//! The penalty energy minimised at every local step, at a fixed score s.
//!
//! Variables (all in length units, so that one L-BFGS step moves everything by comparable amounts):
//! - the centres y_i in the frame of the cell at the last list build (B_ref); the actual centres are F y_i with
//!   F = B B_ref^{-1} (F = I for sq and hex, whose cell is fixed at a given score);
//! - for polygons the angles as phi_i = R theta_i (a unit change of phi moves a vertex by about one unit);
//! - for a free lattice the cell's shape at fixed area s^2: B = [[s e^(T/s), U], [0, s e^(-T/s)]];
//! - for every near polygon image pair a separating line (a, b, beta): unit normal u = (a, b) / |(a, b)| (from
//!   the first piece towards the second), offset beta from the pair's midpoint.
//!
//! E = sum over near image pairs (i, j, k) of the pair penalty, with d = F (y_j - y_i + B_ref k):
//! - disks: max(0, 1 - |d|)^2;
//! - polygons: sum over vertices v of i of max(0, u.(v - d/2) - beta)^2 + sum over vertices w of j of
//!   max(0, beta - u.(d + w - d/2))^2 (vertices relative to their centres). It is zero exactly when the line
//!   separates the two pieces, and continuously differentiable in everything.
//!
//! E = 0 exactly when the packing at score s has no overlap. For a polygon pair only the vertices beyond the
//! line are visited: the extreme vertex in the line's direction is found by climbing from the one found at the
//! previous evaluation (vertices are equally spaced on a circle), then the walk goes both ways while vertices
//! are beyond the line, so a pair costs O(1) whatever N, near contact.
//!
//! Near pairs are listed when their centres are within 2R + skin (all lattice vectors by the Cramer window; a
//! grid over the cell for many pieces); the list is rebuilt when a centre has moved far enough, or the free cell
//! deformed enough, that an unlisted pair could come within 2R.

use crate::budget::Budget;
use crate::geom::{inverse, mat_mul, mul, near_images, pair_key, Family, Shape, Sol};
use crate::lbfgs::{Exit, Lbfgs, Objective, Tol};
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub struct Pair {
    pub i: u32,
    pub j: u32,
    pub key: u64,
    /// B_ref k, the lattice vector of the image, in the build frame.
    pub e: [f64; 2],
    /// Cached extreme vertices of i (towards j) and j (towards i).
    pub ki: u16,
    pub kj: u16,
    /// Direction of the pair's line at the build: the line variable tau turns it to
    /// u = (u0 + t u0') / sqrt(1 + t^2), t = tau / R, u0' = u0 turned by +90 degrees.
    pub u0: [f64; 2],
}

/// What one relaxation gave.
#[derive(Clone, Copy, Debug)]
pub struct Relaxed {
    pub e: f64,
    pub iters: u32,
    /// Stopped near the anchor (a return to its basin).
    pub same: bool,
    /// Given up at `abort_it` iterations (the energy was still above `abort_level`).
    pub aborted: bool,
}

pub struct Model<'a> {
    pub sh: Shape,
    pub p: usize,
    pub fam: Family,
    pub poly: bool,
    pub free: bool,
    pub pairs: Vec<Pair>,
    off_ang: usize,
    off_shape: usize,
    off_lines: usize,
    pub nvar: usize,
    pub s: f64,
    bref: [f64; 4],
    bref_inv: [f64; 4],
    y0: Vec<f64>,
    pub skin: f64,
    cut: f64,
    sn: Vec<f64>,
    cs: Vec<f64>,
    x: Vec<f64>,
    pub rebuild: bool,
    pub evals: u64,
    pub budget: Budget<'a>,
    /// Anchor of the same-basin test: positions, angles, pieces to skip, radius (0: off).
    pub anchor_pos: Vec<f64>,
    pub anchor_ang: Vec<f64>,
    pub anchor_skip: Vec<bool>,
    pub anchor_r: f64,
    pub same: bool,
    /// Per-piece energy shares, accumulated by `eval` when `per_on`.
    per_on: bool,
    pub per: Vec<f64>,
    pub stat_rebuilds: u64,
    pub stat_iters: u64,
    pub stat_relax: u64,
    /// Iterations of the current relaxation (all its rounds); a relaxation whose energy is still above
    /// `abort_level` after `abort_it` of them is given up (0: never).
    pub hop_it: u32,
    pub abort_it: u32,
    pub abort_level: f64,
    pub aborted: bool,
    /// Energies at iterations 25, 50, 100, 200, 400 of the last relaxation (development traces).
    pub marks: [f64; 5],
    cells: Vec<Vec<u32>>,
}

