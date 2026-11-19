//! The search for unit balls (radius `BALL_RADIUS`) in the smallest ball, cube or other solid: a penalty
//! method with the container size as a variable, a legalization that makes the result exactly valid with a
//! clearance, starts and basin hopping hops. Port of `packages/balls/src/ball-pieces.ts`; its file comment
//! (the penalty `s + mu [sum overlaps^2 + sum walls^2]` for mu = 1e1 ... 1e10 by L-BFGS, the legalization by
//! scaling the centres, the lattice cuts, the hops) describes it.

// Index loops and negated comparisons are kept as the source writes them: `!(a < b)` is not `a >= b` for NaN (native/PORTING.md, rule 4).
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord)]

use crate::catalogue::{
    ball_container_radius, ball_container_radius_slope, ball_container_score, BallsProblem, BALL_DIAMETER, BALL_RADIUS,
};
use crate::container::{container_kind, container_of_problem, size_for, Container, ContainerKind};
use crate::lbfgs::lbfgs;
use crate::problems::balls_bound;
use crate::random::{gauss, random_quaternion, rotation_of, Rng};
use crate::stop::{Fail, Stop, Ticker};
use crate::validate::BallsConfig;
use polypack_js::math;

pub type Vec3 = [f64; 3];

/// `ball-pieces.ts: BALL_MUS`: penalty weights of a full polish.
pub const BALL_MUS: [f64; 10] = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10];

/// `ball-pieces.ts: SKIN`: width of the margin of the pair list: pairs within 2 + g + SKIN of each other when
/// it is made.
const SKIN: f64 = 0.5;

/// The container of a problem as the functions here need it: `None` for a ball or a cube.
fn solid_container(problem: &BallsProblem) -> Result<Option<std::sync::Arc<Container>>, String> {
    if container_kind(problem) == ContainerKind::Polyhedron {
        container_of_problem(problem)
    } else {
        Ok(None)
    }
}

/// The objective of one stage on z = [s, x0, y0, z0, x1, ...] (`ball-pieces.ts: objective`).
///
/// The pairs are taken from a list of those within 2 + g + SKIN, made again whenever a ball has moved SKIN / 2
/// or more since (a Verlet list): a pair left out is then farther apart than 2 + g and contributes nothing, so
/// the function is the sum over all pairs, evaluated in the same order with the same rounding, at a cost of
/// about the dozen neighbours of each ball instead of all P - 1.
struct Objective<'c> {
    kind: ContainerKind,
    c: Option<&'c Container>,
    n: usize,
    mu: f64,
    g: f64,
    w: f64,
    lim2: f64,
    reach2: f64,
    move2: f64,
    refpos: Vec<f64>,
    pairs: Vec<u32>,
    made: bool,
}

impl<'c> Objective<'c> {
    fn new(kind: ContainerKind, c: Option<&'c Container>, n: usize, mu: f64, g: f64, w: f64) -> Self {
        let lim = BALL_DIAMETER + g;
        let reach = BALL_DIAMETER + g + SKIN;
        // a little under SKIN / 2, so that rounding never lets a pair in reach that was left out
        let mv = 0.499 * SKIN;
        Objective {
            kind,
            c,
            n,
            mu,
            g,
            w,
            lim2: lim * lim,
            reach2: reach * reach,
            move2: mv * mv,
            refpos: vec![0.0; 3 * n],
            pairs: Vec::new(),
            made: false,
        }
    }

    fn relist(&mut self, z: &[f64]) {
        let n = self.n;
        self.pairs.clear();
        for i in 0..n {
            for j in i + 1..n {
                let dx = z[1 + 3 * i] - z[1 + 3 * j];
                let dy = z[2 + 3 * i] - z[2 + 3 * j];
                let dz = z[3 + 3 * i] - z[3 + 3 * j];
                if dx * dx + dy * dy + dz * dz < self.reach2 {
                    self.pairs.push(i as u32);
                    self.pairs.push(j as u32);
                }
            }
        }
        self.refpos.copy_from_slice(&z[1..1 + 3 * n]);
        self.made = true;
    }

