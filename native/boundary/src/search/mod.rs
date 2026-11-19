//! The boundary space's seeded searches, ported from packages/boundary/src/search/ and the two
//! search entry points of the other containers (ncube/search.ts, nd/search.ts) with what they call
//! (the generic kernel's seeds and its exact finishing: ncube/kernel.ts, nd/kernel.ts, ncube/seeds.ts,
//! nd/seeds.ts, ncube/model.ts, nd/model.ts, and their `finalizeState` of search.ts).
//!
//! What is ported is what `searchBoundary` reaches for one job. The TypeScript models also carry the
//! generic methods' options (per-piece weights, a focus piece, dE/ds), the d-cube and nD models also
//! their energy and gradient: none is read by `searchBoundary`, so none is ported.
//!
//! Every function that can reach the budget's `tick` returns `Result<_, Halt>`: `Halt::Stop` is the
//! source's thrown `Stop` (ends the search with the best so far), `Halt::Error` any other thrown error
//! (the job's error).

pub mod ball_site;
pub mod balls;
pub mod chart;
pub mod cubes;
pub mod driver;
pub mod lbfgs;
pub mod model;
pub mod nd_search;
pub mod ncube_search;
pub mod random;
pub mod rot;
pub mod solids;
pub mod tesseract;

pub use driver::{finalize_state, model_of, search_boundary, BoundarySearchEvent, BoundarySearchOptions, BoundarySearchResult, VALIDATION_EVALS};
pub use model::{copy_state, scale_state, Finish, PieceModel, State};

/// packages/boundary/src/search/search.ts: BoundarySearchEnd
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Evals,
    Time,
    Stopped,
    Bound,
}

impl End {
    pub fn as_str(self) -> &'static str {
        match self {
            End::Evals => "evals",
            End::Time => "time",
            End::Stopped => "stopped",
            End::Bound => "bound",
        }
    }
}

/// What ends a search early: the source's `Stop` (a normal end) or another thrown error.
#[derive(Clone, Debug, PartialEq)]
pub enum Halt {
    Stop(End),
    Error(String),
}

pub type Res<T> = Result<T, Halt>;
