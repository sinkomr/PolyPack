//! The fold search of packages/surface (`src/search/`) and its driver in packages/spaces
//! (`src/search/surface-fold.ts`), ported line by line: the overlap energies (`energy`), the
//! L-BFGS relaxation and compression (`optimize`), the contact-LP polish (`slp`) and the search
//! itself (`fold`).
//!
//! The TypeScript throws where a chain enumeration exceeds its depth limit. The search code calls
//! `enumerate_chains` deep inside its loops, so here that error unwinds as a `ChainError` payload
//! (`std::panic::resume_unwind`, which does not run the panic hook) to `surface_auto`, which turns
//! it into the job's error result as `runSpaceJob` does.

use crate::chains::{enumerate_chains, ChainError, ChainNode};
use crate::solids::Solid;

pub mod energy;
pub mod fold;
pub mod optimize;
pub mod slp;

/// `enumerateChains(solid, s, anchor, cx, cy, reach)` with no chain limit; a `ChainError` unwinds.
pub(crate) fn chains(solid: &Solid, s: f64, anchor: usize, cx: f64, cy: f64, reach: f64) -> Vec<ChainNode> {
    match enumerate_chains(solid, s, anchor, cx, cy, reach, f64::INFINITY) {
        Ok(nodes) => nodes,
        Err(e) => throw(e),
    }
}

/// A `ChainError` unwinding out of the search (see the module comment).
pub(crate) fn throw(e: ChainError) -> ! {
    std::panic::resume_unwind(Box::new(e))
}
