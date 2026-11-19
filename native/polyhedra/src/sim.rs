//! The soft-to-rigid simulator of the polyhedra search. Port of `packages/polyhedra/src/sim/sim.ts` (ported there
//! from upstream's src/sim.js, alejandrozu/platonic-packing, commit cbf76f2f; MIT, Copyright (c) 2026 Yohei
//! Nakajima and Copyright (c) 2026 Alejandro Zarzuelo; see THIRD_PARTY_NOTICES.md).
//!
//! Soft->rigid packer for unit copies of a convex solid in a container that is a scaled copy of a solid.
//! Shape at softness r (internal units: the piece's inradius is 1/2): S_r = (1 - 2r) P (+) B(r); r = 1/2 is the
//! inscribed ball, r = 0 the solid P. Energy: sum over pairs of (2r - sd_core)_+^2, plus sum over walls of the
//! violation squared, plus mu L, where L/2 is the container's inradius. Orientation is a quaternion, with analytic
//! gradients (simgeom.rs), heavy-ball descent with a velocity cap and annealed noise.
//!
//! What the search reaches is ported: `run` and `hop` (without their unused options `add` and `remove`, and so
//! without `bestHole`), `legalize`, `tightContainer` with its simplex, and the step counter and `tick` of the
//! source's changes. Expressions keep the source's order, so the numbers are its numbers to the bit.

// The port keeps the source's index loops and its NaN-aware comparisons (`!(a < b)` is not `a >= b`), line by line.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord, clippy::should_implement_trait)]

use crate::simgeom::{cross, dot, hyp3, overlaps, pose, prep_shape, rotq, sd_cores, Sd, Shape, Vec3};
use crate::solids::get_solid;
use polypack_js::math;
use std::cell::Cell;

/// Why a search was stopped (`polish.ts: StopSearch.why`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    Evals,
    Time,
    Aborted,
}

/// What ends a run before its end: a `StopSearch` of the source, or another thrown `Error` (with its message).
#[derive(Clone, Debug, PartialEq)]
pub enum Halt {
    Stop(Why),
    Error(String),
}

impl From<String> for Halt {
    fn from(e: String) -> Halt {
        Halt::Error(e)
    }
}

/// The `tick` and `poll` of `searchPolyhedra`: `tick` counts an evaluation and ends the run when the budget is
/// spent; both end it when `should_stop` says so.
pub struct Gate<'a> {
    pub evaluations: Cell<u64>,
    pub max_evals: f64,
    pub should_stop: &'a dyn Fn() -> bool,
}

impl Gate<'_> {
    pub fn tick(&self) -> Result<(), Halt> {
        self.evaluations.set(self.evaluations.get() + 1);
        if self.evaluations.get() as f64 > self.max_evals {
            return Err(Halt::Stop(Why::Evals));
        }
        self.poll()
    }

    pub fn poll(&self) -> Result<(), Halt> {
        if (self.should_stop)() {
            return Err(Halt::Stop(Why::Aborted));
        }
        Ok(())
    }
}

/// `x | 0` of a double (ToInt32): the value modulo 2^32 as a signed integer.
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let mut m = x.trunc() % 4294967296.0;
    if m < 0.0 {
        m += 4294967296.0;
    }
    (m as u64 as u32) as i32
}

/// `sim.ts: mulberry32`.
pub struct Rng(u32);

