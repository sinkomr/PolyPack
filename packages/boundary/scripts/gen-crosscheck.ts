/**
 * The engine's verdicts, distances and parts on a set of tesseract configurations, for the exact
 * certifier's cross-check (python/boundary/test_boundary.py). Cases:
 *  - the engine's research fixtures (test/fixtures) at their own s;
 *  - the records (data/boundary/records.json) at score_cert, and shrunk about the centre by 1 - 1e-6;
 *  - the adversarial cases of python/boundary/fixtures/adversarial.json;
 *  - seeded random configurations: pairs of balls or cubes, the second placed by walking a
 *    geodesic from the first (so that many pairs interact across 2-faces), sometimes with a third
 *    piece placed at random; 50 valid and 50 invalid (at tol 1e-9) per piece.
 * For each case: validateBoundary at tol 1e-9 and tol 0; for balls the geodesic distance of every
 * pair, the shortest loop at every centre and every centre's clearance from the chain enumeration
 * (reach 2.5 balls' radii, 1.25 in site units; null beyond), and the closed-form clearance; for cubes every part's bounding box
 * (when every cube crosses the faces of its cell in at most one axis).
 *
 * Usage: npx tsx packages/boundary/scripts/gen-crosscheck.ts [out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BoundaryConfig, BoundaryProblem, PieceName } from "../src/index";
import {
  geodesicDistance,
  geodesicLoop,
  getPolytope,
  hingeClearance,
  parseBoundaryId,
  partMesh,
  pieceParts,
  tesseractClearance,
  traceGeodesic,
  validateBoundary,
} from "../src/index";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const out = process.argv[2] ?? root("python/boundary/fixtures/crosscheck.json");
const T = getPolytope("tesseract");
/** A ball's radius, site units (balls have diameter 1): the random ball cases are the radius-1 ones, scaled by it. */
const BALL = 0.5;
const REACH = 2.5 * BALL;

interface Case {
  id: string;
  piece: PieceName;
  P: number;
  config: BoundaryConfig;
}

/** Seeded generator (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const finite = (x: number) => (Number.isFinite(x) ? x : null);
const shrink = (c: BoundaryConfig, k: number): BoundaryConfig => ({
  s: c.s * k,
  pieces: c.pieces.map((p) => ({ ...p, u: p.u.map((x) => x * k) })),
});

const cases: Case[] = [];
for (const name of ["balls", "cubes"] as const) {
  const file = JSON.parse(readFileSync(root(`packages/boundary/test/fixtures/${name}.json`), "utf8")) as {
    configs: { id: string; config: BoundaryConfig }[];
  };
  for (const f of file.configs) {
    const p = parseBoundaryId(f.id) as BoundaryProblem;
    cases.push({ id: `fixture:${f.id}`, piece: p.piece, P: p.P, config: f.config });
  }
}
const records = (
  JSON.parse(readFileSync(root("data/boundary/records.json"), "utf8")) as {
    records: { id: string; piece: PieceName; P: number; config: BoundaryConfig }[];
  }
).records;
for (const r of records) cases.push({ id: `record:${r.id}`, piece: r.piece, P: r.P, config: r.config });
for (const r of records)
  cases.push({ id: `shrunk:${r.id}`, piece: r.piece, P: r.P, config: shrink(r.config, 1 - 1e-6) });
const adversarial = (
  JSON.parse(readFileSync(root("python/boundary/fixtures/adversarial.json"), "utf8")) as { cases: Case[] }
).cases;
for (const a of adversarial) cases.push({ id: a.id, piece: a.piece, P: a.P, config: a.config });

// random cases
const rand = mulberry32(20261025);
const cellPoint = (s: number, margin: number) => [0, 1, 2].map(() => (2 * rand() - 1) * (s / 2 - margin));
const direction = () => {
  for (;;) {
    const v = [2 * rand() - 1, 2 * rand() - 1, 2 * rand() - 1];
    const n = Math.hypot(v[0], v[1], v[2]);
    if (n > 0.1 && n <= 1) return v.map((x) => x / n);
  }
};
/** Keeps a random case only while its class (valid or invalid at tol 1e-9) is under its quota. */
const quota = { ball: { valid: 0, invalid: 0 }, cube: { valid: 0, invalid: 0 } };
const QUOTA = 50;
function keep(c: Case): boolean {
  const ok = validateBoundary({ polytope: "tesseract", piece: c.piece, P: c.P }, c.config, { tol: 1e-9 }).ok;
  const q = quota[c.piece as "ball" | "cube"];
  const k = ok ? "valid" : "invalid";
  if (q[k] >= QUOTA) return false;
  q[k]++;
  cases.push(c);
  return true;
}
for (let t = 0; (quota.ball.valid < QUOTA || quota.ball.invalid < QUOTA) && t < 200000; t++) {
  const s = BALL * (1.45 + 1.75 * rand());
  const c0 = Math.floor(rand() * 8);
  const u0 = cellPoint(s, 0);
  if (tesseractClearance(u0, s) < 0.98 * BALL) continue;
  const pieces = [{ cell: c0, u: u0 }];
  const walk = traceGeodesic(T, s, c0, u0, direction(), BALL * (1.8 + 0.6 * rand()));
  if (walk.hitHinge) continue;
  pieces.push({ cell: walk.cell, u: walk.u });
  if (rand() < 0.25) pieces.push({ cell: Math.floor(rand() * 8), u: cellPoint(s, 0) });
  keep({ id: `random-ball:${t}`, piece: "ball", P: pieces.length, config: { s, pieces } });
}
for (let t = 0; (quota.cube.valid < QUOTA || quota.cube.invalid < QUOTA) && t < 200000; t++) {
  const s = 1 + 1.2 * rand();
  const c0 = Math.floor(rand() * 8);
  const u0 = cellPoint(s, 0);
  const pieces = [{ cell: c0, u: u0 }];
  // walk along a local axis (sometimes off-axis), so that the second cube meets the first's parts
  const k = Math.floor(rand() * 3);
  const dir = rand() < 0.7 ? [0, 1, 2].map((i) => (i === k ? (rand() < 0.5 ? -1 : 1) : 0)) : direction();
  const walk = traceGeodesic(T, s, c0, u0, dir, 0.8 + 0.6 * rand());
  if (walk.hitHinge) continue;
  pieces.push({ cell: walk.cell, u: walk.u });
  if (rand() < 0.25) pieces.push({ cell: Math.floor(rand() * 8), u: cellPoint(s, 0) });
  keep({ id: `random-cube:${t}`, piece: "cube", P: pieces.length, config: { s, pieces } });
}

