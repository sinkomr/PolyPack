//! The linear program of one polish step (packages/curved/src/polish.ts lpStep), solved through
//! its dual.
//!
//! Primal (P), over the pose steps dz (3P values) and the container step dt:
//!   minimise dt + eps sum_j |dz_j| + W sum_k s_k
//!   subject to G_k . dz + g_k dt + s_k >= r_k (r_k = margin - value_k), s_k >= 0,
//!              |dz_j| <= rho, lo <= dt <= hi.
//! The reference solves (P) with a dense simplex whose basis has one row per constraint (m rows,
//! about ten per piece). Its dual has one row per variable of (P) instead (3P + 1 rows, with m
//! columns), so this module runs a bounded primal simplex on the dual:
//!
//! (D) with dt = lo + d, d in [0, D], D = hi - lo, r'_k = r_k - g_k lo:
//!   minimise -sum_k r'_k lambda_k + rho sum_j (alpha_j + beta_j) + D gamma
//!   subject to row j < 3P:  sum_k G_kj lambda_k - alpha_j + beta_j + tau_j = eps
//!              row 3P:      sum_k g_k lambda_k - gamma + sigma = 1
//!              0 <= lambda_k <= W, 0 <= tau_j <= 2 eps, alpha, beta, gamma, sigma >= 0.
//! (alpha_j and beta_j price the box |dz_j| <= rho, tau_j the kink of eps |dz_j|.) The slack basis
//! (tau, sigma) is feasible, so no first phase is needed, and the duals pi of (D) are the primal
//! step: dz_j = -pi_j, d = -pi_3P (the reduced cost of tau_j is dz_j, that of lambda_k the
//! linearised row k less r'_k). The tableau keeps the columns of lambda and the identity block
//! (B^-1); alpha, beta and gamma are virtual columns, the negatives or copies of tau's and sigma's.
//! At the end pi is computed from B^-1 with a step of iterative refinement and the reduced costs
//! are recomputed from the data, so that an inaccurate tableau cannot end the solve early.

use crate::eval::{Row, NONE};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LpStatus {
    Optimal,
    IterationLimit,
}

/// Work counts of one solve.
#[derive(Clone, Copy, Debug, Default)]
pub struct LpStats {
    pub pivots: u64,
    /// tableau entries updated
    pub work: u64,
    pub flips: u64,
    pub degenerate: u64,
    pub solves: u64,
    /// entering variables by kind: lambda, tau/sigma, alpha/gamma, beta
    pub entered: [u64; 4],
}

pub struct LpSolver {
    t: Vec<f64>,
    xb: Vec<f64>,
    basis: Vec<u32>,
    pos: Vec<i32>,
    at_upper: Vec<bool>,
    d: Vec<f64>,
    c_lam: Vec<f64>,
    aq: Vec<f64>,
    prow: Vec<f64>,
    nzl: Vec<u32>,
    pi: Vec<f64>,
    res: Vec<f64>,
    pub stats: LpStats,
}

#[derive(Clone, Copy)]
enum Var {
    Lam(usize),
    Tau(usize),
    Alp(usize),
    Bet(usize),
}

/// Dual feasibility tolerance (in gap units: a row of (P) may be violated by this much).
const TOL_D: f64 = 1e-14;
/// Smallest pivot element.
const TOL_P: f64 = 1e-11;

/// The entering variable chosen so far.
struct Candidate {
    var: usize,
    dir: f64,
    score: f64,
    bland: bool,
}

impl Candidate {
    #[inline]
    fn offer(&mut self, var: usize, dir: f64, score: f64) {
        if self.bland {
            if var < self.var {
                self.var = var;
                self.dir = dir;
            }
        } else if score > self.score {
            self.score = score;
            self.var = var;
            self.dir = dir;
        }
    }
}

impl LpSolver {
    pub fn new() -> LpSolver {
        LpSolver {
            t: Vec::new(),
            xb: Vec::new(),
            basis: Vec::new(),
            pos: Vec::new(),
            at_upper: Vec::new(),
            d: Vec::new(),
            c_lam: Vec::new(),
            aq: Vec::new(),
            prow: Vec::new(),
            nzl: Vec::new(),
            pi: Vec::new(),
            res: Vec::new(),
            stats: LpStats::default(),
        }
    }

