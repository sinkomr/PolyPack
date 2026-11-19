//! The boundary search for the d-cubes (d = 5..10): the structured starts of the kernel (seeds) finished
//! by its exact finishing, best kept. Port of packages/boundary/src/ncube/search.ts with what it calls
//! of ncube/kernel.ts (seeds, finish, validate), ncube/seeds.ts, ncube/rule.ts and the violation of
//! ncube/model.ts.
//!
//! It is not an optimizer of records: the d-cube problem sets ship without records, and the generic
//! methods run on the kernel for anything more. It exists so that a boundary job on a d-cube problem has
//! an engine with the contract of searchBoundary: seeded, budgeted in evaluations (a finish costs
//! NCUBE_FINISH_COST), stoppable, reproducible from (problem, start, seed, evals) when no clock limit is set.
//!
//! The kernel's finish places the seed's pieces at their anchors with no displacement (walkLong of a zero
//! vector), which is the anchor clamped into its closed cell, and finalizes the result (`finalize_state`
//! with `shrink`). Only the model's `violation` and `pieces` are reached, so only they are ported.

use super::driver::{finalize_state, is_piece_count, validate_at_zero, BoundarySearchEvent, BoundarySearchOptions, BoundarySearchResult, FinalHooks};
use super::model::{Finish, State};
use super::random::Mulberry32;
use super::{End, Halt, Res};
use crate::ncube::bounds::{ncube_bound, ncube_max_p};
use crate::ncube::lattice::{axes_of, embed_cell, ncube_dim, new_budget, realised_words, RealisedOptions};
use crate::ncube::validate::{near_pairs, NCUBE_MAX_WORK};
use crate::types::{BoundaryConfig, BoundaryPiece, BoundaryProblem};
use crate::validate::{validate_boundary_config, ValidateOptions, MAX_S};
use polypack_js::math;
use std::time::Instant;

/// Energy evaluations one finish() costs (a validator call plus 20 to 45 evaluations of the model's rule).
/// packages/boundary/src/ncube/kernel.ts: NCUBE_FINISH_COST
pub const NCUBE_FINISH_COST: u64 = 1000;

/// Search steps one pair of balls may use in the model before the chord stands in for its geodesics.
/// packages/boundary/src/ncube/model.ts: PAIR_WORK
const PAIR_WORK: f64 = 8_000.0;

/// Room the cube layouts get over their exact edge. packages/boundary/src/ncube/seeds.ts: ROOM
const ROOM: f64 = 1.0 + 1e-6;

// ---------------------------------------------------------------- the models (violation and pieces)

/// The pieces of a state, each centre clamped into its closed cell exactly (the validator checks it at tol 0).
/// packages/boundary/src/ncube/model.ts: clampedPieces
fn clamped_pieces(d: usize, st: &State, s: f64) -> Vec<BoundaryPiece> {
    let n = d - 1;
    let h = s * 0.5;
    let mut out = Vec::with_capacity(st.cells.len());
    for i in 0..st.cells.len() {
        let mut u = Vec::with_capacity(n);
        for k in 0..n {
            u.push(math::min(h, math::max(-h, st.u[i * n + k])));
        }
        out.push(BoundaryPiece { cell: st.cells[i], u, q: None });
    }
    out
}

/// Every pair of pieces whose R^d centres are < 1 apart. packages/boundary/src/ncube/model.ts: allPairs
fn all_pairs(d: usize, cells: &[usize], u: &[f64], n: usize, h: f64, p: usize) -> Vec<(usize, usize)> {
    let xs: Vec<Vec<f64>> = (0..p).map(|i| embed_cell(d, cells[i], u, i * n, h)).collect();
    let mut out = Vec::new();
    for i in 0..p {
        for j in (i + 1)..p {
            let mut q = 0.0;
            for t in 0..d {
                q += (xs[i][t] - xs[j][t]) * (xs[i][t] - xs[j][t]);
            }
            if q < 1.0 {
                out.push((i, j));
            }
        }
    }
    out
}

/// packages/boundary/src/ncube/model.ts: NCubeBallModel (the violation and the pieces)
struct NCubeBallModel {
    d: usize,
    n: usize,
    p: usize,
    floor: f64,
}

impl NCubeBallModel {
    fn new(d: usize, p: usize) -> Self {
        NCubeBallModel { d, n: d - 1, p, floor: ncube_bound(d, "ball", p as f64) }
    }
}

