/**
 * Ported from upstream's src/geom.js (alejandrozu/platonic-packing, commit cbf76f2f; MIT, Copyright (c) 2026
 * Yohei Nakajima and Copyright (c) 2026 Alejandro Zarzuelo; see THIRD_PARTY_NOTICES.md). Upstream's header:
 *
 *   Convex-polytope geometry for the soft-to-rigid packer: signed distance between two rounded polytopes' cores
 *   (exact penetration depth by the separating-axis theorem when they overlap, exact Euclidean distance by
 *   feature enumeration when they are apart) with analytic gradients w.r.t. both centres and both world-frame
 *   rotation vectors.
 *
 *   Conventions. A piece is (c, R, k): its core is c + k R P, where P is the solid (scaled so its inradius is 1/2)
 *   and k = 1 - 2r is the core scale of the rounded shape kP (+) B(r). R is row-major 3x3, world = R * local.
 *
 * Changes in the port: TypeScript types; the solids come from ../solids (exact coordinates rounded to binary64)
 * instead of src/solids.json; the precomputed r-rounding cores of non-tangential solids (coreShape, prepCores) are
 * left out, because this port softens every solid as Nakajima's (1 - 2r) P (+) B(r) (see sim.ts); the Gauss-map
 * pruned edge axes are computed on the fly as in upstream's edgeAxes.
 */
import type { Solid } from "../solids";

export type Vec3 = [number, number, number];

