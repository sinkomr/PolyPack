/**
 * Piece geometry of the torus package with an explicit disk radius.
 *
 * Site units (what the API, the records and the validator speak): a disk piece (N = 0) has
 * DIAMETER 1, radius TORUS_DISK_RADIUS = 1/2 (the same number as DISK_RADIUS of
 * @polypack/geometry, which this package does not import for disks so that it stands alone);
 * a polygon piece has side 1. The stand-alone search (search.ts) keeps its old tuning by
 * running in WORKING units, where a disk has radius 1 (= 2 x site): it passes `rd = 1` here and
 * converts its result exactly (factor 2 is exact in binary64) at its edge. Polygons are the
 * same in both, and `rd` is ignored for them.
 */
import { type Pose, boundingRadius, pairPenetration, pieceArea, pieceSeparation } from "@polypack/geometry";
import { TORUS_DISK_RADIUS } from "./lattice";

/** Disk radius of the working units of the search (the radius-1 tuning). */
export const WORKING_DISK_RADIUS = 1;

/** Radius of the smallest circle about the centre that holds the piece. */
export function reachOf(N: number, rd = TORUS_DISK_RADIUS): number {
  return N === 0 ? rd : boundingRadius(N);
}

export function areaOf(N: number, rd = TORUS_DISK_RADIUS): number {
  return N === 0 ? Math.PI * rd * rd : pieceArea(N);
}

/** Separation of two congruent pieces (exact distance minus the diameters for disks). */
export function separationOf(N: number, a: Pose, b: Pose, scale = 1, rd = TORUS_DISK_RADIUS): number {
  if (N !== 0) return pieceSeparation(N, a, b, scale).sep;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  return d === 0 ? -2 * rd * scale : d - 2 * rd * scale;
}

/** Same pair penetration as @polypack/geometry's, with the disk of radius `rd`. */
export function penetrationOf(
  N: number,
  a: Pose,
  b: Pose,
  axesA: Float64Array | undefined,
  axesB: Float64Array | undefined,
  scale: number,
  padding: number,
  rd = TORUS_DISK_RADIUS,
): ReturnType<typeof pairPenetration> {
  if (N !== 0) return pairPenetration(N, a, b, axesA, axesB, scale, padding);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const distance = Math.hypot(dx, dy);
  // coincident centres: a bounded subgradient that separates the pair
  const ux = distance === 0 ? 1 : dx / distance;
  const uy = distance === 0 ? 0 : dy / distance;
  return {
    depth: 2 * (rd * scale + padding) - distance,
    a: { x: -ux, y: -uy, theta: 0 },
    b: { x: ux, y: uy, theta: 0 },
  };
}
