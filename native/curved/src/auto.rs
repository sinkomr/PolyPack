//! The curved space's Auto search for the native client: the interface of `polypack_spaceauto`
//! over `job::run_job_with`, which is already the curved case of `runSpaceJob` in
//! packages/spaces/src/search/run.ts (rounds of one start and up to 8 hops, seeded from the job's
//! seed, from the best so far; see job.rs).
//!
//! The job's id is read as the server reads it (`CurvedProblem::parse`), and its start as
//! `readSpaceConfig` reads a curved configuration: a positive size and P poses. The job's deadline
//! is a wall-clock time: the job runs on the wall clock, so that a thread at low priority stops when
//! the client expects it to, and `job.stop` ends it early. Results are kept by the job's default
//! rule (the strict check, without the bound); the client checks them again with the problem's
//! whole rule.

use crate::job::{run_job_with, Budget, JobOptions, Termination};
use crate::problem::{CurvedConfig, CurvedProblem};
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::Value;
use std::time::Instant;

/// The method a curved Auto result is recorded under (`SPACE_METHOD.curved` of
/// packages/spaces/src/search/model.ts).
pub const METHOD: &str = "curved search";

/// The id as the server reads it.
pub fn parse_id(id: &str) -> Option<CurvedProblem> {
    CurvedProblem::parse(id).ok()
}

/// model.ts `readSpaceConfig`, the curved case: a positive finite size and exactly P poses of
/// finite numbers. None when the value is not a configuration of the problem.
fn read_start(problem: &CurvedProblem, v: &Value) -> Option<CurvedConfig> {
    let size = v.get("size")?.as_f64().filter(|s| s.is_finite() && *s > 0.0)?;
    let pieces = v.get("pieces")?.as_array()?;
    if pieces.len() != problem.p as usize {
        return None;
    }
    let mut out = Vec::with_capacity(pieces.len());
    for q in pieces {
        let f = |k: &str| q.get(k).and_then(Value::as_f64).filter(|x| x.is_finite());
        out.push(serde_json::from_value(serde_json::json!({ "x": f("x")?, "y": f("y")?, "theta": f("theta")? })).ok()?);
    }
    Some(CurvedConfig { size, pieces: out })
}

pub fn auto_search(job: &AutoJob) -> Result<AutoResult, String> {
    let problem = CurvedProblem::parse(job.id).map_err(|e| e.0)?;
    let failed = |why: &str| AutoResult { config: None, score: None, evaluations: 0, stopped: format!("error: {why}"), method: METHOD.to_string() };
    let start = match job.start {
        None => None,
        Some(v) => match read_start(&problem, v) {
            Some(c) => Some(c),
            None => return Ok(failed("the start is not a configuration of this problem")),
        },
    };
    let began = Instant::now();
    let wall = move || began.elapsed().as_secs_f64();
    let seconds = job.deadline.saturating_duration_since(began).as_secs_f64();
    let opts = JobOptions { clock: Some(&wall), ..JobOptions::default() };
    let budget = Budget { evals: job.max_evals, cpu_seconds: Some(seconds) };
    let out = run_job_with(&problem, start.as_ref(), budget, job.seed as u64, job.stop, &opts);
    let stopped = match out.termination {
        Termination::Evals => "evals".to_string(),
        Termination::Time => "time".to_string(),
        Termination::Aborted => "stop".to_string(),
        Termination::Done => "done".to_string(),
        Termination::Error => format!("error: {}", out.reasons.join("; ")),
    };
    Ok(AutoResult {
        config: out.config.map(|c| serde_json::to_value(c).expect("a configuration is plain numbers")),
        score: out.score,
        evaluations: out.evaluations,
        stopped,
        method: METHOD.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    fn run(id: &str, start: Option<&Value>, seed: u32, evals: u64) -> AutoResult {
        let stop = AtomicBool::new(false);
        let job = AutoJob { id, start, seed, max_evals: Some(evals), deadline: Instant::now() + Duration::from_secs(60), stop: &stop };
        auto_search(&job).unwrap()
    }

    #[test]
    fn fresh_and_warm_jobs_give_valid_packings_and_a_warm_start_is_not_made_worse() {
        for id in ["curved/-1/0/0/5", "curved/0.1/4/4/6", "curved/1e-06/3/0/4"] {
            let fresh = run(id, None, 7, 12);
            let c = fresh.config.as_ref().unwrap_or_else(|| panic!("{id}: {}", fresh.stopped));
            let score = fresh.score.unwrap();
            assert_eq!(c["size"].as_f64(), Some(score), "{id}");
            assert_eq!(c["pieces"].as_array().unwrap().len(), parse_id(id).unwrap().p as usize);
            let warm = run(id, Some(c), 8, 12);
            assert!(warm.score.unwrap() <= score, "{id}: {} > {score}", warm.score.unwrap());
            assert_eq!(warm.method, METHOD);
        }
    }

    #[test]
    fn the_same_seed_and_budget_give_the_same_packing() {
        let a = run("curved/-0.5/5/6/7", None, 3, 10);
        let b = run("curved/-0.5/5/6/7", None, 3, 10);
        assert_eq!(a.config, b.config);
        assert_eq!(a.evaluations, b.evaluations);
    }

    #[test]
    fn a_bad_start_or_id_is_reported() {
        let r = run("curved/-1/0/0/3", Some(&serde_json::json!({ "size": 2, "pieces": [] })), 1, 5);
        assert!(r.stopped.starts_with("error: the start"), "{}", r.stopped);
        let stop = AtomicBool::new(false);
        let job = AutoJob { id: "curved/x/0/0/3", start: None, seed: 1, max_evals: Some(1), deadline: Instant::now(), stop: &stop };
        assert!(auto_search(&job).is_err());
    }

    #[test]
    fn the_stop_flag_and_the_deadline_end_a_job() {
        let stop = AtomicBool::new(true);
        let job = AutoJob { id: "curved/-1/0/0/40", start: None, seed: 1, max_evals: None, deadline: Instant::now() + Duration::from_secs(60), stop: &stop };
        let t = Instant::now();
        let r = auto_search(&job).unwrap();
        assert!(t.elapsed() < Duration::from_secs(5));
        assert_eq!(r.stopped, "stop");
        let stop = AtomicBool::new(false);
        let job = AutoJob { id: "curved/-1/0/0/40", start: None, seed: 1, max_evals: None, deadline: Instant::now() + Duration::from_millis(300), stop: &stop };
        let t = Instant::now();
        let r = auto_search(&job).unwrap();
        assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
        assert_eq!(r.stopped, "time");
    }
}
