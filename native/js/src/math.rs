//! `Math.*` of V8 (Node), function by function.
//!
//! `sqrt`, `abs`, `floor`, `ceil`, `min` and `max` on finite numbers are the same in every language
//! (IEEE 754); they are here so that a port can keep the shape of its source, and because
//! `Math.max`, `Math.min` and `Math.round` have their own rules for NaN, signed zeros and halves.
//!
//! The transcendental functions are V8's (`crate::fdlibm`) and give Node's bits on Linux x86-64;
//! `pow` is the correctly rounded power behind JavaScript's special cases (`pow.rs`), because V8
//! leaves it to the C library. See the crate's documentation for what was measured.

use crate::fdlibm;

mod pow;

pub const PI: f64 = std::f64::consts::PI;
pub const SQRT2: f64 = std::f64::consts::SQRT_2;
pub const SQRT1_2: f64 = std::f64::consts::FRAC_1_SQRT_2;
pub const E: f64 = std::f64::consts::E;
pub const LN2: f64 = std::f64::consts::LN_2;

/// `Math.sin`
#[inline]
pub fn sin(x: f64) -> f64 {
    fdlibm::sin(x)
}
/// `Math.cos`
#[inline]
pub fn cos(x: f64) -> f64 {
    fdlibm::cos(x)
}
/// `Math.tan`
#[inline]
pub fn tan(x: f64) -> f64 {
    fdlibm::tan(x)
}
/// `Math.asin`
#[inline]
pub fn asin(x: f64) -> f64 {
    fdlibm::asin(x)
}
/// `Math.acos`
#[inline]
pub fn acos(x: f64) -> f64 {
    fdlibm::acos(x)
}
/// `Math.atan`
#[inline]
pub fn atan(x: f64) -> f64 {
    fdlibm::atan(x)
}
/// `Math.atan2`
#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    fdlibm::atan2(y, x)
}
/// `Math.exp`
#[inline]
pub fn exp(x: f64) -> f64 {
    fdlibm::exp(x)
}
/// `Math.expm1`
#[inline]
pub fn expm1(x: f64) -> f64 {
    fdlibm::expm1(x)
}
/// `Math.log`
#[inline]
pub fn log(x: f64) -> f64 {
    fdlibm::log(x)
}
/// `Math.log1p`
#[inline]
pub fn log1p(x: f64) -> f64 {
    fdlibm::log1p(x)
}
/// `Math.log2`
#[inline]
pub fn log2(x: f64) -> f64 {
    fdlibm::log2(x)
}
/// `Math.log10`
#[inline]
pub fn log10(x: f64) -> f64 {
    fdlibm::log10(x)
}
/// `Math.sinh`
#[inline]
pub fn sinh(x: f64) -> f64 {
    fdlibm::sinh(x)
}
/// `Math.cosh`
#[inline]
pub fn cosh(x: f64) -> f64 {
    fdlibm::cosh(x)
}
/// `Math.tanh`
#[inline]
pub fn tanh(x: f64) -> f64 {
    fdlibm::tanh(x)
}
/// `Math.asinh`
#[inline]
pub fn asinh(x: f64) -> f64 {
    fdlibm::asinh(x)
}
/// `Math.acosh`
#[inline]
pub fn acosh(x: f64) -> f64 {
    fdlibm::acosh(x)
}
/// `Math.atanh`
#[inline]
pub fn atanh(x: f64) -> f64 {
    fdlibm::atanh(x)
}
/// `Math.cbrt`
#[inline]
pub fn cbrt(x: f64) -> f64 {
    fdlibm::cbrt(x)
}

