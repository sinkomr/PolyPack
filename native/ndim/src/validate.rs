//! The floating-point validator of the nD spaces, as a server runs it on untrusted input
//! (packages/ndim/src/validate.ts).
//!
//! A configuration { s, pieces } of a problem (piece X, container C, both polytopes of the
//! catalogue or balls) is valid at tolerance tol when
//!  - containment: every piece lies in the container s C (centred at the origin) up to tol: every
//!    vertex x of a polytope piece satisfies N_f . x <= s b_f + tol for every facet f of a polytope
//!    container (unit normals), or |x| <= s/2 + tol in a ball container; a ball piece (centre c,
//!    radius 1/2) satisfies N_f . c + 1/2 <= s b_f + tol, or |c| + 1/2 <= s/2 + tol;
//!  - disjointness: no two pieces overlap by more than tol, i.e. the signed separation of their
//!    hulls (gjk.rs) is at least -tol; two balls are checked by their centres' distance.
//!
//! Pieces may touch. Lengths are in the catalogue's units: the edge of a polytope piece is 1, a
//! ball piece has diameter 1.
//!
//! A pair is accepted only with a certificate: a unit direction u whose gap min_B u.y - max_A u.x
//! is at least -tol (the gap of any unit vector is a lower bound of the separation). The
//! certificate comes from the cheap candidate directions (the line between the centres, and the
//! facet normals of each piece that face the other most), else from GJK / EPA, else from the
//! max-margin LP (margin.rs). A pair is refused when the separation is proved below -tol, and also
//! when neither is proved: the validator fails closed.
//!
//! Work: the size of the configuration is capped before anything is done (limits.rs); pairs are
//! found by a sweep over the centres and skipped when their centres are farther apart than the sum
//! of the circumradii (plus tol); vertices are placed only for pieces that need them; a piece far
//! from a wall skips the facet test. The check ends after maxErrors errors, and after maxPairErrors
//! (3) refused pairs, since a refused pair costs an EPA or LP run.
use crate::ball::{ball_facet_gap, ball_in_ball_gap, ball_pair_gap};
use crate::gjk::{gap_along, signed_separation};
use crate::limits::{size_errors, LimitsOverride};
use crate::linalg::dot;
use crate::polytope::Polytope;
use crate::pose::{place_vertices, read_pose, Pose, MAX_SIZE};
use crate::problem::{problem_errors, shape_polytope, NdConfig, NdProblem, BALL, BALL_RADIUS};
use crate::Thrown;
use polypack_js::{fmt, math};
use std::sync::OnceLock;
use std::time::Instant;

/// PolyPack's touching tolerance (the polyhedra space's too).
pub const NDIM_TOL: f64 = 1e-9;

/// packages/ndim/src/validate.ts: ValidateOptions.
#[derive(Debug, Clone, Copy, Default)]
pub struct ValidateOptions {
    /// Default NDIM_TOL.
    pub tol: Option<f64>,
    /// Errors listed at most; the check ends after this many. Default 20.
    pub max_errors: Option<usize>,
    /// Refused pairs listed at most (each costs an EPA or LP run); the check ends after this many.
    /// Default 3.
    pub max_pair_errors: Option<usize>,
    /// Limits on the size of the configuration, replacing the defaults of limits.rs (never above
    /// the hard ceilings). Trusted callers only.
    pub limits: Option<LimitsOverride>,
    /// A time in the clock of `performance_now` after which the check stops, invalid, with a
    /// reason (checked between pieces and pairs). Default: none.
    pub deadline: Option<f64>,
}

