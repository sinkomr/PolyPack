//! The search: monotonic basin hopping on the penalty energy at a score held slightly below the best packing
//! found, with a secant polish that drives a promising arrangement to its own jamming score.
//!
//!  - relax(x, s): L-BFGS on the energy (model.rs) at score s (free: the cell's shape free at area s^2).
//!    E = 0 means the arrangement fits at s.
//!  - repair(x): the least uniform scaling of x (centres and lattice) that separates every image pair by a hair
//!    (exact per pair, `geom::repair_scale`); its score is an upper bound for the arrangement.
//!  - polish(x): the jamming score s* of the arrangement, approached by relaxing at trial scores: below s* the
//!    relaxed energy is about k (s* - s)^2, so sqrt(E) is close to linear in s, and two infeasible trials give a
//!    secant estimate of s*; each trial is just below the estimate, so the trials close in on s* from below and
//!    every trial's repair is a valid upper bound. It stops when the bounds meet (about 1e-13 relative) or as
//!    soon as the arrangement cannot beat the best.
//!  - hopping: with s_t = best (1 - eps), the current arrangement is perturbed, relaxed at s_t and accepted when
//!    its energy is lower; an accepted arrangement whose repair is near the best is polished, and a polished one
//!    below the best is checked and becomes the best. Long runs of rejections restart the chain (from the best
//!    shaken, from random places, from a lattice arrangement).
//!
//! Every packing that enters the trace passed the server's check (`polypack_spaces::validate_space_submission`)
//! at the strict tolerance 1e-11, and the solver's own exact separation test before it.

use crate::budget::Budget;
use crate::geom::{canonicalize, inverse, min_separation, mul, repair_scale, Family, Shape, Sol};
use crate::lattice::{double_lattice, free_lattice, random_sol, superlattice, without, Arrangement};
use crate::lbfgs::{Lbfgs, Tol};
use crate::model::Model;
use crate::rng::Rng;
use serde_json::{json, Value};
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Relative compression of the hopping score below the best.
    pub eps: f64,
    /// Consecutive rejections before a restart, as a + b P.
    pub fail_a: f64,
    pub fail_b: f64,
    /// Relative precision of the polish.
    pub polish_tol: f64,
    /// An accepted hop is polished when its repaired score is below best (1 + promise).
    pub promise: f64,
    pub memory: usize,
    /// The secant trial stays this fraction of the step below the estimate.
    pub margin: f64,
    /// Bracket widths (relative) below which the polish relaxes with the early and the fine tolerance.
    pub coarse: f64,
    pub medium: f64,
}

impl Params {
    pub fn new() -> Params {
        let mut p = Params { eps: 1e-3, fail_a: 40.0, fail_b: 3.0, polish_tol: 2e-13, promise: 5e-3, memory: 7, margin: 2e-3, coarse: 1e-4, medium: 1e-7 };
        // development only: FRESH_PARAMS="eps=1e-3,promise=1e-3"
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
                    "margin" => p.margin = val,
                    "coarse" => p.coarse = val,
                    "medium" => p.medium = val,
                    _ => {}
                }
            }
        }
        p
    }
}

impl Default for Params {
    fn default() -> Self {
        Params::new()
    }
}

#[derive(Default, Debug)]
pub struct Stats {
    pub hops: u64,
    pub accepted: u64,
    pub same: u64,
    pub polishes: u64,
    pub restarts: u64,
    pub improvements: u64,
    pub polish_evals: u64,
    pub checks: u64,
    pub refused: u64,
}

/// Number of perturbation kinds.
const NM: usize = 6;

/// Relaxed energies at one score within this relative difference are taken for the same basin.
const SAME: f64 = 2e-5;

pub struct Search<'a, 'c> {
    pub id: String,
    pub fam: Family,
    pub sh: Shape,
    pub p: usize,
    pub model: Model<'a>,
    lb: Lbfgs,
    pub rng: Rng,
    pub prm: Params,
    /// The best checked score, its packing in the solver's frame and its configuration.
    pub best_s: f64,
    pub best: Sol,
    pub best_cfg: Option<Value>,
    pub trace: Vec<(f64, f64)>,
    on_improve: &'c mut dyn FnMut(f64, &Value),
    pub stats: Stats,
    /// Width of a piece (2 r): the length unit of the moves.
    width: f64,
    explore: Tol,
    polish_early: Tol,
    polish_fine: Tol,
    best_e: f64,
    move_wins: [f64; NM],
    move_tries: [f64; NM],
    /// A lower bound on the score: reaching it ends the search.
    pub bound: f64,
    pub debug: bool,
    lattices: Vec<Arrangement>,
    idx: Vec<usize>,
    /// The slope of sqrt(E) against the score below the jamming score, from the last polish (0: none yet).
    slope: f64,
}

