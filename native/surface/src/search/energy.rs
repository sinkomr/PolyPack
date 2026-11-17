//! Overlap energies for the fold search on a solid of edge `s` with pieces scaled by `lam`.
//! Port of `packages/surface/src/search/energy.ts`.
//!
//! E = sum of squared penetrations: part-part overlaps on every face (two parts of one piece
//! included), cone points inside pieces, and for disks the distance form (centre images closer
//! than 2 lam, vertices closer than lam). E = 0 exactly when the float validator (tol 0) accepts.

use super::chains;
use crate::chains::{in_wedge, ChainNode};
use crate::geometry::{bounding_radius, inradius};
use crate::parts::{part_cut_gap, piece_outline, piece_parts, HalfPlanes, SurfacePose};
use crate::rigid::{apply, glue};
use crate::solids::{face_apothem, face_depth, face_vertex, frame_vertex, Solid};
use polypack_js::math;
use polypack_js::math::PI;
use std::rc::Rc;

/// `energy.ts: canonicalize`. Move a pose whose centre left its face into the face that contains
/// it (orientation preserved).
pub fn canonicalize(solid: &Solid, s: f64, p: &SurfacePose) -> SurfacePose {
    if !solid.uniform {
        return canonicalize_general(solid, s, p);
    }
    let mut face = p.face_index();
    let (mut x, mut y, mut theta) = (p.x, p.y, p.theta);
    let m = solid.m;
    let ap = face_apothem(m, s);
    for _step in 0..64 {
        let mut worst = 0.0;
        let mut kw: i32 = -1;
        for j in 0..m {
            let a = (2.0 * PI * (j as f64 + 1.0)) / m as f64 - PI / 2.0;
            let out = x * math::cos(a) + y * math::sin(a) - ap;
            if out > worst {
                worst = out;
                kw = j as i32;
            }
        }
        if kw < 0 {
            return SurfacePose { face: face as f64, x, y, theta };
        }
        // glue maps the neighbour's frame into ours; invert it to express the point in the neighbour's frame
        let g = glue(solid, s, face, kw as usize);
        let t = g.t;
        let ix = -(t.c * t.tx + t.s * t.ty);
        let iy = -(-t.s * t.tx + t.c * t.ty);
        let nx = t.c * x + t.s * y + ix;
        let ny = -t.s * x + t.c * y + iy;
        x = nx;
        y = ny;
        theta -= t.ang;
        face = g.face;
    }
    // A step that jumps across a vertex can circle it without ever landing (the cone angle is below
    // 2 pi, so "beyond the vertex" is not a point of any face). Pull the centre back into the face.
    let ap2 = face_apothem(m, s) * (1.0 - 1e-9);
    let mut worst = 0.0;
    for j in 0..m {
        let a = (2.0 * PI * (j as f64 + 1.0)) / m as f64 - PI / 2.0;
        worst = math::max(worst, (x * math::cos(a) + y * math::sin(a)) / ap2);
    }
    if worst > 1.0 || !worst.is_finite() {
        // scale towards the face centre until the point is inside
        let k = if worst.is_finite() { 1.0 / worst } else { 0.0 };
        x *= k;
        y *= k;
    }
    SurfacePose { face: face as f64, x, y, theta }
}

