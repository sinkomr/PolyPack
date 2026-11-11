//! PolyPack's surface family: the server's validator, ported from packages/surface (TypeScript).
//!
//! Regular polygons (side 1) and disks (diameter 1) on the surface of a convex solid of edge s, in
//! two modes: `fold` (a piece is a flat rigid shape developed across edges from its centre) and
//! `nofold` (each piece inside one face). The port follows native/PORTING.md: line by line, with
//! `polypack_js` for every `Math.*` and every number in a message.
//!
//! What the server calls:
//!  - [`validate`]`(cfg, mode, opts)`: the check of a configuration (`validate` and `validateAsync`
//!    of the TypeScript, which give the same result). Its `Err` is what the TypeScript throws: a
//!    [`ChainError::ChainLimit`] (the server's "the fold check gave up: ...") or another error
//!    ("the check failed: ...");
//!  - [`get_solid`]`(name)`: the solid of a name (the server reads its number of faces, `.f`);
//!  - [`all_solid_names`]: the `SolidName` list;
//!  - the domain ([`domain_info`], [`domain_bound`], [`domain_sample`], and the constants
//!    `SURFACE_MAX_N`, `SURFACE_MAX_P`).
//!
//! Modules, each the port of the TypeScript file of the same name: `solids`, `rigid`, `chains`,
//! `parts`, `disk`, `validate`, `domain`, `kernel` (constants only); `geometry` holds the helpers
//! of packages/geometry that the package imports.

pub mod chains;
pub mod disk;
pub mod domain;
pub mod geometry;
pub mod kernel;
pub mod parts;
pub mod rigid;
pub mod solids;
pub mod validate;

pub use chains::{enumerate_chains, ChainError, ChainNode, Wedge, MAX_CHAIN_DEPTH};
pub use disk::SURFACE_DISK_RADIUS;
pub use domain::{
    domain_bound, domain_info, domain_sample, in_domain, surface_bound, surface_bounds, surface_ns, DomainBound, DomainInfo,
    SURFACE_MAX_N, SURFACE_MAX_P,
};
pub use geometry::TOL;
pub use parts::{Part, SurfacePose};
pub use solids::{all_solid_names, get_solid, is_solid_name, solid_names, Solid, SolidFamily};
pub use validate::{validate, validate_fold, validate_nofold, Mode, SurfaceConfig, ValidateOptions, Validation};
