//! The search for unit-edge solids in the smallest ball: the separating-plane penalty method adapted from the
//! polyhedra family's polish to a ball container, a legalization by scaling the centres, starts and hops. Port
//! of `packages/balls/src/solid-pieces.ts`; its file comment describes the penalty
//!
//!   s + mu [ sum_pairs ( sum_{x in A} (n.x - t + g/2)_+^2 + sum_{x in B} (t - n.x + g/2)_+^2 )
//!            + sum_pieces sum_x (|x| - s + w)_+^2 ]  + small terms keeping |q| and |m| near 1,
//!
//! over the variables s, each piece's centre c and quaternion q (rotation H(q) / |q|^2) and each near pair's
//! plane (m, t), n = m / |m|.

// Index loops and negated comparisons are kept as the source writes them: `!(a < b)` is not `a >= b` for NaN (native/PORTING.md, rule 4).
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use crate::catalogue::{ball_container_radius, ball_container_radius_slope, ball_container_score, BallsProblem};
use crate::lbfgs::lbfgs;
use crate::random::{gauss, random_quaternion, Rng};
use crate::stop::{Fail, Stop, Ticker};
use crate::validate::BallsConfig;
use polypack_js::math;
use polypack_polyhedra::{get_solid, place, separation, Placed, Pose, Solid};

/// `solid-pieces.ts: SOLID_MUS`: penalty weights of a full polish.
pub const SOLID_MUS: [f64; 9] = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];

/// The pair of a stage: the pieces and their vertices that are near the pair's plane.
struct Pair {
    i: usize,
    j: usize,
    vi: Vec<usize>,
    vj: Vec<usize>,
}

/// `solid-pieces.ts: rotOf`: rotation H(q) / |q|^2 of an unnormalised quaternion (row-major), into R; returns |q|^2.
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

/// `solid-pieces.ts: makeObjective`: the penalty of one stage on z = [s, (c, q) of each piece, (m, t) of each
/// pair], with its gradient. The buffers of the source (`X`, `G`, `R`, `Q2`, `touched`) are allocated once.
struct Objective<'a> {
    pc: &'a Solid,
    n: usize,
    pairs: &'a [Pair],
    walls: &'a [Vec<usize>],
    mu: f64,
    g: f64,
    w: f64,
    x: Vec<f64>,
    gg: Vec<f64>,
    r: Vec<f64>,
    q2: Vec<f64>,
    touched: Vec<u8>,
}

/// `reg` of the source: the weight of the terms that keep |q| and |m| near 1.
const REG: f64 = 1e-3;

impl<'a> Objective<'a> {
    fn new(pc: &'a Solid, n: usize, pairs: &'a [Pair], walls: &'a [Vec<usize>], mu: f64, g: f64, w: f64) -> Self {
        let nv = pc.nv;
        Objective {
            pc,
            n,
            pairs,
            walls,
            mu,
            g,
            w,
            x: vec![0.0; 3 * nv * n],
            gg: vec![0.0; 3 * nv * n],
            r: vec![0.0; 9 * n],
            q2: vec![0.0; n],
            touched: vec![0; nv * n],
        }
    }

