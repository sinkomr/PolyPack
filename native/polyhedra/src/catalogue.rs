//! The names of the polyhedra family without its geometry. Port of `packages/polyhedra/src/catalogue.ts`.
//!
//! The solids' names, codes and titles and the 86 problems of polyhedrainpolyhedra.wiki (upstream's
//! scripts/engine.py: AB, ARCHIMEDEAN, CATALAN, PRISMS, PROBLEMS; MIT, see THIRD_PARTY_NOTICES.md), then
//! PolyPack's 64 in the same scheme (not on the wiki): the prisms and antiprisms with 7, 9, 10 and 11 sides in
//! themselves and in a cube, and their prisms of height 1.5, 2 and 3 in a cube; and the bipyramids and
//! trapezohedra (the canonical duals of the unit-edge prisms and antiprisms) in themselves and in a cube.
//!
//! Beyond those 150, every ordered pair (piece, container) of the 186 solids (the 94 above and the 92 Johnson
//! solids, J1 to J92, codes j01 to j92) is a problem family too (34,596 in all, P = 2 to 500, no research
//! records): `problem_name_of` reads the code `<piece code>in<container code>` of any pair, with the family
//! "pairs" for the 34,446 that are not among the 150.
//!
//! The name lists below are the source's, copied by a script and checked against the solids' table by
//! `tests/catalogue.rs` and against the TypeScript by `native/tools/polyhedra-compare.mjs`.

use std::collections::HashMap;
use std::sync::LazyLock;

/// `catalogue.ts: SolidFamily`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SolidFamily {
    Platonic,
    Archimedean,
    Catalan,
    Prism,
    Antiprism,
    ElongatedPrism,
    Bipyramid,
    Trapezohedron,
    Johnson,
}

impl SolidFamily {
    /// The family as the TypeScript writes it ("elongated_prism").
    pub fn as_str(self) -> &'static str {
        match self {
            SolidFamily::Platonic => "platonic",
            SolidFamily::Archimedean => "archimedean",
            SolidFamily::Catalan => "catalan",
            SolidFamily::Prism => "prism",
            SolidFamily::Antiprism => "antiprism",
            SolidFamily::ElongatedPrism => "elongated_prism",
            SolidFamily::Bipyramid => "bipyramid",
            SolidFamily::Trapezohedron => "trapezohedron",
            SolidFamily::Johnson => "johnson",
        }
    }

    /// The family of its TypeScript name, or None.
    pub fn parse(s: &str) -> Option<SolidFamily> {
        SOLID_FAMILIES.iter().copied().find(|f| f.as_str() == s)
    }
}

/// The families in the order of `SOLID_GROUPS`' keys (and of balls' `FAMILY_LABEL`).
pub const SOLID_FAMILIES: [SolidFamily; 9] = [
    SolidFamily::Platonic,
    SolidFamily::Archimedean,
    SolidFamily::Catalan,
    SolidFamily::Prism,
    SolidFamily::Antiprism,
    SolidFamily::ElongatedPrism,
    SolidFamily::Bipyramid,
    SolidFamily::Trapezohedron,
    SolidFamily::Johnson,
];

/// `catalogue.ts: ProblemFamily`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProblemFamily {
    Platonic,
    Archimedean,
    Catalan,
    Prisms,
    Bipyramids,
    Trapezohedra,
    Pairs,
}

impl ProblemFamily {
    /// The family as the TypeScript writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            ProblemFamily::Platonic => "platonic",
            ProblemFamily::Archimedean => "archimedean",
            ProblemFamily::Catalan => "catalan",
            ProblemFamily::Prisms => "prisms",
            ProblemFamily::Bipyramids => "bipyramids",
            ProblemFamily::Trapezohedra => "trapezohedra",
            ProblemFamily::Pairs => "pairs",
        }
    }
}

