/**
 * The penalty energy of the sphere kernel (kernel.ts), with its exact gradient.
 *
 * Variables. Piece i has an anchor quaternion q0_i and a rotation vector w_i about a world axis:
 * its pose is q_i = exp(w_i) q0_i, as in the search (search.ts). The kernel's variables are
 * x_i = rho w_i, so that a rotation about an axis at right angles to the piece's centre moves the
 * centre by |x_i| along the sphere of radius rho: every variable is a length. The size is rho, and
 * the pieces' angular size on the unit sphere is a = 1/rho (geometry.ts).
 *
 * Terms, each a length, squared:
 *  - polygons: m = -rho G, G the separating-edge value of the pair (the largest, over the edge
 *    great circles of both pieces, of the smallest sine distance of the other piece's vertices
 *    beyond the edge; search.ts and docs/spaces/SPHERE.md section 3). G >= 0 separates the cones
 *    over the pieces. For two pieces in a common open hemisphere the converse holds as well: the
 *    gnomonic chart maps them to convex polygons, and disjoint convex polygons are separated by
 *    the line of an edge of one of them (the Minkowski difference argument). Pairs whose
 *    circumscribed caps are disjoint (centres more than 2R apart, as in the validator) are skipped;
 *  - disks: m = rho (2a - theta) = 2 - rho theta, theta the angle between the centres: the
 *    validator's gap, negated;
 *  - one wall term per piece, rho_cap - rho, where rho_cap = 1 / aCap (kernel.ts chooses aCap) is
 *    just above the smallest rho at which the piece exists (polygons) or two disks fit (disks).
 *    Below it the shapes are those of rho_cap, so the energy stays finite and its gradient continuous.
 *
 * Soft shapes (setShape, polygons only). The soft piece at t in [0, 1) is the piece cut by the cap
 * about its centre of angular radius rho_t = t R + (1 - t) r (R, r the angular circumradius and
 * inradius): the inscribed cap at t = 0, the polygon at t = 1, always inside the polygon. The
 * planar soft piece of kernel.ts (the piece scaled by t and dilated by (1 - t) r) has the same
 * circumradius t R + (1 - t) r, so it lies in this one. The term of a pair is min(m_polygon, m_cap)
 * with m_cap = rho (2 rho_t - theta): it is <= 0 only when the polygons or the caps are disjoint,
 * and either makes the cut pieces disjoint; and it never exceeds the true term, so softening never
 * adds energy. At t = 1 the term is the polygon's alone.
 *
 * Gradient. Rotating piece i by a small world rotation dw moves its points v by dw x v. With the
 * left Jacobian J of SO(3), exp(w + d) = exp(J(w) d) exp(w) to first order, so dE/dw_i =
 * J(w_i)^T dE/d(omega_i), omega_i the world rotation. For the active feature of a polygon pair
 * (edge normal n of one piece, vertex v of the other, G = -n.v) dG/d(omega) is -(n x v) for the
 * edge's piece and +(n x v) for the vertex's. For a cap or disk pair d(theta)/d(omega) is -u for
 * piece i and +u for piece j, u = (c_i x c_j) / |c_i x c_j|. The size enters through the factor
 * rho, through w = x / rho and through the shapes' R(a) and r(a), whose derivatives are closed forms.
 */
import { type Quat, type Vec3, circumradiusAngle, inradiusAngle } from "./geometry";
import { maxMarginPlane } from "./validate";

/** The kernel's state as this module reads it (kernel.ts owns the type). */
export interface SphereStateView {
  x: Float64Array;
  size: number;
  aux: { q0: Float64Array; t: number };
}

const SAT = 1;
const CAP = 2;

export class SphereEnergy {
  readonly N: number;
  readonly P: number;
  /** Largest angular size used for the shapes; the wall terms start at rho_cap = 1 / aCap. */
  readonly aCap: number;
  readonly rhoCap: number;

  // the standard piece at angular size `shapeA`: vertices and inward edge normals, and their derivatives
  private shapeA = NaN;
  private R = 0;
  private r = 0;
  private dRda = 0;
  private drda = 0;
  private readonly stdV: Float64Array;
  private readonly stdDV: Float64Array;
  private readonly stdE: Float64Array;
  private readonly stdDE: Float64Array;

