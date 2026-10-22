import { Container, Pose, circumradius, inradius, pieceVertices } from "./shapes";

/**
 * What an enclosing computation needs to know about an arrangement: the convex hull
 * of the piece vertices (polygon pieces, pad = 0) or of the piece centres
 * (circle pieces, pad = radius). `pts` is a flat [x0, y0, x1, y1, ...] array.
 */
export interface PointSet {
  pts: Float64Array;
  pad: number;
}

/** Convex hull by Andrew's monotone chain. Returns flat counter-clockwise points, collinear points dropped. */
export function convexHull(pts: Float64Array): Float64Array {
  const n = pts.length / 2;
  if (n <= 2) return pts.slice();
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => pts[2 * a] - pts[2 * b] || pts[2 * a + 1] - pts[2 * b + 1]);
  const hull = new Uint32Array(2 * n);
  let k = 0;
  const cross = (o: number, a: number, b: number) =>
    (pts[2 * a] - pts[2 * o]) * (pts[2 * b + 1] - pts[2 * o + 1]) -
    (pts[2 * a + 1] - pts[2 * o + 1]) * (pts[2 * b] - pts[2 * o]);
  for (let i = 0; i < n; i++) {
    while (k >= 2 && cross(hull[k - 2], hull[k - 1], idx[i]) <= 0) k--;
    hull[k++] = idx[i];
  }
  const lower = k + 1;
  for (let i = n - 2; i >= 0; i--) {
    while (k >= lower && cross(hull[k - 2], hull[k - 1], idx[i]) <= 0) k--;
    hull[k++] = idx[i];
  }
  k--; // the last point repeats the first
  const out = new Float64Array(2 * k);
  for (let i = 0; i < k; i++) {
    out[2 * i] = pts[2 * hull[i]];
    out[2 * i + 1] = pts[2 * hull[i] + 1];
  }
  return out;
}

/** Hull points and padding that determine every enclosing container of the arrangement. */
export function extremePoints(N: number, poses: readonly Pose[], scale = 1): PointSet {
  if (N === 0) {
    const c = new Float64Array(2 * poses.length);
    poses.forEach((p, i) => {
      c[2 * i] = p.x;
      c[2 * i + 1] = p.y;
    });
    return { pts: convexHull(c), pad: scale };
  }
  const all = new Float64Array(2 * N * poses.length);
  poses.forEach((p, i) => pieceVertices(N, p, scale, all.subarray(2 * N * i, 2 * N * (i + 1))));
  return { pts: convexHull(all), pad: 0 };
}

/** Support values h_j of the arrangement along the M outward edge normals of the container. */
function supports(set: PointSet, M: number, phi: number, h: Float64Array): void {
  const { pts, pad } = set;
  const step = (2 * Math.PI) / M;
  for (let j = 0; j < M; j++) {
    // normal j belongs to the edge ending at vertex j; j = 0 is the bottom edge at phi = 0
    const ang = phi - Math.PI / 2 + j * step;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    let m = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const d = pts[i] * ux + pts[i + 1] * uy;
      if (d > m) m = d;
    }
    h[j] = m + pad;
  }
}

const sineTables = new Map<number, Float64Array>();
function sineTable(M: number): Float64Array {
  let t = sineTables.get(M);
  if (!t) {
    t = new Float64Array(M + 1);
    for (let d = 0; d <= M; d++) t[d] = Math.sin((2 * Math.PI * d) / M);
    sineTables.set(M, t);
  }
  return t;
}

interface DualOptimum {
  a: number;
  i: number;
  j: number;
  /** -1 when the optimum is an antipodal pair */
  k: number;
}

/**
 * Exact solution of the enclosing LP
 *   minimise a  subject to  h_j <= a + c . u_j  for all j
 * through its dual
 *   maximise sum(lambda_j h_j)  subject to  sum(lambda_j u_j) = 0, sum(lambda_j) = 1, lambda >= 0.
 * A basic dual solution has at most three non-zero weights, so the optimum is the best of
 *   - antipodal pairs (M even): (h_i + h_j) / 2;
 *   - triples whose normals positively span the plane (every angular gap below pi). For such a
 *     triple lambda_i is proportional to cross(u_j, u_k), which for equally spaced normals is
 *     sin(2 pi d / M) with d the index gap between the other two.
 * Every candidate is dual feasible, so no feasibility check is needed and the maximum is a*.
 */
