//! The limits a server applies to the polyhedra family. Port of the constants of `packages/polyhedra/src/info.ts`.
//!
//! The source's `POLYHEDRA_INFO` (the family's own listing text) is not here: the server's bundle defines it and
//! never reads it; what /api/spaces says about the family is written in packages/spaces/src/info.ts.

/// `info.ts: POLYHEDRA_MAX_P`: largest P of the domain; research records cover P = 2 to 100 only.
pub const POLYHEDRA_MAX_P: usize = 500;

/// `info.ts: POLYHEDRA_RECORD_MARGIN`: relative margin by which an entry must beat a research record's certified
/// scale to count as better. The records keep the wiki's clearances between pieces and from the walls (1e-7, or
/// less after certified refinements), which cost at most 2.6e-7 relative in s where upstream gives the touching
/// limit s_tight; removing them is not a better packing.
pub const POLYHEDRA_RECORD_MARGIN: f64 = 1e-6;
