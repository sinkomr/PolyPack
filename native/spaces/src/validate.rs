//! Configuration parsing and validation of the spaces, with the work bounds the server needs for
//! untrusted input. Port of packages/spaces/src/validate.ts.
//!
//! Each space is checked by its own floating-point validator (the family crates) at PolyPack's
//! touching tolerance SPACE_TOL = 1e-9: pieces may touch, and an overlap or protrusion deeper than
//! 1e-9 rejects the configuration. This is a float check, like every other site entry; the
//! research records' interval certificates are separate.
//!
//! Beating a research record: a configuration whose size is below the record's certified size by
//! more than the space's record margin (`space_record_margin`: the tie tolerance, 1e-6 for
//! polyhedra and ndim) must also pass the validator at SPACE_STRICT_TOL = 1e-11. Without this, a
//! record's own configuration shrunk by about 1e-9 (its pieces then overlap by up to the touching
//! tolerance) would "beat" it; every research record passes at 1e-11 at its stated size. A problem
//! without a research record (status `no_record`, option `no_record`) asks the strict check of
//! every entry, so that its leader is strictly valid too and cannot be "beaten" by its own
//! configuration shrunk.
//!
//! Work bounds (every validator is at most quadratic in P, so these keep one check short):
//!  - P is at most `space_max_p` of the space;
//!  - sizes are at most SPACE_MAX_SIZE and coordinates, angles and quaternion components at most
//!    SPACE_MAX_COORD in absolute value;
//!  - the size must reach the problem's lower bound (minus 1e-9 relative), which also keeps a solid
//!    or a torus from being far too small for its pieces;
//!  - surface, fold: at most SURFACE_MAX_CHAINS chains of faces per piece;
//!  - torus: at most TORUS_MAX_TRANSLATES lattice translates per pair of pieces, and no lattice
//!    vector shorter than the piece's width (which would make a piece overlap its own translate);
//!  - boundary: s at most the boundary crate's MAX_S = 1e4, at most BOUNDARY_MAX_CHAINS chains of
//!    cells per piece.
//!
//! The untrusted configuration is a `serde_json::Value` as `polypack_js::json::parse` reads a
//! request body; `None` is JavaScript's `undefined` (an absent field). What the source's generators
//! did for the event loop (`runSteps`, `runStepsAsync`, `sliceMs`) is gone: the Rust server runs a
//! check on a worker thread (native/PORTING.md, rule 5).

use crate::ids::{parse_space_id, ParsedSpaceId};
use crate::info::{
    space_record_margin, BOUNDARY_MAX_CHAINS, BOUNDARY_MAX_S, SPACE_MAX_COORD, SPACE_MIN_QUATERNION_NORM, SPACE_STRICT_TOL, SPACE_TOL,
    SURFACE_MAX_CHAINS, TORUS_MAX_TRANSLATES,
};
use crate::types::SpaceName;
use polypack_balls::{balls_config_errors, balls_config_of_value, get_balls_problem, validate_balls, BallsConfig, BallsValidateOptions};
use polypack_boundary::{get_polytope, high_dim_shape, validate_boundary, BoundaryConfig, BoundaryPiece, BoundaryProblem};
use polypack_curved::{container_circumradius, CurvedConfig, CurvedProblem};
use polypack_flat::protocol::SCORE_TIE;
use polypack_flat::shapes::{bounding_radius, piece_inradius};
use polypack_js::{fmt, math};
use polypack_ndim::space::{load_nd_problem, nd_check, parse_nd_config, NdConfigShape, NdParsed, NdProblemId, ND_MAX_P, NDIM_MAX_REASONS};
use polypack_polyhedra::{get_problem as get_polyhedra_problem, parse_polyhedra_config, validate_polyhedra, ParsedConfig, PolyhedraConfig, POLYHEDRA_MAX_P};
use polypack_sphere::{SphereConfig, SpherePiece, SphereProblem};
use polypack_surface::{get_solid, ChainError, SurfaceConfig, SurfacePose};
use polypack_torus::{gauss_reduce, max_image_candidates, torus_score, Lattice, TorusFamily, TorusPacking, TORUS_MAX_P};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};
use std::time::Instant;

/// validate.ts: `SPACE_MAX_P`. Largest P each space accepts: its catalogue or domain cap. The
/// server also caps P at its loaded catalogue's.
pub const fn space_max_p(space: SpaceName) -> f64 {
    match space {
        SpaceName::Surface => 100.0,
        SpaceName::Curved => 500.0,
        SpaceName::Sphere => 100.0,
        SpaceName::Torus => TORUS_MAX_P as f64,
        // 400 for the d-cubes (d = 5..10; the 4-polytopes' catalogue stops at 24, which their domain enforces)
        SpaceName::Boundary => 400.0,
        SpaceName::Polyhedra => POLYHEDRA_MAX_P as f64,
        SpaceName::Balls => 100.0,
        // the largest P of any dimension (4D: 40); each dimension's own range is its domain's (the server refuses others)
        SpaceName::Ndim => ND_MAX_P as f64,
    }
}
/// validate.ts: `SPACE_MAX_SIZE`. Largest size (s, size, rho, L, lattice vector component) accepted.
pub const SPACE_MAX_SIZE: f64 = 1e6;
/// validate.ts: `SPACE_BOUND_SLACK`. Relative slack below the lower bound that a size may have
/// (float rounding of the bound).
pub const SPACE_BOUND_SLACK: f64 = 1e-9;
/// validate.ts: `SPACE_STRICT_REASON`. The reason given when a configuration beats a research
/// record only within the touching tolerance (the source writes the tolerance from SPACE_STRICT_TOL;
/// a test checks the text against it).
pub const SPACE_STRICT_REASON: &str =
    "beats the research record only within the float tolerance; an improvement must be valid at tolerance 1e-11";
/// validate.ts: `SPACE_STRICT_NO_RECORD_REASON`. The reason given when an entry of a problem
/// without a research record is valid only within the touching tolerance.
pub const SPACE_STRICT_NO_RECORD_REASON: &str =
    "valid only within the float tolerance; this problem has no research record yet, and its entries must be valid at tolerance 1e-11";
/// validate.ts: `MAX_REASONS`. Overlap reasons listed at most per verdict.
const MAX_REASONS: usize = 20;

/// validate.ts: `TorusLatticeSpec`. The lattice as a torus configuration states it: `{L}` for sq
/// and hex, `{b1, b2}` for free.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TorusLatticeSpec {
    L(f64),
    Basis { b1: [f64; 2], b2: [f64; 2] },
}

/// The surface configuration as the server keeps it: `{ s, pieces: [{ face, x, y, theta }] }`.
#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceSpaceConfig {
    pub s: f64,
    pub pieces: Vec<SurfacePose>,
}

/// The torus configuration as the server keeps it: `{ lattice, poses: [[x, y, theta], ...] }`.
#[derive(Clone, Debug, PartialEq)]
pub struct TorusSpaceConfig {
    pub lattice: TorusLatticeSpec,
    pub poses: Vec<[f64; 3]>,
}

