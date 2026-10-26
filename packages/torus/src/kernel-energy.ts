/**
 * The penalty energy of the torus kernel (kernel.ts), with its exact gradient.
 *
 * Variables, as in the search (search.ts): the packing is a base packing (a basis B, centres u_i
 * and angles th_i, kept in the state's aux) mapped by k F, where k = size / score(B) scales
 * everything (pieces keep side 1 or radius 1) and, for the free family, F = [[e^t1, t2],
 * [0, e^-t1]] is a shear of determinant 1 (the cell's shape; the 2 globals t1, t2). Piece i has
 * the offsets x_i = (dx, dy, R dtheta): its centre is k F (u_i + (dx, dy)) and its angle
 * th_i + dtheta, R being the circumradius, so every variable is a length. Disks have no angle.
 * The lattice is k F B, and its score is the size, since det F = 1.
 *
 * Terms: for every image pair (i, j, lambda) with |c_j + lambda - c_i| < 2R (the validator's
 * enumeration window, lattice.ts), the squared penetration depth of the shared geometry kernel
 * (pairPenetration of @polypack/geometry: the separating-axis value, which is the exact
 * penetration depth of two convex polygons that overlap, with its analytic pose derivatives).
 * A piece and its own translates are pairs too, once per lambda (the half plane, as in the
 * validator).
 *
 * Soft shapes (setShape, polygons): the piece scaled by t about its centre and dilated by
 * (1 - t) r, r the inradius, exactly as kernel.ts defines it; pairPenetration computes the exact
 * penetration depth of such rounded polygons (scale t, padding (1 - t) r). A rounded polygon lies
 * in the polygon (it is t K + (1 - t) r D, and K contains r D), and penetration depth only grows
 * with the shapes, so softening never adds energy; at t = 0 it is the inscribed disk.
 *
 * Gradient: with v = c_j + lambda - c_i = k F delta (delta the same vector in the base frame),
 * dv/dk = v / k, dv/dt1 = k (e^t1 delta_x, -e^-t1 delta_y), dv/dt2 = k (delta_y, 0); a centre's
 * offset enters through k F, an angle's through 1 / R.
 */
import { type Pose, boundingRadius, inradius, pairPenetration, penaltyEdgeNormals } from "@polypack/geometry";
import { type Lattice, type TorusFamily, familyLattice } from "./lattice";

/** The kernel's state as this module reads it (kernel.ts owns the type). */
export interface TorusStateView {
  x: Float64Array;
  size: number;
  aux: TorusKernelAux;
}

/** The kernel's data in KernelState.aux: the base packing and the soft-shape parameter. */
export interface TorusKernelAux {
  /** The base basis [b1x, b1y, b2x, b2y]; for sq and hex always familyLattice(family, sb). */
  B: Float64Array;
  /** The score of the base lattice. */
  sb: number;
  /** Base centres, 2 per piece. */
  u: Float64Array;
  /** Base angles, 1 per piece (kept for disks too, where they only round-trip). */
  th: Float64Array;
  /** The soft-shape parameter (1 = the true shape). */
  t: number;
}

/** Image candidates per pair beyond which a state counts as degenerate (energy Infinity). */
const MAX_WINDOW = 4096;

// what pairTerms computes
const ENERGY = 0;
const GRADIENT = 1;
const CLEAR = 2;

export class TorusEnergy {
  readonly family: TorusFamily;
  readonly N: number;
  readonly P: number;
  /** Variables per piece: 3, or 2 for disks. */
  readonly dim: number;
  readonly globals: number;
  /** The circumradius (1 for disks): the reach of a pair and the scale of the angle variable. */
  readonly R: number;
  private readonly r: number;

  // the evaluation in progress
  private k = 1;
  private f11 = 1;
  private f12 = 0;
  private f22 = 1;
  private et = 1;
  private readonly L = new Float64Array(4);
  private det = 1;
  private X1 = 0;
  private X2 = 0;
  private scale = 1;
  private padding = 0;
  private readonly c: Float64Array;
  /** The centres' coordinates in the lattice basis. */
  private readonly ab: Float64Array;
  private readonly theta: Float64Array;
  private readonly axes: Float64Array[];
  private readonly pa: Pose = { x: 0, y: 0, theta: 0 };
  private readonly pb: Pose = { x: 0, y: 0, theta: 0 };

