//! Float validator of the simplex, orthoplex and demicube problems (d = 5..10, balls of diameter 1;
//! docs/spaces/BOUNDARY.md section 4D), tolerance tol (default 1e-9).
//! Port of packages/boundary/src/nd/validate.ts (the validator; `measureND` serves the docs).
//!
//! The rule is 4.2's, which is dimension-free: a configuration is valid exactly when
//!  - every centre lies in its closed anchor cell (within tol),
//!  - every centre is at geodesic distance >= 1/2 - tol from the hinges (the (d-3)-faces),
//!  - every two centres are >= 1 - tol apart along the boundary,
//!  - no geodesic loop at a centre is shorter than 1 - tol.
//! The engine is chains.rs: half-chains of reach 1/2 from every centre, hinge distances inside
//! their windows, and joins of two half-chains in a common cell for pairs and loops. Pairs are
//! searched only when the centres are < 1 apart in R^D (a geodesic is never shorter than the chord).
//!
//! A centre within the snap distance eta of a ridge plane is moved onto it (the move is charged to
//! the verdict: thresholds of that piece are tightened by the distance it moved) and then belongs
//! to both cells, which are both used as anchors, as in the 4-polytope engine.
//!
//! Work is capped. A check stops after opts.max_work steps (default ND_MAX_WORK) or opts.max_ops
//! multiply-adds (default nd_max_ops: the steps do not bound the time, 4D.8) and refuses the
//! configuration with a plain reason: a packing that crowds balls against the hinges, or a
//! container too small for its balls, is refused (sound, incomplete), never accepted.

use super::bounds::{nd_ball_volume, nd_boundary_volume};
use super::chains::{develop, hinge_distance, join_distance, nd_zero_length, new_nd_budget, NdBudget, NdLimitError, NdNode};
use super::container::{get_nd, NdContainer};
use super::names::is_nd_name;
use crate::types::{BoundaryProblem, BoundaryVerdict};
use crate::validate::{finite_number, finite_numbers, fmt, is_integer, limit, push, ValidateOptions, MAX_S};
use polypack_js::fmt::num;
use polypack_js::math;
use serde_json::Value;

/// Search steps one check may spend (chains.rs): BOUNDARY.md 4D.7 gives the measurements it comes from.
/// packages/boundary/src/nd/validate.ts: ND_MAX_WORK
pub const ND_MAX_WORK: f64 = 60_000.0;
/// Multiply-adds one check may spend (chains.rs spend_ops): bounds the time of a refused check
/// (4D.8). The 8-demicube gets twice the others': two balls at facet centres there (every hinge
/// tied) need 4.1e7 and are valid.
/// packages/boundary/src/nd/validate.ts: ND_MAX_OPS
pub const ND_MAX_OPS: f64 = 3e7;
/// packages/boundary/src/nd/validate.ts: ndMaxOps
pub fn nd_max_ops(polytope: &str) -> f64 {
    if polytope == "8demicube" {
        2.0 * ND_MAX_OPS
    } else {
        ND_MAX_OPS
    }
}

