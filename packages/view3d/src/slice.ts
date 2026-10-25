/**
 * Slices of the boundary by a hyperplane x_k = t of R^4.
 *
 * In a cell, the hyperplane is the plane a . u = c of the cell's local coordinates, with
 * a_l = frame[l]_k and c = t - s origin_k (the cell's frame and origin in R^4). A cell parallel to
 * the hyperplane (a = 0) is either wholly in it or misses it. A part's cross-section is the placed
 * piece cut by that plane and by the part's half-spaces (the cell's own and its clip): a disk of
 * radius sqrt(1 - d^2) for a ball whose centre is at distance d from the plane, a convex polygon
 * for a polytope piece, both then clipped.
 *
 * Every function here writes into a SliceScratch: moving the slider allocates nothing.
 */
import type { Cell } from "@polypack/boundary";

/** Most points a section polygon may have. */
export const MAX_SECTION = 512;

export class SliceScratch {
  readonly a = new Float64Array(3 * MAX_SECTION);
  readonly b = new Float64Array(3 * MAX_SECTION);
  readonly ang = new Float64Array(MAX_SECTION);
  readonly idx = new Int32Array(MAX_SECTION);
  /** The buffer that holds the last result (a or b), xyz per point. */
  out: Float64Array = this.a;
}

/** The plane is a . u = c, with |a| = 1: [a0, a1, a2, c]. */
export type PlaneBuf = Float64Array;

export const SLICE_CUT = 0;
export const SLICE_MISS = 1;
export const SLICE_WHOLE = 2;

/**
 * Writes the hyperplane x_k = t, in the cell's local coordinates, into out (a . u = c, |a| = 1).
 * Returns SLICE_CUT, or SLICE_WHOLE when the whole cell lies in the hyperplane, or SLICE_MISS.
 */
export function slicePlane(cell: Cell, k: number, t: number, s: number, out: PlaneBuf): number {
  const a0 = cell.frame[0][k];
  const a1 = cell.frame[1][k];
  const a2 = cell.frame[2][k];
  const c = t - s * cell.origin[k];
  const l = Math.hypot(a0, a1, a2);
  if (l < 1e-9) return Math.abs(c) < 1e-9 * Math.max(1, s) ? SLICE_WHOLE : SLICE_MISS;
  out[0] = a0 / l;
  out[1] = a1 / l;
  out[2] = a2 / l;
  out[3] = c / l;
  return SLICE_CUT;
}

/** The section of the unit ball centred at q by the plane a . u = c: its radius, or -1 when they miss. */
export function ballSectionRadius(q: ArrayLike<number>, plane: ArrayLike<number>, r = 1): number {
  const d = plane[0] * q[0] + plane[1] * q[1] + plane[2] * q[2] - plane[3];
  if (Math.abs(d) >= r) return -1;
  return Math.sqrt(r * r - d * d);
}

/**
 * Clips the polygon in sc.out (count points) by the half-spaces n . u <= h listed in planes
 * ([nx, ny, nz, h] each). Returns the new count; the result is in sc.out.
 */
export function clipByPlanes(sc: SliceScratch, count: number, planes: Float64Array, nPlanes = planes.length / 4): number {
  for (let p = 0; p < nPlanes && count >= 3; p++) {
    const nx = planes[4 * p];
    const ny = planes[4 * p + 1];
    const nz = planes[4 * p + 2];
    const h = planes[4 * p + 3];
    const src = sc.out;
    const dst = src === sc.a ? sc.b : sc.a;
    let m = 0;
    let px = src[3 * (count - 1)];
    let py = src[3 * (count - 1) + 1];
    let pz = src[3 * (count - 1) + 2];
    let dp = nx * px + ny * py + nz * pz - h;
    for (let i = 0; i < count && m < MAX_SECTION - 1; i++) {
      const cx = src[3 * i];
      const cy = src[3 * i + 1];
      const cz = src[3 * i + 2];
      const dc = nx * cx + ny * cy + nz * cz - h;
      if ((dc <= 0) !== (dp <= 0)) {
        const t = dp / (dp - dc);
        dst[3 * m] = px + t * (cx - px);
        dst[3 * m + 1] = py + t * (cy - py);
        dst[3 * m + 2] = pz + t * (cz - pz);
        m++;
      }
      if (dc <= 0) {
        dst[3 * m] = cx;
        dst[3 * m + 1] = cy;
        dst[3 * m + 2] = cz;
        m++;
      }
      px = cx;
      py = cy;
      pz = cz;
      dp = dc;
    }
    sc.out = dst;
    count = m;
  }
  return count < 3 ? 0 : count;
}

