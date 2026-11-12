//! The clock of the server. Wherever the source reads the time (`Date.now()`,
//! `new Date().toISOString()`, `performance.now()`), the Rust server reads this one clock, so that
//! a test can set it: the wall clock is the system's plus an offset in milliseconds
//! (native/tools/serverdiff/README.md, "The clock"). Durations and timers run in real time.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::js;

#[derive(Debug)]
struct Inner {
    origin: Instant,
    /// Milliseconds added to the system's wall clock; 0 in production.
    offset_ms: AtomicI64,
}

/// A handle on the server's clock; clones share the offset.
#[derive(Clone, Debug)]
pub struct Clock(Arc<Inner>);

impl Default for Clock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock {
    pub fn new() -> Self {
        Clock(Arc::new(Inner { origin: Instant::now(), offset_ms: AtomicI64::new(0) }))
    }

    /// Sets the test clock's offset from the system clock.
    pub fn set_offset_ms(&self, offset: f64) {
        self.0.offset_ms.store(offset as i64, Ordering::Relaxed);
    }

    /// `Date.now()`: whole milliseconds since 1970-01-01 UTC.
    pub fn date_now(&self) -> f64 {
        let system = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        (system + self.0.offset_ms.load(Ordering::Relaxed)) as f64
    }

    /// `new Date().toISOString()`.
    pub fn iso_now(&self) -> String {
        js::to_iso_string(self.date_now())
    }

    /// `performance.now()`: milliseconds on a clock that only moves forward (never offset).
    pub fn performance_now(&self) -> f64 {
        self.0.origin.elapsed().as_secs_f64() * 1000.0
    }
}

/// The store reads its two clocks through this one.
impl crate::store::Clock for Clock {
    fn performance_now(&self) -> f64 {
        Clock::performance_now(self)
    }
    fn date_now(&self) -> f64 {
        Clock::date_now(self)
    }
}
