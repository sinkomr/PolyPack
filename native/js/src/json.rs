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

/// Deepest nesting of arrays and objects that [`parse`] reads; a text nested deeper is invalid.
///
/// JavaScript has no such limit: Node reads and writes a text nested as deep as the 256 KiB of a
/// request body allow (131,072 levels). A limit is needed here because a `serde_json::Value` is
/// cloned, written and released by functions that call themselves once per level, and a stack
/// that overflows ends the whole process. It is set well above what the server can ever store:
/// `method_params`, the one field that is stored as it was sent, is at most 4,096 bytes as JSON,
/// which nest at most 2,046 levels deep (2,047 inside a body). Every thread of the server that
/// handles such values has a stack sized for this depth with a margin (`polypack-server`:
/// `pool::THREAD_STACK_BYTES`, and the test of it).
pub const MAX_DEPTH: usize = 4096;

/// The nesting serde_json reads by itself (its `remaining_depth` of 128 allows 127 levels).
const SERDE_DEPTH: usize = 127;

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
///  - nesting deeper than [`MAX_DEPTH`] levels is invalid here.
pub fn parse(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    match read(text) {
        Ok(v) => Ok(v),
        Err(e) => {
            // the slow path: the two repairs above, then one more try
            let patched = repair(text);
            if patched == text {
                Err(e)
            } else {
                read(&patched)
            }
        }
    }
}

/// serde_json's reading of a text, to `MAX_DEPTH` levels instead of its own 127.
fn read(text: &str) -> Result<serde_json::Value, String> {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => Ok(v),
        Err(e) => match depth(text) {
            d if d > MAX_DEPTH => Err(format!("nesting deeper than {MAX_DEPTH} levels")),
            // serde_json gave up for the depth alone, or for the depth first
            d if d > SERDE_DEPTH => read_deep(text),
            _ => Err(e.to_string()),
        },
    }
}

/// How deep the arrays and objects of a JSON text nest: the most brackets open at once, outside
/// strings. (Of a text that is not JSON it is some number; `read_deep` then says what is wrong.)
fn depth(text: &str) -> usize {
    let (mut open, mut deepest) = (0usize, 0usize);
    let mut in_string = false;
    let mut bytes = text.bytes();
    while let Some(c) = bytes.next() {
        if in_string {
            match c {
                b'\\' => {
                    bytes.next();
                }
                b'"' => in_string = false,
                _ => {}
            }
        } else {
            match c {
                b'"' => in_string = true,
                b'[' | b'{' => {
                    open += 1;
                    deepest = deepest.max(open);
                }
                b']' | b'}' => open = open.saturating_sub(1),
                _ => {}
            }
        }
    }
    deepest
}

