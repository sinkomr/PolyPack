//! The float validator of curved packings and, for the search client, the server's rule around it.
//!
//! Two layers, in this order in the file:
//!  - [`validation_steps`]: the line-by-line port of packages/curved/src/validate.ts
//!    (`validationSteps`), which the Rust server calls. It gives the TypeScript's verdict, reasons
//!    and numbers (native/PORTING.md; compared by native/tools/curved-compare.mjs);
//!  - [`check_config`] and [`validate_gaps`]: the search client's check of a result before it is
//!    kept or sent: validateSpaceSubmission of packages/spaces (work bounds, lower bound, strict
//!    tolerance) around the same validator, with a second verdict that errs strict.
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
//! The two verdicts of `validate_gaps` come from one pass:
//!  - `mirror`: the TypeScript computation (the numbers of `validation_steps`, bit for bit; the
//!    test `the_client_s_mirror_is_the_validator` holds them together);
//!  - `safe` (the default of the client): each gap less an estimate of its rounding error, so that the
//!    verdict errs strict: a configuration it accepts is accepted by the server too. The estimate
//!    is ERROR_ULPS units of 2^-52 times the squared magnitude of the lifted coordinates involved
//!    (the products in n . v and in the squared chord cancel down to the gap), plus the error of
//!    the apothem where it is ill-conditioned (K > 0 near the hemisphere).
//!
//! Configurations read from JSON must be parsed with correctly rounded floats (serde_json's
//! `float_roundtrip` feature): the default parser of serde_json can be one unit in the last place
//! off, which moves a touching configuration across the strict tolerance.

use crate::bound::CURVED_MAX_P;
use crate::evaluate::{
    all_states, centre_distance, pair_gap, piece_state, required_t, wall_covectors, PairWitness, PieceState,
};
use crate::geom::{js_hypot, js_min, line_value, LPoint};
use crate::kfun::{asn_k, dist_from_vs, tn_k};
use crate::problem::{container_t, is_finite_pose, CurvedConfig, CurvedProblem, Space};
use crate::shapes::{container_circumradius, max_container_size, side_from_apothem};
use polypack_js::{fmt as jsfmt, math};
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

// ---------------------------------------------------------------------------------------------
// packages/curved/src/validate.ts

/// packages/curved/src/validate.ts: ValidationOptions.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ValidationOptions {
    /// overlap tolerance: a gap >= -tol counts as touching (default 1e-9)
    pub tol: f64,
    /// Stop after this many overlapping pairs (server use); None is the source's `undefined` (no limit).
    pub max_errors: Option<usize>,
    /// gaps <= contact_tol are reported as contacts (default 1e-7)
    pub contact_tol: f64,
    /// Not in the source, which always lists the contacts: false leaves the list empty and changes
    /// nothing else. The server reads only the verdict, the reasons and the smallest gap, and a
    /// configuration far outside a many-sided container has a contact for every vertex and wall.
    pub contacts: bool,
}

impl Default for ValidationOptions {
    fn default() -> Self {
        ValidationOptions {
            tol: TOL,
            max_errors: None,
            contact_tol: 1e-7,
            contacts: true,
        }
    }
}

/// packages/curved/src/validate.ts: ValidationContact["kind"].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContactKind {
    Pair,
    Wall,
    Rim,
}

impl ContactKind {
    /// The kind as the TypeScript writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            ContactKind::Pair => "pair",
            ContactKind::Wall => "wall",
            ContactKind::Rim => "rim",
        }
    }
}

/// packages/curved/src/validate.ts: ValidationContact. An index that does not apply is -1, as in the source.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ValidationContact {
    pub kind: ContactKind,
    pub i: i32,
    pub j: i32,
    pub wall: i32,
    pub vertex: i32,
    pub gap: f64,
    /// of a pair contact only
    pub witness: Option<PairWitness>,
}

/// packages/curved/src/validate.ts: ValidationResult.
#[derive(Clone, Debug, PartialEq)]
pub struct ValidationResult {
    pub valid: bool,
    /// every gap strictly positive in float64 (not a proof)
    pub strictly_valid: bool,
    /// the configuration's container size (score); NaN when the check ended before the size was read
    pub score: f64,
    /// smallest container size at the fixed centre and orientation that contains every piece
    pub tight_size: f64,
    pub min_gap: f64,
    pub min_pair_gap: f64,
    pub min_container_gap: f64,
    pub contacts: Vec<ValidationContact>,
    pub errors: Vec<String>,
}

