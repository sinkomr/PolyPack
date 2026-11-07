//! The server's acceptance rule for flat packings (packages/geometry/src/config.ts `parseConfig`,
//! `evaluate` and `strictVerify`, as apps/server/src/app.ts applies them to POST /api/submit):
//!
//! - N and M are 0 or 3..=100, P is 1..=500, every piece has finite x, y, theta with |x|, |y| at
//!   most 1e6, container_phi is finite;
//! - exactly P pieces, and no pair of pieces with a separation below -1e-9 (TOL): contact and
//!   overlaps up to 1e-9 are accepted;
//! - the score is the size of the smallest enclosing container at the container_phi sent (the
//!   server does not search for a better orientation);
//! - a score below a published value by more than its precision is stored but held for review,
//!   with the shrink test of [`strict_verify`].
//!
//! The client never offers a packing that relies on the 1e-9 allowance: it submits only
//! configurations that are *strict* (no penetration above 1e-12, the search framework's rule),
//! and checks them with [`server_check`] first, which errs on the strict side by a further
//! rounding margin.

use crate::enclose::{auto_orient_set, enclose, enclose_set, extreme_points};
use crate::grid::NeighborGrid;
use crate::sep::pair_separation;
use crate::shapes::{bounding_radius, is_shape_code, Config, Container, Pose, MAX_COORD, MAX_PIECES};

/// Penetration the server tolerates (piece units).
pub const TOL: f64 = 1e-9;
/// Relative score difference below which two entries count as equally good.
pub const SCORE_TIE: f64 = 1e-9;
/// Penetration above which a configuration is not strict (search results must not rely on TOL).
pub const STRICT_TOLERANCE: f64 = 1e-12;

/// True when `score` is better than `leader` by more than the tie tolerance.
pub fn improves_on(score: f64, leader: f64) -> bool {
    score < leader * (1.0 - SCORE_TIE)
}