/// `energy.ts: canonicalizeGeneral`. canonicalize on any convex faces: leave through the edge the
/// point is farthest beyond.
fn canonicalize_general(solid: &Solid, s: f64, p: &SurfacePose) -> SurfacePose {
    let mut face = p.face_index();
    let (mut x, mut y, mut theta) = (p.x, p.y, p.theta);
    for _step in 0..64 {
        let m = solid.sides[face];
        let mut worst = 0.0;
        let mut kw: i32 = -1;
        for j in 0..m {
            let (ax, ay) = face_vertex(solid, s, face, j);
            let (bx, by) = face_vertex(solid, s, face, j + 1);
            let ex = bx - ax;
            let ey = by - ay;
            // distance beyond the edge line (inside is to the left)
            let out = (ey * (x - ax) - ex * (y - ay)) / math::hypot(ex, ey);
            if out > worst {
                worst = out;
                kw = j as i32;
            }
        }
        if kw < 0 {
            return SurfacePose { face: face as f64, x, y, theta };
        }
        let g = glue(solid, s, face, kw as usize);
        let t = g.t;
        let ix = -(t.c * t.tx + t.s * t.ty);
        let iy = -(-t.s * t.tx + t.c * t.ty);
        let nx = t.c * x + t.s * y + ix;
        let ny = -t.s * x + t.c * y + iy;
        x = nx;
        y = ny;
        theta -= t.ang;
        face = g.face;
    }
    // circling a vertex without landing (see canonicalize): pull the centre towards the frame origin,
    // which lies inside the face (the foot of the solid's centre on a face of a convex solid that has
    // an insphere or a circumsphere about that centre; the face centre on a Johnson solid)
    let mut k = 0;
    while k < 60 && face_depth(solid, s, face, x, y) < 0.0 {
        x *= 0.7;
        y *= 0.7;
        k += 1;
    }
    if face_depth(solid, s, face, x, y) < 0.0 {
        x = 0.0;
        y = 0.0;
    }
    SurfacePose { face: face as f64, x, y, theta }
}

/// `energy.ts: PartRec`. A part of a piece on one face with its bounding box.
#[derive(Debug)]
pub struct PartRec {
    pub piece: usize,
    pub poly: Vec<f64>,
    /// the half-planes the part was cut from (parts.ts Part.cuts), the separating axes
    pub cuts: HalfPlanes,
    pub minx: f64,
    pub miny: f64,
    pub maxx: f64,
    pub maxy: f64,
}

/// `energy.ts: bbox`.
pub fn bbox(piece: usize, poly: Vec<f64>, cuts: HalfPlanes) -> PartRec {
    let mut minx = f64::INFINITY;
    let mut miny = f64::INFINITY;
    let mut maxx = f64::NEG_INFINITY;
    let mut maxy = f64::NEG_INFINITY;
    let mut i = 0;
    while i < poly.len() {
        if poly[i] < minx {
            minx = poly[i];
        }
        if poly[i] > maxx {
            maxx = poly[i];
        }
        if poly[i + 1] < miny {
            miny = poly[i + 1];
        }
        if poly[i + 1] > maxy {
            maxy = poly[i + 1];
        }
        i += 2;
    }
    PartRec { piece, poly, cuts, minx, miny, maxx, maxy }
}

/// `parts.ts: partSeparation` of two part records.
#[inline]
pub fn part_sep(a_poly: &[f64], a_cuts: &HalfPlanes, b_poly: &[f64], b_cuts: &HalfPlanes) -> f64 {
    math::max(part_cut_gap(a_cuts, b_poly), part_cut_gap(b_cuts, a_poly))
}

/// Cone points are pushed out first: inside a piece they make its development ill-defined.
pub const CONE_WEIGHT: f64 = 4.0;

/// Pieces are kept inside their faces in the nofold mode with this weight on the squared protrusion.
pub const WALL_WEIGHT: f64 = 4.0;

/// `energy.ts: coneEnergy`. Squared cone-point penetration of one piece. A vertex can show up in
/// several chains (at the same developed point when it lies on a wedge boundary), so each vertex
/// counts once, with its deepest appearance; that keeps the energy continuous.
fn cone_energy(solid: &Solid, s: f64, n: usize, p: &SurfacePose, nodes: &[ChainNode], lam: f64) -> f64 {
    let rin = if n == 0 { lam } else { inradius(n) * lam };
    // vertex id -> deepest penetration, in the order a Map keeps (first appearance)
    let mut worst: Vec<(usize, f64)> = Vec::new();
    // the piece's side normals, the same angles for every vertex
    let mut ca = vec![0.0; n];
    let mut sa = vec![0.0; n];
    for j in 0..n {
        let a = p.theta + PI / 2.0 + PI / n as f64 + (2.0 * PI * j as f64) / n as f64;
        ca[j] = math::cos(a);
        sa[j] = math::sin(a);
    }
    for node in nodes {
        for k in 0..solid.sides[node.face] {
            let (fx, fy) = face_vertex(solid, s, node.face, k);
            let (vx, vy) = apply(&node.to_anchor, fx, fy);
            if !in_wedge(node.wedge.as_ref(), p.x, p.y, vx, vy, 1e-12) {
                continue;
            }
            let out;
            if n == 0 {
                out = math::hypot(vx - p.x, vy - p.y) - lam;
            } else {
                let mut o = f64::NEG_INFINITY;
                for j in 0..n {
                    let t = (vx - p.x) * ca[j] + (vy - p.y) * sa[j] - rin;
                    if t > o {
                        o = t;
                    }
                }
                out = o;
            }
            if out < 0.0 {
                let id = solid.faces[node.face][k];
                match worst.iter_mut().find(|(v, _)| *v == id) {
                    None => worst.push((id, out)),
                    Some(e) => {
                        if out < e.1 {
                            e.1 = out;
                        }
                    }
                }
            }
        }
    }
    let mut e = 0.0;
    for &(_, v) in &worst {
        e += CONE_WEIGHT * v * v;
    }
    e
}