  // gradient accumulators: world centres, angles, k, t1, t2
  private readonly gc: Float64Array;
  private readonly gth: Float64Array;
  private gk = 0;
  private gt1 = 0;
  private gt2 = 0;

  constructor(family: TorusFamily, N: number, P: number) {
    this.family = family;
    this.N = N;
    this.P = P;
    this.dim = N === 0 ? 2 : 3;
    this.globals = family === "free" ? 2 : 0;
    this.R = boundingRadius(N);
    this.r = N === 0 ? 1 : inradius(N);
    this.c = new Float64Array(2 * P);
    this.ab = new Float64Array(2 * P);
    this.theta = new Float64Array(P);
    this.axes = Array.from({ length: P }, () => new Float64Array(3 * Math.max(1, N)));
    this.gc = new Float64Array(2 * P);
    this.gth = new Float64Array(P);
  }

  /** Places the pieces and the lattice of state s; false when the state is degenerate. */
  private begin(s: TorusStateView): boolean {
    const { P, N, dim } = this;
    const a = s.aux;
    const x = s.x;
    if (!(s.size > 0) || !Number.isFinite(s.size) || !x.every(Number.isFinite)) return false;
    const k = s.size / a.sb;
    let t1 = 0;
    let t2 = 0;
    if (this.globals) {
      t1 = x[P * dim];
      t2 = x[P * dim + 1];
      // the search's limit on the stretch: beyond it the cell is too thin to be worth enumerating
      if (!(Math.abs(t1) < 2)) return false;
    }
    this.k = k;
    this.et = Math.exp(t1);
    this.f11 = k * this.et;
    this.f12 = k * t2;
    this.f22 = k / this.et;
    const B = a.B;
    const L = this.L;
    L[0] = this.f11 * B[0] + this.f12 * B[1];
    L[1] = this.f22 * B[1];
    L[2] = this.f11 * B[2] + this.f12 * B[3];
    L[3] = this.f22 * B[3];
    for (let i = 0; i < P; i++) {
      const px = a.u[2 * i] + x[dim * i];
      const py = a.u[2 * i + 1] + x[dim * i + 1];
      this.c[2 * i] = this.f11 * px + this.f12 * py;
      this.c[2 * i + 1] = this.f22 * py;
      this.theta[i] = N === 0 ? 0 : a.th[i] + x[dim * i + 2] / this.R;
    }
    return this.layout(N === 0 ? 1 : Math.max(0, Math.min(1, a.t)));
  }

  /**
   * With the lattice L, the centres and the angles set: the enumeration window, the centres'
   * lattice coordinates, the edge axes and the soft shape t; false when the lattice is degenerate.
   */
  private layout(t: number): boolean {
    const { P, N } = this;
    const L = this.L;
    this.det = L[0] * L[3] - L[1] * L[2];
    const area = Math.abs(this.det);
    // the enumeration window of lattice.ts for reach 2R
    const reach = 2 * this.R;
    this.X1 = (reach * Math.hypot(L[2], L[3])) / area;
    this.X2 = (reach * Math.hypot(L[0], L[1])) / area;
    if (!(area > 0) || !((2 * this.X1 + 1) * (2 * this.X2 + 1) <= MAX_WINDOW)) return false;
    for (let i = 0; i < P; i++) {
      const cx = this.c[2 * i];
      const cy = this.c[2 * i + 1];
      // Cramer's rule
      let a = (cx * L[3] - cy * L[2]) / this.det;
      let b = (L[0] * cy - L[1] * cx) / this.det;
      // A centre more than a cell outside the cell comes back by a lattice vector, which changes
      // no image pair. Every pair's lattice coordinates then differ by less than 3, so pairTerms
      // visits a few lattice vectors per pair; a centre too far out for that is degenerate.
      if (!(Math.abs(a) < 2 ** 40 && Math.abs(b) < 2 ** 40)) return false;
      if (a < -1 || a >= 2 || b < -1 || b >= 2) {
        const m = Math.floor(a);
        const n = Math.floor(b);
        this.c[2 * i] = cx - m * L[0] - n * L[2];
        this.c[2 * i + 1] = cy - m * L[1] - n * L[3];
        a -= m;
        b -= n;
      }
      this.ab[2 * i] = a;
      this.ab[2 * i + 1] = b;
      if (N !== 0) penaltyEdgeNormals(N, this.theta[i], this.axes[i]);
    }
    this.scale = t;
    this.padding = t === 1 ? 0 : (1 - t) * this.r;
    return true;
  }

