//! The two problems as smooth constrained programs over points of a surface of constant curvature.
//!
//! Variables: the points' chart coordinates and one size variable sigma (the last entry of x).
//! Every constraint is a value o(x) that must be <= 0, and the search minimises the augmented
//! Lagrangian  F = sigma + (mu / 2) sum_c max(0, o_c + lambda_c / mu)^2  (lambda = 0: a plain penalty).
//!
//! Charts (both unconstrained, so L-BFGS works in plain coordinates):
//!  - K < 0: the hyperboloid's spatial part w in R^2, v = (sqrt(1 - K |w|^2), w);
//!  - K > 0 and the sphere: any u in R^3 \ 0, v = u / sqrt(u0^2 + K (u1^2 + u2^2)).
//!
//! Curved (disks of diameter 1 in a container at curvature K):
//!  - pair i < j: o = (<v_i, v_j> - cs(D)) / K = vs(D) - vs(d_ij) (D = 1 plus a hair);
//!  - disk container, sigma = R' = r - 1/2 (the radius of the centres' disk):
//!    o = (1 - v0) / K - vs(sigma) = vs(d(O, c)) - vs(R');
//!  - M-gon container, sigma = h (apothem): wall covector n = (-sn h, cs h cos a, cs h sin a) with
//!    n . v = sn(signed distance from the wall line), o = n . v + sn(1/2).
//!
//! Sphere (Tammes: P points on the unit sphere, maximise the smallest angle):
//!  - pair: o = v_i . v_j - sigma, sigma = cos(theta_min); the score is rho = 1 / theta_min.

use crate::kfn::Kf;
use crate::rng::Rng;
use serde_json::{json, Value};
use std::f64::consts::PI;

/// Rows of constraints with their gradients in x (at most 7 nonzeros: two points and sigma).
#[derive(Default)]
pub struct Rows {
    /// the constraint's index (pairs first, then the container's)
    pub id: Vec<usize>,
    pub val: Vec<f64>,
    pub nnz: Vec<u8>,
    pub cols: Vec<[u32; 7]>,
    pub coef: Vec<[f64; 7]>,
}

impl Rows {
    pub fn clear(&mut self) {
        self.id.clear();
        self.val.clear();
        self.nnz.clear();
        self.cols.clear();
        self.coef.clear();
    }
    pub fn len(&self) -> usize {
        self.val.len()
    }
    pub fn is_empty(&self) -> bool {
        self.val.is_empty()
    }
    #[inline]
    fn push(&mut self, id: usize, val: f64, entries: &[(usize, f64)]) {
        let mut cols = [0u32; 7];
        let mut coef = [0.0; 7];
        for (k, &(c, v)) in entries.iter().enumerate() {
            cols[k] = c as u32;
            coef[k] = v;
        }
        self.id.push(id);
        self.val.push(val);
        self.nnz.push(entries.len() as u8);
        self.cols.push(cols);
        self.coef.push(coef);
    }
}

/// What the driver needs of a problem.
pub trait Model {
    fn dim(&self) -> usize;
    fn ncons(&self) -> usize;
    fn npts(&self) -> usize;
    /// F and its gradient.
    fn eval(&mut self, x: &[f64], lam: &[f64], mu: f64, g: &mut [f64]) -> f64;
    /// lambda <- max(0, lambda + mu o); returns the largest violation max(0, o).
    fn update_multipliers(&mut self, x: &[f64], lam: &mut [f64], mu: f64) -> f64;
    /// Rescales chart coordinates to the surface (no change in F).
    fn normalize(&self, x: &mut [f64]);
    /// The score of the size variable (a monotone function of it).
    fn score_of_sigma(&self, sigma: f64) -> f64;
    /// Sets sigma to the smallest value that the points allow (the container constraints tight).
    fn fit_sigma(&mut self, x: &mut [f64]);
    fn start(&mut self, rng: &mut Rng, x: &mut [f64], kind: usize);
    /// Moves points: jitter all by `eta`, or re-seat `count` points in holes.
    fn perturb(&mut self, rng: &mut Rng, x: &mut [f64], kind: usize, eta: f64, count: usize);
    /// The exact score of the points and the configuration in the submission format, or None when
    /// a pair overlaps by more than `slack` (the caller polishes further).
    fn finish(&mut self, x: &[f64], slack: f64) -> Option<(f64, Value)>;
    /// Forgets cached neighbour lists (the next evaluation rebuilds them).
    fn invalidate(&mut self);
    /// The constraints that `keep(index, value)` selects, with their gradients, into `out`;
    /// returns the largest value over all constraints.
    fn rows(&mut self, x: &[f64], keep: &dyn Fn(usize, f64) -> bool, out: &mut Rows) -> f64;
    /// The size variable's scale of change worth noticing (for acceptance tests).
    fn sigma_scale(&self) -> f64 {
        1.0
    }
}

// ---------------------------------------------------------------------------------------------
// Curved

pub struct Curved {
    pub kf: Kf,
    pub m: u32,
    pub p: usize,
    /// coordinates per point: 2 (K < 0) or 3 (K > 0)
    pub stride: usize,
    /// pair target D and cs(D)
    pub d_target: f64,
    cs_d: f64,
    sn_half: f64,
    wall_c: Vec<f64>,
    wall_s: Vec<f64>,
    /// the size variable's limit: hemisphere (K > 0) or ideal polygon (K < 0, M >= 3)
    pub sigma_max: f64,
    v: Vec<f64>,
    gv: Vec<f64>,
    cand: Vec<f64>,
    /// neighbour list: (i, j, pair index) of the pairs within D + SKIN at the last build
    nb: Vec<u32>,
    vref: Vec<f64>,
    stale: bool,
    /// vs(D + SKIN): pairs with a larger versine at the build are left out
    vs_far: f64,
    /// rebuild when a point has moved by more than SKIN / 4 (as vs of the distance)
    vs_move: f64,
}

