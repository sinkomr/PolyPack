//! Development: the images of a configuration in this crate's model, against the validator.
//!   cargo run --profile fast -p polypack-fresh-surface-fold --example diag -- ID 'CONFIG_JSON'

use polypack_fresh_surface_fold::geo::Geo;
use polypack_fresh_surface_fold::model::Model;
use polypack_fresh_surface_fold::{poses_of, Problem};
use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let id = &a[0];
    let config: serde_json::Value = serde_json::from_str(&a[1]).unwrap();
    let prob = Problem::parse(id).unwrap();
    let work = prob.bound;
    let (s, cfg) = poses_of(&config, work).unwrap();
    let mu = work / s;
    let geo = Geo::new(&prob.solid, work).unwrap();
    let mut model = Model::new(geo, prob.n, prob.p);
    model.build(&cfg, mu);
    println!("mu {mu} pairs {} cones {}", model.pairs.len(), model.cones.len());
    for pr in &model.pairs {
        let b = &cfg[pr.j as usize];
        let (qx, qy) = pr.t.apply(b.x, b.y);
        let q = &cfg[pr.i as usize];
        let sep = if prob.n > 0 {
            let pa = polypack_surface::geometry::Pose { x: q.x / mu, y: q.y / mu, theta: q.t };
            let pb = polypack_surface::geometry::Pose { x: qx / mu, y: qy / mu, theta: b.t + pr.t.ang };
            polypack_surface::geometry::regular_polygon_separation(prob.n, pa, pb, 1.0)
        } else {
            (qx - q.x).hypot(qy - q.y) / mu - 1.0
        };
        println!("pair {} {} d {:.6} ang {:.4} planar sep {:.6}", pr.i, pr.j, (qx - q.x).hypot(qy - q.y) / mu, pr.t.ang, sep);
    }
    println!("jam {} (mu {mu})", model.jam_scale(&cfg));
    for pr in &model.pairs {
        let j = model.pair_jam(&cfg, pr);
        if j < mu * (1.0 + 1e-6) {
            println!("  tight pair {} {} jam {j}", pr.i, pr.j);
        }
    }
    for c in &model.cones {
        let j = model.cone_jam(&cfg, c);
        if j < mu * (1.0 + 1e-6) {
            println!("  tight cone {} ({}, {}) jam {j}", c.i, c.vx, c.vy);
        }
    }
    if a.len() >= 4 {
        let (pi, pj): (usize, usize) = (a[2].parse().unwrap(), a[3].parse().unwrap());
        let r = model.sh.r1 * mu * (1.0 + 1e-9);
        let mut ki = Vec::new();
        let mut kj = Vec::new();
        model.geo.chains(cfg[pi].f as usize, cfg[pi].x, cfg[pi].y, r, 5000, &mut ki);
        model.geo.chains(cfg[pj].f as usize, cfg[pj].x, cfg[pj].y, r, 5000, &mut kj);
        for (u, nu) in ki.iter().enumerate() {
            for (w, nw) in kj.iter().enumerate() {
                if nu.face != nw.face {
                    continue;
                }
                let t = nu.t.after(&nw.t.inverse());
                let b = &cfg[pj];
                let (qx, qy) = t.apply(b.x, b.y);
                let q = &cfg[pi];
                let pa = polypack_surface::geometry::Pose { x: q.x / mu, y: q.y / mu, theta: q.t };
                let pb = polypack_surface::geometry::Pose { x: qx / mu, y: qy / mu, theta: b.t + t.ang };
                let sep = polypack_surface::geometry::regular_polygon_separation(prob.n, pa, pb, 1.0);
                println!("  chains {u} {w} face {} d {:.6} ang {:.4} sep {:.6} (depths {} {})", nu.face, (qx - q.x).hypot(qy - q.y) / mu, t.ang, sep, nu.depth, nw.depth);
            }
        }
        for c in &model.cones {
            if c.i as usize == pi {
                println!("  cone of {pi}: ({:.6}, {:.6}) d {:.6}", c.vx, c.vy, (c.vx - cfg[pi].x).hypot(c.vy - cfg[pi].y) / mu);
            }
        }
    }
    let v = validate_space_submission(SpaceName::Surface, id, &config, &SpaceValidateOptions::default());
    println!("validator {} {:?}", v.valid, v.reasons);
}
