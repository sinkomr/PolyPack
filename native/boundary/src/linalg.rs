//! Small dense linear algebra for the boundary engine: d-vectors, 3-vectors and rigid motions of
//! R^3 (the cells' local coordinates). Port of packages/boundary/src/linalg.ts, the functions the
//! server reaches.

use crate::types::Affine;
use polypack_js::math;

pub type V3 = [f64; 3];

/// packages/boundary/src/linalg.ts: dot
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut s = 0.0;
    for i in 0..a.len() {
        s += a[i] * b[i];
    }
    s
}

/// packages/boundary/src/linalg.ts: norm
pub fn norm(a: &[f64]) -> f64 {
    dot(a, a).sqrt()
}

/// packages/boundary/src/linalg.ts: sub
pub fn sub(a: &[f64], b: &[f64]) -> Vec<f64> {
    a.iter().enumerate().map(|(i, x)| x - b[i]).collect()
}

/// packages/boundary/src/linalg.ts: unit
pub fn unit(a: &[f64]) -> Vec<f64> {
    let n = norm(a);
    a.iter().map(|x| x / n).collect()
}

/// Gram-Schmidt: an orthonormal basis of the span of `vs` (in order), skipping vectors whose
/// residual after the previous ones is shorter than `eps` times their length.
/// packages/boundary/src/linalg.ts: orthonormalBasis
pub fn orthonormal_basis(vs: &[Vec<f64>], eps: f64) -> Vec<Vec<f64>> {
    let mut out: Vec<Vec<f64>> = Vec::new();
    for v in vs {
        let mut r = v.clone();
        // two passes for numerical orthogonality
        for _pass in 0..2 {
            for b in &out {
                let c = dot(&r, b);
                r = r.iter().enumerate().map(|(i, x)| x - c * b[i]).collect();
            }
        }
        let n = norm(&r);
        if n > eps * math::max(1.0, norm(v)) {
            out.push(r.iter().map(|x| x / n).collect());
        }
    }
    out
}

/// Component of v orthogonal to the orthonormal vectors `basis`.
/// packages/boundary/src/linalg.ts: rejectFrom
pub fn reject_from(v: &[f64], basis: &[Vec<f64>]) -> Vec<f64> {
    let mut r = v.to_vec();
    for _pass in 0..2 {
        for b in basis {
            let c = dot(&r, b);
            r = r.iter().enumerate().map(|(i, x)| x - c * b[i]).collect();
        }
    }
    r
}

// ---------------------------------------------------------------- 3-vectors

#[inline]
pub fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
pub fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
pub fn add3(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
pub fn cross3(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
pub fn norm3(a: V3) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}
#[inline]
pub fn unit3(a: V3) -> V3 {
    let n = norm3(a);
    [a[0] / n, a[1] / n, a[2] / n]
}
/// packages/boundary/src/linalg.ts: toV3
#[inline]
pub fn to_v3(a: &[f64]) -> V3 {
    [a[0], a[1], a[2]]
}

/// Distance from p to the segment [a, b].
/// packages/boundary/src/linalg.ts: pointSegmentDistance3
pub fn point_segment_distance3(p: V3, a: V3, b: V3) -> f64 {
    let e = sub3(b, a);
    let l2 = dot3(e, e);
    let mut t = if l2 > 0.0 { dot3(sub3(p, a), e) / l2 } else { 0.0 };
    t = if t < 0.0 {
        0.0
    } else if t > 1.0 {
        1.0
    } else {
        t
    };
    norm3(sub3(p, [a[0] + t * e[0], a[1] + t * e[1], a[2] + t * e[2]]))
}

// ---------------------------------------------------------------- rigid motions of R^3

/// A rigid motion of R^3, possibly orientation-reversing: y = M x + t, with M orthogonal and
/// stored row-major in 9 numbers. Gluings between cells whose frames have opposite handedness
/// reverse orientation, so det M = -1 occurs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Iso3 {
    pub m: [f64; 9],
    pub t: V3,
}

pub const ISO_IDENTITY: Iso3 = Iso3 { m: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], t: [0.0, 0.0, 0.0] };

/// packages/boundary/src/linalg.ts: isoApply
#[inline]
pub fn iso_apply(t: &Iso3, p: V3) -> V3 {
    let m = &t.m;
    [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + t.t[0],
        m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + t.t[1],
        m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + t.t[2],
    ]
}

/// The linear part only (for directions and normals).
/// packages/boundary/src/linalg.ts: isoLinear
#[inline]
pub fn iso_linear(t: &Iso3, v: V3) -> V3 {
    let m = &t.m;
    [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}

/// Transposed linear part: the inverse for directions, since M is orthogonal.
/// packages/boundary/src/linalg.ts: isoLinearT
#[inline]
pub fn iso_linear_t(t: &Iso3, v: V3) -> V3 {
    let m = &t.m;
    [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]]
}

/// A after B: x -> A(B(x)).
/// packages/boundary/src/linalg.ts: isoCompose
pub fn iso_compose(a_: &Iso3, b_: &Iso3) -> Iso3 {
    let a = &a_.m;
    let b = &b_.m;
    let mut m = [0.0; 9];
    for i in 0..3 {
        for j in 0..3 {
            m[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
        }
    }
    Iso3 { m, t: add3(iso_linear(a_, b_.t), a_.t) }
}

/// Inverse of a rigid motion (M orthogonal): x = M^T (y - t).
/// packages/boundary/src/linalg.ts: isoInverse
pub fn iso_inverse(t_: &Iso3) -> Iso3 {
    let m = &t_.m;
    let mt = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    let t = iso_linear_t(t_, t_.t);
    Iso3 { m: mt, t: [-t[0], -t[1], -t[2]] }
}

/// The contract's Affine (s = 1 translation b) at edge s, as an Iso3.
/// packages/boundary/src/linalg.ts: isoFromAffine
pub fn iso_from_affine(a: &Affine, s: f64) -> Iso3 {
    let m = &a.a;
    Iso3 {
        m: [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]],
        t: [s * a.b[0], s * a.b[1], s * a.b[2]],
    }
}

/// packages/boundary/src/linalg.ts: isoToAffine
pub fn iso_to_affine(t: &Iso3) -> Affine {
    let m = &t.m;
    Affine {
        a: vec![vec![m[0], m[1], m[2]], vec![m[3], m[4], m[5]], vec![m[6], m[7], m[8]]],
        b: vec![t.t[0], t.t[1], t.t[2]],
    }
}

/// Rotation matrix of a unit quaternion (w, x, y, z), row-major: v -> q v q*. The quaternion is
/// normalised first, so a quaternion off unit length by rounding still gives an orthogonal matrix.
/// packages/boundary/src/linalg.ts: quaternionToMatrix
pub fn quaternion_to_matrix(q: &[f64]) -> [f64; 9] {
    let n = math::hypot4(q[0], q[1], q[2], q[3]);
    let w = q[0] / n;
    let x = q[1] / n;
    let y = q[2] / n;
    let z = q[3] / n;
    [
        1.0 - 2.0 * (y * y + z * z),
        2.0 * (x * y - w * z),
        2.0 * (x * z + w * y),
        2.0 * (x * y + w * z),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z - w * x),
        2.0 * (x * z - w * y),
        2.0 * (y * z + w * x),
        1.0 - 2.0 * (x * x + y * y),
    ]
}