/// `energy.ts: wallEnergy`. Squared protrusion of a polygon (flat vertices in face f's frame)
/// beyond the edges of face f.
fn wall_energy(solid: &Solid, s: f64, f: usize, poly: &[f64]) -> f64 {
    let mut e = 0.0;
    let mut i = 0;
    while i < poly.len() {
        let d = face_depth(solid, s, f, poly[i], poly[i + 1]);
        if d < 0.0 {
            e += WALL_WEIGHT * d * d;
        }
        i += 2;
    }
    e
}

/// What `computePiece` returns: the part records, their faces and the cone (or wall) energy.
struct Computed {
    recs: Vec<Rc<PartRec>>,
    faces: Vec<usize>,
    cone: f64,
    /// the chains used (fold mode), for the cache
    nodes: Option<Rc<Vec<ChainNode>>>,
}

/// `energy.ts: PolygonEnergy`. Polygon pieces: energy with per-piece caches so that moving one
/// piece costs only its own terms. Mode "fold" (default): the parts of the developed pieces and
/// the cone points. Mode "nofold": each piece is its own polygon in its anchor face, with the
/// protrusion beyond the face's edges in place of the cone points (E = 0 exactly when the nofold
/// validator, tolerance 0, accepts).
pub struct PolygonEnergy {
    pub solid: &'static Solid,
    pub s: f64,
    pub n: usize,
    pub nofold: bool,
    pub lam: f64,
    pub poses: Vec<SurfacePose>,
    parts: Vec<Vec<Rc<PartRec>>>,
    part_faces: Vec<Vec<usize>>,
    cone: Vec<f64>,
    by_face: Vec<Vec<Rc<PartRec>>>,
    /// Per piece, the pose its cached parts were computed for, the chains of that pose and the
    /// scale of both (lam can change without a rebuild). The gradient's local energy at the piece's
    /// own pose then reuses the parts, and its steps in theta (same face and centre) reuse the
    /// chains: both are what `compute_piece` would compute again, so every value is unchanged.
    built_pose: Vec<Option<SurfacePose>>,
    built_chains: Vec<Option<Rc<Vec<ChainNode>>>>,
    built_lam: Vec<f64>,
    /// `total()` of the cached parts, until they change (rebuild).
    total_memo: Option<f64>,
}

impl PolygonEnergy {
    pub fn new(solid: &'static Solid, s: f64, n: usize, lam: f64, poses: &[SurfacePose], nofold: bool) -> PolygonEnergy {
        let poses: Vec<SurfacePose> = poses.iter().map(|p| canonicalize(solid, s, p)).collect();
        let mut e = PolygonEnergy {
            solid,
            s,
            n,
            nofold,
            lam,
            poses,
            parts: Vec::new(),
            part_faces: Vec::new(),
            cone: Vec::new(),
            by_face: (0..solid.f).map(|_| Vec::new()).collect(),
            built_pose: Vec::new(),
            built_chains: Vec::new(),
            built_lam: Vec::new(),
            total_memo: None,
        };
        e.rebuild();
        e
    }

    pub fn set_scale(&mut self, lam: f64) {
        self.lam = lam;
        self.rebuild();
    }

