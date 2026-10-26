import { TOL, inradius, pieceSeparation, pieceVertices } from "@polypack/geometry";
import { ChainNode, enumerateChains, inWedge } from "./chains";
import { Part, SurfacePose, partSeparation, pieceChains, pieceParts } from "./parts";
import { apply } from "./rigid";
import { Solid, SolidName, faceApothem, faceDepth, faceVertex, getSolid, isSolidName, surfaceArea } from "./solids";

export type Mode = "fold" | "nofold";

/** A configuration on a solid of edge s. Pieces have side 1 (N >= 3) or radius 1 (N = 0). */
export interface SurfaceConfig {
  solid: SolidName;
  N: number;
  s: number;
  pieces: SurfacePose[];
}

export interface Validation {
  ok: boolean;
  errors: string[];
  /** smallest signed clearance found between pieces (or parts of one piece), in piece units */
  minPairSep: number;
  /** smallest clearance between a piece interior and a cone point (negative: cone point inside) */
  minConeSep: number;
  /** smallest clearance of a piece to its face boundary (nofold only) */
  minWallSep: number;
}

export interface ValidateOptions {
  tol?: number;
  /** pieces scaled about their centres (1 = unit pieces) */
  scale?: number;
  /** stop collecting errors after this many */
  maxErrors?: number;
  /** fold: most chains of faces per piece; more throw a ChainLimitError (default: no limit) */
  maxChains?: number;
}

