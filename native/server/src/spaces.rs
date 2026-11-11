//! The seam between the routes ported in this crate and the spaces (surface, curved, sphere,
//! torus, boundary, polyhedra, balls, ndim).
//!
//! `packages/spaces` and `apps/server/src/spaces.ts` are ported after the rest of the server. Until
//! then this module holds what the rest needs to compile and run against:
//!
//!  - `SpacesPort`: everything that app.ts, leaders.ts, snapshot.ts, units-gate.ts, docs.ts and
//!    node.ts take from `@polypack/spaces` and `@polypack/spaces/load` (none of them imports
//!    `@polypack/ndspace`; only spaces.ts does);
//!  - `space_routes`: where the routes of spaces.ts are mounted. It answers nothing yet, so every
//!    path under /api/spaces and /api/admin/spaces gets the 404 of the catch-all;
//!  - the constants of spaces.ts that docs.ts prints;
//!  - `StandInSpaces`: a `SpacesPort` with the names of the spaces and the texts of the API page
//!    (written by native/tools/app-docs.mts), and no catalogue.
//!
//! What each import is used for:
//!
//! | source file    | import                                             | use                                  | here |
//! |----------------|----------------------------------------------------|--------------------------------------|------|
//! | leaders.ts     | `SpacesIndex` (`index[space]`)                     | whether a space has a catalogue      | `has_catalogue` |
//! | leaders.ts     | `isSpaceName`, `parseSpaceId`, `problemOf`         | the problem a key names              | `problem_of` |
//! | leaders.ts     | `acceptsSubmissions`, `p.id`, `p.certified?.score` | its id, record and whether it is open| `SpaceProblemRef` |
//! | snapshot.ts    | `SPACE_NAMES`, `index[s]`                          | the spaces of the manifest           | `space_names`, `has_catalogue` |
//! | snapshot.ts    | `cat.problems` (its ids in order, its length)      | the order of a space's file          | `listed`, `catalogue_len` |
//! | snapshot.ts    | `cat.byId.get`, `acceptsSubmissions`, `listed.P`   | a listed problem's P, open or not    | `listed` |
//! | snapshot.ts    | `isSpaceName`, `parseSpaceId`, `problemOf`         | a domain problem without a record    | `problem_of` |
//! | units-gate.ts  | `isSpaceName` (and `spacePlan` of the store)       | `spaceAffected`                      | `SpaceIds` (store) |
//! | docs.ts        | `SPACE_NAMES`, `SPACE_INFO`, `SPACE_EXHIBITS`, 15 limits and messages | the API page      | `docs` |
//! | node.ts        | `loadSpacesIndex(root, log)`                       | the catalogues, at startup           | the constructor of the port |
//! | app.ts         | `SpacesOptions`, `registerSpaceRoutes` (spaces.ts) | the routes                           | `space_routes` |
//! | sqlite-store.ts, units-migration.ts | `SPACE_NAMES`, `isSpaceName`, `parseSpaceId(..).fields` | the unit conversion | `SpaceIds` (store) |

use std::sync::Arc;

use serde::Deserialize;

use crate::clock::Clock;
use crate::hono::{Req, Res};
use crate::limits::SubmitLimits;
use crate::load::LoadStats;
use crate::pool::Pool;
use crate::store::{SpaceIdFields, SpaceIds, SqliteStore};

/// spaces.ts: SPACE_SITE_ONLY_DEFAULT_LIMIT. Problems one /api/spaces/{space}/site-only page holds
/// without a `limit`.
pub const SPACE_SITE_ONLY_DEFAULT_LIMIT: f64 = 1000.0;
/// spaces.ts: SPACE_SITE_ONLY_MAX_LIMIT. And at most.
pub const SPACE_SITE_ONLY_MAX_LIMIT: f64 = 5000.0;
/// spaces.ts: SPACE_HEAVY_CHECK_P. Polyhedra, surface, curved, sphere and torus checks from this P
/// on are heavy: one runs at a time on the server.
pub const SPACE_HEAVY_CHECK_P: f64 = 30.0;
/// spaces.ts: SPACE_HEAVY_CHECKS_WAITING. Heavy checks that may wait their turn; another is
/// refused with 503.
pub const SPACE_HEAVY_CHECKS_WAITING: f64 = 8.0;
/// spaces.ts: SPACE_METHOD_LENGTH. Longest `method` text of a space submission.
pub const SPACE_METHOD_LENGTH: f64 = 80.0;

