// Cases for the comparison of the Rust port of packages/curved (native/curved) with its TypeScript
// source, and the TypeScript's verdicts, numbers and timings for them (native/PORTING.md).
//
//   node --import tsx native/tools/curved-ref.mts OUTDIR [--snapshot space-curved.json.gz] [--fixtures native/curved/tests/fixtures]
//   cargo run --release -p polypack-curved --example curveddiff -- OUTDIR
//   node native/tools/curved-compare.mjs OUTDIR
//
// It writes into OUTDIR:
//   cases.jsonl      one configuration per line {id, kind, K, N, M, P, size, pieces: [[x, y, theta]]}
//   ref.jsonl        for each: validate() at (tol 1e-9, maxErrors 20), (1e-11, 20) and with the default
//                    options, and the reasons of the server's check (packages/spaces/src/validate.ts,
//                    check(), the curved branch) at both tolerances
//   ts-times.json    best of five of validate() as the server calls it, nanoseconds per case
//   bound-ref.jsonl  curvedMaxP, pieceExists, curvedBoundOf, curvedWhyNot and containerCircumradius over
//                    the whole domain (22 curvatures x 99 pieces x 99 containers) and outside it
// and with --fixtures the files of native/curved/tests/fixtures for `cargo test`: validate.jsonl (small cases of
// every kind with their verdicts), bound.jsonl (a sample of the bound lines) and domain.json (the domain's
// curvatures, pieces and containers and its number of problems).
//
// Cases: the research records (data/curved/records.json: `config` and `config_touching`), the
// published sweep (data/curved/sweep/records.json, 230 curvatures), the site's leading entries (the
// nightly snapshot), lattice packings in their tightest container for every curvature of the
// domain, pieces and containers of both kinds and P up to 500, mutants of all of these around the
// tolerances, inputs the validator refuses, and random configurations.
//
// A number that JSON cannot write (NaN, an infinity, -0) is written as a string ("NaN", "Infinity",
// "-Infinity", "-0"), in the cases and in the results; every result number is written as String(x),
// so that two results have the same text exactly when they are the same doubles.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { validate, type ValidationResult } from "../../packages/curved/src/validate.ts";
import { CURVED_MAX_P, curvedBoundOf, curvedMaxP, curvedWhyNot, pieceExists } from "../../packages/curved/src/bound.ts";
import { containerCircumradius, maxContainerSize } from "../../packages/curved/src/shapes.ts";
import { makeSpace } from "../../packages/curved/src/problem.ts";
import { allStates } from "../../packages/curved/src/evaluate.ts";
import { CURVED_KS, CURVED_MS, CURVED_TILING_KS, PIECE_NS, countCurvedProblems } from "../../packages/spaces/src/piece-domains.ts";
import { validateSpaceSubmission } from "../../packages/spaces/src/validate.ts";
import { formatCurvature } from "../../packages/spaces/src/ids.ts";

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) throw new Error("usage: curved-ref.mts OUTDIR [--snapshot FILE.json.gz] [--fixtures DIR]");
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const snapshot = opt("--snapshot");
const fixturesDir = opt("--fixtures");
const repo = new URL("../../", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------------------------
// numbers in JSON

/** A number of a case: itself, or its name when JSON has no form for it. */
const encIn = (x: number): number | string => (Number.isFinite(x) && !Object.is(x, -0) ? x : Object.is(x, -0) ? "-0" : String(x));
const decIn = (v: number | string): number => (typeof v === "number" ? v : v === "-0" ? -0 : Number(v));
/** A number of a result, as text: the same text exactly when the same double. */
const enc = (x: number): string => (Object.is(x, -0) ? "-0" : String(x));

// mulberry32, seeded: the cases are the same on every run
let state = 20261110;
const rnd = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-300)) * Math.cos(2 * Math.PI * rnd());
const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];

// ---------------------------------------------------------------------------------------------
// cases

type Pose = { x: number; y: number; theta: number };
type Config = { size: number; pieces: Pose[] };
interface Case {
  id: number;
  kind: string;
  /** where the configuration comes from: record, touching, sweep, site, lattice, random, made */
  base: string;
  K: number;
  N: number;
  M: number;
  P: number;
  size: number;
  pieces: Pose[];
}
const cases: Case[] = [];
const add = (kind: string, base: string, K: number, N: number, M: number, P: number, c: Config) =>
  cases.push({ id: cases.length, kind, base, K, N, M, P, size: c.size, pieces: c.pieces.map((p) => ({ ...p })) });