/// types.ts: `SpaceConfig`. A configuration with only its known fields, in its space's own format
/// (the record files' format):
///  - surface: `{ s, pieces: [{ face, x, y, theta }] }`, score s (edge of the solid);
///  - curved:  `{ size, pieces: [{ x, y, theta }] }`, score size;
///  - sphere:  `{ rho, pieces: [{ q: [w, x, y, z] }] }`, score rho (sphere radius);
///  - torus:   `{ lattice: { L } | { b1: [x, y], b2: [x, y] }, poses: [[x, y, theta], ...] }`,
///    score L (sq, hex) or sqrt|det(b1, b2)| (free);
///  - boundary: `{ s, pieces: [{ cell, u, q? }] }`, score s (edge of the polytope);
///  - polyhedra: `{ s, pieces: [[x, y, z, qw, qx, qy, qz], ...] }`, score s;
///  - balls:   `{ s, pieces: [[x, y, z], ...] }` or `[[x, y, z, qw, qx, qy, qz], ...]`, score s;
///  - ndim:    `{ s, pieces: [[t_1..t_d, k_1..k_m, flip?], ...] }` or `[[t_1..t_d], ...]`, score s.
///
/// The source holds a JavaScript object; here it is typed, and it serializes
/// (`polypack_js::json::stringify`) to the text of `JSON.stringify` of that object, which is how
/// the server stores it.
#[derive(Clone, Debug, PartialEq)]
pub enum SpaceConfig {
    Surface(SurfaceSpaceConfig),
    Curved(CurvedConfig),
    Sphere(SphereConfig),
    Torus(TorusSpaceConfig),
    Boundary(BoundaryConfig),
    Polyhedra(PolyhedraConfig),
    Balls(BallsConfig),
    Ndim(NdConfigShape),
}

/// `{ s, pieces: [[numbers], ...] }`.
fn serialize_s_pieces<S: Serializer, T: AsRef<[f64]>>(serializer: S, s: f64, pieces: &[T]) -> Result<S::Ok, S::Error> {
    struct Rows<'a, T>(&'a [T]);
    impl<T: AsRef<[f64]>> Serialize for Rows<'_, T> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
            for row in self.0 {
                seq.serialize_element(row.as_ref())?;
            }
            seq.end()
        }
    }
    let mut map = serializer.serialize_map(Some(2))?;
    map.serialize_entry("s", &s)?;
    map.serialize_entry("pieces", &Rows(pieces))?;
    map.end()
}

impl Serialize for SpaceConfig {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            SpaceConfig::Surface(c) => {
                struct Piece<'a>(&'a SurfacePose);
                impl Serialize for Piece<'_> {
                    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                        let mut map = serializer.serialize_map(Some(4))?;
                        map.serialize_entry("face", &self.0.face)?;
                        map.serialize_entry("x", &self.0.x)?;
                        map.serialize_entry("y", &self.0.y)?;
                        map.serialize_entry("theta", &self.0.theta)?;
                        map.end()
                    }
                }
                struct Pieces<'a>(&'a [SurfacePose]);
                impl Serialize for Pieces<'_> {
                    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                        serializer.collect_seq(self.0.iter().map(Piece))
                    }
                }
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("s", &c.s)?;
                map.serialize_entry("pieces", &Pieces(&c.pieces))?;
                map.end()
            }
            SpaceConfig::Curved(c) => {
                #[derive(Serialize)]
                struct Piece {
                    x: f64,
                    y: f64,
                    theta: f64,
                }
                struct Pieces<'a>(&'a CurvedConfig);
                impl Serialize for Pieces<'_> {
                    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                        serializer.collect_seq(self.0.pieces.iter().map(|p| Piece { x: p.x, y: p.y, theta: p.theta }))
                    }
                }
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("size", &c.size)?;
                map.serialize_entry("pieces", &Pieces(c))?;
                map.end()
            }
            SpaceConfig::Sphere(c) => {
                struct Piece<'a>(&'a SpherePiece);
                impl Serialize for Piece<'_> {
                    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                        let mut map = serializer.serialize_map(Some(1))?;
                        map.serialize_entry("q", &self.0.q)?;
                        map.end()
                    }
                }
                struct Pieces<'a>(&'a [SpherePiece]);
                impl Serialize for Pieces<'_> {
                    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                        serializer.collect_seq(self.0.iter().map(Piece))
                    }
                }
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("rho", &c.rho)?;
                map.serialize_entry("pieces", &Pieces(&c.pieces))?;
                map.end()
            }
            SpaceConfig::Torus(c) => {
                struct Spec(TorusLatticeSpec);
                impl Serialize for Spec {
                    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                        match self.0 {
                            TorusLatticeSpec::L(l) => {
                                let mut map = serializer.serialize_map(Some(1))?;
                                map.serialize_entry("L", &l)?;
                                map.end()
                            }
                            TorusLatticeSpec::Basis { b1, b2 } => {
                                let mut map = serializer.serialize_map(Some(2))?;
                                map.serialize_entry("b1", &b1)?;
                                map.serialize_entry("b2", &b2)?;
                                map.end()
                            }
                        }
                    }
                }
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("lattice", &Spec(c.lattice))?;
                map.serialize_entry("poses", &c.poses)?;
                map.end()
            }
            SpaceConfig::Boundary(c) => {
                struct Piece<'a>(&'a BoundaryPiece);
                impl Serialize for Piece<'_> {
                    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                        let mut map = serializer.serialize_map(None)?;
                        map.serialize_entry("cell", &self.0.cell)?;
                        map.serialize_entry("u", &self.0.u)?;
                        if let Some(q) = &self.0.q {
                            map.serialize_entry("q", q)?;
                        }
                        map.end()
                    }
                }
                struct Pieces<'a>(&'a [BoundaryPiece]);
                impl Serialize for Pieces<'_> {
                    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                        serializer.collect_seq(self.0.iter().map(Piece))
                    }
                }
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("s", &c.s)?;
                map.serialize_entry("pieces", &Pieces(&c.pieces))?;
                map.end()
            }
            SpaceConfig::Polyhedra(c) => serialize_s_pieces(serializer, c.s, &c.pieces),
            SpaceConfig::Balls(c) => serialize_s_pieces(serializer, c.s, &c.pieces),
            SpaceConfig::Ndim(c) => serialize_s_pieces(serializer, c.s, &c.pieces),
        }
    }
}

impl SpaceConfig {
    /// The configuration as a JSON value: what the source passes on when it checks a stored or a
    /// reduced configuration again (the same object; every number keeps its bits).
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("a configuration is JSON")
    }

    /// `JSON.stringify(config)`: the text the server stores.
    pub fn to_json(&self) -> String {
        polypack_js::json::stringify(self)
    }
}

/// validate.ts: `SpaceVerdict`. How a check ended: `valid`, or why not; `malformed` marks input
/// that is not a configuration at all (HTTP 400).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SpaceVerdict {
    pub valid: bool,
    /// The size stated in the configuration (None when it could not be read).
    pub score: Option<f64>,
    pub reasons: Vec<String>,
    /// True when the input is not a well-formed configuration of the space (as opposed to an invalid packing).
    pub malformed: bool,
    /// The configuration with only its known fields, as it is stored.
    pub config: Option<SpaceConfig>,
}