/// What the routes outside spaces.ts read of one problem of a space (a `SpaceProblemEntry`).
#[derive(Clone, Debug, PartialEq)]
pub struct SpaceProblemRef {
    /// `p.id`: the problem's id in its one written form.
    pub id: String,
    /// `p.P`.
    pub p: f64,
    /// `p.certified?.score`: the research record's certified size; None when the problem has no
    /// record or its record has no value (an infeasible problem).
    pub certified_score: Option<f64>,
    /// `acceptsSubmissions(p)`: its research record is neither proven nor infeasible (or it has none).
    pub accepts_submissions: bool,
}

/// `SPACE_INFO[name]`, as far as the API page prints it.
#[derive(Clone, Debug, Deserialize)]
pub struct SpaceInfoDoc {
    pub name: String,
    pub viewer: String,
    pub title: String,
    pub summary: String,
    pub problem_id: String,
    /// `Object.entries(info.conventions)`, in their order.
    pub conventions: Vec<(String, String)>,
    pub score: String,
    pub docs: String,
}

/// One of `SPACE_EXHIBITS`.
#[derive(Clone, Debug, Deserialize)]
pub struct SpaceExhibitDoc {
    pub viewer: String,
    pub title: String,
    pub summary: String,
    pub docs: String,
}

/// What docs.ts imports from `@polypack/spaces`.
#[derive(Clone, Debug, Deserialize)]
pub struct SpacesDocs {
    /// SPACE_NAMES.
    pub names: Vec<String>,
    /// SPACE_INFO, in the order of SPACE_NAMES.
    pub info: Vec<SpaceInfoDoc>,
    /// SPACE_EXHIBITS.
    pub exhibits: Vec<SpaceExhibitDoc>,
    /// SPACE_MAX_P, in the order of SPACE_NAMES.
    pub max_p: Vec<(String, f64)>,
    /// SPACE_BOUND_SLACK.
    pub bound_slack: f64,
    /// SPACE_MIN_QUATERNION_NORM.
    pub min_quaternion_norm: f64,
    /// SPACE_STRICT_NO_RECORD_REASON.
    pub strict_no_record_reason: String,
    /// SPACE_STRICT_REASON.
    pub strict_reason: String,
    /// SPACE_STRICT_TOL.
    pub strict_tol: f64,
    /// SPACE_MAX_COORD.
    pub max_coord: f64,
    /// SPACE_MAX_SIZE.
    pub max_size: f64,
    /// POLYHEDRA_MAX_QUATERNION.
    pub polyhedra_max_quaternion: f64,
    /// SPACE_RECORD_MARGIN.polyhedra.
    pub record_margin_polyhedra: f64,
    /// SPACE_TOL.
    pub tol: f64,
    /// SURFACE_MAX_CHAINS.
    pub surface_max_chains: f64,
    /// TORUS_MAX_TRANSLATES.
    pub torus_max_translates: f64,
    /// BOUNDARY_MAX_CHAINS.
    pub boundary_max_chains: f64,
    /// BOUNDARY_MAX_S.
    pub boundary_max_s: f64,
}

/// What the server outside spaces.ts needs from `packages/spaces`: the catalogues that
/// `loadSpacesIndex` read at startup (a `SpacesIndex`), and the constants of the package. The
/// store's part of it, `SpaceIds` (SPACE_NAMES, isSpaceName, the fields of a parsed id), is the
/// supertrait.
pub trait SpacesPort: SpaceIds + Send + Sync {
    /// False for a stand-in that knows no problem of any space: the server then refuses to convert
    /// a database that holds space entries in the old units, which it could not do right.
    fn complete(&self) -> bool;

    /// `index[space] !== undefined`: whether the space's catalogue was loaded (its records file
    /// was read, or it has a domain).
    fn has_catalogue(&self, space: &str) -> bool;

    /// `index[space].problems.length`: the number of problems with a research record. 0 without a
    /// catalogue.
    fn catalogue_len(&self, space: &str) -> usize;

    /// `index[space].byId.get(id)`: a problem with a research record, by the exact text of its id,
    /// with its place in `index[space].problems`.
    fn listed(&self, space: &str, id: &str) -> Option<(usize, SpaceProblemRef)>;

