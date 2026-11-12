//! Convex polyhedral surfaces: the five Platonic solids, the 13 Archimedean and 13 Catalan solids,
//! the prisms with 3 and 5 to 12 sides, the antiprisms with 4 to 12 sides and the 92 Johnson
//! solids, each a closed surface of convex polygons glued edge to edge, flat except at the
//! vertices (cone points). Port of `packages/surface/src/solids.ts`.
//!
//! Conventions (fixed; the Python certifier rebuilds them independently and the two must agree):
//! - Platonic solids: vertices in a documented order (see `vertex_list`), at unit edge length. The
//!   other solids: the polyhedra family's canonical solids, in its vertex order and scale (unit
//!   edges for Archimedean solids, prisms, antiprisms and Johnson solids; Catalan solids are the
//!   polar reciprocals of the unit-edge Archimedean solids about the midsphere). The score s is the
//!   scale factor of that canonical solid, which for the Platonic, Archimedean and Johnson solids
//!   and the prisms and antiprisms is the edge length.
//! - A face is the cycle of its vertex ids, counter-clockwise seen from outside, rotated so that
//!   its smallest vertex id comes first. Faces are sorted lexicographically by these cycles.
//! - Face frame: the origin is the face centre (see below), and the last edge (frame vertex M - 1
//!   to frame vertex 0) is horizontal at the bottom, running in +x. Frame vertex k is the 3D vertex
//!   faces[f][k] and edge k runs from frame vertex k to k + 1, so frame vertex 0 is the bottom
//!   right corner. The face centre is the foot of the perpendicular from the solid's centre to the
//!   face plane for the Platonic, Archimedean, Catalan, prism and antiprism faces, which have a
//!   circumsphere or an insphere about the solid's centre (the foot is the circumcentre of a
//!   regular face, the incentre of a Catalan face). The Johnson solids have neither in general, so
//!   for them it is the circumcentre of the regular face (the mean of its vertices), not the foot
//!   (`frame_of`). For a regular face (all faces of the Platonic, Archimedean and Johnson solids,
//!   prisms and antiprisms) this is the regular M-gon of side s centred at the origin with a
//!   horizontal bottom edge, PolyPack's container convention with phi = 0: frame vertex k at angle
//!   -pi/2 + pi/M + 2 pi k/M (`frame_vertex`). Catalan faces are irregular but tangential (every
//!   edge touches the midsphere), and the foot is their incentre. Counter-clockwise in the frame is
//!   counter-clockwise from outside, so a frame is an orientation-preserving chart of the surface.
//! - The surface metric depends only on the faces and the gluing (which edge meets which); the 3D
//!   coordinates fix the face shapes and are used for drawing.
//!
//! The Platonic solids keep the code paths they had before the generalisation (`uniform`), so that
//! their validation is bit for bit unchanged.
//!
//! The table of the other solids (`packages/surface/src/general.data.ts`) and the lists of names
//! are not retyped: `native/tools/surface-export.mts` writes them to `data/general.json` and
//! `data/names.json`, and its `--check` mode fails when a file is out of date.

use polypack_js::math;
use polypack_js::math::PI;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// `packages/surface/src/general.data.ts: GeneralSolidData`.
#[derive(Deserialize, Debug)]
pub struct GeneralSolidData {
    pub name: String,
    /// "archimedean" | "catalan" | "prism" | "antiprism" | "johnson"
    pub family: String,
    pub title: String,
    /// vertices of the canonical solid, centred at the origin
    #[serde(rename = "V")]
    pub v: Vec<[f64; 3]>,
    /// faces as vertex cycles, counter-clockwise seen from outside
    pub faces: Vec<Vec<usize>>,
}

/// `packages/surface/src/general.data.ts: GENERAL_SOLID_DATA`, read from `data/general.json`.
pub fn general_solid_data() -> &'static [GeneralSolidData] {
    static DATA: OnceLock<Vec<GeneralSolidData>> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("../data/general.json")).expect("data/general.json"))
}

