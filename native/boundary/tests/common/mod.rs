//! What the comparison with the TypeScript runs, shared by the example `boundarydiff` (which writes the Rust side of
//! native/tools/boundary-compare.mjs) and by the tests on the fixtures: a case of the validator as the server checks it, and
//! a call of one of the other functions the server uses.
#![allow(dead_code)]

use polypack_boundary::bounds::{ball_bounds, boundary_check_ms, boundary_is_heavy, container_max_p, container_pieces, piece_bounds};
use polypack_boundary::domain::{boundary_domain_bound, boundary_domain_info, boundary_domain_sample};
use polypack_boundary::ids::{parse_boundary_id, MAX_P};
use polypack_boundary::kernel_validate::boundary_bound;
use polypack_boundary::ncube::bounds::ncube_bound;
use polypack_boundary::nd::bounds::{nd_bound, nd_bound_kind};
use polypack_boundary::nd::names::{high_dim_shape, is_nd_name, nd_parse};
use polypack_boundary::ncube::validate::validate_ncube;
use polypack_boundary::nd::validate::{validate_nd_stats, NdStats};
use polypack_boundary::pieces::{build_piece_shape, piece_shape, PieceShape};
use polypack_boundary::polytope::{build_catalogue_polytope, get_polytope, Polytope};
use polypack_boundary::types::{BoundaryProblem, BoundaryVerdict, CONTAINERS, PIECES, POLYTOPES};
use polypack_boundary::validate::{validate_boundary, BoundaryError, ValidateOptions, MAX_S};
use serde_json::{json, Value};

/// A case of the comparison: a problem, a configuration (any JSON) and the limits of the check.
pub struct Case {
    pub id: u64,
    pub problem: BoundaryProblem,
    pub config: Value,
    pub opts: ValidateOptions,
    pub tols: Vec<f64>,
    /// "ncube" or "nd": the d-cube or the nD validator called directly, not through validate_boundary.
    pub via: Option<String>,
}

pub fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s == "NaN" => Some(f64::NAN),
        Value::String(s) if s == "Infinity" => Some(f64::INFINITY),
        Value::String(s) if s == "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

pub fn read_case(v: &Value) -> Case {
    let p = &v["problem"];
    let problem = BoundaryProblem { polytope: p["polytope"].as_str().unwrap().to_string(), piece: p["piece"].as_str().unwrap().to_string(), p: number(&p["P"]).unwrap() };
    let o = &v["opts"];
    let opts = ValidateOptions {
        tol: None,
        max_chains: Some(number(&o["maxChains"]).unwrap_or(1024.0)),
        max_reasons: Some(number(&o["maxReasons"]).unwrap_or(20.0)),
        max_pairs: number(&o["maxPairs"]),
        max_work: number(&o["maxWork"]),
        max_ops: number(&o["maxOps"]),
        turned_cubes: false,
    };
    let tols = match v.get("tol") {
        Some(t) => vec![number(t).unwrap()],
        None => vec![1e-9, 1e-11],
    };
    Case { id: v["id"].as_u64().unwrap(), problem, config: v["config"].clone(), opts, tols, via: v["via"].as_str().map(|s| s.to_string()) }
}

/// A double as the reference writes it: JSON has no NaN or Infinity, so those are text.
pub fn num_json(x: f64) -> Value {
    if x.is_finite() {
        json!(x)
    } else if x.is_nan() {
        json!("NaN")
    } else if x > 0.0 {
        json!("Infinity")
    } else {
        json!("-Infinity")
    }
}

/// What one check gave: a verdict (with the nD engine's work) or the source's thrown error.
pub enum Outcome {
    Verdict(BoundaryVerdict, Option<NdStats>),
    Throw(String),
}

/// One check, as the server runs it.
pub fn check(c: &Case, tol: f64) -> Outcome {
    let opts = ValidateOptions { tol: Some(tol), ..c.opts };
    if c.via.as_deref() == Some("nd") || (c.via.is_none() && is_nd_name(&c.problem.polytope)) {
        // (validate_boundary hands every nD problem to validate_nd; called here for the work it reports)
        let (v, stats) = validate_nd_stats(&c.problem, &c.config, &opts);
        return Outcome::Verdict(v, Some(stats));
    }
    let result = if c.via.as_deref() == Some("ncube") { validate_ncube(&c.problem, &c.config, &opts) } else { validate_boundary(&c.problem, &c.config, &opts) };
    match result {
        Ok(v) => Outcome::Verdict(v, None),
        Err(BoundaryError::Range(m)) => Outcome::Throw(format!("RangeError: {m}")),
        Err(BoundaryError::Error(m)) => Outcome::Throw(format!("Error: {m}")),
    }
}

