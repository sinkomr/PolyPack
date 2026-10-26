/**
 * One round of a nofold surface problem on a Platonic solid: every piece stays in one face, so the problem is the
 * planar problem of its fullest face (packages/spaces/src/search/nofold.ts). The round runs the
 * polygon solver's basin hopping on that face, from the face of the start, with the round's seed
 * and budget, and copies the strict result onto every face. Like runSpaceJob, it checks the start
 * and the result with the server's rule and returns the better one.
 */
import { run } from "@polypack/solver";
import type { SpaceConfig } from "@polypack/spaces";
import {
  type NofoldProblem,
  type SpaceJob,
  type SpaceJobResult,
  checkSpaceConfig,
  faceProblem,
  nofoldOnPolygonEngine,
  parseSearchProblem,
  readSpaceConfig,
  surfaceFromFace,
} from "@polypack/spaces/search";

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
  if (!p || !nofoldOnPolygonEngine(p)) return fail("not a nofold surface problem of a Platonic solid");
  const nofold = p as NofoldProblem;
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
    method: "basin_hopping",
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
