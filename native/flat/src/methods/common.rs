//! Helpers shared by the methods: starting grids, restoration of pair separation, homothetic
//! legalisation, and zero-tolerance overlap tests (penalty/restoration.ts, harden/legalise.ts,
//! morph/shapes.ts `dilate`).

use crate::framework::Ctx;
use crate::grid::NeighborGrid;
use crate::sep::Shape;
use crate::shapes::{bounding_radius, Config, Pose, Problem, MAX_COORD};
use std::f64::consts::PI;

/// Unit pieces on a loose jittered grid (pitch 2.4 bounding radii, jitter 0.075 pitch, random
/// angles); `random` is the context's stream, or a constant 0.5 for the jitter-free grid.
pub fn scatter(problem: Problem, mut random: impl FnMut() -> f64) -> Config {
    let p = problem.p;
    let width = (p as f64).sqrt().ceil() as usize;
    let spacing = 2.4 * bounding_radius(problem.n);
    let rows = (p as f64 / width as f64).ceil();
    let mut pieces = Vec::with_capacity(p);
    for i in 0..p {
        let x = spacing * ((i % width) as f64 - (width as f64 - 1.0) / 2.0 + 0.15 * (random() - 0.5));
        let y = spacing * ((i / width) as f64 - (rows - 1.0) / 2.0 + 0.15 * (random() - 0.5));
        let theta = if problem.n == 0 { 0.0 } else { 2.0 * PI * random() };
        pieces.push(Pose::new(x, y, theta));
    }
    Config { n: problem.n, m: problem.m, pieces, phi: 0.0 }
}

/// Scale every centre about the mean centre by `factor`.
pub fn dilate(config: &Config, factor: f64) -> Config {
    let n = config.pieces.len() as f64;
    let cx = config.pieces.iter().map(|p| p.x).sum::<f64>() / n;
    let cy = config.pieces.iter().map(|p| p.y).sum::<f64>() / n;
    let mut out = config.clone();
    for p in &mut out.pieces {
        p.x = cx + factor * (p.x - cx);
        p.y = cy + factor * (p.y - cy);
    }
    out
}

/// Pieces of at most this many sides use their cached edge normals; more sides the closed form.
const CACHED_NORMALS_UP_TO: u32 = 16;

/// Pair tests with reusable buffers. The edge normals of every piece are cached and recomputed
/// only when its angle changes (restoration and legalisation move centres, never angles), so a
/// pair test is 2N products and one cosine instead of the closed form's arctangent and cosines.
pub struct PairTester {
    pub shape: Shape,
    pub grid: NeighborGrid,
    reach: f64,
    nn: usize,
    cached: bool,
    base_cos: Vec<f64>,
    base_sin: Vec<f64>,
    normals: Vec<f64>,
    thetas: Vec<u64>,
}

impl PairTester {
    pub fn new(n: u32) -> Self {
        let shape = Shape::new(n);
        let nn = n as usize;
        let angles: Vec<f64> = (0..nn).map(|k| shape.normal0 + k as f64 * shape.step).collect();
        PairTester {
            shape,
            grid: NeighborGrid::new(),
            reach: 2.0 * bounding_radius(n),
            nn,
            cached: n != 0 && n <= CACHED_NORMALS_UP_TO,
            base_cos: angles.iter().map(|a| a.cos()).collect(),
            base_sin: angles.iter().map(|a| a.sin()).collect(),
            normals: Vec::new(),
            thetas: Vec::new(),
        }
    }

    /// Bring the cached normals up to date with the pieces' angles.
    pub fn refresh(&mut self, pieces: &[Pose]) {
        if !self.cached {
            return;
        }
        let nn = self.nn;
        if self.thetas.len() != pieces.len() {
            self.thetas.clear();
            self.thetas.resize(pieces.len(), u64::MAX);
            self.normals.resize(2 * nn * pieces.len(), 0.0);
        }
        for (i, p) in pieces.iter().enumerate() {
            let bits = p.theta.to_bits();
            if self.thetas[i] == bits {
                continue;
            }
            self.thetas[i] = bits;
            let (s, c) = p.theta.sin_cos();
            let out = &mut self.normals[2 * nn * i..2 * nn * (i + 1)];
            for k in 0..nn {
                out[2 * k] = c * self.base_cos[k] - s * self.base_sin[k];
                out[2 * k + 1] = s * self.base_cos[k] + c * self.base_sin[k];
            }
        }
    }

