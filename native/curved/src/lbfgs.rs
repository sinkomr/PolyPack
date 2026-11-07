//! L-BFGS with Armijo backtracking (packages/curved/src/optim.ts lbfgs), with its memory kept
//! between runs so that a search allocates once.

pub struct Lbfgs {
    n: usize,
    m: usize,
    s: Vec<f64>,
    y: Vec<f64>,
    rho: Vec<f64>,
    alpha: Vec<f64>,
    /// ring buffer: entry j (0 = oldest) lives in slot (head + j) % m
    head: usize,
    len: usize,
    g: Vec<f64>,
    d: Vec<f64>,
    xn: Vec<f64>,
    gn: Vec<f64>,
    /// objective evaluations since creation
    pub evaluations: u64,
}

pub struct LbfgsOptions {
    pub max_iter: usize,
    pub gtol: f64,
    pub stop_below: f64,
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
            head: 0,
            len: 0,
            g: vec![0.0; n],
            d: vec![0.0; n],
            xn: vec![0.0; n],
            gn: vec![0.0; n],
            evaluations: 0,
        }
    }

    #[inline]
    fn slot(&self, j: usize) -> usize {
        (self.head + j) % self.m
    }

    /// Minimises f from x (updated in place); returns the final value and the iterations done.
    /// `stop` is polled before every iteration; true ends the run at the current point.
    pub fn minimize(
        &mut self,
        x: &mut [f64],
        f: &mut dyn FnMut(&[f64], &mut [f64]) -> f64,
        opts: &LbfgsOptions,
        stop: &mut dyn FnMut() -> bool,
    ) -> (f64, usize) {
        let n = self.n;
        debug_assert_eq!(x.len(), n);
        self.head = 0;
        self.len = 0;
        let mut fx = f(x, &mut self.g);
        self.evaluations += 1;
        let mut it = 0;
        while it < opts.max_iter {
            if fx <= opts.stop_below {
                break;
            }
            if stop() {
                break;
            }
            let gn2: f64 = self.g.iter().map(|v| v * v).sum();
            if gn2.sqrt() < opts.gtol {
                break;
            }
            // two-loop recursion
            for i in 0..n {
                self.d[i] = -self.g[i];
            }
            let k = self.len;
            for j in (0..k).rev() {
                let sl = self.slot(j);
                let sj = &self.s[sl * n..sl * n + n];
                let mut a = 0.0;
                for i in 0..n {
                    a += sj[i] * self.d[i];
                }
                a *= self.rho[sl];
                self.alpha[sl] = a;
                let yj = &self.y[sl * n..sl * n + n];
                for i in 0..n {
                    self.d[i] -= a * yj[i];
                }
            }
            if k > 0 {
                let sl = self.slot(k - 1);
                let (sj, yj) = (&self.s[sl * n..sl * n + n], &self.y[sl * n..sl * n + n]);
                let mut sy = 0.0;
                let mut yy = 0.0;
                for i in 0..n {
                    sy += sj[i] * yj[i];
                    yy += yj[i] * yj[i];
                }
                let gamma = sy / yy;
                for v in self.d.iter_mut() {
                    *v *= gamma;
                }
            } else {
                // first step: scale to a modest move
                let s = 0.01 / gn2.sqrt().max(1e-12);
                let c = (s * 10.0).min(1.0);
                for v in self.d.iter_mut() {
                    *v *= c;
                }
            }
            for j in 0..k {
                let sl = self.slot(j);
                let yj = &self.y[sl * n..sl * n + n];
                let mut b = 0.0;
                for i in 0..n {
                    b += yj[i] * self.d[i];
                }
                b *= self.rho[sl];
                let c = self.alpha[sl] - b;
                let sj = &self.s[sl * n..sl * n + n];
                for i in 0..n {
                    self.d[i] += sj[i] * c;
                }
            }
            let mut dg: f64 = (0..n).map(|i| self.d[i] * self.g[i]).sum();
            if !(dg < 0.0) {
                // not a descent direction: forget the memory and use steepest descent
                self.len = 0;
                self.head = 0;
                for i in 0..n {
                    self.d[i] = -self.g[i] * 0.01;
                }
                dg = (0..n).map(|i| self.d[i] * self.g[i]).sum();
            }
            let mut step = 1.0;
            let mut fnew = 0.0;
            let mut ok = false;
            for _ in 0..30 {
                for i in 0..n {
                    self.xn[i] = x[i] + step * self.d[i];
                }
                fnew = f(&self.xn, &mut self.gn);
                self.evaluations += 1;
                if fnew <= fx + 1e-4 * step * dg {
                    ok = true;
                    break;
                }
                step *= 0.5;
            }
            if !ok {
                break;
            }
            let mut sy = 0.0;
            for i in 0..n {
                sy += (self.xn[i] - x[i]) * (self.gn[i] - self.g[i]);
            }
            if sy > 1e-20 {
                // the new pair (s, y) goes to the slot after the newest, replacing the oldest when full
                let sl = if self.len < self.m {
                    self.slot(self.len)
                } else {
                    self.head
                };
                for i in 0..n {
                    self.s[sl * n + i] = self.xn[i] - x[i];
                    self.y[sl * n + i] = self.gn[i] - self.g[i];
                }
                self.rho[sl] = 1.0 / sy;
                if self.len < self.m {
                    self.len += 1;
                } else {
                    self.head = (self.head + 1) % self.m;
                }
            }
            x.copy_from_slice(&self.xn);
            std::mem::swap(&mut self.g, &mut self.gn);
            fx = fnew;
            it += 1;
        }
        (fx, it)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimises_a_quadratic_and_stops_on_request() {
        let mut l = Lbfgs::new(2, 5);
        let mut x = [3.0, -2.0];
        let mut f = |x: &[f64], g: &mut [f64]| {
            g[0] = 2.0 * (x[0] - 1.0);
            g[1] = 20.0 * (x[1] + 0.5);
            (x[0] - 1.0).powi(2) + 10.0 * (x[1] + 0.5).powi(2)
        };
        let opts = LbfgsOptions {
            max_iter: 200,
            gtol: 1e-12,
            stop_below: f64::NEG_INFINITY,
        };
        let (fx, _) = l.minimize(&mut x, &mut f, &opts, &mut || false);
        assert!(fx < 1e-20 && (x[0] - 1.0).abs() < 1e-9 && (x[1] + 0.5).abs() < 1e-9);
        let mut y = [3.0, -2.0];
        let (_, it) = l.minimize(&mut y, &mut f, &opts, &mut || true);
        assert_eq!(it, 0);
        assert_eq!(y, [3.0, -2.0]);
    }
}
