/**
 * Convex polyhedra in R^3 as lists of faces (convex polygons, counter-clockwise around their
 * outward unit normals): clipping by half-spaces, volume, thickness and the separating-axis
 * penetration depth. Used for the parts of polytope pieces.
 */
import { V3, cross3, dot3, norm3, sub3, unit3 } from "./linalg";

export interface Face {
  verts: V3[];
  /** Outward unit normal. */
  n: V3;
}

export interface Polyhedron {
  faces: Face[];
}

/** The polyhedron given by its vertices and faces (index lists, counter-clockwise seen from outside). */
export function polyhedronFrom(vertices: readonly V3[], faces: readonly number[][]): Polyhedron {
  return {
    faces: faces.map((f) => {
      const verts = f.map((i) => vertices[i]);
      return { verts, n: unit3(newell(verts)) };
    }),
  };
}

function newell(P: readonly V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

function samePoint(a: V3, b: V3, eps: number): boolean {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
}

function dedupe(P: V3[], eps: number): V3[] {
  const out: V3[] = [];
  for (const p of P) if (!out.length || !samePoint(out[out.length - 1], p, eps)) out.push(p);
  while (out.length > 1 && samePoint(out[0], out[out.length - 1], eps)) out.pop();
  return out;
}

/**
 * Clips a convex polyhedron to the half-space { x : n . x <= h } (n unit). Each face is clipped
 * (Sutherland–Hodgman, intersection points computed from the inside vertex to the outside one, so
 * that the two faces sharing an edge produce the same point), and the cut is closed by a cap face
 * with normal n. Vertices within eps of the plane count as on it. Returns an empty polyhedron when
 * nothing with interior remains.
 */
export function clipPolyhedron(P: Polyhedron, n: V3, h: number, eps = 1e-12): Polyhedron {
  let anyOut = false;
  let anyIn = false;
  for (const f of P.faces)
    for (const v of f.verts) {
      const d = dot3(n, v) - h;
      if (d > eps) anyOut = true;
      else if (d < -eps) anyIn = true;
    }
  if (!anyOut) return P;
  if (!anyIn) return { faces: [] };
  const faces: Face[] = [];
  const cap: V3[] = [];
  for (const f of P.faces) {
    const V = f.verts;
    const d = V.map((v) => dot3(n, v) - h);
    const out: V3[] = [];
    for (let i = 0; i < V.length; i++) {
      const j = (i + 1) % V.length;
      const ci = d[i] > eps ? 1 : d[i] < -eps ? -1 : 0;
      const cj = d[j] > eps ? 1 : d[j] < -eps ? -1 : 0;
      if (ci <= 0) {
        out.push(V[i]);
        if (ci === 0) cap.push(V[i]);
      }
      if (ci * cj < 0) {
        const [a, da, b, db] = ci < 0 ? [V[i], d[i], V[j], d[j]] : [V[j], d[j], V[i], d[i]];
        const t = da / (da - db);
        const p: V3 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
        out.push(p);
        cap.push(p);
      }
    }
    const poly = dedupe(out, eps);
    if (poly.length >= 3) faces.push({ verts: poly, n: f.n });
  }
  // the cap: distinct cut points, sorted counter-clockwise around n
  const pts: V3[] = [];
  for (const p of cap) if (!pts.some((q) => samePoint(p, q, 10 * eps))) pts.push(p);
  if (pts.length >= 3) {
    const c: V3 = [0, 0, 0];
    for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
    let e1 = sub3(pts[0], c);
    if (norm3(e1) < 1e-300) e1 = sub3(pts[1], c);
    e1 = unit3(sub3(e1, [n[0] * dot3(e1, n), n[1] * dot3(e1, n), n[2] * dot3(e1, n)]));
    const e2 = cross3(n, e1);
    const ang = (p: V3) => {
      const d = sub3(p, c);
      return Math.atan2(dot3(d, e2), dot3(d, e1));
    };
    pts.sort((a, b) => ang(a) - ang(b));
    faces.push({ verts: pts, n: [n[0], n[1], n[2]] });
  }
  if (faces.length < 4) return { faces: [] };
  return { faces };
}

/** Distinct vertices of a polyhedron. */
export function polyhedronVertices(P: Polyhedron, eps = 1e-12): V3[] {
  const out: V3[] = [];
  for (const f of P.faces) for (const v of f.verts) if (!out.some((q) => samePoint(v, q, eps))) out.push(v);
  return out;
}

/** Volume by the divergence theorem (faces fanned from their first vertex). */
export function polyhedronVolume(P: Polyhedron): number {
  let v = 0;
  for (const f of P.faces) {
    const V = f.verts;
    for (let i = 1; i + 1 < V.length; i++) v += dot3(V[0], cross3(V[i], V[i + 1]));
  }
  return v / 6;
}

/**
 * Smallest width of the polyhedron along its face normals. The minimal width of a convex body is
 * at most this, and any convex body overlaps it by at most its minimal width.
 */
export function polyhedronThickness(P: Polyhedron, verts = polyhedronVertices(P)): number {
  if (!P.faces.length) return 0;
  let best = Infinity;
  for (const f of P.faces) {
    const top = dot3(f.n, f.verts[0]);
    let lo = Infinity;
    for (const v of verts) lo = Math.min(lo, dot3(f.n, v));
    best = Math.min(best, top - lo);
  }
  return best;
}

/** The data the separating-axis test needs: vertices, face normals and edge directions (unit, up to sign). */
export interface SatShape {
  verts: V3[];
  normals: V3[];
  edges: V3[];
  lo: V3;
  hi: V3;
}

function addDirection(list: V3[], d: V3): void {
  for (const e of list) if (norm3(cross3(e, d)) < 1e-9) return;
  list.push(d);
}

export function satShape(P: Polyhedron): SatShape {
  const verts = polyhedronVertices(P);
  const normals: V3[] = [];
  const edges: V3[] = [];
  for (const f of P.faces) {
    addDirection(normals, f.n);
    for (let i = 0; i < f.verts.length; i++) {
      const e = sub3(f.verts[(i + 1) % f.verts.length], f.verts[i]);
      const L = norm3(e);
      if (L > 1e-12) addDirection(edges, [e[0] / L, e[1] / L, e[2] / L]);
    }
  }
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const v of verts)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k]);
      hi[k] = Math.max(hi[k], v[k]);
    }
  return { verts, normals, edges, lo, hi };
}