    /// Solves the step LP for `rows` (values and gradients at the current point; the pose of
    /// piece i owns variables 3i..3i+2, dt the last one). Writes dz into step[..nz] and dt into
    /// step[nz]. `stop` is polled every few pivots; true ends the solve with the current basis.
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
    ) -> LpStatus {
        let m = rows.len();
        let rr = nz + 1;
        let cc = m + rr;
        let dd = (hi - lo).max(0.0);
        let nvar = m + 2 * rr + nz;
        self.t.clear();
        self.t.resize(rr * cc, 0.0);
        self.c_lam.clear();
        for (k, r) in rows.iter().enumerate() {
            let i = r.i as usize;
            for a in 0..3 {
                self.t[(3 * i + a) * cc + k] = r.gi[a];
            }
            if r.j != NONE {
                let j = r.j as usize;
                for a in 0..3 {
                    self.t[(3 * j + a) * cc + k] = r.gj[a];
                }
            }
            self.t[nz * cc + k] = r.gt;
            // cost of lambda_k: -(r_k - g_k lo), r_k = margin - value_k
            self.c_lam.push(-((margin - r.value) - r.gt * lo));
        }
        for j in 0..rr {
            self.t[j * cc + m + j] = 1.0;
        }
        self.xb.clear();
        self.xb.resize(rr, eps);
        self.xb[nz] = 1.0;
        self.basis.clear();
        self.basis.extend((0..rr).map(|j| (m + j) as u32));
        self.pos.clear();
        self.pos.resize(nvar, -1);
        for j in 0..rr {
            self.pos[m + j] = j as i32;
        }
        self.at_upper.clear();
        self.at_upper.resize(m + rr, false);
        self.d.clear();
        self.d.extend_from_slice(&self.c_lam);
        self.d.resize(cc, 0.0);
        self.aq.resize(rr, 0.0);
        self.prow.resize(cc, 0.0);
        self.pi.resize(rr, 0.0);
        self.res.resize(rr, 0.0);

        let kind = |v: usize| -> Var {
            if v < m {
                Var::Lam(v)
            } else if v < m + rr {
                Var::Tau(v - m)
            } else if v < m + 2 * rr {
                Var::Alp(v - m - rr)
            } else {
                Var::Bet(v - m - 2 * rr)
            }
        };
        let cost = |c_lam: &[f64], v: usize| -> f64 {
            match kind(v) {
                Var::Lam(k) => c_lam[k],
                Var::Tau(_) => 0.0,
                Var::Alp(j) => {
                    if j < nz {
                        rho
                    } else {
                        dd
                    }
                }
                Var::Bet(_) => rho,
            }
        };
        // bounds (lower is 0 for every variable)
        let upper = |v: usize| -> f64 {
            match kind(v) {
                Var::Lam(_) => w_pen,
                Var::Tau(j) => {
                    if j < nz {
                        2.0 * eps
                    } else {
                        f64::INFINITY
                    }
                }
                _ => f64::INFINITY,
            }
        };
        // stored column and sign of a variable's column
        let column = |v: usize| -> (usize, f64) {
            match kind(v) {
                Var::Lam(k) => (k, 1.0),
                Var::Tau(j) => (m + j, 1.0),
                Var::Alp(j) => (m + j, -1.0),
                Var::Bet(j) => (m + j, 1.0),
            }
        };

        let max_pivots = 10 * rr as u64 + 2000;
        let mut pivots = 0u64;
        let mut degenerate = 0u32;
        let mut status = LpStatus::Optimal;
        let mut refreshes = 0;
        loop {
            if pivots >= max_pivots || (pivots % 16 == 15 && stop()) {
                status = LpStatus::IterationLimit;
                break;
            }
            // ---- pricing: Dantzig (the largest reduced cost), Bland's
            // first candidate when degenerate
            let bland = degenerate > 50;
            let mut cand = Candidate {
                var: usize::MAX,
                dir: 0.0,
                score: 0.0,
                bland,
            };
            for k in 0..m {
                if self.pos[k] >= 0 {
                    continue;
                }
                let dk = self.d[k];
                if !self.at_upper[k] && dk < -TOL_D {
                    cand.offer(k, 1.0, -dk);
                } else if self.at_upper[k] && dk > TOL_D {
                    cand.offer(k, -1.0, dk);
                }
            }
            for j in 0..rr {
                let dt_ = self.d[m + j];
                let tau = m + j;
                if self.pos[tau] < 0 {
                    if !self.at_upper[tau] && dt_ < -TOL_D {
                        cand.offer(tau, 1.0, -dt_);
                    } else if self.at_upper[tau] && dt_ > TOL_D {
                        cand.offer(tau, -1.0, dt_);
                    }
                }
                let alp = m + rr + j;
                if self.pos[alp] < 0 {
                    let da = (if j < nz { rho } else { dd }) - dt_;
                    if da < -TOL_D {
                        cand.offer(alp, 1.0, -da);
                    }
                }
                if j < nz {
                    let bet = m + 2 * rr + j;
                    if self.pos[bet] < 0 {
                        let db = rho + dt_;
                        if db < -TOL_D {
                            cand.offer(bet, 1.0, -db);
                        }
                    }
                }
            }
            let (enter, enter_dir) = (cand.var, cand.dir);
            if enter == usize::MAX {
                // optimal by the maintained reduced costs: recompute them from the data and look again
                self.compute_pi(rows, m, nz, rr, cc, &cost);
                if refreshes >= 3 {
                    break;
                }
                refreshes += 1;
                let mut changed = false;
                for k in 0..m {
                    let r = &rows[k];
                    let mut s = self.c_lam[k] - r.gt * self.pi[nz];
                    let i = r.i as usize;
                    for a in 0..3 {
                        s -= r.gi[a] * self.pi[3 * i + a];
                    }
                    if r.j != NONE {
                        let j = r.j as usize;
                        for a in 0..3 {
                            s -= r.gj[a] * self.pi[3 * j + a];
                        }
                    }
                    if self.pos[k] < 0 && ((!self.at_upper[k] && s < -TOL_D) || (self.at_upper[k] && s > TOL_D)) {
                        changed = true;
                    }
                    self.d[k] = if self.pos[k] >= 0 { 0.0 } else { s };
                }
                for j in 0..rr {
                    self.d[m + j] = if self.pos[m + j] >= 0 { 0.0 } else { -self.pi[j] };
                }
                if !changed {
                    // the virtual columns' prices follow from tau's and sigma's
                    let mut any = false;
                    for j in 0..rr {
                        let dt_ = self.d[m + j];
                        let tau = m + j;
                        if self.pos[tau] < 0
                            && ((!self.at_upper[tau] && dt_ < -TOL_D) || (self.at_upper[tau] && dt_ > TOL_D))
                        {
                            any = true;
                        }
                        if self.pos[m + rr + j] < 0 && (if j < nz { rho } else { dd }) - dt_ < -TOL_D {
                            any = true;
                        }
                        if j < nz && self.pos[m + 2 * rr + j] < 0 && rho + dt_ < -TOL_D {
                            any = true;
                        }
                    }
                    if !any {
                        break;
                    }
                }
                continue;
            }
            // ---- entering column a_q = B^-1 A_q
            let (scol, sign) = column(enter);
            for r in 0..rr {
                self.aq[r] = sign * self.t[r * cc + scol];
            }
            let dq = match kind(enter) {
                Var::Lam(k) => self.d[k],
                Var::Tau(j) => self.d[m + j],
                Var::Alp(j) => (if j < nz { rho } else { dd }) - self.d[m + j],
                Var::Bet(j) => rho + self.d[m + j],
            };
            // ---- ratio test: basic r moves by -dir theta aq[r]; among (nearly) tied rows the
            // largest pivot, or Bland's smallest variable index when degenerate
            let range = upper(enter);
            let mut theta = range;
            let mut leave = usize::MAX;
            let mut leave_up = false;
            let mut leave_size = 0.0;
            for r in 0..rr {
                let delta = enter_dir * self.aq[r];
                let (ratio, up) = if delta > TOL_P {
                    (self.xb[r].max(0.0) / delta, false)
                } else if delta < -TOL_P {
                    let ub = upper(self.basis[r] as usize);
                    if !ub.is_finite() {
                        continue;
                    }
                    ((ub - self.xb[r]).max(0.0) / -delta, true)
                } else {
                    continue;
                };
                let choose = if leave == usize::MAX {
                    ratio < theta
                } else if bland {
                    ratio < theta || (ratio == theta && self.basis[r] < self.basis[leave])
                } else {
                    ratio < theta * (1.0 - 1e-12) || (ratio <= theta * (1.0 + 1e-12) && delta.abs() > leave_size)
                };
                if choose {
                    theta = ratio;
                    leave = r;
                    leave_up = up;
                    leave_size = delta.abs();
                }
            }
            if !theta.is_finite() {
                // unbounded: (P) is feasible, so this is a numerical failure; stop with what we have
                status = LpStatus::IterationLimit;
                break;
            }
            self.stats.entered[match kind(enter) {
                Var::Lam(_) => 0,
                Var::Tau(_) => 1,
                Var::Alp(_) => 2,
                Var::Bet(_) => 3,
            }] += 1;
            if theta < 1e-14 {
                degenerate += 1;
                self.stats.degenerate += 1;
            } else {
                degenerate = 0;
            }
            pivots += 1;
            let start = if (enter < m + rr) && self.at_upper[enter] {
                range
            } else {
                0.0
            };
            if leave == usize::MAX || (range.is_finite() && theta >= range) {
                // bound flip of the entering variable
                self.stats.flips += 1;
                for r in 0..rr {
                    self.xb[r] -= enter_dir * range * self.aq[r];
                }
                self.at_upper[enter] = !self.at_upper[enter];
                continue;
            }
            for r in 0..rr {
                if r != leave {
                    self.xb[r] -= enter_dir * theta * self.aq[r];
                }
            }
            let leaving = self.basis[leave] as usize;
            self.pos[leaving] = -1;
            if leaving < m + rr {
                self.at_upper[leaving] = leave_up;
            }
            self.xb[leave] = start + enter_dir * theta;
            self.basis[leave] = enter as u32;
            self.pos[enter] = leave as i32;
            if enter < m + rr {
                self.at_upper[enter] = false;
            }
            // ---- pivot on (leave, scol)
            let piv = self.aq[leave];
            let base = leave * cc;
            self.nzl.clear();
            for j in 0..cc {
                let v = self.t[base + j] / piv;
                self.prow[j] = v;
                self.t[base + j] = v;
                if v != 0.0 {
                    self.nzl.push(j as u32);
                }
            }
            let dense = self.nzl.len() * 3 > cc;
            for r in 0..rr {
                if r == leave {
                    continue;
                }
                let f = self.aq[r];
                if f == 0.0 {
                    continue;
                }
                let row = &mut self.t[r * cc..r * cc + cc];
                if dense {
                    for (x, p) in row.iter_mut().zip(self.prow.iter()) {
                        *x -= f * p;
                    }
                } else {
                    for &j in &self.nzl {
                        let j = j as usize;
                        row[j] -= f * self.prow[j];
                    }
                }
                // the entering column becomes a unit column exactly
                row[scol] = 0.0;
                self.stats.work += if dense { cc as u64 } else { self.nzl.len() as u64 };
            }
            for &j in &self.nzl {
                let j = j as usize;
                self.d[j] -= dq * self.prow[j];
            }
            self.d[scol] = match kind(enter) {
                Var::Lam(_) | Var::Tau(_) => 0.0,
                Var::Alp(j) => {
                    if j < nz {
                        rho
                    } else {
                        dd
                    }
                }
                Var::Bet(_) => -rho,
            };
        }
        if status == LpStatus::IterationLimit {
            self.compute_pi(rows, m, nz, rr, cc, &cost);
        }
        self.stats.pivots += pivots;
        self.stats.solves += 1;
        for j in 0..nz {
            step[j] = (-self.pi[j]).clamp(-rho, rho);
        }
        step[nz] = lo + (-self.pi[nz]).clamp(0.0, dd);
        status
    }

    /// pi = c_B^T B^-1 from the identity block of the tableau, with two steps of iterative
    /// refinement against the original columns.
    fn compute_pi(
        &mut self,
        rows: &[Row],
        m: usize,
        nz: usize,
        rr: usize,
        cc: usize,
        cost: &dyn Fn(&[f64], usize) -> f64,
    ) {
        for v in self.pi.iter_mut() {
            *v = 0.0;
        }
        for r in 0..rr {
            let cb = cost(&self.c_lam, self.basis[r] as usize);
            if cb == 0.0 {
                continue;
            }
            let row = &self.t[r * cc + m..r * cc + m + rr];
            for (p, b) in self.pi.iter_mut().zip(row.iter()) {
                *p += cb * b;
            }
        }
        for _ in 0..2 {
            let mut worst = 0.0f64;
            for r in 0..rr {
                let v = self.basis[r] as usize;
                let a_dot_pi = if v < m {
                    let row = &rows[v];
                    let i = row.i as usize;
                    let mut s = row.gt * self.pi[nz];
                    for a in 0..3 {
                        s += row.gi[a] * self.pi[3 * i + a];
                    }
                    if row.j != NONE {
                        let j = row.j as usize;
                        for a in 0..3 {
                            s += row.gj[a] * self.pi[3 * j + a];
                        }
                    }
                    s
                } else if v < m + rr {
                    self.pi[v - m]
                } else if v < m + 2 * rr {
                    -self.pi[v - m - rr]
                } else {
                    self.pi[v - m - 2 * rr]
                };
                self.res[r] = cost(&self.c_lam, v) - a_dot_pi;
                worst = worst.max(self.res[r].abs());
            }
            if worst < 1e-17 {
                break;
            }
            for r in 0..rr {
                let e = self.res[r];
                if e == 0.0 {
                    continue;
                }
                let row = &self.t[r * cc + m..r * cc + m + rr];
                for (p, b) in self.pi.iter_mut().zip(row.iter()) {
                    *p += e * b;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Brute force over the vertices of a tiny problem: min dt + eps |dz| s.t. rows, box.
    #[test]
    fn one_piece_against_two_walls() {
        // piece 0 with walls: value_k + g . dz + gt dt >= 0
        let rows = vec![
            row(0, NONE, -0.01, [1.0, 0.0, 0.0], [0.0; 3], 1.0),
            row(0, NONE, 0.02, [-1.0, 0.0, 0.0], [0.0; 3], 1.0),
        ];
        let mut lp = LpSolver::new();
        let mut step = vec![0.0; 4];
        let st = lp.solve(&rows, 0.0, 3, 0.1, -0.1, 0.1, 1e3, 1e-7, &mut step, &mut || false);
        assert_eq!(st, LpStatus::Optimal);
        // x + dt >= 0.01, -x + dt >= -0.02: dt = -0.005, x = 0.015
        assert!((step[3] + 0.005).abs() < 1e-12, "{step:?}");
        assert!((step[0] - 0.015).abs() < 1e-12);
        assert!(step[1].abs() < 1e-15 && step[2].abs() < 1e-15);
    }

    #[test]
    fn infeasible_rows_are_elastic() {
        // two rows that cannot both hold in the box: pays W for the violation
        let rows = vec![
            row(0, NONE, -1.0, [1.0, 0.0, 0.0], [0.0; 3], 0.0),
            row(0, NONE, -1.0, [-1.0, 0.0, 0.0], [0.0; 3], 0.0),
        ];
        let mut lp = LpSolver::new();
        let mut step = vec![0.0; 4];
        let st = lp.solve(&rows, 0.0, 3, 0.1, -0.1, 0.1, 1e3, 1e-7, &mut step, &mut || false);
        assert_eq!(st, LpStatus::Optimal);
        assert!((step[3] + 0.1).abs() < 1e-12);
        assert!(step[0].abs() <= 0.1);
    }
}
