//! Lattices of flat tori R^2 / Lambda, Lambda = Z b1 + Z b2. Source: packages/torus/src/lattice.ts.
//!
//! Families (docs/spaces/TORUS.md):
//!   sq    b1 = L (1, 0), b2 = L (0, 1)              score L
//!   hex   b1 = L (1, 0), b2 = L (1/2, sqrt(3)/2)    score L
//!   free  any basis                                  score sqrt(|det(b1, b2)|)

use polypack_js::math;
use serde::{Deserialize, Serialize};

/// lattice.ts: `TorusFamily`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TorusFamily {
    Sq,
    Hex,
    Free,
}

impl TorusFamily {
    /// The family as ids write it: "sq", "hex" or "free".
    pub fn as_str(self) -> &'static str {
        match self {
            TorusFamily::Sq => "sq",
            TorusFamily::Hex => "hex",
            TorusFamily::Free => "free",
        }
    }

    /// The family of a name, if it is one.
    pub fn parse(s: &str) -> Option<TorusFamily> {
        TORUS_FAMILIES.iter().copied().find(|f| f.as_str() == s)
    }
}

/// lattice.ts: `TORUS_FAMILIES`.
pub const TORUS_FAMILIES: [TorusFamily; 3] = [TorusFamily::Sq, TorusFamily::Hex, TorusFamily::Free];

/// lattice.ts: `TORUS_MAX_P`. Largest P of a torus problem (the domain, the server and the search).
pub const TORUS_MAX_P: usize = 500;

/// lattice.ts: `TORUS_DISK_RADIUS`. Radius of a disk piece (N = 0) in site units: disks have
/// diameter 1. The same number as DISK_RADIUS of packages/geometry.
pub const TORUS_DISK_RADIUS: f64 = 0.5;

/// lattice.ts: `Vec2`.
pub type Vec2 = [f64; 2];

/// lattice.ts: `Lattice`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lattice {
    pub b1: Vec2,
    pub b2: Vec2,
}

/// lattice.ts: `det`.
#[inline]
pub fn det(l: &Lattice) -> f64 {
    l.b1[0] * l.b2[1] - l.b1[1] * l.b2[0]
}

/// lattice.ts: `cellArea`.
#[inline]
pub fn cell_area(l: &Lattice) -> f64 {
    math::abs(det(l))
}

/// lattice.ts: `torusScore`. Score of a torus: side L for sq/hex (|b1|), sqrt(cell area) for free.
pub fn torus_score(family: TorusFamily, l: &Lattice) -> f64 {
    if family == TorusFamily::Free {
        math::sqrt(cell_area(l))
    } else {
        math::hypot(l.b1[0], l.b1[1])
    }
}

/// The result of `gauss_reduce`: the reduced basis and the integer change of basis
/// (lattice.ts: `Unimodular`): reduced = basis * M, M = [[m11, m12], [m21, m22]] (columns).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reduced {
    pub lattice: Lattice,
    pub m: [[f64; 2]; 2],
}

/// lattice.ts: `gaussReduce`. Lagrange-Gauss reduction: returns a basis of the same lattice with
/// |b1| <= |b2| and |b1 . b2| <= |b1|^2 / 2 (so the angle between them is in [60, 120] degrees and
/// b1 is a shortest nonzero vector).
pub fn gauss_reduce(l: &Lattice) -> Reduced {
    let mut u: Vec2 = [l.b1[0], l.b1[1]];
    let mut v: Vec2 = [l.b2[0], l.b2[1]];
    // columns of M express u and v in the original basis
    let mut mu: Vec2 = [1.0, 0.0];
    let mut mv: Vec2 = [0.0, 1.0];
    let n2 = |a: &Vec2| a[0] * a[0] + a[1] * a[1];
    if n2(&v) < n2(&u) {
        std::mem::swap(&mut u, &mut v);
        std::mem::swap(&mut mu, &mut mv);
    }
    for _iter in 0..10000 {
        let k = math::round((u[0] * v[0] + u[1] * v[1]) / n2(&u));
        if k == 0.0 {
            break;
        }
        v = [v[0] - k * u[0], v[1] - k * u[1]];
        mv = [mv[0] - k * mu[0], mv[1] - k * mu[1]];
        if n2(&v) >= n2(&u) {
            break;
        }
        std::mem::swap(&mut u, &mut v);
        std::mem::swap(&mut mu, &mut mv);
    }
    Reduced {
        lattice: Lattice { b1: u, b2: v },
        m: [[mu[0], mv[0]], [mu[1], mv[1]]],
    }
}

/// lattice.ts: `latticeCoordinates`. Coordinates (alpha, beta) of a vector w in the basis:
/// w = alpha b1 + beta b2.
pub fn lattice_coordinates(l: &Lattice, w: &Vec2) -> [f64; 2] {
    let d = det(l);
    [
        (w[0] * l.b2[1] - w[1] * l.b2[0]) / d,
        (l.b1[0] * w[1] - l.b1[1] * w[0]) / d,
    ]
}

