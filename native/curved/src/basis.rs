//! Sparse factorization of a simplex basis whose columns are unit vectors (logical variables) or
//! short structural columns (the poses' coefficients in a few constraint rows).
//!
//! A basic logical column +-e_k covers row k by itself; the structural columns restricted to the
//! uncovered rows form a square kernel, factored by right-looking Gaussian elimination with
//! Markowitz pivoting (smallest (row count - 1)(column count - 1) among entries within a factor
//! of 10 of their column's largest), which keeps the factors of these contact matrices sparse.
//! Basis changes are product-form eta updates until the next factorization.
//!
//! Vectors over basis positions and over constraint rows are dense (the problems have a few
//! thousand rows at most); the factors and etas are sparse.

/// Sparse column: (row, value) pairs.
pub type SparseCol = Vec<(u32, f64)>;

/// LU of the square kernel, as the sequence of eliminations.
#[derive(Default)]
struct KernelLu {
    k: usize,
    piv_row: Vec<u32>,
    piv_col: Vec<u32>,
    piv_val: Vec<f64>,
    /// L multipliers of step s: rows i with l_is (row_i -= l_is row_p)
    l_start: Vec<u32>,
    l_idx: Vec<u32>,
    l_val: Vec<f64>,
    /// U row of step s without its pivot: columns j with values
    u_start: Vec<u32>,
    u_idx: Vec<u32>,
    u_val: Vec<f64>,
}

