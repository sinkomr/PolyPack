//! Development of a neighbourhood of a point c of the surface into the plane of its face's frame
//! (the "anchor frame"). Port of `packages/surface/src/chains.ts`.
//!
//! A straight ray from c that avoids the vertices crosses a sequence of edges. Rays crossing the
//! same edge sequence (a chain) form a wedge with apex c. A chain node holds the last face of the
//! chain unfolded into the anchor frame and the closed wedge of directions whose rays cross the
//! chain's edges in order. The part of a piece on that face is piece ∩ unfolded face ∩ wedge.
//!
//! Enumeration is a search (breadth first: nodes are expanded in the order they were found) that
//! keeps every chain any ray of length <= reach can follow. Three prunings, each valid for every
//! ray that avoids the vertices:
//! 1. distance: an edge farther than `reach` from c cannot be crossed by such a ray;
//! 2. empty wedge: no ray crosses the chain's edges in order (a wedge of width 0 is one ray through
//!    a vertex, so it counts as empty too);
//! 3. turn rule: a straight line that crosses several consecutive edges around one vertex V sweeps
//!    less than pi of angle around V (a line subtends exactly pi seen from a point off it), so
//!    the faces passed between the first and the last such edge have face angles at V summing to
//!    less than pi. A chain that breaks this cannot be followed by a ray. (On the Platonic solids
//!    every face angle is the same, (M - 2) pi / M; on the others the angles at V are summed.)
//! Rays that hit a vertex are covered by the closed wedges (their last face has that vertex).

use crate::rigid::{apply, compose, glue, Rigid, IDENTITY};
use crate::solids::{face_vertex, frame_vertex, Solid};
use polypack_js::fmt;
use polypack_js::math;
use polypack_js::math::PI;

/// `packages/surface/src/chains.ts: Wedge`. Closed angular interval [a0, a0 + w] of directions,
/// 0 <= w <= pi, with unit end vectors.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wedge {
    pub a0: f64,
    pub w: f64,
    pub lx: f64,
    pub ly: f64,
    pub hx: f64,
    pub hy: f64,
}

/// `packages/surface/src/chains.ts: ChainNode`.
///
/// The TypeScript node also carries `path`, the edges crossed as (face left, edge of that face),
/// copied and extended at every node; only the message of the depth limit reads it. Here a node
/// keeps the last crossing (`via`, with `parent`), and `chain_path` rebuilds the list.
#[derive(Clone, Debug)]
pub struct ChainNode {
    pub face: usize,
    /// face frame -> anchor frame
    pub to_anchor: Rigid,
    /// None for the root (all directions)
    pub wedge: Option<Wedge>,
    /// edge of `face` through which the chain entered it, -1 for the root
    pub entry: i32,
    pub depth: usize,
    /// index of the node this one was reached from, -1 for the root
    pub parent: i32,
    /// edge of the parent's face that was crossed to reach this node (0 for the root)
    pub via: usize,
    /// vertex id shared by the last two crossed edges (-1 if none) and the number of faces passed around it
    pub run_vertex: i32,
    pub run_count: usize,
    /// sum of the face angles at run_vertex of the faces passed around it (0 when run_vertex is -1)
    pub run_angle: f64,
    /// Index of the first earlier node with the same face and the same development (see
    /// `mark_twins`), or None. Set on the later nodes of a group of twins only.
    pub twin: Option<usize>,
}

/// `ChainNode.path` of the TypeScript: the edges crossed to reach node `idx`, as (face left, edge
/// of that face), first crossing first.
pub fn chain_path(nodes: &[ChainNode], idx: usize) -> Vec<(usize, usize)> {
    let mut path = Vec::new();
    let mut i = idx;
    while nodes[i].parent >= 0 {
        let p = nodes[i].parent as usize;
        path.push((nodes[p].face, nodes[i].via));
        i = p;
    }
    path.reverse();
    path
}

/// `packages/surface/src/chains.ts: MAX_CHAIN_DEPTH`.
pub const MAX_CHAIN_DEPTH: usize = 80;

/// What `enumerate_chains` (and so the fold check) can throw.
#[derive(Clone, Debug, PartialEq)]
pub enum ChainError {
    /// `packages/surface/src/chains.ts: ChainLimitError`. Thrown when a point has more chains than
    /// the caller allows; the string is the error's message.
    ChainLimit(String),
    /// Any other `Error` (the chain depth limit); the string is its message.
    Other(String),
}

impl ChainError {
    /// The thrown error's `message`.
    pub fn message(&self) -> &str {
        match self {
            ChainError::ChainLimit(m) | ChainError::Other(m) => m,
        }
    }
    /// `e instanceof ChainLimitError`.
    pub fn is_chain_limit(&self) -> bool {
        matches!(self, ChainError::ChainLimit(_))
    }
}