/// The solver frame's invariants: sq and hex have the family's basis at score s; free is upper triangular with
/// det = s^2.
pub fn normalize_frame(fam: Family, sol: &mut Sol) {
    if fam == Family::Free {
        sol.b[1] = 0.0;
        sol.b[3] = sol.s * sol.s / sol.b[0];
    } else {
        sol.b = fam.basis(sol.s);
    }
}

/// The configuration in the submission format: {"lattice": {"L"} or {"b1", "b2"}, "poses": [[x, y, theta]]}.
pub fn config_value(fam: Family, sol: &Sol) -> Value {
    let poses: Vec<Value> = (0..sol.p()).map(|i| json!([sol.pos[2 * i], sol.pos[2 * i + 1], sol.ang[i]])).collect();
    if fam == Family::Free {
        json!({"lattice": {"b1": [sol.b[0], sol.b[1]], "b2": [sol.b[2], sol.b[3]]}, "poses": poses})
    } else {
        json!({"lattice": {"L": sol.s}, "poses": poses})
    }
}

/// The server's check of a torus configuration, at the strict tolerance (as for a problem without a research
/// record, which also implies validity at the default tolerance with the same score). Some(score) when valid.
pub fn check(id: &str, cfg: &Value) -> Option<f64> {
    use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};
    let v = validate_space_submission(SpaceName::Torus, id, cfg, &SpaceValidateOptions { no_record: true, ..Default::default() });
    if v.valid {
        v.score
    } else {
        None
    }
}

/// The default check (the contract's): Some(score) when valid.
pub fn check_default(id: &str, cfg: &Value) -> Option<f64> {
    use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};
    let v = validate_space_submission(SpaceName::Torus, id, cfg, &SpaceValidateOptions::default());
    if v.valid {
        v.score
    } else {
        None
    }
}

/// A lower bound on the score: the area bound at a density that bounds every packing of the piece in the plane.
pub fn lower_bound(fam: Family, sh: &Shape, p: usize) -> f64 {
    // the densities of docs/spaces/TORUS.md section 5: Thue for disks, (5 - sqrt 5)/3 for pentagons and
    // (4 + 4 sqrt 2)/(5 + 4 sqrt 2) for octagons (packings of congruent copies in the plane); 1 otherwise
    let dens = match sh.n {
        0 => PI / 12f64.sqrt(),
        5 => (5.0 - 5f64.sqrt()) / 3.0,
        8 => (4.0 + 4.0 * 2f64.sqrt()) / (5.0 + 4.0 * 2f64.sqrt()),
        _ => 1.0,
    };
    let area = p as f64 * sh.area / dens;
    match fam {
        Family::Hex => (area / (3f64.sqrt() / 2.0)).sqrt(),
        _ => area.sqrt(),
    }
}

impl<'a, 'c> Search<'a, 'c> {
    pub fn new(id: &str, fam: Family, n: usize, p: usize, seed: u64, budget: Budget<'a>, on_improve: &'c mut dyn FnMut(f64, &Value)) -> Search<'a, 'c> {
        let sh = Shape::new(n);
        let prm = Params::new();
        let width = 2.0 * sh.apo;
        let explore = Tol { e_stop: 1e-26, rel: 1e-6, patience: 4, gtol: 1e-13, max_iter: 3000, max_step: 0.25 * width };
        let polish_early = Tol { e_stop: 1e-27, rel: 1e-9, patience: 3, gtol: 1e-15, max_iter: 3000, max_step: 0.1 * width };
        let polish_fine = Tol { e_stop: 1e-27, rel: 1e-13, patience: 4, gtol: 1e-15, max_iter: 4000, max_step: 0.1 * width };
        let bound = lower_bound(fam, &sh, p);
        Search {
            id: id.to_string(),
            fam,
            p,
            model: Model::new(sh.clone(), fam, p, budget),
            lb: Lbfgs::new(prm.memory),
            rng: Rng::new(seed),
            prm,
            best_s: f64::INFINITY,
            best: Sol::new(p),
            best_cfg: None,
            trace: Vec::new(),
            on_improve,
            stats: Stats::default(),
            width,
            explore,
            polish_early,
            polish_fine,
            best_e: 0.0,
            move_wins: [1.0; NM],
            move_tries: [2.0; NM],
            bound,
            debug: std::env::var("FRESH_DEBUG").is_ok(),
            lattices: Vec::new(),
            idx: Vec::new(),
            slope: 0.0,
            sh,
        }
    }