/** u, v completing the plane normal a (unit) to a right-handed basis, into basis[0..5]. */
function planeBasisInto(a0: number, a1: number, a2: number, basis: Float64Array) {
  // u = normalize(e x a), e the axis least aligned with a
  let ux: number;
  let uy: number;
  let uz: number;
  if (Math.abs(a0) < 0.9) {
    ux = 0;
    uy = -a2;
    uz = a1;
  } else {
    ux = a2;
    uy = 0;
    uz = -a0;
  }
  const l = Math.hypot(ux, uy, uz);
  ux /= l;
  uy /= l;
  uz /= l;
  basis[0] = ux;
  basis[1] = uy;
  basis[2] = uz;
  basis[3] = a1 * uz - a2 * uy;
  basis[4] = a2 * ux - a0 * uz;
  basis[5] = a0 * uy - a1 * ux;
}

const BASIS = new Float64Array(6);

/**
 * The section of a unit ball (centre q, cell-local) by the plane, cut by the planes: a polygon of
 * `segments` points on the circle before clipping, CCW about a. Returns the point count (0: empty).
 */
export function ballSection(sc: SliceScratch, q: ArrayLike<number>, plane: PlaneBuf, planes: Float64Array, segments = 96, nPlanes?: number): number {
  const a0 = plane[0];
  const a1 = plane[1];
  const a2 = plane[2];
  const d = a0 * q[0] + a1 * q[1] + a2 * q[2] - plane[3];
  if (Math.abs(d) >= 1) return 0;
  const r = Math.sqrt(1 - d * d);
  const cx = q[0] - d * a0;
  const cy = q[1] - d * a1;
  const cz = q[2] - d * a2;
  planeBasisInto(a0, a1, a2, BASIS);
  const n = Math.min(segments, MAX_SECTION / 2);
  const out = sc.a;
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const cs = r * Math.cos(th);
    const sn = r * Math.sin(th);
    out[3 * i] = cx + cs * BASIS[0] + sn * BASIS[3];
    out[3 * i + 1] = cy + cs * BASIS[1] + sn * BASIS[4];
    out[3 * i + 2] = cz + cs * BASIS[2] + sn * BASIS[5];
  }
  sc.out = out;
  return clipByPlanes(sc, n, planes, nPlanes);
}

/**
 * The section of a convex polytope (vertices xyz, edges as index pairs) by the plane, cut by the
 * planes: its edges' crossings ordered CCW about a. Returns the point count (0: empty).
 */
