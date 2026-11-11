//! PolyPack's torus family: the server's validator, ported from packages/torus (TypeScript).
//!
//! P congruent pieces (disks of diameter 1, N = 0, or regular N-gons of side 1, N = 3..100) on a
//! flat torus R^2 / (Z b1 + Z b2): a square torus `sq` or a hexagonal torus `hex` of side L, or a
//! `free` lattice chosen by the solver. A piece must miss every other piece's translates and its
//! own.
//!
//! What is here is what the server's bundle keeps of the package (`native/PORTING.md`):
//!
//! | TypeScript | Rust module |
//! |---|---|
//! | packages/torus/src/lattice.ts | [`lattice`] |
//! | packages/torus/src/disk.ts (`reachOf`, `areaOf`, `separationOf`) | [`disk`] |
//! | packages/torus/src/validate.ts (`validationSteps`, `areaScoreBound`) | [`validate`] |
//! | packages/geometry/src/shapes.ts, trig.ts, overlap.ts (the helpers the above call) | [`geometry`] |
//!
//! and, for the coordinator, the `torus` branch of `check` and `reducedSpaceConfig` of
//! packages/spaces/src/validate.ts as [`server`]. The search (search.ts, kernel*.ts, start.ts), the
//! record reader, `penetrationOf` and `scalePacking` are not reached by the server and are not
//! ported.
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

pub mod disk;
pub mod geometry;
pub mod json;
pub mod lattice;
pub mod server;
pub mod validate;

pub use geometry::Pose;
pub use lattice::{
    cell_area, det, gauss_reduce, lattice_images, max_image_candidates, torus_score, Image, Lattice, Reduced,
    TorusFamily, MAX_IMAGE_CANDIDATES, TORUS_DISK_RADIUS, TORUS_FAMILIES, TORUS_MAX_P,
};
pub use validate::{area_score_bound, validation_steps, ImageContact, TorusPacking, TorusValidation, ValidateOptions};