interface Base {
  from: string;
  K: number;
  N: number;
  M: number;
  P: number;
  config: Config;
}
const bases: Base[] = [];

// the research records and the sweep
type Rec = { id: string; K: number; N: number; M: number; P: number; config?: Config; config_touching?: Config };
for (const r of JSON.parse(readFileSync(`${repo}data/curved/records.json`, "utf8")).records as Rec[]) {
  if (r.config) bases.push({ from: "record", K: r.K, N: r.N, M: r.M, P: r.P, config: r.config });
  if (r.config_touching) bases.push({ from: "touching", K: r.K, N: r.N, M: r.M, P: r.P, config: r.config_touching });
}
for (const r of JSON.parse(readFileSync(`${repo}data/curved/sweep/records.json`, "utf8")).records as Rec[])
  if (r.config) bases.push({ from: "sweep", K: r.K, N: r.N, M: r.M, P: r.P, config: r.config });

// the site's leading entries
if (snapshot) {
  for await (const line of createInterface({ input: createReadStream(snapshot).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (!line.startsWith('{"problem":')) continue;
    let text = line.trim().replace(/,$/, "");
    let r: { problem: string; P: number; config: Config } | null = null;
    for (let k = 0; k < 4 && !r; k++) {
      try {
        r = JSON.parse(text);
      } catch {
        text = text.slice(0, -1);
      }
    }
    if (!r) throw new Error("unreadable record in " + snapshot);
    const [, k, n, m, p] = r.problem.split("/");
    bases.push({ from: "site", K: Number(k), N: Number(n), M: Number(m), P: Number(p), config: r.config });
  }
}
const real = bases.length;

// Lattice packings: the first P points of a hexagonal lattice in exponential coordinates, turned and
// shifted at random, spread until no two pieces are closer than 1e-7, in the smallest container that
// holds them (validate's tightSize: the container touches a piece to the last bits).
function hexPoints(P: number): [number, number][] {
  const pts: [number, number][] = [];
  const R = Math.ceil(Math.sqrt(P)) + 2;
  for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) pts.push([a + b / 2, (b * Math.sqrt(3)) / 2]);
  pts.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]) || p[0] - q[0] || p[1] - q[1]);
  return pts.slice(0, P);
}
function lattice(K: number, N: number, M: number, P: number): Config | null {
  let R: number;
  try {
    R = makeSpace(K, N, M).piece.R;
  } catch {
    return null;
  }
  const sMax = maxContainerSize(M, K);
  const pts = hexPoints(P);
  const rot = rnd() * 2 * Math.PI;
  const ox = (rnd() - 0.5) * 0.6;
  const oy = (rnd() - 0.5) * 0.6;
  const thetas = pts.map(() => rnd() * 2 * Math.PI);
  let d = 2 * R * 1.001;
  for (let it = 0; it < 80; it++) {
    const pieces = pts.map(([a, b], i) => {
      const x = (a + ox) * d;
      const y = (b + oy) * d;
      return { x: x * Math.cos(rot) - y * Math.sin(rot), y: x * Math.sin(rot) + y * Math.cos(rot), theta: thetas[i] };
    });
    const v = validate({ N, M, P }, K, { size: Number.isFinite(sMax) ? sMax / 2 : 1, pieces });
    if (Number.isNaN(v.minGap)) return null; // (a centre outside the open hemisphere: P pieces do not fit this way)
    if (P > 1 && !(v.minPairGap > 1e-7)) {
      d *= 1.07;
      continue;
    }
    if (v.errors.includes("vertex outside the open hemisphere")) return null;
    if (!Number.isFinite(v.tightSize) || !(v.tightSize < sMax)) return null;
    return { size: v.tightSize, pieces };
  }
  return null;
}
const P_LIST = [1, 2, 3, 5, 8, 13, 24, 50, 100, 200, 500];
const LATTICE_NS = [0, 3, 4, 6, 7, 17, 100];
const LATTICE_MS = [0, 3, 4, 6, 11, 100];
let turn = 0;
for (const K of CURVED_KS) {
  for (const N of LATTICE_NS) {
    if (!pieceExists(N, K)) continue;
    for (const M of LATTICE_MS) {
      const maxP = curvedMaxP(K, N, M);
      if (maxP < 1) continue;
      // two piece counts for each (K, N, M), walking the list; large counts cost time, so not for every shape
      for (let rep = 0; rep < 2; rep++) {
        let P = Math.min(P_LIST[turn++ % P_LIST.length], maxP);
        if (P > 100 && N > 12 && turn % 4 !== 0) P = 24 + (turn % 40);
        P = Math.min(P, maxP);
        const c = lattice(K, N, M, P) ?? lattice(K, N, M, Math.max(1, Math.min(P, 3))) ?? lattice(K, N, M, 1);
        if (c) bases.push({ from: "lattice", K, N, M, P: c.pieces.length, config: c });
      }
    }
  }
}
// the largest P the server accepts, for pieces and containers of both kinds
for (const [K, N, M] of [
  [-1e-6, 0, 0], [1e-6, 0, 4], [-0.0001, 3, 0], [0.0001, 4, 4], [-0.001, 6, 7], [0.001, 0, 100], [-0.01, 100, 0], [-1e-6, 100, 100],
  [-0.01, 0, 0], [-0.1, 0, 0], [-0.25, 3, 0], [-1, 0, 0], [-1, 5, 0], [-6.519717439579256, 0, 0], [-6.519717439579256, 3, 0],
] as const) {
  for (const P of [500, 499, 300]) {
    const c = lattice(K, N, M, Math.min(P, curvedMaxP(K, N, M)));
    if (c) bases.push({ from: "lattice", K, N, M, P: c.pieces.length, config: c });
  }
}
const lattices = bases.length - real;

