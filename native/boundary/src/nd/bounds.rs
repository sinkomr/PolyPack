//! Lower bounds, volumes and costs of the simplex, orthoplex and demicube problems
//! (docs/spaces/BOUNDARY.md section 4D.5). Port of packages/boundary/src/nd/bounds.ts (the
//! functions the server reaches).
//!
//! Both bounds are proved and stored as the largest binary64 value not above the exact one, decided
//! in integer arithmetic (as the d-cubes' ncube_bound): the larger of
//!  - the volume bound P V_n 2^-n <= s^n vol_1: the developed balls have disjoint interiors, each is
//!    a Euclidean ball of radius 1/2 (its centre is 1/2 from the hinges, so the ball is the flat
//!    image of the Euclidean one), and the developments are injective on interiors, so their
//!    volumes add up to at most the boundary's; vol_1 is the boundary's n-volume at unit edge,
//!    n = d - 1 (formulas below);
//!  - the one-ball bound s >= 1 / (2 rho): a centre needs geodesic distance >= 1/2 from the hinges,
//!    hence from the hinges of its own cell, and every point of a cell lies within rho of a hinge of
//!    the cell, rho = the largest distance from the cell's centre O to a hinge of the cell (4A.4).
//!      simplex, orthoplex: cells are regular n-simplices of edge s, hinge distance
//!      s / sqrt(n^2 - 1) = s / sqrt(d (d - 2)): s >= sqrt(d (d-2)) / 2;
//!      demicube: the cells are regular n-simplices (rho^2 = 1/(n^2 - 1)) and n-demicubes of edge s,
//!      whose hinges between a demicube facet and a simplex facet are at squared distance
//!      (n^2 - 5 n + 8) / (8 (n - 1)) s^2 from the centre (and 1/4 s^2 between two demicube facets,
//!      n >= 5; not larger), so s^2 >= 2 (n - 1) / (n^2 - 5 n + 8).
//!
//! Volumes at unit edge, n = d - 1: a regular n-simplex sqrt(n+1) / (n! 2^(n/2)); an n-demicube
//! 2^(-n/2) (1 - 2^(n-1)/n!) (the n-cube of edge 1/sqrt 2 less 2^(n-1) corner simplices, each of
//! volume (1/sqrt 2)^n / n!). The simplex's boundary has d + 1 simplices, the orthoplex's 2^d, the
//! demicube's 2^(d-1) simplices and 2d demicubes.

use super::names::{nd_parse, NdFamily};
use crate::exact::{ball_volume, compare, largest_float, pi_60, ten60};
use num_bigint::BigUint;
use polypack_js::math;

fn factorial(n: usize) -> BigUint {
    let mut f = BigUint::from(1u32);
    for i in 2..=n {
        f *= BigUint::from(i as u64);
    }
    f
}

/// `Number(x)` of a BigInt small enough to be exact.
fn to_number(x: &BigUint) -> f64 {
    let d = x.to_u64_digits();
    match d.len() {
        0 => 0.0,
        1 => d[0] as f64,
        _ => f64::NAN,
    }
}

/// floor(sqrt(x)) of a non-negative BigInt (Newton's iteration).
/// packages/boundary/src/nd/bounds.ts: isqrt
fn isqrt(x: &BigUint) -> BigUint {
    if *x < BigUint::from(2u32) {
        return x.clone();
    }
    let mut r = BigUint::from(1u32) << ((x.bits() + 1) >> 1);
    loop {
        let y: BigUint = (&r + x / &r) >> 1u32;
        if y >= r {
            return r;
        }
        r = y;
    }
}

/// The volume of the unit n-ball (floats).
/// packages/boundary/src/nd/bounds.ts: ndUnitBallVolume
pub fn nd_unit_ball_volume(n: usize) -> f64 {
    let (vn, vd, vk) = ball_volume(n).expect("n = 4..9");
    (vn as f64 / vd as f64) * math::pow(math::PI, vk as f64)
}

/// The volume of a ball of radius 1/2 in n dimensions.
/// packages/boundary/src/nd/bounds.ts: ndBallVolume
pub fn nd_ball_volume(n: usize) -> f64 {
    nd_unit_ball_volume(n) / math::pow(2.0, n as f64)
}

/// The n-volume of the boundary of the container at unit edge (floats), n = d - 1.
/// packages/boundary/src/nd/bounds.ts: ndBoundaryVolume
pub fn nd_boundary_volume(family: NdFamily, d: usize) -> f64 {
    let n = d - 1;
    let nf = to_number(&factorial(n));
    let simplex = ((n + 1) as f64).sqrt() / (nf * math::pow(2.0, n as f64 / 2.0));
    if family == NdFamily::Simplex {
        return (d + 1) as f64 * simplex;
    }
    if family == NdFamily::Orthoplex {
        return math::pow(2.0, d as f64) * simplex;
    }
    let demi = (1.0 - math::pow(2.0, (n - 1) as f64) / nf) / math::pow(2.0, n as f64 / 2.0);
    (2 * d) as f64 * demi + math::pow(2.0, (d - 1) as f64) * simplex
}

