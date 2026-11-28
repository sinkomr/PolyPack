//! Limited-memory BFGS with an Armijo backtracking line search (after fresh-round's), with two
//! additions for this problem: a value at which the minimisation stops (an overlap energy that
//! reaches zero has found a packing), and a cap on any coordinate's move per step (so that one step
//! cannot carry a piece across the solid). All buffers are allocated once and reused.

pub struct Lbfgs {
    cap: usize,
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
    /// the value reached the target (a packing)
    Target,
    Gradient,
    Stalled,
    Iterations,
    /// the budget closure said so (time, evaluations, or a neighbour list to rebuild)
    Budget,
}

pub struct Outcome {
    pub f: f64,
    pub iterations: usize,
    pub evaluations: usize,
    pub stop: Stop,
}

/// What one minimisation is asked to do.
#[derive(Clone, Copy, Debug)]
pub struct Opts {
    pub gtol: f64,
    pub f_stop: f64,
    pub max_iter: usize,
    /// largest move of a coordinate in one step
    pub max_step: f64,
    /// relative decrease below which an iteration counts as stalled
    pub stall_rel: f64,
}

impl Lbfgs {
    pub fn new(m: usize) -> Lbfgs {
        Lbfgs { cap: 0, m, s: Vec::new(), y: Vec::new(), rho: vec![0.0; m], alpha: vec![0.0; m], d: Vec::new(), xt: Vec::new(), gt: Vec::new(), g: Vec::new() }
    }

    fn ensure(&mut self, n: usize) {
        if n > self.cap {
            let cap = n.max(self.cap * 3 / 2);
            self.s = vec![0.0; cap * self.m];
            self.y = vec![0.0; cap * self.m];
            self.d = vec![0.0; cap];
            self.xt = vec![0.0; cap];
            self.gt = vec![0.0; cap];
            self.g = vec![0.0; cap];
            self.cap = cap;
        }
    }

    /// Minimises `f` from `x` (updated in place). `f(x, g)` returns the value and writes the
    /// gradient. `budget(evals, iterations, value)` is asked once per iteration whether to stop.
    pub fn minimize<F, B>(&mut self, x: &mut [f64], mut f: F, o: Opts, mut budget: B) -> Outcome
    where
        F: FnMut(&[f64], &mut [f64]) -> f64,
        B: FnMut(usize, usize, f64) -> bool,
    {
        let n = x.len();
        self.ensure(n);
        let m = self.m;
        let (s_all, y_all) = (&mut self.s, &mut self.y);
        let d = &mut self.d[..n];
        let xt = &mut self.xt[..n];
        let gt = &mut self.gt[..n];
        let g = &mut self.g[..n];
        let mut evals = 1usize;
        let mut fx = f(x, g);
        let mut head = 0usize;
        let mut count = 0usize;
        let mut stall = 0usize;
        let mut iter = 0usize;
        let stop;
        loop {
            if !(fx > o.f_stop) {
                stop = Stop::Target;
                break;
            }
            let gmax = g.iter().fold(0.0f64, |a, &v| a.max(v.abs()));
            if !(gmax > o.gtol) {
                stop = Stop::Gradient;
                break;
            }
            if iter >= o.max_iter {
                stop = Stop::Iterations;
                break;
            }
            if budget(evals, iter, fx) {
                stop = Stop::Budget;
                break;
            }
            iter += 1;
            for (di, gi) in d.iter_mut().zip(g.iter()) {
                *di = -gi;
            }
            let mut k = head;
            for _ in 0..count {
                k = if k == 0 { m - 1 } else { k - 1 };
                let sk = &s_all[k * n..(k + 1) * n];
                let yk = &y_all[k * n..(k + 1) * n];
                let a = self.rho[k] * dot(sk, d);
                self.alpha[k] = a;
                axpy(-a, yk, d);
            }
            if count > 0 {
                let last = if head == 0 { m - 1 } else { head - 1 };
                let yk = &y_all[last * n..(last + 1) * n];
                let gamma = 1.0 / (self.rho[last] * dot(yk, yk));
                for v in d.iter_mut() {
                    *v *= gamma;
                }
            } else {
                let scale = (0.1 * o.max_step / gmax.max(1e-300)).min(1.0);
                for v in d.iter_mut() {
                    *v *= scale;
                }
            }
            for _ in 0..count {
                let sk = &s_all[k * n..(k + 1) * n];
                let yk = &y_all[k * n..(k + 1) * n];
                let b = self.rho[k] * dot(yk, d);
                let a = self.alpha[k];
                axpy(a - b, sk, d);
                k = if k + 1 == m { 0 } else { k + 1 };
            }
            let mut gd = dot(g, d);
            if !(gd < 0.0) {
                count = 0;
                let scale = (0.1 * o.max_step / gmax.max(1e-300)).min(1.0);
                for (di, gi) in d.iter_mut().zip(g.iter()) {
                    *di = -gi * scale;
                }
                gd = dot(g, d);
            }
            // cap the largest move
            let dmax = d.iter().fold(0.0f64, |a, &v| a.max(v.abs()));
            if dmax > o.max_step {
                let r = o.max_step / dmax;
                for v in d.iter_mut() {
                    *v *= r;
                }
                gd *= r;
            }
            let mut step = 1.0;
            let mut ft;
            let mut tries = 0;
            loop {
                for ((t, xi), di) in xt.iter_mut().zip(x.iter()).zip(d.iter()) {
                    *t = xi + step * di;
                }
                ft = f(xt, gt);
                evals += 1;
                tries += 1;
                if ft <= fx + 1e-4 * step * gd || tries >= 30 {
                    break;
                }
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
                stop = Stop::Stalled;
                break;
            }
            let off = head * n;
            {
                let sk = &mut s_all[off..off + n];
                for ((si, t), xi) in sk.iter_mut().zip(xt.iter()).zip(x.iter()) {
                    *si = t - xi;
                }
                let yk = &mut y_all[off..off + n];
                for ((yi, t), gi) in yk.iter_mut().zip(gt.iter()).zip(g.iter()) {
                    *yi = t - gi;
                }
            }
            let sy = dot(&s_all[off..off + n], &y_all[off..off + n]);
            let yy = dot(&y_all[off..off + n], &y_all[off..off + n]);
            if sy > 1e-14 * yy && sy > 0.0 {
                self.rho[head] = 1.0 / sy;
                head = if head + 1 == m { 0 } else { head + 1 };
                if count < m {
                    count += 1;
                }
            }
            let decrease = fx - ft;
            x.copy_from_slice(xt);
            g.copy_from_slice(gt);
            fx = ft;
            if decrease <= o.stall_rel * fx.abs().max(1e-300) {
                stall += 1;
                if stall >= 5 {
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

/// Dot product with four accumulators.
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