/// validate.ts: `SpaceValidateOptions`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SpaceValidateOptions {
    /// The problem's lower bound on the score; sizes below it (minus SPACE_BOUND_SLACK relative) are rejected unchecked.
    pub bound: Option<f64>,
    /// Largest P accepted; `space_max_p` of the space by default, and never more.
    pub max_p: Option<f64>,
    /// The research record's certified size (certified.score). A configuration below it by more
    /// than the space's record margin (`beats_space_record`) must also be valid at SPACE_STRICT_TOL;
    /// without it there is no strict check.
    pub certified: Option<f64>,
    /// True when the problem has no research record (status `no_record`): every entry then needs the strict check.
    pub no_record: bool,
}

/// validate.ts: `Parsed<T>` (and its `Failure`).
#[derive(Clone, Debug, PartialEq)]
pub enum Parsed {
    /// `{ ok: true, config, score }`
    Ok { config: SpaceConfig, score: f64 },
    /// `{ ok: false, malformed, errors }`
    Failed { malformed: bool, errors: Vec<String> },
}

impl Parsed {
    fn failed(malformed: bool, errors: Vec<String>) -> Parsed {
        Parsed::Failed { malformed, errors }
    }
}

/// validate.ts: `isObject`. A JSON object (not null, not an array).
fn object(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

/// `Array.isArray(v) && v.length === n`.
fn array_of(v: Option<&Value>, n: usize) -> Option<&Vec<Value>> {
    v.and_then(Value::as_array).filter(|a| a.len() == n)
}

/// `Number.isInteger(v)` of a JSON value: the number, when it is a whole one.
fn integer(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite() && *x == x.trunc())
}

/// validate.ts: `Reader`. Reads finite numbers with a range; collects what is wrong.
struct Reader {
    errors: Vec<String>,
}

impl Reader {
    fn new() -> Reader {
        Reader { errors: Vec::new() }
    }

    /// `num(v, path, max, positive)`. The path is written only when it is needed.
    fn num(&mut self, v: Option<&Value>, path: std::fmt::Arguments<'_>, max: f64, positive: bool) -> f64 {
        // `typeof v !== "number" || !Number.isFinite(v)`
        let Some(x) = v.and_then(Value::as_f64).filter(|x| x.is_finite()) else {
            self.errors.push(format!("{path} must be a finite number"));
            return f64::NAN;
        };
        if x.abs() > max {
            self.errors.push(format!("{path} must be at most {} in absolute value", fmt::num(max)));
        } else if positive && !(x > 0.0) {
            self.errors.push(format!("{path} must be positive"));
        }
        x
    }

    fn full(&self) -> bool {
        self.errors.len() >= MAX_REASONS
    }

    /// A failure of the pieces list, together with the errors read so far (which make it malformed).
    fn fail_with(self, f: Parsed) -> Parsed {
        if self.errors.is_empty() {
            return f;
        }
        let mut errors = self.errors;
        if let Parsed::Failed { errors: more, .. } = f {
            errors.extend(more);
        }
        Parsed::failed(true, errors)
    }
}

/// validate.ts: `piecesOf`. The pieces array, or a message; a wrong length is an invalid packing,
/// not malformed input.
fn pieces_of<'a>(raw: &'a Map<String, Value>, key: &str, p: u32) -> Result<&'a Vec<Value>, Parsed> {
    let Some(list) = raw.get(key).and_then(Value::as_array) else {
        return Err(Parsed::failed(true, vec![format!("{key} must be an array")]));
    };
    if list.len() as u64 != p as u64 {
        return Err(Parsed::failed(false, vec![format!("expected {p} pieces for this problem, got {}", list.len())]));
    }
    Ok(list)
}

/// validate.ts: `parseSurface`.
fn parse_surface(raw: &Map<String, Value>, id: &ParsedSpaceId) -> Parsed {
    let mut r = Reader::new();
    // a solid of an id is one of SURFACE_SOLIDS, which are the surface crate's solids
    let f = get_solid(id.fields.text("solid")).expect("the solid of a parsed surface id").f as f64;
    let s = r.num(raw.get("s"), format_args!("s"), SPACE_MAX_SIZE, true);
    let list = match pieces_of(raw, "pieces", id.p) {
        Ok(list) => list,
        Err(failure) => return r.fail_with(failure),
    };
    let none = SurfacePose { face: 0.0, x: 0.0, y: 0.0, theta: 0.0 };
    let mut pieces: Vec<SurfacePose> = Vec::with_capacity(list.len());
    for (i, p) in list.iter().enumerate() {
        if r.full() {
            pieces.push(none);
            continue;
        }
        let Some(p) = p.as_object() else {
            r.errors.push(format!("pieces[{i}] must be an object {{face, x, y, theta}}"));
            pieces.push(none);
            continue;
        };
        let face = integer(p.get("face")).filter(|face| !(*face < 0.0) && !(*face >= f));
        if face.is_none() {
            r.errors.push(format!("pieces[{i}].face must be an integer from 0 to {}", fmt::num(f - 1.0)));
        }
        pieces.push(SurfacePose {
            face: face.unwrap_or(f64::NAN),
            x: r.num(p.get("x"), format_args!("pieces[{i}].x"), SPACE_MAX_COORD, false),
            y: r.num(p.get("y"), format_args!("pieces[{i}].y"), SPACE_MAX_COORD, false),
            theta: r.num(p.get("theta"), format_args!("pieces[{i}].theta"), SPACE_MAX_COORD, false),
        });
    }
    if !r.errors.is_empty() {
        return Parsed::failed(true, r.errors);
    }
    Parsed::Ok { config: SpaceConfig::Surface(SurfaceSpaceConfig { s, pieces }), score: s }
}

/// validate.ts: `parseCurved`.
fn parse_curved(raw: &Map<String, Value>, id: &ParsedSpaceId) -> Parsed {
    let mut r = Reader::new();
    let size = r.num(raw.get("size"), format_args!("size"), SPACE_MAX_SIZE, true);
    let list = match pieces_of(raw, "pieces", id.p) {
        Ok(list) => list,
        Err(failure) => return r.fail_with(failure),
    };
    let none = polypack_curved::Pose { x: 0.0, y: 0.0, theta: 0.0 };
    let mut pieces: Vec<polypack_curved::Pose> = Vec::with_capacity(list.len());
    for (i, p) in list.iter().enumerate() {
        if r.full() {
            pieces.push(none);
            continue;
        }
        let Some(p) = p.as_object() else {
            r.errors.push(format!("pieces[{i}] must be an object {{x, y, theta}}"));
            pieces.push(none);
            continue;
        };
        pieces.push(polypack_curved::Pose {
            x: r.num(p.get("x"), format_args!("pieces[{i}].x"), SPACE_MAX_COORD, false),
            y: r.num(p.get("y"), format_args!("pieces[{i}].y"), SPACE_MAX_COORD, false),
            theta: r.num(p.get("theta"), format_args!("pieces[{i}].theta"), SPACE_MAX_COORD, false),
        });
    }
    if !r.errors.is_empty() {
        return Parsed::failed(true, r.errors);
    }
    Parsed::Ok { config: SpaceConfig::Curved(CurvedConfig { size, pieces }), score: size }
}

