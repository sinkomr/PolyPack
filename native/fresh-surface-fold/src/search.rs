//! The global search: starts, the jamming polish, frontier basin hopping, checks and the trace.
//!
//! Scale: the working scale S of the solid is the problem's lower bound on s, so a packing at piece
//! scale mu has score S / mu and mu <= 1.
//!
//! - *Polish* (jamming scale of an arrangement). Relaxed at a scale mu above its jamming scale mu*, an
//!   arrangement keeps an overlap energy E with sqrt(E) close to linear in mu - mu*; below it, E falls
//!   to zero. Each trial relaxes at a scale given by the secant of the two latest infeasible trials (or
//!   a bisection once a trial was feasible), and every relaxed arrangement is *repaired*: its exact
//!   jamming scale for the poses as they are (model.rs, `jam_scale`) is a valid scale. It stops when the
//!   valid and the infeasible scale meet to 1e-13, or as soon as it cannot beat the best.
//! - *Frontier basin hopping*. At a scale a little above the best packing's (mu_best (1 + delta)), perturb
//!   the current arrangement, relax (stopping early when the hop is clearly worse or back where it
//!   started), keep it when its energy is lower; an arrangement whose energy reaches zero there beats the
//!   best: *climb* (relax at growing scales while it fits, each repaired), check, record, move the scale
//!   up and widen delta (x1.5). After `patience` failed hops in a row delta is divided by 4, down to
//!   `delta_min`; then the chain's best is polished and the search restarts (random centres, or the best
//!   shaken by 1-3 moves).
//! - *Check*. Only packings that beat the best are checked, with the server's check; the score is the one
//!   it computes. A packing the check refuses is enlarged by 1e-9, 1e-7, 1e-5 and checked again before it
//!   is dropped.

use crate::geo::Rig;
use crate::model::{wrap_angle, Budget, Model, Pose, RelaxOpts};
use crate::rng::Rng;
use crate::{config_json, poses_of, Problem};
use serde_json::Value;
use std::f64::consts::PI;

#[derive(Clone, Debug)]
pub struct Params {
    /// frontier: hop at mu_best (1 + delta)
    pub delta: f64,
    pub delta_min: f64,
    pub delta_max: f64,
    /// failed hops in a row before a restart: patience0 + patience1 P
    pub patience0: usize,
    pub patience1: usize,
    pub hop_iter: usize,
    pub polish_iter: usize,
    pub gtol: f64,
    pub climb: bool,
    pub start_polish: bool,
}

impl Params {
    pub fn for_problem(_prob: &Problem) -> Params {
        Params { delta: 2e-3, delta_min: env_num("FRESH_DMIN", 2e-4), delta_max: env_num("FRESH_DMAX", 0.03), patience0: 30, patience1: 2, hop_iter: 3000, polish_iter: 2500, gtol: 1e-13, climb: env_flag("FRESH_CLIMB", true), start_polish: env_flag("FRESH_STARTPOL", true) }
    }
}

/// The best checked packing.
#[derive(Clone, Debug)]
pub struct Best {
    pub cfg: Vec<Pose>,
    pub mu: f64,
    pub score: f64,
    pub config: Value,
}

pub struct Report {
    pub best: Option<Best>,
    pub trace: Vec<(f64, f64)>,
    pub evaluations: u64,
    pub stopped: &'static str,
}

/// Statistics (FRESH_DEBUG).
#[derive(Default, Debug, Clone)]
pub struct Stats {
    pub hops: u64,
    pub accepted: u64,
    pub frontier: u64,
    pub polishes: u64,
    pub checks: u64,
    pub refused: u64,
    pub restarts: u64,
    pub moves_tried: [u64; 7],
    pub moves_won: [u64; 7],
}

pub struct Search<'a, 'b> {
    pub prob: Problem,
    pub work: f64,
    pub model: Model,
    pub rng: Rng,
    pub budget: Budget<'a>,
    pub params: Params,
    pub best: Option<Best>,
    pub trace: Vec<(f64, f64)>,
    pub stats: Stats,
    checker: &'b mut dyn FnMut(&Value) -> Option<f64>,
    t0: f64,
    debug: bool,
    debug_polish: bool,
    debug_hops: bool,
    move_w: [f64; 7],
    /// the frontier gap, adapted
    delta: f64,
    /// the best was polished once near the end of the budget
    final_polished: bool,
}

