//! Sequential linear programming polish (packages/curved/src/polish.ts): minimise the container
//! variable t subject to every gap >= margin, with a box trust region, an l1 merit function and a
//! second-order correction step. Only what the search reads is computed at the end (poses, t, the
//! worst gap); the reference's multiplier fit serves the research tools, not the search.

use crate::eval::{Evaluator, NONE};
use crate::lbfgs::{Lbfgs, LbfgsOptions};
use crate::lp::LpSolver;
use crate::shapes::side_from_apothem;

fn trace() -> bool {
    static D: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *D.get_or_init(|| std::env::var("CURVED_DEBUG").is_ok_and(|v| v == "2"))
}

fn debug() -> bool {
    static D: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *D.get_or_init(|| std::env::var_os("CURVED_DEBUG").is_some())
}

pub struct PolishResult {
    pub z: Vec<f64>,
    /// container variable (apothem or radius)
    pub t: f64,
    pub size: f64,
    /// worst gap less the margin (>= -1e-12 when converged)
    pub feasibility: f64,
    #[allow(dead_code)]
    pub iterations: usize,
}

pub struct PolishOptions {
    pub margin: f64,
    pub max_iter: usize,
    pub trust: f64,
    pub weight: f64,
    pub min_trust: f64,
    /// Correction of a rejected trial point: 0 the reference's second-order correction LP; 1 a
    /// feasibility recovery at the trial container (L-BFGS on the overlap energy) first, then
    /// that LP when the point is still rejected; 2 the recovery only.
    pub recover: u8,
}

fn recover_default() -> u8 {
    static D: std::sync::OnceLock<u8> = std::sync::OnceLock::new();
    *D.get_or_init(|| {
        std::env::var("CURVED_RECOVER")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    })
}

impl Default for PolishOptions {
    fn default() -> Self {
        PolishOptions {
            margin: 0.0,
            max_iter: 300,
            trust: 0.05,
            weight: 1e3,
            min_trust: 1e-13,
            recover: recover_default(),
        }
    }
}

/// Polish workspace: the evaluator of the problem, the LP solver and step buffers.
pub struct Polisher {
    lp: LpSolver,
    lbfgs: Lbfgs,
    best_z: Vec<f64>,
    step: Vec<f64>,
    soc: Vec<f64>,
    zn: Vec<f64>,
    z2: Vec<f64>,
    rows: Vec<crate::eval::Row>,
}

impl Polisher {
    pub fn new(nz: usize) -> Polisher {
        Polisher {
            lp: LpSolver::new(),
            lbfgs: Lbfgs::new(nz, 10),
            best_z: Vec::with_capacity(nz),
            step: vec![0.0; nz + 1],
            soc: vec![0.0; nz + 1],
            zn: vec![0.0; nz],
            z2: vec![0.0; nz],
            rows: Vec::new(),
        }
    }

    pub fn lp_pivots(&self) -> u64 {
        self.lp.stats.pivots
    }