/// `catalogue.ts: SolidName`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolidName {
    /// Upstream's name, e.g. "truncated_tetrahedron", "prism3_l15".
    pub name: String,
    /// Upstream's code, e.g. "tte", "pr3l15".
    pub code: String,
    pub family: SolidFamily,
    /// Plain name, e.g. "truncated tetrahedron", "triangular prism of height 1.5".
    pub title: String,
}

/// `catalogue.ts: PLATONIC_SOLIDS`.
pub const PLATONIC_SOLIDS: [&str; 5] = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];
/// `catalogue.ts: ARCHIMEDEAN_SOLIDS`.
pub const ARCHIMEDEAN_SOLIDS: [&str; 13] = [
    "truncated_tetrahedron",
    "cuboctahedron",
    "truncated_cube",
    "truncated_octahedron",
    "rhombicuboctahedron",
    "truncated_cuboctahedron",
    "snub_cube",
    "icosidodecahedron",
    "truncated_dodecahedron",
    "truncated_icosahedron",
    "rhombicosidodecahedron",
    "truncated_icosidodecahedron",
    "snub_dodecahedron",
];
/// `catalogue.ts: CATALAN_SOLIDS`.
pub const CATALAN_SOLIDS: [&str; 13] = [
    "triakis_tetrahedron",
    "rhombic_dodecahedron",
    "triakis_octahedron",
    "tetrakis_hexahedron",
    "deltoidal_icositetrahedron",
    "disdyakis_dodecahedron",
    "pentagonal_icositetrahedron",
    "rhombic_triacontahedron",
    "triakis_icosahedron",
    "pentakis_dodecahedron",
    "deltoidal_hexecontahedron",
    "disdyakis_triacontahedron",
    "pentagonal_hexecontahedron",
];

/// `catalogue.ts: CODES`.
const CODES: [(&str, &str); 31] = [
    ("tetrahedron", "tet"),
    ("cube", "cub"),
    ("octahedron", "oct"),
    ("dodecahedron", "dod"),
    ("icosahedron", "ico"),
    ("truncated_tetrahedron", "tte"),
    ("cuboctahedron", "cbo"),
    ("truncated_cube", "tcu"),
    ("truncated_octahedron", "toc"),
    ("rhombicuboctahedron", "rco"),
    ("truncated_cuboctahedron", "tco"),
    ("snub_cube", "snc"),
    ("icosidodecahedron", "ido"),
    ("truncated_dodecahedron", "tdo"),
    ("truncated_icosahedron", "tic"),
    ("rhombicosidodecahedron", "rid"),
    ("truncated_icosidodecahedron", "tid"),
    ("snub_dodecahedron", "snd"),
    ("triakis_tetrahedron", "ktt"),
    ("rhombic_dodecahedron", "rdo"),
    ("triakis_octahedron", "kto"),
    ("tetrakis_hexahedron", "kth"),
    ("deltoidal_icositetrahedron", "dit"),
    ("disdyakis_dodecahedron", "ddo"),
    ("pentagonal_icositetrahedron", "pit"),
    ("rhombic_triacontahedron", "rtc"),
    ("triakis_icosahedron", "kti"),
    ("pentakis_dodecahedron", "pkd"),
    ("deltoidal_hexecontahedron", "dhc"),
    ("disdyakis_triacontahedron", "dtc"),
    ("pentagonal_hexecontahedron", "phc"),
];

fn code_of(name: &str) -> &'static str {
    CODES.iter().find(|(n, _)| *n == name).map(|(_, c)| *c).expect("a solid of CODES")
}

/// `catalogue.ts: POLY`.
fn poly(k: u32) -> &'static str {
    match k {
        3 => "triangular",
        4 => "square",
        5 => "pentagonal",
        6 => "hexagonal",
        7 => "heptagonal",
        8 => "octagonal",
        9 => "enneagonal",
        10 => "decagonal",
        11 => "hendecagonal",
        12 => "dodecagonal",
        _ => panic!("no polygon name for {k} sides"),
    }
}

