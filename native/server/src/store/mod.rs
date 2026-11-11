//! The database layer of the server: the SQLite store, ported from apps/server/src.
//!
//! | source                        | module               |
//! |-------------------------------|----------------------|
//! | store.ts                      | `types`              |
//! | sqlite-store.ts               | `sqlite_store`, `pieces_migration` (startPiecesMigration) |
//! | pieces.ts                     | `pieces`             |
//! | units-migration.ts            | `units_migration`    |
//! | node:sqlite, as the store uses it | `db`             |
//! | JSON.parse and JSON.stringify of stored text | `json` |
//!
//! The Rust server opens the TypeScript server's database file in place, and either server can
//! take the file over from the other at any time: same schema text, same statements, same row
//! encodings, same `meta` markers, same migrations in place. `native/tools/store-ref.mts`,
//! `examples/storediff.rs` and `native/tools/store-compare.mjs` check this.

pub mod db;
pub mod error;
pub mod json;
pub mod pieces;
pub mod pieces_migration;
pub mod sha256;
pub mod sqlite_store;
pub mod types;
pub mod units_migration;

#[cfg(test)]
mod tests;

pub use db::{Db, JsVal, Param, TraceEvent, Tracer};
pub use error::{Result, StoreError};
pub use pieces::{blob_from_json, decode_pieces, encode_pieces, read_pieces, PIECE_BYTES};
pub use pieces_migration::{MigrationOptions, PiecesMigration};
pub use sqlite_store::{OpenOptions, SqliteStore};
pub use types::*;
pub use units_migration::{
    apply_units, migrate_units, planar_factors, set_units_epoch, space_plan, units_digest, units_epoch, PlanarFactors,
    SpaceIdField, SpaceIdFields, SpaceIds, SpacePlan, SpacePlanResult, UnitsReport, EPOCH_DIAMETER, EPOCH_RADIUS,
    UNITS_EPOCH,
};

use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// The two clocks the source reads. Neither reaches the database: `performance.now()` times the
/// unit conversion and the steps of the pieces migration for the log, and `Date.now()` spaces the
/// migration's progress lines. (The `created_at` of an entry is given by the caller.)
pub trait Clock: Send {
    /// `performance.now()`: milliseconds on a clock that only moves forward.
    fn performance_now(&self) -> f64;
    /// `Date.now()`: milliseconds since 1970-01-01 UTC.
    fn date_now(&self) -> f64;
}

/// The system's clocks.
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        SystemClock { origin: Instant::now() }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn performance_now(&self) -> f64 {
        self.origin.elapsed().as_secs_f64() * 1000.0
    }
    fn date_now(&self) -> f64 {
        // whole milliseconds, as Date.now() gives
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
    }
}
