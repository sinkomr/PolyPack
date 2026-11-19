//! `auto::auto_search`: valid packings in dimensions 4 to 10 for polytopes and balls as pieces and
//! containers, small and medium P, fresh and warm-started, and the job's stop, deadline and budget.

use polypack_ndim::auto::{auto_search, parse_id, METHOD};
use polypack_ndim::kernel::load_problem;
use polypack_ndim::problem::NdConfig;
use polypack_ndim::space::{nd_bound_entry, nd_check};
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
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

fn config_of(v: &Value) -> NdConfig {
    NdConfig {
        s: v["s"].as_f64().unwrap(),
        pieces: v["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| q.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect())
            .collect(),
    }
}

/// Checks the result's configuration with the crate's own validator and returns its score.
fn verify(id: &str, r: &AutoResult) -> f64 {
    let p = parse_id(id).unwrap();
    load_problem(&p).unwrap();
    let c = config_of(r.config.as_ref().expect("a configuration"));
    assert_eq!(c.pieces.len(), p.p as usize);
    assert!(nd_check(&p, &c, 1e-9, 5).unwrap().is_empty(), "{id} valid");
    assert_eq!(r.score, Some(c.s), "{id} score");
    assert_eq!(r.method, METHOD);
    // never below the problem's lower bound
    let bound = nd_bound_entry(p.d, &p.piece, &p.container, p.p).unwrap().value;
    assert!(c.s >= bound * (1.0 - 1e-9), "{id}: {} below the bound {bound}", c.s);
    c.s
}

#[test]
fn fresh_and_warm_in_every_dimension() {
    // (id, fresh evaluations, warm evaluations)
    let cases = [
        ("ndim/4/ball/ball/5", 3000, 1500),
        ("ndim/4/cube/ball/3", 600, 400),
        ("ndim/5/ball/cube/7", 4000, 1500),
        ("ndim/6/ball/ball/9", 4000, 1500),
        ("ndim/7/simplex/cube/3", 500, 300),
        ("ndim/8/ball/cube/6", 3000, 1500),
        ("ndim/9/ball/ball/10", 3000, 1500),
        ("ndim/10/ball/ball/12", 3000, 1500),
        ("ndim/4/ball/ball/20", 6000, 2000),
    ];
    for (id, fresh, warm) in cases {
        let a = run(id, None, 7, fresh);
        assert_eq!(a.stopped, "evals", "{id}");
        // a charge of one evaluation that starts below the cap may end one above it
        assert!(a.evaluations > 0 && a.evaluations <= fresh + 1, "{id}: {} evaluations", a.evaluations);
        let sa = verify(id, &a);
        // warm start from that result: never worse, and the start is a candidate
        let b = run(id, a.config.as_ref(), 8, warm);
        let sb = verify(id, &b);
        assert!(sb <= sa, "{id}: warm {sb} > start {sa}");
    }
}

#[test]
fn a_start_is_never_made_worse() {
    // a start that is a valid but loose packing stays at least that good with a tiny budget
    let id = "ndim/4/ball/ball/3";
    let a = run(id, None, 3, 2000);
    let b = run(id, a.config.as_ref(), 3, 1);
    assert_eq!(b.config, a.config);
    assert_eq!(b.score, a.score);
    assert_eq!(b.stopped, "evals");
}

#[test]
fn a_zero_budget_is_an_error_result_as_in_the_source() {
    // runMethod throws "the budget must be positive", which runSpaceJob turns into an error result
    let r = run("ndim/4/ball/ball/4", None, 3, 0);
    assert_eq!(r.stopped, "error: the budget must be positive");
    assert!(r.config.is_none() && r.score.is_none());
    assert_eq!(r.evaluations, 0);
}

#[test]
fn the_budget_is_respected() {
    for evals in [1u64, 20, 100, 700] {
        let r = run("ndim/5/cube/ball/3", None, 11, evals);
        // the first result is always allowed (the seeds, a first squeeze and an offer), so a tiny budget
        // is overrun by what they cost; otherwise a charge that starts below the cap ends one above it
        eprintln!("{evals}: {} evaluations", r.evaluations);
        assert!(r.evaluations <= evals.max(150) + 1, "{} > {evals}", r.evaluations);
        assert!(r.stopped == "evals", "{evals}: {}", r.stopped);
        if r.config.is_some() {
            verify("ndim/5/cube/ball/3", &r);
        }
    }
}

#[test]
fn stop_and_deadline() {
    let stop = AtomicBool::new(true);
    let job = AutoJob {
        id: "ndim/4/cube/cube/4",
        start: None,
        seed: 1,
        max_evals: None,
        deadline: Instant::now() + Duration::from_secs(60),
        stop: &stop,
    };
    let r = auto_search(&job).unwrap();
    assert_eq!(r.stopped, "stop");
    // the deadline ends a job that has no evaluation cap
    for id in ["ndim/4/ball/ball/8", "ndim/4/cube/cube/4"] {
        let stop = AtomicBool::new(false);
        let t0 = Instant::now();
        let job = AutoJob {
            id,
            start: None,
            seed: 1,
            max_evals: None,
            deadline: Instant::now() + Duration::from_millis(700),
            stop: &stop,
        };
        let r = auto_search(&job).unwrap();
        assert_eq!(r.stopped, "time", "{id}");
        assert!(t0.elapsed() < Duration::from_secs(20), "{id}: {:?}", t0.elapsed());
        if r.config.is_some() {
            verify(id, &r);
        }
    }
    // a stop that comes while the job runs ends it with the best so far
    let stop = AtomicBool::new(false);
    let t0 = Instant::now();
    std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_millis(300));
            stop.store(true, Ordering::Relaxed);
        });
        let job = AutoJob {
            id: "ndim/4/ball/ball/8",
            start: None,
            seed: 2,
            max_evals: None,
            deadline: Instant::now() + Duration::from_secs(60),
            stop: &stop,
        };
        let r = auto_search(&job).unwrap();
        assert_eq!(r.stopped, "stop");
        assert!(t0.elapsed() < Duration::from_secs(20));
        verify("ndim/4/ball/ball/8", &r);
    });
}

