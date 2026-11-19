//! Rotations of R^3 for the pieces' orientations: 3 x 3 matrices stored row-major in 9 numbers, an
//! orientation being an orthogonal matrix (improper after a gluing that reverses handedness; the
//! Platonic solids are mirror-symmetric, so an improper orientation is a proper one of the same piece).
//! Port of packages/boundary/src/search/rot.ts (what the search reaches) and linalg.ts: matrixToQuaternion.

use super::random::Mulberry32;
use polypack_js::math;

/// packages/boundary/src/search/rot.ts: mul9. `out` may not alias `a` or `b`.
pub fn mul9(a: &[f64], ao: usize, b: &[f64], bo: usize, out: &mut [f64], oo: usize) {
    let (a0, a1, a2, a3, a4, a5, a6, a7, a8) = (a[ao], a[ao + 1], a[ao + 2], a[ao + 3], a[ao + 4], a[ao + 5], a[ao + 6], a[ao + 7], a[ao + 8]);
    let (b0, b1, b2, b3, b4, b5, b6, b7, b8) = (b[bo], b[bo + 1], b[bo + 2], b[bo + 3], b[bo + 4], b[bo + 5], b[bo + 6], b[bo + 7], b[bo + 8]);
    out[oo] = a0 * b0 + a1 * b3 + a2 * b6;
    out[oo + 1] = a0 * b1 + a1 * b4 + a2 * b7;
    out[oo + 2] = a0 * b2 + a1 * b5 + a2 * b8;
    out[oo + 3] = a3 * b0 + a4 * b3 + a5 * b6;
    out[oo + 4] = a3 * b1 + a4 * b4 + a5 * b7;
    out[oo + 5] = a3 * b2 + a4 * b5 + a5 * b8;
    out[oo + 6] = a6 * b0 + a7 * b3 + a8 * b6;
    out[oo + 7] = a6 * b1 + a7 * b4 + a8 * b7;
    out[oo + 8] = a6 * b2 + a7 * b5 + a8 * b8;
}

/// packages/boundary/src/search/rot.ts: det9
pub fn det9(m: &[f64], o: usize) -> f64 {
    m[o] * (m[o + 4] * m[o + 8] - m[o + 5] * m[o + 7]) - m[o + 1] * (m[o + 3] * m[o + 8] - m[o + 5] * m[o + 6]) + m[o + 2] * (m[o + 3] * m[o + 7] - m[o + 4] * m[o + 6])
}

/// exp of the cross-product matrix of w (Rodrigues). packages/boundary/src/search/rot.ts: expRot
pub fn exp_rot(w0: f64, w1: f64, w2: f64, out: &mut [f64], oo: usize) {
    let t2 = w0 * w0 + w1 * w1 + w2 * w2;
    let t = t2.sqrt();
    let (a, b);
    if t < 1e-4 {
        a = 1.0 - t2 / 6.0 + (t2 * t2) / 120.0;
        b = 0.5 - t2 / 24.0 + (t2 * t2) / 720.0;
    } else {
        a = math::sin(t) / t;
        b = (1.0 - math::cos(t)) / t2;
    }
    // R = I + a K + b K^2, K = [w]x
    out[oo] = 1.0 + b * (-w1 * w1 - w2 * w2);
    out[oo + 1] = -a * w2 + b * w0 * w1;
    out[oo + 2] = a * w1 + b * w0 * w2;
    out[oo + 3] = a * w2 + b * w0 * w1;
    out[oo + 4] = 1.0 + b * (-w0 * w0 - w2 * w2);
    out[oo + 5] = -a * w0 + b * w1 * w2;
    out[oo + 6] = -a * w1 + b * w0 * w2;
    out[oo + 7] = a * w0 + b * w1 * w2;
    out[oo + 8] = 1.0 + b * (-w0 * w0 - w1 * w1);
}

/// The left Jacobian of the exponential: exp(w + dw) = exp(Jl dw) exp(w) to first order.
/// packages/boundary/src/search/rot.ts: leftJacobian
pub fn left_jacobian(w0: f64, w1: f64, w2: f64, out: &mut [f64], oo: usize) {
    let t2 = w0 * w0 + w1 * w1 + w2 * w2;
    let t = t2.sqrt();
    let (b, c);
    if t < 1e-3 {
        b = 0.5 - t2 / 24.0;
        c = 1.0 / 6.0 - t2 / 120.0;
    } else {
        b = (1.0 - math::cos(t)) / t2;
        c = (t - math::sin(t)) / (t2 * t);
    }
    // I + b K + c K^2
    out[oo] = 1.0 + c * (-w1 * w1 - w2 * w2);
    out[oo + 1] = -b * w2 + c * w0 * w1;
    out[oo + 2] = b * w1 + c * w0 * w2;
    out[oo + 3] = b * w2 + c * w0 * w1;
    out[oo + 4] = 1.0 + c * (-w0 * w0 - w2 * w2);
    out[oo + 5] = -b * w0 + c * w1 * w2;
    out[oo + 6] = -b * w1 + c * w0 * w2;
    out[oo + 7] = b * w0 + c * w1 * w2;
    out[oo + 8] = 1.0 + c * (-w0 * w0 - w1 * w1);
}

