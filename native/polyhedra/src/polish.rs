//! Polish of a packing and its legalization. Port of `packages/polyhedra/src/polish.ts` (PolyPack's own code).
//!
//! Polish: the separating-plane penalty method (the quasi-phi-function model of Pankratov, Romanova, Stoyan et
//! al., as used by upstream's tightening and by compute studies of the wiki records). Every near pair (i, j) gets
//! a plane n . x = t of its own, n = m / |m|, and the variables are the container scale s, each piece's centre c
//! and quaternion q (rotation H(q) / |q|^2, so q needs no normalisation) and each plane's (m, t). Minimised:
//!
//!   s + mu [ sum_pairs ( sum_{x in A} (n.x - t + g/2)_+^2 + sum_{x in B} (t - n.x + g/2)_+^2 )
//!            + sum_pieces sum_faces sum_{x} (N_f.x - s b_f + w)_+^2 ]  + small terms keeping |q| and |m| near 1,
//!
//! with L-BFGS for mu = 1e1, 1e2, ..., 1e9 (g: pair clearance, w: wall clearance). Only vertices near a plane or a
//! wall are kept in the sums of a stage; the pairs and the vertex lists are chosen again at each stage.
//!
//! Legalization (`legalize_config`): the penalty leaves overlaps of about 1/mu. The pieces are first moved apart by
//! scaling their centres about the origin: if every pair is separated by at least -d along some axis, scaling the
//! centres by 1 + delta adds at least 2 rho delta to that axis' gap, rho the piece's inradius (each piece contains
//! the ball of radius rho about its centre, so the centres lie at least rho inside the two half-spaces of the
//! axis), so delta = (g + d) / (2 rho) gives every pair the clearance g. Then the container is translated by the
//! best translation (a 4-variable LP) and s is set to the smallest scale with wall clearance w. The result is
//! checked with the separating-axis test, and the scaling is repeated with a larger delta if float rounding left
//! a pair short.
//!
//! Expressions keep the source's order of operations (the numbers are its numbers to the bit); buffers are reused
//! where the source allocates.

// The port keeps the source's index loops and its NaN-aware comparisons (`!(a < b)` is not `a >= b`), line by line.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use crate::geom::{place, separation, Placed, Pose};
use crate::problems::PolyhedraProblem;
use crate::sim::{Gate, Halt, Why};
use crate::simgeom::Vec3;
use crate::solids::{get_solid, Solid};
use crate::validate::PolyhedraConfig;
use polypack_js::math;

/// `polish.ts: PolishResult`.
pub struct PolishResult {
    pub config: PolyhedraConfig,
    /// Function evaluations used.
    pub evaluations: u64,
    /// Set when `tick` stopped the polish before its last stage.
    pub stopped: Option<Why>,
}

/// `polish.ts: PolishOptions`, with the search's `tick` and `poll` as one [`Gate`].
pub struct PolishOptions<'a> {
    /// Pair clearance g kept by the penalty and by the legalization.
    pub pair_clearance: f64,
    /// Wall clearance w.
    pub wall_clearance: f64,
    /// Penalty weights of the stages; the source's default is 1e1, 1e2, ..., 1e9.
    pub mus: Option<&'a [f64]>,
    pub gate: &'a Gate<'a>,
}

type ObjFn<'a> = dyn FnMut(&[f64], &mut [f64]) -> Result<f64, Halt> + 'a;

