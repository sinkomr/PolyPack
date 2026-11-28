//! fresh-surface-nofold --id surface/<solid>/nofold/<N>/<P> --seconds S --seed K [--evals E] [--verbose]:
//! the contract of native/FRESH.md.
use fresh_surface_nofold::solve;
use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};
use serde_json::json;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned();
    let id = get("--id").unwrap_or_default();
    let seed: u64 = get("--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    let seconds: f64 = get("--seconds").and_then(|s| s.parse().ok()).unwrap_or(60.0);
    let evals: Option<u64> = get("--evals").and_then(|s| s.parse().ok());
    let verbose = a.iter().any(|x| x == "--verbose");
    let out = match solve(&id, seed, seconds, evals, None, None, None) {
        Ok(o) => o,
        Err(e) => {
            println!(
                "{}",
                json!({"solver": "fresh-surface-nofold", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
                       "score": null, "config": null, "evaluations": 0, "check_valid": null, "trace": [], "error": e})
            );
            return;
        }
    };
    if verbose {
        eprintln!("{}", out.stats);
    }
    let check_valid = out.config.as_ref().map(|c| validate_space_submission(SpaceName::Surface, &id, c, &SpaceValidateOptions::default()).valid);
    let trace: Vec<_> = out.trace.iter().map(|&(t, b)| json!({"t": t, "best": b})).collect();
    println!(
        "{}",
        json!({"solver": "fresh-surface-nofold", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
               "score": out.score, "config": out.config, "evaluations": out.evaluations, "check_valid": check_valid,
               "trace": trace, "stopped": out.stopped})
    );
}
