import { boundingRadius, inradius, pieceVertices } from "@polypack/geometry";
import { ChainNode, Wedge, enumerateChains } from "./chains";
import { apply, inverse } from "./rigid";
import { Solid, faceApothem, frameVertex } from "./solids";

/** A piece on the surface: anchor face and (x, y, theta) in that face's frame. */
export interface SurfacePose {
  face: number;
  x: number;
  y: number;
  theta: number;
}

/** Half-planes nx x + ny y <= b with unit normals, as parallel arrays. */
export interface HalfPlanes {
  nx: Float64Array;
  ny: Float64Array;
  b: Float64Array;
}

/** A convex outline in the anchor frame: its corners and the half-planes of its sides, side k from corner k to k + 1. */
export interface Outline extends HalfPlanes {
  poly: Float64Array;
}

/** The part of one piece that lies on one face, in that face's own frame. */
export interface Part {
  piece: number;
  /** index of the chain node in the piece's chain list */
  chain: number;
  face: number;
  /** counter-clockwise flat array; empty when the part is empty */
  poly: Float64Array;
  /**
   * The half-planes the part was cut from, in this face's frame: the piece's sides, the rays of
   * its chain's wedge and the face's edges, from their exact normals. Every side of the part lies
   * on one of them (see partSeparation).
   */
  cuts: HalfPlanes;
  /** piece centre and angle mapped into this face's frame (the developed piece) */
  cx: number;
  cy: number;
  theta: number;
}

/** Disk approximation used only for drawing circle pieces. */
export const DISK_SIDES = 96;

