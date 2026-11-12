//! The pieces of JavaScript's standard library that the server's source leans on and Rust does not
//! have in the same form: `Number(text)`, `parseInt`, strings measured and cut in UTF-16 units,
//! `decodeURI` and `decodeURIComponent`, `Date` texts. Each function names what it stands for.

use std::cmp::Ordering;

/// WhiteSpace and LineTerminator of ECMAScript: what `trim()` removes and `\s` matches.
pub fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_whitespace)
}

/// `Number(text)` (StringToNumber): white space trimmed, "" is 0, decimal literals with an optional
/// sign, fraction and exponent, `Infinity`, and unsigned `0x`, `0o`, `0b` integers; NaN otherwise.
pub fn number(text: &str) -> f64 {
    let s = trim(text);
    if s.is_empty() {
        return 0.0;
    }
    let b = s.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let mut v = 0.0f64;
            for &c in &b[2..] {
                match (c as char).to_digit(radix) {
                    Some(d) => v = v * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return v;
        }
    }
    let (sign, rest) = match b[0] {
        b'+' => (1.0, &s[1..]),
        b'-' => (-1.0, &s[1..]),
        _ => (1.0, s),
    };
    if rest == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrUnsignedDecimalLiteral: digits [. [digits]] [exponent] | . digits [exponent]
    let r = rest.as_bytes();
    let mut i = 0;
    while i < r.len() && r[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i;
    let mut frac_digits = 0;
    if i < r.len() && r[i] == b'.' {
        i += 1;
        let start = i;
        while i < r.len() && r[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return f64::NAN;
    }
    if i < r.len() && (r[i] == b'e' || r[i] == b'E') {
        i += 1;
        if i < r.len() && (r[i] == b'+' || r[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < r.len() && r[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return f64::NAN;
        }
    }
    if i != r.len() {
        return f64::NAN;
    }
    // Rust reads the same grammar and rounds to the nearest double, as JavaScript does
    rest.parse::<f64>().map_or(f64::NAN, |v| sign * v)
}

/// `parseInt(text, 10)`: leading white space, an optional sign, then digits up to the first
/// character that is none; NaN without a digit.
pub fn parse_int(text: &str) -> f64 {
    let s = text.trim_start_matches(is_whitespace);
    let (sign, rest) = match s.as_bytes().first() {
        Some(b'+') => (1.0, &s[1..]),
        Some(b'-') => (-1.0, &s[1..]),
        _ => (1.0, s),
    };
    let digits: &str = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `text.length`: UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, max)`: the first `max` UTF-16 code units. A cut inside a pair leaves a lone
/// surrogate in JavaScript, which becomes U+FFFD wherever the string is written as UTF-8 (the
/// database, a response, the log); here it is U+FFFD at once.
pub fn utf16_prefix(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        let n = c.len_utf16();
        if units + n > max {
            if units < max {
                out.push('\u{fffd}');
            }
            break;
        }
        out.push(c);
        units += n;
    }
    out
}

/// `a < b ? -1 : a > b ? 1 : 0` for strings: JavaScript compares UTF-16 code units, which orders
/// U+E000..U+FFFF after the characters beyond U+FFFF, unlike a comparison of UTF-8 bytes.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

/// `decodeURI` (`reserved` true: the escapes of `;/?:@&=+$,#` stay as they are) and
/// `decodeURIComponent`. `Err` is the URIError: a `%` that is not followed by two hex digits, or
/// bytes that are not UTF-8.
fn decode(s: &str, reserved: bool) -> Result<String, ()> {
    let b = s.as_bytes();
    if !b.contains(&b'%') {
        return Ok(s.to_string());
    }
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let byte = |at: usize| -> Result<u8, ()> {
            if at + 2 < b.len() && b[at] == b'%' {
                match (hex(b[at + 1]), hex(b[at + 2])) {
                    (Some(h), Some(l)) => Ok(h << 4 | l),
                    _ => Err(()),
                }
            } else {
                Err(())
            }
        };
        let first = byte(i)?;
        if first < 0x80 {
            if reserved && b";/?:@&=+$,#".contains(&first) {
                out.extend_from_slice(&b[i..i + 3]);
            } else {
                out.push(first);
            }
            i += 3;
            continue;
        }
        // a UTF-8 sequence of 2 to 4 escapes
        let n = match first {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return Err(()),
        };
        let mut seq = [first, 0, 0, 0];
        for (k, slot) in seq.iter_mut().enumerate().take(n).skip(1) {
            *slot = byte(i + 3 * k)?;
        }
        // overlong forms, surrogates and values past U+10FFFF are no UTF-8, here as in JavaScript
        if std::str::from_utf8(&seq[..n]).is_err() {
            return Err(());
        }
        out.extend_from_slice(&seq[..n]);
        i += 3 * n;
    }
    String::from_utf8(out).map_err(|_| ())
}

/// `decodeURI(text)`.
pub fn decode_uri(s: &str) -> Result<String, ()> {
    decode(s, true)
}

/// `decodeURIComponent(text)`.
pub fn decode_uri_component(s: &str) -> Result<String, ()> {
    decode(s, false)
}

/// hono/utils/url: tryDecode. The whole text decoded, or, when that throws, each run of escapes
/// `(?:%[0-9A-Fa-f]{2})+` decoded on its own where it can be and left as it is where not.
pub fn try_decode(s: &str, decoder: fn(&str) -> Result<String, ()>) -> String {
    if let Ok(v) = decoder(s) {
        return v;
    }
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        let is_escape = |at: usize| at + 2 < b.len() && b[at] == b'%' && hex(b[at + 1]).is_some() && hex(b[at + 2]).is_some();
        if is_escape(i) {
            let start = i;
            while is_escape(i) {
                i += 3;
            }
            let run = &s[start..i];
            match decoder(run) {
                Ok(v) => out.push_str(&v),
                Err(()) => out.push_str(run),
            }
        } else {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// hono/utils/url: tryDecodeURI.
pub fn try_decode_uri(s: &str) -> String {
    try_decode(s, decode_uri)
}

/// hono/utils/url: tryDecodeURIComponent (only when the text has a `%`).
pub fn try_decode_uri_component(s: &str) -> String {
    if s.contains('%') {
        try_decode(s, decode_uri_component)
    } else {
        s.to_string()
    }
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// (year, month, day) to days since 1970-01-01.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The fields of a time value (milliseconds since the epoch, UTC).
pub struct DateFields {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub ms: u32,
    /// 0 is Sunday.
    pub weekday: u32,
}

pub fn date_fields(time: f64) -> DateFields {
    let t = time.floor() as i64;
    let days = t.div_euclid(86_400_000);
    let in_day = t.rem_euclid(86_400_000);
    let (year, month, day) = civil(days);
    DateFields {
        year,
        month,
        day,
        hour: (in_day / 3_600_000) as u32,
        minute: (in_day / 60_000 % 60) as u32,
        second: (in_day / 1000 % 60) as u32,
        ms: (in_day % 1000) as u32,
        weekday: (days + 4).rem_euclid(7) as u32,
    }
}

/// `Date.UTC(year, month - 1, day, hour)`.
pub fn date_utc(year: i64, month: u32, day: u32, hour: u32) -> f64 {
    (days_from_civil(year, month, day) * 86_400_000 + hour as i64 * 3_600_000) as f64
}

/// `new Date(time).toISOString()`: "2026-11-10T07:08:09.123Z" (years outside 0..9999 with a sign
/// and six digits).
pub fn to_iso_string(time: f64) -> String {
    let f = date_fields(time);
    let year = if (0..=9999).contains(&f.year) {
        format!("{:04}", f.year)
    } else {
        format!("{}{:06}", if f.year < 0 { '-' } else { '+' }, f.year.abs())
    };
    format!("{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", f.month, f.day, f.hour, f.minute, f.second, f.ms)
}

/// `new Date(time).toUTCString()`: "Tue, 10 Nov 2026 07:08:09 GMT".
pub fn to_utc_string(time: f64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let f = date_fields(time);
    let year = if f.year < 0 { format!("-{:06}", -f.year) } else { format!("{:04}", f.year) };
    format!(
        "{}, {:02} {} {year} {:02}:{:02}:{:02} GMT",
        DAYS[f.weekday as usize],
        f.day,
        MONTHS[f.month as usize - 1],
        f.hour,
        f.minute,
        f.second
    )
}

/// `Date.parse(text)` for the date-time format of ECMAScript (what `toISOString` writes, and its
/// shorter forms: a date alone, a time without seconds or milliseconds, `Z` or a `±hh:mm` offset);
/// NaN for anything else. JavaScript engines also read other, implementation-defined formats; the
/// server only parses times it wrote itself.
pub fn date_parse(text: &str) -> f64 {
    let b = text.as_bytes();
    let digits = |from: usize, n: usize| -> Option<i64> {
        let part = b.get(from..from + n)?;
        if part.iter().all(u8::is_ascii_digit) {
            std::str::from_utf8(part).ok()?.parse().ok()
        } else {
            None
        }
    };
    let parse = || -> Option<f64> {
        let mut i;
        let year = match b.first()? {
            b'+' | b'-' => {
                let y = digits(1, 6)?;
                i = 7;
                if b[0] == b'-' {
                    if y == 0 {
                        return None;
                    }
                    -y
                } else {
                    y
                }
            }
            _ => {
                i = 4;
                digits(0, 4)?
            }
        };
        let (mut month, mut day) = (1, 1);
        if b.get(i) == Some(&b'-') {
            month = digits(i + 1, 2)?;
            i += 3;
            if b.get(i) == Some(&b'-') {
                day = digits(i + 1, 2)?;
                i += 3;
            }
        }
        let (mut h, mut mi, mut s, mut ms) = (0, 0, 0, 0.0);
        let mut offset = 0;
        if b.get(i) == Some(&b'T') {
            h = digits(i + 1, 2)?;
            if b.get(i + 3) != Some(&b':') {
                return None;
            }
            mi = digits(i + 4, 2)?;
            i += 6;
            if b.get(i) == Some(&b':') {
                s = digits(i + 1, 2)?;
                i += 3;
                if b.get(i) == Some(&b'.') {
                    let start = i + 1;
                    let mut end = start;
                    while b.get(end).is_some_and(u8::is_ascii_digit) {
                        end += 1;
                    }
                    if end == start {
                        return None;
                    }
                    ms = format!("0.{}", &text[start..end]).parse::<f64>().ok()? * 1000.0;
                    i = end;
                }
            }
            match b.get(i) {
                Some(b'Z') => i += 1,
                Some(sign @ (b'+' | b'-')) => {
                    let oh = digits(i + 1, 2)?;
                    if b.get(i + 3) != Some(&b':') {
                        return None;
                    }
                    let om = digits(i + 4, 2)?;
                    offset = (oh * 60 + om) * if *sign == b'-' { -1 } else { 1 };
                    i += 6;
                }
                // a date-time without an offset is local time; the server runs in UTC
                _ => {}
            }
        }
        if i != b.len() || !(1..=12).contains(&month) || !(1..=31).contains(&day) || h > 24 || mi > 59 || s > 59 {
            return None;
        }
        if h == 24 && (mi != 0 || s != 0 || ms != 0.0) {
            return None;
        }
        let days = days_from_civil(year, month as u32, day as u32);
        let t = days as f64 * 86_400_000.0 + (h * 3_600_000 + mi * 60_000 + s * 1000) as f64 + ms.trunc() - offset as f64 * 60_000.0;
        (t.abs() <= 8.64e15).then_some(t)
    };
    parse().unwrap_or(f64::NAN)
}

/// `n.toLocaleString("en-US")` of a whole number: digits in groups of three.
pub fn to_locale_string(n: f64) -> String {
    let digits = polypack_js::fmt::num(n.abs());
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0.0 {
        out.insert(0, '-');
    }
    out
}

/// The bytes of a header value as the string JavaScript sees: one character per byte (latin-1).
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_reads_as_javascript() {
        for (text, want) in [
            ("", 0.0),
            ("  ", 0.0),
            ("4", 4.0),
            (" 4 ", 4.0),
            ("+4", 4.0),
            ("-4", -4.0),
            ("4.0", 4.0),
            ("4.", 4.0),
            (".5", 0.5),
            ("1e2", 100.0),
            ("1E+2", 100.0),
            ("0x10", 16.0),
            ("0X1f", 31.0),
            ("0b11", 3.0),
            ("0o17", 15.0),
            ("04", 4.0),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("9007199254740993", 9007199254740992.0),
        ] {
            assert_eq!(number(text), want, "{text:?}");
        }
        for text in ["x", "4x", "1.5.2", "1e", "e5", ".", "+", "-", "0x", "-0x10", "infinity", "inf", "nan", "NaN", "1_000", "1 2", "++1", "0x1g", "1e+"] {
            assert!(number(text).is_nan(), "{text:?}");
        }
        assert!(number("-0").is_sign_negative());
    }

    #[test]
    fn parse_int_reads_as_javascript() {
        assert_eq!(parse_int("12abc"), 12.0);
        assert_eq!(parse_int("  -7"), -7.0);
        assert_eq!(parse_int("0,5"), 0.0);
        assert!(parse_int("").is_nan());
        assert!(parse_int("items=0").is_nan());
        assert!(parse_int("-").is_nan());
    }

    #[test]
    fn strings_in_utf16_units() {
        assert_eq!(utf16_len("a😀é"), 4);
        assert_eq!(utf16_prefix("ab😀c", 3), "ab\u{fffd}");
        assert_eq!(utf16_prefix("ab😀c", 4), "ab😀");
        assert_eq!(utf16_prefix("abc", 10), "abc");
        assert_eq!(cmp_utf16("\u{e000}", "😀"), Ordering::Greater);
        assert_eq!("\u{e000}".cmp("😀"), Ordering::Less);
    }

    #[test]
    fn uri_decoding() {
        assert_eq!(decode_uri("/a%20b%2Fc%3f"), Ok("/a b%2Fc%3f".to_string()));
        assert_eq!(decode_uri_component("a%20b%2Fc%C3%A9"), Ok("a b/cé".to_string()));
        assert_eq!(decode_uri("%zz"), Err(()));
        assert_eq!(decode_uri("%E0%A4%A"), Err(()));
        assert_eq!(decode_uri("%C3"), Err(()));
        assert_eq!(decode_uri("%ED%A0%80"), Err(()));
        assert_eq!(try_decode_uri("/%zz/a%20b"), "/%zz/a b");
        assert_eq!(try_decode_uri("/%E0%A4%A/x%41"), "/%E0%A4%A/xA");
        assert_eq!(try_decode_uri("/%C3%A9%FF"), "/%C3%A9%FF");
        assert_eq!(try_decode_uri_component("1%20"), "1 ");
        assert_eq!(try_decode_uri_component("..%2Fm"), "../m");
        assert_eq!(decode_uri("%"), Err(()));
        assert_eq!(try_decode_uri("%"), "%");
        assert_eq!(try_decode_uri("a%2"), "a%2");
    }

    #[test]
    fn dates() {
        assert_eq!(to_iso_string(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(to_iso_string(1930461689123.0), "2031-03-05T07:21:29.123Z");
        assert_eq!(to_iso_string(-1.0), "1969-12-31T23:59:59.999Z");
        assert_eq!(to_iso_string(253402300800000.0), "+010000-01-01T00:00:00.000Z");
        assert_eq!(date_parse("2031-03-05T07:21:29.123Z"), 1930461689123.0);
        assert_eq!(date_parse("1970-01-01T00:00:00.000Z"), 0.0);
        assert_eq!(date_parse("2026-10-28"), 1793145600000.0);
        assert!(date_parse("x").is_nan());
        assert!(date_parse("2026-13-01T00:00:00.000Z").is_nan());
        assert_eq!(to_utc_string(1794296769000.0), "Tue, 10 Nov 2026 07:46:09 GMT");
        assert_eq!(date_utc(2031, 3, 5, 11), date_parse("2031-03-05T11:00:00.000Z"));
        assert_eq!(to_locale_string(20000.0), "20,000");
        assert_eq!(to_locale_string(999.0), "999");
        assert_eq!(to_locale_string(1234567.0), "1,234,567");
    }
}
