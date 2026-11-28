//! The objective minimised at every local step, its neighbour lists, and the exact jamming scale.
//!
//! Units: the solid is held at the working scale S (geo.rs) and every piece is scaled by mu (mu = 1:
//! side 1 or diameter 1), so a packing at mu has score s = S / mu. A configuration is a list of poses
//! (face, x, y, theta) in the face frames at scale S.
//!
//! Overlap is measured in developments. For a piece i, the chains of faces around its centre c_i
//! (geo.rs) develop a disk about c_i into i's face plane. Every other centre c_j whose developed image
//! p = T(c_j) is seen from c_i through its chain's wedge (so the segment c_i -> p is a geodesic of the
//! surface) and lies closer than two circumradii plus a skin gives a *pair image* (i, j, T): piece j
//! placed by T next to piece i. Every solid vertex developed in the same way within a circumradius plus
//! half the skin gives a *cone image* (i, v): a cone point that must stay out of piece i. A centre seen
//! again from itself along a geodesic loop gives a self image (i, i, T).
//!
//! Energy at a fixed scale mu, zero exactly when every image is separated:
//! - disks: pair max(0, mu - |c_i - p|)^2, cone max(0, mu/2 - |c_i - v|)^2 (the validator's own form:
//!   geodesic distances between centres and to the vertices);
//! - polygons: every pair image carries a separating line (a, b, beta) as extra variables, unit normal
//!   u = (a, b)/|(a, b)| and offset beta from the midpoint m of the two centres; the penalty is
//!   sum over i's corners of max(0, u.(v - m) - beta)^2 plus sum over the image's corners of
//!   max(0, beta - u.(v - m))^2. A cone image carries a line through the cone point, normal (a, b):
//!   sum over i's corners of max(0, u.(v_k - v))^2. Only the corners that cross a line are visited
//!   (from the corner most in the line's direction outwards), so a 100-gon costs about what a square
//!   does. The penalties are continuously differentiable also at edge-to-edge contacts.
//!
//! The lists are built from canonical poses (every centre in its own face); during a minimisation a
//! piece moves in the plane of the face it had at the build (its chart), and the lists stay right while
//! no piece has moved more than half the skin. Then the centres are walked back into their faces and
//! the lists rebuilt.

use crate::geo::{Geo, Node, Rig};
use crate::lbfgs::{Lbfgs, Opts, Stop};
use std::cell::Cell;
use std::f64::consts::PI;

/// Options of one relaxation.
#[derive(Clone, Copy, Debug)]
pub struct RelaxOpts {
    pub max_iter: usize,
    pub gtol: f64,
    /// relative decrease per iteration below which (5 times running) it has stalled
    pub stall_rel: f64,
    /// the energy of the arrangement a hop is compared with
    pub watch: Option<f64>,
}

/// A piece: anchor face, centre in that face's frame (scale S), angle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub f: u32,
    pub x: f64,
    pub y: f64,
    pub t: f64,
}

/// The piece shape at mu = 1.
#[derive(Clone, Debug)]
pub struct Shape {
    /// sides, 0 for a disk
    pub n: usize,
    /// circumradius (disk: 1/2)
    pub r1: f64,
    /// inradius (disk: 1/2)
    pub rin: f64,
    /// corner k at theta = 0: r1 (cos, sin)(pi/2 + 2 pi k/N)
    pub bx: Vec<f64>,
    pub by: Vec<f64>,
    /// edge normal k at theta = 0: angle pi/2 + pi/N + 2 pi k/N
    pub ex: Vec<f64>,
    pub ey: Vec<f64>,
    pub step: f64,
}

impl Shape {
    pub fn new(n: usize) -> Shape {
        if n == 0 {
            return Shape { n, r1: 0.5, rin: 0.5, bx: vec![], by: vec![], ex: vec![], ey: vec![], step: 0.0 };
        }
        let step = 2.0 * PI / n as f64;
        let r1 = 1.0 / (2.0 * (PI / n as f64).sin());
        let rin = 1.0 / (2.0 * (PI / n as f64).tan());
        let mut bx = vec![0.0; n];
        let mut by = vec![0.0; n];
        let mut ex = vec![0.0; n];
        let mut ey = vec![0.0; n];
        for k in 0..n {
            let a = PI / 2.0 + step * k as f64;
            bx[k] = r1 * a.cos();
            by[k] = r1 * a.sin();
            let e = a + PI / n as f64;
            ex[k] = e.cos();
            ey[k] = e.sin();
        }
        Shape { n, r1, rin, bx, by, ex, ey, step }
    }

    /// Support of the unit piece at angle `th` in the direction (ux, uy) (unit).
    #[inline]
    pub fn support(&self, cs: f64, sn: f64, ux: f64, uy: f64) -> f64 {
        if self.n == 0 {
            return self.r1;
        }
        // direction in the piece's own frame
        let lx = cs * ux + sn * uy;
        let ly = -sn * ux + cs * uy;
        let a = ly.atan2(lx) - PI / 2.0;
        let mut t = a % self.step;
        if t < 0.0 {
            t += self.step;
        }
        if t > self.step / 2.0 {
            t = self.step - t;
        }
        self.r1 * t.cos()
    }

