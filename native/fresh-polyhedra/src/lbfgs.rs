//! Limited-memory BFGS on the penalty energy, with a backtracking (Armijo, safeguarded quadratic) line search
//! and a cap on any variable's move per step. The number of variables changes with the pair list, so the
//! workspace grows as needed and is reused. A minimisation also ends when an evaluation finds the pair list stale
//! (`Energy::stale`): x is then left at the last accepted point, where the list is still exact.

use crate::energy::Energy;
use polypack_flat::clock::thread_cpu_seconds;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// The budget of a run: evaluations, CPU seconds of this thread, and optionally a wall deadline and a stop flag.
/// `poll` reads the clocks every 128 evaluations.
pub struct Budget<'a> {
    pub max_evals: u64,
    pub seconds: f64,
    pub t0: f64,
    pub deadline: Option<Instant>,
    pub stop: Option<&'a AtomicBool>,
    pub stopped: bool,
    /// Why it stopped: "cpu", "deadline", "stop", "evals" (or set by the search: "bound").
    pub reason: &'static str,
    next_poll: u64,
}

impl<'a> Budget<'a> {
    pub fn new(max_evals: u64, seconds: f64) -> Budget<'a> {
        Budget { max_evals, seconds, t0: thread_cpu_seconds(), deadline: None, stop: None, stopped: false, reason: "", next_poll: 0 }
    }
    /// CPU seconds since the start.
    pub fn elapsed(&self) -> f64 {
        thread_cpu_seconds() - self.t0
    }
    #[inline]
    pub fn poll(&mut self, evals: u64) -> bool {
        if self.stopped {
            return true;
        }
        if evals >= self.max_evals {
            self.stopped = true;
            self.reason = "evals";
        } else if evals >= self.next_poll {
            self.next_poll = evals + 128;
            self.check_clocks();
        }
        self.stopped
    }
    /// Reads the clocks now.
    pub fn check_clocks(&mut self) -> bool {
        if self.stopped {
            return true;
        }
        if self.elapsed() >= self.seconds {
            self.stopped = true;
            self.reason = "cpu";
        } else if self.stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
            self.stopped = true;
            self.reason = "stop";
        } else if self.deadline.is_some_and(|d| Instant::now() >= d) {
            self.stopped = true;
            self.reason = "deadline";
        }
        self.stopped
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Tol {
    /// Stop when E <= e_stop.
    pub e_stop: f64,
    /// Stop when an iteration lowers E by at most rel * E, `patience` times in a row.
    pub rel: f64,
    pub patience: u32,
    /// Stop when every gradient component is at most gtol.
    pub gtol: f64,
    pub max_iter: u32,
    /// Largest move of one variable in one step.
    pub max_step: f64,
}

pub struct Outcome {
    pub e: f64,
    pub iters: u32,
    /// The run stopped near the anchor.
    pub same: bool,
    /// The run stopped because the pair list became stale.
    pub stale: bool,
}

pub struct Lbfgs {
    n: usize,
    m: usize,
    sv: Vec<f64>,
    yv: Vec<f64>,
    rho: Vec<f64>,
    alpha: Vec<f64>,
    x: Vec<f64>,
    g: Vec<f64>,
    d: Vec<f64>,
    xn: Vec<f64>,
    gn: Vec<f64>,
    /// When anchor_r2 > 0, the run stops (Outcome::same) once every piece not flagged in anchor_skip has its centre
    /// within sqrt(anchor_r2) of its place in `anchor` and its (unit) quaternion within sqrt(anchor_r2) of +-its
    /// quaternion there: the relaxation is falling back into the anchor's basin.
    pub anchor: Vec<f64>,
    pub anchor_skip: Vec<bool>,
    pub anchor_r2: f64,
    pub p: usize,
    /// A diagonal preconditioner (the initial inverse Hessian is gamma diag(h0)); empty for the identity.
    pub h0: Vec<f64>,
    /// Steps shortened by the cap (diagnostics).
    pub capped_steps: u64,
}

