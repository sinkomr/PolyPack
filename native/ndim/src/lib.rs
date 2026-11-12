//! PolyPack's ndim family: the server's validator, ported from packages/ndim and packages/ndspace
//! (TypeScript). P equal pieces (a unit-edge polytope of the catalogue, or a ball of diameter 1) in
//! a scaled container (the polytope scaled by s, or the ball of diameter s), in dimension d = 4 to
//! 10 (docs/spaces/NDIM.md).
//!
//! The modules of the crate root are packages/ndim (the geometry, file by file); `space` is what
//! the server reaches of packages/ndspace (ids, the domain, bounds, the parser of a configuration
//! and the check with its cap on the work). Only what the server's bundle keeps is ported: the
//! search kernel, the exact certifier's helpers and the pose-from-matrix functions are not here.
//!
//! The port follows native/PORTING.md: the order of operations, loops and early exits is the
//! source's; `Math.*` is `polypack_js::math`, numbers in messages are `polypack_js::fmt::num`.
//! A JavaScript `throw` is an `Err(Thrown)` with the same message.

// The port keeps the source's forms: `!(a > b)` is not `a <= b` when a number is NaN, and the loops
// index the flat arrays as the source does (native/PORTING.md, rules 1 and 4).
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::needless_range_loop, clippy::too_many_arguments)]
// The workspace's rust-version is 1.80: `is_none_or` and `is_multiple_of` are newer.
#![allow(clippy::unnecessary_map_or, clippy::manual_is_multiple_of)]

pub mod ball;
pub mod generate;
pub mod gjk;
pub mod info;
pub mod limits;
pub mod linalg;
pub mod margin;
pub mod polytope;
pub mod pose;
pub mod problem;
pub mod space;
pub mod validate;

/// An `Error` thrown by the TypeScript (`throw new Error(message)` or `RangeError`): the message.
/// The caller catches it where the source's caller does (the server answers "the check failed:
/// <message>").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thrown(pub String);

impl std::fmt::Display for Thrown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Thrown {}

/// `JSON.stringify(s)` of a string (the quotes and escapes of JavaScript).
pub(crate) fn json_string(s: &str) -> String {
    // serde_json escapes as JSON.stringify does for every string that is valid UTF-8: the two
    // quote and backslash escapes, \b \f \n \r \t, and \u00XX for the other control characters
    serde_json::to_string(s).expect("a string always serialises")
}

pub use info::{polytope_info_table, PolytopeInfo};
pub use limits::{
    default_limits, effective_limits, size_errors, LimitsOverride, NdLimits, HARD_MAX_BALL_PIECES, HARD_MAX_PIECES,
    HARD_MAX_VERTEX_WORK, HARD_MAX_WALL_WORK, MAX_BALL_PIECES, MAX_VERTEX_WORK, MAX_WALL_WORK,
};
pub use polytope::{get_polytope, is_loaded, load_polytope, polytope_codes, polytope_info, Polytope};
pub use pose::{cayley_matrix, n_params, place_vertices, read_pose, Pose, ReadPose, MAX_CAYLEY, MAX_COORD, MAX_SIZE};
pub use problem::{problem_errors, shape_polytope, NdConfig, NdProblem, BALL, BALL_RADIUS, MAX_DIM, MIN_DIM};
pub use validate::{config_errors, nd_check, validate_nd, NdValidation, Step, ValidateOptions, NDIM_TOL};
