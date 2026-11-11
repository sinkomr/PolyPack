//! The nD in nD space as the server sees it (packages/ndspace): the names and ids of its problems
//! (`catalogue`), the lower bounds (`bounds`), the domain for the spaces listing (`domain`), and the
//! parser and the capped check of a configuration (`validate`). The package's search kernel, its
//! lattices and contact code are not reached by the server and are not ported.

pub mod bounds;
pub mod catalogue;
pub mod domain;
pub mod validate;

pub use bounds::{nd_ball_volume, nd_bound_entry, nd_lower_bound, NdBound, NdBoundEntry, NdBoundKind};
pub use catalogue::{
    format_nd_id, nd_code, nd_in_range, nd_p_range, nd_polytopes, nd_problem_count, nd_shape_names, nd_shape_title,
    nd_shapes, parse_nd_id, parse_nd_id_value, NdProblemId, ParsedNdId, ND_BALL, ND_DIMENSIONS, ND_ID_FORM, ND_MAX_D,
    ND_MAX_P, ND_MIN_D,
};
pub use domain::{ndim_domain_bound, ndim_domain_info, ndim_domain_info_json, ndim_domain_sample};
pub use validate::{
    load_nd_problem, nd_check, nd_check_ops, nd_check_steps, nd_is_heavy, nd_problem_of, parse_nd_config,
    NdConfigShape, NdParsed, NDIM_CHECK_MS, NDIM_HEAVY_OPS, NDIM_MAX_REASONS,
};
