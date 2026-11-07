//! Penalty / augmented Lagrangian (packages/solver/src/methods/penalty.ts and penalty/objective.ts).
//!
//! The variables are every piece's x, y and theta (no theta for disks) followed by the container's
//! centre, size and, for a polygon container, orientation. The objective is the container size
//! plus the Powell-Hestenes-Rockafellar term (max(0, lambda + 2 w g)^2 - lambda^2) / (4 w) of
//! every pair penetration and wall protrusion g (constraint form g <= 0), minimised by L-BFGS;
//! every accepted step is restored to a valid arrangement and assessed. `PenaltyObjective` and
//! `Descent` are shared by basin hopping (terminal refinement) and morph (soft shapes).
//!
//! Containment uses the support form: one constraint per container wall, with the piece's
//! furthest vertex along the wall normal, found in O(1) as the vertex nearest in angle to it.
//! Multipliers live in dense arrays keyed by integer constraint ids (a pair i < j is i P + j, a
//! wall index k of piece i is i W + k) with lists of the non-zero ones, so a lookup is one load.

use super::common::{restore, scatter, PairTester, Strategy};
use super::lbfgs::{Lbfgs, Objective, Options, Status};
use super::{fill, params_of, Method};
use crate::enclose::enclose;
use crate::framework::{Ctx, Eval};
use crate::grid::NeighborGrid;
use crate::penalty::{pair_penetration, visit_protrusions};
use crate::sep::Shape;
use crate::shapes::{bounding_radius, circumradius, inradius, Config, Container, Pose, DISK_RADIUS, MAX_COORD};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::f64::consts::PI;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub start: String,
    pub schedule: String,
    pub initial_weight: f64,
    pub growth_factor: f64,
    pub outer_iterations: u32,
    pub inner_iterations: u32,
    pub memory: u32,
    pub gradient_tolerance: f64,
    pub restoration: String,
    pub jitter: f64,
    pub violation_reduction: f64,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            start: "seed".into(),
            schedule: "augmented".into(),
            initial_weight: 10.0,
            growth_factor: 4.0,
            outer_iterations: 10,
            inner_iterations: 200,
            memory: 12,
            gradient_tolerance: 1e-7,
            restoration: "separate".into(),
            jitter: 1e-5,
            violation_reduction: 0.5,
        }
    }
}

impl Params {
    pub fn check(&self) -> Result<(), String> {
        fn one_of(name: &str, value: &str, allowed: &[&str]) -> Result<(), String> {
            if allowed.contains(&value) {
                Ok(())
            } else {
                Err(format!("{name} must be one of {}", allowed.join(", ")))
            }
        }
        one_of("start", &self.start, &["seed", "scatter"])?;
        one_of("schedule", &self.schedule, &["quadratic", "augmented"])?;
        one_of("restoration", &self.restoration, &["separate", "expand"])?;
        if !(self.initial_weight > 0.0 && self.initial_weight.is_finite()) {
            return Err("initialWeight must be a positive number".into());
        }
        if !(1.0..=100.0).contains(&self.growth_factor) {
            return Err("growthFactor must be in [1, 100]".into());
        }
        if !(1..=100).contains(&self.outer_iterations) {
            return Err("outerIterations must be an integer in [1, 100]".into());
        }
        if !(1..=10000).contains(&self.inner_iterations) {
            return Err("innerIterations must be an integer in [1, 10000]".into());
        }
        if !(1..=100).contains(&self.memory) {
            return Err("memory must be an integer in [1, 100]".into());
        }
        if !(self.gradient_tolerance > 0.0 && self.gradient_tolerance.is_finite()) {
            return Err("gradientTolerance must be a positive number".into());
        }
        if !(0.0..=1.0).contains(&self.jitter) {
            return Err("jitter must be in [0, 1]".into());
        }
        if !(self.violation_reduction > 0.0 && self.violation_reduction < 1.0) {
            return Err("violationReduction must be in (0, 1)".into());
        }
        Ok(())
    }
}

pub fn resolve(given: &Value) -> Result<Value, String> {
    let (v, p) = fill::<Params>(given)?;
    p.check()?;
    Ok(v)
}

/// Practical AL continuation: hold the weight while primal feasibility improves.
pub fn next_penalty_weight(weight: f64, growth: f64, augmented: bool, violation: f64, previous: f64, reduction: f64) -> f64 {
    if !augmented || violation > reduction * previous {
        weight * growth
    } else {
        weight
    }
}

// ---------------------------------------------------------------------------------------------
// state vector

/// Length of the variable vector: poses, then container centre, size and (polygons) orientation.
pub fn state_len(n: u32, m: u32, p: usize) -> usize {
    (if n == 0 { 2 } else { 3 }) * p + 3 + usize::from(m != 0)
}

