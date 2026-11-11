// Builds the cases of the torus family and writes the TypeScript's verdicts and timings: the
// reference that native/torus (crate polypack-torus) is compared with (native/PORTING.md).
//
//   node --import tsx native/tools/torus-ref.mts OUTDIR space-torus.json.gz [--fixtures native/torus/tests/fixtures] [--no-times]
//   cargo run --release -p polypack-torus --example torusdiff -- OUTDIR
//   node native/tools/torus-compare.mjs OUTDIR
//
// Cases: the site's leading entries (the nightly snapshot), the research records
// (data/torus/records.json), mutants of both (overlaps, shrunk sizes, shifted and rotated copies,
// and for free lattices skewed, left-handed and nearly degenerate bases), random configurations
// of every family and N, grids of up to 500 pieces, pieces at the tolerances, and malformed input.
// Written: cases.jsonl, ref.jsonl (per case the validator's result at 1e-9 and 1e-11 as the server
// calls it, the reasons of `check`, and the result with no options for cases of at most 60
// pieces), ts-times.json (best of five of `check` at 1e-9, in nanoseconds), and aux-cases.jsonl /
// aux-ref.jsonl (gaussReduce, maxImageCandidates, torusScore, the stored basis, areaScoreBound,
// latticeImages, separationOf, the piece radii, and the validator with its other options, on their own inputs).
//
// A number that JSON cannot hold is written as the string "NaN", "Infinity" or "-Infinity".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { boundingRadius, pieceArea, pieceInradius } from "../../packages/geometry/src/index.ts";
import { runSteps } from "../../packages/methods/src/sliced.ts";
import { separationOf } from "../../packages/torus/src/disk.ts";
import {
  type Lattice,
  type TorusFamily,
  gaussReduce,
  latticeImages,
  maxImageCandidates,
  torusScore,
} from "../../packages/torus/src/lattice.ts";
import { type TorusValidation, areaScoreBound, validationSteps } from "../../packages/torus/src/validate.ts";
import { TORUS_MAX_TRANSLATES } from "../../packages/spaces/src/info.ts";
import {
  SPACE_STRICT_NO_RECORD_REASON,
  storedSpaceConfig,
  validateSpaceSubmission,
} from "../../packages/spaces/src/validate.ts";

const args = process.argv.slice(2);
const fx = args.indexOf("--fixtures");
const fixturesDir = fx >= 0 ? args.splice(fx, 2)[1] : null;
// --no-times: the timing passes are left out and ts-times.json is not written (for a run under emulation)
const nt = args.indexOf("--no-times");
const noTimes = nt >= 0;
if (noTimes) args.splice(nt, 1);
const [outDir, snapshot] = args;
if (!outDir || !snapshot) throw new Error("usage: torus-ref.mts OUTDIR space-torus.json.gz [--fixtures DIR]");
mkdirSync(outDir, { recursive: true });

// mulberry32: the cases are the same at every run
let seed = 20261111;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const MAX_REASONS = 20;
const NS = [0, ...Array.from({ length: 98 }, (_, i) => i + 3)];
const FAMILIES: TorusFamily[] = ["sq", "hex", "free"];
type V2 = [number, number];
type Spec = { L: number } | { b1: V2; b2: V2 };
type Config = { lattice: Spec; poses: [number, number, number][] };
type Case = { id: number; kind: string; family: TorusFamily; N: number } & Config;
const cases: Case[] = [];
const add = (kind: string, family: TorusFamily, N: number, c: Config) =>
  cases.push({ id: cases.length, kind, family, N, ...(JSON.parse(JSON.stringify(c, enc), dec) as Config) });

/** Non-finite numbers as strings, in the files. */
function enc(_: string, v: unknown) {
  return typeof v === "number" && !Number.isFinite(v) ? String(v) : v;
}
function dec(_: string, v: unknown) {
  return v === "NaN" ? NaN : v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : v;
}
/** The lattice of a configuration, as check() of packages/spaces/src/validate.ts builds it. */
const latticeOf = (family: TorusFamily, L: Spec): Lattice =>
  "L" in L
    ? family === "sq"
      ? { b1: [L.L, 0], b2: [0, L.L] }
      : { b1: [L.L, 0], b2: [L.L / 2, (L.L * Math.sqrt(3)) / 2] }
    : { b1: L.b1, b2: L.b2 };
