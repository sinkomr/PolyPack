//! Port of apps/server/src/docs.ts: the API page served at /api, and the registered search
//! methods.
//!
//! The page is some 700 lines of text with values spliced in. The text is not retyped:
//! native/tools/app-docs.mts writes the template literals of docs.ts into data/docs.json, each as
//! its parts, a text or the source of a `${...}` expression. This module evaluates each
//! expression (`value_of`: one arm per expression of the source) and joins the parts. An expression
//! it does not know stops the first rendering, so a change of docs.ts that needs a change here
//! cannot pass unseen (the tool's `--check` says when the file is out of date).

use std::collections::HashMap;
use std::sync::OnceLock;

use polypack_flat::protocol::{MAX_EVENT_KEYS, SCORE_TIE};
use polypack_flat::provenance::{MAX_METHOD_PARAMS_BYTES, MAX_SOFTWARE_LENGTH};
use polypack_flat::shapes::{MAX_PIECES, MAX_SIDES};
use polypack_js::fmt;
use serde::Deserialize;

use crate::js;
use crate::leaders::{LEADERS_MAX_KEYS, LEADERS_MAX_URL};
use crate::limits::{KEYED_SUBMISSIONS_PER_MINUTE, KEYED_VERIFY_MS_PER_MINUTE, MAX_BODY_BYTES, MAX_NAME_LENGTH, MAX_NOTE_LENGTH, SNAPSHOT_FILES_PER_HOUR, VERIFY_MS_PER_MINUTE};
use crate::spaces::{SpacesDocs, SPACE_HEAVY_CHECKS_WAITING, SPACE_HEAVY_CHECK_P, SPACE_METHOD_LENGTH, SPACE_SITE_ONLY_DEFAULT_LIMIT, SPACE_SITE_ONLY_MAX_LIMIT};

#[derive(Deserialize)]
#[serde(untagged)]
enum Part {
    Text { text: String },
    Expr { expr: String },
}

#[derive(Deserialize)]
struct DocsFile {
    templates: HashMap<String, Vec<Part>>,
    methods: Vec<(String, String)>,
}

fn file() -> &'static DocsFile {
    static FILE: OnceLock<DocsFile> = OnceLock::new();
    FILE.get_or_init(|| serde_json::from_str(include_str!("../data/docs.json")).expect("data/docs.json is what native/tools/app-docs.mts writes"))
}

/// docs.ts: SOLVER_METHODS. The registered search methods, in registration order, each with the
/// description its schema carries.
pub fn solver_methods() -> &'static [(String, String)] {
    &file().methods
}

/// The names of SOLVER_METHODS: what a submission may give as its `method` (app.ts: METHOD_NAMES).
pub fn method_names() -> Vec<&'static str> {
    solver_methods().iter().map(|(name, _)| name.as_str()).collect()
}

const REPO: &str = "https://github.com/sinkomr/PolyPack";

/// docs.ts: esc.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The limits of the atlas and of the holder page, owned by the routes and passed in.
#[derive(Clone, Copy, Debug)]
pub struct DocsLimits {
    pub atlas_max_span: f64,
    pub atlas_max_pieces: f64,
    pub holder_cache_names: f64,
    pub holder_max_age_ms: f64,
}

struct Page<'a> {
    limits: DocsLimits,
    spaces: &'a SpacesDocs,
}

