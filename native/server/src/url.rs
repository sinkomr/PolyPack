//! The request's address as the source sees it.
//!
//! `@hono/node-server` builds `new URL("http://" + Host + request target)` and hands its `href` on
//! as `request.url`; Hono reads the path and the query from that text (hono/utils/url: getPath,
//! getQueryParam), and leaders.ts reads `new URL(url).searchParams`. So what a route sees is the
//! target after the URL parser of the WHATWG standard: dot segments resolved (`/a/../b`, also
//! written `%2e%2e`), a backslash read as a slash, and some characters escaped. This module ports
//! those steps for an `http:` address, and Hono's readers of the result.

use crate::js;

/// The path percent-encode set of the URL standard (beyond the C0 controls and everything above `~`).
fn in_path_set(c: char) -> bool {
    matches!(c, ' ' | '"' | '#' | '<' | '>' | '?' | '^' | '`' | '{' | '}')
}

/// The special-query percent-encode set.
fn in_query_set(c: char) -> bool {
    matches!(c, ' ' | '"' | '#' | '<' | '>' | '\'')
}

/// The fragment percent-encode set.
fn in_fragment_set(c: char) -> bool {
    matches!(c, ' ' | '"' | '<' | '>' | '`')
}

fn encode_into(out: &mut String, c: char, in_set: fn(char) -> bool) {
    if c <= '\u{1f}' || c > '~' || in_set(c) {
        let mut buf = [0u8; 4];
        for b in c.encode_utf8(&mut buf).bytes() {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    } else {
        out.push(c);
    }
}

fn is_single_dot(segment: &str) -> bool {
    segment == "." || segment.eq_ignore_ascii_case("%2e")
}

fn is_double_dot(segment: &str) -> bool {
    segment == ".." || segment.eq_ignore_ascii_case(".%2e") || segment.eq_ignore_ascii_case("%2e.") || segment.eq_ignore_ascii_case("%2e%2e")
}

/// The `href` of `new URL("http://" + host + target)`, for a target that begins with a slash: the
/// host in lower case without the default port, the path, the query and the fragment as the URL
/// parser writes them. `target` holds one character per byte received (as Node reads a request line).
pub fn href(host: &str, target: &str) -> String {
    // tabs and newlines are removed from the whole input before anything else
    let target: String = target.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let (before_fragment, fragment) = match target.find('#') {
        Some(i) => (&target[..i], Some(&target[i + 1..])),
        None => (&target[..], None),
    };
    let (path, query) = match before_fragment.find('?') {
        Some(i) => (&before_fragment[..i], Some(&before_fragment[i + 1..])),
        None => (before_fragment, None),
    };

    let mut out = String::with_capacity(target.len() + host.len() + 8);
    out.push_str("http://");
    let host_lower = host.to_ascii_lowercase();
    // the default port of http is not written
    let host_text = match host_lower.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && !name.ends_with(':') => {
            match port.parse::<u32>() {
                Ok(80) => name.to_string(),
                Ok(p) => format!("{name}:{p}"),
                Err(_) => host_lower.clone(),
            }
        }
        _ => host_lower.clone(),
    };
    out.push_str(&host_text);

    // the path state: segments end at a slash or a backslash
    let mut segments: Vec<String> = Vec::new();
    let body = path.strip_prefix(['/', '\\']).unwrap_or(path);
    let mut rest = body;
    loop {
        let (segment, more) = match rest.find(['/', '\\']) {
            Some(i) => (&rest[..i], Some(&rest[i + 1..])),
            None => (rest, None),
        };
        let mut buffer = String::with_capacity(segment.len());
        for c in segment.chars() {
            encode_into(&mut buffer, c, in_path_set);
        }
        if is_double_dot(&buffer) {
            segments.pop();
            if more.is_none() {
                segments.push(String::new());
            }
        } else if is_single_dot(&buffer) {
            if more.is_none() {
                segments.push(String::new());
            }
        } else {
            segments.push(buffer);
        }
        match more {
            Some(m) => rest = m,
            None => break,
        }
    }
    for s in &segments {
        out.push('/');
        out.push_str(s);
    }
    if let Some(q) = query {
        out.push('?');
        for c in q.chars() {
            encode_into(&mut out, c, in_query_set);
        }
    }
    if let Some(f) = fragment {
        out.push('#');
        for c in f.chars() {
            encode_into(&mut out, c, in_fragment_set);
        }
    }
    out
}