const basisOf = (family: TorusFamily, L: Spec): { b1: V2; b2: V2 } => {
  const l = latticeOf(family, L);
  return { b1: [l.b1[0], l.b1[1]], b2: [l.b2[0], l.b2[1]] };
};

// ---- real packings and their mutants -------------------------------------------------------
const real: { source: string; family: TorusFamily; N: number; config: Config }[] = [];
for (const line of gunzipSync(readFileSync(snapshot)).toString().split("\n").slice(1)) {
  const text = line.trim().replace(/,$/, "");
  if (!text.startsWith("{")) continue;
  const r = JSON.parse(text);
  const [, family, N] = r.problem.split("/");
  real.push({ source: "site", family, N: Number(N), config: r.config });
}
for (const r of JSON.parse(readFileSync(new URL("../../data/torus/records.json", import.meta.url), "utf8")).records)
  real.push({ source: "record", family: r.family, N: r.N, config: r.configuration });

const scaled = (c: Config, k: number): Config => ({
  lattice: "L" in c.lattice ? { L: c.lattice.L * k } : { b1: [c.lattice.b1[0] * k, c.lattice.b1[1] * k], b2: [c.lattice.b2[0] * k, c.lattice.b2[1] * k] },
  poses: c.poses.map(([x, y, t]) => [x * k, y * k, t]),
});
const withBasis = (c: Config, b: { b1: V2; b2: V2 }): Config => ({ lattice: b, poses: c.poses });
/** The same packing turned by phi about the origin (a free lattice). */
const rotated = (family: TorusFamily, c: Config, phi: number): Config => {
  const [co, si] = [Math.cos(phi), Math.sin(phi)];
  const turn = ([x, y]: V2): V2 => [co * x - si * y, si * x + co * y];
  const b = basisOf(family, c.lattice);
  return { lattice: { b1: turn(b.b1), b2: turn(b.b2) }, poses: c.poses.map(([x, y, t]) => [...turn([x, y]), t + phi]) };
};
const MALFORMED: [string, (N: number, c: Config, b: { b1: V2; b2: V2 }) => [number, Config]][] = [
  ["pose-nan", (N, c) => [N, { ...c, poses: c.poses.map((p, i) => (i === c.poses.length - 1 ? [p[0], NaN, p[2]] : p)) }]],
  ["pose-infinite", (N, c) => [N, { ...c, poses: c.poses.map((p, i) => (i === 0 ? [Infinity, p[1], p[2]] : p)) }]],
  ["theta-nan", (N, c) => [N, { ...c, poses: c.poses.map((p) => [p[0], p[1], NaN]) }]],
  ["lattice-nan", (N, c, b) => [N, withBasis(c, { b1: [NaN, b.b1[1]], b2: b.b2 })]],
  ["lattice-infinite", (N, c, b) => [N, withBasis(c, { b1: b.b1, b2: [b.b2[0], Infinity] })]],
  ["lattice-parallel", (N, c, b) => [N, withBasis(c, { b1: b.b1, b2: [2 * b.b1[0], 2 * b.b1[1]] })]],
  ["lattice-zero", (N, c) => [N, withBasis(c, { b1: [0, 0], b2: [0, 0] })]],
  ["L-zero", (N, c) => [N, { ...c, lattice: { L: 0 } }]],
  ["L-negative", (N, c, b) => [N, { ...c, lattice: { L: -Math.hypot(b.b1[0], b.b1[1]) } }]],
  ["L-nan", (N, c) => [N, { ...c, lattice: { L: NaN } }]],
  ["N-2", (_, c) => [2, c]],
  ["N-101", (_, c) => [101, c]],
  ["N-fraction", (_, c) => [4.5, c]],
  ["N-nan", (_, c) => [NaN, c]],
  ["N-negative", (_, c) => [-6, c]],
  ["no-pieces", (N, c) => [N, { ...c, poses: [] }]],
  ["everything", (_, c) => [1, { lattice: { b1: [NaN, 0], b2: [0, 0] }, poses: c.poses.map((p, i) => [i % 2 ? NaN : p[0], p[1], p[2]]) }]],
  // a lattice whose area is not zero but too small to enumerate, and one whose window overflows
  ["nearly-parallel-1e-9", (N, c, b) => [N, withBasis(c, { b1: b.b1, b2: [b.b1[0] - 1e-9 * b.b1[1], b.b1[1] + 1e-9 * b.b1[0]] })]],
  ["nearly-parallel-1e-320", (N, c) => [N, withBasis(c, { b1: [1, 0], b2: [1, 1e-320] })]],
  ["tiny-lattice", (N, c, b) => [N, withBasis(c, { b1: [b.b1[0] * 0.02, b.b1[1] * 0.02], b2: [b.b2[0] * 0.02, b.b2[1] * 0.02] })]],
];
let malformed = 0;
real.forEach((r, t) => {
  const { family, N, config: c } = r;
  const P = c.poses.length;
  add(`real-${r.source}`, family, N, c);
  const b = basisOf(family, c.lattice);
  const width = 2 * pieceInradius(N);
  const mutants: string[] = [
    ["overlap", "shrink-1e-10", "basis"],
    ["shrink-3e-9", "shifted", "coincident"],
    ["shrink-1e-6", "rotated", "basis"],
    ["shrink-1e-10", "malformed", "squeezed"],
    ["shrink-3e-9", "overlap", "shifted"],
    ["malformed", "basis", "shrink-1e-6"],
  ][t % 6];
  for (const m of mutants) {
    if (m === "overlap" && P >= 2)
      add("overlap", family, N, { ...c, poses: c.poses.map((p, i) => (i === 1 ? [c.poses[0][0] + 0.3 * width, c.poses[0][1], p[2]] : p)) });
    else if (m === "overlap") add("squeezed", family, N, scaled(c, 0.7));
    else if (m.startsWith("shrink-")) add(m, family, N, scaled(c, 1 - Number(m.slice(7))));
    // the torus made smaller with the pieces where they are: overlaps with translates
    else if (m === "squeezed") add("squeezed", family, N, scaled(c, [0.97, 0.9, 0.6, 0.3][t % 4]));
    else if (m === "coincident") add("coincident", family, N, { ...c, poses: c.poses.map((p) => [c.poses[0][0], c.poses[0][1], p[2]]) });
    else if (m === "shifted") {
      // every piece moved by its own lattice vector, and all by one vector: the same packing
      const [gx, gy] = [200 * (rnd() - 0.5), 200 * (rnd() - 0.5)];
      add("shifted", family, N, {
        ...c,
        poses: c.poses.map(([x, y, th]) => {
          const [i, j] = [int(-30, 30), int(-30, 30)];
          const turn = N === 0 ? 100 * (rnd() - 0.5) : ((2 * Math.PI) / N) * int(-50, 50);
          return [x + i * b.b1[0] + j * b.b2[0] + gx, y + i * b.b1[1] + j * b.b2[1] + gy, th + turn];
        }),
      });
    } else if (m === "rotated") add("rotated-free", "free", N, rotated(family, c, 2 * Math.PI * rnd()));
    else if (m === "basis") {
      // the same lattice in another basis, as a free torus: skewed, left-handed, or both
      const k = (rnd() < 0.5 ? -1 : 1) * (P <= 50 ? int(1, 8) : int(1, 2));
      const skew: V2 = [b.b2[0] + k * b.b1[0], b.b2[1] + k * b.b1[1]];
      const pick = Math.floor(t / 2) % 6;
      if (pick === 0) add("basis-skewed", "free", N, withBasis(c, { b1: b.b1, b2: skew }));
      else if (pick === 1) add("basis-left-handed", "free", N, withBasis(c, { b1: b.b2, b2: b.b1 }));
      else if (pick === 2) add("basis-skewed-left-handed", "free", N, withBasis(c, { b1: skew, b2: [-b.b1[0], -b.b1[1]] }));
      else if (pick === 3) {
        // beyond the server's 1,000 translates; the validator alone still enumerates it (few pieces only)
        const big = P <= 4 ? int(40, 400) : 1e7 * (1 + rnd());
        add("basis-very-skewed", "free", N, withBasis(c, { b1: b.b1, b2: [b.b2[0] + big * b.b1[0], b.b2[1] + big * b.b1[1]] }));
      } else if (pick === 4) add("basis-negated", "free", N, withBasis(c, { b1: [-b.b1[0], -b.b1[1]], b2: b.b2 }));
      else add("basis-as-free", "free", N, withBasis(c, b));
    } else if (m === "malformed") {
      const [name, f] = MALFORMED[malformed++ % MALFORMED.length];
      const [n2, c2] = f(N, c, b);
      add(`malformed-${name}`, name.startsWith("L-") ? (family === "free" ? "sq" : family) : name.includes("lattice") || name.includes("parallel") || name === "everything" ? "free" : family, n2, c2);
    }
  }
});

