//! The boundary space's Auto search for the personal client: a port of the `boundary` branch of
//! `runSpaceJob` and `runEngine` in packages/spaces/src/search/run.ts, with `readSpaceConfig` and
//! `parseSearchProblem` of packages/spaces/src/search/model.ts and the server's rule `consider` applies
//! (`checkSpaceConfig`: packages/spaces/src/validate.ts, `parseBoundary` and `check`).
//!
//! The job's id is parsed as `parseSearchProblem` does; the start, when given, is read as
//! `readSpaceConfig` does and is itself a candidate (`consider(start)`); the search is `search_boundary`
//! (packages/boundary/src/search/search.ts: `searchBoundary` and what it calls) with the job's seed and
//! evaluation budget, polling `job.should_stop()` where the TypeScript polls its Gate; and the packing it
//! returns is checked by the server's rule (the form of `parseBoundary`, then `validate_boundary` at the
//! tolerance 1e-9, 20 reasons and 1,024 chains) before it is kept. The best of the two valid candidates, by
//! the validator's score, is the result. A fresh job (`start: None`) gives the search no start, as the
//! source does for a job of kind "fresh".

use crate::ids::parse_boundary_id;
use crate::nd::names::high_dim_shape;
use crate::polytope::get_polytope;
use crate::search::{search_boundary, BoundarySearchOptions, End};
use crate::types::{BoundaryConfig, BoundaryPiece, BoundaryProblem};
use crate::validate::{validate_boundary_config, ValidateOptions, MAX_S};
use polypack_js::math;
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::Value;

/// The method name the TypeScript client records for a boundary Auto result
/// (`SPACE_METHOD.boundary` of packages/spaces/src/search/model.ts).
pub const METHOD: &str = "boundary compression search";

/// packages/geometry/src/shapes.ts: `MAX_PIECES`.
const MAX_PIECES: f64 = 500.0;
/// packages/spaces/src/validate.ts: `SPACE_MAX_P.boundary` (400 for the d-cubes; the 4-polytopes' catalogue stops lower).
const SPACE_MAX_P: f64 = 400.0;
/// packages/spaces/src/validate.ts: `MAX_REASONS`.
const MAX_REASONS: f64 = 20.0;
/// packages/spaces/src/info.ts: `SPACE_TOL`, the tolerance of the server's check.
const SPACE_TOL: f64 = 1e-9;
/// packages/spaces/src/info.ts: `BOUNDARY_MAX_CHAINS`.
const BOUNDARY_MAX_CHAINS: f64 = 1024.0;
/// packages/spaces/src/info.ts: `SPACE_MAX_COORD`.
const SPACE_MAX_COORD: f64 = 1e4;
/// packages/spaces/src/validate.ts: `BOUNDARY_UNIT_SLACK`.
const BOUNDARY_UNIT_SLACK: f64 = 1e-9;
/// `Number.MAX_SAFE_INTEGER`: the source's evaluation cap of a job without one.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// model.ts: `parseSearchProblem`, the boundary case: the boundary package's parser, and P at most MAX_PIECES.
pub fn parse_id(id: &str) -> Option<BoundaryProblem> {
    if !id.starts_with("boundary/") {
        return None;
    }
    let b = parse_boundary_id(id).ok()?;
    if b.p > MAX_PIECES {
        return None;
    }
    Some(b)
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// model.ts: `positive`.
fn positive(v: Option<&Value>) -> Option<f64> {
    v.and_then(finite).filter(|&x| x > 0.0)
}

/// `Number.isInteger(x)` of a JSON value, for a non-negative range check.
fn integer(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite() && x.fract() == 0.0)
}

/// model.ts: `readSpaceConfig`, the boundary case: a clean copy of a configuration, or `None` when it is malformed.
fn read_config(p: &BoundaryProblem, v: &Value) -> Option<BoundaryConfig> {
    let obj = v.as_object()?;
    let s = positive(obj.get("s"))?;
    let list = obj.get("pieces")?.as_array()?;
    if list.len() as f64 != p.p {
        return None;
    }
    let hd = high_dim_shape(&p.polytope);
    let nc = hd.is_some();
    let cells = match hd {
        Some(hd) => hd.cells,
        None => get_polytope(&p.polytope).ok()?.cells.len(),
    };
    let dim_u = hd.map_or(3, |h| h.dim_u);
    let mut pieces = Vec::with_capacity(list.len());
    for q in list {
        let q = q.as_object()?;
        let cell = integer(q.get("cell")).filter(|&c| !(c < 0.0) && !(c >= cells as f64))?;
        let u = q.get("u")?.as_array()?;
        if u.len() != dim_u {
            return None;
        }
        let mut uu = Vec::with_capacity(dim_u);
        for x in u {
            uu.push(finite(x)?);
        }
        let mut piece = BoundaryPiece { cell: cell as usize, u: uu, q: None };
        if let Some(qq) = q.get("q") {
            if nc {
                return None;
            }
            // balls have no rotation; a cube's is four finite numbers (the check decides whether it is a unit one)
            let a = qq.as_array()?;
            if p.piece == "ball" || a.len() != 4 {
                return None;
            }
            let mut quat = [0.0; 4];
            for (k, x) in a.iter().enumerate() {
                quat[k] = finite(x)?;
            }
            piece.q = Some(quat);
        }
        pieces.push(piece);
    }
    Some(BoundaryConfig { s, pieces })
}

