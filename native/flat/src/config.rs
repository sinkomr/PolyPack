//! Port of packages/geometry/src/config.ts: the configuration schema of the API, its parser for
//! untrusted JSON, the one scoring routine (`evaluate`) and the shrink test (`strict_verify`).
//!
//! POST /api/submit (apps/server/src/app.ts) applies them so:
//!
//! ```text
//! parse_config(&body)                      400 with its errors (and parse_provenance's) when not ok
//! evaluate(&config, &EvaluateOptions::server(MAX_REPORTED_OVERLAPS))
//!                                          422 with its reasons when not valid
//! strict_verify(config.n, &config.pieces, &container, STRICT_EPS)
//!                                          only when beats_literature(container.size, record)
//! ```

use crate::enclose::{auto_orient_set, enclose, enclose_set, extreme_points};
pub use crate::overlap::{find_overlaps, Overlap, TOL};
use crate::shapes::{shape_code, Container, Pose, MAX_COORD, MAX_PIECES, MAX_SIDES};
use polypack_js::fmt;
use serde_json::Value;

/// config.ts: PackingConfig. The configuration schema shared by export/import, share URLs and the
/// API.
#[derive(Clone, Debug, PartialEq)]
pub struct PackingConfig {
    pub n: u32,
    pub m: u32,
    pub p: usize,
    pub pieces: Vec<Pose>,
    pub container_phi: f64,
    pub name: Option<String>,
    pub agent_note: Option<String>,
}

/// `typeof v === "number" && Number.isFinite(v)` (config.ts: isFiniteNumber): the number, when
/// the value is one. A `serde_json::Value` holds finite numbers only, and so does anything
/// `JSON.parse` returns except a literal beyond the range of a double (1e999), which JavaScript
/// reads as Infinity and serde_json refuses to parse at all.
fn finite_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        _ => None,
    }
}

/// config.ts: parseConfig. Checks the shape and ranges of an untrusted configuration. It does not
/// check geometry (overlaps, piece count against P); [`evaluate`] does that. The errors are the
/// source's, in its order.
///
/// A JSON `null` is JavaScript's `null` and an absent key is `undefined`; the source tells them
/// apart (`theta: null` is an error, an absent theta is 0) and so does this.
pub fn parse_config(input: &Value) -> Result<PackingConfig, Vec<String>> {
    let mut errors: Vec<String> = Vec::new();
    // typeof input !== "object" || input === null; an array is an object without the fields
    let field = |key: &str| -> Option<&Value> {
        match input {
            Value::Object(o) => o.get(key),
            _ => None,
        }
    };
    if !matches!(input, Value::Object(_) | Value::Array(_)) {
        return Err(vec!["body must be a JSON object".to_string()]);
    }
    let shape_msg = format!("must be 0 (circle) or an integer from 3 to {MAX_SIDES}");
    let n = field("N").and_then(shape_code);
    if n.is_none() {
        errors.push(format!("N {shape_msg}"));
    }
    let m = field("M").and_then(shape_code);
    if m.is_none() {
        errors.push(format!("M {shape_msg}"));
    }
    // typeof o.P !== "number" || !Number.isInteger(o.P) || o.P < 1 || o.P > MAX_PIECES
    let p = match field("P") {
        Some(Value::Number(v)) => v.as_f64().filter(|x| x.is_finite() && x.trunc() == *x && *x >= 1.0 && *x <= MAX_PIECES as f64),
        _ => None,
    };
    if p.is_none() {
        errors.push(format!("P must be an integer from 1 to {MAX_PIECES}"));
    }
    let mut pieces: Vec<Pose> = Vec::new();
    match field("pieces") {
        Some(Value::Array(list)) => {
            if list.len() > MAX_PIECES {
                errors.push(format!("pieces must have at most {MAX_PIECES} entries"));
            } else {
                pieces.reserve(list.len());
                for (i, entry) in list.iter().enumerate() {
                    // A piece is read by its properties x, y, theta. Only an object can have them:
                    // of a number, a string, true or an array they are undefined (an error), and
                    // null, 0, "" and false fail the source's `!p` first, with the same error.
                    // (One pass over the object's fields finds the three; a key occurs once.)
                    let (mut px, mut py, mut pt) = (None, None, None);
                    if let Value::Object(o) = entry {
                        for (key, v) in o {
                            match key.as_str() {
                                "x" => px = Some(v),
                                "y" => py = Some(v),
                                "theta" => pt = Some(v),
                                _ => {}
                            }
                        }
                    }
                    let x = finite_number(px);
                    let y = finite_number(py);
                    // p.theta === undefined ? 0 : p.theta
                    let theta = match pt {
                        None if entry.is_object() => Some(0.0),
                        some => finite_number(some),
                    };
                    let (Some(x), Some(y), Some(theta)) = (x, y, theta) else {
                        errors.push(format!("pieces[{i}] must have finite numbers x, y, theta"));
                        break;
                    };
                    if x.abs() > MAX_COORD || y.abs() > MAX_COORD {
                        errors.push(format!("pieces[{i}] is outside the coordinate limit of {}", fmt::num(MAX_COORD)));
                        break;
                    }
                    pieces.push(Pose { x, y, theta });
                }
            }
        }
        _ => errors.push("pieces must be an array".to_string()),
    }
    // o.container_phi === undefined ? 0 : o.container_phi
    let phi = match field("container_phi") {
        None => Some(0.0),
        some => finite_number(some),
    };
    if phi.is_none() {
        errors.push("container_phi must be a finite number".to_string());
    }
    // `agent` ("human" | "ai") was replaced by found_with (see parse_provenance); old clients still send it, and it is ignored
    let name = field("name");
    if name.is_some_and(|v| !v.is_string()) {
        errors.push("name must be a string".to_string());
    }
    let agent_note = field("agent_note");
    if agent_note.is_some_and(|v| !v.is_string()) {
        errors.push("agent_note must be a string".to_string());
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let text = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
    Ok(PackingConfig {
        n: n.unwrap(),
        m: m.unwrap(),
        p: p.unwrap() as usize,
        pieces,
        container_phi: phi.unwrap(),
        name: text(name),
        agent_note: text(agent_note),
    })
}

/// config.ts: Evaluation.
#[derive(Clone, Debug)]
pub struct Evaluation {
    pub valid: bool,
    /// Human-readable reasons when not valid.
    pub reasons: Vec<String>,
    pub overlaps: Vec<Overlap>,
    /// Smallest enclosing container found; None when there are no pieces, or with
    /// `stop_when_invalid` when not valid.
    pub container: Option<Container>,
    /// container.size, the score. Only meaningful as a record when valid.
    pub score: Option<f64>,
}

/// The `opts` of config.ts: evaluate.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EvaluateOptions {
    pub auto_orient: bool,
    /// None is the source's absent `maxOverlaps` (no limit).
    pub max_overlaps: Option<usize>,
    pub stop_when_invalid: bool,
}