const PRISM_K: [u32; 5] = [3, 5, 6, 8, 12];
const ANTIPRISM_K: [u32; 5] = [4, 5, 6, 8, 12];
/// PolyPack's prisms, antiprisms and elongated prisms (not on the wiki).
const EXTRA_K: [u32; 4] = [7, 9, 10, 11];
/// PolyPack's duals of the n-prisms (n = 4 is the octahedron) and of the n-antiprisms (n = 3 is the cube).
const BIPYRAMID_K: [u32; 9] = [3, 5, 6, 7, 8, 9, 10, 11, 12];
const TRAPEZOHEDRON_K: [u32; 9] = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const ELONG: [(&str, &str); 3] = [("l15", "1.5"), ("l2", "2"), ("l3", "3")];

/// `catalogue.ts: prismSolids`.
fn prism_solids(prisms: &[u32], antiprisms: &[u32]) -> Vec<SolidName> {
    let mut out = Vec::new();
    for &k in prisms {
        out.push(SolidName {
            name: format!("prism{k}"),
            code: format!("pr{k}"),
            family: SolidFamily::Prism,
            title: format!("{} prism", poly(k)),
        });
    }
    for &k in antiprisms {
        out.push(SolidName {
            name: format!("antiprism{k}"),
            code: format!("ap{k}"),
            family: SolidFamily::Antiprism,
            title: format!("{} antiprism", poly(k)),
        });
    }
    for &k in prisms {
        for (tag, h) in ELONG {
            out.push(SolidName {
                name: format!("prism{k}_{tag}"),
                code: format!("pr{k}{tag}"),
                family: SolidFamily::ElongatedPrism,
                title: format!("{} prism of height {h}", poly(k)),
            });
        }
    }
    out
}

/// `catalogue.ts: buildSolids`.
fn build_solids() -> Vec<SolidName> {
    let mut out = Vec::new();
    for s in PLATONIC_SOLIDS {
        out.push(SolidName { name: s.into(), code: code_of(s).into(), family: SolidFamily::Platonic, title: s.into() });
    }
    for s in ARCHIMEDEAN_SOLIDS {
        out.push(SolidName {
            name: s.into(),
            code: code_of(s).into(),
            family: SolidFamily::Archimedean,
            title: s.replace('_', " "),
        });
    }
    for s in CATALAN_SOLIDS {
        out.push(SolidName { name: s.into(), code: code_of(s).into(), family: SolidFamily::Catalan, title: s.replace('_', " ") });
    }
    out.extend(prism_solids(&PRISM_K, &ANTIPRISM_K));
    out.extend(prism_solids(&EXTRA_K, &EXTRA_K));
    for k in BIPYRAMID_K {
        out.push(SolidName {
            name: format!("bipyramid{k}"),
            code: format!("bp{k}"),
            family: SolidFamily::Bipyramid,
            title: format!("{} bipyramid", poly(k)),
        });
    }
    for k in TRAPEZOHEDRON_K {
        out.push(SolidName {
            name: format!("trapezohedron{k}"),
            code: format!("tz{k}"),
            family: SolidFamily::Trapezohedron,
            title: format!("{} trapezohedron", poly(k)),
        });
    }
    out
}

