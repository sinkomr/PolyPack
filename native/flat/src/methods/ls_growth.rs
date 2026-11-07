//! Lubachevsky-Stillinger style growth (packages/solver/src/methods/ls_growth.ts and
//! ls_growth/{dynamics,events}.ts): congruent pieces grow inside a fixed container.
//!
//! A simulation scale q means disk diameter q (radius q/2) or polygon side q. Assessments divide
//! every centre and the container size by q, leaving unit pieces. Disks move ballistically
//! between exact collision events (the first entering root of |d + v t| = 2 r + 2 g t, polygon
//! wall events linear in t, circular walls the first exiting root); polygons use approximate
//! rotating dynamics with four samples per step and bisection back to the contact. Growth injects
//! energy, so a thermostat restores the initial translational energy when it exceeds a multiple.
//!
//! Every state submitted for assessment has non-negative pair separation in unit coordinates
//! (the closed-form SAT of the search kernel) and no wall protrusion. Roundoff violations are
//! repaired by a uniform shrink of the pieces; larger ones end the run. See
//! docs/methods/ls_growth.md.

use super::common::{restore, scatter, PairTester, Strategy, COORD_LIMIT};
use super::{params_of, Method};
use crate::enclose::enclose;
use crate::framework::Ctx;
use crate::grid::NeighborGrid;
use crate::penalty::visit_protrusions;
use crate::rng::Rng;
use crate::sep::{piece_separation, Shape};
use crate::shapes::{bounding_radius, container_inradius, Config, Container, Pose, DISK_RADIUS, MAX_COORD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::f64::consts::PI;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub initialization: String,
    pub growth_rate: f64,
    pub initial_speed: f64,
    pub angular_speed: f64,
    pub initial_shrink: f64,
    pub restart_shrink: f64,
    pub runs: u32,
    pub jam_threshold: f64,
    pub jam_window: u32,
    pub energy_factor: f64,
    pub evaluation_interval: u32,
    pub stagnation_evaluations: u32,
    pub max_step: f64,
    pub seed_evals: u32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            initialization: "random".into(),
            growth_rate: 0.01,
            initial_speed: 1.0,
            angular_speed: 0.3,
            initial_shrink: 0.2,
            restart_shrink: 0.05,
            runs: 4,
            jam_threshold: 1e-8,
            jam_window: 32,
            energy_factor: 4.0,
            evaluation_interval: 16,
            stagnation_evaluations: 128,
            max_step: 0.02,
            seed_evals: 8,
        }
    }
}

fn in_range(name: &str, v: f64, lo: f64, hi: f64) -> Result<(), String> {
    if v >= lo && v <= hi {
        Ok(())
    } else {
        Err(format!("ls_growth: {name} must be between {lo} and {hi}"))
    }
}

impl Params {
    pub fn check(&self) -> Result<(), String> {
        if self.initialization != "random" && self.initialization != "seed" {
            return Err("ls_growth: initialization must be random or seed".into());
        }
        in_range("growthRate", self.growth_rate, 1e-6, 1.0)?;
        in_range("initialSpeed", self.initial_speed, 1e-4, 100.0)?;
        in_range("angularSpeed", self.angular_speed, 0.0, 10.0)?;
        in_range("initialShrink", self.initial_shrink, 0.001, 0.9)?;
        in_range("restartShrink", self.restart_shrink, 0.001, 0.5)?;
        in_range("runs", self.runs as f64, 1.0, 100.0)?;
        in_range("jamThreshold", self.jam_threshold, 1e-14, 0.01)?;
        in_range("jamWindow", self.jam_window as f64, 2.0, 10000.0)?;
        in_range("energyFactor", self.energy_factor, 1.01, 100.0)?;
        in_range("evaluationInterval", self.evaluation_interval as f64, 1.0, 10000.0)?;
        in_range("stagnationEvaluations", self.stagnation_evaluations as f64, 2.0, 10000.0)?;
        in_range("maxStep", self.max_step, 1e-5, 0.1)?;
        in_range("seedEvals", self.seed_evals as f64, 3.0, 256.0)?;
        Ok(())
    }
}

pub fn resolve(given: &Value) -> Result<Value, String> {
    let (v, p) = super::fill::<Params>(given)?;
    p.check()?;
    Ok(v)
}

/// Scanning work between cooperative checkpoints, in weighted piece visits (roughly one or two
/// milliseconds). Counted work, not a clock, so that seeded runs stay reproducible.
const CHECKPOINT_WORK: f64 = 2048.0;
/// Up to this many pieces every pair is distance-tested directly; above it a cell grid is used.
const DIRECT: usize = 40;

#[derive(Default)]
struct Work {
    acc: f64,
}

impl Work {
    /// Add scanned units; true when a checkpoint is due.
    #[inline]
    fn due(&mut self, units: f64) -> bool {
        self.acc += units;
        if self.acc < CHECKPOINT_WORK {
            return false;
        }
        self.acc = 0.0;
        true
    }
}

// ---- signatures of scored states ----

#[inline]
fn mix(mut x: u64) -> u64 {
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58476d1ce4e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d049bb133111eb);
    x ^ (x >> 31)
}

/// 64-bit hash of the exact poses and container angle (negative zero as zero).
fn config_key(config: &Config) -> u64 {
    let mut h = mix(0x9e3779b97f4a7c15 ^ config.pieces.len() as u64);
    h = mix(h ^ (config.phi + 0.0).to_bits());
    for p in &config.pieces {
        h = mix(h ^ (p.x + 0.0).to_bits());
        h = mix(h.wrapping_add((p.y + 0.0).to_bits()));
        h = mix(h ^ (p.theta + 0.0).to_bits().rotate_left(17));
    }
    h
}

/// Signatures of the states already assessed, the oldest forgotten first beyond `limit`. A hash
/// collision can only make the method skip one assessment.
struct Seen {
    set: HashSet<u64>,
    order: VecDeque<u64>,
    limit: usize,
}

impl Seen {
    fn new(limit: usize) -> Self {
        Seen { set: HashSet::new(), order: VecDeque::new(), limit }
    }

    fn contains(&self, key: u64) -> bool {
        self.set.contains(&key)
    }

