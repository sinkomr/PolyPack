//! The Rust side of the comparison of the ndim family (native/PORTING.md): answers the cases that
//! native/tools/ndim-ref.mts built and times the check as the server calls it.
//!
//!   cargo run --release -p polypack-ndim --example ndimdiff -- OUTDIR
//!
//! reads OUTDIR/cases.jsonl, writes OUTDIR/rust.jsonl (one answer per case, in the form of
//! ref.jsonl) and OUTDIR/rust-times.json (nanoseconds, best of five passes, of `nd_check` at 1e-9
//! for every case whose configuration is well formed). native/tools/ndim-compare.mjs compares.
#[path = "../tests/eval/mod.rs"]
mod eval;

use polypack_ndim::space::{nd_check, NDIM_MAX_REASONS};
use serde_json::Value;
use std::io::Write;
use std::time::Instant;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: ndimdiff OUTDIR");
    // so that the validator's clock has started (a deadline of 0 is then in the past, as in the source)
    polypack_ndim::validate::performance_now();
    let text = std::fs::read_to_string(format!("{dir}/cases.jsonl")).expect("cases.jsonl");
    let cases: Vec<Value> = text.lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str(l).expect("a case")).collect();
    let t0 = Instant::now();
    let mut out = std::io::BufWriter::new(std::fs::File::create(format!("{dir}/rust.jsonl")).expect("rust.jsonl"));
    for c in &cases {
        let line = serde_json::json!({ "id": c["id"], "answer": eval::answer(c) });
        writeln!(out, "{}", polypack_js::json::stringify(&line)).expect("write");
    }
    out.flush().expect("write");
    eprintln!("{} answers in {:.1} s", cases.len(), t0.elapsed().as_secs_f64());

    let parsed: Vec<_> = cases.iter().map(eval::parsed).collect();
    let mut best: Vec<Option<u64>> = vec![None; cases.len()];
    for _pass in 0..5 {
        for (i, q) in parsed.iter().enumerate() {
            let Some((p, config)) = q else { continue };
            let t = Instant::now();
            let r = nd_check(p, config, 1e-9, NDIM_MAX_REASONS);
            let dt = t.elapsed().as_nanos() as u64;
            std::hint::black_box(&r);
            if best[i].is_none() || best[i].is_some_and(|b| dt < b) {
                best[i] = Some(dt);
            }
        }
    }
    std::fs::write(format!("{dir}/rust-times.json"), serde_json::to_string(&best).expect("times")).expect("rust-times.json");
    eprintln!("timings done, {:.1} s in all", t0.elapsed().as_secs_f64());
}