impl<'a, 'b> Search<'a, 'b> {
    pub fn new(prob: &Problem, seed: u64, budget: Budget<'a>, checker: &'b mut dyn FnMut(&Value) -> Option<f64>) -> Result<Search<'a, 'b>, String> {
        let work = prob.bound;
        let geo = crate::geo::Geo::new(&prob.solid, work)?;
        let model = Model::new(geo, prob.n, prob.p);
        let t0 = budget.now();
        Ok(Search {
            params: Params::for_problem(prob),
            prob: prob.clone(),
            work,
            model,
            rng: Rng::new(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x5EED),
            budget,
            best: None,
            trace: Vec::new(),
            stats: Stats::default(),
            checker,
            t0,
            debug: std::env::var("FRESH_DEBUG").is_ok(),
            debug_polish: std::env::var("FRESH_DEBUG_POLISH").is_ok(),
            debug_hops: std::env::var("FRESH_DEBUG_HOPS").is_ok(),
            move_w: [1.0; 7],
            delta: env_num("FRESH_D0", 4e-3),
            final_polished: false,
        })
    }

    fn p(&self) -> usize {
        self.prob.p
    }

    fn best_mu(&self) -> f64 {
        self.best.as_ref().map_or(0.0, |b| b.mu)
    }

    // ---------------------------------------------------------------- moves on the surface

    /// Moves piece q by (dx, dy) in its face's frame along the surface (a geodesic).
    fn displace(&self, q: &mut Pose, dx: f64, dy: f64) {
        let (g, x, y, m): (usize, f64, f64, Rig) = self.model.geo.walk(q.f as usize, q.x, q.y, q.x + dx, q.y + dy);
        *q = Pose { f: g as u32, x, y, t: wrap_angle(q.t + m.ang, self.prob.n) };
    }

    fn random_pose(&mut self) -> Pose {
        let (u1, u2, u3, u4) = (self.rng.uniform(), self.rng.uniform(), self.rng.uniform(), self.rng.uniform());
        let (f, x, y) = self.model.geo.sample(u1, u2, u3, u4);
        let t = if self.prob.n == 0 { 0.0 } else { self.rng.uniform() * 2.0 * PI / self.prob.n as f64 };
        Pose { f: f as u32, x, y, t }
    }

    /// 3D position of a pose (a cheap proxy of surface distance: it is never larger).
    fn pos3(&self, q: &Pose) -> [f64; 3] {
        self.model.geo.to3(q.f as usize, q.x, q.y)
    }

    /// The roomiest of `k` random points: the largest 3D distance to the other centres and the vertices.
    fn hole(&mut self, cfg: &[Pose], skip: usize, k: usize) -> Pose {
        let mut best = self.random_pose();
        let mut best_d = -1.0;
        let pts: Vec<[f64; 3]> = cfg.iter().enumerate().filter(|(i, _)| *i != skip).map(|(_, q)| self.pos3(q)).collect();
        let r = self.model.sh.r1 * self.model.mu;
        for _ in 0..k {
            let q = self.random_pose();
            let a = self.pos3(&q);
            let mut d = f64::INFINITY;
            for b in &pts {
                d = d.min(dist3(&a, b) / (2.0 * r));
            }
            // vertices of the face: keep the inscribed disk off them
            let fc = &self.model.geo.faces[q.f as usize];
            for kk in 0..fc.m {
                let dv = (fc.vx[kk] - q.x).hypot(fc.vy[kk] - q.y);
                d = d.min(dv / r);
            }
            if d > best_d {
                best_d = d;
                best = q;
            }
        }
        best
    }

    fn random_cfg(&mut self) -> Vec<Pose> {
        let p = self.p();
        let mut cfg = Vec::with_capacity(p);
        for _ in 0..p {
            let q = self.random_pose();
            cfg.push(q);
        }
        // spread a little: re-place each piece at the roomiest of a few points
        for i in 0..p {
            let q = self.hole(&cfg, i, 8);
            cfg[i] = q;
        }
        // polygons, half the starts: an edge of each piece parallel to its face's nearest edge
        let n = self.prob.n;
        if n > 0 && self.rng.uniform() < 0.5 {
            for q in cfg.iter_mut() {
                let a = self.edge_angle(q);
                let flip = if n % 2 == 1 && self.rng.uniform() < 0.5 { PI / n as f64 } else { 0.0 };
                q.t = wrap_angle(a + flip, n);
            }
        }
        cfg
    }