    fn remember(&mut self, key: u64) {
        if !self.set.insert(key) {
            return;
        }
        self.order.push_back(key);
        if self.order.len() > self.limit {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
    }
}

// ---- events of the disk dynamics (ls_growth/events.ts) ----

#[derive(Clone, Copy, Debug, Default)]
struct Vel {
    x: f64,
    y: f64,
    omega: f64,
}

/// Stable quadratic roots: q avoids subtracting nearly equal numbers. Ascending.
fn roots(a: f64, b: f64, c: f64) -> ([f64; 2], usize) {
    if a == 0.0 {
        return if b == 0.0 { ([0.0; 2], 0) } else { ([-c / b, 0.0], 1) };
    }
    let discriminant = b * b - 4.0 * a * c;
    if discriminant < 0.0 {
        return ([0.0; 2], 0);
    }
    let d = discriminant.sqrt();
    let q = -0.5 * (b + if b < 0.0 { -d } else { d });
    if q == 0.0 {
        return ([-b / (2.0 * a), 0.0], 1);
    }
    let (r0, r1) = (q / a, c / q);
    if r0 <= r1 {
        ([r0, r1], 2)
    } else {
        ([r1, r0], 2)
    }
}

/// |d + v t|^2 = (2 r + 2 g t)^2: the entering root, including immediate contact.
fn disc_disc_time(a: &Pose, b: &Pose, va: &Vel, vb: &Vel, radius: f64, growth: f64) -> f64 {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    let vx = va.x - vb.x;
    let vy = va.y - vb.y;
    let qa = vx * vx + vy * vy - 4.0 * growth * growth;
    let qb = 2.0 * (dx * vx + dy * vy - 4.0 * radius * growth);
    let qc = dx * dx + dy * dy - 4.0 * radius * radius;
    if qc <= 0.0 && qb < 0.0 {
        return 0.0;
    }
    // apart and not approaching (the quadratic never falls to zero for t >= 0): no sqrt needed
    if qc > 0.0 && qb >= 0.0 && qa >= 0.0 {
        return f64::INFINITY;
    }
    let (r, count) = roots(qa, qb, qc);
    for &t in &r[..count] {
        if t >= 0.0 && 2.0 * qa * t + qb < 0.0 {
            return t;
        }
    }
    f64::INFINITY
}

/// Outward unit normal n; the centre must satisfy p.n + r <= apothem.
fn disc_edge_time(p: &Pose, v: &Vel, radius: f64, growth: f64, nx: f64, ny: f64, apothem: f64) -> f64 {
    let closing = v.x * nx + v.y * ny + growth;
    if closing <= 0.0 {
        return f64::INFINITY;
    }
    let t = (apothem - p.x * nx - p.y * ny - radius) / closing;
    if t < 0.0 {
        0.0
    } else {
        t
    }
}

/// |p + v t|^2 = (R - r - g t)^2: the exiting root while the available radius is positive.
fn disc_circle_wall_time(p: &Pose, v: &Vel, radius: f64, growth: f64, container_radius: f64) -> f64 {
    let free = container_radius - radius;
    let qa = v.x * v.x + v.y * v.y - growth * growth;
    let qb = 2.0 * (p.x * v.x + p.y * v.y + free * growth);
    let qc = p.x * p.x + p.y * p.y - free * free;
    if qc >= 0.0 && (qb > 0.0 || (qb == 0.0 && qa > 0.0)) {
        return 0.0;
    }
    let (r, count) = roots(qa, qb, qc);
    for &t in &r[..count] {
        if t >= 0.0 && free - growth * t >= 0.0 && 2.0 * qa * t + qb > 0.0 {
            return t;
        }
    }
    // a stationary concentric disc has a double root when it fills the wall
    if growth > 0.0 && v.x == 0.0 && v.y == 0.0 && p.x == 0.0 && p.y == 0.0 {
        free / growth
    } else {
        f64::INFINITY
    }
}

/// n points from b to a. The relative normal speed u becomes 4 g - u.
fn collide_discs(a: &mut Vel, b: &mut Vel, nx: f64, ny: f64, growth: f64) {
    let relative = (a.x - b.x) * nx + (a.y - b.y) * ny;
    let impulse = 2.0 * growth - relative;
    a.x += impulse * nx;
    a.y += impulse * ny;
    b.x -= impulse * nx;
    b.y -= impulse * ny;
}

#[derive(Clone, Copy)]
struct Event {
    time: f64,
    i: i64,
    j: i64,
    edge: i64,
}

/// Stable tie order makes simultaneous contacts reproducible: time, then piece, partner, wall.
#[inline]
fn before(a: &Event, b: &Event) -> bool {
    a.time < b.time || (a.time == b.time && (a.i < b.i || (a.i == b.i && (a.j < b.j || (a.j == b.j && a.edge < b.edge)))))
}

#[inline]
fn offer(best: &mut Option<Event>, e: Event) {
    if best.map_or(true, |b| before(&e, &b)) {
        *best = Some(e);
    }
}

fn two_mut(v: &mut [Vel], i: usize, j: usize) -> (&mut Vel, &mut Vel) {
    debug_assert!(i < j);
    let (lo, hi) = v.split_at_mut(j);
    (&mut lo[i], &mut hi[0])
}

// ---- dynamics (ls_growth/dynamics.ts) ----

/// What the dynamics need of their run: whether to stop, and a cooperative pause point.
trait Host {
    fn stopped(&mut self) -> bool;
    /// False when the method must end.
    fn pause(&mut self) -> bool;
}

impl Host for Ctx<'_> {
    #[inline]
    fn stopped(&mut self) -> bool {
        self.should_stop()
    }
    fn pause(&mut self) -> bool {
        self.checkpoint()
    }
}

struct Advance {
    dt: f64,
    collision: bool,
    failed: bool,
}

const FAILED: Advance = Advance { dt: 0.0, collision: false, failed: true };

