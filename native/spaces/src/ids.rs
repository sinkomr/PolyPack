//! Problem ids of the spaces, parsed into their fields and written back. Port of
//! packages/spaces/src/ids.ts. Boundary ids are read by the boundary crate's own parser
//! (`parse_boundary_id`), balls and nD ids by theirs, and polyhedra codes are checked against the
//! polyhedra crate's name list, as in the source.
//!
//!  - surface/<solid>/<mode>/<N>/<P>    e.g. surface/cube/fold/4/12
//!  - curved/<K>/<N>/<M>/<P>            e.g. curved/-1/3/4/7, curved/1e-06/0/0/5
//!  - sphere/<N>/<P>                    e.g. sphere/4/12
//!  - torus/<family>/<N>/<P>            e.g. torus/hex/5/8
//!  - boundary/<polytope>/<piece>/<P>   e.g. boundary/tesseract/ball/9
//!  - polyhedra/<code>/<P>              e.g. polyhedra/cubintet/12 (code: the wiki's <piece>in<container>)
//!  - balls/<code>/<P>                  e.g. balls/ballinball/13, balls/ballinpkd/20
//!  - ndim/<d>/<piece>/<container>/<P>  e.g. ndim/4/cube/ortho/12, ndim/8/421/ball/5
//!
//! An id is accepted only in its one written form (no leading zeros, no "+", K written as the
//! research records write it), so that every problem has exactly one id.

use crate::tables::TABLES;
use crate::types::{is_space_name, Field, Fields, SpaceName};
use polypack_balls::{parse_balls_id, BALLS_CODES_HINT};
use polypack_boundary::{parse_boundary_id, CONTAINERS, PIECES};
use polypack_js::fmt;
use polypack_ndim::space::{parse_nd_id, ND_ID_FORM};
use polypack_polyhedra::problem_name_of;
use serde_json::Value;

/// ids.ts: `SURFACE_SOLIDS`. The solids of the surface space, in the order the catalogue lists
/// them: the Platonic solids, the Archimedean solids, Catalan solids, the prisms and the
/// antiprisms, the 92 Johnson solids. The list as ids.ts writes it out (data/tables.json); the same
/// names as `polypack_surface::all_solid_names` (a test checks it).
pub fn surface_solids() -> &'static [String] {
    &TABLES.surface_solids
}
/// ids.ts: `SURFACE_PLATONIC`. Their nofold problems are planar problems of one face.
pub fn surface_platonic() -> &'static [String] {
    &surface_solids()[..5]
}
/// ids.ts: `SURFACE_ARCHIMEDEAN`.
pub fn surface_archimedean() -> &'static [String] {
    &surface_solids()[5..18]
}
/// ids.ts: `SURFACE_CATALAN`.
pub fn surface_catalan() -> &'static [String] {
    &surface_solids()[18..31]
}
/// ids.ts: `SURFACE_JOHNSON`. The 92 Johnson solids of the surface space (J1 to J92).
pub fn surface_johnson() -> &'static [String] {
    let all = surface_solids();
    &all[all.len() - 92..]
}
/// ids.ts: `SURFACE_MODES`.
pub const SURFACE_MODES: [&str; 2] = ["fold", "nofold"];
/// ids.ts: `TORUS_FAMILIES`. The lattice families of the torus space, in the order the catalogue lists them.
pub const TORUS_FAMILIES: [&str; 3] = ["sq", "hex", "free"];
/// ids.ts: `BOUNDARY_POLYTOPES`, `BOUNDARY_PIECES`. The polytopes and pieces of the boundary space,
/// in the order the catalogue lists them.
pub const BOUNDARY_POLYTOPES: [&str; 30] = CONTAINERS;
pub const BOUNDARY_PIECES: [&str; 6] = PIECES;

/// ids.ts: `ParsedSpaceId`.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedSpaceId {
    pub space: SpaceName,
    pub id: String,
    /// surface {solid, mode, N, P}; curved {K, N, M, P}; sphere {N, P}; torus {family, N, P};
    /// boundary {polytope, piece, P}; polyhedra and balls {code, piece, container, P}; ndim {d,
    /// piece, container, P}
    pub fields: Fields,
    /// The number of pieces (the source's field `P`).
    pub p: u32,
}

