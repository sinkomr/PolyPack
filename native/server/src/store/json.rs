//! `JSON.parse` and `JSON.stringify` as the store uses them on stored text.
//!
//! The store keeps `strict_check`, `method_params` and `budget` as JSON text, reads the older form
//! of `pieces` from JSON text, and the unit conversion rewrites the `config` of the space entries
//! by `JSON.stringify(change(JSON.parse(text)))`. A database written by the Rust server must hold
//! the same text as one written by the TypeScript server, so both functions follow JavaScript:
//!
//!  - every number is a double (`12345678901234567890` reads as 12345678901234567000), written
//!    with `polypack_js::fmt::num` (`1e21` as `1e+21`, `-0` as `0`, `2.0` as `2`);
//!  - the keys of an object keep the order they were first seen in, except that keys that are
//!    array indices (`"0"`, `"7"`, up to 2^32 - 2) come first, in ascending order; a key given twice
//!    keeps its first place and its last value;
//!  - a string is written with `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t` and `\u00xx` for the other
//!    characters below U+0020, and nothing else escaped.
//!
//! Three things a `serde_json::Value` cannot hold, and what happens to them (none of them is
//! written by either server):
//!  - a number beyond the range of a double (`1e999`) is `Infinity` in JavaScript, which
//!    `JSON.stringify` writes as `null`; here it is read as `null` at once. Every use the store
//!    makes of such a value gives the same result for `null` (not a finite number, not scaled,
//!    written as `null`);
//!  - an escape of half a surrogate pair (`"\ud800"`) is kept as it is by JavaScript; here it
//!    becomes U+FFFD;
//!  - nesting deeper than `MAX_DEPTH` is refused (JavaScript has no fixed limit).

use polypack_js::fmt;
use serde_json::{Map, Number, Value};

use super::error::{Result, StoreError};

/// Deepest nesting `parse` reads: that of a request body (`polypack_js::json::MAX_DEPTH`, 4,096).
/// The parser itself keeps the open arrays and objects on a list, but `stringify`, a copy and the
/// release of a `Value` call themselves once per level, and a stack overflow ends the process, so
/// the depth is bounded, and every thread that handles stored text has a stack sized for it
/// (`pool::THREAD_STACK_BYTES`; the test below and tests/app.rs run everything at this depth on a
/// quarter of that stack).
/// What the server stores is far shallower: a configuration nests four deep. The deepest text
/// either server can have written is a `method_params` at its limit of 4,096 bytes, which nest
/// 2,046 levels deep: a row of the TypeScript server with one must be read back and written out
/// as that server does it. Deeper text can only have been put into the database by hand; reading
/// it gives a SyntaxError here (JavaScript reads it).
pub const MAX_DEPTH: usize = polypack_js::json::MAX_DEPTH;

/// True for a key that JavaScript orders as an array index: the canonical decimal form of an
/// integer from 0 to 2^32 - 2.
fn array_index(key: &str) -> Option<u32> {
    let b = key.as_bytes();
    if b.is_empty() || b.len() > 10 || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if b.len() > 1 && b[0] == b'0' {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    if n <= 4_294_967_294 {
        Some(n as u32)
    } else {
        None
    }
}

/// The keys of `map` in JavaScript's order of own properties: array indices ascending, then the
/// other keys in the order they were added.
fn js_order(map: Map<String, Value>) -> Map<String, Value> {
    if !map.keys().any(|k| array_index(k).is_some()) {
        return map;
    }
    let mut indexed: Vec<(u32, String, Value)> = Vec::new();
    let mut rest: Vec<(String, Value)> = Vec::new();
    for (k, v) in map {
        match array_index(&k) {
            Some(i) => indexed.push((i, k, v)),
            None => rest.push((k, v)),
        }
    }
    indexed.sort_by_key(|(i, _, _)| *i);
    let mut out = Map::with_capacity(indexed.len() + rest.len());
    for (_, k, v) in indexed {
        out.insert(k, v);
    }
    for (k, v) in rest {
        out.insert(k, v);
    }
    out
}

struct Parser<'a> {
    s: &'a [u8],
    at: usize,
}

