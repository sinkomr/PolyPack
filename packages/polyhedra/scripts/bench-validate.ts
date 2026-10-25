/**
 * Times the float validator: every record of data/polyhedra/records.json at PolyPack's tolerance (as a server
 * checks a submission), and adversarial worst cases (all pieces in near contact on a tight grid, and all pieces
 * coincident) for the heaviest solids at P = 30.
 *
 * Usage: npx tsx packages/polyhedra/scripts/bench-validate.ts [records.json]
 */
import { readFileSync } from "node:fs";
import { type Pose, getProblem, getSolid, validatePolyhedra } from "../src/index";

const path = process.argv[2] ?? new URL("../../../data/polyhedra/records.json", import.meta.url).pathname;
const doc = JSON.parse(readFileSync(path, "utf8"));
const time = (f: () => unknown, reps = 3) => {
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    f();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
};
// warm up the JIT
for (const r of doc.records.slice(0, 200)) validatePolyhedra(getProblem(r.code)!, r.config);
let worst = { ms: 0, id: "" };
let total = 0;
for (const r of doc.records) {
  const ms = time(() => validatePolyhedra(getProblem(r.code)!, r.config), 1);
  total += ms;
  if (ms > worst.ms) worst = { ms, id: r.id };
}
const w = doc.records.find((r: { id: string }) => r.id === worst.id);
const wms = time(() => validatePolyhedra(getProblem(w.code)!, w.config), 5);
console.log(`records: ${doc.records.length} validated in ${(total / 1000).toFixed(2)} s; slowest ${worst.id} ${wms.toFixed(1)} ms`);
// strict check too (as for a submission that beats a record)
console.log(`  slowest again at tol 1e-11: ${time(() => validatePolyhedra(getProblem(w.code)!, w.config, { tol: 1e-11 }), 5).toFixed(1)} ms`);

import { place, separation } from "../src/index";
import { mulberry32, gauss } from "../src/sim/sim";
const rng = mulberry32(7);
const randQ = () => {
  const q = [gauss(rng), gauss(rng), gauss(rng), gauss(rng)];
  return q.map((x) => x / Math.hypot(...q));
};
for (const code of ["tidintid", "dtcindtc", "phcinphc", "sndinsnd", "tdointdo", "pr12incub", "ap12incub", "pr3l3incub", "cubincub"]) {
  const p = getProblem(code)!;
  const P = getSolid(p.piece);
  const n = 30;
  // 1. a valid grid of axis-aligned pieces, neighbours 1e-9 apart: every neighbour pair is near
  const h = [0, 1, 2].map((k) => Math.max(...Array.from({ length: P.nv }, (_, v) => P.V[3 * v + k])));
  const grid: Pose[] = [];
  for (let i = 0; i < n; i++)
    grid.push([(i % 4) * (2 * h[0] + 1e-9), (Math.floor(i / 4) % 4) * (2 * h[1] + 1e-9), Math.floor(i / 16) * (2 * h[2] + 1e-9), 1, 0, 0, 0]);
  const g = validatePolyhedra(p, { s: 1e3, pieces: grid });
  const tGrid = time(() => validatePolyhedra(p, { s: 1e3, pieces: grid }));
  // 2. the cost of one full separating-axis scan (every candidate axis projected), on random near pairs
  const pairs: [ReturnType<typeof place>, ReturnType<typeof place>][] = [];
  for (let k = 0; k < 40; k++) {
    const u = [gauss(rng), gauss(rng), gauss(rng)];
    const l = Math.hypot(...u);
    const d = 1.9 * P.circumradius;
    pairs.push([place(P, [0, 0, 0, ...randQ()] as Pose), place(P, [(d * u[0]) / l, (d * u[1]) / l, (d * u[2]) / l, ...randQ()] as Pose)]);
  }
  let axes = 0;
  const tFull = time(() => {
    for (const [a, b] of pairs) axes += separation(a, b, Infinity, [0, 0, 1]).axes;
  }) / pairs.length;
  console.log(
    `${code} P=30 (V=${P.nv}, F=${P.faces.length}, E=${P.edges.length}): valid grid ${g.pairsTested} near pairs ${tGrid.toFixed(1)} ms (valid ${g.valid}); full scan ${(tFull * 1000).toFixed(0)} us per pair (${Math.round(axes / pairs.length / 3)} axes), so all 435 pairs at most ${(435 * tFull).toFixed(0)} ms`,
  );
}