/// The strict margin of a configuration: STRICT_TOLERANCE, widened by four units in the last
/// place of the largest coordinate far from the origin.
pub fn strict_tolerance(pieces: &[Pose]) -> f64 {
    let mut reach = 0.0f64;
    for p in pieces {
        reach = reach.max(p.x.abs()).max(p.y.abs());
    }
    STRICT_TOLERANCE + 4.0 * f64::EPSILON * reach
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Overlap {
    pub i: usize,
    pub j: usize,
    /// negative; -sep is the penetration depth
    pub sep: f64,
}

/// All pairs whose separation (reference kernel, at `scale`) is below -tol; at most `limit`.
pub fn find_overlaps(n: u32, poses: &[Pose], tol: f64, scale: f64, limit: usize) -> Vec<Overlap> {
    let mut out = Vec::new();
    if limit == 0 {
        return out;
    }
    let reach = 2.0 * bounding_radius(n) * scale;
    let mut grid = NeighborGrid::new();
    grid.build(poses, reach);
    grid.for_each_pair(poses, |i, j| {
        let sep = pair_separation(n, &poses[i], &poses[j], scale);
        if sep < -tol {
            out.push(Overlap { i, j, sep });
            if out.len() >= limit {
                return false;
            }
        }
        true
    });
    out
}

/// Shape and range checks of the server's parseConfig (geometry excluded).
pub fn parse_errors(n: u32, m: u32, p: usize, pieces: &[Pose], phi: f64) -> Vec<String> {
    let mut errors = Vec::new();
    if !is_shape_code(n) {
        errors.push("N must be 0 (circle) or an integer from 3 to 100".to_string());
    }
    if !is_shape_code(m) {
        errors.push("M must be 0 (circle) or an integer from 3 to 100".to_string());
    }
    if p < 1 || p > MAX_PIECES {
        errors.push("P must be an integer from 1 to 500".to_string());
    }
    if pieces.len() > MAX_PIECES {
        errors.push("pieces must have at most 500 entries".to_string());
    } else {
        for (i, q) in pieces.iter().enumerate() {
            if !(q.x.is_finite() && q.y.is_finite() && q.theta.is_finite()) {
                errors.push(format!("pieces[{i}] must have finite numbers x, y, theta"));
                break;
            }
            if q.x.abs() > MAX_COORD || q.y.abs() > MAX_COORD {
                errors.push(format!("pieces[{i}] is outside the coordinate limit of {MAX_COORD}"));
                break;
            }
        }
    }
    if !phi.is_finite() {
        errors.push("container_phi must be a finite number".to_string());
    }
    errors
}

#[derive(Clone, Debug)]
pub struct Evaluation {
    pub valid: bool,
    pub reasons: Vec<String>,
    pub overlaps: Vec<Overlap>,
    pub container: Option<Container>,
    pub score: Option<f64>,
}

/// The server's evaluate(config, {autoOrient, maxOverlaps, stopWhenInvalid}).
pub fn evaluate(config: &Config, p: usize, auto_orient: bool, max_overlaps: usize, stop_when_invalid: bool) -> Evaluation {
    let mut reasons = Vec::new();
    if config.pieces.len() != p {
        reasons.push(format!("expected exactly {p} pieces, got {}", config.pieces.len()));
    }
    let overlaps = find_overlaps(config.n, &config.pieces, TOL, 1.0, max_overlaps);
    if !overlaps.is_empty() {
        let worst = overlaps.iter().fold(overlaps[0], |a, b| if b.sep < a.sep { *b } else { a });
        let count = if overlaps.len() >= max_overlaps {
            format!("at least {}", overlaps.len())
        } else {
            format!("{}", overlaps.len())
        };
        reasons.push(format!(
            "{count} overlapping pair(s); deepest found is pieces {} and {}, penetration {:.3e} (tolerance {TOL})",
            worst.i, worst.j, -worst.sep
        ));
    }
    if stop_when_invalid && !reasons.is_empty() {
        return Evaluation { valid: false, reasons, overlaps, container: None, score: None };
    }
    let mut container = None;
    if !config.pieces.is_empty() && auto_orient && config.m != 0 {
        let set = extreme_points(config.n, &config.pieces, 1.0);
        let mut c = enclose_set(&set, config.m, config.phi);
        let best = auto_orient_set(&set, config.m, config.phi);
        if best.size < c.size {
            c = best;
        }
        container = Some(c);
    } else if !config.pieces.is_empty() {
        container = Some(enclose(config.n, &config.pieces, config.m, config.phi));
    }
    Evaluation { valid: reasons.is_empty(), reasons, overlaps, score: container.map(|c| c.size), container }
}

#[derive(Clone, Debug, PartialEq)]
pub struct StrictResult {
    pub ok: bool,
    /// Container size certified by the shrink test: size / (1 - eps).
    pub certified_size: f64,
    pub eps: f64,
    pub reason: Option<String>,
}

/// The shrink test for submissions that beat the literature: every piece shrunk by (1 - eps)
/// about its centre must be strictly separated and fit strictly inside a container of the same
/// shape and orientation smaller than the given one.
pub fn strict_verify(n: u32, pieces: &[Pose], container: &Container, eps: f64) -> StrictResult {
    let scale = 1.0 - eps;
    let certified_size = container.size / scale;
    // tol = -MIN_VALUE: a separation of exactly zero is a touching pair, not strictly separated
    let touching = find_overlaps(n, pieces, -f64::from_bits(1), scale, usize::MAX);
    if !touching.is_empty() {
        return StrictResult {
            ok: false,
            certified_size,
            eps,
            reason: Some(format!("{} pair(s) not strictly separated after shrinking", touching.len())),
        };
    }
    let shrunk = enclose_set(&extreme_points(n, pieces, scale), container.m, container.phi);
    if !(shrunk.size < container.size) {
        return StrictResult {
            ok: false,
            certified_size,
            eps,
            reason: Some("shrunk pieces do not fit strictly inside the container".to_string()),
        };
    }
    StrictResult { ok: true, certified_size, eps, reason: None }
}

/// What the client checks before it offers a packing to the server.
#[derive(Clone, Debug)]
pub struct ServerCheck {
    /// Accepted by the server's rule, with a further safety margin (see `server_check`).
    pub valid: bool,
    /// No penetration above the strict tolerance.
    pub strict: bool,
    /// The server's score at the configuration's container_phi.
    pub score: Option<f64>,
    pub container: Option<Container>,
    pub reasons: Vec<String>,
}

/// Rounding margin by which the client's verdict is stricter than the server's. Both evaluate the
/// same expressions in the same order, and IEEE additions, subtractions and products round alike
/// everywhere (the centre differences of near pairs are even exact), so they can differ only
/// through sin, cos, atan2 and hypot, which libraries may round differently in the last place.
/// A separation is a sum of terms of size up to 2R (R the bounding radius); an angle error of a
/// few units in the last place of |theta| moves a vertex by about R ulp(theta). A pair is accepted
/// only when it clears -TOL by this much more.
pub fn rounding_margin(n: u32, pieces: &[Pose]) -> f64 {
    let mut turn = 0.0f64;
    for p in pieces {
        turn = turn.max(p.theta.abs());
    }
    32.0 * f64::EPSILON * (1.0 + 2.0 * bounding_radius(n)) * (4.0 + turn)
}

/// The same packing with every angle reduced to one symmetry period of its shape (theta modulo
/// 2 pi / N, phi modulo 2 pi / M; disks and circles 0). A regular N-gon is invariant under a turn
/// by 2 pi / N, so only rounding changes; small angles keep the rounding margin small.
pub fn canonical(config: &Config) -> Config {
    let reduce = |x: f64, period: f64| {
        let t = x % period;
        if t < 0.0 {
            t + period
        } else {
            t
        }
    };
    let mut out = config.clone();
    for p in &mut out.pieces {
        p.theta = if config.n == 0 { 0.0 } else { reduce(p.theta, 2.0 * std::f64::consts::PI / config.n as f64) };
    }
    out.phi = if config.m == 0 { 0.0 } else { reduce(config.phi, 2.0 * std::f64::consts::PI / config.m as f64) };
    out
}

/// The server's rule as the client applies it to its own candidates: the parse checks, the piece
/// count, no pair below -(TOL - margin) (stricter than the server), and the score at phi.
pub fn server_check(config: &Config, p: usize) -> ServerCheck {
    let mut reasons = parse_errors(config.n, config.m, p, &config.pieces, config.phi);
    if config.pieces.len() != p {
        reasons.push(format!("expected exactly {p} pieces, got {}", config.pieces.len()));
    }
    if !reasons.is_empty() {
        return ServerCheck { valid: false, strict: false, score: None, container: None, reasons };
    }
    let margin = rounding_margin(config.n, &config.pieces);
    let strict_tol = strict_tolerance(&config.pieces);
    let reach = 2.0 * bounding_radius(config.n);
    let mut grid = NeighborGrid::new();
    grid.build(&config.pieces, reach);
    let mut worst = f64::INFINITY;
    grid.for_each_pair(&config.pieces, |i, j| {
        let sep = pair_separation(config.n, &config.pieces[i], &config.pieces[j], 1.0);
        if sep < worst {
            worst = sep;
        }
        true
    });
    let valid = !(worst < -(TOL - margin));
    let strict = !(worst < -strict_tol);
    if !valid {
        reasons.push(format!("deepest penetration {:.3e} is beyond the tolerance", -worst));
    }
    let container = enclose(config.n, &config.pieces, config.m, config.phi);
    ServerCheck { valid, strict, score: Some(container.size), container: Some(container), reasons }
}
