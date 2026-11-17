//! The sphere search against the TypeScript's `searchSphere` (fixtures `search-ref.jsonl`, written
//! by Node from packages/sphere/src/search.ts: problem, seed, evaluation budget, optional start,
//! and the result), and `auto::auto_search` on real jobs.

use polypack_spaceauto::AutoJob;
use polypack_sphere::auto::{auto_search, parse_id, read_config};
use polypack_sphere::geometry::{SphereConfig, SphereProblem};
use polypack_sphere::search::{search_sphere, Rng, SearchOptions, Stop};
use polypack_sphere::server::check;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn fixtures() -> Vec<Value> {
    let path = format!("{}/tests/fixtures/search-ref.jsonl", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn valid(id: &str, c: &Value) -> bool {
    let (n, p) = parse_id(id).unwrap();
    let cfg = read_config(c, p).expect("a configuration");
    check(n as f64, p as f64, &cfg, 1e-9, 20).is_empty()
}

fn job<'a>(id: &'a str, start: Option<&'a Value>, seed: u32, evals: u64, stop: &'a AtomicBool) -> AutoJob<'a> {
    AutoJob {
        id,
        start,
        seed,
        max_evals: Some(evals),
        deadline: Instant::now() + Duration::from_secs(600),
        stop,
    }
}

#[test]
fn mulberry32_matches_the_source() {
    // values of mulberry32(1) computed by the source's code under Node
    let mut r = Rng::new(1);
    let got: Vec<f64> = (0..3).map(|_| r.next()).collect();
    assert_eq!(got, vec![0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
}

#[test]
fn bad_ids_are_refused() {
    let stop = AtomicBool::new(false);
    for id in [
        "sphere/2/5",
        "sphere/0/0",
        "sphere/0/101",
        "sphere/4",
        "torus/sq/3/4",
        "sphere/4/5/6",
        "sphere/1000/5",
    ] {
        assert!(auto_search(&job(id, None, 1, 10, &stop)).is_err(), "{id}");
    }
    assert_eq!(parse_id("sphere/0/12"), Some((0, 12)));
    assert_eq!(parse_id("sphere/100/100"), Some((100, 100)));
}

#[test]
fn bad_start_is_an_error_result() {
    let stop = AtomicBool::new(false);
    let start = serde_json::json!({ "rho": 1.0, "pieces": [] });
    let r = auto_search(&job("sphere/0/5", Some(&start), 1, 10, &stop)).unwrap();
    assert!(r.config.is_none());
    assert!(r.stopped.starts_with("error: "));
}

/// Bit-identical with the TypeScript: score, evaluations, hops, stop reason and every quaternion
/// component of the best packing.
#[test]
fn search_is_bit_identical_to_typescript() {
    let all = fixtures();
    assert!(all.len() >= 5);
    for case in &all {
        let id = case["id"].as_str().unwrap();
        let n = case["N"].as_f64().unwrap();
        let p = case["P"].as_f64().unwrap();
        let start: Option<SphereConfig> = case
            .get("start")
            .filter(|v| !v.is_null())
            .map(|v| read_config(v, p as usize).unwrap());
        let r = search_sphere(
            &SphereProblem { n, p },
            &SearchOptions {
                seed: case["seed"].as_u64().unwrap() as u32,
                start: start.as_ref(),
                max_evals: case["evals"].as_u64().unwrap(),
                job: None,
            },
        )
        .unwrap();
        let e = &case["expect"];
        assert_eq!(r.stopped, Stop::Evals, "{id}");
        assert_eq!(r.evaluations, e["evaluations"].as_u64().unwrap(), "{id}: evaluations");
        assert_eq!(r.hops, e["hops"].as_u64().unwrap(), "{id}: hops");
        assert_eq!(r.score.to_bits(), e["score"].as_f64().unwrap().to_bits(), "{id}: score");
        let want = e["config"]["pieces"].as_array().unwrap();
        let got = r.config.as_ref().unwrap();
        assert_eq!(
            got.rho.to_bits(),
            e["config"]["rho"].as_f64().unwrap().to_bits(),
            "{id}: rho"
        );
        assert_eq!(got.q.len(), want.len());
        for (k, (g, w)) in got.q.iter().zip(want).enumerate() {
            for c in 0..4 {
                assert_eq!(
                    g[c].to_bits(),
                    w["q"][c].as_f64().unwrap().to_bits(),
                    "{id}: piece {k} q[{c}]"
                );
            }
        }
        if let Some(s) = e["startScore"].as_f64() {
            assert_eq!(r.start_score.unwrap().to_bits(), s.to_bits(), "{id}: start score");
        } else {
            assert!(r.start_score.is_none(), "{id}");
        }
    }
}

/// The Auto job on the fixtures' problems: the same packing, valid by the validator.
#[test]
fn auto_search_matches_typescript_and_is_valid() {
    let stop = AtomicBool::new(false);
    for case in &fixtures() {
        let id = format!("sphere/{}/{}", case["N"], case["P"]);
        let start = case.get("start").filter(|v| !v.is_null());
        let seed = case["seed"].as_u64().unwrap() as u32;
        let r = auto_search(&job(&id, start, seed, case["evals"].as_u64().unwrap(), &stop)).unwrap();
        let cfg = r.config.as_ref().expect("a packing");
        assert!(valid(&id, cfg), "{id}");
        assert_eq!(
            r.score.unwrap().to_bits(),
            case["expect"]["score"].as_f64().unwrap().to_bits(),
            "{id}"
        );
        assert_eq!(r.evaluations, case["expect"]["evaluations"].as_u64().unwrap(), "{id}");
        assert_eq!(r.stopped, "evals");
        assert_eq!(r.method, "sphere basin hopping");
    }
}

#[test]
fn auto_search_fresh_and_warm_are_valid() {
    let stop = AtomicBool::new(false);
    // small and medium P, a disk and a polygon piece
    for (id, evals) in [
        ("sphere/0/7", 3000u64),
        ("sphere/0/24", 4000),
        ("sphere/4/5", 3000),
        ("sphere/6/16", 20000),
    ] {
        let fresh = auto_search(&job(id, None, 3, evals, &stop)).unwrap();
        let cfg = fresh.config.as_ref().unwrap_or_else(|| panic!("{id}: no packing"));
        assert!(valid(id, cfg), "{id}");
        assert_eq!(fresh.score.unwrap(), cfg["rho"].as_f64().unwrap());
        // warm start from the fresh result: never worse than the start
        let warm = auto_search(&job(id, Some(cfg), 4, evals / 2, &stop)).unwrap();
        let wc = warm.config.as_ref().unwrap();
        assert!(valid(id, wc), "{id}");
        assert!(warm.score.unwrap() <= fresh.score.unwrap(), "{id}");
    }
}

#[test]
fn stop_flag_and_deadline_end_the_search() {
    let stop = AtomicBool::new(true);
    let r = auto_search(&job("sphere/0/12", None, 1, 1_000_000, &stop)).unwrap();
    assert_eq!(r.stopped, "stop");
    let stop = AtomicBool::new(false);
    let mut j = job("sphere/0/12", None, 1, 1_000_000_000, &stop);
    j.max_evals = None;
    j.deadline = Instant::now() + Duration::from_millis(300);
    let t = Instant::now();
    let r = auto_search(&j).unwrap();
    assert_eq!(r.stopped, "time");
    assert!(t.elapsed() < Duration::from_secs(5));
    // the disks' spiral start is kept before the relaxation, so even a short search has a packing
    assert!(valid("sphere/0/12", r.config.as_ref().unwrap()));
}
