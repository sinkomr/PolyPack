/**
 * Event analysis of a curvature sweep (output of run-sweep.ts). Re-runnable without new searches.
 *
 *   npx tsx packages/curved/scripts/sweep/analyze.ts RUN.json OUT.json
 *
 * - ground state s*(K) on the grid = lower envelope of all branches;
 * - crossings: where the lowest branch changes between grid points, the root of s_A - s_B on the
 *   interval where both branches exist (including sub-step points near folds), by bisection with
 *   polished configurations; one-sided slopes of each branch there by finite differences;
 * - "gap" if the two branches never coexist on the interval (would mean a discontinuity of the best
 *   found curve, i.e. a search failure, since s* is continuous);
 * - stability probe: perturb a branch configuration (3 trials, sigma 1e-3) and re-polish; a lower size
 *   means the configuration is a saddle (symmetric branches can be tracked past their stability loss
 *   because the polish keeps exact symmetry); changes of stability along a branch are located by bisection;
 * - contact-graph and symmetry changes along branches that are lowest somewhere (bisection), with
 *   one-sided slopes and second differences;
 * - folds (branch ends where descent jumps; jump size), asymptote and hemisphere ends;
 * - one-sided slopes at K = 0;
 * - asymptote: for polygon containers whose lowest branch ends at the negative end, kPolish from the
 *   last configuration gives a* (P pieces fit iff sqrt(-K) < a*) and the fit s = -alpha ln(K - K_inf) + beta;
 * - certification prep: margin re-solve of the ground state every 4th grid value and of both
 *   branches at every crossing (at K_c and the bracketing grid values).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { certifyPrep, type CurvedConfig, type CurvedPose, type CurvedProblem } from "../../src/index";
import { dSideDApothem } from "../../src/shapes";
import { kPolish } from "../../src/ideal";
import { rng, gaussian } from "../../src/optim";
import { bisectChange, feasibleAt, followBranch, makePoint, rootBisect, tryPolish, type SweepPoint } from "../../src/sweep";

const [inFile, outFile] = process.argv.slice(2);
const run = JSON.parse(readFileSync(inFile, "utf8"));
const problem: CurvedProblem = run.problem;
const { N, M, P } = problem;
const GRID: number = run.grid;
const gi = (K: number) => Math.round(K / GRID);
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

interface Br {
  id: number;
  seed: string;
  points: SweepPoint[];
  low: { K: number; kind: string; note?: string };
  high: { K: number; kind: string; note?: string };
  byGrid: Map<number, SweepPoint>;
}
const branches: Br[] = run.branches.map((b: any) => {
  const byGrid = new Map<number, SweepPoint>();
  for (const p of b.points) if (p.grid) byGrid.set(gi(p.K), p);
  return { id: b.id, seed: b.seed, points: b.points, low: b.low, high: b.high, byGrid };
});
const cfgOf = (p: SweepPoint): CurvedConfig => ({ size: p.size, pieces: p.pieces });
const kMin = (b: Br) => b.points[0].K;
const kMax = (b: Br) => b.points[b.points.length - 1].K;
function nearest(b: Br, K: number): SweepPoint {
  let best = b.points[0];
  for (const p of b.points) if (Math.abs(p.K - K) < Math.abs(best.K - K)) best = p;
  return best;
}
function sizeAt(b: Br, K: number): number {
  const pc = tryPolish(problem, K, cfgOf(nearest(b, K)));
  return pc && feasibleAt(problem, K, pc) ? pc.config.size : NaN;
}
function slopesAt(cfg: CurvedConfig, K: number, d = 2e-4) {
  const at = (k: number) => {
    const pc = tryPolish(problem, k, cfg);
    return pc && feasibleAt(problem, k, pc) ? pc.config.size : NaN;
  };
  const s0 = at(K),
    m1 = at(K - d),
    m2 = at(K - 2 * d),
    p1 = at(K + d),
    p2 = at(K + 2 * d);
  return { s0, left: (s0 - m1) / d, right: (p1 - s0) / d, d2Left: (s0 - 2 * m1 + m2) / (d * d), d2Right: (p2 - 2 * p1 + s0) / (d * d) };
}
const desc = (p: SweepPoint) => ({ size: p.size, sym: p.sym, family: p.family, contacts: p.contacts.length, rattlers: p.rattlers, dsdK: p.dsdK, density: p.density });

// ---------------- ground state
const gridKs = [...new Set(branches.flatMap((b) => [...b.byGrid.keys()]))].sort((a, b) => a - b).map((j) => j * GRID);
const ground: { K: number; s: number; b: number; density: number; sym: string; family: string }[] = [];
for (const K of gridKs) {
  let best: { b: Br; p: SweepPoint } | undefined;
  for (const b of branches) {
    const p = b.byGrid.get(gi(K));
    if (p && (!best || p.size < best.p.size - 1e-12)) best = { b, p };
  }
  if (best) ground.push({ K, s: best.p.size, b: best.b.id, density: best.p.density, sym: best.p.sym, family: best.p.family });
}
// smooth out polish-noise flicker: if two branches are within 1e-9 relative at a grid K, prefer the previous one
for (let k = 1; k < ground.length; k++) {
  const prev = ground[k - 1].b;
  if (ground[k].b === prev) continue;
  const q = branches[prev].byGrid.get(gi(ground[k].K));
  if (q && q.size - ground[k].s <= 1e-9 * ground[k].s) {
    ground[k] = { ...ground[k], s: q.size, b: prev, density: q.density, sym: q.sym, family: q.family };
  }
}
const optimalIds = [...new Set(ground.map((g) => g.b))];
log(`ground ${ground.length} points, ${optimalIds.length} optimal branches of ${branches.length}`);

// ---------------- events
interface Ev {
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
  kink?: number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  onGround?: boolean;
  note?: string;
}
const events: Ev[] = [];

for (let k = 0; k + 1 < ground.length; k++) {
  const g0 = ground[k],
    g1 = ground[k + 1];
  if (g0.b === g1.b || Math.abs(g1.K - g0.K - GRID) > 1e-12) continue;
  const A = branches[g0.b],
    B = branches[g1.b];
  // both branches are polished from their nearest stored point, also slightly beyond their stored range
  // (branches stopped by a merge continue as the branch they joined); shrink to the coexistence range
  // only where a polish fails
  let lo = g0.K,
    hi = g1.K;
  if (!Number.isFinite(sizeAt(B, lo))) lo = Math.max(g0.K, kMin(B));
  if (!Number.isFinite(sizeAt(A, hi))) hi = Math.min(g1.K, kMax(A));
  if (!(hi > lo)) {
    events.push({ kind: "gap", K: (g0.K + g1.K) / 2, Klo: g0.K, Khi: g1.K, from: A.id, to: B.id, note: `branches ${A.id} and ${B.id} do not coexist on [${g0.K}, ${g1.K}]` });
    continue;
  }
  const f = (K: number) => sizeAt(A, K) - sizeAt(B, K);
  const fl = f(lo),
    fh = f(hi);
  let Kc: number;
  let note: string | undefined;
  if (fl <= 0 && fh >= 0) Kc = rootBisect(f, lo, hi, 1e-13);
  else if (fl > 0) {
    Kc = lo;
    note = `B lower already at the left end of the overlap (f = ${fl.toExponential(2)}); crossing at or before ${lo}`;
  } else {
    Kc = hi;
    note = `A still lower at the right end of the overlap (f = ${fh.toExponential(2)}): A folds at ${hi} while lower (jump with continuous s only if f = 0)`;
  }
  const sa = slopesAt(cfgOf(nearest(A, Kc)), Kc);
  const sb = slopesAt(cfgOf(nearest(B, Kc)), Kc);
  const pa = nearest(A, Kc),
    pb = nearest(B, Kc);
  const tangent = Math.abs(sa.left - sb.right) < 2e-3 * (1 + Math.abs(sa.left)) && Math.abs(sa.s0 - sb.s0) < 1e-8 * sa.s0;
  events.push({
    kind: tangent ? "coincide" : "crossing",
    K: Kc,
    Klo: g0.K,
    Khi: g1.K,
    from: A.id,
    to: B.id,
    s: Number.isFinite(sa.s0) ? sa.s0 : sb.s0,
    slopeLeft: sa.left,
    slopeRight: sb.right,
    kink: sb.right - sa.left,
    before: { ...desc(pa), slopes: [sa.left, sa.right], d2: [sa.d2Left, sa.d2Right], sAtKc: sa.s0 },
    after: { ...desc(pb), slopes: [sb.left, sb.right], d2: [sb.d2Left, sb.d2Right], sAtKc: sb.s0 },
    onGround: true,
    note,
  });
  log(`${tangent ? "coincide" : "crossing"} ${A.id}->${B.id} K=${Kc.toFixed(10)} s=${sa.s0.toFixed(8)} slopes ${sa.left.toFixed(5)} | ${sb.right.toFixed(5)} ${note ?? ""}`);
}

// hysteresis: from every crossing follow the branch that loses the lead onward, without the
// competitiveness cut of the search, until it really ends (fold, asymptote, hemisphere) or the range ends
const meta: { branch: number; dir: number; fromK: number; end: { K: number; kind: string; note?: string }; points: SweepPoint[] }[] = [];
for (const e of events) {
  if (e.kind !== "crossing" || e.from === undefined || e.to === undefined) continue;
  for (const [id, dir] of [
    [e.from, 1],
    [e.to, -1],
  ] as const) {
    const b = branches[id];
    const pc = tryPolish(problem, e.K, cfgOf(nearest(b, e.K)));
    if (!pc || !feasibleAt(problem, e.K, pc)) continue;
    const fr = followBranch(problem, e.K, pc, dir > 0 ? run.Kmax : run.Kmin, { grid: GRID });
    const end = { K: fr.end.K, kind: fr.end.kind, note: fr.end.note };
    meta.push({ branch: id, dir, fromK: e.K, end, points: fr.points });
    if (fr.end.kind === "fold" && fr.points.length > 0) {
      // where the metastable state ends, descent jumps (the second half of the hysteresis loop)
      const p = fr.points[fr.points.length - 1];
      const Kj = p.K + dir * 2e-7;
      const q = tryPolish(problem, Kj, cfgOf(p));
      const ev: Ev = {
        kind: "fold",
        K: p.K,
        branch: id,
        s: p.size,
        before: { ...desc(p), end: "fold" },
        onGround: false,
        note: `metastable continuation of branch ${id} from the crossing at K = ${e.K.toFixed(6)} ends in a fold`,
      };
      if (q && feasibleAt(problem, Kj, q)) {
        const qq = makePoint(problem, Kj, q, false);
        ev.after = { ...desc(qq), jumpK: Kj, jump: qq.size - p.size };
      }
      events.push(ev);
    }
    (e as Ev & { hysteresis?: unknown[] }).hysteresis = [...(((e as Ev & { hysteresis?: unknown[] }).hysteresis as unknown[]) ?? []), { branch: id, direction: dir > 0 ? "up" : "down", survivesTo: end.K, end: end.kind }];
    log(`metastable branch ${id} from K_c=${e.K.toFixed(6)} ${dir > 0 ? "up" : "down"}: ends ${end.kind} at ${end.K.toFixed(6)}`);
  }
}

// stability probe
const R = rng(12345);
function stable(p: SweepPoint): { stable: boolean; drop: number } {
  let drop = 0;
  for (let t = 0; t < 3; t++) {
    const pieces: CurvedPose[] = p.pieces.map((q) => ({ x: q.x + 1e-3 * gaussian(R), y: q.y + 1e-3 * gaussian(R), theta: q.theta + 1e-3 * gaussian(R) }));
    const pc = tryPolish(problem, p.K, { size: p.size * (1 + 1e-4), pieces });
    if (pc && feasibleAt(problem, p.K, pc)) drop = Math.max(drop, p.size - pc.config.size);
  }
  return { stable: !(drop > Math.max(1e-8, 1e-8 * p.size)), drop };
}
const stability: Record<number, { K: number; stable: boolean; drop: number }[]> = {};
for (const id of optimalIds) {
  const b = branches[id];
  const pts = b.points.filter((p) => p.grid && gi(p.K) % 2 === 0);
  const res = pts.map((p) => ({ K: p.K, ...stable(p) }));
  stability[id] = res;
  for (let k = 0; k + 1 < res.length; k++) {
    if (res[k].stable === res[k + 1].stable) continue;
    // locate by bisection on the stability flag, polishing along the branch
    const p = pts[k];
    let lo = p.K,
      hi = pts[k + 1].K;
    let base = cfgOf(p);
    for (let it = 0; it < 18; it++) {
      const m = (lo + hi) / 2;
      const pc = tryPolish(problem, m, base);
      if (!pc || !feasibleAt(problem, m, pc)) {
        hi = m;
        continue;
      }
      const sp = makePoint(problem, m, pc, false);
      if (stable(sp).stable === res[k].stable) {
        lo = m;
        base = pc.config;
      } else hi = m;
    }
    const Ke = (lo + hi) / 2;
    const onG = ground.some((g) => g.b === id && Math.abs(g.K - Ke) < 2 * GRID);
    events.push({
      kind: "stability",
      K: Ke,
      Klo: lo,
      Khi: hi,
      branch: id,
      s: sizeAt(b, Ke),
      before: { ...desc(p), stable: res[k].stable },
      after: { ...desc(pts[k + 1]), stable: res[k + 1].stable },
      onGround: onG,
      note: `branch ${id} (${p.sym}) ${res[k].stable ? "loses" : "gains"} stability as K increases (perturb-and-polish probe)`,
    });
    log(`stability change on branch ${id} at K=${Ke.toFixed(6)} (${p.sym}; ${res[k].stable} -> ${res[k + 1].stable})`);
  }
}

// contact / symmetry changes along optimal branches
for (const id of optimalIds) {
  const b = branches[id];
  const pts = b.points.filter((p) => p.grid);
  let count = 0;
  for (let k = 0; k + 1 < pts.length && count < 80; k++) {
    const p = pts[k],
      q = pts[k + 1];
    const cSame = p.contacts.join() === q.contacts.join() && p.rattlers.join() === q.rattlers.join();
    const sSame = p.sym === q.sym;
    if (cSame && sSame) continue;
    count++;
    const what = !cSame ? "contact" : "symmetry";
    const same = (pc: NonNullable<ReturnType<typeof tryPolish>>, K: number) => {
      const pt = makePoint(problem, K, pc, false);
      return what === "contact" ? pt.contacts.join() === p.contacts.join() && pt.rattlers.join() === p.rattlers.join() : pt.sym === p.sym;
    };
    const bis = bisectChange(problem, p.K, q.K, cfgOf(p), same, 36);
    const Ke = (bis.lo + bis.hi) / 2;
    const sl = slopesAt(bis.atLo ? bis.atLo.config : cfgOf(p), Ke, 1e-4);
    const added = q.contacts.filter((c) => !p.contacts.includes(c));
    const removed = p.contacts.filter((c) => !q.contacts.includes(c));
    const onG = ground.some((g) => g.b === id && (Math.abs(g.K - p.K) < 1e-12 || Math.abs(g.K - q.K) < 1e-12));
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
      kink: sl.right - sl.left,
      before: { ...desc(p), contactSet: p.contacts },
      after: { ...desc(q), contactSet: q.contacts, added, removed },
      onGround: onG,
    });
  }
}

// kink scan along each optimal branch: slope jumps between grid intervals that stand out from the
// local second differences (catches kinks with no contact-set change, e.g. a floppy plateau ending);
// located by sampling s at 33 sub-grid points and fitting two lines with a breakpoint
const kinkTol = (sl: number) => 2e-3 * (1 + Math.abs(sl));
for (const id of optimalIds) {
  const b = branches[id];
  const pts = b.points.filter((p) => p.grid);
  const sl: number[] = [];
  for (let k = 1; k < pts.length; k++) sl.push(Math.abs(pts[k].K - pts[k - 1].K - GRID) < 1e-12 ? (pts[k].size - pts[k - 1].size) / GRID : NaN);
  for (let k = 1; k < sl.length; k++) {
    const J = sl[k] - sl[k - 1]; // jump at pts[k]
    if (!Number.isFinite(J) || Math.abs(J) < kinkTol(sl[k])) continue;
    // the jump must dominate the second differences two and three steps away on BOTH sides (near an
    // asymptote the second difference grows smoothly and would otherwise look like a kink)
    let ref = 0;
    let leftRef = false,
      rightRef = false;
    for (const q of [k - 3, k - 2, k + 2, k + 3]) {
      if (q < 1 || q >= sl.length || !Number.isFinite(sl[q] - sl[q - 1])) continue;
      ref = Math.max(ref, Math.abs(sl[q] - sl[q - 1]));
      if (q < k) leftRef = true;
      else rightRef = true;
    }
    if (!leftRef || !rightRef) continue;
    if (Math.abs(J) < 4 * ref + kinkTol(sl[k]) || Math.abs(J) < 0.01 * (1 + Math.abs(sl[k]))) continue;
    const Ka = pts[k - 1].K,
      Kb = pts[k + 1].K;
    if (!onGroundBetween(id, Ka, Kb)) continue;
    if (events.some((e) => (e.kind === "crossing" || e.kind === "contact") && Math.abs(e.K - pts[k].K) < 2 * GRID && Math.abs(e.kink ?? 0) > kinkTol(sl[k]))) continue;
    // sample, fit, and zoom in three times (the two-line fit is biased by curvature; the bias shrinks with the window)
    let wa = Ka,
      wb = Kb;
    let best = { rss: Infinity, Kk: pts[k].K, l: 0, r: 0 };
    for (let zoom = 0; zoom < 4; zoom++) {
    const xs: number[] = [],
      ys: number[] = [];
    for (let i = 0; i <= 32; i++) {
      const K = wa + ((wb - wa) * i) / 32;
      const v = sizeAt(b, K);
      if (Number.isFinite(v)) {
        xs.push(K);
        ys.push(v);
      }
    }
    best = { rss: Infinity, Kk: best.Kk, l: 0, r: 0 };
    for (let c = 2; c < xs.length - 2; c++) {
      // breakpoint between xs[c-1] and xs[c+1]: fit lines left (<= c) and right (>= c) sharing the knot value at xs[c]... use free lines
      const fit = (lo: number, hi: number) => {
        const n = hi - lo + 1;
        let mx = 0,
          my = 0;
        for (let i = lo; i <= hi; i++) {
          mx += xs[i];
          my += ys[i];
        }
        mx /= n;
        my /= n;
        let sxx = 0,
          sxy = 0;
        for (let i = lo; i <= hi; i++) {
          sxx += (xs[i] - mx) ** 2;
          sxy += (xs[i] - mx) * (ys[i] - my);
        }
        const m = sxy / sxx;
        let rss = 0;
        for (let i = lo; i <= hi; i++) rss += (ys[i] - (my + m * (xs[i] - mx))) ** 2;
        return { m, c0: my - m * mx, rss };
      };
      const L = fit(0, c),
        Rr = fit(c, xs.length - 1);
      if (L.rss + Rr.rss < best.rss) {
        const Kk = Math.abs(L.m - Rr.m) > 1e-12 ? (Rr.c0 - L.c0) / (L.m - Rr.m) : xs[c];
        best = { rss: L.rss + Rr.rss, Kk: Math.min(wb, Math.max(wa, Kk)), l: L.m, r: Rr.m };
      }
    }
    const d = (wb - wa) / 32;
    wa = best.Kk - 3 * d;
    wb = best.Kk + 3 * d;
    }
    // final one-sided slopes at the located kink
    // slopes on intervals offset from the kink, so that the small location error does not bias them
    {
      const d = 1e-4;
      const at = (K: number) => sizeAt(b, K);
      const l = (at(best.Kk - d) - at(best.Kk - 2 * d)) / d;
      const r = (at(best.Kk + 2 * d) - at(best.Kk + d)) / d;
      if (Number.isFinite(l) && Number.isFinite(r)) {
        best.l = l;
        best.r = r;
      }
    }
    if (Math.abs(best.r - best.l) < Math.max(kinkTol(best.l), 0.01 * (1 + Math.abs(best.l)))) continue;
    events.push({
      kind: "kink",
      K: best.Kk,
      Klo: Ka,
      Khi: Kb,
      branch: id,
      s: sizeAt(b, best.Kk),
      slopeLeft: best.l,
      slopeRight: best.r,
      kink: best.r - best.l,
      before: desc(pts[k - 1]),
      after: desc(pts[k + 1]),
      onGround: true,
      note: `slope jump without a detected contact-set change (located by two-line fits to 33 samples, zoomed in three times; window ${(wb - wa).toExponential(1)})`,
    });
    log(`kink on branch ${id} at K=${best.Kk.toFixed(6)}: slopes ${best.l.toFixed(4)} | ${best.r.toFixed(4)}`);
  }
}
function onGroundBetween(id: number, a: number, c: number): boolean {
  return ground.some((g) => g.b === id && g.K >= a - 1e-12 && g.K <= c + 1e-12);
}

// branch ends (for optimal branches and every fold)
for (const b of branches) {
  for (const side of ["low", "high"] as const) {
    const end = b[side];
    if (end.kind === "range" || end.kind === "merge" || end.kind === "uncompetitive") continue;
    if (end.kind !== "fold" && !optimalIds.includes(b.id)) continue;
    const p = side === "low" ? b.points[0] : b.points[b.points.length - 1];
    const ev: Ev = {
      kind: end.kind === "fold" ? "fold" : "end",
      K: p.K,
      branch: b.id,
      s: p.size,
      before: { ...desc(p), end: end.kind },
      onGround: ground.some((g) => g.b === b.id && Math.abs(g.K - p.K) < 2 * GRID),
      note: `${side} end of branch ${b.id}: ${end.kind}${end.note ? " (" + end.note + ")" : ""}`,
    };
    if (end.kind === "fold") {
      const dir = side === "low" ? -1 : 1;
      const Kj = p.K + dir * 2e-7;
      const pc = tryPolish(problem, Kj, cfgOf(p));
      if (pc && feasibleAt(problem, Kj, pc)) {
        const q = makePoint(problem, Kj, pc, false);
        ev.after = { ...desc(q), jumpK: Kj, jump: q.size - p.size };
      }
    }
    events.push(ev);
  }
}

// one-sided slopes at K = 0
const k0: Record<string, unknown>[] = [];
for (const b of branches) {
  const p = b.byGrid.get(0);
  if (!p) continue;
  const near = slopesAt(cfgOf(p), 0, 1e-4);
  const far = slopesAt(cfgOf(p), 0, 2e-3);
  k0.push({ branch: b.id, s0: near.s0, left: near.left, right: near.right, leftFar: far.left, rightFar: far.right, contacts: p.contacts.length, rattlers: p.rattlers, sym: p.sym, family: p.family, optimal: ground.some((g) => g.K === 0 && g.b === b.id) });
}

// asymptote at the negative end (polygon containers)
let asymptote: Record<string, unknown> | undefined;
if (M > 0 && ground.length > 0) {
  const g = ground[0];
  const b = branches[g.b];
  const first = b.points[0];
  if (b.low.kind === "cap" || b.low.kind === "infeasible") {
    // fit s = -alpha ln(K - Kinf) + beta on points with s >= 5 (sub-steps included), scanning Kinf
    const pts = b.points.filter((p) => p.size >= 5 && p.K < first.K + 0.2);
    let bestFit: { Kinf: number; alpha: number; beta: number; rms: number } | undefined;
    if (pts.length >= 4) {
      for (let i = 1; i <= 4000; i++) {
        const Kinf = first.K - 0.05 * Math.pow(i / 4000, 3);
        const xs = pts.map((p) => Math.log(p.K - Kinf));
        const ys = pts.map((p) => p.size);
        const n = xs.length;
        const mx = xs.reduce((a, c) => a + c, 0) / n,
          my = ys.reduce((a, c) => a + c, 0) / n;
        let sxx = 0,
          sxy = 0;
        for (let j = 0; j < n; j++) {
          sxx += (xs[j] - mx) ** 2;
          sxy += (xs[j] - mx) * (ys[j] - my);
        }
        const slope = sxy / sxx;
        const beta = my - slope * mx;
        let rss = 0;
        for (let j = 0; j < n; j++) rss += (ys[j] - (beta + slope * xs[j])) ** 2;
        const rms = Math.sqrt(rss / n);
        if (!bestFit || rms < bestFit.rms) bestFit = { Kinf, alpha: -slope, beta, rms };
      }
    }
    let ideal: Record<string, unknown> | undefined;
    try {
      const r = kPolish(N, M, first.pieces, first.K, { maxIter: 800 });
      ideal = { a: r.a, K: r.K, unbounded: r.unbounded };
    } catch (e) {
      ideal = { error: (e as Error).message };
    }
    asymptote = { lastK: first.K, lastS: first.size, fit: bestFit, fitPoints: pts.length, theoryAlpha: bestFit ? 1 / Math.sqrt(-bestFit.Kinf) : undefined, kPolish: ideal };
    log(`asymptote: last K ${first.K} s ${first.size}; fit ${JSON.stringify(bestFit)}; kPolish ${JSON.stringify(ideal)}`);
  }
}

// ---------------- certification prep
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
}
const certs: CertRec[] = [];
function prep(K: number, cfg: CurvedConfig, role: string, branch: number) {
  const pc = tryPolish(problem, K, cfg, 600);
  if (!pc || !feasibleAt(problem, K, pc)) return;
  const dsdt = dSideDApothem(M, K, pc.polish.t);
  const mu = Math.min(4e-11, Math.max(5e-13, 4e-11 / Math.max(1, dsdt / 2)));
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
  });
}
ground.forEach((g, k) => {
  if (k % 4 !== 0 && k !== ground.length - 1) return;
  prep(g.K, cfgOf(branches[g.b].byGrid.get(gi(g.K)) as SweepPoint), "ground", g.b);
});
for (const e of events) {
  if (e.kind !== "crossing" || e.from === undefined || e.to === undefined) continue;
  for (const id of [e.from, e.to]) {
    const b = branches[id];
    for (const K of [e.Klo as number, e.Khi as number]) {
      const p = b.byGrid.get(gi(K));
      if (p) prep(K, cfgOf(p), `crossing ${e.from}->${e.to} at ${e.K}: branch ${id} grid`, id);
    }
    prep(e.K, cfgOf(nearest(b, e.K)), `crossing ${e.from}->${e.to} at ${e.K}: branch ${id} at Kc`, id);
  }
}
log(`certification prep: ${certs.length}`);

writeFileSync(
  outFile,
  JSON.stringify({ problem, source: inFile, grid: GRID, Kmin: run.Kmin, Kmax: run.Kmax, euclidean: run.euclidean, ground, optimal: optimalIds, events, stability, k0, asymptote, meta, certs, seconds: (Date.now() - t0) / 1000 }),
);
log(`wrote ${outFile}`);