// ---- random configurations: every family and N, few and many pieces, dense and sparse ----------
for (const family of FAMILIES)
  for (const N of NS) {
    for (const [kind, P, factor] of [
      ["random-sparse", int(1, 5), 2.5 + 3 * rnd()],
      ["random-dense", int(2, 12), 1.02 + 0.5 * rnd()],
      ["random-dense", (N + FAMILIES.indexOf(family)) % 9 === 0 ? 500 : int(40, 400), 1.05 + 0.6 * rnd()],
    ] as [string, number, number][]) {
      const L = areaScoreBound(family, N, P) * factor;
      let lattice: Spec = { L };
      if (family === "free") {
        // a random basis of area L^2: reduced, or not
        const phi = 2 * Math.PI * rnd();
        const [a, ang] = [0.6 + 0.8 * rnd(), Math.PI / 3 + (Math.PI / 3) * rnd()];
        const [l1, l2] = [L * a, L / (a * Math.sin(ang))];
        const k = rnd() < 0.4 ? int(-3, 3) : 0;
        const b1: V2 = [l1 * Math.cos(phi), l1 * Math.sin(phi)];
        const b2: V2 = [l2 * Math.cos(phi + ang) + k * b1[0], l2 * Math.sin(phi + ang) + k * b1[1]];
        lattice = rnd() < 0.3 ? { b1: b2, b2: b1 } : { b1, b2 };
      }
      const b = basisOf(family, lattice);
      const poses = Array.from({ length: P }, (): [number, number, number] => {
        const [u, v] = [rnd(), rnd()];
        return [u * b.b1[0] + v * b.b2[0], u * b.b1[1] + v * b.b2[1], 20 * (rnd() - 0.5)];
      });
      add(kind, family, N, { lattice, poses });
    }
  }

