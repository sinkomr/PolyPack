/**
 * Sequential linear programming polish: minimise the container variable t subject to every gap
 * >= margin, with a box trust region and an l1 merit function. Converges to a KKT point whose
 * active rows and multipliers are returned (for envelope-theorem sensitivities).
 */
import { CurvedPose, Space } from "./problem";
import { Row, allStates, requiredT } from "./evaluate";
import { collectRows, posesFromVector, vectorFromPoses, violation } from "./model";
import { LpRow, nnls, solveLp } from "./optim";
import { dSideDApothem, sideFromApothem } from "./shapes";

export interface PolishOptions {
  margin?: number;
  maxIter?: number;
  /** initial trust radius for pose coordinates */
  trust?: number;
  /** l1 penalty weight for violations */
  weight?: number;
  /** stop when the trust radius falls below this */
  minTrust?: number;
  /** Optional external stop, polled before every iteration; true returns the current point. */
  shouldStop?: () => boolean;
  /**
   * Optional work poll: called before every iteration with the row sweeps (passes over the pairs
   * and walls: row collections and merit evaluations) done since the last call, and before every
   * simplex pivot with the pivot's tableau work (solveLp). True returns the current point, as
   * shouldStop does; a pivot that is stopped ends its LP at its current, feasible basis.
   */
  poll?: (sweeps: number, lpWork: number) => boolean;
  /** False skips the multiplier fit at the end (active rows, NNLS, rattlers): only poses, t and size are wanted. */
  fit?: boolean;
}

export interface ActiveRow {
  kind: Row["kind"];
  i: number;
  j: number;
  wall: number;
  vertex: number;
  owner: number;
  edge: number;
  gap: number;
  /** Lagrange multiplier with respect to the container size s (ds per unit of gap) */
  lambda: number;
}

export interface PolishResult {
  poses: CurvedPose[];
  /** container variable (apothem or radius) */
  t: number;
  size: number;
  margin: number;
  /** worst pair gap and container gap minus margin (>= -1e-12 when converged) */
  feasibility: number;
  iterations: number;
  active: ActiveRow[];
  /** KKT residual |sum lambda grad - grad s| in the multiplier fit */
  kktResidual: number;
  /** pieces with no active row */
  rattlers: number[];
}

function tightT(space: Space, poses: CurvedPose[], margin: number): number {
  // container variable that gives every container row clearance >= margin (to first order)
  const states = allStates(space, poses);
  let t = -Infinity;
  for (const s of states) t = Math.max(t, requiredT(space, s));
  return t + margin * 1.0000001;
}

interface LpStep {
  step: Float64Array;
  predicted: number;
}

/**
 * One linearised step: minimise dt + 1e-7 |dz|_1 + W * sum(slack) subject to
 * value_k + grad_k . (dz, dt) + slack_k >= margin, |dz_j| <= rho, dt in [lo, hi].
 */
function lpStep(
  space: Space,
  states: ReturnType<typeof allStates>,
  t: number,
  margin: number,
  rho: number,
  dtLo: number,
  dtHi: number,
  W: number,
  below: number,
  poll?: (work: number) => boolean,
): LpStep {
  const P = states.length;
  const nz = 3 * P;
  const rows = collectRows(space, states, t, { below, pairMode: "vertices" });
  const lpRows: LpRow[] = rows.map((r) => {
    const idx: number[] = [];
    const val: number[] = [];
    for (let a = 0; a < 3; a++) {
      const gi = r.gi[a];
      if (gi !== 0) {
        idx.push(3 * r.i + a, nz + 3 * r.i + a);
        val.push(gi, -gi);
      }
      if (r.j >= 0) {
        const gj = r.gj[a];
        if (gj !== 0) {
          idx.push(3 * r.j + a, nz + 3 * r.j + a);
          val.push(gj, -gj);
        }
      }
    }
    if (r.gt !== 0) {
      idx.push(2 * nz);
      val.push(r.gt);
    }
    return { idx, val, rhs: margin - r.value };
  });
  const nv = 2 * nz + 1;
  const c = new Float64Array(nv);
  for (let j = 0; j < 2 * nz; j++) c[j] = 1e-7;
  c[2 * nz] = 1;
  const lo = new Float64Array(nv);
  const hi = new Float64Array(nv);
  for (let j = 0; j < 2 * nz; j++) hi[j] = rho;
  lo[2 * nz] = dtLo;
  hi[2 * nz] = dtHi;
  const lp = solveLp(c, lpRows, lo, hi, W, undefined, poll);
  const step = new Float64Array(nz + 1);
  for (let j = 0; j < nz; j++) step[j] = lp.x[j] - lp.x[nz + j];
  step[nz] = lp.x[2 * nz];
  let cur = 0;
  let pred = 0;
  rows.forEach((r, k) => {
    let lin = r.value;
    const R = lpRows[k];
    for (let q = 0; q < R.idx.length; q++) lin += R.val[q] * lp.x[R.idx[q]];
    cur += Math.max(0, margin - r.value);
    pred += Math.max(0, margin - lin);
  });
  return { step, predicted: -step[nz] + W * (cur - pred) };
}

