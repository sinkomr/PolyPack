//! Reading the server's answers (apps/volunteer/src/validate.ts). They are untrusted input: a
//! value the client uses must have the right type and be finite, and pieces must be P poses of
//! finite numbers. Text shown to the user is stripped of control characters and escapes first.

use polypack_flat::shapes::Pose;
use serde_json::Value;

/// The leader of a problem as GET /api/problems answers it.
#[derive(Clone, Debug, PartialEq)]
pub struct SiteBest {
    pub id: i64,
    pub score: f64,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Literature {
    pub value: f64,
    pub pieces: Option<Vec<Pose>>,
    pub container_phi: f64,
}

/// GET /api/problems/{N}/{M}/{P}, cleaned.
#[derive(Clone, Debug, PartialEq)]
pub struct ProblemInfo {
    pub area_bound: f64,
    pub literature: Option<Literature>,
    pub site_best: Option<SiteBest>,
    pub accepts_submissions: bool,
}

/// Text from the server, safe to print on a terminal: one line of at most `max` characters.
pub fn clean_text(v: &str, max: usize) -> String {
    let mut out = String::new();
    let mut chars = v.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // drop an escape sequence: ESC [ ... final byte, ESC ] ... BEL/ST, or ESC + one char
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(&d) = chars.peek() {
                        chars.next();
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(d) = chars.next() {
                        if d == '\u{7}' || d == '\u{1b}' {
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        let control = (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) || ('\u{200b}'..='\u{200f}').contains(&c) || ('\u{202a}'..='\u{202e}').contains(&c) || ('\u{2066}'..='\u{2069}').contains(&c);
        out.push(if control { ' ' } else { c });
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > max {
        let mut s: String = collapsed.chars().take(max.saturating_sub(1)).collect();
        s.push('…');
        s
    } else {
        collapsed
    }
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

fn positive(v: &Value) -> Option<f64> {
    finite(v).filter(|x| *x > 0.0)
}

/// P poses of finite numbers; a missing theta is 0, as the server reads it.
pub fn read_pieces(v: &Value, p: usize) -> Option<Vec<Pose>> {
    let arr = v.as_array()?;
    if arr.len() != p {
        return None;
    }
    let mut out = Vec::with_capacity(p);
    for q in arr {
        let o = q.as_object()?;
        let theta = match o.get("theta") {
            None => 0.0,
            Some(t) => finite(t)?,
        };
        out.push(Pose::new(finite(o.get("x")?)?, finite(o.get("y")?)?, theta));
    }
    Some(out)
}

/// None when the answer is not this problem's, or when what the decisions rest on (open, area
/// bound, the leader) is malformed; a malformed published value or coordinates only drop those.
pub fn read_problem_info(v: &Value, n: u32, m: u32, p: usize) -> Option<ProblemInfo> {
    let o = v.as_object()?;
    if o.get("N")?.as_u64()? != n as u64 || o.get("M")?.as_u64()? != m as u64 || o.get("P")?.as_u64()? != p as u64 {
        return None;
    }
    let accepts = o.get("accepts_submissions")?.as_bool()?;
    let area_bound = finite(o.get("area_bound")?)?;
    let site_best = match o.get("site_best") {
        None | Some(Value::Null) => None,
        Some(b) => {
            let id = b.get("id")?.as_i64()?;
            let score = positive(b.get("score")?)?;
            let name = b.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            Some(SiteBest { id, score, name })
        }
    };
    let literature = o.get("literature").and_then(|lit| {
        let value = positive(lit.get("value")?)?;
        let pieces = lit.get("pieces").and_then(|x| read_pieces(x, p));
        let container_phi = lit.get("container_phi").and_then(finite).unwrap_or(0.0);
        Some(Literature { value, pieces, container_phi })
    });
    Some(ProblemInfo { area_bound, literature, site_best, accepts_submissions: accepts })
}

/// GET /api/submissions/{id}: the stored packing.
pub fn read_stored_entry(v: &Value, p: usize) -> Option<(f64, Vec<Pose>, f64)> {
    let score = positive(v.get("score")?)?;
    let pieces = read_pieces(v.get("pieces")?, p)?;
    let phi = match v.get("container_phi") {
        None | Some(Value::Null) => 0.0,
        Some(x) => finite(x)?,
    };
    Some((score, pieces, phi))
}

/// The fields of a POST /api/submit answer the client records.
#[derive(Clone, Debug, PartialEq)]
pub struct SubmitResponse {
    pub valid: bool,
    pub leader: bool,
    pub score: Option<f64>,
    pub leader_score: Option<f64>,
    pub id: Option<i64>,
    pub pending_verification: bool,
    pub reasons: Vec<String>,
}

pub fn read_submit_response(v: &Value) -> Option<SubmitResponse> {
    let valid = v.get("valid")?.as_bool()?;
    Some(SubmitResponse {
        valid,
        leader: v.get("leader").and_then(|x| x.as_bool()) == Some(true),
        score: v.get("score").and_then(positive),
        leader_score: v.get("leader_score").and_then(positive),
        id: v.get("id").and_then(|x| x.as_i64()),
        pending_verification: v.get("pending_verification").and_then(|x| x.as_bool()) == Some(true),
        reasons: v.get("reasons").and_then(|r| r.as_array()).map_or(Vec::new(), |r| r.iter().take(5).map(|x| clean_text(&x.as_str().map(|s| s.to_string()).unwrap_or_else(|| x.to_string()), 200)).collect()),
    })
}

impl SubmitResponse {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "valid": self.valid,
            "leader": self.leader,
            "score": self.score,
            "leader_score": self.leader_score,
            "id": self.id,
            "pending_verification": self.pending_verification,
            "reasons": self.reasons,
        })
    }
}

/// "HTTP 422: overlap of pieces 3 and 7" or "no answer", safe to print.
pub fn describe_answer(a: Option<&crate::http::Answer>) -> String {
    let Some(a) = a else { return "no answer from the server".into() };
    let why = if let Some(r) = a.body.get("reasons").and_then(|r| r.as_array()) {
        r.iter().take(5).map(|x| clean_text(x.as_str().unwrap_or(""), 200)).collect::<Vec<_>>().join("; ")
    } else if let Some(e) = a.body.get("error").and_then(|e| e.as_str()) {
        clean_text(e, 200)
    } else if let Some(s) = a.body.as_str() {
        clean_text(s, 200)
    } else {
        String::new()
    };
    if why.is_empty() {
        format!("HTTP {}", a.status)
    } else {
        format!("HTTP {}: {why}", a.status)
    }
}

/// A display name as the server stores it (apps/server/src/limits.ts sanitizeText).
pub fn stored_name(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| {
            let u = c as u32;
            if u < 0x20 || (0x7f..=0x9f).contains(&u) || ('\u{200b}'..='\u{200f}').contains(&c) || ('\u{202a}'..='\u{202e}').contains(&c) || ('\u{2066}'..='\u{2069}').contains(&c) || c == '<' || c == '>' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(40).collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_and_cleans() {
        assert_eq!(clean_text("a\u{1b}[31mred\u{1b}[0m  b\n", 50), "ared b");
        assert_eq!(clean_text("abcdef", 4), "abc…");
        let v = json!({"N": 4, "M": 4, "P": 2, "accepts_submissions": true, "area_bound": 1.4, "site_best": {"id": 5, "score": 2.0, "name": "x"}, "literature": {"value": 2.0, "pieces": [{"x": 0, "y": 0}]}});
        let info = read_problem_info(&v, 4, 4, 2).unwrap();
        assert_eq!(info.site_best.unwrap().id, 5);
        assert!(info.literature.unwrap().pieces.is_none());
        assert!(read_problem_info(&v, 4, 4, 3).is_none());
        assert_eq!(stored_name("  a <b>\tc "), "a b c");
    }
}
