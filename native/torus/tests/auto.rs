//! `auto::auto_search`: valid packings for each family, a disk and polygons, small and medium P,
//! fresh and warm-started, and the job's stop, deadline and budget.

use polypack_spaceauto::AutoJob;
use polypack_torus::auto::{auto_search, parse_id, METHOD};
use polypack_torus::server::check;
use polypack_torus::server::LatticeSpec;
use polypack_torus::{torus_score, TorusFamily};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn run(id: &str, start: Option<&Value>, seed: u32, evals: u64) -> polypack_spaceauto::AutoResult {
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

/// Checks the result's config with the crate's own validator and returns its score.
fn verify(id: &str, r: &polypack_spaceauto::AutoResult) -> f64 {
    let p = parse_id(id).unwrap();
    let c = r.config.as_ref().expect("a config");
    let spec = if p.family == TorusFamily::Free {
        let v2 = |a: &Value| [a[0].as_f64().unwrap(), a[1].as_f64().unwrap()];
        LatticeSpec::Basis {
            b1: v2(&c["lattice"]["b1"]),
            b2: v2(&c["lattice"]["b2"]),
        }
    } else {
        LatticeSpec::L(c["lattice"]["L"].as_f64().unwrap())
    };
    let poses: Vec<[f64; 3]> = c["poses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| [q[0].as_f64().unwrap(), q[1].as_f64().unwrap(), q[2].as_f64().unwrap()])
        .collect();
    assert_eq!(poses.len(), p.p);
    assert!(check(p.family, p.n as f64, &spec, &poses, 1e-9, 20, 1000.0).is_empty(), "{id} valid");
    let score = torus_score(p.family, &polypack_torus::server::spec_lattice(p.family, &spec));
    assert_eq!(r.score, Some(score), "{id} score");
    assert_eq!(r.method, METHOD);
    score
}

#[test]
fn fresh_and_warm_for_each_family_and_piece() {
    // (id, fresh evaluations, warm evaluations)
    let cases = [
        ("torus/sq/0/4", 4000, 2000),
        ("torus/hex/0/7", 8000, 2000),
        ("torus/free/0/5", 6000, 2000),
        ("torus/sq/4/6", 5000, 2000),
        ("torus/hex/3/8", 6000, 2000),
        ("torus/free/5/6", 6000, 2000),
        ("torus/free/6/12", 15000, 3000),
        ("torus/hex/0/20", 20000, 4000),
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
    let id = "torus/sq/4/4";
    let a = run(id, None, 3, 5000);
    let b = run(id, a.config.as_ref(), 3, 0);
    assert_eq!(b.config, a.config);
    assert_eq!(b.stopped, "evals");
    // and nothing without a start
    let c = run(id, None, 3, 0);
    assert!(c.config.is_none() && c.score.is_none());
}

#[test]
fn stop_and_deadline() {
    let stop = AtomicBool::new(true);
    let job = AutoJob {
        id: "torus/hex/5/6",
        start: None,
        seed: 1,
        max_evals: None,
        deadline: Instant::now() + Duration::from_secs(60),
        stop: &stop,
    };
    let r = auto_search(&job).unwrap();
    assert_eq!(r.stopped, "stop");
    let stop = AtomicBool::new(false);
    let t0 = Instant::now();
    let job = AutoJob {
        id: "torus/hex/5/6",
        start: None,
        seed: 1,
        max_evals: None,
        deadline: Instant::now() + Duration::from_millis(500),
        stop: &stop,
    };
    let r = auto_search(&job).unwrap();
    assert_eq!(r.stopped, "time");
    assert!(t0.elapsed() < Duration::from_secs(10));
    assert!(r.config.is_some());
    verify("torus/hex/5/6", &r);
}

#[test]
fn ids_and_bad_starts() {
    for id in ["sphere/4/12", "torus/sq/4", "torus/oct/4/4", "torus/sq/2/4", "torus/sq/4/0", "torus/sq/4/501", "torus/sq/4/4/1", "torus/sq/1000/4", "torus/sq/-4/4", ""] {
        assert!(parse_id(id).is_none(), "{id}");
        let stop = AtomicBool::new(false);
        let job = AutoJob { id, start: None, seed: 0, max_evals: Some(1), deadline: Instant::now(), stop: &stop };
        assert!(auto_search(&job).is_err(), "{id}");
    }
    assert!(parse_id("torus/free/007/012").is_some());
    // a start that is not a configuration of the problem is an error result, not an Err
    let bad = json!({ "lattice": { "L": 4.0 }, "poses": [[0, 0, 0]] });
    let r = run("torus/sq/4/3", Some(&bad), 1, 10);
    assert_eq!(r.stopped, "error: the start is not a configuration of this problem");
    assert!(r.config.is_none());
}
