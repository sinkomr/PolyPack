//! Basin hopping / iterated local search (packages/solver/src/methods/basin_hopping.ts and
//! basin_hopping/operators.ts, escape.ts, refinement.ts).
//!
//! From a valid arrangement the search repeatedly perturbs it with an adaptively chosen operator
//! (kick, orientation swap, cluster turn, free-region reinsertion, restart from a seed, layer
//! peel, cross cleave), repairs it with a short penalty solve, and accepts the local optimum by
//! the Metropolis rule on the container size. Operators gain weight with their recent rate of
//! improvements; the kick size adapts toward a target acceptance. A share of the budget is kept
//! for a terminal refinement of the best arrangement (a fixed-orientation solve when every piece
//! is near wall alignment, then a tighter unrestricted penalty solve), and a pool of distinct
//! local optima is emitted at the end.
//!
//! Differences from the reference. The removal sizes that rank pieces for reinsertion are computed
//! as enclosures directly: the reference read them from the framework's assessment of a partial
//! arrangement, which this framework scores as invalid without a size. The assessment is still
//! made (and counted, one per piece), so budgets behave as documented. The reference's list of
//! starts from earlier pipeline stages does not exist in a single run; the restart pool holds the
//! supplied start and the automatic seed result.

use super::common::{restore, scatter, PairTester, Strategy};
use super::lbfgs::{Lbfgs, Options, Status};
use super::penalty_method::{self, pack_state, unpack_into, Cap, Descent, Meter, PenaltyObjective, Submit};
use super::seed::congruence_signature;
use super::{fill, params_of, Method};
use crate::enclose::{auto_orient, enclose, Encloser};
use crate::framework::{Ctx, Eval, SubRun};
use crate::penalty::visit_protrusions;
use crate::rng::Rng;
use crate::sep::Shape;
use crate::shapes::{bounding_radius, default_theta, piece_inradius, Config, Pose, MAX_COORD};
use crate::validate::TOL;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f64::consts::PI;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Weights {
    pub kick: f64,
    pub swap: f64,
    pub cluster: f64,
    pub reinsert: f64,
    pub restart: f64,
    pub peel: f64,
    pub cleave: f64,
}

