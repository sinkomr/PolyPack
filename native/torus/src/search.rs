//! Seeded local search for packings on flat tori torus/<family>/N/P. Source:
//! packages/torus/src/search.ts (`searchTorus` and its helpers), ported line by line
//! (native/PORTING.md): the same seeded random numbers, the same order of every loop and of every
//! evaluation, so a seed and an evaluation budget give the TypeScript's packing.
//!
//! The size variable is a scale k applied to the lattice and to the centres together (pieces keep
//! side 1 or radius 1): the score is k times the score of the base lattice. Three parts:
//!
//!  - Penalty relaxation. Variables: each centre (x, y) in the base frame, each angle theta (times
//!    the circumradius, so that all variables are lengths), k and, for the free family, a shear
//!    F = [[e^t1, t2], [0, e^-t1]] of unit determinant applied to the lattice and the centres
//!    (the cell shape; sq and hex keep theirs). Minimise k + mu E for mu = 1e2 ... 1e8 with
//!    L-BFGS, where E sums max(0, -sep)^2 over the image pairs (i, j, lambda) within reach, sep
//!    being the separating-axis value of the shared kernel (the exact penetration depth when
//!    negative). Gradients are central differences of each piece's local energy, and of the total
//!    energy for k, t1, t2. The image pairs are listed again at the start of every round.
//!  - Tight scale. Scaling a packing up about the origin keeps it valid (the shrink argument of
//!    docs/spaces/TORUS.md section 3), so validity is monotone in k and the smallest valid k is
//!    found by bisection with the float validator, to 1e-13 relative, keeping every separation
//!    >= 0. sq and hex lattices are rebuilt from L as the records store them.
//!  - Basin hopping from the current packing: jiggle every piece, re-place one to three pieces,
//!    turn a quarter of the polygons by up to pi/N, or (free) shear the cell; then relax and take
//!    the tight scale. Acceptance as in the sphere search (T = 1e-3, back to the best after ten
//!    hops without a gain).
//!
//! Units: the interface is in site units (a disk has diameter 1). Inside, `search_torus` runs the
//! unchanged radius-1 search on the packing scaled by 2 (WORKING_DISK_RADIUS) and scales its
//! result back by 1/2, both exact. Polygons are not scaled.
//!
//! The source's `Stop` exception is the `Err(Stop)` of every step that can end the search, and the
//! `try`/`catch` around it is the `?` chain that ends at `search_working`.

use crate::disk::{area_of, reach_of};
use crate::geometry::Pose;
use crate::lattice::{
    cell_area, gauss_reduce, lattice_images, torus_score, Lattice, TorusFamily, TORUS_DISK_RADIUS,
};
use crate::overlap::regular_polygon_overlap;
use crate::validate::{validation_steps, TorusPacking, ValidateOptions};
use polypack_js::math;
use std::time::Instant;

/// disk.ts: `WORKING_DISK_RADIUS`. Disk radius of the working units of the search.
pub const WORKING_DISK_RADIUS: f64 = 1.0;

/// search.ts: `TorusProblem`. `n` is 0 (disks) or 3..=100.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TorusProblem {
    pub family: TorusFamily,
    pub n: usize,
    pub p: usize,
}

/// search.ts: `TorusSearchOptions`.
pub struct TorusSearchOptions<'a> {
    pub seed: u32,
    /// Packing to start from (any scale; an invalid one is first enlarged until it is valid).
    pub start: Option<&'a TorusPacking>,
    /// Most objective and gradient evaluations; the source's default is 20,000.
    pub max_evals: u64,
    /// Wall-clock ceiling in seconds; default none.
    pub max_seconds: Option<f64>,
    pub should_stop: Option<&'a dyn Fn() -> bool>,
}

impl TorusSearchOptions<'_> {
    pub fn new(seed: u32) -> Self {
        TorusSearchOptions {
            seed,
            start: None,
            max_evals: 20_000,
            max_seconds: None,
            should_stop: None,
        }
    }
}

/// search.ts: the `stopped` of `TorusSearchResult`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    Evals,
    Time,
    Aborted,
}

/// search.ts: `TorusSearchResult`.
#[derive(Clone, Debug)]
pub struct TorusSearchResult {
    /// The best packing found, valid by the validator with every separation >= 0, or `None`.
    pub packing: Option<TorusPacking>,
    /// Its score (L, or sqrt of the cell area for free); Infinity when there is none.
    pub score: f64,
    /// Score of the start after the tight-scale bisection, or `None` without a start.
    pub start_score: Option<f64>,
    pub evaluations: u64,
    pub hops: u64,
    pub stopped: Stopped,
}

