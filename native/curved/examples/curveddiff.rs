//! The Rust port's answers for the cases of native/tools/curved-ref.mts, for comparison with the
//! TypeScript's (native/PORTING.md).
//!
//!   node --import tsx native/tools/curved-ref.mts OUTDIR --snapshot space-curved.json.gz
//!   cargo run --release -p polypack-curved --example curveddiff -- OUTDIR
//!   node native/tools/curved-compare.mjs OUTDIR
//!
//! Reads OUTDIR/cases.jsonl and writes OUTDIR/rust.jsonl: for each case `validation_steps` at
//! (tol 1e-9, max_errors 20), (1e-11, 20) and with the default options, and the reasons of the
//! server's check at both tolerances, in the form of ref.jsonl. OUTDIR/rust-times.json holds the
//! best of five timings of `validation_steps` as the TypeScript server calls it (nanoseconds per
//! case), rust-times-server.json the same without the list of contacts, which the server does not
//! read. Then reads OUTDIR/bound-ref.jsonl and writes OUTDIR/bound-rust.jsonl: curved_max_p,
//! piece_exists, curved_bound_of, curved_why_not and container_circumradius for the same inputs.
//!
//! Numbers that JSON cannot write come as their names ("NaN", "Infinity", "-Infinity", "-0"), and
//! every result number is written as the text JavaScript's String(x) gives.

// Negated comparisons are the source's: `!(a <= b)` is true for NaN.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use polypack_curved::bound::{curved_bound_of, curved_max_p, curved_why_not, CURVED_MAX_P};
use polypack_curved::shapes::{container_circumradius, piece_exists};
use polypack_curved::validate::{validation_steps, ValidationOptions, ValidationResult};
use polypack_curved::{CurvedConfig, CurvedProblem, Pose};
use polypack_js::{fmt as jsfmt, math};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Instant;

/// A number of a case: a JSON number, or the name of one JSON cannot write.
fn dec_in(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().expect("number"),
        Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("not a number: {other}"),
        },
        other => panic!("not a number: {other}"),
    }
}

/// A result number as text: `Object.is(x, -0) ? "-0" : String(x)`.
fn enc(x: f64) -> String {
    if x == 0.0 && x.is_sign_negative() {
        "-0".into()
    } else {
        jsfmt::num(x)
    }
}

const MAX_CONTACTS: usize = 40;
const MAX_ERRORS_WRITTEN: usize = 40;
const MAX_REASONS: usize = 20;

fn result(v: &ValidationResult) -> Value {
    let contacts: Vec<Value> = v
        .contacts
        .iter()
        .take(MAX_CONTACTS)
        .map(|c| {
            let mut row = vec![
                json!(c.kind.as_str()),
                json!(c.i),
                json!(c.j),
                json!(c.wall),
                json!(c.vertex),
                json!(enc(c.gap)),
            ];
            if let Some(w) = c.witness {
                row.extend([json!(w.owner), json!(w.edge), json!(w.vertex)]);
            }
            Value::Array(row)
        })
        .collect();
    json!({
        "valid": v.valid,
        "strictlyValid": v.strictly_valid,
        "score": enc(v.score),
        "tightSize": enc(v.tight_size),
        "minGap": enc(v.min_gap),
        "minPairGap": enc(v.min_pair_gap),
        "minContainerGap": enc(v.min_container_gap),
        "nErrors": v.errors.len(),
        "errors": v.errors.iter().take(MAX_ERRORS_WRITTEN).collect::<Vec<_>>(),
        "nContacts": v.contacts.len(),
        "contacts": contacts,
    })
}

