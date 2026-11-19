//! Minimal L-BFGS with a backtracking (Armijo) line search, for the penalty energies of the boundary
//! searches. Port of packages/boundary/src/search/lbfgs.ts.
//!
//! The energies are sums of squared violations: zero on the feasible set and about quadratic with unit
//! curvature near it, so the first step is -g / 2 (exact for one violation) and every step is capped at
//! `max_step` (a length: the variables are displacements). `f` returns the value and writes the gradient
//! into `g`; it may return Infinity (a centre whose path met a hinge), which the line search treats as
//! too long a step. It may also fail (the search's stop), which ends the run at once.

use super::Halt;

/// packages/boundary/src/search/lbfgs.ts: LbfgsOptions
pub struct LbfgsOptions {
    pub max_iter: usize,
    /// Stop as soon as the value is below this.
    pub target: f64,
    /// Longest step (Euclidean norm of the change of x).
    pub max_step: f64,
    /// Correction pairs kept (default 12).
    pub memory: usize,
}

/// The objective: the value, and the gradient written into the second argument.
pub type Objective<'a> = dyn FnMut(&[f64], &mut [f64]) -> Result<f64, Halt> + 'a;

/// packages/boundary/src/search/lbfgs.ts: lbfgs. Returns the end point and its value.
pub fn lbfgs(f: &mut Objective, x0: &[f64], o: &LbfgsOptions) -> Result<(Vec<f64>, f64), Halt> {
    let n = x0.len();
    let m = o.memory;
    let mut x = x0.to_vec();
    let mut g = vec![0.0; n];
    let mut fx = f(&x, &mut g)?;
    if !(fx < f64::INFINITY) || fx < o.target || n == 0 {
        return Ok((x, fx));
    }
    let mut s_hist: Vec<Vec<f64>> = (0..m).map(|_| vec![0.0; n]).collect();
    let mut y_hist: Vec<Vec<f64>> = (0..m).map(|_| vec![0.0; n]).collect();
    let mut rho = vec![0.0; m];
    let mut alpha = vec![0.0; m];
    let mut head = 0usize;
    let mut len = 0usize;
    let mut d = vec![0.0; n];
    let mut xn = vec![0.0; n];
    let mut gn = vec![0.0; n];
    let mut it = 0;
    while it < o.max_iter && fx >= o.target {
        let mut gg = 0.0;
        for k in 0..n {
            gg += g[k] * g[k];
        }
        if !(gg > 1e-300) {
            break;
        }
        // two-loop recursion, newest pair first
        for k in 0..n {
            d[k] = -g[k];
        }
        for j in 0..len {
            let i = (head + 2 * m - 1 - j) % m;
            let si = &s_hist[i];
            let mut a = 0.0;
            for k in 0..n {
                a += si[k] * d[k];
            }
            a *= rho[i];
            alpha[i] = a;
            let yi = &y_hist[i];
            for k in 0..n {
                d[k] -= a * yi[k];
            }
        }
        if len > 0 {
            let i = (head + m - 1) % m;
            let mut sy = 0.0;
            let mut yy = 0.0;
            for k in 0..n {
                sy += s_hist[i][k] * y_hist[i][k];
                yy += y_hist[i][k] * y_hist[i][k];
            }
            let gamma = sy / yy;
            for k in 0..n {
                d[k] *= gamma;
            }
        } else {
            for k in 0..n {
                d[k] *= 0.5;
            }
        }
        for j in (0..len).rev() {
            let i = (head + 2 * m - 1 - j) % m;
            let yi = &y_hist[i];
            let mut b = 0.0;
            for k in 0..n {
                b += yi[k] * d[k];
            }
            b *= rho[i];
            let si = &s_hist[i];
            for k in 0..n {
                d[k] += (alpha[i] - b) * si[k];
            }
        }
        let mut slope = 0.0;
        for k in 0..n {
            slope += g[k] * d[k];
        }
        if !(slope < 0.0) {
            // not a descent direction: forget the history and take a steepest-descent step
            len = 0;
            for k in 0..n {
                d[k] = -0.5 * g[k];
            }
            slope = -0.5 * gg;
        }
        let mut dn = 0.0;
        for k in 0..n {
            dn += d[k] * d[k];
        }
        dn = dn.sqrt();
        if dn > o.max_step {
            let c = o.max_step / dn;
            for k in 0..n {
                d[k] *= c;
            }
            slope *= c;
        }
        let mut t = 1.0;
        let mut fnew = f64::INFINITY;
        for _ls in 0..40 {
            for k in 0..n {
                xn[k] = x[k] + t * d[k];
            }
            fnew = f(&xn, &mut gn)?;
            if fnew <= fx + 1e-4 * t * slope {
                break;
            }
            t *= 0.5;
        }
        if !(fnew < fx) {
            break;
        }
        let i = head;
        let mut sy = 0.0;
        let mut ss = 0.0;
        let mut yy = 0.0;
        for k in 0..n {
            s_hist[i][k] = xn[k] - x[k];
            y_hist[i][k] = gn[k] - g[k];
            sy += s_hist[i][k] * y_hist[i][k];
            ss += s_hist[i][k] * s_hist[i][k];
            yy += y_hist[i][k] * y_hist[i][k];
        }
        // keep the pair only when it carries positive curvature (the penalties are piecewise quadratic)
        if sy > 1e-12 * (ss * yy).sqrt() && sy > 1e-300 {
            rho[i] = 1.0 / sy;
            head = (head + 1) % m;
            len = (len + 1).min(m);
        }
        let rel = (fx - fnew) / fx;
        std::mem::swap(&mut x, &mut xn);
        std::mem::swap(&mut g, &mut gn);
        fx = fnew;
        if rel < 1e-14 {
            break;
        }
        it += 1;
    }
    Ok((x, fx))
}
