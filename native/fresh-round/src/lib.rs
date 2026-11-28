//! fresh-round: a from-scratch search for disks at constant curvature (`curved/<K>/0/<M>/<P>`) and
//! disks on the sphere (`sphere/0/<P>`). See README.md for the method and native/FRESH.md for the
//! contract. The problem definitions and the check come from polypack-curved, polypack-sphere and
//! polypack-spaces; the search (representation, constraints, optimiser, schedule) is this crate's.

// Negated comparisons are deliberate: `!(a < b)` is true for NaN, which must count as failure.
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::needless_range_loop, clippy::chunks_exact_to_as_chunks)]

pub mod fresh;
pub mod kfn;
pub mod lbfgs;
pub mod model;
pub mod rng;
pub mod search;

use model::{Curved, Model, Sphere};
use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};
use search::{Budget, Params, Report, Search};
use serde_json::Value;

/// A problem this crate searches.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Problem {
    Curved { k: f64, m: u32, p: usize },
    Sphere { p: usize },
}

impl Problem {
    /// Reads `curved/<K>/0/<M>/<P>` (K != 0) or `sphere/0/<P>`; None for anything else.
    pub fn parse(id: &str) -> Option<Problem> {
        let parts: Vec<&str> = id.split('/').collect();
        match parts.as_slice() {
            ["curved", k, "0", m, p] => {
                let k: f64 = k.parse().ok()?;
                let m: u32 = m.parse().ok()?;
                let p: usize = p.parse().ok()?;
                if !(k.is_finite() && k != 0.0) || !(m == 0 || (3..=100).contains(&m)) || p < 2 {
                    return None;
                }
                polypack_spaces::parse_space_id(SpaceName::Curved, id).ok()?;
                Some(Problem::Curved { k, m, p })
            }
            ["sphere", "0", p] => {
                let p: usize = p.parse().ok()?;
                if p < 2 {
                    return None;
                }
                polypack_spaces::parse_space_id(SpaceName::Sphere, id).ok()?;
                Some(Problem::Sphere { p })
            }
            _ => None,
        }
    }

    pub fn space(&self) -> SpaceName {
        match self {
            Problem::Curved { .. } => SpaceName::Curved,
            Problem::Sphere { .. } => SpaceName::Sphere,
        }
    }

    /// False when no packing can exist: the catalogue's area and containment bound (curvedMaxP).
    pub fn can_exist(&self) -> bool {
        match *self {
            Problem::Curved { k, m, p } => polypack_curved::curved_max_p(k, 0.0, m as f64, p as f64) >= p as f64,
            Problem::Sphere { .. } => true,
        }
    }
}

/// The server's check of a configuration (the client's rule, default options): Some(score) when valid.
pub fn check(space: SpaceName, id: &str, config: &Value) -> Option<f64> {
    let v = validate_space_submission(space, id, config, &SpaceValidateOptions::default());
    if v.valid {
        v.score
    } else {
        None
    }
}

pub fn default_params(problem: &Problem) -> Params {
    match *problem {
        Problem::Curved { p, .. } => Params {
            mu0: 100.0,
            mu_max: 1e7,
            explore_tol: 1e-7,
            explore_gtol: 1e-9,
            polish_tol: 1e-11,
            max_outer: 40,
            max_iter: 400,
            patience: 20 + 2 * p,
            memory: 8,
            polish_outer: 12,
            frontier: true,
            delta: 1e-7,
        },
        Problem::Sphere { p } => Params {
            mu0: 100.0,
            mu_max: 1e7,
            explore_tol: 1e-7,
            explore_gtol: 1e-9,
            polish_tol: 1e-11,
            max_outer: 40,
            max_iter: 400,
            patience: 20 + 2 * p,
            memory: 8,
            polish_outer: 12,
            frontier: true,
            delta: 1e-7,
        },
    }
}

/// Runs the search on `id` with the CPU-time deadline `deadline` (absolute, this thread's clock)
/// and an optional evaluation budget.
pub fn solve(id: &str, problem: &Problem, seed: u64, budget: Budget, params: Params, clock: &dyn Fn() -> f64) -> Report {
    let space = problem.space();
    let mut checker = |c: &Value| check(space, id, c);
    match *problem {
        Problem::Curved { k, m, p } => {
            let model = Curved::new(k, m, p);
            Search::new(model, seed, budget, params, clock, &mut checker).run()
        }
        Problem::Sphere { p } => {
            let model = Sphere::new(p);
            Search::new(model, seed, budget, params, clock, &mut checker).run()
        }
    }
}

#[allow(dead_code)]
fn _assert_model<M: Model>() {}
