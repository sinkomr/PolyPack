// The TypeScript side of the comparison of the flat family (packages/geometry) with its Rust port
// (native/flat). Builds the cases and writes what the TypeScript computes for each, with timings.
//
//   node --import tsx native/tools/flat-ref.mts OUTDIR PER_PAIR [--fixtures DIR] [--no-times] n-*.json.gz...
//   cargo run --release -p polypack-flat --example serverdiff -- OUTDIR
//   node native/tools/flat-compare.mjs OUTDIR
//
// The .json.gz files are the nightly snapshot of the site's leading packings, one file per piece
// shape N with every container shape M. PER_PAIR real boards are taken for each pair (N, M), spread
// over P from the smallest to 500. With --fixtures, a small sample of the cases and of the
// TypeScript's answers is also written to DIR (native/flat/tests/fixtures), for `cargo test`.
//
// Two files of cases are written:
//  - cases.jsonl: bodies as POST /api/submit receives them. Real boards; their mutants (a piece
//    moved into another, the board squeezed by 1e-10, 3e-9 and 1e-6, piled up, the container
//    turned, a wrong count, a piece far away, a duplicate, fields left out); random boards of every
//    shape; lattices with exact contacts; boards at the limits; malformed bodies; and bodies given
//    as JSON text, which each side reads with its own JSON parser.
//  - calls.jsonl: single calls of the other functions the server reaches (the separation kernels
//    on pairs of pieces, strictVerify against given containers, the shape constants and bounds,
//    the hull and the enclosing containers of point sets, the rules about published values,
//    parseProvenance, eventKeys).
// The answers go to ref.jsonl and calls-ref.jsonl, the timings (best of five, in nanoseconds) to
// ts-times.json.
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import * as g from "../../packages/geometry/src/index.ts";

type Pose = { x: number; y: number; theta: number };
type Json = any;