/// `catalogue.ts: JOHNSON_TITLES`: the 92 Johnson solids (Johnson 1966; python/polyhedra/johnson_table.py), in
/// Johnson's order.
#[rustfmt::skip]
const JOHNSON_TITLES: [&str; 92] = [
  "square pyramid", "pentagonal pyramid", "triangular cupola", "square cupola", "pentagonal cupola",
  "pentagonal rotunda", "elongated triangular pyramid", "elongated square pyramid", "elongated pentagonal pyramid",
  "gyroelongated square pyramid", "gyroelongated pentagonal pyramid", "triangular bipyramid", "pentagonal bipyramid",
  "elongated triangular bipyramid", "elongated square bipyramid", "elongated pentagonal bipyramid",
  "gyroelongated square bipyramid", "elongated triangular cupola", "elongated square cupola",
  "elongated pentagonal cupola", "elongated pentagonal rotunda", "gyroelongated triangular cupola",
  "gyroelongated square cupola", "gyroelongated pentagonal cupola", "gyroelongated pentagonal rotunda",
  "gyrobifastigium", "triangular orthobicupola", "square orthobicupola", "square gyrobicupola",
  "pentagonal orthobicupola", "pentagonal gyrobicupola", "pentagonal orthocupolarotunda",
  "pentagonal gyrocupolarotunda", "pentagonal orthobirotunda", "elongated triangular orthobicupola",
  "elongated triangular gyrobicupola", "elongated square gyrobicupola", "elongated pentagonal orthobicupola",
  "elongated pentagonal gyrobicupola", "elongated pentagonal orthocupolarotunda",
  "elongated pentagonal gyrocupolarotunda", "elongated pentagonal orthobirotunda",
  "elongated pentagonal gyrobirotunda", "gyroelongated triangular bicupola", "gyroelongated square bicupola",
  "gyroelongated pentagonal bicupola", "gyroelongated pentagonal cupolarotunda",
  "gyroelongated pentagonal birotunda", "augmented triangular prism", "biaugmented triangular prism",
  "triaugmented triangular prism", "augmented pentagonal prism", "biaugmented pentagonal prism",
  "augmented hexagonal prism", "parabiaugmented hexagonal prism", "metabiaugmented hexagonal prism",
  "triaugmented hexagonal prism", "augmented dodecahedron", "parabiaugmented dodecahedron",
  "metabiaugmented dodecahedron", "triaugmented dodecahedron", "metabidiminished icosahedron",
  "tridiminished icosahedron", "augmented tridiminished icosahedron", "augmented truncated tetrahedron",
  "augmented truncated cube", "biaugmented truncated cube", "augmented truncated dodecahedron",
  "parabiaugmented truncated dodecahedron", "metabiaugmented truncated dodecahedron",
  "triaugmented truncated dodecahedron", "gyrate rhombicosidodecahedron", "parabigyrate rhombicosidodecahedron",
  "metabigyrate rhombicosidodecahedron", "trigyrate rhombicosidodecahedron", "diminished rhombicosidodecahedron",
  "paragyrate diminished rhombicosidodecahedron", "metagyrate diminished rhombicosidodecahedron",
  "bigyrate diminished rhombicosidodecahedron", "parabidiminished rhombicosidodecahedron",
  "metabidiminished rhombicosidodecahedron", "gyrate bidiminished rhombicosidodecahedron",
  "tridiminished rhombicosidodecahedron", "snub disphenoid", "snub square antiprism", "sphenocorona",
  "augmented sphenocorona", "sphenomegacorona", "hebesphenomegacorona", "disphenocingulum", "bilunabirotunda",
  "triangular hebesphenorotunda",
];

/// `catalogue.ts: JOHNSON_SOLIDS`: family "johnson", codes j01 to j92 (no "in", so that pair codes such as
/// j05inj92 parse), names in snake_case, titles "J<n> <name>".
pub static JOHNSON_SOLIDS: LazyLock<Vec<SolidName>> = LazyLock::new(|| {
    JOHNSON_TITLES
        .iter()
        .enumerate()
        .map(|(i, t)| SolidName {
            name: t.replace(' ', "_"),
            code: format!("j{:02}", i + 1),
            family: SolidFamily::Johnson,
            title: format!("J{} {}", i + 1, t),
        })
        .collect()
});

/// `catalogue.ts: SOLID_NAMES_LIST`: every solid's name, code and title: upstream's 56 in upstream's order, then
/// PolyPack's 38, then the 92 Johnson solids.
pub static SOLID_NAMES_LIST: LazyLock<Vec<SolidName>> = LazyLock::new(|| {
    let mut out = build_solids();
    out.extend(JOHNSON_SOLIDS.iter().cloned());
    out
});

