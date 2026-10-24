/**
 * Curvature sweeps: follow packings adiabatically in K and classify what happens to them.
 *
 * A *branch* is a family of local optima z(K) (poses in K-independent exponential coordinates) that
 * the SLP polish can track continuously: each step polishes a secant prediction of the next pose
 * vector at K + h. A step is accepted when the polished configuration stays close to the prediction
 * (geodesic pose distance <= jumpTol) or, when it moved far, when its size did not drop below the
 * prediction (a floppy or fast but continuous rearrangement). Otherwise the step is halved; below
 * hMin the branch ends at a *fold*: the local optimum ceases to exist and descent jumps to another
 * configuration (recorded as `jumpTo`, a seed for a new branch). Other ends: the configuration
 * becomes infeasible (polygon containers at K < 0: the container would have to exceed the ideal
 * polygon, s -> infinity), the container would leave the open hemisphere (K > 0), the unit piece
 * stops existing, or the end of the requested range.
 *
 * The ground state s*(K) is the lower envelope of all branches on a common dyadic K grid (every grid
 * K is an exact binary64 and an exact rational for the certifier). Crossings of two branches and
 * contact or symmetry changes along a branch are located by bisection in K with polished configs.
 */
import { CurvedConfig, CurvedPose, CurvedProblem, makeSpace } from "./problem";
import { allStates } from "./evaluate";
import { conformal, distanceFromO } from "./space";
import { polishAt, rowKey, sensitivity, type PolishedConfig } from "./engine";
import { containerArea, maxContainerSize, pieceExists, pieceGeometry } from "./shapes";
import type { ActiveRow } from "./polish";

export interface SweepPoint {
  K: number;
  size: number;
  pieces: CurvedPose[];
  /** contact graph: sorted keys "p:i-j" (pair), "w:i:k" (piece i on wall k), "r:i" (rim) */
  contacts: string[];
  rattlers: number[];
  dsdK: number;
  kkt: number;
  /** symmetry group of the non-rattler part about O: Cn or Dn */
  sym: string;
  /** shell structure of the centres (outer shell first), e.g. "6+1" */
  family: string;
  density: number;
  /** true when K is a grid value */
  grid: boolean;
}

export type EndKind = "range" | "fold" | "infeasible" | "hemisphere" | "piece" | "cap" | "merge" | "uncompetitive";

export interface BranchEnd {
  K: number;
  kind: EndKind;
  note?: string;
  /** fold: the configuration descent jumps to just beyond the fold, and its size */
  jumpTo?: CurvedConfig;
  jumpK?: number;
  /** merge: the branch it joined */
  mergeWith?: number;
}

export interface FollowOptions {
  /** grid spacing (a power of two, so that grid values are exact) */
  grid?: number;
  /** smallest sub-step before declaring a fold or an end */
  hMin?: number;
  /** pose distance (geodesic units) that counts as a jump */
  jumpTol?: number;
  /** stop when the size exceeds this (float coordinates grow like e^s) */
  sizeCap?: number;
  /** called at every accepted grid point; return a reason string to stop the branch there */
  onGrid?: (p: SweepPoint) => { kind: EndKind; mergeWith?: number; note?: string } | undefined;
  maxIter?: number;
}

const DEF = { grid: 1 / 64, hMin: 2 ** -26, jumpTol: 0.03, sizeCap: 14 };

/** Contact keys of a polished configuration (rows with |gap - margin| <= tol). */
export function contactKeys(active: ActiveRow[], margin = 0, tol = 1e-9): string[] {
  const s = new Set<string>();
  for (const r of active) {
    if (Math.abs(r.gap - margin) > tol) continue;
    if (r.kind === "pair") s.add(`p:${Math.min(r.i, r.j)}-${Math.max(r.i, r.j)}`);
    else if (r.kind === "wall") s.add(`w:${r.i}:${r.wall}`);
    else s.add(`r:${r.i}`);
  }
  return [...s].sort();
}

