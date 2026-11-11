//! A small load generator for a PolyPack server (the TypeScript one or the Rust one): real boards
//! from the site's snapshot files as submissions at a set rate over many connections, with some
//! live streams open, and what came of it: throughput, the share of each status, latency
//! percentiles, the server's CPU time.
//!
//!   cargo run --release -p polypack-server --example load -- \
//!       --port 23200 --rate 500 --seconds 20 --connections 64 --streams 40 \
//!       --boards 3000 --min-p 100 --pid <server pid> SNAP/n-4.json.gz SNAP/n-6.json.gz
//!
//! The load is open: request k is due at k / rate seconds whether or not the server keeps up, and
//! its latency is counted from that moment, so a server that falls behind shows it. Each board is
//! a leading entry of the site, valid by construction; on a fresh database the first submission of
//! a problem is its leader, and a board sent again (when the run needs more requests than there
//! are boards) ties it and is not kept. Every request carries its own address in `x-load-ip`
//! (start the server with CLIENT_IP_HEADER=x-load-ip), so the limits of one address do not decide
//! the result. Sends nothing anywhere but to 127.0.0.1.
//!
//! With `--space-file SPACESNAP/space-polyhedra.json.gz --space-rate 3 --space-min-p 100` the run
//! is mixed: leading entries of a space (each of another problem, so each is checked and kept) are
//! posted to /api/spaces/submit at their own rate on connections of their own, among the boards,
//! and counted apart.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

struct Args {
    port: u16,
    rate: f64,
    seconds: f64,
    connections: usize,
    streams: usize,
    boards: usize,
    min_p: u64,
    max_p: u64,
    pid: Option<u32>,
    files: Vec<String>,
    space_file: Option<String>,
    space_rate: f64,
    space_min_p: u64,
    space_max_p: u64,
}

fn args() -> Args {
    let mut a = Args { port: 0, rate: 100.0, seconds: 10.0, connections: 32, streams: 0, boards: 2000, min_p: 1, max_p: 500, pid: None, files: Vec::new(), space_file: None, space_rate: 0.0, space_min_p: 30, space_max_p: 500 };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().unwrap_or_else(|| panic!("{arg} needs a value"));
        match arg.as_str() {
            "--port" => a.port = value().parse().expect("a port"),
            "--rate" => a.rate = value().parse().expect("requests per second"),
            "--seconds" => a.seconds = value().parse().expect("seconds"),
            "--connections" => a.connections = value().parse().expect("a count"),
            "--streams" => a.streams = value().parse().expect("a count"),
            "--boards" => a.boards = value().parse().expect("a count"),
            "--min-p" => a.min_p = value().parse().expect("a count"),
            "--max-p" => a.max_p = value().parse().expect("a count"),
            "--pid" => a.pid = Some(value().parse().expect("a process id")),
            "--space-file" => a.space_file = Some(value()),
            "--space-rate" => a.space_rate = value().parse().expect("requests per second"),
            "--space-min-p" => a.space_min_p = value().parse().expect("a count"),
            "--space-max-p" => a.space_max_p = value().parse().expect("a count"),
            _ => a.files.push(arg),
        }
    }
    assert!(a.port > 20000, "--port PORT (above 20000) is required");
    assert!(!a.files.is_empty(), "give at least one n-*.json.gz file");
    a
}

