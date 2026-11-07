//! Penetration depths and protrusions with analytic derivatives, for the penalty-based searches
//! (packages/geometry/src/penalty.ts).
//!
//! A soft piece is its polygon core scaled by `scale` about the centre and dilated by a disk of
//! radius `padding`; scale 0 is a disk of radius `padding`, and a disk piece (n = 0) is a disk of
//! diameter `scale` plus the padding.

use crate::sep::Shape;
use crate::shapes::{circumradius, container_inradius, inradius, Container, Pose, DISK_RADIUS};
use std::f64::consts::PI;

/// Signed penetration of a pair (positive: overlap) and its derivatives with respect to the poses
/// of a and b (x, y, theta).
#[derive(Clone, Copy, Debug, Default)]
pub struct PairPenetration {
    pub depth: f64,
    pub ga: [f64; 3],
    pub gb: [f64; 3],
}

/// Negative of the SAT separation, with the derivatives of the selected branch: the edge normal
/// u of piece p and the vertex v of piece q nearest it in angle, sep = (q - p + v) . u - r.
/// Rotating p turns u (lever arm q - p + v), rotating q turns v. With padding and separated cores,
/// the exact Euclidean distance of the cores replaces the SAT lower bound.
pub fn pair_penetration(shape: &Shape, a: &Pose, b: &Pose, scale: f64, padding: f64) -> PairPenetration {
    let n = shape.n;
    if n == 0 || scale == 0.0 {
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = dx.hypot(dy);
        // coincident centres: a bounded subgradient that separates the pair
        let ux = if distance == 0.0 { 1.0 } else { dx / distance };
        let uy = if distance == 0.0 { 0.0 } else { dy / distance };
        let rad = if n == 0 { scale * DISK_RADIUS } else { 0.0 } + padding;
        return PairPenetration { depth: 2.0 * rad - distance, ga: [-ux, -uy, 0.0], gb: [ux, uy, 0.0] };
    }
    let big_r = circumradius(n) * scale;
    let r = inradius(n) * scale;
    let step = shape.step;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let d = dx.hypot(dy);
    let phi = dy.atan2(dx);
    // nearest edge normal of A to d and of B to -d (closed form of the 2N-axis maximum)
    let ka = ((phi - a.theta - shape.normal0) / step).round();
    let kb = ((phi + PI - b.theta - shape.normal0) / step).round();
    let ang_a = a.theta + shape.normal0 + ka * step;
    let ang_b = b.theta + shape.normal0 + kb * step;
    let ga = d * (phi - ang_a).cos();
    let gb = d * (phi + PI - ang_b).cos();
    // the reach term r + R cos(delta) is the same for both passes (see Shape::contact_offset)
    let rel = a.theta - b.theta + PI + PI / n as f64;
    let reach = r + big_r * shape.fold(rel).cos();
    let (pass_a, ang, best) = if ga >= gb { (true, ang_a, ga - reach) } else { (false, ang_b, gb - reach) };
    if padding > 0.0 && best > 0.0 {
        if let Some(c) = padded_closest_pair(n, a, b, scale, padding) {
            return c;
        }
    }
    let (p, q) = if pass_a { (a, b) } else { (b, a) };
    let (ux, uy) = (ang.cos(), ang.sin());
    let ddx = q.x - p.x;
    let ddy = q.y - p.y;
    let relq = ang + PI / 2.0 - q.theta;
    let vertex = (relq / step).round();
    let vertex_angle = q.theta + PI / 2.0 + vertex * step;
    let vx = big_r * vertex_angle.cos();
    let vy = big_r * vertex_angle.sin();
    let dp = [ux, uy, (ddx + vx) * uy - (ddy + vy) * ux];
    let dq = [-ux, -uy, vy * ux - vx * uy];
    let depth = if padding == 0.0 { -best } else { -best + 2.0 * padding };
    if pass_a {
        PairPenetration { depth, ga: dp, gb: dq }
    } else {
        PairPenetration { depth, ga: dq, gb: dp }
    }
}

