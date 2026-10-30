/**
 * Convex polyhedral surfaces: the five Platonic solids, the 13 Archimedean and 13 Catalan solids, the prisms with 3 and 5
 * to 12 sides, the antiprisms with 4 to 12 sides and the 92 Johnson solids, each a closed surface of convex polygons glued
 * edge to edge, flat except at the vertices (cone points).
 *
 * Conventions (fixed; the Python certifier rebuilds them independently and the two must agree):
 * - Platonic solids: vertices in a documented order (see `vertexList`), at unit edge length. The other
 *   solids: the polyhedra space's canonical solids (python/polyhedra/solids_exact.json), in its vertex
 *   order and scale (unit edges for Archimedean solids, prisms, antiprisms and Johnson solids; Catalan solids are the
 *   polar reciprocals of the unit-edge Archimedean solids about the midsphere). The score s is the scale factor of that
 *   canonical solid, which for the Platonic, Archimedean and Johnson solids and the prisms and antiprisms is the edge length.
 *   The 92 Johnson solids are named as in the polyhedra space (`square_pyramid`, `gyroelongated_square_bicupola`, ...; J1 to
 *   J92 in Johnson's order); none of the names is another solid's.
 * - A face is the cycle of its vertex ids, counter-clockwise seen from outside, rotated so that its
 *   smallest vertex id comes first. Faces are sorted lexicographically by these cycles.
 * - Face frame: the origin is the face centre (see below), and the last edge (frame vertex M - 1 to frame vertex 0) is horizontal at the bottom, running in
 *   +x. Frame vertex k is the 3D vertex faces[f][k] and edge k runs from frame vertex k to k + 1, so
 *   frame vertex 0 is the bottom right corner. The face centre is the foot of the perpendicular from the solid's centre
 *   to the face plane for the Platonic, Archimedean, Catalan, prism and antiprism faces, which have a circumsphere or an
 *   insphere about the solid's centre (the foot is the circumcentre of a regular face, the incentre of a Catalan face).
 *   The Johnson solids have neither in general, so for them it is the circumcentre of the regular face (the mean of its
 *   vertices), not the foot (`frameOf`). For a regular face (all faces
 *   of the Platonic, Archimedean and Johnson solids, prisms and antiprisms) this is the regular M-gon
 *   of side s centred at the origin with a horizontal bottom edge, PolyPack's container convention with
 *   phi = 0: frame vertex k at angle -pi/2 + pi/M + 2 pi k/M (`frameVertex`). Catalan faces are
 *   irregular but tangential (every edge touches the midsphere), and the foot is their incentre.
 *   Counter-clockwise in the frame is counter-clockwise from outside, so a frame is an
 *   orientation-preserving chart of the surface.
 * - The surface metric depends only on the faces and the gluing (which edge meets which); the 3D
 *   coordinates fix the face shapes and are used for drawing.
 *
 * The Platonic solids keep the code paths they had before the generalisation (`uniform`), so that their
 * validation and search are bit for bit unchanged.
 */
import { GENERAL_SOLID_DATA } from "./general.data";

export type PlatonicName = "tetrahedron" | "cube" | "octahedron" | "dodecahedron" | "icosahedron";
export type ArchimedeanName =
  | "truncated_tetrahedron"
  | "cuboctahedron"
  | "truncated_cube"
  | "truncated_octahedron"
  | "rhombicuboctahedron"
  | "truncated_cuboctahedron"
  | "snub_cube"
  | "icosidodecahedron"
  | "truncated_dodecahedron"
  | "truncated_icosahedron"
  | "rhombicosidodecahedron"
  | "truncated_icosidodecahedron"
  | "snub_dodecahedron";
export type CatalanName =
  | "triakis_tetrahedron"
  | "rhombic_dodecahedron"
  | "triakis_octahedron"
  | "tetrakis_hexahedron"
  | "deltoidal_icositetrahedron"
  | "disdyakis_dodecahedron"
  | "pentagonal_icositetrahedron"
  | "rhombic_triacontahedron"
  | "triakis_icosahedron"
  | "pentakis_dodecahedron"
  | "deltoidal_hexecontahedron"
  | "disdyakis_triacontahedron"
  | "pentagonal_hexecontahedron";