    /// Returns f and fills grad; `tick` counts the evaluation and may end the run.
    fn eval(&mut self, z: &[f64], grad: &mut [f64], tk: &mut Ticker) -> Result<f64, Stop> {
        tk.tick()?;
        let n = self.n;
        let mut stale = !self.made;
        let mut i = 0;
        while i < n && !stale {
            let dx = z[1 + 3 * i] - self.refpos[3 * i];
            let dy = z[2 + 3 * i] - self.refpos[3 * i + 1];
            let dz = z[3 + 3 * i] - self.refpos[3 * i + 2];
            if !(dx * dx + dy * dy + dz * dz < self.move2) {
                stale = true;
            }
            i += 1;
        }
        if stale {
            self.relist(z);
        }
        for v in grad.iter_mut() {
            *v = 0.0;
        }
        let (mu, g, w) = (self.mu, self.g, self.w);
        let s = z[0];
        let mut pen = 0.0;
        let mut gs = 0.0;
        if self.kind == ContainerKind::Cube {
            let h = s / 2.0 - BALL_RADIUS - w;
            for i in 0..n {
                for k in 0..3 {
                    let v = z[1 + 3 * i + k];
                    let viol = math::abs(v) - h;
                    if viol <= 0.0 {
                        continue;
                    }
                    pen += viol * viol;
                    grad[1 + 3 * i + k] += 2.0 * mu * viol * math::sign(v);
                    gs -= mu * viol;
                }
            }
        } else if let Some(c) = self.c {
            // one hinge per face: N_f . c beyond s b_f - r - w
            let nn = c.n();
            let b = c.b();
            for i in 0..n {
                let x = z[1 + 3 * i];
                let y = z[2 + 3 * i];
                let q = z[3 + 3 * i];
                for f in 0..c.f {
                    let viol = nn[3 * f] * x + nn[3 * f + 1] * y + nn[3 * f + 2] * q - (s * b[f] - BALL_RADIUS - w);
                    if viol <= 0.0 {
                        continue;
                    }
                    pen += viol * viol;
                    let cc = 2.0 * mu * viol;
                    grad[1 + 3 * i] += cc * nn[3 * f];
                    grad[2 + 3 * i] += cc * nn[3 * f + 1];
                    grad[3 + 3 * i] += cc * nn[3 * f + 2];
                    gs -= cc * b[f];
                }
            }
        } else {
            let h = ball_container_radius(s) - BALL_RADIUS - w;
            for i in 0..n {
                let x = z[1 + 3 * i];
                let y = z[2 + 3 * i];
                let q = z[3 + 3 * i];
                let r = math::hypot3(x, y, q);
                let viol = r - h;
                if viol <= 0.0 || r == 0.0 {
                    continue;
                }
                pen += viol * viol;
                let cc = (2.0 * mu * viol) / r;
                grad[1 + 3 * i] += cc * x;
                grad[2 + 3 * i] += cc * y;
                grad[3 + 3 * i] += cc * q;
                gs -= 2.0 * mu * viol * ball_container_radius_slope();
            }
        }
        for p in 0..self.pairs.len() / 2 {
            let i = self.pairs[2 * p] as usize;
            let j = self.pairs[2 * p + 1] as usize;
            let dx = z[1 + 3 * i] - z[1 + 3 * j];
            let dy = z[2 + 3 * i] - z[2 + 3 * j];
            let dz = z[3 + 3 * i] - z[3 + 3 * j];
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 >= self.lim2 {
                continue;
            }
            let d = math::sqrt(d2);
            let viol = BALL_DIAMETER + g - d;
            pen += viol * viol;
            if d == 0.0 {
                continue;
            }
            let cc = (2.0 * mu * viol) / d;
            grad[1 + 3 * i] -= cc * dx;
            grad[2 + 3 * i] -= cc * dy;
            grad[3 + 3 * i] -= cc * dz;
            grad[1 + 3 * j] += cc * dx;
            grad[2 + 3 * j] += cc * dy;
            grad[3 + 3 * j] += cc * dz;
        }
        grad[0] = 1.0 + gs;
        Ok(s + mu * pen)
    }
}

