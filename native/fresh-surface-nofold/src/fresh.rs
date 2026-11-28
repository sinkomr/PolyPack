//! The client's entry point (`polypack_spaceauto::FreshSearch`): one whole search of one problem
//! `surface/<solid>/nofold/<N>/<P>` (N = 0 or 3 to 100, P = 1 to 100) on the calling thread. The search is
//! [`crate::solve`], the same as the binary's; the client's stop flag and wall deadline are read where it
//! polls its CPU budget, each checked improvement is reported as it is recorded, and a valid `start` is the
//! best to beat (it is returned when nothing better is found) and seeds the face problems.

use crate::{solve, Halt};
use polypack_spaceauto::{FreshJob, FreshResult};
use serde_json::Value;

/// True when `fresh_search` searches this id (from the id alone).
pub fn handles(id: &str) -> bool {
    crate::solid::parse_id(id).is_some()
}

/// Searches `job.id` until the CPU budget, the wall deadline, the stop flag or the evaluation budget ends
/// it. Err for an id this engine does not handle.
pub fn fresh_search(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
    if !handles(job.id) {
        return Err(format!("fresh-surface-nofold does not search {}", job.id));
    }
    let halt = Some(Halt { stop: job.stop, wall: job.deadline });
    let out = solve(job.id, job.seed, job.cpu_seconds, job.max_evals, job.start, halt, Some(on_improve))?;
    Ok(FreshResult { config: out.config, score: out.score, evaluations: out.evaluations, stopped: out.stopped.into(), method: "fresh surface nofold".into() })
}