impl KernelLu {
    /// Factors the k x k kernel given by columns (kernel row indices). Returns the kernel columns
    /// and rows left without a pivot when the kernel is singular (the same number of each).
    fn factor(&mut self, k: usize, cols_in: &[SparseCol]) -> (Vec<u32>, Vec<u32>) {
        self.k = k;
        self.piv_row.clear();
        self.piv_col.clear();
        self.piv_val.clear();
        self.l_start.clear();
        self.l_idx.clear();
        self.l_val.clear();
        self.u_start.clear();
        self.u_idx.clear();
        self.u_val.clear();
        self.l_start.push(0);
        self.u_start.push(0);
        // active submatrix: rows with values, columns with row patterns
        let mut rows: Vec<Vec<(u32, f64)>> = vec![Vec::new(); k];
        let mut cols: Vec<Vec<u32>> = vec![Vec::new(); k];
        let mut scale = 0.0f64;
        for (j, c) in cols_in.iter().enumerate() {
            for &(i, v) in c {
                if v != 0.0 {
                    rows[i as usize].push((j as u32, v));
                    cols[j].push(i);
                    scale = scale.max(v.abs());
                }
            }
        }
        let abs_tol = 1e-13 * scale.max(1e-300);
        let mut col_alive = vec![true; k];
        let mut row_alive = vec![true; k];
        // scatter work: value and marker per column
        let mut work = vec![0.0f64; k];
        let mut mark = vec![u32::MAX; k];
        let mut singular_cols = Vec::new();
        for step in 0..k {
            // ---- pivot search: the columns of fewest entries first
            let mut best: Option<(usize, usize, f64, usize)> = None; // (row, col, value, cost)
            let mut min_count = usize::MAX;
            for j in 0..k {
                if col_alive[j] && !cols[j].is_empty() && cols[j].len() < min_count {
                    min_count = cols[j].len();
                }
            }
            if min_count == usize::MAX {
                // the remaining columns are empty: singular
                for j in 0..k {
                    if col_alive[j] {
                        singular_cols.push(j as u32);
                    }
                }
                break;
            }
            let mut examined = 0;
            let mut count = min_count;
            while examined < 4 && count <= k {
                for j in 0..k {
                    if !col_alive[j] || cols[j].len() != count {
                        continue;
                    }
                    // the column's largest entry
                    let mut cmax = 0.0f64;
                    for &i in &cols[j] {
                        let v = rows[i as usize].iter().find(|e| e.0 == j as u32).map_or(0.0, |e| e.1);
                        cmax = cmax.max(v.abs());
                    }
                    if cmax <= abs_tol {
                        continue;
                    }
                    for &i in &cols[j] {
                        let r = &rows[i as usize];
                        let v = r.iter().find(|e| e.0 == j as u32).map_or(0.0, |e| e.1);
                        if v.abs() < 0.1 * cmax {
                            continue;
                        }
                        let cost = (r.len() - 1) * (count - 1);
                        let better = match best {
                            None => true,
                            Some((_, _, bv, bc)) => cost < bc || (cost == bc && v.abs() > bv.abs()),
                        };
                        if better {
                            best = Some((i as usize, j, v, cost));
                        }
                    }
                    examined += 1;
                    if examined >= 4 {
                        break;
                    }
                }
                if best.is_some_and(|b| b.3 == 0) {
                    break;
                }
                count += 1;
            }
            let Some((p, q, pv, _)) = best else {
                for j in 0..k {
                    if col_alive[j] {
                        singular_cols.push(j as u32);
                    }
                }
                break;
            };
            let _ = step;
            // ---- record U row p (without the pivot) and eliminate column q from the other rows
            self.piv_row.push(p as u32);
            self.piv_col.push(q as u32);
            self.piv_val.push(pv);
            let prow = std::mem::take(&mut rows[p]);
            for &(j, v) in &prow {
                if j as usize != q {
                    self.u_idx.push(j);
                    self.u_val.push(v);
                    work[j as usize] = v;
                    mark[j as usize] = p as u32;
                }
            }
            self.u_start.push(self.u_idx.len() as u32);
            // the pivot row leaves the columns' patterns
            for &(j, _) in &prow {
                let c = &mut cols[j as usize];
                if let Some(at) = c.iter().position(|&i| i as usize == p) {
                    c.swap_remove(at);
                }
            }
            let others = std::mem::take(&mut cols[q]);
            for &i in &others {
                let i = i as usize;
                let row = &mut rows[i];
                let Some(at) = row.iter().position(|e| e.0 as usize == q) else {
                    continue;
                };
                let l = row[at].1 / pv;
                row.swap_remove(at);
                self.l_idx.push(i as u32);
                self.l_val.push(l);
                // row_i -= l row_p: update shared columns, then add the fill
                let mut seen = 0usize;
                for e in row.iter_mut() {
                    if mark[e.0 as usize] == p as u32 {
                        e.1 -= l * work[e.0 as usize];
                        seen += 1;
                    }
                }
                if seen < self.u_start[self.u_start.len() - 1] as usize - self.u_start[self.u_start.len() - 2] as usize
                {
                    // fill: columns of row p not in row i
                    let ustart = self.u_start[self.u_start.len() - 2] as usize;
                    let uend = self.u_start[self.u_start.len() - 1] as usize;
                    for t in ustart..uend {
                        let j = self.u_idx[t];
                        if !row.iter().any(|e| e.0 == j) {
                            row.push((j, -l * self.u_val[t]));
                            cols[j as usize].push(i as u32);
                        }
                    }
                }
            }
            self.l_start.push(self.l_idx.len() as u32);
            col_alive[q] = false;
            row_alive[p] = false;
            for &(j, _) in &prow {
                mark[j as usize] = u32::MAX;
            }
        }
        let singular_rows: Vec<u32> = (0..k).filter(|&i| row_alive[i]).map(|i| i as u32).collect();
        (singular_cols, singular_rows)
    }

    /// Solves K x = a in place: `a` over kernel rows in, `x` over kernel columns out.
    fn ftran(&self, a: &mut [f64], x: &mut [f64]) {
        let steps = self.piv_row.len();
        for s in 0..steps {
            let t = a[self.piv_row[s] as usize];
            if t != 0.0 {
                for e in self.l_start[s] as usize..self.l_start[s + 1] as usize {
                    a[self.l_idx[e] as usize] -= self.l_val[e] * t;
                }
            }
        }
        for s in (0..steps).rev() {
            let mut sum = a[self.piv_row[s] as usize];
            for e in self.u_start[s] as usize..self.u_start[s + 1] as usize {
                sum -= self.u_val[e] * x[self.u_idx[e] as usize];
            }
            x[self.piv_col[s] as usize] = sum / self.piv_val[s];
        }
    }

    /// Solves K^T y = c in place: `c` over kernel columns in (destroyed), `y` over kernel rows out.
    fn btran(&self, c: &mut [f64], y: &mut [f64]) {
        let steps = self.piv_row.len();
        // U^T w = c, forward: w[p_s] = c[q_s] / piv_s, then remove its contribution
        for s in 0..steps {
            let w = c[self.piv_col[s] as usize] / self.piv_val[s];
            y[self.piv_row[s] as usize] = w;
            if w != 0.0 {
                for e in self.u_start[s] as usize..self.u_start[s + 1] as usize {
                    c[self.u_idx[e] as usize] -= self.u_val[e] * w;
                }
            }
        }
        // y = M_0^T ... M_{k-1}^T w: in reverse, y[p_s] -= sum l_is y[i]
        for s in (0..steps).rev() {
            let mut sum = 0.0;
            for e in self.l_start[s] as usize..self.l_start[s + 1] as usize {
                sum += self.l_val[e] * y[self.l_idx[e] as usize];
            }
            if sum != 0.0 {
                y[self.piv_row[s] as usize] -= sum;
            }
        }
    }
}

