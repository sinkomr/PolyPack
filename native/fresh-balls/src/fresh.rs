//! The client's entry point (`polypack_spaceauto::FreshSearch`): one whole search of one problem of
//! balls in a ball or a solid, `balls/ballin<container>/<P>` (P >= 2), on the calling thread. The
//! search is `solve`, the same as the binary's; the client's stop flag and wall deadline are read
//! where it polls its CPU budget, and each checked improvement is reported as it is recorded.

use crate::{solve_with, Halt};
use polypack_spaceauto::{FreshJob, FreshResult};
use serde_json::Value;

/// Searches `job.id` until the CPU budget, the wall deadline, the stop flag or the evaluation budget
/// ends it. `job.start` is not used. Err for an id this engine does not handle (any piece but a ball).
pub fn fresh_search(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
    let parsed = polypack_balls::parse_balls_id(job.id)?;
    if parsed.problem.piece != "ball" || parsed.p < 2 {
        return Err(format!("fresh-balls does not search {}", job.id));
    }
    crate::shape::Shape::of_name(&parsed.problem.container)?;
    let out = solve_with(
        job.id,
        job.seed,
        job.cpu_seconds,
        job.max_evals.unwrap_or(u64::MAX),
        false,
        Some(Halt { stop: job.stop, wall: job.deadline }),
        Some(on_improve),
    )?;
    Ok(FreshResult { config: out.config, score: out.score, evaluations: out.evaluations, stopped: out.stopped.into(), method: "fresh balls".into() })
}