export type PrismName = `prism${3 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`;
export type AntiprismName = `antiprism${4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`;
export type JohnsonName = (typeof JOHNSON_NAMES)[number];
export type SolidName = PlatonicName | ArchimedeanName | CatalanName | PrismName | AntiprismName | JohnsonName;
export type SolidFamily = "platonic" | "archimedean" | "catalan" | "prism" | "antiprism" | "johnson";

/** The five Platonic solids (the solids of the space before 2026-10-26), in their catalogue order. */
export const SOLID_NAMES: readonly PlatonicName[] = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];
export const PLATONIC_NAMES = SOLID_NAMES;
/** The 13 Archimedean solids, in the polyhedra catalogue order. */
export const ARCHIMEDEAN_NAMES: readonly ArchimedeanName[] = [
  "truncated_tetrahedron",
  "cuboctahedron",
  "truncated_cube",
  "truncated_octahedron",
  "rhombicuboctahedron",
  "truncated_cuboctahedron",
  "snub_cube",
  "icosidodecahedron",
  "truncated_dodecahedron",
  "truncated_icosahedron",
  "rhombicosidodecahedron",
  "truncated_icosidodecahedron",
  "snub_dodecahedron",
];
/** The Catalan solids, by number of faces, then name. */
export const CATALAN_NAMES: readonly CatalanName[] = [
  "rhombic_dodecahedron",
  "triakis_tetrahedron",
  "deltoidal_icositetrahedron",
  "pentagonal_icositetrahedron",
  "tetrakis_hexahedron",
  "triakis_octahedron",
  "rhombic_triacontahedron",
  "disdyakis_dodecahedron",
  "deltoidal_hexecontahedron",
  "pentagonal_hexecontahedron",
  "pentakis_dodecahedron",
  "triakis_icosahedron",
  "disdyakis_triacontahedron",
];
export const PRISM_NAMES: readonly PrismName[] = [3, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `prism${n}` as PrismName);
export const ANTIPRISM_NAMES: readonly AntiprismName[] = [4, 5, 6, 7, 8, 9, 10, 11, 12].map(
  (n) => `antiprism${n}` as AntiprismName,
);
/** The 92 Johnson solids, J1 to J92 in Johnson's order (the polyhedra space's names and order). */
export const JOHNSON_NAMES = [
  "square_pyramid",
  "pentagonal_pyramid",
  "triangular_cupola",
  "square_cupola",
  "pentagonal_cupola",
  "pentagonal_rotunda",
  "elongated_triangular_pyramid",
  "elongated_square_pyramid",
  "elongated_pentagonal_pyramid",
  "gyroelongated_square_pyramid",
  "gyroelongated_pentagonal_pyramid",
  "triangular_bipyramid",
  "pentagonal_bipyramid",
  "elongated_triangular_bipyramid",
  "elongated_square_bipyramid",
  "elongated_pentagonal_bipyramid",
  "gyroelongated_square_bipyramid",
  "elongated_triangular_cupola",
  "elongated_square_cupola",
  "elongated_pentagonal_cupola",
  "elongated_pentagonal_rotunda",
  "gyroelongated_triangular_cupola",
  "gyroelongated_square_cupola",
  "gyroelongated_pentagonal_cupola",
  "gyroelongated_pentagonal_rotunda",
  "gyrobifastigium",
  "triangular_orthobicupola",
  "square_orthobicupola",
  "square_gyrobicupola",
  "pentagonal_orthobicupola",
  "pentagonal_gyrobicupola",
  "pentagonal_orthocupolarotunda",
  "pentagonal_gyrocupolarotunda",
  "pentagonal_orthobirotunda",
  "elongated_triangular_orthobicupola",
  "elongated_triangular_gyrobicupola",
  "elongated_square_gyrobicupola",
  "elongated_pentagonal_orthobicupola",
  "elongated_pentagonal_gyrobicupola",
  "elongated_pentagonal_orthocupolarotunda",
  "elongated_pentagonal_gyrocupolarotunda",
  "elongated_pentagonal_orthobirotunda",
  "elongated_pentagonal_gyrobirotunda",
  "gyroelongated_triangular_bicupola",
  "gyroelongated_square_bicupola",
  "gyroelongated_pentagonal_bicupola",
  "gyroelongated_pentagonal_cupolarotunda",
  "gyroelongated_pentagonal_birotunda",
  "augmented_triangular_prism",
  "biaugmented_triangular_prism",
  "triaugmented_triangular_prism",
  "augmented_pentagonal_prism",
  "biaugmented_pentagonal_prism",
  "augmented_hexagonal_prism",
  "parabiaugmented_hexagonal_prism",
  "metabiaugmented_hexagonal_prism",
  "triaugmented_hexagonal_prism",
  "augmented_dodecahedron",
  "parabiaugmented_dodecahedron",
  "metabiaugmented_dodecahedron",
  "triaugmented_dodecahedron",
  "metabidiminished_icosahedron",
  "tridiminished_icosahedron",
  "augmented_tridiminished_icosahedron",
  "augmented_truncated_tetrahedron",
  "augmented_truncated_cube",
  "biaugmented_truncated_cube",
  "augmented_truncated_dodecahedron",
  "parabiaugmented_truncated_dodecahedron",
  "metabiaugmented_truncated_dodecahedron",
  "triaugmented_truncated_dodecahedron",
  "gyrate_rhombicosidodecahedron",
  "parabigyrate_rhombicosidodecahedron",
  "metabigyrate_rhombicosidodecahedron",
  "trigyrate_rhombicosidodecahedron",
  "diminished_rhombicosidodecahedron",
  "paragyrate_diminished_rhombicosidodecahedron",
  "metagyrate_diminished_rhombicosidodecahedron",
  "bigyrate_diminished_rhombicosidodecahedron",
  "parabidiminished_rhombicosidodecahedron",
  "metabidiminished_rhombicosidodecahedron",
  "gyrate_bidiminished_rhombicosidodecahedron",
  "tridiminished_rhombicosidodecahedron",
  "snub_disphenoid",
  "snub_square_antiprism",
  "sphenocorona",
  "augmented_sphenocorona",
  "sphenomegacorona",
  "hebesphenomegacorona",
  "disphenocingulum",
  "bilunabirotunda",
  "triangular_hebesphenorotunda",
] as const;
/**
 * Every solid of the space, grouped by family (Platonic, Archimedean, Catalan, prisms, antiprisms, Johnson) in catalogue
 * order within each family.
 */
