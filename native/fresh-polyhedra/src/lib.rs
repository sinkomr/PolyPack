//! fresh-polyhedra: a search for P congruent convex polyhedra in the smallest scaled polyhedron
//! (`polyhedra/<piece>in<container>/<P>`) or ball (`balls/<solid>inball/<P>`), written from scratch for the
//! fresh-solvers benchmark (native/FRESH.md). The method is in README.md and search.rs.

pub mod energy;
pub mod lbfgs;
pub mod model;
pub mod repair;
pub mod rng;
pub mod search;

use lbfgs::Budget;
use model::Problem;
use polypack_flat::clock::thread_cpu_seconds;
use polypack_spaceauto::{FreshJob, FreshResult};
use repair::{check_or_enlarge, Packing};
use serde_json::Value;

/// What a run gives: the best checked packing and the trace of checked improvements.
pub struct RunOutput {
    pub score: Option<f64>,
    pub config: Option<Value>,
    pub evaluations: u64,
    /// (CPU seconds, best score) at each checked improvement.
    pub trace: Vec<(f64, f64)>,
    pub stats: String,
    /// Why it ended: "cpu", "deadline", "stop", "evals" or "bound".
    pub stopped: String,
}

/// One search of a problem: `budget` bounds it, `start` (a valid configuration) is where it begins, and
/// `on_improve(score, config)` is called at each checked improvement after the start.
fn run(
    prob: &Problem,
    seed: u64,
    budget: Budget,
    start: Option<&Value>,
    verbose: bool,
    on_improve: &mut dyn FnMut(f64, &Value),
) -> RunOutput {
    let t0 = budget.t0;
    let mut trace: Vec<(f64, f64)> = Vec::new();
    let mut best: Option<(f64, Value)> = None;
    // a start counts only when it is a valid configuration of this problem
    let start_pk = start.and_then(|v| {
        let score = repair::check(prob, v).or_else(|| repair::check_default(prob, v))?;
        let pk = Packing::from_json(v)?;
        (pk.poses.len() == prob.p).then_some((pk, score, v.clone()))
    });
    if let Some((_, score, cfg)) = &start_pk {
        best = Some((*score, cfg.clone()));
    }
    let seconds = budget.seconds;
    // with an evaluation budget the run must be a function of (id, seed, budget): no decisions on the clock
    let timed = budget.max_evals == u64::MAX;
    let mut search = search::Search::new(prob, seed, budget);
    {
        // the check's cost per tight pair (CPU seconds) and when the last check ended
        let mut unit = 0.0f64;
        let mut last_end = f64::NEG_INFINITY;
        let mut offer = |pk: &Packing, ctx: search::OfferCtx| -> Option<f64> {
            let now = thread_cpu_seconds() - t0;
            let cost = unit * (pk.tight + 1) as f64;
            // a polish's trial on the way: not when checks would take more than a fifth of the time
            if timed && ctx.interim && now - last_end < 4.0 * cost {
                return None;
            }
            // not a check that would end long after the budget (large problems: a check takes up to ~0.5 s)
            let remaining = (seconds - now).max(0.0);
            if timed && (ctx.stopped || remaining < 2.0 * cost) && 2.0 * cost - remaining > 0.15 {
                return None;
            }
            let c0 = thread_cpu_seconds();
            let checked = check_or_enlarge(prob, pk);
            let c1 = thread_cpu_seconds();
            if verbose {
                eprintln!("check at {now:.3}: {:.3} s (estimate {cost:.3}, {} tight pairs, interim {}, stopped {})", c1 - c0, pk.tight, ctx.interim, ctx.stopped);
            }
            // a check with few tight pairs is mostly its fixed part: it sets the unit only when there is none yet
            if pk.tight >= 8 || unit == 0.0 {
                unit = (c1 - c0) / (pk.tight + 1) as f64;
            }
            last_end = c1 - t0;
            let (score, cfg, _) = checked?;
            if best.as_ref().is_none_or(|b| score < b.0) {
                let t = thread_cpu_seconds() - t0;
                trace.push((t, score));
                if verbose {
                    eprintln!("t {t:.3} best {score:.12}");
                }
                on_improve(score, &cfg);
                best = Some((score, cfg));
            }
            Some(score)
        };
        search.run(start_pk.as_ref().map(|(pk, score, _)| (pk, *score)), &mut offer);
    }
    let st = &search.stats;
    let stats = format!(
        "evals {} (polish {} in {} trials, {} capped) hops {} (same {}, iters {}) accepted {} polishes {} restarts {} improvements {} segments {} rebuilds {} moves {:?} wins {:?} capped steps {} refines {} ({} better) local hops {} cpu {:.2}",
        search.en.evals,
        st.polish_evals,
        st.polish_trials,
        st.polish_capped,
        st.hops,
        st.same,
        st.hop_iters,
        st.accepted,
        st.polishes,
        st.restarts,
        st.improvements,
        st.segments,
        search.en.rebuilds,
        st.moves,
        st.wins,
        search.opt.capped_steps,
        st.refines,
        st.refined,
        st.local_hops,
        thread_cpu_seconds() - t0
    );
    let mut stopped = search.budget.reason.to_string();
    if stopped.is_empty() {
        stopped = "cpu".to_string();
    }
    let (score, config) = match best {
        Some((s, c)) => (Some(s), Some(c)),
        None => (None, None),
    };
    RunOutput { score, config, evaluations: search.en.evals, trace, stats, stopped }
}