    /// The offset (at mu = 1) of the corner most in the direction (ux, uy), angle (cs, sn).
    #[inline]
    pub fn corner_toward(&self, cs: f64, sn: f64, ux: f64, uy: f64) -> (f64, f64) {
        let k = self.top(cs, sn, ux, uy);
        (cs * self.bx[k] - sn * self.by[k], sn * self.bx[k] + cs * self.by[k])
    }

    /// The corner of the piece most in the direction (ux, uy) (unit), angle (cs, sn).
    #[inline]
    fn top(&self, cs: f64, sn: f64, ux: f64, uy: f64) -> usize {
        let lx = cs * ux + sn * uy;
        let ly = -sn * ux + cs * uy;
        let a = ly.atan2(lx) - PI / 2.0;
        let k = (a / self.step).round() as i64;
        k.rem_euclid(self.n as i64) as usize
    }
}

/// A vertex near both pieces of a pair image, with the angle the image's path from c_i to c_j sweeps
/// about it: an overlap point x counts only when the path c_i -> x -> c_j sweeps that same angle (not
/// one turn more or less), that is when the vertex is not enclosed between the path and the image.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sheet {
    pub vx: f64,
    pub vy: f64,
    pub sweep: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct PairImg {
    pub i: u32,
    pub j: u32,
    /// j's chart frame -> i's chart frame
    pub t: Rig,
    /// first line variable
    pub line: u32,
    /// the vertices near both pieces (at most 2) and the sweeps about them
    pub nsheet: u8,
    pub sheet: [Sheet; 2],
}

impl PairImg {
    /// True when an overlap at (wx, wy) of the image is a real overlap of the surface (see `Sheet`).
    #[inline]
    pub fn real_at(&self, cx: f64, cy: f64, qx: f64, qy: f64, wx: f64, wy: f64) -> bool {
        for k in 0..self.nsheet as usize {
            let sh = &self.sheet[k];
            let s1 = angle_at(sh.vx, sh.vy, cx, cy, wx, wy);
            let s2 = angle_at(sh.vx, sh.vy, wx, wy, qx, qy);
            if (s1 + s2 - sh.sweep).abs() > PI {
                return false;
            }
        }
        true
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ConeImg {
    pub i: u32,
    pub vx: f64,
    pub vy: f64,
    pub line: u32,
    /// cone angle of the vertex
    pub cone: f64,
}

/// Signed angle at v from a to b, in (-pi, pi].
#[inline]
pub fn angle_at(vx: f64, vy: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (ux, uy) = (ax - vx, ay - vy);
    let (wx, wy) = (bx - vx, by - vy);
    (ux * wy - uy * wx).atan2(ux * wx + uy * wy)
}

/// The evaluation budget and clock of a search (CPU deadline, evaluation cap).
pub struct Budget<'a> {
    pub deadline: f64,
    pub max_evals: u64,
    pub evals: u64,
    pub clock: &'a dyn Fn() -> f64,
    pub halted: bool,
    pub halt_evals: bool,
    tick: u32,
}

impl<'a> Budget<'a> {
    pub fn new(deadline: f64, max_evals: Option<u64>, clock: &'a dyn Fn() -> f64) -> Budget<'a> {
        Budget { deadline, max_evals: max_evals.unwrap_or(u64::MAX), evals: 0, clock, halted: false, halt_evals: false, tick: 0 }
    }
    /// True once the budget is spent (the clock is read every 32 calls).
    #[inline]
    pub fn spent(&mut self) -> bool {
        if self.halted {
            return true;
        }
        if self.evals >= self.max_evals {
            self.halted = true;
            self.halt_evals = true;
            return true;
        }
        self.tick += 1;
        if self.tick >= 32 {
            self.tick = 0;
            if (self.clock)() >= self.deadline {
                self.halted = true;
            }
        }
        self.halted
    }
    pub fn now(&self) -> f64 {
        (self.clock)()
    }
}

pub struct Model {
    pub geo: Geo,
    pub sh: Shape,
    pub p: usize,
    pub dim: usize,
    pub mu: f64,
    pub skin: f64,
    pub pairs: Vec<PairImg>,
    pub cones: Vec<ConeImg>,
    pub nvar: usize,
    off_l: usize,
    /// chart faces and build positions
    chart: Vec<u32>,
    bx: Vec<f64>,
    by: Vec<f64>,
    by_face: Vec<Vec<u32>>,
    nodes: Vec<Node>,
    cs: Vec<f64>,
    sn: Vec<f64>,
    pub x: Vec<f64>,
    rebuild: bool,
    lb: Lbfgs,
    pub max_nodes: usize,
    /// end of each piece's cone images in `cones` (they are listed piece by piece)
    cone_end: Vec<u32>,
    /// statistics
    pub stat_builds: u64,
    pub stat_iters: u64,
    pub stat_relax: u64,
}

impl Model {
    pub fn new(geo: Geo, n: usize, p: usize) -> Model {
        let sh = Shape::new(n);
        let dim = if n == 0 { 2 } else { 3 };
        let nf = geo.faces.len();
        Model {
            sh,
            p,
            dim,
            mu: 1.0,
            skin: 0.0,
            pairs: Vec::new(),
            cones: Vec::new(),
            nvar: 0,
            off_l: dim * p,
            chart: vec![0; p],
            bx: vec![0.0; p],
            by: vec![0.0; p],
            by_face: vec![Vec::new(); nf],
            nodes: Vec::new(),
            cs: vec![1.0; p],
            sn: vec![0.0; p],
            x: Vec::new(),
            rebuild: false,
            lb: Lbfgs::new(8),
            max_nodes: 3000,
            cone_end: vec![0; p],
            stat_builds: 0,
            stat_iters: 0,
            stat_relax: 0,
            geo,
        }
    }

