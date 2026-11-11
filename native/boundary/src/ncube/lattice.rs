//! The boundary of the d-cube [-s/2, s/2]^d, d = 5..10 ("4D on 5D" to "9D on 10D"): lattice words,
//! the closed-form clearance and the geodesic search by reach (docs/spaces/BOUNDARY.md section 4B).
//! Port of packages/boundary/src/ncube/lattice.ts (the functions the server reaches).
//!
//! Conventions are the tesseract's with 4 replaced by d (section 2): cell c = 2 i + (sigma > 0) is
//! the facet x_i = sigma s/2, a (d-1)-cube with local coordinates u = the other d - 1 coordinates
//! in increasing order, the cell being [-h, h]^n with h = s/2 and n = d - 1. Every ridge of the
//! d-cube is a right angle, so the cells a straight path crosses unfold into the cubes of the
//! lattice 2h Z^n (the anchor at the origin); the hinges, the (d-3)-faces, are the lattice points
//! where at least two coordinates are odd multiples of h (their codimension in R^n is 2). A
//! straight path is described by the lattice planes y_k = (2m + 1) h it crosses in order (a word).
//! Each word has an end cell and an exact map y -> x = A y + h b from the lattice into R^d, A a
//! signed permutation (stored per lattice axis as a row and a sign) and b an integer vector, built
//! by composing the unfoldings: crossing in direction tau e_k from cell (i, sg), where
//! A e_k = g e_j, enters the cell (j, tj), tj = tau g, by the rotation R of the plane (e_i, e_j)
//! about the ridge, R(sg e_i) = tj e_j and R(tj e_j) = -sg e_i; then A <- R A and
//! b <- R (b - q) + q, q = sg e_i + tj e_j.
//!
//! Completeness (proved in BOUNDARY.md 4.1 and 4B): a straight path of length < 2 s crosses at most
//! two planes of each lattice axis (three consecutive planes are 4 h = 2 s apart in that
//! coordinate), each axis in one direction. Balls need only paths shorter than 1 (their diameter),
//! and a ball fits only if s >= 1/sqrt 2, so 2 s > 1 and the words with |m_k| <= 2 contain every
//! path that matters.
//!
//! Reach. The words are not listed (109,601 per cell for d = 5 and 9,864,101 for d = 6 with two
//! crossings per axis; 10^16 for d = 10) but found for one pair of points at a time, by two exact
//! bounds on the length of any word whose straight path from u joins u to the image y of the target:
//!  1. the path crosses, on every axis k with m_k != 0, the planes up to the last one, at distance
//!     delta_k = (2 |m_k| - 1) h - sign(m_k) u_k from u, in a different coordinate for each axis, so
//!     length^2 >= sum_k delta_k^2 (the support search below is pruned by it);
//!  2. the image is y = 2 h m + yhat, where yhat is a signed permutation of the target's local
//!     coordinates, so with c = 2 h m - u, length^2 = sum_r (c_r + yhat_r)^2 >= sum_r (|c|_(r) -
//!     |u2|_(r))^2, the two lists sorted (the rearrangement inequality). It holds for every order of
//!     the crossings, so a support (m) that fails it needs no orders.
//! Only the supports that pass both are expanded into orders of crossings (the multinomial many),
//! and each ordered word is tested exactly as the tesseract's: its image in its lattice cube and
//! its planes crossed in order within [0, 1]. The search is capped by a work budget
//! (WordLimitError); the cap makes the check sound but incomplete: a configuration that needs more
//! work is refused, never accepted.
//!
//! The source keeps the word maps in Int8Array; their entries stay far inside that range (rows
//! below 10, signs +-1, b at most a few units), so plain `i32` holds the same values.

use polypack_js::math;

/// packages/boundary/src/ncube/lattice.ts: NCUBE_NAMES
pub const NCUBE_NAMES: [&str; 6] = ["5cube", "6cube", "7cube", "8cube", "9cube", "10cube"];

/// The ambient dimension d of a d-cube name ("7cube" -> 7), or 0 when the name is none.
/// packages/boundary/src/ncube/lattice.ts: ncubeDim
pub fn ncube_dim(name: &str) -> usize {
    match NCUBE_NAMES.iter().position(|&n| n == name) {
        Some(i) => i + 5,
        None => 0,
    }
}

