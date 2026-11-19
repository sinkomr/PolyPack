//! PolyPack's generic search methods on a family's geometry kernel, ported from packages/methods
//! (TypeScript). A family implements [`kernel::FamilyKernel`] once; the methods are written against
//! it. Only what `basin_hopping` needs is ported, which is what the nD space's Auto search runs
//! (packages/spaces/src/search/run.ts: `AUTO_NDIM_METHOD`):
//!
//! | TypeScript | Rust module |
//! |---|---|
//! | packages/methods/src/kernel.ts | [`kernel`] |
//! | packages/methods/src/framework.ts (`runMethod`, the counted kernel) | [`framework`] |
//! | packages/methods/src/random.ts | [`random`] |
//! | packages/methods/src/lbfgs.ts | [`lbfgs`] |
//! | packages/methods/src/local.ts | [`local`] |
//! | packages/methods/src/methods/basin_hopping.ts, basin-operators.ts, basin-final.ts, seed-starts.ts (`fitIterations`) | [`basin`] |
//!
//! The port follows native/PORTING.md: the order of operations, loops and early exits is the
//! source's, `Math.*` is `polypack_js::math`, and a run with an evaluation budget only is
//! reproducible bit for bit. A JavaScript `throw` of the kernel or of the framework's `Stop` is an
//! `Err(Throw)`.
//!
//! The registry, the parameter schemas, the other methods, the kernel capabilities "shape" and the
//! observers (`onImprove`, `onOffer`, `observe`) and the time budget of `runMethod` are not ported:
//! the job of the space's Auto search uses none of them.

// The comparisons keep the form of the source: `!(a > b)` is not `a <= b` when one of them is NaN
// (native/PORTING.md, rule 4); the loops index flat arrays as the source does.
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::needless_range_loop, clippy::too_many_arguments)]

pub mod basin;
pub mod framework;
pub mod kernel;
pub mod lbfgs;
pub mod local;
pub mod random;