/// Signed separation of two congruent pieces, `Shape::sep` with the distance to the nearest
/// multiple of the vertex spacing taken by rounding instead of `%` (the same value; the
/// remainder function is the slowest part of the closed form).
#[inline]
fn pair_sep(shape: &Shape, a: &Pose, b: &Pose) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let d = dx.hypot(dy);
    if shape.n == 0 {
        return d - 2.0 * DISK_RADIUS;
    }
    let step = shape.step;
    let near = |x: f64| (x - step * (x / step).round()).abs();
    let phi = dy.atan2(dx);
    let alpha_a = near(phi - a.theta - shape.normal0);
    let alpha_b = near(phi + PI - b.theta - shape.normal0);
    let rel = a.theta - b.theta + PI + PI / shape.n as f64;
    d * alpha_a.min(alpha_b).cos() - (shape.r + shape.big_r * near(rel).cos())
}

/// First pair of unit-coordinate poses with negative separation.
fn first_overlap(shape: &Shape, grid: &mut NeighborGrid, poses: &[Pose], reach: f64) -> Option<(usize, usize)> {
    let p = poses.len();
    if p <= DIRECT {
        let r2 = reach * reach;
        for i in 0..p {
            for j in i + 1..p {
                let dx = poses[i].x - poses[j].x;
                let dy = poses[i].y - poses[j].y;
                if dx * dx + dy * dy <= r2 && pair_sep(shape, &poses[i], &poses[j]) < 0.0 {
                    return Some((i, j));
                }
            }
        }
        return None;
    }
    grid.build(poses, reach);
    let mut hit = None;
    grid.for_each_pair(poses, |i, j| {
        if pair_sep(shape, &poses[i], &poses[j]) < 0.0 {
            hit = Some((i, j));
            false
        } else {
            true
        }
    });
    hit
}

struct Growth {
    n: u32,
    m: u32,
    /// Poses in the scaled frame (pieces of size `scale`), container centred at the origin.
    pieces: Vec<Pose>,
    vel: Vec<Vel>,
    /// The fixed container (centre at the origin, size in scaled units).
    container: Container,
    scale: f64,
    growth: f64,
    repairs: u64,
    operations: u64,
    /// Relative cost of scanning every piece once (one feasibility probe).
    work: f64,
    initial_energy: f64,
    shape: Shape,
    pair_reach: f64,
    /// Unit-coordinate poses of the last probe, and the poses a polygon step starts from.
    unit: Vec<Pose>,
    base: Vec<Pose>,
    grid: NeighborGrid,
    /// Outward wall normals of a polygon container: angle, cosine and sine of each.
    wall_angle: Vec<f64>,
    wall_cos: Vec<f64>,
    wall_sin: Vec<f64>,
    apothem: f64,
}

impl Growth {
    fn new(
        template: &Config,
        container: Container,
        initial_scale: f64,
        growth: f64,
        speed: f64,
        angular_speed: f64,
        rng: &mut Rng,
    ) -> Self {
        let (n, m) = (template.n, template.m);
        let p = template.pieces.len();
        // the container moves to the origin and the pieces with it
        let pieces: Vec<Pose> = template.pieces.iter().map(|q| Pose::new(q.x - container.cx, q.y - container.cy, q.theta)).collect();
        let container = Container { cx: 0.0, cy: 0.0, ..container };
        let mut vel = Vec::with_capacity(p);
        for _ in 0..p {
            let angle = 2.0 * PI * rng.next();
            let omega = if n == 0 { 0.0 } else { angular_speed * (2.0 * rng.next() - 1.0) };
            vel.push(Vel { x: speed * angle.cos(), y: speed * angle.sin(), omega });
        }
        let initial_energy = vel.iter().map(|v| v.x * v.x + v.y * v.y).sum();
        let wall_angle: Vec<f64> = (0..m as usize).map(|edge| container.phi - PI / 2.0 + (2.0 * PI * edge as f64) / m as f64).collect();
        let wall_cos: Vec<f64> = wall_angle.iter().map(|a| a.cos()).collect();
        let wall_sin: Vec<f64> = wall_angle.iter().map(|a| a.sin()).collect();
        Growth {
            n,
            m,
            pieces,
            vel,
            container,
            scale: initial_scale,
            growth,
            repairs: 0,
            operations: 0,
            work: p as f64 * (1.0 + (n + m) as f64 / 16.0),
            initial_energy,
            shape: Shape::new(n),
            pair_reach: 2.0 * bounding_radius(n),
            unit: vec![Pose::default(); p],
            base: Vec::with_capacity(p),
            grid: NeighborGrid::new(),
            wall_angle,
            wall_cos,
            wall_sin,
            apothem: container_inradius(m),
        }
    }

    fn thermostat(&mut self, factor: f64) -> bool {
        let energy: f64 = self.vel.iter().map(|v| v.x * v.x + v.y * v.y).sum();
        if energy <= factor * self.initial_energy {
            return false;
        }
        let multiplier = (self.initial_energy / energy).sqrt();
        for v in &mut self.vel {
            v.x *= multiplier;
            v.y *= multiplier;
        }
        true
    }

    /// The state as unit pieces (centres divided by the scale), in `cfg`.
    fn config_into(&self, cfg: &mut Config) {
        cfg.n = self.n;
        cfg.m = self.m;
        cfg.phi = self.container.phi;
        cfg.pieces.clear();
        for q in &self.pieces {
            cfg.pieces.push(Pose::new(q.x / self.scale, q.y / self.scale, q.theta));
        }
    }

    /// Fill `unit` with the poses at `scale`; false when a pose is not finite.
    fn fill_unit(&mut self, scale: f64) -> bool {
        let mut finite = true;
        for (u, q) in self.unit.iter_mut().zip(self.pieces.iter()) {
            u.x = q.x / scale;
            u.y = q.y / scale;
            u.theta = q.theta;
            finite &= u.x.is_finite() && u.y.is_finite() && u.theta.is_finite();
        }
        finite
    }

    fn unit_container(&self, scale: f64) -> Container {
        Container { size: self.container.size / scale, ..self.container }
    }