/// search.ts: `mulberry32`.
pub struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Mulberry32 { a: seed }
    }

    /// One number in [0, 1).
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

/// search.ts: `gauss`.
fn gauss(rng: &mut Mulberry32) -> f64 {
    let a = rng.next();
    let b = rng.next();
    math::sqrt(-2.0 * math::log(1.0 - a)) * math::cos(2.0 * math::PI * b)
}

/// search.ts: `Stop`, the exception that ends the search.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    Evals,
    Time,
    Aborted,
}

/// The `tick` of `searchWorking`: counts an evaluation and ends the search when the budget, the
/// stop or the clock says so.
struct Ticker<'a> {
    evaluations: u64,
    max_evals: u64,
    should_stop: Option<&'a dyn Fn() -> bool>,
    max_seconds: Option<f64>,
    t0: Instant,
}

impl Ticker<'_> {
    fn tick(&mut self) -> Result<(), Stop> {
        self.evaluations += 1;
        if self.evaluations > self.max_evals {
            return Err(Stop::Evals);
        }
        if let Some(f) = self.should_stop {
            if f() {
                return Err(Stop::Aborted);
            }
        }
        if let Some(s) = self.max_seconds {
            if self.t0.elapsed().as_secs_f64() > s {
                return Err(Stop::Time);
            }
        }
        Ok(())
    }
}

/// search.ts: `lbfgs`. Minimal L-BFGS with a backtracking line search (the same as the sphere
/// search's).
fn lbfgs(
    f: &mut dyn FnMut(&[f64], &mut [f64]) -> f64,
    x0: &[f64],
    max_iter: usize,
    tk: &mut Ticker,
    first_step: f64,
) -> Result<Vec<f64>, Stop> {
    let n = x0.len();
    let m = 8;
    let mut x = x0.to_vec();
    let mut g = vec![0.0; n];
    tk.tick()?;
    let mut fx = f(&x, &mut g);
    let mut s_list: Vec<Vec<f64>> = Vec::new();
    let mut y_list: Vec<Vec<f64>> = Vec::new();
    let mut rhos: Vec<f64> = Vec::new();
    let mut d = vec![0.0; n];
    let mut alpha = vec![0.0; m];
    for _it in 0..max_iter {
        let mut gg = 0.0;
        for k in 0..n {
            gg += g[k] * g[k];
        }
        if !(gg > 1e-30) {
            break;
        }
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
            let scale = first_step / math::sqrt(gg);
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
            s_list.clear();
            y_list.clear();
            rhos.clear();
            continue;
        }
        let mut t = 1.0;
        let mut xn = vec![0.0; n];
        let mut gn = vec![0.0; n];
        let mut fnew = f64::INFINITY;
        for _ls in 0..30 {
            for k in 0..n {
                xn[k] = x[k] + t * d[k];
            }
            tk.tick()?;
            fnew = f(&xn, &mut gn);
            if fnew <= fx + 1e-4 * t * slope {
                break;
            }
            t *= 0.3;
        }
        if !(fnew < fx) {
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
        let rel = (fx - fnew) / math::max(1e-300, math::abs(fx));
        std::mem::swap(&mut x, &mut xn);
        std::mem::swap(&mut g, &mut gn);
        fx = fnew;
        if rel < 1e-15 {
            break;
        }
    }
    Ok(x)
}

/// A packing as the search keeps it: for sq/hex the lattice is always `family_lattice(L)`.
#[derive(Clone, Debug)]
struct State {
    lattice: Lattice,
    poses: Vec<Pose>,
    score: f64,
}

/// A lattice with poses, before it is scored (the source's `{ lattice, poses }`).
#[derive(Clone, Debug)]
struct Cfg {
    lattice: Lattice,
    poses: Vec<Pose>,
}

/// lattice.ts: `SQRT3_2`.
fn sqrt3_2() -> f64 {
    math::sqrt(3.0) / 2.0
}

/// lattice.ts: `familyLattice`. `family` must be sq or hex.
pub fn family_lattice(family: TorusFamily, l: f64) -> Lattice {
    match family {
        TorusFamily::Sq => Lattice {
            b1: [l, 0.0],
            b2: [0.0, l],
        },
        _ => Lattice {
            b1: [l, 0.0],
            b2: [l / 2.0, l * sqrt3_2()],
        },
    }
}