    /// Cut-off distances at scale mu: pair images (centres) and cone images.
    #[inline]
    pub fn cuts(&self, mu: f64) -> (f64, f64) {
        (2.0 * self.sh.r1 * mu + self.skin, self.sh.r1 * mu + 0.5 * self.skin)
    }

    /// Lists the images of `cfg` (canonical poses) at scale `mu` and packs the variables into `self.x`.
    pub fn build(&mut self, cfg: &[Pose], mu: f64) {
        self.stat_builds += 1;
        self.mu = mu;
        self.skin = 0.3 * self.sh.r1 * mu;
        let (pcut, ccut) = self.cuts(mu);
        let tol = 1e-9 * self.geo.scale;
        for l in self.by_face.iter_mut() {
            l.clear();
        }
        for (i, q) in cfg.iter().enumerate() {
            self.by_face[q.f as usize].push(i as u32);
            self.chart[i] = q.f;
            self.bx[i] = q.x;
            self.by[i] = q.y;
        }
        self.pairs.clear();
        self.cones.clear();
        let poly = self.sh.n > 0;
        if self.cone_end.len() != self.p {
            self.cone_end = vec![0; self.p];
        }
        let mut nodes = std::mem::take(&mut self.nodes);
        let mut nline = 0u32;
        for (i, q) in cfg.iter().enumerate() {
            let (cx, cy) = (q.x, q.y);
            self.geo.chains(q.f as usize, cx, cy, pcut, self.max_nodes, &mut nodes);
            let first_cone = self.cones.len();
            let first_pair = self.pairs.len();
            for node in nodes.iter() {
                let fc = &self.geo.faces[node.face as usize];
                for k in 0..fc.m {
                    let (vx, vy) = node.t.apply(fc.vx[k], fc.vy[k]);
                    let d = (vx - cx).hypot(vy - cy);
                    if d >= ccut || !node.sees(cx, cy, vx, vy, tol) {
                        continue;
                    }
                    if self.cones[first_cone..].iter().any(|c| (c.vx - vx).abs() < tol && (c.vy - vy).abs() < tol) {
                        continue;
                    }
                    let cone = self.geo.cone[fc.vid[k]];
                    self.cones.push(ConeImg { i: i as u32, vx, vy, line: nline, cone });
                    if poly {
                        nline += 2;
                    }
                }
                for &j in &self.by_face[node.face as usize] {
                    let j = j as usize;
                    if j < i || (j == i && node.root) {
                        continue;
                    }
                    let r = &cfg[j];
                    let (px, py) = node.t.apply(r.x, r.y);
                    let d = (px - cx).hypot(py - cy);
                    if d >= pcut || !node.sees(cx, cy, px, py, tol) {
                        continue;
                    }
                    if j == i && d < 1e-9 * self.geo.scale {
                        continue;
                    }
                    if self.pairs[first_pair..].iter().any(|e| {
                        if e.j as usize != j {
                            return false;
                        }
                        let (ex, ey) = e.t.apply(r.x, r.y);
                        (ex - px).abs() < tol && (ey - py).abs() < tol
                    }) {
                        continue;
                    }
                    self.pairs.push(PairImg { i: i as u32, j: j as u32, t: node.t, line: nline, nsheet: 0, sheet: [Sheet::default(); 2] });
                    if poly {
                        nline += 3;
                    }
                }
            }
            self.cone_end[i] = self.cones.len() as u32;
        }
        self.nodes = nodes;
        if poly {
            nline = self.add_sheets(cfg, nline);
        }
        // variables
        let dim = self.dim;
        self.off_l = dim * self.p;
        self.nvar = self.off_l + nline as usize;
        if self.x.len() < self.nvar {
            self.x.resize(self.nvar, 0.0);
        }
        for (i, q) in cfg.iter().enumerate() {
            self.x[dim * i] = q.x;
            self.x[dim * i + 1] = q.y;
            if poly {
                self.x[dim * i + 2] = q.t;
            }
        }
        if poly {
            for k in 0..self.pairs.len() {
                let e = self.pairs[k];
                let l = self.sat_line(cfg, &e);
                let o = self.off_l + e.line as usize;
                self.x[o..o + 3].copy_from_slice(&l);
            }
            for k in 0..self.cones.len() {
                let c = self.cones[k];
                let q = &cfg[c.i as usize];
                let (dx, dy) = (c.vx - q.x, c.vy - q.y);
                let d = dx.hypot(dy).max(1e-300);
                let o = self.off_l + c.line as usize;
                self.x[o] = dx / d;
                self.x[o + 1] = dy / d;
            }
        }
    }

