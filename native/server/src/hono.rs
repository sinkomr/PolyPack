//! What the source takes from Hono and from `@hono/node-server`, as far as a client can see it:
//! the request as a route reads it (`c.req.path`, `c.req.query`, `c.req.header`, the body within a
//! limit), the answers of `c.json`, `c.text`, `c.html` and `c.body` with the headers they carry,
//! `hono/compress`, and how an answer is written to the connection (when it has a
//! `Content-Length`, what a HEAD request gets).
//!
//! Sources: node_modules/hono/dist (context.js, hono-base.js, compose.js, middleware/compress,
//! middleware/body-limit, utils/accept.js, utils/compress.js) and
//! node_modules/@hono/node-server/dist/index.mjs (hono 4.13.13, node-server 1.19.17).

use std::io::Write;
use std::net::SocketAddr;
use std::pin::Pin;
use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use bytes::Bytes;
use futures_util::stream::{self, Stream, StreamExt};
use http_body_util::BodyExt;

use crate::{js, url};

/// A request, as a route sees it.
pub struct Req {
    /// The method as sent. A HEAD request is routed as GET and still reads "HEAD" here.
    pub method: String,
    /// `c.req.url`: the `href` of the request's URL.
    pub url: String,
    /// `c.req.path`.
    pub path: String,
    pub headers: HeaderMap,
    /// The address of the connection.
    pub remote: Option<SocketAddr>,
    /// The body, until a route reads it; what is left unread is drained after the answer. (Behind
    /// a lock only so that a request can be shared between threads; nothing ever waits for it.)
    pub body: std::sync::Mutex<Option<Body>>,
    /// When the whole request must have arrived (Node: `requestTimeout`): a body that a route is
    /// still reading then ends the request and the connection (`cut::REQUEST_TIMEOUT`). None: no
    /// such time (requests made in process, by tests).
    pub deadline: Option<tokio::time::Instant>,
}

impl Req {
    /// `c.req.header(name)`: the header's values joined with ", " (as `Headers.get` gives them),
    /// one character per byte; None when the request has none.
    pub fn header(&self, name: &str) -> Option<String> {
        let mut values = self.headers.get_all(name).iter();
        let first = values.next()?;
        let mut out = js::latin1(first.as_bytes());
        for v in values {
            out.push_str(", ");
            out.push_str(&js::latin1(v.as_bytes()));
        }
        Some(out)
    }

    /// `c.req.query(key)`.
    pub fn query(&self, key: &str) -> Option<String> {
        url::query_param(&self.url, key)
    }

    /// The body, if no one has taken it yet.
    pub fn take_body(&mut self) -> Option<Body> {
        self.body.get_mut().unwrap().take()
    }

    fn put_body(&mut self, body: Body) {
        *self.body.get_mut().unwrap() = Some(body);
    }
}

pub type BodyStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

/// The body of an answer.
pub enum ResBody {
    /// `null`.
    Null,
    /// A string or bytes: written with a `Content-Length`, unless the answer names its own.
    Full(Bytes),
    /// A stream whose length is not known when the head is written: sent chunked.
    Stream(BodyStream),
    /// A stream under a `Content-Length` that the answer names itself (a static file, read as it
    /// is sent): `bytes` of it are promised. When the stream ends before that (a defect of the
    /// source's static files: a `Range` beyond the end of the file, see serve_static.rs), the
    /// client is left waiting for the rest until the connection is closed after Node's keep-alive
    /// time.
    Promised { stream: BodyStream, bytes: u64 },
    /// No answer of the server's: the request could not be read to its end, and the connection is
    /// closed after these bytes, written as they are (see `cut`).
    Cut(&'static [u8]),
}

/// What Node's HTTP server writes to a connection before it destroys it, when a request cannot be
/// read to its end (lib/_http_server.js: `socketOnError`). No route answers such a request, and
/// nothing is done for it.
pub mod cut {
    /// A body that is not framed as HTTP frames one (a chunk size that is none), or that ends
    /// before its length.
    pub const BAD_REQUEST: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
    /// A request that has not arrived whole in time: its head within `headersTimeout`, all of it
    /// within `requestTimeout`.
    pub const REQUEST_TIMEOUT: &[u8] = b"HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n";
    /// A head larger than `--max-http-header-size`.
    pub const HEADER_FIELDS_TOO_LARGE: &[u8] = b"HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n";
}

/// An answer: a `Response` of the source.
pub struct Res {
    pub status: u16,
    /// Names in lower case, in the order they were set.
    pub headers: Vec<(String, String)>,
    pub body: ResBody,
}

impl Res {
    pub fn new(status: u16, body: ResBody) -> Res {
        Res { status, headers: Vec::new(), body }
    }

