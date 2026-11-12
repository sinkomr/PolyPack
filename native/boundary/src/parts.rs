//! Pieces and their parts in the cells. Port of packages/boundary/src/parts.ts (the functions the
//! server reaches).
//!
//! A piece X (unit ball, or a Platonic solid of edge 1) with pose (anchor cell, centre u, rotation
//! q) sits in the anchor's local frame as y = R(q) p + u for p in X (piece-local coordinates). It is
//! developed from u (chains.rs); for every chain C ending in cell c, its part in c is
//!
//!   X ∩ (developed c) ∩ W(C),   mapped into c's own frame by the inverse development.
//!
//! In PiecePart terms: `place` = (c's frame -> anchor frame)^-1 ∘ (piece-local -> anchor frame), and
//! `clip` = the window's planes written in c's frame. The cell's own facets bound the part too.
//! Parts without interior are left out (a cube exactly filling its cell touches the neighbours
//! only along faces).

use crate::chains::{clamp_to_cell, enumerate_chains, ridge_snap, ChainLimitError, ChainNode, ChainOptions};
use crate::linalg::{iso_apply, iso_compose, iso_inverse, iso_linear, iso_linear_t, iso_to_affine, quaternion_to_matrix, Iso3, V3};
use crate::pieces::{is_polytope_piece, piece_shape, PieceShape};
use crate::polyhedron::{clip_polyhedron, polyhedron_from, polyhedron_thickness, Face, Polyhedron};
use crate::polytope::{topo, Polytope};
use crate::types::{BoundaryPiece, HalfSpace, PiecePart};
use crate::units::BALL_RADIUS;
use polypack_js::math;

/// The piece's circumradius: the reach of its development from its centre (a ball's radius 1/2, site units).
/// packages/boundary/src/parts.ts: pieceReach
pub fn piece_reach(piece: &str) -> f64 {
    if piece == "ball" {
        BALL_RADIUS
    } else {
        piece_shape(piece).expect("pieceReach: a Platonic piece").circumradius
    }
}