// ---- grids: many pieces that do not overlap, on a square torus and on its free forms -------------
for (const N of [0, 3, 4, 5, 6, 7, 12, 37, 100])
  for (const [cols, rows] of [[10, 10], [25, 10], [25, 20]]) {
    const R = boundingRadius(N);
    // spacing: the bounding disks touch exactly, or clear by a little; squares and disks also edge to edge
    for (const spacing of N === 4 ? [1, 2 * R * (1 + 1e-7)] : N === 0 ? [1, 1 + 1e-10] : [2 * R, 2 * R * (1 + 1e-7)]) {
      const theta = N === 4 && spacing === 1 ? Math.PI / 4 : 0.3;
      const poses = Array.from({ length: cols * rows }, (_, k): [number, number, number] => [(k % cols) * spacing, Math.floor(k / cols) * spacing, theta]);
      const b: { b1: V2; b2: V2 } = { b1: [cols * spacing, 0], b2: [0, rows * spacing] };
      if (cols === rows) add("grid", "sq", N, { lattice: { L: cols * spacing }, poses });
      add("grid", "free", N, { lattice: b, poses });
      add("grid", "free", N, { lattice: { b1: b.b2, b2: [b.b1[0] + b.b2[0], b.b1[1] + b.b2[1]] }, poses });
    }
  }

// ---- pieces at the tolerances: a gap that is a chosen number --------------------------------------
for (const gap of [0, 1e-12, -1e-12, -0.999e-11, -1.001e-11, -0.999e-9, -1.001e-9, -0.999e-7, 0.999e-7, 1.001e-7, -1e-6, 1e-6, -0.3]) {
  for (const family of ["sq", "hex"] as TorusFamily[]) {
    // two disks, and two squares edge to edge, in a torus much larger than they are
    add("gap", family, 0, { lattice: { L: 5 }, poses: [[0.25, 0.5, 0], [1.25 + gap, 0.5, 1]] });
    add("gap", family, 4, { lattice: { L: 5 }, poses: [[0.25, 0.5, Math.PI / 4], [1.25 + gap, 0.5, Math.PI / 4]] });
    // one piece and its own translate: the torus is one piece wide
    add("gap-own-translate", family, 0, { lattice: { L: 1 + gap }, poses: [[0.1, 0.2, 0]] });
    if (family === "sq") add("gap-own-translate", family, 4, { lattice: { L: 1 + gap }, poses: [[0.1, 0.2, Math.PI / 4]] });
  }
  add("gap-own-translate", "free", 6, { lattice: { b1: [Math.sqrt(3) + gap, 0], b2: [(Math.sqrt(3) + gap) / 2, ((Math.sqrt(3) + gap) * Math.sqrt(3)) / 2] }, poses: [[0, 0, 0]] });
}

