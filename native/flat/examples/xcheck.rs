//! The validator cross-check: reads the cases of native/tools/validator-cases.mts (one JSON line
//! each, with the reference's verdicts) and compares this crate's verdicts with them.
//!
//!   npx tsx native/tools/validator-cases.mts 6 1 > cases.jsonl
//!   cargo run --release -p polypack-flat --example xcheck < cases.jsonl
//!
//! Reported per family: parse verdicts; the exact rule (`evaluate`); the client's conservative
//! check (`server_check`), which must never accept what the reference refuses; the strict verdict
//! of the client check and of the search framework's fast kernel; strictVerify; and the largest
//! differences of score and smallest separation.

use polypack_flat::grid::NeighborGrid;
use polypack_flat::sep::{pair_separation, Shape};
use polypack_flat::shapes::{bounding_radius, Config, Pose};
use polypack_flat::validate::{evaluate, parse_errors, server_check, strict_tolerance, strict_verify};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::BufRead;

#[derive(Default)]
struct Stats {
    cases: usize,
    parse_mismatch: usize,
    valid_agree: usize,
    rust_valid_ts_invalid: usize,
    rust_invalid_ts_valid: usize,
    check_unsafe: usize,
    check_stricter: usize,
    strict_mismatch: usize,
    fast_strict_mismatch: usize,
    fast_valid_mismatch: usize,
    verify_mismatch: usize,
    max_score_rel: f64,
    max_sep_abs: f64,
    max_fast_sep_abs: f64,
}