  /**
   * True when no image pair of the packing (a lattice and poses in the plane, the true shapes)
   * overlaps: every separating-axis value >= 0. The values are those of the validator
   * (pairPenetration's depth is pieceSeparation's value, negated, with the same arithmetic), so
   * this is its verdict at tolerance 0, up to the rounding of the image vectors. The kernel's
   * finish bisects with it and then asks the validator itself.
   */
  separatedAt(lattice: Lattice, poses: readonly Pose[]): boolean {
    const L = this.L;
    L.set([lattice.b1[0], lattice.b1[1], lattice.b2[0], lattice.b2[1]]);
    poses.forEach((p, i) => {
      this.c[2 * i] = p.x;
      this.c[2 * i + 1] = p.y;
      this.theta[i] = this.N === 0 ? 0 : p.theta;
    });
    if (!poses.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.theta))) return false;
    if (!this.layout(1)) return false;
    for (let i = 0; i < this.P; i++)
      for (let j = i; j < this.P; j++) if (this.pairTerms(i, j, CLEAR, 1, 0)) return false;
    return true;
  }

  /**
   * The image pairs of (i, j) within reach (for i = j, the translates in the half plane): with
   * mode ENERGY, the sum of their weighted terms; with GRADIENT, the same with the gradient
   * added to the accumulators; with CLEAR, 1 when one of them overlaps by more than tol, else 0.
   */
  private pairTerms(i: number, j: number, mode: number, w: number, tol = 0): number {
    const L = this.L;
    const c = this.c;
    const dx = c[2 * j] - c[2 * i];
    const dy = c[2 * j + 1] - c[2 * i + 1];
    // every lambda = m b1 + n b2 with |c_j + lambda - c_i| < 2R has |a0 + m| <= X1 and
    // |b0 + n| <= X2 (lattice.ts); a pair at exactly 2R has no term, so no rounding guard is needed.
    // layout keeps |a0|, |b0| < 3 and X1, X2 small, so the loops are short.
    const a0 = this.ab[2 * j] - this.ab[2 * i];
    const b0 = this.ab[2 * j + 1] - this.ab[2 * i + 1];
    const mLo = Math.ceil(-a0 - this.X1);
    const mHi = Math.floor(-a0 + this.X1);
    const nLo = Math.ceil(-b0 - this.X2);
    const nHi = Math.floor(-b0 + this.X2);
    const reach2 = 4 * this.R * this.R;
    const pa = this.pa;
    const pb = this.pb;
    pa.theta = this.theta[i];
    pb.theta = this.theta[j];
    let e = 0;
    for (let m = mLo; m <= mHi; m++)
      for (let n = nLo; n <= nHi; n++) {
        if (i === j && !(m > 0 || (m === 0 && n > 0))) continue;
        const vx = dx + m * L[0] + n * L[2];
        const vy = dy + m * L[1] + n * L[3];
        if (vx * vx + vy * vy >= reach2) continue;
        // piece i at the origin, as in the validator: only relative positions matter
        pb.x = vx;
        pb.y = vy;
        const pen = pairPenetration(this.N, pa, pb, this.axes[i], this.axes[j], this.scale, this.padding);
        const depth = pen.depth;
        if (!(depth > 0)) continue;
        if (mode === CLEAR) {
          if (depth > tol) return 1;
          continue;
        }
        e += w * depth * depth;
        if (mode === GRADIENT) this.pairGrad(i, j, 2 * w * depth, pen, vx, vy);
      }
    return e;
  }

  energy(s: TorusStateView, grad?: Float64Array, weights?: Float64Array): number {
    const { P, dim, globals } = this;
    if (grad) grad.fill(0);
    if (!this.begin(s)) return Infinity;
    if (grad) {
      this.gc.fill(0);
      this.gth.fill(0);
      this.gk = 0;
      this.gt1 = 0;
      this.gt2 = 0;
    }
    const mode = grad ? GRADIENT : ENERGY;
    let e = 0;
    for (let i = 0; i < P; i++)
      for (let j = i; j < P; j++) e += this.pairTerms(i, j, mode, weights ? (weights[i] + weights[j]) / 2 : 1);
    if (grad) {
      for (let i = 0; i < P; i++) {
        // d(centre)/d(offset) = k F, so dE/d(offset) = (k F)^T dE/d(centre); f11 etc. include k
        const gx = this.gc[2 * i];
        const gy = this.gc[2 * i + 1];
        grad[dim * i] = this.f11 * gx;
        grad[dim * i + 1] = this.f12 * gx + this.f22 * gy;
        if (dim === 3) grad[dim * i + 2] = this.gth[i] / this.R;
      }
      if (globals) {
        grad[P * dim] = this.gt1;
        grad[P * dim + 1] = this.gt2;
      }
      // k = size / sb
      grad[P * dim + globals] = this.gk / s.aux.sb;
    }
    return e;
  }

  private pairGrad(
    i: number,
    j: number,
    dEdd: number,
    pen: ReturnType<typeof pairPenetration>,
    vx: number,
    vy: number,
  ): void {
    const gc = this.gc;
    // piece i sits at the origin and piece j's image at v = c_j + lambda - c_i
    gc[2 * i] += dEdd * pen.a.x;
    gc[2 * i + 1] += dEdd * pen.a.y;
    gc[2 * j] += dEdd * pen.b.x;
    gc[2 * j + 1] += dEdd * pen.b.y;
    this.gth[i] += dEdd * pen.a.theta;
    this.gth[j] += dEdd * pen.b.theta;
    const gvx = dEdd * pen.b.x;
    const gvy = dEdd * pen.b.y;
    // v = k F delta: dv/dk = v / k
    this.gk += (gvx * vx + gvy * vy) / this.k;
    if (this.globals) {
      // delta = (k F)^-1 v, (k F)^-1 = [[1 / f11, -f12 / (f11 f22)], [0, 1 / f22]]
      const deltaY = vy / this.f22;
      const deltaX = (vx - this.f12 * deltaY) / this.f11;
      const k = this.k;
      this.gt1 += gvx * k * this.et * deltaX - gvy * (k / this.et) * deltaY;
      this.gt2 += gvx * k * deltaY;
    }
  }

  /** The terms of piece i alone: its image pairs with every piece, itself included. */
  pieceEnergy(s: TorusStateView, i: number, weights?: Float64Array): number {
    if (!this.begin(s)) return Infinity;
    let e = 0;
    for (let j = 0; j < this.P; j++) e += this.pairTerms(i, j, ENERGY, weights ? (weights[i] + weights[j]) / 2 : 1);
    return e;
  }

  /** True when no image pair of piece i overlaps by more than tol. */
  clear(s: TorusStateView, i: number, tol: number): boolean {
    if (!this.begin(s)) return false;
    for (let j = 0; j < this.P; j++) if (this.pairTerms(i, j, CLEAR, 1, tol)) return false;
    return true;
  }
}

/** The base basis of a sq or hex lattice of score sb (familyLattice), flattened. */
export function familyBasis(family: "sq" | "hex", sb: number): Float64Array {
  const l = familyLattice(family, sb);
  return Float64Array.from([l.b1[0], l.b1[1], l.b2[0], l.b2[1]]);
}