// ---- the reference ------------------------------------------------------------------------------
const packingOf = (c: Case) => ({ family: c.family, N: c.N, lattice: latticeOf(c.family, c.lattice), poses: c.poses.map(([x, y, theta]) => ({ x, y, theta })) });
/** check() of packages/spaces/src/validate.ts, case "torus" (the function is not exported; this copy is verified below). */
function* check(c: Case, tol: number): Generator<void, string[]> {
  const { family, N } = c;
  const lattice = latticeOf(family, c.lattice);
  const shortest = gaussReduce(lattice).lattice.b1;
  const width = 2 * pieceInradius(N);
  const len = Math.hypot(shortest[0], shortest[1]);
  if (len < width - tol)
    return [
      `the lattice has a vector of length ${len}, shorter than the piece's width ${width}: every piece overlaps its own translate`,
    ];
  const reachR = 2 * boundingRadius(N) + 2 * 1e-7;
  const translates = maxImageCandidates(lattice, reachR);
  if (!(translates <= TORUS_MAX_TRANSLATES))
    return [
      `the lattice basis is too skewed: up to ${translates} translates per pair would need checking (at most ${TORUS_MAX_TRANSLATES}); send a Lagrange-Gauss reduced basis`,
    ];
  const v = yield* validationSteps(
    { family, N, lattice, poses: c.poses.map(([x, y, theta]) => ({ x, y, theta })) },
    { tol, maxErrors: MAX_REASONS },
  );
  if (v.valid && !v.errors.length) return [];
  if (v.errors.length) {
    const list = v.errors.slice(0, MAX_REASONS);
    return list.length ? list : [""];
  }
  return v.overlaps
    .slice(0, MAX_REASONS)
    .map((o) =>
      o.i === o.j
        ? `piece ${o.i} overlaps its own translate by (${o.m}, ${o.n}) lattice vectors, by ${-o.sep}`
        : `pieces ${o.i} and ${o.j} overlap (translate (${o.m}, ${o.n})) by ${-o.sep}`,
    );
}
/** reducedSpaceConfig() of packages/spaces/src/validate.ts, its lattice (not exported; verified below): null = kept as sent. */
function reducedLattice(sent: { b1: V2; b2: V2 }): { b1: V2; b2: V2 } | null {
  const det0 = sent.b1[0] * sent.b2[1] - sent.b1[1] * sent.b2[0];
  const { b1, b2: r2 } = gaussReduce({ b1: sent.b1, b2: sent.b2 }).lattice;
  const b2: V2 = b1[0] * r2[1] - b1[1] * r2[0] < 0 ? [-r2[0], -r2[1]] : [r2[0], r2[1]];
  const length2 = (u: readonly number[], v: readonly number[]) => u[0] ** 2 + u[1] ** 2 + v[0] ** 2 + v[1] ** 2;
  if (det0 > 0 && length2(b1, b2) >= length2(sent.b1, sent.b2) * (1 - 1e-12)) return null;
  return { b1: [b1[0], b1[1]], b2 };
}
const contact = (c: { i: number; j: number; m: number; n: number; sep: number }) => [c.i, c.j, c.m, c.n, c.sep];
const resultJson = (v: TorusValidation) => ({
  valid: v.valid,
  minSep: v.minSep,
  overlaps: v.overlaps.map(contact),
  contacts: v.contacts.map(contact),
  pairsChecked: v.pairsChecked,
  score: v.score,
  density: v.density,
  errors: v.errors,
});

/**
 * The result with no options is asked of cases of at most 60 pieces whose enumeration is small (or
 * so large that latticeImages throws at once): without `maxErrors` nothing stops a check that finds
 * a million overlapping translates per pair. The Rust example applies the same rule.
 */
