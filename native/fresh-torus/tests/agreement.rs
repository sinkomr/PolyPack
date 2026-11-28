//! The solver's geometry against the server's validator (polypack-torus): pair separations, the minimum over
//! all image pairs of a packing (across the periodic boundary, skewed bases, near contact), the energy's zero
//! set, the repair and the lattice starts.

use fresh_torus::geom::{min_separation, repair_scale, scale_to_contact, Family, Shape, Sol};
use fresh_torus::lattice::{double_lattice, free_lattice, superlattice};
use fresh_torus::rng::Rng;
use fresh_torus::search::{check, config_value};
use polypack_torus::{validation_steps, Lattice, Pose, TorusFamily, TorusPacking, ValidateOptions};

const NS: [usize; 11] = [0, 3, 4, 5, 6, 7, 8, 12, 31, 64, 100];

fn validator_sep(n: usize, a: [f64; 3], b: [f64; 3]) -> f64 {
    let pa = Pose { x: a[0], y: a[1], theta: a[2] };
    let pb = Pose { x: b[0], y: b[1], theta: b[2] };
    polypack_torus::disk::separation_of(n as f64, &pa, &pb, 1.0, 0.5)
}

fn validator_min_sep(fam: Family, n: usize, sol: &Sol) -> (f64, bool) {
    let family = match fam {
        Family::Sq => TorusFamily::Sq,
        Family::Hex => TorusFamily::Hex,
        Family::Free => TorusFamily::Free,
    };
    let packing = TorusPacking {
        family,
        n: n as f64,
        lattice: Lattice { b1: [sol.b[0], sol.b[1]], b2: [sol.b[2], sol.b[3]] },
        poses: (0..sol.p()).map(|i| Pose { x: sol.pos[2 * i], y: sol.pos[2 * i + 1], theta: sol.ang[i] }).collect(),
    };
    let v = validation_steps(&packing, &ValidateOptions { tol: Some(0.0), ..Default::default() });
    (v.min_sep, v.valid)
}

/// Random packing: centres anywhere in a window three cells wide (across the boundary), random angles; free:
/// a random, possibly skewed basis.
fn random_packing(rng: &mut Rng, fam: Family, sh: &Shape, p: usize, density: f64) -> Sol {
    let area = p as f64 * sh.area / density;
    let mut sol = Sol::new(p);
    sol.b = match fam {
        Family::Free => {
            let a = area.sqrt() * (0.5 * rng.signed()).exp();
            let skew = 2.5 * rng.signed();
            let ang = 3.0 * rng.signed();
            let (s, c) = ang.sin_cos();
            let b1 = [a, 0.0];
            let b2 = [skew * a, area / a];
            [c * b1[0] - s * b1[1], s * b1[0] + c * b1[1], c * b2[0] - s * b2[1], s * b2[0] + c * b2[1]]
        }
        _ => {
            let l = (area / if fam == Family::Hex { 3f64.sqrt() / 2.0 } else { 1.0 }).sqrt();
            fam.basis(l)
        }
    };
    sol.s = (sol.b[0] * sol.b[3] - sol.b[1] * sol.b[2]).abs().sqrt();
    for i in 0..p {
        let f = [3.0 * rng.uniform() - 1.0, 3.0 * rng.uniform() - 1.0];
        sol.pos[2 * i] = f[0] * sol.b[0] + f[1] * sol.b[2];
        sol.pos[2 * i + 1] = f[0] * sol.b[1] + f[1] * sol.b[3];
        sol.ang[i] = 20.0 * rng.signed();
    }
    sol
}

#[test]
fn pair_separation_agrees_with_the_validator() {
    let mut rng = Rng::new(1);
    for &n in &NS {
        let sh = Shape::new(n);
        for k in 0..400 {
            let ta = 10.0 * rng.signed();
            let tb = 10.0 * rng.signed();
            let dir = 7.0 * rng.signed();
            let mut d = [dir.cos(), dir.sin()];
            // half the cases at a random distance, half scaled to touching (then nudged by 1e-9 either way)
            let r = 2.2 * sh.big_r * rng.uniform();
            d = [d[0] * r, d[1] * r];
            if k % 2 == 1 {
                let lam = sh.pair_scale(ta, tb, d, 0.0);
                let nudge = 1.0 + 1e-9 * rng.signed();
                d = [d[0] * lam * nudge, d[1] * lam * nudge];
            }
            let mine = sh.sep(ta, tb, d);
            let theirs = validator_sep(n, [0.0, 0.0, ta], [d[0], d[1], tb]);
            assert!((mine - theirs).abs() <= 1e-12 * (1.0 + sh.big_r), "n={n}: solver {mine} validator {theirs} d {d:?}");
            if k % 2 == 1 {
                // at the contact factor the pair touches
                let at = sh.sep(ta, tb, [d[0] / (1.0 + 0.0), d[1]]);
                assert!(at.abs() < 1e-7 * (1.0 + sh.big_r), "n={n}: separation at contact {at}");
            }
        }
    }
}