/// lattice.ts: `imageWindow`, as (X1, X2). Enumeration window (docs/spaces/TORUS.md, "Which
/// lattice vectors matter"). If v = alpha b1 + beta b2 then, by Cramer's rule,
/// |alpha| = |v x b2| / |det| <= |v| |b2| / |det| and |beta| = |b1 x v| / |det| <= |v| |b1| / |det|.
/// Every v with |v| < reach therefore has |alpha| < X1 = reach |b2| / |det| and
/// |beta| < X2 = reach |b1| / |det|. The bound holds for any basis; a reduced basis only keeps the
/// window small.
pub fn image_window(l: &Lattice, reach: f64) -> (f64, f64) {
    let a = cell_area(l);
    (
        (reach * math::hypot(l.b2[0], l.b2[1])) / a,
        (reach * math::hypot(l.b1[0], l.b1[1])) / a,
    )
}

/// lattice.ts: `Image`. A lattice translate v = d + m b1 + n b2. `m` and `n` are whole numbers kept
/// as doubles, as the source has them (they are the loop variables of `lattice_images`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Image {
    pub m: f64,
    pub n: f64,
    /// d + m b1 + n b2
    pub v: Vec2,
}

/// lattice.ts: `MAX_IMAGE_CANDIDATES`. Hard cap on enumerated candidates; a nearly degenerate basis
/// is an error instead of a hang.
pub const MAX_IMAGE_CANDIDATES: f64 = 1_000_000.0;

/// lattice.ts: the result of `imageRanges`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImageRanges {
    pub m_lo: f64,
    pub m_hi: f64,
    pub n_lo: f64,
    pub n_hi: f64,
}

/// lattice.ts: `imageRanges`. The integer ranges of m and n that `lattice_images` loops over for a
/// displacement d (one extra on each side). The source throws; here the message is the `Err`.
pub fn image_ranges(l: &Lattice, d: &Vec2, reach: f64) -> Result<ImageRanges, String> {
    let (x1, x2) = image_window(l, reach);
    let [a0, b0] = lattice_coordinates(l, d);
    if !x1.is_finite() || !x2.is_finite() || !a0.is_finite() || !b0.is_finite() {
        return Err("degenerate lattice or non-finite displacement".to_string());
    }
    Ok(ImageRanges {
        m_lo: math::floor(-a0 - x1) - 1.0,
        m_hi: math::ceil(-a0 + x1) + 1.0,
        n_lo: math::floor(-b0 - x2) - 1.0,
        n_hi: math::ceil(-b0 + x2) + 1.0,
    })
}

/// lattice.ts: `maxImageCandidates`. The most candidates `lattice_images` loops over for any
/// displacement: per axis ceil(x + X) - floor(x - X) + 3 is at most ceil(2 X) + 4, so
/// (ceil(2 X1) + 4)(ceil(2 X2) + 4). This is what the server's limit counts.
pub fn max_image_candidates(l: &Lattice, reach: f64) -> f64 {
    let (x1, x2) = image_window(l, reach);
    (math::ceil(2.0 * x1) + 4.0) * (math::ceil(2.0 * x2) + 4.0)
}

/// lattice.ts: `latticeImages`. All lattice translates v = d + m b1 + n b2 with |v| < reach, by the
/// Cramer window above (one extra integer on each side of the window guards against rounding).
/// With `half_plane`, only (m, n) with m > 0 or (m = 0 and n > 0) are returned: for a piece and its
/// own images, lambda and -lambda describe the same pair.
///
/// The loops count in doubles, as the source's do. A displacement beyond 2^53 lattice vectors
/// (which the server's limits on coordinates and on the basis exclude) makes `m + 1 == m`, and the
/// loop then does not end, in the source and here.
pub fn lattice_images(l: &Lattice, d: &Vec2, reach: f64, half_plane: bool) -> Result<Vec<Image>, String> {
    let ImageRanges { m_lo, m_hi, n_lo, n_hi } = image_ranges(l, d, reach)?;
    if (m_hi - m_lo + 1.0) * (n_hi - n_lo + 1.0) > MAX_IMAGE_CANDIDATES {
        return Err("lattice image enumeration too large (nearly degenerate basis)".to_string());
    }
    let mut out: Vec<Image> = Vec::new();
    let r2 = reach * reach;
    let mut m = m_lo;
    while m <= m_hi {
        let mut n = n_lo;
        while n <= n_hi {
            if half_plane && !(m > 0.0 || (m == 0.0 && n > 0.0)) {
                n += 1.0;
                continue;
            }
            let vx = d[0] + m * l.b1[0] + n * l.b2[0];
            let vy = d[1] + m * l.b1[1] + n * l.b2[1];
            if vx * vx + vy * vy < r2 {
                out.push(Image { m, n, v: [vx, vy] });
            }
            n += 1.0;
        }
        m += 1.0;
    }
    Ok(out)
}
