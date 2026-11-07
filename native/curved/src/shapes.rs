//! Unit pieces and regular containers in the plane of constant curvature K
//! (packages/curved/src/shapes.ts).
//!
//! Right-triangle relations (centre angle pi/n, legs: apothem a and half side b, hypotenuse R):
//!   tn_K(b) = sn_K(a) tan(pi/n)        sn_K(b) = sn_K(R) sin(pi/n)        cos(pi/n) = cs_K(b) sin(alpha/2)
//! where alpha is the interior angle. For K = 0 these are the Euclidean formulas.

use crate::kfun::{asn_k, atn_k, cs_k, sn_k, tn_k, vs_k};
use std::f64::consts::PI;

/// Radius of a disk piece (N = 0): disks have diameter 1. Polygon pieces have side 1.
pub const DISK_RADIUS: f64 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PieceGeometry {
    pub n: u32,
    pub k: f64,
    /// circumradius (DISK_RADIUS for a disk piece)
    pub r: f64,
    pub sn_r: f64,
    pub cs_r: f64,
    /// inradius (apothem; DISK_RADIUS for a disk)
    pub rho: f64,
    pub sn_rho: f64,
    pub cs_rho: f64,
    /// interior angle in radians (NaN for a disk)
    pub alpha: f64,
    pub area: f64,
}

/// True when a unit piece of code N exists (and fits in an open hemisphere for K > 0).
/// On the sphere of radius 1/sqrt K a convex regular N-gon with circumradius R < pi/(2 sqrt K) has
/// sin(sqrt K a/2) = sin(sqrt K R) sin(pi/N), so its side a ranges over (0, 2 pi/(N sqrt K)): a unit
/// N-gon exists iff sqrt K < 2 pi/N (perimeter N below 2 pi/sqrt K).
pub fn piece_exists(n: u32, k: f64) -> bool {
    if n == 0 {
        return !(k > 0.0) || DISK_RADIUS < PI / (2.0 * k.sqrt());
    }
    if !(k > 0.0) {
        return true;
    }
    k.sqrt() * (n as f64) < 2.0 * PI && k.sqrt() * sn_k(k, 0.5) < libm::sin(PI / n as f64)
}

/// Area of a right triangle with legs a and b: tan(|K| A / 2) = |K| tn_K(a/2) tn_K(b/2).
fn right_triangle_area(k: f64, a: f64, b: f64) -> f64 {
    let p = tn_k(k, a / 2.0) * tn_k(k, b / 2.0);
    let z = k.abs() * p;
    if z < 1e-8 {
        return 2.0 * p * (1.0 - (z * z) / 3.0);
    }
    (2.0 * libm::atan(z)) / k.abs()
}

/// The unit piece of code N at curvature K, or None when it does not exist.
pub fn piece_geometry(n: u32, k: f64) -> Option<PieceGeometry> {
    if !piece_exists(n, k) {
        return None;
    }
    if n == 0 {
        return Some(PieceGeometry {
            n,
            k,
            r: DISK_RADIUS,
            sn_r: sn_k(k, DISK_RADIUS),
            cs_r: cs_k(k, DISK_RADIUS),
            rho: DISK_RADIUS,
            sn_rho: sn_k(k, DISK_RADIUS),
            cs_rho: cs_k(k, DISK_RADIUS),
            alpha: f64::NAN,
            area: 2.0 * PI * vs_k(k, DISK_RADIUS),
        });
    }
    let nf = n as f64;
    let sn_r = sn_k(k, 0.5) / libm::sin(PI / nf);
    let r = asn_k(k, sn_r);
    let sn_rho = tn_k(k, 0.5) / libm::tan(PI / nf);
    let rho = asn_k(k, sn_rho);
    let alpha = 2.0 * libm::asin(libm::cos(PI / nf) / cs_k(k, 0.5));
    Some(PieceGeometry {
        n,
        k,
        r,
        sn_r,
        cs_r: cs_k(k, r),
        rho,
        sn_rho,
        cs_rho: cs_k(k, rho),
        alpha,
        area: 2.0 * nf * right_triangle_area(k, rho, 0.5),
    })
}

