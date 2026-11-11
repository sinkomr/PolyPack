//! The helpers of `packages/geometry` that the surface validator uses, ported here so that this
//! crate stands alone (it must not depend on `native/flat`).
//!
//! Sources: `packages/geometry/src/shapes.ts` (radii, area, piece vertices),
//! `packages/geometry/src/overlap.ts` (TOL, the separating-axis test of two congruent regular
//! polygons) and `packages/geometry/src/trig.ts` (the edge-normal angles of a piece).

use polypack_js::math;
use polypack_js::math::PI;

/// `packages/geometry/src/overlap.ts: TOL`. Tolerance in piece units: two pieces overlap only when
/// their separation is below -TOL.
pub const TOL: f64 = 1e-9;

/// `packages/geometry/src/shapes.ts: DISK_RADIUS`. Disk pieces (N = 0) have diameter 1.
pub const DISK_RADIUS: f64 = 0.5;

/// `packages/geometry/src/shapes.ts: Pose`. Position and orientation of one piece in a plane.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub theta: f64,
}

/// `packages/geometry/src/shapes.ts: circumradius`. Circumradius of a regular n-gon of side 1.
pub fn circumradius(n: usize) -> f64 {
    1.0 / (2.0 * math::sin(PI / n as f64))
}

/// `packages/geometry/src/shapes.ts: inradius`. Inradius (apothem) of a regular n-gon of side 1.
pub fn inradius(n: usize) -> f64 {
    1.0 / (2.0 * math::tan(PI / n as f64))
}

/// `packages/geometry/src/shapes.ts: boundingRadius`. Radius of the smallest circle about the piece
/// centre that contains the piece.
pub fn bounding_radius(n: usize) -> f64 {
    if n == 0 {
        DISK_RADIUS
    } else {
        circumradius(n)
    }
}

/// `packages/geometry/src/shapes.ts: pieceArea`.
pub fn piece_area(n: usize) -> f64 {
    if n == 0 {
        PI * DISK_RADIUS * DISK_RADIUS
    } else {
        n as f64 / (4.0 * math::tan(PI / n as f64))
    }
}

/// `packages/geometry/src/shapes.ts: pieceVertices`. Vertices of an N-gon piece as a flat
/// [x0, y0, x1, y1, ...] array, counter-clockwise. Vertex k is at angle theta + pi/2 + 2 pi k / N,
/// so theta = 0 puts a vertex straight up. `scale` shrinks or grows the piece about its centre.
pub fn piece_vertices(n: usize, pose: Pose, scale: f64) -> Vec<f64> {
    let mut v = vec![0.0; 2 * n];
    let r = circumradius(n) * scale;
    let step = (2.0 * PI) / n as f64;
    let a0 = pose.theta + PI / 2.0;
    for k in 0..n {
        let a = a0 + k as f64 * step;
        v[2 * k] = pose.x + r * math::cos(a);
        v[2 * k + 1] = pose.y + r * math::sin(a);
    }
    v
}

/// `packages/geometry/src/trig.ts: axesOf`. The edge normals of an N-gon piece at angle theta, as
/// [angle, cos, sin] per edge. The TypeScript keeps these in a memo keyed by (N, theta); an entry
/// holds only pure functions of (N, theta), so computing them once per piece gives the same doubles.
pub fn axes_of(n: usize, theta: f64) -> Vec<f64> {
    let mut axes = vec![0.0; 3 * n];
    let step = (2.0 * PI) / n as f64;
    for k in 0..n {
        let angle = theta + PI / 2.0 + PI / n as f64 + k as f64 * step;
        axes[3 * k] = angle;
        axes[3 * k + 1] = math::cos(angle);
        axes[3 * k + 2] = math::sin(angle);
    }
    axes
}

/// `packages/geometry/src/overlap.ts: cosToNearestVertex`. cos of the angular distance from `rel`
/// to the nearest multiple of `step`.
fn cos_to_nearest_vertex(rel: f64, step: f64) -> f64 {
    let mut t = rel % step;
    if t < 0.0 {
        t += step;
    }
    if t > step / 2.0 {
        t = step - t;
    }
    math::cos(t)
}

/// `packages/geometry/src/overlap.ts: regularPolygonSeparation`, its `sep` (the surface package
/// reads nothing else of the contact). `ax_a` and `ax_b` are `axes_of(n, a.theta)` and
/// `axes_of(n, b.theta)`.
///
/// Separating-axis test for two congruent regular N-gon pieces, O(N). Along an edge normal u of A,
/// A reaches exactly its inradius. B reaches R cos(delta) toward A, where delta is the angle
/// between -u and B's nearest vertex direction (the support function of a regular polygon). So the
/// gap along u is (cB - cA) . u - inradius - R cos(delta).
///
/// The axes are visited A0, B0, A1, B1, ... and the first largest gap wins. Since
/// r <= R cos(delta) <= R, each gap lies in [lin - r - R, lin - 2r], lin = (cB - cA) . u (with the
/// sign of the piece the axis belongs to). So an axis whose lin is below the largest lin by more
/// than R - r (plus a margin of 1e-11 (|dx| + |dy| + R)) has a gap strictly below the largest gap,
/// and its cosine is not needed.
pub fn regular_polygon_separation_with(n: usize, a: Pose, b: Pose, ax_a: &[f64], ax_b: &[f64], scale: f64) -> f64 {
    let big_r = circumradius(n) * scale;
    let r = inradius(n) * scale;
    let step = (2.0 * PI) / n as f64;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut best = f64::NEG_INFINITY;
    let mut top = f64::NEG_INFINITY;
    for k in 0..n {
        let lin_a = dx * ax_a[3 * k + 1] + dy * ax_a[3 * k + 2];
        let lin_b = -(dx * ax_b[3 * k + 1] + dy * ax_b[3 * k + 2]);
        if lin_a > top {
            top = lin_a;
        }
        if lin_b > top {
            top = lin_b;
        }
    }
    let mut threshold = top - (big_r - r) - 1e-11 * (dx.abs() + dy.abs() + big_r);
    // infinite or NaN inputs: every axis, as without the bound
    if !threshold.is_finite() {
        threshold = f64::NEG_INFINITY;
    }
    for k in 0..n {
        // edge normals bisect consecutive vertex directions
        let ux = ax_a[3 * k + 1];
        let uy = ax_a[3 * k + 2];
        let lin_a = dx * ux + dy * uy;
        if !(lin_a < threshold) {
            let sep = lin_a - r - big_r * cos_to_nearest_vertex(ax_a[3 * k] + PI / 2.0 - b.theta, step);
            if sep > best {
                best = sep;
            }
        }
        let ux = ax_b[3 * k + 1];
        let uy = ax_b[3 * k + 2];
        let lin_b = -(dx * ux + dy * uy);
        if !(lin_b < threshold) {
            let sep = lin_b - r - big_r * cos_to_nearest_vertex(ax_b[3 * k] + PI / 2.0 - a.theta, step);
            if sep > best {
                best = sep;
            }
        }
    }
    best
}

/// `packages/geometry/src/overlap.ts: regularPolygonSeparation(N, a, b, scale).sep`.
pub fn regular_polygon_separation(n: usize, a: Pose, b: Pose, scale: f64) -> f64 {
    regular_polygon_separation_with(n, a, b, &axes_of(n, a.theta), &axes_of(n, b.theta), scale)
}
