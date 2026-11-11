//! The Rust side of the comparison with the TypeScript (native/tools/flat-ref.mts): what the port
//! computes for one case of cases.jsonl or one call of calls.jsonl, as the JSON the reference
//! writes for it, field for field. Shared by the `serverdiff` example, which runs every case, and
//! by `tests/fixtures.rs`, which checks the sample kept in `tests/fixtures`.

#![allow(dead_code)]

use polypack_flat::config::{evaluate, parse_config, strict_verify, EvaluateOptions, PackingConfig, StrictResult, STRICT_EPS};
use polypack_flat::enclose::{auto_orient_set, convex_hull, enclose_set, enclosing_circle, enclosing_polygon, PointSet};
use polypack_flat::overlap::{
    circle_separation, find_overlaps, pair_separation, piece_separation, piece_separation_below, polygon_circle_separation,
    polygon_separation, regular_polygon_overlap, regular_polygon_separation, separation_below, Contact, Overlap,
};
use polypack_flat::protocol::{
    beats_literature, closed_to_submissions, event_keys, improves_on, is_proven, literature_tolerance, reaches_literature,
    LiteratureRecord, Provenance,
};
use polypack_flat::provenance::parse_provenance;
use polypack_flat::shapes::{
    area_lower_bound, bounding_radius, circumradius, container_area, container_inradius, container_vertices, inradius, piece_area,
    piece_inradius, piece_vertices, shape_code, Container, Pose, DISK_RADIUS,
};
use serde_json::{json, Map, Value};

/// The methods the reference passes to parseProvenance for a case.
pub const METHODS: [&str; 4] = ["basin-hopping", "ls-growth", "penalty", "harden"];

/// What POST /api/submit passes to evaluate.
pub fn server_options() -> EvaluateOptions {
    EvaluateOptions::server(20)
}

fn container_out(k: Option<Container>) -> Value {
    match k {
        Some(k) => json!({ "M": k.m, "cx": k.cx, "cy": k.cy, "phi": k.phi, "size": k.size }),
        None => Value::Null,
    }
}

/// Every pair in order through a running hash, the first 40 in full, the sum of the depths, and
/// the pairs within 1e-12 of the deepest (at most 60).
fn overlaps_out(list: &[Overlap]) -> Value {
    let mut hash: u64 = 7;
    let mut sum = 0.0;
    let mut min = f64::INFINITY;
    for o in list {
        hash = (hash * 31 + o.i as u64 * 1009 + o.j as u64) % 2147483647;
        sum += o.sep;
        if o.sep < min {
            min = o.sep;
        }
    }
    let pair = |o: &Overlap| json!([o.i, o.j, o.sep]);
    let first: Vec<Value> = list.iter().take(40).map(pair).collect();
    let deepest: Vec<Value> = list.iter().filter(|o| o.sep <= min + 1e-12).take(60).map(pair).collect();
    json!({ "count": list.len(), "hash": hash, "sum": sum, "first": first, "deepest": deepest })
}

fn strict_out(s: &StrictResult) -> Value {
    json!({ "ok": s.ok, "certifiedSize": s.certified_size, "eps": s.eps, "reason": s.reason })
}

fn provenance_out(r: Result<Provenance, Vec<String>>) -> Value {
    match r {
        Ok(p) => {
            let budget = p.budget.map(|b| {
                let mut o = Map::new();
                if let Some(v) = b.evals {
                    o.insert("evals".into(), json!(v));
                }
                if let Some(v) = b.time_s {
                    o.insert("time_s".into(), json!(v));
                }
                Value::Object(o)
            });
            json!({ "ok": true, "provenance": {
                "found_with": p.found_with.map(|f| f.as_str()),
                "method": p.method,
                "method_params": p.method_params,
                "seed": p.seed,
                "budget": budget,
                "software": p.software,
            } })
        }
        Err(errors) => json!({ "ok": false, "errors": errors }),
    }
}

/// The configuration of a case, when its body parses (for the timings).
pub fn config_of(case: &Value) -> Option<PackingConfig> {
    if case.get("text").is_some() {
        return None;
    }
    parse_config(case.get("body").unwrap_or(&Value::Null)).ok()
}

