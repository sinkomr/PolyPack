// Builds the cases of the sphere family and writes the TypeScript's verdicts and timings: the
// reference that native/sphere (crate polypack-sphere) is compared with (native/PORTING.md).
//
//   node --import tsx native/tools/sphere-ref.mts OUTDIR space-sphere.json.gz [--fixtures native/sphere/tests/fixtures] [--no-times]
//   cargo run --release -p polypack-sphere --example spherediff -- OUTDIR
//   node native/tools/sphere-compare.mjs OUTDIR
//
// Cases: the site's leading entries (the nightly snapshot), the research records
// (data/sphere/records.json), mutants of both, random configurations of every N of the domain,
// pieces at the existence limit rho = N/(2 pi), disks at the tolerances, and malformed input.
// Written: cases.jsonl, ref.jsonl (per case the validator's result at 1e-9 and 1e-11 as the server
// calls it, the reasons of `check`, and the result with no options for cases of at most 30
// pieces), ts-times.json (best of five of `check` at 1e-9, in nanoseconds), and aux-cases.jsonl /
// aux-ref.jsonl (areaBound, hullFaces, maxMarginPlane on their own inputs).
//
// A number that JSON cannot hold is written as the string "NaN", "Infinity" or "-Infinity".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { runSteps } from "../../packages/methods/src/sliced.ts";
import {
  type Quat,
  type SphereConfig,
  type Vec3,
  areaBound,
  pieceAngle,
  placedVertices,
  quatFromCentreTheta,
  quatMul,
} from "../../packages/sphere/src/geometry.ts";
import { hullFaces } from "../../packages/sphere/src/hull.ts";
import { type ValidationResult, maxMarginPlane, validationSteps } from "../../packages/sphere/src/validate.ts";
import { SPACE_STRICT_NO_RECORD_REASON, validateSpaceSubmission } from "../../packages/spaces/src/validate.ts";

const args = process.argv.slice(2);
const fx = args.indexOf("--fixtures");
const fixturesDir = fx >= 0 ? args.splice(fx, 2)[1] : null;
// --no-times: the timing passes are left out and ts-times.json is not written (for a run under emulation)
const nt = args.indexOf("--no-times");
const noTimes = nt >= 0;
if (noTimes) args.splice(nt, 1);
const [outDir, snapshot] = args;
if (!outDir || !snapshot) throw new Error("usage: sphere-ref.mts OUTDIR space-sphere.json.gz [--fixtures DIR]");
mkdirSync(outDir, { recursive: true });

// mulberry32: the cases are the same at every run
let seed = 20261110;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const randomQuat = (): Quat => {
  const q = [gauss(), gauss(), gauss(), gauss()];
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};

const MAX_REASONS = 20;
const NS = [0, ...Array.from({ length: 98 }, (_, i) => i + 3)];
type Piece = { q: number[] };
type Config = { rho: number; pieces: Piece[] };
type Case = { id: number; kind: string; N: number; P: number; config: Config };
const cases: Case[] = [];
const add = (kind: string, N: number, P: number, config: Config) =>
  cases.push({ id: cases.length, kind, N, P, config: JSON.parse(JSON.stringify(config, enc), dec) });

/** Non-finite numbers as strings, in the files. */
function enc(_: string, v: unknown) {
  return typeof v === "number" && !Number.isFinite(v) ? String(v) : v;
}
function dec(_: string, v: unknown) {
  return v === "NaN" ? NaN : v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : v;
}

// ---- real packings and their mutants -------------------------------------------------------
const real: { source: string; N: number; P: number; config: Config }[] = [];
for (const line of gunzipSync(readFileSync(snapshot)).toString().split("\n").slice(1)) {
  const text = line.trim().replace(/,$/, "");
  if (!text.startsWith("{")) continue;
  const r = JSON.parse(text);
  const [, N, P] = r.problem.split("/").map(Number);
  real.push({ source: "site", N, P, config: r.config });
}
for (const r of JSON.parse(readFileSync(new URL("../../data/sphere/records.json", import.meta.url), "utf8")).records)
  real.push({ source: "record", N: r.N, P: r.P, config: r.config });