    /// The end of a request that could not be read (`ResBody::Cut`).
    pub fn cut(last_words: &'static [u8]) -> Res {
        Res::new(0, ResBody::Cut(last_words))
    }

    /// Whether this is no answer but the end of the connection.
    pub fn is_cut(&self) -> bool {
        matches!(self.body, ResBody::Cut(_))
    }

    /// `headers.get(name)`.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// `headers.set(name, value)`.
    pub fn set(&mut self, name: &str, value: impl Into<String>) {
        let value = value.into();
        match self.headers.iter_mut().find(|(k, _)| k == name) {
            Some(slot) => slot.1 = value,
            None => self.headers.push((name.to_string(), value)),
        }
    }

    pub fn delete(&mut self, name: &str) {
        self.headers.retain(|(k, _)| k != name);
    }

    pub fn with(mut self, name: &str, value: impl Into<String>) -> Res {
        self.set(name, value);
        self
    }
}

/// `c.json(value, status)`, for a value already written as JSON text.
pub fn json_text(text: impl Into<String>, status: u16) -> Res {
    Res::new(status, ResBody::Full(Bytes::from(text.into()))).with("content-type", "application/json")
}

/// `c.json(value, status)`.
pub fn json<T: serde::Serialize + ?Sized>(value: &T, status: u16) -> Res {
    Res::new(status, ResBody::Full(Bytes::from(polypack_js::json::to_vec(value)))).with("content-type", "application/json")
}

/// `c.json({ error }, status)`.
pub fn json_error(error: &str, status: u16) -> Res {
    json(&serde_json::json!({ "error": error }), status)
}

/// `c.text(text, status)`.
pub fn text(text: &str, status: u16) -> Res {
    Res::new(status, ResBody::Full(Bytes::from(text.to_string()))).with("content-type", "text/plain; charset=UTF-8")
}

/// `c.html(html)`.
pub fn html(html: Bytes) -> Res {
    Res::new(200, ResBody::Full(html)).with("content-type", "text/html; charset=UTF-8")
}

/// Hono's default `notFound`: `c.text("404 Not Found", 404)`.
pub fn not_found() -> Res {
    text("404 Not Found", 404)
}

/// An exception that a route did not catch. Hono's default error handler writes it to stderr
/// (`console.error(err)`) and answers `c.text("Internal Server Error", 500)`, with the headers the
/// route had set through `c.header` before it threw.
#[derive(Debug)]
pub struct Thrown {
    pub message: String,
    pub headers: Vec<(String, String)>,
}

impl Thrown {
    pub fn new(message: impl Into<String>) -> Thrown {
        Thrown { message: message.into(), headers: Vec::new() }
    }
}

impl From<crate::store::StoreError> for Thrown {
    fn from(e: crate::store::StoreError) -> Thrown {
        Thrown::new(format!("{}: {}", e.name(), e.message()))
    }
}

/// What a route returns: its answer, or an exception.
pub type Handled = Result<Res, Thrown>;

/// Hono's default error handler.
pub fn on_error(e: Thrown) -> Res {
    // console.error(err): the text is not part of the contract, its presence on stderr is
    let _ = writeln!(std::io::stderr().lock(), "{}", e.message);
    let mut res = Res::new(500, ResBody::Full(Bytes::from_static(b"Internal Server Error")));
    res.headers = e.headers;
    res.set("content-type", "text/plain; charset=UTF-8");
    res
}

/// hono/utils/compress: COMPRESSIBLE_CONTENT_TYPE_REGEX, tested against a Content-Type.
pub fn compressible(content_type: &str) -> bool {
    const APPLICATION: [&str; 34] = [
        "javascript",
        "json",
        "xml",
        "xml-dtd",
        "ecmascript",
        "dart",
        "msgpack",
        "postscript",
        "rtf",
        "tar",
        "toml",
        "vnd.dart",
        "vnd.ms-fontobject",
        "vnd.ms-opentype",
        "vnd.msgpack",
        "wasm",
        "x-httpd-php",
        "x-javascript",
        "x-msgpack",
        "x-ns-proxy-autoconfig",
        "x-sh",
        "x-tar",
        "x-virtualbox-hdd",
        "x-virtualbox-ova",
        "x-virtualbox-ovf",
        "x-virtualbox-vbox",
        "x-virtualbox-vdi",
        "x-virtualbox-vhd",
        "x-virtualbox-vmdk",
        "x-www-form-urlencoded",
        // the last four alternatives of the expression, which are whole types
        "\0font/otf",
        "\0font/ttf",
        "\0message/rfc822",
        "\0model/gltf-binary",
    ];
    const IMAGE: [&str; 6] = ["bmp", "vnd.adobe.photoshop", "vnd.microsoft.icon", "vnd.ms-dds", "x-icon", "x-ms-bmp"];
    let t = content_type.trim_start_matches(js::is_whitespace).to_ascii_lowercase();
    // every alternative is followed by `;`, white space or the end, so it is the first token
    let token = t.split(|c: char| c == ';' || js::is_whitespace(c)).next().unwrap_or("");
    if let Some(sub) = token.strip_prefix("text/") {
        return !sub.is_empty() && sub != "event-stream";
    }
    if let Some(sub) = token.strip_prefix("application/") {
        if APPLICATION.iter().any(|a| *a == sub) {
            return true;
        }
    }
    if APPLICATION.iter().any(|a| a.strip_prefix('\0') == Some(token)) {
        return true;
    }
    if let Some(sub) = token.strip_prefix("image/") {
        if IMAGE.contains(&sub) {
            return true;
        }
    }
    if token == "x-shader/x-fragment" || token == "x-shader/x-vertex" {
        return true;
    }
    // [^;\s]+?\+(?:json|text|xml|yaml|msgpack)
    ["+json", "+text", "+xml", "+yaml", "+msgpack"].iter().any(|s| token.len() > s.len() && token.ends_with(s))
}

/// One entry of an `Accept-*` header: hono/utils/accept.
struct Accept {
    kind: String,
    q: f64,
}

fn is_ws(c: u8) -> bool {
    c == 32 || c == 9 || c == 10 || c == 13
}

fn consume_whitespace(h: &[u8], mut i: usize) -> usize {
    while i < h.len() && is_ws(h[i]) {
        i += 1;
    }
    i
}

fn ignore_trailing_whitespace(h: &[u8], mut i: usize) -> usize {
    while i > 0 && is_ws(h[i - 1]) {
        i -= 1;
    }
    i
}

/// accept.js: skipInvalidParam.
fn skip_invalid_param(h: &[u8], mut i: usize) -> (usize, bool) {
    while i < h.len() {
        if h[i] == b';' {
            return (i + 1, true);
        }
        if h[i] == b',' {
            return (i + 1, false);
        }
        i += 1;
    }
    (i, false)
}

/// accept.js: skipInvalidAcceptValue.
fn skip_invalid_accept_value(h: &[u8], start: usize) -> usize {
    let mut i = start;
    let mut in_quotes = false;
    while i < h.len() {
        let c = h[i];
        if in_quotes && c == b'\\' {
            i += 1;
        } else if c == b'"' {
            in_quotes = !in_quotes;
        } else if !in_quotes && c == b',' {
            return i + 1;
        }
        i += 1;
    }
    i
}

fn slice(h: &[u8], from: usize, to: usize) -> String {
    if from >= to || from >= h.len() {
        return String::new();
    }
    js::latin1(&h[from..to.min(h.len())])
}

/// accept.js: getNextParam. (next index, key, value, whether another parameter follows)
fn get_next_param(h: &[u8], start: usize) -> (usize, Option<String>, Option<String>, bool) {
    let start = consume_whitespace(h, start);
    let mut i = start;
    let mut key: Option<String> = None;
    let mut value: Option<String> = None;
    let mut has_next = false;
    while i < h.len() {
        let c = h[i];
        if c == b'=' {
            key = Some(slice(h, start, ignore_trailing_whitespace(h, i)));
            i += 1;
            break;
        }
        if c == b';' {
            return (i + 1, None, None, true);
        }
        if c == b',' {
            return (i + 1, None, None, false);
        }
        i += 1;
    }
    let Some(key) = key else {
        return (i, None, None, false);
    };
    i = consume_whitespace(h, i);
    if h.get(i) == Some(&b'=') {
        let (next, more) = skip_invalid_param(h, i + 1);
        return (next, Some(key), None, more);
    }
    let mut in_quotes = false;
    let param_start = i;
    while i < h.len() {
        let c = h[i];
        if in_quotes && c == b'\\' {
            i += 1;
        } else if c == b'"' {
            if in_quotes {
                let mut next_index = consume_whitespace(h, i + 1);
                let next_char = h.get(next_index).copied();
                if next_index < h.len() && !(next_char == Some(b';') || next_char == Some(b',')) {
                    let (next, more) = skip_invalid_param(h, next_index);
                    return (next, Some(key), None, more);
                }
                let mut v = slice(h, param_start + 1, i);
                if v.contains('\\') {
                    // value.replace(/\\(.)/g, "$1")
                    let mut out = String::with_capacity(v.len());
                    let mut chars = v.chars().peekable();
                    while let Some(ch) = chars.next() {
                        if ch == '\\' {
                            match chars.peek() {
                                Some(&n) if n != '\n' && n != '\r' && n != '\u{2028}' && n != '\u{2029}' => {
                                    out.push(n);
                                    chars.next();
                                }
                                _ => out.push(ch),
                            }
                        } else {
                            out.push(ch);
                        }
                    }
                    v = out;
                }
                if next_char == Some(b',') {
                    return (next_index + 1, Some(key), Some(v), false);
                }
                if next_char == Some(b';') {
                    has_next = true;
                    next_index += 1;
                }
                value = Some(v);
                i = next_index;
                break;
            }
            in_quotes = true;
        } else if !in_quotes && (c == b';' || c == b',') {
            value = Some(slice(h, param_start, ignore_trailing_whitespace(h, i)));
            if c == b';' {
                has_next = true;
            }
            i += 1;
            break;
        }
        i += 1;
    }
    let value = value.unwrap_or_else(|| slice(h, param_start, ignore_trailing_whitespace(h, i)));
    (i, Some(key), Some(value), has_next)
}

/// accept.js: parseQuality.
fn parse_quality(q: Option<&str>) -> f64 {
    match q {
        None | Some("") => 1.0,
        Some("NaN") => 0.0,
        Some(text) => {
            let n = js::number(text);
            if n.is_nan() {
                1.0
            } else if n < 0.0 {
                0.0
            } else if n > 1.0 {
                1.0
            } else {
                n
            }
        }
    }
}

/// accept.js: parseAccept (the entries in the order `values` has them after its sort).
fn parse_accept(header: &str) -> Vec<Accept> {
    let h: Vec<u8> = header.chars().map(|c| c as u32 as u8).collect();
    let h = &h[..];
    let mut values: Vec<Accept> = Vec::new();
    let mut requires_sort = false;
    let mut i = 0;
    while i < h.len() {
        // getNextAcceptValue
        let start = consume_whitespace(h, i);
        let mut j = start;
        let mut kind = String::new();
        let mut found: Option<Option<()>> = None; // Some(None): this value is skipped
        while j < h.len() {
            let c = h[j];
            if c == b';' || c == b',' {
                kind = slice(h, start, ignore_trailing_whitespace(h, j));
                j += 1;
                if c == b',' {
                    found = Some(if kind.is_empty() { None } else { Some(()) });
                    break;
                }
                if kind.is_empty() {
                    j = skip_invalid_accept_value(h, j);
                    found = Some(None);
                }
                break;
            }
            j += 1;
        }
        let mut q_lower: Option<String> = None;
        let mut q_upper: Option<String> = None;
        let accepted = match found {
            Some(done) => {
                i = j;
                done.is_some()
            }
            None if kind.is_empty() => {
                kind = slice(h, start, ignore_trailing_whitespace(h, h.len()));
                i = h.len();
                !kind.is_empty()
            }
            None => {
                while j < h.len() {
                    let (next, param, value, has_next) = get_next_param(h, j);
                    j = next;
                    if let (Some(p), Some(v)) = (param, value) {
                        // if (param && value): an empty name or value is not kept
                        if !p.is_empty() && !v.is_empty() {
                            if p == "q" {
                                q_lower = Some(v);
                            } else if p == "Q" {
                                q_upper = Some(v);
                            }
                        }
                    }
                    if !has_next {
                        break;
                    }
                }
                i = j;
                true
            }
        };
        if accepted {
            let q = parse_quality(q_lower.as_deref().or(q_upper.as_deref()));
            if values.last().is_some_and(|last| last.q < q) {
                requires_sort = true;
            }
            values.push(Accept { kind, q });
        }
    }
    if requires_sort {
        // values.sort((a, b) => b.q - a.q): stable
        values.sort_by(|a, b| b.q.partial_cmp(&a.q).unwrap_or(std::cmp::Ordering::Equal));
    }
    values
}

/// compress/index.js: selectEncoding with the candidates gzip and deflate.
pub fn select_encoding(header: Option<&str>) -> Option<&'static str> {
    let accepts = parse_accept(header?);
    let wildcard_q = accepts.iter().find(|a| a.kind == "*").map(|a| a.q);
    let mut best: Option<(&'static str, f64)> = None;
    for enc in ["gzip", "deflate"] {
        let explicit = accepts.iter().find(|a| a.kind.to_lowercase() == enc);
        let q = explicit.map(|a| a.q).or(wildcard_q).unwrap_or(0.0);
        if q == 1.0 {
            return Some(enc);
        } else if q > 0.0 && best.is_none_or(|b| q > b.1) {
            best = Some((enc, q));
        }
    }
    best.map(|b| b.0)
}

/// `/(?:^|,)\s*<token>\s*(?:,|$)/i` with `\s*?` or `\s*`: whether a comma-separated header names
/// the token.
fn lists_token(header: &str, token: &str) -> bool {
    header.split(',').any(|part| part.trim_matches(js::is_whitespace).eq_ignore_ascii_case(token))
}

/// A gzip stream with the header zlib writes in Node: no name, no time, and the system's code
/// (3 for Unix, 19 for macOS), where flate2 would write 255, "unknown".
pub fn gzip_writer(out: Vec<u8>, level: flate2::Compression) -> flate2::write::GzEncoder<Vec<u8>> {
    let os = if cfg!(target_os = "macos") { 19 } else { 3 };
    flate2::GzBuilder::new().operating_system(os).write(out, level)
}

/// Compresses bytes as `CompressionStream(encoding)` does: zlib's defaults.
pub fn encode(encoding: &str, data: &[u8]) -> Vec<u8> {
    use flate2::write::{GzEncoder, ZlibEncoder};
    use flate2::Compression;
    if encoding == "gzip" {
        let mut e: GzEncoder<Vec<u8>> = gzip_writer(Vec::with_capacity(data.len() / 3 + 64), Compression::default());
        e.write_all(data).expect("writing to memory");
        e.finish().expect("writing to memory")
    } else {
        let mut e = ZlibEncoder::new(Vec::with_capacity(data.len() / 3 + 64), Compression::default());
        e.write_all(data).expect("writing to memory");
        e.finish().expect("writing to memory")
    }
}

/// hono/compress with its defaults (gzip or deflate, threshold 1024), applied to an answer after
/// the routes below it have run. `method` and `accept_encoding` are the request's.
pub async fn compress(method: &str, accept_encoding: Option<&str>, mut res: Res) -> Res {
    const THRESHOLD: f64 = 1024.0;
    let content_length = res.header("content-length").map(str::to_string);
    if res.status == 206
        || res.header("content-encoding").is_some()
        || res.header("transfer-encoding").is_some()
        || method == "HEAD"
        || content_length.as_deref().is_some_and(|l| !l.is_empty() && js::number(l) < THRESHOLD)
        || !res.header("content-type").is_some_and(|t| !t.is_empty() && compressible(t))
        || res.header("cache-control").is_some_and(|c| !c.is_empty() && lists_token(c, "no-transform"))
    {
        return res;
    }
    let current = res.header("vary").map(str::to_string);
    if current.as_deref() != Some("*") && !current.as_deref().is_some_and(|c| !c.is_empty() && lists_token(c, "accept-encoding")) {
        match current.as_deref() {
            Some(c) if !c.is_empty() => res.set("vary", format!("{c}, Accept-Encoding")),
            _ => res.set("vary", "Accept-Encoding"),
        }
    }
    let Some(encoding) = select_encoding(accept_encoding) else {
        return res;
    };
    res.body = match std::mem::replace(&mut res.body, ResBody::Null) {
        // !ctx.res.body
        ResBody::Null => return res,
        other @ ResBody::Cut(_) => {
            res.body = other;
            return res;
        }
        // CPU work of some milliseconds for the largest answers: off the threads that answer requests
        ResBody::Full(data) => {
            let packed = if data.len() > 16 * 1024 { crate::pool::blocking(move || encode(encoding, &data)).await } else { encode(encoding, &data) };
            ResBody::Stream(Box::pin(stream::once(async move { Ok(Bytes::from(packed)) })))
        }
        // a stream is compressed as it comes, as the source pipes it through a CompressionStream:
        // nothing is held of it but the compressor's window
        ResBody::Stream(s) | ResBody::Promised { stream: s, .. } => ResBody::Stream(compressed(encoding, s)),
    };
    res.delete("content-length");
    res.set("content-encoding", encoding);
    if let Some(etag) = res.header("etag").map(str::to_string) {
        if !etag.is_empty() && !etag.starts_with("W/") {
            res.set("etag", format!("W/{etag}"));
        }
    }
    res
}

/// A zlib compressor writing into memory.
enum Packer {
    Gzip(flate2::write::GzEncoder<Vec<u8>>),
    Deflate(flate2::write::ZlibEncoder<Vec<u8>>),
}

impl Packer {
    fn new(encoding: &str) -> Packer {
        if encoding == "gzip" {
            Packer::Gzip(gzip_writer(Vec::new(), flate2::Compression::default()))
        } else {
            Packer::Deflate(flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default()))
        }
    }