impl Finish for NCubeBallModel {
    fn floor(&self) -> f64 {
        self.floor
    }

    /// The largest violation: max(1/2 - clearance, 1 - d) over the pairs of axes and every realised geodesic.
    /// packages/boundary/src/ncube/model.ts: NCubeBallModel.evaluate, with `violation`
    fn violation(&mut self, st: &State, s: f64) -> f64 {
        let (d, n, p) = (self.d, self.n, self.p);
        let h = s / 2.0;
        let u = &st.u;
        let cells = &st.cells;
        let mut worst = f64::NEG_INFINITY;
        // clearance, closed form: one term per pair of axes
        for i in 0..p {
            let o = n * i;
            for a in 0..n {
                let aa = h - u[o + a].abs();
                for b in (a + 1)..n {
                    let ab = h - u[o + b].abs();
                    let cl = (aa * aa + ab * ab).sqrt();
                    if 0.5 - cl > worst {
                        worst = 0.5 - cl;
                    }
                }
            }
        }
        // pairs whose R^d centres are < 1 apart (a geodesic is never shorter than the chord)
        let pairs = if p <= 48 { all_pairs(d, cells, u, n, h, p) } else { near_pairs(d, cells, u, n, h, 1.0) };
        for (i, j) in pairs {
            let mut budget = new_budget(PAIR_WORK);
            match realised_words(d, s, cells[i], u, i * n, cells[j], u, j * n, &mut budget, &RealisedOptions::default()) {
                Ok(found) => {
                    for r in found {
                        let dist = r.len;
                        if 1.0 - dist > worst {
                            worst = 1.0 - dist;
                        }
                    }
                }
                Err(_) => {
                    // a pair buried in each other near the hinges of a container far too small for them: the search for
                    // its geodesics is cut off, and the chord in R^d, a lower bound of every geodesic, stands in for it
                    let xi = embed_cell(d, cells[i], u, i * n, h);
                    let xj = embed_cell(d, cells[j], u, j * n, h);
                    let mut q = 0.0;
                    for t in 0..d {
                        q += (xi[t] - xj[t]) * (xi[t] - xj[t]);
                    }
                    let chord = q.sqrt();
                    worst = math::max(worst, 1.0 - chord);
                }
            }
        }
        worst
    }

    fn pieces(&mut self, st: &State, s: f64) -> Vec<BoundaryPiece> {
        clamped_pieces(self.d, st, s)
    }
}

/// packages/boundary/src/ncube/model.ts: NCubeCubeModel (the violation and the pieces)
struct NCubeCubeModel {
    d: usize,
    n: usize,
    p: usize,
    floor: f64,
    p_cell: Vec<usize>,
    p_cube: Vec<usize>,
    lo_i: Vec<i64>,
    lo_a: Vec<f64>,
    lo_b: Vec<f64>,
    hi_i: Vec<i64>,
    hi_a: Vec<f64>,
    hi_b: Vec<f64>,
    order: Vec<usize>,
}

impl NCubeCubeModel {
    fn new(d: usize, p: usize) -> Self {
        let n = d - 1;
        // no aligned unit cube fits in a cell of edge < 1; and the volume bound P <= 2d s^n
        let floor = ncube_bound(d, "cube", p as f64);
        let max_parts = (n + 1) * p;
        let m = max_parts * n;
        NCubeCubeModel {
            d,
            n,
            p,
            floor,
            p_cell: vec![0; max_parts],
            p_cube: vec![0; max_parts],
            lo_i: vec![0; m],
            lo_a: vec![0.0; m],
            lo_b: vec![0.0; m],
            hi_i: vec![0; m],
            hi_a: vec![0.0; m],
            hi_b: vec![0.0; m],
            order: vec![0; max_parts],
        }
    }

    fn bound(i: &[i64], a: &[f64], b: &[f64], x: usize, u: &[f64]) -> f64 {
        if i[x] < 0 {
            b[x]
        } else {
            a[x] * u[i[x] as usize] + b[x]
        }
    }
}

impl Finish for NCubeCubeModel {
    fn floor(&self) -> f64 {
        self.floor
    }

