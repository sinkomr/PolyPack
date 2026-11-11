//! The problems of the balls family without their geometry. Port of `packages/balls/src/catalogue.ts`.
//!
//! P unit balls in the smallest ball or in the smallest copy of any of the polyhedra family's 186 solids, and P
//! unit-edge solids (any of the 186) in the smallest ball.
//!
//! A problem is named by a code `<piece>in<container>` in the manner of the polyhedra family ("cubintet"): the
//! piece is `ball` or a solid's code (tet, cub, oct, dod, ico, tte, pr3l15, ... as the polyhedra family names
//! them), the container `ball` or a solid's code. With P pieces its id is `balls/<code>/<P>`, e.g.
//! "balls/ballinball/13", "balls/ballinpkd/20" (balls in a pentakis dodecahedron), "balls/ap5inball/7".
//!
//! Without a piece or container of the other kind there are 1 + 186 + 186 = 373 codes: balls in a ball, balls in
//! each of the 186 solids, and each of the 186 solids in a ball. The first 7 (BALLS_ORIGINAL_CODES) are the
//! family's first problems, and their ids are unchanged.

use polypack_polyhedra::catalogue::{plural_title, SolidFamily, SolidName, SOLID_FAMILIES, SOLID_NAMES_LIST};
use std::collections::HashMap;
use std::sync::LazyLock;

/// `catalogue.ts: BALL_RADIUS`: the radius of a ball piece, in the units of the family (balls have diameter 1;
/// the polyhedra family's solids have edge 1). Every length of the family that is a ball's size goes through this
/// constant.
pub const BALL_RADIUS: f64 = 0.5;

/// `catalogue.ts: SCORE_TO_RADIUS`: the score s of a ball container is its DIAMETER (2026-10-27, option A of the
/// unit change): radius = s / 2. (The source can change the factor in its tests; the server never does.)
const SCORE_TO_RADIUS: f64 = 0.5;

/// `catalogue.ts: ballContainerScore`: the score of a ball container as a function of its radius.
#[inline]
pub fn ball_container_score(radius: f64) -> f64 {
    radius / SCORE_TO_RADIUS
}

/// `catalogue.ts: ballContainerRadius`: the radius of a ball container of a score.
#[inline]
pub fn ball_container_radius(score: f64) -> f64 {
    SCORE_TO_RADIUS * score
}

/// `catalogue.ts: BALL_DIAMETER`: the least distance of two ball centres.
pub const BALL_DIAMETER: f64 = 2.0 * BALL_RADIUS;

/// `catalogue.ts: BallsProblem`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BallsProblem {
    /// e.g. "ballinball", "ballincub", "tetinball", "ballinpkd".
    pub code: String,
    /// "ball", or the polyhedra family's name of a solid.
    pub piece: String,
    /// "ball", or the polyhedra family's name of a solid ("cube" for the cube).
    pub container: String,
    /// "Balls in a ball", "Triakis tetrahedra in a ball", "Balls in a pentakis dodecahedron".
    pub title: String,
    /// The group of the problem in the board's menu, e.g. "Balls in a Catalan solid".
    pub group: String,
}

/// `catalogue.ts: article` (either case, as the source's /^[aeiouAEIOU]/).
fn article(title: &str) -> String {
    if matches!(title.as_bytes().first(), Some(b'a' | b'e' | b'i' | b'o' | b'u' | b'A' | b'E' | b'I' | b'O' | b'U')) {
        format!("an {title}")
    } else {
        format!("a {title}")
    }
}

/// `catalogue.ts: capital`.
fn capital(t: &str) -> String {
    let mut chars = t.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `catalogue.ts: FAMILY_LABEL`; its keys' order (FAMILY_ORDER) is the polyhedra catalogue's SOLID_FAMILIES.
fn family_label(family: SolidFamily) -> &'static str {
    match family {
        SolidFamily::Platonic => "Platonic solid",
        SolidFamily::Archimedean => "Archimedean solid",
        SolidFamily::Catalan => "Catalan solid",
        SolidFamily::Prism => "prism",
        SolidFamily::Antiprism => "antiprism",
        SolidFamily::ElongatedPrism => "elongated prism",
        SolidFamily::Bipyramid => "bipyramid",
        SolidFamily::Trapezohedron => "trapezohedron",
        SolidFamily::Johnson => "Johnson solid",
    }
}

