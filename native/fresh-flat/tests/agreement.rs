//! The solver's own geometry against the client's check (`polypack_flat::validate::server_check`).

use polypack_flat::shapes::{Config, Pose, Problem};
use polypack_flat::validate::server_check;
use polypack_fresh_flat::geom::{sat_sep, Shape};
use polypack_fresh_flat::rng::Rng;
use polypack_fresh_flat::search::Search;
use std::f64::consts::PI;

const NS: [usize; 7] = [0, 3, 4, 5, 6, 7, 8];
const MS: [usize; 6] = [0, 3, 4, 5, 6, 8];

fn check(n: usize, m: usize, pieces: Vec<Pose>) -> polypack_flat::validate::ServerCheck {
    let p = pieces.len();
    server_check(&Config::new(Problem::new(n as u32, m as u32, p), pieces, 0.0), p)
}

/// Two pieces placed at a given separation along a random direction: the check calls them strict
/// exactly when the solver's separation says they do not overlap (away from the 1e-12 threshold).
#[test]
fn pair_separation_agrees_with_check() {
    let mut rng = Rng::new(11);
    let mut tested = 0;
    for &n in &NS {
        let sh = Shape::new(n, 4);
        for _ in 0..3000 {
            let ta = if n == 0 { 0.0 } else { rng.uniform() * 2.0 * PI };
            let tb = if n == 0 { 0.0 } else { rng.uniform() * 2.0 * PI };
            let dir = rng.uniform() * 2.0 * PI;
            let a = [rng.signed() * 3.0, rng.signed() * 3.0, ta];
            // bring b along dir until the separation crosses a chosen target by bisection
            let target = match rng.below(4) {
                0 => 1e-9,
                1 => -1e-9,
                2 => 1e-6 * rng.signed(),
                _ => 0.3 * rng.signed(),
            };
            let at = |d: f64| [a[0] + d * dir.cos(), a[1] + d * dir.sin(), tb];
            let (mut lo, mut hi) = (0.0, 4.0 * sh.big_r);
            for _ in 0..200 {
                let mid = 0.5 * (lo + hi);
                if sat_sep(&sh, a, at(mid)) < target {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            let b = at(hi);
            let sep = sat_sep(&sh, a, b);
            let chk = check(n, 4, vec![Pose::new(a[0], a[1], a[2]), Pose::new(b[0], b[1], b[2])]);
            if sep > 2e-12 {
                assert!(chk.valid && chk.strict, "n={n} sep {sep:e} rejected");
            } else if sep < -2e-12 {
                assert!(!chk.strict, "n={n} sep {sep:e} accepted as strict");
                if sep < -2e-9 {
                    assert!(!chk.valid, "n={n} sep {sep:e} accepted");
                }
            }
            tested += 1;
        }
    }
    assert!(tested > 20000);
}

/// The container the solver fits around pieces (centred on the check's container centre, phi = 0)
/// has the size of the check's score, for random configurations of every shape pairing.
#[test]
fn container_fit_agrees_with_check() {
    let mut rng = Rng::new(5);
    for &n in &NS {
        for &m in &MS {
            let sh = Shape::new(n, m);
            for _ in 0..40 {
                let p = 1 + rng.below(6);
                let pieces: Vec<Pose> = (0..p).map(|_| Pose::new(5.0 * rng.signed(), 5.0 * rng.signed(), if n == 0 { 0.0 } else { rng.uniform() * 7.0 })).collect();
                let chk = check(n, m, pieces.clone());
                let c = chk.container.expect("a container");
                let dim = if n == 0 { 2 } else { 3 };
                let mut q = Vec::new();
                for pc in &pieces {
                    q.push(pc.x - c.cx);
                    q.push(pc.y - c.cy);
                    if dim == 3 {
                        q.push(pc.theta);
                    }
                }
                let fit = sh.fit_size(&q, p);
                let score = chk.score.unwrap();
                assert!((fit - score).abs() <= 1e-9 * score.max(1.0), "n={n} m={m} p={p}: fit {fit} check {score}");
            }
        }
    }
}

/// Short runs on every shape pairing return a packing the check accepts as valid and strict, at the
/// score reported.
#[test]
fn short_runs_pass_the_check() {
    for &n in &NS {
        for &m in &MS {
            let p = 5 + (n * 7 + m * 3) % 20;
            let mut s = Search::new(n, m, p, 1 + n as u64, polypack_flat::clock::thread_cpu_seconds());
            s.model.eval_limit = 60_000;
            s.run();
            assert!(!s.best_q.is_empty(), "n={n} m={m} p={p}: no packing");
            let cfg = s.config(&s.best_q);
            let chk = server_check(&cfg, p);
            assert!(chk.valid && chk.strict, "n={n} m={m} p={p}: {:?}", chk.reasons);
            assert_eq!(chk.score.unwrap(), s.best_score);
            let last = s.trace.last().unwrap().1;
            assert_eq!(last, s.best_score);
            for w in s.trace.windows(2) {
                assert!(w[1].1 < w[0].1 && w[1].0 >= w[0].0);
            }
        }
    }
}

/// The same seed and evaluation budget give the same packing.
#[test]
fn evaluation_budget_repeats() {
    let run = || {
        let mut s = Search::new(5, 6, 14, 9, polypack_flat::clock::thread_cpu_seconds());
        s.model.eval_limit = 80_000;
        s.run();
        (s.best_score, s.best_q.clone(), s.model.evals)
    };
    assert_eq!(run(), run());
}
