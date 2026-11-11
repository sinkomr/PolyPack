//! The floating-point validator of the balls family, as a server runs it on untrusted input. Port of what the
//! server reaches of `packages/balls/src/validate.ts`.
//!
//! A configuration {s, pieces} of a problem is valid at tolerance tol when
//!  - balls (radius r = BALL_RADIUS): every two centres are at least 2 r - tol apart; in a ball container every
//!    centre has |c| <= s / 2 - r + tol (the ball of diameter s), in a cube container every coordinate
//!    |c_k| <= s / 2 - r + tol (the cube [-s/2, s/2]^3), in any other solid C every face has
//!    N_f . c <= s b_f - r + tol (N_f the unit outward normal and b_f the offset of face f of the canonical
//!    solid, container.rs);
//!  - solids: every vertex x of every piece has |x| <= s / 2 + tol, and no two pieces overlap by more than tol,
//!    i.e. the polyhedra family's separating-axis test (polypack-polyhedra geom.rs: face normals of both pieces
//!    and the Gauss-map pruned edge cross products, which decide the penetration depth exactly up to rounding)
//!    shows a gap of at least -tol.
//! Pieces may touch. Gaps and protrusions are lengths in the pieces' units (ball radius BALL_RADIUS, solid edge 1).
//!
//! Work: P is bounded by the caller (the registry's SPACE_MAX_P, 100). Ball pairs cost a few flops each; solid
//! pairs whose centres are more than twice the circumradius apart are skipped, and the others stop at the first
//! axis with a gap of 1e-3. The check ends after max_errors errors.

use crate::catalogue::{ball_container_radius, BallsProblem, BALL_DIAMETER, BALL_RADIUS};
use crate::container::{container_kind, container_of_problem, wall_gap, ContainerKind};
use polypack_js::{fmt, math};
use polypack_polyhedra::{
    config_errors as polyhedra_config_errors, config_errors_numbers as polyhedra_config_errors_numbers, get_solid, place,
    separation, Placed, Pose,
};
use serde_json::Value;

/// `validate.ts: BALLS_TOL`: PolyPack's touching tolerance.
pub const BALLS_TOL: f64 = 1e-9;
/// `validate.ts: BALLS_MAX_SIZE`: largest container size s accepted.
pub const BALLS_MAX_SIZE: f64 = 1e6;
/// `validate.ts: BALLS_MAX_COORD`: largest absolute value of a centre coordinate.
pub const BALLS_MAX_COORD: f64 = 1e4;

/// `validate.ts: BallsPose`: a ball's centre [x, y, z], or a solid's pose [x, y, z, qw, qx, qy, qz] (the
/// polyhedra family's pose).
pub type BallsPose = Vec<f64>;

/// `validate.ts: BallsConfig`.
#[derive(Clone, Debug, PartialEq)]
pub struct BallsConfig {
    /// The container's diameter (ball), edge (cube) or scale (any other solid).
    pub s: f64,
    pub pieces: Vec<BallsPose>,
}

/// The options of `validateBalls`. `None` is the source's default.
#[derive(Clone, Copy, Debug, Default)]
pub struct BallsValidateOptions {
    /// Default BALLS_TOL.
    pub tol: Option<f64>,
    /// Errors listed at most; the check ends after this many. Default 20.
    pub max_errors: Option<usize>,
}

/// `validate.ts: BallsValidation`.
#[derive(Clone, Debug, PartialEq)]
pub struct BallsValidation {
    pub valid: bool,
    pub errors: Vec<String>,
    /// Smallest gap to the container's boundary (negative: protrusion).
    pub min_wall_gap: f64,
    /// Smallest gap between two near pieces (negative: overlap depth); Infinity when no pair is near (balls:
    /// centres less than 1.25 diameters apart; solids: centres less than twice the circumradius apart). A solid
    /// pair's test stops at the first axis with a gap of 1e-3, so a gap above that is a lower bound.
    pub min_pair_sep: f64,
    pub worst_pair: Option<(usize, usize)>,
}

/// `validate.ts: isFiniteNumber` on a JSON value.
fn finite_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        _ => None,
    }
}

/// A JSON value as a ball's centre: an array of exactly 3 finite numbers, or None.
fn centre_of_value(v: &Value) -> Option<[f64; 3]> {
    let Value::Array(a) = v else { return None };
    if a.len() != 3 {
        return None;
    }
    Some([finite_number(a.first())?, finite_number(a.get(1))?, finite_number(a.get(2))?])
}