function wantsV0(c: Case): boolean {
  const P = c.poses.length;
  if (P > 60) return false;
  const candidates = maxImageCandidates(latticeOf(c.family, c.lattice), 2 * boundingRadius(c.N) + 2e-7);
  return !(candidates * P * (P + 1) > 4e6) || candidates > 1e7;
}
const ref: string[] = [];
let verified = 0;
const stored = { reduced: 0, kept: 0, refused: 0 };
for (const c of cases) {
  const at = (tol: number) => runSteps(validationSteps(packingOf(c), { tol, maxErrors: MAX_REASONS }));
  const r9 = runSteps(check(c, 1e-9));
  const r11 = runSteps(check(c, 1e-11));
  const line: Record<string, unknown> = { id: c.id, t9: resultJson(at(1e-9)), t11: resultJson(at(1e-11)), r9, r11 };
  if (wantsV0(c)) line.v0 = resultJson(runSteps(validationSteps(packingOf(c))));
  // The copy of check() above against the server's own rule, where the server's parser takes the
  // case: with `noRecord` the server runs the check at 1e-9 and, when that passes, at 1e-11.
  const P = c.poses.length;
  if (NS.includes(c.N) && P >= 1 && P <= 500) {
    const id = `torus/${c.family}/${c.N}/${P}`;
    const raw = JSON.parse(JSON.stringify({ lattice: c.lattice, poses: c.poses }));
    const sv = validateSpaceSubmission("torus", id, raw, { noRecord: true });
    if (sv.config !== null) {
      const expected = r9.length ? r9 : r11.length ? [SPACE_STRICT_NO_RECORD_REASON, ...r11.slice(0, 3)] : [];
      if (JSON.stringify(sv.reasons) !== JSON.stringify(expected) || sv.valid !== (expected.length === 0))
        throw new Error(`case ${c.id}: check() here and the server's differ: ${JSON.stringify(sv.reasons)} / ${JSON.stringify(expected)}`);
      verified++;
      // the basis the server stores for an accepted free torus: reducedLattice() above, when it passes again
      if (c.family === "free" && !r9.length && "b1" in c.lattice) {
        const kept = storedSpaceConfig("torus", id, raw, {}, sv.score ?? undefined) as unknown as Config;
        const mine = reducedLattice(c.lattice);
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
        if (mine === null) {
          if (!same(kept.lattice, c.lattice)) throw new Error(`case ${c.id}: the server stored another basis than the one sent`);
          stored.kept++;
        } else if (same(kept.lattice, mine)) stored.reduced++;
        else if (same(kept.lattice, c.lattice)) stored.refused++;
        else throw new Error(`case ${c.id}: the server stored a basis that is neither the one sent nor reducedLattice()'s`);
      }
    }
  }
  ref.push(JSON.stringify(line, enc));
}
writeFileSync(`${outDir}/cases.jsonl`, cases.map((c) => JSON.stringify(c, enc)).join("\n") + "\n");
writeFileSync(`${outDir}/ref.jsonl`, ref.join("\n") + "\n");

// ---- the package's other functions on their own inputs -------------------------------------------
type Aux = { id: number; fn: string; [k: string]: unknown };
const aux: Aux[] = [];
const auxRef: string[] = [];
const auxAdd = (a: Omit<Aux, "id">, result: unknown) => {
  aux.push(JSON.parse(JSON.stringify({ id: aux.length, ...a }, enc)) as Aux);
  auxRef.push(JSON.stringify({ id: aux.length - 1, result }, enc));
};
// the domain's bound (packages/spaces/src/piece-domains.ts): areaScoreBound(family, N, P), every problem of the domain
for (const family of FAMILIES)
  for (const N of NS) auxAdd({ fn: "areaScoreBound", family, N }, Array.from({ length: 500 }, (_, i) => areaScoreBound(family, N, i + 1)));
