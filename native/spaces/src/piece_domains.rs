//! Range domains for curved, whole-sphere and flat-torus pieces. Research records are independent.
//! Port of packages/spaces/src/piece-domains.ts.

use crate::domain::{DomainMenu, SpaceDomain};
use crate::ids::{format_curvature, ParsedSpaceId, TORUS_FAMILIES};
use crate::types::Bound;
use polypack_curved::{curved_bound_of, curved_max_p, curved_why_not, piece_exists, CURVED_MAX_P};
use polypack_flat::shapes::MAX_SIDES;
use polypack_js::fmt;
use polypack_sphere::area_bound;
use polypack_torus::{area_score_bound, TorusFamily, TORUS_DISK_RADIUS, TORUS_MAX_P};
use serde_json::{Map, Value};
use std::sync::LazyLock;

/// piece-domains.ts: `PIECE_NS`. Disks, then 3 to 100 sides.
pub static PIECE_NS: LazyLock<Vec<f64>> = LazyLock::new(|| std::iter::once(0.0).chain((0..98).map(|i| (i + 3) as f64)).collect());

/// piece-domains.ts: `CURVED_MENU_KS`. The curvatures of the board's menu: the published sweep's
/// +-1 and +-1e-6, 0.5 to 0.0001 of both signs.
pub const CURVED_MENU_KS: [f64; 16] = [-1.0, -0.5, -0.25, -0.1, -0.01, -0.001, -0.0001, -1e-6, 1e-6, 0.0001, 0.001, 0.01, 0.1, 0.25, 0.5, 1.0];

/// piece-domains.ts: `CURVED_MENU_K_IDS`. The menu's curvatures as ids write them (formatCurvature).
pub static CURVED_MENU_K_IDS: LazyLock<Vec<String>> = LazyLock::new(|| CURVED_MENU_KS.iter().map(|&k| k_id(k)).collect());

/// piece-domains.ts: `CURVED_TILING_KS`. The six curvatures of the {3,q} tilings (q = 5, 7, 8, 9,
/// 10, 12): in the domain with their records, API problems and entries, but not in the board's menu.
pub const CURVED_TILING_KS: [f64; 6] =
    [-6.519717439579256, -4.50521902808615, -3.4413111779836725, -2.3365290558829845, -1.1892985685754194, 1.225778283313099];

/// piece-domains.ts: `CURVED_KS`. All 22 curvatures of the curved domain, in numeric order.
pub static CURVED_KS: LazyLock<Vec<f64>> = LazyLock::new(|| {
    let mut ks: Vec<f64> = CURVED_MENU_KS.iter().chain(CURVED_TILING_KS.iter()).copied().collect();
    // `.sort((a, b) => a - b)` of finite numbers
    ks.sort_by(|a, b| a.partial_cmp(b).expect("finite curvatures"));
    ks
});

/// piece-domains.ts: `CURVED_MS`. Containers: disks and every regular M-gon the geometry package allows.
pub static CURVED_MS: LazyLock<Vec<f64>> = LazyLock::new(|| std::iter::once(0.0).chain((0..MAX_SIDES - 2).map(|i| (i + 3) as f64)).collect());

fn k_id(k: f64) -> String {
    format_curvature(k).expect("a finite curvature")
}

fn strings(list: &[f64]) -> Value {
    Value::Array(list.iter().map(|&x| Value::String(fmt::num(x))).collect())
}

fn number(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// An object from a list of pairs as JavaScript lists its properties (and so as `JSON.stringify`
/// writes them): the keys that are array indices ("0", "1", "100") first, in ascending order, then
/// the others in the order they were added. A later pair with the same key replaces the value.
pub(crate) fn js_object(entries: Vec<(String, Value)>) -> Value {
    // a canonical array index: digits without a leading zero, below 2^32 - 1
    let index = |k: &str| -> Option<u32> {
        let canonical = k == "0" || (!k.is_empty() && !k.starts_with('0') && k.bytes().all(|c| c.is_ascii_digit()));
        if canonical {
            k.parse::<u32>().ok().filter(|&v| v != u32::MAX)
        } else {
            None
        }
    };
    let mut unique: Vec<(String, Value)> = Vec::new();
    for (k, v) in entries {
        match unique.iter_mut().find(|(key, _)| *key == k) {
            Some(slot) => slot.1 = v,
            None => unique.push((k, v)),
        }
    }
    let mut indexed: Vec<(u32, (String, Value))> = Vec::new();
    let mut named: Vec<(String, Value)> = Vec::new();
    for (k, v) in unique {
        match index(&k) {
            Some(i) => indexed.push((i, (k, v))),
            None => named.push((k, v)),
        }
    }
    indexed.sort_by_key(|(i, _)| *i);
    let mut out = Map::new();
    for (k, v) in indexed.into_iter().map(|(_, kv)| kv).chain(named) {
        out.insert(k, v);
    }
    Value::Object(out)
}

/// An object written key by key in the order given (keys that are no array indices).
fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut out = Map::new();
    for (k, v) in entries {
        out.insert(k.to_string(), v);
    }
    Value::Object(out)
}

