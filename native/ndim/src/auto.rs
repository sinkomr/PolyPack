//! The nD space's Auto search for the personal client: a port of the `ndim` branch of
//! `runSpaceJob`, `runEngine` and `runGeneric` in packages/spaces/src/search/run.ts, with
//! `readSpaceConfig` and `checkSpaceConfig` of packages/spaces/src/search/model.ts.
//!
//! Auto has no engine of its own in the nD space: it is the generic basin hopping
//! (`AUTO_NDIM_METHOD`, polypack-methods `basin`) on the problem's kernel (kernel.rs). The job's id
//! is parsed as `parseSearchProblem` does; the start, when given, is read as `readSpaceConfig` does
//! and is itself a candidate (`consider(start)`) and the method's start; the method runs with the
//! job's seed and evaluation budget (`budget.evals`; without one it runs on the stop alone, as the
//! source does, so a method does not size its work to a cap it does not have), polling
//! `job.should_stop()` where the TypeScript polls its Gate; and the configuration it returns is
//! checked by the server's own rule (`check_config`: the form and the check at the tolerance 1e-9,
//! with the default rule: no bound, no certified size) before it is kept, as `consider` does. The
//! best of the valid candidates, by the validator's score, is the result.
//!
//! The method also keeps an improvement only when it passes the same rule (the kernel's `validate`
//! is replaced by it, as `runGeneric` does).

use crate::kernel::{load_problem, NdKernel};
use crate::problem::NdConfig;
use crate::space::{nd_check, nd_in_range, parse_nd_id, NdProblemId, ND_BALL, ND_MAX_P, NDIM_MAX_REASONS};
use polypack_js::math;
use polypack_methods::basin::run_basin_hopping;
use polypack_methods::framework::{run_method, RunOptions, Stopped};
use polypack_methods::kernel::Validation;
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};
use std::cell::Cell;
use std::sync::atomic::Ordering;

/// The method name the TypeScript client records for an ndim Auto result
/// (`SPACE_METHOD.ndim` of packages/spaces/src/search/model.ts; `spaceMethodName`).
pub const METHOD: &str = "ndim basin hopping";

/// packages/spaces/src/info.ts: `SPACE_TOL`, the tolerance of the server's check.
const SPACE_TOL: f64 = 1e-9;

