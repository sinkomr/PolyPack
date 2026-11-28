//! The surface as the search sees it: the solid's faces at a working scale S (each face in its own
//! frame, the validator's convention), the rigid maps that glue neighbouring faces, a walk that moves a
//! point along a straight path across edges (the exponential map), and the development of a
//! neighbourhood of a point into the plane of its face (chains of faces with their wedges of
//! directions). Everything here is this crate's own code; from `polypack-surface` it reads only the
//! solid's definition (frame vertices, adjacency, 3D frames).

use polypack_surface::solids::face_vertex;
use polypack_surface::{get_solid, Solid};
use std::f64::consts::PI;

/// An orientation-preserving rigid motion p -> R(ang) p + t.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rig {
    pub c: f64,
    pub s: f64,
    pub tx: f64,
    pub ty: f64,
    pub ang: f64,
}

impl Rig {
    pub const ID: Rig = Rig { c: 1.0, s: 0.0, tx: 0.0, ty: 0.0, ang: 0.0 };

    #[inline]
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (self.c * x - self.s * y + self.tx, self.s * x + self.c * y + self.ty)
    }
    /// The rotation part only (a direction or a gradient).
    #[inline]
    pub fn rot(&self, x: f64, y: f64) -> (f64, f64) {
        (self.c * x - self.s * y, self.s * x + self.c * y)
    }
    /// The inverse rotation (pulls a gradient back).
    #[inline]
    pub fn rot_t(&self, x: f64, y: f64) -> (f64, f64) {
        (self.c * x + self.s * y, -self.s * x + self.c * y)
    }
    /// self after o: p -> self(o(p)).
    pub fn after(&self, o: &Rig) -> Rig {
        let c = self.c * o.c - self.s * o.s;
        let s = self.s * o.c + self.c * o.s;
        let (tx, ty) = self.apply(o.tx, o.ty);
        Rig { c, s, tx, ty, ang: self.ang + o.ang }
    }
    pub fn inverse(&self) -> Rig {
        let (tx, ty) = self.rot_t(-self.tx, -self.ty);
        Rig { c: self.c, s: -self.s, tx, ty, ang: -self.ang }
    }
}

/// One face at the working scale.
#[derive(Clone, Debug)]
pub struct Face {
    pub m: usize,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    /// edge k (vertex k to k + 1): unit outward normal and offset; inside is n . p <= off
    pub nx: Vec<f64>,
    pub ny: Vec<f64>,
    pub off: Vec<f64>,
    pub adj_face: Vec<usize>,
    pub adj_edge: Vec<usize>,
    /// the neighbour across edge k: its frame -> this frame (it lies beyond edge k)
    pub glue: Vec<Rig>,
    /// the solid's vertex id of frame vertex k
    pub vid: Vec<usize>,
    pub area: f64,
    /// cumulative areas of the fan triangles (0, k, k + 1), for uniform sampling
    pub fan: Vec<f64>,
    /// 3D frame at the working scale: origin, x and y axes
    pub o3: [f64; 3],
    pub ex3: [f64; 3],
    pub ey3: [f64; 3],
    /// largest distance from the frame origin to a vertex
    pub rad: f64,
}

/// The solid at working scale `scale` (the canonical solid times `scale`).
#[derive(Clone, Debug)]
pub struct Geo {
    pub name: String,
    pub scale: f64,
    pub faces: Vec<Face>,
    pub nv: usize,
    pub area: f64,
    /// cumulative face areas, for sampling
    pub cum: Vec<f64>,
    /// shortest edge
    pub min_edge: f64,
    /// per vertex: cone angle
    pub cone: Vec<f64>,
}

/// One chain of faces developed into the anchor frame: the face, its map into the anchor frame, and
/// the closed wedge of directions from the anchor point whose rays cross the chain's edges in order
/// (none for the root).
#[derive(Clone, Copy, Debug)]
pub struct Node {
    pub face: u32,
    pub entry: i32,
    pub depth: u32,
    pub root: bool,
    pub t: Rig,
    /// wedge [a0, a0 + w] with unit boundary vectors lo (at a0) and hi (at a0 + w)
    pub a0: f64,
    pub w: f64,
    pub lx: f64,
    pub ly: f64,
    pub hx: f64,
    pub hy: f64,
}

