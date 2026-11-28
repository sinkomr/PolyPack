//! fresh-flat: a search for Flat problems written from scratch (native/FRESH.md).
//!
//! - [`geom`]: shapes, the exact separating-axis separation used to repair and to test;
//! - [`model`]: the smooth penalty objective with separating lines and a pressure on the container;
//! - [`lbfgs`]: the minimiser;
//! - [`search`]: starts, basin hopping, polishing, repair and the check.
pub mod fresh;
pub mod geom;
pub mod lattice;
pub mod lbfgs;
pub mod model;
pub mod rng;
pub mod search;
