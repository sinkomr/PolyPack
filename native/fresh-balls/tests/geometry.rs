//! The search's containment and overlap terms against the server's validator (polypack-balls), on random cases.

use fresh_balls::energy::Energy;
use fresh_balls::rng::Rng;
use fresh_balls::search::Search;
use fresh_balls::shape::Shape;
use polypack_balls::{get_balls_problem, validate_balls, BallsConfig, BallsProblem, BallsValidateOptions};

/// Containers of different kinds: the ball, the cube (the validator's own formula), Platonic, Catalan,
/// bipyramids, prisms and Johnson solids (centroid not the centre of the largest ball).
const CODES: &[&str] = &[
    "ballinball", "ballincub", "ballintet", "ballinico", "ballinpkd", "ballinbp3", "ballinbp10", "ballinj86", "ballinj63",
    "ballinj25", "ballinj52", "ballinj54", "ballinj55", "ballinpr3l3", "ballintz5",
];

fn problem(code: &str) -> &'static BallsProblem {
    get_balls_problem(code).unwrap_or_else(|| panic!("no problem {code}"))
}

fn validate(code: &str, s: f64, pieces: &[[f64; 3]], tol: f64) -> polypack_balls::BallsValidation {
    let cfg = BallsConfig { s, pieces: pieces.iter().map(|c| c.to_vec()).collect() };
    validate_balls(problem(code), &cfg, &BallsValidateOptions { tol: Some(tol), max_errors: Some(1000) }).unwrap()
}

fn random_point(shape: &Shape, s: f64, rng: &mut Rng) -> [f64; 3] {
    // the bounding box enlarged by a quarter, so that points fall inside and outside
    let mut c = [0.0; 3];
    for d in 0..3 {
        let (a, b) = (s * shape.lo[d], s * shape.hi[d]);
        let m = 0.5 * (a + b);
        let h = 0.5 * (b - a) * 1.25;
        c[d] = rng.range(m - h, m + h);
    }
    c
}

#[test]
fn wall_gap_and_size_agree_with_the_validator() {
    let mut rng = Rng::new(7);
    for code in CODES {
        let shape = Shape::of_name(&problem(code).container).unwrap();
        for _ in 0..400 {
            let s = rng.range(1.5, 6.0);
            let c = random_point(&shape, s, &mut rng);
            let v = validate(code, s, &[c], 1e-9);
            let mine = shape.gap(s, &c);
            assert!((mine - v.min_wall_gap).abs() <= 1e-12 * s, "{code}: gap {mine} vs validator {}", v.min_wall_gap);
            // the least size that holds the centre has gap zero there, and the validator accepts it
            let need = shape.size_for(&c);
            if need > 1.0 {
                let g = shape.gap(need, &c);
                assert!(g.abs() <= 1e-12 * need, "{code}: gap {g} at the size the centre needs");
                assert!(validate(code, need * (1.0 + 1e-15), &[c], 0.0).valid, "{code}: size_for not accepted");
                assert!(!validate(code, need * (1.0 - 1e-6), &[c], 0.0).valid, "{code}: size_for not least");
            }
        }
    }
}

