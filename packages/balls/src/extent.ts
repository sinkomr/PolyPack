/**
 * The two radii that a solid's lower bounds in the balls space rest on, about the best centre and not about the
 * vertex centroid:
 *
 *  - chebyshevRadius: the radius of the largest ball inside the solid (the Chebyshev radius), max over x of
 *    min_f (b_f - N_f . x);
 *  - enclosingRadius: the radius of the smallest ball holding the solid (that of its vertices).
 *
 * For the 94 solids of the first catalogue the vertex centroid is both centres (their symmetry groups fix no other
 * point, container.ts), so there these are Solid.inradius and Solid.circumradius, and those values are used as they
 * are. The 92 Johnson solids are mostly not symmetric enough: a pyramid's largest inscribed ball is not centred at
 * its vertex centroid, and neither is its smallest enclosing ball. A bound that divides by the centroid's inradius,
 * or asks for the centroid's circumradius, would then be too strong, so the bounds use these.
 *
 * Floating point, [CALC]. The inscribed ball is a linear programme in (x, r) solved by a tableau simplex with Bland's
 * rule; the enclosing ball is Welzl's algorithm on the vertices. Where the optimum is not the centroid's value the
 * result is moved by 1e-9 of itself in the direction that keeps a bound valid (the inradius up, the enclosing radius
 * down), which is far above the rounding of either computation and far below any bound's use.
 */
import type { Solid } from "@polypack/polyhedra";

const SAFETY = 1e-9;

/** max r with N_f . x + r <= b_f for every face f: simplex on the variables x+, x- (x = x+ - x-) and r, all >= 0. */
export function chebyshevOf(N: ArrayLike<number>, b: ArrayLike<number>): number {
  const F = b.length;
  const n = 7; // x+ (3), x- (3), r
  const w = n + F + 1;
  // rows: F constraints, then the objective row (maximise r, stored as -r)
  const T = Array.from({ length: F + 1 }, () => new Float64Array(w));
  const basis = new Int32Array(F);
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 3; k++) {
      T[f][k] = N[3 * f + k];
      T[f][3 + k] = -N[3 * f + k];
    }
    T[f][6] = 1;
    T[f][n + f] = 1;
    T[f][w - 1] = b[f];
    basis[f] = n + f;
  }
  T[F][6] = -1;
  for (let iter = 0; iter < 10000; iter++) {
    // Bland: the lowest-index column with a negative reduced cost
    let col = -1;
    for (let j = 0; j < w - 1; j++)
      if (T[F][j] < -1e-13) {
        col = j;
        break;
      }
    if (col < 0) break;
    let row = -1;
    let best = Infinity;
    for (let f = 0; f < F; f++) {
      if (T[f][col] > 1e-13) {
        const ratio = T[f][w - 1] / T[f][col];
        if (ratio < best - 1e-15 || (Math.abs(ratio - best) <= 1e-15 && basis[f] < basis[row])) {
          best = ratio;
          row = f;
        }
      }
    }
    if (row < 0) throw new Error("the inscribed ball is unbounded: not a bounded polyhedron");
    const p = T[row][col];
    for (let j = 0; j < w; j++) T[row][j] /= p;
    for (let f = 0; f <= F; f++) {
      if (f === row) continue;
      const m = T[f][col];
      if (m !== 0) for (let j = 0; j < w; j++) T[f][j] -= m * T[row][j];
    }
    basis[row] = col;
  }
  return T[F][w - 1];
}

type Ball = { c: [number, number, number]; r2: number };

