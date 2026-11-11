//! The run framework of the search methods (packages/solver/src/framework.ts, in synchronous
//! form): budgets of counted evaluations and active seconds, nested sub-runs, the best
//! configuration of a run with the strict rule, stop and pause, and the final polish stage.
//!
//! An *evaluation* is one assessment of a candidate configuration with the server's rule: the
//! piece count and ranges, the pairs below -1e-9, the strict check and the enclosing container.
//! A run's result is reproducible from its seed when its evaluation budget, rather than its time
//! budget, ends it: no decision of a method reads a clock.
//!
//! Strict results: a configuration is strict when no pair penetrates by more than 1e-12 (widened
//! far from the origin, see `strict_tolerance`). A strict configuration always replaces a
//! non-strict best and is never replaced by one, whatever the scores.

use crate::clock::{Clock, ClockKind};
use crate::enclose::{auto_orient_set_fast as auto_orient_set, extreme_points, Encloser, PolygonEncloser};
use crate::grid::NeighborGrid;
use crate::methods::{self, Method};
use crate::rng::Rng;
use crate::sep::Shape;
use crate::shapes::{bounding_radius, Config, Container, Pose, Problem, MAX_COORD};
use crate::validate::{strict_tolerance, TOL};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Stop and pause flags shared between the host and a running job.
#[derive(Debug, Default)]
pub struct Control {
    pub aborted: AtomicBool,
    pub paused: AtomicBool,
}

impl Control {
    pub fn new() -> Arc<Self> {
        Arc::new(Control::default())
    }
    pub fn aborted(&self) -> bool {
        self.aborted.load(Ordering::Relaxed)
    }
    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Termination {
    Completed,
    Time,
    Evals,
    Aborted,
    Error,
}

impl Termination {
    pub fn as_str(&self) -> &'static str {
        match self {
            Termination::Completed => "completed",
            Termination::Time => "time",
            Termination::Evals => "evals",
            Termination::Aborted => "aborted",
            Termination::Error => "error",
        }
    }
}

/// The outcome of one assessment.
#[derive(Clone, Debug)]
pub struct Eval {
    pub valid: bool,
    pub strict: bool,
    pub score: Option<f64>,
    pub container: Option<Container>,
    /// Sum of the penetrations of the pairs beyond the tolerance (0 when valid).
    pub penetration: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Budget {
    pub evals: Option<u64>,
    pub time_s: Option<f64>,
}

/// What a sub-run reports to its caller.
#[derive(Clone, Debug)]
pub struct SubRun {
    /// Best valid configuration the sub-run itself evaluated.
    pub found: Option<Config>,
    pub found_score: Option<f64>,
    /// Best of the whole run so far.
    pub best: Option<Config>,
    pub score: Option<f64>,
    pub valid: bool,
    pub evaluations: u64,
    pub termination: Termination,
}

struct Scope {
    eval_limit: f64,
    time_limit: f64,
    termination: Termination,
    found: Option<Config>,
    found_score: Option<f64>,
    start: Option<Config>,
    initial: Option<Eval>,
    params: Value,
    error: Option<String>,
}

/// The scratch of the assessments, reused between them.
struct Assessor {
    shape: Shape,
    grid: NeighborGrid,
    encloser: Encloser,
    poly: Option<PolygonEncloser>,
}

/// Everything a method sees of its run.
pub struct Ctx<'a> {
    pub problem: Problem,
    pub rng: Rng,
    control: &'a Control,
    clock: Clock,
    paused_total: f64,
    scopes: Vec<Scope>,
    pub evaluations: u64,
    best: Option<Config>,
    best_score: Option<f64>,
    best_strict: bool,
    best_container: Option<Container>,
    best_eval: Option<Eval>,
    closed: bool,
    assessor: Assessor,
    /// Cached clock reading and the number of stop polls since it was taken.
    now_cache: f64,
    polls: u32,
}

