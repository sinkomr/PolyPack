//! The canonical solids of the polyhedra family. Port of `packages/polyhedra/src/solids.ts`; the table
//! `solids.data.ts` is `data/solids.json`, written by `native/tools/polyhedra-solids.mts`.
//!
//! The 5 Platonic, 13 Archimedean and 13 Catalan solids, 5 prisms, 5 antiprisms and 15 elongated prisms of
//! upstream's catalogue (alejandrozu/platonic-packing, MIT, src/solids_exact.json; see THIRD_PARTY_NOTICES.md),
//! then PolyPack's prisms and antiprisms with 7, 9, 10 and 11 sides and their 12 elongated prisms, PolyPack's 9
//! bipyramids and 9 trapezohedra, and the 92 Johnson solids. Coordinates come from the exact ones, each rounded
//! to the nearest binary64.
//!
//! Conventions (upstream's, and for the bipyramids and trapezohedra upstream's Catalan one):
//!  - every solid is centred at the origin (its vertex centroid, which is interior);
//!  - Platonic and Archimedean solids, prisms and antiprisms have edges of length 1; elongated prisms have base
//!    edges 1 and lateral edges 1.5, 2 or 3; Catalan solids are the polar reciprocals of the unit-edge
//!    Archimedean solids about the midsphere (their edges are not 1); the n-bipyramids and n-trapezohedra are
//!    likewise the polar reciprocals of the unit-edge n-prisms and n-antiprisms about the midsphere;
//!  - faces are vertex cycles ordered counter-clockwise seen from outside; face f is the plane
//!    normals[f] . x = offsets[f] with a unit outward normal, and the solid is the intersection of the
//!    half-spaces normals[f] . x <= offsets[f].

use crate::catalogue::SolidFamily;
use polypack_js::math;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{LazyLock, OnceLock};

/// `solids.data.ts: SolidData`, one entry of the table as the tool wrote it.
#[derive(Deserialize)]
struct SolidData {
    name: String,
    code: String,
    family: String,
    title: String,
    #[serde(rename = "V")]
    v: Vec<[f64; 3]>,
    faces: Vec<Vec<usize>>,
    normals: Vec<[f64; 3]>,
    offsets: Vec<f64>,
    edges: Vec<[usize; 2]>,
    inradius: f64,
    circumradius: f64,
    volume: f64,
    tangential: bool,
}

/// `solids.ts: Solid`.
#[derive(Clone, Debug)]
pub struct Solid {
    /// Upstream's name, e.g. "truncated_tetrahedron", "prism3_l15".
    pub name: String,
    /// Upstream's three-to-five letter code, e.g. "tte", "pr3l15".
    pub code: String,
    pub family: SolidFamily,
    /// Plain name, e.g. "truncated tetrahedron", "triangular prism of height 1.5".
    pub title: String,
    /// Vertices, flat [x0, y0, z0, x1, ...].
    pub v: Vec<f64>,
    pub nv: usize,
    pub faces: Vec<Vec<usize>>,
    /// Unit outward face normals, flat [n0x, n0y, n0z, ...].
    pub n: Vec<f64>,
    /// Face offsets: face f is N_f . x = offsets[f].
    pub offsets: Vec<f64>,
    pub edges: Vec<[usize; 2]>,
    /// The two faces of each edge (same order as edges).
    pub edge_faces: Vec<[usize; 2]>,
    /// Smallest face offset: the radius of the largest ball about the centre inside the solid.
    pub inradius: f64,
    /// Largest vertex distance from the centre.
    pub circumradius: f64,
    pub volume: f64,
    /// True when every face is at the same distance from the centre (an insphere touches every face).
    pub tangential: bool,
    /// Longest edge.
    pub edge_max: f64,
}

/// `solids.data.ts: SOLID_DATA`, read once from the JSON the tool wrote.
static SOLID_DATA: LazyLock<Vec<SolidData>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/solids.json")).expect("data/solids.json is the tool's output")
});