// mutants
const R_of = (b: Base) => makeSpace(b.K, b.N, b.M).piece.R;
const farthest = (c: Config) => c.pieces.reduce((best, p, i) => (Math.hypot(p.x, p.y) > Math.hypot(c.pieces[best].x, c.pieces[best].y) ? i : best), 0);
const moveOut = (c: Config, i: number, by: number): Config => {
  const p = c.pieces[i];
  const d = Math.hypot(p.x, p.y);
  const [ux, uy] = d > 1e-9 ? [p.x / d, p.y / d] : [0.6, -0.8];
  return { size: c.size, pieces: c.pieces.map((q, j) => (j === i ? { x: q.x + ux * by, y: q.y + uy * by, theta: q.theta } : q)) };
};
const scaled = (c: Config, f: number): Config => ({ size: c.size, pieces: c.pieces.map((p) => ({ x: p.x * f, y: p.y * f, theta: p.theta })) });
const GEOMETRIC: [string, (b: Base) => Config | null][] = [
  ["shrink-1e-10", (b) => ({ ...b.config, size: b.config.size * (1 - 1e-10) })],
  ["shrink-3e-9", (b) => ({ ...b.config, size: b.config.size * (1 - 3e-9) })],
  ["shrink-1e-6", (b) => ({ ...b.config, size: b.config.size * (1 - 1e-6) })],
  ["grow-1e-9", (b) => ({ ...b.config, size: b.config.size * (1 + 1e-9) })],
  ["squeeze-3e-10", (b) => scaled(b.config, 1 - 3e-10)],
  ["squeeze-3e-9", (b) => scaled(b.config, 1 - 3e-9)],
  ["squeeze-1e-6", (b) => scaled(b.config, 1 - 1e-6)],
  ["spread-5e-10", (b) => moveOut(b.config, farthest(b.config), 5e-10)],
  ["spread-1e-3", (b) => moveOut(b.config, farthest(b.config), 1e-3)],
  ["overlap", (b) => (b.P < 2 ? null : { size: b.config.size, pieces: b.config.pieces.map((p, i) => (i === 1 ? { x: b.config.pieces[0].x + 0.01, y: b.config.pieces[0].y, theta: p.theta } : p)) })],
  ["coincident", (b) => (b.P < 2 ? null : { size: b.config.size, pieces: b.config.pieces.map(() => ({ ...b.config.pieces[0] })) })],
  ["turned", (b) => ({ size: b.config.size, pieces: b.config.pieces.map((p, i) => (i === 0 ? { ...p, theta: p.theta + 0.3 } : p)) })],
  ["jitter-1e-9", (b) => ({ size: b.config.size, pieces: b.config.pieces.map((p) => ({ x: p.x + 1e-9 * gauss(), y: p.y + 1e-9 * gauss(), theta: p.theta + 1e-9 * gauss() })) })],
  ["far", (b) => {
    const reach = containerCircumradius(b.M, b.K, b.config.size);
    return Number.isFinite(reach) ? moveOut(b.config, 0, reach * 1.5 + 1) : null;
  }],
];
// inputs the validator refuses, or that end in a reason of their own: [kind, the case's fields]
const REFUSED: [string, (b: Base) => Partial<Base> | null][] = [
  ["count+1", (b) => ({ P: b.P + 1 })],
  ["count-1", (b) => (b.P < 2 ? null : { P: b.P - 1 })],
  ["x-nan", (b) => ({ config: { size: b.config.size, pieces: b.config.pieces.map((p, i) => (i === b.P - 1 ? { ...p, x: NaN } : p)) } })],
  ["theta-inf", (b) => ({ config: { size: b.config.size, pieces: b.config.pieces.map((p, i) => (i === 0 ? { ...p, theta: -Infinity } : p)) } })],
  ["size-zero", (b) => ({ config: { ...b.config, size: 0 } })],
  ["size-negative", (b) => ({ config: { ...b.config, size: -b.config.size } })],
  ["size-nan", (b) => ({ config: { ...b.config, size: NaN } })],
  ["size-inf", (b) => ({ config: { ...b.config, size: Infinity } })],
  ["p-zero", (b) => ({ P: 0, config: { size: b.config.size, pieces: [] } })],
  ["n-2", () => ({ N: 2 })],
  ["n-101", () => ({ N: 101 })],
  ["m-1", () => ({ M: 1 })],
  ["m-250", () => ({ M: 250 })],
  ["k-nan", () => ({ K: NaN })],
  ["k-inf", () => ({ K: -Infinity })],
  ["no-piece", (b) => ({ K: b.N === 0 ? 50 : 40 / (b.N * b.N) })],
  ["minus-zero", (b) => ({ config: { size: b.config.size, pieces: b.config.pieces.map((p, i) => (i === 0 ? { x: -0, y: -0, theta: -0 } : p)) } })],
  // K > 0: the size at, just above and just below the open hemisphere's
  ["size-at-max", (b) => (b.K > 0 ? { config: { ...b.config, size: maxContainerSize(b.M, b.K) } } : null)],
  ["size-above-max", (b) => (b.K > 0 ? { config: { ...b.config, size: maxContainerSize(b.M, b.K) * (1 + 1e-12) } } : null)],
  ["size-below-max", (b) => (b.K > 0 ? { config: { ...b.config, size: maxContainerSize(b.M, b.K) * (1 - 1e-12) } } : null)],
  // K > 0: a centre on the hemisphere's rim, and a polygon whose centre is inside it and whose vertices are not
  ["centre-on-rim", (b) => (b.K > 0 ? { config: moveOut(b.config, 0, Math.PI / (2 * Math.sqrt(b.K)) - Math.hypot(b.config.pieces[0].x, b.config.pieces[0].y)) } : null)],
  ["vertex-past-rim", (b) => (b.K > 0 ? { config: moveOut(b.config, 0, Math.PI / (2 * Math.sqrt(b.K)) - Math.hypot(b.config.pieces[0].x, b.config.pieces[0].y) - 0.3 * R_of(b)) } : null)],
  // K < 0: a polygon container whose apothem overflows, and a centre whose coordinates overflow
  ["size-overflow", (b) => (b.K < 0 && b.M > 0 ? { config: { ...b.config, size: 3000 / Math.sqrt(-b.K) } } : null)],
  ["centre-overflow", (b) => (b.K < 0 ? { config: { ...moveOut(b.config, 0, 1500 / Math.sqrt(-b.K)), size: b.M === 0 ? 4000 / Math.sqrt(-b.K) : b.config.size } } : null)],
  ["centre-far", (b) => (b.K < 0 ? { config: { ...moveOut(b.config, 0, 40 / Math.sqrt(-b.K)), size: b.M === 0 ? 100 / Math.sqrt(-b.K) : b.config.size } } : null)],
];
bases.forEach((b, i) => {
  add("as-given", b.from, b.K, b.N, b.M, b.P, b.config);
  // large packings get one mutant, the others two, walking the list of kinds
  const picks = b.P > 100 ? [i % GEOMETRIC.length] : [i % GEOMETRIC.length, (i * 5 + 3) % GEOMETRIC.length];
  for (const g of new Set(picks)) {
    const [kind, make] = GEOMETRIC[g];
    const c = make(b);
    if (c) add(kind, b.from, b.K, b.N, b.M, b.P, c);
  }
  if (i % 3 === 0 && b.P <= 100) {
    const [kind, make] = REFUSED[Math.floor(i / 3) % REFUSED.length];
    const f = make(b);
    if (f) {
      const m = { ...b, ...f };
      add(kind, b.from, m.K, m.N, m.M, m.P, m.config);
    }
  }
});
// every refusal at least a few times, whatever the walk above reached
for (const [kind, make] of REFUSED) {
  let made = 0;
  for (let i = 0; i < bases.length && made < 6; i += 37) {
    const b = bases[(i * 11) % bases.length];
    if (b.P > 60) continue;
    const f = make(b);
    if (!f) continue;
    const m = { ...b, ...f };
    add(kind, b.from, m.K, m.N, m.M, m.P, m.config);
    made++;
  }
}
// random configurations: centres uniform in the disk of the container's circumradius (most overlap), and sparse ones
const RANDOM_KS = [...CURVED_KS, 0, 0, -2, 2, 0.3, -0.7, 1.9, 1e-9, -1e-9, 3];
for (let i = 0; i < 700; i++) {
  const K = pick(RANDOM_KS);
  const N = pick([0, 0, 3, 3, 4, 5, 6, 7, 8, 12, 25, 60, 100]);
  const M = pick([0, 0, 3, 4, 5, 6, 9, 20, 100]);
  if (!pieceExists(N, K)) continue;
  const maxP = curvedMaxP(K, N, M, 60);
  if (maxP < 1) continue;
  const P = 1 + Math.floor(rnd() * Math.min(maxP, i % 5 === 0 ? 60 : 14));
  const bound = curvedBoundOf(K, N, M, P);
  if (bound === null) continue;
  const sMax = maxContainerSize(M, K);
  const sparse = i % 3 === 0;
  let size = bound * (sparse ? 2 + 6 * rnd() : 0.9 + 0.8 * rnd());
  if (!(size < sMax)) size = bound + (sMax - bound) * rnd();
  let reach = containerCircumradius(M, K, size);
  if (!Number.isFinite(reach)) reach = 1;
  const pieces = Array.from({ length: P }, () => {
    const r = reach * Math.sqrt(rnd()) * (sparse ? 0.7 : 1.05);
    const a = rnd() * 2 * Math.PI;
    return { x: r * Math.cos(a), y: r * Math.sin(a), theta: (rnd() - 0.5) * 20 };
  });
  add(sparse ? "random-sparse" : "random", "random", K, N, M, P, { size, pieces });
}

