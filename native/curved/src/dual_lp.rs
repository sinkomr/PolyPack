//! The step LP of the polish (lp.rs states it) solved by a bounded dual simplex on its primal
//! form, with a sparse basis factorization (basis.rs) and a warm start from the basis of the
//! previous solve. Consecutive polish steps differ a little, so the previous optimal basis is dual
//! feasible or nearly so (costs never change; nonbasic boxed variables are moved to the bound
//! their reduced cost asks for) and a few dual iterations restore primal feasibility.
//!
//! Primal form, m rows (one per constraint), with dz = p - q:
//!   minimise eps sum (p_j + q_j) + d + W sum s_k
//!   subject to G_k (p - q) + g_k d + s_k - u_k = r'_k   (r'_k = margin - value_k - g_k lo)
//!              0 <= p, q <= rho, 0 <= d <= hi - lo, s, u >= 0, and dt = lo + d.
//! Variables: p_j (j < nz), q_j, d, then s_k (column e_k) and u_k (column -e_k).
//!
//! Dual simplex (Koberstein's textbook form): a basic variable outside its bounds leaves at the
//! violated bound; the pivot row alpha_r = rho_r^T A; the entering variable is chosen by the ratio
//! test with bound flipping (boxed candidates whose breakpoints the dual step passes move to their
//! other bound while the slope stays positive); reduced costs, flips and the primal step follow.

use crate::basis::{BasicCol, BasisFactor, SparseCol};
use crate::eval::{Row, NONE};

/// Primal feasibility tolerance (row and bound violations of the solution, in gap units).
const TOL_P: f64 = 1e-14;
/// Dual feasibility tolerance.
const TOL_D: f64 = 1e-13;
/// Smallest pivot element.
const TOL_PIV: f64 = 1e-11;
/// Product-form updates before a new factorization.
const REFACTOR: usize = 40;

#[derive(Clone, Copy, Debug, Default)]
pub struct DualStats {
    pub solves: u64,
    pub iterations: u64,
    pub flips: u64,
    pub warm: u64,
    pub cold: u64,
    pub refactors: u64,
    pub failures: u64,
}

pub struct DualLp {
    m: usize,
    nz: usize,
    /// rows: coefficients of the pose coordinates (CSR) and of d
    row_start: Vec<u32>,
    row_j: Vec<u32>,
    row_v: Vec<f64>,
    row_g: Vec<f64>,
    /// columns of the pose coordinates (CSC, the column of p_j; q_j is its negative), and of d
    col_start: Vec<u32>,
    col_k: Vec<u32>,
    col_v: Vec<f64>,
    rhs: Vec<f64>,
    rho: f64,
    dd: f64,
    w_pen: f64,
    eps: f64,
    /// variable state: value and reduced cost; position in the basis or -1
    x: Vec<f64>,
    d: Vec<f64>,
    pos: Vec<i32>,
    basis: Vec<u32>,
    factor: BasisFactor,
    // scratch
    rho_r: Vec<f64>,
    alpha_r: Vec<f64>,
    touched: Vec<u32>,
    col_buf: Vec<f64>,
    pos_buf: Vec<f64>,
    cand: Vec<(f64, u32)>,
    // warm start: row keys and the basis of the last solve
    keys: Vec<u64>,
    last_keys: Vec<u64>,
    last_basis: Vec<u64>,
    last_upper: Vec<bool>,
    stopped: bool,
    pub stats: DualStats,
}

/// A basic variable described independently of the row order: a structural index, or a logical
/// by its row's key.
const LOGICAL_S: u64 = 1 << 62;
const LOGICAL_U: u64 = 2 << 62;

impl DualLp {
    pub fn new() -> DualLp {
        DualLp {
            m: 0,
            nz: 0,
            row_start: Vec::new(),
            row_j: Vec::new(),
            row_v: Vec::new(),
            row_g: Vec::new(),
            col_start: Vec::new(),
            col_k: Vec::new(),
            col_v: Vec::new(),
            rhs: Vec::new(),
            rho: 0.0,
            dd: 0.0,
            w_pen: 0.0,
            eps: 0.0,
            x: Vec::new(),
            d: Vec::new(),
            pos: Vec::new(),
            basis: Vec::new(),
            factor: BasisFactor::default(),
            rho_r: Vec::new(),
            alpha_r: Vec::new(),
            touched: Vec::new(),
            col_buf: Vec::new(),
            pos_buf: Vec::new(),
            cand: Vec::new(),
            keys: Vec::new(),
            last_keys: Vec::new(),
            last_basis: Vec::new(),
            last_upper: Vec::new(),
            stopped: false,
            stats: DualStats::default(),
        }
    }