impl Default for Weights {
    fn default() -> Self {
        Weights { kick: 4.0, swap: 1.0, cluster: 2.0, reinsert: 2.0, restart: 0.3, peel: 2.0, cleave: 2.0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub local_evals: u32,
    pub refinement_evals: u32,
    pub alignment_tolerance: f64,
    pub seed_evals: u32,
    pub temperature: f64,
    pub kick_magnitude: f64,
    pub kick_fraction: f64,
    pub rotation_magnitude: f64,
    pub cluster_radius: f64,
    pub reinsertion_trials: u32,
    pub restart_strength: f64,
    pub target_acceptance: f64,
    pub adaptation_rate: f64,
    pub weight_floor: f64,
    pub weights: Weights,
    pub pool_limit: u32,
    pub penalty: penalty_method::Params,
}

/// The local solves are short: six outer and 120 inner iterations.
fn local_penalty_default() -> penalty_method::Params {
    penalty_method::Params { outer_iterations: 6, inner_iterations: 120, ..penalty_method::Params::default() }
}

impl Default for Params {
    fn default() -> Self {
        Params {
            local_evals: 150,
            refinement_evals: 3000,
            alignment_tolerance: 0.01,
            seed_evals: 24,
            temperature: 0.04,
            kick_magnitude: 0.35,
            kick_fraction: 0.4,
            rotation_magnitude: PI / 2.0,
            cluster_radius: 1.8,
            reinsertion_trials: 48,
            restart_strength: 3.0,
            target_acceptance: 0.5,
            adaptation_rate: 0.15,
            weight_floor: 0.2,
            weights: Weights::default(),
            pool_limit: 8,
            penalty: local_penalty_default(),
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
        within("localEvals", self.local_evals as f64, 2.0, 1e6)?;
        within("refinementEvals", self.refinement_evals as f64, 0.0, 1e6)?;
        within("alignmentTolerance", self.alignment_tolerance, 0.0, 0.1)?;
        within("seedEvals", self.seed_evals as f64, 1.0, 10000.0)?;
        within("temperature", self.temperature, 0.0, 1000.0)?;
        within("kickMagnitude", self.kick_magnitude, 0.001, 10.0)?;
        within("kickFraction", self.kick_fraction, 0.0, 1.0)?;
        within("rotationMagnitude", self.rotation_magnitude, 0.0, PI)?;
        within("clusterRadius", self.cluster_radius, 0.0, 10000.0)?;
        within("reinsertionTrials", self.reinsertion_trials as f64, 1.0, 4096.0)?;
        within("restartStrength", self.restart_strength, 1.0, 100.0)?;
        within("targetAcceptance", self.target_acceptance, 0.0, 1.0)?;
        within("adaptationRate", self.adaptation_rate, 0.0, 1.0)?;
        within("weightFloor", self.weight_floor, 0.001, 1.0)?;
        within("poolLimit", self.pool_limit as f64, 0.0, 64.0)?;
        let w = &self.weights;
        for (name, v) in [
            ("weights.kick", w.kick),
            ("weights.swap", w.swap),
            ("weights.cluster", w.cluster),
            ("weights.reinsert", w.reinsert),
            ("weights.restart", w.restart),
            ("weights.peel", w.peel),
            ("weights.cleave", w.cleave),
        ] {
            within(name, v, 0.0, 1000.0)?;
        }
        self.penalty.check()
    }
}

pub fn resolve(given: &Value) -> Result<Value, String> {
    // a given penalty object overrides the local defaults key by key
    let mut given = given.clone();
    if let Value::Object(map) = &mut given {
        match map.get("penalty") {
            Some(Value::Object(over)) => {
                let mut base = serde_json::to_value(local_penalty_default()).map_err(|e| e.to_string())?;
                for (k, v) in over {
                    base[k.as_str()] = v.clone();
                }
                map.insert("penalty".into(), base);
            }
            Some(Value::Null) => {
                map.remove("penalty");
            }
            Some(_) => return Err("penalty must be an object".into()),
            None => {}
        }
    }
    let (v, p) = fill::<Params>(&given)?;
    p.check()?;
    Ok(v)
}

// ---------------------------------------------------------------------------------------------
// operators (basin_hopping/operators.ts, escape.ts)

const OPERATORS: usize = 7;
const KICK: usize = 0;
const SWAP: usize = 1;
const CLUSTER: usize = 2;
const REINSERT: usize = 3;
const RESTART: usize = 4;
const PEEL: usize = 5;
const CLEAVE: usize = 6;

const IMPROVEMENT_THRESHOLD: f64 = 1e-9;

#[inline]
fn bounded(v: f64) -> f64 {
    v.clamp(-MAX_COORD, MAX_COORD)
}

#[inline]
fn wrap_angle(theta: f64) -> f64 {
    theta % (2.0 * PI)
}

#[inline]
fn floor_below(rng: &mut Rng, n: usize) -> usize {
    ((rng.next() * n as f64) as usize).min(n.saturating_sub(1))
}

/// Move a sample without replacement of the pieces (at least one) by uniform offsets and angles.
fn random_kick(config: &Config, rng: &mut Rng, magnitude: f64, fraction: f64, rotation: f64) -> Config {
    let mut result = config.clone();
    let count_all = config.pieces.len();
    let mut ids: Vec<usize> = (0..count_all).collect();
    let count = ((fraction * count_all as f64).ceil() as usize).max(1);
    for k in 0..count.min(count_all) {
        let j = k + floor_below(rng, count_all - k);
        ids.swap(k, j);
        let p = &mut result.pieces[ids[k]];
        p.x = bounded(p.x + magnitude * (2.0 * rng.next() - 1.0));
        p.y = bounded(p.y + magnitude * (2.0 * rng.next() - 1.0));
        p.theta = if config.n == 0 { 0.0 } else { wrap_angle(wrap_angle(p.theta) + rotation * (2.0 * rng.next() - 1.0)) };
    }
    result
}

/// Congruent positions are indistinguishable: exchange the angles of two pieces, not whole poses.
fn swap_orientations(config: &Config, rng: &mut Rng) -> Config {
    let mut result = config.clone();
    let count = config.pieces.len();
    if count < 2 || config.n == 0 {
        return result;
    }
    let nf = config.n as f64;
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    for i in 0..count {
        for j in i + 1..count {
            if (nf * (config.pieces[i].theta - config.pieces[j].theta) / 2.0).sin().abs() > 1e-9 {
                pairs.push((i as u32, j as u32));
            }
        }
    }
    if pairs.is_empty() {
        return result;
    }
    let (i, j) = pairs[floor_below(rng, pairs.len())];
    let (i, j) = (i as usize, j as usize);
    let (ti, tj) = (result.pieces[i].theta, result.pieces[j].theta);
    result.pieces[i].theta = tj;
    result.pieces[j].theta = ti;
    result
}

/// Turn the pieces within `radius` bounding diameters of a random pivot about their centroid.
fn rotate_cluster(config: &Config, rng: &mut Rng, radius: f64, rotation: f64) -> Config {
    let mut result = config.clone();
    let pivot = config.pieces[floor_below(rng, config.pieces.len())];
    let reach = radius * 2.0 * bounding_radius(config.n);
    let ids: Vec<usize> = (0..config.pieces.len()).filter(|&i| (config.pieces[i].x - pivot.x).hypot(config.pieces[i].y - pivot.y) <= reach).collect();
    if ids.len() < 2 {
        return result;
    }
    let count = ids.len() as f64;
    let cx = ids.iter().map(|&i| config.pieces[i].x).sum::<f64>() / count;
    let cy = ids.iter().map(|&i| config.pieces[i].y).sum::<f64>() / count;
    let turn = rotation * (2.0 * rng.next() - 1.0);
    let (s, c) = turn.sin_cos();
    let mut moved = Vec::with_capacity(ids.len());
    for &i in &ids {
        let p = config.pieces[i];
        let (dx, dy) = (p.x - cx, p.y - cy);
        moved.push(Pose::new(cx + c * dx - s * dy, cy + s * dx + c * dy, if config.n == 0 { 0.0 } else { wrap_angle(wrap_angle(p.theta) + turn) }));
    }
    // reject the entire rigid move at the coordinate boundary: clipping single centres would
    // destroy the pair-distance invariant of a cluster rotation
    if moved.iter().any(|p| p.x.abs() > MAX_COORD || p.y.abs() > MAX_COORD) {
        return result;
    }
    for (k, &i) in ids.iter().enumerate() {
        result.pieces[i] = moved[k];
    }
    result
}

/// Auto-oriented enclosing size of the pieces (the score the framework would give them).
fn oriented_size(n: u32, m: u32, pieces: &[Pose], phi: f64) -> f64 {
    auto_orient(n, pieces, m, phi).size
}

/// Test fitting angles at sampled centres inside the existing enclosure and put the piece at the
/// most compact (then clearest) one. Exact-sized holes have zero area in centre space, so the
/// container centre and the removed piece's own centre are always among the samples.
fn reinsertion(ctx: &mut Ctx, config: &Config, removed: usize, trials: u32) -> Config {
    let mut result = config.clone();
    let n = config.n;
    let m = config.m;
    let fixed: Vec<Pose> = config.pieces.iter().enumerate().filter(|(i, _)| *i != removed).map(|(_, p)| *p).collect();
    if fixed.is_empty() {
        result.pieces[removed].theta = if n == 0 { 0.0 } else { 2.0 * PI * ctx.rng.next() };
        return result;
    }
    let container = enclose(n, &config.pieces, m, config.phi);
    let reach = if m == 0 { container.size / 2.0 } else { container.size / (2.0 * (PI / m as f64).sin()) };
    let (lo_x, hi_x) = (bounded(container.cx - reach), bounded(container.cx + reach));
    let (lo_y, hi_y) = (bounded(container.cy - reach), bounded(container.cy + reach));
    let shape = Shape::new(n);
    let mut encloser = Encloser::new(n, m);
    let mut work = config.pieces.clone();
    struct Choice {
        pose: Pose,
        clearance: f64,
        size: f64,
    }
    let mut best: Option<Choice> = None;
    let mut scanned = 0usize;
    let mut order: Vec<usize> = Vec::new();
    let mut angles: Vec<f64> = Vec::new();
    let mut unique: Vec<f64> = Vec::new();
    for t in 0..trials {
        if t % 4 == 0 && !ctx.checkpoint() {
            return config.clone();
        }
        if ctx.should_stop() {
            return result;
        }
        let x = bounded(if t == 0 { container.cx } else if t == 1 { config.pieces[removed].x } else { lo_x + (hi_x - lo_x) * ctx.rng.next() });
        let y = bounded(if t == 0 { container.cy } else if t == 1 { config.pieces[removed].y } else { lo_y + (hi_y - lo_y) * ctx.rng.next() });
        angles.clear();
        angles.push(if n == 0 { 0.0 } else { 2.0 * PI * ctx.rng.next() });
        if n != 0 {
            order.clear();
            order.extend(0..fixed.len());
            order.sort_by(|&a, &b| {
                let da = (fixed[a].x - x).hypot(fixed[a].y - y);
                let db = (fixed[b].x - x).hypot(fixed[b].y - y);
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            });
            for &k in order.iter().take(4) {
                angles.push(fixed[k].theta);
                angles.push(fixed[k].theta + PI / n as f64);
            }
            for j in 0..m.min(8) {
                angles.push(container.phi + default_theta(n) + 2.0 * PI * j as f64 / m as f64);
            }
        }
        unique.clear();
        for &theta in &angles {
            if unique.iter().any(|&a| n == 0 || (n as f64 * (theta - a) / 2.0).sin().abs() < 1e-9) {
                continue;
            }
            unique.push(theta);
            let pose = Pose::new(x, y, wrap_angle(theta));
            let mut outside = false;
            visit_protrusions(n, &pose, &container, false, 1.0, 0.0, |pr| {
                if pr.depth > 1e-12 {
                    outside = true;
                }
            });
            if outside {
                continue;
            }
            let mut clearance = f64::INFINITY;
            for q in &fixed {
                if scanned % 256 == 0 && !ctx.checkpoint() {
                    return config.clone();
                }
                scanned += 1;
                if ctx.should_stop() {
                    return result;
                }
                clearance = clearance.min(shape.sep(&pose, q));
                if clearance < 0.0 {
                    break;
                }
            }
            if clearance < 0.0 {
                continue;
            }
            work[removed] = pose;
            let size = encloser.enclose(&work, container.phi).size;
            let better = match &best {
                None => true,
                Some(b) => size < b.size - 1e-12 || ((size - b.size).abs() <= 1e-12 && clearance > b.clearance),
            };
            if better {
                best = Some(Choice { pose, clearance, size });
            }
        }
    }
    if let Some(b) = best {
        result.pieces[removed] = b.pose;
    }
    result
}

/// Piece symmetry matters: exchanging equivalent angles is still an exact no-op.
fn same_packing(a: &Config, b: &Config) -> bool {
    a.pieces.iter().zip(b.pieces.iter()).all(|(p, q)| {
        (p.x - q.x).abs() < 1e-12 && (p.y - q.y).abs() < 1e-12 && (a.n == 0 || (a.n as f64 * (p.theta - q.theta) / 2.0).sin().abs() < 1e-9)
    })
}

/// Kick a random seed (or the current packing, without one) at every piece.
fn global_restart(config: &Config, seeds: &[Config], rng: &mut Rng, magnitude: f64, rotation: f64) -> Config {
    let matching: Vec<&Config> = seeds.iter().filter(|s| s.n == config.n && s.m == config.m && s.pieces.len() == config.pieces.len()).collect();
    let seed = if matching.is_empty() { config } else { matching[floor_below(rng, matching.len())] };
    random_kick(seed, rng, magnitude, 1.0, rotation)
}

/// Remove large absolute offsets without leaving the coordinate box.
fn center_local_start(config: &Config) -> Option<Config> {
    let anchor = config.pieces[0];
    let count = config.pieces.len() as f64;
    let mut cx = anchor.x + config.pieces.iter().map(|p| p.x - anchor.x).sum::<f64>() / count;
    let mut cy = anchor.y + config.pieces.iter().map(|p| p.y - anchor.y).sum::<f64>() / count;
    // close-to-origin inputs retain their bits; at large offsets the penalty method's translation
    // back could erase its much smaller separation margin
    if cx.abs() <= 32.0 && cy.abs() <= 32.0 {
        return None;
    }
    if config.pieces.iter().any(|p| (p.x - cx).abs() > MAX_COORD || (p.y - cy).abs() > MAX_COORD) {
        let (mut x0, mut x1, mut y0, mut y1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for p in &config.pieces {
            x0 = x0.min(p.x);
            x1 = x1.max(p.x);
            y0 = y0.min(p.y);
            y1 = y1.max(p.y);
        }
        cx = (x0 + x1) / 2.0;
        cy = (y0 + y1) / 2.0;
    }
    let mut out = config.clone();
    for p in &mut out.pieces {
        p.x -= cx;
        p.y -= cy;
    }
    Some(out)
}

/// A child start is assessed before repair: close that tolerance-band shortcut by restoring a
/// start whose overlaps all lie inside the validity tolerance.
fn strict_local_start(ctx: &mut Ctx, config: Config, tester: &mut PairTester) -> Option<Config> {
    if tester.any_below(&config.pieces, 1e-12) && !tester.any_below(&config.pieces, TOL) {
        return restore(ctx, &config, Strategy::Separate, true, MAX_COORD, tester, None);
    }
    Some(config)
}

/// Layer peel: empty the outermost layer of pieces along one container wall normal, moving each of
/// its pieces into a free lattice-adjacent site further inside.
///
/// Near-lattice packings of P just above a perfect square (the (k+1)-grid holding k^2+1 squares)
/// have their spare room as scattered single-cell holes, and an exact piece-sized hole has zero
/// area in centre space: the random reinsertion cannot hit it. Candidate sites here are the
/// edge-reflected neighbours of every remaining piece (centre at twice the inradius along an edge
/// normal, the reflected orientation; six unit-distance-two neighbours for circles), which include
/// every lattice hole. A site must lie at least one layer inward of the peeled layer, inside the
/// current enclosure up to 1e-9, and clear (up to 1e-9) of placed pieces and of the layer pieces
/// still to be moved. Peeled pieces go, in random order, to a uniformly chosen valid site; a
/// piece without one keeps its pose.
fn peel_layer(ctx: &mut Ctx, config: &Config) -> Config {
    let mut result = config.clone();
    let count = config.pieces.len();
    if count < 2 {
        return result;
    }
    let n = config.n;
    let m = config.m;
    let container = enclose(n, &config.pieces, m, config.phi);
    let direction = if m == 0 { 2.0 * PI * ctx.rng.next() } else { container.phi - PI / 2.0 + 2.0 * PI * floor_below(&mut ctx.rng, m as usize) as f64 / m as f64 };
    let (ny, nx) = direction.sin_cos();
    let depth = |x: f64, y: f64| (x - container.cx) * nx + (y - container.cy) * ny;
    let half = piece_inradius(n);
    let outer = config.pieces.iter().map(|p| depth(p.x, p.y)).fold(f64::NEG_INFINITY, f64::max);
    let mut layer: Vec<usize> = (0..count).filter(|&i| depth(config.pieces[i].x, config.pieces[i].y) > outer - half).collect();
    if layer.len() == count {
        return result;
    }
    let mut in_layer = vec![false; count];
    for &i in &layer {
        in_layer[i] = true;
    }
    let mut placed: Vec<Pose> = (0..count).filter(|&i| !in_layer[i]).map(|i| config.pieces[i]).collect();
    let reach = 2.0 * bounding_radius(n);
    let sides = if n == 0 { 6 } else { n as usize };
    let flip = if n % 2 == 1 { PI / n as f64 } else { 0.0 };
    let shape = Shape::new(n);
    let mut work = 0usize;
    // Fisher-Yates order of the layer, from the seeded stream
    for k in (1..layer.len()).rev() {
        let j = floor_below(&mut ctx.rng, k + 1);
        layer.swap(k, j);
    }
    let mut sites: Vec<Pose> = Vec::new();
    for pos in 0..layer.len() {
        let index = layer[pos];
        // layer pieces not yet moved still occupy their poses: for shapes whose layer is thinner
        // than a whole cell, an inner site can touch them
        let pending = &layer[pos + 1..];
        sites.clear();
        for qi in 0..placed.len() {
            let q = placed[qi];
            for e in 0..sides {
                if work % 256 == 0 && !ctx.checkpoint() {
                    return config.clone();
                }
                work += 1;
                if ctx.should_stop() {
                    return result;
                }
                let normal = if n == 0 { PI * e as f64 / 3.0 } else { q.theta + PI / 2.0 + PI / n as f64 + 2.0 * PI * e as f64 / n as f64 };
                let pose = Pose::new(q.x + 2.0 * half * normal.cos(), q.y + 2.0 * half * normal.sin(), if n == 0 { 0.0 } else { wrap_angle(q.theta + flip) });
                if depth(pose.x, pose.y) > outer - 2.0 * half + 1e-9 {
                    continue;
                }
                if pose.x.abs() > MAX_COORD || pose.y.abs() > MAX_COORD {
                    continue;
                }
                let mut outside = false;
                visit_protrusions(n, &pose, &container, false, 1.0, 0.0, |pr| {
                    if pr.depth > 1e-9 {
                        outside = true;
                    }
                });
                if outside {
                    continue;
                }
                let blocked = |other: &Pose| {
                    let dx = other.x - pose.x;
                    let dy = other.y - pose.y;
                    dx * dx + dy * dy < reach * reach && shape.sep(&pose, other) < -1e-9
                };
                // different neighbours can name the same hole; duplicates only reweight the draw
                if !placed.iter().any(&blocked) && !pending.iter().any(|&i| blocked(&config.pieces[i])) {
                    sites.push(pose);
                }
            }
        }
        if sites.is_empty() {
            placed.push(config.pieces[index]);
            continue;
        }
        let site = sites[floor_below(&mut ctx.rng, sites.len())];
        result.pieces[index] = site;
        placed.push(site);
    }
    result
}

/// Cross cleave: move one piece into a cross-shaped gap opened at a piece vertex, turned by half a
/// piece symmetry period.
///
/// Two distinct container wall normals u1, u2 are drawn (a random direction and its perpendicular
/// for circle containers). Every other piece on the positive side of the vertex X along u_i is
/// translated by delta u_i, delta uniform in [0.75, 1.25] piece circumradii. The piece whose
/// removal shrinks the enclosure most (ties broken at random) is placed at the gap centre
/// X + delta (u1 + u2) / 2, with the orientation of the vertex's owner plus pi/N. For k^2+1 squares
/// packed as a k-by-k block plus one protruding square, X at the block centre, perpendicular
/// normals and delta >= 1/sqrt(2), this is the valid k + delta arrangement of four corner blocks
/// around a 45-degree square. In general it is a large structured kick that the local solve then
/// compresses. The ranking costs P analytic enclosures and no assessments.
fn cross_cleave(ctx: &mut Ctx, config: &Config) -> Config {
    let mut result = config.clone();
    let count = config.pieces.len();
    if count < 3 {
        return result;
    }
    let n = config.n;
    let m = config.m;
    let container = enclose(n, &config.pieces, m, config.phi);
    let normal = |j: usize| container.phi - PI / 2.0 + 2.0 * PI * j as f64 / m as f64;
    let (a1, a2);
    if m == 0 {
        a1 = 2.0 * PI * ctx.rng.next();
        a2 = a1 + if ctx.rng.next() < 0.5 { 1.0 } else { -1.0 } * (PI / 2.0);
    } else {
        let mu = m as usize;
        let j1 = floor_below(&mut ctx.rng, mu);
        let j2 = (j1 + 1 + floor_below(&mut ctx.rng, mu - 1)) % mu;
        a1 = normal(j1);
        a2 = normal(j2);
    }
    let u1 = (a1.cos(), a1.sin());
    let u2 = (a2.cos(), a2.sin());
    let mut encloser = Encloser::new(n, m);
    let mut rest: Vec<Pose> = Vec::with_capacity(count);
    let mut sizes = Vec::with_capacity(count);
    for i in 0..count {
        if ctx.should_stop() {
            return result;
        }
        rest.clear();
        rest.extend(config.pieces.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, p)| *p));
        sizes.push(encloser.enclose(&rest, container.phi).size);
    }
    let smallest = sizes.iter().cloned().fold(f64::INFINITY, f64::min);
    let tied: Vec<usize> = (0..count).filter(|&i| sizes[i] <= smallest + 1e-9).collect();
    if tied.is_empty() {
        return result; // not-a-number sizes: no ranking
    }
    let moved = tied[floor_below(&mut ctx.rng, tied.len())];
    let others: Vec<usize> = (0..count).filter(|&i| i != moved).collect();
    let owner = config.pieces[others[floor_below(&mut ctx.rng, others.len())]];
    let corner = if n == 0 { 2.0 * PI * ctx.rng.next() } else { owner.theta + PI / 2.0 + 2.0 * PI * floor_below(&mut ctx.rng, n as usize) as f64 / n as f64 };
    let reach = bounding_radius(n);
    let (xx, xy) = (owner.x + reach * corner.cos(), owner.y + reach * corner.sin());
    let delta = reach * (0.75 + 0.5 * ctx.rng.next());
    for &i in &others {
        let p = &mut result.pieces[i];
        let (dx, dy) = (p.x - xx, p.y - xy);
        if dx * u1.0 + dy * u1.1 > 0.0 {
            p.x += delta * u1.0;
            p.y += delta * u1.1;
        }
        if dx * u2.0 + dy * u2.1 > 0.0 {
            p.x += delta * u2.0;
            p.y += delta * u2.1;
        }
    }
    // the gap is centred half a push beyond X along both directions
    result.pieces[moved] = Pose::new(
        xx + delta / 2.0 * (u1.0 + u2.0),
        xy + delta / 2.0 * (u1.1 + u2.1),
        if n == 0 { 0.0 } else { wrap_angle(owner.theta + PI / n as f64) },
    );
    if result.pieces.iter().any(|p| p.x.abs() > MAX_COORD || p.y.abs() > MAX_COORD) {
        return config.clone();
    }
    result
}

// ---------------------------------------------------------------------------------------------
// terminal refinement near wall alignment (basin_hopping/refinement.ts)

/// Submissions of the fixed-orientation solve: the iterate is restored and assessed as it is.
struct AlignedSubmitter<'o> {
    meter: Meter<'o>,
    tester: PairTester,
    n: u32,
    m: u32,
    p: usize,
    trial: Config,
}

impl<'o> Submit for AlignedSubmitter<'o> {
    fn submit(&mut self, ctx: &mut Ctx, x: &[f64]) -> bool {
        if self.meter.stopped(ctx) {
            return false;
        }
        self.trial.phi = unpack_into(self.n, self.m, self.p, x, &mut self.trial.pieces);
        match restore(ctx, &self.trial, Strategy::Separate, true, MAX_COORD, &mut self.tester, None) {
            Some(config) => self.meter.evaluate(ctx, &config, false).is_some(),
            None => false,
        }
    }
    fn stopped(&self, ctx: &mut Ctx) -> bool {
        self.meter.stopped(ctx)
    }
    fn checkpoint(&mut self, ctx: &mut Ctx) -> bool {
        self.meter.checkpoint(ctx)
    }
}

/// Near wall alignment, tiny angular errors can converge much more slowly than translations. Try
/// a penalty solve with the angles fixed at the aligned values, in the container's frame,
/// retaining the unrestricted best. No packing template or published score is used.
fn refine_aligned(ctx: &mut Ctx, meter: Meter, start: &Config, tolerance: f64) {
    let (n, m, np) = (start.n, start.m, start.pieces.len());
    if n == 0 || m == 0 || tolerance == 0.0 || meter.stopped(ctx) {
        return;
    }
    let container = enclose(n, &start.pieces, m, start.phi);
    let period = 2.0 * PI / n as f64;
    let (s, c) = container.phi.sin_cos();
    let mut pieces = Vec::with_capacity(np);
    for p in &start.pieces {
        let theta = p.theta - container.phi;
        let mut target = theta;
        let mut error = f64::INFINITY;
        for j in 0..m {
            // piece face and vertex normals aligned with each container wall normal
            for phase in [-PI - PI / n as f64, -PI] {
                let base = phase + 2.0 * PI * j as f64 / m as f64;
                let aligned = base + ((theta - base) / period).round() * period;
                if (theta - aligned).abs() < error {
                    error = (theta - aligned).abs();
                    target = aligned;
                }
            }
        }
        let dx = p.x - container.cx;
        let dy = p.y - container.cy;
        if error > tolerance || (c * dx + s * dy).abs() > MAX_COORD || (-s * dx + c * dy).abs() > MAX_COORD {
            return;
        }
        pieces.push(Pose::new(c * dx + s * dy, -s * dx + c * dy, target));
    }
    let template = Config { n, m, pieces, phi: 0.0 };
    let mut x = Vec::new();
    pack_state(n, m, &template.pieces, &enclose(n, &template.pieces, m, 0.0), &mut x);
    let mut objective = PenaltyObjective::new(n, m, np, 1.0, 0.0, true);
    let mut solver = Lbfgs::new();
    let options = Options { iterations: 200, memory: 12, tolerance: 1e-11 };
    let mut sub = AlignedSubmitter { meter, tester: PairTester::new(n), n, m, p: np, trial: Config { n, m, pieces: Vec::with_capacity(np), phi: 0.0 } };
    let mut weight = 100.0;
    for _outer in 0..20 {
        if sub.meter.stopped(ctx) || !sub.meter.checkpoint(ctx) {
            return;
        }
        objective.begin(weight);
        let result = {
            let mut descent = Descent { ctx: &mut *ctx, objective: &mut objective, sub: &mut sub, restrict: true };
            solver.minimize(&mut x, &options, &mut descent)
        };
        if result.status == Status::Stopped || result.status == Status::Nonfinite {
            return;
        }
        if !sub.submit(ctx, &x) {
            return;
        }
        objective.update_multipliers(&x);
        weight = (weight * 4.0).min(1e10);
    }
}

// ---------------------------------------------------------------------------------------------
// the method

/// The best strictly valid arrangement seen (no pair below -1e-12) and its score.
struct Best {
    config: Option<Config>,
    score: f64,
    tester: PairTester,
}

impl Best {
    fn new(n: u32) -> Self {
        Best { config: None, score: f64::INFINITY, tester: PairTester::new(n) }
    }
    fn track(&mut self, config: &Config, phi: f64, score: Option<f64>) {
        if let Some(score) = score {
            if score < self.score && !self.tester.any_below(&config.pieces, 1e-12) {
                let mut c = config.clone();
                c.phi = phi;
                self.config = Some(c);
                self.score = score;
            }
        }
    }
    fn track_plain(&mut self, config: &Config, score: Option<f64>) {
        self.track(config, config.phi, score);
    }
    fn track_eval(&mut self, config: &Config, eval: &Eval) {
        if let (true, Some(c)) = (eval.valid, eval.container) {
            self.track(config, c.phi, eval.score);
        }
    }
}

struct Member {
    config: Config,
    score: f64,
    key: (i64, u32, u32),
}

/// Keep the arrangement in the pool of distinct local optima (by congruence class), best first.
fn remember(pool: &mut Vec<Member>, limit: usize, tester: &mut PairTester, config: &Config, score: f64) {
    if limit == 0 || tester.any_below(&config.pieces, 1e-12) {
        return;
    }
    let key = congruence_signature(config, score);
    match pool.iter_mut().find(|m| m.key == key) {
        None => pool.push(Member { config: config.clone(), score, key }),
        Some(member) => {
            if score < member.score {
                member.config = config.clone();
                member.score = score;
            }
        }
    }
    pool.sort_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal));
    pool.truncate(limit);
}

