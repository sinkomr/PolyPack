//! The search against the TypeScript's `searchPolyhedra` and `runSpaceJob` (fixtures/search-ref.jsonl, written
//! by `native/tools/polyhedra-search-ref.mts` under Node 24 on Linux x86-64). With an evaluation-only budget the
//! port must give the same configuration, score, evaluation count and ending bit for bit.

use polypack_polyhedra::auto::auto_search;
use polypack_polyhedra::search::{search_polyhedra, PolyhedraSearchOptions};
use polypack_polyhedra::sim::Why;
use polypack_polyhedra::{get_problem, validate_polyhedra, PolyhedraConfig, ValidateOptions};
use polypack_spaceauto::AutoJob;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn config_of(v: &Value) -> PolyhedraConfig {
    PolyhedraConfig {
        s: v["s"].as_f64().unwrap(),
        pieces: v["pieces"]
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
    }
}

/// Equal as numbers: a zero and a minus zero are one (JSON cannot show the sign).
fn same(got: &PolyhedraConfig, want: &PolyhedraConfig, what: &str) {
    assert_eq!(got.s, want.s, "{what}: s");
    assert_eq!(got.pieces.len(), want.pieces.len(), "{what}: pieces");
    for (i, (a, b)) in got.pieces.iter().zip(&want.pieces).enumerate() {
        for k in 0..7 {
            assert!(a[k] == b[k], "{what}: piece {i} component {k}: {:e} vs {:e}", a[k], b[k]);
        }
    }
}

#[test]
fn matches_the_typescript_search_bit_for_bit() {
    let path = format!("{}/tests/fixtures/search-ref.jsonl", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(path).unwrap();
    let (mut searches, mut jobs) = (0, 0);
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let case: Value = serde_json::from_str(line).unwrap();
        let name = case["name"].as_str().unwrap();
        let id = case["id"].as_str().unwrap();
        let mut parts = id.split('/').skip(1);
        let code = parts.next().unwrap();
        let p: usize = parts.next().unwrap().parse().unwrap();
        let problem = get_problem(code).unwrap();
        let seed = case["seed"].as_u64().unwrap();
        let evals = case["evals"].as_u64().unwrap();
        let start = (!case["start"].is_null()).then(|| config_of(&case["start"]));
        let want = &case["result"];
        let no_stop = || false;
        match case["kind"].as_str().unwrap() {
            "search" => {
                searches += 1;
                let o = PolyhedraSearchOptions {
                    seed: seed as f64,
                    start: start.as_ref(),
                    start_polished: case["polished"].as_bool().unwrap(),
                    max_evals: evals as f64,
                    should_stop: &no_stop,
                };
                let r = search_polyhedra(&problem, p, &o).unwrap();
                assert_eq!(r.stopped, Why::Evals, "{name}");
                assert_eq!(r.evaluations, want["evaluations"].as_u64().unwrap(), "{name}: evaluations");
                assert_eq!(r.hops, want["hops"].as_u64().unwrap(), "{name}: hops");
                match want["score"].as_f64() {
                    Some(s) => assert_eq!(r.score, s, "{name}: score"),
                    None => assert!(r.score.is_infinite(), "{name}: no score"),
                }
                assert_eq!(r.start_score, want["start_score"].as_f64(), "{name}: start score");
                match (&r.config, want["config"].is_null()) {
                    (Some(got), false) => {
                        same(got, &config_of(&want["config"]), name);
                        let v = validate_polyhedra(&problem, got, &ValidateOptions { tol: Some(0.0), ..Default::default() }).unwrap();
                        assert!(v.valid, "{name}: valid at tolerance 0");
                    }
                    (None, true) => {}
                    (got, _) => panic!("{name}: config {} vs {}", got.is_some(), !want["config"].is_null()),
                }
            }
            "job" => {
                jobs += 1;
                let stop = AtomicBool::new(false);
                let job = AutoJob {
                    id,
                    start: (!case["start"].is_null()).then(|| &case["start"]),
                    seed: seed as u32,
                    max_evals: Some(evals),
                    deadline: Instant::now() + Duration::from_secs(3600),
                    stop: &stop,
                };
                let r = auto_search(&job).unwrap();
                assert_eq!(r.stopped, want["termination"].as_str().unwrap(), "{name}: termination");
                assert_eq!(r.evaluations, want["evaluations"].as_u64().unwrap(), "{name}: evaluations");
                assert_eq!(r.score, want["score"].as_f64(), "{name}: score");
                assert_eq!(r.config.is_some(), want["valid"].as_bool().unwrap(), "{name}: valid");
                if let (Some(got), false) = (&r.config, want["config"].is_null()) {
                    same(&config_of(got), &config_of(&want["config"]), name);
                }
            }
            k => panic!("kind {k}"),
        }
    }
    assert!(searches >= 25 && jobs >= 3, "{searches} searches, {jobs} jobs");
}