/// packages/ndim/src/validate.ts: NdValidation.
#[derive(Debug, Clone, PartialEq)]
pub struct NdValidation {
    pub valid: bool,
    /// The container scale s when valid, else None.
    pub score: Option<f64>,
    pub reasons: Vec<String>,
    /// Smallest wall gap over all pieces (negative: protrusion); Infinity for an empty check. A
    /// piece far from a wall contributes a lower bound of its gap (the wall prefilter), so this is
    /// exact for the pieces that matter (any protrusion, any gap below the pieces' reach) and never
    /// above the true smallest gap.
    pub min_wall_gap: f64,
    /// Smallest pair separation found (a lower bound of the true separation; negative: overlap
    /// depth); Infinity when no pair is near.
    pub min_pair_sep: f64,
    pub worst_pair: Option<(usize, usize)>,
    /// Pairs given more than the quick centre-line test.
    pub pairs_tested: u64,
}

/// `performance.now()`: milliseconds on a monotonic clock that starts with the process (here, at
/// the first reading).
pub fn performance_now() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// packages/ndim/src/validate.ts: configErrors. The errors of a configuration for a problem whose
/// polytopes are loaded (empty when it is well formed and within the size limits of limits.rs,
/// which are checked first). The source reads an unknown value; here the configuration is typed
/// (the server passes what its parser returned), so "config must be an object {s, pieces}" cannot
/// occur, and `pieces` is always an array.
pub fn config_errors(
    problem: &NdProblem,
    config: &NdConfig,
    max_errors: usize,
    limits: Option<&LimitsOverride>,
) -> Result<Vec<String>, Thrown> {
    let bad = problem_errors(problem);
    if !bad.is_empty() {
        return Ok(bad);
    }
    let mut errors: Vec<String> = Vec::new();
    if !config.s.is_finite() || !(config.s > 0.0) || config.s > MAX_SIZE {
        errors.push(format!("s must be a positive finite number of at most {}", fmt::num(MAX_SIZE)));
    }
    if config.pieces.is_empty() {
        errors.push("pieces must be a nonempty array of poses".into());
        return Ok(errors);
    }
    let big = size_errors(problem, config.pieces.len(), limits)?;
    if !big.is_empty() {
        errors.extend(big);
        return Ok(errors);
    }
    let ball = problem.piece == BALL;
    let mut i = 0;
    while i < config.pieces.len() && errors.len() < max_errors {
        if let Pose::Bad(r) = read_pose(problem.d as usize, &config.pieces[i], ball)? {
            errors.push(format!("pieces[{i}] {r}"));
        }
        i += 1;
    }
    Ok(errors)
}

struct Placed {
    t: Vec<f64>,
    r: Option<Vec<f64>>,
    /// World vertices (polytope pieces), placed on first use.
    x: Option<Vec<f64>>,
}

fn norm(v: &[f64], d: usize) -> f64 {
    dot(v, v, d, 0, 0).sqrt()
}

/// packages/ndim/src/validate.ts: vertices. The world vertices of a placed piece, placing them on
/// first use.
fn vertices<'a>(p: &Polytope, pc: &'a mut Placed, d: usize) -> &'a [f64] {
    if pc.x.is_none() {
        let r = pc.r.as_ref().expect("a polytope piece has a rotation");
        pc.x = Some(place_vertices(&p.v, p.n_v, d, &pc.t, r));
    }
    pc.x.as_deref().expect("just placed")
}

/// packages/ndim/src/validate.ts: validateNd. Checks a configuration of a problem at its stated s.
/// Malformed input gives reasons that say what is wrong.
pub fn validate_nd(problem: &NdProblem, config: &NdConfig, opts: &ValidateOptions) -> Result<NdValidation, Thrown> {
    Ok(nd_check(problem, config, opts, &mut || Step::Continue)?.expect("the check was not stopped"))
}

/// Pairs without a heavy test between two turns of the check's steps.
const QUICK_PAIRS_PER_STEP: u64 = 64;

/// What the caller of the check's steps answers at a `yield` of the source's generator: go on, or
/// abandon the check (the source's caller stops calling `next()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Continue,
    Stop,
}

