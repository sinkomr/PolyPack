//! The server's check of a curved configuration: validateSpaceSubmission of packages/spaces (work
//! bounds, lower bound, strict tolerance) around the float validator of packages/curved/src/validate.ts.
//!
//! Gaps are signed geodesic distances: positive = clearance, 0 = touching, negative = overlap or
//! protrusion.
//!  - polygon pair: separating-axis value. The Beltrami-Klein (K < 0) and gnomonic (K > 0) charts
//!    map geodesics to straight lines, so the Euclidean separating-axis theorem holds there: for each
//!    edge line of one piece the smallest n . v over the other piece's vertices, the largest of these
//!    over both pieces' edges, then asn_K of it (n . v = sn_K(signed distance) for normalised n, v);
//!  - disk pair: centre distance - 1 (diameter 1);
//!  - wall: -(signed distance of a vertex from the wall line), minus 1/2 for a disk centre;
//!  - rim (disk container): r - distance(O, vertex), or r - 1/2 - distance(O, centre) for a disk.
//!
//! A configuration is valid when every gap is >= -tol (1e-9; 1e-11 for the strict check).
//!
//! Two verdicts come from one pass:
//!  - `mirror`: the TypeScript computation in the same floating-point operations, which reproduces
//!    the server's numbers up to the last bits of the transcendental functions;
//!  - `safe` (the default everywhere): each gap less an estimate of its rounding error, so that the
//!    verdict errs strict: a configuration it accepts is accepted by the server too. The estimate
//!    is ERROR_ULPS units of 2^-52 times the squared magnitude of the lifted coordinates involved
//!    (the products in n . v and in the squared chord cancel down to the gap), plus the error of
//!    the apothem where it is ill-conditioned (K > 0 near the hemisphere).
//!
//! Configurations read from JSON must be parsed with correctly rounded floats (serde_json's
//! `float_roundtrip` feature): the default parser of serde_json can be one unit in the last place
//! off, which moves a touching configuration across the strict tolerance.

use crate::bound::CURVED_MAX_P;
use crate::geom::{
    apply_point, covector_norm2, js_hypot, js_min, line_covector, line_through, line_value, pair_vs, pose_motion,
    LPoint,
};
use crate::kfun::{asn_k, dist_from_vs, tn_k, vs_k};
use crate::problem::{CurvedConfig, CurvedProblem, Space};
use crate::shapes::{apothem_from_side, container_circumradius, max_container_size};
use std::f64::consts::PI;

/// PolyPack's touching tolerance: a gap of at least -TOL is contact, not overlap.
pub const TOL: f64 = 1e-9;
/// The strict tolerance of an entry that beats the research record, or of any entry of a problem
/// without one.
pub const STRICT_TOL: f64 = 1e-11;
/// Largest |x|, |y|, |theta| accepted.
pub const MAX_COORD: f64 = 1e4;
/// Largest size accepted.
pub const MAX_SIZE: f64 = 1e6;
/// Relative slack below the lower bound that a size may have.
pub const BOUND_SLACK: f64 = 1e-9;
/// Relative tie tolerance of scores (and the curved space's record margin).
pub const SCORE_TIE: f64 = 1e-9;
/// Overlapping pairs after which the server's check stops counting.
const MAX_REASONS: usize = 20;
/// Rounding-error estimate of a gap, in units of 2^-52 times the squared magnitude of the lifted
/// coordinates of the points and lines involved (measured differences between this code and the
/// server's stay far below it; see tools/xcheck.mjs).
pub const ERROR_ULPS: f64 = 16.0;

/// What the server knows of a problem when it checks an entry.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rule {
    /// The problem's lower bound: sizes below it (less 1e-9 relative) are rejected.
    pub bound: Option<f64>,
    /// The research record's certified size: an entry below it by more than 1e-9 relative must
    /// also be valid at the strict tolerance.
    pub certified: Option<f64>,
    /// True when the problem has no research record: every entry needs the strict check.
    pub no_record: bool,
}

/// The verdict of the server's rule.
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub valid: bool,
    /// The stated size (None when the configuration is malformed).
    pub score: Option<f64>,
    pub reasons: Vec<String>,
    /// The input is not a configuration of the problem at all (the server answers 400).
    pub malformed: bool,
}

