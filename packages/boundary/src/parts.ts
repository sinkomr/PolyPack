/**
 * Pieces and their parts in the cells.
 *
 * A piece X (unit ball, or the unit cube [-1/2, 1/2]^3) with pose (anchor cell, centre u, rotation
 * q) sits in the anchor's local frame as y = R(q) p + u for p in X (piece-local coordinates). It is
 * developed from u (chains.ts); for every chain C ending in cell c, its part in c is
 *
 *   X ∩ (developed c) ∩ W(C),   mapped into c's own frame by the inverse development.
 *
 * In PiecePart terms: `place` = (c's frame -> anchor frame)^-1 ∘ (piece-local -> anchor frame), and
 * `clip` = the window's planes written in c's frame. The cell's own facets bound the part too.
 * Parts without interior are left out (a cube exactly filling its cell touches the neighbours
 * only along faces).
 */
import { ChainNode, ChainOptions, clampToCell, enumerateChains } from "./chains";
import {
  Iso3,
  V3,
  isoApply,
  isoCompose,
  isoFromAffine,
  isoInverse,
  isoLinear,
  isoLinearT,
  isoToAffine,
  quaternionToMatrix,
} from "./linalg";
import { Polyhedron, clipPolyhedron, polyhedronFrom, polyhedronThickness, polyhedronVertices } from "./polyhedron";
import { topo } from "./polytope";
import { BALL_RADIUS } from "./units";
import type { BoundaryConfig, BoundaryPiece, HalfSpace, PieceName, PiecePart, Polytope } from "./types";

/** Unit cube vertices, vertex v having coordinate k = +1/2 exactly when bit k of v is set. */
export const CUBE_VERTICES: V3[] = Array.from({ length: 8 }, (_, v) => [v & 1 ? 0.5 : -0.5, v & 2 ? 0.5 : -0.5, v & 4 ? 0.5 : -0.5]);
/** Unit cube faces, counter-clockwise seen from outside: -x, +x, -y, +y, -z, +z. */
export const CUBE_FACES: number[][] = [
  [0, 4, 6, 2],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 6, 7, 3],
  [0, 2, 3, 1],
  [4, 5, 7, 6],
];

/** The piece's circumradius: the reach of its development from its centre (a ball's radius 1/2, site units). */
export function pieceReach(piece: PieceName): number {
  return piece === "ball" ? BALL_RADIUS : Math.sqrt(3) / 2;
}

/** Piece-local -> anchor-local coordinates: y = R(q) p + u (no rotation for balls or an absent q). */
export function piecePose(piece: PieceName, p: BoundaryPiece): Iso3 {
  const m = piece !== "ball" && p.q ? quaternionToMatrix(p.q) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return { m, t: [p.u[0], p.u[1], p.u[2]] };
}

/** A piece developed from its centre: the clamped centre, its pose and its chains. */
export interface Development {
  /** Centre in the anchor frame, clamped into the closed anchor cell and snapped (opts.snap). */
  u: V3;
  /** How far the snap moved the clamped centre (0 when it lies on no facet plane within the snap). */
  snapped: number;
  pose: Iso3;
  nodes: ChainNode[];
}

export function developPiece(poly: Polytope, piece: PieceName, p: BoundaryPiece, s: number, reach = pieceReach(piece), opts: ChainOptions = {}): Development {
  const u = clampToCell(poly, p.cell, p.u, s, opts.snap);
  const c = clampToCell(poly, p.cell, p.u, s, 0);
  const pose = piecePose(piece, p);
  pose.t = u;
  return { u, snapped: Math.hypot(u[0] - c[0], u[1] - c[1], u[2] - c[2]), pose, nodes: enumerateChains(poly, s, p.cell, u, reach, opts) };
}

/** The window of a chain as half-spaces { y : n . y <= h } in the frame of the chain's last cell. */
export function windowInCell(node: ChainNode, u: V3): HalfSpace[] {
  const T = node.toAnchor;
  // N . (T y - u) >= 0  <=>  (-M^T N) . y <= N . (t - u)
  return node.window.map((N) => {
    const n = isoLinearT(T, N);
    return { n: [-n[0], -n[1], -n[2]], h: N[0] * (T.t[0] - u[0]) + N[1] * (T.t[1] - u[1]) + N[2] * (T.t[2] - u[2]) };
  });
}

/**
 * The part of a polytope piece in a cell, as a convex polyhedron in that cell's frame: the placed
 * piece clipped by the cell's facets (at edge s) and by `clip`.
 *
 * Scale-free: the clipping runs in coordinates relative to the piece's developed centre c =
 * place(0), where the piece's vertices are O(1) whatever s is; a half-space n . y <= h becomes
 * n . (y - c) <= h - n . c, whose offset carries only the rounding of h and c (about 1e-16 s).
 * Vertices within PART_CLIP_EPS (piece units, independent of s) of a plane count as on it. The
 * result is translated back by c.
 */
