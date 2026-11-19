//! Seeded search for packings on the boundary of a polytope ("3D on 4D"): P unit balls or unit cubes
//! (or the other Platonic solids), minimising the edge s. Port of packages/boundary/src/search/search.ts.
//!
//! The method is the research prototype's, in four stages:
//!  - relax: L-BFGS on the model's penalty energy at a fixed s, the variables being one displacement per
//!    piece in its anchor's chart (chart.rs: a piece crosses ridges as smoothly as it moves in a cell);
//!    after each run every piece is re-anchored where it ended and the run starts again, until the energy
//!    is below the model's target or stops falling;
//!  - compress: shrink s geometrically (centres scaled about their cells' centres) and relax; a success
//!    grows the step by 1.5 (to at most 5%), a failure halves it, until it is below `stop`. A start that
//!    is infeasible at its s is first grown by 6% (cubes 5%), up to eight times;
//!  - polish: the same compression from a step of 1e-4 (cubes 1e-5) down to 1e-10, with longer
//!    relaxations, for every compression result within twice the coarse stop of the best;
//!  - finalize: validity is monotone in a scaling of the configuration, so the smallest scale k >= 1 at
//!    which the model's own exact rule holds is found by bisection, then nudged up until the engine's
//!    validator accepts the configuration at tol 0. Only states smaller than the best are finalized.
//! Starts: random layouts at the model's start edge, hops from the best (one to three pieces moved; balls
//! on every third start, cubes on every second) and, for cubes, the two-rings layout first. A given start
//! is checked first by the server's rule (validate_boundary at tol 1e-9, not counted against the budget);
//! when valid it is the first candidate, so a run never returns worse than it was given.
//!
//! Budget: `evals` counts energy evaluations, and each call of the validator counts VALIDATION_EVALS.
//! With an evaluation budget only, the run is reproducible from (problem, start, seed, evals): all choices
//! come from mulberry32(seed). `should_stop` and the clock are polled at every evaluation and before every
//! validation. Ends: "evals", "time" (time_s), "stopped" (should_stop), or "bound" when the best reaches
//! the model's floor.

use super::ball_site::SiteBallModel;
use super::balls::BallModel;
use super::chart::Charts;
use super::cubes::AlignedCubeModel;
use super::lbfgs::{lbfgs, LbfgsOptions};
use super::model::{scale_state, Finish, PieceModel, State};
use super::random::Mulberry32;
use super::rot::{exp_rot, left_jacobian, mul9, orthonormalize};
use super::solids::SolidModel;
use super::{ncube_search, nd_search, End, Halt, Res};
use crate::ids::MAX_P;
use crate::ncube::lattice::is_ncube_name;
use crate::nd::names::is_nd_name;
use crate::pieces::is_polytope_piece;
use crate::polytope::{get_polytope, is_polytope_name};
use crate::types::{BoundaryConfig, BoundaryPiece, BoundaryProblem};
use crate::validate::ValidateOptions;
use polypack_js::math;
use std::time::Instant;

/// packages/boundary/src/search/search.ts: BoundarySearchOptions
pub struct BoundarySearchOptions<'a> {
    /// Configuration to start from (any s; an invalid one is grown until the model finds it feasible).
    pub start: Option<&'a BoundaryConfig>,
    /// Integer seed of the run's random choices.
    pub seed: u32,
    /// `budget.evals`: energy evaluations (validations count VALIDATION_EVALS each).
    pub evals: u64,
    /// `budget.time_s`: a wall-clock ceiling.
    pub time_s: Option<f64>,
    /// Polled at every evaluation: true ends the run with the best so far.
    pub should_stop: Option<&'a dyn Fn() -> bool>,
    /// Balls only, for cross-checks: the generic chain metric instead of the tesseract's lattice words.
    pub ball_chains: bool,
}

impl<'a> BoundarySearchOptions<'a> {
    pub fn new(seed: u32, evals: u64) -> Self {
        BoundarySearchOptions { start: None, seed, evals, time_s: None, should_stop: None, ball_chains: false }
    }
}

/// One improvement of the best: where it came from and when.
/// packages/boundary/src/search/search.ts: BoundarySearchEvent (without the clock)
#[derive(Clone, Debug, PartialEq)]
pub struct BoundarySearchEvent {
    pub evals: u64,
    pub score: f64,
    /// "start": the given start itself; "warm": compressed from it; then random, hop, rings, cells.
    pub source: &'static str,
    /// "given", "coarse" or "polish".
    pub stage: &'static str,
}