/// `ball-pieces.ts: legalizeBalls`: a valid configuration near the given centres. Coincident centres are first
/// moved apart deterministically, since scaling cannot separate them.
pub fn legalize_balls(problem: &BallsProblem, centres: &[Vec3], g: f64, w: f64) -> Result<BallsConfig, String> {
    let kind = container_kind(problem);
    let cont = solid_container(problem)?;
    let cube = kind == ContainerKind::Cube;
    let mut c: Vec<Vec3> = centres.to_vec();
    if cube {
        // the bounding box's centre to the origin
        let mut mid = [0.0f64; 3];
        for k in 0..3 {
            let mut lo = f64::INFINITY;
            let mut hi = f64::NEG_INFINITY;
            for p in &c {
                lo = math::min(lo, p[k]);
                hi = math::max(hi, p[k]);
            }
            mid[k] = (lo + hi) / 2.0;
        }
        for p in c.iter_mut() {
            *p = [p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]];
        }
    }
    let n = c.len();
    for i in 1..n {
        for j in 0..i {
            if c[i][0] == c[j][0] && c[i][1] == c[j][1] && c[i][2] == c[j][2] {
                // a step of 1.1 diameters along a spiral direction, different for each i
                let fi = i as f64;
                let phi = math::acos(1.0 - 2.0 * ((fi * 0.6180339887498949) % 1.0));
                let th = 2.399963229728653 * fi;
                let step = 1.1 * BALL_DIAMETER;
                c[i] = [
                    c[i][0] + step * math::sin(phi) * math::cos(th),
                    c[i][1] + step * math::sin(phi) * math::sin(th),
                    c[i][2] + step * math::cos(phi),
                ];
            }
        }
    }
    let mut dmin = f64::INFINITY;
    for i in 0..n {
        for j in i + 1..n {
            dmin = math::min(dmin, math::hypot3(c[i][0] - c[j][0], c[i][1] - c[j][1], c[i][2] - c[j][2]));
        }
    }
    if dmin < BALL_DIAMETER + g {
        // distances scale by k exactly up to rounding; 4 eps more absorbs it
        let k = ((BALL_DIAMETER + g) / dmin) * (1.0 + 4.0 * f64::EPSILON);
        for p in c.iter_mut() {
            *p = [p[0] * k, p[1] * k, p[2] * k];
        }
    }
    let mut s = 0.0f64;
    for p in &c {
        let v = if cube {
            2.0 * math::max_of(&[math::abs(p[0]), math::abs(p[1]), math::abs(p[2])]) + 2.0 * BALL_RADIUS + 2.0 * w
        } else if let Some(cont) = &cont {
            size_for(cont, BALL_RADIUS + w, p[0], p[1], p[2])
        } else {
            ball_container_score(math::hypot3(p[0], p[1], p[2]) + BALL_RADIUS + w)
        };
        s = math::max(s, v);
    }
    Ok(BallsConfig { s: s * (1.0 + 4.0 * f64::EPSILON), pieces: c.into_iter().map(|p| p.to_vec()).collect() })
}

/// The centres of a configuration of balls.
pub fn centres_of(c: &BallsConfig) -> Vec<Vec3> {
    c.pieces.iter().map(|p| [p[0], p[1], p[2]]).collect()
}

/// `ball-pieces.ts: polishBalls`: penalty polish of the centres at size s, then legalization; on a stop, at an
/// evaluation or between the stages, the `partial` of the stop holds the last finite iterate, legalized.
pub fn polish_balls(
    problem: &BallsProblem,
    start: &BallsConfig,
    tk: &mut Ticker,
    clearance: f64,
    mus: &[f64],
) -> Result<BallsConfig, Fail> {
    let n = start.pieces.len();
    let kind = container_kind(problem);
    let cont = solid_container(problem)?;
    let g = clearance;
    let w = clearance;
    let mut z = vec![0.0f64; 1 + 3 * n];
    z[0] = start.s;
    for (i, p) in start.pieces.iter().enumerate() {
        z[1 + 3 * i] = p[0];
        z[2 + 3 * i] = p[1];
        z[3 + 3 * i] = p[2];
    }
    let iters = 300 + 10 * n;
    let centres = |y: &[f64]| -> Vec<Vec3> { (0..n).map(|i| [y[1 + 3 * i], y[2 + 3 * i], y[3 + 3 * i]]).collect() };
    // the iterate before the stage under way, for a stop that comes after the stage's iterate stopped being finite
    let mut last = z.clone();
    for &mu in mus {
        last.copy_from_slice(&z);
        let stage = (|| -> Result<(), Stop> {
            tk.poll()?;
            let mut obj = Objective::new(kind, cont.as_deref(), n, mu, g, w);
            lbfgs(&mut |zz: &[f64], gg: &mut [f64]| obj.eval(zz, gg, tk), &mut z, iters, 8, 1e-12)?;
            Ok(())
        })();
        if let Err(mut e) = stage {
            // every stop hands over the last finite iterate, legalized (the legalization is a sweep over the pairs)
            let at = if z.iter().all(|v| v.is_finite()) { &z } else { &last };
            e.partial = Some(legalize_balls(problem, &centres(at), g, w)?);
            return Err(Fail::Stop(e));
        }
        if !z.iter().all(|v| v.is_finite()) {
            break;
        }
    }
    Ok(legalize_balls(problem, &centres(&z), g, w)?)
}

