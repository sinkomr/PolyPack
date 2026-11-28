//! Shapes and exact geometry: the separation and the container fit used to repair, to test and to
//! build starts, and the support-function helpers the objective walks with.
//!
//! Conventions (PROMPT.md Section 2, docs/ARCHITECTURE.md Units): a polygon piece is a regular N-gon of
//! side 1 whose vertex k sits at angle theta + pi/2 + 2 pi k / N about its centre; N = 0 is a disk of
//! diameter 1. The container is a regular M-gon of side s centred at the origin with phi = 0 (horizontal
//! bottom edge, outward edge normals at angles -pi/2 + 2 pi j / M), or for M = 0 a circle of diameter s.
//!
//! Every function here costs O(1) per piece or pair, whatever N and M (up to a walk over the few
//! vertices or walls that matter): for a regular polygon the vertex farthest along a direction is
//! the one whose angle is nearest it, and the container's wall nearest a direction is the one whose
//! normal is nearest it.

use std::f64::consts::{FRAC_PI_2, PI};

#[derive(Clone, Debug)]
pub struct Shape {
    /// Piece sides; 0 for a disk.
    pub n: usize,
    /// Container sides; 0 for a circle.
    pub m: usize,
    /// Bounding radius of a piece (circumradius, or 1/2 for a disk).
    pub big_r: f64,
    /// Inradius of a piece (apothem, or 1/2 for a disk).
    pub apo: f64,
    /// Unit vertex directions at theta = 0 (empty for a disk).
    pub base: Vec<[f64; 2]>,
    /// Container outward unit edge normals (empty for a circle).
    pub cnorm: Vec<[f64; 2]>,
    /// Container inradius per unit of size: apothem per side, or 1/2 per diameter.
    pub k_in: f64,
    /// Container circumradius per unit of size.
    pub k_out: f64,
    /// Rotational period of a piece, 2 pi / N (0 for a disk).
    pub period: f64,
    /// Angle between consecutive container normals, 2 pi / M (0 for a circle).
    pub cstep: f64,
}

/// Distance of x to the nearest multiple of step, in [0, step / 2].
#[inline]
pub fn fold(x: f64, step: f64) -> f64 {
    (x - step * (x / step).round()).abs().min(0.5 * step)
}

/// round(x / step) modulo n (no integer division: x / step is far below 2^52 here).
#[inline]
pub fn nearest_index(x: f64, step: f64, n: usize) -> usize {
    let nf = n as f64;
    let f = (x / step).round();
    let k = f - nf * (f / nf).floor();
    let k = k as usize;
    if k >= n {
        k - n
    } else {
        k
    }
}

/// atan2 to about 1e-5 radians: only a starting index for walks that then check their neighbours.
#[inline]
pub fn atan2_approx(y: f64, x: f64) -> f64 {
    let (ax, ay) = (x.abs(), y.abs());
    let (hi, lo) = if ax >= ay { (ax, ay) } else { (ay, ax) };
    let a = if hi > 0.0 { lo / hi } else { 0.0 };
    let s = a * a;
    let mut r = ((-0.046_496_474_9 * s + 0.159_314_22) * s - 0.327_622_764) * s * a + a;
    if ay > ax {
        r = FRAC_PI_2 - r;
    }
    if x < 0.0 {
        r = PI - r;
    }
    if y < 0.0 {
        -r
    } else {
        r
    }
}

#[inline]
fn next(k: usize, n: usize) -> usize {
    if k + 1 == n {
        0
    } else {
        k + 1
    }
}

#[inline]
fn prev(k: usize, n: usize) -> usize {
    if k == 0 {
        n - 1
    } else {
        k - 1
    }
}

/// The vertex of a regular polygon nearest the angle of a direction: the one farthest along it, or
/// a neighbour of it (the angle is approximate). `a`, `b` are the direction in the piece's own frame
/// times its scale (for a piece of circumradius R at angle theta and a direction u:
/// a = u . (R cos theta, R sin theta), b = u x (R cos theta, R sin theta)), so that vertex k projects
/// to base[k] . (a, b).
#[inline]
pub fn peak_guess(base: &[[f64; 2]], a: f64, b: f64) -> usize {
    let n = base.len();
    nearest_index(atan2_approx(b, a) - FRAC_PI_2, 2.0 * PI / n as f64, n)
}

/// The vertex farthest along a direction (see [`peak_guess`]) and its projection, climbing from the
/// guess (the projections are unimodal around the polygon).
#[inline]
pub fn peak(base: &[[f64; 2]], a: f64, b: f64) -> (usize, f64) {
    let mut out = (0, f64::NEG_INFINITY);
    arc_above(base, a, b, peak_guess(base, a, b), f64::INFINITY, |_, _| {}, &mut out);
    out
}

