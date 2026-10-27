/**
 * Near-contact cases for the cross-check of the float validator and the certifier: for each of the first 7 problems,
 * two pieces in random orientations moved apart along a random direction to separations of +-1e-7 and +-1e-9
 * (found by bisection on the validator's measured separation), and one piece at wall gaps of +-1e-7 and +-1e-9.
 * Each case stores the validator's measured gap. python/balls/test_certify.py checks that the certifier proves
 * every case measured as separated by more than 1e-10 and refuses every case measured as overlapping by more than
 * 1e-10; packages/balls/test/crosscheck.test.ts that the stored gaps are still the validator's.
 *
 *   npx tsx scripts/gen-crosscheck.ts > ../../python/balls/fixtures/crosscheck.json
 */
import { BALLS_ORIGINAL_CODES, type BallsConfig, getBallsProblem, validateBalls } from "../src";
import { mulberry32, randomQuaternion } from "../src/random";
import { getSolid } from "@polypack/polyhedra";

const rng = mulberry32(20261025);
const cases: { code: string; what: string; config: BallsConfig; gap: number }[] = [];
const unit = (): [number, number, number] => {
  const u = 2 * rng() - 1;
  const phi = 2 * Math.PI * rng();
  const q = Math.sqrt(1 - u * u);
  return [q * Math.cos(phi), q * Math.sin(phi), u];
};

// the first 7 problems; gen-crosscheck-solids.ts has the others
for (const problem of BALLS_ORIGINAL_CODES.map((c) => getBallsProblem(c)!)) {
  const ball = problem.piece === "ball";
  const R = ball ? 1 : getSolid(problem.piece).circumradius;
  for (let t = 0; t < 3; t++) {
    // two pieces in a large container
    const qa = ball ? [] : randomQuaternion(rng);
    const qb = ball ? [] : randomQuaternion(rng);
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
    // half the centre distance at contact, by bisection on the measured separation
    let lo = 0;
    let hi = 2 * R;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (sep(mid) > 0) hi = mid;
      else lo = mid;
    }
    for (const want of [1e-7, -1e-7, 1e-9, -1e-9]) {
      // the separation grows about linearly with d near contact; two secant steps reach the target
      let d = hi;
      for (let k = 0; k < 6; k++) {
        const g0 = sep(d);
        const g1 = sep(d + 1e-6);
        const slope = (g1 - g0) / 1e-6;
        if (!(slope > 0)) break;
        d += (want - g0) / slope;
      }
      cases.push({ code: problem.code, what: `pair, separation ${want}`, config: at(d), gap: sep(d) });
    }
  }
  // one piece against the wall, at a random place and turn
  for (let t = 0; t < 2; t++) {
    const q = ball ? [] : randomQuaternion(rng);
    const c = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
    const base: number[] = [...c, ...q];
    const wall = (s: number) => validateBalls(problem, { s, pieces: [base] }, { tol: 1 }).minWallGap;
    // the gap grows with s at slope 1 (ball) or 1/2 (cube)
    const slope = problem.container === "cube" ? 0.5 : 1;
    const s0 = 20;
    const g0 = wall(s0);
    for (const want of [1e-7, -1e-7, 1e-9, -1e-9]) {
      let s = s0 + (want - g0) / slope;
      s += (want - wall(s)) / slope;
      cases.push({ code: problem.code, what: `wall, gap ${want}`, config: { s, pieces: [base] }, gap: wall(s) });
    }
  }
}
process.stdout.write(JSON.stringify({ generated: "2026-10-25", cases }, null, 0) + "\n");
