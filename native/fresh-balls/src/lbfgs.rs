//! Limited-memory BFGS for the penalty energy, with a backtracking (Armijo, safeguarded quadratic) line search
//! and a cap on any coordinate's move per step. The workspace is allocated once per problem size and reused.

use crate::energy::Energy;
use polypack_flat::clock::thread_cpu_seconds;

/// The budget of a run: evaluations and CPU seconds. `poll` reads the clock every 256 evaluations.
pub struct Budget {
    pub max_evals: u64,
    pub seconds: f64,
    pub t0: f64,
    pub stopped: bool,
    next_poll: u64,
}

impl Budget {
    pub fn new(max_evals: u64, seconds: f64) -> Budget {
        Budget { max_evals, seconds, t0: thread_cpu_seconds(), stopped: false, next_poll: 0 }
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
        } else if evals >= self.next_poll {
            self.next_poll = evals + 256;
            if self.elapsed() >= self.seconds {
                self.stopped = true;
            }
        }
        self.stopped
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Tol {
    /// Stop when E <= e_stop (the packing is feasible to that depth).
    pub e_stop: f64,
    /// Stop when an iteration lowers E by at most rel * E, `patience` times in a row.
    pub rel: f64,
    pub patience: u32,
    /// Stop when every gradient component is at most gtol.
    pub gtol: f64,
    pub max_iter: u32,
    /// Largest move of one coordinate in one step.
    pub max_step: f64,
}

pub struct Outcome {
    pub e: f64,
    pub iters: u32,
    /// The run stopped near the anchor.
    pub same: bool,
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
    /// When Some, the energy after each iteration is pushed (diagnostics).
    pub trace: Option<Vec<f64>>,
    /// When anchor_r2 > 0: the run stops (Outcome::same) once every ball not flagged in anchor_skip is within
    /// sqrt(anchor_r2) of its place in `anchor`: the relaxation is falling back into the anchor's basin.
    pub anchor: Vec<f64>,
    pub anchor_skip: Vec<bool>,
    pub anchor_r2: f64,
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

/// y += a x
#[inline(always)]
fn axpy(a: f64, x: &[f64], y: &mut [f64]) {
    for (yi, xi) in y.iter_mut().zip(x) {
        *yi += a * xi;
    }
}

impl Lbfgs {
    pub fn new(n: usize, m: usize) -> Lbfgs {
        Lbfgs {
            n,
            m,
            sv: vec![0.0; n * m],
            yv: vec![0.0; n * m],
            rho: vec![0.0; m],
            alpha: vec![0.0; m],
            x: vec![0.0; n],
            g: vec![0.0; n],
            d: vec![0.0; n],
            xn: vec![0.0; n],
            gn: vec![0.0; n],
            trace: None,
            anchor: vec![0.0; n],
            anchor_skip: vec![false; n / 3],
            anchor_r2: 0.0,
        }
    }

    /// Minimises the energy from x (overwritten with the result).
    pub fn minimize(&mut self, en: &mut Energy, budget: &mut Budget, x: &mut [f64], tol: &Tol) -> Outcome {
        let n = self.n;
        let m = self.m;
        self.x.copy_from_slice(&x[..n]);
        let mut e = en.eval(&self.x, &mut self.g);
        let mut len = 0usize; // stored pairs
        let mut head = 0usize; // next slot
        let mut gamma = 0.1;
        let mut small = 0u32;
        let mut iters = 0u32;
        let mut same = false;
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
            // d = -H g by the two-loop recursion
            for (d, g) in self.d.iter_mut().zip(&self.g) {
                *d = -g;
            }
            for t in 0..len {
                let slot = (head + m - 1 - t) % m;
                let a = self.rho[slot] * dot(&self.sv[slot * n..slot * n + n], &self.d);
                self.alpha[slot] = a;
                axpy(-a, &self.yv[slot * n..slot * n + n], &mut self.d);
            }
            for v in self.d.iter_mut() {
                *v *= gamma;
            }
            for t in (0..len).rev() {
                let slot = (head + m - 1 - t) % m;
                let bta = self.rho[slot] * dot(&self.yv[slot * n..slot * n + n], &self.d);
                axpy(self.alpha[slot] - bta, &self.sv[slot * n..slot * n + n], &mut self.d);
            }
            let mut dg = dot(&self.d, &self.g);
            if !(dg < 0.0) {
                // not a descent direction: forget the history
                len = 0;
                gamma = 0.1;
                for (d, g) in self.d.iter_mut().zip(&self.g) {
                    *d = -gamma * g;
                }
                dg = dot(&self.d, &self.g);
            }
            let mut dmax = 0.0f64;
            for &v in &self.d {
                dmax = dmax.max(v.abs());
            }
            if dmax > tol.max_step {
                let c = tol.max_step / dmax;
                for v in self.d.iter_mut() {
                    *v *= c;
                }
                dg *= c;
                dmax = tol.max_step;
            }
            // backtracking line search
            let mut t = 1.0;
            let mut en_new;
            let mut ok = false;
            loop {
                for ((xn, x), d) in self.xn.iter_mut().zip(&self.x).zip(&self.d) {
                    *xn = x + t * d;
                }
                en_new = en.eval(&self.xn, &mut self.gn);
                if en_new <= e + 1e-4 * t * dg {
                    ok = true;
                    break;
                }
                let denom = en_new - e - dg * t;
                let mut tn = if denom > 0.0 { -dg * t * t / (2.0 * denom) } else { 0.5 * t };
                tn = tn.clamp(0.1 * t, 0.5 * t);
                t = tn;
                if t * dmax < 1e-15 || budget.poll(en.evals) {
                    break;
                }
            }
            if !ok {
                break;
            }
            iters += 1;
            // history
            let slot = head;
            let mut sy = 0.0;
            let mut yy = 0.0;
            {
                let s = &mut self.sv[slot * n..slot * n + n];
                let y = &mut self.yv[slot * n..slot * n + n];
                for (((s, y), (xn, x)), (gn, g)) in s.iter_mut().zip(y.iter_mut()).zip(self.xn.iter().zip(&self.x)).zip(self.gn.iter().zip(&self.g)) {
                    let sk = xn - x;
                    let yk = gn - g;
                    *s = sk;
                    *y = yk;
                    sy += sk * yk;
                    yy += yk * yk;
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
            if let Some(tr) = self.trace.as_mut() {
                tr.push(e);
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
        x[..n].copy_from_slice(&self.x);
        Outcome { e, iters, same }
    }

    fn near_anchor(&self) -> bool {
        let r2 = self.anchor_r2;
        for (i, (c, a)) in self.x.chunks_exact(3).zip(self.anchor.chunks_exact(3)).enumerate() {
            if self.anchor_skip[i] {
                continue;
            }
            let dx = c[0] - a[0];
            let dy = c[1] - a[1];
            let dz = c[2] - a[2];
            if dx * dx + dy * dy + dz * dz > r2 {
                return false;
            }
        }
        true
    }
}
