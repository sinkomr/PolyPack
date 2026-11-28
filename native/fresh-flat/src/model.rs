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
//! Only the vertices across a line (or a wall) contribute. For few-sided pieces every vertex is
//! projected (the dense path); for many-sided pieces, or many-sided containers, the terms are found by
//! walking (the sparse path, [`crate::geom::arc_above`] and `Shape::walls_above_from`): the vertices
//! of a regular polygon across a line form one arc around the vertex farthest along its normal, so a
//! pair costs O(1 + vertices across) instead of O(N), and a piece at the wall O(walls its bounding
//! circle crosses + vertices across) instead of O(N M). The farthest vertex (and the wall nearest a
//! centre) is found by climbing from where it was at the previous evaluation, kept per pair and per
//! piece: the lines and poses move little between evaluations, so the climb is usually no step, and
//! no angle is computed in the loop. Both paths compute the same function.
//!
//! Pairs are listed once per local minimisation when their bounding circles come within a skin of
//! each other; the list is rebuilt when a piece has moved half the skin since.

use crate::geom::{arc_above, for_vertices_above, peak_guess, Shape};
use crate::lbfgs::{Exit, Lbfgs, Objective};
use polypack_flat::clock::thread_cpu_seconds;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// Largest N whose pairs are evaluated densely (every vertex projected), and largest M (with N at most
/// that) whose walls are; beyond, the walks. Overridden by FRESH_DENSE_N / FRESH_DENSE_M (development).
pub const DENSE_N: usize = 12;
pub const DENSE_M: usize = 8;

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
    /// The minimiser's container variable is s times this: for a many-sided container the side s
    /// is small against the apothem s k_in that the walls see, and the variable's curvature (k_in^2
    /// per wall contact) would dwarf the pieces'. `s_unit` = max(1, k_in / k_in of the octagon), so
    /// containers of up to 8 sides keep the side itself.
    pub s_unit: f64,
    pub pairs: Vec<[u32; 2]>,
    off_l: usize,
    nvar: usize,
    x: Vec<f64>,
    /// Pairs and walls evaluated by projecting every vertex (else by walks).
    dense_pairs: bool,
    dense_walls: bool,
    /// R cos theta, R sin theta per piece (polygons).
    rc: Vec<f64>,
    rs: Vec<f64>,
    /// Where the walks start (the sparse path): per pair the farthest vertex of i along u and of j
    /// along -u; per piece the wall nearest its centre and the farthest vertex toward it (for a
    /// circle, toward the centre's direction).
    top_pair: Vec<[u32; 2]>,
    top_wall: Vec<[u32; 2]>,
    /// Vertices and their offsets from the centre, for the dense path.
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
        let maxvar = dim * p + 1 + 3 * p * (p - 1) / 2;
        let skin = 0.5 * sh.big_r;
        let env = |k: &str, d: usize| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (dn, dm) = (env("FRESH_DENSE_N", DENSE_N), env("FRESH_DENSE_M", DENSE_M));
        let mut md = Model {
            p,
            dim,
            n,
            w: 1e-4,
            s_unit: sh_unit(&sh),
            pairs: Vec::with_capacity(p * p / 2),
            off_l: dim * p + 1,
            nvar: dim * p + 1,
            x: vec![0.0; maxvar],
            dense_pairs: false,
            dense_walls: false,
            rc: vec![0.0; p],
            rs: vec![0.0; p],
            top_pair: Vec::with_capacity(p * p / 2),
            top_wall: vec![[0, 0]; p],
            vx: Vec::new(),
            vy: Vec::new(),
            ox: Vec::new(),
            oy: Vec::new(),
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
        };
        md.set_dense(n <= dn, n <= dn && md.sh.m <= dm);
        md
    }

    /// Chooses the dense (every vertex, every wall) or the sparse (walks) evaluation of the pair and
    /// the wall terms. Both give the same G; the choice is a matter of speed (and of tests).
    pub fn set_dense(&mut self, pairs: bool, walls: bool) {
        self.dense_pairs = pairs;
        self.dense_walls = walls;
        let len = if pairs || walls { self.p * self.n.max(1) } else { 0 };
        for v in [&mut self.vx, &mut self.vy, &mut self.ox, &mut self.oy] {
            v.resize(len, 0.0);
        }
    }

    /// R cos theta and R sin theta of every polygon, and for the dense path every vertex.
    #[inline]
    fn verts(&mut self, q: &[f64]) {
        let n = self.n;
        let r = self.sh.big_r;
        let dense = self.dense_pairs || self.dense_walls;
        for i in 0..self.p {
            let (x, y, th) = (q[3 * i], q[3 * i + 1], q[3 * i + 2]);
            let (sn, cs) = th.sin_cos();
            let (rc, rs) = (r * cs, r * sn);
            self.rc[i] = rc;
            self.rs[i] = rs;
            if dense {
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
    }

    /// Penalty of a line (a, b, beta) for the pair (i, j), rotations current.
    fn line_penalty(&self, q: &[f64], i: usize, j: usize, l: [f64; 3]) -> f64 {
        let inv = 1.0 / (l[0] * l[0] + l[1] * l[1]).sqrt();
        let (ux, uy) = (l[0] * inv, l[1] * inv);
        let mx = 0.5 * (q[3 * i] + q[3 * j]);
        let my = 0.5 * (q[3 * i + 1] + q[3 * j + 1]);
        let ti = ux * (q[3 * i] - mx) + uy * (q[3 * i + 1] - my) - l[2];
        let tj = l[2] - (ux * (q[3 * j] - mx) + uy * (q[3 * j + 1] - my));
        let base = &self.sh.base;
        let mut e = 0.0;
        let (rc, rs) = (self.rc[i], self.rs[i]);
        for_vertices_above(base, ux * rc + uy * rs, uy * rc - ux * rs, -ti, |_, pv| {
            let t = ti + pv;
            if t > 0.0 {
                e += t * t;
            }
        });
        let (rc, rs) = (self.rc[j], self.rs[j]);
        for_vertices_above(base, -(ux * rc + uy * rs), -(uy * rc - ux * rs), -tj, |_, pv| {
            let t = tj + pv;
            if t > 0.0 {
                e += t * t;
            }
        });
        e
    }

    /// The separating-axis line of a pair: the outward edge normal along which the projections of i
    /// and j leave the largest gap (or overlap least), placed midway (closed form, `Shape::sat_axis`).
    fn sat_line(&self, q: &[f64], i: usize, j: usize) -> [f64; 3] {
        let pa = [q[3 * i], q[3 * i + 1], q[3 * i + 2]];
        let pb = [q[3 * j], q[3 * j + 1], q[3 * j + 2]];
        let (u, _, ext_a, ext_b) = self.sh.sat_axis(pa, pb);
        let mx = 0.5 * (pa[0] + pb[0]);
        let my = 0.5 * (pa[1] + pb[1]);
        let amax = u[0] * (pa[0] - mx) + u[1] * (pa[1] - my) + ext_a;
        let bmin = u[0] * (pb[0] - mx) + u[1] * (pb[1] - my) - ext_b;
        [u[0], u[1], 0.5 * (amax + bmin)]
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
        self.x[dim * p] = sol.s * self.s_unit;
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
        self.init_tops(q);
    }

    /// Starts of the walks from the angles (approximate: the climbs correct them).
    fn init_tops(&mut self, q: &[f64]) {
        let sh = &self.sh;
        let dim = self.dim;
        for i in 0..self.p {
            let (cx, cy) = (q[dim * i], q[dim * i + 1]);
            let j = if sh.m > 0 { sh.wall_near(cx, cy) } else { 0 };
            let k = if self.n == 0 {
                0
            } else {
                let (rc, rs) = (self.rc[i], self.rs[i]);
                let (ux, uy) = if sh.m > 0 { (sh.cnorm[j][0], sh.cnorm[j][1]) } else { (cx, cy) };
                peak_guess(&sh.base, ux * rc + uy * rs, uy * rc - ux * rs)
            };
            self.top_wall[i] = [j as u32, k as u32];
        }
        self.top_pair.clear();
        if self.n == 0 || self.dense_pairs {
            return;
        }
        for (k, &[i, j]) in self.pairs.iter().enumerate() {
            let (i, j) = (i as usize, j as usize);
            let o = self.off_l + 3 * k;
            let (ux, uy) = (self.x[o], self.x[o + 1]);
            let (rc, rs) = (self.rc[i], self.rs[i]);
            let ki = peak_guess(&sh.base, ux * rc + uy * rs, uy * rc - ux * rs);
            let (rc, rs) = (self.rc[j], self.rs[j]);
            let kj = peak_guess(&sh.base, -(ux * rc + uy * rs), -(uy * rc - ux * rs));
            self.top_pair.push([ki as u32, kj as u32]);
        }
    }

    fn unpack(&self, x: &[f64], sol: &mut Sol) {
        let p = self.p;
        let dim = self.dim;
        sol.q.copy_from_slice(&x[..dim * p]);
        sol.s = x[dim * p] / self.s_unit;
        if self.n > 0 {
            for (k, &[i, j]) in self.pairs.iter().enumerate() {
                let t = 3 * (i as usize * p + j as usize);
                let o = self.off_l + 3 * k;
                sol.lines[t..t + 3].copy_from_slice(&x[o..o + 3]);
            }
        }
    }

    /// Minimises G at pressure w from `sol` (updated in place). `check_lines` compares every stored
    /// line with a fresh separating-axis line first (after a perturbation). The gradient tolerance
    /// `gtol` is given relative to a container of `s_unit` 1: the forces the walls put on the pieces
    /// are those of the pressure w / k_in on the apothem, so it is divided by `s_unit` too.
    pub fn local_min(&mut self, lb: &mut Lbfgs, sol: &mut Sol, w: f64, max_iter: usize, gtol: f64, check_lines: bool) -> Exit {
        let gtol = gtol / self.s_unit;
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
        let s = x[2 * p] / self.s_unit;
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
            let mut walls = std::mem::take(&mut self.top_wall);
            let sh = &self.sh;
            for i in 0..p {
                let (cx, cy) = (x[2 * i], x[2 * i + 1]);
                if a > 0.0 && cx * cx + cy * cy <= a * a {
                    continue;
                }
                let mut wall = |nv: [f64; 2], d: f64| {
                    let t = d - a;
                    if t > 0.0 {
                        e += t * t;
                        let h = 2.0 * t;
                        g[2 * i] += h * nv[0];
                        g[2 * i + 1] += h * nv[1];
                        gs -= h * kin;
                    }
                };
                if self.dense_walls {
                    for nv in &sh.cnorm {
                        wall(*nv, nv[0] * cx + nv[1] * cy);
                    }
                } else {
                    let jn = sh.walls_above_from(cx, cy, walls[i][0] as usize, a, |j, d| wall(sh.cnorm[j], d));
                    walls[i][0] = jn as u32;
                }
            }
            self.top_wall = walls;
        }
        g[2 * p] = gs / self.s_unit;
        e + self.w * s
    }

    /// The pair terms by projecting every vertex of both pieces on the line.
    fn pairs_dense(&self, x: &[f64], g: &mut [f64]) -> f64 {
        let n = self.n;
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
            let (mut gti, mut gtj) = (0.0, 0.0);
            let (mut gux, mut guy, mut gb, mut gm) = (0.0, 0.0, 0.0, 0.0);
            let vi = i * n;
            let vj = j * n;
            // a piece whose bounding circle lies on its side of the line has no vertex across it
            let ci = ux * (x[3 * i] - mx) + uy * (x[3 * i + 1] - my) - beta + rb;
            let cj = beta - (ux * (x[3 * j] - mx) + uy * (x[3 * j + 1] - my)) + rb;
            if ci <= 0.0 && cj <= 0.0 {
                g[o] = 0.0;
                g[o + 1] = 0.0;
                g[o + 2] = 0.0;
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
            pair_grad(g, i, j, o, ux, uy, inv, gm, gti, gtj, gux, guy, gb);
        }
        e
    }

    /// The pair terms by walking the arc of vertices across the line on each side.
    fn pairs_sparse(&self, x: &[f64], g: &mut [f64], tops: &mut [[u32; 2]]) -> f64 {
        let base = &self.sh.base;
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
            // vertex v of i is across by ti + u.o_v, vertex v of j by tj - u.o_v
            let (dxi, dyi) = (x[3 * i] - mx, x[3 * i + 1] - my);
            let (dxj, dyj) = (x[3 * j] - mx, x[3 * j + 1] - my);
            let ti = ux * dxi + uy * dyi - beta;
            let tj = beta - (ux * dxj + uy * dyj);
            if ti + rb <= 0.0 && tj + rb <= 0.0 {
                g[o] = 0.0;
                g[o + 1] = 0.0;
                g[o + 2] = 0.0;
                continue;
            }
            let (mut gti, mut gtj) = (0.0, 0.0);
            let (mut gux, mut guy, mut gb, mut gm) = (0.0, 0.0, 0.0, 0.0);
            let mut top = (0, 0.0);
            if ti + rb > 0.0 {
                let (rc, rs) = (self.rc[i], self.rs[i]);
                arc_above(base, ux * rc + uy * rs, uy * rc - ux * rs, tops[k][0] as usize, -ti, |kv, pv| {
                    let t = ti + pv;
                    if t > 0.0 {
                        let b = base[kv];
                        let ox = rc * b[0] - rs * b[1];
                        let oy = rs * b[0] + rc * b[1];
                        e += t * t;
                        let h = 2.0 * t;
                        gm += h;
                        gti += h * (uy * ox - ux * oy);
                        gux += h * (dxi + ox);
                        guy += h * (dyi + oy);
                        gb -= h;
                    }
                }, &mut top);
                tops[k][0] = top.0 as u32;
            }
            if tj + rb > 0.0 {
                let (rc, rs) = (self.rc[j], self.rs[j]);
                arc_above(base, -(ux * rc + uy * rs), -(uy * rc - ux * rs), tops[k][1] as usize, -tj, |kv, pv| {
                    let t = tj + pv;
                    if t > 0.0 {
                        let b = base[kv];
                        let ox = rc * b[0] - rs * b[1];
                        let oy = rs * b[0] + rc * b[1];
                        e += t * t;
                        let h = 2.0 * t;
                        gm += h;
                        gtj -= h * (uy * ox - ux * oy);
                        gux -= h * (dxj + ox);
                        guy -= h * (dyj + oy);
                        gb += h;
                    }
                }, &mut top);
                tops[k][1] = top.0 as u32;
            }
            pair_grad(g, i, j, o, ux, uy, inv, gm, gti, gtj, gux, guy, gb);
        }
        e
    }

    fn eval_poly(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        let p = self.p;
        let n = self.n;
        let s = x[3 * p] / self.s_unit;
        self.verts(x);
        g.fill(0.0);
        let mut tops = std::mem::take(&mut self.top_pair);
        let mut e = if self.dense_pairs { self.pairs_dense(x, g) } else { self.pairs_sparse(x, g, &mut tops) };
        self.top_pair = tops;
        let mut walls = std::mem::take(&mut self.top_wall);
        let r = self.sh.big_r;
        let base = &self.sh.base;
        let mut gs = self.w;
        if self.sh.m == 0 {
            let rho = 0.5 * s;
            for i in 0..p {
                let (cx, cy) = (x[3 * i], x[3 * i + 1]);
                let lim = rho - r;
                let c2 = cx * cx + cy * cy;
                if lim > 0.0 && c2 <= lim * lim {
                    continue;
                }
                let mut vertex = |ox: f64, oy: f64| {
                    let (px, py) = (cx + ox, cy + oy);
                    let d2 = px * px + py * py;
                    if d2 <= rho * rho {
                        return;
                    }
                    let d = d2.sqrt();
                    let t = d - rho;
                    e += t * t;
                    let h = 2.0 * t / d;
                    g[3 * i] += h * px;
                    g[3 * i + 1] += h * py;
                    g[3 * i + 2] += h * (py * ox - px * oy);
                    gs -= t;
                };
                if self.dense_walls {
                    for v in 0..n {
                        vertex(self.ox[i * n + v], self.oy[i * n + v]);
                    }
                } else {
                    // |c + o|^2 = |c|^2 + R^2 + 2 c . o: the vertices outside are those with c . o above
                    let (rc, rs) = (self.rc[i], self.rs[i]);
                    let thr = 0.5 * (rho * rho - c2 - r * r);
                    let mut top = (0, 0.0);
                    arc_above(base, cx * rc + cy * rs, cy * rc - cx * rs, walls[i][1] as usize, thr, |kv, _| {
                        let b = base[kv];
                        vertex(rc * b[0] - rs * b[1], rs * b[0] + rc * b[1]);
                    }, &mut top);
                    walls[i][1] = top.0 as u32;
                }
            }
        } else {
            let a = s * self.sh.k_in;
            let kin = self.sh.k_in;
            let sh = &self.sh;
            for i in 0..p {
                let (cx, cy) = (x[3 * i], x[3 * i + 1]);
                let lim = a - r;
                if lim > 0.0 && cx * cx + cy * cy <= lim * lim {
                    continue;
                }
                let mut term = |nv: [f64; 2], t: f64, ox: f64, oy: f64| {
                    if t > 0.0 {
                        e += t * t;
                        let h = 2.0 * t;
                        g[3 * i] += h * nv[0];
                        g[3 * i + 1] += h * nv[1];
                        g[3 * i + 2] += h * (nv[1] * ox - nv[0] * oy);
                        gs -= h * kin;
                    }
                };
                if self.dense_walls {
                    let vi = i * n;
                    for nv in &sh.cnorm {
                        if nv[0] * cx + nv[1] * cy + r <= a {
                            continue;
                        }
                        for v in 0..n {
                            let t = nv[0] * self.vx[vi + v] + nv[1] * self.vy[vi + v] - a;
                            term(*nv, t, self.ox[vi + v], self.oy[vi + v]);
                        }
                    }
                } else {
                    // the walls the bounding circle crosses, and on each the vertices across it
                    // the climb for each wall starts at the previous wall's farthest vertex: the walls
                    // come in order outward from the nearest, one side and then the other
                    let (rc, rs) = (self.rc[i], self.rs[i]);
                    let k0 = walls[i][1] as usize;
                    let mut top = (k0, 0.0);
                    let mut first_top = usize::MAX;
                    let mut first_j = usize::MAX;
                    let m = sh.m;
                    let jn = sh.walls_above_from(cx, cy, walls[i][0] as usize, a - r, |j, d| {
                        let nv = sh.cnorm[j];
                        // the other side starts again next to the nearest wall
                        let start = if first_top == usize::MAX { k0 } else if (j + 1) % m == first_j { first_top } else { top.0 };
                        arc_above(base, nv[0] * rc + nv[1] * rs, nv[1] * rc - nv[0] * rs, start, a - d, |kv, pv| {
                            let b = base[kv];
                            term(nv, d + pv - a, rc * b[0] - rs * b[1], rs * b[0] + rc * b[1]);
                        }, &mut top);
                        if first_top == usize::MAX {
                            first_top = top.0;
                            first_j = j;
                        }
                    });
                    walls[i][0] = jn as u32;
                    if first_top != usize::MAX {
                        walls[i][1] = first_top as u32;
                    }
                }
            }
        }
        self.top_wall = walls;
        g[3 * p] = gs / self.s_unit;
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

    /// G and its gradient at the packed variables of `sol` (lists the pairs and chooses the lines as
    /// a local minimisation would; tests and development).
    pub fn value_at(&mut self, sol: &Sol, w: f64, check_lines: bool) -> (Vec<f64>, f64, Vec<f64>) {
        self.w = w;
        self.build(sol, check_lines);
        let nvar = self.nvar;
        let x0 = self.x[..nvar].to_vec();
        let mut g = vec![0.0; nvar];
        let f = self.eval(&x0, &mut g);
        (x0, f, g)
    }
}

