//! Piece geometry of the torus package with an explicit disk radius.
//! Source: packages/torus/src/disk.ts (the functions the validator calls).
//!
//! Site units (what the API, the records and the validator speak): a disk piece (N = 0) has
//! DIAMETER 1, radius TORUS_DISK_RADIUS = 1/2; a polygon piece has side 1. The stand-alone search
//! of the TypeScript runs in working units where a disk has radius 1 and passes `rd = 1`; the
//! server never does. Polygons are the same in both, and `rd` is ignored for them.

use crate::geometry::{bounding_radius, piece_area, piece_separation, Pose};
use polypack_js::math;

/// disk.ts: `reachOf`. Radius of the smallest circle about the centre that holds the piece.
pub fn reach_of(n: f64, rd: f64) -> f64 {
    if n == 0.0 {
        rd
    } else {
        bounding_radius(n)
    }
}

/// disk.ts: `areaOf`.
pub fn area_of(n: f64, rd: f64) -> f64 {
    if n == 0.0 {
        math::PI * rd * rd
    } else {
        piece_area(n)
    }
}

/// disk.ts: `separationOf`. Separation of two congruent pieces (exact distance minus the diameters
/// for disks).
pub fn separation_of(n: f64, a: &Pose, b: &Pose, scale: f64, rd: f64) -> f64 {
    if n != 0.0 {
        return piece_separation(n, a, b, scale).sep;
    }
    let d = math::hypot(a.x - b.x, a.y - b.y);
    if d == 0.0 {
        -2.0 * rd * scale
    } else {
        d - 2.0 * rd * scale
    }
}
