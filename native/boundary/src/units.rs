//! Units of the ball pieces. Port of packages/boundary/src/units.ts.
//!
//! Site units: a ball has DIAMETER 1 (BALL_RADIUS = 1/2); a cube has edge 1; the score s is the
//! polytope's edge. The ball validator was written for a ball of radius 1 and keeps that radius as
//! its WORKING unit: every length a ball code reads or reports is converted by BALL_WORK = 2 exactly
//! (a power of two, so binary64 multiplication is exact), on entry to the validator (validate.rs).
//! A tolerance of the site is 2 tol in working units.

/// The radius of a ball piece, in site units.
pub const BALL_RADIUS: f64 = 0.5;

/// Working length per site length for balls: lengths x BALL_WORK on entry to the ball code, / BALL_WORK on exit.
pub const BALL_WORK: f64 = 1.0 / BALL_RADIUS;
