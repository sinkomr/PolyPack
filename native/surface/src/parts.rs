//! The parts of a piece on the faces of a solid, and their separation.
//! Port of what the server reaches of `packages/surface/src/parts.ts`.

use crate::chains::{enumerate_chains, ChainError, ChainNode, Wedge};
use crate::disk::inner_reach;
use crate::geometry::{inradius, piece_vertices, Pose};
use crate::rigid::{apply, inverse};
use crate::solids::{face_apothem, face_vertex, Solid};
use polypack_js::math;
use polypack_js::math::PI;
use std::borrow::Cow;

/// `packages/surface/src/parts.ts: SurfacePose`. A piece on the surface: anchor face and
/// (x, y, theta) in that face's frame.
///
/// `face` is a number as in the TypeScript, so that a configuration read from JSON keeps what it
/// said (a face of 1.5 or -1 is refused by the validator's `check_shape` with the TypeScript's
/// message). Everything else in this crate is called with a face that passed that check.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfacePose {
    pub face: f64,
    pub x: f64,
    pub y: f64,
    pub theta: f64,
}

impl SurfacePose {
    /// The pose in the plane of its face (`{x, y, theta}`).
    pub fn pose(&self) -> Pose {
        Pose { x: self.x, y: self.y, theta: self.theta }
    }
    /// The anchor face as an index (of a pose whose face is a valid face of the solid).
    pub fn face_index(&self) -> usize {
        self.face as usize
    }
}

/// `packages/surface/src/parts.ts: HalfPlanes`. Half-planes nx x + ny y <= b with unit normals, as
/// parallel arrays.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HalfPlanes {
    pub nx: Vec<f64>,
    pub ny: Vec<f64>,
    pub b: Vec<f64>,
}

/// `packages/surface/src/parts.ts: Outline`. A convex outline in the anchor frame: its corners and
/// the half-planes of its sides, side k from corner k to k + 1.
#[derive(Clone, Debug, PartialEq)]
pub struct Outline {
    pub poly: Vec<f64>,
    pub nx: Vec<f64>,
    pub ny: Vec<f64>,
    pub b: Vec<f64>,
}

/// `packages/surface/src/parts.ts: Part`. The part of one piece that lies on one face, in that
/// face's own frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub piece: usize,
    /// index of the chain node in the piece's chain list
    pub chain: usize,
    pub face: usize,
    /// counter-clockwise flat array; empty when the part is empty
    pub poly: Vec<f64>,
    /// The half-planes the part was cut from, in this face's frame: the piece's sides, the rays of
    /// its chain's wedge and the face's edges, from their exact normals. Every side of the part
    /// lies on one of them (see `part_separation`).
    pub cuts: HalfPlanes,
    /// piece centre and angle mapped into this face's frame (the developed piece)
    pub cx: f64,
    pub cy: f64,
    pub theta: f64,
}

/// `packages/surface/src/parts.ts: DISK_SIDES`. Disk approximation used only for drawing circle pieces.
pub const DISK_SIDES: usize = 96;

/// `packages/surface/src/parts.ts: HalfPlane`. Half-plane a.x <= b, as used by the clipper.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HalfPlane {
    pub ax: f64,
    pub ay: f64,
    pub b: f64,
}

/// `packages/surface/src/parts.ts: clipHalfPlane`. Sutherland–Hodgman clip of a convex polygon by
/// one half-plane. (The TypeScript writes into two scratch buffers and returns a copy; here the
/// result is the vector it is built in.)
pub fn clip_half_plane(poly: &[f64], h: &HalfPlane) -> Vec<f64> {
    let n = poly.len() / 2;
    if n == 0 {
        return poly.to_vec();
    }
    // at most two corners per side
    let mut out: Vec<f64> = Vec::with_capacity(4 * n);
    let ax = h.ax;
    let ay = h.ay;
    let hb = h.b;
    for i in 0..n {
        let j = (i + 1) % n;
        let px = poly[2 * i];
        let py = poly[2 * i + 1];
        let qx = poly[2 * j];
        let qy = poly[2 * j + 1];
        let dp = ax * px + ay * py - hb;
        let dq = ax * qx + ay * qy - hb;
        if dp <= 0.0 {
            out.push(px);
            out.push(py);
        }
        if (dp < 0.0 && dq > 0.0) || (dp > 0.0 && dq < 0.0) {
            let t = dp / (dp - dq);
            out.push(px + t * (qx - px));
            out.push(py + t * (qy - py));
        }
    }
    dedupe_corners(&out)
}