/// Calls `f(k, projection)` for every vertex whose projection base[k] . (a, b) exceeds `thr`: they form
/// one arc around the farthest vertex, which is found by climbing from vertex `start` (any vertex;
/// the cost grows with its distance from the farthest), and the arc is walked outward from it until
/// the first vertex that is not above on each side. Writes the farthest vertex and its projection
/// to `top` (a start for the next call with a nearby direction).
#[inline]
pub fn arc_above(base: &[[f64; 2]], a: f64, b: f64, start: usize, thr: f64, mut f: impl FnMut(usize, f64), top: &mut (usize, f64)) {
    let n = base.len();
    let proj = |k: usize| base[k][0] * a + base[k][1] * b;
    let mut k = start;
    let mut pk = proj(k);
    let mut kr = next(k, n);
    let mut pr = proj(kr);
    let mut kl = prev(k, n);
    let mut pl = proj(kl);
    if pr > pk {
        loop {
            kl = k;
            pl = pk;
            k = kr;
            pk = pr;
            kr = next(k, n);
            pr = proj(kr);
            if !(pr > pk) {
                break;
            }
        }
    } else if pl > pk {
        loop {
            kr = k;
            pr = pk;
            k = kl;
            pk = pl;
            kl = prev(k, n);
            pl = proj(kl);
            if !(pl > pk) {
                break;
            }
        }
    }
    *top = (k, pk);
    if !(pk > thr) {
        return;
    }
    f(k, pk);
    let mut count = 1;
    let (mut kk, mut pp) = (kr, pr);
    while count < n && pp > thr {
        f(kk, pp);
        count += 1;
        kk = next(kk, n);
        pp = proj(kk);
    }
    let (mut kk, mut pp) = (kl, pl);
    while count < n && pp > thr {
        f(kk, pp);
        count += 1;
        kk = prev(kk, n);
        pp = proj(kk);
    }
}

/// [`arc_above`] from a guessed start.
#[inline]
pub fn for_vertices_above(base: &[[f64; 2]], a: f64, b: f64, thr: f64, f: impl FnMut(usize, f64)) {
    let mut top = (0, 0.0);
    arc_above(base, a, b, peak_guess(base, a, b), thr, f, &mut top);
}

impl Shape {
    pub fn new(n: usize, m: usize) -> Shape {
        let (big_r, apo, base, period) = if n == 0 {
            (0.5, 0.5, Vec::new(), 0.0)
        } else {
            let nf = n as f64;
            let big_r = 1.0 / (2.0 * (PI / nf).sin());
            let apo = 1.0 / (2.0 * (PI / nf).tan());
            let base = (0..n)
                .map(|k| {
                    let a = PI / 2.0 + 2.0 * PI * k as f64 / nf;
                    [a.cos(), a.sin()]
                })
                .collect();
            (big_r, apo, base, 2.0 * PI / nf)
        };
        let (cnorm, k_in, k_out, cstep) = if m == 0 {
            (Vec::new(), 0.5, 0.5, 0.0)
        } else {
            let mf = m as f64;
            let cnorm = (0..m)
                .map(|j| {
                    let a = -PI / 2.0 + 2.0 * PI * j as f64 / mf;
                    [a.cos(), a.sin()]
                })
                .collect();
            (cnorm, 1.0 / (2.0 * (PI / mf).tan()), 1.0 / (2.0 * (PI / mf).sin()), 2.0 * PI / mf)
        };
        Shape { n, m, big_r, apo, base, cnorm, k_in, k_out, period, cstep }
    }

    pub fn is_disk(&self) -> bool {
        self.n == 0
    }

    /// Area of one piece.
    pub fn piece_area(&self) -> f64 {
        if self.n == 0 {
            PI * 0.25
        } else {
            let nf = self.n as f64;
            nf / (4.0 * (PI / nf).tan())
        }
    }

    /// Area of a container of size 1.
    pub fn container_area_unit(&self) -> f64 {
        if self.m == 0 {
            PI * 0.25
        } else {
            let mf = self.m as f64;
            mf / (4.0 * (PI / mf).tan())
        }
    }

    /// Container size whose area equals the pieces' total area.
    pub fn area_bound(&self, p: usize) -> f64 {
        (p as f64 * self.piece_area() / self.container_area_unit()).sqrt()
    }

