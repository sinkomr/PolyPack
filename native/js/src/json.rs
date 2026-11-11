//! `JSON.stringify` in Rust: serde_json with JavaScript's number text.
//!
//! serde_json writes the float 2.0 as `2.0` and 1e21 as `1e21`; JavaScript writes `2` and `1e+21`.
//! An API answer of the Rust server must be the same text as the TypeScript server's, so every
//! answer is written with `stringify` (or `stringify_pretty` for `JSON.stringify(v, null, n)`).
//!
//! What the caller must still arrange, because serde cannot know it:
//!  - a field that is `undefined` in JavaScript is left out: `#[serde(skip_serializing_if = ...)]`;
//!  - keys come in the order the source builds the object: the field order of a struct, or a
//!    `serde_json::Map` with the `preserve_order` feature;
//!  - a number that JavaScript holds as a double but Rust holds as an integer prints the same up to
//!    2^53; beyond that keep it in an `f64`.
//! NaN and the infinities are written as `null`, as in JavaScript.

use crate::fmt;
use serde::Serialize;
use serde_json::ser::{CompactFormatter, Formatter, PrettyFormatter};
use std::io;

/// Compact output with JavaScript's numbers.
#[derive(Default)]
pub struct JsCompact(CompactFormatter);

impl Formatter for JsCompact {
    fn write_f64<W: ?Sized + io::Write>(&mut self, w: &mut W, v: f64) -> io::Result<()> {
        w.write_all(fmt::num(v).as_bytes())
    }
    fn write_f32<W: ?Sized + io::Write>(&mut self, w: &mut W, v: f32) -> io::Result<()> {
        w.write_all(fmt::num(v as f64).as_bytes())
    }
}

/// Indented output with JavaScript's numbers: every other method is serde_json's pretty printer,
/// whose layout is JavaScript's (`"key": value`, `[]` and `{}` for empty containers).
pub struct JsPretty<'a>(PrettyFormatter<'a>);

impl<'a> Formatter for JsPretty<'a> {
    fn write_f64<W: ?Sized + io::Write>(&mut self, w: &mut W, v: f64) -> io::Result<()> {
        w.write_all(fmt::num(v).as_bytes())
    }
    fn write_f32<W: ?Sized + io::Write>(&mut self, w: &mut W, v: f32) -> io::Result<()> {
        w.write_all(fmt::num(v as f64).as_bytes())
    }
    fn begin_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_array(w)
    }
    fn end_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_array(w)
    }
    fn begin_array_value<W: ?Sized + io::Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.0.begin_array_value(w, first)
    }
    fn end_array_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_array_value(w)
    }
    fn begin_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_object(w)
    }
    fn end_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_object(w)
    }
    fn begin_object_key<W: ?Sized + io::Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.0.begin_object_key(w, first)
    }
    fn begin_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_object_value(w)
    }
    fn end_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_object_value(w)
    }
}

/// `JSON.stringify(value)` as bytes.
pub fn to_vec<T: Serialize + ?Sized>(value: &T) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    let mut ser = serde_json::Serializer::with_formatter(&mut out, JsCompact::default());
    value.serialize(&mut ser).expect("a value that serializes to JSON");
    out
}

/// `JSON.stringify(value)`.
pub fn stringify<T: Serialize + ?Sized>(value: &T) -> String {
    String::from_utf8(to_vec(value)).expect("serde_json writes UTF-8")
}

