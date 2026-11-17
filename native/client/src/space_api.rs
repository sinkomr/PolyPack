//! The sweep's side of the spaces API: reading a problem, deciding whether to submit and what to
//! send. Ports of apps/volunteer/src/spaces/read.ts (`readSpaceProblem`), submit.ts
//! (`decideSpaceSubmission`, `spaceSubmissionBody`, `checkSpaceStored`, `bestRef`) and of
//! search/model.ts (`buildSpaceKnown`, `checkSpaceConfig`). Pure functions of what the server said
//! and what the search found; the server's answers are untrusted input.

use crate::answers::{clean_text, stored_name, SiteBest};
use crate::http::SubmitCheck;
use crate::space_engine::{Candidate, Known};
use polypack_flat::validate::{improves_on, SCORE_TIE};
use polypack_spaces::{improves_space_best, parse_space_config, validate_space_submission, ParsedSpaceId, Parsed, SpaceName, SpaceValidateOptions};
use serde_json::{json, Value};

/// The longest `method` text of a space submission (apps/server SPACE_METHOD_LENGTH).
pub const SPACE_METHOD_LENGTH: usize = 80;

/// What the client uses of GET /api/spaces/:space/problems/<id>.
#[derive(Clone, Debug)]
pub struct SpaceProblemInfo {
    pub accepts_submissions: bool,
    pub closed_reason: Option<String>,
    pub best_score: Option<f64>,
    pub bound: Option<f64>,
    /// The research record's size and status.
    pub certified: Option<(f64, String)>,
    pub no_record: bool,
    pub site_best: Option<SiteBest>,
    pub certified_config: Option<Value>,
    pub site_config: Option<Value>,
}

fn positive(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite() && *x > 0.0)
}

/// A clean copy of a configuration of the problem's format, or None when it is malformed.
fn read_config(p: &ParsedSpaceId, v: &Value) -> Option<Value> {
    match parse_space_config(p, Some(v)) {
        Parsed::Ok { config, .. } => Some(config.to_value()),
        Parsed::Failed { .. } => None,
    }
}

/// The problem, cleaned. None when it is not this problem, or when what the decisions rest on
/// (whether it is open, its best score, the site's leader) is malformed.
pub fn read_space_problem(v: &Value, p: &ParsedSpaceId) -> Option<SpaceProblemInfo> {
    let o = v.as_object()?;
    if o.get("space")?.as_str()? != p.space.as_str() || o.get("id")?.as_str()? != p.id {
        return None;
    }
    let accepts = o.get("accepts_submissions")?.as_bool()?;
    let best_score = match o.get("best_score") {
        None | Some(Value::Null) => None,
        Some(b) => Some(positive(b)?),
    };
    let site_best = match o.get("site_best") {
        None | Some(Value::Null) => None,
        Some(b) => {
            let id = b.get("id")?.as_i64()?;
            let score = positive(b.get("score")?)?;
            Some(SiteBest { id, score, name: b.get("name").and_then(Value::as_str).unwrap_or("").to_string() })
        }
    };
    let certified = o.get("certified").and_then(|c| positive(c.get("score")?).map(|s| (s, clean_text(c.get("status").and_then(Value::as_str).unwrap_or(""), 20))));
    let bound = o.get("bound").and_then(|b| positive(b.get("value")?));
    let config = |key: &str| match o.get(key) {
        None | Some(Value::Null) => None,
        Some(c) => read_config(p, c),
    };
    Some(SpaceProblemInfo {
        accepts_submissions: accepts,
        closed_reason: o.get("closed_reason").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(|s| clean_text(s, 160)),
        best_score,
        bound,
        certified,
        no_record: o.get("status").and_then(Value::as_str) == Some("no_record"),
        site_best,
        certified_config: config("certified_config"),
        site_config: config("site_config"),
    })
}

/// The problem's best as the log shows it: the site's leader when it leads, else the research record.
#[derive(Clone, Debug, PartialEq)]
pub struct BestRef {
    pub id: Option<i64>,
    pub score: f64,
    /// "site" or "certified".
    pub source: &'static str,
    pub name: Option<String>,
}

pub fn best_ref(info: &SpaceProblemInfo) -> Option<BestRef> {
    let site = info.site_best.as_ref();
    let cert = info.certified.as_ref();
    if let Some(s) = site {
        if cert.map_or(true, |c| s.score <= c.0) {
            return Some(BestRef { id: Some(s.id), score: s.score, source: "site", name: Some(s.name.clone()) });
        }
    }
    cert.map(|c| BestRef { id: None, score: c.0, source: "certified", name: None })
}

