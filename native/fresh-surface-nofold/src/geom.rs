//! Shapes of one face problem: the piece (a regular N-gon or a disk) and the container (a convex polygon
//! that holds the origin, scaled by s), with the exact separating-axis separation and the exact smallest
//! scale that holds a piece. These are the solver's own computations; they agree with the validator to
//! rounding (tests/agreement.rs).
//!
//! Units. The search works in "internal" units in which the piece's bounding radius is 1 (circumradius of
//! a polygon, radius of a disk). Site units (side 1, or diameter 1) are internal units times `r_site`.
//! Every function here takes the bounding radius `r` of the units it is called in.

use std::f64::consts::PI;

/// cos of the angular distance from `rel` to the nearest multiple of `step`.
#[inline]
pub fn cos_to_nearest(rel: f64, step: f64) -> f64 {
    let t = rel.rem_euclid(step);
    let d = if t > 0.5 * step { step - t } else { t };
    d.cos()
}

/// A piece: a regular N-gon (N >= 3) or a disk (N = 0).
#[derive(Clone, Debug)]
pub struct Piece {
    pub n: usize,
    /// Bounding radius in site units: the circumradius 1 / (2 sin(pi/N)) of a polygon of side 1, 1/2 for
    /// a disk of diameter 1.
    pub r_site: f64,
    /// Inradius over bounding radius: cos(pi/N) for a polygon, 1 for a disk.
    pub inr: f64,
    /// Rotational period 2 pi / N (2 pi for a disk).
    pub period: f64,
    /// cos and sin of b_k = pi/2 + 2 pi k / N: vertex k sits at angle theta + b_k.
    pub cb: Vec<f64>,
    pub sb: Vec<f64>,
    /// Area in internal units (bounding radius 1).
    pub area: f64,
}

impl Piece {
    pub fn new(n: usize) -> Piece {
        if n == 0 {
            return Piece { n, r_site: 0.5, inr: 1.0, period: 2.0 * PI, cb: Vec::new(), sb: Vec::new(), area: PI };
        }
        let nf = n as f64;
        let step = 2.0 * PI / nf;
        let cb = (0..n).map(|k| (PI / 2.0 + step * k as f64).cos()).collect();
        let sb = (0..n).map(|k| (PI / 2.0 + step * k as f64).sin()).collect();
        Piece { n, r_site: 1.0 / (2.0 * (PI / nf).sin()), inr: (PI / nf).cos(), period: step, cb, sb, area: 0.5 * nf * step.sin() }
    }

    pub fn is_disk(&self) -> bool {
        self.n == 0
    }

    /// Support of the piece at angle `th` in the direction of angle `psi`, at bounding radius 1.
    #[inline]
    pub fn support(&self, th: f64, psi: f64) -> f64 {
        if self.n == 0 {
            1.0
        } else {
            cos_to_nearest(psi - th - PI / 2.0, self.period)
        }
    }

    /// Vertex k of a piece at (x, y, th) with bounding radius r.
    pub fn vertex(&self, x: f64, y: f64, th: f64, r: f64, k: usize) -> (f64, f64) {
        let a = th + PI / 2.0 + self.period * k as f64;
        (x + r * a.cos(), y + r * a.sin())
    }

    /// Exact signed separation of two pieces of bounding radius r (positive: apart by that much along
    /// the best separating axis; negative: overlap depth), as the separating-axis test computes it.
    /// Only the edge normals near the centre-to-centre direction can win; they are visited outward
    /// from it until the bound lin - 2 r_in falls below the best gap.
    pub fn separation(&self, r: f64, a: [f64; 3], b: [f64; 3]) -> f64 {
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let dist = (dx * dx + dy * dy).sqrt();
        if self.n == 0 {
            return dist - 2.0 * r;
        }
        self.sat_axis(r, a, b).0
    }

    /// The separating axis of two polygons (or the centre line of two disks): the gap along it, and the
    /// line that halves the gap in the pair convention of the model: unit normal at angle phi pointing
    /// from a to b, offset beta from the midpoint of the centres.
    pub fn sat_axis(&self, r: f64, a: [f64; 3], b: [f64; 3]) -> (f64, f64, f64) {
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let dist = (dx * dx + dy * dy).sqrt();
        let dang = if dist > 0.0 { dy.atan2(dx) } else { 0.0 };
        if self.n == 0 {
            return (dist - 2.0 * r, dang, 0.0);
        }
        let rin = r * self.inr;
        // axes of a: normals at a.th + pi/2 + pi/N + k step, pointing from a towards b near dang
        let (ga, anga, ca) = self.best_axis(r, rin, a[2], b[2], dx, dy, dist, dang);
        // axes of b: normals pointing from b towards a, near dang + pi
        let (gb, angb, cb) = self.best_axis(r, rin, b[2], a[2], -dx, -dy, dist, dang + PI);
        if ga >= gb {
            (ga, anga, 0.5 * (rin - r * ca))
        } else {
            (gb, angb + PI, 0.5 * (r * cb - rin))
        }
    }

