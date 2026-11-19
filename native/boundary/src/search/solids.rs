//! Platonic solids as pieces of the search: the penalty energy and the violation of a state of rotated
//! pieces on any regular 4-polytope, and the model the search driver works with.
//! Port of packages/boundary/src/search/solids.ts (and rotationOnto of pieces.ts).
//!
//! A state holds each piece's anchor cell, its centre u (3 local coordinates, as for balls) and its
//! orientation R (a 3 x 3 orthogonal matrix in the anchor's frame, improper when a gluing reversed the
//! handedness: every Platonic solid is mirror-symmetric, so that is the same piece and `pieces` turns
//! it into a rotation by the solid's mirror). The piece occupies { u + R p : p in the standard solid }.
//!
//! Energy: the sum of squared violations, each a penetration depth.
//!  - Pairs and loops. The chains of cells (chains.rs) are enumerated from each piece's centre within
//!    twice the solid's circumradius. A chain's development is a rigid motion T (the node's to_anchor):
//!    the piece j seen from i along that chain is the rigid copy with centre T u_j and orientation
//!    M R_j (M the linear part). When that copy's centre lies in the chain's window the term is the
//!    squared separating-axis penetration depth of the piece i and the copy. A copy of a piece itself
//!    along a non-trivial chain is a loop; it counts alike.
//!  - Edges of the polytope. For each chain within the circumradius, every hinge of the node's cell
//!    clipped to the window is a segment; the term is the squared depth of that segment inside the piece.
//! This is the validator's rule with one difference: the validator compares the pieces' parts clipped
//! by the cells and windows, the model the rigid copies. The final scale and nudge of the search
//! (finalize_state) is decided by the validator, so a difference can cost quality, never validity.
//!
//! Gradients are analytic in the centres and in a rotation increment of each orientation (R' =
//! exp(theta) R, theta in the anchor's frame), by the contact feature that sets the depth.

use super::balls::clamped_pieces;
use super::chart::random_cell_point;
use super::model::{copy_state, Finish, PieceModel, State};
use super::random::Mulberry32;
use super::rot::{det9, matrix_to_quaternion, mul9, orthonormalize, random_rotation};
use super::Res;
use crate::bounds::{container_facts, piece_bounds};
use crate::chains::{clamp_to_cell, clip_segment_to_window, enumerate_chains, in_window, ridge_snap, ChainOptions};
use crate::linalg::{cross3, dot3, iso_apply, quaternion_to_matrix, sub3, V3};
use crate::pieces::{piece_shape, PieceShape};
use crate::polytope::{boundary_volume, topo, Polytope};
use crate::types::{BoundaryConfig, BoundaryPiece};
use polypack_js::math;

// ---------------------------------------------------------------- the separating-axis contact and its gradient

/// The contact that sets the penetration depth of two placed solids.
#[derive(Clone, Copy, Default)]
struct Contact {
    depth: f64,
    n: V3,
    /// 0: a face of A, 1: a face of B, 2: an edge of each.
    kind: u8,
    e_a: V3,
    e_b: V3,
    l: f64,
    /// The solid that sets the upper end of the overlap (0 = A, 1 = B), its vertex, and likewise for the lower end.
    hi_owner: u8,
    hi_k: usize,
    lo_owner: u8,
    lo_k: usize,
}

/// A solid placed at a centre with an orientation: its vertices, face normals and edge directions.
struct Placed {
    verts: Vec<f64>,
    normals: Vec<f64>,
    edges: Vec<f64>,
}

impl Placed {
    fn new(shape: &PieceShape) -> Placed {
        Placed { verts: vec![0.0; 3 * shape.vertices.len()], normals: vec![0.0; 3 * shape.normals.len()], edges: vec![0.0; 3 * shape.edge_dirs.len()] }
    }