/// packages/boundary/src/ncube/lattice.ts: isNCubeName
pub fn is_ncube_name(x: &str) -> bool {
    ncube_dim(x) > 0
}

/// The local axes of cell (i, .) in R^d: every axis except i, increasing.
/// packages/boundary/src/ncube/lattice.ts: axesOf
pub fn axes_of(d: usize, i: usize) -> Vec<usize> {
    (0..d).filter(|&j| j != i).collect()
}

/// The R^d point of local coordinates u (read from U at offset o) of cell c, at half-edge h.
/// packages/boundary/src/ncube/lattice.ts: embedCell
pub fn embed_cell(d: usize, c: usize, u: &[f64], o: usize, h: f64) -> Vec<f64> {
    let mut x = vec![0.0; d];
    let i = c >> 1;
    x[i] = if c & 1 == 1 { h } else { -h };
    let mut k = 0;
    for j in 0..d {
        if j != i {
            x[j] = u[o + k];
            k += 1;
        }
    }
    x
}

/// Geodesic distance from the local point u (read from U at offset o) to the hinges, in closed
/// form: the nearest hinge of the development is an edge-of-cell hinge of the anchor, a pair of
/// axes a < b with distance sqrt((h - |u_a|)^2 + (h - |u_b|)^2), so the least is the root of the
/// two smallest squared slacks. (Proof: BOUNDARY.md 4.2; the odd multiple of h nearest u_a in
/// [-h, h] is +-h.) For n = d - 1 >= 2 axes.
/// packages/boundary/src/ncube/lattice.ts: ncubeClearance
pub fn ncube_clearance(u: &[f64], o: usize, n: usize, h: f64) -> f64 {
    let mut a1 = f64::INFINITY;
    let mut a2 = f64::INFINITY;
    for k in 0..n {
        let a = h - u[o + k].abs();
        if a < a1 {
            a2 = a1;
            a1 = a;
        } else if a < a2 {
            a2 = a;
        }
    }
    math::hypot(a1, a2)
}

// ------------------------------------------------------------------------------------------ the development of a word

/// The development map of a word so far: end cell, and per lattice axis the row and sign of A's column, and b.
/// packages/boundary/src/ncube/lattice.ts: WordMap
#[derive(Clone, Debug)]
pub struct WordMap {
    pub cell: usize,
    pub rows: Vec<i32>,
    pub sgn: Vec<i32>,
    pub b: Vec<i32>,
}

/// The empty word's map at cell c0: lattice axis k is the cell's k-th local axis.
/// packages/boundary/src/ncube/lattice.ts: startMap
pub fn start_map(d: usize, c0: usize) -> WordMap {
    let i = c0 >> 1;
    let n = d - 1;
    let ax = axes_of(d, i);
    let rows: Vec<i32> = (0..n).map(|k| ax[k] as i32).collect();
    let sgn = vec![1; n];
    let mut b = vec![0; d];
    b[i] = if c0 & 1 == 1 { 1 } else { -1 };
    WordMap { cell: c0, rows, sgn, b }
}

/// The map after crossing the plane of lattice axis k in direction tau (+1 or -1).
/// packages/boundary/src/ncube/lattice.ts: stepMap
pub fn step_map(d: usize, w: &WordMap, k: usize, tau: i32) -> WordMap {
    let i = (w.cell >> 1) as i32;
    let sg = if w.cell & 1 == 1 { 1 } else { -1 };
    let j = w.rows[k];
    let tj = tau * w.sgn[k];
    let n = d - 1;
    let mut rows = w.rows.clone();
    let mut sgn = w.sgn.clone();
    // the column that lay along e_j now lies along e_i
    for r in 0..n {
        if w.rows[r] == j {
            rows[r] = i;
            sgn[r] = -sg * tj * w.sgn[r];
        }
    }
    // b <- R (b - q) + q, q = sg e_i + tj e_j
    let mut b = w.b.clone();
    let wi = w.b[i as usize] - sg;
    let wj = w.b[j as usize] - tj;
    b[i as usize] = -sg * tj * wj + sg;
    b[j as usize] = sg * tj * wi + tj;
    WordMap { cell: (2 * j + if tj > 0 { 1 } else { 0 }) as usize, rows, sgn, b }
}