    /// The largest violation: the second largest crossing depth of a cube, and the overlap of the parts of
    /// distinct cubes in a cell. packages/boundary/src/ncube/model.ts: NCubeCubeModel.build and evaluate, with `violation`
    fn violation(&mut self, st: &State, s: f64) -> f64 {
        let (d, n, p) = (self.d, self.n, self.p);
        let h = s / 2.0;
        let u = &st.u;
        let mut count = 0usize;
        let mut line = f64::NEG_INFINITY;
        let mut dep = vec![0.0f64; n];
        // the slab's bounds per R^d axis
        let mut lo4_i = vec![0i64; d];
        let mut lo4_a = vec![0.0f64; d];
        let mut lo4_b = vec![0.0f64; d];
        let mut hi4_i = vec![0i64; d];
        let mut hi4_a = vec![0.0f64; d];
        let mut hi4_b = vec![0.0f64; d];
        for q in 0..p {
            let c = st.cells[q];
            let i = c >> 1;
            let sg = if c & 1 == 1 { 1.0 } else { -1.0 };
            let ax = axes_of(d, i);
            let o = n * q;
            for k in 0..n {
                dep[k] = u[o + k].abs() + 0.5 - h;
            }
            // the second largest depth: <= 0 exactly when at most one axis crosses
            let mut a1 = f64::NEG_INFINITY;
            let mut b1 = f64::NEG_INFINITY;
            for k in 0..n {
                if dep[k] > a1 {
                    b1 = a1;
                    a1 = dep[k];
                } else if dep[k] > b1 {
                    b1 = dep[k];
                }
            }
            line = math::max(line, b1);
            // the part in the anchor cell
            let a = count;
            count += 1;
            self.p_cell[a] = c;
            self.p_cube[a] = q;
            for k in 0..n {
                let x = n * a + k;
                self.lo_i[x] = (o + k) as i64;
                self.lo_a[x] = 1.0;
                self.lo_b[x] = -0.5;
                self.hi_i[x] = (o + k) as i64;
                self.hi_a[x] = 1.0;
                self.hi_b[x] = 0.5;
                if dep[k] > 0.0 {
                    if u[o + k] > 0.0 {
                        self.hi_i[x] = -1;
                        self.hi_a[x] = 0.0;
                        self.hi_b[x] = h;
                    } else {
                        self.lo_i[x] = -1;
                        self.lo_a[x] = 0.0;
                        self.lo_b[x] = -h;
                    }
                }
            }
            // a slab beyond each crossed face
            for k in 0..n {
                if !(dep[k] > 0.0) {
                    continue;
                }
                let tau = if u[o + k] > 0.0 { 1.0 } else { -1.0 };
                let j = ax[k];
                let c2 = 2 * j + if tau > 0.0 { 1 } else { 0 };
                let ax2 = axes_of(d, j);
                // along the old normal axis i: from the shared ridge x_i = sg h, depth dd = tau u_k + 1/2 - h
                if sg > 0.0 {
                    lo4_i[i] = (o + k) as i64;
                    lo4_a[i] = -tau;
                    lo4_b[i] = 2.0 * h - 0.5;
                    hi4_i[i] = -1;
                    hi4_a[i] = 0.0;
                    hi4_b[i] = h;
                } else {
                    lo4_i[i] = -1;
                    lo4_a[i] = 0.0;
                    lo4_b[i] = -h;
                    hi4_i[i] = (o + k) as i64;
                    hi4_a[i] = tau;
                    hi4_b[i] = 0.5 - 2.0 * h;
                }
                for m in 0..n {
                    if m == k {
                        continue;
                    }
                    let gm = ax[m];
                    let x = n * a + m;
                    lo4_i[gm] = self.lo_i[x];
                    lo4_a[gm] = self.lo_a[x];
                    lo4_b[gm] = self.lo_b[x];
                    hi4_i[gm] = self.hi_i[x];
                    hi4_a[gm] = self.hi_a[x];
                    hi4_b[gm] = self.hi_b[x];
                }
                let b = count;
                count += 1;
                self.p_cell[b] = c2;
                self.p_cube[b] = q;
                for pp in 0..n {
                    let gp = ax2[pp];
                    let x = n * b + pp;
                    self.lo_i[x] = lo4_i[gp];
                    self.lo_a[x] = lo4_a[gp];
                    self.lo_b[x] = lo4_b[gp];
                    self.hi_i[x] = hi4_i[gp];
                    self.hi_a[x] = hi4_a[gp];
                    self.hi_b[x] = hi4_b[gp];
                }
            }
        }
        let mut e = line;
        // parts by cell (counting sort)
        let cc = 2 * d;
        let mut first = vec![0usize; cc + 1];
        for pt in 0..count {
            first[self.p_cell[pt] + 1] += 1;
        }
        for c in 0..cc {
            first[c + 1] += first[c];
        }
        let mut fill: Vec<usize> = first[..cc].to_vec();
        for pt in 0..count {
            let c = self.p_cell[pt];
            self.order[fill[c]] = pt;
            fill[c] += 1;
        }
        for c in 0..cc {
            for x in first[c]..first[c + 1] {
                let a = self.order[x];
                for y in (x + 1)..first[c + 1] {
                    let b = self.order[y];
                    if self.p_cube[a] == self.p_cube[b] {
                        continue;
                    }
                    let mut best = f64::INFINITY;
                    for m in 0..n {
                        let ha = Self::bound(&self.hi_i, &self.hi_a, &self.hi_b, n * a + m, u);
                        let hb = Self::bound(&self.hi_i, &self.hi_a, &self.hi_b, n * b + m, u);
                        let la = Self::bound(&self.lo_i, &self.lo_a, &self.lo_b, n * a + m, u);
                        let lb = Self::bound(&self.lo_i, &self.lo_a, &self.lo_b, n * b + m, u);
                        let ov = math::min(ha, hb) - math::max(la, lb);
                        if ov < best {
                            best = ov;
                        }
                    }
                    e = math::max(e, best);
                }
            }
        }
        e
    }