  // the placed pieces: rotation matrices (row-major), centres, vertices, inward edge normals
  private readonly M: Float64Array;
  private readonly C: Float64Array;
  private readonly V: Float64Array;
  private readonly E: Float64Array;

  // the evaluation in progress
  private rho = 1;
  /** 1 when the shapes follow a (a < aCap), 0 when they are clamped at aCap. */
  private live = 1;
  private t = 1;
  private capR = 0;
  private dCapR = 0;
  private cosCull = -1;

  // the active feature of the last pair computed
  private kind = 0;
  private fOwner = 0;
  private fEdge = 0;
  private fVert = 0;
  private fG = 0;
  private fTheta = 0;
  private readonly fAxis = new Float64Array(3);

  // gradient accumulators: world rotations, d/da of the shapes, explicit d/drho
  private readonly gOmega: Float64Array;
  private gA = 0;
  private gRho = 0;

  constructor(N: number, P: number, aCap: number) {
    this.N = N;
    this.P = P;
    this.aCap = aCap;
    this.rhoCap = 1 / aCap;
    const k = Math.max(1, N);
    this.stdV = new Float64Array(3 * k);
    this.stdDV = new Float64Array(3 * k);
    this.stdE = new Float64Array(3 * k);
    this.stdDE = new Float64Array(3 * k);
    this.M = new Float64Array(9 * P);
    this.C = new Float64Array(3 * P);
    this.V = new Float64Array(3 * k * P);
    this.E = new Float64Array(3 * k * P);
    this.gOmega = new Float64Array(3 * P);
  }

  /** The standard piece at angular size a (vertex 0 up, geometry.ts), with d/dR and d/dr. */
  private setShape(a: number): void {
    if (a === this.shapeA) return;
    this.shapeA = a;
    const N = this.N;
    if (N === 0) return;
    const rho = 1 / a;
    const R = circumradiusAngle(N, rho);
    const r = inradiusAngle(N, rho);
    this.R = R;
    this.r = r;
    // sin(a/2) = sin R sin(pi/N) and tan(a/2) = sin r tan(pi/N), differentiated in a
    this.dRda = Math.cos(a / 2) / (2 * Math.sin(Math.PI / N) * Math.cos(R));
    this.drda = 1 / (2 * Math.cos(a / 2) ** 2 * Math.tan(Math.PI / N) * Math.cos(r));
    for (let k = 0; k < N; k++) {
      const phi = Math.PI / 2 + (2 * Math.PI * k) / N;
      const psi = phi + Math.PI / N;
      // vertex k at circumradius R; the inward normal of edge k (vertex k to k + 1) is the unit
      // vector at right angles to the edge midpoint (direction psi, distance r) towards the centre
      this.stdV.set([Math.sin(R) * Math.cos(phi), Math.sin(R) * Math.sin(phi), Math.cos(R)], 3 * k);
      this.stdDV.set([Math.cos(R) * Math.cos(phi), Math.cos(R) * Math.sin(phi), -Math.sin(R)], 3 * k);
      this.stdE.set([-Math.cos(r) * Math.cos(psi), -Math.cos(r) * Math.sin(psi), Math.sin(r)], 3 * k);
      this.stdDE.set([Math.sin(r) * Math.cos(psi), Math.sin(r) * Math.sin(psi), Math.cos(r)], 3 * k);
    }
  }

  /** Sets up an evaluation at the state's size and shape; false when the size is not usable. */
  private begin(s: SphereStateView): boolean {
    const rho = s.size;
    if (!(rho > 0) || !Number.isFinite(rho)) return false;
    this.rho = rho;
    const a = 1 / rho;
    this.live = a < this.aCap ? 1 : 0;
    const aEff = Math.min(a, this.aCap);
    const N = this.N;
    this.t = N === 0 ? 1 : Math.max(0, Math.min(1, s.aux.t));
    if (N === 0) {
      // disks of angular radius a overlap only when their centres are closer than 2a
      this.cosCull = 2 * a < Math.PI ? Math.cos(2 * a) : -2;
    } else {
      this.setShape(aEff);
      const t = this.t;
      this.capR = t * this.R + (1 - t) * this.r;
      this.dCapR = (t * this.dRda + (1 - t) * this.drda) * this.live;
      // circumscribed caps more than 2R apart are disjoint (the validator's "far" pairs)
      this.cosCull = Math.cos(Math.min(Math.PI, 2 * this.R + 1e-9));
    }
    return true;
  }