const args = process.argv.slice(2);
let fixturesDir: string | null = null;
const fx = args.indexOf("--fixtures");
if (fx >= 0) fixturesDir = args.splice(fx, 2)[1];
// --no-times: the timing passes are left out and ts-times.json is not written (for a run under emulation)
const nt = args.indexOf("--no-times");
const noTimes = nt >= 0;
if (noTimes) args.splice(nt, 1);
const [outDir, perPairArg, ...files] = args;
const perPair = Number(perPairArg);
if (!outDir || !(perPair >= 1) || files.length === 0) {
  console.error("usage: flat-ref.mts OUTDIR PER_PAIR [--fixtures DIR] [--no-times] n-*.json.gz...");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// mulberry32: the cases are the same on every run
let seed = 20261110;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const records: g.LiteratureRecord[] = JSON.parse(readFileSync("data/records.json", "utf8")).records;
const literature = new Map(records.map((r) => [`${r.N}/${r.M}/${r.P}`, r]));
/** A record without its coordinates: what the rules about published values read. */
const slim = (r: g.LiteratureRecord) => {
  const { pieces: _pieces, container_phi: _phi, ...rest } = r;
  return rest;
};
const METHODS = ["basin-hopping", "ls-growth", "penalty", "harden"];

// ---------------------------------------------------------------- cases.jsonl
interface Case {
  id: number;
  kind: string;
  /** piece and container shape of the board the case was made from, for the tables */
  N: number | null;
  M: number | null;
  body?: Json;
  /** the body as JSON text, for what JSON.stringify cannot write (-0, 1e999, duplicate keys) */
  text?: string;
  /** also evaluate with autoOrient */
  auto?: boolean;
  lit?: Json;
}
const cases: Case[] = [];
const add = (kind: string, body: Json, extra: Partial<Case> = {}) => {
  const N = body && typeof body === "object" && typeof body.N === "number" ? body.N : null;
  const M = body && typeof body === "object" && typeof body.M === "number" ? body.M : null;
  const lit = N !== null && M !== null ? literature.get(`${N}/${M}/${body.P}`) : undefined;
  cases.push({ id: cases.length, kind, N, M, body, ...(lit ? { lit: slim(lit) } : {}), ...extra });
};
const addText = (kind: string, text: string) => cases.push({ id: cases.length, kind, N: null, M: null, text });
const board = (N: number, M: number, P: number, pieces: Pose[], container_phi: number | undefined, more: Json = {}) => ({
  N,
  M,
  P,
  pieces,
  ...(container_phi === undefined ? {} : { container_phi }),
  name: "flat-ref",
  ...more,
});

/** Pairs of pieces of real boards that are near contact, for the kernels. */
const nearPairs: { N: number; a: Pose; b: Pose }[] = [];
/** Small real boards, for strictVerify against containers smaller than the board's own. */
const strictBoards: { N: number; M: number; pieces: Pose[]; phi: number }[] = [];

let real = 0;
let pairIndex = 0;
for (const f of files) {
  let N = 0;
  let M = 0;
  let targets: number[] = [];
  let next = 0;
  let slot = 0;
  for await (const line of createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity })) {
    const mN = /^\{"format":\d+,"N":(\d+)/.exec(line);
    if (mN) N = +mN[1];
    const mM = /"M":(\d+),"records"/.exec(line);
    if (mM) {
      M = +mM[1];
      const q = pairIndex++;
      // the smallest boards, then boards up to 500 pieces, at different P for every pair
      const base = [2 + (q % 9), 12 + ((q * 7) % 40), 60 + ((q * 13) % 140), 200 + ((q * 29) % 301)];
      targets = Array.from({ length: perPair }, (_, t) => (t < 4 ? base[t] : int(2, 500)));
      // every twelfth pair also gives its largest board, 500 pieces
      if (q % 12 === 0) targets.push(500);
      targets.sort((a, b) => a - b);
      next = 0;
      slot = 0;
    }
    if (!line.startsWith('{"P":') || next >= targets.length) continue;
    const P = +/^\{"P":(\d+)/.exec(line)![1];
    if (P < targets[next]) continue;
    while (next < targets.length && targets[next] <= P) next++;
    let text = line.trim().replace(/,$/, "");
    let r: Json = null;
    for (let k = 0; k < 4 && !r; k++) {
      try {
        r = JSON.parse(text);
      } catch {
        text = text.slice(0, -1);
      }
    }
    if (!r) throw new Error("unreadable record in " + f);
    const pieces: Pose[] = r.pieces.map((p: number[]) => ({ x: p[0], y: p[1], theta: p[2] ?? 0 }));
    const phi: number = r.container_phi ?? 0;
    const t = slot++;
    // every sixth board is also scored with autoOrient (never the largest ones: the hull of 500 hundred-gons)
    add("real", board(N, M, r.P, pieces, phi), real % 6 === 0 && pieces.length * Math.max(N, 1) <= 12000 ? { auto: true } : {});
    const squeeze = (f: number) => pieces.map((p) => ({ x: p.x * (1 - f), y: p.y * (1 - f), theta: p.theta }));
    const cx = pieces.reduce((s, p) => s + p.x, 0) / pieces.length;
    const cy = pieces.reduce((s, p) => s + p.y, 0) / pieces.length;
    const k = (5 * (pairIndex + t)) % 8;
    if (k === 0 && pieces.length >= 2)
      add("overlap", board(N, M, r.P, pieces.map((p, i) => (i === 1 ? { x: pieces[0].x + 0.01, y: pieces[0].y, theta: p.theta } : p)), phi));
    if (k === 1) {
      add("squeeze-1e-10", board(N, M, r.P, squeeze(1e-10), phi));
      add("squeeze-3e-9", board(N, M, r.P, squeeze(3e-9), phi));
    }
    if (k === 2) add("turned-container", board(N, M, r.P, pieces, rnd() * 6.283185307179586 - 3.1));
    if (k === 3) add("wrong-count", board(N, M, r.P < 500 ? r.P + 1 : r.P - 1, pieces, phi));
    if (k === 4) add("squeeze-1e-6", board(N, M, r.P, squeeze(1e-6), phi));
    if (k === 5) {
      // piled toward the centroid: many overlaps, usually more than the 20 the server reports
      const f = pick([0.3, 0.6, 0.85, 0.95, 0.99]);
      add("pile", board(N, M, r.P, pieces.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f, theta: p.theta })), phi));
    }
    if (k === 6) {
      add("far-piece", board(N, M, r.P, pieces.map((p, i) => (i === pieces.length - 1 ? { ...p, x: p.x + 1000 } : p)), phi));
      // no container_phi, and no theta for disks: the defaults of the parser
      add("fields-absent", board(N, M, r.P, N === 0 ? (pieces.map((p) => ({ x: p.x, y: p.y })) as Pose[]) : pieces, undefined));
    }
    if (k === 7) {
      const copy = pieces.length < 500 ? [...pieces, { ...pieces[0] }] : pieces.map((p, i) => (i === 1 ? { ...pieces[0] } : p));
      add("duplicate", board(N, M, copy.length, copy, phi));
    }
    if (real % 9 === 0 && pieces.length <= 40) strictBoards.push({ N, M, pieces, phi });
    // two pairs of neighbours for the kernels
    if (N !== 0 || real % 3 === 0) {
      const reach = 2 * g.boundingRadius(N) * 1.02;
      let found = 0;
      for (let i = int(0, pieces.length - 1), n = 0; n < pieces.length && found < 2; n++, i = (i + 1) % pieces.length) {
        for (let j = 0; j < pieces.length && found < 2; j++) {
          if (j !== i && Math.hypot(pieces[i].x - pieces[j].x, pieces[i].y - pieces[j].y) < reach) {
            nearPairs.push({ N, a: pieces[i], b: pieces[j] });
            found++;
            break;
          }
        }
      }
    }
    real++;
  }
}
const realCases = cases.length;

// random boards of every shape
const SHAPES_N = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 24, 37, 50, 67, 99, 100];
const ALL_SHAPES = [0, ...Array.from({ length: 98 }, (_, i) => i + 3)];
for (let c = 0; c < 900; c++) {
  const N = pick(SHAPES_N);
  const M = c % 3 === 0 ? pick([0, 3, 4, 5, 6, 7, 8, 12, 13, 100]) : pick(ALL_SHAPES);
  const P = c % 10 === 0 ? int(100, 500) : int(1, 80);
  const R = g.boundingRadius(N);
  const side = Math.sqrt(P) * R * pick([1.2, 2, 2.6, 3.5]);
  const turn = pick([0, 1, 10, 10, 10, 999, 1001, 1e6]);
  const pieces: Pose[] = Array.from({ length: P }, () => ({
    x: (rnd() - 0.5) * side,
    y: (rnd() - 0.5) * side,
    theta: turn === 0 ? 0 : (rnd() - 0.5) * 2 * turn,
  }));
  add("random", board(N, M, P, pieces, pick([0, undefined, rnd() * 7 - 3.5, 1e3 * (rnd() - 0.5)])), c % 12 === 0 && P <= 80 ? { auto: true } : {});
}

