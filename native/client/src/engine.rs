//! The search engine of one problem (apps/volunteer/src/engine/search.ts and policy.ts): which
//! jobs to run (method, parameters, seed, budget, start), on how many lanes, and when the problem
//! is done.
//!
//! 1. Arms. An arm is a method with its parameters on one kind of start: "fresh" (none), "warm"
//!    (the known packing) or "iterate" (the engine's best when the job starts).
//! 2. Exploration round. Each arm runs once at the base budget T0, in the order of its family's
//!    memory; an iterate arm waits for a packing.
//! 3. Bandit. Thompson sampling: each eligible arm draws theta from its Beta posterior and the arm
//!    with the largest theta per expected second of its next job runs. A finished job pulls its
//!    arm's posterior toward the prior by `DISCOUNT`, then adds its reward r in [0, 1] (the
//!    relative improvement of the best on a log scale) to alpha and 1 - r to beta.
//! 4. Budgets. An arm's jobs get T0 * 2^level seconds up to the cap; the level rises after a job
//!    at that level improves the best, and after every two that do not (the doubling trick). Every
//!    job also gets an evaluation cap, 0.8 of what its time buys at the method's measured rate, so
//!    that most jobs end on evaluations and are reproducible.
//! 5. Stopping. No job starts when aborted, at the area bound, when less than T0/2 is left before
//!    the polish reserve, or after no progress for max(floor, elapsed / 2) seconds.
//! 6. Final polish of the best, for at most the time left and 60 s.
//! 7. Memory: each arm's share of the reward and each method's evaluation rate.

use crate::memory::{arm_credit, arm_prior, Memory};
use polypack_flat::clock::ClockKind;
use polypack_flat::rng::{beta_sample, mix_seed, Rng};
use polypack_flat::shapes::{Config, Problem};
use polypack_flat::{run, Budget, Control, Method, RunOptions};
use serde_json::{json, Value};
use std::sync::mpsc;
use std::sync::Arc;

/// One run of a method that the engine asks for.
#[derive(Clone, Debug)]
pub struct Job {
    pub problem: Problem,
    pub method: Method,
    pub params: Value,
    pub seed: u32,
    pub time_s: f64,
    pub evals: Option<u64>,
    pub start: Option<Config>,
    pub final_polish: bool,
    /// "fresh", "warm", "iterate" or "polish".
    pub kind: &'static str,
}

#[derive(Clone, Debug)]
pub struct JobResult {
    pub job: Job,
    pub score: Option<f64>,
    pub valid: bool,
    pub strict: bool,
    pub best: Option<Config>,
    /// The method's resolved parameters.
    pub params: Value,
    pub evaluations: u64,
    #[allow(dead_code)]
    pub wall_time: f64,
    pub termination: String,
}

/// A packing the engine found, with what produced it.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub config: Config,
    pub score: f64,
    pub strict: bool,
    pub job: Job,
    pub params: Value,
}

/// Runs one job to its end (or until `control` aborts it).
pub fn run_job(job: Job, control: &Control, clock: ClockKind) -> JobResult {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run(
            job.problem,
            RunOptions {
                method: job.method,
                params: job.params.clone(),
                start: job.start.clone(),
                budget: Budget { evals: job.evals, time_s: Some(job.time_s) },
                seed: job.seed,
                final_polish: job.final_polish,
                control,
                clock,
            },
        )
    }));
    match outcome {
        Ok(r) => JobResult {
            score: r.score,
            valid: r.valid,
            strict: r.strict,
            best: if r.valid { r.best } else { None },
            params: r.params,
            evaluations: r.evaluations,
            wall_time: r.wall_time,
            termination: r.termination.as_str().to_string(),
            job,
        },
        Err(_) => JobResult {
            score: None,
            valid: false,
            strict: false,
            best: None,
            params: Value::Null,
            evaluations: 0,
            wall_time: 0.0,
            termination: "error".into(),
            job,
        },
    }
}

/// Where jobs run: threads (one per job) or inline on the caller's thread.
pub trait Runner {
    fn launch(&mut self, id: usize, job: Job);
    fn wait(&mut self) -> (usize, JobResult);
}

