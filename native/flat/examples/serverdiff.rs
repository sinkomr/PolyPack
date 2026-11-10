//! The server rule on a file of cases, for comparison with the TypeScript reference.
//!
//!   cargo run --release -p polypack-flat --example serverdiff -- cases.jsonl out.jsonl times.json
//!
//! Each case is one JSON line {id, N, M, P, pieces: [{x, y, theta}], container_phi}. For each this
//! writes what POST /api/submit computes: the parse verdict, `evaluate` with at most 20 reported
//! overlaps and stop-when-invalid, and `strict_verify` of a valid packing. times.json holds the
//! best of five timings of `evaluate` per case, in nanoseconds (null for a case that did not parse).

use polypack_flat::shapes::{Config, Pose};
use polypack_flat::validate::{evaluate, parse_errors, strict_verify};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = BufReader::new(std::fs::File::open(&args[1]).unwrap());
    let mut out = std::io::BufWriter::new(std::fs::File::create(&args[2]).unwrap());
    let mut cases: Vec<Option<(Config, usize)>> = Vec::new();
    for line in input.lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).unwrap();
        let id = v["id"].as_u64().unwrap();
        let n = v["N"].as_u64().unwrap() as u32;
        let m = v["M"].as_u64().unwrap() as u32;
        let p = v["P"].as_u64().unwrap() as usize;
        let pieces: Vec<Pose> = v["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| Pose::new(q["x"].as_f64().unwrap(), q["y"].as_f64().unwrap(), q["theta"].as_f64().unwrap_or(0.0)))
            .collect();
        let phi = v["container_phi"].as_f64().unwrap_or(0.0);
        let errors = parse_errors(n, m, p, &pieces, phi);
        if !errors.is_empty() {
            writeln!(out, "{}", json!({ "id": id, "parse_ok": false, "errors": errors })).unwrap();
            cases.push(None);
            continue;
        }
        let config = Config { n, m, pieces, phi };
        let e = evaluate(&config, p, false, 20, true);
        let k = if e.valid { e.container } else { None };
        let strict = k.map(|c| strict_verify(n, &config.pieces, &c, 1e-8));
        writeln!(
            out,
            "{}",
            json!({
                "id": id, "parse_ok": true, "valid": e.valid, "reasons": e.reasons,
                "score": k.map(|c| c.size),
                "container": k.map(|c| json!({ "M": c.m, "cx": c.cx, "cy": c.cy, "phi": c.phi, "size": c.size })),
                "strict": strict.map(|s| json!({ "ok": s.ok, "certified": s.certified_size, "reason": s.reason })),
            })
        )
        .unwrap();
        cases.push(Some((config, p)));
    }
    out.flush().unwrap();
    let mut best: Vec<Option<u128>> = cases.iter().map(|c| c.as_ref().map(|_| u128::MAX)).collect();
    let mut sink = 0usize;
    for _ in 0..5 {
        for (i, c) in cases.iter().enumerate() {
            if let Some((config, p)) = c {
                let t = Instant::now();
                let e = std::hint::black_box(evaluate(std::hint::black_box(config), *p, false, 20, true));
                let d = t.elapsed().as_nanos();
                sink += e.reasons.len();
                if d < best[i].unwrap() {
                    best[i] = Some(d);
                }
            }
        }
    }
    std::hint::black_box(sink);
    let times: Vec<Value> = best.iter().map(|b| b.map_or(Value::Null, |v| json!(v as u64))).collect();
    std::fs::write(&args[3], serde_json::to_string(&times).unwrap()).unwrap();
}
