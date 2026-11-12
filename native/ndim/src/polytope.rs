//! The catalogue of convex polytopes of dimension 4 to 10 (packages/ndim/src/polytope.ts,
//! docs/spaces/NDIM.md §2), as floats.
//!
//! Every polytope has unit edge and is centred at its vertex centroid, which is the origin. Codes
//! are "<d>:<name>": simplex, cube (hypercube), ortho (orthoplex), demi (demicube, d >= 5), 24cell,
//! 120cell, 600cell (d = 4), 221 and 122 (d = 6), 321 (d = 7), 421 (d = 8).
//!
//! The simplex, hypercube, orthoplex and demicube of every dimension are computed from formulas
//! (generate.rs) when first used. The others are loaded on demand, as in the source, where they are
//! modules imported dynamically: `load_polytope(code)` once (the tables of the 24-, 120- and
//! 600-cell, 2_21, 1_22 and 3_21 from `data/d4.json`, `d6.json`, `d7.json`, which
//! native/tools/ndim-tables.mts writes; 8:421 from its formula, about 0.1 s); `get_polytope` then
//! returns it, and fails with the source's message until then.
use crate::generate::{generate_polytope, split_code, Data};
use crate::info::{info_of, polytope_info_table, PolytopeInfo};
use crate::{json_string, Thrown};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// packages/ndim/src/polytope.ts: Polytope. The facts of an entry with its coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct Polytope {
    pub code: String,
    pub d: usize,
    pub name: String,
    pub title: String,
    pub n_v: usize,
    pub n_e: usize,
    pub n_f: usize,
    pub inradius: f64,
    pub circumradius: f64,
    pub volume: f64,
    /// Vertices, row-major nV x d.
    pub v: Vec<f64>,
    /// Unit outward facet normals, row-major nF x d: x in the polytope iff N_f . x <= b_f for all f.
    pub n: Vec<f64>,
    /// Facet offsets b_f > 0.
    pub b: Vec<f64>,
}

/// packages/ndim/src/polytope.ts: PolytopeData, as the table files hold it.
#[derive(Deserialize)]
struct TableEntry {
    code: String,
    #[serde(rename = "V")]
    v: Vec<f64>,
    #[serde(rename = "N")]
    n: Vec<f64>,
    b: Vec<f64>,
}

/// packages/ndim/src/polytope.ts: POLYTOPE_CODES. All catalogue codes, by dimension and then name.
pub fn polytope_codes() -> Vec<&'static str> {
    polytope_info_table().iter().map(|i| i.code.as_str()).collect()
}

/// The module's `cache` of the polytopes built so far (one for the process, as the module's).
fn cache() -> &'static Mutex<HashMap<String, Arc<Polytope>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Polytope>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached(code: &str) -> Option<Arc<Polytope>> {
    cache().lock().unwrap_or_else(|e| e.into_inner()).get(code).cloned()
}

/// packages/ndim/src/polytope.ts: build.
fn build(code: &str, data: Data) -> Result<Arc<Polytope>, Thrown> {
    let Some(info) = info_of(code) else {
        return Err(Thrown(format!("no catalogue entry {code}")));
    };
    let p = Polytope {
        code: info.code.clone(),
        d: info.d,
        name: info.name.clone(),
        title: info.title.clone(),
        n_v: info.n_v,
        n_e: info.n_e,
        n_f: info.n_f,
        inradius: info.inradius,
        circumradius: info.circumradius,
        volume: info.volume,
        v: data.v,
        n: data.n,
        b: data.b,
    };
    if p.v.len() != p.n_v * p.d || p.n.len() != p.n_f * p.d || p.b.len() != p.n_f {
        return Err(Thrown(format!("{code}: data does not match its counts")));
    }
    let p = Arc::new(p);
    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(code.to_string(), p.clone());
    Ok(p)
}

/// packages/ndim/src/polytope.ts: generatable (`/^\d+:(simplex|cube|ortho|demi)$/`).
fn generatable(code: &str) -> bool {
    split_code(code, &["simplex", "cube", "ortho", "demi"]).is_some()
}

/// packages/ndim/src/polytope.ts: LAZY_CODES. Entries whose tables are loaded with load_polytope.
pub fn lazy_codes() -> Vec<&'static str> {
    polytope_codes().into_iter().filter(|c| !generatable(c)).collect()
}

/// packages/ndim/src/polytope.ts: polytopeInfo. The facts about a code; an error for an unknown one.
pub fn polytope_info(code: &str) -> Result<&'static PolytopeInfo, Thrown> {
    info_of(code).ok_or_else(|| Thrown(format!("unknown polytope code {}", json_string(code))))
}

/// packages/ndim/src/polytope.ts: isLoaded. Whether get_polytope(code) works now (the code exists
/// and, for the lazy ones, has been loaded).
pub fn is_loaded(code: &str) -> bool {
    cached(code).is_some() || (info_of(code).is_some() && generatable(code))
}

/// packages/ndim/src/polytope.ts: getPolytope. The polytope with its coordinates and facets. An
/// error for an unknown code, and for a lazy one that is not loaded yet.
pub fn get_polytope(code: &str) -> Result<Arc<Polytope>, Thrown> {
    if let Some(hit) = cached(code) {
        return Ok(hit);
    }
    polytope_info(code)?;
    if generatable(code) {
        // `generatePolytope(code)!`: a catalogue code of these families always has a formula
        let data = generate_polytope(code)?.ok_or_else(|| Thrown(format!("no data for {code}")))?;
        return build(code, data);
    }
    Err(Thrown(format!("{code} is loaded on demand: await loadPolytope({}) first", json_string(code))))
}

/// packages/ndim/src/polytope.ts: loadPolytope. Loads a polytope (the tables of the lazy ones from
/// their file, 8:421 from its formula) and returns it. A plain function here: the source's is
/// asynchronous only because its tables are modules imported on demand.
pub fn load_polytope(code: &str) -> Result<Arc<Polytope>, Thrown> {
    if is_loaded(code) {
        return get_polytope(code);
    }
    let info = polytope_info(code)?;
    if code == "8:421" {
        let data = generate_polytope(code)?.ok_or_else(|| Thrown(format!("no data for {code}")))?;
        return build(code, data);
    }
    let text = match info.d {
        4 => include_str!("../data/d4.json"),
        6 => include_str!("../data/d6.json"),
        7 => include_str!("../data/d7.json"),
        _ => return Err(Thrown(format!("no data for {code}"))),
    };
    let table: Vec<TableEntry> = serde_json::from_str(text).expect("the data files are the tool's output");
    let Some(data) = table.into_iter().find(|e| e.code == code) else {
        return Err(Thrown(format!("no data for {code}")));
    };
    build(code, Data { v: data.v, n: data.n, b: data.b })
}

/// packages/ndim/src/polytope.ts: polytopesOfDimension. Codes of the catalogue in dimension d.
pub fn polytopes_of_dimension(d: usize) -> Vec<&'static str> {
    polytope_info_table().iter().filter(|i| i.d == d).map(|i| i.code.as_str()).collect()
}
