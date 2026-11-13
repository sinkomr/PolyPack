//! apps/server/src/pieces.ts: how the `pieces` column stores an arrangement.
//!
//! SQLite keeps a BLOB exactly as given, also in a column declared TEXT, so the three forms live
//! side by side in the same column:
//!  - BLOB whose length is a multiple of 24, the triples: little-endian Float64 [x, y, theta] per
//!    piece, 24 bytes each (the format written since 2026-10-18). Every double comes back bit for
//!    bit, -0 included;
//!  - BLOB of any other length, the packed form (written since 2026-11-14, see pack_pieces): the
//!    triples compressed without loss, to a little over half on the entries of November 2026;
//!  - TEXT holding a JSON array of {x, y, theta}: the oldest format (about 73 bytes per piece).
//! All three are read. The background migration (see SqliteStore::migrate_pieces) packs the first
//! and the last.

use std::borrow::Cow;

use serde_json::Value;

use super::db::JsVal;
use super::error::{Result, StoreError};
use super::json;
use super::types::{Pieces, Pose};

/// pieces.ts: PIECE_BYTES.
pub const PIECE_BYTES: usize = 24;

/// The packed form: a tag byte, the length of the triples and their CRC-32 (little-endian Uint32s),
/// one zstd frame of the doubles regrouped (every x, then every y, then every theta; like values
/// side by side compress better), and for tag 2 one zero byte. The writer takes tag 2 exactly when
/// tag 1 would give a length that is a multiple of 24, so the length alone tells a packed value
/// from triples, whatever the doubles are.
///
/// A packed value is read only when it is exactly that: one whole frame and nothing else, which
/// unpacks to the length written and to triples of the CRC-32 written. A value cut short or damaged
/// on disk is then refused instead of read as other pieces, and by the same rule in every
/// implementation (zstd libraries differ in what they make of a frame that is cut or followed by
/// other bytes, hence frame_length below).
const PACKED: u8 = 1;
const PACKED_PADDED: u8 = 2;
/// zstd's own default; level 6 gives 1 % more on real entries for twice the time (docs/DEPLOY_FLY.md).
const ZSTD_LEVEL: i32 = 3;
/// The most a packed value may unpack to, so that a damaged row cannot ask for the memory of the machine.
const UNPACKED_LIMIT: usize = 1 << 24;
/// Bytes of a packed value before its frame: the tag, the length of the triples and their CRC-32.
const PACKED_HEAD: usize = 9;

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

/// pieces.ts: regroup. The doubles of triples moved to the grouped order (every x, every y, every
/// theta), or back.
fn regroup(from: &[u8], to_triples: bool) -> Vec<u8> {
    let count = from.len() / PIECE_BYTES;
    let mut to = vec![0u8; from.len()];
    for piece in 0..count {
        for field in 0..3 {
            let triple = piece * PIECE_BYTES + field * 8;
            let grouped = (field * count + piece) * 8;
            let (source, target) = if to_triples { (grouped, triple) } else { (triple, grouped) };
            to[target..target + 8].copy_from_slice(&from[source..source + 8]);
        }
    }
    to
}

/// `crc32` of node:zlib: the CRC-32 of zlib and gzip.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(bytes);
    crc.sum()
}

/// pieces.ts: packPieces. The value to store for triples (see encode_pieces): the packed form when
/// that is shorter, and the triples themselves when it is not (a few pieces with nothing in common).
/// The frame is the one zstdCompressSync writes at this level: one call of the same library on the
/// whole input.
pub fn pack_pieces(triples: Vec<u8>) -> Result<Vec<u8>> {
    if triples.len() % PIECE_BYTES != 0 {
        return Err(StoreError::Range(format!(
            "pieces to pack have {} bytes, not a multiple of {PIECE_BYTES}",
            triples.len()
        )));
    }
    if triples.is_empty() || triples.len() > UNPACKED_LIMIT {
        return Ok(triples);
    }
    let frame = zstd::bulk::compress(&regroup(&triples, false), ZSTD_LEVEL)
        .map_err(|e| StoreError::Other(format!("zstd: {e}")))?;
    let padded = (PACKED_HEAD + frame.len()) % PIECE_BYTES == 0;
    let length = PACKED_HEAD + frame.len() + usize::from(padded);
    if length >= triples.len() {
        return Ok(triples);
    }
    let mut packed = Vec::with_capacity(length);
    packed.push(if padded { PACKED_PADDED } else { PACKED });
    packed.extend_from_slice(&(triples.len() as u32).to_le_bytes());
    packed.extend_from_slice(&crc32(&triples).to_le_bytes());
    packed.extend_from_slice(&frame);
    if padded {
        packed.push(0);
    }
    Ok(packed)
}

