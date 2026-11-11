//! Port of apps/server/src/load.ts: what the server did with submissions, for the log.
//!
//! The source's `LoopDelay` measures how late the one thread of the Node server runs. The Rust
//! server has no such thread; the measure in its place is how long a verification waits for a free
//! worker, kept over the same windows (`pool::Pool::delay_ms`, `take_peak`). The minute's line
//! keeps the source's words for it.

use polypack_js::fmt;

/// load.ts: MAX_SAMPLES. Verification times kept for one minute's percentiles; more are counted
/// but not kept.
const MAX_SAMPLES: usize = 100_000;

/// load.ts: fmtMs.
fn fmt_ms(x: f64) -> String {
    format!("{} ms", if x < 10.0 { fmt::fixed(x, 2) } else { fmt::fixed(x, 1) })
}

/// load.ts: percentile. The value below which a share `q` of the sorted values lie (nearest rank).
fn percentile(sorted: &[f64], q: f64) -> f64 {
    let rank = polypack_js::math::ceil(q * sorted.len() as f64) - 1.0;
    let at = polypack_js::math::min(sorted.len() as f64 - 1.0, polypack_js::math::max(0.0, rank));
    sorted[at as usize]
}

/// One answered submission, for `LoadStats::submission`.
#[derive(Clone, Debug)]
pub struct SubmissionLine<'a> {
    pub status: u16,
    pub ms: f64,
    pub verify_ms: Option<f64>,
    /// "N/M/P" (or a space problem's id), or None when the body did not name one.
    pub problem: Option<&'a str>,
}

/// load.ts: LoadStats. One line per POST /api/submit, with its status, its time and its problem
/// (never a name or an address), and one line a minute with the counts by status and the
/// percentiles of verification time, so that production load can be read.
pub struct LoadStats {
    write: Box<dyn Fn(&str) + Send + Sync>,
    /// status -> count, in the order the statuses were first seen.
    statuses: Vec<(u16, f64)>,
    verify: Vec<f64>,
    verify_count: f64,
    verify_total: f64,
    leader_changes: f64,
    streams: f64,
    /// Of the open streams, those that follow every problem, and the keys the others follow.
    streams_all: f64,
    stream_keys: f64,
}

impl LoadStats {
    pub fn new(write: Box<dyn Fn(&str) + Send + Sync>) -> LoadStats {
        LoadStats { write, statuses: Vec::new(), verify: Vec::new(), verify_count: 0.0, verify_total: 0.0, leader_changes: 0.0, streams: 0.0, streams_all: 0.0, stream_keys: 0.0 }
    }

    /// One answered submission.
    pub fn submission(&mut self, s: &SubmissionLine<'_>) {
        let mut line = format!("[submit] {} {} {}", s.status, s.problem.unwrap_or("-"), fmt_ms(s.ms));
        if let Some(v) = s.verify_ms {
            line.push_str(&format!(", verification {}", fmt_ms(v)));
        }
        (self.write)(&line);
        match self.statuses.iter_mut().find(|(status, _)| *status == s.status) {
            Some(slot) => slot.1 += 1.0,
            None => self.statuses.push((s.status, 1.0)),
        }
        if let Some(v) = s.verify_ms {
            self.verify_count += 1.0;
            self.verify_total += v;
            if self.verify.len() < MAX_SAMPLES {
                self.verify.push(v);
            }
        }
    }

    /// A problem got a new leader.
    pub fn leader_changed(&mut self) {
        self.leader_changes += 1.0;
    }

    /// A live-update stream opened (+1) or closed (-1); `keys` is how many keys it follows, None
    /// for every problem.
    pub fn stream(&mut self, change: f64, keys: Option<usize>) {
        self.streams += change;
        match keys {
            Some(n) => self.stream_keys += change * n as f64,
            None => self.streams_all += change,
        }
    }

    /// The open streams, as the minute's line gives them.
    fn streams_text(&self) -> String {
        let n = self.streams;
        let mut text = format!("{} live stream{}", fmt::num(n), if n == 1.0 { "" } else { "s" });
        if n != 0.0 {
            text.push_str(&format!(" ({} following every problem, the others {} keys)", fmt::num(self.streams_all), fmt::num(self.stream_keys)));
        }
        text
    }