// the radii and the area the server's check and the validator take from packages/geometry
auxAdd({ fn: "radii" }, NS.map((N) => [pieceInradius(N), boundingRadius(N), pieceArea(N)]));
// lattices: those of the cases, and random ones (reduced, skewed up to 1e9 times, left-handed,
// nearly degenerate, tiny, huge, with a zero vector)
const lattices: Lattice[] = [];
for (const c of cases) if (c.id % 3 === 0 && "b1" in c.lattice) lattices.push({ b1: c.lattice.b1, b2: c.lattice.b2 });
for (let k = 0; k < 1500; k++) {
  const size = 10 ** (k % 10 === 0 ? 12 * rnd() - 6 : 1.5 * rnd());
  const phi = 2 * Math.PI * rnd();
  const ang = k % 7 === 0 ? 10 ** (-12 * rnd()) : Math.PI / 3 + (Math.PI / 3) * rnd();
  const [l1, l2] = [size, size * (0.5 + 2 * rnd())];
  const skew = k % 3 === 0 ? 0 : Math.round((rnd() - 0.5) * 10 ** (1 + 8 * rnd()));
  const b1: V2 = [l1 * Math.cos(phi), l1 * Math.sin(phi)];
  const b2: V2 = [l2 * Math.cos(phi + ang) + skew * b1[0], l2 * Math.sin(phi + ang) + skew * b1[1]];
  lattices.push(k % 4 === 0 ? { b1: b2, b2: b1 } : { b1, b2 });
}
lattices.push({ b1: [0, 0], b2: [1, 0] }, { b1: [1, 0], b2: [0, 0] }, { b1: [0, 0], b2: [0, 0] }, { b1: [1, 0], b2: [1, 0] }, { b1: [1, 2], b2: [-2, -4] }, { b1: [1e-200, 0], b2: [0, 1e-200] }, { b1: [1e160, 0], b2: [1e160, 1e160] }, { b1: [1, 0], b2: [1e17, 1] }, { b1: [3, 0], b2: [1.5, 1] }, { b1: [2, 0], b2: [1, 5] }, { b1: [2, 0], b2: [-1, 5] });
lattices.forEach((l, k) => {
  const N = NS[k % NS.length];
  const reach = 2 * boundingRadius(N) + 2 * 1e-7;
  const g = gaussReduce(l);
  auxAdd({ fn: "lattice", l, N, reach }, {
    gaussReduce: { lattice: g.lattice, M: g.M },
    maxImageCandidates: maxImageCandidates(l, reach),
    score: FAMILIES.map((f) => torusScore(f, l)),
    reduced: reducedLattice({ b1: [l.b1[0], l.b1[1]], b2: [l.b2[0], l.b2[1]] }),
  });
});
// latticeImages: the translates within reach of a displacement, or the error it throws
for (let k = 0; k < 600; k++) {
  const l = lattices[Math.floor(rnd() * lattices.length)];
  const N = NS[k % NS.length];
  const reach = (2 * boundingRadius(N) + 2e-7) * (k % 5 === 0 ? 3 : 1);
  const d: V2 = [(rnd() - 0.5) * 10 ** (3 * rnd()), (rnd() - 0.5) * 10 ** (3 * rnd())];
  const half = k % 3 === 0;
  let result: unknown;
  // candidates beyond a million throw at once; below, the loop is run (at most a million steps)
  try {
    result = latticeImages(l, half ? [0, 0] : d, reach, half).map((im) => [im.m, im.n, im.v[0], im.v[1]]);
  } catch (e) {
    result = { error: (e as Error).message };
  }
  auxAdd({ fn: "latticeImages", l, d: half ? [0, 0] : d, reach, half }, result);
}
// separationOf: two pieces near each other, angles up to 1e4
for (let k = 0; k < 3000; k++) {
  const N = k < 600 ? [0, 3, 4, 5, 6, 8][k % 6] : NS[k % NS.length];
  const R = boundingRadius(N);
  const dist = 2 * pieceInradius(N) * (0.2 + rnd()) + (k % 4 === 0 ? 2 * (R - pieceInradius(N)) * rnd() : 0);
  const dir = 2 * Math.PI * rnd();
  const big = k % 9 === 0 ? 1e4 : 4;
  const a = { x: k % 2 ? 0 : 100 * (rnd() - 0.5), y: k % 2 ? 0 : 100 * (rnd() - 0.5), theta: big * (rnd() - 0.5) };
  const b = { x: a.x + dist * Math.cos(dir), y: a.y + dist * Math.sin(dir), theta: big * (rnd() - 0.5) };
  const scale = k % 11 === 0 ? 1 - 10 ** (-12 * rnd()) : 1;
  auxAdd({ fn: "separationOf", N, a, b, scale }, separationOf(N, a, b, scale));
}
// the validator's other options (the server passes none of them): scale, contactTol, diskRadius, and maxErrors of a few
const OPTIONS: Record<string, number>[] = [
  { scale: 1 - 1e-9 }, { scale: 0.5 }, { scale: 0 }, { scale: 1.5 }, { scale: NaN }, { scale: -1 }, { scale: 1 },
  { contactTol: 1e-3 }, { contactTol: 0 }, { tol: 1e-6, contactTol: 1e-12 }, { tol: 0 }, { tol: 1e-3 },
  { diskRadius: 1 }, { diskRadius: 0.25, scale: 0.9 }, { maxErrors: 0 }, { maxErrors: 1 }, { maxErrors: 3, tol: 1e-11 }, { maxErrors: 2.5 },
];
cases
  .filter((c) => c.poses.length >= 1 && c.poses.length <= 40 && wantsV0(c) && c.id % 7 === 0)
  .forEach((c, k) => {
    const opts = OPTIONS[k % OPTIONS.length];
    auxAdd({ fn: "validateWith", family: c.family, N: c.N, lattice: c.lattice, poses: c.poses, opts }, resultJson(runSteps(validationSteps(packingOf(c), opts))));
  });
