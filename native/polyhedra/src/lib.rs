//! PolyPack's polyhedra family: the server's validator, ported from packages/polyhedra (TypeScript).
//!
//! Convex polyhedra packed in a scaled convex polyhedron: P congruent copies of a piece solid, each a centre and
//! a quaternion, in s times a container solid. The modules follow the source's files:
//!
//! | source (packages/polyhedra/src) | module |
//! |---|---|
//! | catalogue.ts | [`catalogue`]: the solids' and problems' names, without geometry |
//! | solids.ts, solids.data.ts | [`solids`]: the 186 solids (table in `data/solids.json`) |
//! | geom.ts | [`geom`]: poses, the separating-axis test, the wall gap |
//! | validate.ts | [`validate`]: the check of a configuration's form and the validator |
//! | records.ts | [`records`]: `parse_polyhedra_config` |
//! | problems.ts | [`problems`]: `get_problem`, `volume_bound` |
//! | info.ts | [`info`]: the limits |
//! | domain.ts | [`domain`]: what /api/spaces says of the family, its bound and its sample |
//!
//! `native/PORTING.md` has the rules of the port; `native/tools/polyhedra-ref.mts`,
//! `examples/polyhedradiff.rs` and `native/tools/polyhedra-compare.mjs` compare it with the TypeScript.

pub mod catalogue;
pub mod domain;
pub mod geom;
pub mod info;
pub mod problems;
pub mod records;
pub mod solids;
pub mod validate;

pub use catalogue::{
    pair_code, pair_count, plural_title, problem_name_of, problem_title, solid_group, ProblemFamily, ProblemName,
    SolidFamily, SolidName, JOHNSON_SOLIDS, PROBLEM_CODES, PROBLEM_NAMES, PROBLEM_ORDER, SOLIDS_BY_GROUP,
    SOLID_NAMES_LIST,
};
pub use domain::{
    polyhedra_domain_bound, polyhedra_domain_info, polyhedra_domain_sample, DomainBound, DomainField, DomainInfo,
    DomainJoin, Record,
};
pub use geom::{place, quat_to_r, separation, wall_gap, Placed, Pose, Separation};
pub use info::{POLYHEDRA_MAX_P, POLYHEDRA_RECORD_MARGIN};
pub use problems::{get_problem, volume_bound, PolyhedraProblem};
pub use records::{parse_polyhedra_config, ParsedConfig};
pub use solids::{get_solid, is_solid_name, solid_name_of_code, Solid, JOHNSON_SOLID_NAMES, SOLID_NAMES};
pub use validate::{
    config_errors, config_errors_numbers, config_errors_typed, config_of_value, validate_polyhedra, validate_polyhedra_value,
    PolyhedraConfig, PolyhedraValidation, ValidateOptions, POLYHEDRA_MAX_COORD, POLYHEDRA_MAX_QUATERNION,
    POLYHEDRA_MAX_SIZE, POLYHEDRA_MIN_QUATERNION_NORM, POLYHEDRA_TOL,
};
