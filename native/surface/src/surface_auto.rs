//! The Auto search of the surface space for the personal 2D-on-3D sweep: the fold mode on every
//! solid, and the nofold mode on the solids beyond the Platonic ones (whose faces are not all one
//! regular polygon, so they have no planar engine).
//!
//! A port of the surface branches of `packages/spaces/src/search/run.ts` (`runSpaceJob`, `runEngine`
//! case "surface", `Gate`) with `surface-fold.ts` beneath it (`search/`): the id, the warm start
//! from the job's start, the seed, the evaluation budget, the four-fifths split of the job's time
//! with the final polish's overrun, and the check of every candidate by the server's rule
//! (`checkSpaceConfig`: `validateSpaceSubmission` without a bound or a record).
//!
//! The job's time is the span from the call to `job.deadline`. The search polls `job.stop` and
//! that time as the TypeScript's Gate polls its flags and its active seconds; there are no pauses.

use crate::chains::ChainError;
use crate::parts::SurfacePose;
use crate::search::fold::{surface_fold_search, FoldOptions, Start};
use crate::solids::{get_solid, is_solid_name, Solid};
use crate::validate::{validate, Mode, SurfaceConfig, ValidateOptions};
use polypack_spaceauto::{AutoJob, AutoResult};
use serde_json::{json, Value};
use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;
use std::time::Instant;

/// `run.ts: SURFACE_FINAL_OVERRUN`. Seconds the surface fold search's final stage may run past the
/// job's budget.
pub const SURFACE_FINAL_OVERRUN: f64 = 1.5;

/// `packages/spaces/src/info.ts`: SPACE_MAX_SIZE, SPACE_MAX_COORD, SURFACE_MAX_CHAINS, SPACE_TOL.
const MAX_SIZE: f64 = 1e6;
const MAX_COORD: f64 = 1e4;
const MAX_CHAINS: f64 = 600.0;
const SPACE_TOL: f64 = 1e-9;
/// `validate.ts: SPACE_MAX_P` of the surface space.
const SPACE_MAX_P: usize = 100;
/// `validate.ts: MAX_REASONS`.
const MAX_REASONS: usize = 20;

/// A surface problem (`model.ts: SearchProblem`, surface).
struct Problem {
    solid: &'static Solid,
    nofold: bool,
    n: usize,
    p: usize,
}

/// A text of digits in its one written form (ids.ts: INT), as a number.
fn int_text(t: &str) -> Option<usize> {
    let b = t.as_bytes();
    if b.is_empty() || b.len() > 4 || !b.iter().all(|c| c.is_ascii_digit()) || (b[0] == b'0' && b.len() > 1) {
        return None;
    }
    t.parse().ok()
}

/// `model.ts: parseSearchProblem`, surface, with the stricter form of `ids.ts: parseSpaceId` that
/// the check of every result applies (an id outside it can have no valid result).
fn parse_problem(id: &str) -> Option<Problem> {
    if id.len() > 100 {
        return None;
    }
    let parts: Vec<&str> = id.split('/').collect();
    if parts.len() != 5 || parts[0] != "surface" || !is_solid_name(parts[1]) {
        return None;
    }
    let nofold = match parts[2] {
        "fold" => false,
        "nofold" => true,
        _ => return None,
    };
    let n = int_text(parts[3])?;
    let p = int_text(parts[4])?;
    if !(n == 0 || (3..=100).contains(&n)) || p < 1 || p > SPACE_MAX_P {
        return None;
    }
    Some(Problem { solid: get_solid(parts[1]).ok()?, nofold, n, p })
}