/// The energy's terms against the validator: each pair term is the square of the validator's overlap depth of
/// that pair, and a ball's wall term is the sum over faces of the squared protrusions, so it lies between the
/// square of the validator's worst protrusion and F times it (equal to it for the ball container); the energy is
/// zero exactly when the validator (at tolerance 0) accepts the packing.
#[test]
fn energy_terms_are_the_validators_depths() {
    let mut rng = Rng::new(11);
    for code in CODES {
        let shape = Shape::of_name(&problem(code).container).unwrap();
        let faces = shape.nf.max(1) as f64;
        for _ in 0..60 {
            let p = 2 + rng.below(7);
            let s = rng.range(1.5, 4.0);
            let mut pts = Vec::new();
            for _ in 0..p {
                pts.push(random_point(&shape, s, &mut rng));
            }
            let x: Vec<f64> = pts.iter().flat_map(|c| c.iter().copied()).collect();
            let mut g = vec![0.0; 3 * p];
            // pairs alone: a container far too big to touch
            let huge = 1e5;
            let mut pair_ref = 0.0;
            for i in 0..p {
                for j in i + 1..p {
                    let v = validate(code, huge, &[pts[i], pts[j]], 1e-9);
                    if v.min_pair_sep.is_finite() {
                        pair_ref += v.min_pair_sep.min(0.0).powi(2);
                    }
                }
            }
            let mut en = Energy::new(&shape, p);
            en.set_size(huge);
            let e_pairs = en.eval(&x, &mut g);
            assert!((e_pairs - pair_ref).abs() <= 1e-11 * (1.0 + pair_ref), "{code}: pair energy {e_pairs} vs validator {pair_ref}");
            // walls one ball at a time
            for c in &pts {
                let gap = validate(code, s, &[*c], 1e-9).min_wall_gap;
                let worst = gap.min(0.0).powi(2);
                let mut e1 = Energy::new(&shape, 1);
                e1.set_size(s);
                let mut g1 = [0.0; 3];
                let ew = e1.eval(c, &mut g1);
                assert!(ew >= worst * (1.0 - 1e-11) - 1e-300 && ew <= faces * worst * (1.0 + 1e-11), "{code}: wall energy {ew}, worst protrusion squared {worst}");
                if shape.ball {
                    assert!((ew - worst).abs() <= 1e-11 * (1.0 + worst));
                }
            }
            en.set_size(s);
            let e = en.eval(&x, &mut g);
            let valid = validate(code, s, &pts, 0.0).valid;
            assert_eq!(e == 0.0, valid, "{code}: energy {e}, validator valid {valid}");
        }
    }
}

#[test]
fn zero_energy_agrees_with_validity_near_contact() {
    // packings relaxed at a size, then checked at sizes just above and below: many cases near contact
    let mut rng = Rng::new(5);
    for code in CODES {
        let shape = Shape::of_name(&problem(code).container).unwrap();
        let p = 8;
        let mut search = Search::new(&shape, p, 3, u64::MAX, 1e9);
        let s = shape.size_at_density(p, 0.4);
        let mut x = vec![0.0; 3 * p];
        search.start_random(s, &mut x);
        search.relax(&mut x, s, &fresh_balls::lbfgs::Tol { e_stop: 0.0, rel: 1e-14, patience: 5, gtol: 0.0, max_iter: 2000, max_step: 0.2 });
        let pts: Vec<[f64; 3]> = x.chunks(3).map(|c| [c[0], c[1], c[2]]).collect();
        for _ in 0..50 {
            let st = s * (1.0 + rng.range(-1e-3, 1e-3));
            let mut en = Energy::new(&shape, p);
            en.set_size(st);
            let mut g = vec![0.0; 3 * p];
            let e = en.eval(&x, &mut g);
            let v = validate(code, st, &pts, 0.0);
            assert_eq!(e == 0.0, v.valid, "{code}: s {st} energy {e} valid {}", v.valid);
        }
    }
}

#[test]
fn gradient_matches_finite_differences() {
    let mut rng = Rng::new(3);
    for code in CODES {
        let shape = Shape::of_name(&problem(code).container).unwrap();
        let p = 10;
        let s = shape.size_at_density(p, 0.6);
        let mut en = Energy::new(&shape, p);
        en.set_size(s);
        let mut x = vec![0.0; 3 * p];
        for i in 0..p {
            let c = random_point(&shape, s, &mut rng);
            x[3 * i..3 * i + 3].copy_from_slice(&c);
        }
        let mut g = vec![0.0; 3 * p];
        let mut gd = vec![0.0; 3 * p];
        let e0 = en.eval(&x, &mut g);
        assert!(e0 > 0.0);
        let h = 1e-6;
        for k in 0..3 * p {
            let mut xp = x.clone();
            xp[k] += h;
            let ep = en.eval(&xp, &mut gd);
            let mut xm = x.clone();
            xm[k] -= h;
            let em = en.eval(&xm, &mut gd);
            let fd = (ep - em) / (2.0 * h);
            assert!((fd - g[k]).abs() <= 1e-5 * (1.0 + g[k].abs()), "{code}: d/dx{k} analytic {} numeric {fd}", g[k]);
        }
    }
}