impl EvaluateOptions {
    /// What POST /api/submit passes: `{ maxOverlaps, stopWhenInvalid: true }`.
    pub fn server(max_overlaps: usize) -> Self {
        EvaluateOptions { auto_orient: false, max_overlaps: Some(max_overlaps), stop_when_invalid: true }
    }
}

/// config.ts: evaluate. Validity and score of a configuration: the single scoring routine.
/// With `auto_orient` the container is computed at the given phi and at the auto-oriented phi,
/// and the smaller one is kept. With `max_overlaps`, at most that many overlapping pairs are found
/// and reported (the server's guard against slow, deliberately invalid submissions).
/// With `stop_when_invalid`, a configuration found invalid (wrong piece count, overlaps) returns
/// at once, with the same reasons and overlaps but no container or score. The server passes it:
/// its refusal carries the reasons only, and the container is the costly part for large hulls.
pub fn evaluate(config: &PackingConfig, opts: &EvaluateOptions) -> Evaluation {
    evaluate_parts(config.n, config.m, config.p, &config.pieces, config.container_phi, opts)
}

/// [`evaluate`] for a configuration held in parts (the search keeps its own `Config` type).
pub fn evaluate_parts(n: u32, m: u32, p: usize, pieces: &[Pose], container_phi: f64, opts: &EvaluateOptions) -> Evaluation {
    let mut reasons: Vec<String> = Vec::new();
    if pieces.len() != p {
        reasons.push(format!("expected exactly {p} pieces, got {}", pieces.len()));
    }
    let limit = opts.max_overlaps.unwrap_or(usize::MAX);
    let overlaps = find_overlaps(n, pieces, TOL, 1.0, limit);
    if !overlaps.is_empty() {
        // overlaps.reduce((a, b) => (b.sep < a.sep ? b : a)): the first of the deepest
        let mut worst = overlaps[0];
        for b in &overlaps[1..] {
            if b.sep < worst.sep {
                worst = *b;
            }
        }
        let count = if overlaps.len() >= limit { format!("at least {}", overlaps.len()) } else { format!("{}", overlaps.len()) };
        reasons.push(format!(
            "{count} overlapping pair(s); deepest found is pieces {} and {}, penetration {} (tolerance {})",
            worst.i,
            worst.j,
            fmt::exponential(-worst.sep, Some(3)),
            fmt::num(TOL)
        ));
    }
    if opts.stop_when_invalid && !reasons.is_empty() {
        return Evaluation { valid: false, reasons, overlaps, container: None, score: None };
    }
    let mut container: Option<Container> = None;
    if !pieces.is_empty() && opts.auto_orient && m != 0 {
        let set = extreme_points(n, pieces, 1.0);
        let mut c = enclose_set(&set, m, container_phi);
        let best = auto_orient_set(&set, m, container_phi);
        if best.size < c.size {
            c = best;
        }
        container = Some(c);
    } else if !pieces.is_empty() {
        // at one orientation the hull of all the vertices is rarely needed (see `enclose`)
        container = Some(enclose(n, pieces, m, container_phi));
    }
    Evaluation { valid: reasons.is_empty(), reasons, overlaps, score: container.map(|c| c.size), container }
}