/// What a basic variable's column is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BasicCol {
    /// sign * e_row
    Unit { row: u32, sign: f64 },
    /// a structural column, by its index in the caller's column store
    Structural(u32),
}

/// The factorization of a basis of m positions over m constraint rows.
#[derive(Default)]
pub struct BasisFactor {
    m: usize,
    /// per constraint row: the position of the logical covering it, or -1 (a kernel row)
    row_cover: Vec<i32>,
    row_sign: Vec<f64>,
    /// kernel rows (constraint rows) and kernel columns (basis positions)
    krow: Vec<u32>,
    krow_of: Vec<i32>,
    kpos: Vec<u32>,
    /// the structural columns of the kernel positions, over constraint rows
    kcols: Vec<SparseCol>,
    lu: KernelLu,
    eta_r: Vec<u32>,
    eta_piv: Vec<f64>,
    eta_start: Vec<u32>,
    eta_idx: Vec<u32>,
    eta_val: Vec<f64>,
    // scratch
    ka: Vec<f64>,
    kx: Vec<f64>,
    pub refactors: u64,
}

impl BasisFactor {
    pub fn etas(&self) -> usize {
        self.eta_r.len()
    }

    /// Factors the basis whose position r holds `cols[r]`; `structural(c)` gives a structural
    /// column. Returns the positions whose columns were dependent, each paired with an uncovered
    /// constraint row; the caller replaces them by that row's logical and factors again.
    pub fn factor(&mut self, m: usize, cols: &[BasicCol], structural: &dyn Fn(u32) -> SparseCol) -> Vec<(u32, u32)> {
        self.m = m;
        self.refactors += 1;
        self.row_cover.clear();
        self.row_cover.resize(m, -1);
        self.row_sign.clear();
        self.row_sign.resize(m, 0.0);
        let mut duplicate_units = Vec::new();
        for (r, c) in cols.iter().enumerate() {
            if let BasicCol::Unit { row, sign } = *c {
                if self.row_cover[row as usize] >= 0 {
                    duplicate_units.push(r as u32);
                } else {
                    self.row_cover[row as usize] = r as i32;
                    self.row_sign[row as usize] = sign;
                }
            }
        }
        self.krow.clear();
        self.krow_of.clear();
        self.krow_of.resize(m, -1);
        for k in 0..m {
            if self.row_cover[k] < 0 {
                self.krow_of[k] = self.krow.len() as i32;
                self.krow.push(k as u32);
            }
        }
        self.kpos.clear();
        self.kcols.clear();
        for (r, c) in cols.iter().enumerate() {
            if let BasicCol::Structural(s) = *c {
                self.kpos.push(r as u32);
                self.kcols.push(structural(s));
            }
        }
        let k = self.krow.len();
        let mut dependent: Vec<(u32, u32)> = Vec::new();
        if self.kpos.len() + duplicate_units.len() != k {
            // cannot happen for m positions over m rows; guard anyway
            return (0..m as u32).map(|r| (r, r)).collect();
        }
        // kernel columns restricted to kernel rows
        let kin: Vec<SparseCol> = self
            .kcols
            .iter()
            .map(|c| {
                c.iter()
                    .filter_map(|&(row, v)| {
                        let kr = self.krow_of[row as usize];
                        (kr >= 0).then_some((kr as u32, v))
                    })
                    .collect()
            })
            .collect();
        // duplicate unit columns are dependent: they get an uncovered row below
        let kcount = self.kpos.len();
        let (sing_cols, sing_rows) = self.lu.factor_rect(kcount, k, &kin);
        let mut free_rows: Vec<u32> = sing_rows.iter().map(|&kr| self.krow[kr as usize]).collect();
        for &c in &sing_cols {
            let row = free_rows.pop().unwrap_or(0);
            dependent.push((self.kpos[c as usize], row));
        }
        for &r in &duplicate_units {
            let row = free_rows.pop().unwrap_or(0);
            dependent.push((r, row));
        }
        self.eta_r.clear();
        self.eta_piv.clear();
        self.eta_start.clear();
        self.eta_start.push(0);
        self.eta_idx.clear();
        self.eta_val.clear();
        self.ka.resize(k, 0.0);
        self.kx.resize(kcount.max(k), 0.0);
        dependent
    }

