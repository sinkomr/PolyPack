//! The search: monotonic basin hopping on the penalty energy at a container size held slightly below the best
//! packing found, with a secant polish that drives a promising arrangement to its own jamming size.
//!
//!  - relax(state, s): L-BFGS on the energy at size s (energy.rs), in segments between pair-list rebuilds.
//!    E = 0 means the arrangement fits at s.
//!  - repair(state): the valid packing of an arrangement (repair.rs): centres scaled about the origin until every
//!    near pair is separated along its plane, the size the least that holds every vertex. Its size is an upper
//!    bound for the arrangement.
//!  - polish(state): the jamming size s* of the arrangement, approached by relaxing at trial sizes: below s* the
//!    relaxed energy is about k (s* - s)^2, so sqrt(E) is close to linear in s, and two infeasible trials give a
//!    secant estimate of s*; each trial is just below the estimate, so the trials close in on s* from below; every
//!    trial's repair is a valid upper bound. It stops when the bounds meet, or as soon as the arrangement cannot
//!    beat the best.
//!  - hopping: with s_t = best (1 - eps), the current arrangement is perturbed (every piece jittered, a cluster
//!    jittered, the most squeezed or random pieces moved to the emptiest places found by sampling with a random
//!    orientation, one piece turned, two neighbours' orientations swapped), relaxed at s_t and accepted when its
//!    energy is lower. A hop that falls back to the current arrangement stops early. An accepted arrangement whose
//!    repair is near the best is polished, and a polished packing below the best is offered to the check. Long runs
//!    of rejections restart the chain from the best (shaken), from random poses, or from a lattice cut by the
//!    container (close-packed circumscribed balls, or boxes: a common orientation on the lattice of the piece's
//!    bounding box).
//!  - the first packing: the better of the two lattice packings that are valid as built (balls of the circumradius
//!    close-packed, or bounding boxes stacked), at the least size that holds them; it takes no relaxation.

use crate::energy::{Energy, State};
use crate::lbfgs::{Budget, Lbfgs, Outcome, Tol};
use crate::model::{dot, qexp, qmul, qnormalize, r_mul, rot, rt_mul, Problem};
use crate::repair::{Packing, Repairer};
use crate::rng::Rng;

/// What the search tells the check about a packing it offers.
#[derive(Clone, Copy, Debug)]
pub struct OfferCtx {
    /// A trial of a polish still running (the caller may skip it to save the check's time).
    pub interim: bool,
    /// The budget is spent (the caller may skip a check that would run long past it).
    pub stopped: bool,
}

/// The checked score of a packing offered (None when the check refused it even after enlarging, or the caller
/// skipped it).
pub type Offer<'a> = dyn FnMut(&Packing, OfferCtx) -> Option<f64> + 'a;

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Relative compression of the hopping size below the best.
    pub eps: f64,
    /// Consecutive rejections before a restart, a + b P.
    pub fail_a: f64,
    pub fail_b: f64,
    /// Relative precision of the polish.
    pub polish_tol: f64,
    /// An accepted hop is polished when its repaired size is below best (1 + promise).
    pub promise: f64,
    pub memory: usize,
    pub explore_rel: f64,
    pub explore_patience: u32,
    /// Neighbour-list skin (internal units: circumradius 1).
    pub skin: f64,
    /// Density of the first random start.
    pub density: f64,
    /// Exponent of the penalty: 2 or 3.
    pub power: f64,
    /// Stopping rule of the polish's relaxations: relative decrease per iteration (late and early trials) and
    /// the iteration cap.
    pub polish_rel: f64,
    pub polish_early_rel: f64,
    pub polish_iter: u32,
    /// Largest move of a variable per L-BFGS step: polishing, exploring.
    pub polish_step: f64,
    pub explore_step: f64,
    /// Windowed stopping rules (see lbfgs::Tol): polishing, exploring.
    pub polish_window: u32,
    pub polish_window_rel: f64,
    pub explore_window: u32,
    pub explore_window_rel: f64,
    /// Relaxed energies at one size within this relative difference are taken for the same basin.
    pub same: f64,
    /// Compression of a new best before it is polished again (0: no refinement).
    pub refine_eps: f64,
    /// Each chain hops at eps times spread^u, u uniform in [-1, 1] (1: always eps).
    pub eps_spread: f64,
    /// A polish offers a trial packing on the way when it beats the best by this much (relative).
    pub interim: f64,
    /// Local hops (P >= local_min_p): after a move of a few pieces only those within local_r (internal units,
    /// circumradius 1) of them relax first.
    pub local_r: f64,
    pub local_min_p: f64,
    /// A polish within 1e-9 of its bounds stops after a trial of more evaluations than this.
    pub polish_dear: u64,
    /// Preconditioner factors: centres, quaternions, plane directions, plane offsets.
    pub hc: f64,
    pub hq: f64,
    pub hw: f64,
    pub he: f64,
}

impl Default for Params {
    fn default() -> Params {
        let mut p = Params {
            eps: 2e-3,
            fail_a: 30.0,
            fail_b: 2.0,
            polish_tol: 1e-12,
            promise: 1e-2,
            memory: 6,
            explore_rel: 1e-6,
            explore_patience: 4,
            skin: 0.6,
            density: 0.35,
            power: 2.0,
            polish_rel: 1e-13,
            polish_early_rel: 1e-9,
            polish_iter: 6000,
            polish_step: 0.05,
            explore_step: 0.15,
            polish_window: 40,
            polish_window_rel: 1e-3,
            explore_window: 40,
            explore_window_rel: 1e-3,
            same: 1e-3,
            refine_eps: 0.0,
            eps_spread: 4.0,
            interim: 1e-3,
            local_r: 4.0,
            local_min_p: 24.0,
            polish_dear: 1500,
            hc: 1.0,
            hq: 1.0,
            hw: 1.0,
            he: 1.0,
        };
        // development only: FRESH_PARAMS="eps=1e-3,skin=0.4" overrides
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
                    "skin" => p.skin = val,
                    "density" => p.density = val,
                    "prel" => p.polish_rel = val,
                    "pearly" => p.polish_early_rel = val,
                    "piter" => p.polish_iter = val as u32,
                    "pstep" => p.polish_step = val,
                    "pwin" => p.polish_window = val as u32,
                    "pwrel" => p.polish_window_rel = val,
                    "ewin" => p.explore_window = val as u32,
                    "ewrel" => p.explore_window_rel = val,
                    "same" => p.same = val,
                    "refine" => p.refine_eps = val,
                    "spread" => p.eps_spread = val,
                    "interim" => p.interim = val,
                    "local_r" => p.local_r = val,
                    "local_min_p" => p.local_min_p = val,
                    "dear" => p.polish_dear = val as u64,
                    "estep" => p.explore_step = val,
                    "power" => p.power = val,
                    "hc" => p.hc = val,
                    "hq" => p.hq = val,
                    "hw" => p.hw = val,
                    "he" => p.he = val,
                    _ => {}
                }
            }
        }
        p
    }
}

