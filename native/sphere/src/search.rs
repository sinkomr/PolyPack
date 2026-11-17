//! Seeded local search for whole-sphere packings sphere/N/P. Source: packages/sphere/src/search.ts
//! (`searchSphere` and its helpers), ported line by line (native/PORTING.md).
//!
//! Work is done on the unit sphere with the piece's angular size a = 1/rho as the size variable.
//! Three parts, as in the source: penalty relaxation (L-BFGS on -a + mu E over one rotation vector
//! per piece and the size), the tight size (bisection with the float validator), and basin hopping
//! from the current packing. All randomness comes from `mulberry32(seed)`, so a run that ends on
//! its evaluation budget is reproducible from (problem, start, seed, max_evals) and gives the
//! TypeScript's packing bit for bit.
//!
//! What differs from the source, on purpose: the source throws `Stop` out of its inner loops, here
//! they return `Err(Stop)`; its `shouldStop` and `maxSeconds` are one poll of the job
//! (`AutoJob::should_stop`); no `log`.

use crate::geometry::{
    area_bound, circumradius_angle, norm, piece_angle, piece_exists, rho_for_angle, standard_vertices, Quat,
    SphereConfig, SpherePiece, SphereProblem, Vec3,
};
use crate::validate::{validation_steps, ValidateOptions};
use polypack_js::math;
use polypack_spaceauto::AutoJob;
use std::sync::atomic::Ordering;

/// Why a search ended (search.ts: `Stop`, thrown out of the inner loops).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    Evals,
    Time,
    Aborted,
}

/// search.ts: `mulberry32`, uniform draws in [0, 1). The source's 32-bit steps are `u32` wrapping
/// arithmetic.
pub struct Rng {
    a: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng { a: seed }
    }

    /// One draw.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

/// search.ts: `gauss`.
fn gauss(r: &mut Rng) -> f64 {
    let u = r.next();
    let left = math::sqrt(-2.0 * math::log(1.0 - u));
    let v = r.next();
    left * math::cos(2.0 * math::PI * v)
}

/// geometry.ts: `quatMul`.
pub fn quat_mul(p: &Quat, q: &Quat) -> Quat {
    let [w1, x1, y1, z1] = *p;
    let [w2, x2, y2, z2] = *q;
    [
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ]
}

/// geometry.ts: `unit` (`scale(a, 1 / norm(a))`).
fn unit(a: &Vec3) -> Vec3 {
    let s = 1.0 / norm(a);
    [a[0] * s, a[1] * s, a[2] * s]
}

/// geometry.ts: `quatFromCentreTheta`. G = T(c) R_z(theta) as a quaternion.
pub fn quat_from_centre_theta(c: &Vec3, theta: f64) -> Quat {
    let u = unit(c);
    let d = math::acos(math::max(-1.0, math::min(1.0, u[2])));
    let s = math::hypot(u[0], u[1]);
    let qt: Quat = if s < 1e-300 {
        if u[2] > 0.0 {
            [1.0, 0.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0, 0.0]
        }
    } else {
        [
            math::cos(d / 2.0),
            (math::sin(d / 2.0) * -u[1]) / s,
            (math::sin(d / 2.0) * u[0]) / s,
            0.0,
        ]
    };
    quat_mul(&qt, &[math::cos(theta / 2.0), 0.0, 0.0, math::sin(theta / 2.0)])
}

/// search.ts: `expQuat`. exp(w) as a unit quaternion: the rotation by |w| about w.
pub fn exp_quat(wx: f64, wy: f64, wz: f64) -> Quat {
    let t = math::hypot3(wx, wy, wz);
    if t < 1e-300 {
        return [1.0, 0.0, 0.0, 0.0];
    }
    let s = math::sin(t / 2.0) / t;
    [math::cos(t / 2.0), wx * s, wy * s, wz * s]
}

