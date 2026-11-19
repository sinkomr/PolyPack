//! The boundary search for balls on the simplex, orthoplex and demicube (d = 5..10): the structured
//! starts of the kernel (seeds) finished by its exact finishing, best kept. Port of
//! packages/boundary/src/nd/search.ts with what it calls of nd/kernel.ts (seeds, finish, validate),
//! nd/seeds.ts, nd/rule.ts and the violation, the starts and the pieces of nd/model.ts.
//!
//! As the d-cubes' (ncube_search.rs): it is not an optimizer of records, and it exists so that a boundary
//! job on one of these problems has an engine with the contract of searchBoundary. The kernel's place with
//! no displacement (walkND of a zero vector) is the anchor read into ambient coordinates and back into the
//! local ones of the same cell; the finish is `finalize_state` with `shrink`.

use super::driver::{finalize_state, is_piece_count, validate_at_zero, BoundarySearchEvent, BoundarySearchOptions, BoundarySearchResult, FinalHooks};
use super::model::{Finish, State};
use super::random::Mulberry32;
use super::{End, Halt, Res};
use crate::nd::bounds::nd_bound;
use crate::nd::chains::{develop, hinge_distance, join_distance, new_nd_budget, nd_zero_length, NdNode};
use crate::nd::container::{get_nd, NdContainer};
use crate::nd::names::{nd_parse, NdFamily, ND_MAX_P};
use crate::nd::validate::{anchor_piece, nd_snap, ND_MAX_WORK, ND_REACH};
use crate::types::{BoundaryConfig, BoundaryPiece, BoundaryProblem};
use crate::validate::{validate_boundary_config, ValidateOptions, MAX_S};
use polypack_js::math;
use std::time::Instant;

/// Energy evaluations one finish() costs (measured). packages/boundary/src/nd/kernel.ts: ND_FINISH_COST
pub const ND_FINISH_COST: u64 = 500;

/// Steps one evaluation of the model may spend before it reports a huge violation instead.
/// packages/boundary/src/nd/model.ts: ND_EVAL_WORK
const ND_EVAL_WORK: f64 = 60_000.0;

/// Room the exact layouts get over their derived edge (relative). packages/boundary/src/nd/seeds.ts: ROOM
const ROOM: f64 = 1.0 + 1e-9;

/// The edge from which a ball at a cell's centre is valid. packages/boundary/src/nd/bounds.ts: ndCentreEdge
fn nd_centre_edge(family: NdFamily, d: usize) -> f64 {
    if family == NdFamily::Demicube {
        return if d == 5 { math::sqrt(6.0) / 2.0 } else { 1.0 };
    }
    math::sqrt((d * (d - 2)) as f64) / 2.0
}

/// The edge from which a pair of adjacent centres is valid. packages/boundary/src/nd/bounds.ts: ndPairEdge
fn nd_pair_edge(family: NdFamily, d: usize) -> f64 {
    if family == NdFamily::Demicube {
        return math::SQRT2;
    }
    math::sqrt(((d * (d - 1)) as f64) / 2.0)
}

/// The local coordinates of an ambient point of cell c's hyperplane (the inverse of to_ambient).
/// packages/boundary/src/nd/container.ts: NDContainer.toLocal
fn to_local(cc: &NdContainer, c: usize, x: &[f64], s: f64, out: &mut [f64]) {
    let cl = cc.cell(c);
    let (dd, n) = (cc.dd, cc.n);
    for k in 0..n {
        let f = &cl.frame[k];
        let mut dt = 0.0;
        for j in 0..dd {
            dt += f[j] * (x[j] - s * cl.o[j]);
        }
        out[k] = dt;
    }
}

/// packages/boundary/src/nd/model.ts: NDBallModel (the violation, the starts and the pieces)
pub struct NdBallModel {
    c: &'static NdContainer,
    p: usize,
    n: usize,
    floor: f64,
    /// The cumulative weights of the demicube's cells (NDContainer.cum), built on first use.
    cum: Option<Vec<f64>>,
}