    fn compute_piece(&self, i: usize, pose: &SurfacePose) -> Computed {
        if self.nofold {
            let o = piece_outline(self.n, pose, self.lam);
            let cone = wall_energy(self.solid, self.s, pose.face_index(), &o.poly);
            let cuts = HalfPlanes { nx: o.nx, ny: o.ny, b: o.b };
            return Computed { recs: vec![Rc::new(bbox(i, o.poly, cuts))], faces: vec![pose.face_index()], cone, nodes: None };
        }
        let reuse = match &self.built_pose[i] {
            Some(built) => {
                self.built_lam[i] == self.lam
                    && built.face == pose.face
                    && built.x.to_bits() == pose.x.to_bits()
                    && built.y.to_bits() == pose.y.to_bits()
            }
            None => false,
        };
        let nodes: Rc<Vec<ChainNode>> = if reuse {
            self.built_chains[i].clone().unwrap()
        } else {
            Rc::new(chains(self.solid, self.s, pose.face_index(), pose.x, pose.y, self.lam * bounding_radius(self.n)))
        };
        let parts = piece_parts(self.solid, self.s, self.n, pose, i, self.lam, &nodes);
        let mut recs = Vec::new();
        let mut faces = Vec::new();
        for part in parts {
            if part.poly.len() >= 6 {
                faces.push(part.face);
                recs.push(Rc::new(bbox(i, part.poly, part.cuts)));
            }
        }
        let cone = cone_energy(self.solid, self.s, self.n, pose, &nodes, self.lam);
        Computed { recs, faces, cone, nodes: Some(nodes) }
    }

    pub fn rebuild(&mut self) {
        for l in self.by_face.iter_mut() {
            l.clear();
        }
        self.parts = Vec::new();
        self.part_faces = Vec::new();
        self.cone = Vec::new();
        // the scale may have changed: nothing of the earlier caches is reused
        self.total_memo = None;
        self.built_pose = vec![None; self.poses.len()];
        self.built_chains = vec![None; self.poses.len()];
        self.built_lam = vec![f64::NAN; self.poses.len()];
        for i in 0..self.poses.len() {
            let p = self.poses[i];
            let r = self.compute_piece(i, &p);
            if !self.nofold {
                // keep: the pose, its chains and the scale
                self.built_pose[i] = Some(p);
                self.built_chains[i] = r.nodes.clone();
                self.built_lam[i] = self.lam;
            }
            for (t, rec) in r.recs.iter().enumerate() {
                self.by_face[r.faces[t]].push(rec.clone());
            }
            self.parts.push(r.recs);
            self.part_faces.push(r.faces);
            self.cone.push(r.cone);
        }
    }

    #[inline]
    fn pen(a: &PartRec, b: &PartRec) -> f64 {
        if a.maxx < b.minx || b.maxx < a.minx || a.maxy < b.miny || b.maxy < a.miny {
            return 0.0;
        }
        let sep = part_sep(&a.poly, &a.cuts, &b.poly, &b.cuts);
        if sep < 0.0 {
            sep * sep
        } else {
            0.0
        }
    }

    /// Energy terms involving piece i if it had pose `pose` (others as cached).
    pub fn local_energy(&self, i: usize, pose: &SurfacePose) -> f64 {
        let same = match &self.built_pose[i] {
            Some(built) => {
                self.built_lam[i] == self.lam
                    && built.face == pose.face
                    && built.x.to_bits() == pose.x.to_bits()
                    && built.y.to_bits() == pose.y.to_bits()
                    && built.theta.to_bits() == pose.theta.to_bits()
            }
            None => false,
        };
        let fresh;
        let (recs, faces, cone): (&Vec<Rc<PartRec>>, &Vec<usize>, f64) = if same {
            (&self.parts[i], &self.part_faces[i], self.cone[i])
        } else {
            fresh = self.compute_piece(i, pose);
            (&fresh.recs, &fresh.faces, fresh.cone)
        };
        let mut e = cone;
        for t in 0..recs.len() {
            let a = &recs[t];
            let f = faces[t];
            for b in &self.by_face[f] {
                if b.piece != i {
                    e += Self::pen(a, b);
                }
            }
            for u in t + 1..recs.len() {
                if faces[u] == f {
                    e += Self::pen(a, &recs[u]);
                }
            }
        }
        e
    }

