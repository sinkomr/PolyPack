// Draws the benchmark problem set (native/FRESH.md) from the real catalogues, seeded.
//
//   npx tsx native/tools/fresh/draw.mts [--seed 20261121] [--out native/tools/fresh/problems.json]
//
// 10 flat, 8 curved (K = -1 or 1, disks), 6 sphere (disks), 8 balls (ball pieces). Only problems that exist
// and accept submissions: flat ones the literature has not closed (proven optimum or zero-waste tiling:
// closedToSubmissions, as POST /api/submit decides), the others the spaces' own rule (problemOf from the
// catalogue or the family's domain, acceptsSubmissions: as POST /api/spaces/submit).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { closedToSubmissions, type LiteratureRecord } from "@polypack/geometry";
import { acceptsSubmissions, parseSpaceId, problemOf, type SpaceName } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { BALLS_PROBLEMS } from "@polypack/balls/catalogue";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const seed = Number(arg("--seed", "20261121"));
const out = arg("--out", "native/tools/fresh/problems.json");
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
function pick<T>(pool: T[], n: number, accept: (x: T) => boolean = () => true): T[] {
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  const got: T[] = [];
  for (const x of a) {
    if (got.length === n) break;
    if (accept(x)) got.push(x);
  }
  return got;
}
// A curved problem can have no packing although the domain's area bound allows it: at K = 1 the whole space is a
// sphere of area 4 pi, and at K = -1 a polygon container's area stays below (M - 2) pi however large it grows, so
// near that limit P disks may not fit. The catalogue cannot say so (its research records cover polygon pieces
// only). A curved problem is drawn only if the native client's search finds a valid packing of it in 2 CPU seconds
// (--no-screen skips this). The screen is conservative towards the fresh solver: a problem only it could pack is
// left out. 5 problems are drawn at K = -1 and 3 at K = 1.
const bin = resolve(import.meta.dirname, "../../target/release/polypack-native");
const screen = !process.argv.includes("--no-screen") && existsSync(bin);
const feasible = (id: string): boolean => {
  if (!screen) return true;
  const r = spawnSync(bin, ["bench-space", "--id", id, "--seconds", "2", "--seed", "1"], { encoding: "utf8" });
  try {
    const ok = JSON.parse(r.stdout).score !== null;
    if (!ok) console.error(`screened out ${id}: no packing found`);
    return ok;
  } catch {
    return false;
  }
};
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const records: LiteratureRecord[] = JSON.parse(readFileSync(resolve(root, "data/records.json"), "utf8")).records;
const literature = new Map(records.map((r) => [`${r.N}/${r.M}/${r.P}`, r]));
const index = loadSpacesIndex(root);

const open = (space: SpaceName, id: string): boolean => {
  const parsed = parseSpaceId(space, id);
  if (typeof parsed === "string") return false;
  const cat = index[space];
  const p = cat && problemOf(cat, parsed);
  // a problem that cannot exist (a curved container too small for P pieces, say) has a null bound and no packing
  return !!p && acceptsSubmissions(p) && p.bound !== null && Number.isFinite(p.bound.value);
};

const flat: string[] = [];
for (const N of [0, 3, 4, 5, 6, 7, 8])
  for (const M of [0, 3, 4, 5, 6, 8])
    for (const P of range(5, 40)) {
      if (closedToSubmissions(literature.get(`${N}/${M}/${P}`))) continue;
      flat.push(`flat/${N}/${M}/${P}`);
    }
const curved: string[] = [];
for (const K of [-1, 1])
  for (const M of [0, 3, 4, 5, 6, 8])
    for (const P of range(5, 30)) {
      const id = `curved/${K}/0/${M}/${P}`;
      if (open("curved", id)) curved.push(id);
    }
const sphere = range(5, 80).map((P) => `sphere/0/${P}`).filter((id) => open("sphere", id));
const balls: string[] = [];
for (const b of BALLS_PROBLEMS.filter((b) => b.piece === "ball"))
  for (const P of range(5, 60)) {
    const id = `balls/${b.code}/${P}`;
    if (open("balls", id)) balls.push(id);
  }

const curvedNeg = curved.filter((id) => id.startsWith("curved/-1/"));
const curvedPos = curved.filter((id) => id.startsWith("curved/1/"));
const drawn = [...pick(flat, 10), ...pick(curvedNeg, 5, feasible), ...pick(curvedPos, 3, feasible), ...pick(sphere, 6), ...pick(balls, 8)];
console.error(`candidates: flat ${flat.length}, curved ${curved.length}, sphere ${sphere.length}, balls ${balls.length}`);
writeFileSync(resolve(root, out), JSON.stringify(drawn, null, 1) + "\n");
console.error(`wrote ${drawn.length} problems to ${out}`);
