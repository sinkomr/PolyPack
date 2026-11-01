/**
 * Separation of two convex polytopes (or points) in d dimensions from their vertex lists.
 *
 * signedSeparation(A, B) is the largest gap of a separating hyperplane: the distance of the two convex hulls when they
 * are disjoint, and minus the penetration depth (the length of the smallest translation that separates them) when they
 * overlap. It is the d-dimensional replacement of the separating-axis test of the 3D space (whose candidate axes are the
 * facet normals of the Minkowski difference A - B, too many for d >= 4):
 *
 *  - disjoint: GJK with Wolfe's minimum-norm-point solver on A - B (support points of the two sets, no explicit
 *    difference), accurate to about 1e-13;
 *  - overlapping: EPA, expanding a simplicial polytope inside A - B (initialised from GJK's final simplex, completed to d + 1
 *    points) until its facet nearest to the origin is a facet of A - B. The depth it returns never exceeds the true
 *    depth and converges to it from below, so "overlaps by more than tol" is a sound verdict.
 *
 * Any unit vector u gives a lower bound of the separation, min_B u.y - max_A u.x (gapAlong); a pair is settled as soon as
 * one of a few candidate directions shows a gap of at least -tol.
 */
import { dot, solve } from "./linalg";

/** min over rows of B of u.y minus max over rows of A of u.x, for a unit vector u: a lower bound of the signed separation. */
export function gapAlong(
  A: Float64Array,
  nA: number,
  B: Float64Array,
  nB: number,
  d: number,
  u: ArrayLike<number>,
): number {
  let amax = -Infinity;
  for (let i = 0; i < nA; i++) {
    const s = dot(A, u, d, i * d, 0);
    if (s > amax) amax = s;
  }
  let bmin = Infinity;
  for (let i = 0; i < nB; i++) {
    const s = dot(B, u, d, i * d, 0);
    if (s < bmin) bmin = s;
  }
  return bmin - amax;
}

/** The point of A - B that maximises dir . p (a - b with a maximising dir . a and b minimising dir . b). */
function supportDiff(
  A: Float64Array,
  nA: number,
  B: Float64Array,
  nB: number,
  d: number,
  dir: ArrayLike<number>,
  out: Float64Array,
): void {
  let ia = 0;
  let va = -Infinity;
  for (let i = 0; i < nA; i++) {
    const s = dot(A, dir, d, i * d, 0);
    if (s > va) {
      va = s;
      ia = i;
    }
  }
  let ib = 0;
  let vb = Infinity;
  for (let i = 0; i < nB; i++) {
    const s = dot(B, dir, d, i * d, 0);
    if (s < vb) {
      vb = s;
      ib = i;
    }
  }
  for (let c = 0; c < d; c++) out[c] = A[ia * d + c] - B[ib * d + c];
}

/** Coefficients (sum 1) of the minimum-norm point of the affine hull of the points S, or null if numerically singular. */
function affineMin(S: Float64Array[], d: number): Float64Array | null {
  const k = S.length;
  const n = k + 1;
  const M = new Float64Array(n * n);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) M[i * n + j] = dot(S[i], S[j], d);
    M[i * n + k] = 1;
    M[k * n + i] = 1;
  }
  const rhs = new Float64Array(n);
  rhs[k] = 1;
  const sol = solve(M, rhs, n, 1);
  return sol ? sol.slice(0, k) : null;
}

export interface ClosestResult {
  /** Distance of conv(A) and conv(B); 0 when they touch or overlap. */
  dist: number;
  /** The point a* - b* of A - B nearest the origin; null when the sets touch or overlap (|w| < 1e-14). */
  w: Float64Array | null;
  /** The final corral (affinely independent points of A - B whose hull holds the minimum-norm point). */
  corral: Float64Array[];
}