/// The configuration to start from: the better of the research record's and the site leader's
/// (the record on a tie), when there is one.
pub fn build_known(info: &SpaceProblemInfo) -> Option<Known> {
    let cert = info.certified_config.as_ref().zip(info.certified.as_ref()).map(|(c, s)| (c.clone(), s.0));
    let site = info.site_config.as_ref().zip(info.site_best.as_ref()).map(|(c, s)| (c.clone(), s.score));
    if let Some((config, score)) = &site {
        if cert.as_ref().map_or(true, |c| *score < c.1) {
            return Some(Known { config: config.clone(), score: *score, source: "site" });
        }
    }
    cert.map(|(config, score)| Known { config, score, source: "certified" })
}

/// The server's rule for a configuration (its bound, the research record's size, no record).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rule {
    pub bound: Option<f64>,
    pub certified: Option<f64>,
    pub no_record: bool,
}

/// The client's check of a configuration: the server's own `validateSpaceSubmission`.
#[derive(Clone, Debug)]
pub struct SpaceCheck {
    pub valid: bool,
    /// The stated score, or None when the configuration is malformed.
    pub score: Option<f64>,
    pub reasons: Vec<String>,
}

pub fn check_space_config(space: SpaceName, id: &str, config: &Value, rule: &Rule) -> SpaceCheck {
    let v = validate_space_submission(space, id, config, &SpaceValidateOptions { bound: rule.bound, max_p: None, certified: rule.certified, no_record: rule.no_record });
    SpaceCheck { valid: v.valid, score: if v.malformed { None } else { v.score }, reasons: v.reasons.into_iter().take(5).collect() }
}

/// A job's configuration checked with the score its search claims: valid, and the server's score
/// equal to the claimed one (within the tie tolerance). Returns the server's score.
pub fn check_job_result(space: SpaceName, id: &str, config: &Value, claimed: f64, rule: &Rule) -> Result<f64, String> {
    let c = check_space_config(space, id, config, rule);
    if !c.valid {
        return Err(format!("not valid by the space's validator ({})", c.reasons.first().map_or("unchecked", |s| s.as_str())));
    }
    let Some(score) = c.score.filter(|s| s.is_finite() && *s > 0.0) else { return Err("the validator computes no score".into()) };
    if (score - claimed).abs() > SCORE_TIE * score.max(claimed) {
        return Err(format!("the validator's score {score} is not the search's {claimed}"));
    }
    Ok(score)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub submit: bool,
    pub reason: String,
}

pub struct DecideArgs<'a> {
    pub has_best: bool,
    pub check: Option<&'a SpaceCheck>,
    pub open: bool,
    pub best_score: Option<f64>,
    pub bound: Option<f64>,
    pub dry_run: bool,
    pub space: SpaceName,
    pub certified: Option<f64>,
    pub leader: Option<f64>,
}

/// Submit only a configuration that the space's own validator accepts at its stated size, to an
/// open problem, at or above the problem's lower bound, that improves on the problem's best by
/// more than the tie tolerance, and by the server's keep rule (the leader by the tie tolerance,
/// the research record by the space's record margin). In a dry run the same rule says what would
/// have been sent.
pub fn decide_space_submission(a: &DecideArgs) -> Decision {
    let no = |reason: String| Decision { submit: false, reason };
    if !a.has_best {
        return no("no valid configuration".into());
    }
    let (Some(check), true) = (a.check, true) else { return no("not valid by the space's validator (unchecked)".into()) };
    let Some(score) = check.score.filter(|_| check.valid) else {
        return no(format!("not valid by the space's validator ({})", check.reasons.first().map_or("unchecked", |s| s.as_str())));
    };
    if !a.open {
        return no("the problem is closed".into());
    }
    if a.bound.map_or(false, |b| score < b) {
        return no("below the problem's lower bound".into());
    }
    if a.best_score.map_or(false, |b| !improves_on(score, b)) {
        return no("not better than the problem's best".into());
    }
    if !improves_space_best(a.space, score, a.certified, a.leader) {
        return no("not below the research record by the space's margin".into());
    }
    if a.dry_run {
        return no("dry run: would submit".into());
    }
    Decision { submit: true, reason: "better than the problem's best".into() }
}

/// The body of POST /api/spaces/submit.
pub fn space_submission_body(space: &str, id: &str, c: &Candidate, name: &str, note: &str, software: &str) -> Value {
    let mut body = json!({
        "space": space,
        "id": id,
        "config": c.config,
        // as in the flat submissions: the server answers 426 to a problem with disks or balls without it
        "units": crate::volunteer::UNITS,
        "name": name,
    });
    if !note.is_empty() {
        body["agent_note"] = json!(note);
    }
    body["software"] = json!(software);
    body["method"] = json!(c.method.chars().take(SPACE_METHOD_LENGTH).collect::<String>());
    body["seed"] = json!(c.seed);
    body
}

