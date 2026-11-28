//! Development: the CPU time of the check (strict and default) on a configuration.
//!
//!     cargo run --profile fast -p polypack-fresh-polyhedra --example checktime -- ID CONFIG.json

use fresh_polyhedra::model::Problem;
use fresh_polyhedra::repair::{check, check_default};
use polypack_flat::clock::thread_cpu_seconds;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let prob = Problem::parse(&a[0]).unwrap();
    let text = std::fs::read_to_string(&a[1]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    // a run's JSON line or a bare configuration
    let cfg = if v.get("config").is_some() { v["config"].clone() } else { v };
    let t0 = thread_cpu_seconds();
    let strict = check(&prob, &cfg);
    let t1 = thread_cpu_seconds();
    let default = check_default(&prob, &cfg);
    let t2 = thread_cpu_seconds();
    println!("strict {strict:?} in {:.4} s, default {default:?} in {:.4} s", t1 - t0, t2 - t1);
}
