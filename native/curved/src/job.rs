//! One search job on a curved problem (the curved case of packages/spaces/src/search/run.ts):
//! rounds of one start and up to 8 hops, each round seeded from the job's seed and started from
//! the best so far, until the evaluation budget (restarts plus hops) or the CPU-time budget is
//! spent or the stop flag is set. Every kept result passes the server's rule (check_config with
//! the job's rule); the start, when it passes, is a candidate too, so a job never returns worse
//! than what it was given.
//!
//! Reproducibility: the same problem, start, seed and evaluation budget give the same result on
//! every platform, as long as the time budget and the stop flag do not end the job first (time is
//! only read to stop). Unlike the reference, rounds have no wall-clock limit of their own.

use crate::polish::PolishOptions;
use crate::problem::{CurvedConfig, CurvedProblem, Space};
use crate::rng::{mix_seed, seed32};
use crate::search::{SearchOptions, Searcher};
use crate::shapes::side_from_apothem;
use crate::validate::{check_config, Rule};
use std::sync::atomic::{AtomicBool, Ordering};

/// What a job may spend. Both limits apply; None is no limit.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Budget {
    /// Restarts plus hops (the reference's evaluation unit for curved jobs).
    pub evals: Option<u64>,
    /// CPU seconds of the job (pauses excluded), read from the job's clock.
    pub cpu_seconds: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Termination {
    /// The evaluation budget was spent.
    Evals,
    /// The time budget was spent.
    Time,
    /// The stop flag was set.
    Aborted,
    /// The search ended by itself (no feasible start, or no work left).
    Done,
    /// The problem or the start could not be used.
    Error,
}

#[derive(Clone, Debug)]
pub struct JobOutcome {
    /// The best configuration that passes the job's rule, if any.
    pub config: Option<CurvedConfig>,
    /// Its size (the score).
    pub score: Option<f64>,
    /// Restarts plus hops done.
    pub evaluations: u64,
    /// Seconds of the job's clock (CPU time of the thread by default), pauses excluded.
    pub seconds: f64,
    pub termination: Termination,
    pub reasons: Vec<String>,
    /// Rounds run and work counters (energy minimisations, polishes, LP pivots).
    pub rounds: u64,
    pub repairs: u64,
    pub polishes: u64,
    pub lp_pivots: u64,
}

/// Options beyond the budget.
pub struct JobOptions<'a> {
    /// The server's rule for results: bound, certified size, no research record. Results are
    /// checked by it (erring strict); the default checks validity at 1e-9 only.
    pub rule: Rule,
    /// While set, the job blocks in its next poll (CPU time does not advance while blocked).
    pub paused: Option<&'a AtomicBool>,
    /// The job's clock in seconds; default: CPU time of the calling thread.
    pub clock: Option<&'a dyn Fn() -> f64>,
    /// L-BFGS iterations per energy minimisation; default as the reference: 150 above 12 pieces, else 400.
    pub lbfgs_iter: Option<usize>,
    /// Hops per round (default 8, as the reference).
    pub hops_per_round: usize,
}

impl Default for JobOptions<'_> {
    fn default() -> Self {
        JobOptions {
            rule: Rule::default(),
            paused: None,
            clock: None,
            lbfgs_iter: None,
            hops_per_round: 8,
        }
    }
}

/// CPU seconds of the calling thread (a monotonic wall clock where the platform has no thread clock).
pub fn thread_cpu_seconds() -> f64 {
    #[cfg(unix)]
    {
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: clock_gettime writes the timespec it is given
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
        if rc == 0 {
            return ts.tv_sec as f64 + ts.tv_nsec as f64 * 1e-9;
        }
    }
    use std::sync::OnceLock;
    use std::time::Instant;
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_secs_f64()
}

/// Time and stop checks of one job.
struct Gate<'a> {
    stop: &'a AtomicBool,
    paused: Option<&'a AtomicBool>,
    clock: &'a dyn Fn() -> f64,
    limit: f64,
    active: f64,
    last: f64,
    why: Option<Termination>,
}

