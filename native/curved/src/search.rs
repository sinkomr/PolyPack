//! Seeded global search (packages/curved/src/search.ts): random starts, penalty compression
//! (L-BFGS on the squared-overlap energy at a fixed container), SLP polish, and basin hopping by
//! re-placing, jiggling and turning pieces. Deterministic for a seed and a budget of restarts and
//! hops; the stop callback only ends it early.

use crate::bound::t_for_area;
use crate::eval::Evaluator;
use crate::kfun::sn_k;
use crate::lbfgs::{Lbfgs, LbfgsOptions};
use crate::polish::{PolishOptions, PolishResult, Polisher};
use crate::problem::Space;
use crate::rng::Rng;
use crate::shapes::{apothem_from_side, container_circumradius, side_from_apothem};
use std::f64::consts::PI;

/// Energy below which an arrangement counts as feasible.
const FEAS: f64 = 1e-22;

/// The working state of a search on one problem, reused across rounds.
pub struct Searcher {
    pub ev: Evaluator,
    lbfgs: Lbfgs,
    pub polisher: Polisher,
    pub p: usize,
    /// cumulative work counters, and CPU seconds of the energy minimisations and the polishes
    pub repairs: u64,
    pub polishes: u64,
    pub repair_seconds: f64,
    pub polish_seconds: f64,
    /// the last warm start (poses and size) and the local optimum its restart reached
    restart_cache: Option<(Vec<f64>, f64, Option<PolishResult>)>,
}

pub struct SearchOptions<'a> {
    pub seed: u32,
    pub restarts: usize,
    pub hops: usize,
    /// warm start (possibly infeasible, e.g. a previous optimum moved)
    pub start: Option<(&'a [f64], f64)>,
    /// L-BFGS iterations per energy minimisation
    pub lbfgs_iter: usize,
}

pub struct SearchResult {
    /// the best polished arrangement: poses, container variable t and size
    pub best: Option<PolishResult>,
    pub restarts_done: usize,
    pub hops_done: usize,
}

impl Searcher {
    pub fn new(space: &Space, p: usize) -> Searcher {
        Searcher {
            ev: Evaluator::new(space, p),
            lbfgs: Lbfgs::new(3 * p, 10),
            polisher: Polisher::new(3 * p),
            p,
            repairs: 0,
            polishes: 0,
            repair_seconds: 0.0,
            polish_seconds: 0.0,
            restart_cache: None,
        }
    }

    /// Penalty minimisation at container variable t from z (in place); true when the result is
    /// feasible (energy <= FEAS).
    fn repair(&mut self, z: &mut [f64], t: f64, iters: usize, stop: &mut dyn FnMut() -> bool) -> bool {
        self.repairs += 1;
        let ev = &mut self.ev;
        let mut f = |x: &[f64], g: &mut [f64]| ev.energy(x, t, 0.0, g);
        let opts = LbfgsOptions {
            max_iter: iters,
            gtol: 1e-12,
            stop_below: FEAS,
        };
        let c0 = crate::job::thread_cpu_seconds();
        let (e, _) = self.lbfgs.minimize(z, &mut f, &opts, stop);
        self.repair_seconds += crate::job::thread_cpu_seconds() - c0;
        e <= FEAS
    }

    /// Minimises the overlap energy with a clearance `margin` at container variable t (not
    /// stopped); true when every gap is then within 1e-13 of the margin.
    pub fn repair_with_margin(&mut self, z: &mut [f64], t: f64, margin: f64, iters: usize) -> bool {
        let ev = &mut self.ev;
        let mut f = |x: &[f64], g: &mut [f64]| ev.energy(x, t, margin, g);
        let opts = LbfgsOptions {
            max_iter: iters,
            gtol: 1e-16,
            stop_below: 1e-26,
        };
        let (e, _) = self.lbfgs.minimize(z, &mut f, &opts, &mut || false);
        e <= 1e-26
    }

    fn tight_t(&mut self, z: &[f64]) -> f64 {
        self.ev.set_poses(z);
        self.ev.required_t()
    }