/// Neighbour-list skin of the curved model, in distance units (disk diameter 1).
const SKIN: f64 = 0.35;

impl Curved {
    pub fn new(k: f64, m: u32, p: usize) -> Curved {
        let kf = Kf::new(k);
        let stride = if k < 0.0 { 2 } else { 3 };
        let (wall_c, wall_s): (Vec<f64>, Vec<f64>) = (0..m)
            .map(|w| {
                let a = -PI / 2.0 + 2.0 * PI * w as f64 / m as f64;
                (a.cos(), a.sin())
            })
            .unzip();
        // the centres' region: R' < pi/(2 sqrt K) - 1/2 (hemisphere), h < pi/(2 sqrt K) or the ideal apothem
        let sigma_max = if k > 0.0 {
            if m == 0 {
                PI / (2.0 * kf.s) - 0.5
            } else {
                PI / (2.0 * kf.s)
            }
        } else if m == 0 {
            f64::INFINITY
        } else {
            kf.asn(1.0 / (kf.s * (PI / m as f64).tan()))
        };
        let mut c = Curved {
            kf,
            m,
            p,
            stride,
            d_target: 1.0,
            cs_d: 0.0,
            sn_half: kf.sn(0.5),
            wall_c,
            wall_s,
            sigma_max,
            v: vec![0.0; 3 * p],
            gv: vec![0.0; 3 * p],
            cand: vec![0.0; 3],
            nb: Vec::with_capacity(3 * p * (p - 1) / 2),
            vref: vec![0.0; 3 * p],
            stale: true,
            vs_far: 0.0,
            vs_move: kf.vs(SKIN / 4.0),
        };
        c.set_target(1.0 + 2e-15);
        c
    }

    /// Rebuilds the neighbour list from self.v if a point has moved too far since the last build
    /// (or the multipliers changed). Pairs with a multiplier are always listed.
    #[inline]
    fn refresh(&mut self, lam: &[f64]) {
        let p = self.p;
        let inv_k = 1.0 / self.kf.k;
        if !self.stale {
            let mut moved = false;
            for i in 0..p {
                let d0 = self.v[3 * i] - self.vref[3 * i];
                let d1 = self.v[3 * i + 1] - self.vref[3 * i + 1];
                let d2 = self.v[3 * i + 2] - self.vref[3 * i + 2];
                if (d1 * d1 + d2 * d2 + d0 * d0 * inv_k) * 0.5 > self.vs_move {
                    moved = true;
                    break;
                }
            }
            if !moved {
                return;
            }
        }
        self.stale = false;
        self.vref.copy_from_slice(&self.v);
        self.nb.clear();
        let k = self.kf.k;
        let mut idx = 0u32;
        for i in 0..p {
            let a = &self.v[3 * i..3 * i + 3];
            for j in i + 1..p {
                let b = &self.v[3 * j..3 * j + 3];
                let ip = a[0] * b[0] + k * (a[1] * b[1] + a[2] * b[2]);
                if (1.0 - ip) * inv_k < self.vs_far || lam[idx as usize] > 0.0 {
                    self.nb.push(i as u32);
                    self.nb.push(j as u32);
                    self.nb.push(idx);
                }
                idx += 1;
            }
        }
    }

    pub fn set_target(&mut self, d: f64) {
        self.d_target = d;
        self.cs_d = self.kf.cs(d);
        self.vs_far = self.kf.vs(d + SKIN);
        self.stale = true;
    }

    /// Ambient points of x into self.v.
    #[inline]
    fn chart(&mut self, x: &[f64]) {
        let k = self.kf.k;
        if self.stride == 2 {
            for i in 0..self.p {
                let (a, b) = (x[2 * i], x[2 * i + 1]);
                self.v[3 * i] = (1.0 - k * (a * a + b * b)).sqrt();
                self.v[3 * i + 1] = a;
                self.v[3 * i + 2] = b;
            }
        } else {
            for i in 0..self.p {
                let (a, b, c) = (x[3 * i], x[3 * i + 1], x[3 * i + 2]);
                let inv = 1.0 / (a * a + k * (b * b + c * c)).sqrt();
                self.v[3 * i] = a * inv;
                self.v[3 * i + 1] = b * inv;
                self.v[3 * i + 2] = c * inv;
            }
        }
    }

    /// Pulls the ambient gradient self.gv back to the chart coordinates.
    #[inline]
    fn pull_back(&self, x: &[f64], g: &mut [f64]) {
        let k = self.kf.k;
        if self.stride == 2 {
            for i in 0..self.p {
                let v0 = self.v[3 * i];
                let f = -k * self.gv[3 * i] / v0;
                g[2 * i] = self.gv[3 * i + 1] + f * x[2 * i];
                g[2 * i + 1] = self.gv[3 * i + 2] + f * x[2 * i + 1];
            }
        } else {
            for i in 0..self.p {
                let (a, b, c) = (x[3 * i], x[3 * i + 1], x[3 * i + 2]);
                let n = (a * a + k * (b * b + c * c)).sqrt();
                let v = &self.v[3 * i..3 * i + 3];
                let gv = &self.gv[3 * i..3 * i + 3];
                let vg = v[0] * gv[0] + v[1] * gv[1] + v[2] * gv[2];
                g[3 * i] = (gv[0] - v[0] * vg) / n;
                g[3 * i + 1] = (gv[1] - k * v[1] * vg) / n;
                g[3 * i + 2] = (gv[2] - k * v[2] * vg) / n;
            }
        }
    }