#[test]
fn packing_minimum_agrees_with_the_validator() {
    let mut rng = Rng::new(2);
    for fam in [Family::Sq, Family::Hex, Family::Free] {
        for &n in &NS {
            let sh = Shape::new(n);
            for &p in &[1usize, 2, 5, 13] {
                for density in [0.3, 0.6, 0.85] {
                    let sol = random_packing(&mut rng, fam, &sh, p, density);
                    let mine = min_separation(&sh, &sol);
                    let (theirs, _) = validator_min_sep(fam, n, &sol);
                    let tol = 1e-11 * (1.0 + sol.s);
                    assert!((mine - theirs).abs() <= tol || (mine.is_infinite() && theirs.is_infinite()), "{fam:?} n={n} p={p}: solver {mine} validator {theirs}");
                }
            }
        }
    }
}

#[test]
fn repair_and_contact_scaling_are_valid_and_tight() {
    let mut rng = Rng::new(3);
    for fam in [Family::Sq, Family::Hex, Family::Free] {
        for &n in &NS {
            let sh = Shape::new(n);
            for &p in &[1usize, 3, 8] {
                let mut sol = random_packing(&mut rng, fam, &sh, p, 0.7);
                let target = 1e-13;
                let lam = repair_scale(&sh, &sol, target);
                sol.scale(lam);
                let (m, valid) = validator_min_sep(fam, n, &sol);
                assert!(valid && m >= 0.5 * target, "{fam:?} n={n} p={p}: repaired min sep {m}");
                // and tight: some pair is within a hair of touching (unless nothing needed repair)
                if lam > 1.0 {
                    assert!(m < 1e-9 * (1.0 + sh.big_r), "{fam:?} n={n} p={p}: repair not tight, min sep {m}");
                }
                let mut c = random_packing(&mut rng, fam, &sh, p, 0.5);
                assert!(scale_to_contact(&sh, &mut c));
                let (m, valid) = validator_min_sep(fam, n, &c);
                assert!(valid && m < 1e-9 * (1.0 + c.s), "{fam:?} n={n} p={p}: contact scaling min sep {m}");
            }
        }
    }
}

#[test]
fn energy_is_zero_exactly_on_valid_packings() {
    use fresh_torus::budget::Budget;
    use fresh_torus::model::Model;
    let mut rng = Rng::new(4);
    for fam in [Family::Sq, Family::Hex, Family::Free] {
        for &n in &NS {
            let sh = Shape::new(n);
            for &p in &[1usize, 2, 6] {
                for density in [0.4, 0.8] {
                    let mut sol = random_packing(&mut rng, fam, &sh, p, density);
                    // the solver's frame: canonical (free: reduced, b1 along +x)
                    if fam == Family::Free {
                        fresh_torus::geom::canonicalize(&mut sol, true);
                    }
                    let mut model = Model::new(sh.clone(), fam, p, Budget::new(1e9, None, None, None));
                    let ms = min_separation(&sh, &sol);
                    if ms.abs() < 1e-9 {
                        continue;
                    }
                    let e = model.energy(&sol, false);
                    if ms > 0.0 {
                        assert!(e == 0.0, "{fam:?} n={n} p={p}: valid (min sep {ms}) but energy {e}");
                    } else {
                        assert!(e > 0.0, "{fam:?} n={n} p={p}: overlap {ms} but zero energy");
                    }
                }
            }
        }
    }
}

#[test]
fn lattice_starts_pass_the_check() {
    let mut rng = Rng::new(5);
    for (fam, name) in [(Family::Sq, "sq"), (Family::Hex, "hex"), (Family::Free, "free")] {
        for &n in &[0usize, 3, 4, 5, 6, 7, 30, 100] {
            for &p in &[1usize, 2, 7, 12, 30, 101] {
                let sh = Shape::new(n);
                let id = format!("torus/{name}/{n}/{p}");
                let mut sols = Vec::new();
                if fam == Family::Free {
                    sols.push(free_lattice(&sh, p, None).sol);
                } else {
                    sols.push(superlattice(&sh, fam, p, 1, None).remove(0).sol);
                }
                if p % 2 == 0 {
                    let mut d = double_lattice(&sh, fam, p, &mut rng).expect("a double lattice");
                    fresh_torus::search::normalize_frame(fam, &mut d);
                    let lam = repair_scale(&sh, &d, 1e-13);
                    d.scale(lam);
                    fresh_torus::search::normalize_frame(fam, &mut d);
                    sols.push(d);
                }
                for s in &sols {
                    let mut s = s.clone();
                    fresh_torus::search::normalize_frame(fam, &mut s);
                    fresh_torus::geom::canonicalize(&mut s, fam == Family::Free);
                    let lam = repair_scale(&sh, &s, 1e-13);
                    assert!(lam < 1.0 + 1e-9, "{id}: a lattice start needs a repair of {lam}");
                    s.scale(lam);
                    fresh_torus::search::normalize_frame(fam, &mut s);
                    let cfg = config_value(fam, &s);
                    assert!(check(&id, &cfg).is_some(), "{id}: lattice start refused by the check");
                }
            }
        }
    }
}