// ------------------------------------------------------------------ starts

/// `ball-pieces.ts: latticePoints`: points of a lattice packing of unit balls (nearest neighbours 2 r apart)
/// within radius `reach` of the origin.
fn lattice_points(kind: &str, reach: f64) -> Vec<Vec3> {
    let mut out: Vec<Vec3> = Vec::new();
    let d = BALL_DIAMETER;
    if kind == "fcc" {
        // the cubic setting: a / 2 (i, j, k) with i + j + k even, a = 2 sqrt 2 r
        let h = BALL_RADIUS * math::SQRT2;
        let m = math::ceil(reach / h) as i64 + 1;
        for i in -m..=m {
            for j in -m..=m {
                for k in -m..=m {
                    if (i + j + k).rem_euclid(2) == 0 {
                        out.push([i as f64 * h, j as f64 * h, k as f64 * h]);
                    }
                }
            }
        }
    } else if kind == "sc" {
        let m = math::ceil(reach / d) as i64 + 1;
        for i in -m..=m {
            for j in -m..=m {
                for k in -m..=m {
                    out.push([d * i as f64, d * j as f64, d * k as f64]);
                }
            }
        }
    } else {
        // hexagonal layers of spacing 2 r, stacked ABAB at height 2 r sqrt(2/3)
        let dz = d * math::sqrt(2.0 / 3.0);
        let m = math::ceil(reach / d) as i64 + 2;
        let mz = math::ceil(reach / dz) as i64 + 1;
        let sqrt3 = math::sqrt(3.0);
        for l in -mz..=mz {
            let off = if l.rem_euclid(2) == 1 { [BALL_RADIUS, BALL_RADIUS / sqrt3] } else { [0.0, 0.0] };
            for i in -m..=m {
                for j in -m..=m {
                    let (fi, fj) = (i as f64, j as f64);
                    out.push([d * fi + BALL_RADIUS * fj + off[0], BALL_RADIUS * fj * sqrt3 + off[1], l as f64 * dz]);
                }
            }
        }
    }
    out.retain(|p| math::hypot3(p[0], p[1], p[2]) <= reach);
    out
}

/// `ball-pieces.ts: gauge`: the scale of the solid C that just holds a point, max_f N_f . x / b_f.
fn gauge(c: &Container, x: f64, y: f64, z: f64) -> f64 {
    let n = c.n();
    let b = c.b();
    let mut g = f64::NEG_INFINITY;
    for f in 0..c.f {
        g = math::max(g, (n[3 * f] * x + n[3 * f + 1] * y + n[3 * f + 2] * z) / b[f]);
    }
    g
}