/// `polish.ts: lbfgs`: minimises f from x (in place) by L-BFGS with an Armijo backtracking line search; returns f(x).
pub fn lbfgs(f: &mut ObjFn, x: &mut [f64], max_iter: usize, m: usize, gtol: f64) -> Result<f64, Halt> {
    let n = x.len();
    let mut g = vec![0.0f64; n];
    let mut fx = f(x, &mut g)?;
    let mut ss: Vec<Vec<f64>> = Vec::new();
    let mut ys: Vec<Vec<f64>> = Vec::new();
    let mut rho: Vec<f64> = Vec::new();
    let mut d = vec![0.0f64; n];
    let mut xn = vec![0.0f64; n];
    let mut gn = vec![0.0f64; n];
    let mut alpha = vec![0.0f64; m];
    let mut stall = 0;
    for _ in 0..max_iter {
        let mut gmax = 0.0;
        for i in 0..n {
            gmax = math::max(gmax, math::abs(g[i]));
        }
        if gmax < gtol {
            break;
        }
        // two-loop recursion: d = -H g
        for i in 0..n {
            d[i] = -g[i];
        }
        let k = ss.len();
        for j in (0..k).rev() {
            let mut a = 0.0;
            for i in 0..n {
                a += ss[j][i] * d[i];
            }
            a *= rho[j];
            alpha[j] = a;
            for i in 0..n {
                d[i] -= a * ys[j][i];
            }
        }
        if k > 0 {
            let mut sy = 0.0;
            let mut yy = 0.0;
            for i in 0..n {
                sy += ss[k - 1][i] * ys[k - 1][i];
                yy += ys[k - 1][i] * ys[k - 1][i];
            }
            let gamma = sy / yy;
            for i in 0..n {
                d[i] *= gamma;
            }
        } else {
            // first step: at most 1e-3 in any variable
            let mut dm = 0.0;
            for i in 0..n {
                dm = math::max(dm, math::abs(d[i]));
            }
            let sc = if dm > 0.0 { math::min(1.0, 1e-3 / dm) } else { 1.0 };
            for i in 0..n {
                d[i] *= sc;
            }
        }
        for j in 0..k {
            let mut b = 0.0;
            for i in 0..n {
                b += ys[j][i] * d[i];
            }
            b *= rho[j];
            for i in 0..n {
                d[i] += ss[j][i] * (alpha[j] - b);
            }
        }
        let mut dg = 0.0;
        for i in 0..n {
            dg += d[i] * g[i];
        }
        if !(dg < 0.0) {
            // not a descent direction: restart from steepest descent
            ss.clear();
            ys.clear();
            rho.clear();
            let mut dm = 0.0;
            for i in 0..n {
                dm = math::max(dm, math::abs(g[i]));
            }
            let sc = if dm > 0.0 { 1e-3 / dm } else { 0.0 };
            dg = 0.0;
            for i in 0..n {
                d[i] = -g[i] * sc;
                dg += d[i] * g[i];
            }
            if !(dg < 0.0) {
                break;
            }
        }
        let mut step = 1.0;
        let mut fnew = 0.0;
        let mut ok = false;
        for _ in 0..40 {
            for i in 0..n {
                xn[i] = x[i] + step * d[i];
            }
            fnew = f(&xn, &mut gn)?;
            if fnew <= fx + 1e-4 * step * dg {
                ok = true;
                break;
            }
            step *= 0.5;
        }
        if !ok {
            break;
        }
        let mut s = vec![0.0f64; n];
        let mut y = vec![0.0f64; n];
        let mut sy = 0.0;
        for i in 0..n {
            s[i] = xn[i] - x[i];
            y[i] = gn[i] - g[i];
            sy += s[i] * y[i];
        }
        let df = fx - fnew;
        x.copy_from_slice(&xn);
        g.copy_from_slice(&gn);
        fx = fnew;
        if sy > 1e-300 {
            ss.push(s);
            ys.push(y);
            rho.push(1.0 / sy);
            if ss.len() > m {
                ss.remove(0);
                ys.remove(0);
                rho.remove(0);
            }
        }
        stall = if df <= 1e-15 * math::max(1.0, math::abs(fx)) { stall + 1 } else { 0 };
        if stall >= 5 {
            break;
        }
    }
    Ok(fx)
}

/// `polish.ts: Pair`: a near pair with the active vertices of i and j.
struct Pair {
    i: usize,
    j: usize,
    vi: Vec<usize>,
    vj: Vec<usize>,
}

