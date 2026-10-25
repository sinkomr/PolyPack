/**
 * Facets of the convex hull of a full-dimensional point set in R^k, by gift wrapping (facet to
 * facet pivoting), for any k >= 1. Built for polytope vertex lists: every input point must be a
 * vertex of the hull (no point inside a face), and faces may have many vertices (the tesseract's
 * cells are cubes, not simplices).
 *
 * - Initial facet: start from the supporting hyperplane with normal e_0 and, while its contact set
 *   S spans less than a hyperplane, rotate the normal about aff(S) towards a direction w orthogonal
 *   to aff(S) and to the normal, until a new point is hit (the "pivot" below). Each pivot adds a
 *   point outside aff(S), so k - 1 pivots at most.
 * - Neighbours: the ridges of a facet F are the facets of F inside its own hyperplane (recursion in
 *   R^(k-1)). Rotating F's normal n about a ridge R towards R's outward in-facet normal w, the
 *   first points hit span the neighbouring facet across R.
 *
 * Pivot about an affine subspace A (contained in the current supporting hyperplane, normal n),
 * towards a unit w orthogonal to n and to A: for a point p off the hyperplane write
 * a = (p - r0).w and b = (p - r0).n < 0 (r0 in A). The normal n(t) = cos t n + sin t w keeps p on
 * the inner side, (p - r0).n(t) <= 0, exactly while t <= atan2(-b, a), a value in (0, pi). The
 * largest admissible t is the minimum over p, and the points that reach it join the contact set.
 */
import { dot, norm, orthonormalBasis, rejectFrom, sub, unit } from "./linalg";

export interface HullRidge {
  /** Point indices of the ridge. */
  ids: number[];
  /** Unit normal of the ridge inside the facet's hyperplane, pointing out of the facet. */
  w: number[];
  /** Index of the facet across the ridge. */
  neighbor: number;
}

export interface HullFacet {
  /** Point indices on the facet, ascending. */
  ids: number[];
  /** Outward unit normal; every point p has normal . p <= offset. */
  normal: number[];
  offset: number;
  ridges: HullRidge[];
}

function argmaxSet(pts: number[][], n: number[], tol: number): number[] {
  let best = -Infinity;
  for (const p of pts) best = Math.max(best, dot(p, n));
  const out: number[] = [];
  pts.forEach((p, i) => {
    if (dot(p, n) >= best - tol) out.push(i);
  });
  return out;
}

/** Orthonormal basis of the directions of aff(points[ids]). */
function affineBasis(pts: number[][], ids: number[], tol: number): number[][] {
  const p0 = pts[ids[0]];
  return orthonormalBasis(
    ids.slice(1).map((i) => sub(pts[i], p0)),
    tol,
  );
}

/** Rotates the supporting hyperplane (normal n through r0) about the contact set towards w; returns the new normal. */
function pivot(pts: number[][], members: Set<number>, n: number[], w: number[], r0: number[], tol: number): number[] {
  let best = Infinity;
  pts.forEach((p, i) => {
    if (members.has(i)) return;
    const d = sub(p, r0);
    const b = dot(d, n);
    if (b > -tol) return; // on the hyperplane: already a member up to rounding
    const t = Math.atan2(-b, dot(d, w));
    if (t < best) best = t;
  });
  if (!Number.isFinite(best)) throw new Error("convexHull: the points are not full-dimensional");
  const c = Math.cos(best);
  const s = Math.sin(best);
  return unit(n.map((x, i) => c * x + s * w[i]));
}

/** The contact set of the hyperplane (normal n through r0), and its normal refitted to those points. */
function contact(pts: number[][], n: number[], r0: number[], tol: number): { ids: number[]; normal: number[] } {
  const ids: number[] = [];
  pts.forEach((p, i) => {
    if (Math.abs(dot(sub(p, r0), n)) <= tol) ids.push(i);
  });
  // refit: the normal is orthogonal to aff(ids); remove the rounding drift of the pivot
  const B = affineBasis(pts, ids, tol);
  let m = rejectFrom(n, B);
  if (norm(m) < 0.5) m = n;
  return { ids, normal: unit(m) };
}