/// validate.ts: `parseSphere`.
fn parse_sphere(raw: &Map<String, Value>, id: &ParsedSpaceId) -> Parsed {
    let mut r = Reader::new();
    let rho = r.num(raw.get("rho"), format_args!("rho"), SPACE_MAX_SIZE, true);
    let list = match pieces_of(raw, "pieces", id.p) {
        Ok(list) => list,
        Err(failure) => return r.fail_with(failure),
    };
    let none = || SpherePiece { q: vec![1.0, 0.0, 0.0, 0.0] };
    let mut pieces: Vec<SpherePiece> = Vec::with_capacity(list.len());
    for (i, p) in list.iter().enumerate() {
        let q = p.as_object().and_then(|p| p.get("q"));
        if r.full() {
            pieces.push(none());
            continue;
        }
        let Some(q) = array_of(q, 4) else {
            r.errors.push(format!("pieces[{i}] must be an object {{q: [w, x, y, z]}}"));
            pieces.push(none());
            continue;
        };
        let v: Vec<f64> = q.iter().enumerate().map(|(k, c)| r.num(Some(c), format_args!("pieces[{i}].q[{k}]"), SPACE_MAX_COORD, false)).collect();
        // a tiny quaternion's squared norm underflows, and its rotation is then undefined
        if v.iter().all(|x| x.is_finite()) && !(math::hypot_of(&v) >= SPACE_MIN_QUATERNION_NORM) {
            r.errors.push(format!("pieces[{i}].q must have a norm of at least {}", fmt::exponential(SPACE_MIN_QUATERNION_NORM, None)));
        }
        pieces.push(SpherePiece { q: v });
    }
    if !r.errors.is_empty() {
        return Parsed::failed(true, r.errors);
    }
    Parsed::Ok { config: SpaceConfig::Sphere(SphereConfig { rho, pieces }), score: rho }
}

/// The torus family of an id's field.
fn torus_family(id: &ParsedSpaceId) -> TorusFamily {
    match id.fields.text("family") {
        "sq" => TorusFamily::Sq,
        "hex" => TorusFamily::Hex,
        _ => TorusFamily::Free,
    }
}

/// The lattice of a torus configuration, as `parseTorus` and `check` build it.
fn torus_lattice(family: TorusFamily, spec: &TorusLatticeSpec) -> Lattice {
    match *spec {
        TorusLatticeSpec::L(l) => {
            if family == TorusFamily::Sq {
                Lattice { b1: [l, 0.0], b2: [0.0, l] }
            } else {
                Lattice { b1: [l, 0.0], b2: [l / 2.0, (l * math::sqrt(3.0)) / 2.0] }
            }
        }
        TorusLatticeSpec::Basis { b1, b2 } => Lattice { b1, b2 },
    }
}

/// validate.ts: `parseTorus`.
fn parse_torus(raw: &Map<String, Value>, id: &ParsedSpaceId) -> Parsed {
    let mut r = Reader::new();
    let family = torus_family(id);
    let name = family.as_str();
    let mut lattice = TorusLatticeSpec::L(f64::NAN);
    let mut basis: Option<Lattice> = None;
    match object(raw.get("lattice")) {
        None => r.errors.push(if family == TorusFamily::Free { "lattice must be {b1: [x, y], b2: [x, y]}" } else { "lattice must be {L}" }.to_string()),
        Some(l) if family != TorusFamily::Free => {
            if !l.contains_key("L") || l.contains_key("b1") || l.contains_key("b2") {
                r.errors.push(format!("a {name} lattice is given as {{L}}"));
            } else {
                let side = r.num(l.get("L"), format_args!("lattice.L"), SPACE_MAX_SIZE, true);
                lattice = TorusLatticeSpec::L(side);
                basis = Some(torus_lattice(family, &lattice));
            }
        }
        Some(l) => {
            let mut vec = |v: Option<&Value>, name: &str| -> [f64; 2] {
                let Some(v) = array_of(v, 2) else {
                    r.errors.push(format!("lattice.{name} must be [x, y]"));
                    return [f64::NAN, f64::NAN];
                };
                [
                    r.num(v.first(), format_args!("lattice.{name}[0]"), SPACE_MAX_SIZE, false),
                    r.num(v.get(1), format_args!("lattice.{name}[1]"), SPACE_MAX_SIZE, false),
                ]
            };
            if l.contains_key("L") {
                r.errors.push("a free lattice is given as {b1: [x, y], b2: [x, y]}".to_string());
            } else {
                let b1 = vec(l.get("b1"), "b1");
                let b2 = vec(l.get("b2"), "b2");
                lattice = TorusLatticeSpec::Basis { b1, b2 };
                basis = Some(Lattice { b1, b2 });
                if b1.iter().all(|x| x.is_finite()) && b2.iter().all(|x| x.is_finite()) && !((b1[0] * b2[1] - b1[1] * b2[0]).abs() > 0.0) {
                    r.errors.push("lattice.b1 and lattice.b2 must be linearly independent".to_string());
                }
            }
        }
    }
    let list = match pieces_of(raw, "poses", id.p) {
        Ok(list) => list,
        Err(failure) => return r.fail_with(failure),
    };
    let mut poses: Vec<[f64; 3]> = Vec::with_capacity(list.len());
    for (i, p) in list.iter().enumerate() {
        if r.full() {
            poses.push([0.0, 0.0, 0.0]);
            continue;
        }
        let Some(p) = array_of(Some(p), 3) else {
            r.errors.push(format!("poses[{i}] must be [x, y, theta]"));
            poses.push([0.0, 0.0, 0.0]);
            continue;
        };
        poses.push([
            r.num(p.first(), format_args!("poses[{i}][0]"), SPACE_MAX_COORD, false),
            r.num(p.get(1), format_args!("poses[{i}][1]"), SPACE_MAX_COORD, false),
            r.num(p.get(2), format_args!("poses[{i}][2]"), SPACE_MAX_COORD, false),
        ]);
    }
    let Some(basis) = basis.filter(|_| r.errors.is_empty()) else {
        return Parsed::failed(true, r.errors);
    };
    Parsed::Ok { config: SpaceConfig::Torus(TorusSpaceConfig { lattice, poses }), score: torus_score(family, &basis) }
}

/// validate.ts: `BOUNDARY_UNIT_SLACK`. Quaternion norms the boundary validator accepts as unit:
/// within this of 1.
const BOUNDARY_UNIT_SLACK: f64 = 1e-9;

