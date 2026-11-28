//! Limited-memory BFGS with an Armijo backtracking line search. All buffers are allocated once
//! (`Lbfgs::new`) and reused, so a minimisation allocates nothing.

pub struct Lbfgs {
    n: usize,
    m: usize,
    s: Vec<f64>,
    y: Vec<f64>,
    rho: Vec<f64>,
    alpha: Vec<f64>,
    d: Vec<f64>,
    xt: Vec<f64>,
    gt: Vec<f64>,
    g: Vec<f64>,
}

/// Why a minimisation ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    Gradient,
    Stalled,
    Iterations,
    Budget,
}

pub struct Outcome {
    pub f: f64,
    pub iterations: usize,
    pub evaluations: usize,
    pub stop: Stop,
}

impl Lbfgs {
    pub fn new(n: usize, m: usize) -> Lbfgs {
        Lbfgs {
            n,
            m,
            s: vec![0.0; n * m],
            y: vec![0.0; n * m],
            rho: vec![0.0; m],
            alpha: vec![0.0; m],
            d: vec![0.0; n],
            xt: vec![0.0; n],
            gt: vec![0.0; n],
            g: vec![0.0; n],
        }
    }

    /// Minimises `f` from `x` (updated in place). `f(x, g)` returns the value and writes the
    /// gradient. Ends when the largest gradient component is below `gtol`, after `max_iter`
    /// iterations, when the value stops decreasing, or when `budget()` says so (checked once per
    /// iteration; it receives the evaluations used so far).
    pub fn minimize<F, B>(&mut self, x: &mut [f64], mut f: F, gtol: f64, max_iter: usize, mut budget: B) -> Outcome
    where
        F: FnMut(&[f64], &mut [f64]) -> f64,
        B: FnMut(usize) -> bool,
    {
        let n = self.n;
        debug_assert_eq!(x.len(), n);
        let m = self.m;
        let mut evals = 1usize;
        let mut fx = f(x, &mut self.g);
        let mut head = 0usize; // next slot
        let mut count = 0usize; // pairs stored
        let mut stall = 0usize;
        let mut iter = 0usize;
        let stop;
        loop {
            let gmax = self.g.iter().fold(0.0f64, |a, &v| a.max(v.abs()));
            let gmax = if gmax.is_nan() { 0.0 } else { gmax };
            if !(gmax > gtol) {
                stop = Stop::Gradient;
                break;
            }
            if iter >= max_iter {
                stop = Stop::Iterations;
                break;
            }
            if budget(evals) {
                stop = Stop::Budget;
                break;
            }
            iter += 1;
            // two-loop recursion: d = -H g
            for (d, g) in self.d.iter_mut().zip(&self.g) {
                *d = -g;
            }
            let mut k = head;
            for _ in 0..count {
                k = if k == 0 { m - 1 } else { k - 1 };
                let sk = &self.s[k * n..(k + 1) * n];
                let yk = &self.y[k * n..(k + 1) * n];
                let a = self.rho[k] * dot(sk, &self.d);
                self.alpha[k] = a;
                axpy(-a, yk, &mut self.d);
            }
            if count > 0 {
                let last = if head == 0 { m - 1 } else { head - 1 };
                let yk = &self.y[last * n..(last + 1) * n];
                let gamma = 1.0 / (self.rho[last] * dot(yk, yk));
                for v in self.d.iter_mut() {
                    *v *= gamma;
                }
            } else {
                // first step: a move of at most 0.05 in the largest coordinate
                let scale = 0.05 / gmax.max(1e-300);
                let scale = scale.min(1.0);
                for v in self.d.iter_mut() {
                    *v *= scale;
                }
            }
            for _ in 0..count {
                let sk = &self.s[k * n..(k + 1) * n];
                let yk = &self.y[k * n..(k + 1) * n];
                let b = self.rho[k] * dot(yk, &self.d);
                let a = self.alpha[k];
                axpy(a - b, sk, &mut self.d);
                k = if k + 1 == m { 0 } else { k + 1 };
            }
            let mut gd = dot(&self.g, &self.d);
            if !(gd < 0.0) {
                // not a descent direction: restart from steepest descent
                count = 0;
                let scale = (0.05 / gmax.max(1e-300)).min(1.0);
                for i in 0..n {
                    self.d[i] = -self.g[i] * scale;
                }
                gd = dot(&self.g, &self.d);
            }
            // backtracking line search (Armijo), interpolating the step
            let mut step = 1.0;
            let mut ft;
            let mut tries = 0;
            loop {
                for ((t, xi), di) in self.xt.iter_mut().zip(x.iter()).zip(&self.d) {
                    *t = xi + step * di;
                }
                ft = f(&self.xt, &mut self.gt);
                evals += 1;
                tries += 1;
                if ft <= fx + 1e-4 * step * gd || tries >= 30 {
                    break;
                }
                // minimiser of the quadratic through f(0), f'(0), f(step)
                let denom = 2.0 * (ft - fx - gd * step);
                let mut next = if denom > 0.0 { -gd * step * step / denom } else { 0.5 * step };
                if !(next > 0.1 * step) {
                    next = 0.1 * step;
                }
                if next > 0.5 * step {
                    next = 0.5 * step;
                }
                step = next;
            }
            if !(ft <= fx) {
                // no decrease at all: stop
                stop = Stop::Stalled;
                break;
            }
            // update the history with s = xt - x, y = gt - g
            let sk_off = head * n;
            {
                let sk = &mut self.s[sk_off..sk_off + n];
                for ((si, t), xi) in sk.iter_mut().zip(&self.xt).zip(x.iter()) {
                    *si = t - xi;
                }
                let yk = &mut self.y[sk_off..sk_off + n];
                for ((yi, t), gi) in yk.iter_mut().zip(&self.gt).zip(&self.g) {
                    *yi = t - gi;
                }
            }
            let sy = dot(&self.s[sk_off..sk_off + n], &self.y[sk_off..sk_off + n]);
            let yy = dot(&self.y[sk_off..sk_off + n], &self.y[sk_off..sk_off + n]);
            if sy > 1e-14 * yy && sy > 0.0 {
                self.rho[head] = 1.0 / sy;
                head = if head + 1 == m { 0 } else { head + 1 };
                if count < m {
                    count += 1;
                }
            }
            let decrease = fx - ft;
            x.copy_from_slice(&self.xt);
            self.g.copy_from_slice(&self.gt);
            fx = ft;
            if decrease <= 1e-16 * fx.abs().max(1e-300) {
                stall += 1;
                if stall >= 4 {
                    stop = Stop::Stalled;
                    break;
                }
            } else {
                stall = 0;
            }
        }
        Outcome { f: fx, iterations: iter, evaluations: evals, stop }
    }
}

/// Dot product with four accumulators (vectorisable).
#[inline]
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
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
#[inline]
pub fn axpy(a: f64, x: &[f64], y: &mut [f64]) {
    for (yi, xi) in y.iter_mut().zip(x) {
        *yi += a * xi;
    }
}