/// `catalogue.ts: SOLID_BY_NAME` (the index in SOLID_NAMES_LIST).
static SOLID_BY_NAME: LazyLock<HashMap<&'static str, usize>> =
    LazyLock::new(|| SOLID_NAMES_LIST.iter().enumerate().map(|(i, s)| (s.name.as_str(), i)).collect());
/// `catalogue.ts: SOLID_BY_CODE`.
static SOLID_BY_CODE: LazyLock<HashMap<&'static str, usize>> =
    LazyLock::new(|| SOLID_NAMES_LIST.iter().enumerate().map(|(i, s)| (s.code.as_str(), i)).collect());

/// The solid of a name ("cube"), or None: `SOLID_BY_NAME.get`.
pub fn solid_by_name(name: &str) -> Option<&'static SolidName> {
    SOLID_BY_NAME.get(name).map(|&i| &SOLID_NAMES_LIST[i])
}

/// The solid of a code ("cub"), or None: `SOLID_BY_CODE.get`.
pub fn solid_by_code(code: &str) -> Option<&'static SolidName> {
    SOLID_BY_CODE.get(code).map(|&i| &SOLID_NAMES_LIST[i])
}

/// `catalogue.ts: pluralTitle`: "cubes" for a cube, "tetrahedra", "triangular prisms of height 1.5".
pub fn plural_title(title: &str) -> String {
    if title.contains(" prism of height") {
        return title.replacen(" prism of", " prisms of", 1);
    }
    if title.ends_with("hedron") {
        return format!("{}a", &title[..title.len() - 2]);
    }
    format!("{title}s")
}

/// `catalogue.ts: article` (lower-case vowels only, as the source's /^[aeiou]/).
fn article(title: &str) -> String {
    if matches!(title.as_bytes().first(), Some(b'a' | b'e' | b'i' | b'o' | b'u')) {
        format!("an {title}")
    } else {
        format!("a {title}")
    }
}

