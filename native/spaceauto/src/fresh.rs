//! The interface of the fresh engines: searches written from scratch (native/FRESH.md), one per kind of
//! problem, each tuned to its own geometry. Unlike an [`AutoSearch`](crate::AutoSearch) job, one call is a
//! whole search of one problem on one thread: it plans its own schedule (relaxations, hops, restarts) within
//! the budget and returns the best packing it found.
//!
//! The client runs one call per thread it gives a problem (different seeds) and keeps the best result.
//!
//! Problem ids: a space's own id as the server writes it (`polyhedra/<piece>in<container>/<P>`,
//! `balls/ballin<container>/<P>`, `sphere/<N>/<P>`, `curved/<K>/<N>/<M>/<P>`, `torus/<family>/<N>/<P>`),
//! and for a flat problem (polygons or disks in a polygon or circle; N = 0 is a disk, M = 0 a circle)
//! `flat/<N>/<M>/<P>`. The id is only the engines' and the client's name for it: the flat problem itself
//! is read and submitted through /api/problems/N/M/P, not the spaces' API.
//!
//! Contract of every engine (`FreshSearch`):
//! - One thread, no global state; two calls may run at once on different threads.
//! - Budget: stop when this thread's CPU time since the call reaches `cpu_seconds`, when the wall clock
//!   passes `deadline`, when `stop` is set, or after `max_evals` evaluations if given (then a run is a function
//!   of (id, seed, start, max_evals) only). Check them at least every few milliseconds of work; return within
//!   about 0.2 s of any of them.
//! - Validity: every packing passed to `on_improve` and the one returned have passed
//!   `polypack_spaces::validate_space_submission(space, id, config, &SpaceValidateOptions::default())`
//!   (or `polypack_flat::validate::server_check` with `valid && strict` for flat ids), and `score` is the
//!   score that check computed. Never inside the inner loop: only for candidates.
//! - `start`: a valid configuration of the problem in its submission format (usually the site leader's).
//!   An engine that can use it starts from it (and returns nothing worse than it); one that cannot ignores it.
//! - `on_improve(score, config)` is called each time the best checked packing improves, in time order.
//! - `Err` only when the engine does not handle this id (the client then falls back to the port).

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// One whole search of one problem.
pub struct FreshJob<'a> {
    /// The problem id as the server writes it, e.g. "polyhedra/cubintet/7", "balls/ballinball/13",
    /// "sphere/0/24", or "flat/<N>/<M>/<P>" for a flat problem.
    pub id: &'a str,
    pub seed: u64,
    /// CPU seconds of the calling thread the search may use.
    pub cpu_seconds: f64,
    /// Wall-clock end, whatever the CPU time (a loaded machine, a pause).
    pub deadline: Instant,
    /// Set by the client to end the search early; it then returns its best so far.
    pub stop: &'a AtomicBool,
    /// A valid configuration to start from, or None: from scratch.
    pub start: Option<&'a Value>,
    /// Evaluation budget, for reproducible runs; None for time alone.
    pub max_evals: Option<u64>,
}

impl FreshJob<'_> {
    /// True when the stop flag is set or the wall deadline has passed (the CPU budget is the engine's to check).
    pub fn stopped_or_late(&self) -> bool {
        self.stop.load(Ordering::Relaxed) || Instant::now() >= self.deadline
    }
}

/// What one search produced.
#[derive(Debug, Clone)]
pub struct FreshResult {
    /// The best checked packing, in the submission format, or None.
    pub config: Option<Value>,
    /// Its checked score.
    pub score: Option<f64>,
    pub evaluations: u64,
    /// Why it ended: "cpu", "deadline", "stop", "evals", or "bound" (reached the problem's lower bound).
    pub stopped: String,
    /// The method a submission records, e.g. "fresh polyhedra".
    pub method: String,
}

/// Every engine's entry point.
pub type FreshSearch = fn(&FreshJob, &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String>;