/// Gram-Schmidt on the rows of an almost orthogonal matrix, in place (keeps the handedness).
/// packages/boundary/src/search/rot.ts: orthonormalize
pub fn orthonormalize(m: &mut [f64], o: usize) {
    let mut n0 = math::hypot3(m[o], m[o + 1], m[o + 2]);
    m[o] /= n0;
    m[o + 1] /= n0;
    m[o + 2] /= n0;
    let mut d = m[o] * m[o + 3] + m[o + 1] * m[o + 4] + m[o + 2] * m[o + 5];
    m[o + 3] -= d * m[o];
    m[o + 4] -= d * m[o + 1];
    m[o + 5] -= d * m[o + 2];
    n0 = math::hypot3(m[o + 3], m[o + 4], m[o + 5]);
    m[o + 3] /= n0;
    m[o + 4] /= n0;
    m[o + 5] /= n0;
    // the third row from the cross product, with the sign of the original third row
    let cx = m[o + 1] * m[o + 5] - m[o + 2] * m[o + 4];
    let cy = m[o + 2] * m[o + 3] - m[o] * m[o + 5];
    let cz = m[o] * m[o + 4] - m[o + 1] * m[o + 3];
    d = cx * m[o + 6] + cy * m[o + 7] + cz * m[o + 8];
    let sg = if d < 0.0 { -1.0 } else { 1.0 };
    m[o + 6] = sg * cx;
    m[o + 7] = sg * cy;
    m[o + 8] = sg * cz;
}

/// A uniformly random rotation matrix (random unit quaternion). packages/boundary/src/search/rot.ts: randomRotation
pub fn random_rotation(rand: &mut Mulberry32) -> [f64; 9] {
    let (mut w, mut x, mut y, mut z, mut n);
    loop {
        w = 2.0 * rand.next() - 1.0;
        x = 2.0 * rand.next() - 1.0;
        y = 2.0 * rand.next() - 1.0;
        z = 2.0 * rand.next() - 1.0;
        n = w * w + x * x + y * y + z * z;
        if !(n > 1.0 || n < 1e-6) {
            break;
        }
    }
    let r = 1.0 / n.sqrt();
    w *= r;
    x *= r;
    y *= r;
    z *= r;
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

/// Unit quaternion (w, x, y, z) of a proper rotation matrix (row-major), w >= 0.
/// packages/boundary/src/linalg.ts: matrixToQuaternion
pub fn matrix_to_quaternion(m: &[f64]) -> [f64; 4] {
    let tr = m[0] + m[4] + m[8];
    let (w, x, y, z);
    if tr > 0.0 {
        let s = (tr + 1.0).sqrt() * 2.0;
        w = s / 4.0;
        x = (m[7] - m[5]) / s;
        y = (m[2] - m[6]) / s;
        z = (m[3] - m[1]) / s;
    } else if m[0] > m[4] && m[0] > m[8] {
        let s = (1.0 + m[0] - m[4] - m[8]).sqrt() * 2.0;
        w = (m[7] - m[5]) / s;
        x = s / 4.0;
        y = (m[1] + m[3]) / s;
        z = (m[2] + m[6]) / s;
    } else if m[4] > m[8] {
        let s = (1.0 + m[4] - m[0] - m[8]).sqrt() * 2.0;
        w = (m[2] - m[6]) / s;
        x = (m[1] + m[3]) / s;
        y = s / 4.0;
        z = (m[5] + m[7]) / s;
    } else {
        let s = (1.0 + m[8] - m[0] - m[4]).sqrt() * 2.0;
        w = (m[3] - m[1]) / s;
        x = (m[2] + m[6]) / s;
        y = (m[5] + m[7]) / s;
        z = s / 4.0;
    }
    let n = math::hypot4(w, x, y, z);
    let sg = if w < 0.0 { -1.0 } else { 1.0 };
    [(sg * w) / n, (sg * x) / n, (sg * y) / n, (sg * z) / n]
}
