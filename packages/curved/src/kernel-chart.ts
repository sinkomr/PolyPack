/**
 * Charts of the curved kernel (kernel.ts): each piece's pose is an anchor pose times a small
 * offset in the anchor's own frame.
 *
 * Anchor. A pose (x, y, theta) in the package's exponential coordinates (problem.ts): the motion
 * A = T(exp_O(x, y)) R(theta). Anchors are kept exactly as a configuration states them, so a
 * configuration read with fromConfig comes back unchanged from toConfig.
 *
 * Offset. The chart variables (u, v, phi) of piece i give the motion G = A T(u, v) R(phi): the
 * anchored piece moved by the transvection that takes its centre a geodesic distance
 * sqrt(u^2 + v^2) in the direction (u, v) of its own frame, then turned by phi about its centre.
 * These are the exponential coordinates of the piece's frame, so a unit of u or v moves the piece
 * by exactly one geodesic length unit at every curvature and anywhere in the plane, and a unit of
 * phi turns it by one radian. (Exponential coordinates about O would not: far from O at K < 0 a
 * unit of y moves a piece by about sinh(r) / r units.) Disks have no phi (dim 2).
 *
 * Gradients. dG = G * (body velocity), with the body velocity of A T(u, v) R(phi) equal to that of
 * T(u, v) R(phi) because A is fixed: bodyJacobian(K, u, v, phi). The package's rows built with that
 * Jacobian (pieceStateOf) are therefore differentiated with respect to (u, v, phi) directly.
 *
 * Rebase. The pose of A T(u, v) R(phi) is read back (poseOfMotion) and becomes the new anchor;
 * the offsets become 0. The configuration changes only by rounding.
 */
import { type CurvedPose, type Space } from "./problem";
import { type PieceState, pieceStateOf } from "./evaluate";
import {
  type LPoint,
  type Motion,
  applyPoint,
  bodyJacobian,
  compose,
  logO,
  poseMotion,
  poseMotionInverse,
  transvection,
} from "./space";

/** The kernel's per-state data (KernelState.aux). */
export interface CurvedAux {
  /** Anchor poses, one per piece, in exponential coordinates about O. */
  anchors: CurvedPose[];
  /** Their motions T(x, y) R(theta) and inverses; derived from anchors, never changed in place. */
  motions: Motion[];
  inverses: Motion[];
  /** Soft-shape parameter of the capability "shape": 1 is the true shape. */
  shape: number;
}

const IDENTITY_JACOBIAN = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function makeAux(K: number, anchors: CurvedPose[], shape = 1): CurvedAux {
  return {
    anchors,
    motions: anchors.map((a) => poseMotion(K, a.x, a.y, a.theta)),
    inverses: anchors.map((a) => poseMotionInverse(K, a.x, a.y, a.theta)),
    shape,
  };
}

export function cloneAux(a: CurvedAux): CurvedAux {
  return {
    anchors: a.anchors.map((p) => ({ x: p.x, y: p.y, theta: p.theta })),
    motions: a.motions.slice(),
    inverses: a.inverses.slice(),
    shape: a.shape,
  };
}

/** Sets anchor i to pose p. */
export function setAnchor(K: number, a: CurvedAux, i: number, p: CurvedPose): void {
  a.anchors[i] = { x: p.x, y: p.y, theta: p.theta };
  a.motions[i] = poseMotion(K, p.x, p.y, p.theta);
  a.inverses[i] = poseMotionInverse(K, p.x, p.y, p.theta);
}

/** Pose (x, y, theta) of a motion G = T(exp_O(x, y)) R(theta): the inverse of poseMotion. */
export function poseOfMotion(K: number, G: Motion): CurvedPose {
  const { x, y } = logO(K, { e: G.b[0], x: G.b[1], y: G.b[2] });
  // T(-x, -y) G is the rotation R(theta) about O: rows 1 and 2 hold (cos, -sin; sin, cos)
  const R = compose(transvection(K, -x, -y), G);
  return { x, y, theta: Math.atan2(R.L[7], R.L[4]) };
}

/** A pose with its centre's geodesic polar radius about O scaled by lambda (exponential coordinates are polar). */
export function scalePose(p: CurvedPose, lambda: number): CurvedPose {
  return { x: lambda * p.x, y: lambda * p.y, theta: p.theta };
}

/** The chart offsets (u, v, phi) of piece i; phi is 0 for disks (dim 2). */
export function offsets(x: Float64Array, dim: number, i: number): [number, number, number] {
  return [x[i * dim], x[i * dim + 1], dim === 3 ? x[i * dim + 2] : 0];
}

/** The motion of piece i and its inverse, with the Jacobian from its chart offsets to its body velocity. */
export function pieceMotion(
  K: number,
  aux: CurvedAux,
  x: Float64Array,
  dim: number,
  i: number,
): { G: Motion; Ginv: Motion; Jb: Float64Array } {
  const [u, v, phi] = offsets(x, dim, i);
  if (u === 0 && v === 0 && phi === 0) return { G: aux.motions[i], Ginv: aux.inverses[i], Jb: IDENTITY_JACOBIAN };
  return {
    G: compose(aux.motions[i], poseMotion(K, u, v, phi)),
    Ginv: compose(poseMotionInverse(K, u, v, phi), aux.inverses[i]),
    Jb: bodyJacobian(K, u, v, phi),
  };
}

/** The pose of piece i in exponential coordinates: its anchor itself when its offsets are 0. */
export function piecePose(K: number, aux: CurvedAux, x: Float64Array, dim: number, i: number): CurvedPose {
  const [u, v, phi] = offsets(x, dim, i);
  const a = aux.anchors[i];
  if (u === 0 && v === 0 && phi === 0) return { x: a.x, y: a.y, theta: a.theta };
  return poseOfMotion(K, compose(aux.motions[i], poseMotion(K, u, v, phi)));
}

/** The centre of piece i (lifted coordinates), without its vertices. */
export function pieceCentre(K: number, aux: CurvedAux, x: Float64Array, dim: number, i: number): LPoint {
  const { G } = pieceMotion(K, aux, x, dim, i);
  return { e: G.b[0], x: G.b[1], y: G.b[2] };
}

/** The full state (vertices, edges, gradients in chart offsets) of piece i. */
export function chartPieceState(space: Space, aux: CurvedAux, x: Float64Array, dim: number, i: number): PieceState {
  const { G, Ginv, Jb } = pieceMotion(space.K, aux, x, dim, i);
  const centre: LPoint = { e: G.b[0], x: G.b[1], y: G.b[2] };
  return pieceStateOf(
    space,
    G,
    Ginv,
    centre,
    space.vertices.map((v) => applyPoint(G, v)),
    Jb,
  );
}

/** Folds the offsets of every piece into its anchor. */
export function rebaseAll(K: number, aux: CurvedAux, x: Float64Array, dim: number, P: number): void {
  for (let i = 0; i < P; i++) {
    const [u, v, phi] = offsets(x, dim, i);
    if (u === 0 && v === 0 && phi === 0) continue;
    setAnchor(K, aux, i, piecePose(K, aux, x, dim, i));
    for (let a = 0; a < dim; a++) x[i * dim + a] = 0;
  }
}
