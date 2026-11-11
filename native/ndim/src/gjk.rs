//! Separation of two convex polytopes (or points) in d dimensions from their vertex lists
//! (packages/ndim/src/gjk.ts).
//!
//! signed_separation(A, B) is the largest gap of a separating hyperplane: the distance of the two
//! convex hulls when they are disjoint, and minus the penetration depth (the length of the smallest
//! translation that separates them) when they overlap. It is the d-dimensional replacement of the
//! separating-axis test of the 3D space (whose candidate axes are the facet normals of the
//! Minkowski difference A - B, too many for d >= 4):
//!
//!  - disjoint: GJK with Wolfe's minimum-norm-point solver on A - B (support points of the two
//!    sets, no explicit difference), accurate to about 1e-13;
//!  - overlapping: EPA, expanding a simplicial polytope inside A - B (initialised from GJK's final
//!    simplex, completed to d + 1 points) until its facet nearest to the origin is a facet of
//!    A - B. The depth it returns never exceeds the true depth and converges to it from below, so
//!    "overlaps by more than tol" is a sound verdict.
//!
//! Any unit vector u gives a lower bound of the separation, min_B u.y - max_A u.x (gap_along); a
//! pair is settled as soon as one of a few candidate directions shows a gap of at least -tol.
use crate::linalg::{dot, solve};
use crate::margin::{max_margin_separation, MarginOptions};
use polypack_js::math;

/// packages/ndim/src/gjk.ts: gapAlong. min over rows of B of u.y minus max over rows of A of u.x,
/// for a unit vector u: a lower bound of the signed separation.
pub fn gap_along(a: &[f64], n_a: usize, b: &[f64], n_b: usize, d: usize, u: &[f64]) -> f64 {
    let mut amax = f64::NEG_INFINITY;
    for i in 0..n_a {
        let s = dot(a, u, d, i * d, 0);
        if s > amax {
            amax = s;
        }
    }
    let mut bmin = f64::INFINITY;
    for i in 0..n_b {
        let s = dot(b, u, d, i * d, 0);
        if s < bmin {
            bmin = s;
        }
    }
    bmin - amax
}

/// packages/ndim/src/gjk.ts: supportDiff. The point of A - B that maximises dir . p (a - b with a
/// maximising dir . a and b minimising dir . b). (The source writes it into an array the caller
/// gives, once with the direction's own array; here it is returned.)
fn support_diff(a: &[f64], n_a: usize, b: &[f64], n_b: usize, d: usize, dir: &[f64]) -> Vec<f64> {
    let mut ia = 0;
    let mut va = f64::NEG_INFINITY;
    for i in 0..n_a {
        let s = dot(a, dir, d, i * d, 0);
        if s > va {
            va = s;
            ia = i;
        }
    }
    let mut ib = 0;
    let mut vb = f64::INFINITY;
    for i in 0..n_b {
        let s = dot(b, dir, d, i * d, 0);
        if s < vb {
            vb = s;
            ib = i;
        }
    }
    let mut out = vec![0.0f64; d];
    for c in 0..d {
        out[c] = a[ia * d + c] - b[ib * d + c];
    }
    out
}

/// packages/ndim/src/gjk.ts: affineMin. Coefficients (sum 1) of the minimum-norm point of the
/// affine hull of the points S, or None if numerically singular.
fn affine_min(s: &[Vec<f64>], d: usize) -> Option<Vec<f64>> {
    let k = s.len();
    let n = k + 1;
    let mut m = vec![0.0f64; n * n];
    for i in 0..k {
        for j in 0..k {
            m[i * n + j] = dot(&s[i], &s[j], d, 0, 0);
        }
        m[i * n + k] = 1.0;
        m[k * n + i] = 1.0;
    }
    let mut rhs = vec![0.0f64; n];
    rhs[k] = 1.0;
    let mut sol = solve(&m, &rhs, n, 1)?;
    sol.truncate(k);
    Some(sol)
}

/// packages/ndim/src/gjk.ts: ClosestResult.
#[derive(Debug, Clone)]
pub struct ClosestResult {
    /// Distance of conv(A) and conv(B); 0 when they touch or overlap.
    pub dist: f64,
    /// The point a* - b* of A - B nearest the origin; None when the sets touch or overlap
    /// (|w| < 1e-14).
    pub w: Option<Vec<f64>>,
    /// The final corral (affinely independent points of A - B whose hull holds the minimum-norm
    /// point).
    pub corral: Vec<Vec<f64>>,
}

