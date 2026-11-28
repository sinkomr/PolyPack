//! Short seeded runs give packings that pass the server's check, reproducibly.

use polypack_flat::clock::thread_cpu_seconds;
use polypack_fresh_round::search::Budget;
use polypack_fresh_round::{check, default_params, solve, Problem};

fn run(id: &str, seed: u64, evals: u64) -> (Option<f64>, Option<serde_json::Value>, usize) {
    let problem = Problem::parse(id).expect("a problem");
    assert!(problem.can_exist());
    let clock = || thread_cpu_seconds();
    let budget = Budget { deadline: thread_cpu_seconds() + 60.0, max_evals: Some(evals) };
    let report = solve(id, &problem, seed, budget, default_params(&problem), &clock);
    let best = report.best.map(|b| (b.score, b.config));
    // the trace improves strictly and ends at the reported score
    for w in report.trace.windows(2) {
        assert!(w[1].1 < w[0].1 && w[1].0 >= w[0].0);
    }
    if let Some((score, _)) = &best {
        assert_eq!(report.trace.last().map(|e| e.1), Some(*score));
    }
    (best.as_ref().map(|b| b.0), best.map(|b| b.1), report.trace.len())
}

#[test]
fn short_runs_pass_the_check() {
    for (id, evals) in [
        ("curved/-1/0/0/9", 60_000u64),
        ("curved/-1/0/6/6", 60_000),
        ("curved/1/0/0/5", 60_000),
        ("curved/1/0/4/6", 60_000),
        ("curved/-1/0/8/8", 60_000),
        ("sphere/0/12", 60_000),
        ("sphere/0/31", 100_000),
    ] {
        let problem = Problem::parse(id).unwrap();
        let (score, config, n) = run(id, 7, evals);
        let score = score.unwrap_or_else(|| panic!("{id}: no packing"));
        let config = config.unwrap();
        assert!(n >= 1);
        assert_eq!(check(problem.space(), id, &config), Some(score), "{id}");
    }
}

#[test]
fn a_run_is_reproducible_from_its_seed() {
    for id in ["curved/-1/0/0/11", "sphere/0/20"] {
        let a = run(id, 3, 40_000);
        let b = run(id, 3, 40_000);
        assert_eq!(a.0, b.0, "{id}");
        assert_eq!(a.1, b.1, "{id}");
    }
}

#[test]
fn known_optima_are_found() {
    // sphere/0/12: the icosahedron, rho = 1 / acos(1 / sqrt 5) [EST: Tammes, P = 12]
    let (score, _, _) = run("sphere/0/12", 1, 200_000);
    let ico = 1.0 / (1.0 / 5f64.sqrt()).acos();
    assert!((score.unwrap() / ico - 1.0).abs() < 1e-9, "{score:?} vs {ico}");
    // sphere/0/6: the octahedron, rho = 2 / pi
    let (score, _, _) = run("sphere/0/6", 1, 100_000);
    assert!((score.unwrap() / (2.0 / std::f64::consts::PI) - 1.0).abs() < 1e-9, "{score:?}");
}

#[test]
fn impossible_problems_are_recognised() {
    for id in ["curved/1/0/0/17", "curved/-1/0/4/28", "curved/1/0/5/10", "curved/-1/0/8/29"] {
        assert!(!Problem::parse(id).unwrap().can_exist(), "{id}");
    }
    assert!(Problem::parse("curved/-1/0/0/17").unwrap().can_exist());
    assert!(Problem::parse("flat/0/0/5").is_none());
    assert!(Problem::parse("curved/-1/3/0/5").is_none());
}