/// model.ts: `parseSearchProblem`, the ndim case: `ndim/<d>/<piece>/<container>/<P>` with the
/// dimension's P range and at most ND_MAX_P pieces. (The id is at most 120 UTF-16 code units; the
/// ndim parser's own limit is stricter.)
pub fn parse_id(id: &str) -> Option<NdProblemId> {
    if id.encode_utf16().count() > 120 {
        return None;
    }
    if !id.starts_with("ndim/") {
        return None;
    }
    let n = parse_nd_id(id).ok()?;
    if !nd_in_range(n.d, n.p) || n.p > ND_MAX_P {
        return None;
    }
    Some(n.problem())
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// model.ts: `readSpaceConfig`, the ndim case: a clean copy of a configuration, or `None` when it is
/// malformed: s positive and finite, P poses that are arrays of finite numbers, d + d(d - 1)/2 of
/// them (and an optional flip) for a polytope, d (the centre) for a ball.
pub fn read_config(p: &NdProblemId, v: &Value) -> Option<NdConfig> {
    let obj = v.as_object()?;
    let s = finite(obj.get("s")?).filter(|&x| x > 0.0)?;
    let list = obj.get("pieces")?.as_array()?;
    if list.len() != p.p as usize {
        return None;
    }
    // a ball is its centre (d numbers); a polytope d + d(d-1)/2 numbers and an optional flip
    let d = p.d as usize;
    let m = (d * (d - 1)) / 2;
    let lengths: &[usize] = if p.piece == ND_BALL { &[d] } else { &[d + m, d + m + 1] };
    let mut pieces: Vec<Vec<f64>> = Vec::with_capacity(list.len());
    for q in list {
        let q = q.as_array()?;
        if !lengths.contains(&q.len()) {
            return None;
        }
        pieces.push(q.iter().map(finite).collect::<Option<Vec<f64>>>()?);
    }
    Some(NdConfig { s, pieces })
}

/// model.ts: `checkSpaceConfig` with the job's default rule, which is `validateSpaceSubmission` of
/// packages/spaces/src/validate.ts for the ndim space: a well-formed configuration (the size and
/// the poses, `parse_nd_config_ok`) that passes the validator at the tolerance 1e-9 with the cap on its work. The
/// score is the stated size, and is `None` when the form is wrong. The polytopes must be
/// loaded. A check that fails (the source's `the check failed: ...`) is invalid.
pub fn check_config(p: &NdProblemId, c: &NdConfig) -> Validation {
    if !crate::kernel::parse_nd_config_ok(p, c) {
        return Validation { valid: false, score: None };
    }
    match nd_check(p, c, SPACE_TOL, NDIM_MAX_REASONS) {
        Ok(reasons) if reasons.is_empty() => Validation { valid: true, score: Some(c.s) },
        _ => Validation { valid: false, score: Some(c.s) },
    }
}

/// The configuration as JSON, in the submission format: `{"s": s, "pieces": [[...], ...]}`.
fn config_json(c: &NdConfig) -> Value {
    json!({ "s": c.s, "pieces": c.pieces })
}

/// Why the job's gate ended it (run.ts: `Gate.why`).
#[derive(Clone, Copy, PartialEq)]
enum Why {
    Aborted,
    Time,
}

/// run.ts: `runSpaceJob` for an ndim job on the space's own search (method "auto"). `Err` only for
/// an id that is not an ndim problem.
pub fn auto_search(job: &AutoJob) -> Result<AutoResult, String> {
    let p = parse_id(job.id).ok_or_else(|| format!("not a problem id of ndim: {}", job.id.chars().take(80).collect::<String>()))?;
    let fail = |why: &str| AutoResult {
        config: None,
        score: None,
        evaluations: 0,
        stopped: format!("error: {why}"),
        method: METHOD.to_string(),
    };
    let start = match job.start {
        None => None,
        Some(v) => match read_config(&p, v) {
            Some(c) => Some(c),
            None => return Ok(fail("the start is not a configuration of this problem")),
        },
    };
    // the polytopes that are kept on demand (the client loads them before a job; the check and the kernel need them)
    if let Err(e) = load_problem(&p) {
        return Ok(fail(&e.0));
    }
    // the best valid configuration: the start, then whatever the method returns
    let mut best: Option<(NdConfig, f64)> = None;
    let consider = |c: NdConfig, best: &mut Option<(NdConfig, f64)>| {
        let v = check_config(&p, &c);
        if let (true, Some(score)) = (v.valid, v.score) {
            if best.as_ref().map_or(true, |b| score < b.1) {
                *best = Some((c, score));
            }
        }
    };
    if let Some(c) = &start {
        consider(c.clone(), &mut best);
    }
    // runGeneric: the problem's kernel (a fresh job gets no start)
    let mut kernel = match NdKernel::new(&p) {
        Ok(k) => k,
        Err(_) => return Ok(fail(&format!("{} has no kernel", job.id))),
    };
    let why: Cell<Option<Why>> = Cell::new(None);
    let mut should_stop = |_used: f64, _finishing: bool| -> bool {
        if !job.should_stop() {
            return false;
        }
        // Gate.stopAt: an abort wins, and stays; otherwise the time is up
        if job.stop.load(Ordering::Relaxed) {
            why.set(Some(Why::Aborted));
        } else if why.get().is_none() {
            why.set(Some(Why::Time));
        }
        true
    };
    // the method keeps an improvement only when it passes the job's whole rule
    let mut validate = |c: &NdConfig| check_config(&p, c);
    let out = match run_method(
        &mut kernel,
        RunOptions {
            seed: job.seed,
            start,
            evals: job.max_evals.map(|e| e as f64),
            should_stop: &mut should_stop,
            validate: &mut validate,
        },
        run_basin_hopping,
    ) {
        Ok(r) => r,
        // a plain `throw` of runMethod (the budget is not positive): runSpaceJob returns an error result
        Err(message) => return Ok(fail(&message)),
    };
    // a piece's share of a sweep counts 1/P, so the count can be fractional
    let evaluations = math::round(out.evaluations) as u64;
    if let Some(c) = out.config {
        consider(c, &mut best);
    }
    let stopped = match why.get() {
        Some(Why::Aborted) => "stop".to_string(),
        Some(Why::Time) => "time".to_string(),
        None => match out.stopped {
            Stopped::Evals => "evals".to_string(),
            Stopped::Bound => "bound".to_string(),
            Stopped::Done => "done".to_string(),
            Stopped::Stopped | Stopped::Time => "time".to_string(),
            Stopped::Error => format!("error: {}", out.reasons.first().map(String::as_str).unwrap_or("")),
        },
    };
    Ok(AutoResult {
        config: best.as_ref().map(|(c, _)| config_json(c)),
        score: best.as_ref().map(|b| b.1),
        evaluations,
        stopped,
        method: METHOD.to_string(),
    })
}
