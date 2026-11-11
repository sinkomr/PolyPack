//! Contact polish (packages/solver/src/polish.ts): sequential quadratic programming on the
//! contact graph. Each iteration linearises the near contacts (pair separations and wall gaps of
//! every vertex) and projects a shrink of the container onto the linearised inequalities by
//! Hildreth's coordinate descent on the dual; the shared assessment, not the local model, accepts
//! the step. A final Newton phase snaps the active contacts.
//!
//! The rows are the analytic derivatives of the separations and gaps (the reference takes central
//! differences of the same functions); a row has at most seven non-zero entries, which is how
//! they are stored.

use crate::framework::{Ctx, Eval};
use crate::grid::NeighborGrid;
use crate::penalty::{pair_penetration, visit_protrusions};
use crate::sep::Shape;
use crate::shapes::{area_lower_bound, bounding_radius, Config, Container, Pose};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub max_iterations: u32,
    pub contact_tolerance: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<u32>,
}

impl Default for Params {
    fn default() -> Self {
        Params { max_iterations: 300, contact_tolerance: 0.05, iterations: None }
    }
}

impl Params {
    pub fn check(&self) -> Result<(), String> {
        if self.max_iterations > 300 || !(0.0..=1.0).contains(&self.contact_tolerance) {
            return Err("polish parameters out of range".into());
        }
        Ok(())
    }
}

/// One linearised constraint: gap + row . step >= target. At most 7 variables.
#[derive(Clone, Copy, Debug)]
struct Row {
    idx: [u32; 7],
    val: [f64; 7],
    len: u8,
    gap: f64,
}

impl Row {
    #[inline]
    fn dot(&self, v: &[f64]) -> f64 {
        let mut s = 0.0;
        for k in 0..self.len as usize {
            s += self.val[k] * v[self.idx[k] as usize];
        }
        s
    }
    #[inline]
    fn norm2(&self) -> f64 {
        let mut s = 0.0;
        for k in 0..self.len as usize {
            s += self.val[k] * self.val[k];
        }
        s
    }
    #[inline]
    fn axpy(&self, a: f64, v: &mut [f64]) {
        for k in 0..self.len as usize {
            v[self.idx[k] as usize] += a * self.val[k];
        }
    }
}

struct Polisher {
    shape: Shape,
    grid: NeighborGrid,
    n: u32,
    m: u32,
    p: usize,
}

impl Polisher {
    /// Near contacts (gap <= tolerance), linearised; None when the system is too large.
    fn contacts(&mut self, config: &Config, c: &Container, tolerance: f64, rows: &mut Vec<Row>) -> Option<()> {
        rows.clear();
        let (n, p) = (self.n, self.p);
        let offset = 3 * p as u32;
        // pairs: only those within the near reach of the tolerance can report a gap below it
        self.grid.build(&config.pieces, self.shape.near_reach(tolerance.max(0.0)));
        let shape = self.shape;
        let mut overflow = false;
        let pieces = &config.pieces;
        let limit = |len: usize| len > 2048 || len * (n.max(1) as usize) > 50000;
        self.grid.for_each_pair(pieces, |i, j| {
            let sep = shape.sep(&pieces[i], &pieces[j]);
            if sep <= tolerance {
                let pen = pair_penetration(&shape, &pieces[i], &pieces[j], 1.0, 0.0);
                let (i3, j3) = (3 * i as u32, 3 * j as u32);
                let mut row = Row { idx: [0; 7], val: [0.0; 7], len: 0, gap: sep };
                let vars = [(i3, -pen.ga[0]), (i3 + 1, -pen.ga[1]), (i3 + 2, -pen.ga[2]), (j3, -pen.gb[0]), (j3 + 1, -pen.gb[1]), (j3 + 2, -pen.gb[2])];
                for (k, (ix, v)) in vars.into_iter().enumerate() {
                    if n == 0 && (k == 2 || k == 5) {
                        continue;
                    }
                    row.idx[row.len as usize] = ix;
                    row.val[row.len as usize] = v;
                    row.len += 1;
                }
                rows.push(row);
                if limit(rows.len()) {
                    overflow = true;
                    return false;
                }
            }
            true
        });
        if overflow {
            return None;
        }
        // walls: every vertex (the centre of a disk) against every wall, or radially
        for i in 0..p {
            let i3 = 3 * i as u32;
            let m = self.m;
            let mut over = false;
            visit_protrusions(n, &pieces[i], c, false, 1.0, 0.0, |q| {
                if over || !(-q.depth <= tolerance) {
                    return;
                }
                let mut row = Row { idx: [0; 7], val: [0.0; 7], len: 0, gap: -q.depth };
                let mut push = |ix: u32, v: f64| {
                    row.idx[row.len as usize] = ix;
                    row.val[row.len as usize] = v;
                    row.len += 1;
                };
                push(i3, -q.px);
                push(i3 + 1, -q.py);
                if n != 0 {
                    push(i3 + 2, -q.pt);
                }
                push(offset, -q.cx);
                push(offset + 1, -q.cy);
                if m != 0 {
                    push(offset + 2, -q.phi);
                }
                push(offset + 3, -q.size);
                rows.push(row);
                if limit(rows.len()) {
                    over = true;
                }
            });
            if over {
                return None;
            }
        }
        Some(())
    }