    /// First piece of `unit` protruding through a wall (NaN counts as protruding), with the wall's
    /// outward normal. One scan serves both the feasibility test and the collision it reports, so
    /// that the two never disagree about a contact within rounding.
    fn wall_scan(&self, scale: f64) -> Option<(usize, f64, f64)> {
        let n = self.n;
        let size_u = self.container.size / scale;
        let reach_in = size_u * self.apothem;
        // a piece whose bounding circle stays inside the inscribed circle touches no wall
        let skip = reach_in - bounding_radius(n) - 1e-12 * reach_in.max(1.0);
        let unit_container = self.unit_container(scale);
        for (i, q) in self.unit.iter().enumerate() {
            if q.x.hypot(q.y) <= skip {
                continue;
            }
            if n == 0 && self.m != 0 {
                for (c, s) in self.wall_cos.iter().zip(self.wall_sin.iter()) {
                    let depth = q.x * c + q.y * s + DISK_RADIUS - reach_in;
                    if !(depth <= 0.0) {
                        return Some((i, *c, *s));
                    }
                }
            } else if self.m != 0 {
                // the furthest vertex along a wall normal is the one nearest it in angle
                let a0 = q.theta + PI / 2.0;
                let step = self.shape.step;
                for e in 0..self.wall_angle.len() {
                    let rel = self.wall_angle[e] - a0;
                    let near = rel - step * (rel / step).round();
                    let depth = q.x * self.wall_cos[e] + q.y * self.wall_sin[e] + self.shape.big_r * near.cos() - reach_in;
                    if !(depth <= 0.0) {
                        return Some((i, self.wall_cos[e], self.wall_sin[e]));
                    }
                }
            } else {
                // circle container: every vertex against the circle
                let mut hit = None;
                visit_protrusions(n, q, &unit_container, true, 1.0, 0.0, |pr| {
                    if !(pr.depth <= 0.0) && hit.is_none() {
                        hit = Some((i, pr.px, pr.py));
                    }
                });
                if hit.is_some() {
                    return hit;
                }
            }
        }
        None
    }

    /// No overlap and no wall protrusion with the pieces at `scale`, tested in unit coordinates.
    fn feasible_at(&mut self, scale: f64) -> bool {
        if !(scale > 0.0) || !scale.is_finite() {
            return false;
        }
        if !self.fill_unit(scale) {
            return false;
        }
        if first_overlap(&self.shape, &mut self.grid, &self.unit, self.pair_reach).is_some() {
            return false;
        }
        self.wall_scan(scale).is_none()
    }

    /// Only roundoff-size violations are repaired; substantial missed events end the run.
    fn repair(&mut self, ctx: &mut impl Host) -> bool {
        if self.feasible_at(self.scale) {
            return true;
        }
        let original = self.scale;
        for fraction in [2e-14, 2e-13, 2e-12, 2e-11, 2e-10, 2e-9] {
            if ctx.stopped() {
                return false;
            }
            self.scale = original * (1.0 - fraction);
            if self.feasible_at(self.scale) {
                self.repairs += 1;
                return true;
            }
        }
        self.scale = original;
        false
    }

    fn do_move(&mut self, dt: f64) {
        for (q, v) in self.pieces.iter_mut().zip(self.vel.iter()) {
            q.x += v.x * dt;
            q.y += v.y * dt;
            q.theta += v.omega * dt;
        }
        self.scale += self.growth * dt;
    }

    fn disc_advance(&mut self, ctx: &mut impl Host) -> Advance {
        let p = self.pieces.len();
        let mut vmax = 0.0f64;
        for v in &self.vel {
            vmax = vmax.max(v.x.hypot(v.y));
        }
        // a disk piece scaled by `scale` has radius DISK_RADIUS * scale, growing at DISK_RADIUS * growth
        let radius = self.scale * DISK_RADIUS;
        let radius_growth = self.growth * DISK_RADIUS;
        let horizon = (0.2 * radius) / (vmax + radius_growth);
        // a pair that can collide within the horizon starts within this distance
        let reach = 2.0 * radius + 2.0 * (vmax + radius_growth) * horizon;
        let mut best: Option<Event> = None;
        {
            let pieces = &self.pieces;
            let vel = &self.vel;
            let mut pair = |i: usize, j: usize| {
                let time = disc_disc_time(&pieces[i], &pieces[j], &vel[i], &vel[j], radius, radius_growth);
                if time <= horizon {
                    offer(&mut best, Event { time, i: i as i64, j: j as i64, edge: -1 });
                }
            };
            if p <= DIRECT {
                let r2 = reach * reach;
                for i in 0..p {
                    for j in i + 1..p {
                        let dx = pieces[i].x - pieces[j].x;
                        let dy = pieces[i].y - pieces[j].y;
                        if dx * dx + dy * dy <= r2 {
                            pair(i, j);
                        }
                    }
                }
            } else {
                self.grid.build(pieces, reach);
                self.grid.for_each_pair(pieces, |i, j| {
                    pair(i, j);
                    true
                });
            }
        }
        if self.m == 0 {
            let r = self.container.size / 2.0;
            for i in 0..p {
                let time = disc_circle_wall_time(&self.pieces[i], &self.vel[i], radius, radius_growth, r);
                if time <= horizon {
                    offer(&mut best, Event { time, i: i as i64, j: -1, edge: -1 });
                }
            }
        } else {
            let apothem = self.container.size * self.apothem;
            for i in 0..p {
                for edge in 0..self.m as usize {
                    let time = disc_edge_time(
                        &self.pieces[i],
                        &self.vel[i],
                        radius,
                        radius_growth,
                        self.wall_cos[edge],
                        self.wall_sin[edge],
                        apothem,
                    );
                    if time <= horizon {
                        offer(&mut best, Event { time, i: i as i64, j: -1, edge: edge as i64 });
                    }
                }
            }
        }
        let dt = best.map_or(horizon, |e| e.time);
        self.do_move(dt);
        self.operations += 1;
        if let Some(e) = best {
            self.disc_impulse(&e);
        }
        let valid = self.repair(ctx);
        Advance { dt, collision: best.is_some(), failed: !valid }
    }

