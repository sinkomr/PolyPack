//! Soft-to-rigid hardening, after Yohei Nakajima (packages/solver/src/methods/harden.ts and
//! harden/{dynamics,shapes,legalise,signature}.ts).
//!
//! The method, its shape paths, its three-phase schedule (compress, follow the path, settle), its
//! energy and momentum update, and the default pressure, noise, softness, scale, step counts and
//! start area come from his openly published work, used here with thanks under its MIT licence:
//!   site        https://yoheinakajima.github.io/soft-to-rigid/
//!   repository  https://github.com/yoheinakajima/soft-to-rigid  (engine/engine2d.js, paper/main.pdf)
//! PolyPack's part is the generalisation to every regular piece and container on the shared
//! penalty geometry, the mapping of evaluation and time budgets onto the schedule, restarts, and a
//! grid-based implementation of his legalisation rule. See docs/methods/harden.md.
//!
//! A soft piece is its polygon core scaled by gamma (1 - tau) about the centre and dilated by a
//! disk of radius gamma tau rho (rho the inradius). Only legalised true shapes are ever scored.

use super::common::{adopt, legalise, restore, scatter, PairTester, Strategy, COORD_LIMIT};
use super::params_of;
use crate::framework::Ctx;
use crate::grid::NeighborGrid;
use crate::penalty::{pair_penetration, visit_protrusions, Protrusion};
use crate::rng::Rng;
use crate::sep::Shape;
use crate::shapes::{
    bounding_radius, container_area, container_inradius, inradius, piece_area, piece_inradius, Config, Container, Pose, Problem,
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

    /// Energy gradient for this shape: pair terms, then wall terms. Returns dE/dL.
    fn gradient(&mut self, soft: &Soft) -> Report {
        let n = self.n;
        self.gx.fill(0.0);
        self.gy.fill(0.0);
        self.gt.fill(0.0);
        let one = soft.reach(n);
        self.collect_pairs(2.0 * one);
        let mut size_gradient = 0.0;
        let pair_cost = self.pair_cost(soft);
        {
            let shape = &self.shape;
            let poses = &self.poses;
            let (gx, gy, gt) = (&mut self.gx, &mut self.gy, &mut self.gt);
            for &(i, j) in &self.pairs {
                let (i, j) = (i as usize, j as usize);
                // depth = 2 r - sd(cores): exact core distance when apart, minus the SAT depth when overlapping
                let hit = pair_penetration(shape, &poses[i], &poses[j], soft.scale, soft.padding);
                let depth = hit.depth;
                if !(depth > 0.0) {
                    continue;
                }
                let f = 2.0 * depth;
                gx[i] += f * hit.ga[0];
                gy[i] += f * hit.ga[1];
                gt[i] += f * hit.ga[2];
                gx[j] += f * hit.gb[0];
                gy[j] += f * hit.gb[1];
                gt[j] += f * hit.gb[2];
            }
        }
        self.work += self.pairs.len() as f64 * pair_cost;
        let container = Container { m: self.m, cx: 0.0, cy: 0.0, phi: 0.0, size: self.size() };
        // a piece whose reach stays inside the container's inscribed circle touches no wall
        let clear = self.apothem * container.size - one;
        let disk = n == 0 || soft.scale == 0.0;
        let mut visited = 0.0;
        for i in 0..self.p {
            let pose = self.poses[i];
            if pose.x.hypot(pose.y) <= clear {
                continue;
            }
            visited += 1.0;
            let (mut ax, mut ay, mut at) = (0.0, 0.0, 0.0);
            let mut visit = |pr: Protrusion| {
                let depth = pr.depth;
                if !(depth > 0.0) {
                    return;
                }
                let f = 2.0 * depth;
                ax += f * pr.px;
                ay += f * pr.py;
                at += f * pr.pt;
                size_gradient += f * pr.size;
            };
            if disk {
                // a circle piece or a pure inscribed disk: one constraint per wall, with its radius
                visit_protrusions(0, &pose, &container, true, 0.0, one, &mut visit);
            } else {
                visit_protrusions(n, &pose, &container, false, soft.scale, soft.padding, &mut visit);
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

/// Legalise the current poses as true shapes and score them; false ends the method.
///
/// Homothety about the mean centre to first contact: apart if any true pieces overlap, together if
/// none touch. Coincident centres cannot be separated this way and fall through to the seeded
/// shared restoration. Only an arrangement with no zero-tolerance overlap is ever scored.
fn assess(ctx: &mut Ctx, state: &Dynamics, seen: &mut Seen, tester: &mut PairTester) -> bool {
    if ctx.should_stop() {
        return false;
    }
    let raw = state.config();
    let contact = legalise(ctx, &raw, tester);
    if ctx.should_stop() {
        return false;
    }
    let legal = restore(ctx, contact.as_ref().unwrap_or(&raw), Strategy::Expand, true, COORD_LIMIT, tester, None);
    let legal = match legal {
        Some(l) if !tester.any_below(&l.pieces, 0.0) => l,
        _ => return !ctx.should_stop(),
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
                if !assess(ctx, &state, &mut seen, &mut tester) {
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
            if (done % interval == 0 || done == total) && !assess(ctx, &state, &mut seen, &mut tester) {
                return;
            }
        }
        run += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
