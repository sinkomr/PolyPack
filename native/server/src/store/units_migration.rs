//! apps/server/src/units-migration.ts: the unit change of 2026-10-27 and its exact reverse.
//!
//! Disk and ball pieces have DIAMETER 1 (they had radius 1), and circle and ball containers are
//! scored by their DIAMETER (they were scored by radius). A problem affected by it is the old one
//! scaled exactly by 1/2 (and, for a container that changes from radius to diameter, its score then
//! doubled), so every length of a stored entry is multiplied by a power of two, which binary64
//! holds exactly and which reverses exactly.
//!
//! The state of a database is `meta.units_epoch`: absent or below 2, the old units; 2, the new. The
//! conversion and the marker are one transaction, so a crash leaves all old or all new, and a
//! second start does nothing. A new database starts at 2. `migrate_units(db, true, ..)` is the
//! exact reverse (for a rollback), which sets the marker to 1.
//!
//! Per entry (the lengths of the pieces of a 2D row are x and y; theta is untouched):
//!  - 2D, N = 0, M = 0:  score x 1, pieces x 1/2   (a disk container's diameter is the old radius, in the new disks);
//!  - 2D, N = 0, M >= 3: score x 1/2, pieces x 1/2;
//!  - 2D, N >= 3, M = 0: score x 2, pieces x 1 (polygons keep side 1; the container's diameter is twice its radius);
//!  - literature_value and strict_check.certifiedSize follow the score rule of their row.
//!
//! Spaces (the config JSON, `score` and the score field of the config move together):
//!  - surface (N = 0): s, x, y x 1/2;  sphere (N = 0): rho x 1/2;  torus (N = 0): lattice, x, y x 1/2;
//!  - boundary (piece ball): s, u x 1/2;
//!  - balls: ball pieces in a ball: s x 1, centres x 1/2; ball pieces in a solid: s, centres x 1/2; solids in a ball:
//!    s x 2, poses x 1;
//!  - curved: K = 0, N = 0: size x 1 (M = 0) or 1/2 (M >= 3), x, y x 1/2; N >= 3, M = 0: size x 2 (any K). A disk
//!    problem at K != 0 has no equivalent at the same K (the old radius-1 disks at K are diameter-1 disks at 4K), so
//!    those entries are moved to `space_entries_units_archive` (not served), and moved back by the reverse.
//!
//! The source imports `SPACE_NAMES`, `isSpaceName` and `parseSpaceId` from packages/spaces. Here
//! they come through the trait `SpaceIds`, which the spaces crate implements.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Map, Number, Value};

use super::db::{Db, JsVal, Param};
use super::error::Result;
use super::json;
use super::pieces::{blob_from_json, decode_pieces, encode_pieces, pack_pieces, unpack_pieces};
use super::sha256::Sha256;
use super::types::Pose;
use super::Clock;

/// units-migration.ts: UNITS_EPOCH.
pub const UNITS_EPOCH: &str = "units_epoch";
/// The epoch of diameter-1 disks and balls.
pub const EPOCH_DIAMETER: f64 = 2.0;
/// The epoch of the radius-1 disks and balls; what the reverse sets.
pub const EPOCH_RADIUS: f64 = 1.0;

const ARCHIVE: &str = "
CREATE TABLE IF NOT EXISTS space_entries_units_archive (
  id INTEGER PRIMARY KEY,
  space TEXT NOT NULL,
  problem TEXT NOT NULL,
  score REAL NOT NULL,
  name TEXT NOT NULL,
  agent_note TEXT NOT NULL,
  software TEXT,
  method TEXT,
  seed INTEGER,
  created_at TEXT NOT NULL,
  config TEXT NOT NULL,
  epoch INTEGER NOT NULL
);";

/// A field of a parsed problem id: `Record<string, string | number>`.
#[derive(Clone, Debug, PartialEq)]
pub enum SpaceIdField {
    Number(f64),
    Text(String),
}

/// `parseSpaceId(space, id).fields`: the fields of a problem id, by name.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpaceIdFields(pub Vec<(String, SpaceIdField)>);

