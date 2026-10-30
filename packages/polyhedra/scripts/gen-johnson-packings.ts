/**
 * Writes python/polyhedra/fixtures/johnson_packings.json: test packings of Johnson solids, for python/polyhedra/test_johnson_packings.py
 * (which certifies each exactly, in the solids' number fields) and packages/polyhedra/test/johnson-packings.test.ts
 * (which checks that the float validator agrees). No search: each is latticeStart(problem, P), the patch of the box lattice
 * in the canonical orientation, which is valid with a clearance of about 1e-10 of its scale. They are packings to test the
 * validators with, not good ones.
 *
 * The pieces J1, J3, J6, J12, J37, J44 (chiral), J72, J84, J86, J90 and J92 each go in a cube, in themselves, in another
 * Johnson solid and in an Archimedean solid.
 *
 * Each case also has two adversarial variants of the same configuration, made by moving one piece until it overlaps its
 * neighbour (or sticks out of the container) by 1e-9: the validator at tolerance 0 and the certifier must refuse both.
 *
 * Usage: npx tsx packages/polyhedra/scripts/gen-johnson-packings.ts [out.json]
 */
import { writeFileSync } from "node:fs";
import { JOHNSON_SOLIDS, pairCode } from "../src/catalogue";
import { getProblem, getSolid, latticeStart, place, separation, validatePolyhedra, wallGap, type Pose } from "../src/index";

const out = process.argv[2] ?? new URL("../../../python/polyhedra/fixtures/johnson_packings.json", import.meta.url).pathname;
const J = (n: number) => JOHNSON_SOLIDS[n - 1].name;
const PIECES = [1, 3, 6, 12, 37, 44, 72, 84, 86, 90, 92];
// the other Johnson solid of each piece, and the Archimedean solid: different from the piece, spread over the families
const OTHER = [92, 84, 90, 50, 9, 63, 1, 72, 3, 12, 44];
const ARCH = [
  "truncated_octahedron",
  "cuboctahedron",
  "icosidodecahedron",
  "rhombicuboctahedron",
  "truncated_tetrahedron",
  "snub_cube",
  "truncated_cube",
  "icosidodecahedron",
  "truncated_icosahedron",
  "cuboctahedron",
  "truncated_octahedron",
];

interface Case {
  piece: string;
  container: string;
  code: string;
  P: number;
  s: number;
  pieces: number[][];
  /** The float validator's smallest wall gap and pair separation (stopAt 1e-3: a pair gap above that is a lower bound). */
  minWallGap: number;
  minPairSep: number | null;
  /** Piece j moved toward piece i until they overlap by `depth` (about 1e-9), or null when no two pieces are near. */
  overlap: { pieces: number[][]; pair: [number, number]; depth: number } | null;
  /** The piece moved outward until it sticks out of the container by `depth` (about 1e-9). */
  protrusion: { pieces: number[][]; piece: number; depth: number };
}

const DELTA = 1e-9;

/** Bisection for the smallest t with f(t) <= -DELTA, f decreasing from f(0) >= 0 to f(hi) < -DELTA. */
function bisect(f: (t: number) => number, hi: number): number {
  let lo = 0;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) <= -DELTA) hi = mid;
    else lo = mid;
  }
  return hi;
}

const cases: Case[] = [];
PIECES.forEach((n, i) => {
  const containers = ["cube", J(n), J(OTHER[i]), ARCH[i]];
  containers.forEach((container, k) => {
    const P = 2 + ((i + 2 * k) % 5); // 2 to 6
    const code = pairCode(J(n), container)!;
    const problem = getProblem(code)!;
    const config = latticeStart(problem, P);
    const v = validatePolyhedra(problem, config, { tol: 0 });
    if (!v.valid) throw new Error(`${code} P=${P}: ${v.errors.join("; ")}`);
    const P_ = getSolid(J(n));
    const C_ = getSolid(container);
    let overlap: Case["overlap"] = null;
    if (v.worstPair) {
      const [a, b] = v.worstPair;
      const pa = config.pieces[a];
      const pb = config.pieces[b];
      const dir = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]];
      const len = Math.hypot(...dir);
      const moved = (t: number): Pose => [pb[0] + (t * dir[0]) / len, pb[1] + (t * dir[1]) / len, pb[2] + (t * dir[2]) / len, pb[3], pb[4], pb[5], pb[6]];
      const sepAt = (t: number) => separation(place(P_, pa), place(P_, moved(t))).sep;
      const t = bisect(sepAt, len);
      const pieces = config.pieces.map((p, i) => (i === b ? moved(t) : p));
      const w = validatePolyhedra(problem, { s: config.s, pieces }, { tol: 0, stopAt: Infinity });
      overlap = { pieces, pair: [a, b], depth: -w.minPairSep };
    }
    // the piece with the tightest wall, moved along the normal of its tightest face
    let kp = 0;
    let best = Infinity;
    config.pieces.forEach((p, i) => {
      const g = wallGap(C_, config.s, place(P_, p).X);
      if (g < best) [best, kp] = [g, i];
    });
    const pk = config.pieces[kp];
    let face = 0;
    {
      const X = place(P_, pk).X;
      let m = Infinity;
      for (let f = 0; f < C_.offsets.length; f++) {
        let hi = -Infinity;
        for (let j = 0; j < X.length; j += 3) hi = Math.max(hi, C_.N[3 * f] * X[j] + C_.N[3 * f + 1] * X[j + 1] + C_.N[3 * f + 2] * X[j + 2]);
        const g = config.s * C_.offsets[f] - hi;
        if (g < m) [m, face] = [g, f];
      }
    }
    const out_ = (t: number): Pose => [pk[0] + t * C_.N[3 * face], pk[1] + t * C_.N[3 * face + 1], pk[2] + t * C_.N[3 * face + 2], pk[3], pk[4], pk[5], pk[6]];
    const t = bisect((u) => wallGap(C_, config.s, place(P_, out_(u)).X), 1);
    const pieces = config.pieces.map((p, i) => (i === kp ? out_(t) : p));
    const wv = validatePolyhedra(problem, { s: config.s, pieces }, { tol: 0 });
    cases.push({
      piece: J(n),
      container,
      code,
      P,
      s: config.s,
      pieces: config.pieces,
      minWallGap: v.minWallGap,
      minPairSep: Number.isFinite(v.minPairSep) ? v.minPairSep : null,
      overlap,
      protrusion: { pieces, piece: kp, depth: -wv.minWallGap },
    });
  });
});
writeFileSync(out, JSON.stringify({ generated: "2026-10-30", note: "latticeStart packings of Johnson solids; no search", cases }) + "\n");
console.log(`${cases.length} packings written to ${out}`);
