//! Which problem to search next (apps/volunteer/src/pick.ts): one drawn uniformly at random from
//! every problem this client may search, with or without a record. The flat problems: N and M a
//! circle (0) or 3 to 100 sides and P from 1 to 500, narrowed by --N, --M and --P (or, in target
//! mode, one of the holder's problems, target.rs). With --dimensions, also the problems of the
//! kinds named, narrowed by --P: each kind's problems are the product of its id's fields, its
//! domain as GET /api/spaces describes it (polypack_spaces::space_domain). A draw takes a kind in
//! proportion to the size of its product, then each field uniformly; a draw outside the kind's
//! domain, or on an id that cannot be a problem (curved's impossible ids), starts again.
//!
//! A problem this machine searched in the last week is drawn again at most RECENT_TRIES - 1 times
//! in a row; problems to skip (closed, unreadable, being searched by another slot) are never drawn.

use polypack_flat::rng::Rng;
use polypack_flat::shapes::Problem;
use polypack_spaces::{impossible_reason, parse_space_id, space_domain, SpaceName};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const RECENT_MS: i64 = 7 * 24 * 3600_000;
pub const RECENT_TRIES: usize = 20;
pub const DRAW_TRIES: usize = 1000;

pub fn shape_codes() -> Vec<u32> {
    std::iter::once(0).chain(3..=100).collect()
}

pub struct FlatKind {
    pub ns: Vec<u32>,
    pub ms: Vec<u32>,
    pub ps: Vec<usize>,
}

impl FlatKind {
    pub fn new(n: Option<&Vec<u32>>, m: Option<&Vec<u32>>, p: Option<&Vec<usize>>) -> Self {
        FlatKind {
            ns: n.cloned().unwrap_or_else(shape_codes),
            ms: m.cloned().unwrap_or_else(shape_codes),
            ps: p.cloned().unwrap_or_else(|| (1..=500).collect()),
        }
    }

    pub fn size(&self) -> usize {
        self.ns.len() * self.ms.len() * self.ps.len()
    }

    pub fn draw(&self, rng: &mut Rng) -> Option<Problem> {
        if self.size() == 0 {
            return None;
        }
        let n = self.ns[rng.below(self.ns.len())];
        let m = self.ms[rng.below(self.ms.len())];
        let p = self.ps[rng.below(self.ps.len())];
        Some(Problem::new(n, m, p))
    }
}

/// A drawn problem: a flat one, or one of a kind beyond Flat (a space) by its id.
#[derive(Clone, Debug, PartialEq)]
pub enum Drawn {
    Flat(Problem),
    Space { space: SpaceName, id: String },
}

impl Drawn {
    /// The key of a drawn problem in the history, the skips and the problems being searched.
    pub fn key(&self) -> String {
        match self {
            Drawn::Flat(p) => p.key(),
            Drawn::Space { id, .. } => id.clone(),
        }
    }
}

/// One field of a kind's ids: a list of values, a list of integers (sorted), or the integers from
/// min to max (pick.ts `KindField`).
#[derive(Clone, Debug, PartialEq)]
enum Values {
    List(Vec<String>),
    Ints(Vec<i64>),
    Range(i64, i64),
}

#[derive(Clone, Debug, PartialEq)]
struct Field {
    key: String,
    values: Values,
}

impl Field {
    fn size(&self) -> f64 {
        match &self.values {
            Values::List(v) => v.len() as f64,
            Values::Ints(v) => v.len() as f64,
            Values::Range(min, max) => (max - min + 1).max(0) as f64,
        }
    }

    /// One value, uniformly, as the id writes it.
    fn draw(&self, rng: &mut Rng) -> String {
        match &self.values {
            Values::List(v) => v[rng.below(v.len())].clone(),
            Values::Ints(v) => v[rng.below(v.len())].to_string(),
            Values::Range(min, max) => (min + rng.below((max - min + 1) as usize) as i64).to_string(),
        }
    }
}

/// The fields of a space's ids from its domain's info, with --P cutting the range of P to the
/// allowed values (pick.ts `spaceFields`).
fn space_fields(info: &Value, p: Option<&Vec<usize>>) -> Vec<Field> {
    let mut out = Vec::new();
    for f in info.get("fields").and_then(Value::as_array).into_iter().flatten() {
        let key = f.get("key").and_then(Value::as_str).unwrap_or("").to_string();
        let values = if let Some(v) = f.get("values").and_then(Value::as_array) {
            Values::List(v.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect())
        } else {
            let min = f.get("min").and_then(Value::as_f64).unwrap_or(0.0) as i64;
            let max = f.get("max").and_then(Value::as_f64).unwrap_or(-1.0) as i64;
            match (key.as_str(), p) {
                ("P", Some(ps)) => Values::Ints(ps.iter().map(|&x| x as i64).filter(|&x| x >= min && x <= max).collect()),
                _ => Values::Range(min, max),
            }
        };
        out.push(Field { key, values });
    }
    out
}

