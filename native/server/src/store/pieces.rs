//! apps/server/src/pieces.ts: how the `pieces` column stores an arrangement.
//!
//! SQLite keeps a BLOB exactly as given, also in a column declared TEXT, so the two forms live side
//! by side in the same column:
//!  - BLOB: little-endian Float64 triples [x, y, theta] per piece, 24 bytes each (the format
//!    written since 2026-10-18). Every double comes back bit for bit, -0 included;
//!  - TEXT holding a JSON array of {x, y, theta}: the older format (about 73 bytes per piece),
//!    still read, and converted by the background migration (see SqliteStore::migrate_pieces).

use serde_json::Value;

use super::db::JsVal;
use super::error::{Result, StoreError};
use super::json;
use super::types::{Pieces, Pose};

/// pieces.ts: PIECE_BYTES.
pub const PIECE_BYTES: usize = 24;

/// pieces.ts: encodePieces.
pub fn encode_pieces(pieces: &[Pose]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(pieces.len() * PIECE_BYTES);
    for p in pieces {
        bytes.extend_from_slice(&p.x.to_le_bytes());
        bytes.extend_from_slice(&p.y.to_le_bytes());
        bytes.extend_from_slice(&p.theta.to_le_bytes());
    }
    bytes
}

/// pieces.ts: decodePieces.
pub fn decode_pieces(bytes: &[u8]) -> Result<Vec<Pose>> {
    if bytes.len() % PIECE_BYTES != 0 {
        return Err(StoreError::Range(format!(
            "stored pieces have {} bytes, not a multiple of {PIECE_BYTES}",
            bytes.len()
        )));
    }
    let f = |b: &[u8]| f64::from_le_bytes(b.try_into().expect("eight bytes"));
    Ok(bytes
        .chunks_exact(PIECE_BYTES)
        .map(|c| Pose { x: f(&c[0..8]), y: f(&c[8..16]), theta: f(&c[16..24]) })
        .collect())
}

/// pieces.ts: readPieces. The arrangement held by a `pieces` value in either form.
pub fn read_pieces(value: &JsVal) -> Result<Pieces> {
    match value {
        JsVal::Blob(bytes) => Ok(Pieces::Poses(decode_pieces(bytes)?)),
        JsVal::Text(text) => Ok(Pieces::Json(json::parse(text)?)),
        other => Err(StoreError::Type(format!("unexpected stored pieces of type {}", other.type_of()))),
    }
}

/// pieces.ts: blobFromJson. The BLOB for a value in the older JSON format, or None when the text is
/// not exactly a list of {x, y, theta} with finite numbers: such a row is left as it is rather than
/// changed by guesswork.
pub fn blob_from_json(text: &str) -> Option<Vec<u8>> {
    let parsed = json::parse(text).ok()?;
    let Value::Array(list) = parsed else {
        return None;
    };
    let mut poses = Vec::with_capacity(list.len());
    for p in &list {
        let Value::Object(o) = p else {
            return None;
        };
        if o.len() != 3 {
            return None;
        }
        let x = json::finite_number(o.get("x"))?;
        let y = json::finite_number(o.get("y"))?;
        let theta = json::finite_number(o.get("theta"))?;
        poses.push(Pose { x, y, theta });
    }
    Some(encode_pieces(&poses))
}