/** Closest points of conv(A) and conv(B) by GJK / Wolfe's minimum-norm-point algorithm. */
export function closestPoints(
  A: Float64Array,
  nA: number,
  B: Float64Array,
  nB: number,
  d: number,
  maxIter = 500,
): ClosestResult {
  let S: Float64Array[] = [new Float64Array(d)];
  for (let c = 0; c < d; c++) S[0][c] = A[c] - B[c];
  let lam = [1];
  let x = Float64Array.from(S[0]);
  const p = new Float64Array(d);
  const neg = new Float64Array(d);
  let last = Infinity;
  for (let it = 0; it < maxIter; it++) {
    const xx = dot(x, x, d);
    if (xx < 1e-28) return { dist: 0, w: null, corral: S };
    for (let c = 0; c < d; c++) neg[c] = -x[c];
    supportDiff(A, nA, B, nB, d, neg, p); // minimises x . p
    if (xx - dot(x, p, d) <= 1e-15 + 1e-14 * xx) break; // no support point is lower than x, to the noise of the coordinates
    if (xx >= last * (1 - 1e-15)) break; // stalled at the rounding level
    last = xx;
    if (S.some((q) => q.every((v, c) => Math.abs(v - p[c]) < 1e-15))) break;
    S.push(Float64Array.from(p));
    lam.push(0);
    for (;;) {
      const mu = affineMin(S, d);
      if (!mu) {
        S.pop();
        lam.pop();
        break;
      }
      if (mu.every((m) => m > 1e-14)) {
        lam = Array.from(mu);
        break;
      }
      let theta = 1;
      for (let i = 0; i < lam.length; i++) {
        if (mu[i] <= 1e-14) {
          const den = lam[i] - mu[i];
          theta = Math.min(theta, den > 1e-300 ? lam[i] / den : 0);
        }
      }
      theta = Math.max(0, theta);
      lam = lam.map((l, i) => (1 - theta) * l + theta * mu[i]);
      let keep = lam.map((l, i) => i).filter((i) => lam[i] > 1e-14);
      if (keep.length === lam.length) {
        let imin = 0;
        for (let i = 1; i < lam.length; i++) if (lam[i] < lam[imin]) imin = i;
        keep = keep.filter((i) => i !== imin);
      }
      S = keep.map((i) => S[i]);
      lam = keep.map((i) => lam[i]);
      const tot = lam.reduce((a, b) => a + b, 0);
      lam = lam.map((l) => l / tot);
    }
    x = new Float64Array(d);
    for (let i = 0; i < S.length; i++) for (let c = 0; c < d; c++) x[c] += lam[i] * S[i][c];
  }
  return { dist: Math.sqrt(dot(x, x, d)), w: x, corral: S };
}

// ---------------------------------------------------------------------------------------------------------- EPA
interface Face {
  idx: number[]; // d point indices
  n: Float64Array; // unit outward normal
  off: number; // n . (a point of the face)
  alive: boolean;
}

/** A unit vector orthogonal to the d - 1 rows (r x d), or null if they are dependent. */
function nullVector(rows: Float64Array, r: number, d: number): Float64Array | null {
  const M = Float64Array.from(rows);
  const used = new Array<boolean>(d).fill(false);
  const pivCol: number[] = [];
  let scale = 0;
  for (const v of M) scale = Math.max(scale, Math.abs(v));
  if (!(scale > 0)) return null;
  for (let k = 0; k < r; k++) {
    let bi = -1;
    let bj = -1;
    let bv = 0;
    for (let i = k; i < r; i++)
      for (let j = 0; j < d; j++)
        if (!used[j] && Math.abs(M[i * d + j]) > bv) {
          bv = Math.abs(M[i * d + j]);
          bi = i;
          bj = j;
        }
    if (!(bv > 1e-13 * scale)) return null;
    if (bi !== k) for (let j = 0; j < d; j++) [M[k * d + j], M[bi * d + j]] = [M[bi * d + j], M[k * d + j]];
    used[bj] = true;
    pivCol.push(bj);
    const piv = M[k * d + bj];
    for (let j = 0; j < d; j++) M[k * d + j] /= piv;
    for (let i = 0; i < r; i++) {
      if (i === k) continue;
      const f = M[i * d + bj];
      if (f !== 0) for (let j = 0; j < d; j++) M[i * d + j] -= f * M[k * d + j];
    }
  }
  const free = used.findIndex((u) => !u);
  const n = new Float64Array(d);
  n[free] = 1;
  for (let k = 0; k < r; k++) n[pivCol[k]] = -M[k * d + free];
  let len = 0;
  for (let c = 0; c < d; c++) len += n[c] * n[c];
  len = Math.sqrt(len);
  for (let c = 0; c < d; c++) n[c] /= len;
  return n;
}

export interface PenetrationResult {
  /** Lower bound of the penetration depth of A and B (converging to it from below). */
  depth: number;
  /** Whether the expansion ended with a facet of A - B (false: the iteration cap was reached). */
  converged: boolean;
  /** The unit outward normal of that facet: moving B by depth * normal (relative to A) separates the two. */
  normal: Float64Array | null;
}

/**
 * Penetration depth of two overlapping (or touching) convex hulls by EPA, started from the corral of a GJK run that ended
 * with the origin inside A - B.
 */
