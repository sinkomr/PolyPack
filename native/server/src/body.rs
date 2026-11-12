//! A direct reader of the body of POST /api/submit: a fast path of app.rs.
//!
//! The source reads a body with `JSON.parse` and hands the tree to `parseConfig`. The port of that
//! (`polypack_js::json::parse`, then `polypack_flat::config::parse_config`) stays the definition.
//! But nearly all of a body is its `pieces`, up to 500 objects `{x, y, theta}`, and building a JSON
//! tree of them only to copy three numbers out of each costs as much as verifying the board.
//!
//! `read` reads the pieces straight into poses and everything else of the body into the same JSON
//! tree as before, with `"pieces": []` in the place of the pieces. It answers only when the pieces
//! are what `parse_config` accepts without an error: an array of at most MAX_PIECES objects, each
//! with finite numbers `x` and `y` within MAX_COORD and a number `theta` or none (0), no key
//! twice. For anything else (a body that is not JSON, pieces of another form, numbers JSON cannot
//! hold, text that is not UTF-8) it answers None, and the caller takes the defined path, which
//! also words the refusal. So the fast path never decides what is refused or why.
//!
//! `parse_config` on the tree that `read` returns gives the same result as on the whole body,
//! except that its `pieces` are empty; the caller puts the poses in. A test compares the two paths
//! (tests/app.rs: `the_direct_reader_of_a_body_agrees_with_the_tree`).

use std::fmt;

use polypack_flat::shapes::{Pose, MAX_COORD, MAX_PIECES};
use serde::de::{DeserializeSeed, Deserializer, Error, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

/// A body as `read` gives it.
pub struct DirectBody {
    /// The body as a JSON object, with an empty array where its pieces were.
    pub object: Map<String, Value>,
    /// The pieces, when the body has the key (without it `parse_config` reports that they are missing).
    pub pieces: Option<Vec<Pose>>,
}

/// The body read directly, or None when it is not of the plain form (see the module's text).
pub fn read(body: &[u8]) -> Option<DirectBody> {
    // the defined path decodes bytes that are not UTF-8 and drops a byte order mark
    let text = std::str::from_utf8(body).ok()?;
    if text.starts_with('\u{feff}') {
        return None;
    }
    let mut de = serde_json::Deserializer::from_str(text);
    let direct = de.deserialize_map(BodyVisitor).ok()?;
    // nothing but white space may follow, as for JSON.parse
    de.end().ok()?;
    Some(direct)
}

struct BodyVisitor;

impl<'de> Visitor<'de> for BodyVisitor {
    type Value = DirectBody;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<DirectBody, A::Error> {
        let mut object = Map::new();
        let mut pieces: Option<Vec<Pose>> = None;
        while let Some(key) = map.next_key::<String>()? {
            if key == "pieces" {
                if pieces.is_some() {
                    return Err(A::Error::custom("pieces twice"));
                }
                pieces = Some(map.next_value_seed(Pieces)?);
                object.insert(key, Value::Array(Vec::new()));
            } else {
                // a key given twice: the later value stands, in the place of the first, as in JavaScript
                let value: Value = map.next_value()?;
                object.insert(key, value);
            }
        }
        Ok(DirectBody { object, pieces })
    }
}

struct Pieces;

impl<'de> DeserializeSeed<'de> for Pieces {
    type Value = Vec<Pose>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Vec<Pose>, D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for Pieces {
    type Value = Vec<Pose>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of pieces")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<Pose>, A::Error> {
        let mut out: Vec<Pose> = Vec::with_capacity(seq.size_hint().unwrap_or(64).min(MAX_PIECES));
        while let Some(pose) = seq.next_element_seed(Piece)? {
            if out.len() == MAX_PIECES {
                return Err(A::Error::custom("too many pieces"));
            }
            out.push(pose);
        }
        Ok(out)
    }
}

struct Piece;

impl<'de> DeserializeSeed<'de> for Piece {
    type Value = Pose;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Pose, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Piece {
    type Value = Pose;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a piece {x, y, theta}")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Pose, A::Error> {
        let (mut x, mut y, mut theta): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
        while let Some(key) = map.next_key::<&str>()? {
            let slot = match key {
                "x" => &mut x,
                "y" => &mut y,
                "theta" => &mut theta,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                    continue;
                }
            };
            if slot.is_some() {
                return Err(A::Error::custom("a key twice"));
            }
            // a number, as JSON holds it: anything else (null, a text) is an error here
            *slot = Some(map.next_value::<f64>()?);
        }
        match (x, y) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() && x.abs() <= MAX_COORD && y.abs() <= MAX_COORD && theta.is_none_or(f64::is_finite) => Ok(Pose { x, y, theta: theta.unwrap_or(0.0) }),
            _ => Err(A::Error::custom("not a plain piece")),
        }
    }
}
