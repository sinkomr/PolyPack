/**
 * Convex 4-polytopes as boundary spaces: cells (facets), their local frames, ridges, gluings and
 * hinges, built from a vertex list.
 *
 * Conventions (deterministic for every polytope, and equal to the research prototype's tess.py for
 * the tesseract, so its configurations import unchanged):
 * - Cells are the facets of the convex hull, sorted by their outward unit normal n with
 *   `compareNormals`: first by the index k of the largest |n_k| (the first one on ties within
 *   1e-9), then by the sign of n_k (negative first), then lexicographically. For the tesseract
 *   [-1/2, 1/2]^4 the cell x_i = sigma/2 gets id 2 i + (sigma > 0), as in tess.py.
 * - A cell's origin is the centroid of its vertices (its centre for a regular cell).
 * - A cell's frame is Gram–Schmidt applied to the standard basis vectors e_0, ..., e_3 projected
 *   onto the cell's hyperplane, in that order, skipping the one that is (nearly) parallel to the
 *   normal. For the tesseract cell x_i = +-1/2 this gives the other coordinates in increasing
 *   order, tess.py's local axes.
 * - A cell's vertices are listed by ascending index in the polytope's vertex list; its facets
 *   (the ridges) are sorted by their local outward normals with `compareNormals` (for a tesseract
 *   cell: -u0, +u0, -u1, +u1, -u2, +u2, so facet 2 k + (tau > 0) is the face u_k = tau s/2).
 *
 * Gluing (`CellFacet.toNeighbor`): the ridge R between cells c and c' is fixed pointwise by the
 * rotation of R^4 in the plane span(n_c, n_c') that takes n_c to n_c' (the identity on the
 * orthogonal complement, which contains R's directions). It maps c's hyperplane onto c''s, and
 * the half of c's hyperplane beyond R (where a straight ray continues after crossing R) onto the
 * side of R where c' lies. In local coordinates this is y' = A y + s b with
 *   A = F_c'^T Rot F_c,  b = F_c'^T (Rot (o_c - q) + q - o_c')   (q any point of R, at s = 1),
 * F the frames as 4 x 3 matrices and o the origins. The matching facet of c' holds the inverse.
 */
import { convexHull } from "./hull";
import { V3, dot, orthonormalBasis, rejectFrom, sub, toV3, unit, Iso3, isoFromAffine } from "./linalg";
import type { Affine, Cell, CellFacet, Polytope, PolytopeName } from "./types";
import { POLYTOPES } from "./types";

const ORDER_TOL = 1e-9;

/** The deterministic order of unit normals described above. */
export function compareNormals(a: readonly number[], b: readonly number[]): number {
  const dominant = (n: readonly number[]) => {
    const m = Math.max(...n.map(Math.abs));
    return n.findIndex((x) => Math.abs(x) >= m - ORDER_TOL);
  };
  const ka = dominant(a);
  const kb = dominant(b);
  if (ka !== kb) return ka - kb;
  const sa = Math.sign(a[ka]);
  const sb = Math.sign(b[kb]);
  if (sa !== sb) return sa - sb;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > ORDER_TOL) return a[i] - b[i];
  return 0;
}

const snap = (x: number) => (Math.abs(x) < 1e-15 ? 0 : x);

/** Points of `pts` (indices `ids`) in cyclic order, counter-clockwise around the unit normal n (3D). */
function cyclicOrder(pts: number[][], ids: number[], n: number[]): number[] {
  const c = [0, 0, 0];
  for (const i of ids) for (let k = 0; k < 3; k++) c[k] += pts[i][k] / ids.length;
  const e1 = unit(sub(pts[ids[0]], c));
  // e2 = n x e1, so (e1, e2, n) is right-handed and increasing angle is counter-clockwise around n
  const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  const ang = (i: number) => {
    const d = sub(pts[i], c);
    return Math.atan2(dot(d, e2), dot(d, e1));
  };
  return ids.slice().sort((a, b) => ang(a) - ang(b));
}

/**
 * Builds the boundary space of the convex hull of `vertices` (points of R^4, every one a vertex of
 * the hull). The polytope should have unit edge and be centred at the origin (the contract's
 * convention); the builder does not rescale.
 */