    /// The largest gap over the edge normals of the piece at angle `th_own` (lin = (dx, dy) . u), the
    /// other piece at angle `th_other`: (gap, axis angle, the other's support cosine there). Only the
    /// normals near the centre direction can win: they are visited outward from it while the bound
    /// lin - 2 r_in (r cos >= r_in) can still beat the best gap.
    #[allow(clippy::too_many_arguments)]
    fn best_axis(&self, r: f64, rin: f64, th_own: f64, th_other: f64, dx: f64, dy: f64, dist: f64, dang: f64) -> (f64, f64, f64) {
        let n = self.n;
        let step = self.period;
        let base = th_own + PI / 2.0 + PI / n as f64;
        let k0 = ((dang - base) / step).round();
        let gap = |kf: f64| -> (f64, f64, f64) {
            let ang = base + kf * step;
            let (s, c) = ang.sin_cos();
            let lin = dx * c + dy * s;
            let co = cos_to_nearest(ang + PI / 2.0 - th_other, step);
            (lin - rin - r * co, ang, co)
        };
        let mut best = gap(k0);
        // outward in both directions while the bound can still win
        for dir in [1.0f64, -1.0] {
            let mut j = 1.0;
            while j <= n as f64 / 2.0 {
                let kf = k0 + dir * j;
                let off = base + kf * step - dang;
                let bound = dist * off.cos() - 2.0 * rin;
                if bound <= best.0 {
                    break;
                }
                let g = gap(kf);
                if g.0 > best.0 {
                    best = g;
                }
                j += 1.0;
            }
        }
        best
    }
}

/// A convex polygon container holding the origin: { p : n_e . p <= s h_e for every edge e }.
#[derive(Clone, Debug)]
pub struct Container {
    pub m: usize,
    /// Vertices at scale 1, counter-clockwise.
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    /// Outward unit normal of edge e (vertex e to e + 1), its angle and offset h_e = n_e . v_e > 0.
    pub nx: Vec<f64>,
    pub ny: Vec<f64>,
    pub psi: Vec<f64>,
    pub h: Vec<f64>,
    pub area: f64,
    /// Radius of the largest disk in the polygon at scale 1, when it is the disk about the origin
    /// touching every edge (the faces here are regular or tangential about the origin); else 0.
    pub rho: f64,
    /// Largest |vertex| at scale 1.
    pub ext: f64,
    /// Interior angle at each vertex.
    pub corner: Vec<f64>,
}

impl Container {
    /// From a flat counter-clockwise vertex list [x0, y0, x1, y1, ...] at scale 1.
    pub fn from_flat(flat: &[f64]) -> Container {
        let m = flat.len() / 2;
        let vx: Vec<f64> = (0..m).map(|k| flat[2 * k]).collect();
        let vy: Vec<f64> = (0..m).map(|k| flat[2 * k + 1]).collect();
        let mut nx = Vec::with_capacity(m);
        let mut ny = Vec::with_capacity(m);
        let mut psi = Vec::with_capacity(m);
        let mut h = Vec::with_capacity(m);
        let mut area = 0.0;
        for e in 0..m {
            let f = (e + 1) % m;
            let ex = vx[f] - vx[e];
            let ey = vy[f] - vy[e];
            let l = ex.hypot(ey);
            let (ux, uy) = (ey / l, -ex / l);
            nx.push(ux);
            ny.push(uy);
            psi.push(uy.atan2(ux));
            h.push(ux * vx[e] + uy * vy[e]);
            area += vx[e] * vy[f] - vx[f] * vy[e];
        }
        let hmin = h.iter().cloned().fold(f64::INFINITY, f64::min);
        let hmax = h.iter().cloned().fold(0.0, f64::max);
        let rho = if hmax - hmin <= 1e-9 * hmax { hmin } else { 0.0 };
        let ext = (0..m).map(|k| vx[k].hypot(vy[k])).fold(0.0, f64::max);
        let corner = (0..m)
            .map(|k| {
                let i = (k + m - 1) % m;
                let j = (k + 1) % m;
                let (ax, ay) = (vx[i] - vx[k], vy[i] - vy[k]);
                let (bx, by) = (vx[j] - vx[k], vy[j] - vy[k]);
                (bx * ay - by * ax).atan2(ax * bx + ay * by)
            })
            .collect();
        Container { m, vx, vy, nx, ny, psi, h, area: 0.5 * area, rho, ext, corner }
    }

