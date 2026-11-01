/**
 * Small dense linear algebra for d <= 10, on row-major Float64Arrays.
 */

/** Solves A X = B for square A (n x n) and B (n x m) by Gaussian elimination with partial pivoting; null when singular. */
export function solve(A: Float64Array, B: Float64Array, n: number, m: number): Float64Array | null {
  const w = n + m;
  const M = new Float64Array(n * w);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * w + j] = A[i * n + j];
    for (let j = 0; j < m; j++) M[i * w + n + j] = B[i * m + j];
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    let best = Math.abs(M[c * w + c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(M[r * w + c]);
      if (v > best) {
        best = v;
        p = r;
      }
    }
    if (!(best > 1e-300)) return null;
    if (p !== c) for (let j = 0; j < w; j++) [M[c * w + j], M[p * w + j]] = [M[p * w + j], M[c * w + j]];
    const piv = M[c * w + c];
    for (let j = c; j < w; j++) M[c * w + j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r * w + c];
      if (f === 0) continue;
      for (let j = c; j < w; j++) M[r * w + j] -= f * M[c * w + j];
    }
  }
  const X = new Float64Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) X[i * m + j] = M[i * w + n + j];
  return X;
}

/** Determinant of the n x n matrix A. */
export function det(A: Float64Array, n: number): number {
  const M = Float64Array.from(A);
  let out = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (M[p * n + c] === 0) return 0;
    if (p !== c) {
      for (let j = 0; j < n; j++) [M[c * n + j], M[p * n + j]] = [M[p * n + j], M[c * n + j]];
      out = -out;
    }
    out *= M[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      for (let j = c; j < n; j++) M[r * n + j] -= f * M[c * n + j];
    }
  }
  return out;
}

/** A^T. */
export function transpose(A: Float64Array, n: number): Float64Array {
  const T = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) T[j * n + i] = A[i * n + j];
  return T;
}

/** A B for n x n matrices. */
export function matmul(A: Float64Array, B: Float64Array, n: number): Float64Array {
  const C = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      const a = A[i * n + k];
      if (a === 0) continue;
      for (let j = 0; j < n; j++) C[i * n + j] += a * B[k * n + j];
    }
  return C;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>, d: number, ao = 0, bo = 0): number {
  let s = 0;
  for (let i = 0; i < d; i++) s += a[ao + i] * b[bo + i];
  return s;
}
