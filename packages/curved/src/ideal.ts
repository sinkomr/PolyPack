/**
 * The scale-free hyperbolic family: a*(N, M, P) = sup side of P congruent regular N-gons (or r*,
 * the sup radius of P equal disks) in the IDEAL regular M-gon of the hyperbolic plane K = -1.
 *
 * Scaling: P pieces of side a at K = -1 are P unit pieces at curvature K = -a^2 (lengths scale by
 * sqrt(-K)). So a* = sqrt(-K*) where K* is the most negative curvature at which P unit pieces fit in
 * the ideal M-gon. P unit pieces fit in some finite regular M-gon at curvature K < 0 if
 * sqrt(-K) < a* (shrink a packing of larger pieces about the centres) and only if sqrt(-K) <= a*;
 * the boundary case sqrt(-K) = a* is open (it depends on whether the supremum is attained away
 * from the ideal vertices). One a* table therefore gives the finite catalogue P_max(K) for every
 * K < 0 except at the curvatures -a*^2 themselves.
 *
 * kPolish maximises a = sqrt(-K) by sequential linear programming in (poses, K) with the container
 * fixed to the ideal M-gon at the current K (walls at the ideal apothem h_inf(K)).
 */
import { CurvedPose, makeSpace } from "./problem";
import { allStates, diskPairRow, pieceState, rimRow, vertexEdgeRow, wallRow, type Row } from "./evaluate";
import { collectRows, posesFromVector, vectorFromPoses } from "./model";
import { LpRow, solveLp } from "./optim";
import { idealApothem } from "./shapes";

export interface IdealResult {
  /** most negative curvature reached (unit pieces still fit in the ideal M-gon) */
  K: number;
  /** a* lower bound = sqrt(-K) (side for polygons, radius for disks) */
  a: number;
  poses: CurvedPose[];
  /** true when K ran past the divergence limit: pieces appear to grow without bound */
  unbounded: boolean;
  iterations: number;
  feasibility: number;
}

function rowsAt(N: number, M: number, K: number, poses: CurvedPose[], below: number): Row[] {
  const space = makeSpace(K, N, M);
  const st = allStates(space, poses);
  return collectRows(space, st, idealApothem(M, K) * (1 - 1e-15), { below, pairMode: "vertices" });
}

function rowAt(N: number, M: number, K: number, poses: CurvedPose[], r: Row): number {
  const space = makeSpace(K, N, M);
  const t = idealApothem(M, K) * (1 - 1e-15);
  const Si = pieceState(space, poses[r.i]);
  if (r.kind === "pair") {
    const Sj = pieceState(space, poses[r.j]);
    if (N === 0) return diskPairRow(space, Si, Sj, r.i, r.j).value;
    const [P, Q, pi, qi] = r.owner === 0 ? [Si, Sj, r.i, r.j] : [Sj, Si, r.j, r.i];
    return vertexEdgeRow(space, P, r.edge, Q, r.vertex, pi, qi, r.owner).value;
  }
  if (r.kind === "wall") return wallRow(space, Si, r.i, r.vertex, r.wall, t).value;
  return rimRow(space, Si, r.i, r.vertex, t).value;
}

function violation(rows: Row[]): number {
  let v = 0;
  for (const r of rows) if (r.value < 0) v -= r.value;
  return v;
}

/**
 * Maximise the piece size in the ideal M-gon, starting from P unit pieces that fit at curvature K0 < 0.
 */
