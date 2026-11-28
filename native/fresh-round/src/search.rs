//! The search: monotonic basin hopping over augmented-Lagrangian local solves, with restarts.
//!
//! - local solve: L-BFGS on F(x; lambda, mu) (see model.rs), multipliers updated between solves,
//!   mu raised when the largest violation does not shrink fast enough;
//! - explore at a loose tolerance, polish only a configuration that beats the best found;
//! - a polished configuration is turned into the submission format (`Model::finish`) and checked
//!   by the server's rule (the `check` callback); only checked packings enter the trace.

use crate::lbfgs::Lbfgs;
use crate::model::{Model, Rows};
use crate::rng::Rng;
use serde_json::Value;
use std::cell::Cell;

pub struct Budget {
    /// CPU seconds (this thread) at which to stop, absolute.
    pub deadline: f64,
    pub max_evals: Option<u64>,
}

pub struct Found {
    pub score: f64,
    pub config: Value,
}

pub struct Report {
    pub best: Option<Found>,
    pub evaluations: u64,
    pub trace: Vec<(f64, f64)>,
}

/// Tunables of the search.
#[derive(Clone, Debug)]
pub struct Params {
    pub mu0: f64,
    pub mu_max: f64,
    pub explore_tol: f64,
    pub explore_gtol: f64,
    pub polish_tol: f64,
    pub max_outer: usize,
    pub max_iter: usize,
    /// failed hops before a restart
    pub patience: usize,
    /// L-BFGS memory
    pub memory: usize,
    /// augmented-Lagrangian rounds of a polish (before Newton)
    pub polish_outer: usize,
    /// frontier search (fixed-size energy hops) instead of plain basin hopping
    pub frontier: bool,
    /// the frontier's target: this much (relative) below the best size variable
    pub delta: f64,
}

pub struct Search<'a, M: Model> {
    pub model: M,
    lbfgs: Lbfgs,
    evals: Cell<u64>,
    budget: Budget,
    pub rng: Rng,
    clock: &'a dyn Fn() -> f64,
    check: &'a mut dyn FnMut(&Value) -> Option<f64>,
    t0: f64,
    pub params: Params,
    best: Option<Found>,
    /// the best packing's variables (sigma tight)
    best_x: Option<Vec<f64>>,
    trace: Vec<(f64, f64)>,
    out: Cell<bool>,
    ticks: Cell<u32>,
}

impl<'a, M: Model> Search<'a, M> {
    pub fn new(
        model: M,
        seed: u64,
        budget: Budget,
        params: Params,
        clock: &'a dyn Fn() -> f64,
        check: &'a mut dyn FnMut(&Value) -> Option<f64>,
    ) -> Self {
        let n = model.dim();
        let t0 = clock();
        Search {
            model,
            lbfgs: Lbfgs::new(n, params.memory),
            evals: Cell::new(0),
            budget,
            rng: Rng::new(seed),
            clock,
            check,
            t0,
            params,
            best: None,
            best_x: None,
            trace: Vec::new(),
            out: Cell::new(false),
            ticks: Cell::new(0),
        }
    }

    /// True once the budget is spent, reading the clock now (for expensive steps).
    fn spent_now(&self) -> bool {
        if !self.out.get() && (self.clock)() >= self.budget.deadline {
            self.out.set(true);
        }
        self.spent()
    }

    /// True once the budget is spent (the clock is read every 32 calls).
    fn spent(&self) -> bool {
        if self.out.get() {
            return true;
        }
        if let Some(max) = self.budget.max_evals {
            if self.evals.get() >= max {
                self.out.set(true);
                return true;
            }
        }
        let t = self.ticks.get().wrapping_add(1);
        self.ticks.set(t);
        if t.is_multiple_of(32) && (self.clock)() >= self.budget.deadline {
            self.out.set(true);
            return true;
        }
        false
    }

