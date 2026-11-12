//! The Rust side of the comparison with packages/polyhedra (TypeScript), for the cases of
//! `native/tools/polyhedra-ref.mts`.
//!
//!   cargo run --release -p polypack-polyhedra --example polyhedradiff -- OUTDIR
//!
//! Reads OUTDIR/cases.jsonl (one case {id, kind, code, P, raw} per line) and writes OUTDIR/rust.jsonl, the same
//! answer the tool wrote in ref.jsonl: `parse_polyhedra_config(raw, P, 20)` and `validate_polyhedra` at the
//! tolerances 1e-9 and 1e-11 with at most 20 errors. OUTDIR/rust-times.json holds the best of five timings of
//! `validate_polyhedra` at 1e-9 on the parsed configuration, in nanoseconds (null for a case that did not parse).
//! Then reads the keys of OUTDIR/catalogue-ref.jsonl and writes OUTDIR/catalogue-rust.jsonl, the port's value
//! for each. `native/tools/polyhedra-compare.mjs OUTDIR` compares the two sides.

#[path = "../tests/common/mod.rs"]
mod common;

use polypack_polyhedra as ph;
use serde_json::Value;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::time::Instant;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: polyhedradiff OUTDIR");
    let input = BufReader::new(std::fs::File::open(format!("{dir}/cases.jsonl")).expect("cases.jsonl"));
    let mut out = BufWriter::new(std::fs::File::create(format!("{dir}/rust.jsonl")).expect("rust.jsonl"));
    let mut times: Vec<Option<u64>> = Vec::new();
    let mut sink = 0usize;
    for line in input.lines() {
        let line = line.expect("a line");
        if line.trim().is_empty() {
            continue;
        }
        let case: Value = serde_json::from_str(&line).expect("a case");
        writeln!(out, "{}", common::answer_line(&case)).expect("write");
        // timing: the server's call on the parsed configuration, best of five
        let problem = ph::get_problem(case["code"].as_str().expect("code"));
        let parsed = ph::parse_polyhedra_config(&case["raw"], case["P"].as_u64().expect("P") as usize, 20);
        let time = match (&problem, &parsed) {
            (Some(problem), ph::ParsedConfig::Ok { config, .. }) => {
                let opts = ph::ValidateOptions { tol: Some(1e-9), max_errors: Some(20), stop_at: None };
                let mut best = u128::MAX;
                for _ in 0..5 {
                    let t = Instant::now();
                    let r = std::hint::black_box(ph::validate_polyhedra(problem, std::hint::black_box(config), &opts));
                    let d = t.elapsed().as_nanos();
                    sink += r.map_or(0, |r| r.errors.len());
                    best = best.min(d);
                }
                Some(best as u64)
            }
            _ => None,
        };
        times.push(time);
    }
    out.flush().expect("flush");
    std::hint::black_box(sink);
    let text: Vec<String> = times.iter().map(|t| t.map_or("null".to_string(), |v| v.to_string())).collect();
    std::fs::write(format!("{dir}/rust-times.json"), format!("[{}]", text.join(","))).expect("rust-times.json");

    let catalogue = BufReader::new(std::fs::File::open(format!("{dir}/catalogue-ref.jsonl")).expect("catalogue-ref.jsonl"));
    let mut out = BufWriter::new(std::fs::File::create(format!("{dir}/catalogue-rust.jsonl")).expect("catalogue-rust.jsonl"));
    for line in catalogue.lines() {
        let line = line.expect("a line");
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).expect("a catalogue line");
        writeln!(out, "{}", common::catalogue_line(v["k"].as_str().expect("k"))).expect("write");
    }
    out.flush().expect("flush");
    eprintln!("{} cases written to {dir}/rust.jsonl", times.len());
}
