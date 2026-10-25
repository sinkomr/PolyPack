/**
 * Small dense linear algebra for the boundary engine: d-vectors, 3-vectors and rigid motions of
 * R^3 (the cells' local coordinates). Plain arrays, no dependencies.
 */
import type { Affine } from "./types";

export type V3 = [number, number, number];

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

export function sub(a: readonly number[], b: readonly number[]): number[] {
  return a.map((x, i) => x - b[i]);
}

export function scale(a: readonly number[], k: number): number[] {
  return a.map((x) => x * k);
}

export function unit(a: readonly number[]): number[] {
  const n = norm(a);
  return a.map((x) => x / n);
}

/**
 * Gram–Schmidt: an orthonormal basis of the span of `vs` (in order), skipping vectors whose
 * residual after the previous ones is shorter than `eps` times their length.
 */
export function orthonormalBasis(vs: readonly number[][], eps = 1e-9): number[][] {
  const out: number[][] = [];
  for (const v of vs) {
    let r = v.slice();
    // two passes for numerical orthogonality
    for (let pass = 0; pass < 2; pass++)
      for (const b of out) {
        const c = dot(r, b);
        r = r.map((x, i) => x - c * b[i]);
      }
    const n = norm(r);
    if (n > eps * Math.max(1, norm(v))) out.push(r.map((x) => x / n));
  }
  return out;
}

/** Component of v orthogonal to the orthonormal vectors `basis`. */
export function rejectFrom(v: readonly number[], basis: readonly number[][]): number[] {
  let r = v.slice();
  for (let pass = 0; pass < 2; pass++)
    for (const b of basis) {
      const c = dot(r, b);
      r = r.map((x, i) => x - c * b[i]);
    }
  return r;
}

// ---------------------------------------------------------------- 3-vectors

export const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm3 = (a: V3): number => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
export function unit3(a: V3): V3 {
  const n = norm3(a);
  return [a[0] / n, a[1] / n, a[2] / n];
}
export const toV3 = (a: readonly number[]): V3 => [a[0], a[1], a[2]];

/** Distance from p to the segment [a, b]. */
export function pointSegmentDistance3(p: V3, a: V3, b: V3): number {
  const e = sub3(b, a);
  const L2 = dot3(e, e);
  let t = L2 > 0 ? dot3(sub3(p, a), e) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return norm3(sub3(p, [a[0] + t * e[0], a[1] + t * e[1], a[2] + t * e[2]]));
}

// ---------------------------------------------------------------- rigid motions of R^3

/**
 * A rigid motion of R^3, possibly orientation-reversing: y = M x + t, with M orthogonal and
 * stored row-major in 9 numbers. Gluings between cells whose frames have opposite handedness
 * reverse orientation, so det M = -1 occurs.
 */
export interface Iso3 {
  m: number[];
  t: V3;
}

export const ISO_IDENTITY: Iso3 = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function isoApply(T: Iso3, p: readonly number[]): V3 {
  const m = T.m;
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + T.t[0],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + T.t[1],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + T.t[2],
  ];
}

/** The linear part only (for directions and normals). */
export function isoLinear(T: Iso3, v: readonly number[]): V3 {
  const m = T.m;
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Transposed linear part: the inverse for directions, since M is orthogonal. */
export function isoLinearT(T: Iso3, v: readonly number[]): V3 {
  const m = T.m;
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}

/** A after B: x -> A(B(x)). */
export function isoCompose(A: Iso3, B: Iso3): Iso3 {
  const a = A.m;
  const b = B.m;
  const m = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) m[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return { m, t: add3(isoLinear(A, B.t), A.t) };
}

/** Inverse of a rigid motion (M orthogonal): x = M^T (y - t). */
export function isoInverse(T: Iso3): Iso3 {
  const m = T.m;
  const mt = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  const t = isoLinearT(T, T.t);
  return { m: mt, t: [-t[0], -t[1], -t[2]] };
}

export function isoDet(T: Iso3): number {
  const m = T.m;
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

/** The contract's Affine (s = 1 translation b) at edge s, as an Iso3. */
export function isoFromAffine(a: Affine, s = 1): Iso3 {
  const A = a.A;
  return { m: [A[0][0], A[0][1], A[0][2], A[1][0], A[1][1], A[1][2], A[2][0], A[2][1], A[2][2]], t: [s * a.b[0], s * a.b[1], s * a.b[2]] };
}

export function isoToAffine(T: Iso3): Affine {
  const m = T.m;
  return {
    A: [
      [m[0], m[1], m[2]],
      [m[3], m[4], m[5]],
      [m[6], m[7], m[8]],
    ],
    b: [T.t[0], T.t[1], T.t[2]],
  };
}

/**
 * Rotation matrix of a unit quaternion (w, x, y, z), row-major: v -> q v q*. The quaternion is
 * normalised first, so a quaternion off unit length by rounding still gives an orthogonal matrix.
 */
export function quaternionToMatrix(q: readonly number[]): number[] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  const w = q[0] / n;
  const x = q[1] / n;
  const y = q[2] / n;
  const z = q[3] / n;
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