impl Node {
    /// Is (x, y) in the closed wedge from (cx, cy), within `tol` (a distance)?
    #[inline]
    pub fn sees(&self, cx: f64, cy: f64, x: f64, y: f64, tol: f64) -> bool {
        if self.root {
            return true;
        }
        let vx = x - cx;
        let vy = y - cy;
        self.lx * vy - self.ly * vx >= -tol && vx * self.hy - vy * self.hx >= -tol
    }
}

fn norm_angle(a: f64) -> f64 {
    let mut t = a % (2.0 * PI);
    if t <= -PI {
        t += 2.0 * PI;
    } else if t > PI {
        t -= 2.0 * PI;
    }
    t
}

impl Geo {
    /// The solid `name` at working scale `scale`.
    pub fn new(name: &str, scale: f64) -> Result<Geo, String> {
        let solid: &Solid = get_solid(name)?;
        let nf = solid.f;
        let mut faces: Vec<Face> = Vec::with_capacity(nf);
        let mut min_edge = f64::INFINITY;
        for f in 0..nf {
            let m = solid.sides[f];
            let mut vx = vec![0.0f64; m];
            let mut vy = vec![0.0f64; m];
            for k in 0..m {
                let (x, y) = face_vertex(solid, scale, f, k);
                vx[k] = x;
                vy[k] = y;
            }
            let mut nx = vec![0.0; m];
            let mut ny = vec![0.0; m];
            let mut off = vec![0.0; m];
            for k in 0..m {
                let j = (k + 1) % m;
                let (ex, ey) = (vx[j] - vx[k], vy[j] - vy[k]);
                let l = ex.hypot(ey);
                min_edge = min_edge.min(l);
                nx[k] = ey / l;
                ny[k] = -ex / l;
                off[k] = nx[k] * vx[k] + ny[k] * vy[k];
            }
            let mut area = 0.0;
            let mut fan = vec![0.0; m.saturating_sub(2)];
            for k in 1..m - 1 {
                let a = 0.5 * ((vx[k] - vx[0]) * (vy[k + 1] - vy[0]) - (vx[k + 1] - vx[0]) * (vy[k] - vy[0]));
                area += a;
                fan[k - 1] = area;
            }
            let fr = &solid.frame_3d[f];
            let rad = (0..m).fold(0.0f64, |a, k| a.max(vx[k].hypot(vy[k])));
            faces.push(Face {
                m,
                vx,
                vy,
                nx,
                ny,
                off,
                adj_face: solid.adj[f].iter().map(|e| e.face).collect(),
                adj_edge: solid.adj[f].iter().map(|e| e.edge).collect(),
                glue: Vec::new(),
                vid: solid.faces[f].clone(),
                area,
                fan,
                o3: [fr.o[0] * scale, fr.o[1] * scale, fr.o[2] * scale],
                ex3: fr.ex,
                ey3: fr.ey,
                rad,
            });
        }
        // gluing maps: edge k of f (A = v_k, B = v_k+1) meets edge l of g (A' = v'_l, B' = v'_l+1) with
        // A' at B and B' at A
        for f in 0..nf {
            let m = faces[f].m;
            let mut glue = Vec::with_capacity(m);
            for k in 0..m {
                let g = faces[f].adj_face[k];
                let l = faces[f].adj_edge[k];
                let mg = faces[g].m;
                let (ax, ay) = (faces[f].vx[k], faces[f].vy[k]);
                let (bx, by) = (faces[f].vx[(k + 1) % m], faces[f].vy[(k + 1) % m]);
                let (apx, apy) = (faces[g].vx[l], faces[g].vy[l]);
                let (bpx, bpy) = (faces[g].vx[(l + 1) % mg], faces[g].vy[(l + 1) % mg]);
                // direction B' - A' (in g) must turn into A - B (in f)
                let (ux, uy) = (bpx - apx, bpy - apy);
                let (wx, wy) = (ax - bx, ay - by);
                let lu = ux.hypot(uy);
                let lw = wx.hypot(wy);
                let (ux, uy, wx, wy) = (ux / lu, uy / lu, wx / lw, wy / lw);
                let c = ux * wx + uy * wy;
                let s = ux * wy - uy * wx;
                let ang = s.atan2(c);
                let (c, s) = (ang.cos(), ang.sin());
                // t = B - R A' and also A - R B'; average the two
                let t1 = (bx - (c * apx - s * apy), by - (s * apx + c * apy));
                let t2 = (ax - (c * bpx - s * bpy), ay - (s * bpx + c * bpy));
                glue.push(Rig { c, s, tx: 0.5 * (t1.0 + t2.0), ty: 0.5 * (t1.1 + t2.1), ang });
            }
            faces[f].glue = glue;
        }
        let mut cum = Vec::with_capacity(nf);
        let mut total = 0.0;
        for fc in &faces {
            total += fc.area;
            cum.push(total);
        }
        Ok(Geo { name: name.to_string(), scale, faces, nv: solid.v, area: total, cum, min_edge, cone: solid.vertex_cone.clone() })
    }

