/**
 * What the methods kernel (kernel.ts) needs to know about the faces of a solid, in one place.
 *
 * The kernel works per face: each face is a convex polygon in its own frame (counter-clockwise, at
 * scale 1), with its area, the largest disk about its frame origin that it contains, and the solid's
 * vertex id at each of its corners. These come from the solid's own faces (solids.ts facePolygonOf:
 * the regular polygon's formulas on a regular face, the stored corners on the others), so the
 * Platonic solids get the numbers they always had. Everything else the kernel does goes through the
 * surface's chain, part and gluing code. Random points, chart unfolding and chart points work on any
 * convex faces whose frame origin lies inside them: a regular face's centre, and on a Catalan solid
 * the point where the insphere touches the face.
 */
import { type ChainNode, enumerateChains, inWedge } from "./chains";
import { surfaceBound as domainBound, surfaceBounds } from "./domain";
import { apply, applyDir, glue, inverse } from "./rigid";
import { canonicalize } from "./search/energy";
import { Solid, faceDepth, facePolygonOf } from "./solids";

export interface FaceShape {
  /** Corners in the face's frame at unit edge, counter-clockwise, flat [x0, y0, x1, y1, ...]. */
  poly: Float64Array;
  /** Solid vertex id of each corner. */
  ids: number[];
  /** Area at unit edge. */
  area: number;
  /** Radius of the largest disk about the frame origin inside the face, at unit edge. */
  inner: number;
  /** Outward unit normals and offsets of the edges: inside is n . p <= b. */
  nx: Float64Array;
  ny: Float64Array;
  b: Float64Array;
}

const cache = new WeakMap<Solid, FaceShape[]>();

/** The faces of a solid as convex polygons in their frames. */
export function faceShapes(solid: Solid): FaceShape[] {
  const hit = cache.get(solid);
  if (hit) return hit;
  const out = solid.faces.map((ids, f) => describe(facePolygonOf(solid, 1, f), [...ids]));
  cache.set(solid, out);
  return out;
}

function describe(poly: Float64Array, ids: number[]): FaceShape {
  const n = poly.length / 2;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const b = new Float64Array(n);
  let area = 0;
  let inner = Infinity;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const ex = poly[2 * j] - poly[2 * k];
    const ey = poly[2 * j + 1] - poly[2 * k + 1];
    const len = Math.hypot(ex, ey);
    // counter-clockwise polygon: the outward normal is the edge turned clockwise
    nx[k] = ey / len;
    ny[k] = -ex / len;
    b[k] = nx[k] * poly[2 * k] + ny[k] * poly[2 * k + 1];
    inner = Math.min(inner, b[k]);
    area += poly[2 * k] * poly[2 * j + 1] - poly[2 * j] * poly[2 * k + 1];
  }
  return { poly, ids, area: area / 2, inner, nx, ny, b };
}

/** Signed depth of (x, y) inside a face (positive inside), at scale 1. */
export function shapeDepth(f: FaceShape, x: number, y: number): number {
  let d = Infinity;
  for (let k = 0; k < f.b.length; k++) d = Math.min(d, f.b[k] - f.nx[k] * x - f.ny[k] * y);
  return d;
}

/**
 * Depth of a centre (x, y) inside face f at scale s, exactly as the validators compute it (the fold
 * check's rule 1, at tolerance 0 in a finish): solids.ts faceDepth.
 */
export function centreDepth(solid: Solid, f: number, s: number, x: number, y: number): number {
  return faceDepth(solid, s, f, x, y);
}

/**
 * The surface point of a chart: a pose (face, x, y, theta) at unit edge whose centre may lie
 * outside its face is developed along the straight segment from the face's frame origin to the
 * centre, crossing the edges it meets as the gluing unfolds them, and expressed in the face where
 * the segment ends (the angle turned with the frames). Inside the closed face it is the pose
 * itself; across one edge it is what canonicalize (search/energy.ts) gives. Unlike that edge-by-
 * edge rule, a straight segment never circles a vertex, so every chart point has a surface point
 * and the map is continuous except across the rays from the origin through the corners. The
 * frame origin must lie inside its face (see the head of this file).
 */
