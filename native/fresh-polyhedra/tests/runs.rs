//! Whole runs: valid packings at the reported score with an improving trace, reproducibility with an evaluation
//! budget, and the library interface (stop flag, deadline, start, ids it does not handle).

use fresh_polyhedra::{fresh_search, solve};
use polypack_spaceauto::FreshJob;
use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

fn space_of(id: &str) -> SpaceName {
    if id.starts_with("balls/") {
        SpaceName::Balls
    } else {
        SpaceName::Polyhedra
    }
}

fn checked(id: &str, cfg: &Value) -> Option<f64> {
    let v = validate_space_submission(space_of(id), id, cfg, &SpaceValidateOptions::default());
    v.valid.then_some(v.score).flatten()
}

/// Ten problems of different families and sizes.
const RUNS: [&str; 10] = [
    "polyhedra/tetintet/6",
    "polyhedra/cubincub/8",
    "polyhedra/octinico/3",
    "polyhedra/tocintoc/4",
    "polyhedra/pr3l3incub/7",
    "polyhedra/ap5incub/9",
    "polyhedra/j12inj86/5",
    "polyhedra/kthindod/12",
    "balls/icoinball/5",
    "balls/j20inball/3",
];

#[test]
fn short_runs_give_valid_packings_with_an_improving_trace() {
    for (k, id) in RUNS.iter().enumerate() {
        let out = solve(id, 1 + k as u64, 0.6, u64::MAX, false).unwrap();
        let cfg = out.config.as_ref().expect("a packing");
        let score = out.score.unwrap();
        assert_eq!(checked(id, cfg), Some(score), "{id}: the check disagrees with the reported score");
        // the strict check too (a problem without a research record asks it of every entry)
        let strict = SpaceValidateOptions { no_record: true, ..SpaceValidateOptions::default() };
        assert!(validate_space_submission(space_of(id), id, cfg, &strict).valid, "{id}: not strictly valid");
        assert!(!out.trace.is_empty());
        for w in out.trace.windows(2) {
            assert!(w[1].1 < w[0].1 && w[1].0 >= w[0].0, "{id}: trace not improving: {:?}", out.trace);
        }
        assert_eq!(out.trace.last().unwrap().1, score, "{id}: the trace ends elsewhere");
        let bound = fresh_polyhedra::model::Problem::parse(id).unwrap().bound;
        assert!(score >= bound * (1.0 - 1e-12), "{id}: below the lower bound");
    }
}

#[test]
fn runs_with_an_evaluation_budget_are_reproducible() {
    for id in ["polyhedra/tetintet/7", "polyhedra/pr5inj03/4", "balls/cubinball/6", "polyhedra/octincub/40"] {
        let a = solve(id, 3, 1e6, 40_000, false).unwrap();
        let b = solve(id, 3, 1e6, 40_000, false).unwrap();
        assert_eq!(a.evaluations, b.evaluations, "{id}");
        assert_eq!(a.score, b.score, "{id}");
        assert_eq!(a.config, b.config, "{id}");
        let sa: Vec<f64> = a.trace.iter().map(|e| e.1).collect();
        let sb: Vec<f64> = b.trace.iter().map(|e| e.1).collect();
        assert_eq!(sa, sb, "{id}");
        assert!(a.evaluations <= 40_000 + 50, "{id}: {} evaluations", a.evaluations);
    }
}

fn job<'a>(id: &'a str, seconds: f64, deadline: Instant, stop: &'a AtomicBool, start: Option<&'a Value>) -> FreshJob<'a> {
    FreshJob { id, seed: 5, cpu_seconds: seconds, deadline, stop, start, max_evals: None }
}

#[test]
fn fresh_search_honours_the_stop_flag_and_the_deadline() {
    // the stop flag, set from another thread after 0.3 s
    let stop = AtomicBool::new(false);
    let t0 = Instant::now();
    let res = std::thread::scope(|sc| {
        sc.spawn(|| {
            std::thread::sleep(Duration::from_millis(300));
            stop.store(true, Ordering::Relaxed);
        });
        let far = Instant::now() + Duration::from_secs(60);
        fresh_search(&job("polyhedra/tteintte/9", 60.0, far, &stop, None), &mut |_, _| {}).unwrap()
    });
    let wall = t0.elapsed().as_secs_f64();
    assert!(wall < 0.3 + 0.25, "stopped after {wall} s");
    assert_eq!(res.stopped, "stop");
    assert!(res.config.is_some());
    // the wall deadline
    let stop = AtomicBool::new(false);
    let t0 = Instant::now();
    let res = fresh_search(&job("polyhedra/j37inico/30", 60.0, Instant::now() + Duration::from_millis(400), &stop, None), &mut |_, _| {}).unwrap();
    let wall = t0.elapsed().as_secs_f64();
    assert!(wall < 0.4 + 0.25, "deadline: stopped after {wall} s");
    assert_eq!(res.stopped, "deadline");
    let cfg = res.config.unwrap();
    assert_eq!(checked("polyhedra/j37inico/30", &cfg), res.score);
    // ids of other engines
    let far = Instant::now() + Duration::from_secs(5);
    assert!(fresh_search(&job("balls/ballinball/13", 1.0, far, &stop, None), &mut |_, _| {}).is_err());
    assert!(fresh_search(&job("balls/ballincub/13", 1.0, far, &stop, None), &mut |_, _| {}).is_err());
    assert!(fresh_search(&job("sphere/0/24", 1.0, far, &stop, None), &mut |_, _| {}).is_err());
}

#[test]
fn a_valid_start_is_never_returned_worse() {
    let id = "polyhedra/octintet/5";
    let stop = AtomicBool::new(false);
    let far = Instant::now() + Duration::from_secs(60);
    // a good packing from a first search
    let first = fresh_search(&job(id, 1.0, far, &stop, None), &mut |_, _| {}).unwrap();
    let start = first.config.unwrap();
    let s0 = first.score.unwrap();
    // a short search from it: never worse, and every improvement reported is below it and checked
    let mut seen: Vec<f64> = Vec::new();
    let res = fresh_search(&job(id, 0.3, far, &stop, Some(&start)), &mut |s, cfg| {
        assert_eq!(checked(id, cfg), Some(s));
        seen.push(s);
    })
    .unwrap();
    let s1 = res.score.unwrap();
    assert!(s1 <= s0, "{s1} worse than the start {s0}");
    assert!(seen.iter().all(|&s| s < s0));
    assert_eq!(checked(id, res.config.as_ref().unwrap()), Some(s1));
    // a poor but valid start (the first search's packing scaled up) is improved on
    let mut big = start.clone();
    let s = big["s"].as_f64().unwrap();
    big["s"] = Value::from(s * 1.5);
    for p in big["pieces"].as_array_mut().unwrap() {
        for k in 0..3 {
            let v = p[k].as_f64().unwrap();
            p[k] = Value::from(v * 1.2);
        }
    }
    assert!(checked(id, &big).is_some());
    let res = fresh_search(&job(id, 0.3, far, &stop, Some(&big)), &mut |_, _| {}).unwrap();
    assert!(res.score.unwrap() < s * 1.5);
}
