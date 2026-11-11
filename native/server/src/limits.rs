//! Port of apps/server/src/limits.ts: the limits of submissions (a count per address or per submit
//! key, a budget of verification time), the key an address is limited by, the body limit, and the
//! cleaning of names and notes.
//!
//! The source's `readBodyWithin` is `hono::read_body_within` (it is Hono's body-limit), and its
//! `Gate` is a semaphore where it is used (snapshot.rs).

use std::sync::Mutex;

use indexmap::IndexMap;
use unicode_normalization::UnicodeNormalization;

use crate::clock::Clock;
use crate::js;

/// limits.ts: RateLimiter. Fixed-window rate limiter kept in memory. Good for one server process.
#[derive(Debug)]
pub struct RateLimiter {
    /// key -> (count, resetAt), in insertion order as the source's Map.
    hits: IndexMap<String, (f64, f64)>,
    max: f64,
    window_ms: f64,
}

impl RateLimiter {
    pub fn new(max: f64, window_ms: f64) -> RateLimiter {
        RateLimiter { hits: IndexMap::new(), max, window_ms }
    }

    /// Records one hit at the time `t` (`Date.now()`); returns false when the key is over its limit.
    pub fn allow(&mut self, key: &str, t: f64) -> bool {
        if self.hits.len() > 10000 {
            self.hits.retain(|_, v| !(v.1 <= t));
        }
        match self.hits.get_mut(key) {
            Some(h) if !(h.1 <= t) => {
                h.0 += 1.0;
                h.0 <= self.max
            }
            _ => {
                // a key whose window is over keeps its place in the Map
                self.hits.insert(key.to_string(), (1.0, t + self.window_ms));
                true
            }
        }
    }
}

/// limits.ts: TimeBudget. Milliseconds of work each key may cause, refilled continuously at
/// `per_minute` a minute, with at most `per_minute` saved up. Work is charged after it is done, so
/// one long piece of work can take a key below zero; the key then waits until its balance is
/// positive again.
#[derive(Debug)]
pub struct TimeBudget {
    /// key -> (ms, at)
    balances: IndexMap<String, (f64, f64)>,
    per_minute: f64,
}

impl TimeBudget {
    pub fn new(per_minute: f64) -> TimeBudget {
        TimeBudget { balances: IndexMap::new(), per_minute }
    }

    fn balance(&self, key: &str, t: f64) -> f64 {
        match self.balances.get(key) {
            Some(b) => polypack_js::math::min(self.per_minute, b.0 + ((t - b.1) * self.per_minute) / 60_000.0),
            None => self.per_minute,
        }
    }

    /// Whole seconds until `key` may start more work; 0 when it may now.
    pub fn wait(&self, key: &str, t: f64) -> f64 {
        let ms = self.balance(key, t);
        if ms > 0.0 {
            0.0
        } else {
            polypack_js::math::max(1.0, polypack_js::math::ceil((-ms * 60.0) / self.per_minute))
        }
    }

    /// Charges `key` for `ms` milliseconds of work.
    pub fn charge(&mut self, key: &str, ms: f64, t: f64) {
        if self.balances.len() > 10000 {
            let full: Vec<String> = self.balances.keys().filter(|k| self.balance(k, t) >= self.per_minute).cloned().collect();
            for k in full {
                self.balances.shift_remove(&k);
            }
        }
        let left = self.balance(key, t) - ms;
        self.balances.insert(key.to_string(), (left, t));
    }
}

