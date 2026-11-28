//! The client's entry point (`polypack_spaceauto::FreshSearch`): one whole search of one problem
//! `surface/<solid>/fold/<N>/<P>` on the calling thread. The search reads its CPU clock through a
//! closure; this adapter hands it a clock that jumps to the deadline when the client's stop flag is set
//! or the wall deadline has passed, so the search ends as it ends at its CPU deadline. Each checked
//! improvement is reported as it is recorded. A valid `start` is the first best (not reported): nothing worse is
//! returned.

use crate::model::Budget;
use crate::search::Search;
use crate::{check, Problem};
use polypack_flat::clock::thread_cpu_seconds;
use polypack_spaceauto::{FreshJob, FreshResult};
use serde_json::Value;
use std::cell::Cell;
use std::sync::atomic::Ordering;
use std::time::Instant;

/// True when `fresh_search` searches this id (reads the id only).
pub fn handles(id: &str) -> bool {
    crate::parse_fields(id).is_some()
}

/// Searches `job.id` until the CPU budget, the wall deadline, the stop flag or the evaluation budget
/// ends it. Err for an id this engine does not handle.
pub fn fresh_search(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
    if !handles(job.id) {
        return Err(format!("fresh-surface-fold does not search {}", job.id));
    }
    let prob = Problem::parse(job.id).ok_or_else(|| format!("fresh-surface-fold does not search {}", job.id))?;
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
    let id = job.id.to_string();
    let mut best = f64::INFINITY;
    let mut checker = |c: &Value| {
        let score = check(&id, c)?;
        if score < best {
            best = score;
            on_improve(score, c);
        }
        Some(score)
    };
    let budget = Budget::new(deadline, job.max_evals, &clock);
    let search = Search::new(&prob, job.seed, budget, &mut checker)?;
    let report = search.run(job.start);
    let stopped = match why.get() {
        1 => "stop",
        2 => "deadline",
        _ => report.stopped,
    };
    let (config, score) = match report.best {
        Some(b) => (Some(b.config), Some(b.score)),
        None => (None, None),
    };
    Ok(FreshResult { config, score, evaluations: report.evaluations, stopped: stopped.into(), method: "fresh surface fold".into() })
}
