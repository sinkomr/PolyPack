//! Curvature functions that are uniform in the curvature K (K < 0 hyperbolic, K = 0 Euclidean,
//! K > 0 spherical) and smooth through K = 0 (packages/curved/src/kfun.ts).
//!
//! With t = K x^2 the entire functions
//!   C(t) = sum_k (-t)^k / (2k)!      so  cs_K(x) = C(K x^2)   = cos(sqrt(K) x) | 1 | cosh(sqrt(-K) x)
//!   S(t) = sum_k (-t)^k / (2k+1)!    so  sn_K(x) = x S(K x^2) = sin(sqrt(K) x)/sqrt(K) | x | sinh(..)/sqrt(-K)
//!   V(t) = sum_k (-t)^k / (2k+2)!    so  vs_K(x) = (1 - cs_K(x)) / K = x^2 V(K x^2)
//!   U(t) = sum_k (-t)^k / (2k+3)!    so  (1 - S(t)) / t = U(t)
//! never divide by K, so every formula built from them is well conditioned for small |K|.
//!
//! Every function performs the same floating-point operations in the same order as the
//! TypeScript reference, so that the validator reproduces the server's numbers; `Math.*` is
//! `polypack_js::math` (native/PORTING.md), whose transcendental functions are the `libm` crate's.

use polypack_js::math;
use std::f64::consts::PI;

/// Below this |t| the power series are used; above it the closed forms (both are accurate there).
const SERIES_T: f64 = 0.5;

/// packages/curved/src/kfun.ts: series
#[inline]
fn series(t: f64, first: u32) -> f64 {
    // sum_k (-t)^k / (first + 2k)! normalised by first!: term ratio -t / ((first+2k+1)(first+2k+2))
    let mut fact = 1.0;
    let mut i = 2;
    while i <= first {
        fact *= i as f64;
        i += 1;
    }
    let mut term = 1.0 / fact;
    let mut sum = term;
    for k in 0..40u32 {
        let a = (first + 2 * k + 1) as f64;
        term *= -t / (a * (a + 1.0));
        sum += term;
        if term.abs() < 1e-18 * sum.abs() {
            break;
        }
    }
    sum
}

/// packages/curved/src/kfun.ts: Cfun
#[inline]
pub fn cfun(t: f64) -> f64 {
    if t.abs() < SERIES_T {
        return series(t, 0);
    }
    if t > 0.0 {
        return math::cos(t.sqrt());
    }
    math::cosh((-t).sqrt())
}

/// packages/curved/src/kfun.ts: Sfun
#[inline]
pub fn sfun(t: f64) -> f64 {
    if t.abs() < SERIES_T {
        return series(t, 1);
    }
    if t > 0.0 {
        let r = t.sqrt();
        return math::sin(r) / r;
    }
    let r = (-t).sqrt();
    math::sinh(r) / r
}

/// packages/curved/src/kfun.ts: Vfun
#[inline]
pub fn vfun(t: f64) -> f64 {
    if t.abs() < SERIES_T {
        return series(t, 2);
    }
    if t > 0.0 {
        let r = t.sqrt();
        let s = math::sin(r / 2.0);
        return (2.0 * s * s) / t;
    }
    let r = (-t).sqrt();
    let s = math::sinh(r / 2.0);
    (2.0 * s * s) / -t
}

/// packages/curved/src/kfun.ts: Ufun
#[inline]
pub fn ufun(t: f64) -> f64 {
    if t.abs() < SERIES_T {
        return series(t, 3);
    }
    if t > 0.0 {
        let r = t.sqrt();
        return (r - math::sin(r)) / (r * r * r);
    }
    let r = (-t).sqrt();
    (math::sinh(r) - r) / (r * r * r)
}

/// cs_K(x): cos(sqrt(K) x), 1 or cosh(sqrt(-K) x).
/// (packages/curved/src/kfun.ts: csK)
#[inline]
pub fn cs_k(k: f64, x: f64) -> f64 {
    cfun(k * x * x)
}

/// sn_K(x): sin(sqrt(K) x)/sqrt(K), x or sinh(sqrt(-K) x)/sqrt(-K).
/// (packages/curved/src/kfun.ts: snK)
#[inline]
pub fn sn_k(k: f64, x: f64) -> f64 {
    x * sfun(k * x * x)
}

/// tn_K(x) = sn_K(x) / cs_K(x).
/// (packages/curved/src/kfun.ts: tnK)
#[inline]
pub fn tn_k(k: f64, x: f64) -> f64 {
    sn_k(k, x) / cs_k(k, x)
}