    /// One linearised step at (z, t) into `out`: minimise dt + 1e-7 |dz|_1 + W sum(slack) subject to
    /// value_k + grad_k . (dz, dt) + slack_k >= margin, |dz_j| <= rho, dt in [lo, hi]. Returns the
    /// predicted decrease of the merit t + W violation.
    #[allow(clippy::too_many_arguments)]
    fn lp_step(
        &mut self,
        ev: &mut Evaluator,
        z: &[f64],
        t: f64,
        margin: f64,
        rho: f64,
        lo: f64,
        hi: f64,
        w: f64,
        below: f64,
        use_soc_buffer: bool,
        stop: &mut dyn FnMut() -> bool,
    ) -> f64 {
        let nz = z.len();
        ev.set_poses(z);
        ev.gather(z, t, below, true, true);
        // rows that hold everywhere in the box (their linearisation stays >= margin) cannot bind:
        // leaving them out does not change the program's solution
        let dt_max = lo.abs().max(hi.abs());
        self.rows.clear();
        for r in &ev.rows {
            let mut reach = r.gt.abs() * dt_max;
            let mut g1 = r.gi[0].abs() + r.gi[1].abs() + r.gi[2].abs();
            if r.j != NONE {
                g1 += r.gj[0].abs() + r.gj[1].abs() + r.gj[2].abs();
            }
            reach += g1 * rho;
            if r.value - margin < reach * (1.0 + 1e-9) + 1e-15 {
                self.rows.push(*r);
            }
        }
        let out = if use_soc_buffer { &mut self.soc } else { &mut self.step };
        self.lp.solve(&self.rows, margin, nz, rho, lo, hi, w, 1e-7, out, stop);
        let mut cur = 0.0;
        let mut pred = 0.0;
        for r in &self.rows {
            let i = r.i as usize;
            let mut lin = r.value + r.gt * out[nz];
            for a in 0..3 {
                lin += r.gi[a] * out[3 * i + a];
            }
            if r.j != NONE {
                let j = r.j as usize;
                for a in 0..3 {
                    lin += r.gj[a] * out[3 * j + a];
                }
            }
            cur += (margin - r.value).max(0.0);
            pred += (margin - lin).max(0.0);
        }
        -out[nz] + w * (cur - pred)
    }

