/**
 * One search thread of scripts/batch-search.ts. It runs one search at a time: the main thread
 * sends {type: "run", ...}, and this thread answers {type: "result", ...} when the search ends.
 * {type: "abort"} asks the current search to stop at its next cooperative check (about every
 * 12 ms of solver work); the search then returns its best so far with termination "aborted".
 */
import { parentPort } from "node:worker_threads";
import { run } from "@polypack/solver";
import type { WorkerRequest, WorkerResult } from "./protocol";

if (!parentPort) throw new Error("batch-search/worker.ts must run in a worker thread");
const port = parentPort;
let control = { aborted: false, paused: false };

port.on("message", async (message: WorkerRequest) => {
  if (message.type === "abort") {
    control.aborted = true;
    return;
  }
  control = { aborted: false, paused: false };
  const { id, problem, method, seed, budget } = message;
  let reply: WorkerResult;
  try {
    const result = await run(problem, {
      method,
      seed,
      budget: { evals: budget.evals, time_s: budget.time_s },
      control,
    });
    reply = {
      type: "result",
      id,
      score: result.score,
      valid: result.valid,
      strict: result.strict,
      evaluations: result.evaluations,
      wallTime: result.wallTime,
      termination: result.termination,
      reasons: result.reasons.slice(0, 5),
      best: result.valid ? result.best : undefined,
      params: result.params,
    };
  } catch (error) {
    // run() rejects only for bad input (unknown method, bad budget): report it as an error run
    reply = {
      type: "result",
      id,
      score: null,
      valid: false,
      strict: false,
      evaluations: 0,
      wallTime: 0,
      termination: "error",
      reasons: [(error as Error).message],
    };
  }
  port.postMessage(reply);
});