/// The names of the solids by family, each in catalogue order (`data/names.json`).
#[derive(Deserialize, Debug)]
pub struct SolidNames {
    /// `SOLID_NAMES` / `PLATONIC_NAMES`: the five Platonic solids.
    pub platonic: Vec<String>,
    /// `ARCHIMEDEAN_NAMES`: the 13 Archimedean solids, in the polyhedra catalogue order.
    pub archimedean: Vec<String>,
    /// `CATALAN_NAMES`: the Catalan solids, by number of faces, then name.
    pub catalan: Vec<String>,
    /// `PRISM_NAMES`.
    pub prism: Vec<String>,
    /// `ANTIPRISM_NAMES`.
    pub antiprism: Vec<String>,
    /// `JOHNSON_NAMES`: the 92 Johnson solids, J1 to J92 in Johnson's order.
    pub johnson: Vec<String>,
}

/// The lists of names of `packages/surface/src/solids.ts` (`SOLID_NAMES`, `ARCHIMEDEAN_NAMES`, ...).
pub fn solid_names() -> &'static SolidNames {
    static NAMES: OnceLock<SolidNames> = OnceLock::new();
    NAMES.get_or_init(|| serde_json::from_str(include_str!("../data/names.json")).expect("data/names.json"))
}

/// `packages/surface/src/solids.ts: ALL_SOLID_NAMES` (the `SolidName` list). Every solid of the
/// family, grouped by family (Platonic, Archimedean, Catalan, prisms, antiprisms, Johnson) in
/// catalogue order within each family.
pub fn all_solid_names() -> &'static [String] {
    static ALL: OnceLock<Vec<String>> = OnceLock::new();
    ALL.get_or_init(|| {
        let n = solid_names();
        [&n.platonic, &n.archimedean, &n.catalan, &n.prism, &n.antiprism, &n.johnson]
            .into_iter()
            .flat_map(|l| l.iter().cloned())
            .collect()
    })
}

/// `packages/surface/src/solids.ts: isSolidName`.
pub fn is_solid_name(x: &str) -> bool {
    all_solid_names().iter().any(|n| n == x)
}

/// `packages/surface/src/solids.ts: SolidFamily`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SolidFamily {
    Platonic,
    Archimedean,
    Catalan,
    Prism,
    Antiprism,
    Johnson,
}

impl SolidFamily {
    /// The family as the TypeScript writes it ("platonic", "archimedean", ...).
    pub fn as_str(self) -> &'static str {
        match self {
            SolidFamily::Platonic => "platonic",
            SolidFamily::Archimedean => "archimedean",
            SolidFamily::Catalan => "catalan",
            SolidFamily::Prism => "prism",
            SolidFamily::Antiprism => "antiprism",
            SolidFamily::Johnson => "johnson",
        }
    }

    fn of_data(family: &str) -> SolidFamily {
        match family {
            "archimedean" => SolidFamily::Archimedean,
            "catalan" => SolidFamily::Catalan,
            "prism" => SolidFamily::Prism,
            "antiprism" => SolidFamily::Antiprism,
            "johnson" => SolidFamily::Johnson,
            other => panic!("data/general.json: unknown family {other}"),
        }
    }
}

/// `packages/surface/src/solids.ts: EdgeRef`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EdgeRef {
    pub face: usize,
    pub edge: usize,
}

pub type V3 = [f64; 3];

/// The 3D frame of a face at scale 1 (origin, x axis, y axis), for drawing.
#[derive(Clone, Copy, Debug)]
pub struct Frame3D {
    pub o: V3,
    pub ex: V3,
    pub ey: V3,
}