/// pieces.ts: frameLength. The length of the zstd frame that `bytes` begins with, from its header
/// and the headers of its blocks (RFC 8878, section 3.1.1), or None when they do not describe a
/// frame that ends within `bytes`. Skippable frames and dictionaries, which pack_pieces never
/// writes, are not frames here.
fn frame_length(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 6 || bytes[0..4] != [0x28, 0xb5, 0x2f, 0xfd] {
        return None;
    }
    let descriptor = bytes[4] as usize;
    let single_segment = (descriptor >> 5) & 1;
    // a reserved bit, or a dictionary
    if descriptor & 0x0b != 0 {
        return None;
    }
    let content_size = [single_segment, 2, 4, 8][descriptor >> 6];
    let mut at = 5 + (1 - single_segment) + content_size;
    loop {
        if at + 3 > bytes.len() {
            return None;
        }
        let header = bytes[at] as usize | (bytes[at + 1] as usize) << 8 | (bytes[at + 2] as usize) << 16;
        let kind = (header >> 1) & 3;
        if kind == 3 {
            return None;
        }
        // a run-length block holds one byte, whatever size it unpacks to
        at += 3 + if kind == 1 { 1 } else { header >> 3 };
        if header & 1 == 1 {
            break;
        }
    }
    // the four bytes of a content checksum
    at += descriptor & 4;
    (at <= bytes.len()).then_some(at)
}

/// pieces.ts: unpackPieces. The triples of a stored BLOB in either form.
pub fn unpack_pieces(bytes: &[u8]) -> Result<Cow<'_, [u8]>> {
    if bytes.len() % PIECE_BYTES == 0 {
        return Ok(Cow::Borrowed(bytes));
    }
    let tag = bytes[0];
    if tag != PACKED && tag != PACKED_PADDED {
        return Err(StoreError::Range(format!(
            "stored pieces have {} bytes, not a multiple of {PIECE_BYTES}, and are not packed (they begin with {tag})",
            bytes.len()
        )));
    }
    let refuse = || StoreError::Range(format!("stored pieces of {} bytes cannot be unpacked", bytes.len()));
    let end = bytes.len() - usize::from(tag == PACKED_PADDED);
    if end <= PACKED_HEAD || (tag == PACKED_PADDED && bytes[end] != 0) {
        return Err(refuse());
    }
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes"));
    let length = word(1) as usize;
    if length == 0 || length % PIECE_BYTES != 0 || length > UNPACKED_LIMIT {
        return Err(refuse());
    }
    let frame = &bytes[PACKED_HEAD..end];
    if frame_length(frame) != Some(frame.len()) {
        return Err(refuse());
    }
    // a frame that holds more than `length` does not fit, which is an error here
    let grouped = zstd::bulk::decompress(frame, length).map_err(|_| refuse())?;
    if grouped.len() != length {
        return Err(refuse());
    }
    let triples = regroup(&grouped, true);
    if crc32(&triples) != word(5) {
        return Err(refuse());
    }
    Ok(Cow::Owned(triples))
}

/// pieces.ts: decodePieces. The arrangement held by a stored BLOB in either form.
pub fn decode_pieces(stored: &[u8]) -> Result<Vec<Pose>> {
    let bytes = unpack_pieces(stored)?;
    let f = |b: &[u8]| f64::from_le_bytes(b.try_into().expect("eight bytes"));
    Ok(bytes
        .chunks_exact(PIECE_BYTES)
        .map(|c| Pose { x: f(&c[0..8]), y: f(&c[8..16]), theta: f(&c[16..24]) })
        .collect())
}

/// pieces.ts: readPieces. The arrangement held by a `pieces` value in any form.
pub fn read_pieces(value: &JsVal) -> Result<Pieces> {
    match value {
        JsVal::Blob(bytes) => Ok(Pieces::Poses(decode_pieces(bytes)?)),
        JsVal::Text(text) => Ok(Pieces::Json(json::parse(text)?)),
        other => Err(StoreError::Type(format!("unexpected stored pieces of type {}", other.type_of()))),
    }
}

/// pieces.ts: blobFromJson. The triples for a value in the oldest, JSON format, or None when the text is
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
