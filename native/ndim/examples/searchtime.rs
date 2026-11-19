//! Times the Auto search on the cases of tests/fixtures/search-ref.jsonl (the `job` ones), for the
//! comparison with the TypeScript's time (`node --import tsx native/tools/ndim-search-ref.mts
//! --time` prints the same cases):
//!
//!   cargo run --release -p polypack-ndim --example searchtime
//!
//! Each case is run twice (the first loads the polytopes) and the second is reported.
use polypack_ndim::auto::auto_search;
use polypack_spaceauto::AutoJob;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn main() {
    let text = include_str!("../tests/fixtures/search-ref.jsonl");
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let case: Value = serde_json::from_str(line).expect("a fixture line");
        if case["kind"] != "job" {
            continue;
        }
        let start = (!case["start"].is_null()).then(|| &case["start"]);
        let mut ms = 0.0;
        for _ in 0..2 {
            let stop = AtomicBool::new(false);
            let job = AutoJob {
                id: case["id"].as_str().unwrap(),
                start,
                seed: case["seed"].as_u64().unwrap() as u32,
                max_evals: case["evals"].as_u64(),
                deadline: Instant::now() + Duration::from_secs(3600),
                stop: &stop,
            };
            let t0 = Instant::now();
            auto_search(&job).unwrap();
            ms = t0.elapsed().as_secs_f64() * 1000.0;
        }
        println!("{}: {:.0} ms", case["name"].as_str().unwrap(), ms);
    }
}
