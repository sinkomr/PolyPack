//! Development: agreement of this crate's jamming scale with the validator on random configurations.
//!   cargo run --profile fast -p polypack-fresh-surface-fold --example agree -- [cases]

use polypack_fresh_surface_fold::geo::Geo;
use polypack_fresh_surface_fold::model::{wrap_angle, Model, Pose};
use polypack_fresh_surface_fold::rng::Rng;
use polypack_fresh_surface_fold::{check, config_json, Problem};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let cases: usize = a.first().and_then(|s| s.parse().ok()).unwrap_or(200);
    let solids = [
        "tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron", "truncated_tetrahedron", "cuboctahedron", "snub_cube",
        "rhombic_dodecahedron", "triakis_tetrahedron", "disdyakis_triacontahedron", "prism3", "prism7", "antiprism4", "antiprism9", "square_pyramid", "elongated_triangular_bipyramid", "triangular_orthobicupola", "augmented_tridiminished_icosahedron", "snub_disphenoid", "bilunabirotunda",
    ];
    let ns = [0usize, 3, 4, 5, 6, 7, 12, 40];
    let mut rng = Rng::new(7);
    let mut total = 0;
    let mut miss = 0;
    let mut cons = 0;
    for solid in solids {
        if Problem::parse(&format!("surface/{solid}/fold/0/2")).is_none() {
            println!("skip {solid}");
            continue;
        }
        for &n in &ns {
            let p = 2 + rng.below(4);
            let id = format!("surface/{solid}/fold/{n}/{p}");
            let prob = Problem::parse(&id).unwrap();
            let work = prob.bound;
            let geo = Geo::new(&prob.solid, work).unwrap();
            let mut model = Model::new(geo, n, p);
            let mut m_miss = 0;
            let mut m_cons = 0;
            let mut m_tot = 0;
            for _ in 0..cases / ns.len() {
                // random poses, half of them near a vertex or an edge
                let mut cfg = Vec::new();
                let cluster = rng.uniform() < 0.5;
                let (f0, _, _) = model.geo.sample(rng.uniform(), rng.uniform(), rng.uniform(), rng.uniform());
                let k0 = rng.below(model.geo.faces[f0].m);
                for _ in 0..p {
                    if cluster {
                        // around one vertex: walk from just inside its corner of f0 in a random direction
                        let fc = &model.geo.faces[f0];
                        let (vx, vy) = (fc.vx[k0], fc.vy[k0]);
                        let (qx, qy) = (0.999 * vx, 0.999 * vy);
                        let d = model.geo.min_edge * (0.05 + 0.6 * rng.uniform());
                        let a = rng.uniform() * 7.0;
                        let (g, x, y, m) = model.geo.walk(f0, qx, qy, qx + d * a.cos(), qy + d * a.sin());
                        let t = wrap_angle(rng.uniform() * 7.0 + m.ang, n);
                        cfg.push(Pose { f: g as u32, x, y, t });
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
                    let t = wrap_angle(rng.uniform() * 7.0, n);
                    cfg.push(Pose { f: f as u32, x, y, t });
                }
                // jamming scale in the model
                let mut mu = 0.05;
                let mut jam = 0.0;
                for _ in 0..80 {
                    model.build(&cfg, mu);
                    let j = model.jam_scale(&cfg);
                    let cap = model.mu + model.skin / (2.0 * model.sh.r1) * 0.95;
                    if j < cap * (1.0 - 1e-12) {
                        jam = j;
                        break;
                    }
                    mu = j;
                }
                if jam.partial_cmp(&1e-3) != Some(std::cmp::Ordering::Greater) {
                    continue;
                }
                m_tot += 1;
                let ok_lo = check(&id, &config_json(&cfg, work, work / (jam * (1.0 - 1e-7)))).is_some();
                let ok_hi = check(&id, &config_json(&cfg, work, work / (jam * (1.0 + 1e-7)))).is_some();
                if !ok_lo {
                    m_miss += 1;
                    if m_miss <= 1 {
                        println!("  miss {id}: {}", config_json(&cfg, work, work / (jam * (1.0 - 1e-7))));
                    }
                }
                if ok_hi {
                    m_cons += 1;
                }
            }
            println!("{id}: {m_tot} cases, model misses an overlap {m_miss}, model too strict {m_cons}");
            total += m_tot;
            miss += m_miss;
            cons += m_cons;
        }
    }
    println!("total {total} misses {miss} strict {cons}");
}
