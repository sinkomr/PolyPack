/**
 * The fallback of the pair test: a max-margin separating hyperplane of two vertex sets by linear programming.
 *
 * For unit vectors u (Euclidean norm 1) the gap of u is gap(u) = min over B of u.y - max over A of u.x, and the signed
 * separation of the hulls is sep = max over u of gap(u) (the distance when positive, minus the penetration depth when
 * not). The LP maximises the same expression over the box instead of the sphere:
 *
 *   g = max { delta : a.x <= b - delta/2 on A, a.y >= b + delta/2 on B, |a|_inf = 1 }.
 *
 * (Without a normalisation the LP is useless: a = 0 is feasible with delta = 0, which would call every overlapping pair
 * touching. |a|_inf = 1 is not a linear constraint, so the LP is solved 2d times, once for each coordinate fixed to
 * a_i = +1 or -1 with the others in [-1, 1]; g is the largest of the 2d optima.)
 *
 * The relation to the Euclidean separation, from |a|_inf <= |a|_2 <= sqrt(d) |a|_inf [CALC]:
 *  - g >= 0 (separable): g / sqrt(d) <= sep <= g;
 *  - g <  0 (overlap, depth D = -sep): -sqrt(d) D <= g <= -D, so g <= sep <= g / sqrt(d).
 * Hence the decisions (tol >= 0, sep the Euclidean separation):
 *  - accept: for the optimal a of a branch, u = a / |a|_2 has gap(u) = g_a / |a|_2, and the gap of any unit vector is a
 *    lower bound of sep (sep is their maximum). gap(u) >= -tol therefore proves sep >= -tol, whatever the LP did;
 *  - refuse: g < -sqrt(d) tol gives D > tol, a true overlap by more than tol (this uses the LP's upper bound t);
 *  - otherwise (-sqrt(d) tol <= g, no certificate): inconclusive, the caller refuses. The band is empty at tol = 0.
 *
 * Each of the 2d LPs has d unknowns and one constraint per vertex, so it is solved by cutting planes (Kelley's method):
 * the master LP keeps a pool of constraints t <= a.w_k, where w_k = y - x for the pairs the current a selects as most
 * violated (the point of B - A minimising a.w, found in O(nV d) from the vertex lists), and is solved by a dense
 * simplex with Bland's anti-cycling rule. The pool is shared by the 2d branches. The master value t is an upper bound of
 * the branch optimum, the true value g(a) of the master's a a lower bound; they meet when the polytope has been cut
 * enough, which for polytopes happens after finitely many cuts.
 */
import { dot } from "./linalg";

export interface MarginOptions {
  /** Stop with `separated` as soon as a unit direction with gap at least this is certified (typically -tol). */
  acceptAt?: number;
  /** Stop with `overlapping` once the optimum is proved below this (typically -sqrt(d) tol: the box margin g). */
  refuseBelow?: number;
  /** Cuts in the shared pool, default 260. */
  maxCuts?: number;
  /** Master solves per branch, default 140. */
  maxRounds?: number;
}

export interface MarginResult {
  /** Certified lower bound of the signed separation: the gap of the unit vector `dir`. */
  lower: number;
  /** The unit vector achieving `lower` (pointing from A to B), null if none was evaluated. */
  dir: Float64Array | null;
  /** Upper bound of the signed separation (see the module comment), valid when `conclusive`; else +Infinity. */
  upper: number;
  /** The LP optima of all 2d branches were bracketed (or a stopping threshold was reached). */
  conclusive: boolean;
  /** "separated": a certified gap >= acceptAt; "overlapping": proved below refuseBelow; "open": neither. */
  verdict: "separated" | "overlapping" | "open";
  /** Master solves done (a measure of the work). */
  rounds: number;
}

/**
 * Dense simplex for: maximise z[n-1] subject to G z <= h, z >= 0, with h >= 0 (so z = 0 is feasible). G is m x n, row-major.
 * Compact (Tucker) tableau and Bland's rule once degenerate pivots pile up. Returns z, or null if the pivot cap was hit.
 */