/// validate.ts: `parseBoundary` for a configuration that already has the right types: what is left that can be
/// wrong is the sizes (s and the coordinates), a rotation where there is none, and a quaternion that is not a unit one.
fn form_ok(p: &BoundaryProblem, c: &BoundaryConfig) -> bool {
    let hd = high_dim_shape(&p.polytope);
    let nc = hd.is_some();
    let ball = p.piece == "ball";
    // r.num(raw.s, "s", BOUNDARY_MAX_S, true)
    if !(c.s.is_finite() && c.s.abs() <= MAX_S && c.s > 0.0) {
        return false;
    }
    for pc in &c.pieces {
        if pc.u.iter().any(|x| !x.is_finite() || x.abs() > SPACE_MAX_COORD) {
            return false;
        }
        let Some(q) = &pc.q else { continue };
        if (nc && !ball) || ball {
            return false;
        }
        if q.iter().any(|x| !x.is_finite() || x.abs() > SPACE_MAX_COORD) {
            return false;
        }
        if !(math::abs(math::hypot_of(q) - 1.0) <= BOUNDARY_UNIT_SLACK) {
            return false;
        }
    }
    true
}

/// model.ts: `checkSpaceConfig`, the boundary case with the default rule (no bound, no certified size): valid
/// by the server's check at the tolerance 1e-9, and then the stated score (s).
fn check_config(p: &BoundaryProblem, c: &BoundaryConfig) -> Option<f64> {
    if p.p > SPACE_MAX_P || c.pieces.len() as f64 != p.p || !form_ok(p, c) {
        return None;
    }
    let opts = ValidateOptions { tol: Some(SPACE_TOL), max_reasons: Some(MAX_REASONS), max_chains: Some(BOUNDARY_MAX_CHAINS), ..Default::default() };
    match validate_boundary_config(p, c, &opts) {
        Ok(v) if v.ok => Some(c.s),
        // an error of the validator is a reason ("the check failed"), not a result
        _ => None,
    }
}

/// run.ts: `runSpaceJob` for a boundary job on the space's own search (method "auto"). `Err` only for an id that
/// is not a boundary problem.
pub fn auto_search(job: &AutoJob) -> Result<AutoResult, String> {
    let p = parse_id(job.id).ok_or_else(|| format!("not a problem id of boundary: {}", job.id.chars().take(80).collect::<String>()))?;
    let fail = |why: &str| AutoResult { config: None, score: None, evaluations: 0, stopped: format!("error: {why}"), method: METHOD.to_string() };
    let start = match job.start {
        None => None,
        Some(v) => match read_config(&p, v) {
            Some(c) => Some(c),
            None => return Ok(fail("the start is not a configuration of this problem")),
        },
    };
    // the best valid configuration: the start, then whatever the search returns
    let mut best: Option<(BoundaryConfig, f64)> = None;
    let consider = |c: BoundaryConfig, best: &mut Option<(BoundaryConfig, f64)>| {
        if let Some(score) = check_config(&p, &c) {
            if best.as_ref().is_none_or(|b| score < b.1) {
                *best = Some((c, score));
            }
        }
    };
    if let Some(c) = &start {
        consider(c.clone(), &mut best);
    }
    let stop = || job.should_stop();
    let opts = BoundarySearchOptions { start: start.as_ref(), seed: job.seed, evals: job.max_evals.unwrap_or(MAX_SAFE_INTEGER), time_s: None, should_stop: Some(&stop), ball_chains: false };
    let r = match search_boundary(&p, &opts) {
        Ok(r) => r,
        Err(message) => return Ok(fail(&message)),
    };
    if let Some(c) = r.config {
        consider(c, &mut best);
    }
    let stopped = match r.ended {
        End::Evals => "evals",
        End::Bound => "bound",
        End::Stopped | End::Time => {
            if job.stop.load(std::sync::atomic::Ordering::Relaxed) {
                "stop"
            } else {
                "time"
            }
        }
    };
    Ok(AutoResult {
        config: best.as_ref().map(|(c, _)| serde_json::to_value(c).expect("a configuration")),
        score: best.as_ref().map(|b| b.1),
        evaluations: r.evals,
        stopped: stopped.to_string(),
        method: METHOD.to_string(),
    })
}
