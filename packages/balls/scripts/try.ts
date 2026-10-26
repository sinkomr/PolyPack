/** A quick run: npx tsx scripts/try.ts <code> <P> [evals] [seed] */
import { getBallsProblem, searchBalls, validateBalls } from "../src";

const [code, Ps, evalsS, seedS] = process.argv.slice(2);
const problem = getBallsProblem(code)!;
const P = Number(Ps);
const t = performance.now();
const r = searchBalls(problem, P, { seed: Number(seedS ?? 1), maxEvals: Number(evalsS ?? 50000) });
const v = r.config ? validateBalls(problem, r.config, { tol: 0 }) : null;
console.log(code, P, "s =", r.score, "evals", r.evaluations, "hops", r.hops, r.stopped, "valid", v?.valid, "minPair", v?.minPairSep, "minWall", v?.minWallGap, `${((performance.now() - t) / 1000).toFixed(1)} s`);
