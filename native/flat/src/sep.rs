//! Signed separation of two congruent pieces by the separating-axis theorem (SAT).
//!
//! sep > 0: the pieces are disjoint (for polygons a lower bound on their distance, exact for face
//! contact); sep < 0: they overlap and -sep is the penetration depth. (nx, ny) is the unit
//! direction in which moving piece A increases sep fastest.
//!
//! Two kernels compute the same quantity:
//!
//! - [`regular_polygon_separation`] and [`pair_separation`] follow the reference arithmetic of
//!   the server (packages/geometry/src/overlap.ts) operation for operation, so that the validator
//!   decides as the server does;
//! - [`Shape::sep`] is the closed form used by the search: for two congruent regular N-gons the
//!   reach of B along any edge normal of A is the same, so the 2N axes reduce to the edge normal
//!   of each piece nearest the line of centres (see the derivation there).

use crate::shapes::{bounding_radius, circumradius, inradius, piece_inradius, Pose, DISK_RADIUS};
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Contact {
    pub sep: f64,
    pub nx: f64,
    pub ny: f64,
}

/// cos of the angular distance from `rel` to the nearest multiple of `step`.
#[inline]
fn cos_to_nearest_vertex(rel: f64, step: f64) -> f64 {
    let mut t = rel % step;
    if t < 0.0 {
        t += step;
    }
    if t > step / 2.0 {
        t = step - t;
    }
    t.cos()
}

/// Separating-axis test for two congruent regular N-gons, as the reference computes it.
///
/// Along an edge normal u of A, A reaches exactly its inradius r. B reaches R cos(delta) toward A,
/// delta being the angle between -u and B's nearest vertex direction (the support function of a
/// regular polygon), so the gap along u is (cB - cA) . u - r - R cos(delta).
pub fn regular_polygon_separation(n: u32, a: &Pose, b: &Pose, scale: f64) -> Contact {
    let big_r = circumradius(n) * scale;
    let r = inradius(n) * scale;
    let nf = n as f64;
    let step = 2.0 * PI / nf;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut best = f64::NEG_INFINITY;
    let mut nx = 1.0;
    let mut ny = 0.0;
    for k in 0..n {
        // edge normals bisect consecutive vertex directions
        let ang_a = a.theta + PI / 2.0 + PI / nf + k as f64 * step;
        let (sa, ca) = ang_a.sin_cos();
        let sep = dx * ca + dy * sa - r - big_r * cos_to_nearest_vertex(ang_a + PI / 2.0 - b.theta, step);
        if sep > best {
            best = sep;
            nx = -ca;
            ny = -sa;
        }
        let ang_b = b.theta + PI / 2.0 + PI / nf + k as f64 * step;
        let (sb, cb) = ang_b.sin_cos();
        let sep = -(dx * cb + dy * sb) - r - big_r * cos_to_nearest_vertex(ang_b + PI / 2.0 - a.theta, step);
        if sep > best {
            best = sep;
            nx = cb;
            ny = sb;
        }
    }
    Contact { sep: best, nx, ny }
}

/// Circle-circle separation from the centre distance; exact in both signs.
pub fn circle_separation(a: &Pose, b: &Pose, scale: f64) -> Contact {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    let d = dx.hypot(dy);
    if d == 0.0 {
        return Contact { sep: -2.0 * DISK_RADIUS * scale, nx: 1.0, ny: 0.0 };
    }
    Contact { sep: d - 2.0 * DISK_RADIUS * scale, nx: dx / d, ny: dy / d }
}

/// Separation of two congruent pieces (n = 0 for disks), reference arithmetic.
pub fn piece_separation(n: u32, a: &Pose, b: &Pose, scale: f64) -> Contact {
    if n == 0 {
        circle_separation(a, b, scale)
    } else {
        regular_polygon_separation(n, a, b, scale)
    }
}

const PRUNE_FROM_N: u32 = 12;
const PRUNE_MAX_THETA: f64 = 1000.0;

