//! What the server outside spaces.ts takes from `packages/spaces` (`native/spaces`, the crate
//! `polypack-spaces`): the trait `SpacesPort`, and its implementation over the catalogues that
//! `loadSpacesIndex` read at startup.
//!
//! The modules ported before the spaces (leaders.rs, snapshot.rs, units_gate.rs, docs.rs and the
//! store) were written against this trait, and keep it: each reads through it exactly what its
//! source file imports from `@polypack/spaces`.
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
//! | node.ts        | `loadSpacesIndex(root, log)`                       | the catalogues, at startup           | `LoadedSpaces::load` |
//! | spaces.ts      | `SpacesIndex` and the rest of the package          | the routes                           | `index` |
//! | sqlite-store.ts, units-migration.ts | `SPACE_NAMES`, `isSpaceName`, `parseSpaceId(..).fields` | the unit conversion | `SpaceIds` (store) |

use std::collections::HashMap;
use std::path::Path;

use polypack_spaces::{
    accepts_submissions, load_spaces_index, parse_space_id, parse_space_id_fields, problem_of, space_exhibits, space_info, space_max_p, space_names, space_record_margin, Field, SpaceCatalogue,
    SpaceName, SpaceProblemEntry, SpacesIndex, BOUNDARY_MAX_CHAINS, BOUNDARY_MAX_S, POLYHEDRA_MAX_QUATERNION, SPACE_BOUND_SLACK, SPACE_MAX_COORD, SPACE_MAX_SIZE, SPACE_MIN_QUATERNION_NORM, SPACE_NAMES,
    SPACE_STRICT_NO_RECORD_REASON, SPACE_STRICT_REASON, SPACE_STRICT_TOL, SPACE_TOL, SURFACE_MAX_CHAINS, TORUS_MAX_TRANSLATES,
};
use serde::Deserialize;

use crate::store::{SpaceIdField, SpaceIdFields, SpaceIds};

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

impl SpaceProblemRef {
    fn of(p: &SpaceProblemEntry) -> SpaceProblemRef {
        SpaceProblemRef { id: p.id.clone(), p: p.p as f64, certified_score: p.certified.as_ref().map(|c| c.score), accepts_submissions: accepts_submissions(p) }
    }
}

/// `SPACE_INFO[name]`, as far as the API page prints it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SpaceExhibitDoc {
    pub viewer: String,
    pub title: String,
    pub summary: String,
    pub docs: String,
}

/// What docs.ts imports from `@polypack/spaces`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
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

impl SpacesDocs {
    /// The values of `polypack-spaces`: what docs.ts reads from `@polypack/spaces`.
    pub fn of_the_package() -> SpacesDocs {
        SpacesDocs {
            names: space_names(),
            info: SPACE_NAMES
                .iter()
                .map(|s| {
                    let i = space_info(*s);
                    SpaceInfoDoc {
                        name: i.space.clone(),
                        viewer: i.viewer.clone(),
                        title: i.title.clone(),
                        summary: i.summary.clone(),
                        problem_id: i.problem_id.clone(),
                        conventions: i.conventions.0.clone(),
                        score: i.score.clone(),
                        docs: i.docs.clone(),
                    }
                })
                .collect(),
            exhibits: space_exhibits().iter().map(|e| SpaceExhibitDoc { viewer: e.viewer.clone(), title: e.title.clone(), summary: e.summary.clone(), docs: e.docs.clone() }).collect(),
            max_p: SPACE_NAMES.iter().map(|s| (s.as_str().to_string(), space_max_p(*s))).collect(),
            bound_slack: SPACE_BOUND_SLACK,
            min_quaternion_norm: SPACE_MIN_QUATERNION_NORM,
            strict_no_record_reason: SPACE_STRICT_NO_RECORD_REASON.to_string(),
            strict_reason: SPACE_STRICT_REASON.to_string(),
            strict_tol: SPACE_STRICT_TOL,
            max_coord: SPACE_MAX_COORD,
            max_size: SPACE_MAX_SIZE,
            polyhedra_max_quaternion: POLYHEDRA_MAX_QUATERNION,
            record_margin_polyhedra: space_record_margin(SpaceName::Polyhedra),
            tol: SPACE_TOL,
            surface_max_chains: SURFACE_MAX_CHAINS,
            torus_max_translates: TORUS_MAX_TRANSLATES,
            boundary_max_chains: BOUNDARY_MAX_CHAINS,
            boundary_max_s: BOUNDARY_MAX_S,
        }
    }
}