/// `ball-pieces.ts: latticeCut`: the P points of a turned and shifted lattice nearest the centre in the
/// container's norm. For a solid container (other than the cube) the norm is its gauge, and the lattice is
/// made large enough to hold every point whose gauge is at most the P-th smallest one: such a point lies within
/// g Rc of the origin (Rc the circumradius), so within g Rc + sqrt 3 r before the shift.
pub fn lattice_cut(problem: &BallsProblem, p: usize, rng: &mut Rng, kind: &str, turn: bool) -> Result<Vec<Vec3>, String> {
    let ck = container_kind(problem);
    let cube = ck == ContainerKind::Cube;
    let cont = solid_container(problem)?;
    let mut reach = BALL_DIAMETER * math::cbrt(p as f64) + 6.0 * BALL_RADIUS;
    let rot = if turn { rotation_of(&random_quaternion(rng)) } else { [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] };
    let t0 = BALL_RADIUS * (2.0 * rng.next() - 1.0);
    let t1 = BALL_RADIUS * (2.0 * rng.next() - 1.0);
    let t2 = BALL_RADIUS * (2.0 * rng.next() - 1.0);
    let make = |reach: f64| -> Vec<Vec3> {
        lattice_points(kind, reach)
            .into_iter()
            .map(|q| {
                [
                    rot[0] * q[0] + rot[1] * q[1] + rot[2] * q[2] + t0,
                    rot[3] * q[0] + rot[4] * q[1] + rot[5] * q[2] + t1,
                    rot[6] * q[0] + rot[7] * q[1] + rot[8] * q[2] + t2,
                ]
            })
            .collect()
    };
    let mut pts = make(reach);
    let norm = |q: &Vec3| -> f64 {
        if let Some(c) = &cont {
            gauge(c, q[0], q[1], q[2])
        } else if cube {
            math::max_of(&[math::abs(q[0]), math::abs(q[1]), math::abs(q[2])])
        } else {
            math::hypot3(q[0], q[1], q[2])
        }
    };
    if let Some(c) = &cont {
        loop {
            // the P-th smallest gauge; with fewer than P points it is undefined and the test fails at `pts.length >= P`
            let enough = pts.len() >= p && {
                let mut gs: Vec<f64> = pts.iter().map(&norm).collect();
                gs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                gs[p - 1] * c.circumradius + math::sqrt(3.0) * BALL_RADIUS <= reach
            };
            if enough {
                break;
            }
            reach *= 1.5;
            pts = make(reach);
        }
    }
    // ties broken by a small random key, so that equal shells are cut differently from seed to seed
    let mut keyed: Vec<(f64, Vec3)> = pts.into_iter().map(|q| (norm(&q) + 1e-9 * rng.next(), q)).collect();
    keyed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(keyed.into_iter().take(p).map(|e| e.1).collect())
}

/// `ball-pieces.ts: centreIn`: a centre uniformly at random where a ball fits in the container of size s (the
/// origin when none does). For a solid container (other than the cube) by rejection from the bounding box of
/// the shrunk container, then, if few points are accepted, from the scaled copy (s - r / rho) C, which lies
/// inside it.
pub fn centre_in(problem: &BallsProblem, s: f64, rng: &mut Rng) -> Result<Vec3, String> {
    let ck = container_kind(problem);
    if ck == ContainerKind::Cube {
        let h = math::max(0.0, s / 2.0 - BALL_RADIUS);
        let x = h * (2.0 * rng.next() - 1.0);
        let y = h * (2.0 * rng.next() - 1.0);
        let z = h * (2.0 * rng.next() - 1.0);
        return Ok([x, y, z]);
    }
    if ck == ContainerKind::Ball {
        // uniform in the ball of radius s - r
        let r = math::max(0.0, ball_container_radius(s) - BALL_RADIUS) * math::cbrt(rng.next());
        let u = 2.0 * rng.next() - 1.0;
        let phi = 2.0 * math::PI * rng.next();
        let q = math::sqrt(1.0 - u * u);
        return Ok([r * q * math::cos(phi), r * q * math::sin(phi), r * u]);
    }
    let c = container_of_problem(problem)?.expect("a solid container has its geometry");
    let in_box = |scale: f64, rng: &mut Rng| -> Vec3 {
        let x = scale * (c.lo[0] + (c.hi[0] - c.lo[0]) * rng.next());
        let y = scale * (c.lo[1] + (c.hi[1] - c.lo[1]) * rng.next());
        let z = scale * (c.lo[2] + (c.hi[2] - c.lo[2]) * rng.next());
        [x, y, z]
    };
    let nn = c.n();
    let b = c.b();
    for _t in 0..60 {
        let p = in_box(s, rng);
        let mut ok = true;
        let mut f = 0;
        while f < c.f && ok {
            ok = nn[3 * f] * p[0] + nn[3 * f + 1] * p[1] + nn[3 * f + 2] * p[2] <= s * b[f] - BALL_RADIUS;
            f += 1;
        }
        if ok {
            return Ok(p);
        }
    }
    let k = s - BALL_RADIUS / c.inradius;
    if k > 0.0 {
        for _t in 0..200 {
            let p = in_box(k, rng);
            if gauge(&c, p[0], p[1], p[2]) <= k {
                return Ok(p);
            }
        }
    }
    Ok([0.0, 0.0, 0.0])
}

/// `ball-pieces.ts: randomCentres`: random centres in a container about 30 % larger than the lower bound's.
pub fn random_centres(problem: &BallsProblem, p: usize, rng: &mut Rng) -> Result<BallsConfig, String> {
    let s = 1.3 * balls_bound(problem, p as f64)?.value;
    let mut pieces = Vec::with_capacity(p);
    for _ in 0..p {
        pieces.push(centre_in(problem, s, rng)?.to_vec());
    }
    Ok(BallsConfig { s, pieces })
}

