/**
 * What the methods kernel (kernel.ts) needs to know about the faces of a solid, in one place.
 *
 * The kernel works per face: each face is a convex polygon in its own frame (counter-clockwise,
 * at unit edge), with its area, the largest disk about its frame origin that it contains, and
 * the solid's vertex id at each of its corners. Everything else the kernel does goes through the
 * surface's chain, part and gluing code. Today every face is the regular M-gon of solids.ts, so
 * these come from the Platonic frame formulas; when the solids gain arbitrary convex faces, only
 * `faceShapes`, `areaBound`, `onePieceBound` and `centreDepth` below need the per-face data
 * instead. The rest (random points, chart unfolding, chart points) works on any convex faces whose
 * frame origin lies inside them.
 */
import { type ChainNode, enumerateChains, inWedge } from "./chains";
import { apply, applyDir, glue, inverse } from "./rigid";
import { canonicalize } from "./search/energy";
import { Solid, facePolygon } from "./solids";
import { insideFaceDepth } from "./validate";

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

/** The faces of a solid as convex polygons in their frames. Platonic-only: the regular M-gon. */
export function faceShapes(solid: Solid): FaceShape[] {
  const hit = cache.get(solid);
  if (hit) return hit;
  const out = solid.faces.map((ids) => {
    const poly = facePolygon(solid.M, 1);
    return describe(poly, [...ids]);
  });
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

/** Signed depth of (x, y) inside a face (positive inside), at unit edge. */
export function faceDepth(f: FaceShape, x: number, y: number): number {
  let d = Infinity;
  for (let k = 0; k < f.b.length; k++) d = Math.min(d, f.b[k] - f.nx[k] * x - f.ny[k] * y);
  return d;
}

/**
 * Depth of a centre (x, y) inside face f at edge s, exactly as the fold validator computes it
 * (its rule 1, at tolerance 0 in a finish). Platonic-only: validate.ts's regular-face formula.
 */
export function centreDepth(solid: Solid, f: number, s: number, x: number, y: number): number {
  void f;
  return insideFaceDepth(solid.M, s, x, y);
}

/**
 * The surface point of a chart: a pose (face, x, y, theta) at unit edge whose centre may lie
 * outside its face is developed along the straight segment from the face's frame origin to the
 * centre, crossing the edges it meets as the gluing unfolds them, and expressed in the face where
 * the segment ends (the angle turned with the frames). Inside the closed face it is the pose
 * itself; across one edge it is what canonicalize (search/energy.ts) gives. Unlike that edge-by-
 * edge rule, a straight segment never circles a vertex, so every chart point has a surface point
 * and the map is continuous except across the rays from the origin through the corners. The
 * frame origin must lie inside its face (true for the regular faces' centres).
 */
export function unfoldChart(solid: Solid, p: { face: number; x: number; y: number; theta: number }): { face: number; x: number; y: number; theta: number } {
  const faces = faceShapes(solid);
  if (faceDepth(faces[p.face], p.x, p.y) >= 0) return p;
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

const centreChainCache = new WeakMap<Solid, ChainNode[][]>();

/**
 * For each face, the chains from its frame origin that reach every point of the surface. A point
 * q of face g is within (2 k + 1) R of the origin of face f, where k is the number of gluings
 * between f and g (dual-graph distance) and R the largest distance from a face's origin to its
 * corners: from origin to origin through a shared edge is at most 2 R, and q is within R of g's.
 */
function centreChains(solid: Solid): ChainNode[][] {
  const hit = centreChainCache.get(solid);
  if (hit) return hit;
  const faces = faceShapes(solid);
  let R = 0;
  for (const F of faces) for (let k = 0; k < F.poly.length; k += 2) R = Math.max(R, Math.hypot(F.poly[k], F.poly[k + 1]));
  const out = faces.map((_, f) => {
    // dual-graph eccentricity of f
    const dist = new Array<number>(solid.F).fill(-1);
    dist[f] = 0;
    const queue = [f];
    for (let q = 0; q < queue.length; q++)
      for (const e of solid.adj[queue[q]])
        if (dist[e.face] < 0) {
          dist[e.face] = dist[queue[q]] + 1;
          queue.push(e.face);
        }
    const k = Math.max(...dist);
    return enumerateChains(solid, 1, f, 0, 0, (2 * k + 1) * R * (1 + 1e-9));
  });
  centreChainCache.set(solid, out);
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
  for (const node of centreChains(solid)[f]) {
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

/** Surface area of the solid at unit edge. */
export function unitArea(solid: Solid): number {
  return faceShapes(solid).reduce((t, f) => t + f.area, 0);
}

/**
 * tan(pi / n) as the records' bounds were computed (Python's math.tan, python/surface/tables.py).
 * V8's Math.tan differs from it in the last bit for n = 5, 6 and 8, which moved the bound by an
 * ulp on 434 of the 2038 records, and the server compares sizes with the records' bound.
 */
const RECORD_TAN: Record<number, number> = {
  3: 1.7320508075688767,
  4: 0.9999999999999999,
  5: 0.7265425280053609,
  6: 0.5773502691896256,
  8: 0.4142135623730951,
};
const tanPi = (n: number) => RECORD_TAN[n] ?? Math.tan(Math.PI / n);

/**
 * The area bound on the edge: P pieces of area a(N) fit only when P a(N) <= area(S) =
 * F M s^2 / (4 tan(pi/M)). Platonic-only. The float operations are those of the records' bound
 * (python/surface/tables.py bounds), so that the kernel's bound is the one the server checks.
 */
export function areaBound(solid: Solid, N: number, P: number): number {
  const M = solid.M;
  const A = N === 0 ? Math.PI : N / (4 * tanPi(N));
  return Math.sqrt((P * A * 4 * tanPi(M)) / (solid.F * M));
}

/**
 * The one-piece bound (docs/spaces/SURFACE.md, 2.6): a piece's inscribed disk holds no cone
 * point, and every point of a regular face lies within the face's circumradius s / (2 sin(pi/M))
 * of a corner, so s >= 2 sin(pi/M) r_in. Platonic-only: for other faces the circumradius bound
 * is per face (the largest distance from a point of the face to its nearest corner).
 */
export function onePieceBound(solid: Solid, N: number): number {
  return 2 * Math.sin(Math.PI / solid.M) * (N === 0 ? 1 : 1 / (2 * tanPi(N)));
}

/** The problem's lower bound on s: the larger of the area and one-piece bounds, as the records state it. */
export function surfaceBound(solid: Solid, N: number, P: number): number {
  return Math.max(areaBound(solid, N, P), onePieceBound(solid, N));
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
    if (faceDepth(F, x, y) > 0) return { face, x, y };
  }
}

/** Centroid of a face's corners in 3D, for spreading pieces over the faces. */
export function faceCentre3D(solid: Solid, f: number): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  const ids = solid.faces[f];
  for (const id of ids) for (let t = 0; t < 3; t++) c[t] += solid.vertices[id][t] / ids.length;
  return c;
}