/// packages/boundary/src/search/search.ts: BoundarySearchResult
#[derive(Clone, Debug)]
pub struct BoundarySearchResult {
    /// The best configuration (valid at tol 0, or the given start valid at tol 1e-9), or None.
    pub config: Option<BoundaryConfig>,
    /// Its s, or None.
    pub score: Option<f64>,
    /// Evaluations used.
    pub evals: u64,
    pub ended: End,
    /// The improvements, in order.
    pub trace: Vec<BoundarySearchEvent>,
    /// s of the given start when it is valid (tol 1e-9), else None.
    pub start_score: Option<f64>,
    /// Starts compressed (the warm start included).
    pub starts: usize,
}

/// Evaluations one validator call counts for: for P = 4..16 a call costs 400 to 900 energy
/// evaluations (measured), so that the budget stays about proportional to time.
/// packages/boundary/src/search/search.ts: VALIDATION_EVALS
pub const VALIDATION_EVALS: u64 = 500;

#[derive(Clone, Copy)]
struct Shape {
    /// Compression stops once its relative step is below this.
    stop: f64,
    delta0: f64,
    rounds: usize,
    max_iter: usize,
}

struct Plan {
    coarse: Shape,
    polish: Shape,
    /// Growth of an infeasible start.
    grow: f64,
    /// A hop starts at the best's s times this.
    hop_grow: f64,
    /// Every hop_every-th start (from the second on) is a hop.
    hop_every: usize,
}

/// packages/boundary/src/search/search.ts: PLANS
const BALL_PLAN: Plan = Plan {
    // balls_round2.py: coarse compression to 3e-5, polish by bisection to 1e-10
    coarse: Shape { stop: 3e-5, delta0: 0.02, rounds: 3, max_iter: 200 },
    polish: Shape { stop: 1e-10, delta0: 1e-4, rounds: 6, max_iter: 600 },
    grow: 1.06,
    hop_grow: 1.03,
    hop_every: 3,
};
const CUBE_PLAN: Plan = Plan {
    // cubes_aligned.py: compression to 1e-6; the polish is added here
    coarse: Shape { stop: 1e-6, delta0: 0.02, rounds: 4, max_iter: 300 },
    polish: Shape { stop: 1e-10, delta0: 1e-5, rounds: 6, max_iter: 600 },
    grow: 1.05,
    hop_grow: 1.04,
    hop_every: 2,
};

/// The search's model of a problem's pieces. packages/boundary/src/search/search.ts: modelOf
pub fn model_of(problem: &BoundaryProblem, ball_chains: bool) -> Box<dyn PieceModel> {
    let poly = get_polytope(&problem.polytope).expect("a polytope of the catalogue");
    let p = problem.p as usize;
    // the tesseract's cube is the axis-aligned one of its records; every other solid, the cube on the other 4-polytopes included, is rotated
    if problem.piece == "cube" && poly.name == "tesseract" {
        return Box::new(AlignedCubeModel::new(poly, p));
    }
    if problem.piece != "ball" {
        return Box::new(SolidModel::new(poly, &problem.piece, p));
    }
    // balls: the working model (radius 1) behind its site-unit wrapper (ball_site.rs)
    Box::new(SiteBallModel::new(if ball_chains { BallModel::with_chains(poly, p) } else { BallModel::new(poly, p) }))
}

/// Relative steps by which finalize_state nudges a scale up until the validator accepts it.
const FINAL_BUMPS: [f64; 7] = [0.0, 1e-14, 1e-13, 1e-12, 1e-11, 1e-10, 1e-9];

/// What the finalize stage asks of its caller.
pub trait FinalHooks {
    /// Called before every evaluation of the model's rule (the search counts them).
    fn on_violation(&mut self) -> Res<()> {
        Ok(())
    }
    /// The validator at tol 0.
    fn accept(&mut self, config: &BoundaryConfig) -> Res<bool>;
}