    /// x = B^-1 a: `a` over constraint rows (destroyed), `x` over positions.
    pub fn ftran(&mut self, a: &mut [f64], x: &mut [f64]) {
        let k = self.krow.len();
        for (kr, &row) in self.krow.iter().enumerate() {
            self.ka[kr] = a[row as usize];
        }
        self.lu.ftran(&mut self.ka[..k], &mut self.kx[..k]);
        for (kc, &pos) in self.kpos.iter().enumerate() {
            x[pos as usize] = self.kx[kc];
        }
        // covered rows: sign x_logical = a_k - sum over kernel columns of B_kj x_j
        for (kc, col) in self.kcols.iter().enumerate() {
            let xj = self.kx[kc];
            if xj != 0.0 {
                for &(row, v) in col {
                    if self.row_cover[row as usize] >= 0 {
                        a[row as usize] -= v * xj;
                    }
                }
            }
        }
        for row in 0..self.m {
            let pos = self.row_cover[row];
            if pos >= 0 {
                x[pos as usize] = self.row_sign[row] * a[row];
            }
        }
        // product-form updates
        for e in 0..self.eta_r.len() {
            let r = self.eta_r[e] as usize;
            let t = x[r] / self.eta_piv[e];
            x[r] = t;
            if t != 0.0 {
                for q in self.eta_start[e] as usize..self.eta_start[e + 1] as usize {
                    x[self.eta_idx[q] as usize] -= self.eta_val[q] * t;
                }
            }
        }
    }

    /// y = B^-T c: `c` over positions (destroyed), `y` over constraint rows.
    pub fn btran(&mut self, c: &mut [f64], y: &mut [f64]) {
        for e in (0..self.eta_r.len()).rev() {
            let r = self.eta_r[e] as usize;
            let mut s = c[r];
            for q in self.eta_start[e] as usize..self.eta_start[e + 1] as usize {
                s -= self.eta_val[q] * c[self.eta_idx[q] as usize];
            }
            c[r] = s / self.eta_piv[e];
        }
        for row in 0..self.m {
            let pos = self.row_cover[row];
            y[row] = if pos >= 0 {
                self.row_sign[row] * c[pos as usize]
            } else {
                0.0
            };
        }
        // kernel: K^T y_K = c_kernel - sum over covered rows of B_kj y_k
        let kcount = self.kpos.len();
        for (kc, col) in self.kcols.iter().enumerate() {
            let mut s = c[self.kpos[kc] as usize];
            for &(row, v) in col {
                if self.row_cover[row as usize] >= 0 {
                    s -= v * y[row as usize];
                }
            }
            self.kx[kc] = s;
        }
        let k = self.krow.len();
        self.lu.btran(&mut self.kx[..kcount], &mut self.ka[..k]);
        for (kr, &row) in self.krow.iter().enumerate() {
            y[row as usize] = self.ka[kr];
        }
    }

    /// Records the replacement of position r's column by a column whose B^-1 image is `alpha`
    /// (over positions).
    pub fn update(&mut self, r: usize, alpha: &[f64]) {
        self.eta_r.push(r as u32);
        self.eta_piv.push(alpha[r]);
        for (i, &v) in alpha.iter().enumerate() {
            if i != r && v != 0.0 {
                self.eta_idx.push(i as u32);
                self.eta_val.push(v);
            }
        }
        self.eta_start.push(self.eta_idx.len() as u32);
    }
}