/// validate.ts: `parseBoundary`.
fn parse_boundary(raw: &Map<String, Value>, id: &ParsedSpaceId) -> Parsed {
    let mut r = Reader::new();
    let polytope = id.fields.text("polytope");
    // the d-cubes (d = 5..10): 2d cells, d - 1 coordinates, no rotation; the 4-polytopes: their cells, 3 coordinates
    let hd = high_dim_shape(polytope);
    let nc = hd.is_some();
    let cells = match hd {
        Some(hd) => hd.cells,
        // a polytope of an id is a container of the catalogue: one of these, or a 4-polytope
        None => get_polytope(polytope).expect("the polytope of a parsed boundary id").cells.len(),
    } as f64;
    let dim_u = hd.map_or(3, |hd| hd.dim_u);
    let ball = id.fields.text("piece") == "ball";
    let s = r.num(raw.get("s"), format_args!("s"), BOUNDARY_MAX_S, true);
    let list = match pieces_of(raw, "pieces", id.p) {
        Ok(list) => list,
        Err(failure) => return r.fail_with(failure),
    };
    let none = || BoundaryPiece { cell: 0, u: vec![0.0; dim_u], q: None };
    let mut pieces: Vec<BoundaryPiece> = Vec::with_capacity(list.len());
    for (i, p) in list.iter().enumerate() {
        if r.full() {
            pieces.push(none());
            continue;
        }
        let Some(p) = p.as_object() else {
            r.errors.push(format!("pieces[{i}] must be an object {{cell, u{}}}", if ball || nc { "" } else { ", q?" }));
            pieces.push(none());
            continue;
        };
        let cell = integer(p.get("cell")).filter(|c| !(*c < 0.0) && !(*c >= cells));
        if cell.is_none() {
            r.errors.push(format!("pieces[{i}].cell must be an integer from 0 to {}", fmt::num(cells - 1.0)));
        }
        let mut u = vec![0.0; dim_u];
        match array_of(p.get("u"), dim_u) {
            None => r.errors.push(format!(
                "pieces[{i}].u must be {}",
                if dim_u == 3 { "[u0, u1, u2]".to_string() } else { format!("{dim_u} numbers") }
            )),
            Some(list) => {
                for (k, c) in list.iter().enumerate() {
                    u[k] = r.num(Some(c), format_args!("pieces[{i}].u[{k}]"), SPACE_MAX_COORD, false);
                }
            }
        }
        // a cell that was refused leaves errors, and the configuration is then not kept
        let mut piece = BoundaryPiece { cell: cell.unwrap_or(0.0) as usize, u, q: None };
        // `p.q === undefined`: an absent q; null is a q
        let Some(q) = p.get("q") else {
            pieces.push(piece);
            continue;
        };
        if nc && !ball {
            r.errors.push(format!("pieces[{i}] has no rotation q (pieces on the {polytope} stay axis-aligned)"));
            pieces.push(piece);
            continue;
        }
        if ball {
            r.errors.push(format!("pieces[{i}] is a ball and has no rotation q"));
            pieces.push(piece);
            continue;
        }
        let Some(q) = array_of(Some(q), 4) else {
            r.errors.push(format!("pieces[{i}].q must be a unit quaternion [w, x, y, z]"));
            pieces.push(piece);
            continue;
        };
        let mut quaternion = [0.0; 4];
        for (k, c) in q.iter().enumerate() {
            quaternion[k] = r.num(Some(c), format_args!("pieces[{i}].q[{k}]"), SPACE_MAX_COORD, false);
        }
        if quaternion.iter().all(|x| x.is_finite()) && !((math::hypot_of(&quaternion) - 1.0).abs() <= BOUNDARY_UNIT_SLACK) {
            r.errors.push(format!("pieces[{i}].q must be a unit quaternion (norm within {} of 1)", fmt::num(BOUNDARY_UNIT_SLACK)));
        }
        piece.q = Some(quaternion);
        pieces.push(piece);
    }
    if !r.errors.is_empty() {
        return Parsed::failed(true, r.errors);
    }
    Parsed::Ok { config: SpaceConfig::Boundary(BoundaryConfig { s, pieces }), score: s }
}

/// validate.ts: `ndId`. The nD problem of a parsed id.
fn nd_id(id: &ParsedSpaceId) -> NdProblemId {
    NdProblemId {
        d: id.fields.number("d") as u32,
        piece: id.fields.text("piece").to_string(),
        container: id.fields.text("container").to_string(),
        p: id.p,
    }
}

/// validate.ts: `parseBalls`. A balls configuration: errors of form are malformed input, except a
/// wrong number of pieces.
fn parse_balls(raw: &Value, id: &ParsedSpaceId) -> Parsed {
    let code = id.fields.js_string("code");
    let Some(problem) = get_balls_problem(&code) else {
        return Parsed::failed(true, vec![format!("unknown balls problem {code}")]);
    };
    let errors = balls_config_errors(problem, raw, None, MAX_REASONS);
    if !errors.is_empty() {
        return Parsed::failed(true, errors);
    }
    let object = raw.as_object().expect("a configuration without errors is an object");
    if let Err(failure) = pieces_of(object, "pieces", id.p) {
        return failure;
    }
    // each ball its 3 numbers, each solid its 7 (`p.slice(0, width)` of a pose the check found to be that long)
    let Some(config) = balls_config_of_value(problem, raw) else {
        // not reached: a configuration without errors has s and poses of that length
        return Parsed::failed(true, vec!["config must be an object {s, pieces}".to_string()]);
    };
    let score = config.s;
    Parsed::Ok { config: SpaceConfig::Balls(config), score }
}

/// validate.ts: `parseSpaceConfig`. The configuration of a problem in its space's own format, with
/// only the known fields, and the size it states. Errors are `malformed` when the input is not
/// such a configuration (types, ranges), and not when only the number of pieces is wrong. `raw` is
/// untrusted JSON; `None` is JavaScript's `undefined`.
pub fn parse_space_config(id: &ParsedSpaceId, raw: Option<&Value>) -> Parsed {
    let (Some(raw), Some(object)) = (raw, object(raw)) else {
        return Parsed::failed(true, vec!["config must be an object".to_string()]);
    };
    match id.space {
        SpaceName::Surface => parse_surface(object, id),
        SpaceName::Curved => parse_curved(object, id),
        SpaceName::Sphere => parse_sphere(object, id),
        SpaceName::Torus => parse_torus(object, id),
        SpaceName::Boundary => parse_boundary(object, id),
        SpaceName::Polyhedra => match parse_polyhedra_config(raw, id.p as usize, MAX_REASONS) {
            ParsedConfig::Ok { config, score } => Parsed::Ok { config: SpaceConfig::Polyhedra(config), score },
            ParsedConfig::Failed { malformed, errors } => Parsed::failed(malformed, errors),
        },
        SpaceName::Balls => parse_balls(raw, id),
        SpaceName::Ndim => match parse_nd_config(&nd_id(id), raw) {
            Ok(NdParsed::Ok { config, score }) => Parsed::Ok { config: SpaceConfig::Ndim(config), score },
            Ok(NdParsed::Bad { malformed, errors }) => Parsed::failed(malformed, errors),
            // The source lets this through as an exception: readPose throws for a dimension that
            // has no parameter count, which no parsed id has (d is 4 to 10).
            Err(thrown) => Parsed::failed(true, vec![thrown.0]),
        },
    }
}

/// validate.ts: `reasonsOf`. Reasons from a validator, at most MAX_REASONS, with a fallback when
/// it gave none.
fn reasons_of(errors: Vec<String>, fallback: String) -> Vec<String> {
    let mut list = errors;
    list.truncate(MAX_REASONS);
    if list.is_empty() {
        vec![fallback]
    } else {
        list
    }
}

/// What `check` throws in the source.
enum Thrown {
    /// The surface package's ChainLimitError.
    ChainLimit(String),
    /// Any other Error.
    Other(String),
}