#[inline(always)]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut acc = [0.0f64; 4];
    let ca = a.chunks_exact(4);
    let cb = b.chunks_exact(4);
    let (ra, rb) = (ca.remainder(), cb.remainder());
    for (x, y) in ca.zip(cb) {
        acc[0] += x[0] * y[0];
        acc[1] += x[1] * y[1];
        acc[2] += x[2] * y[2];
        acc[3] += x[3] * y[3];
    }
    let mut s = (acc[0] + acc[1]) + (acc[2] + acc[3]);
    for (x, y) in ra.iter().zip(rb) {
        s += x * y;
    }
    s
}

#[inline(always)]
fn axpy(a: f64, x: &[f64], y: &mut [f64]) {
    for (yi, xi) in y.iter_mut().zip(x) {
        *yi += a * xi;
    }
}

impl Lbfgs {
    pub fn new(p: usize, m: usize) -> Lbfgs {
        Lbfgs {
            n: 0,
            m,
            sv: Vec::new(),
            yv: Vec::new(),
            rho: vec![0.0; m],
            alpha: vec![0.0; m],
            x: Vec::new(),
            g: Vec::new(),
            d: Vec::new(),
            xn: Vec::new(),
            gn: Vec::new(),
            anchor: vec![0.0; 7 * p],
            anchor_skip: vec![false; p],
            anchor_r2: 0.0,
            p,
            h0: Vec::new(),
            capped_steps: 0,
        }
    }

    fn resize(&mut self, n: usize) {
        self.n = n;
        self.sv.resize(n * self.m, 0.0);
        self.yv.resize(n * self.m, 0.0);
        self.x.resize(n, 0.0);
        self.g.resize(n, 0.0);
        self.d.resize(n, 0.0);
        self.xn.resize(n, 0.0);
        self.gn.resize(n, 0.0);
    }

