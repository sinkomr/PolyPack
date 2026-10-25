/**
 * Small dense linear algebra for the views: affine maps in the contract's form (A row-major,
 * y = A x + b), 3-vectors as plain tuples. Nothing here touches three.js, so the tests run in Node.
 */
import type { Affine } from "@polypack/boundary";

export type Vec3 = [number, number, number];

export const dot = (a: readonly number[], b: readonly number[]): number => {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i] * b[i];
  return t;
};

export const sub3 = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: readonly number[], k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const cross3 = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: readonly number[]): number => Math.sqrt(dot(a, a));
export function normalize3(a: readonly number[]): Vec3 {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}

/** A x for a row-major matrix A (any shape). */
export function matVec(A: readonly (readonly number[])[], x: readonly number[]): number[] {
  return A.map((row) => dot(row, x));
}

/** A B for row-major matrices. */
export function matMul(A: readonly (readonly number[])[], B: readonly (readonly number[])[]): number[][] {
  const n = A.length;
  const m = B[0].length;
  const k = B.length;
  const C: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(m).fill(0);
    for (let j = 0; j < m; j++) {
      let t = 0;
      for (let l = 0; l < k; l++) t += A[i][l] * B[l][j];
      row[j] = t;
    }
    C.push(row);
  }
  return C;
}

export function transpose(A: readonly (readonly number[])[]): number[][] {
  return A[0].map((_, j) => A.map((row) => row[j]));
}

/** y = A x + k b: the contract scales the translations of nets and gluings by the edge s. */
export function applyAffine(f: Affine, x: readonly number[], k = 1): number[] {
  return f.A.map((row, i) => dot(row, x) + k * f.b[i]);
}

/** The map f then g, as one affine map (translations already at the same scale). */
export function composeAffine(g: Affine, f: Affine): Affine {
  return { A: matMul(g.A, f.A), b: applyAffine(g, f.b) };
}

/** Scales the translation of f by k (a map given at s = 1, used at edge k). */
export function scaleTranslation(f: Affine, k: number): Affine {
  return { A: f.A.map((r) => r.slice()), b: f.b.map((v) => v * k) };
}

/** The inverse of an isometry (orthogonal A). */
export function invertIsometry(f: Affine): Affine {
  const At = transpose(f.A);
  return { A: At, b: matVec(At, f.b).map((v) => -v) };
}

export function det3(A: readonly (readonly number[])[]): number {
  return (
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])
  );
}

/** Two unit vectors that complete n (unit) to a right-handed orthonormal basis (u, v, n). */
export function planeBasis(n: readonly number[]): [Vec3, Vec3] {
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize3(cross3(a, n));
  const v = cross3(n, u);
  return [u, v];
}

/**
 * Inverse of a 4x4 matrix stored row-major in m (16 numbers), written to out. Returns false when
 * it is singular. Used once per cell per fold step, into preallocated arrays.
 */
export function invert4(m: ArrayLike<number>, out: Float64Array | number[]): boolean {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return false;
  const id = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * id;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * id;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * id;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * id;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * id;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * id;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * id;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * id;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * id;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * id;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * id;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * id;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * id;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * id;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * id;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * id;
  return true;
}
