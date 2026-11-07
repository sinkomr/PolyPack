//! PolyPack's curved 2D family: P congruent pieces (regular N-gons of side 1, or disks of
//! diameter 1) in a regular M-gon or disk container, in the plane of constant curvature K
//! (hyperbolic K < 0, Euclidean K = 0, spherical K > 0). Problem ids `curved/<K>/<N>/<M>/<P>`.
//!
//! The crate is the native port of `packages/curved` and of the curved job of
//! `packages/spaces/src/search/run.ts`:
//!  - [`CurvedProblem`]: ids as the API writes them;
//!  - [`CurvedConfig`]: configurations as the API sends and takes them (serde);
//!  - [`check_config`]: the server's rule for an entry (validateSpaceSubmission), erring strict;
//!  - [`run_job`]: one seeded search job with an evaluation and CPU-time budget and a stop flag.
//!
//! The geometry (homogeneous model, lifted coordinates, exponential-coordinate poses) is described
//! in docs/spaces/CURVED.md; each module names the TypeScript file it follows.
//!
//! ```
//! use polypack_curved::{check_config, run_job_with, Budget, CurvedProblem, JobOptions, Rule};
//! use std::sync::atomic::AtomicBool;
//!
//! // the problem as GET /api/spaces/curved/problems/<id> names it, and what the server knows of it
//! let problem = CurvedProblem::parse("curved/-1/3/6/8").unwrap();
//! let rule = Rule { bound: problem.lower_bound(), certified: Some(1.724148891504105), no_record: false };
//! // a fresh job (no start), 20 restarts and hops or 30 CPU seconds, whichever ends first
//! let stop = AtomicBool::new(false);
//! let opts = JobOptions { rule, ..JobOptions::default() };
//! let budget = Budget { evals: Some(20), cpu_seconds: Some(30.0) };
//! let out = run_job_with(&problem, None, budget, 42, &stop, &opts);
//! let config = out.config.expect("a configuration that passes the rule");
//! assert!(check_config(&problem, &config, &rule).valid);
//! // the `config` of POST /api/spaces/submit
//! let json = serde_json::to_string(&config).unwrap();
//! assert!(json.starts_with("{\"size\":"));
//! ```

// Negated comparisons are deliberate: `!(a < b)` is true for NaN, as in the reference.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
// Index loops over coordinates read as the formulas they implement.
#![allow(clippy::needless_range_loop, clippy::too_many_arguments, clippy::collapsible_match)]

pub mod bound;
mod eval;
pub mod geom;
pub mod job;
pub mod kfun;
mod lbfgs;
mod lp;
mod polish;
pub mod problem;
pub mod rng;
mod search;
pub mod shapes;
pub mod validate;

pub use job::{run_job, run_job_with, Budget, JobOptions, JobOutcome, Termination};
pub use problem::{format_curvature, CurvedConfig, CurvedProblem, IdError, Pose, Space};
pub use validate::{check_config, Rule, Verdict};
