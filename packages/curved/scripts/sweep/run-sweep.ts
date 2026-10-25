/**
 * Curvature sweep of one problem (N, M, P): ground state s*(K), branches, events, certification prep.
 *
 *   npx tsx packages/curved/scripts/sweep/run-sweep.ts --N 0 --M 0 --P 7 --Kmin -2 --Kmax 0.65 --out FILE.json
 *        [--seeds 3 --hops 12 --solveStep 0.25 --relCut 0.05 --certEvery 4]
 *
 * 1. Seeds: seeded multistart solves (restarts 1, one configuration per seed) at every multiple of
 *    solveStep, the Euclidean record (data/records.json, re-centred) at K = 0, and every curved record
 *    of the same (N, M, P) in data/curved/records.json, each polished at the nearest grid K.
 * 2. Branches: every competitive seed (within relCut of the best known size at its K) is followed in
 *    both directions over [Kmin, Kmax] (src/sweep.ts followBranch); fold destinations become new seeds.
 *    A branch stops when it joins an existing branch or becomes uncompetitive.
 * 3. Ground state: lower envelope over branches on the grid (multiples of 1/64, exact rationals).
 * 4. Events: crossings of the envelope (root of s_A - s_B by bisection), contact and symmetry changes
 *    along optimal branches (bisection), branch ends, one-sided slopes at K = 0.
 * 4a. Optional (rerun): --solveOnResume 1 --seedOffset k adds new multistart solves to a resumed run;
 *    --hopEvery n runs warm-started basin hopping from the lowest configuration every n grid values;
 *    --maxBranches, --refineEvery, --refineTrials, --refineSigmas set the budgets.
 * 4b. Refinement (rounds): at every second grid K the lowest configuration is perturbed (sigma 1e-3,
 *    2e-2, 8e-2; two trials each) and re-polished; anything lower becomes a seed and is followed.
 *    --resume RUN.json reuses an earlier run's branches and skips the solves.
 * 5. Certification prep: margin re-solve (certifyPrep) of the ground state every certEvery grid points
 *    and of both branches at every crossing (at K_c and at the bracketing grid values).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extremePoints, enclosingCircle, enclosingPolygon, type Pose } from "@polypack/geometry";
import { certifyPrep, solve, type CurvedConfig, type CurvedProblem } from "../../src/index";
import { gaussian, rng } from "../../src/optim";
import { dSideDApothem } from "../../src/shapes";
import {
  bisectChange,
  feasibleAt,
  followBranch,
  makePoint,
  rootBisect,
  sameConfig,
  tryPolish,
  type BranchEnd,
  type SweepPoint,
} from "../../src/sweep";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def === undefined) throw new Error(`missing --${name}`);
  return def;
}

const N = Number(arg("N"));
const M = Number(arg("M"));
const P = Number(arg("P"));
const Kmin = Number(arg("Kmin"));
const Kmax = Number(arg("Kmax"));
const out = arg("out");
const nSeeds = Number(arg("seeds", "3"));
const hops = Number(arg("hops", "12"));
const solveStep = Number(arg("solveStep", "0.25"));
const relCut = Number(arg("relCut", "0.08"));
const certEvery = Number(arg("certEvery", "4"));
// --resume RUN.json: reuse the branches and solves of an earlier run (no new multistart solves)
const resumeFile = process.argv.includes("--resume") ? arg("resume") : undefined;
// refinement rounds: perturb-and-polish the lowest configuration along K, follow anything lower
const refineRounds = Number(arg("refine", "3"));
// deeper searches (rerun): new multistart solves also when resuming, with a seed offset so that the
// seeds differ from the earlier run; warm-started basin hopping from the lowest configuration every
// hopEvery grid values; denser refinement; a larger branch budget
const solveOnResume = arg("solveOnResume", "0") === "1";
const seedOffset = Number(arg("seedOffset", "0"));
const maxBranches = Number(arg("maxBranches", "60"));
const hopEvery = Number(arg("hopEvery", "0"));
const hopHops = Number(arg("hopHops", "20"));
const refineEvery = Number(arg("refineEvery", "2"));
const refineTrials = Number(arg("refineTrials", "2"));
const refineSigmas = arg("refineSigmas", "0.001,0.02,0.08").split(",").map(Number);
const GRID = 1 / 64;
const problem: CurvedProblem = { N, M, P };
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

const gi = (K: number) => Math.round(K / GRID);
const gridKs: number[] = [];
for (let j = Math.ceil(Kmin / GRID - 1e-9); j <= Math.floor(Kmax / GRID + 1e-9); j++) gridKs.push(j * GRID);

interface Branch {
  id: number;
  seed: string;
  seedK: number;
  points: SweepPoint[];
  low: BranchEnd;
  high: BranchEnd;
  byGrid: Map<number, SweepPoint>;
}
const branches: Branch[] = [];
const env = new Map<number, { s: number; b: number }>();

interface Seed {
  K: number;
  config: CurvedConfig;
  source: string;
}
const seeds: Seed[] = [];

// --- Euclidean record at K = 0
function euclideanSeed(): Seed | undefined {
  const recs = JSON.parse(readFileSync(join(root, "data/records.json"), "utf8")).records as {
    N: number;
    M: number;
    P: number;
    value: number;
    pieces?: Pose[];
    container_phi?: number;
    status?: string;
  }[];
  const r = recs.find((q) => q.N === N && q.M === M && q.P === P && q.pieces && q.pieces.length === P);
  if (!r || !r.pieces) return undefined;
  const set = extremePoints(N, r.pieces);
  const c = M === 0 ? enclosingCircle(set) : enclosingPolygon(set, M, r.container_phi ?? 0);
  const phi = M === 0 ? 0 : c.phi;
  const co = Math.cos(-phi);
  const si = Math.sin(-phi);
  const pieces = r.pieces.map((p) => {
    const dx = p.x - c.cx;
    const dy = p.y - c.cy;
    return { x: co * dx - si * dy, y: si * dx + co * dy, theta: p.theta - phi };
  });
  return { K: 0, config: { size: c.size * (1 + 1e-9), pieces }, source: `euclidean record ${r.value} (${r.status})` };
}
const eu = euclideanSeed();
const euclid = eu ? { value: eu.config.size / (1 + 1e-9), source: eu.source } : undefined;
if (eu && Kmin <= 0 && Kmax >= 0) seeds.push(eu);

// --- curved records of the same problem
{
  const d = JSON.parse(readFileSync(join(root, "data/curved/records.json"), "utf8"));
  for (const r of d.records)
    if (r.N === N && r.M === M && r.P === P && (r.config_touching || r.config)) {
      const Kg = Math.round(r.K / GRID) * GRID;
      if (Kg < Kmin || Kg > Kmax) continue;
      seeds.push({ K: Kg, config: r.config_touching ?? r.config, source: `curved record ${r.id}` });
    }
}

// --- fresh seeded multistart solves
const solveKs: number[] = [];
for (let j = Math.ceil(Kmin / solveStep - 1e-9); j <= Math.floor(Kmax / solveStep + 1e-9); j++) solveKs.push(j * solveStep);
const resumed = resumeFile ? JSON.parse(readFileSync(resumeFile, "utf8")) : undefined;
const solves: { K: number; seed: number; found: boolean; size?: number }[] = resumed ? resumed.solves : [];
for (const K of resumed && !solveOnResume ? [] : solveKs) {
  for (let s = 1; s <= nSeeds; s++) {
    const seed = 7919 * (gi(K) + 1000) + 31 * s + 1009 * N + 13 * M + P + 104729 * seedOffset;
    let res;
    try {
      res = solve(problem, K, { seed, restarts: 1, hops });
    } catch (e) {
      solves.push({ K, seed, found: false });
      continue;
    }
    solves.push({ K, seed, found: res.found, size: res.config?.size });
    if (res.found && res.config) seeds.push({ K, config: res.config, source: `solve seed ${seed} (restarts 1, hops ${hops})` });
  }
  const best = Math.min(...solves.filter((q) => q.K === K && q.found).map((q) => q.size as number));
  log(`solve K=${K}: best ${Number.isFinite(best) ? best.toFixed(6) : "none"}`);
}

// --- polish seeds at their grid K
interface PSeed {
  K: number;
  pt: SweepPoint;
  pc: NonNullable<ReturnType<typeof tryPolish>>;
  source: string;
}
const pseeds: PSeed[] = [];
for (const s of seeds) {
  const pc = tryPolish(problem, s.K, s.config, 600);
  if (!pc || !feasibleAt(problem, s.K, pc)) continue;
  pseeds.push({ K: s.K, pt: makePoint(problem, s.K, pc, true), pc, source: s.source });
}
// order: best relative size at each K first
const bestAt = new Map<number, number>();
for (const s of pseeds) bestAt.set(gi(s.K), Math.min(bestAt.get(gi(s.K)) ?? Infinity, s.pt.size));
pseeds.sort((a, b) => a.pt.size / (bestAt.get(gi(a.K)) as number) - b.pt.size / (bestAt.get(gi(b.K)) as number));

function envAt(K: number): number {
  return env.get(gi(K))?.s ?? Infinity;
}

function findSame(pt: SweepPoint, except: number): number | undefined {
  for (const b of branches) {
    if (b.id === except) continue;
    const q = b.byGrid.get(gi(pt.K));
    if (q && sameConfig(pt, q)) return b.id;
  }
  return undefined;
}

function runBranch(seedK: number, start: NonNullable<ReturnType<typeof tryPolish>>, source: string, queue: PSeed[]): Branch | undefined {
  const id = branches.length;
  const b: Branch = {
    id,
    seed: source,
    seedK,
    points: [],
    low: { K: seedK, kind: "range" },
    high: { K: seedK, kind: "range" },
    byGrid: new Map(),
  };
  branches.push(b);
  const onGrid = (p: SweepPoint) => {
    const other = findSame(p, id);
    b.byGrid.set(gi(p.K), p);
    if (other !== undefined) return { kind: "merge" as const, mergeWith: other };
    const e = envAt(p.K);
    if (p.size > e * (1 + relCut) + 1e-9) return { kind: "uncompetitive" as const, note: `above ${1 + relCut} x best` };
    if (p.size < e) env.set(gi(p.K), { s: p.size, b: id });
    return undefined;
  };
  // register the seed point
  const sp = makePoint(problem, seedK, start, Math.abs(seedK / GRID - Math.round(seedK / GRID)) < 1e-9);
  if (sp.grid) {
    b.byGrid.set(gi(seedK), sp);
    if (sp.size < envAt(seedK)) env.set(gi(seedK), { s: sp.size, b: id });
  }
  const up = followBranch(problem, seedK, start, Kmax, { grid: GRID, onGrid });
  const down = followBranch(problem, seedK, start, Kmin, { grid: GRID, onGrid });
  b.points = [...down.points.slice(1).reverse(), ...up.points];
  b.low = down.end;
  b.high = up.end;
  for (const end of [down.end, up.end])
    if (end.kind === "fold" && end.jumpTo && end.jumpK !== undefined) {
      const pc = tryPolish(problem, end.jumpK, end.jumpTo, 600);
      if (pc && feasibleAt(problem, end.jumpK, pc))
        queue.push({ K: end.jumpK, pt: makePoint(problem, end.jumpK, pc, false), pc, source: `jump from branch ${id} fold at K=${end.K}` });
    }
  log(
    `branch ${id} [${source}] K ${b.points[0].K.toFixed(4)}..${b.points[b.points.length - 1].K.toFixed(4)} ends ${down.end.kind}/${up.end.kind} pts ${b.points.length} polishes ${up.polishes + down.polishes}`,
  );
  return b;
}

// --- earlier branches (resume)
if (resumed) {
  for (const rb of resumed.branches) {
    const b: Branch = { id: branches.length, seed: rb.seed, seedK: rb.seedK, points: rb.points, low: rb.low, high: rb.high, byGrid: new Map() };
    for (const p of rb.points as SweepPoint[])
      if (p.grid) {
        b.byGrid.set(gi(p.K), p);
        if (p.size < envAt(p.K)) env.set(gi(p.K), { s: p.size, b: b.id });
      }
    branches.push(b);
  }
  log(`resumed ${branches.length} branches from ${resumeFile}`);
}

// --- follow seeds
function processQueue(queue: PSeed[]) {
  let guard = 0;
  while (queue.length > 0 && guard++ < 400 + 4 * maxBranches && branches.length < maxBranches) {
    const s = queue.shift() as PSeed;
    if (s.pt.grid) {
      const e = envAt(s.K);
      if (s.pt.size > e * (1 + relCut) + 1e-9) continue;
      if (findSame(s.pt, -1) !== undefined) continue;
      // level dedupe: a seed with the same size as a branch already through this K adds nothing to the
      // envelope there (degenerate Euclidean optima form continua whose members mostly fold at |K| ~ 1e-6)
      if (branches.some((b) => {
        const q = b.byGrid.get(gi(s.K));
        return q !== undefined && Math.abs(q.size - s.pt.size) <= 1e-9 * Math.max(1, q.size);
      }))
        continue;
    } else {
      // jump seeds: skip if a branch already passes through an equivalent point at the nearest grid K
      const Kg = Math.round(s.K / GRID) * GRID;
      const pc = tryPolish(problem, Kg, s.pc.config);
      if (pc && feasibleAt(problem, Kg, pc)) {
        const q = makePoint(problem, Kg, pc, true);
        if (findSame(q, -1) !== undefined) continue;
        if (q.size > envAt(Kg) * (1 + relCut) + 1e-9) continue;
      }
    }
    runBranch(s.K, s.pc, s.source, queue);
  }
}
processQueue([...pseeds]);

// --- warm-started basin hopping from the lowest configuration (every hopEvery grid values)
if (hopEvery > 0) {
  const found: PSeed[] = [];
  const js = [...env.keys()].sort((a, b) => a - b).filter((j) => j % hopEvery === 0);
  for (const j of js) {
    const K = j * GRID;
    const e = env.get(j) as { s: number; b: number };
    const p = branches[e.b].byGrid.get(j);
    if (!p) continue;
    const seed = 7919 * (j + 1000) + 1009 * N + 13 * M + P + 104729 * (seedOffset + 7);
    let res;
    try {
      res = solve(problem, K, { seed, restarts: 1, hops: hopHops, start: { size: p.size, pieces: p.pieces } });
    } catch {
      continue;
    }
    if (!res.found || !res.config) continue;
    const pc = tryPolish(problem, K, res.config, 600);
    if (!pc || !feasibleAt(problem, K, pc)) continue;
    if (pc.config.size < e.s - Math.max(1e-9 * e.s, 1e-10))
      found.push({ K, pt: makePoint(problem, K, pc, true), pc, source: `basin hopping (${hopHops} hops, seed ${seed}) from branch ${e.b}` });
  }
  log(`basin hopping: ${found.length} of ${js.length} grid values improved`);
  found.sort((a, b) => a.pt.size / envAt(a.K) - b.pt.size / envAt(b.K));
  processQueue(found);
}

// --- refinement: perturb-and-polish the lowest configuration along K
{
  const Rr = rng(4242 + 1009 * N + 13 * M + P);
  for (let round = 0; round < refineRounds; round++) {
    const found: PSeed[] = [];
    const js = [...env.keys()].sort((a, b) => a - b).filter((j) => j % refineEvery === 0);
    for (const j of js) {
      const K = j * GRID;
      const e = env.get(j) as { s: number; b: number };
      const p = branches[e.b].byGrid.get(j);
      if (!p) continue;
      let best: PSeed | undefined;
      for (const sigma of refineSigmas)
        for (let t = 0; t < refineTrials; t++) {
          const pieces = p.pieces.map((q) => ({ x: q.x + sigma * gaussian(Rr), y: q.y + sigma * gaussian(Rr), theta: q.theta + sigma * gaussian(Rr) }));
          const pc = tryPolish(problem, K, { size: p.size * (1 + 1e-4), pieces });
          if (!pc || !feasibleAt(problem, K, pc)) continue;
          if (pc.config.size < e.s - Math.max(1e-9 * e.s, 1e-10) && (!best || pc.config.size < best.pt.size))
            best = { K, pt: makePoint(problem, K, pc, true), pc, source: `refine round ${round}: perturbation ${sigma} of branch ${e.b}` };
        }
      if (best) found.push(best);
    }
    log(`refine round ${round}: ${found.length} grid values improved`);
    if (found.length === 0) break;
    found.sort((a, b) => a.pt.size / envAt(a.K) - b.pt.size / envAt(b.K));
    processQueue(found);
  }
}

// --- ground state on the grid
const ground: { K: number; s: number; b: number; density: number; dsdK: number; sym: string; family: string }[] = [];
for (const K of gridKs) {
  let best: { s: number; b: number; p: SweepPoint } | undefined;
  for (const b of branches) {
    const p = b.byGrid.get(gi(K));
    if (p && (!best || p.size < best.s - 1e-12)) best = { s: p.size, b: b.id, p };
  }
  if (best) ground.push({ K, s: best.s, b: best.b, density: best.p.density, dsdK: best.p.dsdK, sym: best.p.sym, family: best.p.family });
}
log(`ground state on ${ground.length}/${gridKs.length} grid points; ${branches.length} branches`);

// --- events
interface SweepEvent {
  kind: string;
  K: number;
  Klo?: number;
  Khi?: number;
  branch?: number;
  from?: number;
  to?: number;
  s?: number;
  slopeLeft?: number;
  slopeRight?: number;
  d2Left?: number;
  d2Right?: number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  note?: string;
}
const events: SweepEvent[] = [];

function nearestPoint(b: Branch, K: number): SweepPoint | undefined {
  let best: SweepPoint | undefined;
  for (const p of b.points) if (!best || Math.abs(p.K - K) < Math.abs(best.K - K)) best = p;
  return best;
}
function sizeOn(b: Branch, K: number, from?: CurvedConfig): number {
  const p = from ?? (nearestPoint(b, K) as SweepPoint);
  const cfg = "pieces" in p ? { size: p.size, pieces: p.pieces } : (p as CurvedConfig);
  const pc = tryPolish(problem, K, cfg);
  return pc && feasibleAt(problem, K, pc) ? pc.config.size : NaN;
}
function desc(p: SweepPoint) {
  return { size: p.size, sym: p.sym, family: p.family, contacts: p.contacts.length, rattlers: p.rattlers, dsdK: p.dsdK };
}
/** One-sided slopes and second differences at K along a branch, polishing from cfg. */
function localSlopes(cfg: CurvedConfig, K: number, d = 2e-4) {
  const at = (k: number) => {
    const pc = tryPolish(problem, k, cfg);
    return pc && feasibleAt(problem, k, pc) ? pc.config.size : NaN;
  };
  const s0 = at(K);
  const m1 = at(K - d);
  const m2 = at(K - 2 * d);
  const p1 = at(K + d);
  const p2 = at(K + 2 * d);
  return {
    s0,
    left: (s0 - m1) / d,
    right: (p1 - s0) / d,
    d2Left: (s0 - 2 * m1 + m2) / (d * d),
    d2Right: (p2 - 2 * p1 + s0) / (d * d),
  };
}

