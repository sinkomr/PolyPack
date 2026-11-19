//! packages/methods/src/local.ts: local solves shared by the methods, on any kernel: L-BFGS on the
//! kernel's penalty energy with every variable scaled to piece units (a variable divided by its
//! `steps` entry), so one step length suits every family.
//!
//!  - relax: the size fixed, minimise the energy (a repair: overlaps pushed apart);
//!  - squeeze: minimise size + mu * energy over the variables and the size together, for each mu of
//!    a rising schedule (a quadratic penalty method: the size shrinks as far as overlaps allow),
//!    then relax at the size reached.
//!
//! Both rebase the state's charts after each L-BFGS run and leave the state at its result. Every
//! energy call goes through the context, so it is charged to the run and may stop it.

use crate::framework::Ctx;
use crate::kernel::{FamilyKernel, KernelState, Throw};
use crate::lbfgs::{lbfgs, LbfgsOptions};

/// local.ts: variableSteps. The typical step of every variable of x: the pieces' steps, then the
/// globals'.
pub fn variable_steps<K: FamilyKernel>(k: &K) -> Vec<f64> {
    let n = k.p() * k.dim();
    let mut out = vec![0.0f64; n + k.globals()];
    let steps = k.steps();
    let dim = k.dim();
    for i in 0..n {
        out[i] = steps[i % dim];
    }
    out[n..].copy_from_slice(&k.global_steps()[..k.globals()]);
    out
}

/// local.ts: RelaxOptions (without the per-piece weights, which no method of this port passes).
#[derive(Clone, Copy, Default)]
pub struct RelaxOptions {
    /// L-BFGS iterations (default 200).
    pub max_iter: Option<usize>,
}

/// local.ts: relax. Relaxes s at its size; returns the energy reached.
pub fn relax<K: FamilyKernel>(
    ctx: &mut Ctx<'_, K>,
    s: &mut KernelState<K::Aux>,
    o: RelaxOptions,
) -> Result<f64, Throw> {
    let steps = variable_steps(&*ctx.k);
    let n = steps.len();
    let mut grad = vec![0.0f64; n + 1];
    let mut y0 = vec![0.0f64; n];
    for i in 0..n {
        y0[i] = s.x[i] / steps[i];
    }
    let (y, fx) = {
        let mut f = |y: &[f64], g: &mut [f64]| -> Result<f64, Throw> {
            for i in 0..n {
                s.x[i] = y[i] * steps[i];
            }
            let e = ctx.energy(s, Some(&mut grad), None)?;
            for i in 0..n {
                g[i] = grad[i] * steps[i];
            }
            Ok(e)
        };
        lbfgs(&mut f, &y0, &LbfgsOptions { max_iter: o.max_iter.unwrap_or(200), target: 1e-20, max_step: 0.5 })?
    };
    for i in 0..n {
        s.x[i] = y[i] * steps[i];
    }
    ctx.k.rebase(s);
    Ok(fx)
}

/// local.ts: SqueezeOptions (without the per-piece weights).
#[derive(Clone, Copy, Default)]
pub struct SqueezeOptions<'a> {
    /// The penalty weights, in order (default 1e1, 1e2, ..., 1e6).
    pub mus: Option<&'a [f64]>,
    /// L-BFGS iterations per weight (default 200).
    pub max_iter: Option<usize>,
}

const DEFAULT_MUS: [f64; 6] = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6];

/// local.ts: squeeze. Squeezes s as far as its overlaps allow; returns the energy at the size
/// reached. The size is kept above the kernel's bound, else 0 (`minSize`'s default).
pub fn squeeze<K: FamilyKernel>(
    ctx: &mut Ctx<'_, K>,
    s: &mut KernelState<K::Aux>,
    o: SqueezeOptions<'_>,
) -> Result<f64, Throw> {
    let steps = variable_steps(&*ctx.k);
    let n = steps.len();
    let min_size = ctx.k.bound().unwrap_or(0.0);
    let mut grad = vec![0.0f64; n + 1];
    for &mu in o.mus.unwrap_or(&DEFAULT_MUS) {
        let mut y0 = vec![0.0f64; n + 1];
        for i in 0..n {
            y0[i] = s.x[i] / steps[i];
        }
        y0[n] = s.size;
        let (y, _) = {
            let mut f = |y: &[f64], g: &mut [f64]| -> Result<f64, Throw> {
                if !(y[n] > min_size) {
                    return Ok(f64::INFINITY);
                }
                for i in 0..n {
                    s.x[i] = y[i] * steps[i];
                }
                s.size = y[n];
                let e = ctx.energy(s, Some(&mut grad), None)?;
                for i in 0..n {
                    g[i] = mu * grad[i] * steps[i];
                }
                g[n] = 1.0 + mu * grad[n];
                Ok(y[n] + mu * e)
            };
            lbfgs(
                &mut f,
                &y0,
                &LbfgsOptions { max_iter: o.max_iter.unwrap_or(200), target: f64::NEG_INFINITY, max_step: 0.25 },
            )?
        };
        for i in 0..n {
            s.x[i] = y[i] * steps[i];
        }
        s.size = y[n];
        ctx.k.rebase(s);
    }
    relax(ctx, s, RelaxOptions { max_iter: o.max_iter })
}