    fn set(&mut self, shape: &PieceShape, c: V3, r: &[f64], ro: usize) {
        for (k, v) in shape.vertices.iter().enumerate() {
            self.verts[3 * k] = c[0] + r[ro] * v[0] + r[ro + 1] * v[1] + r[ro + 2] * v[2];
            self.verts[3 * k + 1] = c[1] + r[ro + 3] * v[0] + r[ro + 4] * v[1] + r[ro + 5] * v[2];
            self.verts[3 * k + 2] = c[2] + r[ro + 6] * v[0] + r[ro + 7] * v[1] + r[ro + 8] * v[2];
        }
        for (k, v) in shape.normals.iter().enumerate() {
            self.normals[3 * k] = r[ro] * v[0] + r[ro + 1] * v[1] + r[ro + 2] * v[2];
            self.normals[3 * k + 1] = r[ro + 3] * v[0] + r[ro + 4] * v[1] + r[ro + 5] * v[2];
            self.normals[3 * k + 2] = r[ro + 6] * v[0] + r[ro + 7] * v[1] + r[ro + 8] * v[2];
        }
        for (k, v) in shape.edge_dirs.iter().enumerate() {
            self.edges[3 * k] = r[ro] * v[0] + r[ro + 1] * v[1] + r[ro + 2] * v[2];
            self.edges[3 * k + 1] = r[ro + 3] * v[0] + r[ro + 4] * v[1] + r[ro + 5] * v[2];
            self.edges[3 * k + 2] = r[ro + 6] * v[0] + r[ro + 7] * v[1] + r[ro + 8] * v[2];
        }
    }
}

/// One axis of the separating-axis test; true when the solids are separated along it (the best so far
/// is <= 0, touching allowed). packages/boundary/src/search/solids.ts: satContact's tryAxis
#[allow(clippy::too_many_arguments)]
fn try_axis(a: &Placed, b: &Placed, nv: usize, n: V3, kind: u8, ia: usize, ib: usize, l: f64, best: &mut f64, ct: &mut Contact) -> bool {
    let (nx, ny, nz) = (n[0], n[1], n[2]);
    let (mut max_a, mut min_a, mut k_max_a, mut k_min_a) = (f64::NEG_INFINITY, f64::INFINITY, 0usize, 0usize);
    let (mut max_b, mut min_b, mut k_max_b, mut k_min_b) = (f64::NEG_INFINITY, f64::INFINITY, 0usize, 0usize);
    for k in 0..nv {
        let pa = nx * a.verts[3 * k] + ny * a.verts[3 * k + 1] + nz * a.verts[3 * k + 2];
        if pa > max_a {
            max_a = pa;
            k_max_a = k;
        }
        if pa < min_a {
            min_a = pa;
            k_min_a = k;
        }
        let pb = nx * b.verts[3 * k] + ny * b.verts[3 * k + 1] + nz * b.verts[3 * k + 2];
        if pb > max_b {
            max_b = pb;
            k_max_b = k;
        }
        if pb < min_b {
            min_b = pb;
            k_min_b = k;
        }
    }
    let hi_owner = if max_a <= max_b { 0 } else { 1 };
    let lo_owner = if min_a >= min_b { 0 } else { 1 };
    let ov = (if hi_owner == 0 { max_a } else { max_b }) - (if lo_owner == 0 { min_a } else { min_b });
    if ov < *best {
        *best = ov;
        ct.n = n;
        ct.kind = kind;
        ct.hi_owner = hi_owner;
        ct.hi_k = if hi_owner == 0 { k_max_a } else { k_max_b };
        ct.lo_owner = lo_owner;
        ct.lo_k = if lo_owner == 0 { k_min_a } else { k_min_b };
        ct.l = l;
        if kind == 2 {
            ct.e_a = [a.edges[3 * ia], a.edges[3 * ia + 1], a.edges[3 * ia + 2]];
            ct.e_b = [b.edges[3 * ib], b.edges[3 * ib + 1], b.edges[3 * ib + 2]];
        }
    }
    *best <= 0.0
}

