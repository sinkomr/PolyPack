/**
 * Runs the search on one problem, from scratch or from an upstream-format record file, and prints the result.
 * Usage: npx tsx packages/polyhedra/scripts/try-search.ts <code> <P> [--start file.json] [--seed S] [--evals E] [--out f]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getProblem, searchPolyhedra, validatePolyhedra } from "../src/index";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const code = args[0];
const P = Number(args[1]);
const problem = getProblem(code);
if (!problem) throw new Error(`unknown code ${code}`);
const startFile = opt("--start");
const start = startFile
  ? (() => {
      const r = JSON.parse(readFileSync(startFile, "utf8"));
      return r.config ?? { s: r.s_full, pieces: r.pieces };
    })()
  : undefined;
const t0 = performance.now();
const res = searchPolyhedra(problem, P, {
  seed: Number(opt("--seed") ?? 1),
  start,
  maxEvals: Number(opt("--evals") ?? 200000),
  clearance: Number(opt("--clearance") ?? 1e-12),
  log: args.includes("-v") ? (m) => console.log(`  ${((performance.now() - t0) / 1000).toFixed(1)}s ${m}`) : undefined,
});
const sec = (performance.now() - t0) / 1000;
const v = res.config ? validatePolyhedra(problem, res.config, { tol: 0, stopAt: Infinity }) : null;
console.log(
  JSON.stringify({
    code,
    P,
    score: res.score,
    startScore: res.startScore,
    evaluations: res.evaluations,
    hops: res.hops,
    stopped: res.stopped,
    seconds: +sec.toFixed(2),
    valid: v?.valid,
    minPairSep: v?.minPairSep,
    minWallGap: v?.minWallGap,
  }),
);
const out = opt("--out");
if (out && res.config) writeFileSync(out, JSON.stringify({ code, P, config: res.config, score: res.score, seed: Number(opt("--seed") ?? 1), evaluations: res.evaluations }));
