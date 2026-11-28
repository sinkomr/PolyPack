//! The fresh engines (native/FRESH.md): searches written from scratch, one per kind of problem, each
//! far faster than the line-by-line port of the TypeScript search. Every one has the entry point
//! `polypack_spaceauto::FreshSearch` (spaceauto/src/fresh.rs): one whole search of one problem on one
//! thread, with its own schedule, returning a checked packing.
//!
//! The registry maps a problem id to the engines that claim it. The client (--engine auto) runs a
//! fresh engine where one claims the problem and the port elsewhere; an engine that answers `Err` to
//! an id it claimed hands the problem back (the next claiming engine tries, and when none does the
//! port searches it).
//!
//! Adding an engine is a Cargo dependency (client/Cargo.toml, behind the fresh-engines feature) and
//! one `Engine` line in `builtin`.
//!
//! One problem is searched by `search`: one job per lane (thread), seeds mixed from the problem's
//! seed, each with the problem's time budget as its CPU budget and 1.5 times it plus 5 s of wall
//! clock; the best checked result wins. The client's halt flag (a stop, a pause) ends all lanes at
//! once and the problem is finished with the best so far.

use crate::space_engine::mix_seed;
use polypack_spaceauto::{FreshJob, FreshResult, FreshSearch};
use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A fresh engine in the registry.
#[derive(Clone, Copy)]
pub struct Engine {
    pub name: &'static str,
    /// The method text its results carry when a lane is lost before it returns (a result's own
    /// `FreshResult.method` replaces it).
    pub method: &'static str,
    /// True for the ids the engine searches (cheap: reads the id only).
    pub claims: fn(&str) -> bool,
    pub search: FreshSearch,
}

/// The engines this build has, in the order they are tried.
pub fn builtin() -> Vec<Engine> {
    #[allow(unused_mut)]
    let mut engines: Vec<Engine> = Vec::new();
    #[cfg(feature = "fresh-engines")]
    {
        engines.push(Engine { name: "fresh-flat", method: "fresh flat", claims: polypack_fresh_flat::fresh::handles, search: polypack_fresh_flat::fresh::fresh_search });
        engines.push(Engine { name: "fresh-round", method: "fresh round", claims: polypack_fresh_round::fresh::handles_id, search: polypack_fresh_round::fresh::fresh_search });
        engines.push(Engine { name: "fresh-balls", method: "fresh balls", claims: fresh_balls::fresh::handles, search: fresh_balls::fresh::fresh_search });
        // TODO(fresh-polyhedra): polyhedra/<piece>in<container>/<P> and balls/<solid>inball/<P>: add the crate
        // polypack-fresh-polyhedra (client/Cargo.toml, optional, in the fresh-engines feature) and
        //     engines.push(Engine { name: "fresh-polyhedra", method: "fresh polyhedra", claims: polypack_fresh_polyhedra::fresh::handles, search: polypack_fresh_polyhedra::fresh::fresh_search });
        // TODO(fresh-torus): torus/<family>/<N>/<P>: the same with polypack-fresh-torus
        //     engines.push(Engine { name: "fresh-torus", method: "fresh torus", claims: polypack_fresh_torus::fresh::handles, search: polypack_fresh_torus::fresh::fresh_search });
    }
    engines
}

/// The id a flat problem has in a `FreshJob`.
pub fn flat_id(n: u32, m: u32, p: usize) -> String {
    format!("flat/{n}/{m}/{p}")
}

/// True when an engine of `engines` claims `id`.
pub fn claimed(engines: &[Engine], id: &str) -> bool {
    engines.iter().any(|e| (e.claims)(id))
}

/// Checks a lane's packing: the server's rule for the problem, and the claimed score equal to the one
/// the rule computes (within the tie tolerance). Returns the rule's score.
pub type Check<'a> = &'a (dyn Fn(&Value, f64) -> Result<f64, String> + Sync);

/// One problem's search.
pub struct FreshRun<'a> {
    pub id: &'a str,
    pub lanes: usize,
    /// The problem's seed; the lanes' are mixed from it.
    pub seed: u32,
    /// The problem's time budget: each lane's CPU seconds.
    pub seconds: f64,
    /// The client's halt flag (stop, pause); read, never set, here.
    pub halt: &'a AtomicBool,
    /// The configuration to start from: the site leader's or the research record's.
    pub start: Option<&'a Value>,
    /// The problem's lower bound; a checked packing at it ends the problem.
    pub bound: Option<f64>,
    pub low_priority: bool,
    pub check: Check<'a>,
}