const shrunk = (c: Config, eps: number): Config => ({ ...c, rho: c.rho * (1 - eps) });
/** Piece 1 moved onto piece 0, shifted by 0.3 of the piece's angular size about the x axis of piece 0. */
const overlapped = (N: number, c: Config): Config => {
  const h = (0.3 * pieceAngle(N, c.rho)) / 2;
  const q = quatMul(c.pieces[0].q as Quat, [Math.cos(h), Math.sin(h), 0, 0]);
  return { ...c, pieces: c.pieces.map((p, i) => (i === 1 ? { q } : p)) };
};
const MALFORMED: [string, (N: number, P: number, c: Config) => [number, number, Config]][] = [
  ["q-nan", (N, P, c) => [N, P, { ...c, pieces: c.pieces.map((p, i) => (i === P - 1 ? { q: [p.q[0], NaN, p.q[2], p.q[3]] } : p)) }]],
  ["q-infinite", (N, P, c) => [N, P, { ...c, pieces: c.pieces.map((p, i) => (i === 0 ? { q: [Infinity, 0, 0, 0] } : p)) }]],
  ["q-zero", (N, P, c) => [N, P, { ...c, pieces: c.pieces.map((p, i) => (i === P - 1 ? { q: [0, 0, 0, 0] } : p)) }]],
  ["q-short", (N, P, c) => [N, P, { ...c, pieces: c.pieces.map((p, i) => (i === 0 ? { q: p.q.slice(0, 3) } : p)) }]],
  ["q-long", (N, P, c) => [N, P, { ...c, pieces: c.pieces.map((p, i) => (i === P - 1 ? { q: [...p.q, 0] } : p)) }]],
  ["q-empty", (N, P, c) => [N, P, { ...c, pieces: c.pieces.map(() => ({ q: [] })) }]],
  ["rho-zero", (N, P, c) => [N, P, { ...c, rho: 0 }]],
  ["rho-negative", (N, P, c) => [N, P, { ...c, rho: -c.rho }]],
  ["rho-nan", (N, P, c) => [N, P, { ...c, rho: NaN }]],
  ["rho-infinite", (N, P, c) => [N, P, { ...c, rho: Infinity }]],
  ["rho-below-existence", (N, P, c) => [N, P, { ...c, rho: N === 0 ? 0.15 : (N / (2 * Math.PI)) * 0.99 }]],
  ["N-2", (_, P, c) => [2, P, c]],
  ["N-101", (_, P, c) => [101, P, c]],
  ["N-fraction", (_, P, c) => [3.5, P, c]],
  ["N-negative", (_, P, c) => [-4, P, c]],
  ["N-nan", (_, P, c) => [NaN, P, c]],
  ["P-zero", (N, _, c) => [N, 0, c]],
  ["P-fraction", (N, P, c) => [N, P + 0.5, c]],
  ["P-nan", (N, _, c) => [N, NaN, c]],
  ["P-zero-empty", (N, _, c) => [N, 0, { ...c, pieces: [] }]],
  ["everything", (_, P, c) => [1, -P, { rho: -1, pieces: c.pieces.map((p, i) => ({ q: i % 2 ? [0, 0, 0, 0] : [NaN, 0, 0, 0] })) }]],
  // a quaternion whose squared norm underflows: the validator takes it (the server's parser does not)
  ["q-tiny-1e-200", (N, P, c) => [N, P, { ...c, pieces: c.pieces.map((p, i) => (i === 0 ? { q: p.q.map((x) => x * 1e-200) } : p)) }]],
  ["q-tiny-1e-160", (N, P, c) => [N, P, { ...c, pieces: c.pieces.map((p, i) => (i === P - 1 ? { q: p.q.map((x) => x * 1e-160) } : p)) }]],
];
real.forEach((r, t) => {
  const { N, P, config: c } = r;
  add(`real-${r.source}`, N, P, c);
  const mutants: string[] = [
    ["overlap", "shrink-1e-10", "shrink-1e-6"],
    ["shrink-3e-9", "wrong-count", "coincident"],
    ["shrink-1e-6", "scaled-q", "shrink-1e-10"],
    ["shrink-1e-10", "malformed", "overlap"],
    ["shrink-3e-9", "overlap", "scaled-q"],
    ["malformed", "shrink-3e-9", "shrink-1e-6"],
  ][t % 6];
  for (const m of mutants) {
    if (m === "overlap" && P >= 2) add("overlap", N, P, overlapped(N, c));
    else if (m === "overlap") add("shrink-1e-6", N, P, shrunk(c, 1e-6));
    else if (m.startsWith("shrink-")) add(m, N, P, shrunk(c, Number(m.slice(7))));
    else if (m === "wrong-count") add("wrong-count", N, t % 4 === 1 || P === 1 ? P + 1 : P - 1, c);
    else if (m === "coincident") add("coincident", N, P, { ...c, pieces: c.pieces.map(() => ({ q: c.pieces[0].q })) });
    else if (m === "scaled-q")
      add("scaled-q", N, P, {
        ...c,
        // the same rotations: any nonzero multiple of a quaternion
        pieces: c.pieces.map((p) => {
          const k = (rnd() < 0.5 ? -1 : 1) * 10 ** (6 * rnd() - 3);
          return { q: p.q.map((x) => x * k) };
        }),
      });
    else if (m === "malformed") {
      const [name, f] = MALFORMED[Math.floor(t / 3) % MALFORMED.length];
      const [n2, p2, c2] = f(N, P, c);
      add(`malformed-${name}`, n2, p2, c2);
    }
  }
});