    /// Augmented-Lagrangian solve from x with multipliers lam and penalty mu (both updated).
    /// Returns the largest violation left.
    pub fn alm(&mut self, x: &mut [f64], lam: &mut [f64], mu: &mut f64, tol: f64, gtol: f64, max_outer: usize) -> f64 {
        let mut prev = f64::INFINITY;
        let mut viol = f64::INFINITY;
        self.model.invalidate();
        for _ in 0..max_outer {
            {
                let model = &mut self.model;
                let evals = &self.evals;
                let lam_ro: &[f64] = lam;
                let m = *mu;
                let out = &self.out;
                let ticks = &self.ticks;
                let clock = self.clock;
                let deadline = self.budget.deadline;
                let max_evals = self.budget.max_evals;
                let o = self.lbfgs.minimize(
                    x,
                    |x, g| {
                        evals.set(evals.get() + 1);
                        model.eval(x, lam_ro, m, g)
                    },
                    gtol,
                    self.params.max_iter,
                    |_| {
                        if out.get() {
                            return true;
                        }
                        if max_evals.is_some_and(|mx| evals.get() >= mx) {
                            out.set(true);
                            return true;
                        }
                        let t = ticks.get().wrapping_add(1);
                        ticks.set(t);
                        if t.is_multiple_of(32) && clock() >= deadline {
                            out.set(true);
                            return true;
                        }
                        false
                    },
                );
                if debug() {
                    eprintln!("    lbfgs f {} iters {} evals {} stop {:?} sigma {}", o.f, o.iterations, o.evaluations, o.stop, x[x.len() - 1]);
                }
            }
            self.model.normalize(x);
            viol = self.model.update_multipliers(x, lam, *mu);
            if debug() {
                eprintln!("    outer viol {:e} mu {}", viol, *mu);
            }
            if viol <= tol || self.spent() {
                break;
            }
            if viol > 0.25 * prev {
                *mu = (*mu * 4.0).min(self.params.mu_max);
            }
            prev = viol;
        }
        viol
    }

    /// Newton polish of a near-optimal x: Gauss-Newton (minimum-norm steps) on the system
    /// o_c(x) = 0 of the active constraints (a multiplier, or a value within 1e-12 of zero), so
    /// that the contacts close exactly; constraints that end up violated join the system. Returns
    /// the largest violation left over all constraints.
    pub fn newton(&mut self, x: &mut [f64], lam: &[f64], eps: f64) -> f64 {
        let mut rows = Rows::default();
        let mut extra: Vec<usize> = Vec::new();
        let mut m_mat: Vec<f64> = Vec::new();
        let mut y: Vec<f64> = Vec::new();
        let mut worst = f64::INFINITY;
        for _round in 0..4 {
            for it in 0..12 {
                if self.spent_now() {
                    self.model.invalidate();
                    return f64::INFINITY;
                }
                let keep = |c: usize, o: f64| lam[c] > 0.0 || o > -eps || extra.contains(&c);
                self.model.rows(x, &keep, &mut rows);
                self.evals.set(self.evals.get() + 1);
                let m = rows.len();
                if m == 0 {
                    break;
                }
                let resid = rows.val.iter().fold(0.0f64, |a, &v| a.max(v.abs()));
                if resid < 1e-15 {
                    break;
                }
                if it == 11 {
                    // no convergence: an inconsistent system (too many contacts asked for)
                    self.model.invalidate();
                    return f64::INFINITY;
                }
                // M = J J^T (+ a tiny ridge), from the sparse rows
                m_mat.clear();
                m_mat.resize(m * m, 0.0);
                for a in 0..m {
                    let (ca, va, na) = (&rows.cols[a], &rows.coef[a], rows.nnz[a] as usize);
                    for b in 0..=a {
                        let (cb, vb, nb) = (&rows.cols[b], &rows.coef[b], rows.nnz[b] as usize);
                        let mut s = 0.0;
                        for p in 0..na {
                            for q in 0..nb {
                                if ca[p] == cb[q] {
                                    s += va[p] * vb[q];
                                }
                            }
                        }
                        m_mat[a * m + b] = s;
                        m_mat[b * m + a] = s;
                    }
                }
                let diag_max = (0..m).fold(0.0f64, |a, i| a.max(m_mat[i * m + i]));
                let ridge = 1e-13 * diag_max.max(1e-300);
                for i in 0..m {
                    m_mat[i * m + i] += ridge;
                }
                y.clear();
                y.extend_from_slice(&rows.val);
                if !cholesky_solve(&mut m_mat, m, &mut y) {
                    break;
                }
                // x -= J^T y
                for a in 0..m {
                    for p in 0..rows.nnz[a] as usize {
                        x[rows.cols[a][p] as usize] -= rows.coef[a][p] * y[a];
                    }
                }
                self.model.normalize(x);
            }
            let keep_none = |_: usize, _: f64| false;
            worst = self.model.rows(x, &keep_none, &mut rows);
            if worst <= 1e-15 {
                break;
            }
            // the violated constraints join the system
            let keep_bad = |_: usize, o: f64| o > 1e-15;
            self.model.rows(x, &keep_bad, &mut rows);
            for &c in &rows.id {
                if !extra.contains(&c) {
                    extra.push(c);
                }
            }
        }
        self.model.invalidate();
        worst
    }