export function kPolish(
  N: number,
  M: number,
  start: CurvedPose[],
  K0: number,
  opts: { maxIter?: number; Klimit?: number } = {},
): IdealResult {
  if (!(K0 < 0) || M === 0) throw new RangeError("ideal containers need K < 0 and a polygon container");
  const maxIter = opts.maxIter ?? 400;
  const Klimit = opts.Klimit ?? -400; // beyond side ~20 float coordinates (~e^20) are meaningless; callers must not treat "unbounded" as a proof
  const W = 1e3;
  let z = vectorFromPoses(start);
  let K = K0;
  let rho = 0.05;
  let rhoK = 0.05 * Math.abs(K0);
  const nz = z.length;
  const meritOf = (zz: Float64Array, KK: number) => {
    const rows = rowsAt(N, M, KK, posesFromVector(zz), 0);
    return KK + W * Math.abs(KK) * violation(rows);
  };
  let merit = meritOf(z, K);
  let it = 0;
  let unbounded = false;
  for (; it < maxIter; it++) {
    if (rho < 1e-13) break;
    if (K < Klimit) {
      unbounded = true;
      break;
    }
    const poses = posesFromVector(z);
    const below = 4 * rho * 2 + 1e-7;
    const rows = rowsAt(N, M, K, poses, below);
    const hK = 1e-6 * Math.abs(K);
    const gK = rows.map((r) => (rowAt(N, M, K + hK, poses, r) - rowAt(N, M, K - hK, poses, r)) / (2 * hK));
    const lpRows: LpRow[] = rows.map((r, k) => {
      const idx: number[] = [];
      const val: number[] = [];
      for (let a = 0; a < 3; a++) {
        if (r.gi[a] !== 0) {
          idx.push(3 * r.i + a, nz + 3 * r.i + a);
          val.push(r.gi[a], -r.gi[a]);
        }
        if (r.j >= 0 && r.gj[a] !== 0) {
          idx.push(3 * r.j + a, nz + 3 * r.j + a);
          val.push(r.gj[a], -r.gj[a]);
        }
      }
      idx.push(2 * nz);
      val.push(gK[k]);
      return { idx, val, rhs: -r.value };
    });
    const nv = 2 * nz + 1;
    const c = new Float64Array(nv);
    for (let j = 0; j < 2 * nz; j++) c[j] = 1e-7;
    c[2 * nz] = 1;
    const lo = new Float64Array(nv);
    const hi = new Float64Array(nv);
    for (let j = 0; j < 2 * nz; j++) hi[j] = rho;
    lo[2 * nz] = -rhoK;
    hi[2 * nz] = Math.min(rhoK, -K / 2);
    const lp = solveLp(c, lpRows, lo, hi, W * Math.abs(K));
    const dz = new Float64Array(nz);
    for (let j = 0; j < nz; j++) dz[j] = lp.x[j] - lp.x[nz + j];
    const dK = lp.x[2 * nz];
    let cur = 0;
    let pred = 0;
    rows.forEach((r, k) => {
      let lin = r.value + gK[k] * dK;
      const R = lpRows[k];
      for (let q = 0; q < R.idx.length - 1; q++) lin += R.val[q] * lp.x[R.idx[q]];
      cur += Math.max(0, -r.value);
      pred += Math.max(0, -lin);
    });
    const predicted = -dK + W * Math.abs(K) * (cur - pred);
    if (!(predicted > 1e-15 * Math.abs(K))) {
      rho *= 0.25;
      rhoK *= 0.25;
      continue;
    }
    const zn = new Float64Array(nz);
    for (let j = 0; j < nz; j++) zn[j] = z[j] + dz[j];
    const Kn = K + dK;
    const mn = meritOf(zn, Kn);
    const actual = merit - mn;
    if (actual >= 0.1 * predicted) {
      z = zn;
      K = Kn;
      merit = mn;
      let maxStep = 0;
      for (let j = 0; j < nz; j++) maxStep = Math.max(maxStep, Math.abs(dz[j]));
      if (actual >= 0.4 * predicted && (maxStep > 0.9 * rho || Math.abs(dK) > 0.9 * rhoK)) {
        rho = Math.min(2 * rho, 0.25);
        rhoK = Math.min(2 * rhoK, 0.5 * Math.abs(K));
      }
    } else {
      rho *= 0.25;
      rhoK *= 0.25;
    }
  }
  const poses = posesFromVector(z);
  const rows = rowsAt(N, M, K, poses, 1e-3);
  let feas = Infinity;
  for (const r of rows) feas = Math.min(feas, r.value);
  return { K, a: Math.sqrt(-K), poses, unbounded, iterations: it, feasibility: Number.isFinite(feas) ? feas : 0 };
}
