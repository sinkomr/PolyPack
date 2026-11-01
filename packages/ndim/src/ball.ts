/**
 * Balls as pieces and containers (centre plus radius). Lengths are in the catalogue's units: a ball piece has
 * diameter 1 (radius BALL_RADIUS); a ball container of scale s has diameter s.
 */
import { dot } from "./linalg";
import type { Polytope } from "./polytope";

/** Gap between two balls: the distance of the centres minus the radii (negative: overlap depth). */
export function ballPairGap(c1: ArrayLike<number>, r1: number, c2: ArrayLike<number>, r2: number, d: number): number {
  let s = 0;
  for (let i = 0; i < d; i++) s += (c1[i] - c2[i]) ** 2;
  return Math.sqrt(s) - r1 - r2;
}

/** Gap between a ball (centre c, radius r) and facet f of a polytope scaled by s: s b_f - N_f . c - r (negative: protrusion). */
export function ballFacetGap(c: ArrayLike<number>, r: number, P: Polytope, f: number, s: number): number {
  return s * P.b[f] - dot(P.N, c, P.d, f * P.d, 0) - r;
}

/** Smallest gap of a ball to the facets of a polytope scaled by s: the distance from the ball to the polytope's boundary from inside. */
export function ballWallGap(c: ArrayLike<number>, r: number, P: Polytope, s: number): number {
  let g = Infinity;
  for (let f = 0; f < P.nF; f++) g = Math.min(g, ballFacetGap(c, r, P, f, s));
  return g;
}

/** Gap between a ball and the inside of a ball container of radius R centred at the origin: R - |c| - r. */
export function ballInBallGap(c: ArrayLike<number>, r: number, R: number, d: number): number {
  return R - Math.sqrt(dot(c, c, d)) - r;
}