export const ALL_SOLID_NAMES: readonly SolidName[] = [
  ...SOLID_NAMES,
  ...ARCHIMEDEAN_NAMES,
  ...CATALAN_NAMES,
  ...PRISM_NAMES,
  ...ANTIPRISM_NAMES,
  ...JOHNSON_NAMES,
];

export interface EdgeRef {
  face: number;
  edge: number;
}

export interface Solid {
  name: SolidName;
  family: SolidFamily;
  /** Plain name, e.g. "cube", "rhombic dodecahedron", "pentagonal prism". */
  title: string;
  /** sides of every face when all faces have the same number of sides, else the largest (see `sides`) */
  M: number;
  F: number;
  V: number;
  E: number;
  /** faces meeting at every vertex when that number is the same at every vertex, else NaN (see `vertexDegree`) */
  degree: number;
  /** interior angle of every face when all faces are the same regular M-gon, (M - 2) pi / M; else NaN (see `corner`) */
  faceAngle: number;
  /** total angle around every vertex when it is the same at every vertex (< 2 pi); else NaN (see `vertexCone`) */
  coneAngle: number;
  /** canonical 3D coordinates (unit edge for the Platonic solids), for drawing only */
  vertices: [number, number, number][];
  /** faces[f][k] = vertex id of frame vertex k */
  faces: number[][];
  /** adj[f][k] = the face and edge glued to edge k of face f */
  adj: EdgeRef[][];
  /** number of sides of each face */
  sides: number[];
  /**
   * True for the Platonic solids: every face is the same regular M-gon in the regular frame. Their code
   * paths are the ones from before the generalisation, so their results stay bit for bit the same.
   */
  uniform: boolean;
  /** per face: a regular polygon in the regular frame (frame vertices from `frameVertex`) */
  regular: boolean[];
  /** per face: frame vertices at scale s = 1, flat [x0, y0, x1, y1, ...] */
  unitFaces: Float64Array[];
  /** per face: interior angle at each frame vertex (radians) */
  corner: number[][];
  /** per face: direction angle of each edge (frame vertex k to k + 1) in the face's frame */
  edgeAngle: number[][];
  /** per vertex: number of faces at it */
  vertexDegree: number[];
  /** per vertex: cone angle, the sum of the face angles at it (radians, < 2 pi) */
  vertexCone: number[];
  /** per face: the 3D frame at scale 1 (origin, x axis, y axis), for drawing */
  frame3D: { o: [number, number, number]; ex: [number, number, number]; ey: [number, number, number] }[];
}

