//! `auto::auto_search`: valid packings for balls in a ball, a cube and other solids and for solids in a ball,
//! small and medium P, fresh and warm-started, and the job's stop, deadline and budget.

use polypack_balls::auto::{auto_search, parse_id, METHOD};
use polypack_balls::{validate_balls, BallsConfig, BallsValidateOptions};
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn run(id: &str, start: Option<&Value>, seed: u32, evals: u64) -> AutoResult {
    let stop = AtomicBool::new(false);
    let job = AutoJob {
        id,
        start,
        seed,
        max_evals: Some(evals),
        deadline: Instant::now() + Duration::from_secs(120),
        stop: &stop,
    };
    auto_search(&job).unwrap()
}

/// Checks the result's config with the crate's own validator at the server's tolerance and returns its score.
fn verify(id: &str, r: &AutoResult) -> f64 {
    let b = parse_id(id).unwrap();
    let c = r.config.as_ref().expect("a config");
    let config = BallsConfig {
        s: c["s"].as_f64().unwrap(),
        pieces: c["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect())
            .collect(),
    };
    assert_eq!(config.pieces.len(), b.p, "{id} pieces");
    let width = if b.problem.piece == "ball" { 3 } else { 7 };
    assert!(config.pieces.iter().all(|p| p.len() == width), "{id} width");
    let v = validate_balls(b.problem, &config, &BallsValidateOptions { tol: Some(1e-9), max_errors: None }).unwrap();
    assert!(v.valid, "{id}: {:?}", v.errors);
    // the search's results are valid at tolerance 0
    let v0 = validate_balls(b.problem, &config, &BallsValidateOptions { tol: Some(0.0), max_errors: None }).unwrap();
    assert!(v0.valid, "{id} at 0: {:?}", v0.errors);
    assert_eq!(r.score, Some(config.s), "{id} score");
    assert_eq!(r.method, METHOD);
    config.s
}

#[test]
fn fresh_and_warm_for_each_kind_of_problem() {
    // (id, fresh evaluations, warm evaluations)
    let cases = [
        ("balls/ballinball/5", 3000, 1500),
        ("balls/ballinball/20", 6000, 2000),
        ("balls/ballincub/9", 4000, 1500),
        ("balls/ballinpkd/8", 4000, 1500),
        ("balls/ballintet/6", 4000, 1500),
        ("balls/tetinball/4", 3000, 1500),
        ("balls/cubinball/6", 4000, 1500),
        ("balls/icoinball/3", 3000, 1500),
        ("balls/pr3inball/5", 3000, 1500),
    ];
    for (id, fresh, warm) in cases {
        let a = run(id, None, 7, fresh);
        assert_eq!(a.stopped, "evals", "{id}");
        assert!(a.evaluations > 0 && a.evaluations <= fresh);
        let sa = verify(id, &a);
        // warm start from that result: never worse, and the start is a candidate
        let b = run(id, a.config.as_ref(), 8, warm);
        let sb = verify(id, &b);
        assert!(sb <= sa, "{id}: warm {sb} > start {sa}");
    }
}

#[test]
fn a_zero_budget_returns_the_start() {
    let id = "balls/ballinball/7";
    let a = run(id, None, 3, 3000);
    let b = run(id, a.config.as_ref(), 3, 0);
    assert_eq!(b.config, a.config);
    assert_eq!(b.stopped, "evals");
    // without a start, the fresh start (random centres or a lattice cut, legalized) is kept before any evaluation
    let c = run(id, None, 3, 0);
    assert_eq!(c.stopped, "evals");
    assert_eq!(c.evaluations, 0);
    verify(id, &c);
}

#[test]
fn an_overlapping_or_loose_start_is_repaired() {
    let id = "balls/ballincub/8";
    let a = run(id, None, 5, 3000);
    let c = a.config.as_ref().unwrap();
    // the pieces pulled together: the start itself is invalid, the result is valid
    let crushed: Vec<Value> = c["pieces"].as_array().unwrap().iter().map(|p| json!([p[0].as_f64().unwrap() * 0.7, p[1].as_f64().unwrap() * 0.7, p[2].as_f64().unwrap() * 0.7])).collect();
    let start = json!({ "s": c["s"], "pieces": crushed });
    let r = run(id, Some(&start), 6, 2500);
    verify(id, &r);
    // the container too large
    let start = json!({ "s": c["s"].as_f64().unwrap() * 1.5, "pieces": c["pieces"] });
    let r = run(id, Some(&start), 6, 2500);
    assert!(verify(id, &r) <= c["s"].as_f64().unwrap() * 1.01);
}

#[test]
fn stop_and_deadline() {
    for id in ["balls/ballinball/9", "balls/cubinball/5"] {
        let stop = AtomicBool::new(true);
        let job = AutoJob { id, start: None, seed: 1, max_evals: None, deadline: Instant::now() + Duration::from_secs(60), stop: &stop };
        let r = auto_search(&job).unwrap();
        assert_eq!(r.stopped, "stop", "{id}");
        let stop = AtomicBool::new(false);
        let t0 = Instant::now();
        let job = AutoJob { id, start: None, seed: 1, max_evals: None, deadline: Instant::now() + Duration::from_millis(500), stop: &stop };
        let r = auto_search(&job).unwrap();
        assert_eq!(r.stopped, "time", "{id}");
        assert!(t0.elapsed() < Duration::from_secs(10), "{id}");
        // a fresh start is polished a little within half a second: some valid packing is kept
        assert!(r.config.is_some(), "{id}");
        verify(id, &r);
    }
}

#[test]
fn the_budget_is_respected() {
    for id in ["balls/ballinball/12", "balls/octinball/4"] {
        for evals in [1, 50, 700] {
            let r = run(id, None, 9, evals);
            assert_eq!(r.stopped, "evals", "{id}");
            assert_eq!(r.evaluations, evals, "{id}");
        }
    }
}

#[test]
fn ids_and_bad_starts() {
    for id in [
        "sphere/4/12",
        "balls/ballinball",
        "balls/ballinball/0",
        "balls/ballinball/01",
        "balls/ballinball/501",
        "balls/nosuchinball/4",
        "balls/ballinball/4/1",
        "balls/Ballinball/4",
        "",
    ] {
        assert!(parse_id(id).is_none(), "{id}");
        let stop = AtomicBool::new(false);
        let job = AutoJob { id, start: None, seed: 0, max_evals: Some(1), deadline: Instant::now(), stop: &stop };
        assert!(auto_search(&job).is_err(), "{id}");
    }
    assert!(parse_id("balls/ballinball/1").is_some());
    // a start that is not a configuration of the problem is an error result, not an Err
    for bad in [
        json!({ "s": 3.0, "pieces": [[0, 0, 0]] }),
        json!({ "s": -1.0, "pieces": [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }),
        json!({ "s": 3.0, "pieces": [[0, 0, 0], [1, 0, 0], [2, 0]] }),
        json!({ "pieces": [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }),
        json!([1, 2, 3]),
    ] {
        let r = run("balls/ballinball/3", Some(&bad), 1, 10);
        assert_eq!(r.stopped, "error: the start is not a configuration of this problem", "{bad}");
        assert!(r.config.is_none());
    }
    // a ball's start for a solid problem has the wrong width
    let balls = json!({ "s": 5.0, "pieces": [[0, 0, 0], [1, 0, 0], [2, 0, 0]] });
    let r = run("balls/icoinball/3", Some(&balls), 1, 10);
    assert!(r.stopped.starts_with("error"));
}