// lattices: exact contacts, edges along the container sides, ties in the hull and in the supports
for (let k = 2; k <= 22; k += k < 8 ? 1 : 3) {
  const squares: Pose[] = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) squares.push({ x: i, y: j, theta: Math.PI / 4 });
  for (const M of [4, 0, 3, 8]) add("lattice", board(4, M, k * k, squares, 0), { auto: k <= 6 });
  add("lattice", board(4, 4, k * k, squares.map((p) => ({ ...p, theta: 0 })), Math.PI / 4));
  const disks: Pose[] = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) disks.push({ x: i + (j % 2) / 2, y: (j * Math.sqrt(3)) / 2, theta: 0 });
  for (const M of [0, 4, 6, 3]) add("lattice", board(0, M, k * k, disks, 0), { auto: k <= 6 });
  const hexes: Pose[] = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) hexes.push({ x: Math.sqrt(3) * (i + (j % 2) / 2), y: 1.5 * j, theta: 0 });
  for (const M of [6, 0, 4]) add("lattice", board(6, M, k * k, hexes, 0));
  const tris: Pose[] = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) tris.push({ x: i, y: (j * Math.sqrt(3)) / 2 + (i % 2 ? Math.sqrt(3) / 6 : 0), theta: i % 2 ? Math.PI : 0 });
  add("lattice", board(3, 3, k * k, tris, 0));
}

// boards at the limits the server accepts, and just beyond
{
  const row = (n: number, at: (i: number) => Pose) => Array.from({ length: n }, (_, i) => at(i));
  for (const [N, M] of [[0, 0], [4, 4], [3, 100], [100, 3], [100, 100], [100, 0], [0, 100]] as const) {
    const R = g.boundingRadius(N);
    const k = 23;
    const spread = row(500, (i) => ({ x: (i % k) * 2.01 * R, y: Math.floor(i / k) * 2.01 * R, theta: i * 0.37 }));
    add("limit", board(N, M, 500, spread, 0.1));
    add("limit", board(N, M, 500, row(500, () => ({ x: 0.25, y: -0.5, theta: 0.3 })), 0)); // 124750 overlapping pairs
    add("limit", board(N, M, 500, row(500, (i) => ({ x: i * 2.5 * R, y: 0, theta: 1 })), 0)); // a row
    add("limit", board(N, M, 500, row(501, (i) => ({ x: i * 2.5 * R, y: 0, theta: 1 })), 0)); // one piece too many
    add("limit", board(N, M, 1, [{ x: 1e6, y: -1e6, theta: 0 }], 0));
    add("limit", board(N, M, 2, [{ x: 1e6, y: 1e6, theta: 0 }, { x: -1e6, y: -1e6, theta: 3 }], 0.5));
    add("limit", board(N, M, 1, [{ x: 1000000.0000000001, y: 0, theta: 0 }], 0));
    add("limit", board(N, M, 2, [{ x: 0, y: 0, theta: 1e300 }, { x: 3, y: 0, theta: -1e15 }], 1e300));
    add("limit", board(N, M, 2, [{ x: 0, y: 0, theta: 1000 }, { x: 0.9, y: 0.1, theta: -1000.0000000001 }], -1e9));
    add("limit", board(N, M, 3, [{ x: 999999.5, y: 999999.5, theta: 0 }, { x: 999998, y: 999999.5, theta: 0.2 }, { x: 999999.5, y: 999997.9, theta: 0.4 }], 2));
    add("limit", board(N, M, 2, [{ x: 5e-324, y: 0, theta: 0 }, { x: 0, y: 5e-324, theta: 0 }], 0));
    add("limit", board(N, M, 1, [{ x: 0, y: 0, theta: 0 }], 0));
  }
  for (const N of ALL_SHAPES) add("limit", board(N, (N * 7) % 101 < 3 ? 0 : (N * 7) % 101, 1, [{ x: 0.5, y: 0.25, theta: 0.125 }], 0.0625));
  for (const M of ALL_SHAPES) add("limit", board(M % 2 ? 0 : 5, M, 3, [{ x: 0, y: 0, theta: 0 }, { x: 2, y: 0.5, theta: 1 }, { x: 1, y: 2, theta: 2 }], 0.3), { auto: true });
}