  /** Places every piece: q_i = exp(x_i / rho) q0_i. */
  private placeAll(s: SphereStateView): void {
    for (let i = 0; i < this.P; i++) this.place(s, i);
  }

  private place(s: SphereStateView, i: number): void {
    const x = s.x;
    const q0 = s.aux.q0;
    const rho = this.rho;
    const q = quatMulExp(x[3 * i] / rho, x[3 * i + 1] / rho, x[3 * i + 2] / rho, q0, 4 * i);
    const M = this.M;
    const o = 9 * i;
    matrixInto(q, M, o);
    this.C[3 * i] = M[o + 2];
    this.C[3 * i + 1] = M[o + 5];
    this.C[3 * i + 2] = M[o + 8];
    const N = this.N;
    if (N === 0) return;
    rotateAll(M, o, this.stdV, this.V, 3 * N * i, N);
    rotateAll(M, o, this.stdE, this.E, 3 * N * i, N);
  }

  /**
   * The overlap length of pieces i and j (> 0 when they overlap by the model), remembering the
   * active feature for pairGrad; -Infinity for pairs too far apart to matter.
   */
  private pair(i: number, j: number): number {
    const C = this.C;
    const ci = 3 * i;
    const cj = 3 * j;
    const dot = C[ci] * C[cj] + C[ci + 1] * C[cj + 1] + C[ci + 2] * C[cj + 2];
    this.kind = 0;
    if (dot < this.cosCull) return -Infinity;
    const rho = this.rho;
    const N = this.N;
    if (N === 0 || this.t < 1) {
      // the angle between the centres, and the axis of the rotation that takes c_i towards c_j
      const ux = C[ci + 1] * C[cj + 2] - C[ci + 2] * C[cj + 1];
      const uy = C[ci + 2] * C[cj] - C[ci] * C[cj + 2];
      const uz = C[ci] * C[cj + 1] - C[ci + 1] * C[cj];
      const sn = Math.hypot(ux, uy, uz);
      const theta = Math.atan2(sn, dot);
      const capR = N === 0 ? 1 / rho : this.capR;
      const mCap = rho * (2 * capR - theta);
      if (mCap <= 0 && N !== 0) return mCap;
      this.kind = CAP;
      this.fTheta = theta;
      if (sn > 1e-300) this.fAxis.set([ux / sn, uy / sn, uz / sn]);
      else anyNormal(C, ci, this.fAxis);
      if (N === 0) return mCap;
      const mSat = this.sat(i, j);
      if (mSat < mCap) return mSat;
      this.kind = CAP;
      return mCap;
    }
    return this.sat(i, j);
  }

  /** The polygon term -rho G of the separating-edge value G; sets the feature when it is positive. */
  private sat(i: number, j: number): number {
    const N = this.N;
    const V = this.V;
    const E = this.E;
    let G = -Infinity;
    let owner = 0;
    let edge = 0;
    let vert = 0;
    for (let pass = 0; pass < 2; pass++) {
      const eo = 3 * N * (pass === 0 ? i : j);
      const vo = 3 * N * (pass === 0 ? j : i);
      for (let e = 0; e < N; e++) {
        const nx = E[eo + 3 * e];
        const ny = E[eo + 3 * e + 1];
        const nz = E[eo + 3 * e + 2];
        let lo = Infinity;
        let lv = 0;
        for (let l = 0; l < N; l++) {
          // sine distance of the vertex beyond the edge great circle (positive outside the edge)
          const d = -(nx * V[vo + 3 * l] + ny * V[vo + 3 * l + 1] + nz * V[vo + 3 * l + 2]);
          if (d < lo) {
            lo = d;
            lv = l;
            if (lo <= G) break;
          }
        }
        if (lo >= 0) return -this.rho * lo; // this edge separates the pair
        if (lo > G) {
          G = lo;
          owner = pass;
          edge = e;
          vert = lv;
        }
      }
    }
    this.kind = SAT;
    this.fOwner = owner;
    this.fEdge = edge;
    this.fVert = vert;
    this.fG = G;
    return -this.rho * G;
  }

