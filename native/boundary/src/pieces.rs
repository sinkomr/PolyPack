//! The Platonic solids as pieces of the boundary space (3D on 4D), unit edge, centred at the origin.
//! Port of packages/boundary/src/pieces.ts.
//!
//! A piece's standard pose is the solid below; a configuration's `q` rotates it about its centre in
//! the anchor cell's frame.
//!
//!  - tetrahedron: (1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1) / (2 sqrt 2);
//!  - cube: (+-1/2)^3;
//!  - octahedron: +-e_k / sqrt 2;
//!  - dodecahedron: (+-phi/2)^3 and the cyclic shifts of (0, +-1/2, +-phi^2/2);
//!  - icosahedron: the cyclic shifts of (0, +-1/2, +-phi/2);
//! phi = (1 + sqrt 5) / 2.
//!
//! `piece_shape` builds a shape on first use with `build_piece_shape`, the port of the source's
//! builder (square roots and V8's hypot only), and keeps it, as the source's `pieceShape` does. The
//! five shapes equal Node's in every number and in the signs of zero (some face normals of the
//! dodecahedron and the icosahedron hold a -0); a test holds that against a fixture written under
//! Node 24 on Linux x86-64 (native/tools/boundary-tables.mts). The crate used to read them from a
//! table written by the TypeScript; see polytope.rs for why it builds them instead.

use crate::linalg::{cross3, dot3, sub3, unit3, V3};
use polypack_js::math;
use serde::Deserialize;
use std::cmp::Ordering;
use std::sync::OnceLock;

/// packages/boundary/src/pieces.ts: PieceShape
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceShape {
    pub name: String,
    pub vertices: Vec<V3>,
    /// Faces as vertex indices, counter-clockwise seen from outside.
    pub faces: Vec<Vec<usize>>,
    /// Outward unit normals of the faces.
    pub normals: Vec<V3>,
    /// Distance from the centre to every face.
    pub inradius: f64,
    /// Distance from the centre to every vertex.
    pub circumradius: f64,
    /// Distance from the centre to every edge.
    pub midradius: f64,
    pub volume: f64,
    /// An orientation-reversing symmetry of the solid (a matrix, row-major): R S = a rotation image of R.
    pub mirror: Vec<f64>,
    /// Edges as vertex index pairs.
    pub edges: Vec<[usize; 2]>,
    /// One unit direction per class of parallel edges (the separating-axis test's edge axes).
    pub edge_dirs: Vec<V3>,
}

/// packages/boundary/src/pieces.ts: POLYTOPE_PIECES
pub const POLYTOPE_PIECES: [&str; 5] = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];

/// packages/boundary/src/pieces.ts: isPolytopePiece
pub fn is_polytope_piece(x: &str) -> bool {
    POLYTOPE_PIECES.contains(&x)
}

/// The shape of a Platonic piece (built once). packages/boundary/src/pieces.ts: pieceShape
pub fn piece_shape(name: &str) -> Option<&'static PieceShape> {
    static SHAPES: [OnceLock<Option<PieceShape>>; 5] = [OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new()];
    let i = POLYTOPE_PIECES.iter().position(|&n| n == name)?;
    SHAPES[i].get_or_init(|| build_piece_shape(name)).as_ref()
}