// malformed bodies
{
  const good = () => board(4, 4, 2, [{ x: 0, y: 0, theta: 0 }, { x: 2, y: 0, theta: 0.5 }], 0.25, { agent_note: "note" });
  const odd: Json[] = [null, true, false, 0, 1, 2, 3, 4, 2.5, -1, 100, 101, 500, 501, 1e21, 1e-7, "", "4", "abc", [], [4], {}, { x: 1 }];
  for (const top of [null, true, 5, "text", [], [1, 2], [good()], {}, 0, ""]) add("malformed", top);
  for (const key of ["N", "M", "P", "pieces", "container_phi", "name", "agent_note"]) {
    for (const v of odd) add("malformed", { ...good(), [key]: v });
    const without: Json = good();
    delete without[key];
    add("malformed", without);
  }
  const pieceValues: Json[] = [null, 0, "", false, 5, "abc", true, [1, 2, 3], {}, { x: 1 }, { y: 1 }, { x: 1, y: "2" }, { x: "1", y: 2 },
    { x: 1, y: 2, theta: null }, { x: 1, y: 2, theta: "0" }, { x: 1, y: 2, theta: [] }, { x: 1e6, y: -1e6 }, { x: 1000000.0000000001, y: 0 },
    { x: 0, y: -1000000.0000000001 }, { x: 1e21, y: 1e21, theta: 1e21 }, { x: 1, y: 2, theta: 1e300 }, { x: null, y: 2 }, { x: 1, y: 2, z: 3, extra: "x" },
    { x: [1], y: 2 }, { x: true, y: 2 }, { x: 4, y: 2 }];
  for (const v of pieceValues) {
    add("malformed", { ...good(), pieces: [v, { x: 5, y: 5, theta: 0 }] });
    add("malformed", { ...good(), pieces: [{ x: 5, y: 5, theta: 0 }, v] });
    add("malformed", { ...good(), P: 1, pieces: [v] });
  }
  add("malformed", { ...good(), pieces: Array.from({ length: 501 }, (_, i) => ({ x: i, y: 0, theta: 0 })) });
  add("malformed", { ...good(), pieces: Array.from({ length: 501 }, () => null) });
  add("malformed", { ...good(), pieces: Array.from({ length: 500 }, () => null) });
  add("malformed", { ...good(), pieces: [] });
  add("malformed", { ...good(), P: 500, pieces: [] });
  // several errors at once, and random mixtures
  add("malformed", { N: 1, M: 2, P: 0, pieces: "x", container_phi: "0", name: 1, agent_note: 2 });
  add("malformed", { N: "4", M: null, P: 1.5, pieces: [{ x: 1 }], container_phi: null, name: null, agent_note: null });
  const keys = ["N", "M", "P", "pieces", "container_phi", "name", "agent_note", "found_with", "method", "seed", "software", "budget", "method_params", "agent"];
  for (let c = 0; c < 500; c++) {
    const b: Json = good();
    for (let n = int(1, 4); n > 0; n--) {
      const key = pick(keys);
      if (rnd() < 0.2) delete b[key];
      else b[key] = key === "pieces" && rnd() < 0.6 ? [pick(pieceValues), pick(pieceValues)] : pick([...odd, "ai", "optimizer", "hand", "external", "ls-growth", { evals: 5 }]);
    }
    add("malformed", b);
  }
  // what JSON.stringify cannot write: each side reads these texts with its own JSON parser
  const t = (s: string) => addText("json-text", s);
  t('{"N":-0,"M":-0,"P":1,"pieces":[{"x":-0,"y":-0,"theta":-0}],"container_phi":-0}');
  t('{"N":4.0,"M":4e0,"P":1.0,"pieces":[{"x":1E0,"y":0.0}]}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"N":5,"M":0}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2,"x":3}]}');
  t('{"N":4,"M":4,"P":2,"pieces":[{"x":0.1e1,"y":2},{"x":123456789012345678901234567890e-25,"y":0}],"seed":9007199254740993}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"seed":9007199254740991}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"seed":9007199254740992}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"seed":18446744073709551616}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"seed":-0}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1e999,"y":2}]}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"container_phi":-1e999}');
  t('{"N":4,"M":4,"P":1e999,"pieces":[{"x":1,"y":2}]}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1e-999,"y":4.9e-324}]}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"name":"\\ud83d\\ude00 ok"}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"name":"\\ud800 lone surrogate"}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"software":"\\udc00"}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"__proto__":{"x":1},"constructor":1,"toString":2}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"__proto__":{"x":1,"y":2}}]}');
  t(" \n\t{\"N\":4,\"M\":4,\"P\":1,\"pieces\":[{\"x\":1,\"y\":2}]}\r\n ");
  t("[".repeat(200) + "]".repeat(200));
  t('{"N":4,"M":4,"P":1,"pieces":' + "[".repeat(130) + "]".repeat(130) + "}");
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"method_params":' + '{"a":'.repeat(140) + "1" + "}".repeat(140) + "}");
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],}');
  t("{'N':4}");
  t('{"N":04}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":.5,"y":2}]}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1.,"y":2}]}');
  t('{"N":+4}');
  t('{"N":NaN}');
  t('{"N":Infinity}');
  t("");
  t("null");
  t("4");
  t('"text"');
  t("﻿{}");
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}]} x');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"name":"tab\tin string"}');
  t('{"N":4,"M":4,"P":1,"pieces":[{"x":1,"y":2}],"name":"\\u0000\\u001f\\"\\\\\\/"}');
}

// ---------------------------------------------------------------- calls.jsonl
interface Call {
  id: number;
  fn: string;
  [key: string]: Json;
}
const calls: Call[] = [];
const call = (fn: string, rest: Json) => calls.push({ id: calls.length, fn, ...rest });

