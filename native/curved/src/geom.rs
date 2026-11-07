//! Points, lines and isometries of the plane of constant curvature K (packages/curved/src/space.ts).
//!
//! Homogeneous model. Points are vectors v = (v0, v1, v2) with Q_K(v) = v0^2 + K (v1^2 + v2^2) = 1
//! and v0 > 0 (for K > 0 the open hemisphere centred at the origin O = (1, 0, 0)). The chart
//! p = (v1, v2) / v0 is the Beltrami-Klein model (K < 0), the gnomonic projection (K > 0) or the
//! identity (K = 0); geodesics are straight lines in it.
//!
//! Lifted coordinates. A point is stored as (e, x, y) with v = (1 - K e, x, y). For a point at
//! distance D from O, e = vs_K(D) = (1 - cs_K(D)) / K (= D^2/2 at K = 0), so e never needs a
//! division by K.
//!
//! Lines are covectors n with n . v = 0. A line at signed distance h from O with outward unit
//! normal direction u is n = (-sn_K(h), cs_K(h) u); it has Qd(n) = |n_vec|^2 + K n0^2 = 1 and then
//! n . v = sn_K(signed distance of v from the line) for a normalised point v.
//!
//! Isometries act linearly on v, hence affinely on lifted coordinates: p' = L p + b.
//!
//! The functions here perform the TypeScript reference's operations in the same order (they back
//! the validator, which must reproduce the server's numbers).

use crate::kfun::{asn_k, cs_k, dist_from_vs, sfun, sn_k, vfun};

/// A lifted point (e, x, y).
pub type LPoint = [f64; 3];

/// Affine action on lifted coordinates: p' = L p + b, L row-major 3x3.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Motion {
    pub l: [f64; 9],
    pub b: [f64; 3],
}

/// Transvection T(w) along the geodesic from O through exp_O(w), w = (x, y): entire in (x, y, K),
///   b = (D^2 V, S x, S y),  L = [[1 - K D^2 V, S x, S y], [-K S x, 1 - K V x^2, -K V x y], [-K S y, -K V x y, 1 - K V y^2]]
/// with D^2 = x^2 + y^2, S = S(K D^2), V = V(K D^2).
pub fn transvection(k: f64, x: f64, y: f64) -> Motion {
    let d2 = x * x + y * y;
    let t = k * d2;
    transvection_of(k, x, y, d2, sfun(t), vfun(t))
}

#[inline]
pub fn transvection_of(k: f64, x: f64, y: f64, d2: f64, s: f64, v: f64) -> Motion {
    Motion {
        l: [
            1.0 - k * d2 * v,
            s * x,
            s * y,
            -k * s * x,
            1.0 - k * v * x * x,
            -k * v * x * y,
            -k * s * y,
            -k * v * x * y,
            1.0 - k * v * y * y,
        ],
        b: [d2 * v, s * x, s * y],
    }
}

pub fn rotation(theta: f64) -> Motion {
    let c = libm::cos(theta);
    let s = libm::sin(theta);
    Motion {
        l: [1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c],
        b: [0.0; 3],
    }
}

/// a o b (apply b first).
pub fn compose(a: &Motion, b: &Motion) -> Motion {
    let mut l = [0.0; 9];
    let aa = &a.l;
    let bb = &b.l;
    for i in 0..3 {
        for j in 0..3 {
            l[3 * i + j] = aa[3 * i] * bb[j] + aa[3 * i + 1] * bb[3 + j] + aa[3 * i + 2] * bb[6 + j];
        }
    }
    let mut v = [0.0; 3];
    for i in 0..3 {
        v[i] = aa[3 * i] * b.b[0] + aa[3 * i + 1] * b.b[1] + aa[3 * i + 2] * b.b[2] + a.b[i];
    }
    Motion { l, b: v }
}

/// Pose motion G = T(x, y) R(theta): the piece frame of a pose.
pub fn pose_motion(k: f64, x: f64, y: f64, theta: f64) -> Motion {
    compose(&transvection(k, x, y), &rotation(theta))
}

/// G^{-1} = R(-theta) T(-x, -y).
pub fn pose_motion_inverse(k: f64, x: f64, y: f64, theta: f64) -> Motion {
    compose(&rotation(-theta), &transvection(k, -x, -y))
}

#[inline]
pub fn apply_point(m: &Motion, p: &LPoint) -> LPoint {
    let l = &m.l;
    [
        l[0] * p[0] + l[1] * p[1] + l[2] * p[2] + m.b[0],
        l[3] * p[0] + l[4] * p[1] + l[5] * p[2] + m.b[1],
        l[6] * p[0] + l[7] * p[1] + l[8] * p[2] + m.b[2],
    ]
}