/// `catalogue.ts: FAMILY_PLURAL`.
fn family_plural(family: SolidFamily) -> &'static str {
    match family {
        SolidFamily::Platonic => "Platonic solids",
        SolidFamily::Archimedean => "Archimedean solids",
        SolidFamily::Catalan => "Catalan solids",
        SolidFamily::Prism => "Prisms",
        SolidFamily::Antiprism => "Antiprisms",
        SolidFamily::ElongatedPrism => "Elongated prisms",
        SolidFamily::Bipyramid => "Bipyramids",
        SolidFamily::Trapezohedron => "Trapezohedra",
        SolidFamily::Johnson => "Johnson solids",
    }
}

/// `catalogue.ts: solidRank`: sort key of a solid within its family: the number of sides, then the height of an
/// elongated prism. The source's pattern is /^(?:prism|antiprism|bipyramid|trapezohedron)(\d+)(?:_(l15|l2|l3))?$/
/// on the name.
fn solid_rank(s: &SolidName) -> [f64; 2] {
    let rest = ["prism", "antiprism", "bipyramid", "trapezohedron"].iter().find_map(|p| s.name.strip_prefix(p));
    let Some(rest) = rest else { return [0.0, 0.0] };
    let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return [0.0, 0.0];
    }
    let Ok(n) = rest[..digits].parse::<f64>() else { return [0.0, 0.0] };
    match &rest[digits..] {
        "" => [n, 0.0],
        "_l15" => [n, 0.0],
        "_l2" => [n, 1.0],
        "_l3" => [n, 2.0],
        _ => [0.0, 0.0],
    }
}

/// `catalogue.ts: SOLIDS`: the 186 solids in the order of the board's menu: by family, then (prisms and the
/// like) by sides and height.
static SOLIDS: LazyLock<Vec<&'static SolidName>> = LazyLock::new(|| {
    let mut out: Vec<&'static SolidName> = Vec::new();
    for f in SOLID_FAMILIES {
        let mut list: Vec<(&'static SolidName, usize, [f64; 2])> = SOLID_NAMES_LIST
            .iter()
            .filter(|s| s.family == f)
            .enumerate()
            .map(|(i, s)| (s, i, solid_rank(s)))
            .collect();
        // a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i
        list.sort_by(|a, b| {
            let keys = [a.2[0] - b.2[0], a.2[1] - b.2[1], a.1 as f64 - b.1 as f64];
            for d in keys {
                if d != 0.0 {
                    return if d < 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
                }
            }
            std::cmp::Ordering::Equal
        });
        out.extend(list.into_iter().map(|e| e.0));
    }
    out
});

/// `catalogue.ts: build`.
fn build() -> Vec<BallsProblem> {
    let mut out: Vec<BallsProblem> = Vec::new();
    let mut balls_in = |container: &str, code: &str, title: &str, group: String| {
        out.push(BallsProblem {
            code: format!("ballin{code}"),
            piece: "ball".to_string(),
            container: container.to_string(),
            title: format!("Balls in {}", article(title)),
            group,
        });
    };
    // balls in a ball, then in the Platonic solids, ..., trapezohedra
    balls_in("ball", "ball", "ball", "Balls in a ball or a Platonic solid".to_string());
    for s in SOLIDS.iter() {
        balls_in(
            &s.name,
            &s.code,
            &s.title,
            if s.family == SolidFamily::Platonic {
                "Balls in a ball or a Platonic solid".to_string()
            } else {
                format!("Balls in {}", article(family_label(s.family)))
            },
        );
    }
    for s in SOLIDS.iter() {
        out.push(BallsProblem {
            code: format!("{}inball", s.code),
            piece: s.name.clone(),
            container: "ball".to_string(),
            title: format!("{} in a ball", capital(&plural_title(&s.title))),
            group: format!("{} in a ball", family_plural(s.family)),
        });
    }
    out
}

/// `catalogue.ts: BALLS_PROBLEMS`.
pub static BALLS_PROBLEMS: LazyLock<Vec<BallsProblem>> = LazyLock::new(build);

