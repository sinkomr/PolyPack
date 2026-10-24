import { Pose, boundingRadius, circumradius, inradius } from "./shapes";

/**
 * Tolerance in piece units (side length or radius 1).
 * Rule for "touching": two pieces overlap only when their separation is below -TOL.
 * A separation in [-TOL, TOL] is contact and is valid.
 */
export const TOL = 1e-9;

/**
 * Signed separation between shapes A and B.
 * sep > 0: disjoint (for polygons a lower bound on the true distance, exact for face contact).
 * sep < 0: overlapping, and -sep is the exact penetration depth.
 * (nx, ny) is the unit direction in which moving A increases sep fastest.
 */
export interface Contact {
  sep: number;
  nx: number;
  ny: number;
}

/**
 * Separating-axis test for two convex polygons given as flat counter-clockwise vertex arrays.
 * Reference implementation, O(|a| * |b|). Works for any convex polygons.
 */
export function polygonSeparation(a: Float64Array, b: Float64Array): Contact {
  let best = -Infinity;
  let nx = 1;
  let ny = 0;
  for (let pass = 0; pass < 2; pass++) {
    // pass 0 uses the edge normals of A, pass 1 those of B
    const p = pass === 0 ? a : b;
    const q = pass === 0 ? b : a;
    const np = p.length / 2;
    const nq = q.length / 2;
    for (let i = 0; i < np; i++) {
      const j = (i + 1) % np;
      const px = p[2 * i];
      const py = p[2 * i + 1];
      const ex = p[2 * j] - px;
      const ey = p[2 * j + 1] - py;
      const len = Math.hypot(ex, ey);
      // outward normal of a counter-clockwise edge
      const ux = ey / len;
      const uy = -ex / len;
      let m = Infinity;
      for (let k = 0; k < nq; k++) {
        const d = (q[2 * k] - px) * ux + (q[2 * k + 1] - py) * uy;
        if (d < m) m = d;
      }
      if (m > best) {
        best = m;
        // A's normal points from A toward B, so A retreats along -u; B's normal pushes A along +u
        const s = pass === 0 ? -1 : 1;
        nx = s * ux;
        ny = s * uy;
      }
    }
  }
  return { sep: best, nx, ny };
}

/** cos of the angular distance from `rel` to the nearest multiple of `step`. */
function cosToNearestVertex(rel: number, step: number): number {
  let t = rel % step;
  if (t < 0) t += step;
  if (t > step / 2) t = step - t;
  return Math.cos(t);
}

/**
 * Separating-axis test for two congruent regular N-gon pieces, O(N).
 *
 * Along an edge normal u of A, A reaches exactly its inradius. B reaches R cos(delta)
 * toward A, where delta is the angle between -u and B's nearest vertex direction
 * (the support function of a regular polygon). So the gap along u is
 *   (cB - cA) . u - inradius - R cos(delta).
 */
export function regularPolygonSeparation(N: number, a: Pose, b: Pose, scale = 1): Contact {
  const R = circumradius(N) * scale;
  const r = inradius(N) * scale;
  const step = (2 * Math.PI) / N;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let best = -Infinity;
  let nx = 1;
  let ny = 0;
  for (let k = 0; k < N; k++) {
    // edge normals bisect consecutive vertex directions
    const angA = a.theta + Math.PI / 2 + Math.PI / N + k * step;
    let ux = Math.cos(angA);
    let uy = Math.sin(angA);
    let sep = dx * ux + dy * uy - r - R * cosToNearestVertex(angA + Math.PI / 2 - b.theta, step);
    if (sep > best) {
      best = sep;
      nx = -ux;
      ny = -uy;
    }
    const angB = b.theta + Math.PI / 2 + Math.PI / N + k * step;
    ux = Math.cos(angB);
    uy = Math.sin(angB);
    sep = -(dx * ux + dy * uy) - r - R * cosToNearestVertex(angB + Math.PI / 2 - a.theta, step);
    if (sep > best) {
      best = sep;
      nx = ux;
      ny = uy;
    }
  }
  return { sep: best, nx, ny };
}

