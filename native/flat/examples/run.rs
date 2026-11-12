//! Run one method on one problem and print the result as JSON:
//!
//!   cargo run --release --example run -- N M P METHOD SECONDS [EVALS] [SEED] [PARAMS_JSON] [START_JSON_FILE]

use polypack_flat::clock::ClockKind;
use polypack_flat::validate::server_check;
use polypack_flat::{run, Budget, Config, Control, Method, Pose, Problem, RunOptions};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: u32 = args[1].parse().unwrap();
    let m: u32 = args[2].parse().unwrap();
    let p: usize = args[3].parse().unwrap();
    let method = Method::from_name(&args[4]).expect("method");
    let seconds: f64 = args[5].parse().unwrap();
    let evals: Option<u64> = args.get(6).and_then(|s| s.parse().ok()).filter(|&e| e > 0);
    let seed: u32 = args.get(7).and_then(|s| s.parse().ok()).unwrap_or(1);
    let params: serde_json::Value = args.get(8).map(|s| serde_json::from_str(s).unwrap()).unwrap_or(serde_json::Value::Null);
    let start = args.get(9).map(|path| {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let pieces = v["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| Pose::new(q["x"].as_f64().unwrap(), q["y"].as_f64().unwrap(), q["theta"].as_f64().unwrap_or(0.0)))
            .collect();
        Config { n, m, pieces, phi: v["container_phi"].as_f64().unwrap_or(0.0) }
    });
    let control = Control::new();
    let t = std::time::Instant::now();
    let r = run(
        Problem::new(n, m, p),
        RunOptions {
            method,
            params,
            start,
            budget: Budget { evals, time_s: Some(seconds) },
            seed,
            final_polish: true,
            control: &control,
            clock: ClockKind::Wall,
        },
    );
    let check = r.best.as_ref().map(|b| server_check(b, p));
    let out = serde_json::json!({
        "score": r.score,
        "valid": r.valid,
        "strict": r.strict,
        "evaluations": r.evaluations,
        "termination": r.termination.as_str(),
        "seconds": t.elapsed().as_secs_f64(),
        "check_valid": check.as_ref().map(|c| c.valid),
        "check_strict": check.as_ref().map(|c| c.strict),
        "check_score": check.as_ref().and_then(|c| c.score),
        "reasons": r.reasons,
        "params": r.params,
        "pieces": r.best.as_ref().map(|b| b.pieces.iter().map(|q| serde_json::json!({"x": q.x, "y": q.y, "theta": q.theta})).collect::<Vec<_>>()),
        "container_phi": r.best.as_ref().map(|b| b.phi),
    });
    println!("{}", out);
}
