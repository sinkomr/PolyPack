//! The smallest enclosing container of an arrangement at a given orientation, and the search for
//! the orientation that minimises it.
//!
//! The functions named after packages/geometry/src/enclose.ts (`convex_hull`, `extreme_points`,
//! `enclosing_polygon`, `enclosing_circle`, `enclose_set`, `enclose`, `auto_orient_set`,
//! `auto_orient`) are its port, operation for operation: the monotone-chain hull, the dual of the
//! enclosing LP solved by enumerating its bases, Welzl's circle. A score computed with them is the
//! server's, up to the last place of a sine.
//!
//! The search calls an enclosing container millions of times, and for it the same file holds a
//! faster solver that is NOT the source's: [`PolygonEncloser`] and [`Encloser`], with the
//! `*_fast` functions, find the LP's optimum by an active-set ascent instead of the enumeration
//! (M^3 / 24 bases for a many-sided container). The two agree to about 1e-14 relative and give the
//! same double except on ties; only the search uses the fast one.

use crate::math;
use std::cell::RefCell;
use std::rc::Rc;
use crate::shapes::{circumradius, inradius, piece_vertices_into, Container, Pose, DISK_RADIUS};
use std::f64::consts::PI;

/// The convex hull of the piece vertices (polygon pieces, pad 0) or of the centres (disks, pad =
/// the disk radius times the scale). `pts` is [x0, y0, x1, y1, ...].
#[derive(Clone, Debug, Default)]
pub struct PointSet {
    pub pts: Vec<f64>,
    pub pad: f64,
}

/// 2 ** 600, exactly.
const TWO_600: f64 = f64::from_bits((1023 + 600) << 52);

/// enclose.ts: the `cross` of convexHull. Sign-correct cross product (a - o) x (b - o). When both products round to zero the factors are
/// rescaled by 2^600 each, so an underflowed product of two non-zero factors keeps its sign
/// (a point that is not on the segment is not dropped).
#[inline]
fn cross(pts: &[f64], o: usize, a: usize, b: usize) -> f64 {
    let ax = pts[2 * a] - pts[2 * o];
    let ay = pts[2 * a + 1] - pts[2 * o + 1];
    let bx = pts[2 * b] - pts[2 * o];
    let by = pts[2 * b + 1] - pts[2 * o + 1];
    let p = ax * by;
    let q = ay * bx;
    if p != 0.0 || q != 0.0 {
        return p - q;
    }
    let s = TWO_600;
    let scaled = |u: f64, v: f64| if u == 0.0 || v == 0.0 { 0.0 } else { u * s * (v * s) };
    scaled(ax, by) - scaled(ay, bx)
}