    /// The chart gradient of point i from an ambient gradient gv (self.v must be current).
    #[inline]
    fn pull_point(&self, x: &[f64], i: usize, gv: [f64; 3], out: &mut Vec<(usize, f64)>) {
        let k = self.kf.k;
        if self.stride == 2 {
            let f = -k * gv[0] / self.v[3 * i];
            out.push((2 * i, gv[1] + f * x[2 * i]));
            out.push((2 * i + 1, gv[2] + f * x[2 * i + 1]));
        } else {
            let (a, b, c) = (x[3 * i], x[3 * i + 1], x[3 * i + 2]);
            let n = (a * a + k * (b * b + c * c)).sqrt();
            let v = &self.v[3 * i..3 * i + 3];
            let vg = v[0] * gv[0] + v[1] * gv[1] + v[2] * gv[2];
            out.push((3 * i, (gv[0] - v[0] * vg) / n));
            out.push((3 * i + 1, (gv[1] - k * v[1] * vg) / n));
            out.push((3 * i + 2, (gv[2] - k * v[2] * vg) / n));
        }
    }

    /// Chart coordinates of an ambient point into x at point i.
    fn put(&self, x: &mut [f64], i: usize, v: &[f64]) {
        if self.stride == 2 {
            x[2 * i] = v[1];
            x[2 * i + 1] = v[2];
        } else {
            x[3 * i] = v[0];
            x[3 * i + 1] = v[1];
            x[3 * i + 2] = v[2];
        }
    }

    /// The container constraint value of ambient point v at size sigma (largest over the walls).
    fn container_o(&self, v: &[f64], sigma: f64) -> f64 {
        let kf = &self.kf;
        if self.m == 0 {
            (1.0 - v[0]) / kf.k - sigma.signum() * kf.vs(sigma.abs())
        } else {
            let (sh, ch) = (kf.sn(sigma), kf.cs(sigma));
            let mut worst = f64::NEG_INFINITY;
            for w in 0..self.m as usize {
                let o = -sh * v[0] + ch * (self.wall_c[w] * v[1] + self.wall_s[w] * v[2]) + self.sn_half;
                worst = worst.max(o);
            }
            worst
        }
    }

    /// The smallest size variable that holds the centre v.
    fn required_sigma(&self, v: &[f64]) -> f64 {
        let kf = &self.kf;
        if self.m == 0 {
            kf.dist_o(v)
        } else {
            // n(h) . v = A sn(beta - h) with X = u . w, Y = v0, A = sqrt(Y^2 + K X^2), beta = ang(X, Y):
            // the wall needs h >= beta + asn(sn(1/2) / A)
            let mut h = f64::NEG_INFINITY;
            for w in 0..self.m as usize {
                let xx = self.wall_c[w] * v[1] + self.wall_s[w] * v[2];
                let yy = v[0];
                let a = (yy * yy + kf.k * xx * xx).max(0.0).sqrt();
                let beta = kf.ang(xx, yy);
                h = h.max(beta + kf.asn(self.sn_half / a));
            }
            h
        }
    }

    /// Exponential coordinates (x, y) of the centre v: distance from O times the direction.
    fn exp_coords(&self, v: &[f64]) -> (f64, f64) {
        let w = (v[1] * v[1] + v[2] * v[2]).sqrt();
        if w == 0.0 {
            return (0.0, 0.0);
        }
        let d = self.kf.ang(w, v[0]);
        (d * v[1] / w, d * v[2] / w)
    }

    /// A uniform random point (by area) of the disk of radius r about O.
    fn random_in_disk(&self, rng: &mut Rng, r: f64) -> [f64; 3] {
        let kf = &self.kf;
        let c = 1.0 - kf.k * rng.uniform() * kf.vs(r);
        let s = ((1.0 - c * c) / kf.k).max(0.0).sqrt();
        let phi = 2.0 * PI * rng.uniform();
        [c, s * phi.cos(), s * phi.sin()]
    }

    /// Radius of the disk about O whose area is `area`.
    fn radius_of_area(&self, area: f64) -> f64 {
        let kf = &self.kf;
        // area = 2 pi vs(r): cs(r) = 1 - K area / (2 pi)
        let c = 1.0 - kf.k * area / (2.0 * PI);
        if kf.k > 0.0 {
            if c <= 0.0 {
                return PI / (2.0 * kf.s);
            }
            c.acos() / kf.s
        } else {
            c.acosh() / kf.s
        }
    }

    /// The radius of the centres' region of a roomy start.
    fn start_radius(&self) -> f64 {
        let disk = 2.0 * PI * self.kf.vs(0.5);
        let r = self.radius_of_area(self.p as f64 * disk / 0.62) - 0.5;
        let cap = if self.m == 0 { self.sigma_max } else { self.sigma_max - 0.5 };
        r.min(cap * 0.97).max(0.05)
    }

    /// The point of `tries` random candidates in the current container farthest from the others
    /// (other than `skip`).
    fn hole(&mut self, rng: &mut Rng, x: &[f64], skip: usize, tries: usize) -> [f64; 3] {
        let sigma = x[x.len() - 1];
        let r = if self.m == 0 { sigma.max(0.05) } else { (sigma - 0.5).max(0.05) * 1.1 };
        let r = r.min(if self.m == 0 { self.sigma_max } else { self.sigma_max - 0.5 });
        let mut best = [1.0, 0.0, 0.0];
        let mut best_val = f64::NEG_INFINITY;
        for _ in 0..tries {
            let c = self.random_in_disk(rng, r);
            if self.container_o(&c, sigma) > 0.05 {
                continue;
            }
            let mut near = f64::INFINITY;
            for j in 0..self.p {
                if j == skip {
                    continue;
                }
                let v = &self.v[3 * j..3 * j + 3];
                // <c, v>: larger is nearer
                let ip = c[0] * v[0] + self.kf.k * (c[1] * v[1] + c[2] * v[2]);
                let d = (1.0 - ip) / self.kf.k; // vs(distance)
                near = near.min(d);
            }
            if near > best_val {
                best_val = near;
                best = c;
            }
        }
        self.cand.copy_from_slice(&best);
        best
    }
}

