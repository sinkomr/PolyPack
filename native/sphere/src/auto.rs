//! The sphere space's Auto search as the 2D-on-3D client calls it (`polypack_spaceauto`): a port of
//! the `sphere` branch of `runSpaceJob` in packages/spaces/src/search/run.ts (and of `runEngine`'s
//! call of `searchSphere`), with the job's gate as `AutoJob::should_stop`.
//!
//! `runSpaceJob` parses the id (`parseSearchProblem`), reads the start (`readSpaceConfig`), takes
//! the best valid of the start and the engine's result under the server's check
//! (`checkSpaceConfig`: the validator at 1e-9, the score is the stated rho), and names the method
//! `SPACE_METHOD.sphere`.

use crate::geometry::{SphereConfig, SpherePiece, SphereProblem};
use crate::search::{config_of, search_sphere, SearchOptions, Stop};
use crate::server::check;
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};

/// packages/spaces/src/search/model.ts: `SPACE_METHOD.sphere`, what a submission records for the
/// sphere space's own search.
pub const METHOD: &str = "sphere basin hopping";

/// The server's MAX_REASONS and SPACE_TOL (packages/spaces/src/validate.ts).
const MAX_REASONS: usize = 20;
const SPACE_TOL: f64 = 1e-9;

/// packages/spaces/src/search/model.ts: `parseSearchProblem`, the sphere case: `sphere/<N>/<P>`
/// with N = 0 or 3..100 and P in 1..100 (`MAX_PIECES`). Returns (N, P).
pub fn parse_id(id: &str) -> Option<(usize, usize)> {
    let rest = id.strip_prefix("sphere/")?;
    let (a, b) = rest.split_once('/')?;
    let digits = |s: &str| (1..=3).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) {
        return None;
    }
    let n: usize = a.parse().ok()?;
    let p: usize = b.parse().ok()?;
    if !(n == 0 || (3..=100).contains(&n)) || !(1..=100).contains(&p) {
        return None;
    }
    Some((n, p))
}

/// model.ts: `readSpaceConfig`, the sphere case: `{ rho > 0, pieces: [{ q: 4 finite numbers }] }`
/// with P pieces; `None` when it is not one.
pub fn read_config(v: &Value, p: usize) -> Option<SphereConfig> {
    let o = v.as_object()?;
    let rho = o.get("rho")?.as_f64()?;
    if !(rho.is_finite() && rho > 0.0) {
        return None;
    }
    let pieces = o.get("pieces")?.as_array()?;
    if pieces.len() != p {
        return None;
    }
    let mut out = Vec::with_capacity(p);
    for piece in pieces {
        let q = piece.as_object()?.get("q")?.as_array()?;
        if q.len() != 4 {
            return None;
        }
        let mut qq = Vec::with_capacity(4);
        for c in q {
            let c = c.as_f64()?;
            if !c.is_finite() {
                return None;
            }
            qq.push(c);
        }
        out.push(SpherePiece { q: qq });
    }
    Some(SphereConfig { rho, pieces: out })
}

/// The submission format of a packing: `{ rho, pieces: [{ q: [w, x, y, z] }] }`.
pub fn config_json(c: &SphereConfig) -> Value {
    json!({
        "rho": c.rho,
        "pieces": c.pieces.iter().map(|p| json!({ "q": p.q })).collect::<Vec<_>>(),
    })
}

/// The server's check of a configuration (`checkSpaceConfig`): valid at 1e-9, and then its score,
/// the stated rho.
fn score_of(n: usize, p: usize, c: &SphereConfig) -> Option<f64> {
    check(n as f64, p as f64, c, SPACE_TOL, MAX_REASONS)
        .is_empty()
        .then_some(c.rho)
}

/// The sphere Auto search of one job. `Err` only for an id that is not a sphere problem.
pub fn auto_search(job: &AutoJob) -> Result<AutoResult, String> {
    let (n, p) = parse_id(job.id).ok_or_else(|| {
        format!(
            "not a problem id of sphere: {}",
            job.id.chars().take(80).collect::<String>()
        )
    })?;
    let fail = |why: &str| AutoResult {
        config: None,
        score: None,
        evaluations: 0,
        stopped: format!("error: {why}"),
        method: METHOD.to_string(),
    };
    let start = match job.start {
        None => None,
        Some(v) => match read_config(v, p) {
            Some(c) => Some(c),
            None => return Ok(fail("the start is not a configuration of this problem")),
        },
    };
    // the best valid configuration: the start, then whatever the engine returns
    let mut best: Option<(SphereConfig, f64)> = None;
    let mut consider = |c: &SphereConfig| {
        if let Some(score) = score_of(n, p, c) {
            if best.as_ref().map_or(true, |b| score < b.1) {
                best = Some((c.clone(), score));
            }
        }
    };
    if let Some(c) = &start {
        consider(c);
    }
    // `cap = job.budget.evals ?? Number.MAX_SAFE_INTEGER`
    let cap = job.max_evals.unwrap_or((1u64 << 53) - 1);
    let r = search_sphere(
        &SphereProblem {
            n: n as f64,
            p: p as f64,
        },
        &SearchOptions {
            seed: job.seed,
            start: start.as_ref(),
            max_evals: cap,
            job: Some(job),
        },
    )?;
    if let Some(pk) = &r.config {
        consider(&config_of(pk));
    }
    let stopped = match r.stopped {
        Stop::Evals => "evals",
        Stop::Time => "time",
        Stop::Aborted => "stop",
    };
    Ok(match best {
        Some((c, score)) => AutoResult {
            config: Some(config_json(&c)),
            score: Some(score),
            evaluations: r.evaluations,
            stopped: stopped.to_string(),
            method: METHOD.to_string(),
        },
        None => AutoResult {
            config: None,
            score: None,
            evaluations: r.evaluations,
            stopped: stopped.to_string(),
            method: METHOD.to_string(),
        },
    })
}