fn min_sep(n: u32, pieces: &[Pose], fast: bool) -> Option<f64> {
    let shape = Shape::new(n);
    let mut grid = NeighborGrid::new();
    grid.build(pieces, 2.0 * bounding_radius(n));
    let mut best = f64::INFINITY;
    grid.for_each_pair(pieces, |i, j| {
        let s = if fast { shape.sep(&pieces[i], &pieces[j]) } else { pair_separation(n, &pieces[i], &pieces[j], 1.0) };
        best = best.min(s);
        true
    });
    if best.is_finite() {
        Some(best)
    } else {
        None
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut fams: BTreeMap<String, Stats> = BTreeMap::new();
    let mut examples: Vec<String> = Vec::new();
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line).unwrap();
        let family = v["family"].as_str().unwrap().to_string();
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
        let config = Config { n, m, pieces: pieces.clone(), phi };
        let s = fams.entry(family.clone()).or_default();
        s.cases += 1;
        let parse_ok = parse_errors(n, m, p, &pieces, phi).is_empty();
        let ts_parse = v["parse_ok"].as_bool().unwrap();
        if parse_ok != ts_parse {
            s.parse_mismatch += 1;
            examples.push(format!("parse {family}: rust {parse_ok} ts {ts_parse}"));
            continue;
        }
        if !parse_ok {
            continue;
        }
        let ts_valid = v["valid"].as_bool().unwrap();
        let e = evaluate(&config, p, false, 20, true);
        if e.valid == ts_valid {
            s.valid_agree += 1;
        } else if e.valid {
            s.rust_valid_ts_invalid += 1;
            examples.push(format!("evaluate {family} N={n}: rust valid, ts invalid, ts min_sep {:?}", v["min_sep"]));
        } else {
            s.rust_invalid_ts_valid += 1;
            examples.push(format!("evaluate {family} N={n}: rust invalid, ts valid, ts min_sep {:?}", v["min_sep"]));
        }
        let c = server_check(&config, p);
        if c.valid && !ts_valid {
            s.check_unsafe += 1;
            examples.push(format!("UNSAFE {family} N={n}: the client check accepts, ts min_sep {:?}", v["min_sep"]));
        }
        if !c.valid && ts_valid {
            s.check_stricter += 1;
        }
        let ts_strict = v["strict"].as_bool().unwrap_or(false);
        if (c.valid && c.strict) != ts_strict {
            s.strict_mismatch += 1;
        }
        // the search framework's verdicts with the closed-form kernel
        let fast = min_sep(n, &pieces, true);
        let tol = strict_tolerance(&pieces);
        let fast_valid = fast.map_or(true, |x| !(x < -1e-9)) && pieces.len() == p;
        let fast_strict = fast_valid && fast.map_or(true, |x| !(x < -tol));
        if fast_valid != ts_valid {
            s.fast_valid_mismatch += 1;
        }
        if fast_strict != ts_strict {
            s.fast_strict_mismatch += 1;
        }
        if let (Some(ts), Some(rs)) = (v["min_sep"].as_f64(), min_sep(n, &pieces, false)) {
            s.max_sep_abs = s.max_sep_abs.max((ts - rs).abs());
        }
        if let (Some(ts), Some(fs)) = (v["min_sep"].as_f64(), fast) {
            s.max_fast_sep_abs = s.max_fast_sep_abs.max((ts - fs).abs());
        }
        if let (Some(ts), Some(rs)) = (v["score"].as_f64(), e.score) {
            if e.valid {
                s.max_score_rel = s.max_score_rel.max((ts - rs).abs() / ts.abs().max(1e-300));
            }
        }
        if let (Some(tv), Some(container)) = (v["strict_verify"].as_bool(), e.container) {
            if e.valid && strict_verify(n, &pieces, &container, 1e-8).ok != tv {
                s.verify_mismatch += 1;
            }
        }
    }
    println!(
        "{:<14} {:>6} {:>6} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>10} {:>10} {:>10}",
        "family", "cases", "parse", "agree", "r+/t-", "r-/t+", "UNSAFE", "stricter", "strict", "fastval", "faststr", "score rel", "sep abs", "fast sep"
    );
    let mut total = Stats::default();
    for (f, s) in &fams {
        println!(
            "{:<14} {:>6} {:>6} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>10.1e} {:>10.1e} {:>10.1e}",
            f, s.cases, s.parse_mismatch, s.valid_agree, s.rust_valid_ts_invalid, s.rust_invalid_ts_valid, s.check_unsafe, s.check_stricter, s.strict_mismatch, s.fast_valid_mismatch, s.fast_strict_mismatch, s.max_score_rel, s.max_sep_abs, s.max_fast_sep_abs
        );
        total.cases += s.cases;
        total.parse_mismatch += s.parse_mismatch;
        total.valid_agree += s.valid_agree;
        total.rust_valid_ts_invalid += s.rust_valid_ts_invalid;
        total.rust_invalid_ts_valid += s.rust_invalid_ts_valid;
        total.check_unsafe += s.check_unsafe;
        total.check_stricter += s.check_stricter;
        total.strict_mismatch += s.strict_mismatch;
        total.fast_valid_mismatch += s.fast_valid_mismatch;
        total.fast_strict_mismatch += s.fast_strict_mismatch;
        total.verify_mismatch += s.verify_mismatch;
        total.max_score_rel = total.max_score_rel.max(s.max_score_rel);
        total.max_sep_abs = total.max_sep_abs.max(s.max_sep_abs);
        total.max_fast_sep_abs = total.max_fast_sep_abs.max(s.max_fast_sep_abs);
    }
    println!(
        "{:<14} {:>6} {:>6} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>10.1e} {:>10.1e} {:>10.1e}",
        "TOTAL", total.cases, total.parse_mismatch, total.valid_agree, total.rust_valid_ts_invalid, total.rust_invalid_ts_valid, total.check_unsafe, total.check_stricter, total.strict_mismatch, total.fast_valid_mismatch, total.fast_strict_mismatch, total.max_score_rel, total.max_sep_abs, total.max_fast_sep_abs
    );
    println!("strictVerify mismatches: {}", total.verify_mismatch);
    for e in examples.iter().take(30) {
        println!("  {e}");
    }
}
