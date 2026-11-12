//! Shapes and conventions; port of packages/geometry/src/shapes.ts (PROMPT.md Section 2,
//! docs/ARCHITECTURE.md):
//!
//! - a polygon piece is a regular N-gon of side 1; N = 0 is a disk of diameter 1;
//! - an unrotated piece points a vertex straight up: vertex k sits at angle
//!   theta + pi/2 + 2 pi k / N about the centre;
//! - an unrotated polygon container has a horizontal bottom edge: vertex k sits at angle
//!   phi - pi/2 + pi/M + 2 pi k / M; M = 0 is a circle container;
//! - the score is the container side for a polygon container and the diameter for a circle;
//! - angles are radians.
//!
//! `Problem`, `Config` and `default_theta` are the search's own and have no counterpart in
//! shapes.ts.

use crate::math;
use std::f64::consts::PI;

/// shapes.ts: Pose. Position and orientation of one piece; theta is in radians and ignored for disks.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Deserialize)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    /// Absent in JSON: 0.
    #[serde(default)]
    pub theta: f64,
}

impl Pose {
    pub const fn new(x: f64, y: f64, theta: f64) -> Self {
        Pose { x, y, theta }
    }
}

/// shapes.ts: Container. An enclosing container. `size` is the side for a polygon container and the diameter for a
/// circle container (m = 0).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Container {
    pub m: u32,
    pub cx: f64,
    pub cy: f64,
    pub phi: f64,
    pub size: f64,
}

/// shapes.ts: DISK_RADIUS. Radius of a disk piece (N = 0): disk pieces have diameter 1.
pub const DISK_RADIUS: f64 = 0.5;
/// shapes.ts: MAX_SIDES.
pub const MAX_SIDES: u32 = 100;
/// shapes.ts: MAX_PIECES.
pub const MAX_PIECES: usize = 500;
/// shapes.ts: MAX_COORD. Largest |x| or |y| of a piece centre the server accepts.
pub const MAX_COORD: f64 = 1e6;

/// shapes.ts: isShapeCode, for a count already known to be a whole number: 0 (circle) or 3..=100
/// sides.
pub fn is_shape_code(n: u32) -> bool {
    n == 0 || (3..=MAX_SIDES).contains(&n)
}

/// shapes.ts: isShapeCode, for any JavaScript number (a query parameter read with `Number(...)`,
/// say): a whole number that is 0 or from 3 to MAX_SIDES. -0 is a shape code, as in the source.
pub fn is_shape_code_number(n: f64) -> bool {
    n.is_finite() && n.trunc() == n && (n == 0.0 || (n >= 3.0 && n <= MAX_SIDES as f64))
}

/// shapes.ts: isShapeCode, for a JSON value: a number that is a shape code. The shape as an
/// integer when it is one.
pub fn shape_code(v: &serde_json::Value) -> Option<u32> {
    match v.as_f64() {
        Some(n) if v.is_number() && is_shape_code_number(n) => Some(n as u32),
        _ => None,
    }
}

/// shapes.ts: circumradius. Circumradius of a regular n-gon of side 1.
#[inline]
pub fn circumradius(n: u32) -> f64 {
    1.0 / (2.0 * math::sin(PI / n as f64))
}

/// shapes.ts: inradius. Inradius (apothem) of a regular n-gon of side 1.
#[inline]
pub fn inradius(n: u32) -> f64 {
    1.0 / (2.0 * math::tan(PI / n as f64))
}

/// shapes.ts: pieceInradius. Inradius of a piece: the polygon's apothem, or the disk radius.
#[inline]
pub fn piece_inradius(n: u32) -> f64 {
    if n == 0 {
        DISK_RADIUS
    } else {
        inradius(n)
    }
}

/// shapes.ts: containerInradius. Apothem of a container of size 1: the polygon apothem, or 1/2 for a circle (size is the diameter).
#[inline]
pub fn container_inradius(m: u32) -> f64 {
    if m == 0 {
        0.5
    } else {
        inradius(m)
    }
}