/// packages/ndim/src/validate.ts: ndCheck. The check as steps: `on_yield` is called wherever the
/// source's generator yields (between pieces and pairs), and the result is None when it answered
/// Stop there. (A generator that yields for the event loop is a plain function here,
/// native/PORTING.md rule 5; the yield points stay because the server's cap on the work is
/// measured at them.)
pub fn nd_check(
    problem: &NdProblem,
    config: &NdConfig,
    opts: &ValidateOptions,
    on_yield: &mut dyn FnMut() -> Step,
) -> Result<Option<NdValidation>, Thrown> {
    let tol = opts.tol.unwrap_or(NDIM_TOL);
    let max_errors = opts.max_errors.unwrap_or(20);
    let max_pair_errors = opts.max_pair_errors.unwrap_or(3);
    let deadline = opts.deadline.unwrap_or(f64::INFINITY);
    let mut out = NdValidation {
        valid: false,
        score: None,
        reasons: Vec::new(),
        min_wall_gap: f64::INFINITY,
        min_pair_sep: f64::INFINITY,
        worst_pair: None,
        pairs_tested: 0,
    };
    let bad = config_errors(problem, config, max_errors, opts.limits.as_ref())?;
    if !bad.is_empty() {
        out.reasons = bad;
        return Ok(Some(out));
    }
    let d = problem.d as usize;
    let s = config.s;
    let p_poly = shape_polytope(&problem.piece)?;
    let c_poly = shape_polytope(&problem.container)?;
    let p_poly = p_poly.as_deref();
    let c_poly = c_poly.as_deref();
    let n = config.pieces.len();
    let mut placed: Vec<Placed> = Vec::with_capacity(n);
    for i in 0..n {
        match read_pose(d, &config.pieces[i], p_poly.is_none())? {
            Pose::Read(r) => placed.push(Placed { t: r.t, r: r.r, x: None }),
            // config_errors has read every pose unless max_errors is 0 (it stops listing at max_errors errors, and
            // there were none). With max_errors 0 a malformed pose gets here; the source then keeps an entry without
            // a centre, skips the containment loop (no error may be listed) and fails in the sweep with V8's
            // TypeError, which is what is returned. The server's max_errors is NDIM_MAX_REASONS.
            Pose::Bad(_) => return Err(Thrown("Cannot read properties of undefined (reading '0')".into())),
        }
    }
    // the closure `timedOut`
    let timed_out = |out: &mut NdValidation| -> bool {
        if performance_now() <= deadline {
            return false;
        }
        out.reasons.push("the time budget of the check ran out before it finished".into());
        true
    };
    // ---- containment
    let mut i = 0;
    while i < n && out.reasons.len() < max_errors {
        let g = wall_gap(p_poly, c_poly, s, &mut placed[i], d, false);
        if g < out.min_wall_gap {
            out.min_wall_gap = g;
        }
        if !(g >= -tol) {
            out.reasons.push(format!("piece {i} sticks out of the container by {}", fmt::num(-g)));
        }
        if on_yield() == Step::Stop {
            return Ok(None);
        }
        if timed_out(&mut out) {
            return Ok(Some(out));
        }
        i += 1;
    }
    // ---- disjointness: a sweep along the coordinate of the largest spread finds the pairs within reach
    let r_p = p_poly.map_or(BALL_RADIUS, |p| p.circumradius);
    let reach = 2.0 * r_p + tol;
    let reach2 = reach * reach;
    let mut axis = 0;
    let mut spread = -1.0f64;
    for c in 0..d {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for pc in &placed {
            lo = math::min(lo, pc.t[c]);
            hi = math::max(hi, pc.t[c]);
        }
        if hi - lo > spread {
            spread = hi - lo;
            axis = c;
        }
    }
    // `.sort((x, y) => placed[x].t[axis] - placed[y].t[axis] || x - y)`: by the coordinate, then by the index (the
    // coordinates are finite, so the difference is 0 only for equal ones)
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&x, &y| {
        let diff = placed[x].t[axis] - placed[y].t[axis];
        if diff < 0.0 {
            std::cmp::Ordering::Less
        } else if diff > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            x.cmp(&y)
        }
    });
    let mut u = vec![0.0f64; d];
    let mut pair_errors = 0usize;
    let mut quick = 0u64;
    for ia in 0..n {
        let i0 = order[ia];
        for ib in ia + 1..n {
            let j0 = order[ib];
            if placed[j0].t[axis] - placed[i0].t[axis] > reach {
                break;
            }
            if out.reasons.len() >= max_errors || pair_errors >= max_pair_errors {
                out.valid = false;
                return Ok(Some(out));
            }
            let i = i0.min(j0);
            let j = i0.max(j0);
            let mut d2 = 0.0f64;
            for c in 0..d {
                let e = placed[i].t[c] - placed[j].t[c];
                d2 += e * e;
            }
            if d2 > reach2 {
                continue;
            }
            let mut sep: f64;
            let mut refused = false;
            let mut heavy = false;
            match p_poly {
                None => {
                    sep = ball_pair_gap(&placed[i].t, BALL_RADIUS, &placed[j].t, BALL_RADIUS, d); // two balls
                    out.pairs_tested += 1;
                    refused = !(sep >= -tol);
                    if refused {
                        out.reasons.push(format!("pieces {i} and {j} overlap by {}", fmt::num(-sep)));
                    }
                }
                Some(p) => {
                    vertices(p, &mut placed[i], d);
                    vertices(p, &mut placed[j], d);
                    let (pi, pj) = (&placed[i], &placed[j]);
                    let a = pi.x.as_deref().expect("placed");
                    let b = pj.x.as_deref().expect("placed");
                    sep = quick_gap(p, pi, pj, d, d2.sqrt(), &mut u, a, b);
                    if !(sep >= -tol) {
                        out.pairs_tested += 1;
                        heavy = true;
                        let r = signed_separation(a, p.n_v, b, p.n_v, d, Some(tol));
                        sep = if r.converged {
                            r.sep
                        } else if r.lower.is_finite() {
                            r.lower
                        } else {
                            r.upper
                        };
                        if !(r.lower >= -tol) {
                            refused = true;
                            if r.upper < -tol {
                                let by = if r.converged {
                                    fmt::num(-r.sep)
                                } else {
                                    format!("at least {}", fmt::num(-r.upper))
                                };
                                out.reasons.push(format!("pieces {i} and {j} overlap by {by}"));
                            } else {
                                out.reasons.push(format!(
                                    "pieces {i} and {j} could not be shown to be separated within the tolerance (their separation lies in [{}, {}])",
                                    fmt::num(r.lower),
                                    fmt::num(r.upper)
                                ));
                            }
                        }
                    }
                }
            }
            if sep < out.min_pair_sep {
                out.min_pair_sep = sep;
                out.worst_pair = Some((i, j));
            }
            if refused {
                pair_errors += 1;
            }
            // `refused || heavy || ++quick % QUICK_PAIRS_PER_STEP === 0`: quick counts the pairs that were neither
            let step = refused || heavy || {
                quick += 1;
                quick % QUICK_PAIRS_PER_STEP == 0
            };
            if step {
                if on_yield() == Step::Stop {
                    return Ok(None);
                }
                if timed_out(&mut out) {
                    return Ok(Some(out));
                }
            }
        }
    }
    out.valid = out.reasons.is_empty();
    out.score = if out.valid { Some(s) } else { None };
    Ok(Some(out))
}