// the separation kernels on pairs of pieces
{
  const thresholdsOf = () => [-1e-9, 0, 5e-324, 1e-11, 0.01 * (rnd() - 0.5), 0.5];
  for (const { N, a, b } of nearPairs) {
    const scale = pick([1, 1, 1 - 1e-8]);
    call("pair", { N, a, b, scale, thresholds: thresholdsOf() });
  }
  for (let c = 0; c < 4000; c++) {
    const N = c % 4 === 0 ? 0 : pick(ALL_SHAPES.slice(1));
    const R = g.boundingRadius(N);
    const turn = pick([0, 1, 7, 7, 7, 999.5, 1000.5, 1e7]);
    const far = pick([0.5, 1, 1, 2, 2.2, 5]);
    const pose = (): Pose => ({ x: (rnd() - 0.5) * far * R * 2, y: (rnd() - 0.5) * far * R * 2, theta: (rnd() - 0.5) * 2 * turn });
    let a = pose();
    let b = pose();
    // Two pieces about one centre: every axis of the general kernels gives the same gap, so which
    // normal they return is decided by the last digit of a sine. Only their separation is compared.
    const tie = c % 50 === 1 || c % 50 === 2;
    if (c % 50 === 1) b = { ...a }; // the same place
    if (c % 50 === 2) b = { ...a, theta: b.theta };
    if (c % 50 === 3) (a = { x: 0, y: 0, theta: 0 }), (b = { x: 2 * g.pieceInradius(N), y: 0, theta: N % 2 ? Math.PI / N : 0 }); // face to face
    if (c % 50 === 4) (a = { x: 1e6, y: -1e6, theta: a.theta }), (b = { x: 1e6 - R, y: -1e6 + 0.3 * R, theta: b.theta });
    call("pair", { N, a, b, scale: pick([1, 1, 1 - 1e-8, 0.5, 3]), thresholds: thresholdsOf(), ...(tie ? { tie: true } : {}) });
  }
}
// strictVerify against the board's own container and against smaller ones: the reason the route never
// sees, since it passes the container evaluate found ("shrunk pieces do not fit strictly inside")
strictBoards.forEach((b, i) => {
  const own = g.enclose(b.N, b.pieces, b.M, b.phi);
  const factors = [1, 1 - 1e-10, 1 - 1e-9, 1 - 1e-8, 1 - 1e-7, 0.9];
  for (let v = 0; v < 3; v++) {
    const container = { M: own.M, cx: own.cx, cy: own.cy, phi: own.phi, size: own.size * factors[(i + 2 * v) % factors.length] };
    call("strict", { N: b.N, pieces: b.pieces, container, eps: [1e-8, 1e-8, 1e-6, 1e-3][(i + v) % 4] });
  }
});
// shape constants, bounds and shape codes
for (const n of ALL_SHAPES) call("shape", { n, size: 1 + rnd() * 50, pose: { x: rnd() * 10 - 5, y: rnd() * 10 - 5, theta: rnd() * 20 - 10 }, scale: pick([1, 1 - 1e-8]) });
for (const N of ALL_SHAPES) for (const M of ALL_SHAPES) call("bound", { N, M, P: int(1, 500) });
for (const v of [0, 3, 100, 101, 2, 1, -1, -3, 3.5, 4, 99, 1e21, 2 ** 53, 5e-324, "4", "", null, true, false, [], [4], {}, { N: 4 }]) call("shapeCode", { v });
// the hull and the enclosing containers of point sets
for (let c = 0; c < 700; c++) {
  const kind = c % 7;
  const n = pick([0, 1, 2, 3, 4, 5, 8, 20, 60, 300]);
  let pts: number[] = [];
  for (let i = 0; i < n; i++) {
    if (kind === 0) pts.push(int(-2, 2), int(-2, 2)); // a lattice: duplicates and collinear points
    else if (kind === 1) pts.push(i * 0.5, 3 - i * 0.25); // a line
    else if (kind === 2) pts.push(Math.cos(i), Math.sin(i)); // a circle
    else if (kind === 3) pts.push(1e6 - rnd(), -1e6 + rnd());
    else if (kind === 4) pts.push(rnd() * 1e-300, rnd() * 1e-300);
    else pts.push((rnd() - 0.5) * 20, (rnd() - 0.5) * 3);
  }
  if (kind === 6 && n >= 3) pts = [0, 0, 5e-324, 0.4, 1, 1, ...pts.slice(6)]; // the underflow the hull's cross product guards against
  call("points", { pts, pad: pick([0, 0.5, 0.5 * (1 - 1e-8)]), M: pick([3, 4, 5, 6, 7, 8, 12, 13, 14, 37, 100]), phi: pick([0, 0.3, -2.5, 100.25]), auto: c % 5 === 0 });
}
// the rules about published values, for every record of data/records.json
for (const r of records) {
  const tol = g.literatureTolerance(r);
  const scores = [r.value, r.value - tol, r.value + tol, r.value - tol * (1 + 1e-9), r.value - tol * (1 - 1e-9), r.value + tol * (1 + 1e-9),
    r.value + 1e-9, r.value + 1.0000001e-9, r.value * (1 - 1e-12), r.value * (1 + 1e-12), r.value - 2 * tol, r.value + 2 * tol, r.value * 0.99, r.value * 1.01];
  call("lit", { rec: slim(r), scores });
}
call("recordsFile", { path: "data/records.json" });
for (let c = 0; c < 400; c++) {
  const leader = pick([1, 2.5, 3.0000000000000004, 17.25, 1e-3, 123456.789, rnd() * 40]);
  const score = pick([leader, leader * (1 - 1e-9), leader * (1 - 1e-9) * (1 - 2e-16), leader * (1 - 1.0000001e-9), leader * (1 - 0.9999999e-9), leader * (1 + 1e-9), leader - 1e-9, leader * 0.5]);
  call("improves", { score, leader });
}
for (let c = 0; c < 300; c++) {
  const pairs = int(1, 6);
  const problems = Array.from({ length: int(0, 160) }, () => ({ N: pick([0, 3, 4, 5, 6, 100].slice(0, pairs)), M: pick([0, 4]), P: int(1, c % 3 ? 40 : 500) }));
  call("eventKeys", { problems, max: pick([100, 100, 5, 1, 0, 30]) });
}
// parseProvenance
{
  const big = (bytes: number) => ({ text: "x".repeat(bytes - 11) }); // {"text":"..."} of exactly `bytes` bytes
  const values: Record<string, Json[]> = {
    found_with: ["hand", "optimizer", "optimizer_edited", "external", "ai", "", null, 5, ["hand"], "Hand"],
    agent: ["ai", "human", 5, null],
    method: ["ls-growth", "basin-hopping", "nope", "", 5, null, ["ls-growth"]],
    method_params: [{}, { a: 1 }, big(4096), big(4097), { "10": 1, "2": 2, b: [1e21, 1e-7, 0.1, -0, 1.5, null, true, "é😀\n\u0001\"\\"] }, [], null, "x", 5,
      { text: "é".repeat(2042) }, { text: "é".repeat(2043) }, { text: "😀".repeat(1021) }, { text: "😀".repeat(1022) }, { n: Array.from({ length: 700 }, (_, i) => i * 1e15) },
      { text: "\u0001".repeat(680) }, { text: "\u0001".repeat(682) }, { a: { b: { c: { d: [[], {}, [[]]] } } } }],
    seed: [0, 1, 123456, -1, 1.5, 2 ** 53 - 1, 2 ** 53, 1e21, "1", null, true, [], -0.5, 4294967296],
    budget: [{ evals: 1 }, { time_s: 0.5 }, { evals: 1000, time_s: 60 }, {}, { evals: 0 }, { evals: 1.5 }, { evals: -1 }, { time_s: 0 }, { time_s: -1 }, { time_s: "1" },
      { evals: null }, { time_s: null }, { evals: 1, other: 2 }, { other: 2 }, [], null, 5, "x", { evals: 2 ** 53 }, { evals: 2 ** 53 - 1 }, { time_s: 1e-300 }],
    software: ["polypack-volunteer/1.0", "", "x".repeat(80), "x".repeat(81), "😀".repeat(40), "😀".repeat(41), "é".repeat(80), "é".repeat(81), 5, null, ["x"], {}],
  };
  const keys = Object.keys(values);
  call("provenance", { body: {}, methods: METHODS });
  for (const key of keys) for (const v of values[key]) {
    call("provenance", { body: { [key]: v }, methods: METHODS });
    call("provenance", { body: { found_with: "optimizer", method: "ls-growth", [key]: v }, methods: METHODS });
    call("provenance", { body: { found_with: "external", [key]: v }, methods: METHODS });
  }
  for (let c = 0; c < 3000; c++) {
    const body: Json = {};
    for (const key of keys) if (rnd() < (key === "agent" ? 0.15 : 0.4)) body[key] = rnd() < 0.6 ? values[key][int(0, 2)] : pick(values[key]);
    call("provenance", { body, methods: c % 40 === 0 ? [] : METHODS });
  }
}