    /// Takes `data` in and gives what the compressor has written out so far (often nothing).
    fn push(&mut self, data: &[u8]) -> Vec<u8> {
        match self {
            Packer::Gzip(e) => {
                e.write_all(data).expect("writing to memory");
                std::mem::take(e.get_mut())
            }
            Packer::Deflate(e) => {
                e.write_all(data).expect("writing to memory");
                std::mem::take(e.get_mut())
            }
        }
    }

    /// The rest of the output.
    fn finish(self) -> Vec<u8> {
        match self {
            Packer::Gzip(e) => e.finish().expect("writing to memory"),
            Packer::Deflate(e) => e.finish().expect("writing to memory"),
        }
    }
}

/// A stream, compressed chunk by chunk as it is read: `body.pipeThrough(new
/// CompressionStream(encoding))`. The source is read only when the reader of the answer wants
/// more, so a client that stops reading stops the reading of the source too.
pub fn compressed(encoding: &'static str, source: BodyStream) -> BodyStream {
    struct Piping {
        source: BodyStream,
        /// None once the source has ended and the last bytes are out.
        packer: Option<Packer>,
    }
    Box::pin(stream::unfold(Piping { source, packer: Some(Packer::new(encoding)) }, |mut piping| async move {
        loop {
            let mut packer = piping.packer.take()?;
            match piping.source.next().await {
                Some(Ok(chunk)) => {
                    // zlib on a chunk of a file is a millisecond or more of a core
                    let (packer, out) = if chunk.len() > 16 * 1024 {
                        crate::pool::blocking(move || {
                            let out = packer.push(&chunk);
                            (packer, out)
                        })
                        .await
                    } else {
                        let out = packer.push(&chunk);
                        (packer, out)
                    };
                    piping.packer = Some(packer);
                    if !out.is_empty() {
                        return Some((Ok(Bytes::from(out)), piping));
                    }
                }
                // the source failed: so does the answer, where it stands
                Some(Err(e)) => return Some((Err(e), piping)),
                None => return Some((Ok(Bytes::from(packer.finish())), piping)),
            }
        }
    }))
}