/// search.ts: `normalized`.
pub fn normalized(q: &Quat) -> Quat {
    let n = math::hypot4(q[0], q[1], q[2], q[3]);
    [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/// search.ts: `randomQuat`. Uniformly random rotation (Shoemake).
pub fn random_quat(r: &mut Rng) -> Quat {
    let u1 = r.next();
    let u2 = 2.0 * math::PI * r.next();
    let u3 = 2.0 * math::PI * r.next();
    let a = math::sqrt(1.0 - u1);
    let b = math::sqrt(u1);
    [
        a * math::sin(u2),
        a * math::cos(u2),
        b * math::sin(u3),
        b * math::cos(u3),
    ]
}

/// search.ts: `matrixInto`. Rotation matrix of a unit quaternion, row-major.
#[inline]
fn matrix_of(q: &Quat) -> [f64; 9] {
    let [w, x, y, z] = *q;
    let n = w * w + x * x + y * y + z * z;
    [
        (w * w + x * x - y * y - z * z) / n,
        (2.0 * (x * y - w * z)) / n,
        (2.0 * (x * z + w * y)) / n,
        (2.0 * (x * y + w * z)) / n,
        (w * w - x * x + y * y - z * z) / n,
        (2.0 * (y * z - w * x)) / n,
        (2.0 * (x * z - w * y)) / n,
        (2.0 * (y * z + w * x)) / n,
        (w * w - x * x - y * y + z * z) / n,
    ]
}

/// The budget of one run: search.ts's `tick`, called once per evaluation.
pub struct Ticker<'a> {
    pub evaluations: u64,
    pub max_evals: u64,
    pub job: Option<&'a AutoJob<'a>>,
}

impl Ticker<'_> {
    /// search.ts: `tick`. Counts one evaluation; `Err` when the budget is spent or the job stops.
    #[inline]
    pub fn tick(&mut self) -> Result<(), Stop> {
        self.evaluations += 1;
        if self.evaluations > self.max_evals {
            return Err(Stop::Evals);
        }
        if let Some(job) = self.job {
            if job.stop.load(Ordering::Relaxed) {
                return Err(Stop::Aborted);
            }
            if job.should_stop() {
                return Err(Stop::Time);
            }
        }
        Ok(())
    }
}

/// search.ts: `lbfgs`. Minimal L-BFGS with a backtracking (Armijo) line search. `f` returns the
/// value and writes the gradient into `g`; `tick` is called once per evaluation.
fn lbfgs(
    f: &mut dyn FnMut(&[f64], &mut [f64]) -> f64,
    x0: &[f64],
    max_iter: usize,
    tick: &mut Ticker,
) -> Result<Vec<f64>, Stop> {
    let n = x0.len();
    let m = 8usize;
    let mut x = x0.to_vec();
    let mut g = vec![0.0; n];
    tick.tick()?;
    let mut fx = f(&x, &mut g);
    let mut s_list: Vec<Vec<f64>> = Vec::new();
    let mut y_list: Vec<Vec<f64>> = Vec::new();
    let mut rhos: Vec<f64> = Vec::new();
    let mut d = vec![0.0; n];
    let mut alpha = vec![0.0; m + 1];
    let mut xn = vec![0.0; n];
    let mut gn = vec![0.0; n];
    for _ in 0..max_iter {
        let mut gg = 0.0;
        for k in 0..n {
            gg += g[k] * g[k];
        }
        if !(gg > 1e-30) {
            break;
        }
        // two-loop recursion
        for k in 0..n {
            d[k] = -g[k];
        }
        for j in (0..s_list.len()).rev() {
            let mut a = 0.0;
            for k in 0..n {
                a += s_list[j][k] * d[k];
            }
            a *= rhos[j];
            alpha[j] = a;
            for k in 0..n {
                d[k] -= a * y_list[j][k];
            }
        }
        if !s_list.is_empty() {
            let j = s_list.len() - 1;
            let mut sy = 0.0;
            let mut yy = 0.0;
            for k in 0..n {
                sy += s_list[j][k] * y_list[j][k];
                yy += y_list[j][k] * y_list[j][k];
            }
            let gamma = sy / yy;
            for k in 0..n {
                d[k] *= gamma;
            }
        } else {
            // first step: at most 1e-3 radians along the gradient
            let scale = 1e-3 / math::sqrt(gg);
            for k in 0..n {
                d[k] *= scale;
            }
        }
        for j in 0..s_list.len() {
            let mut b = 0.0;
            for k in 0..n {
                b += y_list[j][k] * d[k];
            }
            b *= rhos[j];
            for k in 0..n {
                d[k] += s_list[j][k] * (alpha[j] - b);
            }
        }
        let mut slope = 0.0;
        for k in 0..n {
            slope += g[k] * d[k];
        }
        if !(slope < 0.0) {
            // not a descent direction: restart from steepest descent
            s_list.clear();
            y_list.clear();
            rhos.clear();
            continue;
        }
        let mut t = 1.0;
        let mut fnv = f64::INFINITY;
        for _ in 0..30 {
            for k in 0..n {
                xn[k] = x[k] + t * d[k];
            }
            tick.tick()?;
            fnv = f(&xn, &mut gn);
            if fnv <= fx + 1e-4 * t * slope {
                break;
            }
            t *= 0.3;
        }
        if !(fnv < fx) {
            break;
        }
        let mut s = vec![0.0; n];
        let mut y = vec![0.0; n];
        let mut sy = 0.0;
        for k in 0..n {
            s[k] = xn[k] - x[k];
            y[k] = gn[k] - g[k];
            sy += s[k] * y[k];
        }
        if sy > 1e-30 {
            s_list.push(s);
            y_list.push(y);
            rhos.push(1.0 / sy);
            if s_list.len() > m {
                s_list.remove(0);
                y_list.remove(0);
                rhos.remove(0);
            }
        }
        let rel = (fx - fnv) / math::max(1e-300, fx.abs());
        std::mem::swap(&mut x, &mut xn);
        std::mem::swap(&mut g, &mut gn);
        fx = fnv;
        if rel < 1e-15 {
            break;
        }
    }
    Ok(x)
}