    /// Polygons: attaches to every pair image the vertices near both of its pieces (with the angle
    /// the image's geodesic sweeps about each), and adds for each such vertex the image that goes
    /// round it on the other side (the geodesic image turned about the vertex by its cone angle),
    /// with its own sweep. Returns the next free line variable.
    fn add_sheets(&mut self, cfg: &[Pose], mut nline: u32) -> u32 {
        let (pcut, _) = self.cuts(self.mu);
        let tol = 1e-9 * self.geo.scale;
        let ngeo = self.pairs.len();
        let mut cand: Vec<(f64, f64, f64, f64)> = Vec::new();
        for k in 0..ngeo {
            let pr = self.pairs[k];
            let (i, j) = (pr.i as usize, pr.j as usize);
            if i == j {
                continue;
            }
            let (cx, cy) = (cfg[i].x, cfg[i].y);
            let (qx, qy) = pr.t.apply(cfg[j].x, cfg[j].y);
            cand.clear();
            let lo_i = if i == 0 { 0 } else { self.cone_end[i - 1] as usize };
            let lo_j = if j == 0 { 0 } else { self.cone_end[j - 1] as usize };
            let push = |vx: f64, vy: f64, cone: f64, cand: &mut Vec<(f64, f64, f64, f64)>| {
                let (di, dj) = ((vx - cx).hypot(vy - cy), (vx - qx).hypot(vy - qy));
                if di >= pcut || dj >= pcut {
                    return;
                }
                if cand.iter().any(|c| (c.0 - vx).abs() < tol && (c.1 - vy).abs() < tol) {
                    return;
                }
                cand.push((vx, vy, cone, di + dj));
            };
            for c in &self.cones[lo_i..self.cone_end[i] as usize] {
                push(c.vx, c.vy, c.cone, &mut cand);
            }
            for c in &self.cones[lo_j..self.cone_end[j] as usize] {
                let (vx, vy) = pr.t.apply(c.vx, c.vy);
                push(vx, vy, c.cone, &mut cand);
            }
            if cand.is_empty() {
                continue;
            }
            cand.sort_by(|a, b| a.3.total_cmp(&b.3));
            let ns = cand.len().min(2);
            let mut sheets = [Sheet::default(); 2];
            for (s, c) in cand.iter().take(ns).enumerate() {
                sheets[s] = Sheet { vx: c.0, vy: c.1, sweep: angle_at(c.0, c.1, cx, cy, qx, qy) };
            }
            self.pairs[k].nsheet = ns as u8;
            self.pairs[k].sheet = sheets;
            // the images round the other side of each vertex
            for c in cand.iter().take(ns) {
                let (vx, vy, cone) = (c.0, c.1, c.2);
                let sweep = angle_at(vx, vy, cx, cy, qx, qy);
                let turn = if sweep >= 0.0 { -cone } else { cone };
                let (sn, cs) = turn.sin_cos();
                let rot = Rig { c: cs, s: sn, tx: vx - (cs * vx - sn * vy), ty: vy - (sn * vx + cs * vy), ang: turn };
                let t2 = rot.after(&pr.t);
                let (px, py) = t2.apply(cfg[j].x, cfg[j].y);
                if (px - cx).hypot(py - cy) >= pcut {
                    continue;
                }
                let dup = self.pairs.iter().any(|e| {
                    if e.i as usize != i || e.j as usize != j {
                        return false;
                    }
                    let (ex, ey) = e.t.apply(cfg[j].x, cfg[j].y);
                    (ex - px).abs() < tol && (ey - py).abs() < tol
                });
                if dup {
                    continue;
                }
                let mut sh2 = [Sheet::default(); 2];
                sh2[0] = Sheet { vx, vy, sweep: sweep + turn };
                self.pairs.push(PairImg { i: i as u32, j: j as u32, t: t2, line: nline, nsheet: 1, sheet: sh2 });
                nline += 3;
            }
        }
        nline
    }

