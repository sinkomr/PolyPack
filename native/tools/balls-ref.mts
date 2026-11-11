// Cases for the comparison of native/balls (Rust) with packages/balls (TypeScript), and the TypeScript's verdicts
// and timings for them (native/PORTING.md, "Comparing a port with its source").
//
//   node --import tsx native/tools/balls-ref.mts OUTDIR [--snapshot space-balls.json.gz]
//        [--fixtures native/balls/tests/fixtures] [--no-times]
//   cargo run --release -p polypack-balls --example ballsdiff -- OUTDIR
//   node native/tools/balls-compare.mjs OUTDIR
//
// OUTDIR gets cases.jsonl ({id, kind, code, P, raw}), index.jsonl (the same without the configuration), ref.jsonl
// (the TypeScript's answers), ts-times.json (best of five of validateBalls at tol 1e-9, ns) and
// catalogue-ref.jsonl (names, ids, containers, bounds and the domain, one {k, v} per line).
//
// For each case the server's calls are made: the parse of packages/spaces/src/validate.ts (parseBalls:
// ballsConfigErrors(problem, raw, undefined, 20), then the count of pieces), and validateBalls(problem, raw,
// {tol, maxErrors: 20}) at tol 1e-9 and 1e-11 (on the raw value: the validator checks the form itself).
//
// The family has no research records (docs/spaces/BALLS.md section 2: nothing of it is in data/), so the real
// packings are the site's leading entries. Kinds of cases:
//   site        every leading entry of the nightly snapshot (709 entries of 256 codes when this was written)
//   mutants     one per site entry, in rotation: overlap, shrink-* (s smaller by 1e-10, 3e-9, 1e-6 relative),
//               squeeze-* (centres drawn in by the same), outside, count-less, count-more, permute, jitter-1e-9,
//               jitter-1e-7, crowd (more than 20 overlaps), tiny-s (every piece outside), q-scale and q-negate
//   tight       for every one of the 373 codes: a grid of pieces a gap apart (the gaps around the tolerance) in the
//               smallest container that holds them, its size moved by nothing, +-1e-10, -3e-9 or +1e-6 relative
//   random      for every code: random pieces in a container near the lower bound (overlaps and protrusions)
//   malformed   every error of the form, on a configuration of balls and on one of solids
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import {
  BALLS_CODES,
  BALLS_CODES_HINT,
  BALLS_MAX_P,
  BALLS_MIN_P,
  BALLS_ORIGINAL_CODES,
  BALLS_PROBLEMS,
  BALL_DIAMETER,
  BALL_RADIUS,
  type BallsProblem,
  ballContainerRadius,
  ballContainerScore,
  ballsProblemOf,
  ballsTitle,
  formatBallsId,
  parseBallsId,
} from "../../packages/balls/src/catalogue.ts";
import { containerKind, containerOf } from "../../packages/balls/src/container.ts";
import { chebyshevOf, chebyshevRadius, enclosingOf, enclosingRadius } from "../../packages/balls/src/extent.ts";
import { ballsBound, ballsDomain, getBallsProblem, pieceVolume, pluralOf } from "../../packages/balls/src/problems.ts";
import {
  BALLS_MAX_COORD,
  BALLS_MAX_SIZE,
  BALLS_TOL,
  ballsConfigErrors,
  tightSize,
  validateBalls,
} from "../../packages/balls/src/validate.ts";
import { SOLID_NAMES_LIST } from "../../packages/polyhedra/src/catalogue.ts";
import { getSolid } from "../../packages/polyhedra/src/solids.ts";
import { place } from "../../packages/polyhedra/src/geom.ts";
import { parseSpaceId } from "../../packages/spaces/src/ids.ts";
import { parseSpaceConfig } from "../../packages/spaces/src/validate.ts";

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) throw new Error("usage: balls-ref.mts OUTDIR [--snapshot file.json.gz] [--fixtures DIR]");
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const snapshot = opt("--snapshot");
const fixturesDir = opt("--fixtures");
// --no-times: the timing passes are left out and ts-times.json is not written (for a run under emulation)
const noTimes = args.includes("--no-times");
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// deterministic random numbers (mulberry32)
let state = 20261111;
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
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, "utf8")) h = Math.imul(h ^ b, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
/** A number as the text JavaScript prints, so that both sides write the same bytes ("Infinity" too). */
const N = (x: number): string => String(x);

// ---------------------------------------------------------------------------------------------------------------
// the answer for one case
interface Case {
  id: number;
  kind: string;
  code: string;
  P: number;
  raw: unknown;
}
interface Config {
  s: number;
  pieces: number[][];
}
type Parsed = { ok: true; config: Config; score: number } | { ok: false; malformed: boolean; errors: string[] };

/**
 * packages/spaces/src/validate.ts: parseBalls (not exported), for a problem that exists: errors of form are
 * malformed input, except a wrong number of pieces. Checked below against parseSpaceConfig, which calls it.
 */
function parseBalls(problem: BallsProblem, raw: unknown, P: number): Parsed {
  const errors = ballsConfigErrors(problem, raw, undefined, 20);
  if (errors.length) return { ok: false, malformed: true, errors };
  const r = raw as { s: number; pieces: number[][] };
  if (!Array.isArray(r.pieces)) return { ok: false, malformed: true, errors: ["pieces must be an array"] };
  if (r.pieces.length !== P) return { ok: false, malformed: false, errors: [`expected ${P} pieces for this problem, got ${r.pieces.length}`] };
  const width = problem.piece === "ball" ? 3 : 7;
  return { ok: true, config: { s: r.s, pieces: r.pieces.map((p) => p.slice(0, width)) }, score: r.s };
}

const TOLS = [1e-9, 1e-11];
let serverChecks = 0;

function answer(c: Case): Record<string, unknown> {
  const problem = getBallsProblem(c.code);
  if (!problem) return { id: c.id, problem: null };
  const p = parseBalls(problem, c.raw, c.P);
  // the server's own entry, where it reaches parseBalls: an object, and an id it reads
  if (typeof c.raw === "object" && c.raw !== null && !Array.isArray(c.raw) && c.P >= 1 && c.P <= 9999) {
    const id = parseSpaceId("balls", `balls/${c.code}/${c.P}`);
    if (typeof id !== "string") {
      const server = parseSpaceConfig(id, c.raw);
      if (JSON.stringify(server) !== JSON.stringify(p)) throw new Error(`case ${c.id}: parseSpaceConfig says ${JSON.stringify(server).slice(0, 300)}, the tool's parseBalls ${JSON.stringify(p).slice(0, 300)}`);
      serverChecks++;
    }
  }
  const parse = p.ok
    ? { ok: true, score: N(p.score), n: p.config.pieces.length, echo: fnv(JSON.stringify(p.config)) }
    : { ok: false, malformed: p.malformed, errors: p.errors };
  const v = TOLS.map((tol) => {
    try {
      const r = validateBalls(problem, c.raw as never, { tol, maxErrors: 20 });
      return { tol: N(tol), valid: r.valid, errors: r.errors, minWallGap: N(r.minWallGap), minPairSep: N(r.minPairSep), worstPair: r.worstPair };
    } catch (e) {
      return { tol: N(tol), threw: e instanceof Error ? e.message : String(e) };
    }
  });
  return { id: c.id, parse, v };
}

/** Best of five of validateBalls at 1e-9 on the parsed configuration, in ns; null when it does not parse. */
function timing(c: Case): number | null {
  const problem = getBallsProblem(c.code);
  if (!problem) return null;
  const p = parseBalls(problem, c.raw, c.P);
  if (!p.ok) return null;
  let best = Infinity;
  let sink = 0;
  for (let k = 0; k < 5; k++) {
    const t = process.hrtime.bigint();
    const r = validateBalls(problem, p.config, { tol: 1e-9, maxErrors: 20 });
    const d = Number(process.hrtime.bigint() - t);
    sink += r.errors.length;
    if (d < best) best = d;
  }
  if (sink < 0) throw new Error("unreachable");
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// output (the whole set is a few megabytes: kept in memory and written at the end)
const cases: Case[] = [];
const answers: string[] = [];
const times: (number | null)[] = [];
const kinds = new Map<string, number>();
const fixtures: number[] = [];
const fixtureCount = new Map<string, number>();

function emit(kind: string, code: string, P: number, raw: unknown): void {
  const c: Case = { id: cases.length, kind, code, P, raw };
  cases.push(c);
  answers.push(JSON.stringify(answer(c)));
  times.push(noTimes ? null : timing(c));
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  const n = Array.isArray((raw as { pieces?: unknown } | null)?.pieces) ? (raw as { pieces: unknown[] }).pieces.length : null;
  // fixtures: a few small cases of each kind, apart for ball pieces and for solid pieces
  const key = `${kind}/${code.startsWith("ballin") ? (code === "ballinball" ? "ball" : code === "ballincub" ? "cube" : "solid") : "pose"}`;
  const cap = kind === "malformed" ? 60 : 2;
  if (fixturesDir && (n === null || n <= 12) && (fixtureCount.get(key) ?? 0) < cap) {
    fixtureCount.set(key, (fixtureCount.get(key) ?? 0) + 1);
    fixtures.push(c.id);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// mutants of a real configuration
const copy = (c: Config): Config => ({ s: c.s, pieces: c.pieces.map((p) => [...p]) });
type Mutant = (c: Config, problem: BallsProblem) => { config: Config; P?: number } | null;
const moved = (d: number): Mutant => (c) => {
  const m = copy(c);
  for (const p of m.pieces) for (let k = 0; k < 3; k++) p[k] *= 1 - d;
  return { config: m };
};
const jitter = (d: number): Mutant => (c) => {
  const m = copy(c);
  for (const p of m.pieces) for (let k = 0; k < 3; k++) p[k] += d * uniform(-1, 1);
  return { config: m };
};
const MUTANTS: [string, Mutant][] = [
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
  ["squeeze-1e-10", moved(1e-10)],
  ["squeeze-3e-9", moved(3e-9)],
  ["squeeze-1e-6", moved(1e-6)],
  [
    "outside",
    (c, problem) => {
      const m = copy(c);
      const k = Math.floor(random() * m.pieces.length);
      const reach = problem.container === "ball" ? 0.5 : getSolid(problem.container).circumradius;
      m.pieces[k][pick([0, 1, 2])] = c.s * reach * pick([1.2, -1.2]);
      return { config: m };
    },
  ],
  ["count-less", (c) => (c.pieces.length < 2 ? null : { config: { s: c.s, pieces: c.pieces.slice(0, -1).map((p) => [...p]) }, P: c.pieces.length })],
  ["count-more", (c) => ({ config: { s: c.s, pieces: [...c.pieces.map((p) => [...p]), [...c.pieces[0]]] }, P: c.pieces.length })],
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
  ["jitter-1e-9", jitter(1e-9)],
  ["jitter-1e-7", jitter(1e-7)],
  ["crowd", moved(0.1)],
  ["tiny-s", (c) => ({ config: { ...copy(c), s: c.s * 0.5 } })],
  [
    // solids only: the same rotation written with another quaternion (a ball has none: its s is moved instead)
    "q-scale",
    (c, problem) => {
      if (problem.piece === "ball") return { config: { ...copy(c), s: c.s * (1 + 1e-12) } };
      const m = copy(c);
      for (const p of m.pieces) {
        const f = pick([1e-5, 3e-3, 0.5, 7, 1e6, 1e40, 3e90]) * uniform(0.5, 2);
        const big = Math.max(...p.slice(3).map(Math.abs));
        const g = big * f > 1e99 || Math.hypot(p[3], p[4], p[5], p[6]) * f < 1e-5 ? 1 : f;
        for (let k = 3; k < 7; k++) p[k] *= g;
      }
      return { config: m };
    },
  ],
  [
    "q-negate",
    (c, problem) => {
      if (problem.piece === "ball") return { config: { ...copy(c), s: c.s * (1 - 1e-12) } };
      const m = copy(c);
      for (const p of m.pieces) for (let k = 3; k < 7; k++) p[k] = -p[k];
      return { config: m };
    },
  ],
];

// ---------------------------------------------------------------------------------------------------------------
// constructed configurations
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
const GAPS = [0, 1e-9, 1e-10, -5e-10, -3e-9, 1e-4, -1e-6, 0.3];
const SIZES = [0, 1e-10, -1e-10, -3e-9, 1e-6, 0, -1e-6];

/** Pieces a gap apart (balls: centres 1 + gap apart; solids: equally turned, bounding boxes a gap apart). */
function gridPieces(problem: BallsProblem, P: number, gap: number, turned: boolean): number[][] {
  if (problem.piece === "ball") {
    const step = BALL_DIAMETER + gap;
    // a shift off the centre, so that a ball container's and a cube's walls are not met by symmetry alone
    const shift = [uniform(-0.2, 0.2), uniform(-0.2, 0.2), uniform(-0.2, 0.2)];
    return gridPoints(P, [step, step, step]).map((c) => c.map((x, k) => x + shift[k]));
  }
  const q = turned ? randomQuat() : [1, 0, 0, 0];
  const X = place(getSolid(problem.piece), [0, 0, 0, ...q]).X;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < X.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], X[i + k]);
      hi[k] = Math.max(hi[k], X[i + k]);
    }
  return gridPoints(P, [hi[0] - lo[0] + gap, hi[1] - lo[1] + gap, hi[2] - lo[2] + gap]).map((c) => [...c, ...q]);
}

let tightCount = 0;
function tightCase(problem: BallsProblem, P: number): void {
  const k = tightCount++;
  const pieces = gridPieces(problem, P, GAPS[k % GAPS.length], k % 2 === 1);
  const s = tightSize(problem, pieces) * (1 + SIZES[(k >> 3) % SIZES.length]);
  emit("tight", problem.code, P, { s, pieces });
}

function randomCase(problem: BallsProblem, P: number): void {
  const s = ballsBound(problem, P).value * uniform(1, 1.8);
  const reach = problem.container === "ball" ? s / 2 : s * getSolid(problem.container).inradius;
  const pieces = Array.from({ length: P }, () => {
    const c = [uniform(-reach, reach), uniform(-reach, reach), uniform(-reach, reach)];
    return problem.piece === "ball" ? c : [...c, ...randomQuat()];
  });
  emit("random", problem.code, P, { s, pieces });
}

// ---------------------------------------------------------------------------------------------------------------
// malformed configurations: every answer of ballsConfigErrors and of the parse
function malformed(problem: BallsProblem, base: Config): void {
  const P = base.pieces.length;
  const ball = problem.piece === "ball";
  const p0 = base.pieces[0];
  const withPiece = (i: number, piece: unknown): unknown => ({ s: base.s, pieces: base.pieces.map((p, k) => (k === i ? piece : p)) });
  const set = (k: number, v: unknown) => p0.map((x, i) => (i === k ? v : x));
  const forms: unknown[] = [
    // not an object
    null, [], [base.s, base.pieces], 7, "config", true, "",
    // s
    { pieces: base.pieces },
    { s: null, pieces: base.pieces },
    { s: "2", pieces: base.pieces },
    { s: 0, pieces: base.pieces },
    { s: -1, pieces: base.pieces },
    { s: 1e-300, pieces: base.pieces },
    { s: BALLS_MAX_SIZE, pieces: base.pieces },
    { s: BALLS_MAX_SIZE * (1 + 2 ** -52), pieces: base.pieces },
    { s: 1e7, pieces: base.pieces },
    { s: 1e300, pieces: base.pieces },
    // pieces
    { s: base.s },
    { s: base.s, pieces: null },
    { s: base.s, pieces: {} },
    { s: base.s, pieces: "pieces" },
    { s: base.s, pieces: [] },
    {},
    { s: "x", pieces: 5 },
    // one piece of the wrong form: the other kind's pose, too short, too long, not numbers
    withPiece(0, null),
    withPiece(0, 5),
    withPiece(0, {}),
    withPiece(0, []),
    withPiece(0, [0, 0, 0]),
    withPiece(0, [0, 0, 0, 1, 0, 0, 0]),
    withPiece(0, p0.slice(0, -1)),
    withPiece(0, [...p0, 0]),
    withPiece(P - 1, set(0, null)),
    withPiece(P - 1, set(1, "1")),
    withPiece(P - 1, set(2, true)),
    withPiece(P - 1, set(p0.length - 1, [0])),
    // the centre's range
    withPiece(0, set(0, BALLS_MAX_COORD)),
    withPiece(0, set(1, -BALLS_MAX_COORD)),
    withPiece(0, set(0, BALLS_MAX_COORD * (1 + 2 ** -52))),
    withPiece(0, set(2, -10000.000000000002)),
    withPiece(0, set(1, 1e300)),
    // several faults, and more than twenty
    { s: -1, pieces: base.pieces.map((p, i) => (i % 2 ? p : null)) },
    { s: base.s, pieces: Array.from({ length: 30 }, () => "x") },
    { s: 0, pieces: Array.from({ length: 30 }, () => [1e5, 0, 0]) },
    { s: base.s, pieces: Array.from({ length: 19 }, () => 1).concat(base.pieces as never) },
    // a wrong count is not malformed, and a fault of the form comes first
    { s: base.s, pieces: base.pieces.slice(1) },
    { s: base.s, pieces: [...base.pieces, p0] },
    { s: base.s, pieces: [...base.pieces.slice(1), null] },
    // more fields than the two, and whole numbers
    { s: base.s, pieces: base.pieces, note: "x", P: 99 },
    { pieces: base.pieces, s: base.s },
    { s: 9007199254740993, pieces: base.pieces },
  ];
  if (!ball) {
    const pose = (q: number[]) => withPiece(0, [p0[0], p0[1], p0[2], ...q]);
    forms.push(
      // the quaternion's range and norm (the polyhedra family's rules)
      withPiece(0, set(3, 1e100)),
      withPiece(0, set(5, 1.0000000000000002e100)),
      withPiece(0, set(6, -1e200)),
      pose([1e100, 1e100, 1e100, 1e100]),
      pose([0, 0, 0, 0]),
      pose([1e-6, 0, 0, 0]),
      pose([9.999999999999999e-7, 0, 0, 0]),
      pose([5e-7, 5e-7, 5e-7, 5e-7]),
      pose([4.9e-7, 5e-7, 5e-7, 5e-7]),
      pose([5e-324, 0, 0, 0]),
      withPiece(0, [1e5, 0, 0, 0, 0, 0, 0]),
      { s: base.s, pieces: base.pieces.map((p) => [p[0], p[1], p[2], 4.9e48, -1.3e48, 2.2e47, 5e48]) },
      { s: base.s, pieces: base.pieces.map((p) => [p[0], p[1], p[2], 1e-5, 0, 0, 2e-6]) },
    );
  }
  for (const raw of forms) emit("malformed", problem.code, P, raw);
  // the same pieces under a different P: only the count is wrong
  emit("malformed", problem.code, P + 1, base);
  emit("malformed", problem.code, 1, { s: base.s, pieces: [] });
}

// ---------------------------------------------------------------------------------------------------------------
// the cases
const firstOf = new Map<string, Config>();
if (snapshot) {
  let seen = 0;
  for await (const line of createInterface({ input: createReadStream(snapshot).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (!line.startsWith('{"problem":"balls/')) continue;
    const r = JSON.parse(line.trim().replace(/,$/, "")) as { problem: string; P: number; config: Config };
    const code = r.problem.split("/")[1];
    const problem = getBallsProblem(code);
    if (!problem) throw new Error(`the snapshot has an entry of ${code}, which is not a problem`);
    emit("site", code, r.P, r.config);
    const [name, make] = MUTANTS[seen % MUTANTS.length];
    const m = make(r.config, problem);
    if (m) emit(name, code, m.P ?? r.P, m.config);
    if (r.P <= 8 && !firstOf.has(code)) firstOf.set(code, r.config);
    seen++;
  }
  console.log(`site: ${seen} entries; ${cases.length} cases with their mutants`);
}
// every code: grids at the tolerance in the smallest container that holds them, and random pieces
for (const problem of BALLS_PROBLEMS) {
  tightCase(problem, pick([2, 3, 5, 8]));
  tightCase(problem, pick([12, 27, 40]));
  randomCase(problem, 2 + Math.floor(random() * 30));
}
// the largest check the server accepts, for each kind of container and a few solids
for (const code of ["ballinball", "ballincub", "ballintet", "ballintid", "ballinj92", "ballinpr3l3", "tetinball", "cubinball", "icoinball", "tidinball", "phcinball", "j92inball", "pr12l3inball"]) {
  const problem = getBallsProblem(code)!;
  tightCase(problem, BALLS_MAX_P);
  tightCase(problem, BALLS_MAX_P);
  randomCase(problem, BALLS_MAX_P);
}
for (const code of ["ballinball", "ballincub", "ballinico", "cubinball", "tteinball"]) {
  const problem = getBallsProblem(code)!;
  const base = firstOf.get(code) ?? { s: tightSize(problem, gridPieces(problem, 5, 0.01, true)) * 1.01, pieces: gridPieces(problem, 5, 0.01, true) };
  malformed(problem, base);
}

writeFileSync(`${outDir}/cases.jsonl`, `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`);
writeFileSync(
  `${outDir}/index.jsonl`,
  `${cases.map((c) => JSON.stringify({ id: c.id, kind: c.kind, code: c.code, P: c.P, n: Array.isArray((c.raw as { pieces?: unknown } | null)?.pieces) ? (c.raw as { pieces: unknown[] }).pieces.length : null })).join("\n")}\n`,
);
writeFileSync(`${outDir}/ref.jsonl`, `${answers.join("\n")}\n`);
if (!noTimes) writeFileSync(`${outDir}/ts-times.json`, JSON.stringify(times));

// ---------------------------------------------------------------------------------------------------------------
// the catalogue: names, ids, containers, bounds and the domain, one {k, v} per line; numbers as JavaScript prints
// them. A line whose inputs are a list carries them in its key, as JSON after the first "/".
const cat: string[] = [];
const put = (k: string, v: unknown) => cat.push(JSON.stringify({ k, v }));
put("constants", {
  BALL_RADIUS: N(BALL_RADIUS),
  BALL_DIAMETER: N(BALL_DIAMETER),
  BALLS_MIN_P,
  BALLS_MAX_P,
  BALLS_TOL: N(BALLS_TOL),
  BALLS_MAX_SIZE: N(BALLS_MAX_SIZE),
  BALLS_MAX_COORD: N(BALLS_MAX_COORD),
  score_of_radius_3: N(ballContainerScore(3)),
  radius_of_score_3: N(ballContainerRadius(3)),
});
put("problems", BALLS_PROBLEMS.map((p) => [p.code, p.piece, p.container, p.title, p.group]));
put("codes", BALLS_CODES);
put("codes_hint", BALLS_CODES_HINT);
put("original_codes", BALLS_ORIGINAL_CODES);
put("container_kinds", BALLS_PROBLEMS.map((p) => containerKind(p)));
put("plurals", BALLS_PROBLEMS.map((p) => pluralOf(p.piece)));
put("piece_volumes", BALLS_PROBLEMS.map((p) => N(pieceVolume(p))));
{
  const codes = ["ballinball", "ballincub", "tetinball", "ballinj92", "j92inball", "cubintet", "ball", "", "BALLINBALL", "ballinpr3l15"];
  put(`problem_of/${JSON.stringify(codes)}`, codes.map((c) => ballsProblemOf(c)?.title ?? null));
  put(`title/${JSON.stringify(codes)}`, codes.map((c) => ballsTitle(c)));
  const ids = [
    "balls/ballinball/13", "balls/ballinpkd/20", "balls/ap5inball/7", "balls/ballinball/1", "balls/ballinball/9999", "balls/ballinball/10000",
    "balls/ballinball/0", "balls/ballinball/013", "balls/ballinball/+3", "balls/ballinball/3.0", "balls/ballinball/", "balls/ballinball",
    "balls//3", "balls/1ball/3", "balls/Ballinball/3", "balls/cubintet/3", "balls/nope/3", "polyhedra/cubintet/3", "ballinball/3", "balls/ballinball/3/4",
    "balls/ballinball/3\n", " balls/ballinball/3", "balls/ball in ball/3", "balls/ballinbäll/3", "", "balls/" + "a".repeat(93) + "/1", "balls/" + "a".repeat(92) + "/1",
    "balls/" + "é".repeat(93) + "/1", "balls/ballinj01/100", "balls/pr3l15inball/5",
  ];
  put(`parse_id/${JSON.stringify(ids)}`, ids.map((id) => {
    const r = parseBallsId(id);
    return typeof r === "string" ? r : [r.id, r.code, r.P, r.problem.code];
  }));
  put(`format_id/${JSON.stringify([["ballinball", 13], ["x", 0]])}`, [formatBallsId("ballinball", 13), formatBallsId("x", 0)]);
}
for (const s of SOLID_NAMES_LIST) {
  const S = getSolid(s.name);
  put(`extent/${s.name}`, { chebyshevOf: N(chebyshevOf(S.N, S.offsets)), enclosingOf: N(enclosingOf(S.V)), chebyshevRadius: N(chebyshevRadius(S)), enclosingRadius: N(enclosingRadius(S)) });
  const C = containerOf(s.name);
  put(`container/${s.name}`, {
    F: C.F,
    inradius: N(C.inradius),
    chebyshev: N(C.chebyshev),
    circumradius: N(C.circumradius),
    enclosing: N(C.enclosing),
    diameter: N(C.diameter),
    volume: N(C.volume),
    tangential: C.tangential,
    lo: C.lo.map(N),
    hi: C.hi.map(N),
  });
}
for (const p of BALLS_PROBLEMS)
  for (const P of [1, 2, 3, 13, 50, 100]) {
    const b = ballsBound(p, P);
    put(`bound/${p.code}/${P}`, { value: N(b.value), kind: b.kind, label: b.label });
  }
for (const code of [...BALLS_ORIGINAL_CODES, "ballinj01", "ballintid", "j44inball", "nope"])
  for (const P of [2, 7, 100, 1, 0, 101, 2.5, -1]) {
    const b = ballsDomain.bound({ fields: { code }, P });
    put(`domain_bound/${code}/${P}`, b ? { value: N(b.value), label: b.label } : null);
  }
put("domain_info", JSON.stringify(ballsDomain.info));
for (const limit of [0, 1, 7, 8, 100, 693, 694, 5000]) {
  const ids = ballsDomain.sample(limit);
  put(`domain_sample/${limit}`, { length: ids.length, first: ids.slice(0, 3), last: ids.slice(-2), hash: fnv(ids.join(",")) });
}
// ballsConfigErrors with a number of pieces and other limits of errors (the server passes none and 20)
{
  const balls = { s: 3, pieces: [[0, 0, 0], [1, 0, 0]] };
  const poses = { s: 3, pieces: [[0, 0, 0, 1, 0, 0, 0], [1, 1, 1, 0, 0, 0, 1]] };
  const forms: [string, unknown, number | null, number][] = [
    ["ballinball", balls, 2, 20], ["ballinball", balls, 3, 20], ["ballinball", balls, null, 20], ["ballinball", balls, 0, 20],
    ["ballincub", { s: -1, pieces: [null, null, null] }, 2, 20], ["ballincub", { s: -1, pieces: [null, null, null] }, 2, 2], ["ballincub", { s: -1, pieces: [null, null, null] }, 2, 1],
    ["ballintet", { s: 1, pieces: 5 }, 3, 20], ["ballintet", null, 3, 20], ["ballintet", poses, 2, 20],
    ["cubinball", poses, 2, 20], ["cubinball", poses, 3, 20], ["cubinball", balls, 2, 20], ["cubinball", { s: 2e6, pieces: poses.pieces }, 2, 20],
    ["cubinball", { s: -1, pieces: [null, null, null] }, 2, 2], ["cubinball", null, 2, 20], ["cubinball", { s: 1, pieces: {} }, null, 20],
  ];
  for (const [code, raw, P, max] of forms) put(`config_errors/${JSON.stringify([code, raw, P, max])}`, ballsConfigErrors(getBallsProblem(code)!, raw, P ?? undefined, max));
}
writeFileSync(`${outDir}/catalogue-ref.jsonl`, `${cat.join("\n")}\n`);

if (fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(`${fixturesDir}/cases.jsonl`, `${fixtures.map((i) => JSON.stringify(cases[i])).join("\n")}\n`);
  writeFileSync(`${fixturesDir}/ref.jsonl`, `${fixtures.map((i) => answers[i]).join("\n")}\n`);
  // the catalogue with the bounds of one code in fifteen and one container in three
  let n = 0;
  let last = "";
  let containers = 0;
  const keep = cat.filter((line) => {
    const k = (JSON.parse(line) as { k: string }).k;
    // one container in three (every solid's two radii are in its `extent` line)
    if (k.startsWith("container/")) return containers++ % 3 === 0;
    if (!k.startsWith("bound/")) return true;
    const code = k.split("/")[1];
    if (code !== last) {
      last = code;
      n++;
    }
    return n % 15 === 1;
  });
  writeFileSync(`${fixturesDir}/catalogue.jsonl`, `${keep.join("\n")}\n`);
  console.log(`fixtures: ${fixtures.length} cases and ${keep.length} catalogue lines in ${fixturesDir}`);
}

console.log(`${cases.length} cases (${serverChecks} parses checked against parseSpaceConfig), ${cat.length} catalogue lines written to ${outDir}`);
console.log([...kinds].map(([k, n]) => `${k} ${n}`).join(", "));
