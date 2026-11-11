//! Lattice and symmetry seeds (packages/solver/src/methods/seed.ts and seed/lattice.ts): valid
//! starts from lattice cuts (square, hexagonal, the pentagon double lattice), rows, and symmetric
//! rings, interleaved round-robin and each assessed. The record generators of the reference need
//! an adjacent record and are not used by the volunteer engine.

use crate::math;
use crate::framework::Ctx;
use crate::sep::piece_separation;
use crate::shapes::{bounding_radius, circumradius, container_vertices, default_theta, inradius, piece_inradius, Config, Container, Pose, DISK_RADIUS};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::f64::consts::PI;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub kind: String,
    pub trials: u32,
    pub orientation: f64,
    pub automatic_orientation: bool,
    pub lattice_angle: f64,
    pub angle_range: f64,
    pub orientation_range: f64,
    pub offset_range: f64,
    pub per_row: u32,
    pub alternate_rows: bool,
    pub per_ring: u32,
    pub record_trials: u32,
    pub pool_limit: u32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            kind: "auto".into(),
            trials: 12,
            orientation: 0.0,
            automatic_orientation: true,
            lattice_angle: 0.0,
            angle_range: PI / 2.0,
            orientation_range: 0.0,
            offset_range: 1.0,
            per_row: 0,
            alternate_rows: false,
            per_ring: 0,
            record_trials: 128,
            pool_limit: 8,
        }
    }
}

