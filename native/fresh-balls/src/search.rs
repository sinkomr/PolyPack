//! The search: monotonic basin hopping on the penalty energy at a container size held slightly below the best
//! packing found, with a secant polish that drives a promising arrangement to its own jamming size.
//!
//!  - relax(x, s): L-BFGS on the energy at size s (energy.rs). E = 0 means the arrangement fits at s.
//!  - repair(x): the smallest valid packing that is a uniform scaling of x: centres scaled about the origin by
//!    1 / (least pair distance) when two overlap, the size the least that holds every scaled centre. Its score
//!    is an upper bound for the arrangement.
//!  - polish(x): the jamming size s* of the arrangement, approached by relaxing at trial sizes: below s* the
//!    relaxed energy is about k (s* - s)^2, so sqrt(E) is close to linear in s there, and two infeasible
//!    trials give a secant estimate of s*; each trial is just below the estimate, so the trials close in on s*
//!    from below and the secant converges fast; every trial's repair is a valid upper bound. It stops when the
//!    bounds meet, or as soon as the arrangement cannot beat the best.
//!  - hopping: with s_t = best (1 - eps), the current arrangement is perturbed (all balls jittered, a cluster
//!    jittered, or the most squeezed or random balls moved to the emptiest places found by sampling), relaxed at
//!    s_t and accepted when its energy is lower. A hop that falls back within 0.01 of the current arrangement
//!    stops early. An accepted arrangement whose repair is near the best is polished (unless its energy is the
//!    best's: the same basin), and a polished one below the best is offered to the check. Long runs of
//!    rejections restart the chain from the best (shaken), from random centres, or from a lattice (close-packed
//!    or square layers, parallel to a face of the container) cut by the container.

use crate::energy::Energy;
use crate::lbfgs::{Budget, Lbfgs, Tol};
use crate::rng::Rng;
use crate::shape::Shape;

/// What a run reports: each checked improvement is offered through the callback, which answers the checked
/// score (None when the check failed even after enlarging).
pub type Offer<'a> = dyn FnMut(f64, &[f64]) -> Option<f64> + 'a;

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Relative compression of the hopping size below the best.
    pub eps: f64,
    /// Consecutive rejections before a restart, as a + b P.
    pub fail_a: f64,
    pub fail_b: f64,
    /// Relative precision of the polish.
    pub polish_tol: f64,
    /// An accepted hop is polished when its repaired score is below best (1 + promise).
    pub promise: f64,
    /// L-BFGS memory.
    pub memory: usize,
    /// The exploring relaxation's stopping rule: relative decrease per iteration, and how many in a row.
    pub explore_rel: f64,
    pub explore_patience: u32,
}

impl Default for Params {
    fn default() -> Params {
        let mut p = Params { eps: 1e-3, fail_a: 40.0, fail_b: 3.0, polish_tol: 2e-13, promise: 5e-3, memory: 5, explore_rel: 1e-6, explore_patience: 4 };
        // development only: FRESH_PARAMS="eps=1e-3,promise=1e-3" overrides
        if let Ok(v) = std::env::var("FRESH_PARAMS") {
            for kv in v.split(',') {
                let mut it = kv.split('=');
                let (Some(k), Some(val)) = (it.next(), it.next().and_then(|x| x.parse::<f64>().ok())) else { continue };
                match k {
                    "eps" => p.eps = val,
                    "fail_a" => p.fail_a = val,
                    "fail_b" => p.fail_b = val,
                    "polish_tol" => p.polish_tol = val,
                    "promise" => p.promise = val,
                    "memory" => p.memory = val as usize,
                    "explore_rel" => p.explore_rel = val,
                    "explore_patience" => p.explore_patience = val as u32,
                    _ => {}
                }
            }
        }
        p
    }
}