impl KernelLu {
    /// factor() for a kernel of `ncols` columns over `nrows` rows (equal for a nonsingular basis).
    fn factor_rect(&mut self, ncols: usize, nrows: usize, cols: &[SparseCol]) -> (Vec<u32>, Vec<u32>) {
        let n = ncols.max(nrows);
        let (sc, sr) = self.factor(n, cols);
        // padding columns (ncols < nrows) appear among the singular ones: keep only real columns
        let sc: Vec<u32> = sc.into_iter().filter(|&c| (c as usize) < ncols).collect();
        let sr: Vec<u32> = sr.into_iter().filter(|&r| (r as usize) < nrows).collect();
        (sc, sr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dense_mul(m: usize, cols: &[BasicCol], st: &dyn Fn(u32) -> SparseCol, x: &[f64]) -> Vec<f64> {
        let mut out = vec![0.0; m];
        for (r, c) in cols.iter().enumerate() {
            match *c {
                BasicCol::Unit { row, sign } => out[row as usize] += sign * x[r],
                BasicCol::Structural(s) => {
                    for (row, v) in st(s) {
                        out[row as usize] += v * x[r];
                    }
                }
            }
        }
        out
    }

    #[test]
    fn solves_and_updates() {
        let mut rng = crate::rng::Rng::new(3);
        for trial in 0..30 {
            let m = 5 + trial % 23;
            // random sparse structural columns with a dominant entry on a random row
            let store: Vec<SparseCol> = (0..m)
                .map(|_| {
                    let mut c: SparseCol = Vec::new();
                    for _ in 0..3 {
                        let row = (rng.next_f64() * m as f64) as u32;
                        if !c.iter().any(|e| e.0 == row) {
                            c.push((row, rng.next_f64() * 2.0 - 1.0));
                        }
                    }
                    c
                })
                .collect();
            let st = |s: u32| store[s as usize].clone();
            let mut cols: Vec<BasicCol> = (0..m)
                .map(|r| {
                    if rng.next_f64() < 0.4 {
                        BasicCol::Structural(r as u32)
                    } else {
                        BasicCol::Unit {
                            row: r as u32,
                            sign: if rng.next_f64() < 0.5 { 1.0 } else { -1.0 },
                        }
                    }
                })
                .collect();
            let mut f = BasisFactor::default();
            // repair dependent columns with logicals until the basis is nonsingular
            for _ in 0..5 {
                let dep = f.factor(m, &cols, &st);
                if dep.is_empty() {
                    break;
                }
                for (pos, row) in dep {
                    cols[pos as usize] = BasicCol::Unit { row, sign: 1.0 };
                }
            }
            assert!(f.factor(m, &cols, &st).is_empty());
            let b: Vec<f64> = (0..m).map(|_| rng.next_f64() - 0.5).collect();
            let mut a = b.clone();
            let mut x = vec![0.0; m];
            f.ftran(&mut a, &mut x);
            let back = dense_mul(m, &cols, &st, &x);
            for i in 0..m {
                assert!((back[i] - b[i]).abs() < 1e-9, "ftran trial {trial}");
            }
            // B^T y = c
            let c: Vec<f64> = (0..m).map(|_| rng.next_f64() - 0.5).collect();
            let mut cc = c.clone();
            let mut y = vec![0.0; m];
            f.btran(&mut cc, &mut y);
            for (r, col) in cols.iter().enumerate() {
                let v = match *col {
                    BasicCol::Unit { row, sign } => sign * y[row as usize],
                    BasicCol::Structural(s) => st(s).iter().map(|&(row, v)| v * y[row as usize]).sum(),
                };
                assert!((v - c[r]).abs() < 1e-9, "btran trial {trial}");
            }
            // replace a position by a unit column of a row and check again through the eta
            let r = (rng.next_f64() * m as f64) as usize;
            let row = (rng.next_f64() * m as f64) as u32;
            let mut e = vec![0.0; m];
            e[row as usize] = 1.0;
            let mut alpha = vec![0.0; m];
            f.ftran(&mut e, &mut alpha);
            if alpha[r].abs() > 1e-3 {
                f.update(r, &alpha);
                cols[r] = BasicCol::Unit { row, sign: 1.0 };
                let mut a = b.clone();
                f.ftran(&mut a, &mut x);
                let back = dense_mul(m, &cols, &st, &x);
                for i in 0..m {
                    assert!((back[i] - b[i]).abs() < 1e-8, "eta ftran trial {trial}");
                }
                let mut cc = c.clone();
                f.btran(&mut cc, &mut y);
                for (r2, col) in cols.iter().enumerate() {
                    let v = match *col {
                        BasicCol::Unit { row, sign } => sign * y[row as usize],
                        BasicCol::Structural(s) => st(s).iter().map(|&(row, v)| v * y[row as usize]).sum(),
                    };
                    assert!((v - c[r2]).abs() < 1e-8, "eta btran trial {trial}");
                }
            }
        }
    }
}