/// validate.ts: `check`. Runs the space's own validator on a parsed configuration at `tol`;
/// reasons are empty when it is valid.
fn check(id: &ParsedSpaceId, config: &SpaceConfig, tol: f64) -> Result<Vec<String>, Thrown> {
    let f = &id.fields;
    match config {
        SpaceConfig::Surface(c) => {
            let cfg = SurfaceConfig { solid: f.text("solid").to_string(), n: f.number("N"), s: c.s, pieces: c.pieces.clone() };
            let v = polypack_surface::validate(
                &cfg,
                polypack_surface::Mode::of(f.text("mode")),
                &polypack_surface::ValidateOptions { tol, scale: 1.0, max_errors: MAX_REASONS, max_chains: SURFACE_MAX_CHAINS },
            )
            .map_err(|e| match e {
                ChainError::ChainLimit(m) => Thrown::ChainLimit(m),
                ChainError::Other(m) => Thrown::Other(m),
            })?;
            Ok(if v.ok { Vec::new() } else { reasons_of(v.errors, format!("not a valid packing (smallest clearance {})", fmt::num(v.min_pair_sep))) })
        }
        SpaceConfig::Curved(c) => {
            let k = f.number("K");
            let m = f.number("M") as u32;
            // A piece's centre lies in its piece, so in the container: a cheap first test that also
            // keeps far-away centres (whose coordinates overflow at K < 0) from reaching the validator.
            // Its slack of 1e-6 is far above the tolerance, so it refuses nothing the validator would accept.
            let reach = container_circumradius(m, k, c.size);
            if reach.is_finite() {
                let far = c.pieces.iter().position(|p| !(math::hypot(p.x, p.y) <= reach * (1.0 + 1e-6) + 1e-6));
                if let Some(far) = far {
                    return Ok(vec![format!("the centre of piece {far} lies outside the container")]);
                }
            }
            let v = polypack_curved::validation_steps(
                &CurvedProblem { k, n: f.number("N") as u32, m, p: id.p },
                c,
                &polypack_curved::ValidationOptions { tol, max_errors: Some(MAX_REASONS), contact_tol: 1e-7, contacts: false },
            );
            Ok(if v.valid { Vec::new() } else { reasons_of(v.errors, format!("not a valid packing (smallest gap {})", fmt::num(v.min_gap))) })
        }
        SpaceConfig::Sphere(c) => {
            let v = polypack_sphere::validation_steps(
                &SphereProblem { n: f.number("N"), p: id.p as f64 },
                c,
                &polypack_sphere::ValidateOptions { tol: Some(tol), max_errors: Some(MAX_REASONS as f64) },
            );
            if v.valid {
                return Ok(Vec::new());
            }
            if !v.errors.is_empty() {
                return Ok(reasons_of(v.errors, String::new()));
            }
            // `v.worstPair ?? [-1, -1]`
            let (i, j) = match v.worst_pair {
                Some((i, j)) => (i.to_string(), j.to_string()),
                None => ("-1".to_string(), "-1".to_string()),
            };
            Ok(vec![format!("pieces {i} and {j} overlap by {}", fmt::num(-v.min_gap))])
        }
        SpaceConfig::Torus(c) => {
            let family = torus_family(id);
            let n = f.number("N");
            let lattice = torus_lattice(family, &c.lattice);
            // A piece contains its inscribed disk, and its width in every direction is at least twice
            // the inradius r, so a piece and its translate by a lattice vector of length l overlap by at
            // least 2r - l. A lattice vector shorter than 2r - TOL is therefore an overlap the validator
            // would reject as well, and refusing it first keeps the enumeration below small.
            let shortest = gauss_reduce(&lattice).lattice.b1;
            let width = 2.0 * piece_inradius(n as u32);
            let len = math::hypot(shortest[0], shortest[1]);
            if len < width - tol {
                return Ok(vec![format!(
                    "the lattice has a vector of length {}, shorter than the piece's width {}: every piece overlaps its own translate",
                    fmt::num(len),
                    fmt::num(width)
                )]);
            }
            // the validator's enumeration window, per pair of pieces (see the torus crate's lattice.rs)
            let reach_r = 2.0 * bounding_radius(n as u32) + 2.0 * 1e-7;
            // the most candidates (m, n) that the loop of latticeImages visits for one pair, exactly its bound
            let translates = max_image_candidates(&lattice, reach_r);
            if !(translates <= TORUS_MAX_TRANSLATES) {
                return Ok(vec![format!(
                    "the lattice basis is too skewed: up to {} translates per pair would need checking (at most {}); send a Lagrange-Gauss reduced basis",
                    fmt::num(translates),
                    fmt::num(TORUS_MAX_TRANSLATES)
                )]);
            }
            let v = polypack_torus::validation_steps(
                &TorusPacking { family, n, lattice, poses: c.poses.iter().map(|&[x, y, theta]| polypack_torus::Pose { x, y, theta }).collect() },
                &polypack_torus::ValidateOptions { tol: Some(tol), max_errors: Some(MAX_REASONS as f64), ..Default::default() },
            );
            if v.valid && v.errors.is_empty() {
                return Ok(Vec::new());
            }
            if !v.errors.is_empty() {
                return Ok(reasons_of(v.errors, String::new()));
            }
            Ok(v.overlaps
                .iter()
                .take(MAX_REASONS)
                .map(|o| {
                    if o.i == o.j {
                        format!(
                            "piece {} overlaps its own translate by ({}, {}) lattice vectors, by {}",
                            o.i,
                            fmt::num(o.m),
                            fmt::num(o.n),
                            fmt::num(-o.sep)
                        )
                    } else {
                        format!("pieces {} and {} overlap (translate ({}, {})) by {}", o.i, o.j, fmt::num(o.m), fmt::num(o.n), fmt::num(-o.sep))
                    }
                })
                .collect())
        }
        SpaceConfig::Boundary(_) => {
            let problem = BoundaryProblem { polytope: f.text("polytope").to_string(), piece: f.text("piece").to_string(), p: id.p as f64 };
            // the validator's own volume bound and in-cell edge tests run before any chain is enumerated
            let v = validate_boundary(
                &problem,
                &config.to_value(),
                &polypack_boundary::ValidateOptions {
                    tol: Some(tol),
                    max_reasons: Some(MAX_REASONS as f64),
                    max_chains: Some(BOUNDARY_MAX_CHAINS),
                    ..Default::default()
                },
            )
            .map_err(|e| Thrown::Other(e.to_string()))?;
            Ok(if v.ok { Vec::new() } else { reasons_of(v.reasons, "not a valid packing".to_string()) })
        }
        SpaceConfig::Polyhedra(c) => {
            let code = f.js_string("code");
            let Some(problem) = get_polyhedra_problem(&code) else {
                return Ok(vec![format!("unknown polyhedra problem {code}")]);
            };
            let v = validate_polyhedra(&problem, c, &polypack_polyhedra::ValidateOptions { tol: Some(tol), max_errors: Some(MAX_REASONS), stop_at: None })
                .map_err(Thrown::Other)?;
            Ok(if v.valid { Vec::new() } else { reasons_of(v.errors, format!("not a valid packing (smallest separation {})", fmt::num(v.min_pair_sep))) })
        }
        SpaceConfig::Balls(c) => {
            let code = f.js_string("code");
            let Some(problem) = get_balls_problem(&code) else {
                return Ok(vec![format!("unknown balls problem {code}")]);
            };
            let v = validate_balls(problem, c, &BallsValidateOptions { tol: Some(tol), max_errors: Some(MAX_REASONS) }).map_err(Thrown::Other)?;
            Ok(if v.valid { Vec::new() } else { reasons_of(v.errors, format!("not a valid packing (smallest separation {})", fmt::num(v.min_pair_sep))) })
        }
        // with a cap on the work (the ndim crate's space/validate.rs); the polytopes must be loaded (load_nd_problem)
        SpaceConfig::Ndim(c) => nd_check(&nd_id(id), c, tol, NDIM_MAX_REASONS).map_err(|e| Thrown::Other(e.0)),
    }
}

