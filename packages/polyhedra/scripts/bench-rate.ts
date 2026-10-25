/**
 * Evaluations per second of the search and the longest gap between two polls of shouldStop, from a
 * warm start (an upstream-format record file) and from scratch, for a fixed evaluation budget.
 *
 * Usage: npx tsx packages/polyhedra/scripts/bench-rate.ts <code> <P> <evals> [start.json]
 */
import { readFileSync } from "node:fs";
import { getProblem, searchPolyhedra } from "../src/index";

const [code, Ptext, evalsText, file] = process.argv.slice(2);
const p = getProblem(code)!;
const P = Number(Ptext);
const evals = Number(evalsText);
const start = file
  ? (() => {
      const r = JSON.parse(readFileSync(file, "utf8"));
      return r.config ?? { s: r.s_full, pieces: r.pieces };
    })()
  : undefined;
let last = performance.now();
let worst = 0;
const t0 = performance.now();
const r = searchPolyhedra(p, P, {
  seed: 1,
  start,
  maxEvals: evals,
  shouldStop: () => {
    const t = performance.now();
    worst = Math.max(worst, t - last);
    last = t;
    return false;
  },
});
const sec = (performance.now() - t0) / 1000;
console.log(
  JSON.stringify({ code, P, start: !!start, evals: r.evaluations, seconds: +sec.toFixed(2), per_eval_ms: +((sec * 1000) / r.evaluations).toFixed(3), longest_poll_gap_ms: +worst.toFixed(1), hops: r.hops, score: r.score }),
);
