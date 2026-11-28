//! The client's entry point (`polypack_spaceauto::FreshSearch`): one whole search of one disk problem,
//! `curved/<K>/0/<M>/<P>` with K = -1 or 1 and `sphere/0/<P>` (P >= 2), on the calling thread.
//!
//! The search reads its CPU clock through the `clock` closure it is given; this adapter hands it a clock
//! that jumps to the deadline when the client's stop flag is set or the wall deadline has passed, so the
//! search ends where it ends for a CPU deadline. Each checked improvement is reported as it is recorded.

use crate::model::{Curved, Sphere};
use crate::search::{Budget, Params, Report, Search};
use crate::{check, default_params, Problem};
use polypack_flat::clock::thread_cpu_seconds;
use polypack_spaceauto::{FreshJob, FreshResult};
use serde_json::Value;
use std::cell::Cell;
use std::sync::atomic::Ordering;
use std::time::Instant;

/// True when this engine searches the problem (the catalogue's curvatures are +-1 here; a tiny |K| would
/// lose digits in the forms that divide by K).
pub fn handles(problem: &Problem) -> bool {
    match *problem {
        Problem::Curved { k, .. } => k == 1.0 || k == -1.0,
        Problem::Sphere { .. } => true,
    }
}

/// True when `fresh_search` searches this id.
pub fn handles_id(id: &str) -> bool {
    Problem::parse(id).is_some_and(|p| handles(&p))
}

fn run(problem: &Problem, seed: u64, budget: Budget, params: Params, clock: &dyn Fn() -> f64, checker: &mut dyn FnMut(&Value) -> Option<f64>) -> Report {
    match *problem {
        Problem::Curved { k, m, p } => Search::new(Curved::new(k, m, p), seed, budget, params, clock, checker).run(),
        Problem::Sphere { p } => Search::new(Sphere::new(p), seed, budget, params, clock, checker).run(),
    }
}

/// Searches `job.id` until the CPU budget, the wall deadline, the stop flag or the evaluation budget
/// ends it. `job.start` is not used. Err for an id this engine does not handle.
pub fn fresh_search(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
    let problem = Problem::parse(job.id).filter(handles).ok_or_else(|| format!("fresh-round does not search {}", job.id))?;
    if !problem.can_exist() {
        // no packing exists by the catalogue's own bound: nothing to search
        return Ok(FreshResult { config: None, score: None, evaluations: 0, stopped: "impossible".into(), method: "fresh round".into() });
    }
    let t0 = thread_cpu_seconds();
    let deadline = t0 + job.cpu_seconds;
    // why the clock ran out: 0 not yet, 1 the stop flag, 2 the wall deadline
    let why = Cell::new(0u8);
    let clock = || {
        let cpu = thread_cpu_seconds();
        if why.get() == 0 {
            if job.stop.load(Ordering::Relaxed) {
                why.set(1);
            } else if Instant::now() >= job.deadline {
                why.set(2);
            }
        }
        if why.get() != 0 {
            cpu.max(deadline)
        } else {
            cpu
        }
    };
    let id = job.id;
    let space = problem.space();
    let mut best = f64::INFINITY;
    let mut checker = |c: &Value| {
        let score = check(space, id, c)?;
        if score < best {
            best = score;
            on_improve(score, c);
        }
        Some(score)
    };
    let report = run(&problem, job.seed, Budget { deadline, max_evals: job.max_evals }, default_params(&problem), &clock, &mut checker);
    let stopped = match why.get() {
        1 => "stop",
        2 => "deadline",
        _ if job.max_evals.is_some_and(|e| report.evaluations >= e) => "evals",
        _ => "cpu",
    };
    let (config, score) = match report.best {
        Some(f) => (Some(f.config), Some(f.score)),
        None => (None, None),
    };
    Ok(FreshResult { config, score, evaluations: report.evaluations, stopped: stopped.into(), method: "fresh round".into() })
}
