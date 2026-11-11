//! The boundary validator on a file of cases, for comparison with the TypeScript reference
//! (native/tools/boundary-ref.mts writes the cases and the reference, boundary-compare.mjs compares).
//!
//!   cargo run --release -p polypack-boundary --example boundarydiff -- cases.jsonl rust.jsonl rust-times.json
//!   cargo run --release -p polypack-boundary --example boundarydiff -- --extras extras.jsonl rust-extras.jsonl
//!
//! A case is one JSON line {id, problem: {polytope, piece, P}, config, opts?, tol?, via?}. It is checked as
//! the server checks it (validateBoundary with maxReasons 20 and maxChains 1024, `opts` replacing
//! or adding limits) at the tolerances 1e-9 and 1e-11 (or at the one tolerance `tol`, which may be
//! the text "NaN" or "Infinity"); `via` ("ncube" or "nd") calls that validator directly. For each run this writes {tol, ok, score, reasons} or
//! {tol, throw}, and for the nD containers the steps and multiply-adds used. rust-times.json holds
//! the best of five timings per run, in nanoseconds: [{id, t: [t(1e-9), t(1e-11)]}, ...].
//!
//! An extra is one JSON line {id, fn, ...}: a call of one of the other functions the server uses
//! (the id parser, the domain, the bounds, the cost estimates, the tables).

#[path = "../tests/common/mod.rs"]
mod common;

use common::{check, extra, outcome_json, read_case, Case, Outcome};
use polypack_boundary::polytope::get_polytope;
use polypack_boundary::types::POLYTOPES;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "--extras" {
        let input = BufReader::new(std::fs::File::open(&args[2]).unwrap());
        let mut out = std::io::BufWriter::new(std::fs::File::create(&args[3]).unwrap());
        for line in input.lines() {
            let line = line.unwrap();
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(&line).unwrap();
            writeln!(out, "{}", json!({ "id": v["id"], "out": extra(&v) })).unwrap();
        }
        return;
    }
    let input = BufReader::new(std::fs::File::open(&args[1]).unwrap());
    let mut out = std::io::BufWriter::new(std::fs::File::create(&args[2]).unwrap());
    let mut cases: Vec<Case> = Vec::new();
    for line in input.lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).unwrap();
        cases.push(read_case(&v));
    }
    // the tables load on first use: outside the timings, as the server's first check pays it once
    for name in POLYTOPES {
        get_polytope(name).unwrap();
    }
    let mut best: Vec<Vec<u128>> = Vec::with_capacity(cases.len());
    for c in &cases {
        let mut runs: Vec<Value> = Vec::new();
        let mut times: Vec<u128> = Vec::new();
        for &tol in &c.tols {
            let t = Instant::now();
            let o = check(c, tol);
            times.push(t.elapsed().as_nanos());
            runs.push(outcome_json(tol, &o));
        }
        writeln!(out, "{}", json!({ "id": c.id, "runs": runs })).unwrap();
        best.push(times);
    }
    out.flush().unwrap();
    if args.len() > 3 {
        let mut sink = 0usize;
        for _ in 0..4 {
            for (i, c) in cases.iter().enumerate() {
                for (k, &tol) in c.tols.iter().enumerate() {
                    let t = Instant::now();
                    let o = std::hint::black_box(check(std::hint::black_box(c), tol));
                    let d = t.elapsed().as_nanos();
                    sink += match o {
                        Outcome::Verdict(v, _) => v.reasons.len(),
                        Outcome::Throw(m) => m.len(),
                    };
                    if d < best[i][k] {
                        best[i][k] = d;
                    }
                }
            }
        }
        std::hint::black_box(sink);
        let times: Vec<Value> = best.iter().zip(&cases).map(|(b, c)| json!({ "id": c.id, "t": b.iter().map(|&v| v as u64).collect::<Vec<_>>() })).collect();
        std::fs::write(&args[3], serde_json::to_string(&times).unwrap()).unwrap();
    }
}
