//! The polyhedra space's Auto search for the personal client: a port of the `polyhedra` branch of `runSpaceJob`
//! and `runEngine` in packages/spaces/src/search/run.ts, with `parseSearchProblem` and `readSpaceConfig` of
//! packages/spaces/src/search/model.ts.
//!
//! The job's id is parsed as `parseSearchProblem` does; the start, when given, is read as `readSpaceConfig` does
//! and is itself a candidate (`consider(start)`); the search is `search_polyhedra` with the job's seed and
//! evaluation budget (the volunteer client never sets `polished`, so the start is polished), polling
//! `job.should_stop()` where the TypeScript polls its Gate; and the packing it returns is checked by the server's
//! rule before it is kept, as `consider` does: the form of the configuration and the validator at the tolerance
//! 1e-9 (no bound, certified size or record rule applies to a job). The best of the two valid candidates, by
//! the validator's score, is the result.

use crate::catalogue::problem_name_of;
use crate::geom::Pose;
use crate::info::POLYHEDRA_MAX_P;
use crate::problems::{get_problem, PolyhedraProblem};
use crate::sim::Why;
use crate::search::{search_polyhedra, PolyhedraSearchOptions};
use crate::validate::{config_errors_typed, validate_polyhedra, PolyhedraConfig, ValidateOptions, POLYHEDRA_TOL};
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};

/// The method name the TypeScript client records for a polyhedra Auto result (`SPACE_METHOD.polyhedra` of
/// packages/spaces/src/search/model.ts).
pub const METHOD: &str = "polyhedra soft-to-rigid search";

/// `Number.MAX_SAFE_INTEGER`: the source's evaluation cap of a job without one.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// packages/spaces/src/validate.ts: `MAX_REASONS`.
const MAX_REASONS: usize = 20;

/// A parsed polyhedra problem id: `{ space: "polyhedra", id, P, code }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolyhedraJobId {
    pub p: usize,
    pub code: String,
}

/// model.ts: `parseSearchProblem`, the polyhedra case: `^polyhedra/([a-z0-9]{6,16})/(\d{1,3})$`, the code a
/// problem of the catalogue, P without leading zeros, from 1 to the catalogue's largest.
pub fn parse_id(id: &str) -> Option<PolyhedraJobId> {
    if id.encode_utf16().count() > 120 {
        return None;
    }
    let mut it = id.split('/');
    if it.next()? != "polyhedra" {
        return None;
    }
    let code = it.next()?;
    let p = it.next()?;
    if it.next().is_some() {
        return None;
    }
    if !(6..=16).contains(&code.len()) || !code.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        return None;
    }
    if !(1..=3).contains(&p.len()) || !p.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: usize = p.parse().ok()?;
    // count(): 1..=MAX_PIECES (500); String(P) !== m[2] refuses leading zeros
    if problem_name_of(code).is_none() || !(1..=500).contains(&n) || n > POLYHEDRA_MAX_P || n.to_string() != p {
        return None;
    }
    Some(PolyhedraJobId { p: n, code: code.to_string() })
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// model.ts: `readSpaceConfig`, the polyhedra case: a clean copy of a configuration, or `None` when it is
/// malformed: `s` positive and finite, P poses of 7 finite numbers.
fn read_config(p: usize, v: &Value) -> Option<PolyhedraConfig> {
    let obj = v.as_object()?;
    let s = finite(obj.get("s")?).filter(|&x| x > 0.0)?;
    let list = obj.get("pieces")?.as_array()?;
    if list.len() != p {
        return None;
    }
    let mut pieces: Vec<Pose> = Vec::with_capacity(p);
    for q in list {
        let q = q.as_array()?;
        if q.len() != 7 {
            return None;
        }
        let mut pose = [0.0f64; 7];
        for (k, x) in q.iter().enumerate() {
            pose[k] = finite(x)?;
        }
        pieces.push(pose);
    }
    Some(PolyhedraConfig { s, pieces })
}

/// The configuration as JSON, in the submission format: `{"s", "pieces": [[x, y, z, qw, qx, qy, qz], ...]}`.
fn config_json(c: &PolyhedraConfig) -> Value {
    json!({ "s": c.s, "pieces": c.pieces })
}

/// model.ts: `checkSpaceConfig`, the polyhedra case with the default rule: the configuration is well formed for P
/// pieces (`parsePolyhedraConfig`), valid by the server's check at the tolerance 1e-9, and then its stated score s.
fn check_config(problem: &PolyhedraProblem, p: usize, c: &PolyhedraConfig) -> Option<f64> {
    if c.pieces.len() != p || !config_errors_typed(c, MAX_REASONS).is_empty() {
        return None;
    }
    let opts = ValidateOptions { tol: Some(POLYHEDRA_TOL), max_errors: Some(MAX_REASONS), stop_at: None };
    match validate_polyhedra(problem, c, &opts) {
        Ok(v) if v.valid => Some(c.s),
        _ => None,
    }
}

/// run.ts: `runSpaceJob` for a polyhedra job on the space's own search (method "auto"). `Err` only for an id that
/// is not a polyhedra problem.
pub fn auto_search(job: &AutoJob) -> Result<AutoResult, String> {
    let id = parse_id(job.id)
        .ok_or_else(|| format!("not a problem id of polyhedra: {}", job.id.chars().take(80).collect::<String>()))?;
    let problem = get_problem(&id.code).ok_or_else(|| format!("unknown polyhedra problem {}", id.code))?;
    let p = id.p;
    let fail = |why: &str| AutoResult {
        config: None,
        score: None,
        evaluations: 0,
        stopped: format!("error: {why}"),
        method: METHOD.to_string(),
    };
    let start = match job.start {
        None => None,
        Some(v) => match read_config(p, v) {
            Some(c) => Some(c),
            None => return Ok(fail("the start is not a configuration of this problem")),
        },
    };
    // the best valid configuration: the start, then whatever the search returns
    let mut best: Option<(PolyhedraConfig, f64)> = None;
    let consider = |c: PolyhedraConfig, best: &mut Option<(PolyhedraConfig, f64)>| {
        if let Some(score) = check_config(&problem, p, &c) {
            if best.as_ref().is_none_or(|b| score < b.1) {
                *best = Some((c, score));
            }
        }
    };
    if let Some(c) = &start {
        consider(c.clone(), &mut best);
    }
    let stop = || job.should_stop();
    let opts = PolyhedraSearchOptions {
        seed: job.seed as f64,
        start: start.as_ref(),
        start_polished: false,
        max_evals: job.max_evals.unwrap_or(MAX_SAFE_INTEGER) as f64,
        should_stop: &stop,
    };
    let r = match search_polyhedra(&problem, p, &opts) {
        Ok(r) => r,
        Err(message) => return Ok(fail(&message)),
    };
    if let Some(c) = r.config {
        consider(c, &mut best);
    }
    let stopped = match r.stopped {
        Why::Evals => "evals",
        Why::Aborted | Why::Time => {
            if job.stop.load(std::sync::atomic::Ordering::Relaxed) {
                "stop"
            } else {
                "time"
            }
        }
    };
    Ok(AutoResult {
        config: best.as_ref().map(|(c, _)| config_json(c)),
        score: best.as_ref().map(|b| b.1),
        evaluations: r.evaluations,
        stopped: stopped.to_string(),
        method: METHOD.to_string(),
    })
}