/** Fewest sides for which pairSeparation prunes the axes: below, the plain loop is as fast (measured 2026-10-21). */
const PRUNE_FROM_N = 12;
/** Largest |theta| for which the pruning's margin covers the rounding of the axis angles (see pairSeparation). */
const PRUNE_MAX_THETA = 1000;

/**
 * regularPolygonSeparation(N, a, b, scale).sep, the same double (up to the sign of a zero, which
 * findOverlaps never reports), from far fewer axes for many-sided pieces: about 2 instead of 2N for
 * pieces near contact.
 *
 * Why it is exact: each candidate gap is d.u - r - R cos(delta) with R cos(delta) >= r, so it is
 * at most |d| cos(alpha) - 2r, alpha being the angle between the axis and the line of centres. The
 * axes are visited outward from the one nearest that line, on both pieces; the axes s steps away
 * have alpha >= (s - 1/2) 2 pi / N. Once |d| cos((s - 1/2) 2 pi / N) - 2r is below the best gap
 * found by more than the margin, no axis left can reach it, and the maximum is the kernel's: the
 * same expressions, evaluated for a set of axes that holds every one attaining it. The margin,
 * 1e-11 (|d| + R), covers the rounding of the gaps (about 1e-15 (|d| + R)) and of the axis angles
 * (a few ulps of |theta| + 2 pi, below 4e-13 rad while |theta| <= PRUNE_MAX_THETA).
 */
export function pairSeparation(N: number, a: Pose, b: Pose, scale = 1): number {
  if (N === 0) return circleSeparation(a, b, scale).sep;
  if (N < PRUNE_FROM_N || !(Math.abs(a.theta) <= PRUNE_MAX_THETA && Math.abs(b.theta) <= PRUNE_MAX_THETA))
    return regularPolygonSeparation(N, a, b, scale).sep;
  const R = circumradius(N) * scale;
  const r = inradius(N) * scale;
  const step = (2 * Math.PI) / N;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // the candidate gaps of the edge normals k of A and of B, exactly as regularPolygonSeparation has them
  const gapA = (k: number) => {
    const angA = a.theta + Math.PI / 2 + Math.PI / N + k * step;
    return dx * Math.cos(angA) + dy * Math.sin(angA) - r - R * cosToNearestVertex(angA + Math.PI / 2 - b.theta, step);
  };
  const gapB = (k: number) => {
    const angB = b.theta + Math.PI / 2 + Math.PI / N + k * step;
    return (
      -(dx * Math.cos(angB) + dy * Math.sin(angB)) - r - R * cosToNearestVertex(angB + Math.PI / 2 - a.theta, step)
    );
  };
  const index = (k: number) => ((k % N) + N) % N;
  // the normal of A nearest the direction from A to B, and of B nearest the direction from B to A
  const towardB = Math.atan2(dy, dx);
  const kA = Math.round((towardB - (a.theta + Math.PI / 2 + Math.PI / N)) / step);
  const kB = Math.round((towardB + Math.PI - (b.theta + Math.PI / 2 + Math.PI / N)) / step);
  let best = Math.max(gapA(index(kA)), gapB(index(kB)));
  const dist = Math.hypot(dx, dy);
  const margin = 1e-11 * (dist + R);
  for (let s = 1; s <= N / 2; s++) {
    if (dist * Math.cos((s - 0.5) * step) - 2 * r < best - margin) break;
    best = Math.max(best, gapA(index(kA + s)), gapA(index(kA - s)), gapB(index(kB + s)), gapB(index(kB - s)));
  }
  return best;
}

/** Circle-circle separation from the centre distance. Exact in both signs. */
export function circleSeparation(a: Pose, b: Pose, scale = 1): Contact {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return { sep: -2 * scale, nx: 1, ny: 0 };
  return { sep: d - 2 * scale, nx: dx / d, ny: dy / d };
}