/// `t.charAt(0).toUpperCase() + t.slice(1)` for the titles of the catalogue (ASCII).
pub(crate) fn capital(t: &str) -> String {
    let mut chars = t.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `catalogue.ts: ProblemName`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProblemName {
    /// Upstream's code `<piece code>in<container code>`, e.g. "cubintet".
    pub code: String,
    /// The piece solid's name ("cube").
    pub piece: String,
    /// The container solid's name ("tetrahedron").
    pub container: String,
    pub family: ProblemFamily,
    /// e.g. "Cubes in a tetrahedron".
    pub title: String,
    /// True for the 86 problems that polyhedrainpolyhedra.wiki lists.
    pub wiki: bool,
}

/// `catalogue.ts: problemName`.
fn problem_name(piece: &str, container: &str, family: ProblemFamily, wiki: bool) -> ProblemName {
    let p = solid_by_name(piece).expect("a solid of the catalogue");
    let c = solid_by_name(container).expect("a solid of the catalogue");
    let what = plural_title(&p.title);
    ProblemName {
        code: format!("{}in{}", p.code, c.code),
        piece: piece.to_string(),
        container: container.to_string(),
        family,
        title: format!("{} in {}", capital(&what), article(&c.title)),
        wiki,
    }
}

/// `catalogue.ts: prismProblems`.
fn prism_problems(prisms: &[u32], antiprisms: &[u32], wiki: bool) -> Vec<ProblemName> {
    let mut out = Vec::new();
    let solids: Vec<String> =
        prisms.iter().map(|k| format!("prism{k}")).chain(antiprisms.iter().map(|k| format!("antiprism{k}"))).collect();
    for s in &solids {
        for c in [s.as_str(), "cube"] {
            out.push(problem_name(s, c, ProblemFamily::Prisms, wiki));
        }
    }
    for k in prisms {
        for (tag, _) in ELONG {
            out.push(problem_name(&format!("prism{k}_{tag}"), "cube", ProblemFamily::Prisms, wiki));
        }
    }
    out
}

/// `catalogue.ts: buildProblems`.
fn build_problems() -> Vec<ProblemName> {
    // upstream's order: the self-packings and the cube/octahedron and dodecahedron/icosahedron duals
    // first, then the other Platonic pairs piece by piece, then the families
    let mut pairs: Vec<(&str, &str)> = vec![
        ("tetrahedron", "tetrahedron"),
        ("octahedron", "octahedron"),
        ("icosahedron", "icosahedron"),
        ("dodecahedron", "dodecahedron"),
        ("cube", "cube"),
        ("cube", "octahedron"),
        ("octahedron", "cube"),
        ("dodecahedron", "icosahedron"),
        ("icosahedron", "dodecahedron"),
    ];
    for p in PLATONIC_SOLIDS {
        for c in PLATONIC_SOLIDS {
            if !pairs.iter().any(|&(a, b)| a == p && b == c) {
                pairs.push((p, c));
            }
        }
    }
    let mut out: Vec<ProblemName> = pairs.iter().map(|&(p, c)| problem_name(p, c, ProblemFamily::Platonic, true)).collect();
    for s in ARCHIMEDEAN_SOLIDS {
        out.push(problem_name(s, s, ProblemFamily::Archimedean, true));
    }
    for s in CATALAN_SOLIDS {
        out.push(problem_name(s, s, ProblemFamily::Catalan, true));
    }
    out.extend(prism_problems(&PRISM_K, &ANTIPRISM_K, true));
    out.extend(prism_problems(&EXTRA_K, &EXTRA_K, false));
    for k in BIPYRAMID_K {
        let s = format!("bipyramid{k}");
        for c in [s.as_str(), "cube"] {
            out.push(problem_name(&s, c, ProblemFamily::Bipyramids, false));
        }
    }
    for k in TRAPEZOHEDRON_K {
        let s = format!("trapezohedron{k}");
        for c in [s.as_str(), "cube"] {
            out.push(problem_name(&s, c, ProblemFamily::Trapezohedra, false));
        }
    }
    out
}

/// `catalogue.ts: PROBLEM_NAMES`: the 150 problems of the records: upstream's 86 in upstream's order, then
/// PolyPack's 64 (wiki: false).
pub static PROBLEM_NAMES: LazyLock<Vec<ProblemName>> = LazyLock::new(build_problems);
/// `catalogue.ts: PROBLEM_BY_CODE`.
static PROBLEM_BY_CODE: LazyLock<HashMap<&'static str, usize>> =
    LazyLock::new(|| PROBLEM_NAMES.iter().enumerate().map(|(i, p)| (p.code.as_str(), i)).collect());

/// `catalogue.ts: pairOfCode`: the pair of solids a code names: the splits of the code at an "in" with a solid
/// code on each side. [CALC, the source's] No code of two solids has a second reading (catalogue test).
fn pair_of_code(code: &str) -> Option<(&'static SolidName, &'static SolidName)> {
    // code.indexOf("in", 1): a match that does not start the string. "in" is ASCII, so a match found in the bytes
    // from the second byte on is the same match, and its position is a character boundary.
    let bytes = code.as_bytes();
    let mut from = 1usize;
    while from < bytes.len() {
        let Some(off) = bytes[from..].windows(2).position(|w| w == b"in") else { break };
        let i = from + off;
        let piece = solid_by_code(&code[..i]);
        let container = solid_by_code(&code[i + 2..]);
        if let (Some(p), Some(c)) = (piece, container) {
            return Some((p, c));
        }
        from = i + 1;
    }
    None
}

/// `catalogue.ts: problemNameOf`: the problem of a code (one of the 150 or any other pair of solids), or None.
///
/// The source keeps the problems of the other pairs in a cache (PAIR_CACHE), so that it names each once; the name
/// is a function of the code alone, so this port builds it at each call and keeps no cache.
pub fn problem_name_of(code: &str) -> Option<ProblemName> {
    if let Some(&i) = PROBLEM_BY_CODE.get(code) {
        return Some(PROBLEM_NAMES[i].clone());
    }
    // code.length counts UTF-16 units
    if code.encode_utf16().count() > 24 {
        return None;
    }
    let (p, c) = pair_of_code(code)?;
    Some(problem_name(&p.name, &c.name, ProblemFamily::Pairs, false))
}

/// `catalogue.ts: pairCode`: the code of the problem of two solids, given by name ("cube", "tetrahedron" ->
/// "cubintet"), or None.
pub fn pair_code(piece: &str, container: &str) -> Option<String> {
    let p = solid_by_name(piece)?;
    let c = solid_by_name(container)?;
    Some(format!("{}in{}", p.code, c.code))
}

/// `catalogue.ts: PAIR_COUNT`: the number of problem families: every ordered pair of solids.
pub fn pair_count() -> usize {
    SOLID_NAMES_LIST.len() * SOLID_NAMES_LIST.len()
}

/// `catalogue.ts: SOLID_GROUPS`: title of a solid's group in a menu; the order of the groups is SOLID_FAMILIES.
pub fn solid_group(family: SolidFamily) -> &'static str {
    match family {
        SolidFamily::Platonic => "Platonic solids",
        SolidFamily::Archimedean => "Archimedean solids",
        SolidFamily::Catalan => "Catalan solids",
        SolidFamily::Prism => "Prisms",
        SolidFamily::Antiprism => "Antiprisms",
        SolidFamily::ElongatedPrism => "Prisms of height 1.5, 2 and 3",
        SolidFamily::Bipyramid => "Bipyramids",
        SolidFamily::Trapezohedron => "Trapezohedra",
        SolidFamily::Johnson => "Johnson solids",
    }
}