#[test]
fn ids_and_bad_starts() {
    for id in [
        "sphere/4/12",
        "ndim/4/ball/ball",
        "ndim/3/ball/ball/4",
        "ndim/4/ball/ball/1",
        "ndim/4/ball/ball/41",
        "ndim/4/ball/ball/04",
        "ndim/4/demi/ball/4",
        "ndim/4/ball/ball/4/1",
        "ndim/11/ball/ball/4",
        "ndim/10/ball/ball/21",
        "",
    ] {
        assert!(parse_id(id).is_none(), "{id}");
        let stop = AtomicBool::new(false);
        let job = AutoJob { id, start: None, seed: 0, max_evals: Some(1), deadline: Instant::now(), stop: &stop };
        assert!(auto_search(&job).is_err(), "{id}");
    }
    assert!(parse_id("ndim/4/24cell/ball/40").is_some());
    assert!(parse_id("ndim/10/ball/ball/20").is_some());
    // a start that is not a configuration of the problem is an error result, not an Err
    let want = "error: the start is not a configuration of this problem";
    for bad in [
        json!({ "s": 3.0, "pieces": [[0, 0, 0, 0]] }),
        json!({ "s": 3.0, "pieces": [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }),
        json!({ "s": -3.0, "pieces": [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0]] }),
        json!({ "s": "3", "pieces": [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0]] }),
        json!({ "pieces": [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0]] }),
        json!([1, 2]),
        json!(null),
    ] {
        let r = run("ndim/4/ball/ball/3", Some(&bad), 1, 10);
        assert_eq!(r.stopped, want, "{bad}");
        assert!(r.config.is_none());
    }
    // a well-formed start that is not a valid packing is read, is no candidate, and the search goes on
    let overlapping = json!({ "s": 3.0, "pieces": [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });
    let r = run("ndim/4/ball/ball/3", Some(&overlapping), 1, 3000);
    verify("ndim/4/ball/ball/3", &r);
}