pub fn pack_state(n: u32, m: u32, pieces: &[Pose], container: &Container, out: &mut Vec<f64>) {
    out.clear();
    for q in pieces {
        out.push(q.x);
        out.push(q.y);
        if n != 0 {
            out.push(q.theta);
        }
    }
    out.push(container.cx);
    out.push(container.cy);
    out.push(container.size);
    if m != 0 {
        out.push(container.phi);
    }
}

/// The poses of a variable vector (resizing `pieces`); returns the container orientation.
pub fn unpack_into(n: u32, m: u32, p: usize, x: &[f64], pieces: &mut Vec<Pose>) -> f64 {
    let stride = if n == 0 { 2 } else { 3 };
    pieces.clear();
    for i in 0..p {
        pieces.push(Pose::new(x[stride * i], x[stride * i + 1], if stride == 3 { x[stride * i + 2] } else { 0.0 }));
    }
    if m == 0 {
        0.0
    } else {
        x[stride * p + 3]
    }
}

// ---------------------------------------------------------------------------------------------
// objective

const NO_PIECE: usize = usize::MAX;

/// One constraint with its derivatives. A pair has `j` = the second piece with `a`, `b` the pose
/// derivatives of the two pieces; a wall has `j` = NO_PIECE, `a` the pose derivatives of piece `i`,
/// `b` the container's (cx, cy, size) and `phi` its orientation derivative.
struct Hit {
    depth: f64,
    i: usize,
    j: usize,
    key: usize,
    a: [f64; 3],
    b: [f64; 3],
    phi: f64,
}

struct Geometry {
    n: u32,
    m: u32,
    p: usize,
    stride: usize,
    offset: usize,
    shape: Shape,
    scale: f64,
    padding: f64,
    /// Pair reach: twice the soft piece's bounding radius.
    reach: f64,
    wall_count: usize,
    grid: NeighborGrid,
    poses: Vec<Pose>,
    // container wall normals of the current orientation
    wall_cos: Vec<f64>,
    wall_sin: Vec<f64>,
    wall_angle: Vec<f64>,
    // vertex k of the scaled piece relative to the vertex-up one: R scale (cos, sin)(k step)
    vertex_c: Vec<f64>,
    vertex_s: Vec<f64>,
    unit_apothem: f64,
}

impl Geometry {
    fn new(n: u32, m: u32, p: usize, scale: f64, padding: f64) -> Self {
        let mut g = Geometry {
            n,
            m,
            p,
            stride: if n == 0 { 2 } else { 3 },
            offset: if n == 0 { 2 * p } else { 3 * p },
            shape: Shape::new(n),
            scale,
            padding,
            reach: 0.0,
            wall_count: if m == 0 { (n as usize).max(1) } else { m as usize },
            grid: NeighborGrid::new(),
            poses: vec![Pose::default(); p],
            wall_cos: vec![0.0; m as usize],
            wall_sin: vec![0.0; m as usize],
            wall_angle: vec![0.0; m as usize],
            vertex_c: vec![0.0; n as usize],
            vertex_s: vec![0.0; n as usize],
            unit_apothem: if m == 0 { 0.5 } else { inradius(m) },
        };
        g.set_shape(scale, padding);
        g
    }

    fn set_shape(&mut self, scale: f64, padding: f64) {
        self.scale = scale;
        self.padding = padding;
        self.reach = 2.0 * (bounding_radius(self.n) * scale + padding);
        if self.n > 0 {
            let big_r = circumradius(self.n) * scale;
            let step = 2.0 * PI / self.n as f64;
            for k in 0..self.n as usize {
                let (s, c) = (k as f64 * step).sin_cos();
                self.vertex_c[k] = big_r * c;
                self.vertex_s[k] = big_r * s;
            }
        }
    }