impl Page<'_> {
    /// A template of docs.ts with its expressions evaluated.
    fn render(&self, name: &str) -> String {
        let parts = file().templates.get(name).unwrap_or_else(|| panic!("data/docs.json has no template {name}"));
        let mut out = String::new();
        for part in parts {
            match part {
                Part::Text { text } => out.push_str(text),
                Part::Expr { expr } => out.push_str(&self.value_of(expr)),
            }
        }
        out
    }

    /// The `rows` of spacesSection: one table row per space.
    fn rows(&self) -> String {
        let rows: Vec<String> = self
            .spaces
            .info
            .iter()
            .map(|i| {
                format!(
                    "<tr><td><a href=\"{}\">{}</a><br><code>{}</code></td><td>{}</td><td><code>{}</code></td><td><code>{}</code></td><td>{}</td><td><a href=\"{}\">notes</a></td></tr>",
                    i.viewer,
                    esc(&i.title),
                    i.name,
                    esc(&i.summary),
                    esc(&i.problem_id),
                    esc(i.conventions.iter().find(|(k, _)| k == "configuration").map_or("undefined", |(_, v)| v.as_str())),
                    esc(&i.score),
                    i.docs
                )
            })
            .collect();
        rows.join("\n")
    }

    /// The `conventions` of spacesSection: each space's conventions as a table.
    fn conventions(&self) -> String {
        let blocks: Vec<String> = self
            .spaces
            .info
            .iter()
            .map(|i| {
                let items: Vec<String> = i.conventions.iter().map(|(k, v)| format!("<tr><th scope=\"row\"><code>{}</code></th><td>{}</td></tr>", esc(k), esc(v))).collect();
                format!("<h4>{} (<code>{}</code>)</h4>\n<table>\n{}\n</table>", esc(&i.title), i.name, items.join("\n"))
            })
            .collect();
        blocks.join("\n")
    }

    /// The `exhibits` of spacesSection.
    fn exhibits(&self) -> String {
        let items: Vec<String> = self
            .spaces
            .exhibits
            .iter()
            .map(|e| format!("<li><a href=\"{}\">{}</a>: {} (<a href=\"{}\">notes</a>; listed by <code>/api/spaces</code>, takes no submissions)</li>", e.viewer, esc(&e.title), esc(&e.summary), e.docs))
            .collect();
        items.join("\n")
    }

    /// The value of one `${...}` of docs.ts, by the text of its expression.
    fn value_of(&self, expr: &str) -> String {
        let s = self.spaces;
        let n = fmt::num;
        match expr {
            "REPO" => REPO.to_string(),
            "rows" => self.rows(),
            "exhibits" => self.exhibits(),
            "conventions" => self.conventions(),
            "spacesSection()" => self.render("spacesSection"),
            "SPACE_TOL" => n(s.tol),
            "SPACE_STRICT_TOL" => n(s.strict_tol),
            "esc(SPACE_STRICT_NO_RECORD_REASON)" => esc(&s.strict_no_record_reason),
            "esc(SPACE_STRICT_REASON)" => esc(&s.strict_reason),
            "SCORE_TIE" => n(SCORE_TIE),
            "SPACE_RECORD_MARGIN.polyhedra.toExponential()" => fmt::exponential(s.record_margin_polyhedra, None),
            "SPACE_SITE_ONLY_MAX_LIMIT" => n(SPACE_SITE_ONLY_MAX_LIMIT),
            "SPACE_SITE_ONLY_DEFAULT_LIMIT" => n(SPACE_SITE_ONLY_DEFAULT_LIMIT),
            "MAX_NOTE_LENGTH" => n(MAX_NOTE_LENGTH as f64),
            "MAX_SOFTWARE_LENGTH" => n(MAX_SOFTWARE_LENGTH as f64),
            "SPACE_METHOD_LENGTH" => n(SPACE_METHOD_LENGTH),
            "MAX_BODY_BYTES / 1024" => n(MAX_BODY_BYTES as f64 / 1024.0),
            "SPACE_HEAVY_CHECKS_WAITING" => n(SPACE_HEAVY_CHECKS_WAITING),
            "SPACE_HEAVY_CHECK_P" => n(SPACE_HEAVY_CHECK_P),
            "VERIFY_MS_PER_MINUTE / 1000" => n(VERIFY_MS_PER_MINUTE / 1000.0),
            "SPACE_NAMES.map((n) => `${n} ${SPACE_MAX_P[n]}`).join(\", \")" => {
                let list: Vec<String> = s.names.iter().map(|name| format!("{name} {}", s.max_p.iter().find(|(k, _)| k == name).map_or("undefined".to_string(), |(_, p)| n(*p)))).collect();
                list.join(", ")
            }
            "SPACE_MAX_SIZE" => n(s.max_size),
            "SPACE_MAX_COORD" => n(s.max_coord),
            "POLYHEDRA_MAX_QUATERNION" => n(s.polyhedra_max_quaternion),
            "SPACE_MIN_QUATERNION_NORM.toExponential()" => fmt::exponential(s.min_quaternion_norm, None),
            "SPACE_BOUND_SLACK" => n(s.bound_slack),
            "SURFACE_MAX_CHAINS" => n(s.surface_max_chains),
            "TORUS_MAX_TRANSLATES" => n(s.torus_max_translates),
            "BOUNDARY_MAX_S" => n(s.boundary_max_s),
            "BOUNDARY_MAX_CHAINS" => n(s.boundary_max_chains),
            "MAX_SIDES" => n(MAX_SIDES as f64),
            "MAX_PIECES" => n(MAX_PIECES as f64),
            "TOL" => n(polypack_flat::config::TOL),
            "KEYED_SUBMISSIONS_PER_MINUTE" => n(KEYED_SUBMISSIONS_PER_MINUTE),
            "KEYED_VERIFY_MS_PER_MINUTE / 1000" => n(KEYED_VERIFY_MS_PER_MINUTE / 1000.0),
            "MAX_NAME_LENGTH" => n(MAX_NAME_LENGTH as f64),
            "MAX_METHOD_PARAMS_BYTES" => n(MAX_METHOD_PARAMS_BYTES as f64),
            "LEADERS_MAX_KEYS" => n(LEADERS_MAX_KEYS as f64),
            "LEADERS_MAX_URL" => n(LEADERS_MAX_URL as f64),
            "Math.round(limits.holderMaxAgeMs / 60_000)" => n(polypack_js::math::round(self.limits.holder_max_age_ms / 60_000.0)),
            "limits.holderCacheNames" => n(self.limits.holder_cache_names),
            "limits.atlasMaxSpan" => n(self.limits.atlas_max_span),
            "limits.atlasMaxPieces" => n(self.limits.atlas_max_pieces),
            "SNAPSHOT_FILES_PER_HOUR.toLocaleString(\"en-US\")" => js::to_locale_string(SNAPSHOT_FILES_PER_HOUR),
            "MAX_EVENT_KEYS" => n(MAX_EVENT_KEYS as f64),
            "SOLVER_METHODS.map(([name, summary]) => `<tr><td><code>${name}</code></td><td>${esc(summary)}</td></tr>`).join(\"\\n\")" => {
                let rows: Vec<String> = solver_methods().iter().map(|(name, summary)| format!("<tr><td><code>{name}</code></td><td>{}</td></tr>", esc(summary))).collect();
                rows.join("\n")
            }
            other => {
                // esc(NAME): another template of the file, escaped
                if let Some(name) = other.strip_prefix("esc(").and_then(|r| r.strip_suffix(')')) {
                    if file().templates.contains_key(name) {
                        return esc(&self.render(name));
                    }
                }
                panic!("docs.ts has an expression that docs.rs does not know: {other}")
            }
        }
    }
}

