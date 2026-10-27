/**
 * Problem and configuration types for PolyPack's constant-curvature family `curved/K/N/M/P`.
 *
 * Pose (x, y, theta) of a piece: the piece is G(standard piece) with G = T(c) R(theta), where
 *   - the standard piece is centred at the container centre O with vertex k at direction
 *     theta_k = pi/2 + 2 pi k / N (a vertex straight up) and geodesic circumradius R_K(N);
 *   - R(theta) is the rotation about O by theta (counter-clockwise);
 *   - c = exp_O(x, y) is the point at geodesic distance sqrt(x^2 + y^2) from O in direction (x, y);
 *   - T(c) is the transvection along the geodesic from O to c.
 * So theta is the orientation at c relative to the frame parallel-transported from O along Oc. At K = 0
 * this is exactly PolyPack's Euclidean pose. The container is centred at O with phi = 0 (horizontal
 * bottom edge): wall k has outward normal angle -pi/2 + 2 pi k / M at distance h (apothem) from O.
 */
import {
  pieceGeometry,
  apothemFromSide,
  idealApothem,
  maxContainerSize,
  pieceExists,
  type PieceGeometry,
} from "./shapes";
import { polarPoint, poseMotion, applyPoint, lineCovector, type LPoint, type Motion } from "./space";
import { pieceEdgeAngle, pieceVertexAngle, wallAngle } from "./shapes";

export interface CurvedProblem {
  /** 0 = disk of diameter 1 (radius 1/2, DISK_RADIUS), else regular N-gon of side 1 */
  N: number;
  /** 0 = disk container (scored by its diameter), else regular M-gon of side s */
  M: number;
  P: number;
}

export interface CurvedPose {
  x: number;
  y: number;
  theta: number;
}

export interface CurvedConfig {
  /** container size: side s (M >= 3) or DIAMETER (M = 0; its radius is size / 2) */
  size: number;
  pieces: CurvedPose[];
}

export function problemId(K: number, p: CurvedProblem): string {
  return `curved/${K}/${p.N}/${p.M}/${p.P}`;
}

/** Shared per-(N, M, K) data used by the evaluator, solver and validator. */
export interface Space {
  K: number;
  N: number;
  M: number;
  piece: PieceGeometry;
  /** standard-piece vertices in lifted coordinates (empty for disks) */
  vertices: LPoint[];
  /** standard-piece outward edge covectors (Qd = 1); edge e joins vertex e and e+1 */
  edges: [number, number, number][];
  /** wall outward normal angles */
  wallAngles: number[];
  /** upper limit of the container variable t (apothem or radius) */
  tMax: number;
}

const spaceCache = new Map<string, Space>();

export function makeSpace(K: number, N: number, M: number): Space {
  const key = `${K}|${N}|${M}`;
  const hit = spaceCache.get(key);
  if (hit) return hit;
  if (!Number.isFinite(K)) throw new RangeError("K must be finite");
  if (!(N === 0 || (Number.isInteger(N) && N >= 3 && N <= 100))) throw new RangeError("bad N");
  if (!(M === 0 || (Number.isInteger(M) && M >= 3 && M <= 100))) throw new RangeError("bad M");
  if (!pieceExists(N, K)) throw new RangeError(`no unit piece N=${N} exists at K=${K}`);
  const piece = pieceGeometry(N, K);
  const vertices: LPoint[] = [];
  const edges: [number, number, number][] = [];
  for (let k = 0; k < N; k++) {
    vertices.push(polarPoint(K, piece.R, pieceVertexAngle(N, k)));
    edges.push(lineCovector(K, piece.rho, pieceEdgeAngle(N, k)));
  }
  const wallAngles = M === 0 ? [] : Array.from({ length: M }, (_, k) => wallAngle(M, k));
  let tMax = Infinity;
  if (K > 0) tMax = Math.PI / (2 * Math.sqrt(K));
  if (K < 0 && M > 0) tMax = idealApothem(M, K);
  const space: Space = { K, N, M, piece, vertices, edges, wallAngles, tMax };
  spaceCache.set(key, space);
  return space;
}

/** Container variable t (apothem h or radius r) from the size. */
export function containerT(space: Space, size: number): number {
  return apothemFromSide(space.M, space.K, size);
}

/** World-frame lifted vertices of one piece (the centre for a disk). */
export function pieceWorld(space: Space, pose: CurvedPose): { G: Motion; centre: LPoint; verts: LPoint[] } {
  const G = poseMotion(space.K, pose.x, pose.y, pose.theta);
  const centre: LPoint = { e: G.b[0], x: G.b[1], y: G.b[2] };
  const verts = space.vertices.map((v) => applyPoint(G, v));
  return { G, centre, verts };
}

export function isFinitePose(p: CurvedPose): boolean {
  return (
    p !== null && typeof p === "object" && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.theta)
  );
}