  /** Adds dE/dm times the gradient of the last pair's term m (pair(i, j) must come just before). */
  private pairGrad(i: number, j: number, dEdm: number): void {
    const rho = this.rho;
    const g = this.gOmega;
    if (this.kind === CAP) {
      // m = rho (2 capR - theta); d(theta)/d(omega_i) = -u, d(theta)/d(omega_j) = +u
      const u = this.fAxis;
      const k = dEdm * rho;
      for (let c = 0; c < 3; c++) {
        g[3 * i + c] += k * u[c];
        g[3 * j + c] -= k * u[c];
      }
      if (this.N === 0) this.gRho += dEdm * -this.fTheta;
      else {
        this.gRho += dEdm * (2 * this.capR - this.fTheta);
        this.gA += dEdm * 2 * rho * this.dCapR;
      }
      return;
    }
    if (this.kind !== SAT) return;
    // G = -(n . v): n the edge normal of piece p, v the vertex of piece q; m = -rho G
    const N = this.N;
    const p = this.fOwner === 0 ? i : j;
    const q = this.fOwner === 0 ? j : i;
    const no = 3 * N * p + 3 * this.fEdge;
    const vo = 3 * N * q + 3 * this.fVert;
    const E = this.E;
    const V = this.V;
    const nx = E[no];
    const ny = E[no + 1];
    const nz = E[no + 2];
    const vx = V[vo];
    const vy = V[vo + 1];
    const vz = V[vo + 2];
    // dG/d(omega_p) = -(n x v), dG/d(omega_q) = +(n x v); dm/dG = -rho
    const X0 = ny * vz - nz * vy;
    const X1 = nz * vx - nx * vz;
    const X2 = nx * vy - ny * vx;
    const k = dEdm * rho;
    g[3 * p] += k * X0;
    g[3 * p + 1] += k * X1;
    g[3 * p + 2] += k * X2;
    g[3 * q] -= k * X0;
    g[3 * q + 1] -= k * X1;
    g[3 * q + 2] -= k * X2;
    this.gRho += dEdm * -this.fG;
    if (this.live) {
      // the shape: n = M_p n_std(r(a)), v = M_q v_std(R(a))
      const M = this.M;
      const dn = rotate1(M, 9 * p, this.stdDE, 3 * this.fEdge);
      const dv = rotate1(M, 9 * q, this.stdDV, 3 * this.fVert);
      const dGda =
        -(dn[0] * vx + dn[1] * vy + dn[2] * vz) * this.drda - (nx * dv[0] + ny * dv[1] + nz * dv[2]) * this.dRda;
      this.gA += dEdm * -rho * dGda;
    }
  }

  /** The energy at the state's size (kernel.ts), with dE/dx and, last, dE/drho in grad. */
  energy(s: SphereStateView, grad?: Float64Array, weights?: Float64Array): number {
    const P = this.P;
    if (grad) grad.fill(0);
    if (!this.begin(s) || !s.x.every(Number.isFinite)) return Infinity;
    this.placeAll(s);
    if (grad) {
      this.gOmega.fill(0);
      this.gA = 0;
      this.gRho = 0;
    }
    let e = 0;
    for (let i = 0; i < P; i++)
      for (let j = i + 1; j < P; j++) {
        const m = this.pair(i, j);
        if (!(m > 0)) continue;
        const w = weights ? (weights[i] + weights[j]) / 2 : 1;
        e += w * m * m;
        if (grad) this.pairGrad(i, j, 2 * w * m);
      }
    const wall = this.rhoCap - this.rho;
    if (wall > 0)
      for (let i = 0; i < P; i++) {
        const w = weights ? weights[i] : 1;
        e += w * wall * wall;
        if (grad) this.gRho -= 2 * w * wall;
      }
    if (grad) this.finishGrad(s, grad);
    return e;
  }