    /// Vertices of a polygon piece at pose (x, y, th), into `out` (at least N entries).
    pub fn vertices(&self, x: f64, y: f64, th: f64, out: &mut [[f64; 2]]) {
        let (sn, cs) = th.sin_cos();
        for (k, b) in self.base.iter().enumerate() {
            out[k] = [x + self.big_r * (cs * b[0] - sn * b[1]), y + self.big_r * (sn * b[0] + cs * b[1])];
        }
    }

    /// Index of the container normal nearest the direction of (x, y).
    #[inline]
    pub fn wall_near(&self, x: f64, y: f64) -> usize {
        nearest_index(atan2_approx(y, x) + FRAC_PI_2, self.cstep, self.m)
    }

    /// Calls `f(j, n_j . c)` for the contiguous run of container walls j with n_j . c > thr, walking
    /// outward from the wall nearest the direction of c (n_j . c falls with the angle from c, so the
    /// walls that pass form one run around it), first to one side, then from the nearest wall again to
    /// the other. Polygon containers only.
    #[inline]
    pub fn for_walls_above(&self, cx: f64, cy: f64, thr: f64, f: impl FnMut(usize, f64)) -> usize {
        self.walls_above_from(cx, cy, self.wall_near(cx, cy), thr, f)
    }

    /// [`Self::for_walls_above`], climbing to the wall nearest c from wall `start` (any wall; the cost
    /// grows with its distance). Returns that wall, a start for the next call with a nearby c.
    #[inline]
    pub fn walls_above_from(&self, cx: f64, cy: f64, start: usize, thr: f64, mut f: impl FnMut(usize, f64)) -> usize {
        let m = self.m;
        let dot = |j: usize| self.cnorm[j][0] * cx + self.cnorm[j][1] * cy;
        let (mut j, mut d) = (start, dot(start));
        let (mut jr, mut dr) = (next(j, m), dot(next(j, m)));
        let (mut jl, mut dl) = (prev(j, m), dot(prev(j, m)));
        if dr > d {
            loop {
                jl = j;
                dl = d;
                j = jr;
                d = dr;
                jr = next(j, m);
                dr = dot(jr);
                if !(dr > d) {
                    break;
                }
            }
        } else if dl > d {
            loop {
                jr = j;
                dr = d;
                j = jl;
                d = dl;
                jl = prev(j, m);
                dl = dot(jl);
                if !(dl > d) {
                    break;
                }
            }
        }
        if !(d > thr) {
            return j;
        }
        f(j, d);
        let mut count = 1;
        let (mut jj, mut dd) = (jr, dr);
        while count < m && dd > thr {
            f(jj, dd);
            count += 1;
            jj = next(jj, m);
            dd = dot(jj);
        }
        let (mut jj, mut dd) = (jl, dl);
        while count < m && dd > thr {
            f(jj, dd);
            count += 1;
            jj = prev(jj, m);
            dd = dot(jj);
        }
        j
    }

    /// Container gauge of a point: the size of the smallest container (centred at the origin) whose
    /// boundary passes through it. O(1): the largest of n_j . p is at the normal nearest p's angle.
    pub fn gauge(&self, x: f64, y: f64) -> f64 {
        if self.m == 0 {
            (x * x + y * y).sqrt() / self.k_in
        } else {
            let j = self.for_walls_above(x, y, f64::INFINITY, |_, _| {});
            (self.cnorm[j][0] * x + self.cnorm[j][1] * y) / self.k_in
        }
    }

    /// Size of the smallest container centred at the origin (phi = 0) holding one piece at (x, y, th).
    /// Polygon in a polygon: the largest over walls j of n_j . c plus the piece's support along n_j,
    /// walked outward from the wall nearest c's direction while the piece's bounding circle could
    /// still raise it.
    pub fn piece_gauge(&self, x: f64, y: f64, th: f64) -> f64 {
        if self.n == 0 {
            return if self.m == 0 { ((x * x + y * y).sqrt() + 0.5) / self.k_in } else { (self.gauge(x, y) * self.k_in + 0.5) / self.k_in };
        }
        let (sn, cs) = th.sin_cos();
        let (rc, rs) = (self.big_r * cs, self.big_r * sn);
        if self.m == 0 {
            // |c + o|^2 = |c|^2 + R^2 + 2 c . o: the vertex farthest along c is farthest from the origin
            let (k, _) = peak(&self.base, x * rc + y * rs, y * rc - x * rs);
            let b = self.base[k];
            let vx = x + (rc * b[0] - rs * b[1]);
            let vy = y + (rs * b[0] + rc * b[1]);
            return (vx * vx + vy * vy).sqrt() / self.k_in;
        }
        let m = self.m;
        let wall = |j: usize| -> f64 {
            let [nx, ny] = self.cnorm[j];
            let (_, h) = peak(&self.base, nx * rc + ny * rs, ny * rc - nx * rs);
            nx * x + ny * y + h
        };
        let dot = |j: usize| self.cnorm[j][0] * x + self.cnorm[j][1] * y;
        let j0 = self.wall_near(x, y);
        let mut best = wall(j0);
        let r = self.big_r;
        let mut j = j0;
        let mut steps = 0;
        while steps < m / 2 + 1 {
            j = next(j, m);
            if dot(j) + r <= best {
                break;
            }
            best = best.max(wall(j));
            steps += 1;
        }
        let mut j = j0;
        let mut steps = 0;
        while steps < m / 2 + 1 {
            j = prev(j, m);
            if dot(j) + r <= best {
                break;
            }
            best = best.max(wall(j));
            steps += 1;
        }
        best / self.k_in
    }

