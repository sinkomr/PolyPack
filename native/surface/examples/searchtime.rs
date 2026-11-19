//! Times one `surface_auto` job: `searchtime ID EVALS SEED` (compare tests/search-ref.mts `time`).
use polypack_spaceauto::AutoJob;
use polypack_surface::surface_auto::surface_auto;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let stop = AtomicBool::new(false);
    let t0 = Instant::now();
    let job = AutoJob { id: &a[1], start: None, seed: a[3].parse().unwrap(), max_evals: Some(a[2].parse().unwrap()), deadline: t0 + Duration::from_secs(3600), stop: &stop };
    let r = surface_auto(&job).unwrap();
    println!("{{\"score\":{:?},\"evaluations\":{},\"termination\":{:?},\"ms\":{:.0}}}", r.score, r.evaluations, r.stopped, t0.elapsed().as_secs_f64() * 1000.0);
}