impl Rng {
    /// `mulberry32(a)` of a number (`a |= 0` first).
    pub fn new(a: f64) -> Rng {
        Rng(to_int32(a) as u32)
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

/// `sim.ts: gauss`.
pub fn gauss(rng: &mut Rng) -> f64 {
    let mut u = 0.0;
    while u == 0.0 {
        u = rng.next();
    }
    let r = math::sqrt(-2.0 * math::log(u));
    r * math::cos(2.0 * std::f64::consts::PI * rng.next())
}

/// `sim.ts: SimProblem`.
pub struct SimProblem {
    pub p: Shape,
    pub c: Shape,
    pub off: Vec<f64>,
    pub rho_c: f64,
}

impl SimProblem {
    pub fn s_of_l(&self, l: f64) -> f64 {
        l / (2.0 * self.rho_c)
    }

    pub fn l_of_s(&self, s: f64) -> f64 {
        2.0 * self.rho_c * s
    }
}

/// `sim.ts: makeProblem`: piece solid P (inradius 1/2) and container solid C at the same scale; the container of
/// "size" L is { x : N_f . x <= (L/2) off_f } (centred at the origin), and its scale is s = L / (2 rho_C).
pub fn make_problem(piece: &str, container: &str) -> Result<SimProblem, String> {
    let p = prep_shape(get_solid(piece)?, None);
    let c = prep_shape(get_solid(container)?, Some(p.edge));
    let rho_c = math::min_of(&c.beta);
    let off = c.beta.iter().map(|b| b / rho_c).collect();
    Ok(SimProblem { p, c, off, rho_c })
}

/// `sim.ts: SimState`.
pub struct SimState<'a> {
    pub pb: &'a SimProblem,
    pub n: usize,
    pub rng: Rng,
    pub l: f64,
    pub vl: f64,
    pub r: f64,
    pub step: u64,
    pub c: Vec<Vec3>,
    pub q: Vec<[f64; 4]>,
    pub v: Vec<Vec3>,
    pub w: Vec<Vec3>,
    /// The last separating direction of each pair, by i * n + j (the source's `hints` Map).
    hints: Vec<Option<Vec3>>,
    pub mask: Option<Vec<f64>>,
    sd: Sd,
    gate: &'a Gate<'a>,
}

/// `sim.ts: makeState`: random balls in the container shrunk by 0.7.
pub fn make_state<'a>(pb: &'a SimProblem, n: usize, seed: f64, l0: f64, gate: &'a Gate<'a>) -> Result<SimState<'a>, Halt> {
    let mut rng = Rng::new(seed * 7919.0 + 13.0);
    let mut st = SimState {
        pb,
        n,
        rng: Rng(0),
        l: l0,
        vl: 0.0,
        r: 0.5,
        step: 0,
        c: Vec::new(),
        q: Vec::new(),
        v: Vec::new(),
        w: Vec::new(),
        hints: vec![None; n * n],
        mask: None,
        sd: Sd::default(),
        gate,
    };
    let vmax = math::max_of(&pb.c.v.iter().map(|v| hyp3(v)).collect::<Vec<_>>());
    let rc = ((l0 / 2.0) * vmax) / pb.rho_c;
    for _ in 0..n {
        let mut tries = 0u32;
        let p = loop {
            // uniform in the container shrunk by 0.7
            let p = [(2.0 * rng.next() - 1.0) * rc, (2.0 * rng.next() - 1.0) * rc, (2.0 * rng.next() - 1.0) * rc];
            if pb.c.n.iter().enumerate().all(|(f, nn)| dot(nn, &p) <= (l0 / 2.0) * pb.off[f] - 0.7) {
                break p;
            }
            if tries > 100000 {
                return Err(Halt::Error("cannot place initial centre".to_string()));
            }
            tries += 1;
        };
        st.c.push(p);
        let q = [gauss(&mut rng), gauss(&mut rng), gauss(&mut rng), gauss(&mut rng)];
        let m = math::hypot4(q[0], q[1], q[2], q[3]);
        st.q.push([q[0] / m, q[1] / m, q[2] / m, q[3] / m]);
        st.v.push([0.0; 3]);
        st.w.push([0.0; 3]);
    }
    st.rng = rng;
    Ok(st)
}

