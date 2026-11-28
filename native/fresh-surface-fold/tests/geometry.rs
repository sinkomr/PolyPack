//! The model's geometry against the validator: gluing, walking, the jamming scale of random
//! configurations (pieces across edges and hugging vertices), and the energy's gradient.

use polypack_fresh_surface_fold::geo::Geo;
use polypack_fresh_surface_fold::model::{wrap_angle, Budget, Model, Pose};
use polypack_fresh_surface_fold::rng::Rng;
use polypack_fresh_surface_fold::{check, config_json, Problem};

const SOLIDS: [&str; 16] = [
    "tetrahedron",
    "cube",
    "octahedron",
    "dodecahedron",
    "icosahedron",
    "truncated_tetrahedron",
    "snub_cube",
    "truncated_icosidodecahedron",
    "rhombic_dodecahedron",
    "triakis_tetrahedron",
    "pentagonal_icositetrahedron",
    "prism3",
    "antiprism7",
    "square_pyramid",
    "triangular_orthobicupola",
    "bilunabirotunda",
];

/// Every gluing map takes the neighbour's edge onto this face's edge (reversed), and the two frames
/// agree in 3D along it.
#[test]
fn gluing_maps_match_edges_and_3d() {
    for solid in SOLIDS {
        let g = Geo::new(solid, 1.7).unwrap();
        for (f, fc) in g.faces.iter().enumerate() {
            for k in 0..fc.m {
                let nb = fc.adj_face[k];
                let l = fc.adj_edge[k];
                let gc = &g.faces[nb];
                let t = fc.glue[k];
                let (ax, ay) = t.apply(gc.vx[l], gc.vy[l]);
                let (bx, by) = t.apply(gc.vx[(l + 1) % gc.m], gc.vy[(l + 1) % gc.m]);
                let k1 = (k + 1) % fc.m;
                assert!((ax - fc.vx[k1]).abs() < 1e-12 && (ay - fc.vy[k1]).abs() < 1e-12, "{solid} face {f} edge {k}");
                assert!((bx - fc.vx[k]).abs() < 1e-12 && (by - fc.vy[k]).abs() < 1e-12, "{solid} face {f} edge {k}");
                // a point of the edge, in 3D from both frames
                let (px, py) = (0.3 * fc.vx[k] + 0.7 * fc.vx[k1], 0.3 * fc.vy[k] + 0.7 * fc.vy[k1]);
                let (qx, qy) = t.inverse().apply(px, py);
                let a = g.to3(f, px, py);
                let b = g.to3(nb, qx, qy);
                let d = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
                assert!(d < 1e-9, "{solid} face {f} edge {k}: 3D mismatch {d}");
            }
        }
    }
}

/// A walk along a straight path keeps the distance travelled (it is a geodesic) and ends in a face.
#[test]
fn walks_end_inside_and_preserve_length() {
    let mut rng = Rng::new(3);
    for solid in SOLIDS {
        let g = Geo::new(solid, 1.0).unwrap();
        for _ in 0..200 {
            let (f, x, y) = g.sample(rng.uniform(), rng.uniform(), rng.uniform(), rng.uniform());
            let a = rng.uniform() * 7.0;
            let d = g.min_edge * 3.0 * rng.uniform();
            let (h, px, py, m) = g.walk(f, x, y, x + d * a.cos(), y + d * a.sin());
            assert!(g.depth(h, px, py) > -1e-9, "{solid}: walk ends outside its face");
            // the map from f's frame to h's frame takes the far point to (px, py)
            let (ex, ey) = m.apply(x + d * a.cos(), y + d * a.sin());
            assert!((ex - px).abs() < 1e-9 && (ey - py).abs() < 1e-9);
        }
    }
}

/// The exact jamming scale of a configuration in the model, from a small scale up.
fn jam(model: &mut Model, cfg: &[Pose]) -> f64 {
    let mut mu = 0.05;
    for _ in 0..80 {
        model.build(cfg, mu);
        let j = model.jam_scale(cfg);
        let cap = model.mu + model.skin / (2.0 * model.sh.r1) * 0.95;
        if j < cap * (1.0 - 1e-12) {
            return j;
        }
        mu = j;
    }
    mu
}