/// Closest vertex/segment pair of two separated cores, with envelope derivatives. None when the
/// cores touch exactly (the SAT branch derivative is used instead).
fn padded_closest_pair(n: u32, a: &Pose, b: &Pose, scale: f64, padding: f64) -> Option<PairPenetration> {
    let nv = n as usize;
    let big_r = circumradius(n) * scale;
    let step = 2.0 * PI / n as f64;
    // local offsets: tiny cores must not collapse at large absolute centres
    let mut va = [0.0f64; 2 * 100];
    let mut vb = [0.0f64; 2 * 100];
    for k in 0..nv {
        let t = a.theta + PI / 2.0 + k as f64 * step;
        va[2 * k] = big_r * t.cos();
        va[2 * k + 1] = big_r * t.sin();
        let t = b.theta + PI / 2.0 + k as f64 * step;
        vb[2 * k] = big_r * t.cos();
        vb[2 * k + 1] = big_r * t.sin();
    }
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut distance = f64::INFINITY;
    let (mut ax, mut ay, mut bx, mut by, mut ux, mut uy) = (0.0, 0.0, 0.0, 0.0, 1.0, 0.0);
    for pass in 0..2 {
        let (vertices, edges) = if pass == 0 { (&va, &vb) } else { (&vb, &va) };
        let (cx, cy) = if pass == 0 { (dx, dy) } else { (-dx, -dy) };
        for i in 0..nv {
            let x = vertices[2 * i];
            let y = vertices[2 * i + 1];
            for j in 0..nv {
                let k = (j + 1) % nv;
                let ex = edges[2 * k] - edges[2 * j];
                let ey = edges[2 * k + 1] - edges[2 * j + 1];
                let length2 = ex * ex + ey * ey;
                let t = if length2 == 0.0 {
                    0.0
                } else {
                    (((x - cx - edges[2 * j]) * ex + (y - cy - edges[2 * j + 1]) * ey) / length2).clamp(0.0, 1.0)
                };
                let qx = edges[2 * j] + t * ex;
                let qy = edges[2 * j + 1] + t * ey;
                let wx = x - cx - qx;
                let wy = y - cy - qy;
                let d2 = wx * wx + wy * wy;
                if d2 == 0.0 {
                    return None;
                }
                if d2 >= distance * distance {
                    continue;
                }
                let dd = d2.sqrt();
                distance = dd;
                if pass == 0 {
                    ax = x;
                    ay = y;
                    bx = qx;
                    by = qy;
                    ux = wx / dd;
                    uy = wy / dd;
                } else {
                    ax = qx;
                    ay = qy;
                    bx = x;
                    by = y;
                    ux = -wx / dd;
                    uy = -wy / dd;
                }
            }
        }
    }
    Some(PairPenetration {
        depth: 2.0 * padding - distance,
        ga: [-ux, -uy, ay * ux - ax * uy],
        gb: [ux, uy, bx * uy - by * ux],
    })
}

/// One containment constraint: depth <= 0 when the feature is inside, with derivatives with
/// respect to the piece pose (px, py, pt) and the container (cx, cy, size, phi).
#[derive(Clone, Copy, Debug, Default)]
pub struct Protrusion {
    pub depth: f64,
    pub px: f64,
    pub py: f64,
    pub pt: f64,
    pub cx: f64,
    pub cy: f64,
    pub size: f64,
    pub phi: f64,
    /// Constraint id: the wall for support form, vertex * M + wall for the full form, the vertex
    /// for a circle container.
    pub index: usize,
}