/// packages/boundary/src/nd/validate.ts: NDConfig
#[derive(Clone, Debug, PartialEq)]
pub struct NdConfig {
    pub s: f64,
    pub pieces: Vec<NdPiece>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NdPiece {
    pub cell: usize,
    pub u: Vec<f64>,
}

/// Checks the shape of a configuration; returns the typed pieces or pushes reasons.
/// packages/boundary/src/nd/validate.ts: readNDConfig
pub fn read_nd_config(c: &NdContainer, problem: &BoundaryProblem, config: &Value, reasons: &mut Vec<String>, max_reasons: f64) -> Option<NdConfig> {
    let Value::Object(config) = config else {
        push(reasons, max_reasons, "The configuration must be an object with s and pieces.".to_string());
        return None;
    };
    let s = finite_number(config.get("s"));
    match s {
        None => push(reasons, max_reasons, "The edge s must be a finite number.".to_string()),
        Some(s) => {
            if !(s > 0.0 && s <= MAX_S) {
                push(reasons, max_reasons, format!("The edge s must be greater than 0 and at most {}; it is {}.", num(MAX_S), fmt(s)));
            }
        }
    }
    let Some(Value::Array(list)) = config.get("pieces") else {
        push(reasons, max_reasons, "The configuration needs a list of pieces.".to_string());
        return None;
    };
    if list.len() as f64 != problem.p {
        push(reasons, max_reasons, format!("The configuration has {} pieces; the problem needs exactly {}.", list.len(), num(problem.p)));
    }
    if !reasons.is_empty() {
        return None;
    }
    let mut pieces: Vec<NdPiece> = Vec::new();
    for (i, raw) in list.iter().enumerate() {
        let Value::Object(raw) = raw else {
            push(reasons, max_reasons, format!("Piece {i} must be an object with cell and u."));
            continue;
        };
        let mut ok = true;
        let cell = finite_number(raw.get("cell"));
        if !matches!(cell, Some(x) if is_integer(x) && x >= 0.0 && x < c.c as f64) {
            push(reasons, max_reasons, format!("Piece {i}: its cell must be a whole number from 0 to {}.", c.c - 1));
            ok = false;
        }
        let u = finite_numbers(raw.get("u"), c.n);
        if u.is_none() {
            push(reasons, max_reasons, format!("Piece {i}: its centre u must be {} finite numbers.", c.n));
            ok = false;
        }
        if raw.get("q").is_some() {
            push(reasons, max_reasons, format!("Piece {i}: a ball on the {} has no rotation q.", problem.polytope));
            ok = false;
        }
        let (true, Some(u)) = (ok, u) else { continue };
        pieces.push(NdPiece { cell: cell.expect("checked") as usize, u });
    }
    if !reasons.is_empty() {
        return None;
    }
    Some(NdConfig { s: s.expect("a reason was pushed otherwise"), pieces })
}

/// The snap distance of a centre to a ridge plane (4-polytope engine's ridge_snap, chains.rs there).
/// packages/boundary/src/nd/validate.ts: ndSnap
pub fn nd_snap(s: f64, tol: f64) -> f64 {
    let base = 1e-14 * math::max(1.0, s);
    // 2 ** -52 is f64::EPSILON
    math::max(f64::EPSILON * math::max(1.0, s), math::min(base, tol / 10.0))
}

/// One of the cells a centre belongs to, with the centre in that cell's hyperplane.
#[derive(Clone, Debug)]
pub struct NdAnchor {
    pub cell: usize,
    pub x: Vec<f64>,
}

/// packages/boundary/src/nd/validate.ts: NDAnchored
#[derive(Clone, Debug)]
pub struct NdAnchored {
    /// The claimed cell and the centre in ambient coordinates, clamped into it and snapped to the ridges within eta.
    pub x: Vec<f64>,
    pub cell: usize,
    /// How far the clamp and snap moved the centre.
    pub moved: f64,
    /// How far the centre was outside its closed cell before (<= 0 inside).
    pub outside: f64,
    /// All the cells the centre belongs to (the claimed one first) and the centre in each one's hyperplane.
    pub anchors: Vec<NdAnchor>,
}

/// Reads a centre of cell c (local u at edge s): clamped into the closed cell, snapped onto the ridge planes within eta.
/// packages/boundary/src/nd/validate.ts: anchorPiece
pub fn anchor_piece(cc: &NdContainer, s: f64, c: usize, u: &[f64], eta: f64) -> NdAnchored {
    let d = cc.dd;
    let cl = cc.cell(c);
    let x0 = cc.to_ambient(c, u, s);
    let mut x = x0.clone();
    let mut outside = f64::NEG_INFINITY;
    let f = cl.nbr.len();
    for k in 0..f {
        let mut v = -s * cl.hn[k];
        for j in 0..d {
            v += cl.nn[k * d + j] * x[j];
        }
        if v > outside {
            outside = v;
        }
    }
    let mut nu = vec![0.0; d];
    for _pass in 0..6 {
        let mut moved = false;
        for k in 0..f {
            let mut v = -s * cl.hn[k];
            let mut c1 = 0.0;
            for j in 0..d {
                v += cl.nn[k * d + j] * x[j];
                c1 += cl.nn[k * d + j] * cl.n[j];
            }
            if v > 0.0 || (v > -eta && v != 0.0) {
                let fq = v / cl.nu2[k];
                for j in 0..d {
                    nu[j] = cl.nn[k * d + j] - c1 * cl.n[j];
                    x[j] -= fq * nu[j];
                }
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    let mut mv = 0.0;
    for j in 0..d {
        mv += (x[j] - x0[j]) * (x[j] - x0[j]);
    }
    let mut anchors: Vec<NdAnchor> = vec![NdAnchor { cell: c, x: x.clone() }];
    for k in 0..f {
        let mut v = -s * cl.hn[k];
        for j in 0..d {
            v += cl.nn[k * d + j] * x[j];
        }
        if v.abs() <= 4.0 * eta {
            let g = cc.cell(cl.nbr[k]);
            let mut y = x.clone();
            let mut e = -s * g.h;
            for j in 0..d {
                e += g.n[j] * y[j];
            }
            for j in 0..d {
                y[j] -= e * g.n[j];
            }
            anchors.push(NdAnchor { cell: cl.nbr[k], x: y });
        }
    }
    NdAnchored { x, cell: c, moved: mv.sqrt(), outside, anchors }
}

/// Reach of the half-chains: half the diameter of a ball, with a hair for rounding. It must stay
/// below the margins of the packings the server is to accept (records carry margins of 1e-12 and
/// more): a hinge or a pair within the reach makes a tie, and ties are where the search cost
/// explodes (4D.8).
/// packages/boundary/src/nd/validate.ts: ND_REACH
pub const ND_REACH: f64 = 0.5 * (1.0 + 1e-12);

/// packages/boundary/src/nd/validate.ts: validateBalls
fn validate_balls(c: &NdContainer, cfg: &NdConfig, tol: f64, max_reasons: f64, budget: &mut NdBudget) -> Result<Vec<String>, NdLimitError> {
    let mut reasons: Vec<String> = Vec::new();
    let s = cfg.s;
    let pieces = &cfg.pieces;
    let p = pieces.len();
    let eta = nd_snap(s, tol);
    let at: Vec<NdAnchored> = pieces.iter().map(|pc| anchor_piece(c, s, pc.cell, &pc.u, eta)).collect();
    for (i, a) in at.iter().enumerate() {
        if !(a.outside <= tol) {
            push(&mut reasons, max_reasons, format!("Piece {i}: its centre lies outside its anchor cell {} by {}.", a.cell, fmt(a.outside)));
        }
    }
    if !reasons.is_empty() {
        return Ok(reasons);
    }
    // the half-chains of every centre, from every cell it belongs to
    let mut chains: Vec<Vec<Vec<NdNode>>> = Vec::with_capacity(p);
    for i in 0..p {
        // the centre's own cell first: a centre nearer than 1/2 to a hinge of it is refused before any chain is built
        let mut root_only: Vec<Vec<NdNode>> = Vec::with_capacity(at[i].anchors.len());
        for an in &at[i].anchors {
            root_only.push(develop(c, s, an.cell, &an.x, 0.0, budget)?);
        }
        let mut h0 = f64::INFINITY;
        for r in &root_only {
            h0 = math::min(h0, hinge_distance(c, s, r, ND_REACH, budget, -1)?.dist);
        }
        if !(h0 >= 0.5 - tol + at[i].moved) {
            push(
                &mut reasons,
                max_reasons,
                format!("Ball {i} is {} from a (d-3)-face of the {}; it must be at least 0.5, or the face passes through the ball.", fmt(h0), c.name),
            );
            chains.push(vec![]);
            continue;
        }
        let mut cs: Vec<Vec<NdNode>> = Vec::with_capacity(at[i].anchors.len());
        for an in &at[i].anchors {
            cs.push(develop(c, s, an.cell, &an.x, ND_REACH, budget)?);
        }
        let mut h = f64::INFINITY;
        for ch in &cs {
            h = math::min(h, hinge_distance(c, s, ch, ND_REACH, budget, -1)?.dist);
        }
        chains.push(cs);
        if !(h >= 0.5 - tol + at[i].moved) {
            push(
                &mut reasons,
                max_reasons,
                format!("Ball {i} is {} from a (d-3)-face of the {} along a path over a ridge; it must be at least 0.5, or the face passes through the ball.", fmt(h), c.name),
            );
        }
    }
    if !reasons.is_empty() {
        return Ok(reasons);
    }
    // pairs
    let mut i = 0;
    while i < p && (reasons.len() as f64) < max_reasons {
        let mut j = i + 1;
        while j < p && (reasons.len() as f64) < max_reasons {
            let mut q = 0.0;
            for r in 0..c.dd {
                q += (at[i].x[r] - at[j].x[r]) * (at[i].x[r] - at[j].x[r]);
            }
            let lim = 1.0 - tol + at[i].moved + at[j].moved;
            if !(q < 1.0 * 1.0) {
                j += 1;
                continue;
            }
            let mut best = f64::INFINITY;
            // two different balls at (nearly) one point overlap whatever the chains say (4D.2)
            let zero = nd_zero_length(s);
            if q < zero * zero {
                best = q.sqrt();
            } else {
                for a in &chains[i] {
                    for b in &chains[j] {
                        best = math::min(best, join_distance(c, s, a, b, lim, budget, false, 1e-12, false)?.dist);
                    }
                }
            }
            if best < lim {
                push(&mut reasons, max_reasons, format!("Balls {i} and {j} overlap: their centres are {} apart along the boundary; they must be at least 1 apart.", fmt(best)));
            }
            j += 1;
        }
        i += 1;
    }
    // loops
    let mut i = 0;
    while i < p && (reasons.len() as f64) < max_reasons {
        let lim = 1.0 - tol + 2.0 * at[i].moved;
        let mut best = f64::INFINITY;
        for a in 0..chains[i].len() {
            for b in a..chains[i].len() {
                best = math::min(best, join_distance(c, s, &chains[i][a], &chains[i][b], lim, budget, a == b, 1e-12, true)?.dist);
            }
        }
        if best < lim {
            push(&mut reasons, max_reasons, format!("Ball {i} overlaps itself: a geodesic loop of length {} leaves and returns to its centre; it must be at least 1.", fmt(best)));
        }
        i += 1;
    }
    Ok(reasons)
}

/// The steps and the multiply-adds a check used (the source's `opts.stats`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NdStats {
    pub steps: f64,
    pub ops: f64,
}

/// Validates a configuration of balls on a simplex, orthoplex or demicube. Never fails on input.
/// packages/boundary/src/nd/validate.ts: validateND
pub fn validate_nd(problem: &BoundaryProblem, config: &Value, opts: &ValidateOptions) -> BoundaryVerdict {
    validate_nd_stats(problem, config, opts).0
}

/// `validate_nd` with the work it used (zero when the check stopped before the geometry).
pub fn validate_nd_stats(problem: &BoundaryProblem, config: &Value, opts: &ValidateOptions) -> (BoundaryVerdict, NdStats) {
    // typeof opts.tol === "number" && opts.tol >= 0 ? opts.tol : 1e-9
    let tol = match opts.tol {
        Some(t) if t >= 0.0 => t,
        _ => 1e-9,
    };
    let max_reasons = limit(opts.max_reasons, 20.0);
    let max_work = limit(opts.max_work, ND_MAX_WORK);
    let mut reasons: Vec<String> = Vec::new();
    let bad = |reasons: Vec<String>| -> (BoundaryVerdict, NdStats) {
        (BoundaryVerdict { ok: false, score: None, reasons: if reasons.is_empty() { vec!["The configuration is malformed.".to_string()] } else { reasons } }, NdStats::default())
    };
    let Some(c) = (if is_nd_name(&problem.polytope) { get_nd(&problem.polytope) } else { None }) else {
        reasons.push(format!("Unknown polytope \"{}\".", problem.polytope));
        return bad(reasons);
    };
    if problem.piece != "ball" {
        reasons.push(format!("Unknown piece \"{}\": the {} takes balls only.", problem.piece, problem.polytope));
        return bad(reasons);
    }
    if !(is_integer(problem.p) && problem.p >= 1.0) {
        reasons.push("The problem's P must be a whole number from 1.".to_string());
        return bad(reasons);
    }
    let Some(cfg) = read_nd_config(c, problem, config, &mut reasons, max_reasons) else { return bad(reasons) };
    // volume bound [CALC]: the balls' volumes add up to at most the boundary's (1e-6 absorbs overlaps within tol)
    let piece_volume = nd_ball_volume(c.n);
    let volume = nd_boundary_volume(c.family, c.d) * math::pow(cfg.s, c.n as f64);
    let count = cfg.pieces.len() as f64;
    if !(count * piece_volume <= volume * (1.0 + 1e-6)) {
        return (
            BoundaryVerdict {
                ok: false,
                score: None,
                reasons: vec![format!(
                    "{} balls have a total volume of {}, more than the {} of the {}'s boundary at s = {}.",
                    cfg.pieces.len(),
                    fmt(count * piece_volume),
                    fmt(volume),
                    problem.polytope,
                    fmt(cfg.s)
                )],
            },
            NdStats::default(),
        );
    }
    let mut budget = new_nd_budget(max_work, opts.max_ops.unwrap_or_else(|| nd_max_ops(&problem.polytope)));
    let geo = match validate_balls(c, &cfg, tol, max_reasons, &mut budget) {
        Ok(geo) => geo,
        Err(NdLimitError(message)) => vec![format!(
            "The check reached its work limit ({}) before it could decide: too many balls crowd the (d-3)-faces of the {}.",
            message.replacen("the check needs more than ", "", 1),
            problem.polytope
        )],
    };
    let stats = NdStats { steps: budget.steps, ops: budget.ops };
    (if geo.is_empty() { BoundaryVerdict { ok: true, score: Some(cfg.s), reasons: vec![] } } else { BoundaryVerdict { ok: false, score: None, reasons: geo } }, stats)
}