/// Penetration depth of two placed solids (fills `ct` with the axis that sets it). Returns the depth,
/// <= 0 when the solids are separated (touching, at 0, is allowed), stopping at the first separating axis.
/// packages/boundary/src/search/solids.ts: satContact
fn sat_contact(shape: &PieceShape, a: &Placed, b: &Placed, ct: &mut Contact) -> f64 {
    let nv = shape.vertices.len();
    let mut best = f64::INFINITY;
    let nf = shape.normals.len();
    for f in 0..nf {
        if try_axis(a, b, nv, [a.normals[3 * f], a.normals[3 * f + 1], a.normals[3 * f + 2]], 0, f, 0, 1.0, &mut best, ct) {
            ct.depth = best;
            return best;
        }
    }
    for f in 0..nf {
        if try_axis(a, b, nv, [b.normals[3 * f], b.normals[3 * f + 1], b.normals[3 * f + 2]], 1, 0, f, 1.0, &mut best, ct) {
            ct.depth = best;
            return best;
        }
    }
    let nd = shape.edge_dirs.len();
    for ia in 0..nd {
        let (ax, ay, az) = (a.edges[3 * ia], a.edges[3 * ia + 1], a.edges[3 * ia + 2]);
        for ib in 0..nd {
            let (bx, by, bz) = (b.edges[3 * ib], b.edges[3 * ib + 1], b.edges[3 * ib + 2]);
            let mut nx = ay * bz - az * by;
            let mut ny = az * bx - ax * bz;
            let mut nz = ax * by - ay * bx;
            let l = math::hypot3(nx, ny, nz);
            if l < 1e-7 {
                continue;
            }
            nx /= l;
            ny /= l;
            nz /= l;
            if try_axis(a, b, nv, [nx, ny, nz], 2, ia, ib, l, &mut best, ct) {
                ct.depth = best;
                return best;
            }
        }
    }
    ct.depth = best;
    best
}

/// Adds `scale` times the gradient of the contact's depth into gc[0], gt[0] (the centre and the rotation
/// increment of A) and gc[1], gt[1] (B), by the feature that sets the depth (module header).
/// packages/boundary/src/search/solids.ts: contactGradient
fn contact_gradient(a: &Placed, b: &Placed, c_a: V3, c_b: V3, ct: &Contact, scale: f64, gc: &mut [V3; 2], gt: &mut [V3; 2]) {
    let n = ct.n;
    let pp = if ct.hi_owner == 0 { a } else { b };
    let qq = if ct.lo_owner == 0 { a } else { b };
    let c_p = if ct.hi_owner == 0 { c_a } else { c_b };
    let c_q = if ct.lo_owner == 0 { c_a } else { c_b };
    let p: V3 = [pp.verts[3 * ct.hi_k], pp.verts[3 * ct.hi_k + 1], pp.verts[3 * ct.hi_k + 2]];
    let q: V3 = [qq.verts[3 * ct.lo_k], qq.verts[3 * ct.lo_k + 1], qq.verts[3 * ct.lo_k + 2]];
    let rho_p: V3 = [p[0] - c_p[0], p[1] - c_p[1], p[2] - c_p[2]];
    let rho_q: V3 = [q[0] - c_q[0], q[1] - c_q[1], q[2] - c_q[2]];
    let d: V3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    // n . (dP - dQ): centres and the vertices' own rotation
    let (ip, iq) = (ct.hi_owner as usize, ct.lo_owner as usize);
    for k in 0..3 {
        gc[ip][k] += scale * n[k];
        gc[iq][k] -= scale * n[k];
    }
    let rp = cross3(rho_p, n);
    let rq = cross3(rho_q, n);
    for k in 0..3 {
        gt[ip][k] += scale * rp[k];
        gt[iq][k] -= scale * rq[k];
    }
    // the axis itself moves with the solids that make it
    if ct.kind == 0 || ct.kind == 1 {
        let nq = cross3(n, d);
        let gtk = if ct.kind == 0 { 0 } else { 1 };
        for k in 0..3 {
            gt[gtk][k] += scale * nq[k];
        }
    } else {
        let dn = dot3(n, d);
        let dperp: V3 = [d[0] - dn * n[0], d[1] - dn * n[1], d[2] - dn * n[2]];
        let a_v = cross3(ct.e_a, cross3(ct.e_b, dperp));
        let b_v = cross3(ct.e_b, cross3(dperp, ct.e_a));
        for k in 0..3 {
            gt[0][k] += (scale * a_v[k]) / ct.l;
            gt[1][k] += (scale * b_v[k]) / ct.l;
        }
    }
}

