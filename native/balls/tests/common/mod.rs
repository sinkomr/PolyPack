//! What the comparison with the TypeScript writes for a case and for a line of the catalogue, shared by the
//! example `ballsdiff` (the full comparison) and the test `fixtures` (the cases kept in the repository).
//!
//! The text is built by hand, field by field in the order `native/tools/balls-ref.mts` writes it, with every
//! number as JavaScript prints it (`polypack_js::fmt::num`) inside a JSON string, so that equal results are
//! equal bytes.
#![allow(dead_code)]

use polypack_balls as balls;
use polypack_js::fmt;
use polypack_polyhedra as ph;
use serde_json::Value;

/// A JSON string.
pub fn s(x: &str) -> String {
    serde_json::to_string(x).expect("a string")
}

/// A number as JavaScript prints it, as a JSON string ("Infinity" too).
pub fn n(x: f64) -> String {
    s(&fmt::num(x))
}

pub fn arr(items: impl IntoIterator<Item = String>) -> String {
    format!("[{}]", items.into_iter().collect::<Vec<_>>().join(","))
}

pub fn obj(fields: &[(&str, String)]) -> String {
    format!("{{{}}}", fields.iter().map(|(k, v)| format!("{}:{}", s(k), v)).collect::<Vec<_>>().join(","))
}

pub fn opt(x: Option<String>) -> String {
    x.unwrap_or_else(|| "null".to_string())
}

/// FNV-1a (32 bits) of a text's UTF-8 bytes, as 8 hex digits (the tool's `fnv`).
pub fn fnv(text: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in text.bytes() {
        h = (h ^ b as u32).wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}

/// `JSON.stringify(config)` of a parsed configuration.
pub fn config_json(config: &balls::BallsConfig) -> String {
    format!(
        "{{\"s\":{},\"pieces\":{}}}",
        fmt::num(config.s),
        arr(config.pieces.iter().map(|p| arr(p.iter().map(|x| fmt::num(*x)))))
    )
}

fn validation_json(tol: f64, r: &Result<balls::BallsValidation, String>) -> String {
    match r {
        Ok(r) => obj(&[
            ("tol", n(tol)),
            ("valid", r.valid.to_string()),
            ("errors", arr(r.errors.iter().map(|e| s(e)))),
            ("minWallGap", n(r.min_wall_gap)),
            ("minPairSep", n(r.min_pair_sep)),
            ("worstPair", opt(r.worst_pair.map(|(i, j)| format!("[{i},{j}]")))),
        ]),
        Err(e) => obj(&[("tol", n(tol)), ("threw", s(e))]),
    }
}

pub const TOLS: [f64; 2] = [1e-9, 1e-11];

/// The answer for one case {id, kind, code, P, raw}: the tool's `answer`.
pub fn answer_line(case: &Value) -> String {
    let id = case["id"].as_u64().expect("id");
    let code = case["code"].as_str().expect("code");
    let p = case["P"].as_u64().expect("P") as usize;
    let raw = &case["raw"];
    let Some(problem) = balls::get_balls_problem(code) else {
        return format!("{{\"id\":{id},\"problem\":null}}");
    };
    let parsed = balls::parse_balls_config(problem, raw, p, 20);
    let parse = match &parsed {
        balls::BallsParsed::Ok { config, score } => obj(&[
            ("ok", "true".to_string()),
            ("score", n(*score)),
            ("n", config.pieces.len().to_string()),
            ("echo", s(&fnv(&config_json(config)))),
        ]),
        balls::BallsParsed::Failed { malformed, errors } => obj(&[
            ("ok", "false".to_string()),
            ("malformed", malformed.to_string()),
            ("errors", arr(errors.iter().map(|e| s(e)))),
        ]),
    };
    let v = arr(TOLS.iter().map(|&tol| {
        let opts = balls::BallsValidateOptions { tol: Some(tol), max_errors: Some(20) };
        let r = balls::validate_balls_value(problem, raw, &opts);
        let mut text = validation_json(tol, &r);
        // the typed entry (what the server calls after the parse) must say the same as the one on the raw value
        if let balls::BallsParsed::Ok { config, .. } = &parsed {
            let typed = balls::validate_balls(problem, config, &opts);
            if typed != r {
                text = obj(&[("tol", n(tol)), ("typed_differs", validation_json(tol, &typed)), ("raw", text)]);
            }
        }
        text
    }));
    format!("{{\"id\":{id},\"parse\":{parse},\"v\":{v}}}")
}

fn strings<'a>(list: impl IntoIterator<Item = &'a String>) -> String {
    arr(list.into_iter().map(|x| s(x)))
}

/// A key's inputs written after its first '/', as JSON.
fn key_json(key: &str) -> Value {
    serde_json::from_str(key.split_once('/').expect("a key with inputs").1).expect("the key's JSON")
}

/// The code and the number of a key "<head>/<code>/<P>".
fn code_and_number(key: &str) -> (&str, f64) {
    let rest = key.split_once('/').expect("a key with inputs").1;
    let (code, p) = rest.rsplit_once('/').expect("code/P");
    (code, p.parse::<f64>().expect("a number in a key"))
}

fn triple(v: &[f64; 3]) -> String {
    arr(v.iter().map(|x| n(*x)))
}

