//! The problems of the surface family as a domain of parameter ranges (for packages/spaces'
//! SPACE_DOMAINS): surface/<solid>/<mode>/<N>/<P> for the 141 solids, fold and nofold, N = 0
//! (disks) or 3 to 100, and P = 1 to 100, as in 2D in 2D. Records exist only for the Platonic
//! solids with N in {0, 3, 4, 5, 6, 8} (data/surface/records.json); every other problem starts
//! without one. Port of `packages/surface/src/domain.ts`.
//!
//! Each problem's lower bound is the larger of two [CALC] bounds (docs/spaces/SURFACE.md 2.6),
//! which hold with and without folding:
//!  - area: P pieces of area a(N) fit on a surface of area s^2 A(1), so s >= sqrt(P a(N) / A(1));
//!  - one piece: a piece's inscribed disk (radius r = 1/2 for a disk of diameter 1, the apothem for
//!    a polygon) holds no vertex, and every point of a face f is within rho_f s of one of its
//!    corners (face_corner_radius), so s >= r / max_f rho_f.
//! On the Platonic solids these are the bounds the records carry, computed as the records were.

use crate::disk::{piece_area_of, SURFACE_DISK_RADIUS};
use crate::geometry::inradius;
use crate::solids::{all_solid_names, face_corner_radius, general_solid_data, get_solid, is_solid_name, surface_area, GeneralSolidData};
use polypack_js::math;
use polypack_js::math::PI;
use serde::ser::{SerializeMap, SerializeStruct};
use serde::{Serialize, Serializer};
use std::sync::OnceLock;

/// `packages/surface/src/domain.ts: SURFACE_MAX_N`.
pub const SURFACE_MAX_N: usize = 100;
/// `packages/surface/src/domain.ts: SURFACE_MAX_P`.
pub const SURFACE_MAX_P: usize = 100;

/// `packages/surface/src/domain.ts: SURFACE_NS`. The shape codes of the domain: disks, then 3 to 100 sides.
pub fn surface_ns() -> Vec<usize> {
    let mut out = vec![0];
    out.extend((0..SURFACE_MAX_N - 2).map(|k| k + 3));
    out
}

/// `packages/surface/src/domain.ts: pieceTitle`.
fn piece_title(n: usize) -> String {
    match n {
        0 => "disk".to_string(),
        3 => "triangle".to_string(),
        4 => "square".to_string(),
        5 => "pentagon".to_string(),
        6 => "hexagon".to_string(),
        7 => "heptagon".to_string(),
        8 => "octagon".to_string(),
        _ => format!("{n}-gon"),
    }
}

/// `packages/surface/src/domain.ts: FAMILY`.
fn family_title(family: &str) -> &'static str {
    match family {
        "platonic" => "Platonic solids",
        "archimedean" => "Archimedean",
        "catalan" => "Catalan solids",
        "prism" => "Prisms",
        "antiprism" => "Antiprisms",
        "johnson" => "Johnson solids",
        other => panic!("unknown family {other}"),
    }
}

/// `packages/surface/src/domain.ts: DATA.get`. Titles and families without building the solids.
fn data_of(name: &str) -> Option<&'static GeneralSolidData> {
    general_solid_data().iter().find(|d| d.name == name)
}

/// `packages/surface/src/domain.ts: capital`.
fn capital(t: &str) -> String {
    let mut chars = t.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// `packages/surface/src/domain.ts: titleOf`.
fn title_of(name: &str) -> String {
    capital(data_of(name).map_or(name, |d| d.title.as_str()))
}

/// `packages/surface/src/domain.ts: familyOf`.
fn family_of(name: &str) -> &'static str {
    family_title(data_of(name).map_or("platonic", |d| d.family.as_str()))
}

/// `packages/surface/src/domain.ts: maxCornerRadius`, kept per solid as the TypeScript's map does.
fn max_corner_radius(name: &str) -> f64 {
    static CACHE: OnceLock<Vec<OnceLock<f64>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| all_solid_names().iter().map(|_| OnceLock::new()).collect());
    let index = all_solid_names().iter().position(|n| n == name).expect("a solid of the list");
    *cache[index].get_or_init(|| {
        let solid = get_solid(name).expect("a solid of the list");
        let mut r = 0.0;
        for f in 0..solid.f {
            r = math::max(r, face_corner_radius(solid, f));
        }
        r
    })
}