    /// Signed depth of (x, y) inside face f (positive inside).
    #[inline]
    pub fn depth(&self, f: usize, x: f64, y: f64) -> f64 {
        let fc = &self.faces[f];
        let mut d = f64::INFINITY;
        for k in 0..fc.m {
            d = d.min(fc.off[k] - (fc.nx[k] * x + fc.ny[k] * y));
        }
        d
    }

    /// The 3D point of (x, y) in face f (working scale).
    #[inline]
    pub fn to3(&self, f: usize, x: f64, y: f64) -> [f64; 3] {
        let fc = &self.faces[f];
        [fc.o3[0] + x * fc.ex3[0] + y * fc.ey3[0], fc.o3[1] + x * fc.ex3[1] + y * fc.ey3[1], fc.o3[2] + x * fc.ex3[2] + y * fc.ey3[2]]
    }

    /// Moves along the straight path from (qx, qy) (in face f, inside it) to (px, py) (in f's plane),
    /// crossing edges by unfolding, and returns the face where the path ends, the end point in that
    /// face's frame and the map from f's frame to it. A path that passes within rounding of a vertex
    /// continues into one of the faces there; after 200 crossings the walk stops where it is.
    pub fn walk(&self, f: usize, qx: f64, qy: f64, px: f64, py: f64) -> (usize, f64, f64, Rig) {
        let mut face = f;
        let (mut qx, mut qy, mut px, mut py) = (qx, qy, px, py);
        let mut entry: i32 = -1;
        let mut acc = Rig::ID; // f's frame -> current face's frame
        for _ in 0..200 {
            let fc = &self.faces[face];
            let (dx, dy) = (px - qx, py - qy);
            // first edge the segment leaves through
            let mut best_t = f64::INFINITY;
            let mut best_k = usize::MAX;
            for k in 0..fc.m {
                if k as i32 == entry {
                    continue;
                }
                let den = fc.nx[k] * dx + fc.ny[k] * dy;
                if den <= 0.0 {
                    continue;
                }
                let t = (fc.off[k] - (fc.nx[k] * qx + fc.ny[k] * qy)) / den;
                if t < best_t {
                    best_t = t;
                    best_k = k;
                }
            }
            if best_k == usize::MAX || best_t >= 1.0 {
                break;
            }
            let t = best_t.max(0.0);
            let (ex, ey) = (qx + t * dx, qy + t * dy);
            // into the neighbour's frame
            let inv = fc.glue[best_k].inverse();
            let g = fc.adj_face[best_k];
            let (nqx, nqy) = inv.apply(ex, ey);
            let (npx, npy) = inv.apply(px, py);
            entry = fc.adj_edge[best_k] as i32;
            acc = inv.after(&acc);
            face = g;
            qx = nqx;
            qy = nqy;
            px = npx;
            py = npy;
        }
        (face, px, py, acc)
    }

    /// A point (x, y) of f's plane, reached from f's centre (frame origin), as (face, x, y, map).
    /// Points slightly outside f by rounding are kept in f.
    pub fn locate(&self, f: usize, x: f64, y: f64) -> (usize, f64, f64, Rig) {
        if self.depth(f, x, y) >= -1e-13 * self.scale {
            return (f, x, y, Rig::ID);
        }
        self.walk(f, 0.0, 0.0, x, y)
    }