// ---------------------------------------------------------------- a hinge segment inside a piece

#[derive(Clone, Copy)]
struct HingeHit {
    depth: f64,
    /// The point of the segment where the depth is largest (anchor frame).
    x: V3,
    /// Active faces (world normals) and the weight of the first.
    n1: V3,
    n2: Option<V3>,
    w1: f64,
}

/// Depth of the segment a + t (b - a), t in [t0, t1], inside the placed solid (R, u): the largest, over
/// the segment, of the least distance to the faces' planes (r - max_k N_k . (x - u)). Concave piecewise
/// linear in t: the maximum is at an end or where a rising face function crosses a falling one.
/// packages/boundary/src/search/solids.ts: hingeDepth
#[allow(clippy::too_many_arguments)]
fn hinge_depth(shape: &PieceShape, normals: &[f64], u: V3, a: V3, b: V3, t0: f64, t1: f64, hit: &mut HingeHit) -> f64 {
    let nf = shape.normals.len();
    let mut ca = vec![0.0f64; nf];
    let mut cb = vec![0.0f64; nf];
    let dx: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    for k in 0..nf {
        let (nx, ny, nz) = (normals[3 * k], normals[3 * k + 1], normals[3 * k + 2]);
        ca[k] = nx * (a[0] - u[0]) + ny * (a[1] - u[1]) + nz * (a[2] - u[2]);
        cb[k] = nx * dx[0] + ny * dx[1] + nz * dx[2];
    }
    let r = shape.inradius;
    let g = |t: f64| -> f64 {
        let mut m = f64::NEG_INFINITY;
        for k in 0..nf {
            m = math::max(m, ca[k] + t * cb[k]);
        }
        r - m
    };
    let mut best_t = t0;
    let mut best = g(t0);
    let g1 = g(t1);
    if g1 > best {
        best = g1;
        best_t = t1;
    }
    for i in 0..nf {
        if !(cb[i] > 0.0) {
            continue;
        }
        for j in 0..nf {
            if !(cb[j] < 0.0) {
                continue;
            }
            let t = (ca[j] - ca[i]) / (cb[i] - cb[j]);
            if t >= t0 && t <= t1 {
                let v = g(t);
                if v > best {
                    best = v;
                    best_t = t;
                }
            }
        }
    }
    hit.depth = best;
    if !(best > 0.0) {
        return best;
    }
    hit.x = [a[0] + best_t * dx[0], a[1] + best_t * dx[1], a[2] + best_t * dx[2]];
    // active faces at bestT: those within a hair of the largest face function
    let mut m = f64::NEG_INFINITY;
    for k in 0..nf {
        m = math::max(m, ca[k] + best_t * cb[k]);
    }
    let mut act: Vec<usize> = Vec::new();
    for k in 0..nf {
        if ca[k] + best_t * cb[k] >= m - 1e-11 {
            act.push(k);
        }
    }
    let nrm = |k: usize| -> V3 { [normals[3 * k], normals[3 * k + 1], normals[3 * k + 2]] };
    hit.n1 = nrm(act[0]);
    hit.n2 = None;
    hit.w1 = 1.0;
    if best_t > t0 + 1e-12 && best_t < t1 - 1e-12 && act.len() >= 2 {
        // a crossing of a rising and a falling face: the weight that cancels the t-derivative
        let mut rise = act[0];
        let mut fall: i64 = -1;
        for &k in &act {
            if cb[k] > cb[rise] {
                rise = k;
            }
        }
        for &k in &act {
            if fall < 0 || cb[k] < cb[fall as usize] {
                fall = k as i64;
            }
        }
        if cb[rise] > 0.0 && fall >= 0 && cb[fall as usize] < 0.0 {
            let fall = fall as usize;
            // lambda cb_rise + (1 - lambda) cb_fall = 0
            let lam = -cb[fall] / (cb[rise] - cb[fall]);
            hit.n1 = nrm(rise);
            hit.n2 = Some(nrm(fall));
            hit.w1 = lam;
        }
    }
    best
}

// ---------------------------------------------------------------- the model

const MAX_CHAINS: f64 = 4096.0;

