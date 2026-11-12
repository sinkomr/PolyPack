//! The contract of the boundary space: equal (d-1)-dimensional pieces packed on the boundary of a
//! convex d-polytope. Port of packages/boundary/src/types.ts (the shapes the server reaches).
//!
//! The boundary is a closed (d-1)-dimensional space made of flat cells (the polytope's facets),
//! glued along their own facets (the polytope's ridges: 2-faces for d = 4). All its curvature sits
//! on the (d-3)-faces (the edges for d = 4), where the cells around fall short of a full turn. A
//! piece is placed in one cell (its anchor) and may fold across ridges into neighbouring cells, but
//! no point of the (d-3)-skeleton may lie in its interior.
//!
//! Units: a ball has diameter 1 (radius 1/2, BALL_RADIUS in units.rs), a polytope piece has edge 1;
//! the score s is the container's edge length, smaller is better. Every length below is given at
//! s = 1 and scales with s, except piece sizes, which stay 1.
//!
//! Names are strings, as in the source: a `PolytopeName` is one of POLYTOPES, a `ContainerName` one
//! of CONTAINERS, a `PieceName` one of PIECES.

use serde::{Deserialize, Serialize};

/// One of POLYTOPES: "tesseract", "5cell", "16cell", "24cell", "120cell", "600cell".
pub type PolytopeName = str;
/// One of CONTAINERS: a 4-polytope, a d-cube ("5cube".."10cube") or an nD container ("5simplex".."10demicube").
pub type ContainerName = str;
/// One of PIECES.
pub type PieceName = str;

/// Containers that are 4-polytopes. packages/boundary/src/types.ts: POLYTOPES
pub const POLYTOPES: [&str; 6] = ["tesseract", "5cell", "16cell", "24cell", "120cell", "600cell"];

/// Every container of the catalogue: the regular 4-polytopes, the d-cubes for d = 5..10 (ncube/) and
/// the d-simplex, d-orthoplex and d-demicube for d = 5..10 (nd/, balls only), in the source's order
/// [...POLYTOPES, ...NCUBE_NAMES, ...ND_NAMES]. packages/boundary/src/types.ts: CONTAINERS
pub const CONTAINERS: [&str; 30] = [
    "tesseract", "5cell", "16cell", "24cell", "120cell", "600cell",
    "5cube", "6cube", "7cube", "8cube", "9cube", "10cube",
    "5simplex", "6simplex", "7simplex", "8simplex", "9simplex", "10simplex",
    "5orthoplex", "6orthoplex", "7orthoplex", "8orthoplex", "9orthoplex", "10orthoplex",
    "5demicube", "6demicube", "7demicube", "8demicube", "9demicube", "10demicube",
];

/// Pieces. A ball is the (d-1)-ball of diameter 1; the others are unit-edge regular (d-1)-polytopes.
/// On the tesseract "cube" is the axis-aligned cube of its records; on the other 4-polytopes it is a
/// freely rotated cube; on the d-cubes (d = 5..10) the axis-aligned (d-1)-cube.
/// packages/boundary/src/types.ts: PIECES
pub const PIECES: [&str; 6] = ["ball", "cube", "tetrahedron", "octahedron", "dodecahedron", "icosahedron"];

/// A problem: P pieces of one kind on one polytope. Its id is written
/// `boundary/<polytope>/<piece>/<P>`. `p` is a JavaScript number in the source, so it is an `f64`
/// here: the validator itself refuses a P that is not a whole number.
/// packages/boundary/src/types.ts: BoundaryProblem
#[derive(Clone, Debug, PartialEq)]
pub struct BoundaryProblem {
    pub polytope: String,
    pub piece: String,
    pub p: f64,
}

impl BoundaryProblem {
    pub fn new(polytope: &str, piece: &str, p: usize) -> Self {
        BoundaryProblem { polytope: polytope.to_string(), piece: piece.to_string(), p: p as f64 }
    }
}

/// A unit quaternion (w, x, y, z): a rotation of 3-space, for d = 4.
pub type Quaternion = [f64; 4];

