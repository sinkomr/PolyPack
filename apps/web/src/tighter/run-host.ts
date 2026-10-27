import { OpenRun } from "./open-run";
import type { OpenRunRequest, RunState } from "./open-run";
import { SpaceRunControl } from "./space-control";
import { SpaceRun, spaceStart } from "./space-run";
import type { SpaceRunRequest, SpaceRunState, SpaceStartAnswer, SpaceStartRequest } from "./space-run-types";

/**
 * The messages between the page and a lane's worker, and the worker's side of them, kept apart from
 * the worker's transport so that they can be tested directly. A worker holds at most one open run;
 * opening another closes it first.
 *
 * A space run (space-run.ts) blocks its worker while it is paused, so the page steps, holds and
 * ends it through shared memory and never expects a message to reach it: "open-space" runs it right
 * there, and the worker answers the next message only once the run has ended. Its steps are
 * answered by "space-stepped" as it reaches what the page allowed.
 */
export type HostRequest =
  | { type: "open"; id: number; request: OpenRunRequest }
  /** Allow `evals` more evaluations of run `id`; answered by one "stepped" with the same `step`. */
  | { type: "step"; id: number; step: number; evals: number }
  | { type: "close"; id: number }
  /** Holds or releases a polygon run (a space run is held through its control). */
  | { type: "hold"; id: number; held: boolean }
  | { type: "open-space"; id: number; request: SpaceRunRequest; control: SharedArrayBuffer }
  | { type: "space-start"; id: number; request: SpaceStartRequest };

export type HostReply =
  | { type: "opened"; id: number; params: Record<string, unknown>; state: RunState | SpaceRunState }
  /** `ms`: wall time from the step's arrival to its end, waits for earlier steps included. */
  | { type: "stepped"; id: number; step: number; state: RunState; ms: number }
  | { type: "progress"; id: number; state: RunState | SpaceRunState }
  | { type: "closed"; id: number; state: RunState | SpaceRunState }
  /** A space run reached what it was allowed (`target`: game evaluations in all) or ended (Infinity). */
  | { type: "space-stepped"; id: number; target: number; state: SpaceRunState }
  | { type: "started"; id: number; answer: SpaceStartAnswer }
  /** `step`: the step this answers, when it answers one. */
  | { type: "error"; id: number; message: string; step?: number };

export function createRunHost(send: (reply: HostReply) => void): { handle(request: HostRequest): void } {
  let current: { id: number; run: OpenRun } | { id: number; space: SpaceRun } | null = null;
  const publish = (reply: HostReply) => {
    try {
      send(reply);
    } catch {
      // a closed port cannot change the run
    }
  };
  return {
    handle(m) {
      if (m.type === "space-start") {
        publish({ type: "started", id: m.id, answer: spaceStart(m.request) });
        return;
      }
      if (m.type === "open-space") {
        const previous = current;
        let space: SpaceRun;
        try {
          space = new SpaceRun(m.request, new SpaceRunControl(m.control), {
            progress: (state) => publish({ type: "progress", id: m.id, state }),
            stepped: (target, state) => publish({ type: "space-stepped", id: m.id, target, state }),
          });
        } catch (error) {
          publish({ type: "error", id: m.id, message: error instanceof Error ? error.message : String(error) });
          return;
        }
        current = { id: m.id, space };
        if (previous && "run" in previous) void previous.run.close();
        publish({ type: "opened", id: m.id, params: space.params, state: space.state() });
        // blocks the worker until the run ends: the page ends it through its control
        space.run();
        return;
      }
      if (m.type === "open") {
        const previous = current;
        let run: OpenRun;
        try {
          run = new OpenRun(m.request, (state) => publish({ type: "progress", id: m.id, state }));
        } catch (error) {
          publish({ type: "error", id: m.id, message: error instanceof Error ? error.message : String(error) });
          return;
        }
        current = { id: m.id, run };
        if (previous && "run" in previous) void previous.run.close();
        // step(0) settles once the start has been scored
        void run
          .step(0)
          .then((state) =>
            publish(
              state.error
                ? { type: "error", id: m.id, message: state.error }
                : { type: "opened", id: m.id, params: run.params, state },
            ),
          );
        return;
      }
      if (!current || current.id !== m.id) {
        if (m.type === "step") publish({ type: "error", id: m.id, step: m.step, message: "no open run with this id" });
        return;
      }
      if ("space" in current) {
        // steps and holds of a space run go through its control; only its close is a message
        if (m.type === "close") {
          const { space } = current;
          current = null;
          publish({ type: "closed", id: m.id, state: space.state() });
        }
        return;
      }
      const { run } = current;
      if (m.type === "hold") {
        run.hold(m.held);
      } else if (m.type === "step") {
        const t = performance.now();
        void run
          .step(m.evals)
          .then((state) => publish({ type: "stepped", id: m.id, step: m.step, state, ms: performance.now() - t }));
      } else {
        current = null;
        void run.close().then((state) => publish({ type: "closed", id: m.id, state }));
      }
    },
  };
}
