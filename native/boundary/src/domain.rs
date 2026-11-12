//! The domain of the boundary space for the spaces listing (packages/spaces domain.ts): balls on
//! all six regular 4-polytopes (P = 1 to 24 on the five added 2026-11-01, 1 to 16 on the tesseract)
//! and the tesseract's axis-aligned cubes (P = 1 to 16); the five Platonic solids, freely rotated,
//! on all six (the cube on the tesseract being the aligned one), same ranges; the d-cubes; and the
//! simplex, orthoplex and demicube. The tesseract's 32 problems have research records; the others
//! have none, only their lower bounds. Port of packages/boundary/src/domain.ts.

use crate::bounds::{ball_bounds, container_max_p, container_pieces, piece_bounds};
use crate::kernel_validate::boundary_bound;
use crate::ncube::bounds::{ncube_problem_bound, ncube_title};
use crate::ncube::lattice::{is_ncube_name, NCUBE_NAMES};
use crate::nd::bounds::{nd_bound_kind, nd_problem_bound};
use crate::nd::names::{is_nd_name, nd_parse, nd_title, ND_NAMES};
use crate::types::{CONTAINERS, PIECES};
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};

/// An object whose keys keep the order they were inserted in, as a JavaScript object does
/// (serde_json's own map sorts its keys unless a feature is switched on for the whole workspace).
#[derive(Clone, Debug, PartialEq)]
pub struct Ordered<V>(pub Vec<(String, V)>);

impl<V: Serialize> Serialize for Ordered<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// packages/boundary/src/domain.ts: TITLES (in the source's key order: the d-cubes, the nD containers, the 4-polytopes)
fn titles() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for n in NCUBE_NAMES {
        out.push((n.to_string(), ncube_title(n).expect("a d-cube").to_string()));
    }
    for n in ND_NAMES {
        out.push((n.to_string(), nd_title(n).expect("an nD container")));
    }
    for (n, t) in [("tesseract", "Tesseract"), ("5cell", "5-cell"), ("16cell", "16-cell"), ("24cell", "24-cell"), ("120cell", "120-cell"), ("600cell", "600-cell")] {
        out.push((n.to_string(), t.to_string()));
    }
    out
}

/// The most pieces of any container (the P field's overall range).
/// packages/boundary/src/domain.ts: BOUNDARY_DOMAIN_MAX_P
pub fn boundary_domain_max_p() -> usize {
    CONTAINERS.iter().map(|n| container_max_p(n).expect("a container")).max().expect("containers")
}

/// Number of problems of the domain.
/// packages/boundary/src/domain.ts: BOUNDARY_PROBLEM_COUNT
pub fn boundary_problem_count() -> usize {
    CONTAINERS.iter().map(|p| container_pieces(p).expect("a container").len() * container_max_p(p).expect("a container")).sum()
}

/// A lower bound as the listing shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BoundEntry {
    pub value: f64,
    pub label: String,
}

/// The bound of a problem of the domain as the listing shows it.
/// packages/boundary/src/domain.ts: boundEntry
fn bound_entry(polytope: &str, piece: &str, p: f64) -> Option<BoundEntry> {
    if is_ncube_name(polytope) {
        let value = ncube_problem_bound(polytope, piece, p).ok()?;
        return Some(if piece == "ball" {
            BoundEntry {
                value,
                label: "[CALC] larger of the volume bound (P balls of diameter 1 have at most the (d-1)-volume 2d s^(d-1) of the boundary) and one ball (1/sqrt 2: the centre is 1/2 from every (d-3)-face, and no point is farther than s/sqrt 2)".to_string(),
            }
        } else {
            BoundEntry { value, label: "[CALC] larger of the volume bound (P <= 2d s^(d-1)) and one cube (1: with s < 1 it crosses every axis of its cell)".to_string() }
        });
    }
    if is_nd_name(polytope) {
        let (family, d) = nd_parse(polytope)?;
        return Some(BoundEntry {
            value: nd_problem_bound(polytope, p).ok()?,
            label: if nd_bound_kind(family, d, p) == "volume" {
                "[CALC] volume: the P balls of radius 1/2 are Euclidean balls (the centre is 1/2 from the hinges) with disjoint interiors, so P V_(d-1) 2^-(d-1) <= s^(d-1) times the boundary's (d-1)-volume at unit edge".to_string()
            } else {
                "[CALC] one ball: its centre must be 1/2 from every (d-3)-face, and every point of a cell lies within rho of a (d-3)-face of the cell, rho the largest distance from the cell's centre to one".to_string()
            },
        });
    }
    // the Platonic solids, turned (the tesseract's cube is the aligned one of its records, below): the volume and one-piece bounds of 4C.4
    if piece != "ball" && !(piece == "cube" && polytope == "tesseract") {
        let b = piece_bounds(polytope, piece, p)?;
        return Some(BoundEntry {
            value: b.value,
            label: if b.kind == "volume" {
                format!("[CALC] volume: the developed {piece}s have disjoint interiors, so P V <= V_boundary s^3, V the piece's volume")
            } else {
                "[CALC] one piece: it contains its inscribed ball, whose centre must be at distance >= the inradius from the edges, and every point of a cell lies within s rho of the cell's edges, rho the distance from a cell's centre to them".to_string()
            },
        });
    }
    if polytope == "tesseract" {
        let value = boundary_bound(piece, p);
        return Some(if piece == "ball" {
            BoundEntry { value, label: "[CALC] larger of the volume bound (P pi/6 <= 8 s^3) and one ball (1/sqrt 2: the centre is 1/2 from every edge)".to_string() }
        } else {
            BoundEntry { value, label: "[CALC] larger of the volume bound (P <= 8 s^3) and one cube (1/sqrt 2)".to_string() }
        });
    }
    let b = ball_bounds(polytope, p)?;
    Some(BoundEntry {
        value: b.value,
        label: if b.kind == "volume" {
            "[CALC] volume: the developed balls have disjoint interiors, so P pi/6 <= V s^3, V the volume of the boundary at unit edge".to_string()
        } else {
            "[CALC] one ball: its centre must be at distance >= 1/2 from the edges, and every point of a cell lies within s rho of the cell's edges, rho the distance from a cell's centre to them".to_string()
        },
    })
}

