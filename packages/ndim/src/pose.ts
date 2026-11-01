/**
 * Poses in d dimensions (docs/spaces/NDIM.md §3).
 *
 * A polytope piece's pose is the flat array [t_1..t_d, k_1..k_m, flip] with m = d(d-1)/2: the centre t of the piece's
 * vertex centroid, the Cayley parameters k, and an optional flip (an integer; 0 when absent). The rotation is
 *
 *   R = D (I - S)^-1 (I + S),   S[i][j] = k (i < j, row-major order), S[j][i] = -k,   D = diag(-1 for each set bit of flip)
 *
 * and the world vertex of the canonical vertex v is t + R v. S is skew, so I - S is invertible, R is orthogonal with
 * determinant det D = +1 (the flip has an even number of set bits: reflections are refused), and every rotation without
 * eigenvalue -1 has one Cayley form with D = I; with a suitable flip every rotation of the group is representable.
 * The parameters are exactly the rational numbers they denote, and the exact certifier (python/ndim/certify.py) uses R
 * as an exact rational matrix; the floats here agree with it to about 1e-15 (for parameters up to MAX_CAYLEY).
 * A ball's pose is its centre [t_1..t_d].
 */
import { det, matmul, solve, transpose } from "./linalg";

/** Largest absolute value of a Cayley parameter (keeps I - S well conditioned, and rotations within 3.5 degrees of a half turn out). */
export const MAX_CAYLEY = 32;
/** Largest absolute value of a centre coordinate. */
export const MAX_COORD = 1e4;
/** Largest container scale s accepted. */
export const MAX_SIZE = 1e6;

export const nParams = (d: number): number => (d * (d - 1)) / 2;
export const poseLength = (d: number, ball: boolean): number => (ball ? d : d + nParams(d));

/** R = D (I - S)^-1 (I + S) for the Cayley parameters (upper triangle of S, row-major) and the flip bit mask. */
export function cayleyMatrix(params: ArrayLike<number>, d: number, flip = 0): Float64Array {
  const A = new Float64Array(d * d);
  const B = new Float64Array(d * d);
  for (let i = 0; i < d; i++) {
    A[i * d + i] = 1;
    B[i * d + i] = 1;
  }
  let k = 0;
  for (let i = 0; i < d; i++)
    for (let j = i + 1; j < d; j++) {
      const v = params[k++];
      A[i * d + j] = -v; // I - S
      A[j * d + i] = v;
      B[i * d + j] = v; // I + S
      B[j * d + i] = -v;
    }
  const C = solve(A, B, d, d);
  if (!C) throw new RangeError("I - S is singular");
  for (let i = 0; i < d; i++) if ((flip >> i) & 1) for (let j = 0; j < d; j++) C[i * d + j] = -C[i * d + j];
  return C;
}

const parity = (m: number): number => {
  let c = 0;
  for (; m; m &= m - 1) c++;
  return c & 1;
};

/**
 * The Cayley parameters and flip of a rotation matrix (row-major d x d), choosing the flip that keeps the parameters
 * smallest (all even flips for d <= 7, a greedy start and its pair swaps above). Throws a RangeError, with the reason, for
 * a matrix that is not finite, not orthonormal (R^T R differs from I by more than 1e-9), a reflection (determinant < 0)
 * or without a Cayley form within MAX_CAYLEY.
 */
export function cayleyOfMatrix(R: ArrayLike<number>, d: number): { params: number[]; flip: number } {
  if (R.length !== d * d || !Array.from(R).every(Number.isFinite))
    throw new RangeError("the rotation must be a finite d x d matrix");
  const M = Float64Array.from(R);
  const G = matmul(transpose(M, d), M, d);
  for (let i = 0; i < d; i++)
    for (let j = 0; j < d; j++)
      if (Math.abs(G[i * d + j] - (i === j ? 1 : 0)) > 1e-9)
        throw new RangeError("the matrix is not orthonormal (R^T R differs from I by more than 1e-9)");
  if (det(M, d) < 0) throw new RangeError("the matrix is a reflection (determinant -1): poses are rotations only");
  let masks: number[] = [];
  if (d <= 7) {
    for (let m = 0; m < 1 << d; m++) if (!parity(m)) masks.push(m);
  } else {
    let base = 0;
    for (let i = 0; i < d; i++) if (M[i * d + i] < 0) base |= 1 << i;
    if (parity(base)) {
      let imin = 0;
      for (let i = 1; i < d; i++) if (Math.abs(M[i * d + i]) < Math.abs(M[imin * d + imin])) imin = i;
      base ^= 1 << imin;
    }
    masks = [base];
    for (let i = 0; i < d; i++) for (let j = i + 1; j < d; j++) masks.push(base ^ (1 << i) ^ (1 << j));
  }
  let best: { size: number; params: number[]; flip: number } | null = null;
  for (const m of masks) {
    const C = new Float64Array(d * d);
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i * d + j] = ((m >> i) & 1 ? -1 : 1) * M[i * d + j];
    const num = Float64Array.from(C);
    const den = Float64Array.from(C);
    for (let i = 0; i < d; i++) {
      num[i * d + i] -= 1;
      den[i * d + i] += 1;
    }
    // S = num den^-1, i.e. den^T S^T = num^T
    const St = solve(transpose(den, d), transpose(num, d), d, d);
    if (!St) continue;
    const S = transpose(St, d);
    const params: number[] = [];
    let size = 0;
    for (let i = 0; i < d; i++)
      for (let j = i + 1; j < d; j++) {
        const v = 0.5 * (S[i * d + j] - S[j * d + i]);
        params.push(v);
        size = Math.max(size, Math.abs(v));
      }
    if (!best || size < best.size) best = { size, params, flip: m };
  }
  if (!best || !(best.size <= MAX_CAYLEY))
    throw new RangeError("the rotation has no Cayley form within the parameter bound");
  return { params: best.params, flip: best.flip };
}

