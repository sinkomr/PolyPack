//! Convex 4-polytopes as boundary spaces: cells (facets), their local frames, ridges, gluings and
//! hinges. Port of packages/boundary/src/polytope.ts.
//!
//! The catalogue's six polytopes (`get_polytope`) are built here, by `build_polytope`, the port of
//! the source's builder, on first use, as the source's `getPolytope` builds them. The builder's
//! convex hull uses atan2, cos and sin and the hinges' angles use acos, and the validator compares
//! exactly in places (a centre on a window's face), so the polytopes must be the very doubles of
//! the TypeScript server: they are, because `polypack_js::math` is bit for bit the functions of
//! Node on the production platform (Node 24 on Linux x86-64). The six polytopes built here equal
//! the ones that Node builds, in every one of their 159,453 numbers and in the signs of zero; the
//! test `the_builders_give_the_polytopes_and_pieces_of_linux_node` holds that against a fixture
//! written under that Node (native/tools/boundary-tables.mts).
//!
//! The crate used to embed the polytopes as tables written by the TypeScript. The tables had been
//! written by Node on an Apple Silicon Mac, whose V8 is compiled with fused multiply-add: its sine,
//! cosine and arc tangent differ from the production platform's in the last bit for a few
//! arguments (the first, for the 16-cell, is `Math.sin(0.6154797086703874)` in hull.ts's `pivot`).
//! 373 numbers of the 16-cell, 24-cell, 120-cell and 600-cell were therefore not the server's, by
//! up to 7e-16 relative, which changed the last digits of 36 depths and one verdict at the
//! tolerance among 14,127 checks compared with Linux Node. A table of computed numbers is only as
//! good as the platform that wrote it; the ported builder does not depend on one.
//!
//! Conventions (deterministic for every polytope, and equal to the research prototype's tess.py for
//! the tesseract, so its configurations import unchanged):
//! - Cells are the facets of the convex hull, sorted by their outward unit normal n with
//!   `compare_normals`: first by the index k of the largest |n_k| (the first one on ties within
//!   1e-9), then by the sign of n_k (negative first), then lexicographically. For the tesseract
//!   [-1/2, 1/2]^4 the cell x_i = sigma/2 gets id 2 i + (sigma > 0), as in tess.py.
//! - A cell's origin is the centroid of its vertices (its centre for a regular cell).
//! - A cell's frame is Gram-Schmidt applied to the standard basis vectors e_0, ..., e_3 projected
//!   onto the cell's hyperplane, in that order, skipping the one that is (nearly) parallel to the
//!   normal. For the tesseract cell x_i = +-1/2 this gives the other coordinates in increasing
//!   order, tess.py's local axes.
//! - A cell's vertices are listed by ascending index in the polytope's vertex list; its facets
//!   (the ridges) are sorted by their local outward normals with `compare_normals` (for a tesseract
//!   cell: -u0, +u0, -u1, +u1, -u2, +u2, so facet 2 k + (tau > 0) is the face u_k = tau s/2).
//!
//! Gluing (`CellFacet.to_neighbor`): the ridge R between cells c and c' is fixed pointwise by the
//! rotation of R^4 in the plane span(n_c, n_c') that takes n_c to n_c' (the identity on the
//! orthogonal complement, which contains R's directions). It maps c's hyperplane onto c''s, and
//! the half of c's hyperplane beyond R (where a straight ray continues after crossing R) onto the
//! side of R where c' lies. In local coordinates this is y' = A y + s b with
//!   A = F_c'^T Rot F_c,  b = F_c'^T (Rot (o_c - q) + q - o_c')   (q any point of R, at s = 1),
//! F the frames as 4 x 3 matrices and o the origins. The matching facet of c' holds the inverse.

use crate::containers::unit_vertices;
use crate::hull::convex_hull;
use crate::linalg::{dot, iso_from_affine, orthonormal_basis, reject_from, sub, to_v3, unit, Iso3, V3};
use crate::types::{Affine, Cell, CellFacet, HalfSpace, CONTAINERS, POLYTOPES};
use polypack_js::math;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::OnceLock;

const ORDER_TOL: f64 = 1e-9;