/// One run from scratch on a problem id, for the command line (native/FRESH.md).
pub fn solve(id: &str, seed: u64, seconds: f64, max_evals: u64, verbose: bool) -> Result<RunOutput, String> {
    let prob = Problem::parse(id)?;
    let budget = Budget::new(max_evals, seconds);
    Ok(run(&prob, seed, budget, None, verbose, &mut |_, _| {}))
}

/// True for the ids this engine searches, from the id alone: `polyhedra/<pair>/<P>` and
/// `balls/<solid>inball/<P>` (balls in a ball or a solid are fresh-balls'). `fresh_search` may still answer
/// Err for one of them (an unknown code), and the client then falls back to the port.
pub fn handles(id: &str) -> bool {
    let parts: Vec<&str> = id.split('/').collect();
    match parts.as_slice() {
        ["polyhedra", code, p] => code.contains("in") && p.parse::<usize>().is_ok(),
        ["balls", code, p] => code.ends_with("inball") && !code.starts_with("ballin") && p.parse::<usize>().is_ok(),
        _ => false,
    }
}

/// The fresh engines' entry point (polypack_spaceauto::fresh): one whole search of a polyhedra problem or of
/// solids in a ball. Err for any other id.
pub fn fresh_search(job: &FreshJob, on_improve: &mut dyn FnMut(f64, &Value)) -> Result<FreshResult, String> {
    let prob = Problem::parse(job.id)?;
    let mut budget = Budget::new(job.max_evals.unwrap_or(u64::MAX), job.cpu_seconds);
    budget.deadline = Some(job.deadline);
    budget.stop = Some(job.stop);
    let out = run(&prob, job.seed, budget, job.start, false, on_improve);
    Ok(FreshResult {
        config: out.config,
        score: out.score,
        evaluations: out.evaluations,
        stopped: out.stopped,
        method: "fresh polyhedra".to_string(),
    })
}

#[cfg(test)]
mod handles_tests {
    #[test]
    fn claims_polyhedra_and_solids_in_a_ball_only() {
        assert!(super::handles("polyhedra/cubintet/7"));
        assert!(super::handles("balls/tetinball/12"));
        assert!(!super::handles("balls/ballinball/12"));
        assert!(!super::handles("balls/ballincub/12"));
        assert!(!super::handles("sphere/0/12"));
        assert!(!super::handles("polyhedra/cubintet/x"));
    }
}
