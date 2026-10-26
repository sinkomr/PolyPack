/**
 * The curved kernel's penalty energy (kernel.ts): the package's gap rows (evaluate.ts), squared.
 *
 *  - polygon pair: the separating-axis value at its witness (one row per pair, as the search's
 *    energy in model.ts); disk pair: centre distance - 2;
 *  - wall or rim: one row per protruding vertex (or disk centre) and wall.
 * Every gap is a geodesic length, so the energy is a sum of squared lengths. Gradients are those
 * of the rows, taken in the chart offsets of kernel-chart.ts, and through the container variable t
 * (apothem or radius) for the size: dE/ds = dE/dt * dt/ds.
 *
 * Soft shapes (capability "shape", polygons only). The soft piece at t is the true polygon cut by
 * the disk of radius r(t) = rho + t (R - rho) about its centre (rho the inradius, R the
 * circumradius): the inscribed disk at t = 0, the polygon at t = 1, and inside the polygon always.
 * Its gaps are the largest of separation certificates that each prove the soft pieces disjoint
 * (or inside a wall):
 *  - pair: max(SAT value of the polygons, d - 2r, max_e sd(c_j, edge e of i) - r, the same for j);
 *  - wall: per vertex max(vertex gap, disk gap -sd(c, wall) - r), and the same with the rim.
 * Each soft gap is at least the true gap it replaces (the SAT value or the vertex gap is one of the
 * candidates), so the soft energy never exceeds the true one; a zero soft gap is a proof that the
 * soft shapes do not overlap (each certificate separates a superset of each soft piece).
 */
import type { KernelState } from "@polypack/methods";
import { type Space } from "./problem";
import { type PieceState, type Row, diskPairRow, pairGap, rimRow, vertexEdgeRow, wallCovectors, wallRow } from "./evaluate";
import { asnK, distFromVs, vsK } from "./kfun";
import { lineValue, pairVs, type LPoint } from "./space";
import { apothemFromSide, containerCircumradius, dSideDApothem } from "./shapes";
import { type CurvedAux, chartPieceState, pieceCentre } from "./kernel-chart";

/** What the energy needs to know about a problem, built once by the kernel. */
export interface KernelGeometry {
  space: Space;
  P: number;
  dim: number;
  /** Sizes at or above this are evaluated as this (K > 0: just inside the open hemisphere); Infinity otherwise. */
  sizeCap: number;
}

/** Container variable t (apothem or radius) at a size, and dt/dsize (0 above the cap). */
export function containerVariable(g: KernelGeometry, size: number): { t: number; dtds: number } {
  const { M, K } = g.space;
  const capped = !(size < g.sizeCap);
  const s = capped ? g.sizeCap : size;
  if (M === 0) return { t: s, dtds: capped ? 0 : 1 };
  const t = apothemFromSide(M, K, s);
  const dsdt = dSideDApothem(M, K, t);
  return { t, dtds: capped || !(dsdt < Infinity) ? 0 : 1 / dsdt };
}

/**
 * The container radius that setSize scales the centres' geodesic polar radii with: the apothem
 * for K <= 0, the circumradius for K > 0 (both the radius for a disk container), at the size the
 * energy sees (capped). Each is the smaller of the two ratios of the container's boundary radius
 * in a fixed direction when the container grows [CALC]: at K < 0 the corners move out faster than
 * the walls (tanh is concave), at K > 0 slower (tan is convex), and at K = 0 both scale alike.
 * So every point of the old container, scaled, lies in the new one.
 */
export function scaleRadius(g: KernelGeometry, size: number): number {
  const { K, M } = g.space;
  if (K > 0 && M > 0) return containerCircumradius(M, K, Math.min(size, g.sizeCap));
  return containerVariable(g, size).t;
}

/** The soft radius r(t) of a polygon piece, or Infinity for the true shape (and for disks). */
export function softRadius(space: Space, shape: number): number {
  if (space.N === 0 || !(shape < 1)) return Infinity;
  const { rho, R } = space.piece;
  return rho + Math.max(0, shape) * (R - rho);
}

interface Evaluation {
  space: Space;
  P: number;
  dim: number;
  aux: CurvedAux;
  x: Float64Array;
  t: number;
  walls: [number, number, number][];
  r: number;
  states: (PieceState | undefined)[];
  centres: (LPoint | undefined)[];
  /** vs_K of the largest centre distance at which two pieces can meet */
  vsReach: number;
}

