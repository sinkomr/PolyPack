//! The problems of the nD in nD space (packages/ndspace/src/catalogue.ts, docs/spaces/NDIM.md §10):
//! P equal pieces in the smallest scaled container, both a polytope of the dimension's catalogue
//! (packages/ndim) or a ball, in dimension d = 4 to 10.
//!
//! One space holds every dimension: a problem is `ndim/<d>/<piece>/<container>/<P>`, e.g.
//! "ndim/4/cube/ball/12": the shape names are the catalogue's ("simplex", "cube", "ortho", "demi",
//! "24cell", "120cell", "600cell", "221", "122", "321", "421") and "ball". Every ordered pair of the
//! dimension's shapes is a problem, balls included (balls in each polytope, each polytope in a
//! ball, balls in a ball), and P runs over the dimension's range (nd_p_range).
use serde_json::Value;

pub const ND_MIN_D: u32 = 4;
pub const ND_MAX_D: u32 = 10;
pub const ND_BALL: &str = "ball";

/// packages/ndspace/src/catalogue.ts: ND_POLYTOPES. The polytopes of each dimension's catalogue, by
/// catalogue name, in the catalogue's order; None for a dimension outside 4 to 10.
pub fn nd_polytopes(d: u32) -> Option<&'static [&'static str]> {
    match d {
        4 => Some(&["simplex", "cube", "ortho", "24cell", "120cell", "600cell"]),
        5 => Some(&["simplex", "cube", "ortho", "demi"]),
        6 => Some(&["simplex", "cube", "ortho", "demi", "221", "122"]),
        7 => Some(&["simplex", "cube", "ortho", "demi", "321"]),
        8 => Some(&["simplex", "cube", "ortho", "demi", "421"]),
        9 => Some(&["simplex", "cube", "ortho", "demi"]),
        10 => Some(&["simplex", "cube", "ortho", "demi"]),
        _ => None,
    }
}

/// packages/ndspace/src/catalogue.ts: ND_P_RANGE. Smallest and largest P of each dimension:
/// upstream's ranges for the first three (alejandrozu/platonic-packing, 4D to 40, 5D to 32, 6D to
/// 24) and 2 to 20 above.
pub fn nd_p_range(d: u32) -> Option<(u32, u32)> {
    match d {
        4 => Some((2, 40)),
        5 => Some((2, 32)),
        6 => Some((2, 24)),
        7..=10 => Some((2, 20)),
        _ => None,
    }
}
pub const ND_MAX_P: u32 = 40;
pub const ND_DIMENSIONS: [u32; 7] = [4, 5, 6, 7, 8, 9, 10];

/// packages/ndspace/src/catalogue.ts: ndShapes. The shape names of a dimension: its polytopes, then
/// "ball"; empty for a dimension outside 4 to 10.
pub fn nd_shapes(d: u32) -> Vec<&'static str> {
    match nd_polytopes(d) {
        Some(list) => {
            let mut v = list.to_vec();
            v.push(ND_BALL);
            v
        }
        None => Vec::new(),
    }
}

/// packages/ndspace/src/catalogue.ts: ND_SHAPE_NAMES. All shape names that occur, in the order of
/// first appearance (the menus' values).
pub fn nd_shape_names() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for d in ND_DIMENSIONS {
        for &name in nd_polytopes(d).unwrap_or(&[]) {
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    if !out.contains(&ND_BALL) {
        out.push(ND_BALL);
    }
    out
}

/// packages/ndspace/src/catalogue.ts: ndCode. The catalogue code of a shape ("4:cube"), or "ball".
pub fn nd_code(d: u32, shape: &str) -> String {
    if shape == ND_BALL {
        ND_BALL.to_string()
    } else {
        format!("{d}:{shape}")
    }
}

/// packages/ndspace/src/catalogue.ts: ndProblemCount. Number of problems of a dimension: its
/// ordered pairs of shapes times its P range.
pub fn nd_problem_count(d: u32) -> u64 {
    let n = nd_shapes(d).len() as u64;
    match nd_p_range(d) {
        Some((lo, hi)) => n * n * (hi - lo + 1) as u64,
        None => 0,
    }
}
/// packages/ndspace/src/catalogue.ts: ND_PROBLEM_COUNT.
pub fn nd_problem_count_all() -> u64 {
    ND_DIMENSIONS.iter().map(|&d| nd_problem_count(d)).sum()
}

/// packages/ndspace/src/catalogue.ts: SHAPE_TITLES, the singular (the plural is used only by the
/// pages' titles, which the server does not reach).
fn shape_title_one(shape: &str) -> Option<&'static str> {
    Some(match shape {
        "simplex" => "simplex",
        "cube" => "hypercube",
        "ortho" => "orthoplex",
        "demi" => "demicube",
        "24cell" => "24-cell",
        "120cell" => "120-cell",
        "600cell" => "600-cell",
        "221" => "2_21 polytope",
        "122" => "1_22 polytope",
        "321" => "3_21 polytope",
        "421" => "4_21 polytope",
        "ball" => "ball",
        _ => return None,
    })
}