/** Separation between two congruent pieces (N = 0 for circles). */
export function pieceSeparation(N: number, a: Pose, b: Pose, scale = 1): Contact {
  return N === 0 ? circleSeparation(a, b, scale) : regularPolygonSeparation(N, a, b, scale);
}

/**
 * Separation between a convex polygon (flat counter-clockwise vertices) and a circle,
 * by the closest point of the polygon to the circle centre. Exact in both signs.
 * The normal is the direction in which moving the circle increases the separation.
 */
export function polygonCircleSeparation(poly: Float64Array, cx: number, cy: number, r: number): Contact {
  const n = poly.length / 2;
  let inside = -Infinity;
  let inx = 1;
  let iny = 0;
  let bestD2 = Infinity;
  let qx = 0;
  let qy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const px = poly[2 * i];
    const py = poly[2 * i + 1];
    const ex = poly[2 * j] - px;
    const ey = poly[2 * j + 1] - py;
    const len2 = ex * ex + ey * ey;
    const len = Math.sqrt(len2);
    const ux = ey / len;
    const uy = -ex / len;
    const signed = (cx - px) * ux + (cy - py) * uy;
    if (signed > inside) {
      inside = signed;
      inx = ux;
      iny = uy;
    }
    // closest point on this edge segment
    let t = ((cx - px) * ex + (cy - py) * ey) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const sx = px + t * ex;
    const sy = py + t * ey;
    const d2 = (cx - sx) * (cx - sx) + (cy - sy) * (cy - sy);
    if (d2 < bestD2) {
      bestD2 = d2;
      qx = sx;
      qy = sy;
    }
  }
  if (inside <= 0) {
    // centre inside the polygon: depth to the nearest edge plus the radius
    return { sep: inside - r, nx: inx, ny: iny };
  }
  const d = Math.sqrt(bestD2);
  return { sep: d - r, nx: (cx - qx) / d, ny: (cy - qy) / d };
}

export interface Overlap {
  i: number;
  j: number;
  /** negative; -sep is the penetration depth */
  sep: number;
}

/**
 * All overlapping pairs among congruent pieces.
 * Broad phase: uniform grid with cell size 2R, where R is the bounding radius. Two pieces
 * can only overlap when their centres are closer than 2R, so only the 3x3 block of
 * neighbouring cells needs the exact test, pairSeparation.
 * With `limit`, the search stops once that many pairs are found. Pieces that do not overlap
 * leave only a bounded number of neighbours in each cell, so the cost of a heavily overlapping
 * configuration (say every piece at one point) then stays near that of a valid one.
 */
export function findOverlaps(N: number, poses: readonly Pose[], tol = TOL, scale = 1, limit = Infinity): Overlap[] {
  const reach = 2 * boundingRadius(N) * scale;
  const reach2 = reach * reach;
  const OFFSET = 2 ** 25;
  const SPAN = 2 ** 26;
  const grid = new Map<number, number[]>();
  const out: Overlap[] = [];
  for (let i = 0; i < poses.length; i++) {
    const a = poses[i];
    const ix = Math.floor(a.x / reach);
    const iy = Math.floor(a.y / reach);
    for (let gx = ix - 1; gx <= ix + 1; gx++) {
      for (let gy = iy - 1; gy <= iy + 1; gy++) {
        const cell = grid.get((gx + OFFSET) * SPAN + (gy + OFFSET));
        if (!cell) continue;
        for (const j of cell) {
          const b = poses[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          if (dx * dx + dy * dy > reach2) continue;
          const sep = pairSeparation(N, a, b, scale);
          if (sep < -tol && out.push({ i: j, j: i, sep }) >= limit) return out;
        }
      }
    }
    const key = (ix + OFFSET) * SPAN + (iy + OFFSET);
    const cell = grid.get(key);
    if (cell) cell.push(i);
    else grid.set(key, [i]);
  }
  return out;
}