/// The finalize stage (module header): the smallest scale k >= 1 of st (at edge s) at which the model's
/// exact rule holds, by bisection, then nudged up until `accept` (the validator at tol 0) takes the
/// configuration at edge k s; None when no k <= 2 satisfies the rule or no nudge is accepted.
///
/// `shrink` (the generic kernel's finish): when the rule already holds at k = 1, k may also go below 1,
/// down to the model's floor, so that a state with room is drawn in until its pieces touch. The rule is
/// monotone in k, so the bisection is sound either way.
/// packages/boundary/src/search/search.ts: finalizeState
pub fn finalize_state(model: &mut dyn Finish, st: &State, s: f64, hooks: &mut dyn FinalHooks, shrink: bool) -> Res<Option<(BoundaryConfig, f64)>> {
    fn viol(model: &mut dyn Finish, hooks: &mut dyn FinalHooks, st: &State, s: f64, k: f64) -> Res<f64> {
        hooks.on_violation()?;
        Ok(model.violation(&scale_state(st, k), s * k))
    }
    fn bisect(model: &mut dyn Finish, hooks: &mut dyn FinalHooks, st: &State, s: f64, mut lo: f64, mut hi: f64) -> Res<f64> {
        // viol(lo) > 0 >= viol(hi)
        while hi - lo > 1e-15 * hi {
            let mid = 0.5 * (lo + hi);
            if viol(model, hooks, st, s, mid)? > 0.0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        Ok(hi)
    }
    let mut k = 1.0;
    if viol(model, hooks, st, s, 1.0)? > 0.0 {
        let mut lo = 1.0;
        let mut step = 1e-13;
        let mut hi = 1.0 + step;
        while viol(model, hooks, st, s, hi)? > 0.0 {
            lo = hi;
            step *= 4.0;
            if step > 1.0 {
                return Ok(None);
            }
            hi = 1.0 + step;
        }
        k = bisect(model, hooks, st, s, lo, hi)?;
    } else if shrink {
        // steps down from 1, growing fourfold, until the rule fails or the floor is reached
        let k_min = model.floor() / s;
        let mut hi = 1.0;
        let mut step = 1e-13;
        loop {
            let lo = math::max(1.0 - step, k_min);
            if !(lo < hi) {
                break;
            }
            if viol(model, hooks, st, s, lo)? > 0.0 {
                hi = bisect(model, hooks, st, s, lo, hi)?;
                break;
            }
            hi = lo;
            if lo == k_min {
                break;
            }
            step *= 4.0;
        }
        k = hi;
    }
    // the validator at tol 0 judges: touching contacts may need a hair more room than the model's exact rule
    let nudge = |model: &mut dyn Finish, hooks: &mut dyn FinalHooks, k0: f64| -> Res<Option<(BoundaryConfig, f64)>> {
        for bump in FINAL_BUMPS {
            let kk = k0 * (1.0 + bump);
            let sk = s * kk;
            let config = BoundaryConfig { s: sk, pieces: model.pieces(&scale_state(st, kk), sk) };
            if hooks.accept(&config)? {
                return Ok(Some((config, sk)));
            }
        }
        Ok(None)
    };
    // a shrunk scale the validator refuses falls back to k = 1, where the rule held
    if let Some(r) = nudge(model, hooks, k)? {
        return Ok(Some(r));
    }
    if k < 1.0 {
        return nudge(model, hooks, 1.0);
    }
    Ok(None)
}

/// The count of evaluations and the clock of one search: `tick` is the source's.
pub struct Meter<'a> {
    pub evals: u64,
    max_evals: u64,
    max_seconds: Option<f64>,
    t0: Instant,
    should_stop: Option<&'a dyn Fn() -> bool>,
}

impl<'a> Meter<'a> {
    pub fn new(max_evals: u64, max_seconds: Option<f64>, should_stop: Option<&'a dyn Fn() -> bool>) -> Meter<'a> {
        Meter { evals: 0, max_evals, max_seconds, t0: Instant::now(), should_stop }
    }

    /// packages/boundary/src/search/search.ts: tick
    pub fn tick(&mut self, cost: u64) -> Res<()> {
        if self.evals + cost > self.max_evals {
            return Err(Halt::Stop(End::Evals));
        }
        self.evals += cost;
        if let Some(f) = self.should_stop {
            if f() {
                return Err(Halt::Stop(End::Stopped));
            }
        }
        if let Some(ms) = self.max_seconds {
            if self.t0.elapsed().as_secs_f64() > ms {
                return Err(Halt::Stop(End::Time));
            }
        }
        Ok(())
    }
}

/// The validator at tol 0, as the finalize stage of the 4-polytopes' search counts it.
struct SearchHooks<'m, 'a> {
    problem: &'m BoundaryProblem,
    meter: &'m mut Meter<'a>,
}

impl FinalHooks for SearchHooks<'_, '_> {
    fn on_violation(&mut self) -> Res<()> {
        self.meter.tick(1)
    }