/// A field of the problem id, as the listing describes it (boundaryDomain.info.fields).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DomainField {
    pub key: &'static str,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub titles: Option<Ordered<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependent: Option<Dependent>,
}

/// A field whose values or range depend on another field.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Dependent {
    pub on: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Ordered<Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranges: Option<Ordered<[usize; 2]>>,
}

/// packages/boundary/src/domain.ts: boundaryDomain.info. Serialized with serde_json it is the
/// text of JSON.stringify(boundaryDomain.info).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DomainInfo {
    pub id: &'static str,
    pub fields: Vec<DomainField>,
    pub problems: usize,
}

/// packages/boundary/src/domain.ts: boundaryDomain.info
pub fn boundary_domain_info() -> DomainInfo {
    let strings = |list: &[&str]| -> Vec<String> { list.iter().map(|s| s.to_string()).collect() };
    DomainInfo {
        id: "boundary/<polytope>/<piece>/<P>",
        fields: vec![
            DomainField { key: "polytope", label: "Polytope", values: Some(strings(&CONTAINERS)), titles: Some(Ordered(titles())), min: None, max: None, dependent: None },
            DomainField {
                key: "piece",
                label: "Piece",
                values: Some(strings(&PIECES)),
                titles: Some(Ordered(
                    [("ball", "Balls"), ("cube", "Cubes"), ("tetrahedron", "Tetrahedra"), ("octahedron", "Octahedra"), ("dodecahedron", "Dodecahedra"), ("icosahedron", "Icosahedra")]
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect(),
                )),
                min: None,
                max: None,
                // a field whose values depend on the polytope: balls and the Platonic solids on the 4-polytopes (the tesseract's cube is the aligned one, the others' a rotated one), balls and aligned cubes on the d-cubes
                dependent: Some(Dependent { on: "polytope", values: Some(Ordered(CONTAINERS.iter().map(|n| (n.to_string(), strings(container_pieces(n).expect("a container")))).collect())), ranges: None }),
            },
            DomainField {
                key: "P",
                label: "Pieces (P)",
                values: None,
                titles: None,
                min: Some(1),
                max: Some(boundary_domain_max_p()),
                dependent: Some(Dependent { on: "polytope", values: None, ranges: Some(Ordered(CONTAINERS.iter().map(|n| (n.to_string(), [1, container_max_p(n).expect("a container")])).collect())) }),
            },
        ],
        problems: boundary_problem_count(),
    }
}

/// The lower bound of a problem of the domain, or None when the id is outside the domain (the
/// source's `undefined`). `p` is a JavaScript number in the source.
/// packages/boundary/src/domain.ts: boundaryDomain.bound
pub fn boundary_domain_bound(polytope: &str, piece: &str, p: f64) -> Option<BoundEntry> {
    if !CONTAINERS.contains(&polytope) || !PIECES.contains(&piece) || !container_pieces(polytope)?.contains(&piece) {
        return None;
    }
    if !(p.is_finite() && p == p.trunc()) || p < 1.0 || p > container_max_p(polytope)? as f64 {
        return None;
    }
    bound_entry(polytope, piece, p)
}

/// Small P first: P = 1, 2, ... over the containers and pieces (the volunteers' removed work list drew in this order).
/// packages/boundary/src/domain.ts: boundaryDomain.sample
pub fn boundary_domain_sample(limit: f64) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in 1..=boundary_domain_max_p() {
        for n in CONTAINERS {
            for piece in container_pieces(n).expect("a container") {
                if p > container_max_p(n).expect("a container") {
                    continue;
                }
                if out.len() as f64 >= limit {
                    return out;
                }
                out.push(format!("boundary/{n}/{piece}/{p}"));
            }
        }
    }
    out
}