    /// Size of the smallest container centred at the origin (phi = 0) holding every piece.
    pub fn fit_size(&self, q: &[f64], p: usize) -> f64 {
        let dim = if self.n == 0 { 2 } else { 3 };
        let mut best = 0.0f64;
        let reach = self.big_r / self.k_in;
        for i in 0..p {
            let (x, y) = (q[dim * i], q[dim * i + 1]);
            if self.n == 0 {
                best = best.max(self.piece_gauge(x, y, 0.0));
            } else if self.gauge(x, y) + reach > best {
                best = best.max(self.piece_gauge(x, y, q[dim * i + 2]));
            }
        }
        best
    }

    /// The separating axis of two pieces of this shape at poses a and b (polygons): the outward edge
    /// normal u of either piece along which their projections leave the largest gap, as (u from a
    /// toward b, gap, extent of a along u, extent of b along -u). See [`sat_sep`].
    #[inline]
    pub fn sat_axis(&self, a: [f64; 3], b: [f64; 3]) -> ([f64; 2], f64, f64, f64) {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let step = self.period;
        let nf = self.n as f64;
        let normal0 = FRAC_PI_2 + PI / nf;
        let phi = dy.atan2(dx);
        // the normal of a nearest the direction to b, and of b nearest the direction to a
        let ka = ((phi - a[2] - normal0) / step).round();
        let kb = ((phi + PI - b[2] - normal0) / step).round();
        let (sa, ca) = (a[2] + normal0 + ka * step).sin_cos();
        let (sb, cb) = (b[2] + normal0 + kb * step).sin_cos();
        let off = self.big_r * fold(a[2] - b[2] + PI + PI / nf, step).cos();
        let ga = dx * ca + dy * sa - self.apo - off;
        let gb = -(dx * cb + dy * sb) - self.apo - off;
        if ga >= gb {
            ([ca, sa], ga, self.apo, off)
        } else {
            ([-cb, -sb], gb, off, self.apo)
        }
    }
}

/// Exact separation of two pieces of the same shape, as the check defines it: the largest gap between
/// their projections on an outward edge normal of either polygon (separating-axis theorem; for
/// overlapping polygons minus the penetration depth). For disks: centre distance minus 1.
///
/// O(1): along an outward edge normal u of piece a, a reaches its apothem r and b (congruent) reaches
/// R cos(delta) toward a, delta the angle between -u and b's nearest vertex direction. Turning u by one
/// edge turns that angle by one vertex spacing, so delta = fold(theta_a - theta_b + pi + pi/N, 2 pi/N)
/// for every normal of a, and (since pi + pi/N is half an odd number of spacings, and fold is even) for
/// every normal of b too. The gap d . u - r - R cos(delta) is then largest at the normal nearest d.
pub fn sat_sep(sh: &Shape, a: [f64; 3], b: [f64; 3]) -> f64 {
    if sh.n == 0 {
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        return (dx * dx + dy * dy).sqrt() - 1.0;
    }
    sh.sat_axis(a, b).1
}