/** Density P * area(piece) / area(container) at curvature K. */
export function densityOf(problem: CurvedProblem, K: number, size: number): number {
  const a = pieceGeometry(problem.N, K).area;
  return (problem.P * a) / containerArea(problem.M, K, size);
}

/** Geodesic distances of the piece centres from O. */
export function centreRadii(K: number, pieces: CurvedPose[]): number[] {
  // exponential coordinates: the distance from O is |(x, y)| exactly
  void K;
  return pieces.map((p) => Math.hypot(p.x, p.y));
}

/** Shell structure "a+b+c" of centre radii (outer first), shells separated by gaps > gap. */
export function familyLabel(K: number, pieces: CurvedPose[], gap = 0.25): string {
  const r = centreRadii(K, pieces).sort((a, b) => b - a);
  const shells: number[] = [];
  let last = Infinity;
  for (const v of r) {
    if (last - v > gap || shells.length === 0) shells.push(1);
    else shells[shells.length - 1]++;
    last = v;
  }
  return shells.join("+");
}

/**
 * Symmetry group about O of the non-rattler pieces (rotations and reflections that map the set of
 * piece vertices, or disk centres, to itself), in conformal coordinates (equivariant under the
 * isometries fixing O). For polygon containers only the container's own symmetries are tested.
 */
export function symmetryLabel(problem: CurvedProblem, K: number, pieces: CurvedPose[], rattlers: number[] = []): string {
  const space = makeSpace(K, problem.N, problem.M);
  const keep = pieces.filter((_, i) => !rattlers.includes(i));
  if (keep.length === 0) return "-";
  const st = allStates(space, keep);
  const pts: [number, number][] = [];
  for (const s of st) {
    if (problem.N === 0) {
      const c = conformal(K, s.centre);
      pts.push([c.x, c.y]);
    } else
      for (const v of s.verts) {
        const c = conformal(K, v);
        pts.push([c.x, c.y]);
      }
  }
  let scale = 1;
  for (const p of pts) scale = Math.max(scale, Math.hypot(p[0], p[1]));
  const tol = 2e-5 * scale;
  const maps = (f: (p: [number, number]) => [number, number]) =>
    pts.every((p) => {
      const q = f(p);
      return pts.some((r) => Math.abs(r[0] - q[0]) < tol && Math.abs(r[1] - q[1]) < tol);
    });
  const rotBy = (a: number) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return (p: [number, number]): [number, number] => [c * p[0] - s * p[1], s * p[0] + c * p[1]];
  };
  const reflAt = (a: number) => {
    // reflection across the line through O at angle a
    const c = Math.cos(2 * a);
    const s = Math.sin(2 * a);
    return (p: [number, number]): [number, number] => [c * p[0] + s * p[1], s * p[0] - c * p[1]];
  };
  let n = 1;
  const kMax = problem.M === 0 ? Math.max(2, 2 * pieces.length) : problem.M;
  for (let k = kMax; k >= 2; k--) {
    if (problem.M > 0 && problem.M % k !== 0) continue;
    if (maps(rotBy((2 * Math.PI) / k))) {
      n = k;
      break;
    }
  }
  const axes: number[] = [];
  if (problem.M > 0) for (let j = 0; j < problem.M; j++) axes.push(Math.PI / 2 + (j * Math.PI) / problem.M);
  else {
    const ang = pts.map((p) => Math.atan2(p[1], p[0]));
    const rad = pts.map((p) => Math.hypot(p[0], p[1]));
    for (let i = 0; i < pts.length; i++) {
      if (rad[i] > tol) axes.push(ang[i]);
      for (let j = i + 1; j < pts.length; j++)
        if (Math.abs(rad[i] - rad[j]) < tol) {
          axes.push((ang[i] + ang[j]) / 2);
          axes.push((ang[i] + ang[j]) / 2 + Math.PI / 2);
        }
    }
  }
  const tested: number[] = [];
  let refl = false;
  for (const a0 of axes) {
    const a = ((a0 % Math.PI) + Math.PI) % Math.PI;
    if (tested.some((b) => Math.abs(b - a) < 1e-7 || Math.abs(Math.abs(b - a) - Math.PI) < 1e-7)) continue;
    tested.push(a);
    if (tested.length > 400) break;
    if (maps(reflAt(a))) {
      refl = true;
      break;
    }
  }
  return `${refl ? "D" : "C"}${n}`;
}