    /// Polishes x (continuing its multipliers), and records it if it beats the best checked packing.
    /// Returns the exact score when the configuration passed the check.
    fn polish_and_record(&mut self, x: &mut [f64], lam: &mut [f64], mu: &mut f64) -> Option<f64> {
        let tol = self.params.polish_tol;
        let gtol = tol * 1e-2;
        self.alm(x, lam, mu, tol, gtol, self.params.polish_outer);
        // close the contacts exactly: Gauss-Newton on the near-active constraints, for growing
        // nearness thresholds (the vertex of the local optimum needs all its contacts); keep the
        // best result that leaves no constraint violated, or the ALM point if none does
        let saved = x.to_vec();
        let n = x.len();
        let mut best: Option<Vec<f64>> = None;
        let mut fails = 0;
        for eps in [1e-12, 1e-9, 1e-7, 1e-5, 1e-4] {
            x.copy_from_slice(&saved);
            let worst = self.newton(x, lam, eps);
            if worst <= 1e-14 && x[n - 1] <= saved[n - 1] + 1e-7 {
                if best.as_ref().is_none_or(|b| x[n - 1] < b[n - 1]) {
                    best = Some(x.to_vec());
                }
                fails = 0;
            } else {
                fails += 1;
                if fails >= 2 {
                    break;
                }
            }
        }
        match best {
            Some(b) => x.copy_from_slice(&b),
            None => x.copy_from_slice(&saved),
        }
        let mut out = self.model.finish(x, 1e-12);
        if out.is_none() {
            // a pair still overlaps: a few more rounds
            self.alm(x, lam, mu, tol * 0.1, gtol * 0.1, 30);
            out = self.model.finish(x, 1e-11);
        }
        if debug() {
            eprintln!("  polish sigma {} finish {:?}", x[x.len() - 1], out.as_ref().map(|o| o.0));
        }
        let (score, config) = out?;
        if let Some(b) = &self.best {
            if !(score < b.score) {
                return Some(score);
            }
        }
        let checked = (self.check)(&config);
        if debug() {
            eprintln!("  check {:?}", checked);
        }
        let checked = checked?;
        let t = (self.clock)() - self.t0;
        let better = self.best.as_ref().is_none_or(|b| checked < b.score);
        if better {
            self.trace.push((t, checked));
            self.best = Some(Found { score: checked, config });
            let mut bx = x.to_vec();
            self.model.fit_sigma(&mut bx);
            self.best_x = Some(bx);
        }
        Some(checked)
    }

    /// Minimises the overlap energy E = sum max(0, o)^2 at the fixed size sigma_t; returns E.
    pub fn energy(&mut self, x: &mut [f64], sigma_t: f64, zeros: &[f64], max_iter: usize) -> f64 {
        let n = x.len();
        x[n - 1] = sigma_t;
        self.model.invalidate();
        let model = &mut self.model;
        let evals = &self.evals;
        let out = &self.out;
        let ticks = &self.ticks;
        let clock = self.clock;
        let deadline = self.budget.deadline;
        let max_evals = self.budget.max_evals;
        let o = self.lbfgs.minimize(
            x,
            |x, g| {
                evals.set(evals.get() + 1);
                let f = model.eval(x, zeros, 2.0, g) - x[n - 1];
                g[n - 1] = 0.0;
                f
            },
            1e-16,
            max_iter,
            |_| {
                if out.get() {
                    return true;
                }
                if max_evals.is_some_and(|mx| evals.get() >= mx) {
                    out.set(true);
                    return true;
                }
                let t = ticks.get().wrapping_add(1);
                ticks.set(t);
                if t.is_multiple_of(32) && clock() >= deadline {
                    out.set(true);
                    return true;
                }
                false
            },
        );
        self.model.normalize(x);
        o.f
    }

