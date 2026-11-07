//! The smallest enclosing container of an arrangement at a given orientation, and the search for
//! the orientation that minimises it. Ported from packages/geometry/src/enclose.ts with the same
//! algorithms (monotone-chain hull, the exact dual of the enclosing LP, Welzl's circle), so that a
//! score computed here is the server's up to the last bits of the trigonometric functions.

use crate::shapes::{circumradius, inradius, piece_vertices_into, Container, Pose, DISK_RADIUS};
use std::f64::consts::PI;

/// The convex hull of the piece vertices (polygon pieces, pad 0) or of the centres (disks, pad =
/// the disk radius times the scale). `pts` is [x0, y0, x1, y1, ...].
#[derive(Clone, Debug, Default)]
pub struct PointSet {
    pub pts: Vec<f64>,
    pub pad: f64,
}

/// Sign-correct cross product (a - o) x (b - o). When both products round to zero the factors are
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
    let s = 2f64.powi(600);
    let scaled = |u: f64, v: f64| if u == 0.0 || v == 0.0 { 0.0 } else { u * s * (v * s) };
    scaled(ax, by) - scaled(ay, bx)
}

/// Convex hull by Andrew's monotone chain: counter-clockwise, collinear points dropped.
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

/// Hull points and padding that determine every enclosing container of the arrangement.
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

/// Support values h_j of the point set along the M outward edge normals of the container.
fn supports(set: &PointSet, m: u32, phi: f64, h: &mut [f64]) {
    let step = 2.0 * PI / m as f64;
    for j in 0..m as usize {
        // normal j belongs to the edge ending at vertex j; j = 0 is the bottom edge at phi = 0
        let ang = phi - PI / 2.0 + j as f64 * step;
        let ux = ang.cos();
        let uy = ang.sin();
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

fn sine_table(m: u32) -> Vec<f64> {
    (0..=m).map(|d| (2.0 * PI * d as f64 / m as f64).sin()).collect()
}

#[derive(Clone, Copy, Debug)]
struct DualOptimum {
    a: f64,
    i: usize,
    j: usize,
    /// None when the optimum is an antipodal pair
    k: Option<usize>,
}

/// Exact solution of the enclosing LP  min a  s.t.  h_j <= a + c . u_j  for all j, through its dual
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

/// Reusable work space for the enclosing polygon of one container shape M.
#[derive(Clone, Debug)]
pub struct PolygonEncloser {
    pub m: u32,
    sines: Vec<f64>,
    h: Vec<f64>,
}

impl PolygonEncloser {
    pub fn new(m: u32) -> Self {
        PolygonEncloser { m, sines: sine_table(m), h: vec![0.0; m as usize] }
    }

    /// Apothem of the smallest enclosing regular M-gon at orientation phi.
    pub fn min_apothem(&mut self, set: &PointSet, phi: f64) -> f64 {
        let m = self.m;
        supports(set, m, phi, &mut self.h);
        solve_dual(&self.h, m as usize, &self.sines).a
    }

    /// Smallest enclosing regular M-gon (M >= 3) at orientation phi.
    pub fn enclose(&mut self, set: &PointSet, phi: f64) -> Container {
        if set.pts.is_empty() {
            return Container { m: self.m, cx: 0.0, cy: 0.0, phi, size: 0.0 };
        }
        supports(set, self.m, phi, &mut self.h);
        let h = std::mem::take(&mut self.h);
        let c = self.from_supports(&h, phi);
        self.h = h;
        c
    }

    /// The smallest regular M-gon at orientation phi from the supports h along its edge normals.
    pub fn from_supports(&self, h: &[f64], phi: f64) -> Container {
        let m = self.m as usize;
        let DualOptimum { a, i, j, k } = solve_dual(h, m, &self.sines);
        let step = 2.0 * PI / m as f64;
        let ang = |n: usize| phi - PI / 2.0 + n as f64 * step;
        let uix = ang(i).cos();
        let uiy = ang(i).sin();
        let bi = h[i] - a;
        let (cx, cy);
        if k.is_some() {
            // Three active constraints fix the centre; solve c . u = h - a for i and j.
            let ujx = ang(j).cos();
            let ujy = ang(j).sin();
            let bj = h[j] - a;
            let det = uix * ujy - uiy * ujx;
            cx = (bi * ujy - bj * uiy) / det;
            cy = (uix * bj - ujx * bi) / det;
        } else {
            // Two opposite edges are tight: the centre lies on c = bi u_i + t w, w perpendicular to
            // u_i; the other constraints bound t to an interval, whose midpoint is taken.
            let wx = -uiy;
            let wy = uix;
            let mut lo = f64::NEG_INFINITY;
            let mut hi = f64::INFINITY;
            for n in 0..m {
                if n == i || n == j {
                    continue;
                }
                let ux = ang(n).cos();
                let uy = ang(n).sin();
                let g = wx * ux + wy * uy;
                let rhs = h[n] - a - bi * (uix * ux + uiy * uy);
                if g > 1e-12 {
                    lo = lo.max(rhs / g);
                } else if g < -1e-12 {
                    hi = hi.min(rhs / g);
                }
            }
            let t = (lo + hi) / 2.0;
            cx = bi * uix + t * wx;
            cy = bi * uiy + t * wy;
        }
        Container { m: self.m, cx, cy, phi, size: 2.0 * a * (PI / m as f64).tan() }
    }
}

/// Deterministic shuffle, so that client and server visit points in the same order.
fn shuffled_order(n: usize) -> Vec<u32> {
    let mut order: Vec<u32> = (0..n as u32).collect();
    let mut seed: u32 = 0x9e3779b9;
    for i in (1..n).rev() {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let j = (seed % (i as u32 + 1)) as usize;
        order.swap(i, j);
    }
    order
}

/// Smallest enclosing circle of the point set (Welzl's algorithm, iterative); size is the diameter.
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
    let outside = |i: usize, cx: f64, cy: f64, r: f64| (x(i) - cx).hypot(y(i) - cy) > r * (1.0 + 1e-13) + 1e-15;
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
            cx = (x(i) + x(j)) / 2.0;
            cy = (y(i) + y(j)) / 2.0;
            r = (x(i) - x(j)).hypot(y(i) - y(j)) / 2.0;
            for k in 0..j {
                if outside(k, cx, cy, r) {
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
                    r = ux.hypot(uy);
                }
            }
        }
    }
    Container { m: 0, cx, cy, phi: 0.0, size: 2.0 * (r + set.pad) }
}

