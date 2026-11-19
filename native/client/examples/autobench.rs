//! One Auto job of a kind beyond Flat, timed: `cargo run --release -p polypack-native --example
//! autobench -- ID SEED EVALS [REPEATS]` prints the score, evaluations and best wall time as JSON, for
//! comparison with the TypeScript `runSpaceJob` at the same seed and evaluation budget.

use polypack_spaceauto::{AutoJob, AutoSearch};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn search_of(space: &str) -> AutoSearch {
    match space {
        "curved" => polypack_curved::auto::auto_search,
        "sphere" => polypack_sphere::auto::auto_search,
        "torus" => polypack_torus::auto::auto_search,
        "surface" => polypack_surface::surface_auto::surface_auto,
        "boundary" => polypack_boundary::auto::auto_search,
        "polyhedra" => polypack_polyhedra::auto::auto_search,
        "balls" => polypack_balls::auto::auto_search,
        "ndim" => polypack_ndim::auto::auto_search,
        other => panic!("no search for {other}"),
    }
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (id, seed, evals) = (&a[0], a[1].parse::<u32>().unwrap(), a[2].parse::<u64>().unwrap());
    let repeats: usize = a.get(3).map_or(3, |r| r.parse().unwrap());
    let search = search_of(id.split('/').next().unwrap());
    let mut best = f64::INFINITY;
    let mut last = None;
    for _ in 0..repeats {
        let stop = AtomicBool::new(false);
        let job = AutoJob { id, start: None, seed, max_evals: Some(evals), deadline: Instant::now() + Duration::from_secs(600), stop: &stop };
        let t = Instant::now();
        let r = search(&job).unwrap();
        best = best.min(t.elapsed().as_secs_f64());
        last = Some(r);
    }
    let r = last.unwrap();
    println!("{}", serde_json::json!({ "id": id, "score": r.score, "evaluations": r.evaluations, "stopped": r.stopped, "seconds": best }));
}
