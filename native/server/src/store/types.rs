//! The store's types: apps/server/src/store.ts, and the result shapes of sqlite-store.ts.
//!
//! Every number is an `f64`, as in the source: ids, shape codes and counts included. They are bound
//! to SQLite as doubles (see db.rs) and written to JSON by `polypack_js::json` as JavaScript writes
//! them (`7`, not `7.0`). Each struct serializes to the JSON the TypeScript value gives, key for key
//! and in the same order.

use serde::ser::{SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// packages/geometry/src/protocol.ts: SCORE_TIE. The leader of a problem is the earliest listed
/// entry whose score is at most `min * (1 + SCORE_TIE)`.
pub const SCORE_TIE: f64 = 1e-9;

/// store.ts: GET_MANY_LIMIT. Most ids one `get_many` call accepts.
pub const GET_MANY_LIMIT: usize = 500;

/// store.ts: KEEP_PER_PROBLEM. Entries kept per problem: the leader alone (decided 2026-10-18, to
/// keep the database small; it was 3). Every other entry is deleted as soon as it is overtaken, row
/// and name included.
///
/// One exception: while the leader is pending verification (it claims to beat a published value
/// and awaits review), the best entry that is not pending is kept as well, so that rejecting the
/// claim gives the problem back its previous record. Other pending entries are deleted like any
/// other. Once the claim is confirmed, that entry goes; once it is rejected, the claim goes.
pub const KEEP_PER_PROBLEM: f64 = 1.0;

/// packages/geometry/src/shapes.ts: Pose. Position and orientation of one piece.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub theta: f64,
}

/// The `pieces` of a stored entry, as `readPieces` returns them. A row written since 2026-10-18
/// holds a BLOB, which is a list of poses. An older row holds JSON text, which the source hands on
/// as `JSON.parse` read it, whatever it is: nearly always a list of `{x, y, theta}`, but a row the
/// migration left as text (see `SqliteStore::migrate_pieces`) can hold anything.
#[derive(Clone, Debug, PartialEq)]
pub enum Pieces {
    Poses(Vec<Pose>),
    Json(Value),
}

impl Pieces {
    /// The poses, when the value is a list of objects whose x, y and theta are numbers (other keys
    /// are ignored, as a reader of `p.x` would ignore them); None for any other JSON.
    pub fn poses(&self) -> Option<Vec<Pose>> {
        match self {
            Pieces::Poses(p) => Some(p.clone()),
            Pieces::Json(Value::Array(list)) => list
                .iter()
                .map(|p| {
                    let o = p.as_object()?;
                    let n = |k: &str| o.get(k).and_then(|v| if v.is_number() { v.as_f64() } else { None });
                    Some(Pose { x: n("x")?, y: n("y")?, theta: n("theta")? })
                })
                .collect(),
            Pieces::Json(_) => None,
        }
    }
}

impl Serialize for Pieces {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Pieces::Poses(list) => {
                let mut seq = s.serialize_seq(Some(list.len()))?;
                for p in list {
                    seq.serialize_element(p)?;
                }
                seq.end()
            }
            Pieces::Json(v) => v.serialize(s),
        }
    }
}

/// packages/geometry/src/protocol.ts: Provenance. How a packing was found; `edit` replaces all six
/// fields together.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    /// "hand", "optimizer", "optimizer_edited", "external", or null (not recorded).
    pub found_with: Option<String>,
    /// Registered PolyPack search method.
    pub method: Option<String>,
    /// The method's resolved parameters, a JSON object. Stored as `JSON.stringify` writes it; a
    /// value that is falsy in JavaScript (null) is stored as NULL.
    pub method_params: Option<Value>,
    pub seed: Option<f64>,
    /// `{evals?, time_s?}`.
    pub budget: Option<Value>,
    pub software: Option<String>,
}

/// store.ts: EntryEdit. What `edit` may change; fields left None are kept.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EntryEdit {
    pub name: Option<String>,
    pub agent_note: Option<String>,
    pub provenance: Option<Provenance>,
}

/// store.ts: NewSubmission. The legacy `agent` column of older databases is no longer read; new
/// rows store an empty string in it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NewSubmission {
    #[serde(rename = "N")]
    pub n: f64,
    #[serde(rename = "M")]
    pub m: f64,
    #[serde(rename = "P")]
    pub p: f64,
    pub score: f64,
    pub name: String,
    pub agent_note: String,
    pub pieces: Vec<Pose>,
    /// Orientation the score was computed at: the container_phi submitted.
    pub container_phi: f64,
    pub created_at: String,
    /// "none", "pending", "confirmed" (or "rejected" in rows of older versions).
    pub verification: String,
    /// Published value that the submission beat, when it did.
    pub literature_value: Option<f64>,
    /// The StrictResult `{ok, certifiedSize, eps, reason?}` of the shrink test, or null.
    pub strict_check: Option<Value>,
    pub found_with: Option<String>,
    pub method: Option<String>,
    pub method_params: Option<Value>,
    pub seed: Option<f64>,
    pub budget: Option<Value>,
    pub software: Option<String>,
}