/// search.ts: `maxAngle`. Largest admissible angular size: the piece must exist (and two disks
/// must fit).
pub fn max_angle(n: f64, p: f64) -> f64 {
    if n == 0.0 {
        return if p >= 2.0 { math::PI / 2.0 } else { math::PI };
    }
    ((2.0 * math::PI) / n) * (1.0 - 1e-9)
}

/// search.ts: `tightRho`. The tight size of fixed poses: the smallest rho at which they are valid
/// by the float validator at tolerance 0 (every gap >= 0), by bisection to 1e-13 relative from
/// rho0; `None` when no valid rho is found within a factor of about 14 above rho0.
pub fn tight_rho(problem: &SphereProblem, q: &[Quat], rho0: f64, tick: &mut Ticker) -> Result<Option<f64>, Stop> {
    let (n, p) = (problem.n, problem.p);
    let a_max = max_angle(n, p);
    let mut config = SphereConfig {
        rho: rho0,
        pieces: q.iter().map(|x| SpherePiece { q: x.to_vec() }).collect(),
    };
    let opts = ValidateOptions {
        tol: Some(0.0),
        max_errors: Some(1.0),
    };
    // valid with every gap >= 0 at rho
    let mut valid_at = |rho: f64| -> Result<bool, Stop> {
        tick.tick()?;
        if !(piece_angle(n, rho) < a_max) || !piece_exists(n, rho) {
            return Ok(false);
        }
        config.rho = rho;
        // the first overlap decides (maxErrors 1): the answer is the full check's
        let v = validation_steps(problem, &config, &opts);
        Ok(v.errors.is_empty() && v.min_gap >= 0.0)
    };
    tight_size(&mut valid_at, rho0, rho_for_angle(n, a_max))
}