// The cases as both sides read them: written, then read back (a -0 or NaN survives as its name).
const caseLine = (c: Case) =>
  JSON.stringify({
    id: c.id, kind: c.kind, base: c.base, K: encIn(c.K), N: c.N, M: c.M, P: c.P, size: encIn(c.size),
    pieces: c.pieces.map((p) => [encIn(p.x), encIn(p.y), encIn(p.theta)]),
  });
type Read = { id: number; kind: string; base: string; K: number; N: number; M: number; P: number; config: Config };
const readCase = (line: string): Read => {
  const c = JSON.parse(line);
  return {
    id: c.id, kind: c.kind, base: c.base, K: decIn(c.K), N: c.N, M: c.M, P: c.P,
    config: { size: decIn(c.size), pieces: c.pieces.map((p: (number | string)[]) => ({ x: decIn(p[0]), y: decIn(p[1]), theta: decIn(p[2]) })) },
  };
};
const lines = cases.map(caseLine);
writeFileSync(`${outDir}/cases.jsonl`, lines.join("\n") + "\n");
const read = lines.map(readCase);

// ---------------------------------------------------------------------------------------------
// the TypeScript's results

/** Contacts written in full up to this many (the count is always written). */
const MAX_CONTACTS = 40;
const MAX_ERRORS_WRITTEN = 40;
function result(v: ValidationResult) {
  return {
    valid: v.valid,
    strictlyValid: v.strictlyValid,
    score: enc(v.score),
    tightSize: enc(v.tightSize),
    minGap: enc(v.minGap),
    minPairGap: enc(v.minPairGap),
    minContainerGap: enc(v.minContainerGap),
    nErrors: v.errors.length,
    errors: v.errors.slice(0, MAX_ERRORS_WRITTEN),
    nContacts: v.contacts.length,
    contacts: v.contacts
      .slice(0, MAX_CONTACTS)
      .map((c) => [c.kind, c.i, c.j, c.wall, c.vertex, enc(c.gap), ...(c.witness ? [c.witness.owner, c.witness.edge, c.witness.vertex] : [])]),
  };
}
const MAX_REASONS = 20;
/** packages/spaces/src/validate.ts: reasonsOf. */
const reasonsOf = (errors: string[], fallback: string) => {
  const list = errors.slice(0, MAX_REASONS);
  return list.length ? list : [fallback];
};
/** packages/spaces/src/validate.ts: check(), the curved branch (that function is not exported). */
function check(c: Read, tol: number): string[] {
  const reach = containerCircumradius(c.M, c.K, c.config.size);
  if (Number.isFinite(reach)) {
    const far = c.config.pieces.findIndex((p) => !(Math.hypot(p.x, p.y) <= reach * (1 + 1e-6) + 1e-6));
    if (far >= 0) return [`the centre of piece ${far} lies outside the container`];
  }
  const v = validate({ N: c.N, M: c.M, P: c.P }, c.K, c.config, { tol, maxErrors: MAX_REASONS });
  return v.valid ? [] : reasonsOf(v.errors, `not a valid packing (smallest gap ${v.minGap})`);
}
const problemOf = (c: Read) => ({ N: c.N, M: c.M, P: c.P });
/**
 * The largest |v0|, |x|, |y| of the pieces' lifted points, or null when there are none to compute. The products the
 * gaps are made of cancel from the square of this down to the gap, so the validator's own rounding error is about
 * 2^-52 (1 + mag)^2: at K < 0 the coordinates grow as cosh(sqrt(-K) d) with the distance d from O. The comparison
 * uses it to tell a difference of the port from one that is below what the float check itself resolves.
 */
