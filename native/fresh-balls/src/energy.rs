//! The penalty energy of P balls in a container of fixed size s, with its analytic gradient.
//!
//!   E(x) = sum_{i<j} max(0, 1 - |c_i - c_j|)^2  +  W sum_i sum_f max(0, N_f . c_i - (s b_f - R))^2   (solid)
//!                                               +  W sum_i max(0, |c_i| - (s/2 - R))^2               (ball)
//!
//! E = 0 exactly when the balls (diameter 1) are pairwise disjoint and inside the container; at a size below
//! the jamming size of an arrangement its minimum is positive and grows as (s* - s)^2. Lengths are linear (an
//! overlap of depth o costs o^2), so the energy is that of linear springs and its value compares arrangements.
//!
//! Neighbour (Verlet) lists keep the work linear in practice: at a rebuild the pair list keeps the pairs closer
//! than 1 + SKIN and each ball keeps the faces it is within SKIN of. The lists stay exact while every ball has
//! moved less than SKIN/2 since the rebuild (a pair's distance then changed by less than SKIN) and the faces
//! moved inward (the size shrank) by less than SKIN minus that displacement; each evaluation tests this in O(P)
//! and rebuilds when it fails. All buffers are allocated once.

use crate::shape::{Shape, R};

pub struct Energy {
    pub p: usize,
    pub s: f64,
    /// Weight of a wall violation relative to a pair overlap.
    pub wall_w: f64,
    ball: bool,
    nf: usize,
    n: Vec<f64>,
    b: Vec<f64>,
    bmax: f64,
    /// h_f = s b_f - R: the planes the centres must stay behind.
    h: Vec<f64>,
    /// s / 2 - R: the radius the centres must stay within (ball container).
    rho: f64,
    skin: f64,
    ref_x: Vec<f64>,
    ref_s: f64,
    have_lists: bool,
    pi: Vec<u32>,
    pj: Vec<u32>,
    fstart: Vec<u32>,
    flist: Vec<u32>,
    /// Evaluations so far (each is one energy and gradient).
    pub evals: u64,
    pub rebuilds: u64,
}

impl Energy {
    pub fn new(shape: &Shape, p: usize) -> Energy {
        Energy {
            p,
            s: 1.0,
            wall_w: 1.0,
            ball: shape.ball,
            nf: shape.nf,
            n: shape.n.clone(),
            b: shape.b.clone(),
            bmax: shape.bmax,
            h: vec![0.0; shape.nf],
            rho: 0.0,
            skin: 0.35,
            ref_x: vec![0.0; 3 * p],
            ref_s: 0.0,
            have_lists: false,
            pi: Vec::with_capacity(p * p / 2),
            pj: Vec::with_capacity(p * p / 2),
            fstart: vec![0; p + 1],
            flist: Vec::with_capacity(p * shape.nf.max(1)),
            evals: 0,
            rebuilds: 0,
        }
    }

    /// Sets the container size.
    pub fn set_size(&mut self, s: f64) {
        self.s = s;
        self.rho = 0.5 * s - R;
        for f in 0..self.nf {
            self.h[f] = s * self.b[f] - R;
        }
    }

    /// Forces a rebuild of the lists at the next evaluation.
    pub fn invalidate(&mut self) {
        self.have_lists = false;
    }

    fn lists_ok(&self, x: &[f64]) -> bool {
        if !self.have_lists {
            return false;
        }
        let mut m2 = 0.0f64;
        for k in 0..self.p {
            let dx = x[3 * k] - self.ref_x[3 * k];
            let dy = x[3 * k + 1] - self.ref_x[3 * k + 1];
            let dz = x[3 * k + 2] - self.ref_x[3 * k + 2];
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 > m2 {
                m2 = d2;
            }
        }
        let m = m2.sqrt();
        if 2.0 * m >= self.skin {
            return false;
        }
        if !self.ball {
            let shift = if self.s < self.ref_s { (self.ref_s - self.s) * self.bmax } else { 0.0 };
            if m + shift >= self.skin {
                return false;
            }
        }
        true
    }

