//! The solver's own geometry against the validator's: pair separation, containment depth, the fit scale,
//! repair, the face classes and their maps, and the gradient of the objective.

use fresh_surface_nofold::geom::{margin, repair, Container, Piece};
use fresh_surface_nofold::model::{Model, Sol};
use fresh_surface_nofold::rng::Rng;
use fresh_surface_nofold::solid::Problem;
use polypack_surface::disk::disk_separation;
use polypack_surface::geometry::{piece_vertices, regular_polygon_separation, Pose};
use polypack_surface::solids::face_depth;
use polypack_surface::{validate_nofold, SurfaceConfig, SurfacePose, ValidateOptions};

const NS: [usize; 14] = [0, 3, 4, 5, 6, 7, 8, 9, 11, 12, 20, 37, 64, 100];

fn validator_sep(n: usize, a: [f64; 3], b: [f64; 3]) -> f64 {
    let pa = Pose { x: a[0], y: a[1], theta: a[2] };
    let pb = Pose { x: b[0], y: b[1], theta: b[2] };
    if n == 0 {
        disk_separation(pa, pb, 1.0)
    } else {
        regular_polygon_separation(n, pa, pb, 1.0)
    }
}

/// The separation of two pieces agrees with the validator's separating-axis test, at random poses and
/// near contact (a pair moved to touching along a random direction, then by +-1e-10).
#[test]
fn separation_agrees_with_validator() {
    let mut rng = Rng::new(11);
    for &n in &NS {
        let pc = Piece::new(n);
        let r = pc.r_site;
        for _ in 0..3000 {
            let a = [3.0 * r * rng.signed(), 3.0 * r * rng.signed(), 10.0 * rng.signed()];
            let b = [a[0] + 2.2 * r * rng.signed(), a[1] + 2.2 * r * rng.signed(), 10.0 * rng.signed()];
            let mine = pc.separation(r, a, b);
            let theirs = validator_sep(n, a, b);
            assert!((mine - theirs).abs() <= 1e-12 * (1.0 + r), "n={n} a={a:?} b={b:?}: mine {mine} validator {theirs}");
        }
        // near contact
        for _ in 0..500 {
            let a = [r * rng.signed(), r * rng.signed(), 10.0 * rng.signed()];
            let ang = 7.0 * rng.signed();
            let thb = 10.0 * rng.signed();
            let (dx, dy) = (ang.cos(), ang.sin());
            let (mut lo, mut hi) = (0.0, 2.0 * r + 1.0);
            for _ in 0..200 {
                let mid = 0.5 * (lo + hi);
                if validator_sep(n, a, [a[0] + mid * dx, a[1] + mid * dy, thb]) >= 0.0 {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            for eps in [-1e-10, -1e-12, 0.0, 1e-12, 1e-10] {
                let b = [a[0] + (hi + eps) * dx, a[1] + (hi + eps) * dy, thb];
                let mine = pc.separation(r, a, b);
                let theirs = validator_sep(n, a, b);
                assert!((mine - theirs).abs() <= 1e-13 * (1.0 + r), "near contact n={n}: mine {mine} validator {theirs}");
            }
        }
    }
}

/// The validator's depth of a piece in its face: the least face depth of its vertices (disk: of its
/// centre, less the radius).
fn validator_depth(solid: &polypack_surface::Solid, n: usize, s: f64, f: usize, p: [f64; 3]) -> f64 {
    if n == 0 {
        return face_depth(solid, s, f, p[0], p[1]) - 0.5;
    }
    let v = piece_vertices(n, Pose { x: p[0], y: p[1], theta: p[2] }, 1.0);
    (0..n).map(|k| face_depth(solid, s, f, v[2 * k], v[2 * k + 1])).fold(f64::INFINITY, f64::min)
}

/// The depth of a piece in its face, and the least scale that holds it, agree with the validator's
/// computation on regular and irregular faces of several solids.
#[test]
fn containment_agrees_with_validator() {
    let mut rng = Rng::new(5);
    for solid_name in ["cube", "tetrahedron", "dodecahedron", "rhombic_dodecahedron", "deltoidal_icositetrahedron", "pentagonal_icositetrahedron", "triakis_tetrahedron", "disdyakis_triacontahedron", "prism12", "square_pyramid", "snub_cube"] {
        let prob = Problem::new(&format!("surface/{solid_name}/nofold/3/10")).unwrap();
        let solid = prob.solid;
        for f in 0..solid.f {
            let cont = Container::from_flat(&solid.unit_faces[f]);
            for &n in &NS {
                let pc = Piece::new(n);
                let r = pc.r_site;
                for _ in 0..40 {
                    let s = (2.0 + 6.0 * rng.uniform()) * r;
                    let p = [s * cont.ext * 0.5 * rng.signed(), s * cont.ext * 0.5 * rng.signed(), 10.0 * rng.signed()];
                    let mine = cont.depth(&pc, s, p[0], p[1], p[2], r);
                    let theirs = validator_depth(solid, n, s, f, p);
                    assert!((mine - theirs).abs() <= 1e-12 * (1.0 + s), "{solid_name} face {f} n={n}: mine {mine} validator {theirs}");
                    // at the fit scale the piece touches the face: depth 0 to rounding
                    let fit = cont.fit(&pc, p[0], p[1], p[2], r, 0.0);
                    if fit > 0.0 {
                        let d = validator_depth(solid, n, fit, f, p);
                        assert!(d.abs() <= 1e-12 * (1.0 + fit), "{solid_name} face {f} n={n}: depth at fit {d}");
                        let d = validator_depth(solid, n, cont.fit(&pc, p[0], p[1], p[2], r, margin(r)), f, p);
                        assert!(d >= 0.0, "{solid_name} face {f} n={n}: depth with margin {d}");
                    }
                }
            }
        }
    }
}

/// Repair turns random arrangements into packings the validator accepts at tolerance 0, on one face.
#[test]
fn repaired_packings_pass_the_face_check() {
    let mut rng = Rng::new(9);
    for (solid_name, f) in [("cube", 0usize), ("rhombic_triacontahedron", 7), ("pentagonal_hexecontahedron", 3), ("prism9", 1), ("truncated_icosidodecahedron", 5)] {
        let prob = Problem::new(&format!("surface/{solid_name}/nofold/3/10")).unwrap();
        let cont = Container::from_flat(&prob.solid.unit_faces[f]);
        for &n in &NS {
            let pc = Piece::new(n);
            let r = pc.r_site;
            for k in [1usize, 2, 5, 9] {
                let s = (k as f64).sqrt() * 2.0 * r / cont.rho.max(0.3);
                let q: Vec<[f64; 3]> = (0..k).map(|_| [0.4 * s * cont.ext * rng.signed(), 0.4 * s * cont.ext * rng.signed(), 10.0 * rng.signed()]).collect();
                let p = repair(&pc, &cont, &q).expect("repair");
                let pieces = p.q.iter().map(|q| SurfacePose { face: f as f64, x: q[0], y: q[1], theta: q[2] }).collect();
                let cfg = SurfaceConfig { solid: solid_name.to_string(), n: n as f64, s: p.s, pieces };
                let v = validate_nofold(&cfg, &ValidateOptions { tol: 0.0, ..ValidateOptions::default() });
                assert!(v.ok, "{solid_name} n={n} k={k}: {:?}", v.errors);
            }
        }
    }
}

/// Congruent faces are mapped onto each other: every vertex of the representative maps to a vertex of the face.
#[test]
fn face_classes_map_faces_onto_each_other() {
    for solid_name in ["rhombic_dodecahedron", "deltoidal_hexecontahedron", "pentagonal_icositetrahedron", "pentagonal_hexecontahedron", "disdyakis_dodecahedron", "triakis_icosahedron", "snub_dodecahedron", "elongated_square_gyrobicupola", "tetrahedron"] {
        let prob = Problem::new(&format!("surface/{solid_name}/nofold/0/10")).unwrap();
        let solid = prob.solid;
        for (c, cl) in prob.classes.iter().enumerate() {
            let rep = &solid.unit_faces[cl.faces[0]];
            for &f in &cl.faces {
                assert_eq!(prob.face_class[f], c);
                let tf = prob.face_map[f];
                let face = &solid.unit_faces[f];
                for i in 0..rep.len() / 2 {
                    let (x, y) = tf.point(rep[2 * i], rep[2 * i + 1]);
                    let d = (0..face.len() / 2).map(|j| (x - face[2 * j]).hypot(y - face[2 * j + 1])).fold(f64::INFINITY, f64::min);
                    assert!(d < 1e-9, "{solid_name} face {f}: vertex {i} maps {d} from the face");
                }
            }
        }
        if solid_name.starts_with("pentagonal_") || solid_name.starts_with("rhombic") || solid_name.starts_with("deltoidal") || solid_name.starts_with("disdyakis") || solid_name.starts_with("triakis") {
            assert_eq!(prob.classes.len(), 1, "{solid_name}: a Catalan solid's faces are congruent");
        }
    }
}

/// The analytic gradient of the objective agrees with central differences, for disks and polygons of many
/// sides, on regular and irregular faces.
#[test]
fn gradient_matches_differences() {
    let mut rng = Rng::new(7);
    for solid_name in ["cube", "tetrahedron", "pentagonal_icositetrahedron", "prism10"] {
        let prob = Problem::new(&format!("surface/{solid_name}/nofold/3/10")).unwrap();
        for cl in &prob.classes {
            for &n in &[0usize, 3, 4, 5, 7, 12, 40, 100] {
                let k = 6;
                let pc = Piece::new(n);
                let mut model = Model::new(pc.clone(), cl.cont.clone(), k);
                model.w = 0.37;
                let dim = model.dim;
                let mut sol = Sol::new(k, dim, n > 0);
                for i in 0..k {
                    sol.q[dim * i] = 2.5 * rng.signed();
                    sol.q[dim * i + 1] = 2.5 * rng.signed();
                    if dim == 3 {
                        sol.q[3 * i + 2] = 7.0 * rng.signed();
                    }
                }
                for t in 0..sol.phi.len() {
                    sol.phi[t] = 3.0 * rng.signed();
                    sol.beta[t] = 0.3 * rng.signed();
                    sol.has[t] = true;
                }
                sol.s = 0.7 * model.fit_size(&sol.q);
                model.skin = 3.0;
                model.build(&sol, false);
                let x0 = model.packed();
                let nv = x0.len();
                let mut g = vec![0.0; nv];
                let f0 = model.eval(&x0, &mut g);
                assert!(f0.is_finite() && f0 > 0.0);
                let mut gd = vec![0.0; nv];
                for v in 0..nv {
                    let h = 1e-6;
                    let mut xp = x0.clone();
                    xp[v] += h;
                    let mut xm = x0.clone();
                    xm[v] -= h;
                    let num = (model.eval(&xp, &mut gd) - model.eval(&xm, &mut gd)) / (2.0 * h);
                    let tol = 2e-5 * (1.0 + num.abs());
                    assert!((num - g[v]).abs() < tol, "{solid_name} n={n} var {v} of {nv}: analytic {} numeric {}", g[v], num);
                }
            }
        }
    }
}

/// The penalty is zero at a valid packing (lines from the separating axes) and positive when a pair overlaps.
#[test]
fn penalty_is_zero_exactly_at_packings() {
    let mut rng = Rng::new(3);
    let prob = Problem::new("surface/rhombic_dodecahedron/nofold/5/10").unwrap();
    let cont = prob.classes[0].cont.clone();
    for &n in &NS {
        let pc = Piece::new(n);
        let r = pc.r_site;
        let k = 5;
        let s = 3.0 * r / cont.rho;
        let q: Vec<[f64; 3]> = (0..k).map(|_| [0.4 * s * cont.ext * rng.signed(), 0.4 * s * cont.ext * rng.signed(), 10.0 * rng.signed()]).collect();
        let p = repair(&pc, &cont, &q).unwrap();
        let dim = if n == 0 { 2 } else { 3 };
        let mut sol = Sol::new(k, dim, n > 0);
        for i in 0..k {
            sol.q[dim * i] = p.q[i][0] / r;
            sol.q[dim * i + 1] = p.q[i][1] / r;
            if dim == 3 {
                sol.q[3 * i + 2] = p.q[i][2];
            }
        }
        sol.s = p.s / r;
        let mut model = Model::new(pc.clone(), cont.clone(), k);
        assert_eq!(model.penalty(&sol), 0.0, "n={n}: penalty of a valid packing");
        // push piece 1 onto piece 0
        sol.q[dim] = sol.q[0] + 0.5;
        sol.q[dim + 1] = sol.q[1];
        sol.forget_lines();
        assert!(model.penalty(&sol) > 0.0, "n={n}: penalty of an overlap");
    }
}
