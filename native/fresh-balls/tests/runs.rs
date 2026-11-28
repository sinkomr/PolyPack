//! Short runs: every reported packing passes the check at the reported score, the trace is the checked
//! improvements in order, and a run with an evaluation budget is reproducible from its seed.

use fresh_balls::{check, solve};

const IDS: &[&str] = &[
    "balls/ballinball/5",
    "balls/ballinball/13",
    "balls/ballincub/9",
    "balls/ballintet/11",
    "balls/ballinj86/20",
    "balls/ballinbp3/15",
    "balls/ballinj63/30",
    "balls/ballinbp10/10",
    "balls/ballinj52/7",
    "balls/ballinpr3l3/12",
];

#[test]
fn short_runs_give_checked_packings() {
    for (k, id) in IDS.iter().enumerate() {
        let out = solve(id, k as u64 + 1, 30.0, 60_000, false).unwrap();
        let score = out.score.unwrap_or_else(|| panic!("{id}: no packing"));
        let cfg = out.config.as_ref().unwrap();
        assert_eq!(check(id, cfg), Some(score), "{id}: the final packing fails the check");
        assert_eq!(cfg["s"].as_f64(), Some(score));
        assert!(!out.trace.is_empty());
        for w in out.trace.windows(2) {
            assert!(w[1].1 < w[0].1 && w[1].0 >= w[0].0, "{id}: trace not improving in time");
        }
        assert_eq!(out.trace.last().unwrap().1, score);
        assert!(out.evaluations >= 60_000 && out.evaluations < 70_000, "{id}: {} evaluations", out.evaluations);
    }
}

#[test]
fn evaluation_budget_runs_are_reproducible() {
    for id in ["balls/ballinball/17", "balls/ballinj55/12"] {
        let a = solve(id, 42, 60.0, 40_000, false).unwrap();
        let b = solve(id, 42, 60.0, 40_000, false).unwrap();
        assert_eq!(a.config, b.config, "{id}: same seed and budget, different packings");
        assert_eq!(a.evaluations, b.evaluations);
        let scores_a: Vec<f64> = a.trace.iter().map(|t| t.1).collect();
        let scores_b: Vec<f64> = b.trace.iter().map(|t| t.1).collect();
        assert_eq!(scores_a, scores_b);
        let c = solve(id, 43, 60.0, 40_000, false).unwrap();
        assert!(c.config.is_some());
    }
}