/// `polish.ts: rotOf`: rotation H(q) / |q|^2 of an unnormalised quaternion (row-major), into R.
#[inline]
fn rot_of(w: f64, x: f64, y: f64, z: f64, r: &mut [f64]) -> f64 {
    let n = w * w + x * x + y * y + z * z;
    r[0] = (w * w + x * x - y * y - z * z) / n;
    r[1] = (2.0 * (x * y - w * z)) / n;
    r[2] = (2.0 * (x * z + w * y)) / n;
    r[3] = (2.0 * (x * y + w * z)) / n;
    r[4] = (w * w - x * x + y * y - z * z) / n;
    r[5] = (2.0 * (y * z - w * x)) / n;
    r[6] = (2.0 * (x * z - w * y)) / n;
    r[7] = (2.0 * (y * z + w * x)) / n;
    r[8] = (w * w - x * x - y * y + z * z) / n;
    n
}

/// `polish.ts: makeObjective`: the penalty objective of one stage as a function of the packed variables, with its
/// gradient. Holds the buffers the source keeps in its closure.
struct Objective<'a> {
    pc: &'a Solid,
    cc: &'a Solid,
    n: usize,
    pairs: &'a [Pair],
    walls: &'a [Vec<(usize, Vec<usize>)>],
    mu: f64,
    g: f64,
    w: f64,
    gate: &'a Gate<'a>,
    x: Vec<f64>,
    gg: Vec<f64>,
    r: Vec<f64>,
    q2: Vec<f64>,
    touched: Vec<u8>,
    count: u64,
}