/// One case of cases.jsonl: `runCase` of flat-ref.mts.
pub fn run_case(case: &Value) -> Value {
    let id = &case["id"];
    let parsed_text;
    let body: &Value = match case.get("text") {
        Some(text) => match serde_json::from_str::<Value>(text.as_str().unwrap()) {
            Ok(v) => {
                parsed_text = v;
                &parsed_text
            }
            Err(_) => return json!({ "id": id, "json_ok": false }),
        },
        None => case.get("body").unwrap_or(&Value::Null),
    };
    let mut out = Map::new();
    out.insert("id".into(), id.clone());
    out.insert("json_ok".into(), json!(true));
    let parsed = parse_config(body);
    out.insert(
        "parse".into(),
        match &parsed {
            Ok(c) => {
                let first: Vec<Value> = c.pieces.iter().take(3).map(|p| json!([p.x, p.y, p.theta])).collect();
                json!({ "ok": true, "N": c.n, "M": c.m, "P": c.p, "pieces": c.pieces.len(), "container_phi": c.container_phi,
                    "name": c.name, "agent_note": c.agent_note, "first": first })
            }
            Err(errors) => json!({ "ok": false, "errors": errors }),
        },
    );
    // as the route does: how the packing was found is read from the same body, when it is an object
    out.insert(
        "provenance".into(),
        match body {
            Value::Object(o) => provenance_out(parse_provenance(o, &METHODS)),
            _ => Value::Null,
        },
    );
    let Ok(config) = parsed else { return Value::Object(out) };
    // what POST /api/submit computes
    let e = evaluate(&config, &server_options());
    out.insert(
        "server".into(),
        json!({ "valid": e.valid, "reasons": e.reasons, "overlaps": overlaps_out(&e.overlaps), "container": container_out(e.container), "score": e.score }),
    );
    // without the limit and the early return: every overlap, and the container of an invalid board too
    let full = evaluate(&config, &EvaluateOptions::default());
    out.insert(
        "full".into(),
        json!({ "valid": full.valid, "reasons": full.reasons, "overlaps": overlaps_out(&full.overlaps), "container": container_out(full.container), "score": full.score }),
    );
    // the stricter tolerance of the other families, on the same scan
    out.insert("tight".into(), overlaps_out(&find_overlaps(config.n, &config.pieces, 1e-11, 1.0, usize::MAX)));
    out.insert(
        "strict".into(),
        match &full.container {
            Some(k) => strict_out(&strict_verify(config.n, &config.pieces, k, STRICT_EPS)),
            None => Value::Null,
        },
    );
    let lit = match (case.get("lit"), &full.container) {
        (Some(rec), Some(k)) => {
            let rec: LiteratureRecord = serde_json::from_value(rec.clone()).expect("a literature record");
            json!({ "tolerance": literature_tolerance(&rec), "beats": beats_literature(k.size, &rec),
                "reaches": reaches_literature(k.size, &rec), "closed": closed_to_submissions(Some(&rec)) })
        }
        _ => Value::Null,
    };
    out.insert("lit".into(), lit);
    let auto = if case.get("auto").and_then(Value::as_bool) == Some(true) {
        let a = evaluate(&config, &EvaluateOptions { auto_orient: true, max_overlaps: None, stop_when_invalid: false });
        json!({ "container": container_out(a.container), "score": a.score })
    } else {
        Value::Null
    };
    out.insert("auto".into(), auto);
    Value::Object(out)
}

fn contact_out(k: Contact) -> Value {
    json!([k.sep, k.nx, k.ny])
}

fn pose_of(v: &Value) -> Pose {
    Pose::new(v["x"].as_f64().unwrap(), v["y"].as_f64().unwrap(), v["theta"].as_f64().unwrap())
}

fn numbers(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}