    /// Forgets the warm start (a new problem or a new polish).
    pub fn reset(&mut self) {
        self.last_basis.clear();
        self.last_keys.clear();
        self.last_upper.clear();
    }

    #[inline]
    fn nstruct(&self) -> usize {
        2 * self.nz + 1
    }

    #[inline]
    fn s_var(&self, k: usize) -> usize {
        self.nstruct() + k
    }

    #[inline]
    fn u_var(&self, k: usize) -> usize {
        self.nstruct() + self.m + k
    }

    #[inline]
    fn upper(&self, v: usize) -> f64 {
        let ns = self.nstruct();
        if v < 2 * self.nz {
            self.rho
        } else if v < ns {
            self.dd
        } else {
            f64::INFINITY
        }
    }

    #[inline]
    fn cost(&self, v: usize) -> f64 {
        let ns = self.nstruct();
        if v < 2 * self.nz {
            self.eps
        } else if v < ns {
            1.0
        } else if v < ns + self.m {
            self.w_pen
        } else {
            0.0
        }
    }

    /// The column of a variable as a sparse column over rows.
    fn column(&self, v: usize) -> SparseCol {
        let nz = self.nz;
        if v < 2 * nz {
            let (j, sgn) = if v < nz { (v, 1.0) } else { (v - nz, -1.0) };
            (self.col_start[j] as usize..self.col_start[j + 1] as usize)
                .map(|e| (self.col_k[e], sgn * self.col_v[e]))
                .collect()
        } else if v == 2 * nz {
            (0..self.m)
                .filter(|&k| self.row_g[k] != 0.0)
                .map(|k| (k as u32, self.row_g[k]))
                .collect()
        } else if v < self.nstruct() + self.m {
            vec![((v - self.nstruct()) as u32, 1.0)]
        } else {
            vec![((v - self.nstruct() - self.m) as u32, -1.0)]
        }
    }

    /// Adds the column of v times f into a dense vector over rows.
    fn add_column(&self, v: usize, f: f64, out: &mut [f64]) {
        let nz = self.nz;
        if v < 2 * nz {
            let (j, sgn) = if v < nz { (v, f) } else { (v - nz, -f) };
            for e in self.col_start[j] as usize..self.col_start[j + 1] as usize {
                out[self.col_k[e] as usize] += sgn * self.col_v[e];
            }
        } else if v == 2 * nz {
            for k in 0..self.m {
                out[k] += f * self.row_g[k];
            }
        } else if v < self.nstruct() + self.m {
            out[v - self.nstruct()] += f;
        } else {
            out[v - self.nstruct() - self.m] -= f;
        }
    }

    fn basic_col(&self, v: usize) -> BasicCol {
        let ns = self.nstruct();
        if v < ns {
            BasicCol::Structural(v as u32)
        } else if v < ns + self.m {
            BasicCol::Unit {
                row: (v - ns) as u32,
                sign: 1.0,
            }
        } else {
            BasicCol::Unit {
                row: (v - ns - self.m) as u32,
                sign: -1.0,
            }
        }
    }

    /// Factors the current basis, replacing dependent columns by logicals.
    fn refactor(&mut self) {
        self.stats.refactors += 1;
        for _ in 0..4 {
            let cols: Vec<BasicCol> = self.basis.iter().map(|&v| self.basic_col(v as usize)).collect();
            let mut f = std::mem::take(&mut self.factor);
            let dep = {
                let this = &*self;
                let st = |s: u32| this.column(s as usize);
                f.factor(this.m, &cols, &st)
            };
            self.factor = f;
            if dep.is_empty() {
                return;
            }
            for (p, row) in dep {
                let old = self.basis[p as usize] as usize;
                self.pos[old] = -1;
                // the replaced variable goes to the bound its reduced cost asks for (fixed below)
                self.x[old] = 0.0;
                let u = self.u_var(row as usize);
                let nv = if self.pos[u] < 0 { u } else { self.s_var(row as usize) };
                self.basis[p as usize] = nv as u32;
                self.pos[nv] = p as i32;
            }
        }
    }

