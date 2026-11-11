//! The floating-point validator of the polyhedra family, as a server runs it on untrusted input. Port of
//! `packages/polyhedra/src/validate.ts`.
//!
//! A configuration { s, pieces } of a problem (piece solid P, container solid C) is valid at tolerance tol when
//!  - containment: every vertex x of every piece satisfies N_f . x <= s b_f + tol for every face f of the
//!    container s C (unit outward normals N_f, offsets b_f of the canonical C, centred at the origin);
//!  - disjointness: no two pieces overlap by more than tol, i.e. some candidate axis of the separating-axis test
//!    (geom.rs) shows a gap of at least -tol. The candidates contain every face normal of the Minkowski
//!    difference, so this decides "penetration depth <= tol" exactly (up to float rounding).
//! Pieces may touch. Distances are in the units of the canonical solids (edge 1 for most solids).
//!
//! Work: pairs whose centres are farther apart than twice the piece's circumradius (plus tol) are disjoint and
//! skipped; the others get one separating-axis test each, which stops at the first axis with a gap of at least
//! `stop_at` (default 1e-3: such a pair is valid whatever tol is). The check ends after max_errors errors. Both
//! bound the time of one check.
//!
//! The source's `validateSteps` is a generator that yields to the event loop, and `validatePolyhedraAsync` runs
//! it in slices; both give the result of `validatePolyhedra`, which is the one function here (PORTING.md, rule 5).

use crate::catalogue::ProblemName;
use crate::geom::{place, separation, wall_gap, Placed, Pose};
use crate::solids::get_solid;
use polypack_js::{fmt, math};
use serde_json::Value;

/// `validate.ts: POLYHEDRA_TOL`: PolyPack's touching tolerance.
pub const POLYHEDRA_TOL: f64 = 1e-9;
/// `validate.ts: POLYHEDRA_MIN_QUATERNION_NORM`: smallest accepted norm of a pose's quaternion.
pub const POLYHEDRA_MIN_QUATERNION_NORM: f64 = 1e-6;
/// `validate.ts: POLYHEDRA_MAX_COORD`: largest absolute value of a centre coordinate.
pub const POLYHEDRA_MAX_COORD: f64 = 1e4;
/// `validate.ts: POLYHEDRA_MAX_QUATERNION`: largest absolute value of a quaternion component. Only the direction
/// of q matters (the rotation is H(q) / |q|^2), and exact rational rotations are stored with large integer
/// quaternions (some records use components near 5e48), so the bound only keeps |q|^2 far from overflow.
pub const POLYHEDRA_MAX_QUATERNION: f64 = 1e100;
/// `validate.ts: POLYHEDRA_MAX_SIZE`: largest container scale accepted.
pub const POLYHEDRA_MAX_SIZE: f64 = 1e6;

/// `validate.ts: PolyhedraConfig`.
#[derive(Clone, Debug, PartialEq)]
pub struct PolyhedraConfig {
    /// Container scale: the container is s times the canonical container solid, centred at the origin.
    pub s: f64,
    /// One pose [x, y, z, qw, qx, qy, qz] per piece.
    pub pieces: Vec<Pose>,
}

/// `validate.ts: ValidateOptions`. `None` is the source's default.
#[derive(Clone, Copy, Debug, Default)]
pub struct ValidateOptions {
    /// Default POLYHEDRA_TOL.
    pub tol: Option<f64>,
    /// Errors listed at most; the check ends after this many. Default 20.
    pub max_errors: Option<usize>,
    /// A pair is settled as soon as an axis shows this gap; default 1e-3. Infinity for exact separations.
    pub stop_at: Option<f64>,
}

/// `validate.ts: PolyhedraValidation`.
#[derive(Clone, Debug, PartialEq)]
pub struct PolyhedraValidation {
    pub valid: bool,
    pub errors: Vec<String>,
    /// Smallest wall gap s b_f - N_f . x over all vertices and faces (negative: protrusion).
    pub min_wall_gap: f64,
    /// Smallest pair separation found (negative: overlap depth); Infinity when no pair is near.
    pub min_pair_sep: f64,
    /// The pair with the smallest separation.
    pub worst_pair: Option<(usize, usize)>,
    /// Pairs given a separating-axis test.
    pub pairs_tested: u64,
}

/// `validate.ts: isFiniteNumber` on a JSON value: a number (JSON has no NaN or Infinity; a literal too large
/// for a double, which JSON.parse reads as Infinity, is not finite either way).
fn finite_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        _ => None,
    }
}