impl std::fmt::Display for ChainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ChainError {}

/// `packages/surface/src/chains.ts: normAngle`.
pub fn norm_angle(a: f64) -> f64 {
    let mut t = a % (2.0 * PI);
    if t <= -PI {
        t += 2.0 * PI;
    } else if t > PI {
        t -= 2.0 * PI;
    }
    t
}

/// `packages/surface/src/chains.ts: makeWedge`.
fn make_wedge(a0: f64, w: f64) -> Wedge {
    let a1 = a0 + w;
    Wedge { a0, w, lx: math::cos(a0), ly: math::sin(a0), hx: math::cos(a1), hy: math::sin(a1) }
}

/// `packages/surface/src/chains.ts: coneOverEdge`. Closed cone of rays from (cx, cy) through the
/// segment A -> B, where c lies left of A -> B.
pub fn cone_over_edge(cx: f64, cy: f64, ax: f64, ay: f64, bx: f64, by: f64) -> Wedge {
    let ux = ax - cx;
    let uy = ay - cy;
    let vx = bx - cx;
    let vy = by - cy;
    let a0 = math::atan2(uy, ux);
    let mut w = math::atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    // c on the edge line gives w = pi; rounding to the far side gives w near -pi
    if w < 0.0 {
        w = PI;
    }
    make_wedge(a0, math::min(w, PI))
}

/// `packages/surface/src/chains.ts: intersectWedges`. Intersection of two closed wedges with the
/// same apex, or None when it has no interior. A wedge of width 0 is a single ray through a vertex
/// (its boundary rays pass through edge endpoints), which no vertex-avoiding ray follows, so widths
/// below `min_width` radians count as empty.
pub fn intersect_wedges(a: Option<&Wedge>, b: Wedge, min_width: f64) -> Option<Wedge> {
    let Some(a) = a else {
        return if b.w < min_width { None } else { Some(b) };
    };
    let d = norm_angle(b.a0 - a.a0);
    let lo = math::max(0.0, d);
    let hi = math::min(a.w, d + b.w);
    if hi - lo < min_width {
        return None;
    }
    Some(make_wedge(a.a0 + lo, hi - lo))
}

/// `packages/surface/src/chains.ts: inWedge`. Is the point (x, y) within distance tol of the closed
/// wedge with apex (cx, cy)?
#[inline]
pub fn in_wedge(w: Option<&Wedge>, cx: f64, cy: f64, x: f64, y: f64, tol: f64) -> bool {
    let Some(w) = w else {
        return true;
    };
    let vx = x - cx;
    let vy = y - cy;
    // both half-planes bound the wedge exactly when w <= pi
    w.lx * vy - w.ly * vx >= -tol && vx * w.hy - vy * w.hx >= -tol
}

/// `packages/surface/src/chains.ts: pointSegmentDistance`.
pub fn point_segment_distance(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let ex = bx - ax;
    let ey = by - ay;
    let l2 = ex * ex + ey * ey;
    let mut t = if l2 > 0.0 { ((px - ax) * ex + (py - ay) * ey) / l2 } else { 0.0 };
    t = if t < 0.0 {
        0.0
    } else if t > 1.0 {
        1.0
    } else {
        t
    };
    math::hypot(px - ax - t * ex, py - ay - t * ey)
}