/// `sim.ts: dyn`: one heavy-ball step at softness r0 with pressure mu and noise; `move_l` lets the container size
/// move.
pub fn dynamics(st: &mut SimState, r0: f64, mu: f64, noise: f64, move_l: bool) -> Result<(), Halt> {
    st.gate.tick()?;
    let pb = st.pb;
    let n = st.n;
    let pp = &pb.p;
    let k = 1.0 - 2.0 * r0;
    let r = r0;
    let beta = 0.85;
    let cap = 0.03;
    let lr = 0.04;
    let poses: Vec<_> = (0..n).map(|i| pose(pp, &st.c[i], &st.q[i], k)).collect();
    let mut gc = vec![[0.0f64; 3]; n];
    let mut gw = vec![[0.0f64; 3]; n];
    let lim = (2.0 * (k * pp.circ + r) + 1e-3) * (2.0 * (k * pp.circ + r) + 1e-3);
    for i in 0..n {
        for j in i + 1..n {
            let a = st.c[i];
            let b = st.c[j];
            if (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]) > lim {
                continue;
            }
            let key = i * n + j;
            let sd = sd_cores(&mut st.sd, &poses[i], &poses[j], 2.0 * r, true, st.hints[key])?;
            st.hints[key] = st.sd.last_axis;
            let o = 2.0 * r - sd;
            if o <= 0.0 {
                continue;
            }
            let c = -2.0 * o;
            let gr = &st.sd.gr;
            for t in 0..3 {
                gc[i][t] += c * gr[t];
                gw[i][t] += c * gr[3 + t];
                gc[j][t] += c * gr[6 + t];
                gw[j][t] += c * gr[9 + t];
            }
        }
    }
    let mut g_l = mu;
    let cn = &pb.c.n;
    let nv = pp.nv;
    for i in 0..n {
        let x = &poses[i].x;
        let c = st.c[i];
        for f in 0..cn.len() {
            let nn = &cn[f];
            let mut m = f64::NEG_INFINITY;
            let mut im = 0;
            for v in 0..nv {
                let p = x[3 * v] * nn[0] + x[3 * v + 1] * nn[1] + x[3 * v + 2] * nn[2];
                if p > m {
                    m = p;
                    im = v;
                }
            }
            let q = m + r - (st.l / 2.0) * pb.off[f];
            if q <= 0.0 {
                continue;
            }
            let lev = [x[3 * im] - c[0], x[3 * im + 1] - c[1], x[3 * im + 2] - c[2]];
            let tq = cross(&lev, nn);
            for t in 0..3 {
                gc[i][t] += 2.0 * q * nn[t];
                gw[i][t] += 2.0 * q * tq[t];
            }
            if move_l {
                g_l -= 2.0 * q * pb.off[f];
            }
        }
    }
    let ball = r0 >= 0.4999;
    for i in 0..n {
        let mut v = st.v[i];
        let mut w = st.w[i];
        for t in 0..3 {
            v[t] = beta * v[t] - lr * gc[i][t];
            w[t] = if ball { 0.0 } else { beta * w[t] - lr * gw[i][t] };
        }
        let vm = hyp3(&v);
        if vm > cap {
            for t in 0..3 {
                v[t] *= cap / vm;
            }
        }
        let wm = hyp3(&w);
        if wm > cap {
            for t in 0..3 {
                w[t] *= cap / wm;
            }
        }
        st.v[i] = v;
        st.w[i] = w;
        let nz = match &st.mask {
            Some(mk) => noise * mk[i],
            None => noise,
        };
        for t in 0..3 {
            let jitter = if nz > 0.0 { nz * gauss(&mut st.rng) } else { 0.0 };
            st.c[i][t] += v[t] + jitter;
        }
        let mut wx = w[0];
        let mut wy = w[1];
        let mut wz = w[2];
        if nz > 0.0 && !ball {
            wx += 1.5 * nz * gauss(&mut st.rng);
            wy += 1.5 * nz * gauss(&mut st.rng);
            wz += 1.5 * nz * gauss(&mut st.rng);
        }
        st.q[i] = rotq(st.q[i], wx, wy, wz);
    }
    if move_l {
        st.vl = beta * st.vl - 0.02 * g_l;
        if math::abs(st.vl) > cap {
            st.vl = math::sign(st.vl) * cap;
        }
        st.l += st.vl;
    }
    st.r = r0;
    st.step += 1;
    Ok(())
}