    /// The size the frontier search aims at: a hair below the best packing's.
    fn target(&self) -> f64 {
        let bx = self.best_x.as_ref().expect("a best packing");
        let s = bx[bx.len() - 1];
        s - self.params.delta * s.abs().max(1e-3)
    }

    /// Frontier search: after a start (augmented-Lagrangian solve and polish), hop at a fixed size a
    /// hair below the best packing found, accepting moves that lower the overlap energy there; a
    /// move that reaches zero energy beats the best: it is optimised (ALM, Newton) and recorded.
    pub fn run_frontier(mut self) -> Report {
        let n = self.model.dim();
        let nc = self.model.ncons();
        let zeros = vec![0.0; nc];
        let mut x = vec![0.0; n];
        let mut lam = vec![0.0; nc];
        let mut xt = vec![0.0; n];
        let mut lt = vec![0.0; nc];
        let mut restart = 0usize;
        let p = self.model.npts();
        let (mut hops, mut wins, mut downs) = (0usize, 0usize, 0usize);
        let feas = 1e-26;
        while !self.spent() {
            self.model.start(&mut self.rng, &mut x, restart);
            restart += 1;
            lam.iter_mut().for_each(|l| *l = 0.0);
            let mut mu = self.params.mu0;
            self.alm(&mut x, &mut lam, &mut mu, self.params.explore_tol, self.params.explore_gtol, self.params.max_outer);
            if self.spent() {
                break;
            }
            if self.model.score_of_sigma(x[n - 1]) < self.best_score() * (1.0 + 1e-7) {
                xt.copy_from_slice(&x);
                lt.copy_from_slice(&lam);
                let mut m = mu;
                self.polish_and_record(&mut xt, &mut lt, &mut m);
            }
            if self.best_x.is_none() {
                continue;
            }
            let mut sigma_t = self.target();
            let mut e_cur = self.energy(&mut x, sigma_t, &zeros, self.params.max_iter * 4);
            let mut fails = 0usize;
            while fails < self.params.patience && !self.spent() {
                xt.copy_from_slice(&x);
                let kind = self.rng.below(3);
                let eta = 0.05 + 0.3 * self.rng.uniform();
                let count = 1 + self.rng.below(3.min(p));
                self.model.perturb(&mut self.rng, &mut xt, kind, eta, count);
                let e = self.energy(&mut xt, sigma_t, &zeros, self.params.max_iter * 4);
                hops += 1;
                if self.spent() {
                    break;
                }
                if e <= feas {
                    // beats the best: optimise this basin fully and record it
                    wins += 1;
                    self.model.fit_sigma(&mut xt);
                    lt.iter_mut().for_each(|l| *l = 0.0);
                    let mut mu = self.params.mu0;
                    self.alm(&mut xt, &mut lt, &mut mu, self.params.explore_tol, self.params.explore_gtol, self.params.max_outer);
                    self.polish_and_record(&mut xt, &mut lt, &mut mu);
                    if let Some(bx) = &self.best_x {
                        x.copy_from_slice(bx);
                    }
                    sigma_t = self.target();
                    e_cur = self.energy(&mut x, sigma_t, &zeros, self.params.max_iter * 4);
                    fails = 0;
                } else if e < e_cur {
                    downs += 1;
                    x.copy_from_slice(&xt);
                    e_cur = e;
                    fails = 0;
                } else {
                    fails += 1;
                }
            }
        }
        if debug() || std::env::var_os("FRESH_STATS").is_some() {
            eprintln!("stats: frontier restarts {restart} hops {hops} wins {wins} downs {downs} evals {} evals/hop {:.0}", self.evals.get(), self.evals.get() as f64 / hops.max(1) as f64);
        }
        Report { best: self.best, evaluations: self.evals.get(), trace: self.trace }
    }

    pub fn best_score(&self) -> f64 {
        self.best.as_ref().map_or(f64::INFINITY, |b| b.score)
    }

