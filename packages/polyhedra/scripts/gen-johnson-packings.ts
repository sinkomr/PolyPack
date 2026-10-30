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
 * Usage: npx tsx packages/polyhedra/scripts/gen-johnson-packings.ts [out.json]
 */
import { writeFileSync } from "node:fs";
import { JOHNSON_SOLIDS, pairCode } from "../src/catalogue";
import { getProblem, latticeStart, validatePolyhedra } from "../src/index";

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
    cases.push({
      piece: J(n),
      container,
      code,
      P,
      s: config.s,
      pieces: config.pieces,
      minWallGap: v.minWallGap,
      minPairSep: Number.isFinite(v.minPairSep) ? v.minPairSep : null,
    });
  });
});
writeFileSync(out, JSON.stringify({ generated: "2026-10-30", note: "latticeStart packings of Johnson solids; no search", cases }) + "\n");
console.log(`${cases.length} packings written to ${out}`);
