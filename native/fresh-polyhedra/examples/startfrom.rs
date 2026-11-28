//! Development: a search that starts from a given packing (the library's `start`), printing each improvement.
//!
//!     cargo run --profile fast -p polypack-fresh-polyhedra --example startfrom -- ID CONFIG.json SECONDS [SEED]

use fresh_polyhedra::fresh_search;
use polypack_spaceauto::FreshJob;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let id = &a[0];
    let cfg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&a[1]).unwrap()).unwrap();
    let seconds: f64 = a[2].parse().unwrap();
    let seed: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let stop = AtomicBool::new(false);
    let job = FreshJob {
        id,
        seed,
        cpu_seconds: seconds,
        deadline: Instant::now() + Duration::from_secs(3600),
        stop: &stop,
        start: Some(&cfg),
        max_evals: None,
    };
    println!("start {}", cfg["s"]);
    {
        // the polish of the start itself, and of the start compressed by 0.2 % and relaxed
        let prob = fresh_polyhedra::model::Problem::parse(id).unwrap();
        let pk = fresh_polyhedra::repair::Packing::from_json(&cfg).unwrap();
        let mut s = fresh_polyhedra::search::Search::new(&prob, 1, fresh_polyhedra::lbfgs::Budget::new(u64::MAX, 1e9));
        s.best_s = pk.s;
        let mut st = s.state_from_packing(&pk);
        let hi = s.polish(&mut st, None);
        println!("polish of the start: {hi:.12}");
        for eps in [1e-4, 1e-3, 2e-3, 1e-2] {
            let mut st = s.state_from_packing(&pk);
            for i in 0..prob.p {
                for d in 0..3 {
                    st.x[7 * i + d] *= 1.0 - eps;
                }
            }
            let tol = fresh_polyhedra::lbfgs::Tol { e_stop: 1e-26, rel: 1e-6, patience: 4, gtol: 1e-14, max_iter: 4000, max_step: 0.15, window: 0, window_rel: 0.0 };
            let e = s.relax(&mut st, pk.s * (1.0 - eps), &tol).e;
            s.best_s = f64::INFINITY;
            let hi = s.polish(&mut st, Some((pk.s * (1.0 - eps), e)));
            println!("compressed by {eps:.0e}, relaxed (E {e:.3e}), polished: {hi:.12}");
        }
    }
    let t0 = Instant::now();
    let res = fresh_search(&job, &mut |s, _| println!("  {:.3} s: {s:.12}", t0.elapsed().as_secs_f64())).unwrap();
    println!("end {:?} ({}, {} evaluations)", res.score, res.stopped, res.evaluations);
}
