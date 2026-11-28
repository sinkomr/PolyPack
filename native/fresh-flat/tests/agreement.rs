//! The solver's own geometry against the client's check (`polypack_flat::validate::server_check`, and
//! the separation it applies, `polypack_flat::overlap::pair_separation`).

use polypack_flat::overlap::pair_separation;
use polypack_flat::shapes::{Config, Pose, Problem};
use polypack_flat::validate::server_check;
use polypack_fresh_flat::geom::{sat_sep, Shape};
use polypack_fresh_flat::rng::Rng;
use polypack_fresh_flat::search::Search;
use std::f64::consts::PI;

/// Piece shapes: the ones of the first benchmark and many-sided ones up to the limit.
const NS: [usize; 16] = [0, 3, 4, 5, 6, 7, 8, 9, 12, 17, 25, 33, 40, 64, 99, 100];
/// Container shapes likewise.
const MS: [usize; 13] = [0, 3, 4, 5, 6, 8, 9, 12, 16, 33, 64, 97, 100];

fn check(n: usize, m: usize, pieces: Vec<Pose>) -> polypack_flat::validate::ServerCheck {
    let p = pieces.len();
    server_check(&Config::new(Problem::new(n as u32, m as u32, p), pieces, 0.0), p)
}

/// Two pieces placed at a given separation along a direction: the check calls them strict exactly
/// when the solver's separation says they do not overlap (away from the 1e-12 threshold), and the
/// solver's closed-form separation equals the check's (which projects on all 2N edge normals).
/// A third of the cases are face-to-face: the second piece turned so that a face of each is
/// parallel, approached along that face normal.
#[test]
fn pair_separation_agrees_with_check() {
    let mut rng = Rng::new(11);
    let mut tested = 0;
    for &n in &NS {
        let sh = Shape::new(n, 4);
        let cases = if n <= 8 { 3000 } else { 1500 };
        for c in 0..cases {
            let ta = if n == 0 { 0.0 } else { rng.uniform() * 2.0 * PI };
            let face = n > 0 && c % 3 == 0;
            let (tb, dir) = if face {
                // a face normal of a, and b turned so that one of its faces looks back along it
                let k = rng.below(n) as f64;
                let normal = ta + PI / 2.0 + PI / n as f64 + 2.0 * PI * k / n as f64;
                let tb = ta + PI + 2.0 * PI * rng.below(n) as f64 / n as f64 + if rng.chance(0.3) { 1e-9 * rng.signed() } else { 0.0 };
                (tb, normal + if rng.chance(0.5) { 0.0 } else { 0.2 * rng.signed() / n as f64 })
            } else {
                (if n == 0 { 0.0 } else { rng.uniform() * 2.0 * PI }, rng.uniform() * 2.0 * PI)
            };
            let a = [rng.signed() * 3.0, rng.signed() * 3.0, ta];
            // bring b along dir until the separation crosses a chosen target by bisection
            let target = match rng.below(4) {
                0 => 1e-9,
                1 => -1e-9,
                2 => 1e-6 * rng.signed(),
                _ => 0.3 * rng.signed() * sh.big_r.max(1.0),
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
            let pa = Pose::new(a[0], a[1], a[2]);
            let pb = Pose::new(b[0], b[1], b[2]);
            let theirs = pair_separation(n as u32, &pa, &pb, 1.0);
            let tol = 1e-13 * (1.0 + 4.0 * sh.big_r);
            assert!((sep - theirs).abs() <= tol, "n={n} face={face}: solver {sep:e} check {theirs:e}");
            let chk = check(n, 4, vec![pa, pb]);
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
    assert!(tested > 30000);
}

/// The container the solver fits around pieces (centred on the check's container centre, phi = 0)
/// has the size of the check's score, for random configurations of every shape pairing, and for
/// configurations whose pieces all touch the container the solver fitted (near contact: the
/// pieces pushed out to the wall along random rays).
#[test]
fn container_fit_agrees_with_check() {
    let mut rng = Rng::new(5);
    for &n in &NS {
        for &m in &MS {
            let sh = Shape::new(n, m);
            for rep in 0..24 {
                let p = 1 + rng.below(6);
                let spread = 5.0 * sh.big_r.max(1.0);
                let mut pieces: Vec<Pose> = (0..p).map(|_| Pose::new(spread * rng.signed(), spread * rng.signed(), if n == 0 { 0.0 } else { rng.uniform() * 7.0 })).collect();
                if rep % 2 == 1 {
                    // every piece pushed along its ray from the origin until it touches the
                    // container of size s0 centred at the origin
                    let s0 = 4.0 * sh.area_bound(p).max(2.0 * sh.big_r / sh.k_in);
                    for pc in pieces.iter_mut() {
                        let (ux, uy) = (pc.x, pc.y);
                        let (mut lo, mut hi) = (0.0, 10.0 * s0);
                        for _ in 0..200 {
                            let mid = 0.5 * (lo + hi);
                            if sh.piece_gauge(mid * ux, mid * uy, pc.theta) < s0 {
                                lo = mid;
                            } else {
                                hi = mid;
                            }
                        }
                        pc.x = lo * ux;
                        pc.y = lo * uy;
                    }
                }
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
                assert!((fit - score).abs() <= 1e-9 * score.max(1.0), "n={n} m={m} p={p} rep={rep}: fit {fit} check {score}");
            }
        }
    }
}

/// Short runs on shape pairings return a packing the check accepts as valid and strict, at the
/// score reported: every pairing of the first benchmark's shapes, and many-sided pieces and
/// containers up to the limit.
#[test]
fn short_runs_pass_the_check() {
    let mut cases = Vec::new();
    for &n in &[0usize, 3, 4, 5, 6, 7, 8] {
        for &m in &[0usize, 3, 4, 5, 6, 8] {
            cases.push((n, m, 5 + (n * 7 + m * 3) % 20, 60_000u64));
        }
    }
    for &(n, m, p) in &[(17, 9, 12), (25, 0, 20), (40, 4, 15), (64, 33, 10), (100, 0, 12), (100, 3, 7), (100, 100, 9), (12, 100, 30), (3, 100, 25), (0, 100, 40), (9, 16, 18), (99, 64, 2), (33, 97, 50)] {
        cases.push((n, m, p, 40_000));
    }
    for (n, m, p, evals) in cases {
        let mut s = Search::new(n, m, p, 1 + n as u64, polypack_flat::clock::thread_cpu_seconds());
        s.model.eval_limit = evals;
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

/// The same seed and evaluation budget give the same packing.
#[test]
fn evaluation_budget_repeats() {
    for &(n, m, p, seed) in &[(5usize, 6usize, 14usize, 9u64), (40, 33, 12, 4), (3, 64, 20, 2), (100, 5, 8, 7)] {
        let run = || {
            let mut s = Search::new(n, m, p, seed, polypack_flat::clock::thread_cpu_seconds());
            s.model.eval_limit = 80_000;
            s.run();
            (s.best_score, s.best_q.clone(), s.model.evals)
        };
        assert_eq!(run(), run(), "n={n} m={m} p={p}");
    }
}
