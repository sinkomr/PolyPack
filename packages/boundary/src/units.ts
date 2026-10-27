/**
 * Units of the ball pieces (2026-10-27, the unit change; docs and records are in these).
 *
 * Site units: a ball has DIAMETER 1 (BALL_RADIUS = 1/2); a cube has edge 1; the score s is the polytope's edge. The
 * ball model and the ball validator were written for a ball of radius 1 and keep that radius as their WORKING unit:
 * every length a ball code reads or reports is converted by BALL_WORK = 2 exactly (a power of two, so binary64
 * multiplication is exact), on entry to the validator (validate.ts) and to the search model (search/ball-site.ts). A
 * tolerance of the site is 2 tol in working units. Nothing outside those two files sees working units.
 */

/** The radius of a ball piece, in site units. */
export const BALL_RADIUS = 0.5;

/** Working length per site length for balls: lengths x BALL_WORK on entry to the ball code, / BALL_WORK on exit. */
export const BALL_WORK = 1 / BALL_RADIUS;