/// `solids.ts: prepare`.
fn prepare(d: &SolidData) -> Result<Solid, String> {
    let nv = d.v.len();
    let mut v = vec![0.0f64; 3 * nv];
    for (i, p) in d.v.iter().enumerate() {
        v[3 * i..3 * i + 3].copy_from_slice(p);
    }
    let mut n = vec![0.0f64; 3 * d.faces.len()];
    for (f, p) in d.normals.iter().enumerate() {
        n[3 * f..3 * f + 3].copy_from_slice(p);
    }
    let key = |a: usize, b: usize| if a < b { a * 4096 + b } else { b * 4096 + a };
    let mut face_of: HashMap<usize, Vec<usize>> = HashMap::new();
    for (fi, f) in d.faces.iter().enumerate() {
        for (t, &a) in f.iter().enumerate() {
            let k = key(a, f[(t + 1) % f.len()]);
            face_of.entry(k).or_default().push(fi);
        }
    }
    let mut edge_faces = Vec::with_capacity(d.edges.len());
    for &[i, j] in &d.edges {
        match face_of.get(&key(i, j)) {
            Some(l) if l.len() == 2 => edge_faces.push([l[0], l[1]]),
            _ => return Err(format!("{}: edge {}-{} is not on two faces", d.name, i, j)),
        }
    }
    let mut edge_max = 0.0f64;
    for &[i, j] in &d.edges {
        edge_max = math::max(
            edge_max,
            math::hypot3(v[3 * j] - v[3 * i], v[3 * j + 1] - v[3 * i + 1], v[3 * j + 2] - v[3 * i + 2]),
        );
    }
    Ok(Solid {
        name: d.name.clone(),
        code: d.code.clone(),
        family: SolidFamily::parse(&d.family).ok_or_else(|| format!("{}: unknown family {}", d.name, d.family))?,
        title: d.title.clone(),
        v,
        nv,
        faces: d.faces.clone(),
        n,
        offsets: d.offsets.clone(),
        edges: d.edges.clone(),
        edge_faces,
        inradius: d.inradius,
        circumradius: d.circumradius,
        volume: d.volume,
        tangential: d.tangential,
        edge_max,
    })
}

/// `solids.ts: SOLIDS`, the prepared solids, one slot per entry of the table.
static SOLIDS: LazyLock<Vec<OnceLock<Result<Solid, String>>>> =
    LazyLock::new(|| SOLID_DATA.iter().map(|_| OnceLock::new()).collect());
/// The table's index of a name.
static INDEX_BY_NAME: LazyLock<HashMap<&'static str, usize>> =
    LazyLock::new(|| SOLID_DATA.iter().enumerate().map(|(i, d)| (d.name.as_str(), i)).collect());
/// `solids.ts: BY_CODE`.
static BY_CODE: LazyLock<HashMap<&'static str, &'static str>> =
    LazyLock::new(|| SOLID_DATA.iter().map(|d| (d.code.as_str(), d.name.as_str())).collect());

/// `solids.ts: SOLID_NAMES`: the name of every solid of the problems: upstream's 56 in upstream's order, then
/// PolyPack's 38, then the 92 Johnson solids in Johnson's order.
pub static SOLID_NAMES: LazyLock<Vec<String>> = LazyLock::new(|| {
    SOLID_DATA
        .iter()
        .filter(|d| d.family != "johnson")
        .chain(SOLID_DATA.iter().filter(|d| d.family == "johnson"))
        .map(|d| d.name.clone())
        .collect()
});

/// `solids.ts: JOHNSON_SOLID_NAMES`: the names of the 92 Johnson solids, J1 to J92 in Johnson's order.
pub static JOHNSON_SOLID_NAMES: LazyLock<Vec<String>> =
    LazyLock::new(|| SOLID_DATA.iter().filter(|d| d.family == "johnson").map(|d| d.name.clone()).collect());

/// `solids.ts: isSolidName`.
pub fn is_solid_name(v: &str) -> bool {
    SOLID_NAMES.iter().any(|n| n == v)
}

/// `solids.ts: getSolid`: the solid of a name, prepared once and cached. The source throws
/// `unknown solid <name>` for a name that is not in the table; that is the `Err` here.
pub fn get_solid(name: &str) -> Result<&'static Solid, String> {
    let Some(&i) = INDEX_BY_NAME.get(name) else {
        return Err(format!("unknown solid {name}"));
    };
    match SOLIDS[i].get_or_init(|| prepare(&SOLID_DATA[i])) {
        Ok(s) => Ok(s),
        Err(e) => Err(e.clone()),
    }
}

/// `solids.ts: solidNameOfCode`: the solid's name from its code ("tte" -> "truncated_tetrahedron"), or None.
pub fn solid_name_of_code(code: &str) -> Option<&'static str> {
    BY_CODE.get(code).copied()
}