/// `ball-pieces.ts: freshStart`: a new start, random centres or a lattice cut (legalized with the clearance g),
/// chosen by the seed.
pub fn fresh_start(problem: &BallsProblem, p: usize, rng: &mut Rng, g: f64) -> Result<BallsConfig, String> {
    let ck = container_kind(problem);
    let r = rng.next();
    if r < 0.4 {
        return random_centres(problem, p, rng);
    }
    let kinds: &[(&str, bool)] = match ck {
        ContainerKind::Ball => &[("fcc", true), ("hcp", true)],
        ContainerKind::Cube => &[("fcc", false), ("sc", false), ("fcc", true), ("hcp", true)],
        ContainerKind::Polyhedron => &[("fcc", false), ("hcp", false), ("sc", false), ("fcc", true), ("hcp", true)],
    };
    let (kind, turn) = kinds[math::floor(rng.next() * kinds.len() as f64) as usize];
    let c = lattice_cut(problem, p, rng, kind, turn)?;
    legalize_balls(problem, &c, g, g)
}

/// `hops` of `hopBalls`: "holes" (the default) also moves the loosest balls into the largest holes found by
/// sampling; "plain" is the hop of the first compute sweep (random places or a shake only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hops {
    Holes,
    Plain,
}

/// `ball-pieces.ts: hopBalls`: a hop from a configuration: move one to three balls to random places, move one
/// or two of the loosest balls into the largest holes found by sampling, or shake every ball by a small normal
/// step, in a container 0.5 to 4 % larger.
pub fn hop_balls(problem: &BallsProblem, b: &BallsConfig, rng: &mut Rng, hops: Hops) -> Result<BallsConfig, String> {
    let p = b.pieces.len();
    let e = 1.0 + 0.005 + 0.035 * rng.next();
    let s = b.s * e;
    let mut pieces: Vec<Vec3> = b.pieces.iter().map(|q| [q[0] * e, q[1] * e, q[2] * e]).collect();
    let r = rng.next();
    let first = if hops == Hops::Plain { r < 0.55 } else { r < 0.4 || p < 3 };
    if first {
        let k = 1 + math::floor(rng.next() * math::min(3.0, p as f64)) as usize;
        for _t in 0..k {
            // the index is evaluated before the right-hand side
            let i = math::floor(rng.next() * p as f64) as usize;
            pieces[i] = centre_in(problem, s, rng)?;
        }
    } else if r < 0.7 && hops == Hops::Holes {
        // into holes: one or two of the loosest balls (fewest neighbours within 1.05 diameters, ties at random)
        // each go to the best of 64 random places, the one farthest from every other centre
        let mut near: Vec<(usize, f64)> = Vec::with_capacity(p);
        for i in 0..p {
            let q = pieces[i];
            let mut m = 0.0;
            for j in 0..p {
                if j != i
                    && math::hypot3(q[0] - pieces[j][0], q[1] - pieces[j][1], q[2] - pieces[j][2]) < 1.05 * BALL_DIAMETER * e
                {
                    m += 1.0;
                }
            }
            near.push((i, m + rng.next()));
        }
        near.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let k = 1 + math::floor(rng.next() * 2.0) as usize;
        for t in 0..k {
            let i = near[t].0;
            let mut best = pieces[i];
            let mut far = f64::NEG_INFINITY;
            for _n in 0..64 {
                let x = centre_in(problem, s, rng)?;
                let mut d = f64::INFINITY;
                for j in 0..p {
                    if j != i {
                        d = math::min(d, math::hypot3(x[0] - pieces[j][0], x[1] - pieces[j][1], x[2] - pieces[j][2]));
                    }
                }
                if d > far {
                    far = d;
                    best = x;
                }
            }
            pieces[i] = best;
        }
    } else {
        let sigma = BALL_RADIUS * (0.02 + 0.25 * rng.next() * rng.next());
        for q in pieces.iter_mut() {
            for k in 0..3 {
                q[k] += sigma * gauss(rng);
            }
        }
    }
    Ok(BallsConfig { s, pieces: pieces.into_iter().map(|q| q.to_vec()).collect() })
}
