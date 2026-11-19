//! packages/methods/src/framework.ts: running a method on a kernel: the budget, the stop, the best
//! result.
//!
//! A method is synchronous code that works on kernel states. It never checks validity itself: it
//! offers states (`Ctx::offer`), and the framework finishes them with the kernel's exact finishing,
//! checks an improvement with the server's rule and keeps the best. So a run's result is always
//! valid, whatever the method does, and never worse than its start (a valid start is the first
//! best, uncharged).
//!
//! Budget. `evals` counts the kernel's energy evaluations: energy() is 1 (gradCost with a
//! gradient), pieceEnergy() 1/P (one piece's share of a sweep), finish() the kernel's finishCost and
//! validate() its validateCost (finishCost unless the kernel says otherwise). The source's counted
//! kernel is the set of `Ctx` methods that charge (`energy`, `piece_energy`, `random_start`,
//! `seeds`, `finish`); the others reach the kernel directly through `Ctx::k`. Once the budget is
//! spent, or the stop says so, or the best reaches the problem's lower bound, the next charged call
//! returns `Err(Throw::Stop)`, which ends the method; the run returns the best so far.
//!
//! Not ported: the time budget `time_s` (the space's job passes only `evals` and a stop), the
//! registry and the parameter schemas.

use crate::kernel::{FamilyKernel, Finished, KernelState, StopReason, Throw, Validation};
use crate::random::Mulberry32;

type State<K> = KernelState<<K as FamilyKernel>::Aux>;

/// MethodRunOptions, as the space's job passes them.
pub struct RunOptions<'a, K: FamilyKernel> {
    /// Integer from 0 to 2^32 - 1.
    pub seed: u32,
    /// A configuration in the family's format to start from (any size, valid or not).
    pub start: Option<K::Config>,
    /// `budget.evals`; None runs on the stop alone.
    pub evals: Option<f64>,
    /// `shouldStop`: polled at every charged kernel call, before the call is charged, with the
    /// evaluations charged so far; the second argument is true when the poll comes from inside a
    /// finish.
    pub should_stop: &'a mut dyn FnMut(f64, bool) -> bool,
    /// The kernel's `validate` as the job gives it (runGeneric replaces the kernel's own with the
    /// server's rule).
    pub validate: &'a mut dyn FnMut(&K::Config) -> Validation,
}

/// MethodRunResult.stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stopped {
    Evals,
    Time,
    Stopped,
    Bound,
    Done,
    Error,
}

/// MethodRunResult (without the method's name and parameters).
#[derive(Debug, Clone)]
pub struct RunResult<C> {
    /// The best valid configuration (the start's when nothing beat it), or None.
    pub config: Option<C>,
    pub score: Option<f64>,
    /// Evaluations used; a piece's share of a sweep counts 1/P, so the count can be fractional.
    pub evaluations: f64,
    pub stopped: Stopped,
    pub reasons: Vec<String>,
}

/// MethodContext. `k` is the kernel; the methods call its uncounted operations directly and the
/// counted ones through the methods of the context.
pub struct Ctx<'a, K: FamilyKernel> {
    pub k: &'a mut K,
    pub rng: Mulberry32,
    /// The start the run was given, as a state the method may change, or None.
    pub start: Option<State<K>>,
    eval_limit: f64,
    used: f64,
    best: Option<(K::Config, f64)>,
    should_stop: &'a mut dyn FnMut(f64, bool) -> bool,
    validate: &'a mut dyn FnMut(&K::Config) -> Validation,
    /// local.ts `squeezeWithin`'s guard: the used evaluations at which energy calls fail with `Spent`.
    pub(crate) guard: Option<f64>,
}

enum KeepResult {
    Kept,
    Worse,
    Rejected,
}