/// The volume bound as a rational Q with s^(2n) >= Q (so s >= Q^(1/2n)), pi and sqrt d rounded the safe way.
/// packages/boundary/src/nd/bounds.ts: volumeQ
fn volume_q(family: NdFamily, d: usize, p: f64) -> (BigUint, BigUint) {
    let n = d - 1;
    let (vn, vd, vk) = ball_volume(n).expect("n = 4..9");
    let nf = factorial(n);
    let two = BigUint::from(2u32);
    // B = P (num/den) pi^k n!  with pi rounded down:  Bn / Bd
    let bn = BigUint::from(p as u64) * BigUint::from(vn) * pi_60().pow(vk) * &nf;
    let bd = BigUint::from(vd) * ten60().pow(vk);
    if family == NdFamily::Simplex || family == NdFamily::Orthoplex {
        // s^n >= B / (2^(n/2) (d+1) sqrt d)         (simplex)
        // s^n >= B / (2^(n/2) 2^d sqrt d)           (orthoplex)
        // squared:  s^(2n) >= B^2 / (2^n c^2 d),  c = d + 1 or 2^d
        let c = if family == NdFamily::Simplex { BigUint::from(d as u64 + 1) } else { two.pow(d as u32) };
        return (&bn * &bn, &bd * &bd * two.pow(n as u32) * &c * &c * BigUint::from(d as u64));
    }
    // demicube: s^n >= B / (2^(n/2) (alpha + beta sqrt d)),  alpha = 2d (n! - 2^(n-1)), beta = 2^(d-1); sqrt d rounded up
    let alpha = BigUint::from(2 * d as u64) * (&nf - two.pow(n as u32 - 1));
    let beta = two.pow(d as u32 - 1);
    let sqrt_up = isqrt(&(BigUint::from(d as u64) * ten60() * ten60())) + BigUint::from(1u32); // sqrt(d) <= sqrtUp / 10^60
    let denom = alpha * ten60() + beta * sqrt_up; // (alpha + beta sqrt d) 10^60, rounded up
    (&bn * &bn * ten60() * ten60(), &bd * &bd * two.pow(n as u32) * &denom * &denom)
}

/// The one-ball bound as a rational Q with s^2 >= Q.
/// packages/boundary/src/nd/bounds.ts: oneBallQ
fn one_ball_q(family: NdFamily, d: usize) -> (BigUint, BigUint) {
    if family == NdFamily::Simplex || family == NdFamily::Orthoplex {
        return (BigUint::from((d * (d - 2)) as u64), BigUint::from(4u32));
    }
    let n = d - 1;
    // n^2 - 5 n + 8, added in an order that stays non-negative in unsigned integers (n = 4: 16 - 20 + 8)
    (BigUint::from((2 * (n - 1)) as u64), BigUint::from((n * n + 8 - 5 * n) as u64))
}

/// The exact lower bound on s of P balls on the boundary of the container, as the largest binary64 not above it.
/// packages/boundary/src/nd/bounds.ts: ndBound
pub fn nd_bound(family: NdFamily, d: usize, p: f64) -> f64 {
    let n = d - 1;
    let one = one_ball_q(family, d);
    let one_b = largest_float(|x| compare(x, 2, &one.0, &one.1) <= 0, (to_number(&one.0) / to_number(&one.1)).sqrt());
    let q = volume_q(family, d, p);
    let approx = math::pow((p * nd_ball_volume(n)) / nd_boundary_volume(family, d), 1.0 / n as f64);
    let vol_b = largest_float(|x| compare(x, 2 * n as u32, &q.0, &q.1) <= 0, approx);
    math::max(one_b, vol_b)
}

/// Which of the two bounds is the larger (for the listing's label): "volume" or "one ball".
/// packages/boundary/src/nd/bounds.ts: ndBoundKind
pub fn nd_bound_kind(family: NdFamily, d: usize, p: f64) -> &'static str {
    let n = d - 1;
    let one = one_ball_q(family, d);
    let one_b = (to_number(&one.0) / to_number(&one.1)).sqrt();
    let vol_b = math::pow((p * nd_ball_volume(n)) / nd_boundary_volume(family, d), 1.0 / n as f64);
    if vol_b > one_b {
        "volume"
    } else {
        "one ball"
    }
}

/// The bound of a problem by its container name.
/// packages/boundary/src/nd/bounds.ts: ndProblemBound
pub fn nd_problem_bound(polytope: &str, p: f64) -> Result<f64, String> {
    let (family, d) = nd_parse(polytope).ok_or_else(|| format!("ndProblemBound: {polytope} is none of the simplex, orthoplex or demicube containers"))?;
    Ok(nd_bound(family, d, p))
}

/// Estimated milliseconds of the server's check per ball ([CALC] BOUNDARY.md 4D.8, 2026-11-02, one
/// core, Apple Silicon, of the TypeScript): three times the largest cost per ball measured on the
/// test packings, rounded up. A check of 50 ms or more waits in the server's heavy queue
/// (BOUNDARY_HEAVY_MS): the 6-demicube from P = 3, the 7-demicube from P = 2, the 8-demicube always
/// and the 10-demicube from P = 10; the work of every check is also capped (ND_MAX_WORK steps), so
/// a crowded layout is refused, not slow.
/// packages/boundary/src/nd/bounds.ts: ND_BALL_MS
pub fn nd_ball_ms(name: &str) -> Option<f64> {
    Some(match name {
        "5simplex" | "6simplex" | "7simplex" | "8simplex" | "9simplex" | "10simplex" => 0.3,
        "5orthoplex" | "6orthoplex" | "7orthoplex" | "8orthoplex" | "9orthoplex" | "10orthoplex" => 0.3,
        "5demicube" => 0.3,
        "6demicube" => 17.0,
        "7demicube" => 30.0,
        "8demicube" => 125.0,
        "9demicube" => 2.0,
        "10demicube" => 5.0,
        _ => return None,
    })
}

/// packages/boundary/src/nd/bounds.ts: ndCheckMs
pub fn nd_check_ms(polytope: &str, p: f64) -> f64 {
    nd_ball_ms(polytope).unwrap_or(f64::NAN) * p
}
