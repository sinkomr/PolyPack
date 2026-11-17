//! Local optimisation for the fold search, on the solid of edge s = 1 with pieces scaled by lam
//! (a similarity of the unit-piece problem on the solid of edge 1/lam).
//! Port of `packages/surface/src/search/optimize.ts`.
//!
//! relax: L-BFGS on the overlap energy at fixed lam (analytic gradient for disks, central finite
//! differences of each piece's local energy for polygons). Variables are each centre in its anchor
//! face's frame and, for polygons, theta times the piece's circumradius (so that all variables are
//! lengths). A centre that leaves its face is re-anchored in the neighbour (canonicalize); the
//! stored L-BFGS vectors of that piece are rotated into the new chart.
//! relaxSize: the same with lam as a variable, minimising -lam + mu E (penalty continuation).
//! compress (disks): grow lam geometrically while relax reaches zero energy; shrink the growth on
//! failure. compressPenalty (polygons): relaxSize for increasing mu, then back off and bisect
//! (refine) to the largest lam that relaxes to zero energy. Final polish: slp.rs.

use super::energy::{canonicalize, disk_energy, disk_energy_nofold, PolygonEnergy};
use crate::geometry::bounding_radius;
use crate::parts::SurfacePose;
use crate::solids::Solid;
use polypack_js::math;

pub struct RelaxResult {
    pub energy: f64,
    pub iterations: usize,
}

struct DiskMemo {
    version: u64,
    lam: f64,
    e: f64,
    g: Vec<f64>,
}

/// `optimize.ts: Packing`.
pub struct Packing {
    pub solid: &'static Solid,
    pub n: usize,
    pub nofold: bool,
    pub lam: f64,
    pub poses: Vec<SurfacePose>,
    poly: Option<PolygonEnergy>,
    /// Bumped whenever `poses` is replaced: the TypeScript's disk memo is keyed by the identity of
    /// the poses array, which every move replaces.
    version: u64,
    disk_memo: Option<DiskMemo>,
    last_turn: Vec<f64>,
}

type Stop<'a> = &'a dyn Fn() -> bool;

impl Packing {
    pub fn new(solid: &'static Solid, n: usize, lam: f64, poses: &[SurfacePose], nofold: bool) -> Packing {
        let poses: Vec<SurfacePose> = poses.iter().map(|p| canonicalize(solid, 1.0, p)).collect();
        let poly = if n == 0 { None } else { Some(PolygonEnergy::new(solid, 1.0, n, lam, &poses, nofold)) };
        Packing { solid, n, nofold, lam, poses, poly, version: 0, disk_memo: None, last_turn: Vec::new() }
    }

    /// The disk energy of the mode at scale lam (and its gradient, copied into `grad`).
    fn disks(&mut self, lam: f64, grad: Option<&mut [f64]>) -> f64 {
        if let Some(m) = &self.disk_memo {
            if m.version == self.version && m.lam == lam {
                if let Some(g) = grad {
                    g.copy_from_slice(&m.g);
                }
                return m.e;
            }
        }
        let mut g = vec![0.0; 2 * self.poses.len()];
        let e = if self.nofold {
            disk_energy_nofold(self.solid, 1.0, lam, &self.poses, &mut g)
        } else {
            disk_energy(self.solid, 1.0, lam, &self.poses, &mut g)
        };
        if let Some(out) = grad {
            out.copy_from_slice(&g);
        }
        self.disk_memo = Some(DiskMemo { version: self.version, lam, e, g });
        e
    }

    pub fn set_scale(&mut self, lam: f64) {
        self.lam = lam;
        if let Some(p) = &mut self.poly {
            p.set_scale(lam);
        }
    }

    pub fn set_poses(&mut self, poses: &[SurfacePose]) {
        self.poses = poses.to_vec();
        self.version += 1;
        if let Some(p) = &mut self.poly {
            p.poses = self.poses.clone();
            p.rebuild();
        }
    }

    pub fn energy(&mut self) -> f64 {
        if let Some(p) = &mut self.poly {
            return p.total();
        }
        let lam = self.lam;
        self.disks(lam, None)
    }

