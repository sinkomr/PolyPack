//! Shape continuation (packages/solver/src/methods/morph.ts, morph/local.ts and morph/shapes.ts).
//!
//! Carry a packing from an easy soft shape to the true polygon. For the rounded path the piece at
//! stage t is the Minkowski sum t P (+) disc((1 - t) r) of the polygon P with a disk (r the
//! inradius for the inscribed family, the circumradius for the circumscribed one): a disk at t = 0
//! and P at t = 1. For squares the superellipse path |x|^p + |y|^p <= (1/2)^p, sampled as a
//! polygon, runs hard-particle Monte Carlo stages before the exact square. Each stage rescales the
//! arrangement homothetically to first contact of the next shape, then compresses it with the
//! analytic penalty solve (or Monte Carlo); only true-shape arrangements, restored by uniform
//! expansion, are assessed.

use super::common::{dilate, restore, scatter, PairTester, Strategy};
use super::lbfgs::{Lbfgs, Options, Status};
use super::penalty_method::{pack_state, unpack_into, Cap, Descent, PenaltyObjective, Submit};
use super::{fill, params_of, Method};
use crate::enclose::{convex_hull, enclose_set, extreme_points, PointSet};
use crate::framework::Ctx;
use crate::penalty::{pair_penetration, visit_protrusions};
use crate::shapes::{bounding_radius, circumradius, container_inradius, inradius, Config, Container, Pose, MAX_COORD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::f64::consts::{PI, SQRT_2};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub path: String,
    pub family: String,
    pub local_method: String,
    pub stages: u32,
    pub spacing: f64,
    pub adaptive: bool,
    pub residual_threshold: f64,
    pub max_exponent: f64,
    pub vertices: u32,
    pub inner_iterations: u32,
    pub outer_iterations: u32,
    pub initial_weight: f64,
    pub jitter: f64,
    pub mc_sweeps: u32,
    pub translation_step: f64,
    pub rotation_step: f64,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            path: "rounded".into(),
            family: "inscribed".into(),
            local_method: "penalty".into(),
            stages: 7,
            spacing: 1.0,
            adaptive: true,
            residual_threshold: 0.02,
            max_exponent: 32.0,
            vertices: 64,
            inner_iterations: 120,
            outer_iterations: 6,
            initial_weight: 10.0,
            jitter: 0.03,
            mc_sweeps: 2000,
            translation_step: 0.1,
            rotation_step: 0.1,
        }
    }
}

impl Params {
    pub fn check(&self) -> Result<(), String> {
        fn within(name: &str, v: f64, lo: f64, hi: f64) -> Result<(), String> {
            if (lo..=hi).contains(&v) {
                Ok(())
            } else {
                Err(format!("{name} must be in [{lo}, {hi}]"))
            }
        }
        if self.path != "rounded" && self.path != "superellipse" {
            return Err("path must be rounded or superellipse".into());
        }
        if self.family != "inscribed" && self.family != "circumscribed" {
            return Err("family must be inscribed or circumscribed".into());
        }
        if self.local_method != "penalty" && self.local_method != "mc_compress" {
            return Err("localMethod must be penalty or mc_compress".into());
        }
        within("stages", self.stages as f64, 2.0, 64.0)?;
        within("spacing", self.spacing, 0.25, 4.0)?;
        within("residualThreshold", self.residual_threshold, 0.0, 1.0)?;
        within("maxExponent", self.max_exponent, 2.0, 128.0)?;
        within("vertices", self.vertices as f64, 16.0, 256.0)?;
        within("innerIterations", self.inner_iterations as f64, 1.0, 2000.0)?;
        within("outerIterations", self.outer_iterations as f64, 1.0, 30.0)?;
        within("initialWeight", self.initial_weight, 0.001, 1e8)?;
        within("jitter", self.jitter, 0.0, 0.5)?;
        within("mcSweeps", self.mc_sweeps as f64, 1.0, 20000.0)?;
        within("translationStep", self.translation_step, 0.000001, 0.5)?;
        within("rotationStep", self.rotation_step, 0.000001, 0.5)
    }
}