/// `validate.ts: ballsConfigErrors`: the errors of a configuration's form (empty when it is well formed): s
/// positive and at most BALLS_MAX_SIZE; P pieces when P is given; a ball is [x, y, z] of finite numbers of at
/// most BALLS_MAX_COORD; a solid is a pose of 7 finite numbers as the polyhedra family reads it (centre at most
/// 1e4, quaternion components at most 1e100, norm at least 1e-6).
pub fn balls_config_errors(problem: &BallsProblem, config: &Value, p: Option<usize>, max_errors: usize) -> Vec<String> {
    if problem.piece != "ball" {
        let mut errors = polyhedra_config_errors(config, p, max_errors);
        // (config as { s?: unknown } | null)?.s
        let s = finite_number(config.as_object().and_then(|c| c.get("s")));
        if errors.is_empty() && matches!(s, Some(s) if s > BALLS_MAX_SIZE) {
            errors.push(format!("s must be a positive finite number of at most {}", fmt::num(BALLS_MAX_SIZE)));
        }
        return errors;
    }
    let mut errors: Vec<String> = Vec::new();
    let Value::Object(c) = config else {
        return vec!["config must be an object {s, pieces}".to_string()];
    };
    let s_ok = matches!(finite_number(c.get("s")), Some(s) if s > 0.0 && !(s > BALLS_MAX_SIZE));
    if !s_ok {
        errors.push(format!("s must be a positive finite number of at most {}", fmt::num(BALLS_MAX_SIZE)));
    }
    let Some(Value::Array(pieces)) = c.get("pieces") else {
        errors.push("pieces must be an array of [x, y, z]".to_string());
        return errors;
    };
    if let Some(p) = p {
        if pieces.len() != p {
            errors.push(format!("expected {} pieces for this problem, got {}", p, pieces.len()));
        }
    }
    let mut i = 0;
    while i < pieces.len() && errors.len() < max_errors {
        match centre_of_value(&pieces[i]) {
            None => errors.push(format!("pieces[{i}] must be [x, y, z] of finite numbers")),
            Some(c) => {
                if c.iter().any(|v| math::abs(*v) > BALLS_MAX_COORD) {
                    errors.push(format!(
                        "pieces[{i}]: x, y and z must be at most {} in absolute value",
                        fmt::num(BALLS_MAX_COORD)
                    ));
                }
            }
        }
        i += 1;
    }
    errors
}

/// `ballsConfigErrors` on a configuration whose numbers are already read: the same rules and messages in the
/// same order (such a configuration is an object with an array of arrays of numbers, so only the lengths and the
/// values can be wrong).
pub fn balls_config_errors_typed(problem: &BallsProblem, config: &BallsConfig, p: Option<usize>, max_errors: usize) -> Vec<String> {
    if problem.piece != "ball" {
        let mut errors = polyhedra_config_errors_numbers(config.s, &config.pieces, p, max_errors);
        if errors.is_empty() && config.s.is_finite() && config.s > BALLS_MAX_SIZE {
            errors.push(format!("s must be a positive finite number of at most {}", fmt::num(BALLS_MAX_SIZE)));
        }
        return errors;
    }
    let mut errors: Vec<String> = Vec::new();
    let s = config.s;
    if !s.is_finite() || !(s > 0.0) || s > BALLS_MAX_SIZE {
        errors.push(format!("s must be a positive finite number of at most {}", fmt::num(BALLS_MAX_SIZE)));
    }
    if let Some(p) = p {
        if config.pieces.len() != p {
            errors.push(format!("expected {} pieces for this problem, got {}", p, config.pieces.len()));
        }
    }
    let mut i = 0;
    while i < config.pieces.len() && errors.len() < max_errors {
        let c = &config.pieces[i];
        if c.len() != 3 || !c.iter().all(|v| v.is_finite()) {
            errors.push(format!("pieces[{i}] must be [x, y, z] of finite numbers"));
        } else if c.iter().any(|v| math::abs(*v) > BALLS_MAX_COORD) {
            errors.push(format!("pieces[{i}]: x, y and z must be at most {} in absolute value", fmt::num(BALLS_MAX_COORD)));
        }
        i += 1;
    }
    errors
}

