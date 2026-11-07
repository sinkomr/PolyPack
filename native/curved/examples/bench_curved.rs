//! Runs jobs on a panel of problems and prints one JSON line per job (development tool).
//!
//!   cargo run --release --example bench_curved -p polypack-curved -- --ids curved/-1/3/6/8,curved/0.1/0/0/40 --seeds 1,2 \
//!       --seconds 10 [--evals N] [--save DIR] [--loose] [--bound]
//!
//! --seconds: CPU seconds per job (thread CPU time). --evals: evaluation cap (restarts plus hops).
//! --save: write each job's configuration to DIR/<id with _>-<seed>.json. --loose: check
//! results at 1e-9 only (default: the strict rule of a problem without a research record); --bound: with the problem's
//! lower bound.

use polypack_curved::{run_job_with, Budget, CurvedProblem, JobOptions, Rule};
use std::sync::atomic::AtomicBool;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == &format!("--{name}"))
        .and_then(|i| args.get(i + 1).cloned())
}

fn flag(name: &str) -> bool {
    std::env::args().any(|a| a == format!("--{name}"))
}

fn main() {
    let ids = arg("ids").unwrap_or_else(|| "curved/-1/3/6/8".into());
    let seeds: Vec<u64> = arg("seeds")
        .unwrap_or_else(|| "1".into())
        .split(',')
        .map(|s| s.parse().unwrap())
        .collect();
    let seconds: Option<f64> = arg("seconds").map(|s| s.parse().unwrap());
    let evals: Option<u64> = arg("evals").map(|s| s.parse().unwrap());
    let save = arg("save");
    let label = arg("label").unwrap_or_else(|| "native".into());
    let stop = AtomicBool::new(false);
    for id in ids.split(',') {
        let problem = CurvedProblem::parse(id).expect("a curved problem id");
        for &seed in &seeds {
            let rule = Rule {
                bound: if flag("bound") { problem.lower_bound() } else { None },
                certified: None,
                no_record: !flag("loose"),
            };
            let opts = JobOptions {
                rule,
                ..JobOptions::default()
            };
            let out = run_job_with(
                &problem,
                None,
                Budget {
                    evals,
                    cpu_seconds: seconds,
                },
                seed,
                &stop,
                &opts,
            );
            let line = format!(
                "{{\"label\":\"{label}\",\"id\":\"{id}\",\"seed\":{seed},\"seconds\":{},\"score\":{},\"valid\":{},\"evaluations\":{},\"cpu\":{:.3},\"evalsPerCpuS\":{:.3},\"rounds\":{},\"repairs\":{},\"polishes\":{},\"pivots\":{},\"repairS\":{:.2},\"polishS\":{:.2},\"termination\":\"{:?}\"}}",
                seconds.map_or("null".into(), |s| s.to_string()),
                out.score.map_or("null".into(), |s| format!("{s}")),
                out.config.is_some(),
                out.evaluations,
                out.seconds,
                out.evaluations as f64 / out.seconds.max(1e-9),
                out.rounds,
                out.repairs,
                out.polishes,
                out.lp_pivots,
                out.repair_seconds,
                out.polish_seconds,
                out.termination,
            );
            println!("{line}");
            if let (Some(dir), Some(c)) = (&save, &out.config) {
                let path = format!("{dir}/{}-{seed}.json", id.replace('/', "_"));
                std::fs::write(path, serde_json::to_string(c).unwrap()).unwrap();
            }
        }
    }
}