    fn eval(&mut self, z: &[f64], grad: &mut [f64], tk: &mut Ticker) -> Result<f64, Stop> {
        tk.tick()?;
        let (pc, n, mu, g, w) = (self.pc, self.n, self.mu, self.g, self.w);
        let nv = pc.nv;
        let v = &pc.v;
        let base = 1 + 7 * n;
        for t in grad.iter_mut() {
            *t = 0.0;
        }
        let s = z[0];
        for i in 0..n {
            let o = 1 + 7 * i;
            let ri = &mut self.r[9 * i..9 * i + 9];
            self.q2[i] = rot_of(z[o + 3], z[o + 4], z[o + 5], z[o + 6], ri);
            for vi in 0..nv {
                let a = v[3 * vi];
                let b = v[3 * vi + 1];
                let c = v[3 * vi + 2];
                let k = 3 * (i * nv + vi);
                self.x[k] = z[o] + ri[0] * a + ri[1] * b + ri[2] * c;
                self.x[k + 1] = z[o + 1] + ri[3] * a + ri[4] * b + ri[5] * c;
                self.x[k + 2] = z[o + 2] + ri[6] * a + ri[7] * b + ri[8] * c;
            }
        }
        for t in self.gg.iter_mut() {
            *t = 0.0;
        }
        for t in self.touched.iter_mut() {
            *t = 0;
        }
        let xs = &self.x;
        let gs = &mut self.gg;
        let touched = &mut self.touched;
        let mut pen = 0.0;
        // the sphere: vertices beyond s - w
        let lim = ball_container_radius(s) - w;
        for i in 0..n {
            for &vi in &self.walls[i] {
                let k = 3 * (i * nv + vi);
                let r = math::hypot3(xs[k], xs[k + 1], xs[k + 2]);
                let viol = r - lim;
                if viol <= 0.0 || r == 0.0 {
                    continue;
                }
                pen += viol * viol;
                let c2 = (2.0 * mu * viol) / r;
                gs[k] += c2 * xs[k];
                gs[k + 1] += c2 * xs[k + 1];
                gs[k + 2] += c2 * xs[k + 2];
                touched[i * nv + vi] = 1;
                grad[0] -= 2.0 * mu * viol * ball_container_radius_slope();
            }
        }
        // pairs
        for p in 0..self.pairs.len() {
            let Pair { i, j, vi, vj } = &self.pairs[p];
            let (i, j) = (*i, *j);
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
            for &vv in vi {
                let k = 3 * (i * nv + vv);
                let viol = ux * xs[k] + uy * xs[k + 1] + uz * xs[k + 2] - t + g / 2.0;
                if viol <= 0.0 {
                    continue;
                }
                pen += viol * viol;
                let c2 = 2.0 * mu * viol;
                gs[k] += c2 * ux;
                gs[k + 1] += c2 * uy;
                gs[k + 2] += c2 * uz;
                touched[i * nv + vv] = 1;
                gnx += c2 * xs[k];
                gny += c2 * xs[k + 1];
                gnz += c2 * xs[k + 2];
                gt -= c2;
            }
            for &vv in vj {
                let k = 3 * (j * nv + vv);
                let viol = t - (ux * xs[k] + uy * xs[k + 1] + uz * xs[k + 2]) + g / 2.0;
                if viol <= 0.0 {
                    continue;
                }
                pen += viol * viol;
                let c2 = 2.0 * mu * viol;
                gs[k] -= c2 * ux;
                gs[k + 1] -= c2 * uy;
                gs[k + 2] -= c2 * uz;
                touched[j * nv + vv] = 1;
                gnx -= c2 * xs[k];
                gny -= c2 * xs[k + 1];
                gnz -= c2 * xs[k + 2];
                gt += c2;
            }
            // d/dm of a function of n = m/|m|: (gn - (gn.n) n) / |m|
            let gu = gnx * ux + gny * uy + gnz * uz;
            let e = ml * ml - 1.0;
            grad[o] = (gnx - gu * ux) / ml + 4.0 * REG * e * mx;
            grad[o + 1] = (gny - gu * uy) / ml + 4.0 * REG * e * my;
            grad[o + 2] = (gnz - gu * uz) / ml + 4.0 * REG * e * mz;
            grad[o + 3] = gt;
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
            for vi in 0..nv {
                if touched[i * nv + vi] == 0 {
                    continue;
                }
                let k = 3 * (i * nv + vi);
                let ax = gs[k];
                let ay = gs[k + 1];
                let az = gs[k + 2];
                gcx += ax;
                gcy += ay;
                gcz += az;
                let vx = v[3 * vi];
                let vy = v[3 * vi + 1];
                let vz = v[3 * vi + 2];
                let av = ax * vx + ay * vy + az * vz;
                let ua = qx * ax + qy * ay + qz * az;
                let uv = qx * vx + qy * vy + qz * vz;
                let auv = ax * (qy * vz - qz * vy) + ay * (qz * vx - qx * vz) + az * (qx * vy - qy * vx);
                let vax = vy * az - vz * ay;
                let vay = vz * ax - vx * az;
                let vaz = vx * ay - vy * ax;
                gw += 2.0 * qw * av + 2.0 * auv;
                gx += -2.0 * av * qx + 2.0 * ua * vx + 2.0 * uv * ax + 2.0 * qw * vax;
                gy += -2.0 * av * qy + 2.0 * ua * vy + 2.0 * uv * ay + 2.0 * qw * vay;
                gz += -2.0 * av * qz + 2.0 * ua * vz + 2.0 * uv * az + 2.0 * qw * vaz;
                a_rv += ax * (xs[k] - z[o]) + ay * (xs[k + 1] - z[o + 1]) + az * (xs[k + 2] - z[o + 2]);
            }
            grad[o] = gcx;
            grad[o + 1] = gcy;
            grad[o + 2] = gcz;
            let e = q2 - 1.0;
            reg_sum += e * e;
            let c2 = (2.0 * a_rv) / q2;
            grad[o + 3] = gw / q2 - c2 * qw + 4.0 * REG * e * qw;
            grad[o + 4] = gx / q2 - c2 * qx + 4.0 * REG * e * qx;
            grad[o + 5] = gy / q2 - c2 * qy + 4.0 * REG * e * qy;
            grad[o + 6] = gz / q2 - c2 * qz + 4.0 * REG * e * qz;
        }
        for p in 0..self.pairs.len() {
            let o = base + 4 * p;
            let e = z[o] * z[o] + z[o + 1] * z[o + 1] + z[o + 2] * z[o + 2] - 1.0;
            reg_sum += e * e;
        }
        grad[0] += 1.0;
        Ok(s + mu * pen + REG * reg_sum)
    }
}