impl SpaceIdFields {
    fn get(&self, name: &str) -> Option<&SpaceIdField> {
        self.0.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }
    /// `f[name] === value` for a number.
    fn is_number(&self, name: &str, value: f64) -> bool {
        matches!(self.get(name), Some(SpaceIdField::Number(x)) if *x == value)
    }
    /// `f[name] === value` for a string.
    fn is_text(&self, name: &str, value: &str) -> bool {
        matches!(self.get(name), Some(SpaceIdField::Text(s)) if s == value)
    }
}

/// What the unit conversion needs from packages/spaces (`@polypack/spaces`).
pub trait SpaceIds {
    /// types.ts: SPACE_NAMES, in its order.
    fn space_names(&self) -> Vec<String>;
    /// types.ts: isSpaceName.
    fn is_space_name(&self, space: &str) -> bool {
        self.space_names().iter().any(|s| s == space)
    }
    /// ids.ts: parseSpaceId(space, id). The `fields` of the parsed id, or None when the source
    /// returns a message (the id is not one of the space). Only called with a space for which
    /// `is_space_name` is true.
    fn parse_space_id(&self, space: &str, id: &str) -> Option<SpaceIdFields>;
}

/// units-migration.ts: UnitsReport.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UnitsReport {
    /// "forward" or "reverse"; "none" when the database was already in the target epoch.
    pub action: String,
    /// Rows converted, by class of problem, in the order the classes were first met.
    pub submissions: Map<String, Value>,
    #[serde(rename = "spaceEntries")]
    pub space_entries: Map<String, Value>,
    /// Entries moved to the archive (forward) or out of it (reverse, returned in `restored`).
    pub archived: f64,
    pub restored: f64,
    /// Rows left as they were because their stored pieces or config could not be read.
    pub unreadable: f64,
    pub ms: f64,
}

/// units-migration.ts: unitsEpoch. The epoch a database is in: 2 for diameter units. A database
/// with no marker is in the old units.
pub fn units_epoch(db: &Db) -> Result<f64> {
    let r = db.prepare("SELECT value FROM meta WHERE key = ?")?.get(&[UNITS_EPOCH.into()])?;
    match r {
        Some(r) => r.num("value"),
        None => Ok(0.0),
    }
}

/// units-migration.ts: setUnitsEpoch.
pub fn set_units_epoch(db: &Db, value: f64) -> Result<()> {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")?
        .run(&[UNITS_EPOCH.into(), value.into()])?;
    Ok(())
}

/// Factors for a 2D problem: a length factor for the pieces, a factor for the score.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlanarFactors {
    pub len: f64,
    pub score: f64,
}

/// units-migration.ts: planarFactors. None when the problem is unaffected.
pub fn planar_factors(n: f64, m: f64) -> Option<PlanarFactors> {
    if n == 0.0 {
        return Some(PlanarFactors { len: 0.5, score: if m == 0.0 { 1.0 } else { 0.5 } });
    }
    if m == 0.0 {
        return Some(PlanarFactors { len: 1.0, score: 2.0 });
    }
    None
}

/// How a plan rewrites a config (the `apply` closures of the source's `spacePlan`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Rewrite {
    SurfaceDisks,
    SphereDisks,
    TorusDisks,
    BoundaryBalls,
    /// Ball pieces; `ball_box`: in a ball container.
    Balls { ball_box: bool },
    SolidsInBall,
    /// Flat disks (curved, K = 0, N = 0), with the factor of `size`.
    FlatDisks { size: f64 },
    CurvedPolygonsInDisk,
}

/// units-migration.ts: SpacePlan.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpacePlan {
    /// Factor of the score (and of the config's score field).
    pub score: f64,
    pub label: &'static str,
    rewrite: Rewrite,
}

/// What `spacePlan` returns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SpacePlanResult {
    /// null: the unit change leaves the problem's entries alone.
    Unaffected,
    /// "archive": an entry that is moved aside instead of converted.
    Archived,
    Plan(SpacePlan),
}

