//! The port against the TypeScript's own verdicts, without Node: the fixtures were written by
//! native/tools/boundary-ref.mts (mode `fixtures`) from the full comparison's cases.

mod common;

use common::{check, extra, outcome_json, read_case};
use polypack_boundary::pieces::{build_piece_shape, piece_shape, POLYTOPE_PIECES};
use polypack_boundary::polytope::{build_catalogue_polytope, get_polytope};
use polypack_boundary::types::{CONTAINERS, POLYTOPES};
use serde_json::Value;

fn lines(text: &str) -> Vec<Value> {
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).expect("a JSON line")).collect()
}

/// The numbers of a text, and the text with each replaced by '#'.
fn split_numbers(text: &str) -> (String, Vec<f64>) {
    let b = text.as_bytes();
    let mut out = String::new();
    let mut numbers = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        let mut j = i;
        if b[j] == b'-' && j + 1 < b.len() && b[j + 1].is_ascii_digit() {
            j += 1;
        }
        if j < b.len() && b[j].is_ascii_digit() {
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j + 1 < b.len() && b[j] == b'.' && b[j + 1].is_ascii_digit() {
                j += 1;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
            }
            if j < b.len() && b[j] == b'e' {
                let mut k = j + 1;
                if k < b.len() && (b[k] == b'-' || b[k] == b'+') {
                    k += 1;
                }
                if k < b.len() && b[k].is_ascii_digit() {
                    while k < b.len() && b[k].is_ascii_digit() {
                        k += 1;
                    }
                    j = k;
                }
            }
            numbers.push(text[start..j].parse::<f64>().expect("a number"));
            out.push('#');
            i = j;
        } else {
            // (multi-byte characters pass through byte by byte: the texts compared are the same on both sides)
            out.push(b[i] as char);
            i += 1;
        }
    }
    (out, numbers)
}

fn close(x: f64, y: f64) -> bool {
    x == y || (x - y).abs() <= 1e-12 || (x - y).abs() <= 1e-6 * x.abs().max(y.abs())
}

/// The comparison of native/tools/boundary-compare.mjs: identical, or equal up to the last digits of the numbers in the reasons.
fn same_run(a: &Value, b: &Value) -> Result<bool, String> {
    // numbers are compared as doubles (JSON writes 1 where Rust holds 1.0), everything else as it is
    let field = |v: &Value, k: &str| -> Value {
        match v.get(k) {
            Some(Value::Number(n)) => Value::String(format!("{:?}", n.as_f64().unwrap().to_bits())),
            Some(x) => x.clone(),
            None => Value::Null,
        }
    };
    for k in ["tol", "throw", "ok", "score", "steps", "ops"] {
        if field(a, k) != field(b, k) {
            return Err(format!("{k}: {:?} against {:?}", a.get(k), b.get(k)));
        }
    }
    if a.get("throw").is_some() {
        return Ok(true);
    }
    let (ra, rb) = (a["reasons"].as_array().unwrap(), b["reasons"].as_array().unwrap());
    if ra.len() != rb.len() {
        return Err(format!("{} reasons against {}", ra.len(), rb.len()));
    }
    let mut identical = true;
    for (x, y) in ra.iter().zip(rb) {
        if x == y {
            continue;
        }
        identical = false;
        let (tx, nx) = split_numbers(x.as_str().unwrap());
        let (ty, ny) = split_numbers(y.as_str().unwrap());
        if tx != ty || nx.len() != ny.len() || nx.iter().zip(&ny).any(|(p, q)| !close(*p, *q)) {
            return Err(format!("reason {x} against {y}"));
        }
    }
    Ok(identical)
}

#[test]
fn the_validator_gives_the_verdicts_of_the_typescript() {
    let cases = lines(include_str!("fixtures/cases.jsonl"));
    assert!(cases.len() >= 24, "only {} fixture cases", cases.len());
    let mut identical = 0;
    let mut runs = 0;
    for v in &cases {
        let c = read_case(v);
        let expected = v["runs"].as_array().expect("the TypeScript's runs");
        assert_eq!(expected.len(), c.tols.len());
        for (k, &tol) in c.tols.iter().enumerate() {
            let got = outcome_json(tol, &check(&c, tol));
            match same_run(&expected[k], &got) {
                Ok(same) => identical += same as usize,
                Err(why) => panic!("case {} ({}) at tolerance {}: {}", c.id, v["kind"], tol, why),
            }
            runs += 1;
        }
    }
    println!("{runs} runs of {} cases, {identical} identical byte for byte", cases.len());
    // (when the fixtures were written every run was identical; native/PORTING.md allows the last digits of a number to differ)
}

