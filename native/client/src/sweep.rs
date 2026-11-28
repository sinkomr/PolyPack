//! The sweeps (--sweep-2d-on-3d, --sweep-3d-in-3d): the client's main loop taking its problems from the
//! order of sweep_order.rs / sweep_order3.rs instead of at random. Each problem goes through the same
//! search as a drawn space problem (space_search.rs): read it, skip it when it is closed, unknown or led
//! by the user (unless --include-own), search it on its share of the threads (a fresh engine where one
//! handles it, else the port), validate the best with the server's own validator, read the leader again,
//! decide and submit to POST /api/spaces/submit, one submission at a time.
//!
//! The bulk lists of problems with a best (known.rs) let a problem be passed over without being read:
//! closed ones, those you lead, and with --open-only all that have any best.

use crate::format::format_duration;
use crate::http::sleep_unless;
use crate::known::{self, Known, REFRESH_SECONDS};
use crate::options::SweepOptions;
use crate::sweep_order::{Dispenser, Next, Order, Taken};
use crate::volunteer::{log, Searched, Shared};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Tries at reading one problem (each already retried by the API layer) before it is passed over.
const UNREACHABLE_TRIES: u32 = 3;

/// The sweep's order and position, and the lists it reads.
pub struct SweepState {
    pub o: SweepOptions,
    pub dispenser: Dispenser,
    /// The bulk lists and when they were read; None before the first read.
    known: Mutex<Option<(Instant, Arc<Known>)>>,
    /// Problems passed over from the lists, without reading them.
    known_skipped: AtomicUsize,
    /// Problems passed over in all (closed, unknown, led by the user, with a best with --open-only).
    skipped: AtomicUsize,
}

impl SweepState {
    /// The position is read from (and kept in) `state_dir`; the order must not be empty.
    pub fn open(order: Order, o: SweepOptions, state_dir: &Path, logger: Arc<dyn Fn(&str) + Send + Sync>) -> SweepState {
        let dispenser = Dispenser::open(order, Some(state_dir), o.restart, logger).with_one_pass(o.one_pass);
        SweepState { o, dispenser, known: Mutex::new(None), known_skipped: AtomicUsize::new(0), skipped: AtomicUsize::new(0) }
    }

    /// Reads the bulk lists of problems with a best for the swept spaces (known.rs), and logs what they hold.
    pub fn load_known(&self, s: &Shared) {
        let mut spaces: Vec<&str> = Vec::new();
        for k in &self.o.kinds {
            if !spaces.contains(&k.name()) {
                spaces.push(k.name());
            }
        }
        let t = Instant::now();
        match known::load(&s.reader, &spaces) {
            Ok(k) => {
                log(&format!(
                    "Read the lists of problems with a best ({}): {} with a best, {} closed, in {}; {} without reading them",
                    spaces.join(", "),
                    k.has_best.len(),
                    k.closed.len(),
                    format_duration(t.elapsed().as_secs_f64()),
                    if self.o.open_only {
                        "problems with a best, closed ones and those you lead are passed over"
                    } else if self.o.include_own {
                        "closed problems are passed over"
                    } else {
                        "closed problems and those you lead are passed over"
                    }
                ));
                *self.known.lock().unwrap() = Some((Instant::now(), Arc::new(k)));
            }
            Err(e) => {
                if !s.stopped() {
                    log(&format!("Could not read the lists of problems with a best ({e}): every problem is read on its own"));
                }
                // try again at the next refresh, not at every problem
                *self.known.lock().unwrap() = Some((Instant::now(), Arc::new(Known::default())));
            }
        }
    }

    /// True when the lists say the problem can be passed over without reading it. Lists older than
    /// REFRESH_SECONDS are read again first, by the thread that finds them old.
    fn known_skip(&self, s: &Shared, id: &str) -> bool {
        let stale = self.known.lock().unwrap().as_ref().map_or(false, |(at, _)| at.elapsed().as_secs() >= REFRESH_SECONDS);
        if stale {
            // the next thread to look finds them fresh: mark them now, read after
            if let Some((at, _)) = self.known.lock().unwrap().as_mut() {
                *at = Instant::now();
            }
            self.load_known(s);
        }
        let known = self.known.lock().unwrap().as_ref().map(|(_, k)| k.clone());
        let Some(known) = known else { return false };
        let own = if self.o.include_own { None } else { s.o.name.as_deref() };
        if known.skip(id, self.o.open_only, own).is_some() {
            self.known_skipped.fetch_add(1, Ordering::Relaxed);
            return true;
        }
        false
    }

