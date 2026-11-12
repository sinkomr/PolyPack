//! PolyPack's curved 2D family: P congruent pieces (regular N-gons of side 1, or disks of
//! diameter 1) in a regular M-gon or disk container, in the plane of constant curvature K
//! (hyperbolic K < 0, Euclidean K = 0, spherical K > 0). Problem ids `curved/<K>/<N>/<M>/<P>`.
//!
//! The crate is the native port of `packages/curved` and of the curved job of
//! `packages/spaces/src/search/run.ts`. It serves two programs.
//!
//! The Rust server, which must answer as the TypeScript server does (native/PORTING.md). What
//! `packages/spaces` and `apps/server` import from `@polypack/curved` and `@polypack/curved/bound`:
//!  - [`validation_steps`]: the float validator (`validationSteps` of validate.ts), a line-by-line
//!    port with the TypeScript's verdict, reasons and numbers;
//!  - [`container_circumradius`], [`piece_exists`] (shapes.ts);
//!  - [`curved_max_p`], [`curved_bound_of`], [`curved_why_not`], [`CURVED_MAX_P`] (bound.ts);
//!  - [`CurvedConfig`], the type of a parsed configuration.
//!
//! Modules `kfun`, `shapes`, `geom` (space.ts), `problem`, `evaluate`, `bound` and `validate` are
//! these ports, each function named after its source. They are compared with the TypeScript, case
//! by case, by `native/tools/curved-ref.mts`, `examples/curveddiff.rs` and
//! `native/tools/curved-compare.mjs`, and `tests/fixtures.rs` holds a sample of that comparison.
//!
//! The volunteer search client:
//!  - [`CurvedProblem`]: ids as the API writes them;
//!  - [`check_config`]: the server's rule for an entry (validateSpaceSubmission), erring strict;
//!  - [`run_job`]: one seeded search job with an evaluation and CPU-time budget and a stop flag.
//!
//! The search (modules `eval`, `search`, `polish`, `job`, the solvers) shares `kfun`, `shapes`,
//! `geom` and `problem` with the validator; its seeded results are reproducible, and those modules
//! compute the same doubles as before the validator was audited against the TypeScript.
//!
//! The geometry (homogeneous model, lifted coordinates, exponential-coordinate poses) is described
//! in docs/spaces/CURVED.md; each module names the TypeScript file it follows.
//!
//! JSON: read configurations with correctly rounded floats (serde_json with its `float_roundtrip`
//! feature). The default float parser of serde_json can be one unit in the last place off, which
//! is enough to move a touching configuration across the strict tolerance; serialization is exact
//! either way.
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

mod basis;
pub mod bound;
mod dual_lp;
mod eval;
pub mod evaluate;
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

pub use bound::{curved_bound_of, curved_max_p, curved_why_not, CURVED_MAX_P};
pub use job::{run_job, run_job_with, Budget, JobOptions, JobOutcome, Termination};
pub use problem::{format_curvature, CurvedConfig, CurvedProblem, IdError, Pose, Space};
pub use shapes::{container_circumradius, piece_exists};
pub use validate::{check_config, Rule, Verdict};
pub use validate::{validate, validation_steps, ValidationContact, ValidationOptions, ValidationResult};