    fn dim(&self) -> usize {
        if self.n == 0 {
            2
        } else {
            3
        }
    }

    fn theta_scale(&self) -> f64 {
        if self.n == 0 {
            1.0
        } else {
            bounding_radius(self.n) * self.lam
        }
    }

    /// Gradient in the variables (x, y[, theta * R lam]) at the current poses.
    fn gradient(&mut self, g: &mut [f64]) -> f64 {
        let p_count = self.poses.len();
        if self.poly.is_none() {
            let lam = self.lam;
            return self.disks(lam, Some(g));
        }
        let h = 1e-7 * self.lam;
        let ts = self.theta_scale();
        {
            let e = self.poly.as_ref().unwrap();
            for i in 0..p_count {
                let p = self.poses[i];
                let e0 = e.local_energy(i, &p);
                for c in 0..3 {
                    let mut plus = p;
                    let mut minus = p;
                    if c == 0 {
                        plus.x += h;
                        minus.x -= h;
                    } else if c == 1 {
                        plus.y += h;
                        minus.y -= h;
                    } else {
                        plus.theta += h / ts;
                        minus.theta -= h / ts;
                    }
                    let ep = e.local_energy(i, &canonicalize(self.solid, 1.0, &plus));
                    let em = e.local_energy(i, &canonicalize(self.solid, 1.0, &minus));
                    // The energy jumps where a chain appears or vanishes around a cone point that lies inside
                    // a piece. Across such a jump the one-sided differences disagree; take the smaller one.
                    let fwd = (ep - e0) / h;
                    let bwd = (e0 - em) / h;
                    g[3 * i + c] = if (fwd - bwd).abs() > 0.5 * (fwd.abs() + bwd.abs()) + 1e-9 {
                        if fwd.abs() < bwd.abs() {
                            fwd
                        } else {
                            bwd
                        }
                    } else {
                        (ep - em) / (2.0 * h)
                    };
                }
            }
        }
        self.poly.as_mut().unwrap().total()
    }

    /// Apply a step in the variables; returns true when some piece changed face. For such pieces
    /// `last_turn[i]` is the rotation from the old chart to the new one.
    fn step(&mut self, base: &[SurfacePose], d: &[f64], t: f64) -> bool {
        let ts = self.theta_scale();
        let dim = self.dim();
        let mut moved = false;
        self.last_turn = vec![0.0; base.len()];
        let mut poses = Vec::with_capacity(base.len());
        for (i, p) in base.iter().enumerate() {
            let th = if dim == 3 { p.theta + (t * d[dim * i + 2]) / ts } else { p.theta };
            let q = SurfacePose { face: p.face, x: p.x + t * d[dim * i], y: p.y + t * d[dim * i + 1], theta: th };
            let c = canonicalize(self.solid, 1.0, &q);
            if c.face != p.face {
                moved = true;
                self.last_turn[i] = c.theta - q.theta;
            }
            poses.push(c);
        }
        self.poses = poses;
        self.version += 1;
        if let Some(p) = &mut self.poly {
            p.poses = self.poses.clone();
            p.rebuild();
        }
        moved
    }

    /// Express stored L-BFGS vectors in the new charts of pieces that changed face.
    fn turn_memory(&self, vecs: &mut [&mut Vec<f64>]) {
        let dim = self.dim();
        for (i, &a) in self.last_turn.iter().enumerate() {
            if a == 0.0 {
                continue;
            }
            let c = math::cos(a);
            let s = math::sin(a);
            for v in vecs.iter_mut() {
                let x = v[dim * i];
                let y = v[dim * i + 1];
                v[dim * i] = c * x - s * y;
                v[dim * i + 1] = s * x + c * y;
            }
        }
    }

    fn turn_history(&self, hist: &mut Vec<Vec<f64>>) {
        let mut refs: Vec<&mut Vec<f64>> = hist.iter_mut().collect();
        self.turn_memory(&mut refs);
    }