    /// The angle that puts an edge of the piece parallel to the nearest edge of its face.
    fn edge_angle(&self, q: &Pose) -> f64 {
        let n = self.prob.n.max(3) as f64;
        let fc = &self.model.geo.faces[q.f as usize];
        let mut best = (f64::INFINITY, 0.0);
        for k in 0..fc.m {
            let d = fc.off[k] - (fc.nx[k] * q.x + fc.ny[k] * q.y);
            if d < best.0 {
                let j = (k + 1) % fc.m;
                best = (d, (fc.vy[j] - fc.vy[k]).atan2(fc.vx[j] - fc.vx[k]));
            }
        }
        best.1 - PI - PI / n
    }

    // ---------------------------------------------------------------- repair, polish, check

    /// The exact jamming scale of `cfg` as it is (canonical poses), starting the lists at `mu`.
    pub fn repair(&mut self, cfg: &[Pose], mu: f64) -> f64 {
        let mut m = mu;
        for _ in 0..60 {
            self.model.build(cfg, m);
            let cap = self.model.mu + self.model.skin / (2.0 * self.model.sh.r1) * 0.95;
            let j = self.model.jam_scale(cfg);
            if j < cap * (1.0 - 1e-12) {
                return j;
            }
            m = j;
        }
        m
    }

    /// Finds the jamming scale of the arrangement `cfg` (updated: the best valid poses found) starting
    /// with a relaxation at `mu_try`. Returns the valid scale of the returned poses.
    pub fn polish(&mut self, cfg: &mut Vec<Pose>, mu_try: f64) -> f64 {
        self.stats.polishes += 1;
        let tiny = 1e-24;
        let mut work = cfg.clone();
        let mut valid_mu = self.repair(cfg, mu_try.min(1.0) * 0.999);
        let mut valid_cfg = cfg.clone();
        let mut lo = 0.0f64; // largest feasible relaxation scale
        let mut hi = f64::INFINITY; // smallest infeasible
        let mut inf: Vec<(f64, f64)> = Vec::new();
        let mut mu = mu_try;
        let target = self.best_mu();
        let mut grow = 2e-3;
        for _trial in 0..40 {
            if self.budget.spent() {
                break;
            }
            let ro = RelaxOpts { max_iter: self.params.polish_iter, gtol: self.params.gtol, stall_rel: 1e-11, watch: None };
            let e = self.model.relax_with(&mut work, mu, &ro, &mut self.budget);
            let r = self.repair(&work, mu);
            if self.debug_polish {
                eprintln!("  polish trial mu {mu:.12} e {e:.3e} repair {r:.12} valid {valid_mu:.12} it {}", self.model.stat_iters);
            }
            if r > valid_mu {
                valid_mu = r;
                valid_cfg.clone_from(&work);
            }
            if e <= tiny * mu * mu {
                lo = lo.max(mu);
            } else {
                hi = hi.min(mu);
                inf.push((mu, e.sqrt()));
            }
            if hi.is_finite() && (hi - valid_mu) <= 2e-13 * hi {
                break;
            }
            // cannot beat the best: give up
            if hi < target * (1.0 + 1e-13) {
                break;
            }
            let floor = valid_mu.max(lo);
            let next = if !hi.is_finite() {
                // still feasible: grow, faster each time
                grow *= 2.0;
                (floor * (1.0 + grow)).max(mu * (1.0 + grow))
            } else if inf.len() >= 2 {
                let (m1, r1) = inf[inf.len() - 2];
                let (m2, r2) = inf[inf.len() - 1];
                let est = if (r2 - r1).abs() > 0.0 { m2 - r2 * (m2 - m1) / (r2 - r1) } else { f64::NAN };
                if est.is_finite() && est > floor && est < hi {
                    // a hair below the estimate, so that the trial tends to be feasible
                    (est - 1e-3 * (hi - floor)).max(floor + 0.05 * (hi - floor))
                } else {
                    0.5 * (floor + hi)
                }
            } else {
                floor + 0.3 * (hi - floor)
            };
            if !(next > floor) || !(next < hi) || (hi.is_finite() && (hi - floor) <= 2e-13 * hi) {
                break;
            }
            mu = next;
            // continue from the best valid poses when the last trial went astray
            if e > tiny * mu * mu && r < valid_mu * 0.999 {
                work.clone_from(&valid_cfg);
            }
        }
        *cfg = valid_cfg;
        valid_mu
    }

