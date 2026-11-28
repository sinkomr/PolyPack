//! The objective of one face problem, minimised at every local step, in internal units (bounding radius 1).
//!
//! Variables: every piece's centre (and angle, for polygons), the container scale s, and for every near
//! pair of polygons a separating line (phi, beta): unit normal u = (cos phi, sin phi) pointing from the
//! first piece to the second, offset beta from the midpoint m of the centres. With pressure w > 0,
//!
//!   G = sum over near pairs of  sum_{v in i} max(0, u.(v - m) - beta)^2 + sum_{v in j} max(0, beta - u.(v - m))^2
//!     + sum over pieces, walls e and vertices v of max(0, n_e.v - s h_e)^2
//!     + w s
//!
//! (disks: max(0, 2 - |c_i - c_j|)^2 and max(0, n_e.c + 1 - s h_e)^2). The penalty is zero exactly when every
//! pair is separated by its line and every piece lies in s Q. Every term is the square of a smooth function cut
//! at zero, so G is continuously differentiable, also at the face-to-face contacts where a separating-axis
//! depth has kinks.
//!
//! The vertices with a positive term form an arc of the polygon around the vertex that reaches furthest
//! in the line's (or wall's) direction, found from the angles in O(1); the arc is walked outward until a
//! term is zero, so a term costs O(1 + vertices across), not O(N): pieces with 100 sides cost about what
//! hexagons cost.

use crate::geom::{Container, Piece};
use crate::lbfgs::{Exit, Lbfgs, Objective};
use polypack_flat::clock::thread_cpu_seconds;
use std::f64::consts::{FRAC_PI_2, PI};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// The budget shared by every face search of one run: evaluations, CPU time, the client's stop flag and
/// wall-clock end.
pub struct Budget<'a> {
    pub evals: u64,
    pub eval_limit: u64,
    /// End of the run in this thread's CPU seconds.
    pub deadline: f64,
    pub stop: Option<&'a AtomicBool>,
    pub wall: Option<Instant>,
    pub exhausted: bool,
    /// Why the budget ran out: "evals", "cpu", "deadline" or "stop".
    pub halt: &'static str,
    tick: u32,
}