/// What `serde_json::from_str::<Value>` gives for a text, without its limit on nesting: the
/// arrays and objects being read are kept on a list, not on the call stack, and every string,
/// number and literal is read by serde_json itself, so that a value is the same whichever of the
/// two read it (an integer stays an integer, `-0` a float, a key given twice keeps its first place
/// and its last value).
fn read_deep(text: &str) -> Result<serde_json::Value, String> {
    use serde_json::{Map, Value};
    /// An array or object whose closing bracket has not been read yet.
    enum Open {
        Array(Vec<Value>),
        /// The properties so far, and the name of the one whose value is being read.
        Object(Map<String, Value>, String),
    }
    let b = text.as_bytes();
    let ws = |at: &mut usize| {
        while matches!(b.get(*at), Some(b' ' | b'\n' | b'\t' | b'\r')) {
            *at += 1;
        }
    };
    // The end of the string that opens at `at`: the index after its closing quote.
    let string_end = |at: usize| -> Result<usize, String> {
        let mut i = at + 1;
        loop {
            match b.get(i) {
                None => return Err("EOF while parsing a string".to_string()),
                Some(b'\\') => i += 2,
                Some(b'"') => return Ok(i + 1),
                Some(_) => i += 1,
            }
        }
    };
    // A property name and its colon, after which the property's value starts.
    let key = |at: &mut usize| -> Result<String, String> {
        ws(at);
        if b.get(*at) != Some(&b'"') {
            return Err(format!("key must be a string at byte {at}"));
        }
        let end = string_end(*at)?;
        let name = serde_json::from_str::<String>(&text[*at..end]).map_err(|e| e.to_string())?;
        *at = end;
        ws(at);
        if b.get(*at) != Some(&b':') {
            return Err(format!("expected `:` at byte {at}"));
        }
        *at += 1;
        Ok(name)
    };
    let mut at = 0usize;
    let mut open: Vec<Open> = Vec::new();
    loop {
        // the start of a value
        ws(&mut at);
        let mut value = match b.get(at) {
            None => return Err("EOF while parsing a value".to_string()),
            Some(&c @ (b'[' | b'{')) => {
                if open.len() >= MAX_DEPTH {
                    return Err(format!("nesting deeper than {MAX_DEPTH} levels"));
                }
                at += 1;
                ws(&mut at);
                if c == b'[' {
                    if b.get(at) == Some(&b']') {
                        at += 1;
                        Value::Array(Vec::new())
                    } else {
                        open.push(Open::Array(Vec::new()));
                        continue;
                    }
                } else if b.get(at) == Some(&b'}') {
                    at += 1;
                    Value::Object(Map::new())
                } else {
                    let name = key(&mut at)?;
                    open.push(Open::Object(Map::new(), name));
                    continue;
                }
            }
            Some(&c) => {
                // a string, a number or a literal: to its end, and serde_json reads it
                let end = if c == b'"' {
                    string_end(at)?
                } else {
                    let mut i = at;
                    while !matches!(b.get(i), None | Some(b',' | b']' | b'}' | b' ' | b'\n' | b'\t' | b'\r')) {
                        i += 1;
                    }
                    i
                };
                // the token begins and ends at ASCII bytes, or at the ends of the text
                let token = text.get(at..end).ok_or_else(|| "EOF while parsing a string".to_string())?;
                let v = serde_json::from_str::<Value>(token).map_err(|e| e.to_string())?;
                at = end;
                v
            }
        };
        // a whole value: it goes into the array or object it belongs to, which may end with it
        loop {
            match open.last_mut() {
                None => {
                    ws(&mut at);
                    if at != b.len() {
                        return Err(format!("trailing characters at byte {at}"));
                    }
                    return Ok(value);
                }
                Some(Open::Array(list)) => {
                    list.push(value);
                    ws(&mut at);
                    match b.get(at) {
                        Some(b',') => {
                            at += 1;
                            break;
                        }
                        Some(b']') => {
                            at += 1;
                            let Some(Open::Array(list)) = open.pop() else { unreachable!() };
                            value = Value::Array(list);
                        }
                        _ => return Err(format!("expected `,` or `]` at byte {at}")),
                    }
                }
                Some(Open::Object(map, name)) => {
                    // as serde_json's own reader: a key given again keeps its place and takes the new value
                    map.insert(std::mem::take(name), value);
                    ws(&mut at);
                    match b.get(at) {
                        Some(b',') => {
                            at += 1;
                            let next = key(&mut at)?;
                            let Some(Open::Object(_, name)) = open.last_mut() else { unreachable!() };
                            *name = next;
                            break;
                        }
                        Some(b'}') => {
                            at += 1;
                            let Some(Open::Object(map, _)) = open.pop() else { unreachable!() };
                            value = Value::Object(map);
                        }
                        _ => return Err(format!("expected `,` or `}}` at byte {at}")),
                    }
                }
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
                // the backslash and the character after it, of however many bytes
                let ch_len = text[i + 1..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&text[i..i + 1 + ch_len]);
                i += 1 + ch_len;
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

    // A text serde_json refuses is patched and read again (`repair`). The patching once cut two
    // bytes after a backslash, which is inside the next character when that has several bytes: a
    // panic, where the text is simply not JSON.
    #[test]
    fn a_backslash_before_any_character_is_not_json_and_does_not_panic() {
        // before a character of 2, 3 and 4 bytes; as the last byte; alone in a string
        for text in ["{\"x\":\"\\\u{e9}\"}", "{\"x\":\"\\\u{20ac}\"}", "{\"x\":\"\\\u{1f600}\"}", "[\"\\\u{e9}", "\"\\", "\\", "[1,\"a\\", "\"\\\u{e9}\\\u{20ac}\\\u{1f600}\""] {
            assert!(parse(text.as_bytes()).is_err(), "{text:?}");
            // and with something before it that sends the text through the patching whatever follows
            assert!(parse(format!("[1e999,{text}").as_bytes()).is_err(), "{text:?}");
        }
        // `\u` with fewer than four hex digits at the end of the text, in and out of a string
        for text in ["\"\\u", "\"\\u1", "\"\\u12", "\"\\u123", "\"\\ud83d\\u", "\"\\ud83d\\ude0", "\\u12", "[\"\\u12\u{e9}\"]", "\"\\u\u{e9}\u{e9}\u{e9}\u{e9}\""] {
            assert!(parse(text.as_bytes()).is_err(), "{text:?}");
        }
        // an invalid byte after a backslash is U+FFFD by then, three bytes
        assert!(parse(b"\"\\\xff\"").is_err());
        // what is patched still reads: the escapes that are JSON's, beside a number out of range
        assert_eq!(parse("[1e999,\"\\n\\\\\u{e9}\\\"\u{1f600}\\u00e9\"]".as_bytes()).unwrap(), json!([null, "\n\\\u{e9}\"\u{1f600}\u{e9}"]));
    }

    fn nested(open: &str, inner: &str, close: &str, levels: usize) -> String {
        format!("{}{inner}{}", open.repeat(levels), close.repeat(levels))
    }

    /// Runs `f` on a thread with a stack of `bytes`, as the server's threads have one of a known size.
    fn on_a_stack_of<T: Send + 'static>(bytes: usize, f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::Builder::new().stack_size(bytes).spawn(f).unwrap().join().unwrap()
    }

    // serde_json alone refuses nesting of 128 levels; the server must read what the TypeScript
    // server reads and stores (a `method_params` of 4,096 bytes nests 2,046 deep).
    #[test]
    fn reads_nesting_to_the_limit_and_refuses_deeper() {
        on_a_stack_of(16 << 20, || {
            // (the values are released on this stack: 1.6 MiB unoptimised at the limit)
            for levels in [1, 126, 127, 128, 129, 500, 2047, MAX_DEPTH] {
                let arrays = nested("[", "", "]", levels);
                let v = parse(arrays.as_bytes()).unwrap_or_else(|e| panic!("{levels} arrays: {e}"));
                assert_eq!(stringify(&v), arrays, "{levels} arrays");
                let objects = nested("{\"a\":", "1.5", "}", levels);
                let v = parse(objects.as_bytes()).unwrap_or_else(|e| panic!("{levels} objects: {e}"));
                assert_eq!(stringify(&v), objects, "{levels} objects");
            }
            for levels in [MAX_DEPTH + 1, MAX_DEPTH + 2, 100_000] {
                assert!(parse(nested("[", "", "]", levels).as_bytes()).is_err(), "{levels} arrays");
                assert!(parse(nested("[", "1", "]", levels).as_bytes()).is_err(), "{levels} arrays");
                assert!(parse(nested("{\"a\":", "{}", "}", levels - 1).as_bytes()).is_err(), "{levels} objects");
            }
            // brackets inside strings are not nesting
            let text = format!("[\"{}\\\"{}\"]", "[".repeat(5000), "{".repeat(5000));
            assert!(parse(text.as_bytes()).is_ok());
            // a submission as the harness sends it: the nesting is in one field, among others
            let body = format!("{{\"N\":4,\"method_params\":{{\"a\":{}}},\"name\":\"deep\",\"N\":5}}", nested("[", "1e400,\"\\ud800\",-0,7", "]", 2000));
            let v = parse(body.as_bytes()).unwrap();
            assert_eq!(v["N"], json!(5));
            assert_eq!(v.as_object().unwrap().keys().collect::<Vec<_>>(), ["N", "method_params", "name"]);
            let mut inner = &v["method_params"]["a"];
            for _ in 1..2000 {
                inner = &inner[0];
            }
            // read as a shallow text is: out of range as null, half a pair as U+FFFD, -0 a float, 7 an integer
            assert_eq!(*inner, parse(b"[1e400,\"\\ud800\",-0,7]").unwrap());
            assert!(inner[2].is_f64() && inner[3].is_u64());
            // deep and not JSON
            for bad in [nested("[", "", "]", 300) + "x", nested("[", "1,", "]", 300), nested("[", "", "}", 300), nested("{\"a\":", "", "}", 300), nested("[", "tru", "]", 300), "[".repeat(300), nested("{\"a\" ", "1", "}", 300), nested("[", "\"a\nb\"", "]", 300), nested("[", "01", "]", 300), nested("{", "", "}", 300), nested("[", "\"\\\u{e9}\"", "]", 300)] {
                assert!(parse(bad.as_bytes()).is_err(), "{}", &bad[bad.len() / 2 - 20..bad.len() / 2 + 20]);
            }
        });
    }

    // The reader for deep texts must give what serde_json gives: here on texts serde_json reads too.
    #[test]
    fn the_reader_for_deep_texts_agrees_with_serde_json() {
        let texts = [
            "null", " true ", "false", "0", "-0", "-0.0", "1", "-1", "18446744073709551615", "18446744073709551616", "-9223372036854775808", "-9223372036854775809", "1.0", "1e2", "1E-7", "0.1",
            "5e-324", "1e308", "123456789012345678901234567890", "\"\"", "\"a\\u0041\\/\\n\\ud83d\\ude00\u{e9}\"", "[]", "{}", "[ ]", "{ }", "[1,2,3]", " [ 1 , [ 2 , { \"a\" : [ ] } ] , \"x\" ] ",
            "{\"b\":1,\"a\":{\"b\":[true,false,null]},\"b\":2,\"10\":3,\"2\":4}", "{\"a\\u0041\":1,\"aA\":2}", "[[[[[[1.5]]]]],[[[[]]]],{\"\":{\"\":{}}}]", "\t\r\n[1]\t\r\n",
            // and what neither reads
            "", " ", "[", "]", "{", "}", "[1,]", "[,1]", "[1 2]", "{\"a\":1,}", "{\"a\"}", "{\"a\":}", "{a:1}", "{1:1}", "[1]]", "[1]x", "01", "1.", ".5", "+1", "1e", "- 1", "tru", "nulll", "NaN", "\"a", "\"a\nb\"",
            "\"\\x\"", "\"\\ud800\"", "\"\\u12\"", "1e400", "[1e400]", "{\"a\":1}{\"a\":2}", "[\"a\"\"b\"]", "[1\"a\"]", "{\"a\":1 \"b\":2}", "{\"a\"::1}", "[1,,2]", "\u{feff}1", "[\u{a0}1]", "'a'",
        ];
        for text in texts {
            let (deep, serde) = (read_deep(text), serde_json::from_str::<serde_json::Value>(text));
            match (&deep, &serde) {
                (Ok(a), Ok(b)) => {
                    assert_eq!(a, b, "{text:?}");
                    // the same text too: the order of keys, integers as integers
                    assert_eq!(serde_json::to_string(a).unwrap(), serde_json::to_string(b).unwrap(), "{text:?}");
                }
                (Err(_), Err(_)) => {}
                _ => panic!("{text:?}: the deep reader gives {deep:?}, serde_json {serde:?}"),
            }
        }
    }
}
