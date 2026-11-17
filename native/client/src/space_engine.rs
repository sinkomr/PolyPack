//! The engine of one 2D-on-3D problem: which jobs to run, with which seeds, budgets and starts,
//! and when the problem is done. A port of packages/spaces/src/search/engine.ts
//! (`searchSpaceProblem`, `SPACE_POLICY`), with the jobs run on threads by a `SpaceSearcher`.
//!
//! 1. Kinds. "iterate" jobs start from the best found, or from the problem's best configuration
//!    (the research record's or the site leader's) before there is one; "fresh" jobs build their
//!    own start. The first job iterates when there is a start; every later one is fresh with
//!    probability 1/4 (always when there is no start), drawn from a stream seeded by the seed.
//! 2. Budgets. Each kind has a level, starting at 0; its jobs get T0 2^level seconds, T0 =
//!    maxSeconds / 20 clipped to [1, 30], up to a quarter of maxSeconds, clipped to the time left.
//!    The level rises after a job at that level improves the best, and after every two that do not.
//!    Once a kind's jobs have run for a second, every job also gets an evaluation cap, 0.8 of what
//!    its time buys at their measured rate.
//! 3. Stopping. No job starts when aborted, when the best is within 1e-9 of the problem's lower
//!    bound or a valid job ended "bound", when less than T0 / 2 is left, or when the score to beat
//!    has not improved by more than 1e-9 relative for max(maxSeconds / 4, elapsed / 2) seconds.
//!    Three failed jobs in a row also end it.
//! Job seeds are mixed from the seed and the job's index.
//!
//! Not ported: the TypeScript start from a lattice for torus problems without a record (the Auto
//! searches build their own start), and the generic methods (--space-method).
//!
//! A pause (battery power) holds back new jobs; jobs already running end at their deadline.

use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Runs one job of a space ("surface", "sphere" or "torus"); `job.id` says which problem.
pub trait SpaceSearcher: Send + Sync {
    fn search(&self, space: &str, job: &AutoJob) -> Result<AutoResult, String>;
}

pub const FRESH_SHARE: f64 = 0.25;
pub const BASE_SHARE: f64 = 1.0 / 20.0;
pub const BASE_MIN_SECONDS: f64 = 1.0;
pub const BASE_MAX_SECONDS: f64 = 30.0;
pub const CAP_SHARE: f64 = 0.25;
pub const MISSES_PER_LEVEL: u32 = 2;
pub const EVALUATION_FILL: f64 = 0.8;
pub const MIN_EVALUATIONS: u64 = 16;
pub const MIN_IMPROVEMENT: f64 = 1e-9;
pub const STAGNATION_SHARE: f64 = 0.25;

/// Any number as a uint32, as JavaScript's `>>> 0`.
pub fn to_u32(v: f64) -> u32 {
    if v.is_finite() {
        (v.trunc() as i64) as u32
    } else {
        0
    }
}

/// seed.ts `mixSeed`.
pub fn mix_seed(a: u32, b: u32) -> u32 {
    let mut h = a ^ b.wrapping_add(1).wrapping_mul(0x9e3779b1);
    h = (h ^ (h >> 16)).wrapping_mul(0x85ebca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2ae35);
    h ^ (h >> 16)
}

/// seed.ts `seededStream` (mulberry32).
pub struct Stream(u32);

impl Stream {
    pub fn new(seed: u32) -> Stream {
        Stream(seed)
    }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

/// The problem's best configuration, to start from.
#[derive(Clone, Debug)]
pub struct Known {
    pub config: Value,
    pub score: f64,
    /// "site" or "certified".
    pub source: &'static str,
}

/// A configuration found, with the job that produced it.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub config: Value,
    pub score: f64,
    pub seed: u32,
    /// The method name a submission records ("sphere auto").
    pub method: String,
    /// "iterate" or "fresh".
    pub kind: &'static str,
    pub time_s: f64,
    pub evals: Option<u64>,
}

/// What the client's log needs of one finished job.
#[derive(Clone, Debug)]
pub struct JobReport {
    pub seed: u32,
    pub kind: &'static str,
    pub evaluations: u64,
    pub stopped: String,
    pub score: Option<f64>,
    pub valid: bool,
    pub failed: bool,
    pub crashed: bool,
    pub reason: Option<String>,
}

/// Stop and pause flags shared by the client and the running jobs.
pub struct SpaceControl {
    pub aborted: AtomicBool,
    pub paused: AtomicBool,
}

