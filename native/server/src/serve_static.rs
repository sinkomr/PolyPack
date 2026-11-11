//! Port of `serveStatic` of `@hono/node-server` (dist/serve-static.mjs, 1.19.17) with the options
//! node.ts gives it (`{ root }`), and of `getMimeType` of hono/utils/mime: the built website,
//! served by the same process.
//!
//! Its oddities are the source's and are kept (native/tools/serverdiff/README.md lists them): a
//! file is served for every method; OPTIONS is answered like HEAD, with the file's length and no
//! body; a `Range` is read loosely (`bytes=-5` is bytes 0 to 5), one that starts after its end is
//! an exception (500), and one beyond the end of the file promises bytes that never come.

use std::path::Path;
use std::sync::Arc;

use bytes::Bytes;
use futures_util::stream;

use crate::hono::{BodyStream, Req, Res, ResBody, Thrown};
use crate::js;

/// How much of a file is read at a time: the `highWaterMark` of Node's `createReadStream`.
const CHUNK: u64 = 64 * 1024;

/// `createReadStream(path, { start, end })`, piped to the answer: `count` bytes of the file from
/// `start`, read a chunk at a time, each when the connection asks for more. A client that stops
/// reading stops the reading of the file: what a stalled download holds is the chunk in hand and
/// the connection's write buffer, whatever the size of the file. (The whole file in memory per
/// answer, as it was once read, let a few hundred stalled downloads of the largest viewer page
/// take gigabytes.) The stream ends early when the file does.
fn file_stream(file: Option<std::fs::File>, start: u64, count: u64) -> BodyStream {
    struct Reading {
        file: Arc<std::fs::File>,
        at: u64,
        left: u64,
    }
    let Some(file) = file else {
        return Box::pin(stream::empty());
    };
    Box::pin(stream::unfold(Reading { file: Arc::new(file), at: start, left: count }, |mut r| async move {
        if r.left == 0 {
            return None;
        }
        let (file, at, want) = (r.file.clone(), r.at, r.left.min(CHUNK) as usize);
        // a read of a file blocks its thread, for as long as the disk takes
        let read = crate::pool::blocking(move || -> std::io::Result<Vec<u8>> {
            use std::os::unix::fs::FileExt;
            let mut buf = vec![0u8; want];
            let mut got = 0;
            while got < want {
                match file.read_at(&mut buf[got..], at + got as u64) {
                    Ok(0) => break,
                    Ok(n) => got += n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => return Err(e),
                }
            }
            buf.truncate(got);
            Ok(buf)
        })
        .await;
        match read {
            // the file is shorter than it was said to be: the answer ends here
            Ok(buf) if buf.is_empty() => None,
            Ok(buf) => {
                r.at += buf.len() as u64;
                r.left -= buf.len() as u64;
                Some((Ok(Bytes::from(buf)), r))
            }
            Err(_) => None,
        }
    }))
}