    fn accept(&mut self, config: &BoundaryConfig) -> Res<bool> {
        self.meter.tick(VALIDATION_EVALS)?;
        validate_at_zero(self.problem, config)
    }
}

/// `validateBoundary(problem, config, { tol: 0 }).ok`.
pub fn validate_at_zero(problem: &BoundaryProblem, config: &BoundaryConfig) -> Res<bool> {
    let opts = ValidateOptions { tol: Some(0.0), ..Default::default() };
    crate::validate::validate_boundary_config(problem, config, &opts).map(|v| v.ok).map_err(|e| Halt::Error(e.to_string()))
}

/// Is P a valid piece count (an integer from 1 to MAX_P)? packages/boundary/src/ids.ts: isPieceCount
pub fn is_piece_count(p: f64) -> bool {
    p.fract() == 0.0 && p >= 1.0 && p <= MAX_P
}

/// The problem is one the search can model: the polytope, the piece and the count in range.
fn check_problem(problem: &BoundaryProblem) -> Result<(), String> {
    let piece_ok = problem.piece == "ball" || is_polytope_piece(&problem.piece);
    if !is_polytope_name(&problem.polytope) || !piece_ok || !is_piece_count(problem.p) {
        return Err("searchBoundary: invalid problem".to_string());
    }
    Ok(())
}

/// The relaxation's variables: 3 per piece (displacements in the anchor's chart), and for rotated
/// pieces 3 more (a rotation increment in the anchor's frame).
struct Relax {
    rot: bool,
    nv: usize,
    g_u: Vec<f64>,
    ms: Vec<f64>,
    moved: State,
    e_rot: [f64; 9],
    tmp_rot: [f64; 9],
    jac: [f64; 9],
}

impl Relax {
    fn new(p: usize, rot: bool) -> Relax {
        let p3 = 3 * p;
        let nv = if rot { 2 * p3 } else { p3 };
        Relax { rot, nv, g_u: vec![0.0; nv], ms: vec![0.0; 9 * p], moved: Self::new_state(p, rot), e_rot: [0.0; 9], tmp_rot: [0.0; 9], jac: [0.0; 9] }
    }

    fn new_state(p: usize, rot: bool) -> State {
        State { cells: vec![0; p], u: vec![0.0; 3 * p], r: if rot { Some(vec![0.0; 9 * p]) } else { None } }
    }
}

/// Moves every piece of `base` by its displacement (and turns it by its rotation increment) in x;
/// false when a path meets a hinge. packages/boundary/src/search/search.ts: place
#[allow(clippy::too_many_arguments)]
fn place(charts: &Charts, p: usize, rot: bool, ms: &mut [f64], e_rot: &mut [f64; 9], tmp_rot: &mut [f64; 9], base: &State, x: &[f64], s: f64, out: &mut State) -> bool {
    let p3 = 3 * p;
    for q in 0..p {
        let c = charts.move_(base.cells[q], &base.u, 3 * q, x[3 * q], x[3 * q + 1], x[3 * q + 2], s, &mut out.u, 3 * q, ms, 9 * q);
        if c < 0 {
            return false;
        }
        out.cells[q] = c as usize;
        if rot {
            // the new orientation, in the end cell's frame: M exp(omega) R, omega an increment in the start frame
            exp_rot(x[p3 + 3 * q], x[p3 + 3 * q + 1], x[p3 + 3 * q + 2], e_rot, 0);
            mul9(e_rot, 0, base.r.as_ref().unwrap(), 9 * q, tmp_rot, 0);
            mul9(ms, 9 * q, tmp_rot, 0, out.r.as_mut().unwrap(), 9 * q);
            orthonormalize(out.r.as_mut().unwrap(), 9 * q);
        }
    }
    true
}

struct Run<'a> {
    problem: &'a BoundaryProblem,
    charts: Charts,
    model: Box<dyn PieceModel>,
    plan: &'static Plan,
    p: usize,
    rand: Mulberry32,
    meter: Meter<'a>,
    rx: Relax,
    best: Option<(BoundaryConfig, f64)>,
    hop_from: Option<(State, f64)>,
    trace: Vec<BoundarySearchEvent>,
}