impl SpaceControl {
    pub fn new() -> SpaceControl {
        SpaceControl { aborted: AtomicBool::new(false), paused: AtomicBool::new(false) }
    }
}

/// Checks a job's configuration with the claimed score: the validated score, or why not.
pub type CheckFn<'a> = &'a (dyn Fn(&Value, f64) -> Result<f64, String> + Sync);

pub struct SpaceSearchInput<'a> {
    pub space: &'a str,
    pub id: &'a str,
    pub known: Option<&'a Known>,
    pub bound: Option<f64>,
    pub max_seconds: f64,
    pub lanes: usize,
    pub seed: u32,
    /// Active seconds, monotonic.
    pub now: &'a (dyn Fn() -> f64 + Sync),
    pub check: CheckFn<'a>,
    pub low_priority: bool,
}

#[derive(Debug)]
pub struct SpaceOutcome {
    pub best: Option<Candidate>,
    pub jobs: usize,
    pub evaluations: u64,
    /// "time", "stagnation", "aborted" or "bound".
    pub stopped: &'static str,
    /// Jobs that lost their thread (a panic).
    pub crashed: usize,
}

struct Done {
    id: usize,
    report: JobReport,
    config: Option<Value>,
    method: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Iterate,
    Fresh,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Iterate => "iterate",
            Kind::Fresh => "fresh",
        }
    }
}

#[derive(Default, Clone, Copy)]
struct KindState {
    level: i32,
    misses: u32,
    evaluations: f64,
    seconds: f64,
}

struct Flight {
    kind: Kind,
    level: i32,
    started_at: f64,
    seconds: f64,
    evals: Option<u64>,
    seed: u32,
}

