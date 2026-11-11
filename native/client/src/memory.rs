//! What the engine carries from one problem to the next (apps/volunteer/src/engine/memory.ts).
//! Per family of problems (see `family_key`): for each arm, the discounted number of problems it
//! ran on and the discounted sum of its credit (its share of all the reward of that problem's
//! jobs); for each method, its evaluation rate (evaluations per second times P). The credit sets
//! the arm's prior on the family's next problem and the order of its exploration round. The JSON
//! has the reference's shape, and anything malformed is dropped.

use serde_json::{json, Map, Value};

pub const MEMORY_VERSION: u64 = 1;
pub const MAX_FAMILIES: usize = 48;
pub const MAX_ARMS: usize = 32;
pub const MAX_RATES: usize = 16;
const MAX_PROBLEMS: f64 = 20.0;
const FAMILY_DECAY: f64 = 0.9;
const MAX_PRIOR_WEIGHT: f64 = 4.0;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ArmRecord {
    pub n: f64,
    pub r: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FamilyRecord {
    pub used: f64,
    /// In insertion order: the most recently updated last.
    pub arms: Vec<(String, ArmRecord)>,
    pub rates: Vec<(String, f64)>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Memory {
    pub used: f64,
    pub families: Vec<(String, FamilyRecord)>,
}

fn family_key_ok(k: &str) -> bool {
    let parts: Vec<&str> = k.split('/').collect();
    let shape = |s: &str| s == "c" || s == "9+" || matches!(s, "3" | "4" | "5" | "6" | "7" | "8");
    parts.len() == 3 && shape(parts[0]) && shape(parts[1]) && matches!(parts[2], "1" | "10" | "20" | "50" | "100" | "200" | "500")
}

fn arm_key_ok(k: &str) -> bool {
    let Some((start, name)) = k.split_once(':') else { return false };
    matches!(start, "fresh" | "warm" | "iterate")
        && !name.is_empty()
        && name.len() <= 32
        && name.chars().next().unwrap().is_ascii_lowercase()
        && name.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == '-')
}

fn method_key_ok(k: &str) -> bool {
    !k.is_empty() && k.len() <= 32 && k.chars().next().unwrap().is_ascii_lowercase() && k.chars().all(|c| c.is_ascii_lowercase() || c == '_')
}

fn count(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite() && *x >= 0.0)
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

impl Memory {
    pub fn empty() -> Self {
        Memory::default()
    }

    /// Memory from whatever was stored: anything unusable gives empty memory or is dropped.
    pub fn parse(value: &Value) -> Memory {
        let Some(o) = value.as_object() else { return Memory::empty() };
        if o.get("version").and_then(|v| v.as_u64()) != Some(MEMORY_VERSION) {
            return Memory::empty();
        }
        let Some(used) = o.get("used").and_then(count) else { return Memory::empty() };
        let Some(fams) = o.get("families").and_then(|v| v.as_object()) else { return Memory::empty() };
        let mut families = Vec::new();
        for (key, f) in fams.iter().take(4 * MAX_FAMILIES) {
            if !family_key_ok(key) {
                continue;
            }
            let Some(fo) = f.as_object() else { continue };
            let (Some(fused), Some(arms), Some(rates)) = (fo.get("used").and_then(count), fo.get("arms").and_then(|v| v.as_object()), fo.get("rates").and_then(|v| v.as_object())) else {
                continue;
            };
            let mut ar = Vec::new();
            for (k, a) in arms.iter().take(4 * MAX_ARMS) {
                if ar.len() >= MAX_ARMS {
                    break;
                }
                let (Some(n), Some(r)) = (a.get("n").and_then(count), a.get("r").and_then(count)) else { continue };
                if !arm_key_ok(k) {
                    continue;
                }
                let nn = n.min(MAX_PROBLEMS);
                ar.push((k.clone(), ArmRecord { n: nn, r: (if n > 0.0 { r * nn / n } else { 0.0 }).min(nn) }));
            }
            let mut rt = Vec::new();
            for (k, r) in rates.iter().take(4 * MAX_RATES) {
                if rt.len() >= MAX_RATES {
                    break;
                }
                if let Some(r) = count(r) {
                    if method_key_ok(k) && r > 0.0 {
                        rt.push((k.clone(), r));
                    }
                }
            }
            families.push((key.clone(), FamilyRecord { used: fused, arms: ar, rates: rt }));
        }
        Memory { used, families: newest(families) }
    }

    pub fn to_json(&self) -> Value {
        let mut fams = Map::new();
        for (k, f) in &self.families {
            let mut arms = Map::new();
            for (ak, a) in &f.arms {
                arms.insert(ak.clone(), json!({ "n": a.n, "r": a.r }));
            }
            let mut rates = Map::new();
            for (rk, r) in &f.rates {
                rates.insert(rk.clone(), json!(r));
            }
            fams.insert(k.clone(), json!({ "used": f.used, "arms": arms, "rates": rates }));
        }
        json!({ "version": MEMORY_VERSION, "used": self.used, "families": fams })
    }

    pub fn family(&self, key: &str) -> Option<&FamilyRecord> {
        self.families.iter().find(|(k, _)| k == key).map(|(_, f)| f)
    }

    /// A new memory with one problem's record added to its family.
    pub fn remember(&self, family: &str, arms_credit: &[(String, f64)], rates_measured: &[(String, f64)]) -> Memory {
        let used = self.used + 1.0;
        let old = self.family(family).cloned().unwrap_or_default();
        let mut arms = old.arms.clone();
        for (key, credit) in arms_credit {
            if !arm_key_ok(key) || !credit.is_finite() {
                continue;
            }
            let before = arms.iter().position(|(k, _)| k == key).map(|i| arms.remove(i).1).unwrap_or_default();
            let mut n = FAMILY_DECAY * before.n + 1.0;
            let mut r = FAMILY_DECAY * before.r + credit.clamp(0.0, 1.0);
            if n > MAX_PROBLEMS {
                r *= MAX_PROBLEMS / n;
                n = MAX_PROBLEMS;
            }
            arms.push((key.clone(), ArmRecord { n: round3(n), r: round3(r).min(round3(n)) }));
        }
        let mut rates = old.rates.clone();
        for (method, rate) in rates_measured {
            if !method_key_ok(method) || !(*rate > 0.0) || !rate.is_finite() {
                continue;
            }
            // geometric mean of the old and new rate: machines and their load vary
            let before = rates.iter().position(|(k, _)| k == method).map(|i| rates.remove(i).1);
            rates.push((method.clone(), round3(before.map_or(*rate, |b| (b * rate).sqrt()))));
        }
        // most recently updated entries last, so trimming keeps them
        if arms.len() > MAX_ARMS {
            arms.drain(..arms.len() - MAX_ARMS);
        }
        if rates.len() > MAX_RATES {
            rates.drain(..rates.len() - MAX_RATES);
        }
        let mut families: Vec<(String, FamilyRecord)> = self.families.iter().filter(|(k, _)| k != family).cloned().collect();
        families.push((family.to_string(), FamilyRecord { used, arms, rates }));
        Memory { used, families: newest(families) }
    }
}

/// The MAX_FAMILIES most recently used families, ties in their given order.
fn newest(mut families: Vec<(String, FamilyRecord)>) -> Vec<(String, FamilyRecord)> {
    let mut idx: Vec<usize> = (0..families.len()).collect();
    idx.sort_by(|&a, &b| families[b].1.used.partial_cmp(&families[a].1.used).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b)));
    idx.truncate(MAX_FAMILIES);
    let mut out = Vec::with_capacity(idx.len());
    let mut taken: Vec<Option<(String, FamilyRecord)>> = families.drain(..).map(Some).collect();
    for i in idx {
        out.push(taken[i].take().unwrap());
    }
    out
}