function solveDual(h: Float64Array, M: number): DualOptimum {
  const S = sineTable(M);
  let best: DualOptimum = { a: -Infinity, i: 0, j: 0, k: -1 };
  if (M % 2 === 0) {
    const half = M / 2;
    for (let i = 0; i < half; i++) {
      const a = (h[i] + h[i + half]) / 2;
      if (a > best.a) best = { a, i, j: i + half, k: -1 };
    }
  }
  let ta = -Infinity;
  let ti = 0;
  let tj = 0;
  let tk = 0;
  for (let i = 0; i < M - 2; i++) {
    for (let j = i + 1; j < M - 1; j++) {
      const d1 = j - i;
      if (2 * d1 >= M) break;
      for (let k = j + 1; k < M; k++) {
        const d2 = k - j;
        if (2 * d2 >= M) break;
        const d3 = M - k + i;
        if (2 * d3 >= M) continue;
        const a = (S[d2] * h[i] + S[d3] * h[j] + S[d1] * h[k]) / (S[d1] + S[d2] + S[d3]);
        if (a > ta) {
          ta = a;
          ti = i;
          tj = j;
          tk = k;
        }
      }
    }
  }
  // On a tie prefer the pair: its centre is found from all constraints, which is the robust path.
  if (ta > best.a) best = { a: ta, i: ti, j: tj, k: tk };
  return best;
}

/** Apothem of the smallest enclosing regular M-gon at orientation phi. */
function minApothem(set: PointSet, M: number, phi: number, h: Float64Array): number {
  supports(set, M, phi, h);
  return solveDual(h, M).a;
}

/** Smallest enclosing regular M-gon (M >= 3) at fixed orientation phi. */
export function enclosingPolygon(set: PointSet, M: number, phi: number): Container {
  if (set.pts.length === 0) return { M, cx: 0, cy: 0, phi, size: 0 };
  const h = new Float64Array(M);
  supports(set, M, phi, h);
  return polygonFromSupports(h, M, phi);
}

/** The smallest regular M-gon at orientation phi from the supports h along its edge normals. */
function polygonFromSupports(h: Float64Array, M: number, phi: number): Container {
  const { a, i, j, k } = solveDual(h, M);
  const step = (2 * Math.PI) / M;
  const ang = (n: number) => phi - Math.PI / 2 + n * step;
  const uix = Math.cos(ang(i));
  const uiy = Math.sin(ang(i));
  const bi = h[i] - a;
  let cx: number;
  let cy: number;
  if (k >= 0) {
    // Three active constraints fix the centre; solve the two equations c . u = h - a for i and j.
    const ujx = Math.cos(ang(j));
    const ujy = Math.sin(ang(j));
    const bj = h[j] - a;
    const det = uix * ujy - uiy * ujx;
    cx = (bi * ujy - bj * uiy) / det;
    cy = (uix * bj - ujx * bi) / det;
  } else {
    // Two opposite edges are tight, so the centre lies on the line c = bi u_i + t w with w
    // perpendicular to u_i. The other constraints bound t to an interval; take its midpoint.
    const wx = -uiy;
    const wy = uix;
    let lo = -Infinity;
    let hi = Infinity;
    for (let n = 0; n < M; n++) {
      if (n === i || n === j) continue;
      const ux = Math.cos(ang(n));
      const uy = Math.sin(ang(n));
      const g = wx * ux + wy * uy;
      const rhs = h[n] - a - bi * (uix * ux + uiy * uy);
      if (g > 1e-12) lo = Math.max(lo, rhs / g);
      else if (g < -1e-12) hi = Math.min(hi, rhs / g);
    }
    const t = (lo + hi) / 2;
    cx = bi * uix + t * wx;
    cy = bi * uiy + t * wy;
  }
  return { M, cx, cy, phi, size: 2 * a * Math.tan(Math.PI / M) };
}