    /// `relax`: L-BFGS on the overlap energy at fixed lam.
    pub fn relax(&mut self, max_iter: usize, tol_e: f64, max_step: f64, should_stop: Stop) -> RelaxResult {
        let p = self.poses.len();
        let n = self.dim() * p;
        let m = 8;
        let mut s_h: Vec<Vec<f64>> = Vec::new();
        let mut y_h: Vec<Vec<f64>> = Vec::new();
        let mut rho: Vec<f64> = Vec::new();
        let mut g = vec![0.0; n];
        let mut e = self.gradient(&mut g);
        let mut it = 0;
        let len_scale = max_step * self.lam;
        'outer: while it < max_iter && e > tol_e {
            if should_stop() {
                break;
            }
            'body: {
                // two-loop recursion
                let mut q: Vec<f64> = g.iter().map(|v| -v).collect();
                let mut alpha = vec![0.0; s_h.len()];
                for k in (0..s_h.len()).rev() {
                    let mut a = 0.0;
                    for t in 0..n {
                        a += s_h[k][t] * q[t];
                    }
                    a *= rho[k];
                    alpha[k] = a;
                    for t in 0..n {
                        q[t] -= a * y_h[k][t];
                    }
                }
                if !s_h.is_empty() {
                    let k = s_h.len() - 1;
                    let mut sy = 0.0;
                    let mut yy = 0.0;
                    for t in 0..n {
                        sy += s_h[k][t] * y_h[k][t];
                        yy += y_h[k][t] * y_h[k][t];
                    }
                    let gamma = sy / yy;
                    for t in 0..n {
                        q[t] *= gamma;
                    }
                } else {
                    // first step: scale so that the largest move is lenScale / 10
                    let mut mx = 0.0;
                    for t in 0..n {
                        mx = math::max(mx, q[t].abs());
                    }
                    if mx > 0.0 {
                        for t in 0..n {
                            q[t] *= len_scale / 10.0 / mx;
                        }
                    }
                }
                for k in 0..s_h.len() {
                    let mut b = 0.0;
                    for t in 0..n {
                        b += y_h[k][t] * q[t];
                    }
                    b *= rho[k];
                    for t in 0..n {
                        q[t] += s_h[k][t] * (alpha[k] - b);
                    }
                }
                let mut gd = 0.0;
                for t in 0..n {
                    gd += g[t] * q[t];
                }
                if !(gd < 0.0) {
                    // not a descent direction: restart from steepest descent
                    s_h.clear();
                    y_h.clear();
                    rho.clear();
                    let mut mx = 0.0;
                    for t in 0..n {
                        mx = math::max(mx, g[t].abs());
                    }
                    if mx == 0.0 {
                        break 'outer;
                    }
                    for t in 0..n {
                        q[t] = (-g[t] * len_scale) / 10.0 / mx;
                    }
                    gd = 0.0;
                    for t in 0..n {
                        gd += g[t] * q[t];
                    }
                }
                // cap the largest single move
                let mut mx = 0.0;
                for t in 0..n {
                    mx = math::max(mx, q[t].abs());
                }
                let mut tstep = if mx > len_scale { len_scale / mx } else { 1.0 };
                let base = self.poses.clone();
                let mut accepted = false;
                let mut moved = false;
                let mut e_new = e;
                for _ls in 0..30 {
                    moved = self.step(&base, &q, tstep);
                    e_new = self.energy();
                    if e_new <= e + 1e-4 * tstep * gd {
                        accepted = true;
                        break;
                    }
                    tstep *= 0.5;
                }
                if !accepted {
                    self.set_poses(&base);
                    if s_h.is_empty() {
                        break 'outer;
                    }
                    s_h.clear();
                    y_h.clear();
                    rho.clear();
                    break 'body;
                }
                let mut gnew = vec![0.0; n];
                e = self.gradient(&mut gnew);
                if moved {
                    self.turn_history(&mut s_h);
                    self.turn_history(&mut y_h);
                    self.turn_memory(&mut [&mut g, &mut q]);
                }
                let sv: Vec<f64> = q.iter().map(|v| v * tstep).collect();
                let yv: Vec<f64> = gnew.iter().enumerate().map(|(t, v)| v - g[t]).collect();
                let mut sy = 0.0;
                for t in 0..n {
                    sy += sv[t] * yv[t];
                }
                if sy > 1e-30 {
                    s_h.push(sv);
                    y_h.push(yv);
                    rho.push(1.0 / sy);
                    if s_h.len() > m {
                        s_h.remove(0);
                        y_h.remove(0);
                        rho.remove(0);
                    }
                }
                g = gnew;
                if (e_new - e).abs() < 1e-30 && tstep * mx < 1e-15 {
                    break 'outer;
                }
            }
            it += 1;
        }
        RelaxResult { energy: e, iterations: it }
    }

    /// dE/dlam (analytic for disks, central difference for polygons).
    fn energy_scale_derivative(&mut self) -> f64 {
        let lam = self.lam;
        let h = 1e-7 * lam;
        if self.poly.is_none() {
            let up = self.disks(lam + h, None);
            let dn = self.disks(lam - h, None);
            return (up - dn) / (2.0 * h);
        }
        let poly = self.poly.as_mut().unwrap();
        poly.set_scale(lam + h);
        let up = poly.total();
        poly.set_scale(lam - h);
        let dn = poly.total();
        poly.set_scale(lam);
        (up - dn) / (2.0 * h)
    }

    /// `relaxSize`'s evalGrad: f = -lam + mu E and its gradient (the last variable is lam / lamRef).
    fn eval_grad(&mut self, mu: f64, lam_ref: f64, g: &mut [f64]) -> f64 {
        let n = g.len();
        let mut gp = vec![0.0; n - 1];
        let e = self.gradient(&mut gp);
        for t in 0..n - 1 {
            g[t] = mu * gp[t];
        }
        let d = self.energy_scale_derivative();
        g[n - 1] = (-1.0 + mu * d) * lam_ref;
        -self.lam + mu * e
    }

    /// Set the scale without rebuilding polygon caches (step() rebuilds them).
    fn set_scale_quiet(&mut self, lam: f64) {
        self.lam = lam;
        if let Some(p) = &mut self.poly {
            p.lam = lam;
        }
    }

    /// `relaxSize`: penalty relaxation with the piece scale as a variable: minimise
    /// f = -lam + mu * E(poses, lam). The scale variable is lam / lamRef so that its steps are
    /// comparable to centre moves.
    pub fn relax_size(&mut self, mu: f64, max_iter: usize, should_stop: Stop) {
        let p = self.poses.len();
        let dim = self.dim();
        let n = dim * p + 1;
        let m = 8;
        let mut s_h: Vec<Vec<f64>> = Vec::new();
        let mut y_h: Vec<Vec<f64>> = Vec::new();
        let mut rho: Vec<f64> = Vec::new();
        let lam_ref = self.lam;
        let mut g = vec![0.0; n];
        let mut f = self.eval_grad(mu, lam_ref, &mut g);
        let mut it = 0;
        'outer: while it < max_iter {
            if should_stop() {
                break;
            }
            'body: {
                let mut q: Vec<f64> = g.iter().map(|v| -v).collect();
                let mut alpha = vec![0.0; s_h.len()];
                for k in (0..s_h.len()).rev() {
                    let mut a = 0.0;
                    for t in 0..n {
                        a += s_h[k][t] * q[t];
                    }
                    a *= rho[k];
                    alpha[k] = a;
                    for t in 0..n {
                        q[t] -= a * y_h[k][t];
                    }
                }
                if !s_h.is_empty() {
                    let k = s_h.len() - 1;
                    let mut sy = 0.0;
                    let mut yy = 0.0;
                    for t in 0..n {
                        sy += s_h[k][t] * y_h[k][t];
                        yy += y_h[k][t] * y_h[k][t];
                    }
                    for t in 0..n {
                        q[t] *= sy / yy;
                    }
                } else {
                    let mut mx = 0.0;
                    for t in 0..n {
                        mx = math::max(mx, q[t].abs());
                    }
                    if mx > 0.0 {
                        for t in 0..n {
                            q[t] *= (0.002 * self.lam) / mx;
                        }
                    }
                }
                for k in 0..s_h.len() {
                    let mut b = 0.0;
                    for t in 0..n {
                        b += y_h[k][t] * q[t];
                    }
                    b *= rho[k];
                    for t in 0..n {
                        q[t] += s_h[k][t] * (alpha[k] - b);
                    }
                }
                let mut gd = 0.0;
                for t in 0..n {
                    gd += g[t] * q[t];
                }
                if !(gd < 0.0) {
                    s_h.clear();
                    y_h.clear();
                    rho.clear();
                    let mut mx = 0.0;
                    for t in 0..n {
                        mx = math::max(mx, g[t].abs());
                    }
                    if mx == 0.0 {
                        break 'outer;
                    }
                    for t in 0..n {
                        q[t] = (-g[t] * 0.002 * self.lam) / mx;
                    }
                    gd = 0.0;
                    for t in 0..n {
                        gd += g[t] * q[t];
                    }
                }
                let mut mx = 0.0;
                for t in 0..n {
                    mx = math::max(mx, q[t].abs());
                }
                let cap = 0.02 * self.lam;
                let mut tstep = if mx > cap { cap / mx } else { 1.0 };
                let base = self.poses.clone();
                let lam_base = self.lam;
                let mut accepted = false;
                let mut moved = false;
                for _ls in 0..30 {
                    self.set_scale_quiet(lam_base + tstep * q[n - 1] * lam_ref);
                    moved = self.step(&base, &q, tstep);
                    let e = self.energy();
                    let fnew = -self.lam + mu * e;
                    if fnew <= f + 1e-4 * tstep * gd {
                        accepted = true;
                        break;
                    }
                    tstep *= 0.5;
                }
                if !accepted {
                    self.set_scale_quiet(lam_base);
                    self.set_poses(&base);
                    if s_h.is_empty() {
                        break 'outer;
                    }
                    s_h.clear();
                    y_h.clear();
                    rho.clear();
                    break 'body;
                }
                let mut gnew = vec![0.0; n];
                let fnew = self.eval_grad(mu, lam_ref, &mut gnew);
                if moved {
                    self.turn_history(&mut s_h);
                    self.turn_history(&mut y_h);
                    self.turn_memory(&mut [&mut g, &mut q]);
                }
                {
                    let sv: Vec<f64> = q.iter().map(|v| v * tstep).collect();
                    let yv: Vec<f64> = gnew.iter().enumerate().map(|(t, v)| v - g[t]).collect();
                    let mut sy = 0.0;
                    for t in 0..n {
                        sy += sv[t] * yv[t];
                    }
                    if sy > 1e-30 {
                        s_h.push(sv);
                        y_h.push(yv);
                        rho.push(1.0 / sy);
                        if s_h.len() > m {
                            s_h.remove(0);
                            y_h.remove(0);
                            rho.remove(0);
                        }
                    }
                }
                let df = f - fnew;
                f = fnew;
                g = gnew;
                if df >= 0.0 && df < 1e-15 * f.abs() && tstep * mx < 1e-13 {
                    break 'outer;
                }
            }
            it += 1;
        }
    }
}