// ---- random configurations: every N of the domain, small and large P, dense and sparse -------
for (const N of NS) {
  for (const [kind, P, factor] of [
    ["random-sparse", 2 + Math.floor(rnd() * 4), 2.5 + 2 * rnd()],
    ["random-sparse", 6 + Math.floor(rnd() * 10), 1.8 + rnd()],
    ["random-dense", 2 + Math.floor(rnd() * 9), 1.02 + 0.3 * rnd()],
    ["random-dense", 40 + Math.floor(rnd() * 61), 1.05 + 0.5 * rnd()],
    ["random-unnormalised", 3 + Math.floor(rnd() * 20), 1.3 + 2 * rnd()],
  ] as [string, number, number][]) {
    const rho = Math.max(areaBound(N, P), N === 0 ? 0.33 : (N / (2 * Math.PI)) * 1.001) * factor;
    const pieces = Array.from({ length: P }, () => {
      const q = randomQuat();
      const k = kind === "random-unnormalised" ? (rnd() < 0.5 ? -1 : 1) * 10 ** (4 * rnd() - 2) : 1;
      return { q: q.map((x) => x * k) };
    });
    add(kind, N, P, { rho, pieces });
  }
}

// ---- the existence limit: rho at and just above N/(2 pi), where the circumradius reaches pi/2 ---
const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const ulps = (x: number, k: number) => ((f64[0] = x), (u64[0] += BigInt(k)), f64[0]);
for (const N of NS.slice(1)) {
  const limit = N / (2 * Math.PI);
  const rhos = [limit, ulps(limit, 1), ulps(limit, 2), limit * (1 + 1e-12), limit * (1 + 1e-9), limit * (1 + 1e-6)];
  // two antipodal pieces (the P = 2 optimum), turned about the axis; the same centre; three pieces on a great circle
  const theta = 0.1 + rnd();
  const turned: Quat = [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)];
  const layouts: Piece[][] = [
    [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }],
    [{ q: [1, 0, 0, 0] }, { q: quatMul([0, 1, 0, 0], turned) }],
    [{ q: [1, 0, 0, 0] }, { q: turned }],
    [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }, { q: quatFromCentreTheta([1, 0, 0], theta) }],
    [{ q: randomQuat() }, { q: randomQuat() }],
  ];
  for (let k = 0; k < 4; k++) {
    const rho = rhos[(N + k) % rhos.length];
    const pieces = layouts[(N + 2 * k) % layouts.length];
    add("existence-limit", N, pieces.length, { rho, pieces });
  }
}

// ---- disks at the tolerances: two caps whose gap is a chosen number ------------------------------
for (const rho of [0.4, 0.8, 3, 50])
  for (const gap of [0, 1e-12, -1e-12, -0.999e-11, -1.001e-11, -0.999e-9, -1.001e-9, -1e-6, 1e-6, -0.3]) {
    const t = 2 * pieceAngle(0, rho) + gap / rho;
    add("disk-gap", 0, 2, { rho, pieces: [{ q: [1, 0, 0, 0] }, { q: [Math.cos(t / 2), Math.sin(t / 2), 0, 0] }] });
  }
// caps larger than a hemisphere: one fits, two do not
for (const rho of [0.2, 0.3, 0.31, 1 / Math.PI, 0.32, 0.16, 0.159, 1 / (2 * Math.PI)]) {
  add("disk-hemisphere", 0, 1, { rho, pieces: [{ q: [1, 0, 0, 0] }] });
  add("disk-hemisphere", 0, 2, { rho, pieces: [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }] });
  add("disk-hemisphere", 0, 3, { rho, pieces: [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }, { q: [1, 1, 0, 0] }] });
}
// more reasons than the server lists: 30 bad pieces
for (const N of [0, 4, 30])
  add("malformed-many", N, 30, { rho: 10, pieces: Array.from({ length: 30 }, (_, i) => ({ q: i % 3 ? [0, 0, 0, 0] : [1, 2] })) });

