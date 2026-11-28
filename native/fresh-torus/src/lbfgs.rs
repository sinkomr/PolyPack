//! Limited-memory BFGS with a backtracking (Armijo, safeguarded quadratic) line search and a cap on any
//! coordinate's move per step. Buffers are kept between runs, so a run allocates nothing once the sizes have
//! been seen.

pub trait Objective {
    /// Value at x, gradient written to g.
    fn eval(&mut self, x: &[f64], g: &mut [f64]) -> f64;
    /// Called after each accepted step; true stops the run (a neighbour-list rebuild, a return to the anchor's
    /// basin, or the budget).
    fn after_step(&mut self, x: &[f64], f: f64, iter: u32) -> bool;
    /// True once the budget is spent (checked inside the line search too).
    fn exhausted(&self) -> bool;
}

#[derive(Clone, Copy, Debug)]
pub struct Tol {
    /// Stop when f <= e_stop.
    pub e_stop: f64,
    /// Stop when an iteration lowers f by at most rel * f, `patience` times in a row.
    pub rel: f64,
    pub patience: u32,
    /// Stop when every gradient component is at most gtol.
    pub gtol: f64,
    pub max_iter: u32,
    /// Largest move of one coordinate in one step.
    pub max_step: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Converged,
    Stalled,
    MaxIter,
    /// `after_step` or the budget stopped it.
    Hook,
}

#[derive(Clone, Copy, Debug)]
pub struct Outcome {
    pub f: f64,
    pub iters: u32,
    pub exit: Exit,
}

pub struct Lbfgs {
    m: usize,
    sv: Vec<f64>,
    yv: Vec<f64>,
    rho: Vec<f64>,
    alpha: Vec<f64>,
    g: Vec<f64>,
    d: Vec<f64>,
    xn: Vec<f64>,
    gn: Vec<f64>,
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
    pub fn new(m: usize) -> Lbfgs {
        Lbfgs { m, sv: Vec::new(), yv: Vec::new(), rho: vec![0.0; m], alpha: vec![0.0; m], g: Vec::new(), d: Vec::new(), xn: Vec::new(), gn: Vec::new() }
    }

    /// Minimises from x (overwritten with the result).
    pub fn run<O: Objective>(&mut self, o: &mut O, x: &mut [f64], tol: &Tol) -> Outcome {
        let n = x.len();
        let m = self.m;
        if self.g.len() < n {
            self.g.resize(n, 0.0);
            self.d.resize(n, 0.0);
            self.xn.resize(n, 0.0);
            self.gn.resize(n, 0.0);
        }
        if self.sv.len() < m * n {
            self.sv.resize(m * n, 0.0);
            self.yv.resize(m * n, 0.0);
        }
        let g = &mut self.g[..n];
        let d = &mut self.d[..n];
        let xn = &mut self.xn[..n];
        let gn = &mut self.gn[..n];
        let mut f = o.eval(x, g);
        let mut len = 0usize;
        let mut head = 0usize;
        let mut gamma = 0.1;
        let mut small = 0u32;
        let mut iters = 0u32;
        let exit;
        loop {
            if f <= tol.e_stop {
                exit = Exit::Converged;
                break;
            }
            if iters >= tol.max_iter {
                exit = Exit::MaxIter;
                break;
            }
            if o.exhausted() {
                exit = Exit::Hook;
                break;
            }
            let mut gmax = 0.0f64;
            for &v in g.iter() {
                gmax = gmax.max(v.abs());
            }
            if gmax <= tol.gtol {
                exit = Exit::Converged;
                break;
            }
            for (di, gi) in d.iter_mut().zip(g.iter()) {
                *di = -gi;
            }
            for t in 0..len {
                let slot = (head + m - 1 - t) % m;
                let a = self.rho[slot] * dot(&self.sv[slot * n..slot * n + n], d);
                self.alpha[slot] = a;
                axpy(-a, &self.yv[slot * n..slot * n + n], d);
            }
            for v in d.iter_mut() {
                *v *= gamma;
            }
            for t in (0..len).rev() {
                let slot = (head + m - 1 - t) % m;
                let b = self.rho[slot] * dot(&self.yv[slot * n..slot * n + n], d);
                axpy(self.alpha[slot] - b, &self.sv[slot * n..slot * n + n], d);
            }
            let mut dg = dot(d, g);
            if !(dg < 0.0) {
                len = 0;
                gamma = 0.1;
                for (di, gi) in d.iter_mut().zip(g.iter()) {
                    *di = -gamma * gi;
                }
                dg = dot(d, g);
            }
            let mut dmax = 0.0f64;
            for &v in d.iter() {
                dmax = dmax.max(v.abs());
            }
            if dmax > tol.max_step {
                let c = tol.max_step / dmax;
                for v in d.iter_mut() {
                    *v *= c;
                }
                dg *= c;
                dmax = tol.max_step;
            }
            let mut t = 1.0;
            let mut fnew;
            let mut ok = false;
            loop {
                for ((xi, x0), di) in xn.iter_mut().zip(x.iter()).zip(d.iter()) {
                    *xi = x0 + t * di;
                }
                fnew = o.eval(xn, gn);
                if fnew <= f + 1e-4 * t * dg {
                    ok = true;
                    break;
                }
                let denom = fnew - f - dg * t;
                let mut tn = if denom > 0.0 { -dg * t * t / (2.0 * denom) } else { 0.5 * t };
                tn = tn.clamp(0.1 * t, 0.5 * t);
                t = tn;
                if t * dmax < 1e-16 || o.exhausted() {
                    break;
                }
            }
            if !ok {
                if len > 0 && !o.exhausted() {
                    // retry once along the steepest descent before giving up
                    len = 0;
                    gamma = 0.1;
                    small += 1;
                    if small < tol.patience.max(2) {
                        continue;
                    }
                }
                exit = if o.exhausted() { Exit::Hook } else { Exit::Stalled };
                break;
            }
            iters += 1;
            let slot = head;
            let mut sy = 0.0;
            let mut yy = 0.0;
            {
                let s = &mut self.sv[slot * n..slot * n + n];
                let y = &mut self.yv[slot * n..slot * n + n];
                for k in 0..n {
                    let sk = xn[k] - x[k];
                    let yk = gn[k] - g[k];
                    s[k] = sk;
                    y[k] = yk;
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
            let dec = f - fnew;
            x.copy_from_slice(xn);
            g.copy_from_slice(gn);
            f = fnew;
            if o.after_step(x, f, iters) {
                exit = Exit::Hook;
                break;
            }
            if dec <= tol.rel * f {
                small += 1;
                if small >= tol.patience {
                    exit = Exit::Stalled;
                    break;
                }
            } else {
                small = 0;
            }
        }
        Outcome { f, iters, exit }
    }
}