/// hono/utils/url: getPath. The path of a request URL, decoded with `decodeURI` where it has
/// escapes (an escaped `%` stays escaped).
pub fn get_path(url: &str) -> String {
    let b = url.as_bytes();
    // url.indexOf("/", url.indexOf(":") + 4)
    let colon = url.find(':').map_or(0, |i| i + 4);
    let start = url[colon.min(url.len())..].find('/').map_or(url.len(), |i| i + colon);
    let mut i = start;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let query = url[i..].find('?').map(|k| k + i);
                let hash = url[i..].find('#').map(|k| k + i);
                let end = match (query, hash) {
                    (None, None) => url.len(),
                    (None, Some(h)) => h,
                    (Some(q), None) => q,
                    (Some(q), Some(h)) => q.min(h),
                };
                let path = &url[start..end];
                return if path.contains("%25") { js::try_decode_uri(&path.replace("%25", "%2525")) } else { js::try_decode_uri(path) };
            }
            b'?' | b'#' => break,
            _ => i += 1,
        }
    }
    url[start..i].to_string()
}

/// hono/utils/url: _decodeURI.
fn decode_query_value(value: &str) -> String {
    if value.contains('+') {
        js::try_decode_uri_component(&value.replace('+', " "))
    } else {
        js::try_decode_uri_component(value)
    }
}

/// `text.indexOf(needle, from)` in bytes.
fn index_of(text: &str, needle: &str, from: usize) -> Option<usize> {
    text.get(from.min(text.len())..)?.find(needle).map(|i| i + from.min(text.len()))
}

/// hono/utils/url: getQueryParam(url, key), as `c.req.query(key)` calls it: the first value of
/// `key`, None when the URL has no such key. Ported with its fast path, which reads the raw text
/// and can differ from the general path only in what it does with escapes in other keys.
pub fn query_param(url: &str, key: &str) -> Option<String> {
    let url = match index_of(url, "#", 8) {
        Some(h) => &url[..h],
        None => url,
    };
    let mut encoded: Option<bool> = None;
    if !key.is_empty() && !key.contains('%') && !key.contains('+') {
        let mut key_index = index_of(url, "?", 8)?;
        let mut found = url[key_index + 1..].starts_with(key);
        let amp_key = format!("&{key}");
        if !found {
            match index_of(url, &amp_key, key_index + 1) {
                Some(i) => {
                    key_index = i;
                    found = true;
                }
                None => found = false,
            }
        }
        while found {
            let trailing = url.as_bytes().get(key_index + key.len() + 1).copied();
            match trailing {
                Some(b'=') => {
                    let value_index = key_index + key.len() + 2;
                    let end = index_of(url, "&", value_index).unwrap_or(url.len());
                    return Some(decode_query_value(&url[value_index..end]));
                }
                Some(b'&') | None => return Some(String::new()),
                _ => {}
            }
            match index_of(url, &amp_key, key_index + 1) {
                Some(i) => key_index = i,
                None => found = false,
            }
        }
        let e = url.contains('%') || url.contains('+');
        if !e {
            return None;
        }
        encoded = Some(e);
    }
    let encoded = encoded.unwrap_or_else(|| url.contains('%') || url.contains('+'));
    let mut result: Option<String> = None;
    let mut key_index = index_of(url, "?", 8);
    while let Some(k) = key_index {
        let next_key_index = index_of(url, "&", k + 1);
        let mut value_index = index_of(url, "=", k);
        if let (Some(v), Some(n)) = (value_index, next_key_index) {
            if v > n {
                value_index = None;
            }
        }
        let name_end = value_index.or(next_key_index).unwrap_or(url.len());
        let mut name = url[k + 1..name_end].to_string();
        if encoded {
            name = decode_query_value(&name);
        }
        key_index = next_key_index;
        if name.is_empty() {
            continue;
        }
        let value = match value_index {
            None => String::new(),
            Some(v) => {
                let raw = &url[v + 1..next_key_index.unwrap_or(url.len())];
                if encoded {
                    decode_query_value(raw)
                } else {
                    raw.to_string()
                }
            }
        };
        // results[name] ??= value
        if name == key && result.is_none() {
            result = Some(value);
        }
    }
    result
}