const PHI = (1 + Math.sqrt(5)) / 2;

/** Vertex coordinates in the documented order: Platonic solids at unit edge, the others canonical. */
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
  const d = GENERAL_SOLID_DATA.find((x) => x.name === name);
  if (!d) throw new Error(`unknown solid ${name}`);
  return d.V.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
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
  return sortFaces(faces);
}

function sortFaces(faces: number[][]): number[][] {
  return faces.sort((a, b) => {
    for (let t = 0; t < Math.min(a.length, b.length); t++) if (a[t] !== b[t]) return a[t] - b[t];
    return a.length - b.length;
  });
}

/** A face cycle (counter-clockwise from outside) rotated to start at its smallest id. */
export function canonicalCycle(cycle: number[]): number[] {
  const m = cycle.indexOf(Math.min(...cycle));
  return [...cycle.slice(m), ...cycle.slice(0, m)];
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
  return canonicalCycle(sorted);
}

const PLATONIC = new Set<string>(SOLID_NAMES);

/** Interior angle of a convex polygon (flat counter-clockwise array) at vertex k. */
function cornerAngle(poly: Float64Array, k: number): number {
  const n = poly.length / 2;
  const i = (k + n - 1) % n;
  const j = (k + 1) % n;
  const ax = poly[2 * i] - poly[2 * k];
  const ay = poly[2 * i + 1] - poly[2 * k + 1];
  const bx = poly[2 * j] - poly[2 * k];
  const by = poly[2 * j + 1] - poly[2 * k + 1];
  // turning from the next edge counter-clockwise to the previous one
  return Math.atan2(bx * ay - by * ax, ax * bx + ay * by);
}

/**
 * The frame of a face from its 3D vertices, edge n - 1 along +x. The origin is the foot of the perpendicular from the
 * solid's centre, or with `atFaceCentre` (the Johnson solids) the circumcentre of the regular face, the mean of its
 * vertices, which the foot is not unless the solid has a sphere through (or touching) its faces about the centre.
 */
