//! The balls family's Auto search for the personal client: a port of the `balls` branch of `runSpaceJob` and
//! `runEngine` in packages/spaces/src/search/run.ts, with `parseSearchProblem` and `readSpaceConfig` of
//! packages/spaces/src/search/model.ts.
//!
//! The job's id is parsed as `parseSearchProblem` does; the start, when given, is read as `readSpaceConfig`
//! does and is itself a candidate (`consider(start)`); the search is `search_balls` with the job's seed and
//! evaluation budget (the volunteer client never sets `polished`, so a start is polished), polling
//! `job.should_stop()` where the TypeScript polls its Gate; and every packing is checked by the server's own
//! rule (`checkSpaceConfig` with the default rule: the id and P, the form of the configuration, and the
//! validator at the tolerance 1e-9) before it is kept, as `consider` does. The best of the valid candidates, by
//! the validator's score s, is the result.

use crate::catalogue::{parse_balls_id, BallsProblem};
use crate::search::{search_balls, BallsSearchOptions, Stopped};
use crate::validate::{balls_config_errors_typed, validate_balls, BallsConfig, BallsValidateOptions};
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};

/// The method name the TypeScript client records for a balls Auto result (`SPACE_METHOD.balls` of
/// packages/spaces/src/search/model.ts).
pub const METHOD: &str = "balls penalty basin hopping";

/// packages/geometry/src/shapes.ts: `MAX_PIECES`.
const MAX_PIECES: u32 = 500;
/// packages/spaces/src/validate.ts: `SPACE_MAX_P.balls`, the largest P the server's rule accepts.
const SPACE_MAX_P: u32 = 100;
/// packages/spaces/src/validate.ts: `MAX_REASONS`.
const MAX_REASONS: usize = 20;
/// packages/spaces/src/info.ts: `SPACE_TOL`, the tolerance of the server's check.
const SPACE_TOL: f64 = 1e-9;
/// `Number.MAX_SAFE_INTEGER`: the source's evaluation cap of a job without one.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The problem a job names, as `parseSearchProblem` returns it for a balls id.
#[derive(Clone, Copy, Debug)]
pub struct BallsId {
    pub p: usize,
    pub problem: &'static BallsProblem,
}

/// model.ts: `parseSearchProblem`, the balls case: `parseBallsId`, and P at most MAX_PIECES.
pub fn parse_id(id: &str) -> Option<BallsId> {
    if !id.starts_with("balls/") {
        return None;
    }
    let b = parse_balls_id(id).ok()?;
    if b.p > MAX_PIECES {
        return None;
    }
    Some(BallsId { p: b.p as usize, problem: b.problem })
}

/// model.ts: `readSpaceConfig`, the balls case: a clean copy of a configuration, or `None` when it is
/// malformed: s a positive finite number, P pieces, each a ball's centre (3 numbers) or a solid's pose (7), all
/// finite.
fn read_config(id: &BallsId, v: &Value) -> Option<BallsConfig> {
    let obj = v.as_object()?;
    let s = obj.get("s")?.as_f64().filter(|x| x.is_finite() && *x > 0.0)?;
    let list = obj.get("pieces")?.as_array()?;
    if list.len() != id.p {
        return None;
    }
    let width = if id.problem.piece == "ball" { 3 } else { 7 };
    let mut pieces = Vec::with_capacity(id.p);
    for q in list {
        let q = q.as_array()?;
        if q.len() != width {
            return None;
        }
        let mut row = Vec::with_capacity(width);
        for x in q {
            row.push(x.as_f64().filter(|x| x.is_finite())?);
        }
        pieces.push(row);
    }
    Some(BallsConfig { s, pieces })
}

/// model.ts: `checkSpaceConfig` (validate.ts: `validateSpaceSubmission`) with the default rule, for a
/// configuration of the right number of pieces: P within the server's largest, the configuration's form, and
/// valid by the balls validator at the tolerance 1e-9; the score is the stated s.
fn check_config(id: &BallsId, c: &BallsConfig) -> Option<f64> {
    if id.p as u32 > SPACE_MAX_P {
        return None;
    }
    if !balls_config_errors_typed(id.problem, c, Some(id.p), MAX_REASONS).is_empty() {
        return None;
    }
    // a validator that throws is an invalid verdict ("the check failed")
    let v = validate_balls(id.problem, c, &BallsValidateOptions { tol: Some(SPACE_TOL), max_errors: Some(MAX_REASONS) }).ok()?;
    if v.valid {
        Some(c.s)
    } else {
        None
    }
}

/// The configuration as JSON, in the submission format: `{"s": s, "pieces": [[x, y, z], ...]}` (a ball's
/// centre) or `[[x, y, z, qw, qx, qy, qz], ...]` (a solid's pose).
fn config_json(c: &BallsConfig) -> Value {
    json!({ "s": c.s, "pieces": c.pieces })
}

/// run.ts: `runSpaceJob` for a balls job on the space's own search (method "auto"). `Err` only for an id that
/// is not a balls problem.
pub fn auto_search(job: &AutoJob) -> Result<AutoResult, String> {
    let id = parse_id(job.id).ok_or_else(|| format!("not a problem id of balls: {}", job.id.chars().take(80).collect::<String>()))?;
    let fail = |why: &str| AutoResult {
        config: None,
        score: None,
        evaluations: 0,
        stopped: format!("error: {why}"),
        method: METHOD.to_string(),
    };
    let start = match job.start {
        None => None,
        Some(v) => match read_config(&id, v) {
            Some(c) => Some(c),
            None => return Ok(fail("the start is not a configuration of this problem")),
        },
    };
    // the best valid configuration: the start, then whatever the search returns
    let mut best: Option<(BallsConfig, f64)> = None;
    let consider = |c: BallsConfig, best: &mut Option<(BallsConfig, f64)>| {
        if let Some(score) = check_config(&id, &c) {
            if best.as_ref().is_none_or(|b| score < b.1) {
                *best = Some((c, score));
            }
        }
    };
    if let Some(c) = &start {
        consider(c.clone(), &mut best);
    }
    let stop = || job.should_stop();
    let opts = BallsSearchOptions {
        seed: job.seed,
        start: start.as_ref(),
        start_polished: false,
        max_evals: job.max_evals.unwrap_or(MAX_SAFE_INTEGER),
        should_stop: Some(&stop),
        clearance: None,
        hops: crate::ball_pieces::Hops::Holes,
    };
    let r = match search_balls(id.problem, id.p, &opts) {
        Ok(r) => r,
        Err(message) => return Ok(fail(&message)),
    };
    if let Some(c) = r.config {
        consider(c, &mut best);
    }
    let stopped = match r.stopped {
        Stopped::Evals => "evals",
        Stopped::Aborted => {
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
