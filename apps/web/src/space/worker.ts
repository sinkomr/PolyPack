/**
 * The board's search thread for the spaces: runs one round (a SpaceJob) and answers with its
 * result. Fold surfaces, curved, sphere, torus and polyhedra problems run the shared job of the volunteer
 * client (runSpaceJob, packages/spaces/src/search/run.ts), and so do the nofold problems of the
 * Archimedean and Catalan solids, prisms and antiprisms (the surface search in its nofold mode); nofold problems of the
 * Platonic solids run the polygon solver on one face (nofold-round.ts). The page ends a round by ending this worker (search.ts),
 * so the stop and pause flags passed here never change.
 */
import {
  type SpaceJob,
  type SpaceJobResult,
  nofoldOnPolygonEngine,
  parseSearchProblem,
  runSpaceJob,
} from "@polypack/spaces/search";
import { runNofoldRound } from "./nofold-round";

// Structural worker typing avoids importing DOM worker declarations into the window build.
const worker = globalThis as unknown as {
  postMessage(message: { id: number; result: SpaceJobResult }): void;
  addEventListener(type: "message", listener: (event: { data: { id: number; job: SpaceJob } }) => void): void;
};

worker.addEventListener("message", async (event) => {
  const { id, job } = event.data;
  const p = parseSearchProblem(job?.id);
  let result: SpaceJobResult;
  try {
    result =
      p && nofoldOnPolygonEngine(p)
        ? await runNofoldRound(job)
        : runSpaceJob(job, { aborted: false, paused: false });
  } catch (error) {
    result = {
      job,
      score: null,
      valid: false,
      evaluations: 0,
      wallTime: 0,
      termination: "error",
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
  worker.postMessage({ id, result });
});
