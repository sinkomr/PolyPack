/**
 * Rigid geometry of the polyhedra space: placed pieces, the separating-axis test between two placed
 * convex polyhedra and containment in the scaled container.
 *
 * A pose is [x, y, z, qw, qx, qy, qz]: the canonical piece turned by the rotation of the quaternion
 * q / |q| (scalar first; v -> q v q*) and moved so that its centre is at (x, y, z). Any nonzero q is
 * accepted; the rotation is the exactly orthogonal matrix H(q) / |q|^2 that the certifier uses.
 *
 * The separating-axis test follows upstream's src/geom.js and verify_general.py (alejandrozu/
 * platonic-packing, MIT; see THIRD_PARTY_NOTICES.md): the candidate axes are the face normals of
 * both pieces and the cross products of an edge of each whose Gauss-map arcs intersect
 * (D. Gregorius, GDC 2013). Those cross products are the face normals of the Minkowski difference
 * A - B, so for overlapping pieces the smallest overlap over the candidates is the exact penetration
 * depth, and for disjoint pieces some candidate separates them.
 */
import type { Solid } from "./solids";

export type Pose = [number, number, number, number, number, number, number];

/** A piece placed in the world: its vertices, face normals and the edges' adjacent face normals. */
export interface Placed {
  solid: Solid;
  /** Centre. */
  c: [number, number, number];
  /** Row-major rotation, world = R local. */
  R: Float64Array;
  /** World vertices, flat. */
  X: Float64Array;
  /** World unit face normals, flat. */
  FN: Float64Array;
}

/**
 * The rotation of q / |q| as a row-major 3x3 matrix. q is first divided by its largest component, so
 * that tiny or huge quaternions neither underflow nor overflow; throws for a zero or non-finite q.
 */
export function quatToR(qw: number, qx: number, qy: number, qz: number, out = new Float64Array(9)): Float64Array {
  const m = Math.max(Math.abs(qw), Math.abs(qx), Math.abs(qy), Math.abs(qz));
  if (!(m > 0) || !Number.isFinite(m)) throw new RangeError("the quaternion must be finite and nonzero");
  let w = qw / m;
  let x = qx / m;
  let y = qy / m;
  let z = qz / m;
  const n = Math.sqrt(w * w + x * x + y * y + z * z);
  w /= n;
  x /= n;
  y /= n;
  z /= n;
  out[0] = 1 - 2 * (y * y + z * z);
  out[1] = 2 * (x * y - w * z);
  out[2] = 2 * (x * z + w * y);
  out[3] = 2 * (x * y + w * z);
  out[4] = 1 - 2 * (x * x + z * z);
  out[5] = 2 * (y * z - w * x);
  out[6] = 2 * (x * z - w * y);
  out[7] = 2 * (y * z + w * x);
  out[8] = 1 - 2 * (x * x + y * y);
  return out;
}

export function place(solid: Solid, pose: ArrayLike<number>): Placed {
  const R = quatToR(pose[3], pose[4], pose[5], pose[6]);
  const c: [number, number, number] = [pose[0], pose[1], pose[2]];
  const nv = solid.nv;
  const V = solid.V;
  const X = new Float64Array(3 * nv);
  for (let i = 0; i < nv; i++) {
    const a = V[3 * i];
    const b = V[3 * i + 1];
    const d = V[3 * i + 2];
    X[3 * i] = c[0] + R[0] * a + R[1] * b + R[2] * d;
    X[3 * i + 1] = c[1] + R[3] * a + R[4] * b + R[5] * d;
    X[3 * i + 2] = c[2] + R[6] * a + R[7] * b + R[8] * d;
  }
  const F = solid.faces.length;
  const N = solid.N;
  const FN = new Float64Array(3 * F);
  for (let f = 0; f < F; f++) {
    const a = N[3 * f];
    const b = N[3 * f + 1];
    const d = N[3 * f + 2];
    FN[3 * f] = R[0] * a + R[1] * b + R[2] * d;
    FN[3 * f + 1] = R[3] * a + R[4] * b + R[5] * d;
    FN[3 * f + 2] = R[6] * a + R[7] * b + R[8] * d;
  }
  return { solid, c, R, X, FN };
}