    /// Minimises the energy from x (overwritten with the result). x's length is the energy's dimension for its
    /// current pair list.
    pub fn minimize(&mut self, en: &mut Energy, budget: &mut Budget, x: &mut [f64], tol: &Tol) -> Outcome {
        let n = x.len();
        self.resize(n);
        let m = self.m;
        self.x.copy_from_slice(x);
        let mut e = en.eval(&self.x, &mut self.g);
        let mut len = 0usize;
        let mut head = 0usize;
        let mut gamma = 0.05;
        let mut small = 0u32;
        let mut iters = 0u32;
        let mut same = false;
        let mut stale = false;
        loop {
            if e <= tol.e_stop || iters >= tol.max_iter || budget.poll(en.evals) {
                break;
            }
            let mut gmax = 0.0f64;
            for &v in &self.g {
                gmax = gmax.max(v.abs());
            }
            if gmax <= tol.gtol {
                break;
            }
            for (d, g) in self.d.iter_mut().zip(&self.g) {
                *d = -g;
            }
            for t in 0..len {
                let slot = (head + m - 1 - t) % m;
                let a = self.rho[slot] * dot(&self.sv[slot * n..slot * n + n], &self.d);
                self.alpha[slot] = a;
                axpy(-a, &self.yv[slot * n..slot * n + n], &mut self.d);
            }
            if self.h0.len() == n {
                for (v, h) in self.d.iter_mut().zip(&self.h0) {
                    *v *= gamma * h;
                }
            } else {
                for v in self.d.iter_mut() {
                    *v *= gamma;
                }
            }
            for t in (0..len).rev() {
                let slot = (head + m - 1 - t) % m;
                let bta = self.rho[slot] * dot(&self.yv[slot * n..slot * n + n], &self.d);
                axpy(self.alpha[slot] - bta, &self.sv[slot * n..slot * n + n], &mut self.d);
            }
            let mut dg = dot(&self.d, &self.g);
            if !(dg < 0.0) {
                len = 0;
                gamma = 0.05;
                for (k, (d, g)) in self.d.iter_mut().zip(&self.g).enumerate() {
                    *d = -gamma * g * if self.h0.len() == n { self.h0[k] } else { 1.0 };
                }
                dg = dot(&self.d, &self.g);
            }
            let mut dmax = 0.0f64;
            for &v in &self.d {
                dmax = dmax.max(v.abs());
            }
            if dmax > tol.max_step {
                self.capped_steps += 1;
                let c = tol.max_step / dmax;
                for v in self.d.iter_mut() {
                    *v *= c;
                }
                dg *= c;
                dmax = tol.max_step;
            }
            let mut t = 1.0;
            let mut en_new;
            let mut ok = false;
            loop {
                for ((xn, x), d) in self.xn.iter_mut().zip(&self.x).zip(&self.d) {
                    *xn = x + t * d;
                }
                en_new = en.eval(&self.xn, &mut self.gn);
                if en.stale {
                    // the step leaves the list's range: shorten it, take it, then end the segment so that the
                    // list is rebuilt there
                    stale = true;
                    t *= 0.3;
                    if t * dmax < 1e-16 || budget.poll(en.evals) {
                        break;
                    }
                    continue;
                }
                if en_new <= e + 1e-4 * t * dg {
                    ok = true;
                    break;
                }
                let denom = en_new - e - dg * t;
                let mut tn = if denom > 0.0 { -dg * t * t / (2.0 * denom) } else { 0.5 * t };
                tn = tn.clamp(0.1 * t, 0.5 * t);
                t = tn;
                if t * dmax < 1e-16 || budget.poll(en.evals) {
                    break;
                }
            }
            if !ok {
                break;
            }
            iters += 1;
            let slot = head;
            let mut sy = 0.0;
            let mut yy = 0.0;
            let hy = self.h0.len() == n;
            {
                let s = &mut self.sv[slot * n..slot * n + n];
                let y = &mut self.yv[slot * n..slot * n + n];
                for (((s, y), (xn, x)), (gn, g)) in
                    s.iter_mut().zip(y.iter_mut()).zip(self.xn.iter().zip(&self.x)).zip(self.gn.iter().zip(&self.g))
                {
                    let sk = xn - x;
                    let yk = gn - g;
                    *s = sk;
                    *y = yk;
                    sy += sk * yk;
                    yy += yk * yk;
                }
                if hy {
                    yy = 0.0;
                    for (yk, h) in y.iter().zip(&self.h0) {
                        yy += yk * yk * h;
                    }
                }
            }
            if sy > 1e-300 && yy > 0.0 {
                self.rho[slot] = 1.0 / sy;
                gamma = sy / yy;
                head = (head + 1) % m;
                if len < m {
                    len += 1;
                }
            }
            let dec = e - en_new;
            std::mem::swap(&mut self.x, &mut self.xn);
            std::mem::swap(&mut self.g, &mut self.gn);
            e = en_new;
            if stale {
                break;
            }
            if self.anchor_r2 > 0.0 && iters >= 8 && iters % 4 == 0 && self.near_anchor() {
                same = true;
                break;
            }
            if dec <= tol.rel * e {
                small += 1;
                if small >= tol.patience {
                    break;
                }
            } else {
                small = 0;
            }
        }
        x.copy_from_slice(&self.x);
        Outcome { e, iters, same, stale }
    }

    fn near_anchor(&self) -> bool {
        let r2 = self.anchor_r2;
        for i in 0..self.p {
            if self.anchor_skip[i] {
                continue;
            }
            let c = &self.x[7 * i..7 * i + 7];
            let a = &self.anchor[7 * i..7 * i + 7];
            let dx = c[0] - a[0];
            let dy = c[1] - a[1];
            let dz = c[2] - a[2];
            if dx * dx + dy * dy + dz * dz > r2 {
                return false;
            }
            let qn = (c[3] * c[3] + c[4] * c[4] + c[5] * c[5] + c[6] * c[6]).sqrt();
            let mut dp = 0.0;
            let mut dm = 0.0;
            for k in 3..7 {
                let v = c[k] / qn;
                dp += (v - a[k]) * (v - a[k]);
                dm += (v + a[k]) * (v + a[k]);
            }
            if dp.min(dm) > r2 {
                return false;
            }
        }
        true
    }
}
