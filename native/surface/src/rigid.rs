//! Rigid motions of the plane and the gluing maps of a solid's faces.
//! Port of `packages/surface/src/rigid.ts`.

use crate::solids::{face_vertex, frame_vertex, Solid};
use polypack_js::math;
use polypack_js::math::PI;

/// `packages/surface/src/rigid.ts: Rigid`. Orientation-preserving rigid motion of the plane:
/// p -> R(ang) p + (tx, ty). `c` and `s` are cos(ang) and sin(ang); `ang` is kept so that piece
/// angles compose exactly.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rigid {
    pub ang: f64,
    pub c: f64,
    pub s: f64,
    pub tx: f64,
    pub ty: f64,
}

/// `packages/surface/src/rigid.ts: IDENTITY`.
pub const IDENTITY: Rigid = Rigid { ang: 0.0, c: 1.0, s: 0.0, tx: 0.0, ty: 0.0 };

/// `packages/surface/src/rigid.ts: apply`.
#[inline]
pub fn apply(t: &Rigid, x: f64, y: f64) -> (f64, f64) {
    (t.c * x - t.s * y + t.tx, t.s * x + t.c * y + t.ty)
}

/// `packages/surface/src/rigid.ts: compose`. A after B: p -> A(B(p)).
pub fn compose(a: &Rigid, b: &Rigid) -> Rigid {
    Rigid {
        ang: a.ang + b.ang,
        c: a.c * b.c - a.s * b.s,
        s: a.s * b.c + a.c * b.s,
        tx: a.c * b.tx - a.s * b.ty + a.tx,
        ty: a.s * b.tx + a.c * b.ty + a.ty,
    }
}

/// `packages/surface/src/rigid.ts: inverse`.
pub fn inverse(t: &Rigid) -> Rigid {
    // p = R^-1 (q - t)
    Rigid { ang: -t.ang, c: t.c, s: -t.s, tx: -(t.c * t.tx + t.s * t.ty), ty: -(-t.s * t.tx + t.c * t.ty) }
}

/// `packages/surface/src/rigid.ts: rigidThrough`. Rigid motion with rotation `ang` taking point
/// (px, py) to (qx, qy).
pub fn rigid_through(ang: f64, px: f64, py: f64, qx: f64, qy: f64) -> Rigid {
    let c = math::cos(ang);
    let s = math::sin(ang);
    Rigid { ang, c, s, tx: qx - (c * px - s * py), ty: qy - (s * px + c * py) }
}

/// What `glue` returns: the neighbouring face, its glued edge and the gluing map.
#[derive(Clone, Copy, Debug)]
pub struct Glue {
    pub face: usize,
    pub edge: usize,
    pub t: Rigid,
}

/// `packages/surface/src/rigid.ts: glue`. Gluing map across edge k of face f: it takes the frame of
/// the neighbour g (glued along its edge l) to the plane of f's frame, so that g lies on the far
/// side of edge k. g's frame vertex l+1 goes to f's frame vertex k and g's l goes to f's k+1; the
/// rotation is (direction of f's edge k) + pi - (direction of g's edge l). On the Platonic solids
/// (edge k of a frame has direction angle 2 pi (k + 1) / M) that is 2 pi (k - l) / M + pi, computed
/// as before the generalisation.
pub fn glue(solid: &Solid, s: f64, f: usize, k: usize) -> Glue {
    let g = solid.adj[f][k].face;
    let l = solid.adj[f][k].edge;
    if solid.uniform {
        let m = solid.m;
        let ang = (2.0 * PI * (k as f64 - l as f64)) / m as f64 + PI;
        let (px, py) = frame_vertex(m, s, l + 1);
        let (qx, qy) = frame_vertex(m, s, k);
        return Glue { face: g, edge: l, t: rigid_through(ang, px, py, qx, qy) };
    }
    let ang = solid.edge_angle[f][k] + PI - solid.edge_angle[g][l];
    let (px, py) = face_vertex(solid, s, g, l + 1);
    let (qx, qy) = face_vertex(solid, s, f, k);
    Glue { face: g, edge: l, t: rigid_through(ang, px, py, qx, qy) }
}
