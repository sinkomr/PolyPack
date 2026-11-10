//! Checks polypack-js against Node: reads the vectors of native/tools/jsmath-vectors.mts and
//! counts, per function, the results that are not bit-identical (and the largest difference in
//! units in the last place). Exit code 1 when a format differs, when a function that must be exact
//! (sqrt, round, hypot) differs, or when any other differs by more than MAX_ULPS.
//!
//!   node --import tsx native/tools/jsmath-vectors.mts vec.jsonl
//!   cargo run --release -p polypack-js --example vectors -- vec.jsonl

use polypack_js::{fmt, math};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};

fn bits(v: &serde_json::Value) -> f64 {
    f64::from_bits(u64::from_str_radix(v.as_str().expect("hex"), 16).expect("hex"))
}

fn ulps(a: f64, b: f64) -> u64 {
    if a.is_nan() && b.is_nan() {
        return 0;
    }
    if a.is_nan() != b.is_nan() || a.is_sign_negative() != b.is_sign_negative() {
        return u64::MAX;
    }
    a.to_bits().abs_diff(b.to_bits())
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: vectors <vec.jsonl>");
    let file = BufReader::new(std::fs::File::open(&path).expect("vectors file"));
    // function -> (count, different, largest difference in ulps, first examples)
    let mut stats: BTreeMap<String, (u64, u64, u64, Vec<String>)> = BTreeMap::new();
    for line in file.lines() {
        let line = line.expect("line");
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(&line).expect("json");
        let f = v["f"].as_str().expect("f").to_string();
        let a: Vec<f64> = v["a"].as_array().expect("a").iter().map(bits).collect();
        let entry = stats.entry(f.clone()).or_insert((0, 0, 0, Vec::new()));
        entry.0 += 1;
        if let Some(kind) = f.strip_prefix("fmt:") {
            let want = v["s"].as_str().expect("s");
            let p = v["p"].as_i64().unwrap_or(0);
            let got = match kind {
                "string" => fmt::num(a[0]),
                "exponential" => fmt::exponential(a[0], if p < 0 { None } else { Some(p as usize) }),
                "fixed" => fmt::fixed(a[0], p as usize),
                "precision" => fmt::precision(a[0], p as usize),
                _ => panic!("unknown format {kind}"),
            };
            if got != want {
                entry.1 += 1;
                if entry.3.len() < 5 {
                    entry.3.push(format!("{:e} p={p}: node {want}, rust {got}", a[0]));
                }
            }
            continue;
        }
        let want = bits(&v["r"]);
        let got = match f.as_str() {
            "sin" => math::sin(a[0]),
            "cos" => math::cos(a[0]),
            "tan" => math::tan(a[0]),
            "asin" => math::asin(a[0]),
            "acos" => math::acos(a[0]),
            "atan" => math::atan(a[0]),
            "atanh" => math::atanh(a[0]),
            "asinh" => math::asinh(a[0]),
            "cbrt" => math::cbrt(a[0]),
            "exp" => math::exp(a[0]),
            "sinh" => math::sinh(a[0]),
            "cosh" => math::cosh(a[0]),
            "tanh" => math::tanh(a[0]),
            "log" => math::log(a[0]),
            "log2" => math::log2(a[0]),
            "log10" => math::log10(a[0]),
            "sqrt" => math::sqrt(a[0]),
            "round" => math::round(a[0]),
            "atan2" => math::atan2(a[0], a[1]),
            "pow" => math::pow(a[0], a[1]),
            "hypot" => math::hypot_of(&a),
            _ => panic!("unknown function {f}"),
        };
        let d = ulps(want, got);
        if d != 0 {
            entry.1 += 1;
            entry.2 = entry.2.max(d);
            if entry.3.len() < 3 {
                entry.3.push(format!("{:?} -> node {:e}, rust {:e}", a, want, got));
            }
        }
    }
    const MAX_ULPS: u64 = 2;
    const EXACT: [&str; 3] = ["sqrt", "round", "hypot"];
    let mut bad = 0;
    println!("{:<18} {:>8} {:>9} {:>10}", "function", "vectors", "different", "max ulps");
    for (f, (n, diff, max, examples)) in &stats {
        println!("{:<18} {:>8} {:>9} {:>10}", f, n, diff, if *max == u64::MAX { "sign/NaN".to_string() } else { max.to_string() });
        for e in examples {
            println!("    {e}");
        }
        if f.starts_with("fmt:") || EXACT.contains(&f.as_str()) {
            bad += diff;
        } else if *max > MAX_ULPS {
            bad += 1;
        }
    }
    if bad > 0 {
        println!("FAILED: {bad} results outside what is allowed");
        std::process::exit(1);
    }
    println!("formats, sqrt, round and hypot identical; the others within {MAX_ULPS} units in the last place");
}