/// hono/utils/mime: baseMimes.
const MIMES: [(&str, &str); 56] = [
    ("aac", "audio/aac"),
    ("avi", "video/x-msvideo"),
    ("avif", "image/avif"),
    ("av1", "video/av1"),
    ("bin", "application/octet-stream"),
    ("bmp", "image/bmp"),
    ("css", "text/css; charset=utf-8"),
    ("csv", "text/csv; charset=utf-8"),
    ("eot", "application/vnd.ms-fontobject"),
    ("epub", "application/epub+zip"),
    ("gif", "image/gif"),
    ("gz", "application/gzip"),
    ("htm", "text/html; charset=utf-8"),
    ("html", "text/html; charset=utf-8"),
    ("ico", "image/x-icon"),
    ("ics", "text/calendar; charset=utf-8"),
    ("jpeg", "image/jpeg"),
    ("jpg", "image/jpeg"),
    ("js", "text/javascript; charset=utf-8"),
    ("json", "application/json"),
    ("jsonld", "application/ld+json"),
    ("map", "application/json"),
    ("mid", "audio/x-midi"),
    ("midi", "audio/x-midi"),
    ("mjs", "text/javascript; charset=utf-8"),
    ("mp3", "audio/mpeg"),
    ("mp4", "video/mp4"),
    ("mpeg", "video/mpeg"),
    ("oga", "audio/ogg"),
    ("ogv", "video/ogg"),
    ("ogx", "application/ogg"),
    ("opus", "audio/opus"),
    ("otf", "font/otf"),
    ("pdf", "application/pdf"),
    ("png", "image/png"),
    ("rtf", "application/rtf"),
    ("svg", "image/svg+xml; charset=utf-8"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("ts", "video/mp2t"),
    ("ttf", "font/ttf"),
    ("txt", "text/plain; charset=utf-8"),
    ("wasm", "application/wasm"),
    ("webm", "video/webm"),
    ("weba", "audio/webm"),
    ("webmanifest", "application/manifest+json"),
    ("webp", "image/webp"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("xhtml", "application/xhtml+xml; charset=utf-8"),
    ("xml", "application/xml; charset=utf-8"),
    ("zip", "application/zip"),
    ("3gp", "video/3gpp"),
    ("3g2", "video/3gpp2"),
    ("gltf", "model/gltf+json"),
    ("glb", "model/gltf-binary"),
];

/// hono/utils/mime: getMimeType. The type of a file by its extension: what follows the last dot,
/// when that is letters and digits only (`/\.([a-zA-Z0-9]+?)$/`).
pub fn get_mime_type(filename: &str) -> Option<&'static str> {
    let ext = &filename[filename.rfind('.')? + 1..];
    if ext.is_empty() || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let ext = ext.to_ascii_lowercase();
    MIMES.iter().find(|(e, _)| *e == ext).map(|(_, mime)| *mime)
}

/// `/(?:^|[\/\\])\.{1,2}(?:$|[\/\\])|[\/\\]{2,}|\\/`: a path that names a dot segment, an empty
/// segment or holds a backslash is not served.
fn refused(filename: &str) -> bool {
    filename.contains('\\') || filename.contains("//") || filename.split('/').any(|segment| segment == "." || segment == "..")
}

/// serveStatic({ root }). `Ok(None)`: no such file, the next handler answers (`next()`). It looks
/// the file up and opens it, which may block: call it from `pool::blocking`.
pub fn serve_static(root: &str, req: &Req) -> Result<Option<Res>, Thrown> {
    let filename = js::try_decode_uri(&req.path);
    if refused(&filename) {
        return Ok(None);
    }
    // path.join(root, filename): the name begins with a slash and has nothing left to normalise
    let mut path = format!("{}{}", root.trim_end_matches('/'), filename);
    let stat = |p: &str| if p.contains('\0') { None } else { std::fs::metadata(Path::new(p)).ok() };
    let mut stats = stat(&path);
    if stats.as_ref().is_some_and(|s| s.is_dir()) {
        path = format!("{}/index.html", path.trim_end_matches('/'));
        stats = stat(&path);
    }
    let Some(stats) = stats else {
        return Ok(None);
    };
    let mime = get_mime_type(&path).unwrap_or("application/octet-stream");
    let mut res = Res::new(200, ResBody::Null);
    res.set("content-type", mime);
    let size = stats.len();
    let range = req.header("range").unwrap_or_default();
    if req.method == "HEAD" || req.method == "OPTIONS" {
        res.set("content-length", size.to_string());
        return Ok(Some(res));
    }
    // The file is opened now and read as the answer is sent. One that cannot be opened, or that
    // ends before the length the answer names, leaves that answer short (ResBody::Promised).
    let open = || std::fs::File::open(Path::new(&path)).ok();
    if range.is_empty() {
        res.set("content-length", size.to_string());
        res.body = ResBody::Promised { stream: file_stream(open(), 0, size), bytes: size };
        return Ok(Some(res));
    }
    res.set("accept-ranges", "bytes");
    // stats.birthtime.toUTCString()
    let born = stats.created().or_else(|_| stats.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_millis() as f64);
    res.set("date", js::to_utc_string(born));
    // range.replace(/bytes=/, "").split("-", 2)
    let spec = range.replacen("bytes=", "", 1);
    let mut parts = spec.split('-');
    let or = |x: f64, fallback: f64| if x.is_nan() || x == 0.0 { fallback } else { x };
    let start = or(js::parse_int(parts.next().unwrap_or("")), 0.0);
    let mut end = or(parts.next().map_or(f64::NAN, js::parse_int), size as f64 - 1.0);
    if (size as f64) < end - start + 1.0 {
        end = size as f64 - 1.0;
    }
    let chunksize = end - start + 1.0;
    // createReadStream(path, { start, end }) throws for a range that is none
    let safe = |x: f64| js::is_integer(x) && (0.0..=9007199254740991.0).contains(&x);
    if !safe(start) || !safe(end) || start > end {
        let what = if !safe(start) || !safe(end) {
            format!("RangeError [ERR_OUT_OF_RANGE]: The value of \"{}\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}", if !safe(start) { "start" } else { "end" }, polypack_js::fmt::num(if !safe(start) { start } else { end }))
        } else {
            format!("RangeError [ERR_OUT_OF_RANGE]: The value of \"start\" is out of range. It must be <= \"end\" (here: {}). Received {}", polypack_js::fmt::num(end), polypack_js::fmt::num(start))
        };
        return Err(Thrown { message: what, headers: res.headers });
    }
    res.set("content-length", polypack_js::fmt::num(chunksize));
    res.set("content-range", format!("bytes {}-{}/{}", polypack_js::fmt::num(start), polypack_js::fmt::num(end), size));
    res.status = 206;
    res.body = ResBody::Promised { stream: file_stream(open(), start as u64, chunksize as u64), bytes: chunksize as u64 };
    Ok(Some(res))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_types_by_extension() {
        assert_eq!(get_mime_type("/a/index.html"), Some("text/html; charset=utf-8"));
        assert_eq!(get_mime_type("/a/INDEX.HTML"), Some("text/html; charset=utf-8"));
        assert_eq!(get_mime_type("/a/app.js"), Some("text/javascript; charset=utf-8"));
        assert_eq!(get_mime_type("/a/x.tar.gz"), Some("application/gzip"));
        assert_eq!(get_mime_type("/a/data.bin"), Some("application/octet-stream"));
        assert_eq!(get_mime_type("/a/noext"), None);
        assert_eq!(get_mime_type("/a/.hidden"), None);
        assert_eq!(get_mime_type("/a.b/noext"), None);
        assert_eq!(get_mime_type("/a/x."), None);
        assert_eq!(get_mime_type("/a/unicode-é.txt"), Some("text/plain; charset=utf-8"));
    }

    #[test]
    fn paths_that_are_not_served() {
        for p in ["/../x", "/a/../b", "/./a", "/a/.", "/a//b", "//a", "/a\\b", "/.."] {
            assert!(refused(p), "{p}");
        }
        for p in ["/", "/a", "/a/", "/.hidden", "/a/..b", "/a/b.c", "/..%2fx", "/..."] {
            assert!(!refused(p), "{p}");
        }
    }
}