/// The container variable's unit (`Model::s_unit`): max(1, k_in / k_in of the regular octagon).
pub fn sh_unit(sh: &Shape) -> f64 {
    (sh.k_in / OCTAGON_K_IN).max(1.0)
}

/// Apothem of the regular octagon of side 1, 1 / (2 tan(pi / 8)).
pub const OCTAGON_K_IN: f64 = 1.207_106_781_186_547_6;

/// Circumradius of the regular octagon of side 1, 1 / (2 sin(pi / 8)).
pub const OCTAGON_R: f64 = 1.306_562_964_876_376_5;

/// Adds a pair's accumulated sums to the gradient: the centres through the midpoint, the angles, and
/// the line (its direction projected off the unit normal, since u = (a, b) / |(a, b)|).
#[inline]
#[allow(clippy::too_many_arguments)]
fn pair_grad(g: &mut [f64], i: usize, j: usize, o: usize, ux: f64, uy: f64, inv: f64, gm: f64, gti: f64, gtj: f64, gux: f64, guy: f64, gb: f64) {
    // centre gradients: d t / d c_i = u - u/2 for a vertex of i (it moves with c_i, the midpoint with
    // half of it) and u/2 for a vertex of j (through the midpoint only); the reverse for c_j. Every
    // active term therefore gives h u/2 on c_i and -h u/2 on c_j.
    let hm = 0.5 * gm;
    g[3 * i] += hm * ux;
    g[3 * i + 1] += hm * uy;
    g[3 * i + 2] += gti;
    g[3 * j] -= hm * ux;
    g[3 * j + 1] -= hm * uy;
    g[3 * j + 2] += gtj;
    let du = gux * ux + guy * uy;
    g[o] = (gux - du * ux) * inv;
    g[o + 1] = (guy - du * uy) * inv;
    g[o + 2] = gb;
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
                let s = x[self.dim * self.p] / self.s_unit;
                eprintln!("    it {} s {:.9} E {:.3e} |g| {:.2e}", self.conv_it, s, f - w * s, gm);
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

    fn random_sol(rng: &mut Rng, sh: &Shape, p: usize, spread: f64) -> Sol {
        let n = sh.n;
        let dim = if n == 0 { 2 } else { 3 };
        let mut sol = Sol::new(p, dim, n > 0);
        for i in 0..p {
            sol.q[dim * i] = spread * rng.signed();
            sol.q[dim * i + 1] = spread * rng.signed();
            if dim == 3 {
                sol.q[3 * i + 2] = 7.0 * rng.signed();
            }
        }
        for v in sol.lines.iter_mut() {
            *v = rng.signed();
        }
        sol.s = 1.5 * sh.area_bound(p);
        sol
    }

    /// The analytic gradient of G agrees with central differences, for every shape pairing, on the
    /// dense and the sparse paths.
    #[test]
    fn gradient_matches_differences() {
        let mut rng = Rng::new(7);
        for &n in &[0usize, 3, 4, 5, 6, 7, 8, 12, 17, 40, 100] {
            for &m in &[0usize, 3, 4, 5, 6, 8, 9, 33, 100] {
                for sparse in [false, true] {
                    let p = 6;
                    let sh = Shape::new(n, m);
                    let mut model = Model::new(sh.clone(), p);
                    model.set_dense(!sparse, !sparse);
                    let dim = model.dim;
                    let mut sol = random_sol(&mut rng, &sh, p, 3.2 * sh.big_r);
                    // a container that cuts some pieces: about the pieces' extent
                    sol.s = 0.8 * sh.fit_size(&sol.q, p);
                    let (x0, f0, g) = model.value_at(&sol, 0.37, false);
                    assert!(f0.is_finite());
                    let nv = x0.len();
                    let mut gd = vec![0.0; nv];
                    for k in 0..nv {
                        let h = 1e-6 * if k < dim * p && k % 3 == 2 && dim == 3 { 1.0 } else { sh.big_r.max(1.0) };
                        let mut xp = x0.clone();
                        xp[k] += h;
                        let mut xm = x0.clone();
                        xm[k] -= h;
                        let fp = model.eval(&xp, &mut gd);
                        let fm = model.eval(&xm, &mut gd);
                        let num = (fp - fm) / (2.0 * h);
                        let tol = 1e-5 * (1.0 + num.abs()) * sh.big_r.max(1.0);
                        assert!((num - g[k]).abs() < tol, "n={n} m={m} sparse={sparse} var {k} of {nv}: analytic {} numeric {}", g[k], num);
                    }
                }
            }
        }
    }

    /// The dense and the sparse paths compute the same G and gradient (up to rounding).
    #[test]
    fn sparse_matches_dense() {
        let mut rng = Rng::new(19);
        for &n in &[0usize, 3, 4, 7, 12, 17, 25, 40, 64, 100] {
            for &m in &[0usize, 3, 4, 9, 16, 33, 100] {
                let sh = Shape::new(n, m);
                for rep in 0..20 {
                    let p = 2 + rep % 9;
                    let sol = {
                        let mut s = random_sol(&mut rng, &sh, p, (1.0 + rep as f64 * 0.3) * sh.big_r);
                        s.s = (0.7 + 0.03 * rep as f64) * sh.fit_size(&s.q, p);
                        s
                    };
                    let mut a = Model::new(sh.clone(), p);
                    a.set_dense(true, true);
                    let mut b = Model::new(sh.clone(), p);
                    b.set_dense(false, false);
                    let check = rep % 2 == 0;
                    let (xa, fa, ga) = a.value_at(&sol, 0.1, check);
                    let (xb, fb, gb) = b.value_at(&sol, 0.1, check);
                    assert_eq!(xa.len(), xb.len());
                    for k in 0..xa.len() {
                        assert!((xa[k] - xb[k]).abs() <= 1e-12 * (1.0 + xa[k].abs()), "n={n} m={m}: line {k} {} {}", xa[k], xb[k]);
                    }
                    let scale = 1.0 + fa.abs();
                    assert!((fa - fb).abs() <= 1e-11 * scale, "n={n} m={m} p={p}: dense {fa} sparse {fb}");
                    let gscale = 1.0 + ga.iter().fold(0.0f64, |u, v| u.max(v.abs()));
                    for k in 0..ga.len() {
                        assert!((ga[k] - gb[k]).abs() <= 1e-10 * gscale, "n={n} m={m} var {k}: dense {} sparse {}", ga[k], gb[k]);
                    }
                }
            }
        }
    }
}