/// Piece-local -> anchor-local coordinates: y = R(q) p + u (no rotation for balls or an absent q).
/// packages/boundary/src/parts.ts: piecePose
pub fn piece_pose(piece: &str, p: &BoundaryPiece) -> Result<Iso3, String> {
    if piece != "ball" && !is_polytope_piece(piece) {
        return Err(format!("piecePose: unknown piece {piece}"));
    }
    let m = match (&p.q, piece != "ball") {
        (Some(q), true) => quaternion_to_matrix(q),
        _ => [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
    };
    Ok(Iso3 { m, t: [p.u[0], p.u[1], p.u[2]] })
}

/// A piece developed from its centre: the clamped centre, its pose and its chains.
/// packages/boundary/src/parts.ts: Development
#[derive(Clone, Debug)]
pub struct Development {
    /// Centre in the anchor frame, clamped into the closed anchor cell and snapped (opts.snap).
    pub u: V3,
    /// How far the snap moved the clamped centre (0 when it lies on no facet plane within the snap).
    pub snapped: f64,
    pub pose: Iso3,
    pub nodes: Vec<ChainNode>,
}

/// An error of `develop_piece`: the chain limit (which the validator turns into a reason) or any other throw.
#[derive(Clone, Debug, PartialEq)]
pub enum DevelopError {
    ChainLimit(ChainLimitError),
    Other(String),
}

/// packages/boundary/src/parts.ts: developPiece (reach defaults to pieceReach(piece) there)
pub fn develop_piece(poly: &Polytope, piece: &str, p: &BoundaryPiece, s: f64, reach: f64, opts: &ChainOptions) -> Result<Development, DevelopError> {
    let u = clamp_to_cell(poly, p.cell, &p.u, s, opts.snap.unwrap_or_else(|| ridge_snap(s, None)));
    let c = clamp_to_cell(poly, p.cell, &p.u, s, 0.0);
    let mut pose = piece_pose(piece, p).map_err(DevelopError::Other)?;
    pose.t = u;
    let nodes = enumerate_chains(poly, s, p.cell, &u, reach, opts).map_err(DevelopError::ChainLimit)?;
    Ok(Development { u, snapped: math::hypot3(u[0] - c[0], u[1] - c[1], u[2] - c[2]), pose, nodes })
}

/// The window of a chain as half-spaces { y : n . y <= h } in the frame of the chain's last cell.
/// packages/boundary/src/parts.ts: windowInCell
pub fn window_in_cell(node: &ChainNode, u: V3) -> Vec<HalfSpace> {
    let t = &node.to_anchor;
    // N . (T y - u) >= 0  <=>  (-M^T N) . y <= N . (t - u)
    node.window
        .iter()
        .map(|nn| {
            let n = iso_linear_t(t, *nn);
            HalfSpace { n: vec![-n[0], -n[1], -n[2]], h: nn[0] * (t.t[0] - u[0]) + nn[1] * (t.t[1] - u[1]) + nn[2] * (t.t[2] - u[2]) }
        })
        .collect()
}

/// Clipping tolerance of part_polyhedron, in piece units (independent of s).
pub const PART_CLIP_EPS: f64 = 1e-12;

/// The part of a polytope piece in a cell, as a convex polyhedron in that cell's frame: the placed
/// piece clipped by the cell's facets (at edge s) and by `clip`.
///
/// Scale-free: the clipping runs in coordinates relative to the piece's developed centre c =
/// place(0), where the piece's vertices are O(1) whatever s is; a half-space n . y <= h becomes
/// n . (y - c) <= h - n . c, whose offset carries only the rounding of h and c (about 1e-16 s).
/// Vertices within PART_CLIP_EPS (piece units, independent of s) of a plane count as on it. The
/// result is translated back by c.
/// packages/boundary/src/parts.ts: partPolyhedron
pub fn part_polyhedron(poly: &Polytope, cell: usize, place: &Iso3, clip: &[HalfSpace], s: f64, shape: &PieceShape) -> Polyhedron {
    let c = place.t;
    let rel = Iso3 { m: place.m, t: [0.0, 0.0, 0.0] };
    let verts: Vec<V3> = shape.vertices.iter().map(|&v| iso_apply(&rel, v)).collect();
    let mut p = polyhedron_from(&verts, &shape.faces);
    // the faces' normals are exact images of the piece's face normals (an orientation-reversing place keeps them outward)
    p = Polyhedron { faces: p.faces.into_iter().enumerate().map(|(i, f)| Face { verts: f.verts, n: iso_linear(place, shape.normals[i]) }).collect() };
    if iso_det3(place) < 0.0 {
        p = Polyhedron {
            faces: p
                .faces
                .into_iter()
                .map(|mut f| {
                    f.verts.reverse();
                    f
                })
                .collect(),
        };
    }
    let nc = |n: &[f64]| -> f64 { n[0] * c[0] + n[1] * c[1] + n[2] * c[2] };
    for pl in &topo(poly).cells[cell].planes {
        p = clip_polyhedron(p, pl.n, pl.h * s - nc(&pl.n), PART_CLIP_EPS);
        if p.faces.is_empty() {
            return p;
        }
    }
    for h in clip {
        p = clip_polyhedron(p, [h.n[0], h.n[1], h.n[2]], h.h - nc(&h.n), PART_CLIP_EPS);
        if p.faces.is_empty() {
            return p;
        }
    }
    Polyhedron { faces: p.faces.into_iter().map(|f| Face { verts: f.verts.iter().map(|v| [v[0] + c[0], v[1] + c[1], v[2] + c[2]]).collect(), n: f.n }).collect() }
}

fn iso_det3(t: &Iso3) -> f64 {
    let m = &t.m;
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
}

/// Parts thinner than this (in piece units) are dropped: they cannot hide an overlap deeper than it.
pub const PART_EPS: f64 = 1e-12;

/// One part of a developed piece. packages/boundary/src/parts.ts: partsOfDevelopment's element
#[derive(Clone, Debug)]
pub struct DevelopedPart {
    pub part: PiecePart,
    pub place: Iso3,
    pub poly: Option<Polyhedron>,
}

/// The parts of one developed piece, with the cell-frame polyhedron for polytope pieces.
/// packages/boundary/src/parts.ts: partsOfDevelopment
pub fn parts_of_development(poly: &Polytope, piece: &str, index: usize, dev: &Development, s: f64) -> Vec<DevelopedPart> {
    let mut out: Vec<DevelopedPart> = Vec::new();
    let r = piece_reach(piece);
    for node in &dev.nodes {
        let place = iso_compose(&iso_inverse(&node.to_anchor), &dev.pose);
        let clip = window_in_cell(node, dev.u);
        let mut p: Option<Polyhedron> = None;
        if piece == "ball" {
            // the ball reaches into the cell exactly when some ray of the window crosses the gate before length 1
            if node.depth > 0 && node.gate_dist >= r - PART_EPS {
                continue;
            }
        } else {
            let ph = part_polyhedron(poly, node.cell, &place, &clip, s, piece_shape(piece).expect("a Platonic piece"));
            if ph.faces.is_empty() || polyhedron_thickness(&ph) <= PART_EPS {
                continue;
            }
            p = Some(ph);
        }
        // a ball is drawn as the unit ball under place.A, so its A carries the radius (the isometry times BALL_RADIUS)
        let mut affine = iso_to_affine(&place);
        if piece == "ball" {
            affine.a = affine.a.iter().map(|row| row.iter().map(|x| x * BALL_RADIUS).collect()).collect();
        }
        out.push(DevelopedPart { part: PiecePart { piece: index, cell: node.cell, chain: node.cells.clone(), place: affine, clip }, place, poly: p });
    }
    out
}