fn scale_number(o: &mut Map<String, Value>, key: &str, f: f64) {
    if let Some(v) = o.get_mut(key) {
        scale_value(v, f);
    }
}
/// `if (typeof v === "number") v = v * f`. A product beyond the doubles is Infinity in JavaScript,
/// which JSON writes as null.
fn scale_value(v: &mut Value, f: f64) {
    if let Value::Number(n) = v {
        let x = n.as_f64().unwrap_or(f64::NAN) * f;
        *v = Number::from_f64(x).map_or(Value::Null, Value::Number);
    }
}
fn scale_list(list: Option<&mut Value>, f: f64, indices: &[usize]) {
    if let Some(Value::Array(list)) = list {
        for &i in indices {
            if let Some(v) = list.get_mut(i) {
                scale_value(v, f);
            }
        }
    }
}
/// `fn` for each element of `cfg[key]` that is an object. (The source also calls it for an element
/// that is an array, where every rewrite it does reads a named property and finds none.)
fn each_piece(cfg: &mut Map<String, Value>, key: &str, mut f: impl FnMut(&mut Map<String, Value>)) {
    if let Some(Value::Array(list)) = cfg.get_mut(key) {
        for p in list {
            if let Value::Object(o) = p {
                f(o);
            }
        }
    }
}
fn scale_lattice(c: &mut Map<String, Value>, f: f64) {
    if let Some(Value::Object(lat)) = c.get_mut("lattice") {
        scale_number(lat, "L", f);
        scale_list(lat.get_mut("b1"), f, &[0, 1]);
        scale_list(lat.get_mut("b2"), f, &[0, 1]);
    }
    if let Some(Value::Array(poses)) = c.get_mut("poses") {
        for p in poses {
            scale_list(Some(p), f, &[0, 1]);
        }
    }
}
fn scale_u(c: &mut Map<String, Value>, f: f64) {
    each_piece(c, "pieces", |p| {
        if let Some(Value::Array(u)) = p.get_mut("u") {
            for v in u {
                scale_value(v, f);
            }
        }
    });
}
fn scale_xy(c: &mut Map<String, Value>, f: f64) {
    each_piece(c, "pieces", |p| {
        scale_number(p, "x", f);
        scale_number(p, "y", f);
    });
}
fn scale_centres(c: &mut Map<String, Value>, f: f64) {
    if let Some(Value::Array(pieces)) = c.get_mut("pieces") {
        for p in pieces {
            scale_list(Some(p), f, &[0, 1, 2]);
        }
    }
}

impl SpacePlan {
    /// The plan's `apply`: rewrites the config in place.
    pub fn apply(&self, c: &mut Map<String, Value>) {
        match self.rewrite {
            Rewrite::SurfaceDisks => {
                scale_number(c, "s", 0.5);
                scale_xy(c, 0.5);
            }
            Rewrite::SphereDisks => scale_number(c, "rho", 0.5),
            Rewrite::TorusDisks => scale_lattice(c, 0.5),
            Rewrite::BoundaryBalls => {
                scale_number(c, "s", 0.5);
                scale_u(c, 0.5);
            }
            Rewrite::Balls { ball_box } => {
                scale_number(c, "s", if ball_box { 1.0 } else { 0.5 });
                scale_centres(c, 0.5);
            }
            Rewrite::SolidsInBall => scale_number(c, "s", 2.0),
            Rewrite::FlatDisks { size } => {
                scale_number(c, "size", size);
                scale_xy(c, 0.5);
            }
            Rewrite::CurvedPolygonsInDisk => scale_number(c, "size", 2.0),
        }
    }
}