/// The result of a run.
#[derive(Clone, Debug)]
pub struct RunResult {
    pub best: Option<Config>,
    pub score: Option<f64>,
    pub valid: bool,
    pub strict: bool,
    pub container: Option<Container>,
    pub method: String,
    pub params: Value,
    pub seed: u32,
    pub wall_time: f64,
    pub evaluations: u64,
    pub termination: Termination,
    pub reasons: Vec<String>,
}

pub struct RunOptions<'a> {
    pub method: Method,
    pub params: Value,
    pub start: Option<Config>,
    pub budget: Budget,
    pub seed: u32,
    pub final_polish: bool,
    pub control: &'a Control,
    pub clock: ClockKind,
}

impl<'a> Ctx<'a> {
    fn new(problem: Problem, seed: u32, control: &'a Control, clock: ClockKind) -> Self {
        Ctx {
            problem,
            rng: Rng::new(seed),
            control,
            clock: Clock::new(clock),
            paused_total: 0.0,
            scopes: Vec::new(),
            evaluations: 0,
            best: None,
            best_score: None,
            best_strict: false,
            best_container: None,
            best_eval: None,
            closed: false,
            assessor: Assessor {
                shape: Shape::new(problem.n),
                grid: NeighborGrid::new(),
                encloser: Encloser::new(problem.n, problem.m),
                poly: if problem.m >= 3 { Some(PolygonEncloser::new(problem.m)) } else { None },
            },
            now_cache: 0.0,
            polls: 0,
        }
    }

    /// Active seconds of the run: pauses excluded.
    #[inline]
    pub fn active(&mut self) -> f64 {
        self.now_cache = self.clock.seconds() - self.paused_total;
        self.polls = 0;
        self.now_cache
    }

    /// Active seconds, re-reading the clock only every 32 polls (a stop check must be cheap).
    #[inline]
    fn active_cached(&mut self) -> f64 {
        self.polls += 1;
        if self.polls >= 32 {
            self.active()
        } else {
            self.now_cache
        }
    }

    fn scope(&self) -> &Scope {
        self.scopes.last().expect("no active scope")
    }

    /// The parameters of the running method (resolved, defaults filled in).
    pub fn params(&self) -> &Value {
        &self.scope().params
    }

    /// The start of the running method: the best so far, a supplied start, or a sub-run's start.
    pub fn start(&self) -> Option<&Config> {
        self.scope().start.as_ref()
    }

    /// The assessment of `start` the framework made.
    pub fn initial_evaluation(&self) -> Option<&Eval> {
        self.scope().initial.as_ref()
    }

    /// Whether the method must stop: aborted, a limit of this scope or of an enclosing one
    /// reached, or an error. Cheap: the clock is read every few calls only.
    #[inline]
    pub fn should_stop(&mut self) -> bool {
        if self.closed || self.control.aborted() {
            if let Some(s) = self.scopes.last_mut() {
                if s.termination == Termination::Completed {
                    s.termination = Termination::Aborted;
                }
            }
            return true;
        }
        let now = self.active_cached();
        self.scope_stop(now)
    }

    fn scope_stop(&mut self, now: f64) -> bool {
        let evaluations = self.evaluations as f64;
        let mut stop = None;
        for s in self.scopes.iter().rev() {
            if s.error.is_some() {
                stop = Some(Termination::Error);
                break;
            }
            if s.time_limit.is_finite() && now >= s.time_limit {
                stop = Some(Termination::Time);
                break;
            }
            if evaluations >= s.eval_limit {
                stop = Some(Termination::Evals);
                break;
            }
        }
        if let Some(t) = stop {
            if let Some(s) = self.scopes.last_mut() {
                if s.termination == Termination::Completed {
                    s.termination = t;
                }
            }
            return true;
        }
        false
    }

