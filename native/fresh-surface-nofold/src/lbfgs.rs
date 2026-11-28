// Adapted from native/fresh-flat (fresh code of the same experiment).
//! Limited-memory BFGS with a backtracking (Armijo, quadratic interpolation) line search. All buffers
//! are kept between runs, so a run allocates nothing once the sizes have been seen.

pub trait Objective {
    /// Value at x, gradient written to g.
    fn eval(&mut self, x: &[f64], g: &mut [f64]) -> f64;
    /// Called after each accepted step with the value there; true stops the run (budget, a
    /// neighbour-list rebuild, or a hop that cannot win).
    fn stop(&mut self, x: &[f64], f: f64) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Converged,
    MaxIter,
    Stopped,
    Stalled,
}

pub struct Lbfgs {
    m: usize,
    s: Vec<f64>,
    y: Vec<f64>,
    rho: Vec<f64>,
    alpha: Vec<f64>,
    g: Vec<f64>,
    d: Vec<f64>,
    xn: Vec<f64>,
    gn: Vec<f64>,
}

impl Lbfgs {
    pub fn new(m: usize) -> Lbfgs {
        Lbfgs { m, s: Vec::new(), y: Vec::new(), rho: vec![0.0; m], alpha: vec![0.0; m], g: Vec::new(), d: Vec::new(), xn: Vec::new(), gn: Vec::new() }
    }

    /// Minimises from x (updated in place). `step0` is the largest coordinate change of the first,
    /// steepest-descent step. Returns the final value, why it stopped and the iterations taken.
    pub fn run<O: Objective>(&mut self, o: &mut O, x: &mut [f64], max_iter: usize, gtol: f64, step0: f64) -> (f64, Exit, usize) {
        let n = x.len();
        let m = self.m;
        if self.g.len() < n {
            self.g.resize(n, 0.0);
            self.d.resize(n, 0.0);
            self.xn.resize(n, 0.0);
            self.gn.resize(n, 0.0);
        }
        if self.s.len() < m * n {
            self.s.resize(m * n, 0.0);
            self.y.resize(m * n, 0.0);
        }
        let g = &mut self.g[..n];
        let d = &mut self.d[..n];
        let xn = &mut self.xn[..n];
        let gn = &mut self.gn[..n];
        let mut f = o.eval(x, g);
        let mut hist = 0usize; // stored pairs
        let mut head = 0usize; // slot of the next pair
        let mut stall = 0usize;
        for it in 0..max_iter {
            let mut gmax = 0.0f64;
            for &v in g.iter() {
                gmax = gmax.max(v.abs());
            }
            if gmax <= gtol {
                return (f, Exit::Converged, it);
            }
            // two-loop recursion
            for i in 0..n {
                d[i] = -g[i];
            }
            if hist > 0 {
                for k in 0..hist {
                    let slot = (head + m - 1 - k) % m;
                    let sk = &self.s[slot * n..slot * n + n];
                    let yk = &self.y[slot * n..slot * n + n];
                    let a = self.rho[slot] * dot(sk, d);
                    self.alpha[slot] = a;
                    for i in 0..n {
                        d[i] -= a * yk[i];
                    }
                }
                let newest = (head + m - 1) % m;
                let yk = &self.y[newest * n..newest * n + n];
                let gamma = 1.0 / (self.rho[newest] * dot(yk, yk));
                for v in d.iter_mut() {
                    *v *= gamma;
                }
                for k in (0..hist).rev() {
                    let slot = (head + m - 1 - k) % m;
                    let sk = &self.s[slot * n..slot * n + n];
                    let yk = &self.y[slot * n..slot * n + n];
                    let b = self.rho[slot] * dot(yk, d);
                    let c = self.alpha[slot] - b;
                    for i in 0..n {
                        d[i] += c * sk[i];
                    }
                }
            } else {
                let sc = step0 / gmax;
                for v in d.iter_mut() {
                    *v *= sc;
                }
            }
            let mut gd = dot(g, d);
            if !(gd < 0.0) {
                hist = 0;
                let sc = step0 / gmax;
                for i in 0..n {
                    d[i] = -g[i] * sc;
                }
                gd = dot(g, d);
            }
            // line search
            let mut step = 1.0f64;
            let mut fnew = f;
            let mut ok = false;
            for _ in 0..40 {
                for i in 0..n {
                    xn[i] = x[i] + step * d[i];
                }
                fnew = o.eval(xn, gn);
                if fnew <= f + 1e-4 * step * gd {
                    ok = true;
                    break;
                }
                let denom = 2.0 * (fnew - f - gd * step);
                let mut st = if denom > 0.0 { -gd * step * step / denom } else { 0.5 * step };
                if !(st >= 0.1 * step) {
                    st = 0.1 * step;
                }
                if st > 0.5 * step {
                    st = 0.5 * step;
                }
                step = st;
                if step * gmax < 1e-300 {
                    break;
                }
            }
            if !ok {
                if hist == 0 {
                    return (f, Exit::Stalled, it);
                }
                hist = 0;
                stall += 1;
                if stall > 3 {
                    return (f, Exit::Stalled, it);
                }
                continue;
            }
            // memory update
            {
                let sk = &mut self.s[head * n..head * n + n];
                let yk = &mut self.y[head * n..head * n + n];
                let mut sy = 0.0;
                let mut yy = 0.0;
                for i in 0..n {
                    let a = xn[i] - x[i];
                    let b = gn[i] - g[i];
                    sk[i] = a;
                    yk[i] = b;
                    sy += a * b;
                    yy += b * b;
                }
                if sy > 1e-30 && sy > 1e-12 * yy.sqrt() * dot(sk, sk).sqrt() {
                    self.rho[head] = 1.0 / sy;
                    head = (head + 1) % m;
                    if hist < m {
                        hist += 1;
                    }
                }
            }
            x.copy_from_slice(xn);
            g.copy_from_slice(gn);
            let fprev = f;
            f = fnew;
            if o.stop(x, f) {
                return (f, Exit::Stopped, it + 1);
            }
            if fprev - f <= 1e-15 * f.abs() {
                stall += 1;
                if stall > 8 {
                    return (f, Exit::Stalled, it + 1);
                }
            } else {
                stall = 0;
            }
        }
        (f, Exit::MaxIter, max_iter)
    }
}

#[inline]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut s0 = 0.0;
    let mut s1 = 0.0;
    let n = a.len().min(b.len());
    let mut i = 0;
    while i + 1 < n {
        s0 += a[i] * b[i];
        s1 += a[i + 1] * b[i + 1];
        i += 2;
    }
    if i < n {
        s0 += a[i] * b[i];
    }
    s0 + s1
}