function magnitude(c: Read): number | null {
  if (!Number.isFinite(c.K) || !c.config.pieces.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.theta))) return null;
  let space;
  try {
    space = makeSpace(c.K, c.N, c.M);
  } catch {
    return null;
  }
  let mag = 0;
  for (const s of allStates(space, c.config.pieces))
    for (const p of [s.centre, ...s.verts]) mag = Math.max(mag, Math.abs(1 - c.K * p.e), Math.abs(p.x), Math.abs(p.y));
  return mag;
}
const refOf = (c: Read) => ({
  id: c.id,
  mag: ((m) => (m === null ? null : enc(m)))(magnitude(c)),
  runs: [
    result(validate(problemOf(c), c.K, c.config, { tol: 1e-9, maxErrors: MAX_REASONS })),
    result(validate(problemOf(c), c.K, c.config, { tol: 1e-11, maxErrors: MAX_REASONS })),
    result(validate(problemOf(c), c.K, c.config)),
  ],
  check: [check(c, 1e-9), check(c, 1e-11)],
});
const refs = read.map(refOf);
writeFileSync(`${outDir}/ref.jsonl`, refs.map((r) => JSON.stringify(r)).join("\n") + "\n");

// The copy of check() above against the server's own path, where an id and a JSON body can carry the case:
// validateSpaceSubmission with no bound and no record gives check's reasons at 1e-9; told that the problem has
// no research record, it gives the strict reason and the first three of check's at 1e-11.
let serverSame = 0;
let serverDiff = 0;
const jsonNumber = (x: number) => Number.isFinite(x);
for (const [i, c] of read.entries()) {
  if (!Number.isFinite(c.K) || !PIECE_NS.includes(c.N) || !CURVED_MS.includes(c.M) || c.P < 1 || c.P > CURVED_MAX_P) continue;
  if (c.config.pieces.length !== c.P || !jsonNumber(c.config.size) || !c.config.pieces.every((p) => jsonNumber(p.x) && jsonNumber(p.y) && jsonNumber(p.theta))) continue;
  const id = `curved/${formatCurvature(c.K)}/${c.N}/${c.M}/${c.P}`;
  const loose = validateSpaceSubmission("curved", id, c.config, {});
  if (loose.malformed) continue;
  const strict = validateSpaceSubmission("curved", id, c.config, { noRecord: true });
  const [r9, r11] = refs[i].check;
  const want = r9.length ? r9 : r11.length ? [strict.reasons[0], ...r11.slice(0, 3)] : [];
  const ok = JSON.stringify(loose.reasons) === JSON.stringify(r9) && loose.valid === (r9.length === 0) && JSON.stringify(strict.reasons) === JSON.stringify(want);
  if (ok) serverSame++;
  else if (serverDiff++ < 5) console.log("check() differs from validateSpaceSubmission:", id, c.kind, loose.reasons, r9, strict.reasons, want);
}

