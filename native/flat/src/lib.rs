//! Flat 2D packing for PolyPack: P regular N-gons of side 1 (N = 0: disks of diameter 1) in the
//! smallest regular M-gon (M = 0: circle).
//!
//! The server's rule, ported from packages/geometry/src (see native/PORTING.md), one module per
//! source file:
//!
//! - [`shapes`] (shapes.ts), [`trig`] (trig.ts), [`overlap`] (overlap.ts), [`enclose`]
//!   (enclose.ts): the geometry;
//! - [`config`] (config.ts): `parse_config`, `evaluate`, `strict_verify`;
//! - [`protocol`] (protocol.ts) and [`provenance`] (provenance.ts): the record types, the rules
//!   that compare a score with a published value, and how a submission was found.
//!
//! The search, which the TypeScript server does not have:
//!
//! - [`sep`], [`grid`], [`penalty`]: its own kernels;
//! - [`validate`]: what the volunteer client checks before it offers a packing;
//! - [`framework`] and [`methods`]: the search methods and their run framework.
//!
//! Every transcendental function of the crate is [`math`]'s (JavaScript's `Math`, the same doubles
//! on every platform), never the platform's C library.

pub mod clock;
pub mod config;
pub mod enclose;
pub mod framework;
pub mod grid;
pub mod math;
pub mod methods;
pub mod overlap;
pub mod penalty;
pub mod protocol;
pub mod provenance;
pub mod rng;
pub mod sep;
pub mod shapes;
pub mod trig;
pub mod validate;

pub use framework::{run, Budget, Control, RunOptions, RunResult, Termination};
pub use methods::Method;
pub use shapes::{Config, Container, Pose, Problem};