    /// Checks the packing (cfg, mu) and records it when it beats the best. True when recorded.
    pub fn offer(&mut self, cfg: &[Pose], mu: f64) -> bool {
        if !(mu > self.best_mu() * (1.0 + 1e-15)) || !(mu > 0.0) {
            return false;
        }
        let base = self.work / mu * (1.0 + 2e-13);
        for (k, grow) in [0.0, 1e-9, 1e-7, 1e-5].iter().enumerate() {
            let s = base * (1.0 + grow);
            if let Some(b) = &self.best {
                if !(s < b.score) {
                    return false;
                }
            }
            let config = config_json(cfg, self.work, s);
            self.stats.checks += 1;
            self.budget.evals += 1;
            if let Some(score) = (self.checker)(&config) {
                let t = self.budget.now() - self.t0;
                if self.best.as_ref().is_none_or(|b| score < b.score) {
                    self.trace.push((t, score));
                    if self.debug {
                        eprintln!("[{t:.3}s] best {score:.12} (mu {mu:.12}) checks {} refused {}", self.stats.checks, self.stats.refused);
                    }
                    self.best = Some(Best { cfg: cfg.to_vec(), mu: self.work / score, score, config });
                    return true;
                }
                return false;
            }
            self.stats.refused += 1;
            if self.debug && k == 0 && self.stats.refused <= 5 {
                let v = polypack_spaces::validate_space_submission(
                    polypack_spaces::SpaceName::Surface,
                    &self.prob.id,
                    &config,
                    &polypack_spaces::SpaceValidateOptions::default(),
                );
                eprintln!("check refused a packing at mu {mu}: {:?}", &v.reasons[..v.reasons.len().min(4)]);
                if std::env::var("FRESH_DUMP").is_ok() {
                    eprintln!("REFUSED {}", config);
                }
            }
        }
        false
    }

    /// A valid packing at all costs: the poses shrunk until the check accepts them.
    fn fallback(&mut self, cfg: &[Pose], mu: f64) {
        let mut m = mu;
        for _ in 0..40 {
            if self.best.is_some() {
                return;
            }
            m *= 0.8;
            if self.offer(cfg, m) {
                return;
            }
        }
    }

    // ---------------------------------------------------------------- perturbations

