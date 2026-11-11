// Builds the cases of the spaces layer (packages/spaces) and writes the TypeScript's answers and
// timings: the reference that native/spaces (crate polypack-spaces) is compared with
// (native/PORTING.md).
//
//   node --import tsx native/tools/spaces-ref.mts OUTDIR SNAPDIR [--fixtures native/spaces/tests/fixtures] [--quick] [--skip-main]
//   cargo run --release -p polypack-spaces --example spacesdiff -- OUTDIR
//   node native/tools/spaces-compare.mjs OUTDIR
//
// SNAPDIR holds the nightly snapshot's files space-<space>.json.gz (the site's leading entries).
//
// Main cases (cases.jsonl, ref.jsonl): `validateSpaceSubmission(space, id, config, opts)` and its
// Async variant, with the options the server passes (bound, certified, noRecord, maxP of the
// loaded catalogue), and `parseSpaceConfig` on the same input:
//  - entry: leading entries of the site, sampled over every kind of problem of each space;
//  - record: research records of data/<space>/ (configurations kept apart are read from their files);
//  - record-strict: records under the rule of a problem without a record (the strict pass);
//  - mutants of both: the size shrunk by 1e-10, 5e-10, 2e-9, 3e-9 and 1e-6 relative, sizes just
//    below the lower bound inside and outside its slack, a piece moved onto another, a piece moved
//    out of the container, a piece too few and one too many, the same under the rule of a problem
//    without a record;
//  - random: random configurations of problems of every domain;
//  - malformed: every value a parser can refuse, at each place of a configuration (the size, the
//    list, a piece, each field of a piece), more errors than a verdict lists, ids that are not the
//    space's, P above the catalogue's;
// Auxiliary cases (aux-cases.jsonl, aux-ref.jsonl): ids (parseSpaceId, formatSpaceId, spaceOfId,
// formatCurvature), the catalogues of damaged record files (buildSpaceCatalogue), the on-demand
// loader, domains (info, bound, sample, the curved menu), storedSpaceConfig on free tori, the
// comparison rules (beatsSpaceScore, beatsSpaceRecord, improvesSpaceBest), the constants.
// Files of their own: index.ts.jsonl (loadSpacesIndex on the repository's data/: the log, and
// every entry), listing-<space>.ts.json (the records listing as the server sends it), and
// spaces.ts.json (the answer of GET /api/spaces).
// ts-times.json: best of five of validateSpaceSubmission per main case, in nanoseconds.
import { mkdirSync, readFileSync, writeFileSync, createReadStream, createWriteStream, rmSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSolid } from "../../packages/surface/src/solids.ts";
import { getPolytope, highDimShape } from "../../packages/boundary/src/index.ts";
import { ndCheckOps, ndIsHeavy } from "../../packages/ndspace/src/validate.ts";
import {
  CURVED_KS,
  CURVED_MENU_KS,
  CURVED_MENU_K_IDS,
  CURVED_MS,
  CURVED_TILING_KS,
  PIECE_NS,
  SPACE_BOUND_SLACK,
  SPACE_EXHIBITS,
  SPACE_INFO,
  SPACE_MAX_COORD,
  SPACE_MAX_P,
  SPACE_MAX_SIZE,
  SPACE_MIN_QUATERNION_NORM,
  SPACE_NAMES,
  SPACE_RECORD_MARGIN,
  SPACE_STRICT_NO_RECORD_REASON,
  SPACE_STRICT_REASON,
  SPACE_STRICT_TOL,
  SPACE_TOL,
  SURFACE_MAX_CHAINS,
  TORUS_MAX_TRANSLATES,
  BOUNDARY_MAX_CHAINS,
  BOUNDARY_MAX_S,
  POLYHEDRA_MAX_QUATERNION,
  SPACE_DOMAINS,
  type SpaceCatalogue,
  type SpaceName,
  type SpaceProblemEntry,
  acceptsSubmissions,
  beatsSpaceRecord,
  beatsSpaceScore,
  boundaryCheckMs,
  boundaryIsHeavy,
  buildSpaceCatalogue,
  configLocation,
  domainMaxP,
  entryConfig,
  formatCurvature,
  formatSpaceId,
  hasRecord,
  impossibleReason,
  improvesSpaceBest,
  isSpaceName,
  parseSpaceConfig,
  parseSpaceId,
  problemOf,
  spaceOfId,
  spaceProblemSummary,
  storedSpaceConfig,
  storedSpaceConfigAsync,
  validateSpaceSubmission,
  validateSpaceSubmissionAsync,
} from "../../packages/spaces/src/index.ts";
import { countCurvedProblems } from "../../packages/spaces/src/piece-domains.ts";
import { configLoader, loadSpacesIndex, readEntryConfigSync } from "../../packages/spaces/src/load.ts";

const args = process.argv.slice(2);
const fx = args.indexOf("--fixtures");
const fixturesDir = fx >= 0 ? args.splice(fx, 2)[1] : null;
const qk = args.indexOf("--quick");
const quick = qk >= 0 ? (args.splice(qk, 1), true) : false;
// --skip-main: the main cases are built again (they must be the ones OUTDIR holds) but not run; their answers
// and timings are those of the earlier run. For work on the auxiliary cases and on the fixtures.
const sm = args.indexOf("--skip-main");
const skipMain = sm >= 0 ? (args.splice(sm, 1), true) : false;
const [outDir, snapDir] = args;
if (!outDir || !snapDir) throw new Error("usage: spaces-ref.mts OUTDIR SNAPDIR [--fixtures DIR] [--quick] [--skip-main]");
mkdirSync(outDir, { recursive: true });
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// mulberry32: the cases are the same at every run
let seed = 20261110;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T,>(list: readonly T[]): T => list[int(0, list.length - 1)];
const sym = (r: number) => (2 * rnd() - 1) * r;
/** A random selection of at most n of the list, in the list's order. */
function some<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  const chosen = new Set<number>();
  while (chosen.size < n) chosen.add(int(0, list.length - 1));
  return [...chosen].sort((a, b) => a - b).map((k) => list[k]);
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
type Json = any;

// ---- the catalogues, as the server loads them ------------------------------------------------
const indexLog: string[] = [];
const index = loadSpacesIndex(root, (m) => indexLog.push(m));

type Opts = { bound?: number | null; maxP?: number; certified?: number | null; noRecord?: boolean };
/** The options the server passes for a problem (apps/server/src/spaces.ts), or none for an id that is no problem. */
function serverOpts(space: SpaceName, id: unknown): Opts {
  const cat = index[space];
  const parsed = parseSpaceId(space, id);
  if (!cat || typeof parsed === "string") return {};
  const p = problemOf(cat, parsed);
  if (!p) return { maxP: cat.maxP };
  return { bound: p.bound?.value ?? null, maxP: cat.maxP, certified: p.certified?.score ?? null, noRecord: !hasRecord(p) };
}

interface Case {
  id: number;
  kind: string;
  space: SpaceName;
  problem: Json;
  config: Json;
  opts: Opts;
}
const cases: Case[] = [];
const add = (kind: string, space: SpaceName, problem: Json, config: Json, opts?: Opts) =>
  cases.push({ id: cases.length, kind, space, problem, config: clone(config), opts: clone(opts ?? serverOpts(space, problem)) });