    pub fn run(mut self) -> Report {
        if self.params.frontier {
            return self.run_frontier();
        }
        let n = self.model.dim();
        let nc = self.model.ncons();
        let mut x = vec![0.0; n];
        let mut lam = vec![0.0; nc];
        let mut xt = vec![0.0; n];
        let mut lt = vec![0.0; nc];
        let mut xp = vec![0.0; n];
        let mut lp = vec![0.0; nc];
        let mut restart = 0usize;
        let p = self.model.npts();
        let (mut hops, mut accepted) = (0usize, 0usize);
        let (mut tried, mut acc) = ([0usize; 3], [0usize; 3]);
        while !self.spent() {
            // a new start
            self.model.start(&mut self.rng, &mut x, restart);
            restart += 1;
            lam.iter_mut().for_each(|l| *l = 0.0);
            let mut mu = self.params.mu0;
            let viol = self.alm(&mut x, &mut lam, &mut mu, self.params.explore_tol, self.params.explore_gtol, self.params.max_outer);
            if self.spent() {
                break;
            }
            let mut cur = x[n - 1];
            if debug() {
                eprintln!("start {} sigma {} score {} viol {:e} evals {}", restart, cur, self.model.score_of_sigma(cur), viol, self.evals.get());
            }
            let mut cur_ok = viol <= self.params.explore_tol * 10.0;
            let mut cur_mu;
            // polish when it may beat the best
            if cur_ok && self.model.score_of_sigma(cur) < self.best_score() * (1.0 + 1e-7) {
                xp.copy_from_slice(&x);
                lp.copy_from_slice(&lam);
                let mut m = mu;
                self.polish_and_record(&mut xp, &mut lp, &mut m);
            }
            let mut fails = 0usize;
            while fails < self.params.patience && !self.spent() {
                xt.copy_from_slice(&x);
                let kind = self.rng.below(3);
                tried[kind] += 1;
                let eta = 0.05 + 0.3 * self.rng.uniform();
                let count = 1 + self.rng.below(3.min(p));
                self.model.perturb(&mut self.rng, &mut xt, kind, eta, count);
                lt.iter_mut().for_each(|l| *l = 0.0);
                let mut mu = self.params.mu0;
                let viol = self.alm(&mut xt, &mut lt, &mut mu, self.params.explore_tol, self.params.explore_gtol, self.params.max_outer);
                if self.spent() {
                    break;
                }
                let s = xt[n - 1];
                hops += 1;
                let ok = viol <= self.params.explore_tol * 10.0;
                if ok && (!cur_ok || s < cur - 1e-9 * self.model.sigma_scale()) {
                    x.copy_from_slice(&xt);
                    lam.copy_from_slice(&lt);
                    cur = s;
                    cur_ok = true;
                    cur_mu = mu;
                    fails = 0;
                    accepted += 1;
                    acc[kind] += 1;
                    if self.model.score_of_sigma(cur) < self.best_score() * (1.0 - 1e-10) {
                        xp.copy_from_slice(&x);
                        lp.copy_from_slice(&lam);
                        let mut m = cur_mu;
                        self.polish_and_record(&mut xp, &mut lp, &mut m);
                    }
                } else {
                    fails += 1;
                }
            }
        }
        if debug() || std::env::var_os("FRESH_STATS").is_some() {
            eprintln!("stats: restarts {restart} hops {hops} accepted {accepted} evals {} evals/hop {:.0} kinds {:?}/{:?}", self.evals.get(), self.evals.get() as f64 / hops.max(1) as f64, acc, tried);
        }
        Report { best: self.best, evaluations: self.evals.get(), trace: self.trace }
    }
}

fn debug() -> bool {
    std::env::var_os("FRESH_DEBUG").is_some()
}

/// Solves A y = b in place for a symmetric positive definite A (row-major n x n, overwritten by
/// its Cholesky factor). False when A is not numerically positive definite.
fn cholesky_solve(a: &mut [f64], n: usize, b: &mut [f64]) -> bool {
    for j in 0..n {
        let mut d = a[j * n + j];
        for k in 0..j {
            d -= a[j * n + k] * a[j * n + k];
        }
        if !(d > 0.0) {
            return false;
        }
        let d = d.sqrt();
        a[j * n + j] = d;
        for i in j + 1..n {
            let mut s = a[i * n + j];
            for k in 0..j {
                s -= a[i * n + k] * a[j * n + k];
            }
            a[i * n + j] = s / d;
        }
    }
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i {
            s -= a[i * n + k] * b[k];
        }
        b[i] = s / a[i * n + i];
    }
    for i in (0..n).rev() {
        let mut s = b[i];
        for k in i + 1..n {
            s -= a[k * n + i] * b[k];
        }
        b[i] = s / a[i * n + i];
    }
    true
}
