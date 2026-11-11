//! L-BFGS with an Armijo safeguard (packages/solver/src/methods/penalty/lbfgs.ts): the two-loop
//! inverse-Hessian recursion, a steepest-descent restart when the quasi-Newton direction is not a
//! descent direction, and a backtracking line search that accepts only finite, strictly
//! decreasing steps with sufficient decrease. All buffers are reused between solves.

/// How a solve ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// The gradient's infinity norm reached the tolerance.
    Converged,
    /// The iteration limit was reached.
    Limit,
    /// The driver asked to stop (budget, abort, or its per-step callback).
    Stopped,
    /// No step of the line search decreased the objective.
    Stalled,
    /// The objective was not finite at the start.
    Nonfinite,
}

#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub iterations: u32,
    pub memory: usize,
    pub tolerance: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Outcome {
    /// Objective at the final iterate.
    pub value: f64,
    /// Objective at the starting point.
    pub initial_value: f64,
    pub iterations: u32,
    pub status: Status,
}

/// The function to minimise and the hooks of the caller.
pub trait Objective {
    /// The value at `x`, with its gradient written to `grad`.
    fn eval(&mut self, x: &[f64], grad: &mut [f64]) -> f64;
    /// Before every iteration; false stops the solve.
    fn checkpoint(&mut self) -> bool {
        true
    }
    /// Before every line-search trial; true stops the solve.
    fn stopped(&mut self) -> bool {
        false
    }
    /// After every accepted step; false stops the solve (the iterate is kept).
    fn accepted(&mut self, _x: &[f64], _iteration: u32) -> bool {
        true
    }
}

#[inline]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut sum = 0.0;
    for k in 0..a.len() {
        sum += a[k] * b[k];
    }
    sum
}

#[inline]
fn all_finite(v: &[f64]) -> bool {
    v.iter().all(|x| x.is_finite())
}

/// Reusable solver state: the curvature pairs (a ring of `memory` slots) and work vectors.
#[derive(Default)]
pub struct Lbfgs {
    n: usize,
    memory: usize,
    s: Vec<f64>,
    y: Vec<f64>,
    rho: Vec<f64>,
    alpha: Vec<f64>,
    head: usize,
    len: usize,
    grad: Vec<f64>,
    grad_new: Vec<f64>,
    direction: Vec<f64>,
    trial: Vec<f64>,
}

impl Lbfgs {
    pub fn new() -> Self {
        Self::default()
    }

    fn prepare(&mut self, n: usize, memory: usize) {
        let memory = memory.max(1);
        self.n = n;
        self.memory = memory;
        self.s.resize(n * memory, 0.0);
        self.y.resize(n * memory, 0.0);
        self.rho.resize(memory, 0.0);
        self.alpha.resize(memory, 0.0);
        self.head = 0;
        self.len = 0;
        self.grad.resize(n, 0.0);
        self.grad_new.resize(n, 0.0);
        self.direction.resize(n, 0.0);
        self.trial.resize(n, 0.0);
    }

    /// Slot of the k-th oldest stored pair.
    #[inline]
    fn slot(&self, k: usize) -> usize {
        (self.head + k) % self.memory
    }

