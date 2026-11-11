//! The light part of the package (packages/curved/src/bound.ts, the subpath `@polypack/curved/bound`):
//! the lower bound of a curved problem and which problems can exist, as scalars. No `Space` is made.
//! `curved_fits` is the one test of `curved_bound`: a bound is None exactly when it fails.
//!
//! The site's domain (packages/spaces/src/piece-domains.ts) calls `curved_max_p` with the numbers
//! of a query string, which can be anything (`Number("abc")` is NaN), so that function and
//! `curved_why_not` take K, N, M and P as JavaScript numbers (f64) and test them as the source
//! does. The functions that are only reached with shape codes of an id take them as integers.

use crate::shapes::{
    container_area, max_apothem, max_container_size, piece_exists, piece_geometry, side_from_apothem, PieceGeometry,
};
use polypack_js::{fmt as jsfmt, math};
use std::f64::consts::PI;

/// The largest P of the site's curved catalogue (MAX_PIECES of packages/geometry)
/// (packages/curved/src/bound.ts: CURVED_MAX_P).
pub const CURVED_MAX_P: u32 = 500;

/// True when P pieces of this piece can lie in a container of this kind: some size below the
/// admissible limit works (packages/curved/src/bound.ts: curvedFits).
pub fn curved_fits(k: f64, m: u32, t_max: f64, piece: &PieceGeometry, p: f64) -> bool {
    // one piece: a polygon container holds its inscribed disk (inradius >= rho), a disk container its
    // vertices (r >= R); two pieces in a disk container: r >= 2 rho
    let mut b = side_from_apothem(m, k, if m == 0 { piece.r } else { piece.rho });
    if m == 0 && p >= 2.0 {
        b = math::max(b, side_from_apothem(m, k, 2.0 * piece.rho));
    }
    if !b.is_finite() || !(b < max_container_size(m, k)) {
        return false;
    }
    // area: the container at the limit (t_max, less 1e-12 relative) must be larger than P pieces by a
    // margin of 1e-11, so that rounding cannot decide a tie (ten triangles fill the open hemisphere at
    // K = 1.2257..., exactly); without a limit it always is
    if t_max.is_finite()
        && container_area(m, k, side_from_apothem(m, k, t_max * (1.0 - 1e-12))) < p * piece.area * (1.0 + 1e-11)
    {
        return false;
    }
    true
}

/// packages/curved/src/bound.ts: validCode, for a JavaScript number (in the source's form).
#[allow(clippy::manual_range_contains)]
fn valid_code(n: f64) -> bool {
    n == 0.0 || (n.is_finite() && n.fract() == 0.0 && n >= 3.0 && n <= 100.0)
}

/// The largest P <= limit with a curved_bound that is not None, 0 when the unit piece does not
/// exist at K or no container below the admissible limit holds one. The problems that can exist are
/// P = 1 up to this [CALC] (packages/curved/src/bound.ts: curvedMaxP; its default limit is CURVED_MAX_P).
///
/// K, N, M and the limit are JavaScript numbers; so is the result, which is a whole number for
/// every limit that is one (the source can return NaN when the area at the limit is NaN, and
/// Infinity for an infinite limit where no area bounds P).
///
/// As in the source, the walk down from the area's estimate never ends when the limit and the
/// estimate are both above 2^53, where P - 1 is P: `curvedMaxP(1e-300, 0, 0, Infinity)` does not
/// return [CALC]. The server's limits are 1, 500 and an id's P (at most 9999), so it never asks that.
pub fn curved_max_p(k: f64, n: f64, m: f64, limit: f64) -> f64 {
    if !k.is_finite() || !valid_code(n) || !valid_code(m) || !(limit >= 1.0) || !piece_exists(n as u32, k) {
        return 0.0;
    }
    let (n, m) = (n as u32, m as u32);
    // (the source keeps the last piece asked for, as a count walks M for one N and K: the same values)
    let Some(piece) = piece_geometry(n, k) else { return 0.0 };
    let t_max = max_apothem(m, k);
    if !curved_fits(k, m, t_max, &piece, 1.0) {
        return 0.0;
    }
    // a disk container that cannot hold two disks (or two pieces) holds one
    if m == 0 && limit >= 2.0 && !curved_fits(k, m, t_max, &piece, 2.0) {
        return 1.0;
    }
    let mut p = math::floor(limit);
    if t_max.is_finite() {
        let cap = container_area(m, k, side_from_apothem(m, k, t_max * (1.0 - 1e-12)));
        p = math::min(p, math::floor(cap / piece.area) + 1.0);
    }
    // fits is monotone in P from 2 on, and the estimate is off by rounding only
    while p > 1.0 && !curved_fits(k, m, t_max, &piece, p) {
        p -= 1.0;
    }
    p
}

