import { boundingRadius, pieceVertices } from "@polypack/geometry";
import { ChainNode, Wedge, enumerateChains } from "./chains";
import { apply, inverse } from "./rigid";
import { Solid, faceVertex } from "./solids";

/** A piece on the surface: anchor face and (x, y, theta) in that face's frame. */
export interface SurfacePose {
  face: number;
  x: number;
  y: number;
  theta: number;
}

/** The part of one piece that lies on one face, in that face's own frame. */
export interface Part {
  piece: number;
  /** index of the chain node in the piece's chain list */
  chain: number;
  face: number;
  /** counter-clockwise flat array; empty when the part is empty */
  poly: Float64Array;
  /** piece centre and angle mapped into this face's frame (the developed piece) */
  cx: number;
  cy: number;
  theta: number;
  /**
   * The half-planes the part was cut from (piece sides, wedge rays, face edges), in this face's
   * frame. Each supports the part, so separations are measured along them (partSeparation), not
   * along the edges of the clipped polygon, whose near-zero edges have meaningless normals.
   */
  planes: HalfPlane[];
}

/** Disk approximation used only for drawing circle pieces. */
export const DISK_SIDES = 96;

/** Half-plane a.x <= b, as used by the clipper. */
export interface HalfPlane {
  ax: number;
  ay: number;
  b: number;
}

/** Sutherland–Hodgman clip of a convex polygon by one half-plane. */
export function clipHalfPlane(poly: Float64Array, h: HalfPlane): Float64Array {
  const n = poly.length / 2;
  if (n === 0) return poly;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const px = poly[2 * i];
    const py = poly[2 * i + 1];
    const qx = poly[2 * j];
    const qy = poly[2 * j + 1];
    const dp = h.ax * px + h.ay * py - h.b;
    const dq = h.ax * qx + h.ay * qy - h.b;
    if (dp <= 0) out.push(px, py);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push(px + t * (qx - px), py + t * (qy - py));
    }
  }
  return dedupe(out);
}

/**
 * Drops repeated consecutive vertices (a vertex on the clip line is emitted twice), so that no
 * edge has zero length: a zero-length edge has no normal and would break separating-axis tests.
 */
export function dedupe(out: number[]): Float64Array {
  const res: number[] = [];
  const same = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) <= 1e-15 * (1 + Math.abs(ax)) && Math.abs(ay - by) <= 1e-15 * (1 + Math.abs(ay));
  for (let i = 0; i < out.length; i += 2) {
    const n = res.length;
    if (n >= 2 && same(res[n - 2], res[n - 1], out[i], out[i + 1])) continue;
    res.push(out[i], out[i + 1]);
  }
  while (res.length >= 4 && same(res[0], res[1], res[res.length - 2], res[res.length - 1])) res.length -= 2;
  return new Float64Array(res.length >= 6 ? res : []);
}

/** Half-planes of the closed wedge with apex (cx, cy): cross(lo, p - c) >= 0 and cross(p - c, hi) >= 0. */
export function wedgeHalfPlanes(W: Wedge, cx: number, cy: number): HalfPlane[] {
  // cross(l, v) = lx vy - ly vx >= 0  <=>  (ly, -lx) . v <= 0
  const a1 = { ax: W.ly, ay: -W.lx, b: W.ly * cx - W.lx * cy };
  // cross(v, h) = vx hy - vy hx >= 0  <=>  (-hy, hx) . v <= 0
  const a2 = { ax: -W.hy, ay: W.hx, b: -W.hy * cx + W.hx * cy };
  return [a1, a2];
}

/** Half-planes of a counter-clockwise convex polygon (inside is to the left of every edge). */
export function polygonHalfPlanes(poly: Float64Array): HalfPlane[] {
  const n = poly.length / 2;
  const out: HalfPlane[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = poly[2 * j] - poly[2 * i];
    const ey = poly[2 * j + 1] - poly[2 * i + 1];
    // outward normal (ey, -ex)
    out.push({ ax: ey, ay: -ex, b: ey * poly[2 * i] - ex * poly[2 * i + 1] });
  }
  return out;
}