/// The float validator's numbers for one tolerance.
#[derive(Clone, Debug)]
pub struct GapReport {
    /// The TypeScript verdict, computed as the server computes it.
    pub valid_mirror: bool,
    /// The verdict with each gap less its rounding-error estimate (errs strict).
    pub valid_safe: bool,
    pub min_gap: f64,
    pub min_pair_gap: f64,
    pub min_container_gap: f64,
    /// Smallest gap less its error estimate.
    pub min_safe_gap: f64,
    /// Largest |v0|, |x|, |y| of the pieces' lifted points (the scale of the rounding errors).
    pub magnitude: f64,
    pub errors: Vec<String>,
}

fn fail_report(error: String) -> GapReport {
    GapReport {
        valid_mirror: false,
        valid_safe: false,
        min_gap: f64::NAN,
        min_pair_gap: f64::NAN,
        min_container_gap: f64::NAN,
        min_safe_gap: f64::NAN,
        magnitude: f64::NAN,
        errors: vec![error],
    }
}

/// A piece as the TypeScript validator builds it: G, centre, vertices and normalised edge lines.
struct MirrorPiece {
    centre: LPoint,
    verts: Vec<LPoint>,
    edges: Vec<[f64; 3]>,
    /// largest |v0|, |x|, |y| of the piece's points (for the error estimate)
    mag: f64,
}

fn mirror_piece(space: &Space, x: f64, y: f64, theta: f64) -> MirrorPiece {
    let k = space.k;
    let g = pose_motion(k, x, y, theta);
    let centre: LPoint = [g.b[0], g.b[1], g.b[2]];
    let verts: Vec<LPoint> = space.vertices.iter().map(|v| apply_point(&g, v)).collect();
    let nn = verts.len();
    let mut edges = Vec::with_capacity(nn);
    for e in 0..nn {
        let a = &verts[e];
        let b = &verts[(e + 1) % nn];
        // b x a: outward for a counter-clockwise edge a -> b
        let n = line_through(k, b, a);
        let q = covector_norm2(k, &n).sqrt();
        edges.push([n[0] / q, n[1] / q, n[2] / q]);
    }
    let point_mag = |p: &LPoint| (1.0 - k * p[0]).abs().max(p[1].abs()).max(p[2].abs());
    let mut mag = point_mag(&centre);
    for v in &verts {
        mag = mag.max(point_mag(v));
    }
    MirrorPiece {
        centre,
        verts,
        edges,
        mag,
    }
}

/// Separating-axis value (in n . v, before asn_K) of two polygon pieces, as pairGap computes it.
fn mirror_pair_y(k: f64, a: &MirrorPiece, b: &MirrorPiece) -> f64 {
    let mut best = f64::NEG_INFINITY;
    for pass in 0..2 {
        let (p, q) = if pass == 0 { (a, b) } else { (b, a) };
        for n in &p.edges {
            let mut m = f64::INFINITY;
            for v in &q.verts {
                let val = line_value(k, n, v);
                if val < m {
                    m = val;
                }
            }
            if m > best {
                best = m;
            }
        }
    }
    best
}

#[inline]
fn error_of(mag: f64) -> f64 {
    ERROR_ULPS * f64::EPSILON * (1.0 + mag) * (1.0 + mag)
}

