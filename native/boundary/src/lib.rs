//! PolyPack's boundary family: the server's validator, ported from packages/boundary (TypeScript).
//!
//! The boundary space: (d-1)-dimensional pieces on the boundary of a convex d-polytope ("3D on 4D"
//! for d = 4: balls and the Platonic solids on the six regular 4-polytopes, folding across the
//! faces where two cells meet), on the d-cubes for d = 5..10 (balls and axis-aligned cubes) and on
//! the d-simplex, d-orthoplex and d-demicube for d = 5..10 (balls).
//!
//! The modules follow the source's files one for one:
//!  - the 4-polytopes: `validate`, `chains`, `polytope`, `polyhedron`, `pieces`, `parts`, `hull`,
//!    `linalg`, `bounds`, `containers`, `domain`, `ids`, `types`, `units`, `kernel_validate`;
//!  - the d-cubes: `ncube::{validate, lattice, bounds}`;
//!  - the n-dimensional polytopes: `nd::{validate, chains, container, bounds, names}`;
//!  - `exact`: the exact comparison of a double with a rational, which the source repeats in three
//!    of its files.
//!
//! What the server calls is re-exported below (see packages/boundary/src/index.ts).

// A port keeps the shape of its source (native/PORTING.md): comparisons stay in the form that makes NaN reject
// (`!(a <= b)`), loops stay indexed as the source's are, and constants keep the digits the source writes.
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::nonminimal_bool, clippy::needless_range_loop, clippy::excessive_precision, clippy::too_many_arguments)]
#![allow(clippy::doc_lazy_continuation, clippy::doc_overindented_list_items, clippy::manual_range_contains, clippy::needless_late_init, clippy::map_entry, clippy::manual_clamp, clippy::assign_op_pattern)]

pub mod bounds;
pub mod chains;
pub mod containers;
pub mod domain;
pub mod exact;
pub mod hull;
pub mod ids;
pub mod kernel_validate;
pub mod linalg;
pub mod ncube;
pub mod nd;
pub mod parts;
pub mod pieces;
pub mod polyhedron;
pub mod polytope;
pub mod types;
pub mod units;
pub mod validate;

pub use bounds::{
    ball_bounds, boundary_check_ms, boundary_is_heavy, container_facts, container_max_p, container_pieces, piece_bounds, ContainerFacts, PieceBounds, BOUNDARY_HEAVY_MS,
};
pub use domain::{boundary_domain_bound, boundary_domain_info, boundary_domain_max_p, boundary_domain_sample, boundary_problem_count, BoundEntry, DomainInfo};
pub use ids::{is_piece_name, parse_boundary_id, MAX_P};
pub use kernel_validate::boundary_bound;
pub use ncube::bounds::{ncube_bound, ncube_check_ms, ncube_max_p, ncube_problem_bound, unit_ball_volume};
pub use ncube::lattice::{is_ncube_name, ncube_dim, NCUBE_NAMES};
pub use ncube::validate::{validate_ncube, NCUBE_MAX_WORK};
pub use nd::bounds::{nd_ball_volume, nd_bound, nd_bound_kind, nd_boundary_volume, nd_check_ms, nd_problem_bound};
pub use nd::container::{get_nd, NdCell, NdContainer};
pub use nd::names::{high_dim_shape, is_nd_name, nd_cell_count, nd_dim, nd_parse, HighDimShape, NdFamily, ND_FAMILIES, ND_MAX_P, ND_NAMES, ND_PIECES};
pub use nd::validate::{nd_max_ops, validate_nd, validate_nd_stats, NdStats, ND_MAX_OPS, ND_MAX_WORK, ND_REACH};
pub use pieces::{is_polytope_piece, piece_shape, PieceShape, POLYTOPE_PIECES};
pub use polytope::{boundary_volume, build_polytope, cell_excess, compare_normals, get_polytope, is_container_name, is_polytope_name, tesseract_vertices, Polytope};
pub use types::{BoundaryConfig, BoundaryPiece, BoundaryProblem, BoundaryVerdict, ContainerName, PieceName, PolytopeName, Quaternion, CONTAINERS, PIECES, POLYTOPES};
pub use units::BALL_RADIUS;
pub use validate::{validate_boundary, validate_boundary_config, validate_on, BoundaryError, ValidateOptions, MAX_PAIR_TESTS, MAX_S};
