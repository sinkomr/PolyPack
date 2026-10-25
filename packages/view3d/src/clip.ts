/**
 * Clipped solids for drawing. A piece's part in a cell is the placed piece cut by the cell's own
 * half-spaces and the part's clip half-spaces (PiecePart). This file turns one part into
 * triangles in the holding cell's local coordinates: the piece's own surface (smooth normals for a
 * ball, flat for a polytope), the cut faces where the part meets a cell face or a window plane, and
 * line segments that outline them. It is computed once per configuration, never per frame.
 *
 * Every solid here is convex, so clipping a polygon by a half-space keeps one convex polygon
 * (Sutherland-Hodgman), and the cut face of a convex solid by a plane is the convex polygon of the
 * points of the clipped solid that lie on that plane.
 */
import type { Affine, Cell, HalfSpace } from "@polypack/boundary";
import { type Vec3, det3, dot, normalize3, planeBasis, sub3 } from "./math";

/** The shape of a piece in its standard pose, as the engine's standardPiece returns it. */
export type PieceShape = { kind: "ball" } | { kind: "polytope"; vertices: number[][]; faces: number[][] };

/** A closed half-space n . y <= h of R^3 with unit n. */
export interface Plane {
  n: Vec3;
  h: number;
}

/** One part as triangles and outline segments, in its cell's local coordinates. */
export interface PartMesh {
  /** xyz per vertex, three vertices per triangle: the piece's own surface first, then the cut faces. */
  positions: Float32Array;
  normals: Float32Array;
  /** Number of vertices (not floats) of the piece's own surface; the rest belong to cut faces. */
  surfaceCount: number;
  /** Line segments, two xyz points each: polytope edges and the outlines of the cut faces. */
  lines: Float32Array;
}

export interface MeshOptions {
  /** Subdivisions of the icosahedron that approximates a ball (4 gives 5120 triangles). */
  sphereDetail?: number;
  /** Points on a full circle of a ball's cut face. */
  circleSegments?: number;
}

/**
 * Parts thinner than this (in unit-piece lengths) are not drawn. Float layouts sit a hair above
 * their contact values, so a piece that touches a cell face may cross it by 1e-7 or so: drawn, such
 * a part would be a flat plate on the face. The rest of the piece is drawn as usual.
 */
export const SLIVER = 1e-4;

/** The cell's half-spaces at edge s, as unit-normal planes. */
export function cellPlanes(cell: Cell, s: number): Plane[] {
  return cell.facets.map((f) => toPlane(f.inside, s));
}

/** A contract half-space as a unit-normal plane; k scales its offset (a cell's facets are at s = 1). */
export function toPlane(hs: HalfSpace, k = 1): Plane {
  const l = Math.hypot(hs.n[0], hs.n[1], hs.n[2]) || 1;
  return { n: [hs.n[0] / l, hs.n[1] / l, hs.n[2] / l], h: (hs.h * k) / l };
}

// ---------------------------------------------------------------------------------------------
// The unit sphere as an icosphere, cached per detail level: flat triangle list, CCW outward.

const sphereCache = new Map<number, Float64Array>();

