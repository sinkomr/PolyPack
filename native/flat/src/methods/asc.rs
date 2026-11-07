//! Adaptive shrinking container (packages/solver/src/methods/asc.ts, asc/state.ts and the
//! mc_compress/state.ts helpers it uses): hard-particle Monte Carlo in an explicit container of
//! fixed shape. Piece translations and rotations, container translations and rotations, size
//! changes and collective strains of the centres are proposed; a trial is accepted only when
//! every piece stays inside the container and no pair overlaps, and a size change only when it
//! shrinks (or passes the Metropolis test at a positive temperature). Every move type adapts its
//! amplitude toward a target acceptance rate.

use super::common::{restore, PairTester, Strategy};
use crate::enclose::Encloser;
use crate::framework::Ctx;
use crate::sep::Shape;
use crate::shapes::{bounding_radius, container_inradius, piece_inradius, Config, Container, Pose, MAX_COORD};
use crate::validate::TOL;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::f64::consts::PI;

pub const MIN_STEP: f64 = 1e-7;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub translation_step: f64,
    pub rotation_step: f64,
    pub container_translation_step: f64,
    pub container_rotation_step: f64,
    pub scale_step: f64,
    pub balanced_step: f64,
    pub uniaxial_step: f64,
    pub sector_step: f64,
    pub radial_step: f64,
    pub target_acceptance: f64,
    pub adaptation_gain: f64,
    pub adaptation_sweeps: u32,
    pub sweeps_per_evaluation: u32,
    pub stagnation_sweeps: u32,
    pub radial_warmup: u32,
    pub seed_evals: u32,
    pub temperature: f64,
    pub cooling_rate: f64,
    pub container_moves: bool,
    pub collective_moves: bool,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            translation_step: 0.15,
            rotation_step: 0.15,
            container_translation_step: 0.05,
            container_rotation_step: 0.05,
            scale_step: 0.01,
            balanced_step: 0.01,
            uniaxial_step: 0.01,
            sector_step: 0.01,
            radial_step: 0.03,
            target_acceptance: 0.3,
            adaptation_gain: 1.0,
            adaptation_sweeps: 20,
            sweeps_per_evaluation: 10,
            stagnation_sweeps: 2000,
            radial_warmup: 64,
            seed_evals: 24,
            temperature: 0.0,
            cooling_rate: 0.9995,
            container_moves: true,
            collective_moves: true,
        }
    }
}

pub fn resolve(given: &Value) -> Result<Value, String> {
    let (v, p) = super::fill::<Params>(given)?;
    let in_range = |x: f64, lo: f64, hi: f64| x >= lo && x <= hi;
    let ok = in_range(p.translation_step, MIN_STEP, 100.0)
        && in_range(p.rotation_step, MIN_STEP, PI)
        && in_range(p.container_translation_step, MIN_STEP, 100.0)
        && in_range(p.container_rotation_step, MIN_STEP, PI)
        && in_range(p.scale_step, MIN_STEP, 0.3)
        && in_range(p.balanced_step, MIN_STEP, 0.3)
        && in_range(p.uniaxial_step, MIN_STEP, 0.3)
        && in_range(p.sector_step, MIN_STEP, 0.3)
        && in_range(p.radial_step, MIN_STEP, 0.3)
        && in_range(p.target_acceptance, 0.01, 0.99)
        && in_range(p.adaptation_gain, 0.0, 10.0)
        && (1..=10000).contains(&p.adaptation_sweeps)
        && (1..=1000).contains(&p.sweeps_per_evaluation)
        && (1..=100000).contains(&p.stagnation_sweeps)
        && p.radial_warmup <= 256
        && (3..=256).contains(&p.seed_evals)
        && in_range(p.temperature, 0.0, 100.0)
        && in_range(p.cooling_rate, 0.0, 1.0);
    if !ok {
        return Err("asc parameters out of range".into());
    }
    Ok(v)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Translation = 0,
    Rotation = 1,
    ContainerTranslation = 2,
    ContainerRotation = 3,
    Scale = 4,
    Balanced = 5,
    Uniaxial = 6,
    Sector = 7,
    Radial = 8,
}