/// No draw for strict improvements or temperature zero; finite ties are accepted at T > 0.
fn metropolis(current: f64, candidate: f64, temperature: f64, rng: &mut Rng) -> bool {
    if !candidate.is_finite() || !current.is_finite() {
        return false;
    }
    if candidate < current {
        return true;
    }
    if temperature <= 0.0 {
        return false;
    }
    rng.next() < (-(candidate - current) / temperature).exp()
}

fn choose_operator(base: &[f64; OPERATORS], rate: &[f64; OPERATORS], floor: f64, rng: &mut Rng) -> usize {
    let mut effective = [0.0; OPERATORS];
    let mut total = 0.0;
    for k in 0..OPERATORS {
        effective[k] = base[k] * (floor + rate[k]);
        total += effective[k];
    }
    if total == 0.0 {
        return KICK;
    }
    let mut draw = rng.next() * total;
    for k in 0..OPERATORS {
        draw -= effective[k];
        if draw < 0.0 {
            return k;
        }
    }
    for k in (0..OPERATORS).rev() {
        if effective[k] > 0.0 {
            return k;
        }
    }
    KICK
}

/// What the local solves share.
struct Local<'a> {
    p: &'a Params,
    penalty: &'a Value,
    time_reserve: f64,
    tester: PairTester,
}