/// validate.ts: `scalePacking`. Scale a packing about the origin (lattice and centres; pieces keep
/// their size).
pub fn scale_packing(p: &TorusPacking, k: f64) -> TorusPacking {
    TorusPacking {
        family: p.family,
        n: p.n,
        lattice: Lattice {
            b1: [p.lattice.b1[0] * k, p.lattice.b1[1] * k],
            b2: [p.lattice.b2[0] * k, p.lattice.b2[1] * k],
        },
        poses: p
            .poses
            .iter()
            .map(|q| Pose {
                x: q.x * k,
                y: q.y * k,
                theta: q.theta,
            })
            .collect(),
    }
}

/// search.ts: `scaledLattice`. Lattice for a family at scale k of `l` (sq/hex rebuilt from L,
/// exactly as stored).
pub fn scaled_lattice(family: TorusFamily, l: &Lattice, k: f64) -> Lattice {
    if family != TorusFamily::Free {
        return family_lattice(family, math::hypot(l.b1[0], l.b1[1]) * k);
    }
    Lattice {
        b1: [l.b1[0] * k, l.b1[1] * k],
        b2: [l.b2[0] * k, l.b2[1] * k],
    }
}

/// search.ts: `tightScale`. The tight scale of a packing: the smallest k at which the packing
/// scaled by k about the origin (lattice and centres; pieces keep their size) is valid by the float
/// validator at tolerance 0 (every separation >= 0), by bisection to 1e-13 relative from k = 1
/// (validity is monotone in k). Returns the scaled lattice, poses and score, or `None` when no
/// valid k is found within a factor of about 14 above 1. `tick` is called before each validator
/// call and may end the search.
pub fn tight_scale(
    problem: &TorusProblem,
    lattice: &Lattice,
    poses: &[Pose],
    tick: &mut dyn FnMut() -> Result<(), Stop>,
    rd: f64,
) -> Result<Option<(Lattice, Vec<Pose>, f64)>, Stop> {
    let TorusProblem { family, n, .. } = *problem;
    let packing_at = |k: f64| TorusPacking {
        family,
        n: n as f64,
        lattice: scaled_lattice(family, lattice, k),
        poses: poses
            .iter()
            .map(|p| Pose {
                x: p.x * k,
                y: p.y * k,
                theta: p.theta,
            })
            .collect(),
    };
    let opts = ValidateOptions {
        tol: Some(0.0),
        disk_radius: Some(rd),
        max_errors: Some(1.0),
        ..Default::default()
    };
    let mut valid_at = |k: f64| -> Result<bool, Stop> {
        tick()?;
        // the first overlap decides (maxErrors 1): the answer is the full check's
        let v = validation_steps(&packing_at(k), &opts);
        Ok(v.errors.is_empty() && v.valid && v.min_sep >= 0.0)
    };
    let Some(k) = scale_search(&mut valid_at)? else {
        return Ok(None);
    };
    let p = packing_at(k);
    let score = torus_score(family, &p.lattice);
    Ok(Some((p.lattice, p.poses, score)))
}