/// A convex d-polytope with unit edge, centred at the origin.
/// packages/boundary/src/types.ts: Polytope, with the engine's topology cache (polytope.ts: topo) built in.
#[derive(Clone, Debug)]
pub struct Polytope {
    pub name: String,
    /// Ambient dimension d (4 for the tesseract); cells and pieces have dimension d - 1.
    pub d: usize,
    /// Vertices in R^d.
    pub vertices: Vec<Vec<f64>>,
    pub cells: Vec<Cell>,
    /// Total angle around each hinge, in radians (the full turn minus the deficit).
    pub hinge_angle: f64,
    /// The polytope's edges (the hinges) as pairs of indices into `vertices`, sorted.
    pub edges: Vec<[usize; 2]>,
    /// Total angle around each edge (aligned with `edges`): the sum of the dihedral angles at that
    /// edge of the cells containing it. `hinge_angle` is the smallest.
    pub edge_angles: Vec<f64>,
    /// The engine's per-cell data (polytope.ts: topo(poly)).
    pub topo: PolyTopo,
    /// The volume of the boundary at s = 1 (polytope.ts: boundaryVolume(poly)). The source computes
    /// it at every check; it depends on the polytope alone, so it is computed once here, by the same
    /// arithmetic (`boundary_volume_of`).
    pub volume: f64,
}

/// A facet plane n . y <= h at s = 1 (scale h by s).
#[derive(Clone, Copy, Debug)]
pub struct Plane {
    pub n: V3,
    pub h: f64,
}

/// Per-cell data derived from the public fields, in the shapes the engine computes with.
/// packages/boundary/src/polytope.ts: CellTopo
#[derive(Clone, Debug)]
pub struct CellTopo {
    /// Facet half-spaces n . y <= h at s = 1 (scale h by s).
    pub planes: Vec<Plane>,
    /// Facet polygons in local coordinates at s = 1, counter-clockwise around n.
    pub polys: Vec<Vec<V3>>,
    /// toNeighbor of each facet at s = 1 (scale t by s).
    pub glue: Vec<Iso3>,
    pub verts: Vec<V3>,
    /// Dihedral angle of the cell at each hinge (between the two facets containing it).
    pub hinge_dihedral: Vec<f64>,
    /// F x F: the hinge shared by facets a and b, or -1.
    pub pair_hinge: Vec<i32>,
    pub f: usize,
}

/// packages/boundary/src/polytope.ts: PolyTopo
#[derive(Clone, Debug, Default)]
pub struct PolyTopo {
    pub cells: Vec<CellTopo>,
    /// Global edge index of each cell's hinges, per cell.
    pub hinge_edge: Vec<Vec<i32>>,
}

/// The deterministic order of unit normals described above.
/// packages/boundary/src/polytope.ts: compareNormals
pub fn compare_normals(a: &[f64], b: &[f64]) -> f64 {
    let dominant = |n: &[f64]| -> usize {
        let mut m = f64::NEG_INFINITY;
        for x in n {
            m = math::max(m, x.abs());
        }
        n.iter().position(|x| x.abs() >= m - ORDER_TOL).unwrap_or(usize::MAX)
    };
    let ka = dominant(a);
    let kb = dominant(b);
    if ka != kb {
        return ka as f64 - kb as f64;
    }
    let sa = math::sign(a[ka]);
    let sb = math::sign(b[kb]);
    if sa != sb {
        return sa - sb;
    }
    for i in 0..a.len() {
        if (a[i] - b[i]).abs() > ORDER_TOL {
            return a[i] - b[i];
        }
    }
    0.0
}