/// `regular_polygon_separation(..).sep` from far fewer axes for many-sided pieces, the same value
/// (the reference's pairSeparation). Each candidate gap is at most |d| cos(alpha) - 2r, alpha the
/// angle between the axis and the line of centres; axes are visited outward from the nearest one
/// on both pieces until no remaining axis can reach the best gap (with a 1e-11 (|d| + R) margin
/// for rounding).
pub fn pair_separation(n: u32, a: &Pose, b: &Pose, scale: f64) -> f64 {
    if n == 0 {
        return circle_separation(a, b, scale).sep;
    }
    if n < PRUNE_FROM_N || !(a.theta.abs() <= PRUNE_MAX_THETA && b.theta.abs() <= PRUNE_MAX_THETA) {
        return regular_polygon_separation(n, a, b, scale).sep;
    }
    let big_r = circumradius(n) * scale;
    let r = inradius(n) * scale;
    let nf = n as f64;
    let step = 2.0 * PI / nf;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let gap_a = |k: i64| -> f64 {
        let ang = a.theta + PI / 2.0 + PI / nf + k as f64 * step;
        dx * ang.cos() + dy * ang.sin() - r - big_r * cos_to_nearest_vertex(ang + PI / 2.0 - b.theta, step)
    };
    let gap_b = |k: i64| -> f64 {
        let ang = b.theta + PI / 2.0 + PI / nf + k as f64 * step;
        -(dx * ang.cos() + dy * ang.sin()) - r - big_r * cos_to_nearest_vertex(ang + PI / 2.0 - a.theta, step)
    };
    let ni = n as i64;
    let index = |k: i64| ((k % ni) + ni) % ni;
    let toward_b = dy.atan2(dx);
    let ka = ((toward_b - (a.theta + PI / 2.0 + PI / nf)) / step).round() as i64;
    let kb = ((toward_b + PI - (b.theta + PI / 2.0 + PI / nf)) / step).round() as i64;
    let mut best = gap_a(index(ka)).max(gap_b(index(kb)));
    let dist = dx.hypot(dy);
    let margin = 1e-11 * (dist + big_r);
    let mut s = 1i64;
    while (s as f64) <= nf / 2.0 {
        if dist * ((s as f64 - 0.5) * step).cos() - 2.0 * r < best - margin {
            break;
        }
        best = best
            .max(gap_a(index(ka + s)))
            .max(gap_a(index(ka - s)))
            .max(gap_b(index(kb + s)))
            .max(gap_b(index(kb - s)));
        s += 1;
    }
    best
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
            (self.r + self.big_r + t) / (PI / self.n as f64).cos()
        }
    }

    /// Distance of `x` to the nearest multiple of `step`, in [0, step / 2].
    #[inline]
    pub fn fold(&self, x: f64) -> f64 {
        let s = self.step;
        let mut t = x % s;
        if t < 0.0 {
            t += s;
        }
        if t > s / 2.0 {
            s - t
        } else {
            t
        }
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
        self.r + self.big_r * self.fold(rel).cos()
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
            return dx.hypot(dy) - 2.0 * DISK_RADIUS;
        }
        let d = dx.hypot(dy);
        let phi = dy.atan2(dx);
        let alpha_a = self.fold(phi - a.theta - self.normal0);
        let alpha_b = self.fold(phi + PI - b.theta - self.normal0);
        d * alpha_a.min(alpha_b).cos() - self.contact_offset(a.theta, b.theta)
    }

    /// Separation and the unit direction in which moving A increases it (the normal of the
    /// selected axis).
    #[inline]
    pub fn contact(&self, a: &Pose, b: &Pose) -> Contact {
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if self.n == 0 {
            let d = dx.hypot(dy);
            if d == 0.0 {
                return Contact { sep: -2.0 * DISK_RADIUS, nx: 1.0, ny: 0.0 };
            }
            return Contact { sep: d - 2.0 * DISK_RADIUS, nx: -dx / d, ny: -dy / d };
        }
        let d = dx.hypot(dy);
        let phi = dy.atan2(dx);
        let step = self.step;
        // nearest edge normal of A to d, and of B to -d
        let ka = ((phi - a.theta - self.normal0) / step).round();
        let kb = ((phi + PI - b.theta - self.normal0) / step).round();
        let ua = a.theta + self.normal0 + ka * step;
        let ub = b.theta + self.normal0 + kb * step;
        let ga = d * (phi - ua).cos();
        let gb = d * (phi + PI - ub).cos();
        let off = self.contact_offset(a.theta, b.theta);
        if ga >= gb {
            // A's normal points from A toward B: A retreats along -u
            Contact { sep: ga - off, nx: -ua.cos(), ny: -ua.sin() }
        } else {
            // B's normal pushes A along +u
            Contact { sep: gb - off, nx: ub.cos(), ny: ub.sin() }
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