/// search.ts: `scaleSearch`. The bisection of `tight_scale` for any test of validity that is
/// monotone in the scale k: from k = 1, up by steps of 1e-3, 2e-3, ... until valid or down by such
/// steps until invalid, then bisection to 1e-13 relative; the smallest valid k found, or `None`
/// when none is found within a factor of about 14 above 1.
pub fn scale_search(valid_at: &mut dyn FnMut(f64) -> Result<bool, Stop>) -> Result<Option<f64>, Stop> {
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
    let mut step = 1e-3;
    if !valid_at(1.0)? {
        let mut lo = 1.0;
        let mut hi;
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
    let mut hi = 1.0;
    let lo;
    loop {
        let next = hi * (1.0 - step);
        if !valid_at(next)? {
            lo = next;
            break;
        }
        hi = next;
        step = math::min(0.5, step * 2.0);
    }
    Ok(Some(bisect(valid_at, lo, hi)?))
}

/// search.ts: `searchTorus`. Errs with the source's "bad torus problem".
pub fn search_torus(problem: &TorusProblem, o: &TorusSearchOptions) -> Result<TorusSearchResult, String> {
    let n = problem.n;
    // site -> working: disks (N = 0) scale by 2; polygons stay
    let up = if n == 0 { WORKING_DISK_RADIUS / TORUS_DISK_RADIUS } else { 1.0 };
    let down = 1.0 / up;
    if up == 1.0 {
        return search_working(problem, o, o.start);
    }
    // a start of another shape is ignored by the search, so it is passed on as it is
    let scaled = o.start.filter(|s| s.n == n as f64).map(|s| scale_packing(s, up));
    let start = match (&scaled, o.start) {
        (Some(s), _) => Some(s),
        (None, s) => s,
    };
    let r = search_working(problem, o, start)?;
    Ok(TorusSearchResult {
        packing: r.packing.as_ref().map(|p| scale_packing(p, down)),
        score: r.score * down,
        start_score: r.start_score.map(|s| s * down),
        ..r
    })
}

/// The pairs of the relaxation: image pair (i, j, m, n) within reach of the base packing.
struct PairIdx {
    i: usize,
    j: usize,
    m: f64,
    n: f64,
}

/// The state of one round of `relax` (the closures of the source's round loop).
struct Round {
    n: usize,
    rd: f64,
    free: bool,
    p: usize,
    i_k: usize,
    theta_scale: f64,
    base: Lattice,
    u: Vec<Pose>,
    pairs: Vec<PairIdx>,
    touching: Vec<Vec<usize>>,
    lat: Lattice,
    centres: Vec<f64>,
    thetas: Vec<f64>,
    /// Per image pair, set by `total_energy(slack)`: 0 when the pair is separated by at least
    /// `slack`, which exceeds what a gradient step can move a piece's points. Such a pair adds
    /// exactly 0 to every local energy of the gradient, which skips it.
    live: Vec<u8>,
    /// Per image pair, the length of its centre-to-image vector when `total_energy(slack)` marked it.
    span: Vec<f64>,
    live_slack: f64,
}

impl Round {
    /// The packing for variables z: F k applied to the base frame.
    fn setup(&mut self, z: &[f64]) {
        let i_k = self.i_k;
        let k = z[i_k];
        let e = if self.free { math::exp(z[i_k + 1]) } else { 1.0 };
        let t2 = if self.free { z[i_k + 2] } else { 0.0 };
        let f11 = k * e;
        let f12 = k * t2;
        let f22 = k / e;
        let base = self.base;
        self.lat.b1 = [f11 * base.b1[0] + f12 * base.b1[1], f22 * base.b1[1]];
        self.lat.b2 = [f11 * base.b2[0] + f12 * base.b2[1], f22 * base.b2[1]];
        for i in 0..self.p {
            let x = self.u[i].x + z[3 * i];
            let y = self.u[i].y + z[3 * i + 1];
            self.centres[2 * i] = f11 * x + f12 * y;
            self.centres[2 * i + 1] = f22 * y;
            self.thetas[i] = self.u[i].theta + z[3 * i + 2] / self.theta_scale;
        }
    }

    /// `pairEnergy`: the energy of image pair `idx` with the poses given, and its separation and
    /// centre-to-image vector (the source's `lastSep`, `lastDx`, `lastDy`).
    #[allow(clippy::too_many_arguments)]
    fn pair_energy(
        &self,
        idx: usize,
        xi: f64,
        yi: f64,
        ti: f64,
        xj: f64,
        yj: f64,
        tj: f64,
        enough: f64,
    ) -> (f64, f64, f64, f64) {
        let p = &self.pairs[idx];
        let vx = xj + p.m * self.lat.b1[0] + p.n * self.lat.b2[0];
        let vy = yj + p.m * self.lat.b1[1] + p.n * self.lat.b2[1];
        // separationOf's value where it is below `enough` (only overlaps count), with no pose objects
        let sep = if self.n == 0 {
            let d = math::hypot(xi - vx, yi - vy);
            if d == 0.0 {
                -2.0 * self.rd
            } else {
                d - 2.0 * self.rd
            }
        } else {
            regular_polygon_overlap(self.n, xi, yi, ti, vx, vy, tj, 1.0, enough)
        };
        (if sep < 0.0 { sep * sep } else { 0.0 }, sep, vx - xi, vy - yi)
    }

    /// `totalEnergy`: the energy; with `slack` > 0 it marks the live pairs. With `stretch` >= 0 it
    /// skips the pairs that were not live and whose centre-to-image vector the change of the cell
    /// since the marking moves by less than half the slack (by at most stretch times its length):
    /// they are still separated and add exactly 0.
    fn total_energy(&mut self, slack: f64, stretch: f64) -> f64 {
        let mut e_sum = 0.0;
        for idx in 0..self.pairs.len() {
            let (pi, pj) = (self.pairs[idx].i, self.pairs[idx].j);
            if stretch >= 0.0 && self.live[idx] == 0 && stretch * self.span[idx] < 0.5 * self.live_slack {
                continue;
            }
            let (en, sep, dx, dy) = self.pair_energy(
                idx,
                self.centres[2 * pi],
                self.centres[2 * pi + 1],
                self.thetas[pi],
                self.centres[2 * pj],
                self.centres[2 * pj + 1],
                self.thetas[pj],
                slack,
            );
            e_sum += en;
            if slack > 0.0 {
                self.live[idx] = if sep < slack { 1 } else { 0 };
                self.span[idx] = math::sqrt(dx * dx + dy * dy) * (1.0 + 1e-12);
            }
        }
        if slack > 0.0 {
            self.live_slack = slack;
        }
        e_sum
    }

    /// `localEnergy`: energy of piece i's live image pairs with piece i at (x, y, theta) in world
    /// coordinates.
    fn local_energy(&self, i: usize, x: f64, y: f64, t: f64) -> f64 {
        let mut e_sum = 0.0;
        for &idx in &self.touching[i] {
            if self.live[idx] == 0 {
                continue;
            }
            let p = &self.pairs[idx];
            if p.i == p.j {
                e_sum += self.pair_energy(idx, x, y, t, x, y, t, 0.0).0;
            } else if p.i == i {
                e_sum += self
                    .pair_energy(
                        idx,
                        x,
                        y,
                        t,
                        self.centres[2 * p.j],
                        self.centres[2 * p.j + 1],
                        self.thetas[p.j],
                        0.0,
                    )
                    .0;
            } else {
                e_sum += self
                    .pair_energy(
                        idx,
                        self.centres[2 * p.i],
                        self.centres[2 * p.i + 1],
                        self.thetas[p.i],
                        x,
                        y,
                        t,
                        0.0,
                    )
                    .0;
            }
        }
        e_sum
    }

    /// `f`: the objective k + mu E and its gradient.
    fn objective(&mut self, z: &[f64], g: &mut [f64], mu: f64, reach_r: f64) -> f64 {
        let i_k = self.i_k;
        let free = self.free;
        let h = 1e-7;
        if !(z[i_k] > 0.0) || (free && !(math::abs(z[i_k + 1]) < 2.0)) {
            g.fill(0.0);
            return f64::INFINITY;
        }
        self.setup(z);
        let k = z[i_k];
        let e = if free { math::exp(z[i_k + 1]) } else { 1.0 };
        let t2 = if free { z[i_k + 2] } else { 0.0 };
        // a step moves a centre by at most h max(k e, |(k t2, k / e)|) and a vertex by h through
        // the angle (an axis by |d| h / R, |d| < reach); ten times that bounds every change of a
        // separation, so pairs separated by more stay separated in every step
        let slack = 10.0
            * h
            * math::max_of(&[
                1.0,
                k * e,
                math::hypot(k * t2, k / e),
                (2.0 * reach_r * 1.3 + 0.1) / self.theta_scale,
            ]);
        let e_total = self.total_energy(slack, -1.0);
        for i in 0..self.p {
            let mut any = false;
            for &idx in &self.touching[i] {
                if self.live[idx] != 0 {
                    any = true;
                }
            }
            if !any {
                // every local energy below is 0, and so is this piece's gradient
                g[3 * i] = 0.0;
                g[3 * i + 1] = 0.0;
                g[3 * i + 2] = 0.0;
                continue;
            }
            let cx = self.centres[2 * i];
            let cy = self.centres[2 * i + 1];
            let ti = self.thetas[i];
            // d(centre)/d(variable): the map F k (columns (k e, 0) and (k t2, k / e))
            let ex = [k * e, 0.0];
            let ey = [k * t2, k / e];
            let gx = self.local_energy(i, cx + h * ex[0], cy + h * ex[1], ti)
                - self.local_energy(i, cx - h * ex[0], cy - h * ex[1], ti);
            let gy = self.local_energy(i, cx + h * ey[0], cy + h * ey[1], ti)
                - self.local_energy(i, cx - h * ey[0], cy - h * ey[1], ti);
            g[3 * i] = (mu * gx) / (2.0 * h);
            g[3 * i + 1] = (mu * gy) / (2.0 * h);
            if self.n == 0 {
                g[3 * i + 2] = 0.0;
            } else {
                let gt = self.local_energy(i, cx, cy, ti + h / self.theta_scale)
                    - self.local_energy(i, cx, cy, ti - h / self.theta_scale);
                g[3 * i + 2] = (mu * gt) / (2.0 * h);
            }
        }
        let mut zz = z.to_vec();
        // the cell map k F at z, upper triangular [[f11, f12], [0, f22]]
        let f11 = k * e;
        let f12 = k * t2;
        let f22 = k / e;
        let nv = self.i_k + if free { 3 } else { 1 };
        for c in i_k..nv {
            let hc = if c == i_k { 1e-9 * z[i_k] } else { 1e-8 };
            zz[c] = z[c] + hc;
            self.setup(&zz);
            let st = stretch_to(&zz, i_k, free, f11, f12, f22);
            let ep = self.total_energy(0.0, st);
            zz[c] = z[c] - hc;
            self.setup(&zz);
            let st = stretch_to(&zz, i_k, free, f11, f12, f22);
            let em = self.total_energy(0.0, st);
            zz[c] = z[c];
            g[c] = (mu * (ep - em)) / (2.0 * hc) + if c == i_k { 1.0 } else { 0.0 };
        }
        self.setup(z);
        z[i_k] + mu * e_total
    }
}

/// `stretchTo`: a bound on |dv| / |v| for the centre-to-image vectors v = k F delta when the cell
/// map becomes that of zz: the Frobenius norm of (F' - F) F^-1, with room for rounding.
fn stretch_to(zz: &[f64], i_k: usize, free: bool, f11: f64, f12: f64, f22: f64) -> f64 {
    let ez = if free { math::exp(zz[i_k + 1]) } else { 1.0 };
    let d11 = zz[i_k] * ez - f11;
    let d12 = zz[i_k] * (if free { zz[i_k + 2] } else { 0.0 }) - f12;
    let d22 = zz[i_k] / ez - f22;
    let a = d11 / f11;
    let b = -(d11 * f12) / (f11 * f22) + d12 / f22;
    let c = d22 / f22;
    math::sqrt(a * a + b * b + c * c) * 1.01 + 1e-14
}

/// The search of `searchWorking`, with the state its closures share.
struct Search<'a> {
    problem: TorusProblem,
    rd: f64,
    /// reachOf(N, rd): the source's `R`
    reach: f64,
    theta_scale: f64,
    rng: Mulberry32,
    tk: Ticker<'a>,
}