    /// x_B from the nonbasic values, and the reduced costs from the basis.
    fn recompute(&mut self) {
        let m = self.m;
        let nvar = self.nstruct() + 2 * m;
        // rhs - N x_N
        let mut a = std::mem::take(&mut self.col_buf);
        a.clear();
        a.extend_from_slice(&self.rhs);
        for v in 0..nvar {
            if self.pos[v] < 0 && self.x[v] != 0.0 {
                self.add_column(v, -self.x[v], &mut a);
            }
        }
        let mut xb = std::mem::take(&mut self.pos_buf);
        xb.clear();
        xb.resize(m, 0.0);
        self.factor.ftran(&mut a, &mut xb);
        for r in 0..m {
            self.x[self.basis[r] as usize] = xb[r];
        }
        // pi = B^-T c_B; d = c - A^T pi
        for r in 0..m {
            xb[r] = self.cost(self.basis[r] as usize);
        }
        let mut pi = std::mem::take(&mut self.rho_r);
        pi.resize(m, 0.0);
        self.factor.btran(&mut xb, &mut pi);
        let nz = self.nz;
        for j in 0..nz {
            let mut s = 0.0;
            for e in self.col_start[j] as usize..self.col_start[j + 1] as usize {
                s += self.col_v[e] * pi[self.col_k[e] as usize];
            }
            self.d[j] = self.eps - s;
            self.d[nz + j] = self.eps + s;
        }
        let mut s = 0.0;
        for k in 0..m {
            s += self.row_g[k] * pi[k];
        }
        self.d[2 * nz] = 1.0 - s;
        for k in 0..m {
            let sv = self.s_var(k);
            let uv = self.u_var(k);
            self.d[sv] = self.w_pen - pi[k];
            self.d[uv] = pi[k];
        }
        for r in 0..m {
            self.d[self.basis[r] as usize] = 0.0;
        }
        self.rho_r = pi;
        self.col_buf = a;
        self.pos_buf = xb;
    }

    /// Moves boxed nonbasic variables to the bound their reduced cost asks for; returns the number
    /// of unboxed nonbasic variables whose reduced cost is negative beyond the tolerance.
    fn make_dual_feasible(&mut self) -> usize {
        let nvar = self.nstruct() + 2 * self.m;
        let mut bad = 0;
        for v in 0..nvar {
            if self.pos[v] >= 0 {
                continue;
            }
            let ub = self.upper(v);
            if ub.is_finite() {
                self.x[v] = if self.d[v] < 0.0 { ub } else { 0.0 };
            } else {
                self.x[v] = 0.0;
                if self.d[v] < -TOL_D {
                    bad += 1;
                }
            }
        }
        bad
    }