/// `solid-pieces.ts: normalised`: a pose with its quaternion divided by its norm.
fn normalised(p: &[f64]) -> Pose {
    let m = math::hypot4(p[3], p[4], p[5], p[6]);
    [p[0], p[1], p[2], p[3] / m, p[4] / m, p[5] / m, p[6] / m]
}

/// A pair of `nearPairs`: the indices, the separating axis and the plane's offset.
struct NearPair {
    i: usize,
    j: usize,
    axis: [f64; 3],
    t: f64,
}

/// `place` of the pieces, as `poses.map((p) => place(Pc, p))`.
fn place_all<'a>(pc: &'a Solid, poses: &[Pose]) -> Result<Vec<Placed<'a>>, String> {
    poses.iter().map(|p| place(pc, p)).collect()
}

/// `solid-pieces.ts: nearPairs`: pairs whose circumscribed balls (widened by pad) meet, with a plane each from
/// the separating-axis test.
fn near_pairs<'a>(
    pc: &'a Solid,
    poses: &[Pose],
    pad: f64,
    tk: &Ticker,
) -> Result<(Vec<Placed<'a>>, Vec<NearPair>), Fail> {
    let n = poses.len();
    let placed = place_all(pc, poses)?;
    let reach = 2.0 * pc.circumradius + pad;
    let mut out = Vec::new();
    for i in 0..n {
        for j in i + 1..n {
            let a = placed[i].c;
            let b = placed[j].c;
            if (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]) > reach * reach {
                continue;
            }
            tk.poll()?;
            let r = separation(&placed[i], &placed[j], 0.0, None);
            let [ux, uy, uz] = r.axis;
            let mut hi_a = f64::NEG_INFINITY;
            let mut lo_b = f64::INFINITY;
            let xa = &placed[i].x;
            let xb = &placed[j].x;
            let mut k = 0;
            while k < xa.len() {
                hi_a = math::max(hi_a, ux * xa[k] + uy * xa[k + 1] + uz * xa[k + 2]);
                k += 3;
            }
            let mut k = 0;
            while k < xb.len() {
                lo_b = math::min(lo_b, ux * xb[k] + uy * xb[k + 1] + uz * xb[k + 2]);
                k += 3;
            }
            out.push(NearPair { i, j, axis: r.axis, t: (hi_a + lo_b) / 2.0 });
        }
    }
    Ok((placed, out))
}