function evaluation(g: KernelGeometry, s: KernelState, t: number): Evaluation {
  const { space } = g;
  const aux = s.aux as CurvedAux;
  const r = softRadius(space, aux.shape);
  const reach = 2 * Math.min(space.piece.R, r);
  return {
    space,
    P: g.P,
    dim: g.dim,
    aux,
    x: s.x,
    t,
    walls: space.M === 0 ? [] : wallCovectors(space, t),
    r,
    states: new Array(g.P),
    centres: new Array(g.P),
    vsReach: vsK(space.K, reach),
  };
}

function stateOf(ev: Evaluation, i: number): PieceState {
  let st = ev.states[i];
  if (!st) {
    st = chartPieceState(ev.space, ev.aux, ev.x, ev.dim, i);
    ev.states[i] = st;
    ev.centres[i] = st.centre;
  }
  return st;
}

function centreOf(ev: Evaluation, i: number): LPoint {
  let c = ev.centres[i];
  if (!c) {
    c = pieceCentre(ev.space.K, ev.aux, ev.x, ev.dim, i);
    ev.centres[i] = c;
  }
  return c;
}

/** False when pieces i and j are too far apart to meet (their reach disks are disjoint); true when a centre is not finite. */
function near(ev: Evaluation, i: number, j: number): boolean {
  return !(pairVs(ev.space.K, centreOf(ev, i), centreOf(ev, j)) > ev.vsReach);
}

const finitePoint = (p: LPoint) => Number.isFinite(p.e) && Number.isFinite(p.x) && Number.isFinite(p.y);

/** Largest signed distance of point p from the edge lines of piece A, and the edge. */
function farthestEdge(K: number, A: PieceState, p: LPoint): { value: number; edge: number } {
  let best = -Infinity;
  let edge = 0;
  for (let e = 0; e < A.edges.length; e++) {
    const v = lineValue(K, A.edges[e], p);
    if (v > best) {
      best = v;
      edge = e;
    }
  }
  return { value: asnK(K, best), edge };
}

/**
 * The gap of pieces i and j (negative: overlap), with its row when one is wanted and the gap is
 * negative. A certificate's row measures d - 2 or a signed distance; the soft gap differs from its
 * value by a constant, so the row's gradient is the gap's.
 */
function pairTerm(ev: Evaluation, i: number, j: number, withRow: boolean): { gap: number; row?: Row } {
  const { space } = ev;
  const { K } = space;
  const A = stateOf(ev, i);
  const B = stateOf(ev, j);
  // a piece beyond float range (cosh overflows near 710 / sqrt(-K) at K < 0) overlaps everything
  if (!finitePoint(A.centre) || !finitePoint(B.centre)) return { gap: NaN };
  if (space.N === 0) {
    const gap = distFromVs(K, pairVs(K, A.centre, B.centre)) - 2;
    return { gap, row: withRow && gap < 0 ? diskPairRow(space, A, B, i, j) : undefined };
  }
  const sat = pairGap(space, A, B);
  let gap = sat.gap;
  // which certificate gives the gap: 0 SAT, 1 disks, 2 edge of i against j's disk, 3 edge of j against i's disk
  let kind = 0;
  let edge = 0;
  if (gap < 0 && ev.r < Infinity) {
    const dd = distFromVs(K, pairVs(K, A.centre, B.centre)) - 2 * ev.r;
    if (dd > gap) {
      gap = dd;
      kind = 1;
    }
    const ij = farthestEdge(K, A, B.centre);
    if (ij.value - ev.r > gap) {
      gap = ij.value - ev.r;
      kind = 2;
      edge = ij.edge;
    }
    const ji = farthestEdge(K, B, A.centre);
    if (ji.value - ev.r > gap) {
      gap = ji.value - ev.r;
      kind = 3;
      edge = ji.edge;
    }
  }
  if (!withRow || !(gap < 0)) return { gap };
  if (kind === 0) {
    const w = sat.witness;
    const row =
      w.owner === 0
        ? vertexEdgeRow(space, A, w.edge, B, w.vertex, i, j, 0)
        : vertexEdgeRow(space, B, w.edge, A, w.vertex, j, i, 1);
    return { gap, row };
  }
  // gap = d - 2r, sd(c_j, edge of i) - r, sd(c_i, edge of j) - r
  if (kind === 1) return { gap, row: diskPairRow(space, A, B, i, j) };
  if (kind === 2) return { gap, row: vertexEdgeRow(space, A, edge, B, -1, i, j, 0) };
  return { gap, row: vertexEdgeRow(space, B, edge, A, -1, j, i, 1) };
}