    fn disc_impulse(&mut self, event: &Event) {
        let i = event.i as usize;
        if event.j >= 0 {
            let j = event.j as usize;
            let (p, q) = (self.pieces[i], self.pieces[j]);
            let distance = (p.x - q.x).hypot(p.y - q.y);
            let (a, b) = two_mut(&mut self.vel, i, j);
            collide_discs(a, b, (p.x - q.x) / distance, (p.y - q.y) / distance, self.growth * DISK_RADIUS);
        } else {
            let p = self.pieces[i];
            let (nx, ny) = if self.m == 0 {
                let distance = p.x.hypot(p.y);
                if distance == 0.0 {
                    (1.0, 0.0)
                } else {
                    (p.x / distance, p.y / distance)
                }
            } else {
                (self.wall_cos[event.edge as usize], self.wall_sin[event.edge as usize])
            };
            let v = &mut self.vel[i];
            let closing = v.x * nx + v.y * ny + self.growth * DISK_RADIUS;
            // tangency to a curved wall has outward second-order motion; a zero normal impulse
            // cannot resolve it, so create microscopic room for the next event
            if self.m == 0 && closing.abs() <= 1e-14 * 1f64.max(v.x.hypot(v.y)) {
                self.scale *= 1.0 - 2e-14;
                self.repairs += 1;
            }
            let impulse = 2.0 * closing;
            v.x -= impulse * nx;
            v.y -= impulse * ny;
        }
    }

    fn trial(&mut self, scale0: f64, t: f64) {
        self.scale = scale0;
        self.pieces.copy_from_slice(&self.base);
        self.do_move(t);
    }