    fn perturb(&mut self, cfg: &mut [Pose]) -> usize {
        let total: f64 = self.move_w.iter().sum();
        let mut u = self.rng.uniform() * total;
        let mut mv = 0;
        for (k, w) in self.move_w.iter().enumerate() {
            if u < *w {
                mv = k;
                break;
            }
            u -= w;
            mv = k;
        }
        let p = self.p();
        let n = self.prob.n;
        let r = self.model.sh.r1 * self.model.mu.max(1e-3);
        let ang_period = if n == 0 { 0.0 } else { 2.0 * PI / n as f64 };
        match mv {
            0 => {
                // shake every piece
                let amp = r * (0.02f64.ln() + self.rng.uniform() * (0.5f64.ln() - 0.02f64.ln())).exp();
                let turn = self.rng.uniform() < 0.5;
                for i in 0..p {
                    let (dx, dy) = (amp * self.rng.normal(), amp * self.rng.normal());
                    let mut q = cfg[i];
                    self.displace(&mut q, dx, dy);
                    if turn && n > 0 {
                        q.t = wrap_angle(q.t + 0.3 * ang_period * self.rng.normal() * amp / r, n);
                    }
                    cfg[i] = q;
                }
            }
            1 => {
                // shake a neighbourhood hard
                let c = self.rng.below(p);
                let a = self.pos3(&cfg[c]);
                let rad = 2.5 * r * 2.0;
                let amp = 0.4 * r;
                for i in 0..p {
                    if dist3(&a, &self.pos3(&cfg[i])) < rad {
                        let (dx, dy) = (amp * self.rng.normal(), amp * self.rng.normal());
                        let mut q = cfg[i];
                        self.displace(&mut q, dx, dy);
                        if n > 0 {
                            q.t = wrap_angle(q.t + 0.3 * ang_period * self.rng.normal(), n);
                        }
                        cfg[i] = q;
                    }
                }
            }
            2 => {
                // re-seat 1 to 3 pieces in holes
                let k = 1 + self.rng.below(3.min(p));
                // half the time the first is the most squeezed piece
                let first = if p > 1 && self.rng.uniform() < 0.5 {
                    let mu = self.model.mu;
                    let sq = self.model.squeeze(cfg, mu);
                    let (i, &v) = sq.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap();
                    if v > 0.0 {
                        Some(i)
                    } else {
                        None
                    }
                } else {
                    None
                };
                for s in 0..k {
                    let i = match first {
                        Some(f) if s == 0 => f,
                        _ => self.rng.below(p),
                    };
                    let q = self.hole(cfg, i, 24);
                    cfg[i] = q;
                }
            }
            3 => {
                // one piece to a random place
                let i = self.rng.below(p);
                cfg[i] = self.random_pose();
            }
            4 => {
                // turn one or two pieces
                if n == 0 {
                    let i = self.rng.below(p);
                    let mut q = cfg[i];
                    let (dx, dy) = (0.3 * r * self.rng.normal(), 0.3 * r * self.rng.normal());
                    self.displace(&mut q, dx, dy);
                    cfg[i] = q;
                } else {
                    for _ in 0..1 + self.rng.below(2) {
                        let i = self.rng.below(p);
                        cfg[i].t = wrap_angle(cfg[i].t + self.rng.uniform() * ang_period, n);
                    }
                }
            }
            5 => {
                // small shake of everything, angles too
                let amp = 0.05 * r;
                for i in 0..p {
                    let mut q = cfg[i];
                    let (dx, dy) = (amp * self.rng.normal(), amp * self.rng.normal());
                    self.displace(&mut q, dx, dy);
                    if n > 0 {
                        q.t = wrap_angle(q.t + 0.05 * ang_period * self.rng.normal(), n);
                    }
                    cfg[i] = q;
                }
            }
            _ => {
                // polygons: turn a piece to its neighbour's developed angle (odd N: or upside down), or
                // an edge of it parallel to its face's nearest edge; disks: a small shift
                let i = self.rng.below(p);
                if n == 0 {
                    let mut q = cfg[i];
                    let (dx, dy) = (0.15 * r * self.rng.normal(), 0.15 * r * self.rng.normal());
                    self.displace(&mut q, dx, dy);
                    cfg[i] = q;
                } else if self.rng.uniform() < 0.5 && p > 1 {
                    if let Some(a) = self.neighbour_angle(cfg, i) {
                        let flip = if n % 2 == 1 && self.rng.uniform() < 0.5 { PI / n as f64 } else { 0.0 };
                        cfg[i].t = wrap_angle(a + flip, n);
                    }
                } else {
                    let a = self.edge_angle(&cfg[i]);
                    cfg[i].t = wrap_angle(a, n);
                }
            }
        }
        mv
    }

    /// The developed angle of the nearest other piece seen from piece i (in i's face frame).
    fn neighbour_angle(&mut self, cfg: &[Pose], i: usize) -> Option<f64> {
        let q = cfg[i];
        let reach = 2.2 * self.model.sh.r1 * self.model.mu.max(1e-3);
        let mut nodes = Vec::new();
        self.model.geo.chains(q.f as usize, q.x, q.y, reach, 400, &mut nodes);
        let mut best: Option<(f64, f64)> = None;
        for node in &nodes {
            for (j, r) in cfg.iter().enumerate() {
                if j == i || r.f != node.face {
                    continue;
                }
                let (px, py) = node.t.apply(r.x, r.y);
                let d = (px - q.x).hypot(py - q.y);
                if d < reach && node.sees(q.x, q.y, px, py, 1e-9) && best.is_none_or(|b| d < b.0) {
                    best = Some((d, r.t + node.t.ang));
                }
            }
        }
        best.map(|b| b.1)
    }

    // ---------------------------------------------------------------- the schedule

    /// A start relaxed at `mu0`, or at smaller scales until it fits; its exact jamming scale.
    fn start_relax(&mut self, cfg: &mut [Pose], mu0: f64) -> f64 {
        let mut mu = mu0;
        let ro = RelaxOpts { max_iter: 2000, gtol: self.params.gtol, stall_rel: 1e-9, watch: None };
        for _ in 0..12 {
            let e = self.model.relax_with(cfg, mu, &ro, &mut self.budget);
            if e <= 1e-24 * mu * mu || self.budget.spent() {
                break;
            }
            mu *= 0.93;
        }
        self.repair(cfg, mu)
    }