/// One piece of a configuration.
///  - `cell`: index of the anchor cell, the cell that holds the piece's centre.
///  - `u`: the centre in the anchor cell's local coordinates (d-1 numbers) at the configuration's s,
///    the cell's centre at the origin. It must lie in the closed cell.
///  - `q`: rotation of the piece from its standard pose, in the anchor cell's local frame (d = 4).
///    Absent for balls; absent means no rotation for the other pieces.
/// packages/boundary/src/types.ts: BoundaryPiece
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BoundaryPiece {
    pub cell: usize,
    pub u: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q: Option<Quaternion>,
}

/// A configuration: the container's edge s (the score) and the pieces.
/// packages/boundary/src/types.ts: BoundaryConfig
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BoundaryConfig {
    pub s: f64,
    pub pieces: Vec<BoundaryPiece>,
}

/// An affine map of R^n: y = A x + b (A row-major, n x n).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Affine {
    #[serde(rename = "A")]
    pub a: Vec<Vec<f64>>,
    pub b: Vec<f64>,
}

/// A closed half-space { y : n . y <= h } of R^n.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HalfSpace {
    pub n: Vec<f64>,
    pub h: f64,
}

/// A facet of a cell (a ridge of the polytope), in the cell's local coordinates at s = 1: the cell
/// lies in `inside`. Across it the cell is glued to `neighbor`.
///
/// `to_neighbor` is the gluing as the development sees it: for a point y written in this cell's
/// local frame but lying beyond this facet (the neighbour unfolded flat into this cell's
/// hyperplane), `to_neighbor` gives its coordinates in the neighbour's local frame. It is an
/// isometry and fixes the shared ridge pointwise. At edge s its translation scales by s:
/// y' = A y + s b. The neighbour's matching facet holds the inverse map.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellFacet {
    pub inside: HalfSpace,
    pub neighbor: usize,
    /// Index of the matching facet in the neighbour's `facets`.
    pub neighbor_facet: usize,
    pub to_neighbor: Affine,
    /// The ridge polygon: indices into the cell's `vertices`, in cyclic order, counter-clockwise
    /// seen from outside the cell (around `inside.n`).
    pub vertices: Vec<usize>,
}

/// A cell (a facet of the polytope) at s = 1. Local coordinates u map to the ambient space by
/// x = origin + sum_k u_k frame[k] (scaled by s: x = s origin + sum_k u_k frame[k]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub index: usize,
    /// Outward unit normal of the cell's hyperplane in R^d.
    pub normal: Vec<f64>,
    /// The cell's centre in R^d, the origin of its local coordinates.
    pub origin: Vec<f64>,
    /// d-1 orthonormal vectors of R^d spanning the cell's hyperplane: the local axes.
    pub frame: Vec<Vec<f64>>,
    /// The cell's vertices in local coordinates.
    pub vertices: Vec<Vec<f64>>,
    /// The cell's (d-3)-faces (edges for d = 4) as pairs of indices into `vertices`: the singular set.
    pub hinges: Vec<[usize; 2]>,
    pub facets: Vec<CellFacet>,
    /// Index in Polytope.vertices of each entry of `vertices` (ascending).
    pub vertex_ids: Vec<usize>,
}

/// Why a configuration is invalid, or that it is valid, by the float rule (tolerance tol).
/// packages/boundary/src/types.ts: BoundaryVerdict
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BoundaryVerdict {
    pub ok: bool,
    /// The configuration's s when it is valid.
    pub score: Option<f64>,
    /// Plain sentences, empty when valid.
    pub reasons: Vec<String>,
}

/// The part of a piece that lies in one cell, for drawing and checking (see parts.rs).
/// packages/boundary/src/types.ts: PiecePart
#[derive(Clone, Debug, PartialEq)]
pub struct PiecePart {
    /// Index into the configuration's pieces.
    pub piece: usize,
    /// The cell holding this part.
    pub cell: usize,
    /// Cells crossed from the anchor, anchor first, this cell last (length 1 for the anchor's own part).
    pub chain: Vec<usize>,
    /// Piece-local coordinates -> this cell's local coordinates, at the configuration's s.
    pub place: Affine,
    /// Half-spaces in this cell's local coordinates, besides the cell's own, that bound the part.
    pub clip: Vec<HalfSpace>,
}