/// packages/spaces/src/validate.ts: check(), the curved branch, with reasonsOf (the port of that
/// file belongs to native/spaces; this copy is what curved-ref.mts runs on the TypeScript side).
fn check(problem: &CurvedProblem, config: &CurvedConfig, tol: f64) -> Vec<String> {
    let reach = container_circumradius(problem.m, problem.k, config.size);
    if reach.is_finite() {
        if let Some(far) = config
            .pieces
            .iter()
            .position(|p| !(math::hypot(p.x, p.y) <= reach * (1.0 + 1e-6) + 1e-6))
        {
            return vec![format!("the centre of piece {far} lies outside the container")];
        }
    }
    let options = ValidationOptions {
        tol,
        max_errors: Some(MAX_REASONS),
        ..ValidationOptions::default()
    };
    let v = validation_steps(problem, config, &options);
    if v.valid {
        return vec![];
    }
    let list: Vec<String> = v.errors.into_iter().take(MAX_REASONS).collect();
    if list.is_empty() {
        vec![format!("not a valid packing (smallest gap {})", jsfmt::num(v.min_gap))]
    } else {
        list
    }
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: curveddiff OUTDIR");
    let server = |tol: f64| ValidationOptions {
        tol,
        max_errors: Some(MAX_REASONS),
        ..ValidationOptions::default()
    };

    // the configurations
    let input = BufReader::new(std::fs::File::open(format!("{dir}/cases.jsonl")).expect("cases.jsonl"));
    let mut out = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/rust.jsonl")).unwrap());
    let mut cases: Vec<(CurvedProblem, CurvedConfig)> = Vec::new();
    for line in input.lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).expect("json");
        let problem = CurvedProblem {
            k: dec_in(&v["K"]),
            n: v["N"].as_u64().expect("N") as u32,
            m: v["M"].as_u64().expect("M") as u32,
            p: v["P"].as_u64().expect("P") as u32,
        };
        let config = CurvedConfig {
            size: dec_in(&v["size"]),
            pieces: v["pieces"]
                .as_array()
                .expect("pieces")
                .iter()
                .map(|q| Pose {
                    x: dec_in(&q[0]),
                    y: dec_in(&q[1]),
                    theta: dec_in(&q[2]),
                })
                .collect(),
        };
        let runs = [
            result(&validation_steps(&problem, &config, &server(1e-9))),
            result(&validation_steps(&problem, &config, &server(1e-11))),
            result(&validation_steps(&problem, &config, &ValidationOptions::default())),
        ];
        let line = json!({
            "id": v["id"],
            "runs": runs,
            "check": [check(&problem, &config, 1e-9), check(&problem, &config, 1e-11)],
        });
        writeln!(out, "{line}").unwrap();
        cases.push((problem, config));
    }
    out.flush().unwrap();

    // timings: best of five passes per case, with the contacts (as the TypeScript) and without
    for (file, contacts) in [("rust-times.json", true), ("rust-times-server.json", false)] {
        let options = ValidationOptions {
            contacts,
            ..server(1e-9)
        };
        let mut best = vec![u128::MAX; cases.len()];
        let mut sink = 0usize;
        for _ in 0..5 {
            for (i, (problem, config)) in cases.iter().enumerate() {
                let t = Instant::now();
                let v = std::hint::black_box(validation_steps(
                    std::hint::black_box(problem),
                    std::hint::black_box(config),
                    &options,
                ));
                let d = t.elapsed().as_nanos();
                sink += v.errors.len();
                if d < best[i] {
                    best[i] = d;
                }
            }
        }
        std::hint::black_box(sink);
        let times: Vec<u64> = best.iter().map(|&b| b as u64).collect();
        std::fs::write(format!("{dir}/{file}"), serde_json::to_string(&times).unwrap()).unwrap();
    }
    eprintln!("{} cases", cases.len());

    // bounds and the domain
    let Ok(file) = std::fs::File::open(format!("{dir}/bound-ref.jsonl")) else {
        return;
    };
    let mut out = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/bound-rust.jsonl")).unwrap());
    let code = |n: f64| n == 0.0 || (n.is_finite() && n.fract() == 0.0 && (3.0..=100.0).contains(&n));
    let mut lines = 0usize;
    for line in BufReader::new(file).lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).expect("json");
        let (k, n, m) = (dec_in(&v["K"]), dec_in(&v["N"]), dec_in(&v["M"]));
        let limit = if v["limit"].is_null() {
            CURVED_MAX_P as f64
        } else {
            dec_in(&v["limit"])
        };
        let codes = code(n) && code(m);
        let ps: Vec<Value> = v["ps"]
            .as_array()
            .expect("ps")
            .iter()
            .map(|row| {
                let p = dec_in(&row[0]);
                let whole = codes && p.is_finite() && p.fract() == 0.0 && (0.0..4294967296.0).contains(&p);
                let bound = if whole {
                    match curved_bound_of(k, n as u32, m as u32, p as u32) {
                        Some(b) => json!(enc(b)),
                        None => Value::Null,
                    }
                } else {
                    json!("skip")
                };
                json!([row[0], bound, curved_why_not(k, n, m, p)])
            })
            .collect();
        let circ: Vec<Value> = if codes {
            v["circ"]
                .as_array()
                .expect("circ")
                .iter()
                .map(|row| json!([row[0], enc(container_circumradius(m as u32, k, dec_in(&row[0])))]))
                .collect()
        } else {
            vec![]
        };
        let line = json!({
            "K": v["K"], "N": v["N"], "M": v["M"], "limit": v["limit"],
            "maxP": enc(curved_max_p(k, n, m, limit)),
            "exists": if codes { json!(piece_exists(n as u32, k)) } else { Value::Null },
            "ps": ps,
            "circ": circ,
        });
        writeln!(out, "{line}").unwrap();
        lines += 1;
    }
    out.flush().unwrap();
    eprintln!("{lines} bound lines");
}