/// The three range checks of one pose in `configErrors`, in its order (the first that fails is reported).
fn pose_range_error(i: usize, p: &Pose, errors: &mut Vec<String>) {
    if p[0..3].iter().any(|v| math::abs(*v) > POLYHEDRA_MAX_COORD) {
        errors.push(format!(
            "pieces[{i}]: x, y and z must be at most {} in absolute value",
            fmt::num(POLYHEDRA_MAX_COORD)
        ));
    } else if p[3..].iter().any(|v| math::abs(*v) > POLYHEDRA_MAX_QUATERNION) {
        errors.push(format!(
            "pieces[{i}]: quaternion components must be at most {} in absolute value",
            fmt::num(POLYHEDRA_MAX_QUATERNION)
        ));
    } else if !(math::hypot4(p[3], p[4], p[5], p[6]) >= POLYHEDRA_MIN_QUATERNION_NORM) {
        errors.push(format!(
            "pieces[{i}]: the quaternion must have a norm of at least {}",
            fmt::num(POLYHEDRA_MIN_QUATERNION_NORM)
        ));
    }
}

/// `validate.ts: configErrors`: reads a configuration from untrusted JSON: s positive and at most
/// POLYHEDRA_MAX_SIZE, each pose 7 finite numbers, the centre's at most POLYHEDRA_MAX_COORD and the quaternion's
/// at most POLYHEDRA_MAX_QUATERNION in absolute value, with a quaternion norm of at least
/// POLYHEDRA_MIN_QUATERNION_NORM. Returns the errors (empty when it is well formed). `p` is the source's
/// optional P (the number of pieces the problem has).
pub fn config_errors(config: &Value, p: Option<usize>, max_errors: usize) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    let Value::Object(c) = config else {
        return vec!["config must be an object {s, pieces}".to_string()];
    };
    let s_ok = matches!(finite_number(c.get("s")), Some(s) if s > 0.0 && !(s > POLYHEDRA_MAX_SIZE));
    if !s_ok {
        errors.push(format!("s must be a positive finite number of at most {}", fmt::num(POLYHEDRA_MAX_SIZE)));
    }
    let Some(Value::Array(pieces)) = c.get("pieces") else {
        errors.push("pieces must be an array of [x, y, z, qw, qx, qy, qz]".to_string());
        return errors;
    };
    if let Some(p) = p {
        if pieces.len() != p {
            errors.push(format!("expected {} pieces for this problem, got {}", p, pieces.len()));
        }
    }
    let mut i = 0;
    while i < pieces.len() && errors.len() < max_errors {
        match pose_of_value(&pieces[i]) {
            None => errors.push(format!("pieces[{i}] must be [x, y, z, qw, qx, qy, qz] of finite numbers")),
            Some(pose) => pose_range_error(i, &pose, &mut errors),
        }
        i += 1;
    }
    errors
}

/// A JSON value as a pose: an array of exactly 7 finite numbers, or None.
fn pose_of_value(v: &Value) -> Option<Pose> {
    let Value::Array(a) = v else { return None };
    if a.len() != 7 {
        return None;
    }
    let mut pose = [0.0f64; 7];
    for (k, x) in a.iter().enumerate() {
        pose[k] = finite_number(Some(x))?;
    }
    Some(pose)
}

/// `configErrors` on a configuration whose numbers are already read: s and one list of numbers per piece. The
/// same rules and messages in the same order as `config_errors` (such a configuration is an object with an array
/// of arrays of numbers, so only the lengths and the values can be wrong). `p` is the source's optional P.
pub fn config_errors_numbers<T: AsRef<[f64]>>(s: f64, pieces: &[T], p: Option<usize>, max_errors: usize) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    if !s.is_finite() || !(s > 0.0) || s > POLYHEDRA_MAX_SIZE {
        errors.push(format!("s must be a positive finite number of at most {}", fmt::num(POLYHEDRA_MAX_SIZE)));
    }
    if let Some(p) = p {
        if pieces.len() != p {
            errors.push(format!("expected {} pieces for this problem, got {}", p, pieces.len()));
        }
    }
    let mut i = 0;
    while i < pieces.len() && errors.len() < max_errors {
        let piece = pieces[i].as_ref();
        match <&Pose>::try_from(piece) {
            Ok(pose) if pose.iter().all(|v| v.is_finite()) => pose_range_error(i, pose, &mut errors),
            _ => errors.push(format!("pieces[{i}] must be [x, y, z, qw, qx, qy, qz] of finite numbers")),
        }
        i += 1;
    }
    errors
}

/// `configErrors` on a typed configuration (see `config_errors_numbers`).
pub fn config_errors_typed(config: &PolyhedraConfig, max_errors: usize) -> Vec<String> {
    config_errors_numbers(config.s, &config.pieces, None, max_errors)
}

/// The configuration of a JSON value that `config_errors` found well formed: s and the poses, with only those
/// fields kept. None when it is not such a configuration.
pub fn config_of_value(config: &Value) -> Option<PolyhedraConfig> {
    let c = config.as_object()?;
    let s = finite_number(c.get("s"))?;
    let pieces = c.get("pieces")?.as_array()?.iter().map(pose_of_value).collect::<Option<Vec<Pose>>>()?;
    Some(PolyhedraConfig { s, pieces })
}

