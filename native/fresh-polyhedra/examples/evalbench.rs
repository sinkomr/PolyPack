//! Development: the cost of one energy evaluation and of one L-BFGS iteration on a relaxed random arrangement.
//!
//!     cargo run --profile fast -p polypack-fresh-polyhedra --example evalbench -- polyhedra/pr3l3inj01/40

use fresh_polyhedra::lbfgs::{Budget, Tol};
use fresh_polyhedra::model::Problem;
use fresh_polyhedra::search::Search;
use polypack_flat::clock::thread_cpu_seconds;

fn main() {
    let id = std::env::args().nth(1).unwrap_or_else(|| "polyhedra/pr3l3inj01/40".to_string());
    let prob = Problem::parse(&id).unwrap();
    let budget = Budget::new(u64::MAX, 1e9);
    let mut s = Search::new(&prob, 1, budget);
    let mut st = fresh_polyhedra::energy::State::default();
    let s0 = prob.size_at_density(0.5);
    s.start_random(s0, &mut st);
    let tol = Tol { e_stop: 0.0, rel: 1e-9, patience: 3, gtol: 0.0, max_iter: 300, max_step: 0.15, window: 0, window_rel: 0.0 };
    let t0 = thread_cpu_seconds();
    let ev0 = s.en.evals;
    let out = s.relax(&mut st, s0, &tol);
    let t1 = thread_cpu_seconds();
    let ev = s.en.evals - ev0;
    println!(
        "{id}: P {} pairs {} n {} relax: {} evals {} iters {:.3} s, {:.1} us/eval, e {:.3e}",
        prob.p,
        st.pairs.len(),
        st.x.len(),
        ev,
        out.iters,
        t1 - t0,
        (t1 - t0) / ev as f64 * 1e6,
        out.e
    );
    // raw evaluations at the relaxed state
    s.en.s = s0;
    s.en.rebuild(&mut st, None);
    std::mem::swap(&mut s.en.pairs, &mut st.pairs);
    let mut g = vec![0.0; st.x.len()];
    let t0 = thread_cpu_seconds();
    let k = 2000;
    let mut acc = 0.0;
    for _ in 0..k {
        acc += s.en.eval(&st.x, &mut g);
    }
    let t1 = thread_cpu_seconds();
    println!("raw eval: {:.1} us (acc {acc:.3e})", (t1 - t0) / k as f64 * 1e6);
}
