/**
 * The five Platonic solids as glued surfaces of regular polygons.
 *
 * Conventions (fixed; the Python certifier rebuilds them independently and the two must agree):
 * - Vertices are listed in a documented order (see `vertexList`), at unit edge length.
 * - A face is the cycle of its vertex ids, counter-clockwise seen from outside, rotated so that
 *   its smallest vertex id comes first. Faces are sorted lexicographically by these cycles.
 * - Face frame: face f is the regular M-gon of side s centred at the origin with a horizontal
 *   bottom edge (PolyPack's container convention with phi = 0). Frame vertex k sits at angle
 *   -pi/2 + pi/M + 2 pi k / M and is the 3D vertex faces[f][k]. Edge k runs from frame vertex k
 *   to frame vertex k + 1. Counter-clockwise in the frame is counter-clockwise from outside, so a
 *   frame is an orientation-preserving chart of the surface.
 * - The surface metric depends only on the gluing (which edge meets which); the 3D coordinates
 *   are used for the 3D view only.
 */

export type SolidName = "tetrahedron" | "cube" | "octahedron" | "dodecahedron" | "icosahedron";
export const SOLID_NAMES: readonly SolidName[] = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];

export interface EdgeRef {
  face: number;
  edge: number;
}

export interface Solid {
  name: SolidName;
  /** sides of every face */
  M: number;
  F: number;
  V: number;
  E: number;
  /** faces meeting at every vertex */
  degree: number;
  /** interior angle of a face, (M - 2) pi / M */
  faceAngle: number;
  /** total angle around a vertex: degree * faceAngle (< 2 pi) */
  coneAngle: number;
  /** unit-edge 3D coordinates, for drawing only */
  vertices: [number, number, number][];
  /** faces[f][k] = vertex id of frame vertex k */
  faces: number[][];
  /** adj[f][k] = the face and edge glued to edge k of face f */
  adj: EdgeRef[][];
}

const PHI = (1 + Math.sqrt(5)) / 2;