pub struct CompressOptions {
    pub feas_tol: f64,
    /// `maxIter` as the caller gives it (None: the function's own default)
    pub max_iter: Option<usize>,
}

#[derive(Clone)]
pub struct Compressed {
    pub lam: f64,
    pub poses: Vec<SurfacePose>,
}

/// `compressPenalty`: penalty continuation with the scale as a variable, then the largest lam at
/// which the poses relax to (near) zero energy at fixed scale.
pub fn compress_penalty(pk: &mut Packing, lam0: f64, opts: &CompressOptions, should_stop: Stop) -> Option<Compressed> {
    let feas_tol = opts.feas_tol;
    pk.set_scale(lam0);
    let r0 = pk.relax(200, feas_tol, 0.05, should_stop);
    // a feasible start (a warm start may already be optimal and rigid) is never lost
    let start = if r0.energy <= feas_tol { Some(Compressed { lam: lam0, poses: pk.poses.clone() }) } else { None };
    let keep = |pk: &mut Packing, r: Option<Compressed>| -> Option<Compressed> {
        if let Some(st) = &start {
            if r.is_none() || r.as_ref().unwrap().lam < st.lam {
                pk.set_scale(st.lam);
                pk.set_poses(&st.poses);
                return Some(st.clone());
            }
        }
        r
    };
    for mu in [1e2, 1e3, 1e4, 1e5, 1e6, 1e8] {
        if should_stop() {
            break;
        }
        pk.relax_size(mu, opts.max_iter.unwrap_or(150), should_stop);
    }
    // back off until a fixed-scale relaxation reaches zero energy, then bisect
    let top = pk.lam;
    let poses = pk.poses.clone();
    let mut hi = top;
    for k in 0..30 {
        let lam = top * (1.0 - 1e-7 * math::pow(2.0, k as f64));
        pk.set_scale(lam);
        pk.set_poses(&poses);
        let r = pk.relax(300, feas_tol, 0.01, should_stop);
        if r.energy <= feas_tol {
            let at = pk.poses.clone();
            let refined = refine(pk, lam, at, hi, feas_tol, should_stop);
            return keep(pk, Some(refined));
        }
        hi = lam;
    }
    keep(pk, None)
}