impl Objective<'_> {
    fn eval(&mut self, z: &[f64], grad: &mut [f64]) -> Result<f64, Halt> {
        self.gate.tick()?;
        self.count += 1;
        let (nv, n, mu, g, w) = (self.pc.nv, self.n, self.mu, self.g, self.w);
        let v = &self.pc.v;
        let reg = 1e-3;
        let base = 1 + 7 * n;
        grad.fill(0.0);
        let s = z[0];
        for i in 0..n {
            let o = 1 + 7 * i;
            let ri = &mut self.r[9 * i..9 * i + 9];
            self.q2[i] = rot_of(z[o + 3], z[o + 4], z[o + 5], z[o + 6], ri);
            let cx = z[o];
            let cy = z[o + 1];
            let cz = z[o + 2];
            for vv in 0..nv {
                let a = v[3 * vv];
                let b = v[3 * vv + 1];
                let c = v[3 * vv + 2];
                let k = 3 * (i * nv + vv);
                self.x[k] = cx + ri[0] * a + ri[1] * b + ri[2] * c;
                self.x[k + 1] = cy + ri[3] * a + ri[4] * b + ri[5] * c;
                self.x[k + 2] = cz + ri[6] * a + ri[7] * b + ri[8] * c;
            }
        }
        self.gg.fill(0.0);
        self.touched.fill(0);
        let x = &self.x;
        let gg = &mut self.gg;
        let touched = &mut self.touched;
        let mut pen = 0.0;
        // walls
        let cn = &self.cc.n;
        let cb = &self.cc.offsets;
        for i in 0..n {
            for (face, list) in &self.walls[i] {
                let face = *face;
                let nx = cn[3 * face];
                let ny = cn[3 * face + 1];
                let nz = cn[3 * face + 2];
                let lim = s * cb[face] - w;
                for &vv in list {
                    let k = 3 * (i * nv + vv);
                    let viol = x[k] * nx + x[k + 1] * ny + x[k + 2] * nz - lim;
                    if viol <= 0.0 {
                        continue;
                    }
                    pen += viol * viol;
                    let c2 = 2.0 * mu * viol;
                    gg[k] += c2 * nx;
                    gg[k + 1] += c2 * ny;
                    gg[k + 2] += c2 * nz;
                    touched[i * nv + vv] = 1;
                    grad[0] -= c2 * cb[face];
                }
            }
        }
        // pairs
        for (p, pr) in self.pairs.iter().enumerate() {
            let (i, j) = (pr.i, pr.j);
            let o = base + 4 * p;
            let mx = z[o];
            let my = z[o + 1];
            let mz = z[o + 2];
            let t = z[o + 3];
            let ml = math::hypot3(mx, my, mz);
            let ux = mx / ml;
            let uy = my / ml;
            let uz = mz / ml;
            let mut gnx = 0.0;
            let mut gny = 0.0;
            let mut gnz = 0.0;
            let mut gt = 0.0;
            for &vv in &pr.vi {
                let k = 3 * (i * nv + vv);
                let viol = ux * x[k] + uy * x[k + 1] + uz * x[k + 2] - t + g / 2.0;
                if viol <= 0.0 {
                    continue;
                }
                pen += viol * viol;
                let c2 = 2.0 * mu * viol;
                gg[k] += c2 * ux;
                gg[k + 1] += c2 * uy;
                gg[k + 2] += c2 * uz;
                touched[i * nv + vv] = 1;
                gnx += c2 * x[k];
                gny += c2 * x[k + 1];
                gnz += c2 * x[k + 2];
                gt -= c2;
            }
            for &vv in &pr.vj {
                let k = 3 * (j * nv + vv);
                let viol = t - (ux * x[k] + uy * x[k + 1] + uz * x[k + 2]) + g / 2.0;
                if viol <= 0.0 {
                    continue;
                }
                pen += viol * viol;
                let c2 = 2.0 * mu * viol;
                gg[k] -= c2 * ux;
                gg[k + 1] -= c2 * uy;
                gg[k + 2] -= c2 * uz;
                touched[j * nv + vv] = 1;
                gnx -= c2 * x[k];
                gny -= c2 * x[k + 1];
                gnz -= c2 * x[k + 2];
                gt += c2;
            }
            // d/dm of a function of n = m/|m|: (gn - (gn.n) n) / |m|
            let gu = gnx * ux + gny * uy + gnz * uz;
            let e = ml * ml - 1.0;
            grad[o] = (gnx - gu * ux) / ml + 4.0 * reg * e * mx;
            grad[o + 1] = (gny - gu * uy) / ml + 4.0 * reg * e * my;
            grad[o + 2] = (gnz - gu * uz) / ml + 4.0 * reg * e * mz;
            grad[o + 3] = gt;
            pen += 0.0; // the regulariser is added below
        }
        // chain rule to the pieces: x = c + H(q) v / |q|^2
        let mut reg_sum = 0.0;
        for i in 0..n {
            let o = 1 + 7 * i;
            let qw = z[o + 3];
            let qx = z[o + 4];
            let qy = z[o + 5];
            let qz = z[o + 6];
            let q2 = self.q2[i];
            let mut gcx = 0.0;
            let mut gcy = 0.0;
            let mut gcz = 0.0;
            let mut gw = 0.0;
            let mut gx = 0.0;
            let mut gy = 0.0;
            let mut gz = 0.0;
            let mut a_rv = 0.0;
            for vv in 0..nv {
                if touched[i * nv + vv] == 0 {
                    continue;
                }
                let k = 3 * (i * nv + vv);
                let ax = gg[k];
                let ay = gg[k + 1];
                let az = gg[k + 2];
                gcx += ax;
                gcy += ay;
                gcz += az;
                let vx = v[3 * vv];
                let vy = v[3 * vv + 1];
                let vz = v[3 * vv + 2];
                let av = ax * vx + ay * vy + az * vz;
                let ua = qx * ax + qy * ay + qz * az;
                let uv = qx * vx + qy * vy + qz * vz;
                // a . (u x v)
                let auv = ax * (qy * vz - qz * vy) + ay * (qz * vx - qx * vz) + az * (qx * vy - qy * vx);
                // v x a
                let vax = vy * az - vz * ay;
                let vay = vz * ax - vx * az;
                let vaz = vx * ay - vy * ax;
                gw += 2.0 * qw * av + 2.0 * auv;
                gx += -2.0 * av * qx + 2.0 * ua * vx + 2.0 * uv * ax + 2.0 * qw * vax;
                gy += -2.0 * av * qy + 2.0 * ua * vy + 2.0 * uv * ay + 2.0 * qw * vay;
                gz += -2.0 * av * qz + 2.0 * ua * vz + 2.0 * uv * az + 2.0 * qw * vaz;
                // a . (R v) = a . (x - c)
                a_rv += ax * (x[k] - z[o]) + ay * (x[k + 1] - z[o + 1]) + az * (x[k + 2] - z[o + 2]);
            }
            grad[o] = gcx;
            grad[o + 1] = gcy;
            grad[o + 2] = gcz;
            let e = q2 - 1.0;
            reg_sum += e * e;
            let c2 = (2.0 * a_rv) / q2;
            grad[o + 3] = gw / q2 - c2 * qw + 4.0 * reg * e * qw;
            grad[o + 4] = gx / q2 - c2 * qx + 4.0 * reg * e * qx;
            grad[o + 5] = gy / q2 - c2 * qy + 4.0 * reg * e * qy;
            grad[o + 6] = gz / q2 - c2 * qz + 4.0 * reg * e * qz;
        }
        for p in 0..self.pairs.len() {
            let o = base + 4 * p;
            let e = z[o] * z[o] + z[o + 1] * z[o + 1] + z[o + 2] * z[o + 2] - 1.0;
            reg_sum += e * e;
        }
        grad[0] += 1.0;
        Ok(s + mu * pen + reg * reg_sum)
    }
}

