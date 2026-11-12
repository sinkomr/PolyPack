//! The closed-form separation of two congruent pieces that the search uses.
//!
//! sep > 0: the pieces are disjoint (for polygons a lower bound on their distance, exact for face
//! contact); sep < 0: they overlap and -sep is the penetration depth. (nx, ny) is the unit
//! direction in which moving piece A increases sep fastest.
//!
//! Two kernels compute the same quantity:
//!
//! - the reference kernels of [`crate::overlap`] (re-exported here: `regular_polygon_separation`,
//!   `pair_separation`, `piece_separation`, `circle_separation`) follow the arithmetic of the
//!   server (packages/geometry/src/overlap.ts) operation for operation, so that the validator
//!   decides as the server does;
//! - [`Shape::sep`] is the closed form used by the search: for two congruent regular N-gons the
//!   reach of B along any edge normal of A is the same, so the 2N axes reduce to the edge normal
//!   of each piece nearest the line of centres (see the derivation there).

use crate::math;
pub use crate::overlap::{circle_separation, pair_separation, piece_separation, regular_polygon_separation, Contact};
use crate::shapes::{bounding_radius, piece_inradius, Pose, DISK_RADIUS};
use std::f64::consts::PI;

/// Distance of `x` to the nearest multiple of `step`, in [0, step / 2], by rounding the quotient
/// (fast; exact up to the rounding of x - k step).
#[inline]
pub fn fold(x: f64, step: f64) -> f64 {
    (x - step * (x / step).round()).abs().min(step / 2.0)
}

/// Constants of one piece shape, for the closed-form kernels of the search.
#[derive(Clone, Copy, Debug)]
pub struct Shape {
    pub n: u32,
    /// Bounding radius (circumradius, or the disk radius).
    pub big_r: f64,
    /// Inradius (or the disk radius).
    pub r: f64,
    /// 2 pi / n (2 pi for a disk).
    pub step: f64,
    /// Angle of edge normal 0 relative to theta: pi/2 + pi/n.
    pub normal0: f64,
}

impl Shape {
    pub fn new(n: u32) -> Self {
        Shape {
            n,
            big_r: bounding_radius(n),
            r: piece_inradius(n),
            step: if n == 0 { 2.0 * PI } else { 2.0 * PI / n as f64 },
            normal0: if n == 0 { 0.0 } else { PI / 2.0 + PI / n as f64 },
        }
    }

    /// Centre distance beyond which the separation is surely above `t` (t >= 0). The SAT value
    /// is a lower bound on the distance of separated pieces, so pairs whose bounding circles are
    /// apart can still report a small separation: along the edge normal nearest the line of
    /// centres (at most pi/n away) the gap is at least |d| cos(pi/n) - r - R.
    pub fn near_reach(&self, t: f64) -> f64 {
        if self.n == 0 {
            2.0 * DISK_RADIUS + t
        } else {
            (self.r + self.big_r + t) / math::cos(PI / self.n as f64)
        }
    }

    /// Distance of `x` to the nearest multiple of `step`, in [0, step / 2]. A rounding-to-nearest
    /// reduction instead of the reference's exact remainder (fmod is slow): the two differ in the
    /// last bits only, and only the search uses this kernel.
    #[inline]
    pub fn fold(&self, x: f64) -> f64 {
        fold(x, self.step)
    }

    /// Reach of B toward A, plus A's inradius: r + R cos(delta). For congruent regular polygons
    /// delta (the angle between an edge normal of one piece and the nearest vertex direction of the
    /// other, reversed) is the same for every edge normal and for both pieces: shifting the normal
    /// by one edge shifts the relative angle by one vertex spacing, and the folded distance of
    /// x + step/2 equals that of -x + step/2.
    #[inline]
    pub fn contact_offset(&self, ta: f64, tb: f64) -> f64 {
        // rel = ta - tb + pi + pi/n; pi + pi/n is a multiple of step plus step/2 for even n and a
        // multiple of step for odd n.
        let rel = ta - tb + PI + PI / self.n as f64;
        self.r + self.big_r * math::cos(self.fold(rel))
    }

    /// Signed separation of two congruent pieces by the closed form of the SAT:
    ///   sep = max(|d| cos(alpha_A), |d| cos(alpha_B)) - (r + R cos(delta)),
    /// alpha_A being the angle from d = cB - cA to the nearest edge normal of A and alpha_B that
    /// from -d to the nearest edge normal of B. Equal to the reference value up to rounding.
    #[inline]
    pub fn sep(&self, a: &Pose, b: &Pose) -> f64 {
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if self.n == 0 {
            return math::hypot(dx, dy) - 2.0 * DISK_RADIUS;
        }
        let d = math::hypot(dx, dy);
        let phi = math::atan2(dy, dx);
        let alpha_a = self.fold(phi - a.theta - self.normal0);
        let alpha_b = self.fold(phi + PI - b.theta - self.normal0);
        d * math::cos(alpha_a.min(alpha_b)) - self.contact_offset(a.theta, b.theta)
    }

    /// Separation and the unit direction in which moving A increases it (the normal of the
    /// selected axis).
    #[inline]
    pub fn contact(&self, a: &Pose, b: &Pose) -> Contact {
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if self.n == 0 {
            let d = math::hypot(dx, dy);
            if d == 0.0 {
                return Contact { sep: -2.0 * DISK_RADIUS, nx: 1.0, ny: 0.0 };
            }
            return Contact { sep: d - 2.0 * DISK_RADIUS, nx: -dx / d, ny: -dy / d };
        }
        let d = math::hypot(dx, dy);
        let phi = math::atan2(dy, dx);
        let step = self.step;
        // nearest edge normal of A to d, and of B to -d
        let ka = ((phi - a.theta - self.normal0) / step).round();
        let kb = ((phi + PI - b.theta - self.normal0) / step).round();
        let ua = a.theta + self.normal0 + ka * step;
        let ub = b.theta + self.normal0 + kb * step;
        let ga = d * math::cos(phi - ua);
        let gb = d * math::cos(phi + PI - ub);
        let off = self.contact_offset(a.theta, b.theta);
        if ga >= gb {
            // A's normal points from A toward B: A retreats along -u
            Contact { sep: ga - off, nx: -math::cos(ua), ny: -math::sin(ua) }
        } else {
            // B's normal pushes A along +u
            Contact { sep: gb - off, nx: math::cos(ub), ny: math::sin(ub) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64) / ((1u64 << 53) as f64)
    }

    #[test]
    fn closed_form_matches_reference() {
        let mut seed = 7u64;
        for n in [3u32, 4, 5, 6, 7, 8, 9, 12, 17, 50, 100] {
            let s = Shape::new(n);
            for _ in 0..2000 {
                let a = Pose::new(lcg(&mut seed) * 2.0, lcg(&mut seed) * 2.0, lcg(&mut seed) * 20.0 - 10.0);
                let b = Pose::new(lcg(&mut seed) * 2.0, lcg(&mut seed) * 2.0, lcg(&mut seed) * 20.0 - 10.0);
                let reference = regular_polygon_separation(n, &a, &b, 1.0);
                let fast = s.sep(&a, &b);
                assert!((reference.sep - fast).abs() < 1e-12, "n={n} {} {}", reference.sep, fast);
                let pruned = pair_separation(n, &a, &b, 1.0);
                assert!((reference.sep - pruned).abs() < 1e-13);
                let c = s.contact(&a, &b);
                assert!((c.sep - reference.sep).abs() < 1e-12);
            }
        }
    }
}