// crossings of the envelope
for (let k = 0; k + 1 < ground.length; k++) {
  const g0 = ground[k];
  const g1 = ground[k + 1];
  if (g0.b === g1.b || Math.abs(g1.K - g0.K - GRID) > 1e-12) continue;
  const A = branches[g0.b];
  const B = branches[g1.b];
  const a0 = A.byGrid.get(gi(g0.K));
  const a1 = A.byGrid.get(gi(g1.K));
  const b0 = B.byGrid.get(gi(g0.K));
  const b1 = B.byGrid.get(gi(g1.K));
  if (a0 && a1 && b0 && b1) {
    // difference changes sign on [K0, K1]; locate by bisection, polishing each branch from its grid config
    const f = (K: number) => {
      const ca = K - g0.K < g1.K - K ? a0 : a1;
      const cb = K - g0.K < g1.K - K ? b0 : b1;
      return sizeOn(A, K, { size: ca.size, pieces: ca.pieces }) - sizeOn(B, K, { size: cb.size, pieces: cb.pieces });
    };
    const fa = f(g0.K);
    const fb = f(g1.K);
    let Kc: number;
    let note: string | undefined;
    if (fa <= 0 && fb >= 0) Kc = rootBisect(f, g0.K, g1.K, 1e-13);
    else {
      Kc = (g0.K + g1.K) / 2;
      note = `no sign change on the polished branches (f=${fa}, ${fb}); within polish noise`;
    }
    const sa = localSlopes({ size: a0.size, pieces: a0.pieces }, Kc);
    const sb = localSlopes({ size: b1.size, pieces: b1.pieces }, Kc);
    // equal slopes and equal values: the two branches coincide there (same configuration up to labels/rattlers)
    const tangent = Math.abs(sa.left - sb.right) < 2e-3 * (1 + Math.abs(sa.left)) && Math.abs(sa.s0 - sb.s0) < 1e-8 * sa.s0;
    events.push({
      kind: tangent ? "coincide" : "crossing",
      K: Kc,
      Klo: g0.K,
      Khi: g1.K,
      from: A.id,
      to: B.id,
      s: sa.s0,
      slopeLeft: sa.left,
      slopeRight: sb.right,
      before: { ...desc(a0), slopeA: [sa.left, sa.right], d2A: [sa.d2Left, sa.d2Right] },
      after: { ...desc(b1), slopeB: [sb.left, sb.right], d2B: [sb.d2Left, sb.d2Right], sB: sb.s0 },
      note,
    });
    log(`crossing ${A.id}->${B.id} at K=${Kc.toFixed(10)} s=${sa.s0.toFixed(8)} slopes ${sa.left.toFixed(5)} | ${sb.right.toFixed(5)}`);
  } else {
    events.push({
      kind: "handover",
      K: (g0.K + g1.K) / 2,
      Klo: g0.K,
      Khi: g1.K,
      from: A.id,
      to: B.id,
      note: `branches do not both exist on [${g0.K}, ${g1.K}] (A: ${!!a0}/${!!a1}, B: ${!!b0}/${!!b1})`,
    });
  }
}