// timing: validate as the server calls it, best of five passes per case
const best = new Float64Array(read.length).fill(Infinity);
for (let pass = 0; pass < 5; pass++)
  for (const [i, c] of read.entries()) {
    const t = process.hrtime.bigint();
    validate(problemOf(c), c.K, c.config, { tol: 1e-9, maxErrors: MAX_REASONS });
    const d = Number(process.hrtime.bigint() - t);
    if (d < best[i]) best[i] = d;
  }
writeFileSync(`${outDir}/ts-times.json`, JSON.stringify(Array.from(best)));

// ---------------------------------------------------------------------------------------------
// bounds and the domain

/**
 * One line: the inputs, then what the package answers. `limit` null is curvedMaxP's default.
 * curvedMaxP walks P down by one from the area's estimate, which never ends when the limit and the estimate are both
 * above 2^53 (P - 1 is then P): an infinite limit at a curvature so near 0 that the largest container holds more than
 * 2^53 pieces. The server never asks that (its limits are at most 9999), and no line here does.
 */
function boundLine(K: number, N: number, M: number, limit: number | null, Ps: number[], sizes: number[]) {
  const code = (n: number) => n === 0 || (Number.isInteger(n) && n >= 3 && n <= 100);
  const codes = code(N) && code(M);
  const endless = (v: number | null) => v !== null && v > 1e15 && Math.abs(K) < 1e-9;
  if (endless(limit)) limit = 9999;
  Ps = Ps.map((P) => (endless(P) ? 9999 : P));
  // (keys in alphabetical order, as serde_json writes them: the same answers are then the same line)
  return JSON.stringify({
    K: encIn(K),
    M: encIn(M),
    N: encIn(N),
    // containerCircumradius, pieceExists and curvedBoundOf are reached with shape codes only
    circ: codes ? sizes.map((s) => [encIn(s), enc(containerCircumradius(M, K, s))]) : [],
    exists: codes ? pieceExists(N, K) : null,
    limit: limit === null ? null : encIn(limit),
    maxP: enc(limit === null ? curvedMaxP(K, N, M) : curvedMaxP(K, N, M, limit)),
    ps: Ps.map((P) => {
      const whole = codes && Number.isInteger(P) && P >= 0 && P < 2 ** 32;
      const b = whole ? curvedBoundOf(K, N, M, P) : undefined;
      return [encIn(P), b === undefined ? "skip" : b === null ? null : enc(b), curvedWhyNot(K, N, M, P)];
    }),
  });
}
const boundLines: string[] = [];
// the whole domain: every curvature, piece and container; P = 1, 2, the largest that exists and the next, and one at random
for (const K of CURVED_KS)
  for (const N of PIECE_NS)
    for (const M of CURVED_MS) {
      const maxP = curvedMaxP(K, N, M);
      const few = N % 7 === 0 || M % 9 === 0;
      const Ps = [...new Set([1, maxP, maxP + 1, ...(few ? [2, 1 + Math.floor(rnd() * 500), 500] : [])])].filter((p) => p >= 1);
      boundLines.push(boundLine(K, N, M, null, Ps, N === 0 ? [0.5, 1 + 3 * rnd(), 1e6] : []));
      if (few) boundLines.push(boundLine(K, N, M, 1, [], []));
    }
