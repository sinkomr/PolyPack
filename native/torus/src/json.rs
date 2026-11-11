//! The JSON of the comparison with the TypeScript (`native/tools/torus-ref.mts`,
//! `examples/torusdiff.rs`, `tests/fixtures.rs`): how a case is read and a result written.
//!
//! JSON has no NaN and no infinities, and the cases need them (a validator must refuse them), so a
//! number may be written as one of the strings "NaN", "Infinity", "-Infinity". Both sides write
//! results the same way.

use crate::disk::separation_of;
use crate::geometry::{bounding_radius, piece_area, piece_inradius, Pose};
use crate::lattice::{
    gauss_reduce, lattice_images, max_image_candidates, torus_score, Lattice, TorusFamily, TORUS_DISK_RADIUS,
    TORUS_FAMILIES,
};
use crate::server::{check, reduced_lattice, spec_lattice, LatticeSpec};
use crate::validate::{
    area_score_bound, validation_steps, ImageContact, TorusPacking, TorusValidation, ValidateOptions,
};
use serde_json::{json, Value};

/// The server's MAX_REASONS (packages/spaces/src/validate.ts): the `maxErrors` it passes.
pub const MAX_REASONS: usize = 20;
/// The server's TORUS_MAX_TRANSLATES (packages/spaces/src/info.ts).
pub const TORUS_MAX_TRANSLATES: f64 = 1000.0;

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

/// `[x, y]`.
pub fn vec2(v: &Value) -> [f64; 2] {
    [num(&v[0]), num(&v[1])]
}

/// `{ b1, b2 }`.
pub fn lattice_of(v: &Value) -> Lattice {
    Lattice {
        b1: vec2(&v["b1"]),
        b2: vec2(&v["b2"]),
    }
}

/// A lattice as a result.
pub fn lattice_json(l: &Lattice) -> Value {
    json!({ "b1": [enc(l.b1[0]), enc(l.b1[1])], "b2": [enc(l.b2[0]), enc(l.b2[1])] })
}

/// A case `{ family, N, lattice: { L } | { b1, b2 }, poses: [[x, y, theta]] }`: the configuration
/// as the server's parser hands it to `check`.
pub fn case_of(v: &Value) -> (TorusFamily, f64, LatticeSpec, Vec<[f64; 3]>) {
    let family = TorusFamily::parse(v["family"].as_str().expect("family")).expect("a family");
    let l = &v["lattice"];
    let spec = if l.get("L").is_some() {
        LatticeSpec::L(num(&l["L"]))
    } else {
        LatticeSpec::Basis {
            b1: vec2(&l["b1"]),
            b2: vec2(&l["b2"]),
        }
    };
    let poses = v["poses"]
        .as_array()
        .expect("poses")
        .iter()
        .map(|p| [num(&p[0]), num(&p[1]), num(&p[2])])
        .collect();
    (family, num(&v["N"]), spec, poses)
}

fn contacts_json(list: &[ImageContact]) -> Vec<Value> {
    list.iter()
        .map(|c| json!([c.i, c.j, enc(c.m), enc(c.n), enc(c.sep)]))
        .collect()
}

/// A `TorusValidation` as the reference tool writes the TypeScript's.
pub fn result_json(v: &TorusValidation) -> Value {
    json!({
        "valid": v.valid,
        "minSep": enc(v.min_sep),
        "overlaps": contacts_json(&v.overlaps),
        "contacts": contacts_json(&v.contacts),
        "pairsChecked": v.pairs_checked,
        "score": enc(v.score),
        "density": enc(v.density),
        "errors": v.errors,
    })
}

/// The packing of a case, as `check` hands it to the validator.
pub fn packing_of(v: &Value) -> TorusPacking {
    let (family, n, spec, poses) = case_of(v);
    TorusPacking {
        family,
        n,
        lattice: spec_lattice(family, &spec),
        poses: poses.iter().map(|&[x, y, theta]| Pose { x, y, theta }).collect(),
    }
}

/// `wantsV0` of the reference tool: the result with no options is asked of cases of at most 60
/// pieces whose enumeration is small (or so large that `lattice_images` refuses it at once):
/// without `maxErrors` nothing stops a check that finds a million overlapping translates per pair.
fn wants_v0(packing: &TorusPacking) -> bool {
    let p = packing.poses.len() as f64;
    if p > 60.0 {
        return false;
    }
    let candidates = max_image_candidates(&packing.lattice, 2.0 * bounding_radius(packing.n) + 2e-7);
    !(candidates * p * (p + 1.0) > 4e6) || candidates > 1e7
}