/// The bodies of POST /api/submit for up to `want` boards of the files, taken evenly from each.
fn load_boards(files: &[String], want: usize, min_p: u64, max_p: u64) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let per_file = want.div_ceil(files.len());
    for file in files {
        let reader = BufReader::new(flate2::read::MultiGzDecoder::new(std::fs::File::open(file).unwrap_or_else(|e| panic!("{file}: {e}"))));
        // `"key":123` of a header line
        let field = |text: &str, key: &str| -> Option<u64> {
            let at = text.find(&format!("\"{key}\":"))? + key.len() + 3;
            text[at..].chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()
        };
        let (mut n, mut m) = (0u64, 0u64);
        let mut kept: Vec<Vec<u8>> = Vec::new();
        let mut seen = 0usize;
        for line in reader.lines() {
            let line = line.expect("a line of the file");
            let text = line.trim_end_matches(',');
            if text.starts_with("{\"format\"") {
                // the header of the file or of a pair: {"format":3,"N":4,"M":0,"records":[
                n = field(text, "N").unwrap_or(n);
                m = field(text, "M").unwrap_or(m);
                continue;
            }
            if !text.starts_with("{\"P\"") {
                continue;
            }
            let Ok(record) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            let p = record["P"].as_u64().unwrap_or(0);
            if p < min_p || p > max_p {
                continue;
            }
            seen += 1;
            // every 7th board of the file that fits, so that the sample spans the pairs
            if seen % 7 != 0 {
                continue;
            }
            let pieces: Vec<Value> = record["pieces"].as_array().map(|list| list.iter().map(|q| json!({ "x": q[0], "y": q[1], "theta": q[2] })).collect()).unwrap_or_default();
            let body = json!({ "N": n, "M": m, "P": p, "pieces": pieces, "container_phi": record["container_phi"], "name": "load test", "found_with": "external", "units": "diameter" });
            kept.push(serde_json::to_vec(&body).expect("JSON"));
            if kept.len() >= per_file {
                break;
            }
        }
        out.extend(kept);
    }
    out
}

/// The bodies of POST /api/spaces/submit for up to `want` entries of a space's snapshot file with
/// `min_p` to `max_p` pieces, each of another problem.
fn load_space_entries(file: &str, want: usize, min_p: u64, max_p: u64) -> Vec<Vec<u8>> {
    let reader = BufReader::new(flate2::read::MultiGzDecoder::new(std::fs::File::open(file).unwrap_or_else(|e| panic!("{file}: {e}"))));
    let mut out = Vec::new();
    for line in reader.lines() {
        let line = line.expect("a line of the file");
        let text = line.trim_end_matches(',');
        if !text.starts_with("{\"problem\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        let p = record["P"].as_u64().unwrap_or(0);
        let Some(problem) = record["problem"].as_str() else {
            continue;
        };
        if p < min_p || p > max_p {
            continue;
        }
        let space = problem.split('/').next().unwrap_or("");
        let body = json!({ "space": space, "id": problem, "config": record["config"], "name": "load test", "units": "diameter" });
        out.push(serde_json::to_vec(&body).expect("JSON"));
        if out.len() >= want {
            break;
        }
    }
    out
}

/// One answer: its status and the time it took from when the request was due, in milliseconds.
struct Answer {
    status: u16,
    ms: f64,
    leader: bool,
}

/// Sends one request on the connection and reads its answer (a body with a Content-Length).
async fn exchange(stream: &mut TcpStream, request: &[u8], body: &[u8], buf: &mut Vec<u8>) -> std::io::Result<(u16, bool)> {
    stream.write_all(request).await?;
    stream.write_all(body).await?;
    buf.clear();
    let mut chunk = [0u8; 16384];
    let (head_end, length, status) = loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "closed"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..at]).to_ascii_lowercase();
            let status: u16 = head.get(9..12).and_then(|s| s.parse().ok()).unwrap_or(0);
            let length: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
            break (at + 4, length, status);
        }
    };
    while buf.len() < head_end + length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "closed"));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let leader = buf[head_end..].windows(13).any(|w| w == b"\"leader\":true");
    Ok((status, leader))
}

