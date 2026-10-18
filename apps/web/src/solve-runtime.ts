import { findOverlaps, parseConfig } from "@polypack/geometry";
import type { Container, PackingConfig } from "@polypack/geometry";
import { registry, run, strictTolerance } from "@polypack/solver";
import type { Problem, ProgressFrame } from "@polypack/solver";
import type { SolveRequest, SolveResponse } from "./solve-protocol";

interface ActiveJob {
  id: number;
  control: { aborted: boolean; paused: boolean };
  preview?: PackingConfig;
  previewContainer?: Container;
  previewScore: number | null;
}

function strictPreview(frame: ProgressFrame, problem: Problem): PackingConfig | undefined {
  if (!frame.valid || frame.score === null || !Number.isFinite(frame.score) || !frame.container || !frame.config)
    return;
  const parsed = parseConfig(frame.config);
  if (!parsed.ok) return;
  const config = parsed.config;
  if (
    config.N !== problem.N ||
    config.M !== problem.M ||
    config.P !== problem.P ||
    config.pieces.length !== problem.P ||
    frame.container.M !== problem.M ||
    ![frame.container.cx, frame.container.cy, frame.container.phi, frame.container.size].every(Number.isFinite) ||
    findOverlaps(config.N, config.pieces, strictTolerance(config)).length !== 0
  )
    return;
  return { ...config, container_phi: frame.container.phi };
}

/** Browser worker job state, separated from its transport so controls can be tested directly. */
export function createSolveRuntime(send: (message: SolveResponse) => void): { handle(request: SolveRequest): void } {
  let active: ActiveJob | undefined;
  const publish = (message: SolveResponse) => {
    // A closed worker port or failing observer must not leave the solver permanently busy.
    try {
      send(message);
    } catch {
      /* Transport failures cannot change solver state. */
    }
  };
  publish({ type: "ready", methods: registry.list().filter((method) => method.name !== "identity") });

  return {
    handle(request) {
      if (request.type !== "run") {
        if (!active || active.id !== request.id) {
          publish({ type: "error", id: request.id, message: "No active solve job with this id." });
          return;
        }
        if (active.control.aborted && request.type !== "stop") {
          publish({ type: "error", id: request.id, message: "This solve job is stopping." });
          return;
        }
        if (request.type === "stop") {
          active.control.aborted = true;
          active.control.paused = false;
        } else active.control.paused = request.type === "pause";
        publish({
          type: "control",
          id: request.id,
          state: request.type === "stop" ? "stopping" : request.type === "pause" ? "paused" : "running",
        });
        return;
      }
      if (active) {
        publish({ type: "error", id: request.id, message: "A solve job is already running." });
        return;
      }
      let snapshot: Extract<SolveRequest, { type: "run" }>;
      try {
        snapshot = structuredClone(request);
      } catch (error) {
        publish({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      const job: ActiveJob = { id: snapshot.id, control: { aborted: false, paused: false }, previewScore: null };
      active = job;
      // Start after handle returns; controls sent immediately after run affect its first checkpoint.
      void Promise.resolve()
        .then(() =>
          run(snapshot.problem, {
            method: snapshot.method,
            params: snapshot.params,
            budget: snapshot.budget,
            seed: snapshot.seed,
            start: snapshot.start,
            control: job.control,
            onSketch(frame) {
              // The framework already sends a copy, at most once per SKETCH_INTERVAL_MS.
              publish({ type: "sketch", id: job.id, frame });
            },
            onProgress(frame) {
              const candidate = strictPreview(frame, snapshot.problem);
              if (candidate && (job.previewScore === null || frame.score! < job.previewScore)) {
                job.preview = candidate;
                job.previewContainer = { ...frame.container! };
                job.previewScore = frame.score;
              }
              // Every frame carries counters, even while a search evaluates invalid or worse states.
              // Clone the retained best as well as the frame, so observers cannot mutate later previews.
              publish(
                structuredClone({
                  type: "progress",
                  id: job.id,
                  frame,
                  preview: job.preview,
                  previewContainer: job.previewContainer,
                } satisfies SolveResponse),
              );
            },
          }),
        )
        .then(
          (result) => {
            active = undefined;
            const message: SolveResponse = { type: "result", id: job.id, result };
            try {
              send(message);
            } catch (error) {
              // A result that cannot be serialized would otherwise leave the panel running. A
              // transport that rejects a cloneable message is closed and takes no replacement.
              let uncloneable = error instanceof Error && error.name === "DataCloneError";
              if (!uncloneable)
                try {
                  structuredClone(message);
                } catch {
                  uncloneable = true;
                }
              if (uncloneable)
                publish({
                  type: "error",
                  id: job.id,
                  message: `The solver finished, but its result could not be sent to the page: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
          },
          (error: unknown) => {
            active = undefined;
            publish({ type: "error", id: job.id, message: error instanceof Error ? error.message : String(error) });
          },
        );
    },
  };
}
