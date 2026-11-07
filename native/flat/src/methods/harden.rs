//! Soft-to-rigid hardening, after Yohei Nakajima (packages/solver/src/methods/harden.ts and
//! harden/{dynamics,shapes,legalise,signature}.ts).
//!
//! The method, its shape paths, its three-phase schedule (compress, follow the path, settle), its
//! energy and momentum update, and the default pressure, noise, softness, scale, step counts and
//! start area come from his openly published work, used here with thanks under its MIT licence:
//!   site        https://yoheinakajima.github.io/soft-to-rigid/
//!   repository  https://github.com/yoheinakajima/soft-to-rigid  (engine/engine2d.js, paper/main.pdf)
//! PolyPack's part is the generalisation to every regular piece and container on the shared
//! penalty geometry, the mapping of evaluation and time budgets onto the schedule, restarts, and
//! an exact first-contact form of his legalisation rule (`legalise_fast`). See
//! docs/methods/harden.md.
//!
//! Throughput: the energy gradient is evaluated by local kernels that follow
//! penalty::pair_penetration and penalty::visit_protrusions term for term (a unit test holds them
//! to the shared geometry), from per-piece vertex tables built once per step.
//!
//! A soft piece is its polygon core scaled by gamma (1 - tau) about the centre and dilated by a
//! disk of radius gamma tau rho (rho the inradius). Only legalised true shapes are ever scored.

use super::common::{adopt, dilate, restore, scatter, PairTester, Strategy, COORD_LIMIT};
use super::params_of;
use crate::framework::Ctx;
use crate::grid::NeighborGrid;
use crate::penalty::{pair_penetration, PairPenetration};
use crate::rng::Rng;
use crate::sep::Shape;
use crate::shapes::{
    bounding_radius, circumradius, container_area, container_inradius, inradius, piece_area, piece_inradius, Config, Pose, Problem,
    MAX_COORD,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::f64::consts::PI;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub path: String,
    pub pressure: f64,
    pub noise: f64,
    pub tau0: f64,
    pub gamma0: f64,
    pub compress_steps: u32,
    pub morph_steps: u32,
    pub settle_steps: u32,
    pub fill: f64,
    pub restarts: u32,
    pub evaluation_interval: u32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            path: "harden".into(),
            pressure: 0.16,
            noise: 8.0,
            tau0: 1.0,
            gamma0: 0.1,
            compress_steps: 2500,
            morph_steps: 7500,
            settle_steps: 1500,
            fill: 3.2,
            restarts: 0,
            evaluation_interval: 32,
        }
    }
}

const PATHS: [&str; 5] = ["harden", "grow", "rigid", "snap", "grow-area"];

fn in_range(name: &str, v: f64, lo: f64, hi: f64) -> Result<(), String> {
    if v >= lo && v <= hi {
        Ok(())
    } else {
        Err(format!("harden: {name} must be between {lo} and {hi}"))
    }
}

impl Params {
    pub fn check(&self) -> Result<(), String> {
        if !PATHS.contains(&self.path.as_str()) {
            return Err(format!("harden: path must be one of {}", PATHS.join(", ")));
        }
        in_range("pressure", self.pressure, 0.0001, 4.0)?;
        in_range("noise", self.noise, 0.0, 64.0)?;
        in_range("tau0", self.tau0, 0.0, 1.0)?;
        in_range("gamma0", self.gamma0, 0.01, 1.0)?;
        in_range("compressSteps", self.compress_steps as f64, 0.0, 1e6)?;
        in_range("morphSteps", self.morph_steps as f64, 1.0, 1e6)?;
        in_range("settleSteps", self.settle_steps as f64, 0.0, 1e6)?;
        in_range("fill", self.fill, 1.05, 50.0)?;
        in_range("restarts", self.restarts as f64, 0.0, 1e5)?;
        in_range("evaluationInterval", self.evaluation_interval as f64, 1.0, 1e5)?;
        Ok(())
    }
}

pub fn resolve(given: &Value) -> Result<Value, String> {
    let (v, p) = super::fill::<Params>(given)?;
    p.check()?;
    Ok(v)
}

// ---- shape paths (harden/shapes.ts) ----

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Path {
    Harden,
    Grow,
    Rigid,
    Snap,
    GrowArea,
}

impl Path {
    fn parse(s: &str) -> Path {
        match s {
            "grow" => Path::Grow,
            "rigid" => Path::Rigid,
            "snap" => Path::Snap,
            "grow-area" => Path::GrowArea,
            _ => Path::Harden,
        }
    }
}

/// A point of the reference's shape family, in the shared penalty geometry's terms: a core
/// scaled by `scale` about the centre, dilated by a disk of radius `padding`.
#[derive(Clone, Copy, Debug)]
struct Soft {
    tau: f64,
    scale: f64,
    padding: f64,
}

impl Soft {
    /// Largest distance from the piece centre to a point of the soft piece.
    #[inline]
    fn reach(&self, n: u32) -> f64 {
        self.scale * bounding_radius(n) + self.padding
    }
}

/// (gamma, tau) at progress u of the middle phase. Every path ends at exactly (1, 0). A circle
/// piece has no softer state, so harden, snap and grow-area equal rigid for it.
fn path_shape(path: Path, u: f64, n: u32, tau0: f64, gamma0: f64) -> (f64, f64) {
    if u >= 1.0 || path == Path::Rigid {
        return (1.0, 0.0);
    }
    let progress = u.max(0.0);
    if path == Path::Grow {
        return (gamma0 + (1.0 - gamma0) * progress, 0.0);
    }
    if n == 0 {
        return (1.0, 0.0);
    }
    match path {
        Path::Harden => (1.0, tau0 * (1.0 - progress)),
        // inscribed disks through compression and the first path step, then the polygon at once
        Path::Snap => (1.0, if progress == 0.0 { 1.0 } else { 0.0 }),
        _ => {
            // a rigid polygon whose area follows hardening's schedule A(tau) = A - (A - pi rho^2) tau^2
            let rho = inradius(n);
            let disk_share = PI * rho * rho / piece_area(n);
            let t = 1.0 - progress;
            ((1.0 - (1.0 - disk_share) * t * t).sqrt(), 0.0)
        }
    }
}