export function polytopeSection(
  sc: SliceScratch,
  verts: ArrayLike<number>,
  edges: ArrayLike<number>,
  plane: PlaneBuf,
  planes: Float64Array,
  nPlanes?: number,
): number {
  const a0 = plane[0];
  const a1 = plane[1];
  const a2 = plane[2];
  const c = plane[3];
  const tmp = sc.b;
  let m = 0;
  const tol = 1e-12;
  for (let e = 0; e + 1 < edges.length; e += 2) {
    const i = edges[e];
    const j = edges[e + 1];
    const xi = verts[3 * i], yi = verts[3 * i + 1], zi = verts[3 * i + 2];
    const xj = verts[3 * j], yj = verts[3 * j + 1], zj = verts[3 * j + 2];
    const di = a0 * xi + a1 * yi + a2 * zi - c;
    const dj = a0 * xj + a1 * yj + a2 * zj - c;
    if (Math.abs(di) <= tol) m = pushUnique(tmp, m, xi, yi, zi);
    if (Math.abs(dj) <= tol) m = pushUnique(tmp, m, xj, yj, zj);
    if ((di < -tol && dj > tol) || (di > tol && dj < -tol)) {
      const t = di / (di - dj);
      m = pushUnique(tmp, m, xi + t * (xj - xi), yi + t * (yj - yi), zi + t * (zj - zi));
    }
  }
  if (m < 3) return 0;
  // order CCW about a: angles around the centroid in the plane basis
  let gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < m; i++) {
    gx += tmp[3 * i] / m;
    gy += tmp[3 * i + 1] / m;
    gz += tmp[3 * i + 2] / m;
  }
  planeBasisInto(a0, a1, a2, BASIS);
  for (let i = 0; i < m; i++) {
    const dx = tmp[3 * i] - gx, dy = tmp[3 * i + 1] - gy, dz = tmp[3 * i + 2] - gz;
    sc.ang[i] = Math.atan2(dx * BASIS[3] + dy * BASIS[4] + dz * BASIS[5], dx * BASIS[0] + dy * BASIS[1] + dz * BASIS[2]);
    sc.idx[i] = i;
  }
  // insertion sort: a handful of points
  for (let i = 1; i < m; i++) {
    const k = sc.idx[i];
    let j = i - 1;
    while (j >= 0 && sc.ang[sc.idx[j]] > sc.ang[k]) {
      sc.idx[j + 1] = sc.idx[j];
      j--;
    }
    sc.idx[j + 1] = k;
  }
  const out = sc.a;
  for (let i = 0; i < m; i++) {
    const k = sc.idx[i];
    out[3 * i] = tmp[3 * k];
    out[3 * i + 1] = tmp[3 * k + 1];
    out[3 * i + 2] = tmp[3 * k + 2];
  }
  sc.out = out;
  return clipByPlanes(sc, m, planes, nPlanes);
}

/** Appends a point unless it is already there; returns the new count. */
function pushUnique(buf: Float64Array, m: number, x: number, y: number, z: number): number {
  for (let i = 0; i < m; i++) {
    if (Math.abs(buf[3 * i] - x) < 1e-9 && Math.abs(buf[3 * i + 1] - y) < 1e-9 && Math.abs(buf[3 * i + 2] - z) < 1e-9) return m;
  }
  if (m >= MAX_SECTION) return m;
  buf[3 * m] = x;
  buf[3 * m + 1] = y;
  buf[3 * m + 2] = z;
  return m + 1;
}

/** Area of the planar polygon in sc.out (count points). */
export function polygonArea(buf: ArrayLike<number>, count: number): number {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = buf[3 * i], ay = buf[3 * i + 1], az = buf[3 * i + 2];
    const bx = buf[3 * j], by = buf[3 * j + 1], bz = buf[3 * j + 2];
    x += ay * bz - az * by;
    y += az * bx - ax * bz;
    z += ax * by - ay * bx;
  }
  return Math.hypot(x, y, z) / 2;
}

/** The cell's half-spaces at edge s, packed [nx, ny, nz, h] with unit n. */
export function packPlanes(planes: { n: number[]; h: number }[]): Float64Array {
  const out = new Float64Array(planes.length * 4);
  planes.forEach((p, i) => {
    const l = Math.hypot(p.n[0], p.n[1], p.n[2]) || 1;
    out[4 * i] = p.n[0] / l;
    out[4 * i + 1] = p.n[1] / l;
    out[4 * i + 2] = p.n[2] / l;
    out[4 * i + 3] = p.h / l;
  });
  return out;
}

/** The equally spaced slices of the strip: t from lo to hi, n of them, ends included. */
export function stripPositions(lo: number, hi: number, n = 9): number[] {
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}