pub fn resolve(given: &Value) -> Result<Value, String> {
    let (v, p) = fill::<Params>(given)?;
    p.check()?;
    Ok(v)
}

// ---------------------------------------------------------------------------------------------
// shapes

/// The soft piece of a stage: the polygon core scaled by `scale` and dilated by a disk of radius
/// `padding`; or, with `p`, the square superellipse sampled at `vertices` polar angles.
#[derive(Clone, Copy, Debug)]
struct MorphShape {
    scale: f64,
    padding: f64,
    p: Option<f64>,
    vertices: usize,
}

fn rounded_shape(n: u32, t: f64, inscribed: bool) -> MorphShape {
    MorphShape {
        scale: if n == 0 { 1.0 } else { t },
        padding: if n == 0 { 0.0 } else { (1.0 - t) * if inscribed { inradius(n) } else { circumradius(n) } },
        p: None,
        vertices: 64,
    }
}

/// Vertices of the sampled superellipse relative to the piece centre. The unit square's axes are
/// theta + pi/4 under the vertex-up convention. Uniform polar angles: the boundary speed is at
/// most 1 for every p >= 2, so the polygon lies within pi/K (Hausdorff) of the curve.
fn super_rel(theta: f64, p: f64, count: usize, out: &mut [f64]) {
    let (s, c) = (theta + PI / 4.0).sin_cos();
    for k in 0..count {
        let (uy, ux) = (2.0 * PI * k as f64 / count as f64).sin_cos();
        let radius = 0.5 / (ux.abs().powf(p) + uy.abs().powf(p)).powf(1.0 / p);
        let (x, y) = (radius * ux, radius * uy);
        out[2 * k] = c * x - s * y;
        out[2 * k + 1] = s * x + c * y;
    }
}

/// Separating-axis gap of two convex counter-clockwise polygons given by vertices relative to
/// their reference points `apos` and `bpos` (the reference polygonSeparation, O(|a| |b|)).
fn polygon_gap(a: &[f64], apos: (f64, f64), b: &[f64], bpos: (f64, f64)) -> f64 {
    let mut best = f64::NEG_INFINITY;
    for pass in 0..2 {
        let (p, q) = if pass == 0 { (a, b) } else { (b, a) };
        let delta = if pass == 0 { (bpos.0 - apos.0, bpos.1 - apos.1) } else { (apos.0 - bpos.0, apos.1 - bpos.1) };
        let np = p.len() / 2;
        let nq = q.len() / 2;
        for i in 0..np {
            let j = (i + 1) % np;
            let (px, py) = (p[2 * i], p[2 * i + 1]);
            let ex = p[2 * j] - px;
            let ey = p[2 * j + 1] - py;
            let len = ex.hypot(ey);
            // outward normal of a counter-clockwise edge
            let ux = ey / len;
            let uy = -ex / len;
            let shift = delta.0 * ux + delta.1 * uy - (px * ux + py * uy);
            let mut m = f64::INFINITY;
            for k in 0..nq {
                let d = q[2 * k] * ux + q[2 * k + 1] * uy + shift;
                if d < m {
                    m = d;
                }
            }
            if m > best {
                best = m;
            }
        }
    }
    best
}

/// A hash of a configuration's poses (angles of disks and the container angle of a circle are
/// not part of the packing), standing in for the reference's exact string signature.
fn signature(c: &Config) -> (u64, u64) {
    let mut a: u64 = 0xcbf29ce484222325;
    let mut b: u64 = 0x9e3779b97f4a7c15;
    let mut feed = |v: f64| {
        let bits = if v == 0.0 { 0u64 } else { v.to_bits() };
        a = (a ^ bits).wrapping_mul(0x100000001b3);
        a ^= a >> 29;
        b = (b.rotate_left(23) ^ bits).wrapping_mul(0xff51afd7ed558ccd);
        b ^= b >> 31;
    };
    for p in &c.pieces {
        feed(p.x);
        feed(p.y);
        if c.n != 0 {
            feed(p.theta);
        }
    }
    feed(if c.m == 0 { 0.0 } else { c.phi });
    (a, b)
}

