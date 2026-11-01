/**
 * A problem of the nD spaces: P equal pieces in the smallest scaled container (docs/spaces/NDIM.md §1).
 *
 * The piece is a catalogue polytope of unit edge or a ball of diameter 1; the container, centred at the origin, is the
 * polytope scaled by s or the ball of diameter s. The score is s; smaller is better. A shape is named by its catalogue
 * code ("5:demi") or "ball".
 */
import { getPolytope, isLoaded, polytopeInfo, type Polytope } from "./polytope";

export const BALL = "ball";
/** Radius of a ball piece, and of a ball container at s = 1. */
export const BALL_RADIUS = 0.5;

export interface NdProblem {
  /** Dimension, 4 to 10. */
  d: number;
  /** Catalogue code of the piece, or "ball". */
  piece: string;
  /** Catalogue code of the container, or "ball". */
  container: string;
}

/** A configuration: the container scale and one pose per piece (see pose.ts for the formats). */
export interface NdConfig {
  s: number;
  pieces: number[][];
}

export const MIN_DIM = 4;
export const MAX_DIM = 10;

/** The errors of a problem description (empty when it is well formed and its polytopes are loaded). */
export function problemErrors(problem: unknown): string[] {
  if (typeof problem !== "object" || problem === null || Array.isArray(problem))
    return ["problem must be an object {d, piece, container}"];
  const p = problem as Record<string, unknown>;
  const errors: string[] = [];
  if (!Number.isInteger(p.d) || (p.d as number) < MIN_DIM || (p.d as number) > MAX_DIM) {
    errors.push(`d must be an integer from ${MIN_DIM} to ${MAX_DIM}`);
    return errors;
  }
  for (const key of ["piece", "container"] as const) {
    const v = p[key];
    if (v === BALL) continue;
    if (typeof v !== "string") {
      errors.push(`${key} must be a catalogue code or "ball"`);
      continue;
    }
    let info;
    try {
      info = polytopeInfo(v);
    } catch {
      errors.push(`unknown ${key} ${JSON.stringify(v)}`);
      continue;
    }
    if (info.d !== p.d) errors.push(`${key} ${v} is not ${p.d}-dimensional`);
    else if (!isLoaded(v))
      errors.push(`${key} ${v} is loaded on demand: await loadPolytope(${JSON.stringify(v)}) first`);
  }
  return errors;
}

/** The polytope of a shape name, or null for "ball". */
export function shapePolytope(code: string): Polytope | null {
  return code === BALL ? null : getPolytope(code);
}