export function unfoldChart(solid: Solid, p: { face: number; x: number; y: number; theta: number }): { face: number; x: number; y: number; theta: number } {
  const faces = faceShapes(solid);
  if (shapeDepth(faces[p.face], p.x, p.y) >= 0) return p;
  // a chart point absurdly far away (no search moves a piece that far) gets the edge-by-edge rule, whose work is bounded
  if (!(Math.hypot(p.x, p.y) <= 1e3)) return canonicalize(solid, 1, p);
  let face = p.face;
  let ox = 0;
  let oy = 0;
  let dx = p.x;
  let dy = p.y;
  let theta = p.theta;
  let entry = -1;
  for (let step = 0; step < 100000; step++) {
    const F = faces[face];
    // where the segment o + tau d (0 <= tau <= 1) leaves the face
    let tau = Infinity;
    let k = -1;
    for (let j = 0; j < F.b.length; j++) {
      if (j === entry) continue;
      const nd = F.nx[j] * dx + F.ny[j] * dy;
      if (!(nd > 0)) continue;
      const t = (F.b[j] - F.nx[j] * ox - F.ny[j] * oy) / nd;
      if (t < tau) {
        tau = t;
        k = j;
      }
    }
    if (k < 0 || tau >= 1) return { face, x: ox + dx, y: oy + dy, theta };
    tau = Math.max(0, tau);
    // the gluing maps the neighbour's frame into this one; its inverse takes the crossing point there
    const g = glue(solid, 1, face, k);
    const T = inverse(g.T);
    const [ex, ey] = apply(T, ox + tau * dx, oy + tau * dy);
    const [rx, ry] = applyDir(T, (1 - tau) * dx, (1 - tau) * dy);
    ox = ex;
    oy = ey;
    dx = rx;
    dy = ry;
    theta += T.ang;
    face = g.face;
    entry = g.edge;
  }
  throw new Error("unfoldChart: the segment crossed too many faces");
}

/** What chartPoint needs of a chain: its last face, that face's frame in the anchor's, its wedge. */
type CentreChain = Pick<ChainNode, "face" | "toAnchor" | "wedge">;
const centreChainCache = new WeakMap<Solid, Map<number, CentreChain[]>>();
/**
 * Faces whose chains are kept per solid, the most recently used: [CALC] all 120 faces of the
 * disdyakis triacontahedron hold about 118 MB, one face's take about 3 ms to enumerate.
 */
const CENTRE_FACES_KEPT = 16;

/**
 * A distance from face f's origin within which every point of the surface lies. Dijkstra over the
 * faces: from one face's origin to a neighbour's, a path on the surface runs straight through
 * their shared edge when the developed segment crosses it, else through the edge's midpoint (both
 * pieces lie in their convex faces); a point of face g is within its farthest corner of g's origin.
 */
function centreReach(solid: Solid, f: number): number {
  const faces = faceShapes(solid);
  const far = faces.map((F) => {
    let r = 0;
    for (let k = 0; k < F.poly.length; k += 2) r = Math.max(r, Math.hypot(F.poly[k], F.poly[k + 1]));
    return r;
  });
  const dist = new Array<number>(solid.F).fill(Infinity);
  const done = new Array<boolean>(solid.F).fill(false);
  dist[f] = 0;
  for (;;) {
    let a = -1;
    for (let g = 0; g < solid.F; g++) if (!done[g] && dist[g] < Infinity && (a < 0 || dist[g] < dist[a])) a = g;
    if (a < 0) break;
    done[a] = true;
    const A = faces[a];
    solid.adj[a].forEach((e, k) => {
      // the neighbour's origin developed into a's frame, and the shared edge's corners p, q there
      const [bx, by] = apply(glue(solid, 1, a, k).T, 0, 0);
      const j = (k + 1) % (A.poly.length / 2);
      const [px, py, qx, qy] = [A.poly[2 * k], A.poly[2 * k + 1], A.poly[2 * j], A.poly[2 * j + 1]];
      // the segment from the origin to b crosses the edge when each separates the other's ends
      const byEdge = (x: number, y: number) => (qx - px) * (y - py) - (qy - py) * (x - px);
      const bySegment = (x: number, y: number) => bx * y - by * x;
      const straight = byEdge(0, 0) * byEdge(bx, by) <= 0 && bySegment(px, py) * bySegment(qx, qy) <= 0;
      const mx = (px + qx) / 2;
      const my = (py + qy) / 2;
      const w = straight ? Math.hypot(bx, by) : Math.hypot(mx, my) + Math.hypot(bx - mx, by - my);
      if (dist[a] + w < dist[e.face]) dist[e.face] = dist[a] + w;
    });
  }
  let reach = 0;
  for (let g = 0; g < solid.F; g++) reach = Math.max(reach, dist[g] + far[g]);
  return reach * (1 + 1e-9);
}