impl<'a> Budget<'a> {
    pub fn new(deadline: f64, eval_limit: u64, stop: Option<&'a AtomicBool>, wall: Option<Instant>) -> Budget<'a> {
        Budget { evals: 0, eval_limit, deadline, stop, wall, exhausted: false, halt: "", tick: 0 }
    }

    /// True when the run must end. Reads the clocks every 16 calls.
    pub fn poll(&mut self) -> bool {
        if self.exhausted {
            return true;
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
            self.check_clocks();
        }
        self.exhausted
    }

    /// Reads the clocks now.
    pub fn check_clocks(&mut self) -> bool {
        if thread_cpu_seconds() >= self.deadline {
            self.exhausted = true;
            self.halt = "cpu";
        } else if self.wall.is_some_and(|w| Instant::now() >= w) {
            self.exhausted = true;
            self.halt = "deadline";
        }
        self.exhausted
    }
}

/// A configuration of one face problem in internal units.
#[derive(Clone, Debug)]
pub struct Sol {
    /// x, y (and theta for polygons) per piece.
    pub q: Vec<f64>,
    pub s: f64,
    /// Dense k x k tables of separating lines (phi, beta) for i < j, and whether one is stored.
    pub phi: Vec<f64>,
    pub beta: Vec<f64>,
    pub has: Vec<bool>,
}

impl Sol {
    pub fn new(k: usize, dim: usize, poly: bool) -> Sol {
        let t = if poly { k * k } else { 0 };
        Sol { q: vec![0.0; dim * k], s: 0.0, phi: vec![0.0; t], beta: vec![0.0; t], has: vec![false; t] }
    }
    pub fn copy_from(&mut self, o: &Sol) {
        self.q.clone_from(&o.q);
        self.s = o.s;
        self.phi.clone_from(&o.phi);
        self.beta.clone_from(&o.beta);
        self.has.clone_from(&o.has);
    }
    pub fn forget_lines(&mut self) {
        self.has.iter_mut().for_each(|h| *h = false);
    }
}

pub struct Model {
    pub pc: Piece,
    pub ct: Container,
    pub k: usize,
    pub dim: usize,
    /// Pressure on the container scale.
    pub w: f64,
    pub pairs: Vec<(u32, u32)>,
    off: usize,
    nvar: usize,
    x: Vec<f64>,
    anchor: Vec<f64>,
    /// Pairs whose bounding circles are within `skin` are listed; the list is rebuilt when a piece has
    /// moved half of it.
    pub skin: f64,
    rebuild: bool,
    cs: Vec<f64>,
    sn: Vec<f64>,
    /// cos and sin of the walls' normal angles.
    cpsi: Vec<f64>,
    spsi: Vec<f64>,
    /// Iterations of the current local minimisation.
    pub hop_it: u64,
    /// Abort a minimisation whose G / w at iteration `abort_it` is above `abort_level`.
    pub abort_it: u64,
    pub abort_level: f64,
    pub aborted: bool,
    /// Penalty (G without the pressure term) at the end of the last local minimisation.
    pub last_e: f64,
    pub stat_iters: u64,
    pub stat_calls: u64,
}

/// The terms of one arc: sum t^2, sum 2t, sum 2t sin(angle) over the vertices with t = a + cos(gamma + b_k) > 0.
#[inline(always)]
fn arc(n: usize, step: f64, gnum: f64, cg: f64, sg: f64, cb: &[f64], sb: &[f64], a: f64) -> (f64, f64, f64) {
    let kf = ((-gnum - FRAC_PI_2) / step).round();
    let k0 = (kf as i64).rem_euclid(n as i64) as usize;
    let c = cg * cb[k0] - sg * sb[k0];
    let t = a + c;
    if t <= 0.0 {
        return (0.0, 0.0, 0.0);
    }
    let s1 = sg * cb[k0] + cg * sb[k0];
    let mut e = t * t;
    let mut h = 2.0 * t;
    let mut hs = 2.0 * t * s1;
    let mut cnt = 1;
    let mut kk = k0;
    while cnt < n {
        kk = if kk + 1 == n { 0 } else { kk + 1 };
        let t = a + cg * cb[kk] - sg * sb[kk];
        if t <= 0.0 {
            break;
        }
        let s1 = sg * cb[kk] + cg * sb[kk];
        e += t * t;
        h += 2.0 * t;
        hs += 2.0 * t * s1;
        cnt += 1;
    }
    kk = k0;
    while cnt < n {
        kk = if kk == 0 { n - 1 } else { kk - 1 };
        let t = a + cg * cb[kk] - sg * sb[kk];
        if t <= 0.0 {
            break;
        }
        let s1 = sg * cb[kk] + cg * sb[kk];
        e += t * t;
        h += 2.0 * t;
        hs += 2.0 * t * s1;
        cnt += 1;
    }
    (e, h, hs)
}

impl Model {
    pub fn new(pc: Piece, ct: Container, k: usize) -> Model {
        let dim = if pc.n == 0 { 2 } else { 3 };
        let maxvar = dim * k + 1 + if pc.n > 0 { k * k } else { 0 };
        let cpsi = ct.psi.iter().map(|p| p.cos()).collect();
        let spsi = ct.psi.iter().map(|p| p.sin()).collect();
        Model {
            pc,
            ct,
            k,
            dim,
            w: 1e-2,
            pairs: Vec::with_capacity(k * k / 2),
            off: dim * k + 1,
            nvar: dim * k + 1,
            x: vec![0.0; maxvar],
            anchor: vec![0.0; 2 * k],
            skin: 0.5,
            rebuild: false,
            cs: vec![0.0; k],
            sn: vec![0.0; k],
            cpsi,
            spsi,
            hop_it: 0,
            abort_it: 0,
            abort_level: f64::INFINITY,
            aborted: false,
            last_e: 0.0,
            stat_iters: 0,
            stat_calls: 0,
        }
    }

    pub fn nvar(&self) -> usize {
        self.nvar
    }

    /// The smallest scale at which every piece of q lies in s Q.
    pub fn fit_size(&self, q: &[f64]) -> f64 {
        let mut s = 0.0f64;
        for i in 0..self.k {
            let th = if self.dim == 3 { q[3 * i + 2] } else { 0.0 };
            s = s.max(self.ct.fit(&self.pc, q[self.dim * i], q[self.dim * i + 1], th, 1.0, 0.0));
        }
        s
    }

