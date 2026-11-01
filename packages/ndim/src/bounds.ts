/**
 * Volumes and radii for bounds (docs/spaces/NDIM.md §6).
 */
import { BALL, BALL_RADIUS, type NdProblem } from "./problem";
import { polytopeInfo } from "./polytope";

/** Volume of the d-ball of radius r: pi^(d/2) / Gamma(d/2 + 1) r^d, by the recurrence V_d = 2 pi / d V_(d-2). */
export function ballVolume(d: number, r = 1): number {
  let v = d % 2 === 0 ? 1 : 2;
  for (let k = d % 2 === 0 ? 2 : 3; k <= d; k += 2) v *= (2 * Math.PI) / k;
  return v * r ** d;
}

/** Volume of a shape at scale 1: a unit-edge polytope, or the ball of diameter 1. */
export function unitVolume(d: number, shape: string): number {
  return shape === BALL ? ballVolume(d, BALL_RADIUS) : polytopeInfo(shape).volume;
}

/** Inradius of a shape at scale 1. */
export function unitInradius(shape: string): number {
  return shape === BALL ? BALL_RADIUS : polytopeInfo(shape).inradius;
}

/** Circumradius of a shape at scale 1 (the radius of the ball about the centroid that holds it). */
export function unitCircumradius(shape: string): number {
  return shape === BALL ? BALL_RADIUS : polytopeInfo(shape).circumradius;
}

/** The volume bound on the container scale: P vol(piece) <= s^d vol(container), so s >= (P vol(piece) / vol(container))^(1/d). */
export function volumeBound(problem: NdProblem, count: number): number {
  const ratio = (count * unitVolume(problem.d, problem.piece)) / unitVolume(problem.d, problem.container);
  return ratio ** (1 / problem.d);
}

/**
 * The bound from one piece: it contains a ball of radius r_in(piece) about its centroid, which must fit in the container
 * s C (s r_in(C) >= r_in(piece) for a centred container; since a ball in a convex body has radius at most the inradius of
 * the body, this holds wherever the piece sits).
 */
export function inradiusBound(problem: NdProblem): number {
  return unitInradius(problem.piece) / unitInradius(problem.container);
}

/** The largest P the volume allows at scale s: floor(s^d vol(container) / vol(piece)). */
export function maxPiecesByVolume(problem: NdProblem, s: number): number {
  return Math.floor(
    (s ** problem.d * unitVolume(problem.d, problem.container)) / unitVolume(problem.d, problem.piece) + 1e-9,
  );
}

/** The best of the volume and one-piece bounds, with the name of the one that gives it. */
export function lowerBound(problem: NdProblem, count: number): { value: number; kind: "volume" | "inradius" } {
  const v = volumeBound(problem, count);
  const r = inradiusBound(problem);
  return v >= r ? { value: v, kind: "volume" } : { value: r, kind: "inradius" };
}