// ------------------------------------------------------------------------------------------ the search

/// The work of a check is capped; a search that needs more throws this and the caller refuses the configuration.
/// packages/boundary/src/ncube/lattice.ts: WordLimitError
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WordLimitError {
    pub limit: f64,
}

/// A work budget shared by the searches of one check (steps left). The counts are JavaScript
/// numbers in the source (a caller may give any limit), so they are `f64` here.
/// packages/boundary/src/ncube/lattice.ts: WordBudget
#[derive(Clone, Copy, Debug)]
pub struct WordBudget {
    pub left: f64,
    /// The budget's size, for messages.
    pub limit: f64,
}

/// packages/boundary/src/ncube/lattice.ts: newBudget
pub fn new_budget(limit: f64) -> WordBudget {
    WordBudget { left: limit, limit }
}

/// One realised straight geodesic from a point to (an image of) another, with the map that produced its image.
/// packages/boundary/src/ncube/lattice.ts: Realised
#[derive(Clone, Debug)]
pub struct Realised {
    /// Its length.
    pub len: f64,
    /// The image y of the target in the start's development (n numbers).
    pub y: Vec<f64>,
    /// y_r = sign_r u2[perm_r] + h t_r (sign 0: a constant, the coordinate along the target's own normal).
    pub perm: Vec<usize>,
    pub sign: Vec<i32>,
    pub t: Vec<f64>,
}

/// packages/boundary/src/ncube/lattice.ts: RealisedOptions
#[derive(Clone, Copy, Debug, Default)]
pub struct RealisedOptions {
    /// Only paths shorter than this are looked for (default 1, a ball's diameter).
    pub reach: Option<f64>,
    /// Skip the empty word (for loops, where the target is the start).
    pub exclude_empty: bool,
    /// Slack for a point lying on a plane or a face (default 1e-12 max(1, h)).
    pub eps: Option<f64>,
}

/// Insertion sort, ascending, in place. packages/boundary/src/ncube/lattice.ts: ascending
fn ascending(a: &mut [f64]) {
    for i in 1..a.len() {
        let v = a[i];
        let mut j = i as isize - 1;
        while j >= 0 && a[j as usize] > v {
            a[j as usize + 1] = a[j as usize];
            j -= 1;
        }
        a[(j + 1) as usize] = v;
    }
}

/// The state of one call of `realised_words` (the closures of the source share these variables).
struct Search<'a> {
    d: usize,
    n: usize,
    h: f64,
    reach2: f64,
    eps: f64,
    exclude_empty: bool,
    u1: Vec<f64>,
    x2: Vec<f64>,
    /// The cells that hold x2, in the order they were added (a Set in the source).
    ends: Vec<usize>,
    i2: usize,
    ax2: Vec<usize>,
    e_abs: Vec<f64>,
    start: WordMap,
    must_cross: i32,
    may_stay: bool,
    need_rows: Vec<usize>,
    known0: Vec<f64>,
    d_pos: Vec<f64>,
    d_neg: Vec<f64>,
    out: Vec<Realised>,
    m: Vec<i32>,
    tmp: Vec<f64>,
    y: Vec<f64>,
    step_k: Vec<usize>,
    step_level: Vec<i32>,
    step_t: Vec<f64>,
    taken: Vec<i32>,
    rem: Vec<i32>,
    plane_dist2: Vec<f64>,
    budget: &'a mut WordBudget,
}