/// The float validator of packages/curved at tolerance `tol` (validationSteps), with the safe
/// verdict alongside. `max_errors` overlapping pairs end the pair loop (the server passes 20).
pub fn validate_gaps(problem: &CurvedProblem, config: &CurvedConfig, tol: f64, max_errors: usize) -> GapReport {
    let k = problem.k;
    let (n, m, p) = (problem.n, problem.m, problem.p as usize);
    if !k.is_finite() {
        return fail_report("K must be finite".into());
    }
    if config.pieces.len() != p {
        return fail_report(format!("expected {p} pieces, got {}", config.pieces.len()));
    }
    if !config
        .pieces
        .iter()
        .all(|q| q.x.is_finite() && q.y.is_finite() && q.theta.is_finite())
    {
        return fail_report("every pose needs finite x, y, theta".into());
    }
    if !(config.size.is_finite() && config.size > 0.0) {
        return fail_report("size must be a positive finite number".into());
    }
    let space = match Space::new(k, n, m) {
        Ok(s) => s,
        Err(e) => return fail_report(e),
    };
    let s_max = max_container_size(m, k);
    if !(config.size < s_max) {
        return fail_report(format!("size must be below {s_max} (open hemisphere) at K={k}"));
    }
    let t = apothem_from_side(m, k, config.size);
    if !t.is_finite() {
        return fail_report("container size not representable".into());
    }
    if k > 0.0 {
        // exponential coordinates stay in the open hemisphere so that the pose is unambiguous
        let lim = PI / (2.0 * k.sqrt());
        for q in &config.pieces {
            if !(js_hypot(q.x, q.y) < lim) {
                return fail_report("piece centre outside the open hemisphere".into());
            }
        }
    }
    let pieces: Vec<MirrorPiece> = config
        .pieces
        .iter()
        .map(|q| mirror_piece(&space, q.x, q.y, q.theta))
        .collect();
    let mut errors = Vec::new();
    let mut safe_errors = false;
    if k > 0.0 {
        for s in &pieces {
            let pts: &[LPoint] = if n == 0 {
                std::slice::from_ref(&s.centre)
            } else {
                &s.verts
            };
            for v in pts {
                let v0 = 1.0 - k * v[0];
                if !(v0 > 0.0) {
                    errors.push("vertex outside the open hemisphere".to_string());
                }
                if !(v0 > error_of(s.mag)) {
                    safe_errors = true;
                }
            }
        }
    }
    let r = space.piece.r;
    let mut min_pair = f64::INFINITY;
    let mut min_cont = f64::INFINITY;
    let mut min_safe = f64::INFINITY;
    let reach = 2.0 * r + 1e-6;
    // pairs whose half squared chord is far above vs_K(reach) are farther apart than reach (as
    // vs_K grows with the distance); the others are decided by the distance itself, as in the reference
    let vs_far = if k > 0.0 && k.sqrt() * reach > 0.99 * PI {
        f64::INFINITY
    } else {
        vs_k(k, reach) * (1.0 + 1e-9) + 1e-300
    };
    let mut overlaps = 0usize;
    'pairs: for i in 0..p {
        for j in i + 1..p {
            let (a, b) = (&pieces[i], &pieces[j]);
            let vs = pair_vs(k, &a.centre, &b.centre);
            if vs > vs_far {
                continue;
            }
            if dist_from_vs(k, vs) > reach {
                continue;
            }
            let gap = if n == 0 {
                dist_from_vs(k, vs) - 2.0 * r
            } else {
                asn_k(k, mirror_pair_y(k, a, b))
            };
            min_pair = js_min(min_pair, gap);
            min_safe = js_min(min_safe, gap - error_of(a.mag + b.mag));
            if gap < -tol {
                overlaps += 1;
                if overlaps >= max_errors {
                    break 'pairs;
                }
            }
        }
    }
    let walls: Vec<[f64; 3]> = space.wall_angles.iter().map(|&a| line_covector(k, t, a)).collect();
    let wall_mag = walls
        .iter()
        .fold(t.abs(), |acc, w| acc.max(w[0].abs()).max(w[1].abs()).max(w[2].abs()));
    // the apothem t = asn_K(tn_K(s/2) / tan(pi/M)) is ill-conditioned near the hemisphere (K > 0):
    // its rounding error grows with the derivative of asn_K there
    let t_cond = if m > 0 && k > 0.0 {
        let y = tn_k(k, config.size / 2.0) / libm::tan(PI / m as f64);
        1.0 / (1.0 - k * y * y).max(1e-300).sqrt()
    } else {
        1.0
    };
    let t_err = ERROR_ULPS * f64::EPSILON * t_cond * (1.0 + t.abs());
    for s in &pieces {
        let pts: &[LPoint] = if n == 0 {
            std::slice::from_ref(&s.centre)
        } else {
            &s.verts
        };
        let pad = if n == 0 { r } else { 0.0 };
        let err = error_of(s.mag + wall_mag) + t_err;
        for pt in pts {
            if m == 0 {
                let g = t - dist_from_vs(k, pt[0]) - pad;
                min_cont = js_min(min_cont, g);
                min_safe = js_min(min_safe, g - err);
            } else {
                for w in &walls {
                    let g = -asn_k(k, line_value(k, w, pt)) - pad;
                    min_cont = js_min(min_cont, g);
                    min_safe = js_min(min_safe, g - err);
                }
            }
        }
    }
    let min_gap = js_min(min_pair, min_cont);
    let valid_mirror = errors.is_empty() && min_gap >= -tol;
    let valid_safe = valid_mirror && !safe_errors && min_safe >= -tol;
    if min_pair < -tol {
        errors.push(format!("pieces overlap by {}", -min_pair));
    }
    if min_cont < -tol {
        errors.push(format!("a piece protrudes by {}", -min_cont));
    }
    GapReport {
        valid_mirror,
        valid_safe,
        min_gap,
        min_pair_gap: min_pair,
        min_container_gap: min_cont,
        min_safe_gap: min_safe,
        magnitude: pieces.iter().fold(0.0, |a, q| a.max(q.mag)),
        errors,
    }
}