/** Deterministic shuffle, so that client and server visit points in the same order. */
function shuffledOrder(n: number): Uint32Array {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  let seed = 0x9e3779b9;
  for (let i = n - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

/** Smallest enclosing circle of the arrangement (Welzl's algorithm, iterative form). */
export function enclosingCircle(set: PointSet): Container {
  const { pts, pad } = set;
  const n = pts.length / 2;
  if (n === 0) return { M: 0, cx: 0, cy: 0, phi: 0, size: 0 };
  const o = shuffledOrder(n);
  const X = (i: number) => pts[2 * o[i]];
  const Y = (i: number) => pts[2 * o[i] + 1];
  let cx = X(0);
  let cy = Y(0);
  let r = 0;
  // relative slack so that points on the boundary do not retrigger a rebuild
  const outside = (i: number) => Math.hypot(X(i) - cx, Y(i) - cy) > r * (1 + 1e-13) + 1e-15;
  const from2 = (i: number, j: number) => {
    cx = (X(i) + X(j)) / 2;
    cy = (Y(i) + Y(j)) / 2;
    r = Math.hypot(X(i) - X(j), Y(i) - Y(j)) / 2;
  };
  const from3 = (i: number, j: number, k: number) => {
    const bx = X(j) - X(i);
    const by = Y(j) - Y(i);
    const dx = X(k) - X(i);
    const dy = Y(k) - Y(i);
    const det = 2 * (bx * dy - by * dx);
    if (Math.abs(det) < 1e-300) return; // collinear: the two-point circle already covers them
    const b2 = bx * bx + by * by;
    const d2 = dx * dx + dy * dy;
    const ux = (dy * b2 - by * d2) / det;
    const uy = (bx * d2 - dx * b2) / det;
    cx = X(i) + ux;
    cy = Y(i) + uy;
    r = Math.hypot(ux, uy);
  };
  for (let i = 1; i < n; i++) {
    if (!outside(i)) continue;
    cx = X(i);
    cy = Y(i);
    r = 0;
    for (let j = 0; j < i; j++) {
      if (!outside(j)) continue;
      from2(i, j);
      for (let k = 0; k < j; k++) {
        if (outside(k)) from3(i, j, k);
      }
    }
  }
  return { M: 0, cx, cy, phi: 0, size: r + pad };
}

/** Smallest enclosing container of shape M at orientation phi (phi is ignored for circles). */
export function encloseSet(set: PointSet, M: number, phi: number): Container {
  return M === 0 ? enclosingCircle(set) : enclosingPolygon(set, M, phi);
}

/** Unit roundoff of a double. */
const EPS = 2 ** -53;
/** Most candidate pieces along one normal before candidateSupports leaves the support to the hull. */
const MAX_CANDIDATES = 8;

/**
 * The supports h_j that `supports` finds on the hull of all the vertices, the same doubles, found
 * from the vertices of a few pieces, without the hull; false (h unusable) when that cannot be
 * vouched for. Polygon pieces (N >= 3) and container (M >= 3) only.
 *
 * Candidates: along a normal u, a piece reaches at most c.u + R and at least c.u + r, so only the
 * pieces whose centre lies within R - r of the highest centre can attain the support; a margin
 * of 1e-12 C, C bounding every vertex coordinate, covers rounding. Their vertices are computed
 * exactly as extremePoints computes them, and h_j is the largest x ux + y uy among them.
 *
 * Why it is the kernel's value: that largest vertex q must also lie on the kernel's hull, whose
 * points `supports` takes the largest of. The monotone chain drops q only when a cross product
 * (q - o) x (b - o) rounds to <= 0, with o before q and b after it in the sort (by x); the exact
 * cross product is then below 3.02 eps (|A_x B_y| + |A_y B_x|), A = q - o, B = b - o, in the pass
 * that keeps the points extreme along u (the lower one when u_y < 0). If every other vertex is
 * lower along u by T, the segment ob passes q by T along u at q's abscissa, which makes the exact
 * cross product at least T |B_x| / |u_y|, while |A_x B_y| + |A_y B_x| <= 2 D |B_x| (D the diameter,
 * below 2.9 C): so T > 17.1 eps C keeps q. (With u_y = 0, q is the first or the last point of the
 * sort, which is never dropped.) The check below asks the largest value to beat the second by
 * 64 eps C, which leaves 8 eps C for the rounding of the dot products and still more than a factor
 * of 3; the vertices of other pieces are lower by at least the margin. When the check fails (two
 * vertices level with the support, as when an edge lies along a container side exactly), the hull
 * decides.
 */
function candidateSupports(N: number, poses: readonly Pose[], M: number, phi: number, h: Float64Array): boolean {
  const R = circumradius(N);
  const r = inradius(N);
  let maxAbs = 0;
  for (const p of poses) maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
  const C = maxAbs + R;
  const reach = R - r + 1e-12 * C;
  const tie = 64 * EPS * C;
  const step = (2 * Math.PI) / M;
  const vertices = new Map<number, Float64Array>();
  for (let j = 0; j < M; j++) {
    // the normal exactly as `supports` computes it
    const ang = phi - Math.PI / 2 + j * step;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    let top = -Infinity;
    for (const p of poses) {
      const d = p.x * ux + p.y * uy;
      if (d > top) top = d;
    }
    // Many pieces level with the highest (a row along a container side) nearly always tie: the
    // hull decides at once, before their vertices are computed for nothing.
    let count = 0;
    for (const p of poses) if (p.x * ux + p.y * uy >= top - reach && ++count > MAX_CANDIDATES) return false;
    let first = -Infinity;
    let second = -Infinity;
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i];
      if (p.x * ux + p.y * uy < top - reach) continue;
      let v = vertices.get(i);
      if (!v) vertices.set(i, (v = pieceVertices(N, p, 1, new Float64Array(2 * N))));
      for (let k = 0; k < v.length; k += 2) {
        const d = v[k] * ux + v[k + 1] * uy;
        if (d > first) {
          second = first;
          first = d;
        } else if (d > second) second = d;
      }
    }
    if (!(first - second > tie)) return false;
    // + 0 as `supports` adds its pad, which also makes a support of -0 the kernel's +0
    h[j] = first + 0;
  }
  return true;
}