/// Node's keep-alive time: an answer that promises bytes it does not send leaves the client waiting
/// this long before the connection is closed.
const KEEP_ALIVE: Duration = Duration::from_secs(5);

/// Writes an answer as `@hono/node-server` and Node's `http` do:
///  - a string or bytes get a `Content-Length` unless the answer has one;
///  - a `null` body has no `Content-Length` (Node sends it chunked and empty);
///  - a HEAD request gets the head of the GET answer as its headers stand, without a body and
///    without a computed `Content-Length` (`new Response(null, res)` in hono-base.js).
pub fn into_response(res: Res, head: bool) -> axum::response::Response {
    let mut builder = axum::response::Response::builder().status(StatusCode::from_u16(res.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR));
    let has_length = res.header("content-length").is_some();
    {
        let headers = builder.headers_mut().expect("a new builder");
        for (name, value) in &res.headers {
            let (Ok(n), Ok(v)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_bytes(value.as_bytes())) else {
                continue;
            };
            headers.append(n, v);
        }
    }
    let body = if head {
        Body::empty()
    } else {
        match res.body {
            ResBody::Full(b) => {
                if !has_length {
                    builder = builder.header("content-length", b.len());
                }
                Body::from(b)
            }
            // a length and no body (OPTIONS on a static file): the client waits for bytes that never come
            ResBody::Null if has_length && res.header("content-length") != Some("0") => Body::from_stream(silence()),
            ResBody::Null if has_length => Body::empty(),
            // no length: an empty stream, which is sent as an empty chunked body
            ResBody::Null => Body::from_stream(stream::empty::<Result<Bytes, std::io::Error>>()),
            ResBody::Stream(s) => Body::from_stream(s),
            ResBody::Promised { stream, bytes } => promised_body(stream, bytes),
            // node.rs ends the connection before it comes to this
            ResBody::Cut(_) => Body::empty(),
        }
    };
    builder.body(body).expect("a valid response")
}