/** Pose distance: max over pieces (except `skip`) of centre displacement plus R times the turn. */
export function poseDistance(problem: CurvedProblem, a: CurvedPose[], b: CurvedPose[], skip: number[] = []): number {
  const R = problem.N === 0 ? 0 : 1;
  const per = problem.N === 0 ? 0 : (2 * Math.PI) / problem.N;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (skip.includes(i)) continue;
    let t = 0;
    if (per > 0) {
      t = (b[i].theta - a[i].theta) % per;
      if (t > per / 2) t -= per;
      if (t < -per / 2) t += per;
    }
    d = Math.max(d, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y) + R * Math.abs(t));
  }
  return d;
}

/** Build a sweep point from a polished configuration. */
export function makePoint(problem: CurvedProblem, K: number, pc: PolishedConfig, grid: boolean): SweepPoint {
  const sens = sensitivity(problem, K, pc.config, pc.polish);
  return {
    K,
    size: pc.config.size,
    pieces: pc.config.pieces,
    contacts: contactKeys(pc.polish.active, pc.polish.margin),
    rattlers: pc.polish.rattlers,
    dsdK: sens.dsdK,
    kkt: pc.polish.kktResidual,
    sym: symmetryLabel(problem, K, pc.config.pieces, pc.polish.rattlers),
    family: familyLabel(K, pc.config.pieces),
    density: densityOf(problem, K, pc.config.size),
    grid,
  };
}

export function isGrid(K: number, grid: number): boolean {
  return Math.abs(K / grid - Math.round(K / grid)) < 1e-9;
}

function extrapolate(a: CurvedPose[], b: CurvedPose[], f: number): CurvedPose[] {
  // b + f (b - a); thetas unwrapped per piece
  return b.map((p, i) => ({
    x: p.x + f * (p.x - a[i].x),
    y: p.y + f * (p.y - a[i].y),
    theta: p.theta + f * (p.theta - a[i].theta),
  }));
}

export interface FollowResult {
  points: SweepPoint[];
  end: BranchEnd;
  polishes: number;
}

/**
 * Existence of the unit piece, with the necessary perimeter condition for polygons at K > 0: a convex
 * spherical N-gon of side 1 has perimeter N < 2 pi / sqrt(K), i.e. sqrt(K) < 2 pi / N. (The engine's
 * pieceExists tests sqrt(K) sn_K(1/2) < sin(pi/N), which is also met again at large K by polygons that
 * do not exist; the sweeps stay below sqrt(K) = 2 pi / N, where the two tests agree.)
 */
export function pieceExistsStrict(N: number, K: number): boolean {
  if (!pieceExists(N, K)) return false;
  return !(N >= 3 && K > 0 && !(Math.sqrt(K) < (2 * Math.PI) / N));
}

/** Safe polish: returns undefined when the polish throws or K is outside the piece's existence. */
export function tryPolish(problem: CurvedProblem, K: number, cfg: CurvedConfig, maxIter?: number): PolishedConfig | undefined {
  if (!pieceExistsStrict(problem.N, K)) return undefined;
  try {
    const sMax = maxContainerSize(problem.M, K);
    const start = cfg.size < sMax ? cfg : { size: sMax * (1 - 1e-9), pieces: cfg.pieces };
    return polishAt(problem, K, start, { maxIter });
  } catch {
    return undefined;
  }
}

export function feasibleAt(problem: CurvedProblem, K: number, pc: PolishedConfig | undefined): boolean {
  if (!pc) return false;
  // maxContainerSize keeps the container in the open hemisphere: K s^2 < (2 pi / M)^2, K r^2 < (pi / 2)^2
  return pc.validation.valid && pc.polish.feasibility > -1e-9 && pc.config.size < maxContainerSize(problem.M, K);
}