    fn pose(&self, q: &[f64], i: usize) -> [f64; 3] {
        if self.dim == 3 {
            [q[3 * i], q[3 * i + 1], q[3 * i + 2]]
        } else {
            [q[2 * i], q[2 * i + 1], 0.0]
        }
    }

    /// Penalty of the line (phi, beta) for the pair (i, j) of q.
    pub fn line_penalty(&self, q: &[f64], i: usize, j: usize, phi: f64, beta: f64) -> f64 {
        let n = self.pc.n;
        let step = self.pc.period;
        let (sp, cp) = phi.sin_cos();
        let dx = q[3 * j] - q[3 * i];
        let dy = q[3 * j + 1] - q[3 * i + 1];
        let ud = cp * dx + sp * dy;
        let ai = -0.5 * ud - beta;
        let aj = beta - 0.5 * ud;
        let mut e = 0.0;
        if ai + 1.0 > 0.0 {
            let (si, ci) = q[3 * i + 2].sin_cos();
            let cg = ci * cp + si * sp;
            let sg = si * cp - ci * sp;
            e += arc(n, step, q[3 * i + 2] - phi, cg, sg, &self.pc.cb, &self.pc.sb, ai).0;
        }
        if aj + 1.0 > 0.0 {
            let (sj, cj) = q[3 * j + 2].sin_cos();
            let cg = -(cj * cp + sj * sp);
            let sg = -(sj * cp - cj * sp);
            e += arc(n, step, q[3 * j + 2] - phi - PI, cg, sg, &self.pc.cb, &self.pc.sb, aj).0;
        }
        e
    }

    /// Lists the near pairs of `sol`, chooses their lines and packs the variables.
    pub fn build(&mut self, sol: &Sol, check_lines: bool) {
        let k = self.k;
        let dim = self.dim;
        let q = &sol.q;
        self.pairs.clear();
        let cut = 2.0 + self.skin;
        let cut2 = cut * cut;
        for i in 0..k {
            for j in i + 1..k {
                let dx = q[dim * j] - q[dim * i];
                let dy = q[dim * j + 1] - q[dim * i + 1];
                if dx * dx + dy * dy < cut2 {
                    self.pairs.push((i as u32, j as u32));
                }
            }
        }
        self.x[..dim * k].copy_from_slice(q);
        self.x[dim * k] = sol.s;
        self.off = dim * k + 1;
        self.nvar = self.off;
        if dim == 3 {
            self.nvar += 2 * self.pairs.len();
            for p in 0..self.pairs.len() {
                let (i, j) = (self.pairs[p].0 as usize, self.pairs[p].1 as usize);
                let t = i * k + j;
                let mut line = (sol.phi[t], sol.beta[t]);
                if !sol.has[t] || !line.0.is_finite() || !line.1.is_finite() {
                    let (_, phi, beta) = self.pc.sat_axis(1.0, self.pose(q, i), self.pose(q, j));
                    line = (phi, beta);
                } else if check_lines {
                    let (_, phi, beta) = self.pc.sat_axis(1.0, self.pose(q, i), self.pose(q, j));
                    if self.line_penalty(q, i, j, phi, beta) < self.line_penalty(q, i, j, line.0, line.1) {
                        line = (phi, beta);
                    }
                }
                let o = self.off + 2 * p;
                self.x[o] = line.0;
                self.x[o + 1] = line.1;
            }
        }
        for i in 0..k {
            self.anchor[2 * i] = q[dim * i];
            self.anchor[2 * i + 1] = q[dim * i + 1];
        }
    }

    fn unpack(&self, x: &[f64], sol: &mut Sol) {
        let k = self.k;
        let dim = self.dim;
        sol.q.copy_from_slice(&x[..dim * k]);
        sol.s = x[dim * k];
        if dim == 3 {
            for (p, &(i, j)) in self.pairs.iter().enumerate() {
                let t = i as usize * k + j as usize;
                let o = self.off + 2 * p;
                sol.phi[t] = x[o];
                sol.beta[t] = x[o + 1];
                sol.has[t] = true;
            }
        }
    }

