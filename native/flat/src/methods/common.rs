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

/// Zero-tolerance pair tests with reusable buffers.
pub struct PairTester {
    pub shape: Shape,
    pub grid: NeighborGrid,
    reach: f64,
}

impl PairTester {
    pub fn new(n: u32) -> Self {
        PairTester { shape: Shape::new(n), grid: NeighborGrid::new(), reach: 2.0 * bounding_radius(n) }
    }

    /// True when some pair has a separation below -tol (tol = 0: any penetration at all).
    pub fn any_below(&mut self, pieces: &[Pose], tol: f64) -> bool {
        self.grid.build(pieces, self.reach);
        let shape = self.shape;
        let mut hit = false;
        self.grid.for_each_pair(pieces, |i, j| {
            if shape.sep(&pieces[i], &pieces[j]) < -tol {
                hit = true;
                return false;
            }
            true
        });
        hit
    }

    /// The deepest penetration (0 when nothing overlaps) of pairs below zero separation.
    pub fn deepest(&mut self, pieces: &[Pose]) -> f64 {
        self.grid.build(pieces, self.reach);
        let shape = self.shape;
        let mut deepest = 0.0f64;
        self.grid.for_each_pair(pieces, |i, j| {
            let s = shape.sep(&pieces[i], &pieces[j]);
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
    let shape = tester.shape;
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
    if strategy == Strategy::Separate {
        for _sweep in 0..48 {
            if stopped(ctx) {
                return None;
            }
            let mut moved = false;
            tester.pairs(&config.pieces, &mut pairs);
            for &(i, j) in &pairs {
                let (i, j) = (i as usize, j as usize);
                // the normal moves piece i (A) away from j
                let c = shape.contact(&config.pieces[i], &config.pieces[j]);
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
        !tester.any_below(&config.pieces, 0.0) && !stopped(ctx)
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
