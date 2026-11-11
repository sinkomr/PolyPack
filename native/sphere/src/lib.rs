//! PolyPack's sphere family: the server's validator, ported from packages/sphere (TypeScript).
//!
//! P congruent pieces on a whole sphere of radius rho with no container: caps of geodesic diameter
//! 1 (N = 0) or regular spherical N-gons of geodesic side 1 (N = 3..100), each placed by a
//! quaternion. The score is rho.
//!
//! What is here is what the server's bundle keeps of the package (`native/PORTING.md`):
//!
//! | TypeScript (packages/sphere/src) | Rust module |
//! |---|---|
//! | geometry.ts (the functions the validator and the domain's bound use) | [`geometry`] |
//! | hull.ts | [`hull`] |
//! | validate.ts | [`validate`] |
//!
//! and, for the coordinator, the `sphere` branch of `check` in packages/spaces/src/validate.ts as
//! [`server::check`]. The search (search.ts, kernel*.ts) and the record reader are not reached by
//! the server and are not ported.
//!
//! Every `Math.*` of the source is `polypack_js::math::*`, every number in a message is
//! `polypack_js::fmt::num`.

// The comparisons keep the form of the source: `!(a > b)` is not `a <= b` when one of them is NaN
// (native/PORTING.md, rule 4).
#![allow(
    clippy::neg_cmp_op_on_partial_ord,
    clippy::manual_range_contains,
    clippy::nonminimal_bool
)]

pub mod geometry;
pub mod hull;
pub mod json;
pub mod server;
pub mod validate;

pub use geometry::{
    area_bound, centre_of, circumradius_angle, piece_angle, piece_exists, placed_vertices, rho_for_angle, Quat,
    SphereConfig, SpherePiece, SphereProblem, Vec3,
};
pub use validate::{
    max_margin_plane, pair_gaps, validation_steps, MaxMargin, PairGap, PairKind, ValidateOptions, ValidationResult,
};