    /// The best separating-axis line of a pair image: (unit normal, offset from the midpoint).
    fn sat_line(&self, cfg: &[Pose], e: &PairImg) -> [f64; 3] {
        let a = &cfg[e.i as usize];
        let b = &cfg[e.j as usize];
        let (qx, qy) = e.t.apply(b.x, b.y);
        let phi = b.t + e.t.ang;
        let (sa, ca) = a.t.sin_cos();
        let (sb, cb) = phi.sin_cos();
        let (dx, dy) = (qx - a.x, qy - a.y);
        let (mx, my) = (0.5 * (a.x + qx), 0.5 * (a.y + qy));
        let mu = self.mu;
        let sh = &self.sh;
        let mut best = f64::NEG_INFINITY;
        let mut line = [1.0, 0.0, 0.0];
        for k in 0..sh.n {
            // axis from a: its edge normal k
            let (nx, ny) = (ca * sh.ex[k] - sa * sh.ey[k], sa * sh.ex[k] + ca * sh.ey[k]);
            let amax = nx * a.x + ny * a.y + mu * sh.rin;
            let bmin = nx * qx + ny * qy - mu * sh.support(cb, sb, -nx, -ny);
            if bmin - amax > best {
                best = bmin - amax;
                line = [nx, ny, 0.5 * (amax + bmin) - (nx * mx + ny * my)];
            }
            // axis from b: its edge normal k, pointing to a
            let (nx, ny) = (cb * sh.ex[k] - sb * sh.ey[k], sb * sh.ex[k] + cb * sh.ey[k]);
            let bmax = nx * qx + ny * qy + mu * sh.rin;
            let amin = nx * a.x + ny * a.y - mu * sh.support(ca, sa, -nx, -ny);
            if amin - bmax > best {
                best = amin - bmax;
                line = [-nx, -ny, -(0.5 * (bmax + amin) - (nx * mx + ny * my))];
            }
        }
        if !best.is_finite() {
            let d = dx.hypot(dy).max(1e-300);
            line = [dx / d, dy / d, 0.0];
        }
        line
    }

    /// Writes the variables' piece part back into `cfg` (chart coordinates) and walks every centre
    /// back into its own face.
    pub fn unpack(&self, x: &[f64], cfg: &mut [Pose]) {
        let dim = self.dim;
        for i in 0..self.p {
            let f = self.chart[i] as usize;
            let (px, py) = (x[dim * i], x[dim * i + 1]);
            let t = if dim == 3 { x[dim * i + 2] } else { 0.0 };
            let (g, gx, gy, m) = if self.geo.depth(f, px, py) >= 0.0 {
                (f, px, py, Rig::ID)
            } else {
                self.geo.walk(f, self.bx[i], self.by[i], px, py)
            };
            cfg[i] = Pose { f: g as u32, x: gx, y: gy, t: wrap_angle(t + m.ang, self.sh.n) };
        }
    }