/** The piece polygon (disks approximated by DISK_SIDES sides, for drawing) in its anchor frame. */
export function piecePolygon(N: number, pose: SurfacePose, scale = 1): Float64Array {
  if (N === 0) {
    const out = new Float64Array(2 * DISK_SIDES);
    // circumscribed polygon so that the drawn part covers the disk
    const R = scale / Math.cos(Math.PI / DISK_SIDES);
    for (let k = 0; k < DISK_SIDES; k++) {
      const a = (2 * Math.PI * k) / DISK_SIDES;
      out[2 * k] = pose.x + R * Math.cos(a);
      out[2 * k + 1] = pose.y + R * Math.sin(a);
    }
    return out;
  }
  return pieceVertices(N, { x: pose.x, y: pose.y, theta: pose.theta }, scale);
}

/** Chains of a piece: every chain a ray of length <= scale * boundingRadius(N) from its centre can follow. */
export function pieceChains(solid: Solid, s: number, N: number, pose: SurfacePose, scale = 1, maxChains = Infinity): ChainNode[] {
  return enumerateChains(solid, s, pose.face, pose.x, pose.y, scale * boundingRadius(N), maxChains);
}

/**
 * Parts of a piece on the faces, each in its face's own frame.
 * For a disk the polygon is the circumscribed DISK_SIDES-gon (drawing only; validation of disks
 * uses distances, see validate.ts).
 */
export function pieceParts(solid: Solid, s: number, N: number, pose: SurfacePose, piece: number, scale = 1, chains?: ChainNode[]): Part[] {
  const nodes = chains ?? pieceChains(solid, s, N, pose, scale);
  const base = piecePolygon(N, pose, scale);
  const parts: Part[] = [];
  nodes.forEach((node, ci) => {
    let poly = base;
    if (node.wedge) for (const h of wedgeHalfPlanes(node.wedge, pose.x, pose.y)) poly = clipHalfPlane(poly, h);
    const M = solid.sides[node.face];
    const face = new Float64Array(2 * M);
    for (let k = 0; k < M; k++) {
      const [x, y] = faceVertex(solid, s, node.face, k);
      const [u, v] = apply(node.toAnchor, x, y);
      face[2 * k] = u;
      face[2 * k + 1] = v;
    }
    for (const h of polygonHalfPlanes(face)) {
      if (poly.length === 0) break;
      poly = clipHalfPlane(poly, h);
    }
    const back = inverse(node.toAnchor);
    // the defining half-planes in the face's frame: a.x <= b with x = back^-1 x' becomes
    // (R a).x' <= b + (R a).t for back: x -> R x + t
    const planes: HalfPlane[] = [];
    const cut = [...polygonHalfPlanes(base), ...(node.wedge ? wedgeHalfPlanes(node.wedge, pose.x, pose.y) : []), ...polygonHalfPlanes(face)];
    for (const h of cut) {
      const ax = back.c * h.ax - back.s * h.ay;
      const ay = back.s * h.ax + back.c * h.ay;
      planes.push({ ax, ay, b: h.b + ax * back.tx + ay * back.ty });
    }
    const mapped = new Float64Array(poly.length);
    for (let i = 0; i < poly.length; i += 2) {
      const [u, v] = apply(back, poly[i], poly[i + 1]);
      mapped[i] = u;
      mapped[i + 1] = v;
    }
    const [cx, cy] = apply(back, pose.x, pose.y);
    parts.push({ piece, chain: ci, face: node.face, poly: mapped, cx, cy, theta: pose.theta + back.ang, planes });
  });
  return parts;
}

export function polygonArea(poly: Float64Array): number {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
  }
  return a / 2;
}

/**
 * Signed separation of two convex parts (positive: the distance between them; negative: minus the
 * penetration depth), by the separating-axis theorem along the half-planes each part was cut from.
 * Every such line supports its part, and they include every edge line of the part, so the result is
 * the exact separation of the polygons; the clipped polygons' own edges are not used as axes, since
 * a near-zero edge left by clipping has a normal that need not support the part.
 */
export function partSeparation(A: { poly: Float64Array; planes: readonly HalfPlane[] }, B: { poly: Float64Array; planes: readonly HalfPlane[] }): number {
  let best = -Infinity;
  for (let pass = 0; pass < 2; pass++) {
    const planes = pass === 0 ? A.planes : B.planes;
    const q = pass === 0 ? B.poly : A.poly;
    for (const h of planes) {
      const len = Math.hypot(h.ax, h.ay);
      if (!(len > 0)) continue;
      let m = Infinity;
      for (let k = 0; k < q.length; k += 2) {
        const d = h.ax * q[k] + h.ay * q[k + 1] - h.b;
        if (d < m) m = d;
      }
      m /= len;
      if (m > best) best = m;
    }
  }
  return best;
}