/// packages/curved/src/bound.ts: kText, `String(Number(K.toPrecision(6)))`.
fn k_text(k: f64) -> String {
    // toPrecision writes digits with an optional exponent ("1.22578", "1.00000e-7"), which Rust reads as Number() does
    jsfmt::num(jsfmt::precision(k, 6).parse::<f64>().unwrap_or(f64::NAN))
}

/// Why a problem cannot exist, in a plain sentence, or None when it can (curved_max_p(K, N, M) >= P).
/// The board shows it for a link to such an id, instead of a search that ends with an error
/// (packages/curved/src/bound.ts: curvedWhyNot).
pub fn curved_why_not(k: f64, n: f64, m: f64, p: f64) -> Option<String> {
    if !k.is_finite() || !valid_code(n) || !valid_code(m) {
        return None;
    }
    let piece = if n == 0.0 {
        "disk".to_string()
    } else {
        format!("{}-gon", jsfmt::num(n))
    };
    let at = format!("at K = {}", k_text(k));
    if !piece_exists(n as u32, k) {
        if n > 0.0 && math::sqrt(k) * n >= 2.0 * PI {
            return Some(format!(
                "No unit {piece} exists {at}: its perimeter, {}, is longer than a great circle, 2π/√K ≈ {}.",
                jsfmt::num(n),
                jsfmt::precision((2.0 * PI) / math::sqrt(k), 4)
            ));
        }
        return Some(if n == 0.0 {
            format!("No unit disk exists {at}: it does not fit in a hemisphere.")
        } else {
            format!("No unit {piece} exists {at}: its sides are too long for the sphere.")
        });
    }
    let max = curved_max_p(k, n, m, math::max(p, 1.0));
    if max >= p {
        return None;
    }
    let container = if m == 0.0 {
        "disk container".to_string()
    } else {
        format!("{}-gon container", jsfmt::num(m))
    };
    let limit = if k > 0.0 {
        "a container stays inside an open hemisphere"
    } else {
        "a polygon container cannot grow past the ideal polygon"
    };
    if max == 0.0 {
        return Some(format!(
            "A {container} {at} cannot hold even one unit {piece}: {limit}."
        ));
    }
    if m == 0.0 && max == 1.0 {
        return Some(format!("A {container} {at} cannot hold two unit {piece}s: {limit}."));
    }
    Some(format!(
        "A {container} {at} holds at most {} unit {piece}{}: {limit}, and {} pieces need more area than it has.",
        jsfmt::num(max),
        if max == 1.0 { "" } else { "s" },
        jsfmt::num(p)
    ))
}