fn hash_vector(x: &[f64]) -> (u64, u64) {
    let mut a: u64 = 0xcbf29ce484222325;
    let mut b: u64 = 0x9e3779b97f4a7c15;
    for v in x {
        let bits = if *v == 0.0 { 0u64 } else { v.to_bits() };
        a = (a ^ bits).wrapping_mul(0x100000001b3);
        a ^= a >> 29;
        b = (b.rotate_left(23) ^ bits).wrapping_mul(0xff51afd7ed558ccd);
        b ^= b >> 31;
    }
    (a, b)
}

// ---------------------------------------------------------------------------------------------
// the method state

struct Morph {
    params: Params,
    n: u32,
    m: u32,
    p: usize,
    tester: PairTester,
    seen: HashSet<(u64, u64)>,
    raw_seen: HashSet<(u64, u64)>,
    /// The working configuration of a penalty stage, kept up to date by accepted iterates.
    config: Config,
    cap: Cap,
    /// Superellipse vertices of every piece relative to its centre, P x vertices x 2.
    rel: Vec<f64>,
    trial_rel: Vec<f64>,
    scratch: Vec<f64>,
}

impl Morph {
    /// Offer a raw state: repair it by expansion to a true-shape arrangement and assess it once.
    fn submit_config(&mut self, ctx: &mut Ctx, trial: &Config) -> bool {
        if ctx.should_stop() {
            return false;
        }
        if !self.raw_seen.insert(signature(trial)) {
            return true;
        }
        let Some(repaired) = restore(ctx, trial, Strategy::Expand, true, MAX_COORD, &mut self.tester, None) else {
            return !ctx.should_stop();
        };
        if self.tester.any_below(&repaired.pieces, 0.0) {
            return !ctx.should_stop();
        }
        if !self.seen.insert(signature(&repaired)) {
            return true;
        }
        ctx.evaluate(&repaired, false).is_some()
    }

    fn fill_rel(&mut self, pieces: &[Pose], shape: &MorphShape) {
        if let Some(p) = shape.p {
            let width = 2 * shape.vertices;
            self.rel.resize(self.p * width, 0.0);
            for (i, q) in pieces.iter().enumerate() {
                super_rel(q.theta, p, shape.vertices, &mut self.rel[i * width..(i + 1) * width]);
            }
        }
    }

    /// Gap of two pieces in this shape: negative when they overlap.
    fn gap(&self, a: &Pose, b: &Pose, ia: usize, ib: usize, shape: &MorphShape) -> f64 {
        if shape.p.is_some() {
            let w = 2 * shape.vertices;
            polygon_gap(&self.rel[ia * w..(ia + 1) * w], (a.x, a.y), &self.rel[ib * w..(ib + 1) * w], (b.x, b.y))
        } else {
            -pair_penetration(&self.tester.shape, a, b, shape.scale, shape.padding).depth
        }
    }

    /// No pair of the shape overlaps (superellipse caches `rel` must match the angles).
    fn is_clear(&mut self, pieces: &[Pose], shape: &MorphShape) -> bool {
        let reach = if shape.p.is_none() { 2.0 * (bounding_radius(self.n) * shape.scale + shape.padding) } else { SQRT_2 };
        self.tester.grid.build(pieces, reach);
        let mut clear = true;
        let this = &*self;
        this.tester.grid.for_each_pair(pieces, |i, j| {
            if this.gap(&pieces[i], &pieces[j], i, j, shape) < 0.0 {
                clear = false;
                return false;
            }
            true
        });
        clear
    }