impl Model for Curved {
    fn dim(&self) -> usize {
        self.stride * self.p + 1
    }
    fn ncons(&self) -> usize {
        self.p * (self.p - 1) / 2 + self.p * (self.m.max(1) as usize)
    }
    fn npts(&self) -> usize {
        self.p
    }

    fn eval(&mut self, x: &[f64], lam: &[f64], mu: f64, g: &mut [f64]) -> f64 {
        let p = self.p;
        let k = self.kf.k;
        let sigma = x[x.len() - 1];
        self.chart(x);
        for e in self.gv.iter_mut() {
            *e = 0.0;
        }
        let inv_mu = 1.0 / mu;
        let inv_k = 1.0 / k;
        let cs_d = self.cs_d;
        let mut f = 0.0;
        let mut gs = 1.0; // dF/dsigma
        // pairs: o = (<vi, vj> - cs(D)) / K, over the neighbour list
        self.refresh(lam);
        for e in self.nb.chunks_exact(3) {
            let (i, j, pi) = (e[0] as usize, e[1] as usize, e[2] as usize);
            let (a0, a1, a2) = (self.v[3 * i], self.v[3 * i + 1], self.v[3 * i + 2]);
            let (b0, b1, b2) = (self.v[3 * j], self.v[3 * j + 1], self.v[3 * j + 2]);
            let ip = a0 * b0 + k * (a1 * b1 + a2 * b2);
            let t = (ip - cs_d) * inv_k + lam[pi] * inv_mu;
            if t > 0.0 {
                f += 0.5 * mu * t * t;
                let c = mu * t;
                // d o / d vi = (vj0 / K, vj1, vj2)
                self.gv[3 * i] += c * b0 * inv_k;
                self.gv[3 * i + 1] += c * b1;
                self.gv[3 * i + 2] += c * b2;
                self.gv[3 * j] += c * a0 * inv_k;
                self.gv[3 * j + 1] += c * a1;
                self.gv[3 * j + 2] += c * a2;
            }
        }
        let mut idx = p * (p - 1) / 2;
        // container
        if self.m == 0 {
            // phi(sigma) = sign(sigma) vs(|sigma|): monotone, so a negative radius is not a way out
            let vsr = sigma.signum() * self.kf.vs(sigma.abs());
            let dvs = self.kf.sn(sigma.abs());
            for i in 0..p {
                let o = (1.0 - self.v[3 * i]) * inv_k - vsr;
                let t = o + lam[idx] * inv_mu;
                idx += 1;
                if t > 0.0 {
                    f += 0.5 * mu * t * t;
                    let c = mu * t;
                    self.gv[3 * i] -= c * inv_k;
                    gs -= c * dvs;
                }
            }
        } else {
            let (sh, ch) = (self.kf.sn(sigma), self.kf.cs(sigma));
            let mw = self.m as usize;
            for i in 0..p {
                let (v0, v1, v2) = (self.v[3 * i], self.v[3 * i + 1], self.v[3 * i + 2]);
                for w in 0..mw {
                    let u = self.wall_c[w] * v1 + self.wall_s[w] * v2;
                    let o = -sh * v0 + ch * u + self.sn_half;
                    let t = o + lam[idx] * inv_mu;
                    idx += 1;
                    if t > 0.0 {
                        f += 0.5 * mu * t * t;
                        let c = mu * t;
                        self.gv[3 * i] -= c * sh;
                        self.gv[3 * i + 1] += c * ch * self.wall_c[w];
                        self.gv[3 * i + 2] += c * ch * self.wall_s[w];
                        // d/dh: -cs(h) v0 - K sn(h) u
                        gs += c * (-ch * v0 - k * sh * u);
                    }
                }
            }
        }
        self.pull_back(x, g);
        let n = g.len();
        g[n - 1] = gs;
        f + sigma
    }

    fn update_multipliers(&mut self, x: &[f64], lam: &mut [f64], mu: f64) -> f64 {
        let p = self.p;
        let k = self.kf.k;
        let sigma = x[x.len() - 1];
        self.chart(x);
        self.stale = true;
        let inv_k = 1.0 / k;
        let mut worst = 0.0f64;
        let mut idx = 0;
        for i in 0..p {
            for j in i + 1..p {
                let (a, b) = (&self.v[3 * i..3 * i + 3], &self.v[3 * j..3 * j + 3]);
                let ip = a[0] * b[0] + k * (a[1] * b[1] + a[2] * b[2]);
                let o = (ip - self.cs_d) * inv_k;
                worst = worst.max(o);
                lam[idx] = (lam[idx] + mu * o).max(0.0);
                idx += 1;
            }
        }
        if self.m == 0 {
            let vsr = sigma.signum() * self.kf.vs(sigma.abs());
            for i in 0..p {
                let o = (1.0 - self.v[3 * i]) * inv_k - vsr;
                worst = worst.max(o);
                lam[idx] = (lam[idx] + mu * o).max(0.0);
                idx += 1;
            }
        } else {
            let (sh, ch) = (self.kf.sn(sigma), self.kf.cs(sigma));
            for i in 0..p {
                let (v0, v1, v2) = (self.v[3 * i], self.v[3 * i + 1], self.v[3 * i + 2]);
                for w in 0..self.m as usize {
                    let o = -sh * v0 + ch * (self.wall_c[w] * v1 + self.wall_s[w] * v2) + self.sn_half;
                    worst = worst.max(o);
                    lam[idx] = (lam[idx] + mu * o).max(0.0);
                    idx += 1;
                }
            }
        }
        worst
    }