// ---- real packings --------------------------------------------------------------------------
interface Real {
  space: SpaceName;
  source: "entry" | "record";
  problem: string;
  P: number;
  config: Json;
}
/** The key a space's problems are sampled by: every kind of problem gets its share. */
function groupOf(space: SpaceName, problem: string, source: Real["source"]): string {
  const parts = problem.split("/");
  // the site's surface entries: by solid and mode (141 solids); its records: by solid, mode and N
  if (space === "surface" && source === "entry") return parts.slice(1, 3).join("/");
  return parts.slice(1, -1).join("/");
}
/** Per group: the entry with the most pieces, and `perGroup - 1` others. */
function sample(list: Real[], space: SpaceName, perGroup: number, cap: number): Real[] {
  const groups = new Map<string, Real[]>();
  for (const r of list) {
    const k = groupOf(space, r.problem, r.source);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  let out: Real[] = [];
  for (const g of groups.values()) {
    const largest = g.reduce((a, b) => (b.P > a.P ? b : a));
    out.push(largest, ...some(g.filter((r) => r !== largest), perGroup - 1));
  }
  if (out.length > cap) out = some(out, cap);
  return out;
}
async function snapshot(space: SpaceName, keep: (problem: string, P: number) => boolean): Promise<Real[]> {
  const out: Real[] = [];
  const rl = createInterface({ input: createReadStream(join(snapDir, `space-${space}.json.gz`)).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim().replace(/,$/, "");
    if (!text.startsWith('{"problem"')) continue;
    const m = /^\{"problem":"([^"]+)","P":(\d+)/.exec(text)!;
    if (!keep(m[1], Number(m[2]))) continue;
    const r = JSON.parse(text);
    out.push({ space, source: "entry", problem: r.problem, P: r.P, config: r.config });
  }
  return out;
}
const PER: Record<SpaceName, { entries: [number, number]; records: [number, number]; mutants: number; random: number }> = {
  surface: { entries: [2, 520], records: [5, 320], mutants: 50, random: 40 },
  curved: { entries: [9, 200], records: [9, 300], mutants: 50, random: 40 },
  sphere: { entries: [4, 320], records: [99, 200], mutants: 50, random: 40 },
  torus: { entries: [3, 300], records: [20, 330], mutants: 50, random: 40 },
  boundary: { entries: [9, 50], records: [40, 50], mutants: 40, random: 60 },
  polyhedra: { entries: [1, 420], records: [2, 300], mutants: 40, random: 30 },
  balls: { entries: [2, 420], records: [0, 0], mutants: 50, random: 40 },
  ndim: { entries: [9, 50], records: [3, 170], mutants: 30, random: 40 },
};
if (quick) for (const s of SPACE_NAMES) PER[s] = { entries: [1, 12], records: [1, 12], mutants: 4, random: 4 };

const reals: Record<string, Real[]> = {};
for (const space of SPACE_NAMES) {
  // polyhedra: 20,065 entries of 171 MB; one in six is read, and every one above P = 200
  const all = await snapshot(space, (_, P) => space !== "polyhedra" || P > 200 || rnd() < 1 / 6);
  let entries = sample(all, space, ...PER[space].entries);
  // the largest checks of the space are always there (polyhedra and torus at P = 500)
  const big = [...all].sort((a, b) => b.P - a.P).slice(0, quick ? 1 : 6);
  entries = [...new Set([...entries, ...big])];
  const cat = index[space]!;
  const recorded: Real[] = [];
  for (const p of cat.problems) {
    if (p.status === "infeasible") continue;
    recorded.push({ space, source: "record", problem: p.id, P: p.P, config: p });
  }
  const records = sample(recorded, space, ...PER[space].records);
  for (const r of records) {
    const p = r.config as SpaceProblemEntry;
    const text = p.configApart ? readEntryConfigSync(root, cat, p) : p.config;
    if (text === null) throw new Error(`${p.id}: the record's configuration could not be read`);
    r.config = JSON.parse(text);
  }
  reals[space] = [...entries, ...records];
  for (const r of entries) add("entry", space, r.problem, r.config);
  for (const r of records) {
    add("record", space, r.problem, r.config);
    add("record-strict", space, r.problem, r.config, { ...serverOpts(space, r.problem), certified: null, noRecord: true });
  }
}

// ---- mutants ---------------------------------------------------------------------------------
/** The configuration with its stated size multiplied by k (nothing else moves). */
function resized(space: SpaceName, c: Json, k: number): Json {
  const out = clone(c);
  if (space === "curved") out.size *= k;
  else if (space === "sphere") out.rho *= k;
  else if (space === "torus") {
    if ("L" in out.lattice) out.lattice.L *= k;
    else {
      out.lattice.b1 = out.lattice.b1.map((x: number) => x * k);
      out.lattice.b2 = out.lattice.b2.map((x: number) => x * k);
    }
  } else out.s *= k;
  return out;
}
const sizeOf = (space: SpaceName, c: Json): number =>
  space === "curved" ? c.size : space === "sphere" ? c.rho : space === "torus" ? ("L" in c.lattice ? c.lattice.L : Math.sqrt(Math.abs(c.lattice.b1[0] * c.lattice.b2[1] - c.lattice.b1[1] * c.lattice.b2[0]))) : c.s;
const listKey = (space: SpaceName) => (space === "torus" ? "poses" : "pieces");
/** Piece k moved far from where it is, in the space's format. */
function movedOut(space: SpaceName, c: Json): Json | null {
  const out = clone(c);
  const p = out[listKey(space)][0];
  const far = 10 * sizeOf(space, c) + 5;
  if (space === "surface" || space === "curved") p.x += far;
  else if (space === "boundary") p.u[0] += far;
  else if (space === "polyhedra" || space === "balls" || space === "ndim") p[0] += far;
  else return null;
  return out;
}
for (const space of SPACE_NAMES) {
  const bases = some(reals[space].filter((r) => r.P <= 120), PER[space].mutants);
  for (const r of bases) {
    const { problem, config: c } = r;
    const key = listKey(space);
    const opts = serverOpts(space, problem);
    const noRecord = { ...opts, certified: null, noRecord: true };
    for (const shrink of [1e-10, 5e-10, 2e-9, 3e-9, 1e-6]) {
      add(`shrink-${shrink}`, space, problem, resized(space, c, 1 - shrink));
      if (shrink !== 5e-10) add(`shrink-${shrink}-norecord`, space, problem, resized(space, c, 1 - shrink), noRecord);
    }
    add("grow-1e-9", space, problem, resized(space, c, 1 + 1e-9), noRecord);
    if (typeof opts.bound === "number") {
      // just below the lower bound: inside its slack of 1e-9, and outside
      for (const below of [0.5e-9, 2e-9, 1e-3]) add(`below-bound-${below}`, space, problem, resized(space, c, (opts.bound * (1 - below)) / sizeOf(space, c)));
      add("unbounded", space, problem, resized(space, c, (opts.bound * (1 - 2e-9)) / sizeOf(space, c)), { ...opts, bound: null });
    }
    if (c[key].length >= 2) {
      const overlap = clone(c);
      overlap[key][1] = clone(overlap[key][0]);
      add("overlap", space, problem, overlap);
      add("overlap-norecord", space, problem, overlap, noRecord);
      const fewer = clone(c);
      fewer[key].pop();
      add("one-fewer", space, problem, fewer);
    }
    const more = clone(c);
    more[key].push(clone(more[key][0]));
    add("one-more", space, problem, more);
    const out = movedOut(space, c);
    if (out) add("outside", space, problem, out);
    add("maxP-below", space, problem, c, { ...opts, maxP: r.P - 1 });
    add("no-options", space, problem, c, {});
  }
}

// ---- random configurations -------------------------------------------------------------------
function unitQuaternion(): number[] {
  const q = [sym(1), sym(1), sym(1), sym(1)];
  const n = Math.hypot(...q) || 1;
  return q.map((x) => x / n);
}
function randomConfig(space: SpaceName, problem: string, scale: number): Json {
  const id = parseSpaceId(space, problem);
  if (typeof id === "string") throw new Error(id);
  const f = id.fields as Record<string, Json>;
  const bound = index[space]!.domain?.bound(id)?.value ?? 1;
  const size = Math.max(bound, 0.3) * scale;
  const list = Array.from({ length: id.P }, () => {
    switch (space) {
      case "surface":
        return { face: int(0, getSolid(f.solid).F - 1), x: sym(size / 3), y: sym(size / 3), theta: sym(Math.PI) };
      case "curved":
        return { x: sym(size / 3), y: sym(size / 3), theta: sym(Math.PI) };
      case "sphere":
        return { q: unitQuaternion() };
      case "torus":
        return [rnd() * size, rnd() * size, sym(Math.PI)];
      case "boundary": {
        const hd = highDimShape(f.polytope);
        const C = hd ? hd.cells : getPolytope(f.polytope).cells.length;
        const u = Array.from({ length: hd ? hd.dimU : 3 }, () => sym(size / 4));
        const piece: Json = { cell: int(0, C - 1), u };
        if (!hd && f.piece !== "ball" && rnd() < (f.polytope === "tesseract" && f.piece === "cube" ? 0.3 : 0.9)) piece.q = unitQuaternion();
        return piece;
      }
      case "polyhedra":
        return [sym(size / 3), sym(size / 3), sym(size / 3), ...unitQuaternion()];
      case "balls":
        return f.piece === "ball" ? [sym(size / 3), sym(size / 3), sym(size / 3)] : [sym(size / 3), sym(size / 3), sym(size / 3), ...unitQuaternion()];
      case "ndim": {
        const d = f.d as number;
        const t = Array.from({ length: d }, () => sym(size / 3));
        return f.piece === "ball" ? t : [...t, ...Array.from({ length: (d * (d - 1)) / 2 }, () => sym(0.8))];
      }
    }
  });
  switch (space) {
    case "curved":
      return { size, pieces: list };
    case "sphere":
      return { rho: size, pieces: list };
    case "torus":
      return f.family === "free" ? { lattice: { b1: [size, 0], b2: [sym(size / 2), size] }, poses: list } : { lattice: { L: size }, poses: list };
    default:
      return { s: size, pieces: list };
  }
}
/** Ids of the domain in every part of it: its sample (small P first), spread, and the records. */
function domainIds(space: SpaceName, n: number): string[] {
  const from = SPACE_DOMAINS[space]!.sample(4000);
  const recorded = index[space]!.problems.map((p) => p.id);
  return [...some(from, n), ...some(recorded, Math.ceil(n / 3))];
}
for (const space of SPACE_NAMES) {
  for (const problem of domainIds(space, PER[space].random)) {
    const id = parseSpaceId(space, problem);
    if (typeof id === "string") throw new Error(id);
    // the heaviest ndim problems are left to the entries and records: a random pile of 8D polytopes costs seconds
    if (space === "ndim" && ndIsHeavy({ d: id.fields.d as number, piece: String(id.fields.piece), container: String(id.fields.container), P: id.P })) continue;
    // loose (valid when lucky, a few overlaps otherwise) and crowded (more overlaps than a verdict lists)
    add("random-loose", space, problem, randomConfig(space, problem, 1.6 + 2 * rnd()));
    if (id.P >= 3) add("random-crowded", space, problem, randomConfig(space, problem, 1.02));
  }
}
// curved problems that cannot exist (infeasible records and impossible ids), with a configuration all the same
for (const p of index.curved!.problems.filter((p) => p.status === "infeasible").slice(0, quick ? 2 : 12))
  add("infeasible", "curved", p.id, { size: 3, pieces: Array.from({ length: p.P }, () => ({ x: sym(0.5), y: sym(0.5), theta: sym(3) })) });

// ---- malformed input -------------------------------------------------------------------------
/** A valid configuration of each kind of problem, to damage: the first real one, else a random one. */
const BASES: [SpaceName, string][] = [
  ["surface", "surface/cube/fold/4/3"],
  ["surface", "surface/snub_disphenoid/nofold/0/2"],
  ["curved", "curved/-1/3/4/3"],
  ["curved", "curved/1/0/0/2"],
  ["sphere", "sphere/4/3"],
  ["sphere", "sphere/0/2"],
  ["torus", "torus/sq/4/3"],
  ["torus", "torus/hex/0/2"],
  ["torus", "torus/free/5/3"],
  ["boundary", "boundary/tesseract/ball/3"],
  ["boundary", "boundary/tesseract/cube/2"],
  ["boundary", "boundary/24cell/tetrahedron/2"],
  ["boundary", "boundary/6cube/ball/3"],
  ["boundary", "boundary/5cube/cube/2"],
  ["boundary", "boundary/5simplex/ball/2"],
  ["boundary", "boundary/6demicube/ball/2"],
  ["polyhedra", "polyhedra/cubintet/3"],
  ["balls", "balls/ballinball/3"],
  ["balls", "balls/ballincub/2"],
  ["balls", "balls/tetinball/2"],
  ["ndim", "ndim/4/cube/ortho/3"],
  ["ndim", "ndim/5/ball/simplex/2"],
  ["ndim", "ndim/4/24cell/ball/2"],
];
/** Values no field takes, and values only some take. */
const BAD: Json[] = [null, "1", true, false, [], {}, [1, 2], { x: 1 }, -1, 0, 0.5, 1.5, 3, 7, 1e5, 2e6, -2e6, 1e-7, 1e101, 1e-320, "", "x", [[]], [null]];
/** Every place of a configuration: the whole, each key, the first, second and last piece and each of their fields. */
function places(c: Json): (string | number)[][] {
  const out: (string | number)[][] = [[]];
  const walk = (v: Json, path: (string | number)[], depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(v)) {
      const ks = [...new Set([0, 1, v.length - 1])].filter((k) => k >= 0 && k < v.length);
      for (const k of path.length <= 1 ? ks : v.map((_, k) => k)) {
        out.push([...path, k]);
        walk(v[k], [...path, k], depth + 1);
      }
    } else if (typeof v === "object" && v !== null)
      for (const k of Object.keys(v)) {
        out.push([...path, k]);
        walk(v[k], [...path, k], depth + 1);
      }
  };
  walk(c, [], 0);
  return out;
}
function setAt(c: Json, path: (string | number)[], value: Json, remove = false): Json {
  if (!path.length) return clone(value);
  const out = clone(c);
  let at = out;
  for (const k of path.slice(0, -1)) at = at[k];
  const last = path[path.length - 1];
  if (!remove) at[last] = clone(value);
  else if (Array.isArray(at)) at.splice(last as number, 1);
  else delete at[last];
  return out;
}
for (const [space, problem] of quick ? BASES.filter((_, k) => k % 3 === 0) : BASES) {
  const real = reals[space].find((r) => r.problem === problem);
  let base: Json = real?.config;
  if (!base) {
    // a random configuration that parses; valid or not does not matter here
    base = randomConfig(space, problem, 3);
  }
  add("base", space, problem, base);
  const where = places(base);
  for (const path of where) {
    const name = path.join(".") || "(config)";
    if (path.length) add(`missing:${name}`, space, problem, setAt(base, path, null, true));
    for (const [k, bad] of BAD.entries()) {
      if (quick && k % 5) continue;
      add(`bad:${name}=${JSON.stringify(bad)}`, space, problem, setAt(base, path, bad));
    }
  }
  // fields the format does not have: dropped from the configuration that is kept
  const extra = clone(base);
  extra.note = "an extra field";
  extra.P = 99;
  const first = extra[listKey(space)][0];
  if (Array.isArray(first)) {
    if (space === "ndim" && !problem.includes("/ball/")) first.push(0);
  } else first.colour = "red";
  add("extra-fields", space, problem, extra);
  // the torus lattice in the other family's form, in both, in neither
  if (space === "torus") {
    for (const lattice of [{ L: 3 }, { b1: [3, 0], b2: [0, 3] }, { L: 3, b1: [3, 0], b2: [0, 3] }, { L: 3, b1: [3, 0] }, { L: 3, b2: [0, 3] }, { b1: [3, 0] }, { b2: [0, 3] }, {}, { b1: [3, 0], b2: [6, 0] }, { b1: [0, 0], b2: [0, 0] }, { b1: [3, 0, 0], b2: [0, 3] }, { b1: [1e-200, 0], b2: [0, 1e-200] }, { b1: [3, 0], b2: [1e-9, 1e-300] }, { L: 1e-3 }, { b1: [3, 0], b2: [3000, 3] }, { b1: [0.5, 0], b2: [0, 30] }, { b1: [3, 0], b2: [-1.5, 2.6] }, { b1: [0, 3], b2: [3, 0] }])
      add(`lattice=${JSON.stringify(lattice)}`, space, problem, { ...base, lattice });
  }
  // rotations where the format has none, and ones that are not unit
  if (space === "boundary") {
    for (const q of [[1, 0, 0, 0], [0.5, 0.5, 0.5, 0.5], [1, 0, 0, 1e-9], [1, 0, 0, 1e-4], [2, 0, 0, 0], [0, 0, 0, 0], [1, 0, 0], [1, 0, 0, 0, 0], null, "q", [1, 0, 0, "0"], [1e5, 0, 0, 0], [0.6, 0.8, 0, 0], [1 + 5e-10, 0, 0, 0]])
      add(`q=${JSON.stringify(q)}`, space, problem, setAt(base, ["pieces", 0, "q"], q));
  }
}
// more errors than a verdict lists (20), in every parser: each piece wrong, in two ways
for (const [space, problem, piece] of [
  ["surface", "surface/cube/fold/4/30", { face: 9, x: "a", y: null, theta: 1e9 }],
  ["surface", "surface/cube/nofold/3/30", 5],
  ["curved", "curved/-1/3/4/30", { x: "a", y: 1, theta: 1e9 }],
  ["sphere", "sphere/4/30", { q: [0, 0, 0, 0] }],
  ["sphere", "sphere/5/30", { q: [1, "a", null, 1e9] }],
  ["torus", "torus/sq/4/30", [1, 2]],
  ["torus", "torus/free/4/30", ["a", null, 1e9]],
  ["boundary", "boundary/tesseract/ball/16", { cell: 8, u: [1e9, "a", 0], q: [1, 0, 0, 0] }],
  ["boundary", "boundary/6cube/cube/30", { cell: -1, u: [0, 0, 0], q: [1, 0, 0, 0] }],
  ["polyhedra", "polyhedra/cubintet/30", [0, 0, 0, 0, 0, 0, 0]],
  ["polyhedra", "polyhedra/cubintet/30", [1e9, 0, 0, 1, 0, 0, 0]],
  ["balls", "balls/ballinball/30", [0, 0]],
  ["balls", "balls/tetinball/30", [0, 0, 0, 0, 0, 0, 0]],
  ["ndim", "ndim/4/cube/ortho/30", [0, 0, 0, 0]],
  ["ndim", "ndim/5/ball/ball/30", [1e9, 0, 0, 0, 0]],
] as [SpaceName, string, Json][]) {
  const P = Number(problem.split("/").pop());
  const size = space === "curved" ? { size: 9 } : space === "sphere" ? { rho: 9 } : space === "torus" ? { lattice: problem.includes("free") ? { b1: [9, 0], b2: [0, 9] } : { L: 9 } } : { s: 9 };
  const key = listKey(space);
  add("many-errors", space, problem, { ...size, [key]: Array.from({ length: P }, () => piece) });
  // the size wrong too, and a piece too few: the errors read so far make it malformed
  add("many-errors-short", space, problem, { [key]: Array.from({ length: P - 1 }, () => piece) });
  add("size-wrong-short", space, problem, { ...Object.fromEntries(Object.keys(size).map((k) => [k, "big"])), [key]: [] });
  add("no-list", space, problem, size);
}
// work limits: a piece far larger than the faces it lies on, on a solid or a polytope with no lower bound given
for (const [space, problem, config] of [
  ["surface", "surface/antiprism12/fold/100/1", { s: 0.3, pieces: [{ face: 0, x: 0, y: 0, theta: 0 }] }],
  ["surface", "surface/antiprism12/fold/100/2", { s: 1.5, pieces: [{ face: 0, x: 0, y: 0, theta: 0 }, { face: 1, x: 0, y: 0, theta: 0.3 }] }],
  ["surface", "surface/icosahedron/fold/50/1", { s: 0.05, pieces: [{ face: 3, x: 0, y: 0, theta: 1 }] }],
  ["surface", "surface/snub_dodecahedron/fold/0/1", { s: 0.01, pieces: [{ face: 0, x: 0, y: 0, theta: 0 }] }],
  ["surface", "surface/cube/nofold/100/1", { s: 0.05, pieces: [{ face: 0, x: 0, y: 0, theta: 0 }] }],
  ["boundary", "boundary/120cell/ball/1", { s: 0.02, pieces: [{ cell: 0, u: [0, 0, 0] }] }],
  ["boundary", "boundary/600cell/icosahedron/1", { s: 0.05, pieces: [{ cell: 5, u: [0, 0, 0], q: [1, 0, 0, 0] }] }],
  ["boundary", "boundary/tesseract/ball/1", { s: 0.01, pieces: [{ cell: 0, u: [0, 0, 0] }] }],
  ["boundary", "boundary/10cube/ball/2", { s: 0.3, pieces: [{ cell: 0, u: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, { cell: 3, u: [0.1, 0, 0, 0, 0, 0, 0, 0, 0] }] }],
  ["boundary", "boundary/8demicube/ball/2", { s: 0.4, pieces: [{ cell: 0, u: [0, 0, 0, 0, 0, 0, 0] }, { cell: 20, u: [0, 0, 0, 0, 0, 0, 0] }] }],
  ["torus", "torus/free/0/1", { lattice: { b1: [1, 0], b2: [200.3, 1] }, poses: [[0, 0, 0]] }],
  ["torus", "torus/free/4/2", { lattice: { b1: [1e-3, 0], b2: [0, 1e3] }, poses: [[0, 0, 0], [0, 500, 0]] }],
  ["torus", "torus/sq/7/2", { lattice: { L: 0.2 }, poses: [[0, 0, 0], [0.1, 0.1, 0]] }],
  ["curved", "curved/-1/3/4/2", { size: 30, pieces: [{ x: 0, y: 0, theta: 0 }, { x: 9000, y: 9000, theta: 0 }] }],
  ["curved", "curved/-6.519717439579256/3/7/2", { size: 5, pieces: [{ x: 0, y: 0, theta: 0 }, { x: 700, y: 0, theta: 0 }] }],
  ["curved", "curved/1/4/4/1", { size: 3.2, pieces: [{ x: 0, y: 0, theta: 0 }] }],
  ["curved", "curved/1/100/0/1", { size: 2, pieces: [{ x: 0, y: 0, theta: 0 }] }],
  ["sphere", "sphere/100/1", { rho: 0.5, pieces: [{ q: [1, 0, 0, 0] }] }],
  ["sphere", "sphere/3/2", { rho: 0.2, pieces: [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }] }],
] as [SpaceName, string, Json][]) {
  add("work-limit", space, problem, config, {});
  add("work-limit-with-options", space, problem, config);
}
// ids that are not the space's, in validateSpaceSubmission itself
for (const space of SPACE_NAMES) {
  const r = reals[space][0];
  const other = SPACE_NAMES[(SPACE_NAMES.indexOf(space) + 1) % SPACE_NAMES.length];
  add("id-of-another-space", space, reals[other][0].problem, r.config);
  add("id-malformed", space, r.problem + "/", r.config);
  add("id-zero-pieces", space, r.problem.replace(/\/\d+$/, "/0"), r.config);
  add("id-9999-pieces", space, r.problem.replace(/\/\d+$/, "/9999"), r.config);
  add("id-9999-pieces-own-cap", space, r.problem.replace(/\/\d+$/, "/9999"), r.config, {});
  add("id-empty", space, "", r.config);
}

