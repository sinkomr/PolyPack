//! Lower bounds on s for balls of diameter 1 on the boundary of a regular 4-polytope of edge s, and
//! the facts about each container that they rest on (docs/spaces/BOUNDARY.md section 5).
//! Port of packages/boundary/src/bounds.ts.
//!
//!  - Volume: developments are local isometries, injective on interiors, with disjoint images, so P
//!    balls of volume pi/6 fit only if P pi / 6 <= V s^3, V the volume of the boundary at s = 1
//!    (cells x the cell's volume).
//!  - One piece: a ball's centre needs distance >= 1/2 from every hinge, and every point of a
//!    regular cell lies within rho of an edge of the cell, rho the distance from the cell's centre
//!    to its edges (the midradius of the cell). Proof: a point p of the cell lies on a segment from
//!    the centre O to a point q of a facet F of the cell; q lies within the inradius r_F of a
//!    regular polygon F of the boundary of F, i.e. within r_F of an edge e of F; the distance to the
//!    convex set e is convex, so d(p, e) <= (1 - t) d(O, e) + t d(q, e) <= max(rho, r_F) = rho, as
//!    rho^2 = h^2 + r_F^2 for the distance h of O to F's plane. So s rho >= 1/2.
//!
//! The tesseract's bounds are exact (kernel_validate.rs boundary_bound). For the other containers
//! the floats below are rounded down by a relative 1e-15 (far above the rounding of the few
//! operations; the exact check in python/boundary/general.py tests every stored bound against the
//! exact value).

use crate::ncube::bounds::{ncube_check_ms, ncube_max_p};
use crate::ncube::lattice::is_ncube_name;
use crate::nd::bounds::nd_check_ms;
use crate::nd::names::{is_nd_name, ND_MAX_P};
use crate::pieces::piece_shape;
use polypack_js::math;

fn phi() -> f64 {
    (1.0 + 5f64.sqrt()) / 2.0
}

/// What the bounds need of a container, at unit edge.
/// packages/boundary/src/bounds.ts: ContainerFacts
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContainerFacts {
    pub cells: usize,
    /// The cell: tetrahedron, cube, octahedron or dodecahedron.
    pub cell: &'static str,
    /// Volume of one cell, and of the whole boundary.
    pub cell_volume: f64,
    pub boundary_volume: f64,
    /// Distance from the cell's centre to its edges (rho above) and to its facet planes (the inradius).
    pub midradius: f64,
    pub inradius: f64,
    /// Cells around each edge and the total angle there, in degrees (the full turn minus the deficit).
    pub cells_at_edge: usize,
    pub cone_angle: f64,
}

/// (volume, midradius, inradius) of a cell shape. packages/boundary/src/bounds.ts: CELL
fn cell_facts(cell: &str) -> (f64, f64, f64) {
    match cell {
        "tetrahedron" => (2f64.sqrt() / 12.0, 1.0 / (2.0 * math::SQRT2), 6f64.sqrt() / 12.0),
        "cube" => (1.0, math::SQRT1_2, 0.5),
        "octahedron" => (math::SQRT2 / 3.0, 0.5, 6f64.sqrt() / 6.0),
        _ => ((15.0 + 7.0 * 5f64.sqrt()) / 4.0, (phi() * phi()) / 2.0, (250.0 + 110.0 * 5f64.sqrt()).sqrt() / 20.0),
    }
}

/// (cell, cells, cellsAtEdge, coneAngle). packages/boundary/src/bounds.ts: SHAPE
fn shape_facts(name: &str) -> Option<(&'static str, usize, usize, f64)> {
    Some(match name {
        "5cell" => ("tetrahedron", 5, 3, 211.58633809652784),
        "tesseract" => ("cube", 8, 3, 270.0),
        "16cell" => ("tetrahedron", 16, 4, 282.1151174620371),
        "24cell" => ("octahedron", 24, 3, 328.4136619034721),
        "120cell" => ("dodecahedron", 120, 3, 349.6951535312339),
        "600cell" => ("tetrahedron", 600, 5, 352.6438968275464),
        _ => return None,
    })
}

/// packages/boundary/src/bounds.ts: containerFacts
pub fn container_facts(name: &str) -> Option<ContainerFacts> {
    let (cell, cells, cells_at_edge, cone_angle) = shape_facts(name)?;
    let (volume, midradius, inradius) = cell_facts(cell);
    Some(ContainerFacts { cells, cell, cell_volume: volume, boundary_volume: cells as f64 * volume, midradius, inradius, cells_at_edge, cone_angle })
}

/// The two proven lower bounds of a problem and the larger.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PieceBounds {
    pub volume: f64,
    pub one_piece: f64,
    pub value: f64,
    /// "volume" or "one piece".
    pub kind: &'static str,
}

/// The proven lower bounds on s of P balls on a container other than the tesseract, and the larger.
/// packages/boundary/src/bounds.ts: ballBounds
pub fn ball_bounds(name: &str, p: f64) -> Option<PieceBounds> {
    let f = container_facts(name)?;
    let down = 1.0 - 1e-15;
    let volume = math::cbrt((p * math::PI) / 6.0 / f.boundary_volume) * down;
    let one_piece = (1.0 / (2.0 * f.midradius)) * down;
    Some(if volume > one_piece { PieceBounds { volume, one_piece, value: volume, kind: "volume" } } else { PieceBounds { volume, one_piece, value: one_piece, kind: "one piece" } })
}

