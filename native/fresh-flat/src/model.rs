//! The objective minimised at every local step.
//!
//! Variables: every piece's centre (and angle, for polygons), the container size s, and for every
//! near pair of polygons a separating line (a, b, beta): unit normal u = (a, b) / |(a, b)|, offset beta
//! from the pair's midpoint m. The objective is
//!
//!   G = sum over near pairs (i, j) of  sum_{v in i} max(0, u.(v - m) - beta)^2
//!                                    + sum_{v in j} max(0, beta - u.(v - m))^2
//!     + sum over pieces of sum over vertices and container walls of max(0, wall excess)^2
//!     + w * s,
//!
//! for disks the pair term is max(0, 1 - |c_i - c_j|)^2. The penalty is zero exactly when every pair
//! is separated by its line and every piece lies in the container, so with no pressure (w = 0) a zero
//! minimum is a valid packing; with pressure w > 0 the minimiser trades a little overlap for a
//! smaller container, and the overlap shrinks with w (it is of order w). Every term is a square of a
//! smooth function cut at zero, so G is continuously differentiable: L-BFGS converges well, also at
//! the face-to-face contacts where a separating-axis depth has kinks.
//!
//! Pairs are listed once per local minimisation when their bounding circles come within a skin of
//! each other; the list is rebuilt when a piece has moved half the skin since.

use crate::geom::Shape;
use crate::lbfgs::{Exit, Lbfgs, Objective};
use polypack_flat::clock::thread_cpu_seconds;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use std::f64::consts::PI;

/// A configuration in the search's own frame (container centred at the origin, phi = 0).
#[derive(Clone, Debug)]
pub struct Sol {
    /// x, y (and theta for polygons) per piece.
    pub q: Vec<f64>,
    /// Container size (side, or diameter for a circle).
    pub s: f64,
    /// Dense P x P table of separating lines (a, b, beta) for i < j; polygons only.
    pub lines: Vec<f64>,
}

impl Sol {
    pub fn new(p: usize, dim: usize, poly: bool) -> Sol {
        Sol { q: vec![0.0; dim * p], s: 0.0, lines: if poly { vec![0.0; 3 * p * p] } else { Vec::new() } }
    }
    pub fn copy_from(&mut self, o: &Sol) {
        self.q.copy_from_slice(&o.q);
        self.s = o.s;
        self.lines.copy_from_slice(&o.lines);
    }
}

pub struct Model<'a> {
    pub sh: Shape,
    pub p: usize,
    pub dim: usize,
    pub n: usize,
    /// Pressure on the container size.
    pub w: f64,
    pub pairs: Vec<[u32; 2]>,
    off_l: usize,
    nvar: usize,
    x: Vec<f64>,
    /// Unit normal directions of a piece's edges at theta = 0.
    nbase: Vec<[f64; 2]>,
    vx: Vec<f64>,
    vy: Vec<f64>,
    ox: Vec<f64>,
    oy: Vec<f64>,
    anchor: Vec<f64>,
    pub skin: f64,
    rebuild: bool,
    pub evals: u64,
    pub deadline: f64,
    pub eval_limit: u64,
    /// A flag that ends the search when set, and a wall-clock end (the client's `FreshJob`).
    pub stop: Option<&'a AtomicBool>,
    pub wall: Option<Instant>,
    /// Why the budget ran out: "evals", "cpu", "deadline" or "stop".
    pub halt: &'static str,
    pub exhausted: bool,
    tick: u32,
    /// Statistics: local minimisations, L-BFGS iterations, list rebuilds, exits [converged, max, stopped, stalled].
    pub stat_calls: u64,
    pub stat_iters: u64,
    pub stat_rebuilds: u64,
    pub stat_exit: [u64; 4],
    pub conv_every: u64,
    conv_it: u64,
    /// Iterations of the current local minimisation (all its rounds).
    pub hop_it: u64,
    /// Abort a minimisation whose G / w at iteration `abort_it` is above `abort_level`.
    pub abort_it: u64,
    pub abort_level: f64,
    pub aborted: bool,
    /// Record G / w at iterations 25, 50 and 100 (development).
    pub trace_hop: bool,
    pub hop_marks: [f64; 3],
    /// Penalty (G without the pressure term) at the end of the last local minimisation.
    pub last_e: f64,
}