/// validate.ts: `checked`. `check` that turns a thrown error into a reason.
fn checked(id: &ParsedSpaceId, config: &SpaceConfig, tol: f64) -> Vec<String> {
    match check(id, config, tol) {
        Ok(reasons) => reasons,
        Err(Thrown::ChainLimit(message)) => vec![format!("the fold check gave up: {message}")],
        Err(Thrown::Other(message)) => vec![format!("the check failed: {message}")],
    }
}

/// What `prepare` answers when a check is needed: the parsed id and configuration, and what turns
/// the check's reasons into the verdict.
struct Prepared {
    space: SpaceName,
    id: ParsedSpaceId,
    config: SpaceConfig,
    score: f64,
    certified: Option<f64>,
    no_record: bool,
}

fn fail(reasons: Vec<String>, malformed: bool, score: Option<f64>, config: Option<SpaceConfig>) -> SpaceVerdict {
    SpaceVerdict { valid: false, score, reasons, malformed, config }
}

impl Prepared {
    /// `needsStrict(reasons)`.
    fn needs_strict(&self, reasons: &[String]) -> bool {
        reasons.is_empty() && (self.no_record || self.certified.is_some_and(|certified| beats_space_record(self.space, self.score, Some(certified))))
    }

    /// `verdict(reasons, strict)`.
    fn verdict(self, reasons: Vec<String>, strict: Vec<String>) -> SpaceVerdict {
        if !reasons.is_empty() {
            return fail(reasons, false, Some(self.score), Some(self.config));
        }
        if !strict.is_empty() {
            let first = if self.no_record { SPACE_STRICT_NO_RECORD_REASON } else { SPACE_STRICT_REASON };
            let reasons = std::iter::once(first.to_string()).chain(strict.into_iter().take(3)).collect();
            return fail(reasons, false, Some(self.score), Some(self.config));
        }
        SpaceVerdict { valid: true, score: Some(self.score), reasons: Vec::new(), malformed: false, config: Some(self.config) }
    }
}

/// validate.ts: `prepare`. What both checks share: the verdict on the id, P, the configuration's
/// form and the lower bound (the `Err`), or what is needed to finish.
fn prepare(space: SpaceName, id: &str, raw_config: &Value, opts: &SpaceValidateOptions) -> Result<Prepared, SpaceVerdict> {
    let parsed_id = parse_space_id(space, id).map_err(|message| fail(vec![message], true, None, None))?;
    // `Math.min(opts.maxP ?? SPACE_MAX_P[space], SPACE_MAX_P[space])`
    let max_p = math::min(opts.max_p.unwrap_or(space_max_p(space)), space_max_p(space));
    if parsed_id.p as f64 > max_p {
        return Err(fail(vec![format!("P = {} is above the largest P of the {space} catalogue ({})", parsed_id.p, fmt::num(max_p))], true, None, None));
    }
    let (config, score) = match parse_space_config(&parsed_id, Some(raw_config)) {
        Parsed::Ok { config, score } => (config, score),
        Parsed::Failed { malformed, mut errors } => {
            errors.truncate(MAX_REASONS);
            return Err(fail(errors, malformed, None, None));
        }
    };
    if let Some(bound) = opts.bound.filter(|b| b.is_finite()) {
        if score < bound * (1.0 - SPACE_BOUND_SLACK) {
            return Err(fail(
                vec![format!("the size {} is below the lower bound {} of this problem", fmt::num(score), fmt::num(bound))],
                false,
                Some(score),
                Some(config),
            ));
        }
    }
    Ok(Prepared { space, id: parsed_id, config, score, certified: opts.certified, no_record: opts.no_record })
}

/// validate.ts: `validateSpaceSubmission`. Checks a configuration for a problem of a space: the
/// id, the number of pieces, the work bounds, the lower bound when one is given, and then the
/// space's own validator at the size the configuration states (TOL = 1e-9); when `certified` is
/// given and the size beats it by more than the space's record margin, also at SPACE_STRICT_TOL.
/// It never fails; a validator that gives up (a work limit) gives an invalid verdict with its
/// reason. As in the source, the polytopes of an ndim problem that are loaded on demand are not
/// loaded here (`validate_space_submission_async` loads them); a check of one that is not loaded
/// is invalid with the ndim validator's reason ("container 4:24cell is loaded on demand: ...").
/// The server calls the Async variant.
pub fn validate_space_submission(space: SpaceName, id: &str, raw_config: &Value, opts: &SpaceValidateOptions) -> SpaceVerdict {
    let prep = match prepare(space, id, raw_config, opts) {
        Ok(prep) => prep,
        Err(verdict) => return verdict,
    };
    let reasons = checked(&prep.id, &prep.config, SPACE_TOL);
    let strict = if prep.needs_strict(&reasons) { checked(&prep.id, &prep.config, SPACE_STRICT_TOL) } else { Vec::new() };
    prep.verdict(reasons, strict)
}

/// What `validateSpaceSubmissionAsync` resolves to: the verdict and the time its work took. (The
/// source's `slices` and `longestSliceMs` describe its turns of the event loop, which are gone.)
#[derive(Clone, Debug, PartialEq)]
pub struct TimedVerdict {
    pub verdict: SpaceVerdict,
    /// The time the checks took, in milliseconds (the load of an ndim polytope is not part of it,
    /// as in the source).
    pub work_ms: f64,
}

