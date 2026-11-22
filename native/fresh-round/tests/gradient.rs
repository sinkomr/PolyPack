use polypack_fresh_round::model::{Curved, Model, Sphere};
use polypack_fresh_round::rng::Rng;

fn check_grad<M: Model>(model: &mut M, seed: u64, label: &str) {
    let mut rng = Rng::new(seed);
    let n = model.dim();
    let nc = model.ncons();
    let mut x = vec![0.0; n];
    model.start(&mut rng, &mut x, seed as usize);
    // squeeze so that constraints are active
    x[n - 1] *= 0.9;
    let mut lam = vec![0.0; nc];
    for l in lam.iter_mut() {
        *l = if rng.uniform() < 0.3 { rng.uniform() } else { 0.0 };
    }
    let mu = 50.0;
    let mut g = vec![0.0; n];
    let f0 = model.eval(&x, &lam, mu, &mut g);
    let mut gd = vec![0.0; n];
    let mut worst = 0.0f64;
    for i in 0..n {
        let h = 1e-6;
        let mut xp = x.clone();
        xp[i] += h;
        let mut xm = x.clone();
        xm[i] -= h;
        let fp = model.eval(&xp, &lam, mu, &mut gd);
        let fm = model.eval(&xm, &lam, mu, &mut gd);
        let num = (fp - fm) / (2.0 * h);
        let err = (num - g[i]).abs() / (1.0 + g[i].abs());
        worst = worst.max(err);
        if err > 1e-5 {
            eprintln!("{label}: coord {i}: analytic {} numeric {}", g[i], num);
        }
    }
    assert!(worst < 1e-5, "{label}: f0 {f0} worst {worst}");
}

#[test]
fn gradients_match_finite_differences() {
    for &(k, m, p) in &[(-1.0, 0u32, 9usize), (-1.0, 6, 7), (-1.0, 8, 10), (1.0, 0, 6), (1.0, 5, 6), (-0.5, 4, 5), (0.5, 3, 5)] {
        for seed in 0..4 {
            let mut c = Curved::new(k, m, p);
            check_grad(&mut c, seed, &format!("curved K={k} M={m} P={p} seed {seed}"));
        }
    }
    for p in [5usize, 13, 40] {
        let mut s = Sphere::new(p);
        check_grad(&mut s, 3, &format!("sphere P={p}"));
    }
}