/// The CPU time a process has used so far, in seconds (`ps -o time=`: [[dd-]hh:]mm:ss.cc).
fn cpu_seconds(pid: u32) -> Option<f64> {
    let out = std::process::Command::new("ps").args(["-o", "time=", "-p", &pid.to_string()]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (days, rest) = match text.split_once('-') {
        Some((d, r)) => (d.parse::<f64>().ok()?, r.to_string()),
        None => (0.0, text),
    };
    let mut total = 0.0;
    for part in rest.split(':') {
        total = total * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(days * 86400.0 + total)
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted[((q * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1]
}

/// Offers `total` requests to `path` at `rate` a second over `connections` connections, request k
/// with the body `bodies[k % len]` and an address of its own under `net`; the answers.
#[allow(clippy::too_many_arguments)]
async fn offer(port: u16, path: &'static str, rate: f64, total: u64, connections: usize, bodies: Arc<Vec<Vec<u8>>>, net: u8, began: Instant, errors: Arc<AtomicU64>) -> Vec<Answer> {
    let next = Arc::new(AtomicU64::new(0));
    let answers: Arc<Mutex<Vec<Answer>>> = Arc::new(Mutex::new(Vec::with_capacity(total as usize)));
    let mut workers = Vec::new();
    for _ in 0..connections {
        let (bodies, next, answers, errors) = (bodies.clone(), next.clone(), answers.clone(), errors.clone());
        workers.push(tokio::spawn(async move {
            let mut stream: Option<TcpStream> = None;
            let mut buf = Vec::with_capacity(4096);
            let mut mine = Vec::new();
            loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                if k >= total {
                    break;
                }
                let due = began + Duration::from_secs_f64(k as f64 / rate);
                tokio::time::sleep_until(due.into()).await;
                let body = &bodies[k as usize % bodies.len()];
                let request = format!(
                    "POST {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\ncontent-type: application/json\r\nx-load-ip: {net}.{}.{}.{}\r\ncontent-length: {}\r\n\r\n",
                    (k >> 16) & 255,
                    (k >> 8) & 255,
                    k & 255,
                    body.len()
                );
                let mut done = None;
                for _attempt in 0..2 {
                    if stream.is_none() {
                        stream = TcpStream::connect(("127.0.0.1", port)).await.ok();
                        if let Some(s) = &stream {
                            let _ = s.set_nodelay(true);
                        }
                    }
                    let Some(s) = stream.as_mut() else {
                        break;
                    };
                    match exchange(s, request.as_bytes(), body, &mut buf).await {
                        Ok(r) => {
                            done = Some(r);
                            break;
                        }
                        // a connection the server closed meanwhile: once more on a new one
                        Err(_) => stream = None,
                    }
                }
                match done {
                    Some((status, leader)) => mine.push(Answer { status, ms: due.elapsed().as_secs_f64() * 1000.0, leader }),
                    None => {
                        errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            answers.lock().await.extend(mine);
        }));
    }
    for w in workers {
        let _ = w.await;
    }
    let mut answers = answers.lock().await;
    std::mem::take(&mut *answers)
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let a = args();
    let boards = Arc::new(load_boards(&a.files, a.boards, a.min_p, a.max_p));
    assert!(!boards.is_empty(), "no board in the files fits");
    let bytes: usize = boards.iter().map(Vec::len).sum();
    println!("{} boards, {:.1} kB each on average", boards.len(), bytes as f64 / boards.len() as f64 / 1000.0);

    // the live streams: opened first, each on its own connection; what they receive is counted
    let events = Arc::new(AtomicU64::new(0));
    let mut stream_tasks = Vec::new();
    for k in 0..a.streams {
        let events = events.clone();
        let port = a.port;
        stream_tasks.push(tokio::spawn(async move {
            let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)).await else {
                return;
            };
            // a third of the streams follow every problem, the others one pair of shapes each
            let path = if k % 3 == 0 { "/api/events".to_string() } else { format!("/api/events?keys={}/{}/*", [4, 6, 3, 0][k % 4], [0, 3, 4, 5, 6][k % 5]) };
            if s.write_all(format!("GET {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).await.is_err() {
                return;
            }
            let mut chunk = [0u8; 8192];
            while let Ok(n) = s.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                events.fetch_add(chunk[..n].windows(18).filter(|w| *w == b"event: leaderboard").count() as u64, Ordering::Relaxed);
            }
        }));
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    let total = (a.rate * a.seconds).round() as u64;
    let errors = Arc::new(AtomicU64::new(0));
    // the entries of a space, read before the clock of the run starts
    let entries = match &a.space_file {
        Some(file) if a.space_rate > 0.0 => {
            let wanted = (a.space_rate * a.seconds).round() as usize;
            let entries = Arc::new(load_space_entries(file, wanted, a.space_min_p, a.space_max_p));
            assert!(!entries.is_empty(), "no entry in {file} fits");
            let bytes: usize = entries.iter().map(Vec::len).sum();
            println!("{} space entries, {:.1} kB each on average", entries.len(), bytes as f64 / entries.len() as f64 / 1000.0);
            Some(entries)
        }
        _ => None,
    };
    let cpu_before = a.pid.and_then(cpu_seconds);
    let began = Instant::now();
    let flat = tokio::spawn(offer(a.port, "/api/submit", a.rate, total, a.connections, boards.clone(), 10, began, errors.clone()));
    // among the boards
    let space = entries.map(|entries| tokio::spawn(offer(a.port, "/api/spaces/submit", a.space_rate, entries.len() as u64, 16, entries, 11, began, errors.clone())));
    let answers = flat.await.expect("the boards' task");
    let space_answers = match space {
        Some(task) => Some(task.await.expect("the entries' task")),
        None => None,
    };
    let wall = began.elapsed().as_secs_f64();
    let cpu_after = a.pid.and_then(cpu_seconds);
    tokio::time::sleep(Duration::from_millis(300)).await;
    for t in &stream_tasks {
        t.abort();
    }

    let mut by_status: HashMap<u16, u64> = HashMap::new();
    for r in answers.iter() {
        *by_status.entry(r.status).or_default() += 1;
    }
    let mut statuses: Vec<(u16, u64)> = by_status.into_iter().collect();
    statuses.sort();
    let mut all: Vec<f64> = answers.iter().map(|r| r.ms).collect();
    all.sort_by(f64::total_cmp);
    let mut ok: Vec<f64> = answers.iter().filter(|r| r.status == 200).map(|r| r.ms).collect();
    ok.sort_by(f64::total_cmp);
    let accepted = ok.len() as f64;
    let refused = answers.iter().filter(|r| r.status == 503).count() as f64;
    println!("offered {:.0}/s for {:.0} s on {} connections with {} streams: {} requests in {:.1} s", a.rate, a.seconds, a.connections, a.streams, total, wall);
    println!("answered {} ({:.0}/s), connection errors {}", answers.len(), answers.len() as f64 / wall, errors.load(Ordering::Relaxed));
    println!("statuses: {}", statuses.iter().map(|(s, n)| format!("{s}: {n}")).collect::<Vec<_>>().join(", "));
    println!("accepted (200): {:.0}/s, of them leaders {}; refused as busy (503): {:.1}%", accepted / wall, answers.iter().filter(|r| r.leader).count(), 100.0 * refused / answers.len().max(1) as f64);
    println!("latency of all answers, ms: p50 {:.1}, p90 {:.1}, p99 {:.1}, max {:.1}", percentile(&all, 0.5), percentile(&all, 0.9), percentile(&all, 0.99), all.last().copied().unwrap_or(f64::NAN));
    println!("latency of accepted,    ms: p50 {:.1}, p90 {:.1}, p99 {:.1}, max {:.1}", percentile(&ok, 0.5), percentile(&ok, 0.9), percentile(&ok, 0.99), ok.last().copied().unwrap_or(f64::NAN));
    println!("leaderboard events received by the streams: {}", events.load(Ordering::Relaxed));
    if let Some(space) = &space_answers {
        let mut by: HashMap<u16, u64> = HashMap::new();
        for r in space.iter() {
            *by.entry(r.status).or_default() += 1;
        }
        let mut by: Vec<(u16, u64)> = by.into_iter().collect();
        by.sort();
        let mut ms: Vec<f64> = space.iter().map(|r| r.ms).collect();
        ms.sort_by(f64::total_cmp);
        println!(
            "space entries: offered {:.1}/s, answered {} (statuses: {}), of them leaders {}",
            a.space_rate,
            space.len(),
            by.iter().map(|(s, n)| format!("{s}: {n}")).collect::<Vec<_>>().join(", "),
            space.iter().filter(|r| r.leader).count()
        );
        println!("latency of space entries, ms: p50 {:.1}, p90 {:.1}, p99 {:.1}, max {:.1}", percentile(&ms, 0.5), percentile(&ms, 0.9), percentile(&ms, 0.99), ms.last().copied().unwrap_or(f64::NAN));
    }
    if let (Some(b), Some(e)) = (cpu_before, cpu_after) {
        println!("server CPU: {:.1} s over {:.1} s of wall time ({:.0}% of one core)", e - b, wall, 100.0 * (e - b) / wall);
    }
}