fn ms_since(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// One pass of `validateSpaceSubmissionAsync`'s `run`: the check at `tol` as the server runs it,
/// and the time it took. The polytopes of an ndim problem are loaded first (once; a no-op
/// afterwards), and a failure to load is a clean reason.
fn run(prep: &Prepared, tol: f64) -> (Vec<String>, f64) {
    if prep.id.space == SpaceName::Ndim {
        let nd = nd_id(&prep.id);
        if let Err(e) = load_nd_problem(nd.d, &nd.piece, &nd.container) {
            return (vec![format!("the check failed: {}", e.0)], 0.0);
        }
    }
    let t = Instant::now();
    let reasons = checked(&prep.id, &prep.config, tol);
    (reasons, ms_since(t))
}

/// validate.ts: `validateSpaceSubmissionAsync`, as one synchronous function for a worker thread:
/// the same checks as `validate_space_submission`, with the polytopes of an ndim problem loaded
/// first, and the time the work took (`workMs`), which the server charges to the submitter.
pub fn validate_space_submission_async(space: SpaceName, id: &str, raw_config: &Value, opts: &SpaceValidateOptions) -> TimedVerdict {
    let t0 = Instant::now();
    let prep = prepare(space, id, raw_config, opts);
    let first = ms_since(t0);
    let prep = match prep {
        Ok(prep) => prep,
        Err(verdict) => return TimedVerdict { verdict, work_ms: first },
    };
    let mut work_ms = first;
    let (reasons, ms) = run(&prep, SPACE_TOL);
    work_ms += ms;
    let strict = if prep.needs_strict(&reasons) {
        let (strict, ms) = run(&prep, SPACE_STRICT_TOL);
        work_ms += ms;
        strict
    } else {
        Vec::new()
    };
    TimedVerdict { verdict: prep.verdict(reasons, strict), work_ms }
}

/// validate.ts: `beatsSpaceScore`. True when `score` beats `best` by more than the tie tolerance
/// (as on the main site: score < best (1 - SCORE_TIE)).
pub fn beats_space_score(score: f64, best: Option<f64>) -> bool {
    match best {
        None => true,
        Some(best) => score < best * (1.0 - SCORE_TIE),
    }
}

/// validate.ts: `beatsSpaceRecord`. True when `score` beats a research record's certified value by
/// more than the space's record margin (the tie tolerance, or 1e-6 for polyhedra and ndim, whose
/// records keep a clearance).
pub fn beats_space_record(space: SpaceName, score: f64, certified: Option<f64>) -> bool {
    match certified {
        None => true,
        Some(certified) => score < certified * (1.0 - space_record_margin(space)),
    }
}

/// validate.ts: `improvesSpaceBest`. True when an entry improves on a problem's best values: the
/// research record by its space's record margin and the site leader by the tie tolerance.
pub fn improves_space_best(space: SpaceName, score: f64, certified: Option<f64>, leader: Option<f64>) -> bool {
    beats_space_record(space, score, certified) && beats_space_score(score, leader)
}

/// validate.ts: `reducedSpaceConfig`. The configuration as the server stores it. A free torus
/// lattice that is skewed or left-handed is stored Lagrange-Gauss reduced with det(b1, b2) > 0:
/// the same lattice, so the same packing and score, in a basis that every reader can draw and
/// search without a long walk over translates. The poses stay as they are, since positions count
/// modulo the lattice. None: the configuration is kept as it is (the source returns the same object).
pub fn reduced_space_config(space: SpaceName, id: &str, config: &SpaceConfig) -> Option<SpaceConfig> {
    if space != SpaceName::Torus {
        return None;
    }
    let parsed = parse_space_id(space, id).ok()?;
    if parsed.fields.text("family") != "free" {
        return None;
    }
    // `config.lattice` with both b1 and b2
    let SpaceConfig::Torus(TorusSpaceConfig { lattice: TorusLatticeSpec::Basis { b1: sent1, b2: sent2 }, poses }) = config else {
        return None;
    };
    let det0 = sent1[0] * sent2[1] - sent1[1] * sent2[0];
    let reduced = gauss_reduce(&Lattice { b1: *sent1, b2: *sent2 }).lattice;
    let (b1, r2) = (reduced.b1, reduced.b2);
    // -b2 spans the same lattice as b2
    let b2: [f64; 2] = if b1[0] * r2[1] - b1[1] * r2[0] < 0.0 { [-r2[0], -r2[1]] } else { [r2[0], r2[1]] };
    let length2 = |u: &[f64; 2], v: &[f64; 2]| u[0] * u[0] + u[1] * u[1] + v[0] * v[0] + v[1] * v[1];
    // a reduced, right-handed basis is kept as it was sent, so that stored records are not rewritten
    if det0 > 0.0 && length2(&b1, &b2) >= length2(sent1, sent2) * (1.0 - 1e-12) {
        return None;
    }
    Some(SpaceConfig::Torus(TorusSpaceConfig { lattice: TorusLatticeSpec::Basis { b1: [b1[0], b1[1]], b2 }, poses: poses.clone() }))
}

/// The rule of `storedSpaceConfig`: the reduced form replaces the one sent only when it passes
/// with the same score (to within SCORE_TIE).
fn keeps(before: Option<f64>, after: &SpaceVerdict) -> bool {
    match (before, after.score) {
        (Some(before), Some(score)) => after.valid && after.config.is_some() && !((score - before).abs() > SCORE_TIE * before),
        _ => false,
    }
}

/// validate.ts: `storedSpaceConfig`. The stored form is checked again by the same rule and
/// replaces the one sent only when it passes with the same score (to within SCORE_TIE); anything
/// else is stored as it was sent. `sent_score`: the score of the verdict that has just accepted
/// `config`; the check is then not repeated.
pub fn stored_space_config(space: SpaceName, id: &str, config: &SpaceConfig, opts: &SpaceValidateOptions, sent_score: Option<f64>) -> SpaceConfig {
    let Some(candidate) = reduced_space_config(space, id, config) else {
        return config.clone();
    };
    let before = match sent_score {
        Some(score) => Some(score),
        None => validate_space_submission(space, id, &config.to_value(), opts).score,
    };
    let after = validate_space_submission(space, id, &candidate.to_value(), opts);
    if !keeps(before, &after) {
        return config.clone();
    }
    after.config.unwrap_or_else(|| config.clone())
}

/// What `storedSpaceConfigAsync` resolves to: the configuration to store and the time the work took.
#[derive(Clone, Debug, PartialEq)]
pub struct TimedConfig {
    pub config: SpaceConfig,
    pub work_ms: f64,
}

/// validate.ts: `storedSpaceConfigAsync`, as one synchronous function for a worker thread: the
/// storage recheck with the time its work took, which the server adds to the submission's.
pub fn stored_space_config_async(space: SpaceName, id: &str, config: &SpaceConfig, opts: &SpaceValidateOptions, sent_score: Option<f64>) -> TimedConfig {
    let start = Instant::now();
    let candidate = reduced_space_config(space, id, config);
    let first = ms_since(start);
    let Some(candidate) = candidate else {
        return TimedConfig { config: config.clone(), work_ms: first };
    };
    let (before, before_ms) = match sent_score {
        Some(score) => (Some(score), 0.0),
        None => {
            let v = validate_space_submission_async(space, id, &config.to_value(), opts);
            (v.verdict.score, v.work_ms)
        }
    };
    let after = validate_space_submission_async(space, id, &candidate.to_value(), opts);
    let work_ms = first + before_ms + after.work_ms;
    let keep = keeps(before, &after.verdict);
    TimedConfig { config: if keep { after.verdict.config.unwrap_or_else(|| config.clone()) } else { config.clone() }, work_ms }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_strict_reasons_name_the_strict_tolerance() {
        let tol = fmt::num(SPACE_STRICT_TOL);
        assert_eq!(SPACE_STRICT_REASON, format!("beats the research record only within the float tolerance; an improvement must be valid at tolerance {tol}"));
        assert_eq!(
            SPACE_STRICT_NO_RECORD_REASON,
            format!("valid only within the float tolerance; this problem has no research record yet, and its entries must be valid at tolerance {tol}")
        );
    }
}