export function icosphere(detail: number): Float64Array {
  const hit = sphereCache.get(detail);
  if (hit) return hit;
  const t = (1 + Math.sqrt(5)) / 2;
  const base: Vec3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((p) => normalize3(p));
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  let tris: Vec3[][] = faces.map((f) => f.map((i) => base[i]));
  for (let d = 0; d < detail; d++) {
    const next: Vec3[][] = [];
    for (const [a, b, c] of tris) {
      const ab = normalize3([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
      const bc = normalize3([(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2]);
      const ca = normalize3([(c[0] + a[0]) / 2, (c[1] + a[1]) / 2, (c[2] + a[2]) / 2]);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    tris = next;
  }
  const out = new Float64Array(tris.length * 9);
  tris.forEach((tri, i) => tri.forEach((p, j) => out.set(p, i * 9 + j * 3)));
  sphereCache.set(detail, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Convex polygon clipping (3D points on a common plane).

const EPS = 1e-12;

/** The part of a convex polygon with n . p <= h. */
export function clipPolygon(pts: Vec3[], pl: Plane): Vec3[] {
  const out: Vec3[] = [];
  const m = pts.length;
  if (m === 0) return out;
  let prev = pts[m - 1];
  let dp = dot(pl.n, prev) - pl.h;
  for (let i = 0; i < m; i++) {
    const cur = pts[i];
    const dc = dot(pl.n, cur) - pl.h;
    if (dc <= EPS) {
      if (dp > EPS) out.push(lerpAt(prev, cur, dp, dc));
      out.push(cur);
    } else if (dp <= EPS) {
      out.push(lerpAt(prev, cur, dp, dc));
    }
    prev = cur;
    dp = dc;
  }
  return out;
}

function lerpAt(a: Vec3, b: Vec3, da: number, db: number): Vec3 {
  const t = da / (da - db);
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}

/** Twice the area vector of a polygon (Newell): its direction is the CCW normal. */
export function newell(pts: Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

/** Points on a plane with normal n, deduplicated and ordered CCW about n (a convex polygon). */
export function orderOnPlane(points: Vec3[], n: Vec3, tol = 1e-9): Vec3[] {
  const uniq: Vec3[] = [];
  for (const p of points) {
    if (!uniq.some((q) => Math.abs(q[0] - p[0]) < tol && Math.abs(q[1] - p[1]) < tol && Math.abs(q[2] - p[2]) < tol)) {
      uniq.push(p);
    }
  }
  if (uniq.length < 3) return uniq;
  const c: Vec3 = [0, 0, 0];
  for (const p of uniq) {
    c[0] += p[0] / uniq.length;
    c[1] += p[1] / uniq.length;
    c[2] += p[2] / uniq.length;
  }
  const [u, v] = planeBasis(n);
  const ang = uniq.map((p) => {
    const d = sub3(p, c);
    return Math.atan2(dot(d, v), dot(d, u));
  });
  return uniq.map((p, i) => ({ p, a: ang[i] })).sort((x, y) => x.a - y.a).map((x) => x.p);
}

// ---------------------------------------------------------------------------------------------
// Polyhedra as face lists.

interface Face {
  pts: Vec3[];
  n: Vec3;
  cut: boolean;
}

function clipPolyhedron(faces: Face[], pl: Plane): Face[] {
  const out: Face[] = [];
  const on: Vec3[] = [];
  let hasFaceOnPlane = false;
  for (const f of faces) {
    const c = clipPolygon(f.pts, pl);
    if (c.length < 3) continue;
    out.push({ pts: c, n: f.n, cut: f.cut });
    let allOn = true;
    for (const p of c) {
      if (Math.abs(dot(pl.n, p) - pl.h) < 1e-9) on.push(p);
      else allOn = false;
    }
    // a face that already lies in the plane (a cube flush with a cell face) is its own cut face
    if (allOn && dot(f.n, pl.n) > 0.999) hasFaceOnPlane = true;
  }
  if (!hasFaceOnPlane && on.length >= 3) {
    const poly = orderOnPlane(on, pl.n);
    if (poly.length >= 3 && Math.hypot(...newell(poly)) > 1e-12) out.push({ pts: poly, n: pl.n, cut: true });
  }
  return out;
}

/** The faces of a placed polytope piece, each oriented CCW seen from outside. */
function placedPolytope(shape: { vertices: number[][]; faces: number[][] }, place: Affine): Face[] {
  const V = shape.vertices.map((v) => applyPlace(place, v));
  const c: Vec3 = [0, 0, 0];
  for (const p of V) for (let k = 0; k < 3; k++) c[k] += p[k] / V.length;
  return shape.faces.map((idx) => {
    let pts = idx.map((i) => V[i]);
    let n = newell(pts);
    const fc = pts.reduce<Vec3>((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0]);
    if (dot(n, sub3(fc, c)) < 0) {
      pts = pts.slice().reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    return { pts, n: normalize3(n), cut: false };
  });
}

function applyPlace(place: Affine, v: readonly number[]): Vec3 {
  const A = place.A;
  const b = place.b;
  return [
    A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2] + b[0],
    A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2] + b[1],
    A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2] + b[2],
  ];
}

// ---------------------------------------------------------------------------------------------
// Builders.

class Sink {
  pos: number[] = [];
  nor: number[] = [];
  lines: number[] = [];
  /** A convex polygon as a triangle fan, one normal for all its vertices. */
  fan(pts: Vec3[], n: Vec3) {
    for (let i = 1; i + 1 < pts.length; i++) {
      for (const p of [pts[0], pts[i], pts[i + 1]]) {
        this.pos.push(p[0], p[1], p[2]);
        this.nor.push(n[0], n[1], n[2]);
      }
    }
  }
  outline(pts: Vec3[]) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      this.lines.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }
  finish(surfaceFloats: number): PartMesh {
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nor),
      surfaceCount: surfaceFloats / 3,
      lines: Float32Array.from(this.lines),
    };
  }
}

/** Smallest width of the point set along the planes' normals and the axes: is the part a sliver? */
function thin(pts: number[], dirs: Vec3[]): boolean {
  for (const d of dirs) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const t = d[0] * pts[i] + d[1] * pts[i + 1] + d[2] * pts[i + 2];
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (hi - lo < SLIVER) return true;
  }
  return false;
}

/**
 * The part of a placed piece inside the planes, or null when nothing (or only a touching sliver)
 * of it is there.
 */
export function partMesh(shape: PieceShape, place: Affine, planes: Plane[], opts: MeshOptions = {}): PartMesh | null {
  return shape.kind === "ball" ? ballPart(place, planes, opts) : polytopePart(shape, place, planes);
}

function ballPart(place: Affine, planes: Plane[], opts: MeshOptions): PartMesh | null {
  const c = place.b as Vec3;
  // planes the unit ball reaches; a ball wholly beyond one plane has no part here
  const live: Plane[] = [];
  for (const pl of planes) {
    const d = dot(pl.n, c) - pl.h;
    if (d >= 1 - SLIVER) return null;
    if (d > -1) live.push(pl);
  }
  const sink = new Sink();
  const flip = det3(place.A) < 0;
  const S = icosphere(opts.sphereDetail ?? 4);
  const A = place.A;
  const tri: Vec3[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < S.length; i += 9) {
    for (let j = 0; j < 3; j++) {
      const o = i + 3 * (flip ? [0, 2, 1][j] : j);
      const x = S[o];
      const y = S[o + 1];
      const z = S[o + 2];
      tri[j] = [
        A[0][0] * x + A[0][1] * y + A[0][2] * z + c[0],
        A[1][0] * x + A[1][1] * y + A[1][2] * z + c[1],
        A[2][0] * x + A[2][1] * y + A[2][2] * z + c[2],
      ];
    }
    let poly: Vec3[] = tri;
    let clipped = false;
    for (const pl of live) {
      const d0 = dot(pl.n, poly[0]) - pl.h;
      const d1 = dot(pl.n, poly[1]) - pl.h;
      const d2 = dot(pl.n, poly[2]) - pl.h;
      if (poly.length === 3 && d0 <= 0 && d1 <= 0 && d2 <= 0) continue;
      poly = clipPolygon(poly, pl);
      clipped = true;
      if (poly.length < 3) break;
    }
    if (poly.length < 3) continue;
    if (!clipped) poly = tri.map((p) => p.slice() as Vec3);
    for (let k = 1; k + 1 < poly.length; k++) {
      for (const p of [poly[0], poly[k], poly[k + 1]]) {
        sink.pos.push(p[0], p[1], p[2]);
        const nx = p[0] - c[0];
        const ny = p[1] - c[1];
        const nz = p[2] - c[2];
        const l = Math.hypot(nx, ny, nz) || 1;
        sink.nor.push(nx / l, ny / l, nz / l);
      }
    }
  }
  if (sink.pos.length === 0 || thin(sink.pos, live.map((p) => p.n))) return null;
  const surface = sink.pos.length;
  // the cut faces: the plane's disk of the ball, cut by the other planes
  const K = opts.circleSegments ?? 96;
  live.forEach((pl, j) => {
    const d = dot(pl.n, c) - pl.h;
    if (Math.abs(d) >= 1) return;
    const r = Math.sqrt(1 - d * d);
    const q: Vec3 = [c[0] - d * pl.n[0], c[1] - d * pl.n[1], c[2] - d * pl.n[2]];
    const [u, v] = planeBasis(pl.n);
    let poly: Vec3[] = [];
    for (let k = 0; k < K; k++) {
      const a = (2 * Math.PI * k) / K;
      const cs = r * Math.cos(a);
      const sn = r * Math.sin(a);
      poly.push([q[0] + cs * u[0] + sn * v[0], q[1] + cs * u[1] + sn * v[1], q[2] + cs * u[2] + sn * v[2]]);
    }
    live.forEach((other, k) => {
      if (k !== j && poly.length >= 3) poly = clipPolygon(poly, other);
    });
    if (poly.length < 3 || Math.hypot(...newell(poly)) < 1e-12) return;
    sink.fan(poly, pl.n);
    sink.outline(poly);
  });
  return sink.finish(surface);
}

function polytopePart(shape: { vertices: number[][]; faces: number[][] }, place: Affine, planes: Plane[]): PartMesh | null {
  let faces = placedPolytope(shape, place);
  for (const pl of planes) {
    let beyond = false;
    let inside = true;
    for (const f of faces) {
      for (const p of f.pts) {
        const d = dot(pl.n, p) - pl.h;
        if (d > 1e-12) inside = false;
        else beyond = true;
      }
    }
    if (!beyond) return null;
    if (inside) continue;
    faces = clipPolyhedron(faces, pl);
    if (faces.length < 4) return null;
  }
  const all: number[] = [];
  for (const f of faces) for (const p of f.pts) all.push(p[0], p[1], p[2]);
  if (thin(all, [[1, 0, 0], [0, 1, 0], [0, 0, 1], ...planes.map((p) => p.n)])) return null;
  const sink = new Sink();
  for (const f of faces) if (!f.cut) sink.fan(f.pts, f.n);
  const surface = sink.pos.length;
  for (const f of faces) if (f.cut) sink.fan(f.pts, f.n);
  // every edge once: two faces share it
  const seen = new Set<string>();
  const key = (p: Vec3) => p.map((x) => x.toFixed(7)).join(",");
  for (const f of faces) {
    for (let i = 0; i < f.pts.length; i++) {
      const a = f.pts[i];
      const b = f.pts[(i + 1) % f.pts.length];
      const ka = key(a);
      const kb = key(b);
      const k = ka < kb ? ka + "|" + kb : kb + "|" + ka;
      if (ka === kb || seen.has(k)) continue;
      seen.add(k);
      sink.lines.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }
  return sink.finish(surface);
}

// ---------------------------------------------------------------------------------------------
// Cells.

/** A cell's faces at edge s: one convex polygon per facet, CCW seen from outside the cell. */
export function cellFaces(cell: Cell, s: number): { facet: number; pts: Vec3[]; n: Vec3 }[] {
  return cell.facets.map((f, i) => {
    const pl = toPlane(f.inside);
    const on = cell.vertices.filter((v) => Math.abs(dot(pl.n, v) - pl.h) < 1e-9).map((v) => [v[0] * s, v[1] * s, v[2] * s] as Vec3);
    return { facet: i, pts: orderOnPlane(on, pl.n), n: pl.n };
  });
}

/** A cell's edges at edge s, as segments. */
export function cellEdges(cell: Cell, s: number): Float32Array {
  const out = new Float32Array(cell.hinges.length * 6);
  cell.hinges.forEach(([a, b], i) => {
    const p = cell.vertices[a];
    const q = cell.vertices[b];
    out.set([p[0] * s, p[1] * s, p[2] * s, q[0] * s, q[1] * s, q[2] * s], i * 6);
  });
  return out;
}

/** Radius of the smallest origin-centred ball holding the cell at edge s. */
export function cellRadius(cell: Cell, s: number): number {
  return s * Math.max(...cell.vertices.map((v) => Math.hypot(v[0], v[1], v[2])));
}