/// store.ts: StoredSubmission, in the key order of sqlite-store.ts: toStored.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StoredSubmission {
    pub id: f64,
    #[serde(rename = "N")]
    pub n: f64,
    #[serde(rename = "M")]
    pub m: f64,
    #[serde(rename = "P")]
    pub p: f64,
    pub score: f64,
    pub name: String,
    pub agent_note: String,
    pub pieces: Pieces,
    pub container_phi: f64,
    pub created_at: String,
    pub verification: String,
    pub literature_value: Option<f64>,
    /// `JSON.parse` of the stored text; `Value::Null` when nothing is stored.
    pub strict_check: Value,
    pub found_with: Option<String>,
    pub method: Option<String>,
    pub method_params: Value,
    pub seed: Option<f64>,
    pub budget: Value,
    pub software: Option<String>,
}

/// packages/geometry/src/protocol.ts: LeaderboardEntry, as the store reads it (the columns of
/// ENTRY_COLUMNS, in their order).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LeaderboardEntry {
    pub id: f64,
    pub name: String,
    pub found_with: Option<String>,
    pub agent_note: String,
    pub score: f64,
    pub created_at: String,
    pub verification: String,
}

/// One row of `best_per_p`: `LeaderboardEntry & { P }`, P first as the statement returns it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BestOfP {
    #[serde(rename = "P")]
    pub p: f64,
    pub id: f64,
    pub name: String,
    pub found_with: Option<String>,
    pub agent_note: String,
    pub score: f64,
    pub created_at: String,
    pub verification: String,
}

/// A problem: `{ N, M, P }`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProblemKey {
    #[serde(rename = "N")]
    pub n: f64,
    #[serde(rename = "M")]
    pub m: f64,
    #[serde(rename = "P")]
    pub p: f64,
}

/// A pair of shapes: `{ N, M }`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pair {
    #[serde(rename = "N")]
    pub n: f64,
    #[serde(rename = "M")]
    pub m: f64,
}

/// store.ts: ProblemLeader. The leader of one problem, as `leaders` lists it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProblemLeader {
    #[serde(rename = "N")]
    pub n: f64,
    #[serde(rename = "M")]
    pub m: f64,
    #[serde(rename = "P")]
    pub p: f64,
    /// Submission id of the leading entry.
    pub id: f64,
    pub name: String,
    pub score: f64,
    pub verification: String,
}

/// store.ts: Submitted. What `submit` did with a new entry.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Submitted {
    pub id: f64,
    /// The problem's leader before the entry was added, and after.
    pub before: Option<LeaderboardEntry>,
    pub leader: Option<LeaderboardEntry>,
    /// The entry's `rank` position when it was added.
    pub position: f64,
    /// False when the prune deleted the entry at once: it does not lead and is not kept behind a pending leader.
    pub kept: bool,
}

/// What `review` decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Confirmed,
    Rejected,
}

/// One row of `holder_peaks`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HolderPeak {
    pub name: String,
    pub peak: f64,
}

/// store.ts: NewSpaceEntry. A site entry of one of the spaces.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NewSpaceEntry {
    pub space: String,
    /// The problem id, e.g. "surface/cube/fold/4/12".
    pub problem: String,
    pub score: f64,
    pub name: String,
    pub agent_note: String,
    pub software: Option<String>,
    pub method: Option<String>,
    pub seed: Option<f64>,
    /// The configuration as JSON text, as the server normalised it.
    pub config: String,
    pub created_at: String,
}

/// store.ts: StoredSpaceEntry, in the key order of sqlite-store.ts: spaceGet.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StoredSpaceEntry {
    pub id: f64,
    pub space: String,
    pub problem: String,
    pub score: f64,
    pub name: String,
    pub agent_note: String,
    pub software: Option<String>,
    pub method: Option<String>,
    pub seed: Option<f64>,
    pub config: String,
    pub created_at: String,
}

/// store.ts: SpaceLeader. The leader of one space problem, without its configuration.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceLeader {
    pub id: f64,
    pub space: String,
    pub problem: String,
    pub score: f64,
    pub name: String,
    pub created_at: String,
}

/// store.ts: SpaceSubmitted. What `space_submit` did with a new entry.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceSubmitted {
    pub id: f64,
    pub before: Option<SpaceLeader>,
    pub leader: Option<SpaceLeader>,
    /// False when the prune deleted the entry at once: it does not lead.
    pub kept: bool,
}

/// store.ts: SpaceEntryEdit. What `space_edit` may change.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpaceEntryEdit {
    pub name: Option<String>,
    pub agent_note: Option<String>,
}

/// A space problem: `{ space, problem }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpaceProblem {
    pub space: String,
    pub problem: String,
}

/// sqlite-store.ts: MigrationStep. What one step of the pieces migration did.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct MigrationStep {
    /// True when no row was left after the cursor: the migration is complete.
    pub done: bool,
    /// Id of the last row handled so far.
    pub cursor: f64,
    pub rows: f64,
    /// Rows whose pieces, JSON text or triples, were rewritten in the packed form (or, from JSON
    /// text, as triples).
    pub converted: f64,
    /// Rows deleted because their problem no longer keeps them (see KEEP_PER_PROBLEM), rejected rows
    /// included. Rows of the same problem beyond this step count here too.
    pub deleted: f64,
    /// Rows left as JSON text because it is not exactly a list of {x, y, theta}.
    pub unreadable: f64,
    /// Bytes of pieces of the converted rows, before and after.
    #[serde(rename = "bytesBefore")]
    pub bytes_before: f64,
    #[serde(rename = "bytesAfter")]
    pub bytes_after: f64,
}