/// `Math.pow(x, y)` and `x ** y`: V8's `math::pow` (src/numbers/ieee754.cc), which is the C
/// library's `pow` behind JavaScript's special cases.
///
/// The C library is the one thing here that is not the same on every platform: macOS's and glibc's
/// `pow` are different programs, and each is wrong by one unit in the last place for some arguments
/// (not the same ones). This function is the correctly rounded power: the double nearest to the
/// true value, which is what both libraries return for all but about one argument in a thousand
/// (the counts are in `pow.rs`).
pub fn pow(x: f64, y: f64) -> f64 {
    // 1. If exponent is NaN, return NaN.
    if y.is_nan() {
        return f64::NAN;
    }
    // 9., 10. If exponent is +-Infinity and abs(base) is 1, return NaN (C gives 1).
    if y.is_infinite() && (x == 1.0 || x == -1.0) {
        return f64::NAN;
    }
    // "The following special cases just exist to match the optimizing compilers' behavior, which
    // avoid calls to `pow` in those cases."
    if y == 2.0 {
        // x ** 2   ==>   x * x
        return x * x;
    } else if y == 0.5 {
        // x ** 0.5   ==>  sqrt(x), except if x is -Infinity
        if x.is_infinite() {
            return f64::INFINITY;
        } else {
            // Note the +0 so that we get +0 for -0**0.5 rather than -0.
            return (x + 0.0).sqrt();
        }
    }
    // std::pow(x, y): the cases C99 (Annex F.9.4.4) and ECMAScript (Number::exponentiate) spell
    // out, then the correctly rounded power of |x|.
    if y == 0.0 || x == 1.0 {
        return 1.0; // also for a NaN base with the exponent 0; (1, +-Infinity) and NaN exponents are gone
    }
    if x.is_nan() {
        return f64::NAN;
    }
    // an odd whole exponent keeps the sign of a negative base; every double from 2^53 on is even
    let whole = y == y.trunc();
    let odd = whole && y.abs() < 9007199254740992.0 && (y.abs() as u64) & 1 == 1;
    if x == 0.0 || x.is_infinite() {
        // +-0 and +-Infinity: zero or infinity according to the sign of the exponent
        let large = (x == 0.0) == (y < 0.0);
        let magnitude = if large { f64::INFINITY } else { 0.0 };
        return if odd && x.is_sign_negative() { -magnitude } else { magnitude };
    }
    if y.is_infinite() {
        return if (x.abs() > 1.0) == (y > 0.0) { f64::INFINITY } else { 0.0 };
    }
    if x < 0.0 && !whole {
        return f64::NAN;
    }
    // (-1)^y for a whole y is 1 or -1; 1^y went above
    let r = if x == -1.0 { 1.0 } else { pow::pow_positive(x.abs(), y) };
    if x < 0.0 && odd {
        -r
    } else {
        r
    }
}

/// `x ** n` for a whole exponent, as `Math.pow(x, n)`.
#[inline]
pub fn powi(x: f64, n: i32) -> f64 {
    pow(x, n as f64)
}
#[inline]
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}
#[inline]
pub fn abs(x: f64) -> f64 {
    x.abs()
}
#[inline]
pub fn floor(x: f64) -> f64 {
    x.floor()
}
#[inline]
pub fn ceil(x: f64) -> f64 {
    x.ceil()
}
#[inline]
pub fn trunc(x: f64) -> f64 {
    x.trunc()
}

/// `Math.sign`: NaN for NaN, and a zero keeps its sign.
#[inline]
pub fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// `Math.round`: halves go up (towards +infinity), unlike `f64::round`.
#[inline]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    let f = x.floor();
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    // -0.5 <= x < 0 rounds to -0
    if r == 0.0 && x < 0.0 {
        -0.0
    } else {
        r
    }
}

/// `Math.max(a, b)`: NaN if either is NaN, and +0 is larger than -0.
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a == 0.0 && a.is_sign_negative() {
        b
    } else {
        a
    }
}

/// `Math.min(a, b)`: NaN if either is NaN, and -0 is smaller than +0.
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && a.is_sign_positive() {
        b
    } else {
        a
    }
}

/// `Math.max(...list)`: -Infinity for an empty list.
pub fn max_of(list: &[f64]) -> f64 {
    list.iter().fold(f64::NEG_INFINITY, |m, &v| max(m, v))
}

/// `Math.min(...list)`: Infinity for an empty list.
pub fn min_of(list: &[f64]) -> f64 {
    list.iter().fold(f64::INFINITY, |m, &v| min(m, v))
}

/// `Math.hypot(...list)` as V8 computes it: every value over the largest, squares added with
/// Kahan's compensation, then the root times the largest.
pub fn hypot_of(list: &[f64]) -> f64 {
    if list.is_empty() {
        return 0.0;
    }
    let mut nan = false;
    let mut max = 0.0f64;
    for &v in list {
        if v.is_nan() {
            nan = true;
        } else if v.abs() > max {
            max = v.abs();
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for &v in list {
        let n = v.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.hypot(a, b)`.
#[inline]
pub fn hypot(a: f64, b: f64) -> f64 {
    hypot_of(&[a, b])
}

/// `Math.hypot(a, b, c)`.
#[inline]
pub fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    hypot_of(&[a, b, c])
}

/// `Math.hypot(a, b, c, d)`.
#[inline]
pub fn hypot4(a: f64, b: f64, c: f64, d: f64) -> f64 {
    hypot_of(&[a, b, c, d])
}

/// `Math.imul(a, b)`: the low 32 bits of the product, as a signed integer.
#[inline]
pub fn imul(a: i32, b: i32) -> i32 {
    a.wrapping_mul(b)
}