/// search.ts: `tightSize`. The bisection of `tight_rho` for any test of validity that is monotone
/// in rho: from rho0 (raised to just above `floor`), up by steps of 1e-3, 2e-3, ... until valid or
/// down by such steps until invalid, then bisection to 1e-13 relative.
pub fn tight_size(
    valid_at: &mut dyn FnMut(f64) -> Result<bool, Stop>,
    rho0: f64,
    floor: f64,
) -> Result<Option<f64>, Stop> {
    fn bisect(valid_at: &mut dyn FnMut(f64) -> Result<bool, Stop>, mut lo: f64, mut hi: f64) -> Result<f64, Stop> {
        while hi - lo > 1e-13 * hi {
            let mid = 0.5 * (lo + hi);
            if valid_at(mid)? {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        Ok(hi)
    }
    let mut hi = math::max(rho0, floor * (1.0 + 1e-12));
    let mut step = 1e-3;
    if !valid_at(hi)? {
        let mut lo = hi;
        loop {
            if step > 4.0 {
                return Ok(None);
            }
            hi = lo * (1.0 + step);
            if valid_at(hi)? {
                break;
            }
            lo = hi;
            step *= 2.0;
        }
        return Ok(Some(bisect(valid_at, lo, hi)?));
    }
    let lo;
    loop {
        let next = math::max(floor * (1.0 + 1e-12), hi * (1.0 - step));
        if next >= hi {
            return Ok(Some(hi));
        }
        if !valid_at(next)? {
            lo = next;
            break;
        }
        hi = next;
        step = math::min(0.5, step * 2.0);
    }
    Ok(Some(bisect(valid_at, lo, hi)?))
}

/// Places a piece with pose q into (c, v, e): centre, vertices and unit edge normals (search.ts:
/// `Model.place`).
fn place(n: usize, std_v: &[f64], q: &Quat, c: &mut [f64], v: &mut [f64], e: &mut [f64]) {
    let m = matrix_of(q);
    c[0] = m[2];
    c[1] = m[5];
    c[2] = m[8];
    if n == 0 {
        return;
    }
    for k in 0..n {
        let x = std_v[3 * k];
        let y = std_v[3 * k + 1];
        let z = std_v[3 * k + 2];
        v[3 * k] = m[0] * x + m[1] * y + m[2] * z;
        v[3 * k + 1] = m[3] * x + m[4] * y + m[5] * z;
        v[3 * k + 2] = m[6] * x + m[7] * y + m[8] * z;
    }
    for k in 0..n {
        let j = (k + 1) % n;
        // a_k x a_{k+1} points into the piece for counter-clockwise vertices (seen from outside)
        let ax = v[3 * k];
        let ay = v[3 * k + 1];
        let az = v[3 * k + 2];
        let bx = v[3 * j];
        let by = v[3 * j + 1];
        let bz = v[3 * j + 2];
        let mut nx = ay * bz - az * by;
        let mut ny = az * bx - ax * bz;
        let mut nz = ax * by - ay * bx;
        let len = math::hypot3(nx, ny, nz);
        nx /= len;
        ny /= len;
        nz /= len;
        e[3 * k] = nx;
        e[3 * k + 1] = ny;
        e[3 * k + 2] = nz;
    }
}

/// search.ts: `Model`. The near-pair energy model at fixed base poses. Pieces carry their placed
/// vertices and the unit normals of their edge planes (pointing into the piece), or only their
/// centre for disks.
pub struct Model {
    n: usize,
    p: usize,
    /// base quaternions, unit
    pub base: Vec<Quat>,
    /// neighbour lists over the near pairs (both directions)
    nbrs: Vec<Vec<usize>>,
    /// per piece, the index in `pairs` of each entry of nbrs
    nbr_pair: Vec<Vec<usize>>,
    pairs: Vec<(usize, usize)>,
    /// Per pair, set by `total(LIVE_SLACK)`: 0 when an edge separates the placed pieces by at least
    /// LIVE_SLACK (disks: their chord exceeds the touching chord by that much); `local` skips it.
    live: Vec<u8>,
    /// per piece: centre (3), vertices (3k), edge normals (3k), k = max(1, N)
    c: Vec<f64>,
    v: Vec<f64>,
    e: Vec<f64>,
    k: usize,
    std_v: Vec<f64>,
    a: f64,
    /// 2 sin(a), the chord two touching disks need; set with a.
    chord2: f64,
    tmp_c: [f64; 3],
    tmp_v: Vec<f64>,
    tmp_e: Vec<f64>,
}

impl Model {
    pub fn new(n: usize, base: &[Quat]) -> Model {
        let k = std::cmp::max(1, n);
        let p = base.len();
        Model {
            n,
            p,
            base: base.iter().map(normalized).collect(),
            nbrs: Vec::new(),
            nbr_pair: Vec::new(),
            pairs: Vec::new(),
            live: Vec::new(),
            c: vec![0.0; 3 * p],
            v: vec![0.0; 3 * k * p],
            e: vec![0.0; 3 * k * p],
            k,
            std_v: vec![0.0; 3 * k],
            a: f64::NAN,
            chord2: f64::NAN,
            tmp_c: [0.0; 3],
            tmp_v: vec![0.0; 3 * k],
            tmp_e: vec![0.0; 3 * k],
        }
    }

    /// Sets the standard piece for angular size a.
    pub fn set_size(&mut self, a: f64) {
        if a == self.a {
            return;
        }
        self.a = a;
        self.chord2 = 2.0 * math::sin(a);
        if self.n == 0 {
            return;
        }
        let r = circumradius_angle(self.n as f64, 1.0 / a);
        let sv = standard_vertices(self.n, r);
        for k in 0..self.n {
            self.std_v[3 * k] = sv[k][0];
            self.std_v[3 * k + 1] = sv[k][1];
            self.std_v[3 * k + 2] = sv[k][2];
        }
    }

    /// `Model.pose`: the pose of piece i for rotation vector w.
    pub fn pose(&self, i: usize, wx: f64, wy: f64, wz: f64) -> Quat {
        quat_mul(&exp_quat(wx, wy, wz), &self.base[i])
    }

    /// `Model.poseInto`: `pose` without allocating, the same numbers.
    #[inline]
    pub fn pose_into(&self, i: usize, wx: f64, wy: f64, wz: f64, out: &mut Quat) {
        // expQuat
        let t = math::hypot3(wx, wy, wz);
        let mut w1 = 1.0;
        let mut x1 = 0.0;
        let mut y1 = 0.0;
        let mut z1 = 0.0;
        if !(t < 1e-300) {
            let s = math::sin(t / 2.0) / t;
            w1 = math::cos(t / 2.0);
            x1 = wx * s;
            y1 = wy * s;
            z1 = wz * s;
        }
        // quatMul(exp(w), base)
        let [w2, x2, y2, z2] = self.base[i];
        out[0] = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2;
        out[1] = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2;
        out[2] = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2;
        out[3] = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2;
    }

    pub fn place_all(&mut self, x: &[f64]) {
        let mut q: Quat = [1.0, 0.0, 0.0, 0.0];
        let k3 = 3 * self.k;
        for i in 0..self.p {
            self.pose_into(i, x[3 * i], x[3 * i + 1], x[3 * i + 2], &mut q);
            place(
                self.n,
                &self.std_v,
                &q,
                &mut self.c[3 * i..3 * i + 3],
                &mut self.v[k3 * i..k3 * (i + 1)],
                &mut self.e[k3 * i..k3 * (i + 1)],
            );
        }
    }

    /// Near pairs at angular size a_max: centre angle below 2R + slack.
    pub fn refresh_pairs(&mut self, a_max: f64) {
        let r = if self.n == 0 {
            a_max
        } else {
            circumradius_angle(self.n as f64, 1.0 / a_max)
        };
        let reach = math::min(math::PI, 2.0 * r + 0.5 * r + 0.05);
        let cos_reach = math::cos(reach);
        self.pairs = Vec::new();
        self.nbrs = vec![Vec::new(); self.p];
        self.nbr_pair = vec![Vec::new(); self.p];
        for i in 0..self.p {
            for j in i + 1..self.p {
                let ci = &self.c[3 * i..3 * i + 3];
                let cj = &self.c[3 * j..3 * j + 3];
                if ci[0] * cj[0] + ci[1] * cj[1] + ci[2] * cj[2] > cos_reach {
                    self.nbr_pair[i].push(self.pairs.len());
                    self.nbr_pair[j].push(self.pairs.len());
                    self.pairs.push((i, j));
                    self.nbrs[i].push(j);
                    self.nbrs[j].push(i);
                }
            }
        }
    }

    /// `Model.overlap`: overlap of two placed pieces when they overlap (positive); a value <= 0
    /// otherwise, which the energy ignores. For polygons the separating-edge value is the largest,
    /// over the edges, of the smallest distance of the other piece's vertices beyond the edge; both
    /// early exits leave every result above -enough unchanged, bit for bit.
    #[allow(clippy::too_many_arguments)]
    #[inline]
    fn overlap(
        n: usize,
        chord2: f64,
        ca: &[f64],
        va: &[f64],
        ea: &[f64],
        cb: &[f64],
        vb: &[f64],
        eb: &[f64],
        enough: f64,
    ) -> f64 {
        if n == 0 {
            let chord = math::hypot3(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
            return chord2 - chord;
        }
        let mut sat = f64::NEG_INFINITY;
        for pass in 0..2 {
            let e = if pass == 0 { ea } else { eb };
            let w = if pass == 0 { vb } else { va };
            for k in 0..n {
                let nx = e[3 * k];
                let ny = e[3 * k + 1];
                let nz = e[3 * k + 2];
                let mut lo = f64::INFINITY;
                for l in 0..n {
                    // sine distance of the vertex beyond the edge great circle (positive outside)
                    let d = -(nx * w[3 * l] + ny * w[3 * l + 1] + nz * w[3 * l + 2]);
                    if d < lo {
                        lo = d;
                        if lo <= sat {
                            break;
                        }
                    }
                }
                if lo > sat {
                    sat = lo;
                    if sat >= enough {
                        return -sat;
                    }
                }
            }
        }
        -sat
    }

    /// `Model.total`: the energy of the placed pieces; with `slack` > 0 it also marks the live
    /// pairs. With `skip_dead` it leaves out the pairs that were not live.
    pub fn total(&mut self, slack: f64, skip_dead: bool) -> f64 {
        let mut energy = 0.0;
        if slack > 0.0 && self.live.len() < self.pairs.len() {
            self.live = vec![0; self.pairs.len()];
        }
        let k3 = 3 * self.k;
        for p in 0..self.pairs.len() {
            if skip_dead && self.live[p] == 0 {
                continue;
            }
            let (i, j) = self.pairs[p];
            let o = Self::overlap(
                self.n,
                self.chord2,
                &self.c[3 * i..3 * i + 3],
                &self.v[k3 * i..k3 * (i + 1)],
                &self.e[k3 * i..k3 * (i + 1)],
                &self.c[3 * j..3 * j + 3],
                &self.v[k3 * j..k3 * (j + 1)],
                &self.e[k3 * j..k3 * (j + 1)],
                slack,
            );
            if slack > 0.0 {
                self.live[p] = if o > -slack { 1 } else { 0 };
            }
            if o > 0.0 {
                energy += o * o;
            }
        }
        energy
    }

    /// `Model.hasLive`: true when piece i has a live pair (as last marked by total(slack)).
    pub fn has_live(&self, i: usize) -> bool {
        for &p in &self.nbr_pair[i] {
            if self.live[p] != 0 {
                return true;
            }
        }
        false
    }

    /// `Model.local`: energy of piece i's pairs with piece i at pose q (the others as placed), over
    /// its live pairs as last marked by total(slack).
    pub fn local(&mut self, i: usize, q: &Quat) -> f64 {
        place(
            self.n,
            &self.std_v,
            q,
            &mut self.tmp_c,
            &mut self.tmp_v,
            &mut self.tmp_e,
        );
        let mut energy = 0.0;
        let k3 = 3 * self.k;
        let nb = &self.nbrs[i];
        let np = &self.nbr_pair[i];
        for t in 0..nb.len() {
            if self.live[np[t]] == 0 {
                continue;
            }
            let j = nb[t];
            let o = Self::overlap(
                self.n,
                self.chord2,
                &self.tmp_c,
                &self.tmp_v,
                &self.tmp_e,
                &self.c[3 * j..3 * j + 3],
                &self.v[k3 * j..k3 * (j + 1)],
                &self.e[k3 * j..k3 * (j + 1)],
                0.0,
            );
            if o > 0.0 {
                energy += o * o;
            }
        }
        energy
    }
}

/// search.ts: `spiralStart`. P poses whose centres are the Fibonacci spiral on the sphere, all
/// turned by the rotation `turn`.
pub fn spiral_start(p: usize, turn: &Quat) -> Vec<Quat> {
    let golden = math::PI * (3.0 - math::sqrt(5.0));
    let mut out = Vec::with_capacity(p);
    for i in 0..p {
        let z = 1.0 - (2.0 * (i as f64 + 0.5)) / p as f64;
        let r = math::sqrt(math::max(0.0, 1.0 - z * z));
        let a = golden * i as f64;
        out.push(normalized(&quat_mul(
            turn,
            &quat_from_centre_theta(&[r * math::cos(a), r * math::sin(a), z], 0.0),
        )));
    }
    out
}

/// Separation beyond which a pair is left out of the gradient's local energies (`Model.live`).
const LIVE_SLACK: f64 = 1e-6;

const FRESH_MUS: [f64; 7] = [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
const START_MUS: [f64; 5] = [1e4, 1e5, 1e6, 1e7, 1e8];

/// search.ts: `inradiusAngle`. Angular inradius r: tan(a/2) = sin r tan(pi/N).
pub fn inradius_angle(n: f64, rho: f64) -> f64 {
    let a = piece_angle(n, rho);
    if n == 0.0 {
        return a;
    }
    math::asin(math::tan(a / 2.0) / math::tan(math::PI / n))
}

/// Search state: the poses and the tight rho of a valid packing.
#[derive(Clone, Debug)]
pub struct Packing {
    pub q: Vec<Quat>,
    pub rho: f64,
}

/// The options of `searchSphere` that an `AutoJob` has.
pub struct SearchOptions<'a> {
    pub seed: u32,
    /// Packing to start from (any rho; an invalid one is first enlarged until it is valid).
    pub start: Option<&'a SphereConfig>,
    /// Most objective and gradient evaluations (the source's default is 20,000).
    pub max_evals: u64,
    /// The job whose `should_stop` is polled at every evaluation.
    pub job: Option<&'a AutoJob<'a>>,
}

/// search.ts: `SphereSearchResult`.
#[derive(Clone, Debug)]
pub struct SearchResult {
    /// The best packing found, valid with every gap >= 0, or `None`.
    pub config: Option<Packing>,
    /// Its rho (Infinity when there is none).
    pub score: f64,
    pub start_score: Option<f64>,
    pub evaluations: u64,
    pub hops: u64,
    pub stopped: Stop,
}

struct Search<'a> {
    problem: SphereProblem,
    n: usize,
    p: usize,
    a_max: f64,
    rand: Rng,
    t: Ticker<'a>,
    best: Option<Packing>,
    start_score: Option<f64>,
    hops: u64,
}

impl Search<'_> {
    fn tight(&mut self, q: &[Quat], rho0: f64) -> Result<Option<f64>, Stop> {
        tight_rho(&self.problem, q, rho0, &mut self.t)
    }

    /// Penalty continuation from poses q at angular size a0; returns the relaxed poses and size.
    fn relax(&mut self, q: &[Quat], a0: f64, mus: &[f64]) -> Result<(Vec<Quat>, f64), Stop> {
        let (n, p, a_max) = (self.n, self.p, self.a_max);
        let nf = n as f64;
        let mut model = Model::new(n, q);
        let mut x = vec![0.0; 3 * p + 1];
        x[3 * p] = math::min(a0, a_max * (1.0 - 1e-6));
        let mut cur_q: Vec<Quat> = model.base.clone();
        let mut cur_a = x[3 * p];
        let h = 1e-7;
        for &mu in mus {
            for _round in 0..3 {
                // a new base at the current poses keeps the rotation vectors small
                model.base = cur_q.iter().map(normalized).collect();
                x.fill(0.0);
                x[3 * p] = cur_a;
                model.set_size(cur_a);
                model.place_all(&x);
                model.refresh_pairs(math::min(a_max, cur_a * 1.05));
                let z = {
                    let mut f = |z: &[f64], g: &mut [f64]| -> f64 {
                        let a = z[3 * p];
                        if !(a > 0.0 && a < a_max) {
                            g.fill(0.0);
                            return f64::INFINITY;
                        }
                        model.set_size(a);
                        model.place_all(z);
                        let energy = model.total(LIVE_SLACK, false);
                        let mut q: Quat = [1.0, 0.0, 0.0, 0.0];
                        for i in 0..p {
                            // no live pair: every local energy below is 0, and so is the gradient
                            if !model.has_live(i) {
                                g[3 * i] = 0.0;
                                g[3 * i + 1] = 0.0;
                                g[3 * i + 2] = 0.0;
                                continue;
                            }
                            for c in 0..3 {
                                let w0 = z[3 * i];
                                let w1 = z[3 * i + 1];
                                let w2 = z[3 * i + 2];
                                // the steps +h and then -2h of the coordinate c
                                let up = (if c == 0 {
                                    w0
                                } else if c == 1 {
                                    w1
                                } else {
                                    w2
                                }) + h;
                                let down = up - 2.0 * h;
                                model.pose_into(
                                    i,
                                    if c == 0 { up } else { w0 },
                                    if c == 1 { up } else { w1 },
                                    if c == 2 { up } else { w2 },
                                    &mut q,
                                );
                                let ep = model.local(i, &q);
                                model.pose_into(
                                    i,
                                    if c == 0 { down } else { w0 },
                                    if c == 1 { down } else { w1 },
                                    if c == 2 { down } else { w2 },
                                    &mut q,
                                );
                                let em = model.local(i, &q);
                                g[3 * i + c] = (mu * (ep - em)) / (2.0 * h);
                            }
                        }
                        let ha = 1e-9 * a;
                        let mut ep = f64::INFINITY;
                        // the pairs that are not live stay separated in the size steps when the
                        // steps move every point by much less than LIVE_SLACK (see the source)
                        let mut skip_dead = true;
                        if n != 0 {
                            let r0 = circumradius_angle(nf, 1.0 / a);
                            let i0 = inradius_angle(nf, 1.0 / a);
                            let am = a - ha;
                            let ap = math::min(a + ha, a_max);
                            let mv = math::max_of(&[
                                (circumradius_angle(nf, 1.0 / ap) - r0).abs(),
                                (circumradius_angle(nf, 1.0 / am) - r0).abs(),
                                (inradius_angle(nf, 1.0 / ap) - i0).abs(),
                                (inradius_angle(nf, 1.0 / am) - i0).abs(),
                            ]);
                            skip_dead = 4.0 * mv + 1e-12 < 0.5 * LIVE_SLACK;
                        }
                        // disks are placed by their centres alone, which do not depend on a
                        if a + ha < a_max {
                            model.set_size(a + ha);
                            if n != 0 {
                                model.place_all(z);
                            }
                            ep = model.total(0.0, skip_dead);
                        }
                        model.set_size(a - ha);
                        if n != 0 {
                            model.place_all(z);
                        }
                        let em = model.total(0.0, skip_dead);
                        model.set_size(a);
                        if n != 0 {
                            model.place_all(z);
                        }
                        g[3 * p] = -1.0
                            + if ep.is_finite() {
                                (mu * (ep - em)) / (2.0 * ha)
                            } else {
                                (mu * (energy - em)) / ha
                            };
                        -a + mu * energy
                    };
                    lbfgs(&mut f, &x, 150, &mut self.t)?
                };
                cur_q = (0..p)
                    .map(|i| normalized(&model.pose(i, z[3 * i], z[3 * i + 1], z[3 * i + 2])))
                    .collect();
                cur_a = math::min(z[3 * p], a_max * (1.0 - 1e-9));
            }
        }
        Ok((cur_q, cur_a))
    }

    /// Relax, then the tight size; `None` when no valid size was found near the relaxed one.
    fn local(&mut self, q: &[Quat], a0: f64, mus: &[f64]) -> Result<Option<Packing>, Stop> {
        let (rq, ra) = self.relax(q, a0, mus)?;
        let rho = self.tight(&rq, rho_for_angle(self.problem.n, ra))?;
        Ok(rho.map(|rho| Packing { q: rq, rho }))
    }

    fn random_start(&mut self, fresh_angle: f64) -> Result<Option<Packing>, Stop> {
        let q: Vec<Quat> = (0..self.p).map(|_| random_quat(&mut self.rand)).collect();
        self.local(&q, fresh_angle, &FRESH_MUS)
    }

    fn perturb(&mut self, pk: &Packing) -> Vec<Quat> {
        let (n, p) = (self.n, self.p);
        let mut q = pk.q.clone();
        let a = piece_angle(n as f64, pk.rho);
        let rand = &mut self.rand;
        let kind = rand.next();
        if kind < 0.4 {
            let sigma = (0.05 + 0.15 * rand.next()) * a;
            for qi in q.iter_mut() {
                let wx = sigma * gauss(rand);
                let wy = sigma * gauss(rand);
                let wz = sigma * gauss(rand);
                *qi = normalized(&quat_mul(&exp_quat(wx, wy, wz), &*qi));
            }
        } else if kind < 0.75 || n == 0 {
            let k = 1.0 + math::floor(rand.next() * math::min(3.0, math::max(1.0, math::floor(p as f64 / 4.0))));
            let mut t = 0.0;
            while t < k {
                let idx = math::floor(rand.next() * p as f64) as usize;
                q[idx] = random_quat(rand);
                t += 1.0;
            }
        } else {
            let k = math::max(1.0, math::floor(p as f64 / 4.0));
            let mut t = 0.0;
            while t < k {
                let i = math::floor(rand.next() * p as f64) as usize;
                // a rotation about the piece's own centre spins it in place
                let m = matrix_of(&q[i]);
                let phi = (rand.next() - 0.5) * ((2.0 * math::PI) / n as f64);
                q[i] = normalized(&quat_mul(&exp_quat(phi * m[2], phi * m[5], phi * m[8]), &q[i]));
                t += 1.0;
            }
        }
        q
    }

    /// The body of `searchSphere`'s try block; `self.best` and `self.hops` keep what was found
    /// when it returns `Err(Stop)`. It returns only by a `Stop`.
    fn run(&mut self, start: Option<&SphereConfig>) -> Stop {
        match self.run_inner(start) {
            Err(e) => e,
            Ok(never) => match never {},
        }
    }

    fn run_inner(&mut self, start: Option<&SphereConfig>) -> Result<std::convert::Infallible, Stop> {
        let (n, p) = (self.problem.n, self.p);
        let fresh_angle = 0.7
            / (if n == 0.0 {
                2.0 * area_bound(n, p as f64)
            } else {
                area_bound(n, p as f64)
            });
        if let Some(st) = start {
            if st.pieces.len() == p && st.rho > 0.0 && st.pieces.iter().all(|pc| pc.q.len() == 4) {
                let q: Vec<Quat> = st
                    .pieces
                    .iter()
                    .map(|pc| normalized(&[pc.q[0], pc.q[1], pc.q[2], pc.q[3]]))
                    .collect();
                let rho = self.tight(&q, st.rho)?;
                if let Some(rho) = rho {
                    self.best = Some(Packing { q: q.clone(), rho });
                    self.start_score = Some(rho);
                }
                let (lq, la) = match &self.best {
                    Some(b) => (b.q.clone(), piece_angle(n, b.rho)),
                    None => (q, piece_angle(n, st.rho)),
                };
                let r = self.local(&lq, la, &START_MUS)?;
                if let Some(r) = r {
                    if self.best.as_ref().map_or(true, |b| r.rho < b.rho) {
                        self.best = Some(r);
                    }
                }
            }
        }
        if self.best.is_none() && n == 0.0 {
            // disks start from the Fibonacci spiral, turned at random (see the source's comment)
            let turn = random_quat(&mut self.rand);
            let q = spiral_start(p, &turn);
            let rho = self.tight(&q, rho_for_angle(n, fresh_angle))?;
            if let Some(rho) = rho {
                self.best = Some(Packing { q: q.clone(), rho });
            }
            let r = self.local(&q, fresh_angle, &FRESH_MUS)?;
            if let Some(r) = r {
                if self.best.as_ref().map_or(true, |b| r.rho < b.rho) {
                    self.best = Some(r);
                }
            }
        }
        while self.best.is_none() {
            self.best = self.random_start(fresh_angle)?;
        }
        let mut cur = self.best.clone().unwrap();
        let mut misses = 0;
        loop {
            self.hops += 1;
            let q = self.perturb(&cur);
            let r = self.local(&q, piece_angle(n, cur.rho) * 0.99, &FRESH_MUS)?;
            let Some(r) = r else { continue };
            if r.rho < self.best.as_ref().unwrap().rho * (1.0 - 1e-13) {
                self.best = Some(r.clone());
            }
            if r.rho < cur.rho * (1.0 - 1e-13) || self.rand.next() < math::exp(-(r.rho / cur.rho - 1.0) / 1e-3) {
                cur = r;
                misses = 0;
            } else {
                misses += 1;
                if misses >= 10 {
                    cur = self.best.clone().unwrap();
                    misses = 0;
                }
            }
        }
    }
}

/// search.ts: `searchSphere`. `Err` for a problem that is not one ("bad sphere problem").
pub fn search_sphere<'a>(problem: &SphereProblem, o: &SearchOptions<'a>) -> Result<SearchResult, String> {
    let (n, p) = (problem.n, problem.p);
    let is_integer = |v: f64| v.is_finite() && v == v.trunc();
    if !(n == 0.0 || (is_integer(n) && n >= 3.0 && n <= 100.0)) || !is_integer(p) || p < 1.0 || p > 100.0 {
        return Err("bad sphere problem".to_string());
    }
    let mut s = Search {
        problem: *problem,
        n: n as usize,
        p: p as usize,
        a_max: max_angle(n, p),
        rand: Rng::new(o.seed),
        t: Ticker {
            evaluations: 0,
            max_evals: o.max_evals,
            job: o.job,
        },
        best: None,
        start_score: None,
        hops: 0,
    };
    let stopped = s.run(o.start);
    let score = s.best.as_ref().map_or(f64::INFINITY, |b| b.rho);
    Ok(SearchResult {
        config: s.best,
        score,
        start_score: s.start_score,
        evaluations: std::cmp::min(s.t.evaluations, o.max_evals),
        hops: s.hops,
        stopped,
    })
}

#[cfg(test)]
mod tests;

/// A packing as the validator's configuration type.
pub fn config_of(pk: &Packing) -> SphereConfig {
    SphereConfig {
        rho: pk.rho,
        pieces: pk.q.iter().map(|q| SpherePiece { q: q.to_vec() }).collect(),
    }
}
