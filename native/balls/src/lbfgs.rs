//! `lbfgs` of `packages/polyhedra/src/polish.ts`, the minimiser of the balls polishes (ball-pieces.ts and
//! solid-pieces.ts import it from `@polypack/polyhedra`).

// Index loops and negated comparisons are kept as the source writes them: `!(a < b)` is not `a >= b` for NaN (native/PORTING.md, rule 4).
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use crate::stop::Stop;
use polypack_js::math;

/// Minimises f from x (in place) by L-BFGS with an Armijo backtracking line search; returns f(x). `f` fills the
/// gradient and may end the run (`Err`), in which case x is the last accepted iterate, as in the source where
/// the exception leaves x as the last `x.set(xn)` made it.
///
/// The source keeps the last `m` pairs (s, y) in arrays and allocates each pair anew; the buffers of a pair
/// dropped from the list are reused here, and `s` and `y` are computed in the same order. The sums run over
/// the same indices in the same order, so every number is the source's.
pub fn lbfgs<F>(f: &mut F, x: &mut [f64], max_iter: usize, m: usize, gtol: f64) -> Result<f64, Stop>
where
    F: FnMut(&[f64], &mut [f64]) -> Result<f64, Stop>,
{
    let n = x.len();
    let mut g = vec![0.0f64; n];
    let mut fx = f(x, &mut g)?;
    // the list of pairs, oldest first; a ring would do, the lists are short (m = 8)
    let mut ss: Vec<Vec<f64>> = Vec::new();
    let mut ys: Vec<Vec<f64>> = Vec::new();
    let mut rho: Vec<f64> = Vec::new();
    let mut spare: Vec<(Vec<f64>, Vec<f64>)> = Vec::new();
    let mut d = vec![0.0f64; n];
    let mut xn = vec![0.0f64; n];
    let mut gn = vec![0.0f64; n];
    let mut alpha = vec![0.0f64; m];
    let mut stall = 0;
    for _it in 0..max_iter {
        let mut gmax = 0.0f64;
        for i in 0..n {
            gmax = math::max(gmax, math::abs(g[i]));
        }
        if gmax < gtol {
            break;
        }
        // two-loop recursion: d = -H g
        for i in 0..n {
            d[i] = -g[i];
        }
        let k = ss.len();
        for j in (0..k).rev() {
            let mut a = 0.0;
            for (sv, dv) in ss[j].iter().zip(d.iter()) {
                a += sv * dv;
            }
            a *= rho[j];
            alpha[j] = a;
            for (dv, yv) in d.iter_mut().zip(ys[j].iter()) {
                *dv -= a * yv;
            }
        }
        if k > 0 {
            let mut sy = 0.0;
            let mut yy = 0.0;
            for (sv, yv) in ss[k - 1].iter().zip(ys[k - 1].iter()) {
                sy += sv * yv;
                yy += yv * yv;
            }
            let gamma = sy / yy;
            for i in 0..n {
                d[i] *= gamma;
            }
        } else {
            // first step: at most 1e-3 in any variable
            let mut dm = 0.0f64;
            for i in 0..n {
                dm = math::max(dm, math::abs(d[i]));
            }
            let sc = if dm > 0.0 { math::min(1.0, 1e-3 / dm) } else { 1.0 };
            for i in 0..n {
                d[i] *= sc;
            }
        }
        for j in 0..k {
            let mut b = 0.0;
            for (yv, dv) in ys[j].iter().zip(d.iter()) {
                b += yv * dv;
            }
            b *= rho[j];
            let c = alpha[j] - b;
            for (dv, sv) in d.iter_mut().zip(ss[j].iter()) {
                *dv += sv * c;
            }
        }
        let mut dg = 0.0;
        for (dv, gv) in d.iter().zip(g.iter()) {
            dg += dv * gv;
        }
        if !(dg < 0.0) {
            // not a descent direction: restart from steepest descent
            while let (Some(s), Some(y)) = (ss.pop(), ys.pop()) {
                spare.push((s, y));
            }
            rho.clear();
            let mut dm = 0.0f64;
            for i in 0..n {
                dm = math::max(dm, math::abs(g[i]));
            }
            let sc = if dm > 0.0 { 1e-3 / dm } else { 0.0 };
            dg = 0.0;
            for i in 0..n {
                d[i] = -g[i] * sc;
                dg += d[i] * g[i];
            }
            if !(dg < 0.0) {
                break;
            }
        }
        let mut step = 1.0;
        let mut fnew = 0.0;
        let mut ok = false;
        for _ls in 0..40 {
            for i in 0..n {
                xn[i] = x[i] + step * d[i];
            }
            fnew = f(&xn, &mut gn)?;
            if fnew <= fx + 1e-4 * step * dg {
                ok = true;
                break;
            }
            step *= 0.5;
        }
        if !ok {
            break;
        }
        let (mut s, mut y) = spare.pop().unwrap_or_else(|| (vec![0.0; n], vec![0.0; n]));
        let mut sy = 0.0;
        for i in 0..n {
            s[i] = xn[i] - x[i];
            y[i] = gn[i] - g[i];
            sy += s[i] * y[i];
        }
        let df = fx - fnew;
        x.copy_from_slice(&xn);
        g.copy_from_slice(&gn);
        fx = fnew;
        if sy > 1e-300 {
            ss.push(s);
            ys.push(y);
            rho.push(1.0 / sy);
            if ss.len() > m {
                spare.push((ss.remove(0), ys.remove(0)));
                rho.remove(0);
            }
        } else {
            spare.push((s, y));
        }
        stall = if df <= 1e-15 * math::max(1.0, math::abs(fx)) { stall + 1 } else { 0 };
        if stall >= 5 {
            break;
        }
    }
    Ok(fx)
}
