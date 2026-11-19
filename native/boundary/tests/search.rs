//! The boundary search against the TypeScript's (fixtures/search-ref.jsonl, written by native/tools/boundary-search-ref.mts
//! under Node 24 on Linux x86-64): `searchBoundary` and `runSpaceJob` with an evaluation budget only, so that the port must
//! give the same packing bit for bit, the same score, the same number of evaluations, the same end and the same
//! improvements in the same order. The cases cover the tesseract (balls by lattice words, cubes by the two rings, rotated
//! solids), the other 4-polytopes (chains), the d-cubes and the simplex, orthoplex and demicube, fresh and warm-started.

use polypack_boundary::auto::{auto_search, parse_id as auto_parse_id};
use polypack_boundary::search::{search_boundary, BoundarySearchOptions, End};
use polypack_boundary::types::BoundaryConfig;
use polypack_spaceauto::AutoJob;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

fn cases() -> Vec<Value> {
    let path = format!("{}/tests/fixtures/search-ref.jsonl", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn config_of(v: &Value) -> Option<BoundaryConfig> {
    (!v.is_null()).then(|| serde_json::from_value(v.clone()).unwrap())
}

/// Equal as numbers (a fixture cannot hold a -0: JSON.stringify writes 0, and 0 == -0 here).
fn same_config(name: &str, got: &Option<BoundaryConfig>, want: &Option<BoundaryConfig>) {
    match (got, want) {
        (None, None) => {}
        (Some(g), Some(w)) => {
            assert_eq!(g.s, w.s, "{name}: s");
            assert_eq!(g.pieces.len(), w.pieces.len(), "{name}: pieces");
            for (i, (a, b)) in g.pieces.iter().zip(&w.pieces).enumerate() {
                assert_eq!(a.cell, b.cell, "{name}: piece {i} cell");
                assert_eq!(a.u, b.u, "{name}: piece {i} u");
                assert_eq!(a.q, b.q, "{name}: piece {i} q");
            }
        }
        _ => panic!("{name}: a configuration against none"),
    }
}

fn opt_num(v: &Value) -> Option<f64> {
    v.as_f64()
}

#[test]
fn matches_the_typescript_search_bit_for_bit() {
    let mut count = 0;
    for case in cases().iter().filter(|c| c["kind"] == "search") {
        let name = case["name"].as_str().unwrap();
        let id = case["id"].as_str().unwrap();
        let problem = auto_parse_id(id).unwrap();
        let start = config_of(&case["start"]);
        let mut opts = BoundarySearchOptions::new(case["seed"].as_u64().unwrap() as u32, case["evals"].as_u64().unwrap());
        opts.start = start.as_ref();
        let r = search_boundary(&problem, &opts).unwrap();
        let want = &case["result"];
        assert_eq!(r.ended.as_str(), want["ended"].as_str().unwrap(), "{name}: ended");
        assert_eq!(r.evals, want["evals"].as_u64().unwrap(), "{name}: evals");
        assert_eq!(r.score, opt_num(&want["score"]), "{name}: score");
        assert_eq!(r.start_score, opt_num(&want["startScore"]), "{name}: start score");
        assert_eq!(r.starts as u64, want["starts"].as_u64().unwrap(), "{name}: starts");
        same_config(name, &r.config, &config_of(&want["config"]));
        let trace = want["trace"].as_array().unwrap();
        assert_eq!(r.trace.len(), trace.len(), "{name}: improvements");
        for (a, b) in r.trace.iter().zip(trace) {
            assert_eq!((a.evals, a.score, a.source, a.stage), (b["evals"].as_u64().unwrap(), num(&b["score"]), b["source"].as_str().unwrap(), b["stage"].as_str().unwrap()), "{name}: trace");
        }
        // the result is valid by the validator at tol 0 (or the given start by the server's rule): the search's own contract
        if let Some(c) = &r.config {
            let v = polypack_boundary::validate_boundary_config(&problem, c, &polypack_boundary::ValidateOptions { tol: Some(1e-9), ..Default::default() }).unwrap();
            assert!(v.ok, "{name}: valid at the server's tolerance");
        }
        count += 1;
    }
    assert!(count >= 30, "{count} cases");
}

#[test]
fn matches_the_typescript_job_bit_for_bit() {
    let mut count = 0;
    for case in cases().iter().filter(|c| c["kind"] == "job") {
        let name = case["name"].as_str().unwrap();
        let id = case["id"].as_str().unwrap();
        let stop = AtomicBool::new(false);
        let job = AutoJob {
            id,
            start: (!case["start"].is_null()).then_some(&case["start"]),
            seed: case["seed"].as_u64().unwrap() as u32,
            max_evals: Some(case["evals"].as_u64().unwrap()),
            deadline: Instant::now() + Duration::from_secs(3600),
            stop: &stop,
        };
        let r = auto_search(&job).unwrap();
        let want = &case["result"];
        assert_eq!(r.stopped, want["ended"].as_str().unwrap(), "{name}: ended");
        assert_eq!(r.evaluations, want["evals"].as_u64().unwrap(), "{name}: evaluations");
        assert_eq!(r.score, opt_num(&want["score"]), "{name}: score");
        let got = r.config.as_ref().map(|c| serde_json::from_value::<BoundaryConfig>(c.clone()).unwrap());
        same_config(name, &got, &config_of(&want["config"]));
        assert_eq!(want["valid"].as_bool().unwrap(), r.config.is_some(), "{name}: valid");
        count += 1;
    }
    assert!(count >= 6, "{count} cases");
}

#[test]
fn ends_are_the_typescripts_names() {
    assert_eq!(End::Evals.as_str(), "evals");
    assert_eq!(End::Time.as_str(), "time");
    assert_eq!(End::Stopped.as_str(), "stopped");
    assert_eq!(End::Bound.as_str(), "bound");
}

#[test]
fn mulberry32_is_the_typescripts() {
    // generated by the TypeScript mulberry32 (search/random.ts)
    use polypack_boundary::search::random::Mulberry32;
    let want: [(u32, [f64; 5]); 4] = [
        (0, [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086]),
        (1, [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849]),
        (42, [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423]),
        (4294967295, [0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489]),
    ];
    for (seed, vals) in want {
        let mut r = Mulberry32::new(seed);
        for v in vals {
            assert_eq!(r.next(), v, "seed {seed}");
        }
    }
}

#[test]
fn an_invalid_problem_is_an_error() {
    use polypack_boundary::types::BoundaryProblem;
    let opts = BoundarySearchOptions::new(1, 10);
    for (poly, piece, p) in [("tesseract", "ball", 0.0), ("tesseract", "ball", 1.5), ("tesseract", "ball", 10000.0), ("tesseract", "sphere", 3.0), ("hypercube", "ball", 3.0), ("5cell", "ball", f64::NAN)] {
        let problem = BoundaryProblem { polytope: poly.to_string(), piece: piece.to_string(), p };
        assert_eq!(search_boundary(&problem, &opts).unwrap_err(), "searchBoundary: invalid problem", "{poly} {piece} {p}");
    }
    // a d-cube beyond its problem set's largest P is the kernel's error
    let problem = BoundaryProblem::new("5cube", "ball", 161);
    assert_eq!(search_boundary(&problem, &opts).unwrap_err(), "ncubeKernel: P = 161 is above the largest of the 5cube, 160");
    let problem = BoundaryProblem::new("5simplex", "ball", 25);
    assert_eq!(search_boundary(&problem, &opts).unwrap_err(), "ndKernel: P = 25 is above the largest of the 5simplex, 24");
}

/// Timings of the fixture's cases, for a comparison with the TypeScript's (`cargo test --release -p polypack-boundary
/// --test search timings -- --ignored --nocapture`).
#[test]
#[ignore]
fn timings() {
    for case in cases().iter().filter(|c| c["kind"] == "search") {
        let name = case["name"].as_str().unwrap();
        let problem = auto_parse_id(case["id"].as_str().unwrap()).unwrap();
        let start = config_of(&case["start"]);
        let mut opts = BoundarySearchOptions::new(case["seed"].as_u64().unwrap() as u32, case["evals"].as_u64().unwrap());
        opts.start = start.as_ref();
        let t = Instant::now();
        let r = search_boundary(&problem, &opts).unwrap();
        println!("{name}: {} evals {} ({} ms)", r.ended.as_str(), r.evals, t.elapsed().as_millis());
    }
}