/** The ball with the given points (1 to 4) on its boundary and the smallest radius, or null when they are degenerate. */
function ballOn(pts: number[][]): Ball | null {
  const [a, b] = pts;
  if (pts.length === 0) return { c: [0, 0, 0], r2: -1 };
  if (pts.length === 1) return { c: [a[0], a[1], a[2]], r2: 0 };
  if (pts.length === 2) {
    const m: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    return { c: m, r2: (a[0] - m[0]) ** 2 + (a[1] - m[1]) ** 2 + (a[2] - m[2]) ** 2 };
  }
  // centre = a + sum_k t_k (p_k - a) in the span of the others' differences, from |x - a|^2 = |x - p|^2
  const u = pts.slice(1).map((p) => [p[0] - a[0], p[1] - a[1], p[2] - a[2]]);
  const m = u.length;
  const G: number[][] = u.map((p) => u.map((q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  const rhs = u.map((p) => (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / 2);
  const t = solve(G, rhs);
  if (!t) return null;
  const x: [number, number, number] = [a[0], a[1], a[2]];
  for (let k = 0; k < m; k++) for (let e = 0; e < 3; e++) x[e] += t[k] * u[k][e];
  return { c: x, r2: (a[0] - x[0]) ** 2 + (a[1] - x[1]) ** 2 + (a[2] - x[2]) ** 2 };
}

/** Gaussian elimination with partial pivoting; null for a (nearly) singular matrix. */
function solve(A: number[][], y: number[]): number[] | null {
  const n = y.length;
  const M = A.map((row, i) => [...row, y[i]]);
  let scale = 0;
  for (const row of A) for (const v of row) scale = Math.max(scale, Math.abs(v));
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) <= 1e-11 * scale) return null;
    [M[i], M[p]] = [M[p], M[i]];
    for (let r = i + 1; r < n; r++) {
      const m = M[r][i] / M[i][i];
      for (let j = i; j <= n; j++) M[r][j] -= m * M[i][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let v = M[i][n];
    for (let j = i + 1; j < n; j++) v -= M[i][j] * x[j];
    x[i] = v / M[i][i];
  }
  return x;
}

const inside = (B: Ball, p: number[]) => (p[0] - B.c[0]) ** 2 + (p[1] - B.c[1]) ** 2 + (p[2] - B.c[2]) ** 2 <= B.r2 * (1 + 1e-12) + 1e-15;

/** Radius of the smallest ball holding the points (flat x, y, z), by Welzl's algorithm with move-to-front. */
export function enclosingOf(V: ArrayLike<number>): number {
  const pts: number[][] = [];
  for (let i = 0; i < V.length; i += 3) pts.push([V[i], V[i + 1], V[i + 2]]);
  // a fixed shuffle (a multiplicative walk), so that the run is reproducible and the recursion shallow
  const order = pts.map((_, i) => i).sort((i, j) => ((i * 2654435761) % 4294967296) - ((j * 2654435761) % 4294967296));
  const P = order.map((i) => pts[i]);
  const welzl = (n: number, R: number[][]): Ball => {
    let B = ballOn(R) ?? { c: [0, 0, 0] as [number, number, number], r2: -1 };
    if (R.length === 4) return B;
    for (let i = 0; i < n; i++) {
      if (B.r2 >= 0 && inside(B, P[i])) continue;
      const nb = welzl(i, [...R, P[i]]);
      B = nb;
    }
    return B;
  };
  const B = welzl(P.length, []);
  return Math.sqrt(B.r2);
}

const CHEB = new Map<string, number>();
const ENCL = new Map<string, number>();

/** The Chebyshev radius of the solid (about its best centre), as a valid upper bound; the inradius where the centroid is optimal. */
export function chebyshevRadius(S: Solid): number {
  let v = CHEB.get(S.name);
  if (v === undefined) {
    const r = chebyshevOf(S.N, S.offsets);
    v = r <= S.inradius * (1 + 1e-9) ? S.inradius : r * (1 + SAFETY);
    CHEB.set(S.name, v);
  }
  return v;
}

/** The radius of the smallest ball holding the solid, as a valid lower bound; the circumradius where the centroid is optimal. */
export function enclosingRadius(S: Solid): number {
  let v = ENCL.get(S.name);
  if (v === undefined) {
    const r = enclosingOf(S.V);
    v = r >= S.circumradius * (1 - 1e-9) ? S.circumradius : r * (1 - SAFETY);
    ENCL.set(S.name, v);
  }
  return v;
}