    /// A cooperative checkpoint: waits while paused (paused time is not charged), then answers
    /// whether the method may go on. Reads the clock.
    pub fn checkpoint(&mut self) -> bool {
        if self.control.paused() {
            let t0 = self.clock.seconds();
            while self.control.paused() && !self.control.aborted() {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            self.paused_total += self.clock.seconds() - t0;
        }
        if self.closed || self.control.aborted() {
            return !self.should_stop();
        }
        let now = self.active();
        !self.scope_stop(now)
    }

    /// Evaluations and active seconds still available to the running method.
    pub fn remaining(&mut self) -> (f64, f64) {
        let now = self.active();
        let mut evals = f64::INFINITY;
        let mut time = f64::INFINITY;
        for s in &self.scopes {
            evals = evals.min(s.eval_limit - self.evaluations as f64);
            time = time.min(s.time_limit - now);
        }
        (evals.max(0.0), time.max(0.0))
    }

    /// End the running method with an error (the reference's thrown error): its scope stops.
    pub fn fail(&mut self, message: impl Into<String>) {
        if let Some(s) = self.scopes.last_mut() {
            s.error = Some(message.into());
        }
    }

    /// The run's best so far (strict preferred).
    pub fn best(&self) -> Option<&Config> {
        self.best.as_ref()
    }

    pub fn best_score(&self) -> Option<f64> {
        self.best_score
    }

    /// One counted assessment with the server's rule; None when the method must stop (nothing
    /// is counted then). `auto_orient` also searches the container orientation.
    pub fn evaluate(&mut self, config: &Config, auto_orient: bool) -> Option<Eval> {
        if self.should_stop() || !self.checkpoint() {
            return None;
        }
        Some(self.assess(config, auto_orient))
    }

    /// Like `evaluate`; the reference keeps emitted configurations as starts of a next pipeline
    /// stage, which single runs never have.
    pub fn emit(&mut self, config: &Config) -> Option<Eval> {
        self.evaluate(config, true)
    }

    /// The assessment itself: counted, scored and offered to the best trackers.
    fn assess(&mut self, config: &Config, auto_orient: bool) -> Eval {
        self.evaluations += 1;
        let eval = self.score_config(config, auto_orient);
        if eval.valid {
            self.store(config, &eval);
        }
        eval
    }

    fn score_config(&mut self, config: &Config, auto_orient: bool) -> Eval {
        let invalid = Eval { valid: false, strict: false, score: None, container: None, penetration: 0.0 };
        let p = self.problem;
        if config.n != p.n || config.m != p.m || config.pieces.len() != p.p || !config.phi.is_finite() {
            return invalid;
        }
        for q in &config.pieces {
            if !(q.x.is_finite() && q.y.is_finite() && q.theta.is_finite()) || q.x.abs() > MAX_COORD || q.y.abs() > MAX_COORD {
                return invalid;
            }
        }
        let a = &mut self.assessor;
        let strict_tol = strict_tolerance(&config.pieces);
        let reach = 2.0 * bounding_radius(p.n);
        a.grid.build(&config.pieces, reach);
        let mut penetration = 0.0;
        let mut valid = true;
        let mut strict = true;
        let shape = a.shape;
        let pieces = &config.pieces;
        a.grid.for_each_pair(pieces, |i, j| {
            let sep = shape.sep(&pieces[i], &pieces[j]);
            if sep < -strict_tol {
                strict = false;
                if sep < -TOL {
                    valid = false;
                    penetration -= sep;
                }
            }
            true
        });
        let container = if auto_orient && p.m != 0 {
            let set = extreme_points(p.n, pieces, 1.0);
            let poly = a.poly.as_mut().unwrap();
            let mut c = poly.enclose(&set, config.phi);
            let best = auto_orient_set(&set, p.m, config.phi);
            if best.size < c.size {
                c = best;
            }
            c
        } else {
            a.encloser.enclose(pieces, config.phi)
        };
        Eval { valid, strict: valid && strict, score: Some(container.size), container: Some(container), penetration }
    }

    fn store(&mut self, config: &Config, eval: &Eval) {
        let score = eval.score.unwrap();
        let container = eval.container.unwrap();
        if let Some(s) = self.scopes.last_mut() {
            if s.found_score.map_or(true, |f| score < f) {
                let mut found = config.clone();
                found.phi = container.phi;
                s.found = Some(found);
                s.found_score = Some(score);
            }
        }
        let strict = eval.strict;
        let better = match self.best_score {
            None => true,
            Some(b) => (strict && !self.best_strict) || (strict == self.best_strict && score < b),
        };
        if better {
            self.best_strict = strict;
            let mut best = config.clone();
            best.phi = container.phi;
            self.best = Some(best);
            self.best_score = Some(score);
            self.best_container = Some(container);
            self.best_eval = Some(eval.clone());
        }
    }

    /// A child run of another method with shared counters, randomness and best: its start is
    /// `start`, else the run's best, else this method's start; its limits are this scope's,
    /// further capped by `evals` and `time_s`.
    pub fn run(&mut self, method: Method, params: &Value, start: Option<Config>, evals: Option<u64>, time_s: Option<f64>) -> SubRun {
        let resolved = match methods::resolve_params(method, params) {
            Ok(v) => v,
            Err(e) => {
                let _ = e;
                return SubRun {
                    found: None,
                    found_score: None,
                    best: self.best.clone(),
                    score: self.best_score,
                    valid: self.best.is_some(),
                    evaluations: 0,
                    termination: Termination::Error,
                };
            }
        };
        let child_start = start.or_else(|| self.best.clone()).or_else(|| self.scope().start.clone());
        let count0 = self.evaluations;
        let now = self.active();
        let parent_eval = self.scope().eval_limit;
        let parent_time = self.scope().time_limit;
        let eval_limit = parent_eval.min(self.evaluations as f64 + evals.map_or(f64::INFINITY, |e| e as f64));
        let time_limit = parent_time.min(now + time_s.unwrap_or(f64::INFINITY));
        let mut initial = None;
        if !self.should_stop() {
            if let Some(s) = &child_start {
                initial = Some(self.assess(s, true));
            }
        }
        let termination = self.execute(method, resolved, child_start, initial, eval_limit, time_limit);
        let child = self.scopes.pop().unwrap();
        let found = child.found.clone();
        let found_score = child.found_score;
        if let (Some(f), Some(fs)) = (&found, found_score) {
            let parent = self.scopes.last_mut().unwrap();
            if parent.found_score.map_or(true, |p| fs < p) {
                parent.found = Some(f.clone());
                parent.found_score = Some(fs);
            }
        }
        SubRun {
            found,
            found_score,
            best: self.best.clone(),
            score: self.best_score,
            valid: self.best.is_some(),
            evaluations: self.evaluations - count0,
            termination,
        }
    }

    /// Push a scope and run a method in it; the scope stays on the stack for the caller to pop.
    fn execute(&mut self, method: Method, params: Value, start: Option<Config>, initial: Option<Eval>, eval_limit: f64, time_limit: f64) -> Termination {
        let mut scope = Scope {
            eval_limit,
            time_limit,
            termination: Termination::Completed,
            found: None,
            found_score: None,
            start,
            initial,
            params,
            error: None,
        };
        // the start was scored before this scope existed; it counts as found by it
        if let (Some(s), Some(e)) = (&scope.start, &scope.initial) {
            if e.valid {
                let mut f = s.clone();
                f.phi = e.container.unwrap().phi;
                scope.found = Some(f);
                scope.found_score = e.score;
            }
        }
        self.scopes.push(scope);
        if !self.should_stop() {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| methods::execute(method, self)));
            if let Err(panic) = outcome {
                let message = panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "method failed".to_string());
                self.scopes.last_mut().unwrap().error = Some(message);
            }
        }
        let s = self.scopes.last_mut().unwrap();
        if s.error.is_some() {
            s.termination = Termination::Error;
        }
        s.termination
    }
}

