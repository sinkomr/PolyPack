//! The helpers of packages/geometry that the torus package and the server's torus check call.
//! Sources: packages/geometry/src/shapes.ts, trig.ts and overlap.ts. This crate keeps its own copy
//! (it does not depend on `native/flat`).

use polypack_js::math;
use serde::{Deserialize, Serialize};

/// shapes.ts: `DISK_RADIUS`. Radius of the disk piece (N = 0): diameter 1.
pub const DISK_RADIUS: f64 = 0.5;
/// shapes.ts: `MAX_SIDES`.
pub const MAX_SIDES: f64 = 100.0;
/// overlap.ts: `TOL`. Pieces may touch; an overlap deeper than this is an overlap.
pub const TOL: f64 = 1e-9;

/// shapes.ts: `Pose`. Centre and rotation of a piece; at theta = 0 a polygon has a vertex pointing up.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub theta: f64,
}

/// shapes.ts: `isShapeCode`. 0 (disk) or a whole number of sides from 3 to MAX_SIDES.
pub fn is_shape_code(n: f64) -> bool {
    // Number.isInteger: finite and whole
    n.is_finite() && n == n.trunc() && (n == 0.0 || (n >= 3.0 && n <= MAX_SIDES))
}

/// shapes.ts: `circumradius`. Circumradius of a regular n-gon with side 1.
#[inline]
pub fn circumradius(n: f64) -> f64 {
    1.0 / (2.0 * math::sin(math::PI / n))
}

/// shapes.ts: `inradius`. Inradius of a regular n-gon with side 1.
#[inline]
pub fn inradius(n: f64) -> f64 {
    1.0 / (2.0 * math::tan(math::PI / n))
}

/// shapes.ts: `pieceInradius`. The server's torus check compares twice this with the shortest
/// lattice vector.
pub fn piece_inradius(n: f64) -> f64 {
    if n == 0.0 {
        DISK_RADIUS
    } else {
        inradius(n)
    }
}

/// shapes.ts: `boundingRadius`. Radius of the smallest circle about the centre that holds the piece.
pub fn bounding_radius(n: f64) -> f64 {
    if n == 0.0 {
        DISK_RADIUS
    } else {
        circumradius(n)
    }
}

/// shapes.ts: `pieceArea`.
pub fn piece_area(n: f64) -> f64 {
    if n == 0.0 {
        math::PI * DISK_RADIUS * DISK_RADIUS
    } else {
        n / (4.0 * math::tan(math::PI / n))
    }
}

/// trig.ts: `axesOf`. The outward edge normals of the N-gon turned by theta, three numbers per
/// edge k: the angle theta + pi/2 + pi/N + k 2 pi/N, its cosine and its sine. (The source keeps
/// them in a cache keyed by N and theta; the numbers are these.)
pub fn axes_of(n: usize, theta: f64) -> Vec<f64> {
    let nf = n as f64;
    let step = (2.0 * math::PI) / nf;
    let mut axes = vec![0.0; 3 * n];
    for k in 0..n {
        let angle = theta + math::PI / 2.0 + math::PI / nf + k as f64 * step;
        axes[3 * k] = angle;
        axes[3 * k + 1] = math::cos(angle);
        axes[3 * k + 2] = math::sin(angle);
    }
    axes
}

/// overlap.ts: `cosToNearestVertex`. The cosine of the angle between a direction and the nearest
/// vertex direction of an N-gon (`rel` is measured from a vertex, `step` = 2 pi/N).
#[inline]
fn cos_to_nearest_vertex(rel: f64, step: f64) -> f64 {
    // JavaScript's % is the remainder that keeps the sign of the dividend, as Rust's
    let mut t = rel % step;
    if t < 0.0 {
        t += step;
    }
    if t > step / 2.0 {
        t = step - t;
    }
    math::cos(t)
}

/// overlap.ts: the result of `pieceSeparation`: the signed separation along the best axis and the
/// axis (pointing from b towards a).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Separation {
    pub sep: f64,
    pub nx: f64,
    pub ny: f64,
}

/// overlap.ts: `regularPolygonSeparation`, with the axes of the two pieces given (`axes_of`).
/// Separating-axis test for two congruent regular N-gons: over the 2N edge normals, the gap along
/// the normal between the owner's edge and the other polygon's nearest vertex; the largest is the
/// separation (negative: the penetration depth).
pub fn regular_polygon_separation_with(
    n: usize,
    a: &Pose,
    b: &Pose,
    ax_a: &[f64],
    ax_b: &[f64],
    scale: f64,
) -> Separation {
    let nf = n as f64;
    let big_r = circumradius(nf) * scale;
    let r = inradius(nf) * scale;
    let step = (2.0 * math::PI) / nf;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut best = f64::NEG_INFINITY;
    let mut nx = 1.0;
    let mut ny = 0.0;
    // An axis whose linear part is below every other by more than R - r cannot be the best one:
    // the vertex term lies between r and R.
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
    let mut threshold = top - (big_r - r) - 1e-11 * (math::abs(dx) + math::abs(dy) + big_r);
    if !threshold.is_finite() {
        threshold = f64::NEG_INFINITY;
    }
    for k in 0..n {
        let mut ux = ax_a[3 * k + 1];
        let mut uy = ax_a[3 * k + 2];
        let lin_a = dx * ux + dy * uy;
        if !(lin_a < threshold) {
            let sep = lin_a - r - big_r * cos_to_nearest_vertex(ax_a[3 * k] + math::PI / 2.0 - b.theta, step);
            if sep > best {
                best = sep;
                nx = -ux;
                ny = -uy;
            }
        }
        ux = ax_b[3 * k + 1];
        uy = ax_b[3 * k + 2];
        let lin_b = -(dx * ux + dy * uy);
        if !(lin_b < threshold) {
            let sep = lin_b - r - big_r * cos_to_nearest_vertex(ax_b[3 * k] + math::PI / 2.0 - a.theta, step);
            if sep > best {
                best = sep;
                nx = ux;
                ny = uy;
            }
        }
    }
    Separation { sep: best, nx, ny }
}

/// overlap.ts: `regularPolygonSeparation`.
pub fn regular_polygon_separation(n: usize, a: &Pose, b: &Pose, scale: f64) -> Separation {
    regular_polygon_separation_with(n, a, b, &axes_of(n, a.theta), &axes_of(n, b.theta), scale)
}

/// overlap.ts: `circleSeparation`. Two disks of radius DISK_RADIUS.
pub fn circle_separation(a: &Pose, b: &Pose, scale: f64) -> Separation {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    let d = math::hypot(dx, dy);
    if d == 0.0 {
        return Separation {
            sep: -2.0 * DISK_RADIUS * scale,
            nx: 1.0,
            ny: 0.0,
        };
    }
    Separation {
        sep: d - 2.0 * DISK_RADIUS * scale,
        nx: dx / d,
        ny: dy / d,
    }
}

/// overlap.ts: `pieceSeparation`. `n` must be a shape code.
pub fn piece_separation(n: f64, a: &Pose, b: &Pose, scale: f64) -> Separation {
    if n == 0.0 {
        circle_separation(a, b, scale)
    } else {
        regular_polygon_separation(n as usize, a, b, scale)
    }
}