    /// The objective at `x` (variables of the current build) with its gradient.
    pub fn energy(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        let p = self.p;
        let dim = self.dim;
        let nvar = self.nvar;
        for v in g[..nvar].iter_mut() {
            *v = 0.0;
        }
        let half = 0.5 * self.skin;
        let half2 = half * half;
        for i in 0..p {
            let dx = x[dim * i] - self.bx[i];
            let dy = x[dim * i + 1] - self.by[i];
            if dx * dx + dy * dy > half2 {
                self.rebuild = true;
            }
        }
        let mu = self.mu;
        let mut e = 0.0;
        if dim == 2 {
            for pr in &self.pairs {
                let (i, j) = (pr.i as usize, pr.j as usize);
                let (qx, qy) = pr.t.apply(x[2 * j], x[2 * j + 1]);
                let dx = qx - x[2 * i];
                let dy = qy - x[2 * i + 1];
                let d2 = dx * dx + dy * dy;
                if d2 >= mu * mu {
                    continue;
                }
                let d = d2.sqrt().max(1e-300);
                let o = mu - d;
                e += o * o;
                // dE/dq = -2 o (dx, dy)/d
                let gq = -2.0 * o / d;
                let (gx, gy) = (gq * dx, gq * dy);
                g[2 * i] -= gx;
                g[2 * i + 1] -= gy;
                let (hx, hy) = pr.t.rot_t(gx, gy);
                g[2 * j] += hx;
                g[2 * j + 1] += hy;
            }
            let r = 0.5 * mu;
            for c in &self.cones {
                let i = c.i as usize;
                let dx = x[2 * i] - c.vx;
                let dy = x[2 * i + 1] - c.vy;
                let d2 = dx * dx + dy * dy;
                if d2 >= r * r {
                    continue;
                }
                let d = d2.sqrt().max(1e-300);
                let o = r - d;
                e += o * o;
                let gq = -2.0 * o / d;
                g[2 * i] += gq * dx;
                g[2 * i + 1] += gq * dy;
            }
            return e;
        }
        for i in 0..p {
            let (s, c) = x[3 * i + 2].sin_cos();
            self.sn[i] = s;
            self.cs[i] = c;
        }
        let off = self.off_l;
        let sh = &self.sh;
        let n = sh.n;
        let rmu = mu;
        for pr in &self.pairs {
            let (i, j) = (pr.i as usize, pr.j as usize);
            let (cix, ciy) = (x[3 * i], x[3 * i + 1]);
            let (qx, qy) = pr.t.apply(x[3 * j], x[3 * j + 1]);
            let (dx, dy) = (qx - cix, qy - ciy);
            let o = off + pr.line as usize;
            let (a, b, beta) = (x[o], x[o + 1], x[o + 2]);
            let wn = a.hypot(b).max(1e-300);
            let (ux, uy) = (a / wn, b / wn);
            let ud2 = 0.5 * (ux * dx + uy * dy);
            let (ci_c, ci_s) = (self.cs[i], self.sn[i]);
            // developed angle of j
            let (cj, sj) = (self.cs[j], self.sn[j]);
            let (cp, sp) = (pr.t.c * cj - pr.t.s * sj, pr.t.s * cj + pr.t.c * sj);
            let mut dci = (0.0, 0.0);
            let mut dq = (0.0, 0.0);
            let mut dthi = 0.0;
            let mut dphi = 0.0;
            let mut du = (0.0, 0.0);
            let mut dbeta = 0.0;
            let mut hit = false;
            let mut el = 0.0;
            let mut wi = (0.0, 0.0, 0.0);
            let mut wj = (0.0, 0.0, 0.0);
            // corners of i beyond the line: t = -u.d/2 + u.o_k - beta
            let c0 = -ud2 - beta;
            scan(sh, ci_c, ci_s, ux, uy, rmu, c0, |ox, oy, t| {
                hit = true;
                el += t * t;
                if t > wi.2 {
                    wi = (ox, oy, t);
                }
                let gg = 2.0 * t;
                dci.0 += gg * 0.5 * ux;
                dci.1 += gg * 0.5 * uy;
                dq.0 -= gg * 0.5 * ux;
                dq.1 -= gg * 0.5 * uy;
                dthi += gg * (ox * uy - oy * ux);
                du.0 += gg * (-0.5 * dx + ox);
                du.1 += gg * (-0.5 * dy + oy);
                dbeta -= gg;
            });
            // corners of j's image before the line: t = beta - u.d/2 - u.o_k = c0' + (-u).o_k
            let c1 = beta - ud2;
            scan(sh, cp, sp, -ux, -uy, rmu, c1, |ox, oy, t| {
                hit = true;
                el += t * t;
                if t > wj.2 {
                    wj = (ox, oy, t);
                }
                let gg = 2.0 * t;
                dci.0 += gg * 0.5 * ux;
                dci.1 += gg * 0.5 * uy;
                dq.0 -= gg * 0.5 * ux;
                dq.1 -= gg * 0.5 * uy;
                dphi -= gg * (ox * uy - oy * ux);
                du.0 += gg * (-0.5 * dx - ox);
                du.1 += gg * (-0.5 * dy - oy);
                dbeta += gg;
            });
            if !hit {
                continue;
            }
            if pr.nsheet > 0 {
                // a point of the overlap: between the deepest crossing corners
                let (pxi, pyi) = (cix + wi.0, ciy + wi.1);
                let (pxj, pyj) = (qx + wj.0, qy + wj.1);
                let (wx, wy) = if wi.2 > 0.0 && wj.2 > 0.0 {
                    (0.5 * (pxi + pxj), 0.5 * (pyi + pyj))
                } else if wi.2 > 0.0 {
                    (pxi, pyi)
                } else {
                    (pxj, pyj)
                };
                if !pr.real_at(cix, ciy, qx, qy, wx, wy) {
                    continue;
                }
            }
            e += el;
            g[3 * i] += dci.0;
            g[3 * i + 1] += dci.1;
            g[3 * i + 2] += dthi;
            let (hx, hy) = pr.t.rot_t(dq.0, dq.1);
            g[3 * j] += hx;
            g[3 * j + 1] += hy;
            g[3 * j + 2] += dphi;
            let udu = ux * du.0 + uy * du.1;
            g[o] += (du.0 - ux * udu) / wn;
            g[o + 1] += (du.1 - uy * udu) / wn;
            g[o + 2] += dbeta;
        }
        for c in &self.cones {
            let i = c.i as usize;
            let o = off + c.line as usize;
            let (a, b) = (x[o], x[o + 1]);
            let wn = a.hypot(b).max(1e-300);
            let (ux, uy) = (a / wn, b / wn);
            let (rx, ry) = (x[3 * i] - c.vx, x[3 * i + 1] - c.vy);
            let c0 = ux * rx + uy * ry;
            let mut dci = (0.0, 0.0);
            let mut dth = 0.0;
            let mut du = (0.0, 0.0);
            let mut hit = false;
            scan(sh, self.cs[i], self.sn[i], ux, uy, rmu, c0, |ox, oy, t| {
                hit = true;
                e += t * t;
                let gg = 2.0 * t;
                dci.0 += gg * ux;
                dci.1 += gg * uy;
                dth += gg * (ox * uy - oy * ux);
                du.0 += gg * (rx + ox);
                du.1 += gg * (ry + oy);
            });
            if !hit {
                continue;
            }
            g[3 * i] += dci.0;
            g[3 * i + 1] += dci.1;
            g[3 * i + 2] += dth;
            let udu = ux * du.0 + uy * du.1;
            g[o] += (du.0 - ux * udu) / wn;
            g[o + 1] += (du.1 - uy * udu) / wn;
        }
        let _ = n;
        e
    }

