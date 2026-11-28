//! Development: how fast one relaxation converges near the jamming size. Runs a short search, then relaxes the
//! best arrangement at sizes just below its size and prints the energy against the iterations.
//!
//!     cargo run --profile fast -p polypack-fresh-polyhedra --example convergence -- polyhedra/bp10inpr5l2/16 2

use fresh_polyhedra::lbfgs::{Budget, Tol};
use fresh_polyhedra::model::Problem;
use fresh_polyhedra::search::Search;

fn main() {
    let id = std::env::args().nth(1).unwrap_or_else(|| "polyhedra/bp10inpr5l2/16".to_string());
    let secs: f64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let prob = Problem::parse(&id).unwrap();
    let budget = Budget::new(u64::MAX, secs);
    let mut s = Search::new(&prob, 1, budget);
    s.run(None, &mut |pk, _| Some(pk.s));
    println!("{id}: best {:.12} after {secs} s", s.best_s);
    s.budget = Budget::new(u64::MAX, 1e9);
    let ev0 = s.en.evals;
    let best = s.repolish_best();
    if let Ok(h) = std::env::var("CONV_H") {
        let v: Vec<f64> = h.split(',').map(|x| x.parse().unwrap()).collect();
        s.params.hc = v[0];
        s.params.hq = v[1];
        s.params.hw = v[2];
        s.params.he = v[3];
    }
    println!("repolished: {best:.12} ({} evals)", s.en.evals - ev0);
    for rel in [1e-2, 1e-3, 1e-4, 1e-6] {
        let mut st = s.best.clone();
        let target = best * (1.0 - rel);
        for i in 0..prob.p {
            for d in 0..3 {
                st.x[7 * i + d] *= 1.0 - rel;
            }
        }
        let mut line = format!("rel {rel:.0e}:");
        let mut total = 0;
        let ev0 = s.en.evals;
        for chunk in 0..12 {
            let tol = Tol { e_stop: 1e-30, rel: 0.0, patience: 1000, gtol: 0.0, max_iter: 250, max_step: 0.05, window: 0, window_rel: 0.0 };
            let out = s.relax(&mut st, target, &tol);
            total += out.iters;
            line += &format!(" {}:{:.2e}", total, out.e);
            if chunk == 11 || out.e <= 1e-30 {
                break;
            }
        }
        println!("{line}  (evals {})", s.en.evals - ev0);
    }
}