/// One thread per job; results come back over a channel.
pub struct ThreadRunner {
    control: Arc<Control>,
    clock: ClockKind,
    low_priority: bool,
    tx: mpsc::Sender<(usize, JobResult)>,
    rx: mpsc::Receiver<(usize, JobResult)>,
}

impl ThreadRunner {
    pub fn new(control: Arc<Control>, clock: ClockKind, low_priority: bool) -> Self {
        let (tx, rx) = mpsc::channel();
        ThreadRunner { control, clock, low_priority, tx, rx }
    }
}

impl Runner for ThreadRunner {
    fn launch(&mut self, id: usize, job: Job) {
        let tx = self.tx.clone();
        let control = self.control.clone();
        let clock = self.clock;
        let low = self.low_priority;
        std::thread::Builder::new()
            .name(format!("search-{id}"))
            .spawn(move || {
                if low {
                    crate::platform::lower_thread_priority();
                }
                let result = run_job(job, &control, clock);
                let _ = tx.send((id, result));
            })
            .expect("cannot start a search thread");
    }

    fn wait(&mut self) -> (usize, JobResult) {
        self.rx.recv().expect("search threads lost")
    }
}

/// Jobs run on the caller's thread, one at a time (benchmarks: the thread's CPU clock then
/// measures everything).
pub struct InlineRunner {
    control: Arc<Control>,
    clock: ClockKind,
    done: std::collections::VecDeque<(usize, JobResult)>,
}

impl InlineRunner {
    pub fn new(control: Arc<Control>, clock: ClockKind) -> Self {
        InlineRunner { control, clock, done: Default::default() }
    }
}

impl Runner for InlineRunner {
    fn launch(&mut self, id: usize, job: Job) {
        let r = run_job(job, &self.control, self.clock);
        self.done.push_back((id, r));
    }
    fn wait(&mut self) -> (usize, JobResult) {
        self.done.pop_front().expect("no job in flight")
    }
}

// ---------------------------------------------------------------------------------------------
// Policy

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    Fresh,
    Warm,
    Iterate,
}