function frameOf(pts: V3[], atFaceCentre: boolean): { o: V3; ex: V3; ey: V3; flat: Float64Array } {
  const n = pts.length;
  // outward normal from the polygon's vector area (the cycle runs counter-clockwise from outside)
  let nrm: V3 = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const c = cross3(pts[k], pts[(k + 1) % n]);
    nrm = [nrm[0] + c[0], nrm[1] + c[1], nrm[2] + c[2]];
  }
  const ln = Math.hypot(...nrm);
  nrm = [nrm[0] / ln, nrm[1] / ln, nrm[2] / ln];
  let off = 0;
  for (const p of pts) off += dot(nrm, p) / n;
  const o: V3 = atFaceCentre
    ? [0, 1, 2].map((t) => pts.reduce((a, p) => a + p[t], 0) / n) as V3
    : [nrm[0] * off, nrm[1] * off, nrm[2] * off];
  // the bottom edge, from frame vertex n - 1 to frame vertex 0, runs along +x
  const e = sub(pts[0], pts[n - 1]);
  const le = Math.hypot(...e);
  const ex: V3 = [e[0] / le, e[1] / le, e[2] / le];
  const ey = cross3(nrm, ex);
  const flat = new Float64Array(2 * n);
  pts.forEach((p, k) => {
    const d = sub(p, o);
    flat[2 * k] = dot(d, ex);
    flat[2 * k + 1] = dot(d, ey);
  });
  return { o, ex, ey, flat };
}

const cache = new Map<SolidName, Solid>();

export function getSolid(name: SolidName): Solid {
  const hit = cache.get(name);
  if (hit) return hit;
  if (!isSolidName(name)) throw new Error(`unknown solid ${String(name)}`);
  const vertices = vertexList(name);
  const data = GENERAL_SOLID_DATA.find((x) => x.name === name);
  const uniform = PLATONIC.has(name);
  // Platonic: hull of the documented vertices; the others: the canonical solid's own faces, canonically ordered
  const faces = uniform ? hullFaces(vertices) : sortFaces(data!.faces.map(canonicalCycle));
  const F = faces.length;
  const V = vertices.length;
  const sides = faces.map((f) => f.length);
  const E = sides.reduce((a, b) => a + b, 0) / 2;
  // edge k of face f runs from faces[f][k] to faces[f][k+1]; its neighbour holds the reverse edge
  const directed = new Map<string, EdgeRef>();
  faces.forEach((f, fi) => f.forEach((v, k) => directed.set(`${v}>${f[(k + 1) % f.length]}`, { face: fi, edge: k })));
  const adj = faces.map((f) =>
    f.map((v, k) => {
      const r = directed.get(`${f[(k + 1) % f.length]}>${v}`);
      if (!r) throw new Error(`${name}: unglued edge`);
      return r;
    }),
  );
  const frames = faces.map((f) => frameOf(f.map((v) => vertices[v]), data?.family === "johnson"));
  const regular = faces.map((f, fi) => {
    if (uniform) return true;
    if (data!.family === "catalan") return false;
    // Archimedean and Johnson solids, prisms and antiprisms: every face is the regular polygon of its frame; check it
    const M = f.length;
    const flat = frames[fi].flat;
    for (let k = 0; k < M; k++) {
      const [x, y] = frameVertex(M, 1, k);
      if (Math.hypot(flat[2 * k] - x, flat[2 * k + 1] - y) > 1e-12 * faceCircumradius(M, 1))
        throw new Error(`${name}: face ${fi} is not the regular ${M}-gon of its frame`);
    }
    return true;
  });
  const unitFaces = faces.map((f, fi) => (regular[fi] ? facePolygon(f.length, 1) : frames[fi].flat));
  const corner = faces.map((f, fi) =>
    regular[fi] ? f.map(() => ((f.length - 2) * Math.PI) / f.length) : f.map((_, k) => cornerAngle(unitFaces[fi], k)),
  );
  const edgeAngle = faces.map((f, fi) =>
    f.map((_, k) => {
      if (regular[fi]) return (2 * Math.PI * (k + 1)) / f.length;
      const u = unitFaces[fi];
      const j = (k + 1) % f.length;
      return Math.atan2(u[2 * j + 1] - u[2 * k + 1], u[2 * j] - u[2 * k]);
    }),
  );
  const vertexDegree = new Array<number>(V).fill(0);
  const vertexCone = new Array<number>(V).fill(0);
  faces.forEach((f, fi) =>
    f.forEach((v, k) => {
      vertexDegree[v]++;
      vertexCone[v] += corner[fi][k];
    }),
  );
  const M = Math.max(...sides);
  const degree = vertexDegree.every((d) => d === vertexDegree[0]) ? vertexDegree[0] : NaN;
  const faceAngle = uniform ? ((M - 2) * Math.PI) / M : NaN;
  const coneAngle = uniform
    ? degree * faceAngle
    : vertexCone.every((c) => Math.abs(c - vertexCone[0]) < 1e-12)
      ? vertexCone[0]
      : NaN;
  const solid: Solid = {
    name,
    family: uniform ? "platonic" : data!.family,
    title: uniform ? name : data!.title,
    M,
    F,
    V,
    E,
    degree,
    faceAngle,
    coneAngle,
    vertices,
    faces,
    adj,
    sides,
    uniform,
    regular,
    unitFaces,
    corner,
    edgeAngle,
    vertexDegree,
    vertexCone,
    frame3D: frames.map(({ o, ex, ey }) => ({ o, ex, ey })),
  };
  cache.set(name, solid);
  return solid;
}