/// Smallest separation over all pairs that can touch, with the pair that attains it.
pub fn min_separation(sh: &Shape, q: &[f64], p: usize) -> (f64, usize, usize) {
    let dim = if sh.n == 0 { 2 } else { 3 };
    let reach = 2.0 * sh.big_r + 1e-9;
    let mut worst = (f64::INFINITY, 0, 0);
    for i in 0..p {
        for j in i + 1..p {
            let dx = q[dim * j] - q[dim * i];
            let dy = q[dim * j + 1] - q[dim * i + 1];
            if dx * dx + dy * dy > reach * reach {
                continue;
            }
            let pa = [q[dim * i], q[dim * i + 1], if dim == 3 { q[dim * i + 2] } else { 0.0 }];
            let pb = [q[dim * j], q[dim * j + 1], if dim == 3 { q[dim * j + 2] } else { 0.0 }];
            let s = sat_sep(sh, pa, pb);
            if s < worst.0 {
                worst = (s, i, j);
            }
        }
    }
    worst
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;

    /// The walks against brute force: the vertex arc above a threshold, the container gauge, a
    /// piece's container fit and the closed-form separation against all 2N projections.
    #[test]
    fn walks_match_brute_force() {
        let mut rng = Rng::new(3);
        for &n in &[3usize, 4, 5, 7, 8, 12, 17, 25, 40, 64, 100] {
            for &m in &[0usize, 3, 4, 5, 9, 16, 33, 100] {
                let sh = Shape::new(n, m);
                for _ in 0..300 {
                    let th = 20.0 * rng.signed();
                    let (sn, cs) = th.sin_cos();
                    let (rc, rs) = (sh.big_r * cs, sh.big_r * sn);
                    let ang = 7.0 * rng.signed();
                    let (ux, uy) = (ang.cos(), ang.sin());
                    let (a, b) = (ux * rc + uy * rs, uy * rc - ux * rs);
                    let thr = sh.big_r * (2.2 * rng.uniform() - 1.1);
                    let mut got = vec![false; n];
                    for_vertices_above(&sh.base, a, b, thr, |k, p| {
                        assert!(!got[k]);
                        got[k] = true;
                        assert!((p - (sh.base[k][0] * a + sh.base[k][1] * b)).abs() < 1e-15);
                    });
                    for k in 0..n {
                        let p = sh.base[k][0] * a + sh.base[k][1] * b;
                        assert_eq!(got[k], p > thr, "n={n} k={k} p={p} thr={thr}");
                    }
                    let (x, y) = (sh.big_r * 3.0 * rng.signed(), sh.big_r * 3.0 * rng.signed());
                    if m > 0 {
                        let brute = sh.cnorm.iter().map(|v| v[0] * x + v[1] * y).fold(f64::NEG_INFINITY, f64::max) / sh.k_in;
                        assert!((sh.gauge(x, y) - brute).abs() <= 1e-14 * brute.abs().max(1.0));
                    }
                    let mut v = vec![[0.0; 2]; n];
                    sh.vertices(x, y, th, &mut v);
                    let brute = v.iter().map(|w| if m == 0 { (w[0] * w[0] + w[1] * w[1]).sqrt() / sh.k_in } else { sh.cnorm.iter().map(|c| c[0] * w[0] + c[1] * w[1]).fold(f64::NEG_INFINITY, f64::max) / sh.k_in }).fold(f64::NEG_INFINITY, f64::max);
                    let fit = sh.piece_gauge(x, y, th);
                    assert!((fit - brute).abs() <= 1e-13 * brute.max(1.0), "n={n} m={m}: {fit} {brute}");
                    // separation against every projection on every edge normal of both pieces
                    let pa = [x, y, th];
                    let pb = [x + 2.5 * sh.big_r * rng.signed(), y + 2.5 * sh.big_r * rng.signed(), 20.0 * rng.signed()];
                    let mut va = vec![[0.0; 2]; n];
                    let mut vb = vec![[0.0; 2]; n];
                    sh.vertices(pa[0], pa[1], pa[2], &mut va);
                    sh.vertices(pb[0], pb[1], pb[2], &mut vb);
                    let mut best = f64::NEG_INFINITY;
                    for (th0, sign) in [(pa[2], 1.0), (pb[2], -1.0)] {
                        for k in 0..n {
                            let ang = th0 + PI / 2.0 + PI / n as f64 + 2.0 * PI * k as f64 / n as f64;
                            let (uy, ux) = ang.sin_cos();
                            let pr = |w: &[f64; 2]| ux * w[0] + uy * w[1];
                            let amax = va.iter().map(pr).fold(f64::NEG_INFINITY, f64::max);
                            let amin = va.iter().map(pr).fold(f64::INFINITY, f64::min);
                            let bmax = vb.iter().map(pr).fold(f64::NEG_INFINITY, f64::max);
                            let bmin = vb.iter().map(pr).fold(f64::INFINITY, f64::min);
                            best = best.max(if sign > 0.0 { bmin - amax } else { amin - bmax });
                        }
                    }
                    let s = sat_sep(&sh, pa, pb);
                    assert!((s - best).abs() < 1e-12 * sh.big_r.max(1.0), "n={n}: {s} {best}");
                }
            }
        }
    }
}