impl<'a> Local<'a> {
    /// A short penalty solve from `start`, clipped to the budget less `reserve` assessments.
    fn solve(&mut self, ctx: &mut Ctx, best: &mut Best, start: &Config, reserve: f64) -> Option<SubRun> {
        if ctx.should_stop() {
            return None;
        }
        let (rem_evals, rem_time) = ctx.remaining();
        let evals = (self.p.local_evals as f64).min(rem_evals - reserve);
        if evals < 1.0 {
            return None;
        }
        let centred = center_local_start(start);
        let guarded = strict_local_start(ctx, centred.unwrap_or_else(|| start.clone()), &mut self.tester)?;
        if ctx.should_stop() {
            return None;
        }
        let time = if self.time_reserve > 0.0 { Some((rem_time - self.time_reserve).max(0.0)) } else { None };
        let result = ctx.run(Method::Penalty, self.penalty, Some(guarded), Some(evals as u64), time);
        if let Some(b) = &result.best {
            best.track_plain(b, result.score);
        }
        Some(result)
    }
}

pub fn execute(ctx: &mut Ctx) {
    let Some(p) = params_of::<Params>(ctx) else { return };
    let problem = ctx.problem;
    let (n, m, np) = (problem.n, problem.m, problem.p);
    if np == 0 {
        return;
    }
    let limit = p.pool_limit as usize;
    let penalty_json = serde_json::to_value(&p.penalty).unwrap_or(Value::Null);
    let mut pool: Vec<Member> = Vec::new();
    let mut seeds: Vec<Config> = Vec::new();
    let mut best = Best::new(n);
    let mut pool_tester = PairTester::new(n);
    // This reserve belongs to the method, in addition to the framework's polish reserve.
    // Unlimited-evaluation runs cannot promise a final refinement slice. A finite time limit gets
    // a terminal reserve too, also when evaluations are limited: with both limits time usually
    // binds first for large P, and an evaluation reserve alone never reached refinement.
    let (initial_allowance, initial_time) = ctx.remaining();
    let time_reserve = if initial_time.is_finite() && p.refinement_evals > 0 { initial_time / 6.0 } else { 0.0 };
    let final_reserve = if initial_allowance.is_finite() { (p.refinement_evals as f64).min((initial_allowance / 6.0).floor()) } else { 0.0 };
    let mut local = Local { p: &p, penalty: &penalty_json, time_reserve, tester: PairTester::new(n) };

    if !ctx.checkpoint() {
        return;
    }
    let mut current: Option<Config> = ctx.start().filter(|s| s.pieces.len() == np).cloned();
    let mut current_score: Option<f64> = ctx.initial_evaluation().filter(|e| e.valid).and_then(|e| e.score);
    if let Some(c) = &current {
        seeds.push(c.clone());
        best.track_plain(c, current_score);
    }
    {
        let evals = (p.seed_evals as f64).min(ctx.remaining().0);
        if evals >= 1.0 {
            let seeded = ctx.run(Method::Seed, &serde_json::json!({ "kind": "auto" }), None, Some(evals as u64), None);
            if let Some(b) = &seeded.best {
                best.track_plain(b, seeded.score);
            }
            if current.is_none() {
                current = seeded.found.clone();
                current_score = seeded.found_score;
            }
            if let Some(f) = seeded.found {
                seeds.push(f);
            }
        }
    }
    if ctx.should_stop() {
        return;
    }
    if let (Some(c), None) = (&current, current_score) {
        let c = c.clone();
        let repaired = local.solve(ctx, &mut best, &c, limit.min(1) as f64);
        current = repaired.as_ref().and_then(|r| r.found.clone());
        current_score = repaired.as_ref().and_then(|r| r.found_score);
    }
    if current.is_none() || current_score.is_none() {
        let fallback = scatter(problem, || ctx.rng.next());
        if let Some(result) = ctx.evaluate(&fallback, true) {
            if let (true, Some(score), Some(container)) = (result.valid, result.score, result.container) {
                let mut c = fallback;
                c.phi = container.phi;
                seeds.push(c.clone());
                best.track_plain(&c, Some(score));
                current = Some(c);
                current_score = Some(score);
            }
        }
    }
    let (Some(mut cur), Some(mut cur_score)) = (current, current_score) else { return };
    if ctx.should_stop() {
        return;
    }
    let first = local.solve(ctx, &mut best, &cur, final_reserve + limit.min(1) as f64);
    if let Some(f) = first {
        if let (Some(c), Some(s)) = (f.found, f.found_score) {
            cur = c;
            cur_score = s;
        }
    }
    remember(&mut pool, limit, &mut pool_tester, &cur, cur_score);

    let mut redraws = 0u32;
    let mut kick_magnitude = p.kick_magnitude;
    let mut rate = [0.0f64; OPERATORS];
    loop {
        if ctx.should_stop() {
            break;
        }
        let (rem_evals, rem_time) = ctx.remaining();
        if !(rem_evals > final_reserve + pool.len() as f64 && rem_time > time_reserve) {
            break;
        }
        if !ctx.checkpoint() {
            break;
        }
        let before = ctx.evaluations;
        let reserve = final_reserve + limit.min(pool.len() + 1) as f64;
        if ctx.remaining().0 <= reserve {
            let _ = ctx.evaluate(&cur, true);
            break;
        }
        let w = &p.weights;
        let mut weights = [w.kick, w.swap, w.cluster, w.reinsert, w.restart, w.peel, w.cleave];
        if n == 0 {
            weights[SWAP] = 0.0;
        }
        if ctx.remaining().0 < reserve + np as f64 + 1.0 {
            weights[REINSERT] = 0.0;
        }
        // An operator-only parameter set can have no legal move. Bounded redraws fall back to a
        // kick, rather than burning solves or looping forever.
        if redraws >= 8 {
            weights = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        }
        let operator = choose_operator(&weights, &rate, p.weight_floor, &mut ctx.rng);
        let perturbed = match operator {
            SWAP => swap_orientations(&cur, &mut ctx.rng),
            PEEL => peel_layer(ctx, &cur),
            CLEAVE => cross_cleave(ctx, &cur),
            CLUSTER => rotate_cluster(&cur, &mut ctx.rng, p.cluster_radius, p.rotation_magnitude),
            RESTART => global_restart(&cur, &seeds, &mut ctx.rng, kick_magnitude * p.restart_strength, p.rotation_magnitude),
            REINSERT => {
                // The piece whose removal shrinks the (auto-oriented) enclosure most. Each removal
                // is one counted assessment of the partial arrangement, as in the reference; the
                // framework scores a partial arrangement as invalid without a size, so the size
                // comes from the enclosure directly.
                let mut worst = 0;
                let mut smallest = f64::INFINITY;
                if np > 1 {
                    let mut partial = Config { n, m, pieces: Vec::with_capacity(np), phi: cur.phi };
                    for i in 0..np {
                        if ctx.should_stop() || ctx.remaining().0 <= reserve + 1.0 {
                            break;
                        }
                        partial.pieces.clear();
                        partial.pieces.extend(cur.pieces.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, q)| *q));
                        if ctx.evaluate(&partial, true).is_none() {
                            break;
                        }
                        let size = oriented_size(n, m, &partial.pieces, cur.phi);
                        if size < smallest {
                            smallest = size;
                            worst = i;
                        }
                    }
                }
                reinsertion(ctx, &cur, worst, p.reinsertion_trials)
            }
            _ => random_kick(&cur, &mut ctx.rng, kick_magnitude, p.kick_fraction, p.rotation_magnitude),
        };
        if ctx.should_stop() {
            break;
        }
        if same_packing(&cur, &perturbed) {
            redraws += 1;
            continue;
        }
        redraws = 0;
        let result = local.solve(ctx, &mut best, &perturbed, reserve);
        let candidate = result.as_ref().and_then(|r| r.found.clone());
        let raw = result.as_ref().and_then(|r| r.found_score);
        let previous = cur_score;
        // float64 score noise is a tie; the actual score stays in the framework's best tracker
        let score = raw.map(|r| if (r - cur_score).abs() <= IMPROVEMENT_THRESHOLD { cur_score } else { r });
        let improved = score.map_or(false, |s| s < cur_score);
        let accepted = match (&candidate, score) {
            (Some(_), Some(s)) => metropolis(cur_score, s, p.temperature, &mut ctx.rng),
            _ => false,
        };
        if accepted {
            cur = candidate.clone().unwrap();
            cur_score = score.unwrap();
        }
        let r = p.adaptation_rate;
        rate[operator] = (1.0 - r) * rate[operator] + r * if improved { 1.0 } else { 0.0 };
        if operator == KICK && raw.map_or(true, |x| (x - previous).abs() > IMPROVEMENT_THRESHOLD) {
            let step = (r * (if accepted { 1.0 } else { 0.0 } - p.target_acceptance)).exp();
            kick_magnitude = (kick_magnitude * step).min(10.0).max(0.001);
        }
        if let (Some(c), Some(x)) = (&candidate, raw) {
            if !ctx.should_stop() {
                remember(&mut pool, limit, &mut pool_tester, c, x);
            }
        }
        // failed local solves can consume nothing: force progress
        if ctx.evaluations == before && !ctx.should_stop() {
            let _ = ctx.evaluate(&cur, true);
        }
    }

    // Terminal refinement. The solves reuse the penalty driver under a scoped cap: every
    // assessment still goes through the framework, and this solve is not a hop.
    if best.config.is_some() && final_reserve > 0.0 && !ctx.should_stop() {
        let cap = (ctx.remaining().0 - pool.len() as f64).max(0.0);
        let base = ctx.evaluations;
        let start = best.config.clone().unwrap();
        if let Some(initial) = ctx.evaluate(&start, true) {
            let _ = initial;
            let first_cap = cap.min((cap / 2.0).ceil());
            let refine = refinement_params(&p.penalty);
            {
                let mut observe = |config: &Config, eval: &Eval| best.track_eval(config, eval);
                let meter = Meter { cap: Cap::since(base, first_cap), observer: Some(&mut observe) };
                refine_aligned(ctx, meter, &start, p.alignment_tolerance);
            }
            let stopped_by_cap = |ctx: &Ctx| Cap::since(base, cap).hit(ctx);
            if best.config.is_some() && !ctx.should_stop() && !stopped_by_cap(ctx) {
                let current_best = best.config.clone().unwrap();
                let next = {
                    let mut observe = |config: &Config, eval: &Eval| best.track_eval(config, eval);
                    let mut meter = Meter { cap: Cap::since(base, cap), observer: Some(&mut observe) };
                    meter.evaluate(ctx, &current_best, true)
                };
                if let Some(next) = next {
                    let mut observe = |config: &Config, eval: &Eval| best.track_eval(config, eval);
                    let meter = Meter { cap: Cap::since(base, cap), observer: Some(&mut observe) };
                    penalty_method::solve(ctx, &refine, Some((current_best, Some(next))), meter);
                }
            }
            if let Some(b) = best.config.clone() {
                remember(&mut pool, limit, &mut pool_tester, &b, best.score);
            }
        }
    }
    if best.config.is_some() && !initial_allowance.is_finite() && time_reserve > 0.0 && !ctx.should_stop() {
        let refine = refinement_params(&p.penalty);
        let json = serde_json::to_value(&refine).unwrap_or(Value::Null);
        let start = best.config.clone().unwrap();
        let time = ctx.remaining().1;
        let result = ctx.run(Method::Penalty, &json, Some(start), Some(p.refinement_evals as u64), Some(time));
        if let Some(b) = &result.best {
            best.track_plain(b, result.score);
        }
        if let Some(b) = best.config.clone() {
            remember(&mut pool, limit, &mut pool_tester, &b, best.score);
        }
    }
    // Members were ranked by the score of the search that produced them, which may be at a fixed
    // phi. Emit them best first by the framework's auto-oriented score, which is what a next
    // stage sees.
    for member in pool.iter_mut() {
        member.score = oriented_size(n, m, &member.config.pieces, member.config.phi);
    }
    pool.sort_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal));
    for member in &pool {
        if ctx.should_stop() {
            break;
        }
        let _ = ctx.emit(&member.config);
    }
    // Early convergence can leave a method allowance: count those assessments too, without
    // inventing hops or taking the final polish reserve.
    let spare = best.config.clone().unwrap_or(cur);
    while initial_allowance.is_finite() && !ctx.should_stop() {
        if ctx.evaluate(&spare, true).is_none() {
            break;
        }
    }
}