/**
 * Smallest enclosing container of N-gon (or circle) pieces at the given poses. For polygon pieces
 * in a polygon container the supports come from a few candidate pieces (candidateSupports), the
 * same doubles as from the hull of all N P vertices at a small part of the cost; the hull is built
 * only when they cannot be vouched for.
 */
export function enclose(N: number, poses: readonly Pose[], M: number, phi: number): Container {
  if (N >= 3 && M >= 3 && poses.length > 0) {
    const h = new Float64Array(M);
    if (candidateSupports(N, poses, M, phi, h)) return polygonFromSupports(h, M, phi);
  }
  return encloseSet(extremePoints(N, poses), M, phi);
}

const GOLD = (Math.sqrt(5) - 1) / 2;

/**
 * Container orientation that minimises the size, searched over one period [0, 2 pi / M).
 *
 * Method: s(phi) is continuous, piecewise smooth and not convex. Its breakpoints come from a
 * change of supporting hull vertex (about H in total over one period, H = hull size) or a
 * change of active edges (order M). So:
 *   1. sample uniformly at about 4 (H + M) points, at least 256;
 *   2. take the lowest local minima of the samples (up to 8);
 *   3. refine each by golden-section search between its two neighbours.
 * phi0 (the current orientation) and phi = 0 are always candidates, so the result is never
 * worse than either. This is a search and not a proof of the global minimum over phi.
 * For large M the sample count is capped to bound the cost.
 */
export function autoOrientSet(set: PointSet, M: number, phi0 = 0): Container {
  if (M === 0 || set.pts.length === 0) return encloseSet(set, M, 0);
  const period = (2 * Math.PI) / M;
  const h = new Float64Array(M);
  const f = (phi: number) => minApothem(set, M, phi, h);
  const wrap = (phi: number) => ((phi % period) + period) % period;

  const triples = (M * (M - 1) * (M - 2)) / 6;
  const want = Math.max(256, 4 * (set.pts.length / 2 + M));
  const n = Math.max(256, Math.min(want, 2048, Math.floor(5e7 / triples)));
  const dphi = period / n;
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) vals[i] = f(i * dphi);

  const minima: number[] = [];
  for (let i = 0; i < n; i++) {
    if (vals[i] <= vals[(i + n - 1) % n] && vals[i] <= vals[(i + 1) % n]) minima.push(i);
  }
  minima.sort((p, q) => vals[p] - vals[q]);

  let bestPhi = wrap(phi0);
  let bestVal = f(bestPhi);
  const consider = (phi: number, val: number) => {
    if (val < bestVal) {
      bestVal = val;
      bestPhi = wrap(phi);
    }
  };
  consider(0, vals[0]);
  for (const i of minima.slice(0, 8)) {
    let lo = (i - 1) * dphi;
    let hi = (i + 1) * dphi;
    let x1 = hi - GOLD * (hi - lo);
    let x2 = lo + GOLD * (hi - lo);
    let f1 = f(x1);
    let f2 = f(x2);
    while (hi - lo > 1e-13) {
      if (f1 < f2) {
        hi = x2;
        x2 = x1;
        f2 = f1;
        x1 = hi - GOLD * (hi - lo);
        f1 = f(x1);
      } else {
        lo = x1;
        x1 = x2;
        f1 = f2;
        x2 = lo + GOLD * (hi - lo);
        f2 = f(x2);
      }
    }
    consider(i * dphi, vals[i]);
    const mid = (lo + hi) / 2;
    consider(mid, f(mid));
  }
  // The search compares apothems; the side length is computed afterwards and can round one step
  // differently, so the guaranteed candidates are compared again on the returned size.
  let result = enclosingPolygon(set, M, bestPhi);
  for (const phi of [wrap(phi0), 0]) {
    const c = enclosingPolygon(set, M, phi);
    if (c.size < result.size) result = c;
  }
  return result;
}

/** Auto-orient for pieces given as poses. */
export function autoOrient(N: number, poses: readonly Pose[], M: number, phi0 = 0): Container {
  return autoOrientSet(extremePoints(N, poses), M, phi0);
}
