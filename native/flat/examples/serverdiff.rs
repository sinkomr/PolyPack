//! The Rust side of the comparison of the flat port with its TypeScript source.
//!
//!   node --import tsx native/tools/flat-ref.mts OUTDIR PER_PAIR n-*.json.gz...     (from the repository root)
//!   cargo run --release -p polypack-flat --example serverdiff -- OUTDIR             (from native/)
//!   node native/tools/flat-compare.mjs OUTDIR
//!
//! Reads OUTDIR/cases.jsonl and OUTDIR/calls.jsonl, which the reference tool wrote, and writes
//! what the port computes for each line to rust.jsonl and calls-rust.jsonl, in the reference's
//! layout (see tests/support/mod.rs). rust-times.json holds the best of five timings per case, in
//! nanoseconds: `parse_config`, `evaluate` as POST /api/submit calls it, and `strict_verify` of a
//! board it accepts (null where a step does not apply).

#[path = "../tests/support/mod.rs"]
mod support;

use polypack_flat::config::{evaluate, parse_config, strict_verify, STRICT_EPS};
use serde_json::{json, Value};
use std::hint::black_box;
use std::io::{BufRead, BufReader, Write};
use std::time::Instant;

fn lines(path: &str) -> Vec<Value> {
    let file = std::fs::File::open(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    BufReader::new(file)
        .lines()
        .map(|l| l.unwrap())
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(&l).unwrap_or_else(|e| panic!("{path}: {e}")))
        .collect()
}

fn write_lines(path: &str, values: impl Iterator<Item = Value>) {
    let mut out = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    for v in values {
        writeln!(out, "{v}").unwrap();
    }
    out.flush().unwrap();
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: serverdiff OUTDIR");
    let cases = lines(&format!("{dir}/cases.jsonl"));
    write_lines(&format!("{dir}/rust.jsonl"), cases.iter().map(support::run_case));
    let calls = lines(&format!("{dir}/calls.jsonl"));
    write_lines(&format!("{dir}/calls-rust.jsonl"), calls.iter().map(support::run_call));

    // timings, best of five
    let configs: Vec<_> = cases.iter().map(support::config_of).collect();
    let accepted: Vec<_> = configs.iter().map(|c| c.as_ref().and_then(support::strict_time_input)).collect();
    let options = support::server_options();
    let mut parse_ns: Vec<Option<u128>> = cases.iter().map(|c| c.get("text").is_none().then_some(u128::MAX)).collect();
    let mut eval_ns: Vec<Option<u128>> = configs.iter().map(|c| c.as_ref().map(|_| u128::MAX)).collect();
    let mut strict_ns: Vec<Option<u128>> = accepted.iter().map(|c| c.as_ref().map(|_| u128::MAX)).collect();
    let null = Value::Null;
    let mut sink = 0usize;
    for _ in 0..5 {
        for (i, case) in cases.iter().enumerate() {
            if let Some(best) = &mut parse_ns[i] {
                let body = case.get("body").unwrap_or(&null);
                let t = Instant::now();
                let parsed = black_box(parse_config(black_box(body)));
                *best = (*best).min(t.elapsed().as_nanos());
                sink += parsed.is_ok() as usize;
            }
            let Some(config) = &configs[i] else { continue };
            let t = Instant::now();
            let e = black_box(evaluate(black_box(config), &options));
            let d = t.elapsed().as_nanos();
            eval_ns[i] = Some(eval_ns[i].unwrap().min(d));
            sink += e.reasons.len();
            if let Some(container) = &accepted[i] {
                let t = Instant::now();
                let s = black_box(strict_verify(config.n, black_box(&config.pieces), container, STRICT_EPS));
                let d = t.elapsed().as_nanos();
                strict_ns[i] = Some(strict_ns[i].unwrap().min(d));
                sink += s.ok as usize;
            }
        }
    }
    black_box(sink);
    let list = |v: &[Option<u128>]| -> Vec<Value> { v.iter().map(|b| b.map_or(Value::Null, |ns| json!(ns as u64))).collect() };
    let times = json!({ "parse": list(&parse_ns), "evaluate": list(&eval_ns), "strict": list(&strict_ns) });
    std::fs::write(format!("{dir}/rust-times.json"), serde_json::to_string(&times).unwrap()).unwrap();
    println!("{} cases and {} calls answered in {dir}", cases.len(), calls.len());
}
