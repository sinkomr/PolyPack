//! Disk pieces of the surface package: site units and the kernels' working scale.
//! Port of what the server reaches of `packages/surface/src/disk.ts`.
//!
//! Site units (what the API, the records and the validator speak): a disk piece (N = 0) has
//! DIAMETER 1, radius SURFACE_DISK_RADIUS = 1/2; a polygon piece has side 1. Before 2026-10-27
//! disks had radius 1 and every disk score s was twice as large, with the same poses on the solid
//! of edge 1. The parts (parts.rs) keep the kernels' convention, in which a disk "at scale lam" has
//! RADIUS lam.

use crate::geometry::{bounding_radius, piece_area, regular_polygon_separation, Pose};
use polypack_js::math;
use polypack_js::math::PI;

/// `packages/surface/src/disk.ts: SURFACE_DISK_RADIUS`.
pub const SURFACE_DISK_RADIUS: f64 = 0.5;

/// `packages/surface/src/disk.ts: innerReach`. Circumradius of the piece at scale 1 of the
/// kernels' convention (disks: 1, a disk of radius lam at scale lam).
pub fn inner_reach(n: usize) -> f64 {
    if n == 0 {
        1.0
    } else {
        bounding_radius(n)
    }
}

/// `packages/surface/src/disk.ts: pieceReach`. Radius of the smallest circle about the centre that
/// holds the true piece, in site units.
pub fn piece_reach(n: usize) -> f64 {
    if n == 0 {
        SURFACE_DISK_RADIUS
    } else {
        bounding_radius(n)
    }
}

/// `packages/surface/src/disk.ts: pieceAreaOf`. Area of the true piece, in site units.
pub fn piece_area_of(n: usize) -> f64 {
    if n == 0 {
        PI * SURFACE_DISK_RADIUS * SURFACE_DISK_RADIUS
    } else {
        piece_area(n)
    }
}

/// `packages/surface/src/disk.ts: planarSeparation`. Separation of two congruent pieces of scale
/// `scale` (true pieces times scale) in one plane, site units.
pub fn planar_separation(n: usize, a: Pose, b: Pose, scale: f64) -> f64 {
    if n != 0 {
        return regular_polygon_separation(n, a, b, scale);
    }
    disk_separation(a, b, scale)
}

/// The disk branch of `planarSeparation`.
pub fn disk_separation(a: Pose, b: Pose, scale: f64) -> f64 {
    let d = math::hypot(a.x - b.x, a.y - b.y);
    if d == 0.0 {
        -2.0 * SURFACE_DISK_RADIUS * scale
    } else {
        d - 2.0 * SURFACE_DISK_RADIUS * scale
    }
}