    fn pieces(&mut self, st: &State, s: f64) -> Vec<BoundaryPiece> {
        clamped_pieces(self.d, st, s)
    }
}

// ---------------------------------------------------------------- the seeds

/// How many pieces each of the 2d cells holds. packages/boundary/src/ncube/seeds.ts: perCell
fn per_cell(d: usize, p: usize, rand: &mut Mulberry32) -> Vec<usize> {
    let c = 2 * d;
    let mut counts = vec![p / c; c];
    let mut cells: Vec<usize> = (0..c).collect();
    for i in 0..(p % c) {
        let j = i + rand.int(c - i);
        cells.swap(i, j);
        counts[cells[i]] += 1;
    }
    counts
}

/// `count` distinct points of the k^n grid of spacing `step` centred at the origin, in random order.
/// packages/boundary/src/ncube/seeds.ts: gridPoints
fn grid_points(n: usize, k: usize, step: f64, count: usize, rand: &mut Mulberry32) -> Vec<Vec<f64>> {
    let total = (k as f64).powi(n as i32) as usize;
    // a Set in insertion order
    let mut picked: Vec<usize> = Vec::new();
    while picked.len() < count {
        let v = rand.int(total);
        if !picked.contains(&v) {
            picked.push(v);
        }
    }
    picked
        .into_iter()
        .map(|idx| {
            let mut p = Vec::with_capacity(n);
            let mut r = idx;
            for _a in 0..n {
                p.push(((r % k) as f64 - (k as f64 - 1.0) / 2.0) * step);
                r /= k;
            }
            p
        })
        .collect()
}

/// The cell layout of P pieces on the d-cube. packages/boundary/src/ncube/seeds.ts: cellLayout
fn cell_layout(d: usize, piece: &str, p: usize, rand: &mut Mulberry32) -> (State, f64) {
    let n = d - 1;
    let c = 2 * d;
    let m = math::ceil(p as f64 / c as f64) as usize;
    let k = math::max(1.0, math::ceil(math::pow(m as f64, 1.0 / n as f64) - 1e-12)) as usize;
    let s: f64;
    // how a cell's points are drawn: 0 grid of unit cubes, 1 centre, 2 diagonal pair, 3 grid of spacing 1
    let local: u8;
    if piece == "cube" {
        s = k as f64 * ROOM;
        local = 0;
    } else if m == 1 {
        s = 1.0;
        local = 1;
    } else if m == 2 {
        s = 1.0 + 1.0 / math::sqrt(n as f64);
        local = 2;
    } else {
        s = k as f64;
        local = 3;
    }
    let counts = per_cell(d, p, rand);
    let mut cells = vec![0usize; p];
    let mut u = vec![0.0; n * p];
    let mut q = 0;
    for cc in 0..c {
        if counts[cc] == 0 {
            continue;
        }
        let pts: Vec<Vec<f64>> = match local {
            0 => grid_points(n, k, s / k as f64, counts[cc], rand),
            1 => vec![vec![0.0; n]],
            2 => {
                let a = (s - 1.0) / 2.0;
                let pt: Vec<f64> = (0..n).map(|_| if rand.next() < 0.5 { -a } else { a }).collect();
                let neg: Vec<f64> = pt.iter().map(|x| -x).collect();
                vec![pt, neg]
            }
            _ => grid_points(n, k, 1.0, counts[cc], rand),
        };
        for i in 0..counts[cc] {
            cells[q] = cc;
            u[n * q..n * q + n].copy_from_slice(&pts[i]);
            q += 1;
        }
    }
    (State { cells, u, r: None }, s)
}

