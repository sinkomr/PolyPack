//! Lower bounds, sizes and costs of the d-cube problems (docs/spaces/BOUNDARY.md section 4B).
//! Port of packages/boundary/src/ncube/bounds.ts.
//!
//! The container is the boundary of the d-cube [-s/2, s/2]^d: 2d facets, each a (d-1)-cube of edge
//! s, so its (d-1)-volume is 2d s^(d-1). Balls have diameter 1 and cubes edge 1. Both bounds below
//! are proved and stored as the largest binary64 value not above the exact one (decided in integer
//! arithmetic), as the tesseract's (kernel_validate.rs boundary_bound):
//!  - volume: the developed pieces have disjoint interiors and a development is injective on
//!    interiors, so P vol(piece) <= 2d s^(d-1). A ball's volume is V_n / 2^n, V_n the volume of the
//!    unit n-ball, n = d - 1;
//!  - one piece: a ball's centre is at distance >= 1/2 from the hinges, and the clearance is at most
//!    h sqrt 2 (the two slacks h - |u_k| are at most h), so s >= 1/sqrt 2; a cube needs s >= 1 (with
//!    s < 1 it crosses every axis of its cell, and two crossed axes put a hinge inside it, 4.3).

use super::lattice::ncube_dim;
use crate::exact::{ball_volume, compare, largest_float, pi_60, ten60};
use num_bigint::BigUint;
use polypack_js::math;

/// Largest P of each d-cube problem set: the first tilings (P = 2d k^(d-1) at s = k) for d = 5, 6, then a common cap.
/// packages/boundary/src/ncube/bounds.ts: NCUBE_MAX_P
pub fn ncube_max_p(name: &str) -> Option<usize> {
    Some(match name {
        "5cube" => 160,
        "6cube" => 384,
        "7cube" | "8cube" | "9cube" | "10cube" => 400,
        _ => return None,
    })
}

/// The bound on s of P pieces on the boundary of the d-cube (header).
/// packages/boundary/src/ncube/bounds.ts: ncubeBound
pub fn ncube_bound(d: usize, piece: &str, p: f64) -> f64 {
    let n = d - 1;
    let one = if piece == "ball" { largest_float(|x| compare(x, 2, &BigUint::from(1u32), &BigUint::from(2u32)) <= 0, math::SQRT1_2) } else { 1.0 };
    let volume;
    if piece == "cube" {
        // P <= 2d s^n
        let num = BigUint::from(p as u64);
        let den = BigUint::from(2 * d as u64);
        volume = largest_float(|x| compare(x, n as u32, &num, &den) <= 0, math::pow(p / (2 * d) as f64, 1.0 / n as f64));
    } else {
        // P V_n 2^-n <= 2d s^n with pi replaced by its truncation (a smaller bound, so a valid one)
        let (vn, vd, vk) = ball_volume(n).expect("n = 4..9");
        let num = BigUint::from(p as u64) * BigUint::from(vn) * pi_60().pow(vk);
        let den = BigUint::from(vd) * BigUint::from(2u32).pow(n as u32 + 1) * BigUint::from(d as u64) * ten60().pow(vk);
        volume = largest_float(
            |x| compare(x, n as u32, &num, &den) <= 0,
            math::pow((p * math::pow(math::PI, vk as f64) * vn as f64) / (vd as f64 * math::pow(2.0, (n + 1) as f64) * d as f64), 1.0 / n as f64),
        );
    }
    math::max(one, volume)
}

/// The volume of the unit n-ball (floats), for the validator's volume test.
/// packages/boundary/src/ncube/bounds.ts: unitBallVolume
pub fn unit_ball_volume(n: usize) -> f64 {
    let (vn, vd, vk) = ball_volume(n).expect("n = 4..9");
    (vn as f64 / vd as f64) * math::pow(math::PI, vk as f64)
}

/// The bound of a problem by its container name.
/// packages/boundary/src/ncube/bounds.ts: ncubeProblemBound
pub fn ncube_problem_bound(polytope: &str, piece: &str, p: f64) -> Result<f64, String> {
    let d = ncube_dim(polytope);
    if d == 0 {
        return Err(format!("ncubeProblemBound: {polytope} is no d-cube"));
    }
    Ok(ncube_bound(d, piece, p))
}

/// The title of a d-cube container. packages/boundary/src/ncube/bounds.ts: NCUBE_TITLES
pub fn ncube_title(name: &str) -> Option<&'static str> {
    Some(match name {
        "5cube" => "5-cube",
        "6cube" => "6-cube",
        "7cube" => "7-cube",
        "8cube" => "8-cube",
        "9cube" => "9-cube",
        "10cube" => "10-cube",
        _ => return None,
    })
}

/// Estimated milliseconds of the server's check per piece ([CALC] BOUNDARY.md 4B, 2026-11-01, one
/// core, of the TypeScript): the cost of the pair stage per ball measured on the cell layouts was at
/// most 0.5 ms for the smallest P of d = 10 and 0.03 to 0.05 ms for the largest; the table is that
/// worst per-piece cost times 3 for crowded layouts and a cold engine. Cubes cost 0.02 ms each.
/// packages/boundary/src/ncube/bounds.ts: NCUBE_BALL_MS
pub fn ncube_ball_ms(name: &str) -> Option<f64> {
    Some(match name {
        "5cube" => 0.3,
        "6cube" => 0.35,
        "7cube" => 0.5,
        "8cube" => 0.6,
        "9cube" => 1.0,
        "10cube" => 1.5,
        _ => return None,
    })
}

/// packages/boundary/src/ncube/bounds.ts: ncubeCheckMs
pub fn ncube_check_ms(polytope: &str, piece: &str, p: f64) -> f64 {
    if piece == "cube" {
        0.02 * p
    } else {
        ncube_ball_ms(polytope).unwrap_or(f64::NAN) * p
    }
}