/// docs.ts: docsPage. API documentation page served at /api.
pub fn docs_page(limits: DocsLimits, spaces: &SpacesDocs) -> String {
    Page { limits, spaces }.render("docsPage")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spaces::{SpacesPort, StandInSpaces};

    #[test]
    fn the_page_renders_every_expression() {
        let spaces = StandInSpaces::new();
        let page = docs_page(DocsLimits { atlas_max_span: 100.0, atlas_max_pieces: 6000.0, holder_cache_names: 32.0, holder_max_age_ms: 900_000.0 }, spaces.docs());
        assert!(page.starts_with("<!doctype html>\n<html lang=\"en\">"));
        assert!(page.ends_with("</body>\n</html>"));
        assert!(!page.contains("${"));
        assert!(page.contains("an integer from 3 to 100 for a regular polygon. <code>P</code> is from 1 to 500."));
        assert!(page.contains("separation is below −1e-9 (in piece units)"));
        assert!(page.contains("asks for more than 20,000 files an hour"));
        assert!(page.contains("<tr><td><code>identity</code></td><td>Evaluate a starting configuration without searching."));
        assert!(page.contains("The answer can be up to 15 minutes old: the server keeps the answers of the last 32 names"));
        assert!(page.contains("600 submissions and 20 s of verification time a minute"));
        assert!(page.contains("at most 4096 bytes as JSON"));
        assert!(page.contains("&lt;ADMIN_TOKEN&gt;"));
    }

    // apps/server/test/api.test.ts: the methods a submission may name are the solver's registry
    #[test]
    fn the_methods_are_the_sources() {
        assert_eq!(method_names(), ["identity", "polish", "seed", "penalty", "basin_hopping", "mc_compress", "morph", "asc", "ls_growth", "harden", "shrink_repair"]);
    }
}
