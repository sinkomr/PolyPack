//! The tesseract's lower bound. Port of packages/boundary/src/kernel-validate.ts: boundaryBound, the
//! one function of that file the server reaches (the rest is the generic methods' kernel).

use crate::exact::{compare, largest_float, pi_60};
use num_bigint::BigUint;
use polypack_js::math;

/// The problem's lower bound on s as the records store it (python/boundary/build_records.py
/// bounds_of; docs/spaces/BOUNDARY.md section 5): the larger of the volume bound and the one-piece
/// bound, each the largest binary64 value not above its exact value. Balls (diameter 1):
/// (P pi / 48)^(1/3) and 1 / sqrt 2, exactly half the values for balls of radius 1; cubes:
/// (P / 8)^(1/3) and 1 / sqrt 2. Each comparison is decided exactly, with integers.
/// packages/boundary/src/kernel-validate.ts: boundaryBound
pub fn boundary_bound(piece: &str, p: f64) -> f64 {
    let pb = BigUint::from(p as u64);
    let one_n = BigUint::from(1u32);
    let two = BigUint::from(2u32);
    if piece == "ball" {
        // x^3 <= P pi / 48, with pi bracketed to 60 decimals (no binary64 cube lies in the bracket's width)
        let num = &pb * pi_60();
        let den = BigUint::from(48u32) * BigUint::from(10u32).pow(60);
        let volume = largest_float(|x| compare(x, 3, &num, &den) <= 0, math::cbrt((p * math::PI) / 48.0));
        let one = largest_float(|x| compare(x, 2, &one_n, &two) <= 0, math::SQRT1_2);
        return math::max(volume, one);
    }
    let eight = BigUint::from(8u32);
    let volume = largest_float(|x| compare(x, 3, &pb, &eight) <= 0, math::cbrt(p / 8.0));
    let one = largest_float(|x| compare(x, 2, &one_n, &two) <= 0, math::SQRT1_2);
    math::max(volume, one)
}