/// `JSON.stringify(value, null, indent)` with `indent` spaces.
pub fn stringify_pretty<T: Serialize + ?Sized>(value: &T, indent: usize) -> String {
    let pad = " ".repeat(indent);
    let mut out = Vec::with_capacity(256);
    let mut ser =
        serde_json::Serializer::with_formatter(&mut out, JsPretty(PrettyFormatter::with_indent(pad.as_bytes())));
    value.serialize(&mut ser).expect("a value that serializes to JSON");
    String::from_utf8(out).expect("serde_json writes UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_as_javascript() {
        assert_eq!(stringify(&json!({ "a": 2.0, "b": 1e21, "c": 1e-7, "d": 0.1, "e": -0.0, "f": 3 })), r#"{"a":2,"b":1e+21,"c":1e-7,"d":0.1,"e":0,"f":3}"#);
        assert_eq!(stringify(&f64::NAN), "null");
        assert_eq!(stringify(&vec![1.5f64, 100.0]), "[1.5,100]");
    }

    #[test]
    fn pretty_as_javascript() {
        assert_eq!(stringify_pretty(&json!({ "a": [1.0, 2.5], "b": {}, "c": [] }), 2), "{\n  \"a\": [\n    1,\n    2.5\n  ],\n  \"b\": {},\n  \"c\": []\n}");
    }
}

/// `JSON.parse` of a request body, as the TypeScript server reads one (`await c.req.json()`): the
/// bytes are decoded as UTF-8 with U+FFFD for invalid sequences and a leading byte order mark is
/// dropped, then parsed. `Err` holds serde_json's message (the server answers "invalid JSON"
/// whatever the message is).
///
/// Three inputs that JavaScript reads and this does not read the same way; none is a
/// configuration anyone sends:
///  - a number too large for a double (`1e400`) is `Infinity` in JavaScript; here it becomes
///    `null`, which every reader of a number rejects with the same message as a non-finite number;
///  - half a surrogate pair escaped in a string (`"\ud800"`) stays half a pair in JavaScript until
///    the text is stored, when SQLite's UTF-8 makes it U+FFFD; here it is U+FFFD from the start;
///  - nesting deeper than 128 levels is invalid here.
pub fn parse(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => Ok(v),
        Err(e) => {
            // the slow path: the two repairs above, then one more try
            let patched = repair(text);
            if patched == text {
                Err(e.to_string())
            } else {
                serde_json::from_str::<serde_json::Value>(&patched).map_err(|e| e.to_string())
            }
        }
    }
}

/// The value of a `\uXXXX` escape starting at byte `i` (the backslash), if there is one.
fn escape_at(b: &[u8], i: usize) -> Option<u32> {
    if i + 6 <= b.len() && b[i] == b'\\' && b[i + 1] == b'u' {
        std::str::from_utf8(&b[i + 2..i + 6]).ok().and_then(|h| u32::from_str_radix(h, 16).ok())
    } else {
        None
    }
}

/// The text with every number token that overflows a double replaced by `null`, and every escaped
/// half of a surrogate pair replaced by the escape of U+FFFD.
fn repair(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < b.len() {
        let c = b[i];
        if in_string {
            // copy the string through, escapes included
            if c == b'\\' && i + 1 < b.len() {
                if let Some(u) = escape_at(b, i) {
                    let low_follows = matches!(escape_at(b, i + 6), Some(0xdc00..=0xdfff));
                    if (0xd800..=0xdbff).contains(&u) && low_follows {
                        out.push_str(&text[i..i + 12]);
                        i += 12;
                    } else if (0xd800..=0xdfff).contains(&u) {
                        out.push_str("\\ufffd");
                        i += 6;
                    } else {
                        out.push_str(&text[i..i + 6]);
                        i += 6;
                    }
                    continue;
                }
                out.push_str(&text[i..i + 2]);
                i += 2;
                continue;
            }
            if c == b'"' {
                in_string = false;
            }
            let ch_len = text[i..].chars().next().map(|ch| ch.len_utf8()).unwrap_or(1);
            out.push_str(&text[i..i + ch_len]);
            i += ch_len;
            continue;
        }
        if c == b'"' {
            in_string = true;
            out.push('"');
            i += 1;
            continue;
        }
        if c == b'-' || c.is_ascii_digit() {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_digit() || matches!(b[i], b'.' | b'e' | b'E' | b'+' | b'-')) {
                i += 1;
            }
            let token = &text[start..i];
            match token.parse::<f64>() {
                Ok(v) if v.is_infinite() => out.push_str("null"),
                _ => out.push_str(token),
            }
            continue;
        }
        let ch_len = text[i..].chars().next().map(|ch| ch.len_utf8()).unwrap_or(1);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    out
}

#[cfg(test)]
mod parse_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_as_javascript() {
        assert_eq!(parse(br#"{"a": 1e400, "b": "1e400", "c": [-1e999, 2]}"#).unwrap(), json!({ "a": null, "b": "1e400", "c": [null, 2] }));
        assert_eq!(parse(b"\xef\xbb\xbf[1]").unwrap(), json!([1]));
        assert_eq!(parse(b"\"a\xffb\"").unwrap(), json!("a\u{fffd}b"));
        assert!(parse(b"{").is_err());
        assert_eq!(parse(br#"["\ud800", "a\udc00b", "\ud83d\ude00", "\\ud800"]"#).unwrap(), json!(["\u{fffd}", "a\u{fffd}b", "\u{1f600}", "\\ud800"]));
        assert_eq!(parse(br#"{"a":1,"a":2}"#).unwrap(), json!({ "a": 2 }));
    }
}