/// packages/ndim/src/gjk.ts: closestPoints. Closest points of conv(A) and conv(B) by GJK / Wolfe's
/// minimum-norm-point algorithm (maxIter = 500, the source's default).
pub fn closest_points(a: &[f64], n_a: usize, b: &[f64], n_b: usize, d: usize) -> ClosestResult {
    const MAX_ITER: usize = 500;
    let mut s: Vec<Vec<f64>> = vec![(0..d).map(|c| a[c] - b[c]).collect()];
    let mut lam: Vec<f64> = vec![1.0];
    let mut x: Vec<f64> = s[0].clone();
    let mut neg = vec![0.0f64; d];
    let mut last = f64::INFINITY;
    for _it in 0..MAX_ITER {
        let xx = dot(&x, &x, d, 0, 0);
        if xx < 1e-28 {
            return ClosestResult { dist: 0.0, w: None, corral: s };
        }
        for c in 0..d {
            neg[c] = -x[c];
        }
        let p = support_diff(a, n_a, b, n_b, d, &neg); // minimises x . p
        if xx - dot(&x, &p, d, 0, 0) <= 1e-15 + 1e-14 * xx {
            break; // no support point is lower than x, to the noise of the coordinates
        }
        if xx >= last * (1.0 - 1e-15) {
            break; // stalled at the rounding level
        }
        last = xx;
        if s.iter().any(|q| (0..d).all(|c| (q[c] - p[c]).abs() < 1e-15)) {
            break;
        }
        s.push(p);
        lam.push(0.0);
        loop {
            let Some(mu) = affine_min(&s, d) else {
                s.pop();
                lam.pop();
                break;
            };
            if mu.iter().all(|&m| m > 1e-14) {
                lam = mu;
                break;
            }
            let mut theta = 1.0f64;
            for i in 0..lam.len() {
                if mu[i] <= 1e-14 {
                    let den = lam[i] - mu[i];
                    theta = math::min(theta, if den > 1e-300 { lam[i] / den } else { 0.0 });
                }
            }
            theta = math::max(0.0, theta);
            for i in 0..lam.len() {
                lam[i] = (1.0 - theta) * lam[i] + theta * mu[i];
            }
            let mut keep: Vec<usize> = (0..lam.len()).filter(|&i| lam[i] > 1e-14).collect();
            if keep.len() == lam.len() {
                let mut imin = 0;
                for i in 1..lam.len() {
                    if lam[i] < lam[imin] {
                        imin = i;
                    }
                }
                keep.retain(|&i| i != imin);
            }
            s = keep.iter().map(|&i| s[i].clone()).collect();
            lam = keep.iter().map(|&i| lam[i]).collect();
            // `lam.reduce((a, b) => a + b, 0)`
            let mut tot = 0.0f64;
            for &l in &lam {
                tot += l;
            }
            for l in lam.iter_mut() {
                *l /= tot;
            }
        }
        x = vec![0.0f64; d];
        for i in 0..s.len() {
            for c in 0..d {
                x[c] += lam[i] * s[i][c];
            }
        }
    }
    ClosestResult { dist: dot(&x, &x, d, 0, 0).sqrt(), w: Some(x), corral: s }
}

// ------------------------------------------------------------------------------------------- EPA
//
// The source keeps each facet as an object { idx, n, off, alive } and builds a Float64Array per
// normal; here the facets and the points are rows of flat arrays (the expansion makes thousands of
// facets per call in 8 to 10 dimensions, and one allocation per facet was most of the time). The
// facets are the same, in the same order, and every number is computed by the same operations.