writeFileSync(`${outDir}/aux-cases.jsonl`, aux.map((a) => JSON.stringify(a, enc)).join("\n") + "\n");
writeFileSync(`${outDir}/aux-ref.jsonl`, auxRef.join("\n") + "\n");

// ---- fixtures for `cargo test`: a few cases of every kind, small ---------------------------------
if (fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true });
  const taken = new Map<string, number>();
  const pick: number[] = [];
  for (const c of cases) {
    const big = c.poses.length > 8 || ref[c.id].length > 6000;
    const kind = `${c.kind}/${c.family}`;
    const n = taken.get(kind) ?? 0;
    if (big || n >= (c.kind.startsWith("malformed") || c.kind.startsWith("gap") ? 1 : 2)) continue;
    taken.set(kind, n + 1);
    pick.push(c.id);
  }
  // the tolerance cases, one of each gap
  for (const c of cases) if (c.kind.startsWith("gap") && c.family === "sq" && !pick.includes(c.id)) pick.push(c.id);
  pick.sort((a, b) => a - b);
  writeFileSync(`${fixturesDir}/cases.jsonl`, pick.map((i) => JSON.stringify(cases[i], enc)).join("\n") + "\n");
  writeFileSync(`${fixturesDir}/ref.jsonl`, pick.map((i) => ref[i]).join("\n") + "\n");
  const counts = new Map<string, number>();
  const auxPick = aux
    .filter((a) => {
      const n = counts.get(a.fn) ?? 0;
      counts.set(a.fn, n + 1);
      if (a.fn === "areaScoreBound") return [0, 3, 4, 7, 100].includes(a.N as number);
      if (a.fn === "radii") return true;
      if (a.fn === "lattice") return n % 40 === 0 || n >= lattices.length - 11;
      if (a.fn === "latticeImages") return n % 25 === 0 && auxRef[a.id].length < 4000;
      if (a.fn === "validateWith") return n < 2 * OPTIONS.length && auxRef[a.id].length < 3000;
      return n % 60 === 0;
    })
    .map((a) => a.id);
  writeFileSync(`${fixturesDir}/aux-cases.jsonl`, auxPick.map((i) => JSON.stringify(aux[i], enc)).join("\n") + "\n");
  writeFileSync(`${fixturesDir}/aux-ref.jsonl`, auxPick.map((i) => auxRef[i]).join("\n") + "\n");
  console.log(`fixtures: ${pick.length} cases, ${auxPick.length} auxiliary`);
}

// ---- timing: check() as the server calls it at 1e-9, best of five passes per case -----------------
const best = new Float64Array(cases.length).fill(Infinity);
for (let pass = 0; pass < (noTimes ? 0 : 5); pass++)
  for (let i = 0; i < cases.length; i++) {
    const t = process.hrtime.bigint();
    runSteps(check(cases[i], 1e-9));
    const d = Number(process.hrtime.bigint() - t);
    if (d < best[i]) best[i] = d;
  }
if (!noTimes) writeFileSync(`${outDir}/ts-times.json`, JSON.stringify(Array.from(best)));
const kinds = new Map<string, number>();
for (const c of cases) {
  const k = c.kind.replace(/^malformed-.*/, "malformed");
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
}
console.log(`${cases.length} cases (${real.length} real), ${aux.length} auxiliary; check() verified against validateSpaceSubmission on ${verified}`);
console.log(`stored basis (storedSpaceConfig) against reducedLattice(): ${stored.reduced} stored reduced, ${stored.kept} kept as sent, ${stored.refused} kept because the reduced form did not pass again`);
console.log([...kinds].map(([k, n]) => `${k} ${n}`).join(", "));