/// ids.ts: `INT`, `/^(0|[1-9]\d{0,3})$/`. A shape code (0 for a disk, else 3 to 100 sides) or a
/// piece count (1 to 9999), in its one written form.
fn int_text(text: &str) -> Option<u32> {
    let b = text.as_bytes();
    let ok = text == "0" || ((1..=4).contains(&b.len()) && (b'1'..=b'9').contains(&b[0]) && b[1..].iter().all(u8::is_ascii_digit));
    if ok {
        text.parse().ok()
    } else {
        None
    }
}

/// ids.ts: `shapeCode`.
fn shape_code(text: &str) -> Option<u32> {
    let n = int_text(text)?;
    if n == 0 || (3..=100).contains(&n) {
        Some(n)
    } else {
        None
    }
}

/// ids.ts: `pieceCount`.
fn piece_count(text: &str) -> Option<u32> {
    let n = int_text(text)?;
    if n >= 1 {
        Some(n)
    } else {
        None
    }
}

/// ids.ts: `formatCurvature`. K as the curved records write it: an integer as an integer ("1",
/// "-1"), any other value as Python's repr of the binary64 number ("1.225778283313099", "1e-06").
/// JavaScript and Python both print the shortest digits that round-trip; they differ only in when
/// they switch to exponent notation and in how they write the exponent. The `Err` is the message
/// of the RangeError the source throws for a K that is not finite.
pub fn format_curvature(k: f64) -> Result<String, String> {
    if !k.is_finite() {
        return Err(format!("K must be finite, not {}", fmt::num(k)));
    }
    if k == 0.0 && k.is_sign_negative() {
        return Ok("0".to_string());
    }
    if k == k.trunc() && k.abs() < 1e16 {
        return Ok(fmt::num(k));
    }
    let text = fmt::exponential(k, None);
    let (mantissa, exp) = text.split_once('e').expect("toExponential writes an exponent");
    let e: i32 = exp.parse().expect("an exponent");
    // Python's repr uses fixed notation for decimal exponents -4 <= e < 16, where it agrees with String()
    if (-4..16).contains(&e) {
        return Ok(fmt::num(k));
    }
    Ok(format!("{mantissa}e{}{:02}", if e < 0 { "-" } else { "+" }, e.abs()))
}

/// ids.ts: `DECIMAL`, `/^-?(0|[1-9]\d*)(\.\d+)?(e[-+]\d+)?$/`.
fn is_decimal(text: &str) -> bool {
    let b = text.as_bytes();
    let mut i = 0;
    if i < b.len() && b[i] == b'-' {
        i += 1;
    }
    // (0|[1-9]\d*)
    if i >= b.len() {
        return false;
    }
    if b[i] == b'0' {
        i += 1;
    } else if (b'1'..=b'9').contains(&b[i]) {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    } else {
        return false;
    }
    // (\.\d+)?
    if i < b.len() && b[i] == b'.' {
        let start = i + 1;
        let mut j = start;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == start {
            return false;
        }
        i = j;
    }
    // (e[-+]\d+)?
    if i < b.len() && b[i] == b'e' {
        if !(i + 1 < b.len() && (b[i + 1] == b'-' || b[i + 1] == b'+')) {
            return false;
        }
        let start = i + 2;
        let mut j = start;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == start {
            return false;
        }
        i = j;
    }
    i == b.len()
}

fn text(s: &str) -> Field {
    Field::Text(s.to_string())
}
fn number(n: u32) -> Field {
    Field::Number(n as f64)
}