/// A configuration of a problem: the edge and the poses (`model.ts: readSpaceConfig`).
#[derive(Clone)]
struct Config {
    s: f64,
    pieces: Vec<SurfacePose>,
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// `model.ts: readSpaceConfig`, surface.
fn read_config(p: &Problem, v: &Value) -> Option<Config> {
    let o = v.as_object()?;
    let list = o.get("pieces")?.as_array()?;
    if list.len() != p.p {
        return None;
    }
    let mut pieces = Vec::with_capacity(list.len());
    for q in list {
        let q = q.as_object()?;
        let (x, y, theta) = (finite(q.get("x")?)?, finite(q.get("y")?)?, finite(q.get("theta")?)?);
        let f = q.get("face")?.as_f64()?;
        // a face index: the largest solid has 120 faces; the check decides the range
        if f.fract() != 0.0 || !(0.0..=1000.0).contains(&f) {
            return None;
        }
        pieces.push(SurfacePose { face: f, x, y, theta });
    }
    let s = finite(o.get("s")?)?;
    if !(s > 0.0) {
        return None;
    }
    Some(Config { s, pieces })
}

/// `model.ts: checkSpaceConfig` for a surface configuration with no bound and no record: the score
/// when `validateSpaceSubmission` finds it valid (the stated size within SPACE_MAX_SIZE, each
/// coordinate within SPACE_MAX_COORD, the fold or nofold validator at SPACE_TOL with the work
/// bound of the server), else None.
fn check_config(p: &Problem, c: &Config) -> Option<f64> {
    if c.s.abs() > MAX_SIZE || !(c.s > 0.0) {
        return None;
    }
    for q in &c.pieces {
        if q.face < 0.0 || q.face >= p.solid.f as f64 || q.x.abs() > MAX_COORD || q.y.abs() > MAX_COORD || q.theta.abs() > MAX_COORD {
            return None;
        }
    }
    let cfg = SurfaceConfig { solid: p.solid.name.clone(), n: p.n as f64, s: c.s, pieces: c.pieces.clone() };
    let mode = if p.nofold { Mode::Nofold } else { Mode::Fold };
    let opts = ValidateOptions { tol: SPACE_TOL, max_errors: MAX_REASONS, max_chains: MAX_CHAINS, ..ValidateOptions::default() };
    match validate(&cfg, mode, &opts) {
        Ok(v) if v.ok => Some(c.s),
        // a validator that gives up (a work limit) is an invalid verdict
        _ => None,
    }
}

/// `run.ts: Gate`'s `why`.
#[derive(Clone, Copy, PartialEq)]
enum Why {
    None,
    Aborted,
    Time,
}

/// `run.ts: Gate`, without pauses: active seconds are the time since the job began.
struct Gate<'a> {
    job: &'a AutoJob<'a>,
    began: Instant,
    seconds: f64,
    why: Cell<Why>,
}

impl Gate<'_> {
    /// `Gate.stopAt(limit)`: true once the job must end, or a phase that ends after `limit` active
    /// seconds of the job has.
    fn stop_at(&self, limit: f64) -> bool {
        if self.why.get() == Why::Aborted {
            return true;
        }
        if self.job.stop.load(Ordering::Relaxed) {
            self.why.set(Why::Aborted);
            return true;
        }
        let active = self.began.elapsed().as_secs_f64();
        if active >= self.seconds && self.why.get() == Why::None {
            self.why.set(Why::Time);
        }
        active >= limit
    }
}

