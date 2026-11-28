//! fresh-surface-nofold: a search for `surface/<solid>/nofold/<N>/<P>` written from scratch (native/FRESH.md).
//!
//! - [`solid`]: the problem as face classes (congruent faces) with the maps between their frames;
//! - [`geom`]: the piece and the face polygon, exact separation, exact fit, repair;
//! - [`model`]: the smooth penalty objective of one face problem and its local minimisation;
//! - [`lbfgs`]: the minimiser;
//! - [`lattice`]: periodic arrangements for starts;
//! - [`planar`]: the basin-hopping search of one face problem, resumable in slices;
//! - [`search`]: the assignment of pieces to faces, the schedule over face problems, the check.

pub mod fresh;
pub mod geom;
pub mod lattice;
pub mod lbfgs;
pub mod model;
pub mod planar;
pub mod rng;
pub mod search;
pub mod solid;

use model::Budget;
use polypack_flat::clock::thread_cpu_seconds;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

/// What a run gives: the best checked packing and the trace of checked improvements.
pub struct RunOutput {
    pub score: Option<f64>,
    pub config: Option<Value>,
    pub evaluations: u64,
    /// (CPU seconds, best score) at each checked improvement.
    pub trace: Vec<(f64, f64)>,
    /// Why the run ended: "evals", "cpu", "deadline", "stop" or "bound".
    pub stopped: &'static str,
    pub stats: String,
}

/// The client's way to end a run early: a flag and a wall-clock end.
pub struct Halt<'a> {
    pub stop: &'a AtomicBool,
    pub wall: Instant,
}

/// One run on a problem id, from scratch or from a valid `start`.
pub fn solve<'a>(
    id: &str,
    seed: u64,
    seconds: f64,
    max_evals: Option<u64>,
    start: Option<&Value>,
    halt: Option<Halt<'a>>,
    on_improve: Option<&'a mut dyn FnMut(f64, &Value)>,
) -> Result<RunOutput, String> {
    let t0 = thread_cpu_seconds();
    let prob = solid::Problem::new(id)?;
    let bud = Budget::new(t0 + seconds, max_evals.unwrap_or(u64::MAX), halt.as_ref().map(|h| h.stop), halt.as_ref().map(|h| h.wall));
    let mut eng = search::Engine::new(prob, seed, bud, t0);
    eng.on_improve = on_improve;
    if let Some(st) = start {
        eng.seed_start(st);
    }
    eng.run();
    let stats = format!("slices {} checks {} check_failures {}\n{}", eng.slices, eng.checks, eng.check_failures, eng.summary());
    let (score, config) = match &eng.best_config {
        Some(c) => (Some(eng.best_score), Some(c.clone())),
        None => (None, None),
    };
    Ok(RunOutput { score, config, evaluations: eng.bud.evals, trace: eng.trace.clone(), stopped: eng.stopped, stats })
}