    /// Largest projection of d on the edge normals of piece i, and the normal's index.
    #[inline]
    fn reach_along(&self, i: usize, dx: f64, dy: f64) -> (f64, usize) {
        let nn = self.nn;
        let u = &self.normals[2 * nn * i..2 * nn * (i + 1)];
        let mut best = f64::NEG_INFINITY;
        let mut at = 0;
        for k in 0..nn {
            let g = dx * u[2 * k] + dy * u[2 * k + 1];
            if g > best {
                best = g;
                at = k;
            }
        }
        (best, at)
    }

    /// Separation of pieces i and j (cached normals after `refresh`).
    #[inline]
    pub fn sep_ij(&self, i: usize, j: usize, pieces: &[Pose]) -> f64 {
        let (a, b) = (&pieces[i], &pieces[j]);
        if !self.cached {
            return self.shape.sep(a, b);
        }
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let (ma, _) = self.reach_along(i, dx, dy);
        let (mb, _) = self.reach_along(j, -dx, -dy);
        ma.max(mb) - self.shape.contact_offset(a.theta, b.theta)
    }

    /// Whether pieces i and j overlap (separation below zero); decided without the cosine when
    /// the reach alone settles it: the offset r + R cos(delta) lies in [2r, r + R].
    #[inline]
    pub fn overlap_ij(&self, i: usize, j: usize, pieces: &[Pose]) -> bool {
        let (a, b) = (&pieces[i], &pieces[j]);
        if !self.cached {
            return self.shape.sep(a, b) < 0.0;
        }
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let (ma, _) = self.reach_along(i, dx, dy);
        let s = &self.shape;
        if ma >= s.r + s.big_r {
            return false;
        }
        let (mb, _) = self.reach_along(j, -dx, -dy);
        let m = ma.max(mb);
        if m >= s.r + s.big_r {
            return false;
        }
        if m < 2.0 * s.r {
            return true;
        }
        m - s.contact_offset(a.theta, b.theta) < 0.0
    }

    /// Separation and the direction in which moving piece i increases it.
    #[inline]
    pub fn contact_ij(&self, i: usize, j: usize, pieces: &[Pose]) -> crate::sep::Contact {
        let (a, b) = (&pieces[i], &pieces[j]);
        if !self.cached {
            return self.shape.contact(a, b);
        }
        let nn = self.nn;
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let (ma, ka) = self.reach_along(i, dx, dy);
        let (mb, kb) = self.reach_along(j, -dx, -dy);
        let off = self.shape.contact_offset(a.theta, b.theta);
        if ma >= mb {
            // A's normal points from A toward B: A retreats along -u
            let u = &self.normals[2 * nn * i..];
            crate::sep::Contact { sep: ma - off, nx: -u[2 * ka], ny: -u[2 * ka + 1] }
        } else {
            // B's normal pushes A along +u
            let u = &self.normals[2 * nn * j..];
            crate::sep::Contact { sep: mb - off, nx: u[2 * kb], ny: u[2 * kb + 1] }
        }
    }

    /// True when some pair has a separation below -tol (tol = 0: any penetration at all).
    pub fn any_below(&mut self, pieces: &[Pose], tol: f64) -> bool {
        self.refresh(pieces);
        self.grid.build(pieces, self.reach);
        let mut hit = false;
        let me = &*self;
        me.grid.for_each_pair(pieces, |i, j| {
            let below = if tol == 0.0 { me.overlap_ij(i, j, pieces) } else { me.sep_ij(i, j, pieces) < -tol };
            if below {
                hit = true;
                return false;
            }
            true
        });
        hit
    }