impl NdBallModel {
    fn new(polytope: &str, p: usize) -> NdBallModel {
        let (family, d) = nd_parse(polytope).expect("an nD container");
        let c = get_nd(polytope).expect("an nD container");
        NdBallModel { c, p, n: c.n, floor: nd_bound(family, d, p as f64), cum: None }
    }

    /// A random cell, chosen with probability proportional to its (d-1)-volume (the demicube's simplex facets
    /// are tiny beside its (d-1)-demicube facets). packages/boundary/src/nd/container.ts: NDContainer.pickCell
    fn pick_cell(&mut self, rand: &mut Mulberry32) -> usize {
        let c = self.c;
        if c.family != NdFamily::Demicube {
            return (c.c - 1).min((rand.next() * c.c as f64).floor() as usize);
        }
        if self.cum.is_none() {
            let n = c.n;
            let mut nf = 1.0;
            for i in 2..=n {
                nf *= i as f64;
            }
            let w_sim = math::sqrt(c.d as f64) / nf;
            let w_dem = 1.0 - math::pow(2.0, (n - 1) as f64) / nf;
            let w: Vec<f64> = (0..c.c).map(|k| if k < 2 * c.d { w_dem } else { w_sim }).collect();
            let mut total = 0.0;
            for x in &w {
                total += x;
            }
            let mut acc = 0.0;
            self.cum = Some(
                w.iter()
                    .map(|x| {
                        acc += x / total;
                        acc
                    })
                    .collect(),
            );
        }
        let cum = self.cum.as_ref().unwrap();
        let r = rand.next();
        let mut lo = 0usize;
        let mut hi = c.c - 1;
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if cum[mid] >= r {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        lo
    }

    /// A random point of cell c (local coordinates at edge s), shrunk toward the cell's centre until it is inside.
    /// packages/boundary/src/nd/model.ts: NDBallModel.randomPoint
    fn random_point(&self, c: usize, s: f64, rand: &mut Mulberry32, spread: f64) -> Vec<f64> {
        let (cc, n) = (self.c, self.n);
        let cl = cc.cell(c);
        let dd = cc.dd;
        let mut u0 = vec![0.0; n];
        for k in 0..n {
            let a = math::sqrt(-2.0 * math::log(1.0 - rand.next()));
            let b = math::cos(2.0 * math::PI * rand.next());
            u0[k] = a * b * spread * s;
        }
        let mut lam = 1.0;
        for _t in 0..40 {
            let u: Vec<f64> = u0.iter().map(|v| v * lam).collect();
            let x = cc.to_ambient(c, &u, s);
            let mut ok = true;
            let mut k = 0;
            while k < cl.nbr.len() && ok {
                let mut v = -s * cl.hn[k];
                for r in 0..dd {
                    v += cl.nn[k * dd + r] * x[r];
                }
                if v > 0.0 {
                    ok = false;
                }
                k += 1;
            }
            if ok {
                return u;
            }
            lam *= 0.7;
        }
        vec![0.0; n]
    }

    /// A random cell a ball can sit in at edge s: the demicube's simplex facets only when large enough.
    /// packages/boundary/src/nd/model.ts: NDBallModel.viableCell
    fn viable_cell(&mut self, rand: &mut Mulberry32, s: f64) -> usize {
        let (family, d, n) = (self.c.family, self.c.d, self.n);
        for _t in 0..30 {
            let c = self.pick_cell(rand);
            if family != NdFamily::Demicube || c < 2 * d || s >= 0.55 * math::sqrt((n * n - 1) as f64) {
                return c;
            }
        }
        0
    }
}

impl Finish for NdBallModel {
    fn floor(&self) -> f64 {
        self.floor
    }