    pub fn total(&mut self) -> f64 {
        if let Some(t) = self.total_memo {
            return t;
        }
        let mut e = 0.0;
        for c in &self.cone {
            e += c;
        }
        for l in &self.by_face {
            for a in 0..l.len() {
                for b in a + 1..l.len() {
                    e += Self::pen(&l[a], &l[b]);
                }
            }
        }
        self.total_memo = Some(e);
        e
    }
}

/// `chains.ts: twinGroups`. The later twins of each node that has some, by the index of the first
/// of the group (an empty list where there is none).
fn twin_groups(nodes: &[ChainNode]) -> Vec<Vec<usize>> {
    let mut groups: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for (i, node) in nodes.iter().enumerate() {
        if let Some(t) = node.twin {
            groups[t].push(i);
        }
    }
    groups
}

/// `chains.ts: countsImage`. Does node `ni` count the developed image (x, y) of a centre
/// c = (cx, cy)? A twin node never does; the first of a group does when the image lies in any of
/// the group's wedges (the shared boundary ray included, tolerance 1e-12), so the group counts it
/// once; any other node tests its own wedge.
fn counts_image(nodes: &[ChainNode], groups: &[Vec<usize>], ni: usize, cx: f64, cy: f64, x: f64, y: f64) -> bool {
    let node = &nodes[ni];
    if node.twin.is_some() {
        return false;
    }
    let group = &groups[ni];
    if group.is_empty() {
        return in_wedge(node.wedge.as_ref(), cx, cy, x, y, 0.0);
    }
    in_wedge(node.wedge.as_ref(), cx, cy, x, y, 1e-12) || group.iter().any(|&m| in_wedge(nodes[m].wedge.as_ref(), cx, cy, x, y, 1e-12))
}

/// `energy.ts: diskEnergy`. Disks: E = sum over ordered pairs of developed centre images
/// 1/2 max(0, 2 lam - d)^2 + sum over vertices max(0, lam - d)^2, with analytic gradient in each
/// anchor frame. Geodesic loops at a centre count as images of the centre itself. `grad` (length
/// 2 P) is filled.
pub fn disk_energy(solid: &Solid, s: f64, lam: f64, poses: &[SurfacePose], grad: &mut [f64]) -> f64 {
    let mut by_face: Vec<Vec<usize>> = vec![Vec::new(); solid.f];
    for (i, p) in poses.iter().enumerate() {
        by_face[p.face_index()].push(i);
    }
    let mut e = 0.0;
    for g in grad.iter_mut() {
        *g = 0.0;
    }
    // frame vertices of every face (the Platonic solids share one frame, as before)
    let mut shared: Vec<(f64, f64)> = Vec::new();
    if solid.uniform {
        for k in 0..solid.m {
            shared.push(frame_vertex(solid.m, s, k));
        }
    }
    for i in 0..poses.len() {
        let p = poses[i];
        let nodes = chains(solid, s, p.face_index(), p.x, p.y, 2.0 * lam);
        let mut gx = 0.0;
        let mut gy = 0.0;
        // vertex id -> [d, dx, dy] of its closest appearance, in the order a Map keeps
        let mut vbest: Vec<(usize, f64, f64, f64)> = Vec::new();
        // chains with the same development (cone angle pi) count an image once, over the union of wedges
        let groups = twin_groups(&nodes);
        for (ni, node) in nodes.iter().enumerate() {
            let t = &node.to_anchor;
            for &j in &by_face[node.face] {
                if j == i && ni == 0 {
                    continue;
                }
                let q = poses[j];
                let (qx, qy) = apply(t, q.x, q.y);
                if !counts_image(&nodes, &groups, ni, p.x, p.y, qx, qy) {
                    continue;
                }
                let dx = qx - p.x;
                let dy = qy - p.y;
                let d = math::hypot(dx, dy);
                if d >= 2.0 * lam || d == 0.0 {
                    continue;
                }
                let pen = 2.0 * lam - d;
                e += 0.5 * pen * pen;
                if j != i {
                    // the pair's two ordered terms add up to pen^2, whose gradient in p is 2 pen (q' - p)/d
                    gx += (2.0 * pen * dx) / d;
                    gy += (2.0 * pen * dy) / d;
                } else {
                    // loop: q' = R p + t, d/dp |q' - p| = (R - I)^T (q' - p)/d
                    let ux = dx / d;
                    let uy = dy / d;
                    let rx = t.c * ux + t.s * uy - ux;
                    let ry = -t.s * ux + t.c * uy - uy;
                    gx += -pen * rx;
                    gy += -pen * ry;
                }
            }
            let own: Vec<(f64, f64)>;
            let verts: &[(f64, f64)] = if solid.uniform {
                &shared
            } else {
                own = (0..solid.sides[node.face]).map(|k| face_vertex(solid, s, node.face, k)).collect();
                &own
            };
            for k in 0..verts.len() {
                let (vx, vy) = apply(t, verts[k].0, verts[k].1);
                if !in_wedge(node.wedge.as_ref(), p.x, p.y, vx, vy, 1e-12) {
                    continue;
                }
                let dx = vx - p.x;
                let dy = vy - p.y;
                let d = math::hypot(dx, dy);
                if d >= lam {
                    continue;
                }
                // each vertex once, at its closest appearance (continuity, see cone_energy)
                let id = solid.faces[node.face][k];
                match vbest.iter_mut().find(|v| v.0 == id) {
                    None => vbest.push((id, d, dx, dy)),
                    Some(old) => {
                        if d < old.1 {
                            old.1 = d;
                            old.2 = dx;
                            old.3 = dy;
                        }
                    }
                }
            }
        }
        for &(_, d, dx, dy) in &vbest {
            let pen = lam - d;
            e += CONE_WEIGHT * pen * pen;
            if d > 0.0 {
                gx += (2.0 * CONE_WEIGHT * pen * dx) / d;
                gy += (2.0 * CONE_WEIGHT * pen * dy) / d;
            }
        }
        grad[2 * i] = gx;
        grad[2 * i + 1] = gy;
    }
    e
}