// contact / symmetry changes along branches that are optimal somewhere
const optimal = [...new Set(ground.map((g) => g.b))];
for (const id of optimal) {
  const b = branches[id];
  const pts = b.points.filter((p) => p.grid);
  let count = 0;
  for (let k = 0; k + 1 < pts.length && count < 60; k++) {
    const p = pts[k];
    const q = pts[k + 1];
    const cSame = p.contacts.join() === q.contacts.join() && p.rattlers.join() === q.rattlers.join();
    const sSame = p.sym === q.sym;
    if (cSame && sSame) continue;
    count++;
    const what = !cSame ? "contact" : "symmetry";
    const pred = (pc: NonNullable<ReturnType<typeof tryPolish>>, K: number) => {
      const pt = makePoint(problem, K, pc, false);
      return what === "contact"
        ? pt.contacts.join() === p.contacts.join() && pt.rattlers.join() === p.rattlers.join()
        : pt.sym === p.sym;
    };
    const bis = bisectChange(problem, p.K, q.K, { size: p.size, pieces: p.pieces }, pred, 36);
    const Ke = (bis.lo + bis.hi) / 2;
    const sl = localSlopes(bis.atLo ? bis.atLo.config : { size: p.size, pieces: p.pieces }, Ke, 1e-4);
    const added = q.contacts.filter((c) => !p.contacts.includes(c));
    const removed = p.contacts.filter((c) => !q.contacts.includes(c));
    const isOpt = ground.some((g) => g.b === id && Math.abs(g.K - p.K) < 1e-12) || ground.some((g) => g.b === id && Math.abs(g.K - q.K) < 1e-12);
    events.push({
      kind: what,
      K: Ke,
      Klo: bis.lo,
      Khi: bis.hi,
      branch: id,
      s: sl.s0,
      slopeLeft: sl.left,
      slopeRight: sl.right,
      d2Left: sl.d2Left,
      d2Right: sl.d2Right,
      before: { ...desc(p), contactSet: p.contacts },
      after: { ...desc(q), contactSet: q.contacts, added, removed },
      note: isOpt ? "on the ground state" : "on a metastable stretch",
    });
  }
}
// branch ends
for (const b of branches) {
  for (const [side, end] of [
    ["low", b.low],
    ["high", b.high],
  ] as const) {
    if (end.kind === "range" || end.kind === "merge" || end.kind === "uncompetitive") continue;
    const p = side === "low" ? b.points[0] : b.points[b.points.length - 1];
    events.push({
      kind: `end:${end.kind}`,
      K: end.K,
      branch: b.id,
      s: p.size,
      before: desc(p),
      after: end.jumpTo ? { size: end.jumpTo.size, jumpK: end.jumpK } : undefined,
      note: `${side} end of branch ${b.id}${end.note ? ": " + end.note : ""}`,
    });
  }
}
// K = 0 one-sided slopes of every branch through 0
const k0: { branch: number; s0: number; left: number; right: number; leftFar: number; rightFar: number; optimal: boolean }[] = [];
for (const b of branches) {
  const p = b.byGrid.get(0);
  if (!p) continue;
  const cfg = { size: p.size, pieces: p.pieces };
  const near = localSlopes(cfg, 0, 1e-4);
  const far = localSlopes(cfg, 0, 2e-3);
  k0.push({
    branch: b.id,
    s0: near.s0,
    left: near.left,
    right: near.right,
    leftFar: far.left,
    rightFar: far.right,
    optimal: ground.some((g) => g.K === 0 && g.b === b.id),
  });
}