// ---- the reference ------------------------------------------------------------------------------
/** check() of packages/spaces/src/validate.ts, case "sphere" (the function is not exported; this copy is verified below). */
function* check(N: number, P: number, config: SphereConfig, tol: number): Generator<void, string[]> {
  return reasonsOf(yield* validationSteps({ N, P }, config, { tol, maxErrors: MAX_REASONS }));
}
function reasonsOf(v: ValidationResult): string[] {
  if (v.valid) return [];
  if (v.errors.length) {
    const list = v.errors.slice(0, MAX_REASONS);
    return list.length ? list : [""];
  }
  const [i, j] = v.worstPair ?? [-1, -1];
  return [`pieces ${i} and ${j} overlap by ${-v.minGap}`];
}
/** The result as both sides write it: every pair up to 600; beyond, every stride-th and those within 1e-9 of the smallest gap. */
function resultJson(v: ValidationResult) {
  const stride = v.pairs.length <= 600 ? 1 : Math.ceil(v.pairs.length / 400);
  const count = (kind: string) => v.pairs.filter((g) => g.kind === kind).length;
  return {
    valid: v.valid,
    strictlyValid: v.strictlyValid,
    minGap: v.minGap,
    worstPair: v.worstPair,
    errors: v.errors,
    npairs: v.pairs.length,
    kinds: { far: count("far"), plane: count("plane"), disk: count("disk") },
    pairs: v.pairs.flatMap((g, at) => (at % stride === 0 || g.gap <= v.minGap + 1e-9 ? [[at, g.i, g.j, g.kind, g.gap, g.normal ?? null]] : [])),
  };
}

