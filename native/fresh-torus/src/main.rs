//! fresh-torus --id torus/<family>/<N>/<P> --seconds S --seed K [--evals E]: the contract of native/FRESH.md.
use fresh_torus::search::check_default;
use polypack_flat::clock::thread_cpu_seconds;
use polypack_spaceauto::FreshJob;
use serde_json::json;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn main() {
    let t0 = thread_cpu_seconds();
    let a: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned();
    let id = get("--id").unwrap_or_default();
    let seed: u64 = get("--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    let seconds: f64 = get("--seconds").and_then(|s| s.parse().ok()).unwrap_or(60.0);
    let evals: Option<u64> = get("--evals").and_then(|s| s.parse().ok());
    let verbose = a.iter().any(|x| x == "--verbose");
    let stop = AtomicBool::new(false);
    // the wall clock only guards against a stalled machine; the CPU budget is the clock
    let deadline = Instant::now() + Duration::from_secs_f64(4.0 * seconds + 120.0);
    let job = FreshJob { id: &id, seed, cpu_seconds: seconds - (thread_cpu_seconds() - t0), deadline, stop: &stop, start: None, max_evals: evals };
    let mut trace: Vec<(f64, f64)> = Vec::new();
    let out = fresh_torus::run(&job, &mut |score, _cfg| trace.push((thread_cpu_seconds() - t0, score)));
    match out {
        Err(e) => {
            println!(
                "{}",
                json!({"solver": "fresh-torus", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu", "score": null, "config": null,
                       "evaluations": 0, "check_valid": null, "trace": [], "error": e})
            );
        }
        Ok(info) => {
            if verbose {
                eprintln!("{}", info.stats);
            }
            let r = info.result;
            let valid = r.config.as_ref().map(|c| check_default(&id, c).is_some());
            let tr: Vec<_> = trace.iter().map(|&(t, b)| json!({"t": t, "best": b})).collect();
            println!(
                "{}",
                json!({"solver": "fresh-torus", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
                       "score": r.score, "config": r.config, "evaluations": r.evaluations, "check_valid": valid,
                       "trace": tr, "stopped": r.stopped, "engine_seconds": thread_cpu_seconds() - t0, "stats": info.stats})
            );
        }
    }
}