/// What the server outside spaces.ts needs from `packages/spaces`: the catalogues that
/// `loadSpacesIndex` read at startup (a `SpacesIndex`), and the constants of the package. The
/// store's part of it, `SpaceIds` (SPACE_NAMES, isSpaceName, the fields of a parsed id), is the
/// supertrait.
pub trait SpacesPort: SpaceIds + Send + Sync {
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

    /// The catalogues themselves, for the routes of spaces.ts.
    fn index(&self) -> &SpacesIndex;
}

/// The spaces as node.ts has them: `loadSpacesIndex(root, log)`.
pub struct LoadedSpaces {
    index: SpacesIndex,
    /// For each space, `new Map(cat.problems.map((q, i) => [q.id, i]))` (snapshot.ts: snapshotSpaces).
    order: Vec<HashMap<String, usize>>,
    docs: SpacesDocs,
}

impl LoadedSpaces {
    /// load.ts: loadSpacesIndex. Reads data/<space>/records.json below `root`; `log` receives one
    /// line per space and one per record left out.
    pub fn load(root: &Path, log: polypack_spaces::Log) -> LoadedSpaces {
        LoadedSpaces::new(load_spaces_index(root, log))
    }

    pub fn new(index: SpacesIndex) -> LoadedSpaces {
        let order = SPACE_NAMES
            .iter()
            .map(|s| match index.get(*s) {
                Some(cat) => cat.problems.iter().enumerate().map(|(i, q)| (q.id.clone(), i)).collect(),
                None => HashMap::new(),
            })
            .collect();
        LoadedSpaces { index, order, docs: SpacesDocs::of_the_package() }
    }

    /// `isSpaceName(space) ? index[space] : undefined`.
    fn catalogue(&self, space: &str) -> Option<(SpaceName, &SpaceCatalogue)> {
        let name = SpaceName::parse(space)?;
        self.index.get(name).map(|cat| (name, &**cat))
    }
}

impl SpaceIds for LoadedSpaces {
    fn space_names(&self) -> Vec<String> {
        space_names()
    }

    fn is_space_name(&self, space: &str) -> bool {
        polypack_spaces::is_space_name(space)
    }

    fn parse_space_id(&self, space: &str, id: &str) -> Option<SpaceIdFields> {
        let fields = parse_space_id_fields(space, id)?;
        Some(SpaceIdFields(
            fields
                .into_iter()
                .map(|(k, v)| {
                    (
                        k,
                        match v {
                            Field::Number(x) => SpaceIdField::Number(x),
                            Field::Text(s) => SpaceIdField::Text(s),
                        },
                    )
                })
                .collect(),
        ))
    }
}

impl SpacesPort for LoadedSpaces {
    fn has_catalogue(&self, space: &str) -> bool {
        self.catalogue(space).is_some()
    }

    fn catalogue_len(&self, space: &str) -> usize {
        self.catalogue(space).map_or(0, |(_, cat)| cat.problems.len())
    }

    fn listed(&self, space: &str, id: &str) -> Option<(usize, SpaceProblemRef)> {
        let (name, cat) = self.catalogue(space)?;
        let listed = cat.by_id.get(id)?;
        let at = self.order[name.index()].get(id).copied()?;
        Some((at, SpaceProblemRef::of(listed)))
    }

    fn problem_of(&self, space: &str, id: &str) -> Option<SpaceProblemRef> {
        let (name, cat) = self.catalogue(space)?;
        let parsed = parse_space_id(name, id).ok()?;
        problem_of(cat, &parsed).map(|p| SpaceProblemRef::of(&p))
    }

    fn docs(&self) -> &SpacesDocs {
        &self.docs
    }

    fn index(&self) -> &SpacesIndex {
        &self.index
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// data/spaces_docs.json is what native/tools/app-docs.mts writes from `@polypack/spaces`: the
    /// values that the Rust package's own constants must equal.
    #[test]
    fn the_packages_constants_are_the_sources() {
        let written: SpacesDocs = serde_json::from_str(include_str!("../data/spaces_docs.json")).expect("data/spaces_docs.json is what native/tools/app-docs.mts writes");
        assert_eq!(SpacesDocs::of_the_package(), written);
    }
}