/**
 * Follow a branch from (K0, start) towards K1 (either direction). `start` must already be polished at
 * K0 and is returned as the first point. Grid points (multiples of opts.grid) are always visited.
 */
export function followBranch(
  problem: CurvedProblem,
  K0: number,
  start: PolishedConfig,
  K1: number,
  opts: FollowOptions = {},
): FollowResult {
  const grid = opts.grid ?? DEF.grid;
  const hMin = opts.hMin ?? DEF.hMin;
  const jumpTol = opts.jumpTol ?? DEF.jumpTol;
  const sizeCap = opts.sizeCap ?? DEF.sizeCap;
  const dir = K1 >= K0 ? 1 : -1;
  const points: SweepPoint[] = [makePoint(problem, K0, start, isGrid(K0, grid))];
  let polishes = 0;
  let cur = start;
  let K = K0;
  let prev: { K: number; pieces: CurvedPose[]; size: number } | undefined;
  // next grid point strictly beyond K in direction dir
  const nextGrid = (k: number) => {
    const j = dir > 0 ? Math.floor(k / grid + 1e-9) + 1 : Math.ceil(k / grid - 1e-9) - 1;
    return j * grid;
  };
  let h = grid;
  while (dir * (K1 - K) > 1e-15) {
    let target = Math.min(dir * (nextGrid(K) - K), h, dir * (K1 - K));
    let accepted = false;
    let lastFail: { pc?: PolishedConfig; Kt: number; why: string } | undefined;
    while (target >= hMin * 0.999) {
      const Kt = K + dir * target;
      // secant predictor in K
      let pred = cur.config.pieces;
      let sPred = cur.config.size;
      if (prev && Math.abs(K - prev.K) > 0) {
        const f = (Kt - K) / (K - prev.K);
        pred = extrapolate(prev.pieces, cur.config.pieces, f);
        sPred = cur.config.size + f * (cur.config.size - prev.size);
      } else {
        const sens = points[points.length - 1].dsdK;
        if (Number.isFinite(sens)) sPred = cur.config.size + sens * (Kt - K);
      }
      const startCfg = { size: Math.max(sPred, 1e-6), pieces: pred };
      let pc = tryPolish(problem, Kt, startCfg, opts.maxIter);
      polishes++;
      if (!feasibleAt(problem, Kt, pc)) {
        // retry from the unextrapolated configuration
        pc = tryPolish(problem, Kt, cur.config, opts.maxIter);
        polishes++;
      }
      if (!feasibleAt(problem, Kt, pc)) {
        lastFail = { pc, Kt, why: "infeasible" };
        target /= 2;
        continue;
      }
      const p = pc as PolishedConfig;
      if (p.config.size > sizeCap) {
        lastFail = { pc: p, Kt, why: "cap" };
        target /= 2;
        continue;
      }
      const dz = poseDistance(problem, pred, p.config.pieces, [...p.polish.rattlers, ...cur.polish.rattlers]);
      const sTol = 1e-9 * Math.max(1, p.config.size) + 1e-3 * Math.abs(cur.config.size - sPred);
      if (dz > jumpTol && p.config.size < sPred - sTol) {
        lastFail = { pc: p, Kt, why: "jump" };
        target /= 2;
        continue;
      }
      // accept
      prev = { K, pieces: cur.config.pieces, size: cur.config.size };
      cur = p;
      K = Kt;
      const pt = makePoint(problem, K, p, isGrid(K, grid));
      points.push(pt);
      accepted = true;
      h = Math.min(grid, target * 2);
      if (pt.grid && opts.onGrid) {
        const stop = opts.onGrid(pt);
        if (stop) return { points, end: { K, ...stop }, polishes };
      }
      break;
    }
    if (!accepted) {
      const why = lastFail?.why ?? "infeasible";
      const Kt = lastFail?.Kt ?? K + dir * hMin;
      if (!pieceExistsStrict(problem.N, Kt)) return { points, end: { K, kind: "piece", note: "unit piece stops existing" }, polishes };
      if (why === "jump")
        return {
          points,
          end: { K, kind: "fold", jumpTo: lastFail?.pc?.config, jumpK: Kt, note: "local optimum ceases to exist; descent jumps" },
          polishes,
        };
      if (why === "cap") return { points, end: { K, kind: "cap", note: `size exceeds ${sizeCap}` }, polishes };
      const sMax = maxContainerSize(problem.M, Kt);
      if (Number.isFinite(sMax) && cur.config.size > 0.98 * sMax)
        return { points, end: { K, kind: "hemisphere", note: "container would leave the open hemisphere" }, polishes };
      return { points, end: { K, kind: "infeasible", note: "no valid polish beyond this K" }, polishes };
    }
  }
  return { points, end: { K, kind: "range" }, polishes };
}

