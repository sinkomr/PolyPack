//! The budget of one search: evaluations, this thread's CPU time, a wall deadline and a stop flag.

use polypack_flat::clock::thread_cpu_seconds;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

pub struct Budget<'a> {
    pub max_evals: u64,
    /// Thread CPU time (absolute, `thread_cpu_seconds`) at which the search ends.
    pub cpu_end: f64,
    pub t0: f64,
    pub deadline: Option<Instant>,
    pub stop: Option<&'a AtomicBool>,
    pub done: bool,
    /// Why it ended: "cpu", "deadline", "stop", "evals" or "bound".
    pub reason: &'static str,
    next_poll: u64,
    interval: u64,
    last_cpu: f64,
}

impl<'a> Budget<'a> {
    pub fn new(seconds: f64, max_evals: Option<u64>, deadline: Option<Instant>, stop: Option<&'a AtomicBool>) -> Budget<'a> {
        let t0 = thread_cpu_seconds();
        Budget {
            max_evals: max_evals.unwrap_or(u64::MAX),
            cpu_end: t0 + seconds,
            t0,
            deadline,
            stop,
            done: false,
            reason: "",
            next_poll: 0,
            interval: 8,
            last_cpu: t0,
        }
    }

    /// CPU seconds since the start.
    pub fn elapsed(&self) -> f64 {
        thread_cpu_seconds() - self.t0
    }

    fn finish(&mut self, why: &'static str) -> bool {
        if !self.done {
            self.done = true;
            self.reason = why;
        }
        true
    }

    /// Checks the evaluation budget every time and the clocks every few milliseconds of work (the interval
    /// between clock reads adapts to the cost of an evaluation). Only the stop decision reads the clock, so runs
    /// with an evaluation budget repeat exactly.
    #[inline]
    pub fn poll(&mut self, evals: u64) -> bool {
        if self.done {
            return true;
        }
        if evals >= self.max_evals {
            return self.finish("evals");
        }
        if evals >= self.next_poll {
            return self.check_clocks(evals);
        }
        false
    }

    /// Reads the clocks now.
    pub fn check_clocks(&mut self, evals: u64) -> bool {
        if self.done {
            return true;
        }
        let now = thread_cpu_seconds();
        let dt = now - self.last_cpu;
        self.last_cpu = now;
        if dt < 0.5e-3 && self.interval < 4096 {
            self.interval *= 2;
        } else if dt > 3e-3 && self.interval > 1 {
            self.interval /= 2;
        }
        self.next_poll = evals + self.interval;
        if now >= self.cpu_end {
            return self.finish("cpu");
        }
        if let Some(s) = self.stop {
            if s.load(Ordering::Relaxed) {
                return self.finish("stop");
            }
        }
        if let Some(d) = self.deadline {
            if Instant::now() >= d {
                return self.finish("deadline");
            }
        }
        false
    }
}