/// config.ts: StrictResult.
#[derive(Clone, Debug, PartialEq)]
pub struct StrictResult {
    pub ok: bool,
    /// Container size certified by the shrink test: size / (1 - eps). (`certifiedSize` in JSON.)
    pub certified_size: f64,
    pub eps: f64,
    /// Absent from the JSON when None.
    pub reason: Option<String>,
}

/// The default `eps` of config.ts: strictVerify, which the server uses.
pub const STRICT_EPS: f64 = 1e-8;

/// config.ts: strictVerify. Stricter check for submissions that beat the literature (the shrink
/// test). Every piece is shrunk by (1 - eps) about its centre. The shrunk pieces must be strictly
/// separated (no tolerance) and must fit a container of the same shape and orientation that is
/// strictly smaller than the given one. Scaling the whole picture by 1 / (1 - eps) then gives
/// unit pieces in a container of size size / (1 - eps), which is the certified value.
pub fn strict_verify(n: u32, pieces: &[Pose], container: &Container, eps: f64) -> StrictResult {
    let scale = 1.0 - eps;
    let certified_size = container.size / scale;
    // tol = 0 would still accept exact contact; require a strictly positive gap
    // (-Number.MIN_VALUE: the smallest positive double, negated)
    let touching = find_overlaps(n, pieces, -f64::from_bits(1), scale, usize::MAX);
    if !touching.is_empty() {
        return StrictResult {
            ok: false,
            certified_size,
            eps,
            reason: Some(format!("{} pair(s) not strictly separated after shrinking", touching.len())),
        };
    }
    let shrunk = enclose_set(&extreme_points(n, pieces, scale), container.m, container.phi);
    if !(shrunk.size < container.size) {
        return StrictResult {
            ok: false,
            certified_size,
            eps,
            reason: Some("shrunk pieces do not fit strictly inside the container".to_string()),
        };
    }
    StrictResult { ok: true, certified_size, eps, reason: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_reports_the_sources_errors_in_its_order() {
        assert_eq!(parse_config(&json!(null)), Err(vec!["body must be a JSON object".to_string()]));
        assert_eq!(parse_config(&json!("x")), Err(vec!["body must be a JSON object".to_string()]));
        let all = vec![
            "N must be 0 (circle) or an integer from 3 to 100",
            "M must be 0 (circle) or an integer from 3 to 100",
            "P must be an integer from 1 to 500",
            "pieces must be an array",
        ];
        assert_eq!(parse_config(&json!([])), Err(all.iter().map(|s| s.to_string()).collect()));
        assert_eq!(parse_config(&json!({})), Err(all.iter().map(|s| s.to_string()).collect()));
        let body = json!({"N": 4, "M": 4, "P": 2, "pieces": [{"x": 0, "y": 0}, {"x": 1e7, "y": 0, "theta": 1}],
            "container_phi": null, "name": 3, "agent_note": []});
        assert_eq!(
            parse_config(&body),
            Err(vec![
                "pieces[1] is outside the coordinate limit of 1000000".to_string(),
                "container_phi must be a finite number".to_string(),
                "name must be a string".to_string(),
                "agent_note must be a string".to_string(),
            ])
        );
        let ok = parse_config(&json!({"N": 0.0, "M": 3, "P": 1.0, "pieces": [{"x": 1, "y": -2.5}], "name": "a"})).unwrap();
        assert_eq!((ok.n, ok.m, ok.p, ok.container_phi), (0, 3, 1, 0.0));
        assert_eq!(ok.pieces, vec![Pose::new(1.0, -2.5, 0.0)]);
        assert_eq!((ok.name.as_deref(), ok.agent_note), (Some("a"), None));
    }

    #[test]
    fn the_refusal_is_worded_as_the_source_words_it() {
        let config = PackingConfig {
            n: 4,
            m: 4,
            p: 3,
            pieces: vec![Pose::new(0.0, 0.0, 0.0), Pose::new(0.5, 0.0, 0.0)],
            container_phi: 0.0,
            name: None,
            agent_note: None,
        };
        let e = evaluate(&config, &EvaluateOptions::server(20));
        assert!(!e.valid && e.container.is_none() && e.score.is_none());
        assert_eq!(e.reasons[0], "expected exactly 3 pieces, got 2");
        assert!(e.reasons[1].starts_with("1 overlapping pair(s); deepest found is pieces 0 and 1, penetration "));
        assert!(e.reasons[1].ends_with(" (tolerance 1e-9)"));
    }
}