const KINDS: [Kind; 9] = [
    Kind::Translation,
    Kind::Rotation,
    Kind::ContainerTranslation,
    Kind::ContainerRotation,
    Kind::Scale,
    Kind::Balanced,
    Kind::Uniaxial,
    Kind::Sector,
    Kind::Radial,
];

/// 64-bit hash of the scored configuration (the container's own centre and size are not part of
/// it); a collision can only skip one assessment.
fn configuration_key(pieces: &[Pose], phi: f64) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325 ^ pieces.len() as u64;
    let mut mix = |v: f64| {
        h ^= (v + 0.0).to_bits();
        h = h.wrapping_mul(0x100000001b3).rotate_left(29).wrapping_mul(0x9e3779b97f4a7c15);
    };
    mix(phi);
    for q in pieces {
        mix(q.x);
        mix(q.y);
        mix(q.theta);
    }
    h
}

/// Enclosure with an outward margin: a shared enclosure can round inward by a few ulps, so free
/// room is added rather than a protrusion accepted.
pub fn strict_enclose(encloser: &mut Encloser, config: &Config, phi: f64) -> Container {
    let c = encloser.enclose(&config.pieces, phi);
    Container { size: c.size + 2e-13 * c.size.max(1.0) / container_inradius(config.m), ..c }
}

/// The working state: the configuration, its explicit container (never re-enclosed) and a
/// uniform grid of the centres. Pieces outside the grid's box are clamped into its border cells,
/// which keeps every pair within reach in adjacent cells.
struct State {
    n: u32,
    shape: Shape,
    pieces: Vec<Pose>,
    container: Container,
    reach: f64,
    // grid
    origin_x: f64,
    origin_y: f64,
    g: i64,
    head: Vec<i32>,
    next: Vec<i32>,
    prev: Vec<i32>,
    cell_of: Vec<i32>,
    tester: PairTester,
}

impl State {
    fn new(n: u32, pieces: Vec<Pose>, container: Container) -> Self {
        let p = pieces.len();
        let mut s = State {
            n,
            shape: Shape::new(n),
            pieces,
            container,
            reach: 2.0 * bounding_radius(n),
            origin_x: 0.0,
            origin_y: 0.0,
            g: 1,
            head: vec![-1],
            next: vec![-1; p],
            prev: vec![-1; p],
            cell_of: vec![0; p],
            tester: PairTester::new(n),
        };
        s.rebuild();
        s
    }

    fn cell(&self, x: f64, y: f64) -> i32 {
        let g = self.g;
        let cx = ((x - self.origin_x) / self.reach).floor();
        let cy = ((y - self.origin_y) / self.reach).floor();
        let cx = if !(cx >= 0.0) { 0 } else if cx >= g as f64 { g - 1 } else { cx as i64 };
        let cy = if !(cy >= 0.0) { 0 } else if cy >= g as f64 { g - 1 } else { cy as i64 };
        (cy * g + cx) as i32
    }

    /// Size the grid to the current container (with a margin) and insert every piece.
    fn rebuild(&mut self) {
        let c = self.container;
        let half = if c.m == 0 { c.size / 2.0 } else { c.size / (2.0 * (PI / c.m as f64).sin()) };
        let half = half + 2.0 * self.reach;
        let g = ((2.0 * half / self.reach).ceil()).clamp(1.0, 512.0);
        self.g = if g.is_finite() { g as i64 } else { 512 };
        self.origin_x = c.cx - self.g as f64 * self.reach / 2.0;
        self.origin_y = c.cy - self.g as f64 * self.reach / 2.0;
        let cells = (self.g * self.g) as usize;
        self.head.clear();
        self.head.resize(cells, -1);
        for i in 0..self.pieces.len() {
            self.insert(i);
        }
    }