    /// `parseSpaceId(space, id)`, and when that is an id of the space, `problemOf(cat, parsed)`:
    /// the problem's record, or for an id of the space's domain without one, the entry made for it
    /// (status `no_record`). None when the id is not of the space's form, the space has no
    /// catalogue, or the id is neither in the catalogue nor in the domain.
    fn problem_of(&self, space: &str, id: &str) -> Option<SpaceProblemRef>;

    /// The constants and texts of the package that the API page prints.
    fn docs(&self) -> &SpacesDocs;
}

/// spaces.ts: SpaceRouteContext. What the spaces routes share with the rest of the API: the limits
/// of /api/submit, the log and the admin check; and what the Rust server adds: the store behind its
/// lock, the workers that verify, and the clock.
pub struct SpaceRouteContext<'a> {
    /// `spaces.index`.
    pub spaces: &'a Arc<dyn SpacesPort>,
    /// `spaces.store`: the store, behind its lock. Never hold it while checking a submission.
    pub store: &'a Arc<std::sync::Mutex<SqliteStore>>,
    /// Whether submissions to problems of the unit change must carry units (see AppOptions.unitsGate).
    pub units_gate: bool,
    /// The count and verification budget of an address, or of the submit key.
    pub submit_limits: &'a Arc<SubmitLimits>,
    /// True while verifications wait too long for a worker (submissions are then refused with 503).
    pub overloaded: &'a (dyn Fn() -> bool + Send + Sync),
    pub client_ip: &'a (dyn Fn(&Req) -> String + Send + Sync),
    pub log: &'a (dyn Fn(&str) + Send + Sync),
    pub stats: Option<&'a Arc<std::sync::Mutex<LoadStats>>>,
    /// None when the request carries the admin token; otherwise the refusal to send.
    pub admin: &'a (dyn Fn(&Req) -> Option<Res> + Send + Sync),
    /// The workers on which a submission is checked.
    pub pool: &'a Pool,
    pub clock: &'a Clock,
}

/// What `space_routes` did with a request.
pub enum SpaceRoute {
    /// A route of spaces.ts answered.
    Answer(Res),
    /// None did: the catch-all of app.ts answers 404. `compress` says whether the path is one that
    /// spaces.ts puts `hono/compress` on (`app.use(path, compress())`), which then also applies to
    /// that 404.
    Pass { compress: bool },
}

/// spaces.ts: registerSpaceRoutes, as one function: the routes under /api/spaces and
/// /api/admin/spaces. `method` is the method the request is routed by (GET for a HEAD request).
///
/// Not ported yet: every request passes on to the catch-all.
pub async fn space_routes(_ctx: &SpaceRouteContext<'_>, _method: &str, _path: &str, _req: &mut Req) -> SpaceRoute {
    SpaceRoute::Pass { compress: false }
}

/// A `SpacesPort` without catalogues: the names of the spaces and the texts of the API page, as
/// native/tools/app-docs.mts wrote them from `@polypack/spaces`. No key of /api/leaders names a
/// problem of a space, the snapshot has no space files, and the unit conversion reads no id.
pub struct StandInSpaces {
    docs: SpacesDocs,
}

impl StandInSpaces {
    pub fn new() -> StandInSpaces {
        let docs: SpacesDocs = serde_json::from_str(include_str!("../data/spaces_docs.json")).expect("data/spaces_docs.json is what native/tools/app-docs.mts writes");
        StandInSpaces { docs }
    }
}

impl Default for StandInSpaces {
    fn default() -> Self {
        Self::new()
    }
}

impl SpaceIds for StandInSpaces {
    fn space_names(&self) -> Vec<String> {
        self.docs.names.clone()
    }
    fn parse_space_id(&self, _space: &str, _id: &str) -> Option<SpaceIdFields> {
        None
    }
}

impl SpacesPort for StandInSpaces {
    fn complete(&self) -> bool {
        false
    }
    fn has_catalogue(&self, _space: &str) -> bool {
        false
    }
    fn catalogue_len(&self, _space: &str) -> usize {
        0
    }
    fn listed(&self, _space: &str, _id: &str) -> Option<(usize, SpaceProblemRef)> {
        None
    }
    fn problem_of(&self, _space: &str, _id: &str) -> Option<SpaceProblemRef> {
        None
    }
    fn docs(&self) -> &SpacesDocs {
        &self.docs
    }
}
