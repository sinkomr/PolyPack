//! Problem ids, configurations and the per-(K, N, M) data shared by the validator and the search
//! (packages/curved/src/problem.ts, packages/spaces/src/ids.ts).
//!
//! Pose (x, y, theta) of a piece: the piece is G(standard piece) with G = T(c) R(theta), where
//!   - the standard piece is centred at the container centre O with vertex k at direction
//!     pi/2 + 2 pi k / N (a vertex straight up) and geodesic circumradius R_K(N);
//!   - R(theta) is the rotation about O by theta (counter-clockwise);
//!   - c = exp_O(x, y) is the point at geodesic distance sqrt(x^2 + y^2) from O in direction (x, y);
//!   - T(c) is the transvection along the geodesic from O to c.
//!
//! At K = 0 this is PolyPack's Euclidean pose. The container is centred at O with a horizontal
//! bottom edge: wall k has outward normal angle -pi/2 + 2 pi k / M at distance h (apothem) from O.

use crate::bound::{curved_bound, curved_max_p, CURVED_MAX_P};
use crate::geom::{line_covector, polar_point, LPoint};
use crate::shapes::{
    max_apothem, piece_edge_angle, piece_exists, piece_geometry, piece_vertex_angle, wall_angle, PieceGeometry,
};
use serde::{Deserialize, Serialize};
use std::fmt;

/// A problem of the curved space: id `curved/<K>/<N>/<M>/<P>`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CurvedProblem {
    /// Curvature.
    pub k: f64,
    /// 0 = disk of diameter 1, else regular N-gon of side 1 (3 to 100).
    pub n: u32,
    /// 0 = disk container (scored by its diameter), else regular M-gon of side s (3 to 100).
    pub m: u32,
    /// Number of pieces (1 to 500).
    pub p: u32,
}

/// Why an id is not a curved problem id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdError(pub String);

impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for IdError {}

/// One pose: exponential coordinates of the centre and the orientation (radians).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub theta: f64,
}

/// A configuration as the API sends and takes it: `{"size": s, "pieces": [{"x", "y", "theta"}, ...]}`
/// (the `config` of POST /api/spaces/submit, and `certified_config` / `site_config` of
/// GET /api/spaces/curved/problems/<id>). Unknown fields are ignored when reading.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CurvedConfig {
    /// Container size: side s (M >= 3) or diameter (M = 0).
    pub size: f64,
    pub pieces: Vec<Pose>,
}

impl CurvedConfig {
    /// The poses as a flat vector (x0, y0, theta0, x1, ...).
    pub fn to_vector(&self) -> Vec<f64> {
        let mut z = Vec::with_capacity(3 * self.pieces.len());
        for p in &self.pieces {
            z.extend_from_slice(&[p.x, p.y, p.theta]);
        }
        z
    }

    pub fn from_vector(size: f64, z: &[f64]) -> CurvedConfig {
        CurvedConfig {
            size,
            pieces: z
                .as_chunks::<3>()
                .0
                .iter()
                .map(|c| Pose {
                    x: c[0],
                    y: c[1],
                    theta: c[2],
                })
                .collect(),
        }
    }

    /// True when every number is finite and the size positive.
    pub fn is_finite(&self) -> bool {
        self.size.is_finite()
            && self.size > 0.0
            && self
                .pieces
                .iter()
                .all(|p| p.x.is_finite() && p.y.is_finite() && p.theta.is_finite())
    }
}

/// K as the curved records and ids write it: an integer as an integer ("1", "-1"), any other value
/// as Python's repr of the binary64 number ("1.225778283313099", "1e-06"): the shortest digits that
/// round-trip, fixed notation for decimal exponents -4 <= e < 16, else d.ddde-XX.
pub fn format_curvature(k: f64) -> Option<String> {
    if !k.is_finite() {
        return None;
    }
    if k == 0.0 {
        return Some("0".to_string());
    }
    if k.fract() == 0.0 && k.abs() < 1e16 {
        return Some(format!("{}", k as i64));
    }
    // shortest round-trip digits in exponent form, e.g. "1.5e-6" or "-1e16"
    let text = format!("{:e}", k);
    let (mantissa, exp) = text.split_once('e')?;
    let e: i32 = exp.parse().ok()?;
    if (-4..16).contains(&e) {
        // fixed notation with the same shortest digits (Rust's Display never uses an exponent)
        return Some(format!("{}", k));
    }
    let sign = if e < 0 { '-' } else { '+' };
    Some(format!("{mantissa}e{sign}{:02}", e.abs()))
}