fn ordering(x: f64) -> Ordering {
    if x < 0.0 {
        Ordering::Less
    } else if x > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// Faces of the convex hull of `verts` (counter-clockwise from outside), found by planes through triples.
/// packages/boundary/src/pieces.ts: hullFaces
fn hull_faces(verts: &[V3]) -> (Vec<Vec<usize>>, Vec<V3>) {
    let n = verts.len();
    let mut found: Vec<(V3, Vec<usize>)> = Vec::new();
    for a in 0..n {
        for b in a + 1..n {
            for c in b + 1..n {
                let nr = cross3(sub3(verts[b], verts[a]), sub3(verts[c], verts[a]));
                let len = math::hypot3(nr[0], nr[1], nr[2]);
                if len < 1e-9 {
                    continue;
                }
                let nu = unit3(nr);
                let h = dot3(nu, verts[a]);
                let mut pos = 0;
                let mut neg = 0;
                for v in verts {
                    let d = dot3(nu, *v) - h;
                    if d > 1e-9 {
                        pos += 1;
                    } else if d < -1e-9 {
                        neg += 1;
                    }
                }
                if pos != 0 && neg != 0 {
                    continue;
                }
                let out: V3 = if pos != 0 { [-nu[0], -nu[1], -nu[2]] } else { nu };
                if found.iter().any(|f| dot3(f.0, out) > 1.0 - 1e-9) {
                    continue;
                }
                let hh = dot3(out, verts[a]);
                let ids: Vec<usize> = (0..n).filter(|&i| (dot3(out, verts[i]) - hh).abs() < 1e-9).collect();
                found.push((out, ids));
            }
        }
    }
    let faces = found
        .iter()
        .map(|(normal, ids)| {
            // order counter-clockwise around the normal
            let mut c: V3 = [0.0; 3];
            for &i in ids {
                for k in 0..3 {
                    c[k] += verts[i][k] / ids.len() as f64;
                }
            }
            let e1 = unit3(sub3(verts[ids[0]], c));
            let e2 = cross3(*normal, e1);
            let ang = |i: usize| -> f64 {
                let d = sub3(verts[i], c);
                math::atan2(dot3(d, e2), dot3(d, e1))
            };
            let mut f = ids.clone();
            f.sort_by(|&x, &y| ordering(ang(x) - ang(y)));
            f
        })
        .collect();
    (faces, found.into_iter().map(|f| f.0).collect())
}

/// packages/boundary/src/pieces.ts: edgesOf
fn edges_of(faces: &[Vec<usize>]) -> Vec<[usize; 2]> {
    let mut out: Vec<[usize; 2]> = Vec::new();
    for f in faces {
        for i in 0..f.len() {
            let a = f[i].min(f[(i + 1) % f.len()]);
            let b = f[i].max(f[(i + 1) % f.len()]);
            if !out.contains(&[a, b]) {
                out.push([a, b]);
            }
        }
    }
    out.sort();
    out
}

/// packages/boundary/src/pieces.ts: signs
fn signs(base: V3) -> Vec<V3> {
    let mut out: Vec<V3> = Vec::new();
    for m in 0..8 {
        let v: V3 = [if m & 1 != 0 { -base[0] } else { base[0] }, if m & 2 != 0 { -base[1] } else { base[1] }, if m & 4 != 0 { -base[2] } else { base[2] }];
        if !out.iter().any(|w| w[0] == v[0] && w[1] == v[1] && w[2] == v[2]) {
            out.push(v);
        }
    }
    out
}

/// packages/boundary/src/pieces.ts: cyclic
fn cyclic(v: V3) -> [V3; 3] {
    [v, [v[1], v[2], v[0]], [v[2], v[0], v[1]]]
}

/// packages/boundary/src/pieces.ts: buildVertices
fn build_vertices(name: &str) -> Option<Vec<V3>> {
    let phi = (1.0 + 5f64.sqrt()) / 2.0;
    Some(match name {
        "tetrahedron" => {
            let k = 1.0 / (2.0 * math::SQRT2);
            [[1.0, 1.0, 1.0], [1.0, -1.0, -1.0], [-1.0, 1.0, -1.0], [-1.0, -1.0, 1.0]].iter().map(|v: &V3| [v[0] * k, v[1] * k, v[2] * k]).collect()
        }
        "cube" => (0..8).map(|v| [if v & 1 != 0 { 0.5 } else { -0.5 }, if v & 2 != 0 { 0.5 } else { -0.5 }, if v & 4 != 0 { 0.5 } else { -0.5 }]).collect(),
        "octahedron" => {
            let r = math::SQRT1_2;
            vec![[r, 0.0, 0.0], [-r, 0.0, 0.0], [0.0, r, 0.0], [0.0, -r, 0.0], [0.0, 0.0, r], [0.0, 0.0, -r]]
        }
        "dodecahedron" => {
            let mut out = signs([phi / 2.0, phi / 2.0, phi / 2.0]);
            for c in cyclic([0.0, 0.5, (phi * phi) / 2.0]) {
                out.extend(signs(c));
            }
            out
        }
        "icosahedron" => {
            let mut out = Vec::new();
            for c in cyclic([0.0, 0.5, phi / 2.0]) {
                out.extend(signs(c));
            }
            out
        }
        _ => return None,
    })
}

/// The shape of a Platonic piece as the TypeScript builds it. packages/boundary/src/pieces.ts: build
pub fn build_piece_shape(name: &str) -> Option<PieceShape> {
    let vertices = build_vertices(name)?;
    // the cube keeps its published face order (parts.ts CUBE_FACES: -x, +x, -y, +y, -z, +z)
    let (faces, normals) = if name == "cube" {
        (
            vec![vec![0, 4, 6, 2], vec![1, 3, 7, 5], vec![0, 1, 5, 4], vec![2, 6, 7, 3], vec![0, 2, 3, 1], vec![4, 5, 7, 6]],
            vec![[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, -1.0], [0.0, 0.0, 1.0]],
        )
    } else {
        hull_faces(&vertices)
    };
    let edges = edges_of(&faces);
    let mut edge_dirs: Vec<V3> = Vec::new();
    for &[a, b] in &edges {
        let d = unit3(sub3(vertices[b], vertices[a]));
        if !edge_dirs.iter().any(|&e| {
            let c = cross3(e, d);
            math::hypot3(c[0], c[1], c[2]) < 1e-9
        }) {
            edge_dirs.push(d);
        }
    }
    let inradius = dot3(normals[0], vertices[faces[0][0]]);
    let circumradius = if name == "cube" { 3f64.sqrt() / 2.0 } else { math::hypot3(vertices[0][0], vertices[0][1], vertices[0][2]) };
    let [ea, eb] = edges[0];
    let mid: V3 = [(vertices[ea][0] + vertices[eb][0]) / 2.0, (vertices[ea][1] + vertices[eb][1]) / 2.0, (vertices[ea][2] + vertices[eb][2]) / 2.0];
    // volume: sum over faces of (1/3) area * inradius
    let mut vol = 0.0;
    for (k, f) in faces.iter().enumerate() {
        let mut a = 0.0;
        let mut i = 1;
        while i + 1 < f.len() {
            let c = cross3(sub3(vertices[f[i]], vertices[f[0]]), sub3(vertices[f[i + 1]], vertices[f[0]]));
            a += math::hypot3(c[0], c[1], c[2]) / 2.0;
            i += 1;
        }
        vol += (a * dot3(normals[k], vertices[f[0]])) / 3.0;
    }
    let mirror = if name == "tetrahedron" { vec![0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0] } else { vec![-1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0] };
    Some(PieceShape {
        name: name.to_string(),
        vertices,
        faces,
        normals,
        inradius,
        circumradius,
        midradius: math::hypot3(mid[0], mid[1], mid[2]),
        volume: vol,
        mirror,
        edges,
        edge_dirs,
    })
}