    /// Minimises the energy at scale `mu` from `cfg` (canonical poses, updated in place, canonical
    /// again on return). Returns the final energy.
    pub fn relax(&mut self, cfg: &mut [Pose], mu: f64, max_iter: usize, gtol: f64, budget: &mut Budget) -> f64 {
        self.relax_with(cfg, mu, &RelaxOpts { max_iter, gtol, stall_rel: 1e-12, watch: None }, budget)
    }

    /// `relax` with options: with `watch` = Some(e_ref) (a hop compared with an arrangement of energy
    /// e_ref), the minimisation stops early once it is clearly above e_ref or has come back to it.
    pub fn relax_with(&mut self, cfg: &mut [Pose], mu: f64, ro: &RelaxOpts, budget: &mut Budget) -> f64 {
        self.stat_relax += 1;
        let gtol = ro.gtol;
        let mut left = ro.max_iter;
        let watch = ro.watch;
        let mut e = f64::INFINITY;
        let f_stop = 1e-26 * mu * mu;
        for _round in 0..100 {
            self.build(cfg, mu);
            self.rebuild = false;
            let nvar = self.nvar;
            let mut x = std::mem::take(&mut self.x);
            let mut lb = std::mem::replace(&mut self.lb, Lbfgs::new(1));
            let opts = Opts { gtol, f_stop, max_iter: left, max_step: 0.25 * self.sh.r1 * mu, stall_rel: ro.stall_rel };
            let flag = Cell::new(false);
            let quit = Cell::new(false);
            let done = ro.max_iter - left;
            let cnt = Cell::new(0u64);
            let base = budget.evals;
            let out = {
                let me = &mut *self;
                let fun = |xx: &[f64], gg: &mut [f64]| {
                    cnt.set(cnt.get() + 1);
                    let v = me.energy(xx, gg);
                    if me.rebuild {
                        flag.set(true);
                    }
                    v
                };
                lb.minimize(&mut x[..nvar], fun, opts, |_n, it, fx| {
                    if flag.get() {
                        return true;
                    }
                    if let Some(er) = watch {
                        let it = it + done;
                        let hopeless = (it >= 60 && fx > 4.0 * er) || (it >= 250 && fx > 1.3 * er) || (it >= 800 && fx > 1.02 * er);
                        let back = it >= 40 && fx <= er * (1.0 + 1e-7) && fx >= er * (1.0 - 1e-6);
                        if hopeless || back {
                            quit.set(true);
                            return true;
                        }
                    }
                    budget.evals = base + cnt.get();
                    budget.spent()
                })
            };
            self.lb = lb;
            budget.evals = base + cnt.get();
            self.stat_iters += out.iterations as u64;
            self.unpack(&x[..nvar], cfg);
            self.x = x;
            e = out.f;
            left = left.saturating_sub(out.iterations);
            let stale = self.rebuild;
            if budget.spent() || left == 0 || quit.get() {
                break;
            }
            if stale {
                continue;
            }
            match out.stop {
                Stop::Target | Stop::Gradient | Stop::Stalled | Stop::Iterations => break,
                Stop::Budget => {}
            }
        }
        if self.rebuild {
            // the final value was computed on a stale list: recompute on a fresh one
            self.build(cfg, mu);
            let nvar = self.nvar;
            let mut x = std::mem::take(&mut self.x);
            let mut g = vec![0.0; nvar];
            e = self.energy(&x[..nvar], &mut g);
            budget.evals += 1;
            self.rebuild = false;
            let _ = &mut x;
            self.x = x;
        }
        e
    }

    /// The largest scale at which the pair image `pr` of `cfg` is separated.
    pub fn pair_jam(&self, cfg: &[Pose], pr: &PairImg) -> f64 {
        let sh = &self.sh;
        let a = &cfg[pr.i as usize];
        let b = &cfg[pr.j as usize];
        let (qx, qy) = pr.t.apply(b.x, b.y);
        let (dx, dy) = (qx - a.x, qy - a.y);
        if sh.n == 0 {
            return dx.hypot(dy);
        }
        let (sa, ca) = a.t.sin_cos();
        let (sb, cb) = (b.t + pr.t.ang).sin_cos();
        let mut m = 0.0f64;
        // the best axis: (normal, true when it is i's)
        let mut axis = (0.0, 0.0, true);
        for k in 0..sh.n {
            // i's outward normal n: the image must lie beyond i along n
            let (nx, ny) = (ca * sh.ex[k] - sa * sh.ey[k], sa * sh.ex[k] + ca * sh.ey[k]);
            let l = nx * dx + ny * dy;
            if l > 0.0 {
                let v = l / (sh.rin + sh.support(cb, sb, -nx, -ny));
                if v > m {
                    m = v;
                    axis = (nx, ny, true);
                }
            }
            // the image's outward normal n: i must lie beyond it along n
            let (nx, ny) = (cb * sh.ex[k] - sb * sh.ey[k], sb * sh.ex[k] + cb * sh.ey[k]);
            let l = -(nx * dx + ny * dy);
            if l > 0.0 {
                let v = l / (sh.rin + sh.support(ca, sa, -nx, -ny));
                if v > m {
                    m = v;
                    axis = (nx, ny, false);
                }
            }
        }
        if pr.nsheet > 0 && m > 0.0 {
            // where the two touch at scale m: the image's corner on i's side, or i's corner on the image's side
            let (nx, ny, own) = axis;
            let (wx, wy) = if own {
                let (ox, oy) = sh.corner_toward(cb, sb, -nx, -ny);
                (qx + m * ox, qy + m * oy)
            } else {
                let (ox, oy) = sh.corner_toward(ca, sa, -nx, -ny);
                (a.x + m * ox, a.y + m * oy)
            };
            if !pr.real_at(a.x, a.y, qx, qy, wx, wy) {
                return f64::INFINITY;
            }
        }
        m
    }