/// limits.ts: addressKey. The key an address is limited by: an IPv4 address as it is, an IPv6
/// address by its /64 prefix, since one connection is usually given a whole /64. An IPv4 address
/// written as IPv6 (::ffff:1.2.3.4) counts as IPv4. Anything else is its own key.
pub fn address_key(ip: &str) -> String {
    let mut text = js::trim(ip).to_lowercase();
    // .replace(/^\[(.*)\]$/, "$1")
    if text.len() >= 2 && text.starts_with('[') && text.ends_with(']') && !text.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        text = text[1..text.len() - 1].to_string();
    }
    // .replace(/%.*$/, "")
    if !text.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        if let Some(i) = text.find('%') {
            text.truncate(i);
        }
    }
    if !text.contains(':') {
        return text;
    }
    // /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/
    if let Some(v4) = text.strip_prefix("::ffff:") {
        let parts: Vec<&str> = v4.split('.').collect();
        if parts.len() == 4 && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit())) {
            return v4.to_string();
        }
    }
    let halves: Vec<&str> = text.split("::").collect();
    if halves.len() > 2 {
        return text;
    }
    // an IPv4 address at the end (64:ff9b::1.2.3.4) takes the place of two groups
    let groups = |s: &str| -> Vec<String> {
        if s.is_empty() {
            return Vec::new();
        }
        s.split(':').flat_map(|g| if g.contains('.') { vec!["0".to_string(), "0".to_string()] } else { vec![g.to_string()] }).collect()
    };
    let head = groups(halves[0]);
    let tail = if halves.len() == 2 { groups(halves[1]) } else { Vec::new() };
    let fill: i64 = if halves.len() == 2 { 8 - head.len() as i64 - tail.len() as i64 } else { 0 };
    let mut all = head;
    all.extend(std::iter::repeat_n("0".to_string(), fill.max(0) as usize));
    all.extend(tail);
    let is_group = |g: &String| (1..=4).contains(&g.len()) && g.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if fill < 0 || all.len() != 8 || !all.iter().all(is_group) {
        return text;
    }
    let prefix: Vec<String> = all[..4].iter().map(|g| format!("{:x}", u32::from_str_radix(g, 16).unwrap_or(0))).collect();
    format!("{}::/64", prefix.join(":"))
}

/// limits.ts: MAX_BODY_BYTES.
pub const MAX_BODY_BYTES: usize = 256 * 1024;
/// limits.ts: MAX_NAME_LENGTH.
pub const MAX_NAME_LENGTH: usize = 40;
/// limits.ts: MAX_NOTE_LENGTH.
pub const MAX_NOTE_LENGTH: usize = 200;

