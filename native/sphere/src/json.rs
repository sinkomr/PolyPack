//! The JSON of the comparison with the TypeScript (`native/tools/sphere-ref.mts`,
//! `examples/spherediff.rs`, `tests/fixtures.rs`): how a case is read and a result written.
//!
//! JSON has no NaN and no infinities, and the cases need them (a validator must refuse them), so a
//! number may be written as one of the strings "NaN", "Infinity", "-Infinity". Both sides write
//! results the same way.

use crate::geometry::{area_bound, placed_vertices, SphereConfig, SpherePiece, SphereProblem, Vec3};
use crate::hull::hull_faces;
use crate::server::check;
use crate::validate::{max_margin_plane, validation_steps, PairGap, ValidateOptions, ValidationResult};
use serde_json::{json, Value};

/// The server's MAX_REASONS (packages/spaces/src/validate.ts): the `maxErrors` it passes.
pub const MAX_REASONS: usize = 20;

/// A number of a case: a JSON number, or "NaN", "Infinity", "-Infinity".
pub fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().expect("a double"),
        Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => panic!("not a number: {other}"),
        },
        other => panic!("not a number: {other}"),
    }
}

/// A number of a result, written so that it reads back as the same double.
pub fn enc(x: f64) -> Value {
    if x.is_nan() {
        json!("NaN")
    } else if x == f64::INFINITY {
        json!("Infinity")
    } else if x == f64::NEG_INFINITY {
        json!("-Infinity")
    } else {
        json!(x)
    }
}

/// A case `{ N, P, config: { rho, pieces: [{ q: [...] }] } }`.
pub fn case_of(v: &Value) -> (SphereProblem, SphereConfig) {
    let problem = SphereProblem {
        n: num(&v["N"]),
        p: num(&v["P"]),
    };
    let c = &v["config"];
    let pieces = c["pieces"]
        .as_array()
        .expect("pieces")
        .iter()
        .map(|p| SpherePiece {
            q: p["q"].as_array().expect("q").iter().map(num).collect(),
        })
        .collect();
    (
        problem,
        SphereConfig {
            rho: num(&c["rho"]),
            pieces,
        },
    )
}

/// The pairs of a result that the comparison keeps, each as `[at, i, j, kind, gap, normal]` with
/// `at` its place in the list: all of them up to 600; beyond that every `stride`-th,
/// `stride = ceil(count / 400)` (a check of 100 pieces has 4,950), and every pair whose gap is
/// within 1e-9 of the smallest (the pairs that can be the worst one).
pub fn kept_pairs(pairs: &[PairGap], min_gap: f64) -> Vec<Value> {
    let stride = if pairs.len() <= 600 {
        1
    } else {
        pairs.len().div_ceil(400)
    };
    pairs
        .iter()
        .enumerate()
        .filter(|(at, g)| at % stride == 0 || g.gap <= min_gap + 1e-9)
        .map(|(at, g)| {
            let normal = match g.normal {
                Some(n) => json!([enc(n[0]), enc(n[1]), enc(n[2])]),
                None => Value::Null,
            };
            json!([at, g.i, g.j, g.kind.as_str(), enc(g.gap), normal])
        })
        .collect()
}

/// A `ValidationResult` as the reference tool writes the TypeScript's.
pub fn result_json(v: &ValidationResult) -> Value {
    let count = |kind: &str| v.pairs.iter().filter(|g| g.kind.as_str() == kind).count();
    json!({
        "valid": v.valid,
        "strictlyValid": v.strictly_valid,
        "minGap": enc(v.min_gap),
        "worstPair": v.worst_pair.map(|(i, j)| json!([i, j])),
        "errors": v.errors,
        "npairs": v.pairs.len(),
        "kinds": { "far": count("far"), "plane": count("plane"), "disk": count("disk") },
        "pairs": kept_pairs(&v.pairs, v.min_gap),
    })
}

/// What the comparison records of a case, as the reference tool does: the validator's result at
/// 1e-9 and 1e-11 as the server calls it (`t9`, `t11`), the reasons of `check` at both (`r9`,
/// `r11`), and the validator's result with no options (`v0`) when the case has at most 30 pieces.
pub fn case_line(v: &Value) -> Value {
    let (problem, config) = case_of(v);
    let at = |tol: f64| {
        validation_steps(
            &problem,
            &config,
            &ValidateOptions {
                tol: Some(tol),
                max_errors: Some(MAX_REASONS as f64),
            },
        )
    };
    let mut line = json!({
        "id": v["id"],
        "t9": result_json(&at(1e-9)),
        "t11": result_json(&at(1e-11)),
        "r9": check(problem.n, problem.p, &config, 1e-9, MAX_REASONS),
        "r11": check(problem.n, problem.p, &config, 1e-11, MAX_REASONS),
    });
    if config.pieces.len() <= 30 {
        line["v0"] = result_json(&validation_steps(&problem, &config, &ValidateOptions::default()));
    }
    line
}

fn points(v: &Value) -> Vec<Vec3> {
    v.as_array()
        .expect("points")
        .iter()
        .map(|p| [num(&p[0]), num(&p[1]), num(&p[2])])
        .collect()
}