/// Silence for Node's keep-alive time, then the connection is cut.
fn silence() -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    stream::once(async {
        tokio::time::sleep(KEEP_ALIVE).await;
        Err::<Bytes, std::io::Error>(std::io::Error::other("the answer promised more bytes than it has"))
    })
}

/// The stream, and when it has ended before `promised` bytes, silence for Node's keep-alive time
/// before the connection is cut.
fn promised_body(source: BodyStream, promised: u64) -> Body {
    struct Counting {
        source: Option<BodyStream>,
        left: u64,
    }
    let counted = stream::unfold(Counting { source: Some(source), left: promised }, |mut c| async move {
        let source = c.source.as_mut()?;
        match source.next().await {
            Some(Ok(chunk)) => {
                c.left = c.left.saturating_sub(chunk.len() as u64);
                Some((Ok(chunk), c))
            }
            Some(Err(e)) => {
                c.source = None;
                Some((Err(e), c))
            }
            None if c.left == 0 => None,
            None => {
                c.source = None;
                tokio::time::sleep(KEEP_ALIVE).await;
                Some((Err(std::io::Error::other("the answer promised more bytes than it has")), c))
            }
        }
    });
    Body::from_stream(counted)
}

/// The next frame of a request body; None at its end. `Err` is the end of the request: the body
/// did not arrive whole (a chunk size that is none, a connection closed before the length was
/// reached: `cut::BAD_REQUEST`), or not by the request's deadline (`cut::REQUEST_TIMEOUT`).
///
/// In Node the stream of such a body fails (`aborted`), the route that reads it throws, and the
/// socket is destroyed; nothing is done with the part that came. A truncated or mis-framed upload
/// whose beginning happens to be a whole JSON text must not be taken for the body.
async fn next_frame(body: &mut Body, deadline: Option<tokio::time::Instant>) -> Result<Option<hyper::body::Frame<Bytes>>, Res> {
    let frame = match deadline {
        Some(at) => match tokio::time::timeout_at(at, body.frame()).await {
            Ok(frame) => frame,
            Err(_) => return Err(Res::cut(cut::REQUEST_TIMEOUT)),
        },
        None => body.frame().await,
    };
    match frame {
        None => Ok(None),
        Some(Ok(frame)) => Ok(Some(frame)),
        Some(Err(_)) => Err(Res::cut(cut::BAD_REQUEST)),
    }
}

