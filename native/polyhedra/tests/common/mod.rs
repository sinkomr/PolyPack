//! What the comparison with the TypeScript writes for a case and for a line of the catalogue, shared by the
//! example `polyhedradiff` (the full comparison) and the test `fixtures` (the cases kept in the repository).
//!
//! The text is built by hand, field by field in the order `native/tools/polyhedra-ref.mts` writes it, with every
//! number as JavaScript prints it (`polypack_js::fmt::num`) inside a JSON string, so that equal results are
//! equal bytes.
#![allow(dead_code)]

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
pub fn config_json(config: &ph::PolyhedraConfig) -> String {
    format!(
        "{{\"s\":{},\"pieces\":{}}}",
        fmt::num(config.s),
        arr(config.pieces.iter().map(|p| arr(p.iter().map(|x| fmt::num(*x)))))
    )
}

fn validation_json(tol: f64, r: &Result<ph::PolyhedraValidation, String>) -> String {
    match r {
        Ok(r) => obj(&[
            ("tol", n(tol)),
            ("valid", r.valid.to_string()),
            ("errors", arr(r.errors.iter().map(|e| s(e)))),
            ("minWallGap", n(r.min_wall_gap)),
            ("minPairSep", n(r.min_pair_sep)),
            ("worstPair", opt(r.worst_pair.map(|(i, j)| format!("[{i},{j}]")))),
            ("pairsTested", r.pairs_tested.to_string()),
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
    let Some(problem) = ph::get_problem(code) else {
        return format!("{{\"id\":{id},\"problem\":null}}");
    };
    let parsed = ph::parse_polyhedra_config(raw, p, 20);
    let parse = match &parsed {
        ph::ParsedConfig::Ok { config, score } => obj(&[
            ("ok", "true".to_string()),
            ("score", n(*score)),
            ("n", config.pieces.len().to_string()),
            ("echo", s(&fnv(&config_json(config)))),
        ]),
        ph::ParsedConfig::Failed { malformed, errors } => obj(&[
            ("ok", "false".to_string()),
            ("malformed", malformed.to_string()),
            ("errors", arr(errors.iter().map(|e| s(e)))),
        ]),
    };
    let v = arr(TOLS.iter().map(|&tol| {
        let opts = ph::ValidateOptions { tol: Some(tol), max_errors: Some(20), stop_at: None };
        let r = ph::validate_polyhedra_value(&problem, raw, &opts);
        let mut text = validation_json(tol, &r);
        // the typed entry (what the server calls after the parse) must say the same as the one on the raw value
        if let ph::ParsedConfig::Ok { config, .. } = &parsed {
            let typed = ph::validate_polyhedra(&problem, config, &opts);
            if typed != r {
                text = obj(&[("tol", n(tol)), ("typed_differs", validation_json(tol, &typed)), ("raw", text)]);
            }
        }
        text
    }));
    format!("{{\"id\":{id},\"parse\":{parse},\"v\":{v}}}")
}

fn name_row(p: Option<ph::ProblemName>) -> String {
    opt(p.map(|p| {
        arr([s(&p.code), s(&p.piece), s(&p.container), s(p.family.as_str()), s(&p.title), p.wiki.to_string()])
    }))
}

fn strings<'a>(list: impl IntoIterator<Item = &'a String>) -> String {
    arr(list.into_iter().map(|x| s(x)))
}

/// The weighted sum the tool takes of a flat list: sum of a[i] * (1 + i % 7), in order.
fn weighted(a: &[f64]) -> f64 {
    let mut t = 0.0;
    for (i, x) in a.iter().enumerate() {
        t += x * (1 + (i % 7)) as f64;
    }
    t
}

fn lists_json(l: &[Vec<usize>]) -> String {
    arr(l.iter().map(|f| arr(f.iter().map(|x| x.to_string()))))
}

fn pairs_json(l: &[[usize; 2]]) -> String {
    arr(l.iter().map(|f| format!("[{},{}]", f[0], f[1])))
}

/// A key's inputs written after its first '/', as JSON.
fn key_json(key: &str) -> Value {
    serde_json::from_str(key.split_once('/').expect("a key with inputs").1).expect("the key's JSON")
}

/// A JavaScript number from its text in a key ("2.5", "1000000000", "-3").
fn key_number(text: &str) -> f64 {
    text.parse::<f64>().expect("a number in a key")
}

/// The value of one line of the catalogue (the tool's `put(k, v)`), as JSON text. Panics on a key it does not
/// know, so that nothing is left out silently.
pub fn catalogue_value(key: &str) -> String {
    let head = key.split('/').next().unwrap_or("");
    match head {
        "constants" => obj(&[
            ("POLYHEDRA_TOL", n(ph::POLYHEDRA_TOL)),
            ("POLYHEDRA_MIN_QUATERNION_NORM", n(ph::POLYHEDRA_MIN_QUATERNION_NORM)),
            ("POLYHEDRA_MAX_COORD", n(ph::POLYHEDRA_MAX_COORD)),
            ("POLYHEDRA_MAX_QUATERNION", n(ph::POLYHEDRA_MAX_QUATERNION)),
            ("POLYHEDRA_MAX_SIZE", n(ph::POLYHEDRA_MAX_SIZE)),
            ("POLYHEDRA_MAX_P", ph::POLYHEDRA_MAX_P.to_string()),
            ("POLYHEDRA_RECORD_MARGIN", n(ph::POLYHEDRA_RECORD_MARGIN)),
            ("PAIR_COUNT", ph::pair_count().to_string()),
        ]),
        "solid_names_list" => arr(
            ph::SOLID_NAMES_LIST.iter().map(|x| arr([s(&x.name), s(&x.code), s(x.family.as_str()), s(&x.title)])),
        ),
        "solids_by_group" => arr(ph::SOLIDS_BY_GROUP.iter().map(|x| s(&x.code))),
        "solid_groups" => arr(ph::SOLID_NAMES_LIST.iter().map(|x| s(ph::solid_group(x.family)))),
        "plural_titles" => arr(ph::SOLID_NAMES_LIST.iter().map(|x| s(&ph::plural_title(&x.title)))),
        "problem_names" => arr(ph::PROBLEM_NAMES.iter().map(|p| name_row(Some(p.clone())))),
        "problem_codes" => strings(ph::PROBLEM_CODES.iter()),
        "problem_order" => strings(ph::PROBLEM_ORDER.iter()),
        "solid_names" => strings(ph::SOLID_NAMES.iter()),
        "johnson_solid_names" => strings(ph::JOHNSON_SOLID_NAMES.iter()),
        "is_solid_name" => arr(
            key_json(key).as_array().expect("names").iter().map(|x| ph::is_solid_name(x.as_str().unwrap()).to_string()),
        ),
        "solid_name_of_code" => arr(
            key_json(key).as_array().expect("codes").iter().map(|x| opt(ph::solid_name_of_code(x.as_str().unwrap()).map(s))),
        ),
        "solid" => {
            let x = ph::get_solid(key.split_once('/').unwrap().1).expect("a solid");
            obj(&[
                ("code", s(&x.code)),
                ("family", s(x.family.as_str())),
                ("title", s(&x.title)),
                ("nv", x.nv.to_string()),
                ("faces", x.faces.len().to_string()),
                ("edges", x.edges.len().to_string()),
                ("V", n(weighted(&x.v))),
                ("N", n(weighted(&x.n))),
                ("offsets", n(weighted(&x.offsets))),
                ("faceList", s(&fnv(&lists_json(&x.faces)))),
                ("edgeList", s(&fnv(&pairs_json(&x.edges)))),
                ("edgeFaces", s(&fnv(&pairs_json(&x.edge_faces)))),
                ("inradius", n(x.inradius)),
                ("circumradius", n(x.circumradius)),
                ("volume", n(x.volume)),
                ("tangential", x.tangential.to_string()),
                ("edgeMax", n(x.edge_max)),
            ])
        }
        "problem_name_of" | "problem_title" => {
            let rest = key.split_once('/').unwrap().1;
            // a code that is not plain is written as a JSON string
            let code: String = if rest.starts_with('"') { serde_json::from_str(rest).expect("a code") } else { rest.to_string() };
            if head == "problem_title" {
                s(&ph::problem_title(&code))
            } else {
                name_row(ph::problem_name_of(&code))
            }
        }
        "pair_code" => arr(key_json(key).as_array().expect("pairs").iter().map(|x| {
            opt(ph::pair_code(x[0].as_str().unwrap(), x[1].as_str().unwrap()).map(|c| s(&c)))
        })),
        "domain_info" => s(&serde_json::to_string(&ph::polyhedra_domain_info()).expect("the domain's JSON")),
        "domain_bound" => {
            let rest = key.split_once('/').unwrap().1;
            let (code, p) = rest.rsplit_once('/').expect("code/P");
            opt(ph::polyhedra_domain_bound(code, key_number(p)).map(|b| obj(&[("value", n(b.value)), ("label", s(&b.label))])))
        }
        "volume_bound" => {
            let rest = key.split_once('/').unwrap().1;
            let (code, p) = rest.rsplit_once('/').expect("code/P");
            n(ph::volume_bound(&ph::get_problem(code).expect("a pair"), key_number(p)).expect("two solids"))
        }
        "domain_sample" => {
            let limit: usize = key.split_once('/').unwrap().1.parse().expect("a limit");
            let ids = ph::polyhedra_domain_sample(limit);
            obj(&[
                ("length", ids.len().to_string()),
                ("first", strings(ids.iter().take(3))),
                ("last", strings(ids.iter().skip(ids.len().saturating_sub(2)))),
                ("hash", s(&fnv(&ids.join(",")))),
            ])
        }
        "config_errors" => {
            // the key carries [raw, P or null, maxErrors]
            let input = key_json(key);
            let p = input[1].as_u64().map(|x| x as usize);
            let max = input[2].as_u64().expect("maxErrors") as usize;
            arr(ph::config_errors(&input[0], p, max).iter().map(|e| s(e)))
        }
        _ => panic!("no rule for the catalogue line {key:?}"),
    }
}

/// One line of the catalogue: {"k": key, "v": value}.
pub fn catalogue_line(key: &str) -> String {
    format!("{{\"k\":{},\"v\":{}}}", s(key), catalogue_value(key))
}
