//! Convex polyhedra in R^3 as lists of faces (convex polygons, counter-clockwise around their
//! outward unit normals): clipping by half-spaces, thickness and the separating-axis penetration
//! depth. Used for the parts of polytope pieces. Port of packages/boundary/src/polyhedron.ts.

use crate::linalg::{cross3, dot3, norm3, sub3, unit3, V3};
use polypack_js::math;
use std::cmp::Ordering;

#[derive(Clone, Debug, PartialEq)]
pub struct Face {
    pub verts: Vec<V3>,
    /// Outward unit normal.
    pub n: V3,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Polyhedron {
    pub faces: Vec<Face>,
}

/// The polyhedron given by its vertices and faces (index lists, counter-clockwise seen from outside).
/// packages/boundary/src/polyhedron.ts: polyhedronFrom
pub fn polyhedron_from(vertices: &[V3], faces: &[Vec<usize>]) -> Polyhedron {
    Polyhedron {
        faces: faces
            .iter()
            .map(|f| {
                let verts: Vec<V3> = f.iter().map(|&i| vertices[i]).collect();
                let n = unit3(newell(&verts));
                Face { verts, n }
            })
            .collect(),
    }
}

fn newell(p: &[V3]) -> V3 {
    let mut n: V3 = [0.0; 3];
    for i in 0..p.len() {
        let a = p[i];
        let b = p[(i + 1) % p.len()];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    n
}

#[inline]
fn same_point(a: V3, b: V3, eps: f64) -> bool {
    (a[0] - b[0]).abs() <= eps && (a[1] - b[1]).abs() <= eps && (a[2] - b[2]).abs() <= eps
}

fn dedupe(p: Vec<V3>, eps: f64) -> Vec<V3> {
    let mut out: Vec<V3> = Vec::with_capacity(p.len());
    for v in p {
        if out.is_empty() || !same_point(out[out.len() - 1], v, eps) {
            out.push(v);
        }
    }
    while out.len() > 1 && same_point(out[0], out[out.len() - 1], eps) {
        out.pop();
    }
    out
}

/// Clips a convex polyhedron to the half-space { x : n . x <= h } (n unit). Each face is clipped
/// (Sutherland-Hodgman, intersection points computed from the inside vertex to the outside one, so
/// that the two faces sharing an edge produce the same point), and the cut is closed by a cap face
/// with normal n. Vertices within eps of the plane count as on it. Returns an empty polyhedron when
/// nothing with interior remains.
/// packages/boundary/src/polyhedron.ts: clipPolyhedron (eps defaults to 1e-12 there)
pub fn clip_polyhedron(p: Polyhedron, n: V3, h: f64, eps: f64) -> Polyhedron {
    let mut any_out = false;
    let mut any_in = false;
    for f in &p.faces {
        for &v in &f.verts {
            let d = dot3(n, v) - h;
            if d > eps {
                any_out = true;
            } else if d < -eps {
                any_in = true;
            }
        }
    }
    if !any_out {
        return p;
    }
    if !any_in {
        return Polyhedron { faces: vec![] };
    }
    let mut faces: Vec<Face> = Vec::new();
    let mut cap: Vec<V3> = Vec::new();
    for f in &p.faces {
        let vs = &f.verts;
        let d: Vec<f64> = vs.iter().map(|&v| dot3(n, v) - h).collect();
        let mut out: Vec<V3> = Vec::new();
        for i in 0..vs.len() {
            let j = (i + 1) % vs.len();
            let ci = if d[i] > eps {
                1
            } else if d[i] < -eps {
                -1
            } else {
                0
            };
            let cj = if d[j] > eps {
                1
            } else if d[j] < -eps {
                -1
            } else {
                0
            };
            if ci <= 0 {
                out.push(vs[i]);
                if ci == 0 {
                    cap.push(vs[i]);
                }
            }
            if ci * cj < 0 {
                let (a, da, b, db) = if ci < 0 { (vs[i], d[i], vs[j], d[j]) } else { (vs[j], d[j], vs[i], d[i]) };
                let t = da / (da - db);
                let q: V3 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
                out.push(q);
                cap.push(q);
            }
        }
        let poly = dedupe(out, eps);
        if poly.len() >= 3 {
            faces.push(Face { verts: poly, n: f.n });
        }
    }
    // the cap: distinct cut points, sorted counter-clockwise around n
    let mut pts: Vec<V3> = Vec::new();
    for &q in &cap {
        if !pts.iter().any(|&r| same_point(q, r, 10.0 * eps)) {
            pts.push(q);
        }
    }
    if pts.len() >= 3 {
        let mut c: V3 = [0.0; 3];
        for q in &pts {
            for k in 0..3 {
                c[k] += q[k] / pts.len() as f64;
            }
        }
        let mut e1 = sub3(pts[0], c);
        if norm3(e1) < 1e-300 {
            e1 = sub3(pts[1], c);
        }
        e1 = unit3(sub3(e1, [n[0] * dot3(e1, n), n[1] * dot3(e1, n), n[2] * dot3(e1, n)]));
        let e2 = cross3(n, e1);
        let ang = |q: V3| -> f64 {
            let d = sub3(q, c);
            math::atan2(dot3(d, e2), dot3(d, e1))
        };
        // the comparator of the source, (a, b) => ang(a) - ang(b), with the angles computed once
        let mut keyed: Vec<(f64, V3)> = pts.iter().map(|&q| (ang(q), q)).collect();
        keyed.sort_by(|a, b| {
            let x = a.0 - b.0;
            if x < 0.0 {
                Ordering::Less
            } else if x > 0.0 {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        });
        faces.push(Face { verts: keyed.into_iter().map(|k| k.1).collect(), n: [n[0], n[1], n[2]] });
    }
    if faces.len() < 4 {
        return Polyhedron { faces: vec![] };
    }
    Polyhedron { faces }
}

/// Distinct vertices of a polyhedron.
/// packages/boundary/src/polyhedron.ts: polyhedronVertices (eps defaults to 1e-12 there)
pub fn polyhedron_vertices(p: &Polyhedron, eps: f64) -> Vec<V3> {
    let mut out: Vec<V3> = Vec::new();
    for f in &p.faces {
        for &v in &f.verts {
            if !out.iter().any(|&q| same_point(v, q, eps)) {
                out.push(v);
            }
        }
    }
    out
}

/// Smallest width of the polyhedron along its face normals. The minimal width of a convex body is
/// at most this, and any convex body overlaps it by at most its minimal width.
/// packages/boundary/src/polyhedron.ts: polyhedronThickness (verts defaults to polyhedronVertices(P))
pub fn polyhedron_thickness(p: &Polyhedron) -> f64 {
    let verts = polyhedron_vertices(p, 1e-12);
    if p.faces.is_empty() {
        return 0.0;
    }
    let mut best = f64::INFINITY;
    for f in &p.faces {
        let top = dot3(f.n, f.verts[0]);
        let mut lo = f64::INFINITY;
        for &v in &verts {
            lo = math::min(lo, dot3(f.n, v));
        }
        best = math::min(best, top - lo);
    }
    best
}

/// The data the separating-axis test needs: vertices, face normals and edge directions (unit, up to sign).
/// packages/boundary/src/polyhedron.ts: SatShape
#[derive(Clone, Debug)]
pub struct SatShape {
    pub verts: Vec<V3>,
    pub normals: Vec<V3>,
    pub edges: Vec<V3>,
    pub lo: V3,
    pub hi: V3,
}

fn add_direction(list: &mut Vec<V3>, d: V3) {
    for &e in list.iter() {
        if norm3(cross3(e, d)) < 1e-9 {
            return;
        }
    }
    list.push(d);
}

/// packages/boundary/src/polyhedron.ts: satShape
pub fn sat_shape(p: &Polyhedron) -> SatShape {
    let verts = polyhedron_vertices(p, 1e-12);
    let mut normals: Vec<V3> = Vec::new();
    let mut edges: Vec<V3> = Vec::new();
    for f in &p.faces {
        add_direction(&mut normals, f.n);
        for i in 0..f.verts.len() {
            let e = sub3(f.verts[(i + 1) % f.verts.len()], f.verts[i]);
            let l = norm3(e);
            if l > 1e-12 {
                add_direction(&mut edges, [e[0] / l, e[1] / l, e[2] / l]);
            }
        }
    }
    let mut lo: V3 = [f64::INFINITY; 3];
    let mut hi: V3 = [f64::NEG_INFINITY; 3];
    for v in &verts {
        for k in 0..3 {
            lo[k] = math::min(lo[k], v[k]);
            hi[k] = math::max(hi[k], v[k]);
        }
    }
    SatShape { verts, normals, edges, lo, hi }
}

#[inline]
fn project(vs: &[V3], a: V3) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for v in vs {
        let x = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
        if x < lo {
            lo = x;
        }
        if x > hi {
            hi = x;
        }
    }
    (lo, hi)
}

/// Penetration depth of two convex polyhedra: the smallest overlap of their projections over the
/// candidate axes (face normals of both, cross products of their edge directions). For convex
/// polyhedra this is the depth of the minimum translation that separates them; a value <= 0 means
/// they do not overlap (the axis separates them). Stops early, returning the current overlap, as
/// soon as it is <= `stop_at`.
/// packages/boundary/src/polyhedron.ts: satDepth (stopAt defaults to -Infinity there)
pub fn sat_depth(a: &SatShape, b: &SatShape, stop_at: f64) -> f64 {
    let mut depth = f64::INFINITY;
    // bounding boxes first: the coordinate axes are valid separating directions
    for k in 0..3 {
        let ov = math::min(a.hi[k], b.hi[k]) - math::max(a.lo[k], b.lo[k]);
        if ov < depth {
            depth = ov;
        }
        if depth <= stop_at {
            return depth;
        }
    }
    let test = |axis: V3, depth: &mut f64| -> bool {
        let (la, ha) = project(&a.verts, axis);
        let (lb, hb) = project(&b.verts, axis);
        let ov = math::min(ha, hb) - math::max(la, lb);
        if ov < *depth {
            *depth = ov;
        }
        *depth <= stop_at
    };
    for &n in &a.normals {
        if test(n, &mut depth) {
            return depth;
        }
    }
    for &n in &b.normals {
        if test(n, &mut depth) {
            return depth;
        }
    }
    for &ea in &a.edges {
        for &eb in &b.edges {
            let c = cross3(ea, eb);
            let l = norm3(c);
            if l < 1e-9 {
                continue;
            }
            if test([c[0] / l, c[1] / l, c[2] / l], &mut depth) {
                return depth;
            }
        }
    }
    depth
}