/// limits.ts: sanitizeText. Display text from an untrusted string: control characters and angle
/// brackets removed, whitespace collapsed, length capped (in UTF-16 units, as the source counts).
/// The client also only ever inserts names as text.
pub fn sanitize_text(raw: &str, max_length: usize) -> String {
    let mut collapsed = String::with_capacity(raw.len());
    let mut in_space = false;
    for c in raw.nfc() {
        let c = match c {
            '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '<' | '>' => ' ',
            other => other,
        };
        // .replace(/\s+/g, " ")
        if js::is_whitespace(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let cut = js::utf16_prefix(js::trim(&collapsed), max_length);
    js::trim(&cut).to_string()
}

/// limits.ts: SNAPSHOT_FILES_PER_HOUR. Snapshot files (GET /api/snapshot/{file}) one address may
/// fetch an hour. The server generates each one from the database, and the mirror workflow fetches
/// every file of the snapshot, sequentially, from one address: up to 9,801 pairs and the spaces, in
/// well under an hour. This leaves it room to be twice as fast, and stops a client that asks for
/// the files again and again.
pub const SNAPSHOT_FILES_PER_HOUR: f64 = 20_000.0;
/// limits.ts: SUBMISSIONS_PER_MINUTE. Submissions per minute from one address. Cloud batch
/// sessions may share one address.
pub const SUBMISSIONS_PER_MINUTE: f64 = 120.0;
/// limits.ts: VERIFY_MS_PER_MINUTE. Milliseconds of verification (the geometry check of
/// submissions) one address may cause a minute, saved up to a minute's worth.
pub const VERIFY_MS_PER_MINUTE: f64 = 4000.0;
/// limits.ts: SUBMIT_KEY_HEADER. The header that carries the server's submit key (SUBMIT_KEY),
/// which the operator gives to a submitter who needs more than an address's limits.
pub const SUBMIT_KEY_HEADER: &str = "x-submit-key";
/// limits.ts: KEYED_SUBMISSIONS_PER_MINUTE. Submissions per minute with the submit key, all its
/// holders together.
pub const KEYED_SUBMISSIONS_PER_MINUTE: f64 = 600.0;
/// limits.ts: KEYED_VERIFY_MS_PER_MINUTE. Verification a minute with the submit key: the address's
/// budget in the same ratio as the count (20 s).
pub const KEYED_VERIFY_MS_PER_MINUTE: f64 = (VERIFY_MS_PER_MINUTE * KEYED_SUBMISSIONS_PER_MINUTE) / SUBMISSIONS_PER_MINUTE;
/// limits.ts: MIN_SUBMIT_KEY_LENGTH. A shorter SUBMIT_KEY is not used: a key is a secret that a
/// guess must not find.
pub const MIN_SUBMIT_KEY_LENGTH: usize = 32;
/// limits.ts: OVERLOAD_DELAY_MS. The delay (ms) above which new submissions are answered 503 with
/// Retry-After. In the source it is the delay of the event loop; here, how long a verification
/// waits for a free worker (pool.rs).
pub const OVERLOAD_DELAY_MS: f64 = 250.0;
/// limits.ts: OVERLOAD_RETRY_S. Retry-After (s) of the answer to a submission refused while the
/// server is overloaded.
pub const OVERLOAD_RETRY_S: f64 = 5.0;
/// limits.ts: MAX_REPORTED_OVERLAPS. Overlapping pairs the server looks for before rejecting.
/// Finding every pair of a heavily overlapping 500-piece configuration takes up to seconds; the
/// first few are found at once.
pub const MAX_REPORTED_OVERLAPS: usize = 20;

/// Which of the two sets of limits a submission counts against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Counted {
    Address,
    Key,
}

/// limits.ts: Submitter. The limits one submission counts against.
#[derive(Clone, Debug, PartialEq)]
pub struct Submitter {
    /// What its count and its verification are kept under: the address, or the submit key.
    pub key: String,
    pub counted: Counted,
    /// For the reasons of a refusal: "from this address" or "with this submit key".
    pub from: &'static str,
}

#[derive(Debug)]
struct Limiters {
    address: RateLimiter,
    address_budget: TimeBudget,
    keyed: RateLimiter,
    keyed_budget: TimeBudget,
}

/// The numbers of `SubmitLimits`.
#[derive(Clone, Copy, Debug)]
pub struct SubmitLimitValues {
    pub per_ip: f64,
    pub window_ms: f64,
    pub verify_ms_per_minute: f64,
    pub per_key: f64,
    pub key_verify_ms_per_minute: f64,
}

/// limits.ts: SubmitLimits. Chooses the limits of a submission: the submit key's when it carries
/// the server's key, its address's when it carries none, and none (None: the caller answers 401)
/// when it carries a key that is not the server's. A wrong key still counts against the address,
/// so that guessing keys is held to the address's limit.
///
/// Both submit routes share one of these. The limiters sit behind a lock of their own, which is
/// never held together with another.
#[derive(Debug)]
pub struct SubmitLimits {
    submit_key: Option<String>,
    limiters: Mutex<Limiters>,
    clock: Clock,
}

impl SubmitLimits {
    pub fn new(submit_key: Option<String>, limits: SubmitLimitValues, clock: Clock) -> SubmitLimits {
        SubmitLimits {
            submit_key,
            limiters: Mutex::new(Limiters {
                address: RateLimiter::new(limits.per_ip, limits.window_ms),
                address_budget: TimeBudget::new(limits.verify_ms_per_minute),
                keyed: RateLimiter::new(limits.per_key, limits.window_ms),
                keyed_budget: TimeBudget::new(limits.key_verify_ms_per_minute),
            }),
            clock,
        }
    }

    /// SubmitLimits.of.
    pub fn of(&self, address: &str, given_key: Option<&str>) -> Option<Submitter> {
        let Some(given) = given_key else {
            return Some(Submitter { key: address.to_string(), counted: Counted::Address, from: "from this address" });
        };
        match &self.submit_key {
            Some(key) if !key.is_empty() && constant_time_equal(given, key) => {
                Some(Submitter { key: "submit-key".to_string(), counted: Counted::Key, from: "with this submit key" })
            }
            _ => {
                let t = self.clock.date_now();
                self.limiters.lock().unwrap().address.allow(address, t);
                None
            }
        }
    }

    /// `submitter.count.allow(submitter.key)`.
    pub fn count_allow(&self, s: &Submitter) -> bool {
        let t = self.clock.date_now();
        let mut l = self.limiters.lock().unwrap();
        match s.counted {
            Counted::Address => l.address.allow(&s.key, t),
            Counted::Key => l.keyed.allow(&s.key, t),
        }
    }

    /// `submitter.budget.wait(submitter.key)`.
    pub fn budget_wait(&self, s: &Submitter) -> f64 {
        let t = self.clock.date_now();
        let l = self.limiters.lock().unwrap();
        match s.counted {
            Counted::Address => l.address_budget.wait(&s.key, t),
            Counted::Key => l.keyed_budget.wait(&s.key, t),
        }
    }

    /// `submitter.budget.charge(submitter.key, ms)`.
    pub fn budget_charge(&self, s: &Submitter, ms: f64) {
        let t = self.clock.date_now();
        let mut l = self.limiters.lock().unwrap();
        match s.counted {
            Counted::Address => l.address_budget.charge(&s.key, ms, t),
            Counted::Key => l.keyed_budget.charge(&s.key, ms, t),
        }
    }
}

/// limits.ts: constantTimeEqual. String equality whose time does not depend on where the strings
/// first differ (over UTF-16 units, as the source).
pub fn constant_time_equal(a: &str, b: &str) -> bool {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u16;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_keys() {
        for (a, key) in [
            ("1.2.3.4", "1.2.3.4"),
            (" 7.7.7.7", "7.7.7.7"),
            ("2001:db8:1:2::1", "2001:db8:1:2::/64"),
            ("2001:DB8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"),
            ("::ffff:9.9.9.9", "9.9.9.9"),
            ("[2001:db8:5:6::1]", "2001:db8:5:6::/64"),
            ("fe80::1%eth0", "fe80:0:0:0::/64"),
            ("fe80:0:0:0:9::", "fe80:0:0:0::/64"),
            ("64:ff9b::1.2.3.4", "64:ff9b:0:0::/64"),
            ("64:ff9b:0:0:0:0:5.6.7.8", "64:ff9b:0:0::/64"),
            ("::1", "0:0:0:0::/64"),
            ("::", "0:0:0:0::/64"),
            ("2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8:0:0::/64"),
            ("1::2::3", "1::2::3"),
            ("gggg::1", "gggg::1"),
            ("GGGG::1", "gggg::1"),
            ("1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8:9"),
            ("not an address", "not an address"),
            ("1:2:3:4:5:6:7::", "1:2:3:4::/64"),
            ("1:2:3:4::", "1:2:3:4::/64"),
            ("12345::1", "12345::1"),
            ("1:2:3", "1:2:3"),
            ("::ffff:999.1.1.1", "999.1.1.1"),
            ("1.2.3.4.5", "1.2.3.4.5"),
            ("", ""),
            ("unknown", "unknown"),
        ] {
            assert_eq!(address_key(a), key, "{a}");
        }
    }

    #[test]
    fn text_is_cleaned() {
        assert_eq!(sanitize_text("  <b>Ann</b>\tof\n\nGreen   Gables\u{7} ", 40), "b Ann /b of Green Gables");
        assert_eq!(sanitize_text("\u{0}\u{1}", 40), "");
        assert_eq!(sanitize_text("<>", 40), "");
        assert_eq!(sanitize_text("\u{200b}\u{200e}", 40), "");
        assert_eq!(sanitize_text(&("n".repeat(39) + "😀"), 40), "n".repeat(39) + "\u{fffd}");
        assert_eq!(sanitize_text(&("a".repeat(38) + "   " + &"b".repeat(10)), 40), "a".repeat(38) + " b");
        assert_eq!(sanitize_text(&("a".repeat(39) + "   " + &"b".repeat(10)), 40), "a".repeat(39));
        assert_eq!(sanitize_text("e\u{301}cole", 40), "\u{e9}cole");
        assert_eq!(sanitize_text(" nbsp\u{a0}\u{3000}ideographic em\u{feff} bom", 40), "nbsp ideographic em bom");
    }

    #[test]
    fn rate_limiter_counts_per_window() {
        let mut r = RateLimiter::new(2.0, 1000.0);
        assert!(r.allow("a", 0.0));
        assert!(r.allow("a", 1.0));
        assert!(!r.allow("a", 2.0));
        assert!(r.allow("b", 2.0));
        assert!(!r.allow("a", 999.0));
        assert!(r.allow("a", 1000.0));
    }

    #[test]
    fn time_budget_refills() {
        let mut b = TimeBudget::new(4000.0);
        assert_eq!(b.wait("a", 0.0), 0.0);
        b.charge("a", 5000.0, 0.0);
        assert_eq!(b.wait("a", 0.0), 15.0);
        assert_eq!(b.wait("a", 15_000.0), 1.0);
        assert_eq!(b.wait("a", 15_001.0), 0.0);
        b.charge("a", 1.0, 120_000.0);
        assert_eq!(b.wait("a", 120_000.0), 0.0);
    }

    #[test]
    fn keys_are_compared_whole() {
        assert!(constant_time_equal("abc", "abc"));
        assert!(!constant_time_equal("abc", "abd"));
        assert!(!constant_time_equal("abc", "abcd"));
        assert!(constant_time_equal("", ""));
    }
}