/** Vertex coordinates in the documented order, scaled to unit edge. */
export function vertexList(name: SolidName): [number, number, number][] {
  const scale = (pts: number[][], k: number) => pts.map((p) => [p[0] * k, p[1] * k, p[2] * k] as [number, number, number]);
  const cube = (h: number) => {
    // vertex i: x = +h when bit 0 is set, y when bit 1, z when bit 2
    const out: number[][] = [];
    for (let i = 0; i < 8; i++) out.push([i & 1 ? h : -h, i & 2 ? h : -h, i & 4 ? h : -h]);
    return out;
  };
  // the three cyclic patterns (0, ±a, ±b), (±a, ±b, 0), (±b, 0, ±a), signs in the order (+,+), (+,-), (-,+), (-,-)
  const cyclic = (a: number, b: number) => {
    const sg = [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    const out: number[][] = [];
    for (const [p, q] of sg) out.push([0, p * a, q * b]);
    for (const [p, q] of sg) out.push([p * a, q * b, 0]);
    for (const [p, q] of sg) out.push([q * b, 0, p * a]);
    return out;
  };
  switch (name) {
    case "tetrahedron":
      return scale(
        [
          [1, 1, 1],
          [1, -1, -1],
          [-1, 1, -1],
          [-1, -1, 1],
        ],
        1 / (2 * Math.SQRT2),
      );
    case "cube":
      return scale(cube(0.5), 1);
    case "octahedron":
      return scale(
        [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ],
        1 / Math.SQRT2,
      );
    case "icosahedron":
      return scale(cyclic(1, PHI), 0.5);
    case "dodecahedron":
      return scale([...cube(1), ...cyclic(1 / PHI, PHI)], PHI / 2);
  }
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Faces of the convex hull of `pts` (all points are hull vertices), canonically ordered. */
export function hullFaces(pts: V3[]): number[][] {
  const n = pts.length;
  const seen = new Set<string>();
  const faces: number[][] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        let nrm = cross3(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
        const len = Math.hypot(...nrm);
        if (len < 1e-9) continue;
        nrm = [nrm[0] / len, nrm[1] / len, nrm[2] / len];
        const d = dot(nrm, pts[i]);
        let pos = 0;
        let neg = 0;
        const on: number[] = [];
        for (let m = 0; m < n; m++) {
          const t = dot(nrm, pts[m]) - d;
          if (t > 1e-9) pos++;
          else if (t < -1e-9) neg++;
          else on.push(m);
        }
        if (pos && neg) continue;
        const key = on.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        // outward normal: the other vertices lie on the negative side
        if (pos) nrm = [-nrm[0], -nrm[1], -nrm[2]];
        faces.push(orderCcw(pts, on, nrm));
      }
  faces.sort((a, b) => {
    for (let t = 0; t < Math.min(a.length, b.length); t++) if (a[t] !== b[t]) return a[t] - b[t];
    return a.length - b.length;
  });
  return faces;
}

/** Counter-clockwise order about the outward normal, starting at the smallest id. */
function orderCcw(pts: V3[], ids: number[], nrm: V3): number[] {
  const c: V3 = [0, 0, 0];
  for (const id of ids) for (let t = 0; t < 3; t++) c[t] += pts[id][t] / ids.length;
  const e1 = sub(pts[ids[0]], c);
  const l1 = Math.hypot(...e1);
  const u: V3 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
  const w = cross3(nrm, u);
  const ang = (id: number) => {
    const d = sub(pts[id], c);
    return Math.atan2(dot(d, w), dot(d, u));
  };
  const sorted = [...ids].sort((a, b) => ang(a) - ang(b));
  const m = sorted.indexOf(Math.min(...sorted));
  return [...sorted.slice(m), ...sorted.slice(0, m)];
}

const cache = new Map<SolidName, Solid>();

export function getSolid(name: SolidName): Solid {
  const hit = cache.get(name);
  if (hit) return hit;
  const vertices = vertexList(name);
  const faces = hullFaces(vertices);
  const M = faces[0].length;
  const F = faces.length;
  const V = vertices.length;
  const E = (F * M) / 2;
  // edge k of face f runs from faces[f][k] to faces[f][k+1]; its neighbour holds the reverse edge
  const directed = new Map<string, EdgeRef>();
  faces.forEach((f, fi) => f.forEach((v, k) => directed.set(`${v}>${f[(k + 1) % M]}`, { face: fi, edge: k })));
  const adj = faces.map((f) =>
    f.map((v, k) => {
      const r = directed.get(`${f[(k + 1) % M]}>${v}`);
      if (!r) throw new Error(`${name}: unglued edge`);
      return r;
    }),
  );
  const degree = (F * M) / V;
  const faceAngle = ((M - 2) * Math.PI) / M;
  const solid: Solid = { name, M, F, V, E, degree, faceAngle, coneAngle: degree * faceAngle, vertices, faces, adj };
  cache.set(name, solid);
  return solid;
}

export function isSolidName(x: unknown): x is SolidName {
  return typeof x === "string" && (SOLID_NAMES as readonly string[]).includes(x);
}

/** Circumradius of the face polygon at edge s. */
export function faceCircumradius(M: number, s: number): number {
  return s / (2 * Math.sin(Math.PI / M));
}

/** Apothem of the face polygon at edge s. */
export function faceApothem(M: number, s: number): number {
  return s / (2 * Math.tan(Math.PI / M));
}

/** Frame vertex k of a face at edge s (angle -pi/2 + pi/M + 2 pi k / M). */
export function frameVertex(M: number, s: number, k: number): [number, number] {
  const R = faceCircumradius(M, s);
  const a = -Math.PI / 2 + Math.PI / M + (2 * Math.PI * (((k % M) + M) % M)) / M;
  return [R * Math.cos(a), R * Math.sin(a)];
}

/** Face polygon in its own frame as a flat counter-clockwise array. */
export function facePolygon(M: number, s: number): Float64Array {
  const out = new Float64Array(2 * M);
  for (let k = 0; k < M; k++) {
    const [x, y] = frameVertex(M, s, k);
    out[2 * k] = x;
    out[2 * k + 1] = y;
  }
  return out;
}

/** Surface area of the solid at edge s. */
export function surfaceArea(solid: Solid, s: number): number {
  return (solid.F * solid.M * s * s) / (4 * Math.tan(Math.PI / solid.M));
}

/**
 * 3D position of a point given in face f's frame (for drawing). The frame vertex k maps to the
 * 3D vertex faces[f][k]; the map is the similarity fixed by the face centre and frame vertex 0.
 */
export function faceTo3D(solid: Solid, s: number, f: number, x: number, y: number): [number, number, number] {
  const ids = solid.faces[f];
  const M = solid.M;
  const c: V3 = [0, 0, 0];
  for (const id of ids) for (let t = 0; t < 3; t++) c[t] += (solid.vertices[id][t] * s) / M;
  // 3D images of the frame axes, from two frame vertices
  const [x0, y0] = frameVertex(M, s, 0);
  const [x1, y1] = frameVertex(M, s, 1);
  const p0 = solid.vertices[ids[0]].map((v) => v * s) as V3;
  const p1 = solid.vertices[ids[1]].map((v) => v * s) as V3;
  // solve for ex, ey (3D vectors) with p - c = x ex + y ey at both vertices
  const det = x0 * y1 - x1 * y0;
  const d0 = sub(p0, c);
  const d1 = sub(p1, c);
  const ex: V3 = [0, 0, 0];
  const ey: V3 = [0, 0, 0];
  for (let t = 0; t < 3; t++) {
    ex[t] = (d0[t] * y1 - d1[t] * y0) / det;
    ey[t] = (x0 * d1[t] - x1 * d0[t]) / det;
  }
  return [c[0] + x * ex[0] + y * ey[0], c[1] + x * ex[1] + y * ey[1], c[2] + x * ex[2] + y * ey[2]];
}