fn soft_shape(n: u32, gamma: f64, tau: f64) -> Soft {
    if n == 0 {
        return Soft { tau: 0.0, scale: gamma, padding: 0.0 };
    }
    Soft { tau, scale: gamma * (1.0 - tau), padding: gamma * tau * inradius(n) }
}

// ---- schedule ----

#[derive(Clone, Copy, Debug)]
struct Phases {
    compress: i64,
    morph: i64,
    settle: i64,
}

impl Phases {
    fn total(&self) -> i64 {
        self.compress + self.morph + self.settle
    }
}

/// Phase lengths of a run of `steps` momentum steps in the proportion of the full-length run.
/// The path phase gets the rounding remainder and at least one step; a run from a supplied
/// arrangement has no compression.
fn plan_phases(steps: i64, full: Phases, compression: bool) -> Phases {
    let total = full.total();
    let count = steps.max(1);
    let mut compress = ((count * full.compress) as f64 / total as f64).round() as i64;
    let mut settle = ((count * full.settle) as f64 / total as f64).round() as i64;
    if compress + settle >= count {
        settle = settle.min(count - 1);
        compress = compress.min(count - 1 - settle);
    }
    if !compression {
        compress = 0;
    }
    Phases { compress, morph: count - compress - settle, settle }
}

/// Number of runs for an evaluation allowance: the requested number, or as many full-length runs
/// as fit (at least one); every run needs one assessment.
fn plan_runs(evals: f64, full_steps: f64, interval: f64, restarts: f64) -> f64 {
    if !evals.is_finite() {
        return if restarts > 0.0 { restarts } else { f64::INFINITY };
    }
    let wanted = if restarts > 0.0 { restarts } else { 1f64.max((evals / (full_steps / interval).ceil()).floor()) };
    wanted.min(evals.floor())
}

// ---- duplicate suppression (harden/signature.ts) ----

#[inline]
fn mix(mut x: u64) -> u64 {
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58476d1ce4e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d049bb133111eb);
    x ^ (x >> 31)
}

/// Bounded memory of the arrangements already scored: a 64-bit hash of the pose values (zero and
/// negative zero alike, circle angles left out), the oldest forgotten first. A collision can only
/// make a run skip one re-assessment; nothing here decides validity.
struct Seen {
    n: u32,
    set: HashSet<u64>,
    order: VecDeque<u64>,
    limit: usize,
}

impl Seen {
    fn new(n: u32) -> Self {
        Seen { n, set: HashSet::new(), order: VecDeque::new(), limit: 16384 }
    }

    fn key(&self, pieces: &[Pose]) -> u64 {
        let mut h = mix(0x9e3779b97f4a7c15 ^ pieces.len() as u64);
        for p in pieces {
            h = mix(h ^ (p.x + 0.0).to_bits());
            h = mix(h.wrapping_add((p.y + 0.0).to_bits()));
            if self.n != 0 {
                h = mix(h ^ (p.theta + 0.0).to_bits().rotate_left(17));
            }
        }
        h
    }