/// units-migration.ts: spacePlan. What the unit change does to the entries of one space problem.
pub fn space_plan(spaces: &dyn SpaceIds, space: &str, id: &str) -> SpacePlanResult {
    use SpacePlanResult::{Archived, Plan, Unaffected};
    if !spaces.is_space_name(space) {
        return Unaffected;
    }
    let Some(f) = spaces.parse_space_id(space, id) else {
        return Unaffected;
    };
    let plan = |score: f64, label: &'static str, rewrite: Rewrite| Plan(SpacePlan { score, label, rewrite });
    match space {
        "surface" => {
            if !f.is_number("N", 0.0) {
                return Unaffected;
            }
            plan(0.5, "surface disks", Rewrite::SurfaceDisks)
        }
        "sphere" => {
            if !f.is_number("N", 0.0) {
                return Unaffected;
            }
            plan(0.5, "sphere disks", Rewrite::SphereDisks)
        }
        "torus" => {
            if !f.is_number("N", 0.0) {
                return Unaffected;
            }
            plan(0.5, "torus disks", Rewrite::TorusDisks)
        }
        "boundary" => {
            if !f.is_text("piece", "ball") {
                return Unaffected;
            }
            plan(0.5, "boundary balls", Rewrite::BoundaryBalls)
        }
        "balls" => {
            let ball_piece = f.is_text("piece", "ball");
            let ball_box = f.is_text("container", "ball");
            if ball_piece {
                return plan(
                    if ball_box { 1.0 } else { 0.5 },
                    if ball_box { "balls in a ball" } else { "balls in a solid" },
                    Rewrite::Balls { ball_box },
                );
            }
            if ball_box {
                return plan(2.0, "solids in a ball", Rewrite::SolidsInBall);
            }
            Unaffected
        }
        "curved" => {
            let n0 = f.is_number("N", 0.0);
            let m0 = f.is_number("M", 0.0);
            let k0 = f.is_number("K", 0.0);
            if n0 && !k0 {
                return Archived;
            }
            if n0 {
                let size = if m0 { 1.0 } else { 0.5 };
                return plan(size, "flat disks", Rewrite::FlatDisks { size });
            }
            if m0 {
                return plan(2.0, "curved polygons in a disk", Rewrite::CurvedPolygonsInDisk);
            }
            Unaffected
        }
        // "polyhedra", and "ndim", which the source's switch does not name
        _ => Unaffected,
    }
}

/// units-migration.ts: inversePasses. The reverse rewrites, written out beside the forward ones
/// above so that the two are easy to compare (all factors are powers of two).
fn inverse_passes(spaces: &dyn SpaceIds, space: &str, id: &str, c: &mut Map<String, Value>) {
    let Some(f) = spaces.parse_space_id(space, id) else {
        return;
    };
    match space {
        "surface" => {
            scale_number(c, "s", 2.0);
            scale_xy(c, 2.0);
        }
        "sphere" => scale_number(c, "rho", 2.0),
        "torus" => scale_lattice(c, 2.0),
        "boundary" => {
            scale_number(c, "s", 2.0);
            scale_u(c, 2.0);
        }
        "balls" => {
            if f.is_text("piece", "ball") {
                scale_number(c, "s", if f.is_text("container", "ball") { 1.0 } else { 2.0 });
                scale_centres(c, 2.0);
            } else {
                scale_number(c, "s", 0.5);
            }
        }
        "curved" => {
            if f.is_number("N", 0.0) {
                scale_number(c, "size", if f.is_number("M", 0.0) { 1.0 } else { 2.0 });
                scale_xy(c, 2.0);
            } else {
                scale_number(c, "size", 0.5);
            }
        }
        _ => {}
    }
}

fn bump(counts: &mut Map<String, Value>, key: &str) {
    let n = counts.get(key).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
    counts.insert(key.to_string(), Value::Number(Number::from_f64(n).expect("a count")));
}

/// The text `JSON.parse(value)` would read from a stored value that is truthy: a string as it is,
/// anything else as `String(value)`. None for a falsy value (null, "", 0).
pub(crate) fn json_source(v: &JsVal) -> Option<String> {
    if v.truthy() {
        Some(v.to_js_string())
    } else {
        None
    }
}