    /// Every constraint at the poses of `x`: the pairs within reach, the pairs listed in `far`
    /// (keys of constraints that carry a multiplier) beyond it, and the walls of every piece.
    fn visit(&mut self, x: &[f64], far: &[u32], mut f: impl FnMut(&Hit)) {
        let (n, m, p, stride, off) = (self.n, self.m, self.p, self.stride, self.offset);
        for i in 0..p {
            self.poses[i] = Pose::new(x[stride * i], x[stride * i + 1], if stride == 3 { x[stride * i + 2] } else { 0.0 });
        }
        let container = Container { m, cx: x[off], cy: x[off + 1], size: x[off + 2], phi: if m == 0 { 0.0 } else { x[off + 3] } };
        let (scale, padding) = (self.scale, self.padding);
        let shape = self.shape;
        self.grid.build(&self.poses, self.reach);
        {
            let poses = &self.poses;
            self.grid.for_each_pair(poses, |i, j| {
                let pp = pair_penetration(&shape, &poses[i], &poses[j], scale, padding);
                f(&Hit { depth: pp.depth, i, j, key: i * p + j, a: pp.ga, b: pp.gb, phi: 0.0 });
                true
            });
            let reach2 = self.reach * self.reach;
            for &key in far {
                let (i, j) = (key as usize / p, key as usize % p);
                let dx = poses[i].x - poses[j].x;
                let dy = poses[i].y - poses[j].y;
                if dx * dx + dy * dy <= reach2 {
                    continue; // visited with the pairs within reach
                }
                let pp = pair_penetration(&shape, &poses[i], &poses[j], scale, padding);
                f(&Hit { depth: pp.depth, i, j, key: key as usize, a: pp.ga, b: pp.gb, phi: 0.0 });
            }
        }
        if m == 0 {
            for i in 0..p {
                let wc = self.wall_count;
                visit_protrusions(n, &self.poses[i], &container, true, scale, padding, |pr| {
                    f(&Hit {
                        depth: pr.depth,
                        i,
                        j: NO_PIECE,
                        key: i * wc + pr.index,
                        a: [pr.px, pr.py, pr.pt],
                        b: [pr.cx, pr.cy, pr.size],
                        phi: pr.phi,
                    })
                });
            }
            return;
        }
        // polygon container: wall normals once for all pieces
        let wall_step = 2.0 * PI / m as f64;
        for j in 0..m as usize {
            let angle = container.phi - PI / 2.0 + wall_step * j as f64;
            let (s, c) = angle.sin_cos();
            self.wall_cos[j] = c;
            self.wall_sin[j] = s;
            self.wall_angle[j] = angle;
        }
        let radius = if n == 0 { scale * DISK_RADIUS } else { 0.0 } + padding;
        let step = if n == 0 { 0.0 } else { 2.0 * PI / n as f64 };
        let unit_apothem = self.unit_apothem;
        for i in 0..p {
            let pose = &self.poses[i];
            let a0 = pose.theta + PI / 2.0;
            let (sa, ca) = a0.sin_cos();
            for edge in 0..m as usize {
                let (ux, uy) = (self.wall_cos[edge], self.wall_sin[edge]);
                // the support vertex is the one nearest in angle to the wall normal
                let (ox, oy) = if n == 0 {
                    (0.0, 0.0)
                } else {
                    let nearest = ((self.wall_angle[edge] - a0) / step).round();
                    // integer remainder (the float one is a slow library call)
                    let k = (nearest as i64).rem_euclid(n as i64) as usize;
                    let (rc, rs) = (self.vertex_c[k], self.vertex_s[k]);
                    (ca * rc - sa * rs, sa * rc + ca * rs)
                };
                let dx = pose.x + ox - container.cx;
                let dy = pose.y + oy - container.cy;
                f(&Hit {
                    depth: dx * ux + dy * uy + radius - container.size * unit_apothem,
                    i,
                    j: NO_PIECE,
                    key: i * m as usize + edge,
                    a: [ux, uy, ox * uy - oy * ux],
                    b: [-ux, -uy, -unit_apothem],
                    phi: -dx * uy + dy * ux,
                });
            }
        }
    }
}

pub struct PenaltyObjective {
    geo: Geometry,
    augmented: bool,
    weight: f64,
    /// Sum of -lambda^2 / (4 w): the constant term of the augmented objective.
    constant: f64,
    lam_pair: Vec<f64>,
    act_pair: Vec<u32>,
    lam_wall: Vec<f64>,
    act_wall: Vec<u32>,
    spare_pair: Vec<u32>,
    spare_wall: Vec<u32>,
}