/// packages/ndim/src/gjk.ts: nullVector. A unit vector orthogonal to the d - 1 rows (r x d),
/// written to `n`; false if the rows are dependent. The source works on a copy of the rows; here
/// the rows are overwritten (the caller fills them again for every facet), and `used`, `piv_col`
/// and `piv_row` are the caller's scratch arrays (of d entries).
fn null_vector(m: &mut [f64], r: usize, d: usize, used: &mut [bool], piv_col: &mut [usize], piv_row: &mut [f64], n: &mut [f64]) -> bool {
    used.fill(false);
    let mut scale = 0.0f64;
    for &v in m.iter() {
        scale = math::max(scale, v.abs());
    }
    if !(scale > 0.0) {
        return false;
    }
    for k in 0..r {
        let mut bi = usize::MAX;
        let mut bj = usize::MAX;
        let mut bv = 0.0f64;
        for i in k..r {
            let row = &m[i * d..i * d + d];
            for j in 0..d {
                if !used[j] && row[j].abs() > bv {
                    bv = row[j].abs();
                    bi = i;
                    bj = j;
                }
            }
        }
        if !(bv > 1e-13 * scale) {
            return false;
        }
        if bi != k {
            for j in 0..d {
                m.swap(k * d + j, bi * d + j);
            }
        }
        used[bj] = true;
        piv_col[k] = bj;
        let piv = m[k * d + bj];
        for j in 0..d {
            m[k * d + j] /= piv;
        }
        piv_row[..d].copy_from_slice(&m[k * d..k * d + d]);
        for i in 0..r {
            if i == k {
                continue;
            }
            let row = &mut m[i * d..i * d + d];
            let f = row[bj];
            if f != 0.0 {
                for (x, &p) in row.iter_mut().zip(piv_row.iter()) {
                    *x -= f * p;
                }
            }
        }
    }
    // r = d - 1 pivots leave one column free
    let Some(free) = used.iter().position(|u| !u) else {
        return false;
    };
    n.fill(0.0);
    n[free] = 1.0;
    for k in 0..r {
        n[piv_col[k]] = -m[k * d + free];
    }
    let mut len = 0.0f64;
    for c in 0..d {
        len += n[c] * n[c];
    }
    let len = len.sqrt();
    for c in 0..d {
        n[c] /= len;
    }
    true
}

/// packages/ndim/src/gjk.ts: PenetrationResult.
#[derive(Debug, Clone)]
pub struct PenetrationResult {
    /// Lower bound of the penetration depth of A and B (converging to it from below).
    pub depth: f64,
    /// Whether the expansion ended with a facet of A - B. False: the iteration or facet cap was
    /// reached, or the polytope degenerated (a facet that could not be built); `depth` is then a
    /// lower bound that may be far below the true depth, and 0 when not even a starting simplex
    /// could be built. Callers must not accept a pair on an unconverged depth.
    pub converged: bool,
    /// The unit outward normal of that facet: moving B by depth * normal (relative to A) separates
    /// the two.
    pub normal: Option<Vec<f64>>,
}

/// A point is added to the starting simplex only if it lies this far (absolute, the pieces have
/// unit edge) off the hull so far.
const RANK_TOL: f64 = 1e-9;

/// packages/ndim/src/gjk.ts: lcg. A deterministic stream of numbers in [-1, 1) for the random
/// fallback directions (`Math.imul` and `>>> 0` are the 32-bit operations).
struct Lcg(u32);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.0 as f64 / 2147483648.0) * 1.0 - 1.0
    }
}

/// The points and the orthonormal basis of the hull so far (the closures of startingSimplex).
struct Hull {
    d: usize,
    pts: Vec<Vec<f64>>,
    basis: Vec<Vec<f64>>,
}
impl Hull {
    /// Removes from v its components along the basis (twice, for orthogonality to rounding) and
    /// returns its length.
    fn reduce(&self, v: &mut [f64]) -> f64 {
        let d = self.d;
        for _pass in 0..2 {
            for b in &self.basis {
                let f = dot(v, b, d, 0, 0);
                for c in 0..d {
                    v[c] -= f * b[c];
                }
            }
        }
        dot(v, v, d, 0, 0).sqrt()
    }
    fn off_hull(&self, p: &[f64]) -> Vec<f64> {
        (0..self.d).map(|c| p[c] - self.pts[0][c]).collect()
    }
    fn try_add(&mut self, p: &[f64], tol: f64) -> bool {
        if self.pts.is_empty() {
            self.pts.push(p.to_vec());
            return true;
        }
        let mut v = self.off_hull(p);
        let l = self.reduce(&mut v);
        if !(l > tol) {
            return false;
        }
        for c in 0..self.d {
            v[c] /= l;
        }
        self.basis.push(v);
        self.pts.push(p.to_vec());
        true
    }
}