impl<K: FamilyKernel> Ctx<'_, K> {
    fn at_bound(&self) -> bool {
        match (&self.best, self.k.bound()) {
            (Some(b), Some(bound)) => bound > 0.0 && b.1 <= bound * (1.0 + 1e-9),
            _ => false,
        }
    }

    /// Throws Stop when the run must end.
    pub fn check(&mut self) -> Result<(), Throw> {
        if (self.should_stop)(self.used, false) {
            return Err(Throw::Stop(StopReason::Stopped));
        }
        if self.used >= self.eval_limit {
            return Err(Throw::Stop(StopReason::Evals));
        }
        if self.at_bound() {
            return Err(Throw::Stop(StopReason::Bound));
        }
        Ok(())
    }

    fn charge(&mut self, cost: f64) -> Result<(), Throw> {
        self.check()?;
        self.used += cost;
        Ok(())
    }

    /// Evaluations used.
    #[inline]
    pub fn used(&self) -> f64 {
        self.used
    }

    /// Evaluations left (Infinity without an evaluation budget).
    #[inline]
    pub fn remaining(&self) -> f64 {
        (self.eval_limit - self.used).max(0.0)
    }

    /// The counted `energy`.
    pub fn energy(&mut self, s: &State<K>, grad: Option<&mut [f64]>, w: Option<&[f64]>) -> Result<f64, Throw> {
        if let Some(limit) = self.guard {
            if self.used >= limit {
                return Err(Throw::Spent);
            }
        }
        let cost = if grad.is_some() { self.k.grad_cost().unwrap_or(1.0) } else { 1.0 };
        self.charge(cost)?;
        self.k.energy(s, grad, w)
    }

    /// The counted `pieceEnergy`.
    pub fn piece_energy(&mut self, s: &State<K>, i: usize, w: Option<&[f64]>) -> Result<f64, Throw> {
        if let Some(limit) = self.guard {
            if self.used >= limit {
                return Err(Throw::Spent);
            }
        }
        self.charge(1.0 / self.k.p() as f64)?;
        self.k.piece_energy(s, i, w)
    }

    /// The counted `randomStart`.
    pub fn random_start(&mut self) -> Result<State<K>, Throw> {
        self.charge(1.0)?;
        Ok(self.k.random_start(&mut self.rng))
    }

    /// The counted `seeds`.
    pub fn seeds(&mut self, n: usize) -> Result<Vec<State<K>>, Throw> {
        self.charge(n as f64)?;
        Ok(self.k.seeds(&mut self.rng, n))
    }

    /// The counted `finish`: a finish that is under way still ends on the external stop, through
    /// its poll.
    fn finish(&mut self, s: &State<K>) -> Result<Option<Finished<K::Config>>, Throw> {
        let cost = self.k.finish_cost();
        self.charge(cost)?;
        let used = self.used;
        let stop = &mut *self.should_stop;
        let mut polled = || stop(used, true);
        self.k.finish(s, &mut polled)
    }

    fn validate_cost(&self) -> f64 {
        self.k.validate_cost().unwrap_or_else(|| self.k.finish_cost())
    }

    /// Keeps f when it beats the best; Rejected when the server's rule refuses it (a finish that
    /// broke its contract).
    fn keep(&mut self, f: &Finished<K::Config>) -> KeepResult {
        if let Some(b) = &self.best {
            if !(f.score < b.1) {
                return KeepResult::Worse;
            }
        }
        // an improvement is checked with the server's rule before it is kept (charged like a finish)
        self.used += self.validate_cost();
        let v = (self.validate)(&f.config);
        match v.score {
            Some(score) if v.valid && score <= f.score * (1.0 + 1e-12) => {
                self.best = Some((f.config.clone(), f.score));
                KeepResult::Kept
            }
            _ => KeepResult::Rejected,
        }
    }

    /// Finishes s (charged finishCost) and keeps it when it beats the best; the finished score, or
    /// None when s does not finish or the server's rule refuses the finished configuration. Once
    /// the run has a result, an offer whose finish and check no longer fit the budget ends the run.
    pub fn offer(&mut self, s: &State<K>) -> Result<Option<f64>, Throw> {
        // once the run has a result, an offer whose finish no longer fits the budget ends the run
        // rather than overrunning it by a whole finish (the first result is always allowed)
        if self.best.is_some() && self.eval_limit - self.used < self.k.finish_cost() + self.validate_cost() {
            return Err(Throw::Stop(StopReason::Evals));
        }
        let Some(f) = self.finish(s)? else {
            return Ok(None);
        };
        Ok(match self.keep(&f) {
            KeepResult::Rejected => None,
            KeepResult::Kept | KeepResult::Worse => Some(f.score),
        })
    }

    /// The best so far: its state (a fresh one at the finished size) and score, or None.
    pub fn best(&mut self) -> Option<(State<K>, f64)> {
        let (config, score) = self.best.clone()?;
        let state = self.k.from_config(&config)?;
        Some((state, score))
    }
}

/// framework.ts: runMethod, for the method `run`. `Err` is a plain `throw` of the source (a budget
/// that is not positive); a method's own failure is a result with `stopped: Error`.
pub fn run_method<K: FamilyKernel>(
    kernel: &mut K,
    o: RunOptions<'_, K>,
    run: fn(&mut Ctx<'_, K>) -> Result<(), Throw>,
) -> Result<RunResult<K::Config>, String> {
    let eval_limit = o.evals.unwrap_or(f64::INFINITY);
    if !(eval_limit > 0.0) {
        return Err("the budget must be positive".to_string());
    }
    let RunOptions { seed, start: start_config, evals: _, should_stop, validate } = o;

    // a valid start is the first best, uncharged, so a run never returns worse than it was given
    // (a kernel that throws on a start is treated as refusing it: the run goes on without one)
    let mut best: Option<(K::Config, f64)> = None;
    let mut start: Option<State<K>> = None;
    if let Some(config) = start_config {
        start = kernel.from_config(&config);
        if start.is_some() {
            let v = validate(&config);
            if let (true, Some(score)) = (v.valid, v.score) {
                best = Some((config, score));
            }
        }
    }

    let mut ctx = Ctx {
        k: kernel,
        rng: Mulberry32::new(seed),
        start,
        eval_limit,
        used: 0.0,
        best,
        should_stop,
        validate,
        guard: None,
    };
    let mut stopped = Stopped::Done;
    let mut reasons: Vec<String> = Vec::new();
    let outcome = ctx.check().and_then(|()| run(&mut ctx));
    match outcome {
        Ok(()) => {}
        Err(Throw::Stop(reason)) => {
            stopped = match reason {
                StopReason::Evals => Stopped::Evals,
                StopReason::Time => Stopped::Time,
                StopReason::Stopped => Stopped::Stopped,
                StopReason::Bound => Stopped::Bound,
            }
        }
        // `Spent` never leaves squeezeWithin
        Err(Throw::Spent) => {
            stopped = Stopped::Error;
            reasons.push("stop: spent".to_string());
        }
        Err(Throw::Error(message)) => {
            stopped = Stopped::Error;
            reasons.push(message);
        }
    }
    if stopped == Stopped::Done && ctx.at_bound() {
        stopped = Stopped::Bound;
    }
    let (config, score) = match ctx.best.take() {
        Some((c, s)) => (Some(c), Some(s)),
        None => (None, None),
    };
    if config.is_none() {
        reasons.push("no valid configuration found".to_string());
    }
    Ok(RunResult { config, score, evaluations: ctx.used, stopped, reasons })
}