impl PenaltyObjective {
    /// An objective for P pieces of shape n in a container of shape m; the piece is its polygon
    /// core scaled by `scale` and dilated by a disk of radius `padding` (1 and 0: the true piece).
    pub fn new(n: u32, m: u32, p: usize, scale: f64, padding: f64, augmented: bool) -> Self {
        let geo = Geometry::new(n, m, p, scale, padding);
        let (pairs, walls) = if augmented { (p * p, p * geo.wall_count) } else { (0, 0) };
        PenaltyObjective {
            geo,
            augmented,
            weight: 1.0,
            constant: 0.0,
            lam_pair: vec![0.0; pairs],
            act_pair: Vec::new(),
            lam_wall: vec![0.0; walls],
            act_wall: Vec::new(),
            spare_pair: Vec::new(),
            spare_wall: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        state_len(self.geo.n, self.geo.m, self.geo.p)
    }

    /// Change the soft piece (the multipliers are kept: callers reset them for a new shape).
    pub fn set_shape(&mut self, scale: f64, padding: f64) {
        self.geo.set_shape(scale, padding);
    }

    pub fn reset_multipliers(&mut self) {
        for &k in &self.act_pair {
            self.lam_pair[k as usize] = 0.0;
        }
        for &k in &self.act_wall {
            self.lam_wall[k as usize] = 0.0;
        }
        self.act_pair.clear();
        self.act_wall.clear();
        self.constant = 0.0;
    }

    /// Start an outer iteration at this weight.
    pub fn begin(&mut self, weight: f64) {
        self.weight = weight;
        let mut c = 0.0;
        if self.augmented {
            for &k in &self.act_pair {
                let l = self.lam_pair[k as usize];
                c -= l * l / (4.0 * weight);
            }
            for &k in &self.act_wall {
                let l = self.lam_wall[k as usize];
                c -= l * l / (4.0 * weight);
            }
        }
        self.constant = c;
    }

    /// Objective and gradient; infinite (with a zero gradient) for a non-finite or out-of-range
    /// state, which the line search rejects.
    pub fn value(&mut self, x: &[f64], grad: &mut [f64]) -> f64 {
        grad.fill(0.0);
        let (stride, off) = (self.geo.stride, self.geo.offset);
        if !x.iter().all(|v| v.is_finite()) || x[off + 2] <= 0.0 {
            return f64::INFINITY;
        }
        // a start in the accepted global range spans at most 2 MAX_COORD about its centroid
        let limit = 2.0 * MAX_COORD;
        for i in 0..self.geo.p {
            if x[stride * i].abs() > limit || x[stride * i + 1].abs() > limit {
                return f64::INFINITY;
            }
        }
        if x[off].abs() > limit || x[off + 1].abs() > limit {
            return f64::INFINITY;
        }
        let mut value = x[off + 2] + self.constant;
        grad[off + 2] = 1.0;
        let weight = self.weight;
        let augmented = self.augmented;
        let m_nonzero = self.geo.m != 0;
        let Self { geo, lam_pair, lam_wall, act_pair, .. } = self;
        let (lam_pair, lam_wall): (&[f64], &[f64]) = (lam_pair, lam_wall);
        geo.visit(x, act_pair, |h| {
            let lambda = if !augmented {
                0.0
            } else if h.j != NO_PIECE {
                lam_pair[h.key]
            } else {
                lam_wall[h.key]
            };
            let raw = lambda + 2.0 * weight * h.depth;
            let factor = if raw.is_nan() { raw } else { raw.max(0.0) };
            if factor == 0.0 {
                return;
            }
            value += factor * factor / (4.0 * weight);
            let gi = stride * h.i;
            grad[gi] += factor * h.a[0];
            grad[gi + 1] += factor * h.a[1];
            if stride == 3 {
                grad[gi + 2] += factor * h.a[2];
            }
            if h.j != NO_PIECE {
                let gj = stride * h.j;
                grad[gj] += factor * h.b[0];
                grad[gj + 1] += factor * h.b[1];
                if stride == 3 {
                    grad[gj + 2] += factor * h.b[2];
                }
            } else {
                grad[off] += factor * h.b[0];
                grad[off + 1] += factor * h.b[1];
                grad[off + 2] += factor * h.b[2];
                if m_nonzero {
                    grad[off + 3] += factor * h.phi;
                }
            }
        });
        value
    }

    /// Largest positive constraint depth (0 when feasible).
    pub fn violation(&mut self, x: &[f64]) -> f64 {
        let mut maximum = 0.0f64;
        let Self { geo, act_pair, .. } = self;
        geo.visit(x, act_pair, |h| {
            if h.depth > maximum || h.depth.is_nan() {
                maximum = h.depth;
            }
        });
        maximum
    }

    /// lambda <- max(0, lambda + 2 w g) at `x` for every constraint within reach or carrying one.
    pub fn update_multipliers(&mut self, x: &[f64]) {
        if !self.augmented {
            return;
        }
        let weight = self.weight;
        let old_pair = std::mem::take(&mut self.act_pair);
        let old_wall = std::mem::take(&mut self.act_wall);
        let mut new_pair = std::mem::take(&mut self.spare_pair);
        let mut new_wall = std::mem::take(&mut self.spare_wall);
        new_pair.clear();
        new_wall.clear();
        {
            let Self { geo, lam_pair, lam_wall, .. } = self;
            geo.visit(x, &old_pair, |h| {
                let (lam, list) = if h.j != NO_PIECE { (&mut lam_pair[h.key], &mut new_pair) } else { (&mut lam_wall[h.key], &mut new_wall) };
                let next = (*lam + 2.0 * weight * h.depth).max(0.0);
                if next > 0.0 && next.is_finite() {
                    *lam = next;
                    list.push(h.key as u32);
                } else {
                    *lam = 0.0;
                }
            });
        }
        // every constraint that held a multiplier was visited and rewritten
        self.act_pair = new_pair;
        self.act_wall = new_wall;
        self.spare_pair = old_pair;
        self.spare_wall = old_wall;
    }
}

// ---------------------------------------------------------------------------------------------
// budget scoping and the descent driver

/// An extra evaluation cap for a scoped solve: stops once `limit` assessments have been counted
/// since `base`. The reference gives such solves a scoped context with its own stop function.
#[derive(Clone, Copy, Debug)]
pub struct Cap {
    base: u64,
    limit: f64,
}

impl Cap {
    pub fn none() -> Cap {
        Cap { base: 0, limit: f64::INFINITY }
    }
    /// `limit` more assessments from now.
    pub fn new(ctx: &Ctx, limit: f64) -> Cap {
        Cap { base: ctx.evaluations, limit }
    }
    /// A cap of `limit` assessments counted from an earlier reading of the counter.
    pub fn since(base: u64, limit: f64) -> Cap {
        Cap { base, limit }
    }
    #[inline]
    pub fn hit(&self, ctx: &Ctx) -> bool {
        (ctx.evaluations - self.base) as f64 >= self.limit
    }
}

/// A cap together with an optional observer of every counted valid assessment.
pub struct Meter<'o> {
    pub cap: Cap,
    pub observer: Option<&'o mut dyn FnMut(&Config, &Eval)>,
}