/// A comparator's number as an ordering (a NaN compares equal, as in Array.prototype.sort).
fn ordering(x: f64) -> Ordering {
    if x < 0.0 {
        Ordering::Less
    } else if x > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

fn snap(x: f64) -> f64 {
    if x.abs() < 1e-15 {
        0.0
    } else {
        x
    }
}

/// Points of `pts` (indices `ids`) in cyclic order, counter-clockwise around the unit normal n (3D).
/// packages/boundary/src/polytope.ts: cyclicOrder
fn cyclic_order(pts: &[Vec<f64>], ids: &[usize], n: &[f64]) -> Vec<usize> {
    let mut c = [0.0; 3];
    for &i in ids {
        for k in 0..3 {
            c[k] += pts[i][k] / ids.len() as f64;
        }
    }
    let e1 = unit(&sub(&pts[ids[0]], &c));
    // e2 = n x e1, so (e1, e2, n) is right-handed and increasing angle is counter-clockwise around n
    let e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    let ang = |i: usize| -> f64 {
        let d = sub(&pts[i], &c);
        math::atan2(dot(&d, &e2), dot(&d, &e1))
    };
    let mut out = ids.to_vec();
    out.sort_by(|&a, &b| ordering(ang(a) - ang(b)));
    out
}

fn pair_key(a: usize, b: usize) -> (usize, usize) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Builds the boundary space of the convex hull of `vertices` (points of R^4, every one a vertex of
/// the hull). The polytope should have unit edge and be centred at the origin (the contract's
/// convention); the builder does not rescale.
/// packages/boundary/src/polytope.ts: buildPolytope (tol defaults to 1e-9 there)
pub fn build_polytope(name: &str, vertices: &[Vec<f64>], tol: f64) -> Result<Polytope, String> {
    let d = vertices.first().map(|v| v.len());
    if d != Some(4) {
        return Err("buildPolytope: only 4-polytopes (3D cells) are supported".to_string());
    }
    let d = 4usize;
    if vertices.iter().any(|v| v.len() != d || v.iter().any(|x| !x.is_finite())) {
        return Err("buildPolytope: bad vertex list".to_string());
    }
    let hull = convex_hull(vertices, tol)?;
    let mut order: Vec<usize> = (0..hull.len()).collect();
    order.sort_by(|&a, &b| ordering(compare_normals(&hull[a].normal, &hull[b].normal)));

    struct Raw {
        cell: Cell,
        face_keys: Vec<Vec<usize>>,
    }
    let mut raws: Vec<Raw> = Vec::new();
    for (index, &hi) in order.iter().enumerate() {
        let f = &hull[hi];
        let normal: Vec<f64> = f.normal.iter().map(|&x| snap(x)).collect();
        let mut vertex_ids = f.ids.clone();
        vertex_ids.sort_unstable();
        let mut origin = vec![0.0; d];
        for &id in &vertex_ids {
            for k in 0..d {
                origin[k] += vertices[id][k] / vertex_ids.len() as f64;
            }
        }
        let std: Vec<Vec<f64>> = (0..d).map(|j| (0..d).map(|i| if i == j { 1.0 } else { 0.0 }).collect()).collect();
        let rejected: Vec<Vec<f64>> = std.iter().map(|e| reject_from(e, std::slice::from_ref(&normal))).collect();
        let mut frame = orthonormal_basis(&rejected, 1e-6);
        frame.truncate(d - 1);
        let frame: Vec<Vec<f64>> = frame.into_iter().map(|f| f.into_iter().map(snap).collect()).collect();
        let local: Vec<Vec<f64>> = vertex_ids
            .iter()
            .map(|&id| {
                let rel = sub(&vertices[id], &origin);
                frame.iter().map(|f| snap(dot(&rel, f))).collect()
            })
            .collect();
        let h3 = convex_hull(&local, tol)?;
        let mut f_order: Vec<usize> = (0..h3.len()).collect();
        f_order.sort_by(|&a, &b| ordering(compare_normals(&h3[a].normal, &h3[b].normal)));
        let mut facets: Vec<CellFacet> = Vec::new();
        let mut face_keys: Vec<Vec<usize>> = Vec::new();
        let mut hinge_set: Vec<[usize; 2]> = Vec::new();
        for &fi in &f_order {
            let f = &h3[fi];
            let n3: Vec<f64> = f.normal.iter().map(|&x| snap(x)).collect();
            let poly = cyclic_order(&local, &f.ids, &n3);
            for j in 0..poly.len() {
                let (a, b) = pair_key(poly[j], poly[(j + 1) % poly.len()]);
                if !hinge_set.contains(&[a, b]) {
                    hinge_set.push([a, b]);
                }
            }
            let h = snap(dot(&n3, &local[poly[0]]));
            facets.push(CellFacet {
                inside: HalfSpace { n: n3, h },
                neighbor: usize::MAX,
                neighbor_facet: usize::MAX,
                to_neighbor: Affine { a: vec![], b: vec![] },
                vertices: poly,
            });
            let mut key: Vec<usize> = f.ids.iter().map(|&i| vertex_ids[i]).collect();
            key.sort_unstable();
            face_keys.push(key);
        }
        let mut hinges = hinge_set;
        hinges.sort();
        let cell = Cell { index, normal, origin: origin.into_iter().map(snap).collect(), frame, vertices: local, hinges, facets, vertex_ids };
        raws.push(Raw { cell, face_keys });
    }

    // match ridges: each 2-face lies in exactly two cells
    let mut by_key: HashMap<&Vec<usize>, Vec<(usize, usize)>> = HashMap::new();
    let mut key_order: Vec<&Vec<usize>> = Vec::new();
    for (c, r) in raws.iter().enumerate() {
        for (f, k) in r.face_keys.iter().enumerate() {
            let e = by_key.entry(k).or_default();
            if e.is_empty() {
                key_order.push(k);
            }
            e.push((c, f));
        }
    }
    for key in &key_order {
        let list = &by_key[*key];
        if list.len() != 2 {
            let text: Vec<String> = key.iter().map(|v| v.to_string()).collect();
            return Err(format!("buildPolytope: ridge {} lies in {} cells", text.join(","), list.len()));
        }
    }
    let mut cells: Vec<Cell> = raws.iter().map(|r| r.cell.clone()).collect();
    for (c, r) in raws.iter().enumerate() {
        for (f, key) in r.face_keys.iter().enumerate() {
            let list = &by_key[key];
            let (p, q) = (list[0], list[1]);
            let (c2, f2) = if p.0 == c && p.1 == f { q } else { p };
            let g = gluing(&cells[c], &cells[c2], &vertices[key[0]]);
            let facet = &mut cells[c].facets[f];
            facet.neighbor = c2;
            facet.neighbor_facet = f2;
            facet.to_neighbor = g;
        }
    }

    // edges and the total angle around each
    let mut edge_map: HashMap<(usize, usize), usize> = HashMap::new();
    let mut edges: Vec<[usize; 2]> = Vec::new();
    for c in &cells {
        for &[a, b] in &c.hinges {
            let k = pair_key(c.vertex_ids[a], c.vertex_ids[b]);
            if !edge_map.contains_key(&k) {
                edge_map.insert(k, usize::MAX);
                edges.push([k.0, k.1]);
            }
        }
    }
    edges.sort();
    for (i, e) in edges.iter().enumerate() {
        edge_map.insert((e[0], e[1]), i);
    }
    let mut edge_angles = vec![0.0; edges.len()];
    let mut cell_topos: Vec<CellTopo> = Vec::new();
    for c in &cells {
        let t = cell_topo_of(c)?;
        for (hi, &[a, b]) in c.hinges.iter().enumerate() {
            let e = edge_map[&pair_key(c.vertex_ids[a], c.vertex_ids[b])];
            edge_angles[e] += t.hinge_dihedral[hi];
        }
        cell_topos.push(t);
    }
    let hinge_angle = math::min_of(&edge_angles);
    let hinge_edge = hinge_edges(&cells, &edges);
    let volume = boundary_volume_of(&cells);
    Ok(Polytope {
        name: name.to_string(),
        d,
        vertices: vertices.to_vec(),
        cells,
        hinge_angle,
        edges,
        edge_angles,
        topo: PolyTopo { cells: cell_topos, hinge_edge },
        volume,
    })
}

/// The gluing across the ridge shared by cells c and c2 (q: a point of the ridge, at s = 1).
/// packages/boundary/src/polytope.ts: gluing
fn gluing(c: &Cell, c2: &Cell, q: &[f64]) -> Affine {
    let n = &c.normal;
    let n2 = &c2.normal;
    let cphi = dot(n, n2);
    let ev: Vec<f64> = n2.iter().enumerate().map(|(i, x)| x - cphi * n[i]).collect();
    let e = unit(&ev);
    let sphi = dot(n2, &e);
    // Rot x = x + (cos - 1)((n.x) n + (e.x) e) + sin ((n.x) e - (e.x) n): the rotation by the angle
    // between the normals in the plane span(n, e), taking n to n2
    let rot = |x: &[f64]| -> Vec<f64> {
        let a = dot(n, x);
        let b = dot(&e, x);
        x.iter().enumerate().map(|(i, xi)| xi + (cphi - 1.0) * (a * n[i] + b * e[i]) + sphi * (a * e[i] - b * n[i])).collect()
    };
    let a: Vec<Vec<f64>> = c2.frame.iter().map(|f2| c.frame.iter().map(|f| snap(dot(f2, &rot(f)))).collect()).collect();
    let p: Vec<f64> = rot(&sub(&c.origin, q)).iter().enumerate().map(|(i, x)| x + q[i] - c2.origin[i]).collect();
    let b: Vec<f64> = c2.frame.iter().map(|f2| snap(dot(f2, &p))).collect();
    Affine { a, b }
}

// ---------------------------------------------------------------- internal topology cache

/// packages/boundary/src/polytope.ts: cellTopoOf
fn cell_topo_of(c: &Cell) -> Result<CellTopo, String> {
    let f_count = c.facets.len();
    let verts: Vec<V3> = c.vertices.iter().map(|v| to_v3(v)).collect();
    let polys: Vec<Vec<V3>> = c.facets.iter().map(|f| f.vertices.iter().map(|&i| verts[i]).collect()).collect();
    let planes: Vec<Plane> = c.facets.iter().map(|f| Plane { n: to_v3(&f.inside.n), h: f.inside.h }).collect();
    let mut pair_hinge = vec![-1i32; f_count * f_count];
    let mut hinge_dihedral = vec![0.0; c.hinges.len()];
    let mut index: HashMap<(usize, usize), usize> = HashMap::new();
    for (i, &[a, b]) in c.hinges.iter().enumerate() {
        index.insert((a, b), i);
    }
    let mut owners: Vec<Vec<usize>> = c.hinges.iter().map(|_| Vec::new()).collect();
    for (fi, f) in c.facets.iter().enumerate() {
        let p = &f.vertices;
        for j in 0..p.len() {
            let a = p[j];
            let b = p[(j + 1) % p.len()];
            if let Some(&h) = index.get(&pair_key(a, b)) {
                owners[h].push(fi);
            }
        }
    }
    for (h, fs) in owners.iter().enumerate() {
        if fs.len() != 2 {
            return Err(format!("cell {}: hinge {} lies in {} facets", c.index, h, fs.len()));
        }
        let (a, b) = (fs[0], fs[1]);
        pair_hinge[a * f_count + b] = h as i32;
        pair_hinge[b * f_count + a] = h as i32;
        let cos = math::max(-1.0, math::min(1.0, crate::linalg::dot3(planes[a].n, planes[b].n)));
        hinge_dihedral[h] = math::PI - math::acos(cos);
    }
    let glue = c.facets.iter().map(|f| iso_from_affine(&f.to_neighbor, 1.0)).collect();
    Ok(CellTopo { planes, polys, glue, verts, hinge_dihedral, pair_hinge, f: f_count })
}

/// The global edge index of each cell's hinges (polytope.ts: topo, `hingeEdge`).
fn hinge_edges(cells: &[Cell], edges: &[[usize; 2]]) -> Vec<Vec<i32>> {
    let mut edge_idx: HashMap<(usize, usize), usize> = HashMap::new();
    for (i, e) in edges.iter().enumerate() {
        edge_idx.insert((e[0], e[1]), i);
    }
    cells
        .iter()
        .map(|c| c.hinges.iter().map(|&[a, b]| edge_idx.get(&pair_key(c.vertex_ids[a], c.vertex_ids[b])).map_or(-1, |&i| i as i32)).collect())
        .collect()
}

/// The engine's topology of a polytope. packages/boundary/src/polytope.ts: topo
#[inline]
pub fn topo(poly: &Polytope) -> &PolyTopo {
    &poly.topo
}

// ---------------------------------------------------------------- the catalogue

/// Vertices (+-1/2)^4 of the unit tesseract; vertex v has coordinate k = +1/2 exactly when bit k of v is set.
/// packages/boundary/src/polytope.ts: tesseractVertices
pub fn tesseract_vertices() -> Vec<Vec<f64>> {
    (0..16usize).map(|v| (0..4).map(|k| if (v >> k) & 1 == 1 { 0.5 } else { -0.5 }).collect()).collect()
}

/// packages/boundary/src/polytope.ts: isPolytopeName
pub fn is_polytope_name(x: &str) -> bool {
    POLYTOPES.contains(&x)
}

/// Is x the name of a container of the catalogue: a 4-polytope, a d-cube (d = 5..10) or an nD container?
/// packages/boundary/src/polytope.ts: isContainerName
pub fn is_container_name(x: &str) -> bool {
    CONTAINERS.contains(&x)
}

/// The catalogue's polytopes (unit edge, centred at the origin), each built on first use and shared.
/// packages/boundary/src/polytope.ts: getPolytope
pub fn get_polytope(name: &str) -> Result<&'static Polytope, String> {
    static CACHE: [OnceLock<Result<Polytope, String>>; 6] = [OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new()];
    let i = POLYTOPES.iter().position(|&n| n == name).ok_or_else(|| format!("unknown polytope {name}"))?;
    CACHE[i].get_or_init(|| build_catalogue_polytope(name)).as_ref().map_err(|e| e.clone())
}

/// A polytope of the catalogue, built anew (what `get_polytope` builds once and keeps): for timing
/// the builder, and for the comparison's `polytopeBuilt`.
/// packages/boundary/src/polytope.ts: getPolytope, without its cache
pub fn build_catalogue_polytope(name: &str) -> Result<Polytope, String> {
    if name == "tesseract" {
        build_polytope("tesseract", &tesseract_vertices(), 1e-9)
    } else if POLYTOPES.contains(&name) {
        build_polytope(name, &unit_vertices(name).ok_or_else(|| format!("unknown polytope {name}"))?, 1e-9)
    } else {
        Err(format!("unknown polytope {name}"))
    }
}

/// Volume of the boundary (the sum of the cells' 3-volumes) at s = 1; scale by s^3. Each cell is the
/// union of the pyramids from its origin (inside it) over its facets: sum of h_f area_f / 3.
/// packages/boundary/src/polytope.ts: boundaryVolume
pub fn boundary_volume(poly: &Polytope) -> f64 {
    poly.volume
}

/// The sum that `boundaryVolume` of the source computes (see `Polytope::volume`).
fn boundary_volume_of(cells: &[Cell]) -> f64 {
    let mut v = 0.0;
    for c in cells {
        for f in &c.facets {
            // (the source first lists the facet's vertices, P = f.vertices.map(i => c.vertices[i]); read in place here)
            let p = &f.vertices;
            // Newell: twice the area vector
            let mut ax = 0.0;
            let mut ay = 0.0;
            let mut az = 0.0;
            for i in 0..p.len() {
                let a = &c.vertices[p[i]];
                let b = &c.vertices[p[(i + 1) % p.len()]];
                ax += (a[1] - b[1]) * (a[2] + b[2]);
                ay += (a[2] - b[2]) * (a[0] + b[0]);
                az += (a[0] - b[0]) * (a[1] + b[1]);
            }
            v += (f.inside.h * math::hypot3(ax, ay, az)) / 6.0;
        }
    }
    v
}

/// Largest violation of the cell's facet inequalities by u at edge s (<= 0 inside the closed cell).
/// packages/boundary/src/polytope.ts: cellExcess
pub fn cell_excess(poly: &Polytope, cell: usize, u: &[f64], s: f64) -> f64 {
    let mut worst = f64::NEG_INFINITY;
    for f in &poly.cells[cell].facets {
        worst = math::max(worst, dot(&f.inside.n, u) - s * f.inside.h);
    }
    worst
}
