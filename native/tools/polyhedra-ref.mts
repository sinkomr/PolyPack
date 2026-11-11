// Cases for the comparison of native/polyhedra (Rust) with packages/polyhedra (TypeScript), and the TypeScript's
// verdicts and timings for them (native/PORTING.md, "Comparing a port with its source").
//
//   node --import tsx native/tools/polyhedra-ref.mts OUTDIR [--snapshot space-polyhedra.json.gz]
//        [--fixtures native/polyhedra/tests/fixtures] [--light]
//   cargo run --release -p polypack-polyhedra --example polyhedradiff -- OUTDIR
//   node native/tools/polyhedra-compare.mjs OUTDIR
//
// OUTDIR gets
//   cases.jsonl      one case per line: {id, kind, code, P, raw}; raw is the configuration as submitted (any JSON)
//   index.jsonl      {id, kind, code, P, n} without the configuration, for the comparison's tables
//   ref.jsonl        the TypeScript's answer for each case (the format is `answer` below)
//   ts-times.json    best of five timings of validatePolyhedra at tol 1e-9 per case, in ns (null: did not parse)
//   catalogue-ref.jsonl  the names, solids, domain and bounds, one {k, v} per line
//
// For each case the server's two calls are made: parsePolyhedraConfig(raw, P, 20), and validatePolyhedra(problem,
// raw, {tol, maxErrors: 20}) at tol 1e-9 and 1e-11 (on the raw value: the validator checks the form itself, and a
// configuration with a wrong number of pieces is still checked).
//
// Kinds of cases:
//   record         research records (data/polyhedra/configs/<code>.jsonl): every one of the 150 codes, a spread of P
//   site           leading entries of the site (the nightly snapshot): one per code and every one with P > 200
//   mutants of both (two per record, one per site entry, in rotation): overlap, shrink-* (s smaller by 1e-10, 3e-9, 1e-6 relative),
//                  squeeze-* (centres drawn in by the same), outside, count-less, count-more, q-scale, q-negate,
//                  permute, jitter-1e-9, jitter-1e-7, crowd (more than 20 overlaps), tiny-s (every piece outside)
//   malformed      every error of the form, on three real configurations
//   random         random poses in a container near the volume bound (mostly overlaps and protrusions)
//   grid           a jittered grid of randomly turned pieces at a spacing near the circumscribed diameter
//   contact        a grid of equally turned pieces whose bounding boxes are a gap g apart, g around the tolerance
//   pair           every ordered pair of the 186 solids (34,596 codes), two to four pieces each
//   replica-500    a research record of 100 pieces repeated five times in a larger container (P = 500, valid)
//   contact-500    500 large solids in a grid 1e-9 apart or 5e-10 into each other (the heaviest check there is)
import { createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  PAIR_COUNT,
  PROBLEM_CODES,
  PROBLEM_NAMES,
  PROBLEM_ORDER,
  SOLIDS_BY_GROUP,
  SOLID_GROUPS,
  SOLID_NAMES_LIST,
  pairCode,
  pluralTitle,
  problemNameOf,
  problemTitle,
} from "../../packages/polyhedra/src/catalogue.ts";
import { JOHNSON_SOLID_NAMES, SOLID_NAMES, getSolid, isSolidName, solidNameOfCode } from "../../packages/polyhedra/src/solids.ts";
import { getProblem, volumeBound } from "../../packages/polyhedra/src/problems.ts";
import { place } from "../../packages/polyhedra/src/geom.ts";
import {
  POLYHEDRA_MAX_COORD,
  POLYHEDRA_MAX_QUATERNION,
  POLYHEDRA_MAX_SIZE,
  POLYHEDRA_MIN_QUATERNION_NORM,
  POLYHEDRA_TOL,
  configErrors,
  validatePolyhedra,
} from "../../packages/polyhedra/src/validate.ts";
import { parsePolyhedraConfig } from "../../packages/polyhedra/src/records.ts";
import { POLYHEDRA_MAX_P, POLYHEDRA_RECORD_MARGIN } from "../../packages/polyhedra/src/info.ts";
import { polyhedraDomain } from "../../packages/polyhedra/src/domain.ts";

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) throw new Error("usage: polyhedra-ref.mts OUTDIR [--snapshot file.json.gz] [--fixtures DIR] [--light]");
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const snapshot = opt("--snapshot");
const fixturesDir = opt("--fixtures");
/** --light: a tenth of the real cases and none of the heavy ones, for a quick run. */
const light = args.includes("--light");
const repo = fileURLToPath(new URL("../../", import.meta.url));
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// deterministic random numbers (mulberry32)
let state = 20261110;
const random = (): number => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const uniform = (a: number, b: number) => a + (b - a) * random();
function pick<T>(list: readonly T[]): T {
  return list[Math.floor(random() * list.length)];
}
const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
const randomQuat = (): number[] => [gauss(), gauss(), gauss(), gauss()];
/** FNV-1a (32 bits) of a text's UTF-8 bytes, as 8 hex digits. */
export function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, "utf8")) h = Math.imul(h ^ b, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
/** A number as the text JavaScript prints, so that both sides write the same bytes ("Infinity" too). */
const N = (x: number): string => String(x);

// ---------------------------------------------------------------------------------------------------------------
// the answer for one case
type Raw = unknown;
interface Case {
  id: number;
  kind: string;
  code: string;
  P: number;
  raw: Raw;
}

const TOLS = [1e-9, 1e-11];

function answer(c: Case): Record<string, unknown> {
  const problem = getProblem(c.code);
  if (!problem) return { id: c.id, problem: null };
  const p = parsePolyhedraConfig(c.raw, c.P, 20);
  const parse = p.ok
    ? { ok: true, score: N(p.score), n: p.config.pieces.length, echo: fnv(JSON.stringify(p.config)) }
    : { ok: false, malformed: p.malformed, errors: p.errors };
  const v = TOLS.map((tol) => {
    try {
      const r = validatePolyhedra(problem, c.raw as never, { tol, maxErrors: 20 });
      return {
        tol: N(tol),
        valid: r.valid,
        errors: r.errors,
        minWallGap: N(r.minWallGap),
        minPairSep: N(r.minPairSep),
        worstPair: r.worstPair,
        pairsTested: r.pairsTested,
      };
    } catch (e) {
      return { tol: N(tol), threw: e instanceof Error ? e.message : String(e) };
    }
  });
  return { id: c.id, parse, v };
}

/** Best of five of validatePolyhedra at 1e-9 on the parsed configuration, in ns; null when it does not parse. */
function timing(c: Case): number | null {
  const problem = getProblem(c.code);
  if (!problem) return null;
  const p = parsePolyhedraConfig(c.raw, c.P, 20);
  if (!p.ok) return null;
  let best = Infinity;
  let sink = 0;
  for (let k = 0; k < 5; k++) {
    const t = process.hrtime.bigint();
    const r = validatePolyhedra(problem, p.config, { tol: 1e-9, maxErrors: 20 });
    const d = Number(process.hrtime.bigint() - t);
    sink += r.errors.length;
    if (d < best) best = d;
  }
  if (sink < 0) throw new Error("unreachable");
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// output
const casesOut = createWriteStream(`${outDir}/cases.jsonl`);
const indexOut = createWriteStream(`${outDir}/index.jsonl`);
const refOut = createWriteStream(`${outDir}/ref.jsonl`);
const times: (number | null)[] = [];
const kinds = new Map<string, number>();
/** Fixture candidates: up to three small cases of each kind. */
const fixtures: { c: Case; a: string }[] = [];
const fixtureCount = new Map<string, number>();
let nextId = 0;
let pending: Promise<void> = Promise.resolve();

const draining = new Set<unknown>();
/** Writes a line; when the stream's buffer is full, `pending` resolves once it has drained (awaited between cases). */
function write(stream: ReturnType<typeof createWriteStream>, text: string): void {
  if (stream.write(text) || draining.has(stream)) return;
  draining.add(stream);
  const before = pending;
  pending = new Promise((resolve) =>
    stream.once("drain", () => {
      draining.delete(stream);
      void before.then(resolve);
    }),
  );
}

function emit(kind: string, code: string, P: number, raw: Raw): void {
  const c: Case = { id: nextId++, kind, code, P, raw };
  const n = Array.isArray((raw as { pieces?: unknown } | null)?.pieces) ? (raw as { pieces: unknown[] }).pieces.length : null;
  const a = JSON.stringify(answer(c));
  write(casesOut, `${JSON.stringify(c)}\n`);
  write(indexOut, `${JSON.stringify({ id: c.id, kind, code, P, n })}\n`);
  write(refOut, `${a}\n`);
  times.push(timing(c));
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  const small = n === null || n <= 12;
  const cap = kind === "malformed" ? 100 : 3;
  if (fixturesDir && small && (fixtureCount.get(kind) ?? 0) < cap && kind !== "pair") {
    fixtureCount.set(kind, (fixtureCount.get(kind) ?? 0) + 1);
    fixtures.push({ c, a });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// mutants of a real configuration
interface Config {
  s: number;
  pieces: number[][];
}
const copy = (c: Config): Config => ({ s: c.s, pieces: c.pieces.map((p) => [...p]) });

const MUTANTS: [string, (c: Config, code: string) => { config: Config; P?: number } | null][] = [
  [
    "overlap",
    (c) => {
      if (c.pieces.length < 2) return null;
      const m = copy(c);
      m.pieces[1][0] = m.pieces[0][0] + 0.01;
      m.pieces[1][1] = m.pieces[0][1];
      m.pieces[1][2] = m.pieces[0][2];
      return { config: m };
    },
  ],
  ["shrink-1e-10", (c) => ({ config: { ...copy(c), s: c.s * (1 - 1e-10) } })],
  ["shrink-3e-9", (c) => ({ config: { ...copy(c), s: c.s * (1 - 3e-9) } })],
  ["shrink-1e-6", (c) => ({ config: { ...copy(c), s: c.s * (1 - 1e-6) } })],
  ...([[1e-10, "1e-10"], [3e-9, "3e-9"], [1e-6, "1e-6"]] as [number, string][]).map(
    ([d, name]): [string, (c: Config) => { config: Config }] => [
      `squeeze-${name}`,
      (c) => {
        const m = copy(c);
        for (const p of m.pieces) for (let k = 0; k < 3; k++) p[k] *= 1 - d;
        return { config: m };
      },
    ],
  ),
  [
    "outside",
    (c, code) => {
      const C = getSolid(getProblem(code)!.container);
      const m = copy(c);
      const k = Math.floor(random() * m.pieces.length);
      m.pieces[k][0] = c.s * C.circumradius * 1.2;
      return { config: m };
    },
  ],
  ["count-less", (c) => (c.pieces.length < 2 ? null : { config: { s: c.s, pieces: c.pieces.slice(0, -1).map((p) => [...p]) }, P: c.pieces.length })],
  ["count-more", (c) => ({ config: { s: c.s, pieces: [...c.pieces.map((p) => [...p]), [...c.pieces[0]]] }, P: c.pieces.length })],
  [
    "q-scale",
    (c) => {
      const m = copy(c);
      for (const p of m.pieces) {
        const f = pick([1e-5, 3e-3, 0.5, 7, 1e6, 1e40, 3e90]) * uniform(0.5, 2);
        // keep the components inside the limits: at most 1e100, norm at least 1e-6
        const big = Math.max(...p.slice(3).map(Math.abs));
        const g = big * f > 1e99 || Math.hypot(p[3], p[4], p[5], p[6]) * f < 1e-5 ? 1 : f;
        for (let k = 3; k < 7; k++) p[k] *= g;
      }
      return { config: m };
    },
  ],
  [
    "q-negate",
    (c) => {
      const m = copy(c);
      for (const p of m.pieces) for (let k = 3; k < 7; k++) p[k] = -p[k];
      return { config: m };
    },
  ],
  [
    "permute",
    (c) => {
      const m = copy(c);
      for (let i = m.pieces.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [m.pieces[i], m.pieces[j]] = [m.pieces[j], m.pieces[i]];
      }
      return { config: m };
    },
  ],
  ...[1e-9, 1e-7].map(
    (d): [string, (c: Config) => { config: Config }] => [
      `jitter-${d}`,
      (c) => {
        const m = copy(c);
        for (const p of m.pieces) for (let k = 0; k < 3; k++) p[k] += d * uniform(-1, 1);
        return { config: m };
      },
    ],
  ),
  [
    "crowd",
    (c) => {
      const m = copy(c);
      for (const p of m.pieces) for (let k = 0; k < 3; k++) p[k] *= 0.9;
      return { config: m };
    },
  ],
  ["tiny-s", (c) => ({ config: { ...copy(c), s: c.s * 0.5 } })],
];

let realCount = 0;
/** A real configuration and one or two of its mutants (the kinds in rotation). */
function real(kind: string, code: string, P: number, config: Config, mutants = 2): void {
  emit(kind, code, P, config);
  const k = realCount++;
  for (const m of [k % MUTANTS.length, (k * 7 + 5) % MUTANTS.length].slice(0, mutants)) {
    const [name, make] = MUTANTS[m];
    const r = make(config, code);
    if (r) emit(name, code, r.P ?? P, r.config);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// malformed configurations: every answer of configErrors and parsePolyhedraConfig
function malformed(code: string, base: Config): void {
  const P = base.pieces.length;
  const withPiece = (i: number, piece: unknown): unknown => ({ s: base.s, pieces: base.pieces.map((p, k) => (k === i ? piece : p)) });
  const p0 = base.pieces[0];
  const set = (k: number, v: unknown) => p0.map((x, i) => (i === k ? v : x));
  const forms: unknown[] = [
    // not an object
    null, [], [base.s, base.pieces], 7, "config", true, false, "",
    // s
    { pieces: base.pieces },
    { s: null, pieces: base.pieces },
    { s: "2", pieces: base.pieces },
    { s: [2], pieces: base.pieces },
    { s: 0, pieces: base.pieces },
    { s: -0, pieces: base.pieces },
    { s: -1, pieces: base.pieces },
    { s: 1e-300, pieces: base.pieces },
    { s: POLYHEDRA_MAX_SIZE, pieces: base.pieces },
    { s: POLYHEDRA_MAX_SIZE * (1 + 2 ** -52), pieces: base.pieces },
    { s: 1e7, pieces: base.pieces },
    { s: 1e300, pieces: base.pieces },
    { s: true, pieces: base.pieces },
    // pieces
    { s: base.s },
    { s: base.s, pieces: null },
    { s: base.s, pieces: {} },
    { s: base.s, pieces: "pieces" },
    { s: base.s, pieces: 3 },
    { s: base.s, pieces: [] },
    { pieces: "x" },
    {},
    { s: "x", pieces: [1, 2, 3] },
    // one piece of the wrong form
    withPiece(0, null),
    withPiece(0, 5),
    withPiece(0, "pose"),
    withPiece(0, {}),
    withPiece(0, { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0, 5: 0, 6: 0, length: 7 }),
    withPiece(0, []),
    withPiece(0, p0.slice(0, 6)),
    withPiece(0, [...p0, 0]),
    withPiece(0, p0.slice(0, 3)),
    withPiece(P - 1, set(0, null)),
    withPiece(P - 1, set(3, "1")),
    withPiece(P - 1, set(6, true)),
    withPiece(P - 1, set(2, [0])),
    withPiece(P - 1, set(4, {})),
    // the centre's range
    withPiece(0, set(0, POLYHEDRA_MAX_COORD)),
    withPiece(0, set(1, -POLYHEDRA_MAX_COORD)),
    withPiece(0, set(0, POLYHEDRA_MAX_COORD * (1 + 2 ** -52))),
    withPiece(0, set(2, -10000.000000000002)),
    withPiece(0, set(1, 1e300)),
    // the quaternion's range and norm
    withPiece(0, set(3, POLYHEDRA_MAX_QUATERNION)),
    withPiece(0, set(4, -POLYHEDRA_MAX_QUATERNION)),
    withPiece(0, set(5, 1.0000000000000002e100)),
    withPiece(0, set(6, -1e200)),
    withPiece(0, [p0[0], p0[1], p0[2], 1e100, 1e100, 1e100, 1e100]),
    withPiece(0, [p0[0], p0[1], p0[2], 1e154, 0, 0, 0]),
    withPiece(0, [p0[0], p0[1], p0[2], 0, 0, 0, 0]),
    withPiece(0, [p0[0], p0[1], p0[2], -0, 0, -0, 0]),
    withPiece(0, [p0[0], p0[1], p0[2], POLYHEDRA_MIN_QUATERNION_NORM, 0, 0, 0]),
    withPiece(0, [p0[0], p0[1], p0[2], 0, 0, 0, -POLYHEDRA_MIN_QUATERNION_NORM]),
    withPiece(0, [p0[0], p0[1], p0[2], 9.999999999999999e-7, 0, 0, 0]),
    withPiece(0, [p0[0], p0[1], p0[2], 5e-7, 5e-7, 5e-7, 5e-7]),
    withPiece(0, [p0[0], p0[1], p0[2], 4.9e-7, 5e-7, 5e-7, 5e-7]),
    withPiece(0, [p0[0], p0[1], p0[2], 1e-200, 1e-200, 0, 0]),
    withPiece(0, [p0[0], p0[1], p0[2], 5e-324, 0, 0, 0]),
    withPiece(0, [p0[0], p0[1], p0[2], 3e-6, -4e-6, 0, 0]),
    withPiece(0, [p0[0], p0[1], p0[2], 3e99, 4e99, 0, 1e-300]),
    // the centre's fault hides the quaternion's (else if)
    withPiece(0, [1e5, 0, 0, 0, 0, 0, 0]),
    withPiece(0, [0, 0, 0, 1e101, 0, 0, 0]),
    // several faults, and more than twenty
    { s: -1, pieces: base.pieces.map((p, i) => (i % 2 ? p : null)) },
    { s: base.s, pieces: Array.from({ length: 30 }, () => [0, 0, 0, 0, 0, 0, 0]) },
    { s: base.s, pieces: Array.from({ length: 30 }, (_, i) => (i < 25 ? [0, 0, 0] : p0)) },
    { s: 0, pieces: Array.from({ length: 30 }, () => "x") },
    { s: base.s, pieces: Array.from({ length: 19 }, () => 1).concat(base.pieces as never) },
    // a wrong count is not malformed, and a fault of the form comes first
    { s: base.s, pieces: base.pieces.slice(1) },
    { s: base.s, pieces: [...base.pieces, p0] },
    { s: base.s, pieces: [...base.pieces.slice(1), null] },
    // more fields than the two, integers, exponents and numbers beyond 2^53
    { s: base.s, pieces: base.pieces, note: "x", P: 99, size: 1 },
    { pieces: base.pieces, s: base.s },
    { s: 3, pieces: base.pieces.map(() => [1, 2, 3, 1, 0, 0, 0]) },
    { s: 12345678901234567890, pieces: base.pieces },
    { s: 9007199254740993, pieces: base.pieces },
    { s: base.s, pieces: base.pieces.map((p) => [p[0], p[1], p[2], 123456789012345678901234567890, 1, -98765432109876543210, 3]) },
    { s: base.s, pieces: base.pieces.map((p) => [p[0], p[1], p[2], 4.9e48, -1.3e48, 2.2e47, 5e48]) },
    { s: base.s, pieces: base.pieces.map((p) => [p[0], p[1], p[2], 1e-5, 0, 0, 2e-6]) },
  ];
  for (const raw of forms) emit("malformed", code, P, raw);
  // the same pieces under a different P: only the count is wrong
  emit("malformed", code, P + 1, base);
  emit("malformed", code, 0, base);
  emit("malformed", code, 1, { s: base.s, pieces: [] });
  emit("malformed", code, 0, { s: base.s, pieces: [] });
}

// ---------------------------------------------------------------------------------------------------------------
// constructed configurations
const NAMES = SOLID_NAMES_LIST.map((s) => s.name);
const codeOf = (piece: string, container: string) => pairCode(piece, container)!;

/** Bounding box of a solid in a pose's rotation. */
function boxOf(name: string, q: number[]): { lo: number[]; hi: number[] } {
  const X = place(getSolid(name), [0, 0, 0, ...q]).X;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < X.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], X[i + k]);
      hi[k] = Math.max(hi[k], X[i + k]);
    }
  return { lo, hi };
}

/** The first n points of a cubic grid of step (dx, dy, dz), centred at the origin. */
function gridPoints(n: number, d: number[]): number[][] {
  const m = Math.ceil(Math.cbrt(n) - 1e-9);
  const out: number[][] = [];
  for (let i = 0; i < m && out.length < n; i++)
    for (let j = 0; j < m && out.length < n; j++)
      for (let k = 0; k < m && out.length < n; k++)
        out.push([(i - (m - 1) / 2) * d[0], (j - (m - 1) / 2) * d[1], (k - (m - 1) / 2) * d[2]]);
  return out;
}

/** A container scale that holds balls of radius `reach` about every centre, times `slack`. */
function holding(container: string, centres: number[][], reach: number, slack: number): number {
  let far = 0;
  for (const c of centres) far = Math.max(far, Math.hypot(c[0], c[1], c[2]));
  return ((far + reach) / getSolid(container).inradius) * slack;
}

function randomCase(): void {
  const piece = pick(NAMES);
  const container = pick(NAMES);
  const P = 2 + Math.floor(random() * 39);
  const problem = getProblem(codeOf(piece, container))!;
  const s = volumeBound(problem, P) * uniform(1, 2.5);
  const C = getSolid(container);
  const pieces = Array.from({ length: P }, () => {
    const r = s * C.inradius * 0.9;
    return [uniform(-r, r), uniform(-r, r), uniform(-r, r), ...randomQuat()];
  });
  emit("random", problem.code, P, { s, pieces });
}

function gridCase(): void {
  const piece = pick(NAMES);
  const container = pick(NAMES);
  const P = 2 + Math.floor(random() * 59);
  const S = getSolid(piece);
  const step = 2 * S.circumradius * uniform(0.55, 1.05);
  const sameTurn = random() < 0.3 ? randomQuat() : null;
  const centres = gridPoints(P, [step, step, step]).map((c) => c.map((x) => x + 0.02 * step * uniform(-1, 1)));
  const s = holding(container, centres, S.circumradius, uniform(0.97, 1.05));
  emit("grid", codeOf(piece, container), P, { s, pieces: centres.map((c) => [...c, ...(sameTurn ?? randomQuat())]) });
}

/** Equally turned pieces whose bounding boxes are `gap` apart along each axis. */
function contactConfig(piece: string, container: string, P: number, q: number[], gap: number): Config {
  const { lo, hi } = boxOf(piece, q);
  const centres = gridPoints(P, [hi[0] - lo[0] + gap, hi[1] - lo[1] + gap, hi[2] - lo[2] + gap]);
  const s = holding(container, centres, getSolid(piece).circumradius, 1.001);
  return { s, pieces: centres.map((c) => [...c, ...q]) };
}

const GAPS = [0, 1e-9, 1e-10, -5e-10, -3e-9, 1e-4, -1e-6, 2e-3];

/** Five copies of a configuration side by side along x, in a container large enough for them (see the header). */
function replica(code: string, c: Config): Config {
  const C = getSolid(getProblem(code)!.container);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < C.V.length; i += 3) {
    lo = Math.min(lo, C.V[i]);
    hi = Math.max(hi, C.V[i]);
  }
  // copies of s C a step apart are disjoint when the step is at least s times C's width along x; the copy moved
  // by t lies in k C when t is in (k - s) C, which holds the ball of radius (k - s) inradius
  const step = c.s * (hi - lo) * (1 + 1e-9);
  const k = c.s + (2 * step) / C.inradius;
  const pieces: number[][] = [];
  for (let m = -2; m <= 2; m++) for (const p of c.pieces) pieces.push([p[0] + m * step, ...p.slice(1)]);
  return { s: k * (1 + 1e-9), pieces };
}

// ---------------------------------------------------------------------------------------------------------------
// the cases
const readConfigs = (code: string): { P: number; config: Config }[] =>
  readFileSync(`${repo}data/polyhedra/configs/${code}.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

// research records: every code, P spread over 2 to 100
const recordCodes = readdirSync(`${repo}data/polyhedra/configs`).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).sort();
const SPREAD = [2, 3, 4, 5, 7, 9, 12, 16, 21, 28, 37, 50, 68, 84, 100];
const malformedBases: [string, Config][] = [];
for (const code of recordCodes) {
  const list = readConfigs(code);
  const want = new Set(light ? [2, 12, 100] : [...SPREAD, 2 + Math.floor(random() * 99), 2 + Math.floor(random() * 99)]);
  for (const r of list) {
    if (!want.has(r.P)) continue;
    real("record", code, r.P, r.config);
    if (r.P === 5 && ["cubintet", "tidintid", "tz7incub"].includes(code)) malformedBases.push([code, r.config]);
  }
  await pending;
}
for (const [code, base] of malformedBases) malformed(code, base);
console.log(`records and malformed: ${nextId} cases`);

// site entries: one per code (the one whose id hashes lowest among its entries of at most 200 pieces) and every
// entry of more than 200 pieces, each with one mutant
if (snapshot) {
  const chosen = new Map<string, { h: string; line: string }>();
  const large: string[] = [];
  let seen = 0;
  for await (const line of createInterface({ input: createReadStream(snapshot).pipe(createGunzip()), crlfDelay: Infinity })) {
    const m = /^\{"problem":"polyhedra\/([a-z0-9]+)\/(\d+)"/.exec(line);
    if (!m) continue;
    seen++;
    if (Number(m[2]) > 200) {
      large.push(line);
      continue;
    }
    const h = fnv(`${m[1]}/${m[2]}`);
    const have = chosen.get(m[1]);
    if (!have || h < have.h) chosen.set(m[1], { h, line });
  }
  const lines = [...[...chosen.values()].map((c) => c.line), ...large];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const r = JSON.parse(lines[i].trim().replace(/,$/, "")) as { problem: string; P: number; config: Config };
    if (light && (r.P > 200 || i % 10 !== 0)) continue;
    real("site", r.problem.split("/")[1], r.P, r.config, 1);
    used++;
    await pending;
  }
  console.log(`site: ${seen} entries in the snapshot, ${chosen.size} codes, ${large.length} of more than 200 pieces, ${used} used; ${nextId} cases`);
}

for (let i = 0; i < (light ? 150 : 1500); i++) randomCase();
for (let i = 0; i < (light ? 150 : 1500); i++) gridCase();
await pending;
// contact grids: every solid as the piece, twice (as it is and turned), the gaps in rotation
{
  let g = 0;
  for (const piece of NAMES) {
    for (const turned of [false, true]) {
      const container = pick(NAMES);
      const P = pick([8, 12, 27]);
      const gap = GAPS[g++ % GAPS.length];
      emit("contact", codeOf(piece, container), P, contactConfig(piece, container, P, turned ? randomQuat() : [1, 0, 0, 0], gap));
    }
  }
}
await pending;
// every ordered pair of solids: two to four pieces, alternately a contact grid and a tight jittered grid
{
  let k = 0;
  for (const piece of NAMES)
    for (const container of NAMES) {
      const P = 2 + (k % 3);
      const S = getSolid(piece);
      if (k % 2 === 0) {
        emit("pair", codeOf(piece, container), P, contactConfig(piece, container, P, k % 4 === 0 ? [1, 0, 0, 0] : randomQuat(), GAPS[(k >> 1) % GAPS.length]));
      } else {
        const step = 2 * S.inradius * uniform(0.9, 1.6);
        const centres = gridPoints(P, [step, step, step]);
        const s = holding(container, centres, S.circumradius, uniform(0.9, 1.05));
        emit("pair", codeOf(piece, container), P, { s, pieces: centres.map((c) => [...c, ...randomQuat()]) });
      }
      k++;
      if (k % 2000 === 0) await pending;
    }
}
console.log(`with the constructed cases: ${nextId} cases`);

// the heavy ones: 500 pieces
if (!light) {
  for (const code of ["cubincub", "tetintet", "octinoct", "dodindod", "icoinico", "tidintid", "sndinsnd", "ridinrid", "ticintic", "dtcindtc", "phcinphc", "dhcindhc", "pr12inpr12", "ap12incub", "tz12intz12", "bp12incub", "pr3l3incub", "kttinktt", "cubintet", "icoindod"]) {
    const r = readConfigs(code).find((x) => x.P === 100);
    if (!r) throw new Error(`no record of 100 pieces for ${code}`);
    const big = replica(code, r.config);
    emit("replica-500", code, 500, big);
    emit("replica-500", code, 500, { s: big.s, pieces: big.pieces.map((p) => p.map((x, i) => (i < 3 ? x * (1 - 3e-9) : x))) });
    await pending;
  }
  for (const piece of ["truncated_icosidodecahedron", "disdyakis_triacontahedron", "pentagonal_hexecontahedron", "snub_dodecahedron", "rhombicosidodecahedron", "truncated_icosahedron", "cube", "tetrahedron"]) {
    for (const gap of [1e-9, -5e-10]) {
      emit("contact-500", codeOf(piece, "cube"), 500, contactConfig(piece, "cube", 500, [1, 0, 0, 0], gap));
      await pending;
    }
  }
  emit("contact-500", "tidintid", 500, contactConfig("truncated_icosidodecahedron", "truncated_icosidodecahedron", 500, randomQuat(), 1e-9));
}

await pending;
await Promise.all([casesOut, indexOut, refOut].map((s) => new Promise((resolve) => s.end(resolve))));
writeFileSync(`${outDir}/ts-times.json`, JSON.stringify(times));

// ---------------------------------------------------------------------------------------------------------------
// the catalogue: names, solids, domain and bounds, one {k, v} per line; numbers as JavaScript prints them
const cat: string[] = [];
const put = (k: string, v: unknown) => cat.push(JSON.stringify({ k, v }));
const nameRow = (p: ReturnType<typeof problemNameOf>) => (p ? [p.code, p.piece, p.container, p.family, p.title, p.wiki] : null);
put("constants", {
  POLYHEDRA_TOL: N(POLYHEDRA_TOL),
  POLYHEDRA_MIN_QUATERNION_NORM: N(POLYHEDRA_MIN_QUATERNION_NORM),
  POLYHEDRA_MAX_COORD: N(POLYHEDRA_MAX_COORD),
  POLYHEDRA_MAX_QUATERNION: N(POLYHEDRA_MAX_QUATERNION),
  POLYHEDRA_MAX_SIZE: N(POLYHEDRA_MAX_SIZE),
  POLYHEDRA_MAX_P,
  POLYHEDRA_RECORD_MARGIN: N(POLYHEDRA_RECORD_MARGIN),
  PAIR_COUNT,
});
put("solid_names_list", SOLID_NAMES_LIST.map((s) => [s.name, s.code, s.family, s.title]));
put("solids_by_group", SOLIDS_BY_GROUP.map((s) => s.code));
put("solid_groups", SOLID_NAMES_LIST.map((s) => SOLID_GROUPS[s.family]));
put("plural_titles", SOLID_NAMES_LIST.map((s) => pluralTitle(s.title)));
put("problem_names", PROBLEM_NAMES.map(nameRow));
put("problem_codes", PROBLEM_CODES);
put("problem_order", PROBLEM_ORDER);
put("solid_names", SOLID_NAMES);
put("johnson_solid_names", JOHNSON_SOLID_NAMES);
// a line whose inputs are a list carries them in its key, as JSON after the first "/"
{
  const names = ["cube", "cub", "", "J1", "square_pyramid", "ball"];
  put(`is_solid_name/${JSON.stringify(names)}`, names.map((n) => isSolidName(n)));
  const codes = ["cub", "cube", "j92", "j93", "pr3l15", ""];
  put(`solid_name_of_code/${JSON.stringify(codes)}`, codes.map((c) => solidNameOfCode(c)));
}
for (const s of SOLID_NAMES_LIST) {
  const S = getSolid(s.name);
  const sum = (a: ArrayLike<number>) => {
    let t = 0;
    for (let i = 0; i < a.length; i++) t += a[i] * (1 + (i % 7));
    return t;
  };
  put(`solid/${s.name}`, {
    code: S.code,
    family: S.family,
    title: S.title,
    nv: S.nv,
    faces: S.faces.length,
    edges: S.edges.length,
    V: N(sum(S.V)),
    N: N(sum(S.N)),
    offsets: N(sum(S.offsets)),
    faceList: fnv(JSON.stringify(S.faces)),
    edgeList: fnv(JSON.stringify(S.edges)),
    edgeFaces: fnv(JSON.stringify(S.edgeFaces)),
    inradius: N(S.inradius),
    circumradius: N(S.circumradius),
    volume: N(S.volume),
    tangential: S.tangential,
    edgeMax: N(S.edgeMax),
  });
}
for (const piece of SOLID_NAMES_LIST) for (const container of SOLID_NAMES_LIST) put(`problem_name_of/${piece.code}in${container.code}`, nameRow(problemNameOf(`${piece.code}in${container.code}`)));
const BAD_CODES = ["", "in", "cubin", "incub", "cubinxyz", "CUBINCUB", "cubincubincub", "cubintetx", "xcubintet", "cub in tet", "éincub", "cubiné", "ballincub", "cubinball", "pr3l15inpr12l15", "pr12l15inpr12l15xxxxxxxxx", "pr11l15inpr11l15", "j01inj92", "j00inj01", "j1inj2", "inin", "ininin", "tetinin", "cubincub\n", "cubin cub", "cubintet/2", "__proto__", "constructor", "toString"];
for (const code of BAD_CODES) {
  put(`problem_name_of/${JSON.stringify(code)}`, nameRow(problemNameOf(code)));
  put(`problem_title/${JSON.stringify(code)}`, problemTitle(code));
}
{
  const pairs = [["cube", "tetrahedron"], ["cub", "tet"], ["square_pyramid", "prism3_l15"], ["cube", "ball"], ["", ""]];
  put(`pair_code/${JSON.stringify(pairs)}`, pairs.map(([a, b]) => pairCode(a, b)));
}
put("domain_info", JSON.stringify(polyhedraDomain.info));
{
  const codes = [...PROBLEM_CODES, "j01inj92", "j92incub", "tidinj05", "pkdintz7", "nope"];
  const Ps = [2, 3, 10, 99, 100, 101, 250, 499, 500, 501, 1, 0, -3, 2.5, 1e9];
  for (const code of codes)
    for (const P of Ps) {
      const b = polyhedraDomain.bound({ fields: { code }, P });
      put(`domain_bound/${code}/${P}`, b ? { value: N(b.value), label: b.label } : null);
    }
  // every pair's bound at one P, so that every solid's volume is read as the piece and as the container
  for (const piece of SOLID_NAMES_LIST)
    for (const container of SOLID_NAMES_LIST) {
      const code = `${piece.code}in${container.code}`;
      const P = 2 + ((piece.code.length * 31 + container.code.charCodeAt(1) * 7 + container.code.length) % 499);
      put(`volume_bound/${code}/${P}`, N(volumeBound(getProblem(code)!, P)));
    }
}
for (const limit of [0, 1, 2, 149, 150, 151, 1000, 59999, 60000, 100000]) {
  const ids = polyhedraDomain.sample(limit);
  put(`domain_sample/${limit}`, { length: ids.length, first: ids.slice(0, 3), last: ids.slice(-2), hash: fnv(ids.join(",")) });
}
// configErrors with a number of pieces (the balls family calls it so)
{
  const base = { s: 2, pieces: [[0, 0, 0, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0, 1]] };
  const forms: [unknown, number | undefined, number][] = [
    [base, 2, 20], [base, 3, 20], [base, undefined, 20], [base, 0, 20],
    [{ s: -1, pieces: [null, null, null] }, 2, 20], [{ s: -1, pieces: [null, null, null] }, 2, 2], [{ s: -1, pieces: [null, null, null] }, 2, 1],
    [{ s: 1, pieces: [null, null, null] }, 3, 2], [{ s: 1, pieces: 5 }, 3, 20], [null, 3, 20],
  ];
  for (const [raw, P, max] of forms) put(`config_errors/${JSON.stringify([raw, P ?? null, max])}`, configErrors(raw, P, max));
}
writeFileSync(`${outDir}/catalogue-ref.jsonl`, `${cat.join("\n")}\n`);

if (fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(`${fixturesDir}/cases.jsonl`, `${fixtures.map((f) => JSON.stringify(f.c)).join("\n")}\n`);
  writeFileSync(`${fixturesDir}/ref.jsonl`, `${fixtures.map((f) => f.a).join("\n")}\n`);
  // the catalogue without the bulk: one pair code in 211, one volume bound in 211 and one domain bound in 6
  let n = 0;
  let bounds = 0;
  const keep = cat.filter((line) => {
    const k = (JSON.parse(line) as { k: string }).k;
    if (/^(problem_name_of\/[a-z0-9]+in[a-z0-9]+$|volume_bound\/)/.test(k)) return n++ % 211 === 0;
    if (k.startsWith("domain_bound/")) return bounds++ % 6 === 0;
    return true;
  });
  writeFileSync(`${fixturesDir}/catalogue.jsonl`, `${keep.join("\n")}\n`);
  console.log(`fixtures: ${fixtures.length} cases and ${keep.length} catalogue lines in ${fixturesDir}`);
}

console.log(`${nextId} cases, ${cat.length} catalogue lines written to ${outDir}`);
console.log([...kinds].map(([k, n]) => `${k} ${n}`).join(", "));
