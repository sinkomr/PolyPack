//! The torus validator on a file of cases, for comparison with the TypeScript reference
//! (`native/tools/torus-ref.mts`, then this, then `native/tools/torus-compare.mjs`).
//!
//!   cargo run --release -p polypack-torus --example torusdiff -- DIR
//!
//! reads DIR/cases.jsonl and DIR/aux-cases.jsonl and writes DIR/rust.jsonl, DIR/rust-times.json and
//! DIR/aux-rust.jsonl. Each case is one JSON line `{ id, kind, family, N, lattice, poses }`. For
//! each this writes what the server computes at both tolerances (`polypack_torus::json::case_line`):
//! the validator's result with `maxErrors` 20 (`t9`, `t11`) and the reasons of `check` (`r9`,
//! `r11`); and the validator's result with no options (`v0`) for the cases the reference tool asks
//! it of. rust-times.json holds the best of five timings of `check` at 1e-9 per case, in
//! nanoseconds.
//!
//! The auxiliary cases are the package's other functions on their own inputs
//! (`polypack_torus::json::aux_result`): `areaScoreBound` (the domain's lower bound), the piece
//! radii, `gaussReduce`, `maxImageCandidates`, `torusScore`, the stored basis, `latticeImages`,
//! `separationOf`, and the validator with its other options.

use polypack_torus::json::{aux_result, case_line, case_of, MAX_REASONS, TORUS_MAX_TRANSLATES};
use polypack_torus::server::check;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Instant;

fn lines(path: &str) -> Vec<Value> {
    BufReader::new(std::fs::File::open(path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .lines()
        .map(|l| l.unwrap())
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(&l).unwrap())
        .collect()
}

fn main() {
    let dir = std::env::args().nth(1).expect("the directory of the cases");
    let mut out = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/rust.jsonl")).unwrap());
    let mut cases = Vec::new();
    for v in lines(&format!("{dir}/cases.jsonl")) {
        writeln!(out, "{}", case_line(&v)).unwrap();
        cases.push(case_of(&v));
    }
    out.flush().unwrap();

    let mut best = vec![u128::MAX; cases.len()];
    let mut sink = 0usize;
    for _ in 0..5 {
        for (i, (family, n, spec, poses)) in cases.iter().enumerate() {
            let t = Instant::now();
            let r = std::hint::black_box(check(
                *family,
                *n,
                spec,
                std::hint::black_box(poses),
                1e-9,
                MAX_REASONS,
                TORUS_MAX_TRANSLATES,
            ));
            let d = t.elapsed().as_nanos();
            sink += r.len();
            if d < best[i] {
                best[i] = d;
            }
        }
    }
    std::hint::black_box(sink);
    let times: Vec<u64> = best.iter().map(|b| *b as u64).collect();
    std::fs::write(format!("{dir}/rust-times.json"), serde_json::to_string(&times).unwrap()).unwrap();

    let mut aux = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/aux-rust.jsonl")).unwrap());
    for v in lines(&format!("{dir}/aux-cases.jsonl")) {
        writeln!(aux, "{}", json!({ "id": v["id"], "result": aux_result(&v) })).unwrap();
    }
    aux.flush().unwrap();
}