/// Visit the containment constraints of one piece.
///
/// Support form (`support_only`, also used for disk pieces): one constraint per polygon wall,
/// with the piece's furthest vertex along the wall normal, found in O(1) as the vertex nearest in
/// angle to the normal. Full form: every vertex against every wall. A circle container has one
/// radial constraint per vertex. Both forms describe the same feasible set.
#[inline]
pub fn visit_protrusions(
    n: u32,
    pose: &Pose,
    container: &Container,
    support_only: bool,
    scale: f64,
    padding: f64,
    mut visit: impl FnMut(Protrusion),
) {
    let count = if n == 0 { 1 } else { n as usize };
    let big_r = if n == 0 { 0.0 } else { circumradius(n) * scale };
    let step = if n == 0 { 0.0 } else { 2.0 * PI / n as f64 };
    let a0 = pose.theta + PI / 2.0;
    let radius = if n == 0 { scale * DISK_RADIUS } else { 0.0 } + padding;
    if container.m == 0 {
        let apothem = container_inradius(0);
        for vertex in 0..count {
            let (vx, vy) = if n == 0 {
                (pose.x, pose.y)
            } else {
                let angle = a0 + vertex as f64 * step;
                (pose.x + big_r * angle.cos(), pose.y + big_r * angle.sin())
            };
            let ox = vx - pose.x;
            let oy = vy - pose.y;
            let dx = vx - container.cx;
            let dy = vy - container.cy;
            let distance = dx.hypot(dy);
            let ux = if distance == 0.0 { 1.0 } else { dx / distance };
            let uy = if distance == 0.0 { 0.0 } else { dy / distance };
            visit(Protrusion {
                depth: distance + radius - container.size * apothem,
                px: ux,
                py: uy,
                pt: ox * uy - oy * ux,
                cx: -ux,
                cy: -uy,
                size: -apothem,
                phi: 0.0,
                index: vertex,
            });
        }
        return;
    }
    let m = container.m;
    let unit_apothem = inradius(m);
    let wall_step = 2.0 * PI / m as f64;
    if n == 0 || support_only {
        for edge in 0..m as usize {
            // edge 0 is the bottom edge at phi = 0; edge j ends at container vertex j
            let angle = container.phi - PI / 2.0 + wall_step * edge as f64;
            let (uy, ux) = angle.sin_cos();
            let (vx, vy) = if n == 0 {
                (pose.x, pose.y)
            } else {
                let nearest = ((angle - a0) / step).round();
                let va = a0 + nearest * step;
                (pose.x + big_r * va.cos(), pose.y + big_r * va.sin())
            };
            let ox = vx - pose.x;
            let oy = vy - pose.y;
            let dx = vx - container.cx;
            let dy = vy - container.cy;
            visit(Protrusion {
                depth: dx * ux + dy * uy + radius - container.size * unit_apothem,
                px: ux,
                py: uy,
                pt: ox * uy - oy * ux,
                cx: -ux,
                cy: -uy,
                size: -unit_apothem,
                phi: -dx * uy + dy * ux,
                index: edge,
            });
        }
        return;
    }
    let mut wcos = [0.0f64; 100];
    let mut wsin = [0.0f64; 100];
    for edge in 0..m as usize {
        let angle = container.phi - PI / 2.0 + wall_step * edge as f64;
        let (s, c) = angle.sin_cos();
        wcos[edge] = c;
        wsin[edge] = s;
    }
    for vertex in 0..n as usize {
        let angle = a0 + vertex as f64 * step;
        let vx = pose.x + big_r * angle.cos();
        let vy = pose.y + big_r * angle.sin();
        let ox = vx - pose.x;
        let oy = vy - pose.y;
        let dx = vx - container.cx;
        let dy = vy - container.cy;
        for edge in 0..m as usize {
            let ux = wcos[edge];
            let uy = wsin[edge];
            visit(Protrusion {
                depth: dx * ux + dy * uy + padding - container.size * unit_apothem,
                px: ux,
                py: uy,
                pt: ox * uy - oy * ux,
                cx: -ux,
                cy: -uy,
                size: -unit_apothem,
                phi: -dx * uy + dy * ux,
                index: vertex * m as usize + edge,
            });
        }
    }
}

/// Largest protrusion of a piece through the container walls (support form; <= 0 when inside).
#[inline]
pub fn max_protrusion(n: u32, pose: &Pose, container: &Container, scale: f64, padding: f64) -> f64 {
    let mut worst = f64::NEG_INFINITY;
    visit_protrusions(n, pose, container, true, scale, padding, |p| {
        if !(p.depth <= worst) {
            worst = p.depth;
        }
    });
    worst
}

/// True when the whole piece lies in the closed container (support form; NaN counts as outside).
#[inline]
pub fn contained(n: u32, pose: &Pose, container: &Container) -> bool {
    if !(container.size.is_finite() && container.size > 0.0) {
        return false;
    }
    let mut ok = true;
    visit_protrusions(n, pose, container, true, 1.0, 0.0, |p| {
        if !(p.depth <= 0.0) {
            ok = false;
        }
    });
    ok
}

/// True when every vertex lies in the closed container (full form, the asc state's check).
#[inline]
pub fn fully_contained(n: u32, pose: &Pose, container: &Container) -> bool {
    if !(container.size.is_finite() && container.size > 0.0) {
        return false;
    }
    let mut ok = true;
    visit_protrusions(n, pose, container, false, 1.0, 0.0, |p| {
        if !(p.depth <= 0.0) {
            ok = false;
        }
    });
    ok
}