/// packages/ndim/src/gjk.ts: startingSimplex. d + 1 affinely independent points of A - B to start
/// EPA, or None if A - B is numerically flat. The corral's points come first (those that are
/// independent, so the origin stays inside the simplex when GJK's simplex held it). Each of the
/// others is the support point of A - B in a direction orthogonal to the hull so far, in the sign
/// that moves farther off it: the width of A - B in that direction is positive, so one of the two
/// signs always lifts the rank, whatever ties the vertex lists have. Directions: the coordinate
/// axis with the largest component outside the hull first, then seeded random ones.
fn starting_simplex(a: &[f64], n_a: usize, b: &[f64], n_b: usize, d: usize, corral: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let mut hull = Hull { d, pts: Vec::new(), basis: Vec::new() };
    for q in corral {
        hull.try_add(q, 1e-8);
    }
    if hull.pts.is_empty() {
        let mut e0 = vec![0.0f64; d];
        e0[0] = 1.0;
        let e0 = support_diff(a, n_a, b, n_b, d, &e0);
        hull.try_add(&e0, 0.0);
    }
    let mut rnd = Lcg(0x9e3779b9);
    let mut dir = vec![0.0f64; d];
    let mut attempts = 0usize;
    while hull.pts.len() < d + 1 {
        let before = attempts;
        attempts += 1;
        if before > 4 * d + 16 {
            return None;
        }
        // the candidate direction: orthogonal to the hull so far
        if attempts <= 1 || attempts % 3 == 1 {
            let mut found = false;
            let mut bl = 0.0f64;
            for i in 0..d {
                let mut e = vec![0.0f64; d];
                e[i] = 1.0;
                let l = hull.reduce(&mut e);
                if l > bl + 1e-12 {
                    bl = l;
                    found = true;
                    dir.copy_from_slice(&e);
                }
            }
            if !found || !(bl > 1e-6) {
                continue;
            }
            for c in 0..d {
                dir[c] /= bl;
            }
        } else {
            for c in 0..d {
                dir[c] = rnd.next();
            }
            let l = hull.reduce(&mut dir);
            if !(l > 1e-3) {
                continue;
            }
            for c in 0..d {
                dir[c] /= l;
            }
        }
        let p1 = support_diff(a, n_a, b, n_b, d, &dir);
        for c in 0..d {
            dir[c] = -dir[c];
        }
        let p2 = support_diff(a, n_a, b, n_b, d, &dir);
        let r1 = hull.reduce(&mut hull.off_hull(&p1));
        let r2 = hull.reduce(&mut hull.off_hull(&p2));
        hull.try_add(if r1 >= r2 { &p1 } else { &p2 }, RANK_TOL);
    }
    Some(hull.pts)
}

/// The facet count at which EPA gives up (the expansion in 8 to 10 dimensions grows by thousands of
/// facets per step).
const MAX_EPA_FACES: usize = 12000;

/// The polytope EPA grows: its points (rows of `pts`) and its facets, alive or not, in the order
/// they were made (`idx`: d point indices each; `n`: the unit outward normal; `off`: n . a point of
/// the facet).
struct Expansion {
    d: usize,
    pts: Vec<f64>,
    /// The reference point inside every hull we build: the centroid of the initial simplex.
    c0: Vec<f64>,
    idx: Vec<u32>,
    n: Vec<f64>,
    off: Vec<f64>,
    alive: Vec<bool>,
    // scratch of make_face
    rows: Vec<f64>,
    used: Vec<bool>,
    piv_col: Vec<usize>,
    piv_row: Vec<f64>,
    normal: Vec<f64>,
}