/** The pose array [t..., k..., flip] of a centre and a rotation matrix (see cayleyOfMatrix for the refusals). */
export function poseOfMatrix(t: ArrayLike<number>, R: ArrayLike<number>, d: number): number[] {
  const { params, flip } = cayleyOfMatrix(R, d);
  return [...Array.from(t).slice(0, d), ...params, flip];
}

/** A pose read from untrusted input: the centre and, for a polytope, the rotation matrix. */
export interface ReadPose {
  t: Float64Array;
  R: Float64Array | null;
}

/** Reads a pose; returns the error text when it is malformed. */
export function readPose(d: number, pose: unknown, ball: boolean): ReadPose | string {
  const m = nParams(d);
  if (!Array.isArray(pose)) return "must be an array of numbers";
  if (ball) {
    if (pose.length !== d) return `must be the centre of a ball, ${d} numbers`;
  } else if (pose.length !== d + m && pose.length !== d + m + 1)
    return `must have ${d + m} numbers (centre and Cayley parameters) and an optional flip`;
  const n = ball ? d : d + m;
  for (let i = 0; i < n; i++)
    if (typeof pose[i] !== "number" || !Number.isFinite(pose[i])) return "must contain finite numbers only";
  for (let i = 0; i < d; i++)
    if (Math.abs(pose[i]) > MAX_COORD) return `centre coordinates must be at most ${MAX_COORD} in absolute value`;
  const t = Float64Array.from(pose.slice(0, d) as number[]);
  if (ball) return { t, R: null };
  for (let i = d; i < d + m; i++)
    if (Math.abs(pose[i]) > MAX_CAYLEY) return `Cayley parameters must be at most ${MAX_CAYLEY} in absolute value`;
  let flip = 0;
  if (pose.length === d + m + 1) {
    const f = pose[d + m];
    if (!Number.isInteger(f) || f < 0 || f >= 2 ** d) return `the flip must be an integer in [0, 2^${d})`;
    if (parity(f)) return "the flip must have an even number of set bits (a reflection is refused)";
    flip = f;
  }
  return { t, R: cayleyMatrix((pose as number[]).slice(d, d + m), d, flip) };
}

/** The world vertices t + R v of canonical vertices V (nV x d), flat. */
export function placeVertices(V: Float64Array, nV: number, d: number, t: Float64Array, R: Float64Array): Float64Array {
  const X = new Float64Array(nV * d);
  for (let v = 0; v < nV; v++)
    for (let i = 0; i < d; i++) {
      let s = t[i];
      for (let j = 0; j < d; j++) s += R[i * d + j] * V[v * d + j];
      X[v * d + i] = s;
    }
  return X;
}

/**
 * The facets of a polytope placed by t + R x: unit normals R N_f and offsets b_f + (R N_f) . t, so that the placed
 * polytope is { x : N'_f . x <= b'_f }.
 */
export function placeFacets(
  N: Float64Array,
  b: Float64Array,
  nF: number,
  d: number,
  t: ArrayLike<number>,
  R: Float64Array,
): { N: Float64Array; b: Float64Array } {
  const N2 = new Float64Array(nF * d);
  const b2 = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    let off = b[f];
    for (let i = 0; i < d; i++) {
      let s = 0;
      for (let j = 0; j < d; j++) s += R[i * d + j] * N[f * d + j];
      N2[f * d + i] = s;
      off += s * t[i];
    }
    b2[f] = off;
  }
  return { N: N2, b: b2 };
}
