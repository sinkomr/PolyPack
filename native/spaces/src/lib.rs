//! PolyPack's spaces: ids, catalogues, parsing and the server's check, ported from packages/spaces (TypeScript).
//!
//! The spaces layer ties the families' validators together. One module per source file:
//!
//! | source (packages/spaces/src) | module |
//! |---|---|
//! | types.ts | [`types`]: the names of the spaces and the shapes of the API's answers |
//! | ids.ts | [`ids`]: problem ids, parsed into their fields and written back |
//! | info.ts | [`info`]: what /api/spaces says of each space, and the limits the checks share |
//! | domain.ts | [`domain`]: the domain of each space (its problems by parameter ranges) |
//! | piece-domains.ts | [`piece_domains`]: the curved, sphere and torus domains |
//! | records.ts | [`records`]: the catalogue of a space from its research records |
//! | load.ts | [`load`]: reading data/<space>/records.json, and the configurations kept apart |
//! | (V8's `JSON.parse`) | [`json_error`]: the message of a syntax error, as load.ts logs it |
//! | validate.ts | [`validate`]: parsing untrusted configurations, and the server's check of a submission |
//! | index.ts | the re-exports below |
//!
//! `native/PORTING.md` has the rules of the port; `native/tools/spaces-ref.mts`,
//! `examples/spacesdiff.rs` and `native/tools/spaces-compare.mjs` compare it with the TypeScript.
//! The source's `search` directory (the volunteer's methods) is not reached by the server and is
//! not ported.

// The port keeps the source's forms: `!(a > b)` is not `a <= b` when a number is NaN
// (native/PORTING.md, rule 4).
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::nonminimal_bool, clippy::manual_range_contains)]

pub mod domain;
pub mod ids;
pub mod info;
pub mod json_error;
pub mod load;
pub mod piece_domains;
pub mod records;
mod tables;
pub mod types;
pub mod validate;

pub use domain::{domain_max_p, impossible_reason, space_domain, DomainMenu, SpaceDomain};
pub use ids::{
    format_curvature, format_space_id, parse_space_id, parse_space_id_fields, parse_space_id_value, space_of_id, surface_archimedean,
    surface_catalan, surface_johnson, surface_platonic, surface_solids, ParsedSpaceId, BOUNDARY_PIECES, BOUNDARY_POLYTOPES, SURFACE_MODES,
    TORUS_FAMILIES,
};
pub use info::{
    space_docs_url, space_exhibits, space_info, space_record_margin, BOUNDARY_MAX_CHAINS, BOUNDARY_MAX_S, POLYHEDRA_MAX_QUATERNION,
    SPACE_MAX_COORD, SPACE_MIN_QUATERNION_NORM, SPACE_STRICT_TOL, SPACE_TOL, SURFACE_MAX_CHAINS, TORUS_MAX_TRANSLATES,
};
pub use load::{
    config_loader, config_loader_with, load_spaces_index, no_log, read_entry_config_sync, space_config_path, space_records_path, ConfigLoader,
    LoaderStats, Log, CONFIG_CACHE_BYTES, CONFIG_READS_AT_ONCE,
};
// the curved domain's lists: the board's 16 curvatures, the six tiling curvatures that stay off its menu, and all 22
pub use piece_domains::{count_curved_problems, CURVED_KS, CURVED_MENU_KS, CURVED_MENU_K_IDS, CURVED_MS, CURVED_PROBLEMS, CURVED_TILING_KS, PIECE_NS};
pub use records::{
    accepts_submissions, build_space_catalogue, compare_space_problems, config_location, entry_config, has_record, problem_of,
    space_problem_summary, ConfigLocation, SpaceCatalogue, SpaceProblemEntry, SpacesIndex, CONFIG_LINE_MAX,
};
pub use tables::SpaceInfoText;
pub use types::{
    is_space_name, is_space_name_value, space_names, Bound, CertifiedStatus, CertifiedValue, Field, Fields, Nofold, SiteBest, SpaceEntryHead,
    SpaceExhibit, SpaceInfo, SpaceName, SpaceProblemExtra, SpaceProblemHead, SpaceProblemStatus, SpaceProblemSummary, SpaceRecordsResponse,
    SpaceSiteOnlyResponse, SpaceSubmitResponse, SpacesResponse, Texts, SPACE_NAMES,
};
pub use validate::{
    beats_space_record, beats_space_score, improves_space_best, parse_space_config, reduced_space_config, space_max_p, stored_space_config,
    stored_space_config_async, validate_space_submission, validate_space_submission_async, Parsed, SpaceConfig, SpaceValidateOptions,
    SpaceVerdict, SurfaceSpaceConfig, TimedConfig, TimedVerdict, TorusLatticeSpec, TorusSpaceConfig, SPACE_BOUND_SLACK, SPACE_MAX_SIZE,
    SPACE_STRICT_NO_RECORD_REASON, SPACE_STRICT_REASON,
};

// 3D on 4D: the check-size estimates the server queues by (the boundary crate's, re-exported as
// index.ts does, so that the server needs no dependency of its own)
pub use polypack_boundary::{boundary_check_ms, boundary_is_heavy};
// nD in nD: what apps/server/src/spaces.ts imports from @polypack/ndspace
pub use polypack_ndim::space::{nd_check_ops, nd_is_heavy, NdProblemId};