/// `packages/surface/src/parts.ts: sameCorner`. Two corners closer than rounding (dedupe's test;
/// not symmetric: a is the corner kept).
#[inline]
fn same_corner(ax: f64, ay: f64, bx: f64, by: f64) -> bool {
    (ax - bx).abs() <= 1e-15 * (1.0 + ax.abs()) && (ay - by).abs() <= 1e-15 * (1.0 + ay.abs())
}

/// `packages/surface/src/parts.ts: dedupeCorners`. Drops repeated consecutive vertices (a vertex on
/// the clip line is emitted twice), so that no edge has zero length: a zero-length edge has no
/// normal and would break separating-axis tests. Fewer than three corners left are no polygon.
fn dedupe_corners(out: &[f64]) -> Vec<f64> {
    let mut res: Vec<f64> = Vec::with_capacity(out.len());
    let mut i = 0;
    while i < out.len() {
        let n = res.len();
        if n >= 2 && same_corner(res[n - 2], res[n - 1], out[i], out[i + 1]) {
            i += 2;
            continue;
        }
        res.push(out[i]);
        res.push(out[i + 1]);
        i += 2;
    }
    let mut n = res.len();
    while n >= 4 && same_corner(res[0], res[1], res[n - 2], res[n - 1]) {
        n -= 2;
    }
    if n >= 6 {
        res.truncate(n);
        res
    } else {
        Vec::new()
    }
}

/// `packages/surface/src/parts.ts: wedgeHalfPlanes`. Half-planes of the closed wedge with apex
/// (cx, cy): cross(lo, p - c) >= 0 and cross(p - c, hi) >= 0.
pub fn wedge_half_planes(w: &Wedge, cx: f64, cy: f64) -> [HalfPlane; 2] {
    // cross(l, v) = lx vy - ly vx >= 0  <=>  (ly, -lx) . v <= 0
    let a1 = HalfPlane { ax: w.ly, ay: -w.lx, b: w.ly * cx - w.lx * cy };
    // cross(v, h) = vx hy - vy hx >= 0  <=>  (-hy, hx) . v <= 0
    let a2 = HalfPlane { ax: -w.hy, ay: w.hx, b: -w.hy * cx + w.hx * cy };
    [a1, a2]
}

/// `packages/surface/src/parts.ts: polygonHalfPlanes`. Half-planes of a counter-clockwise convex
/// polygon (inside is to the left of every edge).
pub fn polygon_half_planes(poly: &[f64]) -> Vec<HalfPlane> {
    let n = poly.len() / 2;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let j = (i + 1) % n;
        let ex = poly[2 * j] - poly[2 * i];
        let ey = poly[2 * j + 1] - poly[2 * i + 1];
        // outward normal (ey, -ex)
        out.push(HalfPlane { ax: ey, ay: -ex, b: ey * poly[2 * i] - ex * poly[2 * i + 1] });
    }
    out
}

/// `packages/surface/src/parts.ts: piecePolygon`. The piece polygon (disks approximated by
/// DISK_SIDES sides, for drawing) in its anchor frame. `scale` is the kernels' convention
/// (disk.rs): a disk has radius `scale`.
pub fn piece_polygon(n: usize, pose: &SurfacePose, scale: f64) -> Vec<f64> {
    if n == 0 {
        let mut out = vec![0.0; 2 * DISK_SIDES];
        // circumscribed polygon so that the drawn part covers the disk
        let r = scale / math::cos(PI / DISK_SIDES as f64);
        for k in 0..DISK_SIDES {
            let a = (2.0 * PI * k as f64) / DISK_SIDES as f64;
            out[2 * k] = pose.x + r * math::cos(a);
            out[2 * k + 1] = pose.y + r * math::sin(a);
        }
        return out;
    }
    piece_vertices(n, pose.pose(), scale)
}

/// `packages/surface/src/parts.ts: pieceChains`. Chains of a piece: every chain a ray of length
/// <= scale * boundingRadius(N) from its centre can follow.
pub fn piece_chains(
    solid: &Solid,
    s: f64,
    n: usize,
    pose: &SurfacePose,
    scale: f64,
    max_chains: f64,
) -> Result<Vec<ChainNode>, ChainError> {
    enumerate_chains(solid, s, pose.face_index(), pose.x, pose.y, scale * inner_reach(n), max_chains)
}

