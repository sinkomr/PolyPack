import { OpenRun } from "./open-run";
import type { OpenRunRequest, RunState } from "./open-run";

/**
 * The messages between the page and a lane's worker, and the worker's side of them, kept apart from
 * the worker's transport so that they can be tested directly. A worker holds at most one open run;
 * opening another closes it first.
 */
export type HostRequest =
  | { type: "open"; id: number; request: OpenRunRequest }
  /** Allow `evals` more evaluations of run `id`; answered by one "stepped" with the same `step`. */
  | { type: "step"; id: number; step: number; evals: number }
  | { type: "close"; id: number };

export type HostReply =
  | { type: "opened"; id: number; params: Record<string, unknown>; state: RunState }
  /** `ms`: wall time from the step's arrival to its end, waits for earlier steps included. */
  | { type: "stepped"; id: number; step: number; state: RunState; ms: number }
  | { type: "progress"; id: number; state: RunState }
  | { type: "closed"; id: number; state: RunState }
  /** `step`: the step this answers, when it answers one. */
  | { type: "error"; id: number; message: string; step?: number };

export function createRunHost(send: (reply: HostReply) => void): { handle(request: HostRequest): void } {
  let current: { id: number; run: OpenRun } | null = null;
  const publish = (reply: HostReply) => {
    try {
      send(reply);
    } catch {
      // a closed port cannot change the run
    }
  };
  return {
    handle(m) {
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
        void previous?.run.close();
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
      const { run } = current;
      if (m.type === "step") {
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