impl Search<'_> {
    /// The time at which the segment u -> y crosses a plane, or NaN when the step puts no constraint (both ends on the plane).
    fn crossing_time(&self, k: usize, level: i32, yk: f64) -> f64 {
        let plane = self.h * level as f64;
        if (self.u1[k] - plane).abs() <= self.eps && (yk - plane).abs() <= self.eps {
            return f64::NAN;
        }
        (plane - self.u1[k]) / (yk - self.u1[k])
    }

    /// Tests the finished word map against the end cells.
    fn finish(&mut self, w: &WordMap, steps: usize) {
        let (n, h, eps) = (self.n, self.h, self.eps);
        if !self.ends.contains(&w.cell) {
            return;
        }
        for r in 0..n {
            let row = w.rows[r] as usize;
            self.y[r] = w.sgn[r] as f64 * (self.x2[row] - h * w.b[row] as f64);
            if !((self.y[r] - 2.0 * h * self.m[r] as f64).abs() <= h + eps) {
                return;
            }
        }
        let mut prev = f64::NEG_INFINITY;
        for q in 0..steps {
            let k = self.step_k[q];
            let plane = h * self.step_level[q] as f64;
            if (self.u1[k] - plane).abs() <= eps && (self.y[k] - plane).abs() <= eps {
                continue;
            }
            let t = (plane - self.u1[k]) / (self.y[k] - self.u1[k]);
            if !(t >= -1e-12 && t <= 1.0 + 1e-12 && t > prev) {
                return;
            }
            prev = t;
        }
        let mut l2 = 0.0;
        for r in 0..n {
            l2 += (self.y[r] - self.u1[r]) * (self.y[r] - self.u1[r]);
        }
        let mut real = Realised { len: l2.sqrt(), y: self.y.clone(), perm: vec![0; n], sign: vec![0; n], t: vec![0.0; n] };
        for r in 0..n {
            let row = w.rows[r] as usize;
            if row == self.i2 {
                // the coordinate along the target's own normal: a constant (sigma h)
                real.sign[r] = 0;
                real.t[r] = (w.sgn[r] as f64 * (self.x2[row] - h * w.b[row] as f64)) / h;
            } else {
                real.perm[r] = self.ax2.iter().position(|&a| a == row).unwrap_or(255);
                real.sign[r] = w.sgn[r];
                real.t[r] = -(w.sgn[r] as f64) * w.b[row] as f64;
            }
        }
        self.out.push(real);
    }

    /// Expands one support into the orders of its crossings; `partial` is the bound 3 so far (squared).
    fn orders(&mut self, w: &WordMap, steps: usize, total: usize, partial: f64) -> Result<(), WordLimitError> {
        if steps == total {
            self.finish(w, steps);
            return Ok(());
        }
        let (n, h, eps) = (self.n, self.h, self.eps);
        for k in 0..n {
            if self.rem[k] == 0 {
                continue;
            }
            self.budget.left -= 1.0;
            if self.budget.left < 0.0 {
                return Err(WordLimitError { limit: self.budget.limit });
            }
            let tau = if self.m[k] > 0 { 1 } else { -1 };
            let level = tau * (2 * self.taken[k] + 1);
            self.step_k[steps] = k;
            self.step_level[steps] = level;
            self.step_t[steps] = f64::NAN;
            self.rem[k] -= 1;
            self.taken[k] += 1;
            let nw = step_map(self.d, w, k, tau);
            let mut ok = true;
            let mut np = partial;
            let mut set_t = false;
            if self.rem[k] == 0 {
                // the last crossing of the axis: its image coordinate is known
                let row = nw.rows[k] as usize;
                let yk = nw.sgn[k] as f64 * (self.x2[row] - h * nw.b[row] as f64);
                if !((yk - 2.0 * h * self.m[k] as f64).abs() <= h + eps) {
                    ok = false;
                } else {
                    let delta = yk - self.u1[k];
                    np = partial - self.plane_dist2[k] + delta * delta;
                    if !(np < self.reach2) {
                        ok = false;
                    } else {
                        // times of this axis's crossings (steps so far), then the order among all known times
                        for q in 0..=steps {
                            if self.step_k[q] == k {
                                self.step_t[q] = self.crossing_time(k, self.step_level[q], yk);
                            }
                        }
                        set_t = true;
                        let mut prev = f64::NEG_INFINITY;
                        let mut q = 0;
                        while q <= steps && ok {
                            let t = self.step_t[q];
                            q += 1;
                            if t.is_nan() {
                                continue;
                            }
                            if !(t >= -1e-12 && t <= 1.0 + 1e-12 && t >= prev - 1e-12) {
                                ok = false;
                            }
                            prev = math::max(prev, t);
                        }
                    }
                }
            }
            if ok {
                self.orders(&nw, steps + 1, total, np)?;
            }
            if set_t {
                for q in 0..=steps {
                    if self.step_k[q] == k {
                        self.step_t[q] = f64::NAN;
                    }
                }
            }
            self.taken[k] -= 1;
            self.rem[k] += 1;
        }
        Ok(())
    }

    /// Chooses the crossings of axis r onward (the support), pruning by bound 1.
    fn support(&mut self, r: usize, cost: f64, total: usize) -> Result<(), WordLimitError> {
        let (n, h) = (self.n, self.h);
        self.budget.left -= 1.0;
        if self.budget.left < 0.0 {
            return Err(WordLimitError { limit: self.budget.limit });
        }
        if r == n {
            if total == 0 && self.exclude_empty {
                return Ok(());
            }
            if !self.may_stay {
                let mut reaches = false;
                let mut q = 0;
                while q < n && !reaches {
                    if self.m[q] != 0 && self.need_rows.contains(&(self.start.rows[q] as usize)) {
                        reaches = true;
                    }
                    q += 1;
                }
                if !reaches {
                    return Ok(());
                }
            }
            // bound 2, the assignment bound
            for q in 0..n {
                self.tmp[q] = (2.0 * h * self.m[q] as f64 - self.u1[q]).abs();
            }
            ascending(&mut self.tmp);
            let mut lb = 0.0;
            for q in 0..n {
                lb += (self.tmp[q] - self.e_abs[q]) * (self.tmp[q] - self.e_abs[q]);
            }
            if !(lb < self.reach2) {
                return Ok(());
            }
            for q in 0..n {
                self.rem[q] = self.m[q].abs();
                self.plane_dist2[q] = if self.m[q] == 0 {
                    0.0
                } else {
                    let v = (if self.m[q] > 0 { &self.d_pos } else { &self.d_neg })[2 * q + self.m[q].unsigned_abs() as usize - 1];
                    v * v
                };
            }
            self.taken.fill(0);
            let start = self.start.clone();
            return self.orders(&start, 0, total, cost);
        }
        // no crossing on this axis: y_r is known
        let c0 = cost + self.known0[r] * self.known0[r];
        if c0 < self.reach2 && r as i32 != self.must_cross {
            self.m[r] = 0;
            self.support(r + 1, c0, total)?;
        }
        for mm in 1..=2usize {
            let cp = cost + self.d_pos[2 * r + mm - 1] * self.d_pos[2 * r + mm - 1];
            if cp < self.reach2 {
                self.m[r] = mm as i32;
                self.support(r + 1, cp, total + mm)?;
            }
            let cn = cost + self.d_neg[2 * r + mm - 1] * self.d_neg[2 * r + mm - 1];
            if cn < self.reach2 {
                self.m[r] = -(mm as i32);
                self.support(r + 1, cn, total + mm)?;
            }
        }
        self.m[r] = 0;
        Ok(())
    }
}

