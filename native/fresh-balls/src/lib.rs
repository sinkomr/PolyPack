//! fresh-balls: a search for P balls of diameter 1 in the smallest ball or scaled solid, written from scratch
//! for the fresh-solvers benchmark (native/FRESH.md). The method is in README.md and search.rs.

pub mod energy;
pub mod fresh;
pub mod lbfgs;
pub mod rng;
pub mod search;
pub mod shape;

use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};
use serde_json::{json, Value};

/// The configuration in the submission format: {"s": s, "pieces": [[x, y, z], ...]}.
pub fn config_json(s: f64, x: &[f64]) -> Value {
    let pieces: Vec<Value> = x.chunks(3).map(|c| json!([c[0], c[1], c[2]])).collect();
    json!({ "s": s, "pieces": pieces })
}

/// The check the native client applies before it submits: the server's validator with the default options.
/// Some(score) when valid.
pub fn check(id: &str, config: &Value) -> Option<f64> {
    let v = validate_space_submission(SpaceName::Balls, id, config, &SpaceValidateOptions::default());
    if v.valid {
        v.score
    } else {
        None
    }
}

/// A packing at size s checked as it is, or with s enlarged by a hair (1e-12 relative, then 1e-10, ...) when the
/// check refuses it; the checked score and configuration.
pub fn check_or_enlarge(id: &str, s: f64, x: &[f64]) -> Option<(f64, Value)> {
    let mut st = s;
    for k in 0..5 {
        let cfg = config_json(st, x);
        if let Some(score) = check(id, &cfg) {
            return Some((score, cfg));
        }
        st = s * (1.0 + 1e-12 * 100f64.powi(k));
    }
    None
}

/// What a run gives: the best checked packing and the trace of checked improvements.
pub struct RunOutput {
    pub score: Option<f64>,
    pub config: Option<Value>,
    pub evaluations: u64,
    /// (CPU seconds, best score) at each checked improvement.
    pub trace: Vec<(f64, f64)>,
    pub stats: String,
    /// Why the run ended: "evals", "cpu", "deadline" or "stop".
    pub stopped: &'static str,
}

/// The client's way to end a run early (`fresh::fresh_search`): a flag and a wall-clock end.
pub struct Halt<'a> {
    pub stop: &'a std::sync::atomic::AtomicBool,
    pub wall: std::time::Instant,
}

/// One run on a problem id (balls/ballin<container>/<P>), from scratch.
pub fn solve(id: &str, seed: u64, seconds: f64, max_evals: u64, verbose: bool) -> Result<RunOutput, String> {
    solve_with(id, seed, seconds, max_evals, verbose, None, None)
}

/// `solve` that also ends at `halt` and reports each checked improvement to `on_improve`.
pub fn solve_with(
    id: &str,
    seed: u64,
    seconds: f64,
    max_evals: u64,
    verbose: bool,
    halt: Option<Halt>,
    mut on_improve: Option<&mut dyn FnMut(f64, &Value)>,
) -> Result<RunOutput, String> {
    use polypack_flat::clock::thread_cpu_seconds;
    let t0 = thread_cpu_seconds();
    let parsed = polypack_balls::parse_balls_id(id)?;
    if parsed.problem.piece != "ball" {
        return Err(format!("{id}: only ball pieces are searched"));
    }
    let shape = shape::Shape::of_name(&parsed.problem.container)?;
    let p = parsed.p as usize;
    let mut search = search::Search::new(&shape, p, seed, max_evals, seconds);
    if let Some(h) = &halt {
        search.budget.stop = Some(h.stop);
        search.budget.wall = Some(h.wall);
    }
    let mut trace: Vec<(f64, f64)> = Vec::new();
    let mut best: Option<(f64, Value)> = None;
    {
        let mut offer = |s: f64, x: &[f64]| -> Option<f64> {
            let (score, cfg) = check_or_enlarge(id, s, x)?;
            if best.as_ref().is_none_or(|b| score < b.0) {
                let t = thread_cpu_seconds() - t0;
                trace.push((t, score));
                if verbose {
                    eprintln!("t {t:.3} best {score:.10}");
                }
                if let Some(cb) = on_improve.as_mut() {
                    cb(score, &cfg);
                }
                best = Some((score, cfg));
            }
            Some(score)
        };
        search.run(&mut offer);
    }
    let st = &search.stats;
    let stats = format!(
        "evals {} (polish {}) hops {} (same {}, iters {} same {}) accepted {} polishes {} restarts {} improvements {} rebuilds {} cpu {:.2}",
        search.en.evals,
        st.polish_evals,
        st.hops,
        st.same,
        st.hop_iters,
        st.same_iters,
        st.accepted,
        st.polishes,
        st.restarts,
        st.improvements,
        search.en.rebuilds,
        thread_cpu_seconds() - t0
    );
    let (score, config) = match best {
        Some((s, c)) => (Some(s), Some(c)),
        None => (None, None),
    };
    let stopped = if search.budget.reason.is_empty() { "cpu" } else { search.budget.reason };
    Ok(RunOutput { score, config, evaluations: search.en.evals, trace, stats, stopped })
}