/// `refine`: bisection between a feasible scale lo (with its poses) and a scale hi not reached,
/// relaxing from the last feasible poses each time, until hi / lo - 1 < 1e-11.
pub fn refine(pk: &mut Packing, lo: f64, poses_lo: Vec<SurfacePose>, mut hi: f64, feas_tol: f64, should_stop: Stop) -> Compressed {
    let mut best = Compressed { lam: lo, poses: poses_lo };
    let mut k = 0;
    while k < 40 && hi / best.lam - 1.0 > 1e-11 {
        if should_stop() {
            break;
        }
        let mid = math::sqrt(best.lam * hi);
        pk.set_scale(mid);
        pk.set_poses(&best.poses);
        let r = pk.relax(150, feas_tol, 0.002, should_stop);
        if r.energy <= feas_tol {
            best = Compressed { lam: mid, poses: pk.poses.clone() };
        } else {
            hi = mid;
        }
        k += 1;
    }
    pk.set_scale(best.lam);
    pk.set_poses(&best.poses);
    best
}

/// `compress` (disks): grow lam while the packing can be relaxed to (near) zero energy. Starts at
/// lam0 (shrinking first if lam0 is infeasible). Returns the largest feasible lam reached, with
/// its poses.
pub fn compress(pk: &mut Packing, lam0: f64, opts: &CompressOptions, should_stop: Stop) -> Option<Compressed> {
    let feas_tol = opts.feas_tol;
    let max_iter = opts.max_iter.unwrap_or(200);
    let mut lam = lam0;
    pk.set_scale(lam);
    let mut r = pk.relax(max_iter * 2, feas_tol, 0.05, should_stop);
    let mut tries = 0;
    while r.energy > feas_tol && tries < 25 {
        lam *= 0.96;
        pk.set_scale(lam);
        r = pk.relax(max_iter, feas_tol, 0.05, should_stop);
        tries += 1;
    }
    if r.energy > feas_tol {
        return None;
    }
    let mut best = Compressed { lam, poses: pk.poses.clone() };
    let mut growth = 0.02;
    let min_growth = 1e-11;
    while growth > min_growth {
        if should_stop() {
            break;
        }
        let trial = best.lam * (1.0 + growth);
        pk.set_scale(trial);
        r = pk.relax(max_iter, feas_tol, 0.02, should_stop);
        if r.energy <= feas_tol {
            best = Compressed { lam: trial, poses: pk.poses.clone() };
            growth = math::min(growth * 1.6, 0.03);
        } else {
            pk.set_poses(&best.poses);
            growth *= 0.35;
        }
    }
    pk.set_scale(best.lam);
    pk.set_poses(&best.poses);
    Some(best)
}