    /// The minute's line, then the counts start again. Nothing is written for a minute without
    /// submissions while no live-update stream is open. `delay_ms` is the longest delay of the
    /// minute.
    pub fn flush(&mut self, delay_ms: f64) {
        let count: f64 = self.statuses.iter().map(|(_, n)| n).sum();
        if count != 0.0 || self.streams != 0.0 {
            let mut by: Vec<(u16, f64)> = self.statuses.clone();
            by.sort_by_key(|(status, _)| *status);
            let by_status: Vec<String> = by.iter().map(|(status, n)| format!("{status}: {}", fmt::num(*n))).collect();
            self.verify.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let sorted = &self.verify;
            let times = if sorted.is_empty() {
                "no verification".to_string()
            } else {
                format!(
                    "verification p50 {}, p90 {}, p99 {}, max {}, {} in all over {} boards",
                    fmt_ms(percentile(sorted, 0.5)),
                    fmt_ms(percentile(sorted, 0.9)),
                    fmt_ms(percentile(sorted, 0.99)),
                    fmt_ms(sorted[sorted.len() - 1]),
                    fmt_ms(self.verify_total),
                    fmt::num(self.verify_count)
                )
            };
            (self.write)(&format!(
                "[load] last minute: {} submission{}{}; {times}; {} leader change{}; {}; event loop delay up to {}",
                fmt::num(count),
                if count == 1.0 { "" } else { "s" },
                if count != 0.0 { format!(" ({})", by_status.join(", ")) } else { String::new() },
                fmt::num(self.leader_changes),
                if self.leader_changes == 1.0 { "" } else { "s" },
                self.streams_text(),
                fmt_ms(delay_ms)
            ));
        }
        self.statuses.clear();
        self.verify = Vec::new();
        self.verify_count = 0.0;
        self.verify_total = 0.0;
        self.leader_changes = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn stats() -> (LoadStats, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        (LoadStats::new(Box::new(move |l| sink.lock().unwrap().push(l.to_string()))), lines)
    }

    // apps/server/test/load.test.ts: "writes a line per submission and a line a minute"
    #[test]
    fn a_line_per_submission_and_a_line_a_minute() {
        let (mut s, lines) = stats();
        s.submission(&SubmissionLine { status: 200, ms: 1.234, verify_ms: Some(0.5), problem: Some("4/4/11") });
        s.submission(&SubmissionLine { status: 422, ms: 12.34, verify_ms: Some(10.0), problem: Some("4/4/11") });
        s.submission(&SubmissionLine { status: 400, ms: 0.1, verify_ms: None, problem: None });
        s.submission(&SubmissionLine { status: 200, ms: 3.0, verify_ms: Some(2.0), problem: Some("3/3/5") });
        s.leader_changed();
        s.stream(1.0, None);
        s.stream(1.0, Some(3));
        s.flush(42.0);
        s.flush(0.0);
        s.stream(-1.0, None);
        s.stream(-1.0, Some(3));
        s.flush(0.0);
        let lines = lines.lock().unwrap();
        assert_eq!(
            *lines,
            vec![
                "[submit] 200 4/4/11 1.23 ms, verification 0.50 ms",
                "[submit] 422 4/4/11 12.3 ms, verification 10.0 ms",
                "[submit] 400 - 0.10 ms",
                "[submit] 200 3/3/5 3.00 ms, verification 2.00 ms",
                "[load] last minute: 4 submissions (200: 2, 400: 1, 422: 1); verification p50 2.00 ms, p90 10.0 ms, p99 10.0 ms, max 10.0 ms, 12.5 ms in all over 3 boards; 1 leader change; 2 live streams (1 following every problem, the others 3 keys); event loop delay up to 42.0 ms",
                "[load] last minute: 0 submissions; no verification; 0 leader changes; 2 live streams (1 following every problem, the others 3 keys); event loop delay up to 0.00 ms",
            ]
        );
    }

    #[test]
    fn percentiles_are_nearest_rank() {
        let v: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&v, 0.5), 50.0);
        assert_eq!(percentile(&v, 0.9), 90.0);
        assert_eq!(percentile(&v, 0.99), 99.0);
        assert_eq!(percentile(&[7.0], 0.5), 7.0);
    }
}