pub struct Stats {
    pub hops: u64,
    pub accepted: u64,
    pub polishes: u64,
    pub restarts: u64,
    pub improvements: u64,
    pub polish_evals: u64,
    pub hop_iters: u64,
    pub same: u64,
    pub same_iters: u64,
}

pub struct Search<'s> {
    pub shape: &'s Shape,
    pub p: usize,
    n: usize,
    pub rng: Rng,
    pub en: Energy,
    opt: Lbfgs,
    pub budget: Budget<'s>,
    pub params: Params,
    pub best_s: f64,
    pub best_x: Vec<f64>,
    pub stats: Stats,
    // scratch
    rep: Vec<f64>,
    hi_x: Vec<f64>,
    per: Vec<f64>,
    idx: Vec<usize>,
    lattice: Vec<f64>,
    keys: Vec<(f64, usize)>,
    move_wins: [f64; 4],
    move_tries: [f64; 4],
    pub debug: bool,
    debug_hops: bool,
    explore: Tol,
    /// The best arrangement's energy at the hopping size.
    best_e: f64,
}

const EXPLORE: Tol = Tol { e_stop: 1e-26, rel: 1e-6, patience: 4, gtol: 1e-13, max_iter: 3000, max_step: 0.25 };
/// Relaxed energies at one size within this relative difference are taken for the same basin (the exploring
/// relaxation leaves E about 1e-6 relative above its minimum).
const SAME: f64 = 2e-5;
/// A hop that comes back within this distance of the current arrangement (every ball) is a return to its basin.
const ANCHOR_R: f64 = 0.01;
const POLISH_EARLY: Tol = Tol { e_stop: 1e-27, rel: 1e-9, patience: 3, gtol: 1e-15, max_iter: 3000, max_step: 0.1 };
const POLISH: Tol = Tol { e_stop: 1e-27, rel: 1e-13, patience: 4, gtol: 1e-15, max_iter: 4000, max_step: 0.1 };