/// `sim.ts: lpTranslation`: smallest container (any translation) holding all given world vertices: min z s.t.
/// N_f.(x + t) <= z off_f. Dual of  min z s.t. N_f.t - off_f z <= -S_f :  max sum_f S_f lam_f  s.t. sum_f lam_f N_f
/// = 0, sum_f lam_f off_f = 1, lam >= 0 (4 equality rows). Two-phase tableau simplex with Bland's rule; the optimal
/// multipliers y of the 4 rows give the primal solution t = -y[0..2]. Only used to choose t: the reported size is
/// recomputed exactly at that t.
pub fn lp_translation(nn: &[Vec3], off: &[f64], s: &[f64]) -> Vec3 {
    let f_count = nn.len();
    let m = 4;
    let nc = f_count + m;
    let eps = 1e-12;
    let mut t: Vec<Vec<f64>> = (0..4)
        .map(|i| {
            let mut row = vec![0.0f64; nc + 1];
            for f in 0..f_count {
                row[f] = if i < 3 { nn[f][i] } else { off[f] };
            }
            row[f_count + i] = 1.0;
            row[nc] = if i == 3 { 1.0 } else { 0.0 };
            row
        })
        .collect();
    let mut basis = [f_count, f_count + 1, f_count + 2, f_count + 3];
    let mut run = |cost: &[f64], allow_art: bool| -> Vec<f64> {
        let mut rc = vec![0.0f64; nc];
        for j in 0..nc {
            let mut v = cost[j];
            for i in 0..m {
                v -= cost[basis[i]] * t[i][j];
            }
            rc[j] = v;
        }
        for _ in 0..500 {
            let mut e: isize = -1;
            for j in 0..nc {
                if rc[j] > eps && (allow_art || j < f_count) {
                    e = j as isize;
                    break;
                }
            }
            if e < 0 {
                return rc;
            }
            let e = e as usize;
            let mut r: isize = -1;
            let mut best = f64::INFINITY;
            for i in 0..m {
                if t[i][e] > eps {
                    let q = t[i][nc] / t[i][e];
                    if q < best - 1e-15 || (math::abs(q - best) <= 1e-15 && r >= 0 && basis[i] < basis[r as usize]) {
                        best = q;
                        r = i as isize;
                    }
                }
            }
            if r < 0 {
                return rc;
            }
            let r = r as usize;
            let pv = t[r][e];
            for j in 0..=nc {
                t[r][j] /= pv;
            }
            for i in 0..m {
                if i != r && t[i][e] != 0.0 {
                    let f = t[i][e];
                    for j in 0..=nc {
                        let tr = t[r][j];
                        t[i][j] -= f * tr;
                    }
                }
            }
            let f = rc[e];
            for j in 0..nc {
                rc[j] -= f * t[r][j];
            }
            basis[r] = e;
        }
        rc
    };
    let mut c1 = vec![0.0f64; nc];
    for v in c1.iter_mut().skip(f_count) {
        *v = -1.0;
    }
    run(&c1, true);
    let mut c2 = vec![0.0f64; nc];
    c2[..f_count].copy_from_slice(&s[..f_count]);
    let rc = run(&c2, false);
    [rc[f_count], rc[f_count + 1], rc[f_count + 2]]
}

/// `solve4` of `tightContainer`: Gauss-Jordan with partial pivoting on 4 rows of [M | b]; None when singular.
fn solve4(m: &[[f64; 4]; 4], b: &[f64; 4]) -> Option<[f64; 4]> {
    let mut a: [[f64; 5]; 4] = [[0.0; 5]; 4];
    for i in 0..4 {
        a[i][..4].copy_from_slice(&m[i]);
        a[i][4] = b[i];
    }
    for c in 0..4 {
        let mut p = c;
        for r in c + 1..4 {
            if math::abs(a[r][c]) > math::abs(a[p][c]) {
                p = r;
            }
        }
        if math::abs(a[p][c]) < 1e-12 {
            return None;
        }
        a.swap(c, p);
        for r in 0..4 {
            if r != c {
                let f = a[r][c] / a[c][c];
                for k in c..5 {
                    a[r][k] -= f * a[c][k];
                }
            }
        }
    }
    Some([a[0][4] / a[0][0], a[1][4] / a[1][1], a[2][4] / a[2][2], a[3][4] / a[3][3]])
}