/** Signed distance of (x, y) inside the regular M-gon face of side s (positive inside), in its frame. See also faceDepth. */
export function insideFaceDepth(M: number, s: number, x: number, y: number): number {
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

function checkShape(cfg: SurfaceConfig, errors: string[]): Solid | null {
  if (!isSolidName(cfg.solid)) {
    errors.push(`unknown solid ${String(cfg.solid)}`);
    return null;
  }
  const solid = getSolid(cfg.solid);
  if (!(Number.isInteger(cfg.N) && (cfg.N === 0 || cfg.N >= 3))) errors.push("N must be 0 or an integer >= 3");
  if (!(typeof cfg.s === "number" && Number.isFinite(cfg.s) && cfg.s > 0)) errors.push("s must be a positive finite number");
  if (!Array.isArray(cfg.pieces) || cfg.pieces.length === 0) errors.push("pieces must be a non-empty array");
  if (errors.length) return null;
  cfg.pieces.forEach((p, i) => {
    if (!p || !Number.isInteger(p.face) || p.face < 0 || p.face >= solid.F) errors.push(`pieces[${i}].face out of range`);
    else if (![p.x, p.y, p.theta].every((v) => typeof v === "number" && Number.isFinite(v)))
      errors.push(`pieces[${i}] needs finite x, y, theta`);
  });
  return errors.length ? null : solid;
}

const empty = (errors: string[]): Validation => ({ ok: false, errors, minPairSep: NaN, minConeSep: NaN, minWallSep: NaN });

/**
 * nofold: every piece lies in its closed anchor face; pieces on one face have disjoint interiors.
 * Faces meet only along edges, so pieces on different faces never overlap.
 */
export function validateNofold(cfg: SurfaceConfig, opts: ValidateOptions = {}): Validation {
  const tol = opts.tol ?? TOL;
  const scale = opts.scale ?? 1;
  const errors: string[] = [];
  const solid = checkShape(cfg, errors);
  if (!solid) return empty(errors);
  const { N, s } = cfg;
  let minWall = Infinity;
  let minPair = Infinity;
  cfg.pieces.forEach((p, i) => {
    let depth: number;
    if (N === 0) depth = faceDepth(solid, s, p.face, p.x, p.y) - scale;
    else {
      const v = pieceVertices(N, p, scale);
      depth = Infinity;
      for (let k = 0; k < N; k++) depth = Math.min(depth, faceDepth(solid, s, p.face, v[2 * k], v[2 * k + 1]));
    }
    minWall = Math.min(minWall, depth);
    if (depth < -tol) errors.push(`piece ${i} leaves face ${p.face} by ${-depth}`);
  });
  for (let i = 0; i < cfg.pieces.length; i++)
    for (let j = i + 1; j < cfg.pieces.length; j++) {
      const a = cfg.pieces[i];
      const b = cfg.pieces[j];
      if (a.face !== b.face) continue;
      const sep = pieceSeparation(N, a, b, scale).sep;
      minPair = Math.min(minPair, sep);
      if (sep < -tol) errors.push(`pieces ${i} and ${j} overlap on face ${a.face} by ${-sep}`);
    }
  return { ok: errors.length === 0, errors, minPairSep: minPair, minConeSep: Infinity, minWallSep: minWall };
}

/** Developed images of a point q (face fq, frame coords) seen from p along chains: [x, y, length]. */
export function chainImages(nodes: ChainNode[], px: number, py: number, fq: number, qx: number, qy: number, tol = 1e-9, skipRoot = false): [number, number, number][] {
  const out: [number, number, number][] = [];
  nodes.forEach((node, idx) => {
    if (node.face !== fq || (skipRoot && idx === 0)) return;
    const [x, y] = apply(node.toAnchor, qx, qy);
    if (!inWedge(node.wedge, px, py, x, y, tol)) return;
    out.push([x, y, Math.hypot(x - px, y - py)]);
  });
  return out;
}

/**
 * Surface (geodesic) distance between two points, valid when it is at most `reach`; otherwise
 * returns Infinity. Shortest paths avoid the vertices, so they unfold into straight segments.
 */
export function surfaceDistance(solid: Solid, s: number, p: { face: number; x: number; y: number }, q: { face: number; x: number; y: number }, reach: number): number {
  const nodes = enumerateChains(solid, s, p.face, p.x, p.y, reach);
  let best = Infinity;
  for (const [, , d] of chainImages(nodes, p.x, p.y, q.face, q.x, q.y, 1e-12)) if (d < best) best = d;
  return best <= reach + 1e-12 ? best : Infinity;
}

/** Cone-point clearance of piece i: smallest distance of a vertex to the piece's boundary (negative = inside). */
function coneClearance(solid: Solid, s: number, N: number, pose: SurfacePose, nodes: ChainNode[], scale: number, tol: number): number {
  let worst = Infinity;
  const rin = N === 0 ? scale : inradius(N) * scale;
  for (const node of nodes) {
    const M = solid.sides[node.face];
    for (let k = 0; k < M; k++) {
      const [fx, fy] = faceVertex(solid, s, node.face, k);
      const [x, y] = apply(node.toAnchor, fx, fy);
      if (!inWedge(node.wedge, pose.x, pose.y, x, y, tol)) continue;
      let out: number;
      if (N === 0) out = Math.hypot(x - pose.x, y - pose.y) - scale;
      else {
        // largest support excess over the apothem: > 0 means outside the polygon
        out = -Infinity;
        for (let j = 0; j < N; j++) {
          const a = pose.theta + Math.PI / 2 + Math.PI / N + (2 * Math.PI * j) / N;
          out = Math.max(out, (x - pose.x) * Math.cos(a) + (y - pose.y) * Math.sin(a) - rin);
        }
      }
      if (out < worst) worst = out;
    }
  }
  return worst;
}

/**
 * fold: rigid flat pieces developed from their centres across edges.
 * Valid when (1) every centre lies in its closed anchor face, (2) no cone point lies in the open
 * interior of a piece, (3) on every face, the parts of all pieces (two parts of one piece included)
 * have disjoint interiors. (3) for parts of one piece is the embedding condition.
 * Disks use the equivalent distance form (see docs): vertex distance >= 1, centre distance >= 2,
 * geodesic loops at a centre >= 2.
 */
export function validateFold(cfg: SurfaceConfig, opts: ValidateOptions = {}): Validation {
  const tol = opts.tol ?? TOL;
  const scale = opts.scale ?? 1;
  const maxErrors = opts.maxErrors ?? 50;
  const maxChains = opts.maxChains ?? Infinity;
  const errors: string[] = [];
  const solid = checkShape(cfg, errors);
  if (!solid) return empty(errors);
  const { N, s } = cfg;
  const push = (e: string) => {
    if (errors.length < maxErrors) errors.push(e);
  };
  let minPair = Infinity;
  let minCone = Infinity;
  cfg.pieces.forEach((p, i) => {
    const d = faceDepth(solid, s, p.face, p.x, p.y);
    if (d < -tol) push(`centre of piece ${i} is outside its face ${p.face} by ${-d}`);
  });
  if (errors.length) return { ok: false, errors, minPairSep: NaN, minConeSep: NaN, minWallSep: Infinity };

  if (N === 0) {
    const reach = 2 * scale;
    const nodes = cfg.pieces.map((p) => enumerateChains(solid, s, p.face, p.x, p.y, reach, maxChains));
    cfg.pieces.forEach((p, i) => {
      const c = coneClearance(solid, s, 0, p, nodes[i], scale, tol);
      minCone = Math.min(minCone, c);
      if (c < -tol) push(`a cone point lies inside disk ${i} (by ${-c})`);
      // Images use the exact wedge (tolerance 0): an image on a wedge boundary is a path through a
      // vertex, of length d(p, V) + d(V, q), which the vertex check already bounds below by 2, and
      // a tolerance would admit paths that do not exist (slightly shorter than 2 near a touched vertex).
      for (const [, , d] of chainImages(nodes[i], p.x, p.y, p.face, p.x, p.y, 0, true)) {
        const sep = d - 2 * scale;
        minPair = Math.min(minPair, sep);
        if (sep < -tol) push(`disk ${i} wraps onto itself (geodesic loop ${d})`);
      }
      for (let j = i + 1; j < cfg.pieces.length; j++) {
        const q = cfg.pieces[j];
        for (const [, , d] of chainImages(nodes[i], p.x, p.y, q.face, q.x, q.y, 0)) {
          const sep = d - 2 * scale;
          minPair = Math.min(minPair, sep);
          if (sep < -tol) push(`disks ${i} and ${j} overlap (centre distance ${d})`);
        }
      }
    });
    return { ok: errors.length === 0, errors, minPairSep: minPair, minConeSep: minCone, minWallSep: Infinity };
  }

  const byFace: Part[][] = Array.from({ length: solid.F }, () => []);
  cfg.pieces.forEach((p, i) => {
    const nodes = pieceChains(solid, s, N, p, scale, maxChains);
    const c = coneClearance(solid, s, N, p, nodes, scale, tol);
    minCone = Math.min(minCone, c);
    if (c < -tol) push(`a cone point lies inside piece ${i} (depth ${-c})`);
    for (const part of pieceParts(solid, s, N, p, i, scale, nodes)) if (part.poly.length >= 6) byFace[part.face].push(part);
  });
  for (let f = 0; f < solid.F; f++) {
    const list = byFace[f];
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a];
        const B = list[b];
        // axes from the half-planes the parts were cut from, not from their clipped sides (parts.ts)
        const sep = partSeparation(A, B);
        minPair = Math.min(minPair, sep);
        if (sep < -tol) {
          if (A.piece === B.piece) push(`piece ${A.piece} overlaps itself on face ${f} (depth ${-sep})`);
          else push(`pieces ${A.piece} and ${B.piece} overlap on face ${f} (depth ${-sep})`);
        }
      }
  }
  return { ok: errors.length === 0, errors, minPairSep: minPair, minConeSep: minCone, minWallSep: Infinity };
}

export function validate(cfg: SurfaceConfig, mode: Mode, opts: ValidateOptions = {}): Validation {
  return mode === "fold" ? validateFold(cfg, opts) : validateNofold(cfg, opts);
}

/** Area lower bound on the scale s (the edge, for unit-edge solids): P * pieceArea <= surface area. */
export function areaBoundEdge(solidName: SolidName, N: number, P: number): number {
  const solid = getSolid(solidName);
  const A = N === 0 ? Math.PI : N / (4 * Math.tan(Math.PI / N));
  // Platonic: surface area at edge s is F * M s^2 / (4 tan(pi/M)), computed as before
  if (solid.uniform) return Math.sqrt((P * A * 4 * Math.tan(Math.PI / solid.M)) / (solid.F * solid.M));
  return Math.sqrt((P * A) / surfaceArea(solid, 1));
}