/// `packages/surface/src/solids.ts: Solid`.
#[derive(Clone, Debug)]
pub struct Solid {
    pub name: String,
    pub family: SolidFamily,
    /// Plain name, e.g. "cube", "rhombic dodecahedron", "pentagonal prism".
    pub title: String,
    /// sides of every face when all faces have the same number of sides, else the largest (see `sides`)
    pub m: usize,
    /// number of faces (`F`)
    pub f: usize,
    /// number of vertices (`V`)
    pub v: usize,
    /// number of edges (`E`)
    pub e: f64,
    /// faces meeting at every vertex when that number is the same at every vertex, else NaN
    pub degree: f64,
    /// interior angle of every face when all faces are the same regular M-gon, (M - 2) pi / M; else NaN
    pub face_angle: f64,
    /// total angle around every vertex when it is the same at every vertex (< 2 pi); else NaN
    pub cone_angle: f64,
    /// canonical 3D coordinates (unit edge for the Platonic solids), for drawing only
    pub vertices: Vec<V3>,
    /// faces[f][k] = vertex id of frame vertex k
    pub faces: Vec<Vec<usize>>,
    /// adj[f][k] = the face and edge glued to edge k of face f
    pub adj: Vec<Vec<EdgeRef>>,
    /// number of sides of each face
    pub sides: Vec<usize>,
    /// True for the Platonic solids: every face is the same regular M-gon in the regular frame.
    /// Their code paths are the ones from before the generalisation, so their results stay bit for
    /// bit the same.
    pub uniform: bool,
    /// per face: a regular polygon in the regular frame (frame vertices from `frame_vertex`)
    pub regular: Vec<bool>,
    /// per face: frame vertices at scale s = 1, flat [x0, y0, x1, y1, ...]
    pub unit_faces: Vec<Vec<f64>>,
    /// per face: interior angle at each frame vertex (radians)
    pub corner: Vec<Vec<f64>>,
    /// per face: direction angle of each edge (frame vertex k to k + 1) in the face's frame
    pub edge_angle: Vec<Vec<f64>>,
    /// per vertex: number of faces at it
    pub vertex_degree: Vec<usize>,
    /// per vertex: cone angle, the sum of the face angles at it (radians, < 2 pi)
    pub vertex_cone: Vec<f64>,
    /// per face: the 3D frame at scale 1 (origin, x axis, y axis), for drawing
    pub frame_3d: Vec<Frame3D>,
}

