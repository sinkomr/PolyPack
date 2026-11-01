/**
 * Hard caps on the size of a configuration, enforced by configErrors / validateNd before any pose is read or any vertex
 * is placed (docs/spaces/NDIM.md §4). They bound the work and the memory of the validator on untrusted input: the
 * world vertices of the pieces take P nV d numbers, the wall test up to P nV nF inequalities, and the pair test one
 * GJK / EPA per near pair.
 *
 * The defaults are the planned domains: 40 pieces in 4D, 32 in 5D, 24 in 6D, 20 in 7D to 10D, and up to MAX_BALL_PIECES
 * balls (a ball pair costs one distance). A trusted caller (tests, offline tools, the exact certifier's fixtures) may
 * raise them with ValidateOptions.limits, never above the HARD_* ceilings; a server must not take the limits from the
 * request.
 */
import type { NdProblem } from "./problem";
import { BALL, shapePolytope } from "./problem";

/** Largest number of polytope pieces by dimension. */
export const MAX_PIECES_BY_DIM: Readonly<Record<number, number>> = {
  4: 40,
  5: 32,
  6: 24,
  7: 20,
  8: 20,
  9: 20,
  10: 20,
};
/** Largest number of ball pieces, in any dimension. */
export const MAX_BALL_PIECES = 400;
/** Largest P * nV * d (the world vertices of the pieces are 8 bytes each: 4 MB at the default). */
export const MAX_VERTEX_WORK = 500_000;
/** Largest P * nV * nF (vertex-facet inequalities of the wall test, before its prefilters). */
export const MAX_WALL_WORK = 200_000_000;

/** The ceilings no override can exceed. */
export const HARD_MAX_PIECES = 256;
export const HARD_MAX_BALL_PIECES = 1024;
export const HARD_MAX_VERTEX_WORK = 8_000_000;
export const HARD_MAX_WALL_WORK = 4_000_000_000;

export interface NdLimits {
  maxPieces: number;
  maxVertexWork: number;
  maxWallWork: number;
}

/** The default limits of a problem. */
export function defaultLimits(problem: Pick<NdProblem, "d" | "piece">): NdLimits {
  return {
    maxPieces: problem.piece === BALL ? MAX_BALL_PIECES : (MAX_PIECES_BY_DIM[problem.d] ?? 20),
    maxVertexWork: MAX_VERTEX_WORK,
    maxWallWork: MAX_WALL_WORK,
  };
}

/** The limits in force: the defaults, replaced field by field by `override`, never above the hard ceilings. */
export function effectiveLimits(problem: Pick<NdProblem, "d" | "piece">, override?: Partial<NdLimits>): NdLimits {
  const base = defaultLimits(problem);
  if (!override) return base;
  return {
    maxPieces: Math.min(
      problem.piece === BALL ? HARD_MAX_BALL_PIECES : HARD_MAX_PIECES,
      override.maxPieces ?? base.maxPieces,
    ),
    maxVertexWork: Math.min(HARD_MAX_VERTEX_WORK, override.maxVertexWork ?? base.maxVertexWork),
    maxWallWork: Math.min(HARD_MAX_WALL_WORK, override.maxWallWork ?? base.maxWallWork),
  };
}

/** The errors of a piece count against the limits (empty when within them); the problem's polytopes must be loaded. */
export function sizeErrors(problem: NdProblem, nPieces: number, override?: Partial<NdLimits>): string[] {
  const lim = effectiveLimits(problem, override);
  const errors: string[] = [];
  if (nPieces > lim.maxPieces)
    errors.push(`at most ${lim.maxPieces} pieces are checked in this problem, got ${nPieces}`);
  const P = shapePolytope(problem.piece);
  if (P) {
    if (nPieces * P.nV * problem.d > lim.maxVertexWork)
      errors.push(`${nPieces} pieces of ${P.nV} vertices exceed the work limit of ${lim.maxVertexWork} coordinates`);
    const C = shapePolytope(problem.container);
    if (C && nPieces * P.nV * C.nF > lim.maxWallWork)
      errors.push(`${nPieces} pieces of ${P.nV} vertices in a container of ${C.nF} facets exceed the work limit`);
  }
  return errors;
}