impl Search<'_> {
    fn tight(&mut self, s: &Cfg) -> Result<Option<State>, Stop> {
        let tk = &mut self.tk;
        Ok(tight_scale(&self.problem, &s.lattice, &s.poses, &mut || tk.tick(), self.rd)?
            .map(|(lattice, poses, score)| State { lattice, poses, score }))
    }

    /// `relax`: penalty continuation from a packing (lattice, poses) scaled by k0.
    fn relax(&mut self, s: &Cfg, k0: f64, mus: &[f64]) -> Result<Cfg, Stop> {
        let TorusProblem { family, n, p } = self.problem;
        let mut cur = Cfg {
            lattice: scaled_lattice(family, &s.lattice, k0),
            poses: s
                .poses
                .iter()
                .map(|q| Pose {
                    x: q.x * k0,
                    y: q.y * k0,
                    theta: q.theta,
                })
                .collect(),
        };
        let free = family == TorusFamily::Free;
        let nv = 3 * p + if free { 3 } else { 1 };
        let i_k = 3 * p;
        let reach_r = self.reach;
        for &mu in mus {
            for _round in 0..3 {
                let mut base = cur.lattice;
                if free {
                    base = gauss_reduce(&base).lattice;
                }
                let u: Vec<Pose> = cur.poses.to_vec();
                // image pairs within reach of the base packing
                let reach = 2.0 * reach_r * 1.3 + 0.1;
                let mut pairs: Vec<PairIdx> = Vec::new();
                for i in 0..p {
                    for j in i..p {
                        match lattice_images(&base, &[u[j].x - u[i].x, u[j].y - u[i].y], reach, i == j) {
                            Ok(images) => {
                                for im in images {
                                    pairs.push(PairIdx {
                                        i,
                                        j,
                                        m: im.m,
                                        n: im.n,
                                    });
                                }
                            }
                            // the source's catch: the round is given up
                            Err(_) => return Ok(cur),
                        }
                    }
                }
                let mut touching: Vec<Vec<usize>> = vec![Vec::new(); p];
                for (idx, pr) in pairs.iter().enumerate() {
                    touching[pr.i].push(idx);
                    if pr.j != pr.i {
                        touching[pr.j].push(idx);
                    }
                }
                let count = pairs.len();
                let mut round = Round {
                    n,
                    rd: self.rd,
                    free,
                    p,
                    i_k,
                    theta_scale: self.theta_scale,
                    base,
                    u,
                    pairs,
                    touching,
                    lat: Lattice {
                        b1: [0.0, 0.0],
                        b2: [0.0, 0.0],
                    },
                    centres: vec![0.0; 2 * p],
                    thetas: vec![0.0; p],
                    live: vec![0; count],
                    span: vec![0.0; count],
                    live_slack: 0.0,
                };
                let mut x0 = vec![0.0; nv];
                x0[i_k] = 1.0;
                let z = lbfgs(&mut |z, g| round.objective(z, g, mu, reach_r), &x0, 150, &mut self.tk, 1e-3)?;
                round.setup(&z);
                let poses: Vec<Pose> = (0..p)
                    .map(|i| Pose {
                        x: round.centres[2 * i],
                        y: round.centres[2 * i + 1],
                        theta: round.thetas[i],
                    })
                    .collect();
                let lattice = if free {
                    Lattice {
                        b1: [round.lat.b1[0], round.lat.b1[1]],
                        b2: [round.lat.b2[0], round.lat.b2[1]],
                    }
                } else {
                    family_lattice(family, math::hypot(round.lat.b1[0], round.lat.b1[1]))
                };
                cur = Cfg { lattice, poses };
            }
        }
        Ok(cur)
    }

    fn local(&mut self, s: &Cfg, k0: f64, mus: &[f64]) -> Result<Option<State>, Stop> {
        let r = self.relax(s, k0, mus)?;
        self.tight(&r)
    }

    /// Cell of area P A / density in the family's shape (free: square or hexagonal at random).
    fn fresh_lattice(&mut self, density: f64) -> Lattice {
        let TorusProblem { family, n, p } = self.problem;
        let area = (p as f64 * area_of(n as f64, self.rd)) / density;
        let shape = if family == TorusFamily::Free {
            if self.rng.next() < 0.5 {
                TorusFamily::Sq
            } else {
                TorusFamily::Hex
            }
        } else {
            family
        };
        family_lattice(
            shape,
            if shape == TorusFamily::Sq {
                math::sqrt(area)
            } else {
                math::sqrt(area / (math::sqrt(3.0) / 2.0))
            },
        )
    }

    fn random_point(&mut self, l: &Lattice) -> (f64, f64) {
        let a = self.rng.next();
        let b = self.rng.next();
        (a * l.b1[0] + b * l.b2[0], a * l.b1[1] + b * l.b2[1])
    }

    fn random_start(&mut self) -> Result<Option<State>, Stop> {
        let lattice = self.fresh_lattice(0.45);
        let mut poses = Vec::with_capacity(self.problem.p);
        for _ in 0..self.problem.p {
            let (x, y) = self.random_point(&lattice);
            let theta = 2.0 * math::PI * self.rng.next();
            poses.push(Pose { x, y, theta });
        }
        self.local(&Cfg { lattice, poses }, 1.0, &MUS_FRESH)
    }

    fn perturb(&mut self, s: &State) -> Cfg {
        let TorusProblem { family, n, p } = self.problem;
        let r = self.reach;
        let mut lattice = s.lattice;
        let mut poses = s.poses.clone();
        let kind = self.rng.next();
        if kind < 0.35 {
            let sigma = (0.05 + 0.15 * self.rng.next()) * r;
            for q in poses.iter_mut() {
                q.x += sigma * gauss(&mut self.rng);
                q.y += sigma * gauss(&mut self.rng);
                if n != 0 {
                    q.theta += (sigma / r) * gauss(&mut self.rng);
                }
            }
        } else if kind < 0.65 || n == 0 {
            let k = 1.0 + math::floor(self.rng.next() * math::min(3.0, math::max(1.0, math::floor(p as f64 / 3.0))));
            let mut t = 0.0;
            while t < k {
                let idx = math::floor(self.rng.next() * p as f64) as usize;
                let (x, y) = self.random_point(&lattice);
                let theta = 2.0 * math::PI * self.rng.next();
                poses[idx] = Pose { x, y, theta };
                t += 1.0;
            }
        } else if kind < 0.85 || family != TorusFamily::Free {
            let k = math::max(1.0, math::floor(p as f64 / 4.0));
            let mut t = 0.0;
            while t < k {
                let idx = math::floor(self.rng.next() * p as f64) as usize;
                let d = (self.rng.next() - 0.5) * ((2.0 * math::PI) / n as f64);
                poses[idx].theta += d;
                t += 1.0;
            }
        } else {
            // shear the free cell, carrying the centres along
            let e = math::exp((self.rng.next() - 0.5) * 0.1);
            let t2 = (self.rng.next() - 0.5) * 0.2;
            let f = |x: f64, y: f64| -> [f64; 2] { [e * x + t2 * y, y / e] };
            lattice = Lattice {
                b1: f(lattice.b1[0], lattice.b1[1]),
                b2: f(lattice.b2[0], lattice.b2[1]),
            };
            for q in poses.iter_mut() {
                let v = f(q.x, q.y);
                q.x = v[0];
                q.y = v[1];
            }
        }
        Cfg { lattice, poses }
    }
}