impl<'a> Parser<'a> {
    fn err<T>(&self, what: &str) -> Result<T> {
        Err(StoreError::Syntax(format!("{what} in JSON at position {}", self.at)))
    }

    fn ws(&mut self) {
        while let Some(&c) = self.s.get(self.at) {
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.at += 1;
            } else {
                break;
            }
        }
    }

    /// A property name and its colon: `"name" :`, after which the property's value starts.
    fn key(&mut self) -> Result<String> {
        self.ws();
        if self.s.get(self.at) != Some(&b'"') {
            return self.err("Expected a property name");
        }
        let key = self.string()?;
        self.ws();
        if self.s.get(self.at) != Some(&b':') {
            return self.err("Expected ':' after a property name");
        }
        self.at += 1;
        Ok(key)
    }

    /// One value. The arrays and objects being read are kept on a list of their own, not on the
    /// call stack, so the depth of the text costs no stack here.
    fn value(&mut self) -> Result<Value> {
        /// An array or object whose closing bracket has not been read yet.
        enum Open {
            Array(Vec<Value>),
            /// The properties so far, and the name of the one whose value is being read.
            Object(Map<String, Value>, String),
        }
        let mut open: Vec<Open> = Vec::new();
        loop {
            // the start of a value
            self.ws();
            let Some(&c) = self.s.get(self.at) else {
                return self.err("Unexpected end of input");
            };
            let mut value = match c {
                b'{' | b'[' => {
                    if open.len() >= MAX_DEPTH {
                        return self.err("Nesting too deep");
                    }
                    self.at += 1;
                    self.ws();
                    if c == b'{' {
                        if self.s.get(self.at) == Some(&b'}') {
                            self.at += 1;
                            Value::Object(Map::new())
                        } else {
                            let key = self.key()?;
                            open.push(Open::Object(Map::new(), key));
                            continue;
                        }
                    } else if self.s.get(self.at) == Some(&b']') {
                        self.at += 1;
                        Value::Array(Vec::new())
                    } else {
                        open.push(Open::Array(Vec::new()));
                        continue;
                    }
                }
                b'"' => Value::String(self.string()?),
                b't' => self.word("true", Value::Bool(true))?,
                b'f' => self.word("false", Value::Bool(false))?,
                b'n' => self.word("null", Value::Null)?,
                b'-' | b'0'..=b'9' => self.number()?,
                _ => return self.err("Unexpected token"),
            };
            // a whole value: it goes into the array or object it belongs to, which may end with it
            loop {
                match open.last_mut() {
                    None => return Ok(value),
                    Some(Open::Array(list)) => {
                        list.push(value);
                        self.ws();
                        match self.s.get(self.at) {
                            Some(b',') => {
                                self.at += 1;
                                break;
                            }
                            Some(b']') => {
                                self.at += 1;
                                let Some(Open::Array(list)) = open.pop() else { unreachable!() };
                                value = Value::Array(list);
                            }
                            _ => return self.err("Expected ',' or ']' after an array element"),
                        }
                    }
                    Some(Open::Object(map, key)) => {
                        // a key given again keeps its place and takes the new value, as a property does
                        map.insert(std::mem::take(key), value);
                        self.ws();
                        match self.s.get(self.at) {
                            Some(b',') => {
                                self.at += 1;
                                let next = self.key()?;
                                let Some(Open::Object(_, key)) = open.last_mut() else { unreachable!() };
                                *key = next;
                                break;
                            }
                            Some(b'}') => {
                                self.at += 1;
                                let Some(Open::Object(map, _)) = open.pop() else { unreachable!() };
                                value = Value::Object(js_order(map));
                            }
                            _ => return self.err("Expected ',' or '}' after a property value"),
                        }
                    }
                }
            }
        }
    }

    fn word(&mut self, word: &str, v: Value) -> Result<Value> {
        if self.s[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(v)
        } else {
            self.err("Unexpected token")
        }
    }

    /// -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
    fn number(&mut self) -> Result<Value> {
        let start = self.at;
        if self.s.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        match self.s.get(self.at) {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.s.get(self.at), Some(b'0'..=b'9')) {
                    self.at += 1;
                }
            }
            _ => return self.err("No number after minus sign"),
        }
        if self.s.get(self.at) == Some(&b'.') {
            self.at += 1;
            if !matches!(self.s.get(self.at), Some(b'0'..=b'9')) {
                return self.err("Unterminated fractional number");
            }
            while matches!(self.s.get(self.at), Some(b'0'..=b'9')) {
                self.at += 1;
            }
        }
        if matches!(self.s.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.s.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if !matches!(self.s.get(self.at), Some(b'0'..=b'9')) {
                return self.err("Exponent part is missing a number");
            }
            while matches!(self.s.get(self.at), Some(b'0'..=b'9')) {
                self.at += 1;
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.at]).expect("ASCII");
        // Rust reads a decimal as the nearest double, as JavaScript does; beyond the range it gives
        // an infinity, which a Value cannot hold: null (see the head of this file)
        let x: f64 = text.parse().expect("a JSON number is a Rust float literal");
        Ok(Number::from_f64(x).map_or(Value::Null, Value::Number))
    }

    fn hex4(&mut self) -> Result<u32> {
        let mut v = 0u32;
        for _ in 0..4 {
            let d = match self.s.get(self.at) {
                Some(c @ b'0'..=b'9') => (c - b'0') as u32,
                Some(c @ b'a'..=b'f') => (c - b'a') as u32 + 10,
                Some(c @ b'A'..=b'F') => (c - b'A') as u32 + 10,
                _ => return self.err("Bad Unicode escape"),
            };
            v = v * 16 + d;
            self.at += 1;
        }
        Ok(v)
    }

    /// A string, from its opening quote to its closing quote.
    fn string(&mut self) -> Result<String> {
        self.at += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let Some(&c) = self.s.get(self.at) else {
                return self.err("Unterminated string");
            };
            match c {
                b'"' => {
                    self.at += 1;
                    // the input was a str and only whole characters were copied or escaped ones added
                    return Ok(String::from_utf8(out).expect("UTF-8"));
                }
                b'\\' => {
                    self.at += 1;
                    let Some(&e) = self.s.get(self.at) else {
                        return self.err("Unterminated string");
                    };
                    self.at += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            if (0xD800..0xDC00).contains(&hi) {
                                // a pair of escapes is one character; half a pair is U+FFFD here
                                let save = self.at;
                                if self.s.get(self.at) == Some(&b'\\') && self.s.get(self.at + 1) == Some(&b'u') {
                                    self.at += 2;
                                    let lo = self.hex4()?;
                                    if (0xDC00..0xE000).contains(&lo) {
                                        char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))
                                            .expect("a surrogate pair is a character")
                                    } else {
                                        self.at = save;
                                        '\u{FFFD}'
                                    }
                                } else {
                                    '\u{FFFD}'
                                }
                            } else {
                                char::from_u32(hi).unwrap_or('\u{FFFD}')
                            }
                        }
                        _ => {
                            self.at -= 1;
                            return self.err("Bad escaped character");
                        }
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                0..=0x1f => return self.err("Bad control character in string literal"),
                _ => {
                    out.push(c);
                    self.at += 1;
                }
            }
        }
    }
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Value> {
    let mut p = Parser { s: text.as_bytes(), at: 0 };
    let v = p.value()?;
    p.ws();
    if p.at != p.s.len() {
        return p.err("Unexpected non-whitespace character after JSON");
    }
    Ok(v)
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => match n.as_f64() {
            // an integer the caller built beyond 2^53 is written as the double JavaScript would hold
            Some(x) if x.is_finite() => out.push_str(&fmt::num(x)),
            _ => out.push_str("null"),
        },
        Value::String(s) => write_string(out, s),
        Value::Array(list) => {
            out.push('[');
            for (i, item) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut first = true;
            let mut put = |out: &mut String, k: &str, item: &Value| {
                if !first {
                    out.push(',');
                }
                first = false;
                write_string(out, k);
                out.push(':');
                write_value(out, item);
            };
            // JavaScript's order of own properties, whatever order the map was built in
            if map.keys().any(|k| array_index(k).is_some()) {
                let mut indexed: Vec<(u32, &String, &Value)> =
                    map.iter().filter_map(|(k, v)| array_index(k).map(|i| (i, k, v))).collect();
                indexed.sort_by_key(|(i, _, _)| *i);
                for (_, k, item) in indexed {
                    put(out, k, item);
                }
                for (k, item) in map.iter().filter(|(k, _)| array_index(k).is_none()) {
                    put(out, k, item);
                }
            } else {
                for (k, item) in map {
                    put(out, k, item);
                }
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(value)` of a value that came from JSON.
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, v);
    out
}

/// JavaScript's truthiness of a JSON value (`value ? a : b`).
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Number.isFinite(value)`: a number, and finite.
pub fn finite_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(text: &str) -> String {
        stringify(&parse(text).unwrap())
    }

    #[test]
    fn numbers_and_strings_as_javascript() {
        assert_eq!(round("[1.0, 1e21, 1E-7, -0, 0.1, 12345678901234567890, 1e999, -1e999, 5e-324, 100]"), "[1,1e+21,1e-7,0,0.1,12345678901234567000,null,null,5e-324,100]");
        assert_eq!(round(r#"["a\u0041\/\n\u001f\u00e9é\ud83d\ude00\u2028"]"#), "[\"aA/\\n\\u001f\u{e9}\u{e9}\u{1F600}\u{2028}\"]");
        assert_eq!(round(" { \"a\" : [ ] , \"b\" : { } } "), r#"{"a":[],"b":{}}"#);
    }

    #[test]
    fn keys_in_javascript_order() {
        assert_eq!(round(r#"{"b":1,"10":2,"a":3,"2":4,"01":5,"b":6,"4294967295":7,"4294967294":8,"-1":9}"#), r#"{"2":4,"10":2,"4294967294":8,"b":6,"a":3,"01":5,"4294967295":7,"-1":9}"#);
    }

    #[test]
    fn refuses_what_javascript_refuses() {
        for bad in ["", " ", "{", "[1,]", "{\"a\":1,}", "01", "1.", ".5", "+1", "1e", "'a'", "\"a\nb\"", "\"\\x\"", "nul", "[1] x", "\u{feff}1", "NaN", "Infinity", "-", "{a:1}", "\"\\u12\""] {
            assert!(matches!(parse(bad), Err(StoreError::Syntax(_))), "{bad:?}");
        }
        for good in ["1", " 1 ", "\"\"", "null", "-0.0e+0", "[[[]]]", "\t\r\n[ ]"] {
            assert!(parse(good).is_ok(), "{good:?}");
        }
    }

    #[test]
    fn reads_and_writes_the_deepest_nesting_on_a_small_stack_and_refuses_deeper() {
        // a quarter of the stack the server's threads have
        std::thread::Builder::new()
            .stack_size(crate::pool::THREAD_STACK_BYTES / 4)
            .spawn(|| {
                let deep = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
                assert_eq!(round(&deep), deep);
                let objects = format!("{}1{}", "{\"a\":".repeat(MAX_DEPTH), "}".repeat(MAX_DEPTH));
                assert_eq!(round(&objects), objects);
                let deeper = format!("{}{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
                assert!(matches!(parse(&deeper), Err(StoreError::Syntax(_))));
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn truthiness() {
        for (text, want) in [("null", false), ("false", false), ("0", false), ("-0", false), ("\"\"", false), ("\"0\"", true), ("[]", true), ("{}", true), ("1e-300", true)] {
            assert_eq!(truthy(&parse(text).unwrap()), want, "{text}");
        }
    }
}