/// Do two results agree: the same structure and texts, and numbers that are the same double (or, for the bounds whose
/// formulas use cbrt and pow, the neighbouring one)?
fn agree(a: &Value, b: &Value, ulps: bool) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            x == y || (ulps && (x - y).abs() <= 4.0 * f64::EPSILON * x.abs().max(y.abs()))
        }
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| agree(p, q, ulps)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).is_some_and(|q| agree(p, q, ulps))),
        _ => a == b,
    }
}

#[test]
fn the_other_functions_give_the_results_of_the_typescript() {
    let extras = lines(include_str!("fixtures/extras.jsonl"));
    assert!(extras.len() >= 100);
    for q in &extras {
        let mut got = extra(q);
        let name = q["fn"].as_str().unwrap();
        if name == "domainInfo" {
            // as text, so that the order of the fields is compared too
            assert_eq!(got.as_str().unwrap(), q["out"].as_str().unwrap(), "the domain's description");
            continue;
        }
        if name == "checkMs" {
            // a product of two doubles: the same on both sides
            got = serde_json::from_str(&got.to_string()).unwrap();
        }
        // ballBounds and pieceBounds (and the domain's bounds that quote them) go through Math.cbrt, ndBoundKind through Math.pow
        let ulps = matches!(name, "ballBounds" | "pieceBounds" | "bound");
        assert!(agree(&q["out"], &got, ulps), "{q}: {got}");
    }
}

fn numbers(v: &Value, out: &mut Vec<f64>, shape: &mut String) {
    match v {
        Value::Number(n) => {
            out.push(n.as_f64().unwrap());
            shape.push('#');
        }
        Value::Array(a) => {
            shape.push('[');
            for x in a {
                numbers(x, out, shape);
            }
            shape.push(']');
        }
        Value::Object(o) => {
            shape.push('{');
            for (k, x) in o {
                shape.push_str(k);
                numbers(x, out, shape);
            }
            shape.push('}');
        }
        other => shape.push_str(&other.to_string()),
    }
}

/// The largest difference between the numbers of two tables of one shape; None when the shapes differ.
/// Integers (indices, counts) must be equal: a difference of 1 or more fails the callers' bound.
fn largest_difference(a: &Value, b: &Value) -> Option<f64> {
    let (mut na, mut nb, mut sa, mut sb) = (Vec::new(), Vec::new(), String::new(), String::new());
    numbers(a, &mut na, &mut sa);
    numbers(b, &mut nb, &mut sb);
    if sa != sb {
        return None;
    }
    Some(na.iter().zip(&nb).map(|(x, y)| (x - y).abs()).fold(0.0, f64::max))
}

#[test]
fn the_ported_builder_gives_the_polytopes_of_the_tables() {
    // hull.rs and polytope.rs (build_polytope) against the tables the TypeScript wrote: the same cells, facets, gluings and
    // edges, and numbers equal up to the rounding of atan2, cos and sin
    for name in POLYTOPES {
        let table = common::polytope_json(get_polytope(name).unwrap());
        let built = common::polytope_json(&build_catalogue_polytope(name).unwrap());
        let d = largest_difference(&table, &built).unwrap_or_else(|| panic!("{name}: the built polytope has another structure"));
        assert!(d < 1e-12, "{name}: the built polytope differs by {d}");
    }
}

#[test]
fn the_ported_builder_gives_the_pieces_of_the_table() {
    for name in POLYTOPE_PIECES {
        let table = common::piece_json(piece_shape(name).unwrap());
        let built = common::piece_json(&build_piece_shape(name).unwrap());
        let d = largest_difference(&table, &built).unwrap_or_else(|| panic!("{name}: the built piece has another structure"));
        assert!(d < 1e-14, "{name}: the built piece differs by {d}");
    }
}