/// The result of an auxiliary case `{ fn, ... }`: one of the package's other functions on its own
/// input, as the reference tool writes it.
pub fn aux_result(v: &Value) -> Value {
    match v["fn"].as_str().expect("fn") {
        // areaBound(N, P) for P = 1..100
        "areaBound" => {
            let n = num(&v["N"]);
            json!((1..=100).map(|p| enc(area_bound(n, p as f64))).collect::<Vec<_>>())
        }
        "hullFaces" => json!(hull_faces(&points(&v["S"]))),
        "maxMarginPlane" => {
            let m = max_margin_plane(&points(&v["A"]), &points(&v["B"]));
            json!({ "value": enc(m.value), "normal": [enc(m.normal[0]), enc(m.normal[1]), enc(m.normal[2])] })
        }
        // the vertices of a placed piece, as one list of numbers
        "placedVertices" => {
            let q = [num(&v["q"][0]), num(&v["q"][1]), num(&v["q"][2]), num(&v["q"][3])];
            json!(placed_vertices(num(&v["N"]) as usize, num(&v["rho"]), &q)
                .iter()
                .flatten()
                .map(|x| enc(*x))
                .collect::<Vec<_>>())
        }
        other => panic!("unknown function {other}"),
    }
}

/// How two results agree, by the rule of the comparison (native/PORTING.md).
#[derive(Clone, Debug, PartialEq)]
pub enum Agreement {
    /// every boolean, index, count, string and number is the same (numbers bit for bit, 0 and -0 alike)
    Identical,
    /// the same but for the last digits of numbers: they agree to 1e-6 relative or 1e-12 absolute,
    /// and messages are equal once each number in them is replaced by a placeholder and those
    /// numbers agree likewise
    Close,
    /// anything else, with the place of the first difference
    Different(String),
}

fn near(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a == b || (a - b).abs() <= 1e-12 || (a - b).abs() <= 1e-6 * a.abs().max(b.abs())
}

/// A number of a result, if the value is one (a JSON number or one of the three strings).
fn number_of(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if matches!(s.as_str(), "NaN" | "Infinity" | "-Infinity") => Some(num(v)),
        _ => None,
    }
}

/// A message with each number replaced by '#', and the numbers: -?(digits[.digits][e[+-]digits] | Infinity) | NaN.
fn message_numbers(s: &str) -> (String, Vec<f64>) {
    let b = s.as_bytes();
    let mut text = String::new();
    let mut numbers = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        let mut j = i;
        if b[j] == b'-' {
            j += 1;
        }
        let word = |at: usize, w: &str| s[at..].starts_with(w);
        let end = if j < b.len() && b[j].is_ascii_digit() {
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j < b.len() && b[j] == b'.' {
                j += 1;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
            }
            if j < b.len() && b[j] == b'e' {
                let mut k = j + 1;
                if k < b.len() && (b[k] == b'+' || b[k] == b'-') {
                    k += 1;
                }
                if k < b.len() && b[k].is_ascii_digit() {
                    while k < b.len() && b[k].is_ascii_digit() {
                        k += 1;
                    }
                    j = k;
                }
            }
            Some(j)
        } else if word(j, "Infinity") {
            Some(j + 8)
        } else if j == start && word(j, "NaN") {
            Some(j + 3)
        } else {
            None
        };
        match end {
            Some(end) => {
                let token = s[start..end].trim_end_matches('.');
                numbers.push(match token {
                    "NaN" => f64::NAN,
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    t => t.parse().expect("a number"),
                });
                text.push('#');
                i = end;
            }
            None => {
                let ch = s[i..].chars().next().unwrap();
                text.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    (text, numbers)
}

/// Compares the reference's value `a` with the port's `b`.
pub fn agreement(a: &Value, b: &Value) -> Agreement {
    fn walk(a: &Value, b: &Value, path: &str, close: &mut bool) -> Result<(), String> {
        if let (Some(x), Some(y)) = (number_of(a), number_of(b)) {
            if (x.is_nan() && y.is_nan()) || x == y {
                return Ok(());
            }
            if near(x, y) {
                *close = true;
                return Ok(());
            }
            return Err(format!("{path}: {x:e} / {y:e}"));
        }
        match (a, b) {
            (Value::String(x), Value::String(y)) => {
                if x == y {
                    return Ok(());
                }
                let ((tx, nx), (ty, ny)) = (message_numbers(x), message_numbers(y));
                if tx == ty && nx.len() == ny.len() && nx.iter().zip(&ny).all(|(p, q)| near(*p, *q)) {
                    *close = true;
                    return Ok(());
                }
                Err(format!("{path}: {x} / {y}"))
            }
            (Value::Array(x), Value::Array(y)) => {
                if x.len() != y.len() {
                    return Err(format!("{path}: {} / {} elements", x.len(), y.len()));
                }
                for (k, (p, q)) in x.iter().zip(y).enumerate() {
                    walk(p, q, &format!("{path}[{k}]"), close)?;
                }
                Ok(())
            }
            (Value::Object(x), Value::Object(y)) => {
                for (k, p) in x {
                    match y.get(k) {
                        Some(q) => walk(p, q, &format!("{path}.{k}"), close)?,
                        None => return Err(format!("{path}.{k}: missing in the port's result")),
                    }
                }
                match y.keys().find(|k| !x.contains_key(*k)) {
                    Some(k) => Err(format!("{path}.{k}: missing in the reference")),
                    None => Ok(()),
                }
            }
            _ if a == b => Ok(()),
            _ => Err(format!("{path}: {a} / {b}")),
        }
    }
    let mut close = false;
    match walk(a, b, "", &mut close) {
        Err(place) => Agreement::Different(place),
        Ok(()) if close => Agreement::Close,
        Ok(()) => Agreement::Identical,
    }
}