    /// True when no pair penetrates and no vertex protrudes by more than 1e-12.
    fn strictly_feasible(&mut self, config: &Config, c: &Container) -> bool {
        let pieces = &config.pieces;
        self.grid.build(pieces, 2.0 * bounding_radius(self.n));
        let shape = self.shape;
        let mut ok = true;
        self.grid.for_each_pair(pieces, |i, j| {
            if shape.sep(&pieces[i], &pieces[j]) <= -1e-12 {
                ok = false;
                return false;
            }
            true
        });
        if !ok {
            return false;
        }
        for q in pieces {
            visit_protrusions(self.n, q, c, false, 1.0, 0.0, |pr| {
                if !(-pr.depth > -1e-12) {
                    ok = false;
                }
            });
            if !ok {
                return false;
            }
        }
        true
    }

    /// Pairwise separating sweeps with a margin far tighter than the server's tolerance.
    fn restore_separation(&mut self, ctx: &mut Ctx, config: &mut Config) -> bool {
        let n = self.n;
        let shape = self.shape;
        let reach = 2.0 * bounding_radius(n) + 1e-9;
        let threshold = if n == 0 { 0.0 } else { -2e-14 };
        let mut pairs: Vec<(u32, u32)> = Vec::new();
        for _sweep in 0..48 {
            if ctx.should_stop() {
                return false;
            }
            self.grid.build(&config.pieces, reach);
            pairs.clear();
            self.grid.for_each_pair(&config.pieces, |i, j| {
                pairs.push((i as u32, j as u32));
                true
            });
            let mut worst = 0.0f64;
            for &(i, j) in &pairs {
                let (i, j) = (i as usize, j as usize);
                let c = shape.contact(&config.pieces[i], &config.pieces[j]);
                worst = worst.max(-c.sep);
                if c.sep < threshold {
                    let mv = (-c.sep + 2e-13) / 2.0;
                    config.pieces[i].x += mv * c.nx;
                    config.pieces[i].y += mv * c.ny;
                    config.pieces[j].x -= mv * c.nx;
                    config.pieces[j].y -= mv * c.ny;
                }
            }
            if if n == 0 { worst == 0.0 } else { worst < 2e-14 } {
                return true;
            }
        }
        self.grid.build(&config.pieces, reach);
        let limit = if n == 0 { 0.0 } else { -1e-12 };
        let mut ok = true;
        let pieces = &config.pieces;
        self.grid.for_each_pair(pieces, |i, j| {
            if shape.sep(&pieces[i], &pieces[j]) < limit {
                ok = false;
                return false;
            }
            true
        });
        ok && !ctx.should_stop()
    }
}

fn pack(config: &Config, c: &Container, out: &mut Vec<f64>) {
    out.clear();
    for q in &config.pieces {
        out.push(q.x);
        out.push(q.y);
        out.push(q.theta);
    }
    out.extend_from_slice(&[c.cx, c.cy, c.phi, c.size]);
}

fn unpack(template: &Config, x: &[f64], out: &mut Config) {
    out.n = template.n;
    out.m = template.m;
    out.pieces.clear();
    let p = template.pieces.len();
    for i in 0..p {
        out.pieces.push(Pose::new(x[3 * i], x[3 * i + 1], x[3 * i + 2]));
    }
    out.phi = x[3 * p + 2];
}