/// `solid-pieces.ts: minSeparation`: smallest separation over pairs whose circumscribed balls meet (each pair
/// stops at `enough`).
fn min_separation(pc: &Solid, poses: &[Pose], enough: f64, poll: &mut dyn FnMut() -> Result<(), Stop>) -> Result<f64, Fail> {
    let placed = place_all(pc, poses)?;
    let reach = 2.0 * pc.circumradius + math::max(enough, 0.0) + 1e-9;
    let mut m = f64::INFINITY;
    for i in 0..poses.len() {
        for j in i + 1..poses.len() {
            let a = placed[i].c;
            let b = placed[j].c;
            if (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]) > reach * reach {
                continue;
            }
            poll()?;
            m = math::min(m, separation(&placed[i], &placed[j], enough, None).sep);
        }
    }
    Ok(m)
}

fn config_of(s: f64, poses: &[Pose]) -> BallsConfig {
    BallsConfig { s, pieces: poses.iter().map(|p| p.to_vec()).collect() }
}

/// `solid-pieces.ts: legalizeSolids`: a valid configuration near the given poses (each at least 7 numbers, its
/// quaternion normalised first, as the source does at every call); orientations are kept. `poll` is called
/// between the separating-axis tests.
pub fn legalize_solids<P: AsRef<[f64]>>(
    problem: &BallsProblem,
    poses0: &[P],
    g: f64,
    w: f64,
    poll: &mut dyn FnMut() -> Result<(), Stop>,
) -> Result<BallsConfig, Fail> {
    let poses0: Vec<Pose> = poses0.iter().map(|p| normalised(p.as_ref())).collect();
    let pc = get_solid(&problem.piece)?;
    let close = |a: &Pose, b: &Pose| {
        math::hypot3(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9 * (1.0 + math::hypot3(a[0], a[1], a[2]))
    };
    // the first of a coincident group stays; each later one moves out along a spiral (the test reads the poses
    // as they were before any moved)
    let mut poses: Vec<Pose> = Vec::with_capacity(poses0.len());
    for (i, p) in poses0.iter().enumerate() {
        if !poses0.iter().enumerate().any(|(j, q)| j < i && close(p, q)) {
            poses.push(*p);
            continue;
        }
        let t = (i + 1) as f64;
        let r = 2.2 * pc.circumradius * math::cbrt(t);
        let phi = math::acos(1.0 - 2.0 * ((t * 0.6180339887498949) % 1.0));
        let th = 2.399963229728653 * t;
        poses.push([
            p[0] + r * math::sin(phi) * math::cos(th),
            p[1] + r * math::sin(phi) * math::sin(th),
            p[2] + r * math::cos(phi),
            p[3],
            p[4],
            p[5],
            p[6],
        ]);
    }
    let mut extra = 0.0;
    for _round in 0..60 {
        let sep = min_separation(pc, &poses, g, poll)?;
        if sep >= g {
            break;
        }
        // scaling the centres by 1 + delta adds at least 2 rho delta to every pair's gap, rho the inradius
        let delta = (g - sep) / (2.0 * pc.inradius) + extra + 1e-15;
        for p in poses.iter_mut() {
            *p = [p[0] * (1.0 + delta), p[1] * (1.0 + delta), p[2] * (1.0 + delta), p[3], p[4], p[5], p[6]];
        }
        extra = if extra != 0.0 { 2.0 * extra } else { 1e-14 };
    }
    let mut far = 0.0f64;
    for p in &poses {
        let x = place(pc, p)?.x;
        let mut k = 0;
        while k < x.len() {
            far = math::max(far, math::hypot3(x[k], x[k + 1], x[k + 2]));
            k += 3;
        }
    }
    Ok(config_of(ball_container_score((far + w) * (1.0 + 4.0 * f64::EPSILON)), &poses))
}

/// `solid-pieces.ts: polishSolids`: penalty polish, then legalization. On a stop the `partial` of the stop is
/// the last iterate legalized; a stop before the first stage has minimised carries none, the start being the
/// only iterate.
pub fn polish_solids(
    problem: &BallsProblem,
    config: &BallsConfig,
    tk: &mut Ticker,
    clearance: f64,
    mus: &[f64],
) -> Result<BallsConfig, Fail> {
    let pc = get_solid(&problem.piece)?;
    let g = clearance;
    let w = clearance;
    let n = config.pieces.len();
    let mut poses: Vec<Pose> = config.pieces.iter().map(|p| normalised(p)).collect();
    let mut s = config.s;
    let iters = 400;
    // true once a stage has minimised: its iterate is near legal, and a stop from then on hands it over, legalized
    let mut moved = false;
    for &mu in mus {
        let delta = 0.25 * pc.circumradius + 0.05;
        let (placed, out) = match near_pairs(pc, &poses, 0.1 * pc.circumradius + 0.05, tk) {
            Ok(r) => r,
            Err(Fail::Stop(mut e)) => {
                // a stop between stages: the last iterate, legalized without polls since it is near legal (before
                // the first stage there is none, and the caller has the start)
                if moved {
                    e.partial = Some(legalize_solids(problem, &poses, g, w, &mut || Ok(()))?);
                }
                return Err(Fail::Stop(e));
            }
            Err(e) => return Err(e),
        };
        let mut pairs: Vec<Pair> = Vec::with_capacity(out.len());
        for np in &out {
            let (axis, t) = (np.axis, np.t);
            let mut vi = Vec::new();
            let mut vj = Vec::new();
            let xa = &placed[np.i].x;
            let xb = &placed[np.j].x;
            for v in 0..pc.nv {
                if axis[0] * xa[3 * v] + axis[1] * xa[3 * v + 1] + axis[2] * xa[3 * v + 2] >= t - delta {
                    vi.push(v);
                }
                if axis[0] * xb[3 * v] + axis[1] * xb[3 * v + 1] + axis[2] * xb[3 * v + 2] <= t + delta {
                    vj.push(v);
                }
            }
            pairs.push(Pair { i: np.i, j: np.j, vi, vj });
        }
        let walls: Vec<Vec<usize>> = placed
            .iter()
            .map(|pl| {
                let mut v = Vec::new();
                for k in 0..pc.nv {
                    if math::hypot3(pl.x[3 * k], pl.x[3 * k + 1], pl.x[3 * k + 2]) >= ball_container_radius(s) - delta {
                        v.push(k);
                    }
                }
                v
            })
            .collect();
        let mut z = vec![0.0f64; 1 + 7 * n + 4 * pairs.len()];
        z[0] = s;
        for (i, p) in poses.iter().enumerate() {
            z[1 + 7 * i..8 + 7 * i].copy_from_slice(p);
        }
        for (p, np) in out.iter().enumerate() {
            z[1 + 7 * n + 4 * p..1 + 7 * n + 4 * p + 3].copy_from_slice(&np.axis);
            z[1 + 7 * n + 4 * p + 3] = np.t;
        }
        let mut stopped: Option<Stop> = None;
        {
            let mut obj = Objective::new(pc, n, &pairs, &walls, mu, g, w);
            if let Err(e) = lbfgs(&mut |zz: &[f64], gg: &mut [f64]| obj.eval(zz, gg, tk), &mut z, iters, 8, 1e-12) {
                stopped = Some(e);
            }
        }
        if z.iter().all(|v| v.is_finite()) {
            s = z[0];
            poses = (0..n).map(|i| normalised(&z[1 + 7 * i..8 + 7 * i])).collect();
            moved = true;
        }
        if let Some(mut e) = stopped {
            // the last iterate, legalized without polls, so that a stop already seen cannot leave it without a result
            e.partial = Some(legalize_solids(problem, &poses, g, w, &mut || Ok(()))?);
            return Err(Fail::Stop(e));
        }
    }
    // not polled: the polished iterate is near legal, so this is a sweep or two over the pairs, and a stop that
    // came during it would otherwise leave the polish without a result
    legalize_solids(problem, &poses, g, w, &mut || Ok(()))
}

/// `solid-pieces.ts: solidsAt`: poses of solids at given centres, turned at random.
pub fn solids_at(centres: &[[f64; 3]], rng: &mut Rng) -> Vec<Vec<f64>> {
    centres
        .iter()
        .map(|c| {
            let q = random_quaternion(rng);
            vec![c[0], c[1], c[2], q[0], q[1], q[2], q[3]]
        })
        .collect()
}

/// `solid-pieces.ts: cubeLatticeCut`: P axis-aligned unit cubes of the cubic lattice, shifted at random, whose
/// farthest vertices are nearest the origin.
pub fn cube_lattice_cut(p: usize, rng: &mut Rng) -> Vec<Vec<f64>> {
    let t = [rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5];
    let m = math::ceil(math::cbrt(p as f64)) as i64 + 3;
    let mut cells: Vec<(f64, [f64; 3])> = Vec::new();
    for i in -m..=m {
        for j in -m..=m {
            for k in -m..=m {
                let c = [i as f64 + t[0], j as f64 + t[1], k as f64 + t[2]];
                let far = math::hypot3(math::abs(c[0]) + 0.5, math::abs(c[1]) + 0.5, math::abs(c[2]) + 0.5);
                cells.push((far + 1e-9 * rng.next(), c));
            }
        }
    }
    cells.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    cells.into_iter().take(p).map(|(_, c)| vec![c[0], c[1], c[2], 1.0, 0.0, 0.0, 0.0]).collect()
}

/// `solid-pieces.ts: hopSolids`: a jiggle or a shake of the best configuration.
pub fn hop_solids(problem: &BallsProblem, b: &BallsConfig, rng: &mut Rng) -> Result<BallsConfig, String> {
    let pc = get_solid(&problem.piece)?;
    let p = b.pieces.len();
    let e = 1.0 + 0.005 + 0.025 * rng.next();
    let mut pieces: Vec<Vec<f64>> =
        b.pieces.iter().map(|q| vec![q[0] * e, q[1] * e, q[2] * e, q[3], q[4], q[5], q[6]]).collect();
    if rng.next() < 0.6 {
        let k = 1 + math::floor(rng.next() * math::min(3.0, p as f64)) as usize;
        for _t in 0..k {
            let i = math::floor(rng.next() * p as f64) as usize;
            let q = pieces[i].clone();
            let a = 0.3 * rng.next();
            let step = pc.inradius * 0.5;
            let x = q[0] + step * gauss(rng);
            let y = q[1] + step * gauss(rng);
            let z = q[2] + step * gauss(rng);
            let q3 = q[3] + a * gauss(rng);
            let q4 = q[4] + a * gauss(rng);
            let q5 = q[5] + a * gauss(rng);
            let q6 = q[6] + a * gauss(rng);
            pieces[i] = vec![x, y, z, q3, q4, q5, q6];
        }
    } else {
        let a = 0.02 + 0.1 * rng.next();
        let step = pc.inradius * (0.02 + 0.1 * rng.next());
        for q in pieces.iter_mut() {
            for k in 0..3 {
                q[k] += step * gauss(rng);
            }
            for k in 3..7 {
                q[k] += a * gauss(rng);
            }
        }
    }
    Ok(BallsConfig { s: b.s * e, pieces })
}