/// All realised straight geodesics, shorter than the reach, from the point (c1, U1[o1..]) to the
/// point (c2, U2[o2..]) at edge s, one per realised word that the bounds below do not rule out. A
/// step whose plane holds both ends (two points of one ridge) puts no constraint on the order, as
/// in the tesseract's tables. Caution as there: such a word can also be a path through a hinge,
/// never shorter than the two clearances together, so for balls whose clearances are >= 1/2 it is
/// >= 1 and changes no verdict.
///
/// The target is the R^d point x2 (the cells that contain it are the end cells). Three exact bounds
/// prune the search, all valid for every word with the support m at hand (the crossings per lattice
/// axis):
///  1. the support bound: length^2 >= sum_k delta_k^2, delta_k the distance from u to the last plane
///     crossed on axis k, plus, for an axis k with m_k = 0, the squared difference
///     (x2[row_k] - u_k)^2: a column of A that is never crossed keeps its row, and b keeps its
///     value there, so y_k = x2[row_k] is known before any crossing;
///  2. the assignment bound of the header (rearrangement inequality);
///  3. during the orders: the image coordinate y_k of an axis is known as soon as its last crossing
///     is made, so delta_k = y_k - u_k replaces the plane distance in the sum, the image must lie in
///     its lattice cube, and the crossing times t = (plane - u_k)/(y_k - u_k) known so far must lie
///     in [0, 1] and increase along the order. A prefix that fails any of them has no realised
///     extension.
/// packages/boundary/src/ncube/lattice.ts: realisedWords
#[allow(clippy::too_many_arguments)]
pub fn realised_words(d: usize, s: f64, c1: usize, u1_: &[f64], o1: usize, c2: usize, u2_: &[f64], o2: usize, budget: &mut WordBudget, opts: &RealisedOptions) -> Result<Vec<Realised>, WordLimitError> {
    let n = d - 1;
    let h = s / 2.0;
    let reach = opts.reach.unwrap_or(1.0);
    let reach2 = reach * reach;
    let eps = opts.eps.unwrap_or(1e-12 * math::max(1.0, h));
    let exclude_empty = opts.exclude_empty;
    let u1: Vec<f64> = (0..n).map(|k| u1_[o1 + k]).collect();
    let x2 = embed_cell(d, c2, u2_, o2, h);
    // the cells that hold x2: its anchor and, for a coordinate on a ridge, the neighbour across
    let mut ends: Vec<usize> = vec![c2];
    for t in 0..d {
        if h - x2[t].abs() <= eps {
            let e = 2 * t + if x2[t] > 0.0 { 1 } else { 0 };
            if !ends.contains(&e) {
                ends.push(e);
            }
        }
    }
    let i2 = c2 >> 1;
    let ax2 = axes_of(d, i2);
    let mut e_abs: Vec<f64> = ax2.iter().map(|&a| x2[a].abs()).collect();
    ascending(&mut e_abs);
    let start = start_map(d, c1);
    // The normal axis of the end cell is the original row of a crossed axis, or the start's own normal axis (a crossing swaps
    // the normal with the row of the axis it crosses, so the normal after any word is one of the rows of the crossed axes, or
    // the original normal when a swap is undone). So unless an end cell has the start's normal axis, some axis whose original
    // row is an end cell's normal axis must be crossed: when only one row is possible, that axis is crossed in every word.
    let i1 = c1 >> 1;
    let mut must_cross = -1i32;
    let mut may_stay = false;
    let mut need_rows: Vec<usize> = Vec::new();
    for &e in &ends {
        if e >> 1 == i1 {
            may_stay = true;
        } else if !need_rows.contains(&(e >> 1)) {
            need_rows.push(e >> 1);
        }
    }
    if !may_stay && need_rows.len() == 1 {
        must_cross = start.rows.iter().position(|&r| r as usize == need_rows[0]).map_or(-1, |p| p as i32);
    }
    // y_k for an axis never crossed: x2 along its original row
    let known0: Vec<f64> = (0..n).map(|k| x2[start.rows[k] as usize] - u1[k]).collect();
    // distance from u to the last plane crossed on the axis, for m = 1, 2 on the + and - sides
    let mut d_pos = vec![0.0; 2 * n];
    let mut d_neg = vec![0.0; 2 * n];
    for k in 0..n {
        for m in 1..=2usize {
            d_pos[2 * k + m - 1] = math::max(0.0, (2 * m - 1) as f64 * h - u1[k]);
            d_neg[2 * k + m - 1] = math::max(0.0, (2 * m - 1) as f64 * h + u1[k]);
        }
    }
    let mut search = Search {
        d,
        n,
        h,
        reach2,
        eps,
        exclude_empty,
        u1,
        x2,
        ends,
        i2,
        ax2,
        e_abs,
        start,
        must_cross,
        may_stay,
        need_rows,
        known0,
        d_pos,
        d_neg,
        out: Vec::new(),
        m: vec![0; n],
        tmp: vec![0.0; n],
        y: vec![0.0; n],
        step_k: vec![0; 2 * n],
        step_level: vec![0; 2 * n],
        step_t: vec![0.0; 2 * n],
        taken: vec![0; n],
        rem: vec![0; n],
        plane_dist2: vec![0.0; n],
        budget,
    };
    search.support(0, 0.0, 0)?;
    Ok(search.out)
}