/// Container variable whose container has area A (bisection), capped below t_max: Infinity when
/// even the limit is too small (packages/curved/src/bound.ts: tForArea; its `space` is K, M and tMax).
pub fn t_for_area(k: f64, m: u32, t_max: f64, a: f64) -> f64 {
    let mut lo = 0.0;
    let mut hi = if t_max.is_finite() { t_max } else { 1.0 };
    let area_of_t = |t: f64| container_area(m, k, side_from_apothem(m, k, t));
    if !t_max.is_finite() {
        while area_of_t(hi) < a && hi < 1e6 {
            hi *= 2.0;
        }
    } else if area_of_t(hi * (1.0 - 1e-12)) < a {
        return f64::INFINITY;
    }
    for _ in 0..200 {
        let mid = (lo + hi) / 2.0;
        if area_of_t(mid) < a {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    hi
}

/// A lower bound on the score [CALC], deflated by 1e-12 relative against rounding, or None when
/// none is finite inside the admissible range (an infeasible problem):
///  - area: P disjoint pieces of area A lie in the container, so its area is at least P A;
///  - one piece: a polygon container contains the piece's inscribed disk, so its inradius is at
///    least rho; a disk container contains the piece's vertices, so r >= R;
///  - two pieces in a disk: two disjoint inscribed disks have centres within r - rho of O and at
///    least 2 rho apart, so r >= 2 rho.
///
/// These are the bounds of the research records (data/curved/records.json, `bound.kind`)
/// (packages/curved/src/bound.ts: curvedBound; its `space` is K, M, the piece and tMax).
pub fn curved_bound(k: f64, m: u32, piece: &PieceGeometry, t_max: f64, p: f64) -> Option<f64> {
    if !curved_fits(k, m, t_max, piece, p) {
        return None;
    }
    // (a disk container's size is its diameter 2 t)
    let size_of_t = |t: f64| side_from_apothem(m, k, t);
    let mut b = size_of_t(t_for_area(k, m, t_max, p * piece.area));
    b = math::max(b, size_of_t(if m == 0 { piece.r } else { piece.rho }));
    if m == 0 && p >= 2.0 {
        b = math::max(b, size_of_t(2.0 * piece.rho));
    }
    if b.is_finite() {
        Some(b * (1.0 - 1e-12))
    } else {
        None
    }
}

/// curved_bound of the problem (K, N, M, P) without a Space: None when the piece does not exist
/// either (packages/curved/src/bound.ts: curvedBoundOf). N and M are shape codes (0, or 3 to 100).
pub fn curved_bound_of(k: f64, n: u32, m: u32, p: u32) -> Option<f64> {
    if !piece_exists(n, k) {
        return None;
    }
    let piece = piece_geometry(n, k)?;
    curved_bound(k, m, &piece, max_apothem(m, k), p as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn max_p(k: f64, n: u32, m: u32) -> f64 {
        curved_max_p(k, n as f64, m as f64, CURVED_MAX_P as f64)
    }

    #[test]
    fn largest_p_as_the_reference() {
        // the values of the reference's curvedMaxP
        assert_eq!(max_p(1.0, 5, 5), 2.0);
        assert_eq!(max_p(1.0, 6, 0), 1.0);
        assert_eq!(max_p(1.0, 3, 3), 12.0);
        assert_eq!(max_p(1.0, 7, 3), 0.0);
        assert_eq!(max_p(-1.0, 3, 6), 32.0);
        assert_eq!(max_p(0.0001, 0, 0), 500.0);
        assert_eq!(max_p(-0.1, 4, 4), 63.0);
    }

    #[test]
    fn numbers_that_are_not_shape_codes() {
        for bad in [f64::NAN, 1.0, 2.0, 3.5, 101.0, -3.0, f64::INFINITY] {
            assert_eq!(curved_max_p(-1.0, bad, 4.0, 500.0), 0.0);
            assert_eq!(curved_max_p(-1.0, 4.0, bad, 500.0), 0.0);
            assert_eq!(curved_why_not(-1.0, bad, 4.0, 3.0), None);
        }
        assert_eq!(curved_max_p(f64::NAN, 4.0, 4.0, 500.0), 0.0);
        assert_eq!(curved_max_p(-1.0, 4.0, 4.0, 0.5), 0.0);
        assert_eq!(curved_max_p(-1.0, 4.0, 4.0, f64::NAN), 0.0);
        // a limit that is not whole is floored; without an area limit an infinite one stays infinite
        assert_eq!(curved_max_p(0.0, 4.0, 4.0, 7.9), 7.0);
        assert_eq!(curved_max_p(0.0, 4.0, 4.0, f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn euclidean_area_bound() {
        // 4 unit squares in a square: the area bound is 2
        let b = curved_bound_of(0.0, 4, 4, 4).unwrap();
        assert!((b - 2.0).abs() < 1e-9);
    }
}
