//! fresh-balls --id balls/ballin<container>/<P> --seconds S --seed K [--evals E] [--verbose]
//!
//! Prints one JSON line (native/FRESH.md): the best checked packing, its score, the evaluations, and the trace
//! of checked improvements against this thread's CPU time.

use serde_json::{json, Value};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned();
    let id = get("--id").unwrap_or_default();
    let seed: u64 = get("--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    let seconds: f64 = get("--seconds").and_then(|s| s.parse().ok()).unwrap_or(60.0);
    let max_evals: u64 = get("--evals").and_then(|s| s.parse().ok()).unwrap_or(u64::MAX);
    let verbose = a.iter().any(|x| x == "--verbose");
    match fresh_balls::solve(&id, seed, seconds, max_evals, verbose) {
        Ok(out) => {
            if verbose {
                eprintln!("{}", out.stats);
            }
            let valid = match &out.config {
                Some(c) => json!(fresh_balls::check(&id, c).is_some()),
                None => Value::Null,
            };
            let trace: Vec<Value> = out.trace.iter().map(|(t, b)| json!({"t": t, "best": b})).collect();
            println!(
                "{}",
                json!({"solver": "fresh-balls", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
                       "score": out.score, "config": out.config, "evaluations": out.evaluations,
                       "check_valid": valid, "trace": trace})
            );
        }
        Err(e) => {
            eprintln!("fresh-balls: {e}");
            println!(
                "{}",
                json!({"solver": "fresh-balls", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu", "score": null,
                       "config": null, "evaluations": 0, "check_valid": null, "trace": []})
            );
        }
    }
}
