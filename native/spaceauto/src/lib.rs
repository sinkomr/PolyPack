//! The interface between the personal 2D-on-3D sweep (native/client) and the Auto searches of the
//! 2D-on-3D spaces: surface (fold and nofold), sphere and torus. One job goes in, its best packing
//! comes out. Each space crate implements it in its `auto` module as a port of that space's branch of
//! packages/spaces/src/search/run.ts (`runSpaceJob`), without pausing: the client stops a job by
//! setting `stop`, and its time budget is `deadline`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

pub mod fresh;
pub use fresh::{FreshJob, FreshResult, FreshSearch};

/// One search job on one 2D-on-3D problem.
pub struct AutoJob<'a> {
    /// The problem id as the server writes it, e.g. "sphere/4/12".
    pub id: &'a str,
    /// A packing to start from, in the space's submission format (usually the site leader's), or
    /// `None` for a fresh start.
    pub start: Option<&'a serde_json::Value>,
    /// The job's seed, 0 to 2^32 - 1, as the TypeScript job's seed.
    pub seed: u32,
    /// The evaluation budget, as the TypeScript job's `budget.evals`; `None` for time alone.
    pub max_evals: Option<u64>,
    /// When the job's time budget ends.
    pub deadline: Instant,
    /// Set by the client to end the job early; the search then returns its best so far.
    pub stop: &'a AtomicBool,
}

impl AutoJob<'_> {
    /// True when the search should end now: stopped, or past its deadline. The searches call it
    /// where the TypeScript searches poll their Gate.
    pub fn should_stop(&self) -> bool {
        self.stop.load(Ordering::Relaxed) || Instant::now() >= self.deadline
    }
}

/// What one job produced.
#[derive(Debug, Clone)]
pub struct AutoResult {
    /// The best packing found, in the space's submission format (the `config` of POST
    /// /api/spaces/submit), valid by the space's own validator; `None` when the job found none.
    pub config: Option<serde_json::Value>,
    /// Its score as the space's validator computes it, which is the server's score.
    pub score: Option<f64>,
    /// Evaluations spent, as the TypeScript job counts them.
    pub evaluations: u64,
    /// Why the search ended: "time", "evals", "stop", "bound", or "error: <message>".
    pub stopped: String,
    /// The method name a submission records, as the TypeScript client writes it (e.g. "sphere auto").
    pub method: String,
}

/// The signature every space's `auto::auto_search` has. `Err` only for an id the space cannot model.
pub type AutoSearch = fn(&AutoJob) -> Result<AutoResult, String>;