/** min and max of X . u over the vertices. */
function project(X: Float64Array, ux: number, uy: number, uz: number, out: Float64Array): void {
  let mn = Infinity;
  let mx = -Infinity;
  for (let j = 0; j < X.length; j += 3) {
    const p = X[j] * ux + X[j + 1] * uy + X[j + 2] * uz;
    if (p < mn) mn = p;
    if (p > mx) mx = p;
  }
  out[0] = mn;
  out[1] = mx;
}

const PA = new Float64Array(2);
const PB = new Float64Array(2);

/** Gap of A and B along unit u: > 0 when u separates them by that much, else minus the smaller overlap. */
function gapAlong(A: Placed, B: Placed, ux: number, uy: number, uz: number): number {
  project(A.X, ux, uy, uz, PA);
  project(B.X, ux, uy, uz, PB);
  return Math.max(PB[0] - PA[1], PA[0] - PB[1]);
}

export interface Separation {
  /**
   * The largest gap over the candidate axes: for overlapping pieces minus the exact penetration
   * depth (<= 0); for disjoint pieces a positive lower bound on their distance. When the test stopped
   * early (see `stopAt`), the gap of the axis that stopped it.
   */
  sep: number;
  /** A unit axis attaining sep (pointing from A to B when sep > 0). */
  axis: [number, number, number];
  /** Number of axes projected. */
  axes: number;
}

/**
 * Separating-axis test of two placed pieces. With `stopAt`, the test ends at the first axis whose gap
 * is at least stopAt (enough to decide sep >= stopAt). `hint`, a unit axis, is tried first.
 */
