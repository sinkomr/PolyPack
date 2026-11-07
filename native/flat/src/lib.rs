//! Flat 2D packing for PolyPack: P regular N-gons of side 1 (N = 0: disks of diameter 1) in the
//! smallest regular M-gon (M = 0: circle).
//!
//! - [`shapes`], [`sep`], [`grid`], [`enclose`], [`penalty`]: the geometry;
//! - [`validate`]: the server's acceptance rule and score;
//! - [`framework`] and [`methods`]: the search methods and their run framework.

pub mod clock;
pub mod enclose;
pub mod framework;
pub mod grid;
pub mod methods;
pub mod penalty;
pub mod rng;
pub mod sep;
pub mod shapes;
pub mod validate;

pub use framework::{run, Budget, Control, RunOptions, RunResult, Termination};
pub use methods::Method;
pub use shapes::{Config, Container, Pose, Problem};