/// Largest admissible container size: infinity except K > 0, where the container stays in an open hemisphere.
pub fn max_container_size(m: u32, k: f64) -> f64 {
    if !(k > 0.0) {
        return f64::INFINITY;
    }
    // a disk container is scored by its geodesic diameter: the open hemisphere has radius pi / (2 sqrt K)
    if m == 0 {
        PI / k.sqrt()
    } else {
        (2.0 * PI) / (m as f64 * k.sqrt())
    }
}

/// Apothem h of the ideal regular M-gon (K < 0): sn_K(h) = 1 / (sqrt(-K) tan(pi/M)). Infinity otherwise.
pub fn ideal_apothem(m: u32, k: f64) -> f64 {
    if !(k < 0.0) || m == 0 {
        return f64::INFINITY;
    }
    asn_k(k, 1.0 / ((-k).sqrt() * libm::tan(PI / m as f64)))
}

/// Upper limit of the container variable t (apothem, or radius for a disk): the hemisphere at
/// K > 0, the ideal M-gon at K < 0.
pub fn max_apothem(m: u32, k: f64) -> f64 {
    if k > 0.0 {
        return PI / (2.0 * k.sqrt());
    }
    if k < 0.0 && m > 0 {
        return ideal_apothem(m, k);
    }
    f64::INFINITY
}

/// Container variable t: the apothem h for polygon containers, the radius r = s / 2 for disk
/// containers (a disk container's size s is its diameter).
pub fn apothem_from_side(m: u32, k: f64, s: f64) -> f64 {
    if m == 0 {
        return s / 2.0;
    }
    asn_k(k, tn_k(k, s / 2.0) / libm::tan(PI / m as f64))
}

/// Inverse of apothem_from_side; infinity at or beyond the ideal apothem (K < 0).
pub fn side_from_apothem(m: u32, k: f64, h: f64) -> f64 {
    if m == 0 {
        return 2.0 * h;
    }
    2.0 * atn_k(k, sn_k(k, h) * libm::tan(PI / m as f64))
}

/// Circumradius of a regular M-gon container with side s (radius s / 2 of a disk container).
pub fn container_circumradius(m: u32, k: f64, s: f64) -> f64 {
    if m == 0 {
        return s / 2.0;
    }
    asn_k(k, sn_k(k, s / 2.0) / libm::sin(PI / m as f64))
}

/// Area of a regular M-gon of side s (or disk of diameter s for M = 0) at curvature K.
pub fn container_area(m: u32, k: f64, s: f64) -> f64 {
    if m == 0 {
        return 2.0 * PI * vs_k(k, s / 2.0);
    }
    let h = apothem_from_side(m, k, s);
    2.0 * m as f64 * right_triangle_area(k, h, s / 2.0)
}

/// Outward unit normal angle of container wall k (wall 0 is the bottom edge).
pub fn wall_angle(m: u32, k: u32) -> f64 {
    -PI / 2.0 + (2.0 * PI * k as f64) / m as f64
}

/// Outward normal angle of edge e of the standard piece (vertex 0 straight up).
pub fn piece_edge_angle(n: u32, e: u32) -> f64 {
    PI / 2.0 + PI / n as f64 + (2.0 * PI * e as f64) / n as f64
}

/// Direction of vertex k of the standard piece.
pub fn piece_vertex_angle(n: u32, k: u32) -> f64 {
    PI / 2.0 + (2.0 * PI * k as f64) / n as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn euclidean_pieces() {
        let sq = piece_geometry(4, 0.0).unwrap();
        assert!((sq.r - 0.5f64.sqrt()).abs() < 1e-15);
        assert!((sq.rho - 0.5).abs() < 1e-15);
        assert!((sq.area - 1.0).abs() < 1e-15);
        let tri = piece_geometry(3, 0.0).unwrap();
        assert!((tri.area - 3f64.sqrt() / 4.0).abs() < 1e-15);
    }

    #[test]
    fn existence_at_positive_curvature() {
        assert!(piece_exists(6, 1.0));
        assert!(!piece_exists(7, 1.0));
        assert!(!piece_exists(3, 20.0));
    }

    #[test]
    fn side_and_apothem_round_trip() {
        for &k in &[-1.0, -0.1, 0.0, 0.1, 1.0] {
            for &m in &[0u32, 3, 4, 6, 8] {
                let s = 0.7;
                let h = apothem_from_side(m, k, s);
                assert!((side_from_apothem(m, k, h) - s).abs() < 1e-13, "K={k} M={m}");
            }
        }
    }
}
