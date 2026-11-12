//! Whole-sphere geometry for the problems sphere/N/P (no container).
//! Source: packages/sphere/src/geometry.ts, the part the server's bundle keeps.
//!
//! Problem: P congruent pieces on a sphere of radius rho: disks of geodesic DIAMETER 1, i.e. radius
//! 1/2 (N = 0), or regular spherical N-gons of geodesic side 1 (N >= 3). Score rho (smaller is
//! better), K = 1/rho^2.
//!
//! All computation is done on the UNIT sphere, where a piece has angular size a = 1/rho for polygons
//! (side angle) and a = 1/(2 rho) for disks (angular radius): see `piece_angle`. Lengths on the
//! sphere (gaps) are rho times an angle, in site units.
//!
//! Coordinates: R^3 with O = e3 = (0, 0, 1) (north pole); the tangent frame at O is x = e1, y = e2.
//!
//! Standard piece: centre O, vertex k at (sin R cos phi_k, sin R sin phi_k, cos R),
//! phi_k = pi/2 + 2 pi k/N (vertex 0 straight up, +y), angular circumradius R with
//! sin(a/2) = sin R sin(pi/N). A convex regular N-gon needs R < pi/2, i.e. a < 2 pi/N
//! (rho > N/(2 pi)).
//!
//! Pose: a quaternion q = [w, x, y, z] (any nonzero q; the rotation of q/|q|, v -> q v q*). The
//! piece is G(standard piece).

use polypack_js::math;
use serde::{Deserialize, Serialize};

/// geometry.ts: `Vec3`.
pub type Vec3 = [f64; 3];
/// geometry.ts: `Quat`, [w, x, y, z].
pub type Quat = [f64; 4];

/// geometry.ts: `SphereProblem`. N and P are doubles, as in JavaScript: the validator itself
/// refuses the values that are not a shape or a count (`validation_steps`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SphereProblem {
    #[serde(rename = "N")]
    pub n: f64,
    #[serde(rename = "P")]
    pub p: f64,
}

/// geometry.ts: `SpherePiece`. `q` is a list so that a quaternion of another length reaches the
/// validator, which names it ("piece k: q must be 4 finite numbers"), as the TypeScript does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpherePiece {
    pub q: Vec<f64>,
}

/// geometry.ts: `SphereConfig`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SphereConfig {
    pub rho: f64,
    pub pieces: Vec<SpherePiece>,
}