    /// One polygon step: the largest step keeping the fastest surface point within a fraction of
    /// the piece size, four samples to catch transient contacts, then bisection back to the
    /// contact and an impulse. Four samples are not continuous collision detection: a brief
    /// grazing rotational overlap between samples can be missed.
    fn polygon_step(&mut self, ctx: &mut impl Host, max_step: f64, work: &mut Work) -> Advance {
        let radius = bounding_radius(self.n);
        let mut fastest = f64::NEG_INFINITY;
        for v in &self.vel {
            fastest = fastest.max(v.x.hypot(v.y) + radius * self.scale * v.omega.abs());
        }
        let closing = fastest + radius * self.growth;
        let dt = max_step.min((0.025 * radius * self.scale) / closing);
        self.base.clear();
        self.base.extend_from_slice(&self.pieces);
        let scale0 = self.scale;
        // four substeps reduce transient rotation contacts missed by an endpoint-only test
        let mut low = 0.0;
        let mut high = dt;
        let mut hit = false;
        for sample in 1..=4 {
            if ctx.stopped() {
                return FAILED;
            }
            let t = (dt * sample as f64) / 4.0;
            self.trial(scale0, t);
            let free = self.feasible_at(self.scale);
            if work.due(self.work) && !ctx.pause() {
                return FAILED;
            }
            if !free {
                high = t;
                hit = true;
                break;
            }
            low = t;
        }
        if hit {
            for _ in 0..40 {
                if ctx.stopped() {
                    return FAILED;
                }
                let mid = (low + high) / 2.0;
                self.trial(scale0, mid);
                let free = self.feasible_at(self.scale);
                if work.due(self.work) && !ctx.pause() {
                    return FAILED;
                }
                if free {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            // what blocks at the infeasible end identifies the collision
            self.trial(scale0, high);
            let scale = self.scale;
            let pair = if self.fill_unit(scale) { first_overlap(&self.shape, &mut self.grid, &self.unit, self.pair_reach) } else { None };
            let wall = if pair.is_none() { self.wall_scan(scale) } else { None };
            self.trial(scale0, low);
            if let Some((i, j)) = pair {
                let contact = piece_separation(self.n, &self.pieces[i], &self.pieces[j], self.scale);
                let (a, b) = two_mut(&mut self.vel, i, j);
                let relative = (a.x - b.x) * contact.nx + (a.y - b.y) * contact.ny;
                // at zero growth the equal-mass central impulse conserves translation energy and
                // momentum; rotation is reflected separately, without torque
                if relative < 2.0 * radius * self.growth {
                    collide_discs(a, b, contact.nx, contact.ny, radius * self.growth);
                }
                a.omega = -a.omega;
                b.omega = -b.omega;
            } else if let Some((i, nx, ny)) = wall {
                let v = &mut self.vel[i];
                let normal = v.x * nx + v.y * ny;
                if normal + radius * self.growth > 0.0 {
                    let impulse = 2.0 * (normal + radius * self.growth);
                    v.x -= impulse * nx;
                    v.y -= impulse * ny;
                }
                v.omega = -v.omega;
            }
            // locating the contact scanned the pieces about twice more
            if work.due(2.0 * self.work) && !ctx.pause() {
                return FAILED;
            }
        }
        self.operations += 1;
        let valid = self.repair(ctx);
        Advance { dt: if hit { low } else { dt }, collision: hit, failed: !valid }
    }
}

// ---- starts ----

/// Container of the pieces at their stored orientation, with outward room against rounding: the
/// shared enclosure can round inward, and free room is better than accepting protrusion.
fn strict_enclose(config: &Config, phi: f64) -> Container {
    let c = enclose(config.n, &config.pieces, config.m, phi);
    let wall = container_inradius(config.m);
    Container { size: c.size + (2e-13 * c.size.max(1.0)) / wall, ..c }
}

enum Loose {
    Done(Config),
    /// The time reserve was reached during preparation.
    Late,
    /// A checkpoint ended the method.
    Abort,
}

/// Late in a time-limited run whose start is not yet assessed: the last 25 ms of the allowance
/// (half of a shorter one). Reads the clock, so it only ever acts on runs the time budget ends.
#[inline]
fn is_late(ctx: &mut Ctx, timed: bool, reserve: f64) -> bool {
    timed && ctx.remaining().1 <= reserve
}

/// Random sequential addition inside a roomy enclosure (the loose jittered grid, enclosed and
/// widened by 30 %), at most 256 trials per piece; failure falls back to the jittered grid.
fn random_loose(ctx: &mut Ctx, work: &mut Work, timed: bool, reserve: f64) -> Loose {
    let problem = ctx.problem;
    let (n, m, p) = (problem.n, problem.m, problem.p);
    let fallback = scatter(problem, || ctx.rng.next());
    let mut bx = strict_enclose(&fallback, fallback.phi);
    bx.size *= 1.3;
    let reach = if m == 0 { bx.size / 2.0 } else { bx.size / (2.0 * (PI / m as f64).sin()) };
    let shape = Shape::new(n);
    // placed pieces in a cell grid of side twice the bounding radius: a new piece can only meet
    // the 3x3 block around it
    let cell = 2.0 * bounding_radius(n);
    let x0 = bx.cx - reach;
    let y0 = bx.cy - reach;
    let cols = (((2.0 * reach) / cell).floor() + 1.0).clamp(1.0, 4096.0) as i64;
    let mut head = vec![-1i32; (cols * cols) as usize];
    let mut next = vec![-1i32; p];
    let mut pieces: Vec<Pose> = Vec::with_capacity(p);
    let cell_of = |v: f64, v0: f64| (((v - v0) / cell).floor() as i64).clamp(0, cols - 1);
    for i in 0..p {
        let mut placed = false;
        for _trial in 0..256 {
            if ctx.should_stop() {
                return Loose::Done(fallback);
            }
            let q = Pose::new(
                bx.cx + reach * (2.0 * ctx.rng.next() - 1.0),
                bx.cy + reach * (2.0 * ctx.rng.next() - 1.0),
                if n == 0 { 0.0 } else { 2.0 * PI * ctx.rng.next() },
            );
            let mut inside = true;
            visit_protrusions(n, &q, &bx, true, 1.0, 0.0, |pr| {
                if pr.depth > 0.0 {
                    inside = false;
                }
            });
            let mut scanned = 1.0;
            let mut blocked = !inside;
            if inside {
                let (cx, cy) = (cell_of(q.x, x0), cell_of(q.y, y0));
                'scan: for gy in (cy - 1).max(0)..=(cy + 1).min(cols - 1) {
                    for gx in (cx - 1).max(0)..=(cx + 1).min(cols - 1) {
                        let mut k = head[(gy * cols + gx) as usize];
                        while k >= 0 {
                            scanned += 1.0;
                            if pair_sep(&shape, &pieces[k as usize], &q) < 0.0 {
                                blocked = true;
                                break 'scan;
                            }
                            k = next[k as usize];
                        }
                    }
                }
            }
            if is_late(ctx, timed, reserve) {
                return Loose::Late;
            }
            if work.due(scanned) && !ctx.checkpoint() {
                return Loose::Abort;
            }
            if blocked {
                continue;
            }
            let c = (cell_of(q.y, y0) * cols + cell_of(q.x, x0)) as usize;
            next[i] = head[c];
            head[c] = i as i32;
            pieces.push(q);
            placed = true;
            break;
        }
        if !placed {
            return Loose::Done(fallback);
        }
    }
    Loose::Done(Config { n, m, pieces, phi: 0.0 })
}

fn is_valid(tester: &mut PairTester, config: Option<&Config>, p: usize) -> bool {
    config.map_or(false, |c| c.pieces.len() == p && !tester.any_below(&c.pieces, 0.0))
}

/// Assess the jitter-free grid once; its score when valid.
fn insure(ctx: &mut Ctx, seen: &mut Seen, grid: &Config, score: &mut Option<f64>) -> bool {
    if score.is_none() {
        seen.remember(config_key(grid));
        if let Some(e) = ctx.evaluate(grid, false) {
            if e.valid {
                *score = e.score;
            }
        }
    }
    score.is_some()
}

/// The assessments of the growth runs: the best state, duplicate suppression and the
/// stagnation count of the running run.
struct Track {
    seen: Seen,
    best: Config,
    best_score: f64,
    cfg: Config,
    assessments: u32,
    stagnant: u32,
    run_best: f64,
}

impl Track {
    /// Assess the current state as unit pieces; false ends the run.
    fn submit(&mut self, ctx: &mut Ctx, state: &mut Growth) -> bool {
        if ctx.should_stop() {
            return false;
        }
        state.config_into(&mut self.cfg);
        // division into unit coordinates can round a scaled non-negative contact negative;
        // shrinking the pieces uniformly fixes that without moving centres
        for _ in 0..8 {
            if first_overlap(&state.shape, &mut state.grid, &self.cfg.pieces, state.pair_reach).is_none() {
                break;
            }
            state.scale *= 1.0 - 2e-13;
            state.repairs += 1;
            state.config_into(&mut self.cfg);
        }
        if first_overlap(&state.shape, &mut state.grid, &self.cfg.pieces, state.pair_reach).is_some()
            || !state.feasible_at(state.scale)
            || self.cfg.pieces.iter().any(|q| q.x.abs() > MAX_COORD || q.y.abs() > MAX_COORD)
        {
            return false;
        }
        let key = config_key(&self.cfg);
        if self.seen.contains(key) {
            return true;
        }
        self.seen.remember(key);
        let eval = match ctx.evaluate(&self.cfg, false) {
            Some(e) if e.valid => e,
            _ => return false,
        };
        self.assessments += 1;
        let score = eval.score.unwrap_or(f64::INFINITY);
        let reference = if self.run_best.is_finite() { self.run_best } else { 1.0 };
        if score < self.run_best - 1e-9 * 1f64.max(reference) {
            self.stagnant = 0;
        } else {
            self.stagnant += 1;
        }
        self.run_best = self.run_best.min(score);
        if score < self.best_score {
            self.best_score = score;
            self.best = self.cfg.clone();
        }
        true
    }
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
    let (allow_evals, allow_time) = ctx.remaining();
    // Every key belongs to one counted assessment, so an evaluation budget already bounds this
    // set. Only a run with unlimited evaluations forgets its oldest keys.
    let seen_limit = if allow_evals.is_finite() { usize::MAX } else { 256usize.max((262144.0 / p as f64).ceil() as usize) };
    let mut seen = Seen::new(seen_limit);
    let mut tester = PairTester::new(n);
    let mut work = Work::default();
    let has_start = ctx.start().is_some();
    let mut best: Option<Config> = ctx.start().cloned();
    if let Some(b) = &best {
        seen.remember(config_key(b));
    }
    let initial_valid = ctx.initial_evaluation().map_or(false, |e| e.valid);
    let initial_score = ctx.initial_evaluation().and_then(|e| e.score);
    let mut best_score = if is_valid(&mut tester, best.as_ref(), p) && initial_valid { initial_score.unwrap_or(f64::INFINITY) } else { f64::INFINITY };

