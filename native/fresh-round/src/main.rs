//! fresh-round --id ID --seconds S --seed K [--evals E]: the contract of native/FRESH.md.

use polypack_flat::clock::thread_cpu_seconds;
use polypack_fresh_round::search::Budget;
use polypack_fresh_round::{check, default_params, solve, Problem};
use serde_json::{json, Value};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned();
    let id = get("--id").unwrap_or_default();
    let seed: u64 = get("--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    let seconds: f64 = get("--seconds").and_then(|s| s.parse().ok()).unwrap_or(60.0);
    let evals: Option<u64> = get("--evals").and_then(|s| s.parse().ok());
    let t0 = thread_cpu_seconds();
    let clock = || thread_cpu_seconds();
    let empty = |n: u64| {
        json!({"solver": "fresh-round", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
               "score": null, "config": null, "evaluations": n, "check_valid": null, "trace": []})
    };
    let Some(problem) = Problem::parse(&id) else {
        eprintln!("fresh-round: not a problem of this solver: {id}");
        println!("{}", empty(0));
        return;
    };
    if !problem.can_exist() {
        eprintln!("fresh-round: {id} cannot exist (area / containment bound of the catalogue)");
        println!("{}", empty(0));
        return;
    }
    let mut params = default_params(&problem);
    if let Some(v) = get("--patience").and_then(|s| s.parse().ok()) {
        params.patience = v;
    }
    if let Some(v) = get("--mu0").and_then(|s| s.parse().ok()) {
        params.mu0 = v;
    }
    if let Some(v) = get("--mu-max").and_then(|s| s.parse().ok()) {
        params.mu_max = v;
    }
    if let Some(v) = get("--explore-tol").and_then(|s| s.parse().ok()) {
        params.explore_tol = v;
    }
    if let Some(v) = get("--max-iter").and_then(|s| s.parse().ok()) {
        params.max_iter = v;
    }
    if let Some(v) = get("--max-outer").and_then(|s| s.parse().ok()) {
        params.max_outer = v;
    }
    if a.iter().any(|x| x == "--frontier") {
        params.frontier = true;
    }
    if a.iter().any(|x| x == "--mbh") {
        params.frontier = false;
    }
    if let Some(v) = get("--delta").and_then(|s| s.parse().ok()) {
        params.delta = v;
    }
    if let Some(v) = get("--patience").and_then(|s| s.parse().ok()) {
        params.patience = v;
    }
    if let Some(v) = get("--polish-outer").and_then(|s| s.parse().ok()) {
        params.polish_outer = v;
    }
    if let Some(v) = get("--memory").and_then(|s| s.parse().ok()) {
        params.memory = v;
    }
    let budget = Budget { deadline: t0 + seconds, max_evals: evals };
    let report = solve(&id, &problem, seed, budget, params, &clock);
    let trace: Vec<Value> = report.trace.iter().map(|(t, b)| json!({"t": t, "best": b})).collect();
    let (score, config, valid) = match &report.best {
        Some(f) => {
            let again = check(problem.space(), &id, &f.config);
            (json!(f.score), f.config.clone(), json!(again.is_some() && again == Some(f.score)))
        }
        None => (Value::Null, Value::Null, Value::Null),
    };
    println!(
        "{}",
        json!({"solver": "fresh-round", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
               "score": score, "config": config, "evaluations": report.evaluations, "check_valid": valid,
               "trace": trace})
    );
}
