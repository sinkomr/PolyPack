//! Hard caps on the size of a configuration, enforced by config_errors / validate_nd before any
//! pose is read or any vertex is placed (packages/ndim/src/limits.ts, docs/spaces/NDIM.md §4). They
//! bound the work and the memory of the validator on untrusted input: the world vertices of the
//! pieces take P nV d numbers, the wall test up to P nV nF inequalities, and the pair test one
//! GJK / EPA per near pair.
//!
//! The defaults are the planned domains: 40 pieces in 4D, 32 in 5D, 24 in 6D, 20 in 7D to 10D, and
//! up to MAX_BALL_PIECES balls (a ball pair costs one distance). A trusted caller may raise them
//! with ValidateOptions.limits, never above the HARD_* ceilings; a server must not take the limits
//! from the request (the server passes none).
use crate::problem::{shape_polytope, NdProblem, BALL};
use crate::Thrown;
use polypack_js::{fmt, math};

/// packages/ndim/src/limits.ts: MAX_PIECES_BY_DIM. Largest number of polytope pieces by dimension
/// (None for a dimension outside 4 to 10, where the source's record has no entry).
pub fn max_pieces_by_dim(d: i64) -> Option<f64> {
    match d {
        4 => Some(40.0),
        5 => Some(32.0),
        6 => Some(24.0),
        7..=10 => Some(20.0),
        _ => None,
    }
}
/// Largest number of ball pieces, in any dimension.
pub const MAX_BALL_PIECES: f64 = 400.0;
/// Largest P * nV * d (the world vertices of the pieces are 8 bytes each: 4 MB at the default).
pub const MAX_VERTEX_WORK: f64 = 500_000.0;
/// Largest P * nV * nF (vertex-facet inequalities of the wall test, before its prefilters).
pub const MAX_WALL_WORK: f64 = 200_000_000.0;

/// The ceilings no override can exceed.
pub const HARD_MAX_PIECES: f64 = 256.0;
pub const HARD_MAX_BALL_PIECES: f64 = 1024.0;
pub const HARD_MAX_VERTEX_WORK: f64 = 8_000_000.0;
pub const HARD_MAX_WALL_WORK: f64 = 4_000_000_000.0;

/// packages/ndim/src/limits.ts: NdLimits. Numbers, as in the source (they are compared with
/// products of counts and printed in the messages).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NdLimits {
    pub max_pieces: f64,
    pub max_vertex_work: f64,
    pub max_wall_work: f64,
}

/// `Partial<NdLimits>`: the fields a trusted caller replaces.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LimitsOverride {
    pub max_pieces: Option<f64>,
    pub max_vertex_work: Option<f64>,
    pub max_wall_work: Option<f64>,
}

/// packages/ndim/src/limits.ts: defaultLimits. The default limits of a problem.
pub fn default_limits(problem: &NdProblem) -> NdLimits {
    NdLimits {
        max_pieces: if problem.piece == BALL { MAX_BALL_PIECES } else { max_pieces_by_dim(problem.d).unwrap_or(20.0) },
        max_vertex_work: MAX_VERTEX_WORK,
        max_wall_work: MAX_WALL_WORK,
    }
}

/// packages/ndim/src/limits.ts: effectiveLimits. The limits in force: the defaults, replaced field
/// by field by `override`, never above the hard ceilings.
pub fn effective_limits(problem: &NdProblem, over: Option<&LimitsOverride>) -> NdLimits {
    let base = default_limits(problem);
    let Some(over) = over else {
        return base;
    };
    NdLimits {
        max_pieces: math::min(
            if problem.piece == BALL { HARD_MAX_BALL_PIECES } else { HARD_MAX_PIECES },
            over.max_pieces.unwrap_or(base.max_pieces),
        ),
        max_vertex_work: math::min(HARD_MAX_VERTEX_WORK, over.max_vertex_work.unwrap_or(base.max_vertex_work)),
        max_wall_work: math::min(HARD_MAX_WALL_WORK, over.max_wall_work.unwrap_or(base.max_wall_work)),
    }
}

/// packages/ndim/src/limits.ts: sizeErrors. The errors of a piece count against the limits (empty
/// when within them); the problem's polytopes must be loaded.
pub fn size_errors(problem: &NdProblem, n_pieces: usize, over: Option<&LimitsOverride>) -> Result<Vec<String>, Thrown> {
    let lim = effective_limits(problem, over);
    let mut errors: Vec<String> = Vec::new();
    let n = n_pieces as f64;
    if n > lim.max_pieces {
        errors.push(format!(
            "at most {} pieces are checked in this problem, got {}",
            fmt::num(lim.max_pieces),
            fmt::num(n)
        ));
    }
    if let Some(p) = shape_polytope(&problem.piece)? {
        let nv = p.n_v as f64;
        if n * nv * problem.d as f64 > lim.max_vertex_work {
            errors.push(format!(
                "{} pieces of {} vertices exceed the work limit of {} coordinates",
                fmt::num(n),
                fmt::num(nv),
                fmt::num(lim.max_vertex_work)
            ));
        }
        if let Some(c) = shape_polytope(&problem.container)? {
            let nf = c.n_f as f64;
            if n * nv * nf > lim.max_wall_work {
                errors.push(format!(
                    "{} pieces of {} vertices in a container of {} facets exceed the work limit",
                    fmt::num(n),
                    fmt::num(nv),
                    fmt::num(nf)
                ));
            }
        }
    }
    Ok(errors)
}