/// `${t.charAt(0).toUpperCase()}${t.slice(1)}` (the titles are ASCII).
fn capital(t: &str) -> String {
    let mut chars = t.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// packages/ndspace/src/catalogue.ts: ndShapeTitle. Title of a shape in the menus of a dimension:
/// "Hypercube", "Ball".
pub fn nd_shape_title(shape: &str) -> String {
    capital(shape_title_one(shape).unwrap_or(shape))
}

/// packages/ndspace/src/catalogue.ts: NdProblemId.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NdProblemId {
    pub d: u32,
    pub piece: String,
    pub container: String,
    /// The number of pieces (the source's field `P`).
    pub p: u32,
}

/// packages/ndspace/src/catalogue.ts: ParsedNdId.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedNdId {
    pub id: String,
    pub d: u32,
    pub piece: String,
    pub container: String,
    pub p: u32,
}

impl ParsedNdId {
    pub fn problem(&self) -> NdProblemId {
        NdProblemId { d: self.d, piece: self.piece.clone(), container: self.container.clone(), p: self.p }
    }
}

pub const ND_ID_FORM: &str = "ndim/<d>/<piece>/<container>/<P>, d from 4 to 10, piece and container a polytope of the dimension (simplex, cube, ortho, demi, 24cell, 120cell, 600cell, 221, 122, 321, 421) or ball";

/// `/^[1-9]\d{0,3}$/`: one to four ASCII digits, the first not 0.
fn int_text(t: &str) -> Option<u32> {
    let b = t.as_bytes();
    if b.is_empty() || b.len() > 4 || !(b'1'..=b'9').contains(&b[0]) || !b.iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    t.parse().ok()
}

/// packages/ndspace/src/catalogue.ts: parseNdId, for an id that is a string. The fields of an id
/// `ndim/<d>/<piece>/<container>/<P>`, or a message saying what is wrong. Ids are accepted only in
/// their one written form. The dimension's P range is the caller's to apply (nd_in_range).
pub fn parse_nd_id(id: &str) -> Result<ParsedNdId, String> {
    // `id.length` counts UTF-16 code units
    if id.encode_utf16().count() > 100 {
        return Err("id is too long".into());
    }
    let parts: Vec<&str> = id.split('/').collect();
    let bad = || format!("\"{id}\" is not an ndim problem id: the form is {ND_ID_FORM}");
    if parts.len() != 5 || parts[0] != "ndim" {
        return Err(bad());
    }
    let (dt, piece, container, pt) = (parts[1], parts[2], parts[3], parts[4]);
    let (Some(d), Some(p)) = (int_text(dt), int_text(pt)) else {
        return Err(bad());
    };
    let shapes = nd_shapes(d);
    if !shapes.contains(&piece) || !shapes.contains(&container) {
        return Err(bad());
    }
    Ok(ParsedNdId { id: id.to_string(), d, piece: piece.to_string(), container: container.to_string(), p })
}

/// packages/ndspace/src/catalogue.ts: parseNdId, for any JSON value (`id: unknown`).
pub fn parse_nd_id_value(id: &Value) -> Result<ParsedNdId, String> {
    match id {
        Value::String(s) => parse_nd_id(s),
        _ => Err("id must be a string".into()),
    }
}

/// packages/ndspace/src/catalogue.ts: formatNdId.
pub fn format_nd_id(d: u32, piece: &str, container: &str, p: u32) -> String {
    format!("ndim/{d}/{piece}/{container}/{p}")
}

/// packages/ndspace/src/catalogue.ts: ndInRange. True when P is in the dimension's range.
pub fn nd_in_range(d: u32, p: u32) -> bool {
    match nd_p_range(d) {
        Some((lo, hi)) => p >= lo && p <= hi,
        None => false,
    }
}