/// `packages/surface/src/domain.ts: tanPi`. tan(pi / n) as the Platonic records' bounds were
/// computed (Python's math.tan, python/surface/tables.py). V8's Math.tan differs from it in the
/// last bit for n = 5, 6 and 8; with these values (`RECORD_TAN`) the bound below is the records'
/// bound.value to the last bit.
fn tan_pi(n: usize) -> f64 {
    match n {
        3 => 1.7320508075688767,
        4 => 0.9999999999999999,
        5 => 0.7265425280053609,
        6 => 0.5773502691896256,
        8 => 0.4142135623730951,
        _ => math::tan(PI / n as f64),
    }
}

/// What `surfaceBounds` returns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceBounds {
    pub area: f64,
    pub one: f64,
}

/// `packages/surface/src/domain.ts: surfaceBounds`. The two lower bounds of
/// surface/<solid>/<mode>/<N>/<P> on the scale s (see the head of this file). `solid` is a name of
/// the list (an unknown one is the `Err` of `get_solid`).
pub fn surface_bounds(solid: &str, n: usize, p: f64) -> Result<SurfaceBounds, String> {
    let sd = get_solid(solid)?;
    let area;
    let one;
    if sd.uniform {
        // the Platonic solids, with the records' float operations (tables.py bounds): area F M s^2 / (4 tan(pi/M)),
        // and every point of a face within its circumradius s / (2 sin(pi/M)) of a corner
        let m = sd.m;
        let a = if n == 0 { PI / 4.0 } else { n as f64 / (4.0 * tan_pi(n)) }; // a disk of diameter 1: pi / 4
        area = ((p * a * 4.0 * tan_pi(m)) / (sd.f as f64 * m as f64)).sqrt();
        one = 2.0 * math::sin(PI / m as f64) * (if n == 0 { SURFACE_DISK_RADIUS } else { 1.0 / (2.0 * tan_pi(n)) });
    } else {
        area = ((p * piece_area_of(n)) / surface_area(sd, 1.0)).sqrt();
        one = (if n == 0 { SURFACE_DISK_RADIUS } else { inradius(n) }) / max_corner_radius(solid);
    }
    Ok(SurfaceBounds { area, one })
}

/// What `surfaceBound` returns: the bound and its kind, "area" or "one piece".
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceBound {
    pub value: f64,
    pub kind: &'static str,
}

/// `packages/surface/src/domain.ts: surfaceBound`. The lower bound of
/// surface/<solid>/<mode>/<N>/<P> on the scale s, with its kind.
pub fn surface_bound(solid: &str, n: usize, p: f64) -> Result<SurfaceBound, String> {
    let b = surface_bounds(solid, n, p)?;
    Ok(if b.area >= b.one { SurfaceBound { value: b.area, kind: "area" } } else { SurfaceBound { value: b.one, kind: "one piece" } })
}

/// `Number.isInteger`.
fn is_integer(x: f64) -> bool {
    x.is_finite() && x == x.trunc()
}

/// `packages/surface/src/domain.ts: inDomain`. True when the fields name a problem of the domain.
/// (The TypeScript also asks that solid and mode are strings and N and P numbers, which the types
/// say here.)
pub fn in_domain(solid: &str, mode: &str, n: f64, p: f64) -> bool {
    is_solid_name(solid)
        && (mode == "fold" || mode == "nofold")
        && (n == 0.0 || (is_integer(n) && n >= 3.0 && n <= SURFACE_MAX_N as f64))
        && is_integer(p)
        && p >= 1.0
        && p <= SURFACE_MAX_P as f64
}

/// A lower bound as a domain gives it: `{value, label}`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DomainBound {
    pub value: f64,
    pub label: String,
}

/// `packages/surface/src/domain.ts: surfaceDomain.bound`. The lower bound of the problem with the
/// id's fields `solid`, `mode`, `N` and its `P`, or None (the TypeScript's `undefined`) when they
/// name no problem of the domain.
pub fn domain_bound(solid: &str, mode: &str, n: f64, p: f64) -> Option<DomainBound> {
    if !in_domain(solid, mode, n, p) {
        return None;
    }
    let b = surface_bound(solid, n as usize, p).expect("a solid of the list");
    Some(DomainBound { value: b.value, label: format!("{} bound; [CALC]", b.kind) })
}