/// shapes.ts: boundingRadius. Radius of the smallest circle about the piece centre containing the piece.
#[inline]
pub fn bounding_radius(n: u32) -> f64 {
    if n == 0 {
        DISK_RADIUS
    } else {
        circumradius(n)
    }
}

/// shapes.ts: pieceArea.
pub fn piece_area(n: u32) -> f64 {
    if n == 0 {
        PI * DISK_RADIUS * DISK_RADIUS
    } else {
        n as f64 / (4.0 * math::tan(PI / n as f64))
    }
}

/// shapes.ts: containerArea.
pub fn container_area(m: u32, size: f64) -> f64 {
    if m == 0 {
        PI * size * size / 4.0
    } else {
        m as f64 * size * size / (4.0 * math::tan(PI / m as f64))
    }
}

/// shapes.ts: pieceVertices (with `out`). Vertices of a piece as [x0, y0, x1, y1, ...], counter-clockwise; `scale` shrinks or grows the
/// piece about its centre (the strict verifier shrinks by 1 - 1e-8).
pub fn piece_vertices_into(n: u32, pose: &Pose, scale: f64, out: &mut [f64]) {
    let r = circumradius(n) * scale;
    let step = 2.0 * PI / n as f64;
    let a0 = pose.theta + PI / 2.0;
    for k in 0..n as usize {
        let a = a0 + k as f64 * step;
        out[2 * k] = pose.x + r * math::cos(a);
        out[2 * k + 1] = pose.y + r * math::sin(a);
    }
}

/// shapes.ts: pieceVertices.
pub fn piece_vertices(n: u32, pose: &Pose, scale: f64) -> Vec<f64> {
    let mut v = vec![0.0; 2 * n as usize];
    piece_vertices_into(n, pose, scale, &mut v);
    v
}

/// shapes.ts: containerVertices. Vertices of a polygon container, counter-clockwise (phi = 0: horizontal bottom edge).
pub fn container_vertices(c: &Container) -> Vec<f64> {
    let m = c.m as usize;
    let mut v = vec![0.0; 2 * m];
    let r = c.size / (2.0 * math::sin(PI / c.m as f64));
    let a0 = c.phi - PI / 2.0 + PI / c.m as f64;
    let step = 2.0 * PI / c.m as f64;
    for k in 0..m {
        let a = a0 + k as f64 * step;
        v[2 * k] = c.cx + r * math::cos(a);
        v[2 * k + 1] = c.cy + r * math::sin(a);
    }
    v
}

/// shapes.ts: areaLowerBound. Area lower bound on the container size (side or diameter): P times the piece area fits in the container.
pub fn area_lower_bound(n: u32, m: u32, p: usize) -> f64 {
    let total = p as f64 * piece_area(n);
    if m == 0 {
        2.0 * (total / PI).sqrt()
    } else {
        (total * 4.0 * math::tan(PI / m as f64) / m as f64).sqrt()
    }
}

/// The orientation that gives a piece a horizontal bottom edge.
pub fn default_theta(n: u32) -> f64 {
    if n != 0 && n % 2 == 0 {
        PI / n as f64
    } else {
        0.0
    }
}

/// A flat packing problem: P pieces of shape N in a container of shape M.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Problem {
    pub n: u32,
    pub m: u32,
    pub p: usize,
}

impl Problem {
    pub fn new(n: u32, m: u32, p: usize) -> Self {
        Problem { n, m, p }
    }
    pub fn key(&self) -> String {
        format!("{}-{}-{}", self.n, self.m, self.p)
    }
    pub fn label(&self) -> String {
        format!("N={} M={} P={}", self.n, self.m, self.p)
    }
}

/// A configuration: the poses and the container orientation the score is taken at.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub n: u32,
    pub m: u32,
    pub pieces: Vec<Pose>,
    pub phi: f64,
}

impl Config {
    pub fn new(problem: Problem, pieces: Vec<Pose>, phi: f64) -> Self {
        Config { n: problem.n, m: problem.m, pieces, phi }
    }
    pub fn p(&self) -> usize {
        self.pieces.len()
    }
    pub fn problem(&self) -> Problem {
        Problem::new(self.n, self.m, self.pieces.len())
    }
}
