/**
 * Cost of the search's evaluations: microseconds per evaluation of a run of `evals` from a fresh start (its polish
 * and hops), wall time included the work between evaluations (pair lists, legalizations), for each problem at a few P.
 *   npx tsx scripts/bench.ts [evals]
 */
import { BALLS_CODES, getBallsProblem, searchBalls } from "../src";

const evals = Number(process.argv[2] ?? 30000);
for (const code of BALLS_CODES)
  for (const P of [10, 30, 60, 100]) {
    const t = performance.now();
    const r = searchBalls(getBallsProblem(code)!, P, { seed: 1, maxEvals: evals });
    const ms = performance.now() - t;
    console.log(`${code} P=${P}: ${((1000 * ms) / r.evaluations).toFixed(2)} us per evaluation (${r.evaluations} in ${(ms / 1000).toFixed(2)} s)`);
  }
