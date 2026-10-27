/**
 * Near-contact cases for the cross-check of the float validator and the certifier on the problems added after the
 * first 7: one ball against the walls of each of the 94 solids as container (a random place near the centre, the size
 * found by bisection and secant steps so that the validator's wall gap is +-1e-7, +-1e-9 and +-1e-12), and, for the
 * pieces of BALLS_FAMILY_SAMPLE, two solids in random orientations moved apart to separations of the same gaps and one
 * solid against the ball's wall (as gen-crosscheck.ts does). Each case stores the validator's measured gap.
 * python/balls/test_certify.py checks that the certifier proves every case measured as separated by more than 1e-13 and
 * refuses every case measured as overlapping by more than 1e-13 (the certifier is exact, the validator's floats err by
 * about 1e-16 of the sizes); packages/balls/test/containers.test.ts that the stored gaps are still the validator's.
 *
 *   npx tsx scripts/gen-crosscheck-solids.ts > ../../python/balls/fixtures/crosscheck_solids.json
 */
import { BALLS_FAMILY_SAMPLE, BALLS_PROBLEMS, type BallsConfig, getBallsProblem, validateBalls } from "../src";
import { mulberry32, randomQuaternion } from "../src/random";
import { getSolid } from "@polypack/polyhedra";

const rng = mulberry32(20261026);
const GAPS = [1e-7, -1e-7, 1e-9, -1e-9, 1e-12, -1e-12];
const cases: { code: string; what: string; config: BallsConfig; gap: number }[] = [];
const unit = (): [number, number, number] => {
  const u = 2 * rng() - 1;
  const phi = 2 * Math.PI * rng();
  const q = Math.sqrt(1 - u * u);
  return [q * Math.cos(phi), q * Math.sin(phi), u];
};

/** One piece at base against the wall: the size at which the validator's wall gap is each wanted value. */
function wallCases(code: string, base: number[]) {
  const problem = getBallsProblem(code)!;
  const wall = (s: number) => validateBalls(problem, { s, pieces: [base] }, { tol: 1 }).minWallGap;
  let s0 = 20;
  for (const want of GAPS) {
    let s = s0;
    // the gap is piecewise linear in s; secant steps from two sizes reach the target
    for (let k = 0; k < 8; k++) {
      const g0 = wall(s);
      const g1 = wall(s * (1 + 1e-6));
      const slope = (g1 - g0) / (s * 1e-6);
      if (!(slope > 0)) break;
      s += (want - g0) / slope;
    }
    cases.push({ code, what: `wall, gap ${want}`, config: { s, pieces: [base] }, gap: wall(s) });
  }
}

for (const problem of BALLS_PROBLEMS) {
  if (problem.piece === "ball" && problem.container !== "ball" && problem.container !== "cube") {
    const c = [0.6 * (rng() - 0.5), 0.6 * (rng() - 0.5), 0.6 * (rng() - 0.5)];
    wallCases(problem.code, c);
  }
}
for (const code of BALLS_FAMILY_SAMPLE.filter((c) => c.endsWith("inball"))) {
  const problem = getBallsProblem(code)!;
  const R = getSolid(problem.piece).circumradius;
  for (let t = 0; t < 2; t++) {
    const qa = randomQuaternion(rng);
    const qb = randomQuaternion(rng);
    const u = unit();
    const s = 10 * R + 10;
    const at = (d: number): BallsConfig => ({
      s,
      pieces: [
        [-u[0] * d, -u[1] * d, -u[2] * d, ...qa],
        [u[0] * d, u[1] * d, u[2] * d, ...qb],
      ],
    });
    const sep = (d: number) => validateBalls(problem, at(d), { tol: 1 }).minPairSep;
    let lo = 0;
    let hi = 2 * R;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (sep(mid) > 0) hi = mid;
      else lo = mid;
    }
    for (const want of GAPS) {
      let d = hi;
      for (let k = 0; k < 6; k++) {
        const g0 = sep(d);
        const slope = (sep(d + 1e-6) - g0) / 1e-6;
        if (!(slope > 0)) break;
        d += (want - g0) / slope;
      }
      cases.push({ code, what: `pair, separation ${want}`, config: at(d), gap: sep(d) });
    }
  }
  const q = randomQuaternion(rng);
  const base: number[] = [rng() - 0.5, rng() - 0.5, rng() - 0.5, ...q];
  const wall = (s: number) => validateBalls(problem, { s, pieces: [base] }, { tol: 1 }).minWallGap;
  for (const want of GAPS) {
    let s = 20;
    s += want - wall(s);
    s += want - wall(s);
    cases.push({ code, what: `wall, gap ${want}`, config: { s, pieces: [base] }, gap: wall(s) });
  }
}
process.stdout.write(JSON.stringify({ generated: "2026-10-26", cases }, null, 0) + "\n");