    /// Smallest scale s with (x, y) in s Q.
    #[inline]
    pub fn gauge(&self, x: f64, y: f64) -> f64 {
        let mut g = f64::NEG_INFINITY;
        for e in 0..self.m {
            g = g.max((self.nx[e] * x + self.ny[e] * y) / self.h[e]);
        }
        g
    }

    /// Smallest scale holding the piece at (x, y, th) of bounding radius r, with `margin` of clearance
    /// to every edge.
    pub fn fit(&self, pc: &Piece, x: f64, y: f64, th: f64, r: f64, margin: f64) -> f64 {
        let mut g = f64::NEG_INFINITY;
        for e in 0..self.m {
            let sup = self.nx[e] * x + self.ny[e] * y + r * pc.support(th, self.psi[e]);
            g = g.max((sup + margin) / self.h[e]);
        }
        g
    }

    /// Signed clearance of the piece to the boundary of s Q (positive inside).
    pub fn depth(&self, pc: &Piece, s: f64, x: f64, y: f64, th: f64, r: f64) -> f64 {
        let mut d = f64::INFINITY;
        for e in 0..self.m {
            let sup = self.nx[e] * x + self.ny[e] * y + r * pc.support(th, self.psi[e]);
            d = d.min(s * self.h[e] - sup);
        }
        d
    }

    /// A uniform random point of Q (scale 1) whose gauge is at most `lim`, by rejection.
    pub fn sample(&self, rng: &mut crate::rng::Rng, lim: f64) -> (f64, f64) {
        let e = self.ext * lim.max(1e-9);
        for _ in 0..10000 {
            let x = e * rng.signed();
            let y = e * rng.signed();
            if self.gauge(x, y) <= lim {
                return (x, y);
            }
        }
        (0.0, 0.0)
    }
}

/// A packing of one face in site units: poses (x, y, theta) and the scale s that holds them.
#[derive(Clone, Debug)]
pub struct Packing {
    pub s: f64,
    pub q: Vec<[f64; 3]>,
}

/// Separation margin (site units) that a repaired packing keeps between pieces and to the walls, so that
/// rounding in the validator's own computation and in the transfer to other faces cannot make it invalid
/// at the strict tolerance 1e-11.
pub const MARGIN: f64 = 2e-12;

/// The least pair separation of a packing (site units, bounding radius r); pairs whose centres are
/// farther apart than two bounding radii are separated and skipped.
pub fn min_separation(pc: &Piece, r: f64, q: &[[f64; 3]]) -> f64 {
    let mut best = f64::INFINITY;
    let reach = 2.0 * r * (1.0 + 1e-9) + 1e-9;
    for i in 0..q.len() {
        for j in i + 1..q.len() {
            let dx = q[j][0] - q[i][0];
            let dy = q[j][1] - q[i][1];
            if dx.abs() > reach || dy.abs() > reach || dx * dx + dy * dy > reach * reach {
                continue;
            }
            best = best.min(pc.separation(r, q[i], q[j]));
        }
    }
    best
}

/// Turns any arrangement (site units) into a valid packing: spreads the centres about the origin by
/// 1 + lambda (doubling lambda) until every pair is separated by MARGIN (a separation never decreases
/// under the spread when the overlap is less than the pieces' width), then takes the smallest scale
/// that holds every piece with MARGIN to spare. None if the spread fails.
pub fn repair(pc: &Piece, cont: &Container, q: &[[f64; 3]]) -> Option<Packing> {
    let r = pc.r_site;
    let mut out: Vec<[f64; 3]> = q.iter().map(|p| [p[0], p[1], reduce_angle(p[2], pc.period)]).collect();
    let ms = min_separation(pc, r, &out);
    if !(ms >= MARGIN) {
        let mut lam = ((MARGIN - ms).max(1e-15) / (2.0 * r * pc.inr)) * 1.5;
        let mut ok = false;
        for _ in 0..90 {
            for (o, p) in out.iter_mut().zip(q) {
                o[0] = p[0] * (1.0 + lam);
                o[1] = p[1] * (1.0 + lam);
            }
            if min_separation(pc, r, &out) >= MARGIN {
                ok = true;
                break;
            }
            lam *= 2.0;
        }
        if !ok {
            return None;
        }
    }
    let mut s = 0.0f64;
    for p in &out {
        s = s.max(cont.fit(pc, p[0], p[1], p[2], r, MARGIN));
    }
    // the validator recomputes the walls at s with its own rounding
    s *= 1.0 + 4.0 * f64::EPSILON;
    if !(s.is_finite() && s > 0.0) {
        return None;
    }
    Some(Packing { s, q: out })
}

/// An angle reduced to [0, period).
pub fn reduce_angle(th: f64, period: f64) -> f64 {
    let t = th.rem_euclid(period);
    if t.is_finite() {
        t
    } else {
        0.0
    }
}