/// piece-domains.ts: `pieces`, the field N of the three domains.
fn pieces() -> Vec<(&'static str, Value)> {
    vec![
        ("key", Value::String("N".into())),
        ("label", Value::String("Piece (N)".into())),
        ("values", strings(&PIECE_NS)),
        (
            "titles",
            js_object(
                PIECE_NS
                    .iter()
                    .map(|&n| (fmt::num(n), Value::String(if n == 0.0 { "Disk (N = 0)".to_string() } else { format!("{}-gon", fmt::num(n)) })))
                    .collect(),
            ),
        ),
    ]
}

/// piece-domains.ts: `count`, `curvedCount`, `torusCount`: the field P, 1 to `max`.
fn count(max: f64) -> Value {
    object(vec![("key", Value::String("P".into())), ("label", Value::String("Pieces (P)".into())), ("min", number(1.0)), ("max", number(max))])
}

/// piece-domains.ts: `shape`. A number that is one of PIECE_NS.
fn shape(n: Option<f64>) -> Option<f64> {
    n.filter(|n| PIECE_NS.contains(n))
}

/// piece-domains.ts: `countOK`.
fn count_ok(p: f64) -> bool {
    p == p.trunc() && (1.0..=100.0).contains(&p)
}

/// piece-domains.ts: `sample`.
fn sample(prefixes: &[String], limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // New shapes first, so that the bounded work list (removed 2026-10-29) offered problems without records.
    let first = [7.0, 12.0, 20.0, 100.0];
    let order: Vec<f64> = first.iter().copied().chain(PIECE_NS.iter().copied().filter(|n| !first.contains(n))).collect();
    for p in 2..=100 {
        for &n in &order {
            for prefix in prefixes {
                if out.len() >= limit {
                    return out;
                }
                // `prefix.replace("<N>", String(N))`: the first place
                out.push(format!("{}/{p}", prefix.replacen("<N>", &fmt::num(n), 1)));
            }
        }
    }
    out
}

fn sphere_bound(id: &ParsedSpaceId) -> Option<Option<Bound>> {
    let n = shape(id.fields.get("N").and_then(|f| f.as_number()))?;
    let p = id.p as f64;
    if !count_ok(p) {
        return None;
    }
    Some(Some(Bound { value: area_bound(n, p) * (1.0 - 1e-12), label: "area / existence bound; [CALC]".to_string() }))
}

fn sphere_sample(limit: usize) -> Vec<String> {
    sample(&["sphere/<N>".to_string()], limit)
}

/// piece-domains.ts: `sphereDomain`.
pub(crate) fn sphere_domain() -> SpaceDomain {
    SpaceDomain {
        info: object(vec![
            ("id", Value::String("sphere/<N>/<P>".into())),
            ("fields", Value::Array(vec![object(pieces()), count(100.0)])),
            ("problems", number(PIECE_NS.len() as f64 * 100.0)),
        ]),
        bound: sphere_bound,
        sample: sphere_sample,
        menu: None,
        impossible: None,
    }
}

fn torus_family(name: &str) -> Option<TorusFamily> {
    match name {
        "sq" => Some(TorusFamily::Sq),
        "hex" => Some(TorusFamily::Hex),
        "free" => Some(TorusFamily::Free),
        _ => None,
    }
}

fn torus_bound(id: &ParsedSpaceId) -> Option<Option<Bound>> {
    let family = torus_family(id.fields.get("family").and_then(|f| f.as_text())?)?;
    let n = shape(id.fields.get("N").and_then(|f| f.as_number()))?;
    let p = id.p as f64;
    if p != p.trunc() || p < 1.0 || p > TORUS_MAX_P as f64 {
        return None;
    }
    Some(Some(Bound { value: area_score_bound(family, n, p, 1.0, TORUS_DISK_RADIUS) * (1.0 - 1e-12), label: "area bound; [CALC]".to_string() }))
}

fn torus_sample(limit: usize) -> Vec<String> {
    let prefixes: Vec<String> = TORUS_FAMILIES.iter().map(|f| format!("torus/{f}/<N>")).collect();
    sample(&prefixes, limit)
}

/// piece-domains.ts: `torusDomain`. Torus pieces run to TORUS_MAX_P = 500; the others stop at 100.
pub(crate) fn torus_domain() -> SpaceDomain {
    SpaceDomain {
        info: object(vec![
            ("id", Value::String("torus/<family>/<N>/<P>".into())),
            (
                "fields",
                Value::Array(vec![
                    object(vec![
                        ("key", Value::String("family".into())),
                        ("label", Value::String("Torus".into())),
                        ("values", Value::Array(TORUS_FAMILIES.iter().map(|f| Value::String(f.to_string())).collect())),
                    ]),
                    object(pieces()),
                    count(TORUS_MAX_P as f64),
                ]),
            ),
            ("problems", number((TORUS_FAMILIES.len() * PIECE_NS.len() * TORUS_MAX_P) as f64)),
        ]),
        bound: torus_bound,
        sample: torus_sample,
        menu: None,
        impossible: None,
    }
}