#[inline(always)]
fn walk(base: &[[f64; 2]], r: f64, sn: f64, cs: f64, w: [f64; 2], c0: f64, kc: &mut u16, mut f: impl FnMut(f64, [f64; 2])) {
    let n = base.len();
    // w in the piece's own frame
    let wp0 = cs * w[0] + sn * w[1];
    let wp1 = cs * w[1] - sn * w[0];
    let proj = |k: usize| r * (wp0 * base[k][0] + wp1 * base[k][1]);
    let mut k = (*kc as usize).min(n - 1);
    let mut pk = proj(k);
    loop {
        let k1 = if k + 1 == n { 0 } else { k + 1 };
        let p1 = proj(k1);
        if p1 > pk {
            k = k1;
            pk = p1;
        } else {
            break;
        }
    }
    loop {
        let k1 = if k == 0 { n - 1 } else { k - 1 };
        let p1 = proj(k1);
        if p1 > pk {
            k = k1;
            pk = p1;
        } else {
            break;
        }
    }
    *kc = k as u16;
    let t0 = pk - c0;
    if !(t0 > 0.0) {
        return;
    }
    let vert = |k: usize| {
        let b = base[k];
        [r * (cs * b[0] - sn * b[1]), r * (sn * b[0] + cs * b[1])]
    };
    f(t0, vert(k));
    let mut cnt = 1;
    let mut a = k;
    while cnt < n {
        a = if a + 1 == n { 0 } else { a + 1 };
        let t = proj(a) - c0;
        if !(t > 0.0) {
            break;
        }
        f(t, vert(a));
        cnt += 1;
    }
    let mut b = k;
    while cnt < n {
        b = if b == 0 { n - 1 } else { b - 1 };
        let t = proj(b) - c0;
        if !(t > 0.0) {
            break;
        }
        f(t, vert(b));
        cnt += 1;
    }
}

/// The line direction of the chart: u = (u0 + t u0') / sqrt(1 + t^2), and q = 1 / sqrt(1 + t^2).
#[inline(always)]
fn line_dir(u0: [f64; 2], t: f64) -> ([f64; 2], f64) {
    let q = 1.0 / (1.0 + t * t).sqrt();
    ([(u0[0] - t * u0[1]) * q, (u0[1] + t * u0[0]) * q], q)
}

/// The vertex index of a piece at angle theta whose direction is nearest the direction w.
#[inline]
fn nearest_vertex(sh: &Shape, theta: f64, w: [f64; 2]) -> u16 {
    let a = w[1].atan2(w[0]) - theta - 0.5 * PI;
    let k = (a / sh.step).round().rem_euclid(sh.n as f64) as usize;
    k.min(sh.n - 1) as u16
}

/// Smallest singular value of a 2x2 matrix (column-major).
fn sigma_min(f: &[f64; 4]) -> f64 {
    let a = f[0] * f[0] + f[1] * f[1];
    let c = f[2] * f[2] + f[3] * f[3];
    let b = f[0] * f[2] + f[1] * f[3];
    let h = 0.5 * (a + c);
    let q = (0.25 * (a - c) * (a - c) + b * b).sqrt();
    (h - q).max(0.0).sqrt()
}