/// units-migration.ts: applyUnits. Converts the entries of `db` between the two units, WITHOUT a
/// transaction of its own (the caller holds one, so that the conversion and the marker commit
/// together). `reverse` converts from diameter units back to radius units. Returns what it did; a
/// database already in the target epoch is left alone.
pub fn apply_units(db: &Db, reverse: bool, spaces: &dyn SpaceIds, clock: &dyn Clock) -> Result<UnitsReport> {
    let start = clock.performance_now();
    let mut report = UnitsReport {
        action: if reverse { "reverse" } else { "forward" }.to_string(),
        submissions: Map::new(),
        space_entries: Map::new(),
        archived: 0.0,
        restored: 0.0,
        unreadable: 0.0,
        ms: 0.0,
    };
    let epoch = units_epoch(db)?;
    if if reverse { epoch != EPOCH_DIAMETER } else { epoch >= EPOCH_DIAMETER } {
        report.action = "none".to_string();
        return Ok(report);
    }
    db.exec(ARCHIVE)?;

    // 2D submissions: only the rows of affected problems are read (n = 0 or m = 0)
    let rows = db
        .prepare(
            "SELECT id, n, m, score, pieces, literature_value, strict_check FROM submissions WHERE n = 0 OR m = 0 ORDER BY id",
        )?
        .all(&[])?;
    let mut update =
        db.prepare("UPDATE submissions SET score = ?, pieces = ?, literature_value = ?, strict_check = ? WHERE id = ?")?;
    for r in &rows {
        let (n, m) = (r.num("n")?, r.num("m")?);
        let Some(fac) = planar_factors(n, m) else {
            continue;
        };
        let kind = format!("n={} m={}", if n == 0.0 { "0" } else { ">=3" }, if m == 0.0 { "0" } else { ">=3" });
        let len_f = if reverse { 1.0 / fac.len } else { fac.len };
        let score_f = if reverse { 1.0 / fac.score } else { fac.score };
        let blob: Option<Vec<u8>> = match r.get("pieces") {
            JsVal::Blob(b) => Some(b.clone()),
            JsVal::Text(t) => blob_from_json(t),
            _ => None,
        };
        let Some(blob) = blob else {
            report.unreadable += 1.0;
            continue;
        };
        let mut pieces = blob;
        if len_f != 1.0 {
            let poses: Vec<Pose> = decode_pieces(&pieces)?
                .iter()
                .map(|p| Pose { x: p.x * len_f, y: p.y * len_f, theta: p.theta })
                .collect();
            pieces = pack_pieces(encode_pieces(&poses))?;
        }
        // `strict` is bound as it was read unless its JSON was read and written again
        let mut strict: JsVal = r.get("strict_check").clone();
        if let Some(text) = json_source(&strict) {
            match json::parse(&text) {
                // `null["certifiedSize"]` throws, which the source's catch counts like bad JSON
                Ok(Value::Null) | Err(_) => {
                    // an unreadable certificate stays as it was; the row is counted below
                    report.unreadable += 1.0;
                }
                Ok(mut s) => {
                    if let Value::Object(o) = &mut s {
                        scale_number(o, "certifiedSize", score_f);
                    }
                    strict = JsVal::Text(json::stringify(&s));
                }
            }
        }
        update.run(&[
            (r.num("score")? * score_f).into(),
            (&pieces).into(),
            r.num_or_null("literature_value")?.map(|v| v * score_f).into(),
            (&strict).into(),
            r.num("id")?.into(),
        ])?;
        bump(&mut report.submissions, &kind);
    }
    drop(update);

    // space entries
    let names = spaces.space_names();
    let sql = format!(
        "SELECT id, space, problem, score, config FROM space_entries WHERE space IN ({}) ORDER BY id",
        names.iter().map(|_| "?").collect::<Vec<_>>().join(",")
    );
    let entries = db.prepare(&sql)?.all(&names.iter().map(Param::from).collect::<Vec<_>>())?;
    let mut update_entry = db.prepare("UPDATE space_entries SET score = ?, config = ? WHERE id = ?")?;
    let mut to_archive = db.prepare(
        "INSERT INTO space_entries_units_archive (id, space, problem, score, name, agent_note, software, method, seed, created_at, config, epoch)
     SELECT id, space, problem, score, name, agent_note, software, method, seed, created_at, config, ? FROM space_entries WHERE id = ?",
    )?;
    let mut drop_entry = db.prepare("DELETE FROM space_entries WHERE id = ?")?;
    let mut cache: HashMap<(String, String), SpacePlanResult> = HashMap::new();
    for r in &entries {
        let (space, problem) = (r.text("space")?, r.text("problem")?);
        let plan = *cache
            .entry((space.clone(), problem.clone()))
            .or_insert_with(|| space_plan(spaces, &space, &problem));
        let plan = match plan {
            SpacePlanResult::Unaffected => continue,
            SpacePlanResult::Archived => {
                let id = r.num("id")?;
                to_archive.run(&[(if reverse { EPOCH_DIAMETER } else { EPOCH_RADIUS }).into(), id.into()])?;
                drop_entry.run(&[id.into()])?;
                report.archived += 1.0;
                continue;
            }
            SpacePlanResult::Plan(plan) => plan,
        };
        let mut cfg = match json::parse(&r.get("config").to_js_string()) {
            Ok(Value::Object(o)) => o,
            _ => {
                report.unreadable += 1.0;
                continue;
            }
        };
        if reverse {
            inverse_passes(spaces, &space, &problem, &mut cfg);
        } else {
            plan.apply(&mut cfg);
        }
        let text = json::stringify(&Value::Object(cfg));
        update_entry.run(&[
            (r.num("score")? * if reverse { 1.0 / plan.score } else { plan.score }).into(),
            (&text).into(),
            r.num("id")?.into(),
        ])?;
        bump(&mut report.space_entries, plan.label);
    }
    // entries archived in the other direction come back, in the units of the epoch they were archived from
    let other = if reverse { EPOCH_RADIUS } else { EPOCH_DIAMETER };
    let back = db
        .prepare(
            "INSERT INTO space_entries (id, space, problem, score, name, agent_note, software, method, seed, created_at, config)
       SELECT id, space, problem, score, name, agent_note, software, method, seed, created_at, config
       FROM space_entries_units_archive WHERE epoch = ?",
        )?
        .run(&[other.into()])?;
    report.restored = back.changes;
    db.prepare("DELETE FROM space_entries_units_archive WHERE epoch = ?")?.run(&[other.into()])?;
    set_units_epoch(db, other)?;
    report.ms = clock.performance_now() - start;
    Ok(report)
}

