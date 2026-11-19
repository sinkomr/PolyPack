//! `auto::auto_search`: valid packings for each family and piece, small and medium P, fresh and warm-started,
//! and the job's stop, deadline and budget.

use polypack_boundary::auto::{auto_search, parse_id, METHOD};
use polypack_boundary::types::BoundaryConfig;
use polypack_boundary::{validate_boundary_config, ValidateOptions};
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn run(id: &str, start: Option<&Value>, seed: u32, evals: u64) -> AutoResult {
    let stop = AtomicBool::new(false);
    let job = AutoJob { id, start, seed, max_evals: Some(evals), deadline: Instant::now() + Duration::from_secs(120), stop: &stop };
    auto_search(&job).unwrap()
}

/// Checks the result's config with the crate's own validator and returns its score.
fn verify(id: &str, r: &AutoResult) -> f64 {
    let p = parse_id(id).unwrap();
    let c: BoundaryConfig = serde_json::from_value(r.config.clone().expect("a config")).unwrap();
    assert_eq!(c.pieces.len() as f64, p.p);
    let v = validate_boundary_config(&p, &c, &ValidateOptions { tol: Some(1e-9), max_reasons: Some(20.0), max_chains: Some(1024.0), ..Default::default() }).unwrap();
    assert!(v.ok, "{id} valid: {:?}", v.reasons);
    assert_eq!(r.score, Some(c.s), "{id} score");
    assert_eq!(r.method, METHOD);
    c.s
}

#[test]
fn fresh_and_warm_for_each_family_and_piece() {
    // (id, fresh evaluations, warm evaluations)
    let cases = [
        ("boundary/tesseract/ball/4", 20000, 8000),
        ("boundary/tesseract/ball/7", 30000, 8000),
        ("boundary/tesseract/cube/9", 30000, 8000),
        ("boundary/5cell/ball/2", 4000, 2000),
        ("boundary/16cell/tetrahedron/1", 3000, 1500),
        ("boundary/24cell/ball/2", 8000, 2000),
        ("boundary/5cube/ball/6", 5000, 2000),
        ("boundary/6cube/cube/12", 5000, 2000),
        ("boundary/5simplex/ball/4", 5000, 2000),
        ("boundary/6orthoplex/ball/2", 5000, 2000),
        ("boundary/5demicube/ball/5", 5000, 2000),
    ];
    for (id, fresh, warm) in cases {
        let a = run(id, None, 7, fresh);
        assert!(a.stopped == "evals" || a.stopped == "bound", "{id}: {}", a.stopped);
        assert!(a.evaluations <= fresh);
        let sa = verify(id, &a);
        // warm start from that result: never worse, and the start is a candidate
        let b = run(id, a.config.as_ref(), 8, warm);
        let sb = verify(id, &b);
        assert!(sb <= sa, "{id}: warm {sb} > start {sa}");
        assert!(b.evaluations <= warm);
    }
}

#[test]
fn a_zero_budget_returns_the_start() {
    let id = "boundary/tesseract/ball/5";
    let a = run(id, None, 3, 20000);
    let b = run(id, a.config.as_ref(), 3, 0);
    assert_eq!(b.config, a.config);
    assert_eq!(b.stopped, "evals");
    assert_eq!(b.evaluations, 0);
    // and nothing without a start
    let c = run(id, None, 3, 0);
    assert!(c.config.is_none() && c.score.is_none());
}

#[test]
fn the_budget_is_respected() {
    for evals in [1, 500, 1000, 4321] {
        let r = run("boundary/tesseract/ball/6", None, 5, evals);
        assert!(r.evaluations <= evals, "{} > {evals}", r.evaluations);
        assert_eq!(r.stopped, "evals");
    }
}