/// `packages/surface/src/parts.ts: pieceOutline`. The piece polygon of `piece_polygon` with the
/// half-planes of its sides, written from their angles: side k of an N-gon has its outward normal
/// at theta + pi/2 + (k + 1/2) 2 pi / N and lies at the inradius from the centre; side k of the
/// disk's circumscribed polygon at (2 k + 1) pi / DISK_SIDES and at the radius.
pub fn piece_outline(n_sides: usize, pose: &SurfacePose, scale: f64) -> Outline {
    let poly = piece_polygon(n_sides, pose, scale);
    let n = if n_sides == 0 { DISK_SIDES } else { n_sides };
    let mut nx = vec![0.0; n];
    let mut ny = vec![0.0; n];
    let mut b = vec![0.0; n];
    let r = if n_sides == 0 { scale } else { inradius(n_sides) * scale };
    for k in 0..n {
        let a = if n_sides == 0 {
            ((2.0 * k as f64 + 1.0) * PI) / n as f64
        } else {
            pose.theta + PI / 2.0 + ((k as f64 + 0.5) * 2.0 * PI) / n as f64
        };
        nx[k] = math::cos(a);
        ny[k] = math::sin(a);
        b[k] = nx[k] * pose.x + ny[k] * pose.y + r;
    }
    Outline { poly, nx, ny, b }
}

/// `packages/surface/src/parts.ts: faceCuts`. The half-planes of a face in its own frame at edge
/// s: edge j (frame vertex j to j + 1) has its outward normal at 2 pi (j + 1) / M - pi / 2 and lies
/// at the apothem.
pub fn face_cuts(solid: &Solid, s: f64) -> HalfPlanes {
    // a Platonic solid: every face is the same regular M-gon in the same frame
    let m = solid.m;
    let mut nx = vec![0.0; m];
    let mut ny = vec![0.0; m];
    let b = vec![face_apothem(m, s); m];
    for j in 0..m {
        let a = (2.0 * PI * (j as f64 + 1.0)) / m as f64 - PI / 2.0;
        nx[j] = math::cos(a);
        ny[j] = math::sin(a);
    }
    HalfPlanes { nx, ny, b }
}

/// `packages/surface/src/parts.ts: faceCutsOf`. The half-planes of face f of any solid in its own
/// frame at scale s: edge j from frame vertex j to j + 1, unit outward normal. On the Platonic
/// solids this is `face_cuts`, computed as there.
pub fn face_cuts_of(solid: &Solid, s: f64, f: usize) -> HalfPlanes {
    if solid.uniform {
        return face_cuts(solid, s);
    }
    let m = solid.sides[f];
    let mut nx = vec![0.0; m];
    let mut ny = vec![0.0; m];
    let mut b = vec![0.0; m];
    for j in 0..m {
        let (ax, ay) = face_vertex(solid, s, f, j);
        let (bx, by) = face_vertex(solid, s, f, j + 1);
        let l = math::hypot(bx - ax, by - ay);
        nx[j] = (by - ay) / l;
        ny[j] = -(bx - ax) / l;
        b[j] = nx[j] * ax + ny[j] * ay;
    }
    HalfPlanes { nx, ny, b }
}

/// `packages/surface/src/parts.ts: pieceParts`. Parts of a piece on the faces, each in its face's
/// own frame, along the chains `nodes` of the piece (`piece_chains`; the TypeScript's optional
/// argument, which the validator always gives). For a disk the polygon is the circumscribed
/// DISK_SIDES-gon (drawing only; validation of disks uses distances, see validate.rs).
pub fn piece_parts(solid: &Solid, s: f64, n: usize, pose: &SurfacePose, piece: usize, scale: f64, nodes: &[ChainNode]) -> Vec<Part> {
    develop_parts(solid, s, &piece_outline(n, pose, scale), pose, piece, nodes)
}

