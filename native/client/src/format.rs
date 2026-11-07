//! Formatting for the output: durations, timestamps, scores.

use std::time::{SystemTime, UNIX_EPOCH};

/// "1h02m", "4m05s", "12s".
pub fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() {
        return "?".into();
    }
    let s = seconds.max(0.0).round() as u64;
    let (h, m, r) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 {
        format!("{h}h{m:02}m")
    } else if m > 0 {
        format!("{m}m{r:02}s")
    } else {
        format!("{r}s")
    }
}

/// Scores are shown with six decimals; storage keeps full precision.
pub fn format_score(score: f64) -> String {
    format!("{score:.6}")
}

/// How far `score` is from `reference`, in percent (negative: smaller, better).
pub fn relative_percent(score: f64, reference: f64) -> String {
    let pct = (score / reference - 1.0) * 100.0;
    if pct == 0.0 {
        return "0%".into();
    }
    let text = if pct.abs() >= 0.001 { format!("{:.3}", pct.abs()) } else { format!("{:.2e}", pct.abs()) };
    format!("{}{}%", if pct > 0.0 { "+" } else { "-" }, text)
}

/// Civil date (y, m, d) of a day count since 1970-01-01 (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn parts(secs: i64) -> (i64, u32, u32, i64, i64, i64) {
    let (y, mo, d) = civil(secs.div_euclid(86400));
    let t = secs.rem_euclid(86400);
    (y, mo, d, t / 3600, (t % 3600) / 60, t % 60)
}

/// UTC time as ISO 8601 with milliseconds, like JavaScript's toISOString.
pub fn iso_now() -> String {
    iso_of_ms(now_ms())
}

/// A time in milliseconds since the epoch as ISO 8601 with milliseconds, UTC.
pub fn iso_of_ms(ms: i64) -> String {
    let (y, mo, d, h, mi, s) = parts(ms.div_euclid(1000));
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{:03}Z", ms.rem_euclid(1000))
}

/// Milliseconds since the epoch of an ISO 8601 UTC time as iso_now writes it; None otherwise.
pub fn parse_iso(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let num = |a: usize, z: usize| text.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let ms = if b.get(19) == Some(&b'.') { num(20, 23).unwrap_or(0) } else { 0 };
    // days from civil (inverse of `civil`)
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + s) * 1000) + ms)
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Local time as "2026-10-21 21:43:06" (UTC where the local offset is not known).
pub fn timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    #[cfg(unix)]
    {
        let t: libc::time_t = now as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: localtime_r fills the tm it is given from the time it reads.
        if !unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
            return format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
        }
    }
    let (y, mo, d, h, mi, s) = parts(now);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(format_duration(3725.0), "1h02m");
        assert_eq!(format_duration(245.0), "4m05s");
        assert_eq!(format_duration(12.4), "12s");
        assert_eq!(relative_percent(0.99, 1.0), "-1.000%");
        let iso = iso_now();
        let ms = parse_iso(&iso).unwrap();
        assert!((ms - now_ms()).abs() < 5000);
        assert_eq!(parse_iso("1970-01-02T00:00:01.500Z"), Some(86_401_500));
        assert_eq!(iso_of_ms(86_401_500), "1970-01-02T00:00:01.500Z");
    }
}