impl<'s> Search<'s> {
    pub fn new(shape: &'s Shape, p: usize, seed: u64, max_evals: u64, seconds: f64) -> Search<'s> {
        let n = 3 * p;
        let params = Params::default();
        let explore = Tol { rel: params.explore_rel, patience: params.explore_patience, ..EXPLORE };
        Search {
            shape,
            p,
            n,
            rng: Rng::new(seed),
            en: Energy::new(shape, p),
            opt: Lbfgs::new(n, params.memory),
            explore,
            budget: Budget::new(max_evals, seconds),
            params,
            best_s: f64::INFINITY,
            best_x: vec![0.0; n],
            stats: Stats { hops: 0, accepted: 0, polishes: 0, restarts: 0, improvements: 0, polish_evals: 0, hop_iters: 0, same: 0, same_iters: 0 },
            rep: vec![0.0; n],
            hi_x: vec![0.0; n],
            per: vec![0.0; p],
            idx: Vec::with_capacity(p),
            lattice: Vec::new(),
            keys: Vec::new(),
            move_wins: [1.0; 4],
            move_tries: [2.0; 4],
            debug: std::env::var("FRESH_DEBUG").is_ok(),
            debug_hops: std::env::var("FRESH_DEBUG_HOPS").is_ok(),
            best_e: 0.0,
        }
    }

    #[inline]
    pub fn stopped(&mut self) -> bool {
        self.budget.poll(self.en.evals)
    }

    /// Relaxes x at size s; returns the energy.
    pub fn relax(&mut self, x: &mut [f64], s: f64, tol: &Tol) -> f64 {
        self.relax_outcome(x, s, tol).e
    }

    fn relax_outcome(&mut self, x: &mut [f64], s: f64, tol: &Tol) -> crate::lbfgs::Outcome {
        self.en.set_size(s);
        self.en.invalidate();
        self.opt.minimize(&mut self.en, &mut self.budget, x, tol)
    }

    /// Makes `cur` the anchor of the hops: a hop that relaxes back to within ANCHOR_R of it (rattlers, the balls
    /// without energy at size s, excepted) stops early as a return to the same basin.
    fn set_anchor(&mut self, cur: &[f64], s: f64) {
        self.opt.anchor.copy_from_slice(cur);
        self.en.set_size(s);
        self.en.per_ball(cur, &mut self.per);
        for i in 0..self.p {
            self.opt.anchor_skip[i] = self.per[i] <= 0.0;
        }
    }

    /// The uniform-scaling repair of x into `out`; returns its size (a valid packing up to rounding, which the
    /// small factors below cover).
    pub fn repair(shape: &Shape, p: usize, x: &[f64], out: &mut [f64]) -> f64 {
        let mut d2min = f64::INFINITY;
        for i in 0..p {
            for j in i + 1..p {
                let dx = x[3 * i] - x[3 * j];
                let dy = x[3 * i + 1] - x[3 * j + 1];
                let dz = x[3 * i + 2] - x[3 * j + 2];
                let d2 = dx * dx + dy * dy + dz * dz;
                if d2 < d2min {
                    d2min = d2;
                }
            }
        }
        let lam = if d2min < 1.0 + 1e-14 { (1.0 + 1e-14) / d2min.sqrt() } else { 1.0 };
        let mut s = 0.0f64;
        for i in 0..p {
            for k in 0..3 {
                out[3 * i + k] = lam * x[3 * i + k];
            }
            s = s.max(shape.size_for(&out[3 * i..3 * i + 3]));
        }
        s * (1.0 + 1e-14)
    }

    /// Drives x towards its jamming size (see the module notes). `known` is an infeasible trial already made
    /// (size, energy) for this x, if any. Leaves the best valid packing found in `self.hi_x` and returns its size.
    pub fn polish(&mut self, x: &mut [f64], known: Option<(f64, f64)>) -> f64 {
        let ev0 = self.en.evals;
        let hi = self.polish_inner(x, known);
        self.stats.polish_evals += self.en.evals - ev0;
        hi
    }

    fn polish_inner(&mut self, x: &mut [f64], known: Option<(f64, f64)>) -> f64 {
        self.stats.polishes += 1;
        if self.debug {
            eprintln!("polish known {known:?}");
        }
        let (shape, p) = (self.shape, self.p);
        let mut hi = Search::repair(shape, p, x, &mut self.hi_x);
        let tol_rel = self.params.polish_tol;
        // the two most recent infeasible trials (size, sqrt E), and the largest infeasible size
        let mut pts: [(f64, f64); 2] = [(0.0, 0.0); 2];
        let mut npts = 0usize;
        let mut lo = 0.0f64;
        if let Some((s, e)) = known {
            if e > POLISH.e_stop && s < hi {
                pts[0] = (s, e.sqrt());
                npts = 1;
                lo = s;
            }
        }
        let mut eta = 1e-4;
        // the least size found feasible (E = 0) by a trial
        let mut feas = f64::INFINITY;
        for _ in 0..40 {
            if self.stopped() {
                break;
            }
            // the next trial: just below the secant estimate of s* from the two latest infeasible trials (its
            // error shrinks with their distance to s*, so trials that stay below s* make it converge fast)
            let mut st = if npts >= 2 {
                let (s1, g1) = pts[0];
                let (s2, g2) = pts[1];
                if g1 > g2 && s2 > s1 {
                    let est = s2 + g2 * (s2 - s1) / (g1 - g2);
                    est - 0.02 * (est - s2)
                } else {
                    lo + 0.5 * (hi - lo)
                }
            } else if npts == 1 {
                lo + 0.5 * (hi - lo)
            } else {
                hi * (1.0 - eta)
            };
            let top = hi.min(feas);
            if !(st > lo && st < top) {
                // the estimate is in the feasible range already: between the bounds
                st = if feas < hi { lo + 0.5 * (top - lo) } else { hi - 0.2 * (hi - lo) };
            }
            let tol = if hi - lo > 1e-6 * hi { &POLISH_EARLY } else { &POLISH };
            let e = self.relax(x, st, tol);
            let r = Search::repair(shape, p, x, &mut self.rep);
            if self.debug {
                eprintln!("  trial st {st:.15} e {e:.3e} repaired {r:.15} hi {hi:.15} lo {lo:.15} evals {}", self.en.evals);
            }
            if r < hi {
                hi = r;
                self.hi_x.copy_from_slice(&self.rep);
            }
            if e > POLISH.e_stop {
                if st > lo {
                    lo = st;
                }
                // keep the trials ordered by size: the latest (closest) last
                if npts == 2 {
                    if st > pts[1].0 {
                        pts[0] = pts[1];
                        pts[1] = (st, e.sqrt());
                    } else if st > pts[0].0 {
                        pts[0] = (st, e.sqrt());
                    }
                } else if npts == 1 {
                    if st > pts[0].0 {
                        pts[1] = (st, e.sqrt());
                    } else {
                        pts[1] = pts[0];
                        pts[0] = (st, e.sqrt());
                    }
                    npts = 2;
                } else {
                    pts[0] = (st, e.sqrt());
                    npts = 1;
                }
            } else {
                feas = feas.min(st);
                if npts == 0 {
                    eta *= 4.0;
                }
            }
            if hi.min(feas) - lo <= tol_rel * hi {
                break;
            }
            // give up on an arrangement that cannot beat the best: infeasible at the best size, or its secant
            // estimate (an overestimate by about the product of the trials' distances to s*) clearly above it
            if lo >= self.best_s {
                break;
            }
            if npts == 2 && hi > self.best_s {
                let (s1, g1) = pts[0];
                let (s2, g2) = pts[1];
                if g1 > g2 && s2 > s1 && s2 + g2 * (s2 - s1) / (g1 - g2) > self.best_s * (1.0 + 2e-5) {
                    break;
                }
            }
        }
        hi
    }

    /// Offers the packing in `self.hi_x` at size s when it beats the best; true when it became the best.
    fn offer_hi(&mut self, s: f64, offer: &mut Offer) -> bool {
        if s < self.best_s * (1.0 - 1e-14) {
            if let Some(checked) = offer(s, &self.hi_x) {
                if checked < self.best_s {
                    self.best_s = checked;
                    self.best_x.copy_from_slice(&self.hi_x);
                    self.stats.improvements += 1;
                    return true;
                }
            }
        }
        false
    }

    /// Random centres in the container at size s.
    pub fn start_random(&mut self, s: f64, x: &mut [f64]) {
        for i in 0..self.p {
            self.shape.random_inside(s, 0.0, &mut self.rng, &mut x[3 * i..3 * i + 3]);
        }
    }

    /// A lattice start: close-packed layers stacked ABC (FCC) or AB (HCP), or square layers (FCC seen along a
    /// cube axis), unit spacing; layers parallel to a random face of the container with rows along one of its
    /// edges (3 times in 4; a random orientation otherwise, and always in a ball), randomly shifted; the P points
    /// that need the least size, scaled about the origin until they all lie in size s (which must hold the origin's
    /// ball; the search's sizes do).
    pub fn start_lattice(&mut self, s: f64, x: &mut [f64]) {
        let kind = self.rng.below(3);
        let rot = if !self.shape.ball && self.rng.uniform() < 0.75 { self.face_frame() } else { self.rng.rotation() };
        let shift = [self.rng.uniform(), self.rng.uniform(), self.rng.uniform()];
        let reach = ((self.p as f64 * 3.0).cbrt() + 3.0).ceil() as i32;
        self.lattice.clear();
        let r3 = 3.0f64.sqrt();
        for c in -reach..=reach {
            for b in -reach..=reach {
                for a in -reach..=reach {
                    let w = match kind {
                        0 | 1 => {
                            // triangular layers a1 = (1, 0), a2 = (1/2, sqrt 3 / 2), spacing sqrt(2/3)
                            let m = if kind == 0 { c.rem_euclid(3) } else { c.rem_euclid(2) };
                            let off = [0.5 * m as f64, r3 / 6.0 * m as f64];
                            [a as f64 + 0.5 * b as f64 + off[0], b as f64 * r3 * 0.5 + off[1], c as f64 * (2.0f64 / 3.0).sqrt()]
                        }
                        _ => {
                            // square layers of side 1, alternate layers shifted by (1/2, 1/2), spacing 1 / sqrt 2
                            let m = c.rem_euclid(2) as f64 * 0.5;
                            [a as f64 + m, b as f64 + m, c as f64 * std::f64::consts::FRAC_1_SQRT_2]
                        }
                    };
                    let w = [w[0] + shift[0], w[1] + shift[1], w[2] + shift[2]];
                    self.lattice.push(rot[0] * w[0] + rot[1] * w[1] + rot[2] * w[2]);
                    self.lattice.push(rot[3] * w[0] + rot[4] * w[1] + rot[5] * w[2]);
                    self.lattice.push(rot[6] * w[0] + rot[7] * w[1] + rot[8] * w[2]);
                }
            }
        }
        let m = self.lattice.len() / 3;
        self.keys.clear();
        for k in 0..m {
            let need = self.shape.size_for(&self.lattice[3 * k..3 * k + 3]);
            self.keys.push((need, k));
        }
        let p = self.p.min(m);
        self.keys.select_nth_unstable_by(p - 1, |a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut scale = 1.0f64;
        for i in 0..p {
            let k = self.keys[i].1;
            scale = scale.min(self.shape.scale_into(s, &self.lattice[3 * k..3 * k + 3]));
        }
        // a hair inside, against rounding
        scale *= 1.0 - 1e-12;
        for i in 0..p {
            let k = self.keys[i].1;
            for d in 0..3 {
                x[3 * i + d] = scale * self.lattice[3 * k + d];
            }
        }
    }

    /// A rotation (row major) taking z to the outward normal of a random face and x to one of its edges.
    fn face_frame(&mut self) -> [f64; 9] {
        let f = self.rng.below(self.shape.nf);
        let edges = &self.shape.face_edges[f];
        if edges.is_empty() {
            return self.rng.rotation();
        }
        let t = edges[self.rng.below(edges.len())];
        let n = [self.shape.n[3 * f], self.shape.n[3 * f + 1], self.shape.n[3 * f + 2]];
        let u = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
        // columns t, u, n
        [t[0], u[0], n[0], t[1], u[1], n[1], t[2], u[2], n[2]]
    }

    /// The emptiest of `tries` random places in the container at size s: the one farthest from every centre
    /// except those flagged in `skip` (by the per-ball scratch: per[j] < 0 skips j).
    fn hole(&mut self, x: &[f64], s: f64, tries: usize, out: &mut [f64; 3]) {
        let mut best = -1.0;
        let mut c = [0.0; 3];
        for _ in 0..tries {
            self.shape.random_inside(s, 0.0, &mut self.rng, &mut c);
            let mut dmin = f64::INFINITY;
            for j in 0..self.p {
                if self.per[j] < 0.0 {
                    continue;
                }
                let dx = c[0] - x[3 * j];
                let dy = c[1] - x[3 * j + 1];
                let dz = c[2] - x[3 * j + 2];
                let d2 = dx * dx + dy * dy + dz * dz;
                if d2 < dmin {
                    dmin = d2;
                }
            }
            if dmin > best {
                best = dmin;
                *out = c;
            }
        }
    }

    fn pick_move(&mut self) -> usize {
        let mut w = [0.0; 4];
        let mut tot = 0.0;
        for k in 0..4 {
            w[k] = 0.1 + self.move_wins[k] / self.move_tries[k];
            tot += w[k];
        }
        let mut u = self.rng.uniform() * tot;
        for (k, wk) in w.iter().enumerate() {
            if u < *wk {
                return k;
            }
            u -= wk;
        }
        3
    }

    /// A perturbation of `cur` into `y` at size s; returns the kind of move.
    fn perturb(&mut self, cur: &[f64], y: &mut [f64], s: f64) -> usize {
        y.copy_from_slice(cur);
        let p = self.p;
        let kind = self.pick_move();
        match kind {
            0 => {
                // jitter every ball
                let amp = 0.02 * (25.0f64).powf(self.rng.uniform());
                for v in y.iter_mut() {
                    *v += amp * self.rng.range(-1.0, 1.0);
                }
            }
            1 => {
                // jitter a cluster about a random ball
                let c = self.rng.below(p);
                let rad = self.rng.range(1.0, 2.2);
                let amp = self.rng.range(0.2, 0.6);
                for j in 0..p {
                    let dx = cur[3 * j] - cur[3 * c];
                    let dy = cur[3 * j + 1] - cur[3 * c + 1];
                    let dz = cur[3 * j + 2] - cur[3 * c + 2];
                    if dx * dx + dy * dy + dz * dz < rad * rad {
                        for d in 0..3 {
                            y[3 * j + d] += amp * self.rng.range(-1.0, 1.0);
                        }
                    }
                }
            }
            2 | 3 => {
                // move 1..3 balls to holes: the most squeezed (kind 2) or random ones (kind 3)
                let k = 1 + self.rng.below(3.min(p));
                self.en.set_size(s);
                self.en.per_ball(cur, &mut self.per);
                self.idx.clear();
                for _ in 0..k {
                    let j = if kind == 2 {
                        // roulette on the energy share, among balls not chosen yet
                        let mut tot = 0.0;
                        for i in 0..p {
                            if self.per[i] > 0.0 {
                                tot += self.per[i];
                            }
                        }
                        if tot > 0.0 {
                            let mut u = self.rng.uniform() * tot;
                            let mut pick = p - 1;
                            for i in 0..p {
                                if self.per[i] > 0.0 {
                                    if u < self.per[i] {
                                        pick = i;
                                        break;
                                    }
                                    u -= self.per[i];
                                }
                            }
                            pick
                        } else {
                            self.rng.below(p)
                        }
                    } else {
                        self.rng.below(p)
                    };
                    if self.per[j] >= 0.0 {
                        self.per[j] = -1.0;
                        self.idx.push(j);
                    }
                }
                for t in 0..self.idx.len() {
                    let j = self.idx[t];
                    let mut c = [0.0; 3];
                    self.hole(y, s, 24, &mut c);
                    y[3 * j..3 * j + 3].copy_from_slice(&c);
                    // the moved ball now counts for the next holes
                    self.per[j] = 0.0;
                }
            }
            _ => unreachable!(),
        }
        kind
    }

    /// The whole run.
    pub fn run(&mut self, offer: &mut Offer) {
        let n = self.n;
        let mut cur = vec![0.0; n];
        let mut y = vec![0.0; n];
        // first packing: a random start compressed at a density guess, polished
        let st0 = self.shape.size_at_density(self.p, 0.55).max(1.0);
        self.start_random(st0, &mut cur);
        let tol = self.explore;
        let e = self.relax(&mut cur, st0, &tol);
        let hi = self.polish(&mut cur, Some((st0, e)));
        self.offer_hi(hi, offer);
        if self.stopped() || !self.best_s.is_finite() {
            return;
        }
        let mut st = 0.0;
        let mut cur_e = 0.0;
        self.from_best(&mut cur, &mut st, &mut cur_e);
        self.set_anchor(&cur, st);
        let mut fails = 0u64;
        let mut restart_kind = 0usize;
        loop {
            if self.stopped() {
                break;
            }
            self.stats.hops += 1;
            let kind = self.perturb(&cur, &mut y, st);
            self.move_tries[kind] += 1.0;
            let tol = self.explore;
            if self.debug_hops {
                self.opt.trace = Some(Vec::new());
            }
            self.opt.anchor_r2 = ANCHOR_R * ANCHOR_R;
            let out = self.relax_outcome(&mut y, st, &tol);
            self.opt.anchor_r2 = 0.0;
            let e = out.e;
            if self.stopped() {
                break;
            }
            if out.same {
                self.stats.same += 1;
                self.stats.same_iters += out.iters as u64;
            }
            self.stats.hop_iters += out.iters as u64;
            if let Some(tr) = self.opt.trace.take() {
                let at = |k: usize| tr.get(k).copied().unwrap_or(f64::NAN) / cur_e;
                eprintln!(
                    "hop kind {kind} iters {} E/cur at 10 {:.3} 20 {:.3} 40 {:.3} 80 {:.3} 160 {:.3} final {:.4}",
                    tr.len(), at(9), at(19), at(39), at(79), at(159), e / cur_e
                );
            }
            if !out.same && e < cur_e * (1.0 - SAME) {
                self.stats.accepted += 1;
                self.move_wins[kind] += 1.0;
                fails = 0;
                std::mem::swap(&mut cur, &mut y);
                cur_e = e;
                if (e - self.best_e).abs() > SAME * self.best_e && self.try_polish(&cur, &mut y, st, e, offer) {
                    self.from_best(&mut cur, &mut st, &mut cur_e);
                }
                self.set_anchor(&cur, st);
            } else {
                fails += 1;
            }
            let limit = (self.params.fail_a + self.params.fail_b * self.p as f64) as u64;
            if fails >= limit {
                self.stats.restarts += 1;
                fails = 0;
                restart_kind = (restart_kind + 1) % 4;
                match restart_kind {
                    0 => {
                        cur.copy_from_slice(&self.best_x);
                        scale(&mut cur, st / self.best_s);
                        let amp = 0.3;
                        for v in cur.iter_mut() {
                            *v += amp * self.rng.range(-1.0, 1.0);
                        }
                    }
                    1 => self.start_random(st, &mut cur),
                    _ => self.start_lattice(st, &mut cur),
                    // (kinds 2 and 3: a lattice start every other restart)
                }
                let tol = self.explore;
                cur_e = self.relax(&mut cur, st, &tol);
                if (cur_e - self.best_e).abs() > SAME * self.best_e && self.try_polish(&cur, &mut y, st, cur_e, offer) {
                    self.from_best(&mut cur, &mut st, &mut cur_e);
                }
                self.set_anchor(&cur, st);
            }
        }
    }

    /// Polishes a copy (in `y`) of an arrangement relaxed at size st with energy e when its repair is near the
    /// best, and offers the result; true when it became the best.
    fn try_polish(&mut self, cur: &[f64], y: &mut [f64], st: f64, e: f64, offer: &mut Offer) -> bool {
        let r = Search::repair(self.shape, self.p, cur, &mut self.rep);
        if r < self.best_s * (1.0 + self.params.promise) {
            y.copy_from_slice(cur);
            let hi = self.polish(y, Some((st, e)));
            return self.offer_hi(hi, offer);
        }
        false
    }

    /// Restarts the chain at the best packing, relaxed at the hopping size best (1 - eps).
    fn from_best(&mut self, cur: &mut [f64], st: &mut f64, cur_e: &mut f64) {
        cur.copy_from_slice(&self.best_x);
        *st = self.best_s * (1.0 - self.params.eps);
        scale(cur, *st / self.best_s);
        let tol = self.explore;
        *cur_e = self.relax(cur, *st, &tol);
        self.best_e = *cur_e;
    }
}

fn scale(x: &mut [f64], f: f64) {
    for v in x.iter_mut() {
        *v *= f;
    }
}
