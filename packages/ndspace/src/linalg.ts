/** Small dense linear algebra for d <= 10 on row-major Float64Arrays (the kernel's own; the ndim package's is not exported). */

/** Inverse of an n x n matrix by Gauss-Jordan with partial pivoting; null when singular. */
export function inverse(A: Float64Array, n: number): Float64Array | null {
  const w = 2 * n;
  const M = new Float64Array(n * w);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * w + j] = A[i * n + j];
    M[i * w + n + i] = 1;
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * w + c]) > Math.abs(M[p * w + c])) p = r;
    if (!(Math.abs(M[p * w + c]) > 1e-300)) return null;
    if (p !== c) for (let j = 0; j < w; j++) [M[c * w + j], M[p * w + j]] = [M[p * w + j], M[c * w + j]];
    const piv = M[c * w + c];
    for (let j = 0; j < w; j++) M[c * w + j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r * w + c];
      if (f === 0) continue;
      for (let j = 0; j < w; j++) M[r * w + j] -= f * M[c * w + j];
    }
  }
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = M[i * w + n + j];
  return out;
}

export function mul(A: Float64Array, B: Float64Array, n: number, out = new Float64Array(n * n)): Float64Array {
  out.fill(0);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      const a = A[i * n + k];
      if (a === 0) continue;
      for (let j = 0; j < n; j++) out[i * n + j] += a * B[k * n + j];
    }
  return out;
}

/** Gram-Schmidt on the columns of M: the nearest-ish orthonormal matrix (keeps the rotation from drifting). */
export function orthonormalise(M: Float64Array, n: number): void {
  for (let c = 0; c < n; c++) {
    for (let p = 0; p < c; p++) {
      let f = 0;
      for (let i = 0; i < n; i++) f += M[i * n + c] * M[i * n + p];
      for (let i = 0; i < n; i++) M[i * n + c] -= f * M[i * n + p];
    }
    let l = 0;
    for (let i = 0; i < n; i++) l += M[i * n + c] ** 2;
    l = Math.sqrt(l);
    for (let i = 0; i < n; i++) M[i * n + c] /= l;
  }
}