const domainLines = boundLines.length;
// outside the domain: other curvatures, numbers that are not shape codes, limits and counts of every kind
const ODD_KS = [0, -0, NaN, Infinity, -Infinity, 1e-300, -1e-300, 1e300, -1e300, 5e-324, 2, -2, 39.47841760435743, 39.4784176043574, 9.869604401089358, 0.4386490844928603, 157.91367041742973, 1.2257782833130991, 1.2257782833130988, 123456.789, -123456.789, 1e-7, -1e-7, 1e21, -1e21];
const ODD_CODES = [0, -0, 1, 2, 3, 3.5, 4, 5, 6, 7, 50, 100, 101, -3, NaN, Infinity, 1e9];
const ODD_LIMITS = [null, 0, 0.5, 1, 1.5, 2, 2.5, 7.9, 500, 9999, NaN, Infinity, -1];
const ODD_PS = [0, 1, 2, 3, 2.5, -1, NaN, 500, 501, 9999, 1e6, Infinity];
for (let i = 0; i < 6000; i++) {
  const K = i % 3 === 0 ? pick(ODD_KS) : i % 3 === 1 ? (rnd() - 0.6) * 10 ** (4 * rnd() - 2) : pick(CURVED_KS);
  const N = i % 4 === 0 ? pick(ODD_CODES) : pick(PIECE_NS);
  const M = i % 5 === 0 ? pick(ODD_CODES) : pick(CURVED_MS);
  boundLines.push(boundLine(K, N, M, pick(ODD_LIMITS), [pick(ODD_PS), pick(ODD_PS), 1 + Math.floor(rnd() * 40)], [rnd() * 3, 10 ** (8 * rnd() - 2)]));
}
writeFileSync(`${outDir}/bound-ref.jsonl`, boundLines.join("\n") + "\n");