impl<'a> Gate<'a> {
    fn new(stop: &'a AtomicBool, paused: Option<&'a AtomicBool>, clock: &'a dyn Fn() -> f64, limit: f64) -> Gate<'a> {
        let last = clock();
        Gate {
            stop,
            paused,
            clock,
            limit,
            active: 0.0,
            last,
            why: None,
        }
    }

    fn account(&mut self) {
        let t = (self.clock)();
        self.active += (t - self.last).max(0.0);
        self.last = t;
    }

    /// True once the job must end (and from then on); blocks while paused.
    fn stop(&mut self) -> bool {
        if self.why == Some(Termination::Aborted) {
            return true;
        }
        if self.stop.load(Ordering::Relaxed) {
            self.why = Some(Termination::Aborted);
            return true;
        }
        if let Some(p) = self.paused {
            if p.load(Ordering::Relaxed) {
                self.account();
                while p.load(Ordering::Relaxed) && !self.stop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                // the pause is not active time
                self.last = (self.clock)();
                if self.stop.load(Ordering::Relaxed) {
                    self.why = Some(Termination::Aborted);
                    return true;
                }
            }
        }
        self.account();
        if self.active >= self.limit {
            self.why.get_or_insert(Termination::Time);
            return true;
        }
        false
    }
}

/// Runs one job: `start` None is a fresh job (the search builds its own starts), Some an iterate
/// job from that configuration (repaired when it is not feasible). Never panics on bad input:
/// failures are outcomes with termination Error.
pub fn run_job(
    problem: &CurvedProblem,
    start: Option<&CurvedConfig>,
    budget: Budget,
    seed: u64,
    stop: &AtomicBool,
) -> JobOutcome {
    run_job_with(problem, start, budget, seed, stop, &JobOptions::default())
}

pub fn run_job_with(
    problem: &CurvedProblem,
    start: Option<&CurvedConfig>,
    budget: Budget,
    seed: u64,
    stop: &AtomicBool,
    opts: &JobOptions,
) -> JobOutcome {
    let default_clock = thread_cpu_seconds;
    let clock: &dyn Fn() -> f64 = opts.clock.unwrap_or(&default_clock);
    let limit = budget.cpu_seconds.map_or(f64::INFINITY, |s| s.max(0.0));
    let mut gate = Gate::new(stop, opts.paused, clock, limit);
    let mut out = JobOutcome {
        config: None,
        score: None,
        evaluations: 0,
        seconds: 0.0,
        termination: Termination::Done,
        reasons: vec![],
        rounds: 0,
        repairs: 0,
        polishes: 0,
        lp_pivots: 0,
    };
    let fail = |mut out: JobOutcome, gate: &mut Gate, reason: String| {
        gate.account();
        out.seconds = gate.active;
        out.termination = Termination::Error;
        out.reasons = vec![reason];
        out
    };
    let space = match Space::of(problem) {
        Ok(s) => s,
        Err(e) => return fail(out, &mut gate, e),
    };
    if !problem.exists() {
        return fail(
            out,
            &mut gate,
            format!("no container below the admissible limit holds {} pieces", problem.p),
        );
    }
    let p = problem.p as usize;
    if let Some(s) = start {
        if s.pieces.len() != p || !s.is_finite() {
            return fail(
                out,
                &mut gate,
                "the start is not a configuration of this problem".into(),
            );
        }
    }
    let rule = opts.rule;
    // the best configuration that passes the rule: the start, then the rounds' results
    let mut best: Option<(CurvedConfig, f64)> = None;
    if let Some(s) = start {
        if check_config(problem, s, &rule).valid {
            best = Some((s.clone(), s.size));
        }
    }
    // the next round's start: the best so far, or the given start while nothing passes
    let mut warm: Option<(Vec<f64>, f64)> = start.map(|s| (s.to_vector(), s.size));
    let cap = budget.evals.unwrap_or(u64::MAX);
    let seed = seed32(seed);
    let iters = opts.lbfgs_iter.unwrap_or(if p > 12 { 150 } else { 400 });
    let mut searcher = Searcher::new(&space, p);
    let mut done = 0u64;
    let mut round = 0u64;
    let mut ran = Termination::Done;
    {
        let mut stop_fn = || gate.stop();
        while done < cap && !stop_fn() {
            let hops = (opts.hops_per_round as u64).min(cap.saturating_sub(done).saturating_sub(1)) as usize;
            let sopts = SearchOptions {
                seed: mix_seed(seed, round as u32),
                restarts: 1,
                hops,
                start: warm.as_ref().map(|(z, s)| (z.as_slice(), *s)),
                lbfgs_iter: iters,
            };
            let r = searcher.search(&sopts, &mut stop_fn);
            done += (r.restarts_done + r.hops_done) as u64;
            round += 1;
            if let Some(pol) = r.best {
                let size = side_from_apothem(problem.m, problem.k, pol.t);
                let mut cfg = CurvedConfig::from_vector(size, &pol.z);
                let mut ok = check_config(problem, &cfg, &rule).valid;
                if !ok {
                    // valid only within the rounding allowance or the strict tolerance: polish with
                    // a small clearance and check again
                    for margin in [2e-11, 2e-10, 2e-9] {
                        let pr = searcher.polisher.polish(
                            &mut searcher.ev,
                            &pol.z,
                            None,
                            &PolishOptions {
                                margin,
                                max_iter: 60,
                                ..PolishOptions::default()
                            },
                            &mut stop_fn,
                        );
                        if !(pr.t < searcher.ev.t_max) {
                            continue;
                        }
                        let c2 = CurvedConfig::from_vector(pr.size, &pr.z);
                        if check_config(problem, &c2, &rule).valid {
                            cfg = c2;
                            ok = true;
                            break;
                        }
                    }
                }
                if ok && best.as_ref().is_none_or(|(_, s)| cfg.size < *s) {
                    warm = Some((cfg.to_vector(), cfg.size));
                    best = Some((cfg.clone(), cfg.size));
                }
            }
            if r.restarts_done + r.hops_done == 0 {
                break;
            }
        }
        if done >= cap {
            ran = Termination::Evals;
        }
    }
    gate.account();
    out.seconds = gate.active;
    out.evaluations = done;
    out.rounds = round;
    out.repairs = searcher.repairs;
    out.polishes = searcher.polishes;
    out.lp_pivots = searcher.polisher.lp_pivots();
    out.termination = gate.why.unwrap_or(ran);
    match best {
        Some((c, s)) => {
            out.config = Some(c);
            out.score = Some(s);
        }
        None => out.reasons = vec!["no valid configuration found".into()],
    }
    out
}