/// The configuration of a JSON value that `balls_config_errors` found well formed, with only the known fields
/// kept: each ball its 3 numbers, each solid its 7 (as packages/spaces validate.ts parseBalls cuts them). None
/// when it is not such a configuration.
pub fn balls_config_of_value(problem: &BallsProblem, config: &Value) -> Option<BallsConfig> {
    let c = config.as_object()?;
    let s = finite_number(c.get("s"))?;
    let width = if problem.piece == "ball" { 3 } else { 7 };
    let mut pieces = Vec::new();
    for p in c.get("pieces")?.as_array()? {
        let a = p.as_array()?;
        if a.len() != width {
            return None;
        }
        pieces.push(a.iter().map(|x| finite_number(Some(x))).collect::<Option<Vec<f64>>>()?);
    }
    Some(BallsConfig { s, pieces })
}

/// `validate.ts: validateBalls`: checks a configuration of a problem at its stated s.
///
/// The source says "never throws", which holds for the server's calls (max_errors 20, a problem of the
/// catalogue). What it would throw otherwise is the `Err` here: `unknown solid <name>` for a problem whose
/// solid is not in the table, and a pose the check of the form did not read when max_errors is 0.
pub fn validate_balls(
    problem: &BallsProblem,
    config: &BallsConfig,
    opts: &BallsValidateOptions,
) -> Result<BallsValidation, String> {
    let tol = opts.tol.unwrap_or(BALLS_TOL);
    let max_errors = opts.max_errors.unwrap_or(20);
    let mut out = BallsValidation {
        valid: false,
        errors: Vec::new(),
        min_wall_gap: f64::INFINITY,
        min_pair_sep: f64::INFINITY,
        worst_pair: None,
    };
    let bad = balls_config_errors_typed(problem, config, None, max_errors);
    if !bad.is_empty() {
        out.errors = bad;
        return Ok(out);
    }
    let s = config.s;
    let pieces = &config.pieces;
    let n = pieces.len();
    fn pair(out: &mut BallsValidation, tol: f64, i: usize, j: usize, sep: f64) {
        if sep < out.min_pair_sep {
            out.min_pair_sep = sep;
            out.worst_pair = Some((i, j));
        }
        if !(sep >= -tol) {
            out.errors.push(format!("pieces {} and {} overlap by {}", i, j, fmt::num(-sep)));
        }
    }
    fn wall(out: &mut BallsValidation, tol: f64, i: usize, gap: f64) {
        if gap < out.min_wall_gap {
            out.min_wall_gap = gap;
        }
        if !(gap >= -tol) {
            out.errors.push(format!("piece {} sticks out of the container by {}", i, fmt::num(-gap)));
        }
    }
    let unread = || "the configuration was not checked (max_errors is 0)".to_string();
    if problem.piece == "ball" {
        let kind = container_kind(problem);
        let c = container_of_problem(problem)?;
        let half = s / 2.0 - BALL_RADIUS;
        let mut i = 0;
        while i < n && out.errors.len() < max_errors {
            let p = &pieces[i];
            if p.len() < 3 {
                return Err(unread());
            }
            let (x, y, z) = (p[0], p[1], p[2]);
            let gap = match kind {
                ContainerKind::Ball => ball_container_radius(s) - BALL_RADIUS - math::hypot3(x, y, z),
                ContainerKind::Cube => half - math::max(math::max(math::abs(x), math::abs(y)), math::abs(z)),
                ContainerKind::Polyhedron => {
                    wall_gap(c.as_ref().expect("a solid container has its geometry"), s, BALL_RADIUS, x, y, z)
                }
            };
            wall(&mut out, tol, i, gap);
            i += 1;
        }
        // pairs 0.25 diameters or more beyond contact are valid at any tolerance and are not near
        let near2 = (BALL_DIAMETER * 1.25) * (BALL_DIAMETER * 1.25);
        let mut i = 0;
        while i < n && out.errors.len() < max_errors {
            let a = &pieces[i];
            let mut j = i + 1;
            while j < n && out.errors.len() < max_errors {
                let b = &pieces[j];
                if a.len() < 3 || b.len() < 3 {
                    return Err(unread());
                }
                let dx = a[0] - b[0];
                let dy = a[1] - b[1];
                let dz = a[2] - b[2];
                let d2 = dx * dx + dy * dy + dz * dz;
                if d2 >= near2 {
                    j += 1;
                    continue;
                }
                pair(&mut out, tol, i, j, d2.sqrt() - BALL_DIAMETER);
                j += 1;
            }
            i += 1;
        }
    } else {
        let solid = get_solid(&problem.piece)?;
        let mut placed: Vec<Placed> = Vec::with_capacity(n);
        for p in pieces {
            let pose: Pose = p.as_slice().try_into().map_err(|_| unread())?;
            placed.push(place(solid, &pose)?);
        }
        let mut i = 0;
        while i < n && out.errors.len() < max_errors {
            let x = &placed[i].x;
            let mut far = 0.0f64;
            let mut k = 0;
            while k < x.len() {
                far = math::max(far, math::hypot3(x[k], x[k + 1], x[k + 2]));
                k += 3;
            }
            wall(&mut out, tol, i, ball_container_radius(s) - far);
            i += 1;
        }
        // pieces lie in their circumscribed balls: centres more than 2 R apart cannot overlap
        let reach = 2.0 * solid.circumradius + tol;
        let mut i = 0;
        while i < n && out.errors.len() < max_errors {
            let a = placed[i].c;
            let mut j = i + 1;
            while j < n && out.errors.len() < max_errors {
                let b = placed[j].c;
                let dx = a[0] - b[0];
                let dy = a[1] - b[1];
                let dz = a[2] - b[2];
                if dx * dx + dy * dy + dz * dz > reach * reach {
                    j += 1;
                    continue;
                }
                pair(&mut out, tol, i, j, separation(&placed[i], &placed[j], 1e-3, None).sep);
                j += 1;
            }
            i += 1;
        }
    }
    out.valid = out.errors.is_empty();
    Ok(out)
}