impl Params {
    pub fn check(&self) -> Result<(), String> {
        let kinds = ["square_lattice", "hex_lattice", "pentagon_double_lattice", "rings", "rows", "auto"];
        if !kinds.contains(&self.kind.as_str()) {
            return Err(format!("seed kind {} is not available", self.kind));
        }
        if !(1..=256).contains(&self.trials) || self.pool_limit > 64 {
            return Err("seed parameters out of range".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
struct Trial {
    angle: f64,
    orientation: f64,
    offset: [f64; 2],
}

#[derive(Clone, Debug)]
pub struct Cell {
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub motif: Vec<Pose>,
}

pub fn rotate(p: &Pose, angle: f64) -> Pose {
    let (s, c) = math::sin_cos(angle);
    Pose::new(c * p.x - s * p.y, s * p.x + c * p.y, p.theta + angle)
}

/// Side-one ice-ray cell of the pentagon double lattice (Kuperberg & Kuperberg 1990, see seed.md).
fn pentagon_cell() -> Cell {
    let r = circumradius(5);
    let x = r * math::sin(2.0 * PI / 5.0);
    let y = r * math::cos(2.0 * PI / 5.0);
    Cell {
        a: [3.0 * x, 0.0],
        b: [0.0, r + inradius(5)],
        motif: vec![Pose::new(0.0, 0.0, 0.0), Pose::new(3.0 * x / 2.0, (r + 3.0 * y) / 2.0, PI)],
    }
}

fn base_cell(n: u32, hex: bool, theta: f64) -> Cell {
    let h = 3f64.sqrt() / 2.0;
    if n == 3 {
        // a honeycomb of triangle centroids: two orientations per triangular cell, or four per
        // rectangular cell, decorating the same exact plane tiling
        let cell = if hex {
            Cell { a: [1.0, 0.0], b: [0.5, h], motif: vec![Pose::new(0.0, 0.0, 0.0), Pose::new(0.5, h / 3.0, PI)] }
        } else {
            Cell {
                a: [1.0, 0.0],
                b: [0.0, 2.0 * h],
                motif: vec![
                    Pose::new(0.0, 0.0, 0.0),
                    Pose::new(0.5, h / 3.0, PI),
                    Pose::new(0.5, h, 0.0),
                    Pose::new(1.0, 4.0 * h / 3.0, PI),
                ],
            }
        };
        let (s, c) = math::sin_cos(theta);
        return Cell {
            a: [cell.a[0] * c, cell.a[0] * s],
            b: [cell.b[0] * c - cell.b[1] * s, cell.b[0] * s + cell.b[1] * c],
            motif: cell.motif.iter().map(|p| rotate(p, theta)).collect(),
        };
    }
    Cell { a: [1.0, 0.0], b: if hex { [0.5, h] } else { [0.0, 1.0] }, motif: vec![Pose::new(0.0, 0.0, theta)] }
}

/// Smallest uniform dilation of a cell without overlap, testing only translates that can still
/// make contact (inscribed disks give the lower bound; beyond 2R at it a translate cannot decide).
fn tight_scale(ctx: &mut Ctx, n: u32, cell: &Cell) -> Option<f64> {
    let reach = 2.0 * bounding_radius(n);
    struct V {
        dx: f64,
        dy: f64,
        ta: f64,
        tb: f64,
        distance: f64,
    }
    let mut vectors = Vec::new();
    let mut shortest = f64::INFINITY;
    for i in -4i32..=4 {
        for j in -4i32..=4 {
            for (u, a) in cell.motif.iter().enumerate() {
                for (v, b) in cell.motif.iter().enumerate() {
                    if i == 0 && j == 0 && u == v {
                        continue;
                    }
                    let dx = i as f64 * cell.a[0] + j as f64 * cell.b[0] + b.x - a.x;
                    let dy = i as f64 * cell.a[1] + j as f64 * cell.b[1] + b.y - a.y;
                    let distance = math::hypot(dx, dy);
                    shortest = shortest.min(distance);
                    vectors.push(V { dx, dy, ta: a.theta, tb: b.theta, distance });
                }
            }
        }
    }
    let mut scale = 2.0 * piece_inradius(n) / shortest;
    vectors.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap_or(std::cmp::Ordering::Equal));
    for v in &vectors {
        if !ctx.checkpoint() {
            return None;
        }
        if v.distance * scale > reach * (1.0 + 1e-12) {
            continue;
        }
        let mut lo = 0.0;
        let mut hi = reach / v.distance;
        let origin = Pose::new(0.0, 0.0, v.ta);
        for _ in 0..44 {
            let mid = (lo + hi) / 2.0;
            if piece_separation(n, &origin, &Pose::new(mid * v.dx, mid * v.dy, v.tb), 1.0).sep < 0.0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        scale = scale.max(hi);
    }
    Some(scale * (1.0 + 2e-13))
}

/// Contact calculations cached within one run.
#[derive(Default)]
struct SpacingCache {
    scales: Vec<(String, f64)>,
    orientations: Vec<(String, f64)>,
}

impl SpacingCache {
    fn scale(&mut self, ctx: &mut Ctx, kind: &str, cell: &Cell, orientation: f64) -> Option<f64> {
        let n = ctx.problem.n;
        let key = format!("{kind}:{}", if n == 3 { 0.0 } else { orientation });
        if let Some((_, s)) = self.scales.iter().find(|(k, _)| *k == key) {
            return Some(*s);
        }
        let s = tight_scale(ctx, n, cell)?;
        self.scales.push((key, s));
        Some(s)
    }

    /// Piece orientation of the smallest cell area of a lattice (scan and golden section).
    fn optimum(&mut self, ctx: &mut Ctx, hex: bool) -> Option<f64> {
        let n = ctx.problem.n;
        let key = format!("{n}:{hex}");
        if let Some((_, s)) = self.orientations.iter().find(|(k, _)| *k == key) {
            return Some(*s);
        }
        if n == 0 || n == 3 || n == 4 || n == 8 || (n == 6 && hex) {
            return Some(default_theta(n));
        }
        let end = PI / n as f64;
        let steps = 24;
        let mut best = 0.0;
        let mut smallest = f64::INFINITY;
        let kind = format!("orientation-{hex}");
        let value = |me: &mut Self, ctx: &mut Ctx, theta: f64| -> Option<f64> {
            let cell = base_cell(n, hex, theta);
            Some(me.scale(ctx, &kind, &cell, theta).unwrap_or(f64::INFINITY))
        };
        for i in 0..=steps {
            if ctx.should_stop() {
                return None;
            }
            let theta = end * i as f64 / steps as f64;
            let s = value(self, ctx, theta)?;
            if s < smallest {
                smallest = s;
                best = theta;
            }
        }
        let mut lo = (best - end / steps as f64).max(0.0);
        let mut hi = (best + end / steps as f64).min(end);
        let golden = (5f64.sqrt() - 1.0) / 2.0;
        let mut left = hi - golden * (hi - lo);
        let mut right = lo + golden * (hi - lo);
        let mut lv = value(self, ctx, left)?;
        let mut rv = value(self, ctx, right)?;
        for _ in 0..30 {
            if ctx.should_stop() {
                return None;
            }
            if lv < rv {
                hi = right;
                right = left;
                rv = lv;
                left = hi - golden * (hi - lo);
                lv = value(self, ctx, left)?;
            } else {
                lo = left;
                left = right;
                lv = rv;
                right = lo + golden * (hi - lo);
                rv = value(self, ctx, right)?;
            }
        }
        if lv.min(rv) < smallest {
            best = if lv < rv { left } else { right };
        }
        self.orientations.push((key, best));
        Some(best)
    }
}

/// The rank of a site: how large the container at phi = 0 must be to hold a piece there.
fn ranker(n: u32, m: u32, theta: f64) -> impl Fn(f64, f64) -> f64 {
    let vertices: Vec<f64> = if n == 0 { vec![0.0, 0.0] } else { crate::shapes::piece_vertices(n, &Pose::new(0.0, 0.0, theta), 1.0) };
    let pad = if n == 0 { DISK_RADIUS } else { 0.0 };
    let normals: Vec<(f64, f64, f64)> = if m == 0 {
        Vec::new()
    } else {
        (0..m)
            .map(|edge| {
                let angle = -PI / 2.0 + 2.0 * PI * edge as f64 / m as f64;
                let (ny, nx) = math::sin_cos(angle);
                let mut support = f64::NEG_INFINITY;
                for k in (0..vertices.len()).step_by(2) {
                    support = support.max(nx * vertices[k] + ny * vertices[k + 1] + pad);
                }
                (nx, ny, support)
            })
            .collect()
    };
    move |x: f64, y: f64| {
        if m == 0 {
            let mut rank = 0.0f64;
            for k in (0..vertices.len()).step_by(2) {
                rank = rank.max(math::hypot(x + vertices[k], y + vertices[k + 1]) + pad);
            }
            rank
        } else {
            let mut rank = f64::NEG_INFINITY;
            for &(nx, ny, s) in &normals {
                rank = rank.max(x * nx + y * ny + s);
            }
            rank
        }
    }
}

/// The P lattice sites of lowest rank: the cut of the lattice by a growing container.
fn lattice_cut(ctx: &mut Ctx, cell: &Cell, scale: f64, angle: f64, offset: [f64; 2]) -> Option<Vec<Pose>> {
    let (n, m, p) = (ctx.problem.n, ctx.problem.m, ctx.problem.p);
    let extent = ((p as f64 / cell.motif.len() as f64).sqrt().ceil() as i64) + 3;
    let (s, c) = math::sin_cos(angle);
    let ranks: Vec<_> = cell.motif.iter().map(|q| ranker(n, m, q.theta + angle)).collect();
    let mut sites: Vec<(Pose, f64)> = Vec::new();
    for i in -extent..=extent {
        if !ctx.checkpoint() {
            return None;
        }
        for j in -extent..=extent {
            for (k, q) in cell.motif.iter().enumerate() {
                let x = scale * ((i as f64 + offset[0]) * cell.a[0] + (j as f64 + offset[1]) * cell.b[0] + q.x);
                let y = scale * ((i as f64 + offset[0]) * cell.a[1] + (j as f64 + offset[1]) * cell.b[1] + q.y);
                let pose = Pose::new(c * x - s * y, s * x + c * y, q.theta + angle);
                let rank = ranks[k](pose.x, pose.y);
                sites.push((pose, rank));
            }
        }
    }
    sites.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.y.partial_cmp(&b.0.y).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.0.x.partial_cmp(&b.0.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    Some(sites.into_iter().take(p).map(|s| s.0).collect())
}

/// k^2 unit triangles tile a triangle of side k; partial cuts stay valid.
fn triangle_block(p: usize, angle: f64) -> Vec<Pose> {
    let k = (p as f64).sqrt().ceil() as usize;
    let h = 3f64.sqrt() / 2.0;
    let kf = k as f64;
    let mut pieces = Vec::new();
    for row in 0..k {
        for col in 0..k - row {
            let (r, c) = (row as f64, col as f64);
            pieces.push(rotate(&Pose::new(-kf / 2.0 + 0.5 + c + r / 2.0, -kf * h / 3.0 + h / 3.0 + r * h, 0.0), angle));
            if col < k - row - 1 {
                pieces.push(rotate(&Pose::new(-kf / 2.0 + 1.0 + c + r / 2.0, -kf * h / 3.0 + 2.0 * h / 3.0 + r * h, PI), angle));
            }
        }
    }
    pieces.truncate(p);
    pieces
}

enum Kind {
    Square,
    Hex,
    Pentagon,
    Rows,
    Rings,
}

struct Generator {
    kind: Kind,
    t: usize,
    seen: HashSet<String>,
    // rows
    widths: Vec<usize>,
    pitches: Vec<(u64, [f64; 2])>,
}

fn ring_reason(ctx: &Ctx, p: &Params) -> Option<&'static str> {
    let (n, m, pp) = (ctx.problem.n, ctx.problem.m, ctx.problem.p);
    if m == 0 {
        return None;
    }
    let count = p.per_ring;
    if count != 0 && count % m != 0 {
        return Some("polygon rings require perRing to be zero or a multiple of M");
    }
    let remainder = pp % m as usize;
    if remainder != 0 && remainder != 1 {
        return Some("D_M rings require P to be a multiple of M, or one more");
    }
    if remainder == 1 && n != 0 && n % m != 0 {
        return Some("a central polygon has D_M symmetry only when M divides N");
    }
    if p.orientation != 0.0 || p.orientation_range != 0.0 {
        return Some("D_M rings require orientation and orientationRange to be zero");
    }
    None
}

fn config(ctx: &Ctx, pieces: Vec<Pose>) -> Config {
    Config { n: ctx.problem.n, m: ctx.problem.m, pieces, phi: 0.0 }
}

/// Bisected contact distance of a piece translated from the origin, horizontally or vertically.
fn row_contact(n: u32, theta: f64, offset: f64, horizontal: bool) -> f64 {
    let origin = Pose::new(0.0, 0.0, theta);
    let mut lo = 0.0;
    let mut hi = 2.0 * bounding_radius(n);
    for _ in 0..44 {
        let mid = (lo + hi) / 2.0;
        let p = if horizontal { Pose::new(mid, 0.0, theta) } else { Pose::new(offset, mid, theta) };
        if piece_separation(n, &origin, &p, 1.0).sep < 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    hi
}

fn row_pitch(n: u32, theta: f64, shifted: bool) -> [f64; 2] {
    let dx = row_contact(n, theta, 0.0, true);
    let vertical = row_contact(n, theta, 0.0, false);
    let left = if shifted { row_contact(n, theta, -dx / 2.0, false) } else { vertical };
    let right = if shifted { row_contact(n, theta, dx / 2.0, false) } else { vertical };
    [dx * (1.0 + 2e-13), left.max(right).max(if shifted { vertical / 2.0 } else { vertical }) * (1.0 + 2e-13)]
}

impl Generator {
    fn next(&mut self, ctx: &mut Ctx, p: &Params, trials: &[Trial], cache: &mut SpacingCache) -> Option<Config> {
        match self.kind {
            Kind::Square | Kind::Hex | Kind::Pentagon => self.next_lattice(ctx, p, trials, cache),
            Kind::Rows => self.next_row(ctx, p, trials, cache),
            Kind::Rings => self.next_ring(ctx, p, trials),
        }
    }

    fn next_lattice(&mut self, ctx: &mut Ctx, p: &Params, trials: &[Trial], cache: &mut SpacingCache) -> Option<Config> {
        let (n, m, pp) = (ctx.problem.n, ctx.problem.m, ctx.problem.p);
        let pentagon = matches!(self.kind, Kind::Pentagon);
        let hex = matches!(self.kind, Kind::Hex);
        while self.t < trials.len() {
            if !ctx.checkpoint() {
                return None;
            }
            let t = self.t;
            self.t += 1;
            let trial = trials[t];
            if n == 3 && m == 3 && t == 0 {
                return Some(config(ctx, triangle_block(pp, trial.orientation + trial.angle)));
            }
            let mut orientation = trial.orientation;
            let mut angle = if m == 0 { 0.0 } else { trial.angle };
            if t == 4 && p.automatic_orientation && !pentagon {
                let optimum = cache.optimum(ctx, hex)?;
                orientation = optimum + p.orientation;
                angle = if m == 0 { 0.0 } else { p.lattice_angle };
            }
            // circle-container rotations, and triangle-cell rotations, do not change a cut
            let key = format!(
                "{}:{}:{},{}",
                if n == 3 && m == 0 { trials[0].orientation } else { orientation },
                angle,
                trial.offset[0],
                trial.offset[1]
            );
            if !self.seen.insert(key) {
                continue;
            }
            let mut cell = if pentagon { pentagon_cell() } else { base_cell(n, hex, orientation) };
            if hex && n == 6 {
                // the vertex-up convention puts face normals at theta (mod pi/3)
                let a = rotate(&Pose::new(cell.a[0], cell.a[1], 0.0), orientation);
                let b = rotate(&Pose::new(cell.b[0], cell.b[1], 0.0), orientation);
                cell.a = [a.x, a.y];
                cell.b = [b.x, b.y];
            }
            let kind = if hex { "hex_lattice" } else { "square_lattice" };
            let scale = if pentagon { 1.0 } else { cache.scale(ctx, kind, &cell, orientation)? };
            if pentagon {
                angle += if m == 0 { 0.0 } else { orientation };
            }
            let pieces = lattice_cut(ctx, &cell, scale, angle, trial.offset)?;
            return Some(config(ctx, pieces));
        }
        None
    }

    fn next_row(&mut self, ctx: &mut Ctx, p: &Params, trials: &[Trial], cache: &mut SpacingCache) -> Option<Config> {
        let (n, m, pp) = (ctx.problem.n, ctx.problem.m, ctx.problem.p);
        let specified = p.per_row as usize;
        while self.t < trials.len() {
            if !ctx.checkpoint() {
                return None;
            }
            let t = self.t;
            self.t += 1;
            let trial = trials[t];
            if n == 3 && specified == 0 && t == 0 {
                return Some(config(ctx, triangle_block(pp, trial.orientation + trial.angle)));
            }
            let width = if specified > 0 { specified } else { self.widths[t % self.widths.len()] };
            let angle = if m == 0 { 0.0 } else { trial.angle };
            let key = format!("{}:{}", width.min(pp), if n == 3 { 0.0 } else { trial.orientation });
            if !self.seen.insert(key) {
                continue;
            }
            let mut scale = 1.0;
            let mut pitch = [0.0, 0.0];
            if n == 3 {
                scale = cache.scale(ctx, "triangle-rows", &base_cell(n, false, trial.orientation), trial.orientation)?;
            } else {
                let bits = trial.orientation.to_bits();
                pitch = match self.pitches.iter().find(|(k, _)| *k == bits) {
                    Some((_, v)) => *v,
                    None => {
                        let v = row_pitch(n, trial.orientation, p.alternate_rows);
                        self.pitches.push((bits, v));
                        v
                    }
                };
            }
            let s3 = 3f64.sqrt();
            let mut pieces = Vec::with_capacity(pp);
            for i in 0..pp {
                let row = (i / width) as f64;
                let col = i % width;
                let pose = if n == 3 {
                    Pose::new(
                        scale * ((col / 2) as f64 + (col % 2) as f64 / 2.0 + (row as usize % 2) as f64 / 2.0),
                        scale * (row * s3 / 2.0 + (col % 2) as f64 * s3 / 6.0),
                        (col % 2) as f64 * PI,
                    )
                } else {
                    let shift = if p.alternate_rows { (row as usize % 2) as f64 / 2.0 } else { 0.0 };
                    Pose::new(pitch[0] * (col as f64 + shift), row * pitch[1], trial.orientation)
                };
                pieces.push(rotate(&pose, angle + if n == 3 { trial.orientation } else { 0.0 }));
            }
            return Some(config(ctx, pieces));
        }
        None
    }

    fn next_ring(&mut self, ctx: &mut Ctx, p: &Params, trials: &[Trial]) -> Option<Config> {
        let (n, m, pp) = (ctx.problem.n, ctx.problem.m, ctx.problem.p);
        let reach = 2.0 * bounding_radius(n);
        let reach2 = (reach + 1e-10) * (reach + 1e-10);
        let polygon = if m == 0 { None } else { Some(container_vertices(&Container { m, cx: 0.0, cy: 0.0, phi: 0.0, size: 1.0 })) };
        while self.t < trials.len() {
            if !ctx.checkpoint() {
                return None;
            }
            let t = self.t;
            self.t += 1;
            let trial = trials[t];
            let central = if m == 0 { pp == 1 || t % 2 == 0 } else { pp % m as usize == 1 };
            let small_polygon = m != 0 && pp <= m as usize + 1;
            let profile = format!(
                "{}:{}:{}",
                central,
                if n == 0 && m == 0 && pp <= 12 { 0 } else { t % 4 },
                if n == 0 { 0.0 } else { trial.orientation }
            );
            if !self.seen.insert(profile) {
                continue;
            }
            let mut pieces: Vec<Pose> = Vec::with_capacity(pp);
            struct Band {
                pieces: Vec<Pose>,
                low: f64,
                high: f64,
            }
            let mut bands: Vec<Band> = Vec::new();
            let nf = n as f64;
            let central_flip = if n != 0 && (t % 4 == 1 || t % 4 == 2) { PI / nf } else { 0.0 };
            let ring_flip = if n != 0 && t % 2 == 1 { PI / nf } else { 0.0 };
            if central {
                let centre = Pose::new(0.0, 0.0, if m == 0 { trial.orientation } else { -PI + central_flip });
                pieces.push(centre);
                bands.push(Band { pieces: vec![centre], low: 0.0, high: 0.0 });
            }
            let mut previous_scale = 0.0f64;
            let mut ring = 1usize;
            while pieces.len() < pp {
                if !ctx.checkpoint() {
                    return None;
                }
                let prescribed = p.per_ring as usize;
                let population = if prescribed > 0 {
                    prescribed
                } else if m == 0 {
                    if pp <= 12 {
                        pp
                    } else {
                        6 * ring
                    }
                } else if small_polygon {
                    m as usize
                } else {
                    m as usize * (2 * ring - if central { 0 } else { 1 })
                };
                let count = (pp - pieces.len()).min(population);
                let slots = if m == 0 { 0.0 } else { count as f64 / m as f64 };
                let units: Vec<Pose> = (0..count)
                    .map(|i| {
                        if m != 0 && !small_polygon {
                            let poly = polygon.as_ref().unwrap();
                            let edge = (i as f64 / slots).floor() as usize;
                            let fraction = (i as f64 % slots) / slots;
                            let next = (edge + 1) % m as usize;
                            let x = poly[2 * edge] * (1.0 - fraction) + poly[2 * next] * fraction;
                            let y = poly[2 * edge + 1] * (1.0 - fraction) + poly[2 * next + 1] * fraction;
                            let normal = -PI / 2.0 + 2.0 * PI * next as f64 / m as f64;
                            let theta = if n == 0 || n % m == 0 {
                                default_theta(n) + ring_flip
                            } else {
                                (if fraction == 0.0 { math::atan2(y, x) } else { normal }) - PI / 2.0 + ring_flip
                            };
                            return Pose::new(x, y, theta);
                        }
                        let phase = if (ring + if t % 4 == 2 { 1 } else { 0 }) % 2 == 0 { PI / count as f64 } else { 0.0 };
                        let angle = -PI / 2.0 + 2.0 * PI * i as f64 / count as f64 + phase;
                        Pose::new(
                            math::cos(angle),
                            math::sin(angle),
                            if n == 0 { 0.0 } else { angle - PI / 2.0 + if m == 0 { trial.orientation } else { ring_flip } },
                        )
                    })
                    .collect();
                let norms: Vec<f64> = units.iter().map(|q| math::hypot(q.x, q.y)).collect();
                let low_norm = norms.iter().cloned().fold(f64::INFINITY, f64::min);
                let high_norm = norms.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let mut min_distance = f64::INFINITY;
                for i in 0..count {
                    for j in 0..i {
                        min_distance = min_distance.min(math::hypot(units[i].x - units[j].x, units[i].y - units[j].y));
                    }
                }
                let make_ring = |scale: f64| -> Vec<Pose> { units.iter().map(|q| Pose::new(scale * q.x, scale * q.y, q.theta)).collect() };
                let feasible = |ctx: &mut Ctx, scale: f64| -> Option<bool> {
                    let added = make_ring(scale);
                    let mut scanned = 0usize;
                    for i in 0..added.len() {
                        let a = added[i];
                        let radius = scale * norms[i];
                        for band in &bands {
                            // radial intervals identify neighbouring rings rigorously
                            if radius - reach > band.high || radius + reach < band.low {
                                continue;
                            }
                            for b in &band.pieces {
                                scanned += 1;
                                if scanned % 256 == 0 && !ctx.checkpoint() {
                                    return None;
                                }
                                if (a.x - b.x).powi(2) + (a.y - b.y).powi(2) > reach2 {
                                    continue;
                                }
                                if piece_separation(n, &a, b, 1.0).sep < 0.0 {
                                    return Some(false);
                                }
                            }
                        }
                        for b in &added[..i] {
                            scanned += 1;
                            if scanned % 256 == 0 && !ctx.checkpoint() {
                                return None;
                            }
                            if (a.x - b.x).powi(2) + (a.y - b.y).powi(2) > reach2 {
                                continue;
                            }
                            if piece_separation(n, &a, b, 1.0).sep < 0.0 {
                                return Some(false);
                            }
                        }
                    }
                    Some(true)
                };
                let mut lo = previous_scale;
                let outer_radius = bands.last().map_or(0.0, |b| b.high);
                let mut hi = ((outer_radius + reach) / low_norm).max(reach / min_distance).max(previous_scale + reach);
                for _ in 0..40 {
                    let mid = (lo + hi) / 2.0;
                    if feasible(ctx, mid)? {
                        hi = mid;
                    } else {
                        lo = mid;
                    }
                }
                previous_scale = hi * (1.0 + 2e-13);
                let added = make_ring(previous_scale);
                pieces.extend_from_slice(&added);
                bands.push(Band { pieces: added, low: previous_scale * low_norm, high: previous_scale * high_norm });
                ring += 1;
            }
            return Some(config(ctx, pieces));
        }
        None
    }
}

/// Congruence signature of an arrangement: its score and the multiset of pairwise centre
/// distances (rounded to 1e-7), hashed. Rigid motions keep it; a practical filter, not a proof.
pub fn congruence_signature(config: &Config, score: f64) -> (i64, u32, u32) {
    let ps = &config.pieces;
    let mut distances: Vec<i64> = Vec::with_capacity(ps.len() * ps.len().saturating_sub(1) / 2);
    for i in 0..ps.len() {
        for j in 0..i {
            distances.push((math::hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y) / 1e-7).round() as i64);
        }
    }
    distances.sort_unstable();
    let mut first: u32 = 2166136261;
    let mut second: u32 = 5381;
    for v in distances {
        let lo = v as u32;
        let hi = (v >> 32) as u32;
        first = (first ^ lo).wrapping_mul(16777619);
        first = (first ^ hi).wrapping_mul(16777619);
        second = (second ^ lo).wrapping_mul(65599);
        second = (second ^ hi).wrapping_mul(65599);
    }
    ((score / 1e-7).round() as i64, first, second)
}

pub fn execute(ctx: &mut Ctx) {
    let p: Params = match serde_json::from_value(ctx.params().clone()) {
        Ok(p) => p,
        Err(e) => return ctx.fail(e.to_string()),
    };
    let (n, _m, pp) = (ctx.problem.n, ctx.problem.m, ctx.problem.p);
    let mut kinds: Vec<Kind> = Vec::new();
    match p.kind.as_str() {
        "auto" => {
            kinds.push(Kind::Square);
            kinds.push(Kind::Hex);
            if n == 5 {
                kinds.push(Kind::Pentagon);
            }
            kinds.push(Kind::Rows);
            if ring_reason(ctx, &p).is_none() && pp <= 100 {
                kinds.push(Kind::Rings);
            }
        }
        "square_lattice" => kinds.push(Kind::Square),
        "hex_lattice" => kinds.push(Kind::Hex),
        "pentagon_double_lattice" => {
            if n != 5 {
                return ctx.fail("pentagon_double_lattice applies only to N = 5");
            }
            kinds.push(Kind::Pentagon)
        }
        "rows" => kinds.push(Kind::Rows),
        "rings" => {
            if let Some(r) = ring_reason(ctx, &p) {
                return ctx.fail(r);
            }
            kinds.push(Kind::Rings)
        }
        other => return ctx.fail(format!("unknown seed kind {other}")),
    }
    let orientation = if p.automatic_orientation { default_theta(n) } else { 0.0 } + p.orientation;
    let anchors = [[0.0, 0.0], [0.5, 0.5], [0.5, 0.0], [0.0, 0.5]];
    let mut trials = Vec::new();
    for t in 0..p.trials as usize {
        // the same trial table for single and auto runs, whichever generators apply
        let r = [ctx.rng.next(), ctx.rng.next(), ctx.rng.next(), ctx.rng.next()];
        let offset = if t < 4 { anchors[t] } else { [r[2], r[3]] };
        trials.push(Trial {
            angle: p.lattice_angle + if t < 4 { 0.0 } else { (2.0 * r[0] - 1.0) * p.angle_range },
            orientation: orientation + if t < 4 { 0.0 } else { (2.0 * r[1] - 1.0) * p.orientation_range },
            offset: [offset[0] * p.offset_range, offset[1] * p.offset_range],
        });
    }
    let root = (pp as f64).sqrt().ceil() as usize;
    let mut widths: Vec<usize> = Vec::new();
    for w in [root, (pp as f64).sqrt().floor() as usize, root + 1, root.saturating_sub(2).max(1), 1, pp]
        .into_iter()
        .chain(1..=pp.min(trials.len()))
    {
        if !widths.contains(&w) {
            widths.push(w);
        }
    }
    let mut generators: Vec<Generator> = kinds
        .into_iter()
        .map(|kind| Generator { kind, t: 0, seen: HashSet::new(), widths: widths.clone(), pitches: Vec::new() })
        .collect();
    let mut cache = SpacingCache::default();
    let mut active = vec![true; generators.len()];
    struct Member {
        config: Config,
        score: f64,
        key: (i64, u32, u32),
    }
    let mut pool: Vec<Member> = Vec::new();
    let limit = p.pool_limit as usize;
    let mut emitted: HashSet<(i64, u32, u32)> = HashSet::new();
    let mut emitted_generator: HashSet<usize> = HashSet::new();
    while active.iter().any(|&a| a) {
        let mut initial: Vec<(Config, (i64, u32, u32))> = Vec::new();
        for i in 0..generators.len() {
            if !active[i] {
                continue;
            }
            if !ctx.checkpoint() {
                return;
            }
            let next = generators[i].next(ctx, &p, &trials, &mut cache);
            let Some(candidate) = next else {
                if ctx.should_stop() {
                    return;
                }
                active[i] = false;
                continue;
            };
            let Some(result) = ctx.evaluate(&candidate, true) else { return };
            if !result.valid {
                return ctx.fail("seed produced invalid geometry");
            }
            if limit > 0 {
                let mut c = candidate.clone();
                c.phi = result.container.unwrap().phi;
                let score = result.score.unwrap();
                let key = congruence_signature(&c, score);
                if let Some(prev) = pool.iter_mut().find(|m| m.key == key) {
                    if score < prev.score {
                        prev.config = c.clone();
                        prev.score = score;
                    }
                } else {
                    pool.push(Member { config: c.clone(), score, key });
                }
                pool.sort_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal));
                if pool.len() > limit {
                    pool.pop();
                }
                // finish the first round before emitting: each generator gets an evaluation
                if !emitted_generator.contains(&i) && !emitted.contains(&key) && !initial.iter().any(|m| m.1 == key) && emitted.len() + initial.len() < limit {
                    initial.push((c, key));
                    emitted_generator.insert(i);
                }
            }
        }
        for (c, key) in initial {
            if ctx.emit(&c).is_none() {
                return;
            }
            emitted.insert(key);
        }
    }
    for member in &pool {
        if emitted.contains(&member.key) {
            continue;
        }
        if emitted.len() >= limit {
            break;
        }
        if !ctx.checkpoint() {
            return;
        }
        if ctx.emit(&member.config).is_none() {
            return;
        }
        emitted.insert(member.key);
    }
}
