//! The crate's own geometry (ambient points, distances, the smallest container) against the
//! validators of polypack-curved and polypack-sphere, on random cases.

use polypack_curved::evaluate::{centre_distance, piece_state};
use polypack_curved::{validation_steps, CurvedConfig, CurvedProblem, Pose, Space, ValidationOptions};
use polypack_fresh_round::kfn::Kf;
use polypack_fresh_round::model::{quat_to, Curved, Model};
use polypack_fresh_round::rng::Rng;
use polypack_sphere::{centre_of, SphereConfig, SpherePiece, SphereProblem};

/// The ambient point of exponential coordinates (x, y).
fn ambient(kf: &Kf, x: f64, y: f64) -> [f64; 3] {
    let d = (x * x + y * y).sqrt();
    kf.polar(d, y.atan2(x))
}

#[test]
fn curved_distances_agree_with_the_validator() {
    let mut rng = Rng::new(11);
    for &k in &[-1.0, -0.25, 0.5, 1.0] {
        let kf = Kf::new(k);
        let space = Space::new(k, 0, 0).unwrap();
        let lim = if k > 0.0 { 0.45 * std::f64::consts::PI / kf.s } else { 3.0 };
        for _ in 0..2000 {
            let r1 = lim * rng.uniform().sqrt();
            let r2 = lim * rng.uniform().sqrt();
            let (a1, a2) = (6.3 * rng.uniform(), 6.3 * rng.uniform());
            let p = Pose { x: r1 * a1.cos(), y: r1 * a1.sin(), theta: 0.0 };
            let q = Pose { x: r2 * a2.cos(), y: r2 * a2.sin(), theta: 0.0 };
            let theirs = centre_distance(&space, &piece_state(&space, &p), &piece_state(&space, &q));
            let (u, v) = (ambient(&kf, p.x, p.y), ambient(&kf, q.x, q.y));
            let mine = kf.dist(&u, &v);
            assert!((mine - theirs).abs() <= 1e-12 * (1.0 + theirs), "K={k}: {mine} vs {theirs}");
            // the bilinear form gives cs(distance)
            let ip = u[0] * v[0] + k * (u[1] * v[1] + u[2] * v[2]);
            assert!((ip - kf.cs(theirs)).abs() <= 1e-11 * (1.0 + ip.abs()), "K={k}: <u,v> {ip} vs cs {}", kf.cs(theirs));
            // the distance from O
            assert!((kf.dist_o(&u) - r1).abs() <= 1e-12 * (1.0 + r1));
        }
    }
}

#[test]
fn curved_tight_container_agrees_with_the_validator() {
    // one disk: the smallest container that holds it, ours (finish) against the validator's tight_size
    let mut rng = Rng::new(5);
    for &k in &[-1.0, 1.0, -0.5] {
        for &m in &[0u32, 3, 4, 5, 6, 8] {
            let kf = Kf::new(k);
            let problem = CurvedProblem { k, n: 0, m, p: 1 };
            let mut model = Curved::new(k, m, 1);
            let lim = if k > 0.0 { 0.6 } else { 0.9 };
            for _ in 0..300 {
                let r = lim * rng.uniform();
                let a = 6.3 * rng.uniform();
                let v = kf.polar(r, a);
                let mut x = vec![0.0; model.dim()];
                if model.stride == 2 {
                    x[0] = v[1];
                    x[1] = v[2];
                } else {
                    x[..3].copy_from_slice(&v);
                }
                let Some((size, config)) = model.finish(&x, 1e-12) else {
                    // no container of this kind holds the disk there (beyond the ideal polygon): the
                    // validator's smallest size is not finite either
                    let pose = Pose { x: r * a.cos(), y: r * a.sin(), theta: 0.0 };
                    let c = CurvedConfig { size: 1.0, pieces: vec![pose] };
                    let res = validation_steps(&problem, &c, &ValidationOptions::default());
                    assert!(!res.tight_size.is_finite(), "K={k} M={m}: we found none, validator {}", res.tight_size);
                    continue;
                };
                let c: CurvedConfig = serde_json::from_value(config).unwrap();
                let res = validation_steps(&problem, &c, &ValidationOptions::default());
                if !res.tight_size.is_finite() {
                    assert!(!size.is_finite() || size > 1e3, "K={k} M={m}: {size} vs inf");
                    continue;
                }
                assert!((size - res.tight_size).abs() <= 1e-11 * res.tight_size, "K={k} M={m}: {size} vs {}", res.tight_size);
                assert!(res.valid, "K={k} M={m}: {:?}", res.errors);
                // a hair smaller is not valid (the container is tight)
                let smaller = CurvedConfig { size: res.tight_size * (1.0 - 1e-6), pieces: c.pieces.clone() };
                let strict = ValidationOptions { tol: 1e-12, ..ValidationOptions::default() };
                assert!(!validation_steps(&problem, &smaller, &strict).valid, "K={k} M={m}: not tight");
            }
        }
    }
}

