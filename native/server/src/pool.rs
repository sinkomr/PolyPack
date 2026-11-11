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

/// The stack of every thread of the server: the workers of the pools here, the threads of the
/// runtime (main.rs) and the thread that warms the tables (node.rs).
///
/// It is set, not left to the platform's default (2 MiB for a spawned thread, the shell's limit
/// for the main one), because of JSON: a body may nest 4,096 levels deep
/// (`polypack_js::json::MAX_DEPTH`), and a `serde_json::Value` that deep is copied, compared,
/// written and released by functions that call themselves once per level. A stack that overflows
/// ends the whole process, so the size has a margin, not a guess. What each of them needs at that
/// depth was measured with examples/stackprobe.rs (2026-11-10, arm64 macOS; `stackprobe search
/// 4096`), and the most is the copy of a value: 1.3 MiB in a release build (333 bytes a level;
/// comparing takes 285, the provenance's `json_stringify` 237, the store's writer 141, an answer's
/// writer 125, the release 61) and 8.4 MiB unoptimised (2,141 bytes a level). 64 MiB is 49 times
/// the first and 7 times the second; tests/app.rs runs all of them at the full depth on a quarter
/// of it. The memory is reserved address space: only the pages a thread has touched are real.
pub const THREAD_STACK_BYTES: usize = 64 << 20;

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

/// How many sections of the threads that answer requests may block at once (`blocking`): one per
/// core, and at least two.
fn blocking_permits() -> usize {
    std::thread::available_parallelism().map_or(2, |n| n.get()).max(2)
}

/// The runtime of the server: its threads have the stack of `THREAD_STACK_BYTES`, and there are
/// not many of them. Besides one worker per core, the runtime starts a thread for every section
/// that blocks (`blocking`: it takes over the tasks of the thread that blocks) and for every
/// `spawn_blocking` (a snapshot's file, a build), up to this bound; beyond it such a job waits
/// for a thread, and a section blocks its own thread without one taking over. The bound leaves
/// room for every turn of `blocking` and for the snapshot's jobs at once (snapshot.rs: 2 files
/// and a build), where the runtime's default is 512.
pub fn runtime() -> tokio::runtime::Runtime {
    runtime_with_stack(THREAD_STACK_BYTES)
}

/// `runtime` with threads whose stack is `stack_bytes` (the tests of the stack's margin).
pub fn runtime_with_stack(stack_bytes: usize) -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(stack_bytes).max_blocking_threads(blocking_permits() + 8).build().expect("the runtime can be started")
}

static BLOCKING: std::sync::LazyLock<tokio::sync::Semaphore> = std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(blocking_permits()));

/// Runs `section`, which may block its thread (it waits for the store's lock or the state's, runs
/// a statement, reads a file, compresses an answer), when its turn comes, and gives its result.
///
/// A thread of the runtime that blocks hands its other tasks to another thread first
/// (`block_in_place`), and the runtime starts a new thread for that whenever none is idle. So
/// without a turn, every request that waits for the store's lock while one statement is slow
/// holds a thread of its own: 600 requests for a leaderboard at once on a database of a million
/// entries, and the process went from 18 threads to 530 (measured 2026-11-10). Node queues such
/// requests on its one thread. Here they wait for one of a few turns as tasks, which cost no
/// thread, in the order they came (the semaphore is first come, first served), and with the
/// bound of `runtime` the process keeps a few threads per core however many requests wait: 35
/// on eight cores under the same 600 requests
/// (tests/app.rs: `requests_that_wait_for_the_store_do_not_each_hold_a_thread`).
///
/// A section must not ask for another turn inside it.
pub async fn blocking<T>(section: impl FnOnce() -> T) -> T {
    let _turn = BLOCKING.acquire().await.expect("the turns are never closed");
    tokio::task::block_in_place(section)
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
        Pool::with_stack(threads, clock, THREAD_STACK_BYTES)
    }

    /// `new` with workers whose stack is `stack_bytes` (the tests of the stack's margin).
    pub fn with_stack(threads: usize, clock: Clock, stack_bytes: usize) -> Pool {
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
                .stack_size(stack_bytes)
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