export function buildPolytope(name: PolytopeName, vertices: number[][], tol = 1e-9): Polytope {
  const d = vertices[0]?.length;
  if (d !== 4) throw new Error("buildPolytope: only 4-polytopes (3D cells) are supported");
  if (vertices.some((v) => v.length !== d || v.some((x) => !Number.isFinite(x)))) throw new Error("buildPolytope: bad vertex list");
  const hull = convexHull(vertices, tol);
  const order = hull.map((_, i) => i).sort((a, b) => compareNormals(hull[a].normal, hull[b].normal));

  interface Raw {
    cell: Cell;
    faceKeys: string[];
  }
  const raws: Raw[] = order.map((hi, index) => {
    const F = hull[hi];
    const normal = F.normal.map(snap);
    const vertexIds = F.ids.slice().sort((a, b) => a - b);
    const origin = new Array<number>(d).fill(0);
    for (const id of vertexIds) for (let k = 0; k < d; k++) origin[k] += vertices[id][k] / vertexIds.length;
    const std = Array.from({ length: d }, (_, j) => Array.from({ length: d }, (_, i) => (i === j ? 1 : 0)));
    const frame = orthonormalBasis(
      std.map((e) => rejectFrom(e, [normal])),
      1e-6,
    )
      .slice(0, d - 1)
      .map((f) => f.map(snap));
    const local = vertexIds.map((id) => frame.map((f) => snap(dot(sub(vertices[id], origin), f))));
    const h3 = convexHull(local, tol);
    const fOrder = h3.map((_, i) => i).sort((a, b) => compareNormals(h3[a].normal, h3[b].normal));
    const facets: CellFacet[] = [];
    const faceKeys: string[] = [];
    const hingeSet = new Map<string, [number, number]>();
    for (const fi of fOrder) {
      const f = h3[fi];
      const n3 = f.normal.map(snap);
      const poly = cyclicOrder(local, f.ids, n3);
      for (let j = 0; j < poly.length; j++) {
        const a = poly[j];
        const b = poly[(j + 1) % poly.length];
        const pr: [number, number] = a < b ? [a, b] : [b, a];
        hingeSet.set(pr.join(","), pr);
      }
      facets.push({
        inside: { n: n3, h: snap(dot(n3, local[poly[0]])) },
        neighbor: -1,
        neighborFacet: -1,
        toNeighbor: { A: [], b: [] },
        vertices: poly,
      });
      faceKeys.push(
        f.ids
          .map((i) => vertexIds[i])
          .sort((a, b) => a - b)
          .join(","),
      );
    }
    const hinges = [...hingeSet.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cell: Cell = { index, normal, origin: origin.map(snap), frame, vertices: local, hinges, facets, vertexIds };
    return { cell, faceKeys };
  });

  // match ridges: each 2-face lies in exactly two cells
  const byKey = new Map<string, [number, number][]>();
  raws.forEach((r, c) => r.faceKeys.forEach((k, f) => byKey.set(k, [...(byKey.get(k) ?? []), [c, f]])));
  for (const [key, list] of byKey) if (list.length !== 2) throw new Error(`buildPolytope: ridge ${key} lies in ${list.length} cells`);
  const cells = raws.map((r) => r.cell);
  raws.forEach((r, c) =>
    r.faceKeys.forEach((key, f) => {
      const [p, q] = byKey.get(key)!;
      const [c2, f2] = p[0] === c && p[1] === f ? q : p;
      const facet = cells[c].facets[f];
      facet.neighbor = c2;
      facet.neighborFacet = f2;
      facet.toNeighbor = gluing(cells[c], cells[c2], vertices[Number(key.split(",")[0])]);
    }),
  );

  // edges and the total angle around each
  const edgeMap = new Map<string, number>();
  const edges: [number, number][] = [];
  for (const c of cells)
    for (const [a, b] of c.hinges) {
      const ga = c.vertexIds[a];
      const gb = c.vertexIds[b];
      const pr: [number, number] = ga < gb ? [ga, gb] : [gb, ga];
      const k = pr.join(",");
      if (!edgeMap.has(k)) {
        edgeMap.set(k, -1);
        edges.push(pr);
      }
    }
  edges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  edges.forEach((e, i) => edgeMap.set(e.join(","), i));
  const edgeAngles = new Array<number>(edges.length).fill(0);
  for (const c of cells) {
    const T = cellTopoOf(c);
    c.hinges.forEach(([a, b], hi) => {
      const ga = c.vertexIds[a];
      const gb = c.vertexIds[b];
      const e = edgeMap.get((ga < gb ? [ga, gb] : [gb, ga]).join(","))!;
      edgeAngles[e] += T.hingeDihedral[hi];
    });
  }
  const hingeAngle = Math.min(...edgeAngles);
  return { name, d, vertices: vertices.map((v) => v.slice()), cells, hingeAngle, edges, edgeAngles };
}

/** The gluing across the ridge shared by cells c and c2 (q: a point of the ridge, at s = 1). */
function gluing(c: Cell, c2: Cell, q: number[]): Affine {
  const n = c.normal;
  const n2 = c2.normal;
  const cphi = dot(n, n2);
  const e = unit(n2.map((x, i) => x - cphi * n[i]));
  const sphi = dot(n2, e);
  // Rot x = x + (cos - 1)((n.x) n + (e.x) e) + sin ((n.x) e - (e.x) n): the rotation by the angle
  // between the normals in the plane span(n, e), taking n to n2
  const rot = (x: number[]) => {
    const a = dot(n, x);
    const b = dot(e, x);
    return x.map((xi, i) => xi + (cphi - 1) * (a * n[i] + b * e[i]) + sphi * (a * e[i] - b * n[i]));
  };
  const A = c2.frame.map((f2) => c.frame.map((f) => snap(dot(f2, rot(f)))));
  const p = rot(sub(c.origin, q)).map((x, i) => x + q[i] - c2.origin[i]);
  const b = c2.frame.map((f2) => snap(dot(f2, p)));
  return { A, b };
}

// ---------------------------------------------------------------- internal topology cache

/** Per-cell data derived from the public fields, in the shapes the engine computes with. */
export interface CellTopo {
  /** Facet half-spaces n . y <= h at s = 1 (scale h by s). */
  planes: { n: V3; h: number }[];
  /** Facet polygons in local coordinates at s = 1, counter-clockwise around n. */
  polys: V3[][];
  /** toNeighbor of each facet at s = 1 (scale t by s). */
  glue: Iso3[];
  verts: V3[];
  /** Dihedral angle of the cell at each hinge (between the two facets containing it). */
  hingeDihedral: number[];
  /** F x F: the hinge shared by facets a and b, or -1. */
  pairHinge: Int32Array;
  F: number;
}

export interface PolyTopo {
  cells: CellTopo[];
  /** Global edge index of each cell's hinges, per cell. */
  hingeEdge: number[][];
}

function cellTopoOf(c: Cell): CellTopo {
  const F = c.facets.length;
  const verts = c.vertices.map(toV3);
  const polys = c.facets.map((f) => f.vertices.map((i) => verts[i]));
  const planes = c.facets.map((f) => ({ n: toV3(f.inside.n), h: f.inside.h }));
  const pairHinge = new Int32Array(F * F).fill(-1);
  const hingeDihedral = new Array<number>(c.hinges.length).fill(0);
  const index = new Map<string, number>();
  c.hinges.forEach(([a, b], i) => index.set(`${a},${b}`, i));
  const owners: number[][] = c.hinges.map(() => []);
  c.facets.forEach((f, fi) => {
    const p = f.vertices;
    for (let j = 0; j < p.length; j++) {
      const a = p[j];
      const b = p[(j + 1) % p.length];
      const h = index.get(a < b ? `${a},${b}` : `${b},${a}`);
      if (h !== undefined) owners[h].push(fi);
    }
  });
  owners.forEach((fs, h) => {
    if (fs.length !== 2) throw new Error(`cell ${c.index}: hinge ${h} lies in ${fs.length} facets`);
    const [a, b] = fs;
    pairHinge[a * F + b] = h;
    pairHinge[b * F + a] = h;
    const cos = Math.max(-1, Math.min(1, dot(planes[a].n, planes[b].n)));
    hingeDihedral[h] = Math.PI - Math.acos(cos);
  });
  return { planes, polys, glue: c.facets.map((f) => isoFromAffine(f.toNeighbor)), verts, hingeDihedral, pairHinge, F };
}

const TOPO = new WeakMap<Polytope, PolyTopo>();

export function topo(poly: Polytope): PolyTopo {
  let t = TOPO.get(poly);
  if (!t) {
    const edgeIdx = new Map<string, number>();
    poly.edges.forEach(([a, b], i) => edgeIdx.set(`${a},${b}`, i));
    const hingeEdge = poly.cells.map((c) =>
      c.hinges.map(([a, b]) => {
        const ga = c.vertexIds[a];
        const gb = c.vertexIds[b];
        return edgeIdx.get(ga < gb ? `${ga},${gb}` : `${gb},${ga}`) ?? -1;
      }),
    );
    t = { cells: poly.cells.map(cellTopoOf), hingeEdge };
    TOPO.set(poly, t);
  }
  return t;
}

// ---------------------------------------------------------------- the catalogue

/** Vertices (+-1/2)^4 of the unit tesseract; vertex v has coordinate k = +1/2 exactly when bit k of v is set. */
export function tesseractVertices(): number[][] {
  return Array.from({ length: 16 }, (_, v) => [0, 1, 2, 3].map((k) => ((v >> k) & 1 ? 0.5 : -0.5)));
}

const CACHE = new Map<PolytopeName, Polytope>();

export function isPolytopeName(x: unknown): x is PolytopeName {
  return typeof x === "string" && (POLYTOPES as readonly string[]).includes(x);
}

/** The catalogue's polytopes (unit edge, centred at the origin), built once and shared: treat as read-only. */
export function getPolytope(name: PolytopeName): Polytope {
  let p = CACHE.get(name);
  if (!p) {
    if (name === "tesseract") p = buildPolytope("tesseract", tesseractVertices());
    else throw new Error(`unknown polytope ${String(name)}`);
    CACHE.set(name, p);
  }
  return p;
}

/** Ambient point of local coordinates u (at edge s) of a cell: x = s origin + sum_k u_k frame[k]. */
export function toAmbient(poly: Polytope, cell: number, u: number[], s: number): number[] {
  const c = poly.cells[cell];
  const x = c.origin.map((o) => s * o);
  c.frame.forEach((f, k) => f.forEach((fi, i) => (x[i] += u[k] * fi)));
  return x;
}

/**
 * The cell holding an ambient point of the boundary (at edge s), and its local coordinates: the
 * cell whose hyperplane is nearest (ties: the lowest index).
 */
export function fromAmbient(poly: Polytope, x: number[], s: number): { cell: number; u: number[] } {
  let best = -1;
  let gap = Infinity;
  poly.cells.forEach((c, i) => {
    const g = Math.abs(dot(c.normal, x) - s * dot(c.normal, c.origin));
    if (g < gap - 1e-15) {
      gap = g;
      best = i;
    }
  });
  const c = poly.cells[best];
  const d = x.map((xi, i) => xi - s * c.origin[i]);
  return { cell: best, u: c.frame.map((f) => dot(f, d)) };
}

/** Local outward unit normal and offset of a facet, at edge s: the facet is { y : n . y <= s h }. */
export function facetPlane(poly: Polytope, cell: number, facet: number, s: number): { n: number[]; h: number } {
  const f = poly.cells[cell].facets[facet].inside;
  return { n: f.n.slice(), h: s * f.h };
}

/**
 * Volume of the boundary (the sum of the cells' 3-volumes) at s = 1; scale by s^3. Each cell is the
 * union of the pyramids from its origin (inside it) over its facets: sum of h_f area_f / 3.
 */
export function boundaryVolume(poly: Polytope): number {
  let v = 0;
  for (const c of poly.cells)
    for (const f of c.facets) {
      const P = f.vertices.map((i) => c.vertices[i]);
      // Newell: twice the area vector
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let i = 0; i < P.length; i++) {
        const a = P[i];
        const b = P[(i + 1) % P.length];
        ax += (a[1] - b[1]) * (a[2] + b[2]);
        ay += (a[2] - b[2]) * (a[0] + b[0]);
        az += (a[0] - b[0]) * (a[1] + b[1]);
      }
      v += (f.inside.h * Math.hypot(ax, ay, az)) / 6;
    }
  return v;
}

/** Largest violation of the cell's facet inequalities by u at edge s (<= 0 inside the closed cell). */
export function cellExcess(poly: Polytope, cell: number, u: readonly number[], s: number): number {
  let worst = -Infinity;
  for (const f of poly.cells[cell].facets) worst = Math.max(worst, dot(f.inside.n, u as number[]) - s * f.inside.h);
  return worst;
}