/// What a re-read says after a POST without a clear answer.
pub fn check_space_stored(info: &SpaceProblemInfo, name: &str, score: f64) -> SubmitCheck {
    if !info.accepts_submissions {
        return SubmitCheck::Closed;
    }
    if let Some(b) = &info.site_best {
        if (b.score - score).abs() <= SCORE_TIE * b.score.max(score) && stored_name(&b.name) == stored_name(name) {
            return SubmitCheck::Ours { id: b.id, score: b.score };
        }
    }
    if let Some(best) = info.best_score {
        if !improves_on(score, best) {
            return SubmitCheck::Beaten { leader: best };
        }
    }
    SubmitCheck::Absent
}

/// The fields of a POST /api/spaces/submit answer that the client records.
#[derive(Clone, Debug, PartialEq)]
pub struct SpaceSubmitResponse {
    pub valid: bool,
    pub leader: bool,
    pub score: Option<f64>,
    pub best_score: Option<f64>,
    pub id: Option<i64>,
    pub beats_certified: bool,
    pub reasons: Vec<String>,
}

pub fn read_space_submit_response(v: &Value) -> Option<SpaceSubmitResponse> {
    let valid = v.get("valid")?.as_bool()?;
    Some(SpaceSubmitResponse {
        valid,
        leader: v.get("leader").and_then(Value::as_bool) == Some(true),
        score: v.get("score").and_then(positive),
        best_score: v.get("best_score").and_then(positive),
        id: v.get("id").and_then(Value::as_i64),
        beats_certified: v.get("beats_certified").and_then(Value::as_bool) == Some(true),
        reasons: v.get("reasons").and_then(Value::as_array).map_or(Vec::new(), |r| r.iter().take(5).map(|x| clean_text(x.as_str().unwrap_or(""), 200)).collect()),
    })
}

