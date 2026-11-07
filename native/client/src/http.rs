//! The client's side of the PolyPack HTTP API (apps/volunteer/src/http.ts).
//!
//! - Every request has a 30 s timeout and an answer of at most 16 MB.
//! - A 429 is retried after a 65 s wait, at most three times.
//! - A GET is also retried after network failures, timeouts and 5xx answers, with exponential
//!   backoff (2 s doubling to 60 s), and gives up after 10 failed attempts.
//! - A POST is never sent again blindly: after a failure the server may have stored it. `submit`
//!   reads the problem first and sends again only when the packing is not there (at most three
//!   POSTs in all).
//! - Submissions are paced at the server's limit per address, 120 a minute, over a sliding window
//!   one second longer than the server's.

use serde_json::Value;
use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const RATE_LIMIT_WAIT_MS: u64 = 65_000;
pub const RATE_LIMIT_RETRIES: u32 = 3;
pub const MAX_BACKOFF_MS: u64 = 60_000;
pub const SUBMISSIONS_PER_MINUTE: usize = 120;
pub const SUBMISSION_WINDOW_MS: u64 = 61_000;
pub const MAX_ANSWER_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_SUBMIT_ATTEMPTS: u32 = 3;
pub const MAX_FAILURES: u32 = 10;
pub const TIMEOUT_S: u64 = 30;

#[derive(Clone, Debug)]
pub struct Answer {
    pub status: u16,
    /// The parsed JSON, or the text as a JSON string when it is not JSON.
    pub body: Value,
}

/// One request's result: an answer below 500, or a failure and whether the request went out.
enum Attempt {
    Answer(Answer),
    Failed { why: String, sent: bool },
}

/// Sleeps `ms`, waking early (false) when `stop` is set.
pub fn sleep_unless(stop: &AtomicBool, ms: u64) -> bool {
    let end = Instant::now() + Duration::from_millis(ms);
    loop {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        let now = Instant::now();
        if now >= end {
            return true;
        }
        std::thread::sleep((end - now).min(Duration::from_millis(100)));
    }
}

/// Keeps submissions at or below `limit` per window, sliding; `block` holds every submission back.
pub struct Pacer {
    sent: VecDeque<Instant>,
    blocked_until: Option<Instant>,
    limit: usize,
    window: Duration,
}

impl Pacer {
    pub fn new(limit: usize, window_ms: u64) -> Self {
        Pacer { sent: VecDeque::new(), blocked_until: None, limit, window: Duration::from_millis(window_ms) }
    }

    /// Milliseconds to wait before the next submission may go.
    pub fn delay(&mut self, now: Instant) -> u64 {
        while let Some(&t) = self.sent.front() {
            if t + self.window <= now {
                self.sent.pop_front();
            } else {
                break;
            }
        }
        let mut d = self.blocked_until.map_or(0, |b| b.saturating_duration_since(now).as_millis() as u64);
        if self.sent.len() >= self.limit {
            let t = self.sent[self.sent.len() - self.limit];
            d = d.max((t + self.window).saturating_duration_since(now).as_millis() as u64);
        }
        d
    }

    pub fn block(&mut self, ms: u64) {
        let until = Instant::now() + Duration::from_millis(ms);
        self.blocked_until = Some(self.blocked_until.map_or(until, |b| b.max(until)));
    }
}

/// How one submission went.
#[derive(Clone, Debug)]
pub struct SubmitOutcome {
    pub answer: Option<Answer>,
    /// POST requests actually made.
    pub requests: u32,
    pub without_software: bool,
    pub failure: Option<String>,
    pub check: Option<SubmitCheck>,
}

/// What a re-read of the problem says after a POST without a clear answer: "ours" (stored as the
/// leader under our name and score), "beaten" (another leader is at least as good), "closed", or
/// "absent" (not stored; sending again may still lead).
#[derive(Clone, Debug, PartialEq)]
pub enum SubmitCheck {
    Ours { id: i64, score: f64 },
    Beaten { leader: f64 },
    Closed,
    Absent,
}

pub const SOFTWARE_REFUSAL: &str = "software needs found_with \"external\"";

pub fn is_software_refusal(status: u16, body: &Value) -> bool {
    status == 400 && body.get("reasons").and_then(|r| r.as_array()).map_or(false, |r| r.iter().any(|x| x.as_str() == Some(SOFTWARE_REFUSAL)))
}