    if !is_valid(&mut tester, best.as_ref(), p) {
        // The framework assesses nothing once the time budget has expired or stop was requested,
        // so a start still being prepared at that moment would leave the run with no
        // configuration. A jitter-free grid needs no search and no seeded draw, and is assessed
        // while that is still allowed: at once when evaluations are unlimited. Under an
        // evaluation budget one more assessment would shift every later count, so the grid
        // replaces the start only when preparation reaches the last 25 ms of the time budget,
        // where that budget ends the run anyway.
        let timed = !initial_valid && allow_time.is_finite();
        let reserve = (allow_time / 2.0).min(0.025);
        let grid = scatter(problem, || 0.5);
        let mut grid_score: Option<f64> = None;
        if timed && !allow_evals.is_finite() && !insure(ctx, &mut seen, &grid, &mut grid_score) {
            return;
        }
        // repair the supplied start locally, avoiding a duplicate start assessment
        if best.as_ref().map_or(false, |b| b.pieces.len() == p) {
            let b = best.take().unwrap();
            let repaired = restore(ctx, &b, Strategy::Separate, true, COORD_LIMIT, &mut tester, None);
            best = if is_late(ctx, timed, reserve) { None } else { repaired };
        }
        if !is_valid(&mut tester, best.as_ref(), p) && !has_start && params.initialization == "seed" && !is_late(ctx, timed, reserve) {
            let slice = (params.seed_evals as f64).min(3f64.max((ctx.remaining().0 / 10.0).floor()));
            let seeded = ctx.run(Method::Seed, &serde_json::json!({ "kind": "auto" }), None, Some(slice as u64), None);
            best = seeded.found.or(seeded.best);
            if is_valid(&mut tester, best.as_ref(), p) {
                best_score = seeded.found_score.or(seeded.score).unwrap_or(f64::INFINITY);
                seen.remember(config_key(best.as_ref().unwrap()));
            }
        }
        if !is_valid(&mut tester, best.as_ref(), p) {
            best = None;
            match random_loose(ctx, &mut work, timed, reserve) {
                Loose::Abort => return,
                Loose::Late => {}
                Loose::Done(c) => best = Some(c),
            }
        }
        if ctx.should_stop() {
            return;
        }
        match best.as_ref() {
            None => {
                // preparation ran into the reserve: continue from the assessed grid
                if !insure(ctx, &mut seen, &grid, &mut grid_score) {
                    return;
                }
                best_score = grid_score.unwrap_or(f64::INFINITY);
                best = Some(grid);
            }
            Some(b) => {
                let key = config_key(b);
                if !seen.contains(key) {
                    seen.remember(key);
                    match ctx.evaluate(b, false) {
                        Some(e) if e.valid => best_score = best_score.min(e.score.unwrap_or(f64::INFINITY)),
                        _ => return,
                    }
                }
            }
        }
    }
    if !is_valid(&mut tester, best.as_ref(), p) || ctx.should_stop() {
        return;
    }
    let mut track = Track {
        seen,
        best: best.unwrap(),
        best_score,
        cfg: Config { n, m: problem.m, pieces: Vec::with_capacity(p), phi: 0.0 },
        assessments: 0,
        stagnant: 0,
        run_best: f64::INFINITY,
    };
    let runs = params.runs as usize;
    for run in 0..runs {
        if !ctx.checkpoint() {
            return;
        }
        let tight = strict_enclose(&track.best, track.best.phi);
        let shrink = if run == 0 { params.initial_shrink } else { params.restart_shrink };
        let mut state = Growth::new(&track.best, tight, 1.0 - shrink, params.growth_rate, params.initial_speed, params.angular_speed, &mut ctx.rng);
        track.assessments = 0;
        track.stagnant = 0;
        track.run_best = f64::INFINITY;
        let mut tiny = 0u32;
        let mut flight_time = 0.0;
        let remaining = ctx.remaining().0;
        let slice = if remaining.is_finite() { 1f64.max((remaining / (runs - run) as f64).floor()) } else { f64::INFINITY };
        while !ctx.should_stop() {
            let advance = if n == 0 {
                // a disk event sweeps the pairs, the walls and one repair probe
                if work.due(3.0 * state.work) && !ctx.checkpoint() {
                    break;
                }
                state.disc_advance(ctx)
            } else {
                state.polygon_step(ctx, params.max_step, &mut work)
            };
            if advance.failed {
                break;
            }
            state.thermostat(params.energy_factor);
            flight_time += advance.dt;
            if advance.collision {
                tiny = if params.growth_rate * flight_time / state.scale < params.jam_threshold { tiny + 1 } else { 0 };
                flight_time = 0.0;
            }
            let jammed = tiny >= params.jam_window;
            if (state.operations % params.evaluation_interval as u64 == 0 || jammed) && !track.submit(ctx, &mut state) {
                break;
            }
            if jammed {
                break;
            }
            if track.assessments as f64 >= slice || track.stagnant >= params.stagnation_evaluations {
                break;
            }
        }
        if !ctx.should_stop() && state.feasible_at(state.scale) {
            track.submit(ctx, &mut state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quadratic_roots_are_ascending() {
        let (r, c) = roots(1.0, -3.0, 2.0);
        assert_eq!(c, 2);
        assert!((r[0] - 1.0).abs() < 1e-12 && (r[1] - 2.0).abs() < 1e-12);
        assert_eq!(roots(0.0, 0.0, 1.0).1, 0);
        assert_eq!(roots(1.0, 0.0, 1.0).1, 0);
    }

    #[test]
    fn approaching_discs_meet_at_the_expected_time() {
        let a = Pose::new(0.0, 0.0, 0.0);
        let b = Pose::new(3.0, 0.0, 0.0);
        let va = Vel { x: 1.0, y: 0.0, omega: 0.0 };
        let vb = Vel { x: -1.0, y: 0.0, omega: 0.0 };
        // gap 3 - 2 radius(1) = 1 closing at 2
        let t = disc_disc_time(&a, &b, &va, &vb, 1.0, 0.0);
        assert!((t - 0.5).abs() < 1e-12, "{t}");
        assert_eq!(disc_disc_time(&a, &b, &vb, &va, 1.0, 0.0), f64::INFINITY);
    }

    #[test]
    fn rounded_separation_equals_the_closed_form() {
        let mut rng = Rng::new(9);
        for &n in &[0u32, 3, 4, 5, 8, 12, 30] {
            let shape = Shape::new(n);
            for _ in 0..2000 {
                let a = Pose::new(2.0 * rng.next(), 2.0 * rng.next(), 20.0 * rng.next() - 10.0);
                let b = Pose::new(2.0 * rng.next(), 2.0 * rng.next(), 20.0 * rng.next() - 10.0);
                assert!((pair_sep(&shape, &a, &b) - shape.sep(&a, &b)).abs() < 1e-12);
            }
        }
    }

    struct Free;

    impl Host for Free {
        fn stopped(&mut self) -> bool {
            false
        }
        fn pause(&mut self) -> bool {
            true
        }
    }

    /// The dynamics from the jitter-free grid (default growth, speeds and thermostat, initial
    /// scale 0.8) follow those of packages/solver/src/methods/ls_growth/dynamics.ts: the scale
    /// after a number of operations, from the reference at the same start and seed.
    #[test]
    fn dynamics_follow_the_reference_trajectory() {
        // (N, M, P, seed, operations, scale of the reference, tolerance)
        let cases: [(u32, u32, usize, u32, u32, f64, f64); 7] = [
            (0, 4, 30, 1, 300, 0.8530543710, 2e-10),
            (0, 0, 40, 3, 300, 0.8572803688, 2e-10),
            (5, 5, 20, 2, 300, 0.8312876562884013, 1e-10),
            (4, 4, 17, 1, 1000, 0.8738685799089297, 1e-10),
            (3, 6, 20, 5, 800, 0.8495310781484793, 1e-10),
            (7, 0, 30, 3, 600, 0.8695307362073798, 1e-10),
            (12, 4, 20, 7, 600, 0.8970035742394085, 1e-10),
        ];
        for (n, m, p, seed, ops, want, tolerance) in cases {
            let problem = crate::shapes::Problem::new(n, m, p);
            let grid = scatter(problem, || 0.5);
            let tight = strict_enclose(&grid, grid.phi);
            let mut rng = Rng::new(seed);
            let mut state = Growth::new(&grid, tight, 0.8, 0.01, 1.0, 0.3, &mut rng);
            let mut work = Work::default();
            for _ in 0..ops {
                let advance = if n == 0 { state.disc_advance(&mut Free) } else { state.polygon_step(&mut Free, 0.02, &mut work) };
                assert!(!advance.failed, "n={n} m={m} p={p}: a step failed");
                state.thermostat(4.0);
            }
            assert!((state.scale - want).abs() < tolerance, "n={n} m={m} p={p}: scale {} against the reference {want}", state.scale);
        }
    }

    #[test]
    fn wall_test_equals_the_shared_protrusions() {
        let mut rng = Rng::new(21);
        let (mut inside, mut outside) = (0, 0);
        for &(n, m) in &[(0u32, 4u32), (0, 0), (0, 7), (3, 5), (4, 4), (6, 3), (5, 0), (9, 6), (30, 4)] {
            for _ in 0..600 {
                let phi = 6.0 * rng.next();
                let container = Container { m, cx: 0.0, cy: 0.0, phi, size: 4.0 };
                let template = Config { n, m, pieces: vec![Pose::new(0.0, 0.0, 0.0)], phi };
                let mut state = Growth::new(&template, container, 1.0, 0.01, 1.0, 0.3, &mut rng);
                let (x, y, t) = (2.6 * rng.signed(), 2.6 * rng.signed(), 7.0 * rng.signed());
                state.pieces[0] = Pose::new(x, y, t);
                state.fill_unit(1.0);
                let got = state.wall_scan(1.0).is_none();
                let mut want = true;
                visit_protrusions(n, &state.unit[0], &state.unit_container(1.0), true, 1.0, 0.0, |pr| {
                    if !(pr.depth <= 0.0) {
                        want = false;
                    }
                });
                // a disagreement is allowed only within rounding of the wall
                if got != want {
                    let mut margin = f64::INFINITY;
                    visit_protrusions(n, &state.unit[0], &state.unit_container(1.0), true, 1.0, 0.0, |pr| margin = margin.min(pr.depth.abs()));
                    assert!(margin < 1e-9, "n={n} m={m}: got {got}, want {want}, margin {margin}");
                }
                if want {
                    inside += 1;
                } else {
                    outside += 1;
                }
            }
        }
        assert!(inside > 200 && outside > 200, "{inside} inside, {outside} outside");
    }

    /// Runs of the method on small problems: strictly valid, reproducible from the seed under an
    /// evaluation budget, and never below the area bound.
    #[test]
    fn runs_are_strict_and_reproducible() {
        use crate::clock::ClockKind;
        use crate::framework::{run, Budget, Control, RunOptions};
        use crate::shapes::{area_lower_bound, Problem};
        for &(n, m, p) in &[(0u32, 4u32, 10usize), (0, 0, 12), (0, 6, 7), (4, 4, 6), (3, 0, 8), (5, 5, 6)] {
            let go = |seed: u32| {
                let control = Control::new();
                run(
                    Problem::new(n, m, p),
                    RunOptions {
                        method: Method::LsGrowth,
                        params: Value::Null,
                        start: None,
                        budget: Budget { evals: Some(120), time_s: Some(60.0) },
                        seed,
                        final_polish: false,
                        control: &control,
                        clock: ClockKind::ThreadCpu,
                    },
                )
            };
            let (a, b) = (go(3), go(3));
            assert!(a.valid && a.strict, "n={n} m={m} p={p}: {:?}", a.reasons);
            assert_eq!(a.score, b.score, "n={n} m={m} p={p}: not reproducible");
            assert_eq!(a.evaluations, b.evaluations);
            assert!(a.score.unwrap() >= area_lower_bound(n, m, p) * (1.0 - 1e-9));
        }
    }

    #[test]
    fn rejects_out_of_range_parameters() {
        assert!(resolve(&serde_json::json!({"growthRate": 0.0})).is_err());
        assert!(resolve(&serde_json::json!({"initialization": "bogus"})).is_err());
        assert!(resolve(&serde_json::json!({"nope": 1})).is_err());
        assert!(resolve(&Value::Null).is_ok());
    }
}