/// What the comparison records of a case, as the reference tool does: the validator's result at
/// 1e-9 and 1e-11 as the server calls it (`t9`, `t11`), the reasons of `check` at both (`r9`,
/// `r11`), and the validator's result with no options (`v0`) for the cases `wants_v0` names.
pub fn case_line(v: &Value) -> Value {
    let (family, n, spec, poses) = case_of(v);
    let packing = packing_of(v);
    let at = |tol: f64| {
        validation_steps(
            &packing,
            &ValidateOptions {
                tol: Some(tol),
                max_errors: Some(MAX_REASONS as f64),
                ..Default::default()
            },
        )
    };
    let mut line = json!({
        "id": v["id"],
        "t9": result_json(&at(1e-9)),
        "t11": result_json(&at(1e-11)),
        "r9": check(family, n, &spec, &poses, 1e-9, MAX_REASONS, TORUS_MAX_TRANSLATES),
        "r11": check(family, n, &spec, &poses, 1e-11, MAX_REASONS, TORUS_MAX_TRANSLATES),
    });
    if wants_v0(&packing) {
        line["v0"] = result_json(&validation_steps(&packing, &ValidateOptions::default()));
    }
    line
}

fn pose(v: &Value) -> Pose {
    Pose {
        x: num(&v["x"]),
        y: num(&v["y"]),
        theta: num(&v["theta"]),
    }
}

/// The result of an auxiliary case `{ fn, ... }`: one of the package's other functions on its own
/// input, as the reference tool writes it.
pub fn aux_result(v: &Value) -> Value {
    match v["fn"].as_str().expect("fn") {
        // areaScoreBound(family, N, P) for P = 1..500, with the source's defaults
        "areaScoreBound" => {
            let family = TorusFamily::parse(v["family"].as_str().expect("family")).expect("a family");
            let n = num(&v["N"]);
            json!((1..=500)
                .map(|p| enc(area_score_bound(family, n, p as f64, 1.0, TORUS_DISK_RADIUS)))
                .collect::<Vec<_>>())
        }
        // [pieceInradius(N), boundingRadius(N), pieceArea(N)] for every N of the domain
        "radii" => json!(std::iter::once(0)
            .chain(3..=100)
            .map(|n| {
                let n = n as f64;
                json!([enc(piece_inradius(n)), enc(bounding_radius(n)), enc(piece_area(n))])
            })
            .collect::<Vec<_>>()),
        // gaussReduce, maxImageCandidates, torusScore of each family, and the basis the server stores
        "lattice" => {
            let l = lattice_of(&v["l"]);
            let g = gauss_reduce(&l);
            json!({
                "gaussReduce": {
                    "lattice": lattice_json(&g.lattice),
                    "M": [[enc(g.m[0][0]), enc(g.m[0][1])], [enc(g.m[1][0]), enc(g.m[1][1])]],
                },
                "maxImageCandidates": enc(max_image_candidates(&l, num(&v["reach"]))),
                "score": TORUS_FAMILIES.iter().map(|f| enc(torus_score(*f, &l))).collect::<Vec<_>>(),
                "reduced": reduced_lattice(&l).map(|r| lattice_json(&r)),
            })
        }
        "latticeImages" => {
            let l = lattice_of(&v["l"]);
            match lattice_images(&l, &vec2(&v["d"]), num(&v["reach"]), v["half"].as_bool().expect("half")) {
                Ok(images) => json!(images
                    .iter()
                    .map(|im| json!([enc(im.m), enc(im.n), enc(im.v[0]), enc(im.v[1])]))
                    .collect::<Vec<_>>()),
                Err(message) => json!({ "error": message }),
            }
        }
        "separationOf" => enc(separation_of(
            num(&v["N"]),
            &pose(&v["a"]),
            &pose(&v["b"]),
            num(&v["scale"]),
            TORUS_DISK_RADIUS,
        )),
        // validationSteps with the options the server does not pass
        "validateWith" => {
            let o = &v["opts"];
            let opt = |key: &str| o.get(key).map(num);
            let opts = ValidateOptions {
                tol: opt("tol"),
                max_errors: opt("maxErrors"),
                scale: opt("scale"),
                contact_tol: opt("contactTol"),
                disk_radius: opt("diskRadius"),
            };
            result_json(&validation_steps(&packing_of(v), &opts))
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
