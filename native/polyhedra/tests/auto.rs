//! `auto::auto_search`: valid packings for several piece and container solids, small and medium P, fresh and
//! warm-started, and the job's stop, deadline and budget.

use polypack_polyhedra::auto::{auto_search, parse_id, METHOD};
use polypack_polyhedra::{get_problem, validate_polyhedra, PolyhedraConfig, ValidateOptions};
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

/// Checks the result's config with the crate's own validator at the server's tolerance and returns its score.
fn verify(id: &str, r: &AutoResult) -> f64 {
    let parsed = parse_id(id).unwrap();
    let problem = get_problem(&parsed.code).unwrap();
    let c = r.config.as_ref().expect("a config");
    let config = PolyhedraConfig {
        s: c["s"].as_f64().unwrap(),
        pieces: c["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let mut pose = [0.0; 7];
                for (k, x) in p.as_array().unwrap().iter().enumerate() {
                    pose[k] = x.as_f64().unwrap();
                }
                pose
            })
            .collect(),
    };
    assert_eq!(config.pieces.len(), parsed.p, "{id}: pieces");
    let v = validate_polyhedra(&problem, &config, &ValidateOptions { tol: Some(1e-9), ..Default::default() }).unwrap();
    assert!(v.valid, "{id} valid: {:?}", v.errors);
    assert_eq!(r.score, Some(config.s), "{id} score");
    assert_eq!(r.method, METHOD);
    config.s
}

#[test]
fn fresh_and_warm_for_several_solids() {
    // (id, fresh evaluations, warm evaluations)
    let cases = [
        ("polyhedra/cubincub/4", 8000, 4000),
        ("polyhedra/cubintet/6", 12000, 4000),
        ("polyhedra/ap6incub/3", 8000, 4000),
        ("polyhedra/tteinrco/3", 8000, 4000),
        ("polyhedra/tetincub/10", 20000, 6000),
        ("polyhedra/cubintic/3", 8000, 4000),
    ];
    for (id, fresh, warm) in cases {
        let a = run(id, None, 7, fresh);
        assert_eq!(a.stopped, "evals", "{id}");
        assert!(a.evaluations > 0 && a.evaluations <= fresh, "{id}: {}", a.evaluations);
        let sa = verify(id, &a);
        // warm start from that result: never worse, and the start is a candidate
        let b = run(id, a.config.as_ref(), 8, warm);
        let sb = verify(id, &b);
        assert!(sb <= sa, "{id}: warm {sb} > start {sa}");
    }
}

#[test]
fn a_zero_budget_returns_the_start() {
    let id = "polyhedra/cubincub/3";
    let a = run(id, None, 3, 6000);
    let b = run(id, a.config.as_ref(), 3, 0);
    assert_eq!(b.config, a.config);
    assert_eq!(b.stopped, "evals");
    assert_eq!(b.evaluations, 0);
}

#[test]
fn stop_and_deadline() {
    let stop = AtomicBool::new(true);
    let job = AutoJob {
        id: "polyhedra/cubintet/5",
        start: None,
        seed: 1,
        max_evals: None,
        deadline: Instant::now() + Duration::from_secs(60),
        stop: &stop,
    };
    let r = auto_search(&job).unwrap();
    assert_eq!(r.stopped, "stop");
    // the deadline ends a job without an evaluation cap, and what it found is valid
    let stop = AtomicBool::new(false);
    let t0 = Instant::now();
    let job = AutoJob {
        id: "polyhedra/cubintet/5",
        start: None,
        seed: 1,
        max_evals: None,
        deadline: Instant::now() + Duration::from_millis(600),
        stop: &stop,
    };
    let r = auto_search(&job).unwrap();
    assert_eq!(r.stopped, "time");
    assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
    verify("polyhedra/cubintet/5", &r);
    assert!(!stop.load(Ordering::Relaxed));
}

#[test]
fn ids_and_bad_starts() {
    for id in [
        "sphere/4/12",
        "polyhedra/cubincub",
        "polyhedra/cubincub/0",
        "polyhedra/cubincub/04",
        "polyhedra/cubincub/501",
        "polyhedra/cubincub/1000",
        "polyhedra/cubincub/4/1",
        "polyhedra/nosuchcode/4",
        "polyhedra/CUBINCUB/4",
        "polyhedra/cub/4",
        "polyhedra/cubincub/-4",
        "",
    ] {
        assert!(parse_id(id).is_none(), "{id}");
        let stop = AtomicBool::new(false);
        let job = AutoJob { id, start: None, seed: 0, max_evals: Some(1), deadline: Instant::now(), stop: &stop };
        assert!(auto_search(&job).is_err(), "{id}");
    }
    assert_eq!(parse_id("polyhedra/cubincub/100").unwrap().p, 100);
    // a start that is not a configuration of the problem is an error result, not an Err
    let bad = json!({ "s": 3.0, "pieces": [[0, 0, 0, 1, 0, 0, 0]] });
    let r = run("polyhedra/cubincub/3", Some(&bad), 1, 10);
    assert_eq!(r.stopped, "error: the start is not a configuration of this problem");
    assert!(r.config.is_none());
    // a zero quaternion cannot be placed: the search fails as the TypeScript's does
    let zero = json!({ "s": 3.0, "pieces": [[0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 1, 0, 0, 0], [2, 0, 0, 1, 0, 0, 0]] });
    let r = run("polyhedra/cubincub/3", Some(&zero), 1, 100);
    assert_eq!(r.stopped, "error: the quaternion must be finite and nonzero");
    assert!(r.config.is_none());
}