export function separation(A: Placed, B: Placed, stopAt = Infinity, hint?: ArrayLike<number>): Separation {
  let best = -Infinity;
  let bx = 0;
  let by = 0;
  let bz = 1;
  let axes = 0;
  const consider = (ux: number, uy: number, uz: number): boolean => {
    axes++;
    project(A.X, ux, uy, uz, PA);
    project(B.X, ux, uy, uz, PB);
    const g1 = PB[0] - PA[1];
    const g2 = PA[0] - PB[1];
    const g = g1 >= g2 ? g1 : g2;
    if (g > best) {
      best = g;
      const s = g1 >= g2 ? 1 : -1;
      bx = s * ux;
      by = s * uy;
      bz = s * uz;
    }
    return best >= stopAt;
  };
  const done = (): Separation => ({ sep: best, axis: [bx, by, bz], axes });
  if (hint) {
    const l = Math.hypot(hint[0], hint[1], hint[2]);
    if (l > 0 && consider(hint[0] / l, hint[1] / l, hint[2] / l)) return done();
  }
  // the line between the centres often separates and is cheap to try
  {
    const dx = B.c[0] - A.c[0];
    const dy = B.c[1] - A.c[1];
    const dz = B.c[2] - A.c[2];
    const l = Math.hypot(dx, dy, dz);
    if (l > 0 && consider(dx / l, dy / l, dz / l)) return done();
  }
  const FA = A.FN;
  const FB = B.FN;
  for (let f = 0; f < FA.length; f += 3) if (consider(FA[f], FA[f + 1], FA[f + 2])) return done();
  for (let f = 0; f < FB.length; f += 3) if (consider(FB[f], FB[f + 1], FB[f + 2])) return done();
  // edge-edge axes with Gauss-map pruning. For an edge with faces (f1, f2) the arc runs from n1 to n2
  // on the Gauss map; B's arcs are negated. Arcs (a, b) and (c, d) intersect iff
  //   (c . (b x a)) (d . (b x a)) < 0, (a . (d x c)) (b . (d x c)) < 0 and (c . (b x a)) (b . (d x c)) > 0,
  // with c = -nB1, d = -nB2 (the test of geom.js edgeAxes).
  const EA = A.solid.edgeFaces;
  const EB = B.solid.edgeFaces;
  const nb = EB.length;
  const cb = new Float64Array(3 * nb); // nB2 x nB1 per edge of B (= d x c), unnormalised
  for (let j = 0; j < nb; j++) {
    const [g1, g2] = EB[j];
    const c1x = FB[3 * g1];
    const c1y = FB[3 * g1 + 1];
    const c1z = FB[3 * g1 + 2];
    const c2x = FB[3 * g2];
    const c2y = FB[3 * g2 + 1];
    const c2z = FB[3 * g2 + 2];
    cb[3 * j] = c2y * c1z - c2z * c1y;
    cb[3 * j + 1] = c2z * c1x - c2x * c1z;
    cb[3 * j + 2] = c2x * c1y - c2y * c1x;
  }
  for (let i = 0; i < EA.length; i++) {
    const [f1, f2] = EA[i];
    const ax = FA[3 * f1];
    const ay = FA[3 * f1 + 1];
    const az = FA[3 * f1 + 2];
    const bxx = FA[3 * f2];
    const byy = FA[3 * f2 + 1];
    const bzz = FA[3 * f2 + 2];
    // b x a
    const pcx = byy * az - bzz * ay;
    const pcy = bzz * ax - bxx * az;
    const pcz = bxx * ay - byy * ax;
    for (let j = 0; j < nb; j++) {
      const [g1, g2] = EB[j];
      // C = -nB1, D = -nB2
      const CBA = -(FB[3 * g1] * pcx + FB[3 * g1 + 1] * pcy + FB[3 * g1 + 2] * pcz);
      const DBA = -(FB[3 * g2] * pcx + FB[3 * g2 + 1] * pcy + FB[3 * g2 + 2] * pcz);
      if (CBA * DBA >= 0) continue;
      const qx = cb[3 * j];
      const qy = cb[3 * j + 1];
      const qz = cb[3 * j + 2];
      const ADC = ax * qx + ay * qy + az * qz;
      const BDC = bxx * qx + byy * qy + bzz * qz;
      if (ADC * BDC >= 0 || CBA * BDC <= 0) continue;
      // the axis is the cross product of the two edge directions, i.e. of (b x a) and (d x c)
      let wx = pcy * qz - pcz * qy;
      let wy = pcz * qx - pcx * qz;
      let wz = pcx * qy - pcy * qx;
      const l = Math.hypot(wx, wy, wz);
      if (l < 1e-12) continue;
      wx /= l;
      wy /= l;
      wz /= l;
      if (consider(wx, wy, wz)) return done();
    }
  }
  return done();
}

/**
 * Smallest container scale holding a placed piece, and the face that sets it: max over vertices and
 * container faces of (N_f . x) / b_f (the container is centred at the origin).
 */
export function containerScaleOf(container: Solid, X: Float64Array): number {
  const N = container.N;
  const b = container.offsets;
  let s = -Infinity;
  for (let f = 0; f < b.length; f++) {
    const nx = N[3 * f];
    const ny = N[3 * f + 1];
    const nz = N[3 * f + 2];
    let m = -Infinity;
    for (let j = 0; j < X.length; j += 3) {
      const p = X[j] * nx + X[j + 1] * ny + X[j + 2] * nz;
      if (p > m) m = p;
    }
    const r = m / b[f];
    if (r > s) s = r;
  }
  return s;
}

/** Smallest wall gap s b_f - N_f . x over the piece's vertices and the container's faces (unit normals). */
export function wallGap(container: Solid, s: number, X: Float64Array): number {
  const N = container.N;
  const b = container.offsets;
  let g = Infinity;
  for (let f = 0; f < b.length; f++) {
    const nx = N[3 * f];
    const ny = N[3 * f + 1];
    const nz = N[3 * f + 2];
    const lim = s * b[f];
    for (let j = 0; j < X.length; j += 3) {
      const d = lim - (X[j] * nx + X[j + 1] * ny + X[j + 2] * nz);
      if (d < g) g = d;
    }
  }
  return g;
}

export { gapAlong };
