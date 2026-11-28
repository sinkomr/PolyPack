// Draws the torus benchmark problems (native/fresh-torus), seeded, from the real catalogue.
//
//   npx tsx native/tools/fresh/draw-torus.mts [--seed 20261128] [--out native/tools/fresh/problems-torus.json]
//
// 14 problems torus/<family>/<N>/<P>: the family uniform over sq, hex, free; N by a fixed list of classes so that
// disks (N = 0), triangles, squares, hexagons, other small polygons (5, 7, 8), medium (9-29) and many-sided ones
// (30-90) all appear; P from 2 to 50 for 11 of them and from 51 to 150 for 3. Only problems that exist and accept
// submissions (problemOf from the catalogue or the domain, acceptsSubmissions, a finite bound: as
// POST /api/spaces/submit decides); a drawn id that does not is replaced by another draw of the same class.
// Free tori of disks, squares and hexagons are skipped too: a lattice settles them exactly (Thue's hexagonal
// packing reaches the disks' density bound for every P; squares and hexagons tile), so they measure nothing.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { acceptsSubmissions, parseSpaceId, problemOf } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const seed = Number(arg("--seed", "20261128"));
const out = arg("--out", "native/tools/fresh/problems-torus.json");
const root = resolve(import.meta.dirname, "../../..");

// mulberry32
let state = seed >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pickOf = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

const index = loadSpacesIndex(root);
const open = (id: string): boolean => {
  const parsed = parseSpaceId("torus", id);
  if (typeof parsed === "string") return false;
  const cat = index["torus"];
  const p = cat && problemOf(cat, parsed);
  return !!p && acceptsSubmissions(p) && p.bound !== null && Number.isFinite(p.bound.value);
};

const classes: (() => number)[] = [
  () => 0,
  () => 3,
  () => 4,
  () => 6,
  () => pickOf([5, 7, 8]),
  () => int(30, 90),
  () => 0,
  () => 3,
  () => int(30, 90),
  () => int(9, 29),
  () => 4,
  () => 6,
  () => int(30, 90),
  () => pickOf([5, 7, 8]),
];
const bigP = new Set([3, 8, 12]);
const drawn: string[] = [];
classes.forEach((cls, k) => {
  for (let tries = 0; tries < 1000; tries++) {
    const family = pickOf(["sq", "hex", "free"]);
    const N = cls();
    const P = bigP.has(k) ? int(51, 150) : int(2, 50);
    const id = `torus/${family}/${N}/${P}`;
    const settled = family === "free" && (N === 0 || N === 4 || N === 6);
    if (!settled && !drawn.includes(id) && open(id)) {
      drawn.push(id);
      return;
    }
  }
  throw new Error(`no open problem for class ${k}`);
});
writeFileSync(resolve(root, out), JSON.stringify(drawn, null, 1) + "\n");
console.error(`wrote ${drawn.length} problems to ${out}: ${drawn.join(" ")}`);