    fn insert(&mut self, i: usize) {
        let c = self.cell(self.pieces[i].x, self.pieces[i].y);
        self.cell_of[i] = c;
        let first = self.head[c as usize];
        self.next[i] = first;
        self.prev[i] = -1;
        if first >= 0 {
            self.prev[first as usize] = i as i32;
        }
        self.head[c as usize] = i as i32;
    }

    fn remove(&mut self, i: usize) {
        let (n, p) = (self.next[i], self.prev[i]);
        if p >= 0 {
            self.next[p as usize] = n;
        } else {
            self.head[self.cell_of[i] as usize] = n;
        }
        if n >= 0 {
            self.prev[n as usize] = p;
        }
    }

    /// True when no other piece overlaps piece i placed at `trial`.
    fn clear(&self, i: usize, trial: &Pose) -> bool {
        let c = self.cell(trial.x, trial.y) as i64;
        let g = self.g;
        let (cx, cy) = (c % g, c / g);
        let reach2 = self.reach * self.reach;
        for gy in (cy - 1).max(0)..=(cy + 1).min(g - 1) {
            for gx in (cx - 1).max(0)..=(cx + 1).min(g - 1) {
                let mut j = self.head[(gy * g + gx) as usize];
                while j >= 0 {
                    let ju = j as usize;
                    j = self.next[ju];
                    if ju == i {
                        continue;
                    }
                    let o = &self.pieces[ju];
                    // bounding disks exclude contacts beyond the reach
                    if (trial.x - o.x).powi(2) + (trial.y - o.y).powi(2) > reach2 {
                        continue;
                    }
                    if self.shape.sep(trial, o) < 0.0 {
                        return false;
                    }
                }
            }
        }
        true
    }

    fn move_piece(&mut self, i: usize, p: Pose) -> bool {
        let old = self.pieces[i];
        if p == old {
            return false;
        }
        if !(p.x.is_finite() && p.y.is_finite() && p.theta.is_finite()) || p.x.abs() > MAX_COORD || p.y.abs() > MAX_COORD {
            return false;
        }
        if !inside(self.n, &p, &self.container) || !self.clear(i, &p) {
            return false;
        }
        self.pieces[i] = p;
        let c = self.cell(p.x, p.y);
        if c != self.cell_of[i] {
            self.remove(i);
            self.insert(i);
        }
        true
    }

    /// Replace the configuration and the container (never re-enclosed or silently enlarged).
    fn replace(&mut self, pieces: Option<&[Pose]>, container: Container, temperature: f64, rng: &mut crate::rng::Rng) -> bool {
        if !(container.cx.is_finite() && container.cy.is_finite() && container.phi.is_finite() && container.size.is_finite()) {
            return false;
        }
        match pieces {
            Some(candidate) => {
                if !feasible(self.n, candidate, &container, &mut self.tester) {
                    return false;
                }
            }
            // the pieces do not move, and the state never overlaps: only containment can fail
            None => {
                if !self.pieces.iter().all(|q| inside(self.n, q, &container)) {
                    return false;
                }
            }
        }
        if !accept_size(self.container.size, container.size, temperature, rng) {
            return false;
        }
        if let Some(p) = pieces {
            self.pieces.clear();
            self.pieces.extend_from_slice(p);
        }
        self.container = container;
        self.rebuild();
        true
    }
}

/// Whether a whole piece lies in the closed container. A bounding circle well inside accepts at
/// once; otherwise the furthest vertex along each wall normal (the vertex nearest in angle to
/// the normal) is tested, which for a regular polygon decides every vertex.
#[inline]
fn inside(n: u32, pose: &Pose, c: &Container) -> bool {
    if !(c.size.is_finite() && c.size > 0.0) {
        return false;
    }
    let reach = bounding_radius(n);
    let dx = pose.x - c.cx;
    let dy = pose.y - c.cy;
    if c.m == 0 {
        if dx.hypot(dy) + reach <= c.size * 0.5 * (1.0 - 1e-12) {
            return true;
        }
    } else {
        // inside the inscribed circle by more than the reach
        let apothem = c.size * container_inradius(c.m);
        if dx.hypot(dy) + reach <= apothem * (1.0 - 1e-12) {
            return true;
        }
    }
    crate::penalty::max_protrusion(n, pose, c, 1.0, 0.0) <= 0.0
}