#[test]
fn the_catalogue_is_the_source_s() {
    // CONTAINERS = [...POLYTOPES, ...NCUBE_NAMES, ...ND_NAMES], ND_NAMES = families x dimensions
    let mut names: Vec<String> = POLYTOPES.iter().map(|s| s.to_string()).collect();
    names.extend(polypack_boundary::NCUBE_NAMES.iter().map(|s| s.to_string()));
    for family in polypack_boundary::ND_FAMILIES {
        for d in polypack_boundary::nd::names::ND_DIMS {
            names.push(format!("{d}{family}"));
        }
    }
    assert_eq!(names, CONTAINERS);
    assert_eq!(&names[12..], polypack_boundary::ND_NAMES);
    assert_eq!(get_polytope("600cell").unwrap().cells.len(), 600);
    assert_eq!(get_polytope("120cell").unwrap().vertices.len(), 600);
    assert!(get_polytope("8cell").is_err());
}

#[test]
fn a_typed_configuration_is_checked_as_its_json() {
    use polypack_boundary::{validate_boundary_config, BoundaryConfig, BoundaryError, BoundaryPiece, BoundaryProblem, ValidateOptions};
    // the server's limits (packages/spaces/src/validate.ts: MAX_REASONS 20, BOUNDARY_MAX_CHAINS 1024)
    let server = |tol: f64| ValidateOptions { tol: Some(tol), max_reasons: Some(20.0), max_chains: Some(1024.0), ..Default::default() };
    // the research record of boundary/tesseract/ball/1
    let record = BoundaryConfig { s: 0.7071067811872548, pieces: vec![BoundaryPiece { cell: 0, u: vec![0.0, 0.0, 0.0], q: None }] };
    let problem = BoundaryProblem::new("tesseract", "ball", 1);
    for tol in [1e-9, 1e-11] {
        let v = validate_boundary_config(&problem, &record, &server(tol)).unwrap();
        assert!(v.ok && v.reasons.is_empty());
        assert_eq!(v.score, Some(record.s));
    }
    // a tolerance that is none is the caller's mistake: the source's RangeError
    let thrown = validate_boundary_config(&problem, &record, &server(-1.0));
    assert_eq!(thrown, Err(BoundaryError::Range("validateBoundary: tol must be a finite number >= 0, not -1".to_string())));
    // a turned cube is not a cube of the tesseract's problem; the same cube on the 16-cell is checked
    let turned = BoundaryConfig { s: 5.0, pieces: vec![BoundaryPiece { cell: 0, u: vec![0.0, 0.0, 0.0], q: Some([0.3f64.cos(), 0.3f64.sin(), 0.0, 0.0]) }] };
    let v = validate_boundary_config(&BoundaryProblem::new("tesseract", "cube", 1), &turned, &server(1e-9)).unwrap();
    assert_eq!(v.reasons, ["Piece 0: the cubes of the tesseract are axis-aligned; q must be absent or a rotation that maps the cube onto itself (one of its 24 symmetries), not a turned cube."]);
    let v = validate_boundary_config(&BoundaryProblem::new("16cell", "cube", 1), &turned, &server(1e-9)).unwrap();
    assert!(v.ok, "{:?}", v.reasons);
    // a number that is not finite reads as JavaScript's NaN does
    let nan = BoundaryConfig { s: f64::NAN, pieces: vec![] };
    let v = validate_boundary_config(&problem, &nan, &server(1e-9)).unwrap();
    assert_eq!(v.reasons, ["The edge s must be a finite number.", "The configuration has 0 pieces; the problem needs exactly 1."]);
}

#[test]
fn the_cube_roots_of_the_bounds_are_node_s() {
    // The bounds of bounds.rs are cube roots that the server shows and compares sizes with, so they need Math.cbrt bit for
    // bit: V8's (FreeBSD's s_cbrt.c, accurate to 0.667 units in the last place) differs from a correctly rounded cube root
    // for about one argument in seven. [x, Math.cbrt(x)] from Node 26 (V8 14.6), 1,507 arguments.
    let vectors: Vec<(f64, f64)> = serde_json::from_str(include_str!("fixtures/cbrt.json")).unwrap();
    assert!(vectors.len() > 1000);
    for (x, y) in &vectors {
        assert_eq!(polypack_js::math::cbrt(*x).to_bits(), y.to_bits(), "cbrt({x})");
    }
}