    /// The largest violation. packages/boundary/src/nd/model.ts: NDBallModel.evaluate, with `viol`
    fn violation(&mut self, st: &State, s: f64) -> f64 {
        let (cc, p, n) = (self.c, self.p, self.n);
        let dd = cc.dd;
        let mut budget = new_nd_budget(ND_EVAL_WORK, f64::INFINITY);
        let eta = nd_snap(s, 0.0);
        let mut run = || -> Result<f64, crate::nd::chains::NdLimitError> {
            let mut crowded = vec![false; p];
            let mut need = vec![false; p];
            let mut chains: Vec<Option<Vec<Vec<NdNode>>>> = (0..p).map(|_| None).collect();
            let at: Vec<_> = (0..p).map(|i| anchor_piece(cc, s, st.cells[i], &st.u[i * n..(i + 1) * n], eta)).collect();
            // chord-near pairs first, to know which balls the focus needs
            let mut near: Vec<(usize, usize)> = Vec::new();
            for i in 0..p {
                let xi = &at[i].x;
                need[i] = true;
                for j in 0..p {
                    if j <= i {
                        continue;
                    }
                    let xj = &at[j].x;
                    let mut q = 0.0;
                    for r in 0..dd {
                        q += (xi[r] - xj[r]) * (xi[r] - xj[r]);
                    }
                    if q < 1.0 {
                        near.push((i, j));
                        need[j] = true;
                    }
                }
            }
            let mut worst = f64::NEG_INFINITY;
            // clearance, and the half-chains of the balls that are not crowded against a hinge
            for i in 0..p {
                if !need[i] {
                    continue;
                }
                let a = &at[i];
                let mut roots: Vec<Vec<NdNode>> = Vec::with_capacity(a.anchors.len());
                for an in &a.anchors {
                    roots.push(develop(cc, s, an.cell, &an.x, 0.0, &mut budget)?);
                }
                let mut best_dist = f64::INFINITY;
                for k in 0..roots.len() {
                    let h = hinge_distance(cc, s, &roots[k], ND_REACH, &mut budget, -1)?;
                    if h.dist < best_dist {
                        best_dist = h.dist;
                    }
                }
                if best_dist >= 0.5 {
                    let mut chains_of: Vec<Vec<NdNode>> = Vec::with_capacity(a.anchors.len());
                    for an in &a.anchors {
                        chains_of.push(develop(cc, s, an.cell, &an.x, ND_REACH, &mut budget)?);
                    }
                    for k in 0..chains_of.len() {
                        let h = hinge_distance(cc, s, &chains_of[k], ND_REACH, &mut budget, -1)?;
                        if h.dist < best_dist {
                            best_dist = h.dist;
                        }
                    }
                    chains[i] = Some(chains_of);
                } else {
                    crowded[i] = true;
                }
                let v = 0.5 - best_dist;
                worst = math::max(worst, v);
            }
            // pairs
            for &(i, j) in &near {
                let xi = &at[i].x;
                let xj = &at[j].x;
                let mut q0 = 0.0;
                for r in 0..dd {
                    q0 += (xi[r] - xj[r]) * (xi[r] - xj[r]);
                }
                let ell;
                if crowded[i] || crowded[j] || q0 < nd_zero_length(s) * nd_zero_length(s) {
                    let mut q = 0.0;
                    for r in 0..dd {
                        q += (xi[r] - xj[r]) * (xi[r] - xj[r]);
                    }
                    ell = math::sqrt(q);
                } else {
                    let ci = chains[i].as_ref().expect("a ball that is not crowded has its half-chains");
                    let cj = chains[j].as_ref().expect("a ball that is not crowded has its half-chains");
                    let mut best_j = f64::INFINITY;
                    for pi in 0..ci.len() {
                        for qj in 0..cj.len() {
                            let r = join_distance(cc, s, &ci[pi], &cj[qj], math::min(best_j, 1.0), &mut budget, false, 1e-12, false)?;
                            if r.dist < best_j {
                                best_j = r.dist;
                            }
                        }
                    }
                    ell = best_j;
                }
                if !(ell < 1.0) {
                    continue;
                }
                worst = math::max(worst, 1.0 - ell);
            }
            // loops
            for i in 0..p {
                if !need[i] || crowded[i] {
                    continue;
                }
                let Some(ci) = chains[i].as_ref() else { continue };
                let mut best_l = f64::INFINITY;
                for pi in 0..ci.len() {
                    for qj in pi..ci.len() {
                        let r = join_distance(cc, s, &ci[pi], &ci[qj], math::min(best_l, 1.0), &mut budget, pi == qj, 1e-12, true)?;
                        if r.dist < best_l {
                            best_l = r.dist;
                        }
                    }
                }
                if !(best_l < 1.0) {
                    continue;
                }
                worst = math::max(worst, 1.0 - best_l);
            }
            Ok(worst)
        };
        match run() {
            // a limit of the model's work: a huge violation
            Err(_) => 1.0,
            Ok(w) => {
                if w == f64::NEG_INFINITY {
                    -1.0
                } else {
                    w
                }
            }
        }
    }

