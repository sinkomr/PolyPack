//! What the Rust side answers to one case of the comparison (native/tools/ndim-ref.mts builds the
//! cases and writes the TypeScript's answers in the same form). Shared by the example `ndimdiff`,
//! which answers a whole case file, and by the fixture test.
#![allow(dead_code)]

use polypack_js::fmt;
use polypack_ndim::limits::LimitsOverride;
use polypack_ndim::polytope::{get_polytope, is_loaded, load_polytope, polytope_codes};
use polypack_ndim::space::{
    load_nd_problem, nd_bound_entry, nd_check, nd_check_ops, nd_check_steps, nd_in_range, nd_is_heavy, nd_lower_bound,
    nd_problem_of, nd_shape_names, ndim_domain_bound, ndim_domain_info_json, ndim_domain_sample, parse_nd_config,
    parse_nd_id_value, NdConfigShape, NdParsed, NdProblemId, ND_BALL, ND_ID_FORM, ND_MAX_P, NDIM_CHECK_MS,
    NDIM_HEAVY_OPS, NDIM_MAX_REASONS,
};
use polypack_ndim::{validate_nd, NdConfig, NdProblem, NdValidation, ValidateOptions};
use serde_json::{json, Value};

/// The two tolerances of the server: the touching tolerance and the strict one.
pub const TOLS: [f64; 2] = [1e-9, 1e-11];

/// A number as text (`String(x)` on the other side): every double has its own.
fn n(x: f64) -> Value {
    Value::String(fmt::num(x))
}

fn validation(v: &NdValidation) -> Value {
    json!({
        "valid": v.valid,
        "score": v.score.map(n),
        "reasons": v.reasons,
        "minWallGap": n(v.min_wall_gap),
        "minPairSep": n(v.min_pair_sep),
        "worstPair": v.worst_pair.map(|(i, j)| json!([i, j])),
        "pairsTested": v.pairs_tested,
    })
}