impl Expansion {
    fn faces(&self) -> usize {
        self.off.len()
    }
    fn normal_of(&self, f: usize) -> &[f64] {
        &self.n[f * self.d..(f + 1) * self.d]
    }
    /// The closure `makeFace` of penetrationDepth: the facet through the d points `idx`, its normal
    /// turned away from the reference point c0, added to the list; false when the points are
    /// dependent.
    fn make_face(&mut self, idx: &[u32]) -> bool {
        let d = self.d;
        let q0 = idx[0] as usize * d;
        for k in 1..d {
            let qk = idx[k] as usize * d;
            for c in 0..d {
                self.rows[(k - 1) * d + c] = self.pts[qk + c] - self.pts[q0 + c];
            }
        }
        if !null_vector(&mut self.rows, d - 1, d, &mut self.used, &mut self.piv_col, &mut self.piv_row, &mut self.normal) {
            return false;
        }
        let q0 = &self.pts[q0..q0 + d];
        let n = &mut self.normal;
        let mut s = 0.0f64;
        for c in 0..d {
            s += n[c] * (self.c0[c] - q0[c]);
        }
        if s > 0.0 {
            for c in 0..d {
                n[c] = -n[c];
            }
        }
        self.off.push(dot(n, q0, d, 0, 0));
        self.n.extend_from_slice(n);
        self.idx.extend_from_slice(idx);
        self.alive.push(true);
        true
    }
    /// packages/ndim/src/gjk.ts: unconverged.
    fn unconverged(&self, best: f64) -> PenetrationResult {
        let mut m = f64::INFINITY;
        let mut fm: Option<usize> = None;
        for g in 0..self.faces() {
            if self.alive[g] && self.off[g] < m {
                m = self.off[g];
                fm = Some(g);
            }
        }
        PenetrationResult {
            depth: math::max(0.0, if m.is_finite() { m } else { best }),
            converged: false,
            normal: fm.map(|f| self.normal_of(f).to_vec()),
        }
    }
}

/// packages/ndim/src/gjk.ts: penetrationDepth. Penetration depth of two overlapping (or touching)
/// convex hulls by EPA, started from the corral of a GJK run that ended with the origin inside
/// A - B (maxIter = 600, the source's default). Never reports a failure as a depth of 0 with
/// converged = true: see PenetrationResult.
pub fn penetration_depth(a: &[f64], n_a: usize, b: &[f64], n_b: usize, d: usize, corral: &[Vec<f64>]) -> PenetrationResult {
    const MAX_ITER: usize = 600;
    let Some(start) = starting_simplex(a, n_a, b, n_b, d, corral) else {
        return PenetrationResult { depth: 0.0, converged: false, normal: None };
    };
    // the reference point c0 inside every hull we build: the centroid of the initial simplex
    let mut c0 = vec![0.0f64; d];
    let np = start.len() as f64;
    for q in &start {
        for c in 0..d {
            c0[c] += q[c] / np;
        }
    }
    let mut e = Expansion {
        d,
        pts: start.concat(),
        c0,
        idx: Vec::new(),
        n: Vec::new(),
        off: Vec::new(),
        alive: Vec::new(),
        rows: vec![0.0f64; (d - 1) * d],
        used: vec![false; d],
        piv_col: vec![0; d],
        piv_row: vec![0.0f64; d],
        normal: vec![0.0f64; d],
    };
    let mut n_pts = start.len();
    let mut idx: Vec<u32> = Vec::with_capacity(d);
    for omit in 0..=d {
        idx.clear();
        idx.extend((0..n_pts as u32).filter(|&i| i as usize != omit));
        e.make_face(&idx);
    }
    if e.faces() < d + 1 {
        return PenetrationResult { depth: 0.0, converged: false, normal: None };
    }
    let mut best = 0.0f64;
    let mut visible: Vec<usize> = Vec::new();
    // the ridges of the visible facets: (the d - 1 point indices in ascending order, packed 12 bits each into one
    // number, and the place in the order the ridges were met)
    assert!(d <= 11 && MAX_ITER + d + 1 < 4096, "the ridge keys hold d - 1 indices of 12 bits");
    let mut ridges: Vec<(u128, usize)> = Vec::new();
    let mut ridge: Vec<u32> = Vec::with_capacity(d);
    let mut once: Vec<usize> = Vec::new();
    for _it in 0..MAX_ITER {
        let mut fi: Option<usize> = None;
        let mut f_off = 0.0f64;
        for g in 0..e.faces() {
            if e.alive[g] && (fi.is_none() || e.off[g] < f_off) {
                fi = Some(g);
                f_off = e.off[g];
            }
        }
        let Some(fi) = fi else {
            break;
        };
        best = math::max(best, f_off);
        let p = support_diff(a, n_a, b, n_b, d, e.normal_of(fi));
        let gain = dot(e.normal_of(fi), &p, d, 0, 0) - f_off;
        if gain <= 1e-12 * (1.0 + f_off.abs()) {
            return PenetrationResult { depth: math::max(0.0, f_off), converged: true, normal: Some(e.normal_of(fi).to_vec()) };
        }
        let pi = n_pts as u32;
        visible.clear();
        for g in 0..e.faces() {
            if e.alive[g] && dot(&e.n, &p, d, g * d, 0) - e.off[g] > 1e-11 {
                visible.push(g);
            }
        }
        e.pts.extend_from_slice(&p);
        n_pts += 1;
        if visible.is_empty() {
            return PenetrationResult { depth: math::max(0.0, f_off), converged: true, normal: Some(e.normal_of(fi).to_vec()) };
        }
        // The source counts, in a Map keyed by the ridge, how many visible facets each ridge belongs to, and then
        // builds a facet on every ridge counted once, in the order the ridges were first met. A ridge counted once
        // was met once, so that order is the order of meeting: the ridges are sorted to find the repeated ones, and
        // the others are put back in the order they were met.
        ridges.clear();
        for &g in &visible {
            e.alive[g] = false;
            for skip in 0..d {
                ridge.clear();
                ridge.extend(e.idx[g * d..(g + 1) * d].iter().enumerate().filter(|&(k, _)| k != skip).map(|(_, &v)| v));
                ridge.sort_unstable();
                let key = ridge.iter().fold(0u128, |key, &v| (key << 12) | v as u128);
                let met = ridges.len();
                ridges.push((key, met));
            }
        }
        ridges.sort_unstable();
        once.clear();
        let mut k = 0;
        while k < ridges.len() {
            let mut j = k + 1;
            while j < ridges.len() && ridges[j].0 == ridges[k].0 {
                j += 1;
            }
            if j == k + 1 {
                once.push(k);
            }
            k = j;
        }
        once.sort_unstable_by_key(|&k| ridges[k].1);
        for &k in &once {
            idx.clear();
            idx.extend((0..d - 1).map(|c| ((ridges[k].0 >> (12 * (d - 2 - c))) & 0xfff) as u32));
            idx.push(pi);
            // a facet that cannot be built leaves a hole in the hull, and the nearest facet of a polytope with a hole can be
            // too far: stop, unconverged, instead of going on
            if !e.make_face(&idx) {
                return e.unconverged(best);
            }
        }
        if e.faces() > MAX_EPA_FACES {
            break;
        }
    }
    e.unconverged(best)
}