#[test]
fn stop_and_deadline() {
    let stop = AtomicBool::new(true);
    let job = AutoJob { id: "boundary/tesseract/ball/6", start: None, seed: 1, max_evals: None, deadline: Instant::now() + Duration::from_secs(60), stop: &stop };
    let r = auto_search(&job).unwrap();
    assert_eq!(r.stopped, "stop");
    let stop = AtomicBool::new(false);
    let t0 = Instant::now();
    let job = AutoJob { id: "boundary/tesseract/ball/6", start: None, seed: 1, max_evals: None, deadline: Instant::now() + Duration::from_millis(500), stop: &stop };
    let r = auto_search(&job).unwrap();
    assert_eq!(r.stopped, "time");
    assert!(t0.elapsed() < Duration::from_secs(10));
    assert!(r.config.is_some());
    verify("boundary/tesseract/ball/6", &r);
    // the d-cube and nD searches poll it too
    for id in ["boundary/6cube/ball/9", "boundary/5simplex/ball/9"] {
        let stop = AtomicBool::new(false);
        let t0 = Instant::now();
        let job = AutoJob { id, start: None, seed: 1, max_evals: None, deadline: Instant::now() + Duration::from_millis(300), stop: &stop };
        let r = auto_search(&job).unwrap();
        assert!(r.stopped == "time" || r.stopped == "bound", "{id}: {}", r.stopped);
        assert!(t0.elapsed() < Duration::from_secs(10));
        verify(id, &r);
    }
}

#[test]
fn ids_and_bad_starts() {
    for id in ["sphere/4/12", "boundary/tesseract/ball", "boundary/tesseract/sphere/4", "boundary/tesseract/ball/04", "boundary/tesseract/ball/0", "boundary/tesseract/ball/501", "boundary/5simplex/cube/3", "boundary/tesseract/ball/4/1", ""] {
        assert!(parse_id(id).is_none(), "{id}");
        let stop = AtomicBool::new(false);
        let job = AutoJob { id, start: None, seed: 0, max_evals: Some(1), deadline: Instant::now(), stop: &stop };
        assert!(auto_search(&job).is_err(), "{id}");
    }
    assert!(parse_id("boundary/600cell/icosahedron/3").is_some());
    assert!(parse_id("boundary/10demicube/ball/24").is_some());
    // a start that is not a configuration of the problem is an error result, not an Err
    let id = "boundary/tesseract/ball/3";
    let bad = [
        json!({ "s": 2.0, "pieces": [{ "cell": 0, "u": [0, 0, 0] }] }),
        json!({ "s": 2.0, "pieces": [{ "cell": 8, "u": [0, 0, 0] }, { "cell": 0, "u": [0, 0, 0] }, { "cell": 0, "u": [0, 0, 0] }] }),
        json!({ "s": 2.0, "pieces": [{ "cell": 0, "u": [0, 0] }, { "cell": 0, "u": [0, 0, 0] }, { "cell": 0, "u": [0, 0, 0] }] }),
        json!({ "s": -2.0, "pieces": [{ "cell": 0, "u": [0, 0, 0] }, { "cell": 0, "u": [0, 0, 0] }, { "cell": 0, "u": [0, 0, 0] }] }),
        json!({ "s": 2.0, "pieces": [{ "cell": 0, "u": [0, 0, 0], "q": [1, 0, 0, 0] }, { "cell": 0, "u": [0, 0, 0] }, { "cell": 0, "u": [0, 0, 0] }] }),
        json!("start"),
    ];
    for b in &bad {
        let r = run(id, Some(b), 1, 10);
        assert_eq!(r.stopped, "error: the start is not a configuration of this problem", "{b}");
        assert!(r.config.is_none());
    }
    // a start that is well formed but not valid is no candidate: the search still runs and gives its own result
    let loose = json!({ "s": 3.0, "pieces": [{ "cell": 0, "u": [0, 0, 0] }, { "cell": 0, "u": [0, 0, 0] }, { "cell": 1, "u": [0, 0, 0] }] });
    let r = run(id, Some(&loose), 1, 20000);
    assert!(r.config.is_some());
    verify(id, &r);
}

#[test]
fn rotated_pieces_keep_their_quaternions() {
    // a solid on a 4-polytope carries the rotation of each piece, a ball or an aligned cube none
    let r = run("boundary/16cell/tetrahedron/1", None, 2, 3000);
    verify("boundary/16cell/tetrahedron/1", &r);
    assert!(r.config.as_ref().unwrap()["pieces"][0]["q"].is_array());
    let r = run("boundary/tesseract/cube/5", None, 2, 3000);
    verify("boundary/tesseract/cube/5", &r);
    assert!(r.config.as_ref().unwrap()["pieces"][0].get("q").is_none());
}