/** Half-plane a.x <= b, as used by the clipper. */
interface HalfPlane {
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
 * The piece polygon of piecePolygon with the half-planes of its sides, written from their
 * angles: side k of an N-gon has its outward normal at theta + pi/2 + (k + 1/2) 2 pi / N and lies
 * at the inradius from the centre; side k of the disk's circumscribed polygon at (2 k + 1) pi /
 * DISK_SIDES and at the radius.
 */
export function pieceOutline(N: number, pose: SurfacePose, scale = 1): Outline {
  const poly = piecePolygon(N, pose, scale);
  const n = N === 0 ? DISK_SIDES : N;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const b = new Float64Array(n);
  const r = N === 0 ? scale : inradius(N) * scale;
  for (let k = 0; k < n; k++) {
    const a = N === 0 ? ((2 * k + 1) * Math.PI) / n : pose.theta + Math.PI / 2 + ((k + 0.5) * 2 * Math.PI) / n;
    nx[k] = Math.cos(a);
    ny[k] = Math.sin(a);
    b[k] = nx[k] * pose.x + ny[k] * pose.y + r;
  }
  return { poly, nx, ny, b };
}

/**
 * The half-planes of a face in its own frame at edge s: edge j (frame vertex j to j + 1) has its
 * outward normal at 2 pi (j + 1) / M - pi / 2 and lies at the apothem (validate.ts insideFaceDepth).
 */
export function faceCuts(solid: Solid, s: number): HalfPlanes {
  const M = solid.M;
  const nx = new Float64Array(M);
  const ny = new Float64Array(M);
  const b = new Float64Array(M).fill(faceApothem(M, s));
  for (let j = 0; j < M; j++) {
    const a = (2 * Math.PI * (j + 1)) / M - Math.PI / 2;
    nx[j] = Math.cos(a);
    ny[j] = Math.sin(a);
  }
  return { nx, ny, b };
}

/**
 * Parts of a piece on the faces, each in its face's own frame.
 * For a disk the polygon is the circumscribed DISK_SIDES-gon (drawing only; validation of disks
 * uses distances, see validate.ts).
 */
export function pieceParts(solid: Solid, s: number, N: number, pose: SurfacePose, piece: number, scale = 1, chains?: ChainNode[]): Part[] {
  const nodes = chains ?? pieceChains(solid, s, N, pose, scale);
  return developParts(solid, s, pieceOutline(N, pose, scale), pose, piece, nodes);
}

/**
 * Parts of a convex outline (anchor frame, star-shaped about the pose's centre) developed from the
 * pose's centre along `nodes`, each in its face's own frame: the outline cut by the chain's wedge
 * and by the unfolded face, mapped back. pieceParts is this for the piece's own outline.
 */
export function developParts(solid: Solid, s: number, outline: Outline, pose: SurfacePose, piece: number, nodes: ChainNode[]): Part[] {
  const base = outline.poly;
  const M = solid.M;
  const own = faceCuts(solid, s);
  const parts: Part[] = [];
  nodes.forEach((node, ci) => {
    let poly = base;
    if (node.wedge) for (const h of wedgeHalfPlanes(node.wedge, pose.x, pose.y)) poly = clipHalfPlane(poly, h);
    const face = new Float64Array(2 * M);
    for (let k = 0; k < M; k++) {
      const [x, y] = frameVertex(M, s, k);
      const [u, v] = apply(node.toAnchor, x, y);
      face[2 * k] = u;
      face[2 * k + 1] = v;
    }
    for (const h of polygonHalfPlanes(face)) {
      if (poly.length === 0) break;
      poly = clipHalfPlane(poly, h);
    }
    const back = inverse(node.toAnchor);
    const mapped = new Float64Array(poly.length);
    for (let i = 0; i < poly.length; i += 2) {
      const [u, v] = apply(back, poly[i], poly[i + 1]);
      mapped[i] = u;
      mapped[i + 1] = v;
    }
    const [cx, cy] = apply(back, pose.x, pose.y);
    const cuts = partCuts(node, outline, pose, own);
    parts.push({ piece, chain: ci, face: node.face, poly: mapped, cuts, cx, cy, theta: pose.theta + back.ang });
  });
  return parts;
}

/**
 * The half-planes a part on node's face was cut from, in that face's frame: the outline's sides
 * and the wedge's rays (anchor frame, mapped back) and the face's own edges.
 */
function partCuts(node: ChainNode, outline: Outline, pose: SurfacePose, face: HalfPlanes): HalfPlanes {
  const wedge = node.wedge ? wedgeHalfPlanes(node.wedge, pose.x, pose.y) : [];
  const no = outline.b.length;
  const n = no + wedge.length + face.b.length;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const b = new Float64Array(n);
  // the anchor frame point is p = R q + t for q in the face's frame, so a . p <= c reads (R^T a) . q <= c - a . t
  const T = node.toAnchor;
  const put = (k: number, ax: number, ay: number, c: number) => {
    nx[k] = T.c * ax + T.s * ay;
    ny[k] = -T.s * ax + T.c * ay;
    b[k] = c - (ax * T.tx + ay * T.ty);
  };
  for (let k = 0; k < no; k++) put(k, outline.nx[k], outline.ny[k], outline.b[k]);
  wedge.forEach((h, k) => put(no + k, h.ax, h.ay, h.b));
  nx.set(face.nx, no + wedge.length);
  ny.set(face.ny, no + wedge.length);
  b.set(face.b, no + wedge.length);
  return { nx, ny, b };
}

/** Largest gap of the corners q beyond one of the half-planes h (the separating-axis value of h's normals). */
function cutGap(h: HalfPlanes, q: Float64Array): number {
  let best = -Infinity;
  for (let k = 0; k < h.b.length; k++) {
    const nx = h.nx[k];
    const ny = h.ny[k];
    const c = h.b[k];
    let m = Infinity;
    for (let i = 0; i < q.length; i += 2) {
      const d = nx * q[i] + ny * q[i + 1] - c;
      if (d < m) m = d;
    }
    if (m > best) best = m;
  }
  return best;
}

/**
 * Separation of two parts on one face (negative: their penetration depth), by separating axes
 * taken from the half-planes each part was cut from rather than from its clipped sides.
 *
 * Clipping can leave a part a side about 1e-15 long whose direction rounding makes arbitrary; an
 * axis taken from it can cut a sliver off the part and so call two overlapping parts apart. Here
 * every axis is exact: every side of a part lies on one of its half-planes, so the axes include
 * every side's true normal. A half-plane that does not touch the part only gives a smaller gap
 * along its normal, and any positive gap separates the parts (the part lies in the half-plane),
 * so for overlapping parts the result is exactly minus the separating-axis depth. For parts that
 * are apart it is positive, a lower bound on their distance.
 */
export function partSeparation(a: { poly: Float64Array; cuts: HalfPlanes }, b: { poly: Float64Array; cuts: HalfPlanes }): number {
  return Math.max(cutGap(a.cuts, b.poly), cutGap(b.cuts, a.poly));
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