    /// Solves the step LP; writes dz into step[..nz] and dt into step[nz]. Rows carry their
    /// values and gradients (pose of piece i in variables 3i..3i+2) and `keys` their identities.
    #[allow(clippy::too_many_arguments)]
    pub fn solve(
        &mut self,
        rows: &[Row],
        margin: f64,
        nz: usize,
        rho: f64,
        lo: f64,
        hi: f64,
        w_pen: f64,
        eps: f64,
        step: &mut [f64],
        stop: &mut dyn FnMut() -> bool,
    ) -> bool {
        self.stats.solves += 1;
        let m = rows.len();
        self.m = m;
        self.nz = nz;
        self.rho = rho;
        self.dd = (hi - lo).max(0.0);
        self.w_pen = w_pen;
        self.eps = eps;
        // ---- the problem: rows (CSR), columns (CSC), right-hand sides
        self.row_start.clear();
        self.row_j.clear();
        self.row_v.clear();
        self.row_g.clear();
        self.rhs.clear();
        self.row_start.push(0);
        let mut counts = vec![0u32; nz + 1];
        for r in rows {
            for (piece, g) in [(r.i, r.gi), (r.j, r.gj)] {
                if piece == NONE {
                    continue;
                }
                for a in 0..3 {
                    if g[a] != 0.0 {
                        let j = 3 * piece as usize + a;
                        self.row_j.push(j as u32);
                        self.row_v.push(g[a]);
                        counts[j + 1] += 1;
                    }
                }
            }
            self.row_start.push(self.row_j.len() as u32);
            self.row_g.push(r.gt);
            self.rhs.push((margin - r.value) - r.gt * lo);
        }
        for j in 0..nz {
            counts[j + 1] += counts[j];
        }
        self.col_start.clear();
        self.col_start.extend_from_slice(&counts);
        self.col_k.clear();
        self.col_k.resize(self.row_j.len(), 0);
        self.col_v.clear();
        self.col_v.resize(self.row_j.len(), 0.0);
        let mut fill = counts.clone();
        for k in 0..m {
            for e in self.row_start[k] as usize..self.row_start[k + 1] as usize {
                let j = self.row_j[e] as usize;
                let at = fill[j] as usize;
                self.col_k[at] = k as u32;
                self.col_v[at] = self.row_v[e];
                fill[j] += 1;
            }
        }
        let nvar = self.nstruct() + 2 * m;
        self.x.clear();
        self.x.resize(nvar, 0.0);
        self.d.clear();
        self.d.resize(nvar, 0.0);
        self.pos.clear();
        self.pos.resize(nvar, -1);
        self.basis.clear();
        self.alpha_r.clear();
        self.alpha_r.resize(nvar, 0.0);
        self.touched.clear();
        self.rho_r.resize(m, 0.0);
        self.keys.clear();
        self.keys.extend(rows.iter().map(|r| r.key));
        // ---- starting basis: the previous one mapped through the row keys, else the logicals u
        let warm = !self.last_basis.is_empty() && self.warm_basis();
        if !warm {
            self.basis.clear();
            for k in 0..m {
                let u = self.u_var(k);
                self.basis.push(u as u32);
            }
            for v in self.pos.iter_mut() {
                *v = -1;
            }
            for (r, &v) in self.basis.iter().enumerate() {
                self.pos[v as usize] = r as i32;
            }
            self.stats.cold += 1;
        } else {
            self.stats.warm += 1;
        }
        self.refactor();
        // nonbasic at their lower bounds (the warm basis's statuses are set by make_dual_feasible)
        self.recompute();
        if self.make_dual_feasible() > 0 && warm {
            // the warm basis is not dual feasible in an unboxed variable: start cold
            self.stats.failures += 1;
            self.last_basis.clear();
            return self.solve(rows, margin, nz, rho, lo, hi, w_pen, eps, step, stop);
        }
        self.recompute();
        self.stopped = false;
        let ok = self.iterate(stop);
        if !ok && warm && !self.stopped {
            self.stats.failures += 1;
            self.last_basis.clear();
            return self.solve(rows, margin, nz, rho, lo, hi, w_pen, eps, step, stop);
        }
        // ---- the step
        for j in 0..nz {
            step[j] = (self.x[j] - self.x[nz + j]).clamp(-rho, rho);
        }
        step[nz] = lo + self.x[2 * nz].clamp(0.0, self.dd);
        // remember the basis for the next solve
        self.last_keys.clear();
        self.last_keys.extend_from_slice(&self.keys);
        self.last_basis.clear();
        let ns = self.nstruct();
        for &v in &self.basis {
            let v = v as usize;
            let key = if v < ns {
                v as u64
            } else if v < ns + m {
                LOGICAL_S | (v - ns) as u64
            } else {
                LOGICAL_U | (v - ns - m) as u64
            };
            self.last_basis.push(key);
        }
        if !ok {
            self.stats.failures += 1;
            self.last_basis.clear();
        }
        ok
    }

    /// The previous basis on the current rows: structurals as they were, logicals of rows that
    /// still exist (matched by key), logicals u for the new rows; true when it has m columns.
    fn warm_basis(&mut self) -> bool {
        let m = self.m;
        let ns = self.nstruct();
        // previous row index by key -> current row index
        let mut by_key: Vec<(u64, u32)> = self.keys.iter().enumerate().map(|(k, &key)| (key, k as u32)).collect();
        by_key.sort_unstable();
        let find = |key: u64| {
            by_key
                .binary_search_by(|e| e.0.cmp(&key))
                .ok()
                .map(|i| by_key[i].1 as usize)
        };
        let mut covered = vec![false; m];
        self.basis.clear();
        for &b in &self.last_basis {
            if b & (3 << 62) == 0 {
                let v = b as usize;
                if v < ns {
                    self.basis.push(v as u32);
                }
            } else {
                let old_row = (b & ((1 << 62) - 1)) as usize;
                let Some(&key) = self.last_keys.get(old_row) else {
                    continue;
                };
                let Some(k) = find(key) else { continue };
                if covered[k] {
                    continue;
                }
                covered[k] = true;
                let v = if b & (3 << 62) == LOGICAL_S {
                    self.s_var(k)
                } else {
                    self.u_var(k)
                };
                self.basis.push(v as u32);
            }
        }
        for k in 0..m {
            if !covered[k] {
                self.basis.push(self.u_var(k) as u32);
            }
        }
        // too many columns (rows disappeared under basic structurals): drop the last structurals
        while self.basis.len() > m {
            let Some(at) = self.basis.iter().rposition(|&v| (v as usize) < ns) else {
                return false;
            };
            self.basis.remove(at);
        }
        if self.basis.len() != m {
            return false;
        }
        for (r, &v) in self.basis.iter().enumerate() {
            self.pos[v as usize] = r as i32;
        }
        true
    }