    /// The smallest container of the shape's arrangement, with a rounding margin.
    fn enclose(&mut self, pieces: &[Pose], phi: f64, shape: &MorphShape) -> Container {
        let set = if let Some(p) = shape.p {
            let count = shape.vertices;
            self.scratch.clear();
            for q in pieces {
                let at = self.scratch.len();
                self.scratch.resize(at + 2 * count, 0.0);
                super_rel(q.theta, p, count, &mut self.scratch[at..]);
                for k in 0..count {
                    self.scratch[at + 2 * k] += q.x;
                    self.scratch[at + 2 * k + 1] += q.y;
                }
            }
            PointSet { pts: convex_hull(&self.scratch), pad: 0.0 }
        } else {
            let mut set = extreme_points(self.n, pieces, shape.scale);
            set.pad += shape.padding;
            set
        };
        let mut c = enclose_set(&set, self.m, phi);
        c.size += 2e-12 * c.size.max(1.0) / container_inradius(self.m);
        c
    }

    /// Whether the shape at `pose` (with superellipse vertices `rel`) lies inside the container.
    fn contained(&self, pose: &Pose, rel: &[f64], container: &Container, shape: &MorphShape) -> bool {
        if shape.p.is_none() {
            let mut valid = true;
            visit_protrusions(self.n, pose, container, true, shape.scale, shape.padding, |pr| {
                if !pr.depth.is_finite() || pr.depth > 0.0 {
                    valid = false;
                }
            });
            return valid;
        }
        let apothem = container_inradius(container.m);
        for k in 0..rel.len() / 2 {
            let dx = rel[2 * k] + pose.x - container.cx;
            let dy = rel[2 * k + 1] + pose.y - container.cy;
            if container.m == 0 {
                if dx.hypot(dy) > container.size * apothem {
                    return false;
                }
            } else {
                for edge in 0..container.m {
                    let a = container.phi - PI / 2.0 + 2.0 * PI * edge as f64 / container.m as f64;
                    if dx * a.cos() + dy * a.sin() > container.size * apothem {
                        return false;
                    }
                }
            }
        }
        true
    }

    /// Homothety about the mean centre to the first contact of the shape: feasibility is monotone
    /// in the factor because the Minkowski difference of two convex shapes contains zero.
    fn rescale(&mut self, ctx: &mut Ctx, config: &Config, shape: &MorphShape) -> Option<Config> {
        self.fill_rel(&config.pieces, shape);
        let count = config.pieces.len() as f64;
        let cx = config.pieces.iter().map(|q| q.x).sum::<f64>() / count;
        let cy = config.pieces.iter().map(|q| q.y).sum::<f64>() / count;
        let mut work = config.clone();
        let clear = |this: &mut Morph, ctx: &mut Ctx, work: &mut Config, factor: f64| -> Option<bool> {
            for (w, b) in work.pieces.iter_mut().zip(config.pieces.iter()) {
                w.x = cx + factor * (b.x - cx);
                w.y = cy + factor * (b.y - cy);
            }
            let free = this.is_clear(&work.pieces, shape);
            if !ctx.checkpoint() {
                None
            } else {
                Some(free)
            }
        };
        let mut low = 0.0;
        let mut high = 1.0;
        while !clear(self, ctx, &mut work, high)? {
            if high > 1e6 {
                return None;
            }
            low = high;
            high *= 2.0;
        }
        for _ in 0..40 {
            let mid = (low + high) / 2.0;
            if clear(self, ctx, &mut work, mid)? {
                high = mid;
            } else {
                low = mid;
            }
        }
        if clear(self, ctx, &mut work, high * (1.0 + 2e-12))? {
            Some(work)
        } else {
            None
        }
    }

