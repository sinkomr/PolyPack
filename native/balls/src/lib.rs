//! PolyPack's balls family: the server's validator, ported from packages/balls (TypeScript).
//!
//! Balls of diameter 1 in a ball or in a scaled solid, and unit-edge solids in a ball. The solids, their names
//! and the separating-axis test are the polyhedra family's (`polypack-polyhedra`), as in the source. The modules
//! follow the source's files:
//!
//! | source (packages/balls/src) | module |
//! |---|---|
//! | catalogue.ts | [`catalogue`]: the 373 problems' names, ids, the ball's size |
//! | extent.ts | [`extent`]: a solid's Chebyshev radius and smallest enclosing ball |
//! | container.ts | [`container`]: a solid as a container of balls, the wall gap |
//! | problems.ts | [`problems`]: the lower bounds and the domain |
//! | validate.ts | [`validate`]: the check of a configuration's form and the validator |
//!
//! `native/PORTING.md` has the rules of the port; `native/tools/balls-ref.mts`, `examples/ballsdiff.rs` and
//! `native/tools/balls-compare.mjs` compare it with the TypeScript.

pub mod catalogue;
pub mod container;
pub mod extent;
pub mod problems;
pub mod validate;

pub use catalogue::{
    ball_container_radius, ball_container_score, balls_problem_of, balls_title, format_balls_id, parse_balls_id,
    BallsProblem, ParsedBallsId, BALLS_CODES, BALLS_CODES_HINT, BALLS_MAX_P, BALLS_MIN_P, BALLS_ORIGINAL_CODES,
    BALLS_PROBLEMS, BALL_DIAMETER, BALL_RADIUS,
};
pub use container::{container_kind, container_of, container_of_problem, wall_gap, Container, ContainerKind};
pub use extent::{chebyshev_of, chebyshev_radius, enclosing_of, enclosing_radius};
pub use problems::{
    balls_bound, balls_domain_bound, balls_domain_info, balls_domain_sample, get_balls_problem, piece_volume,
    plural_of, BallsBound,
};
pub use validate::{
    balls_config_errors, balls_config_errors_typed, balls_config_of_value, parse_balls_config, validate_balls,
    validate_balls_value, BallsConfig, BallsParsed, BallsPose, BallsValidateOptions, BallsValidation, BALLS_MAX_COORD, BALLS_MAX_SIZE, BALLS_TOL,
};
