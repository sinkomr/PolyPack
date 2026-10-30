/**
 * Writes python/balls/fixtures/johnson_packings.json: test packings of the balls space with Johnson solids, for
 * python/balls/test_johnson_packings.py (which certifies each exactly) and packages/balls/test/johnson.test.ts (which
 * checks that the float validator agrees). No search: balls in J12 (triangular bipyramid), J44 (chiral) and J92 are an fcc or hcp lattice cut legalized with a clearance of 1e-10 (latticeCut, legalizeBalls); J1, J44 and
 * J92 in a ball are solids on a coarse grid in random orientations legalized the same way (legalizeSolids). They are
 * packings to test with, not good ones. Each also has two adversarial variants: a piece moved until it overlaps a
 * neighbour (or sticks out of the container) by 1e-9.
 *
 * Usage: npx tsx packages/balls/scripts/gen-johnson-packings.ts [out.json]
 */
import { writeFileSync } from "node:fs";
import { JOHNSON_SOLIDS } from "@polypack/polyhedra/catalogue";
import { getSolid } from "@polypack/polyhedra";
import { latticeCut, legalizeBalls, mulberry32 } from "../src/ball-pieces";
import { legalizeSolids, solidsAt } from "../src/solid-pieces";
import { BALL_DIAMETER, ballContainerRadius, ballsProblemOf } from "../src/catalogue";
import { containerOfProblem, wallGap } from "../src/container";
import { validateBalls } from "../src/validate";

const out = process.argv[2] ?? new URL("../../../python/balls/fixtures/johnson_packings.json", import.meta.url).pathname;
const J = (n: number) => JOHNSON_SOLIDS[n - 1];
const DELTA = 1e-9;
const G = 1e-10;

interface Case {
  code: string;
  P: number;
  s: number;
  pieces: number[][];
  minWallGap: number;
  minPairSep: number | null;
  overlap: { s: number; pieces: number[][]; pair: [number, number]; depth: number } | null;
  protrusion: { pieces: number[][]; piece: number; depth: number };
}
const cases: Case[] = [];