/// The fields of a domain whose fields depend on another (nD in nD: the shapes and the range of P
/// of each dimension), one group per value of the field they depend on (pick.ts
/// `dependentGroups`): (the key depended on, [(its value, the other fields then)]).
fn dependent_groups(info: &Value, fields: &[Field]) -> Option<(String, Vec<(String, Vec<Field>)>)> {
    let infos = info.get("fields")?.as_array()?;
    let on = infos.iter().find_map(|f| f.get("dependent")?.get("on")?.as_str())?.to_string();
    let Values::List(on_values) = &fields.iter().find(|f| f.key == on)?.values else { return None };
    let groups = on_values
        .iter()
        .map(|value| {
            let fs = fields
                .iter()
                .filter(|f| f.key != on)
                .map(|f| {
                    let dep = infos.iter().find(|x| x.get("key").and_then(Value::as_str) == Some(&f.key)).and_then(|x| x.get("dependent"));
                    let values = dep.and_then(|d| d.get("values")?.get(value)?.as_array());
                    let range = dep.and_then(|d| d.get("ranges")?.get(value)?.as_array()).and_then(|r| Some((r.first()?.as_f64()? as i64, r.get(1)?.as_f64()? as i64)));
                    if let Some(v) = values {
                        return Field { key: f.key.clone(), values: Values::List(v.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()) };
                    }
                    match (range, &f.values) {
                        (Some((lo, hi)), Values::Ints(ints)) => Field { key: f.key.clone(), values: Values::Ints(ints.iter().copied().filter(|&x| x >= lo && x <= hi).collect()) },
                        (Some((lo, hi)), Values::Range(min, max)) => Field { key: f.key.clone(), values: Values::Range(lo.max(*min), hi.min(*max)) },
                        _ => f.clone(),
                    }
                })
                .collect();
            (value.clone(), fs)
        })
        .collect();
    Some((on, groups))
}

