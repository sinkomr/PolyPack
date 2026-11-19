//! packages/methods/src/lbfgs.ts: minimal L-BFGS with a backtracking (Armijo) line search, for the
//! penalty energies of the kernels.
//!
//! The energies are sums of squared violations: zero on the feasible set and about quadratic with
//! unit curvature near it, so the first step is -g / 2 (exact for one violation) and every step is
//! capped at `max_step`. `f` returns the value and writes the gradient into `g`; it may return
//! Infinity, which the line search treats as too long a step. It may also fail (a method's stop),
//! which ends the run at once.

use crate::kernel::Throw;
use polypack_js::math;

/// lbfgs.ts: LbfgsOptions. `memory` is the source's default, 12.
pub struct LbfgsOptions {
    pub max_iter: usize,
    /// Stop as soon as the value is below this.
    pub target: f64,
    /// Longest step (Euclidean norm of the change of x).
    pub max_step: f64,
}

const MEMORY: usize = 12;

/// The function: the value at a point, with its gradient written to the second argument.
pub type Objective<'a> = dyn FnMut(&[f64], &mut [f64]) -> Result<f64, Throw> + 'a;

/// lbfgs.ts: lbfgs. Returns the point and its value (the source's `iterations` is not read by any
/// caller).
pub fn lbfgs(
    f: &mut Objective<'_>,
    x0: &[f64],
    o: &LbfgsOptions,
) -> Result<(Vec<f64>, f64), Throw> {
    let n = x0.len();
    let m = MEMORY;
    let mut x = x0.to_vec();
    let mut g = vec![0.0f64; n];
    let mut fx = f(&x, &mut g)?;
    if !(fx < f64::INFINITY) || fx < o.target || n == 0 {
        return Ok((x, fx));
    }
    // the correction pairs, flat: pair i is [i * n, (i + 1) * n)
    let mut s_mem = vec![0.0f64; m * n];
    let mut y_mem = vec![0.0f64; m * n];
    let mut rho = vec![0.0f64; m];
    let mut alpha = vec![0.0f64; m];
    let mut head = 0usize;
    let mut len = 0usize;
    let mut d = vec![0.0f64; n];
    let mut xn = vec![0.0f64; n];
    let mut gn = vec![0.0f64; n];
    let mut it = 0usize;
    while it < o.max_iter && fx >= o.target {
        let mut gg = 0.0f64;
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
            let si = &s_mem[i * n..(i + 1) * n];
            let mut a = 0.0f64;
            for k in 0..n {
                a += si[k] * d[k];
            }
            a *= rho[i];
            alpha[i] = a;
            let yi = &y_mem[i * n..(i + 1) * n];
            for k in 0..n {
                d[k] -= a * yi[k];
            }
        }
        if len > 0 {
            let i = (head + m - 1) % m;
            let mut sy = 0.0f64;
            let mut yy = 0.0f64;
            for k in 0..n {
                sy += s_mem[i * n + k] * y_mem[i * n + k];
                yy += y_mem[i * n + k] * y_mem[i * n + k];
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
            let yi = &y_mem[i * n..(i + 1) * n];
            let mut b = 0.0f64;
            for k in 0..n {
                b += yi[k] * d[k];
            }
            b *= rho[i];
            let si = &s_mem[i * n..(i + 1) * n];
            for k in 0..n {
                d[k] += (alpha[i] - b) * si[k];
            }
        }
        let mut slope = 0.0f64;
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
        let mut dn = 0.0f64;
        for k in 0..n {
            dn += d[k] * d[k];
        }
        dn = math::sqrt(dn);
        if dn > o.max_step {
            let c = o.max_step / dn;
            for k in 0..n {
                d[k] *= c;
            }
            slope *= c;
        }
        let mut t = 1.0f64;
        let mut fnew = f64::INFINITY;
        for _ in 0..40 {
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
        let mut sy = 0.0f64;
        let mut ss = 0.0f64;
        let mut yy = 0.0f64;
        for k in 0..n {
            let sk = xn[k] - x[k];
            let yk = gn[k] - g[k];
            s_mem[i * n + k] = sk;
            y_mem[i * n + k] = yk;
            sy += sk * yk;
            ss += sk * sk;
            yy += yk * yk;
        }
        // keep the pair only when it carries positive curvature (the penalties are piecewise quadratic)
        if sy > 1e-12 * math::sqrt(ss * yy) && sy > 1e-300 {
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