    fn normalize(&self, x: &mut [f64]) {
        if self.stride == 3 {
            let k = self.kf.k;
            for i in 0..self.p {
                let (a, b, c) = (x[3 * i], x[3 * i + 1], x[3 * i + 2]);
                let inv = 1.0 / (a * a + k * (b * b + c * c)).sqrt();
                x[3 * i] = a * inv;
                x[3 * i + 1] = b * inv;
                x[3 * i + 2] = c * inv;
            }
        }
    }

    fn score_of_sigma(&self, sigma: f64) -> f64 {
        // beyond the hemisphere (K > 0) or the ideal polygon (K < 0) there is no container
        if !(sigma < self.sigma_max) {
            return f64::INFINITY;
        }
        if self.m == 0 {
            2.0 * (sigma + 0.5)
        } else {
            2.0 * self.kf.atn(self.kf.sn(sigma) * (PI / self.m as f64).tan())
        }
    }

    fn fit_sigma(&mut self, x: &mut [f64]) {
        self.chart(x);
        let mut s = f64::NEG_INFINITY;
        for i in 0..self.p {
            let v = [self.v[3 * i], self.v[3 * i + 1], self.v[3 * i + 2]];
            s = s.max(self.required_sigma(&v));
        }
        let n = x.len();
        x[n - 1] = s;
    }

    fn start(&mut self, rng: &mut Rng, x: &mut [f64], kind: usize) {
        let r = self.start_radius();
        match kind % 2 {
            0 => {
                for i in 0..self.p {
                    let v = self.random_in_disk(rng, r);
                    self.put(x, i, &v);
                }
            }
            _ => {
                // a hexagonal patch of spacing ~1 in exponential coordinates, randomly shifted and turned,
                // its P points nearest O
                let spacing = 1.0 + 0.1 * rng.uniform();
                let (ox, oy) = (rng.uniform(), rng.uniform());
                let rot = 2.0 * PI * rng.uniform();
                let mut pts: Vec<(f64, f64, f64)> = Vec::new();
                let n = ((self.p as f64).sqrt() as i64) + 4;
                for a in -n..=n {
                    for b in -n..=n {
                        let px = (a as f64 + ox + 0.5 * (b as f64)) * spacing;
                        let py = (b as f64 + oy) * spacing * 3f64.sqrt() / 2.0;
                        let (c, s) = (rot.cos(), rot.sin());
                        let (qx, qy) = (c * px - s * py, s * px + c * py);
                        pts.push((qx * qx + qy * qy, qx, qy));
                    }
                }
                pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
                let cap = if self.m == 0 { self.sigma_max } else { self.sigma_max - 0.5 } * 0.97;
                for i in 0..self.p {
                    let (d2, qx, qy) = pts[i];
                    let mut d = d2.sqrt();
                    if d > cap {
                        d = cap * rng.uniform();
                    }
                    let phi = qy.atan2(qx);
                    let v = self.kf.polar(d, phi);
                    self.put(x, i, &v);
                }
            }
        }
        self.fit_sigma(x);
    }

    fn perturb(&mut self, rng: &mut Rng, x: &mut [f64], kind: usize, eta: f64, count: usize) {
        self.chart(x);
        match kind {
            0 => {
                // jitter every point by eta (distance units, in the chart)
                for i in 0..self.p {
                    for c in 0..self.stride {
                        x[self.stride * i + c] += eta * rng.normal();
                    }
                }
                self.normalize(x);
            }
            2 => {
                // jitter the points within distance 2 of a random point, harder
                let i0 = rng.below(self.p);
                let c0 = [self.v[3 * i0], self.v[3 * i0 + 1], self.v[3 * i0 + 2]];
                for i in 0..self.p {
                    if self.kf.dist(&c0, &self.v[3 * i..3 * i + 3]) < 2.0 {
                        for c in 0..self.stride {
                            x[self.stride * i + c] += 1.5 * eta * rng.normal();
                        }
                    }
                }
                self.normalize(x);
            }
            _ => {
                for _ in 0..count {
                    let i = rng.below(self.p);
                    let c = self.hole(rng, x, i, 24);
                    self.put(x, i, &c);
                    self.v[3 * i..3 * i + 3].copy_from_slice(&c);
                }
                // and a little jitter, to unlock the rest
                for i in 0..self.p {
                    for c in 0..self.stride {
                        x[self.stride * i + c] += 0.1 * eta * rng.normal();
                    }
                }
                self.normalize(x);
            }
        }
    }

    fn finish(&mut self, x: &[f64], slack: f64) -> Option<(f64, Value)> {
        let p = self.p;
        self.chart(x);
        let mut min_d = f64::INFINITY;
        for i in 0..p {
            for j in i + 1..p {
                let d = self.kf.dist(&self.v[3 * i..3 * i + 3], &self.v[3 * j..3 * j + 3]);
                min_d = min_d.min(d);
            }
        }
        if !(min_d >= 1.0 - slack) {
            return None;
        }
        let mut sigma = f64::NEG_INFINITY;
        let mut pieces = Vec::with_capacity(p);
        for i in 0..p {
            let v = [self.v[3 * i], self.v[3 * i + 1], self.v[3 * i + 2]];
            sigma = sigma.max(self.required_sigma(&v));
            let (ex, ey) = self.exp_coords(&v);
            pieces.push(json!({"x": ex, "y": ey, "theta": 0.0}));
        }
        let size = self.score_of_sigma(sigma) * (1.0 + 2e-15);
        if !size.is_finite() {
            return None;
        }
        Some((size, json!({"size": size, "pieces": pieces})))
    }

