//! The spaces layer on a folder of cases, for comparison with the TypeScript reference
//! (`native/tools/spaces-ref.mts`, then this, then `native/tools/spaces-compare.mjs`).
//!
//!   cargo run --release -p polypack-spaces --example spacesdiff -- DIR [--no-times]
//!
//! reads DIR/cases.jsonl and DIR/aux-cases.jsonl and writes:
//!  - DIR/rust.jsonl: per main case `parse_space_config`, and the verdicts of
//!    `validate_space_submission` and `validate_space_submission_async`, in the order of the cases
//!    (the polytopes of the ndim space that are loaded on demand are loaded by the cases, in that
//!    order, as in the reference);
//!  - DIR/rust-times.json: best of five of `validate_space_submission` per case, in nanoseconds;
//!  - DIR/index.rust.jsonl, DIR/listing-<space>.rust.json, DIR/spaces.rust.json: the index of the
//!    repository's data/ (`load_spaces_index`: the log, every entry), each space's records listing
//!    and the answer of GET /api/spaces, as the server sends them;
//!  - DIR/aux-rust.jsonl: the auxiliary cases (ids, domains, catalogues of damaged files, the
//!    on-demand loader, stored configurations, the comparison rules, the constants).

#[path = "../tests/support/mod.rs"]
mod support;

use polypack_js::json;
use polypack_spaces::load::load_spaces_index;
use polypack_spaces::SPACE_NAMES;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Instant;

/// The lines of a file, each read as a server reads a body.
fn lines(path: &str) -> Vec<Value> {
    BufReader::new(std::fs::File::open(path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .lines()
        .map(|l| l.unwrap())
        .filter(|l| !l.trim().is_empty())
        .map(|l| json::parse(l.as_bytes()).unwrap())
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = args.first().expect("the directory of the cases").clone();
    let times = !args.iter().any(|a| a == "--no-times");

    let cases = lines(&format!("{dir}/cases.jsonl"));
    let mut out = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/rust.jsonl")).unwrap());
    let t = Instant::now();
    for case in &cases {
        writeln!(out, "{}", json::stringify(&support::main_result(case))).unwrap();
    }
    out.flush().unwrap();
    eprintln!("{} main cases in {:.1} s", cases.len(), t.elapsed().as_secs_f64());

    if times {
        let t = Instant::now();
        let mut best = vec![u128::MAX; cases.len()];
        let mut sink = 0usize;
        for _ in 0..5 {
            for (i, case) in cases.iter().enumerate() {
                let t = Instant::now();
                sink += std::hint::black_box(support::run_sync(std::hint::black_box(case)));
                let d = t.elapsed().as_nanos();
                if d < best[i] {
                    best[i] = d;
                }
            }
        }
        std::hint::black_box(sink);
        let best: Vec<u64> = best.iter().map(|b| *b as u64).collect();
        std::fs::write(format!("{dir}/rust-times.json"), serde_json::to_string(&best).unwrap()).unwrap();
        eprintln!("timings in {:.1} s", t.elapsed().as_secs_f64());
    }

    // the index of the repository's data
    let (log, kept) = support::keeping_log();
    let t = Instant::now();
    let index = load_spaces_index(&support::repo_root(), log);
    eprintln!("the index of data/ in {:.2} s", t.elapsed().as_secs_f64());
    let mut out = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/index.rust.jsonl")).unwrap());
    writeln!(out, "{}", json::stringify(&json!({ "log": *kept.lock().unwrap() }))).unwrap();
    for space in SPACE_NAMES {
        let cat = index.get(space);
        writeln!(out, "{}", json::stringify(&json!({ "catalogue": cat.map(|c| support::catalogue_json(c)) }))).unwrap();
        for p in cat.map(|c| c.problems.as_slice()).unwrap_or(&[]) {
            writeln!(out, "{}", json::stringify(&support::entry_json(p))).unwrap();
        }
        if let Some(cat) = cat {
            std::fs::write(format!("{dir}/listing-{space}.rust.json"), support::listing_json(cat)).unwrap();
        }
    }
    out.flush().unwrap();
    std::fs::write(format!("{dir}/spaces.rust.json"), support::spaces_json(&index)).unwrap();

    let mut aux = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/aux-rust.jsonl")).unwrap());
    let aux_cases = lines(&format!("{dir}/aux-cases.jsonl"));
    for c in &aux_cases {
        writeln!(aux, "{}", json::stringify(&json!({ "id": c["id"], "result": support::aux_result(c) }))).unwrap();
    }
    aux.flush().unwrap();
    eprintln!("{} auxiliary cases", aux_cases.len());
}