impl<'a> Run<'a> {
    // ------------------------------------------------------------ relax
    fn relax(&mut self, st: &State, s: f64, rounds: usize, max_iter: usize) -> Res<(State, f64)> {
        let mut cur = st.clone();
        let mut e = f64::INFINITY;
        let p = self.p;
        let p3 = 3 * p;
        let rot = self.rx.rot;
        for _ in 0..rounds {
            let base = cur.clone();
            let (target, max_step, nv) = (self.model.target(), self.model.max_step(), self.rx.nv);
            let res = {
                let (charts, meter, model, rx) = (&self.charts, &mut self.meter, &mut self.model, &mut self.rx);
                let mut f = |x: &[f64], g: &mut [f64]| -> Res<f64> {
                    meter.tick(1)?;
                    let Relax { ms, e_rot, tmp_rot, moved, g_u, jac, .. } = rx;
                    if !place(charts, p, rot, ms, e_rot, tmp_rot, &base, x, s, moved) {
                        g.fill(0.0);
                        return Ok(f64::INFINITY);
                    }
                    let en = model.energy(moved, s, g_u);
                    // gradient in the anchor's chart: M^T times the gradient at the end point
                    for q in 0..p {
                        let m = 9 * q;
                        let a = g_u[3 * q];
                        let b = g_u[3 * q + 1];
                        let c = g_u[3 * q + 2];
                        g[3 * q] = ms[m] * a + ms[m + 3] * b + ms[m + 6] * c;
                        g[3 * q + 1] = ms[m + 1] * a + ms[m + 4] * b + ms[m + 7] * c;
                        g[3 * q + 2] = ms[m + 2] * a + ms[m + 5] * b + ms[m + 8] * c;
                        if rot {
                            // the rotation increment omega (start frame): d theta_end = det(M) M Jl(omega) d omega,
                            // so g_omega = Jl^T det(M) M^T g_theta
                            let ta = g_u[p3 + 3 * q];
                            let tb = g_u[p3 + 3 * q + 1];
                            let tc = g_u[p3 + 3 * q + 2];
                            let det = ms[m] * (ms[m + 4] * ms[m + 8] - ms[m + 5] * ms[m + 7]) - ms[m + 1] * (ms[m + 3] * ms[m + 8] - ms[m + 5] * ms[m + 6]) + ms[m + 2] * (ms[m + 3] * ms[m + 7] - ms[m + 4] * ms[m + 6]);
                            let h0 = det * (ms[m] * ta + ms[m + 3] * tb + ms[m + 6] * tc);
                            let h1 = det * (ms[m + 1] * ta + ms[m + 4] * tb + ms[m + 7] * tc);
                            let h2 = det * (ms[m + 2] * ta + ms[m + 5] * tb + ms[m + 8] * tc);
                            left_jacobian(x[p3 + 3 * q], x[p3 + 3 * q + 1], x[p3 + 3 * q + 2], jac, 0);
                            g[p3 + 3 * q] = jac[0] * h0 + jac[3] * h1 + jac[6] * h2;
                            g[p3 + 3 * q + 1] = jac[1] * h0 + jac[4] * h1 + jac[7] * h2;
                            g[p3 + 3 * q + 2] = jac[2] * h0 + jac[5] * h1 + jac[8] * h2;
                        }
                    }
                    Ok(en)
                };
                let opts = LbfgsOptions { max_iter, target, max_step, memory: 12 };
                lbfgs(&mut f, &vec![0.0; nv], &opts)?
            };
            let mut next = Relax::new_state(p, rot);
            let Relax { ms, e_rot, tmp_rot, .. } = &mut self.rx;
            if !(res.1 < f64::INFINITY) || !place(&self.charts, p, rot, ms, e_rot, tmp_rot, &base, &res.0, s, &mut next) {
                break;
            }
            let prev = e;
            cur = next;
            e = res.1;
            if e < self.model.target() || !(e < prev * (1.0 - 1e-3)) {
                break;
            }
        }
        Ok((cur, e))
    }