    /// Minimise from `x`, which holds the latest accepted iterate on return (the start when the
    /// objective is not finite there).
    pub fn minimize<O: Objective>(&mut self, x: &mut [f64], options: &Options, objective: &mut O) -> Outcome {
        let n = x.len();
        self.prepare(n, options.memory);
        let mut f = objective.eval(x, &mut self.grad);
        let initial_value = f;
        let mut iterations = 0u32;
        if !(f.is_finite() && all_finite(&self.grad)) {
            return Outcome { value: f, initial_value, iterations, status: Status::Nonfinite };
        }
        macro_rules! finish {
            ($status:expr) => {
                return Outcome { value: f, initial_value, iterations, status: $status }
            };
        }
        while iterations < options.iterations {
            if objective.stopped() || !objective.checkpoint() {
                finish!(Status::Stopped);
            }
            let gmax = self.grad.iter().fold(0.0f64, |m, g| m.max(g.abs()));
            if gmax <= options.tolerance {
                finish!(Status::Converged);
            }
            // two-loop recursion on a copy of the gradient
            self.direction.copy_from_slice(&self.grad);
            for k in (0..self.len).rev() {
                let slot = self.slot(k);
                let a = self.rho[slot] * dot(&self.s[slot * n..(slot + 1) * n], &self.direction);
                self.alpha[k] = a;
                let yk = &self.y[slot * n..(slot + 1) * n];
                for (d, y) in self.direction.iter_mut().zip(yk.iter()) {
                    *d -= a * y;
                }
            }
            let scale = if self.len > 0 {
                let slot = self.slot(self.len - 1);
                let s = &self.s[slot * n..(slot + 1) * n];
                let y = &self.y[slot * n..(slot + 1) * n];
                dot(s, y) / dot(y, y)
            } else {
                1.0
            };
            for d in self.direction.iter_mut() {
                *d *= scale;
            }
            for k in 0..self.len {
                let slot = self.slot(k);
                let beta = self.rho[slot] * dot(&self.y[slot * n..(slot + 1) * n], &self.direction);
                let c = self.alpha[k] - beta;
                let sk = &self.s[slot * n..(slot + 1) * n];
                for (d, s) in self.direction.iter_mut().zip(sk.iter()) {
                    *d += s * c;
                }
            }
            for d in self.direction.iter_mut() {
                *d = -*d;
            }
            let gg = dot(&self.grad, &self.grad);
            let mut slope = dot(&self.grad, &self.direction);
            if !slope.is_finite() || slope >= -1e-16 * gg {
                self.len = 0;
                self.head = 0;
                for j in 0..n {
                    self.direction[j] = -self.grad[j];
                }
                slope = -gg;
            }
            let mut step = if self.len > 0 { 1.0 } else { 1f64.min(1.0 / 1f64.max((-slope).sqrt())) };
            // nonfinite trials and feature switches cannot bypass the sufficient-decrease test
            let mut accepted = None;
            for _line in 0..48 {
                if objective.stopped() {
                    finish!(Status::Stopped);
                }
                for j in 0..n {
                    self.trial[j] = x[j] + step * self.direction[j];
                }
                let value = objective.eval(&self.trial, &mut self.grad_new);
                if value.is_finite() && all_finite(&self.grad_new) && value <= f + 1e-4 * step * slope && value < f {
                    accepted = Some(value);
                    break;
                }
                step *= 0.5;
            }
            let Some(value) = accepted else {
                finish!(Status::Stalled);
            };
            // the new curvature pair goes into the next free slot, or replaces the oldest
            let (mut sy, mut ss, mut yy) = (0.0, 0.0, 0.0);
            for j in 0..n {
                let s = self.trial[j] - x[j];
                let y = self.grad_new[j] - self.grad[j];
                sy += s * y;
                ss += s * s;
                yy += y * y;
            }
            // skip nonpositive or numerically vanishing curvature, keeping the inverse positive
            if sy > 1e-10 * (ss * yy).sqrt() {
                let slot = if self.len == self.memory {
                    let oldest = self.head;
                    self.head = (self.head + 1) % self.memory;
                    oldest
                } else {
                    let slot = self.slot(self.len);
                    self.len += 1;
                    slot
                };
                let base = slot * n;
                for j in 0..n {
                    self.s[base + j] = self.trial[j] - x[j];
                    self.y[base + j] = self.grad_new[j] - self.grad[j];
                }
                self.rho[slot] = 1.0 / sy;
            }
            x.copy_from_slice(&self.trial);
            std::mem::swap(&mut self.grad, &mut self.grad_new);
            f = value;
            if !objective.accepted(x, iterations) {
                finish!(Status::Stopped);
            }
            iterations += 1;
        }
        finish!(Status::Limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rosenbrock;
    impl Objective for Rosenbrock {
        fn eval(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
            let (a, b) = (x[0], x[1]);
            g[0] = -2.0 * (1.0 - a) - 400.0 * a * (b - a * a);
            g[1] = 200.0 * (b - a * a);
            (1.0 - a).powi(2) + 100.0 * (b - a * a).powi(2)
        }
    }

    #[test]
    fn minimises_rosenbrock() {
        let mut x = [-1.2, 1.0];
        let mut solver = Lbfgs::new();
        let out = solver.minimize(&mut x, &Options { iterations: 500, memory: 8, tolerance: 1e-9 }, &mut Rosenbrock);
        assert!(out.value < 1e-12, "{out:?}");
        assert!((x[0] - 1.0).abs() < 1e-5 && (x[1] - 1.0).abs() < 1e-5);
        assert_eq!(out.status, Status::Converged);
    }
}