const t0 = performance.now();
const results = cases.map((c) => {
  const problem: BoundaryProblem = { polytope: "tesseract", piece: c.piece, P: c.P };
  const v9 = validateBoundary(problem, c.config, { tol: 1e-9 });
  const v0 = validateBoundary(problem, c.config, { tol: 0 });
  const res: Record<string, unknown> = {
    id: c.id,
    piece: c.piece,
    P: c.P,
    config: c.config,
    ts_valid_1e9: v9.ok,
    ts_valid_0: v0.ok,
    ts_reason: [...v9.reasons, ...v0.reasons][0] ?? null,
  };
  const s = c.config.s;
  const inside = c.config.pieces.every((p) => p.u.every((x) => Math.abs(x) <= s / 2));
  if (c.piece === "ball" && inside) {
    const pc = c.config.pieces;
    const pairs: [number, number, number | null][] = [];
    for (let i = 0; i < pc.length; i++)
      for (let j = i + 1; j < pc.length; j++) pairs.push([i, j, finite(geodesicDistance(T, s, pc[i], pc[j], REACH))]);
    res.pairs = pairs;
    res.loops = pc.map((p, i) => [i, finite(geodesicLoop(T, s, p, REACH))]);
    res.clearance_chains = pc.map((p) => finite(hingeClearance(T, s, p, 1.5 * BALL)));
    res.clearance_closed = pc.map((p) => tesseractClearance(p.u, s));
  }
  // parts only where every cube crosses the faces of its cell in at most one axis (where the
  // certifier's parts are defined); elsewhere an edge passes through a cube anyway
  const oneAxis = c.config.pieces.every((p) => p.u.filter((x) => Math.abs(x) + 0.5 > s / 2).length <= 1);
  if (c.piece === "cube" && inside && oneAxis) {
    res.parts = pieceParts(T, "cube", c.config).map((part) => {
      const m = partMesh(T, "cube", part, s)!;
      const lo = [0, 1, 2].map((k) => Math.min(...m.vertices.map((v) => v[k])));
      const hi = [0, 1, 2].map((k) => Math.max(...m.vertices.map((v) => v[k])));
      return [part.piece, part.cell, lo, hi];
    });
  }
  return res;
});
const count = (f: (r: Record<string, unknown>) => boolean) => results.filter(f).length;
writeFileSync(
  out,
  JSON.stringify({
    note: "generated by packages/boundary/scripts/gen-crosscheck.ts (random seed 20261025); TypeScript engine verdicts at tol 1e-9 and 0, chain distances (reach 1.25 for balls of diameter 1) and cube parts",
    cases: results,
  }),
);
console.log(
  `wrote ${results.length} cases (${count((r) => r.ts_valid_1e9 === true)} valid at tol 1e-9, ${count((r) => r.ts_valid_0 === true)} at tol 0) in ${((performance.now() - t0) / 1000).toFixed(2)} s`,
);