    /// The deepest penetration (0 when nothing overlaps) of pairs below zero separation.
    pub fn deepest(&mut self, pieces: &[Pose]) -> f64 {
        self.refresh(pieces);
        self.grid.build(pieces, self.reach);
        let mut deepest = 0.0f64;
        let me = &*self;
        me.grid.for_each_pair(pieces, |i, j| {
            let s = me.sep_ij(i, j, pieces);
            if s < 0.0 && -s > deepest {
                deepest = -s;
            }
            true
        });
        deepest
    }

    /// Pairs within reach (i < j).
    pub fn pairs(&mut self, pieces: &[Pose], out: &mut Vec<(u32, u32)>) {
        out.clear();
        self.grid.build(pieces, self.reach);
        self.grid.for_each_pair(pieces, |i, j| {
            out.push((i as u32, j as u32));
            true
        });
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Strategy {
    /// Small pairwise separating moves (48 sweeps), then uniform expansion if necessary.
    Separate,
    /// Uniform expansion of the centres about their mean, bisected to first contact.
    Expand,
}

/// Restore pair separation (no overlap at zero tolerance); the container is the framework's
/// business. With `use_random`, pairs with (nearly) coincident centres are first parted along a
/// seeded direction. None when stopped or when no expansion within the coordinate limit works.
pub fn restore(
    ctx: &mut Ctx,
    input: &Config,
    strategy: Strategy,
    use_random: bool,
    coordinate_limit: f64,
    tester: &mut PairTester,
    mut extra_stop: Option<&mut dyn FnMut() -> bool>,
) -> Option<Config> {
    if !input.pieces.iter().all(|p| p.x.is_finite() && p.y.is_finite() && p.theta.is_finite()) {
        return None;
    }
    let mut stopped = |ctx: &mut Ctx| -> bool {
        if let Some(f) = extra_stop.as_mut() {
            if f() {
                return true;
            }
        }
        ctx.should_stop()
    };
    let n = input.n;
    let mut config = input.clone();
    let reach = 2.0 * bounding_radius(n);
    let accepted = |c: &Config| c.pieces.iter().all(|p| p.x.is_finite() && p.y.is_finite() && p.x.abs() <= coordinate_limit && p.y.abs() <= coordinate_limit);
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    if use_random {
        // expansion cannot separate coincident rays: give each such pair a seeded direction
        tester.pairs(&config.pieces, &mut pairs);
        for &(i, j) in &pairs {
            if stopped(ctx) {
                return None;
            }
            let (i, j) = (i as usize, j as usize);
            let (a, b) = (config.pieces[i], config.pieces[j]);
            if (a.x - b.x).hypot(a.y - b.y) >= 1e-8 * reach {
                continue;
            }
            let angle = 2.0 * PI * ctx.rng.next();
            let dx = (reach / 2.0 + 2e-12) * angle.cos();
            let dy = (reach / 2.0 + 2e-12) * angle.sin();
            config.pieces[i].x += dx;
            config.pieces[i].y += dy;
            config.pieces[j].x -= dx;
            config.pieces[j].y -= dy;
        }
    }
    tester.refresh(&config.pieces);
    if strategy == Strategy::Separate {
        // The pairs within 2R plus a slack are listed once, and listed again only after some piece
        // has moved by half the slack. A pair is tested again only when one of its pieces moved
        // since its last test: a pair found apart stays apart while neither piece moves.
        let p = config.pieces.len();
        let slack = 0.25 * reach;
        let mut drift = vec![0.0f64; p];
        let mut moved_at = vec![0u64; p];
        let mut tested_at: Vec<u64> = Vec::new();
        let mut clock: u64 = 1;
        let mut listed = false;
        for _sweep in 0..48u32 {
            if stopped(ctx) {
                return None;
            }
            if !listed || drift.iter().any(|&d| 2.0 * d > slack) {
                pairs.clear();
                tester.grid.build(&config.pieces, reach + slack);
                let pieces = &config.pieces;
                tester.grid.for_each_pair(pieces, |i, j| {
                    pairs.push((i as u32, j as u32));
                    true
                });
                drift.iter_mut().for_each(|d| *d = 0.0);
                // a fresh list is tested in full
                tested_at.clear();
                tested_at.resize(pairs.len(), 0);
                listed = true;
            }
            let mut moved = false;
            for (k, &(i, j)) in pairs.iter().enumerate() {
                let (i, j) = (i as usize, j as usize);
                if tested_at[k] != 0 && moved_at[i].max(moved_at[j]) <= tested_at[k] {
                    continue;
                }
                tested_at[k] = clock;
                // the normal moves piece i (A) away from j
                let c = tester.contact_ij(i, j, &config.pieces);
                if c.sep >= 0.0 {
                    continue;
                }
                if stopped(ctx) {
                    return None;
                }
                let delta = (-c.sep + 2e-12) / 2.0;
                let (mut nx, mut ny) = (c.nx, c.ny);
                let (a, b) = (config.pieces[i], config.pieces[j]);
                if use_random && (a.x - b.x).hypot(a.y - b.y) < 1e-8 * reach {
                    let angle = 2.0 * PI * ctx.rng.next();
                    nx = angle.cos();
                    ny = angle.sin();
                }
                config.pieces[i].x += delta * nx;
                config.pieces[i].y += delta * ny;
                config.pieces[j].x -= delta * nx;
                config.pieces[j].y -= delta * ny;
                drift[i] += delta;
                drift[j] += delta;
                clock += 1;
                moved_at[i] = clock;
                moved_at[j] = clock;
                tested_at[k] = clock;
                moved = true;
            }
            if !moved {
                return if accepted(&config) { Some(config) } else { None };
            }
        }
    }
    let np = config.pieces.len() as f64;
    let cx = config.pieces.iter().map(|p| p.x).sum::<f64>() / np;
    let cy = config.pieces.iter().map(|p| p.y).sum::<f64>() / np;
    let base: Vec<Pose> = config.pieces.clone();
    // Expansion only moves centres apart (every distance grows by the factor), so the pairs that
    // can touch at a factor >= 1 are among those within 2R at factor 1: listed once.
    tester.pairs(&base, &mut pairs);
    let mut feasible = |ctx: &mut Ctx, config: &mut Config, factor: f64| -> bool {
        for (p, b) in config.pieces.iter_mut().zip(base.iter()) {
            p.x = cx + factor * (b.x - cx);
            p.y = cy + factor * (b.y - cy);
        }
        if !accepted(config) {
            return false;
        }
        if stopped(ctx) {
            return false;
        }
        let reach2 = reach * reach;
        for &(i, j) in &pairs {
            let (a, b) = (&config.pieces[i as usize], &config.pieces[j as usize]);
            if (a.x - b.x).powi(2) + (a.y - b.y).powi(2) > reach2 {
                continue;
            }
            if tester.overlap_ij(i as usize, j as usize, &config.pieces) {
                return false;
            }
        }
        !stopped(ctx)
    };
    if feasible(ctx, &mut config, 1.0) {
        return if accepted(&config) { Some(config) } else { None };
    }
    let mut low = 1.0;
    let mut high = 1.001;
    let mut k = 0;
    while k < 40 && !feasible(ctx, &mut config, high) {
        if ctx.should_stop() || !accepted(&config) {
            return None;
        }
        low = high;
        high *= 2.0;
        k += 1;
    }
    if !feasible(ctx, &mut config, high) {
        return None;
    }
    // along each fixed centre ray the separating half-spaces are monotone in the scale
    for _ in 0..44 {
        if ctx.should_stop() {
            return None;
        }
        let mid = (low + high) / 2.0;
        if feasible(ctx, &mut config, mid) {
            high = mid;
        } else {
            low = mid;
        }
    }
    if feasible(ctx, &mut config, high * (1.0 + 2e-12)) && accepted(&config) {
        Some(config)
    } else {
        None
    }
}

/// Homothety of the true-shape arrangement about its mean centre to first contact (harden's
/// legalisation): the smallest factor at which no pair has negative separation, apart when pieces
/// overlap and together when none touch. Feasibility is monotone in the factor because each
/// pair's separating half-space is. None when stopped or when no factor up to 1e6 works.
pub fn legalise(ctx: &mut Ctx, config: &Config, tester: &mut PairTester) -> Option<Config> {
    let n = config.pieces.len() as f64;
    let cx = config.pieces.iter().map(|p| p.x).sum::<f64>() / n;
    let cy = config.pieces.iter().map(|p| p.y).sum::<f64>() / n;
    let mut work = config.clone();
    let mut clear = |ctx: &mut Ctx, work: &mut Config, factor: f64| -> Option<bool> {
        for (p, b) in work.pieces.iter_mut().zip(config.pieces.iter()) {
            p.x = cx + factor * (b.x - cx);
            p.y = cy + factor * (b.y - cy);
        }
        let free = !tester.any_below(&work.pieces, 0.0);
        if ctx.should_stop() {
            None
        } else {
            Some(free)
        }
    };
    let mut low = 0.0;
    let mut high = 1.0;
    loop {
        match clear(ctx, &mut work, high)? {
            true => break,
            false => {
                if high > 1e6 {
                    return None;
                }
                low = high;
                high *= 2.0;
            }
        }
    }
    for _ in 0..40 {
        let middle = (low + high) / 2.0;
        if clear(ctx, &mut work, middle)? {
            high = middle;
        } else {
            low = middle;
        }
    }
    // a last-place margin, so that contact does not round into overlap
    if clear(ctx, &mut work, high * (1.0 + 2e-12))? {
        Some(work)
    } else {
        None
    }
}

/// Poses of a configuration in the frame of its enclosing container at the stored orientation:
/// centre at the origin, phi = 0 (a rigid motion of the whole arrangement). Returns the poses and
/// the container size.
pub fn adopt(config: &Config) -> (Vec<Pose>, f64) {
    let phi = if config.m == 0 { 0.0 } else { config.phi };
    let bx = crate::enclose::enclose(config.n, &config.pieces, config.m, phi);
    let c = (-bx.phi).cos();
    let s = (-bx.phi).sin();
    let pieces = config
        .pieces
        .iter()
        .map(|p| {
            let dx = p.x - bx.cx;
            let dy = p.y - bx.cy;
            Pose::new(c * dx - s * dy, s * dx + c * dy, if config.n == 0 { 0.0 } else { p.theta - bx.phi })
        })
        .collect();
    (pieces, bx.size)
}

/// Fisher-Yates shuffle from the seeded stream.
pub fn shuffle(values: &mut [usize], ctx: &mut Ctx) {
    for i in (1..values.len()).rev() {
        let j = (ctx.rng.next() * (i + 1) as f64) as usize;
        values.swap(i, j);
    }
}

pub const COORD_LIMIT: f64 = MAX_COORD;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sep::regular_polygon_separation;

    #[test]
    fn cached_normals_agree_with_the_reference() {
        let mut rng = crate::rng::Rng::new(5);
        for n in [3u32, 4, 5, 7, 8, 12, 16, 17, 40] {
            let mut tester = PairTester::new(n);
            for _ in 0..300 {
                let pieces: Vec<Pose> = (0..2).map(|_| Pose::new(rng.next() * 2.5, rng.next() * 2.5, rng.signed() * 20.0)).collect();
                tester.refresh(&pieces);
                let reference = regular_polygon_separation(n, &pieces[0], &pieces[1], 1.0);
                assert!((tester.sep_ij(0, 1, &pieces) - reference.sep).abs() < 1e-12);
                assert_eq!(tester.overlap_ij(0, 1, &pieces), reference.sep < 0.0, "n={n} sep={}", reference.sep);
                let c = tester.contact_ij(0, 1, &pieces);
                assert!((c.sep - reference.sep).abs() < 1e-12);
                // moving A along the normal increases the separation
                let mut moved = pieces.clone();
                moved[0].x += 1e-4 * c.nx;
                moved[0].y += 1e-4 * c.ny;
                assert!(regular_polygon_separation(n, &moved[0], &moved[1], 1.0).sep > reference.sep);
            }
        }
    }
}