#[test]
fn neighbour_lists_give_the_full_energy() {
    // after many small moves (lists kept) and size changes, the energy equals a fresh evaluation's
    let mut rng = Rng::new(9);
    for code in CODES {
        let shape = Shape::of_name(&problem(code).container).unwrap();
        let p = 20;
        let mut s = shape.size_at_density(p, 0.55);
        let mut en = Energy::new(&shape, p);
        en.set_size(s);
        let mut x = vec![0.0; 3 * p];
        for i in 0..p {
            shape.random_inside(s, 0.0, &mut rng, &mut x[3 * i..3 * i + 3]);
        }
        let mut g = vec![0.0; 3 * p];
        let mut g2 = vec![0.0; 3 * p];
        for _ in 0..300 {
            for v in x.iter_mut() {
                *v += rng.range(-0.03, 0.03);
            }
            s *= 1.0 + rng.range(-0.004, 0.003);
            en.set_size(s);
            let e = en.eval(&x, &mut g);
            let mut fresh = Energy::new(&shape, p);
            fresh.set_size(s);
            let e2 = fresh.eval(&x, &mut g2);
            assert!((e - e2).abs() <= 1e-13 * (1.0 + e2), "{code}: listed {e} vs full {e2}");
        }
    }
}

#[test]
fn repair_gives_packings_the_check_accepts() {
    let mut rng = Rng::new(13);
    for code in CODES {
        let shape = Shape::of_name(&problem(code).container).unwrap();
        for _ in 0..40 {
            let p = 2 + rng.below(30);
            let s = shape.size_at_density(p, rng.range(0.2, 0.9));
            let mut x = vec![0.0; 3 * p];
            for i in 0..p {
                let c = random_point(&shape, s, &mut rng);
                x[3 * i..3 * i + 3].copy_from_slice(&c);
            }
            let mut out = vec![0.0; 3 * p];
            let sr = Search::repair(&shape, p, &x, &mut out);
            let id = format!("balls/{code}/{p}");
            let cfg = fresh_balls::config_json(sr, &out);
            assert_eq!(fresh_balls::check(&id, &cfg), Some(sr), "{id}: repaired packing refused");
            // and it is valid without the tolerance
            let pts: Vec<[f64; 3]> = out.chunks(3).map(|c| [c[0], c[1], c[2]]).collect();
            assert!(validate(code, sr, &pts, 0.0).valid, "{id}: repair valid only within the tolerance");
        }
    }
}

#[test]
fn starts_lie_in_the_container() {
    for code in CODES {
        let shape = Shape::of_name(&problem(code).container).unwrap();
        for (f, edges) in shape.face_edges.iter().enumerate() {
            let n = &shape.n[3 * f..3 * f + 3];
            for t in edges {
                assert!((t[0] * t[0] + t[1] * t[1] + t[2] * t[2] - 1.0).abs() < 1e-12);
                assert!((t[0] * n[0] + t[1] * n[1] + t[2] * n[2]).abs() < 1e-12, "{code}: edge not in its face");
            }
        }
        for p in [5usize, 23, 60] {
            let mut search = Search::new(&shape, p, 17, u64::MAX, 1e9);
            // lattices are scaled towards the origin, which must then be a valid centre (s b_f > R for every
            // face); the search's sizes are far above that
            let s = shape.size_at_density(p, 0.5).max(1.5 * 0.5 / shape.bmin);
            let mut x = vec![0.0; 3 * p];
            for k in 0..12 {
                if k % 3 == 0 {
                    search.start_random(s, &mut x);
                } else {
                    search.start_lattice(s, &mut x);
                }
                for c in x.chunks(3) {
                    assert!(shape.size_for(c) <= s * (1.0 + 1e-12), "{code}: start (kind {}) outside at P = {p}: {} > {s}", k % 3, shape.size_for(c));
                }
            }
        }
    }
}
