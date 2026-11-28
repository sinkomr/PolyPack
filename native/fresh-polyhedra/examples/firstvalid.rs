//! Development: the time to the first valid packing (the constructive lattice packing and its check) over many
//! pairs of solids.
//!
//!     cargo run --profile fast -p polypack-fresh-polyhedra --example firstvalid -- 500 200

use fresh_polyhedra::model::Problem;
use fresh_polyhedra::rng::Rng;
use polypack_flat::clock::thread_cpu_seconds;
use polypack_polyhedra::SOLID_NAMES_LIST;

fn main() {
    let p: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(500);
    let count: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(200);
    let codes: Vec<&str> = SOLID_NAMES_LIST.iter().map(|s| s.code.as_str()).collect();
    let mut rng = Rng::new(5);
    let mut worst = (0.0, String::new());
    let mut total = 0.0;
    let mut fails = 0;
    for k in 0..count {
        let id = if k % 4 == 3 {
            format!("balls/{}inball/{}", codes[rng.below(codes.len())], p.min(100))
        } else {
            format!("polyhedra/{}in{}/{}", codes[rng.below(codes.len())], codes[rng.below(codes.len())], p)
        };
        let t0 = thread_cpu_seconds();
        let out = fresh_polyhedra::solve(&id, 1, 0.0, u64::MAX, false).unwrap();
        let t = thread_cpu_seconds() - t0;
        total += t;
        let first = out.trace.first().map(|e| e.0);
        if out.score.is_none() {
            fails += 1;
            println!("{id}: NO PACKING");
        }
        let prob = Problem::parse(&id).unwrap();
        if t > worst.0 {
            worst = (t, id.clone());
        }
        if t > 0.3 {
            println!("{id}: {t:.3} s (first at {first:?}), score {:?} bound {:.4}", out.score, prob.bound);
        }
    }
    println!("{count} problems at P {p}: mean {:.3} s, worst {:.3} s ({}), without packing {fails}", total / count as f64, worst.0, worst.1);
}
