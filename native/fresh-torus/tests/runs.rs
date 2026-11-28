//! Whole runs through `fresh_search`: valid packings at the reported score with an improving trace, runs with an
//! evaluation budget repeat exactly, the stop flag and the wall deadline end a run promptly, a valid start is
//! never returned worse. Run with an optimised profile: `cargo test --release -p polypack-fresh-torus`.

use fresh_torus::search::check_default;
use fresh_torus::{fresh_search, run};
use polypack_spaceauto::FreshJob;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

fn job<'a>(id: &'a str, seed: u64, seconds: f64, evals: Option<u64>, stop: &'a AtomicBool, start: Option<&'a Value>) -> FreshJob<'a> {
    FreshJob { id, seed, cpu_seconds: seconds, deadline: Instant::now() + Duration::from_secs(600), stop, start, max_evals: evals }
}

#[test]
fn short_runs_are_valid_with_an_improving_trace() {
    let ids = [
        "torus/sq/0/9",
        "torus/hex/0/23",
        "torus/free/3/7",
        "torus/sq/4/10",
        "torus/hex/5/12",
        "torus/free/7/6",
        "torus/sq/6/5",
        "torus/hex/8/3",
        "torus/free/12/4",
        "torus/sq/40/8",
        "torus/hex/100/5",
        "torus/sq/5/1",
        "torus/free/9/60",
    ];
    let stop = AtomicBool::new(false);
    for id in ids {
        let mut seen: Vec<(f64, Value)> = Vec::new();
        let info = run(&job(id, 7, 0.6, None, &stop, None), &mut |s, c| seen.push((s, c.clone()))).expect("a torus id");
        let r = &info.result;
        let score = r.score.expect("a packing");
        let cfg = r.config.as_ref().expect("a configuration");
        let checked = check_default(id, cfg).expect("the result passes the check");
        assert_eq!(checked, score, "{id}: reported score is the checked one");
        assert!(!seen.is_empty(), "{id}: on_improve was called");
        for w in seen.windows(2) {
            assert!(w[1].0 < w[0].0, "{id}: improvements decrease");
        }
        assert_eq!(seen.last().unwrap().0, score, "{id}: the last improvement is the result");
        for (s, c) in &seen {
            assert_eq!(check_default(id, c), Some(*s), "{id}: every improvement passes the check at its score");
        }
        assert_eq!(info.trace.len(), seen.len());
    }
}

#[test]
fn evaluation_budget_runs_repeat() {
    let stop = AtomicBool::new(false);
    for (id, evals) in [("torus/hex/0/11", 30000u64), ("torus/sq/5/9", 20000), ("torus/free/7/8", 20000), ("torus/hex/50/6", 8000)] {
        let a = fresh_search(&job(id, 3, 1000.0, Some(evals), &stop, None), &mut |_, _| {}).unwrap();
        let b = fresh_search(&job(id, 3, 1000.0, Some(evals), &stop, None), &mut |_, _| {}).unwrap();
        assert_eq!(a.stopped, "evals", "{id}");
        assert_eq!(a.evaluations, b.evaluations, "{id}");
        assert_eq!(a.score, b.score, "{id}");
        assert_eq!(a.config, b.config, "{id}");
        let c = fresh_search(&job(id, 4, 1000.0, Some(evals), &stop, None), &mut |_, _| {}).unwrap();
        assert!(c.score.is_some());
    }
}

#[test]
fn stop_flag_and_deadline_end_a_run_promptly() {
    for id in ["torus/sq/0/40", "torus/hex/7/30", "torus/free/60/25", "torus/sq/9/300"] {
        // the stop flag, set from another thread
        let stop = AtomicBool::new(false);
        let t0 = Instant::now();
        let r = std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_millis(400));
                stop.store(true, Ordering::Relaxed);
            });
            fresh_search(&job(id, 1, 1000.0, None, &stop, None), &mut |_, _| {}).unwrap()
        });
        let took = t0.elapsed().as_secs_f64();
        assert_eq!(r.stopped, "stop", "{id}");
        assert!(took < 0.4 + 0.2, "{id}: stopped {took:.3} s after start (flag at 0.4 s)");
        assert!(r.score.is_some(), "{id}: a packing by then");
        // the wall deadline
        let stop = AtomicBool::new(false);
        let t0 = Instant::now();
        let mut j = job(id, 1, 1000.0, None, &stop, None);
        j.deadline = t0 + Duration::from_millis(300);
        let r = fresh_search(&j, &mut |_, _| {}).unwrap();
        let took = t0.elapsed().as_secs_f64();
        assert_eq!(r.stopped, "deadline", "{id}");
        assert!(took < 0.3 + 0.2, "{id}: returned {took:.3} s after start (deadline 0.3 s)");
        // the CPU budget (this thread's CPU time: the tests share the machine)
        let c0 = polypack_flat::clock::thread_cpu_seconds();
        let r = fresh_search(&job(id, 1, 0.3, None, &stop, None), &mut |_, _| {}).unwrap();
        let took = polypack_flat::clock::thread_cpu_seconds() - c0;
        assert_eq!(r.stopped, "cpu", "{id}");
        assert!(took < 0.3 + 0.2, "{id}: returned after {took:.3} CPU s (budget 0.3)");
    }
}

#[test]
fn a_valid_start_is_never_returned_worse() {
    let stop = AtomicBool::new(false);
    for id in ["torus/sq/0/14", "torus/hex/5/9", "torus/free/7/10"] {
        // a good start: a longer run's result
        let good = fresh_search(&job(id, 11, 1.5, None, &stop, None), &mut |_, _| {}).unwrap();
        let cfg = good.config.clone().unwrap();
        let s0 = good.score.unwrap();
        let mut calls = Vec::new();
        let r = fresh_search(&job(id, 12, 0.3, None, &stop, Some(&cfg)), &mut |s, _| calls.push(s)).unwrap();
        let s = r.score.unwrap();
        assert!(s <= s0, "{id}: from a start at {s0} it returned {s}");
        assert_eq!(check_default(id, r.config.as_ref().unwrap()), Some(s));
        for c in calls {
            assert!(c < s0, "{id}: on_improve only below the start");
        }
        // with no CPU at all, the start itself comes back
        let r = fresh_search(&job(id, 12, 0.0, None, &stop, Some(&cfg)), &mut |_, _| {}).unwrap();
        assert!(r.score.unwrap() <= s0);
    }
    // an invalid start is ignored
    let bad: Value = serde_json::json!({"lattice": {"L": 1.0}, "poses": [[0, 0, 0], [0.1, 0, 0]]});
    let r = fresh_search(&job("torus/sq/0/2", 1, 0.2, None, &stop, Some(&bad)), &mut |_, _| {}).unwrap();
    assert!(r.score.unwrap() > 1.0);
    assert!(check_default("torus/sq/0/2", r.config.as_ref().unwrap()).is_some());
}

#[test]
fn other_ids_are_refused() {
    let stop = AtomicBool::new(false);
    for id in ["sphere/0/20", "torus/oct/0/5", "torus/sq/2/5", "torus/sq/0/0", "flat/3/4/8", "torus/sq/0/501"] {
        assert!(fresh_search(&job(id, 1, 0.1, None, &stop, None), &mut |_, _| {}).is_err(), "{id}");
    }
}
