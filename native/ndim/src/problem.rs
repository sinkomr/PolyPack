//! A problem of the nD spaces: P equal pieces in the smallest scaled container
//! (packages/ndim/src/problem.ts, docs/spaces/NDIM.md §1).
//!
//! The piece is a catalogue polytope of unit edge or a ball of diameter 1; the container, centred
//! at the origin, is the polytope scaled by s or the ball of diameter s. The score is s; smaller is
//! better. A shape is named by its catalogue code ("5:demi") or "ball".
use crate::polytope::{get_polytope, is_loaded, polytope_info, Polytope};
use crate::{json_string, Thrown};
use polypack_js::fmt;
use std::sync::Arc;

pub const BALL: &str = "ball";
/// Radius of a ball piece, and of a ball container at s = 1.
pub const BALL_RADIUS: f64 = 0.5;

/// packages/ndim/src/problem.ts: NdProblem.
#[derive(Debug, Clone, PartialEq)]
pub struct NdProblem {
    /// Dimension, 4 to 10.
    pub d: i64,
    /// Catalogue code of the piece, or "ball".
    pub piece: String,
    /// Catalogue code of the container, or "ball".
    pub container: String,
}

/// packages/ndim/src/problem.ts: NdConfig. A configuration: the container scale and one pose per
/// piece (see pose.rs for the formats).
#[derive(Debug, Clone, PartialEq)]
pub struct NdConfig {
    pub s: f64,
    pub pieces: Vec<Vec<f64>>,
}

pub const MIN_DIM: i64 = 4;
pub const MAX_DIM: i64 = 10;

/// packages/ndim/src/problem.ts: problemErrors. The errors of a problem description (empty when it
/// is well formed and its polytopes are loaded). The source reads an unknown value; here the
/// problem is typed, so "problem must be an object {d, piece, container}", a d that is not an
/// integer and a shape that is not a string cannot occur.
pub fn problem_errors(p: &NdProblem) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();
    if p.d < MIN_DIM || p.d > MAX_DIM {
        errors.push(format!("d must be an integer from {MIN_DIM} to {MAX_DIM}"));
        return errors;
    }
    for (key, v) in [("piece", &p.piece), ("container", &p.container)] {
        if v == BALL {
            continue;
        }
        let info = match polytope_info(v) {
            Ok(info) => info,
            Err(_) => {
                errors.push(format!("unknown {key} {}", json_string(v)));
                continue;
            }
        };
        if info.d as i64 != p.d {
            errors.push(format!("{key} {v} is not {}-dimensional", fmt::int(p.d)));
        } else if !is_loaded(v) {
            errors.push(format!("{key} {v} is loaded on demand: await loadPolytope({}) first", json_string(v)));
        }
    }
    errors
}

/// packages/ndim/src/problem.ts: shapePolytope. The polytope of a shape name, or None for "ball".
pub fn shape_polytope(code: &str) -> Result<Option<Arc<Polytope>>, Thrown> {
    if code == BALL {
        Ok(None)
    } else {
        get_polytope(code).map(Some)
    }
}
