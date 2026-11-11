//! Gap functions (float64) for curved packings, as the server's validator reads them
//! (packages/curved/src/evaluate.ts, the functions the server reaches: pieceState, allStates,
//! wallCovectors, pairGap, centreDistance, requiredT). The rows with gradients of that file belong
//! to the search; the crate's search has its own, organised for speed, in eval.rs.
//!
//! Every constraint is a gap in geodesic length units: positive = clearance, 0 = touching,
//! negative = overlap or protrusion.
//!  - polygon pair: separating-axis value in the chart. For each edge line of one piece, the
//!    smallest signed distance of the other piece's vertices; the largest of these over both
//!    pieces' edges. A value >= 0 proves the interiors are disjoint (Klein / gnomonic charts map
//!    geodesics to straight lines, so the Euclidean separating-axis theorem applies there).
//!  - disk pair: centre distance - 2 DISK_RADIUS.
//!
//! This module is a line-by-line port (native/PORTING.md): the same operations in the same order.

use crate::geom::{
    apply_point, body_jacobian_of, covector_norm2, line_covector, line_through, line_value, pair_vs, pose_frame,
    pose_motion_inverse, LPoint, Motion, PoseFrame,
};
use crate::kfun::{ang_k, asn_k, dist_from_vs, sn_k};
use crate::problem::{Pose, Space};
use polypack_js::math;

/// The state of a piece at a pose (packages/curved/src/evaluate.ts: PieceState, class PoseState).
/// The inverse motion and the body Jacobian are built when asked for, as in the source, where only
/// the rows of constraints near contact read them; the validator reads neither.
#[derive(Clone, Debug)]
pub struct PieceState {
    k: f64,
    x: f64,
    y: f64,
    theta: f64,
    frame: PoseFrame,
    pub g: Motion,
    pub centre: LPoint,
    pub verts: Vec<LPoint>,
    /// outward world covectors of the edges, normalised to Qd = 1
    pub edges: Vec<[f64; 3]>,
}

impl PieceState {
    /// packages/curved/src/evaluate.ts: PoseState.Ginv, poseMotionInverse of the pose.
    pub fn ginv(&self) -> Motion {
        pose_motion_inverse(self.k, self.x, self.y, self.theta)
    }

    /// packages/curved/src/evaluate.ts: PoseState.Jb, bodyJacobian(K, x, y, theta) from the frame's scalars.
    pub fn jb(&self) -> [f64; 9] {
        let f = &self.frame;
        body_jacobian_of(self.k, self.x, self.y, f.t, f.s_t, f.v_t, f.c, f.s)
    }
}

/// packages/curved/src/evaluate.ts: pieceState. The motion, centre and vertices of a pose, from a
/// frame that keeps its scalars for Jb.
pub fn piece_state(space: &Space, pose: &Pose) -> PieceState {
    let frame = pose_frame(space.k, pose.x, pose.y, pose.theta);
    let g = frame.g;
    let centre: LPoint = [g.b[0], g.b[1], g.b[2]];
    let verts: Vec<LPoint> = space.vertices.iter().map(|v| apply_point(&g, v)).collect();
    let edges = edge_covectors(space, &verts);
    PieceState {
        k: space.k,
        x: pose.x,
        y: pose.y,
        theta: pose.theta,
        frame,
        g,
        centre,
        verts,
        edges,
    }
}

/// Outward world covectors of the edges of placed vertices, normalised to Qd = 1
/// (packages/curved/src/evaluate.ts: edgeCovectors).
fn edge_covectors(space: &Space, verts: &[LPoint]) -> Vec<[f64; 3]> {
    let k = space.k;
    let nn = space.n as usize;
    let mut edges = Vec::with_capacity(nn);
    for e in 0..nn {
        let a = &verts[e];
        let b = &verts[(e + 1) % nn];
        // b x a: outward for a counter-clockwise edge a -> b
        let n = line_through(k, b, a);
        let q = math::sqrt(covector_norm2(k, &n));
        edges.push([n[0] / q, n[1] / q, n[2] / q]);
    }
    edges
}

/// packages/curved/src/evaluate.ts: allStates.
pub fn all_states(space: &Space, poses: &[Pose]) -> Vec<PieceState> {
    poses.iter().map(|p| piece_state(space, p)).collect()
}