/// packages/curved/src/validate.ts: fail.
fn fail(errors: Vec<String>, size: f64) -> ValidationResult {
    ValidationResult {
        valid: false,
        strictly_valid: false,
        score: size,
        tight_size: f64::NAN,
        min_gap: f64::NAN,
        min_pair_gap: f64::NAN,
        min_container_gap: f64::NAN,
        contacts: vec![],
        errors,
    }
}

/// The points of a piece that the hemisphere and the container are tested on: the centre of a
/// disk, the vertices of a polygon (`N === 0 ? [s.centre] : s.verts` in the source).
fn points(n: u32, s: &PieceState) -> &[LPoint] {
    if n == 0 {
        std::slice::from_ref(&s.centre)
    } else {
        &s.verts
    }
}

/// The float64 validator of a curved packing (packages/curved/src/validate.ts: validationSteps, a
/// generator that yields for the event loop; here a plain function, PORTING.md rule 5). The
/// TypeScript's `(problem {N, M, P}, K, config, options)` is `(problem {k, n, m, p}, config, options)`.
///
/// What the types already settle, and the source tests: `config.pieces` is an array, every pose is
/// an object, the size is a number, P is an integer (so "config.pieces must be an array" cannot
/// occur, and "P must be a positive integer" only for P = 0), and N and M are integers ("bad N" and
/// "bad M" only for 1, 2 and above 100).
pub fn validation_steps(
    problem: &CurvedProblem,
    config: &CurvedConfig,
    options: &ValidationOptions,
) -> ValidationResult {
    let tol = options.tol;
    let contact_tol = options.contact_tol;
    let k = problem.k;
    let mut errors: Vec<String> = Vec::new();
    if !k.is_finite() {
        return fail(vec!["K must be finite".into()], f64::NAN);
    }
    let (n, m) = (problem.n, problem.m);
    let p = problem.p as usize;
    if p < 1 {
        return fail(vec!["P must be a positive integer".into()], f64::NAN);
    }
    if config.pieces.len() != p {
        return fail(
            vec![format!("expected {p} pieces, got {}", config.pieces.len())],
            f64::NAN,
        );
    }
    if !config.pieces.iter().all(is_finite_pose) {
        return fail(vec!["every pose needs finite x, y, theta".into()], f64::NAN);
    }
    if !(config.size.is_finite() && config.size > 0.0) {
        return fail(vec!["size must be a positive finite number".into()], f64::NAN);
    }
    let space = match Space::new(k, n, m) {
        Ok(space) => space,
        Err(message) => return fail(vec![message], config.size),
    };
    let s_max = max_container_size(m, k);
    if !(config.size < s_max) {
        return fail(
            vec![format!(
                "size must be below {} (open hemisphere) at K={}",
                jsfmt::num(s_max),
                jsfmt::num(k)
            )],
            config.size,
        );
    }
    let t = container_t(&space, config.size);
    if !t.is_finite() {
        return fail(vec!["container size not representable".into()], config.size);
    }
    if k > 0.0 {
        // keep exponential coordinates in the open hemisphere so that the pose is unambiguous
        let lim = PI / (2.0 * math::sqrt(k));
        for q in &config.pieces {
            if !(math::hypot(q.x, q.y) < lim) {
                return fail(vec!["piece centre outside the open hemisphere".into()], config.size);
            }
        }
    }
    let states = all_states(&space, &config.pieces);
    if k > 0.0 {
        for s in &states {
            for v in points(n, s) {
                if !(1.0 - k * v[0] > 0.0) {
                    errors.push("vertex outside the open hemisphere".into());
                }
            }
        }
    }
    let mut contacts: Vec<ValidationContact> = Vec::new();
    let mut min_pair = f64::INFINITY;
    let mut min_cont = f64::INFINITY;
    let reach = 2.0 * space.piece.r + 1e-6;
    let mut overlaps = 0usize;
    'pairs: for i in 0..p {
        for j in i + 1..p {
            if centre_distance(&space, &states[i], &states[j]) > reach {
                continue;
            }
            let g = pair_gap(&space, &states[i], &states[j]);
            min_pair = math::min(min_pair, g.gap);
            if g.gap < -tol {
                overlaps += 1;
                // (`++overlaps >= (options.maxErrors ?? Infinity)`)
                if options.max_errors.is_some_and(|max| overlaps >= max) {
                    break 'pairs;
                }
            }
            if g.gap <= contact_tol && options.contacts {
                contacts.push(ValidationContact {
                    kind: ContactKind::Pair,
                    i: i as i32,
                    j: j as i32,
                    wall: -1,
                    vertex: g.witness.vertex,
                    gap: g.gap,
                    witness: Some(g.witness),
                });
            }
        }
    }
    let walls = wall_covectors(&space, t);
    let mut t_req = f64::NEG_INFINITY;
    for i in 0..p {
        let s = &states[i];
        t_req = math::max(t_req, required_t(&space, s));
        let pts = points(n, s);
        let pad = if n == 0 { space.piece.r } else { 0.0 };
        for (kv, pt) in pts.iter().enumerate() {
            let vertex = if n == 0 { -1 } else { kv as i32 };
            if m == 0 {
                let g = t - dist_from_vs(k, pt[0]) - pad;
                min_cont = math::min(min_cont, g);
                if g <= contact_tol && options.contacts {
                    contacts.push(ValidationContact {
                        kind: ContactKind::Rim,
                        i: i as i32,
                        j: -1,
                        wall: -1,
                        vertex,
                        gap: g,
                        witness: None,
                    });
                }
            } else {
                for (w, wall) in walls.iter().enumerate() {
                    let g = -asn_k(k, line_value(k, wall, pt)) - pad;
                    min_cont = math::min(min_cont, g);
                    if g <= contact_tol && options.contacts {
                        contacts.push(ValidationContact {
                            kind: ContactKind::Wall,
                            i: i as i32,
                            j: -1,
                            wall: w as i32,
                            vertex,
                            gap: g,
                            witness: None,
                        });
                    }
                }
            }
        }
    }
    let min_gap = math::min(min_pair, min_cont);
    let tight_size = side_from_apothem(m, k, t_req);
    let valid = errors.is_empty() && min_gap >= -tol;
    if min_pair < -tol {
        errors.push(format!("pieces overlap by {}", jsfmt::num(-min_pair)));
    }
    if min_cont < -tol {
        errors.push(format!("a piece protrudes by {}", jsfmt::num(-min_cont)));
    }
    ValidationResult {
        valid,
        strictly_valid: valid && min_gap > 0.0,
        score: config.size,
        tight_size,
        min_gap,
        min_pair_gap: min_pair,
        min_container_gap: min_cont,
        contacts,
        errors,
    }
}