    /// Analytic augmented penalty solves on the shape, as many as the stage slice allows. Returns
    /// the arrangement and its residual (the largest remaining violation).
    fn penalty_stage(&mut self, ctx: &mut Ctx, config: Config, shape: &MorphShape, slice: f64, objective: &mut PenaltyObjective, solver: &mut Lbfgs) -> (Config, f64) {
        let (n, m, p) = (self.n, self.m, self.p);
        self.config = config;
        let pieces = self.config.pieces.clone();
        let container = self.enclose(&pieces, self.config.phi, shape);
        let mut x = Vec::new();
        pack_state(n, m, &self.config.pieces, &container, &mut x);
        objective.set_shape(shape.scale, shape.padding);
        objective.reset_multipliers();
        self.cap = Cap::new(ctx, slice);
        let mut residual = f64::INFINITY;
        let mut weight = self.params.initial_weight;
        let mut previous = f64::INFINITY;
        let mut solved: HashSet<(u64, u64)> = HashSet::new();
        let options = Options { iterations: self.params.inner_iterations, memory: 12, tolerance: 1e-7 };
        for _outer in 0..self.params.outer_iterations {
            if ctx.should_stop() || self.cap.hit(ctx) || !ctx.checkpoint() {
                break;
            }
            // a repeated solve start cannot do better than its first run
            if !solved.insert(hash_vector(&x)) {
                break;
            }
            objective.begin(weight);
            let result = {
                let mut descent = Descent { ctx: &mut *ctx, objective: &mut *objective, sub: &mut *self, restrict: false };
                solver.minimize(&mut x, &options, &mut descent)
            };
            self.config.phi = unpack_into(n, m, p, &x, &mut self.config.pieces);
            residual = objective.violation(&x);
            if result.status == Status::Nonfinite || result.status == Status::Stopped {
                break;
            }
            if result.status == Status::Stalled && result.iterations == 0 {
                break;
            }
            objective.update_multipliers(&x);
            if residual > previous * 0.5 {
                weight *= 4.0;
            }
            previous = residual;
        }
        (self.config.clone(), residual)
    }

    /// Hard-particle Monte Carlo compression on the shape with adaptive move sizes.
    fn monte_carlo_stage(&mut self, ctx: &mut Ctx, config: Config, shape: &MorphShape, slice: f64) -> (Config, f64) {
        let mut config = config;
        let (n, np) = (self.n, self.p);
        self.fill_rel(&config.pieces, shape);
        let pieces = config.pieces.clone();
        let mut container = self.enclose(&pieces, config.phi, shape);
        container.size *= 1.03;
        let cap = Cap::new(ctx, slice);
        let mut step = self.params.translation_step;
        let mut angle_step = self.params.rotation_step;
        let mut jammed = 0u32;
        let mut stagnant = 0u32;
        let mut smallest = container.size;
        let width = 2 * shape.vertices;
        // pairs of centres farther apart than this cannot overlap
        let far = if shape.p.is_none() { 2.0 * (bounding_radius(n) * shape.scale + shape.padding) } else { SQRT_2 };
        for sweep in 0..self.params.mc_sweeps {
            if ctx.should_stop() || cap.hit(ctx) || !ctx.checkpoint() {
                break;
            }
            let mut accepted = 0usize;
            for mv in 0..np {
                if ctx.should_stop() || (mv % 8 == 0 && !ctx.checkpoint()) {
                    return (config, 0.0);
                }
                let i = ((ctx.rng.next() * np as f64) as usize).min(np - 1);
                let p = config.pieces[i];
                let rotate = n != 0 && ctx.rng.next() < 0.5;
                let trial = if rotate {
                    Pose::new(p.x, p.y, p.theta + angle_step * (2.0 * ctx.rng.next() - 1.0))
                } else {
                    Pose::new(p.x + step * (2.0 * ctx.rng.next() - 1.0), p.y + step * (2.0 * ctx.rng.next() - 1.0), p.theta)
                };
                if trial.x == p.x && trial.y == p.y && trial.theta == p.theta {
                    continue;
                }
                // a rotated superellipse has new vertices; otherwise the cached ones serve
                if let (Some(sp), true) = (shape.p, rotate) {
                    self.trial_rel.resize(width, 0.0);
                    super_rel(trial.theta, sp, shape.vertices, &mut self.trial_rel);
                }
                let own: &[f64] = if shape.p.is_some() {
                    if rotate {
                        &self.trial_rel
                    } else {
                        &self.rel[i * width..(i + 1) * width]
                    }
                } else {
                    &[]
                };
                if !self.contained(&trial, own, &container, shape) {
                    continue;
                }
                let mut clear = true;
                for j in 0..np {
                    if j == i {
                        continue;
                    }
                    let q = &config.pieces[j];
                    if (trial.x - q.x).hypot(trial.y - q.y) > far {
                        continue;
                    }
                    let gap = if shape.p.is_some() {
                        polygon_gap(own, (trial.x, trial.y), &self.rel[j * width..(j + 1) * width], (q.x, q.y))
                    } else {
                        -pair_penetration(&self.tester.shape, &trial, q, shape.scale, shape.padding).depth
                    };
                    if gap < 0.0 {
                        clear = false;
                        break;
                    }
                }
                if !clear {
                    continue;
                }
                if rotate && shape.p.is_some() {
                    let fresh = self.trial_rel.clone();
                    self.rel[i * width..(i + 1) * width].copy_from_slice(&fresh);
                }
                config.pieces[i] = trial;
                accepted += 1;
            }
            let mut changed = accepted > 0;
            if sweep >= 5 {
                let contracted = dilate(&config, 0.998);
                if self.is_clear(&contracted.pieces, shape) {
                    let tight = self.enclose(&contracted.pieces, contracted.phi, shape);
                    if tight.size < container.size {
                        config = contracted;
                        container = tight;
                        changed = true;
                    }
                }
                let tight = self.enclose(&config.pieces, config.phi, shape);
                if tight.size < container.size {
                    container = tight;
                }
            }
            if changed && !self.submit_config(ctx, &config) {
                break;
            }
            jammed = if changed { 0 } else { jammed + 1 };
            stagnant = if container.size < smallest - 1e-8 { 0 } else { stagnant + 1 };
            smallest = smallest.min(container.size);
            if jammed >= 40 || stagnant >= 200 {
                break;
            }
            if sweep % 10 == 9 {
                let gain = (accepted as f64 / np as f64 - 0.3).exp();
                step = (step * gain).min(0.5).max(1e-7);
                angle_step = (angle_step * gain).min(0.5).max(1e-7);
            }
        }
        (config, 0.0)
    }
}

