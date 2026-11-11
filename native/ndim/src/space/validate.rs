//! Configurations of the nD in nD space as the server reads and checks them
//! (packages/ndspace/src/validate.ts): the form (packages/ndim poses), the work bounds, and the
//! check with a cap on its work (docs/spaces/NDIM.md §10).
//!
//! A configuration is `{ s, pieces }`: the container scale s and one pose per piece,
//! `[t_1..t_d, k_1..k_m, flip?]` for a polytope (m = d(d - 1)/2) or the centre `[t_1..t_d]` for a
//! ball. It is checked by the ndim validator at PolyPack's touching tolerance, with the work of the
//! check capped at NDIM_CHECK_MS of processor time: a check that needs more is refused, with that
//! reason, so that no input costs unbounded time.
use super::catalogue::{nd_code, NdProblemId, ND_BALL};
use crate::info::info_of;
use crate::polytope::{is_loaded, load_polytope};
use crate::pose::{read_pose_value, Pose, MAX_SIZE};
use crate::problem::{NdConfig, NdProblem};
use crate::validate::{nd_check as core_check, performance_now, Step, ValidateOptions};
use crate::Thrown;
use polypack_js::{fmt, math};
use serde_json::Value;

/// Largest processor time one pass of a check may take (the server runs a second, strict pass for
/// entries that beat a record or have no record). [CALC, the source's] The worst valid case, 20
/// 4_21 polytopes in a 4_21 container (4.67 million vertex-facet tests each), took 2.3 s in the
/// TypeScript before the validator skipped facets that cannot lower the gap: the cap is above that.
pub const NDIM_CHECK_MS: f64 = 8000.0;
/// Reasons listed at most per verdict. A check stops after this many, and an overlapping pair of
/// 8D or 10D polytopes costs up to 0.8 s of GJK and EPA in the TypeScript, so this bounds the work
/// of a bad input.
pub const NDIM_MAX_REASONS: usize = 5;

/// packages/ndspace/src/validate.ts: NdConfigShape (the same shape as the core's NdConfig).
pub type NdConfigShape = NdConfig;

/// packages/ndspace/src/validate.ts: NdParsed.
#[derive(Debug, Clone, PartialEq)]
pub enum NdParsed {
    Ok { config: NdConfigShape, score: f64 },
    Bad { malformed: bool, errors: Vec<String> },
}

/// packages/ndspace/src/validate.ts: ndProblemOf. The core's problem for an id: catalogue codes
/// ("4:cube") and "ball".
pub fn nd_problem_of(d: u32, piece: &str, container: &str) -> NdProblem {
    NdProblem { d: d as i64, piece: nd_code(d, piece), container: nd_code(d, container) }
}

/// packages/ndspace/src/validate.ts: parseNdConfig. Reads a configuration for a problem of P
/// pieces: s a number in (0, MAX_SIZE], P poses of the right length with finite numbers in range
/// (read_pose). Malformed input is `malformed`; a wrong number of pieces is not. The result has only
/// the known fields, with the poses copied.
pub fn parse_nd_config(p: &NdProblemId, raw: &Value) -> Result<NdParsed, Thrown> {
    let Value::Object(c) = raw else {
        return Ok(NdParsed::Bad { malformed: true, errors: vec!["config must be an object {s, pieces}".into()] });
    };
    let mut errors: Vec<String> = Vec::new();
    // `typeof c.s !== "number" || !Number.isFinite(c.s) || !(c.s > 0) || c.s > MAX_SIZE`
    let s = c.get("s").and_then(Value::as_f64);
    if !matches!(s, Some(s) if s.is_finite() && s > 0.0 && !(s > MAX_SIZE)) {
        errors.push(format!("s must be a positive finite number of at most {}", fmt::num(MAX_SIZE)));
    }
    let Some(Value::Array(list)) = c.get("pieces") else {
        errors.push("pieces must be an array of poses".into());
        return Ok(NdParsed::Bad { malformed: true, errors });
    };
    if list.len() as u64 != p.p as u64 && errors.is_empty() {
        return Ok(NdParsed::Bad {
            malformed: false,
            errors: vec![format!("expected {} pieces for this problem, got {}", p.p, list.len())],
        });
    }
    let ball = p.piece == ND_BALL;
    let mut pieces: Vec<Vec<f64>> = Vec::new();
    let mut i = 0;
    while i < list.len().min(p.p as usize) && errors.len() < NDIM_MAX_REASONS {
        match read_pose_value(p.d as usize, &list[i], ball)? {
            Pose::Bad(r) => errors.push(format!("pieces[{i}] {r}")),
            // `c.pieces[i].slice()`: a pose that was read is an array of numbers only
            Pose::Read(_) => pieces.push(
                list[i]
                    .as_array()
                    .map(|a| a.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect())
                    .unwrap_or_default(),
            ),
        }
        i += 1;
    }
    if !errors.is_empty() {
        return Ok(NdParsed::Bad { malformed: true, errors });
    }
    let s = s.unwrap_or(f64::NAN);
    Ok(NdParsed::Ok { config: NdConfigShape { s, pieces }, score: s })
}

