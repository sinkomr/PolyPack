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

use crate::kfun::{asn_k, cs_k, dist_from_vs, sfun, sn_k, ufun, vfun};
use polypack_js::math;

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
/// (packages/curved/src/space.ts: transvection)
pub fn transvection(k: f64, x: f64, y: f64) -> Motion {
    let d2 = x * x + y * y;
    let t = k * d2;
    transvection_of(k, x, y, d2, sfun(t), vfun(t))
}

/// transvection(K, x, y) from D^2 = x^2 + y^2 and S, V at K D^2
/// (packages/curved/src/space.ts: transvectionOf).
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

/// (packages/curved/src/space.ts: rotation)
pub fn rotation(theta: f64) -> Motion {
    let c = math::cos(theta);
    let s = math::sin(theta);
    Motion {
        l: [1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c],
        b: [0.0; 3],
    }
}

/// a o b (apply b first).
/// (packages/curved/src/space.ts: compose)
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

/// Pose motion G = T(x, y) R(theta): the piece frame of a pose. The TypeScript's poseMotion is
/// poseFrame(...).G, whose entries are the same sums in the same order as compose(T, R) forms them,
/// so the two give the same bits (the test `pose_frame_is_compose` checks it).
pub fn pose_motion(k: f64, x: f64, y: f64, theta: f64) -> Motion {
    compose(&transvection(k, x, y), &rotation(theta))
}

/// The pose motion G with the scalars it was built from: t = K (x^2 + y^2), S(t), V(t), cos theta
/// and sin theta, which body_jacobian_of takes (packages/curved/src/space.ts: PoseFrame).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PoseFrame {
    pub g: Motion,
    pub t: f64,
    pub s_t: f64,
    pub v_t: f64,
    pub c: f64,
    pub s: f64,
}

/// packages/curved/src/space.ts: poseFrame. The product T(x, y) R(theta) written out with R's
/// entries as scalars, each entry the same sum, in the same order, as compose(T, R) forms it.
pub fn pose_frame(k: f64, x: f64, y: f64, theta: f64) -> PoseFrame {
    let d2 = x * x + y * y;
    let t = k * d2;
    let s_t = sfun(t);
    let v_t = vfun(t);
    let tr = transvection_of(k, x, y, d2, s_t, v_t);
    let a = &tr.l;
    let c = math::cos(theta);
    let s = math::sin(theta);
    let ms = -s;
    let mut l = [0.0; 9];
    let mut v = [0.0; 3];
    for i in 0..3 {
        let a0 = a[3 * i];
        let a1 = a[3 * i + 1];
        let a2 = a[3 * i + 2];
        // R = [[1, 0, 0], [0, c, -s], [0, s, c]], R.b = 0
        l[3 * i] = a0 * 1.0 + a1 * 0.0 + a2 * 0.0;
        l[3 * i + 1] = a0 * 0.0 + a1 * c + a2 * s;
        l[3 * i + 2] = a0 * 0.0 + a1 * ms + a2 * c;
        v[i] = a0 * 0.0 + a1 * 0.0 + a2 * 0.0 + tr.b[i];
    }
    PoseFrame {
        g: Motion { l, b: v },
        t,
        s_t,
        v_t,
        c,
        s,
    }
}

/// bodyJacobian from the scalars of the pose's frame (packages/curved/src/space.ts: bodyJacobianOf).
/// Chain rule from body-frame velocities (dx_b, dy_b, dtheta_b), defined by
/// dG = G (dx_b P_x + dy_b P_y + dtheta_b J), to the pose coordinates (x, y, theta) of G = T(x, y) R(theta):
///   body translation = R(-theta) A dw,  A = S I + K U w w^T,
///   body rotation    = dtheta - K V (x dy - y dx),
/// with S, U, V evaluated at K |w|^2. Returns the 3x3 matrix Jb (row-major), body = Jb . (dx, dy, dtheta).
/// The validator never reads it (the TypeScript builds it only when a gradient row asks).
pub fn body_jacobian_of(k: f64, x: f64, y: f64, t: f64, s_t: f64, v_t: f64, c: f64, s: f64) -> [f64; 9] {
    let u = ufun(t);
    let a00 = s_t + k * u * x * x;
    let a01 = k * u * x * y;
    let a11 = s_t + k * u * y * y;
    // R(-theta) = [[c, s], [-s, c]]
    let mut j = [0.0; 9];
    j[0] = c * a00 + s * a01;
    j[1] = c * a01 + s * a11;
    j[3] = -s * a00 + c * a01;
    j[4] = -s * a01 + c * a11;
    j[6] = k * v_t * y;
    j[7] = -k * v_t * x;
    j[8] = 1.0;
    j
}