/// units-migration.ts: migrateUnits. The start-up conversion: one transaction, run once (a database
/// in diameter units is left alone).
pub fn migrate_units(db: &Db, reverse: bool, spaces: &dyn SpaceIds, clock: &dyn Clock) -> Result<UnitsReport> {
    db.exec("BEGIN IMMEDIATE")?;
    match apply_units(db, reverse, spaces, clock).and_then(|report| db.exec("COMMIT").map(|()| report)) {
        Ok(report) => Ok(report),
        Err(e) => {
            db.exec("ROLLBACK")?;
            Err(e)
        }
    }
}

/// units-migration.ts: unitsDigest. A digest of every converted table (rows in id order), to
/// compare a database before and after a round trip.
pub fn units_digest(db: &Db) -> Result<String> {
    let mut h = Sha256::new();
    let mut feed = |sql: &str| -> Result<()> {
        for r in db.prepare(sql)?.all(&[])? {
            for v in r.values() {
                match v {
                    // pieces, by their triples: the same arrangement packed or not (see pieces.rs) is the
                    // same content
                    JsVal::Blob(b) => h.update(&unpack_pieces(b)?),
                    JsVal::Text(s) if s.starts_with('{') || s.starts_with('[') => {
                        h.update(json::stringify(&json::parse(s)?).as_bytes())
                    }
                    other => h.update(other.to_js_string().as_bytes()),
                }
                h.update("\u{1}".as_bytes());
            }
        }
        Ok(())
    };
    feed("SELECT id, n, m, p, score, pieces, literature_value, strict_check FROM submissions ORDER BY id")?;
    feed("SELECT id, space, problem, score, config FROM space_entries ORDER BY id")?;
    Ok(h.hex())
}