impl<'o> Meter<'o> {
    pub fn new(cap: Cap) -> Self {
        Meter { cap, observer: None }
    }
    #[inline]
    pub fn stopped(&self, ctx: &mut Ctx) -> bool {
        self.cap.hit(ctx) || ctx.should_stop()
    }
    pub fn checkpoint(&self, ctx: &mut Ctx) -> bool {
        !self.cap.hit(ctx) && ctx.checkpoint()
    }
    pub fn evaluate(&mut self, ctx: &mut Ctx, config: &Config, auto_orient: bool) -> Option<Eval> {
        if self.cap.hit(ctx) {
            return None;
        }
        let result = ctx.evaluate(config, auto_orient)?;
        if result.valid {
            if let Some(o) = self.observer.as_mut() {
                o(config, &result);
            }
        }
        Some(result)
    }
}

/// What a descent needs of its caller: the stop rules and the handling of an accepted iterate.
pub trait Submit {
    /// Restore and assess an accepted iterate; false stops the descent.
    fn submit(&mut self, ctx: &mut Ctx, x: &[f64]) -> bool;
    fn stopped(&self, ctx: &mut Ctx) -> bool;
    fn checkpoint(&mut self, ctx: &mut Ctx) -> bool;
}

/// The L-BFGS objective of a penalty solve, with the caller's stop rules and submissions.
pub struct Descent<'a, 'c, S: Submit> {
    pub ctx: &'a mut Ctx<'c>,
    pub objective: &'a mut PenaltyObjective,
    pub sub: &'a mut S,
    /// Zero the gradient of the angles (pieces and container): a fixed-orientation solve.
    pub restrict: bool,
}

impl<'a, 'c, S: Submit> Objective for Descent<'a, 'c, S> {
    fn eval(&mut self, x: &[f64], grad: &mut [f64]) -> f64 {
        let value = self.objective.value(x, grad);
        if self.restrict {
            let g = &self.objective.geo;
            if g.stride == 3 {
                for i in 0..g.p {
                    grad[3 * i + 2] = 0.0;
                }
            }
            if g.m != 0 {
                let last = grad.len() - 1;
                grad[last] = 0.0;
            }
        }
        value
    }
    fn checkpoint(&mut self) -> bool {
        self.sub.checkpoint(self.ctx)
    }
    fn stopped(&mut self) -> bool {
        self.sub.stopped(self.ctx)
    }
    fn accepted(&mut self, x: &[f64], _iteration: u32) -> bool {
        self.sub.submit(self.ctx, x)
    }
}

// ---------------------------------------------------------------------------------------------
// the method

/// Submissions of the penalty method: the iterate is restored to a valid arrangement, shifted back
/// to the start's frame and assessed at its stored container orientation.
pub struct PenaltySubmitter<'o> {
    pub meter: Meter<'o>,
    pub tester: PairTester,
    n: u32,
    m: u32,
    p: usize,
    cx: f64,
    cy: f64,
    strategy: Strategy,
    trial: Config,
}