/// G^{-1} = R(-theta) T(-x, -y).
/// (packages/curved/src/space.ts: poseMotionInverse)
pub fn pose_motion_inverse(k: f64, x: f64, y: f64, theta: f64) -> Motion {
    compose(&rotation(-theta), &transvection(k, -x, -y))
}

/// (packages/curved/src/space.ts: applyPoint)
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
/// (packages/curved/src/space.ts: polarPoint)
pub fn polar_point(k: f64, r: f64, a: f64) -> LPoint {
    let s = sn_k(k, r);
    let t = k * r * r;
    [r * r * vfun(t), s * math::cos(a), s * math::sin(a)]
}

/// Versine vs_K of the distance between two normalised lifted points: (|dx|^2 + K de^2) / 2.
/// (packages/curved/src/space.ts: pairVs)
#[inline]
pub fn pair_vs(k: f64, p: &LPoint, q: &LPoint) -> f64 {
    let dx = p[1] - q[1];
    let dy = p[2] - q[2];
    let de = p[0] - q[0];
    (dx * dx + dy * dy + k * de * de) / 2.0
}

/// (packages/curved/src/space.ts: distance)
#[inline]
pub fn distance(k: f64, p: &LPoint, q: &LPoint) -> f64 {
    dist_from_vs(k, pair_vs(k, p, q))
}

/// Covector of the line at signed distance h from O with outward normal angle a (Qd = 1).
/// (packages/curved/src/space.ts: lineCovector)
pub fn line_covector(k: f64, h: f64, a: f64) -> [f64; 3] {
    let c = cs_k(k, h);
    [-sn_k(k, h), c * math::cos(a), c * math::sin(a)]
}

/// n . v for lifted p: sn_K(signed distance) when n is normalised (Qd = 1) and p normalised.
/// (packages/curved/src/space.ts: lineValue)
#[inline]
pub fn line_value(k: f64, n: &[f64; 3], p: &LPoint) -> f64 {
    n[0] * (1.0 - k * p[0]) + n[1] * p[1] + n[2] * p[2]
}

/// Signed distance from the normalised line n (positive on the side n . v > 0).
/// (packages/curved/src/space.ts: signedDistance)
#[inline]
pub fn signed_distance(k: f64, n: &[f64; 3], p: &LPoint) -> f64 {
    asn_k(k, line_value(k, n, p))
}

/// Homogeneous cross product a x b of two lifted points: the covector of the line through them.
/// (packages/curved/src/space.ts: lineThrough)
#[inline]
pub fn line_through(k: f64, a: &LPoint, b: &LPoint) -> [f64; 3] {
    let a0 = 1.0 - k * a[0];
    let b0 = 1.0 - k * b[0];
    [a[1] * b[2] - a[2] * b[1], a[2] * b0 - a0 * b[2], a0 * b[1] - a[1] * b0]
}

/// Qd(n) = |n_vec|^2 + K n0^2 (invariant under isometries for covectors).
/// (packages/curved/src/space.ts: covectorNorm2)
#[inline]
pub fn covector_norm2(k: f64, n: &[f64; 3]) -> f64 {
    n[1] * n[1] + n[2] * n[2] + k * n[0] * n[0]
}

/// Exponential map at O: the point at distance |w| in direction w.
/// (packages/curved/src/space.ts: expO)
pub fn exp_o(k: f64, x: f64, y: f64) -> LPoint {
    let d2 = x * x + y * y;
    let s = sfun(k * d2);
    [d2 * vfun(k * d2), s * x, s * y]
}

/// `Math.min(a, b)` of JavaScript (polypack_js::math::min): NaN when either is NaN, -0 below +0.
#[inline]
pub fn js_min(a: f64, b: f64) -> f64 {
    math::min(a, b)
}

/// `Math.hypot(x, y)` as V8 computes it (polypack_js::math::hypot: Kahan-compensated sum of
/// squares scaled by the largest), which is not the C library's hypot.
#[inline]
pub fn js_hypot(x: f64, y: f64) -> f64 {
    math::hypot(x, y)
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
    fn pose_frame_is_compose() {
        // the claim of the TypeScript's poseMotion: the written-out product has compose's bits
        let mut seed = 1u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5) * 6.0
        };
        for &k in &[-6.5, -1.0, -1e-6, 0.0, 1e-6, 0.3, 1.0] {
            for _ in 0..200 {
                let (x, y, th) = (next(), next(), next());
                let f = pose_frame(k, x, y, th);
                let g = pose_motion(k, x, y, th);
                for i in 0..9 {
                    assert_eq!(f.g.l[i].to_bits(), g.l[i].to_bits());
                }
                for i in 0..3 {
                    assert_eq!(f.g.b[i].to_bits(), g.b[i].to_bits());
                }
            }
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