/// packages/curved/src/validate.ts: validate (the generator run to its end).
pub fn validate(problem: &CurvedProblem, config: &CurvedConfig, options: &ValidationOptions) -> ValidationResult {
    validation_steps(problem, config, options)
}

// ---------------------------------------------------------------------------------------------
// The search client's check

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

/// Largest |v0|, |x|, |y| of a piece's points (the scale of its rounding errors).
fn magnitude(k: f64, s: &PieceState) -> f64 {
    let point_mag = |p: &LPoint| (1.0 - k * p[0]).abs().max(p[1].abs()).max(p[2].abs());
    let mut mag = point_mag(&s.centre);
    for v in &s.verts {
        mag = mag.max(point_mag(v));
    }
    mag
}

#[inline]
fn error_of(mag: f64) -> f64 {
    ERROR_ULPS * f64::EPSILON * (1.0 + mag) * (1.0 + mag)
}

/// The float validator of packages/curved at tolerance `tol`, with the safe verdict alongside:
/// `validation_steps` (the same calls in the same order, so the same numbers and reasons) and, for
/// each gap, its rounding-error estimate. `max_errors` overlapping pairs end the pair loop (the
/// server passes 20).
pub fn validate_gaps(problem: &CurvedProblem, config: &CurvedConfig, tol: f64, max_errors: usize) -> GapReport {
    let k = problem.k;
    let (n, m, p) = (problem.n, problem.m, problem.p as usize);
    if !k.is_finite() {
        return fail_report("K must be finite".into());
    }
    if p < 1 {
        return fail_report("P must be a positive integer".into());
    }
    if config.pieces.len() != p {
        return fail_report(format!("expected {p} pieces, got {}", config.pieces.len()));
    }
    if !config.pieces.iter().all(is_finite_pose) {
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
        return fail_report(format!(
            "size must be below {} (open hemisphere) at K={}",
            jsfmt::num(s_max),
            jsfmt::num(k)
        ));
    }
    let t = container_t(&space, config.size);
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
    let pieces: Vec<PieceState> = config.pieces.iter().map(|q| piece_state(&space, q)).collect();
    let mags: Vec<f64> = pieces.iter().map(|s| magnitude(k, s)).collect();
    let mut errors = Vec::new();
    let mut safe_errors = false;
    if k > 0.0 {
        for (s, &mag) in pieces.iter().zip(&mags) {
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
                if !(v0 > error_of(mag)) {
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
    let mut overlaps = 0usize;
    'pairs: for i in 0..p {
        for j in i + 1..p {
            let (a, b) = (&pieces[i], &pieces[j]);
            if centre_distance(&space, a, b) > reach {
                continue;
            }
            let gap = pair_gap(&space, a, b).gap;
            min_pair = js_min(min_pair, gap);
            min_safe = js_min(min_safe, gap - error_of(mags[i] + mags[j]));
            if gap < -tol {
                overlaps += 1;
                if overlaps >= max_errors {
                    break 'pairs;
                }
            }
        }
    }
    let walls = wall_covectors(&space, t);
    let wall_mag = walls
        .iter()
        .fold(t.abs(), |acc, w| acc.max(w[0].abs()).max(w[1].abs()).max(w[2].abs()));
    // the apothem t = asn_K(tn_K(s/2) / tan(pi/M)) is ill-conditioned near the hemisphere (K > 0):
    // its rounding error grows with the derivative of asn_K there
    let t_cond = if m > 0 && k > 0.0 {
        let y = tn_k(k, config.size / 2.0) / math::tan(PI / m as f64);
        1.0 / (1.0 - k * y * y).max(1e-300).sqrt()
    } else {
        1.0
    };
    let t_err = ERROR_ULPS * f64::EPSILON * t_cond * (1.0 + t.abs());
    for (s, &mag) in pieces.iter().zip(&mags) {
        let pts: &[LPoint] = if n == 0 {
            std::slice::from_ref(&s.centre)
        } else {
            &s.verts
        };
        let pad = if n == 0 { r } else { 0.0 };
        let err = error_of(mag + wall_mag) + t_err;
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
        errors.push(format!("pieces overlap by {}", jsfmt::num(-min_pair)));
    }
    if min_cont < -tol {
        errors.push(format!("a piece protrudes by {}", jsfmt::num(-min_cont)));
    }
    GapReport {
        valid_mirror,
        valid_safe,
        min_gap,
        min_pair_gap: min_pair,
        min_container_gap: min_cont,
        min_safe_gap: min_safe,
        magnitude: mags.iter().fold(0.0, |a, &q| a.max(q)),
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
        errors.push(format!(
            "size must be at most {} in absolute value",
            jsfmt::num(MAX_SIZE)
        ));
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
                    "pieces[{i}].{name} must be at most {} in absolute value",
                    jsfmt::num(MAX_COORD)
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
                    "the size {} is below the lower bound {} of this problem",
                    jsfmt::num(score),
                    jsfmt::num(bound)
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
                format!("valid only within the float tolerance; this problem has no research record yet, and its entries must be valid at tolerance {}", jsfmt::num(STRICT_TOL))
            } else {
                format!("beats the research record only within the float tolerance; an improvement must be valid at tolerance {}", jsfmt::num(STRICT_TOL))
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
        errors.push(match mode {
            // the server's sentence (validate.ts check(): `not a valid packing (smallest gap ${v.minGap})`)
            Mode::Mirror => format!("not a valid packing (smallest gap {})", jsfmt::num(v.min_gap)),
            Mode::Safe => format!(
                "not a valid packing (smallest gap {}, {} less its rounding allowance)",
                jsfmt::num(v.min_gap),
                jsfmt::num(v.min_safe_gap)
            ),
        });
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