/// hono/utils/url: getQueryParams(url), as `c.req.queries()` calls it: every key of the query with
/// all its values, in the order `Object.entries` gives the keys of the object they are collected
/// in: those that are array indices first, by their number, then the others as they first came.
pub fn query_params(url: &str) -> Vec<(String, Vec<String>)> {
    let url = match index_of(url, "#", 8) {
        Some(h) => &url[..h],
        None => url,
    };
    let encoded = url.contains('%') || url.contains('+');
    let mut results: Vec<(String, Vec<String>)> = Vec::new();
    let mut key_index = index_of(url, "?", 8);
    while let Some(k) = key_index {
        let next_key_index = index_of(url, "&", k + 1);
        let mut value_index = index_of(url, "=", k);
        if let (Some(v), Some(n)) = (value_index, next_key_index) {
            if v > n {
                value_index = None;
            }
        }
        let name_end = value_index.or(next_key_index).unwrap_or(url.len());
        let mut name = url[k + 1..name_end].to_string();
        if encoded {
            name = decode_query_value(&name);
        }
        key_index = next_key_index;
        if name.is_empty() {
            continue;
        }
        let value = match value_index {
            None => String::new(),
            Some(v) => {
                let raw = &url[v + 1..next_key_index.unwrap_or(url.len())];
                if encoded {
                    decode_query_value(raw)
                } else {
                    raw.to_string()
                }
            }
        };
        match results.iter_mut().find(|(n, _)| *n == name) {
            Some((_, values)) => values.push(value),
            None => results.push((name, vec![value])),
        }
    }
    // an array index: the decimal text of an integer below 2^32 - 1, as JavaScript writes it
    let index = |name: &str| -> Option<u32> {
        let canonical = name == "0" || (!name.starts_with('0') && !name.is_empty() && name.len() <= 10 && name.bytes().all(|b| b.is_ascii_digit()));
        if !canonical {
            return None;
        }
        name.parse::<u32>().ok().filter(|n| *n < u32::MAX)
    };
    let mut indices: Vec<(u32, (String, Vec<String>))> = Vec::new();
    let mut others: Vec<(String, Vec<String>)> = Vec::new();
    for entry in results {
        match index(&entry.0) {
            Some(n) => indices.push((n, entry)),
            None => others.push(entry),
        }
    }
    indices.sort_by_key(|(n, _)| *n);
    indices.into_iter().map(|(_, entry)| entry).chain(others).collect()
}