/// packages/boundary/src/search/solids.ts: SolidModel
pub struct SolidModel {
    poly: &'static Polytope,
    piece: String,
    p: usize,
    floor: f64,
    shape: &'static PieceShape,
    a: Placed,
    b: Placed,
    ct: Contact,
}

impl SolidModel {
    pub fn new(poly: &'static Polytope, piece: &str, p: usize) -> SolidModel {
        let shape = piece_shape(piece).expect("a Platonic piece");
        let floor = piece_bounds(&poly.name, piece, p as f64).expect("bounds of a catalogue problem").value;
        SolidModel { poly, piece: piece.to_string(), p, floor, shape, a: Placed::new(shape), b: Placed::new(shape), ct: Contact::default() }
    }

    /// The energy (adding its gradient into g: 3P centre entries then 3P rotation entries), or with
    /// `violation` the largest depth. packages/boundary/src/search/solids.ts: SolidModel.evaluate
    fn evaluate(&mut self, cells: &[usize], u_all: &[f64], r_all: &[f64], s: f64, mut g: Option<&mut [f64]>, violation: bool) -> f64 {
        let poly = self.poly;
        let t = topo(poly);
        let p = cells.len();
        let sh = self.shape;
        let reach = 2.0 * sh.circumradius;
        let mut by_cell: Vec<Vec<usize>> = poly.cells.iter().map(|_| Vec::new()).collect();
        for i in 0..p {
            by_cell[cells[i]].push(i);
        }
        let off = 3 * p;
        let mut e = 0.0;
        let mut worst = f64::NEG_INFINITY;
        let mut gc: [V3; 2] = [[0.0; 3]; 2];
        let mut gt: [V3; 2] = [[0.0; 3]; 2];
        let mut hit = HingeHit { depth: 0.0, x: [0.0; 3], n1: [0.0; 3], n2: None, w1: 1.0 };
        let mut rj = [0.0f64; 9];
        let ne = poly.edges.len();
        let mut edge_depth = vec![0.0f64; ne];
        let mut edge_hit: Vec<Option<HingeHit>> = vec![None; ne];
        let mut ct = self.ct;
        for i in 0..p {
            let u = clamp_to_cell(poly, cells[i], &[u_all[3 * i], u_all[3 * i + 1], u_all[3 * i + 2]], s, ridge_snap(s, None));
            let nodes = match enumerate_chains(poly, s, cells[i], &u, reach, &ChainOptions { max_chains: Some(MAX_CHAINS), ..Default::default() }) {
                Ok(n) => n,
                Err(_) => return f64::INFINITY,
            };
            self.a.set(sh, u, r_all, 9 * i);
            for (ni, node) in nodes.iter().enumerate() {
                // ---- the edges of the polytope in this chain, inside the piece: one term per polytope edge, its deepest
                // hit over the chains (an edge on the rim of several windows is seen by each of them, and rounding
                // decides which: the deepest does not depend on that)
                if node.gate_dist <= sh.circumradius {
                    let ct_ = &t.cells[node.cell];
                    let v: Vec<V3> = ct_.verts.iter().map(|q| iso_apply(&node.to_anchor, [q[0] * s, q[1] * s, q[2] * s])).collect();
                    for (hi, &[ha, hb]) in poly.cells[node.cell].hinges.iter().enumerate() {
                        let Some(iv) = clip_segment_to_window(&node.window, u, v[ha], v[hb]) else { continue };
                        let d = hinge_depth(sh, &self.a.normals, u, v[ha], v[hb], iv.0, iv.1, &mut hit);
                        if !(d > 0.0) {
                            continue;
                        }
                        let ge = t.hinge_edge[node.cell][hi] as usize;
                        if d > edge_depth[ge] {
                            edge_depth[ge] = d;
                            edge_hit[ge] = Some(hit);
                        }
                    }
                }
                // ---- the other pieces (and this one, along a non-trivial chain) in this chain's cell
                for &j in &by_cell[node.cell] {
                    if j < i || (j == i && ni == 0) {
                        continue;
                    }
                    let uj: V3 = if j == i { u } else { [u_all[3 * j], u_all[3 * j + 1], u_all[3 * j + 2]] };
                    let y = iso_apply(&node.to_anchor, uj);
                    if !in_window(node, u, y, 0.0) {
                        continue;
                    }
                    let dist = math::hypot3(y[0] - u[0], y[1] - u[1], y[2] - u[2]);
                    if dist >= reach {
                        continue;
                    }
                    if j == i && dist <= 1e-12 {
                        continue;
                    }
                    mul9(&node.to_anchor.m, 0, r_all, 9 * j, &mut rj, 0);
                    self.b.set(sh, y, &rj, 0);
                    let depth = sat_contact(sh, &self.a, &self.b, &mut ct);
                    if !(depth > 0.0) {
                        continue;
                    }
                    if violation {
                        worst = math::max(worst, depth);
                        continue;
                    }
                    e += depth * depth;
                    let Some(g) = g.as_deref_mut() else { continue };
                    gc = [[0.0; 3]; 2];
                    gt = [[0.0; 3]; 2];
                    contact_gradient(&self.a, &self.b, u, y, &ct, 2.0 * depth, &mut gc, &mut gt);
                    let m = &node.to_anchor.m;
                    let detm = det9(m, 0);
                    for k in 0..3 {
                        g[3 * i + k] += gc[0][k];
                        g[off + 3 * i + k] += gt[0][k];
                        // back to piece j's own frame: M^T for the centre, det(M) M^T for the rotation increment
                        g[3 * j + k] += m[k] * gc[1][0] + m[3 + k] * gc[1][1] + m[6 + k] * gc[1][2];
                        g[off + 3 * j + k] += detm * (m[k] * gt[1][0] + m[3 + k] * gt[1][1] + m[6 + k] * gt[1][2]);
                    }
                }
            }
            // the edges' terms
            for ed in 0..ne {
                let d = edge_depth[ed];
                if !(d > 0.0) {
                    continue;
                }
                edge_depth[ed] = 0.0;
                if violation {
                    worst = math::max(worst, d);
                    continue;
                }
                e += d * d;
                let Some(g) = g.as_deref_mut() else { continue };
                let h = edge_hit[ed].expect("a hit was recorded with the depth");
                let c = 2.0 * d;
                let dxu: V3 = [h.x[0] - u[0], h.x[1] - u[1], h.x[2] - u[2]];
                // depth = r - N . (x - u) at the active face(s): d/du = N, d/dtheta = (x - u) x N
                let faces: Vec<(V3, f64)> = match h.n2 {
                    Some(n2) => vec![(h.n1, h.w1), (n2, 1.0 - h.w1)],
                    None => vec![(h.n1, 1.0)],
                };
                for (nn, w) in faces {
                    let gtv = cross3(dxu, nn);
                    for k in 0..3 {
                        g[3 * i + k] += c * w * nn[k];
                        g[off + 3 * i + k] += c * w * gtv[k];
                    }
                }
            }
        }
        self.ct = ct;
        let _ = (&gc, &gt);
        if violation {
            worst
        } else {
            e
        }
    }
}