    /// Polishes poses z from container variable t0 (None: the tight container at the poses).
    pub fn polish(
        &mut self,
        ev: &mut Evaluator,
        z0: &[f64],
        t0: Option<f64>,
        opts: &PolishOptions,
        stop: &mut dyn FnMut() -> bool,
    ) -> PolishResult {
        let margin = opts.margin;
        let w = opts.weight;
        let nz = z0.len();
        let t_max = ev.t_max;
        let r_piece = ev.r;
        let mut z = z0.to_vec();
        let mut t = match t0 {
            Some(t) => t,
            None => {
                ev.set_poses(&z);
                ev.required_t() + margin * 1.0000001
            }
        };
        if t > t_max {
            t = t_max - 1e-9;
        }
        let mut rho = opts.trust;
        let mut rho_t = rho;
        let merit_at = |ev: &mut Evaluator, zz: &[f64], tt: f64| {
            ev.set_poses(zz);
            tt + w * ev.violation(zz, tt, margin)
        };
        let mut merit = merit_at(ev, &z, t);
        // the accepted point of smallest t whose gaps are all within 1e-12 of the margin: returned
        // when the polish ends (or is stopped) at a point that is not feasible
        let mut best_t = f64::INFINITY;
        if merit - t <= w * 1e-12 || ev.feasibility(&z, t, margin) > -1e-10 {
            best_t = t;
            self.best_z.clear();
            self.best_z.extend_from_slice(&z);
        }
        let reach_of = |r: f64| margin + 4.0 * r * (1.0 + r_piece) + 1e-7;
        let mut it = 0;
        while it < opts.max_iter {
            if rho < opts.min_trust {
                break;
            }
            if stop() {
                break;
            }
            let dt_hi = rho_t.min((t_max - t) * 0.5);
            let predicted = self.lp_step(ev, &z, t, margin, rho, -rho_t, dt_hi, w, reach_of(rho), false, stop);
            if !(predicted > 1e-16) {
                rho *= 0.25;
                rho_t *= 0.25;
                it += 1;
                continue;
            }
            let mut zn = std::mem::take(&mut self.zn);
            let mut z2 = std::mem::take(&mut self.z2);
            for j in 0..nz {
                zn[j] = z[j] + self.step[j];
            }
            let tn = t + self.step[nz];
            let mut trial = merit_at(ev, &zn, tn);
            let mut actual = merit - trial;
            if actual < 0.1 * predicted && opts.recover > 0 {
                // feasibility recovery: remove the second-order overlaps of the trial point by
                // minimising the overlap energy at the trial container
                z2.copy_from_slice(&zn);
                let lopts = LbfgsOptions {
                    max_iter: 30,
                    gtol: 1e-16,
                    stop_below: 1e-26,
                };
                let mut f = |x: &[f64], g: &mut [f64]| ev.energy(x, tn, margin, g);
                self.lbfgs.minimize(&mut z2, &mut f, &lopts, stop);
                let trial2 = merit_at(ev, &z2, tn);
                let actual2 = merit - trial2;
                if trace() {
                    eprintln!("    recover: actual {actual:.3e} -> {actual2:.3e}");
                }
                if actual2 > actual {
                    std::mem::swap(&mut zn, &mut z2);
                    trial = trial2;
                    actual = actual2;
                }
            }
            if actual < 0.1 * predicted && opts.recover < 2 {
                // second-order correction: re-linearise at the trial point and restore feasibility with t fixed
                self.lp_step(ev, &zn, tn, margin, rho, 0.0, 0.0, w, reach_of(rho), true, stop);
                for j in 0..nz {
                    z2[j] = zn[j] + self.soc[j];
                }
                let trial2 = merit_at(ev, &z2, tn);
                let actual2 = merit - trial2;
                if trace() {
                    let ms = (0..nz).fold(0.0f64, |a, j| a.max(self.soc[j].abs()));
                    eprintln!(
                        "    soc: actual {actual:.3e} -> {actual2:.3e}, soc step {ms:.3e}, trial t-part {:.3e}",
                        trial2 - tn
                    );
                }
                if actual2 > actual {
                    std::mem::swap(&mut zn, &mut z2);
                    trial = trial2;
                    actual = actual2;
                }
            }
            let accepted = actual >= 0.1 * predicted;
            if trace() {
                let ms = (0..nz).fold(0.0f64, |a, j| a.max(self.step[j].abs()));
                eprintln!(
                    "  it {it} rho {rho:.3e} t {t:.15} dt {:.3e} maxstep {ms:.3e} pred {predicted:.3e} actual {actual:.3e} acc {accepted} rows {} piv {}",
                    self.step[nz],
                    self.rows.len(),
                    self.lp.stats.pivots
                );
            }
            if accepted {
                z.copy_from_slice(&zn);
            }
            self.zn = zn;
            self.z2 = z2;
            if accepted {
                t = tn;
                merit = trial;
                if merit - t <= w * 1e-12 && t < best_t {
                    best_t = t;
                    self.best_z.clear();
                    self.best_z.extend_from_slice(&z);
                }
                let mut max_step = 0.0f64;
                for j in 0..nz {
                    max_step = max_step.max(self.step[j].abs());
                }
                if actual >= 0.4 * predicted && max_step > 0.9 * rho {
                    rho = (rho * 2.0).min(0.25);
                    rho_t = (rho_t * 2.0).min(0.25);
                } else if max_step < 0.1 * rho {
                    rho = (max_step * 2.0).max(opts.min_trust * 0.5);
                    rho_t = (self.step[nz].abs() * 2.0).max(rho);
                }
                if predicted < 1e-15 && actual < 1e-15 {
                    it += 1;
                    break;
                }
            } else {
                rho *= 0.25;
                rho_t *= 0.25;
            }
            it += 1;
        }
        ev.set_poses(&z);
        let mut feasibility = ev.feasibility(&z, t, margin);
        if !(feasibility > -1e-10) && best_t.is_finite() {
            // the merit decreases, so this iterate has a larger t than the final one, but it is feasible
            z.copy_from_slice(&self.best_z);
            t = best_t;
            ev.set_poses(&z);
            feasibility = ev.feasibility(&z, t, margin);
        }
        let size = side_from_apothem(ev.m as u32, ev.k, t);
        if debug() {
            eprintln!(
                "polish: {it} iterations, rho {rho:e}, t {t}, feasibility {feasibility:e}, rows {}, lp {:?}",
                self.rows.len(),
                self.lp.stats
            );
        }
        PolishResult {
            z,
            t,
            size,
            feasibility,
            iterations: it,
        }
    }
}
