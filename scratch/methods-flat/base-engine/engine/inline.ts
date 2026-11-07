/**
 * Runs a job on the current thread with @polypack/solver. The host's worker threads call this for
 * each job they receive; the engine's tests call it directly.
 */
import { run } from "@polypack/solver";
import type { Control, Job, JobResult, RunJob } from "../types";

export const inlineRunJob: RunJob = async (job: Job, control: Control): Promise<JobResult> => {
  try {
    const result = await run(job.problem, {
      method: job.method,
      params: job.params,
      seed: job.seed,
      budget: job.budget.evals === undefined ? { time_s: job.budget.time_s } : { ...job.budget },
      start: job.start,
      finalPolish: job.finalPolish,
      control,
    });
    return {
      job,
      score: result.score,
      valid: result.valid,
      strict: result.strict,
      best: result.valid ? result.best : undefined,
      params: result.params,
      evaluations: result.evaluations,
      wallTime: result.wallTime,
      termination: result.termination,
      reasons: result.reasons.slice(0, 5),
    };
  } catch (error) {
    // run() rejects only for bad input: an unknown method, a bad budget or a mismatched start
    return {
      job,
      score: null,
      valid: false,
      strict: false,
      evaluations: 0,
      wallTime: 0,
      termination: "error",
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
};