/** Bisection for the first K in (a, b) where pred(polish from cfgA at K) is false (pred(a) true). */
export function bisectChange(
  problem: CurvedProblem,
  a: number,
  b: number,
  cfgA: CurvedConfig,
  same: (pc: PolishedConfig, K: number) => boolean,
  iters = 34,
): { lo: number; hi: number; atLo?: PolishedConfig; atHi?: PolishedConfig } {
  let lo = a;
  let hi = b;
  let atLo: PolishedConfig | undefined;
  let atHi: PolishedConfig | undefined;
  let base = cfgA;
  for (let i = 0; i < iters; i++) {
    const m = (lo + hi) / 2;
    if (m === lo || m === hi) break;
    const pc = tryPolish(problem, m, base);
    if (pc && feasibleAt(problem, m, pc) && same(pc, m)) {
      lo = m;
      atLo = pc;
      base = pc.config;
    } else {
      hi = m;
      atHi = pc;
    }
  }
  return { lo, hi, atLo, atHi };
}

/** Root of f on [a, b] with f(a), f(b) of opposite signs (bisection with secant safeguard). */
export function rootBisect(f: (K: number) => number, a: number, b: number, tol = 1e-11, iters = 80): number {
  let fa = f(a);
  let lo = a;
  let hi = b;
  for (let i = 0; i < iters && hi - lo > tol; i++) {
    const m = (lo + hi) / 2;
    const fm = f(m);
    if (!Number.isFinite(fm)) break;
    if (Math.sign(fm) === Math.sign(fa)) {
      lo = m;
      fa = fm;
    } else hi = m;
  }
  return (lo + hi) / 2;
}

/** Key used to recognise the same configuration (up to symmetry and relabelling) at the same K. */
export function configKey(p: SweepPoint): string {
  const rat = new Set(p.rattlers);
  const r = p.pieces
    .filter((_, i) => !rat.has(i))
    .map((q) => Math.hypot(q.x, q.y))
    .sort((a, b) => a - b)
    .map((v) => v.toFixed(3));
  return `${p.size.toPrecision(8)}|${p.rattlers.length}|${r.join(",")}`;
}

/** Same configuration within tolerance (size and sorted non-rattler centre radii). */
export function sameConfig(a: SweepPoint, b: SweepPoint, sTol = 1e-7, rTol = 2e-3): boolean {
  if (Math.abs(a.size - b.size) > sTol * Math.max(1, a.size)) return false;
  if (a.rattlers.length !== b.rattlers.length) return false;
  const ra = new Set(a.rattlers);
  const rb = new Set(b.rattlers);
  const x = a.pieces.filter((_, i) => !ra.has(i)).map((q) => Math.hypot(q.x, q.y)).sort((u, v) => u - v);
  const y = b.pieces.filter((_, i) => !rb.has(i)).map((q) => Math.hypot(q.x, q.y)).sort((u, v) => u - v);
  return x.every((v, i) => Math.abs(v - y[i]) < rTol);
}

/** Active-row keys (vertex level) for diagnostics. */
export function activeKeys(active: ActiveRow[]): string[] {
  return active.map(rowKey).sort();
}