/// `packages/surface/src/chains.ts: enumerateChains`. All chains from the point (cx, cy) of face
/// `anchor` that a ray of length <= reach can follow. The root (index 0) is the anchor face itself.
/// `max_chains` bounds the work for untrusted input (a solid far too small for its pieces): more
/// chains than that are a `ChainError::ChainLimit`. It is a number as in the TypeScript, with
/// `f64::INFINITY` for no limit.
pub fn enumerate_chains(
    solid: &Solid,
    s: f64,
    anchor: usize,
    cx: f64,
    cy: f64,
    reach: f64,
    max_chains: f64,
) -> Result<Vec<ChainNode>, ChainError> {
    let uniform = solid.uniform;
    let mut out: Vec<ChainNode> = vec![ChainNode {
        face: anchor,
        to_anchor: IDENTITY,
        wedge: None,
        entry: -1,
        depth: 0,
        parent: -1,
        via: 0,
        run_vertex: -1,
        run_count: 0,
        run_angle: 0.0,
        twin: None,
    }];
    // the Platonic solids: one frame for every face, as before the generalisation
    let mut shared: Vec<(f64, f64)> = Vec::new();
    if uniform {
        for k in 0..solid.m {
            shared.push(frame_vertex(solid.m, s, k));
        }
    }
    let slack = 1e-12 * math::max(1.0, s);
    let mut own: Vec<(f64, f64)> = Vec::new();
    let mut idx = 0;
    while idx < out.len() {
        // the fields of the node that the loop reads (the list grows below)
        let node_face = out[idx].face;
        let node_entry = out[idx].entry;
        let node_depth = out[idx].depth;
        let node_wedge = out[idx].wedge;
        let node_run_vertex = out[idx].run_vertex;
        let node_run_count = out[idx].run_count;
        let node_run_angle = out[idx].run_angle;
        let t = out[idx].to_anchor;
        if node_depth >= MAX_CHAIN_DEPTH {
            let path: Vec<String> = chain_path(&out, idx).iter().map(|(f, e)| format!("{f}:{e}")).collect();
            let w = match node_wedge {
                Some(w) => fmt::num(w.w),
                None => "undefined".to_string(),
            };
            return Err(ChainError::Other(format!("chain depth limit reached: {} w={}", path.join(" "), w)));
        }
        let m = solid.sides[node_face];
        let verts: &[(f64, f64)] = if uniform {
            &shared
        } else {
            own.clear();
            for k in 0..m {
                own.push(face_vertex(solid, s, node_face, k));
            }
            &own
        };
        for k in 0..m {
            if k as i32 == node_entry {
                continue;
            }
            let (ax, ay) = apply(&t, verts[k].0, verts[k].1);
            let (bx, by) = apply(&t, verts[(k + 1) % m].0, verts[(k + 1) % m].1);
            // c strictly beyond this edge's line: no ray from c crosses it out of the face
            if (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < -slack * s {
                continue;
            }
            if point_segment_distance(cx, cy, ax, ay, bx, by) > reach + slack {
                continue;
            }
            let mut run_vertex: i32 = -1;
            let mut run_count: usize = 0;
            let mut run_angle = 0.0;
            if node_entry >= 0 {
                let entry = node_entry as usize;
                let mut local: i32 = -1;
                if k == (entry + 1) % m {
                    local = k as i32;
                } else if k == (entry + m - 1) % m {
                    local = entry as i32;
                }
                if local >= 0 {
                    let local = local as usize;
                    run_vertex = solid.faces[node_face][local] as i32;
                    let same = run_vertex == node_run_vertex;
                    run_count = if same { node_run_count + 1 } else { 1 };
                    run_angle = (if same { node_run_angle } else { 0.0 }) + solid.corner[node_face][local];
                    if (if uniform { run_count as f64 * solid.face_angle } else { run_angle }) >= PI - 1e-9 {
                        continue;
                    }
                }
            }
            let Some(w) = intersect_wedges(node_wedge.as_ref(), cone_over_edge(cx, cy, ax, ay, bx, by), 1e-12) else {
                continue;
            };
            if out.len() as f64 >= max_chains {
                return Err(ChainError::ChainLimit(format!(
                    "more than {} chains of faces from one point (face {}): the solid is far too small for its pieces",
                    fmt::num(max_chains),
                    anchor
                )));
            }
            let g = glue(solid, s, node_face, k);
            out.push(ChainNode {
                face: g.face,
                to_anchor: compose(&t, &g.t),
                wedge: Some(w),
                entry: g.edge as i32,
                depth: node_depth + 1,
                parent: idx as i32,
                via: k,
                run_vertex,
                run_count,
                run_angle,
                twin: None,
            });
        }
        idx += 1;
    }
    mark_twins(&mut out, slack, solid.f);
    Ok(out)
}

/// `packages/surface/src/chains.ts: markTwins`. Mark chains whose developments coincide. At a
/// vertex of cone angle exactly pi (three triangles meet), going around the vertex to the left or
/// to the right reaches the same face with the same rigid motion, since a rotation by pi equals one
/// by -pi. The two wedges then only share a boundary ray through that vertex, and a point on it
/// lies in both. The fields of the nodes and their order are unchanged. (The validator does not
/// read `twin`; the search kernels do.)
///
/// `faces` is the number of faces of the solid: the TypeScript's Map from a face to the nodes on
/// it is a list per face here.
pub fn mark_twins(nodes: &mut [ChainNode], slack: f64, faces: usize) {
    let mut by_face: Vec<Vec<usize>> = vec![Vec::new(); faces];
    for i in 0..nodes.len() {
        let face = nodes[i].face;
        if by_face[face].is_empty() {
            by_face[face].push(i);
            continue;
        }
        let b = nodes[i].to_anchor;
        let mut twin: Option<usize> = None;
        for &j in &by_face[face] {
            let a = nodes[j].to_anchor;
            if (a.c - b.c).abs() <= slack && (a.s - b.s).abs() <= slack && (a.tx - b.tx).abs() <= slack && (a.ty - b.ty).abs() <= slack
            {
                twin = Some(nodes[j].twin.unwrap_or(j));
                break;
            }
        }
        match twin {
            Some(t) => nodes[i].twin = Some(t),
            None => by_face[face].push(i),
        }
    }
}