/// Random configurations (uniform, near vertices and edges, and clusters around one vertex): the
/// validator accepts them just below the model's jamming scale and refuses them just above it.
#[test]
fn jamming_scale_agrees_with_the_validator() {
    let mut rng = Rng::new(11);
    let ns = [0usize, 3, 4, 5, 7, 12, 40];
    let (mut total, mut miss, mut strict) = (0, 0, 0);
    for solid in SOLIDS {
        for &n in &ns {
            let p = 2 + rng.below(4);
            let id = format!("surface/{solid}/fold/{n}/{p}");
            let prob = Problem::parse(&id).unwrap();
            let work = prob.bound;
            let mut model = Model::new(Geo::new(solid, work).unwrap(), n, p);
            for _ in 0..12 {
                let cluster = rng.uniform() < 0.5;
                let (f0, _, _) = model.geo.sample(rng.uniform(), rng.uniform(), rng.uniform(), rng.uniform());
                let k0 = rng.below(model.geo.faces[f0].m);
                let mut cfg = Vec::new();
                for _ in 0..p {
                    if cluster {
                        let fc = &model.geo.faces[f0];
                        let (qx, qy) = (0.999 * fc.vx[k0], 0.999 * fc.vy[k0]);
                        let d = model.geo.min_edge * (0.05 + 0.6 * rng.uniform());
                        let a = rng.uniform() * 7.0;
                        let (g, x, y, m) = model.geo.walk(f0, qx, qy, qx + d * a.cos(), qy + d * a.sin());
                        cfg.push(Pose { f: g as u32, x, y, t: wrap_angle(rng.uniform() * 7.0 + m.ang, n) });
                        continue;
                    }
                    let (f, mut x, mut y) = model.geo.sample(rng.uniform(), rng.uniform(), rng.uniform(), rng.uniform());
                    let fc = &model.geo.faces[f];
                    if rng.uniform() < 0.5 {
                        let k = rng.below(fc.m);
                        let w = 0.6 + 0.4 * rng.uniform();
                        x = w * fc.vx[k] + (1.0 - w) * x;
                        y = w * fc.vy[k] + (1.0 - w) * y;
                    }
                    cfg.push(Pose { f: f as u32, x, y, t: wrap_angle(rng.uniform() * 7.0, n) });
                }
                let j = jam(&mut model, &cfg);
                if !(j > 1e-3) {
                    continue;
                }
                total += 1;
                if check(&id, &config_json(&cfg, work, work / (j * (1.0 - 1e-7)))).is_none() {
                    miss += 1;
                    eprintln!("model misses an overlap: {id} {}", config_json(&cfg, work, work / (j * (1.0 - 1e-7))));
                }
                if check(&id, &config_json(&cfg, work, work / (j * (1.0 + 1e-7)))).is_some() {
                    strict += 1;
                    eprintln!("model stricter than the validator: {id}");
                }
            }
        }
    }
    eprintln!("{total} configurations: {miss} misses, {strict} stricter");
    assert!(total > 1000);
    assert_eq!(miss, 0);
    assert!(strict * 100 <= total, "stricter than the validator on {strict} of {total}");
}

/// The energy's analytic gradient against central differences, for every kind of variable.
#[test]
fn gradient_matches_finite_differences() {
    let mut rng = Rng::new(5);
    let cases = [("cube", 0usize, 6usize), ("cube", 4, 6), ("tetrahedron", 3, 5), ("snub_cube", 7, 8), ("antiprism7", 3, 10), ("icosahedron", 40, 5), ("rhombic_dodecahedron", 5, 7)];
    let clock = || 0.0;
    for (solid, n, p) in cases {
        let id = format!("surface/{solid}/fold/{n}/{p}");
        let prob = Problem::parse(&id).unwrap();
        let mut model = Model::new(Geo::new(solid, prob.bound).unwrap(), n, p);
        let mut cfg: Vec<Pose> = (0..p)
            .map(|_| {
                let (f, x, y) = model.geo.sample(rng.uniform(), rng.uniform(), rng.uniform(), rng.uniform());
                Pose { f: f as u32, x, y, t: wrap_angle(rng.uniform() * 7.0, n) }
            })
            .collect();
        // overlapping, after a few relaxation steps so that the lines are not at their start
        let mut budget = Budget::new(f64::INFINITY, None, &clock);
        model.relax(&mut cfg, 1.05, 15, 1e-13, &mut budget);
        model.build(&cfg, 1.05);
        let nvar = model.nvar;
        let mut x = model.x[..nvar].to_vec();
        // move the lines off their initial values a little
        for v in x[model.dim * p..].iter_mut() {
            *v += 0.01 * rng.normal();
        }
        let mut g = vec![0.0; nvar];
        let e0 = model.energy(&x, &mut g);
        assert!(e0 > 0.0, "{id}: no overlap to test");
        let mut gg = vec![0.0; nvar];
        let mut worst = 0.0f64;
        for k in 0..nvar {
            let h = 1e-6;
            let keep = x[k];
            x[k] = keep + h;
            let ep = model.energy(&x, &mut gg);
            x[k] = keep - h;
            let em = model.energy(&x, &mut gg);
            x[k] = keep;
            let fd = (ep - em) / (2.0 * h);
            let err = (fd - g[k]).abs() / (1e-6 + g[k].abs().max(fd.abs()));
            worst = worst.max(err.min((fd - g[k]).abs() / 1e-4));
            assert!((fd - g[k]).abs() <= 1e-5 * (1.0 + g[k].abs()) + 1e-7, "{id}: variable {k} of {nvar}: analytic {} numeric {fd}", g[k]);
        }
        eprintln!("{id}: {nvar} variables, energy {e0:.3e}, worst relative error {worst:.1e}");
    }
}