fn feasible(n: u32, pieces: &[Pose], c: &Container, tester: &mut PairTester) -> bool {
    for q in pieces {
        if !(q.x.is_finite() && q.y.is_finite() && q.theta.is_finite()) || q.x.abs() > MAX_COORD || q.y.abs() > MAX_COORD {
            return false;
        }
        if !inside(n, q, c) {
            return false;
        }
    }
    !tester.any_below(pieces, 0.0)
}

/// The size is the energy: shrinking is always accepted, growth with probability
/// exp(-(after - before) / T).
fn accept_size(before: f64, after: f64, temperature: f64, rng: &mut crate::rng::Rng) -> bool {
    after <= before || (temperature > 0.0 && rng.next() < (-(after - before) / temperature).exp())
}

fn adapt_step(step: f64, rate: f64, target: f64, gain: f64, maximum: f64) -> f64 {
    if gain == 0.0 {
        return step;
    }
    (step * (gain * (rate - target)).exp()).clamp(MIN_STEP, maximum)
}

/// Strain of the centres only (applied to the vertices it would deform the pieces): balanced
/// (compression along an axis with reciprocal expansion across it), uniaxial, sector (a radial
/// contraction restricted to a half-plane or sector) or radial.
fn collective_trial(pieces: &[Pose], c: &Container, kind: Kind, amplitude: f64, angle: f64, half_width: f64, out: &mut Vec<Pose>) {
    let (uy, ux) = angle.sin_cos();
    let along = 1.0 - amplitude;
    let across = if kind == Kind::Balanced { 1.0 / along } else { 1.0 };
    out.clear();
    for q in pieces {
        let x = q.x - c.cx;
        let y = q.y - c.cy;
        let a = x * ux + y * uy;
        let b = -x * uy + y * ux;
        if kind == Kind::Sector && a < x.hypot(y) * half_width.cos() {
            out.push(*q);
            continue;
        }
        if kind == Kind::Radial || kind == Kind::Sector {
            out.push(Pose::new(c.cx + along * x, c.cy + along * y, q.theta));
            continue;
        }
        out.push(Pose::new(c.cx + along * a * ux - across * b * uy, c.cy + along * a * uy + across * b * ux, q.theta));
    }
}