export function polish(
  space: Space,
  start: readonly CurvedPose[],
  t0: number | undefined,
  opts: PolishOptions = {},
): PolishResult {
  const margin = opts.margin ?? 0;
  const maxIter = opts.maxIter ?? 300;
  const W = opts.weight ?? 1e3;
  const minTrust = opts.minTrust ?? 1e-13;
  const P = start.length;
  const nz = 3 * P;
  let z = vectorFromPoses(start);
  let t = t0 ?? tightT(space, posesFromVector(z), margin);
  if (t > space.tMax) t = space.tMax - 1e-9;
  let rho = opts.trust ?? 0.05;
  let rhoT = rho;
  let states = allStates(space, posesFromVector(z));
  let merit = t + W * violation(space, states, t, margin);
  let it = 0;
  const reachOf = (r: number) => margin + 4 * r * (1 + space.piece.R) + 1e-7;
  const meritAt = (zz: Float64Array, tt: number) => {
    const st = allStates(space, posesFromVector(zz));
    return { st, m: tt + W * violation(space, st, tt, margin) };
  };
  // work since the last poll, in row sweeps (the start's merit is one)
  let sweeps = 1;
  const pivotPoll = opts.poll ? (work: number) => opts.poll!(0, work) : undefined;
  for (; it < maxIter; it++) {
    if (rho < minTrust) break;
    if (opts.shouldStop?.()) break;
    if (opts.poll?.(sweeps, 0)) break;
    sweeps = 0;
    const dtHi = Math.min(rhoT, (space.tMax - t) * 0.5);
    const { step, predicted } = lpStep(space, states, t, margin, rho, -rhoT, dtHi, W, reachOf(rho), pivotPoll);
    sweeps++;
    if (!(predicted > 1e-16)) {
      rho *= 0.25;
      rhoT *= 0.25;
      continue;
    }
    let zn = new Float64Array(nz);
    for (let j = 0; j < nz; j++) zn[j] = z[j] + step[j];
    const tn = t + step[nz];
    let trial = meritAt(zn, tn);
    sweeps++;
    let actual = merit - trial.m;
    if (actual < 0.1 * predicted) {
      // second-order correction: re-linearise at the trial point and restore feasibility with t fixed
      const soc = lpStep(space, trial.st, tn, margin, rho, 0, 0, W, reachOf(rho), pivotPoll);
      const z2 = new Float64Array(nz);
      for (let j = 0; j < nz; j++) z2[j] = zn[j] + soc.step[j];
      const trial2 = meritAt(z2, tn);
      sweeps += 2;
      const actual2 = merit - trial2.m;
      if (actual2 > actual) {
        zn = z2;
        trial = trial2;
        actual = actual2;
      }
    }
    if (actual >= 0.1 * predicted) {
      z = zn;
      t = tn;
      states = trial.st;
      merit = trial.m;
      let maxStep = 0;
      for (let j = 0; j < nz; j++) maxStep = Math.max(maxStep, Math.abs(step[j]));
      if (actual >= 0.4 * predicted && maxStep > 0.9 * rho) {
        rho = Math.min(rho * 2, 0.25);
        rhoT = Math.min(rhoT * 2, 0.25);
      } else if (maxStep < 0.1 * rho) {
        rho = Math.max(maxStep * 2, minTrust * 0.5);
        rhoT = Math.max(Math.abs(step[nz]) * 2, rho);
      }
      if (predicted < 1e-15 && actual < 1e-15) break;
    } else {
      rho *= 0.25;
      rhoT *= 0.25;
    }
  }
  const poses = posesFromVector(z);
  if (opts.fit === false)
    return {
      poses,
      t,
      size: sideFromApothem(space.M, space.K, t),
      margin,
      feasibility: NaN,
      iterations: it,
      active: [],
      kktResidual: NaN,
      rattlers: [],
    };
  return finishPolish(space, poses, t, margin, it);
}

/** Active set, multipliers (NNLS fit of the KKT stationarity condition) and rattlers. */
export function finishPolish(
  space: Space,
  poses: CurvedPose[],
  t: number,
  margin: number,
  iterations: number,
): PolishResult {
  const P = poses.length;
  const states = allStates(space, poses);
  const tolA = 1e-8;
  const rows = collectRows(space, states, t, { below: margin + tolA, pairMode: "vertices" });
  let worst = Infinity;
  const all = collectRows(space, states, t, { below: margin + 1e-3, pairMode: "summary" });
  for (const r of all) worst = Math.min(worst, r.value - margin);
  if (!Number.isFinite(worst)) worst = 0;
  // stationarity in (z, t): sum lambda_k grad g_k = grad t = e_t
  const n = 3 * P + 1;
  const cols = rows.map((r) => {
    const v = new Float64Array(n);
    for (let a = 0; a < 3; a++) {
      v[3 * r.i + a] += r.gi[a];
      if (r.j >= 0) v[3 * r.j + a] += r.gj[a];
    }
    v[3 * P] = r.gt;
    return v;
  });
  const target = new Float64Array(n);
  target[3 * P] = 1;
  const fit = rows.length > 0 ? nnls(cols, target) : { x: new Float64Array(0), residual: 1 };
  // convert multipliers from t (apothem) to the size s: lambda_s = lambda_t * ds/dt
  const dsdt = dSideDApothem(space.M, space.K, t);
  const touched = new Uint8Array(P);
  const active: ActiveRow[] = rows.map((r, k) => {
    touched[r.i] = 1;
    if (r.j >= 0) touched[r.j] = 1;
    return {
      kind: r.kind,
      i: r.i,
      j: r.j,
      wall: r.wall,
      vertex: r.vertex,
      owner: r.owner,
      edge: r.edge,
      gap: r.value,
      lambda: fit.x[k] * dsdt,
    };
  });
  const rattlers: number[] = [];
  for (let i = 0; i < P; i++) if (!touched[i]) rattlers.push(i);
  return {
    poses,
    t,
    size: sideFromApothem(space.M, space.K, t),
    margin,
    feasibility: worst,
    iterations,
    active,
    kktResidual: fit.residual,
    rattlers,
  };
}