/// ids.ts: `parseSpaceId`, for an id that is a string. The fields of a problem id, or a message
/// saying what is wrong with it.
pub fn parse_space_id(space: SpaceName, id: &str) -> Result<ParsedSpaceId, String> {
    // `id.length` counts UTF-16 code units
    if id.encode_utf16().count() > 100 {
        return Err("id is too long".to_string());
    }
    let parts: Vec<&str> = id.split('/').collect();
    if parts[0] != space.as_str() {
        return Err(format!("the id of a {space} problem starts with \"{space}/\""));
    }
    let bad = |pattern: &str| format!("\"{id}\" is not a {space} problem id: the form is {pattern}");
    let parsed = |fields: Vec<(&'static str, Field)>, p: u32| ParsedSpaceId { space, id: id.to_string(), fields: Fields(fields), p };
    match space {
        SpaceName::Surface => {
            let pattern = "surface/<solid>/<mode>/<N>/<P>, solid a Platonic solid (tetrahedron, cube, octahedron, dodecahedron, icosahedron), \
                           an Archimedean solid (such as snub_cube), a Catalan solid (such as rhombic_dodecahedron), a prism (prism3, prism5 to prism12), an antiprism \
                           (antiprism4 to antiprism12) or a Johnson solid (such as square_pyramid or snub_disphenoid), mode fold or nofold";
            if parts.len() != 5 {
                return Err(bad(pattern));
            }
            let (solid, mode) = (parts[1], parts[2]);
            let n = shape_code(parts[3]);
            let p = piece_count(parts[4]);
            if !surface_solids().iter().any(|s| s == solid) || !SURFACE_MODES.contains(&mode) {
                return Err(bad(pattern));
            }
            let (Some(n), Some(p)) = (n, p) else {
                return Err(bad(pattern));
            };
            Ok(parsed(vec![("solid", text(solid)), ("mode", text(mode)), ("N", number(n)), ("P", number(p))], p))
        }
        SpaceName::Curved => {
            let pattern = "curved/<K>/<N>/<M>/<P>, K written as the catalogue writes it (for example 1, -1 or 1e-06)";
            if parts.len() != 5 {
                return Err(bad(pattern));
            }
            let k_text = parts[1];
            let n = shape_code(parts[2]);
            let m = shape_code(parts[3]);
            let p = piece_count(parts[4]);
            let (true, Some(n), Some(m), Some(p)) = (is_decimal(k_text), n, m, p) else {
                return Err(bad(pattern));
            };
            // `Number(k)` of a decimal: the nearest double, Infinity beyond the largest
            let k: f64 = k_text.parse().unwrap_or(f64::NAN);
            if !k.is_finite() {
                return Err(bad(pattern));
            }
            let written = format_curvature(k).expect("a finite K");
            if written != k_text {
                return Err(format!("\"{id}\" is not written in its one form: K is written {written}"));
            }
            Ok(parsed(vec![("K", Field::Number(k)), ("N", number(n)), ("M", number(m)), ("P", number(p))], p))
        }
        SpaceName::Sphere => {
            let pattern = "sphere/<N>/<P>";
            if parts.len() != 3 {
                return Err(bad(pattern));
            }
            let (Some(n), Some(p)) = (shape_code(parts[1]), piece_count(parts[2])) else {
                return Err(bad(pattern));
            };
            Ok(parsed(vec![("N", number(n)), ("P", number(p))], p))
        }
        SpaceName::Torus => {
            let pattern = "torus/<family>/<N>/<P>, family one of sq, hex, free";
            if parts.len() != 4 {
                return Err(bad(pattern));
            }
            let family = parts[1];
            let (true, Some(n), Some(p)) = (TORUS_FAMILIES.contains(&family), shape_code(parts[2]), piece_count(parts[3])) else {
                return Err(bad(pattern));
            };
            Ok(parsed(vec![("family", text(family)), ("N", number(n)), ("P", number(p))], p))
        }
        SpaceName::Boundary => {
            let pattern = format!("boundary/<polytope>/<piece>/<P>, polytope {}, piece {}", CONTAINERS.join(" or "), PIECES.join(" or "));
            match parse_boundary_id(id) {
                // the package's sentence says which part is wrong, once the id has the right number of parts
                Err(message) => Err(if parts.len() == 4 { format!("{}. {message}", bad(&pattern)) } else { bad(&pattern) }),
                Ok(b) => {
                    let p = b.p as u32;
                    Ok(parsed(vec![("polytope", text(&b.polytope)), ("piece", text(&b.piece)), ("P", Field::Number(b.p))], p))
                }
            }
        }
        SpaceName::Polyhedra => {
            let pattern = "polyhedra/<code>/<P>, code the wiki's <piece>in<container> such as cubincub or cubintet";
            if parts.len() != 3 {
                return Err(bad(pattern));
            }
            let problem = problem_name_of(parts[1]);
            let p = piece_count(parts[2]);
            let (Some(problem), Some(p)) = (problem, p) else {
                return Err(bad(pattern));
            };
            Ok(parsed(
                vec![("code", text(&problem.code)), ("piece", text(&problem.piece)), ("container", text(&problem.container)), ("P", number(p))],
                p,
            ))
        }
        SpaceName::Balls => {
            let pattern = format!("balls/<code>/<P>, code {}", *BALLS_CODES_HINT);
            let Ok(b) = parse_balls_id(id) else {
                return Err(bad(&pattern));
            };
            let problem = b.problem;
            Ok(parsed(
                vec![("code", text(&problem.code)), ("piece", text(&problem.piece)), ("container", text(&problem.container)), ("P", number(b.p))],
                b.p,
            ))
        }
        SpaceName::Ndim => {
            let Ok(n) = parse_nd_id(id) else {
                return Err(format!("\"{id}\" is not an ndim problem id: the form is {ND_ID_FORM}"));
            };
            Ok(parsed(vec![("d", number(n.d)), ("piece", text(&n.piece)), ("container", text(&n.container)), ("P", number(n.p))], n.p))
        }
    }
}

/// ids.ts: `parseSpaceId`, for any JSON value (`id: unknown`, a request's field): a value that is
/// not a string is refused in the source's words.
pub fn parse_space_id_value(space: SpaceName, id: Option<&Value>) -> Result<ParsedSpaceId, String> {
    match id {
        Some(Value::String(s)) => parse_space_id(space, s),
        _ => Err("id must be a string".to_string()),
    }
}

/// `parseSpaceId(space, id).fields` for a caller that keeps no types of this crate (the database
/// layer's `SpaceIds::parse_space_id`): the fields in their order, or None when the space is not
/// one or the source returns a message.
pub fn parse_space_id_fields(space: &str, id: &str) -> Option<Vec<(String, Field)>> {
    let space = SpaceName::parse(space)?;
    let parsed = parse_space_id(space, id).ok()?;
    Some(parsed.fields.0.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// ids.ts: `spaceOfId`. The space an id belongs to (its first segment), or None.
pub fn space_of_id(id: &str) -> Option<SpaceName> {
    let head = id.split('/').next().unwrap_or("");
    if is_space_name(head) {
        SpaceName::parse(head)
    } else {
        None
    }
}

/// ids.ts: `formatSpaceId`. The id of a problem from its fields; the inverse of `parse_space_id`.
/// The `Err` is the message of the RangeError the source throws for a curved K that is not finite.
pub fn format_space_id(space: SpaceName, fields: &Fields) -> Result<String, String> {
    let f = |key: &str| fields.js_string(key);
    Ok(match space {
        SpaceName::Surface => format!("surface/{}/{}/{}/{}", f("solid"), f("mode"), f("N"), f("P")),
        SpaceName::Curved => {
            // `Number(fields.K)`: NaN for an absent K
            let k = fields.get("K").map_or(f64::NAN, Field::js_number);
            format!("curved/{}/{}/{}/{}", format_curvature(k)?, f("N"), f("M"), f("P"))
        }
        SpaceName::Sphere => format!("sphere/{}/{}", f("N"), f("P")),
        SpaceName::Torus => format!("torus/{}/{}/{}", f("family"), f("N"), f("P")),
        // as formatBoundaryId writes it, but without its throw on fields that name no problem
        SpaceName::Boundary => format!("boundary/{}/{}/{}", f("polytope"), f("piece"), f("P")),
        SpaceName::Polyhedra => format!("polyhedra/{}/{}", f("code"), f("P")),
        SpaceName::Balls => format!("balls/{}/{}", f("code"), f("P")),
        SpaceName::Ndim => format!("ndim/{}/{}/{}/{}", f("d"), f("piece"), f("container"), f("P")),
    })
}
