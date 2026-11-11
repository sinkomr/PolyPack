//! What GET /api/spaces says about each space, apart from its problem and record counts, which come
//! from the loaded catalogue, and the limits the checks share. Port of packages/spaces/src/info.ts.
//!
//! The texts (`SPACE_INFO`, `SPACE_EXHIBITS`) are not retyped: the source writes them from the
//! packages' limits, and native/tools/spaces-tables.mts writes them as they come out into
//! data/tables.json (native/PORTING.md, rule 6).

use crate::tables::{SpaceInfoText, TABLES};
use crate::types::{SpaceExhibit, SpaceName};
use polypack_boundary::MAX_S;
use polypack_flat::protocol::SCORE_TIE;
use polypack_polyhedra::POLYHEDRA_RECORD_MARGIN;

pub use polypack_polyhedra::POLYHEDRA_MAX_QUATERNION;

/// info.ts: `NOTES`.
const NOTES: &str = "https://github.com/sinkomr/PolyPack/blob/main/docs/spaces";

/// info.ts: `SPACE_TOL`. PolyPack's touching tolerance, the same as on the main site: overlaps
/// deeper than this are rejected.
pub const SPACE_TOL: f64 = 1e-9;
/// info.ts: `SPACE_STRICT_TOL`. Tolerance of the strict check of a configuration that beats a
/// research record (validate.rs): far below the touching tolerance, and above the float error of
/// the validators at these sizes.
pub const SPACE_STRICT_TOL: f64 = 1e-11;
/// info.ts: `SPACE_MAX_COORD`. Largest absolute value of a coordinate, an angle or a quaternion
/// component, each on its own.
pub const SPACE_MAX_COORD: f64 = 1e4;
/// info.ts: `SPACE_MIN_QUATERNION_NORM`. Smallest norm of a sphere piece's quaternion: a tinier
/// one's squared norm can underflow.
pub const SPACE_MIN_QUATERNION_NORM: f64 = 1e-6;
/// info.ts: `SURFACE_MAX_CHAINS`. Most chains of faces one piece may cross in the fold check.
/// [CALC, the source's] Real packings on the Platonic solids need at most about 35; random single
/// pieces at the one-piece and area scales need up to 126 on the other solids.
pub const SURFACE_MAX_CHAINS: f64 = 600.0;
/// info.ts: `TORUS_MAX_TRANSLATES`. Most lattice translates checked per pair of torus pieces; a
/// reduced basis needs at most about 60.
pub const TORUS_MAX_TRANSLATES: f64 = 1000.0;
/// info.ts: `BOUNDARY_MAX_CHAINS`. Most chains of cells one boundary piece may cross in the check
/// (the boundary validator's maxChains).
pub const BOUNDARY_MAX_CHAINS: f64 = 1024.0;
/// info.ts: `BOUNDARY_MAX_S`. Largest edge s of a boundary configuration: the boundary validator's MAX_S.
pub const BOUNDARY_MAX_S: f64 = MAX_S;

/// info.ts: `SPACE_RECORD_MARGIN`. Relative margin by which an entry must beat a space's research
/// record (score < certified (1 - margin)) to count as better than it. The tie tolerance, except
/// for polyhedra and ndim: their records keep the wiki's clearance of up to 1e-7 between pieces and
/// from the walls, and removing that clearance is not a better packing. Site entries still compete
/// with each other by the tie tolerance.
pub const fn space_record_margin(space: SpaceName) -> f64 {
    match space {
        SpaceName::Surface | SpaceName::Curved | SpaceName::Sphere | SpaceName::Torus | SpaceName::Boundary | SpaceName::Balls => SCORE_TIE,
        // records keep the wiki's clearance of 1e-7 between pieces and from the walls
        SpaceName::Polyhedra | SpaceName::Ndim => POLYHEDRA_RECORD_MARGIN,
    }
}

/// info.ts: `spaceDocsUrl`. The space's notes on GitHub.
pub fn space_docs_url(file: &str) -> String {
    format!("{NOTES}/{file}")
}

/// info.ts: `SPACE_INFO[space]`: the title, the sentences and the conventions of a space, with the
/// keys of the conventions in the source's order.
pub fn space_info(space: SpaceName) -> &'static SpaceInfoText {
    &TABLES.info[space.index()]
}

/// info.ts: `SPACE_EXHIBITS`. Research material shown on the site that takes no submissions.
pub fn space_exhibits() -> &'static [SpaceExhibit] {
    &TABLES.exhibits
}