writeFileSync(`${outDir}/cases.jsonl`, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
writeFileSync(`${outDir}/calls.jsonl`, calls.map((c) => JSON.stringify(c)).join("\n") + "\n");

// ---------------------------------------------------------------- the TypeScript's answers
const containerOut = (k: g.Container | null) => (k ? { M: k.M, cx: k.cx, cy: k.cy, phi: k.phi, size: k.size } : null);
const overlapsOut = (list: g.Overlap[]) => {
  // every pair in order through a running hash, the first 40 in full, the sum of the depths, and
  // the pairs within 1e-12 of the deepest (at most 60): when several pairs are equally deep, which
  // one a refusal names is decided by the last digit of a sine, and the comparison checks the tie
  let hash = 7;
  let sum = 0;
  let min = Infinity;
  for (const o of list) {
    hash = (hash * 31 + o.i * 1009 + o.j) % 2147483647;
    sum += o.sep;
    if (o.sep < min) min = o.sep;
  }
  const pair = (o: g.Overlap) => [o.i, o.j, o.sep];
  return { count: list.length, hash, sum, first: list.slice(0, 40).map(pair), deepest: list.filter((o) => o.sep <= min + 1e-12).slice(0, 60).map(pair) };
};
const strictOut = (s: g.StrictResult) => ({ ok: s.ok, certifiedSize: s.certifiedSize, eps: s.eps, reason: s.reason ?? null });
const provenanceOut = (r: g.ProvenanceResult) => (r.ok ? { ok: true, provenance: r.provenance } : { ok: false, errors: r.errors });
const SERVER = { maxOverlaps: 20, stopWhenInvalid: true };

function runCase(c: Case): Json {
  let body = c.body;
  if (c.text !== undefined) {
    try {
      body = JSON.parse(c.text);
    } catch {
      return { id: c.id, json_ok: false };
    }
  }
  const out: Json = { id: c.id, json_ok: true };
  const parsed = g.parseConfig(body);
  out.parse = parsed.ok
    ? { ok: true, N: parsed.config.N, M: parsed.config.M, P: parsed.config.P, pieces: parsed.config.pieces.length, container_phi: parsed.config.container_phi,
        name: parsed.config.name ?? null, agent_note: parsed.config.agent_note ?? null,
        first: parsed.config.pieces.slice(0, 3).map((p) => [p.x, p.y, p.theta]) }
    : { ok: false, errors: parsed.errors };
  // as the route does: how the packing was found is read from the same body, when it is an object
  out.provenance = typeof body === "object" && body !== null && !Array.isArray(body) ? provenanceOut(g.parseProvenance(body, METHODS)) : null;
  if (!parsed.ok) return out;
  const config = parsed.config;
  // what POST /api/submit computes
  const e = g.evaluate(config, SERVER);
  out.server = { valid: e.valid, reasons: e.reasons, overlaps: overlapsOut(e.overlaps), container: containerOut(e.container), score: e.score };
  // without the limit and the early return: every overlap, and the container of an invalid board too
  const full = g.evaluate(config);
  out.full = { valid: full.valid, reasons: full.reasons, overlaps: overlapsOut(full.overlaps), container: containerOut(full.container), score: full.score };
  // the stricter tolerance of the other families, on the same scan
  out.tight = overlapsOut(g.findOverlaps(config.N, config.pieces, 1e-11, 1, Infinity));
  out.strict = full.container ? strictOut(g.strictVerify(config.N, config.pieces, full.container)) : null;
  if (c.lit && full.container) {
    const beats = g.beatsLiterature(full.container.size, c.lit);
    out.lit = { tolerance: g.literatureTolerance(c.lit), beats, reaches: g.reachesLiterature(full.container.size, c.lit), closed: g.closedToSubmissions(c.lit) };
  } else out.lit = null;
  if (c.auto) {
    const a = g.evaluate(config, { autoOrient: true });
    out.auto = { container: containerOut(a.container), score: a.score };
  } else out.auto = null;
  return out;
}

const contactOut = (k: g.Contact) => [k.sep, k.nx, k.ny];
function runCall(c: Call): Json {
  switch (c.fn) {
    case "pair": {
      const { N, a, b, scale, thresholds } = c;
      const out: Json = {
        piece: contactOut(g.pieceSeparation(N, a, b, scale)),
        pair: g.pairSeparation(N, a, b, scale),
        circle: contactOut(g.circleSeparation(a, b, scale)),
        below: thresholds.map((t: number) => g.separationBelow(N, a, b, t, scale)),
        pieceBelow: thresholds.map((t: number) => g.pieceSeparationBelow(N, a, b, t, scale)),
      };
      if (N !== 0) {
        out.regular = contactOut(g.regularPolygonSeparation(N, a, b, scale));
        out.overlap = g.regularPolygonOverlap(N, a.x, a.y, a.theta, b.x, b.y, b.theta, scale, 0);
        const va = g.pieceVertices(N, a, scale);
        const vb = g.pieceVertices(N, b, scale);
        const general = (k: g.Contact) => (c.tie ? [k.sep] : contactOut(k));
        out.polygon = general(g.polygonSeparation(va, vb));
        out.polygonCircle = general(g.polygonCircleSeparation(va, b.x, b.y, g.DISK_RADIUS * scale));
      }
      return out;
    }
    case "shape": {
      const n = c.n;
      const out: Json = { pieceInradius: g.pieceInradius(n), containerInradius: g.containerInradius(n), boundingRadius: g.boundingRadius(n), pieceArea: g.pieceArea(n), containerArea: g.containerArea(n, c.size) };
      if (n !== 0) {
        out.circumradius = g.circumradius(n);
        out.inradius = g.inradius(n);
        out.pieceVertices = Array.from(g.pieceVertices(n, c.pose, c.scale));
        out.containerVertices = Array.from(g.containerVertices({ M: n, cx: c.pose.x, cy: c.pose.y, phi: c.pose.theta, size: c.size }));
      }
      return out;
    }
    case "strict":
      return strictOut(g.strictVerify(c.N, c.pieces, c.container, c.eps));
    case "bound":
      return { areaLowerBound: g.areaLowerBound(c.N, c.M, c.P) };
    case "shapeCode":
      return { isShapeCode: g.isShapeCode(c.v) };
    case "points": {
      const set = { pts: g.convexHull(Float64Array.from(c.pts)), pad: c.pad };
      const k = (x: g.Container) => containerOut(x);
      return { hull: Array.from(set.pts), circle: k(g.enclosingCircle(set)), polygon: k(g.enclosingPolygon(set, c.M, c.phi)), set: k(g.encloseSet(set, c.M, c.phi)),
        auto: c.auto ? k(g.autoOrientSet(set, c.M, c.phi)) : null };
    }
    case "lit":
      return { tolerance: g.literatureTolerance(c.rec), closed: g.closedToSubmissions(c.rec), proven: g.isProven(c.rec.status),
        beats: c.scores.map((s: number) => g.beatsLiterature(s, c.rec)), reaches: c.scores.map((s: number) => g.reachesLiterature(s, c.rec)) };
    case "recordsFile": {
      let sum = 0;
      let closed = 0;
      let withPieces = 0;
      for (const r of records) {
        sum += r.N * 1e6 + r.M * 1e3 + r.P + r.value + r.display_precision + r.display.length + (r.pieces?.length ?? 0) + (r.container_phi ?? 0);
        if (g.closedToSubmissions(r)) closed++;
        if (r.pieces) withPieces++;
      }
      return { count: records.length, sum, closed, withPieces, none: g.closedToSubmissions(null) };
    }
    case "improves":
      return { improvesOn: g.improvesOn(c.score, c.leader) };
    case "eventKeys":
      return { keys: g.eventKeys(c.problems, c.max) };
    case "provenance":
      return provenanceOut(g.parseProvenance(c.body, c.methods));
    default:
      throw new Error("unknown call " + c.fn);
  }
}

const ref = cases.map(runCase);
writeFileSync(`${outDir}/ref.jsonl`, ref.map((r) => JSON.stringify(r)).join("\n") + "\n");
const callsRef = calls.map((c) => ({ id: c.id, ...runCall(c) }));
writeFileSync(`${outDir}/calls-ref.jsonl`, callsRef.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ---------------------------------------------------------------- timings, best of five
// `evaluate` as the server calls it, and strictVerify of a board it accepts
const configs = cases.map((c) => {
  if (c.text !== undefined) return null;
  const p = g.parseConfig(c.body);
  return p.ok ? p.config : null;
});
const evalNs = new Float64Array(cases.length).fill(Infinity);
const strictNs = new Float64Array(cases.length).fill(Infinity);
const parseNs = new Float64Array(cases.length).fill(Infinity);
const now = () => process.hrtime.bigint();
for (let pass = 0; pass < (noTimes ? 0 : 5); pass++) {
  for (let i = 0; i < cases.length; i++) {
    if (cases[i].text === undefined) {
      const t = now();
      g.parseConfig(cases[i].body);
      const d = Number(now() - t);
      if (d < parseNs[i]) parseNs[i] = d;
    }
    const config = configs[i];
    if (!config) continue;
    let t = now();
    const e = g.evaluate(config, SERVER);
    let d = Number(now() - t);
    if (d < evalNs[i]) evalNs[i] = d;
    if (e.valid && e.container) {
      t = now();
      g.strictVerify(config.N, config.pieces, e.container);
      d = Number(now() - t);
      if (d < strictNs[i]) strictNs[i] = d;
    }
  }
}
const finite = (a: Float64Array) => Array.from(a, (v) => (Number.isFinite(v) ? v : null));
if (!noTimes) writeFileSync(`${outDir}/ts-times.json`, JSON.stringify({ parse: finite(parseNs), evaluate: finite(evalNs), strict: finite(strictNs) }));

// ---------------------------------------------------------------- fixtures for cargo test
if (fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true });
  const keepCases: number[] = [];
  const perKind = new Map<string, number>();
  for (const c of cases) {
    const size = JSON.stringify(c).length;
    const n = perKind.get(c.kind) ?? 0;
    const quota = c.kind === "json-text" ? 100 : c.kind === "malformed" ? 40 : c.kind === "limit" || c.kind === "lattice" || c.kind === "random" ? 10 : 6;
    // small boards only; a text that one of the JSON parsers refuses says nothing about the port
    if (size > 2200 || n >= quota || ref[c.id].json_ok === false || (c.kind === "json-text" && /e999|\\ud800|\\udc00|\[{100}|\{"a":\{"a"/.test(c.text!))) continue;
    perKind.set(c.kind, n + 1);
    keepCases.push(c.id);
  }
  const keepCalls: number[] = [];
  const perFn = new Map<string, number>();
  for (const c of calls) {
    const n = perFn.get(c.fn) ?? 0;
    const quota = c.fn === "pair" ? 50 : c.fn === "provenance" ? 60 : c.fn === "recordsFile" ? 0 : 20;
    if (JSON.stringify(c).length > 2200 || n >= quota || (c.fn === "pair" && c.id % 97 !== 0) || (c.fn === "provenance" && c.id % 13 !== 0) || (c.fn === "lit" && c.id % 131 !== 0) || (c.fn === "bound" && c.id % 401 !== 0)) continue;
    perFn.set(c.fn, n + 1);
    keepCalls.push(c.id);
  }
  const lines = (list: Json[]) => list.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(`${fixturesDir}/cases.jsonl`, lines(keepCases.map((i) => cases[i])));
  writeFileSync(`${fixturesDir}/ref.jsonl`, lines(keepCases.map((i) => ref[i])));
  writeFileSync(`${fixturesDir}/calls.jsonl`, lines(keepCalls.map((i) => calls[i])));
  writeFileSync(`${fixturesDir}/calls-ref.jsonl`, lines(keepCalls.map((i) => callsRef[i])));
  console.log(`fixtures: ${keepCases.length} cases and ${keepCalls.length} calls in ${fixturesDir}`);
}
const kinds = new Map<string, number>();
for (const c of cases) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
console.log(`${cases.length} cases (${real} real boards of ${pairIndex} pairs of shapes, ${realCases - real} mutants) and ${calls.length} calls written to ${outDir}`);
console.log([...kinds].map(([k, n]) => `${k} ${n}`).join(", "));