impl Start {
    pub fn as_str(&self) -> &'static str {
        match self {
            Start::Fresh => "fresh",
            Start::Warm => "warm",
            Start::Iterate => "iterate",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ParamsKind {
    None,
    Rigid,
    RigidNoise,
    MorphFamily,
}

#[derive(Clone, Debug)]
pub struct Arm {
    pub key: String,
    pub method: Method,
    pub start: Start,
    params: ParamsKind,
}

struct Recipe {
    name: &'static str,
    method: Method,
    starts: &'static [Start],
    params: ParamsKind,
    when: fn(&Problem) -> bool,
}

/// The arms. Constructors run from scratch; improvers start from the known packing or the
/// engine's own best. `seed`, `penalty` and `polish` run inside these methods and are not arms;
/// `mc_compress` is left out as dominated by `asc` (docs/methods).
fn recipes() -> Vec<Recipe> {
    use Start::*;
    vec![
        Recipe { name: "harden", method: Method::Harden, starts: &[Fresh], params: ParamsKind::None, when: |_| true },
        Recipe { name: "shrink_repair", method: Method::ShrinkRepair, starts: &[Fresh, Warm, Iterate], params: ParamsKind::None, when: |_| true },
        // the reference's control path: better than the harden path on triangles, the same for disks
        Recipe { name: "harden-rigid", method: Method::Harden, starts: &[Fresh], params: ParamsKind::Rigid, when: |p| p.n != 0 },
        // to refine an existing packing: the rigid path with a small noise (harden.md)
        Recipe { name: "harden-refine", method: Method::Harden, starts: &[Warm, Iterate], params: ParamsKind::RigidNoise, when: |_| true },
        Recipe { name: "asc", method: Method::Asc, starts: &[Fresh, Warm, Iterate], params: ParamsKind::None, when: |_| true },
        Recipe { name: "basin_hopping", method: Method::BasinHopping, starts: &[Fresh, Warm, Iterate], params: ParamsKind::None, when: |_| true },
        // neither shape family is better in general (morph.md): each job draws one
        Recipe { name: "morph", method: Method::Morph, starts: &[Fresh, Warm, Iterate], params: ParamsKind::MorphFamily, when: |_| true },
        Recipe { name: "ls_growth", method: Method::LsGrowth, starts: &[Fresh], params: ParamsKind::None, when: |p| p.n == 0 },
    ]
}

/// The arms that apply to a problem (and that this build implements), recipe by recipe.
pub fn arms_for(problem: &Problem) -> Vec<Arm> {
    let mut arms = Vec::new();
    for r in recipes() {
        if !(r.when)(problem) || !r.method.available() {
            continue;
        }
        for &start in r.starts {
            arms.push(Arm { key: format!("{}:{}", start.as_str(), r.name), method: r.method, start, params: r.params });
        }
    }
    arms
}

fn arm_params(kind: ParamsKind, rng: &mut Rng) -> Value {
    match kind {
        ParamsKind::None => Value::Null,
        ParamsKind::Rigid => json!({ "path": "rigid" }),
        ParamsKind::RigidNoise => json!({ "path": "rigid", "noise": 1 }),
        ParamsKind::MorphFamily => json!({ "family": if rng.next() < 0.5 { "inscribed" } else { "circumscribed" } }),
    }
}

pub mod policy {
    /// Prior cost of one counted evaluation per piece, in seconds.
    pub const SECONDS_PER_EVALUATION_PER_PIECE: f64 = 1.5e-4;
    pub const BASE_EVALUATIONS: f64 = 1500.0;
    pub const BASE_MIN_SECONDS: f64 = 4.0;
    pub const BASE_MAX_SECONDS: f64 = 120.0;
    pub const EXPLORATION_SHARE: f64 = 0.25;
    pub const CAP_SHARE: f64 = 1.0 / 6.0;
    pub const CAP_MAX_SECONDS: f64 = 900.0;
    pub const EVALUATION_FILL: f64 = 0.8;
    pub const MIN_EVALUATIONS: f64 = 64.0;
    pub const MISSES_PER_LEVEL: u32 = 2;
    pub const DISCOUNT: f64 = 0.9;
    pub const ERROR_LIMIT: u32 = 3;
    pub const MIN_IMPROVEMENT: f64 = 1e-9;
    pub const STAGNATION_SHARE: f64 = 0.5;
    pub const FAIR_SHARE: f64 = 0.25;
    pub const STAGNATION_FLOOR_BASES: f64 = 4.0;
    pub const APPROACH_GAP: f64 = 0.01;
    pub const POLISH_SHARE: f64 = 0.02;
    pub const POLISH_MIN_SECONDS: f64 = 2.0;
    pub const POLISH_MAX_SECONDS: f64 = 60.0;
    pub const POLISH_EVALUATIONS: u64 = 10_000;
    pub const MAX_JOBS: usize = 100_000;
}

#[derive(Clone, Copy, Debug)]
pub struct Plan {
    pub base: f64,
    pub cap: f64,
    pub max_level: u32,
    pub polish_reserve: f64,
    pub stagnation_floor: f64,
    pub min_job: f64,
}

pub fn make_plan(max_seconds: f64, lanes: usize, arms: usize, evaluations_per_second: f64) -> Plan {
    use policy::*;
    let t = max_seconds.max(0.0);
    let polish_reserve = (POLISH_SHARE * t).clamp(POLISH_MIN_SECONDS, POLISH_MAX_SECONDS).min(t / 4.0);
    let by_size = (BASE_EVALUATIONS / evaluations_per_second).clamp(BASE_MIN_SECONDS, BASE_MAX_SECONDS);
    let by_share = EXPLORATION_SHARE * t * lanes as f64 / arms.max(1) as f64;
    let base = 0.5f64.max(by_size.min(by_share));
    let cap = base.max((CAP_SHARE * t).min(CAP_MAX_SECONDS));
    let max_level = ((cap / base).log2() + 1e-9).floor().max(0.0) as u32;
    let floor = (STAGNATION_FLOOR_BASES * base).max(FAIR_SHARE * t);
    Plan { base, cap, max_level, polish_reserve, stagnation_floor: t.min(floor), min_job: base / 2.0 }
}

pub fn level_seconds(plan: &Plan, level: u32) -> f64 {
    plan.cap.min(plan.base * 2f64.powi(level as i32))
}

/// Reward of a job: 0 unless it improved the score to beat by more than 1e-9 relative; then a log
/// scale from 0.1 (about 1e-9) through 0.5 (1e-6) to 1 (1e-3 and more).
pub fn reward(before: f64, after: f64) -> f64 {
    if !before.is_finite() || !(before > 0.0) || !(after < before) {
        return 0.0;
    }
    let gain = (before - after) / before;
    if gain <= policy::MIN_IMPROVEMENT {
        return 0.0;
    }
    ((gain.log10() + 9.0) / 6.0).clamp(0.1, 1.0)
}

/// The family a problem's memory is kept under: piece and container shape (circles "c", 3 to 8
/// sides exactly, 9 or more together) and a P bucket.
pub fn family_key(p: &Problem) -> String {
    let shape = |s: u32| if s == 0 { "c".to_string() } else if s <= 8 { s.to_string() } else { "9+".to_string() };
    let bucket = match p.p {
        0..=9 => 1,
        10..=19 => 10,
        20..=49 => 20,
        50..=99 => 50,
        100..=199 => 100,
        200..=499 => 200,
        _ => 500,
    };
    format!("{}/{}/{}", shape(p.n), shape(p.m), bucket)
}

// ---------------------------------------------------------------------------------------------
// The search

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    Time,
    Stagnation,
    Aborted,
    Bound,
}

impl Stop {
    pub fn as_str(&self) -> &'static str {
        match self {
            Stop::Time => "time",
            Stop::Stagnation => "stagnation",
            Stop::Aborted => "aborted",
            Stop::Bound => "bound",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Known {
    pub config: Config,
    pub score: f64,
}

pub struct SearchInput<'a> {
    pub problem: Problem,
    pub known: Option<Known>,
    pub area_bound: f64,
    pub max_seconds: f64,
    pub lanes: usize,
    pub seed: u32,
    pub memory: Memory,
    /// Active seconds, monotonic (frozen while paused).
    pub now: &'a dyn Fn() -> f64,
    pub control: Arc<Control>,
    /// Called after every job, for the host's log.
    pub on_result: &'a mut dyn FnMut(&JobResult, Option<&Candidate>),
    /// The host's memory as it stands when the search ends (other searches may have changed it).
    pub memory_now: &'a dyn Fn() -> Memory,
}

pub struct SearchOutcome {
    pub best: Option<Candidate>,
    pub jobs: usize,
    pub stopped: Stop,
    pub memory: Memory,
    pub evaluations: u64,
}

struct ArmState {
    arm: Arm,
    prior: (f64, f64),
    alpha: f64,
    beta: f64,
    level: u32,
    misses: u32,
    errors: u32,
    disabled: bool,
    explored: bool,
    jobs: u32,
    rewards: f64,
    planned: f64,
    spent: f64,
}

struct Flight {
    job: Job,
    state: Option<usize>,
    level: u32,
    from_known: bool,
    started_at: f64,
}

struct Rate {
    method: Method,
    evaluations: f64,
    seconds: f64,
    prior: f64,
}

pub fn search(input: SearchInput, runner: &mut dyn Runner) -> SearchOutcome {
    let SearchInput { problem, known, area_bound, max_seconds, lanes, seed, memory, now, control, on_result, memory_now } = input;
    let lanes = lanes.max(1);
    let max_seconds = if max_seconds.is_finite() { max_seconds.max(0.0) } else { 0.0 };
    let mut random = Rng::new(mix_seed(seed, 0xffffffff));
    let family = family_key(&problem);
    let fam = memory.family(&family).cloned();
    let known = known.filter(|k| k.config.pieces.len() == problem.p).map(|k| Known { score: if k.score.is_finite() && k.score > 0.0 { k.score } else { f64::INFINITY }, ..k });
    let arms: Vec<Arm> = arms_for(&problem).into_iter().filter(|a| a.start != Start::Warm || known.is_some()).collect();
    let mut states: Vec<ArmState> = arms
        .into_iter()
        .map(|arm| {
            let prior = arm_prior(fam.as_ref(), &arm.key);
            ArmState { arm, prior, alpha: prior.0, beta: prior.1, level: 0, misses: 0, errors: 0, disabled: false, explored: false, jobs: 0, rewards: 0.0, planned: 0.0, spent: 0.0 }
        })
        .collect();
    // exploration order: the family's best arms first (stable: arms without a record keep their order)
    let mut order: Vec<usize> = (0..states.len()).collect();
    order.sort_by(|&a, &b| {
        let ca = arm_credit(fam.as_ref(), &states[a].arm.key).unwrap_or(-1.0);
        let cb = arm_credit(fam.as_ref(), &states[b].arm.key).unwrap_or(-1.0);
        cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal)
    });
    let p = problem.p as f64;
    let generic = 1.0 / (policy::SECONDS_PER_EVALUATION_PER_PIECE * p);
    let remembered: Vec<(String, f64)> = fam.as_ref().map_or(Vec::new(), |f| f.rates.iter().map(|(m, r)| (m.clone(), r / p)).collect());
    let mut rates: Vec<Rate> = Vec::new();
    for s in &states {
        if !rates.iter().any(|r| r.method == s.arm.method) {
            rates.push(Rate { method: s.arm.method, evaluations: 0.0, seconds: 0.0, prior: generic });
        }
    }
    for (m, r) in &remembered {
        if let Some(t) = rates.iter_mut().find(|x| x.method.name() == m) {
            t.prior = *r;
        }
    }
    let typical = if remembered.is_empty() { generic } else { (remembered.iter().map(|(_, r)| r.ln()).sum::<f64>() / remembered.len() as f64).exp() };
    let plan = make_plan(max_seconds, lanes, states.len(), typical);
    let t0 = now();
    let elapsed = || now() - t0;