pub fn search_space_problem(
    input: &SpaceSearchInput,
    searcher: &dyn SpaceSearcher,
    control: &SpaceControl,
    on_result: &mut dyn FnMut(&JobReport, Option<&Candidate>),
) -> SpaceOutcome {
    let max_seconds = if input.max_seconds.is_finite() { input.max_seconds.max(0.0) } else { 0.0 };
    let lanes = input.lanes.max(1);
    let mut random = Stream::new(mix_seed(input.seed, 0xfffffffe));
    let t0 = (input.now)();
    let elapsed = || (input.now)() - t0;
    let base = BASE_MAX_SECONDS.min(BASE_MIN_SECONDS.max(max_seconds * BASE_SHARE));
    let cap = base.max(max_seconds * CAP_SHARE);
    let known = input.known.filter(|k| k.score.is_finite() && k.score > 0.0);
    let mut kinds = [KindState::default(); 2];
    let mut best: Option<Candidate> = None;
    let mut at_floor = false;
    let mut last_progress = 0.0;
    let mut jobs = 0usize;
    let mut failures = 0u32;
    let mut evaluations = 0u64;
    let mut crashed = 0usize;
    let mut flights: std::collections::HashMap<usize, Flight> = std::collections::HashMap::new();
    let mut stopped: &'static str = "time";

    let (tx, rx) = mpsc::channel::<Done>();
    std::thread::scope(|scope| {
        loop {
            // start jobs while a lane is free
            while flights.len() < lanes && !control.paused.load(Ordering::Relaxed) {
                if control.aborted.load(Ordering::Relaxed) {
                    stopped = "aborted";
                    break;
                }
                if failures >= 3 {
                    stopped = "stagnation";
                    break;
                }
                if at_floor || best.as_ref().map_or(false, |b| input.bound.map_or(false, |bd| bd > 0.0 && b.score <= bd * (1.0 + MIN_IMPROVEMENT))) {
                    stopped = "bound";
                    break;
                }
                let t = elapsed();
                let available = max_seconds - t;
                if available < base / 2.0 {
                    stopped = "time";
                    break;
                }
                if t - last_progress >= (max_seconds * STAGNATION_SHARE).max(t / 2.0) {
                    stopped = "stagnation";
                    break;
                }
                let start: Option<Value> = best.as_ref().map(|b| b.config.clone()).or_else(|| known.map(|k| k.config.clone()));
                let kind = if start.is_none() || (jobs > 0 && random.next() < FRESH_SHARE) { Kind::Fresh } else { Kind::Iterate };
                let st = kinds[kind as usize];
                let seconds = cap.min(base * 2f64.powi(st.level)).min(available);
                let rate = if st.seconds >= 1.0 { Some(st.evaluations / st.seconds) } else { None };
                let evals = rate.map(|r| MIN_EVALUATIONS.max((r * seconds * EVALUATION_FILL).floor() as u64));
                let seed = mix_seed(input.seed, jobs as u32);
                let id = jobs;
                jobs += 1;
                flights.insert(id, Flight { kind, level: st.level, started_at: elapsed(), seconds, evals, seed });
                let tx = tx.clone();
                let start = if kind == Kind::Iterate { start } else { None };
                let deadline = Instant::now() + Duration::from_secs_f64(seconds);
                let (space, pid, check, low) = (input.space, input.id, input.check, input.low_priority);
                let stop = &control.aborted;
                scope.spawn(move || {
                    if low {
                        crate::platform::lower_thread_priority();
                    }
                    let job = AutoJob { id: pid, start: start.as_ref(), seed, max_evals: evals, deadline, stop };
                    let run = catch_unwind(AssertUnwindSafe(|| searcher.search(space, &job)));
                    let done = match run {
                        Err(_) => Done {
                            id,
                            config: None,
                            method: String::new(),
                            report: JobReport { seed, kind: kind.name(), evaluations: 0, stopped: "crashed".into(), score: None, valid: false, failed: true, crashed: true, reason: Some("the search thread panicked".into()) },
                        },
                        Ok(Err(e)) => Done {
                            id,
                            config: None,
                            method: String::new(),
                            report: JobReport { seed, kind: kind.name(), evaluations: 0, stopped: format!("error: {e}"), score: None, valid: false, failed: true, crashed: false, reason: Some(e) },
                        },
                        Ok(Ok(r)) => {
                            let failed = r.stopped.starts_with("error");
                            let mut valid = None;
                            let mut reason = if failed { Some(r.stopped.clone()) } else { None };
                            if let (Some(c), Some(s)) = (&r.config, r.score) {
                                if s.is_finite() && s > 0.0 {
                                    match check(c, s) {
                                        Ok(v) => valid = Some(v),
                                        Err(why) => reason = Some(why),
                                    }
                                }
                            }
                            Done {
                                id,
                                config: if valid.is_some() { r.config.clone() } else { None },
                                method: r.method.clone(),
                                report: JobReport { seed, kind: kind.name(), evaluations: r.evaluations, stopped: r.stopped, score: valid, valid: valid.is_some(), failed, crashed: false, reason },
                            }
                        }
                    };
                    let _ = tx.send(done);
                });
            }
            if flights.is_empty() {
                if control.paused.load(Ordering::Relaxed) && !control.aborted.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                break;
            }
            let done = match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let flight = flights.remove(&done.id).unwrap();
            let t = elapsed();
            let to_beat = best.as_ref().map_or(f64::INFINITY, |b| b.score).min(known.map_or(f64::INFINITY, |k| k.score));
            let mut improved = false;
            let r = &done.report;
            if let (true, Some(score), Some(config)) = (r.valid, r.score, done.config.clone()) {
                if best.as_ref().map_or(true, |b| score < b.score) {
                    best = Some(Candidate { config, score, seed: flight.seed, method: done.method.clone(), kind: flight.kind.name(), time_s: flight.seconds, evals: flight.evals });
                }
                if r.stopped == "bound" {
                    at_floor = true;
                }
                if !to_beat.is_finite() || (to_beat - score) / to_beat > MIN_IMPROVEMENT {
                    improved = true;
                    last_progress = t;
                }
            }
            let st = &mut kinds[flight.kind as usize];
            failures = if r.failed { failures + 1 } else { 0 };
            if r.crashed {
                crashed += 1;
            }
            evaluations += r.evaluations;
            if !r.failed && r.evaluations > 0 {
                st.evaluations += r.evaluations as f64;
                st.seconds += (t - flight.started_at).max(0.0);
            }
            if flight.level == st.level {
                st.misses += 1;
                if improved || st.misses >= MISSES_PER_LEVEL {
                    if base * 2f64.powi(st.level) < cap {
                        st.level += 1;
                    }
                    st.misses = 0;
                }
                if improved {
                    st.misses = 0;
                }
            }
            on_result(&done.report, best.as_ref());
        }
    });
    if control.aborted.load(Ordering::Relaxed) {
        stopped = "aborted";
    }
    SpaceOutcome { best, jobs, evaluations, stopped, crashed }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    /// A searcher that answers from a script: the score of job i (by seed order of arrival).
    pub struct Scripted {
        pub scores: Mutex<Vec<f64>>,
        pub log: Mutex<Vec<(u32, bool, Option<u64>)>>,
        pub stopped: &'static str,
    }

    impl SpaceSearcher for Scripted {
        fn search(&self, _space: &str, job: &AutoJob) -> Result<AutoResult, String> {
            self.log.lock().unwrap().push((job.seed, job.start.is_some(), job.max_evals));
            let mut s = self.scores.lock().unwrap();
            let score = if s.is_empty() { 10.0 } else { s.remove(0) };
            Ok(AutoResult { config: Some(json!({ "s": score })), score: Some(score), evaluations: 100, stopped: self.stopped.into(), method: "test auto".into() })
        }
    }

    fn ok_check(c: &Value, s: f64) -> Result<f64, String> {
        if c["s"].as_f64() == Some(s) {
            Ok(s)
        } else {
            Err("mismatch".into())
        }
    }

    #[test]
    fn seeds_match_the_typescript() {
        // computed with packages/spaces/src/search/seed.ts under node
        assert_eq!(mix_seed(12345, 0), 2679938182);
        assert_eq!(mix_seed(7, 3), 3510281238);
        assert_eq!(mix_seed(0xffffffff, 0xfffffffe), 2980047484);
        let mut s = Stream::new(42);
        assert_eq!([s.next(), s.next(), s.next()], [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
    }

    #[test]
    fn runs_jobs_and_keeps_the_best() {
        let searcher = Scripted { scores: Mutex::new(vec![5.0, 4.0, 4.5, 3.0]), log: Mutex::new(Vec::new()), stopped: "time" };
        let now = || {
            // a fake clock: every call advances one second per ten calls would be fragile; use real time scaled
            static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
            START.get_or_init(Instant::now).elapsed().as_secs_f64() * 50.0
        };
        let input = SpaceSearchInput { space: "sphere", id: "sphere/4/3", known: None, bound: None, max_seconds: 40.0, lanes: 1, seed: 7, now: &now, check: &ok_check, low_priority: false };
        let control = SpaceControl::new();
        let mut reports = Vec::new();
        let out = search_space_problem(&input, &searcher, &control, &mut |r, b| reports.push((r.score, b.map(|b| b.score))));
        assert!(out.jobs >= 3, "{out:?}");
        assert_eq!(out.best.as_ref().map(|b| b.score), Some(3.0).filter(|_| out.jobs >= 4).or(out.best.as_ref().map(|b| b.score)));
        let log = searcher.log.lock().unwrap();
        // nothing to start from: the first job is fresh; later ones may iterate from the best
        assert!(!log[0].1);
        // seeds are mixed from the seed and the job's index
        assert_eq!(log[0].0, mix_seed(7, 0));
        assert_eq!(reports[0].0, Some(5.0));
    }

    #[test]
    fn starts_from_the_known_and_stops_at_the_bound() {
        let searcher = Scripted { scores: Mutex::new(vec![2.0]), log: Mutex::new(Vec::new()), stopped: "bound" };
        let known = Known { config: json!({ "s": 9.0 }), score: 9.0, source: "site" };
        let now = || {
            static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
            START.get_or_init(Instant::now).elapsed().as_secs_f64()
        };
        let input = SpaceSearchInput { space: "sphere", id: "sphere/4/3", known: Some(&known), bound: Some(2.0), max_seconds: 30.0, lanes: 2, seed: 1, now: &now, check: &ok_check, low_priority: false };
        let out = search_space_problem(&input, &searcher, &SpaceControl::new(), &mut |_, _| {});
        // the first job iterates from the known start, a valid job that ended "bound" ends the problem
        assert_eq!(out.stopped, "bound");
        assert_eq!(out.best.as_ref().map(|b| (b.score, b.kind)), Some((2.0, "iterate")));
        assert!(searcher.log.lock().unwrap()[0].1);
    }

    #[test]
    fn an_invalid_result_is_not_kept_and_failures_end_it() {
        struct Bad;
        impl SpaceSearcher for Bad {
            fn search(&self, _: &str, _: &AutoJob) -> Result<AutoResult, String> {
                Err("cannot model".into())
            }
        }
        let now = || {
            static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
            START.get_or_init(Instant::now).elapsed().as_secs_f64()
        };
        let input = SpaceSearchInput { space: "sphere", id: "sphere/4/3", known: None, bound: None, max_seconds: 600.0, lanes: 1, seed: 1, now: &now, check: &ok_check, low_priority: false };
        let out = search_space_problem(&input, &Bad, &SpaceControl::new(), &mut |_, _| {});
        assert_eq!((out.jobs, out.stopped, out.best.is_none()), (3, "stagnation", true));
    }
}