/// vs_K(x) = (1 - cs_K(x)) / K = 2 sn_K(x/2)^2; equals x^2/2 at K = 0.
/// (packages/curved/src/kfun.ts: vsK)
#[inline]
pub fn vs_k(k: f64, x: f64) -> f64 {
    x * x * vfun(k * x * x)
}

/// Inverse of sn_K on its monotone branch |x| <= pi/(2 sqrt K). Arguments beyond the range clamp.
/// (packages/curved/src/kfun.ts: asnK)
#[inline]
#[allow(clippy::manual_clamp)] // the source's form: `a > 1 ? 1 : a < -1 ? -1 : a`
pub fn asn_k(k: f64, y: f64) -> f64 {
    if k > 0.0 {
        let r = k.sqrt();
        let a = r * y;
        return math::asin(if a > 1.0 {
            1.0
        } else if a < -1.0 {
            -1.0
        } else {
            a
        }) / r;
    }
    if k < 0.0 {
        let r = (-k).sqrt();
        return math::asinh(r * y) / r;
    }
    y
}

/// Inverse of tn_K. For K < 0 the argument must satisfy |y| < 1/sqrt(-K) (else +-infinity).
/// (packages/curved/src/kfun.ts: atnK)
#[inline]
pub fn atn_k(k: f64, y: f64) -> f64 {
    if k > 0.0 {
        let r = k.sqrt();
        return math::atan(r * y) / r;
    }
    if k < 0.0 {
        let r = (-k).sqrt();
        let a = r * y;
        if a >= 1.0 {
            return f64::INFINITY;
        }
        if a <= -1.0 {
            return f64::NEG_INFINITY;
        }
        return math::atanh(a) / r;
    }
    y
}

/// Length x >= 0 from (sn_K(x), cs_K(x)) given up to a common positive factor. For K > 0 this is
/// the atan2 branch, valid on [0, pi/sqrt K]; for K <= 0 cs is positive and sn decides.
/// (packages/curved/src/kfun.ts: angK)
#[inline]
pub fn ang_k(k: f64, sn: f64, cs: f64) -> f64 {
    if k > 0.0 {
        let r = k.sqrt();
        return math::atan2(r * sn, cs) / r;
    }
    if k < 0.0 {
        // tanh(r x) = r sn / cs; asinh of the normalised sine for accuracy at large x
        let r = (-k).sqrt();
        let a = (cs * cs + k * sn * sn).sqrt();
        return math::asinh((r * sn) / a) / r;
    }
    sn / cs
}

/// Distance from its versine: d with vs_K(d) = v, i.e. d = 2 asn_K(sqrt(v/2)).
/// (packages/curved/src/kfun.ts: distFromVs)
#[inline]
pub fn dist_from_vs(k: f64, v: f64) -> f64 {
    2.0 * asn_k(k, math::sqrt(math::max(0.0, v) / 2.0))
}

/// Half the circumference of the space for K > 0 (antipodal distance), infinity otherwise.
/// (packages/curved/src/kfun.ts: antipodal)
pub fn antipodal(k: f64) -> f64 {
    if k > 0.0 {
        PI / k.sqrt()
    } else {
        f64::INFINITY
    }
}

/// `Math.max(0, v)` of JavaScript for the finite and infinite values that occur here; NaN stays NaN
/// as in JavaScript (f64::max would return 0).
#[inline]
pub fn js_max0(v: f64) -> f64 {
    if v > 0.0 || v.is_nan() {
        v
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_and_closed_forms_agree_at_the_switch() {
        for &t in &[0.4999f64, -0.4999, 0.5, -0.5, 0.25, -2.0, 3.0] {
            let r = t.abs().sqrt();
            let (c, s, v) = if t > 0.0 {
                (r.cos(), r.sin() / r, 2.0 * (r / 2.0).sin().powi(2) / t)
            } else {
                (r.cosh(), r.sinh() / r, 2.0 * (r / 2.0).sinh().powi(2) / -t)
            };
            assert!((cfun(t) - c).abs() < 1e-15);
            assert!((sfun(t) - s).abs() < 1e-15);
            assert!((vfun(t) - v).abs() < 1e-15);
        }
    }

    #[test]
    fn inverse_functions() {
        for &k in &[-1.0, -0.01, 0.0, 1e-6, 0.5, 1.0] {
            for &x in &[0.1, 0.5, 1.0] {
                assert!((asn_k(k, sn_k(k, x)) - x).abs() < 1e-14);
                assert!((atn_k(k, tn_k(k, x)) - x).abs() < 1e-14);
                assert!((ang_k(k, sn_k(k, x), cs_k(k, x)) - x).abs() < 1e-14);
                assert!((dist_from_vs(k, vs_k(k, x)) - x).abs() < 1e-14);
            }
        }
    }
}
