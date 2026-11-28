//! fresh-surface-fold: a from-scratch search for `surface/<solid>/fold/<N>/<P>`: P regular N-gons of
//! side 1 (N = 0: disks of diameter 1) on the surface of a convex solid, folding over its edges, in
//! the smallest scale s of the solid. See README.md for the method and native/FRESH.md for the
//! contract. The problem definitions (the solids, the domain's lower bound) come from
//! polypack-surface and the check from polypack-spaces; the search (geometry, objective, optimiser,
//! schedule) is this crate's own.

// Negated comparisons are deliberate: `!(a < b)` is true for NaN, which must count as failure.
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::needless_range_loop, clippy::too_many_arguments)]

pub mod fresh;
pub mod geo;
pub mod lbfgs;
pub mod model;
pub mod rng;
pub mod search;

use model::Pose;
use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};
use serde_json::{json, Value};

/// A problem this crate searches.
#[derive(Clone, Debug, PartialEq)]
pub struct Problem {
    pub id: String,
    pub solid: String,
    /// sides, 0 for disks
    pub n: usize,
    pub p: usize,
    /// the domain's lower bound on s (area or one piece)
    pub bound: f64,
}

/// The fields of `surface/<solid>/fold/<N>/<P>` when the shape is right (cheap: no solid is built).
pub fn parse_fields(id: &str) -> Option<(String, usize, usize)> {
    let parts: Vec<&str> = id.split('/').collect();
    if parts.len() != 5 || parts[0] != "surface" || parts[2] != "fold" {
        return None;
    }
    let n: usize = parts[3].parse().ok()?;
    let p: usize = parts[4].parse().ok()?;
    if !(n == 0 || (3..=100).contains(&n)) || !(1..=100).contains(&p) {
        return None;
    }
    if parts[3] != n.to_string() || parts[4] != p.to_string() {
        return None;
    }
    if !polypack_surface::is_solid_name(parts[1]) {
        return None;
    }
    Some((parts[1].to_string(), n, p))
}

impl Problem {
    /// Reads `surface/<solid>/fold/<N>/<P>`; None for anything else.
    pub fn parse(id: &str) -> Option<Problem> {
        let (solid, n, p) = parse_fields(id)?;
        polypack_spaces::parse_space_id(SpaceName::Surface, id).ok()?;
        let b = polypack_surface::domain_bound(&solid, "fold", n as f64, p as f64)?;
        if !(b.value.is_finite() && b.value > 0.0) {
            return None;
        }
        Some(Problem { id: id.to_string(), solid, n, p, bound: b.value })
    }
}

/// The server's check of a configuration (the client's rule, default options): Some(score) when valid.
pub fn check(id: &str, config: &Value) -> Option<f64> {
    let v = validate_space_submission(SpaceName::Surface, id, config, &SpaceValidateOptions::default());
    if v.valid {
        v.score
    } else {
        None
    }
}

/// The submission format of canonical poses at working scale `work` for the score `s`.
pub fn config_json(cfg: &[Pose], work: f64, s: f64) -> Value {
    let k = s / work;
    let pieces: Vec<Value> = cfg.iter().map(|q| json!({"face": q.f, "x": q.x * k, "y": q.y * k, "theta": q.t})).collect();
    json!({"s": s, "pieces": pieces})
}

/// Reads a submission-format configuration into poses at working scale `work`.
pub fn poses_of(config: &Value, work: f64) -> Option<(f64, Vec<Pose>)> {
    let s = config.get("s")?.as_f64()?;
    if !(s.is_finite() && s > 0.0) {
        return None;
    }
    let k = work / s;
    let list = config.get("pieces")?.as_array()?;
    let mut out = Vec::with_capacity(list.len());
    for p in list {
        let f = p.get("face")?.as_f64()?;
        if !(f >= 0.0 && f == f.trunc()) {
            return None;
        }
        out.push(Pose { f: f as u32, x: p.get("x")?.as_f64()? * k, y: p.get("y")?.as_f64()? * k, t: p.get("theta")?.as_f64()? });
    }
    Some((s, out))
}