const MUS_FRESH: [f64; 7] = [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
const MUS_WARM: [f64; 5] = [1e4, 1e5, 1e6, 1e7, 1e8];

/// search.ts: `searchWorking`. The search in working units (see the header).
fn search_working(
    problem: &TorusProblem,
    o: &TorusSearchOptions,
    start: Option<&TorusPacking>,
) -> Result<TorusSearchResult, String> {
    let TorusProblem { family, n, p } = *problem;
    let rd = if n == 0 { WORKING_DISK_RADIUS } else { TORUS_DISK_RADIUS };
    if !(n == 0 || (3..=100).contains(&n)) || p < 1 {
        return Err("bad torus problem".to_string());
    }
    let reach = reach_of(n as f64, rd);
    let mut s = Search {
        problem: *problem,
        rd,
        reach,
        theta_scale: if n == 0 { 1.0 } else { reach },
        rng: Mulberry32::new(o.seed),
        tk: Ticker {
            evaluations: 0,
            max_evals: o.max_evals,
            should_stop: o.should_stop,
            max_seconds: o.max_seconds,
            t0: Instant::now(),
        },
    };
    let mut best: Option<State> = None;
    let mut start_score: Option<f64> = None;
    let mut hops = 0u64;
    let stopped = (|| -> Result<(), Stop> {
        if let Some(st) = start {
            if st.poses.len() == p && st.n == n as f64 && st.family == family && cell_area(&st.lattice) > 0.0 {
                let s0 = Cfg {
                    lattice: st.lattice,
                    poses: st.poses.clone(),
                };
                let t = s.tight(&s0)?;
                if let Some(t) = t {
                    start_score = Some(t.score);
                    best = Some(t);
                }
                let from = match &best {
                    Some(b) => Cfg {
                        lattice: b.lattice,
                        poses: b.poses.clone(),
                    },
                    None => s0,
                };
                let r = s.local(&from, 1.0, &MUS_WARM)?;
                if let Some(r) = r {
                    if best.as_ref().map_or(true, |b| r.score < b.score) {
                        best = Some(r);
                    }
                }
            }
        }
        while best.is_none() {
            best = s.random_start()?;
        }
        let mut cur: State = best.clone().unwrap();
        let mut misses = 0;
        loop {
            hops += 1;
            let pert = s.perturb(&cur);
            let Some(r) = s.local(&pert, 1.01, &MUS_FRESH)? else {
                continue;
            };
            if r.score < best.as_ref().unwrap().score * (1.0 - 1e-13) {
                best = Some(r.clone());
            }
            if r.score < cur.score * (1.0 - 1e-13) || s.rng.next() < math::exp(-(r.score / cur.score - 1.0) / 1e-3) {
                cur = r;
                misses = 0;
            } else {
                misses += 1;
                if misses >= 10 {
                    cur = best.clone().unwrap();
                    misses = 0;
                }
            }
        }
    })()
    .unwrap_err();
    let evaluations = s.tk.evaluations.min(o.max_evals);
    Ok(TorusSearchResult {
        packing: best.as_ref().map(|b| TorusPacking {
            family,
            n: n as f64,
            lattice: b.lattice,
            poses: b.poses.clone(),
        }),
        score: best.as_ref().map_or(f64::INFINITY, |b| b.score),
        start_score,
        evaluations,
        hops,
        stopped: match stopped {
            Stop::Evals => Stopped::Evals,
            Stop::Time => Stopped::Time,
            Stop::Aborted => Stopped::Aborted,
        },
    })
}