/// packages/ndim/src/validate.ts: wallGap. Gap of a piece to the walls: s b_f - max N_f . x over
/// the piece and the container's facets (polytope container), or s/2 minus the farthest point (ball
/// container); positive: inside, negative: protrusion.
///
/// With exact = false the walls and facets that the piece's circumscribed ball (radius R about its
/// centre t) cannot reach are skipped, each contributing the lower bound of its gap from the ball:
/// s b_f - N_f . t - R, or s/2 - |t| - R.
fn wall_gap(p: Option<&Polytope>, c: Option<&Polytope>, s: f64, pc: &mut Placed, d: usize, exact: bool) -> f64 {
    let r = p.map_or(BALL_RADIUS, |p| p.circumradius);
    let Some(c) = c else {
        let room = s / 2.0;
        let Some(p) = p else {
            return ball_in_ball_gap(&pc.t, BALL_RADIUS, room, d);
        };
        let tn = norm(&pc.t, d);
        if !exact && tn + r <= room {
            return room - tn - r;
        }
        let mut far = 0.0f64;
        let x = vertices(p, pc, d);
        for v in 0..p.n_v {
            far = math::max(far, norm(&x[v * d..v * d + d], d));
        }
        return room - far;
    };
    let mut gap = f64::INFINITY;
    if !exact && p.is_some() && norm(&pc.t, d) + r <= s * c.inradius {
        return s * c.inradius - norm(&pc.t, d) - r;
    }
    for f in 0..c.n_f {
        let Some(p) = p else {
            gap = math::min(gap, ball_facet_gap(&pc.t, BALL_RADIUS, c, f, s));
            continue;
        };
        if !exact {
            let bound = s * c.b[f] - dot(&c.n, &pc.t, d, f * d, 0) - r;
            if bound > 0.0 {
                gap = math::min(gap, bound);
                continue;
            }
        }
        let x = vertices(p, pc, d);
        let mut top = f64::NEG_INFINITY;
        for v in 0..p.n_v {
            top = math::max(top, dot(&c.n, x, d, f * d, v * d));
        }
        gap = math::min(gap, s * c.b[f] - top);
    }
    gap
}