/// piece-domains.ts: `CURVED_PROBLEMS`. How many curved problems can exist [CALC, the source's]:
/// `count_curved_problems()` below, which takes long enough that the server (which reads the count
/// as it starts) keeps this value; a test checks that the two agree.
pub const CURVED_PROBLEMS: f64 = 26_830_100.0;

/// piece-domains.ts: `countCurvedProblems`. The problems that can exist: for every curvature, piece
/// and container, P = 1 up to curvedMaxP.
pub fn count_curved_problems() -> f64 {
    let mut n = 0.0;
    for &k in CURVED_KS.iter() {
        for &piece in PIECE_NS.iter() {
            for &m in CURVED_MS.iter() {
                n += curved_max_p(k, piece, m, CURVED_MAX_P as f64);
            }
        }
    }
    n
}

fn curved_bound(id: &ParsedSpaceId) -> Option<Option<Bound>> {
    let k = id.fields.get("K").and_then(|f| f.as_number())?;
    let m = id.fields.get("M").and_then(|f| f.as_number())?;
    // `CURVED_KS.includes(K)`: -0 is 0 there, and NaN is no curvature of the list
    if !CURVED_KS.contains(&k) {
        return None;
    }
    let n = shape(id.fields.get("N").and_then(|f| f.as_number()))?;
    let p = id.p as f64;
    if !CURVED_MS.contains(&m) || p != p.trunc() || p < 1.0 || p > CURVED_MAX_P as f64 {
        return None;
    }
    // null for an id in the ranges that cannot exist (the piece is absent at K, or no container below the limit holds P)
    Some(curved_bound_of(k, n as u32, m as u32, id.p).map(|value| Bound { value, label: "area / one piece bound; [CALC]".to_string() }))
}

/// piece-domains.ts: `curvedKey`, one field: `Number(fields[key])`, NaN for an absent one.
fn chosen_number(chosen: &[(String, String)], key: &str) -> f64 {
    match chosen.iter().find(|(k, _)| k == key) {
        // the board passes the values of the menus, which are decimal numbers
        Some((_, v)) => crate::types::Field::Text(v.clone()).js_number(),
        None => f64::NAN,
    }
}

fn curved_menu(key: &str, chosen: &[(String, String)]) -> Option<DomainMenu> {
    let (k, n, m) = (chosen_number(chosen, "K"), chosen_number(chosen, "N"), chosen_number(chosen, "M"));
    // the containers that hold at least one such piece, and P up to the area limit
    if key == "M" {
        return Some(DomainMenu::Values(CURVED_MS.iter().filter(|&&c| curved_max_p(k, n, c, 1.0) >= 1.0).map(|&c| fmt::num(c)).collect()));
    }
    if key == "P" {
        return Some(DomainMenu::Range(1.0, curved_max_p(k, n, m, CURVED_MAX_P as f64)));
    }
    None
}

fn curved_impossible(id: &ParsedSpaceId) -> Option<String> {
    curved_why_not(id.fields.number("K"), id.fields.number("N"), id.fields.number("M"), id.p as f64)
}

fn curved_sample(limit: usize) -> Vec<String> {
    let prefixes: Vec<String> =
        CURVED_KS.iter().flat_map(|&k| CURVED_MS.iter().map(move |&m| format!("curved/{}/<N>/{}", k_id(k), fmt::num(m)))).collect();
    sample(&prefixes, limit)
}

/// piece-domains.ts: `curvedDomain`. Curved pieces run to 500, as 2D in 2D does.
pub(crate) fn curved_domain() -> SpaceDomain {
    // a unit piece exists at every K <= 0; at K > 0 the larger pieces do not (listed by K, the others have them all)
    let mut curved_pieces = pieces();
    curved_pieces.push((
        "dependent",
        object(vec![
            ("on", Value::String("K".into())),
            (
                "values",
                js_object(
                    CURVED_KS
                        .iter()
                        .filter(|&&k| k > 0.0)
                        .map(|&k| {
                            let ns: Vec<f64> = PIECE_NS.iter().copied().filter(|&n| piece_exists(n as u32, k)).collect();
                            (k_id(k), strings(&ns))
                        })
                        .collect(),
                ),
            ),
        ]),
    ));
    let ids = |list: &[f64]| Value::Array(list.iter().map(|&k| Value::String(k_id(k))).collect());
    SpaceDomain {
        info: object(vec![
            ("id", Value::String("curved/<K>/<N>/<M>/<P>".into())),
            (
                "fields",
                Value::Array(vec![
                    object(vec![
                        ("key", Value::String("K".into())),
                        ("label", Value::String("Curvature".into())),
                        ("values", ids(&CURVED_KS)),
                        ("unlisted", ids(&CURVED_TILING_KS)),
                    ]),
                    object(curved_pieces),
                    object(vec![("key", Value::String("M".into())), ("label", Value::String("Container".into())), ("values", strings(&CURVED_MS))]),
                    count(CURVED_MAX_P as f64),
                ]),
            ),
            ("problems", number(CURVED_PROBLEMS)),
        ]),
        bound: curved_bound,
        sample: curved_sample,
        menu: Some(curved_menu),
        impossible: Some(curved_impossible),
    }
}