  /** dE/dx_i = J(w_i)^T dE/d(omega_i) / rho, and dE/drho with w = x / rho and a = 1 / rho. */
  private finishGrad(s: SphereStateView, grad: Float64Array): void {
    const P = this.P;
    const rho = this.rho;
    const x = s.x;
    let gSize = this.gRho - this.gA / (rho * rho);
    const out = new Float64Array(3);
    for (let i = 0; i < P; i++) {
      const wx = x[3 * i] / rho;
      const wy = x[3 * i + 1] / rho;
      const wz = x[3 * i + 2] / rho;
      jacobianTransposeTimes(wx, wy, wz, this.gOmega, 3 * i, out);
      grad[3 * i] = out[0] / rho;
      grad[3 * i + 1] = out[1] / rho;
      grad[3 * i + 2] = out[2] / rho;
      gSize -= (out[0] * wx + out[1] * wy + out[2] * wz) / rho;
    }
    grad[3 * P] = gSize;
  }

  /** The terms of piece i alone: its pairs and its wall. */
  pieceEnergy(s: SphereStateView, i: number, weights?: Float64Array): number {
    if (!this.begin(s) || !s.x.every(Number.isFinite)) return Infinity;
    this.placeAll(s);
    let e = 0;
    for (let j = 0; j < this.P; j++) {
      if (j === i) continue;
      const m = this.pair(i, j);
      if (m > 0) e += (weights ? (weights[i] + weights[j]) / 2 : 1) * m * m;
    }
    const wall = this.rhoCap - this.rho;
    if (wall > 0) e += (weights ? weights[i] : 1) * wall * wall;
    return e;
  }

  /**
   * True when every pair of the poses q0 (the true shapes, unit anchors with x = 0) is separated at
   * rho: by an edge great circle (the term's own test), or else by the validator's max-margin plane
   * (validate.ts), and the far pairs by their circumscribed caps as in the validator. So it agrees
   * with the validator except within float rounding at the contacts. The kernel's finish bisects
   * with it and then asks the validator itself.
   */
  separatedAt(q0: Float64Array, rho: number): boolean {
    const view: SphereStateView = { x: new Float64Array(3 * this.P), size: rho, aux: { q0, t: 1 } };
    if (!this.begin(view)) return false;
    this.placeAll(view);
    // pairs whose centres are closer than pi - 2R lie in a common open hemisphere (about the
    // midpoint of their centres), where the edge test is exact; only the others need the validator's plane
    const cosCommon = Math.cos(Math.max(0, Math.PI - 2 * this.R - 1e-6));
    const C = this.C;
    for (let i = 0; i < this.P; i++)
      for (let j = i + 1; j < this.P; j++) {
        if (!(this.pair(i, j) > 0)) continue;
        if (this.N === 0) return false;
        const dot = C[3 * i] * C[3 * j] + C[3 * i + 1] * C[3 * j + 1] + C[3 * i + 2] * C[3 * j + 2];
        if (dot > cosCommon || !(maxMarginPlane(this.vertices(i), this.vertices(j)).value >= 0)) return false;
      }
    return true;
  }

  private vertices(i: number): Vec3[] {
    const o = 3 * this.N * i;
    const V = this.V;
    return Array.from({ length: this.N }, (_, k) => [V[o + 3 * k], V[o + 3 * k + 1], V[o + 3 * k + 2]] as Vec3);
  }

  /** True when no term of piece i exceeds tol (a length). */
  clear(s: SphereStateView, i: number, tol: number): boolean {
    if (!this.begin(s) || !s.x.every(Number.isFinite)) return false;
    if (this.rhoCap - this.rho > tol) return false;
    this.placeAll(s);
    for (let j = 0; j < this.P; j++) if (j !== i && this.pair(i, j) > tol) return false;
    return true;
  }
}

/** exp(w) q0[o .. o + 3], not normalized (matrixInto divides by the norm). */
function quatMulExp(wx: number, wy: number, wz: number, q0: Float64Array, o: number): Quat {
  const t = Math.hypot(wx, wy, wz);
  const w0 = q0[o];
  const x0 = q0[o + 1];
  const y0 = q0[o + 2];
  const z0 = q0[o + 3];
  if (t < 1e-300) return [w0, x0, y0, z0];
  const c = Math.cos(t / 2);
  const k = Math.sin(t / 2) / t;
  const a = wx * k;
  const b = wy * k;
  const d = wz * k;
  return [
    c * w0 - a * x0 - b * y0 - d * z0,
    c * x0 + a * w0 + b * z0 - d * y0,
    c * y0 - a * z0 + b * w0 + d * x0,
    c * z0 + a * y0 - b * x0 + d * w0,
  ];
}