#[test]
fn curved_constraints_have_the_validator_s_sign() {
    // random configurations: a configuration that our constraints call feasible (with a margin) the
    // validator accepts, and one that overlaps by a margin it rejects
    let mut rng = Rng::new(9);
    for &(k, m, p) in &[(-1.0, 0u32, 7usize), (-1.0, 6, 5), (1.0, 0, 5), (1.0, 4, 5), (-1.0, 8, 6)] {
        let problem = CurvedProblem { k, n: 0, m, p: p as u32 };
        let mut model = Curved::new(k, m, p);
        let mut agree = 0;
        for trial in 0..400 {
            let mut x = vec![0.0; model.dim()];
            model.start(&mut rng, &mut x, trial);
            let mut rows = polypack_fresh_round::model::Rows::default();
            let worst = model.rows(&x, &|_, _| false, &mut rows);
            let (size, config) = match model.finish(&x, f64::INFINITY) {
                Some(f) => f,
                None => continue,
            };
            let c: CurvedConfig = serde_json::from_value(config).unwrap();
            let res = validation_steps(&problem, &c, &ValidationOptions::default());
            if worst < -1e-6 {
                assert!(res.valid, "K={k} M={m}: ours feasible, validator {:?} size {size}", res.errors);
                agree += 1;
            } else if worst > 1e-6 {
                assert!(!res.valid, "K={k} M={m}: ours infeasible ({worst}), validator valid");
                agree += 1;
            }
        }
        assert!(agree > 50, "too few decided cases ({agree})");
    }
}

#[test]
fn sphere_centres_and_gaps_agree_with_the_validator() {
    let mut rng = Rng::new(3);
    for _ in 0..200 {
        let p = 2 + rng.below(30);
        let mut cs = Vec::new();
        let mut pieces = Vec::new();
        for _ in 0..p {
            let v = loop {
                let v = [rng.normal(), rng.normal(), rng.normal()];
                let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                if n > 1e-3 {
                    break [v[0] / n, v[1] / n, v[2] / n];
                }
            };
            let q = quat_to(&v);
            let c = centre_of(&q);
            for d in 0..3 {
                assert!((c[d] - v[d]).abs() < 1e-14, "centre {c:?} vs {v:?}");
            }
            cs.push(v);
            pieces.push(SpherePiece { q: q.to_vec() });
        }
        let rho = 0.3 + 2.0 * rng.uniform();
        let config = SphereConfig { rho, pieces };
        let gaps = polypack_sphere::pair_gaps(&SphereProblem { n: 0.0, p: p as f64 }, &config, &Default::default());
        for g in gaps {
            let (a, b) = (&cs[g.i], &cs[g.j]);
            let ang = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).clamp(-1.0, 1.0).acos();
            let mine = rho * ang - 1.0;
            assert!((mine - g.gap).abs() < 1e-12, "{mine} vs {}", g.gap);
        }
    }
}