function simplexMax(G: Float64Array, h: Float64Array, m: number, n: number, maxPivots: number): Float64Array | null {
  const w = n + 1;
  const T = new Float64Array((m + 1) * w);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) T[i * w + j] = G[i * n + j];
    T[i * w + n] = Math.max(0, h[i]);
  }
  T[m * w + n - 1] = -1; // objective row: obj = T[m][n] - sum T[m][j] z_j, so -1 means "increasing z[n-1] gains 1"
  const rowVar = new Int32Array(m);
  const colVar = new Int32Array(n);
  for (let i = 0; i < m; i++) rowVar[i] = n + i;
  for (let j = 0; j < n; j++) colVar[j] = j;
  const EPS = 1e-11;
  let degenerate = 0;
  for (let it = 0; it < maxPivots; it++) {
    let q = -1;
    if (degenerate < 30) {
      let best = -EPS;
      for (let j = 0; j < n; j++)
        if (T[m * w + j] < best) {
          best = T[m * w + j];
          q = j;
        }
    } else {
      let lab = Infinity;
      for (let j = 0; j < n; j++) if (T[m * w + j] < -EPS && colVar[j] < lab) ((lab = colVar[j]), (q = j));
    }
    if (q < 0) {
      const z = new Float64Array(n);
      for (let i = 0; i < m; i++) if (rowVar[i] < n) z[rowVar[i]] = T[i * w + n];
      return z;
    }
    let r = -1;
    let ratio = Infinity;
    for (let i = 0; i < m; i++) {
      const c = T[i * w + q];
      if (c > EPS) {
        const rt = T[i * w + n] / c;
        if (rt < ratio - 1e-14 || (rt <= ratio + 1e-14 && r >= 0 && rowVar[i] < rowVar[r])) {
          ratio = rt;
          r = i;
        }
      }
    }
    if (r < 0) return null; // unbounded: cannot happen with the bound rows, so numerical trouble
    degenerate = ratio < 1e-13 ? degenerate + 1 : 0;
    const piv = T[r * w + q];
    for (let j = 0; j < w; j++) if (j !== q) T[r * w + j] /= piv;
    T[r * w + q] = 1 / piv;
    for (let i = 0; i <= m; i++) {
      if (i === r) continue;
      const f = T[i * w + q];
      if (f === 0) continue;
      for (let j = 0; j < w; j++) if (j !== q) T[i * w + j] -= f * T[r * w + j];
      T[i * w + q] = -f / piv;
    }
    const tmp = rowVar[r];
    rowVar[r] = colVar[q];
    colVar[q] = tmp;
  }
  return null;
}

/**
 * Decides, or brackets, the signed separation of conv(A) and conv(B) by the max-margin LP (see the module comment).
 * Never throws; `verdict` "open" means the LP did not settle the thresholds within its caps.
 */
