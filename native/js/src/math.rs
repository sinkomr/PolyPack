//! `Math.*` of V8 (Node), function by function.
//!
//! `sqrt`, `abs`, `floor`, `ceil`, `min` and `max` on finite numbers are the same in every language
//! (IEEE 754); they are here so that a port can keep the shape of its source, and because
//! `Math.max`, `Math.min` and `Math.round` have their own rules for NaN, signed zeros and halves.

pub const PI: f64 = std::f64::consts::PI;
pub const SQRT2: f64 = std::f64::consts::SQRT_2;
pub const SQRT1_2: f64 = std::f64::consts::FRAC_1_SQRT_2;
pub const E: f64 = std::f64::consts::E;
pub const LN2: f64 = std::f64::consts::LN_2;

#[inline]
pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}
#[inline]
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}
#[inline]
pub fn tan(x: f64) -> f64 {
    libm::tan(x)
}
#[inline]
pub fn asin(x: f64) -> f64 {
    libm::asin(x)
}
#[inline]
pub fn acos(x: f64) -> f64 {
    libm::acos(x)
}
#[inline]
pub fn atan(x: f64) -> f64 {
    libm::atan(x)
}
#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}
#[inline]
pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}
#[inline]
pub fn log(x: f64) -> f64 {
    libm::log(x)
}
#[inline]
pub fn log2(x: f64) -> f64 {
    libm::log2(x)
}
#[inline]
pub fn log10(x: f64) -> f64 {
    libm::log10(x)
}
#[inline]
pub fn sinh(x: f64) -> f64 {
    libm::sinh(x)
}
#[inline]
pub fn cosh(x: f64) -> f64 {
    libm::cosh(x)
}
#[inline]
pub fn tanh(x: f64) -> f64 {
    libm::tanh(x)
}
#[inline]
pub fn asinh(x: f64) -> f64 {
    libm::asinh(x)
}
#[inline]
pub fn atanh(x: f64) -> f64 {
    libm::atanh(x)
}
#[inline]
pub fn cbrt(x: f64) -> f64 {
    libm::cbrt(x)
}
#[inline]
pub fn pow(x: f64, y: f64) -> f64 {
    // JavaScript's rules where they differ from C's: NaN for a NaN exponent (even of 1) and for
    // (+-1) ** (+-Infinity); V8 gives x * x for the exponent 2 and the root for 0.5
    if y.is_nan() || ((x == 1.0 || x == -1.0) && y.is_infinite()) {
        return f64::NAN;
    }
    if y == 2.0 {
        return x * x;
    }
    libm::pow(x, y)
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