/// GJK distances below this are not trusted (it can stall with a point of about 1e-14 inside an
/// overlap): EPA decides.
const TOUCH: f64 = 1e-12;

/// packages/ndim/src/gjk.ts: Separation.
#[derive(Debug, Clone)]
pub struct Separation {
    /// The signed separation: the distance when disjoint, minus the penetration depth when
    /// overlapping. Exact to about 1e-11 when `converged`. Otherwise an estimate: `lower`, a
    /// certified lower bound that may be below the true value, except for disjoint pieces closer
    /// than GJK can certify (about 1e-7), where it is GJK's distance, and for an EPA that stopped
    /// early, where it is minus its depth so far (an upper bound of the separation, usually close).
    pub sep: f64,
    /// Disjoint: the unit normal, pointing from A to B, of a separating hyperplane achieving sep.
    /// Overlapping: the unit direction in which moving B by |sep| separates the two. None if none
    /// was found.
    pub dir: Option<Vec<f64>>,
    /// Whether `sep` is the exact value (GJK's distance, or EPA ended with a facet of A - B), not a
    /// bound.
    pub converged: bool,
    /// A certified lower bound of the true signed separation: the gap of a unit vector (gap_along),
    /// so that lower >= -tol proves the pair is separated within tol. -Infinity when none was
    /// found.
    pub lower: f64,
    /// An upper bound of the true signed separation: GJK's distance, minus EPA's depth (a lower
    /// bound of the depth), or the LP's bound; so that upper < -tol proves an overlap by more than
    /// tol. +Infinity when unknown.
    pub upper: f64,
    /// The unit vector of `lower` (pointing from A to B), None if none.
    pub lower_dir: Option<Vec<f64>>,
}

