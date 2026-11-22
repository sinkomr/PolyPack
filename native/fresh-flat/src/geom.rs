//! Shapes and exact geometry for the checks of this solver (not used in the inner loop).
//!
//! Conventions (PROMPT.md Section 2, docs/ARCHITECTURE.md Units): a polygon piece is a regular N-gon of
//! side 1 whose vertex k sits at angle theta + pi/2 + 2 pi k / N about its centre; N = 0 is a disk of
//! diameter 1. The container is a regular M-gon of side s centred at the origin with phi = 0 (horizontal
//! bottom edge, outward edge normals at angles -pi/2 + 2 pi j / M), or for M = 0 a circle of diameter s.

use std::f64::consts::PI;

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
        let (cnorm, k_in, k_out) = if m == 0 {
            (Vec::new(), 0.5, 0.5)
        } else {
            let mf = m as f64;
            let cnorm = (0..m)
                .map(|j| {
                    let a = -PI / 2.0 + 2.0 * PI * j as f64 / mf;
                    [a.cos(), a.sin()]
                })
                .collect();
            (cnorm, 1.0 / (2.0 * (PI / mf).tan()), 1.0 / (2.0 * (PI / mf).sin()))
        };
        Shape { n, m, big_r, apo, base, cnorm, k_in, k_out, period }
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

    /// Vertices of a polygon piece at pose (x, y, th).
    pub fn vertices(&self, x: f64, y: f64, th: f64, out: &mut [[f64; 2]]) {
        let (sn, cs) = th.sin_cos();
        for (k, b) in self.base.iter().enumerate() {
            out[k] = [x + self.big_r * (cs * b[0] - sn * b[1]), y + self.big_r * (sn * b[0] + cs * b[1])];
        }
    }

    /// Container gauge of a point: the size of the smallest container (centred at the origin) whose
    /// boundary passes through it.
    pub fn gauge(&self, x: f64, y: f64) -> f64 {
        if self.m == 0 {
            (x * x + y * y).sqrt() / self.k_in
        } else {
            let mut h = f64::NEG_INFINITY;
            for nv in &self.cnorm {
                h = h.max(nv[0] * x + nv[1] * y);
            }
            h / self.k_in
        }
    }

    /// Size of the smallest container centred at the origin (phi = 0) holding every piece.
    pub fn fit_size(&self, q: &[f64], p: usize) -> f64 {
        let dim = if self.n == 0 { 2 } else { 3 };
        let mut best = 0.0f64;
        let mut v = [[0.0; 2]; 16];
        for i in 0..p {
            let (x, y) = (q[dim * i], q[dim * i + 1]);
            if self.n == 0 {
                if self.m == 0 {
                    best = best.max(((x * x + y * y).sqrt() + 0.5) / self.k_in);
                } else {
                    best = best.max((self.gauge(x, y) * self.k_in + 0.5) / self.k_in);
                }
            } else {
                self.vertices(x, y, q[dim * i + 2], &mut v[..self.n]);
                for w in &v[..self.n] {
                    best = best.max(self.gauge(w[0], w[1]));
                }
            }
        }
        best
    }
}

/// Exact separation of two pieces of the same shape: the largest gap between their projections on
/// an edge normal of either polygon (separating-axis theorem; for overlapping polygons it is minus
/// the penetration depth). For disks: centre distance minus 1.
pub fn sat_sep(sh: &Shape, a: [f64; 3], b: [f64; 3]) -> f64 {
    if sh.n == 0 {
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        return (dx * dx + dy * dy).sqrt() - 1.0;
    }
    let n = sh.n;
    let mut va = [[0.0; 2]; 16];
    let mut vb = [[0.0; 2]; 16];
    sh.vertices(a[0], a[1], a[2], &mut va[..n]);
    sh.vertices(b[0], b[1], b[2], &mut vb[..n]);
    let mut best = f64::NEG_INFINITY;
    for (poly, th) in [(&va, a[2]), (&vb, b[2])] {
        let _ = poly;
        for k in 0..n {
            // outward normal of edge k: midway between vertices k and k + 1
            let ang = th + PI / 2.0 + PI / n as f64 + 2.0 * PI * k as f64 / n as f64;
            let (uy, ux) = ang.sin_cos();
            let (mut amin, mut amax, mut bmin, mut bmax) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
            for w in &va[..n] {
                let t = ux * w[0] + uy * w[1];
                amin = amin.min(t);
                amax = amax.max(t);
            }
            for w in &vb[..n] {
                let t = ux * w[0] + uy * w[1];
                bmin = bmin.min(t);
                bmax = bmax.max(t);
            }
            best = best.max(bmin - amax).max(amin - bmax);
        }
    }
    best
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
