// Draws the surface fold benchmark problems (native/fresh-surface-fold), seeded, from the real catalogue.
//
//   npx tsx native/tools/fresh/draw-surface.mts [--seed 20261128] [--out native/tools/fresh/problems-surface-fold.json]
//
// 14 problems `surface/<solid>/fold/<N>/<P>`: 3 Platonic, 3 Archimedean, 2 Catalan, 2 prisms, 1 antiprism, 3 Johnson
// solids; N = 0 (disks) with probability 0.3, a small polygon (3 to 8 sides) 0.45, a large one (9 to 100) 0.25;
// P from 1 to 50 with probability 0.75, else 51 to 100. Only ids that exist and accept submissions (problemOf from
// the catalogue or the domain, acceptsSubmissions: as POST /api/spaces/submit decides), as draw.mts.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { acceptsSubmissions, parseSpaceId, problemOf } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const seed = Number(arg("--seed", "20261128"));
const out = arg("--out", "native/tools/fresh/problems-surface-fold.json");
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

const names: Record<string, string[]> = JSON.parse(
  (await import("node:fs")).readFileSync(resolve(root, "native/surface/data/names.json"), "utf8"),
);
const index = loadSpacesIndex(root);
const open = (id: string): boolean => {
  const parsed = parseSpaceId("surface", id);
  if (typeof parsed === "string") return false;
  const cat = index["surface"];
  const p = cat && problemOf(cat, parsed);
  return !!p && acceptsSubmissions(p) && p.bound !== null && Number.isFinite(p.bound.value);
};

const plan: [string, number][] = [
  ["platonic", 3],
  ["archimedean", 3],
  ["catalan", 2],
  ["prism", 2],
  ["antiprism", 1],
  ["johnson", 3],
];
const drawn: string[] = [];
for (const [family, count] of plan) {
  const pool = names[family]!.slice();
  let got = 0;
  let tries = 0;
  while (got < count && tries < 1000) {
    tries++;
    const solid = pool[Math.floor(rand() * pool.length)]!;
    const u = rand();
    const N = u < 0.3 ? 0 : u < 0.75 ? int(3, 8) : int(9, 100);
    const P = rand() < 0.75 ? int(1, 50) : int(51, 100);
    const id = `surface/${solid}/fold/${N}/${P}`;
    if (drawn.includes(id) || drawn.some((d) => d.split("/")[1] === solid) || !open(id)) continue;
    drawn.push(id);
    got++;
  }
}
writeFileSync(resolve(root, out), JSON.stringify(drawn, null, 1) + "\n");
console.error(`wrote ${drawn.length} problems to ${out}`);