/** Rotation matrix of q / |q| (row-major) into m[o .. o + 8]. */
function matrixInto(q: Quat, m: Float64Array, o: number): void {
  const [w, x, y, z] = q;
  const n = w * w + x * x + y * y + z * z;
  m[o] = (w * w + x * x - y * y - z * z) / n;
  m[o + 1] = (2 * (x * y - w * z)) / n;
  m[o + 2] = (2 * (x * z + w * y)) / n;
  m[o + 3] = (2 * (x * y + w * z)) / n;
  m[o + 4] = (w * w - x * x + y * y - z * z) / n;
  m[o + 5] = (2 * (y * z - w * x)) / n;
  m[o + 6] = (2 * (x * z - w * y)) / n;
  m[o + 7] = (2 * (y * z + w * x)) / n;
  m[o + 8] = (w * w - x * x - y * y + z * z) / n;
}

/** out[oo + 3k ..] = M std[3k ..] for k < count. */
function rotateAll(M: Float64Array, o: number, std: Float64Array, out: Float64Array, oo: number, count: number): void {
  for (let k = 0; k < count; k++) {
    const x = std[3 * k];
    const y = std[3 * k + 1];
    const z = std[3 * k + 2];
    out[oo + 3 * k] = M[o] * x + M[o + 1] * y + M[o + 2] * z;
    out[oo + 3 * k + 1] = M[o + 3] * x + M[o + 4] * y + M[o + 5] * z;
    out[oo + 3 * k + 2] = M[o + 6] * x + M[o + 7] * y + M[o + 8] * z;
  }
}

function rotate1(M: Float64Array, o: number, std: Float64Array, so: number): [number, number, number] {
  const x = std[so];
  const y = std[so + 1];
  const z = std[so + 2];
  return [
    M[o] * x + M[o + 1] * y + M[o + 2] * z,
    M[o + 3] * x + M[o + 4] * y + M[o + 5] * z,
    M[o + 6] * x + M[o + 7] * y + M[o + 8] * z,
  ];
}

/** A unit vector at right angles to C[o .. o + 2] (for coincident centres, whose axis is undefined). */
function anyNormal(C: Float64Array, o: number, out: Float64Array): void {
  const x = C[o];
  const y = C[o + 1];
  const z = C[o + 2];
  // cross with the coordinate axis least aligned with c
  const ax = Math.abs(x) <= Math.abs(y) && Math.abs(x) <= Math.abs(z) ? 0 : Math.abs(y) <= Math.abs(z) ? 1 : 2;
  const e = [0, 0, 0];
  e[ax] = 1;
  const u = [y * e[2] - z * e[1], z * e[0] - x * e[2], x * e[1] - y * e[0]];
  const n = Math.hypot(u[0], u[1], u[2]);
  out.set([u[0] / n, u[1] / n, u[2] / n]);
}

/**
 * out = J(w)^T g[o .. o + 2], J the left Jacobian of SO(3):
 * J = I + (1 - cos f) / f^2 W + (f - sin f) / f^3 W^2, W = [w]x, f = |w|;
 * J^T g = g - c1 (w x g) + c2 (w x (w x g)).
 */
function jacobianTransposeTimes(
  wx: number,
  wy: number,
  wz: number,
  g: Float64Array,
  o: number,
  out: Float64Array,
): void {
  const f2 = wx * wx + wy * wy + wz * wz;
  let c1: number;
  let c2: number;
  if (f2 < 1e-8) {
    c1 = 0.5 - f2 / 24;
    c2 = 1 / 6 - f2 / 120;
  } else {
    const f = Math.sqrt(f2);
    c1 = (1 - Math.cos(f)) / f2;
    c2 = (f - Math.sin(f)) / (f2 * f);
  }
  const gx = g[o];
  const gy = g[o + 1];
  const gz = g[o + 2];
  const ax = wy * gz - wz * gy;
  const ay = wz * gx - wx * gz;
  const az = wx * gy - wy * gx;
  const bx = wy * az - wz * ay;
  const by = wz * ax - wx * az;
  const bz = wx * ay - wy * ax;
  out[0] = gx - c1 * ax + c2 * bx;
  out[1] = gy - c1 * ay + c2 * by;
  out[2] = gz - c1 * az + c2 * bz;
}
