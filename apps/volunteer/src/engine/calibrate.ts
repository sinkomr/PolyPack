/**
 * Development script, not part of the engine: the measurements behind policy.ts's defaults. Each
 * experiment prints one JSON line per cell; shards split the cells between processes. Times are
 * real, so results depend on the machine and its load.
 *
 *   npx tsx apps/volunteer/src/engine/calibrate.ts <experiment> [shard] [shards]
 *
 * rate: six methods for 6 s from scratch on nine problems (cost of an evaluation, early scores);
 * improve: improver runs of 8 s from an 8 s harden result against fresh restarts;
 * length: harden and shrink_repair at 4, 8 and 16 s, seeds 1 to 3;
 * polish: the final polish of a 5 s asc result;
 * portfolio: the engine (one lane, 120 s) against asc and harden, seeds 1 to 3, 20 s each.
 */
import { areaLowerBound, type PackingConfig } from "@polypack/geometry";
import { run } from "@polypack/solver";
import type { Problem } from "../types";
import { inlineRunJob } from "./inline";
import { searchProblem } from "./search";

type Cell = () => Promise<Record<string, unknown>>;

const problem = ([N, M, P]: number[]): Problem => ({ N, M, P });

async function best(p: Problem, method: string, seconds: number, seed = 1, start?: PackingConfig, params = {}) {
  const t = performance.now();
  const r = await run(p, { method, params, seed, start, budget: { time_s: seconds } });
  return { score: r.score, strict: r.strict, evals: r.evaluations, ms: performance.now() - t, best: r.best };
}

const experiments: Record<string, Cell[]> = {
  rate: [
    [4, 4, 10],
    [4, 4, 30],
    [0, 0, 30],
    [3, 3, 20],
    [5, 5, 20],
    [6, 6, 50],
    [4, 4, 100],
    [7, 0, 40],
    [0, 4, 60],
  ].flatMap((cell) =>
    ["harden", "shrink_repair", "basin_hopping", "asc", "morph", "ls_growth"].map((method) => async () => {
      const r = await best(problem(cell), method, 6);
      return { cell, method, score: r.score, evals: r.evals, msPerEvaluationPerPiece: r.ms / r.evals / cell[2] };
    }),
  ),
  improve: [
    [3, 3, 20],
    [5, 5, 20],
    [7, 0, 40],
    [0, 4, 60],
  ].map((cell) => async () => {
    const p = problem(cell);
    const base = await best(p, "harden", 8);
    const gain = (score: number | null) => (base.score! - score!) / base.score!;
    const out: Record<string, unknown> = { cell, base: base.score };
    out["fresh harden"] = gain((await best(p, "harden", 8, 2)).score);
    out["fresh shrink_repair"] = gain((await best(p, "shrink_repair", 8, 2)).score);
    for (const [label, method, params] of [
      ["shrink_repair", "shrink_repair", {}],
      ["basin_hopping", "basin_hopping", {}],
      ["morph", "morph", {}],
      ["asc", "asc", {}],
      ["harden rigid noise 1", "harden", { path: "rigid", noise: 1 }],
      ["mc_compress", "mc_compress", {}],
    ] as const)
      out[`iterate ${label}`] = gain((await best(p, method, 8, 2, base.best, params)).score);
    return out;
  }),
  length: [
    [4, 4, 17],
    [3, 3, 20],
  ].flatMap((cell) =>
    ["harden", "shrink_repair"].flatMap((method) =>
      [4, 8, 16].map((seconds) => async () => {
        const scores = [];
        for (const seed of [1, 2, 3]) scores.push((await best(problem(cell), method, seconds, seed)).score);
        return { cell, method, seconds, scores };
      }),
    ),
  ),
  polish: [
    [4, 4, 30],
    [5, 5, 60],
    [0, 0, 100],
    [6, 0, 100],
    [4, 4, 200],
    [7, 7, 50],
  ].map((cell) => async () => {
    const p = problem(cell);
    const base = await run(p, { method: "asc", seed: 1, budget: { time_s: 5 }, finalPolish: false });
    const t = performance.now();
    const r = await run(p, { method: "polish", seed: 1, start: base.best, budget: { time_s: 60, evals: 10_000 } });
    return { cell, before: base.score, after: r.score, ms: performance.now() - t, termination: r.termination };
  }),
  portfolio: [
    [4, 4, 17],
    [3, 3, 20],
    [5, 5, 20],
    [7, 0, 40],
  ].map((cell) => async () => {
    const p = problem(cell);
    let portfolio = Infinity;
    for (const method of ["asc", "harden"])
      for (const seed of [1, 2, 3]) {
        const r = await best(p, method, 20, seed);
        if (r.strict && r.score !== null) portfolio = Math.min(portfolio, r.score);
      }
    const t0 = performance.now();
    const outcome = await searchProblem(
      {
        problem: p,
        leader: null,
        published: null,
        areaBound: areaLowerBound(p.N, p.M, p.P),
        maxSeconds: 120,
        lanes: 1,
        seed: 1,
        now: () => (performance.now() - t0) / 1000,
      },
      inlineRunJob,
      { aborted: false, paused: false },
    );
    return { cell, portfolio, engine: outcome.best?.score, jobs: outcome.jobs, stopped: outcome.stopped };
  }),
};

const [name, shard = "0", shards = "1"] = process.argv.slice(2);
const cells = experiments[name];
if (!cells) throw new Error(`experiment: one of ${Object.keys(experiments).join(", ")}`);
for (let i = Number(shard); i < cells.length; i += Number(shards)) console.log(JSON.stringify(await cells[i]()));