/// `[...new URL(url).searchParams]`: the pairs of the query as the URL standard reads a form:
/// split at `&`, each part at its first `=`, `+` read as a space, escapes decoded as bytes, the
/// bytes read as UTF-8 with U+FFFD for what is not.
pub fn search_params(url: &str) -> Vec<(String, String)> {
    let before_hash = url.split('#').next().unwrap_or("");
    let Some((_, query)) = before_hash.split_once('?') else {
        return Vec::new();
    };
    let decode = |text: &str| -> String {
        let b = text.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if b[i] == b'+' {
                out.push(b' ');
                i += 1;
            } else if b[i] == b'%' && i + 2 < b.len() && hex(b[i + 1]).is_some() && hex(b[i + 2]).is_some() {
                out.push((hex(b[i + 1]).unwrap() << 4 | hex(b[i + 2]).unwrap()) as u8);
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    };
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| match part.split_once('=') {
            Some((name, value)) => (decode(name), decode(value)),
            None => (decode(part), String::new()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn href_as_the_url_parser_writes_it() {
        let h = |t: &str| href("x", t);
        assert_eq!(h("/a^b|c{d}e`f\"g<h>i j?k^l|m`n{o}p'q\"r<s>t u#v w`x"), "http://x/a%5Eb|c%7Bd%7De%60f%22g%3Ch%3Ei%20j?k^l|m`n{o}p%27q%22r%3Cs%3Et%20u#v%20w%60x");
        assert_eq!(h("/%2e%2E/a/./b/%2e/c\\d/.."), "http://x/a/b/c/");
        assert_eq!(h("/a/.."), "http://x/");
        assert_eq!(h("/a/."), "http://x/a/");
        assert_eq!(h("/a/%2E"), "http://x/a/");
        assert_eq!(h("//a//"), "http://x//a//");
        assert_eq!(h("/"), "http://x/");
        assert_eq!(h("/?"), "http://x/?");
        assert_eq!(h("/a?b=c#"), "http://x/a?b=c#");
        assert_eq!(h("/\u{e9}/%zz%41"), "http://x/%C3%A9/%zz%41");
        assert_eq!(href("X:80", "/a"), "http://x/a");
        assert_eq!(href("x:080", "/a"), "http://x/a");
        assert_eq!(href("127.0.0.1:8080", "/a"), "http://127.0.0.1:8080/a");
        assert_eq!(h("/assets\\app.js"), "http://x/assets/app.js");
        assert_eq!(h("/assets/%2e%2e/%2e%2e/records.json"), "http://x/records.json");
        assert_eq!(h("/..%2frecords.json"), "http://x/..%2frecords.json");
    }

    #[test]
    fn path_as_hono_reads_it() {
        assert_eq!(get_path("http://x:1/api/health?x=1"), "/api/health");
        assert_eq!(get_path("http://x/file%20with%20space.txt"), "/file with space.txt");
        assert_eq!(get_path("http://x/a%2520b"), "/a%2520b");
        assert_eq!(get_path("http://x/a%2Fb?c=%20"), "/a%2Fb");
        assert_eq!(get_path("http://x/%zz"), "/%zz");
        assert_eq!(get_path("http://x/a#b"), "/a");
        assert_eq!(get_path("http://x/"), "/");
    }

    #[test]
    fn query_as_hono_reads_it() {
        let q = |u: &str, k: &str| query_param(&format!("http://h{u}"), k);
        assert_eq!(q("/r?N=4&M=5", "N"), Some("4".into()));
        assert_eq!(q("/r?N=4&M=5", "M"), Some("5".into()));
        assert_eq!(q("/r?N=4&M=5", "P"), None);
        assert_eq!(q("/r", "N"), None);
        assert_eq!(q("/r?N", "N"), Some("".into()));
        assert_eq!(q("/r?N&M=1", "N"), Some("".into()));
        assert_eq!(q("/r?NN=1&N=2", "N"), Some("2".into()));
        assert_eq!(q("/r?N=1&N=2", "N"), Some("1".into()));
        assert_eq!(q("/r?name=a%20b+c%2F", "name"), Some("a b c/".into()));
        assert_eq!(q("/r?keys=4/4/1%2C4/4/2", "keys"), Some("4/4/1,4/4/2".into()));
        assert_eq!(q("/r?%4E=4", "N"), Some("4".into()));
        assert_eq!(q("/r?x=%zz&N=1", "N"), Some("1".into()));
        assert_eq!(q("/r?N=%zz", "N"), Some("%zz".into()));
        assert_eq!(q("/r?=1&N=2", "N"), Some("2".into()));
        assert_eq!(q("/r?keys=", "keys"), Some("".into()));
    }

    #[test]
    fn queries_as_hono_reads_them() {
        let q = |u: &str| query_params(&format!("http://h{u}"));
        let e = |k: &str, v: &[&str]| (k.to_string(), v.iter().map(|s| s.to_string()).collect::<Vec<String>>());
        assert_eq!(q("/r"), vec![]);
        assert_eq!(q("/r?limit=2&after=a%2Fb&limit=3"), vec![e("limit", &["2", "3"]), e("after", &["a/b"])]);
        assert_eq!(q("/r?b=1&10=x&2=y&a&=z&01=w#c=1"), vec![e("2", &["y"]), e("10", &["x"]), e("b", &["1"]), e("a", &[""]), e("01", &["w"])]);
        assert_eq!(q("/r?a+b=c+d"), vec![e("a b", &["c d"])]);
    }

    #[test]
    fn search_params_as_the_url_standard_reads_them() {
        let p = search_params("http://h/api/leaders?keys=3/3/5,sphere/0/12&x=a+b%20c&&y&%ff=1#z=2");
        assert_eq!(
            p,
            vec![
                ("keys".to_string(), "3/3/5,sphere/0/12".to_string()),
                ("x".to_string(), "a b c".to_string()),
                ("y".to_string(), "".to_string()),
                ("\u{fffd}".to_string(), "1".to_string())
            ]
        );
        assert!(search_params("http://h/a").is_empty());
    }
}