impl<'a> Model<'a> {
    pub fn new(sh: Shape, fam: Family, p: usize, budget: Budget<'a>) -> Model<'a> {
        let poly = sh.n > 0;
        let free = fam == Family::Free;
        let skin = if poly { (0.5 * sh.big_r).min(1.0).max(0.3) } else { 0.3 };
        Model {
            p,
            fam,
            poly,
            free,
            pairs: Vec::new(),
            off_ang: 2 * p,
            off_shape: 0,
            off_lines: 0,
            nvar: 0,
            s: 0.0,
            bref: [0.0; 4],
            bref_inv: [0.0; 4],
            y0: vec![0.0; 2 * p],
            skin,
            cut: 2.0 * sh.big_r + skin,
            sn: vec![0.0; p],
            cs: vec![1.0; p],
            x: Vec::new(),
            rebuild: false,
            evals: 0,
            budget,
            anchor_pos: vec![0.0; 2 * p],
            anchor_ang: vec![0.0; p],
            anchor_skip: vec![false; p],
            anchor_r: 0.0,
            same: false,
            per_on: false,
            per: vec![0.0; p],
            stat_rebuilds: 0,
            stat_iters: 0,
            stat_relax: 0,
            hop_it: 0,
            abort_it: 0,
            abort_level: f64::INFINITY,
            aborted: false,
            marks: [f64::NAN; 5],
            cells: Vec::new(),
            sh,
        }
    }

    #[inline]
    pub fn done(&self) -> bool {
        self.budget.done
    }

    /// The cell at shape variables (T, U) (free only).
    #[inline]
    fn cell(&self, t: f64, u: f64) -> [f64; 4] {
        let s = self.s;
        let q = (t / s).exp();
        [s * q, 0.0, u, s / q]
    }

    /// The deformation F = B B_ref^{-1} at x.
    #[inline]
    fn deform(&self, x: &[f64]) -> [f64; 4] {
        if self.free {
            mat_mul(&self.cell(x[self.off_shape], x[self.off_shape + 1]), &self.bref_inv)
        } else {
            [1.0, 0.0, 0.0, 1.0]
        }
    }

    /// Lists the near image pairs of `sol`, sorted by key.
    fn list_pairs(&mut self, sol: &Sol) {
        let b = sol.b;
        self.pairs.clear();
        let pairs = &mut self.pairs;
        near_images(&b, &sol.pos, self.cut, &mut self.cells, |i, j, m, n, _| {
            let e = [m as f64 * b[0] + n as f64 * b[2], m as f64 * b[1] + n as f64 * b[3]];
            pairs.push(Pair { i: i as u32, j: j as u32, key: pair_key(i, j, m, n), e, ki: 0, kj: 0, u0: [1.0, 0.0] });
        });
        if !self.pairs.windows(2).all(|w| w[0].key < w[1].key) {
            self.pairs.sort_unstable_by_key(|q| q.key);
        }
    }

    /// The separating-axis line of a pair (i at 0 with angle ti, j at d with angle tj): the edge normal of either
    /// piece along which the gap is largest, placed midway in the gap. For many sides only the normals near the
    /// direction of d are tried (the best one is there unless the pieces overlap deeply).
    fn sat_line(&self, ti: f64, tj: f64, d: [f64; 2]) -> [f64; 3] {
        let sh = &self.sh;
        let n = sh.n;
        let off = 0.5 * PI + 0.5 * sh.step;
        let mut best = f64::NEG_INFINITY;
        let mut line = [1.0, 0.0, 0.0];
        let (ka, kb, span) = if n <= 16 {
            (0i64, 0i64, n as i64)
        } else {
            let al = d[1].atan2(d[0]);
            let ka = ((al - ti - off) / sh.step).round() as i64 - 2;
            let kb = ((al + PI - tj - off) / sh.step).round() as i64 - 2;
            (ka, kb, 5)
        };
        for q in 0..span {
            let phi = ti + off + sh.step * (ka + q) as f64;
            let (s, c) = phi.sin_cos();
            let hb = sh.support(tj, phi + PI);
            let g = c * d[0] + s * d[1] - sh.apo - hb;
            if g > best {
                best = g;
                line = [c, s, 0.5 * (sh.apo - hb)];
            }
            let phi = tj + off + sh.step * (kb + q) as f64;
            let (s, c) = phi.sin_cos();
            let ha = sh.support(ti, phi + PI);
            let g = -(c * d[0] + s * d[1]) - sh.apo - ha;
            if g > best {
                best = g;
                line = [-c, -s, 0.5 * (ha - sh.apo)];
            }
        }
        line
    }

    /// Penalty of the pair (i at 0, j at d) with line l (normalised), every vertex (for line choice only).
    fn line_penalty(&self, ti: f64, tj: f64, d: [f64; 2], l: [f64; 3]) -> f64 {
        let sh = &self.sh;
        let hd = 0.5 * (l[0] * d[0] + l[1] * d[1]);
        let (si, ci) = ti.sin_cos();
        let (sj, cj) = tj.sin_cos();
        let r = sh.big_r;
        let mut e = 0.0;
        for b in &sh.base {
            let oi = [r * (ci * b[0] - si * b[1]), r * (si * b[0] + ci * b[1])];
            let t = l[0] * oi[0] + l[1] * oi[1] - hd - l[2];
            if t > 0.0 {
                e += t * t;
            }
            let oj = [r * (cj * b[0] - sj * b[1]), r * (sj * b[0] + cj * b[1])];
            let t = l[2] - hd - (l[0] * oj[0] + l[1] * oj[1]);
            if t > 0.0 {
                e += t * t;
            }
        }
        e
    }

    /// Lists the pairs of `sol`, chooses their lines (the stored one, or the separating-axis line when there is
    /// none, or when `check_lines` and it is better) and packs the variables.
    fn build(&mut self, sol: &Sol, check_lines: bool) {
        let p = self.p;
        self.s = sol.s;
        self.bref = sol.b;
        self.bref_inv = inverse(&sol.b);
        self.y0.copy_from_slice(&sol.pos);
        self.list_pairs(sol);
        self.off_ang = 2 * p;
        self.off_shape = self.off_ang + if self.poly { p } else { 0 };
        self.off_lines = self.off_shape + if self.free { 2 } else { 0 };
        self.nvar = self.off_lines + if self.poly { 2 * self.pairs.len() } else { 0 };
        if self.x.len() < self.nvar {
            self.x.resize(self.nvar, 0.0);
        }
        let mut x = std::mem::take(&mut self.x);
        x[..2 * p].copy_from_slice(&sol.pos);
        if self.poly {
            let r = self.sh.big_r;
            for i in 0..p {
                x[self.off_ang + i] = r * sol.ang[i];
            }
        }
        if self.free {
            x[self.off_shape] = sol.s * (sol.b[0] / sol.s).ln();
            x[self.off_shape + 1] = sol.b[2];
        }
        if self.poly {
            let mut pairs = std::mem::take(&mut self.pairs);
            for (k, pr) in pairs.iter_mut().enumerate() {
                let (i, j) = (pr.i as usize, pr.j as usize);
                let d = [sol.pos[2 * j] - sol.pos[2 * i] + pr.e[0], sol.pos[2 * j + 1] - sol.pos[2 * i + 1] + pr.e[1]];
                let (ti, tj) = (sol.ang[i], sol.ang[j]);
                let stored = sol.lines.binary_search_by_key(&pr.key, |e| e.0).ok().map(|ix| sol.lines[ix].1);
                let mut l = match stored {
                    Some(l) => {
                        let nrm = (l[0] * l[0] + l[1] * l[1]).sqrt();
                        if nrm > 1e-12 && nrm.is_finite() && l[2].is_finite() {
                            [l[0] / nrm, l[1] / nrm, l[2]]
                        } else {
                            self.sat_line(ti, tj, d)
                        }
                    }
                    None => self.sat_line(ti, tj, d),
                };
                if check_lines && stored.is_some() {
                    let cand = self.sat_line(ti, tj, d);
                    if self.line_penalty(ti, tj, d, cand) < self.line_penalty(ti, tj, d, l) {
                        l = cand;
                    }
                }
                pr.ki = nearest_vertex(&self.sh, ti, [l[0], l[1]]);
                pr.kj = nearest_vertex(&self.sh, tj, [-l[0], -l[1]]);
                pr.u0 = [l[0], l[1]];
                let o = self.off_lines + 2 * k;
                x[o] = 0.0;
                x[o + 1] = l[2];
            }
            self.pairs = pairs;
        }
        self.x = x;
    }

    fn unpack(&self, x: &[f64], sol: &mut Sol) {
        let p = self.p;
        let f = self.deform(x);
        for i in 0..p {
            let c = mul(&f, [x[2 * i], x[2 * i + 1]]);
            sol.pos[2 * i] = c[0];
            sol.pos[2 * i + 1] = c[1];
        }
        if self.poly {
            let r = self.sh.big_r;
            for i in 0..p {
                sol.ang[i] = x[self.off_ang + i] / r;
            }
            sol.lines.clear();
            let inv_r = 1.0 / r;
            for (k, pr) in self.pairs.iter().enumerate() {
                let o = self.off_lines + 2 * k;
                let u = line_dir(pr.u0, x[o] * inv_r).0;
                sol.lines.push((pr.key, [u[0], u[1], x[o + 1]]));
            }
        }
        if self.free {
            sol.b = self.cell(x[self.off_shape], x[self.off_shape + 1]);
        }
    }

    /// Relaxes `sol` at its score (L-BFGS, rebuilding the list as needed). `check_lines`: compare every stored
    /// line with a fresh separating-axis line first (after a perturbation).
    pub fn relax(&mut self, lb: &mut Lbfgs, sol: &mut Sol, tol: &Tol, check_lines: bool) -> Relaxed {
        self.same = false;
        self.aborted = false;
        self.hop_it = 0;
        self.marks = [f64::NAN; 5];
        self.stat_relax += 1;
        let mut left = tol.max_iter;
        let mut iters = 0u32;
        let mut e = f64::INFINITY;
        for round in 0..200 {
            self.build(sol, check_lines || round > 0);
            self.rebuild = false;
            let mut x = std::mem::take(&mut self.x);
            let t = Tol { max_iter: left, ..*tol };
            let nvar = self.nvar;
            let out = lb.run(self, &mut x[..nvar], &t);
            self.unpack(&x[..nvar], sol);
            self.x = x;
            iters += out.iters;
            left = left.saturating_sub(out.iters);
            e = out.f;
            if out.exit == Exit::Hook && self.rebuild && !self.budget.done && !self.same && !self.aborted && left > 0 {
                self.stat_rebuilds += 1;
                continue;
            }
            break;
        }
        self.stat_iters += iters as u64;
        Relaxed { e, iters, same: self.same, aborted: self.aborted }
    }

    /// The energy of `sol` as it is (lines as stored, or separating-axis lines), with the per-piece shares in
    /// `self.per` when `per` is set.
    pub fn energy(&mut self, sol: &Sol, per: bool) -> f64 {
        self.build(sol, false);
        let nvar = self.nvar;
        let x = std::mem::take(&mut self.x);
        let mut g = vec![0.0; nvar];
        self.per_on = per;
        if per {
            self.per.fill(0.0);
        }
        let e = self.eval(&x[..nvar], &mut g);
        self.per_on = false;
        self.x = x;
        e
    }

    fn near_anchor(&self, x: &[f64]) -> bool {
        let f = self.deform(x);
        let r2 = self.anchor_r * self.anchor_r;
        let rr = self.sh.big_r;
        for i in 0..self.p {
            if self.anchor_skip[i] {
                continue;
            }
            let c = mul(&f, [x[2 * i], x[2 * i + 1]]);
            let dx = c[0] - self.anchor_pos[2 * i];
            let dy = c[1] - self.anchor_pos[2 * i + 1];
            if dx * dx + dy * dy > r2 {
                return false;
            }
            if self.poly {
                let da = x[self.off_ang + i] - rr * self.anchor_ang[i];
                if da * da > r2 {
                    return false;
                }
            }
        }
        true
    }
}

impl Objective for Model<'_> {
    fn eval(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        self.evals += 1;
        self.budget.poll(self.evals);
        let nvar = self.nvar;
        g[..nvar].fill(0.0);
        let p = self.p;
        let f = self.deform(x);
        let r = self.sh.big_r;
        let poly = self.poly;
        let free = self.free;
        if poly {
            let inv_r = 1.0 / r;
            for i in 0..p {
                let (s, c) = (x[self.off_ang + i] * inv_r).sin_cos();
                self.sn[i] = s;
                self.cs[i] = c;
            }
        }
        let mut e = 0.0;
        let mut gf = [0.0f64; 4];
        let inv_r = 1.0 / r;
        let off_ang = self.off_ang;
        let off_lines = self.off_lines;
        let per_on = self.per_on;
        let Model { pairs, sh, sn, cs, per, .. } = self;
        let base = &sh.base[..];
        for (k, pr) in pairs.iter_mut().enumerate() {
            let (i, j) = (pr.i as usize, pr.j as usize);
            let ev = [x[2 * j] - x[2 * i] + pr.e[0], x[2 * j + 1] - x[2 * i + 1] + pr.e[1]];
            let d = mul(&f, ev);
            let gd: [f64; 2];
            if !poly {
                let d2 = d[0] * d[0] + d[1] * d[1];
                if d2 >= 1.0 {
                    continue;
                }
                let dist = d2.sqrt().max(1e-300);
                let t = 1.0 - dist;
                e += t * t;
                if per_on {
                    per[i] += 0.5 * t * t;
                    per[j] += 0.5 * t * t;
                }
                let h = -2.0 * t / dist;
                gd = [h * d[0], h * d[1]];
            } else {
                let o = off_lines + 2 * k;
                let t = x[o] * inv_r;
                let beta = x[o + 1];
                let (u, q) = line_dir(pr.u0, t);
                let hd = 0.5 * (u[0] * d[0] + u[1] * d[1]);
                let ci = hd + beta;
                let cj = hd - beta;
                if ci >= r && cj >= r {
                    continue;
                }
                let (mut hi, mut hj, mut gti, mut gtj, mut gux, mut guy, mut ep) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
                if ci < r {
                    walk(base, r, sn[i], cs[i], u, ci, &mut pr.ki, |t, ov| {
                        ep += t * t;
                        let h = 2.0 * t;
                        hi += h;
                        gti += h * (u[1] * ov[0] - u[0] * ov[1]);
                        gux += h * ov[0];
                        guy += h * ov[1];
                    });
                }
                if cj < r {
                    walk(base, r, sn[j], cs[j], [-u[0], -u[1]], cj, &mut pr.kj, |t, ov| {
                        ep += t * t;
                        let h = 2.0 * t;
                        hj += h;
                        gtj += h * (u[0] * ov[1] - u[1] * ov[0]);
                        gux -= h * ov[0];
                        guy -= h * ov[1];
                    });
                }
                let hs = hi + hj;
                if hs == 0.0 {
                    continue;
                }
                e += ep;
                if per_on {
                    per[i] += 0.5 * ep;
                    per[j] += 0.5 * ep;
                }
                gux -= 0.5 * d[0] * hs;
                guy -= 0.5 * d[1] * hs;
                // du/dt = q^3 (u0' - t u0)
                let n0 = [-pr.u0[1], pr.u0[0]];
                g[o] = q * q * q * (gux * (n0[0] - t * pr.u0[0]) + guy * (n0[1] - t * pr.u0[1])) * inv_r;
                g[o + 1] = hj - hi;
                g[off_ang + i] += gti / r;
                g[off_ang + j] += gtj / r;
                gd = [-0.5 * u[0] * hs, -0.5 * u[1] * hs];
            }
            let gy = [f[0] * gd[0] + f[1] * gd[1], f[2] * gd[0] + f[3] * gd[1]];
            g[2 * j] += gy[0];
            g[2 * j + 1] += gy[1];
            g[2 * i] -= gy[0];
            g[2 * i + 1] -= gy[1];
            if free {
                gf[0] += gd[0] * ev[0];
                gf[1] += gd[1] * ev[0];
                gf[2] += gd[0] * ev[1];
                gf[3] += gd[1] * ev[1];
            }
        }
        if free {
            let inv = &self.bref_inv;
            let gb00 = gf[0] * inv[0] + gf[2] * inv[2];
            let gb01 = gf[0] * inv[1] + gf[2] * inv[3];
            let gb11 = gf[1] * inv[1] + gf[3] * inv[3];
            let q = (x[self.off_shape] / self.s).exp();
            g[self.off_shape] = gb00 * q - gb11 / q;
            g[self.off_shape + 1] = gb01;
        }
        e
    }

