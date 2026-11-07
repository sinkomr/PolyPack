//! Lower bounds of curved problems and which problems can exist (packages/curved/src/bound.ts).

use crate::shapes::{
    container_area, max_apothem, max_container_size, piece_exists, piece_geometry, side_from_apothem, PieceGeometry,
};

/// The largest P of the site's curved catalogue (and of the server's check).
pub const CURVED_MAX_P: u32 = 500;

/// True when P pieces of this piece can lie in a container of this kind: some size below the
/// admissible limit works.
pub fn curved_fits(k: f64, m: u32, t_max: f64, piece: &PieceGeometry, p: u32) -> bool {
    // one piece: a polygon container holds its inscribed disk (inradius >= rho), a disk container its
    // vertices (r >= R); two pieces in a disk container: r >= 2 rho
    let mut b = side_from_apothem(m, k, if m == 0 { piece.r } else { piece.rho });
    if m == 0 && p >= 2 {
        b = b.max(side_from_apothem(m, k, 2.0 * piece.rho));
    }
    if !b.is_finite() || !(b < max_container_size(m, k)) {
        return false;
    }
    // area: the container at the limit (t_max less 1e-12 relative) must be larger than P pieces by
    // a margin of 1e-11, so that rounding cannot decide a tie
    if t_max.is_finite()
        && container_area(m, k, side_from_apothem(m, k, t_max * (1.0 - 1e-12))) < p as f64 * piece.area * (1.0 + 1e-11)
    {
        return false;
    }
    true
}

fn valid_code(n: u32) -> bool {
    n == 0 || (3..=100).contains(&n)
}

/// The largest P <= limit for which the problem can exist (0 when the unit piece does not exist at
/// K or no container below the admissible limit holds one).
pub fn curved_max_p(k: f64, n: u32, m: u32, limit: u32) -> u32 {
    if !k.is_finite() || !valid_code(n) || !valid_code(m) || limit < 1 || !piece_exists(n, k) {
        return 0;
    }
    let piece = match piece_geometry(n, k) {
        Some(p) => p,
        None => return 0,
    };
    let t_max = max_apothem(m, k);
    if !curved_fits(k, m, t_max, &piece, 1) {
        return 0;
    }
    if m == 0 && limit >= 2 && !curved_fits(k, m, t_max, &piece, 2) {
        return 1;
    }
    let mut p = limit as f64;
    if t_max.is_finite() {
        let cap = container_area(m, k, side_from_apothem(m, k, t_max * (1.0 - 1e-12)));
        p = p.min((cap / piece.area).floor() + 1.0);
    }
    let mut p = p as u32;
    while p > 1 && !curved_fits(k, m, t_max, &piece, p) {
        p -= 1;
    }
    p
}

/// Container variable whose container has area A (bisection), capped below t_max (infinity when
/// even the limit is too small).
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

/// A lower bound on the score, deflated by 1e-12 relative against rounding, or None when no
/// container below the admissible limit holds the pieces: the area bound, one-piece containment,
/// and (disk containers, P >= 2) two disjoint inscribed disks.
pub fn curved_bound(k: f64, n: u32, m: u32, p: u32) -> Option<f64> {
    if !piece_exists(n, k) {
        return None;
    }
    let piece = piece_geometry(n, k)?;
    let t_max = max_apothem(m, k);
    if !curved_fits(k, m, t_max, &piece, p) {
        return None;
    }
    let size_of_t = |t: f64| side_from_apothem(m, k, t);
    let mut b = size_of_t(t_for_area(k, m, t_max, p as f64 * piece.area));
    b = b.max(size_of_t(if m == 0 { piece.r } else { piece.rho }));
    if m == 0 && p >= 2 {
        b = b.max(size_of_t(2.0 * piece.rho));
    }
    if b.is_finite() {
        Some(b * (1.0 - 1e-12))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn largest_p_as_the_reference() {
        // the values of the reference's curvedMaxP
        assert_eq!(curved_max_p(1.0, 5, 5, 500), 2);
        assert_eq!(curved_max_p(1.0, 6, 0, 500), 1);
        assert_eq!(curved_max_p(1.0, 3, 3, 500), 12);
        assert_eq!(curved_max_p(1.0, 7, 3, 500), 0);
        assert_eq!(curved_max_p(-1.0, 3, 6, 500), 32);
        assert_eq!(curved_max_p(0.0001, 0, 0, 500), 500);
        assert_eq!(curved_max_p(-0.1, 4, 4, 500), 63);
    }

    #[test]
    fn euclidean_area_bound() {
        // 4 unit squares in a square: the area bound is 2
        let b = curved_bound(0.0, 4, 4, 4).unwrap();
        assert!((b - 2.0).abs() < 1e-9);
    }
}
