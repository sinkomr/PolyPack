//! The fold search of packages/surface (`src/search/search.ts`, `searchProblem`) as the spaces
//! package drives it. Port of `packages/spaces/src/search/surface-fold.ts` and of the helpers it
//! imports from `search.ts` (`mulberry32`, `randomPose`, `areaScale`).
//!
//! Compress every start (penalty compression on the unit solid with the scale as a variable for
//! polygons, geometric growth for disks), basin-hop from the best, then the final tightening and
//! the contact-LP polish, and the float check (validateFold, tolerance 1e-10). The final stage
//! stops on `final_stop`.

use super::optimize::{compress, compress_penalty, CompressOptions, Packing};
use super::slp::slp_polish;
use super::throw;
use crate::geometry::piece_area;
use crate::parts::SurfacePose;
use crate::solids::{face_apothem, face_area, face_depth, surface_area, Solid};
use crate::validate::{validate, Mode, SurfaceConfig, ValidateOptions};
use polypack_js::math;
use polypack_js::math::PI;

/// `search.ts: mulberry32`. Seeded generator (mulberry32).
pub struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Mulberry32 {
        Mulberry32 { a: seed }
    }
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

/// `search.ts: randomPose`. A random pose on the solid of scale 1: a face (uniformly on the
/// Platonic solids, by area on the others), a uniform point of it and a uniform angle.
pub fn random_pose(solid: &Solid, rand: &mut Mulberry32) -> SurfacePose {
    if !solid.uniform {
        return random_pose_general(solid, rand);
    }
    let ap = face_apothem(solid.m, 1.0);
    let face = math::floor(rand.next() * solid.f as f64);
    loop {
        let x = (2.0 * rand.next() - 1.0) * ap * 1.3;
        let y = (2.0 * rand.next() - 1.0) * ap * 1.3;
        let mut inside = true;
        for j in 0..solid.m {
            let a = (2.0 * PI * (j as f64 + 1.0)) / solid.m as f64 - PI / 2.0;
            if x * math::cos(a) + y * math::sin(a) > ap {
                inside = false;
            }
        }
        if inside {
            return SurfacePose { face, x, y, theta: 2.0 * PI * rand.next() };
        }
    }
}

fn random_pose_general(solid: &Solid, rand: &mut Mulberry32) -> SurfacePose {
    let mut total = 0.0;
    for f in 0..solid.f {
        total += face_area(solid, f);
    }
    let mut t = rand.next() * total;
    let mut face = solid.f - 1;
    for f in 0..solid.f {
        t -= face_area(solid, f);
        if t < 0.0 {
            face = f;
            break;
        }
    }
    let u = &solid.unit_faces[face];
    let mut x0 = f64::INFINITY;
    let mut x1 = f64::NEG_INFINITY;
    let mut y0 = f64::INFINITY;
    let mut y1 = f64::NEG_INFINITY;
    let mut i = 0;
    while i < u.len() {
        x0 = math::min(x0, u[i]);
        x1 = math::max(x1, u[i]);
        y0 = math::min(y0, u[i + 1]);
        y1 = math::max(y1, u[i + 1]);
        i += 2;
    }
    loop {
        let x = x0 + rand.next() * (x1 - x0);
        let y = y0 + rand.next() * (y1 - y0);
        if face_depth(solid, 1.0, face, x, y) > 0.0 {
            return SurfacePose { face: face as f64, x, y, theta: 2.0 * PI * rand.next() };
        }
    }
}

/// `search.ts: areaScale`. Largest piece scale allowed by area on the unit solid.
pub fn area_scale(solid: &Solid, n: usize, p: usize) -> f64 {
    let inner = if n == 0 { PI } else { piece_area(n) };
    math::sqrt(surface_area(solid, 1.0) / (p as f64 * inner))
}

/// `search.ts: Start`.
#[derive(Clone, Debug)]
pub struct Start {
    pub lam: f64,
    pub poses: Vec<SurfacePose>,
}

/// `surface-fold.ts: perturb`. searchProblem's perturbation: re-place or shift one to three pieces,
/// sometimes jiggle them all.
fn perturb(solid: &Solid, poses: &[SurfacePose], rand: &mut Mulberry32, lam: f64) -> Vec<SurfacePose> {
    let mut out: Vec<SurfacePose> = poses.to_vec();
    let kind = rand.next();
    let k = 1 + math::floor(rand.next() * math::min(3.0, out.len() as f64)) as usize;
    for _t in 0..k {
        let i = math::floor(rand.next() * out.len() as f64) as usize;
        if kind < 0.35 {
            out[i] = random_pose(solid, rand);
        } else {
            let r = (0.15 + 0.5 * rand.next()) * lam;
            let a = 2.0 * PI * rand.next();
            let dtheta = (rand.next() - 0.5) * 1.5;
            out[i] = SurfacePose { face: out[i].face, x: out[i].x + r * math::cos(a), y: out[i].y + r * math::sin(a), theta: out[i].theta + dtheta };
        }
    }
    if kind > 0.85 {
        for p in out.iter_mut() {
            p.x += (rand.next() - 0.5) * 0.05 * lam;
            p.y += (rand.next() - 0.5) * 0.05 * lam;
            p.theta += (rand.next() - 0.5) * 0.1;
        }
    }
    out
}