    fn after_step(&mut self, x: &[f64], _f: f64, iter: u32) -> bool {
        if self.budget.done {
            return true;
        }
        let p = self.p;
        let mut dm2 = 0.0f64;
        for i in 0..p {
            let dx = x[2 * i] - self.y0[2 * i];
            let dy = x[2 * i + 1] - self.y0[2 * i + 1];
            dm2 = dm2.max(dx * dx + dy * dy);
        }
        let sig = if self.free { sigma_min(&self.deform(x)) } else { 1.0 };
        let contact = 2.0 * self.sh.big_r;
        if sig * (self.cut - 2.0 * dm2.sqrt()) < contact * (1.0 + 1e-9) {
            self.rebuild = true;
            return true;
        }
        self.hop_it += 1;
        match self.hop_it {
            25 => self.marks[0] = _f,
            50 => self.marks[1] = _f,
            100 => self.marks[2] = _f,
            200 => self.marks[3] = _f,
            400 => self.marks[4] = _f,
            _ => {}
        }
        if self.hop_it == self.abort_it && _f > self.abort_level {
            self.aborted = true;
            return true;
        }
        if self.anchor_r > 0.0 && iter >= 8 && iter % 4 == 0 && self.near_anchor(x) {
            self.same = true;
            return true;
        }
        false
    }