/// Mean credit of an arm on a family, or None without a record.
pub fn arm_credit(family: Option<&FamilyRecord>, key: &str) -> Option<f64> {
    let f = family?;
    let (_, a) = f.arms.iter().find(|(k, _)| k == key)?;
    if a.n > 0.0 {
        Some(a.r / a.n)
    } else {
        None
    }
}

/// Beta prior of an arm: Beta(1, 1) without a record; with one, the arm's mean credit relative to
/// the family's best arm, p, gives Beta(1 + w p / 2, 1 + w (1 - p / 2)), w growing with the
/// remembered problems up to 4.
pub fn arm_prior(family: Option<&FamilyRecord>, key: &str) -> (f64, f64) {
    let Some(credit) = arm_credit(family, key) else { return (1.0, 1.0) };
    let f = family.unwrap();
    let mut top = 0.0f64;
    for (k, _) in &f.arms {
        top = top.max(arm_credit(family, k).unwrap_or(0.0));
    }
    let p = if top > 0.0 { credit / top } else { 1.0 };
    let n = f.arms.iter().find(|(k, _)| k == key).map_or(0.0, |(_, a)| a.n);
    let weight = MAX_PRIOR_WEIGHT.min(n);
    (1.0 + weight * p / 2.0, 1.0 + weight * (1.0 - p / 2.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_remember() {
        let m = Memory::empty();
        let m = m.remember("4/4/10", &[("fresh:harden".into(), 0.6), ("iterate:asc".into(), 0.4)], &[("harden".into(), 1000.0)]);
        let j = m.to_json();
        let back = Memory::parse(&j);
        assert_eq!(back, m);
        let f = back.family("4/4/10");
        assert_eq!(arm_prior(f, "fresh:harden"), (1.5, 1.5));
        assert_eq!(arm_prior(f, "warm:asc"), (1.0, 1.0));
        assert_eq!(Memory::parse(&json!({"version": 2})), Memory::empty());
    }
}