/// Smallest enclosing container of shape M at orientation phi (phi is ignored for circles).
pub fn enclose_set(set: &PointSet, m: u32, phi: f64) -> Container {
    if m == 0 {
        enclosing_circle(set)
    } else {
        PolygonEncloser::new(m).enclose(set, phi)
    }
}

const EPS: f64 = 1.0 / 9007199254740992.0; // 2^-53
const MAX_CANDIDATES: usize = 8;

/// The supports the hull of all the vertices gives, found from the vertices of a few candidate
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
        max_abs = max_abs.max(p.x.abs()).max(p.y.abs());
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
        let ux = ang.cos();
        let uy = ang.sin();
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

/// Smallest enclosing container of the pieces at orientation phi (the server's score routine).
pub fn enclose(n: u32, poses: &[Pose], m: u32, phi: f64) -> Container {
    if n >= 3 && m >= 3 && !poses.is_empty() {
        let mut h = vec![0.0; m as usize];
        let mut verts = Vec::new();
        let mut have = Vec::new();
        if candidate_supports(n, poses, m, phi, &mut h, &mut verts, &mut have) {
            return PolygonEncloser::new(m).from_supports(&h, phi);
        }
    }
    enclose_set(&extreme_points(n, poses, 1.0), m, phi)
}

/// Reusable form of [`enclose`] for the search: keeps its buffers between calls.
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

const GOLD: f64 = 0.6180339887498949; // (sqrt(5) - 1) / 2

/// Container orientation minimising the size over one period [0, 2 pi / M): a uniform sample of
/// about 4 (H + M) points (at least 256), the lowest local minima (up to 8) refined by
/// golden-section search, and phi0 and 0 always considered. A search, not a proof.
pub fn auto_orient_set(set: &PointSet, m: u32, phi0: f64) -> Container {
    if m == 0 || set.pts.is_empty() {
        return enclose_set(set, m, 0.0);
    }
    let mut enc = PolygonEncloser::new(m);
    let period = 2.0 * PI / m as f64;
    let wrap = |phi: f64| ((phi % period) + period) % period;
    let mf = m as f64;
    let triples = mf * (mf - 1.0) * (mf - 2.0) / 6.0;
    let want = 256f64.max(4.0 * (set.pts.len() as f64 / 2.0 + mf));
    let n = 256f64.max(want.min(2048.0).min((5e7 / triples).floor())) as usize;
    let dphi = period / n as f64;
    let mut vals = vec![0.0; n];
    for (i, v) in vals.iter_mut().enumerate() {
        *v = enc.min_apothem(set, i as f64 * dphi);
    }
    let mut minima: Vec<usize> = (0..n)
        .filter(|&i| vals[i] <= vals[(i + n - 1) % n] && vals[i] <= vals[(i + 1) % n])
        .collect();
    minima.sort_by(|&p, &q| vals[p].partial_cmp(&vals[q]).unwrap_or(std::cmp::Ordering::Equal));
    let mut best_phi = wrap(phi0);
    let mut best_val = enc.min_apothem(set, best_phi);
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
        let mut x1 = hi - GOLD * (hi - lo);
        let mut x2 = lo + GOLD * (hi - lo);
        let mut f1 = enc.min_apothem(set, x1);
        let mut f2 = enc.min_apothem(set, x2);
        while hi - lo > 1e-13 {
            if f1 < f2 {
                hi = x2;
                x2 = x1;
                f2 = f1;
                x1 = hi - GOLD * (hi - lo);
                f1 = enc.min_apothem(set, x1);
            } else {
                lo = x1;
                x1 = x2;
                f1 = f2;
                x2 = lo + GOLD * (hi - lo);
                f2 = enc.min_apothem(set, x2);
            }
        }
        consider(i as f64 * dphi, vals[i], &mut best_phi, &mut best_val);
        let mid = (lo + hi) / 2.0;
        let fm = enc.min_apothem(set, mid);
        consider(mid, fm, &mut best_phi, &mut best_val);
    }
    // The search compares apothems; the side is computed afterwards and can round one step
    // differently, so the guaranteed candidates are compared again on the returned size.
    let mut result = enc.enclose(set, best_phi);
    for phi in [wrap(phi0), 0.0] {
        let c = enc.enclose(set, phi);
        if c.size < result.size {
            result = c;
        }
    }
    result
}

/// Auto-orientation for pieces given as poses.
pub fn auto_orient(n: u32, poses: &[Pose], m: u32, phi0: f64) -> Container {
    auto_orient_set(&extreme_points(n, poses, 1.0), m, phi0)
}