/// `catalogue.ts: BALLS_ORIGINAL_CODES`: the codes of the family's first 7 problems, in their first order: balls
/// in a ball and in a cube, and the five Platonic solids in a ball.
pub const BALLS_ORIGINAL_CODES: [&str; 7] =
    ["ballinball", "ballincub", "tetinball", "cubinball", "octinball", "dodinball", "icoinball"];

/// `catalogue.ts: BALLS_CODES`: the codes in catalogue order.
pub static BALLS_CODES: LazyLock<Vec<String>> = LazyLock::new(|| BALLS_PROBLEMS.iter().map(|p| p.code.clone()).collect());

/// `catalogue.ts: BALLS_CODES_HINT`: a few codes for a message ("ballinball, ballincub, ..."), the list being 373
/// long.
pub static BALLS_CODES_HINT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}, ... (<piece>in<container>, the piece or the container ball or a solid's code of the polyhedra family; GET /api/spaces lists them)",
        BALLS_CODES[..6].join(", ")
    )
});

/// `catalogue.ts: BALLS_MIN_P`, `BALLS_MAX_P`: smallest and largest P of the catalogue.
pub const BALLS_MIN_P: u32 = 2;
pub const BALLS_MAX_P: u32 = 100;

/// `catalogue.ts: BY_CODE`.
static BY_CODE: LazyLock<HashMap<&'static str, usize>> =
    LazyLock::new(|| BALLS_PROBLEMS.iter().enumerate().map(|(i, p)| (p.code.as_str(), i)).collect());

/// `catalogue.ts: ballsProblemOf`: the problem of a code, or None.
pub fn balls_problem_of(code: &str) -> Option<&'static BallsProblem> {
    BY_CODE.get(code).map(|&i| &BALLS_PROBLEMS[i])
}

/// `catalogue.ts: ballsTitle`: "Balls in a ball" for a code; the code itself when it names no problem.
pub fn balls_title(code: &str) -> String {
    balls_problem_of(code).map_or_else(|| code.to_string(), |p| p.title.clone())
}

/// `catalogue.ts: ParsedBallsId`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedBallsId {
    pub id: String,
    pub code: String,
    pub p: u32,
    pub problem: &'static BallsProblem,
}

/// `catalogue.ts: parseBallsId`: the fields of a problem id `balls/<code>/<P>`, or a message saying what is wrong.
/// An id is accepted only in its one written form (P from 1 without leading zeros or a sign), so that every
/// problem has exactly one id. The catalogue's P range (BALLS_MIN_P to BALLS_MAX_P) is the caller's to apply.
/// (The source's first answer, "id must be a string", is for a value that is not a string.)
pub fn parse_balls_id(id: &str) -> Result<ParsedBallsId, String> {
    // id.length counts UTF-16 units
    if id.encode_utf16().count() > 100 {
        return Err("id is too long".to_string());
    }
    // /^balls\/([a-z][a-z0-9]*)\/([1-9]\d{0,3})$/
    let matched = (|| {
        let rest = id.strip_prefix("balls/")?;
        let (code, p) = rest.split_once('/')?;
        let cb = code.as_bytes();
        if cb.is_empty() || !cb[0].is_ascii_lowercase() || !cb.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
            return None;
        }
        let pb = p.as_bytes();
        if pb.is_empty() || pb.len() > 4 || !(b'1'..=b'9').contains(&pb[0]) || !pb.iter().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some((code, p.parse::<u32>().ok()?))
    })();
    let Some((code, p)) = matched else {
        return Err(format!(
            "\"{}\" is not a balls problem id: the form is balls/<code>/<P>, code {}",
            id, *BALLS_CODES_HINT
        ));
    };
    let Some(problem) = balls_problem_of(code) else {
        return Err(format!("\"{}\" is not a balls problem code ({})", code, *BALLS_CODES_HINT));
    };
    Ok(ParsedBallsId { id: id.to_string(), code: code.to_string(), p, problem })
}

/// `catalogue.ts: formatBallsId`.
pub fn format_balls_id(code: &str, p: u32) -> String {
    format!("balls/{code}/{p}")
}