/// The ring cut of P pieces, or None when the layout would not fit with a cross grid of at most 3 per axis.
/// packages/boundary/src/ncube/seeds.ts: ringLayout
fn ring_layout(d: usize, piece: &str, p: usize, rand: &mut Mulberry32) -> Option<(State, f64)> {
    let n = d - 1;
    // two random axes a < b of R^d
    let a = rand.int(d);
    let mut b = rand.int(d - 1);
    if b >= a {
        b += 1;
    }
    let (ra, rb) = if a < b { (a, b) } else { (b, a) };
    let rest: Vec<usize> = (0..d).filter(|&i| i != ra && i != rb).collect();
    let mut best: Option<(usize, f64)> = None;
    for g in 1..=3usize {
        let layers = (g as f64).powi(rest.len() as i32);
        let m = math::ceil(p as f64 / layers);
        let s = math::max(g as f64, m / 4.0);
        if best.is_none_or(|bb| s < bb.1) {
            best = Some((g, s));
        }
    }
    let (g, best_s) = best?;
    let s = best_s * if piece == "cube" { ROOM } else { 1.0 + 1e-9 };
    let h = s / 2.0;
    let layers = (g as f64).powi(rest.len() as i32) as usize;
    let m = math::ceil(p as f64 / layers as f64) as usize;
    let phase = rand.next() * 4.0 * s;
    let mut cells = vec![0usize; p];
    let mut u = vec![0.0; n * p];
    let cross = grid_points(rest.len(), g, if g > 1 { (s - 1.0) / (g as f64 - 1.0) } else { 1.0 }, layers.min(p), rand);
    let mut q = 0usize;
    let mut j = 0usize;
    while j < m && q < p {
        let t = (phase + (j as f64 * 4.0 * s) / m as f64) % (4.0 * s);
        let tt = (t + h) % (4.0 * s);
        let seg = math::floor(tt / s) as i32;
        let off = tt - seg as f64 * s - h;
        // the R^d point: the ring coordinates and the cross coordinates
        for cp in &cross {
            if q >= p {
                break;
            }
            let mut x = vec![0.0f64; d];
            for (i, &axis) in rest.iter().enumerate() {
                x[axis] = cp[i];
            }
            // seg 0: cell (ra, +), moving +rb; seg 1: (rb, +), moving -ra; seg 2: (ra, -), moving -rb; seg 3: (rb, -), moving +ra
            let c: usize;
            match seg {
                0 => {
                    x[ra] = h;
                    x[rb] = off;
                    c = 2 * ra + 1;
                }
                1 => {
                    x[rb] = h;
                    x[ra] = -off;
                    c = 2 * rb + 1;
                }
                2 => {
                    x[ra] = -h;
                    x[rb] = -off;
                    c = 2 * ra;
                }
                _ => {
                    x[rb] = -h;
                    x[ra] = off;
                    c = 2 * rb;
                }
            }
            let ax = axes_of(d, c >> 1);
            cells[q] = c;
            for k in 0..n {
                u[n * q + k] = x[ax[k]];
            }
            q += 1;
        }
        j += 1;
    }
    if q == p {
        Some((State { cells, u, r: None }, s))
    } else {
        None
    }
}

// ---------------------------------------------------------------- the server's rule on the start