/// domain.ts `splitJoined`: the parts of a joined field's value ("cubintet" into "cub" and "tet"),
/// split at a separator such that every part is a value of its field; None otherwise.
fn split_joined(info: &Value, join: &Value, value: &str) -> Option<Vec<(String, String)>> {
    let parts: Vec<&str> = join.get("parts")?.as_array()?.iter().filter_map(Value::as_str).collect();
    let separator = join.get("separator")?.as_str()?;
    if parts.len() != 2 || separator.is_empty() {
        return None;
    }
    let list = |k: &str| -> Option<Vec<String>> {
        let f = info.get("fields")?.as_array()?.iter().find(|f| f.get("key").and_then(Value::as_str) == Some(k))?;
        Some(f.get("values")?.as_array()?.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
    };
    let (a_list, b_list) = (list(parts[0])?, list(parts[1])?);
    let mut from = 1;
    while let Some(i) = value.get(from..).and_then(|rest| rest.find(separator)).map(|i| i + from) {
        let (a, b) = (&value[..i], &value[i + separator.len()..]);
        if a_list.iter().any(|x| x == a) && b_list.iter().any(|x| x == b) {
            return Some(vec![(parts[0].to_string(), a.to_string()), (parts[1].to_string(), b.to_string())]);
        }
        from = i + 1;
    }
    None
}

/// domain.ts `domainId` (with `withJoined`): the id of a choice of the domain's fields, from its
/// pattern ("balls/<code>/<P>"), joined fields written from their parts where the choice lacks them.
pub fn domain_id(info: &Value, chosen: &[(String, String)]) -> String {
    let mut all: Vec<(String, String)> = chosen.to_vec();
    let get = |all: &[(String, String)], k: &str| all.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    let joined: Vec<&Value> = info.get("joined").and_then(Value::as_array).map(|j| j.iter().collect()).unwrap_or_default();
    for j in &joined {
        let (Some(key), Some(parts), Some(sep)) = (j.get("key").and_then(Value::as_str), j.get("parts").and_then(Value::as_array), j.get("separator").and_then(Value::as_str)) else { continue };
        let values: Option<Vec<String>> = parts.iter().map(|k| k.as_str().and_then(|k| get(&all, k))).collect();
        if get(&all, key).is_none() {
            if let Some(v) = values {
                all.push((key.to_string(), v.join(sep)));
            }
        }
    }
    // a joined value (the code) is the truth: the parts of a parsed id may be names, not the menus' values
    for j in &joined {
        let Some(key) = j.get("key").and_then(Value::as_str) else { continue };
        if let Some(parts) = get(chosen, key).and_then(|v| split_joined(info, j, &v)) {
            for (k, v) in parts {
                all.retain(|(key, _)| key != &k);
                all.push((k, v));
            }
        }
    }
    let pattern = info.get("id").and_then(Value::as_str).unwrap_or("");
    let mut out = String::new();
    let mut rest = pattern;
    while let Some(open) = rest.find('<') {
        let Some(close) = rest[open..].find('>').map(|c| c + open) else { break };
        let key = &rest[open + 1..close];
        if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphabetic()) {
            out.push_str(&rest[..open]);
            out.push_str(&get(&all, key).unwrap_or_else(|| "undefined".into()));
        } else {
            out.push_str(&rest[..=close]);
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out
}

/// True when `id` is a problem of the space's domain that this client searches: not one the
/// domain says cannot exist (pick.ts `inSpace`).
fn in_space(space: SpaceName, id: &str) -> bool {
    let Ok(parsed) = parse_space_id(space, id) else { return false };
    let Some(domain) = space_domain(space) else { return true };
    domain.bound(&parsed).is_some() && impossible_reason(space, &parsed).is_none()
}

/// The problems of one kind beyond Flat, after --P (pick.ts `spaceKind`).
pub struct SpaceKind {
    pub space: SpaceName,
    info: Value,
    /// The fields, or the groups of fields by the value of the field the others depend on.
    fields: Vec<Field>,
    groups: Option<(String, Vec<(String, Vec<Field>, f64)>)>,
    pub size: f64,
}

impl SpaceKind {
    pub fn new(space: SpaceName, p: Option<&Vec<usize>>) -> SpaceKind {
        let info = space_domain(space).map(|d| d.info.clone()).unwrap_or(Value::Null);
        let fields = space_fields(&info, p);
        let groups = dependent_groups(&info, &fields)
            .map(|(on, gs)| (on, gs.into_iter().map(|(v, fs)| {
                let n = fs.iter().map(Field::size).product::<f64>();
                (v, fs, n)
            }).collect::<Vec<_>>()));
        let size = match &groups {
            Some((_, gs)) => gs.iter().map(|g| g.2).sum(),
            None if fields.is_empty() => 0.0,
            None => fields.iter().map(Field::size).product(),
        };
        SpaceKind { space, info, fields, groups, size }
    }

    /// A problem of the product, each field drawn uniformly (a value of the field the others depend
    /// on in proportion to its problems); None when it falls outside the domain.
    pub fn draw(&self, rng: &mut Rng) -> Option<Drawn> {
        let mut chosen: Vec<(String, String)> = Vec::new();
        match &self.groups {
            Some((on, gs)) => {
                let mut r = rng.next() * self.size;
                let mut at = gs.len() - 1;
                for (i, g) in gs.iter().enumerate() {
                    if r < g.2 {
                        at = i;
                        break;
                    }
                    r -= g.2;
                }
                let (value, fs, _) = &gs[at];
                chosen.push((on.clone(), value.clone()));
                for f in fs {
                    chosen.push((f.key.clone(), f.draw(rng)));
                }
            }
            None => {
                for f in &self.fields {
                    chosen.push((f.key.clone(), f.draw(rng)));
                }
            }
        }
        let id = domain_id(&self.info, &chosen);
        in_space(self.space, &id).then(|| Drawn::Space { space: self.space, id })
    }
}

/// One kind of problem a draw covers: the flat problems, or those of a space.
pub enum Kind {
    Flat(FlatKind),
    Space(SpaceKind),
}

impl Kind {
    pub fn name(&self) -> &'static str {
        match self {
            Kind::Flat(_) => "flat",
            Kind::Space(k) => k.space.as_str(),
        }
    }

    /// The size of the product of its fields, after the filters: what the kind is drawn in proportion to.
    pub fn size(&self) -> f64 {
        match self {
            Kind::Flat(k) => k.size() as f64,
            Kind::Space(k) => k.size,
        }
    }

    fn draw(&self, rng: &mut Rng) -> Option<Drawn> {
        match self {
            Kind::Flat(k) => k.draw(rng).map(Drawn::Flat),
            Kind::Space(k) => k.draw(rng),
        }
    }
}

/// The kinds a client draws from: flat unless --only-dimensions, and the kinds of --dimensions;
/// those left empty dropped (pick.ts `kindsFor`).
pub fn kinds_for(o: &crate::options::Options) -> Vec<Kind> {
    let mut kinds = Vec::new();
    if !o.only_dimensions {
        kinds.push(Kind::Flat(FlatKind::new(o.n.as_ref(), o.m.as_ref(), o.p.as_ref())));
    }
    for &space in o.dimensions.iter().flatten() {
        kinds.push(Kind::Space(SpaceKind::new(space, o.p.as_ref())));
    }
    kinds.retain(|k| k.size() > 0.0);
    kinds
}

/// One problem of the kinds, every problem equally likely; None when no draw of DRAW_TRIES falls
/// in a domain (pick.ts `drawOnce`).
pub fn draw_once(kinds: &[Kind], rng: &mut Rng) -> Option<Drawn> {
    let total: f64 = kinds.iter().map(Kind::size).sum();
    if !(total > 0.0) {
        return None;
    }
    for _ in 0..DRAW_TRIES {
        let mut r = rng.next() * total;
        let mut kind = kinds.last()?;
        for k in kinds {
            if r < k.size() {
                kind = k;
                break;
            }
            r -= k.size();
        }
        if let Some(d) = kind.draw(rng) {
            return Some(d);
        }
    }
    None
}

/// Records one finished search (not one cut short by a signal or --hours). A dry run's search
/// counts for later dry runs only: a real run must still search the problem and submit.
pub fn note_search(recent: &mut HashMap<String, i64>, line: &Value, dry_run: bool) {
    let stopped = line.get("stopped").and_then(|s| s.as_str()).unwrap_or("");
    if matches!(stopped, "aborted" | "interrupted" | "crashed") {
        return;
    }
    let was_dry = line.get("dry_run").and_then(|d| d.as_bool()) == Some(true) || line.get("decision").and_then(|d| d.as_str()) == Some("dry run: would submit");
    if !dry_run && was_dry {
        return;
    }
    let Some(time) = line.get("time").and_then(|t| t.as_str()).and_then(crate::format::parse_iso) else { return };
    // a space problem's line names its space and id, which is its key
    let key = if let (Some(_), Some(id)) = (line.get("space").and_then(|x| x.as_str()), line.get("id").and_then(|x| x.as_str())) {
        id.to_string()
    } else {
        let (Some(n), Some(m), Some(p)) = (line.get("N").and_then(|x| x.as_u64()), line.get("M").and_then(|x| x.as_u64()), line.get("P").and_then(|x| x.as_u64())) else {
            return;
        };
        format!("{n}-{m}-{p}")
    };
    let e = recent.entry(key).or_insert(time);
    if *e < time {
        *e = time;
    }
}

pub fn prune_recent(recent: &mut HashMap<String, i64>, now: i64) {
    recent.retain(|_, t| now - *t < RECENT_MS);
}

/// The next problem: a uniform draw (of `draw`: the kinds', or the target list's) not in `skip`,
/// and not searched here within a week unless RECENT_TRIES draws in a row were. None when
/// DRAW_TRIES draws found only problems to skip, or there is nothing to draw.
pub fn draw_problem(draw: &dyn Fn(&mut Rng) -> Option<Drawn>, recent: &HashMap<String, i64>, skip: &HashSet<String>, now: i64, rng: &mut Rng) -> Option<Drawn> {
    let mut recent_in_a_row = 0;
    for _ in 0..DRAW_TRIES {
        let d = draw(rng)?;
        let key = d.key();
        if skip.contains(&key) {
            continue;
        }
        if recent.get(&key).map_or(false, |t| now - t < RECENT_MS) {
            recent_in_a_row += 1;
            if recent_in_a_row < RECENT_TRIES {
                continue;
            }
        }
        return Some(d);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_within_filters() {
        let kind = FlatKind::new(Some(&vec![4]), Some(&vec![0, 4]), Some(&(1..=10).collect()));
        assert_eq!(kind.size(), 20);
        let draw = |r: &mut Rng| kind.draw(r).map(Drawn::Flat);
        let mut rng = Rng::new(3);
        let recent = HashMap::new();
        let mut skip = HashSet::new();
        for _ in 0..200 {
            let Some(Drawn::Flat(p)) = draw_problem(&draw, &recent, &skip, 0, &mut rng) else { panic!() };
            assert!(p.n == 4 && (p.m == 0 || p.m == 4) && (1..=10).contains(&p.p));
        }
        for m in [0, 4] {
            for p in 1..=10 {
                skip.insert(format!("4-{m}-{p}"));
            }
        }
        assert!(draw_problem(&draw, &recent, &skip, 0, &mut rng).is_none());
    }

    // Every kind's draws are problems of its domain, the kinds' sizes are their products (the
    // dependent fields of ndim summed by dimension), and --P narrows them.
    #[test]
    fn draws_of_every_kind_are_problems_of_its_domain() {
        let mut rng = Rng::new(11);
        for space in polypack_spaces::SPACE_NAMES {
            let kind = SpaceKind::new(space, None);
            assert!(kind.size > 0.0, "{}", space.as_str());
            let domain = space_domain(space).unwrap();
            for _ in 0..300 {
                if let Some(Drawn::Space { space: s, id }) = kind.draw(&mut rng) {
                    assert_eq!(s, space);
                    let parsed = parse_space_id(space, &id).unwrap_or_else(|e| panic!("{id}: {e}"));
                    assert!(domain.bound(&parsed).is_some(), "{id}");
                }
            }
            // a kind of a product that holds only problems has as many as its domain says
            if space != SpaceName::Curved {
                assert_eq!(kind.size, domain.problems(), "{}", space.as_str());
            }
        }
        // curved: the whole product, of which the impossible ids are drawn again
        assert_eq!(SpaceKind::new(SpaceName::Curved, None).size, 83_655_000.0);
        let small = SpaceKind::new(SpaceName::Torus, Some(&vec![2, 3]));
        for _ in 0..100 {
            let Some(Drawn::Space { id, .. }) = small.draw(&mut rng) else { continue };
            assert!(id.ends_with("/2") || id.ends_with("/3"), "{id}");
        }
    }

    #[test]
    fn kinds_and_the_draw_across_them() {
        let o = |dims: Option<Vec<SpaceName>>, only: bool| crate::options::Options {
            dimensions: dims,
            only_dimensions: only,
            p: Some((1..=5).collect()),
            ..match crate::options::parse_options(&[], &crate::options::Machine { available_parallelism: 8, home: "/h".into() }).unwrap() {
                crate::options::Parsed::Run(o) => o,
                _ => panic!(),
            }
        };
        assert_eq!(kinds_for(&o(None, false)).iter().map(Kind::name).collect::<Vec<_>>(), vec!["flat"]);
        let both = kinds_for(&o(Some(vec![SpaceName::Sphere, SpaceName::Torus]), false));
        assert_eq!(both.iter().map(Kind::name).collect::<Vec<_>>(), vec!["flat", "sphere", "torus"]);
        let only = kinds_for(&o(Some(vec![SpaceName::Sphere]), true));
        assert_eq!(only.iter().map(Kind::name).collect::<Vec<_>>(), vec!["sphere"]);
        // every problem as likely as any other: the flat share of draws is the flat share of problems
        let mut rng = Rng::new(5);
        let total: f64 = both.iter().map(Kind::size).sum();
        let flat_share = both[0].size() / total;
        let n = 20_000;
        let flat = (0..n).filter(|_| matches!(draw_once(&both, &mut rng), Some(Drawn::Flat(_)))).count() as f64 / n as f64;
        assert!((flat - flat_share).abs() < 0.02, "{flat} vs {flat_share}");
    }

    #[test]
    fn domain_ids_write_joined_fields_from_their_parts() {
        let info = serde_json::json!({
            "id": "polyhedra/<code>/<P>",
            "fields": [{ "key": "piece", "values": ["cub", "tet"] }, { "key": "container", "values": ["cub", "tet"] }, { "key": "P", "min": 2, "max": 9 }],
            "joined": [{ "key": "code", "parts": ["piece", "container"], "separator": "in" }],
        });
        let chosen = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(domain_id(&info, &chosen(&[("piece", "tet"), ("container", "cub"), ("P", "4")])), "polyhedra/tetincub/4");
        // a joined value given whole is the truth
        assert_eq!(domain_id(&info, &chosen(&[("code", "cubintet"), ("P", "2")])), "polyhedra/cubintet/2");
        assert_eq!(split_joined(&info, &info["joined"][0], "cubintet"), Some(vec![("piece".into(), "cub".into()), ("container".into(), "tet".into())]));
        assert_eq!(split_joined(&info, &info["joined"][0], "cubinx"), None);
    }
}