/// `validateBalls` on a configuration that is still JSON (the source takes any value at run time): the check of
/// the form is `balls_config_errors`, then the geometry of the configuration read with `balls_config_of_value`.
pub fn validate_balls_value(
    problem: &BallsProblem,
    config: &Value,
    opts: &BallsValidateOptions,
) -> Result<BallsValidation, String> {
    let max_errors = opts.max_errors.unwrap_or(20);
    let bad = balls_config_errors(problem, config, None, max_errors);
    if !bad.is_empty() {
        return Ok(BallsValidation {
            valid: false,
            errors: bad,
            min_wall_gap: f64::INFINITY,
            min_pair_sep: f64::INFINITY,
            worst_pair: None,
        });
    }
    let typed = balls_config_of_value(problem, config)
        .ok_or_else(|| "the configuration was not checked (max_errors is 0)".to_string())?;
    validate_balls(problem, &typed, opts)
}

/// What the server's parse of a balls configuration answers (packages/spaces/src/validate.ts: `Parsed`).
#[derive(Clone, Debug, PartialEq)]
pub enum BallsParsed {
    /// `{ ok: true, config, score }`.
    Ok { config: BallsConfig, score: f64 },
    /// `{ ok: false, malformed, errors }`.
    Failed { malformed: bool, errors: Vec<String> },
}

/// `packages/spaces/src/validate.ts: parseBalls` for a problem that exists (the caller answers
/// `unknown balls problem <code>` for a code that names none): a configuration of a problem with P pieces from
/// untrusted input, with only the known fields kept (each ball its 3 numbers, each solid its 7). Errors of form
/// are malformed input, except a wrong number of pieces. `max_reasons` is the server's MAX_REASONS, 20.
///
/// The server calls it through `parseSpaceConfig`, which answers "config must be an object" itself for a value
/// that is not an object; for such a value this gives `balls_config_errors`' "config must be an object {s, pieces}".
pub fn parse_balls_config(problem: &BallsProblem, raw: &Value, p: usize, max_reasons: usize) -> BallsParsed {
    let errors = balls_config_errors(problem, raw, None, max_reasons);
    if !errors.is_empty() {
        return BallsParsed::Failed { malformed: true, errors };
    }
    // piecesOf(raw, "pieces", P)
    let Some(list) = raw.get("pieces").and_then(Value::as_array) else {
        return BallsParsed::Failed { malformed: true, errors: vec!["pieces must be an array".to_string()] };
    };
    if list.len() != p {
        return BallsParsed::Failed {
            malformed: false,
            errors: vec![format!("expected {} pieces for this problem, got {}", p, list.len())],
        };
    }
    match balls_config_of_value(problem, raw) {
        Some(config) => {
            let score = config.s;
            BallsParsed::Ok { config, score }
        }
        // only with max_reasons 0, where the check of the form reads no piece
        None => BallsParsed::Failed { malformed: true, errors: vec!["config must be an object {s, pieces}".to_string()] },
    }
}