    /// The chains of faces that a ray of length <= `reach` from (cx, cy) in face `anchor` can follow,
    /// developed into the anchor's frame; the root (the anchor face) first. At most `max_nodes`.
    pub fn chains(&self, anchor: usize, cx: f64, cy: f64, reach: f64, max_nodes: usize, out: &mut Vec<Node>) {
        out.clear();
        out.push(Node { face: anchor as u32, entry: -1, depth: 0, root: true, t: Rig::ID, a0: 0.0, w: 2.0 * PI, lx: 1.0, ly: 0.0, hx: 1.0, hy: 0.0 });
        let slack = 1e-12 * self.scale;
        let mut idx = 0;
        while idx < out.len() {
            let node = out[idx];
            idx += 1;
            if node.depth >= 60 {
                continue;
            }
            let f = node.face as usize;
            let fc = &self.faces[f];
            let m = fc.m;
            for k in 0..m {
                if k as i32 == node.entry {
                    continue;
                }
                let (ax, ay) = node.t.apply(fc.vx[k], fc.vy[k]);
                let (bx, by) = node.t.apply(fc.vx[(k + 1) % m], fc.vy[(k + 1) % m]);
                let (ex, ey) = (bx - ax, by - ay);
                // the point must be on the inner side of the edge to cross it outwards
                if ex * (cy - ay) - ey * (cx - ax) < -slack {
                    continue;
                }
                // distance from the point to the edge
                let l2 = ex * ex + ey * ey;
                let mut t = ((cx - ax) * ex + (cy - ay) * ey) / l2;
                t = t.clamp(0.0, 1.0);
                let dist = (cx - ax - t * ex).hypot(cy - ay - t * ey);
                if dist > reach + slack {
                    continue;
                }
                // cone of directions from c over the edge A -> B
                let (ux, uy) = (ax - cx, ay - cy);
                let (vx, vy) = (bx - cx, by - cy);
                let b0 = uy.atan2(ux);
                let mut bw = (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
                if bw < 0.0 {
                    bw = PI;
                }
                let bw = bw.min(PI);
                let (a0, w) = if node.root {
                    (b0, bw)
                } else {
                    let d = norm_angle(b0 - node.a0);
                    let lo = d.max(0.0);
                    let hi = node.w.min(d + bw);
                    (node.a0 + lo, hi - lo)
                };
                if !(w > 1e-11) {
                    continue;
                }
                if out.len() >= max_nodes {
                    return;
                }
                let g = fc.adj_face[k];
                let t2 = node.t.after(&fc.glue[k]);
                let a1 = a0 + w;
                out.push(Node {
                    face: g as u32,
                    entry: fc.adj_edge[k] as i32,
                    depth: node.depth + 1,
                    root: false,
                    t: t2,
                    a0,
                    w,
                    lx: a0.cos(),
                    ly: a0.sin(),
                    hx: a1.cos(),
                    hy: a1.sin(),
                });
            }
        }
    }

    /// A uniform random point of the surface: (face, x, y).
    pub fn sample(&self, u1: f64, u2: f64, u3: f64, u4: f64) -> (usize, f64, f64) {
        let target = u1 * self.area;
        let f = self.cum.iter().position(|&c| c >= target).unwrap_or(self.faces.len() - 1);
        let fc = &self.faces[f];
        let t2 = u2 * fc.area;
        let k = fc.fan.iter().position(|&c| c >= t2).unwrap_or(fc.fan.len() - 1) + 1;
        let (mut a, mut b) = (u3, u4);
        if a + b > 1.0 {
            a = 1.0 - a;
            b = 1.0 - b;
        }
        let x = fc.vx[0] + a * (fc.vx[k] - fc.vx[0]) + b * (fc.vx[k + 1] - fc.vx[0]);
        let y = fc.vy[0] + a * (fc.vy[k] - fc.vy[0]) + b * (fc.vy[k + 1] - fc.vy[0]);
        (f, x, y)
    }
}