/// A pair of `nearPairs`: indices, the separating axis and the plane's offset t.
struct NearPair {
    i: usize,
    j: usize,
    axis: Vec3,
    t: f64,
}

/// `polish.ts: nearPairs`: pairs whose circumscribed balls (widened by `pad`) meet, with planes from the
/// separating-axis test: for a separated pair the first axis that separates it (the stage moves the plane anyway),
/// for an overlapping pair the axis of least overlap.
fn near_pairs<'a>(pc: &'a Solid, poses: &[Pose], pad: f64, gate: &Gate) -> Result<(Vec<Placed<'a>>, Vec<NearPair>), Halt> {
    let n = poses.len();
    let placed = poses.iter().map(|p| place(pc, p)).collect::<Result<Vec<_>, String>>()?;
    let reach = 2.0 * pc.circumradius + pad;
    let mut out = Vec::new();
    for i in 0..n {
        for j in i + 1..n {
            let a = placed[i].c;
            let b = placed[j].c;
            if (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]) > reach * reach {
                continue;
            }
            gate.poll()?;
            let r = separation(&placed[i], &placed[j], 0.0, None);
            let [ux, uy, uz] = r.axis;
            let mut hi_a = f64::NEG_INFINITY;
            let mut lo_b = f64::INFINITY;
            let xa = &placed[i].x;
            let xb = &placed[j].x;
            for k in (0..xa.len()).step_by(3) {
                hi_a = math::max(hi_a, ux * xa[k] + uy * xa[k + 1] + uz * xa[k + 2]);
            }
            for k in (0..xb.len()).step_by(3) {
                lo_b = math::min(lo_b, ux * xb[k] + uy * xb[k + 1] + uz * xb[k + 2]);
            }
            out.push(NearPair { i, j, axis: r.axis, t: (hi_a + lo_b) / 2.0 });
        }
    }
    Ok((placed, out))
}

/// `polish.ts: normalised`.
fn normalised(p: &Pose) -> Pose {
    let m = math::hypot4(p[3], p[4], p[5], p[6]);
    [p[0], p[1], p[2], p[3] / m, p[4] / m, p[5] / m, p[6] / m]
}