// --- certification prep
interface CertRec {
  id: string;
  K: number;
  N: number;
  M: number;
  P: number;
  role: string;
  branch: number;
  score_float: number;
  score_cert: number;
  config_cert: CurvedConfig;
  witnesses: unknown;
  margin: number;
  validation_cert: { valid: boolean; minGap: number };
}
const certs: CertRec[] = [];
function prep(K: number, cfg: CurvedConfig, role: string, branch: number) {
  const pc = tryPolish(problem, K, cfg, 600);
  if (!pc || !feasibleAt(problem, K, pc)) return;
  const dsdt = dSideDApothem(M, K, pc.polish.t);
  const mu = Math.min(4e-11, Math.max(2e-12, 4e-11 / Math.max(1, dsdt / 2)));
  let cp;
  try {
    cp = certifyPrep(problem, K, pc.config, mu, 600);
  } catch {
    return;
  }
  if (!cp.validation.valid) return;
  certs.push({
    id: `curved/${K}/${N}/${M}/${P}#${role}`,
    K,
    N,
    M,
    P,
    role,
    branch,
    score_float: Math.min(pc.config.size, cp.config.size),
    score_cert: cp.config.size,
    config_cert: cp.config,
    witnesses: cp.witnesses,
    margin: mu,
    validation_cert: { valid: cp.validation.valid, minGap: cp.validation.minGap },
  });
}
ground.forEach((g, k) => {
  if (k % certEvery !== 0 && k !== ground.length - 1) return;
  const p = branches[g.b].byGrid.get(gi(g.K)) as SweepPoint;
  prep(g.K, { size: p.size, pieces: p.pieces }, `ground b${g.b}`, g.b);
});
for (const e of events) {
  if (e.kind !== "crossing" || e.from === undefined || e.to === undefined) continue;
  for (const id of [e.from, e.to]) {
    const b = branches[id];
    for (const K of [e.Klo as number, e.Khi as number]) {
      const p = b.byGrid.get(gi(K));
      if (p) prep(K, { size: p.size, pieces: p.pieces }, `crossing b${e.from}->b${e.to} branch ${id} grid`, id);
    }
    const p = nearestPoint(b, e.K) as SweepPoint;
    prep(e.K, { size: p.size, pieces: p.pieces }, `crossing b${e.from}->b${e.to} branch ${id} at Kc`, id);
  }
}
log(`certification prep: ${certs.length} configurations`);

const result = {
  problem,
  Kmin,
  Kmax,
  grid: GRID,
  params: { nSeeds, hops, solveStep, relCut, certEvery },
  euclidean: euclid,
  solves,
  branches: branches.map((b) => ({ id: b.id, seed: b.seed, seedK: b.seedK, low: { ...b.low, jumpTo: undefined }, high: { ...b.high, jumpTo: undefined }, points: b.points })),
  ground,
  events,
  k0,
  certs,
  seconds: (Date.now() - t0) / 1000,
};
writeFileSync(out, JSON.stringify(result));
log(`wrote ${out}`);