export function isSolidName(x: unknown): x is SolidName {
  return typeof x === "string" && (ALL_SOLID_NAMES as readonly string[]).includes(x);
}

/** Circumradius of the regular face polygon at edge s. */
export function faceCircumradius(M: number, s: number): number {
  return s / (2 * Math.sin(Math.PI / M));
}

/** Apothem of the regular face polygon at edge s. */
export function faceApothem(M: number, s: number): number {
  return s / (2 * Math.tan(Math.PI / M));
}

/** Frame vertex k of a regular face at edge s (angle -pi/2 + pi/M + 2 pi k / M). */
export function frameVertex(M: number, s: number, k: number): [number, number] {
  const R = faceCircumradius(M, s);
  const a = -Math.PI / 2 + Math.PI / M + (2 * Math.PI * (((k % M) + M) % M)) / M;
  return [R * Math.cos(a), R * Math.sin(a)];
}

/** Frame vertex k of face f of a solid at scale s (any face; regular faces use `frameVertex`). */
export function faceVertex(solid: Solid, s: number, f: number, k: number): [number, number] {
  const M = solid.sides[f];
  if (solid.regular[f]) return frameVertex(M, s, k);
  const u = solid.unitFaces[f];
  const i = ((k % M) + M) % M;
  return [s * u[2 * i], s * u[2 * i + 1]];
}

/** Frame vertices of face f at scale s, as pairs. */
export function faceVertices(solid: Solid, s: number, f: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < solid.sides[f]; k++) out.push(faceVertex(solid, s, f, k));
  return out;
}

/** Regular face polygon in its own frame as a flat counter-clockwise array. */
export function facePolygon(M: number, s: number): Float64Array {
  const out = new Float64Array(2 * M);
  for (let k = 0; k < M; k++) {
    const [x, y] = frameVertex(M, s, k);
    out[2 * k] = x;
    out[2 * k + 1] = y;
  }
  return out;
}

/** Face f of a solid in its own frame at scale s, as a flat counter-clockwise array. */
export function facePolygonOf(solid: Solid, s: number, f: number): Float64Array {
  if (solid.regular[f]) return facePolygon(solid.sides[f], s);
  return Float64Array.from(solid.unitFaces[f], (v) => v * s);
}

/** Area of face f at scale 1. */
export function faceArea(solid: Solid, f: number): number {
  const u = solid.unitFaces[f];
  const n = u.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += u[2 * i] * u[2 * j + 1] - u[2 * j] * u[2 * i + 1];
  }
  return a / 2;
}

/** Surface area of the solid at scale s. */
export function surfaceArea(solid: Solid, s: number): number {
  if (solid.uniform) return (solid.F * solid.M * s * s) / (4 * Math.tan(Math.PI / solid.M));
  let a = 0;
  for (let f = 0; f < solid.F; f++) a += faceArea(solid, f);
  return a * s * s;
}

