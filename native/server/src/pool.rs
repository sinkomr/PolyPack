//! The workers that verify submissions.
//!
//! The source verifies a submission on the one thread that also answers every request, and
//! measures how late that thread runs (load.ts: LoopDelay) to refuse submissions when it cannot
//! keep up. Here verification runs on a pool of threads, one per core, beside the threads that
//! answer requests, so that several submissions are verified at once. The measure that takes the
//! place of the event-loop delay is how long a job waits for a free worker: zero while a worker is
//! idle, and growing when submissions arrive faster than the cores verify them. It is kept over
//! the same windows as LoopDelay keeps its delay (see `Delay`), and read by the same callers.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex};

use crate::clock::Clock;

type Job = Box<dyn FnOnce() + Send + 'static>;

/// load.ts: LoopDelay, without its timer: the longest wait of the current window and of the one
/// before it, and the longest since `take_peak`.
#[derive(Debug)]
struct Delay {
    window_ms: f64,
    current: f64,
    previous: f64,
    window_end: f64,
    peak: f64,
}

impl Delay {
    /// LoopDelay.tick, up to its measurement: a window that has ended is closed. The source closes
    /// it at the first tick after its end, 20 ms apart; here it is closed when the delay is next
    /// noted or read, which gives the same windows.
    fn roll(&mut self, t: f64) {
        if t >= self.window_end {
            // a window without a reading leaves nothing to carry over
            self.previous = if t >= self.window_end + self.window_ms { 0.0 } else { self.current };
            self.current = 0.0;
            self.window_end = t + self.window_ms;
        }
    }

    fn note(&mut self, t: f64, late: f64) {
        self.roll(t);
        let late = late.max(0.0);
        self.current = self.current.max(late);
        self.peak = self.peak.max(late);
    }
}

struct Queue {
    jobs: VecDeque<(f64, Job)>,
    delay: Delay,
    closed: bool,
}

struct Shared {
    queue: Mutex<Queue>,
    ready: Condvar,
    clock: Clock,
}

/// A pool of worker threads for CPU work (the verification of submissions).
#[derive(Clone)]
pub struct Pool {
    shared: Arc<Shared>,
    threads: usize,
}

impl Pool {
    /// `threads` workers; 0 means one per core of the machine.
    pub fn new(threads: usize, clock: Clock) -> Pool {
        let threads = if threads == 0 { std::thread::available_parallelism().map_or(1, |n| n.get()) } else { threads };
        let t = clock.performance_now();
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue {
                jobs: VecDeque::new(),
                delay: Delay { window_ms: 1000.0, current: 0.0, previous: 0.0, window_end: t + 1000.0, peak: 0.0 },
                closed: false,
            }),
            ready: Condvar::new(),
            clock,
        });
        for k in 0..threads {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name(format!("verify-{k}"))
                .spawn(move || worker(&shared))
                .expect("a worker thread can be started");
        }
        Pool { shared, threads }
    }

    pub fn threads(&self) -> usize {
        self.threads
    }

    /// Runs `job` on a worker and gives its result; `Err` when the job panicked.
    pub async fn run<T: Send + 'static>(&self, job: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let boxed: Job = Box::new(move || {
            let result = catch_unwind(AssertUnwindSafe(job)).map_err(|e| {
                e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_else(|| "a worker failed".to_string())
            });
            let _ = tx.send(result);
        });
        {
            let mut q = self.shared.queue.lock().unwrap();
            q.jobs.push_back((self.shared.clock.performance_now(), boxed));
        }
        self.shared.ready.notify_one();
        rx.await.unwrap_or_else(|_| Err("the worker pool has stopped".to_string()))
    }

    /// LoopDelay.ms: the longest wait of about the last one to two seconds, in milliseconds. A job
    /// that is waiting now counts already with the time it has waited.
    pub fn delay_ms(&self) -> f64 {
        let t = self.shared.clock.performance_now();
        let mut q = self.shared.queue.lock().unwrap();
        q.delay.roll(t);
        let waiting = q.jobs.front().map_or(0.0, |(since, _)| t - since);
        q.delay.current.max(q.delay.previous).max(waiting)
    }

    /// LoopDelay.takePeak: the longest wait since the last call, in milliseconds.
    pub fn take_peak(&self) -> f64 {
        let t = self.shared.clock.performance_now();
        let mut q = self.shared.queue.lock().unwrap();
        let waiting = q.jobs.front().map_or(0.0, |(since, _)| t - since);
        let p = q.delay.peak.max(waiting);
        q.delay.peak = 0.0;
        p
    }

    /// Lets the workers end once the queue is empty.
    pub fn close(&self) {
        self.shared.queue.lock().unwrap().closed = true;
        self.shared.ready.notify_all();
    }
}

fn worker(shared: &Shared) {
    loop {
        let job = {
            let mut q = shared.queue.lock().unwrap();
            loop {
                if let Some((since, job)) = q.jobs.pop_front() {
                    let t = shared.clock.performance_now();
                    q.delay.note(t, t - since);
                    break job;
                }
                if q.closed {
                    return;
                }
                q = shared.ready.wait(q).unwrap();
            }
        };
        job();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn jobs_run_in_parallel_and_their_wait_is_measured() {
        let pool = Pool::new(2, Clock::new());
        assert_eq!(pool.run(|| 6 * 7).await, Ok(42));
        // two jobs hold both workers; a third waits for one of them
        let slow = || std::thread::sleep(std::time::Duration::from_millis(60));
        let (a, b, c) = tokio::join!(pool.run(slow), pool.run(slow), pool.run(|| 1));
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(c, Ok(1));
        let waited = pool.delay_ms();
        assert!(waited >= 40.0 && waited < 1000.0, "waited {waited} ms");
        assert!(pool.take_peak() >= 40.0);
        assert_eq!(pool.take_peak(), 0.0);
        assert!(pool.run(|| panic!("boom")).await.is_err());
        assert_eq!(pool.run(|| 2).await, Ok(2));
        pool.close();
    }
}