export function maxMarginSeparation(
  A: Float64Array,
  nA: number,
  B: Float64Array,
  nB: number,
  d: number,
  opts: MarginOptions = {},
  seed: ArrayLike<number>[] = [],
): MarginResult {
  const acceptAt = opts.acceptAt ?? Infinity;
  const refuseBelow = opts.refuseBelow ?? -Infinity;
  const maxCuts = opts.maxCuts ?? 260;
  const maxRounds = opts.maxRounds ?? 140;
  const sqrtD = Math.sqrt(d);
  // M bounds |w|_1 for every w = y - x: |w|_1 <= sqrt(d) |w|_2 <= sqrt(d) (rA + rB + |cB - cA|)
  const cA = new Float64Array(d);
  const cB = new Float64Array(d);
  for (let i = 0; i < nA; i++) for (let c = 0; c < d; c++) cA[c] += A[i * d + c] / nA;
  for (let i = 0; i < nB; i++) for (let c = 0; c < d; c++) cB[c] += B[i * d + c] / nB;
  let rA = 0;
  let rB = 0;
  for (let i = 0; i < nA; i++) {
    let s = 0;
    for (let c = 0; c < d; c++) s += (A[i * d + c] - cA[c]) ** 2;
    rA = Math.max(rA, Math.sqrt(s));
  }
  for (let i = 0; i < nB; i++) {
    let s = 0;
    for (let c = 0; c < d; c++) s += (B[i * d + c] - cB[c]) ** 2;
    rB = Math.max(rB, Math.sqrt(s));
  }
  let dc = 0;
  for (let c = 0; c < d; c++) dc += (cB[c] - cA[c]) ** 2;
  const M = sqrtD * (rA + rB + Math.sqrt(dc)) * (1 + 1e-9) + 1e-9;

  const cuts: Float64Array[] = [];
  const addCut = (w: Float64Array): void => {
    for (const q of cuts) {
      let same = true;
      for (let c = 0; c < d; c++)
        if (q[c] !== w[c]) {
          same = false;
          break;
        }
      if (same) return;
    }
    cuts.push(w);
  };
  const a = new Float64Array(d);
  const unit = new Float64Array(d);
  /** The point w = y - x of B - A minimising a.w, and a.w. */
  const worst = (aa: ArrayLike<number>): { w: Float64Array; g: number } => {
    let ia = 0;
    let va = -Infinity;
    for (let i = 0; i < nA; i++) {
      const s = dot(A, aa, d, i * d, 0);
      if (s > va) {
        va = s;
        ia = i;
      }
    }
    let ib = 0;
    let vb = Infinity;
    for (let i = 0; i < nB; i++) {
      const s = dot(B, aa, d, i * d, 0);
      if (s < vb) {
        vb = s;
        ib = i;
      }
    }
    const w = new Float64Array(d);
    for (let c = 0; c < d; c++) w[c] = B[ib * d + c] - A[ia * d + c];
    return { w, g: vb - va };
  };
  // seeds: the support points in the coordinate directions, and the given ones (typically the points GJK found)
  for (let i = 0; i < d; i++) {
    for (const sg of [1, -1]) {
      a.fill(0);
      a[i] = sg;
      addCut(worst(a).w);
    }
  }
  for (const s of seed) {
    const w = new Float64Array(d);
    for (let c = 0; c < d; c++) w[c] = s[c];
    addCut(w);
  }

  let lower = -Infinity;
  let bestDir: Float64Array | null = null;
  let upper = -Infinity; // max over branches of the proved upper bound of the branch optimum g
  let rounds = 0;
  let conclusive = true;
  let verdict: MarginResult["verdict"] = "open";
  const finish = (): MarginResult => {
    let up = Infinity;
    if (conclusive) up = upper >= 0 ? upper : upper / sqrtD;
    return { lower, dir: bestDir, upper: up, conclusive, verdict, rounds };
  };
  const n = d; // d - 1 free coordinates and t'
  branches: for (let i = 0; i < d; i++) {
    for (const sigma of [1, -1]) {
      let branchUp = Infinity;
      let done = false;
      for (let round = 0; round < maxRounds; round++) {
        // master: variables a'_j = a_j + 1 in [0, 2] (j != i) and t' = t + M in [0, 2 M]
        const m = cuts.length + d;
        const G = new Float64Array(m * n);
        const h = new Float64Array(m);
        for (let k = 0; k < cuts.length; k++) {
          const w = cuts[k];
          let sumOthers = 0;
          let col = 0;
          for (let j = 0; j < d; j++) {
            if (j === i) continue;
            G[k * n + col++] = -w[j];
            sumOthers += w[j];
          }
          G[k * n + n - 1] = 1;
          h[k] = sigma * w[i] + M - sumOthers;
        }
        for (let c = 0; c < d - 1; c++) {
          G[(cuts.length + c) * n + c] = 1;
          h[cuts.length + c] = 2;
        }
        G[(cuts.length + d - 1) * n + n - 1] = 1;
        h[cuts.length + d - 1] = 2 * M;
        rounds++;
        const z = simplexMax(G, h, m, n, 40 * (m + n) + 200);
        if (!z) break;
        const t = z[n - 1] - M;
        branchUp = Math.min(branchUp, t);
        let col = 0;
        for (let j = 0; j < d; j++) a[j] = j === i ? sigma : z[col++] - 1;
        let na = 0;
        for (let j = 0; j < d; j++) na += a[j] * a[j];
        na = Math.sqrt(na);
        const { w, g } = worst(a);
        const cert = g / na; // gap of the unit vector a / |a|_2: a rigorous lower bound of the separation
        if (cert > lower) {
          lower = cert;
          bestDir = new Float64Array(d);
          for (let j = 0; j < d; j++) bestDir[j] = a[j] / na;
        }
        if (lower >= acceptAt) {
          verdict = "separated";
          return finish();
        }
        if (t < refuseBelow || t - g <= 1e-11 * (1 + Math.abs(t))) {
          done = true; // the branch optimum is at most t, and (when t - g is tiny) equals it
          break;
        }
        if (cuts.length >= maxCuts) break;
        addCut(w);
      }
      if (!done) {
        conclusive = false;
        upper = Infinity;
        if (cuts.length >= maxCuts) break branches;
      } else upper = Math.max(upper, branchUp);
    }
  }
  if (conclusive && upper < refuseBelow) verdict = "overlapping";
  else if (conclusive && lower >= acceptAt) verdict = "separated";
  return finish();
}