    fn start_from(&mut self, mut cfg: Vec<Pose>, mu0: f64) {
        if self.best.is_none() {
            // a valid packing at once: the start as it is, at its exact jamming scale
            let r = self.repair(&cfg, 0.05);
            if !self.offer(&cfg, r) {
                self.fallback(&cfg, r);
            }
        }
        let mu = if self.params.start_polish { self.polish(&mut cfg, mu0) } else { self.start_relax(&mut cfg, mu0) };
        if mu > self.best_mu() && !self.offer(&cfg, mu) && self.best.is_none() {
            self.fallback(&cfg, mu);
        }
        if self.best.is_none() && !self.budget.spent() {
            self.fallback(&cfg, mu.max(1e-3));
        }
        self.hop_from(cfg, mu);
    }

    /// From an arrangement that fits at `mu` (energy zero there), grows the scale while it still fits
    /// (steps doubling from `step`), with short relaxations; stops at the first scale where it does
    /// not. `cfg` becomes the last arrangement that fitted; returns its exact jamming scale.
    fn climb(&mut self, cfg: &mut Vec<Pose>, mu: f64, step: f64) -> f64 {
        let mut best = self.repair(cfg, mu);
        let mut work = cfg.clone();
        let mut g = step;
        for _ in 0..30 {
            if self.budget.spent() {
                break;
            }
            let m = best * (1.0 + g);
            let ro = RelaxOpts { max_iter: 600, gtol: self.params.gtol, stall_rel: 1e-9, watch: None };
            let e = self.model.relax_with(&mut work, m, &ro, &mut self.budget);
            if e > 1e-24 * m * m {
                break;
            }
            let r = self.repair(&work, m);
            if !(r > best) {
                break;
            }
            best = r;
            cfg.clone_from(&work);
            g *= 2.0;
        }
        best
    }

    /// Near the end of the budget: the best, polished precisely (its last digits), once.
    fn final_polish(&mut self) {
        self.final_polished = true;
        if let Some(b) = self.best.clone() {
            let mut c = b.cfg.clone();
            let m = self.polish(&mut c, b.mu * (1.0 + 1e-5));
            if m > self.best_mu() {
                self.offer(&c, m);
            }
        }
    }

    /// Frontier basin hopping from (cfg, mu_cfg) until patience runs out, then the precise polish of
    /// the chain's best.
    fn hop_from(&mut self, cfg: Vec<Pose>, mu_cfg: f64) {
        let p = self.p();
        let patience = self.params.patience0 + self.params.patience1 * p;
        let mut cur = cfg;
        let mut delta = self.delta;
        let mut mu_h = self.best_mu().max(mu_cfg) * (1.0 + delta);
        let full = RelaxOpts { max_iter: self.params.hop_iter, gtol: self.params.gtol, stall_rel: 1e-10, watch: None };
        let mut e_cur = self.model.relax_with(&mut cur, mu_h, &full, &mut self.budget);
        let mut fails = 0;
        let mut chain_best: Option<(Vec<Pose>, f64)> = None;
        while !self.budget.spent() {
            if fails >= patience {
                if delta > self.params.delta_min * 1.5 {
                    // nothing fits a step above the best: hop closer to it
                    delta = (delta / 4.0).max(self.params.delta_min);
                    mu_h = self.best_mu().max(mu_cfg) * (1.0 + delta);
                    e_cur = self.model.relax_with(&mut cur, mu_h, &full, &mut self.budget);
                    fails = patience / 2;
                    continue;
                }
                break;
            }
            if !self.final_polished && self.budget.fraction() > 0.9 {
                self.final_polish();
            }
            let mut cand = cur.clone();
            let mv = self.perturb(&mut cand);
            self.stats.hops += 1;
            self.stats.moves_tried[mv] += 1;
            let it0 = self.model.stat_iters;
            let ro = RelaxOpts { watch: Some(e_cur), ..full };
            let e = self.model.relax_with(&mut cand, mu_h, &ro, &mut self.budget);
            if self.debug_hops {
                eprintln!("  hop mv {mv} it {} e {e:.3e} cur {e_cur:.3e} delta {delta:.1e}", self.model.stat_iters - it0);
            }
            if self.budget.spent() {
                break;
            }
            if e <= 1e-24 * mu_h * mu_h {
                // fits at the hopping scale: beats the best
                self.stats.frontier += 1;
                self.stats.moves_won[mv] += 1;
                self.move_w[mv] = (self.move_w[mv] * 1.1).min(4.0);
                let mu = if self.params.climb { self.climb(&mut cand, mu_h, delta) } else { self.repair(&cand, mu_h) };
                if mu > self.best_mu() {
                    self.offer(&cand, mu);
                }
                if chain_best.as_ref().is_none_or(|c| mu > c.1) {
                    chain_best = Some((cand.clone(), mu));
                }
                cur = cand;
                delta = (delta * 1.5).min(self.params.delta_max);
                mu_h = self.best_mu().max(mu) * (1.0 + delta);
                e_cur = self.model.relax_with(&mut cur, mu_h, &full, &mut self.budget);
                fails = 0;
                continue;
            }
            if e < e_cur * (1.0 - 1e-5) {
                self.stats.accepted += 1;
                self.stats.moves_won[mv] += 1;
                self.move_w[mv] = (self.move_w[mv] * 1.05).min(4.0);
                cur = cand;
                e_cur = e;
                fails = 0;
            } else {
                self.move_w[mv] = (self.move_w[mv] * 0.98).max(0.2);
                fails += 1;
            }
        }
        self.delta = delta;
        // the chain's best, polished: the last digits
        if let Some((mut c, mu)) = chain_best {
            if !self.budget.spent() && mu >= self.best_mu() * (1.0 - 1e-6) {
                let m = self.polish(&mut c, mu * (1.0 + 1e-5));
                if m > self.best_mu() {
                    self.offer(&c, m);
                }
            }
        }
    }

