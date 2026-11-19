//! The surface Auto search (`surface_auto`): parity with the TypeScript on evaluation-budgeted
//! jobs (fixtures written by `tests/search-ref.mts` from `runSpaceJob` of packages/spaces) and
//! validity of what it returns, fresh and warm-started.

use polypack_spaceauto::{AutoJob, AutoResult};
use polypack_surface::surface_auto::surface_auto;
use polypack_surface::validate::{validate, Mode, SurfaceConfig, ValidateOptions};
use polypack_surface::SurfacePose;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn run(id: &str, start: Option<&Value>, seed: u32, evals: u64, secs: f64) -> Result<AutoResult, String> {
    let stop = AtomicBool::new(false);
    let job = AutoJob { id, start, seed, max_evals: Some(evals), deadline: Instant::now() + Duration::from_secs_f64(secs), stop: &stop };
    surface_auto(&job)
}

/// The server's rule for a result: valid at 1e-9 by the validator, with the stated score.
fn assert_valid(id: &str, r: &AutoResult) -> f64 {
    let config = r.config.as_ref().unwrap_or_else(|| panic!("{id}: no packing ({})", r.stopped));
    let parts: Vec<&str> = id.split('/').collect();
    let pieces: Vec<SurfacePose> = config["pieces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| SurfacePose { face: q["face"].as_f64().unwrap(), x: q["x"].as_f64().unwrap(), y: q["y"].as_f64().unwrap(), theta: q["theta"].as_f64().unwrap() })
        .collect();
    let s = config["s"].as_f64().unwrap();
    let cfg = SurfaceConfig { solid: parts[1].to_string(), n: parts[3].parse().unwrap(), s, pieces };
    let mode = if parts[2] == "fold" { Mode::Fold } else { Mode::Nofold };
    let v = validate(&cfg, mode, &ValidateOptions { max_errors: 20, max_chains: 600.0, ..ValidateOptions::default() }).unwrap();
    assert!(v.ok, "{id}: {:?}", v.errors);
    assert_eq!(r.score, Some(s));
    s
}

#[test]
fn fresh_and_warm_jobs_are_valid() {
    // cube and tetrahedron (fold), an Archimedean solid and a prism (fold), a Catalan solid and a
    // Johnson solid (nofold), disks and polygons, small P
    let cases = [
        ("surface/cube/fold/4/3", "surface fold search"),
        ("surface/tetrahedron/fold/3/3", "surface fold search"),
        ("surface/cuboctahedron/fold/3/4", "surface fold search"),
        ("surface/prism3/fold/4/3", "surface fold search"),
        ("surface/rhombic_dodecahedron/nofold/4/3", "surface nofold search"),
        ("surface/square_pyramid/nofold/3/3", "surface nofold search"),
        ("surface/cube/fold/0/3", "surface fold search"),
        ("surface/antiprism4/nofold/0/3", "surface nofold search"),
    ];
    for (id, method) in cases {
        let fresh = run(id, None, 1, 1, 3600.0).unwrap();
        assert_eq!(fresh.method, method);
        let s0 = assert_valid(id, &fresh);
        assert_eq!(fresh.stopped, "evals", "{id}");
        // a warm start is a candidate too: never worse than what it was given
        let warm = run(id, fresh.config.as_ref(), 2, 1, 3600.0).unwrap();
        let s1 = assert_valid(id, &warm);
        assert!(s1 <= s0, "{id}: {s1} > {s0}");
    }
}

#[test]
fn nofold_on_a_platonic_solid_is_for_the_planar_engine() {
    let e = run("surface/cube/nofold/4/4", None, 1, 1, 10.0).err().unwrap();
    assert_eq!(e, "nofold on a Platonic solid runs on the planar engine");
    assert!(run("surface/cube/sideways/4/4", None, 1, 1, 10.0).is_err());
    assert!(run("surface/nope/fold/4/4", None, 1, 1, 10.0).is_err());
}

#[test]
fn a_start_that_is_not_a_configuration_is_an_error_result() {
    let bad: Value = serde_json::json!({"s": 1.0, "pieces": []});
    let r = run("surface/cube/fold/4/4", Some(&bad), 1, 1, 10.0).unwrap();
    assert!(r.config.is_none());
    assert!(r.stopped.starts_with("error: the start is not a configuration"));
}

#[test]
fn a_stopped_job_returns_its_start() {
    let id = "surface/cube/fold/4/3";
    let first = run(id, None, 1, 1, 3600.0).unwrap();
    let stop = AtomicBool::new(true);
    let job = AutoJob { id, start: first.config.as_ref(), seed: 5, max_evals: None, deadline: Instant::now() + Duration::from_secs(3600), stop: &stop };
    let r = surface_auto(&job).unwrap();
    assert_eq!(r.stopped, "aborted");
    assert_eq!(r.score, first.score);
}

/// Equal as numbers (JSON text of 0 and 0.0 differ in serde_json's number type).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64().unwrap().to_bits() == y.as_f64().unwrap().to_bits(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

#[test]
fn parity_with_the_typescript() {
    let text = std::fs::read_to_string(format!("{}/tests/fixtures/search.jsonl", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let mut n = 0;
    for line in text.lines() {
        let c: Value = serde_json::from_str(line).unwrap();
        let name = c["name"].as_str().unwrap();
        let start = if c["start"].is_null() { None } else { Some(&c["start"]) };
        let r = run(c["id"].as_str().unwrap(), start, c["seed"].as_u64().unwrap() as u32, c["evals"].as_u64().unwrap(), 3600.0).unwrap();
        assert_eq!(r.evaluations, c["evaluations"].as_u64().unwrap(), "{name}: evaluations");
        assert_eq!(r.stopped, c["termination"].as_str().unwrap(), "{name}: termination");
        assert_eq!(r.score.unwrap().to_bits(), c["score"].as_f64().unwrap().to_bits(), "{name}: score {:?} / {}", r.score, c["score"]);
        assert!(same(r.config.as_ref().unwrap(), &c["config"]), "{name}: config differs");
        n += 1;
    }
    assert!(n >= 5);
}