    /// Remember an arrangement; false when it was already remembered.
    fn add(&mut self, pieces: &[Pose]) -> bool {
        let key = self.key(pieces);
        if !self.set.insert(key) {
            return false;
        }
        self.order.push_back(key);
        if self.order.len() > self.limit {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

// ---- dynamics (harden/dynamics.ts) ----

/// Reference update constants (engine2d.js `step`).
const MOMENTUM: f64 = 0.85;
const POSE_RATE: f64 = 0.04;
const SIZE_RATE: f64 = 0.02;
/// Translation cap per step is STEP_CAP * sqrt(2) * bounding radius; the rotation cap is STEP_CAP.
const STEP_CAP: f64 = 0.03;
/// Above this softness a piece is a pure disk and receives no torque.
const DISK_TAU: f64 = 0.9999;
/// Up to this many pieces every pair is distance-tested directly; above it a cell grid is used.
const DIRECT_PAIRS: usize = 32;
/// Counted feature tests between cooperative checkpoints (about a millisecond).
const CHECKPOINT_WORK: f64 = 60000.0;

struct Report {
    size_gradient: f64,
}

/// State of one run: poses and velocities, and a container centred at the origin with a
/// horizontal bottom edge whose size variable L moves under inward pressure.
///
/// E = sum_pairs (2 r - sd_ij)_+^2 + sum_i sum_core-vertices (wall violation + r)_+^2 (+ mu L),
/// with r the disk padding and sd the signed distance between cores.
struct Dynamics {
    n: u32,
    m: u32,
    p: usize,
    shape: Shape,
    poses: Vec<Pose>,
    vx: Vec<f64>,
    vy: Vec<f64>,
    vt: Vec<f64>,
    gx: Vec<f64>,
    gy: Vec<f64>,
    gt: Vec<f64>,
    /// Container size variable; the container size is L / unit.
    l: f64,
    vl: f64,
    unit: f64,
    /// Length unit of the pressure and of the noise: the piece's inscribed diameter.
    length: f64,
    cap: f64,
    apothem: f64,
    pairs: Vec<(u32, u32)>,
    grid: NeighborGrid,
    /// Counted pair and wall feature tests since the last reset.
    work: f64,
    // polygon constants: vertex spacing, angle of edge normal 0 relative to theta, circumradius
    // and inradius of the unit piece, and cos/sin of the vertex directions at theta = 0
    nf: f64,
    step: f64,
    normal0: f64,
    big_r1: f64,
    r1: f64,
    base_cos: Vec<f64>,
    base_sin: Vec<f64>,
    /// Outward wall normals of the container at phi = 0 (edge 0 is the bottom edge).
    wall_cos: Vec<f64>,
    wall_sin: Vec<f64>,
    /// Core vertex offsets of every piece at the current scale, [x0, y0, x1, y1, ...] per piece.
    vtx: Vec<f64>,
    /// Core circumradius at the current scale.
    rs: f64,
}

impl Dynamics {
    fn new(problem: Problem) -> Self {
        let (n, m, p) = (problem.n, problem.m, problem.p);
        Dynamics {
            n,
            m,
            p,
            shape: Shape::new(n),
            poses: vec![Pose::default(); p],
            vx: vec![0.0; p],
            vy: vec![0.0; p],
            vt: vec![0.0; p],
            gx: vec![0.0; p],
            gy: vec![0.0; p],
            gt: vec![0.0; p],
            l: 1.0,
            vl: 0.0,
            // L is the radius for a circle; from M = 7 on the apothem, below that the side
            unit: if m == 0 { container_inradius(0) } else { 1f64.max(inradius(m)) },
            length: 2.0 * piece_inradius(n),
            cap: STEP_CAP * std::f64::consts::SQRT_2 * bounding_radius(n),
            apothem: container_inradius(m),
            pairs: Vec::new(),
            grid: NeighborGrid::new(),
            work: 0.0,
            nf: n as f64,
            step: if n == 0 { 2.0 * PI } else { 2.0 * PI / n as f64 },
            normal0: if n == 0 { 0.0 } else { PI / 2.0 + PI / n as f64 },
            big_r1: if n == 0 { 0.0 } else { circumradius(n) },
            r1: if n == 0 { 0.0 } else { inradius(n) },
            base_cos: (0..n).map(|k| (PI / 2.0 + k as f64 * 2.0 * PI / n as f64).cos()).collect(),
            base_sin: (0..n).map(|k| (PI / 2.0 + k as f64 * 2.0 * PI / n as f64).sin()).collect(),
            wall_cos: (0..m).map(|e| (-PI / 2.0 + (2.0 * PI / m as f64) * e as f64).cos()).collect(),
            wall_sin: (0..m).map(|e| (-PI / 2.0 + (2.0 * PI / m as f64) * e as f64).sin()).collect(),
            vtx: vec![0.0; if n == 0 { 0 } else { 2 * n as usize * p }],
            rs: 0.0,
        }
    }

    #[inline]
    fn size(&self) -> f64 {
        self.l / self.unit
    }

    fn rest(&mut self) {
        self.vx.fill(0.0);
        self.vy.fill(0.0);
        self.vt.fill(0.0);
        self.vl = 0.0;
    }

    /// Reference start: a container of `fill` times the pieces' area, centres uniform in it at
    /// least a bounding radius from the walls, uniform angles. A piece that finds no such place
    /// is placed anywhere inside.
    fn scatter(&mut self, fill: f64, rng: &mut Rng) {
        let (n, m, p) = (self.n, self.m, self.p);
        let size = (fill * p as f64 * piece_area(n) / container_area(m, 1.0)).sqrt();
        self.l = size * self.unit;
        let half = if m == 0 { size / 2.0 } else { size / (2.0 * (PI / m as f64).sin()) };
        let margin = bounding_radius(n);
        // outward wall normals at phi = 0 (edge 0 is the bottom edge)
        let normals: Vec<(f64, f64)> = (0..m as usize)
            .map(|edge| {
                let angle = -PI / 2.0 + 2.0 * PI * edge as f64 / m as f64;
                (angle.cos(), angle.sin())
            })
            .collect();
        let apothem = self.apothem;
        let inside = |x: f64, y: f64, clearance: f64| -> bool {
            if m == 0 {
                return x.hypot(y) < apothem * size - clearance;
            }
            for &(ux, uy) in &normals {
                if x * ux + y * uy > apothem * size - clearance {
                    return false;
                }
            }
            true
        };
        for i in 0..p {
            let pose = &mut self.poses[i];
            pose.x = 0.0;
            pose.y = 0.0;
            // the clearance is dropped after 200 failures; 64 more trials practically always place it
            for trial in 0..264 {
                let x = (2.0 * rng.next() - 1.0) * half;
                let y = (2.0 * rng.next() - 1.0) * half;
                if !inside(x, y, if trial < 200 { margin } else { 0.0 }) {
                    continue;
                }
                pose.x = x;
                pose.y = y;
                break;
            }
            pose.theta = if n == 0 { 0.0 } else { 2.0 * PI * rng.next() };
        }
        self.rest();
    }

    /// Adopt a supplied arrangement: its enclosing container at the stored orientation becomes the
    /// moving container, with every pose expressed in that container's frame.
    fn adopt(&mut self, config: &Config) {
        let (poses, size) = adopt(config);
        self.poses.copy_from_slice(&poses);
        self.l = size * self.unit;
        self.rest();
    }

    /// True-shape arrangement of the current poses in the moving container's frame.
    fn config(&self) -> Config {
        Config { n: self.n, m: self.m, pieces: self.poses.clone(), phi: 0.0 }
    }

    /// False once a pose or the container has left the range a configuration may hold.
    fn finite(&self) -> bool {
        if !self.l.is_finite() {
            return false;
        }
        self.poses.iter().all(|q| q.theta.is_finite() && q.x.abs() <= MAX_COORD && q.y.abs() <= MAX_COORD)
    }

    fn pair_cost(&self, soft: &Soft) -> f64 {
        if self.n == 0 || soft.scale == 0.0 {
            return 1.0;
        }
        let n = self.n as f64;
        2.0 * n + if soft.padding > 0.0 { 2.0 * n * n } else { 0.0 }
    }

    fn wall_cost(&self, soft: &Soft) -> f64 {
        (if self.n == 0 || soft.scale == 0.0 { 1.0 } else { self.n as f64 }) * (self.m.max(1) as f64)
    }

    /// Pairs within twice the reach of the current shape (two soft pieces further apart cannot touch).
    fn collect_pairs(&mut self, reach: f64) {
        self.pairs.clear();
        if self.p > DIRECT_PAIRS {
            if reach > 0.0 {
                self.grid.build(&self.poses, reach);
                let pairs = &mut self.pairs;
                self.grid.for_each_pair(&self.poses, |i, j| {
                    pairs.push((i as u32, j as u32));
                    true
                });
            }
            self.work += 12.0 * self.p as f64;
            return;
        }
        let limit = reach * reach;
        for i in 0..self.p {
            for j in i + 1..self.p {
                let dx = self.poses[i].x - self.poses[j].x;
                let dy = self.poses[i].y - self.poses[j].y;
                if dx * dx + dy * dy <= limit {
                    self.pairs.push((i as u32, j as u32));
                }
            }
        }
        self.work += (self.p * (self.p.max(1) - 1)) as f64 / 2.0;
    }

    /// Core vertex offsets of every piece at core scale `s` (polygon cores only).
    fn build_vertices(&mut self, s: f64) {
        let n = self.n as usize;
        self.rs = self.big_r1 * s;
        for (i, q) in self.poses.iter().enumerate() {
            let (sn, cs) = q.theta.sin_cos();
            let out = &mut self.vtx[2 * n * i..2 * n * (i + 1)];
            for k in 0..n {
                let (bc, bs) = (self.base_cos[k], self.base_sin[k]);
                out[2 * k] = self.rs * (cs * bc - sn * bs);
                out[2 * k + 1] = self.rs * (sn * bc + cs * bs);
            }
        }
    }

    /// Penetration of two soft polygon pieces with the derivatives of the selected branch
    /// (penalty::pair_penetration for scale > 0, with two exact shortcuts). Along the edge normal u
    /// of piece p the other piece q reaches R cos(delta), delta the same for every normal of a
    /// pass, so the 2N axes reduce to the normal of each piece nearest the line of centres. The
    /// SAT gap lower-bounds the distance of the cores: past twice the padding nothing overlaps and
    /// the closest-feature search is skipped. None when the pair contributes nothing.
    #[inline]
    fn pair_poly(&self, i: usize, j: usize, s: f64, pad: f64) -> Option<PairPenetration> {
        let (a, b) = (&self.poses[i], &self.poses[j]);
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = dx.hypot(dy);
        let phi = dy.atan2(dx);
        let step = self.step;
        let ka = ((phi - a.theta - self.normal0) / step).round();
        let kb = ((phi + PI - b.theta - self.normal0) / step).round();
        let ang_a = a.theta + self.normal0 + ka * step;
        let ang_b = b.theta + self.normal0 + kb * step;
        let ga = d * (phi - ang_a).cos();
        let gb = d * (phi + PI - ang_b).cos();
        // the reach term r + R cos(delta) is the same for both passes
        let rel = a.theta - b.theta + PI + PI / self.nf;
        let reach = self.r1 * s + self.big_r1 * s * (rel - step * (rel / step).round()).cos();
        let (pass_a, ang, best) = if ga >= gb { (true, ang_a, ga - reach) } else { (false, ang_b, gb - reach) };
        if pad > 0.0 && best > 0.0 {
            if best >= 2.0 * pad {
                return None;
            }
            if let Some(c) = self.padded(i, j, dx, dy, pad) {
                return Some(c);
            }
        }
        let (p, q, qi) = if pass_a { (a, b, j) } else { (b, a, i) };
        let (uy, ux) = ang.sin_cos();
        let ddx = q.x - p.x;
        let ddy = q.y - p.y;
        // the vertex of q nearest the direction of u
        let nv = self.n as i64;
        let vertex = (((ang + PI / 2.0 - q.theta) / step).round() as i64).rem_euclid(nv) as usize;
        let at = 2 * (self.n as usize * qi + vertex);
        let (vx, vy) = (self.vtx[at], self.vtx[at + 1]);
        let dp = [ux, uy, (ddx + vx) * uy - (ddy + vy) * ux];
        let dq = [-ux, -uy, vy * ux - vx * uy];
        let depth = if pad == 0.0 { -best } else { -best + 2.0 * pad };
        Some(if pass_a { PairPenetration { depth, ga: dp, gb: dq } } else { PairPenetration { depth, ga: dq, gb: dp } })
    }

    /// Closest vertex/segment pair of two separated cores, with envelope derivatives. None when
    /// the cores touch exactly (the SAT branch derivative is used instead). A vertex whose
    /// distance to the other core's centre minus its circumradius cannot beat the best so far is
    /// skipped, which leaves the minimum unchanged.
    fn padded(&self, i: usize, j: usize, dx: f64, dy: f64, pad: f64) -> Option<PairPenetration> {
        let nv = self.n as usize;
        let va = &self.vtx[2 * nv * i..2 * nv * (i + 1)];
        let vb = &self.vtx[2 * nv * j..2 * nv * (j + 1)];
        let mut distance = f64::INFINITY;
        let (mut ax, mut ay, mut bx, mut by, mut ux, mut uy) = (0.0, 0.0, 0.0, 0.0, 1.0, 0.0);
        for pass in 0..2 {
            let (vertices, edges) = if pass == 0 { (va, vb) } else { (vb, va) };
            let (cx, cy) = if pass == 0 { (dx, dy) } else { (-dx, -dy) };
            for v in 0..nv {
                let x = vertices[2 * v];
                let y = vertices[2 * v + 1];
                let (px, py) = (x - cx, y - cy);
                let lim = distance + self.rs;
                if px * px + py * py >= lim * lim {
                    continue;
                }
                for e in 0..nv {
                    let k = if e + 1 == nv { 0 } else { e + 1 };
                    let ex = edges[2 * k] - edges[2 * e];
                    let ey = edges[2 * k + 1] - edges[2 * e + 1];
                    let length2 = ex * ex + ey * ey;
                    let t = if length2 == 0.0 {
                        0.0
                    } else {
                        (((x - cx - edges[2 * e]) * ex + (y - cy - edges[2 * e + 1]) * ey) / length2).clamp(0.0, 1.0)
                    };
                    let qx = edges[2 * e] + t * ex;
                    let qy = edges[2 * e + 1] + t * ey;
                    let wx = x - cx - qx;
                    let wy = y - cy - qy;
                    let d2 = wx * wx + wy * wy;
                    if d2 == 0.0 {
                        return None;
                    }
                    if d2 >= distance * distance {
                        continue;
                    }
                    let dd = d2.sqrt();
                    distance = dd;
                    if pass == 0 {
                        ax = x;
                        ay = y;
                        bx = qx;
                        by = qy;
                        ux = wx / dd;
                        uy = wy / dd;
                    } else {
                        ax = qx;
                        ay = qy;
                        bx = x;
                        by = y;
                        ux = -wx / dd;
                        uy = -wy / dd;
                    }
                }
            }
        }
        Some(PairPenetration {
            depth: 2.0 * pad - distance,
            ga: [-ux, -uy, ay * ux - ax * uy],
            gb: [ux, uy, bx * uy - by * ux],
        })
    }

    /// Energy gradient for this shape: pair terms, then wall terms. Returns dE/dL.
    ///
    /// The terms are those of penalty::pair_penetration and penalty::visit_protrusions (full form
    /// for polygon cores, one constraint per wall for disks), evaluated from per-piece vertex
    /// tables and wall normals built once per gradient.
    #[inline(never)]
    fn gradient(&mut self, soft: &Soft) -> Report {
        let n = self.n;
        self.gx.fill(0.0);
        self.gy.fill(0.0);
        self.gt.fill(0.0);
        let one = soft.reach(n);
        let poly = n != 0 && soft.scale > 0.0;
        if poly {
            self.build_vertices(soft.scale);
        }
        self.collect_pairs(2.0 * one);
        let mut size_gradient = 0.0;
        let pair_cost = self.pair_cost(soft);
        for k in 0..self.pairs.len() {
            let (i, j) = (self.pairs[k].0 as usize, self.pairs[k].1 as usize);
            // depth = 2 r - sd(cores): exact core distance when apart, minus the SAT depth when overlapping
            let hit = if poly {
                match self.pair_poly(i, j, soft.scale, soft.padding) {
                    Some(h) => h,
                    None => continue,
                }
            } else {
                pair_penetration(&self.shape, &self.poses[i], &self.poses[j], soft.scale, soft.padding)
            };
            let depth = hit.depth;
            if !(depth > 0.0) {
                continue;
            }
            let f = 2.0 * depth;
            self.gx[i] += f * hit.ga[0];
            self.gy[i] += f * hit.ga[1];
            self.gt[i] += f * hit.ga[2];
            self.gx[j] += f * hit.gb[0];
            self.gy[j] += f * hit.gb[1];
            self.gt[j] += f * hit.gb[2];
        }
        self.work += self.pairs.len() as f64 * pair_cost;
        let size = self.size();
        // a piece whose reach stays inside the container's inscribed circle touches no wall
        let apothem = self.apothem;
        let clear = apothem * size - one;
        let wall = size * apothem;
        let (m, nv) = (self.m as usize, n as usize);
        let mut visited = 0.0;
        for i in 0..self.p {
            let pose = self.poses[i];
            if pose.x.hypot(pose.y) <= clear {
                continue;
            }
            visited += 1.0;
            let (mut ax, mut ay, mut at) = (0.0, 0.0, 0.0);
            // one violated constraint: depth, outward normal, and the lever arm of the vertex
            let mut hit = |depth: f64, ux: f64, uy: f64, ox: f64, oy: f64| {
                let f = 2.0 * depth;
                ax += f * ux;
                ay += f * uy;
                at += f * (ox * uy - oy * ux);
                size_gradient -= f * apothem;
            };
            if poly {
                let off = &self.vtx[2 * nv * i..2 * nv * (i + 1)];
                for k in 0..nv {
                    let (ox, oy) = (off[2 * k], off[2 * k + 1]);
                    let dx = pose.x + ox;
                    let dy = pose.y + oy;
                    if m == 0 {
                        let distance = dx.hypot(dy);
                        let (ux, uy) = if distance == 0.0 { (1.0, 0.0) } else { (dx / distance, dy / distance) };
                        let depth = distance + soft.padding - wall;
                        if depth > 0.0 {
                            hit(depth, ux, uy, ox, oy);
                        }
                    } else {
                        for e in 0..m {
                            let (ux, uy) = (self.wall_cos[e], self.wall_sin[e]);
                            let depth = dx * ux + dy * uy + soft.padding - wall;
                            if depth > 0.0 {
                                hit(depth, ux, uy, ox, oy);
                            }
                        }
                    }
                }
            } else if m == 0 {
                // a circle piece or a pure inscribed disk: one constraint, with its radius
                let distance = pose.x.hypot(pose.y);
                let (ux, uy) = if distance == 0.0 { (1.0, 0.0) } else { (pose.x / distance, pose.y / distance) };
                let depth = distance + one - wall;
                if depth > 0.0 {
                    hit(depth, ux, uy, 0.0, 0.0);
                }
            } else {
                for e in 0..m {
                    let (ux, uy) = (self.wall_cos[e], self.wall_sin[e]);
                    let depth = pose.x * ux + pose.y * uy + one - wall;
                    if depth > 0.0 {
                        hit(depth, ux, uy, 0.0, 0.0);
                    }
                }
            }
            self.gx[i] += ax;
            self.gy[i] += ay;
            self.gt[i] += at;
        }
        self.work += self.p as f64 + visited * self.wall_cost(soft);
        // no torque on pure disks
        if n == 0 || soft.tau >= DISK_TAU {
            self.gt.fill(0.0);
        }
        Report { size_gradient: size_gradient / self.unit }
    }

    /// One momentum step from the finished gradient: v <- 0.85 v - 0.04 grad, capped, then noise;
    /// the container follows v_L <- 0.85 v_L - 0.02 (pressure + dE/dL) under the same cap.
    /// `pressure` and `noise` are in piece length units; angular noise is 1.5 times the
    /// positional noise per length unit (radians).
    fn advance(&mut self, report: &Report, pressure: f64, noise: f64, rng: &mut Rng) {
        let cap = self.cap;
        let turn = if self.n == 0 { 0.0 } else { 1.5 * noise / self.length };
        for i in 0..self.p {
            self.vx[i] = MOMENTUM * self.vx[i] - POSE_RATE * self.gx[i];
            self.vy[i] = MOMENTUM * self.vy[i] - POSE_RATE * self.gy[i];
            self.vt[i] = MOMENTUM * self.vt[i] - POSE_RATE * self.gt[i];
            let speed = self.vx[i].hypot(self.vy[i]);
            if speed > cap {
                self.vx[i] *= cap / speed;
                self.vy[i] *= cap / speed;
            }
            if self.vt[i].abs() > STEP_CAP {
                self.vt[i] = STEP_CAP.copysign(self.vt[i]);
            }
            let pose = &mut self.poses[i];
            pose.x += self.vx[i];
            pose.y += self.vy[i];
            pose.theta += self.vt[i];
            if noise > 0.0 {
                pose.x += noise * rng.gaussian();
                pose.y += noise * rng.gaussian();
                if turn > 0.0 {
                    pose.theta += turn * rng.gaussian();
                }
            }
        }
        self.vl = MOMENTUM * self.vl - SIZE_RATE * (pressure + report.size_gradient);
        if self.vl.abs() > cap {
            self.vl = cap.copysign(self.vl);
        }
        self.l += self.vl;
        self.work += self.p as f64;
    }
}

/// Legalisation by homothety about the mean centre to first contact: the smallest factor at which
/// no pair has negative separation, apart when pieces overlap and together when none touch (the
/// reference's rule, harden/legalise.ts).
///
/// The factor needs no bisection. Scaling the centres moves each pair along a fixed ray, and for
/// congruent pieces the separation of the closed-form SAT is
///   sep(f) = f |d| cos(alpha) - offset
/// with alpha (the angle from the ray to the nearest edge normal) and offset (r + R cos(delta))
/// independent of f, so a pair is separated from f = offset / (|d| cos(alpha)) on, and the answer
/// is the largest such factor over the pairs. A pair at critical factor f touches at centre
/// distance f |d| <= 2R, so the search widens its reach to 2R / factor until the list of pairs
/// covers every pair that could still raise the factor. A last-place margin of 2e-12 keeps contact
/// from rounding into overlap, and the result is verified at zero tolerance. None when pieces
/// coincide (no finite factor), when the factor exceeds 1e6, or when the check fails; the caller
/// then hands the arrangement to the seeded shared restoration.
fn legalise_fast(config: &Config, grid: &mut NeighborGrid, tester: &mut PairTester) -> Option<Config> {
    let shape = tester.shape;
    let poses = &config.pieces;
    let two_r = 2.0 * bounding_radius(config.n);
    let critical = |a: &Pose, b: &Pose| -> f64 {
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = dx.hypot(dy);
        if shape.n == 0 {
            return 2.0 * crate::shapes::DISK_RADIUS / d;
        }
        let phi = dy.atan2(dx);
        let alpha_a = shape.fold(phi - a.theta - shape.normal0);
        let alpha_b = shape.fold(phi + PI - b.theta - shape.normal0);
        shape.contact_offset(a.theta, b.theta) / (d * alpha_a.min(alpha_b).cos())
    };
    let mut reach = two_r;
    let mut factor = 0.0f64;
    for round in 0..8 {
        factor = 0.0;
        // `!(f <= factor)` also lets a NaN through to the range check below
        let mut take = |f: f64| {
            if !(f <= factor) {
                factor = f;
            }
        };
        if reach.is_finite() && round < 7 {
            grid.build(poses, reach);
            grid.for_each_pair(poses, |i, j| {
                take(critical(&poses[i], &poses[j]));
                true
            });
        } else {
            for i in 0..poses.len() {
                for j in i + 1..poses.len() {
                    take(critical(&poses[i], &poses[j]));
                }
            }
            break;
        }
        let need = if factor > 0.0 { two_r / factor } else { f64::INFINITY };
        if need <= reach {
            break;
        }
        reach = need;
    }
    if !(factor <= 1e6) {
        return None;
    }
    let result = dilate(config, factor * (1.0 + 2e-12));
    if tester.any_below(&result.pieces, 0.0) {
        None
    } else {
        Some(result)
    }
}

/// Legalise the current poses as true shapes and score them; false ends the method.
///
/// Only an arrangement with no zero-tolerance overlap is ever scored.
#[inline(never)]
fn assess(ctx: &mut Ctx, state: &mut Dynamics, seen: &mut Seen, tester: &mut PairTester) -> bool {
    if ctx.should_stop() {
        return false;
    }
    let raw = state.config();
    let legal = match legalise_fast(&raw, &mut state.grid, tester) {
        Some(c) => c,
        None => {
            // coincident centres: the seeded shared restoration
            let legal = restore(ctx, &raw, Strategy::Expand, true, COORD_LIMIT, tester, None);
            match legal {
                Some(l) if !tester.any_below(&l.pieces, 0.0) => l,
                _ => return !ctx.should_stop(),
            }
        }
    };
    if !seen.add(&legal.pieces) {
        return true;
    }
    ctx.evaluate(&legal, false).is_some()
}

pub fn execute(ctx: &mut Ctx) {
    let params: Params = match params_of(ctx) {
        Some(p) => p,
        None => return,
    };
    if !ctx.checkpoint() {
        return;
    }
    let problem = ctx.problem;
    let (n, p) = (problem.n, problem.p);
    let path = Path::parse(&params.path);
    let (tau0, gamma0) = (params.tau0, params.gamma0);
    let interval = params.evaluation_interval as i64;
    let full = Phases { compress: params.compress_steps as i64, morph: params.morph_steps as i64, settle: params.settle_steps as i64 };
    let full_steps = full.total();
    let allowance = ctx.remaining().0;
    let limited = allowance.is_finite();
    let runs = plan_runs(allowance, full_steps as f64, interval as f64, params.restarts as f64);

    // hashes of scored arrangements; the framework has already scored a supplied start
    let mut seen = Seen::new(n);
    let start: Option<Config> = ctx.start().filter(|s| s.pieces.len() == p).cloned();
    if let Some(s) = &start {
        seen.add(&s.pieces);
    }
    let mut tester = PairTester::new(n);
    let mut state = Dynamics::new(problem);

    let mut run = 0u64;
    while (run as f64) < runs {
        if !ctx.checkpoint() {
            return;
        }
        let remaining = ctx.remaining().0;
        if remaining < 1.0 {
            return;
        }
        // a complete supplied arrangement replaces the random start of the first run
        let supplied = if run == 0 { start.as_ref() } else { None };
        if let Some(s) = supplied {
            state.adopt(s);
        } else {
            state.scatter(params.fill, &mut ctx.rng);
        }
        // pressure and noise in piece length units
        let pressure = params.pressure * state.length;
        let noise = params.noise * state.length;
        let (g, t) = path_shape(path, 0.0, n, tau0, gamma0);
        let mut soft = soft_shape(n, g, t);

        // Until something valid has been scored, a stop would leave the run without a result and
        // the first steps of a large problem take a noticeable time. When the framework holds no
        // valid start and the run can afford it, one arrangement is therefore scored first: the
        // legalised supplied start, or else the shared jitter-free grid (no repair, no seeded draw).
        if run == 0 && !ctx.initial_evaluation().map_or(false, |e| e.valid) && (!limited || remaining / runs >= 2.0) {
            if supplied.is_some() {
                if !assess(ctx, &mut state, &mut seen, &mut tester) {
                    return;
                }
            } else {
                let grid = scatter(problem, || 0.5);
                seen.add(&grid.pieces);
                if ctx.evaluate(&grid, false).is_none() {
                    return;
                }
            }
        }
        // an evaluation allowance fixes the run length: its share of assessments times the steps
        // each one pays for; without one every run has the full length
        let steps = if limited { ((ctx.remaining().0 / (runs - run as f64)).floor() as i64) * interval } else { full_steps };
        let plan = plan_phases(steps, full, supplied.is_none());
        let total = plan.total();
        let mut done = 0i64;
        let mut work = 0.0;
        while done < total {
            if ctx.should_stop() {
                return;
            }
            // phase, progress u within it, and the reference's pressure and noise for this step
            let mut strength = pressure;
            let mut sigma = 0.0;
            if done < plan.compress {
                strength = 3.0 * pressure;
                sigma = 0.015 * noise * (1.0 - done as f64 / plan.compress as f64);
            } else if done < plan.compress + plan.morph {
                let u = (done - plan.compress) as f64 / plan.morph as f64;
                let (g, t) = path_shape(path, u, n, tau0, gamma0);
                soft = soft_shape(n, g, t);
                sigma = 0.004 * noise * (1.0 - u);
            } else {
                let (g, t) = path_shape(path, 1.0, n, tau0, gamma0);
                soft = soft_shape(n, g, t);
                strength = pressure * 10f64.powf(-4.0 * (done - plan.compress - plan.morph) as f64 / plan.settle as f64);
            }
            state.work = 0.0;
            let report = state.gradient(&soft);
            state.advance(&report, strength, sigma, &mut ctx.rng);
            done += 1;
            work += state.work;
            if work >= CHECKPOINT_WORK {
                work = 0.0;
                if !ctx.checkpoint() {
                    return;
                }
            }
            // a diverged state cannot be scored or continued; the next run starts afresh
            if !state.finite() {
                break;
            }
            if (done % interval == 0 || done == total) && !assess(ctx, &mut state, &mut seen, &mut tester) {
                return;
            }
        }
        run += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::penalty::visit_protrusions;
    use crate::shapes::Container;

    /// The gradient as the shared penalty geometry gives it: pair_penetration for every pair
    /// within reach and visit_protrusions for every piece (the reference the fast kernels follow).
    fn reference_gradient(d: &Dynamics, soft: &Soft) -> (Vec<[f64; 3]>, f64) {
        let n = d.n;
        let one = soft.reach(n);
        let mut g = vec![[0.0; 3]; d.p];
        let mut size_gradient = 0.0;
        for i in 0..d.p {
            for j in i + 1..d.p {
                let dist = (d.poses[i].x - d.poses[j].x).hypot(d.poses[i].y - d.poses[j].y);
                if dist > 2.0 * one {
                    continue;
                }
                let hit = pair_penetration(&d.shape, &d.poses[i], &d.poses[j], soft.scale, soft.padding);
                if !(hit.depth > 0.0) {
                    continue;
                }
                for c in 0..3 {
                    g[i][c] += 2.0 * hit.depth * hit.ga[c];
                    g[j][c] += 2.0 * hit.depth * hit.gb[c];
                }
            }
        }
        let container = Container { m: d.m, cx: 0.0, cy: 0.0, phi: 0.0, size: d.size() };
        for i in 0..d.p {
            let mut acc = [0.0; 3];
            let mut visit = |pr: crate::penalty::Protrusion| {
                if pr.depth > 0.0 {
                    acc[0] += 2.0 * pr.depth * pr.px;
                    acc[1] += 2.0 * pr.depth * pr.py;
                    acc[2] += 2.0 * pr.depth * pr.pt;
                    size_gradient += 2.0 * pr.depth * pr.size;
                }
            };
            if n == 0 || soft.scale == 0.0 {
                visit_protrusions(0, &d.poses[i], &container, true, 0.0, one, &mut visit);
            } else {
                visit_protrusions(n, &d.poses[i], &container, false, soft.scale, soft.padding, &mut visit);
            }
            for c in 0..3 {
                g[i][c] += acc[c];
            }
        }
        if n == 0 || soft.tau >= DISK_TAU {
            for q in &mut g {
                q[2] = 0.0;
            }
        }
        (g, size_gradient / d.unit)
    }

    #[test]
    fn legalisation_is_the_first_contact_homothety() {
        let mut rng = Rng::new(5);
        let mut grid = NeighborGrid::new();
        let mut looser = 0;
        let mut tighter = 0;
        for &n in &[0u32, 3, 4, 5, 6, 9, 20] {
            let mut tester = PairTester::new(n);
            for &(p, spread) in &[(2usize, 1.5), (6, 2.0), (25, 3.0), (60, 12.0), (60, 4.0)] {
                for _ in 0..8 {
                    let pieces: Vec<Pose> = (0..p)
                        .map(|_| Pose::new(spread * (rng.next() - 0.5), spread * (rng.next() - 0.5), 6.0 * rng.next()))
                        .collect();
                    let config = Config { n, m: 4, pieces, phi: 0.0 };
                    let legal = legalise_fast(&config, &mut grid, &mut tester).expect("a factor");
                    assert!(!tester.any_below(&legal.pieces, 0.0), "n={n} p={p}: overlap left");
                    // the factor is the smallest: a hair less than it overlaps somewhere
                    let distance = |v: &[Pose]| (v[1].x - v[0].x).hypot(v[1].y - v[0].y);
                    let factor = distance(&legal.pieces) / distance(&config.pieces);
                    let probe = dilate(&config, factor * (1.0 - 1e-7));
                    assert!(tester.any_below(&probe.pieces, 0.0), "n={n} p={p}: not tight (factor {factor})");
                    if factor > 1.0 {
                        looser += 1;
                    } else {
                        tighter += 1;
                    }
                }
            }
        }
        assert!(looser > 10 && tighter > 10, "both directions covered: {looser} apart, {tighter} together");
    }

    /// Runs on small problems, from nothing and from a supplied start: strictly valid, reproducible
    /// from the seed under an evaluation budget, and never worse than the start.
    #[test]
    fn runs_are_strict_and_reproducible() {
        use crate::clock::ClockKind;
        use crate::framework::{run, Budget, Control, RunOptions};
        use crate::methods::Method;
        use crate::shapes::area_lower_bound;
        for &(n, m, p) in &[(0u32, 4u32, 10usize), (0, 0, 9), (4, 4, 6), (3, 6, 7), (5, 5, 6), (7, 0, 6)] {
            let go = |seed: u32, params: Value, start: Option<Config>| {
                let control = Control::new();
                run(
                    Problem::new(n, m, p),
                    RunOptions {
                        method: Method::Harden,
                        params,
                        start,
                        budget: Budget { evals: Some(150), time_s: Some(60.0) },
                        seed,
                        final_polish: false,
                        control: &control,
                        clock: ClockKind::ThreadCpu,
                    },
                )
            };
            let (a, b) = (go(3, Value::Null, None), go(3, Value::Null, None));
            assert!(a.valid && a.strict, "n={n} m={m} p={p}: {:?}", a.reasons);
            assert_eq!(a.score, b.score, "n={n} m={m} p={p}: not reproducible");
            assert_eq!(a.evaluations, b.evaluations);
            assert!(a.score.unwrap() >= area_lower_bound(n, m, p) * (1.0 - 1e-9));
            // from the result of the first run, along the rigid path with noise
            let params = serde_json::json!({"path": "rigid", "noise": 1});
            let c = go(5, params.clone(), a.best.clone());
            let d = go(5, params, a.best.clone());
            assert!(c.valid && c.strict, "n={n} m={m} p={p}: {:?}", c.reasons);
            assert!(c.score.unwrap() <= a.score.unwrap() * (1.0 + 1e-12), "n={n} m={m} p={p}: worse than its start");
            assert_eq!(c.score, d.score);
        }
    }

    #[test]
    fn gradient_equals_the_shared_penalty_geometry() {
        let mut rng = Rng::new(11);
        let mut checked = 0;
        for &(n, m) in &[(0u32, 0u32), (0, 4), (3, 6), (4, 4), (5, 0), (7, 3), (12, 5), (30, 4)] {
            for &p in &[9usize, 45] {
                let mut d = Dynamics::new(Problem::new(n, m, p));
                d.scatter(1.6, &mut rng);
                // push some pieces together and out of the walls
                for q in d.poses.iter_mut() {
                    q.x *= 0.8 + 0.2 * rng.next();
                    q.y *= 0.8 + 0.2 * rng.next();
                }
                for &(gamma, tau) in &[(1.0, 0.0), (1.0, 0.4), (1.0, 1.0), (0.35, 0.0), (0.8, 0.9), (1.0, 0.05)] {
                    let soft = soft_shape(n, gamma, tau);
                    let (want, want_size) = reference_gradient(&d, &soft);
                    d.gradient(&soft);
                    for i in 0..p {
                        let got = [d.gx[i], d.gy[i], d.gt[i]];
                        for c in 0..3 {
                            let tol = 1e-9 * (1.0 + want[i][c].abs());
                            assert!((got[c] - want[i][c]).abs() <= tol, "n={n} m={m} p={p} g={gamma} t={tau} piece {i} comp {c}: {} vs {}", got[c], want[i][c]);
                        }
                        if want[i].iter().any(|v| v.abs() > 1e-6) {
                            checked += 1;
                        }
                    }
                    let report = d.gradient(&soft);
                    assert!((report.size_gradient - want_size).abs() <= 1e-9 * (1.0 + want_size.abs()), "size {} vs {}", report.size_gradient, want_size);
                }
            }
        }
        // the states are crowded enough that most pieces feel some force
        assert!(checked > 1000, "only {checked} pieces with a force");
    }

    #[test]
    fn phases_keep_the_proportion_and_at_least_one_path_step() {
        let full = Phases { compress: 2500, morph: 7500, settle: 1500 };
        let p = plan_phases(11500, full, true);
        assert_eq!((p.compress, p.morph, p.settle), (2500, 7500, 1500));
        let p = plan_phases(1, full, true);
        assert_eq!(p.total(), 1);
        assert_eq!(p.morph, 1);
        let p = plan_phases(115, full, false);
        assert_eq!(p.compress, 0);
        assert_eq!(p.total(), 115);
    }

    #[test]
    fn runs_fit_the_allowance() {
        assert_eq!(plan_runs(f64::INFINITY, 11500.0, 32.0, 0.0), f64::INFINITY);
        assert_eq!(plan_runs(f64::INFINITY, 11500.0, 32.0, 3.0), 3.0);
        assert_eq!(plan_runs(718.0, 11500.0, 32.0, 0.0), 1.0);
        assert_eq!(plan_runs(1500.0, 11500.0, 32.0, 0.0), 4.0);
        assert_eq!(plan_runs(2.0, 11500.0, 32.0, 5.0), 2.0);
    }

    #[test]
    fn paths_end_at_the_true_piece() {
        for path in [Path::Harden, Path::Grow, Path::Rigid, Path::Snap, Path::GrowArea] {
            assert_eq!(path_shape(path, 1.0, 5, 1.0, 0.1), (1.0, 0.0));
        }
        assert_eq!(path_shape(Path::Harden, 0.0, 5, 1.0, 0.1), (1.0, 1.0));
        assert_eq!(path_shape(Path::Harden, 0.0, 0, 1.0, 0.1), (1.0, 0.0));
        assert_eq!(path_shape(Path::Grow, 0.0, 0, 1.0, 0.1), (0.1, 0.0));
    }

    #[test]
    fn rejects_out_of_range_parameters() {
        assert!(resolve(&serde_json::json!({"pressure": 0.0})).is_err());
        assert!(resolve(&serde_json::json!({"path": "bogus"})).is_err());
        assert!(resolve(&serde_json::json!({"nope": 1})).is_err());
        assert!(resolve(&Value::Null).is_ok());
    }
}
