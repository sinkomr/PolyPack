//! The tables of packages/spaces that are not retyped (native/PORTING.md, rule 6):
//! `data/tables.json`, written by native/tools/spaces-tables.mts from the TypeScript modules, holds
//! `SURFACE_SOLIDS` of ids.ts and `SPACE_INFO` and `SPACE_EXHIBITS` of info.ts (whose sentences the
//! source writes from the packages' limits). The tool's `--check` fails when the file is out of date.

use crate::types::{SpaceExhibit, Texts};
use serde_json::Value;
use std::sync::LazyLock;

/// One entry of `SPACE_INFO`: what info.ts says of a space (the counts and the domain come from
/// the loaded catalogue).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct SpaceInfoText {
    pub space: String,
    pub title: String,
    pub summary: String,
    pub score: String,
    pub problem_id: String,
    pub conventions: Texts,
    pub viewer: String,
    pub docs: String,
}

pub(crate) struct Tables {
    pub surface_solids: Vec<String>,
    /// In the order of `SPACE_NAMES`.
    pub info: Vec<SpaceInfoText>,
    pub exhibits: Vec<SpaceExhibit>,
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("tables.json: {key} is not a string")).to_string()
}

pub(crate) static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let v: Value = serde_json::from_str(include_str!("../data/tables.json")).expect("data/tables.json is the tool's output");
    let list = |key: &str| v.get(key).and_then(Value::as_array).unwrap_or_else(|| panic!("tables.json: {key} is not a list"));
    let surface_solids = list("surface_solids").iter().map(|s| s.as_str().expect("a solid's name").to_string()).collect();
    let info = list("info")
        .iter()
        .map(|i| SpaceInfoText {
            space: text(i, "space"),
            title: text(i, "title"),
            summary: text(i, "summary"),
            score: text(i, "score"),
            problem_id: text(i, "problem_id"),
            // the order of the keys is the file's (serde_json with preserve_order), which is the source's
            conventions: Texts(
                i.get("conventions")
                    .and_then(Value::as_object)
                    .expect("conventions")
                    .iter()
                    .map(|(k, s)| (k.clone(), s.as_str().expect("a sentence").to_string()))
                    .collect(),
            ),
            viewer: text(i, "viewer"),
            docs: text(i, "docs"),
        })
        .collect();
    let exhibits = list("exhibits")
        .iter()
        .map(|e| SpaceExhibit {
            name: text(e, "name"),
            title: text(e, "title"),
            summary: text(e, "summary"),
            viewer: text(e, "viewer"),
            docs: text(e, "docs"),
        })
        .collect();
    Tables { surface_solids, info, exhibits }
});
