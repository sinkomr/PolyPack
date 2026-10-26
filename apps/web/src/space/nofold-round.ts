/**
 * One round of a nofold surface problem: every piece stays in one face, so the problem is the
 * planar problem of its fullest face (packages/spaces/src/search/nofold.ts). The round runs a
 * polygon solver method on that face, from the face of the start, with the round's seed and
 * budget, and copies the strict result onto every face: the job's method (one of the polygon
 * solver's, spaceMethodsFor) with its parameters, or for "auto" basin hopping with its defaults.
 * Like runSpaceJob, it checks the start and the result with the server's rule and returns the
 * better one; a method or parameters the problem does not take give an error result.
 */
import { run } from "@polypack/solver";
import type { SpaceConfig } from "@polypack/spaces";
import { useNofoldMethods } from "@polypack/spaces/search/nofold-methods";
import {
  NOFOLD_AUTO,
  type NofoldProblem,
  type SpaceJob,
  type SpaceJobResult,
  checkSpaceConfig,
  checkSpaceMethod,
  faceProblem,
  isAutoMethod,
  parseSearchProblem,
  readSpaceConfig,
  surfaceFromFace,
} from "@polypack/spaces/search";

// this thread holds the polygon solver anyway: its methods are the ones a nofold job may name
useNofoldMethods();

export async function runNofoldRound(job: SpaceJob): Promise<SpaceJobResult> {
  const t0 = performance.now();
  const seconds = () => (performance.now() - t0) / 1000;
  const p = parseSearchProblem(job.id);
  const fail = (reason: string): SpaceJobResult => ({
    job,
    score: null,
    valid: false,
    evaluations: 0,
    wallTime: seconds(),
    termination: "error",
    reasons: [reason],
  });
  if (!p || p.space !== "surface" || p.mode !== "nofold") return fail("not a nofold surface problem");
  const nofold = p as NofoldProblem;
  const why = checkSpaceMethod(p, job.method, job.params);
  if (why) return fail(why);
  const auto = isAutoMethod(p.space, job.method);
  const start = job.start === undefined ? undefined : (readSpaceConfig(p, job.start) ?? undefined);
  if (job.start !== undefined && !start) return fail("the start is not a configuration of this problem");
  let best: { config: SpaceConfig; score: number } | null = null;
  const consider = (config: SpaceConfig | null | undefined) => {
    if (!config) return;
    const c = checkSpaceConfig(p.space, p.id, config, job.rule);
    if (c.valid && c.score !== null && (!best || c.score < best.score)) best = { config, score: c.score };
  };
  consider(start);
  const face = faceProblem(nofold, start);
  const result = await run(face.problem, {
    method: auto ? NOFOLD_AUTO : job.method,
    ...(auto || !job.params ? {} : { params: job.params }),
    budget: { evals: job.budget.evals, time_s: job.budget.time_s },
    seed: job.seed,
    ...(face.known ? { start: face.known.config } : {}),
  });
  // only a strict result: one that does not rely on the validity tolerance
  if (result.valid && result.strict && result.best) consider(surfaceFromFace(nofold, result.best));
  const b = best as { config: SpaceConfig; score: number } | null;
  return {
    job,
    score: b ? b.score : null,
    valid: b !== null,
    ...(b ? { config: b.config } : {}),
    evaluations: result.evaluations,
    wallTime: seconds(),
    termination: result.termination,
    reasons: b ? [] : ["no valid configuration found"],
  };
}