fn run_compress(pk: &mut Packing, n: usize, lam0: f64, stop: &dyn Fn() -> bool) -> Option<super::optimize::Compressed> {
    if n == 0 {
        compress(pk, lam0, &CompressOptions { feas_tol: 1e-18, max_iter: None }, stop)
    } else {
        compress_penalty(pk, lam0, &CompressOptions { feas_tol: 1e-18, max_iter: Some(300) }, stop)
    }
}

/// `surface-fold.ts: FoldOptions`.
pub struct FoldOptions<'a> {
    pub seed: u32,
    pub random_starts: usize,
    pub hops: usize,
    pub warm: Vec<Start>,
    /// Ends the starts and the hops.
    pub stop: &'a dyn Fn() -> bool,
    /// Ends the final stage.
    pub final_stop: &'a dyn Fn() -> bool,
    pub nofold: bool,
}

/// `surface-fold.ts: surfaceWorkingScale`. The engine works in working units, where a disk piece
/// has radius 1; the site's disks have diameter 1.
pub fn surface_working_scale(n: usize) -> f64 {
    if n == 0 {
        0.5
    } else {
        1.0
    }
}

pub struct FoldResult {
    pub lam: f64,
    pub poses: Vec<SurfacePose>,
    pub compressions: u64,
}

/// `surface-fold.ts: surfaceFoldSearch`. The best fold packing on the unit solid (pieces scaled by
/// lam, so the edge is 1/lam), and the number of compressions run; None when none produced a
/// packing or the final check failed. lam is in site units.
pub fn surface_fold_search(solid: &'static Solid, n: usize, p: usize, o: &FoldOptions) -> Option<FoldResult> {
    let mut rand = Mulberry32::new(o.seed);
    let u = surface_working_scale(n);
    let la = area_scale(solid, n, p);
    let mut best: Option<Start> = None;
    let mut compressions: u64 = 0;
    let mut starts: Vec<Start> = o.warm.iter().map(|st| Start { lam: st.lam * u, poses: st.poses.clone() }).collect();
    for _k in 0..o.random_starts {
        let poses = (0..p).map(|_| random_pose(solid, &mut rand)).collect();
        starts.push(Start { lam: 0.55 * la, poses });
    }
    let mut take = |best: &mut Option<Start>, lam: f64, poses: &[SurfacePose]| {
        compressions += 1;
        if best.is_none() || lam > best.as_ref().unwrap().lam {
            *best = Some(Start { lam, poses: poses.to_vec() });
        }
    };
    for st in &starts {
        if (o.stop)() {
            break;
        }
        let mut pk = Packing::new(solid, n, st.lam, &st.poses, o.nofold);
        let r = run_compress(&mut pk, n, st.lam, o.stop);
        if let Some(r) = r {
            take(&mut best, r.lam, &r.poses);
        }
    }
    let mut h = 0;
    while h < o.hops && best.is_some() {
        if (o.stop)() {
            break;
        }
        let b = best.clone().unwrap();
        let start = perturb(solid, &b.poses, &mut rand, b.lam);
        let mut pk = Packing::new(solid, n, b.lam * 0.97, &start, o.nofold);
        let r = run_compress(&mut pk, n, b.lam * 0.97, o.stop);
        if let Some(r) = r {
            take(&mut best, r.lam, &r.poses);
        }
        h += 1;
    }
    let fin = best?;
    // optimize.ts finalize, with the stop check: relax hard at a slightly smaller scale
    let mut pk = Packing::new(solid, n, fin.lam, &fin.poses, o.nofold);
    let mut f0 = Start { lam: fin.lam, poses: fin.poses.clone() };
    let mut l = fin.lam * (1.0 - 1e-10);
    let mut k = 0;
    while k < 12 && !(o.final_stop)() {
        pk.set_scale(l);
        pk.set_poses(&fin.poses);
        let r = pk.relax(3000, 1e-28, 0.002, o.final_stop);
        if r.energy <= 1e-26 {
            f0 = Start { lam: l, poses: pk.poses.clone() };
            break;
        }
        l *= 1.0 - 3e-10 * math::pow(3.0, k as f64);
        k += 1;
    }
    let pol = slp_polish(solid, n, f0.lam, &f0.poses, 120, o.final_stop, o.nofold);
    let f = if pol.lam >= f0.lam { Start { lam: pol.lam, poses: pol.poses } } else { f0 };
    // the site's edge s = U / lam_working and the poses on the solid of that edge
    let poses: Vec<SurfacePose> = f.poses.iter().map(|q| SurfacePose { face: q.face, x: (q.x * u) / f.lam, y: (q.y * u) / f.lam, theta: q.theta }).collect();
    let cfg = SurfaceConfig { solid: solid.name.clone(), n: n as f64, s: u / f.lam, pieces: poses };
    let mode = if o.nofold { Mode::Nofold } else { Mode::Fold };
    let v = match validate(&cfg, mode, &ValidateOptions { tol: 1e-10, ..ValidateOptions::default() }) {
        Ok(v) => v,
        Err(e) => throw(e),
    };
    if v.ok {
        Some(FoldResult { lam: f.lam / u, poses: f.poses, compressions })
    } else {
        None
    }
}