/// `packages/surface/src/domain.ts: surfaceDomain.sample`. At most `limit` ids of the domain in a
/// fixed order (the order of the volunteers' work list until it was removed on 2026-10-29):
/// problems without a record, small P first from P = 2 (P = 1 left out): the folding ones, and the
/// Catalan nofold ones (the other nofold problems are 2D in 2D problems); within a P the shapes of
/// the records' tables (0, 3, 4, 5, 6, 8) first, then the other N, the solids in catalogue order.
pub fn domain_sample(limit: usize) -> Vec<String> {
    let first: [usize; 6] = [0, 3, 4, 5, 6, 8];
    let mut order: Vec<usize> = first.to_vec();
    order.extend(surface_ns().into_iter().filter(|n| !first.contains(n)));
    let mut out: Vec<String> = Vec::new();
    let mut p = 2;
    while p <= SURFACE_MAX_P && out.len() < limit {
        for &n in &order {
            for solid in all_solid_names() {
                if out.len() >= limit {
                    return out;
                }
                let data = data_of(solid);
                // the Platonic records' table: fold P <= 24 for these shapes
                if data.is_some() || !first.contains(&n) || p > 24 {
                    out.push(format!("surface/{solid}/fold/{n}/{p}"));
                }
                // a Catalan nofold problem has an irregular face, which no 2D in 2D problem covers
                if data.map_or(false, |d| d.family == "catalan") && out.len() < limit {
                    out.push(format!("surface/{solid}/nofold/{n}/{p}"));
                }
            }
        }
        p += 1;
    }
    out
}

/// An object of strings by string keys, written in the order of the list (as JSON.stringify writes
/// an object whose keys were set in that order).
#[derive(Clone, Debug, PartialEq)]
pub struct Titles(pub Vec<(String, String)>);

impl Serialize for Titles {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// One field of the domain's ids (`SpaceDomainField` of packages/spaces/src/domain.ts): the values
/// it takes, or a range of integers. A field that is None is left out of the JSON, as JSON.stringify
/// leaves out a key that is not set.
#[derive(Clone, Debug, PartialEq)]
pub struct DomainField {
    pub key: String,
    pub label: String,
    pub values: Option<Vec<String>>,
    pub titles: Option<Titles>,
    pub groups: Option<Titles>,
    pub min: Option<usize>,
    pub max: Option<usize>,
}

impl Serialize for DomainField {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut st = serializer.serialize_struct("DomainField", 7)?;
        st.serialize_field("key", &self.key)?;
        st.serialize_field("label", &self.label)?;
        if let Some(v) = &self.values {
            st.serialize_field("values", v)?;
        }
        if let Some(v) = &self.titles {
            st.serialize_field("titles", v)?;
        }
        if let Some(v) = &self.groups {
            st.serialize_field("groups", v)?;
        }
        if let Some(v) = &self.min {
            st.serialize_field("min", v)?;
        }
        if let Some(v) = &self.max {
            st.serialize_field("max", v)?;
        }
        st.end()
    }
}

/// What /api/spaces says about the domain (`SpaceDomainInfo` of packages/spaces/src/domain.ts).
/// Its JSON (`serde_json::to_string`) is JSON.stringify(surfaceDomain.info) byte for byte.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DomainInfo {
    pub id: String,
    pub fields: Vec<DomainField>,
    pub problems: usize,
}

/// `packages/surface/src/domain.ts: surfaceDomain.info`.
pub fn domain_info() -> DomainInfo {
    let names = all_solid_names();
    let ns = surface_ns();
    let pair = |k: &str, v: &str| (k.to_string(), v.to_string());
    DomainInfo {
        id: "surface/<solid>/<mode>/<N>/<P>".to_string(),
        fields: vec![
            DomainField {
                key: "solid".to_string(),
                label: "Solid".to_string(),
                values: Some(names.to_vec()),
                titles: Some(Titles(names.iter().map(|n| (n.clone(), title_of(n))).collect())),
                // The family of each solid, for grouping a menu (Platonic, Archimedean, Catalan, prisms, antiprisms).
                groups: Some(Titles(names.iter().map(|n| (n.clone(), family_of(n).to_string())).collect())),
                min: None,
                max: None,
            },
            DomainField {
                key: "mode".to_string(),
                label: "Folding".to_string(),
                values: Some(vec!["fold".to_string(), "nofold".to_string()]),
                titles: Some(Titles(vec![pair("fold", "Fold over edges"), pair("nofold", "No fold")])),
                groups: None,
                min: None,
                max: None,
            },
            DomainField {
                key: "N".to_string(),
                label: "Piece (N)".to_string(),
                values: Some(ns.iter().map(|n| n.to_string()).collect()),
                // the keys are whole numbers in ascending order, which is also the order JavaScript lists them in
                titles: Some(Titles(ns.iter().map(|&n| (n.to_string(), format!("{} (N = {})", capital(&piece_title(n)), n))).collect())),
                groups: None,
                min: None,
                max: None,
            },
            DomainField {
                key: "P".to_string(),
                label: "Pieces (P)".to_string(),
                values: None,
                titles: None,
                groups: None,
                min: Some(1),
                max: Some(SURFACE_MAX_P),
            },
        ],
        problems: names.len() * 2 * ns.len() * SURFACE_MAX_P,
    }
}