/// What is wrong with the form of a d-cube configuration, in the server's words; false when it is well
/// formed. packages/boundary/src/ncube/rule.ts: ncubeFormErrors (for a typed configuration: the types and
/// the cell, the count and the number of coordinates are those of the type)
fn ncube_form_errors(d: usize, p: usize, config: &BoundaryConfig) -> bool {
    let n = d - 1;
    if !(config.s.is_finite() && config.s.abs() <= MAX_S && config.s > 0.0) {
        return true;
    }
    if config.pieces.len() != p {
        return true;
    }
    for pc in &config.pieces {
        if pc.cell >= 2 * d || pc.u.len() != n {
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

/// The server's verdict on a configuration of the problem: its score when valid.
/// packages/boundary/src/ncube/rule.ts: ncubeServerRule
fn ncube_server_rule(problem: &BoundaryProblem, d: usize, config: &BoundaryConfig, bound: f64) -> Option<f64> {
    let max = ncube_max_p(&problem.polytope)? as f64;
    if !(problem.p <= max) {
        return None;
    }
    if ncube_form_errors(d, problem.p as usize, config) {
        return None;
    }
    let s = config.s;
    if s < bound * (1.0 - 1e-9) {
        return None;
    }
    let opts = ValidateOptions { tol: Some(1e-9), max_reasons: Some(20.0), max_work: Some(NCUBE_MAX_WORK), ..Default::default() };
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

/// packages/boundary/src/ncube/search.ts: searchNCube
pub fn search_ncube(problem: &BoundaryProblem, opts: &BoundarySearchOptions) -> Result<BoundarySearchResult, String> {
    if !is_piece_count(problem.p) {
        return Err("ncubeKernel: invalid problem".to_string());
    }
    let p = problem.p as usize;
    let max = ncube_max_p(&problem.polytope).expect("a d-cube");
    if p > max {
        return Err(format!("ncubeKernel: P = {} is above the largest of the {}, {}", p, problem.polytope, max));
    }
    let d = ncube_dim(&problem.polytope);
    let n = d - 1;
    let ball = problem.piece == "ball";
    let mut model: Box<dyn Finish> = if ball { Box::new(NCubeBallModel::new(d, p)) } else { Box::new(NCubeCubeModel::new(d, p)) };
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
    let take = |best: &mut Option<(BoundaryConfig, f64)>, trace: &mut Vec<BoundarySearchEvent>, evals: u64, config: BoundaryConfig, score: f64, source: &'static str, stage: &'static str| {
        if best.as_ref().is_some_and(|b| !(score < b.1)) {
            return;
        }
        *best = Some((config, score));
        trace.push(BoundarySearchEvent { evals, score, source, stage });
    };
    if let Some(start) = opts.start {
        if let Some(score) = ncube_server_rule(problem, d, start, bound) {
            start_score = Some(score);
            take(&mut best, &mut trace, evals, start.clone(), score, "start", "given");
        }
    }
    let mut hooks = Hooks { problem };
    loop {
        // the kernel's stop test: should_stop, then the clock, then the budget
        let why = if opts.should_stop.is_some_and(|f| f()) {
            Some(End::Stopped)
        } else if max_seconds.is_some_and(|ms| t0.elapsed().as_secs_f64() > ms) {
            Some(End::Time)
        } else if evals + NCUBE_FINISH_COST > max_evals {
            Some(End::Evals)
        } else {
            None
        };
        if let Some(w) = why {
            ended = w;
            break;
        }
        // k.seeds(rand, 1)[0]: the ring cut and the cell layout alternate (the ring first); a ball ring is kept
        // only when the validator accepts it
        let mut built = ring_layout(d, &problem.piece, p, &mut rand);
        if let Some((st, s)) = &built {
            if ball {
                let cfg = BoundaryConfig { s: *s, pieces: model.pieces(st, *s) };
                match validate_at_zero(problem, &cfg) {
                    Ok(true) => {}
                    Ok(false) => built = None,
                    Err(Halt::Error(e)) => return Err(e),
                    Err(Halt::Stop(_)) => unreachable!("the validator does not stop"),
                }
            }
        }
        let (st, size) = built.unwrap_or_else(|| cell_layout(d, &problem.piece, p, &mut rand));
        evals += NCUBE_FINISH_COST;
        // the kernel's place: no displacement, so every anchor clamped into its closed cell (walkN of a zero vector)
        let h = size / 2.0;
        let mut placed = st.clone();
        for k in 0..(n * p) {
            placed.u[k] = math::max(-h, math::min(h, st.u[k]));
        }
        let f = match finalize_state(&mut *model, &placed, size, &mut hooks, true) {
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