/// `packages/surface/src/solids.ts: vertexList`. Vertex coordinates in the documented order:
/// Platonic solids at unit edge, the others canonical.
pub fn vertex_list(name: &str) -> Result<Vec<V3>, String> {
    let phi = (1.0 + (5.0f64).sqrt()) / 2.0;
    let scale = |pts: Vec<V3>, k: f64| -> Vec<V3> { pts.iter().map(|p| [p[0] * k, p[1] * k, p[2] * k]).collect() };
    let cube = |h: f64| -> Vec<V3> {
        // vertex i: x = +h when bit 0 is set, y when bit 1, z when bit 2
        (0..8)
            .map(|i| [if i & 1 != 0 { h } else { -h }, if i & 2 != 0 { h } else { -h }, if i & 4 != 0 { h } else { -h }])
            .collect()
    };
    // the three cyclic patterns (0, ±a, ±b), (±a, ±b, 0), (±b, 0, ±a), signs in the order (+,+), (+,-), (-,+), (-,-)
    let cyclic = |a: f64, b: f64| -> Vec<V3> {
        let sg: [[f64; 2]; 4] = [[1.0, 1.0], [1.0, -1.0], [-1.0, 1.0], [-1.0, -1.0]];
        let mut out: Vec<V3> = Vec::new();
        for [p, q] in sg {
            out.push([0.0, p * a, q * b]);
        }
        for [p, q] in sg {
            out.push([p * a, q * b, 0.0]);
        }
        for [p, q] in sg {
            out.push([q * b, 0.0, p * a]);
        }
        out
    };
    match name {
        "tetrahedron" => {
            return Ok(scale(
                vec![[1.0, 1.0, 1.0], [1.0, -1.0, -1.0], [-1.0, 1.0, -1.0], [-1.0, -1.0, 1.0]],
                1.0 / (2.0 * math::SQRT2),
            ))
        }
        "cube" => return Ok(scale(cube(0.5), 1.0)),
        "octahedron" => {
            return Ok(scale(
                vec![
                    [1.0, 0.0, 0.0],
                    [-1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, -1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.0, 0.0, -1.0],
                ],
                1.0 / math::SQRT2,
            ))
        }
        "icosahedron" => return Ok(scale(cyclic(1.0, phi), 0.5)),
        "dodecahedron" => {
            let mut pts = cube(1.0);
            pts.extend(cyclic(1.0 / phi, phi));
            return Ok(scale(pts, phi / 2.0));
        }
        _ => {}
    }
    match general_solid_data().iter().find(|x| x.name == name) {
        None => Err(format!("unknown solid {name}")),
        Some(d) => Ok(d.v.iter().map(|p| [p[0], p[1], p[2]]).collect()),
    }
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross3(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// `packages/surface/src/solids.ts: hullFaces`. Faces of the convex hull of `pts` (all points are
/// hull vertices), canonically ordered.
pub fn hull_faces(pts: &[V3]) -> Vec<Vec<usize>> {
    let n = pts.len();
    let mut seen: HashSet<Vec<usize>> = HashSet::new();
    let mut faces: Vec<Vec<usize>> = Vec::new();
    for i in 0..n {
        for j in i + 1..n {
            for k in j + 1..n {
                let mut nrm = cross3(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
                let len = math::hypot3(nrm[0], nrm[1], nrm[2]);
                if len < 1e-9 {
                    continue;
                }
                nrm = [nrm[0] / len, nrm[1] / len, nrm[2] / len];
                let d = dot(nrm, pts[i]);
                let mut pos = 0;
                let mut neg = 0;
                let mut on: Vec<usize> = Vec::new();
                for (m, p) in pts.iter().enumerate() {
                    let t = dot(nrm, *p) - d;
                    if t > 1e-9 {
                        pos += 1;
                    } else if t < -1e-9 {
                        neg += 1;
                    } else {
                        on.push(m);
                    }
                }
                if pos != 0 && neg != 0 {
                    continue;
                }
                // the TypeScript's key is on.join(","): the same set of keys
                if seen.contains(&on) {
                    continue;
                }
                seen.insert(on.clone());
                // outward normal: the other vertices lie on the negative side
                if pos != 0 {
                    nrm = [-nrm[0], -nrm[1], -nrm[2]];
                }
                faces.push(order_ccw(pts, &on, nrm));
            }
        }
    }
    sort_faces(faces)
}

/// `packages/surface/src/solids.ts: sortFaces`. Lexicographic by the cycles, a prefix first
/// (Array.prototype.sort is stable, as `sort_by` is).
fn sort_faces(mut faces: Vec<Vec<usize>>) -> Vec<Vec<usize>> {
    faces.sort_by(|a, b| {
        for t in 0..a.len().min(b.len()) {
            if a[t] != b[t] {
                return a[t].cmp(&b[t]);
            }
        }
        a.len().cmp(&b.len())
    });
    faces
}

/// `packages/surface/src/solids.ts: canonicalCycle`. A face cycle (counter-clockwise from outside)
/// rotated to start at its smallest id.
pub fn canonical_cycle(cycle: &[usize]) -> Vec<usize> {
    let min = cycle.iter().copied().min().unwrap_or(0);
    let m = cycle.iter().position(|&v| v == min).unwrap_or(0);
    let mut out = cycle[m..].to_vec();
    out.extend_from_slice(&cycle[..m]);
    out
}

/// `packages/surface/src/solids.ts: orderCcw`. Counter-clockwise order about the outward normal,
/// starting at the smallest id.
fn order_ccw(pts: &[V3], ids: &[usize], nrm: V3) -> Vec<usize> {
    let mut c: V3 = [0.0, 0.0, 0.0];
    for &id in ids {
        for t in 0..3 {
            c[t] += pts[id][t] / ids.len() as f64;
        }
    }
    let e1 = sub(pts[ids[0]], c);
    let l1 = math::hypot3(e1[0], e1[1], e1[2]);
    let u: V3 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
    let w = cross3(nrm, u);
    let ang = |id: usize| -> f64 {
        let d = sub(pts[id], c);
        math::atan2(dot(d, w), dot(d, u))
    };
    let mut sorted: Vec<usize> = ids.to_vec();
    // the comparator (a, b) => ang(a) - ang(b) of a stable sort
    sorted.sort_by(|&a, &b| {
        let d = ang(a) - ang(b);
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    canonical_cycle(&sorted)
}

/// `packages/surface/src/solids.ts: cornerAngle`. Interior angle of a convex polygon (flat
/// counter-clockwise array) at vertex k.
fn corner_angle(poly: &[f64], k: usize) -> f64 {
    let n = poly.len() / 2;
    let i = (k + n - 1) % n;
    let j = (k + 1) % n;
    let ax = poly[2 * i] - poly[2 * k];
    let ay = poly[2 * i + 1] - poly[2 * k + 1];
    let bx = poly[2 * j] - poly[2 * k];
    let by = poly[2 * j + 1] - poly[2 * k + 1];
    // turning from the next edge counter-clockwise to the previous one
    math::atan2(bx * ay - by * ax, ax * bx + ay * by)
}

struct Frame {
    o: V3,
    ex: V3,
    ey: V3,
    flat: Vec<f64>,
}

/// `packages/surface/src/solids.ts: frameOf`. The frame of a face from its 3D vertices, edge n - 1
/// along +x. The origin is the foot of the perpendicular from the solid's centre, or with
/// `at_face_centre` (the Johnson solids) the circumcentre of the regular face, the mean of its
/// vertices, which the foot is not unless the solid has a sphere through (or touching) its faces
/// about the centre.
fn frame_of(pts: &[V3], at_face_centre: bool) -> Frame {
    let n = pts.len();
    // outward normal from the polygon's vector area (the cycle runs counter-clockwise from outside)
    let mut nrm: V3 = [0.0, 0.0, 0.0];
    for k in 0..n {
        let c = cross3(pts[k], pts[(k + 1) % n]);
        nrm = [nrm[0] + c[0], nrm[1] + c[1], nrm[2] + c[2]];
    }
    let ln = math::hypot3(nrm[0], nrm[1], nrm[2]);
    nrm = [nrm[0] / ln, nrm[1] / ln, nrm[2] / ln];
    let mut off = 0.0;
    for p in pts {
        off += dot(nrm, *p) / n as f64;
    }
    let o: V3 = if at_face_centre {
        let mean = |t: usize| pts.iter().fold(0.0, |a, p| a + p[t]) / n as f64;
        [mean(0), mean(1), mean(2)]
    } else {
        [nrm[0] * off, nrm[1] * off, nrm[2] * off]
    };
    // the bottom edge, from frame vertex n - 1 to frame vertex 0, runs along +x
    let e = sub(pts[0], pts[n - 1]);
    let le = math::hypot3(e[0], e[1], e[2]);
    let ex: V3 = [e[0] / le, e[1] / le, e[2] / le];
    let ey = cross3(nrm, ex);
    let mut flat = vec![0.0; 2 * n];
    for (k, p) in pts.iter().enumerate() {
        let d = sub(*p, o);
        flat[2 * k] = dot(d, ex);
        flat[2 * k + 1] = dot(d, ey);
    }
    Frame { o, ex, ey, flat }
}

/// `packages/surface/src/solids.ts: getSolid`. The solid of a name, built once and kept (the
/// TypeScript's `cache`). An unknown name, an unglued edge or a face that is not the regular
/// polygon of its frame is the `Err` with the message the TypeScript throws.
pub fn get_solid(name: &str) -> Result<&'static Solid, String> {
    static CACHE: OnceLock<Vec<OnceLock<Result<Solid, String>>>> = OnceLock::new();
    let Some(index) = all_solid_names().iter().position(|n| n == name) else {
        return Err(format!("unknown solid {name}"));
    };
    let cache = CACHE.get_or_init(|| all_solid_names().iter().map(|_| OnceLock::new()).collect());
    cache[index].get_or_init(|| build_solid(name)).as_ref().map_err(|e| e.clone())
}

/// The body of `getSolid` after its cache.
fn build_solid(name: &str) -> Result<Solid, String> {
    let vertices = vertex_list(name)?;
    let data = general_solid_data().iter().find(|x| x.name == name);
    let uniform = solid_names().platonic.iter().any(|n| n == name);
    // Platonic: hull of the documented vertices; the others: the canonical solid's own faces, canonically ordered
    let faces: Vec<Vec<usize>> = if uniform {
        hull_faces(&vertices)
    } else {
        let d = data.ok_or_else(|| format!("unknown solid {name}"))?;
        sort_faces(d.faces.iter().map(|f| canonical_cycle(f)).collect())
    };
    let family = if uniform { SolidFamily::Platonic } else { SolidFamily::of_data(&data.unwrap().family) };
    let nf = faces.len();
    let nv = vertices.len();
    let sides: Vec<usize> = faces.iter().map(|f| f.len()).collect();
    let e = sides.iter().fold(0.0, |a, &b| a + b as f64) / 2.0;
    // edge k of face f runs from faces[f][k] to faces[f][k+1]; its neighbour holds the reverse edge
    let mut directed: HashMap<(usize, usize), EdgeRef> = HashMap::new();
    for (fi, f) in faces.iter().enumerate() {
        for (k, &v) in f.iter().enumerate() {
            directed.insert((v, f[(k + 1) % f.len()]), EdgeRef { face: fi, edge: k });
        }
    }
    let mut adj: Vec<Vec<EdgeRef>> = Vec::with_capacity(nf);
    for f in &faces {
        let mut row = Vec::with_capacity(f.len());
        for (k, &v) in f.iter().enumerate() {
            match directed.get(&(f[(k + 1) % f.len()], v)) {
                Some(r) => row.push(*r),
                None => return Err(format!("{name}: unglued edge")),
            }
        }
        adj.push(row);
    }
    let frames: Vec<Frame> = faces
        .iter()
        .map(|f| frame_of(&f.iter().map(|&v| vertices[v]).collect::<Vec<V3>>(), family == SolidFamily::Johnson))
        .collect();
    let mut regular: Vec<bool> = Vec::with_capacity(nf);
    for (fi, f) in faces.iter().enumerate() {
        if uniform {
            regular.push(true);
            continue;
        }
        if family == SolidFamily::Catalan {
            regular.push(false);
            continue;
        }
        // Archimedean and Johnson solids, prisms and antiprisms: every face is the regular polygon of its frame; check it
        let m = f.len();
        let flat = &frames[fi].flat;
        for k in 0..m {
            let (x, y) = frame_vertex(m, 1.0, k);
            if math::hypot(flat[2 * k] - x, flat[2 * k + 1] - y) > 1e-12 * face_circumradius(m, 1.0) {
                return Err(format!("{name}: face {fi} is not the regular {m}-gon of its frame"));
            }
        }
        regular.push(true);
    }
    let unit_faces: Vec<Vec<f64>> = faces
        .iter()
        .enumerate()
        .map(|(fi, f)| if regular[fi] { face_polygon(f.len(), 1.0) } else { frames[fi].flat.clone() })
        .collect();
    let corner: Vec<Vec<f64>> = faces
        .iter()
        .enumerate()
        .map(|(fi, f)| {
            if regular[fi] {
                f.iter().map(|_| ((f.len() as f64 - 2.0) * PI) / f.len() as f64).collect()
            } else {
                (0..f.len()).map(|k| corner_angle(&unit_faces[fi], k)).collect()
            }
        })
        .collect();
    let edge_angle: Vec<Vec<f64>> = faces
        .iter()
        .enumerate()
        .map(|(fi, f)| {
            (0..f.len())
                .map(|k| {
                    if regular[fi] {
                        return (2.0 * PI * (k as f64 + 1.0)) / f.len() as f64;
                    }
                    let u = &unit_faces[fi];
                    let j = (k + 1) % f.len();
                    math::atan2(u[2 * j + 1] - u[2 * k + 1], u[2 * j] - u[2 * k])
                })
                .collect()
        })
        .collect();
    let mut vertex_degree = vec![0usize; nv];
    let mut vertex_cone = vec![0.0f64; nv];
    for (fi, f) in faces.iter().enumerate() {
        for (k, &v) in f.iter().enumerate() {
            vertex_degree[v] += 1;
            vertex_cone[v] += corner[fi][k];
        }
    }
    let m = sides.iter().copied().max().unwrap_or(0);
    let degree = if vertex_degree.iter().all(|&d| d == vertex_degree[0]) { vertex_degree[0] as f64 } else { f64::NAN };
    let face_angle = if uniform { ((m as f64 - 2.0) * PI) / m as f64 } else { f64::NAN };
    let cone_angle = if uniform {
        degree * face_angle
    } else if vertex_cone.iter().all(|&c| (c - vertex_cone[0]).abs() < 1e-12) {
        vertex_cone[0]
    } else {
        f64::NAN
    };
    Ok(Solid {
        name: name.to_string(),
        family,
        title: if uniform { name.to_string() } else { data.unwrap().title.clone() },
        m,
        f: nf,
        v: nv,
        e,
        degree,
        face_angle,
        cone_angle,
        vertices,
        faces,
        adj,
        sides,
        uniform,
        regular,
        unit_faces,
        corner,
        edge_angle,
        vertex_degree,
        vertex_cone,
        frame_3d: frames.iter().map(|fr| Frame3D { o: fr.o, ex: fr.ex, ey: fr.ey }).collect(),
    })
}

/// `packages/surface/src/solids.ts: faceCircumradius`. Circumradius of the regular face polygon at edge s.
pub fn face_circumradius(m: usize, s: f64) -> f64 {
    s / (2.0 * math::sin(PI / m as f64))
}

/// `packages/surface/src/solids.ts: faceApothem`. Apothem of the regular face polygon at edge s.
pub fn face_apothem(m: usize, s: f64) -> f64 {
    s / (2.0 * math::tan(PI / m as f64))
}

/// `packages/surface/src/solids.ts: frameVertex`. Frame vertex k of a regular face at edge s
/// (angle -pi/2 + pi/M + 2 pi k / M). k is taken modulo M (every caller's k is at least 0).
pub fn frame_vertex(m: usize, s: f64, k: usize) -> (f64, f64) {
    let r = face_circumradius(m, s);
    let a = -PI / 2.0 + PI / m as f64 + (2.0 * PI * (k % m) as f64) / m as f64;
    (r * math::cos(a), r * math::sin(a))
}

/// `packages/surface/src/solids.ts: faceVertex`. Frame vertex k of face f of a solid at scale s
/// (any face; regular faces use `frame_vertex`).
pub fn face_vertex(solid: &Solid, s: f64, f: usize, k: usize) -> (f64, f64) {
    let m = solid.sides[f];
    if solid.regular[f] {
        return frame_vertex(m, s, k);
    }
    let u = &solid.unit_faces[f];
    let i = k % m;
    (s * u[2 * i], s * u[2 * i + 1])
}

/// `packages/surface/src/solids.ts: facePolygon`. Regular face polygon in its own frame as a flat
/// counter-clockwise array.
pub fn face_polygon(m: usize, s: f64) -> Vec<f64> {
    let mut out = vec![0.0; 2 * m];
    for k in 0..m {
        let (x, y) = frame_vertex(m, s, k);
        out[2 * k] = x;
        out[2 * k + 1] = y;
    }
    out
}

/// `packages/surface/src/solids.ts: faceArea`. Area of face f at scale 1.
pub fn face_area(solid: &Solid, f: usize) -> f64 {
    let u = &solid.unit_faces[f];
    let n = u.len() / 2;
    let mut a = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        a += u[2 * i] * u[2 * j + 1] - u[2 * j] * u[2 * i + 1];
    }
    a / 2.0
}

/// `packages/surface/src/solids.ts: surfaceArea`. Surface area of the solid at scale s.
pub fn surface_area(solid: &Solid, s: f64) -> f64 {
    if solid.uniform {
        return (solid.f as f64 * solid.m as f64 * s * s) / (4.0 * math::tan(PI / solid.m as f64));
    }
    let mut a = 0.0;
    for f in 0..solid.f {
        a += face_area(solid, f);
    }
    a * s * s
}

/// `packages/surface/src/solids.ts: faceDepth`. Signed distance of (x, y) inside face f (positive
/// inside), in that face's frame at scale s. On a regular face this is computed as
/// `insideFaceDepth` of validate.ts always was.
pub fn face_depth(solid: &Solid, s: f64, f: usize, x: f64, y: f64) -> f64 {
    let m = solid.sides[f];
    if solid.regular[f] {
        let ap = face_apothem(m, s);
        let mut worst = f64::INFINITY;
        for j in 0..m {
            // outward normal of edge j has angle 2 pi (j + 1) / M - pi / 2
            let a = (2.0 * PI * (j as f64 + 1.0)) / m as f64 - PI / 2.0;
            let d = ap - (x * math::cos(a) + y * math::sin(a));
            if d < worst {
                worst = d;
            }
        }
        return worst;
    }
    let u = &solid.unit_faces[f];
    let mut worst = f64::INFINITY;
    for j in 0..m {
        let k = (j + 1) % m;
        let ax = s * u[2 * j];
        let ay = s * u[2 * j + 1];
        let ex = s * u[2 * k] - ax;
        let ey = s * u[2 * k + 1] - ay;
        let d = (ex * (y - ay) - ey * (x - ax)) / math::hypot(ex, ey);
        if d < worst {
            worst = d;
        }
    }
    worst
}

/// `packages/surface/src/solids.ts: faceCornerRadius`. Largest distance from a point of face f to
/// the nearest corner of that face, at scale 1: every point of the face is within this distance of
/// one of its corners. The farthest point is a vertex of the corners' Voronoi diagram inside the
/// face or a point where a Voronoi edge meets the boundary, so the circumcentres of corner triples
/// and the meetings of corner bisectors with edges suffice.
pub fn face_corner_radius(solid: &Solid, f: usize) -> f64 {
    let u = &solid.unit_faces[f];
    let n = u.len() / 2;
    let p: Vec<(f64, f64)> = (0..n).map(|k| (u[2 * k], u[2 * k + 1])).collect();
    let near = |x: f64, y: f64| -> f64 { p.iter().fold(f64::INFINITY, |m, &(a, b)| math::min(m, math::hypot(x - a, y - b))) };
    let inside = |x: f64, y: f64| -> bool { face_depth(solid, 1.0, f, x, y) >= -1e-12 };
    let mut best = 0.0;
    for i in 0..n {
        for j in i + 1..n {
            for k in j + 1..n {
                let (ax, ay) = p[i];
                let (bx, by) = p[j];
                let (cx, cy) = p[k];
                let d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
                if d.abs() < 1e-15 {
                    continue;
                }
                let a2 = ax * ax + ay * ay;
                let b2 = bx * bx + by * by;
                let c2 = cx * cx + cy * cy;
                let x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
                let y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
                if inside(x, y) {
                    best = math::max(best, near(x, y));
                }
            }
        }
    }
    for i in 0..n {
        for j in i + 1..n {
            let mx = (p[i].0 + p[j].0) / 2.0;
            let my = (p[i].1 + p[j].1) / 2.0;
            let nx = p[j].0 - p[i].0;
            let ny = p[j].1 - p[i].1;
            for e in 0..n {
                let (ax, ay) = p[e];
                let (bx, by) = p[(e + 1) % n];
                // the point a + t (b - a) on the bisector n . (p - m) = 0
                let den = nx * (bx - ax) + ny * (by - ay);
                if den.abs() < 1e-15 {
                    continue;
                }
                let t = (nx * (mx - ax) + ny * (my - ay)) / den;
                if t < 0.0 || t > 1.0 {
                    continue;
                }
                best = math::max(best, near(ax + t * (bx - ax), ay + t * (by - ay)));
            }
        }
    }
    best
}