/// The index of an elongation tag in a list of tags, as `[...].indexOf(tag)`.
fn index_of(list: &[&str], tag: &str) -> i64 {
    list.iter().position(|t| *t == tag).map_or(-1, |i| i as i64)
}

/// The digits at the start of `s` (at least one) and what follows them: the `(\d+)` of the source's patterns.
fn leading_number(s: &str) -> Option<(f64, &str)> {
    let n = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if n == 0 {
        return None;
    }
    // Number("12"): a decimal integer, exact for every count of digits a code can have
    Some((s[..n].parse::<f64>().ok()?, &s[n..]))
}

/// `catalogue.ts: solidRank`: rank of a solid in a menu: by group, then (prisms, antiprisms, elongated prisms)
/// by sides and height. The source's pattern is /^(?:pr|ap|bp|tz)(\d+)(l15|l2|l3)?$/ on the code.
fn solid_rank(s: &SolidName, place: usize) -> [f64; 4] {
    let group = SOLID_FAMILIES.iter().position(|f| *f == s.family).expect("a family") as f64;
    let m = ["pr", "ap", "bp", "tz"]
        .iter()
        .find_map(|p| s.code.strip_prefix(p))
        .and_then(leading_number)
        .filter(|(_, rest)| matches!(*rest, "" | "l15" | "l2" | "l3"));
    match m {
        Some((n, rest)) => [group, n, index_of(&["", "l15", "l2", "l3"], rest) as f64, place as f64],
        None => [group, 0.0, 0.0, place as f64],
    }
}