/// packages/ndspace/src/validate.ts: loadNdProblem. Loads the polytopes of a problem that are kept
/// on demand (the tables of the 24-, 120- and 600-cell, 2_21, 1_22 and 3_21, and 8D 4_21 from its
/// formula); a no-op for the others. A plain function: an `Err` where the source's promise rejects.
pub fn load_nd_problem(d: u32, piece: &str, container: &str) -> Result<(), Thrown> {
    for code in [nd_code(d, piece), nd_code(d, container)] {
        if code != ND_BALL && !is_loaded(&code) {
            load_polytope(&code)?;
        }
    }
    Ok(())
}

/// packages/ndspace/src/validate.ts: epaOps. Multiply-adds of one overlapping pair of polytopes,
/// which GJK answers with EPA (and an LP for the direction) for the depth: about 3e6 d from 6D on;
/// lower dimensions are much cheaper and ignored.
fn epa_ops(d: u32) -> f64 {
    if d >= 6 {
        3e6 * d as f64
    } else {
        0.0
    }
}

/// packages/ndspace/src/validate.ts: ndCheckOps. Work of a check in multiply-adds, by the sizes
/// alone: every vertex of every piece against every facet of the container (P nV nF d; a ball piece
/// P nF d, a ball container P nV d), about P^2/2 pair tests of cost 40 nV d each, and, for polytope
/// pieces, the depth of the pairs that overlap: the check stops at NDIM_MAX_REASONS reasons, so at
/// most that many pairs pay for EPA (epa_ops). The estimate of the server's heavy queue and budget;
/// the cap is on the measured time.
pub fn nd_check_ops(p: &NdProblemId) -> f64 {
    let n_v = |shape: &str| -> f64 {
        if shape == ND_BALL {
            1.0
        } else {
            info_of(&nd_code(p.d, shape)).map_or(1.0, |i| i.n_v as f64)
        }
    };
    let n_f = |shape: &str| -> f64 {
        if shape == ND_BALL {
            1.0
        } else {
            info_of(&nd_code(p.d, shape)).map_or(1.0, |i| i.n_f as f64)
        }
    };
    let pp = p.p as f64;
    let d = p.d as f64;
    let walls = if p.container == ND_BALL { pp * n_v(&p.piece) * d } else { pp * n_v(&p.piece) * n_f(&p.container) * d };
    let n_pairs = (pp * (pp - 1.0)) / 2.0;
    let pairs = n_pairs * 40.0 * n_v(&p.piece) * d;
    let depth = if p.piece == ND_BALL { 0.0 } else { math::min(n_pairs, NDIM_MAX_REASONS as f64) * epa_ops(p.d) };
    walls + pairs + depth
}

/// Checks of at least this many multiply-adds (nd_check_ops) are heavy: the server queues them, one
/// at a time (about 50 ms of work in the TypeScript).
pub const NDIM_HEAVY_OPS: f64 = 2e7;
/// packages/ndspace/src/validate.ts: ndIsHeavy. True when a problem's check is heavy.
pub fn nd_is_heavy(p: &NdProblemId) -> bool {
    nd_check_ops(p) >= NDIM_HEAVY_OPS
}

/// packages/ndspace/src/validate.ts: ndCheckSteps. The reasons a configuration is not valid at
/// `tol` (empty when valid). The polytopes must be loaded (load_nd_problem). The work is capped at
/// `cap_ms` milliseconds of the clock `now`: past it the check ends with a reason that says so.
///
/// The source is a generator that the server drives in slices; this is one synchronous function
/// (native/PORTING.md rule 5). The cap stays, since it changes the verdict: `now` is read before and
/// after every step of the core's check, as in the source, the time between the two readings is
/// added to the work, and the check is abandoned at the first step after which the work is above
/// the cap.
pub fn nd_check_steps(
    p: &NdProblemId,
    config: &NdConfigShape,
    tol: f64,
    max_errors: usize,
    cap_ms: f64,
    now: &mut dyn FnMut() -> f64,
) -> Result<Vec<String>, Thrown> {
    // the core's limits (pieces, vertex and wall work) are those of the problem's registry, never of the request
    let problem = nd_problem_of(p.d, &p.piece, &p.container);
    let opts = ValidateOptions { tol: Some(tol), max_errors: Some(max_errors), ..Default::default() };
    let mut work = 0.0f64;
    let mut t = now();
    let done = core_check(&problem, config, &opts, &mut || {
        work += now() - t;
        if work > cap_ms {
            return Step::Stop;
        }
        t = now();
        Step::Continue
    })?;
    match done {
        Some(v) => {
            // the source adds the last step's time to the work, which it then does not use: the clock is read all the same
            work += now() - t;
            let _ = work;
            if v.valid {
                return Ok(Vec::new());
            }
            Ok(if !v.reasons.is_empty() {
                v.reasons.into_iter().take(max_errors).collect()
            } else {
                vec![format!("not a valid packing (smallest separation {})", fmt::num(v.min_pair_sep))]
            })
        }
        None => Ok(vec![format!(
            "the check was stopped after {} ms of work, above the cap of {} ms for one check",
            fmt::num(math::round(work)),
            fmt::num(cap_ms)
        )]),
    }
}

/// packages/ndspace/src/validate.ts: ndCheck, as the server calls ndCheckSteps: the check run to
/// its end with the cap NDIM_CHECK_MS on the process's clock.
pub fn nd_check(p: &NdProblemId, config: &NdConfigShape, tol: f64, max_errors: usize) -> Result<Vec<String>, Thrown> {
    nd_check_steps(p, config, tol, max_errors, NDIM_CHECK_MS, &mut performance_now)
}
