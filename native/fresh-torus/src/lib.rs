//! fresh-torus: a search for torus problems (`torus/<family>/<N>/<P>`: P congruent disks or regular N-gons on a
//! flat square, hexagonal or free torus), written from scratch for the fresh-solvers benchmark (native/FRESH.md).
//!
//! - [`geom`]: shapes, lattices, the exact separation and the repair used before every check;
//! - [`model`]: the smooth penalty energy (separating lines for polygons) at a fixed score, with exact
//!   gradients, the free cell's shape among the variables;
//! - [`lbfgs`]: the minimiser;
//! - [`lattice`]: constructive lattice arrangements (the always-valid first packing, and restarts);
//! - [`search`]: basin hopping at a score just below the best, the secant polish, the check.
//!
//! It reads only the problem definitions (the id, conventions and score) and calls the server's check
//! (`polypack_spaces::validate_space_submission`) on candidates, never in its loops.

pub mod budget;
pub mod geom;
pub mod lattice;
pub mod lbfgs;
pub mod model;
pub mod rng;
pub mod search;

use budget::Budget;
use geom::Family;
use polypack_spaceauto::{FreshJob, FreshResult};
use search::Search;
use serde_json::Value;

/// A torus problem: family, N (0 = disk) and P.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Problem {
    pub family: Family,
    pub n: usize,
    pub p: usize,
}

/// Parses `torus/<family>/<N>/<P>` (the server's id rule decides what exists).
pub fn parse_id(id: &str) -> Result<Problem, String> {
    polypack_spaces::parse_space_id(polypack_spaces::SpaceName::Torus, id)?;
    let parts: Vec<&str> = id.split('/').collect();
    let family = Family::parse(parts[1]).ok_or_else(|| format!("{id}: unknown torus family"))?;
    let n: usize = parts[2].parse().map_err(|_| format!("{id}: bad N"))?;
    let p: usize = parts[3].parse().map_err(|_| format!("{id}: bad P"))?;
    if !(n == 0 || (3..=100).contains(&n)) || !(1..=500).contains(&p) {
        return Err(format!("{id}: N or P out of range"));
    }
    Ok(Problem { family, n, p })
}

/// Statistics of a run (development).
pub struct RunInfo {
    pub result: FreshResult,
    pub trace: Vec<(f64, f64)>,
    pub stats: String,
}

/// One whole search (see `polypack_spaceauto::fresh`): one thread; stops at the CPU budget, the wall deadline,
/// the stop flag, the evaluation budget or the problem's lower bound; starts from `job.start` when it is a valid
/// packing (and returns nothing worse); calls `on_improve` with each checked improvement. `Err` for ids that are
/// not torus problems.
pub fn fresh_search(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
    run(job, on_improve).map(|r| r.result)
}

/// `fresh_search` with the trace and statistics.
pub fn run(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<RunInfo, String> {
    let pb = parse_id(job.id)?;
    let budget = Budget::new(job.cpu_seconds, job.max_evals, Some(job.deadline), Some(job.stop));
    let mut search = Search::new(job.id, pb.family, pb.n, pb.p, job.seed, budget, on_improve);
    if let Some(start) = job.start {
        search.take_start(start);
    }
    search.run();
    let st = &search.stats;
    let stats = format!(
        "evals {} (polish {}) hops {} accepted {} same {} polishes {} restarts {} improvements {} checks {} refused {} relax {} iters {} rebuilds {}",
        search.model.evals,
        st.polish_evals,
        st.hops,
        st.accepted,
        st.same,
        st.polishes,
        st.restarts,
        st.improvements,
        st.checks,
        st.refused,
        search.model.stat_relax,
        search.model.stat_iters,
        search.model.stat_rebuilds
    );
    let reason = if search.model.budget.reason.is_empty() { "cpu" } else { search.model.budget.reason };
    let score = if search.best_s.is_finite() { Some(search.best_s) } else { None };
    Ok(RunInfo {
        result: FreshResult { config: search.best_cfg.clone(), score, evaluations: search.model.evals, stopped: reason.to_string(), method: "fresh torus".to_string() },
        trace: search.trace.clone(),
        stats,
    })
}