/// The value of one line of the catalogue (the tool's `put(k, v)`), as JSON text. Panics on a key it does not
/// know, so that nothing is left out silently.
pub fn catalogue_value(key: &str) -> String {
    let head = key.split('/').next().unwrap_or("");
    match head {
        "constants" => obj(&[
            ("BALL_RADIUS", n(balls::BALL_RADIUS)),
            ("BALL_DIAMETER", n(balls::BALL_DIAMETER)),
            ("BALLS_MIN_P", balls::BALLS_MIN_P.to_string()),
            ("BALLS_MAX_P", balls::BALLS_MAX_P.to_string()),
            ("BALLS_TOL", n(balls::BALLS_TOL)),
            ("BALLS_MAX_SIZE", n(balls::BALLS_MAX_SIZE)),
            ("BALLS_MAX_COORD", n(balls::BALLS_MAX_COORD)),
            ("score_of_radius_3", n(balls::ball_container_score(3.0))),
            ("radius_of_score_3", n(balls::ball_container_radius(3.0))),
        ]),
        "problems" => arr(
            balls::BALLS_PROBLEMS.iter().map(|p| arr([s(&p.code), s(&p.piece), s(&p.container), s(&p.title), s(&p.group)])),
        ),
        "codes" => strings(balls::BALLS_CODES.iter()),
        "codes_hint" => s(&balls::BALLS_CODES_HINT),
        "original_codes" => arr(balls::BALLS_ORIGINAL_CODES.iter().map(|c| s(c))),
        "container_kinds" => arr(balls::BALLS_PROBLEMS.iter().map(|p| {
            s(match balls::container_kind(p) {
                balls::ContainerKind::Ball => "ball",
                balls::ContainerKind::Cube => "cube",
                balls::ContainerKind::Polyhedron => "polyhedron",
            })
        })),
        "plurals" => arr(balls::BALLS_PROBLEMS.iter().map(|p| s(&balls::plural_of(&p.piece)))),
        "piece_volumes" => arr(balls::BALLS_PROBLEMS.iter().map(|p| n(balls::piece_volume(p).expect("a solid")))),
        "problem_of" => arr(
            key_json(key).as_array().unwrap().iter().map(|c| opt(balls::balls_problem_of(c.as_str().unwrap()).map(|p| s(&p.title)))),
        ),
        "title" => arr(key_json(key).as_array().unwrap().iter().map(|c| s(&balls::balls_title(c.as_str().unwrap())))),
        "parse_id" => arr(key_json(key).as_array().unwrap().iter().map(|id| match balls::parse_balls_id(id.as_str().unwrap()) {
            Ok(r) => arr([s(&r.id), s(&r.code), r.p.to_string(), s(&r.problem.code)]),
            Err(e) => s(&e),
        })),
        "format_id" => arr(
            key_json(key).as_array().unwrap().iter().map(|x| s(&balls::format_balls_id(x[0].as_str().unwrap(), x[1].as_u64().unwrap() as u32))),
        ),
        "extent" => {
            let solid = ph::get_solid(key.split_once('/').unwrap().1).expect("a solid");
            obj(&[
                ("chebyshevOf", n(balls::chebyshev_of(&solid.n, &solid.offsets).expect("a bounded solid"))),
                ("enclosingOf", n(balls::enclosing_of(&solid.v))),
                ("chebyshevRadius", n(balls::chebyshev_radius(solid).expect("a bounded solid"))),
                ("enclosingRadius", n(balls::enclosing_radius(solid))),
            ])
        }
        "container" => {
            let c = balls::container_of(key.split_once('/').unwrap().1).expect("a solid");
            obj(&[
                ("F", c.f.to_string()),
                ("inradius", n(c.inradius)),
                ("chebyshev", n(c.chebyshev)),
                ("circumradius", n(c.circumradius)),
                ("enclosing", n(c.enclosing)),
                ("diameter", n(c.diameter)),
                ("volume", n(c.volume)),
                ("tangential", c.tangential.to_string()),
                ("lo", triple(&c.lo)),
                ("hi", triple(&c.hi)),
            ])
        }
        "bound" => {
            let (code, p) = code_and_number(key);
            let b = balls::balls_bound(balls::get_balls_problem(code).expect("a problem"), p).expect("a bound");
            obj(&[("value", n(b.value)), ("kind", s(b.kind)), ("label", s(&b.label))])
        }
        "domain_bound" => {
            let (code, p) = code_and_number(key);
            opt(balls::balls_domain_bound(code, p).map(|b| obj(&[("value", n(b.value)), ("label", s(&b.label))])))
        }
        "domain_info" => s(&serde_json::to_string(&balls::balls_domain_info()).expect("the domain's JSON")),
        "domain_sample" => {
            let limit: usize = key.split_once('/').unwrap().1.parse().expect("a limit");
            let ids = balls::balls_domain_sample(limit);
            obj(&[
                ("length", ids.len().to_string()),
                ("first", strings(ids.iter().take(3))),
                ("last", strings(ids.iter().skip(ids.len().saturating_sub(2)))),
                ("hash", s(&fnv(&ids.join(",")))),
            ])
        }
        "config_errors" => {
            // the key carries [code, raw, P or null, maxErrors]
            let input = key_json(key);
            let problem = balls::get_balls_problem(input[0].as_str().unwrap()).expect("a problem");
            let p = input[2].as_u64().map(|x| x as usize);
            let max = input[3].as_u64().expect("maxErrors") as usize;
            arr(balls::balls_config_errors(problem, &input[1], p, max).iter().map(|e| s(e)))
        }
        _ => panic!("no rule for the catalogue line {key:?}"),
    }
}

/// One line of the catalogue: {"k": key, "v": value}.
pub fn catalogue_line(key: &str) -> String {
    format!("{{\"k\":{},\"v\":{}}}", s(key), catalogue_value(key))
}
