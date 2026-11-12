//! Clocks for time budgets: the wall clock (minus pauses) for the volunteer client, or the
//! calling thread's CPU time for benchmarks on a loaded machine.

use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClockKind {
    Wall,
    ThreadCpu,
}

/// Seconds of CPU time used by the calling thread (wall time where that is not available).
pub fn thread_cpu_seconds() -> f64 {
    #[cfg(unix)]
    {
        let mut ts = TimeSpec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: clock_gettime writes one timespec into the pointer given.
        let rc = unsafe { clock_gettime(CLOCK_THREAD_CPUTIME_ID, &mut ts) };
        if rc == 0 {
            return ts.tv_sec as f64 + ts.tv_nsec as f64 * 1e-9;
        }
    }
    process_start().elapsed().as_secs_f64()
}

fn process_start() -> &'static Instant {
    use std::sync::OnceLock;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now)
}

#[cfg(unix)]
#[repr(C)]
struct TimeSpec {
    tv_sec: i64,
    tv_nsec: i64,
}

#[cfg(target_os = "macos")]
const CLOCK_THREAD_CPUTIME_ID: i32 = 16;
#[cfg(all(unix, not(target_os = "macos")))]
const CLOCK_THREAD_CPUTIME_ID: i32 = 3;

#[cfg(unix)]
extern "C" {
    fn clock_gettime(clk_id: i32, tp: *mut TimeSpec) -> i32;
}

/// A clock started at creation.
#[derive(Clone, Debug)]
pub struct Clock {
    kind: ClockKind,
    wall0: Instant,
    cpu0: f64,
}

impl Clock {
    pub fn new(kind: ClockKind) -> Self {
        Clock { kind, wall0: Instant::now(), cpu0: if kind == ClockKind::ThreadCpu { thread_cpu_seconds() } else { 0.0 } }
    }

    /// Seconds since the clock was made.
    #[inline]
    pub fn seconds(&self) -> f64 {
        match self.kind {
            ClockKind::Wall => self.wall0.elapsed().as_secs_f64(),
            ClockKind::ThreadCpu => thread_cpu_seconds() - self.cpu0,
        }
    }

    pub fn kind(&self) -> ClockKind {
        self.kind
    }
}