    /// Random centre inside a disk of radius r_max about O, uniform in area at curvature K
    /// (the area within distance s is 2 pi vs_K(s); inverted by bisection).
    fn random_centre(k: f64, r_max: f64, rng: &mut Rng) -> (f64, f64) {
        let vs_of = |x: f64| {
            let s = sn_k(k, x / 2.0);
            2.0 * s * s
        };
        let u = rng.next_f64();
        let target = u * vs_of(r_max);
        let mut lo = 0.0;
        let mut hi = r_max;
        for _ in 0..60 {
            let mid = (lo + hi) / 2.0;
            if vs_of(mid) < target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let a = 2.0 * PI * rng.next_f64();
        (hi * libm::cos(a), hi * libm::sin(a))
    }

    /// Radius within which random centres are drawn for container variable t.
    fn placement_radius(&self, t: f64) -> f64 {
        let (k, m) = (self.ev.k, self.ev.m as u32);
        if m == 0 {
            return (t - self.ev.rho * 0.5).max(0.0);
        }
        // polygon container: centres within the inscribed region plus a little
        let side = side_from_apothem(m, k, t);
        let r = if side.is_finite() {
            container_circumradius(m, k, side)
        } else {
            t + 3.0
        };
        r.min(t + 0.5 * self.ev.r)
    }

    fn random_poses(&self, z: &mut [f64], t: f64, rng: &mut Rng) {
        let r_max = self.placement_radius(t);
        for i in 0..self.p {
            let (x, y) = Self::random_centre(self.ev.k, r_max, rng);
            z[3 * i] = x;
            z[3 * i + 1] = y;
            z[3 * i + 2] = 2.0 * PI * rng.next_f64();
        }
    }

    pub fn search(&mut self, opts: &SearchOptions, stop: &mut dyn FnMut() -> bool) -> SearchResult {
        let p = self.p;
        let (k, m) = (self.ev.k, self.ev.m as u32);
        let t_max = self.ev.t_max;
        let area = self.ev.area;
        let iters = opts.lbfgs_iter;
        let mut rng = Rng::new(opts.seed);
        let t_area = t_for_area(k, m, t_max, p as f64 * area);
        let mut best: Option<PolishResult> = None;
        let mut restarts_done = 0;
        let mut hops_done = 0;
        let t_cap = if t_max.is_finite() {
            t_max * (1.0 - 1e-9)
        } else {
            f64::INFINITY
        };
        if !(t_area < t_max) {
            return SearchResult {
                best,
                restarts_done,
                hops_done,
            };
        }
        let mut z = vec![0.0; 3 * p];
        let mut zz = vec![0.0; 3 * p];
        for rs in 0..opts.restarts {
            if stop() {
                break;
            }
            restarts_done += 1;
            // starting container: roomy (area density about 0.45) but inside the admissible range
            let mut t0 = t_for_area(k, m, t_max, (p as f64 * area) / 0.45);
            if !(t0 < t_cap) {
                t0 = if t_cap.is_finite() {
                    t_area + 0.9 * (t_cap - t_area)
                } else {
                    t0
                };
            }
            // the warm start's restart has no randomness: the same start gives the same local
            // optimum, so a round that starts where the last one did reuses it
            let warm = if rs == 0 { opts.start } else { None };
            if let (Some((zs, size)), Some((cz, cs, cres))) = (warm, &self.restart_cache) {
                if *cs == size && cz.as_slice() == zs {
                    let Some(pol) = cres.clone() else { continue };
                    let local = (pol.z.clone(), pol.t);
                    best = Some(pol);
                    let (cur_z, cur_t) = local;
                    self.hops(
                        opts,
                        &mut rng,
                        &mut best,
                        cur_z,
                        cur_t,
                        t_area,
                        t_cap,
                        &mut hops_done,
                        &mut z,
                        &mut zz,
                        stop,
                    );
                    continue;
                }
            }
            let feasible;
            if let (0, Some((zs, size))) = (rs, opts.start) {
                // warm start: repair, growing t if needed
                let mut tt = self.tight_t(zs).max(apothem_from_side(m, k, size)).min(t_cap);
                z.copy_from_slice(zs);
                let mut ok = self.repair(&mut z, tt, iters, stop);
                let mut g = 0;
                while !ok && g < 8 {
                    tt = if t_cap.is_finite() {
                        tt + 0.3 * (t_cap - tt)
                    } else {
                        tt * 1.15
                    };
                    z.copy_from_slice(zs);
                    ok = self.repair(&mut z, tt, iters, stop);
                    g += 1;
                }
                feasible = ok;
            } else {
                self.random_poses(&mut z, t0, &mut rng);
                let mut ok = self.repair(&mut z, t0, iters, stop);
                // grow toward the admissible limit if the roomy container was not enough
                let mut tt = t0;
                let mut g = 0;
                while !ok && g < 6 {
                    tt = if t_cap.is_finite() {
                        tt + 0.5 * (t_cap - tt)
                    } else {
                        tt * 1.3
                    };
                    self.random_poses(&mut z, tt, &mut rng);
                    ok = self.repair(&mut z, tt, iters, stop);
                    g += 1;
                }
                feasible = ok;
            }
            if !feasible {
                continue;
            }
            // penalty compression: shrink t while repairs succeed
            let mut tf = self.tight_t(&z).min(t_cap);
            let mut delta = 0.05 * (tf - t_area).max(1e-3);
            let mut step = 0;
            while step < 40 && delta > 1e-5 * tf.max(1.0) {
                step += 1;
                if stop() {
                    break;
                }
                let tt = tf - delta;
                if tt <= t_area {
                    delta /= 2.0;
                    continue;
                }
                zz.copy_from_slice(&z);
                if self.repair(&mut zz, tt, iters, stop) {
                    std::mem::swap(&mut z, &mut zz);
                    tf = self.tight_t(&z).min(tt);
                    delta *= 1.2;
                } else {
                    delta /= 2.0;
                }
            }
            let local = self.consider(&z, tf, &mut best, stop);
            if let (Some((zs, size)), false) = (warm, stop()) {
                self.restart_cache = Some((zs.to_vec(), size, local.as_ref().and(best.clone())));
            }
            let Some((cur_z, cur_t)) = local else { continue };
            self.hops(
                opts,
                &mut rng,
                &mut best,
                cur_z,
                cur_t,
                t_area,
                t_cap,
                &mut hops_done,
                &mut z,
                &mut zz,
                stop,
            );
        }
        SearchResult {
            best,
            restarts_done,
            hops_done,
        }
    }

    /// Basin hopping from the local optimum (cur_z, cur_t): re-place, jiggle or turn pieces,
    /// repair, polish, and move to the result when it is smaller.
    fn hops(
        &mut self,
        opts: &SearchOptions,
        rng: &mut Rng,
        best: &mut Option<PolishResult>,
        mut cur_z: Vec<f64>,
        mut cur_t: f64,
        t_area: f64,
        t_cap: f64,
        hops_done: &mut usize,
        z: &mut [f64],
        zz: &mut [f64],
        stop: &mut dyn FnMut() -> bool,
    ) {
        let p = self.p;
        let k = self.ev.k;
        let iters = opts.lbfgs_iter;
        for _ in 0..opts.hops {
            if stop() {
                break;
            }
            *hops_done += 1;
            zz.copy_from_slice(&cur_z);
            let kind = rng.next_f64();
            let n_move = 1 + (rng.next_f64() * (3.min(p) as f64)).floor() as usize;
            if kind < 0.5 {
                // re-place random pieces anywhere
                let r_max = self.placement_radius(cur_t);
                for _ in 0..n_move {
                    let i = (rng.next_f64() * p as f64).floor() as usize;
                    let (x, y) = Self::random_centre(k, r_max, rng);
                    zz[3 * i] = x;
                    zz[3 * i + 1] = y;
                    zz[3 * i + 2] = 2.0 * PI * rng.next_f64();
                }
            } else if kind < 0.8 {
                // jiggle everything
                let s = 0.05 + 0.15 * rng.next_f64();
                for (j, v) in zz.iter_mut().enumerate() {
                    *v += s * rng.gaussian() * if j % 3 == 2 { 1.0 } else { 0.5 };
                }
            } else {
                // turn a few pieces
                for _ in 0..n_move {
                    let i = (rng.next_f64() * p as f64).floor() as usize;
                    zz[3 * i + 2] += (rng.next_f64() - 0.5) * PI;
                }
            }
            // repair at a slightly smaller container to push for improvement, then at the same size
            let target = cur_t - 1e-3 * (cur_t - t_area).max(1e-3);
            z.copy_from_slice(zz);
            let mut ok = self.repair(z, target, iters, stop);
            if !ok {
                z.copy_from_slice(zz);
                ok = self.repair(z, cur_t, iters, stop);
            }
            if !ok {
                continue;
            }
            let tt = self.tight_t(z).min(t_cap);
            if let Some((pz, pt)) = self.consider(z, tt, best, stop) {
                if pt < cur_t - 1e-12 {
                    cur_z = pz;
                    cur_t = pt;
                }
            }
        }
    }

    /// Polishes (z, t); keeps it as the best when it is feasible and smaller. Returns the polished
    /// poses and t when feasible.
    fn consider(
        &mut self,
        z: &[f64],
        t: f64,
        best: &mut Option<PolishResult>,
        stop: &mut dyn FnMut() -> bool,
    ) -> Option<(Vec<f64>, f64)> {
        self.polishes += 1;
        let c0 = crate::job::thread_cpu_seconds();
        let pol = self
            .polisher
            .polish(&mut self.ev, z, Some(t), &PolishOptions::default(), stop);
        self.polish_seconds += crate::job::thread_cpu_seconds() - c0;
        if !(pol.feasibility > -1e-10) || !(pol.t < self.ev.t_max) {
            return None;
        }
        let out = (pol.z.clone(), pol.t);
        if best.as_ref().is_none_or(|b| pol.t < b.t - 1e-13) {
            *best = Some(pol);
        }
        Some(out)
    }
}