/// `catalogue.ts: SOLIDS_BY_GROUP`: the solids in the order of a menu of pieces or containers: grouped by
/// family, prisms by their number of sides.
pub static SOLIDS_BY_GROUP: LazyLock<Vec<SolidName>> = LazyLock::new(|| {
    let mut list: Vec<([f64; 4], &SolidName)> =
        SOLID_NAMES_LIST.iter().enumerate().map(|(i, s)| (solid_rank(s, i), s)).collect();
    // x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3]; the sort is stable, as Array.prototype.sort
    list.sort_by(|(x, _), (y, _)| {
        for k in 0..4 {
            let d = x[k] - y[k];
            if d != 0.0 {
                return if d < 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
            }
        }
        std::cmp::Ordering::Equal
    });
    list.into_iter().map(|(_, s)| s.clone()).collect()
});

/// `catalogue.ts: problemTitle`: the problem's title ("Cubes in a tetrahedron"), or the code itself when it is
/// not a problem.
pub fn problem_title(code: &str) -> String {
    problem_name_of(code).map_or_else(|| code.to_string(), |p| p.title)
}

/// `catalogue.ts: PROBLEM_CODES`: the problem codes in the order of PROBLEM_NAMES.
pub static PROBLEM_CODES: LazyLock<Vec<String>> = LazyLock::new(|| PROBLEM_NAMES.iter().map(|p| p.code.clone()).collect());

/// `catalogue.ts: prismRank`: rank of a prism-family problem: prisms (in themselves, in a cube), antiprisms,
/// then elongated prisms, by sides. The source's pattern is /^(pr|ap)(\d+)(l15|l2|l3)?in/ on the code.
fn prism_rank(p: &ProblemName) -> Option<[f64; 3]> {
    if p.family != ProblemFamily::Prisms {
        return None;
    }
    let (kind, rest) = if let Some(r) = p.code.strip_prefix("pr") {
        ("pr", r)
    } else if let Some(r) = p.code.strip_prefix("ap") {
        ("ap", r)
    } else {
        return None;
    };
    let (n, rest) = leading_number(rest)?;
    // the optional height, then "in"; the alternatives in the pattern's order
    let mut tag: Option<&str> = None;
    let mut matched = false;
    for t in ["l15", "l2", "l3"] {
        if let Some(after) = rest.strip_prefix(t) {
            if after.starts_with("in") {
                tag = Some(t);
                matched = true;
                break;
            }
        }
    }
    if !matched {
        if !rest.starts_with("in") {
            return None;
        }
    }
    if let Some(t) = tag {
        return Some([2.0, n, index_of(&["l15", "l2", "l3"], t) as f64]);
    }
    Some([if kind == "pr" { 0.0 } else { 1.0 }, n, if p.container == "cube" { 1.0 } else { 0.0 }])
}

/// `catalogue.ts: PROBLEM_ORDER`: the problem codes in the order of a listing or a picker: the wiki's order, with
/// PolyPack's prisms and antiprisms among the wiki's by their number of sides (heptagonal prisms after the
/// hexagonal ones, and so on), then the bipyramids and trapezohedra. The wiki's own problems keep their order.
pub static PROBLEM_ORDER: LazyLock<Vec<String>> = LazyLock::new(|| {
    let mut prisms: Vec<([f64; 3], &ProblemName)> =
        PROBLEM_NAMES.iter().filter_map(|p| prism_rank(p).map(|r| (r, p))).collect();
    prisms.sort_by(|(x, _), (y, _)| {
        for k in 0..3 {
            let d = x[k] - y[k];
            if d != 0.0 {
                return if d < 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
            }
        }
        std::cmp::Ordering::Equal
    });
    let duals = |p: &ProblemName| p.family == ProblemFamily::Bipyramids || p.family == ProblemFamily::Trapezohedra;
    let mut out: Vec<String> =
        PROBLEM_NAMES.iter().filter(|p| prism_rank(p).is_none() && !duals(p)).map(|p| p.code.clone()).collect();
    out.extend(prisms.iter().map(|(_, p)| p.code.clone()));
    out.extend(PROBLEM_NAMES.iter().filter(|p| duals(p)).map(|p| p.code.clone()));
    out
});