/// packages/ndim/src/gjk.ts: signedSeparation. The signed separation of conv(A) and conv(B) (see
/// the module comment). `tol` is SeparationOptions.tol: the pair is only to be decided against this
/// tolerance (the validator's), so the LP fallback stops as soon as the verdict is clear; None is
/// full accuracy. Never reports a failure of EPA as a separation of 0: when EPA does not converge,
/// or its normal does not certify its depth, the max-margin LP (margin.rs) decides, and if that is
/// inconclusive, `lower` and `upper` bracket the answer (`sep` is `lower`).
pub fn signed_separation(a: &[f64], n_a: usize, b: &[f64], n_b: usize, d: usize, tol: Option<f64>) -> Separation {
    let c = closest_points(a, n_a, b, n_b, d);
    // below TOUCH the sets may touch or overlap (GJK can stall near the origin with a tiny nonzero point): EPA decides
    if let Some(w) = c.w.as_ref().filter(|_| c.dist >= TOUCH) {
        let dir: Vec<f64> = (0..d).map(|i| -w[i] / c.dist).collect();
        let lower = gap_along(a, n_a, b, n_b, d, &dir);
        if lower >= c.dist - 1e-9 {
            return Separation {
                sep: c.dist,
                dir: Some(dir.clone()),
                converged: true,
                lower,
                upper: c.dist,
                lower_dir: Some(dir),
            };
        }
        // GJK's direction -w / |w| has an error of about 1e-16 / |w| radians, so below |w| ~ 1e-7 its gap does not certify
        // the distance (and GJK stops at a tolerance of 1e-15 in |w|^2, which does not prove it either): the LP certifies
        let r = fallback(a, n_a, b, n_b, d, &c.corral, tol, lower, c.dist, Some(dir));
        return Separation { sep: c.dist, ..r };
    }
    let e = penetration_depth(a, n_a, b, n_b, d, &c.corral);
    if let (true, Some(normal)) = (e.converged, e.normal.as_ref()) {
        // the normal certifies the depth: moving B along it must separate, i.e. its gap is -depth
        let lower = gap_along(a, n_a, b, n_b, d, normal);
        if lower >= -e.depth - 1e-9 {
            return Separation {
                sep: -e.depth,
                dir: Some(normal.clone()),
                converged: true,
                lower,
                upper: -e.depth,
                lower_dir: Some(normal.clone()),
            };
        }
        return fallback(a, n_a, b, n_b, d, &c.corral, tol, lower, TOUCH - e.depth, Some(normal.clone()));
    }
    let r = fallback(a, n_a, b, n_b, d, &c.corral, tol, f64::NEG_INFINITY, TOUCH - e.depth, None);
    // EPA's depth so far is a lower bound of the depth and, in practice, close to it (the expansion stopped near the
    // origin's nearest facet): a better estimate than the certified lower bound, but only as an estimate
    if e.depth > 0.0 && e.normal.is_some() {
        Separation { sep: math::max(r.lower, -e.depth), ..r }
    } else {
        r
    }
}

/// packages/ndim/src/gjk.ts: fallback. The LP verdict, merged with what GJK / EPA proved
/// (`have_lower`, `have_upper`, `have_dir` are the source's `have`).
#[allow(clippy::too_many_arguments)]
fn fallback(
    a: &[f64],
    n_a: usize,
    b: &[f64],
    n_b: usize,
    d: usize,
    corral: &[Vec<f64>],
    tol: Option<f64>,
    have_lower: f64,
    have_upper: f64,
    have_dir: Option<Vec<f64>>,
) -> Separation {
    let opts = match tol {
        None => MarginOptions::default(),
        Some(tol) => {
            MarginOptions { accept_at: Some(-tol), refuse_below: Some(-(d as f64).sqrt() * tol), ..Default::default() }
        }
    };
    // the LP's cuts are points of B - A; the corral holds points of A - B, so they are negated (with the sign of A - B the
    // cuts exclude valid directions, and a separated pair at a gap of 1e-7 was reported as overlapping)
    let seed: Vec<Vec<f64>> = corral.iter().map(|w| w.iter().map(|x| -x).collect()).collect();
    let r = max_margin_separation(a, n_a, b, n_b, d, &opts, &seed);
    let mut lower = have_lower;
    let mut lower_dir = have_dir;
    if r.lower > lower {
        lower = r.lower;
        lower_dir = r.dir;
    }
    let upper = math::min(have_upper, r.upper);
    Separation { sep: lower, dir: lower_dir.clone(), converged: false, lower, upper, lower_dir }
}