    /// Minimises G at pressure w from `sol` (updated in place). `check_lines` compares every stored line
    /// with the separating-axis line first (after a perturbation).
    #[allow(clippy::too_many_arguments)]
    pub fn local_min(&mut self, lb: &mut Lbfgs, bud: &mut Budget, sol: &mut Sol, w: f64, max_iter: usize, gtol: f64, check_lines: bool) -> Exit {
        self.w = w;
        self.hop_it = 0;
        self.aborted = false;
        // start the container where the pieces just fit: s has no curvature until it meets them
        sol.s = self.fit_size(&sol.q);
        let mut left = max_iter;
        let mut exit = Exit::Stalled;
        for round in 0..50 {
            self.build(sol, check_lines || round > 0);
            self.rebuild = false;
            let mut x = std::mem::take(&mut self.x);
            let nvar = self.nvar;
            let (fval, e, it) = {
                let mut run = Run { m: self, b: bud };
                lb.run(&mut run, &mut x[..nvar], left, gtol, 0.05)
            };
            self.unpack(&x[..nvar], sol);
            self.last_e = fval - self.w * sol.s;
            self.x = x;
            left = left.saturating_sub(it);
            exit = e;
            self.stat_iters += it as u64;
            if !(e == Exit::Stopped && self.rebuild && !bud.exhausted && !self.aborted) || left == 0 {
                break;
            }
        }
        self.stat_calls += 1;
        exit
    }

    /// G and its gradient at x.
    pub fn eval(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        if self.dim == 2 {
            self.eval_disk(x, g)
        } else {
            self.eval_poly(x, g)
        }
    }

    fn eval_disk(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        let k = self.k;
        let s = x[2 * k];
        g.fill(0.0);
        let mut e = 0.0;
        for &(i, j) in &self.pairs {
            let (i, j) = (i as usize, j as usize);
            let dx = x[2 * j] - x[2 * i];
            let dy = x[2 * j + 1] - x[2 * i + 1];
            let d2 = dx * dx + dy * dy;
            if d2 < 4.0 {
                let d = d2.sqrt().max(1e-300);
                let t = 2.0 - d;
                e += t * t;
                let h = 2.0 * t / d;
                g[2 * i] += h * dx;
                g[2 * i + 1] += h * dy;
                g[2 * j] -= h * dx;
                g[2 * j + 1] -= h * dy;
            }
        }
        let mut gs = self.w;
        let ct = &self.ct;
        let lim = s * ct.rho - 1.0;
        for i in 0..k {
            let (cx, cy) = (x[2 * i], x[2 * i + 1]);
            if lim > 0.0 && cx * cx + cy * cy <= lim * lim {
                continue;
            }
            for e_ in 0..ct.m {
                let t = ct.nx[e_] * cx + ct.ny[e_] * cy + 1.0 - s * ct.h[e_];
                if t > 0.0 {
                    e += t * t;
                    let h = 2.0 * t;
                    g[2 * i] += h * ct.nx[e_];
                    g[2 * i + 1] += h * ct.ny[e_];
                    gs -= h * ct.h[e_];
                }
            }
        }
        g[2 * k] = gs;
        e + self.w * s
    }