    /// Dual simplex iterations from a dual feasible basis. False on failure (iteration limit,
    /// numerical trouble); the values are then those of the last basis.
    fn iterate(&mut self, stop: &mut dyn FnMut() -> bool) -> bool {
        let m = self.m;
        let nvar = self.nstruct() + 2 * m;
        let max_iter = 50 * m + 1000;
        let mut alpha_q = vec![0.0; m];
        let mut since_check = 0;
        for it in 0..max_iter {
            if it % 32 == 31 && stop() {
                self.stopped = true;
                return false;
            }
            if self.factor.etas() >= REFACTOR {
                self.refactor();
                self.recompute();
                if self.make_dual_feasible() > 0 {
                    return false;
                }
                self.recompute();
            }
            // ---- leaving row: the largest bound violation (dual steepest edge took more iterations
            // on these programs)
            let mut r = usize::MAX;
            let mut worst = TOL_P;
            let mut delta = 0.0;
            for p in 0..m {
                let v = self.basis[p] as usize;
                let xv = self.x[v];
                let ub = self.upper(v);
                let (viol, dl) = if xv < -TOL_P {
                    (-xv, xv)
                } else if xv > ub + TOL_P * ub.max(1.0) {
                    (xv - ub, xv - ub)
                } else {
                    (0.0, 0.0)
                };
                if viol > worst {
                    worst = viol;
                    r = p;
                    delta = dl;
                }
            }
            if r == usize::MAX {
                // optimal by the maintained values: check with values recomputed from the basis
                if since_check == 0 {
                    return true;
                }
                since_check = 0;
                self.recompute();
                if self.make_dual_feasible() > 0 {
                    return false;
                }
                self.recompute();
                continue;
            }
            since_check += 1;
            let leaving = self.basis[r] as usize;
            // ---- rho_r = B^-T e_r, alpha_r = rho_r^T A over the nonbasic variables
            let mut e = std::mem::take(&mut self.pos_buf);
            e.clear();
            e.resize(m, 0.0);
            e[r] = 1.0;
            let mut rho_r = std::mem::take(&mut self.rho_r);
            rho_r.resize(m, 0.0);
            self.factor.btran(&mut e, &mut rho_r);
            self.pos_buf = e;
            for &v in &self.touched {
                self.alpha_r[v as usize] = 0.0;
            }
            self.touched.clear();
            let nz = self.nz;
            let mut ad = 0.0;
            for k in 0..m {
                let rk = rho_r[k];
                if rk == 0.0 {
                    continue;
                }
                for e in self.row_start[k] as usize..self.row_start[k + 1] as usize {
                    let j = self.row_j[e] as usize;
                    if self.alpha_r[j] == 0.0 {
                        self.touched.push(j as u32);
                    }
                    self.alpha_r[j] += rk * self.row_v[e];
                    if self.alpha_r[j] == 0.0 {
                        // keep it recognisable as touched
                        self.alpha_r[j] = f64::MIN_POSITIVE;
                    }
                }
                ad += rk * self.row_g[k];
                let sv = self.s_var(k);
                let uv = self.u_var(k);
                self.alpha_r[sv] = rk;
                self.alpha_r[uv] = -rk;
                self.touched.push(sv as u32);
                self.touched.push(uv as u32);
            }
            let ntouched = self.touched.len();
            for t in 0..ntouched {
                let j = self.touched[t] as usize;
                if j < nz {
                    self.alpha_r[nz + j] = -self.alpha_r[j];
                    self.touched.push((nz + j) as u32);
                }
            }
            self.alpha_r[2 * nz] = ad;
            self.touched.push((2 * nz) as u32);
            self.rho_r = rho_r;
            // ---- ratio test with bound flipping. alpha~ = -alpha when the leaving variable is below its bound
            let sgn = if delta < 0.0 { -1.0 } else { 1.0 };
            self.cand.clear();
            for &v in &self.touched {
                let v = v as usize;
                if self.pos[v] >= 0 {
                    continue;
                }
                let a = sgn * self.alpha_r[v];
                if a.abs() <= TOL_PIV {
                    continue;
                }
                let at_upper = self.x[v] > 0.0 && self.x[v] == self.upper(v);
                if (!at_upper && a > 0.0) || (at_upper && a < 0.0) {
                    let ratio = (self.d[v] / a).max(0.0);
                    self.cand.push((ratio, v as u32));
                }
            }
            if self.cand.is_empty() {
                // dual unbounded: the primal is infeasible, which the elastic rows exclude
                return false;
            }
            // candidates in increasing ratio, extracted one at a time (few are passed per
            // iteration), the rest sorted once more than 8 have been passed; the last one enters
            let less = |a: &(f64, u32), b: &(f64, u32)| a.0 < b.0 || (a.0 == b.0 && a.1 < b.1);
            let mut slope = delta.abs();
            let mut flips_end = 0;
            let len = self.cand.len();
            let enter;
            loop {
                if flips_end == 8 {
                    self.cand[flips_end..].sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                }
                if flips_end < 8 {
                    let mut bi = flips_end;
                    for i in flips_end + 1..len {
                        if less(&self.cand[i], &self.cand[bi]) {
                            bi = i;
                        }
                    }
                    self.cand.swap(flips_end, bi);
                }
                let v = self.cand[flips_end].1 as usize;
                let ub = self.upper(v);
                let a = self.alpha_r[v].abs();
                if ub.is_finite() && flips_end + 1 < len && slope - a * ub > 0.0 {
                    slope -= a * ub;
                    flips_end += 1;
                    continue;
                }
                enter = v;
                break;
            }
            let mut enter = enter;
            // among candidates tied with the entering ratio, the largest pivot
            let eratio = self.cand[flips_end].0;
            let mut best_a = self.alpha_r[enter].abs();
            let mut best_at = flips_end;
            for idx in flips_end + 1..self.cand.len() {
                let (ratio, v) = self.cand[idx];
                if ratio > eratio + 1e-12 * (1.0 + eratio) {
                    continue;
                }
                let a = self.alpha_r[v as usize].abs();
                if a > best_a {
                    best_a = a;
                    best_at = idx;
                }
            }
            if best_at != flips_end {
                self.cand.swap(flips_end, best_at);
                enter = self.cand[flips_end].1 as usize;
            }
            // ---- dual update: d_j -= theta_D alpha_rj
            let theta_d = self.d[enter] / self.alpha_r[enter];
            for &v in &self.touched {
                let v = v as usize;
                if self.pos[v] < 0 {
                    self.d[v] -= theta_d * self.alpha_r[v];
                }
            }
            self.d[enter] = 0.0;
            self.d[leaving] = -theta_d;
            // ---- bound flips: x_B -= B^-1 (sum a_j dx_j)
            if flips_end > 0 {
                let mut a = std::mem::take(&mut self.col_buf);
                a.clear();
                a.resize(m, 0.0);
                for idx in 0..flips_end {
                    let v = self.cand[idx].1 as usize;
                    let ub = self.upper(v);
                    let dx = if self.x[v] == 0.0 { ub } else { -ub };
                    self.x[v] += dx;
                    self.add_column(v, dx, &mut a);
                }
                let mut dxb = std::mem::take(&mut self.pos_buf);
                dxb.clear();
                dxb.resize(m, 0.0);
                self.factor.ftran(&mut a, &mut dxb);
                for p in 0..m {
                    self.x[self.basis[p] as usize] -= dxb[p];
                }
                self.pos_buf = dxb;
                self.col_buf = a;
                self.stats.flips += flips_end as u64;
            }
            // ---- entering column alpha_q = B^-1 a_q and the primal step
            let mut a = std::mem::take(&mut self.col_buf);
            a.clear();
            a.resize(m, 0.0);
            self.add_column(enter, 1.0, &mut a);
            self.factor.ftran(&mut a, &mut alpha_q);
            self.col_buf = a;
            let piv = alpha_q[r];
            if piv.abs() < TOL_PIV {
                // the row and the column disagree: refactor and try again
                self.refactor();
                self.recompute();
                if self.make_dual_feasible() > 0 {
                    return false;
                }
                self.recompute();
                continue;
            }
            let xl = self.x[leaving];
            let bound = if delta < 0.0 { 0.0 } else { self.upper(leaving) };
            let theta_p = (xl - bound) / piv;
            for p in 0..m {
                if alpha_q[p] != 0.0 {
                    let v = self.basis[p] as usize;
                    self.x[v] -= theta_p * alpha_q[p];
                }
            }
            self.x[enter] += theta_p;
            self.x[leaving] = bound;
            // ---- basis change
            self.pos[leaving] = -1;
            self.pos[enter] = r as i32;
            self.basis[r] = enter as u32;
            self.factor.update(r, &alpha_q);
            self.stats.iterations += 1;
            let _ = nvar;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lp::LpSolver;

    fn row(i: u32, j: u32, value: f64, gi: [f64; 3], gj: [f64; 3], gt: f64) -> Row {
        Row {
            i,
            j,
            value,
            gi,
            gj,
            gt,
            key: 0,
        }
    }

    /// The dual simplex and the dense tableau solve the same random step LPs to the same objective.
    #[test]
    fn agrees_with_the_tableau() {
        let mut rng = crate::rng::Rng::new(9);
        let mut dense = LpSolver::new();
        let mut dual = DualLp::new();
        for trial in 0..200 {
            // three problems of the same size in a row: the second and third start warm (from an
            // unrelated basis, which must still give the optimum)
            let p = 2 + (trial / 3) % 7;
            let nz = 3 * p;
            let m = 1 + (rng.next_f64() * 3.0 * p as f64) as usize;
            let mut rows: Vec<Row> = (0..m)
                .map(|_| {
                    let i = (rng.next_f64() * p as f64) as u32;
                    let mut j = (rng.next_f64() * p as f64) as u32;
                    if j == i || rng.next_f64() < 0.3 {
                        j = NONE;
                    }
                    let g = |rng: &mut crate::rng::Rng| {
                        [rng.next_f64() - 0.5, rng.next_f64() - 0.5, 0.3 * (rng.next_f64() - 0.5)]
                    };
                    let gi = g(&mut rng);
                    let gj = if j == NONE { [0.0; 3] } else { g(&mut rng) };
                    let gt = if j == NONE { 0.5 + rng.next_f64() } else { 0.0 };
                    row(i, j, (rng.next_f64() - 0.6) * 0.05, gi, gj, gt)
                })
                .collect();
            for (k, r) in rows.iter_mut().enumerate() {
                r.key = k as u64;
            }
            let rho = 0.01 + 0.05 * rng.next_f64();
            let (lo, hi) = (-rho, rho);
            let mut s1 = vec![0.0; nz + 1];
            let mut s2 = vec![0.0; nz + 1];
            dense.solve(&rows, 0.0, nz, rho, lo, hi, 1e3, 1e-7, &mut s1, &mut || false);
            if trial % 3 == 0 {
                dual.reset();
            }
            assert!(
                dual.solve(&rows, 0.0, nz, rho, lo, hi, 1e3, 1e-7, &mut s2, &mut || false),
                "trial {trial}"
            );
            let obj = |s: &[f64]| {
                let mut o = s[nz] + 1e-7 * s[..nz].iter().map(|v| v.abs()).sum::<f64>();
                for r in &rows {
                    let mut lin = r.value + r.gt * s[nz];
                    for a in 0..3 {
                        lin += r.gi[a] * s[3 * r.i as usize + a];
                        if r.j != NONE {
                            lin += r.gj[a] * s[3 * r.j as usize + a];
                        }
                    }
                    o += 1e3 * (-lin).max(0.0);
                }
                o
            };
            let (o1, o2) = (obj(&s1), obj(&s2));
            assert!(
                (o1 - o2).abs() < 1e-9 * (1.0 + o1.abs()),
                "trial {trial}: tableau {o1} dual {o2}"
            );
        }
        assert!(dual.stats.warm > 0);
    }
}
