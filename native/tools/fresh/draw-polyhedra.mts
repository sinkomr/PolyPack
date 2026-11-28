// Draws the polyhedra benchmark problem set for fresh-polyhedra (native/FRESH.md), seeded.
//
//   npx tsx native/tools/fresh/draw-polyhedra.mts [--seed 20261128] [--out native/tools/fresh/problems-polyhedra.json]
//
// 12 polyhedra problems, weighted to small P (4 with P 2..5, 4 with P 6..15, 4 with P 16..60): in each band two
// problems of the 150 pairs with research records (P <= 100) and two of all 34,596 pairs of the 186 solids; and 4
// solids-in-a-ball problems (balls/<solid>inball/<P>, P 2..20). Only problems that exist and accept submissions
// (problemOf from the catalogue or the family's domain, acceptsSubmissions: as POST /api/spaces/submit).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { acceptsSubmissions, parseSpaceId, problemOf, type SpaceName } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { BALLS_PROBLEMS } from "@polypack/balls/catalogue";
import { PROBLEM_NAMES, SOLID_NAMES_LIST } from "@polypack/polyhedra/catalogue";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const seed = Number(arg("--seed", "20261128"));
const out = arg("--out", "native/tools/fresh/problems-polyhedra.json");
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
const index = loadSpacesIndex(root);
const open = (space: SpaceName, id: string): boolean => {
  const parsed = parseSpaceId(space, id);
  if (typeof parsed === "string") return false;
  const cat = index[space];
  const p = cat && problemOf(cat, parsed);
  return !!p && acceptsSubmissions(p) && p.bound !== null && Number.isFinite(p.bound.value);
};

const codes = SOLID_NAMES_LIST.map((s: { code: string }) => s.code);
const recordCodes = PROBLEM_NAMES.map((p: { code: string }) => p.code);
const drawn: string[] = [];
const draw = (make: () => string, space: SpaceName) => {
  for (let tries = 0; tries < 1000; tries++) {
    const id = make();
    if (!drawn.includes(id) && open(space, id)) {
      drawn.push(id);
      return;
    }
  }
  throw new Error("no open problem drawn");
};
for (const [lo, hi] of [
  [2, 5],
  [6, 15],
  [16, 60],
]) {
  for (let k = 0; k < 2; k++) draw(() => `polyhedra/${recordCodes[int(0, recordCodes.length - 1)]}/${int(lo!, hi!)}`, "polyhedra");
  for (let k = 0; k < 2; k++)
    draw(() => `polyhedra/${codes[int(0, codes.length - 1)]}in${codes[int(0, codes.length - 1)]}/${int(lo!, hi!)}`, "polyhedra");
}
const inBall = BALLS_PROBLEMS.filter((b: { piece: string; container: string }) => b.piece !== "ball" && b.container === "ball");
for (let k = 0; k < 4; k++) draw(() => `balls/${inBall[int(0, inBall.length - 1)]!.code}/${int(2, 20)}`, "balls");
writeFileSync(resolve(root, out), JSON.stringify(drawn, null, 1) + "\n");
console.error(`wrote ${drawn.length} problems to ${out}`);
