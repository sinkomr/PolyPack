//! The problems of the polyhedra family: P congruent copies of a piece solid in the smallest scaled copy s C of
//! a container solid. Port of what the server reaches of `packages/polyhedra/src/problems.ts`.
//!
//! A problem is named by upstream's code `<piece code>in<container code>`, e.g. "cubintet" (cubes in a
//! tetrahedron) or "pr3l15incub" (triangular prisms of height 1.5 in a cube), and a problem with P pieces has
//! the PolyPack id `polyhedra/<code>/<P>`. Every ordered pair of the 186 solids is a problem (catalogue.rs).

use crate::catalogue::{problem_name_of, ProblemName};
use crate::solids::get_solid;
use polypack_js::math;

/// `problems.ts: PolyhedraProblem`.
pub type PolyhedraProblem = ProblemName;

/// `problems.ts: getProblem`: the problem of a code (any ordered pair of the solids), or None.
pub fn get_problem(code: &str) -> Option<PolyhedraProblem> {
    problem_name_of(code)
}

/// `problems.ts: volumeBound`: the volume bound s >= (P vol(piece) / vol(container))^(1/3): P disjoint pieces of
/// total volume P vol(piece) fit in s C only if vol(s C) = s^3 vol(C) is at least that much. [EST, elementary]
/// `Err` (the source throws) for a problem whose solids are not in the table.
pub fn volume_bound(problem: &PolyhedraProblem, p: f64) -> Result<f64, String> {
    Ok(math::cbrt((p * get_solid(&problem.piece)?.volume) / get_solid(&problem.container)?.volume))
}