impl<'o> PenaltySubmitter<'o> {
    pub fn new(meter: Meter<'o>, n: u32, m: u32, p: usize, cx: f64, cy: f64, strategy: Strategy) -> Self {
        PenaltySubmitter {
            meter,
            tester: PairTester::new(n),
            n,
            m,
            p,
            cx,
            cy,
            strategy,
            trial: Config { n, m, pieces: Vec::with_capacity(p), phi: 0.0 },
        }
    }
}

impl<'o> Submit for PenaltySubmitter<'o> {
    fn submit(&mut self, ctx: &mut Ctx, x: &[f64]) -> bool {
        if self.meter.stopped(ctx) {
            return false;
        }
        self.trial.phi = unpack_into(self.n, self.m, self.p, x, &mut self.trial.pieces);
        let restored = restore(ctx, &self.trial, self.strategy, true, 2.0 * MAX_COORD, &mut self.tester, None);
        let Some(mut valid) = restored else {
            return !self.meter.stopped(ctx);
        };
        for q in valid.pieces.iter_mut() {
            q.x += self.cx;
            q.y += self.cy;
        }
        self.meter.evaluate(ctx, &valid, false).is_some()
    }
    fn stopped(&self, ctx: &mut Ctx) -> bool {
        self.meter.stopped(ctx)
    }
    fn checkpoint(&mut self, ctx: &mut Ctx) -> bool {
        self.meter.checkpoint(ctx)
    }
}

pub fn execute(ctx: &mut Ctx) {
    let Some(params) = params_of::<Params>(ctx) else { return };
    let supplied = ctx.start().cloned().map(|c| (c, ctx.initial_evaluation().cloned()));
    solve(ctx, &params, supplied, Meter::new(Cap::none()));
}