    // ------------------------------------------------------------ compress
    /// `early`, when given, is called once with the first feasible state (the models of rotated pieces
    /// offer it drawn in to touching, so that a first valid packing does not wait for the whole
    /// compression: a solid's first result needs thousands of evaluations).
    fn compress(&mut self, st0: &State, s0: f64, sh: Shape, grow: bool, early: Option<&'static str>) -> Res<Option<(State, f64)>> {
        let mut s = s0;
        let mut r = self.relax(st0, s, sh.rounds, sh.max_iter)?;
        let mut k = 0;
        while grow && k < 8 && !(r.1 < self.model.target()) {
            let s2 = s * self.plan.grow;
            r = self.relax(&scale_state(&r.0, s2 / s), s2, sh.rounds, sh.max_iter)?;
            s = s2;
            k += 1;
        }
        if !(r.1 < self.model.target()) {
            return Ok(None);
        }
        if let Some(source) = early {
            self.early_offer(source, &r.0, s)?;
        }
        let mut best = (r.0, s);
        let mut delta = sh.delta0;
        while delta > sh.stop {
            let s2 = math::max(best.1 * (1.0 - delta), self.model.floor());
            if !(s2 < best.1) {
                break;
            }
            let q = self.relax(&scale_state(&best.0, s2 / best.1), s2, sh.rounds, sh.max_iter)?;
            if q.1 < self.model.target() {
                best = (q.0, s2);
                delta = math::min(delta * 1.5, 0.05);
            } else {
                delta *= 0.5;
            }
        }
        Ok(Some(best))
    }

    // ------------------------------------------------------------ finalize
    fn finalize(&mut self, st: &State, s: f64, shrink: bool) -> Res<Option<(BoundaryConfig, f64)>> {
        let mut hooks = SearchHooks { problem: self.problem, meter: &mut self.meter };
        finalize_state(&mut *self.model, st, s, &mut hooks, shrink)
    }

    // ------------------------------------------------------------ the run
    fn at_floor(&self) -> bool {
        self.best.as_ref().is_some_and(|b| b.1 <= self.model.floor() * (1.0 + 1e-9))
    }

    fn offer(&mut self, f: Option<(BoundaryConfig, f64)>, source: &'static str, stage: &'static str, st: &State, s: f64) -> Res<()> {
        let Some(f) = f else { return Ok(()) };
        if self.best.as_ref().is_some_and(|b| !(f.1 < b.1)) {
            return Ok(());
        }
        let score = f.1;
        self.best = Some(f);
        self.hop_from = Some((st.clone(), s));
        self.trace.push(BoundarySearchEvent { evals: self.meter.evals, score, source, stage });
        if self.at_floor() {
            return Err(Halt::Stop(End::Bound));
        }
        Ok(())
    }

    /// The early offer of rotated pieces (compress): the first feasible state, drawn in to touching.
    fn early_offer(&mut self, source: &'static str, st: &State, s: f64) -> Res<()> {
        if !self.model.rotates() {
            return Ok(());
        }
        let f = self.finalize(st, s, true)?;
        self.offer(f, source, "coarse", st, s)
    }

    fn consider(&mut self, r: Option<(State, f64)>, source: &'static str) -> Res<()> {
        let Some((rst, rs)) = r else { return Ok(()) };
        let window = 2.0 * self.plan.coarse.stop;
        if self.best.as_ref().is_some_and(|b| rs > b.1 * (1.0 + window)) {
            return Ok(());
        }
        // finalizing only scales up, so a state no smaller than the best cannot beat it
        let better = |best: &Option<(BoundaryConfig, f64)>, s: f64| best.as_ref().is_none_or(|b| s < b.1);
        if better(&self.best, rs) {
            let f = self.finalize(&rst, rs, false)?;
            self.offer(f, source, "coarse", &rst, rs)?;
        }
        let polish = self.plan.polish;
        let p = self.compress(&rst, rs, polish, false, None)?;
        if let Some((pst, ps)) = p {
            if ps < rs && better(&self.best, ps) {
                let f = self.finalize(&pst, ps, false)?;
                self.offer(f, source, "polish", &pst, ps)?;
            }
        }
        Ok(())
    }

