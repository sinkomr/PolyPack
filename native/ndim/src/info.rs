//! The facts of the 34 catalogue polytopes (packages/ndim/src/data/info.ts), read from
//! `data/info.json`, which native/tools/ndim-tables.mts writes from that module.
use serde::Deserialize;
use std::sync::OnceLock;

/// packages/ndim/src/polytope.ts: PolytopeInfo. Facts about a polytope that do not need its
/// coordinates.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PolytopeInfo {
    pub code: String,
    pub d: usize,
    pub name: String,
    pub title: String,
    /// Vertices, edges and facets (the literature's counts, proved by the generator).
    #[serde(rename = "nV")]
    pub n_v: usize,
    #[serde(rename = "nE")]
    pub n_e: usize,
    #[serde(rename = "nF")]
    pub n_f: usize,
    /// Radius of the largest ball centred at the origin inside it: the smallest facet offset.
    pub inradius: f64,
    /// Largest distance of a vertex from the origin.
    pub circumradius: f64,
    /// d-dimensional volume of the unit-edge polytope.
    pub volume: f64,
}

/// packages/ndim/src/data/info.ts: INFO, in the file's order (by dimension, then by code).
pub fn polytope_info_table() -> &'static [PolytopeInfo] {
    static INFO: OnceLock<Vec<PolytopeInfo>> = OnceLock::new();
    INFO.get_or_init(|| serde_json::from_str(include_str!("../data/info.json")).expect("data/info.json is the tool's output"))
}

/// The entry of a code (the lookups of POLYTOPE_INFO and ND_INFO, both `new Map(INFO.map(...))`).
pub fn info_of(code: &str) -> Option<&'static PolytopeInfo> {
    polytope_info_table().iter().find(|i| i.code == code)
}