    #[inline]
    pub fn done(&self) -> bool {
        self.model.budget.done
    }

    fn free(&self) -> bool {
        self.fam == Family::Free
    }

    /// The exactness margin of a repaired packing (absolute; grows with the coordinates' size against rounding).
    fn target(&self, s: f64) -> f64 {
        1e-13 + 4e-16 * s
    }

    /// Takes a start configuration (a valid one, usually the site leader's) as the best: it is returned unless
    /// something better is found.
    pub fn take_start(&mut self, cfg: &Value) -> bool {
        let Some(score) = check_default(&self.id, cfg) else { return false };
        let Some(sol) = parse_config(self.fam, self.p, cfg) else { return false };
        self.best_s = score;
        self.best = sol;
        self.best_cfg = Some(cfg.clone());
        true
    }

    /// Repairs a copy of `sol`, checks it and makes it the best when it beats the best. True when it did.
    pub fn offer(&mut self, sol: &Sol) -> bool {
        if self.done() && self.model.budget.reason == "bound" {
            return false;
        }
        let mut c = sol.clone();
        normalize_frame(self.fam, &mut c);
        canonicalize(&mut c, self.free());
        if self.sh.n > 0 {
            let st = self.sh.step;
            for a in c.ang.iter_mut() {
                *a = a.rem_euclid(st);
                if !(*a < st) {
                    *a = 0.0;
                }
            }
        } else {
            c.ang.fill(0.0);
        }
        let target = self.target(c.s);
        let lam = repair_scale(&self.sh, &c, target);
        if !lam.is_finite() {
            return false;
        }
        if lam > 1.0 {
            c.scale(lam);
            normalize_frame(self.fam, &mut c);
        }
        for attempt in 0..4 {
            if !(c.s < self.best_s * (1.0 - 1e-15)) {
                return false;
            }
            if min_separation(&self.sh, &c) >= 0.5 * target {
                let cfg = config_value(self.fam, &c);
                self.stats.checks += 1;
                if let Some(score) = check(&self.id, &cfg) {
                    if score < self.best_s {
                        self.best_s = score;
                        self.best = c;
                        let t = self.model.budget.elapsed();
                        self.trace.push((t, score));
                        self.stats.improvements += 1;
                        if self.debug {
                            eprintln!("t {t:.3} best {score:.12} evals {}", self.model.evals);
                        }
                        (self.on_improve)(score, &cfg);
                        self.best_cfg = Some(cfg);
                        if score <= self.bound * (1.0 + 1e-9) {
                            self.model.budget.done = true;
                            self.model.budget.reason = "bound";
                        }
                        return true;
                    }
                    return false;
                }
                self.stats.refused += 1;
            }
            c.scale(1.0 + 1e-12 * 100f64.powi(attempt));
            normalize_frame(self.fam, &mut c);
        }
        false
    }

    /// Relaxes x at its score.
    fn relax(&mut self, x: &mut Sol, tol: &Tol, check_lines: bool) -> crate::model::Relaxed {
        let tol = *tol;
        self.model.relax(&mut self.lb, x, &tol, check_lines)
    }

    /// The uniform-scaling repair of x into `out`; returns its score.
    fn repair(&self, x: &Sol, out: &mut Sol) -> f64 {
        out.copy_from(x);
        let lam = repair_scale(&self.sh, x, self.target(x.s));
        out.scale(lam);
        normalize_frame(self.fam, out);
        out.s
    }

