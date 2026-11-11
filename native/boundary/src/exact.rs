//! Exact comparisons of a binary64 number against a rational, for the lower bounds: each bound is
//! the largest binary64 value not above its exact value, decided with integers.
//!
//! The source has these three functions three times, word for word:
//! packages/boundary/src/kernel-validate.ts, ncube/bounds.ts and nd/bounds.ts (compare, step,
//! largestFloat, on BigInt). They are ported once here, on `num_bigint::BigUint`.

use num_bigint::BigUint;
use std::cmp::Ordering;

/// The sign of x^p - num / den, exactly, for a positive finite x and positive integers num, den.
/// packages/boundary/src/kernel-validate.ts: compare
pub fn compare(x: f64, p: u32, num: &BigUint, den: &BigUint) -> i32 {
    let bits = x.to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i64;
    let frac = bits & ((1u64 << 52) - 1);
    // x = m 2^e
    let m = if exp == 0 { frac } else { frac | (1u64 << 52) };
    let e = (if exp == 0 { 1 } else { exp }) - 1075;
    let mut left = BigUint::from(m).pow(p) * den;
    let mut right = num.clone();
    let shift = e * p as i64;
    if shift >= 0 {
        left <<= shift as u64;
    } else {
        right <<= (-shift) as u64;
    }
    match left.cmp(&right) {
        Ordering::Greater => 1,
        Ordering::Less => -1,
        Ordering::Equal => 0,
    }
}

/// The next binary64 value above (dir 1) or below (dir -1) a positive finite x.
/// packages/boundary/src/kernel-validate.ts: step
pub fn step(x: f64, dir: i32) -> f64 {
    let bits = x.to_bits();
    f64::from_bits(if dir > 0 { bits.wrapping_add(1) } else { bits.wrapping_sub(1) })
}

/// The largest binary64 x with check(x) true, near approx (check monotone in x).
/// packages/boundary/src/kernel-validate.ts: largestFloat
pub fn largest_float(check: impl Fn(f64) -> bool, approx: f64) -> f64 {
    let mut f = approx;
    while !check(f) {
        f = step(f, -1);
    }
    while check(step(f, 1)) {
        f = step(f, 1);
    }
    f
}

/// floor(pi 10^60). The source's PI_60.
pub fn pi_60() -> BigUint {
    "3141592653589793238462643383279502884197169399375105820974944".parse().expect("digits")
}

/// 10^60. The source's TEN60.
pub fn ten60() -> BigUint {
    BigUint::from(10u32).pow(60)
}

/// V_n = (num / den) pi^k for n = 4..9 (the volume of the unit n-ball).
/// packages/boundary/src/ncube/bounds.ts and nd/bounds.ts: BALL_VOLUME
pub fn ball_volume(n: usize) -> Option<(u32, u32, u32)> {
    Some(match n {
        4 => (1, 2, 2),
        5 => (8, 15, 2),
        6 => (1, 6, 3),
        7 => (16, 105, 3),
        8 => (1, 24, 4),
        9 => (32, 945, 4),
        _ => return None,
    })
}