    /// The largest scale at which the cone image `c` lies outside its piece.
    pub fn cone_jam(&self, cfg: &[Pose], c: &ConeImg) -> f64 {
        let sh = &self.sh;
        let a = &cfg[c.i as usize];
        let (dx, dy) = (c.vx - a.x, c.vy - a.y);
        if sh.n == 0 {
            return 2.0 * dx.hypot(dy);
        }
        let (sa, ca) = a.t.sin_cos();
        let mut m = 0.0f64;
        for k in 0..sh.n {
            let (nx, ny) = (ca * sh.ex[k] - sa * sh.ey[k], sa * sh.ex[k] + ca * sh.ey[k]);
            m = m.max((nx * dx + ny * dy) / sh.rin);
        }
        m
    }

    /// The largest scale at which the pieces of `cfg` (canonical poses, with the lists of the last
    /// build of this cfg) are separated along every image, capped where the lists stop being complete.
    pub fn jam_scale(&self, cfg: &[Pose]) -> f64 {
        let cap = self.mu + self.skin / (2.0 * self.sh.r1) * 0.95;
        let mut best = cap;
        for pr in &self.pairs {
            best = best.min(self.pair_jam(cfg, pr));
        }
        for c in &self.cones {
            best = best.min(self.cone_jam(cfg, c));
        }
        best
    }

    /// The energy of `cfg` at `mu` without minimising (a fresh build).
    pub fn energy_of(&mut self, cfg: &[Pose], mu: f64) -> f64 {
        self.build(cfg, mu);
        let nvar = self.nvar;
        let x = std::mem::take(&mut self.x);
        let mut g = vec![0.0; nvar];
        let e = self.energy(&x[..nvar], &mut g);
        self.x = x;
        e
    }
}

/// Angle reduced to [0, 2 pi / N) (a regular N-gon is symmetric under turns of 2 pi / N); disks 0.
pub fn wrap_angle(t: f64, n: usize) -> f64 {
    if n == 0 {
        return 0.0;
    }
    let p = 2.0 * PI / n as f64;
    let r = t.rem_euclid(p);
    if r.is_finite() {
        r
    } else {
        0.0
    }
}

/// Visits the corners k of a piece (angle (cs, sn), scale mu) with t = c0 + u.o_k > 0, where o_k is
/// the corner's offset from the centre: f(o_x, o_y, t). Corners are visited from the one most in the
/// direction u outwards (the values fall away from it), so only the crossing corners cost anything.
#[inline]
fn scan<F: FnMut(f64, f64, f64)>(sh: &Shape, cs: f64, sn: f64, ux: f64, uy: f64, mu: f64, c0: f64, mut f: F) {
    let n = sh.n;
    // quick reject: the farthest any corner reaches along u is mu r1
    if c0 + mu * sh.r1 <= 0.0 {
        return;
    }
    let corner = |k: usize| -> (f64, f64) {
        let (bx, by) = (sh.bx[k], sh.by[k]);
        (mu * (cs * bx - sn * by), mu * (sn * bx + cs * by))
    };
    if n <= 8 {
        for k in 0..n {
            let (ox, oy) = corner(k);
            let t = c0 + ux * ox + uy * oy;
            if t > 0.0 {
                f(ox, oy, t);
            }
        }
        return;
    }
    let k0 = sh.top(cs, sn, ux, uy);
    let (ox, oy) = corner(k0);
    let t = c0 + ux * ox + uy * oy;
    if !(t > 0.0) {
        // the top corner might be its neighbour by rounding
        for kk in [(k0 + 1) % n, (k0 + n - 1) % n] {
            let (ox, oy) = corner(kk);
            let t = c0 + ux * ox + uy * oy;
            if t > 0.0 {
                f(ox, oy, t);
            }
        }
        return;
    }
    f(ox, oy, t);
    let mut up = 0usize;
    for s in 1..n {
        let k = (k0 + s) % n;
        let (ox, oy) = corner(k);
        let t = c0 + ux * ox + uy * oy;
        if !(t > 0.0) {
            break;
        }
        f(ox, oy, t);
        up = s;
    }
    for s in 1..n - up {
        let k = (k0 + n - s) % n;
        let (ox, oy) = corner(k);
        let t = c0 + ux * ox + uy * oy;
        if !(t > 0.0) {
            break;
        }
        f(ox, oy, t);
    }
}