    fn sigma_scale(&self) -> f64 {
        1.0
    }

    fn invalidate(&mut self) {
        self.stale = true;
    }

    fn rows(&mut self, x: &[f64], keep: &dyn Fn(usize, f64) -> bool, out: &mut Rows) -> f64 {
        let p = self.p;
        let k = self.kf.k;
        let inv_k = 1.0 / k;
        let sigma = x[x.len() - 1];
        let sc = x.len() - 1;
        self.chart(x);
        out.clear();
        let mut worst = f64::NEG_INFINITY;
        let mut e: Vec<(usize, f64)> = Vec::with_capacity(7);
        let mut idx = 0;
        for i in 0..p {
            for j in i + 1..p {
                let (a0, a1, a2) = (self.v[3 * i], self.v[3 * i + 1], self.v[3 * i + 2]);
                let (b0, b1, b2) = (self.v[3 * j], self.v[3 * j + 1], self.v[3 * j + 2]);
                let o = (a0 * b0 + k * (a1 * b1 + a2 * b2) - self.cs_d) * inv_k;
                worst = worst.max(o);
                if keep(idx, o) {
                    e.clear();
                    self.pull_point(x, i, [b0 * inv_k, b1, b2], &mut e);
                    self.pull_point(x, j, [a0 * inv_k, a1, a2], &mut e);
                    out.push(idx, o, &e);
                }
                idx += 1;
            }
        }
        if self.m == 0 {
            let vsr = sigma.signum() * self.kf.vs(sigma.abs());
            let dvs = self.kf.sn(sigma.abs());
            for i in 0..p {
                let o = (1.0 - self.v[3 * i]) * inv_k - vsr;
                worst = worst.max(o);
                if keep(idx, o) {
                    e.clear();
                    self.pull_point(x, i, [-inv_k, 0.0, 0.0], &mut e);
                    e.push((sc, -dvs));
                    out.push(idx, o, &e);
                }
                idx += 1;
            }
        } else {
            let (sh, ch) = (self.kf.sn(sigma), self.kf.cs(sigma));
            for i in 0..p {
                let (v0, v1, v2) = (self.v[3 * i], self.v[3 * i + 1], self.v[3 * i + 2]);
                for w in 0..self.m as usize {
                    let u = self.wall_c[w] * v1 + self.wall_s[w] * v2;
                    let o = -sh * v0 + ch * u + self.sn_half;
                    worst = worst.max(o);
                    if keep(idx, o) {
                        e.clear();
                        self.pull_point(x, i, [-sh, ch * self.wall_c[w], ch * self.wall_s[w]], &mut e);
                        e.push((sc, -ch * v0 - k * sh * u));
                        out.push(idx, o, &e);
                    }
                    idx += 1;
                }
            }
        }
        worst
    }
}

// ---------------------------------------------------------------------------------------------
// Sphere

pub struct Sphere {
    pub p: usize,
    v: Vec<f64>,
    gv: Vec<f64>,
    /// neighbour list (i, j, pair index); built at sigma = sref with margin `skin` in the dot product
    nb: Vec<u32>,
    vref: Vec<f64>,
    sref: f64,
    skin: f64,
    stale: bool,
}

impl Sphere {
    pub fn new(p: usize) -> Sphere {
        Sphere {
            p,
            v: vec![0.0; 3 * p],
            gv: vec![0.0; 3 * p],
            nb: Vec::with_capacity(3 * p * (p - 1) / 2),
            vref: vec![0.0; 3 * p],
            sref: 0.0,
            skin: 0.0,
            stale: true,
        }
    }

    /// For unit vectors |a.b - a'.b'| <= |a - a'| + |b - b'|: a pair left out at the build (dot <=
    /// sref - skin) stays below sigma - skin/4 while every point moves less than skin/4 and sigma
    /// stays above sref - skin/4.
    #[inline]
    fn refresh(&mut self, sigma: f64, lam: &[f64]) {
        let p = self.p;
        if !self.stale && sigma >= self.sref - 0.25 * self.skin {
            let lim = 0.0625 * self.skin * self.skin;
            let mut moved = false;
            for i in 0..p {
                let d0 = self.v[3 * i] - self.vref[3 * i];
                let d1 = self.v[3 * i + 1] - self.vref[3 * i + 1];
                let d2 = self.v[3 * i + 2] - self.vref[3 * i + 2];
                if d0 * d0 + d1 * d1 + d2 * d2 > lim {
                    moved = true;
                    break;
                }
            }
            if !moved {
                return;
            }
        }
        self.stale = false;
        self.vref.copy_from_slice(&self.v);
        self.sref = sigma;
        // the shell up to 1.4 times the contact angle
        let theta = sigma.clamp(-1.0, 1.0).acos();
        self.skin = (sigma - (1.4 * theta).min(PI).cos()).max(1e-3);
        let cut = sigma - self.skin;
        self.nb.clear();
        let mut idx = 0u32;
        for i in 0..p {
            let a = &self.v[3 * i..3 * i + 3];
            for j in i + 1..p {
                let b = &self.v[3 * j..3 * j + 3];
                if a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > cut || lam[idx as usize] > 0.0 {
                    self.nb.push(i as u32);
                    self.nb.push(j as u32);
                    self.nb.push(idx);
                }
                idx += 1;
            }
        }
    }