/**
 * Calls `term` for every container gap of piece i below `below` (or not a number): one per vertex (or disk centre)
 * and wall, or per vertex and rim. `row()` builds the gap's row (its value differs from a soft
 * disk gap by the constant r - 1, so its gradient is the gap's).
 */
function wallTerms(ev: Evaluation, i: number, below: number, term: (gap: number, row: () => Row) => void): void {
  const { space, t } = ev;
  const { K, N, M } = space;
  const S = stateOf(ev, i);
  const pts = N === 0 ? [S.centre] : S.verts;
  const pad = N === 0 ? 1 : 0;
  const soft = N > 0 && ev.r < Infinity;
  if (M === 0) {
    // rim: t - d(O, p) - pad; the soft disk's: t - d(O, c) - r
    const disk = soft ? t - distFromVs(K, S.centre.e) - ev.r : -Infinity;
    for (let k = 0; k < pts.length; k++) {
      const gk = t - distFromVs(K, pts[k].e) - pad;
      const gap = Math.max(gk, disk);
      if (gap >= below) continue;
      const kk = N === 0 ? -1 : k;
      term(gap, () => (gk >= disk ? rimRow(space, S, i, kk, t) : rimRow(space, S, i, -1, t)));
    }
    return;
  }
  for (let w = 0; w < M; w++) {
    const n = ev.walls[w];
    const disk = soft ? -asnK(K, lineValue(K, n, S.centre)) - ev.r : -Infinity;
    for (let k = 0; k < pts.length; k++) {
      const gk = -asnK(K, lineValue(K, n, pts[k])) - pad;
      const gap = Math.max(gk, disk);
      if (gap >= below) continue;
      const kk = N === 0 ? -1 : k;
      term(gap, () => (gk >= disk ? wallRow(space, S, i, kk, w, t) : wallRow(space, S, i, -1, w, t)));
    }
  }
}

/**
 * The energy, or the terms of piece `only` (its pairs and walls). With `grad` (length P dim + 1),
 * writes dE/d(offsets) and dE/dsize last.
 */
export function kernelEnergy(
  g: KernelGeometry,
  s: KernelState,
  grad?: Float64Array,
  weights?: Float64Array,
  only = -1,
): number {
  const { P, dim } = g;
  const { t, dtds } = containerVariable(g, s.size);
  const ev = evaluation(g, s, t);
  if (grad) grad.fill(0);
  let E = 0;
  let dEdt = 0;
  const add = (row: Row, gap: number, wt: number) => {
    const f = 2 * wt * gap;
    for (let a = 0; a < dim; a++) {
      grad![row.i * dim + a] += f * row.gi[a];
      if (row.j >= 0) grad![row.j * dim + a] += f * row.gj[a];
    }
    dEdt += f * row.gt;
  };
  const pair = (i: number, j: number) => {
    if (!near(ev, i, j)) return;
    const p = pairTerm(ev, i, j, !!grad);
    if (p.gap >= 0) return;
    // a gap that is not a number (a piece beyond float range) counts as an infinite overlap
    if (!Number.isFinite(p.gap)) return void (E = Infinity);
    const wt = weights ? (weights[i] + weights[j]) / 2 : 1;
    E += wt * p.gap * p.gap;
    if (grad) add(p.row!, p.gap, wt);
  };
  const walls = (i: number) => {
    const wt = weights ? weights[i] : 1;
    wallTerms(ev, i, 0, (gap, row) => {
      if (!Number.isFinite(gap)) return void (E = Infinity);
      E += wt * gap * gap;
      if (grad) add(row(), gap, wt);
    });
  };
  if (only >= 0) {
    for (let j = 0; j < P; j++) if (j !== only) pair(only, j);
    walls(only);
  } else
    for (let i = 0; i < P; i++) {
      for (let j = i + 1; j < P; j++) pair(i, j);
      walls(i);
    }
  if (grad) grad[P * dim] = dEdt * dtds;
  return E;
}

/** True when piece i overlaps no other piece and no wall by more than tol (with the current shape). */
export function kernelClear(g: KernelGeometry, s: KernelState, i: number, tol: number): boolean {
  const ev = evaluation(g, s, containerVariable(g, s.size).t);
  let clear = true;
  wallTerms(ev, i, -tol, () => (clear = false));
  if (!clear) return false;
  for (let j = 0; j < g.P; j++) if (j !== i && near(ev, i, j) && !(pairTerm(ev, i, j, false).gap >= -tol)) return false;
  return true;
}