/// `polish.ts: polishConfig`: penalty polish of a configuration (see the module comment), followed by
/// `legalize_config`. A `Halt::Stop` comes back only from the work between evaluations (a poll); one from `tick`
/// ends the stages and is the result's `stopped`.
pub fn polish_config(problem: &PolyhedraProblem, config: &PolyhedraConfig, opts: &PolishOptions) -> Result<PolishResult, Halt> {
    let pc = get_solid(&problem.piece)?;
    let cc = get_solid(&problem.container)?;
    let g = opts.pair_clearance;
    let w = opts.wall_clearance;
    let default_mus = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
    let mus = opts.mus.unwrap_or(&default_mus);
    let iters = 400;
    let n = config.pieces.len();
    let mut poses: Vec<Pose> = config.pieces.iter().map(normalised).collect();
    let mut s = config.s;
    let mut evaluations = 0u64;
    let mut stopped: Option<Why> = None;
    for &mu in mus {
        // vertex lists: within delta of the stage's planes and walls
        let delta = 0.25 * pc.circumradius + 0.05;
        let (placed, out) = near_pairs(pc, &poses, 0.1 * pc.circumradius + 0.05, opts.gate)?;
        let pairs: Vec<Pair> = out
            .iter()
            .map(|np| {
                let mut vi = Vec::new();
                let mut vj = Vec::new();
                let xa = &placed[np.i].x;
                let xb = &placed[np.j].x;
                let axis = np.axis;
                for v in 0..pc.nv {
                    if axis[0] * xa[3 * v] + axis[1] * xa[3 * v + 1] + axis[2] * xa[3 * v + 2] >= np.t - delta {
                        vi.push(v);
                    }
                    if axis[0] * xb[3 * v] + axis[1] * xb[3 * v + 1] + axis[2] * xb[3 * v + 2] <= np.t + delta {
                        vj.push(v);
                    }
                }
                Pair { i: np.i, j: np.j, vi, vj }
            })
            .collect();
        let walls: Vec<Vec<(usize, Vec<usize>)>> = placed
            .iter()
            .map(|pl| {
                let mut list = Vec::new();
                for f in 0..cc.offsets.len() {
                    let nx = cc.n[3 * f];
                    let ny = cc.n[3 * f + 1];
                    let nz = cc.n[3 * f + 2];
                    let lim = s * cc.offsets[f] - delta;
                    let mut v = Vec::new();
                    for k in 0..pc.nv {
                        if nx * pl.x[3 * k] + ny * pl.x[3 * k + 1] + nz * pl.x[3 * k + 2] >= lim {
                            v.push(k);
                        }
                    }
                    if !v.is_empty() {
                        list.push((f, v));
                    }
                }
                list
            })
            .collect();
        let mut z = vec![0.0f64; 1 + 7 * n + 4 * pairs.len()];
        z[0] = s;
        for (i, p) in poses.iter().enumerate() {
            z[1 + 7 * i..8 + 7 * i].copy_from_slice(p);
        }
        for (p, np) in out.iter().enumerate() {
            let o = 1 + 7 * n + 4 * p;
            z[o..o + 3].copy_from_slice(&np.axis);
            z[o + 3] = np.t;
        }
        let nv = pc.nv;
        let mut obj = Objective {
            pc,
            cc,
            n,
            pairs: &pairs,
            walls: &walls,
            mu,
            g,
            w,
            gate: opts.gate,
            x: vec![0.0; 3 * nv * n],
            gg: vec![0.0; 3 * nv * n],
            r: vec![0.0; 9 * n],
            q2: vec![0.0; n],
            touched: vec![0; nv * n],
            count: 0,
        };
        // the best iterate seen, for a stop in the middle of a line search
        match lbfgs(&mut |zz, gr| obj.eval(zz, gr), &mut z, iters, 8, 1e-12) {
            Ok(_) => {}
            Err(Halt::Stop(why)) => stopped = Some(why),
            Err(e) => return Err(e),
        }
        evaluations += obj.count;
        if z.iter().all(|v| v.is_finite()) {
            s = z[0];
            poses = (0..n)
                .map(|i| {
                    let mut p = [0.0f64; 7];
                    p.copy_from_slice(&z[1 + 7 * i..8 + 7 * i]);
                    normalised(&p)
                })
                .collect();
        }
        if stopped.is_some() {
            break;
        }
    }
    let config2 = legalize_config(problem, &PolyhedraConfig { s, pieces: poses }, g, w, opts.gate)?;
    Ok(PolishResult { config: config2, evaluations, stopped })
}