    fn exhausted(&self) -> bool {
        self.budget.done
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::rng::Rng;

    /// A random packing of p pieces at score s (free: a random sheared cell of area s^2).
    pub fn random_sol(rng: &mut Rng, fam: Family, p: usize, s: f64) -> Sol {
        let mut sol = Sol::new(p);
        sol.s = s;
        sol.b = if fam == Family::Free {
            let a = s * (0.3 * rng.signed()).exp();
            [a, 0.0, 0.4 * a * rng.signed(), s * s / a]
        } else {
            fam.basis(s)
        };
        for i in 0..p {
            let f = [rng.uniform() * 1.4 - 0.2, rng.uniform() * 1.4 - 0.2];
            let c = mul(&sol.b, f);
            sol.pos[2 * i] = c[0];
            sol.pos[2 * i + 1] = c[1];
            sol.ang[i] = 7.0 * rng.signed();
        }
        sol
    }

    /// The analytic gradient matches central differences, for every family and several shapes.
    #[test]
    fn gradient_matches_differences() {
        let mut rng = Rng::new(11);
        for fam in [Family::Sq, Family::Hex, Family::Free] {
            for &n in &[0usize, 3, 4, 5, 6, 9, 24, 60] {
                for &p in &[1usize, 2, 5] {
                    let sh = Shape::new(n);
                    let s = (p as f64 * sh.area / 0.95).sqrt() * if fam == Family::Hex { 1.07 } else { 1.0 };
                    let mut model = Model::new(sh.clone(), fam, p, Budget::new(1e9, None, None, None));
                    let mut sol = random_sol(&mut rng, fam, p, s);
                    // random lines for the near pairs
                    model.build(&sol, false);
                    for k in 0..model.pairs.len() {
                        sol.lines.push((model.pairs[k].key, [rng.signed(), rng.signed(), 0.3 * rng.signed()]));
                    }
                    sol.lines.sort_by_key(|e| e.0);
                    model.build(&sol, false);
                    let nv = model.nvar;
                    // the line charts away from their centres too
                    for k in model.off_lines..nv {
                        if (k - model.off_lines) % 2 == 0 {
                            model.x[k] = 0.8 * sh.big_r * rng.signed();
                        }
                    }
                    if model.free {
                        model.x[model.off_shape] += 0.1 * rng.signed();
                        model.x[model.off_shape + 1] += 0.1 * rng.signed();
                    }
                    let x0: Vec<f64> = model.x[..nv].to_vec();
                    let mut g = vec![0.0; nv];
                    let f0 = model.eval(&x0, &mut g);
                    assert!(f0.is_finite());
                    let mut gd = vec![0.0; nv];
                    for k in 0..nv {
                        let h = 1e-6;
                        let mut xp = x0.clone();
                        xp[k] += h;
                        let mut xm = x0.clone();
                        xm[k] -= h;
                        let fp = model.eval(&xp, &mut gd);
                        let fm = model.eval(&xm, &mut gd);
                        let num = (fp - fm) / (2.0 * h);
                        let tol = 1e-5 * (1.0 + num.abs()) + 1e-6 * f0.abs().sqrt();
                        assert!((num - g[k]).abs() < tol, "{fam:?} n={n} p={p} var {k} of {nv}: analytic {} numeric {}", g[k], num);
                    }
                }
            }
        }
    }

    /// The fast vertex walk gives the same penalty as visiting every vertex.
    #[test]
    fn walk_matches_full_penalty() {
        let mut rng = Rng::new(5);
        for &n in &[3usize, 5, 8, 17, 50, 100] {
            let sh = Shape::new(n);
            let model = Model::new(sh.clone(), Family::Sq, 2, Budget::new(1e9, None, None, None));
            for _ in 0..200 {
                let ti = 7.0 * rng.signed();
                let tj = 7.0 * rng.signed();
                let d = [2.0 * sh.big_r * rng.signed(), 2.0 * sh.big_r * rng.signed()];
                let a = 7.0 * rng.signed();
                let l = [a.cos(), a.sin(), 0.5 * sh.big_r * rng.signed()];
                let full = model.line_penalty(ti, tj, d, l);
                let hd = 0.5 * (l[0] * d[0] + l[1] * d[1]);
                let mut ep = 0.0;
                let (si, ci) = ti.sin_cos();
                let (sj, cj) = tj.sin_cos();
                let mut ki = rng.below(n) as u16;
                let mut kj = rng.below(n) as u16;
                walk(&sh.base, sh.big_r, si, ci, [l[0], l[1]], hd + l[2], &mut ki, |t, _| ep += t * t);
                walk(&sh.base, sh.big_r, sj, cj, [-l[0], -l[1]], hd - l[2], &mut kj, |t, _| ep += t * t);
                assert!((ep - full).abs() <= 1e-12 * (1.0 + full), "n={n}: walk {ep} full {full}");
            }
        }
    }
}