    fn rebuild(&mut self, x: &[f64]) {
        self.rebuilds += 1;
        self.ref_x.copy_from_slice(&x[..3 * self.p]);
        self.ref_s = self.s;
        self.pi.clear();
        self.pj.clear();
        let reach = 1.0 + self.skin;
        let reach2 = reach * reach;
        for i in 0..self.p {
            let (xi, yi, zi) = (x[3 * i], x[3 * i + 1], x[3 * i + 2]);
            for j in i + 1..self.p {
                let dx = xi - x[3 * j];
                let dy = yi - x[3 * j + 1];
                let dz = zi - x[3 * j + 2];
                if dx * dx + dy * dy + dz * dz < reach2 {
                    self.pi.push(i as u32);
                    self.pj.push(j as u32);
                }
            }
        }
        if !self.ball {
            self.flist.clear();
            for i in 0..self.p {
                self.fstart[i] = self.flist.len() as u32;
                let c = &x[3 * i..3 * i + 3];
                for f in 0..self.nf {
                    let n = &self.n[3 * f..3 * f + 3];
                    if n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - self.h[f] > -self.skin {
                        self.flist.push(f as u32);
                    }
                }
            }
            self.fstart[self.p] = self.flist.len() as u32;
        }
        self.have_lists = true;
    }

    /// The energy at x and its gradient in g (both of length 3P).
    pub fn eval(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        self.evals += 1;
        if !self.lists_ok(x) {
            self.rebuild(x);
        }
        let np = 3 * self.p;
        let x = &x[..np];
        let g = &mut g[..np];
        g.fill(0.0);
        let mut e = 0.0;
        for k in 0..self.pi.len() {
            let i = 3 * self.pi[k] as usize;
            let j = 3 * self.pj[k] as usize;
            let dx = x[i] - x[j];
            let dy = x[i + 1] - x[j + 1];
            let dz = x[i + 2] - x[j + 2];
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 < 1.0 {
                if d2 > 1e-24 {
                    let d = d2.sqrt();
                    let o = 1.0 - d;
                    e += o * o;
                    let c = -2.0 * o / d;
                    g[i] += c * dx;
                    g[i + 1] += c * dy;
                    g[i + 2] += c * dz;
                    g[j] -= c * dx;
                    g[j + 1] -= c * dy;
                    g[j + 2] -= c * dz;
                } else {
                    // coincident centres: push them apart along x
                    e += 1.0;
                    g[i] -= 2.0;
                    g[j] += 2.0;
                }
            }
        }
        let w = self.wall_w;
        if self.ball {
            let rho = self.rho;
            let rho2 = rho * rho;
            for i in (0..np).step_by(3) {
                let r2 = x[i] * x[i] + x[i + 1] * x[i + 1] + x[i + 2] * x[i + 2];
                if r2 > rho2 {
                    let r = r2.sqrt();
                    let v = r - rho;
                    e += w * v * v;
                    let c = 2.0 * w * v / r;
                    g[i] += c * x[i];
                    g[i + 1] += c * x[i + 1];
                    g[i + 2] += c * x[i + 2];
                }
            }
        } else {
            for i in 0..self.p {
                let a = self.fstart[i] as usize;
                let z = self.fstart[i + 1] as usize;
                if a == z {
                    continue;
                }
                let (cx, cy, cz) = (x[3 * i], x[3 * i + 1], x[3 * i + 2]);
                let (mut gx, mut gy, mut gz) = (0.0, 0.0, 0.0);
                for &f in &self.flist[a..z] {
                    let f = f as usize;
                    let n = &self.n[3 * f..3 * f + 3];
                    let v = n[0] * cx + n[1] * cy + n[2] * cz - self.h[f];
                    if v > 0.0 {
                        e += w * v * v;
                        let c = 2.0 * w * v;
                        gx += c * n[0];
                        gy += c * n[1];
                        gz += c * n[2];
                    }
                }
                g[3 * i] += gx;
                g[3 * i + 1] += gy;
                g[3 * i + 2] += gz;
            }
        }
        e
    }

    /// Each ball's share of the energy (half of each pair term, all of its wall terms), with no lists: for the
    /// moves, not the inner loop.
    pub fn per_ball(&self, x: &[f64], out: &mut [f64]) {
        out[..self.p].fill(0.0);
        for i in 0..self.p {
            for j in i + 1..self.p {
                let dx = x[3 * i] - x[3 * j];
                let dy = x[3 * i + 1] - x[3 * j + 1];
                let dz = x[3 * i + 2] - x[3 * j + 2];
                let d2 = dx * dx + dy * dy + dz * dz;
                if d2 < 1.0 {
                    let o = 1.0 - d2.sqrt();
                    out[i] += 0.5 * o * o;
                    out[j] += 0.5 * o * o;
                }
            }
            let c = &x[3 * i..3 * i + 3];
            if self.ball {
                let v = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt() - self.rho;
                if v > 0.0 {
                    out[i] += self.wall_w * v * v;
                }
            } else {
                for f in 0..self.nf {
                    let n = &self.n[3 * f..3 * f + 3];
                    let v = n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - self.h[f];
                    if v > 0.0 {
                        out[i] += self.wall_w * v * v;
                    }
                }
            }
        }
    }
}