export interface Shape {
  name: string;
  /** Internal units per unit of the canonical solid (inradius becomes 1/2). */
  scale: number;
  V: Vec3[];
  nv: number;
  faces: number[][];
  N: Vec3[];
  beta: number[];
  /** Face normals, one per direction up to sign. */
  faxes: Vec3[];
  /** Edge directions, one per direction up to sign. */
  edirs: Vec3[];
  /** Per face: its edges as (p, m), m the inward in-plane unit normal. */
  fedges: { p: Vec3; m: Vec3 }[][];
  edges: [number, number][];
  circ: number;
  emax: number;
  eface: [number, number][];
  prune: boolean;
  inradius: number;
  edge: number;
  volume: number;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vx = (X: Float64Array, i: number): Vec3 => [X[3 * i], X[3 * i + 1], X[3 * i + 2]];
export { dot, cross, sub };

/** Gauss-map pruning pays off when the full scan is more expensive than one arc test per pair of edges. */
function pruneFlag(nd: number, nv: number, ne: number): boolean {
  return nd * nd * nv * 6 > 2 * ne * ne * 20;
}

/** The solid in internal units: multiplied by `scale` (default: inradius 1/2). */
export function prepShape(S: Solid, scale?: number): Shape {
  const sc = scale ?? 0.5 / S.inradius;
  const V: Vec3[] = [];
  for (let i = 0; i < S.nv; i++) V.push([S.V[3 * i] * sc, S.V[3 * i + 1] * sc, S.V[3 * i + 2] * sc]);
  const N: Vec3[] = S.faces.map((_, f) => [S.N[3 * f], S.N[3 * f + 1], S.N[3 * f + 2]]);
  const beta = S.faces.map((f, i) => dot(N[i], V[f[0]]));
  const uniq = (list: Vec3[]) => {
    const out: Vec3[] = [];
    for (const u of list) if (!out.some((w) => Math.abs(dot(u, w)) > 1 - 1e-9)) out.push(u);
    return out;
  };
  const faxes = uniq(N);
  const edirs = uniq(
    S.edges.map(([i, j]) => {
      const d = sub(V[j], V[i]);
      const l = Math.hypot(...d);
      return [d[0] / l, d[1] / l, d[2] / l] as Vec3;
    }),
  );
  const fedges = S.faces.map((f, fi) =>
    f.map((a, t) => {
      const b = f[(t + 1) % f.length];
      const n = N[fi];
      const p = V[a];
      const e = sub(V[b], p);
      const m = cross(n, e);
      const l = Math.hypot(...m);
      return { p, m: [m[0] / l, m[1] / l, m[2] / l] as Vec3 };
    }),
  );
  const circ = Math.max(...V.map((v) => Math.hypot(...v)));
  const emax = Math.max(...S.edges.map(([i, j]) => Math.hypot(...sub(V[j], V[i]))));
  return {
    name: S.name,
    scale: sc,
    V,
    nv: V.length,
    faces: S.faces,
    N,
    beta,
    faxes,
    edirs,
    fedges,
    edges: S.edges,
    circ,
    emax,
    eface: S.edgeFaces,
    prune: pruneFlag(edirs.length, V.length, S.edges.length),
    inradius: S.inradius * sc,
    edge: sc,
    volume: S.volume * sc ** 3,
  };
}

// ---------------------------------------------------------------- rotations
export function quatToR(q: ArrayLike<number>): number[] {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

/** q <- exp(omega) q (world-frame rotation vector), normalised. */
export function rotq(q: number[], wx: number, wy: number, wz: number): number[] {
  const th = Math.hypot(wx, wy, wz);
  if (th < 1e-16) return q;
  const h = th / 2;
  const sh = Math.sin(h) / th;
  const dw = Math.cos(h);
  const dx = wx * sh;
  const dy = wy * sh;
  const dz = wz * sh;
  const [w, x, y, z] = q;
  const r = [
    dw * w - dx * x - dy * y - dz * z,
    dw * x + dx * w + dy * z - dz * y,
    dw * y - dx * z + dy * w + dz * x,
    dw * z + dx * y - dy * x + dz * w,
  ];
  const m = Math.hypot(r[0], r[1], r[2], r[3]);
  return [r[0] / m, r[1] / m, r[2] / m, r[3] / m];
}

export interface SimPose {
  shape: Shape;
  c: number[];
  R: number[];
  k: number;
  X: Float64Array;
  FA: Vec3[];
  ED: Vec3[];
  FN?: Vec3[];
  _E?: { a: Vec3; b: Vec3; c: Vec3; d: Vec3 | null }[];
}

/** World data of one piece: centre, rotation, core scale, world vertices, face axes and edge directions. */
export function pose(shape: Shape, c: number[], q: number[], k: number): SimPose {
  const R = quatToR(q);
  const X = new Float64Array(3 * shape.nv);
  for (let i = 0; i < shape.nv; i++) {
    const v = shape.V[i];
    X[3 * i] = c[0] + k * (R[0] * v[0] + R[1] * v[1] + R[2] * v[2]);
    X[3 * i + 1] = c[1] + k * (R[3] * v[0] + R[4] * v[1] + R[5] * v[2]);
    X[3 * i + 2] = c[2] + k * (R[6] * v[0] + R[7] * v[1] + R[8] * v[2]);
  }
  const rot = (u: Vec3): Vec3 => [
    R[0] * u[0] + R[1] * u[1] + R[2] * u[2],
    R[3] * u[0] + R[4] * u[1] + R[5] * u[2],
    R[6] * u[0] + R[7] * u[1] + R[8] * u[2],
  ];
  const out: SimPose = { shape, c, R, k, X, FA: shape.faxes.map(rot), ED: shape.edirs.map(rot) };
  if (shape.prune) out.FN = shape.N.map(rot);
  return out;
}

// projection of a vertex array on u: sets PR = [min, max, argmin, argmax]
const PR = [0, 0, 0, 0];
function proj(X: Float64Array, n: number, u0: number, u1: number, u2: number): void {
  let mn = Infinity;
  let mx = -Infinity;
  let imn = 0;
  let imx = 0;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const p = X[j] * u0 + X[j + 1] * u1 + X[j + 2] * u2;
    if (p < mn) {
      mn = p;
      imn = i;
    }
    if (p > mx) {
      mx = p;
      imx = i;
    }
  }
  PR[0] = mn;
  PR[1] = mx;
  PR[2] = imn;
  PR[3] = imx;
}

// closest points between segments X1[a]-X1[b] and X2[c]-X2[e] (Ericson, Real-Time Collision Detection 5.1.9);
// writes the two points into out[0..5] and returns their squared distance
const SEG = new Float64Array(6);
function segDist2(X1: Float64Array, a: number, b: number, X2: Float64Array, c: number, e: number, out: Float64Array): number {
  const p1x = X1[a];
  const p1y = X1[a + 1];
  const p1z = X1[a + 2];
  const p2x = X2[c];
  const p2y = X2[c + 1];
  const p2z = X2[c + 2];
  const d1x = X1[b] - p1x;
  const d1y = X1[b + 1] - p1y;
  const d1z = X1[b + 2] - p1z;
  const d2x = X2[e] - p2x;
  const d2y = X2[e + 1] - p2y;
  const d2z = X2[e + 2] - p2z;
  const rx = p1x - p2x;
  const ry = p1y - p2y;
  const rz = p1z - p2z;
  const A = d1x * d1x + d1y * d1y + d1z * d1z;
  const E = d2x * d2x + d2y * d2y + d2z * d2z;
  const F = d2x * rx + d2y * ry + d2z * rz;
  const C = d1x * rx + d1y * ry + d1z * rz;
  const Bq = d1x * d2x + d1y * d2y + d1z * d2z;
  const den = A * E - Bq * Bq;
  let s = den > 1e-14 * A * E ? Math.min(1, Math.max(0, (Bq * F - C * E) / den)) : 0;
  let t = (Bq * s + F) / E;
  if (t < 0) {
    t = 0;
    s = Math.min(1, Math.max(0, -C / A));
  } else if (t > 1) {
    t = 1;
    s = Math.min(1, Math.max(0, (Bq - C) / A));
  }
  out[0] = p1x + d1x * s;
  out[1] = p1y + d1y * s;
  out[2] = p1z + d1z * s;
  out[3] = p2x + d2x * t;
  out[4] = p2y + d2y * t;
  out[5] = p2z + d2z * t;
  const qx = out[0] - out[3];
  const qy = out[1] - out[4];
  const qz = out[2] - out[5];
  return qx * qx + qy * qy + qz * qz;
}

/** d sd / d [cA(3), wA(3), cB(3), wB(3)] of the last sdCores call with needGrad. */
export const GR = new Float64Array(12);
let lastAxis: Vec3 | null = null;
/** The best known separating direction A -> B of the last sdCores call, or null when the cores overlap. */
export function sdLastAxis(): Vec3 | null {
  return lastAxis;
}

/**
 * Signed distance between the cores of A and B: < 0 the penetration depth by the separating-axis test, > 0 the
 * Euclidean distance. Fills GR. If an axis already separates by >= cutoff, returns that lower bound (no gradient).
 * `hint`, a unit vector from A towards B that separated the pair recently, is tried first.
 */
export function sdCores(A: SimPose, B: SimPose, cutoff = Infinity, needGrad = true, hint?: Vec3 | null): number {
  const SA = A.shape;
  const SB = B.shape;
  const k = A.k;
  lastAxis = null;
  if (k <= 1e-12) {
    // cores are points
    const D = sub(A.c, B.c);
    const d = Math.hypot(...D) || 1e-300;
    GR.fill(0);
    for (let t = 0; t < 3; t++) {
      GR[t] = D[t] / d;
      GR[6 + t] = -D[t] / d;
    }
    return d;
  }
  if (hint) {
    proj(A.X, SA.nv, hint[0], hint[1], hint[2]);
    const aMax = PR[1];
    proj(B.X, SB.nv, hint[0], hint[1], hint[2]);
    const bMin = PR[0];
    const gap = bMin - aMax;
    if (gap > 0) {
      if (gap >= cutoff) {
        lastAxis = hint;
        return gap;
      }
      const r = distSeparated(A, B, hint, gap, needGrad);
      lastAxis = [(r.PB[0] - r.PA[0]) / r.d, (r.PB[1] - r.PA[1]) / r.d, (r.PB[2] - r.PA[2]) / r.d];
      return r.d;
    }
  }
  let minO = Infinity;
  type Best = { u: Vec3; sg: number; ia: number; ib: number; kind: string; i: Vec3 | null; j: Vec3 | null; l: number };
  let best = null as Best | null;
  let sepGap = -Infinity;
  let sepU: Vec3 | null = null;
  const test = (u: Vec3, kind: string, ea: Vec3 | null, eb: Vec3 | null, l: number): boolean => {
    proj(A.X, SA.nv, u[0], u[1], u[2]);
    const aMin = PR[0];
    const aMax = PR[1];
    const aiMin = PR[2];
    const aiMax = PR[3];
    proj(B.X, SB.nv, u[0], u[1], u[2]);
    const bMin = PR[0];
    const bMax = PR[1];
    const biMin = PR[2];
    const biMax = PR[3];
    const o1 = aMax - bMin; // A below B along u
    const o2 = bMax - aMin; // A above B
    if (o1 <= 0 || o2 <= 0) {
      const gap = o1 <= 0 ? -o1 : -o2;
      if (gap > sepGap) {
        sepGap = gap;
        sepU = o1 <= 0 ? u : [-u[0], -u[1], -u[2]];
      }
      return true;
    }
    const o = Math.min(o1, o2);
    if (o < minO) {
      minO = o;
      best =
        o1 <= o2
          ? { u, sg: 1, ia: aiMax, ib: biMin, kind, i: ea, j: eb, l }
          : { u: [-u[0], -u[1], -u[2]], sg: -1, ia: aiMin, ib: biMax, kind, i: ea, j: eb, l };
    }
    return false;
  };
  let sep = false;
  for (let i = 0; i < A.FA.length; i++) if (test(A.FA[i], "A", null, null, 1)) sep = true;
  for (let i = 0; i < B.FA.length; i++) if (test(B.FA[i], "B", null, null, 1)) sep = true;
  if (!sep) {
    if (SA.prune || SB.prune) {
      edgeAxes(A, B, (ea, eb) => {
        const w = cross(ea, eb);
        const l = Math.hypot(w[0], w[1], w[2]);
        if (l < 1e-9) return false;
        if (test([w[0] / l, w[1] / l, w[2] / l], "X", ea, eb, l)) {
          sep = true;
          return true;
        }
        return false;
      });
    } else {
      for (let i = 0; i < A.ED.length && !sep; i++)
        for (let j = 0; j < B.ED.length; j++) {
          const w = cross(A.ED[i], B.ED[j]);
          const l = Math.hypot(w[0], w[1], w[2]);
          if (l < 1e-9) continue;
          if (test([w[0] / l, w[1] / l, w[2] / l], "X", A.ED[i], B.ED[j], l)) {
            sep = true;
            break;
          }
        }
    }
  }
  if (sep) {
    const su = sepU as unknown as Vec3;
    if (sepGap >= cutoff) {
      lastAxis = su;
      return sepGap;
    }
    const r = distSeparated(A, B, su, sepGap, needGrad);
    lastAxis = [(r.PB[0] - r.PA[0]) / r.d, (r.PB[1] - r.PA[1]) / r.d, (r.PB[2] - r.PA[2]) / r.d];
    return r.d;
  }
  if (!needGrad) return -minO;
  // penetration o = h_A(u) + h_B(-u) along the oriented best axis u; sd = -o
  const bb = best as unknown as Best;
  const u = bb.u;
  const pa = vx(A.X, bb.ia);
  const pb = vx(B.X, bb.ib);
  const g = sub(pa, pb);
  let dA = cross(sub(pa, A.c), u);
  let dB = cross(sub(pb, B.c), u);
  dB = [-dB[0], -dB[1], -dB[2]];
  if (bb.kind === "A") {
    const t = cross(u, g);
    dA = [dA[0] + t[0], dA[1] + t[1], dA[2] + t[2]];
  } else if (bb.kind === "B") {
    const t = cross(u, g);
    dB = [dB[0] + t[0], dB[1] + t[1], dB[2] + t[2]];
  } else {
    const a = bb.i as Vec3;
    const b = bb.j as Vec3;
    const ug = dot(u, g);
    const h: Vec3 = [
      (bb.sg * (g[0] - u[0] * ug)) / bb.l,
      (bb.sg * (g[1] - u[1] * ug)) / bb.l,
      (bb.sg * (g[2] - u[2] * ug)) / bb.l,
    ];
    const tA = cross(a, cross(b, h));
    const tB = cross(b, cross(h, a));
    dA = [dA[0] + tA[0], dA[1] + tA[1], dA[2] + tA[2]];
    dB = [dB[0] + tB[0], dB[1] + tB[1], dB[2] + tB[2]];
  }
  for (let t = 0; t < 3; t++) {
    GR[t] = -u[t];
    GR[3 + t] = -dA[t];
    GR[6 + t] = u[t];
    GR[9 + t] = -dB[t];
  }
  return -minO;
}

/**
 * Edge-edge separating-axis candidates with Gauss-map pruning (D. Gregorius, GDC 2013); fn(ea, eb) gets unit
 * world edge directions and returns true to stop.
 */
export function edgeAxes(A: SimPose, B: SimPose, fn: (ea: Vec3, eb: Vec3) => boolean): void {
  const SA = A.shape;
  const SB = B.shape;
  const rotR = (R: number[], u: Vec3): Vec3 => [
    R[0] * u[0] + R[1] * u[1] + R[2] * u[2],
    R[3] * u[0] + R[4] * u[1] + R[5] * u[2],
    R[6] * u[0] + R[7] * u[1] + R[8] * u[2],
  ];
  const FNA = A.FN || SA.N.map((u) => rotR(A.R, u));
  const FNB = B.FN || SB.N.map((u) => rotR(B.R, u));
  const prepE = (FNs: Vec3[], ef: [number, number][]) =>
    ef.map(([f1, f2]) => {
      const a = FNs[f1];
      const b = FNs[f2];
      const c = cross(b, a);
      const l = Math.hypot(c[0], c[1], c[2]);
      return { a, b, c, d: l > 1e-12 ? ([-c[0] / l, -c[1] / l, -c[2] / l] as Vec3) : null };
    });
  const EA = A._E || (A._E = prepE(FNA, SA.eface));
  const EB = B._E || (B._E = prepE(FNB, SB.eface));
  for (let i = 0; i < EA.length; i++) {
    const p = EA[i];
    if (!p.d) continue;
    for (let j = 0; j < EB.length; j++) {
      const q = EB[j];
      if (!q.d) continue;
      const CBA = -(q.a[0] * p.c[0] + q.a[1] * p.c[1] + q.a[2] * p.c[2]);
      const DBA = -(q.b[0] * p.c[0] + q.b[1] * p.c[1] + q.b[2] * p.c[2]);
      if (CBA * DBA >= 0) continue;
      const ADC = p.a[0] * q.c[0] + p.a[1] * q.c[1] + p.a[2] * q.c[2];
      const BDC = p.b[0] * q.c[0] + p.b[1] * q.c[1] + p.b[2] * q.c[2];
      if (ADC * BDC >= 0 || CBA * BDC <= 0) continue;
      if (fn(p.d, q.d)) return;
    }
  }
}

/**
 * Exact distance between disjoint cores. u: unit axis with max_A u.x + gap <= min_B u.x (gap > 0). The closest
 * pair lies in the slabs u.x >= h_A - delta (on A) and u.x <= m_B + delta (on B), delta = D - gap, where D is any
 * upper bound on the distance; every candidate feature pair touching the slabs is enumerated: vertex of A / face
 * of B, face of A / vertex of B, edge of A / edge of B.
 */
function distSeparated(A: SimPose, B: SimPose, u: Vec3, _gap: number, needGrad: boolean): { d: number; PA: Vec3; PB: Vec3 } {
  const SA = A.shape;
  const SB = B.shape;
  const k = A.k;
  const pa_ = new Float64Array(SA.nv);
  const pb_ = new Float64Array(SB.nv);
  let hA = -Infinity;
  let mB = Infinity;
  let ia = 0;
  let ib = 0;
  for (let i = 0; i < SA.nv; i++) {
    const p = A.X[3 * i] * u[0] + A.X[3 * i + 1] * u[1] + A.X[3 * i + 2] * u[2];
    pa_[i] = p;
    if (p > hA) {
      hA = p;
      ia = i;
    }
  }
  for (let i = 0; i < SB.nv; i++) {
    const p = B.X[3 * i] * u[0] + B.X[3 * i + 1] * u[1] + B.X[3 * i + 2] * u[2];
    pb_[i] = p;
    if (p < mB) {
      mB = p;
      ib = i;
    }
  }
  let PA = vx(A.X, ia);
  let PB = vx(B.X, ib);
  let d2 = (PA[0] - PB[0]) ** 2 + (PA[1] - PB[1]) ** 2 + (PA[2] - PB[2]) ** 2;
  const delta = Math.sqrt(d2) - (mB - hA) + 1e-12 * (1 + Math.sqrt(d2));
  const thA = hA - delta;
  const thB = mB + delta;
  const consider = (p: Vec3, q: Vec3) => {
    const dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
    if (dd < d2) {
      d2 = dd;
      PA = p;
      PB = q;
    }
  };
  // vertex of X (world point x) against faces of polytope Y lying in Y's slab; closest point on Y or null
  const vertFace = (x: Vec3, Y: SimPose, faceOK: boolean[]): Vec3 | null => {
    const SY = Y.shape;
    const R = Y.R;
    const kk = Y.k;
    const dx = x[0] - Y.c[0];
    const dy = x[1] - Y.c[1];
    const dz = x[2] - Y.c[2];
    const y: Vec3 = [
      (R[0] * dx + R[3] * dy + R[6] * dz) / kk,
      (R[1] * dx + R[4] * dy + R[7] * dz) / kk,
      (R[2] * dx + R[5] * dy + R[8] * dz) / kk,
    ];
    let bestq: Vec3 | null = null;
    let bestt = Infinity;
    for (let f = 0; f < SY.faces.length; f++) {
      if (!faceOK[f]) continue;
      const n = SY.N[f];
      const t = dot(n, y) - SY.beta[f];
      if (t <= 0 || t >= bestt) continue;
      let inside = true;
      for (const e of SY.fedges[f])
        if ((y[0] - e.p[0]) * e.m[0] + (y[1] - e.p[1]) * e.m[1] + (y[2] - e.p[2]) * e.m[2] < 0) {
          inside = false;
          break;
        }
      if (!inside) continue;
      bestt = t;
      const nw = [
        R[0] * n[0] + R[1] * n[1] + R[2] * n[2],
        R[3] * n[0] + R[4] * n[1] + R[5] * n[2],
        R[6] * n[0] + R[7] * n[1] + R[8] * n[2],
      ];
      bestq = [x[0] - kk * t * nw[0], x[1] - kk * t * nw[1], x[2] - kk * t * nw[2]];
    }
    return bestq;
  };
  const fA = SA.faces.map((f) => f.some((i) => pa_[i] >= thA));
  const fB = SB.faces.map((f) => f.some((i) => pb_[i] <= thB));
  for (let i = 0; i < SA.nv; i++)
    if (pa_[i] >= thA) {
      const x = vx(A.X, i);
      const q = vertFace(x, B, fB);
      if (q) consider(x, q);
    }
  for (let i = 0; i < SB.nv; i++)
    if (pb_[i] <= thB) {
      const x = vx(B.X, i);
      const q = vertFace(x, A, fA);
      if (q) consider(q, x);
    }
  // the vertex-face candidates gave a better upper bound D; the slab argument holds for any D >= d, so re-slab
  const delta2 = Math.sqrt(d2) - (mB - hA) + 1e-12 * (1 + Math.sqrt(d2));
  const thA2 = hA - delta2;
  const thB2 = mB + delta2;
  const eA = SA.edges.filter(([i, j]) => pa_[i] >= thA2 || pa_[j] >= thA2);
  const eB = SB.edges.filter(([i, j]) => pb_[i] <= thB2 || pb_[j] <= thB2);
  const XA = A.X;
  const XB = B.X;
  const halfSum = 0.5 * k * (SA.emax + SB.emax) * (1 + 1e-12);
  for (const [i1, j1] of eA) {
    const a = 3 * i1;
    const b = 3 * j1;
    const mx1 = 0.5 * (XA[a] + XA[b]);
    const my1 = 0.5 * (XA[a + 1] + XA[b + 1]);
    const mz1 = 0.5 * (XA[a + 2] + XA[b + 2]);
    for (const [i2, j2] of eB) {
      const c = 3 * i2;
      const e = 3 * j2;
      // segment distance >= |m1 - m2| - (l1 + l2)/2: skip pairs that cannot be strictly closer than the best so far
      const ex = mx1 - 0.5 * (XB[c] + XB[e]);
      const ey = my1 - 0.5 * (XB[c + 1] + XB[e + 1]);
      const ez = mz1 - 0.5 * (XB[c + 2] + XB[e + 2]);
      const lb = Math.sqrt(d2) + halfSum;
      if (ex * ex + ey * ey + ez * ez >= lb * lb) continue;
      const dd = segDist2(XA, a, b, XB, c, e, SEG);
      if (dd < d2) {
        d2 = dd;
        PA = [SEG[0], SEG[1], SEG[2]];
        PB = [SEG[3], SEG[4], SEG[5]];
      }
    }
  }
  const d = Math.sqrt(d2) || 1e-300;
  if (needGrad) {
    const n: Vec3 = [(PA[0] - PB[0]) / d, (PA[1] - PB[1]) / d, (PA[2] - PB[2]) / d];
    const tA = cross(sub(PA, A.c), n);
    const tB = cross(sub(PB, B.c), n);
    for (let t = 0; t < 3; t++) {
      GR[t] = n[t];
      GR[3 + t] = tA[t];
      GR[6 + t] = -n[t];
      GR[9 + t] = -tB[t];
    }
  }
  return { d, PA, PB };
}

/** Boolean SAT overlap test (true if the interiors overlap by more than tol along every axis). */
export function overlaps(A: SimPose, B: SimPose, tol: number): boolean {
  const SA = A.shape;
  const SB = B.shape;
  const chk = (u: Vec3) => {
    proj(A.X, SA.nv, u[0], u[1], u[2]);
    const aMin = PR[0];
    const aMax = PR[1];
    proj(B.X, SB.nv, u[0], u[1], u[2]);
    return Math.min(aMax - PR[0], PR[1] - aMin) > tol;
  };
  for (const u of A.FA) if (!chk(u)) return false;
  for (const u of B.FA) if (!chk(u)) return false;
  if (SA.prune || SB.prune) {
    let res = true;
    edgeAxes(A, B, (a, b) => {
      const w = cross(a, b);
      const l = Math.hypot(...w);
      if (l < 1e-9) return false;
      if (!chk([w[0] / l, w[1] / l, w[2] / l])) {
        res = false;
        return true;
      }
      return false;
    });
    return res;
  }
  for (const a of A.ED)
    for (const b of B.ED) {
      const w = cross(a, b);
      const l = Math.hypot(...w);
      if (l < 1e-9) continue;
      if (!chk([w[0] / l, w[1] / l, w[2] / l])) return false;
    }
  return true;
}