    #[inline]
    fn chart(&mut self, x: &[f64]) {
        for i in 0..self.p {
            let (a, b, c) = (x[3 * i], x[3 * i + 1], x[3 * i + 2]);
            let inv = 1.0 / (a * a + b * b + c * c).sqrt();
            self.v[3 * i] = a * inv;
            self.v[3 * i + 1] = b * inv;
            self.v[3 * i + 2] = c * inv;
        }
    }

    fn random_unit(rng: &mut Rng) -> [f64; 3] {
        loop {
            let v = [rng.normal(), rng.normal(), rng.normal()];
            let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if n > 1e-6 {
                return [v[0] / n, v[1] / n, v[2] / n];
            }
        }
    }
}

/// Quaternion [w, x, y, z] whose rotation takes the north pole e3 to the unit vector c (for the
/// southern half through the south pole, so that no component cancels).
pub fn quat_to(c: &[f64]) -> [f64; 4] {
    if c[2] >= 0.0 {
        [1.0 + c[2], -c[1], c[0], 0.0]
    } else {
        [-c[1], 1.0 - c[2], 0.0, c[0]]
    }
}

impl Model for Sphere {
    fn invalidate(&mut self) {
        self.stale = true;
    }

    fn rows(&mut self, x: &[f64], keep: &dyn Fn(usize, f64) -> bool, out: &mut Rows) -> f64 {
        let p = self.p;
        let sigma = x[x.len() - 1];
        let sc = x.len() - 1;
        self.chart(x);
        out.clear();
        let mut worst = f64::NEG_INFINITY;
        let mut e: Vec<(usize, f64)> = Vec::with_capacity(7);
        let mut idx = 0;
        for i in 0..p {
            for j in i + 1..p {
                let a = [self.v[3 * i], self.v[3 * i + 1], self.v[3 * i + 2]];
                let b = [self.v[3 * j], self.v[3 * j + 1], self.v[3 * j + 2]];
                let ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
                let o = ab - sigma;
                worst = worst.max(o);
                if keep(idx, o) {
                    e.clear();
                    for (pt, v, w) in [(i, &a, &b), (j, &b, &a)] {
                        let (u0, u1, u2) = (x[3 * pt], x[3 * pt + 1], x[3 * pt + 2]);
                        let n = (u0 * u0 + u1 * u1 + u2 * u2).sqrt();
                        // d(v.w)/du = (w - v (v.w)) / |u|
                        for d in 0..3 {
                            e.push((3 * pt + d, (w[d] - v[d] * ab) / n));
                        }
                    }
                    e.push((sc, -1.0));
                    out.push(idx, o, &e);
                }
                idx += 1;
            }
        }
        worst
    }

    fn dim(&self) -> usize {
        3 * self.p + 1
    }
    fn ncons(&self) -> usize {
        self.p * (self.p - 1) / 2
    }
    fn npts(&self) -> usize {
        self.p
    }

    fn eval(&mut self, x: &[f64], lam: &[f64], mu: f64, g: &mut [f64]) -> f64 {
        let p = self.p;
        let sigma = x[x.len() - 1];
        self.chart(x);
        for e in self.gv.iter_mut() {
            *e = 0.0;
        }
        let inv_mu = 1.0 / mu;
        let mut f = 0.0;
        let mut gs = 1.0;
        self.refresh(sigma, lam);
        for e in self.nb.chunks_exact(3) {
            let (i, j, pi) = (e[0] as usize, e[1] as usize, e[2] as usize);
            let (a0, a1, a2) = (self.v[3 * i], self.v[3 * i + 1], self.v[3 * i + 2]);
            let (b0, b1, b2) = (self.v[3 * j], self.v[3 * j + 1], self.v[3 * j + 2]);
            let t = a0 * b0 + a1 * b1 + a2 * b2 - sigma + lam[pi] * inv_mu;
            if t > 0.0 {
                f += 0.5 * mu * t * t;
                let c = mu * t;
                self.gv[3 * i] += c * b0;
                self.gv[3 * i + 1] += c * b1;
                self.gv[3 * i + 2] += c * b2;
                self.gv[3 * j] += c * a0;
                self.gv[3 * j + 1] += c * a1;
                self.gv[3 * j + 2] += c * a2;
                gs -= c;
            }
        }
        for i in 0..p {
            let (a, b, c) = (x[3 * i], x[3 * i + 1], x[3 * i + 2]);
            let n = (a * a + b * b + c * c).sqrt();
            let v = &self.v[3 * i..3 * i + 3];
            let gv = &self.gv[3 * i..3 * i + 3];
            let vg = v[0] * gv[0] + v[1] * gv[1] + v[2] * gv[2];
            g[3 * i] = (gv[0] - v[0] * vg) / n;
            g[3 * i + 1] = (gv[1] - v[1] * vg) / n;
            g[3 * i + 2] = (gv[2] - v[2] * vg) / n;
        }
        let n = g.len();
        g[n - 1] = gs;
        f + sigma
    }