impl Submit for Morph {
    fn submit(&mut self, ctx: &mut Ctx, x: &[f64]) -> bool {
        self.config.phi = unpack_into(self.n, self.m, self.p, x, &mut self.config.pieces);
        let trial = self.config.clone();
        self.submit_config(ctx, &trial)
    }
    fn stopped(&self, ctx: &mut Ctx) -> bool {
        ctx.should_stop() || self.cap.hit(ctx)
    }
    fn checkpoint(&mut self, ctx: &mut Ctx) -> bool {
        ctx.checkpoint()
    }
}

pub fn execute(ctx: &mut Ctx) {
    let Some(params) = params_of::<Params>(ctx) else { return };
    if !ctx.checkpoint() {
        return;
    }
    let problem = ctx.problem;
    let (n, m, np) = (problem.n, problem.m, problem.p);
    let mut st = Morph {
        params: params.clone(),
        n,
        m,
        p: np,
        tester: PairTester::new(n),
        seen: HashSet::new(),
        raw_seen: HashSet::new(),
        config: Config { n, m, pieces: Vec::new(), phi: 0.0 },
        cap: Cap::none(),
        rel: Vec::new(),
        trial_rel: Vec::new(),
        scratch: Vec::new(),
    };
    // Circle angles do not describe a different packing: the signature leaves them out.
    let start = ctx.start().cloned();
    if let Some(s) = &start {
        st.seen.insert(signature(s));
    }
    let mut initial = start.clone().filter(|s| s.pieces.len() == np);
    if start.is_none() {
        let remaining = ctx.remaining().0;
        let slice = if remaining.is_finite() { 3f64.max(24f64.min((remaining / 20.0).floor())) } else { 24.0 };
        let seeded = ctx.run(Method::Seed, &serde_json::json!({ "kind": "auto", "poolLimit": 0 }), None, Some(slice as u64), None);
        initial = seeded.found.or(seeded.best);
        if let Some(i) = &initial {
            st.seen.insert(signature(i));
        }
    }
    if ctx.should_stop() {
        return;
    }
    let initial = match initial {
        Some(c) => c,
        None => scatter(problem, || ctx.rng.next()),
    };
    let mut config = initial.clone();
    // Restoration is necessary even for server-valid starts with a tiny negative pair gap.
    if config.pieces.len() != np || st.tester.any_below(&config.pieces, 0.0) {
        let restored = restore(ctx, &config, Strategy::Expand, true, MAX_COORD, &mut st.tester, None);
        config = match restored {
            Some(c) => c,
            None => scatter(problem, || ctx.rng.next()),
        };
    }
    if !st.submit_config(ctx, &config) {
        return;
    }
    // Recentre with the bounding-box midpoint: accepted extreme coordinates remain in range.
    let (mut x0, mut x1, mut y0, mut y1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for q in &config.pieces {
        x0 = x0.min(q.x);
        x1 = x1.max(q.x);
        y0 = y0.min(q.y);
        y1 = y1.max(q.y);
    }
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    for q in config.pieces.iter_mut() {
        q.x -= cx;
        q.y -= cy;
    }
    let jitter = params.jitter;
    for q in config.pieces.iter_mut() {
        q.x += jitter * (2.0 * ctx.rng.next() - 1.0);
        q.y += jitter * (2.0 * ctx.rng.next() - 1.0);
        if n != 0 {
            q.theta += jitter * (2.0 * ctx.rng.next() - 1.0);
        }
    }
    let stages = if n == 0 { 1 } else { params.stages as usize };
    let mut schedule: VecDeque<f64> = if n == 0 {
        VecDeque::from(vec![1.0])
    } else {
        (0..stages).map(|j| (j as f64 / (stages - 1) as f64).powf(params.spacing)).collect()
    };
    let mut objective = PenaltyObjective::new(n, m, np, 1.0, 0.0, true);
    let mut solver = Lbfgs::new();
    let mut previous_t = 0.0;
    let mut residual = 0.0;
    let mut subdivisions = 0;
    while !schedule.is_empty() && !ctx.should_stop() {
        if !ctx.checkpoint() {
            return;
        }
        let mut t = schedule.pop_front().unwrap();
        if params.adaptive && residual > params.residual_threshold && t > previous_t && subdivisions < 2 {
            schedule.push_front(t);
            t = (previous_t + t) / 2.0;
            subdivisions += 1;
        } else {
            subdivisions = 0;
        }
        let mut shape = rounded_shape(n, t, params.family == "inscribed");
        if n == 4 && params.path == "superellipse" && t < 1.0 {
            let last_finite = if stages > 2 { ((stages - 2) as f64 / (stages - 1) as f64).powf(params.spacing) } else { 1.0 };
            shape = MorphShape {
                scale: 1.0,
                padding: 0.0,
                p: Some(2.0 * (params.max_exponent / 2.0).powf(1f64.min(t / last_finite))),
                vertices: 8 * (params.vertices as usize).div_ceil(8),
            };
        }
        let Some(scaled) = st.rescale(ctx, &config, &shape) else { break };
        config = scaled;
        let remaining = ctx.remaining().0;
        let slice = if remaining.is_finite() { 1f64.max((remaining / (schedule.len() + 1) as f64).floor()) } else { f64::INFINITY };
        let monte_carlo = params.local_method == "mc_compress" || shape.p.is_some();
        let (next, left) = if monte_carlo {
            st.monte_carlo_stage(ctx, config, &shape, slice)
        } else {
            st.penalty_stage(ctx, config, &shape, slice, &mut objective, &mut solver)
        };
        config = next;
        residual = left;
        previous_t = t;
        if !st.submit_config(ctx, &config) {
            return;
        }
    }
    // The last raw state is repaired even when a stage failed; a duplicate assessment is skipped.
    st.submit_config(ctx, &config);
}