impl<'a> Model<'a> {
    pub fn new(sh: Shape, p: usize) -> Model<'a> {
        let n = sh.n;
        let dim = if n == 0 { 2 } else { 3 };
        let nbase = (0..n)
            .map(|k| {
                let a = PI / 2.0 + PI / n as f64 + 2.0 * PI * k as f64 / n as f64;
                [a.cos(), a.sin()]
            })
            .collect();
        let maxvar = dim * p + 1 + 3 * p * (p - 1) / 2;
        let skin = 0.5 * sh.big_r;
        Model {
            p,
            dim,
            n,
            w: 1e-4,
            pairs: Vec::with_capacity(p * p / 2),
            off_l: dim * p + 1,
            nvar: dim * p + 1,
            x: vec![0.0; maxvar],
            nbase,
            vx: vec![0.0; p * n.max(1)],
            vy: vec![0.0; p * n.max(1)],
            ox: vec![0.0; p * n.max(1)],
            oy: vec![0.0; p * n.max(1)],
            anchor: vec![0.0; 2 * p],
            skin,
            rebuild: false,
            evals: 0,
            deadline: f64::INFINITY,
            eval_limit: u64::MAX,
            stop: None,
            wall: None,
            halt: "",
            exhausted: false,
            tick: 0,
            stat_calls: 0,
            stat_iters: 0,
            stat_rebuilds: 0,
            stat_exit: [0; 4],
            conv_every: 0,
            conv_it: 0,
            hop_it: 0,
            abort_it: 0,
            abort_level: f64::INFINITY,
            aborted: false,
            trace_hop: false,
            hop_marks: [f64::NAN; 3],
            last_e: 0.0,
            sh,
        }
    }

    #[inline]
    fn verts(&mut self, q: &[f64]) {
        let n = self.n;
        let r = self.sh.big_r;
        for i in 0..self.p {
            let (x, y, th) = (q[3 * i], q[3 * i + 1], q[3 * i + 2]);
            let (sn, cs) = th.sin_cos();
            let (rc, rs) = (r * cs, r * sn);
            for k in 0..n {
                let b = self.sh.base[k];
                let ox = rc * b[0] - rs * b[1];
                let oy = rs * b[0] + rc * b[1];
                self.ox[i * n + k] = ox;
                self.oy[i * n + k] = oy;
                self.vx[i * n + k] = x + ox;
                self.vy[i * n + k] = y + oy;
            }
        }
    }

    /// Penalty of a line (a, b, beta) for the pair (i, j), vertices current.
    fn line_penalty(&self, q: &[f64], i: usize, j: usize, l: [f64; 3]) -> f64 {
        let n = self.n;
        let inv = 1.0 / (l[0] * l[0] + l[1] * l[1]).sqrt();
        let (ux, uy) = (l[0] * inv, l[1] * inv);
        let mx = 0.5 * (q[3 * i] + q[3 * j]);
        let my = 0.5 * (q[3 * i + 1] + q[3 * j + 1]);
        let mut e = 0.0;
        for k in 0..n {
            let t = ux * (self.vx[i * n + k] - mx) + uy * (self.vy[i * n + k] - my) - l[2];
            if t > 0.0 {
                e += t * t;
            }
            let t = l[2] - (ux * (self.vx[j * n + k] - mx) + uy * (self.vy[j * n + k] - my));
            if t > 0.0 {
                e += t * t;
            }
        }
        e
    }

    /// The separating-axis line of a pair: the edge normal along which the projections of i and j
    /// leave the largest gap (or overlap least), placed midway; vertices current.
    fn sat_line(&self, q: &[f64], i: usize, j: usize) -> [f64; 3] {
        let n = self.n;
        let mx = 0.5 * (q[3 * i] + q[3 * j]);
        let my = 0.5 * (q[3 * i + 1] + q[3 * j + 1]);
        let mut best = f64::NEG_INFINITY;
        let mut line = [1.0, 0.0, 0.0];
        for &piece in &[i, j] {
            let (sn, cs) = q[3 * piece + 2].sin_cos();
            for k in 0..n {
                let b = self.nbase[k];
                let ux = cs * b[0] - sn * b[1];
                let uy = sn * b[0] + cs * b[1];
                let (mut amin, mut amax, mut bmin, mut bmax) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
                for v in 0..n {
                    let ta = ux * (self.vx[i * n + v] - mx) + uy * (self.vy[i * n + v] - my);
                    amin = amin.min(ta);
                    amax = amax.max(ta);
                    let tb = ux * (self.vx[j * n + v] - mx) + uy * (self.vy[j * n + v] - my);
                    bmin = bmin.min(tb);
                    bmax = bmax.max(tb);
                }
                if bmin - amax > best {
                    best = bmin - amax;
                    line = [ux, uy, 0.5 * (amax + bmin)];
                }
                if amin - bmax > best {
                    best = amin - bmax;
                    line = [-ux, -uy, -0.5 * (amin + bmax)];
                }
            }
        }
        line
    }

    /// Lists the near pairs of `sol`, chooses their lines and packs the variables.
    fn build(&mut self, sol: &Sol, check_lines: bool) {
        let p = self.p;
        let dim = self.dim;
        let q = &sol.q;
        if self.n > 0 {
            self.verts(q);
        }
        self.pairs.clear();
        let cut = 2.0 * self.sh.big_r + self.skin;
        let cut2 = cut * cut;
        for i in 0..p {
            for j in i + 1..p {
                let dx = q[dim * j] - q[dim * i];
                let dy = q[dim * j + 1] - q[dim * i + 1];
                if dx * dx + dy * dy < cut2 {
                    self.pairs.push([i as u32, j as u32]);
                }
            }
        }
        self.x[..dim * p].copy_from_slice(q);
        self.x[dim * p] = sol.s;
        self.off_l = dim * p + 1;
        self.nvar = self.off_l;
        if self.n > 0 {
            self.nvar += 3 * self.pairs.len();
            for k in 0..self.pairs.len() {
                let [i, j] = self.pairs[k];
                let (i, j) = (i as usize, j as usize);
                let t = 3 * (i * p + j);
                let mut l = [sol.lines[t], sol.lines[t + 1], sol.lines[t + 2]];
                let nrm = (l[0] * l[0] + l[1] * l[1]).sqrt();
                if nrm < 1e-12 || !nrm.is_finite() {
                    l = self.sat_line(q, i, j);
                } else {
                    l[0] /= nrm;
                    l[1] /= nrm;
                    if check_lines {
                        let cand = self.sat_line(q, i, j);
                        if self.line_penalty(q, i, j, cand) < self.line_penalty(q, i, j, l) {
                            l = cand;
                        }
                    }
                }
                let o = self.off_l + 3 * k;
                self.x[o..o + 3].copy_from_slice(&l);
            }
        }
        for i in 0..p {
            self.anchor[2 * i] = q[dim * i];
            self.anchor[2 * i + 1] = q[dim * i + 1];
        }
    }

    fn unpack(&self, x: &[f64], sol: &mut Sol) {
        let p = self.p;
        let dim = self.dim;
        sol.q.copy_from_slice(&x[..dim * p]);
        sol.s = x[dim * p];
        if self.n > 0 {
            for (k, &[i, j]) in self.pairs.iter().enumerate() {
                let t = 3 * (i as usize * p + j as usize);
                let o = self.off_l + 3 * k;
                sol.lines[t..t + 3].copy_from_slice(&x[o..o + 3]);
            }
        }
    }

    /// Minimises G at pressure w from `sol` (updated in place). `check_lines` compares every stored
    /// line with a fresh separating-axis line first (after a perturbation).
    pub fn local_min(&mut self, lb: &mut Lbfgs, sol: &mut Sol, w: f64, max_iter: usize, gtol: f64, check_lines: bool) -> Exit {
        self.w = w;
        self.hop_it = 0;
        self.aborted = false;
        self.hop_marks = [f64::NAN; 3];
        // start the container where the pieces just fit: s has no curvature until it meets them
        sol.s = self.sh.fit_size(&sol.q, self.p);
        let mut left = max_iter;
        let mut exit = Exit::Stalled;
        for round in 0..50 {
            self.build(sol, check_lines || round > 0);
            self.rebuild = false;
            let mut x = std::mem::take(&mut self.x);
            let nvar = self.nvar;
            let (fval, e, it) = lb.run(self, &mut x[..nvar], left, gtol, 0.05);
            self.unpack(&x[..nvar], sol);
            self.last_e = fval - self.w * sol.s;
            self.x = x;
            left = left.saturating_sub(it);
            exit = e;
            self.stat_iters += it as u64;
            if self.rebuild {
                self.stat_rebuilds += 1;
            }
            if !(e == Exit::Stopped && self.rebuild && !self.exhausted && !self.aborted) || left == 0 {
                break;
            }
        }
        self.stat_calls += 1;
        self.stat_exit[match exit {
            Exit::Converged => 0,
            Exit::MaxIter => 1,
            Exit::Stopped => 2,
            Exit::Stalled => 3,
        }] += 1;
        exit
    }

    fn eval_disk(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        let p = self.p;
        let s = x[2 * p];
        g.fill(0.0);
        let mut e = 0.0;
        for &[i, j] in &self.pairs {
            let (i, j) = (i as usize, j as usize);
            let dx = x[2 * j] - x[2 * i];
            let dy = x[2 * j + 1] - x[2 * i + 1];
            let d2 = dx * dx + dy * dy;
            if d2 < 1.0 {
                let d = d2.sqrt().max(1e-300);
                let t = 1.0 - d;
                e += t * t;
                let h = 2.0 * t / d;
                g[2 * i] += h * dx;
                g[2 * i + 1] += h * dy;
                g[2 * j] -= h * dx;
                g[2 * j + 1] -= h * dy;
            }
        }
        let mut gs = self.w;
        if self.sh.m == 0 {
            let rho = 0.5 * s - 0.5;
            for i in 0..p {
                let (cx, cy) = (x[2 * i], x[2 * i + 1]);
                let d2 = cx * cx + cy * cy;
                if rho > 0.0 && d2 <= rho * rho {
                    continue;
                }
                let d = d2.sqrt().max(1e-300);
                let t = d - rho;
                if t > 0.0 {
                    e += t * t;
                    let h = 2.0 * t / d;
                    g[2 * i] += h * cx;
                    g[2 * i + 1] += h * cy;
                    gs -= t; // d rho / d s = 1/2
                }
            }
        } else {
            let a = s * self.sh.k_in - 0.5;
            let kin = self.sh.k_in;
            for i in 0..p {
                let (cx, cy) = (x[2 * i], x[2 * i + 1]);
                if a > 0.0 && cx * cx + cy * cy <= a * a {
                    continue;
                }
                for nv in &self.sh.cnorm {
                    let t = nv[0] * cx + nv[1] * cy - a;
                    if t > 0.0 {
                        e += t * t;
                        let h = 2.0 * t;
                        g[2 * i] += h * nv[0];
                        g[2 * i + 1] += h * nv[1];
                        gs -= h * kin;
                    }
                }
            }
        }
        g[2 * p] = gs;
        e + self.w * s
    }

    fn eval_poly(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        let p = self.p;
        let n = self.n;
        let s = x[3 * p];
        self.verts(x);
        g.fill(0.0);
        let mut e = 0.0;
        let off = self.off_l;
        let rb = self.sh.big_r * (1.0 + 1e-12);
        for (k, &[i, j]) in self.pairs.iter().enumerate() {
            let (i, j) = (i as usize, j as usize);
            let o = off + 3 * k;
            let (la, lb, beta) = (x[o], x[o + 1], x[o + 2]);
            let inv = 1.0 / (la * la + lb * lb).sqrt();
            let (ux, uy) = (la * inv, lb * inv);
            let mx = 0.5 * (x[3 * i] + x[3 * j]);
            let my = 0.5 * (x[3 * i + 1] + x[3 * j + 1]);
            let (mut gxi, mut gyi, mut gti) = (0.0, 0.0, 0.0);
            let (mut gxj, mut gyj, mut gtj) = (0.0, 0.0, 0.0);
            let (mut gux, mut guy, mut gb, mut gm) = (0.0, 0.0, 0.0, 0.0);
            let vi = i * n;
            let vj = j * n;
            // a piece whose bounding circle lies on its side of the line has no vertex across it
            let ci = ux * (x[3 * i] - mx) + uy * (x[3 * i + 1] - my) - beta + rb;
            let cj = beta - (ux * (x[3 * j] - mx) + uy * (x[3 * j + 1] - my)) + rb;
            if ci <= 0.0 && cj <= 0.0 {
                continue;
            }
            if ci > 0.0 {
                for v in 0..n {
                    let dx = self.vx[vi + v] - mx;
                    let dy = self.vy[vi + v] - my;
                    let t = ux * dx + uy * dy - beta;
                    if t > 0.0 {
                        e += t * t;
                        let h = 2.0 * t;
                        gm += h;
                        gti += h * (uy * self.ox[vi + v] - ux * self.oy[vi + v]);
                        gux += h * dx;
                        guy += h * dy;
                        gb -= h;
                    }
                }
            }
            if cj > 0.0 {
                for v in 0..n {
                    let dx = self.vx[vj + v] - mx;
                    let dy = self.vy[vj + v] - my;
                    let t = beta - (ux * dx + uy * dy);
                    if t > 0.0 {
                        e += t * t;
                        let h = 2.0 * t;
                        gm += h;
                        gtj -= h * (uy * self.ox[vj + v] - ux * self.oy[vj + v]);
                        gux -= h * dx;
                        guy -= h * dy;
                        gb += h;
                    }
                }
            }
            // centre gradients: d t / d c_i = u - u/2 for a vertex of i (it moves with c_i, the
            // midpoint with half of it) and u/2 for a vertex of j (through the midpoint only); the
            // reverse for c_j. Every active term therefore gives h u/2 on c_i and -h u/2 on c_j.
            let hm = 0.5 * gm;
            gxi += hm * ux;
            gyi += hm * uy;
            gxj -= hm * ux;
            gyj -= hm * uy;
            g[3 * i] += gxi;
            g[3 * i + 1] += gyi;
            g[3 * i + 2] += gti;
            g[3 * j] += gxj;
            g[3 * j + 1] += gyj;
            g[3 * j + 2] += gtj;
            let du = gux * ux + guy * uy;
            g[o] = (gux - du * ux) * inv;
            g[o + 1] = (guy - du * uy) * inv;
            g[o + 2] = gb;
        }
        let r = self.sh.big_r;
        let mut gs = self.w;
        if self.sh.m == 0 {
            let rho = 0.5 * s;
            for i in 0..p {
                let (cx, cy) = (x[3 * i], x[3 * i + 1]);
                let lim = rho - r;
                if lim > 0.0 && cx * cx + cy * cy <= lim * lim {
                    continue;
                }
                let vi = i * n;
                for v in 0..n {
                    let (px, py) = (self.vx[vi + v], self.vy[vi + v]);
                    let d2 = px * px + py * py;
                    if d2 <= rho * rho {
                        continue;
                    }
                    let d = d2.sqrt();
                    let t = d - rho;
                    e += t * t;
                    let h = 2.0 * t / d;
                    g[3 * i] += h * px;
                    g[3 * i + 1] += h * py;
                    g[3 * i + 2] += h * (py * self.ox[vi + v] - px * self.oy[vi + v]);
                    gs -= t;
                }
            }
        } else {
            let a = s * self.sh.k_in;
            let kin = self.sh.k_in;
            for i in 0..p {
                let (cx, cy) = (x[3 * i], x[3 * i + 1]);
                let lim = a - r;
                if lim > 0.0 && cx * cx + cy * cy <= lim * lim {
                    continue;
                }
                let vi = i * n;
                for nv in &self.sh.cnorm {
                    if nv[0] * cx + nv[1] * cy + r <= a {
                        continue;
                    }
                    for v in 0..n {
                        let t = nv[0] * self.vx[vi + v] + nv[1] * self.vy[vi + v] - a;
                        if t > 0.0 {
                            e += t * t;
                            let h = 2.0 * t;
                            g[3 * i] += h * nv[0];
                            g[3 * i + 1] += h * nv[1];
                            g[3 * i + 2] += h * (nv[1] * self.ox[vi + v] - nv[0] * self.oy[vi + v]);
                            gs -= h * kin;
                        }
                    }
                }
            }
        }
        g[3 * p] = gs;
        e + self.w * s
    }

    /// The penalty part of G (no pressure term) at sol, with its lines as stored.
    pub fn penalty(&mut self, sol: &Sol) -> f64 {
        let w = self.w;
        self.w = 0.0;
        self.build(sol, false);
        let nvar = self.nvar;
        let mut x = std::mem::take(&mut self.x);
        let mut g = vec![0.0; nvar];
        let e = self.eval(&x[..nvar], &mut g);
        self.x = std::mem::take(&mut x);
        self.w = w;
        e
    }
}