const IMPROVEMENT_FLOOR: f64 = 2e-13;

/// Polish `config`; every candidate goes through the run's counted assessment, whose best
/// tracker keeps the result.
pub fn polish(ctx: &mut Ctx, config: &Config, max_iterations: u32, contact_tolerance: f64) {
    let (n, m, p) = (ctx.problem.n, ctx.problem.m, ctx.problem.p);
    if config.pieces.len() != p {
        return;
    }
    let iterations = max_iterations.min(300);
    let tolerance = contact_tolerance.clamp(1e-7, 1.0);
    if ctx.should_stop() || !ctx.checkpoint() {
        return;
    }
    let mut current = config.clone();
    let mut evaluation: Eval = match ctx.initial_evaluation().cloned() {
        Some(e) => e,
        None => match ctx.evaluate(&current, true) {
            Some(e) => e,
            None => return,
        },
    };
    let Some(mut container) = evaluation.container else { return };
    let mut po = Polisher { shape: Shape::new(n), grid: NeighborGrid::new(), n, m, p };
    let initial_strict = evaluation.valid && po.strictly_feasible(&current, &container);
    let mut best: Option<Config> = if initial_strict {
        let mut b = current.clone();
        b.phi = container.phi;
        Some(b)
    } else {
        None
    };
    let mut best_score = if evaluation.valid { evaluation.score.unwrap() } else { f64::INFINITY };
    let mut best_eval: Option<Eval> = if initial_strict { Some(evaluation.clone()) } else { None };
    // dense Jacobian work is bounded: large problems keep their validated fallback
    if p > 100 {
        return;
    }
    let max_trust = 0.5f64.min(0.05f64.max(0.1 * (evaluation.score.unwrap() - area_lower_bound(n, m, p)).max(0.0)));
    let mut trust = 0.05f64.min(max_trust);
    let mut stalled = 0;
    let mut rows: Vec<Row> = Vec::new();
    let mut x: Vec<f64> = Vec::new();
    let mut direction: Vec<f64> = Vec::new();
    let mut multipliers: Vec<f64> = Vec::new();
    let mut norms: Vec<f64> = Vec::new();
    let mut trial_vars: Vec<f64> = Vec::new();
    let mut trial = current.clone();
    for _iteration in 0..iterations {
        if ctx.should_stop() || !ctx.checkpoint() {
            break;
        }
        current.phi = container.phi;
        if po.contacts(&current, &container, tolerance, &mut rows).is_none() {
            return;
        }
        pack(&current, &container, &mut x);
        direction.clear();
        direction.resize(x.len(), 0.0);
        let last = x.len() - 1;
        direction[last] = -trust;
        multipliers.clear();
        multipliers.resize(rows.len(), 0.0);
        norms.clear();
        norms.extend(rows.iter().map(|r| r.norm2()));
        // Hildreth coordinate descent solves the convex QP dual without singular KKT matrices
        for _sweep in 0..300 {
            if ctx.should_stop() {
                return;
            }
            let mut largest = 0.0f64;
            for k in 0..rows.len() {
                if norms[k] < 1e-20 {
                    continue;
                }
                let next = (multipliers[k] + (-rows[k].gap + 2e-13 - rows[k].dot(&direction)) / norms[k]).max(0.0);
                let delta = next - multipliers[k];
                multipliers[k] = next;
                largest = largest.max(delta.abs());
                if delta != 0.0 {
                    rows[k].axpy(delta, &mut direction);
                }
            }
            if largest < 1e-12 {
                break;
            }
        }
        let max_move = direction.iter().fold(0.0f64, |a, &d| a.max(d.abs()));
        if evaluation.valid && max_move < 5e-14 {
            break;
        }
        let scale = if max_move > trust { trust / max_move } else { 1.0 };
        let mut accepted = false;
        for line in 0..16 {
            if ctx.should_stop() {
                return;
            }
            let fraction = scale * 2f64.powi(-line);
            trial_vars.clear();
            trial_vars.extend(x.iter().zip(direction.iter()).map(|(v, d)| v + fraction * d));
            unpack(&current, &trial_vars, &mut trial);
            // the local container is only a model: the shared geometry recomputes containment
            if !po.restore_separation(ctx, &mut trial) {
                if ctx.should_stop() {
                    return;
                }
                continue;
            }
            if !trial.pieces.iter().all(|q| q.x.is_finite() && q.y.is_finite() && q.theta.is_finite() && q.x.abs() <= 1e6 && q.y.abs() <= 1e6) || !trial.phi.is_finite() {
                continue;
            }
            let Some(result) = ctx.evaluate(&trial, false) else { return };
            let strict = result.valid && result.container.is_some() && po.strictly_feasible(&trial, &result.container.unwrap());
            if strict && result.score.unwrap() < best_score - IMPROVEMENT_FLOOR {
                best_score = result.score.unwrap();
                best = Some(trial.clone());
                best_eval = Some(result.clone());
            }
            if result.container.is_some()
                && ((strict && (!evaluation.valid || result.score.unwrap() < evaluation.score.unwrap() - IMPROVEMENT_FLOOR))
                    || (!evaluation.valid && result.penetration < evaluation.penetration * 0.9))
            {
                current = trial.clone();
                container = result.container.unwrap();
                evaluation = result;
                accepted = true;
                break;
            }
        }
        if accepted {
            stalled = 0;
            trust = max_trust.min(trust * 1.3);
        } else {
            trust *= 0.4;
            stalled += 1;
        }
        if stalled >= 5 || trust < 1e-12 {
            break;
        }
    }
    // once the trust region has settled, snap the final active contacts with Newton projections
    if iterations > 0 {
        for _refinement in 0..8 {
            let Some(b) = best.clone() else { break };
            if ctx.should_stop() || !ctx.checkpoint() {
                return;
            }
            let Some(base) = best_eval.as_ref().and_then(|e| e.container) else { return };
            if po.contacts(&b, &base, 2e-7, &mut rows).is_none() {
                return;
            }
            pack(&b, &base, &mut x);
            direction.clear();
            direction.resize(x.len(), 0.0);
            if rows.is_empty() {
                break;
            }
            norms.clear();
            norms.extend(rows.iter().map(|r| r.norm2()));
            for _sweep in 0..1000 {
                if ctx.should_stop() {
                    return;
                }
                let mut largest = 0.0f64;
                for k in 0..rows.len() {
                    if norms[k] < 1e-20 {
                        continue;
                    }
                    let residual = 2e-13 - rows[k].gap - rows[k].dot(&direction);
                    largest = largest.max(residual.abs());
                    rows[k].axpy(residual / norms[k], &mut direction);
                }
                if largest < 5e-14 {
                    break;
                }
            }
            if direction.iter().fold(0.0f64, |a, &d| a.max(d.abs())) < 5e-14 {
                break;
            }
            let mut improved = false;
            for line in 0..8 {
                if ctx.should_stop() {
                    return;
                }
                let f = 2f64.powi(-line);
                trial_vars.clear();
                trial_vars.extend(x.iter().zip(direction.iter()).map(|(v, d)| v + f * d));
                unpack(&b, &trial_vars, &mut trial);
                if !po.restore_separation(ctx, &mut trial) || !trial.pieces.iter().all(|q| q.x.is_finite() && q.y.is_finite() && q.x.abs() <= 1e6 && q.y.abs() <= 1e6) {
                    continue;
                }
                let Some(result) = ctx.evaluate(&trial, false) else { return };
                if result.valid && result.score.unwrap() < best_score - IMPROVEMENT_FLOOR && po.strictly_feasible(&trial, &result.container.unwrap()) {
                    best = Some(trial.clone());
                    best_score = result.score.unwrap();
                    best_eval = Some(result);
                    improved = true;
                    break;
                }
            }
            if !improved {
                break;
            }
        }
    }
    if let Some(b) = best {
        if !ctx.should_stop() && iterations > 0 && ctx.checkpoint() {
            // the auto-oriented assessment hands the framework the best orientation
            let _ = ctx.evaluate(&b, true);
        }
    }
}

pub fn execute(ctx: &mut Ctx) {
    let params: Params = match serde_json::from_value(ctx.params().clone()) {
        Ok(p) => p,
        Err(e) => return ctx.fail(e.to_string()),
    };
    let Some(start) = ctx.start().cloned() else { return };
    let iterations = params.iterations.unwrap_or(params.max_iterations);
    polish(ctx, &start, iterations, params.contact_tolerance);
}