export function penetrationDepth(
  A: Float64Array,
  nA: number,
  B: Float64Array,
  nB: number,
  d: number,
  corral: Float64Array[],
  maxIter = 600,
): PenetrationResult {
  const pts: Float64Array[] = corral.map((q) => Float64Array.from(q));
  // Complete the corral to d + 1 affinely independent points. The origin lies in (or within rounding of) the affine hull
  // of the corral, so the support point of A - B in a direction orthogonal to that hull's direction space lies off it.
  const basis: Float64Array[] = [];
  const orth = (v: Float64Array): number => {
    for (const b of basis) {
      const f = dot(v, b, d);
      for (let c = 0; c < d; c++) v[c] -= f * b[c];
    }
    return Math.sqrt(dot(v, v, d));
  };
  for (let k = 1; k < pts.length; k++) {
    const v = new Float64Array(d);
    for (let c = 0; c < d; c++) v[c] = pts[k][c] - pts[0][c];
    const l = orth(v);
    if (l > 1e-12) {
      for (let c = 0; c < d; c++) v[c] /= l;
      basis.push(v);
    }
  }
  while (pts.length < d + 1) {
    let best: Float64Array | null = null;
    let bl = 0;
    for (let i = 0; i < d; i++) {
      const v = new Float64Array(d);
      v[i] = 1;
      const l = orth(v);
      if (l > bl) {
        bl = l;
        best = v;
      }
    }
    if (!best) break;
    for (let c = 0; c < d; c++) best[c] /= bl;
    const p = new Float64Array(d);
    supportDiff(A, nA, B, nB, d, best, p);
    if (dot(p, best, d) < 1e-14) {
      for (let c = 0; c < d; c++) best[c] = -best[c];
      supportDiff(A, nA, B, nB, d, best, p);
    }
    pts.push(p);
    basis.push(best);
  }
  if (pts.length < d + 1) return { depth: 0, converged: false, normal: null };
  // the reference point c0 inside every hull we build: the centroid of the initial simplex
  const c0 = new Float64Array(d);
  for (const q of pts) for (let c = 0; c < d; c++) c0[c] += q[c] / pts.length;
  const faces: Face[] = [];
  const rows = new Float64Array((d - 1) * d);
  const makeFace = (idx: number[]): Face | null => {
    const q0 = pts[idx[0]];
    for (let k = 1; k < d; k++) for (let c = 0; c < d; c++) rows[(k - 1) * d + c] = pts[idx[k]][c] - q0[c];
    const n = nullVector(rows, d - 1, d);
    if (!n) return null;
    let s = 0;
    for (let c = 0; c < d; c++) s += n[c] * (c0[c] - q0[c]);
    if (s > 0) for (let c = 0; c < d; c++) n[c] = -n[c];
    return { idx, n, off: dot(n, q0, d), alive: true };
  };
  for (let omit = 0; omit <= d; omit++) {
    const f = makeFace(pts.map((_, i) => i).filter((i) => i !== omit));
    if (f) faces.push(f);
  }
  if (faces.length < d + 1) return { depth: 0, converged: false, normal: null };
  const p = new Float64Array(d);
  let best = 0;
  for (let it = 0; it < maxIter; it++) {
    let f: Face | null = null;
    for (const g of faces) if (g.alive && (!f || g.off < f.off)) f = g;
    if (!f) break;
    best = Math.max(best, f.off);
    supportDiff(A, nA, B, nB, d, f.n, p);
    const gain = dot(f.n, p, d) - f.off;
    if (gain <= 1e-12 * (1 + Math.abs(f.off))) return { depth: Math.max(0, f.off), converged: true, normal: f.n };
    const pi = pts.length;
    pts.push(Float64Array.from(p));
    const visible: Face[] = [];
    for (const g of faces) if (g.alive && dot(g.n, p, d) - g.off > 1e-13) visible.push(g);
    if (visible.length === 0) return { depth: Math.max(0, f.off), converged: true, normal: f.n };
    const ridges = new Map<string, { ridge: number[]; count: number }>();
    for (const g of visible) {
      g.alive = false;
      for (let skip = 0; skip < d; skip++) {
        const ridge = g.idx.filter((_, k) => k !== skip).sort((a, b) => a - b);
        const key = ridge.join(",");
        const e = ridges.get(key);
        if (e) e.count++;
        else ridges.set(key, { ridge, count: 1 });
      }
    }
    for (const { ridge, count } of ridges.values()) {
      if (count !== 1) continue;
      const nf = makeFace([...ridge, pi]);
      if (nf) faces.push(nf);
    }
    if (faces.length > 60000) break;
  }
  let m = Infinity;
  let fm: Face | null = null;
  for (const g of faces)
    if (g.alive && g.off < m) {
      m = g.off;
      fm = g;
    }
  return { depth: Math.max(0, Number.isFinite(m) ? m : best), converged: false, normal: fm ? fm.n : null };
}

/** GJK distances below this are not trusted (it can stall with a point of about 1e-14 inside an overlap): EPA decides. */
const TOUCH = 1e-12;

export interface Separation {
  /** Distance when disjoint, minus the penetration depth when overlapping (a lower bound of the depth, see above). */
  sep: number;
  /**
   * Disjoint: the unit normal, pointing from A to B, of a separating hyperplane achieving sep. Overlapping: the unit
   * direction in which moving B by |sep| separates the two (null if EPA found none).
   */
  dir: Float64Array | null;
  /** False when EPA stopped at its iteration cap. */
  converged: boolean;
}

/** The signed separation of conv(A) and conv(B) (see the module comment). */
export function signedSeparation(A: Float64Array, nA: number, B: Float64Array, nB: number, d: number): Separation {
  const c = closestPoints(A, nA, B, nB, d);
  // below TOUCH the sets may touch or overlap (GJK can stall near the origin with a tiny nonzero point): EPA decides
  if (c.w && c.dist >= TOUCH) {
    const dir = new Float64Array(d);
    for (let i = 0; i < d; i++) dir[i] = -c.w[i] / c.dist;
    return { sep: c.dist, dir, converged: true };
  }
  const e = penetrationDepth(A, nA, B, nB, d, c.corral);
  return { sep: -e.depth, dir: e.normal, converged: e.converged };
}