/// A shape code (0 for a disk, else 3 to 100) or a count, in its one written form.
fn int_field(text: &str) -> Option<u32> {
    let b = text.as_bytes();
    if b.is_empty() || b.len() > 4 || !b.iter().all(u8::is_ascii_digit) || (b.len() > 1 && b[0] == b'0') {
        return None;
    }
    text.parse().ok()
}

/// The decimal form of an id's K: -?(0|[1-9]\d*)(\.\d+)?(e[-+]\d+)?
fn decimal_form(text: &str) -> bool {
    let mut s = text.strip_prefix('-').unwrap_or(text);
    let int_len = s.bytes().take_while(u8::is_ascii_digit).count();
    if int_len == 0 || (int_len > 1 && s.as_bytes()[0] == b'0') {
        return false;
    }
    s = &s[int_len..];
    if let Some(rest) = s.strip_prefix('.') {
        let frac = rest.bytes().take_while(u8::is_ascii_digit).count();
        if frac == 0 {
            return false;
        }
        s = &rest[frac..];
    }
    if s.is_empty() {
        return true;
    }
    let Some(rest) = s.strip_prefix('e') else { return false };
    let Some(rest) = rest.strip_prefix('-').or_else(|| rest.strip_prefix('+')) else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|c| c.is_ascii_digit())
}

impl CurvedProblem {
    /// Reads an API id `curved/<K>/<N>/<M>/<P>`, accepted only in its one written form (as the
    /// server's parseSpaceId), with P at most 500 (the server's largest curved P).
    pub fn parse(id: &str) -> Result<CurvedProblem, IdError> {
        let bad = || {
            IdError(format!(
                "\"{id}\" is not a curved problem id: the form is curved/<K>/<N>/<M>/<P>"
            ))
        };
        if id.len() > 100 {
            return Err(IdError("id is too long".into()));
        }
        let parts: Vec<&str> = id.split('/').collect();
        if parts.len() != 5 || parts[0] != "curved" {
            return Err(bad());
        }
        let shape = |t: &str| int_field(t).filter(|&n| n == 0 || (3..=100).contains(&n));
        let (Some(n), Some(m), Some(p)) = (
            shape(parts[2]),
            shape(parts[3]),
            int_field(parts[4]).filter(|&p| p >= 1),
        ) else {
            return Err(bad());
        };
        if !decimal_form(parts[1]) {
            return Err(bad());
        }
        let k: f64 = parts[1].parse().map_err(|_| bad())?;
        if !k.is_finite() {
            return Err(bad());
        }
        let written = format_curvature(k).ok_or_else(bad)?;
        if written != parts[1] {
            return Err(IdError(format!(
                "\"{id}\" is not written in its one form: K is written {written}"
            )));
        }
        if p > CURVED_MAX_P {
            return Err(IdError(format!(
                "P = {p} is above the largest P of the curved catalogue ({CURVED_MAX_P})"
            )));
        }
        Ok(CurvedProblem { k, n, m, p })
    }

    /// The API id of the problem (None when K is not finite).
    pub fn id(&self) -> Option<String> {
        Some(format!(
            "curved/{}/{}/{}/{}",
            format_curvature(self.k)?,
            self.n,
            self.m,
            self.p
        ))
    }

    /// True when the problem can exist: the unit piece exists at K and some container below the
    /// admissible limit holds P pieces by the area and containment bounds (curvedMaxP).
    pub fn exists(&self) -> bool {
        curved_max_p(self.k, self.n, self.m, self.p.max(1)) >= self.p
    }

    /// The problem's lower bound on the score (the server's bound when the problem has no
    /// research record), or None when the problem cannot exist.
    pub fn lower_bound(&self) -> Option<f64> {
        curved_bound(self.k, self.n, self.m, self.p)
    }
}