/** The chains from face f's origin that reach every point of the surface (computed when needed, a few faces kept). */
function centreChains(solid: Solid, f: number): CentreChain[] {
  let kept = centreChainCache.get(solid);
  if (!kept) {
    kept = new Map();
    centreChainCache.set(solid, kept);
  }
  const hit = kept.get(f);
  if (hit) {
    // most recent last
    kept.delete(f);
    kept.set(f, hit);
    return hit;
  }
  const out = enumerateChains(solid, 1, f, 0, 0, centreReach(solid, f)).map(({ face, toAnchor, wedge }) => ({ face, toAnchor, wedge }));
  kept.set(f, out);
  if (kept.size > CENTRE_FACES_KEPT) kept.delete(kept.keys().next().value as number);
  return out;
}

/**
 * The chart point of face f (unit edge) for the surface point (g, x, y): the developed end of a
 * shortest path from f's origin, so that unfoldChart takes it back to (g, x, y). Null only when
 * rounding puts the point outside every wedge of the face's chains.
 */
export function chartPoint(solid: Solid, f: number, g: number, x: number, y: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const node of centreChains(solid, f)) {
    if (node.face !== g) continue;
    const [u, v] = apply(node.toAnchor, x, y);
    if (!inWedge(node.wedge, 0, 0, u, v, 0)) continue;
    const d = Math.hypot(u, v);
    if (d < bestD) {
      bestD = d;
      best = [u, v];
    }
  }
  return best;
}

/** Surface area of the solid at scale 1. */
export function unitArea(solid: Solid): number {
  return faceShapes(solid).reduce((t, f) => t + f.area, 0);
}

/** The area bound on the scale (domain.ts surfaceBounds): P pieces of area a(N) fit only when P a(N) <= area(S). */
export function areaBound(solid: Solid, N: number, P: number): number {
  return surfaceBounds(solid.name, N, P).area;
}

/**
 * The problem's lower bound on s, the server's for every problem: domain.ts surfaceBound, which on
 * the Platonic solids is each record's bound.value to the last bit (the server checks a problem with
 * a record against its record's bound and one without against the domain's).
 */
export function surfaceBound(solid: Solid, N: number, P: number): number {
  return domainBound(solid.name, N, P).value;
}

/** A uniform random point of the surface at unit edge: a face by area, then a point of it by rejection. */
export function randomSurfacePoint(solid: Solid, rng: () => number): { face: number; x: number; y: number } {
  const faces = faceShapes(solid);
  const total = unitArea(solid);
  let r = rng() * total;
  let face = faces.length - 1;
  for (let f = 0; f < faces.length; f++) {
    r -= faces[f].area;
    if (r < 0) {
      face = f;
      break;
    }
  }
  const F = faces[face];
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let k = 0; k < F.poly.length; k += 2) {
    minx = Math.min(minx, F.poly[k]);
    maxx = Math.max(maxx, F.poly[k]);
    miny = Math.min(miny, F.poly[k + 1]);
    maxy = Math.max(maxy, F.poly[k + 1]);
  }
  for (;;) {
    const x = minx + rng() * (maxx - minx);
    const y = miny + rng() * (maxy - miny);
    if (shapeDepth(F, x, y) > 0) return { face, x, y };
  }
}

/** Centroid of a face's corners in 3D, for spreading pieces over the faces. */
export function faceCentre3D(solid: Solid, f: number): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  const ids = solid.faces[f];
  for (const id of ids) for (let t = 0; t < 3; t++) c[t] += solid.vertices[id][t] / ids.length;
  return c;
}