function finish(code: string, P: number, s: number, pieces: number[][]) {
  const pb = ballsProblemOf(code)!;
  const v = validateBalls(pb, { s, pieces }, { tol: 0 });
  if (!v.valid) throw new Error(`${code} P=${P}: ${v.errors.join("; ")}`);
  let overlap: Case["overlap"] = null;
  let protrusion: Case["protrusion"];
  if (pb.piece === "ball") {
    // the nearest pair: the second ball moved toward the first until the centres are D - DELTA apart
    let best = Infinity;
    let pair: [number, number] = [0, 1];
    for (let i = 0; i < P; i++)
      for (let j = i + 1; j < P; j++) {
        const d = Math.hypot(pieces[i][0] - pieces[j][0], pieces[i][1] - pieces[j][1], pieces[i][2] - pieces[j][2]);
        if (d < best) [best, pair] = [d, [i, j]];
      }
    const [a, b] = pair;
    const target = BALL_DIAMETER - DELTA;
    const moved = pieces.map((p, i) => {
      if (i !== b) return p;
      const u = [0, 1, 2].map((k) => (pieces[b][k] - pieces[a][k]) / best);
      return [0, 1, 2].map((k) => pieces[a][k] + target * u[k]);
    });
    overlap = { s, pieces: moved, pair, depth: BALL_DIAMETER - Math.hypot(...[0, 1, 2].map((k) => moved[b][k] - moved[a][k])) };
    // the ball with the tightest wall moved along the normal of its tightest face until it sticks out by DELTA
    const C = containerOfProblem(pb)!;
    let k = 0;
    let g0 = Infinity;
    pieces.forEach((p, i) => {
      const g = wallGap(C, s, 0.5, p[0], p[1], p[2]);
      if (g < g0) [g0, k] = [g, i];
    });
    const p = pieces[k];
    let face = 0;
    let m = Infinity;
    for (let f = 0; f < C.F; f++) {
      const g = s * C.b[f] - 0.5 - (C.N[3 * f] * p[0] + C.N[3 * f + 1] * p[1] + C.N[3 * f + 2] * p[2]);
      if (g < m) [m, face] = [g, f];
    }
    const at = (t: number) => [p[0] + t * C.N[3 * face], p[1] + t * C.N[3 * face + 1], p[2] + t * C.N[3 * face + 2]];
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 200; it++) {
      const mid = (lo + hi) / 2;
      const q = at(mid);
      if (wallGap(C, s, 0.5, q[0], q[1], q[2]) <= -DELTA) hi = mid;
      else lo = mid;
    }
    const q = at(hi);
    protrusion = { pieces: pieces.map((x, i) => (i === k ? q : x)), piece: k, depth: -wallGap(C, s, 0.5, q[0], q[1], q[2]) };
  } else {
    // solids in a ball: the piece with the farthest vertex is pushed radially out until that vertex is DELTA beyond the ball
    const S = getSolid(pb.piece);
    const R = ballContainerRadius(s);
    let k = 0;
    let far = 0;
    let dir = [1, 0, 0];
    pieces.forEach((pose, i) => {
      const q = pose;
      const w = q[3], x = q[4], y = q[5], z = q[6];
      const n = Math.hypot(w, x, y, z);
      const [qw, qx, qy, qz] = [w / n, x / n, y / n, z / n];
      const Rm = [
        1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy),
        2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx),
        2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy),
      ];
      for (let v = 0; v < S.nv; v++) {
        const a = S.V[3 * v], b = S.V[3 * v + 1], c = S.V[3 * v + 2];
        const X = [q[0] + Rm[0] * a + Rm[1] * b + Rm[2] * c, q[1] + Rm[3] * a + Rm[4] * b + Rm[5] * c, q[2] + Rm[6] * a + Rm[7] * b + Rm[8] * c];
        const d = Math.hypot(...X);
        if (d > far) [far, k, dir] = [d, i, X.map((t) => t / d)];
      }
    });
    const t = R + DELTA - far;
    const moved = pieces.map((p, i) => (i === k ? [p[0] + t * dir[0], p[1] + t * dir[1], p[2] + t * dir[2], p[3], p[4], p[5], p[6]] : p));
    protrusion = { pieces: moved, piece: k, depth: -validateBalls(pb, { s, pieces: moved }, { tol: 0 }).minWallGap };
    // the second piece moved toward the first along the line of centres until they overlap by DELTA
    let lo = 0;
    let hi = 0;
    const pa = pieces[0];
    const pbb = pieces[1];
    const len = Math.hypot(pa[0] - pbb[0], pa[1] - pbb[1], pa[2] - pbb[2]);
    const mv = (u: number) => pieces.map((p, i) => (i === 1 ? [p[0] + (u * (pa[0] - pbb[0])) / len, p[1] + (u * (pa[1] - pbb[1])) / len, p[2] + (u * (pa[2] - pbb[2])) / len, p[3], p[4], p[5], p[6]] : p));
    hi = len;
    for (let it = 0; it < 200; it++) {
      const mid = (lo + hi) / 2;
      const w = validateBalls(pb, { s: 1e6, pieces: mv(mid) }, { tol: 0, maxErrors: 1000 });
      if (w.minPairSep <= -DELTA) hi = mid;
      else lo = mid;
    }
    const w = validateBalls(pb, { s: 1e6, pieces: mv(hi) }, { tol: 0 });
    // the moved pair may leave the ball, so the variant is judged in a container of size 1e6 (by its pair overlap only)
    overlap = { s: 1e6, pieces: mv(hi), pair: [0, 1], depth: -w.minPairSep };
  }
  cases.push({
    code,
    P,
    s,
    pieces,
    minWallGap: v.minWallGap,
    minPairSep: Number.isFinite(v.minPairSep) ? v.minPairSep : null,
    overlap,
    protrusion,
  });
}

// balls in J12 (triangular bipyramid), J44 (chiral snub) and J92, then J1, J44 and J92 in a ball
const rng = mulberry32(2026);
for (const [n, P, kind] of [
  [12, 5, "fcc"], [12, 9, "hcp"], [44, 6, "fcc"], [44, 11, "hcp"], [92, 7, "fcc"], [92, 14, "hcp"],
] as const) {
  const code = `ballin${J(n).code}`;
  const pb = ballsProblemOf(code)!;
  const c = latticeCut(pb, P, rng, kind, false);
  const cfg = legalizeBalls(pb, c, G, G);
  finish(code, P, cfg.s, cfg.pieces as number[][]);
}
for (const [n, P] of [[1, 2], [1, 4], [44, 3], [44, 5], [92, 2], [92, 4]] as const) {
  const code = `${J(n).code}inball`;
  const pb = ballsProblemOf(code)!;
  const S = getSolid(pb.piece);
  // a coarse grid of centres, each solid in its own random orientation
  const step = 2.4 * S.circumradius;
  const centres = Array.from({ length: P }, (_, i) => [step * (i % 2), step * (Math.floor(i / 2) % 2), step * Math.floor(i / 4)]);
  const cfg = legalizeSolids(pb, solidsAt(centres, rng), G, G, () => {});
  finish(code, P, cfg.s, cfg.pieces as number[][]);
}
writeFileSync(out, JSON.stringify({ generated: "2026-10-30", note: "lattice and grid packings with Johnson solids in the balls space; no search", cases }) + "\n");
console.log(`${cases.length} packings written to ${out}`);
