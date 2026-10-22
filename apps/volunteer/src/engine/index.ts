/**
 * PLACEHOLDER, to be replaced by the real engine: one fresh "asc" run per lane, each for up to
 * 30 s of the problem's time, keeping the best strict packing. It exists so that the host can be
 * built and run end to end before the engine is written. See ../types.ts for the contract.
 */
import type { Candidate, Job, JobResult, SearchProblem } from "../types";

export const searchProblem: SearchProblem = async (input, runJob, control) => {
  const time_s = Math.max(1, Math.min(30, input.maxSeconds));
  const jobs: Job[] = Array.from({ length: Math.max(1, input.lanes) }, (_, i) => ({
    problem: input.problem,
    method: "asc",
    seed: (input.seed + i) >>> 0,
    budget: { time_s },
    kind: "fresh",
  }));
  let best: Candidate | null = null;
  const keep = (r: JobResult) => {
    if (r.valid && r.strict && r.best && r.score !== null && (!best || r.score < best.score))
      best = { config: r.best, score: r.score, strict: true, job: r.job, params: r.params };
    input.onResult?.(r, best);
  };
  await Promise.all(jobs.map((job) => runJob(job, control).then(keep)));
  return { best, jobs: jobs.length, stopped: control.aborted ? "aborted" : "time", memory: input.memory ?? null };
};