export function partPolyhedron(poly: Polytope, cell: number, place: Iso3, clip: readonly HalfSpace[], s: number): Polyhedron {
  const c = place.t;
  const rel: Iso3 = { m: place.m, t: [0, 0, 0] };
  const verts = CUBE_VERTICES.map((v) => isoApply(rel, v));
  let P = polyhedronFrom(verts, CUBE_FACES);
  // the faces' normals are exact images of the cube's axes (an orientation-reversing place keeps them outward)
  P = { faces: P.faces.map((f, i) => ({ verts: f.verts, n: isoLinear(place, CUBE_NORMALS[i]) })) };
  if (isoDet3(place) < 0) P = { faces: P.faces.map((f) => ({ verts: f.verts.slice().reverse(), n: f.n })) };
  const nc = (n: readonly number[]) => n[0] * c[0] + n[1] * c[1] + n[2] * c[2];
  for (const pl of topo(poly).cells[cell].planes) {
    P = clipPolyhedron(P, pl.n, pl.h * s - nc(pl.n), PART_CLIP_EPS);
    if (!P.faces.length) return P;
  }
  for (const h of clip) {
    P = clipPolyhedron(P, [h.n[0], h.n[1], h.n[2]], h.h - nc(h.n), PART_CLIP_EPS);
    if (!P.faces.length) return P;
  }
  return { faces: P.faces.map((f) => ({ verts: f.verts.map((v) => [v[0] + c[0], v[1] + c[1], v[2] + c[2]] as V3), n: f.n })) };
}

/** Clipping tolerance of partPolyhedron, in piece units (independent of s). */
export const PART_CLIP_EPS = 1e-12;

const CUBE_NORMALS: V3[] = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];

function isoDet3(T: Iso3): number {
  const m = T.m;
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

/** Parts thinner than this (in piece units) are dropped: they cannot hide an overlap deeper than it. */
export const PART_EPS = 1e-12;

/** The parts of one developed piece, with the cell-frame polyhedron for polytope pieces. */
export function partsOfDevelopment(poly: Polytope, piece: PieceName, index: number, dev: Development, s: number): { part: PiecePart; place: Iso3; poly: Polyhedron | null }[] {
  const out: { part: PiecePart; place: Iso3; poly: Polyhedron | null }[] = [];
  const r = pieceReach(piece);
  for (const node of dev.nodes) {
    const place = isoCompose(isoInverse(node.toAnchor), dev.pose);
    const clip = windowInCell(node, dev.u);
    let P: Polyhedron | null = null;
    if (piece === "ball") {
      // the ball reaches into the cell exactly when some ray of the window crosses the gate before length 1
      if (node.depth > 0 && node.gateDist >= r - PART_EPS) continue;
    } else {
      P = partPolyhedron(poly, node.cell, place, clip, s);
      if (!P.faces.length || polyhedronThickness(P) <= PART_EPS) continue;
    }
    // a ball is drawn as the unit ball under place.A, so its A carries the radius (the isometry times BALL_RADIUS)
    const affine = isoToAffine(place);
    if (piece === "ball") affine.A = affine.A.map((row) => row.map((x) => x * BALL_RADIUS));
    out.push({ part: { piece: index, cell: node.cell, chain: node.cells.slice(), place: affine, clip }, place, poly: P });
  }
  return out;
}

/**
 * The parts of every piece of a configuration (pieces in config order, each piece's parts in chain
 * order, the anchor's part first). Throws a ChainLimitError for configurations far too small for
 * their pieces.
 */
export function pieceParts(poly: Polytope, piece: PieceName, config: BoundaryConfig, opts: ChainOptions = {}): PiecePart[] {
  const out: PiecePart[] = [];
  config.pieces.forEach((p, i) => {
    const dev = developPiece(poly, piece, p, config.s, pieceReach(piece), opts);
    for (const x of partsOfDevelopment(poly, piece, i, dev, config.s)) out.push(x.part);
  });
  return out;
}

/**
 * A polytope piece's part as a mesh in its cell's frame (vertices and faces counter-clockwise seen
 * from outside), for drawing; null for balls (draw the ball cut by the cell and `clip`).
 */
export function partMesh(poly: Polytope, piece: PieceName, part: PiecePart, s: number): { vertices: number[][]; faces: number[][] } | null {
  if (piece === "ball") return null;
  const P = partPolyhedron(poly, part.cell, isoFromAffine(part.place), part.clip, s);
  const verts = polyhedronVertices(P);
  const find = (v: V3) => verts.findIndex((q) => Math.abs(q[0] - v[0]) <= 1e-12 && Math.abs(q[1] - v[1]) <= 1e-12 && Math.abs(q[2] - v[2]) <= 1e-12);
  return { vertices: verts.map((v) => [v[0], v[1], v[2]]), faces: P.faces.map((f) => f.verts.map(find)) };
}