/**
 * Signed distance of (x, y) inside face f (positive inside), in that face's frame at scale s. On a
 * regular face this is computed as `insideFaceDepth` of validate.ts always was.
 */
export function faceDepth(solid: Solid, s: number, f: number, x: number, y: number): number {
  const M = solid.sides[f];
  if (solid.regular[f]) {
    const ap = faceApothem(M, s);
    let worst = Infinity;
    for (let j = 0; j < M; j++) {
      // outward normal of edge j has angle 2 pi (j + 1) / M - pi / 2
      const a = (2 * Math.PI * (j + 1)) / M - Math.PI / 2;
      const d = ap - (x * Math.cos(a) + y * Math.sin(a));
      if (d < worst) worst = d;
    }
    return worst;
  }
  const u = solid.unitFaces[f];
  let worst = Infinity;
  for (let j = 0; j < M; j++) {
    const k = (j + 1) % M;
    const ax = s * u[2 * j];
    const ay = s * u[2 * j + 1];
    const ex = s * u[2 * k] - ax;
    const ey = s * u[2 * k + 1] - ay;
    const d = (ex * (y - ay) - ey * (x - ax)) / Math.hypot(ex, ey);
    if (d < worst) worst = d;
  }
  return worst;
}

/**
 * Largest distance from a point of face f to the nearest corner of that face, at scale 1: every point
 * of the face is within this distance of one of its corners. The farthest point is a vertex of the
 * corners' Voronoi diagram inside the face or a point where a Voronoi edge meets the boundary, so the
 * circumcentres of corner triples and the meetings of corner bisectors with edges suffice.
 */
export function faceCornerRadius(solid: Solid, f: number): number {
  const u = solid.unitFaces[f];
  const n = u.length / 2;
  const P = Array.from({ length: n }, (_, k) => [u[2 * k], u[2 * k + 1]] as [number, number]);
  const near = (x: number, y: number) => Math.min(...P.map(([a, b]) => Math.hypot(x - a, y - b)));
  const inside = (x: number, y: number) => faceDepth(solid, 1, f, x, y) >= -1e-12;
  let best = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        const [ax, ay] = P[i];
        const [bx, by] = P[j];
        const [cx, cy] = P[k];
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(d) < 1e-15) continue;
        const a2 = ax * ax + ay * ay;
        const b2 = bx * bx + by * by;
        const c2 = cx * cx + cy * cy;
        const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
        const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
        if (inside(x, y)) best = Math.max(best, near(x, y));
      }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const mx = (P[i][0] + P[j][0]) / 2;
      const my = (P[i][1] + P[j][1]) / 2;
      const nx = P[j][0] - P[i][0];
      const ny = P[j][1] - P[i][1];
      for (let e = 0; e < n; e++) {
        const [ax, ay] = P[e];
        const [bx, by] = P[(e + 1) % n];
        // the point a + t (b - a) on the bisector n . (p - m) = 0
        const den = nx * (bx - ax) + ny * (by - ay);
        if (Math.abs(den) < 1e-15) continue;
        const t = (nx * (mx - ax) + ny * (my - ay)) / den;
        if (t < 0 || t > 1) continue;
        best = Math.max(best, near(ax + t * (bx - ax), ay + t * (by - ay)));
      }
    }
  return best;
}

/**
 * 3D position of a point given in face f's frame (for drawing). The frame vertex k maps to the
 * 3D vertex faces[f][k].
 */
export function faceTo3D(solid: Solid, s: number, f: number, x: number, y: number): [number, number, number] {
  if (!solid.uniform) {
    const { o, ex, ey } = solid.frame3D[f];
    return [s * o[0] + x * ex[0] + y * ey[0], s * o[1] + x * ex[1] + y * ey[1], s * o[2] + x * ex[2] + y * ey[2]];
  }
  // the Platonic solids: the similarity fixed by the face centre and frame vertex 0
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
