//! The torus space's Auto search for the personal client: a port of the `torus` branch of
//! `runSpaceJob` and `runEngine` in packages/spaces/src/search/run.ts, with `readSpaceConfig`,
//! `torusPackingOf` and `torusConfigOf` of packages/spaces/src/search/model.ts.
//!
//! The job's id is parsed as `parseSearchProblem` does; the start, when given, is read as
//! `readSpaceConfig` does and is itself a candidate (`consider(start)`); the search is
//! `search_torus` with the job's seed and evaluation budget, polling `job.should_stop()` where the
//! TypeScript polls its Gate; and the packing it returns is checked by the server's own rule
//! (`server::check` at the tolerance 1e-9) before it is kept, as `consider` does. The best of the
//! two valid candidates, by the validator's score, is the result.

use crate::lattice::{torus_score, TorusFamily};
use crate::search::{family_lattice, search_torus, Stopped, TorusProblem, TorusSearchOptions};
use crate::server::{check, spec_lattice, LatticeSpec};
use crate::validate::TorusPacking;
use crate::{Lattice, Pose};
use polypack_js::math;
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};

/// The method name the TypeScript client records for a torus Auto result
/// (`SPACE_METHOD.torus` of packages/spaces/src/search/model.ts).
pub const METHOD: &str = "torus basin hopping";

/// packages/geometry/src/shapes.ts: `MAX_PIECES`.
const MAX_PIECES: u32 = 500;
/// packages/spaces/src/validate.ts: `MAX_REASONS`.
const MAX_REASONS: usize = 20;
/// packages/spaces/src/info.ts: `TORUS_MAX_TRANSLATES`.
const TORUS_MAX_TRANSLATES: f64 = 1000.0;
/// packages/spaces/src/info.ts: `SPACE_TOL`, the tolerance of the server's check.
const SPACE_TOL: f64 = 1e-9;
/// `Number.MAX_SAFE_INTEGER`: the source's evaluation cap of a job without one.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// model.ts: `parseSearchProblem`, the torus case: `^torus/(sq|hex|free)/(\d{1,3})/(\d{1,3})$`.
pub fn parse_id(id: &str) -> Option<TorusProblem> {
    let mut it = id.split('/');
    if it.next()? != "torus" {
        return None;
    }
    let family = TorusFamily::parse(it.next()?)?;
    let n = it.next()?;
    let p = it.next()?;
    if it.next().is_some() {
        return None;
    }
    let digits = |s: &str| -> Option<u32> {
        if (1..=3).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse().ok()
        } else {
            None
        }
    };
    let (n, p) = (digits(n)?, digits(p)?);
    // shape(): 0 or 3..=100; count(): 1..=MAX_PIECES
    if !(n == 0 || (3..=100).contains(&n)) || !(1..=MAX_PIECES).contains(&p) {
        return None;
    }
    Some(TorusProblem {
        family,
        n: n as usize,
        p: p as usize,
    })
}