/// One call of calls.jsonl: `runCall` of flat-ref.mts, with the call's id.
pub fn run_call(c: &Value) -> Value {
    let mut out = match c["fn"].as_str().unwrap() {
        "pair" => {
            let n = c["N"].as_u64().unwrap() as u32;
            let (a, b) = (pose_of(&c["a"]), pose_of(&c["b"]));
            let scale = c["scale"].as_f64().unwrap();
            let thresholds = numbers(&c["thresholds"]);
            let mut out = json!({
                "piece": contact_out(piece_separation(n, &a, &b, scale)),
                "pair": pair_separation(n, &a, &b, scale),
                "circle": contact_out(circle_separation(&a, &b, scale)),
                "below": thresholds.iter().map(|&t| separation_below(n, &a, &b, t, scale)).collect::<Vec<bool>>(),
                "pieceBelow": thresholds.iter().map(|&t| piece_separation_below(n, &a, &b, t, scale)).collect::<Vec<bool>>(),
            });
            if n != 0 {
                let o = out.as_object_mut().unwrap();
                o.insert("regular".into(), contact_out(regular_polygon_separation(n, &a, &b, scale)));
                o.insert("overlap".into(), json!(regular_polygon_overlap(n, a.x, a.y, a.theta, b.x, b.y, b.theta, scale, 0.0)));
                let va = piece_vertices(n, &a, scale);
                let vb = piece_vertices(n, &b, scale);
                // two pieces about one centre: the normal of the general kernels is a tie (see flat-ref.mts)
                let tie = c.get("tie").and_then(Value::as_bool) == Some(true);
                let general = |k: Contact| if tie { json!([k.sep]) } else { contact_out(k) };
                o.insert("polygon".into(), general(polygon_separation(&va, &vb)));
                o.insert("polygonCircle".into(), general(polygon_circle_separation(&va, b.x, b.y, DISK_RADIUS * scale)));
            }
            out
        }
        "shape" => {
            let n = c["n"].as_u64().unwrap() as u32;
            let size = c["size"].as_f64().unwrap();
            let mut out = json!({ "pieceInradius": piece_inradius(n), "containerInradius": container_inradius(n),
                "boundingRadius": bounding_radius(n), "pieceArea": piece_area(n), "containerArea": container_area(n, size) });
            if n != 0 {
                let pose = pose_of(&c["pose"]);
                let o = out.as_object_mut().unwrap();
                o.insert("circumradius".into(), json!(circumradius(n)));
                o.insert("inradius".into(), json!(inradius(n)));
                o.insert("pieceVertices".into(), json!(piece_vertices(n, &pose, c["scale"].as_f64().unwrap())));
                o.insert("containerVertices".into(), json!(container_vertices(&Container { m: n, cx: pose.x, cy: pose.y, phi: pose.theta, size })));
            }
            out
        }
        "strict" => {
            let pieces: Vec<Pose> = c["pieces"].as_array().unwrap().iter().map(pose_of).collect();
            let k = &c["container"];
            let number = |key: &str| k[key].as_f64().unwrap();
            let container = Container { m: k["M"].as_u64().unwrap() as u32, cx: number("cx"), cy: number("cy"), phi: number("phi"), size: number("size") };
            strict_out(&strict_verify(c["N"].as_u64().unwrap() as u32, &pieces, &container, c["eps"].as_f64().unwrap()))
        }
        "bound" => {
            let field = |k: &str| c[k].as_u64().unwrap();
            json!({ "areaLowerBound": area_lower_bound(field("N") as u32, field("M") as u32, field("P") as usize) })
        }
        "shapeCode" => json!({ "isShapeCode": shape_code(&c["v"]).is_some() }),
        "points" => {
            let set = PointSet { pts: convex_hull(&numbers(&c["pts"])), pad: c["pad"].as_f64().unwrap() };
            let m = c["M"].as_u64().unwrap() as u32;
            let phi = c["phi"].as_f64().unwrap();
            let auto = if c["auto"].as_bool() == Some(true) { container_out(Some(auto_orient_set(&set, m, phi))) } else { Value::Null };
            json!({ "hull": set.pts, "circle": container_out(Some(enclosing_circle(&set))),
                "polygon": container_out(Some(enclosing_polygon(&set, m, phi))), "set": container_out(Some(enclose_set(&set, m, phi))), "auto": auto })
        }
        "lit" => {
            let rec: LiteratureRecord = serde_json::from_value(c["rec"].clone()).expect("a literature record");
            let scores = numbers(&c["scores"]);
            json!({ "tolerance": literature_tolerance(&rec), "closed": closed_to_submissions(Some(&rec)), "proven": is_proven(rec.status),
                "beats": scores.iter().map(|&s| beats_literature(s, &rec)).collect::<Vec<bool>>(),
                "reaches": scores.iter().map(|&s| reaches_literature(s, &rec)).collect::<Vec<bool>>() })
        }
        "recordsFile" => {
            #[derive(serde::Deserialize)]
            struct File {
                records: Vec<LiteratureRecord>,
            }
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(c["path"].as_str().unwrap());
            let file: File = serde_json::from_str(&std::fs::read_to_string(path).expect("data/records.json")).expect("the records");
            let (mut sum, mut closed, mut with_pieces) = (0.0, 0, 0);
            for r in &file.records {
                // `display.length` is in UTF-16 code units
                sum += r.n as f64 * 1e6
                    + r.m as f64 * 1e3
                    + r.p as f64
                    + r.value
                    + r.display_precision
                    + r.display.encode_utf16().count() as f64
                    + r.pieces.as_ref().map_or(0, |p| p.len()) as f64
                    + r.container_phi.unwrap_or(0.0);
                if closed_to_submissions(Some(r)) {
                    closed += 1;
                }
                if r.pieces.is_some() {
                    with_pieces += 1;
                }
            }
            json!({ "count": file.records.len(), "sum": sum, "closed": closed, "withPieces": with_pieces, "none": closed_to_submissions(None) })
        }
        "improves" => json!({ "improvesOn": improves_on(c["score"].as_f64().unwrap(), c["leader"].as_f64().unwrap()) }),
        "eventKeys" => {
            let field = |p: &Value, k: &str| p[k].as_u64().unwrap() as u32;
            let problems: Vec<(u32, u32, u32)> =
                c["problems"].as_array().unwrap().iter().map(|p| (field(p, "N"), field(p, "M"), field(p, "P"))).collect();
            json!({ "keys": event_keys(&problems, c["max"].as_u64().unwrap() as usize) })
        }
        "provenance" => {
            let methods: Vec<&str> = c["methods"].as_array().unwrap().iter().map(|m| m.as_str().unwrap()).collect();
            provenance_out(parse_provenance(c["body"].as_object().unwrap(), &methods))
        }
        other => panic!("unknown call {other}"),
    };
    out.as_object_mut().unwrap().insert("id".into(), c["id"].clone());
    out
}