/// Shared per-(K, N, M) data: the unit piece, its standard vertices and edge lines, the walls.
#[derive(Clone, Debug)]
pub struct Space {
    pub k: f64,
    pub n: u32,
    pub m: u32,
    pub piece: PieceGeometry,
    /// standard-piece vertices in lifted coordinates (empty for disks)
    pub vertices: Vec<LPoint>,
    /// standard-piece outward edge covectors (Qd = 1); edge e joins vertex e and e + 1
    pub edges: Vec<[f64; 3]>,
    /// wall outward normal angles
    pub wall_angles: Vec<f64>,
    /// upper limit of the container variable t (apothem or radius)
    pub t_max: f64,
}

impl Space {
    /// The space of (K, N, M), or a reason when the shapes are not valid or the unit piece does
    /// not exist at K (makeSpace).
    pub fn new(k: f64, n: u32, m: u32) -> Result<Space, String> {
        if !k.is_finite() {
            return Err("K must be finite".into());
        }
        if !(n == 0 || (3..=100).contains(&n)) {
            return Err("bad N".into());
        }
        if !(m == 0 || (3..=100).contains(&m)) {
            return Err("bad M".into());
        }
        if !piece_exists(n, k) {
            return Err(format!("no unit piece N={n} exists at K={k}"));
        }
        let piece = piece_geometry(n, k).ok_or_else(|| format!("no unit piece N={n} exists at K={k}"))?;
        let vertices = (0..n)
            .map(|v| polar_point(k, piece.r, piece_vertex_angle(n, v)))
            .collect();
        let edges = (0..n)
            .map(|e| line_covector(k, piece.rho, piece_edge_angle(n, e)))
            .collect();
        let wall_angles = (0..m).map(|w| wall_angle(m, w)).collect();
        Ok(Space {
            k,
            n,
            m,
            piece,
            vertices,
            edges,
            wall_angles,
            t_max: max_apothem(m, k),
        })
    }

    pub fn of(problem: &CurvedProblem) -> Result<Space, String> {
        Space::new(problem.k, problem.n, problem.m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curvatures_are_written_as_the_catalogue_writes_them() {
        let cases = [
            (1.0, "1"),
            (-1.0, "-1"),
            (0.0, "0"),
            (1e-6, "1e-06"),
            (-1e-6, "-1e-06"),
            (1e-5, "1e-05"),
            (0.0001, "0.0001"),
            (-0.25, "-0.25"),
            (1.225778283313099, "1.225778283313099"),
            (-6.519717439579256, "-6.519717439579256"),
            (1e16, "1e+16"),
            (1.2345678901234568e17, "1.2345678901234568e+17"),
            (1e21, "1e+21"),
        ];
        for (k, text) in cases {
            assert_eq!(format_curvature(k).unwrap(), text);
        }
    }

    #[test]
    fn ids_parse_in_their_one_form() {
        let p = CurvedProblem::parse("curved/-1/3/6/8").unwrap();
        assert_eq!(
            p,
            CurvedProblem {
                k: -1.0,
                n: 3,
                m: 6,
                p: 8
            }
        );
        assert_eq!(p.id().unwrap(), "curved/-1/3/6/8");
        let q = CurvedProblem::parse("curved/1e-06/0/0/5").unwrap();
        assert_eq!(q.k, 1e-6);
        for bad in [
            "curved/1.0/3/6/8",
            "curved/0.000001/0/0/5",
            "curved/1e-6/0/0/5",
            "curved/-1/3/6/0",
            "curved/-1/3/6/501",
            "curved/-1/2/6/8",
            "curved/-1/03/6/8",
            "curved/+1/3/6/8",
            "curved/-1/3/6",
            "sphere/4/12",
            "curved/-0/3/6/8",
            "curved/1./3/6/8",
        ] {
            assert!(CurvedProblem::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn configurations_serialize_as_the_api_writes_them() {
        let text = r#"{"size":1.724148891504105,"pieces":[{"x":-0.7764145291718095,"y":0.20772581604160836,"theta":4.047426214757005}],"extra":1}"#;
        let c: CurvedConfig = serde_json::from_str(text).unwrap();
        assert_eq!(c.pieces[0].theta, 4.047426214757005);
        let back = serde_json::to_string(&c).unwrap();
        assert_eq!(
            back,
            r#"{"size":1.724148891504105,"pieces":[{"x":-0.7764145291718095,"y":0.20772581604160836,"theta":4.047426214757005}]}"#
        );
    }
}