/// The proven lower bounds on s of P Platonic pieces on a 4-polytope's boundary, and the larger
/// (docs/spaces/BOUNDARY.md 4C.4).
///  - Volume: developments are injective on interiors with disjoint images, so P V_piece <= V_boundary s^3.
///  - One piece: the piece contains the ball of its inradius r about its centre, and that ball must
///    be a valid ball; its centre needs distance >= r from every hinge, and every point of a cell
///    lies within s rho of its edges (rho the cell's midradius, 4A.4). So s >= r / rho.
/// Each stored as a binary64 rounded down by a relative 1e-15, like the ball bounds. On the
/// tesseract the cube is not listed here (its records' bounds are kernel_validate.rs
/// boundary_bound); the other four pieces are.
/// packages/boundary/src/bounds.ts: pieceBounds
pub fn piece_bounds(name: &str, piece: &str, p: f64) -> Option<PieceBounds> {
    let f = container_facts(name)?;
    let sh = piece_shape(piece)?;
    let down = 1.0 - 1e-15;
    let volume = math::cbrt((p * sh.volume) / f.boundary_volume) * down;
    let one_piece = (sh.inradius / f.midradius) * down;
    Some(if volume > one_piece { PieceBounds { volume, one_piece, value: volume, kind: "volume" } } else { PieceBounds { volume, one_piece, value: one_piece, kind: "one piece" } })
}

const ALL_PIECES: [&str; 6] = ["ball", "cube", "tetrahedron", "octahedron", "dodecahedron", "icosahedron"];

/// Which pieces each container takes. The five regular 4-polytopes besides the tesseract take balls
/// and all five Platonic solids, freely rotated (so "cube" there is a rotated cube); the tesseract
/// takes balls, its axis-aligned cubes (the records' problems) and the other four solids; the
/// d-cubes (d = 5..10) take balls and axis-aligned cubes; the simplex, orthoplex and demicube
/// (d = 5..10) take balls only.
/// packages/boundary/src/bounds.ts: CONTAINER_PIECES
pub fn container_pieces(name: &str) -> Option<&'static [&'static str]> {
    if is_ncube_name(name) {
        return Some(&["ball", "cube"]);
    }
    if is_nd_name(name) {
        return Some(&["ball"]);
    }
    if crate::polytope::is_polytope_name(name) {
        return Some(&ALL_PIECES);
    }
    None
}

/// The largest P of each container in the catalogue: the tesseract's 16, 24 for the other
/// 4-polytopes and the nD containers, the d-cubes' own.
/// packages/boundary/src/bounds.ts: CONTAINER_MAX_P
pub fn container_max_p(name: &str) -> Option<usize> {
    if let Some(p) = ncube_max_p(name) {
        return Some(p);
    }
    if is_nd_name(name) {
        return Some(ND_MAX_P);
    }
    Some(match name {
        "tesseract" => 16,
        "5cell" | "16cell" | "24cell" | "120cell" | "600cell" => 24,
        _ => return None,
    })
}

/// Milliseconds of validation per ball of the TypeScript validator (validateBoundary at tolerance
/// 1e-9, one machine core, [CALC] 2026-11-01): the measured cost of loose random layouts at P = 24
/// divided by 24, times 3 for tight packings, raised after review to cover 24-ball crowds. The
/// chain stage dominates, so a container with small cells relative to the ball costs most.
/// packages/boundary/src/bounds.ts: BOUNDARY_BALL_MS
pub fn boundary_ball_ms(name: &str) -> Option<f64> {
    Some(match name {
        "tesseract" => 0.3,
        "5cell" => 1.0,
        "16cell" => 0.8,
        "24cell" => 2.3,
        "600cell" => 2.0,
        "120cell" => 12.0,
        _ => return None,
    })
}

/// Milliseconds of validation per Platonic piece of the TypeScript validator (at tolerance 1e-9
/// with the server's 1024 chains, one machine core, [CALC] 2026-11-02), with 1.5 times headroom
/// over the worst measured, rounded up.
/// packages/boundary/src/bounds.ts: BOUNDARY_SOLID_MS
pub fn boundary_solid_ms(name: &str) -> Option<f64> {
    Some(match name {
        "tesseract" => 4.0,
        "5cell" => 6.0,
        "16cell" => 5.0,
        "24cell" => 4.0,
        "120cell" => 11.0,
        "600cell" => 2.0,
        _ => return None,
    })
}

/// Estimated milliseconds of the server's check of a configuration of P pieces. A solid costs
/// BOUNDARY_SOLID_MS each (the tesseract's aligned cubes, which have no chains to speak of, 0.3
/// each). An unknown container gives NaN, as the source's `undefined * P`.
/// packages/boundary/src/bounds.ts: boundaryCheckMs
pub fn boundary_check_ms(polytope: &str, piece: &str, p: f64) -> f64 {
    if is_nd_name(polytope) {
        return nd_check_ms(polytope, p);
    }
    if is_ncube_name(polytope) {
        return ncube_check_ms(polytope, piece, p);
    }
    if piece == "ball" {
        return boundary_ball_ms(polytope).unwrap_or(f64::NAN) * p;
    }
    if piece == "cube" && polytope == "tesseract" {
        return 0.3 * p;
    }
    boundary_solid_ms(polytope).unwrap_or(f64::NAN) * p
}

/// A check of at least this many milliseconds waits its turn in the server's heavy queue.
/// packages/boundary/src/bounds.ts: BOUNDARY_HEAVY_MS
pub const BOUNDARY_HEAVY_MS: f64 = 50.0;

/// packages/boundary/src/bounds.ts: boundaryIsHeavy
pub fn boundary_is_heavy(polytope: &str, piece: &str, p: f64) -> bool {
    boundary_check_ms(polytope, piece, p) >= BOUNDARY_HEAVY_MS
}