pub fn outcome_json(tol: f64, o: &Outcome) -> Value {
    match o {
        Outcome::Verdict(v, None) => json!({ "tol": num_json(tol), "ok": v.ok, "score": v.score, "reasons": v.reasons }),
        Outcome::Verdict(v, Some(stats)) => json!({ "tol": num_json(tol), "ok": v.ok, "score": v.score, "reasons": v.reasons, "steps": stats.steps, "ops": stats.ops }),
        Outcome::Throw(m) => json!({ "tol": num_json(tol), "throw": m }),
    }
}

pub fn polytope_json(p: &Polytope) -> Value {
    json!({
        "name": p.name, "d": p.d, "vertices": p.vertices,
        "cells": p.cells.iter().enumerate().map(|(i, c)| json!({
            "index": c.index, "normal": c.normal, "origin": c.origin, "frame": c.frame, "vertices": c.vertices, "hinges": c.hinges,
            "facets": c.facets, "vertexIds": c.vertex_ids, "hingeDihedral": p.topo.cells[i].hinge_dihedral,
        })).collect::<Vec<_>>(),
        "hingeAngle": p.hinge_angle, "edges": p.edges, "edgeAngles": p.edge_angles,
    })
}

pub fn piece_json(s: &PieceShape) -> Value {
    json!({
        "name": s.name, "vertices": s.vertices, "faces": s.faces, "normals": s.normals, "inradius": s.inradius, "circumradius": s.circumradius,
        "midradius": s.midradius, "volume": s.volume, "mirror": s.mirror, "edges": s.edges, "edgeDirs": s.edge_dirs,
    })
}

pub fn bounds_json(b: Option<polypack_boundary::bounds::PieceBounds>) -> Value {
    match b {
        Some(b) => json!({ "volume": b.volume, "onePiece": b.one_piece, "value": b.value, "kind": b.kind }),
        None => Value::Null,
    }
}

pub fn extra(v: &Value) -> Value {
    let s = |k: &str| v[k].as_str().unwrap_or("");
    let n = |k: &str| number(&v[k]).unwrap_or(f64::NAN);
    match s("fn") {
        "parseBoundaryId" => match parse_boundary_id(s("arg")) {
            Ok(p) => json!({ "polytope": p.polytope, "piece": p.piece, "P": p.p }),
            Err(e) => json!(e),
        },
        "bound" => match boundary_domain_bound(s("polytope"), s("piece"), n("P")) {
            Some(b) => json!({ "value": b.value, "label": b.label }),
            None => Value::Null,
        },
        "checkMs" => json!({ "ms": boundary_check_ms(s("polytope"), s("piece"), n("P")), "heavy": boundary_is_heavy(s("polytope"), s("piece"), n("P")) }),
        "highDimShape" => match high_dim_shape(s("name")) {
            Some(h) => json!({ "cells": h.cells, "dimU": h.dim_u }),
            None => Value::Null,
        },
        "cells" => match get_polytope(s("name")) {
            Ok(p) => json!(p.cells.len()),
            Err(e) => json!({ "throw": e }),
        },
        "domainInfo" => json!(serde_json::to_string(&boundary_domain_info()).unwrap()),
        "sample" => json!(boundary_domain_sample(n("limit"))),
        "ballBounds" => bounds_json(ball_bounds(s("polytope"), n("P"))),
        "pieceBounds" => bounds_json(piece_bounds(s("polytope"), s("piece"), n("P"))),
        "boundaryBound" => json!(boundary_bound(s("piece"), n("P"))),
        "ncubeBound" => json!(ncube_bound(n("d") as usize, s("piece"), n("P"))),
        "ndBound" => {
            let (family, d) = nd_parse(s("polytope")).unwrap();
            json!({ "value": nd_bound(family, d, n("P")), "kind": nd_bound_kind(family, d, n("P")) })
        }
        "constants" => json!({
            "MAX_S": MAX_S, "MAX_P": MAX_P, "CONTAINERS": CONTAINERS, "PIECES": PIECES, "POLYTOPES": POLYTOPES,
            "CONTAINER_PIECES": CONTAINERS.iter().map(|c| container_pieces(c).unwrap().to_vec()).collect::<Vec<_>>(),
            "CONTAINER_MAX_P": CONTAINERS.iter().map(|c| container_max_p(c).unwrap()).collect::<Vec<_>>(),
        }),
        // the catalogue's polytope as the validator uses it (built once by the ported builder and kept)
        "polytope" => polytope_json(get_polytope(s("name")).unwrap()),
        // the same polytope built anew by the port of the TypeScript builder (hull.rs, polytope.rs)
        "polytopeBuilt" => polytope_json(&build_catalogue_polytope(s("name")).unwrap()),
        "piece" => piece_json(piece_shape(s("name")).unwrap()),
        "pieceBuilt" => piece_json(&build_piece_shape(s("name")).unwrap()),
        other => json!({ "throw": format!("unknown extra {other}") }),
    }
}