impl Objective for Model<'_> {
    #[inline]
    fn eval(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        self.evals += 1;
        if self.n == 0 {
            self.eval_disk(x, g)
        } else {
            self.eval_poly(x, g)
        }
    }

    fn stop(&mut self, x: &[f64], f: f64) -> bool {
        self.hop_it += 1;
        if self.hop_it == self.abort_it && self.w > 0.0 && f / self.w > self.abort_level {
            self.aborted = true;
            return true;
        }
        if self.trace_hop && (self.hop_it == 25 || self.hop_it == 50 || self.hop_it == 100) {
            self.hop_marks[(self.hop_it / 50).min(2) as usize] = f / self.w;
        }
        if self.conv_every > 0 {
            self.conv_it += 1;
            if self.conv_it % self.conv_every == 0 {
                let mut g = vec![0.0; x.len()];
                let w = self.w;
                let f = self.eval(x, &mut g);
                let gm = g.iter().fold(0.0f64, |a, &b| a.max(b.abs()));
                eprintln!("    it {} s {:.9} E {:.3e} |g| {:.2e}", self.conv_it, x[self.dim * self.p], f - w * x[self.dim * self.p], gm);
            }
        }
        let lim = 0.25 * self.skin * self.skin;
        let dim = self.dim;
        for i in 0..self.p {
            let dx = x[dim * i] - self.anchor[2 * i];
            let dy = x[dim * i + 1] - self.anchor[2 * i + 1];
            if dx * dx + dy * dy > lim {
                self.rebuild = true;
                return true;
            }
        }
        if self.evals >= self.eval_limit {
            self.exhausted = true;
            self.halt = "evals";
            return true;
        }
        if self.stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
            self.exhausted = true;
            self.halt = "stop";
            return true;
        }
        self.tick = self.tick.wrapping_add(1);
        if self.tick % 16 == 0 {
            if thread_cpu_seconds() >= self.deadline {
                self.exhausted = true;
                self.halt = "cpu";
                return true;
            }
            if self.wall.is_some_and(|w| Instant::now() >= w) {
                self.exhausted = true;
                self.halt = "deadline";
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;

    /// The analytic gradient of G agrees with central differences, for every shape pairing.
    #[test]
    fn gradient_matches_differences() {
        let mut rng = Rng::new(7);
        for &n in &[0usize, 3, 4, 5, 6, 7, 8] {
            for &m in &[0usize, 3, 4, 5, 6, 8] {
                let p = 6;
                let sh = Shape::new(n, m);
                let mut model = Model::new(sh.clone(), p);
                model.w = 0.37;
                let dim = model.dim;
                let mut sol = Sol::new(p, dim, n > 0);
                for i in 0..p {
                    sol.q[dim * i] = 1.6 * rng.signed();
                    sol.q[dim * i + 1] = 1.6 * rng.signed();
                    if dim == 3 {
                        sol.q[3 * i + 2] = 7.0 * rng.signed();
                    }
                }
                for v in sol.lines.iter_mut() {
                    *v = rng.signed();
                }
                sol.s = 1.5 * sh.area_bound(p);
                model.build(&sol, false);
                let nv = model.nvar;
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
                    let tol = 1e-5 * (1.0 + num.abs());
                    assert!((num - g[k]).abs() < tol, "n={n} m={m} var {k} of {nv}: analytic {} numeric {}", g[k], num);
                }
            }
        }
    }
}