// ---------------------------------------------------------------------------------------------
// fixtures for cargo test: small cases of every kind with their verdicts, and a sample of the bounds

if (fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true });
  // two of each kind of case, from different sources, and two as given from each source; small ones
  const taken = new Map<string, Set<string>>();
  const chosen: string[] = [];
  for (const [i, c] of read.entries()) {
    const key = c.kind === "as-given" ? `as-given ${c.base}` : c.kind;
    const bases = taken.get(key) ?? new Set<string>();
    const full = c.kind === "as-given" ? bases.size >= 2 : bases.size >= 2 || bases.has(c.base);
    if (lines[i].length > 1800 || full) continue;
    // a verdict that hangs on the last bits of a gap is not a fixture: the transcendental functions differ there
    const edge = refs[i].runs.some((r, k) => {
      const g = Number(r.minGap);
      const tol = k === 1 ? 1e-11 : 1e-9;
      return Number.isFinite(g) && (Math.abs(g + tol) < 1e-13 || Math.abs(g - 1e-7) < 1e-13);
    });
    if (edge) continue;
    taken.set(key, bases.add(c.kind === "as-given" ? String(bases.size) : c.base));
    chosen.push(JSON.stringify({ case: JSON.parse(lines[i]), expect: refs[i] }));
  }
  writeFileSync(`${fixturesDir}/validate.jsonl`, chosen.join("\n") + "\n");
  const sample = boundLines.filter((_, i) => (i < domainLines ? i % 2999 === 0 : i % 25 === 0));
  writeFileSync(`${fixturesDir}/bound.jsonl`, sample.join("\n") + "\n");
  // the domain's lists and its number of problems (packages/spaces/src/piece-domains.ts), which is the sum of curvedMaxP
  writeFileSync(`${fixturesDir}/domain.json`, JSON.stringify({ ks: CURVED_KS, ns: PIECE_NS, ms: CURVED_MS, problems: countCurvedProblems() }) + "\n");
  console.log(`fixtures: ${chosen.length} configurations, ${sample.length} bound lines in ${fixturesDir}`);
}

const count = (key: (c: Case) => string) => {
  const m = new Map<string, number>();
  for (const c of cases) m.set(key(c), (m.get(key(c)) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k} ${n}`).join(", ");
};
console.log(`${cases.length} cases from ${bases.length} configurations (${real} real: records, sweep${snapshot ? ", site" : ""}; ${lattices} lattices${existsSync(snapshot ?? "") ? "" : "; no snapshot given"})`);
console.log(`by source: ${count((c) => c.base)}`);
console.log(`by kind: ${count((c) => c.kind)}`);
console.log(`tiling curvatures: ${cases.filter((c) => CURVED_TILING_KS.includes(c.K)).length} cases; P > 100: ${cases.filter((c) => c.P > 100).length}; P = 500: ${cases.filter((c) => c.P === 500).length}`);
console.log(`check() against validateSpaceSubmission: ${serverSame} the same, ${serverDiff} different`);
console.log(`${boundLines.length} bound lines (${domainLines} of the domain)`);