/// `sim.ts: tightContainer`: the tight container size L over translations t of the given world vertex sets, and t.
pub fn tight_container(pb: &SimProblem, xs: &[Vec<f64>]) -> (f64, Vec3) {
    let nn = &pb.c.n;
    let f_count = nn.len();
    let off = &pb.off;
    let s: Vec<f64> = nn
        .iter()
        .map(|u| {
            let mut m = f64::NEG_INFINITY;
            for x in xs {
                let mut v = 0;
                while v < x.len() {
                    m = math::max(m, x[v] * u[0] + x[v + 1] * u[1] + x[v + 2] * u[2]);
                    v += 3;
                }
            }
            m
        })
        .collect();
    let z_at = |t: &[f64]| {
        let mut z = f64::NEG_INFINITY;
        for f in 0..f_count {
            z = math::max(z, (s[f] + dot(&nn[f], t)) / off[f]);
        }
        z
    };
    if f_count > 14 {
        let t = lp_translation(nn, off, &s);
        let tn = [-t[0], -t[1], -t[2]];
        let z1 = z_at(&t);
        let z2 = z_at(&tn);
        let z0 = z_at(&[0.0, 0.0, 0.0]);
        let tb = if z1 <= z2 && z1 <= z0 {
            t
        } else if z2 <= z0 {
            tn
        } else {
            [0.0, 0.0, 0.0]
        };
        return (2.0 * math::min(math::min(z0, z1), z2), tb);
    }
    let mut best: Option<(f64, Vec3)> = None;
    for a in 0..f_count {
        for b in a + 1..f_count {
            for c in b + 1..f_count {
                for d in c + 1..f_count {
                    let idx = [a, b, c, d];
                    let mut mm = [[0.0f64; 4]; 4];
                    let mut rhs = [0.0f64; 4];
                    for (r, &f) in idx.iter().enumerate() {
                        mm[r] = [nn[f][0], nn[f][1], nn[f][2], -off[f]];
                        rhs[r] = -s[f];
                    }
                    let Some(sol) = solve4(&mm, &rhs) else { continue };
                    let (t0, t1, t2, z) = (sol[0], sol[1], sol[2], sol[3]);
                    let mut ok = true;
                    for f in 0..f_count {
                        if s[f] + nn[f][0] * t0 + nn[f][1] * t1 + nn[f][2] * t2 > z * off[f] + 1e-9 * (1.0 + math::abs(z)) {
                            ok = false;
                            break;
                        }
                    }
                    if ok && best.is_none_or(|(bz, _)| z < bz) {
                        best = Some((z, [t0, t1, t2]));
                    }
                }
            }
        }
    }
    let t = best.map_or([0.0, 0.0, 0.0], |b| b.1);
    (2.0 * z_at(&t), t)
}

/// What `legalize` returns.
pub struct Legal {
    pub l: f64,
    pub s: f64,
    pub k: f64,
    pub c: Vec<Vec3>,
    pub q: Vec<[f64; 4]>,
}

