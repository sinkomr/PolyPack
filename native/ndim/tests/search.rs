//! The nD space's Auto search against the TypeScript (fixtures/search-ref.jsonl, written by
//! native/tools/ndim-search-ref.mts under Node 24 on Linux x86-64, the production platform:
//! native/tools/LINUX_REFERENCE.md). With an evaluation-only budget the port must give the same
//! configuration, score, evaluation count and termination bit for bit, whatever the machine, in
//! dimensions 4 to 10, for balls and polytopes as pieces and as containers, fresh and warm.
//!
//! Two kinds of cases: `job` is `runSpaceJob` (`auto::auto_search`) and `method` is the generic
//! basin hopping on the kernel with the job's rule as its validate (`polypack_methods`
//! `run_method` on `NdKernel`), whose evaluation count is the raw, fractional one.
//!
//! The one exception of PORTING.md, `Math.pow` with an exponent other than 2 and 0.5, applies to
//! the search at `Math.pow(x, 1 / d)` (the roomy start's size and the radius of a random centre in a
//! ball) and at the container's box test: `polypack_js::math::pow` is correctly rounded and Node's
//! C library is not, for about 1 argument in 1,200. No case of the fixtures differs because of it;
//! if one ever does, the difference is in the last bit of a start and shows from the first hop on.

use polypack_methods::basin::run_basin_hopping;
use polypack_methods::framework::{run_method, RunOptions, Stopped};
use polypack_methods::kernel::Validation;
use polypack_ndim::auto::{auto_search, check_config, parse_id, read_config};
use polypack_ndim::kernel::{load_problem, NdKernel};
use polypack_ndim::problem::NdConfig;
use polypack_spaceauto::AutoJob;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

/// Every number of the two configurations is the same double (a 0 the TypeScript wrote as an
/// integer is the same as 0.0).
fn same_numbers(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_numbers(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same_numbers(v, w)))
        }
        _ => a == b,
    }
}

fn config_value(c: &NdConfig) -> Value {
    serde_json::json!({ "s": c.s, "pieces": c.pieces })
}

#[test]
fn matches_the_typescript_search_bit_for_bit() {
    let text = include_str!("fixtures/search-ref.jsonl");
    let mut jobs = 0;
    let mut methods = 0;
    let mut dims = std::collections::BTreeSet::new();
    let mut warm = 0;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let case: Value = serde_json::from_str(line).expect("a fixture line");
        let name = case["name"].as_str().unwrap();
        let id = case["id"].as_str().unwrap();
        let evals = case["evals"].as_u64().unwrap();
        let seed = case["seed"].as_u64().unwrap() as u32;
        let start = (!case["start"].is_null()).then(|| &case["start"]);
        let want = &case["result"];
        let p = parse_id(id).unwrap();
        dims.insert(p.d);
        if start.is_some() {
            warm += 1;
        }
        let want_score = want["score"].as_f64();
        match case["kind"].as_str().unwrap() {
            "job" => {
                let stop = AtomicBool::new(false);
                let job = AutoJob {
                    id,
                    start,
                    seed,
                    max_evals: Some(evals),
                    deadline: Instant::now() + Duration::from_secs(3600),
                    stop: &stop,
                };
                let r = auto_search(&job).unwrap();
                assert_eq!(r.evaluations, want["evaluations"].as_u64().unwrap(), "{name}: evaluations");
                assert_eq!(r.stopped, want["termination"].as_str().unwrap(), "{name}: termination");
                assert_eq!(r.score, want_score, "{name}: score");
                let got = r.config.as_ref().expect("a configuration");
                assert!(same_numbers(got, &want["config"]), "{name}: configuration");
                jobs += 1;
            }
            _ => {
                load_problem(&p).unwrap();
                let mut kernel = NdKernel::new(&p).unwrap();
                let start = start.map(|v| read_config(&p, v).expect("a start"));
                let mut stop = |_: f64, _: bool| false;
                let mut validate = |c: &NdConfig| -> Validation { check_config(&p, c) };
                let r = run_method(
                    &mut kernel,
                    RunOptions { seed, start, evals: Some(evals as f64), should_stop: &mut stop, validate: &mut validate },
                    run_basin_hopping,
                )
                .unwrap();
                assert_eq!(r.evaluations, want["evaluations"].as_f64().unwrap(), "{name}: evaluations");
                let stopped = match r.stopped {
                    Stopped::Evals => "evals",
                    Stopped::Bound => "bound",
                    Stopped::Stopped => "stopped",
                    Stopped::Time => "time",
                    Stopped::Done => "done",
                    Stopped::Error => "error",
                };
                assert_eq!(stopped, want["stopped"].as_str().unwrap(), "{name}: stopped");
                assert_eq!(r.score, want_score, "{name}: score");
                let got = config_value(r.config.as_ref().expect("a configuration"));
                assert!(same_numbers(&got, &want["config"]), "{name}: configuration");
                methods += 1;
            }
        }
    }
    assert!(jobs >= 15 && methods >= 4 && warm >= 4, "{jobs} jobs, {methods} methods, {warm} warm");
    assert_eq!(dims.len(), 7, "dimensions {dims:?}");
}