impl Finish for SolidModel {
    fn floor(&self) -> f64 {
        self.floor
    }

    fn violation(&mut self, st: &State, s: f64) -> f64 {
        self.evaluate(&st.cells, &st.u, st.r.as_ref().expect("an orientation per piece"), s, None, true)
    }

    fn pieces(&mut self, st: &State, s: f64) -> Vec<BoundaryPiece> {
        let mut out = clamped_pieces(self.poly, st, s);
        let mirror = &self.shape.mirror;
        let mut tmp = [0.0f64; 9];
        let r = st.r.as_ref().expect("an orientation per piece");
        for (i, piece) in out.iter_mut().enumerate() {
            let mut ri = [0.0f64; 9];
            ri.copy_from_slice(&r[9 * i..9 * i + 9]);
            orthonormalize(&mut ri, 0);
            // an improper orientation is the same piece turned by the solid's mirror
            if det9(&ri, 0) < 0.0 {
                mul9(&ri, 0, mirror, 0, &mut tmp, 0);
                ri.copy_from_slice(&tmp);
                orthonormalize(&mut ri, 0);
            }
            piece.q = Some(matrix_to_quaternion(&ri));
        }
        out
    }
}

impl PieceModel for SolidModel {
    fn rotates(&self) -> bool {
        true
    }