    fn eval_poly(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        let k = self.k;
        let n = self.pc.n;
        let step = self.pc.period;
        let s = x[3 * k];
        for i in 0..k {
            let (sn, cs) = x[3 * i + 2].sin_cos();
            self.sn[i] = sn;
            self.cs[i] = cs;
        }
        g.fill(0.0);
        let cb = &self.pc.cb;
        let sb = &self.pc.sb;
        let mut e = 0.0;
        let off = self.off;
        for (p, &(i, j)) in self.pairs.iter().enumerate() {
            let (i, j) = (i as usize, j as usize);
            let o = off + 2 * p;
            let phi = x[o];
            let beta = x[o + 1];
            let dx = x[3 * j] - x[3 * i];
            let dy = x[3 * j + 1] - x[3 * i + 1];
            // cheap exit: a pair whose centres are apart by more than two bounding radii along the line
            let (sp, cp) = phi.sin_cos();
            let ud = cp * dx + sp * dy;
            let ai = -0.5 * ud - beta;
            let aj = beta - 0.5 * ud;
            if ai + 1.0 <= 0.0 && aj + 1.0 <= 0.0 {
                continue;
            }
            let upd = -sp * dx + cp * dy;
            let (mut hsum, mut gphi, mut gb, mut gti, mut gtj) = (0.0, 0.0, 0.0, 0.0, 0.0);
            if ai + 1.0 > 0.0 {
                let cg = self.cs[i] * cp + self.sn[i] * sp;
                let sg = self.sn[i] * cp - self.cs[i] * sp;
                let (ee, h, hs) = arc(n, step, x[3 * i + 2] - phi, cg, sg, cb, sb, ai);
                e += ee;
                hsum += h;
                gphi += -0.5 * upd * h + hs;
                gb -= h;
                gti -= hs;
            }
            if aj + 1.0 > 0.0 {
                let cg = -(self.cs[j] * cp + self.sn[j] * sp);
                let sg = -(self.sn[j] * cp - self.cs[j] * sp);
                let (ee, h, hs) = arc(n, step, x[3 * j + 2] - phi - PI, cg, sg, cb, sb, aj);
                e += ee;
                hsum += h;
                gphi += -0.5 * upd * h + hs;
                gb += h;
                gtj -= hs;
            }
            let hm = 0.5 * hsum;
            g[3 * i] += hm * cp;
            g[3 * i + 1] += hm * sp;
            g[3 * j] -= hm * cp;
            g[3 * j + 1] -= hm * sp;
            g[3 * i + 2] += gti;
            g[3 * j + 2] += gtj;
            g[o] = gphi;
            g[o + 1] = gb;
        }
        let mut gs = self.w;
        let ct = &self.ct;
        let lim = s * ct.rho - 1.0;
        for i in 0..k {
            let (cx, cy) = (x[3 * i], x[3 * i + 1]);
            if lim > 0.0 && cx * cx + cy * cy <= lim * lim {
                continue;
            }
            let th = x[3 * i + 2];
            for e_ in 0..ct.m {
                let a = ct.nx[e_] * cx + ct.ny[e_] * cy - s * ct.h[e_];
                if a + 1.0 <= 0.0 {
                    continue;
                }
                let (cp, sp) = (self.cpsi[e_], self.spsi[e_]);
                let cg = self.cs[i] * cp + self.sn[i] * sp;
                let sg = self.sn[i] * cp - self.cs[i] * sp;
                let (ee, h, hs) = arc(n, step, th - ct.psi[e_], cg, sg, cb, sb, a);
                if h > 0.0 {
                    e += ee;
                    g[3 * i] += h * ct.nx[e_];
                    g[3 * i + 1] += h * ct.ny[e_];
                    g[3 * i + 2] -= hs;
                    gs -= h * ct.h[e_];
                }
            }
        }
        g[3 * k] = gs;
        e + self.w * s
    }

    /// The penalty part of G (no pressure term) at sol, its lines as stored (missing ones from the
    /// separating axis).
    pub fn penalty(&mut self, sol: &Sol) -> f64 {
        let w = self.w;
        self.w = 0.0;
        self.build(sol, false);
        let nvar = self.nvar;
        let x = std::mem::take(&mut self.x);
        let mut g = vec![0.0; nvar];
        let e = self.eval(&x[..nvar], &mut g);
        self.x = x;
        self.w = w;
        e
    }

    /// The packed variables of the last `build` (tests).
    pub fn packed(&self) -> Vec<f64> {
        self.x[..self.nvar].to_vec()
    }
}

/// A local minimisation: the model and the run's budget.
struct Run<'m, 'b, 'a> {
    m: &'m mut Model,
    b: &'b mut Budget<'a>,
}

impl Objective for Run<'_, '_, '_> {
    #[inline]
    fn eval(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        self.b.evals += 1;
        self.m.eval(x, g)
    }

    fn stop(&mut self, x: &[f64], f: f64) -> bool {
        let m = &mut *self.m;
        m.hop_it += 1;
        if m.hop_it == m.abort_it && m.w > 0.0 && f / m.w > m.abort_level {
            m.aborted = true;
            return true;
        }
        let lim = 0.25 * m.skin * m.skin;
        let dim = m.dim;
        for i in 0..m.k {
            let dx = x[dim * i] - m.anchor[2 * i];
            let dy = x[dim * i + 1] - m.anchor[2 * i + 1];
            if dx * dx + dy * dy > lim {
                m.rebuild = true;
                return true;
            }
        }
        self.b.poll()
    }
}
