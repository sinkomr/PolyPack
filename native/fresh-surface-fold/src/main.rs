//! fresh-surface-fold --id ID --seconds S --seed K [--evals E]: the contract of native/FRESH.md.

use polypack_flat::clock::thread_cpu_seconds;
use polypack_fresh_surface_fold::model::Budget;
use polypack_fresh_surface_fold::search::Search;
use polypack_fresh_surface_fold::{check, Problem};
use serde_json::{json, Value};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned();
    let id = get("--id").unwrap_or_default();
    let seed: u64 = get("--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    let seconds: f64 = get("--seconds").and_then(|s| s.parse().ok()).unwrap_or(60.0);
    let evals: Option<u64> = get("--evals").and_then(|s| s.parse().ok());
    let t0 = thread_cpu_seconds();
    let clock = thread_cpu_seconds;
    let empty = |n: u64| {
        json!({"solver": "fresh-surface-fold", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
               "score": null, "config": null, "evaluations": n, "check_valid": null, "trace": []})
    };
    let Some(problem) = Problem::parse(&id) else {
        eprintln!("fresh-surface-fold: not a problem of this solver: {id}");
        println!("{}", empty(0));
        return;
    };
    let budget = Budget::new(t0 + seconds, evals, &clock);
    let mut checker = |c: &Value| check(&id, c);
    let search = match Search::new(&problem, seed, budget, &mut checker) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("fresh-surface-fold: {e}");
            println!("{}", empty(0));
            return;
        }
    };
    let report = search.run(None);
    let trace: Vec<Value> = report.trace.iter().map(|(t, b)| json!({"t": t, "best": b})).collect();
    let (score, config, valid) = match &report.best {
        Some(b) => {
            let again = check(&id, &b.config);
            (json!(b.score), b.config.clone(), json!(again.is_some() && again == Some(b.score)))
        }
        None => (Value::Null, Value::Null, Value::Null),
    };
    println!(
        "{}",
        json!({"solver": "fresh-surface-fold", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
               "score": score, "config": config, "evaluations": report.evaluations, "check_valid": valid,
               "trace": trace, "stopped": report.stopped})
    );
}