/// `polish.ts: bestTranslation`: the best translation t of the pieces in the container: min z with N_f . (x + t)
/// <= z b_f for all vertices x; the size is then z. Enumerates 4-subsets of faces for containers with at most 14
/// faces, else uses a projected subgradient descent. Returns t (the caller recomputes the scale exactly).
fn best_translation(cc: &Solid, s: &[f64]) -> Vec3 {
    let f_count = s.len();
    let nf = |f: usize| [cc.n[3 * f], cc.n[3 * f + 1], cc.n[3 * f + 2]];
    let b = &cc.offsets;
    let z_at = |t: &[f64]| {
        let mut z = f64::NEG_INFINITY;
        for f in 0..f_count {
            let n = nf(f);
            z = math::max(z, (s[f] + n[0] * t[0] + n[1] * t[1] + n[2] * t[2]) / b[f]);
        }
        z
    };
    let mut best = [0.0, 0.0, 0.0];
    let mut bz = z_at(&best);
    if f_count <= 14 {
        for a in 0..f_count {
            for c in a + 1..f_count {
                for d in c + 1..f_count {
                    for e in d + 1..f_count {
                        let idx = [a, c, d, e];
                        let mut mat: [[f64; 5]; 4] = [[0.0; 5]; 4];
                        for (r, &f) in idx.iter().enumerate() {
                            let n = nf(f);
                            mat[r] = [n[0], n[1], n[2], -b[f], -s[f]];
                        }
                        let mut ok = true;
                        let mut col = 0;
                        while col < 4 && ok {
                            let mut p = col;
                            for r in col + 1..4 {
                                if math::abs(mat[r][col]) > math::abs(mat[p][col]) {
                                    p = r;
                                }
                            }
                            if math::abs(mat[p][col]) < 1e-12 {
                                ok = false;
                            } else {
                                mat.swap(col, p);
                                for r in 0..4 {
                                    if r != col {
                                        let fct = mat[r][col] / mat[col][col];
                                        for k in col..5 {
                                            mat[r][k] -= fct * mat[col][k];
                                        }
                                    }
                                }
                            }
                            col += 1;
                        }
                        if !ok {
                            continue;
                        }
                        let t = [mat[0][4] / mat[0][0], mat[1][4] / mat[1][1], mat[2][4] / mat[2][2]];
                        let z = z_at(&t);
                        if z < bz {
                            bz = z;
                            best = t;
                        }
                    }
                }
            }
        }
        return best;
    }
    // larger containers: projected subgradient descent on z(t), a convex piecewise-linear function
    let mut t = [0.0f64, 0.0, 0.0];
    let ratios: Vec<f64> = s.iter().enumerate().map(|(f, x)| math::abs(*x) / b[f]).collect();
    let mut step = 0.05 * math::max_of(&ratios);
    let mut it = 0;
    while it < 400 && step > 1e-15 {
        let mut fm = 0;
        let mut zm = f64::NEG_INFINITY;
        for f in 0..f_count {
            let n = nf(f);
            let z = (s[f] + n[0] * t[0] + n[1] * t[1] + n[2] * t[2]) / b[f];
            if z > zm {
                zm = z;
                fm = f;
            }
        }
        let n = nf(fm);
        let cand = [t[0] - (step * n[0]) / b[fm], t[1] - (step * n[1]) / b[fm], t[2] - (step * n[2]) / b[fm]];
        if z_at(&cand) < zm {
            t = cand;
        } else {
            step *= 0.7;
        }
        it += 1;
    }
    if z_at(&t) < bz {
        t
    } else {
        best
    }
}

/// `polish.ts: minSeparation`: smallest separation over pairs whose circumscribed balls meet (stops each pair at
/// `enough`).
fn min_separation(pc: &Solid, poses: &[Pose], enough: f64, gate: &Gate) -> Result<f64, Halt> {
    let placed = poses.iter().map(|p| place(pc, p)).collect::<Result<Vec<_>, String>>()?;
    let reach = 2.0 * pc.circumradius + math::max(enough, 0.0) + 1e-9;
    let mut m = f64::INFINITY;
    for i in 0..poses.len() {
        for j in i + 1..poses.len() {
            let a = placed[i].c;
            let b = placed[j].c;
            if (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]) > reach * reach {
                continue;
            }
            gate.poll()?;
            m = math::min(m, separation(&placed[i], &placed[j], enough, None).sep);
        }
    }
    Ok(m)
}

