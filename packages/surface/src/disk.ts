/**
 * Disk pieces of the surface package: site units and the kernels' working scale.
 *
 * Site units (what the API, the records and the validator speak): a disk piece (N = 0) has
 * DIAMETER 1, radius SURFACE_DISK_RADIUS = 1/2 (the same number as DISK_RADIUS of
 * @polypack/geometry, which this package does not import for disks so that it stands alone);
 * a polygon piece has side 1. Before 2026-10-27 disks had radius 1 and every disk score s was
 * twice as large, with the same poses on the solid of edge 1.
 *
 * Inside, the kernels, the searches and the parts (parts.ts, search/*, kernel-*.ts) work on the
 * solid of edge 1 with pieces "at scale lam" = the piece times lam, where a polygon has side lam
 * and a disk has RADIUS lam (a disk of the old radius-1 convention). The edge s of the solid in
 * piece units is then s = 1 / lam for polygons and s = RD / lam for disks (RD = 1/2), because a
 * disk of diameter 1 on the solid of edge s has radius RD / s on the solid of edge 1. scaleFor and
 * sizeFor are that map and its inverse (factor 2, exact), so the trajectory of a seeded search is
 * the one it had before the change (only s halves), and the validator (validate.ts), which takes
 * site configurations, gets `s` from sizeFor. Code that develops a search's output (packages/spaces
 * surface-fold.ts, the scripts) converts lam and s with these two functions.
 */
import { type Pose, boundingRadius, pieceArea, pieceSeparation } from "@polypack/geometry";

export const SURFACE_DISK_RADIUS = 0.5;

/** The kernels' scale lam (polygon scale, disk radius on the unit solid) at edge s in piece units. */
export function scaleFor(N: number, s: number): number {
  return (N === 0 ? SURFACE_DISK_RADIUS : 1) / s;
}

/** The edge s in piece units at the kernels' scale lam: the inverse of scaleFor. */
export function sizeFor(N: number, lam: number): number {
  return (N === 0 ? SURFACE_DISK_RADIUS : 1) / lam;
}

/** Circumradius of the piece at scale 1 of the kernels' convention (disks: 1, a disk of radius lam at scale lam). */
export function innerReach(N: number): number {
  return N === 0 ? 1 : boundingRadius(N);
}

/** Area of the piece at scale 1 of the kernels' convention (disks: pi). */
export function innerArea(N: number): number {
  return N === 0 ? Math.PI : pieceArea(N);
}

/** Radius of the smallest circle about the centre that holds the true piece, in site units. */
export function pieceReach(N: number): number {
  return N === 0 ? SURFACE_DISK_RADIUS : boundingRadius(N);
}

/** Area of the true piece, in site units. */
export function pieceAreaOf(N: number): number {
  return N === 0 ? Math.PI * SURFACE_DISK_RADIUS * SURFACE_DISK_RADIUS : pieceArea(N);
}

/** Separation of two congruent pieces of scale `scale` (true pieces times scale) in one plane, site units. */
export function planarSeparation(N: number, a: Pose, b: Pose, scale = 1): number {
  if (N !== 0) return pieceSeparation(N, a, b, scale).sep;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  return d === 0 ? -2 * SURFACE_DISK_RADIUS * scale : d - 2 * SURFACE_DISK_RADIUS * scale;
}

/** Area lower bound on the side of a regular M-gon (M >= 3) that holds k pieces: k true pieces' area <= the M-gon's. */
export function faceAreaLowerBound(N: number, M: number, k: number): number {
  return Math.sqrt((k * pieceAreaOf(N) * 4 * Math.tan(Math.PI / M)) / M);
}

/** The `scale` argument of parts.ts (pieceParts, piecePolygon, pieceOutline) for pieces of the given true scale: a disk's is its radius. */
export function partsScale(N: number, scale = 1): number {
  return N === 0 ? scale * SURFACE_DISK_RADIUS : scale;
}