    /// Drives x towards its jamming score (see the module notes). `known` is an infeasible trial already made
    /// (score, energy) for this x. Returns the best valid packing found (repaired), or None.
    fn polish(&mut self, x: &mut Sol, known: Option<(f64, f64)>) -> Option<Sol> {
        let ev0 = self.model.evals;
        self.stats.polishes += 1;
        let mut hi_sol = Sol::new(self.p);
        let mut rep = Sol::new(self.p);
        let mut hi = self.repair(x, &mut hi_sol);
        let tol_rel = self.prm.polish_tol;
        let mut pts: [(f64, f64); 2] = [(0.0, 0.0); 2];
        let mut npts = 0usize;
        let mut lo = 0.0f64;
        if let Some((s, e)) = known {
            if e > self.polish_fine.e_stop && s < hi {
                pts[0] = (s, e.sqrt());
                npts = 1;
                lo = s;
            }
        }
        let mut eta = 1e-4;
        let mut feas = f64::INFINITY;
        // after a trial lands on the feasible side, the next secant step is shortened (and lengthened again after
        // an infeasible one), so that the trials close in on s* from below where sqrt(E) carries information
        let mut shrink = 1.0f64;
        for _ in 0..40 {
            if self.done() {
                break;
            }
            let top = hi.min(feas);
            let mut st = if npts >= 2 {
                let (s1, g1) = pts[0];
                let (s2, g2) = pts[1];
                if g1 > g2 && s2 > s1 {
                    let est = s2 + g2 * (s2 - s1) / (g1 - g2);
                    s2 + (est - s2) * (1.0 - self.prm.margin) * shrink
                } else {
                    lo + 0.5 * (top - lo)
                }
            } else if npts == 1 {
                // one infeasible trial: the slope of sqrt(E) remembered from the last polish, conservatively
                let (s1, g1) = pts[0];
                if self.slope > 0.0 {
                    // far below s* sqrt(E) grows more slowly than near it: at least a quarter of the bracket
                    (s1 + 0.7 * shrink * g1 / self.slope).max(lo + 0.25 * (top - lo))
                } else {
                    lo + 0.5 * (hi - lo)
                }
            } else {
                hi * (1.0 - eta)
            };
            if !(st > lo && st < top) {
                st = if feas < hi { lo + 0.5 * (top - lo) } else { hi - 0.2 * (hi - lo) };
            }
            x.rescale_to(st);
            normalize_frame(self.fam, x);
            let tol = if hi - lo > self.prm.coarse * hi {
                self.explore
            } else if hi - lo > self.prm.medium * hi {
                self.polish_early
            } else {
                self.polish_fine
            };
            let e = self.relax(x, &tol, false).e;
            let r = self.repair(x, &mut rep);
            if self.debug {
                eprintln!("  trial st {st:.15} e {e:.3e} repaired {r:.15} hi {hi:.15} lo {lo:.15}");
            }
            if r < hi {
                hi = r;
                std::mem::swap(&mut hi_sol, &mut rep);
            }
            if e > self.polish_fine.e_stop {
                if st > lo {
                    lo = st;
                }
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
                shrink = (2.0 * shrink).min(1.0);
            } else {
                feas = feas.min(st);
                shrink *= 0.3;
                if npts == 0 {
                    eta *= 4.0;
                }
            }
            if hi.min(feas) - lo <= tol_rel * hi {
                break;
            }
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
        if npts == 2 && pts[0].1 > pts[1].1 && pts[1].0 > pts[0].0 {
            self.slope = (pts[0].1 - pts[1].1) / (pts[1].0 - pts[0].0);
        }
        self.stats.polish_evals += self.model.evals - ev0;
        if hi.is_finite() {
            Some(hi_sol)
        } else {
            None
        }
    }

    /// Polishes a copy of an arrangement relaxed at score st with energy e when its repair is near the best, and
    /// offers the result; true when it became the best.
    fn try_polish(&mut self, cur: &Sol, st: f64, e: f64) -> bool {
        let mut rep = Sol::new(self.p);
        let r = self.repair(cur, &mut rep);
        if r < self.best_s * (1.0 + self.prm.promise) {
            let mut y = cur.clone();
            if let Some(h) = self.polish(&mut y, Some((st, e))) {
                if h.s < self.best_s {
                    return self.offer(&h);
                }
            }
        }
        false
    }

    /// The chain restarts at the best packing, relaxed at the hopping score best (1 - eps).
    fn from_best(&mut self, cur: &mut Sol) -> (f64, f64) {
        cur.copy_from(&self.best);
        let st = self.best.s * (1.0 - self.prm.eps);
        cur.rescale_to(st);
        normalize_frame(self.fam, cur);
        let tol = self.explore;
        let e = self.relax(cur, &tol, false).e;
        self.best_e = e;
        (st, e)
    }

    /// Makes `cur` the anchor of the hops: a hop that relaxes back to within 0.01 width of it (pieces without
    /// energy excepted) stops early as a return to the same basin.
    fn set_anchor(&mut self, cur: &Sol) {
        self.model.energy(cur, true);
        for i in 0..self.p {
            self.model.anchor_skip[i] = self.model.per[i] <= 0.0;
        }
        self.model.anchor_pos.copy_from_slice(&cur.pos);
        self.model.anchor_ang.copy_from_slice(&cur.ang);
    }

    /// The emptiest of `tries` random places of the cell: the one farthest from every centre (nearest image)
    /// except those flagged in `skip`.
    fn hole(&mut self, x: &Sol, tries: usize, skip: &[bool]) -> [f64; 2] {
        let inv = inverse(&x.b);
        let mut best = (-1.0, [0.0, 0.0]);
        for _ in 0..tries {
            let c = mul(&x.b, [self.rng.uniform(), self.rng.uniform()]);
            let mut dmin = f64::INFINITY;
            for j in 0..self.p {
                if skip[j] {
                    continue;
                }
                let d = [c[0] - x.pos[2 * j], c[1] - x.pos[2 * j + 1]];
                let f = mul(&inv, d);
                let f0 = [f[0] - f[0].round(), f[1] - f[1].round()];
                for a in -1..=1 {
                    for b in -1..=1 {
                        let v = mul(&x.b, [f0[0] + a as f64, f0[1] + b as f64]);
                        let d2 = v[0] * v[0] + v[1] * v[1];
                        if d2 < dmin {
                            dmin = d2;
                        }
                    }
                }
            }
            if dmin > best.0 {
                best = (dmin, c);
            }
        }
        best.1
    }

    fn pick_move(&mut self) -> usize {
        let mut w = [0.0; NM];
        let mut tot = 0.0;
        for k in 0..NM {
            let allowed = match k {
                4 => self.sh.n > 0,
                5 => self.free(),
                2 | 3 => self.p > 1,
                1 => self.p > 2,
                _ => true,
            };
            if allowed {
                w[k] = 0.1 + self.move_wins[k] / self.move_tries[k];
                tot += w[k];
            }
        }
        let mut u = self.rng.uniform() * tot;
        for (k, wk) in w.iter().enumerate() {
            if *wk > 0.0 {
                if u < *wk {
                    return k;
                }
                u -= wk;
            }
        }
        0
    }

    /// A perturbation of `cur` into `y`; returns the kind of move.
    fn perturb(&mut self, cur: &Sol, y: &mut Sol) -> usize {
        y.copy_from(cur);
        let p = self.p;
        let wd = self.width;
        let r = self.sh.big_r;
        let poly = self.sh.n > 0;
        let kind = self.pick_move();
        match kind {
            0 => {
                // jitter every piece (and half the time every angle)
                let amp = wd * 0.02 * 25f64.powf(self.rng.uniform());
                let turn = poly && self.rng.chance(0.5);
                for i in 0..p {
                    y.pos[2 * i] += amp * self.rng.signed();
                    y.pos[2 * i + 1] += amp * self.rng.signed();
                    if turn {
                        y.ang[i] += amp / r * self.rng.signed();
                    }
                }
            }
            1 => {
                // jitter a cluster about a random piece
                let c = self.rng.below(p);
                let rad = wd * (1.0 + 1.2 * self.rng.uniform());
                let amp = wd * (0.2 + 0.4 * self.rng.uniform());
                let inv = inverse(&cur.b);
                for j in 0..p {
                    let d = [cur.pos[2 * j] - cur.pos[2 * c], cur.pos[2 * j + 1] - cur.pos[2 * c + 1]];
                    let f = mul(&inv, d);
                    let v = mul(&cur.b, [f[0] - f[0].round(), f[1] - f[1].round()]);
                    if v[0] * v[0] + v[1] * v[1] < rad * rad {
                        y.pos[2 * j] += amp * self.rng.signed();
                        y.pos[2 * j + 1] += amp * self.rng.signed();
                        if poly {
                            y.ang[j] += 0.5 * self.sh.step * self.rng.signed();
                        }
                    }
                }
            }
            2 | 3 => {
                // move 1..3 pieces to holes: the most squeezed (kind 2) or random ones (kind 3)
                let k = 1 + self.rng.below(3.min(p - 1));
                let mut per = vec![0.0; p];
                if kind == 2 {
                    self.model.energy(cur, true);
                    per.copy_from_slice(&self.model.per);
                }
                let mut skip = vec![false; p];
                self.idx.clear();
                for _ in 0..k {
                    let j = if kind == 2 {
                        let mut tot = 0.0;
                        for i in 0..p {
                            if !skip[i] && per[i] > 0.0 {
                                tot += per[i];
                            }
                        }
                        if tot > 0.0 {
                            let mut u = self.rng.uniform() * tot;
                            let mut pick = p - 1;
                            for i in 0..p {
                                if !skip[i] && per[i] > 0.0 {
                                    if u < per[i] {
                                        pick = i;
                                        break;
                                    }
                                    u -= per[i];
                                }
                            }
                            pick
                        } else {
                            self.rng.below(p)
                        }
                    } else {
                        self.rng.below(p)
                    };
                    if !skip[j] {
                        skip[j] = true;
                        self.idx.push(j);
                    }
                }
                let idx = std::mem::take(&mut self.idx);
                for &j in &idx {
                    let c = self.hole(y, 24, &skip);
                    y.pos[2 * j] = c[0];
                    y.pos[2 * j + 1] = c[1];
                    if poly {
                        y.ang[j] = self.rng.uniform() * self.sh.step;
                    }
                    skip[j] = false;
                }
                self.idx = idx;
            }
            4 => {
                // turn pieces: one or two at random angles, a flip by half a period, or a neighbour's angle
                let roll = self.rng.uniform();
                let i = self.rng.below(p);
                if roll < 0.4 {
                    y.ang[i] += self.sh.step * self.rng.uniform();
                    if p > 1 && self.rng.chance(0.5) {
                        let j = self.rng.below(p);
                        y.ang[j] += self.sh.step * self.rng.uniform();
                    }
                } else if roll < 0.7 {
                    y.ang[i] += 0.5 * self.sh.step;
                } else {
                    // the angle of the nearest other piece (or its half-period flip)
                    let inv = inverse(&cur.b);
                    let mut nb = i;
                    let mut bd = f64::INFINITY;
                    for j in 0..p {
                        if j == i {
                            continue;
                        }
                        let d = [cur.pos[2 * j] - cur.pos[2 * i], cur.pos[2 * j + 1] - cur.pos[2 * i + 1]];
                        let f = mul(&inv, d);
                        let v = mul(&cur.b, [f[0] - f[0].round(), f[1] - f[1].round()]);
                        let d2 = v[0] * v[0] + v[1] * v[1];
                        if d2 < bd {
                            bd = d2;
                            nb = j;
                        }
                    }
                    y.ang[i] = cur.ang[nb] + if self.sh.n % 2 == 1 && self.rng.chance(0.5) { 0.5 * self.sh.step } else { 0.0 };
                }
            }
            _ => {
                // deform the free cell at fixed area (the centres follow it): stretch and shear
                let a = 0.05 * self.rng.signed();
                let sh = 0.08 * self.rng.signed();
                let inv = inverse(&y.b);
                let q = a.exp();
                let s = y.s;
                let b0 = y.b[0] * q;
                let nb = [b0, 0.0, y.b[2] + sh * b0, s * s / b0];
                for i in 0..p {
                    let f = mul(&inv, [y.pos[2 * i], y.pos[2 * i + 1]]);
                    let c = mul(&nb, f);
                    y.pos[2 * i] = c[0];
                    y.pos[2 * i + 1] = c[1];
                }
                y.b = nb;
                y.lines.clear();
            }
        }
        kind
    }

    /// A fresh arrangement at score st: random places (kind 1), a lattice arrangement shaken (kind 2), or the
    /// best shaken hard (kind 0).
    fn restart(&mut self, kind: usize, st: f64, cur: &mut Sol) {
        let p = self.p;
        match kind {
            0 => {
                cur.copy_from(&self.best);
                cur.rescale_to(st);
                normalize_frame(self.fam, cur);
                let amp = 0.3 * self.width;
                for i in 0..self.p {
                    cur.pos[2 * i] += amp * self.rng.signed();
                    cur.pos[2 * i + 1] += amp * self.rng.signed();
                    if self.sh.n > 0 && self.rng.chance(0.3) {
                        cur.ang[i] += self.sh.step * self.rng.uniform();
                    }
                }
            }
            1 => {
                let shape = if self.free() { Some(self.best.b) } else { None };
                *cur = random_sol(self.fam, &self.sh, self.p, st, shape.as_ref(), &mut self.rng);
            }
            3 if p > 1 => {
                // a lattice of P + k pieces with k left out (k = 0..3); for odd N a double lattice
                let k = self.rng.below(4);
                let mut got = None;
                if self.sh.n % 2 == 1 {
                    let pd = p + k + (p + k) % 2;
                    if let Some(d) = double_lattice(&self.sh, self.fam, pd, &mut self.rng) {
                        got = Some(self.drop_pieces(d, pd - p));
                    }
                }
                if got.is_none() {
                    let pp = p + k;
                    let a = if self.free() {
                        free_lattice(&self.sh, pp, Some(&mut self.rng)).sol
                    } else {
                        let mut ls = superlattice(&self.sh, self.fam, pp, 3, Some(&mut self.rng));
                        let pick = self.rng.below(ls.len());
                        ls.swap_remove(pick).sol
                    };
                    got = Some(self.drop_pieces(a, k));
                }
                let mut d = got.unwrap();
                normalize_frame(self.fam, &mut d);
                cur.copy_from(&d);
                cur.rescale_to(st);
                normalize_frame(self.fam, cur);
            }
            _ => {
                let arr = if self.free() {
                    free_lattice(&self.sh, self.p, Some(&mut self.rng))
                } else {
                    let k = self.rng.below(self.lattices.len().max(1));
                    self.lattices.get(k).cloned().unwrap_or_else(|| superlattice(&self.sh, self.fam, self.p, 1, None).remove(0))
                };
                cur.copy_from(&arr.sol);
                cur.rescale_to(st);
                normalize_frame(self.fam, cur);
                let amp = 0.05 * self.width;
                for i in 0..self.p {
                    cur.pos[2 * i] += amp * self.rng.signed();
                    cur.pos[2 * i + 1] += amp * self.rng.signed();
                }
            }
        }
        cur.lines.clear();
        canonicalize(cur, self.free());
    }

    /// The constructive phase: lattice arrangements (the family's superlattices of index P, of index P + 1 with
    /// one piece left out, and for odd N double lattices), each valid at once and offered; then the best few are
    /// polished.
    fn constructive(&mut self) {
        let p = self.p;
        let mut cands: Vec<Sol> = Vec::new();
        // arrangements of P + k pieces with k left out (vacancies): a perfect arrangement of a nearby count often
        // beats every arrangement of P itself (triangles: the 5 x 5 tiling of the hexagonal torus minus two for P = 48)
        let kmax = if p < 2 { 0 } else { 3 };
        for k in 0..=kmax {
            let pp = p + k;
            if self.free() {
                let a = free_lattice(&self.sh, pp, None);
                cands.push(self.drop_pieces(a.sol, k));
            } else {
                let ls = superlattice(&self.sh, self.fam, pp, if k == 0 { 6 } else { 2 }, None);
                for a in ls.iter().take(if k == 0 { 3 } else { 2 }) {
                    cands.push(self.drop_pieces(a.sol.clone(), k));
                }
                if k == 0 {
                    self.lattices = ls;
                }
            }
            if self.sh.n % 2 == 1 && pp % 2 == 0 {
                for _ in 0..if k <= 1 { 3 } else { 2 } {
                    if let Some(d) = double_lattice(&self.sh, self.fam, pp, &mut self.rng) {
                        cands.push(self.drop_pieces(d, k));
                    }
                }
            }
        }
        for c in cands.iter_mut() {
            normalize_frame(self.fam, c);
        }
        for c in &cands {
            self.offer(c);
            if self.done() {
                return;
            }
        }
        cands.sort_by(|a, b| a.s.partial_cmp(&b.s).unwrap());
        for c in cands.iter().take(4) {
            if self.done() {
                return;
            }
            let mut x = c.clone();
            if let Some(h) = self.polish(&mut x, None) {
                if h.s < self.best_s {
                    self.offer(&h);
                }
            }
        }
    }

    /// Leaves k random pieces out.
    fn drop_pieces(&mut self, mut sol: Sol, k: usize) -> Sol {
        for _ in 0..k {
            let i = self.rng.below(sol.p());
            sol = without(&sol, i);
        }
        sol
    }

    /// The whole run.
    pub fn run(&mut self) {
        let p = self.p;
        self.constructive();
        if self.done() || !self.best_s.is_finite() {
            return;
        }
        let mut cur = Sol::new(p);
        let mut y = Sol::new(p);
        // a random start at the best's score, compressed and polished
        {
            let st = self.best.s * (1.0 - self.prm.eps);
            self.restart(1, st, &mut cur);
            let tol = self.explore;
            let e = self.relax(&mut cur, &tol, true).e;
            self.try_polish(&cur, st, e);
        }
        if self.done() {
            return;
        }
        let (mut st, mut cur_e) = self.from_best(&mut cur);
        canonicalize(&mut cur, self.free());
        self.set_anchor(&cur);
        let mut fails = 0u64;
        let mut restart_kind = 0usize;
        let anchor_r = 0.01 * self.width;
        loop {
            if self.done() {
                break;
            }
            self.stats.hops += 1;
            let kind = self.perturb(&cur, &mut y);
            self.move_tries[kind] += 1.0;
            self.model.anchor_r = anchor_r;
            let tol = self.explore;
            let out = self.relax(&mut y, &tol, true);
            self.model.anchor_r = 0.0;
            let e = out.e;
            if self.done() {
                break;
            }
            if out.same {
                self.stats.same += 1;
            }
            if !out.same && e < cur_e * (1.0 - SAME) {
                self.stats.accepted += 1;
                self.move_wins[kind] += 1.0;
                fails = 0;
                std::mem::swap(&mut cur, &mut y);
                canonicalize(&mut cur, self.free());
                cur_e = e;
                if (e - self.best_e).abs() > SAME * self.best_e && self.try_polish(&cur, st, e) {
                    (st, cur_e) = self.from_best(&mut cur);
                    canonicalize(&mut cur, self.free());
                }
                if self.done() {
                    break;
                }
                self.set_anchor(&cur);
            } else {
                fails += 1;
            }
            let limit = (self.prm.fail_a + self.prm.fail_b * p as f64) as u64;
            if fails >= limit {
                self.stats.restarts += 1;
                fails = 0;
                restart_kind = (restart_kind + 1) % 4;
                let k = restart_kind;
                self.restart(k, st, &mut cur);
                let tol = self.explore;
                cur_e = self.relax(&mut cur, &tol, true).e;
                if self.done() {
                    break;
                }
                if (cur_e - self.best_e).abs() > SAME * self.best_e && self.try_polish(&cur, st, cur_e) {
                    (st, cur_e) = self.from_best(&mut cur);
                }
                canonicalize(&mut cur, self.free());
                if self.done() {
                    break;
                }
                self.set_anchor(&cur);
            }
        }
    }
}

/// A configuration of the problem parsed into the solver's frame (free: reduced, turned so that b1 lies along
/// +x). None when it is not one.
pub fn parse_config(fam: Family, p: usize, cfg: &Value) -> Option<Sol> {
    let lat = cfg.get("lattice")?;
    let poses = cfg.get("poses")?.as_array()?;
    if poses.len() != p {
        return None;
    }
    let mut sol = Sol::new(p);
    for (i, q) in poses.iter().enumerate() {
        let q = q.as_array()?;
        sol.pos[2 * i] = q.first()?.as_f64()?;
        sol.pos[2 * i + 1] = q.get(1)?.as_f64()?;
        sol.ang[i] = q.get(2)?.as_f64()?;
    }
    if fam == Family::Free {
        let b1 = lat.get("b1")?.as_array()?;
        let b2 = lat.get("b2")?.as_array()?;
        sol.b = [b1.first()?.as_f64()?, b1.get(1)?.as_f64()?, b2.first()?.as_f64()?, b2.get(1)?.as_f64()?];
        let d = crate::geom::det(&sol.b);
        if !(d.abs() > 0.0) {
            return None;
        }
        sol.s = d.abs().sqrt();
        // force the canonical frame (reduce, turn)
        sol.b[1] += 0.0;
        let (rb, _) = crate::geom::gauss_reduce(&sol.b);
        sol.b = rb;
        let a = rb[1].atan2(rb[0]);
        crate::geom::rotate(&mut sol, -a);
        normalize_frame(fam, &mut sol);
    } else {
        sol.s = lat.get("L")?.as_f64()?;
        sol.b = fam.basis(sol.s);
    }
    if !sol.s.is_finite() || sol.s <= 0.0 {
        return None;
    }
    canonicalize(&mut sol, fam == Family::Free);
    Some(sol)
}