/// limits.ts: readBodyWithin, the part of hono/body-limit and `c.req.text()`: the request body as
/// bytes, or None when it is larger than `max`. A body with a Content-Length above the limit is
/// not read at all; one without (chunked) is read only up to the limit. `Err` when the body does
/// not arrive whole and in time (`next_frame`): the caller returns it, and does nothing else.
pub async fn read_body_within(req: &mut Req, max: usize) -> Result<Option<Bytes>, Res> {
    let Some(mut body) = req.take_body() else {
        return Ok(Some(Bytes::new()));
    };
    let has_transfer_encoding = req.headers.contains_key("transfer-encoding");
    if !has_transfer_encoding {
        if let Some(length) = req.header("content-length") {
            // parseInt(length, 10) > maxSize
            if js::parse_int(&length) > max as f64 {
                req.put_body(body);
                return Ok(None);
            }
        }
    }
    let mut parts: Vec<Bytes> = Vec::new();
    let mut size = 0usize;
    while let Some(frame) = next_frame(&mut body, req.deadline).await? {
        if let Ok(data) = frame.into_data() {
            size += data.len();
            if size > max {
                req.put_body(body);
                return Ok(None);
            }
            parts.push(data);
        }
    }
    Ok(Some(concat(parts, size)))
}

/// The whole request body (`await c.req.text()` without a limit). `Err` as for `read_body_within`.
pub async fn read_body(req: &mut Req) -> Result<Bytes, Res> {
    let Some(mut body) = req.take_body() else {
        return Ok(Bytes::new());
    };
    let mut parts: Vec<Bytes> = Vec::new();
    let mut size = 0usize;
    while let Some(frame) = next_frame(&mut body, req.deadline).await? {
        if let Ok(data) = frame.into_data() {
            size += data.len();
            parts.push(data);
        }
    }
    Ok(concat(parts, size))
}