    /// The pieces of a state: each centre pulled toward its cell's centre by a hair until its reading is inside
    /// the closed cell. packages/boundary/src/nd/model.ts: NDBallModel.pieces
    fn pieces(&mut self, st: &State, s: f64) -> Vec<BoundaryPiece> {
        let (cc, p, n) = (self.c, self.p, self.n);
        let dd = cc.dd;
        let mut out = Vec::with_capacity(p);
        for i in 0..p {
            let c = st.cells[i];
            let cl = cc.cell(c);
            let mut u: Vec<f64> = st.u[i * n..i * n + n].to_vec();
            let mut f = 1e-16;
            for _t in 0..60 {
                let x = cc.to_ambient(c, &u, s);
                let mut worst = f64::NEG_INFINITY;
                for k in 0..cl.nbr.len() {
                    let mut v = -s * cl.hn[k];
                    for r in 0..dd {
                        v += cl.nn[k * dd + r] * x[r];
                    }
                    if v > worst {
                        worst = v;
                    }
                }
                if worst <= 0.0 {
                    break;
                }
                u = st.u[i * n..i * n + n].iter().map(|v| v * (1.0 - f)).collect();
                f *= 2.0;
            }
            out.push(BoundaryPiece { cell: c, u, q: None });
        }
        out
    }
}

// ---------------------------------------------------------------- the seeds

fn pick(count: usize, from: usize, rand: &mut Mulberry32) -> Vec<usize> {
    let mut pool: Vec<usize> = (0..from).collect();
    for i in 0..count {
        let j = i + rand.int(from - i);
        pool.swap(i, j);
    }
    pool.truncate(count);
    pool
}

/// An exact layout of P balls, or None when none is known for this container and P.
/// packages/boundary/src/nd/seeds.ts: ndExactLayout
fn nd_exact_layout(polytope: &str, p: usize, rand: &mut Mulberry32) -> Option<(State, f64)> {
    let cc = get_nd(polytope).expect("an nD container");
    let n = cc.n;
    let (family, d) = (cc.family, cc.d);
    let mk = |cells: Vec<usize>, s: f64| -> (State, f64) {
        let k = cells.len();
        (State { cells, u: vec![0.0; n * k], r: None }, s)
    };
    if p == 1 {
        let c = rand.int(if family == NdFamily::Demicube { 2 * d } else { cc.c });
        return Some(mk(vec![c], nd_centre_edge(family, d) * ROOM));
    }
    if family == NdFamily::Simplex && p <= d + 1 {
        return Some(mk(pick(p, cc.c, rand), nd_pair_edge(family, d) * ROOM));
    }
    if family == NdFamily::Demicube && p <= 2 * d {
        return Some(mk(pick(p, 2 * d, rand), nd_pair_edge(family, d) * ROOM));
    }
    if family == NdFamily::Orthoplex && p == 2 {
        let c = rand.int(cc.c);
        let bit = rand.int(d);
        return Some(mk(vec![c, c ^ (1 << bit)], nd_pair_edge(family, d) * ROOM));
    }
    None
}

/// The sequential random layout: balls are added one at a time at random points, each accepted when it
/// conflicts with none placed (the model's violation), the edge raised by 6% (the placed balls scaled with
/// it) after every failed round. packages/boundary/src/nd/seeds.ts: ndSequentialLayout
fn nd_sequential_layout(polytope: &str, p: usize, rand: &mut Mulberry32) -> (State, f64) {
    let (family, d) = nd_parse(polytope).expect("an nD container");
    let cc = get_nd(polytope).expect("an nD container");
    let n = cc.n;
    let mut models: Vec<(usize, NdBallModel)> = Vec::new();
    fn model_index(models: &mut Vec<(usize, NdBallModel)>, polytope: &str, k: usize) -> usize {
        if let Some(i) = models.iter().position(|m| m.0 == k) {
            return i;
        }
        models.push((k, NdBallModel::new(polytope, k)));
        models.len() - 1
    }
    let mut s = math::max(nd_bound(family, d, p as f64), nd_centre_edge(family, d)) * 1.1;
    let mut cells: Vec<usize> = Vec::new();
    let mut us: Vec<Vec<f64>> = Vec::new();
    let state = |cells: &[usize], us: &[Vec<f64>], extra: Option<(usize, &[f64])>| -> State {
        let k = cells.len() + if extra.is_some() { 1 } else { 0 };
        let mut st = State { cells: vec![0; k], u: vec![0.0; n * k], r: None };
        for (i, &c) in cells.iter().enumerate() {
            st.cells[i] = c;
            st.u[i * n..i * n + n].copy_from_slice(&us[i]);
        }
        if let Some((c, u)) = extra {
            st.cells[k - 1] = c;
            st.u[(k - 1) * n..k * n].copy_from_slice(u);
        }
        st
    };
    while cells.len() < p {
        let mut placed = false;
        let mut t = 0;
        while t < 60 && !placed {
            let m1 = model_index(&mut models, polytope, 1);
            let c = models[m1].1.viable_cell(rand, s);
            let u = models[m1].1.random_point(c, s, rand, 0.4 / math::sqrt(n as f64));
            let k = cells.len() + 1;
            let mk = model_index(&mut models, polytope, k);
            let ok = models[mk].1.violation(&state(&cells, &us, Some((c, &u))), s) <= -1e-9 || (k == 1 && models[m1].1.violation(&state(&cells, &us, Some((c, &u))), s) <= 0.0);
            if ok {
                cells.push(c);
                us.push(u);
                placed = true;
            }
            t += 1;
        }
        if !placed {
            s *= 1.06;
            for u in us.iter_mut() {
                for v in u.iter_mut() {
                    *v *= 1.06;
                }
            }
        }
    }
    (state(&cells, &us, None), s)
}

// ---------------------------------------------------------------- the server's rule on the start

/// What is wrong with the form of a configuration (typed: cell, count and coordinates are those of the
/// type). packages/boundary/src/nd/rule.ts: ndFormErrors
fn nd_form_errors(cc: &NdContainer, p: usize, config: &BoundaryConfig) -> bool {
    if !(config.s.is_finite() && config.s.abs() <= MAX_S && config.s > 0.0) {
        return true;
    }
    if config.pieces.len() != p {
        return true;
    }
    for pc in &config.pieces {
        if pc.cell >= cc.c || pc.u.len() != cc.n {
            return true;
        }
        if pc.u.iter().any(|x| !x.is_finite() || x.abs() > 1e4) {
            return true;
        }
        if pc.q.is_some() {
            return true;
        }
    }
    false
}

/// packages/boundary/src/nd/rule.ts: ndServerRule: the score of a valid configuration
fn nd_server_rule(problem: &BoundaryProblem, cc: &NdContainer, config: &BoundaryConfig, bound: f64) -> Option<f64> {
    if !(problem.p <= ND_MAX_P as f64) {
        return None;
    }
    if nd_form_errors(cc, problem.p as usize, config) {
        return None;
    }
    let s = config.s;
    if s < bound * (1.0 - 1e-9) {
        return None;
    }
    let opts = ValidateOptions { tol: Some(1e-9), max_reasons: Some(20.0), max_work: Some(ND_MAX_WORK), ..Default::default() };
    match validate_boundary_config(problem, config, &opts) {
        Ok(v) if v.ok => Some(s),
        _ => None,
    }
}

struct Hooks<'m> {
    problem: &'m BoundaryProblem,
}