/// `energy.ts: diskEnergyNofold`. Disks without folding: E = sum over pairs on one face of
/// max(0, 2 lam - d)^2 + WALL_WEIGHT * sum over the edges of each disk's face of
/// max(0, lam - distance to the edge line)^2, with analytic gradient. Disks on different faces
/// never meet (the open faces are disjoint).
pub fn disk_energy_nofold(solid: &Solid, s: f64, lam: f64, poses: &[SurfacePose], grad: &mut [f64]) -> f64 {
    let mut e = 0.0;
    for g in grad.iter_mut() {
        *g = 0.0;
    }
    // face -> disks on it, in the order faces first appear (a Map's)
    let mut by_face: Vec<(usize, Vec<usize>)> = Vec::new();
    for (i, p) in poses.iter().enumerate() {
        let face = p.face_index();
        match by_face.iter_mut().find(|(f, _)| *f == face) {
            Some((_, l)) => l.push(i),
            None => by_face.push((face, vec![i])),
        }
        let m = solid.sides[face];
        for j in 0..m {
            let (ax, ay) = face_vertex(solid, s, face, j);
            let (bx, by) = face_vertex(solid, s, face, j + 1);
            let l = math::hypot(bx - ax, by - ay);
            // inward unit normal (the face is to the left of its edges)
            let nx = -(by - ay) / l;
            let ny = (bx - ax) / l;
            let d = nx * (p.x - ax) + ny * (p.y - ay);
            let pen = lam - d;
            if pen <= 0.0 {
                continue;
            }
            e += WALL_WEIGHT * pen * pen;
            grad[2 * i] -= 2.0 * WALL_WEIGHT * pen * nx;
            grad[2 * i + 1] -= 2.0 * WALL_WEIGHT * pen * ny;
        }
    }
    for (_, list) in &by_face {
        for a in 0..list.len() {
            for b in a + 1..list.len() {
                let i = list[a];
                let j = list[b];
                let dx = poses[j].x - poses[i].x;
                let dy = poses[j].y - poses[i].y;
                let d = math::hypot(dx, dy);
                let pen = 2.0 * lam - d;
                if pen <= 0.0 {
                    continue;
                }
                e += pen * pen;
                if d > 0.0 {
                    grad[2 * i] += (2.0 * pen * dx) / d;
                    grad[2 * i + 1] += (2.0 * pen * dy) / d;
                    grad[2 * j] -= (2.0 * pen * dx) / d;
                    grad[2 * j + 1] -= (2.0 * pen * dy) / d;
                }
            }
        }
    }
    e
}
