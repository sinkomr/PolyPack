// Convergence profile of one local minimisation after a shake of a converged configuration.
use polypack_fresh_flat::{geom::Shape, lbfgs::Lbfgs, model::{Model, Sol}, rng::Rng};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let n: usize = a[1].parse().unwrap();
    let m: usize = a[2].parse().unwrap();
    let p: usize = a[3].parse().unwrap();
    let w: f64 = a[4].parse().unwrap();
    let mem: usize = a.get(5).map(|s| s.parse().unwrap()).unwrap_or(7);
    let sh = Shape::new(n, m);
    let mut md = Model::new(sh.clone(), p);
    let dim = md.dim;
    let mut lb = Lbfgs::new(mem);
    let mut rng = Rng::new(3);
    let mut sol = Sol::new(p, dim, n > 0);
    let s0 = sh.area_bound(p) * 1.45;
    for i in 0..p {
        sol.q[dim * i] = 0.5 * s0 * sh.k_in * rng.signed();
        sol.q[dim * i + 1] = 0.5 * s0 * sh.k_in * rng.signed();
        if dim == 3 { sol.q[3 * i + 2] = rng.uniform() * 6.0; }
    }
    let t = std::time::Instant::now();
    let e = md.local_min(&mut lb, &mut sol, w, 100000, w * 1e-2, true);
    eprintln!("start: {:?} s {:.9} iters {} rebuilds {} {:.1}ms", e, sol.s, md.stat_iters, md.stat_rebuilds, t.elapsed().as_secs_f64()*1e3);
    for rep in 0..3 {
        let amp = 0.2 * sh.big_r;
        for i in 0..p {
            sol.q[dim * i] += amp * rng.signed();
            sol.q[dim * i + 1] += amp * rng.signed();
        }
        md.conv_every = 100;
        let i0 = md.stat_iters; let r0 = md.stat_rebuilds;
        let t = std::time::Instant::now();
        let e = md.local_min(&mut lb, &mut sol, w, 100000, w * 1e-2, true);
        eprintln!("hop {rep}: {:?} s {:.9} iters {} rebuilds {} {:.1}ms", e, sol.s, md.stat_iters - i0, md.stat_rebuilds - r0, t.elapsed().as_secs_f64()*1e3);
        md.conv_every = 0;
    }
    let fac: f64 = a.get(6).map(|s| s.parse().unwrap()).unwrap_or(1e-2);
    let mut ww = w * fac;
    let t = std::time::Instant::now();
    while ww > 1e-12 {
        let i0 = md.stat_iters;
        let e = md.local_min(&mut lb, &mut sol, ww, 100000, ww * 1e-3, false);
        eprintln!("polish w {:.0e}: {:?} s {:.12} iters {}", ww, e, sol.s, md.stat_iters - i0);
        ww *= fac;
    }
    eprintln!("polish total {:.1}ms", t.elapsed().as_secs_f64()*1e3);
}
