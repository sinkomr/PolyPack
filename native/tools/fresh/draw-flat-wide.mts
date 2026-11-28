// Draws the wide flat problem set: flat problems with many-sided pieces or containers, seeded.
//
//   npx tsx native/tools/fresh/draw-flat-wide.mts [--seed 20261128] [--out native/tools/fresh/problems-flat-wide.json]
//
// 16 problems: 5 with N >= 17 and M <= 8, 5 with M >= 9 and N <= 16, 3 with both, and 3 with neither but
// N or M outside the shapes of problems.json (N in 9..16). N and M are drawn uniformly from their ranges
// (0 or 3..100 overall). P is 5..50 with probability 0.8, else 51..120. Only problems that accept
// submissions: not closed by the literature (closedToSubmissions, as POST /api/submit decides); every
// N, M in 0, 3..100 and P in 1..500 exists.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { closedToSubmissions, type LiteratureRecord } from "@polypack/geometry";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const seed = Number(arg("--seed", "20261128"));
const out = arg("--out", "native/tools/fresh/problems-flat-wide.json");
const root = resolve(import.meta.dirname, "../../..");

// mulberry32, as draw.mts
let state = seed >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pickOf = (xs: number[]) => xs[Math.floor(rand() * xs.length)]!;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const records: LiteratureRecord[] = JSON.parse(readFileSync(resolve(root, "data/records.json"), "utf8")).records;
const literature = new Map(records.map((r) => [`${r.N}/${r.M}/${r.P}`, r]));

const manyN = range(17, 100);
const fewN = [0, ...range(3, 16)];
const manyM = range(9, 100);
const fewM = [0, ...range(3, 8)];
const midN = range(9, 16);
const drawP = () => (rand() < 0.8 ? int(5, 50) : int(51, 120));

const groups: [number, number[], number[]][] = [
  [5, manyN, fewM],
  [5, fewN, manyM],
  [3, manyN, manyM],
  [3, midN, fewM],
];
const drawn: string[] = [];
for (const [count, ns, ms] of groups) {
  let got = 0;
  while (got < count) {
    const id = `${pickOf(ns)}/${pickOf(ms)}/${drawP()}`;
    if (closedToSubmissions(literature.get(id)) || drawn.includes(`flat/${id}`)) continue;
    drawn.push(`flat/${id}`);
    got++;
  }
}
writeFileSync(resolve(root, out), JSON.stringify(drawn, null, 1) + "\n");
console.error(`wrote ${drawn.length} problems to ${out}`);