    fn target(&self) -> f64 {
        1e-20
    }

    fn max_step(&self) -> f64 {
        0.25
    }

    fn energy(&mut self, st: &State, s: f64, g: &mut [f64]) -> f64 {
        g.fill(0.0);
        self.evaluate(&st.cells, &st.u, st.r.as_ref().expect("an orientation per piece"), s, Some(g), false)
    }

    /// A random start edge: pieces at a quarter of the boundary's volume, never below 1.35 of the proven
    /// bound, and roomy enough that a cell's inscribed ball holds the solid's circumscribed ball.
    fn start_edge(&self) -> f64 {
        let f = self.floor;
        let vol = math::cbrt((4.0 * self.p as f64 * self.shape.volume) / boundary_volume(self.poly));
        let room = self.shape.circumradius / container_facts(&self.poly.name).expect("a catalogue polytope").inradius;
        math::max_of(&[1.35 * f, vol, room])
    }

    fn random_state(&mut self, s: f64, rand: &mut Mulberry32) -> State {
        let c = self.poly.cells.len();
        let mut cells = vec![0usize; self.p];
        let mut u = vec![0.0; 3 * self.p];
        let mut r = vec![0.0; 9 * self.p];
        for i in 0..self.p {
            cells[i] = rand.int(c);
            u[3 * i..3 * i + 3].copy_from_slice(&random_cell_point(self.poly, cells[i], s, rand, 0.6));
            r[9 * i..9 * i + 9].copy_from_slice(&random_rotation(rand));
        }
        State { cells, u, r: Some(r) }
    }

    fn hop(&mut self, st: &State, s: f64, rand: &mut Mulberry32) -> State {
        let mut out = copy_state(st);
        let k = 1 + rand.int(3);
        for _ in 0..k {
            let i = rand.int(self.p);
            out.cells[i] = rand.int(self.poly.cells.len());
            out.u[3 * i..3 * i + 3].copy_from_slice(&random_cell_point(self.poly, out.cells[i], s, rand, 0.6));
            out.r.as_mut().unwrap()[9 * i..9 * i + 9].copy_from_slice(&random_rotation(rand));
        }
        out
    }

    /// The cells themselves, when the solid is the polytope's own cell and P <= C: each piece centred in a
    /// cell and turned onto it, valid from s = 1 (a hair above); None otherwise.
    fn constructed_start(&mut self, rand: &mut Mulberry32) -> Res<Option<(State, f64)>> {
        let c = self.poly.cells.len();
        if self.p > c {
            return Ok(None);
        }
        let mut rs: Vec<[f64; 9]> = Vec::new();
        for cell in &self.poly.cells {
            let verts: Vec<V3> = cell.vertices.iter().map(|v| [v[0], v[1], v[2]]).collect();
            match rotation_onto(self.shape, &verts) {
                Some(r) => rs.push(r),
                None => return Ok(None),
            }
        }
        let mut order: Vec<usize> = (0..c).collect();
        let mut cells = vec![0usize; self.p];
        let mut r = vec![0.0; 9 * self.p];
        for i in 0..self.p {
            let j = i + rand.int(c - i);
            order.swap(i, j);
            cells[i] = order[i];
            r[9 * i..9 * i + 9].copy_from_slice(&rs[order[i]]);
        }
        Ok(Some((State { cells, u: vec![0.0; 3 * self.p], r: Some(r) }, 1.0 + 1e-6)))
    }