/// Which verdict a check returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Each gap less its rounding-error estimate: never accepts what the server would reject.
    Safe,
    /// The server's numbers as this code reproduces them (for comparisons).
    Mirror,
}

/// The server's rule for an entry (validateSpaceSubmission): P at most 500, a well-formed
/// configuration within the work bounds, at or above the lower bound, valid by the float validator
/// at 1e-9 at its stated size, and at 1e-11 too when the rule asks for the strict check. Errs strict.
pub fn check_config(problem: &CurvedProblem, config: &CurvedConfig, rule: &Rule) -> Verdict {
    check_config_mode(problem, config, rule, Mode::Safe)
}

pub fn check_config_mode(problem: &CurvedProblem, config: &CurvedConfig, rule: &Rule, mode: Mode) -> Verdict {
    let fail = |reasons: Vec<String>, malformed: bool, score: Option<f64>| Verdict {
        valid: false,
        score,
        reasons,
        malformed,
    };
    if problem.p > CURVED_MAX_P {
        return fail(
            vec![format!(
                "P = {} is above the largest P of the curved catalogue ({CURVED_MAX_P})",
                problem.p
            )],
            true,
            None,
        );
    }
    // the reader of the server: finite numbers within the work bounds
    let mut errors = Vec::new();
    let size = config.size;
    if !size.is_finite() {
        errors.push("size must be a finite number".to_string());
    } else if size.abs() > MAX_SIZE {
        errors.push(format!("size must be at most {MAX_SIZE} in absolute value"));
    } else if !(size > 0.0) {
        errors.push("size must be positive".to_string());
    }
    if config.pieces.len() != problem.p as usize {
        if !errors.is_empty() {
            errors.push(format!(
                "expected {} pieces for this problem, got {}",
                problem.p,
                config.pieces.len()
            ));
            return fail(errors, true, None);
        }
        return fail(
            vec![format!(
                "expected {} pieces for this problem, got {}",
                problem.p,
                config.pieces.len()
            )],
            false,
            None,
        );
    }
    for (i, q) in config.pieces.iter().enumerate() {
        if errors.len() >= MAX_REASONS {
            break;
        }
        for (name, v) in [("x", q.x), ("y", q.y), ("theta", q.theta)] {
            if !v.is_finite() {
                errors.push(format!("pieces[{i}].{name} must be a finite number"));
            } else if v.abs() > MAX_COORD {
                errors.push(format!(
                    "pieces[{i}].{name} must be at most {MAX_COORD} in absolute value"
                ));
            }
        }
    }
    if !errors.is_empty() {
        errors.truncate(MAX_REASONS);
        return fail(errors, true, None);
    }
    let score = size;
    if let Some(bound) = rule.bound {
        if bound.is_finite() && score < bound * (1.0 - BOUND_SLACK) {
            return fail(
                vec![format!(
                    "the size {score} is below the lower bound {bound} of this problem"
                )],
                false,
                Some(score),
            );
        }
    }
    let reasons = curved_check(problem, config, TOL, mode);
    if !reasons.is_empty() {
        return fail(reasons, false, Some(score));
    }
    let needs_strict = rule.no_record || rule.certified.is_some_and(|c| score < c * (1.0 - SCORE_TIE));
    if needs_strict {
        let strict = curved_check(problem, config, STRICT_TOL, mode);
        if !strict.is_empty() {
            let head = if rule.no_record {
                format!("valid only within the float tolerance; this problem has no research record yet, and its entries must be valid at tolerance {STRICT_TOL}")
            } else {
                format!("beats the research record only within the float tolerance; an improvement must be valid at tolerance {STRICT_TOL}")
            };
            let mut r = vec![head];
            r.extend(strict.into_iter().take(3));
            return fail(r, false, Some(score));
        }
    }
    Verdict {
        valid: true,
        score: Some(score),
        reasons: vec![],
        malformed: false,
    }
}