impl FinalHooks for Hooks<'_> {
    fn accept(&mut self, config: &BoundaryConfig) -> Res<bool> {
        validate_at_zero(self.problem, config)
    }
}

/// packages/boundary/src/nd/search.ts: searchND
pub fn search_nd(problem: &BoundaryProblem, opts: &BoundarySearchOptions) -> Result<BoundarySearchResult, String> {
    if !is_piece_count(problem.p) {
        return Err("ndKernel: invalid problem".to_string());
    }
    let p = problem.p as usize;
    if p > ND_MAX_P {
        return Err(format!("ndKernel: P = {} is above the largest of the {}, {}", p, problem.polytope, ND_MAX_P));
    }
    let cc = get_nd(&problem.polytope).expect("an nD container");
    let n = cc.n;
    let mut model = NdBallModel::new(&problem.polytope, p);
    let bound = model.floor();
    let mut rand = Mulberry32::new(opts.seed);
    let t0 = Instant::now();
    let max_evals = opts.evals;
    let max_seconds = opts.time_s;
    let mut evals = 0u64;
    let mut best: Option<(BoundaryConfig, f64)> = None;
    let mut start_score: Option<f64> = None;
    let mut trace: Vec<BoundarySearchEvent> = Vec::new();
    let ended;
    fn take(best: &mut Option<(BoundaryConfig, f64)>, trace: &mut Vec<BoundarySearchEvent>, evals: u64, config: BoundaryConfig, score: f64, source: &'static str, stage: &'static str) {
        if best.as_ref().is_some_and(|b| !(score < b.1)) {
            return;
        }
        *best = Some((config, score));
        trace.push(BoundarySearchEvent { evals, score, source, stage });
    }
    if let Some(start) = opts.start {
        if let Some(score) = nd_server_rule(problem, cc, start, bound) {
            start_score = Some(score);
            take(&mut best, &mut trace, evals, start.clone(), score, "start", "given");
        }
    }
    let mut hooks = Hooks { problem };
    loop {
        let why = if opts.should_stop.is_some_and(|f| f()) {
            Some(End::Stopped)
        } else if max_seconds.is_some_and(|ms| t0.elapsed().as_secs_f64() > ms) {
            Some(End::Time)
        } else if evals + ND_FINISH_COST > max_evals {
            Some(End::Evals)
        } else {
            None
        };
        if let Some(w) = why {
            ended = w;
            break;
        }
        // k.seeds(rand, 1)[0]: the exact layout (when one is known) and the sequential layout alternate, the exact one first
        let (st, size) = match nd_exact_layout(&problem.polytope, p, &mut rand) {
            Some(b) => b,
            None => nd_sequential_layout(&problem.polytope, p, &mut rand),
        };
        evals += ND_FINISH_COST;
        // the kernel's place: no displacement, so every anchor read into ambient coordinates and back into its own cell's
        let mut placed = State { cells: st.cells.clone(), u: vec![0.0; n * p], r: None };
        for q in 0..p {
            let xs = cc.to_ambient(st.cells[q], &st.u[n * q..n * q + n], size);
            to_local(cc, st.cells[q], &xs, size, &mut placed.u[n * q..n * q + n]);
        }
        let f = match finalize_state(&mut model, &placed, size, &mut hooks, true) {
            Ok(f) => f,
            Err(Halt::Error(e)) => return Err(e),
            Err(Halt::Stop(_)) => unreachable!("the finish does not stop"),
        };
        if let Some((config, score)) = f {
            take(&mut best, &mut trace, evals, config, score, "random", "coarse");
        }
        // the bound is reached: nothing smaller exists
        if best.as_ref().is_some_and(|b| b.1 <= bound * (1.0 + 1e-12)) {
            ended = End::Bound;
            break;
        }
    }
    let (config, score) = match best {
        Some((c, s)) => (Some(c), Some(s)),
        None => (None, None),
    };
    let starts = trace.len();
    Ok(BoundarySearchResult { config, score, evals, ended, trace, start_score, starts })
}
