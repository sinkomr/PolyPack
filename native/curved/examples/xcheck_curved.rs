//! Compares the native validator with the TypeScript verdicts in a case file written by
//! tools/xcheck-gen.ts (development tool).
//!
//!   cargo run --release --example xcheck_curved -p polypack-curved -- CASES.jsonl
//!
//! For every case: the mirror verdict (the server's computation as reproduced here) and the safe
//! verdict (the default, which errs strict) against the TypeScript verdict; for the loose rule the
//! smallest gaps against the TypeScript validator's. A safe acceptance of a configuration that the
//! TypeScript rule rejects is an error (exit status 1).

use polypack_curved::validate::{check_config_mode, validate_gaps, Mode};
use polypack_curved::{CurvedConfig, CurvedProblem, Rule};
use serde_json::Value;
use std::collections::BTreeMap;

fn main() {
    let path = std::env::args().nth(1).expect("usage: xcheck CASES.jsonl");
    let text = std::fs::read_to_string(&path).expect("read cases");
    let mut stats: BTreeMap<String, [u64; 6]> = BTreeMap::new();
    let mut lenient = 0u64;
    let mut gap_cases = 0u64;
    let mut gap_equal = 0u64;
    let mut max_diff = 0.0f64;
    let mut max_ratio = 0.0f64;
    let mut worst = String::new();
    let mut shown = 0;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).expect("json");
        let id = v["id"].as_str().unwrap();
        let rule_name = v["ruleName"].as_str().unwrap().to_string();
        let kind = v["kind"].as_str().unwrap().split(' ').next().unwrap().to_string();
        let ts_valid = v["ts"]["valid"].as_bool().unwrap();
        let problem = CurvedProblem::parse(id).expect("id");
        let rule = Rule {
            bound: v["rule"]["bound"].as_f64(),
            certified: v["rule"]["certified"].as_f64(),
            no_record: v["rule"]["noRecord"].as_bool().unwrap_or(false),
        };
        let config: Option<CurvedConfig> = serde_json::from_value(v["config"].clone()).ok();
        let (mirror, safe) = match &config {
            Some(c) => (
                check_config_mode(&problem, c, &rule, Mode::Mirror).valid,
                check_config_mode(&problem, c, &rule, Mode::Safe).valid,
            ),
            None => (false, false),
        };
        // [cases, mirror agrees, safe agrees, safe stricter, ts valid, safe valid]
        let e = stats.entry(format!("{rule_name:9} {kind}")).or_default();
        e[0] += 1;
        e[1] += (mirror == ts_valid) as u64;
        e[2] += (safe == ts_valid) as u64;
        e[3] += (!safe && ts_valid) as u64;
        e[4] += ts_valid as u64;
        e[5] += safe as u64;
        if safe && !ts_valid {
            lenient += 1;
            eprintln!("LENIENT {id} {rule_name} {}: {}", v["kind"], v["ts"]["reason"]);
        }
        if !safe && ts_valid && shown < 30 {
            shown += 1;
            let g = validate_gaps(&problem, config.as_ref().unwrap(), 1e-9, usize::MAX);
            eprintln!(
                "stricter: {id} {rule_name} {} gap {:e} safe {:e} magnitude {:.3}",
                v["kind"], g.min_gap, g.min_safe_gap, g.magnitude
            );
        }
        if mirror != ts_valid && shown < 30 {
            shown += 1;
            eprintln!(
                "mirror differs: {id} {rule_name} {} ts={ts_valid} reason={}",
                v["kind"], v["ts"]["reason"]
            );
        }
        if rule_name == "loose" {
            if let (Some(c), Some(ts_gap)) = (&config, v["ts"]["minGap"].as_f64()) {
                let g = validate_gaps(&problem, c, 1e-9, usize::MAX);
                if g.min_gap.is_finite() {
                    gap_cases += 1;
                    let d = (g.min_gap - ts_gap).abs();
                    if d == 0.0 {
                        gap_equal += 1;
                    }
                    let scale = f64::EPSILON * (1.0 + 2.0 * g.magnitude).powi(2);
                    let ratio = d / scale;
                    if ratio > max_ratio {
                        max_ratio = ratio;
                        worst = format!(
                            "{id} {} gap {} ts {} magnitude {}",
                            v["kind"], g.min_gap, ts_gap, g.magnitude
                        );
                    }
                    max_diff = max_diff.max(d);
                }
            }
        }
    }
    println!(
        "{:26} {:>7} {:>9} {:>9} {:>9} {:>8} {:>8}",
        "rule kind", "cases", "mirror=", "safe=", "stricter", "tsValid", "safeOK"
    );
    let mut tot = [0u64; 6];
    for (k, e) in &stats {
        println!(
            "{k:26} {:>7} {:>9} {:>9} {:>9} {:>8} {:>8}",
            e[0], e[1], e[2], e[3], e[4], e[5]
        );
        for i in 0..6 {
            tot[i] += e[i];
        }
    }
    println!(
        "{:26} {:>7} {:>9} {:>9} {:>9} {:>8} {:>8}",
        "total", tot[0], tot[1], tot[2], tot[3], tot[4], tot[5]
    );
    println!(
        "smallest gaps compared: {gap_cases}, bitwise equal {gap_equal}, largest difference {max_diff:e}, largest difference / (eps (1 + 2 magnitude)^2) {max_ratio:.3} ({worst})"
    );
    println!("safe acceptances of configurations the TypeScript rule rejects: {lenient}");
    if lenient > 0 {
        std::process::exit(1);
    }
}