/// geometry.ts: `dot`.
#[inline]
pub fn dot(a: &Vec3, b: &Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// geometry.ts: `cross`.
#[inline]
pub fn cross(a: &Vec3, b: &Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// geometry.ts: `norm` (`Math.hypot` of the three components).
#[inline]
pub fn norm(a: &Vec3) -> f64 {
    math::hypot3(a[0], a[1], a[2])
}

/// geometry.ts: `sub` (hull.ts has its own copy with the same body).
#[inline]
pub fn sub(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// geometry.ts: `pieceAngle`. Angular size of a piece on the unit sphere: polygon side angle, disk
/// angular radius.
pub fn piece_angle(n: f64, rho: f64) -> f64 {
    1.0 / (if n == 0.0 { 2.0 * rho } else { rho })
}

/// geometry.ts: `rhoForAngle`. The sphere radius rho at which a piece has angular size a (the
/// inverse of `piece_angle`; exact).
pub fn rho_for_angle(n: f64, a: f64) -> f64 {
    if n == 0.0 {
        1.0 / (2.0 * a)
    } else {
        1.0 / a
    }
}

/// geometry.ts: `pieceExists`. Does the piece exist as a convex regular N-gon (or a proper cap) at
/// sphere radius rho?
pub fn piece_exists(n: f64, rho: f64) -> bool {
    if !(rho > 0.0) || !rho.is_finite() {
        return false;
    }
    let a = piece_angle(n, rho);
    if n == 0.0 {
        return a < math::PI; // as the certifier: a cap of angular radius pi is the whole sphere
    }
    n >= 3.0 && a < (2.0 * math::PI) / n // equivalent to sin(a/2) < sin(pi/N) only for a < pi
}

/// geometry.ts: `circumradiusAngle`. Angular circumradius R: sin(a/2) = sin R sin(pi/N). Disks:
/// the angular radius.
pub fn circumradius_angle(n: f64, rho: f64) -> f64 {
    let a = piece_angle(n, rho);
    if n == 0.0 {
        return a;
    }
    math::asin(math::sin(a / 2.0) / math::sin(math::PI / n))
}

/// geometry.ts: `areaBound`. Area bound (float): the rho at which P pieces have total area
/// 4 pi rho^2; for P <= 2 polygons the existence limit N/(2 pi). The sphere domain's lower bound
/// is this times (1 - 1e-12) (packages/spaces/src/piece-domains.ts: `sphereDomain.bound`).
pub fn area_bound(n: f64, p: f64) -> f64 {
    // P caps of angular radius a cover the sphere at 1 - cos a = 2/P, i.e. sin(a/2) = 1/sqrt(P); rho = 1/(2a)
    if n == 0.0 {
        return rho_for_angle(0.0, 2.0 * math::asin(1.0 / math::sqrt(p)));
    }
    if p <= 2.0 {
        return n / (2.0 * math::PI);
    }
    // cos(a/2) = cos(x)/cos(y), x=pi/N, y=x(1-2/P). Avoid acos of a quotient
    // almost equal to one: sin²(a/4) = sin(x(1-1/P)) sin(x/P) / cos(y).
    // The quotient loses enough digits at large N, P to overstate a lower bound.
    let x = math::PI / n;
    let t = (math::sin(x * (1.0 - 1.0 / p)) * math::sin(x / p)) / math::cos(x * (1.0 - 2.0 / p));
    1.0 / (4.0 * math::asin(math::sqrt(t)))
}

/// geometry.ts: `quatToMatrix`. Rotation matrix of q/|q| (rows), exactly orthogonal formula
/// H(q)/|q|^2.
pub fn quat_to_matrix(q: &Quat) -> [Vec3; 3] {
    let [w, x, y, z] = *q;
    let n = w * w + x * x + y * y + z * z;
    [
        [
            (w * w + x * x - y * y - z * z) / n,
            (2.0 * (x * y - w * z)) / n,
            (2.0 * (x * z + w * y)) / n,
        ],
        [
            (2.0 * (x * y + w * z)) / n,
            (w * w - x * x + y * y - z * z) / n,
            (2.0 * (y * z - w * x)) / n,
        ],
        [
            (2.0 * (x * z - w * y)) / n,
            (2.0 * (y * z + w * x)) / n,
            (w * w - x * x - y * y + z * z) / n,
        ],
    ]
}

/// The second half of geometry.ts `rotate`: the matrix of the quaternion applied to v. `rotate`
/// builds the matrix at every call; a caller that turns many vectors by one quaternion builds it
/// once, with the same result.
#[inline]
pub fn apply(m: &[Vec3; 3], v: &Vec3) -> Vec3 {
    [dot(&m[0], v), dot(&m[1], v), dot(&m[2], v)]
}

/// geometry.ts: `rotate`.
pub fn rotate(q: &Quat, v: &Vec3) -> Vec3 {
    let m = quat_to_matrix(q);
    apply(&m, v)
}

/// geometry.ts: `centreOf`.
pub fn centre_of(q: &Quat) -> Vec3 {
    rotate(q, &[0.0, 0.0, 1.0])
}

/// geometry.ts: `standardVertices`. Vertices of the standard N-gon of circumradius R (vertex 0 up).
pub fn standard_vertices(n: usize, r: f64) -> Vec<Vec3> {
    let mut out = Vec::with_capacity(n);
    for k in 0..n {
        let phi = math::PI / 2.0 + (2.0 * math::PI * k as f64) / n as f64;
        out.push([
            math::sin(r) * math::cos(phi),
            math::sin(r) * math::sin(phi),
            math::cos(r),
        ]);
    }
    out
}

/// geometry.ts: `placedVertices`. Vertices of a placed N-gon on the unit sphere at sphere radius rho.
pub fn placed_vertices(n: usize, rho: f64, q: &Quat) -> Vec<Vec3> {
    let r = circumradius_angle(n as f64, rho);
    let m = quat_to_matrix(q);
    standard_vertices(n, r).iter().map(|v| apply(&m, v)).collect()
}