/// The space's own check at `tol` (validate.ts check() for curved): the centres within the
/// container's circumradius, then the float validator.
fn curved_check(problem: &CurvedProblem, config: &CurvedConfig, tol: f64, mode: Mode) -> Vec<String> {
    // A piece's centre lies in its piece, so in the container: a cheap first test that also keeps
    // far-away centres (whose coordinates overflow at K < 0) from reaching the validator. Its slack
    // of 1e-6 is far above the tolerance, so it refuses nothing the validator would accept.
    let reach = container_circumradius(problem.m, problem.k, config.size);
    if reach.is_finite() {
        if let Some(far) = config
            .pieces
            .iter()
            .position(|q| !(js_hypot(q.x, q.y) <= reach * (1.0 + 1e-6) + 1e-6))
        {
            return vec![format!("the centre of piece {far} lies outside the container")];
        }
    }
    let v = validate_gaps(problem, config, tol, MAX_REASONS);
    let ok = match mode {
        Mode::Safe => v.valid_safe,
        Mode::Mirror => v.valid_mirror,
    };
    if ok {
        return vec![];
    }
    let mut errors = v.errors;
    if errors.is_empty() {
        errors.push(format!(
            "not a valid packing (smallest gap {}, {} less its rounding allowance)",
            v.min_gap, v.min_safe_gap
        ));
    }
    errors.truncate(MAX_REASONS);
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::problem::Pose;

    fn record() -> (CurvedProblem, CurvedConfig) {
        let p = CurvedProblem::parse("curved/-1/3/6/8").unwrap();
        let c: CurvedConfig = serde_json::from_str(r#"{"size":1.724148891504105,"pieces":[{"x":-0.7764145291718095,"y":0.20772581604160836,"theta":4.047426214757005},{"x":-0.12530104877408077,"y":-0.7641082721281892,"theta":4.2739477331451985},{"x":0.021891400877602482,"y":0.08532157903034833,"theta":5.388675298255929},{"x":0.5271992300058851,"y":0.6970724278560901,"theta":1.8580819400292397},{"x":-0.6379610101608442,"y":-0.4106429096829371,"theta":3.116667750028599},{"x":-0.35373428202129004,"y":0.7902172734176479,"theta":2.8532304916627695},{"x":0.5395044165320629,"y":-0.6599031140743641,"theta":5.440226162341727},{"x":0.5156797295581319,"y":-0.09825721152765993,"theta":0.17524711387801004}]}"#).unwrap();
        (p, c)
    }

    #[test]
    fn a_research_record_passes_the_strict_check() {
        let (p, c) = record();
        let rule = Rule {
            bound: Some(1.2996367039683485),
            certified: Some(1.724148891504105),
            no_record: true,
        };
        let v = check_config(&p, &c, &rule);
        assert!(v.valid, "{:?}", v.reasons);
        let g = validate_gaps(&p, &c, TOL, 20);
        assert!(g.min_gap > 0.0 && g.min_gap < 1e-9);
    }

    #[test]
    fn shrinking_a_record_is_rejected() {
        let (p, mut c) = record();
        c.size *= 1.0 - 1e-6;
        assert!(!check_config(&p, &c, &Rule::default()).valid);
    }

    #[test]
    fn malformed_input() {
        let (p, mut c) = record();
        c.pieces[0].x = f64::NAN;
        let v = check_config(&p, &c, &Rule::default());
        assert!(!v.valid && v.malformed);
        let (_, mut c) = record();
        c.pieces.push(Pose {
            x: 0.0,
            y: 0.0,
            theta: 0.0,
        });
        let v = check_config(&p, &c, &Rule::default());
        assert!(!v.valid && !v.malformed);
        let (_, mut c) = record();
        c.size = 2e6;
        assert!(check_config(&p, &c, &Rule::default()).malformed);
    }

    #[test]
    fn bound_is_enforced() {
        let (p, c) = record();
        let v = check_config(
            &p,
            &c,
            &Rule {
                bound: Some(1.8),
                ..Rule::default()
            },
        );
        assert!(!v.valid);
    }
}