const ref: string[] = [];
let verified = 0;
for (const c of cases) {
  const config = c.config as unknown as SphereConfig;
  const at = (tol: number) => runSteps(validationSteps({ N: c.N, P: c.P }, config, { tol, maxErrors: MAX_REASONS }));
  const [v9, v11] = [at(1e-9), at(1e-11)];
  const [r9, r11] = [reasonsOf(v9), reasonsOf(v11)];
  const line: Record<string, unknown> = { id: c.id, t9: resultJson(v9), t11: resultJson(v11), r9, r11 };
  if (config.pieces.length <= 30) line.v0 = resultJson(runSteps(validationSteps({ N: c.N, P: c.P }, config)));
  // The copy of check() above against the server's own rule, where the server's parser takes the
  // case: with `noRecord` the server runs the check at 1e-9 and, when that passes, at 1e-11.
  if (NS.includes(c.N) && Number.isInteger(c.P) && c.P >= 1 && c.P <= 100) {
    const sv = validateSpaceSubmission("sphere", `sphere/${c.N}/${c.P}`, JSON.parse(JSON.stringify(c.config)), { noRecord: true });
    if (sv.config !== null) {
      const expected = r9.length ? r9 : r11.length ? [SPACE_STRICT_NO_RECORD_REASON, ...r11.slice(0, 3)] : [];
      if (JSON.stringify(sv.reasons) !== JSON.stringify(expected) || sv.valid !== (expected.length === 0))
        throw new Error(`case ${c.id}: check() here and the server's differ: ${JSON.stringify(sv.reasons)} / ${JSON.stringify(expected)}`);
      verified++;
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
  aux.push({ id: aux.length, ...a } as Aux);
  auxRef.push(JSON.stringify({ id: aux.length - 1, result }, enc));
};
// the domain's bound (packages/spaces/src/piece-domains.ts): areaBound(N, P), every N and P of the domain
for (const N of NS) auxAdd({ fn: "areaBound", N }, Array.from({ length: 100 }, (_, i) => areaBound(N, i + 1)));
// the hull and the max-margin plane on the vertices of two placed pieces, given as numbers
for (let k = 0; k < 400; k++) {
  const N = k < 60 ? 3 + (k % 6) : 3 + Math.floor(rnd() * 98);
  const rho = (N / (2 * Math.PI)) * (k % 7 === 0 ? 1 + 1e-9 : 1.0005 + 3 * rnd() * rnd());
  const qa = randomQuat();
  // the second piece near the first (a pair the validator would measure), or anywhere
  const near = quatMul(qa, quatFromCentreTheta([Math.sin(2.2 * rnd() * pieceAngle(N, rho) * N / 6), 0, 1], 6 * rnd()));
  const qb = k % 5 === 0 ? randomQuat() : near;
  const A = placedVertices(N, rho, qa);
  const B = placedVertices(N, rho, qb);
  const m = maxMarginPlane(A, B);
  auxAdd({ fn: "maxMarginPlane", N, A, B }, m);
  const S: Vec3[] = [...A, ...B.map((b) => [-b[0], -b[1], -b[2]] as Vec3)];
  if (S.length >= 4) auxAdd({ fn: "hullFaces", N, S }, runSteps(hullFaces(S)));
}
// the vertices of a placed piece (sines and cosines: where the two languages can differ in a last digit)
for (let k = 0; k < 600; k++) {
  const N = NS[1 + (k % 98)];
  const rho = (N / (2 * Math.PI)) * (1.0005 + 3 * rnd() * rnd());
  const q = randomQuat();
  auxAdd({ fn: "placedVertices", N, rho, q }, placedVertices(N, rho, q).flat());
}
// coplanar points (the fan of hullFaces): two polygons at the pole, exactly in one plane
for (const N of [3, 4, 9, 17, 40, 100]) {
  const z = 0.25;
  const ring = (turn: number, sign: number): Vec3[] =>
    Array.from({ length: N }, (_, k) => {
      const phi = turn + (2 * Math.PI * k) / N;
      return [sign * Math.sqrt(1 - z * z) * Math.cos(phi), Math.sqrt(1 - z * z) * Math.sin(phi), z];
    });
  const S = [...ring(0, 1), ...ring(0.3, -1)];
  auxAdd({ fn: "hullFaces", N, S }, runSteps(hullFaces(S)));
  auxAdd({ fn: "maxMarginPlane", N, A: ring(0, 1), B: ring(0.3, -1).map((b) => [-b[0], -b[1], -b[2]]) }, maxMarginPlane(ring(0, 1), ring(0.3, -1).map((b) => [-b[0], -b[1], -b[2]] as Vec3)));
}
writeFileSync(`${outDir}/aux-cases.jsonl`, aux.map((a) => JSON.stringify(a, enc)).join("\n") + "\n");
writeFileSync(`${outDir}/aux-ref.jsonl`, auxRef.join("\n") + "\n");

// ---- fixtures for `cargo test`: a few cases of every kind, small ---------------------------------
if (fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true });
  const taken = new Map<string, number>();
  const pick: number[] = [];
  for (const c of cases) {
    const big = c.config.pieces.length > 8 || JSON.stringify(c.config, enc).length > 1000;
    // polygons of more than 8 sides go through the hull: keep some of them too
    const kind = `${c.kind}${c.N > 8 ? "/hull" : ""}`;
    const n = taken.get(kind) ?? 0;
    if (big || n >= (c.kind.startsWith("malformed") || c.N > 8 ? 1 : 2)) continue;
    taken.set(kind, n + 1);
    pick.push(c.id);
  }
  writeFileSync(`${fixturesDir}/cases.jsonl`, pick.map((i) => JSON.stringify(cases[i], enc)).join("\n") + "\n");
  writeFileSync(`${fixturesDir}/ref.jsonl`, pick.map((i) => ref[i]).join("\n") + "\n");
  const auxPick = aux.filter((a, i) => (a.fn === "areaBound" ? [0, 3, 4, 5, 7, 12, 50, 100].includes(a.N as number) : a.fn === "placedVertices" ? (a.N as number) <= 12 && i % 7 === 0 : ((a.N as number) <= 30 && i % 20 === 0) || ((a.N as number) <= 17 && a.fn !== "placedVertices" && i >= 1499))).map((a) => a.id);
  writeFileSync(`${fixturesDir}/aux-cases.jsonl`, auxPick.map((i) => JSON.stringify(aux[i], enc)).join("\n") + "\n");
  writeFileSync(`${fixturesDir}/aux-ref.jsonl`, auxPick.map((i) => auxRef[i]).join("\n") + "\n");
  console.log(`fixtures: ${pick.length} cases, ${auxPick.length} auxiliary`);
}

// ---- timing: check() as the server calls it at 1e-9, best of five passes per case -----------------
const best = new Float64Array(cases.length).fill(Infinity);
for (let pass = 0; pass < (noTimes ? 0 : 5); pass++)
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const t = process.hrtime.bigint();
    runSteps(check(c.N, c.P, c.config as unknown as SphereConfig, 1e-9));
    const d = Number(process.hrtime.bigint() - t);
    if (d < best[i]) best[i] = d;
  }
if (!noTimes) writeFileSync(`${outDir}/ts-times.json`, JSON.stringify(Array.from(best)));
const kinds = new Map<string, number>();
for (const c of cases) kinds.set(c.kind.replace(/^malformed-.*/, "malformed"), (kinds.get(c.kind.replace(/^malformed-.*/, "malformed")) ?? 0) + 1);
console.log(`${cases.length} cases (${real.length} real), ${aux.length} auxiliary; check() verified against validateSpaceSubmission on ${verified}`);
console.log([...kinds].map(([k, n]) => `${k} ${n}`).join(", "));