    pub fn banner(&self, s: &Shared) {
        let (pass, k) = self.dispenser.position();
        let order = self.dispenser.order();
        log(&format!(
            "{}: {}; loop {k} of {} (pass {pass}); up to {} per problem; {}{}",
            order.name(),
            order.describe(),
            order.loops(),
            format_duration(s.o.minutes_per_problem * 60.0),
            if self.o.include_own { "problems you lead are searched again (--include-own)" } else { "problems you already lead are skipped" },
            if self.o.open_only { "; open problems only (a problem with any best is skipped)" } else { "" }
        ));
    }

    /// The last line of a run: what was done and where the sweep stands.
    pub fn final_log(&self, s: &Shared, c: [usize; 4]) {
        let (pass, k) = self.dispenser.position();
        self.dispenser.flush();
        log(&format!(
            "Stopped after {}: {} problem(s) searched, {} skipped ({} of them from the lists, without reading them), {} submission(s) sent, {} accepted, {} took the lead. At loop {k} of pass {pass}; state is in {}.",
            format_duration(s.started.elapsed().as_secs_f64()),
            c[0],
            self.skipped.load(Ordering::Relaxed),
            self.known_skipped.load(Ordering::Relaxed),
            c[1],
            c[2],
            c[3],
            s.o.state_dir.display()
        ));
    }
}

/// One problem of the sweep: from the lists when they can say it is not worth a read, else read and searched.
fn search_one(s: &Arc<Shared>, sw: &SweepState, t: &Taken, lanes: usize) -> Searched {
    if sw.known_skip(s, &t.problem.id) {
        return Searched::Skipped;
    }
    crate::space_search::search_space(s, t.problem.space(), &t.problem.id, lanes, Some(t))
}

/// One problem after another on `lanes` threads, until the client stops.
pub(crate) fn slot(s: &Arc<Shared>, lanes: usize) -> i32 {
    let Some(sw) = s.sweep.as_ref() else { return 1 };
    while !s.stopped() {
        while s.paused.load(Ordering::Relaxed) && !s.stopped() {
            std::thread::sleep(Duration::from_millis(500));
        }
        if s.stopped() || s.check_deadline(true) {
            break;
        }
        let t = match sw.dispenser.take() {
            Next::Wait => {
                sleep_unless(&s.stop, 250);
                continue;
            }
            Next::Finished => {
                s.request_stop("The pass is complete (--one-pass)");
                break;
            }
            Next::Problem(t) => t,
        };
        let mut tries = 0;
        loop {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| search_one(s, sw, &t, lanes)));
            let searched = outcome.unwrap_or_else(|_| {
                log(&format!("Passing over {} after an unexpected error", t.problem.id));
                Searched::Skipped
            });
            match searched {
                Searched::Unreachable => {
                    tries += 1;
                    if s.stopped() {
                        break;
                    }
                    if tries >= UNREACHABLE_TRIES {
                        log(&format!("Could not reach the server to read {} after {tries} tries: passing over it", t.problem.id));
                        sw.dispenser.finish(&t, false);
                        break;
                    }
                    let ms = 60_000u64.min(2000 * 2u64.pow(tries + 1));
                    log(&format!("Could not reach the server to read a problem; trying again in {} s", ms / 1000));
                    sleep_unless(&s.stop, ms);
                    continue;
                }
                Searched::Skipped | Searched::Held => {
                    sw.skipped.fetch_add(1, Ordering::Relaxed);
                    sw.dispenser.finish(&t, false);
                }
                Searched::Done(complete) => {
                    if complete {
                        sw.dispenser.finish(&t, true);
                    }
                    if s.o.once {
                        return 0;
                    }
                }
            }
            break;
        }
    }
    0
}