    fn update_multipliers(&mut self, x: &[f64], lam: &mut [f64], mu: f64) -> f64 {
        let p = self.p;
        let sigma = x[x.len() - 1];
        self.chart(x);
        self.stale = true;
        let mut worst = 0.0f64;
        let mut idx = 0;
        for i in 0..p {
            for j in i + 1..p {
                let (a, b) = (&self.v[3 * i..3 * i + 3], &self.v[3 * j..3 * j + 3]);
                let o = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] - sigma;
                worst = worst.max(o);
                lam[idx] = (lam[idx] + mu * o).max(0.0);
                idx += 1;
            }
        }
        worst
    }

    fn normalize(&self, x: &mut [f64]) {
        for i in 0..self.p {
            let (a, b, c) = (x[3 * i], x[3 * i + 1], x[3 * i + 2]);
            let inv = 1.0 / (a * a + b * b + c * c).sqrt();
            x[3 * i] = a * inv;
            x[3 * i + 1] = b * inv;
            x[3 * i + 2] = c * inv;
        }
    }

    fn score_of_sigma(&self, sigma: f64) -> f64 {
        1.0 / sigma.clamp(-1.0, 1.0).acos()
    }

    fn fit_sigma(&mut self, x: &mut [f64]) {
        self.chart(x);
        let mut s = -1.0f64;
        for i in 0..self.p {
            for j in i + 1..self.p {
                let (a, b) = (&self.v[3 * i..3 * i + 3], &self.v[3 * j..3 * j + 3]);
                s = s.max(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
            }
        }
        let n = x.len();
        x[n - 1] = s;
    }

    fn start(&mut self, rng: &mut Rng, x: &mut [f64], kind: usize) {
        match kind % 2 {
            0 => {
                for i in 0..self.p {
                    let v = Sphere::random_unit(rng);
                    x[3 * i..3 * i + 3].copy_from_slice(&v);
                }
            }
            _ => {
                // golden spiral, randomly turned, slightly jittered
                let a = Sphere::random_unit(rng);
                let b0 = Sphere::random_unit(rng);
                // orthonormal frame (a, b, c)
                let ab = a[0] * b0[0] + a[1] * b0[1] + a[2] * b0[2];
                let mut b = [b0[0] - ab * a[0], b0[1] - ab * a[1], b0[2] - ab * a[2]];
                let nb = (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]).sqrt();
                for e in b.iter_mut() {
                    *e /= nb;
                }
                let c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
                let golden = PI * (3.0 - 5f64.sqrt());
                let n = self.p as f64;
                let off = rng.uniform();
                for i in 0..self.p {
                    let z = 1.0 - 2.0 * (i as f64 + 0.5) / n;
                    let r = (1.0 - z * z).max(0.0).sqrt();
                    let phi = golden * (i as f64 + off);
                    let (px, py) = (r * phi.cos(), r * phi.sin());
                    for d in 0..3 {
                        x[3 * i + d] = px * b[d] + py * c[d] + z * a[d] + 0.02 * rng.normal();
                    }
                }
                self.normalize(x);
            }
        }
        self.fit_sigma(x);
    }

    fn perturb(&mut self, rng: &mut Rng, x: &mut [f64], kind: usize, eta: f64, count: usize) {
        // eta and the holes are in units of the current angle between neighbours
        self.chart(x);
        let theta = x[x.len() - 1].clamp(-1.0, 1.0).acos();
        match kind {
            0 => {
                for e in x[..3 * self.p].iter_mut() {
                    *e += eta * theta * rng.normal();
                }
            }
            2 => {
                // jitter the points within 2.5 contact angles of a random point, harder
                let i0 = rng.below(self.p);
                let cut = (2.5 * theta).min(PI).cos();
                for i in 0..self.p {
                    let d = self.v[3 * i] * self.v[3 * i0] + self.v[3 * i + 1] * self.v[3 * i0 + 1] + self.v[3 * i + 2] * self.v[3 * i0 + 2];
                    if d > cut {
                        for c in 0..3 {
                            x[3 * i + c] += 1.5 * eta * theta * rng.normal();
                        }
                    }
                }
            }
            _ => {
                for _ in 0..count {
                    let i = rng.below(self.p);
                    let mut best = [0.0; 3];
                    let mut best_val = f64::INFINITY;
                    for _ in 0..24 {
                        let c = Sphere::random_unit(rng);
                        let mut near = -1.0f64;
                        for j in 0..self.p {
                            if j == i {
                                continue;
                            }
                            let v = &self.v[3 * j..3 * j + 3];
                            near = near.max(c[0] * v[0] + c[1] * v[1] + c[2] * v[2]);
                        }
                        if near < best_val {
                            best_val = near;
                            best = c;
                        }
                    }
                    x[3 * i..3 * i + 3].copy_from_slice(&best);
                    self.v[3 * i..3 * i + 3].copy_from_slice(&best);
                }
                for e in x[..3 * self.p].iter_mut() {
                    *e += 0.1 * eta * theta * rng.normal();
                }
            }
        }
        self.normalize(x);
    }

    fn finish(&mut self, x: &[f64], _slack: f64) -> Option<(f64, Value)> {
        // the centres exactly as the validator computes them from the quaternions
        let p = self.p;
        self.chart(x);
        let mut qs = Vec::with_capacity(p);
        let mut cs = Vec::with_capacity(p);
        for i in 0..p {
            let q = quat_to(&self.v[3 * i..3 * i + 3]);
            cs.push(polypack_sphere::centre_of(&q));
            qs.push(q);
        }
        let mut min_ang = f64::INFINITY;
        for i in 0..p {
            for j in i + 1..p {
                let d = cs[i][0] * cs[j][0] + cs[i][1] * cs[j][1] + cs[i][2] * cs[j][2];
                min_ang = min_ang.min(d.clamp(-1.0, 1.0).acos());
            }
        }
        if !(min_ang > 0.0) {
            return None;
        }
        let rho = (1.0 / min_ang) * (1.0 + 2e-15);
        let pieces: Vec<Value> = qs.iter().map(|q| json!({"q": [q[0], q[1], q[2], q[3]]})).collect();
        Some((rho, json!({"rho": rho, "pieces": pieces})))
    }
}