    /// The loop of the run: the given start, then starts without end (it leaves only by a Halt).
    fn run(&mut self, start: Option<&BoundaryConfig>, start_score: &mut Option<f64>, starts: &mut usize) -> Res<()> {
        if let Some(start) = start {
            // the given start, by the server's rule (not counted against the budget: it is always checked)
            let opts = ValidateOptions { tol: Some(1e-9), ..Default::default() };
            let v = crate::validate::validate_boundary_config(self.problem, start, &opts).map_err(|e| Halt::Error(e.to_string()))?;
            let st = self.model.state_of(start);
            if v.ok {
                self.best = Some((start.clone(), start.s));
                *start_score = Some(start.s);
                if let Some(st) = &st {
                    self.hop_from = Some((st.clone(), start.s));
                }
                self.trace.push(BoundarySearchEvent { evals: self.meter.evals, score: start.s, source: "start", stage: "given" });
                if self.at_floor() {
                    return Err(Halt::Stop(End::Bound));
                }
            }
            if let Some(st) = st {
                if start.s.is_finite() && start.s > 0.0 {
                    *starts += 1;
                    let coarse = self.plan.coarse;
                    let r = self.compress(&st, start.s, coarse, true, Some("warm"))?;
                    self.consider(r, "warm")?;
                }
            }
        }
        let mut n = 0usize;
        loop {
            let built = if n == 0 { self.model.constructed_start(&mut self.rand)? } else { None };
            let hop_every = self.plan.hop_every;
            let (st, s, source): (State, f64, &'static str);
            if let Some((bst, bs)) = built {
                st = bst;
                s = bs;
                source = if self.problem.piece == "cube" && self.problem.polytope == "tesseract" { "rings" } else { "cells" };
            } else if let Some((fst, fs)) = self.hop_from.clone().filter(|_| n % hop_every == hop_every - 1) {
                s = fs * self.plan.hop_grow;
                st = self.model.hop(&scale_state(&fst, self.plan.hop_grow), s, &mut self.rand);
                source = "hop";
            } else {
                s = self.model.start_edge();
                st = self.model.random_state(s, &mut self.rand);
                source = "random";
            }
            *starts += 1;
            let coarse = self.plan.coarse;
            let r = self.compress(&st, s, coarse, true, Some(source))?;
            self.consider(r, source)?;
            n += 1;
        }
    }
}

/// packages/boundary/src/search/search.ts: searchBoundary. `Err` for what the source throws: an invalid
/// problem, or an error of the validator or the model.
pub fn search_boundary(problem: &BoundaryProblem, opts: &BoundarySearchOptions) -> Result<BoundarySearchResult, String> {
    // the simplex, orthoplex and demicube (d = 5..10): the same (nd/search.ts)
    if is_nd_name(&problem.polytope) && is_piece_count(problem.p) && problem.piece == "ball" {
        return nd_search::search_nd(problem, opts);
    }
    // the d-cubes (d = 5..10): seeds finished by the kernel's exact finishing (ncube/search.ts)
    if is_ncube_name(&problem.polytope) && is_piece_count(problem.p) && (problem.piece == "ball" || problem.piece == "cube") {
        return ncube_search::search_ncube(problem, opts);
    }
    check_problem(problem)?;
    let poly = get_polytope(&problem.polytope)?;
    let model = model_of(problem, opts.ball_chains);
    let plan: &'static Plan = if problem.piece == "ball" { &BALL_PLAN } else { &CUBE_PLAN };
    let p = problem.p as usize;
    let rot = model.rotates();
    let mut run = Run {
        problem,
        charts: Charts::new(poly),
        model,
        plan,
        p,
        rand: Mulberry32::new(opts.seed),
        meter: Meter::new(opts.evals, opts.time_s, opts.should_stop),
        rx: Relax::new(p, rot),
        best: None,
        hop_from: None,
        trace: Vec::new(),
    };
    let mut start_score = None;
    let mut starts = 0usize;
    let ended = match run.run(opts.start, &mut start_score, &mut starts) {
        Err(Halt::Stop(why)) => why,
        Err(Halt::Error(e)) => return Err(e),
        Ok(()) => End::Evals,
    };
    let (config, score) = match run.best {
        Some((c, s)) => (Some(c), Some(s)),
        None => (None, None),
    };
    Ok(BoundarySearchResult { config, score, evals: run.meter.evals, ended, trace: run.trace, start_score, starts })
}

/// A copy of a configuration (the source's cloneConfig).
pub fn clone_config(c: &BoundaryConfig) -> BoundaryConfig {
    BoundaryConfig { s: c.s, pieces: c.pieces.iter().map(|p| BoundaryPiece { cell: p.cell, u: p.u.clone(), q: p.q }).collect() }
}