pub fn execute(ctx: &mut Ctx) {
    let Some(params) = super::params_of::<Params>(ctx) else { return };
    if !ctx.checkpoint() {
        return;
    }
    let problem = ctx.problem;
    let (n, m, p) = (problem.n, problem.m, problem.p);
    let mut encloser = Encloser::new(n, m);
    let mut tester = PairTester::new(n);
    let mut seen: HashSet<u64> = HashSet::new();
    let start = ctx.start().cloned();
    if let Some(s) = &start {
        seen.insert(configuration_key(&s.pieces, s.phi));
    }
    let usable = |c: &Config, tester: &mut PairTester| c.pieces.len() == p && !tester.any_below(&c.pieces, 0.0);
    // strict_enclose leaves an outward margin of 2e-13 relative; far from the origin rounding
    // exceeds it and the state as given has no strict walls to start from
    let workable = |c: &Config, tester: &mut PairTester, encloser: &mut Encloser| -> bool {
        if !usable(c, tester) {
            return false;
        }
        let walls = strict_enclose(encloser, c, c.phi);
        feasible(n, &c.pieces, &walls, tester)
    };
    // Contact-tight inputs commonly touch at about -1e-16: dilating every centre about the
    // centroid by f widens the gap of a pair along its separating axis by (f - 1) n.(b - a),
    // and n.(b - a) is at least twice the apothem less the penetration (each piece contains its
    // incircle); the shared repair then parts whatever rounding left.
    let separated = |ctx: &mut Ctx, c: &Config, tester: &mut PairTester, encloser: &mut Encloser| -> Option<Config> {
        if c.pieces.len() != p {
            return None;
        }
        let depth = tester.deepest(&c.pieces);
        if depth > TOL {
            return None;
        }
        let factor = 1.0 + (depth + 2e-12) / (2.0 * piece_inradius(n));
        let k = c.pieces.len() as f64;
        let cx = c.pieces.iter().map(|q| q.x).sum::<f64>() / k;
        let cy = c.pieces.iter().map(|q| q.y).sum::<f64>() / k;
        let mut dilated = c.clone();
        for q in &mut dilated.pieces {
            q.x = cx + factor * (q.x - cx);
            q.y = cy + factor * (q.y - cy);
        }
        let mut polls = 0usize;
        let limit = 64 * p;
        let mut extra = || {
            polls += 1;
            polls > limit
        };
        let parted = restore(ctx, &dilated, Strategy::Separate, false, MAX_COORD, tester, Some(&mut extra))?;
        if workable(&parted, tester, encloser) {
            Some(parted)
        } else {
            None
        }
    };
    let mut supplied = false;
    let mut initial: Option<Config> = None;
    if let Some(s) = &start {
        if workable(s, &mut tester, &mut encloser) {
            supplied = true;
            initial = Some(s.clone());
        }
    }
    // a repaired start is a configuration nothing has scored yet
    let mut repaired = false;
    if !supplied {
        if let Some(s) = &start {
            initial = separated(ctx, s, &mut tester, &mut encloser);
            repaired = initial.is_some();
        }
    }
    if initial.is_none() {
        let mut bootstrap: Option<Config> = None;
        if start.is_some() {
            // a distinct safe grid avoids paying twice for the invalid input
            let width = (p as f64).sqrt().ceil() as usize;
            let pitch = 2.1 * bounding_radius(n);
            let pieces = (0..p).map(|i| Pose::new(pitch * (i % width) as f64, pitch * (i / width) as f64, 0.0)).collect();
            bootstrap = Some(Config { n, m, pieces, phi: 0.0 });
        }
        let remaining = ctx.remaining().0;
        let slice = remaining.min(3f64.max((params.seed_evals as f64).min((remaining / 10.0).floor())));
        let seeded = ctx.run(crate::methods::Method::Seed, &serde_json::json!({"kind": "auto", "poolLimit": 0}), bootstrap.clone(), Some(slice as u64), None);
        let found_usable = seeded.found.as_ref().map_or(false, |c| usable(c, &mut tester));
        let mut pick = if found_usable { seeded.found.clone() } else { seeded.best.clone() };
        if !pick.as_ref().map_or(false, |c| workable(c, &mut tester, &mut encloser)) {
            let base = seeded.found.clone().or(seeded.best.clone());
            pick = base.and_then(|b| separated(ctx, &b, &mut tester, &mut encloser));
            repaired = pick.is_some();
        }
        initial = pick;
        if let Some(b) = &bootstrap {
            seen.insert(configuration_key(&b.pieces, b.phi));
        }
    }
    let Some(initial) = initial else { return };
    if ctx.should_stop() {
        return;
    }
    seen.insert(configuration_key(&initial.pieces, initial.phi));
    let walls = strict_enclose(&mut encloser, &initial, initial.phi);
    let mut state = State::new(n, initial.pieces.clone(), walls);
    if !feasible(n, &state.pieces, &state.container, &mut tester) {
        return;
    }
    // only an assessment of this exact working state may be the score to beat
    let mut best_score = if supplied && ctx.initial_evaluation().map_or(false, |e| e.valid) {
        ctx.initial_evaluation().unwrap().score.unwrap()
    } else {
        state.container.size
    };
    let mut temperature = params.temperature;
    let mut sweep: u64 = 0;
    let mut last_progress: u64 = 0;
    let max_translation = 2.0 * bounding_radius(n);
    let mut amplitude = [
        params.translation_step,
        params.rotation_step,
        params.container_translation_step,
        params.container_rotation_step,
        params.scale_step,
        params.balanced_step,
        params.uniaxial_step,
        params.sector_step,
        params.radial_step,
    ];
    let mut windows = [(0u64, 0u64); 9];
    let mut trial_pieces: Vec<Pose> = Vec::with_capacity(p);

    // assess the working state unless an identical one was assessed; false ends the method
    let submit = |ctx: &mut Ctx, state: &State, seen: &mut HashSet<u64>, best_score: &mut f64, last_progress: &mut u64, sweep: u64| -> bool {
        if ctx.should_stop() {
            return false;
        }
        let key = configuration_key(&state.pieces, state.container.phi);
        if !seen.insert(key) {
            return true;
        }
        let config = Config { n, m, pieces: state.pieces.clone(), phi: state.container.phi };
        let Some(result) = ctx.evaluate(&config, false) else { return false };
        if !result.valid {
            ctx.fail("asc invariant: an accepted state is not valid");
            return false;
        }
        let score = result.score.unwrap();
        if score < *best_score {
            if *best_score - score > 1e-10 * best_score.max(1.0) {
                *last_progress = sweep;
            }
            *best_score = score;
        }
        true
    };
    let adapt = |kind: Kind, amplitude: &mut [f64; 9], windows: &mut [(u64, u64); 9]| {
        let k = kind as usize;
        let (attempts, accepted) = windows[k];
        if attempts == 0 {
            return;
        }
        let maximum = match kind {
            Kind::Translation | Kind::ContainerTranslation => max_translation,
            Kind::Rotation | Kind::ContainerRotation => PI,
            _ => 0.3,
        };
        amplitude[k] = adapt_step(amplitude[k], accepted as f64 / attempts as f64, params.target_acceptance, params.adaptation_gain, maximum);
        windows[k] = (0, 0);
    };
    // bookkeeping after a trial: windows, progress, and the assessment of a state below the best
    macro_rules! after {
        ($kind:expr, $accepted:expr, $before:expr) => {{
            let k = $kind as usize;
            windows[k].0 += 1;
            if $accepted {
                windows[k].1 += 1;
                if state.container.size < $before - 1e-10 * $before.max(1.0) {
                    last_progress = sweep;
                }
            }
            !$accepted || state.container.size >= best_score || submit(ctx, &state, &mut seen, &mut best_score, &mut last_progress, sweep)
        }};
    }
    let unit_wall = bounding_radius(n) / container_inradius(m);

    if repaired {
        // counted like any other assessment; it hands the framework a strictly separated result
        let config = Config { n, m, pieces: state.pieces.clone(), phi: state.container.phi };
        seen.insert(configuration_key(&config.pieces, config.phi));
        let Some(result) = ctx.evaluate(&config, false) else { return };
        if !result.valid {
            return ctx.fail("asc invariant: the repaired start is not valid");
        }
        best_score = result.score.unwrap();
    }
    // radial strain: scaling the centres by f needs a wall of size f s + (1 - f) B / apothem, B the
    // bounding radius, rather than scaling the rigid pieces
    macro_rules! radial {
        () => {{
            if !ctx.checkpoint() {
                return;
            }
            let before = state.container.size;
            let a = amplitude[Kind::Radial as usize];
            collective_trial(&state.pieces, &state.container, Kind::Radial, a, 0.0, PI / 2.0, &mut trial_pieces);
            let same = trial_pieces == state.pieces;
            let accepted = if same {
                false
            } else {
                let c = Container { size: (1.0 - a) * state.container.size + a * unit_wall, ..state.container };
                let tp = std::mem::take(&mut trial_pieces);
                let ok = state.replace(Some(&tp), c, temperature, &mut ctx.rng);
                trial_pieces = tp;
                ok
            };
            if !after!(Kind::Radial, accepted, before) {
                return;
            }
        }};
    }
    if params.collective_moves {
        for _ in 0..params.radial_warmup {
            radial!();
            adapt(Kind::Radial, &mut amplitude, &mut windows);
        }
    }
    let mut since_checkpoint = 0;
    while !ctx.should_stop() {
        sweep += 1;
        if !ctx.checkpoint() {
            return;
        }
        for _ in 0..p {
            if ctx.should_stop() {
                return;
            }
            since_checkpoint += 1;
            if since_checkpoint >= 16 {
                since_checkpoint = 0;
                if !ctx.checkpoint() {
                    return;
                }
            }
            let i = (ctx.rng.next() * p as f64) as usize;
            let q = state.pieces[i];
            let kind = if n != 0 && ctx.rng.next() < 0.5 { Kind::Rotation } else { Kind::Translation };
            let a = amplitude[kind as usize];
            let trial = if kind == Kind::Rotation {
                Pose::new(q.x, q.y, q.theta + ctx.rng.signed() * a)
            } else {
                let dx = ctx.rng.signed() * a;
                let dy = ctx.rng.signed() * a;
                Pose::new(q.x + dx, q.y + dy, q.theta)
            };
            let before = state.container.size;
            let accepted = state.move_piece(i, trial);
            if !after!(kind, accepted, before) {
                return;
            }
        }
        if params.container_moves {
            if !ctx.checkpoint() {
                return;
            }
            let a = amplitude[Kind::ContainerTranslation as usize];
            let mut c = state.container;
            c.cx += ctx.rng.signed() * a;
            c.cy += ctx.rng.signed() * a;
            let before = state.container.size;
            let accepted = state.replace(None, c, temperature, &mut ctx.rng);
            if !after!(Kind::ContainerTranslation, accepted, before) {
                return;
            }
            if m != 0 {
                if !ctx.checkpoint() {
                    return;
                }
                let b = amplitude[Kind::ContainerRotation as usize];
                let period = 2.0 * PI / m as f64;
                let mut c = state.container;
                c.phi = ((c.phi + ctx.rng.signed() * b) % period + period) % period;
                let before = state.container.size;
                let accepted = state.replace(None, c, temperature, &mut ctx.rng);
                if !after!(Kind::ContainerRotation, accepted, before) {
                    return;
                }
            }
        }
        if params.collective_moves {
            for kind in [Kind::Balanced, Kind::Uniaxial, Kind::Sector] {
                let amp = amplitude[kind as usize] * (0.5 + 0.5 * ctx.rng.next());
                let angle = 2.0 * PI * ctx.rng.next();
                let half_width = if ctx.rng.next() < 0.5 { PI / 2.0 } else { PI * (0.1 + 0.4 * ctx.rng.next()) };
                if !ctx.checkpoint() {
                    return;
                }
                let before = state.container.size;
                collective_trial(&state.pieces, &state.container, kind, amp, angle, half_width, &mut trial_pieces);
                let accepted = if trial_pieces == state.pieces {
                    false
                } else {
                    let tp = std::mem::take(&mut trial_pieces);
                    let c = state.container;
                    let ok = state.replace(Some(&tp), c, temperature, &mut ctx.rng);
                    trial_pieces = tp;
                    ok
                };
                if !after!(kind, accepted, before) {
                    return;
                }
            }
            radial!();
        }
        {
            if !ctx.checkpoint() {
                return;
            }
            let a = amplitude[Kind::Scale as usize] * (0.5 + 0.5 * ctx.rng.next());
            let expansion = temperature > 0.0 && ctx.rng.next() < 0.2;
            let mut c = state.container;
            c.size *= 1.0 + if expansion { a } else { -a };
            let before = state.container.size;
            let accepted = state.replace(None, c, temperature, &mut ctx.rng);
            if !after!(Kind::Scale, accepted, before) {
                return;
            }
        }
        if sweep % params.adaptation_sweeps as u64 == 0 {
            for kind in KINDS {
                adapt(kind, &mut amplitude, &mut windows);
            }
        }
        temperature *= params.cooling_rate;
        if sweep % params.sweeps_per_evaluation as u64 == 0 && !submit(ctx, &state, &mut seen, &mut best_score, &mut last_progress, sweep) {
            return;
        }
        if sweep - last_progress >= params.stagnation_sweeps as u64 {
            submit(ctx, &state, &mut seen, &mut best_score, &mut last_progress, sweep);
            return;
        }
    }
}