/// packages/ndim/src/validate.ts: quickGap. A lower bound of the separation of two placed polytope
/// pieces from a few directions: the line between the centres and the two facet normals of each
/// piece that face the other most.
#[allow(clippy::too_many_arguments)]
fn quick_gap(p: &Polytope, a: &Placed, b: &Placed, d: usize, dist: f64, u: &mut [f64], a_x: &[f64], b_x: &[f64]) -> f64 {
    let mut best = f64::NEG_INFINITY;
    if dist > 0.0 {
        for c in 0..d {
            u[c] = (b.t[c] - a.t[c]) / dist;
        }
        best = gap_along(a_x, p.n_v, b_x, p.n_v, d, u);
        if best >= 1e-3 {
            return best;
        }
    } else {
        u.fill(0.0);
    }
    let mut w = vec![0.0f64; d];
    let mut lu = vec![0.0f64; d];
    for (me, sgn) in [(a, 1.0f64), (b, -1.0f64)] {
        // the two facets of `me` whose world normals R n best align with sgn * u, i.e. n with the largest n . (R^T sgn u)
        let r = me.r.as_ref().expect("a polytope piece has a rotation");
        for i in 0..d {
            let mut t = 0.0f64;
            for j in 0..d {
                t += r[j * d + i] * u[j];
            }
            lu[i] = sgn * t;
        }
        let mut f1: Option<usize> = None;
        let mut f2: Option<usize> = None;
        let mut v1 = f64::NEG_INFINITY;
        let mut v2 = f64::NEG_INFINITY;
        for f in 0..p.n_f {
            let v = dot(&p.n, &lu, d, f * d, 0);
            if v > v1 {
                f2 = f1;
                v2 = v1;
                f1 = Some(f);
                v1 = v;
            } else if v > v2 {
                f2 = Some(f);
                v2 = v;
            }
        }
        for f in [f1, f2] {
            let Some(f) = f else {
                continue;
            };
            for i in 0..d {
                let mut t = 0.0f64;
                for j in 0..d {
                    t += r[i * d + j] * p.n[f * d + j];
                }
                w[i] = sgn * t; // the world normal, pointing from a to b
            }
            best = math::max(best, gap_along(a_x, p.n_v, b_x, p.n_v, d, &w));
        }
    }
    best
}