/// enclose.ts: convexHull. Convex hull by Andrew's monotone chain: flat counter-clockwise points,
/// collinear points dropped. The points are sorted by x, then y, with a stable sort, as the
/// source's comparator `x_a - x_b || y_a - y_b` orders finite coordinates. (For a coordinate that
/// is not a number the source's order is whatever V8's sort makes of an inconsistent comparator;
/// `parse_config` admits finite coordinates only.)
pub fn convex_hull(pts: &[f64]) -> Vec<f64> {
    let n = pts.len() / 2;
    if n <= 2 {
        return pts.to_vec();
    }
    let mut idx: Vec<u32> = (0..n as u32).collect();
    idx.sort_by(|&a, &b| {
        let (a, b) = (a as usize, b as usize);
        let d = pts[2 * a] - pts[2 * b];
        let d = if d != 0.0 { d } else { pts[2 * a + 1] - pts[2 * b + 1] };
        // the reference sorts with a comparator returning this difference: NaN compares equal
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut hull: Vec<u32> = Vec::with_capacity(2 * n);
    for i in 0..n {
        while hull.len() >= 2
            && cross(pts, hull[hull.len() - 2] as usize, hull[hull.len() - 1] as usize, idx[i] as usize) <= 0.0
        {
            hull.pop();
        }
        hull.push(idx[i]);
    }
    let lower = hull.len() + 1;
    for i in (0..n - 1).rev() {
        while hull.len() >= lower
            && cross(pts, hull[hull.len() - 2] as usize, hull[hull.len() - 1] as usize, idx[i] as usize) <= 0.0
        {
            hull.pop();
        }
        hull.push(idx[i]);
    }
    hull.pop(); // the last point repeats the first
    let mut out = Vec::with_capacity(2 * hull.len());
    for &h in &hull {
        out.push(pts[2 * h as usize]);
        out.push(pts[2 * h as usize + 1]);
    }
    out
}

/// enclose.ts: extremePoints. Hull points and padding that determine every enclosing container of
/// the arrangement.
pub fn extreme_points(n: u32, poses: &[Pose], scale: f64) -> PointSet {
    if n == 0 {
        let mut c = Vec::with_capacity(2 * poses.len());
        for p in poses {
            c.push(p.x);
            c.push(p.y);
        }
        return PointSet { pts: convex_hull(&c), pad: scale * DISK_RADIUS };
    }
    let nv = n as usize;
    let mut all = vec![0.0; 2 * nv * poses.len()];
    for (i, p) in poses.iter().enumerate() {
        piece_vertices_into(n, p, scale, &mut all[2 * nv * i..2 * nv * (i + 1)]);
    }
    PointSet { pts: convex_hull(&all), pad: 0.0 }
}

/// enclose.ts: supports. Support values h_j of the point set along the M outward edge normals of
/// the container.
fn supports(set: &PointSet, m: u32, phi: f64, h: &mut [f64]) {
    let step = 2.0 * PI / m as f64;
    for j in 0..m as usize {
        // normal j belongs to the edge ending at vertex j; j = 0 is the bottom edge at phi = 0
        let ang = phi - PI / 2.0 + j as f64 * step;
        let ux = math::cos(ang);
        let uy = math::sin(ang);
        let mut best = f64::NEG_INFINITY;
        let pts = &set.pts;
        let mut i = 0;
        while i < pts.len() {
            let d = pts[i] * ux + pts[i + 1] * uy;
            if d > best {
                best = d;
            }
            i += 2;
        }
        h[j] = best + set.pad;
    }
}

thread_local! {
    /// enclose.ts: sineTables, per thread.
    static SINE_TABLES: RefCell<Vec<Option<Rc<[f64]>>>> = const { RefCell::new(Vec::new()) };
}

/// enclose.ts: sineTable. sin(2 pi d / M) for d = 0..=M, kept per M (up to 1024 sides; the server
/// admits 100).
fn sine_table(m: u32) -> Rc<[f64]> {
    let make = || -> Rc<[f64]> { (0..=m).map(|d| math::sin((2.0 * PI * d as f64) / m as f64)).collect() };
    if m > 1024 {
        return make();
    }
    SINE_TABLES.with(|tables| {
        let mut tables = tables.borrow_mut();
        if tables.len() <= m as usize {
            tables.resize(m as usize + 1, None);
        }
        tables[m as usize].get_or_insert_with(make).clone()
    })
}

#[derive(Clone, Copy, Debug)]
struct DualOptimum {
    a: f64,
    i: usize,
    j: usize,
    /// None when the optimum is an antipodal pair
    k: Option<usize>,
}

/// enclose.ts: solveDual. Exact solution of the enclosing LP  min a  s.t.  h_j <= a + c . u_j  for all j, through its dual
///   max sum(lambda_j h_j)  s.t.  sum(lambda_j u_j) = 0, sum(lambda_j) = 1, lambda >= 0.
/// A basic dual solution has at most three non-zero weights, so the optimum is the best of the
/// antipodal pairs (M even), (h_i + h_j) / 2, and of the triples whose normals positively span the
/// plane (every angular gap below pi), for which lambda_i is proportional to sin(2 pi d / M), d the
/// index gap between the other two. Every candidate is dual feasible, so the maximum is a*.
fn solve_dual(h: &[f64], m: usize, s: &[f64]) -> DualOptimum {
    let mut best = DualOptimum { a: f64::NEG_INFINITY, i: 0, j: 0, k: None };
    if m % 2 == 0 {
        let half = m / 2;
        for i in 0..half {
            let a = (h[i] + h[i + half]) / 2.0;
            if a > best.a {
                best = DualOptimum { a, i, j: i + half, k: None };
            }
        }
    }
    let mut ta = f64::NEG_INFINITY;
    let (mut ti, mut tj, mut tk) = (0, 0, 0);
    if m >= 3 {
        for i in 0..m - 2 {
            for j in i + 1..m - 1 {
                let d1 = j - i;
                if 2 * d1 >= m {
                    break;
                }
                for k in j + 1..m {
                    let d2 = k - j;
                    if 2 * d2 >= m {
                        break;
                    }
                    let d3 = m - k + i;
                    if 2 * d3 >= m {
                        continue;
                    }
                    let a = (s[d2] * h[i] + s[d3] * h[j] + s[d1] * h[k]) / (s[d1] + s[d2] + s[d3]);
                    if a > ta {
                        ta = a;
                        ti = i;
                        tj = j;
                        tk = k;
                    }
                }
            }
        }
    }
    // On a tie prefer the pair: its centre is found from all constraints, the robust path.
    if ta > best.a {
        best = DualOptimum { a: ta, i: ti, j: tj, k: Some(tk) };
    }
    best
}

/// The dual value of the triple i < j < k, when its normals positively span the plane.
#[inline]
fn triple_value(h: &[f64], m: usize, s: &[f64], i: usize, j: usize, k: usize) -> Option<f64> {
    let (d1, d2) = (j - i, k - j);
    let d3 = m - k + i;
    if 2 * d1 >= m || 2 * d2 >= m || 2 * d3 >= m {
        return None;
    }
    Some((s[d2] * h[i] + s[d3] * h[j] + s[d1] * h[k]) / (s[d1] + s[d2] + s[d3]))
}

/// The best dual basis among the walls of `set` (at most five): antipodal pairs and positively
/// spanning triples, the pair preferred on a tie as in `solve_dual`.
fn best_basis(h: &[f64], m: usize, s: &[f64], set: &[usize]) -> DualOptimum {
    let mut idx: Vec<usize> = set.to_vec();
    idx.sort_unstable();
    idx.dedup();
    let mut best = DualOptimum { a: f64::NEG_INFINITY, i: 0, j: 0, k: None };
    if m % 2 == 0 {
        for &i in &idx {
            if i < m / 2 && idx.contains(&(i + m / 2)) {
                let a = (h[i] + h[i + m / 2]) / 2.0;
                if a > best.a {
                    best = DualOptimum { a, i, j: i + m / 2, k: None };
                }
            }
        }
    }
    let mut triple = DualOptimum { a: f64::NEG_INFINITY, i: 0, j: 0, k: None };
    for x in 0..idx.len() {
        for y in x + 1..idx.len() {
            for z in y + 1..idx.len() {
                if let Some(a) = triple_value(h, m, s, idx[x], idx[y], idx[z]) {
                    if a > triple.a {
                        triple = DualOptimum { a, i: idx[x], j: idx[y], k: Some(idx[z]) };
                    }
                }
            }
        }
    }
    if triple.a > best.a {
        triple
    } else {
        best
    }
}

/// NOT in the source; the search's solver. The same optimum as `solve_dual` by a dual active-set ascent: from a spanning triple, the wall
/// most violated at the basis's centre (or, for an antipodal pair, the two walls that empty the
/// segment of its centres) joins the basis, and the best basis of those few walls replaces it.
/// The value of the small LP rises strictly at every step, so no basis returns; it ends when no
/// wall is violated beyond rounding (1e-14 of the apothem), where the value is a* to that
/// precision. O(M) per step and a handful of steps, instead of the enumeration's M^3 / 24 triples;
/// any step that fails to rise hands over to the enumeration.
fn solve_dual_fast(h: &[f64], m: usize, s: &[f64], cu: &[f64], su: &[f64]) -> DualOptimum {
    if m <= 12 {
        return solve_dual(h, m, s);
    }
    let top = (0..m).fold(0, |b, j| if h[j] > h[b] { j } else { b });
    let mut start = [top, (top + m / 3) % m, (top + 2 * m / 3) % m];
    start.sort_unstable();
    let mut basis = best_basis(h, m, s, &start);
    for _ in 0..4 * m {
        let a = basis.a;
        if !a.is_finite() {
            break;
        }
        let tol = 1e-14 * (a.abs() + 1.0);
        let next_set: Vec<usize>;
        match basis.k {
            Some(_) => {
                // the centre of the triple: c . u = h - a on two of its walls
                let (i, j) = (basis.i, basis.j);
                let (bi, bj) = (h[i] - a, h[j] - a);
                let det = cu[i] * su[j] - su[i] * cu[j];
                let cx = (bi * su[j] - bj * su[i]) / det;
                let cy = (cu[i] * bj - cu[j] * bi) / det;
                let mut worst = 0usize;
                let mut violation = f64::NEG_INFINITY;
                for n in 0..m {
                    let v = h[n] - cx * cu[n] - cy * su[n] - a;
                    if v > violation {
                        violation = v;
                        worst = n;
                    }
                }
                if violation <= tol {
                    return basis;
                }
                next_set = vec![basis.i, basis.j, basis.k.unwrap(), worst];
            }
            None => {
                // the centres of an antipodal pair form a line c = b_i u_i + t w; the other walls
                // bound t to an interval, empty unless the pair is optimal
                let i = basis.i;
                let bi = h[i] - a;
                let (wx, wy) = (-su[i], cu[i]);
                let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::INFINITY);
                let (mut lo_at, mut hi_at) = (i, i);
                for n in 0..m {
                    if n == i || n == basis.j {
                        continue;
                    }
                    let g = wx * cu[n] + wy * su[n];
                    let rhs = h[n] - a - bi * (cu[i] * cu[n] + su[i] * su[n]);
                    if g > 1e-12 {
                        if rhs / g > lo {
                            lo = rhs / g;
                            lo_at = n;
                        }
                    } else if g < -1e-12 && rhs / g < hi {
                        hi = rhs / g;
                        hi_at = n;
                    }
                }
                if lo <= hi + tol {
                    return basis;
                }
                next_set = vec![basis.i, basis.j, lo_at, hi_at];
            }
        }
        let next = best_basis(h, m, s, &next_set);
        if !(next.a > a) {
            break;
        }
        basis = next;
    }
    solve_dual(h, m, s)
}

/// enclose.ts: minApothem. Apothem of the smallest enclosing regular M-gon at orientation phi.
fn min_apothem(set: &PointSet, m: u32, phi: f64, h: &mut [f64], sines: &[f64]) -> f64 {
    supports(set, m, phi, h);
    solve_dual(h, m as usize, sines).a
}

/// enclose.ts: enclosingPolygon. Smallest enclosing regular M-gon (M >= 3) at fixed orientation
/// phi.
pub fn enclosing_polygon(set: &PointSet, m: u32, phi: f64) -> Container {
    if set.pts.is_empty() {
        return Container { m, cx: 0.0, cy: 0.0, phi, size: 0.0 };
    }
    let mut h = vec![0.0; m as usize];
    supports(set, m, phi, &mut h);
    polygon_from_supports(&h, m, phi)
}

/// enclose.ts: polygonFromSupports. The smallest regular M-gon at orientation phi from the
/// supports h along its edge normals.
fn polygon_from_supports(h: &[f64], m: u32, phi: f64) -> Container {
    let sines = sine_table(m);
    polygon_from_dual(h, m, phi, solve_dual(h, m as usize, &sines))
}

/// The body of polygonFromSupports after its call of solveDual: the centre and the side from the
/// optimal basis.
fn polygon_from_dual(h: &[f64], m: u32, phi: f64, optimum: DualOptimum) -> Container {
    let DualOptimum { a, i, j, k } = optimum;
    let count = m as usize;
    let step = (2.0 * PI) / m as f64;
    let ang = |n: usize| phi - PI / 2.0 + n as f64 * step;
    let uix = math::cos(ang(i));
    let uiy = math::sin(ang(i));
    let bi = h[i] - a;
    let (cx, cy);
    if k.is_some() {
        // Three active constraints fix the centre; solve the two equations c . u = h - a for i and j.
        let ujx = math::cos(ang(j));
        let ujy = math::sin(ang(j));
        let bj = h[j] - a;
        let det = uix * ujy - uiy * ujx;
        cx = (bi * ujy - bj * uiy) / det;
        cy = (uix * bj - ujx * bi) / det;
    } else {
        // Two opposite edges are tight, so the centre lies on the line c = bi u_i + t w with w
        // perpendicular to u_i. The other constraints bound t to an interval; take its midpoint.
        let wx = -uiy;
        let wy = uix;
        let mut lo = f64::NEG_INFINITY;
        let mut hi = f64::INFINITY;
        for n in 0..count {
            if n == i || n == j {
                continue;
            }
            let ux = math::cos(ang(n));
            let uy = math::sin(ang(n));
            let g = wx * ux + wy * uy;
            let rhs = h[n] - a - bi * (uix * ux + uiy * uy);
            if g > 1e-12 {
                lo = math::max(lo, rhs / g);
            } else if g < -1e-12 {
                hi = math::min(hi, rhs / g);
            }
        }
        let t = (lo + hi) / 2.0;
        cx = bi * uix + t * wx;
        cy = bi * uiy + t * wy;
    }
    Container { m, cx, cy, phi, size: 2.0 * a * math::tan(PI / m as f64) }
}

/// NOT in the source; the search's solver. Reusable work space for the enclosing polygon of one
/// container shape M, with the active-set dual ([`solve_dual_fast`]).
#[derive(Clone, Debug)]
pub struct PolygonEncloser {
    pub m: u32,
    sines: Rc<[f64]>,
    h: Vec<f64>,
    /// Wall normals at phi = 0 (the LP is the same in the container's own frame).
    cu: Vec<f64>,
    su: Vec<f64>,
}

impl PolygonEncloser {
    pub fn new(m: u32) -> Self {
        let angles: Vec<f64> = (0..m).map(|j| -PI / 2.0 + j as f64 * 2.0 * PI / m as f64).collect();
        PolygonEncloser {
            m,
            sines: sine_table(m),
            h: vec![0.0; m as usize],
            cu: angles.iter().map(|&a| math::cos(a)).collect(),
            su: angles.iter().map(|&a| math::sin(a)).collect(),
        }
    }

    /// Apothem of the smallest enclosing regular M-gon at orientation phi.
    pub fn min_apothem(&mut self, set: &PointSet, phi: f64) -> f64 {
        let m = self.m;
        supports(set, m, phi, &mut self.h);
        solve_dual_fast(&self.h, m as usize, &self.sines, &self.cu, &self.su).a
    }

    /// Smallest enclosing regular M-gon (M >= 3) at orientation phi.
    pub fn enclose(&mut self, set: &PointSet, phi: f64) -> Container {
        if set.pts.is_empty() {
            return Container { m: self.m, cx: 0.0, cy: 0.0, phi, size: 0.0 };
        }
        supports(set, self.m, phi, &mut self.h);
        self.from_supports(&self.h, phi)
    }

    /// The smallest regular M-gon at orientation phi from the supports h along its edge normals.
    pub fn from_supports(&self, h: &[f64], phi: f64) -> Container {
        polygon_from_dual(h, self.m, phi, solve_dual_fast(h, self.m as usize, &self.sines, &self.cu, &self.su))
    }
}

/// enclose.ts: shuffledOrder. Deterministic shuffle, so that client and server visit points in the
/// same order.
fn shuffled_order(n: usize) -> Vec<u32> {
    let mut order: Vec<u32> = (0..n as u32).collect();
    let mut seed: u32 = 0x9e37_79b9;
    for i in (1..n).rev() {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let j = (seed % (i as u32 + 1)) as usize;
        order.swap(i, j);
    }
    order
}

/// enclose.ts: enclosingCircle. Smallest enclosing circle of the point set (Welzl's algorithm,
/// iterative form); its size is the diameter.
pub fn enclosing_circle(set: &PointSet) -> Container {
    let pts = &set.pts;
    let n = pts.len() / 2;
    if n == 0 {
        return Container { m: 0, cx: 0.0, cy: 0.0, phi: 0.0, size: 0.0 };
    }
    let o = shuffled_order(n);
    let x = |i: usize| pts[2 * o[i] as usize];
    let y = |i: usize| pts[2 * o[i] as usize + 1];
    let mut cx = x(0);
    let mut cy = y(0);
    let mut r = 0.0f64;
    // relative slack so that points on the boundary do not retrigger a rebuild
    let outside = |i: usize, cx: f64, cy: f64, r: f64| math::hypot(x(i) - cx, y(i) - cy) > r * (1.0 + 1e-13) + 1e-15;
    for i in 1..n {
        if !outside(i, cx, cy, r) {
            continue;
        }
        cx = x(i);
        cy = y(i);
        r = 0.0;
        for j in 0..i {
            if !outside(j, cx, cy, r) {
                continue;
            }
            // from2
            cx = (x(i) + x(j)) / 2.0;
            cy = (y(i) + y(j)) / 2.0;
            r = math::hypot(x(i) - x(j), y(i) - y(j)) / 2.0;
            for k in 0..j {
                if outside(k, cx, cy, r) {
                    // from3
                    let bx = x(j) - x(i);
                    let by = y(j) - y(i);
                    let dx = x(k) - x(i);
                    let dy = y(k) - y(i);
                    let det = 2.0 * (bx * dy - by * dx);
                    if det.abs() < 1e-300 {
                        continue; // collinear: the two-point circle already covers them
                    }
                    let b2 = bx * bx + by * by;
                    let d2 = dx * dx + dy * dy;
                    let ux = (dy * b2 - by * d2) / det;
                    let uy = (bx * d2 - dx * b2) / det;
                    cx = x(i) + ux;
                    cy = y(i) + uy;
                    r = math::hypot(ux, uy);
                }
            }
        }
    }
    Container { m: 0, cx, cy, phi: 0.0, size: 2.0 * (r + set.pad) }
}

/// enclose.ts: encloseSet. Smallest enclosing container of shape M at orientation phi (phi is
/// ignored for circles).
pub fn enclose_set(set: &PointSet, m: u32, phi: f64) -> Container {
    if m == 0 {
        enclosing_circle(set)
    } else {
        enclosing_polygon(set, m, phi)
    }
}

/// NOT in the source: [`enclose_set`] with the search's solver.
pub fn enclose_set_fast(set: &PointSet, m: u32, phi: f64) -> Container {
    if m == 0 {
        enclosing_circle(set)
    } else {
        PolygonEncloser::new(m).enclose(set, phi)
    }
}

/// enclose.ts: EPS. Unit roundoff of a double, 2 ** -53.
const EPS: f64 = 1.0 / 9007199254740992.0;
/// enclose.ts: MAX_CANDIDATES. Most candidate pieces along one normal before candidate_supports
/// leaves the support to the hull.
const MAX_CANDIDATES: usize = 8;

/// enclose.ts: candidateSupports (its Map of vertices is the buffer `verts` with the flags `have`).
/// The supports the hull of all the vertices gives, the same doubles, found from the vertices of a few candidate
/// pieces (polygon pieces and container only); false when that cannot be vouched for.
///
/// Along a normal u a piece reaches at most c.u + R and at least c.u + r, so only pieces whose
/// centre lies within R - r of the highest centre can attain the support (with a 1e-12 C margin,
/// C bounding every vertex coordinate). The largest vertex value is the hull's support when it
/// beats the second largest by 64 eps C (see the reference for the rounding argument); otherwise
/// the hull decides.
fn candidate_supports(n: u32, poses: &[Pose], m: u32, phi: f64, h: &mut [f64], verts: &mut Vec<f64>, have: &mut Vec<bool>) -> bool {
    let big_r = circumradius(n);
    let r = inradius(n);
    let mut max_abs = 0.0f64;
    for p in poses {
        max_abs = math::max(math::max(max_abs, p.x.abs()), p.y.abs());
    }
    let c = max_abs + big_r;
    let reach = big_r - r + 1e-12 * c;
    let tie = 64.0 * EPS * c;
    let step = 2.0 * PI / m as f64;
    let nv = n as usize;
    verts.resize(2 * nv * poses.len(), 0.0);
    have.clear();
    have.resize(poses.len(), false);
    for j in 0..m as usize {
        let ang = phi - PI / 2.0 + j as f64 * step;
        let ux = math::cos(ang);
        let uy = math::sin(ang);
        let mut top = f64::NEG_INFINITY;
        for p in poses {
            let d = p.x * ux + p.y * uy;
            if d > top {
                top = d;
            }
        }
        let mut count = 0;
        for p in poses {
            if p.x * ux + p.y * uy >= top - reach {
                count += 1;
                if count > MAX_CANDIDATES {
                    return false;
                }
            }
        }
        let mut first = f64::NEG_INFINITY;
        let mut second = f64::NEG_INFINITY;
        for (i, p) in poses.iter().enumerate() {
            if p.x * ux + p.y * uy < top - reach {
                continue;
            }
            let v = &mut verts[2 * nv * i..2 * nv * (i + 1)];
            if !have[i] {
                piece_vertices_into(n, p, 1.0, v);
                have[i] = true;
            }
            let mut k = 0;
            while k < v.len() {
                let d = v[k] * ux + v[k + 1] * uy;
                if d > first {
                    second = first;
                    first = d;
                } else if d > second {
                    second = d;
                }
                k += 2;
            }
        }
        if !(first - second > tie) {
            return false;
        }
        h[j] = first + 0.0;
    }
    true
}

/// enclose.ts: enclose. Smallest enclosing container of N-gon (or circle) pieces at the given
/// poses: the server's score routine. For polygon pieces in a polygon container the supports come
/// from a few candidate pieces (candidate_supports), the same doubles as from the hull of all N P
/// vertices at a small part of the cost; the hull is built only when they cannot be vouched for.
pub fn enclose(n: u32, poses: &[Pose], m: u32, phi: f64) -> Container {
    if n >= 3 && m >= 3 && !poses.is_empty() {
        let mut h = vec![0.0; m as usize];
        let mut verts = Vec::new();
        let mut have = Vec::new();
        if candidate_supports(n, poses, m, phi, &mut h, &mut verts, &mut have) {
            return polygon_from_supports(&h, m, phi);
        }
    }
    enclose_set(&extreme_points(n, poses, 1.0), m, phi)
}

/// NOT in the source: [`enclose`] with the search's solver.
pub fn enclose_fast(n: u32, poses: &[Pose], m: u32, phi: f64) -> Container {
    Encloser::new(n, m).enclose(poses, phi)
}

/// NOT in the source: the reusable form of [`enclose_fast`] for the search, which keeps its
/// buffers between calls.
#[derive(Clone, Debug)]
pub struct Encloser {
    pub n: u32,
    pub m: u32,
    poly: Option<PolygonEncloser>,
    h: Vec<f64>,
    verts: Vec<f64>,
    have: Vec<bool>,
}

impl Encloser {
    pub fn new(n: u32, m: u32) -> Self {
        Encloser {
            n,
            m,
            poly: if m >= 3 { Some(PolygonEncloser::new(m)) } else { None },
            h: vec![0.0; m as usize],
            verts: Vec::new(),
            have: Vec::new(),
        }
    }

    pub fn enclose(&mut self, poses: &[Pose], phi: f64) -> Container {
        let (n, m) = (self.n, self.m);
        if n >= 3 && m >= 3 && !poses.is_empty() {
            if candidate_supports(n, poses, m, phi, &mut self.h, &mut self.verts, &mut self.have) {
                return self.poly.as_ref().unwrap().from_supports(&self.h, phi);
            }
        }
        let set = extreme_points(n, poses, 1.0);
        match &mut self.poly {
            Some(p) => p.enclose(&set, phi),
            None => enclosing_circle(&set),
        }
    }
}

/// The two things auto-orientation asks of an LP solver.
trait OrientationSolver {
    fn min_apothem(&mut self, set: &PointSet, phi: f64) -> f64;
    fn enclosing_polygon(&mut self, set: &PointSet, phi: f64) -> Container;
}

/// The source's solver: `minApothem` and `enclosingPolygon` with the enumerating dual.
struct SourceSolver {
    m: u32,
    sines: Rc<[f64]>,
    h: Vec<f64>,
}

impl OrientationSolver for SourceSolver {
    fn min_apothem(&mut self, set: &PointSet, phi: f64) -> f64 {
        min_apothem(set, self.m, phi, &mut self.h, &self.sines)
    }
    fn enclosing_polygon(&mut self, set: &PointSet, phi: f64) -> Container {
        enclosing_polygon(set, self.m, phi)
    }
}

impl OrientationSolver for PolygonEncloser {
    fn min_apothem(&mut self, set: &PointSet, phi: f64) -> f64 {
        PolygonEncloser::min_apothem(self, set, phi)
    }
    fn enclosing_polygon(&mut self, set: &PointSet, phi: f64) -> Container {
        self.enclose(set, phi)
    }
}

/// enclose.ts: autoOrientSet. Container orientation that minimises the size, searched over one
/// period [0, 2 pi / M).
///
/// Method: s(phi) is continuous, piecewise smooth and not convex. Its breakpoints come from a
/// change of supporting hull vertex (about H in total over one period, H = hull size) or a
/// change of active edges (order M). So:
///   1. sample uniformly at about 4 (H + M) points, at least 256;
///   2. take the lowest local minima of the samples (up to 8);
///   3. refine each by golden-section search between its two neighbours.
/// phi0 (the current orientation) and phi = 0 are always candidates, so the result is never
/// worse than either. This is a search and not a proof of the global minimum over phi.
/// For large M the sample count is capped to bound the cost.
pub fn auto_orient_set(set: &PointSet, m: u32, phi0: f64) -> Container {
    if m == 0 || set.pts.is_empty() {
        return enclose_set(set, m, 0.0);
    }
    let mut solver = SourceSolver { m, sines: sine_table(m), h: vec![0.0; m as usize] };
    auto_orient_with(&mut solver, set, m, phi0)
}

/// NOT in the source: [`auto_orient_set`] with the search's solver.
pub fn auto_orient_set_fast(set: &PointSet, m: u32, phi0: f64) -> Container {
    if m == 0 || set.pts.is_empty() {
        return enclose_set_fast(set, m, 0.0);
    }
    auto_orient_with(&mut PolygonEncloser::new(m), set, m, phi0)
}

/// The body of autoOrientSet for a polygon container and a set that is not empty.
fn auto_orient_with<S: OrientationSolver>(solver: &mut S, set: &PointSet, m: u32, phi0: f64) -> Container {
    // enclose.ts: GOLD
    let gold = (5.0f64.sqrt() - 1.0) / 2.0;
    let mf = m as f64;
    let period = (2.0 * PI) / mf;
    let wrap = |phi: f64| ((phi % period) + period) % period;

    let triples = (mf * (mf - 1.0) * (mf - 2.0)) / 6.0;
    let want = math::max(256.0, 4.0 * (set.pts.len() as f64 / 2.0 + mf));
    let n = math::max(256.0, math::min(math::min(want, 2048.0), (5e7 / triples).floor())) as usize;
    let dphi = period / n as f64;
    let mut vals = vec![0.0; n];
    for (i, v) in vals.iter_mut().enumerate() {
        *v = solver.min_apothem(set, i as f64 * dphi);
    }

    let mut minima: Vec<usize> = Vec::new();
    for i in 0..n {
        if vals[i] <= vals[(i + n - 1) % n] && vals[i] <= vals[(i + 1) % n] {
            minima.push(i);
        }
    }
    // the source's comparator is the difference of the values; a difference that is not a number
    // counts as equal, and the sort is stable
    minima.sort_by(|&p, &q| (vals[p] - vals[q]).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut best_phi = wrap(phi0);
    let mut best_val = solver.min_apothem(set, best_phi);
    let consider = |phi: f64, val: f64, best_phi: &mut f64, best_val: &mut f64| {
        if val < *best_val {
            *best_val = val;
            *best_phi = wrap(phi);
        }
    };
    consider(0.0, vals[0], &mut best_phi, &mut best_val);
    for &i in minima.iter().take(8) {
        let mut lo = (i as f64 - 1.0) * dphi;
        let mut hi = (i as f64 + 1.0) * dphi;
        let mut x1 = hi - gold * (hi - lo);
        let mut x2 = lo + gold * (hi - lo);
        let mut f1 = solver.min_apothem(set, x1);
        let mut f2 = solver.min_apothem(set, x2);
        while hi - lo > 1e-13 {
            if f1 < f2 {
                hi = x2;
                x2 = x1;
                f2 = f1;
                x1 = hi - gold * (hi - lo);
                f1 = solver.min_apothem(set, x1);
            } else {
                lo = x1;
                x1 = x2;
                f1 = f2;
                x2 = lo + gold * (hi - lo);
                f2 = solver.min_apothem(set, x2);
            }
        }
        consider(i as f64 * dphi, vals[i], &mut best_phi, &mut best_val);
        let mid = (lo + hi) / 2.0;
        let at_mid = solver.min_apothem(set, mid);
        consider(mid, at_mid, &mut best_phi, &mut best_val);
    }
    // The search compares apothems; the side length is computed afterwards and can round one step
    // differently, so the guaranteed candidates are compared again on the returned size.
    let mut result = solver.enclosing_polygon(set, best_phi);
    for phi in [wrap(phi0), 0.0] {
        let c = solver.enclosing_polygon(set, phi);
        if c.size < result.size {
            result = c;
        }
    }
    result
}

/// enclose.ts: autoOrient. Auto-orient for pieces given as poses.
pub fn auto_orient(n: u32, poses: &[Pose], m: u32, phi0: f64) -> Container {
    auto_orient_set(&extreme_points(n, poses, 1.0), m, phi0)
}

/// NOT in the source: [`auto_orient`] with the search's solver.
pub fn auto_orient_fast(n: u32, poses: &[Pose], m: u32, phi0: f64) -> Container {
    auto_orient_set_fast(&extreme_points(n, poses, 1.0), m, phi0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;

    /// The active-set dual agrees with the enumeration, on supports of random point clouds
    /// (whose optimum is usually a triple) and of lattice-like ones (ties, antipodal pairs).
    #[test]
    fn active_set_dual_matches_the_enumeration() {
        let mut rng = Rng::new(9);
        let mut exact = 0;
        let mut total = 0;
        for m in 13..=100u32 {
            let enc = PolygonEncloser::new(m);
            for case in 0..40 {
                let count = 3 + rng.below(60);
                let mut pts = Vec::new();
                for _ in 0..count {
                    let (x, y) = if case % 4 == 0 {
                        ((rng.below(5) as f64) - 2.0, (rng.below(5) as f64) - 2.0)
                    } else {
                        (rng.signed() * 10.0, rng.signed() * (1.0 + 9.0 * rng.next()))
                    };
                    pts.push(x + 1000.0 * (case % 3) as f64);
                    pts.push(y);
                }
                let set = PointSet { pts: convex_hull(&pts), pad: 0.25 };
                let mut h = vec![0.0; m as usize];
                let phi = rng.next();
                supports(&set, m, phi, &mut h);
                let slow = solve_dual(&h, m as usize, &enc.sines);
                let fast = solve_dual_fast(&h, m as usize, &enc.sines, &enc.cu, &enc.su);
                assert!((slow.a - fast.a).abs() <= 1e-13 * (1.0 + slow.a.abs()), "m={m} {} {}", slow.a, fast.a);
                total += 1;
                if slow.a == fast.a {
                    exact += 1;
                }
            }
        }
        // ties apart, the same basis gives the same double
        assert!(exact * 10 >= total * 9, "{exact} of {total}");
    }
}