/// `sim.ts: legalize`: scale centres apart about their mean until no pair of rigid pieces overlaps (SAT, tol
/// 1e-12), then measure the tight container.
pub fn legalize(pb: &SimProblem, c: &[Vec3], q: &[[f64; 4]], gate: &Gate) -> Result<Legal, Halt> {
    let n = c.len();
    let pp = &pb.p;
    let mut cen = [0.0f64; 3];
    for t in 0..3 {
        cen[t] = c.iter().fold(0.0, |a, cc| a + cc[t]) / n as f64;
    }
    let pos = |s: f64| -> Vec<Vec3> {
        c.iter().map(|cc| [cen[0] + s * (cc[0] - cen[0]), cen[1] + s * (cc[1] - cen[1]), cen[2] + s * (cc[2] - cen[2])]).collect()
    };
    let lim = (2.0 * pp.circ) * (2.0 * pp.circ);
    let ok = |s: f64| -> Result<bool, Halt> {
        gate.poll()?;
        let pos_s = pos(s);
        let ps: Vec<_> = pos_s.iter().enumerate().map(|(i, cc)| pose(pp, cc, &q[i], 1.0)).collect();
        for i in 0..n {
            for j in i + 1..n {
                let a = pos_s[i];
                let b = pos_s[j];
                if (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]) > lim {
                    continue;
                }
                if overlaps(&ps[i], &ps[j], 1e-12) {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    };
    let mut lo = 1.0;
    let mut hi = 1.0;
    if !ok(1.0)? {
        hi = 1.0001;
        while !ok(hi)? {
            hi = 1.0 + (hi - 1.0) * 2.0;
        }
        for _ in 0..60 {
            let m = (lo + hi) / 2.0;
            if ok(m)? {
                hi = m;
            } else {
                lo = m;
            }
        }
    }
    let pp_hi = pos(hi);
    let xs: Vec<Vec<f64>> = pp_hi.iter().enumerate().map(|(i, cc)| pose(pp, cc, &q[i], 1.0).x).collect();
    let (l, t) = tight_container(pb, &xs);
    Ok(Legal {
        l,
        s: pb.s_of_l(l),
        k: hi,
        c: pp_hi.iter().map(|p| [p[0] + t[0], p[1] + t[1], p[2] + t[2]]).collect(),
        q: q.to_vec(),
    })
}

/// `sim.ts: defaultL0`: initial container: balls (diameter 1) at packing fraction about 0.07, centres at least 0.7
/// inside every wall.
pub fn default_l0(pb: &SimProblem, n: usize) -> f64 {
    let vol_at_l = |l: f64| pb.c.volume * math::powi(pb.s_of_l(l), 3);
    let vp = std::f64::consts::PI / 6.0;
    let mut l = 2.0;
    while (n as f64 * vp) / vol_at_l(l) > 0.07 {
        l *= 1.02;
    }
    math::max(l, 2.0 * (0.7 + 0.35))
}

/// The packing a run or a hop returns: centres and unit quaternions in internal units, container size L, scale s.
pub struct SimResult {
    pub s: f64,
    pub l: f64,
    pub c: Vec<Vec3>,
    pub q: Vec<[f64; 4]>,
}

/// `sim.ts: run`, as `searchPolyhedra` calls it (mu 0.02, annealed): from random balls compress, morph balls into
/// solids, settle rigid, legalize. The schedule is `(compact, morph, settle)` steps.
pub fn run(pb: &SimProblem, seed: f64, n: usize, schedule: (f64, f64, f64), gate: &Gate) -> Result<SimResult, Halt> {
    let (compact, morph, settle) = schedule;
    let mu = 0.02;
    let l0 = default_l0(pb, n);
    let mut st = make_state(pb, n, seed, l0, gate)?;
    let r0 = 0.5;
    let mut k = 0.0;
    while k < compact {
        let u = k / compact;
        dynamics(&mut st, r0, mu * 3.0, 0.015 * (1.0 - u), true)?;
        k += 1.0;
    }
    let mut k = 0.0;
    while k < morph {
        let u = k / morph;
        dynamics(&mut st, r0 * (1.0 - u), mu, 0.004 * (1.0 - u), true)?;
        k += 1.0;
    }
    let mut k = 0.0;
    while k < settle {
        dynamics(&mut st, 0.0, mu * math::pow(1e-4, k / settle), 0.0, true)?;
        k += 1.0;
    }
    let leg = legalize(pb, &st.c, &st.q, gate)?;
    Ok(SimResult { s: leg.s, l: leg.l, c: leg.c, q: leg.q })
}

/// `sim.ts: arrangementChange`: relative-arrangement change between two states of the same pieces: RMS change of
/// the centre distances of all pairs that were neighbours (distance < 2 x circumradius) in either state, in units
/// of the piece edge.
pub fn arrangement_change(pb: &SimProblem, c0: &[Vec3], c1: &[Vec3], scale1: f64, focus: Option<&[bool]>) -> f64 {
    let n = c0.len();
    let r2 = (2.0 * pb.p.circ) * (2.0 * pb.p.circ);
    let mut sum = 0.0;
    let mut cnt = 0.0;
    for i in 0..n {
        for j in i + 1..n {
            if let Some(f) = focus {
                if !f[i] && !f[j] {
                    continue;
                }
            }
            let d0 = (c0[i][0] - c0[j][0]) * (c0[i][0] - c0[j][0])
                + (c0[i][1] - c0[j][1]) * (c0[i][1] - c0[j][1])
                + (c0[i][2] - c0[j][2]) * (c0[i][2] - c0[j][2]);
            let d1 = ((c1[i][0] - c1[j][0]) * (c1[i][0] - c1[j][0])
                + (c1[i][1] - c1[j][1]) * (c1[i][1] - c1[j][1])
                + (c1[i][2] - c1[j][2]) * (c1[i][2] - c1[j][2]))
                * scale1
                * scale1;
            if d0 > r2 && d1 > r2 {
                continue;
            }
            let dd = d1.sqrt() - d0.sqrt();
            sum += dd * dd;
            cnt += 1.0;
        }
    }
    if cnt != 0.0 {
        (sum / cnt).sqrt() / pb.p.edge
    } else {
        0.0
    }
}

/// The options of `sim.ts: HopConfig` that `searchPolyhedra` sets; the rest take the source's defaults (noise
/// 0.004, shake 400, mu 0.02, maxEsc 8).
pub struct HopConfig<'a> {
    /// Rigid packing in internal units, container centred at the origin, of size L.
    pub c: &'a [Vec3],
    pub q: &'a [[f64; 4]],
    pub l: f64,
    pub seed: f64,
    pub expand: f64,
    pub rh: f64,
    pub min_diff: f64,
    pub morph: f64,
    pub settle: f64,
    pub focus: usize,
}

/// `sim.ts: hop`: one hop from a rigid packing (C, Q, L), in internal units with the container centred at the
/// origin:
///  1. scale everything by (1 + expand);
///  2. soften the pieces to S_rh and shake them at fixed container size with noise until the relative arrangement
///     has changed by at least minDiff piece edges (escalating the noise and the softness each block), or maxEsc
///     blocks;
///  3. re-sharpen under pressure (r: rh -> 0 over `morph` steps), settle rigid pieces, legalize.
pub fn hop(pb: &SimProblem, cfg: &HopConfig, gate: &Gate) -> Result<SimResult, Halt> {
    let shake = 400;
    let mu = 0.02;
    let max_esc = 8;
    let mut rng = Rng::new(to_int32(cfg.seed * 7919.0 + 17.0) as f64);
    let n = cfg.c.len();
    let f = (1.0 + cfg.expand) * 1.0;
    let c: Vec<Vec3> = cfg.c.iter().map(|p| [p[0] * f, p[1] * f, p[2] * f]).collect();
    let q: Vec<[f64; 4]> = cfg.q.to_vec();
    let l = cfg.l * f;
    let reference: Vec<Vec3> = c.clone();
    let mut st = SimState {
        pb,
        n,
        rng: Rng(0),
        l,
        vl: 0.0,
        r: cfg.rh,
        step: 0,
        c,
        q,
        v: vec![[0.0; 3]; n],
        w: vec![[0.0; 3]; n],
        hints: vec![None; n * n],
        mask: None,
        sd: Sd::default(),
        gate,
    };
    let mut focus_set: Option<Vec<bool>> = None;
    if cfg.focus != 0 && cfg.focus < reference.len() {
        let i0 = math::floor(rng.next() * reference.len() as f64) as usize;
        let mut order: Vec<(f64, usize)> = reference
            .iter()
            .enumerate()
            .map(|(i, p)| {
                (
                    (p[0] - reference[i0][0]) * (p[0] - reference[i0][0])
                        + (p[1] - reference[i0][1]) * (p[1] - reference[i0][1])
                        + (p[2] - reference[i0][2]) * (p[2] - reference[i0][2]),
                    i,
                )
            })
            .collect();
        // `sort((a, b) => a[0] - b[0])`: stable, a NaN difference counts as equal
        order.sort_by(|a, b| {
            let d = a.0 - b.0;
            if d < 0.0 {
                std::cmp::Ordering::Less
            } else if d > 0.0 {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
        let mut fs = vec![false; n];
        for t in 0..cfg.focus {
            fs[order[t].1] = true;
        }
        st.mask = Some(fs.iter().map(|&x| if x { 1.0 } else { 0.15 }).collect());
        focus_set = Some(fs);
    }
    st.rng = rng;
    let mut noise = 0.004;
    let mut rh = cfg.rh;
    let mut esc = 0;
    loop {
        for _ in 0..shake {
            dynamics(&mut st, rh, 0.0, noise, false)?;
        }
        let diff = arrangement_change(pb, &reference, &st.c[..reference.len()], 1.0, focus_set.as_deref());
        if diff >= cfg.min_diff || esc >= max_esc {
            break;
        }
        esc += 1;
        noise *= 1.5;
        rh = math::min(0.4, rh * 1.3);
    }
    let noise0 = noise * 0.25;
    let mut k = 0.0;
    while k < cfg.morph {
        let u = k / cfg.morph;
        dynamics(&mut st, rh * (1.0 - u), mu, noise0 * (1.0 - u), true)?;
        k += 1.0;
    }
    let mut k = 0.0;
    while k < cfg.settle {
        dynamics(&mut st, 0.0, mu * math::pow(1e-4, k / cfg.settle), 0.0, true)?;
        k += 1.0;
    }
    let leg = legalize(pb, &st.c, &st.q, gate)?;
    Ok(SimResult { s: leg.s, l: leg.l, c: leg.c, q: leg.q })
}