fn empty_validation() -> PolyhedraValidation {
    PolyhedraValidation {
        valid: false,
        errors: Vec::new(),
        min_wall_gap: f64::INFINITY,
        min_pair_sep: f64::INFINITY,
        worst_pair: None,
        pairs_tested: 0,
    }
}

/// `validate.ts: validateSteps` after its check of the form: the geometry of a well-formed configuration.
fn validate_geometry(
    problem: &ProblemName,
    config: &PolyhedraConfig,
    tol: f64,
    max_errors: usize,
    stop_at: f64,
    mut out: PolyhedraValidation,
) -> Result<PolyhedraValidation, String> {
    let piece = get_solid(&problem.piece)?;
    let container = get_solid(&problem.container)?;
    let n = config.pieces.len();
    let s = config.s;
    let mut placed: Vec<Placed> = Vec::with_capacity(n);
    for i in 0..n {
        placed.push(place(piece, &config.pieces[i])?);
    }
    let mut i = 0;
    while i < n && out.errors.len() < max_errors {
        let g = wall_gap(container, s, &placed[i].x);
        if g < out.min_wall_gap {
            out.min_wall_gap = g;
        }
        if !(g >= -tol) {
            out.errors.push(format!("piece {} sticks out of the container by {}", i, fmt::num(-g)));
        }
        i += 1;
    }
    // pieces lie in their circumscribed balls: centres more than 2 R apart cannot overlap
    let reach = 2.0 * piece.circumradius + tol;
    let reach2 = reach * reach;
    let mut i = 0;
    while i < n && out.errors.len() < max_errors {
        let a = placed[i].c;
        let mut j = i + 1;
        while j < n && out.errors.len() < max_errors {
            let b = placed[j].c;
            let dx = a[0] - b[0];
            let dy = a[1] - b[1];
            let dz = a[2] - b[2];
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 > reach2 {
                j += 1;
                continue;
            }
            out.pairs_tested += 1;
            let r = separation(&placed[i], &placed[j], stop_at, None);
            if r.sep < out.min_pair_sep {
                out.min_pair_sep = r.sep;
                out.worst_pair = Some((i, j));
            }
            if !(r.sep >= -tol) {
                out.errors.push(format!("pieces {} and {} overlap by {}", i, j, fmt::num(-r.sep)));
            }
            j += 1;
        }
        i += 1;
    }
    out.valid = out.errors.is_empty();
    Ok(out)
}

/// `validate.ts: validatePolyhedra` (and `validatePolyhedraAsync`, the same check in slices): checks a
/// configuration of a problem at its stated s.
///
/// The source says "never throws", which holds for the server's calls (max_errors 20, a problem of the
/// catalogue). What it would throw otherwise is the `Err` here, with the source's message: `unknown solid <name>`
/// for a problem whose solids are not in the table, and "the quaternion must be finite and nonzero" when
/// max_errors is 0 (the check of the form then reads no pose) and a quaternion is zero.
pub fn validate_polyhedra(
    problem: &ProblemName,
    config: &PolyhedraConfig,
    opts: &ValidateOptions,
) -> Result<PolyhedraValidation, String> {
    let tol = opts.tol.unwrap_or(POLYHEDRA_TOL);
    let max_errors = opts.max_errors.unwrap_or(20);
    let stop_at = opts.stop_at.unwrap_or(1e-3);
    let mut out = empty_validation();
    let bad = config_errors_typed(config, max_errors);
    if !bad.is_empty() {
        out.errors = bad;
        return Ok(out);
    }
    validate_geometry(problem, config, tol, max_errors, stop_at, out)
}

/// `validatePolyhedra` on a configuration that is still JSON (the source takes any value at run time): the check
/// of the form is `config_errors`, then the geometry. With max_errors 0 the source reads poses it has not
/// checked and throws a TypeError on one that is not an array of numbers; that is an `Err` here.
pub fn validate_polyhedra_value(
    problem: &ProblemName,
    config: &Value,
    opts: &ValidateOptions,
) -> Result<PolyhedraValidation, String> {
    let tol = opts.tol.unwrap_or(POLYHEDRA_TOL);
    let max_errors = opts.max_errors.unwrap_or(20);
    let stop_at = opts.stop_at.unwrap_or(1e-3);
    let mut out = empty_validation();
    let bad = config_errors(config, None, max_errors);
    if !bad.is_empty() {
        out.errors = bad;
        return Ok(out);
    }
    let typed = config_of_value(config).ok_or_else(|| "the configuration was not checked (max_errors is 0)".to_string())?;
    validate_geometry(problem, &typed, tol, max_errors, stop_at, out)
}