#[derive(Default, Debug)]
pub struct Stats {
    pub hops: u64,
    pub accepted: u64,
    pub polishes: u64,
    pub restarts: u64,
    pub improvements: u64,
    pub polish_evals: u64,
    pub hop_iters: u64,
    pub same: u64,
    pub segments: u64,
    pub polish_trials: u64,
    pub refines: u64,
    pub local_hops: u64,
    pub refined: u64,
    pub polish_capped: u64,
    pub moves: [u64; NMOVES],
    pub wins: [u64; NMOVES],
}

const NMOVES: usize = 7;

const EXPLORE: Tol = Tol { e_stop: 1e-26, rel: 1e-6, patience: 4, gtol: 1e-14, max_iter: 4000, max_step: 0.15, window: 0, window_rel: 0.0 };
const POLISH_EARLY: Tol =
    Tol { e_stop: 1e-28, rel: 1e-9, patience: 3, gtol: 1e-16, max_iter: 4000, max_step: 0.05, window: 0, window_rel: 0.0 };
const POLISH: Tol = Tol { e_stop: 1e-28, rel: 1e-13, patience: 4, gtol: 1e-16, max_iter: 6000, max_step: 0.05, window: 0, window_rel: 0.0 };
/// A hop that comes back within this distance of the current arrangement is a return to its basin.
const ANCHOR_R: f64 = 0.01;

pub struct Search<'a> {
    pub prob: &'a Problem,
    pub p: usize,
    pub rng: Rng,
    pub en: Energy,
    pub opt: Lbfgs,
    pub budget: Budget<'a>,
    pub params: Params,
    pub best_s: f64,
    /// The best packing's arrangement (internal units).
    pub best: State,
    pub stats: Stats,
    rep: Repairer,
    dirty: Vec<bool>,
    any_dirty: bool,
    per: Vec<f64>,
    move_wins: [f64; NMOVES],
    move_tries: [f64; NMOVES],
    explore: Tol,
    polish_early: Tol,
    polish_tol: Tol,
    best_e: f64,
    hi_state: State,
    hi_pack: Packing,
    pub debug: bool,
}

