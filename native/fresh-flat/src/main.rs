//! fresh-flat --id flat/N/M/P --seconds S --seed K [--evals E]: the contract of native/FRESH.md.
use polypack_flat::clock::thread_cpu_seconds;
use polypack_fresh_flat::search::Search;
use serde_json::json;

fn main() {
    let t0 = thread_cpu_seconds();
    let a: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned();
    let id = get("--id").unwrap_or_default();
    let seed: u64 = get("--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    let seconds: f64 = get("--seconds").and_then(|s| s.parse().ok()).unwrap_or(60.0);
    let evals: Option<u64> = get("--evals").and_then(|s| s.parse().ok());
    let parts: Vec<&str> = id.split('/').collect();
    let parsed = if parts.len() == 4 && parts[0] == "flat" {
        match (parts[1].parse::<usize>(), parts[2].parse::<usize>(), parts[3].parse::<usize>()) {
            (Ok(n), Ok(m), Ok(p)) if (n == 0 || (3..=16).contains(&n)) && (m == 0 || (3..=100).contains(&m)) && (2..=500).contains(&p) => Some((n, m, p)),
            _ => None,
        }
    } else {
        None
    };
    let Some((n, m, p)) = parsed else {
        println!("{}", json!({"solver": "fresh-flat", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu", "score": null, "config": null, "evaluations": 0, "check_valid": null, "trace": [], "error": "unsupported id"}));
        return;
    };
    let mut s = Search::new(n, m, p, seed, t0);
    s.model.deadline = t0 + seconds;
    if let Some(e) = evals {
        s.model.eval_limit = e;
    }
    s.run();
    if s.debug {
        let md = &s.model;
        eprintln!("calls {} iters {} rebuilds {} exits {:?} evals {} evals/iter {:.2}", md.stat_calls, md.stat_iters, md.stat_rebuilds, md.stat_exit, md.evals, md.evals as f64 / md.stat_iters.max(1) as f64);
        eprintln!("moves tries {:?} wins {:?}", s.move_tries, s.move_wins);
    }
    let trace: Vec<_> = s.trace.iter().map(|&(t, b)| json!({"t": t, "best": b})).collect();
    let (score, config, valid) = if s.best_q.is_empty() {
        (serde_json::Value::Null, serde_json::Value::Null, serde_json::Value::Null)
    } else {
        let cfg = s.config(&s.best_q);
        let chk = polypack_flat::validate::server_check(&cfg, p);
        let pieces: Vec<_> = cfg.pieces.iter().map(|q| json!({"x": q.x, "y": q.y, "theta": q.theta})).collect();
        (
            json!(chk.score),
            json!({"N": n, "M": m, "P": p, "container_phi": cfg.phi, "pieces": pieces}),
            json!(chk.valid && chk.strict),
        )
    };
    println!(
        "{}",
        json!({"solver": "fresh-flat", "id": id, "seed": seed, "seconds": seconds, "clock": "cpu",
               "score": score, "config": config, "evaluations": s.model.evals, "check_valid": valid,
               "trace": trace, "starts": s.starts, "hops": s.hops, "checks": s.checks})
    );
}