function project(V: readonly V3[], a: V3): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of V) {
    const x = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return [lo, hi];
}

/**
 * Penetration depth of two convex polyhedra: the smallest overlap of their projections over the
 * candidate axes (face normals of both, cross products of their edge directions). For convex
 * polyhedra this is the depth of the minimum translation that separates them; a value <= 0 means
 * they do not overlap (the axis separates them). Stops early, returning the current overlap, as
 * soon as it is <= `stopAt`.
 */
export function satDepth(A: SatShape, B: SatShape, stopAt = -Infinity): number {
  let depth = Infinity;
  const test = (a: V3): boolean => {
    const [la, ha] = project(A.verts, a);
    const [lb, hb] = project(B.verts, a);
    const ov = Math.min(ha, hb) - Math.max(la, lb);
    if (ov < depth) depth = ov;
    return depth <= stopAt;
  };
  // bounding boxes first: the coordinate axes are valid separating directions
  for (let k = 0; k < 3; k++) {
    const ov = Math.min(A.hi[k], B.hi[k]) - Math.max(A.lo[k], B.lo[k]);
    if (ov < depth) depth = ov;
    if (depth <= stopAt) return depth;
  }
  for (const n of A.normals) if (test(n)) return depth;
  for (const n of B.normals) if (test(n)) return depth;
  for (const ea of A.edges)
    for (const eb of B.edges) {
      const c = cross3(ea, eb);
      const L = norm3(c);
      if (L < 1e-9) continue;
      if (test([c[0] / L, c[1] / L, c[2] / L])) return depth;
    }
  return depth;
}