/// `packages/surface/src/parts.ts: developParts`. Parts of a convex outline (anchor frame,
/// star-shaped about the pose's centre) developed from the pose's centre along `nodes`, each in its
/// face's own frame: the outline cut by the chain's wedge and by the unfolded face, mapped back.
pub fn develop_parts(solid: &Solid, s: f64, outline: &Outline, pose: &SurfacePose, piece: usize, nodes: &[ChainNode]) -> Vec<Part> {
    let base: &[f64] = &outline.poly;
    // each face's own half-planes (one set for all faces of a Platonic solid)
    let mut own: Vec<Option<HalfPlanes>> = vec![None; if solid.uniform { 1 } else { solid.f }];
    let mut parts: Vec<Part> = Vec::with_capacity(nodes.len());
    let mut face: Vec<f64> = Vec::new();
    for (ci, node) in nodes.iter().enumerate() {
        let mut poly: Cow<[f64]> = Cow::Borrowed(base);
        if let Some(w) = &node.wedge {
            for h in wedge_half_planes(w, pose.x, pose.y) {
                poly = Cow::Owned(clip_half_plane(&poly, &h));
            }
        }
        let m = solid.sides[node.face];
        face.clear();
        for k in 0..m {
            let (x, y) = face_vertex(solid, s, node.face, k);
            let (u, v) = apply(&node.to_anchor, x, y);
            face.push(u);
            face.push(v);
        }
        for h in polygon_half_planes(&face) {
            if poly.is_empty() {
                break;
            }
            poly = Cow::Owned(clip_half_plane(&poly, &h));
        }
        let back = inverse(&node.to_anchor);
        let mut mapped = vec![0.0; poly.len()];
        let mut i = 0;
        while i < poly.len() {
            let (u, v) = apply(&back, poly[i], poly[i + 1]);
            mapped[i] = u;
            mapped[i + 1] = v;
            i += 2;
        }
        let (cx, cy) = apply(&back, pose.x, pose.y);
        let key = if solid.uniform { 0 } else { node.face };
        if own[key].is_none() {
            own[key] = Some(face_cuts_of(solid, s, node.face));
        }
        let cuts = part_cuts(node, outline, pose, own[key].as_ref().unwrap());
        parts.push(Part { piece, chain: ci, face: node.face, poly: mapped, cuts, cx, cy, theta: pose.theta + back.ang });
    }
    parts
}

/// `packages/surface/src/parts.ts: partCuts`. The half-planes a part on node's face was cut from,
/// in that face's frame: the outline's sides and the wedge's rays (anchor frame, mapped back) and
/// the face's own edges.
fn part_cuts(node: &ChainNode, outline: &Outline, pose: &SurfacePose, face: &HalfPlanes) -> HalfPlanes {
    let wedge: Vec<HalfPlane> = match &node.wedge {
        Some(w) => wedge_half_planes(w, pose.x, pose.y).to_vec(),
        None => Vec::new(),
    };
    let no = outline.b.len();
    let n = no + wedge.len() + face.b.len();
    let mut nx = Vec::with_capacity(n);
    let mut ny = Vec::with_capacity(n);
    let mut b = Vec::with_capacity(n);
    // the anchor frame point is p = R q + t for q in the face's frame, so a . p <= c reads (R^T a) . q <= c - a . t
    let t = &node.to_anchor;
    let mut put = |ax: f64, ay: f64, c: f64| {
        nx.push(t.c * ax + t.s * ay);
        ny.push(-t.s * ax + t.c * ay);
        b.push(c - (ax * t.tx + ay * t.ty));
    };
    for k in 0..no {
        put(outline.nx[k], outline.ny[k], outline.b[k]);
    }
    for h in &wedge {
        put(h.ax, h.ay, h.b);
    }
    nx.extend_from_slice(&face.nx);
    ny.extend_from_slice(&face.ny);
    b.extend_from_slice(&face.b);
    HalfPlanes { nx, ny, b }
}

/// `packages/surface/src/parts.ts: cutGap`. Largest gap of the corners q beyond one of the
/// half-planes h (the separating-axis value of h's normals).
fn cut_gap(h: &HalfPlanes, q: &[f64]) -> f64 {
    let mut best = f64::NEG_INFINITY;
    for k in 0..h.b.len() {
        let nx = h.nx[k];
        let ny = h.ny[k];
        let c = h.b[k];
        let mut m = f64::INFINITY;
        let mut i = 0;
        while i < q.len() {
            let d = nx * q[i] + ny * q[i + 1] - c;
            if d < m {
                m = d;
            }
            i += 2;
        }
        if m > best {
            best = m;
        }
    }
    best
}

/// `packages/surface/src/parts.ts: partSeparation`. Separation of two parts on one face (negative:
/// their penetration depth), by separating axes taken from the half-planes each part was cut from
/// rather than from its clipped sides.
///
/// Clipping can leave a part a side about 1e-15 long whose direction rounding makes arbitrary; an
/// axis taken from it can cut a sliver off the part and so call two overlapping parts apart. Here
/// every axis is exact: every side of a part lies on one of its half-planes, so the axes include
/// every side's true normal. A half-plane that does not touch the part only gives a smaller gap
/// along its normal, and any positive gap separates the parts (the part lies in the half-plane),
/// so for overlapping parts the result is exactly minus the separating-axis depth. For parts that
/// are apart it is positive, a lower bound on their distance.
pub fn part_separation(a: &Part, b: &Part) -> f64 {
    math::max(cut_gap(&a.cuts, &b.poly), cut_gap(&b.cuts, &a.poly))
}