    let mut flights: Vec<Option<Flight>> = Vec::new();
    let mut in_flight = 0usize;
    let mut best: Option<Candidate> = None;
    let mut fallback: Option<(Config, f64)> = None;
    let mut best_from_known = false;
    let mut fallback_from_known = false;
    let mut own_best = f64::INFINITY;
    let mut last_beaten = 0.0f64;
    let mut last_own = 0.0f64;
    let mut jobs = 0usize;
    let mut evaluations = 0u64;
    let mut stop = Stop::Time;

    let rate_of = |rates: &[Rate], m: Method| -> f64 {
        match rates.iter().find(|r| r.method == m) {
            Some(t) => (t.evaluations + t.prior) / (t.seconds + 1.0),
            None => 1.0 / (policy::SECONDS_PER_EVALUATION_PER_PIECE * p),
        }
    };

    macro_rules! start_for {
        ($arm:expr) => {
            match $arm.start {
                Start::Warm => known.as_ref().map(|k| k.config.clone()),
                Start::Iterate => best.as_ref().map(|b| b.config.clone()).or_else(|| fallback.as_ref().map(|f| f.0.clone())),
                Start::Fresh => None,
            }
        };
    }
    let eligible = |s: &ArmState, best: &Option<Candidate>, fallback: &Option<(Config, f64)>| -> bool {
        !s.disabled
            && match s.arm.start {
                Start::Fresh => true,
                Start::Warm => known.is_some(),
                Start::Iterate => best.is_some() || fallback.is_some(),
            }
    };