/// A board the server accepts, for the timing of strict_verify.
pub fn strict_time_input(config: &PackingConfig) -> Option<Container> {
    let e = evaluate(config, &server_options());
    if e.valid {
        e.container
    } else {
        None
    }
}

// ------------------------------------------------------------------ the rule of the comparison

/// A message with every number replaced by `#`, and the numbers (native/PORTING.md).
fn split_numbers(text: &str) -> (String, Vec<f64>) {
    let bytes = text.as_bytes();
    let mut shape = String::new();
    let mut found = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i + 1 < bytes.len() && bytes[i] == b'.' && bytes[i + 1].is_ascii_digit() {
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if i < bytes.len() && bytes[i] == b'e' {
                let mut j = i + 1;
                if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
                    j += 1;
                }
                if j < bytes.len() && bytes[j].is_ascii_digit() {
                    while j < bytes.len() && bytes[j].is_ascii_digit() {
                        j += 1;
                    }
                    i = j;
                }
            }
            found.push(text[start..i].parse::<f64>().unwrap());
            shape.push('#');
        } else {
            let c = text[i..].chars().next().unwrap();
            shape.push(c);
            i += c.len_utf8();
        }
    }
    (shape, found)
}

/// The largest |coordinate| among the inputs of a case or a call (poses and flat point lists).
pub fn coordinate_scale(input: &Value) -> f64 {
    fn largest(v: &Value) -> f64 {
        match v {
            Value::Number(n) => n.as_f64().map_or(0.0, f64::abs),
            Value::Array(list) => list.iter().map(largest).fold(0.0, f64::max),
            Value::Object(o) => ["x", "y"].iter().filter_map(|k| o.get(*k)).map(largest).fold(0.0, f64::max),
            _ => 0.0,
        }
    }
    let poses = [&input["body"]["pieces"], &input["pts"], &input["a"], &input["b"], &input["pose"], &input["pieces"]];
    poses.iter().map(|v| largest(v)).fold(1.0, f64::max)
}

/// The difference between the reference's answer and the port's, or None when they agree as
/// native/PORTING.md asks: the same structure, booleans and counts; texts equal once their numbers
/// are placeholders, those numbers to 1e-6 relative or 1e-12 absolute; other numbers to 1e-12 of
/// their scale, which is at least `scale` (1, or the largest coordinate of the input: the size of
/// a set of points near (1e6, -1e6) is a difference of numbers near 1e6). The rule of
/// native/tools/flat-compare.mjs, without its verified ties, which the sample does not hold.
pub fn difference(path: &str, reference: &Value, port: &Value, scale: f64) -> Option<String> {
    match (reference, port) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            let unit = scale.max(1.0).max(a.abs()).max(b.abs());
            if a == b || (a - b).abs() <= 1e-12 * unit {
                None
            } else {
                Some(format!("{path}: {a} against {b}"))
            }
        }
        (Value::String(a), Value::String(b)) => {
            if a == b {
                return None;
            }
            let (sa, na) = split_numbers(a);
            let (sb, nb) = split_numbers(b);
            let close = |x: f64, y: f64| (x - y).abs() <= 1e-12 || (x - y).abs() <= 1e-6 * x.abs().max(y.abs());
            if sa == sb && na.iter().zip(&nb).all(|(&x, &y)| close(x, y)) {
                None
            } else {
                Some(format!("{path}: {a:?} against {b:?}"))
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{path}: {} entries against {}", a.len(), b.len()));
            }
            a.iter().zip(b).enumerate().find_map(|(i, (x, y))| difference(&format!("{path}[{i}]"), x, y, scale))
        }
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => {
                        if let Some(d) = difference(&format!("{path}.{key}"), x, y, scale) {
                            return Some(d);
                        }
                    }
                    _ => return Some(format!("{path}.{key}: on one side only")),
                }
            }
            None
        }
        (a, b) if a == b => None,
        (a, b) => Some(format!("{path}: {a} against {b}")),
    }
}