/// Container wall covectors for container variable t (apothem)
/// (packages/curved/src/evaluate.ts: wallCovectors).
pub fn wall_covectors(space: &Space, t: f64) -> Vec<[f64; 3]> {
    space
        .wall_angles
        .iter()
        .map(|&a| line_covector(space.k, t, a))
        .collect()
}

/// packages/curved/src/evaluate.ts: PairWitness. `owner` 0: the axis is an edge of piece i; 1: of
/// piece j; -1: a disk pair (then edge and vertex are -1 too).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PairWitness {
    pub owner: i32,
    pub edge: i32,
    pub vertex: i32,
}

/// packages/curved/src/evaluate.ts: PairGap.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PairGap {
    pub gap: f64,
    pub witness: PairWitness,
}

/// Signed separation of two pieces: the separating-axis value for polygons, distance - 2 DISK_RADIUS
/// = distance - 1 for disks (packages/curved/src/evaluate.ts: pairGap).
pub fn pair_gap(space: &Space, a: &PieceState, b: &PieceState) -> PairGap {
    let k = space.k;
    let nn = space.n as usize;
    if nn == 0 {
        let vs = pair_vs(k, &a.centre, &b.centre);
        return PairGap {
            gap: dist_from_vs(k, vs) - 2.0 * space.piece.r,
            witness: PairWitness {
                owner: -1,
                edge: -1,
                vertex: -1,
            },
        };
    }
    let mut best = f64::NEG_INFINITY;
    let mut w = PairWitness {
        owner: 0,
        edge: 0,
        vertex: 0,
    };
    for pass in 0..2 {
        let (p, q) = if pass == 0 { (a, b) } else { (b, a) };
        for e in 0..nn {
            let n = &p.edges[e];
            let mut m = f64::INFINITY;
            let mut mk = 0usize;
            for kv in 0..nn {
                let val = line_value(k, n, &q.verts[kv]);
                if val < m {
                    m = val;
                    mk = kv;
                }
            }
            if m > best {
                best = m;
                w = PairWitness {
                    owner: pass,
                    edge: e as i32,
                    vertex: mk as i32,
                };
            }
        }
    }
    PairGap {
        gap: asn_k(k, best),
        witness: w,
    }
}

/// The distance of two pieces' centres (packages/curved/src/evaluate.ts: centreDistance).
pub fn centre_distance(space: &Space, a: &PieceState, b: &PieceState) -> f64 {
    dist_from_vs(space.k, pair_vs(space.k, &a.centre, &b.centre))
}

/// Smallest container variable t (apothem or radius) that contains the piece, at the fixed centre O
/// and orientation phi = 0. For wall direction u write the point as v = (c0, X = u . v_vec, ...) and
/// A = sqrt(c0^2 + K X^2), a = ang_K(X, c0). Then n(t) . v = A sn_K(a - t), so a vertex needs t >= a
/// and a disk centre needs t >= a + asn_K(sn_K(R) / A), R the disk's radius
/// (packages/curved/src/evaluate.ts: requiredT).
pub fn required_t(space: &Space, s: &PieceState) -> f64 {
    let k = space.k;
    let (n, m) = (space.n, space.m);
    let mut t = f64::NEG_INFINITY;
    let pts: &[LPoint] = if n == 0 {
        std::slice::from_ref(&s.centre)
    } else {
        &s.verts
    };
    if m == 0 {
        for p in pts {
            t = math::max(t, dist_from_vs(k, p[0]) + if n == 0 { space.piece.r } else { 0.0 });
        }
        return t;
    }
    let s1 = sn_k(k, space.piece.r); // (used by disks only)
    for p in pts {
        let c0 = 1.0 - k * p[0];
        for &ang in &space.wall_angles {
            let x = math::cos(ang) * p[1] + math::sin(ang) * p[2];
            let a = ang_k(k, x, c0);
            if n == 0 {
                let aa = math::sqrt(math::max(0.0, c0 * c0 + k * x * x));
                t = math::max(t, a + asn_k(k, s1 / aa));
            } else {
                t = math::max(t, a);
            }
        }
    }
    t
}