    loop {
        while in_flight < lanes {
            // decide
            if control.aborted() {
                stop = Stop::Aborted;
                break;
            }
            if let Some(b) = &best {
                if area_bound > 0.0 && b.score <= area_bound * (1.0 + policy::MIN_IMPROVEMENT) {
                    stop = Stop::Bound;
                    break;
                }
            }
            if jobs >= policy::MAX_JOBS {
                stop = Stop::Stagnation;
                break;
            }
            let t = elapsed();
            let available = max_seconds - plan.polish_reserve - t;
            if available < plan.min_job {
                stop = Stop::Time;
                break;
            }
            // the last progress: the score to beat improved, or the own line did while it counts
            let target = best.as_ref().map_or(f64::INFINITY, |b| b.score).min(known.as_ref().map_or(f64::INFINITY, |k| k.score));
            let counts = t < plan.stagnation_floor || own_best <= target * (1.0 + policy::APPROACH_GAP);
            let last = if counts { last_beaten.max(last_own) } else { last_beaten };
            if t - last >= plan.stagnation_floor.max(policy::STAGNATION_SHARE * t) {
                stop = Stop::Stagnation;
                break;
            }
            let mut chosen = order.iter().copied().find(|&i| !states[i].explored && eligible(&states[i], &best, &fallback));
            if chosen.is_none() {
                // Thompson sampling over the eligible arms, per expected second
                let mut top = f64::NEG_INFINITY;
                for i in 0..states.len() {
                    if !eligible(&states[i], &best, &fallback) {
                        continue;
                    }
                    let s = &states[i];
                    let theta = beta_sample(&mut random, s.alpha, s.beta);
                    let share = ((s.spent + plan.base) / (s.planned + plan.base)).clamp(0.1, 1.0);
                    let value = theta / (level_seconds(&plan, s.level).min(available) * share);
                    if value > top {
                        top = value;
                        chosen = Some(i);
                    }
                }
            }
            let Some(i) = chosen else {
                // every arm failed for good
                stop = Stop::Stagnation;
                break;
            };
            states[i].explored = true;
            let seconds = level_seconds(&plan, states[i].level).min(available);
            let wanted = (rate_of(&rates, states[i].arm.method) * seconds * policy::EVALUATION_FILL).floor();
            let evals = 1e9f64.min(policy::MIN_EVALUATIONS.max(if wanted.is_finite() { wanted } else { 0.0 })) as u64;
            let params = arm_params(states[i].arm.params, &mut random);
            let start = start_for!(states[i].arm);
            let from_known = match states[i].arm.start {
                Start::Warm => true,
                Start::Iterate => if best.is_some() { best_from_known } else { fallback_from_known },
                Start::Fresh => false,
            };
            let job = Job {
                problem,
                method: states[i].arm.method,
                params,
                seed: mix_seed(seed, jobs as u32),
                time_s: seconds,
                evals: Some(evals),
                start,
                final_polish: true,
                kind: states[i].arm.start.as_str(),
            };
            let id = jobs;
            jobs += 1;
            flights.push(Some(Flight { job: job.clone(), state: Some(i), level: states[i].level, from_known, started_at: elapsed() }));
            in_flight += 1;
            runner.launch(id, job);
        }
        if in_flight == 0 {
            break;
        }
        let (id, result) = runner.wait();
        let flight = flights[id].take().expect("unknown job");
        in_flight -= 1;
        evaluations += result.evaluations;
        // absorb: the best, the arm's posterior and level, the method's rate
        let t = elapsed();
        let seconds = (t - flight.started_at).max(0.0);
        let mut gain = 0.0;
        if result.valid {
            if let (Some(config), Some(score)) = (&result.best, result.score) {
                if score.is_finite() && score > 0.0 && config.pieces.len() == problem.p {
                    if !result.strict {
                        if fallback.as_ref().map_or(true, |f| score < f.1) {
                            fallback = Some((config.clone(), score));
                            fallback_from_known = flight.from_known;
                        }
                    } else {
                        let before = best.as_ref().map_or(f64::INFINITY, |b| b.score).min(known.as_ref().map_or(f64::INFINITY, |k| k.score));
                        if best.as_ref().map_or(true, |b| score < b.score) {
                            best = Some(Candidate { config: config.clone(), score, strict: true, job: flight.job.clone(), params: result.params.clone() });
                            best_from_known = flight.from_known;
                        }
                        if !before.is_finite() || (before - score) / before > policy::MIN_IMPROVEMENT {
                            last_beaten = t;
                        }
                        if !flight.from_known && score < own_best * (1.0 - policy::MIN_IMPROVEMENT) {
                            own_best = score;
                            last_own = t;
                        }
                        gain = reward(before, score);
                    }
                }
            }
        }
        let failed = result.termination == "error" || result.termination == "crashed";
        if let Some(i) = flight.state {
            let s = &mut states[i];
            s.jobs += 1;
            s.rewards += gain;
            s.planned += flight.job.time_s;
            s.spent += seconds;
            s.alpha = s.prior.0 + policy::DISCOUNT * (s.alpha - s.prior.0) + gain;
            s.beta = s.prior.1 + policy::DISCOUNT * (s.beta - s.prior.1) + (1.0 - gain);
            if failed {
                s.errors += 1;
                if s.errors >= policy::ERROR_LIMIT {
                    s.disabled = true;
                }
            } else {
                s.errors = 0;
                // only a job at the arm's current level moves it: lanes may finish older jobs late
                if flight.level == s.level && s.level < plan.max_level {
                    s.misses += 1;
                    if gain > 0.0 || s.misses >= policy::MISSES_PER_LEVEL {
                        s.level += 1;
                        s.misses = 0;
                    }
                }
            }
        }
        if let Some(r) = rates.iter_mut().find(|r| r.method == flight.job.method) {
            if !failed && seconds > 0.01 && result.evaluations > 0 {
                r.evaluations += result.evaluations as f64;
                r.seconds += seconds;
            }
        }
        on_result(&result, best.as_ref());
    }
    let aborted = control.aborted();
    // the final polish of the best packing (or of the best valid one when none is strict)
    if !aborted {
        let target = best.as_ref().map(|b| b.config.clone()).or_else(|| fallback.as_ref().map(|f| f.0.clone()));
        let seconds = (max_seconds - elapsed()).min(policy::POLISH_MAX_SECONDS);
        if let Some(cfg) = target {
            if seconds >= 0.05 {
                let job = Job {
                    problem,
                    method: Method::Polish,
                    params: Value::Null,
                    seed: mix_seed(seed, jobs as u32),
                    time_s: seconds,
                    evals: Some(policy::POLISH_EVALUATIONS),
                    start: Some(cfg),
                    final_polish: false,
                    kind: "polish",
                };
                let id = jobs;
                jobs += 1;
                flights.push(Some(Flight { job: job.clone(), state: None, level: 0, from_known: false, started_at: elapsed() }));
                runner.launch(id, job);
                let (_, result) = runner.wait();
                let flight = flights[id].take().unwrap();
                evaluations += result.evaluations;
                if result.valid && result.strict {
                    if let (Some(config), Some(score)) = (&result.best, result.score) {
                        if best.as_ref().map_or(true, |b| score < b.score) {
                            best = Some(Candidate { config: config.clone(), score, strict: true, job: flight.job.clone(), params: result.params.clone() });
                        }
                    }
                }
                on_result(&result, best.as_ref());
            }
        }
    }
    // memory: each arm's share of the reward (nothing when no job improved anything), each rate
    let total: f64 = states.iter().map(|s| s.rewards).sum();
    let credits: Vec<(String, f64)> = if total > 0.0 { states.iter().filter(|s| s.jobs > 0).map(|s| (s.arm.key.clone(), s.rewards / total)).collect() } else { Vec::new() };
    let measured: Vec<(String, f64)> = rates.iter().filter(|r| r.seconds >= 1.0).map(|r| (r.method.name().to_string(), r.evaluations / r.seconds * p)).collect();
    let learned = memory_now().remember(&family, &credits, &measured);
    SearchOutcome { best, jobs, stopped: if aborted { Stop::Aborted } else { stop }, memory: learned, evaluations }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_and_reward() {
        let plan = make_plan(600.0, 4, 20, 1000.0);
        assert!((plan.base - 4.0).abs() < 1e-12);
        assert_eq!(plan.polish_reserve, 12.0);
        assert_eq!(plan.cap, 100.0);
        assert_eq!(plan.max_level, 4);
        assert_eq!(plan.stagnation_floor, 150.0);
        assert_eq!(reward(10.0, 10.0), 0.0);
        assert!((reward(1.0, 1.0 - 1e-6) - 0.5).abs() < 1e-6);
        assert_eq!(reward(1.0, 0.5), 1.0);
        assert_eq!(family_key(&Problem::new(0, 12, 150)), "c/9+/100");
    }
}
