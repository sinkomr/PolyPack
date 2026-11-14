//! sqlite-store.ts: startPiecesMigration, without its timer.
//!
//! The source runs the pieces migration in the background with `setTimeout`: one step of `batch`
//! rows every `pauseMs`, until it is complete. Each step blocks the process for its own few
//! milliseconds only. A step that fails (for example while an operator holds the database) is tried
//! again after a minute; after five failures in a row the migration stops until the next start.
//!
//! Here the timer belongs to the HTTP layer. `SqliteStore::start_pieces_migration` does what the
//! source does before its first timeout and returns the state of the run; `PiecesMigration::tick`
//! is the body of the source's `tick`: one step, the same log lines, and the delay after which the
//! caller is to call `tick` again, or None once the run has finished. Between two ticks the caller
//! releases the store, so requests are served as they are between two timeouts in the source.

use polypack_js::fmt;

use super::error::Result;
use super::sqlite_store::SqliteStore;

/// sqlite-store.ts: MigrationOptions (its `log` is passed to each call instead).
#[derive(Clone, Copy, Debug)]
pub struct MigrationOptions {
    /// Rows per step; each step is one short transaction. 0 (or less) switches the migration off.
    pub batch: f64,
    /// Pause between steps, during which requests are served.
    pub pause_ms: f64,
    /// Least time between two progress lines in the log; 60,000 ms when None.
    pub log_every_ms: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Total {
    rows: f64,
    converted: f64,
    deleted: f64,
    unreadable: f64,
    bytes_before: f64,
    bytes_after: f64,
    ms: f64,
}

/// A run of the pieces migration: what the closure of the source's `startPiecesMigration` holds.
#[derive(Debug)]
pub struct PiecesMigration {
    batch: f64,
    pause_ms: f64,
    log_every_ms: f64,
    total: Total,
    failures: u32,
    last_log: f64,
    stopped: bool,
}

fn mb(bytes: f64) -> String {
    format!("{} MB", fmt::fixed(bytes / 1e6, 1))
}

impl PiecesMigration {
    /// True once the run is over: complete, stopped, or given up after five failures (the source's
    /// `finished` promise has resolved).
    pub fn finished(&self) -> bool {
        self.stopped
    }

    /// The delay before the first `tick`, in milliseconds (the source's first `setTimeout`); None
    /// when there is nothing to do: the migration is complete already or switched off.
    pub fn first_delay_ms(&self) -> Option<f64> {
        if self.stopped {
            None
        } else {
            Some(self.pause_ms)
        }
    }

    /// The source's `stop`: no further step is taken.
    pub fn stop(&mut self) {
        self.stopped = true;
    }

    fn summary(&self) -> String {
        let t = &self.total;
        format!(
            "{} converted ({} to {}), {} deleted, {} left as text; {} rows in {} s of work",
            fmt::num(t.converted),
            mb(t.bytes_before),
            mb(t.bytes_after),
            fmt::num(t.deleted),
            fmt::num(t.unreadable),
            fmt::num(t.rows),
            fmt::fixed(t.ms / 1000.0, 1)
        )
    }

    /// The source's `tick`: one step of the migration. Returns the delay in milliseconds after
    /// which to call `tick` again, or None when the run has finished.
    pub fn tick(&mut self, store: &SqliteStore, log: &mut dyn FnMut(&str)) -> Option<f64> {
        if self.stopped {
            return None;
        }
        let started = store.clock.performance_now();
        let step = match store.migrate_pieces(self.batch) {
            Ok(step) => {
                self.failures = 0;
                step
            }
            Err(e) => {
                self.failures += 1;
                log(&format!("[pieces] migration step failed ({} in a row): {}", self.failures, e.message()));
                if self.failures >= 5 {
                    log("[pieces] migration stopped; it resumes at the next start");
                    self.stopped = true;
                    return None;
                }
                return Some(self.pause_ms.max(60_000.0));
            }
        };
        self.total.ms += store.clock.performance_now() - started;
        self.total.rows += step.rows;
        self.total.converted += step.converted;
        self.total.deleted += step.deleted;
        self.total.unreadable += step.unreadable;
        self.total.bytes_before += step.bytes_before;
        self.total.bytes_after += step.bytes_after;
        if step.done {
            // the source reads the two pragmas unguarded, in a timer: a failure there is an uncaught
            // exception of the process. Here the line is written without the figure instead.
            let free = store.pragma("freelist_count").and_then(|f| Ok(f * store.pragma("page_size")?));
            match free {
                Ok(free) => log(&format!(
                    "[pieces] migration complete: {}. {} of the file is free for reuse; docs/DEPLOY_FLY.md says how to give it back to the disk",
                    self.summary(),
                    mb(free)
                )),
                Err(e) => log(&format!("[pieces] migration complete: {}. ({})", self.summary(), e.message())),
            }
            self.stopped = true;
            return None;
        }
        if store.clock.date_now() - self.last_log >= self.log_every_ms {
            self.last_log = store.clock.date_now();
            // as above: the source's MAX(id) read is unguarded
            let last = store.last_id().map_or_else(|e| e.message(), fmt::num);
            log(&format!("[pieces] migration at row {} of {}: {}", fmt::num(step.cursor), last, self.summary()));
        }
        Some(self.pause_ms)
    }
}

impl SqliteStore {
    /// sqlite-store.ts: startPiecesMigration, up to its first timeout. Does nothing (and logs
    /// nothing) when the migration is complete or `batch` is 0; otherwise writes the starting line.
    /// The caller then calls `tick` after `first_delay_ms()`, and again after each delay it returns.
    pub fn start_pieces_migration(&self, opts: MigrationOptions, log: &mut dyn FnMut(&str)) -> Result<PiecesMigration> {
        let mut run = PiecesMigration {
            batch: opts.batch,
            pause_ms: opts.pause_ms,
            log_every_ms: opts.log_every_ms.unwrap_or(60_000.0),
            total: Total::default(),
            failures: 0,
            last_log: 0.0,
            stopped: false,
        };
        if opts.batch <= 0.0 || self.pieces_migrated()? {
            run.stopped = true;
            return Ok(run);
        }
        run.last_log = self.clock.date_now();
        log(&format!(
            "[pieces] migration starting after row {} of {}: {} rows every {} ms",
            fmt::num(self.pieces_cursor()?),
            fmt::num(self.last_id()?),
            fmt::num(opts.batch),
            fmt::num(opts.pause_ms)
        ));
        Ok(run)
    }
}