fn concat(mut parts: Vec<Bytes>, size: usize) -> Bytes {
    if parts.len() == 1 {
        return parts.pop().unwrap();
    }
    let mut all = Vec::with_capacity(size);
    for p in &parts {
        all.extend_from_slice(p);
    }
    Bytes::from(all)
}

/// node-server: drainIncoming. A request body that no route read is read and thrown away after the
/// answer, for at most half a second and 64 MB, so that the client can finish sending and read the
/// answer on the same connection; after that the connection is closed.
pub fn drain(mut body: Body) {
    const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
    const MAX_DRAIN_BYTES: usize = 64 * 1024 * 1024;
    tokio::spawn(async move {
        let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
            let mut read = 0usize;
            while let Some(Ok(frame)) = body.frame().await {
                if let Ok(data) = frame.into_data() {
                    read += data.len();
                    if read > MAX_DRAIN_BYTES {
                        break;
                    }
                }
            }
        })
        .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressible_types() {
        for t in ["text/html; charset=utf-8", "application/json", " Text/Plain", "image/svg+xml; charset=utf-8", "application/ld+json", "font/otf", "text/css;x", "text/event-streams"] {
            assert!(compressible(t), "{t}");
        }
        for t in ["text/event-stream", "text/event-stream; charset=utf-8", "application/gzip", "application/octet-stream", "image/png", "text/", "application/jsonx", "+json", ""] {
            assert!(!compressible(t), "{t}");
        }
    }

    #[test]
    fn encodings() {
        assert_eq!(select_encoding(None), None);
        assert_eq!(select_encoding(Some("gzip")), Some("gzip"));
        assert_eq!(select_encoding(Some("deflate")), Some("deflate"));
        assert_eq!(select_encoding(Some("br")), None);
        assert_eq!(select_encoding(Some("gzip, deflate, br")), Some("gzip"));
        assert_eq!(select_encoding(Some("identity")), None);
        assert_eq!(select_encoding(Some("*")), Some("gzip"));
        assert_eq!(select_encoding(Some("gzip;q=0")), None);
        assert_eq!(select_encoding(Some("x-gzip")), None);
        assert_eq!(select_encoding(Some("GZIP")), Some("gzip"));
        assert_eq!(select_encoding(Some("gzip;q=0.5, deflate;q=0.8")), Some("deflate"));
        assert_eq!(select_encoding(Some("gzip;q=0, *;q=0.3")), Some("deflate"));
        assert_eq!(select_encoding(Some("deflate, gzip;q=0.9")), Some("deflate"));
        assert_eq!(select_encoding(Some("")), None);
        assert_eq!(select_encoding(Some("gzip; q=\"0\"")), None);
        assert_eq!(select_encoding(Some(" gzip ; q = 0.2 ,deflate")), Some("deflate"));
    }
}