/// Run a method on a problem: the start (if any) is assessed first, the method runs within the
/// budget, and unless `final_polish` is false or the method is polish, the contact polish runs
/// last on the best, with 10% of the budget kept for it. The best is finally turned to its best
/// container orientation (uncounted), so that its score is the server's at its stored phi.
pub fn run(problem: Problem, options: RunOptions) -> RunResult {
    let RunOptions { method, params, start, budget, seed, final_polish, control, clock } = options;
    let resolved = match methods::resolve_params(method, &params) {
        Ok(v) => v,
        Err(e) => {
            return RunResult {
                best: None,
                score: None,
                valid: false,
                strict: false,
                container: None,
                method: method.name().to_string(),
                params,
                seed,
                wall_time: 0.0,
                evaluations: 0,
                termination: Termination::Error,
                reasons: vec![e],
            }
        }
    };
    let mut ctx = Ctx::new(problem, seed, control, clock);
    let wall = std::time::Instant::now();
    let overall_time = budget.time_s.unwrap_or(f64::INFINITY);
    let overall_evals = budget.evals.map_or(f64::INFINITY, |e| e as f64);
    let append_polish = final_polish && method != Method::Polish;
    let start = start.filter(|s| s.n == problem.n && s.m == problem.m && s.pieces.len() == problem.p);
    // the start is assessed even when already aborted or out of time
    let initial = start.as_ref().map(|s| ctx.assess(s, true));
    let remaining_after_start = (overall_evals - ctx.evaluations as f64).max(0.0);
    let reserve_evals = if append_polish && overall_evals.is_finite() {
        remaining_after_start.min((overall_evals / 10.0).ceil())
    } else {
        0.0
    };
    let reserve_time = if append_polish && overall_time.is_finite() { overall_time / 10.0 } else { 0.0 };
    let mut stages: Vec<(Method, Value)> = vec![(method, resolved.clone())];
    if append_polish {
        stages.push((Method::Polish, methods::resolve_params(Method::Polish, &Value::Null).unwrap()));
    }
    let mut termination = Termination::Completed;
    let mut stage_start = start.clone();
    for (i, (m, p)) in stages.into_iter().enumerate() {
        let before_final = append_polish && i == 0;
        let eval_cap = if before_final { overall_evals - reserve_evals } else { overall_evals };
        let time_cap = if before_final { overall_time - reserve_time } else { overall_time };
        let s = ctx.best.clone().or(stage_start.clone());
        let init = ctx.best_eval.clone().or(if i == 0 { initial.clone() } else { None });
        let t = ctx.execute(m, p, s.clone(), init, eval_cap, time_cap);
        ctx.scopes.pop();
        stage_start = ctx.best.clone().or(s);
        if t == Termination::Error || t == Termination::Aborted {
            termination = t;
            break;
        }
        if t != Termination::Completed {
            termination = t;
        }
    }
    ctx.closed = true;
    // the final orientation is outside the counted budget
    if let Some(best) = ctx.best.clone() {
        let eval = ctx.score_config(&best, true);
        if eval.valid {
            let c = eval.container.unwrap();
            let mut b = best;
            b.phi = c.phi;
            ctx.best = Some(b);
            ctx.best_score = eval.score;
            ctx.best_container = Some(c);
        }
    }
    let mut reasons = Vec::new();
    if ctx.best.is_none() {
        reasons.push("no valid configuration evaluated".to_string());
    } else if !ctx.best_strict {
        reasons.push("best configuration relies on the validity tolerance (penetration above 1e-12)".to_string());
    }
    RunResult {
        valid: ctx.best.is_some(),
        strict: ctx.best.is_some() && ctx.best_strict,
        best: ctx.best,
        score: ctx.best_score,
        container: ctx.best_container,
        method: method.name().to_string(),
        params: resolved,
        seed,
        wall_time: wall.elapsed().as_secs_f64(),
        evaluations: ctx.evaluations,
        termination,
        reasons,
    }
}

/// A helper for methods: the configuration of the problem with these poses at phi.
pub fn config_of(problem: Problem, pieces: &[Pose], phi: f64) -> Config {
    Config { n: problem.n, m: problem.m, pieces: pieces.to_vec(), phi }
}
