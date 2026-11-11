//! Problem ids of the boundary space. Port of packages/boundary/src/ids.ts (what the server reaches).

use crate::bounds::container_pieces;
use crate::polytope::is_container_name;
use crate::types::{BoundaryProblem, PIECES};
use polypack_js::fmt::num;

/// packages/boundary/src/ids.ts: MAX_P
pub const MAX_P: f64 = 9999.0;

/// packages/boundary/src/ids.ts: isPieceName
pub fn is_piece_name(x: &str) -> bool {
    PIECES.contains(&x)
}

/// Parses `boundary/<polytope>/<piece>/<P>`, e.g. `boundary/tesseract/ball/9`. Exactly one written
/// form is accepted: lower-case names from the catalogue and P from 1 to 9999 without leading zeros
/// or signs. Returns the problem, or a plain sentence saying what is wrong.
/// packages/boundary/src/ids.ts: parseBoundaryId
pub fn parse_boundary_id(id: &str) -> Result<BoundaryProblem, String> {
    let parts: Vec<&str> = id.split('/').collect();
    if parts.len() != 4 || parts[0] != "boundary" {
        return Err(format!("\"{id}\" is not of the form boundary/<polytope>/<piece>/<P>."));
    }
    let (polytope, piece, ps) = (parts[1], parts[2], parts[3]);
    if !is_container_name(polytope) {
        return Err(format!("Unknown polytope \"{polytope}\"."));
    }
    if !is_piece_name(piece) {
        return Err(format!("Unknown piece \"{piece}\"."));
    }
    let allowed = container_pieces(polytope).expect("a container of the catalogue");
    if !allowed.contains(&piece) {
        return Err(format!("The {polytope} takes {} problems only, not \"{piece}\".", allowed.join(" and ")));
    }
    // /^[1-9][0-9]{0,3}$/
    let b = ps.as_bytes();
    let well_formed = (1..=4).contains(&b.len()) && (b'1'..=b'9').contains(&b[0]) && b[1..].iter().all(|c| c.is_ascii_digit());
    if !well_formed {
        return Err(format!("The piece count \"{ps}\" must be a whole number from 1 to {}, written without leading zeros.", num(MAX_P)));
    }
    Ok(BoundaryProblem { polytope: polytope.to_string(), piece: piece.to_string(), p: ps.parse::<f64>().expect("digits") })
}