/// Lifted point at polar position (distance r from O, direction a), via sn and vs.
pub fn polar_point(k: f64, r: f64, a: f64) -> LPoint {
    let s = sn_k(k, r);
    let t = k * r * r;
    [r * r * vfun(t), s * libm::cos(a), s * libm::sin(a)]
}

/// Versine vs_K of the distance between two normalised lifted points: (|dx|^2 + K de^2) / 2.
#[inline]
pub fn pair_vs(k: f64, p: &LPoint, q: &LPoint) -> f64 {
    let dx = p[1] - q[1];
    let dy = p[2] - q[2];
    let de = p[0] - q[0];
    (dx * dx + dy * dy + k * de * de) / 2.0
}

#[inline]
pub fn distance(k: f64, p: &LPoint, q: &LPoint) -> f64 {
    dist_from_vs(k, pair_vs(k, p, q))
}

/// Covector of the line at signed distance h from O with outward normal angle a (Qd = 1).
pub fn line_covector(k: f64, h: f64, a: f64) -> [f64; 3] {
    let c = cs_k(k, h);
    [-sn_k(k, h), c * libm::cos(a), c * libm::sin(a)]
}

/// n . v for lifted p: sn_K(signed distance) when n is normalised (Qd = 1) and p normalised.
#[inline]
pub fn line_value(k: f64, n: &[f64; 3], p: &LPoint) -> f64 {
    n[0] * (1.0 - k * p[0]) + n[1] * p[1] + n[2] * p[2]
}

/// Signed distance from the normalised line n (positive on the side n . v > 0).
#[inline]
pub fn signed_distance(k: f64, n: &[f64; 3], p: &LPoint) -> f64 {
    asn_k(k, line_value(k, n, p))
}

/// Homogeneous cross product a x b of two lifted points: the covector of the line through them.
#[inline]
pub fn line_through(k: f64, a: &LPoint, b: &LPoint) -> [f64; 3] {
    let a0 = 1.0 - k * a[0];
    let b0 = 1.0 - k * b[0];
    [a[1] * b[2] - a[2] * b[1], a[2] * b0 - a0 * b[2], a0 * b[1] - a[1] * b0]
}

/// Qd(n) = |n_vec|^2 + K n0^2 (invariant under isometries for covectors).
#[inline]
pub fn covector_norm2(k: f64, n: &[f64; 3]) -> f64 {
    n[1] * n[1] + n[2] * n[2] + k * n[0] * n[0]
}

/// Exponential map at O: the point at distance |w| in direction w.
pub fn exp_o(k: f64, x: f64, y: f64) -> LPoint {
    let d2 = x * x + y * y;
    let s = sfun(k * d2);
    [d2 * vfun(k * d2), s * x, s * y]
}

/// `Math.min(a, b)` of JavaScript: NaN when either is NaN.
#[inline]
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && b == 0.0 && (a.is_sign_negative() || b.is_sign_negative()) {
        -0.0
    } else {
        a
    }
}

/// `Math.hypot(x, y)` as V8 computes it (Kahan-compensated sum of squares scaled by the largest).
pub fn js_hypot(x: f64, y: f64) -> f64 {
    let mut abs = [0.0f64; 2];
    let mut nan = false;
    let mut max = 0.0f64;
    for (i, &v) in [x, y].iter().enumerate() {
        if v.is_nan() {
            nan = true;
        } else {
            let a = v.abs();
            abs[i] = a;
            if a > max {
                max = a;
            }
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    } else if nan {
        return f64::NAN;
    } else if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for a in abs {
        let n = a / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transvection_moves_o_by_the_distance() {
        for &k in &[-1.0, 0.0, 0.3] {
            let m = transvection(k, 0.3, -0.4);
            let p = apply_point(&m, &[0.0; 3]);
            assert!((distance(k, &p, &[0.0; 3]) - 0.5).abs() < 1e-15);
        }
    }

    #[test]
    fn pose_inverse() {
        let k = -0.7;
        let g = pose_motion(k, 0.4, 0.9, 1.3);
        let gi = pose_motion_inverse(k, 0.4, 0.9, 1.3);
        let p = [0.01, 0.1, -0.2];
        let q = apply_point(&gi, &apply_point(&g, &p));
        for i in 0..3 {
            assert!((p[i] - q[i]).abs() < 1e-14);
        }
    }

    #[test]
    fn hypot_matches_plain_formula() {
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert_eq!(js_hypot(0.0, 0.0), 0.0);
        assert!(js_hypot(f64::NAN, f64::INFINITY).is_infinite());
        assert!(js_hypot(f64::NAN, 1.0).is_nan());
    }
}