/// A configuration as the search keeps it between `read_config` and `config_of`: the lattice as
/// the configuration states it, and the poses.
struct Config {
    spec: LatticeSpec,
    poses: Vec<[f64; 3]>,
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

fn vec2(v: &Value) -> Option<[f64; 2]> {
    let a = v.as_array()?;
    if a.len() != 2 {
        return None;
    }
    Some([finite(&a[0])?, finite(&a[1])?])
}

/// model.ts: `readSpaceConfig`, the torus case: a clean copy of a configuration, or `None` when it
/// is malformed.
fn read_config(p: &TorusProblem, v: &Value) -> Option<Config> {
    let obj = v.as_object()?;
    let l = obj.get("lattice")?.as_object()?;
    let poses_v = obj.get("poses")?.as_array()?;
    if poses_v.len() != p.p {
        return None;
    }
    let mut poses = Vec::with_capacity(p.p);
    for q in poses_v {
        let q = q.as_array()?;
        if q.len() != 3 {
            return None;
        }
        poses.push([finite(&q[0])?, finite(&q[1])?, finite(&q[2])?]);
    }
    if p.family == TorusFamily::Free {
        let b1 = vec2(l.get("b1")?)?;
        let b2 = vec2(l.get("b2")?)?;
        // a basis of a real lattice: a degenerate one (det 0, or not finite) has no cells to draw or search
        let det = b1[0] * b2[1] - b1[1] * b2[0];
        return if det.is_finite() && det != 0.0 {
            Some(Config {
                spec: LatticeSpec::Basis { b1, b2 },
                poses,
            })
        } else {
            None
        };
    }
    let len = finite(l.get("L")?).filter(|&x| x > 0.0)?;
    Some(Config {
        spec: LatticeSpec::L(len),
        poses,
    })
}

/// model.ts: `torusPackingOf`. The torus packing a configuration describes (sq/hex lattices
/// rebuilt from L).
fn packing_of(p: &TorusProblem, c: &Config) -> TorusPacking {
    let lattice = match c.spec {
        LatticeSpec::Basis { b1, b2 } => Lattice { b1, b2 },
        LatticeSpec::L(l) => family_lattice(p.family, l),
    };
    TorusPacking {
        family: p.family,
        n: p.n as f64,
        lattice,
        poses: c.poses.iter().map(|&[x, y, theta]| Pose { x, y, theta }).collect(),
    }
}

/// model.ts: `torusConfigOf`. The configuration of a torus packing: {L} for sq/hex (|b1|), {b1, b2}
/// for free.
fn config_of(p: &TorusProblem, k: &TorusPacking) -> Config {
    let spec = if p.family == TorusFamily::Free {
        LatticeSpec::Basis {
            b1: [k.lattice.b1[0], k.lattice.b1[1]],
            b2: [k.lattice.b2[0], k.lattice.b2[1]],
        }
    } else {
        LatticeSpec::L(math::hypot(k.lattice.b1[0], k.lattice.b1[1]))
    };
    Config {
        spec,
        poses: k.poses.iter().map(|q| [q.x, q.y, q.theta]).collect(),
    }
}

/// The configuration as JSON, in the submission format: `{"lattice": {"L"} | {"b1", "b2"}, "poses": [[x, y, theta], ...]}`.
fn config_json(c: &Config) -> Value {
    let lattice = match c.spec {
        LatticeSpec::L(l) => json!({ "L": l }),
        LatticeSpec::Basis { b1, b2 } => json!({ "b1": b1, "b2": b2 }),
    };
    json!({ "lattice": lattice, "poses": c.poses })
}

/// model.ts: `checkSpaceConfig`, the torus case with the default rule: valid by the server's check
/// at the tolerance 1e-9, and then the stated score (L, or sqrt of the cell area for free).
fn check_config(p: &TorusProblem, c: &Config) -> Option<f64> {
    let reasons = check(p.family, p.n as f64, &c.spec, &c.poses, SPACE_TOL, MAX_REASONS, TORUS_MAX_TRANSLATES);
    if reasons.is_empty() {
        Some(torus_score(p.family, &spec_lattice(p.family, &c.spec)))
    } else {
        None
    }
}

/// run.ts: `runSpaceJob` for a torus job on the space's own search (method "auto"). `Err` only for
/// an id that is not a torus problem.
pub fn auto_search(job: &AutoJob) -> Result<AutoResult, String> {
    let p = parse_id(job.id).ok_or_else(|| format!("not a problem id of torus: {}", job.id.chars().take(80).collect::<String>()))?;
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
    // the best valid configuration: the start, then whatever the search returns
    let mut best: Option<(Config, f64)> = None;
    let consider = |c: Config, best: &mut Option<(Config, f64)>| {
        if let Some(score) = check_config(&p, &c) {
            if best.as_ref().map_or(true, |b| score < b.1) {
                *best = Some((c, score));
            }
        }
    };
    let start_packing = start.as_ref().map(|c| packing_of(&p, c));
    if let Some(c) = start {
        consider(c, &mut best);
    }
    let stop = || job.should_stop();
    let opts = TorusSearchOptions {
        seed: job.seed,
        start: start_packing.as_ref(),
        max_evals: job.max_evals.unwrap_or(MAX_SAFE_INTEGER),
        max_seconds: None,
        should_stop: Some(&stop),
    };
    let r = match search_torus(&p, &opts) {
        Ok(r) => r,
        Err(message) => return Ok(fail(&message)),
    };
    if let Some(k) = &r.packing {
        consider(config_of(&p, k), &mut best);
    }
    let stopped = match r.stopped {
        Stopped::Evals => "evals",
        Stopped::Aborted | Stopped::Time => {
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
