//! Reading configurations as a server must: untrusted input in, a clean copy with only the known fields out.
//! Port of what the server reaches of `packages/polyhedra/src/records.ts` (`parsePolyhedraConfig`).

use crate::validate::{config_errors, config_of_value, PolyhedraConfig};
use serde_json::Value;

/// `records.ts: ParsedConfig`.
#[derive(Clone, Debug, PartialEq)]
pub enum ParsedConfig {
    /// `{ ok: true, config, score }`.
    Ok { config: PolyhedraConfig, score: f64 },
    /// `{ ok: false, malformed, errors }`.
    Failed { malformed: bool, errors: Vec<String> },
}

/// `records.ts: parsePolyhedraConfig`: a configuration of a problem with P pieces from untrusted input:
/// { s, pieces: [[x, y, z, qw, qx, qy, qz], ...] } with only those fields kept. Errors are `malformed` when the
/// input is not such a configuration at all, and not when only the number of pieces is wrong (an invalid
/// packing, as the other families have it).
pub fn parse_polyhedra_config(raw: &Value, p: usize, max_errors: usize) -> ParsedConfig {
    let errs = config_errors(raw, None, max_errors);
    if !errs.is_empty() {
        return ParsedConfig::Failed { malformed: true, errors: errs };
    }
    let count = raw.get("pieces").and_then(Value::as_array).map_or(0, Vec::len);
    if count != p {
        return ParsedConfig::Failed {
            malformed: false,
            errors: vec![format!("expected {} pieces for this problem, got {}", p, count)],
        };
    }
    // With max_errors 0 the source's check reads no pose, and its `p.slice(0, 7)` then throws on a pose that is
    // not an array; the server calls with 20, where a configuration without errors is always readable.
    match config_of_value(raw) {
        Some(config) => {
            let score = config.s;
            ParsedConfig::Ok { config, score }
        }
        None => ParsedConfig::Failed {
            malformed: true,
            errors: vec!["config must be an object {s, pieces}".to_string()],
        },
    }
}