    fn state_of(&self, config: &BoundaryConfig) -> Option<State> {
        if config.pieces.len() != self.p {
            return None;
        }
        if !(config.s.is_finite() && config.s > 0.0) {
            return None;
        }
        let mut cells = vec![0usize; self.p];
        let mut u = vec![0.0; 3 * self.p];
        let mut r = vec![0.0; 9 * self.p];
        for i in 0..self.p {
            let p = &config.pieces[i];
            if p.cell >= self.poly.cells.len() || p.u.len() != 3 || !p.u.iter().all(|x| x.is_finite()) {
                return None;
            }
            cells[i] = p.cell;
            u[3 * i..3 * i + 3].copy_from_slice(&clamp_to_cell(self.poly, p.cell, &p.u, config.s, ridge_snap(config.s, None)));
            let m = match &p.q {
                Some(q) => quaternion_to_matrix(q),
                None => [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            };
            r[9 * i..9 * i + 9].copy_from_slice(&m);
        }
        Some(State { cells, u, r: Some(r) })
    }
}

impl SolidModel {
    /// The piece's name.
    pub fn piece(&self) -> &str {
        &self.piece
    }
}

/// packages/boundary/src/pieces.ts: inv3m
fn inv3m(m: &[f64; 9]) -> Option<[f64; 9]> {
    let [a, b, c, d, e, f, g, h, i] = *m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-12 {
        return None;
    }
    Some([
        (e * i - f * h) / det,
        (c * h - b * i) / det,
        (b * f - c * e) / det,
        (f * g - d * i) / det,
        (a * i - c * g) / det,
        (c * d - a * f) / det,
        (d * h - e * g) / det,
        (b * g - a * h) / det,
        (a * e - b * d) / det,
    ])
}

/// A proper rotation matrix (row-major) taking the standard `shape` onto the solid with the given
/// vertices (the same solid at unit edge, in any pose, centre anywhere), or None when there is none:
/// used to place a piece exactly onto a cell of its own shape.
/// packages/boundary/src/pieces.ts: rotationOnto
pub fn rotation_onto(shape: &PieceShape, vertices: &[V3]) -> Option<[f64; 9]> {
    let n = vertices.len();
    if n != shape.vertices.len() {
        return None;
    }
    let mut c: V3 = [0.0; 3];
    for v in vertices {
        for k in 0..3 {
            c[k] += v[k] / n as f64;
        }
    }
    let t: Vec<V3> = vertices.iter().map(|v| sub3(*v, c)).collect();
    let s = &shape.vertices;
    // three vertices of the standard solid that are linearly independent
    let mut tri: Option<[usize; 3]> = None;
    let mut s_inv: Option<[f64; 9]> = None;
    'outer: for a in 0..s.len() {
        for b in (a + 1)..s.len() {
            for d in (b + 1)..s.len() {
                if let Some(inv) = inv3m(&[s[a][0], s[b][0], s[d][0], s[a][1], s[b][1], s[d][1], s[a][2], s[b][2], s[d][2]]) {
                    tri = Some([a, b, d]);
                    s_inv = Some(inv);
                    break 'outer;
                }
            }
        }
    }
    let (tri, s_inv) = (tri?, s_inv?);
    let dist = |p: V3, q: V3| math::hypot3(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    for j0 in 0..n {
        for j1 in 0..n {
            if j1 == j0 || (dist(t[j0], t[j1]) - dist(s[tri[0]], s[tri[1]])).abs() > 1e-9 {
                continue;
            }
            for j2 in 0..n {
                if j2 == j0 || j2 == j1 {
                    continue;
                }
                if (dist(t[j0], t[j2]) - dist(s[tri[0]], s[tri[2]])).abs() > 1e-9 || (dist(t[j1], t[j2]) - dist(s[tri[1]], s[tri[2]])).abs() > 1e-9 {
                    continue;
                }
                // R S3 = T3  =>  R = T3 S3^-1 (columns)
                let t3 = [t[j0][0], t[j1][0], t[j2][0], t[j0][1], t[j1][1], t[j2][1], t[j0][2], t[j1][2], t[j2][2]];
                let mut r = [0.0f64; 9];
                for i in 0..3 {
                    for j in 0..3 {
                        for k in 0..3 {
                            r[3 * i + j] += t3[3 * i + k] * s_inv[3 * k + j];
                        }
                    }
                }
                let det = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
                if det < 0.0 {
                    continue;
                }
                // every vertex of the standard solid must land on a vertex of the target
                let ok = s.iter().all(|v| {
                    let w: V3 = [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
                    t.iter().any(|tt| dist(*tt, w) < 1e-9)
                });
                if ok {
                    return Some(r);
                }
            }
        }
    }
    None
}