/// FNV-1a (64 bits) of the bytes of the doubles, little-endian.
fn hash(a: &[f64]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for x in a {
        for b in x.to_le_bytes() {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    format!("{h:016x}")
}

fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}

/// The problem id of a `check` or `cap` case.
pub fn problem_id(c: &Value) -> NdProblemId {
    NdProblemId {
        d: c["d"].as_u64().unwrap_or(0) as u32,
        piece: text(c, "piece"),
        container: text(c, "container"),
        p: c["P"].as_u64().unwrap_or(0) as u32,
    }
}

/// A configuration that the case holds as numbers (the `cap` and `core` cases).
fn typed_config(v: &Value) -> NdConfig {
    NdConfig {
        s: v["s"].as_f64().unwrap_or(f64::NAN),
        pieces: v["pieces"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|q| q.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// The parsed configuration of a `check` case, when it is well formed and its polytopes load (what
/// the timing runs on).
pub fn parsed(c: &Value) -> Option<(NdProblemId, NdConfigShape)> {
    if c["op"] != "check" {
        return None;
    }
    let p = problem_id(c);
    match parse_nd_config(&p, &c["raw"]) {
        Ok(NdParsed::Ok { config, .. }) => {
            load_nd_problem(p.d, &p.piece, &p.container).ok()?;
            Some((p, config))
        }
        _ => None,
    }
}

/// The answer to one case.
pub fn answer(c: &Value) -> Value {
    match c["op"].as_str().unwrap_or_default() {
        "check" => {
            let p = problem_id(c);
            let (config, score) = match parse_nd_config(&p, &c["raw"]) {
                Err(e) => return json!({ "thrown": e.0 }),
                Ok(NdParsed::Bad { malformed, errors }) => {
                    return json!({ "parse": { "ok": false, "malformed": malformed, "errors": errors } })
                }
                Ok(NdParsed::Ok { config, score }) => (config, score),
            };
            let pieces: Vec<Vec<Value>> = config.pieces.iter().map(|q| q.iter().map(|&x| n(x)).collect()).collect();
            let mut out = json!({ "parse": { "ok": true, "score": n(score), "s": n(config.s), "pieces": pieces } });
            if let Err(e) = load_nd_problem(p.d, &p.piece, &p.container) {
                out["load"] = json!(e.0);
                return out;
            }
            let checks: Vec<Value> = TOLS
                .iter()
                .map(|&tol| {
                    let reasons = match nd_check(&p, &config, tol, NDIM_MAX_REASONS) {
                        Ok(r) => r,
                        Err(e) => return json!({ "thrown": e.0 }),
                    };
                    let opts = ValidateOptions { tol: Some(tol), max_errors: Some(NDIM_MAX_REASONS), ..Default::default() };
                    match validate_nd(&nd_problem_of(p.d, &p.piece, &p.container), &config, &opts) {
                        Ok(v) => json!({ "reasons": reasons, "core": validation(&v) }),
                        Err(e) => json!({ "thrown": e.0 }),
                    }
                })
                .collect();
            out["checks"] = json!(checks);
            out
        }
        "cap" => {
            let p = problem_id(c);
            if let Err(e) = load_nd_problem(p.d, &p.piece, &p.container) {
                return json!({ "thrown": e.0 });
            }
            let config = typed_config(&c["config"]);
            let tick = c["tick"].as_f64().unwrap_or(1.0);
            let mut t = 0.0f64;
            let mut readings = 0u64;
            let mut clock = || {
                let v = t;
                t += tick;
                readings += 1;
                v
            };
            let reasons = nd_check_steps(
                &p,
                &config,
                c["tol"].as_f64().unwrap_or(1e-9),
                c["maxErrors"].as_u64().unwrap_or(0) as usize,
                c["capMs"].as_f64().unwrap_or(0.0),
                &mut clock,
            );
            match reasons {
                // the source reads its clock twice per step (before and after), and yields after every step but the last
                Ok(reasons) => json!({ "reasons": reasons, "yields": readings / 2 - 1 }),
                Err(e) => json!({ "thrown": e.0 }),
            }
        }
        "core" => {
            let pr = &c["problem"];
            let problem =
                NdProblem { d: pr["d"].as_i64().unwrap_or(0), piece: text(pr, "piece"), container: text(pr, "container") };
            if c["load"] == true {
                for code in [&problem.piece, &problem.container] {
                    if code != "ball" {
                        let _ = load_polytope(code); // an unknown code: the validator says so
                    }
                }
            }
            let o = &c["opts"];
            let limits = o.get("limits").map(|l| LimitsOverride {
                max_pieces: l["maxPieces"].as_f64(),
                max_vertex_work: l["maxVertexWork"].as_f64(),
                max_wall_work: l["maxWallWork"].as_f64(),
            });
            let opts = ValidateOptions {
                tol: o["tol"].as_f64(),
                max_errors: o["maxErrors"].as_u64().map(|v| v as usize),
                max_pair_errors: o["maxPairErrors"].as_u64().map(|v| v as usize),
                limits,
                deadline: o["deadline"].as_f64(),
            };
            match validate_nd(&problem, &typed_config(&c["config"]), &opts) {
                Ok(v) => json!({ "core": validation(&v) }),
                Err(e) => json!({ "thrown": e.0 }),
            }
        }
        "id" => match parse_nd_id_value(&c["value"]) {
            Err(e) => json!({ "error": e }),
            Ok(r) => json!({
                "id": r.id, "d": r.d, "piece": r.piece, "container": r.container, "P": r.p, "inRange": nd_in_range(r.d, r.p),
            }),
        },
        "bound" => {
            let d = c["d"].as_u64().unwrap_or(0) as u32;
            let (piece, container) = (text(c, "piece"), text(c, "container"));
            let rows: Vec<Value> = (1..=ND_MAX_P + 1)
                .map(|p| {
                    let id = NdProblemId { d, piece: piece.clone(), container: container.clone(), p };
                    let dom = ndim_domain_bound(d, &piece, &container, p);
                    let lower = match (nd_lower_bound(d, &piece, &container, p), nd_bound_entry(d, &piece, &container, p)) {
                        (Ok(b), Ok(e)) => {
                            json!({ "value": n(b.value), "kind": b.kind.as_str(), "entry": n(e.value), "label": e.label })
                        }
                        (Err(e), _) | (_, Err(e)) => json!({ "thrown": e.0 }),
                    };
                    json!({
                        "P": p,
                        "inRange": nd_in_range(d, p),
                        "domain": dom.map(|b| json!({ "value": n(b.value), "label": b.label })),
                        "lower": lower,
                        "ops": n(nd_check_ops(&id)),
                        "heavy": nd_is_heavy(&id),
                    })
                })
                .collect();
            json!({ "rows": rows })
        }
        "domain" => {
            let samples: Vec<Vec<String>> =
                [0usize, 1, 7, 50, 245, 246, 1000, 7000].iter().map(|&k| ndim_domain_sample(k)).collect();
            json!({
            "info": ndim_domain_info_json(),
            "samples": samples,
            "constants": {
                "ND_MAX_P": ND_MAX_P,
                "NDIM_MAX_REASONS": NDIM_MAX_REASONS,
                "NDIM_CHECK_MS": NDIM_CHECK_MS,
                "NDIM_HEAVY_OPS": NDIM_HEAVY_OPS,
                "ND_ID_FORM": ND_ID_FORM,
                "ND_SHAPE_NAMES": nd_shape_names(),
                "ND_BALL": ND_BALL,
            },
            "codes": polytope_codes(),
        })
        }
        "table" => {
            let code = text(c, "code");
            let mut out = json!({ "loadedBefore": is_loaded(&code) });
            if c["load"] != true {
                out["get"] = match get_polytope(&code) {
                    Ok(_) => json!("ok"),
                    Err(e) => json!(e.0),
                };
                return out;
            }
            match load_polytope(&code) {
                Ok(p) => {
                    out["polytope"] = json!({
                        "code": p.code, "d": p.d, "name": p.name, "title": p.title, "nV": p.n_v, "nE": p.n_e, "nF": p.n_f,
                        "inradius": n(p.inradius), "circumradius": n(p.circumradius), "volume": n(p.volume),
                        "V": hash(&p.v), "N": hash(&p.n), "b": hash(&p.b), "lengths": [p.v.len(), p.n.len(), p.b.len()],
                    });
                    out["loadedAfter"] = json!(is_loaded(&code));
                }
                Err(e) => out["thrown"] = json!(e.0),
            }
            out
        }
        "load" => match load_nd_problem(c["d"].as_u64().unwrap_or(0) as u32, &text(c, "piece"), &text(c, "container")) {
            Ok(()) => json!({ "ok": true }),
            Err(e) => json!({ "thrown": e.0 }),
        },
        other => panic!("unknown op {other}"),
    }
}

/// What is not the same in two answers (the place and the two values), or None when the port's answer is the
/// TypeScript's exactly: the same structure, booleans, counts and texts. Every number of an answer is written as its
/// own text (`String(x)`), so equal texts are equal doubles, and a number inside a message is its digits.
///
/// One exception, and it is named here: a bound that went through `Math.pow` with an exponent other than 2 and 0.5.
/// The volume bound of `ndLowerBound` is `Math.pow(P vol(piece) / vol(container), 1 / d)`
/// (packages/ndspace/src/bounds.ts). Node calls the C library's `pow`, which is not correctly rounded;
/// `polypack_js::math::pow` is (native/PORTING.md, "Differences that are meant"). So in the answer of a `bound` case
/// (`pow_bounds` true), where a row's lower bound is of the kind "volume", its `value`, its `entry` (the value times
/// 1 - 1e-12) and the domain's `value` that quotes it may be the neighbouring double: one unit in the last place, no
/// more. `pow_differences` counts the numbers that used the exception.
pub fn difference(a: &Value, b: &Value, pow_bounds: bool, pow_differences: &mut usize) -> Option<String> {
    walk(a, b, "", pow_bounds, pow_differences)
}

/// Two doubles from their texts that are the same or neighbours: one unit in the last place apart.
fn neighbours(x: &str, y: &str) -> bool {
    match (x.parse::<f64>(), y.parse::<f64>()) {
        (Ok(p), Ok(q)) => p.is_finite() && q.is_finite() && p.is_sign_negative() == q.is_sign_negative() && p.to_bits().abs_diff(q.to_bits()) <= 1,
        _ => false,
    }
}

fn walk(a: &Value, b: &Value, path: &str, pow_bounds: bool, pow_differences: &mut usize) -> Option<String> {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{path}: {} entries | {}", x.len(), y.len()));
            }
            x.iter().zip(y).enumerate().find_map(|(i, (p, q))| walk(p, q, &format!("{path}[{i}]"), pow_bounds, pow_differences))
        }
        (Value::Object(x), Value::Object(y)) => {
            if x.len() != y.len() || x.keys().any(|k| !y.contains_key(k)) {
                return Some(format!("{path}: other fields: {a} | {b}"));
            }
            // a volume bound, here or quoted by the domain: the fields that hold a result of Math.pow(x, 1 / d)
            let volume = pow_bounds
                && ((path.ends_with(".lower") && x.get("kind").and_then(Value::as_str) == Some("volume") && y.get("kind").and_then(Value::as_str) == Some("volume"))
                    || (path.ends_with(".domain") && [x, y].iter().all(|o| o.get("label").and_then(Value::as_str).is_some_and(|l| l.starts_with("volume bound")))));
            for (k, p) in x {
                let q = &y[k];
                if p == q {
                    continue;
                }
                if volume && (k == "value" || k == "entry") {
                    if let (Some(s), Some(t)) = (p.as_str(), q.as_str()) {
                        if neighbours(s, t) {
                            *pow_differences += 1;
                            continue;
                        }
                    }
                }
                if let Some(d) = walk(p, q, &format!("{path}.{k}"), pow_bounds, pow_differences) {
                    return Some(d);
                }
            }
            None
        }
        _ if a == b => None,
        _ => Some(format!("{path}: {a} | {b}")),
    }
}