/// The best checked packing found.
#[derive(Clone, Debug)]
pub struct Found {
    pub config: Value,
    pub score: f64,
    pub seed: u32,
    pub method: String,
}

/// What happens during a search, for the client's log.
pub enum Event<'a> {
    /// A new best, checked by the client's rule.
    Best(&'a Found),
    /// A lane's packing the client's rule does not accept.
    Rejected { seed: u32, why: &'a str },
    /// A lane that ended without a result (an error or a panic).
    Lost { seed: u32, why: &'a str },
    /// A lane finished.
    LaneDone,
}

#[derive(Debug)]
pub struct FreshOutcome {
    pub best: Option<Found>,
    /// Lanes run.
    pub jobs: usize,
    pub evaluations: u64,
    /// "time", "bound", "stagnation" (no gain for a while: `stalled`), or "halted" (the halt flag was set by
    /// the client: a stop or a pause).
    pub stopped: &'static str,
    /// Lanes lost to a panic.
    pub crashed: usize,
}

/// A problem ends early when no lane has improved its best by more than `STALL_MIN_GAIN` (relative) for
/// the longest of `STALL_FLOOR_SECONDS`, `STALL_BUDGET_SHARE` of the budget and `STALL_ELAPSED_SHARE` of the
/// time spent (wall clock). The fresh engines converge in a fraction of a second on most small problems, so
/// without it every problem would take its whole budget; a problem without any packing yet never stalls.
pub const STALL_FLOOR_SECONDS: f64 = 5.0;
pub const STALL_BUDGET_SHARE: f64 = 0.1;
pub const STALL_ELAPSED_SHARE: f64 = 0.5;
pub const STALL_MIN_GAIN: f64 = 1e-6;

/// True when a search `elapsed` seconds in, whose best last improved at `last_gain`, has stalled.
pub fn stalled(elapsed: f64, last_gain: Option<f64>, budget: f64) -> bool {
    match last_gain {
        None => false,
        Some(t) => elapsed - t >= STALL_FLOOR_SECONDS.max(STALL_BUDGET_SHARE * budget).max(STALL_ELAPSED_SHARE * elapsed),
    }
}

/// The wall-clock end of a job of `seconds` of CPU time: 1.5 times it plus 5 s.
pub fn wall_budget(seconds: f64) -> Duration {
    Duration::from_secs_f64((seconds * 1.5 + 5.0).clamp(5.0, 1e7))
}

fn run_lane(engines: &[Engine], job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
    let mut last = None;
    for e in engines.iter().filter(|e| (e.claims)(job.id)) {
        match (e.search)(job, on_improve) {
            Ok(r) => return Ok(r),
            Err(why) => last = Some(format!("{}: {why}", e.name)),
        }
    }
    Err(last.unwrap_or_else(|| format!("no fresh engine claims {}", job.id)))
}

struct Live {
    best: Option<Found>,
    reached_bound: bool,
    /// Wall seconds since the start at which the best last improved by more than STALL_MIN_GAIN.
    last_gain: Option<f64>,
}

fn improves(score: f64, best: &Option<Found>) -> bool {
    best.as_ref().map_or(true, |b| score < b.score * (1.0 - 1e-12))
}

/// Searches `run.id` with the engines of `engines` that claim it, one job per lane. None when no
/// engine takes it (every lane's engines answered `Err`): the caller falls back to the port.
pub fn search(engines: &[Engine], run: &FreshRun, on_event: &(dyn Fn(Event) + Sync)) -> Option<FreshOutcome> {
    let lanes = run.lanes.max(1);
    let live = Mutex::new(Live { best: None, reached_bound: false, last_gain: None });
    let default_method = engines.iter().find(|e| (e.claims)(run.id)).map_or("fresh", |e| e.method);
    let started = Instant::now();
    let deadline = started + wall_budget(run.seconds);
    // the lanes' own stop: set by the watcher below on the client's halt, at the bound, or when the search stalls
    let lane_stop = AtomicBool::new(run.halt.load(Ordering::Relaxed));
    let lanes_done = std::sync::atomic::AtomicUsize::new(0);
    let stalled_out = AtomicBool::new(false);
    // seed, result of each lane
    let results: Vec<(u32, Result<Result<FreshResult, String>, ()>)> = std::thread::scope(|scope| {
        {
            let (live, lane_stop, lanes_done, stalled_out) = (&live, &lane_stop, &lanes_done, &stalled_out);
            scope.spawn(move || {
                while lanes_done.load(Ordering::Relaxed) < lanes {
                    if run.halt.load(Ordering::Relaxed) {
                        lane_stop.store(true, Ordering::Relaxed);
                    } else if !lane_stop.load(Ordering::Relaxed) {
                        let l = live.lock().unwrap();
                        if l.reached_bound {
                            lane_stop.store(true, Ordering::Relaxed);
                        } else if stalled(started.elapsed().as_secs_f64(), l.last_gain, run.seconds) {
                            stalled_out.store(true, Ordering::Relaxed);
                            lane_stop.store(true, Ordering::Relaxed);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            });
        }
        let handles: Vec<_> = (0..lanes)
            .map(|lane| {
                let seed = mix_seed(run.seed, lane as u32);
                let (live, on_event, lane_stop, lanes_done) = (&live, on_event, &lane_stop, &lanes_done);
                scope.spawn(move || {
                    if run.low_priority {
                        crate::platform::lower_thread_priority();
                    }
                    let job = FreshJob { id: run.id, seed: seed as u64, cpu_seconds: run.seconds, deadline, stop: lane_stop, start: run.start, max_evals: None };
                    let mut on_improve = |claimed: f64, config: &Value| {
                        if !claimed.is_finite() || !improves(claimed, &live.lock().unwrap().best) {
                            return;
                        }
                        match (run.check)(config, claimed) {
                            Ok(score) => {
                                let mut l = live.lock().unwrap();
                                if improves(score, &l.best) {
                                    let found = Found { config: config.clone(), score, seed, method: default_method.to_string() };
                                    if run.bound.map_or(false, |b| b > 0.0 && score <= b * (1.0 + 1e-9)) {
                                        l.reached_bound = true;
                                        lane_stop.store(true, Ordering::Relaxed);
                                    }
                                    if l.best.as_ref().map_or(true, |b| score < b.score * (1.0 - STALL_MIN_GAIN)) {
                                        l.last_gain = Some(started.elapsed().as_secs_f64());
                                    }
                                    l.best = Some(found.clone());
                                    drop(l);
                                    on_event(Event::Best(&found));
                                }
                            }
                            Err(why) => on_event(Event::Rejected { seed, why: &why }),
                        }
                    };
                    let r = catch_unwind(AssertUnwindSafe(|| run_lane(engines, &job, &mut on_improve))).map_err(|_| ());
                    if let Ok(Ok(res)) = &r {
                        // a lane's final packing is the last it reported, but the client checks what it is given
                        if let (Some(config), Some(score)) = (&res.config, res.score) {
                            on_improve(score, config);
                        }
                    }
                    on_event(Event::LaneDone);
                    lanes_done.fetch_add(1, Ordering::Relaxed);
                    (seed, r)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or((0, Err(())))).collect()
    });
    let mut evaluations = 0u64;
    let mut crashed = 0usize;
    let mut handled = 0usize;
    let mut halted = false;
    let mut l = live.into_inner().unwrap();
    for (seed, r) in results {
        match r {
            Err(()) => {
                crashed += 1;
                on_event(Event::Lost { seed, why: "the search thread panicked" });
            }
            Ok(Err(why)) => on_event(Event::Lost { seed, why: &why }),
            Ok(Ok(res)) => {
                handled += 1;
                evaluations += res.evaluations;
                halted |= res.stopped == "stop" && run.halt.load(Ordering::Relaxed);
                // the method text of the result of the lane whose packing is the best
                if let Some(b) = l.best.as_mut() {
                    if b.seed == seed && !res.method.is_empty() {
                        b.method = res.method.clone();
                    }
                }
            }
        }
    }
    if handled == 0 && crashed == 0 {
        // every lane's engines answered Err: nothing here searches this problem
        return None;
    }
    let stopped = if l.reached_bound {
        "bound"
    } else if halted || run.halt.load(Ordering::Relaxed) {
        "halted"
    } else if stalled_out.load(Ordering::Relaxed) {
        "stagnation"
    } else {
        "time"
    };
    Some(FreshOutcome { best: l.best, jobs: lanes, evaluations, stopped, crashed })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    /// An engine that claims `fake/...` ids and answers from the id's last number: its score.
    pub fn fake_claims(id: &str) -> bool {
        id.starts_with("fake/")
    }

    pub fn fake_search(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
        let score: f64 = job.id.rsplit('/').next().and_then(|s| s.parse().ok()).ok_or("no score in the id")?;
        // the lane's seed makes its score a little different: the best lane is the one with the smallest offset
        let score = score + (job.seed % 7) as f64 * 0.001;
        on_improve(score + 1.0, &json!({ "s": score + 1.0 }));
        on_improve(score, &json!({ "s": score, "start": job.start.is_some() }));
        Ok(FreshResult { config: Some(json!({ "s": score, "start": job.start.is_some() })), score: Some(score), evaluations: 5, stopped: "cpu".into(), method: "fake fresh".into() })
    }

    fn refuses_claims(id: &str) -> bool {
        id.starts_with("refuse/")
    }

    fn refuses(_: &FreshJob, _: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
        Err("not mine".into())
    }

    fn check(c: &Value, claimed: f64) -> Result<f64, String> {
        if c["s"].as_f64() == Some(claimed) {
            Ok(claimed)
        } else {
            Err("mismatch".into())
        }
    }

    pub fn registry() -> Vec<Engine> {
        vec![
            Engine { name: "refuser", method: "refuses", claims: refuses_claims, search: refuses },
            Engine { name: "fake", method: "fake default", claims: fake_claims, search: fake_search },
        ]
    }

    fn run_of<'a>(id: &'a str, halt: &'a AtomicBool, start: Option<&'a Value>) -> FreshRun<'a> {
        FreshRun { id, lanes: 3, seed: 11, seconds: 1.0, halt, start, bound: None, low_priority: false, check: &check }
    }

    #[test]
    fn takes_the_best_lane_and_passes_the_start_on() {
        let halt = AtomicBool::new(false);
        let start = json!({ "s": 9.0 });
        let bests = AtomicUsize::new(0);
        let lanes = AtomicUsize::new(0);
        let out = search(&registry(), &run_of("fake/2", &halt, Some(&start)), &|e| match e {
            Event::Best(_) => {
                bests.fetch_add(1, Ordering::Relaxed);
            }
            Event::LaneDone => {
                lanes.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        })
        .unwrap();
        let best = out.best.unwrap();
        assert!(best.score >= 2.0 && best.score < 2.01, "{}", best.score);
        assert_eq!(best.method, "fake fresh");
        assert_eq!(best.config["start"], json!(true));
        let seeds: Vec<u32> = (0..3).map(|l| mix_seed(11, l)).collect();
        assert!(seeds.contains(&best.seed));
        assert_eq!((out.jobs, out.evaluations, out.stopped, out.crashed), (3, 15, "time", 0));
        assert_eq!(lanes.load(Ordering::Relaxed), 3);
        assert!(bests.load(Ordering::Relaxed) >= 1);
    }

    #[test]
    fn an_id_no_engine_takes_falls_back() {
        let halt = AtomicBool::new(false);
        // claimed by an engine that answers Err, and claimed by nobody
        assert!(search(&registry(), &run_of("refuse/3", &halt, None), &|_| {}).is_none());
        assert!(search(&registry(), &run_of("other/3", &halt, None), &|_| {}).is_none());
        assert!(claimed(&registry(), "fake/1") && !claimed(&registry(), "other/1"));
    }

    #[test]
    fn a_result_the_rule_rejects_is_not_kept_and_the_bound_halts_every_lane() {
        let halt = AtomicBool::new(false);
        let rejected = AtomicUsize::new(0);
        let strict: Check = &|c: &Value, claimed| if claimed < 2.5 { Err("too good".into()) } else { check(c, claimed) };
        let mut r = run_of("fake/2", &halt, None);
        r.check = strict;
        let out = search(&registry(), &r, &|e| {
            if let Event::Rejected { .. } = e {
                rejected.fetch_add(1, Ordering::Relaxed);
            }
        })
        .unwrap();
        // every lane's scores are 2.0xx and 3.0xx; only the 3.0xx ones pass
        let best = out.best.unwrap();
        assert!(best.score > 3.0 && best.score < 3.01, "{}", best.score);
        assert!(rejected.load(Ordering::Relaxed) >= 3);
        // a bound the best reaches ends the problem, without touching the client's halt flag
        let mut r = run_of("fake/2", &halt, None);
        r.bound = Some(2.5);
        let out = search(&registry(), &r, &|_| {}).unwrap();
        assert_eq!(out.stopped, "bound");
        assert!(!halt.load(Ordering::Relaxed));
    }

    #[test]
    fn a_search_stalls_only_after_the_longest_of_its_waits() {
        // no packing yet: never
        assert!(!stalled(1e6, None, 60.0));
        // budget 60 s: the wait is max(5, 6, elapsed / 2)
        assert!(!stalled(10.0, Some(4.5), 60.0));
        assert!(stalled(10.0, Some(4.0), 60.0));
        assert!(!stalled(100.0, Some(51.0), 60.0));
        assert!(stalled(100.0, Some(50.0), 60.0));
        // budget 600 s: at least 60 s without a gain
        assert!(!stalled(70.0, Some(20.0), 600.0));
        assert!(stalled(90.0, Some(20.0), 600.0));
    }

    /// Improves once at once, then runs until it is stopped.
    fn idle_after_one(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
        on_improve(3.0, &json!({ "s": 3.0 }));
        while !job.stopped_or_late() {
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(FreshResult { config: Some(json!({ "s": 3.0 })), score: Some(3.0), evaluations: 1, stopped: "stop".into(), method: "idle".into() })
    }

    #[test]
    fn a_stalled_search_ends_long_before_its_budget_and_is_not_a_halt() {
        let engines = vec![Engine { name: "idle", method: "idle", claims: |id| id.starts_with("idle/"), search: idle_after_one }];
        let halt = AtomicBool::new(false);
        let check = |_: &Value, s: f64| -> Result<f64, String> { Ok(s) };
        let run = FreshRun { id: "idle/1", lanes: 2, seed: 1, seconds: 30.0, halt: &halt, start: None, bound: None, low_priority: false, check: &check };
        let t = Instant::now();
        let out = search(&engines, &run, &|_| {}).unwrap();
        let took = t.elapsed().as_secs_f64();
        assert_eq!(out.stopped, "stagnation");
        assert!(took >= STALL_FLOOR_SECONDS && took < STALL_FLOOR_SECONDS + 2.0, "{took}");
        assert!(!halt.load(Ordering::Relaxed));
        assert_eq!(out.best.unwrap().score, 3.0);
    }

    #[test]
    fn a_halt_flag_set_before_the_end_says_halted() {
        let halt = AtomicBool::new(true);
        let out = search(&registry(), &run_of("fake/2", &halt, None), &|_| {}).unwrap();
        assert_eq!(out.stopped, "halted");
        assert!(out.best.is_some());
    }

    /// An engine that works until the halt flag is set (a stop or a pause) and then returns what it has.
    fn slow_search(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
        let mut score = 9.0;
        while !job.stopped_or_late() {
            score -= 1.0;
            on_improve(score, &json!({ "s": score }));
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(FreshResult { config: Some(json!({ "s": score })), score: Some(score), evaluations: 1, stopped: "stop".into(), method: "slow fresh".into() })
    }

    #[test]
    fn a_pause_ends_every_lane_with_its_best_so_far() {
        let slow = Engine { name: "slow", method: "slow", claims: |id| id == "slow/1", search: slow_search };
        let halt = AtomicBool::new(false);
        let t = Instant::now();
        let out = std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_millis(150));
                halt.store(true, Ordering::Relaxed);
            });
            let mut run = run_of("slow/1", &halt, None);
            run.seconds = 100.0;
            search(&[slow], &run, &|_| {}).unwrap()
        });
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert_eq!(out.stopped, "halted");
        assert_eq!(out.jobs, 3);
        let best = out.best.unwrap();
        assert!(best.score < 9.0 && best.method == "slow fresh", "{best:?}");
    }

    #[test]
    fn the_builtin_registry_claims_what_the_adapters_handle() {
        let engines = builtin();
        #[cfg(feature = "fresh-engines")]
        {
            for id in ["flat/4/6/12", "flat/0/0/5", "flat/17/4/12", "flat/100/100/500", "flat/3/97/2", "sphere/0/20", "curved/-1/0/0/9", "curved/1/0/6/6", "balls/ballinball/13", "balls/ballincub/9"] {
                assert!(claimed(&engines, id), "{id}");
            }
            // the engines' own limits: flat P of at least 2, curvature +-1, balls only as pieces
            for id in ["flat/101/4/12", "flat/4/6/1", "curved/0.5/0/0/9", "sphere/4/12", "balls/cubinball/5", "polyhedra/cubintet/5", "torus/sq/0/5", "surface/cube/fold/0/3"] {
                assert!(!claimed(&engines, id), "{id}");
            }
        }
        let _ = engines;
        assert_eq!(flat_id(4, 6, 12), "flat/4/6/12");
        assert_eq!(wall_budget(60.0), Duration::from_secs(95));
    }
}