impl SpaceSubmitResponse {
    pub fn to_json(&self) -> Value {
        json!({ "valid": self.valid, "leader": self.leader, "score": self.score, "best_score": self.best_score, "id": self.id, "beats_certified": self.beats_certified, "reasons": self.reasons })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use polypack_spaces::parse_space_id;

    fn cand() -> Candidate {
        Candidate { config: json!({"rho": 1.0, "pieces": []}), score: 1.0, seed: 77, method: "sphere auto".into(), kind: "fresh", time_s: 3.0, evals: Some(10) }
    }

    fn check(valid: bool, score: Option<f64>) -> SpaceCheck {
        SpaceCheck { valid, score, reasons: vec!["pieces overlap".into()] }
    }

    fn args<'a>(c: &'a SpaceCheck) -> DecideArgs<'a> {
        DecideArgs { has_best: true, check: Some(c), open: true, best_score: None, bound: None, dry_run: false, space: SpaceName::Sphere, certified: None, leader: None }
    }

    #[test]
    fn decisions() {
        let ok = check(true, Some(2.0));
        assert_eq!(decide_space_submission(&args(&ok)), Decision { submit: true, reason: "better than the problem's best".into() });
        // a first entry on a problem with nothing yet; an improvement beyond the tie tolerance
        assert!(decide_space_submission(&DecideArgs { best_score: Some(2.1), leader: Some(2.1), ..args(&ok) }).submit);
        assert_eq!(decide_space_submission(&DecideArgs { best_score: Some(2.0), leader: Some(2.0), ..args(&ok) }).reason, "not better than the problem's best");
        assert_eq!(decide_space_submission(&DecideArgs { best_score: Some(2.0 * (1.0 + 1e-10)), ..args(&ok) }).reason, "not better than the problem's best");
        assert!(decide_space_submission(&DecideArgs { best_score: Some(2.0 * (1.0 + 1e-8)), ..args(&ok) }).submit);
        assert_eq!(decide_space_submission(&DecideArgs { open: false, ..args(&ok) }).reason, "the problem is closed");
        assert_eq!(decide_space_submission(&DecideArgs { bound: Some(2.5), ..args(&ok) }).reason, "below the problem's lower bound");
        assert_eq!(decide_space_submission(&DecideArgs { dry_run: true, ..args(&ok) }).reason, "dry run: would submit");
        assert_eq!(decide_space_submission(&DecideArgs { certified: Some(2.0), ..args(&ok) }).reason, "not below the research record by the space's margin");
        assert_eq!(decide_space_submission(&DecideArgs { has_best: false, ..args(&ok) }).reason, "no valid configuration");
        let bad = check(false, Some(2.0));
        assert_eq!(decide_space_submission(&args(&bad)).reason, "not valid by the space's validator (pieces overlap)");
        assert_eq!(decide_space_submission(&DecideArgs { check: None, ..args(&ok) }).reason, "not valid by the space's validator (unchecked)");
    }

    #[test]
    fn body_format() {
        let b = space_submission_body("sphere", "sphere/4/2", &cand(), "me", "", "polypack-native 0.1.0");
        assert_eq!(
            b,
            json!({"space": "sphere", "id": "sphere/4/2", "config": {"rho": 1.0, "pieces": []}, "units": "diameter", "name": "me", "software": "polypack-native 0.1.0", "method": "sphere auto", "seed": 77})
        );
        let keys: Vec<&String> = b.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["space", "id", "config", "units", "name", "software", "method", "seed"]);
        let b = space_submission_body("sphere", "sphere/4/2", &Candidate { method: "x".repeat(100), ..cand() }, "me", "a note", "s");
        assert_eq!(b["agent_note"], "a note");
        assert_eq!(b["method"].as_str().unwrap().len(), 80);
    }

    fn info(site: Option<(i64, f64, &str)>, cert: Option<f64>, open: bool) -> SpaceProblemInfo {
        let site_best = site.map(|(id, score, name)| SiteBest { id, score, name: name.into() });
        let certified = cert.map(|c| (c, "best_known".to_string()));
        let best_score = match (site.map(|s| s.1), cert) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        SpaceProblemInfo { accepts_submissions: open, closed_reason: None, best_score, bound: None, certified, no_record: cert.is_none(), site_best, certified_config: None, site_config: None }
    }

    #[test]
    fn stored_checks_and_best_ref() {
        let i = info(Some((5, 2.0, "Me")), None, true);
        assert_eq!(check_space_stored(&i, "Me", 2.0), SubmitCheck::Ours { id: 5, score: 2.0 });
        assert_eq!(check_space_stored(&i, "other", 2.0), SubmitCheck::Beaten { leader: 2.0 });
        assert_eq!(check_space_stored(&i, "other", 1.5), SubmitCheck::Absent);
        assert_eq!(check_space_stored(&info(None, None, true), "me", 1.0), SubmitCheck::Absent);
        assert_eq!(check_space_stored(&info(None, None, false), "me", 1.0), SubmitCheck::Closed);
        assert_eq!(best_ref(&info(Some((5, 2.0, "Me")), Some(2.5), true)).unwrap().source, "site");
        assert_eq!(best_ref(&info(Some((5, 3.0, "Me")), Some(2.5), true)).unwrap().source, "certified");
        assert!(best_ref(&info(None, None, true)).is_none());
    }

    #[test]
    fn reads_the_problem() {
        let p = parse_space_id(SpaceName::Sphere, "sphere/4/2").unwrap();
        let v = json!({"space": "sphere", "id": "sphere/4/2", "accepts_submissions": true, "best_score": 1.5, "status": "no_record",
            "bound": {"value": 1.2}, "certified": null, "site_best": {"id": 3, "score": 1.5, "name": "x"}, "site_config": {"rho": 1.5, "pieces": [{"q": [1, 0, 0, 0]}, {"q": [0, 1, 0, 0]}]}});
        let i = read_space_problem(&v, &p).unwrap();
        assert!(i.accepts_submissions && i.no_record);
        assert_eq!((i.best_score, i.bound), (Some(1.5), Some(1.2)));
        assert_eq!(i.site_best.as_ref().unwrap().name, "x");
        assert!(i.site_config.is_some() && i.certified_config.is_none());
        let k = build_known(&i).unwrap();
        assert_eq!((k.score, k.source), (1.5, "site"));
        // another problem's answer, a malformed best, a malformed configuration
        assert!(read_space_problem(&json!({"space": "sphere", "id": "sphere/4/3", "accepts_submissions": true, "best_score": null}), &p).is_none());
        assert!(read_space_problem(&json!({"space": "sphere", "id": "sphere/4/2", "accepts_submissions": true, "best_score": -1}), &p).is_none());
        let v = json!({"space": "sphere", "id": "sphere/4/2", "accepts_submissions": false, "best_score": null, "site_config": {"rho": 1}});
        let i = read_space_problem(&v, &p).unwrap();
        assert!(!i.accepts_submissions && i.site_config.is_none() && build_known(&i).is_none());
    }
}