/// The penalty method on a start (with its assessment, when known) under a scoped budget.
pub fn solve(ctx: &mut Ctx, params: &Params, supplied: Option<(Config, Option<Eval>)>, meter: Meter) {
    let problem = ctx.problem;
    let (n, m, p) = (problem.n, problem.m, problem.p);
    if p == 0 || !meter.checkpoint(ctx) {
        return;
    }
    let mut initial: Option<Config> = None;
    let mut assessment: Option<Eval> = None;
    if let Some((config, eval)) = supplied {
        if config.pieces.len() == p {
            initial = Some(config);
            assessment = eval;
        }
    }
    if initial.is_none() && params.start == "seed" {
        // a fixed assessment cap keeps evaluation-only runs deterministic
        let seeded = ctx.run(Method::Seed, &json!({ "kind": "auto" }), None, Some(24), None);
        if seeded.valid {
            if let Some(b) = seeded.best {
                if b.n == n && b.m == m && b.pieces.len() == p {
                    initial = Some(b);
                }
            }
        }
    }
    let initial = match initial {
        Some(c) => c,
        None => scatter(problem, || ctx.rng.next()),
    };
    // Work about an anchored centroid so that large absolute coordinates do not affect line
    // searches or symmetry breaking.
    let anchor = initial.pieces[0];
    let cx = anchor.x + initial.pieces.iter().map(|q| q.x - anchor.x).sum::<f64>() / p as f64;
    let cy = anchor.y + initial.pieces.iter().map(|q| q.y - anchor.y).sum::<f64>() / p as f64;
    let mut config = Config { n, m, pieces: initial.pieces.iter().map(|q| Pose::new(q.x - cx, q.y - cy, q.theta)).collect(), phi: 0.0 };
    let strategy = if params.restoration == "expand" { Strategy::Expand } else { Strategy::Separate };
    let mut sub = PenaltySubmitter::new(meter, n, m, p, cx, cy, strategy);
    if !assessment.as_ref().map_or(false, |e| e.valid) {
        let repaired = restore(ctx, &config, strategy, true, 2.0 * MAX_COORD, &mut sub.tester, None);
        config = match repaired {
            Some(c) => c,
            None => scatter(problem, || ctx.rng.next()),
        };
        let shifted = Config { n, m, pieces: config.pieces.iter().map(|q| Pose::new(q.x + cx, q.y + cy, q.theta)).collect(), phi: config.phi };
        assessment = sub.meter.evaluate(ctx, &shifted, false);
    }
    if !assessment.as_ref().map_or(false, |e| e.valid && e.container.is_some()) || sub.meter.stopped(ctx) {
        return;
    }
    // The enclosure is recomputed in the local frame at phi = 0: the stored angle of the start is
    // the framework's auto-orientation, whose rounding at far coordinates must not become an input.
    let container = enclose(n, &config.pieces, m, 0.0);
    let mut x = Vec::new();
    pack_state(n, m, &config.pieces, &container, &mut x);
    if params.jitter > 0.0 {
        let stride = if n == 0 { 2 } else { 3 };
        for v in x.iter_mut().take(stride * p) {
            *v += params.jitter * (2.0 * ctx.rng.next() - 1.0);
        }
    }
    let augmented = params.schedule == "augmented";
    let mut objective = PenaltyObjective::new(n, m, p, 1.0, 0.0, augmented);
    let mut solver = Lbfgs::new();
    let options = Options { iterations: params.inner_iterations, memory: params.memory as usize, tolerance: params.gradient_tolerance };
    let mut weight = params.initial_weight;
    let mut previous = f64::INFINITY;
    for _outer in 0..params.outer_iterations {
        if sub.meter.stopped(ctx) || !sub.meter.checkpoint(ctx) {
            return;
        }
        if !weight.is_finite() {
            return;
        }
        objective.begin(weight);
        let result = {
            let mut descent = Descent { ctx: &mut *ctx, objective: &mut objective, sub: &mut sub, restrict: false };
            solver.minimize(&mut x, &options, &mut descent)
        };
        if result.status == Status::Nonfinite || result.status == Status::Stopped {
            return;
        }
        if !sub.submit(ctx, &x) {
            return;
        }
        let violation = objective.violation(&x);
        // a stalled solve without significant progress must not turn unresolved residuals into
        // larger multipliers
        if result.status == Status::Converged || result.initial_value - result.value > 1e-12 * 1f64.max(result.initial_value.abs()) {
            objective.update_multipliers(&x);
        }
        weight = next_penalty_weight(weight, params.growth_factor, augmented, violation, previous, params.violation_reduction);
        previous = violation;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64) / ((1u64 << 53) as f64)
    }

    /// The (non-augmented) objective written out with the shared penetration and protrusion routines.
    fn reference(n: u32, m: u32, p: usize, scale: f64, padding: f64, weight: f64, x: &[f64], grad: &mut [f64]) -> f64 {
        let stride = if n == 0 { 2 } else { 3 };
        let off = stride * p;
        grad.fill(0.0);
        let shape = Shape::new(n);
        let poses: Vec<Pose> = (0..p).map(|i| Pose::new(x[stride * i], x[stride * i + 1], if stride == 3 { x[stride * i + 2] } else { 0.0 })).collect();
        let container = Container { m, cx: x[off], cy: x[off + 1], size: x[off + 2], phi: if m == 0 { 0.0 } else { x[off + 3] } };
        let mut value = x[off + 2];
        grad[off + 2] = 1.0;
        let reach = 2.0 * (bounding_radius(n) * scale + padding);
        for i in 0..p {
            for j in i + 1..p {
                if (poses[i].x - poses[j].x).hypot(poses[i].y - poses[j].y) > reach {
                    continue;
                }
                let pp = pair_penetration(&shape, &poses[i], &poses[j], scale, padding);
                let f = (2.0 * weight * pp.depth).max(0.0);
                if f == 0.0 {
                    continue;
                }
                value += f * f / (4.0 * weight);
                for k in 0..stride {
                    grad[stride * i + k] += f * pp.ga[k];
                    grad[stride * j + k] += f * pp.gb[k];
                }
            }
            visit_protrusions(n, &poses[i], &container, true, scale, padding, |pr| {
                let f = (2.0 * weight * pr.depth).max(0.0);
                if f == 0.0 {
                    return;
                }
                value += f * f / (4.0 * weight);
                grad[stride * i] += f * pr.px;
                grad[stride * i + 1] += f * pr.py;
                if stride == 3 {
                    grad[stride * i + 2] += f * pr.pt;
                }
                grad[off] += f * pr.cx;
                grad[off + 1] += f * pr.cy;
                grad[off + 2] += f * pr.size;
                if m != 0 {
                    grad[off + 3] += f * pr.phi;
                }
            });
        }
        value
    }

    #[test]
    fn resolve_fills_defaults_and_checks_ranges() {
        let v = resolve(&Value::Null).unwrap();
        assert_eq!(v["outerIterations"], 10);
        assert_eq!(v["innerIterations"], 200);
        assert_eq!(v["schedule"], "augmented");
        for bad in [
            json!({ "start": "elsewhere" }),
            json!({ "schedule": "cubic" }),
            json!({ "restoration": "shake" }),
            json!({ "initialWeight": 0 }),
            json!({ "growthFactor": 0.5 }),
            json!({ "outerIterations": 0 }),
            json!({ "innerIterations": 10001 }),
            json!({ "memory": 101 }),
            json!({ "gradientTolerance": 0 }),
            json!({ "jitter": 2 }),
            json!({ "violationReduction": 1 }),
            json!({ "extra": true }),
        ] {
            assert!(resolve(&bad).is_err(), "{bad}");
        }
        assert_eq!(next_penalty_weight(10.0, 4.0, true, 0.4, 1.0, 0.5), 10.0);
        assert_eq!(next_penalty_weight(10.0, 4.0, true, 0.6, 1.0, 0.5), 40.0);
        assert_eq!(next_penalty_weight(10.0, 4.0, false, 0.0, 1.0, 0.5), 40.0);
    }

    #[test]
    fn runs_are_valid_and_reproducible() {
        use crate::clock::ClockKind;
        use crate::framework::{run, Budget, Control, RunOptions};
        use crate::shapes::Problem;
        for problem in [Problem::new(4, 4, 6), Problem::new(0, 0, 7), Problem::new(5, 5, 7), Problem::new(0, 4, 9)] {
            for params in [json!({}), json!({ "schedule": "quadratic", "restoration": "expand" }), json!({ "start": "scatter" })] {
                let go = || {
                    let control = Control::new();
                    run(
                        problem,
                        RunOptions {
                            method: Method::Penalty,
                            params: params.clone(),
                            start: None,
                            budget: Budget { evals: Some(800), time_s: Some(1000.0) },
                            seed: 3,
                            final_polish: true,
                            control: &control,
                            clock: ClockKind::Wall,
                        },
                    )
                };
                let (a, b) = (go(), go());
                assert!(a.valid && a.strict, "{problem:?} {params}: {:?}", a.reasons);
                assert_eq!(a.best, b.best);
                assert_eq!(a.evaluations, b.evaluations);
            }
        }
    }

    #[test]
    fn objective_matches_reference_and_finite_differences() {
        let mut seed = 11u64;
        for &(n, m) in &[(4u32, 4u32), (3, 6), (0, 4), (7, 0), (5, 5), (0, 0), (6, 3)] {
            for &(scale, padding) in &[(1.0, 0.0), (0.6, 0.25), (0.0, 0.5)] {
                for augmented in [false, true] {
                    let p = 14;
                    let stride = if n == 0 { 2 } else { 3 };
                    let mut obj = PenaltyObjective::new(n, m, p, scale, padding, augmented);
                    let len = obj.len();
                    let mut x = vec![0.0; len];
                    for i in 0..p {
                        x[stride * i] = (lcg(&mut seed) - 0.5) * 4.0;
                        x[stride * i + 1] = (lcg(&mut seed) - 0.5) * 4.0;
                        if stride == 3 {
                            x[stride * i + 2] = lcg(&mut seed) * 6.0;
                        }
                    }
                    x[stride * p] = 0.1;
                    x[stride * p + 1] = -0.2;
                    x[stride * p + 2] = 2.2;
                    if m != 0 {
                        x[stride * p + 3] = 0.3;
                    }
                    let weight = 7.0;
                    if augmented {
                        // multipliers from a first pass, then the augmented objective itself
                        obj.begin(weight);
                        obj.update_multipliers(&x);
                    }
                    obj.begin(weight);
                    let mut g = vec![0.0; len];
                    let v = obj.value(&x, &mut g);
                    if !augmented {
                        let mut gr = vec![0.0; len];
                        let vr = reference(n, m, p, scale, padding, weight, &x, &mut gr);
                        assert!((v - vr).abs() < 1e-9 * vr.abs().max(1.0), "n={n} m={m} value {v} {vr}");
                        for k in 0..len {
                            assert!((g[k] - gr[k]).abs() < 1e-9 * gr[k].abs().max(1.0), "n={n} m={m} grad[{k}] {} {}", g[k], gr[k]);
                        }
                    }
                    // central differences (the objective is piecewise smooth: a switch or two is allowed)
                    let mut bad = 0;
                    for k in 0..len {
                        let h = 1e-6;
                        let mut xp = x.clone();
                        let mut xm = x.clone();
                        xp[k] += h;
                        xm[k] -= h;
                        let mut scratch = vec![0.0; len];
                        let fd = (obj.value(&xp, &mut scratch) - obj.value(&xm, &mut scratch)) / (2.0 * h);
                        if (fd - g[k]).abs() > 1e-4 * g[k].abs().max(1.0) {
                            bad += 1;
                        }
                    }
                    assert!(bad <= 1, "n={n} m={m} scale={scale} padding={padding} augmented={augmented}: {bad} of {len} derivatives differ from finite differences");
                }
            }
        }
    }
}