/// `polish.ts: legalizeConfig`: a valid configuration near the given one: pairs separated by at least g, walls at
/// least w, container translated to its best position (see the module comment). The pieces' orientations are kept.
pub fn legalize_config(
    problem: &PolyhedraProblem,
    config: &PolyhedraConfig,
    g: f64,
    w: f64,
    gate: &Gate,
) -> Result<PolyhedraConfig, Halt> {
    let pc = get_solid(&problem.piece)?;
    let cc = get_solid(&problem.container)?;
    let mut poses: Vec<Pose> = config.pieces.iter().map(normalised).collect();
    // scaling about the origin cannot separate pieces whose centres coincide: move every such duplicate away
    // first, deterministically, by a little more than twice a piece's circumradius (along a spiral)
    let close = |a: &Pose, b: &Pose| {
        math::hypot3(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9 * (1.0 + math::hypot3(a[0], a[1], a[2]))
    };
    let moved: Vec<Pose> = (0..poses.len())
        .map(|i| {
            let p = poses[i];
            if !(0..i).any(|j| close(&p, &poses[j])) {
                return p;
            }
            let t = (i + 1) as f64;
            let r = 2.2 * pc.circumradius * math::cbrt(t);
            let phi = math::acos(1.0 - 2.0 * ((t * 0.6180339887498949) % 1.0));
            let th = 2.399963229728653 * t;
            [
                p[0] + r * math::sin(phi) * math::cos(th),
                p[1] + r * math::sin(phi) * math::sin(th),
                p[2] + r * math::cos(phi),
                p[3],
                p[4],
                p[5],
                p[6],
            ]
        })
        .collect();
    poses = moved;
    // move apart until every pair has its clearance (float rounding may leave a pair a hair short)
    let mut extra = 0.0;
    for _ in 0..60 {
        let sep = min_separation(pc, &poses, g, gate)?;
        if sep >= g {
            break;
        }
        let delta = (g - sep) / (2.0 * pc.inradius) + extra + 1e-15;
        poses = poses
            .iter()
            .map(|p| [p[0] * (1.0 + delta), p[1] * (1.0 + delta), p[2] * (1.0 + delta), p[3], p[4], p[5], p[6]])
            .collect();
        extra = if extra != 0.0 { 2.0 * extra } else { 1e-14 };
    }
    // translate to the best position and take the smallest scale with wall clearance w
    let f_count = cc.offsets.len();
    let mut sv = vec![f64::NEG_INFINITY; f_count];
    let placed = poses.iter().map(|p| place(pc, p)).collect::<Result<Vec<_>, String>>()?;
    for pl in &placed {
        for f in 0..f_count {
            let nx = cc.n[3 * f];
            let ny = cc.n[3 * f + 1];
            let nz = cc.n[3 * f + 2];
            for k in (0..pl.x.len()).step_by(3) {
                sv[f] = math::max(sv[f], nx * pl.x[k] + ny * pl.x[k + 1] + nz * pl.x[k + 2]);
            }
        }
    }
    let t = best_translation(cc, &sv);
    poses = poses.iter().map(|p| [p[0] + t[0], p[1] + t[1], p[2] + t[2], p[3], p[4], p[5], p[6]]).collect();
    let mut s = 0.0;
    for p in &poses {
        let pl = place(pc, p)?;
        for f in 0..f_count {
            let nx = cc.n[3 * f];
            let ny = cc.n[3 * f + 1];
            let nz = cc.n[3 * f + 2];
            for k in (0..pl.x.len()).step_by(3) {
                s = math::max(s, (nx * pl.x[k] + ny * pl.x[k + 1] + nz * pl.x[k + 2] + w) / cc.offsets[f]);
            }
        }
    }
    // one ulp-scale margin against the rounding of s * b_f in a check
    s *= 1.0 + 4.0 * f64::EPSILON;
    Ok(PolyhedraConfig { s, pieces: poses })
}