    /// Starts from `start` when given (a valid configuration of the problem), then searches until the
    /// budget is spent.
    pub fn run(mut self, start: Option<&Value>) -> Report {
        if let Some(v) = start {
            if let Some((_, poses)) = poses_of(v, self.work) {
                if poses.len() == self.p() && poses.iter().all(|q| (q.f as usize) < self.model.geo.faces.len()) {
                    // checked directly: the start is the first best, not an improvement to report
                    if let Some(score) = crate::check(&self.prob.id, v) {
                        let t = self.budget.now() - self.t0;
                        let geo = &self.model.geo;
                        let n = self.prob.n;
                        let cfg: Vec<Pose> = poses
                            .iter()
                            .map(|q| {
                                let (f, x, y, m) = geo.locate(q.f as usize, q.x, q.y);
                                Pose { f: f as u32, x, y, t: wrap_angle(q.t + m.ang, n) }
                            })
                            .collect();
                        self.trace.push((t, score));
                        self.best = Some(Best { cfg, mu: self.work / score, score, config: v.clone() });
                    }
                }
            }
        }
        let mut round = 0usize;
        while !self.budget.spent() {
            round += 1;
            let have = self.best.clone();
            match have {
                Some(b) if round % 3 != 1 || self.prob.p == 1 => {
                    // from the best, shaken hard
                    self.stats.restarts += 1;
                    let mut cfg = b.cfg.clone();
                    let k = 1 + self.rng.below(3);
                    for _ in 0..k {
                        self.perturb(&mut cfg);
                    }
                    let mu = b.mu;
                    let pol_start = mu * (1.0 + self.params.delta);
                    self.start_from(cfg, pol_start);
                }
                _ => {
                    self.stats.restarts += 1;
                    let cfg = self.random_cfg();
                    let mu0 = if self.prob.p == 1 { 0.9 } else { 0.7 };
                    self.start_from(cfg, mu0);
                }
            }
        }
        if self.debug {
            eprintln!("stats {:?} evals {} relax {} iters {} builds {}", self.stats, self.budget.evals, self.model.stat_relax, self.model.stat_iters, self.model.stat_builds);
        }
        let stopped = if self.budget.halt_evals { "evals" } else { "cpu" };
        Report { best: self.best, trace: self.trace, evaluations: self.budget.evals, stopped }
    }
}

/// A development switch from the environment (default when unset).
pub fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) => v != "0",
        Err(_) => default,
    }
}

/// A development number from the environment.
pub fn env_num(name: &str, default: f64) -> f64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[inline]
fn dist3(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}
