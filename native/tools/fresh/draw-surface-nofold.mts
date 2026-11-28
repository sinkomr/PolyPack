// Draws the surface nofold benchmark set for fresh-surface-nofold, seeded, from the real catalogue (only ids that
// exist and accept submissions, as POST /api/spaces/submit decides: problemOf from the surface domain,
// acceptsSubmissions, a finite bound).
//
//   npx tsx native/tools/fresh/draw-surface-nofold.mts [--seed 20261128] [--out native/tools/fresh/problems-surface-nofold.json]
//
// 14 problems: per solid family Platonic 2, Archimedean 2, Catalan 3, prisms 2, antiprisms 1, Johnson 4. The piece:
// a disk (N = 0) with probability 0.3, a small polygon (N = 3..8) 0.45, a many-sided one (N = 9..100) 0.25. P: 2..50
// with probability 0.75, else 51..100.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { acceptsSubmissions, parseSpaceId, problemOf } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const seed = Number(arg("--seed", "20261128"));
const out = arg("--out", "native/tools/fresh/problems-surface-nofold.json");
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
const below = (n: number) => Math.floor(rand() * n);

const names = JSON.parse(readFileSync(resolve(root, "native/surface/data/names.json"), "utf8")) as Record<string, string[]>;
const index = loadSpacesIndex(root);
const open = (id: string): boolean => {
  const parsed = parseSpaceId("surface", id);
  if (typeof parsed === "string") return false;
  const cat = index.surface;
  const p = cat && problemOf(cat, parsed);
  return !!p && acceptsSubmissions(p) && p.bound !== null && Number.isFinite(p.bound.value);
};

const quota: [string, number][] = [
  ["platonic", 2],
  ["archimedean", 2],
  ["catalan", 3],
  ["prism", 2],
  ["antiprism", 1],
  ["johnson", 4],
];
const drawn: string[] = [];
for (const [family, count] of quota) {
  const solids = names[family]!;
  let got = 0;
  for (let tries = 0; got < count && tries < 1000; tries++) {
    const solid = solids[below(solids.length)]!;
    const r = rand();
    const N = r < 0.3 ? 0 : r < 0.75 ? 3 + below(6) : 9 + below(92);
    const P = rand() < 0.75 ? 2 + below(49) : 51 + below(50);
    const id = `surface/${solid}/nofold/${N}/${P}`;
    if (drawn.includes(id) || !open(id)) continue;
    drawn.push(id);
    got++;
  }
}
writeFileSync(resolve(root, out), JSON.stringify(drawn, null, 1) + "\n");
console.error(`wrote ${drawn.length} problems to ${out}`);