export function convexHull(points: number[][], tol = 1e-9): HullFacet[] {
  const k = points[0].length;
  const sc = Math.max(1, ...points.map((p) => Math.max(...p.map(Math.abs))));
  const eps = tol * sc;
  if (k === 1) {
    const xs = points.map((p) => p[0]);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    if (hi - lo <= eps) throw new Error("convexHull: the points are not full-dimensional");
    const loIds = xs.map((x, i) => (x <= lo + eps ? i : -1)).filter((i) => i >= 0);
    const hiIds = xs.map((x, i) => (x >= hi - eps ? i : -1)).filter((i) => i >= 0);
    return [
      { ids: loIds, normal: [-1], offset: -lo, ridges: [] },
      { ids: hiIds, normal: [1], offset: hi, ridges: [] },
    ];
  }

  // initial facet
  let n: number[] = Array.from({ length: k }, (_, i) => (i === 0 ? 1 : 0));
  let S = argmaxSet(points, n, eps);
  for (let guard = 0; ; guard++) {
    if (guard > k) throw new Error("convexHull: could not find an initial facet");
    const B = affineBasis(points, S, eps);
    if (B.length >= k - 1) break;
    // a direction orthogonal to n and to aff(S): the standard basis vector with the largest residual
    const ref = [n, ...B];
    const Bref = orthonormalBasis(ref, eps);
    let w: number[] = [];
    let wn = 0;
    for (let j = 0; j < k; j++) {
      const r = rejectFrom(
        Array.from({ length: k }, (_, i) => (i === j ? 1 : 0)),
        Bref,
      );
      const rn = norm(r);
      if (rn > wn) {
        wn = rn;
        w = r;
      }
    }
    w = unit(w);
    const r0 = points[S[0]];
    n = pivot(points, new Set(S), n, w, r0, eps);
    const c = contact(points, n, r0, eps);
    n = c.normal;
    S = c.ids;
  }

  const facets: HullFacet[] = [];
  const index = new Map<string, number>();
  const add = (ids: number[], normal: number[]): number => {
    const key = ids.join(",");
    const got = index.get(key);
    if (got !== undefined) return got;
    const f: HullFacet = { ids, normal, offset: dot(normal, points[ids[0]]), ridges: [] };
    index.set(key, facets.length);
    facets.push(f);
    return facets.length - 1;
  };
  add(S, n);
  for (let fi = 0; fi < facets.length; fi++) {
    const F = facets[fi];
    const members = new Set(F.ids);
    // the facet's points in an orthonormal basis of its hyperplane
    const basis = orthonormalBasis(
      Array.from({ length: k }, (_, j) => Array.from({ length: k }, (_, i) => (i === j ? 1 : 0))).map((e) => rejectFrom(e, [F.normal])),
      1e-6,
    ).slice(0, k - 1);
    const c0 = F.ids.map((i) => points[i]).reduce((a, p) => a.map((x, i) => x + p[i] / F.ids.length), new Array<number>(k).fill(0));
    const local = F.ids.map((i) => basis.map((b) => dot(sub(points[i], c0), b)));
    const sub_ = convexHull(local, tol);
    for (const r of sub_) {
      const ids = r.ids.map((j) => F.ids[j]).sort((a, b) => a - b);
      const w = unit(basis[0].map((_, i) => basis.reduce((acc, b, j) => acc + b[i] * r.normal[j], 0)));
      const r0 = points[ids[0]];
      const n2 = pivot(points, members, F.normal, w, r0, eps);
      const c = contact(points, n2, r0, eps);
      const nb = add(c.ids, c.normal);
      F.ridges.push({ ids, w, neighbor: nb });
    }
  }
  return facets;
}