impl<'a> Search<'a> {
    pub fn new(prob: &'a Problem, seed: u64, budget: Budget<'a>) -> Search<'a> {
        let p = prob.p;
        let params = Params::default();
        let mut en = Energy::new(&prob.piece, &prob.cont, p);
        en.skin = params.skin;
        en.cubic = params.power >= 3.0;
        let pw = en.power();
        // energies of the overlaps the tolerances aim at: 1e-13 exploring, 1e-14 polishing
        let explore = Tol {
            rel: params.explore_rel,
            patience: params.explore_patience,
            e_stop: 1e-13f64.powf(pw),
            gtol: 1e-14f64.powf(pw - 1.0),
            max_step: params.explore_step,
            window: params.explore_window,
            window_rel: params.explore_window_rel,
            ..EXPLORE
        };
        let polish_early = Tol {
            e_stop: 1e-14f64.powf(pw),
            gtol: 1e-16f64.powf(pw - 1.0),
            rel: params.polish_early_rel,
            max_iter: params.polish_iter,
            max_step: params.polish_step,
            window: params.polish_window,
            window_rel: params.polish_window_rel,
            ..POLISH_EARLY
        };
        let polish_tol = Tol {
            e_stop: 1e-14f64.powf(pw),
            gtol: 1e-16f64.powf(pw - 1.0),
            rel: params.polish_rel,
            max_iter: params.polish_iter,
            max_step: params.polish_step,
            window: params.polish_window,
            window_rel: params.polish_window_rel,
            ..POLISH
        };
        Search {
            prob,
            p,
            rng: Rng::new(seed),
            en,
            opt: Lbfgs::new(p, params.memory),
            budget,
            params,
            best_s: f64::INFINITY,
            best: State::default(),
            stats: Stats::default(),
            rep: Repairer::default(),
            dirty: vec![false; p],
            any_dirty: false,
            per: vec![0.0; p],
            move_wins: [1.0; NMOVES],
            move_tries: [2.0; NMOVES],
            explore,
            polish_early,
            polish_tol,
            best_e: 0.0,
            hi_state: State::default(),
            hi_pack: Packing::default(),
            debug: std::env::var("FRESH_DEBUG").is_ok(),
        }
    }

    /// E^(1/p): close to linear in the size near the jamming size.
    #[inline]
    fn root(&self, e: f64) -> f64 {
        if self.en.cubic {
            e.cbrt()
        } else {
            e.sqrt()
        }
    }

    #[inline]
    pub fn stopped(&mut self) -> bool {
        self.budget.poll(self.en.evals)
    }

    fn mark_dirty(&mut self, i: usize) {
        self.dirty[i] = true;
        self.any_dirty = true;
    }

    /// Relaxes the state at size s: L-BFGS segments between rebuilds of the pair list.
    pub fn relax(&mut self, st: &mut State, s: f64, tol: &Tol) -> Outcome {
        self.en.s = s;
        if self.any_dirty {
            self.en.rebuild(st, Some(&self.dirty));
            self.dirty.iter_mut().for_each(|d| *d = false);
            self.any_dirty = false;
        } else {
            self.en.rebuild(st, None);
        }
        let mut segments = 0;
        loop {
            self.set_h0(st.x.len());
            std::mem::swap(&mut self.en.pairs, &mut st.pairs);
            let out = self.opt.minimize(&mut self.en, &mut self.budget, &mut st.x, tol);
            std::mem::swap(&mut self.en.pairs, &mut st.pairs);
            self.stats.segments += 1;
            segments += 1;
            if out.stale && !self.budget.stopped && segments < 200 {
                self.en.rebuild(st, None);
                continue;
            }
            return out;
        }
    }

    /// The preconditioner: constant factors per kind of variable (development: FRESH_PARAMS hc, hq, hw, he).
    fn set_h0(&mut self, n: usize) {
        let pr = &self.params;
        if pr.hc == 1.0 && pr.hq == 1.0 && pr.hw == 1.0 && pr.he == 1.0 {
            self.opt.h0.clear();
            return;
        }
        let p = self.p;
        self.opt.h0.resize(n, 1.0);
        for i in 0..p {
            for k in 0..3 {
                self.opt.h0[7 * i + k] = pr.hc;
            }
            for k in 3..7 {
                self.opt.h0[7 * i + k] = pr.hq;
            }
        }
        let mut k = 7 * p;
        while k + 4 <= n {
            self.opt.h0[k] = pr.hw;
            self.opt.h0[k + 1] = pr.hw;
            self.opt.h0[k + 2] = pr.hw;
            self.opt.h0[k + 3] = pr.he;
            k += 4;
        }
    }

    /// The energy of a state at size s (its own pair list, rebuilt).
    pub fn energy_of(&mut self, st: &mut State, s: f64) -> f64 {
        self.en.s = s;
        self.en.rebuild(st, None);
        std::mem::swap(&mut self.en.pairs, &mut st.pairs);
        let mut g = vec![0.0; st.x.len()];
        let e = self.en.eval(&st.x, &mut g);
        std::mem::swap(&mut self.en.pairs, &mut st.pairs);
        e
    }

    /// Each piece's energy share at size s.
    fn per_piece(&mut self, st: &mut State, s: f64) {
        self.en.s = s;
        self.en.rebuild(st, None);
        std::mem::swap(&mut self.en.pairs, &mut st.pairs);
        let mut per = std::mem::take(&mut self.per);
        self.en.per_piece(&st.x, &mut per);
        self.per = per;
        std::mem::swap(&mut self.en.pairs, &mut st.pairs);
    }

    fn set_anchor(&mut self, cur: &mut State, s: f64) {
        self.per_piece(cur, s);
        for i in 0..self.p {
            let c = &cur.x[7 * i..7 * i + 7];
            let qn = (c[3] * c[3] + c[4] * c[4] + c[5] * c[5] + c[6] * c[6]).sqrt();
            let a = &mut self.opt.anchor[7 * i..7 * i + 7];
            a[0] = c[0];
            a[1] = c[1];
            a[2] = c[2];
            for k in 3..7 {
                a[k] = c[k] / qn;
            }
            self.opt.anchor_skip[i] = self.per[i] <= 0.0;
        }
    }

    /// The state of a packing (true units) with the pair list and planes of `planes_from`.
    fn state_of_packing(&self, pk: &Packing, planes_from: &State, out: &mut State) {
        let rho = self.prob.piece.rho;
        out.x.clear();
        for pose in &pk.poses {
            out.x.extend_from_slice(&[pose[0] / rho, pose[1] / rho, pose[2] / rho, pose[3], pose[4], pose[5], pose[6]]);
        }
        out.pairs.clone_from(&planes_from.pairs);
        out.x.extend_from_slice(&planes_from.x[7 * self.p..]);
    }

    /// Drives the arrangement towards its jamming size (see the module notes). `known` is an infeasible trial
    /// already made (size, energy). Leaves the best valid packing found in `hi_pack` (its state in `hi_state`) and
    /// returns its size.
    pub fn polish(&mut self, x: &mut State, known: Option<(f64, f64)>) -> f64 {
        self.polish_with(x, known, None)
    }

    /// `polish`, offering on the way every trial packing that beats the best by more than `params.interim`
    /// (relative): a long polish of many pieces then reports its progress.
    pub fn polish_with(&mut self, x: &mut State, known: Option<(f64, f64)>, offer: Option<&mut Offer>) -> f64 {
        let ev0 = self.en.evals;
        let hi = self.polish_inner(x, known, offer);
        self.stats.polish_evals += self.en.evals - ev0;
        hi
    }

    fn polish_inner(&mut self, x: &mut State, known: Option<(f64, f64)>, mut offer: Option<&mut Offer>) -> f64 {
        self.stats.polishes += 1;
        let prob = self.prob;
        self.hi_pack = self.rep.repair(prob, x, 1.0);
        self.hi_state.clone_from(x);
        let mut hi = self.hi_pack.s;
        if self.debug {
            eprintln!("polish known {known:?} start repaired {hi:.12}");
        }
        let tol_rel = self.params.polish_tol;
        let mut pts: [(f64, f64); 2] = [(0.0, 0.0); 2];
        let mut npts = 0usize;
        let mut lo = 0.0f64;
        if let Some((s, e)) = known {
            if e > self.polish_tol.e_stop && s < hi {
                pts[0] = (s, self.root(e));
                npts = 1;
                lo = s;
            }
        }
        let mut eta = if npts > 0 { 1e-4 } else { 2e-3 };
        let mut feas = f64::INFINITY;
        for _ in 0..40 {
            if self.stopped() {
                break;
            }
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
                st = if feas < hi { lo + 0.5 * (top - lo) } else { hi - 0.2 * (hi - lo) };
            }
            // coarse trials while the bounds are far apart, precise ones at the end
            let gap = hi.min(feas) - lo;
            let tol = if gap > 1e-3 * hi {
                self.explore
            } else if gap > 1e-6 * hi {
                self.polish_early
            } else {
                self.polish_tol
            };
            let ev_trial = self.en.evals;
            let out = self.relax(x, st, &tol);
            let trial_evals = self.en.evals - ev_trial;
            let e = out.e;
            self.stats.polish_trials += 1;
            if out.iters >= tol.max_iter {
                self.stats.polish_capped += 1;
            }
            let r = self.rep.repair(prob, x, 1.0);
            if self.debug {
                eprintln!("  trial st {st:.15} e {e:.3e} repaired {:.15} hi {hi:.15} lo {lo:.15} evals {}", r.s, self.en.evals);
            }
            if r.s < hi {
                hi = r.s;
                self.hi_pack = r;
                self.hi_state.clone_from(x);
                if let Some(o) = offer.as_deref_mut() {
                    if hi < self.best_s * (1.0 - self.params.interim) {
                        self.offer_hi_ctx(o, true);
                    }
                }
            }
            if e > self.polish_tol.e_stop {
                if st > lo {
                    lo = st;
                }
                if npts == 2 {
                    if st > pts[1].0 {
                        pts[0] = pts[1];
                        pts[1] = (st, self.root(e));
                    } else if st > pts[0].0 {
                        pts[0] = (st, self.root(e));
                    }
                } else if npts == 1 {
                    if st > pts[0].0 {
                        pts[1] = (st, self.root(e));
                    } else {
                        pts[1] = pts[0];
                        pts[0] = (st, self.root(e));
                    }
                    npts = 2;
                } else {
                    pts[0] = (st, self.root(e));
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
            // the last digits are dear for many pieces: past 1e-9, stop once a trial takes long
            if hi.min(feas) - lo <= 1e-9 * hi && trial_evals > self.params.polish_dear {
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
        hi
    }

    /// The state of a packing (true units), without planes.
    pub fn state_from_packing(&self, pk: &Packing) -> State {
        let empty = State { x: vec![0.0; 7 * self.p], pairs: Vec::new() };
        let mut st = State::default();
        self.state_of_packing(pk, &empty, &mut st);
        st
    }

    /// Development: polishes the best arrangement again (no check) and keeps the result when it is smaller.
    pub fn repolish_best(&mut self) -> f64 {
        let mut x = self.best.clone();
        let hi = self.polish(&mut x, None);
        if hi < self.best_s {
            self.best_s = hi;
            let mut b = std::mem::take(&mut self.best);
            self.state_of_packing(&self.hi_pack, &self.hi_state, &mut b);
            self.best = b;
        }
        self.best_s
    }

    /// Offers `hi_pack` when it beats the best; true when it became the best.
    fn offer_hi(&mut self, offer: &mut Offer) -> bool {
        self.offer_hi_ctx(offer, false)
    }

    fn offer_hi_ctx(&mut self, offer: &mut Offer, interim: bool) -> bool {
        if self.hi_pack.s < self.best_s * (1.0 - 1e-14) {
            let ctx = OfferCtx { interim, stopped: self.budget.stopped };
            if let Some(checked) = offer(&self.hi_pack, ctx) {
                if checked < self.best_s {
                    self.best_s = checked;
                    let mut b = std::mem::take(&mut self.best);
                    self.state_of_packing(&self.hi_pack, &self.hi_state, &mut b);
                    self.best = b;
                    self.stats.improvements += 1;
                    if self.best_s <= self.prob.bound * (1.0 + 1e-12) {
                        self.budget.stopped = true;
                        self.budget.reason = "bound";
                    }
                    return true;
                }
            }
        }
        false
    }

    /// Offers a packing that is valid as built (no relaxation): the state's repair.
    fn offer_state(&mut self, st: &State, offer: &mut Offer) -> bool {
        self.hi_pack = self.rep.repair(self.prob, st, 1.0);
        self.hi_state.clone_from(st);
        self.offer_hi(offer)
    }

    // ---------------------------------------------------------------- starts

    fn new_state(&self) -> State {
        State { x: vec![0.0; 7 * self.p], pairs: Vec::new() }
    }

    /// Random centres in the container at size s (shrunk by half the circumradius) and random orientations.
    pub fn start_random(&mut self, s: f64, st: &mut State) {
        st.x.clear();
        st.pairs.clear();
        for _ in 0..self.p {
            let c = self.prob.cont.random_inside(s, 0.5, &mut self.rng);
            let q = self.rng.quaternion();
            st.x.extend_from_slice(&[c[0], c[1], c[2], q[0], q[1], q[2], q[3]]);
        }
    }

    /// Lattice points (world) of the given cell: `cell` the edge lengths of the conventional cell, `basis` its
    /// points in cell units, `frame` the rotation of the lattice, `shift` in cell units; the points within the
    /// container at a size large enough to hold at least 2P of them (and many more for small P).
    fn lattice(&mut self, cell: [f64; 3], basis: &[[f64; 3]], frame: &[f64; 9], shift: [f64; 3]) -> Vec<[f64; 3]> {
        let cont = &self.prob.cont;
        let per_cell = basis.len() as f64;
        let vcell = cell[0] * cell[1] * cell[2] / per_cell;
        let rho = self.prob.piece.rho;
        let vol1 = cont.volume / (rho * rho * rho);
        let want = (2 * self.p).max(self.p + 12);
        let mut sg = ((want as f64) * vcell / vol1).cbrt();
        loop {
            let reach = sg * cont.outr + 1.0;
            let mut pts = Vec::new();
            let k = [(reach / cell[0]).ceil() as i64 + 1, (reach / cell[1]).ceil() as i64 + 1, (reach / cell[2]).ceil() as i64 + 1];
            for a in -k[0]..=k[0] {
                for b in -k[1]..=k[1] {
                    for c in -k[2]..=k[2] {
                        for bp in basis {
                            let l = [
                                (a as f64 + bp[0] + shift[0]) * cell[0],
                                (b as f64 + bp[1] + shift[1]) * cell[1],
                                (c as f64 + bp[2] + shift[2]) * cell[2],
                            ];
                            let w = r_mul(frame, l);
                            if cont.size_for_ball(w, 0.0) <= sg {
                                pts.push(w);
                            }
                        }
                    }
                }
            }
            if pts.len() >= want || sg > 1e5 {
                return pts;
            }
            sg *= 1.25;
        }
    }

    /// Places the P pieces on the lattice points that need the least size: all with the orientation `q` if given
    /// (need computed exactly), else random orientations (need of the unit ball). Writes the state; returns the
    /// least size that holds them as placed.
    fn place_on(&mut self, pts: &[[f64; 3]], q: Option<[f64; 4]>, st: &mut State) -> f64 {
        let cont = &self.prob.cont;
        let piece = &self.prob.piece;
        let mut keys: Vec<(f64, usize)> = Vec::with_capacity(pts.len());
        match q {
            Some(q) => {
                let r = rot(&q);
                if cont.ball {
                    for (k, p) in pts.iter().enumerate() {
                        keys.push((cont.size_for_piece(piece, *p, &r), k));
                    }
                } else {
                    let h: Vec<f64> = (0..cont.nf).map(|g| piece.support(rt_mul(&r, [cont.nx[g], cont.ny[g], cont.nz[g]]))).collect();
                    for (k, p) in pts.iter().enumerate() {
                        let mut s = f64::NEG_INFINITY;
                        for g in 0..cont.nf {
                            s = s.max((cont.nx[g] * p[0] + cont.ny[g] * p[1] + cont.nz[g] * p[2] + h[g]) / cont.b[g]);
                        }
                        keys.push((s, k));
                    }
                }
            }
            None => {
                for (k, p) in pts.iter().enumerate() {
                    keys.push((cont.size_for_ball(*p, 1.0), k));
                }
            }
        }
        let p = self.p.min(keys.len());
        keys.select_nth_unstable_by(p - 1, |a, b| a.0.partial_cmp(&b.0).unwrap());
        keys[..p].sort_by(|a, b| a.1.cmp(&b.1));
        st.x.clear();
        st.pairs.clear();
        let mut need = 0.0f64;
        for t in 0..p {
            let c = pts[keys[t].1];
            need = need.max(keys[t].0);
            let qq = match q {
                Some(q) => q,
                None => self.rng.quaternion(),
            };
            st.x.extend_from_slice(&[c[0], c[1], c[2], qq[0], qq[1], qq[2], qq[3]]);
        }
        need
    }

    /// FCC points of nearest-neighbour distance `nn`.
    fn fcc(&mut self, nn: f64, frame: &[f64; 9], shift: [f64; 3]) -> Vec<[f64; 3]> {
        let a = nn * std::f64::consts::SQRT_2;
        let basis = [[0.0, 0.0, 0.0], [0.5, 0.5, 0.0], [0.5, 0.0, 0.5], [0.0, 0.5, 0.5]];
        self.lattice([a, a, a], &basis, frame, shift)
    }

    /// The piece's bounding box edges in its own frame.
    fn box_cell(&self) -> [f64; 3] {
        let pc = &self.prob.piece;
        let (a0, a1) = pc.extent([1.0, 0.0, 0.0]);
        let (b0, b1) = pc.extent([0.0, 1.0, 0.0]);
        let (c0, c1) = pc.extent([0.0, 0.0, 1.0]);
        [a1 - a0, b1 - b0, c1 - c0]
    }

    /// The first packing: the better of the close-packed circumscribed balls and the stacked bounding boxes (in the
    /// canonical frame, a few shifts each), both valid as built. Writes the state; returns its size.
    pub fn constructive(&mut self, st: &mut State) -> f64 {
        let id = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let mut best = f64::INFINITY;
        let mut tmp = self.new_state();
        // boxes: spacing a hair above the box, common orientation (the identity)
        let bc = self.box_cell();
        let cell = [bc[0] * (1.0 + 1e-6) + 1e-9, bc[1] * (1.0 + 1e-6) + 1e-9, bc[2] * (1.0 + 1e-6) + 1e-9];
        for sh in 0..8 {
            let shift = [0.5 * (sh & 1) as f64, 0.5 * ((sh >> 1) & 1) as f64, 0.5 * ((sh >> 2) & 1) as f64];
            let pts = self.lattice(cell, &[[0.0; 3]], &id, shift);
            let need = self.place_on(&pts, Some([1.0, 0.0, 0.0, 0.0]), &mut tmp);
            if need < best {
                best = need;
                st.clone_from(&tmp);
            }
        }
        // balls: FCC of contact distance 2 (a hair more), orientations random
        for sh in 0..2 {
            let shift = [0.25 * sh as f64; 3];
            let pts = self.fcc(2.0 * (1.0 + 1e-6), &id, shift);
            let need = self.place_on(&pts, None, &mut tmp);
            // the need of the unit balls bounds the pieces' need
            if need < best {
                best = need;
                st.clone_from(&tmp);
            }
        }
        best
    }

    /// A rotation (row major) taking z to the outward normal of a random face of the container and x along one of
    /// its edges; a random rotation for the ball.
    fn face_frame(&mut self) -> [f64; 9] {
        let cont = &self.prob.cont;
        if cont.ball || cont.nf == 0 {
            return rot(&self.rng.quaternion());
        }
        let f = self.rng.below(cont.nf);
        let face = &cont.faces[f];
        let k = self.rng.below(face.len());
        let a = &cont.verts[3 * face[k]..3 * face[k] + 3];
        let b = &cont.verts[3 * face[(k + 1) % face.len()]..3 * face[(k + 1) % face.len()] + 3];
        let mut t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let tn = dot(t, t).sqrt();
        if tn < 1e-12 {
            return rot(&self.rng.quaternion());
        }
        t = [t[0] / tn, t[1] / tn, t[2] / tn];
        let n = [cont.nx[f], cont.ny[f], cont.nz[f]];
        let u = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
        [t[0], u[0], n[0], t[1], u[1], n[1], t[2], u[2], n[2]]
    }

    /// The unit quaternion of a rotation matrix (row major).
    fn quat_of(r: &[f64; 9]) -> [f64; 4] {
        let tr = r[0] + r[4] + r[8];
        let mut q = if tr > 0.0 {
            let s = (tr + 1.0).sqrt() * 2.0;
            [0.25 * s, (r[7] - r[5]) / s, (r[2] - r[6]) / s, (r[3] - r[1]) / s]
        } else if r[0] > r[4] && r[0] > r[8] {
            let s = (1.0 + r[0] - r[4] - r[8]).sqrt() * 2.0;
            [(r[7] - r[5]) / s, 0.25 * s, (r[1] + r[3]) / s, (r[2] + r[6]) / s]
        } else if r[4] > r[8] {
            let s = (1.0 + r[4] - r[0] - r[8]).sqrt() * 2.0;
            [(r[2] - r[6]) / s, (r[1] + r[3]) / s, 0.25 * s, (r[5] + r[7]) / s]
        } else {
            let s = (1.0 + r[8] - r[0] - r[4]).sqrt() * 2.0;
            [(r[3] - r[1]) / s, (r[2] + r[6]) / s, (r[5] + r[7]) / s, 0.25 * s]
        };
        qnormalize(&mut q);
        q
    }

    /// A lattice start at size s: close-packed balls (random orientations, or one common orientation) or stacked
    /// bounding boxes (one common orientation: the canonical frame, a frame of a container face, or random), the P
    /// points that need the least size, scaled about the origin until their unit balls lie in size s.
    pub fn start_lattice(&mut self, s: f64, st: &mut State) {
        let kind = self.rng.below(4);
        let frame = match self.rng.below(3) {
            0 => [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            1 => self.face_frame(),
            _ => rot(&self.rng.quaternion()),
        };
        let shift = [self.rng.uniform(), self.rng.uniform(), self.rng.uniform()];
        let q = Self::quat_of(&frame);
        let pts = match kind {
            0 | 1 => {
                // balls: the nearest-neighbour distance of a dense packing of the piece's volume (density 0.6)
                let rho = self.prob.piece.rho;
                let vol = self.prob.piece.volume / (rho * rho * rho);
                let nn = (vol / 0.6 * std::f64::consts::SQRT_2).cbrt().min(2.0);
                self.fcc(nn, &frame, shift)
            }
            _ => {
                let bc = self.box_cell();
                let cell = [bc[0], bc[1], bc[2]];
                self.lattice(cell, &[[0.0; 3]], &frame, shift)
            }
        };
        let common = if kind == 0 { None } else { Some(q) };
        self.place_on(&pts, common, st);
        // scale the centres about the origin so that every unit ball is in size s (or as far as it goes)
        let cont = &self.prob.cont;
        let mut f = f64::INFINITY;
        for i in 0..self.p {
            let c = [st.x[7 * i], st.x[7 * i + 1], st.x[7 * i + 2]];
            if cont.ball {
                let n = dot(c, c).sqrt();
                if n > 0.0 {
                    f = f.min((s * cont.beta - 1.0).max(0.0) / n);
                }
            } else {
                for g in 0..cont.nf {
                    let d = cont.nx[g] * c[0] + cont.ny[g] * c[1] + cont.nz[g] * c[2];
                    if d > 0.0 {
                        f = f.min((s * cont.b[g] - 1.0).max(0.0) / d);
                    }
                }
            }
        }
        if f.is_finite() && f < 1.0 {
            for i in 0..self.p {
                for d in 0..3 {
                    st.x[7 * i + d] *= f;
                }
            }
        }
    }

    // ---------------------------------------------------------------- moves

    fn pick_move(&mut self) -> usize {
        let mut w = [0.0; NMOVES];
        let mut tot = 0.0;
        for k in 0..NMOVES {
            w[k] = 0.1 + self.move_wins[k] / self.move_tries[k];
            if (k == 5 || k == 6) && self.p < 2 {
                w[k] = 0.0;
            }
            tot += w[k];
        }
        let mut u = self.rng.uniform() * tot;
        for (k, wk) in w.iter().enumerate() {
            if u < *wk {
                return k;
            }
            u -= wk;
        }
        0
    }

    /// A random piece chosen by its energy share (roulette), or uniformly when nothing has energy; pieces flagged
    /// (per < 0) are skipped.
    fn squeezed(&mut self) -> usize {
        let p = self.p;
        let mut tot = 0.0;
        for i in 0..p {
            if self.per[i] > 0.0 {
                tot += self.per[i];
            }
        }
        if tot > 0.0 {
            let mut u = self.rng.uniform() * tot;
            for i in 0..p {
                if self.per[i] > 0.0 {
                    if u < self.per[i] {
                        return i;
                    }
                    u -= self.per[i];
                }
            }
        }
        self.rng.below(p)
    }

    /// The emptiest of `tries` random places in the container at size s: the farthest from every centre except
    /// the pieces flagged (per < 0).
    fn hole(&mut self, x: &[f64], s: f64, tries: usize) -> [f64; 3] {
        let mut best = -1.0;
        let mut out = [0.0; 3];
        for _ in 0..tries {
            let c = self.prob.cont.random_inside(s, 0.5, &mut self.rng);
            let mut dmin = f64::INFINITY;
            for j in 0..self.p {
                if self.per[j] < 0.0 {
                    continue;
                }
                let dx = c[0] - x[7 * j];
                let dy = c[1] - x[7 * j + 1];
                let dz = c[2] - x[7 * j + 2];
                dmin = dmin.min(dx * dx + dy * dy + dz * dz);
            }
            if dmin > best {
                best = dmin;
                out = c;
            }
        }
        out
    }

    fn turn(&mut self, x: &mut [f64], i: usize, angle: f64) {
        let v = self.rng.unit();
        let dq = qexp([v[0] * angle, v[1] * angle, v[2] * angle]);
        let q = [x[7 * i + 3], x[7 * i + 4], x[7 * i + 5], x[7 * i + 6]];
        let mut nq = qmul(dq, q);
        qnormalize(&mut nq);
        x[7 * i + 3..7 * i + 7].copy_from_slice(&nq);
    }

    /// A perturbation of `cur` into `y` at size s; returns the kind of move.
    fn perturb(&mut self, cur: &mut State, y: &mut State, s: f64) -> usize {
        y.clone_from(cur);
        let p = self.p;
        let kind = self.pick_move();
        match kind {
            0 => {
                // jitter every piece: centres and orientations
                let amp = 0.02 * 25f64.powf(self.rng.uniform());
                for i in 0..p {
                    for d in 0..3 {
                        y.x[7 * i + d] += amp * self.rng.range(-1.0, 1.0);
                    }
                    let a = amp * self.rng.uniform();
                    self.turn(&mut y.x, i, a);
                }
            }
            1 => {
                // jitter a cluster about a random piece
                let c = self.rng.below(p);
                let rad = self.rng.range(2.0, 4.4);
                let amp = self.rng.range(0.3, 1.0);
                for j in 0..p {
                    let dx = cur.x[7 * j] - cur.x[7 * c];
                    let dy = cur.x[7 * j + 1] - cur.x[7 * c + 1];
                    let dz = cur.x[7 * j + 2] - cur.x[7 * c + 2];
                    if dx * dx + dy * dy + dz * dz < rad * rad {
                        for d in 0..3 {
                            y.x[7 * j + d] += amp * self.rng.range(-1.0, 1.0);
                        }
                        let a = amp * self.rng.uniform();
                        self.turn(&mut y.x, j, a);
                        self.mark_dirty(j);
                    }
                }
            }
            2 | 3 => {
                // move 1..3 pieces to holes with random orientations: the most squeezed (2) or random ones (3)
                let k = 1 + self.rng.below(3.min(p));
                self.per_piece(cur, s);
                let mut chosen: Vec<usize> = Vec::with_capacity(k);
                for _ in 0..k {
                    let j = if kind == 2 { self.squeezed() } else { self.rng.below(p) };
                    if self.per[j] >= 0.0 {
                        self.per[j] = -1.0;
                        chosen.push(j);
                    }
                }
                for &j in &chosen {
                    let c = self.hole(&y.x, s, 24);
                    let q = self.rng.quaternion();
                    y.x[7 * j..7 * j + 7].copy_from_slice(&[c[0], c[1], c[2], q[0], q[1], q[2], q[3]]);
                    self.per[j] = 0.0;
                    self.mark_dirty(j);
                }
            }
            4 => {
                // turn one piece (a squeezed one or a random one) by a large angle, or to a random orientation
                self.per_piece(cur, s);
                let j = if self.rng.uniform() < 0.5 { self.squeezed() } else { self.rng.below(p) };
                if self.rng.uniform() < 0.5 {
                    let q = self.rng.quaternion();
                    y.x[7 * j + 3..7 * j + 7].copy_from_slice(&q);
                } else {
                    let a = self.rng.range(0.3, 1.6);
                    self.turn(&mut y.x, j, a);
                }
                for d in 0..3 {
                    y.x[7 * j + d] += 0.1 * self.rng.range(-1.0, 1.0);
                }
                self.mark_dirty(j);
            }
            6 => {
                // align a piece (a squeezed one or a random one): the container's frame, a neighbour's orientation,
                // or a neighbour's turned half a turn about one of its own axes
                self.per_piece(cur, s);
                let j = if self.rng.uniform() < 0.5 { self.squeezed() } else { self.rng.below(p) };
                let pick = self.rng.below(3);
                let q = if pick == 0 && !self.prob.cont.ball {
                    [1.0, 0.0, 0.0, 0.0]
                } else {
                    // the nearest of a few random others
                    let mut nb = (f64::INFINITY, (j + 1) % p);
                    for _ in 0..4 {
                        let k = self.rng.below(p);
                        if k == j {
                            continue;
                        }
                        let dx = cur.x[7 * k] - cur.x[7 * j];
                        let dy = cur.x[7 * k + 1] - cur.x[7 * j + 1];
                        let dz = cur.x[7 * k + 2] - cur.x[7 * j + 2];
                        let d2 = dx * dx + dy * dy + dz * dz;
                        if d2 < nb.0 {
                            nb = (d2, k);
                        }
                    }
                    let k = nb.1;
                    let qk = [cur.x[7 * k + 3], cur.x[7 * k + 4], cur.x[7 * k + 5], cur.x[7 * k + 6]];
                    if pick == 2 {
                        let axis = match self.rng.below(3) {
                            0 => [1.0, 0.0, 0.0],
                            1 => [0.0, 1.0, 0.0],
                            _ => [0.0, 0.0, 1.0],
                        };
                        // q_k turned by pi about its own axis: q_k (0, axis)
                        qmul(qk, [0.0, axis[0], axis[1], axis[2]])
                    } else {
                        qk
                    }
                };
                let mut q = q;
                qnormalize(&mut q);
                y.x[7 * j + 3..7 * j + 7].copy_from_slice(&q);
                for d in 0..3 {
                    y.x[7 * j + d] += 0.05 * self.rng.range(-1.0, 1.0);
                }
                self.mark_dirty(j);
            }
            _ => {
                // swap the orientations of two neighbours
                let i = self.rng.below(p);
                let mut best = (f64::INFINITY, (i + 1) % p);
                for j in 0..p {
                    if j == i {
                        continue;
                    }
                    let dx = cur.x[7 * j] - cur.x[7 * i];
                    let dy = cur.x[7 * j + 1] - cur.x[7 * i + 1];
                    let dz = cur.x[7 * j + 2] - cur.x[7 * i + 2];
                    let d2 = (dx * dx + dy * dy + dz * dz) * self.rng.range(1.0, 2.0);
                    if d2 < best.0 {
                        best = (d2, j);
                    }
                }
                let j = best.1;
                for k in 3..7 {
                    y.x.swap(7 * i + k, 7 * j + k);
                }
                // and a small jitter of both
                for &t in &[i, j] {
                    for d in 0..3 {
                        y.x[7 * t + d] += 0.05 * self.rng.range(-1.0, 1.0);
                    }
                }
                self.mark_dirty(i);
                self.mark_dirty(j);
            }
        }
        kind
    }

    // ---------------------------------------------------------------- run

    /// The whole run. `start`: a checked packing and its score to begin from (the best never gets worse than it;
    /// it is not offered).
    pub fn run(&mut self, start: Option<(&Packing, f64)>, offer: &mut Offer) {
        let p = self.p;
        let mut cur = self.new_state();
        let mut y = self.new_state();
        if let Some((pk, score)) = start {
            let empty = State { x: vec![0.0; 7 * p], pairs: Vec::new() };
            let mut b = self.new_state();
            self.state_of_packing(pk, &empty, &mut b);
            self.best = b;
            self.best_s = score;
        }
        // the first packing: valid as built
        let mut first = self.new_state();
        self.constructive(&mut first);
        self.offer_state(&first, offer);
        if self.stopped() {
            return;
        }
        // for many pieces the lattice packing is a good arrangement to compress first
        if p >= 20 {
            cur.clone_from(&first);
            self.mark_all_dirty();
            self.polish_with(&mut cur, None, Some(&mut *offer));
            if self.offer_hi(offer) {
                self.refine(&mut y, offer);
            }
        }
        // a random start compressed at a density guess, polished
        if !self.stopped() {
            let st0 = self.prob.size_at_density(self.params.density).max(self.prob.bound * 1.05);
            self.start_random(st0, &mut cur);
            self.mark_all_dirty();
            let tol = self.explore;
            let e = self.relax(&mut cur, st0, &tol).e;
            self.polish_with(&mut cur, (e > self.polish_tol.e_stop).then_some((st0, e)), Some(&mut *offer));
            if self.offer_hi(offer) {
                self.refine(&mut y, offer);
            }
        }
        if self.stopped() || !self.best_s.is_finite() {
            return;
        }
        let mut st = 0.0;
        let mut cur_e = 0.0;
        self.from_best(&mut cur, &mut st, &mut cur_e);
        self.set_anchor(&mut cur, st);
        let mut fails = 0u64;
        let mut restart_kind = 0usize;
        loop {
            if self.stopped() {
                break;
            }
            self.stats.hops += 1;
            let kind = self.perturb(&mut cur, &mut y, st);
            self.move_tries[kind] += 1.0;
            self.stats.moves[kind] += 1;
            let tol = self.explore;
            // a move of a few pieces is relaxed locally first: only the pieces near them move
            let local = self.local_region(&cur, &y);
            let mut frozen_e = 0.0;
            if local {
                self.en.local = true;
                frozen_e = (cur_e - self.energy_of(&mut cur, st)).max(0.0);
                self.stats.local_hops += 1;
            }
            self.opt.anchor_r2 = ANCHOR_R * ANCHOR_R;
            let out = self.relax(&mut y, st, &tol);
            self.opt.anchor_r2 = 0.0;
            self.en.local = false;
            let mut e = out.e + frozen_e;
            if self.stopped() {
                break;
            }
            if out.same {
                self.stats.same += 1;
            }
            self.stats.hop_iters += out.iters as u64;
            if !out.same && e < cur_e * (1.0 - self.params.same) {
                if local {
                    // settle the whole arrangement
                    e = self.relax(&mut y, st, &tol).e;
                }
                self.stats.accepted += 1;
                self.stats.wins[kind] += 1;
                self.move_wins[kind] += 1.0;
                fails = 0;
                std::mem::swap(&mut cur, &mut y);
                cur_e = e;
                if (e - self.best_e).abs() > self.params.same * self.best_e && self.try_polish(&mut cur, &mut y, st, e, offer) {
                    self.from_best(&mut cur, &mut st, &mut cur_e);
                }
                self.set_anchor(&mut cur, st);
            } else {
                fails += 1;
            }
            let limit = (self.params.fail_a + self.params.fail_b * p as f64) as u64;
            if fails >= limit {
                self.stats.restarts += 1;
                fails = 0;
                restart_kind = (restart_kind + 1) % 4;
                if self.params.eps_spread > 1.0 {
                    // a new hopping size for the new chain
                    self.from_best(&mut cur, &mut st, &mut cur_e);
                }
                match restart_kind {
                    0 => {
                        cur.clone_from(&self.best);
                        scale_centres(&mut cur, st / self.best_s, p);
                        for i in 0..p {
                            for d in 0..3 {
                                cur.x[7 * i + d] += 0.4 * self.rng.range(-1.0, 1.0);
                            }
                            let a = 0.4 * self.rng.uniform();
                            self.turn(&mut cur.x, i, a);
                        }
                    }
                    1 => self.start_random(st, &mut cur),
                    _ => self.start_lattice(st, &mut cur),
                }
                self.mark_all_dirty();
                let tol = self.explore;
                cur_e = self.relax(&mut cur, st, &tol).e;
                if (cur_e - self.best_e).abs() > self.params.same * self.best_e && self.try_polish(&mut cur, &mut y, st, cur_e, offer) {
                    self.from_best(&mut cur, &mut st, &mut cur_e);
                }
                self.set_anchor(&mut cur, st);
            }
        }
    }

    /// When the last move changed few pieces (the dirty ones) of many, marks the pieces within `local_r` of a
    /// changed piece (before or after the move) active in the energy and returns true.
    fn local_region(&mut self, cur: &State, y: &State) -> bool {
        let p = self.p;
        if (p as f64) < self.params.local_min_p || !self.any_dirty {
            return false;
        }
        let r2 = self.params.local_r * self.params.local_r;
        let mut count = 0usize;
        for i in 0..p {
            let mut near = self.dirty[i];
            if !near {
                for j in 0..p {
                    if !self.dirty[j] {
                        continue;
                    }
                    for c in [&cur.x[7 * j..7 * j + 3], &y.x[7 * j..7 * j + 3]] {
                        let dx = y.x[7 * i] - c[0];
                        let dy = y.x[7 * i + 1] - c[1];
                        let dz = y.x[7 * i + 2] - c[2];
                        if dx * dx + dy * dy + dz * dz < r2 {
                            near = true;
                        }
                    }
                    if near {
                        break;
                    }
                }
            }
            self.en.active[i] = near;
            count += near as usize;
        }
        (count as f64) < 0.6 * p as f64
    }

    fn mark_all_dirty(&mut self) {
        self.dirty.iter_mut().for_each(|d| *d = true);
        self.any_dirty = true;
    }

    /// Polishes a copy (in `y`) of an arrangement relaxed at st with energy e when its repair is near the best, and
    /// offers the result; true when it became the best.
    fn try_polish(&mut self, cur: &mut State, y: &mut State, st: f64, e: f64, offer: &mut Offer) -> bool {
        let r = self.rep.repair(self.prob, cur, 1.0);
        if r.s < self.best_s * (1.0 + self.params.promise) {
            y.clone_from(cur);
            self.polish_with(y, Some((st, e)), Some(&mut *offer));
            if self.offer_hi(offer) {
                self.refine(y, offer);
                return true;
            }
        }
        false
    }

    /// The jammed state a polish reaches depends on the size it approaches from: a new best is compressed by a
    /// hair (refine_eps), relaxed and polished again, as long as that improves it (a few times at most).
    fn refine(&mut self, y: &mut State, offer: &mut Offer) {
        let f = self.params.refine_eps;
        if f <= 0.0 {
            return;
        }
        for _ in 0..4 {
            if self.stopped() {
                return;
            }
            y.clone_from(&self.best);
            let st = self.best_s * (1.0 - f);
            scale_centres(y, 1.0 - f, self.p);
            let tol = self.explore;
            let e = self.relax(y, st, &tol).e;
            self.stats.refines += 1;
            self.polish_with(y, (e > self.polish_tol.e_stop).then_some((st, e)), Some(&mut *offer));
            if !self.offer_hi(offer) {
                return;
            }
            self.stats.refined += 1;
        }
    }

    /// Restarts the chain at the best packing, relaxed at the hopping size best (1 - eps).
    fn from_best(&mut self, cur: &mut State, st: &mut f64, cur_e: &mut f64) {
        cur.clone_from(&self.best);
        let eps = if self.params.eps_spread > 1.0 {
            self.params.eps * self.params.eps_spread.powf(self.rng.range(-1.0, 1.0))
        } else {
            self.params.eps
        };
        *st = self.best_s * (1.0 - eps);
        scale_centres(cur, *st / self.best_s, self.p);
        let tol = self.explore;
        *cur_e = self.relax(cur, *st, &tol).e;
        self.best_e = *cur_e;
    }
}

fn scale_centres(st: &mut State, f: f64, p: usize) {
    for i in 0..p {
        for d in 0..3 {
            st.x[7 * i + d] *= f;
        }
    }
}