/// The Auto search of a surface problem: `runSpaceJob` for the surface space.
///
/// `Err` for an id this search cannot model, and for a nofold problem on a Platonic solid, which
/// runs on the planar engine. A job that fails otherwise (a start that is not a configuration, a
/// chain enumeration that gives up) is an `Ok` result without a packing whose `stopped` is
/// "error: <message>".
pub fn surface_auto(job: &AutoJob) -> Result<AutoResult, String> {
    let began = Instant::now();
    let Some(p) = parse_problem(job.id) else {
        return Err(format!("not a problem id of surface: {}", job.id.chars().take(80).collect::<String>()));
    };
    if p.nofold && p.solid.uniform {
        return Err("nofold on a Platonic solid runs on the planar engine".to_string());
    }
    let method = if p.nofold { "surface nofold search" } else { "surface fold search" }.to_string();
    let error = |msg: &str, evaluations: u64| AutoResult { config: None, score: None, evaluations, stopped: format!("error: {msg}"), method: method.clone() };
    let start = match job.start {
        None => None,
        Some(v) => match read_config(&p, v) {
            Some(c) => Some(c),
            None => return Ok(error("the start is not a configuration of this problem", 0)),
        },
    };
    let seconds = job.deadline.saturating_duration_since(began).as_secs_f64();
    let gate = Gate { job, began, seconds, why: Cell::new(Why::None) };
    // the best valid configuration: the start, then whatever the engine returns
    let mut best: Option<(Config, f64)> = None;
    let consider = |best: &mut Option<(Config, f64)>, c: &Config| {
        if let Some(score) = check_config(&p, c) {
            if best.as_ref().map_or(true, |b| score < b.1) {
                *best = Some((c.clone(), score));
            }
        }
    };
    if let Some(c) = &start {
        consider(&mut best, c);
    }
    let cap: u64 = job.max_evals.unwrap_or((1u64 << 53) - 1);
    let run = catch_unwind(AssertUnwindSafe(|| -> (Option<Config>, u64, &'static str) {
        let warm: Vec<Start> = match &start {
            Some(c) => vec![Start {
                lam: 1.0 / c.s,
                poses: c.pieces.iter().map(|q| SurfacePose { face: q.face, x: q.x / c.s, y: q.y / c.s, theta: q.theta }).collect(),
            }],
            None => Vec::new(),
        };
        // the search leaves the last fifth of the budget to the final tightening and polish, which
        // may run on for SURFACE_FINAL_OVERRUN s more
        let stop = || gate.stop_at(gate.seconds * 0.8);
        let final_stop = || gate.stop_at(gate.seconds + SURFACE_FINAL_OVERRUN);
        let opts = FoldOptions {
            seed: job.seed,
            random_starts: if warm.is_empty() { 2 } else { 0 },
            hops: cap.min(1_000_000) as usize,
            warm,
            stop: &stop,
            final_stop: &final_stop,
            nofold: p.nofold,
        };
        match surface_fold_search(p.solid, p.n, p.p, &opts) {
            None => (None, 0, "done"),
            Some(r) => {
                let s = 1.0 / r.lam;
                let pieces = r.poses.iter().map(|q| SurfacePose { face: q.face, x: q.x * s, y: q.y * s, theta: q.theta }).collect();
                (Some(Config { s, pieces }), r.compressions, if r.compressions >= cap { "evals" } else { "done" })
            }
        }
    }));
    let (config, evaluations, ran) = match run {
        Ok(r) => r,
        Err(payload) => {
            let msg = if let Some(e) = payload.downcast_ref::<ChainError>() {
                e.message().to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else {
                "the search failed".to_string()
            };
            return Ok(error(&msg, 0));
        }
    };
    if let Some(c) = &config {
        consider(&mut best, c);
    }
    let stopped = match gate.why.get() {
        Why::Aborted => "aborted",
        Why::Time => "time",
        Why::None => ran,
    }
    .to_string();
    Ok(match best {
        Some((c, score)) => AutoResult { config: Some(config_json(&c)), score: Some(score), evaluations, stopped, method },
        None => AutoResult { config: None, score: None, evaluations, stopped, method },
    })
}

/// A number as JSON writes it for JavaScript: -0 is 0.
fn num(x: f64) -> Value {
    json!(x + 0.0)
}

/// The submission's `config`: `{s, pieces: [{face, x, y, theta}]}`.
fn config_json(c: &Config) -> Value {
    let pieces: Vec<Value> = c.pieces.iter().map(|q| json!({"face": q.face as u64, "x": num(q.x), "y": num(q.y), "theta": num(q.theta)})).collect();
    json!({"s": num(c.s), "pieces": pieces})
}