pub struct Api {
    pub base: String,
    agent: ureq::Agent,
    pacer: Arc<Mutex<Pacer>>,
    /// Set to stop: no new request starts and every wait ends.
    stop: Arc<AtomicBool>,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    upgrade: Arc<Mutex<Option<String>>>,
    on_upgrade: Arc<dyn Fn(&str) + Send + Sync>,
}

impl Clone for Api {
    fn clone(&self) -> Self {
        Api {
            base: self.base.clone(),
            agent: self.agent.clone(),
            pacer: self.pacer.clone(),
            stop: self.stop.clone(),
            log: self.log.clone(),
            upgrade: self.upgrade.clone(),
            on_upgrade: self.on_upgrade.clone(),
        }
    }
}

impl Api {
    pub fn new(
        base: &str,
        user_agent: &str,
        stop: Arc<AtomicBool>,
        pacer: Arc<Mutex<Pacer>>,
        log: Arc<dyn Fn(&str) + Send + Sync>,
        on_upgrade: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(TIMEOUT_S)).user_agent(user_agent).build();
        Api { base: base.trim_end_matches('/').to_string(), agent, pacer, stop, log, upgrade: Arc::new(Mutex::new(None)), on_upgrade }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn read_body(resp: ureq::Response) -> Result<String, String> {
        if let Some(len) = resp.header("content-length").and_then(|v| v.parse::<u64>().ok()) {
            if len > MAX_ANSWER_BYTES {
                return Err("the answer is larger than 16 MB".into());
            }
        }
        let mut buf = Vec::new();
        resp.into_reader().take(MAX_ANSWER_BYTES + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if buf.len() as u64 > MAX_ANSWER_BYTES {
            return Err("the answer is larger than 16 MB".into());
        }
        Ok(String::from_utf8_lossy(&buf).to_string())
    }

    /// One request, never retried here.
    fn attempt(&self, method: &str, path: &str, body: Option<&Value>) -> Attempt {
        if self.stopped() {
            return Attempt::Failed { why: "the client is stopping".into(), sent: false };
        }
        let url = format!("{}{}", self.base, path);
        let req = if method == "GET" { self.agent.get(&url) } else { self.agent.post(&url) };
        let req = req.set("accept", "application/json");
        let result = match body {
            Some(b) => req.set("content-type", "application/json").send_string(&b.to_string()),
            None => req.call(),
        };
        let resp = match result {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(ureq::Error::Transport(t)) => {
                return Attempt::Failed { why: format!("{method} {path} failed: {t}"), sent: true };
            }
        };
        let status = resp.status();
        let text = match Self::read_body(resp) {
            Ok(t) => t,
            Err(e) => return Attempt::Failed { why: format!("{method} {path} failed: {e}"), sent: true },
        };
        if status >= 500 {
            return Attempt::Failed { why: format!("HTTP {status} from {method} {path}"), sent: true };
        }
        let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
        if status == 426 {
            let mut up = self.upgrade.lock().unwrap();
            if up.is_none() {
                let said = parsed.get("error").and_then(|e| e.as_str()).unwrap_or("the server requires a newer client").to_string();
                *up = Some(said.clone());
                drop(up);
                (self.on_upgrade)(&said);
            }
        }
        Attempt::Answer(Answer { status, body: parsed })
    }

    /// A GET, retried as described above. The answer (any status below 500, or the 429 that
    /// remains after three waits), or None when every attempt failed or the client is stopping.
    pub fn get(&self, path: &str) -> Option<Answer> {
        let mut failures = 0u32;
        let mut limited = 0u32;
        loop {
            if self.stopped() {
                return None;
            }
            match self.attempt("GET", path, None) {
                Attempt::Answer(a) => {
                    if a.status != 429 || limited >= RATE_LIMIT_RETRIES {
                        return Some(a);
                    }
                    limited += 1;
                    (self.log)(&format!("HTTP 429 (rate limit) from GET {path}: waiting 65 s (retry {limited} of {RATE_LIMIT_RETRIES})"));
                    if !sleep_unless(&self.stop, RATE_LIMIT_WAIT_MS) {
                        return None;
                    }
                }
                Attempt::Failed { why, .. } => {
                    if self.stopped() {
                        return None;
                    }
                    failures += 1;
                    if failures >= MAX_FAILURES {
                        (self.log)(&format!("{why}; giving up after {failures} attempts"));
                        return None;
                    }
                    let wait = MAX_BACKOFF_MS.min(2000 * 2u64.pow(failures - 1));
                    (self.log)(&format!("{why}; retrying in {} s", wait / 1000));
                    if !sleep_unless(&self.stop, wait) {
                        return None;
                    }
                }
            }
        }
    }

    /// Waits for the pacer; false when the client stops first.
    fn acquire(&self) -> bool {
        loop {
            let d = {
                let mut p = self.pacer.lock().unwrap();
                let now = Instant::now();
                let d = p.delay(now);
                if d == 0 {
                    p.sent.push_back(now);
                }
                d
            };
            if d == 0 {
                return true;
            }
            if !sleep_unless(&self.stop, d) {
                return false;
            }
        }
    }

    /// One POST through the pacer. A 429 means nothing was stored: it is sent again after 65 s,
    /// at most three times, and every submission waits with it.
    fn post(&self, path: &str, body: &Value) -> (Option<Answer>, Option<String>, u32) {
        let mut limited = 0;
        let mut requests = 0;
        loop {
            if !self.acquire() {
                return (None, Some("the client is stopping".into()), requests);
            }
            match self.attempt("POST", path, Some(body)) {
                Attempt::Failed { why, sent } => return (None, Some(why), requests + if sent { 1 } else { 0 }),
                Attempt::Answer(a) => {
                    requests += 1;
                    if a.status != 429 || limited >= RATE_LIMIT_RETRIES {
                        return (Some(a), None, requests);
                    }
                    limited += 1;
                    (self.log)(&format!("HTTP 429 (rate limit) from POST {path}: waiting 65 s (retry {limited} of {RATE_LIMIT_RETRIES})"));
                    self.pacer.lock().unwrap().block(RATE_LIMIT_WAIT_MS);
                }
            }
        }
    }

    pub fn problem(&self, n: u32, m: u32, p: usize) -> Option<Answer> {
        self.get(&format!("/api/problems/{n}/{m}/{p}"))
    }

    pub fn entry(&self, id: i64) -> Option<Answer> {
        self.get(&format!("/api/submissions/{id}"))
    }

    /// POST /api/submit. A server that refuses `software` with found_with "optimizer" (exactly that
    /// 400) gets the body once more without it. After a POST without an answer, `check` reads the
    /// problem, and the POST is sent again, after a backoff, only when the packing is not there.
    pub fn submit(&self, body: &Value, check: &dyn Fn() -> Option<SubmitCheck>) -> SubmitOutcome {
        let mut current = body.clone();
        let mut without_software = false;
        let mut requests = 0;
        let mut checked: Option<SubmitCheck> = None;
        let mut attempt = 1;
        loop {
            let (answer, failure, made) = self.post("/api/submit", &current);
            requests += made;
            if let Some(a) = answer {
                if without_software || current.get("software").is_none() || !is_software_refusal(a.status, &a.body) {
                    return SubmitOutcome { answer: Some(a), requests, without_software, failure: None, check: None };
                }
                (self.log)("the server does not take \"software\" with optimizer entries yet: sending again without it");
                if let Some(o) = current.as_object_mut() {
                    o.remove("software");
                }
                without_software = true;
                continue;
            }
            let outcome = |checked: Option<SubmitCheck>| SubmitOutcome { answer: None, requests, without_software, failure: failure.clone(), check: checked };
            // nothing went out, or the client is stopping and can no longer read the problem
            if made == 0 || self.stopped() {
                return outcome(checked);
            }
            (self.log)(&format!("{}: the server may have stored the packing; reading the problem before sending it again", failure.clone().unwrap_or_default()));
            checked = check();
            if checked != Some(SubmitCheck::Absent) || attempt >= MAX_SUBMIT_ATTEMPTS {
                return outcome(checked);
            }
            attempt += 1;
            let wait = MAX_BACKOFF_MS.min(2000 * 2u64.pow(attempt - 2));
            (self.log)(&format!("It was not stored: sending it again in {} s (attempt {attempt} of {MAX_SUBMIT_ATTEMPTS})", wait / 1000));
            if !sleep_unless(&self.stop, wait) {
                return outcome(checked);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pacer_limits() {
        let mut p = Pacer::new(2, 1000);
        let t = Instant::now();
        assert_eq!(p.delay(t), 0);
        p.sent.push_back(t);
        p.sent.push_back(t);
        assert!(p.delay(t) > 900);
        assert_eq!(p.delay(t + Duration::from_millis(1001)), 0);
    }

    #[test]
    fn software_refusal() {
        let body = serde_json::json!({"reasons": [SOFTWARE_REFUSAL]});
        assert!(is_software_refusal(400, &body));
        assert!(!is_software_refusal(422, &body));
    }
}