// ---- the main run ----------------------------------------------------------------------------
// A case is run on what a server reads: the JSON text of its configuration (-0 is then 0).
const stored = (c: Json): string | null => (c === null || c === undefined ? null : JSON.stringify(c));
const verdictOf = (v: Json) => ({ valid: v.valid, score: v.score, reasons: v.reasons, malformed: v.malformed, config: stored(v.config) });
const refs: Json[] = [];
let t0 = performance.now();
if (skipMain) {
  const lines = async (file: string, each: (line: string, k: number) => void) => {
    let k = 0;
    for await (const line of createInterface({ input: createReadStream(join(outDir, file)), crlfDelay: Infinity })) if (line.length) each(line, k++);
    return k;
  };
  const n = await lines("cases.jsonl", (line, k) => {
    if (line !== JSON.stringify(cases[k])) throw new Error(`--skip-main: case ${k} is not the one ${outDir}/cases.jsonl holds; run without --skip-main`);
  });
  if (n !== cases.length) throw new Error(`--skip-main: ${cases.length} cases, ${n} in ${outDir}/cases.jsonl`);
  await lines("ref.jsonl", (line) => refs.push(JSON.parse(line)));
  if (refs.length !== cases.length) throw new Error(`--skip-main: ${cases.length} cases, ${refs.length} answers in ${outDir}/ref.jsonl`);
  console.error(`${cases.length} main cases, with the answers of the earlier run`);
} else {
  const casesOut = createWriteStream(join(outDir, "cases.jsonl"));
  const refOut = createWriteStream(join(outDir, "ref.jsonl"));
  const write = (stream: ReturnType<typeof createWriteStream>, text: string) =>
    new Promise<void>((done) => (stream.write(text + "\n") ? done() : stream.once("drain", () => done())));
  for (const c of cases) {
    const text = JSON.stringify(c);
    await write(casesOut, text);
    const run = JSON.parse(text) as Case;
    const parsedId = parseSpaceId(run.space, run.problem);
    let parse: Json = null;
    if (typeof parsedId !== "string") {
      const p = parseSpaceConfig(parsedId, run.config);
      parse = p.ok ? { ok: true, score: p.score, config: stored(p.config) } : { ok: false, malformed: p.malformed, errors: p.errors };
    }
    const sync = verdictOf(validateSpaceSubmission(run.space, run.problem, run.config, run.opts));
    const asyncVerdict = verdictOf(await validateSpaceSubmissionAsync(run.space, run.problem, run.config, run.opts));
    const ref = { id: c.id, parse, sync, async: asyncVerdict };
    refs.push(ref);
    await write(refOut, JSON.stringify(ref));
  }
  casesOut.end();
  refOut.end();
  console.error(`${cases.length} main cases in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  // ---- timings: best of five of validateSpaceSubmission, per case ---------------------------
  const parsedCases = cases.map((c) => JSON.parse(JSON.stringify(c)) as Case);
  const best = new Array<number>(cases.length).fill(Infinity);
  t0 = performance.now();
  for (let round = 0; round < 5; round++)
    for (const [k, c] of parsedCases.entries()) {
      const t = process.hrtime.bigint();
      validateSpaceSubmission(c.space, c.problem, c.config, c.opts);
      const d = Number(process.hrtime.bigint() - t);
      if (d < best[k]) best[k] = d;
    }
  writeFileSync(join(outDir, "ts-times.json"), JSON.stringify(best));
  console.error(`timings in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

// ---- the index of the repository's data ------------------------------------------------------
const entryJson = (p: SpaceProblemEntry) => ({
  space: p.space,
  id: p.id,
  fields: p.fields,
  P: p.P,
  status: p.status,
  certified: p.certified,
  bound: p.bound,
  closed_reason: p.closed_reason,
  config: p.config,
  configApart: p.configApart ?? false,
  configAt: p.configAt ?? null,
  extra: p.extra ?? null,
});
const catalogueJson = (cat: SpaceCatalogue) => ({
  space: cat.space,
  generated: cat.generated,
  maxP: cat.maxP,
  skipped: cat.skipped,
  domain: cat.domain !== undefined,
  loader: cat.loadConfig !== undefined,
  count: cat.problems.length,
});
{
  const out: string[] = [JSON.stringify({ log: indexLog })];
  for (const space of SPACE_NAMES) {
    const cat = index[space];
    out.push(JSON.stringify({ catalogue: cat ? catalogueJson(cat) : null }));
    for (const p of cat?.problems ?? []) out.push(JSON.stringify(entryJson(p)));
  }
  writeFileSync(join(outDir, "index.ts.jsonl"), out.join("\n") + "\n");
  // the records listing as the server sends it (apps/server/src/spaces.ts), with a site entry on every third open problem
  for (const space of SPACE_NAMES) {
    const cat = index[space]!;
    const site = (p: SpaceProblemEntry, k: number) =>
      k % 3 === 0 ? { id: 1000 + k, score: (p.certified?.score ?? 2) * (k % 2 ? 0.999 : 1.001), name: `entry ${k}`, created_at: "2026-11-10T12:00:00.000Z" } : null;
    const listing = { space, generated_at: "2026-11-10T12:00:00.000Z", problems: cat.problems.map((p, k) => spaceProblemSummary(p, site(p, k))) };
    writeFileSync(join(outDir, `listing-${space}.ts.json`), JSON.stringify(listing));
  }
  // GET /api/spaces
  const loaded = SPACE_NAMES.filter((s) => index[s]);
  const answer = {
    spaces: loaded.map((s) => {
      const domain = index[s]!.domain;
      return {
        ...SPACE_INFO[s],
        problems: domain ? domain.info.problems : index[s]!.problems.length,
        records: index[s]!.problems.filter(hasRecord).length,
        ...(domain ? { domain: domain.info } : {}),
      };
    }),
    exhibits: loaded.length ? SPACE_EXHIBITS : [],
  };
  writeFileSync(join(outDir, "spaces.ts.json"), JSON.stringify(answer));
}

// ---- auxiliary cases -------------------------------------------------------------------------
const aux: Json[] = [];
const auxAdd = (kind: string, input: Json) => aux.push({ id: aux.length, kind, ...clone(input) });
/** A number as the files hold it: the non-finite ones as their names. */
const numOut = (x: number) => (Number.isFinite(x) ? x : String(x));

// ids: valid ones of every space, and each damaged in every way
const ID_DAMAGE: ((id: string) => Json)[] = [
  (id) => id + "/",
  (id) => "/" + id,
  (id) => id + "/1",
  (id) => id.replace(/\/\d+$/, ""),
  (id) => id.replace(/\/(\d+)$/, "/0$1"),
  (id) => id.replace(/\/(\d+)$/, "/+$1"),
  (id) => id.replace(/\/(\d+)$/, "/$1.0"),
  (id) => id.replace(/\/\d+$/, "/0"),
  (id) => id.replace(/\/\d+$/, "/10000"),
  (id) => id.replace(/\/\d+$/, "/9999"),
  (id) => id.replace(/\/\d+$/, "/-3"),
  (id) => id.replace(/\/\d+$/, "/1e2"),
  (id) => id.replace(/\/\d+$/, "/ 5"),
  (id) => id.replace(/\/\d+$/, "/5\n"),
  (id) => id.replace(/\/\d+$/, "/٥"),
  (id) => id.replace(/\/\d+$/, "/"),
  (id) => id.toUpperCase(),
  (id) => id.replace("/", "//"),
  (id) => id.replace(/^[a-z]+/, "space"),
  (id) => id.replace(/^[a-z]+\//, ""),
  (id) => id.split("/").slice(0, 2).join("/"),
  (id) => id.split("/").slice(0, 1).join("/"),
  (id) => {
    const parts = id.split("/");
    parts[1] = "nothing";
    return parts.join("/");
  },
  (id) => {
    const parts = id.split("/");
    parts[parts.length - 2] = "nothing";
    return parts.join("/");
  },
  (id) => {
    const parts = id.split("/");
    parts[parts.length - 2] = "2";
    return parts.join("/");
  },
  (id) => {
    const parts = id.split("/");
    parts[parts.length - 2] = "101";
    return parts.join("/");
  },
  (id) => {
    const parts = id.split("/");
    parts[parts.length - 2] = "003";
    return parts.join("/");
  },
  (id) => {
    const parts = id.split("/");
    [parts[1], parts[2]] = [parts[2], parts[1]];
    return parts.join("/");
  },
  (id) => id + "x".repeat(101 - id.length),
  (id) => id + "x".repeat(100 - id.length),
  (id) => id + "é".repeat(60),
  (id) => id + "😀".repeat(40),
  (id) => " " + id,
  (id) => id + " ",
];
for (const space of SPACE_NAMES) {
  const valid = [...domainIds(space, quick ? 6 : 60), ...reals[space].slice(0, quick ? 3 : 25).map((r) => r.problem)];
  for (const id of valid) auxAdd("id", { space, value: id });
  for (const id of some(valid, quick ? 2 : 8)) for (const damage of ID_DAMAGE) auxAdd("id", { space, value: damage(id) });
  for (const value of [null, 5, true, [], {}, ["surface/cube/fold/4/3"], "", "/", space, space + "/", `${space}//`, `${space}/1/2/3/4/5/6/7`]) auxAdd("id", { space, value });
  // every space's id read as every other space's
  for (const other of SPACE_NAMES) auxAdd("id", { space: other, value: valid[0] });
}
// the curved K in every written form, and the other spaces' names in every place
for (const k of ["1", "-1", "0", "-0", "1.0", "01", "+1", "1e-06", "1e-6", "0.000001", "1E-06", "1e-006", "1e-07", "1e-7", "0.0001", "1e-04", "0.00001", "1e-05", "1.225778283313099", "1.2257782833130990", "1.22577828331309901", "-6.519717439579256", ".5", "0.5", "5e-1", "1e16", "1e+16", "10000000000000000", "1e15", "1000000000000000", "1e+22", "1e22", "1e+400", "1e-400", "NaN", "Infinity", "-Infinity", "0x10", "1_000", "1e", "1e+", "--1", "1.", "1.5e+0", "2.5", "123456789012345680000", "1.2345678901234568e+20", "0.1", "1e-01", "100", "1e2", "1e+02", "-0.25", "-0.250", "3.14159", "1e-300", "1e+300", "4.9e-324", "5e-324", "1.7976931348623157e+308", "", " 1"])
  auxAdd("id", { space: "curved", value: `curved/${k}/3/4/7` });
for (const s of ["surface/cube/fold/1/3", "surface/cube/fold/2/3", "surface/cube/fold/100/3", "surface/cube/fold/101/3", "surface/cube/flat/4/3", "surface/Cube/fold/4/3", "surface/prism4/fold/4/3", "surface/prism3/fold/4/3", "surface/antiprism3/fold/4/3", "surface/triangular_hebesphenorotunda/nofold/100/100", "surface/cube/fold/4", "surface/cube/fold/4/3/1"]) auxAdd("id", { space: "surface", value: s });
for (const s of ["torus/tri/4/3", "torus/sq/4/3", "torus/hex/0/500", "torus/free/100/9999", "torus/free/2/1", "torus/sq/4"]) auxAdd("id", { space: "torus", value: s });
for (const s of ["sphere/0/1", "sphere/1/1", "sphere/100/100", "sphere/4/12/1", "sphere/4"]) auxAdd("id", { space: "sphere", value: s });
for (const s of ["boundary/tesseract/ball/9", "boundary/tesseract/sphere/9", "boundary/hypercube/ball/9", "boundary/tesseract/tetrahedron/3", "boundary/5cube/tetrahedron/3", "boundary/5simplex/cube/3", "boundary/11cube/ball/3", "boundary/4cube/ball/3", "boundary/tesseract/ball/09", "boundary/tesseract/ball", "boundary/tesseract/ball/9/1", "boundary/600cell/icosahedron/24", "boundary/10demicube/ball/24", "boundary/tesseract/cube/10000"]) auxAdd("id", { space: "boundary", value: s });
for (const s of ["polyhedra/cubintet/12", "polyhedra/cubincub/2", "polyhedra/j05inj92/500", "polyhedra/j00inj92/5", "polyhedra/j93incub/5", "polyhedra/cub/5", "polyhedra/cubin/5", "polyhedra/incub/5", "polyhedra/cubincubincub/5", "polyhedra/pr3l15incub/7", "polyhedra/CUBINTET/12", "polyhedra/cubintet/12/1", "polyhedra/cubintet", "polyhedra/tetinin/3", "polyhedra/" + "a".repeat(30) + "/3"]) auxAdd("id", { space: "polyhedra", value: s });
for (const s of ["balls/ballinball/13", "balls/ballinpkd/20", "balls/tetinball/2", "balls/tetincub/2", "balls/ballin/2", "balls/ball/2", "balls/BALLINBALL/2", "balls/ballinball/2/1", "balls/ballinball", "balls/ballinball/101", "balls/ballinball/1", "balls/pr3l15inball/5", "balls/ballinj92/5", "balls/9ball/5"]) auxAdd("id", { space: "balls", value: s });
for (const s of ["ndim/4/cube/ortho/12", "ndim/8/421/ball/5", "ndim/3/cube/cube/5", "ndim/11/cube/cube/5", "ndim/4/demi/cube/5", "ndim/5/demi/cube/5", "ndim/5/24cell/cube/5", "ndim/6/221/122/24", "ndim/7/321/ball/20", "ndim/4/ball/ball/41", "ndim/4/ball/ball/1", "ndim/04/cube/cube/5", "ndim/4/cube/cube", "ndim/4/cube/cube/5/1", "ndim/4/Cube/cube/5"]) auxAdd("id", { space: "ndim", value: s });
// formatSpaceId on fields that name no id, and formatCurvature on its own
for (const [space, fields] of [
  ["surface", { solid: "cube", mode: "fold", N: 4, P: 3 }],
  ["surface", { solid: "cube" }],
  ["curved", { K: -1, N: 3, M: 4, P: 7 }],
  ["curved", { K: "1e-06", N: 3, M: 4, P: 7 }],
  ["curved", { K: 1e-6, N: 3, M: 4, P: 7 }],
  ["curved", { N: 3, M: 4, P: 7 }],
  ["curved", { K: "x", N: 3, M: 4, P: 7 }],
  ["sphere", { N: 0, P: 2.5 }],
  ["torus", { family: "free", N: 1e21, P: 1e-7 }],
  ["boundary", { polytope: "x", piece: "y", P: 0 }],
  ["polyhedra", { code: "cubintet", P: 12 }],
  ["balls", { code: "ballinball", P: 13 }],
  ["ndim", { d: 4, piece: "cube", container: "ortho", P: 12 }],
  ["ndim", {}],
] as [SpaceName, Json][])
  auxAdd("format", { space, fields });
for (const K of [0, -0, 1, -1, 0.5, 1e-6, -1e-6, 1e-4, 9.999e-5, 1e-5, 1e15, 1e16, 9007199254740993, 1.5e16, 1e21, 1e22, 1.225778283313099, -6.519717439579256, 123456.789, 1e-300, 5e-324, 1.7976931348623157e308, 0.1 + 0.2, 1 / 3, 2 ** 53, 2 ** 53 + 2, 1e100, "NaN", "Infinity", "-Infinity"])
  auxAdd("curvature", { K });

// domains: info, bound of ids inside and outside, sample, the curved menu and its impossible ids
for (const space of SPACE_NAMES) {
  auxAdd("domain-info", { space });
  for (const limit of [0, 1, 7, 50, quick ? 60 : 2500]) auxAdd("domain-sample", { space, limit });
  const inside = [...domainIds(space, quick ? 10 : 150)];
  for (const id of inside) auxAdd("domain-bound", { space, value: id });
  for (const id of some(inside, quick ? 3 : 25))
    for (const P of [1, 2, 24, 25, 100, 101, 160, 161, 384, 400, 401, 500, 501, 9999]) auxAdd("domain-bound", { space, value: id.replace(/\/\d+$/, `/${P}`) });
}
for (const K of CURVED_KS)
  for (const [N, M] of [[0, 0], [3, 0], [0, 3], [3, 3], [4, 4], [6, 3], [5, 7], [12, 100], [100, 0], [100, 100], [50, 3], [7, 20]]) {
    const K_id = formatCurvature(K);
    auxAdd("curved-menu", { key: "M", chosen: { K: K_id, N: String(N) } });
    auxAdd("curved-menu", { key: "P", chosen: { K: K_id, N: String(N), M: String(M) } });
    for (const P of [1, 2, 3, 5, 20, 100, 500]) auxAdd("domain-bound", { space: "curved", value: `curved/${K_id}/${N}/${M}/${P}`, impossible: true });
  }
auxAdd("curved-menu", { key: "N", chosen: { K: "1" } });
auxAdd("curved-menu", { key: "P", chosen: {} });
// curvatures outside the list
for (const k of ["2", "-2", "0", "0.3", "1e-07"]) auxAdd("domain-bound", { space: "curved", value: `curved/${k}/3/4/5`, impossible: true });

// catalogues of damaged record files
function recordsOf(space: SpaceName, n: number): Json[] {
  const file = JSON.parse(readFileSync(join(root, "data", space, "records.json"), "utf8"));
  return some(file.records, n);
}
const DAMAGE: [string, (r: Json, space: SpaceName) => Json][] = [
  ["as-it-is", (r) => r],
  ["not-an-object", () => 5],
  ["null", () => null],
  ["an-array", (r) => [r]],
  ["no-id", (r) => ({ ...r, id: undefined, problem: undefined })],
  ["id-a-number", (r) => ({ ...r, id: 7, problem: 7 })],
  ["id-null", (r) => ({ ...r, id: null, problem: null })],
  ["id-malformed", (r) => ({ ...r, id: (r.id ?? r.problem) + "/x", problem: r.problem === undefined ? undefined : r.problem + "/x" })],
  ["P-differs", (r) => ({ ...r, P: r.P + 1 })],
  ["P-a-string", (r) => ({ ...r, P: String(r.P) })],
  ["P-missing", (r) => ({ ...r, P: undefined })],
  ["N-differs", (r) => ({ ...r, N: r.N === undefined ? 5 : r.N + 1 })],
  ["piece-differs", (r) => ({ ...r, piece: "cube7", solid: "cube7", family: "x", K: 9, d: 99 })],
  ["status-unknown", (r) => ({ ...r, status: "optimal" })],
  ["status-missing", (r) => ({ ...r, status: undefined })],
  ["status-an-object", (r) => ({ ...r, status: { a: [1, null, [2, 3]] } })],
  ["status-an-array", (r) => ({ ...r, status: [1, null, "x", [2, [3]], true, {}] })],
  ["no-score", (r) => ({ ...r, score_cert: undefined })],
  ["score-a-string", (r) => ({ ...r, score_cert: "1.5" })],
  ["no-display", (r) => ({ ...r, display: undefined })],
  ["display-a-number", (r) => ({ ...r, display: 1.5 })],
  ["no-config", (r) => ({ ...r, config: undefined, configuration: undefined, pieces: undefined, config_at: undefined })],
  ["config-null", (r) => ({ ...r, config: null, configuration: null, pieces: null })],
  ["config-short", (r) => {
    const c = clone(r);
    for (const holder of [c, c.config, c.configuration]) for (const key of ["pieces", "poses"]) if (Array.isArray(holder?.[key])) holder[key].pop();
    return c;
  }],
  ["config-damaged", (r) => {
    const c = clone(r);
    for (const holder of [c, c.config, c.configuration]) for (const key of ["pieces", "poses"]) if (Array.isArray(holder?.[key])) holder[key] = holder[key].map(() => "x");
    for (const holder of [c, c.config, c.configuration]) for (const key of ["s", "size", "rho"]) if (holder && key in holder) holder[key] = -1;
    return c;
  }],
  ["config-at-short", (r) => ({ ...r, config: undefined, config_at: [5] })],
  ["config-at-negative", (r) => ({ ...r, config: undefined, config_at: [-1, 10] })],
  ["config-at-zero-length", (r) => ({ ...r, config: undefined, config_at: [0, 0] })],
  ["config-at-too-long", (r) => ({ ...r, config: undefined, config_at: [0, 1000001] })],
  ["config-at-longest", (r) => ({ ...r, config: undefined, config_at: [0, 1000000] })],
  ["config-at-fraction", (r) => ({ ...r, config: undefined, config_at: [0.5, 10] })],
  ["config-at-unsafe", (r) => ({ ...r, config: undefined, config_at: [2 ** 53, 10] })],
  ["config-at-strings", (r) => ({ ...r, config: undefined, config_at: ["0", "10"] })],
  ["config-at-good", (r) => ({ ...r, config: undefined, config_at: [12, 345] })],
  ["infeasible", (r) => ({ ...r, status: "infeasible", score_cert: undefined, display: undefined, config: undefined })],
  ["infeasible-with-proof", (r) => ({ ...r, status: "infeasible", proof: "area: the pieces cover more than the container" })],
  ["proven", (r) => ({ ...r, status: "proven", literature: undefined })],
  ["proven-with-proofs", (r) => ({ ...r, status: "proven", literature: { proof: ["Smith 1901", 5, "Jones 2020"], source: "a book" } })],
  ["proven-with-source", (r) => ({ ...r, status: "proven", literature: { proof: [], source: "a book" } })],
  ["proven-with-empty-source", (r) => ({ ...r, status: "proven", literature: { proof: "not a list", source: "" } })],
  ["proven-with-list", (r) => ({ ...r, status: "proven", literature: [5, { short: "no proof here" }, { proof: "p", short: "Dickinson et al. 2011", doi: "10.1/x" }, { proof: "q", short: "second" }] })],
  ["proven-with-list-no-doi", (r) => ({ ...r, status: "proven", literature: [{ proof: "p", short: "Musin and Tarasov 2015", doi: 5 }] })],
  ["proven-with-list-unusable", (r) => ({ ...r, status: "proven", literature: [{ proof: 5, short: "x" }, null] })],
  ["bound-missing", (r) => ({ ...r, bound: undefined })],
  ["bound-null", (r) => ({ ...r, bound: null })],
  ["bound-a-number", (r) => ({ ...r, bound: 1.5 })],
  ["bound-value", (r) => ({ ...r, bound: { value: 0.5 } })],
  ["bound-lower", (r) => ({ ...r, bound: { lower: 0.25 } })],
  ["bound-both", (r) => ({ ...r, bound: { value: 0.5, lower: 0.25, label: "[CALC] a label", kind: "area" } })],
  ["bound-value-a-string", (r) => ({ ...r, bound: { value: "0.5", lower: 0.25, kind: "one-piece" } })],
  ["bound-kind-words", (r) => ({ ...r, bound: { value: 0.5, kind: "two_piece-bound of some kind", label: "[EST]" } })],
  ["bound-kind-one-piece", (r) => ({ ...r, bound: { value: 0.5, kind: "one_piece" } })],
  ["bound-kind-piece", (r) => ({ ...r, bound: { value: 0.5, kind: " piece", label: "" } })],
  ["bound-kind-upper", (r) => ({ ...r, bound: { value: 0.5, kind: "Area", label: "x" } })],
  ["bound-kind-a-number", (r) => ({ ...r, bound: { value: 0.5, kind: 5, label: 7 } })],
  ["bound-label-only", (r) => ({ ...r, bound: { value: 0.5, label: "only a label" } })],
  ["bound-nothing", (r) => ({ ...r, bound: {} })],
  ["nofold-good", (r) => ({ ...r, nofold: { value: 1.25, source: "[CALC] a source" }, fold_gain: 0.2 })],
  ["nofold-no-source", (r) => ({ ...r, nofold: { value: 1.25, source: 5 }, fold_gain: "0.2" })],
  ["nofold-negative", (r) => ({ ...r, nofold: { value: -1 }, fold_gain: null })],
  ["nofold-missing", (r) => ({ ...r, nofold: undefined, fold_gain: undefined })],
  ["nofold-an-array", (r) => ({ ...r, nofold: [1.25], fold_gain: 0 })],
  ["outside-the-domain", (r, space) => {
    const id: string = r.id ?? r.problem;
    const P = space === "curved" ? 501 : space === "torus" ? 501 : space === "polyhedra" ? 501 : space === "boundary" ? 401 : 101;
    const moved = id.replace(/\/\d+$/, `/${P}`);
    return { ...r, id: moved, problem: r.problem === undefined ? undefined : moved, P };
  }],
];
for (const space of SPACE_NAMES) {
  if (space === "balls") {
    // no records file: a catalogue of the domain alone, and of nothing
    auxAdd("catalogue", { space, file: null, domain: true });
    auxAdd("catalogue", { space, file: null, domain: false });
    auxAdd("catalogue", { space, file: { generated: "2026-01-01", records: [{ id: "balls/ballinball/5", code: "ballinball", piece: "ball", container: "ball", P: 5, status: "best_known", score_cert: 3, display: "3.000000", config: { s: 3, pieces: [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] }, bound: { value: 2, kind: "two-piece", label: "[EST]" } }, { id: "balls/ballinball/6", code: "ballinball", piece: "ball", container: "ball", P: 6, status: "best_known", score_cert: 3, display: "3.000000", config_at: [0, 99] }] }, domain: true });
    continue;
  }
  // a small file: the smallest record, damaged in the ways that give each reason once (also a fixture of cargo test)
  {
    const all: Json[] = JSON.parse(readFileSync(join(root, "data", space, "records.json"), "utf8")).records;
    const small = all.filter((r) => r.status === "best_known").reduce((a, b) => (JSON.stringify(b.config ?? b.configuration ?? b.pieces ?? null).length < JSON.stringify(a.config ?? a.configuration ?? a.pieces ?? null).length ? b : a));
    // only what the catalogue reads of a record
    const lean: Json = {};
    for (const k of ["id", "problem", "solid", "mode", "K", "N", "M", "P", "family", "polytope", "piece", "container", "code", "d", "status", "score_cert", "display", "s", "pieces", "config", "configuration", "config_at", "bound", "nofold", "fold_gain", "literature", "proof"]) if (small[k] !== undefined) lean[k] = small[k];
    const wanted = ["as-it-is", "as-it-is", "not-an-object", "id-a-number", "id-malformed", "P-differs", "piece-differs", "status-unknown", "status-an-array", "no-score", "display-a-number", "no-config", "config-short", "config-damaged", "config-at-short", "config-at-good", "infeasible-with-proof", "proven", "proven-with-proofs", "proven-with-list", "proven-with-list-no-doi", "bound-missing", "bound-both", "bound-lower", "bound-kind-words", "bound-kind-one-piece", "bound-label-only", "nofold-good", "nofold-no-source", "outside-the-domain"];
    const records = wanted.map((name) => DAMAGE.find(([n]) => n === name)![1](clone(lean), space));
    auxAdd("catalogue", { space, name: "small", file: { generated: "2026-11-10", records }, domain: true });
    auxAdd("catalogue", { space, name: "small", file: { records: records.slice(0, 12) }, domain: false });
  }
  const records = recordsOf(space, quick ? 2 : 6);
  // every kind of damage on one or two records
  const plain = DAMAGE.flatMap(([name, damage]) => some(records, quick ? 1 : 2).map((r) => damage(clone(r), space)));
  for (const domain of [true, false]) {
    auxAdd("catalogue", { space, file: { generated: "2026-11-10", records: plain }, domain });
    // the same records twice (listed twice), in the other order
    auxAdd("catalogue", { space, file: { generated: 5, records: [...records, ...[...records].reverse()] }, domain });
  }
  auxAdd("catalogue", { space, file: { records: "none" }, domain: true });
  auxAdd("catalogue", { space, file: [], domain: true });
  auxAdd("catalogue", { space, file: "text", domain: false });
  auxAdd("catalogue", { space, file: null, domain: true });
  auxAdd("catalogue", { space, file: null, domain: false });
  auxAdd("catalogue", { space, file: { generated: "g", records: [] }, domain: true });
}

// problemOf and the summary, on ids with and without a record, with and without a site entry
for (const space of SPACE_NAMES) {
  const ids = [...domainIds(space, quick ? 4 : 30), ...index[space]!.problems.filter((p) => !acceptsSubmissions(p)).slice(0, 6).map((p) => p.id)];
  for (const [k, id] of ids.entries())
    auxAdd("problem", { space, value: id, site: k % 2 ? { id: 7 + k, score: 1.5 + k / 7, name: "a \"name\" ✓", created_at: "2026-11-10T12:00:00.000Z" } : null });
  for (const P of [501, 9999]) auxAdd("problem", { space, value: ids[0].replace(/\/\d+$/, `/${P}`), site: null });
}

// storedSpaceConfig on free tori: reduced, skewed, left-handed
{
  const free = reals.torus.filter((r) => r.problem.startsWith("torus/free/") && r.P <= 60);
  const SKEW: [string, (b1: number[], b2: number[]) => [number[], number[]]][] = [
    ["as-sent", (b1, b2) => [b1, b2]],
    ["swapped", (b1, b2) => [b2, b1]],
    ["b2-negated", (b1, b2) => [b1, [-b2[0], -b2[1]]]],
    ["b1-negated", (b1, b2) => [[-b1[0], -b1[1]], b2]],
    ["both-negated", (b1, b2) => [[-b1[0], -b1[1]], [-b2[0], -b2[1]]]],
    ["b2+b1", (b1, b2) => [b1, [b2[0] + b1[0], b2[1] + b1[1]]]],
    ["b2-b1", (b1, b2) => [b1, [b2[0] - b1[0], b2[1] - b1[1]]]],
    ["b2+3b1", (b1, b2) => [b1, [b2[0] + 3 * b1[0], b2[1] + 3 * b1[1]]]],
    ["b1+2b2", (b1, b2) => [[b1[0] + 2 * b2[0], b1[1] + 2 * b2[1]], b2]],
    ["b2-7b1-swapped", (b1, b2) => [[b2[0] - 7 * b1[0], b2[1] - 7 * b1[1]], b1]],
    ["b2+40b1", (b1, b2) => [b1, [b2[0] + 40 * b1[0], b2[1] + 40 * b1[1]]]],
    ["b2+4000b1", (b1, b2) => [b1, [b2[0] + 4000 * b1[0], b2[1] + 4000 * b1[1]]]],
    ["unimodular", (b1, b2) => [[2 * b1[0] + 3 * b2[0], 2 * b1[1] + 3 * b2[1]], [b1[0] + 2 * b2[0], b1[1] + 2 * b2[1]]]],
  ];
  for (const r of some(free, quick ? 3 : 45)) {
    const c = r.config;
    for (const [name, skew] of SKEW) {
      const [b1, b2] = skew(c.lattice.b1, c.lattice.b2);
      const config = { lattice: { b1, b2 }, poses: c.poses };
      const opts = serverOpts("torus", r.problem);
      auxAdd("stored", { name, space: "torus", problem: r.problem, config, opts, sentScore: null });
      auxAdd("stored", { name: name + "/sent", space: "torus", problem: r.problem, config, opts, sentScore: sizeOf("torus", config) });
    }
  }
  // not a free torus, and not a torus: stored as they are
  for (const space of SPACE_NAMES) {
    const r = reals[space].find((x) => !x.problem.startsWith("torus/free/"))!;
    auxAdd("stored", { name: "other", space, problem: r.problem, config: r.config, opts: serverOpts(space, r.problem), sentScore: null });
  }
  const sq = reals.torus.find((r) => r.problem.startsWith("torus/sq/"))!;
  auxAdd("stored", { name: "sq", space: "torus", problem: sq.problem, config: sq.config, opts: serverOpts("torus", sq.problem), sentScore: null });
}

// the comparison rules around their margins
for (const space of SPACE_NAMES)
  for (const best of [1, 2.5, 1e-3, 1234.5678])
    for (const rel of [0, 1e-12, 0.5e-9, 0.999999e-9, 1e-9, 1.000001e-9, 2e-9, 0.5e-6, 0.999999e-6, 1e-6, 1.000001e-6, 2e-6, -1e-9, 1e-3])
      auxAdd("beats", { space, score: best * (1 - rel), certified: best, leader: best * (1 + (rel > 1e-7 ? 0 : 1e-8)) });
for (const space of SPACE_NAMES) {
  auxAdd("beats", { space, score: 1, certified: null, leader: null });
  auxAdd("beats", { space, score: 1, certified: 2, leader: null });
  auxAdd("beats", { space, score: 1, certified: null, leader: 0.5 });
}

// the estimates the server queues by
for (const space of ["boundary", "ndim"] as SpaceName[])
  for (const id of [...domainIds(space, quick ? 6 : 120), ...reals[space].map((r) => r.problem)]) auxAdd("heavy", { space, value: id });

auxAdd("constants", {});

// the on-demand loader: the repository's configurations kept apart, and a folder of damaged ones
const loaderRoot = resolve(outDir, "loader-root");
{
  rmSync(loaderRoot, { recursive: true, force: true });
  const dir = join(loaderRoot, "data", "polyhedra", "configs");
  mkdirSync(dir, { recursive: true });
  const cat = index.polyhedra!;
  const code = "cubintet";
  const taken = cat.problems.filter((p) => p.fields.code === code).slice(0, 12);
  let text = "";
  const records: Json[] = [];
  const line = (p: SpaceProblemEntry, k: number): string => {
    const good = `{"P":${p.P},"config":${readEntryConfigSync(root, cat, p)}}\n`;
    if (k === 3) return good.replace('{"P"', '{"Q"');
    if (k === 4) return good.replace(/"s":[0-9.e+-]+/, '"s":1.5');
    if (k === 5) return "not json at all\n";
    if (k === 6) return good.replace(/"pieces":\[\[/, '"pieces":[["x",');
    if (k === 7) return `[${p.P}]\n`;
    if (k === 8) return good.replace(`{"P":${p.P}`, `{"P":"${p.P}"`);
    if (k === 9) return `{"P":${p.P},"config":null}\n`;
    return good;
  };
  for (const [k, p] of taken.entries()) {
    const l = line(p, k);
    const at = Buffer.byteLength(text);
    // k = 10: a place beyond the end of the file; k = 11: a length that cuts the line short
    const place = k === 10 ? [1e7, 50] : k === 11 ? [at, Buffer.byteLength(l) - 9] : [at, Buffer.byteLength(l)];
    records.push({ id: p.id, code, piece: p.fields.piece, container: p.fields.container, P: p.P, status: "best_known", score_cert: p.certified!.score, display: p.certified!.display, config_at: place });
    text += l;
  }
  writeFileSync(join(dir, `${code}.jsonl`), text);
  // a problem whose file is missing
  const other = cat.problems.find((p) => p.fields.code === "cubincub")!;
  records.push({ id: other.id, code: "cubincub", piece: other.fields.piece, container: other.fields.container, P: other.P, status: "best_known", score_cert: other.certified!.score, display: other.certified!.display, config_at: [0, 100] });
  writeFileSync(join(loaderRoot, "data", "polyhedra", "records.json"), JSON.stringify({ generated: "2026-11-10", records }));
  const ids = records.map((r) => r.id);
  // each twice (the second from the cache, or logged once), a small cache, then the first again
  auxAdd("loader", { root: loaderRoot, space: "polyhedra", limitBytes: 2500, atOnce: 2, steps: [...ids, ...ids, ids[0], ids[1], ids[0]].map((id) => [id]) });
  auxAdd("loader", { root: loaderRoot, space: "polyhedra", limitBytes: 1, atOnce: 1, steps: [[ids[0]], [ids[1]], [ids[0]], [ids[2]]] });
  // simultaneous loads: of different entries (at most atOnce at once), and of the same one (one read)
  auxAdd("loader", { root: loaderRoot, space: "polyhedra", limitBytes: 4000000, atOnce: 2, steps: [ids, [ids[0], ids[0], ids[0], ids[5], ids[5]], [ids[12], ids[12]]] });
  // the repository's own: polyhedra and ndim, a cache that holds a few
  for (const space of ["polyhedra", "ndim"] as SpaceName[]) {
    const all = index[space]!.problems.filter((p) => p.configApart);
    const chosen = some(all, quick ? 6 : 60).map((p) => p.id);
    auxAdd("loader", { root, space, limitBytes: 60000, atOnce: 4, steps: [...chosen.map((id) => [id]), ...chosen.slice(0, 5).map((id) => [id]), chosen.slice(0, 10)] });
  }
  // a records file that is not one, and none at all
  const broken = resolve(outDir, "broken-root");
  rmSync(broken, { recursive: true, force: true });
  mkdirSync(join(broken, "data", "sphere"), { recursive: true });
  mkdirSync(join(broken, "data", "torus"), { recursive: true });
  mkdirSync(join(broken, "data", "curved", "records.json"), { recursive: true });
  writeFileSync(join(broken, "data", "sphere", "records.json"), '{"generated": "x", "records": [');
  writeFileSync(join(broken, "data", "torus", "records.json"), '﻿{"generated": "x", "records": []}');
  mkdirSync(join(broken, "data", "surface"), { recursive: true });
  writeFileSync(join(broken, "data", "surface", "records.json"), '{"generated": "2026", "records": [5, {"id": "surface/cube/fold/4/1"}]}');
  auxAdd("index", { root: broken });
  auxAdd("index", { root: loaderRoot });
}

// ---- the auxiliary run -----------------------------------------------------------------------
const boundJson = (b: Json) => (b === undefined ? "outside" : b);
async function auxResult(c: Json): Promise<Json> {
  switch (c.kind) {
    case "id": {
      const parsed = parseSpaceId(c.space, c.value);
      const of = typeof c.value === "string" ? spaceOfId(c.value) : null;
      if (typeof parsed === "string") return { error: parsed, spaceOf: of, isSpace: isSpaceName(c.value) };
      return { id: parsed.id, space: parsed.space, fields: parsed.fields, P: parsed.P, formatted: formatSpaceId(c.space, parsed.fields), spaceOf: of };
    }
    case "format":
      try {
        return { text: formatSpaceId(c.space, c.fields) };
      } catch (e) {
        return { thrown: (e as Error).message };
      }
    case "curvature":
      try {
        return { text: formatCurvature(Number(c.K)) };
      } catch (e) {
        return { thrown: (e as Error).message };
      }
    case "domain-info":
      return { text: JSON.stringify(SPACE_DOMAINS[c.space as SpaceName]!.info), maxP: domainMaxP(SPACE_DOMAINS[c.space as SpaceName]!) };
    case "domain-sample":
      return { ids: SPACE_DOMAINS[c.space as SpaceName]!.sample(c.limit) };
    case "domain-bound": {
      const parsed = parseSpaceId(c.space, c.value);
      if (typeof parsed === "string") return { error: parsed };
      const out: Json = { bound: boundJson(SPACE_DOMAINS[c.space as SpaceName]!.bound(parsed)) };
      if (c.impossible) out.impossible = impossibleReason(c.space, parsed);
      return out;
    }
    case "curved-menu": {
      const m = SPACE_DOMAINS.curved!.menu!(c.key, c.chosen);
      return m === undefined ? { menu: "none" } : { values: m.values ?? null, range: m.range?.map(numOut) ?? null };
    }
    case "catalogue": {
      const cat = buildSpaceCatalogue(c.space, c.file, c.domain ? SPACE_DOMAINS[c.space as SpaceName] : undefined);
      return { ...catalogueJson(cat), problems: cat.problems.map(entryJson), byId: [...cat.byId.keys()].sort() };
    }
    case "problem": {
      const parsed = parseSpaceId(c.space, c.value);
      if (typeof parsed === "string") return { error: parsed };
      const cat = index[c.space as SpaceName]!;
      const p = problemOf(cat, parsed);
      if (!p) return { problem: null };
      return {
        problem: entryJson(p),
        accepts: acceptsSubmissions(p),
        hasRecord: hasRecord(p),
        summary: JSON.stringify(spaceProblemSummary(p, c.site)),
        head: JSON.stringify({ ...spaceProblemSummary(p, c.site), conventions: SPACE_INFO[c.space as SpaceName].conventions }),
        location: p.configApart ? configLocation(p) : null,
        config: await entryConfig(cat, p),
      };
    }
    case "stored": {
      const sent = c.sentScore === null ? undefined : c.sentScore;
      // the configuration as a verdict holds it: parsed
      const id = parseSpaceId(c.space, c.problem);
      if (typeof id === "string") throw new Error(id);
      const parsed = parseSpaceConfig(id, c.config);
      if (!parsed.ok) throw new Error(`${c.problem}: ${parsed.errors.join("; ")}`);
      const sync = storedSpaceConfig(c.space, c.problem, parsed.config, c.opts, sent);
      const later = await storedSpaceConfigAsync(c.space, c.problem, parsed.config, c.opts, sent);
      return { sync: JSON.stringify(sync), async: JSON.stringify(later.config) };
    }
    case "beats":
      return {
        score: beatsSpaceScore(c.score, c.leader),
        record: beatsSpaceRecord(c.space, c.score, c.certified),
        improves: improvesSpaceBest(c.space, c.score, c.certified, c.leader),
      };
    case "heavy": {
      const parsed = parseSpaceId(c.space, c.value);
      if (typeof parsed === "string") return { error: parsed };
      const f = parsed.fields as Record<string, Json>;
      if (c.space === "boundary") {
        const problem = { polytope: f.polytope, piece: f.piece, P: parsed.P };
        return { ms: numOut(boundaryCheckMs(problem)), heavy: boundaryIsHeavy(problem) };
      }
      const problem = { d: f.d, piece: f.piece, container: f.container, P: parsed.P };
      return { ops: ndCheckOps(problem), heavy: ndIsHeavy(problem) };
    }
    case "constants":
      return {
        SPACE_NAMES,
        PIECE_NS,
        CURVED_KS,
        CURVED_MENU_KS,
        CURVED_MENU_K_IDS,
        CURVED_MS,
        CURVED_TILING_KS,
        countCurvedProblems: countCurvedProblems(),
        SPACE_MAX_P: SPACE_NAMES.map((s) => SPACE_MAX_P[s]),
        SPACE_RECORD_MARGIN: SPACE_NAMES.map((s) => SPACE_RECORD_MARGIN[s]),
        SPACE_MAX_SIZE,
        SPACE_BOUND_SLACK,
        SPACE_STRICT_REASON,
        SPACE_STRICT_NO_RECORD_REASON,
        SPACE_TOL,
        SPACE_STRICT_TOL,
        SPACE_MAX_COORD,
        SPACE_MIN_QUATERNION_NORM,
        SURFACE_MAX_CHAINS,
        TORUS_MAX_TRANSLATES,
        BOUNDARY_MAX_CHAINS,
        BOUNDARY_MAX_S,
        POLYHEDRA_MAX_QUATERNION,
        info: JSON.stringify(SPACE_NAMES.map((s) => SPACE_INFO[s])),
        exhibits: JSON.stringify(SPACE_EXHIBITS),
      };
    case "loader": {
      const log: string[] = [];
      const file = JSON.parse(readFileSync(join(c.root, "data", c.space, "records.json"), "utf8"));
      const cat = buildSpaceCatalogue(c.space, file, SPACE_DOMAINS[c.space as SpaceName]);
      const loader = configLoader(c.root, cat, (m) => log.push(m), c.limitBytes, c.atOnce);
      const steps: Json[] = [];
      for (const step of c.steps as string[][]) {
        const served = await Promise.all(step.map((id) => loader.load(cat.byId.get(id)!)));
        steps.push({ served, cached: loader.cached(), stats: loader.stats() });
      }
      return { skipped: cat.skipped, steps, log: log.map((m) => m.replaceAll(c.root, "<root>")) };
    }
    case "index": {
      const log: string[] = [];
      const ix = loadSpacesIndex(c.root, (m) => log.push(m));
      return {
        log: log.map((m) => m.replaceAll(c.root, "<root>")),
        catalogues: SPACE_NAMES.map((s) => (ix[s] ? { ...catalogueJson(ix[s]!), ids: ix[s]!.problems.map((p) => p.id) } : null)),
      };
    }
  }
  throw new Error(`no such kind ${c.kind}`);
}
const auxRefs: Json[] = [];
for (const c of aux) {
  // the case as the Rust side reads it
  const run = JSON.parse(JSON.stringify(c));
  auxRefs.push({ id: c.id, result: await auxResult(run) });
}
writeFileSync(join(outDir, "aux-cases.jsonl"), aux.map((c) => JSON.stringify(c)).join("\n") + "\n");
writeFileSync(join(outDir, "aux-ref.jsonl"), auxRefs.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.error(`${aux.length} auxiliary cases`);

// ---- fixtures for cargo test ----------------------------------------------------------------
if (fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true });
  // Small cases of every space and every kind of case, with the TypeScript's answers. Of each group of kinds a
  // space gets a few, taken in turn from the group's kinds, so that the spaces together hold every kind.
  const GROUPS: [RegExp, number][] = [
    [/^entry$/, 2],
    [/^record$/, 1],
    [/^record-strict$/, 1],
    [/^shrink-/, 3],
    [/^(below-bound|unbounded|grow)/, 2],
    [/^(overlap|outside)/, 2],
    [/^(one-fewer|one-more|maxP-below|no-options)$/, 2],
    [/^random-/, 2],
    [/^(infeasible|work-limit)/, 2],
    [/^(bad|missing):/, 6],
    [/^(lattice|q)=/, 3],
    [/^(many-errors|size-wrong|no-list|extra-fields)/, 2],
    [/^id-/, 2],
  ];
  const chosen: Json[] = [];
  for (const space of SPACE_NAMES) {
    for (const [pattern, count] of GROUPS) {
      const group = cases.filter((c) => c.space === space && pattern.test(c.kind) && JSON.stringify(c.config ?? null).length <= 520);
      const kinds = [...new Set(group.map((c) => c.kind))];
      // start at another kind for each space
      const start = SPACE_NAMES.indexOf(space) * 3;
      for (let k = 0; k < Math.min(count, kinds.length); k++) {
        const kind = kinds[(start + k * Math.max(1, Math.floor(kinds.length / count))) % kinds.length];
        const c = group.find((x) => x.kind === kind && !chosen.some((y) => y.case.id === x.id));
        if (c) chosen.push({ case: c, ref: refs[c.id] });
      }
    }
  }
  writeFileSync(join(fixturesDir, "validate.jsonl"), chosen.map((c) => JSON.stringify(c)).join("\n") + "\n");
  const auxChosen: Json[] = [];
  const auxSeen = new Map<string, number>();
  const CAP: Record<string, number> = { id: 18, "domain-bound": 6, beats: 5, stored: 14, curvature: 40, format: 14, problem: 1, "curved-menu": 8, heavy: 6, "domain-sample": 3, catalogue: 2 };
  for (const c of aux) {
    // the loader and the index read folders the tool makes; cargo test has scenarios of its own for them
    if (c.kind === "loader" || c.kind === "index") continue;
    // of the catalogues: the small damaged file of each space with its domain, and the file that is missing
    if (c.kind === "catalogue" && !(c.name === "small" && c.domain) && !(c.file === null && c.domain)) continue;
    if (c.kind === "domain-sample" && c.limit > 50) continue;
    const text = JSON.stringify(c);
    const result = auxRefs[c.id].result;
    if (text.length > 30000 || JSON.stringify(result).length > (c.kind === "constants" ? 40000 : 16000)) continue;
    if (c.kind === "stored" && text.length > 1200) continue;
    const key = `${c.kind}/${c.kind === "stored" ? "" : (c.space ?? "")}`;
    const n = auxSeen.get(key) ?? 0;
    if (n >= (CAP[c.kind] ?? 3)) continue;
    // of the long lists, one in a few, so that the ones taken are spread
    if (["id", "domain-bound", "beats", "curved-menu", "heavy"].includes(c.kind) && c.id % 11) continue;
    auxSeen.set(key, n + 1);
    auxChosen.push({ case: c, result });
  }
  writeFileSync(join(fixturesDir, "aux.jsonl"), auxChosen.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.error(`fixtures: ${chosen.length} checks and ${auxChosen.length} auxiliary cases in ${fixturesDir}`);
}