/// The tighter parameters of the terminal penalty solve: no jitter, more and longer iterations.
fn refinement_params(local: &penalty_method::Params) -> penalty_method::Params {
    penalty_method::Params {
        outer_iterations: local.outer_iterations.max(20),
        inner_iterations: local.inner_iterations.max(300),
        gradient_tolerance: local.gradient_tolerance.min(1e-10),
        jitter: 0.0,
        ..local.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::ClockKind;
    use crate::framework::{run, Budget, Control, RunOptions};
    use crate::shapes::Problem;
    use serde_json::json;

    #[test]
    fn resolve_fills_defaults_and_checks_ranges() {
        let v = resolve(&Value::Null).unwrap();
        assert_eq!(v["localEvals"], 150);
        assert_eq!(v["penalty"]["outerIterations"], 6);
        assert_eq!(v["penalty"]["innerIterations"], 120);
        assert_eq!(v["weights"]["peel"], 2.0);
        // a given nested penalty object overrides key by key and keeps the local defaults
        let v = resolve(&json!({ "penalty": { "memory": 5 }, "weights": { "kick": 1 } })).unwrap();
        assert_eq!(v["penalty"]["memory"], 5);
        assert_eq!(v["penalty"]["outerIterations"], 6);
        assert_eq!(v["weights"]["kick"], 1.0);
        assert_eq!(v["weights"]["swap"], 1.0);
        for bad in [
            json!({ "bogus": 1 }),
            json!({ "localEvals": 1 }),
            json!({ "temperature": -1 }),
            json!({ "weights": { "kick": -1 } }),
            json!({ "weights": { "jump": 1 } }),
            json!({ "penalty": { "start": "nowhere" } }),
            json!({ "penalty": 3 }),
        ] {
            assert!(resolve(&bad).is_err(), "{bad}");
        }
    }

    fn square_grid(count: usize) -> Config {
        let width = (count as f64).sqrt().ceil() as usize;
        let pieces = (0..count).map(|i| Pose::new((i % width) as f64 * 1.1, (i / width) as f64 * 1.1, 0.3 * i as f64)).collect();
        Config { n: 4, m: 4, pieces, phi: 0.0 }
    }

    #[test]
    fn operators_keep_their_invariants() {
        let config = square_grid(12);
        let mut rng = Rng::new(5);
        let kicked = random_kick(&config, &mut rng, 0.3, 0.25, 1.0);
        let moved = (0..12).filter(|&i| kicked.pieces[i] != config.pieces[i]).count();
        assert_eq!(moved, 3);
        let swapped = swap_orientations(&config, &mut rng);
        let mut a: Vec<u64> = config.pieces.iter().map(|p| p.theta.to_bits()).collect();
        let mut b: Vec<u64> = swapped.pieces.iter().map(|p| p.theta.to_bits()).collect();
        a.sort();
        b.sort();
        assert_eq!(a, b);
        assert!((0..12).all(|i| swapped.pieces[i].x == config.pieces[i].x && swapped.pieces[i].y == config.pieces[i].y));
        let turned = rotate_cluster(&config, &mut rng, 1.8, 1.0);
        let changed: Vec<usize> = (0..12).filter(|&i| turned.pieces[i] != config.pieces[i]).collect();
        assert!(changed.len() >= 2);
        for &i in &changed {
            for &j in &changed {
                let d0 = (config.pieces[i].x - config.pieces[j].x).hypot(config.pieces[i].y - config.pieces[j].y);
                let d1 = (turned.pieces[i].x - turned.pieces[j].x).hypot(turned.pieces[i].y - turned.pieces[j].y);
                assert!((d0 - d1).abs() < 1e-12);
            }
        }
        assert!(same_packing(&config, &config));
        assert!(!same_packing(&config, &kicked));
        let mut metropolis_rng = Rng::new(1);
        assert!(metropolis(2.0, 1.0, 0.0, &mut metropolis_rng));
        assert!(!metropolis(1.0, 2.0, 0.0, &mut metropolis_rng));
        assert!(!metropolis(1.0, f64::NAN, 1.0, &mut metropolis_rng));
    }

    fn run_method(problem: Problem, evals: u64, seed: u32, params: Value) -> crate::framework::RunResult {
        let control = Control::new();
        run(
            problem,
            RunOptions {
                method: Method::BasinHopping,
                params,
                start: None,
                budget: Budget { evals: Some(evals), time_s: Some(1000.0) },
                seed,
                final_polish: true,
                control: &control,
                clock: ClockKind::Wall,
            },
        )
    }

    #[test]
    fn runs_are_valid_and_reproducible() {
        for problem in [Problem::new(4, 4, 6), Problem::new(0, 0, 7), Problem::new(3, 6, 8)] {
            let a = run_method(problem, 1200, 9, Value::Null);
            let b = run_method(problem, 1200, 9, Value::Null);
            assert!(a.valid && a.strict, "{problem:?}: {:?}", a.reasons);
            assert_eq!(a.score, b.score, "{problem:?}");
            assert_eq!(a.evaluations, b.evaluations);
            assert_eq!(a.best, b.best);
            assert!(a.evaluations <= 1200);
        }
    }
}
