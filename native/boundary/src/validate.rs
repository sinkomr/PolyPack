//! Float validator of the boundary space (tolerance tol, default 1e-9).
//! Port of packages/boundary/src/validate.ts.
//!
//! A configuration is valid ("fold" placement, research note sec. 2.2) when:
//! (1) every centre lies in its closed anchor cell (within tol);
//! (2) no point of the hinges (the polytope's edges, vertices included) lies in the interior of a
//!     developed piece (by more than tol);
//! (3) the development is injective on each piece's interior, and (4) the interiors of distinct
//!     pieces are disjoint. With (2), (3) and (4) together say: in every cell, all parts (two parts
//!     of one piece included) have disjoint interiors (overlap depth <= tol allowed).
//!
//! Units (units.rs): balls have diameter 1, radius 1/2. The ball code is written for radius 1 and
//! runs on lengths x2; the text below states the rule in that working unit (clearance >= 1, centre
//! distances >= 2), which in site units is clearance >= 1/2 and distances >= 1, and the reasons
//! quote site lengths. The tolerance is a site length.
//!
//! Balls use the equivalent distance form (shortest paths avoid the hinges [EST: Miller, Pak 2008,
//! Prop. 1.2]): every centre at geodesic distance >= 1 - tol from the hinges, centre distances
//! >= 2 - tol, geodesic loops at each centre >= 2 - tol. Distances and loops count a developed
//! image of a centre only when it lies in the chain's closed window, exactly (no tolerance). A
//! window's faces are planes through the centre x and an edge of a gate, which lies on a hinge or
//! on an earlier window face, with one exception: the half-space window of a centre lying on a
//! ridge (chains.rs, "Centres near ridges") is bounded by the ridge's own plane. So an image on a
//! window boundary is either a path through a hinge, of length >= d(x, hinge) + d(hinge, y)
//! >= 2 - 2 tol by the clearance check, or a path inside a ridge from a centre on that ridge to a
//! centre on it. Rounding could hide the second kind, so a ball whose centre lies on a facet of its
//! anchor cell is also entered, mapped across, in the neighbouring cell: a ball of that cell sees
//! it from its own anchor, with no window at all.
//!
//! Vertices. This validator enforces only the following at vertices: a vertex is a point of the
//! hinges, so (2) rejects a vertex inside a piece (by more than tol), exactly as for any other edge
//! point; a vertex on a piece's boundary is allowed with no further condition; and parts are
//! developed along rays that avoid the vertices, so overlaps next to a vertex are caught only
//! through the parts test of (3)-(4).
//!
//! Work is bounded: chains per piece are capped (opts.max_chains, default 4096), and a
//! configuration that reaches the cap is rejected with a plain reason. Cheap checks run first, so a
//! container far too small for its pieces fails before any chain is enumerated: the volume bound
//! (P vol(piece) <= vol(boundary)), then each piece against its anchor cell's own edges. The pair
//! stages bin centres (balls) or parts' bounding boxes (solids) in a uniform grid per cell, so
//! their work is linear in P, and they stop once opts.max_reasons reasons are collected.
//!
//! Ridge snap. Each piece is developed from its centre snapped onto the facet planes of its anchor
//! within ridge_snap(s, tol) = min(1e-14 max(1, s), tol / 10) (chains.rs), which moves it by some
//! mu <= sqrt 3 tol / 10. Moving a piece by mu changes each distance or overlap depth it takes part
//! in by at most mu (a loop at its centre, or its overlap with itself, by 2 mu), so every check
//! compares against tol charged with the displacements: clearance >= 1 - tol + mu_i, centre
//! distances >= 2 - tol + mu_i + mu_j, loops >= 2 - tol + 2 mu_i, hinge depth <= tol - mu_i,
//! part overlaps <= tol - mu_A - mu_B. The charged tolerance never goes below 0 (allowed() below).
//!
//! Untrusted input: the configuration is a JSON value, read as the source reads an unknown
//! JavaScript value, and every rejecting comparison is written so that NaN rejects.

use crate::chains::{clip_segment_to_window, hinge_distance_over_chains, in_window, ridge_snap, ChainNode, ChainOptions, RIDGE_SNAP};
use crate::ids::{is_piece_name, MAX_P};
use crate::linalg::{iso_apply, iso_inverse, iso_linear_t, norm3, point_segment_distance3, quaternion_to_matrix, sub3, Iso3, V3};
use crate::ncube::lattice::is_ncube_name;
use crate::ncube::validate::validate_ncube;
use crate::nd::names::is_nd_name;
use crate::nd::validate::validate_nd;
use crate::parts::{develop_piece, parts_of_development, piece_reach, DevelopError, Development, PART_EPS};
use crate::pieces::{piece_shape, PieceShape};
use crate::polyhedron::{polyhedron_thickness, sat_depth, sat_shape, SatShape};
use crate::polytope::{boundary_volume, cell_excess, get_polytope, is_polytope_name, topo, Polytope};
use crate::types::{BoundaryConfig, BoundaryPiece, BoundaryProblem, BoundaryVerdict};
use crate::units::{BALL_RADIUS, BALL_WORK};
use polypack_js::fmt::{num, precision};
use polypack_js::math;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

/// packages/boundary/src/validate.ts: ValidateOptions. The limits are JavaScript numbers in the
/// source, so they are `f64` here (`None` is `undefined`: the default).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ValidateOptions {
    /// Float tolerance (default 1e-9).
    pub tol: Option<f64>,
    /// Most chains of cells per piece before the configuration is rejected (default 4096).
    pub max_chains: Option<f64>,
    /// Stop collecting reasons after this many (default 20).
    pub max_reasons: Option<f64>,
    /// Platonic pieces: the most pairs of parts tested before the check is refused (default MAX_PAIR_TESTS = 20,000).
    pub max_pairs: Option<f64>,
    /// The d-cubes (ncube/) and the nD containers (nd/): the most search steps of one check (defaults
    /// NCUBE_MAX_WORK and ND_MAX_WORK); max_chains is for the 4-polytopes.
    pub max_work: Option<f64>,
    /// The nD containers only: the most multiply-adds of one check (default ndMaxOps of the container).
    pub max_ops: Option<f64>,
    /// Tests of the rotated-cube rule only (default false): accept a turned cube on the tesseract.
    /// The server never sets it.
    pub turned_cubes: bool,
}

/// What the source throws: a RangeError for a bad tolerance (a caller's mistake), an Error otherwise.
#[derive(Clone, Debug, PartialEq)]
pub enum BoundaryError {
    Range(String),
    Error(String),
}

impl std::fmt::Display for BoundaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BoundaryError::Range(m) | BoundaryError::Error(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for BoundaryError {}

/// Largest accepted edge s. Every meaningful score is far below it: P <= 9999 unit balls already
/// fit at s = 22 and the catalogue's P <= 64 below s = 4, cubes lower still; but a straight row of
/// P unit cubes along one cell, a valid if useless layout, needs s of about P, so 1e4 keeps every
/// such layout of the engine's MAX_P = 9999 pieces checkable. It also keeps the float rule
/// meaningful: local coordinates stay below 1e4, where one rounding unit is 1.8e-12, so tol = 1e-9
/// is still about 500 units and the ridge snap (chains.rs, 1e-14 s) moves a centre by less than 2e-10.
/// packages/boundary/src/validate.ts: MAX_S
pub const MAX_S: f64 = 1e4;

fn capital(x: &str) -> String {
    let mut c = x.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Plural of a piece's name (tetrahedra, cubes, ...). packages/boundary/src/validate.ts: plural
pub fn plural(x: &str) -> String {
    if x.ends_with("hedron") {
        format!("{}a", &x[..x.len() - 2])
    } else {
        format!("{x}s")
    }
}

/// `Number.isFinite(x) ? String(Number(x.toPrecision(10))) : String(x)`.
/// packages/boundary/src/validate.ts: fmt (the same in ncube/validate.ts and nd/validate.ts)
pub(crate) fn fmt(x: f64) -> String {
    if x.is_finite() {
        num(precision(x, 10).parse::<f64>().expect("toPrecision gives a number"))
    } else {
        num(x)
    }
}

/// `String(v)` of a JSON value's number, and the tests `typeof v === "number" && Number.isFinite(v)`.
pub(crate) fn finite_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        _ => None,
    }
}

/// `Number.isInteger(x)` of a finite double.
pub(crate) fn is_integer(x: f64) -> bool {
    x.is_finite() && x == x.trunc()
}

/// The first n entries of x, when x is an array of exactly n finite numbers.
/// packages/boundary/src/validate.ts: finiteNumbers
pub(crate) fn finite_numbers(x: Option<&Value>, n: usize) -> Option<Vec<f64>> {
    let list = match x {
        Some(Value::Array(a)) if a.len() == n => a,
        _ => return None,
    };
    let mut out = Vec::with_capacity(n);
    for v in list {
        out.push(finite_number(Some(v))?);
    }
    Some(out)
}

/// Pushes a reason while fewer than `max_reasons` are collected (the source's `push` closures).
pub(crate) fn push(reasons: &mut Vec<String>, max_reasons: f64, r: String) {
    if (reasons.len() as f64) < max_reasons {
        reasons.push(r);
    }
}

struct Shape<'a> {
    poly: &'a Polytope,
    s: f64,
    pieces: Vec<BoundaryPiece>,
}

/// Checks the problem and the configuration's shape; returns the typed pieces or pushes reasons.
/// `given`: a polytope to use instead of the catalogue's (its name is then not checked).
/// packages/boundary/src/validate.ts: checkShape
fn check_shape<'a>(
    problem: &BoundaryProblem,
    config: &Value,
    tol: f64,
    reasons: &mut Vec<String>,
    max_reasons: f64,
    given: Option<&'a Polytope>,
    turned_cubes: bool,
) -> Result<Option<Shape<'a>>, BoundaryError> {
    // (the source first refuses a problem that is not an object: a BoundaryProblem always is)
    if given.is_none() && !is_polytope_name(&problem.polytope) {
        push(reasons, max_reasons, format!("Unknown polytope \"{}\".", problem.polytope));
    }
    if !is_piece_name(&problem.piece) {
        push(reasons, max_reasons, format!("Unknown piece \"{}\".", problem.piece));
    }
    if !(is_integer(problem.p) && problem.p >= 1.0 && problem.p <= MAX_P) {
        push(reasons, max_reasons, format!("The problem's P must be a whole number from 1 to {}.", num(MAX_P)));
    }
    if !reasons.is_empty() {
        return Ok(None);
    }
    let poly: &'a Polytope = match given {
        Some(p) => p,
        None => get_polytope(&problem.polytope).map_err(BoundaryError::Error)?,
    };
    let dim = poly.d - 1;
    let Value::Object(config) = config else {
        push(reasons, max_reasons, "The configuration must be an object with s and pieces.".to_string());
        return Ok(None);
    };
    let s = finite_number(config.get("s"));
    match s {
        None => push(reasons, max_reasons, "The edge s must be a finite number.".to_string()),
        Some(s) => {
            if !(s > 0.0 && s <= MAX_S) {
                push(reasons, max_reasons, format!("The edge s must be greater than 0 and at most {}; it is {}.", num(MAX_S), fmt(s)));
            }
        }
    }
    let Some(Value::Array(list)) = config.get("pieces") else {
        push(reasons, max_reasons, "The configuration needs a list of pieces.".to_string());
        return Ok(None);
    };
    if list.len() as f64 != problem.p {
        push(reasons, max_reasons, format!("The configuration has {} pieces; the problem needs exactly {}.", list.len(), num(problem.p)));
    }
    if !reasons.is_empty() {
        return Ok(None);
    }
    let s = s.expect("a reason was pushed otherwise");
    let c_count = poly.cells.len();
    let mut pieces: Vec<BoundaryPiece> = Vec::new();
    for (i, raw) in list.iter().enumerate() {
        let Value::Object(raw) = raw else {
            push(reasons, max_reasons, format!("Piece {i} must be an object with cell and u."));
            continue;
        };
        let cell = finite_number(raw.get("cell"));
        let q = raw.get("q");
        let mut ok = true;
        if !matches!(cell, Some(c) if is_integer(c) && c >= 0.0 && c < c_count as f64) {
            push(reasons, max_reasons, format!("Piece {i}: its cell must be a whole number from 0 to {}.", c_count - 1));
            ok = false;
        }
        let u = finite_numbers(raw.get("u"), dim);
        if u.is_none() {
            push(reasons, max_reasons, format!("Piece {i}: its centre u must be {dim} finite numbers."));
            ok = false;
        }
        let mut qv: Option<Vec<f64>> = None;
        if problem.piece == "ball" {
            if q.is_some() {
                push(reasons, max_reasons, format!("Piece {i} is a ball and must not have a rotation q."));
                ok = false;
            }
        } else if q.is_some() {
            qv = finite_numbers(q, 4);
            match &qv {
                None => {
                    push(reasons, max_reasons, format!("Piece {i}: its rotation q must be 4 finite numbers (a unit quaternion w, x, y, z)."));
                    ok = false;
                }
                Some(v) => {
                    let n = math::hypot4(v[0], v[1], v[2], v[3]);
                    if !((n - 1.0).abs() <= 1e-9) {
                        push(reasons, max_reasons, format!("Piece {i}: its rotation q must be a unit quaternion; its length is {}.", fmt(n)));
                        ok = false;
                    } else if given.is_none() && !turned_cubes && problem.polytope == "tesseract" && problem.piece == "cube" && !maps_cube_onto_itself(v) {
                        // boundary/tesseract/cube/P is the axis-aligned cube problem (4.3): a rotation is allowed only when it is one of the cube's 24 symmetries
                        push(
                            reasons,
                            max_reasons,
                            format!("Piece {i}: the cubes of the tesseract are axis-aligned; q must be absent or a rotation that maps the cube onto itself (one of its 24 symmetries), not a turned cube."),
                        );
                        ok = false;
                    }
                }
            }
        }
        let (true, Some(u)) = (ok, u) else { continue };
        let piece = BoundaryPiece { cell: cell.expect("checked") as usize, u, q: qv.map(|v| [v[0], v[1], v[2], v[3]]) };
        let ex = cell_excess(poly, piece.cell, &piece.u, s);
        if !(ex <= tol) {
            push(reasons, max_reasons, format!("Piece {i}: its centre lies outside its anchor cell {} by {}.", piece.cell, fmt(ex)));
        }
        pieces.push(piece);
    }
    if !reasons.is_empty() {
        return Ok(None);
    }
    if pieces.len() as f64 != problem.p {
        return Ok(None);
    }
    Ok(Some(Shape { poly, s, pieces }))
}

/// Distance from u to the anchor cell's own hinges (straight segments inside the cell).
/// packages/boundary/src/validate.ts: inCellHingeDistance
fn in_cell_hinge_distance(poly: &Polytope, cell: usize, u: V3, s: f64) -> f64 {
    let ct = &topo(poly).cells[cell];
    let mut best = f64::INFINITY;
    for &[i, j] in &poly.cells[cell].hinges {
        let a = ct.verts[i];
        let b = ct.verts[j];
        best = math::min(best, point_segment_distance3(u, [a[0] * s, a[1] * s, a[2] * s], [b[0] * s, b[1] * s, b[2] * s]));
    }
    best
}

/// Depth of the segment a + t (b - a), t in [t0, t1], inside the unit cube with pose (R, u):
/// max over t of 1/2 - max_k |(R^T (x(t) - u))_k|. The function is concave piecewise linear in t,
/// so its maximum is at an end or where two of the |.| terms cross or one vanishes.
/// packages/boundary/src/validate.ts: segmentDepthInCube
fn segment_depth_in_cube(r: &[f64; 9], u: V3, a: V3, b: V3, t0: f64, t1: f64) -> f64 {
    let t = Iso3 { m: *r, t: [0.0, 0.0, 0.0] };
    let av = iso_linear_t(&t, sub3(a, u));
    let bv = iso_linear_t(&t, sub3(b, a));
    let g = |t: f64| -> f64 { math::max(math::max((av[0] + t * bv[0]).abs(), (av[1] + t * bv[1]).abs()), (av[2] + t * bv[2]).abs()) };
    let mut cand: Vec<f64> = Vec::with_capacity(11);
    cand.push(t0);
    cand.push(t1);
    for k in 0..3 {
        if bv[k] != 0.0 {
            cand.push(-av[k] / bv[k]);
        }
        for l in k + 1..3 {
            if bv[k] != bv[l] {
                cand.push((av[l] - av[k]) / (bv[k] - bv[l]));
            }
            if bv[k] != -bv[l] {
                cand.push(-(av[l] + av[k]) / (bv[k] + bv[l]));
            }
        }
    }
    let mut best = f64::INFINITY;
    for &t in &cand {
        if t >= t0 && t <= t1 {
            best = math::min(best, g(t));
        }
    }
    0.5 - best
}

/// Depth of the segment a + t (b - a), t in [t0, t1], inside the Platonic solid `shape` with pose
/// (R, u): the maximum over t of min over faces k of (r - n_k . p(t)), p = R^T (x(t) - u), r the
/// inradius. The function is concave piecewise linear in t: its maximum is at an end or where an
/// increasing face function crosses a decreasing one.
/// packages/boundary/src/validate.ts: segmentDepthInShape
fn segment_depth_in_shape(shape: &PieceShape, r_: &[f64; 9], u: V3, a: V3, b: V3, t0: f64, t1: f64) -> f64 {
    let t = Iso3 { m: *r_, t: [0.0, 0.0, 0.0] };
    let av = iso_linear_t(&t, sub3(a, u));
    let bv = iso_linear_t(&t, sub3(b, a));
    let f = shape.normals.len();
    let mut ca = vec![0.0; f];
    let mut cb = vec![0.0; f];
    for k in 0..f {
        let n = shape.normals[k];
        ca[k] = n[0] * av[0] + n[1] * av[1] + n[2] * av[2];
        cb[k] = n[0] * bv[0] + n[1] * bv[1] + n[2] * bv[2];
    }
    let r = shape.inradius;
    // depth at t: r - max_k (ca + t cb)
    let g = |t: f64| -> f64 {
        let mut m = f64::NEG_INFINITY;
        for k in 0..f {
            let x = ca[k] + t * cb[k];
            if x > m {
                m = x;
            }
        }
        r - m
    };
    let mut best = math::max(g(t0), g(t1));
    for i in 0..f {
        if !(cb[i] > 0.0) {
            continue;
        }
        for j in 0..f {
            if !(cb[j] < 0.0) {
                continue;
            }
            // face i's value rises with t, face j's falls: the max over faces is lowest where they cross
            let t = (ca[j] - ca[i]) / (cb[i] - cb[j]);
            if t >= t0 && t <= t1 {
                best = math::max(best, g(t));
            }
        }
    }
    best
}

/// Largest depth of a hinge point inside a piece, over the chains given (hinges clipped to each window).
/// packages/boundary/src/validate.ts: hingeDepthInCube
fn hinge_depth_in_cube(poly: &Polytope, s: f64, nodes: &[ChainNode], r: &[f64; 9], u: V3, shape: &PieceShape) -> f64 {
    let t = topo(poly);
    let mut worst = f64::NEG_INFINITY;
    let mut v: Vec<V3> = Vec::new();
    for node in nodes {
        v.clear();
        v.extend(t.cells[node.cell].verts.iter().map(|p| iso_apply(&node.to_anchor, [p[0] * s, p[1] * s, p[2] * s])));
        for &[i, j] in &poly.cells[node.cell].hinges {
            let Some(iv) = clip_segment_to_window(&node.window, u, v[i], v[j]) else { continue };
            worst = math::max(
                worst,
                if shape.name == "cube" { segment_depth_in_cube(r, u, v[i], v[j], iv.0, iv.1) } else { segment_depth_in_shape(shape, r, u, v[i], v[j], iv.0, iv.1) },
            );
        }
    }
    worst
}

/// The tolerance left after charging a snap displacement m: tol - m, but never below 0, the value
/// at tol 0 (header: for tol > 0 the cap keeps m < tol, so only the rounding-unit snaps of tol 0
/// go uncharged).
/// packages/boundary/src/validate.ts: allowed
fn allowed(tol: f64, m: f64) -> f64 {
    math::max(tol - m, 0.0)
}

/// packages/boundary/src/validate.ts: develop. `Ok(None)` after the chain limit's reason was pushed.
#[allow(clippy::too_many_arguments)]
fn develop(poly: &Polytope, piece: &str, p: &BoundaryPiece, s: f64, reach: f64, max_chains: f64, snap: f64, i: usize, reasons: &mut Vec<String>) -> Result<Option<Development>, BoundaryError> {
    match develop_piece(poly, piece, p, s, reach, &ChainOptions { max_chains: Some(max_chains), max_depth: None, snap: Some(snap) }) {
        Ok(dev) => Ok(Some(dev)),
        Err(DevelopError::ChainLimit(_)) => {
            reasons.push(format!("Piece {i} reaches more than {} chains of cells; the {} is far too small for its pieces.", num(max_chains), poly.name));
            Ok(None)
        }
        Err(DevelopError::Other(e)) => Err(BoundaryError::Error(e)),
    }
}

/// The ball rule in site units (balls of diameter 1): the working code below is written for balls
/// of radius 1, so the lengths, the tolerance and the snaps are converted by BALL_WORK = 2 on entry
/// (exact), and the reasons quote site lengths (units.rs).
/// packages/boundary/src/validate.ts: validateBallsSite
fn validate_balls_site(poly: &Polytope, s: f64, pieces: &[BoundaryPiece], tol: f64, max_chains: f64, max_reasons: f64) -> Result<Vec<String>, BoundaryError> {
    let w = BALL_WORK;
    let scaled: Vec<BoundaryPiece> = pieces.iter().map(|p| BoundaryPiece { cell: p.cell, u: p.u.iter().map(|x| x * w).collect(), q: None }).collect();
    validate_balls(poly, s * w, &scaled, tol * w, max_chains, max_reasons, BALL_RADIUS)
}

#[derive(Clone, Copy)]
struct Entry {
    j: usize,
    y: V3,
    own: bool,
}

/// The ball rule for balls of radius 1: `unit` is the site length of one working unit
/// (1 / BALL_WORK), by which the lengths quoted in the reasons are multiplied.
/// packages/boundary/src/validate.ts: validateBalls
fn validate_balls(poly: &Polytope, s: f64, pieces: &[BoundaryPiece], tol: f64, max_chains: f64, max_reasons: f64, unit: f64) -> Result<Vec<String>, BoundaryError> {
    let q = |x: f64| fmt(x * unit);
    let mut reasons: Vec<String> = Vec::new();
    let name = &poly.name;
    // in-cell clearance first: a straight segment inside the anchor cell is a path
    let mut devs: Vec<Development> = Vec::new();
    for (i, p) in pieces.iter().enumerate() {
        let d = in_cell_hinge_distance(poly, p.cell, [p.u[0], p.u[1], p.u[2]], s);
        if !(d >= 1.0 - tol) {
            push(&mut reasons, max_reasons, format!("Ball {i} is {} from an edge of the {name}; it must be at least {}, or the edge passes through the ball.", q(d), q(1.0)));
        }
    }
    if !reasons.is_empty() {
        return Ok(reasons);
    }
    let snap = ridge_snap(s, Some(tol));
    for (i, p) in pieces.iter().enumerate() {
        let Some(dev) = develop(poly, "ball", p, s, 2.0, max_chains, snap, i, &mut reasons)? else { return Ok(reasons) };
        devs.push(dev);
    }
    // clearance along the chains
    for (i, dev) in devs.iter().enumerate() {
        let d = hinge_distance_over_chains(poly, s, &dev.nodes, dev.u);
        if !(d >= 1.0 - allowed(tol, dev.snapped)) {
            push(
                &mut reasons,
                max_reasons,
                format!("Ball {i} is {} from an edge of the {name} along the boundary; it must be at least {}, or the edge passes through the ball.", q(d), q(1.0)),
            );
        }
    }
    // Centres by cell, in a grid of side 2 (the interaction distance), for the pair checks. A centre
    // on a facet of its anchor (snapped there, chains.rs) is also entered in the neighbour across
    // that facet, mapped into the neighbour's frame (see the header: paths inside a ridge).
    // copies are true path lengths (the unfolding across the ridge), so this threshold is not a tolerance
    let on_facet = RIDGE_SNAP * math::max(1.0, s);
    type Grid = HashMap<(i64, i64, i64), Vec<Entry>>;
    let mut grids: Vec<Grid> = poly.cells.iter().map(|_| HashMap::new()).collect();
    let key = |x: f64, y: f64, z: f64| -> (i64, i64, i64) { (x as i64, y as i64, z as i64) };
    let enter = |grids: &mut Vec<Grid>, cell: usize, e: Entry| {
        let k = key((e.y[0] / 2.0).floor(), (e.y[1] / 2.0).floor(), (e.y[2] / 2.0).floor());
        grids[cell].entry(k).or_default().push(e);
    };
    let t = topo(poly);
    for (j, dev) in devs.iter().enumerate() {
        let cell = pieces[j].cell;
        enter(&mut grids, cell, Entry { j, y: dev.u, own: true });
        let ct = &t.cells[cell];
        for (f, pl) in ct.planes.iter().enumerate() {
            if !((pl.h * s - (pl.n[0] * dev.u[0] + pl.n[1] * dev.u[1] + pl.n[2] * dev.u[2])).abs() <= on_facet) {
                continue;
            }
            let g = &ct.glue[f];
            let y = iso_apply(&Iso3 { m: g.m, t: [g.t[0] * s, g.t[1] * s, g.t[2] * s] }, dev.u);
            enter(&mut grids, poly.cells[cell].facets[f].neighbor, Entry { j, y, own: false });
        }
    }
    // Entries of `cell` whose centres may lie within 2 of p (cell frame).
    let near = |cell: usize, p: V3, out: &mut Vec<Entry>| {
        let g = &grids[cell];
        out.clear();
        let bx = (p[0] / 2.0).floor();
        let by = (p[1] / 2.0).floor();
        let bz = (p[2] / 2.0).floor();
        for a in -1..=1 {
            for b in -1..=1 {
                for c in -1..=1 {
                    if let Some(list) = g.get(&key(bx + a as f64, by + b as f64, bz + c as f64)) {
                        out.extend_from_slice(list);
                    }
                }
            }
        }
    };
    // Stops once maxReasons reasons are collected: without overlaps every grid cell of side 2 holds
    // a bounded number of centres (they are 2 apart in their cell), so the work stays linear in P.
    let mut found: Vec<Entry> = Vec::new();
    for (i, dev) in devs.iter().enumerate() {
        if reasons.len() as f64 >= max_reasons {
            continue;
        }
        let u = dev.u;
        let mut pair_min: BTreeMap<usize, f64> = BTreeMap::new();
        let mut loop_ = f64::INFINITY;
        // thresholds charged with the snap displacements (header)
        let loop_limit = 2.0 - allowed(tol, 2.0 * dev.snapped);
        for (ni, node) in dev.nodes.iter().enumerate() {
            if pair_min.len() as f64 >= max_reasons {
                continue;
            }
            let back = iso_inverse(&node.to_anchor);
            let u_loc = iso_apply(&back, u);
            near(node.cell, u_loc, &mut found);
            for &Entry { j, y, own } in &found {
                if j < i {
                    continue;
                }
                let limit = 2.0 - allowed(tol, dev.snapped + devs[j].snapped);
                // cheap test in the cell's frame first (the development is an isometry)
                if norm3(sub3(y, u_loc)) >= limit {
                    continue;
                }
                if j == i {
                    // loops: the ball's own entry only (a copy across its ridge is the centre itself)
                    if ni == 0 || !own {
                        continue;
                    }
                    let img = iso_apply(&node.to_anchor, y);
                    if !in_window(node, u, img, 0.0) {
                        continue;
                    }
                    loop_ = math::min(loop_, norm3(sub3(img, u)));
                    continue;
                }
                let img = iso_apply(&node.to_anchor, y);
                if !in_window(node, u, img, 0.0) {
                    continue;
                }
                let d = norm3(sub3(img, u));
                let e = pair_min.entry(j).or_insert(f64::INFINITY);
                *e = math::min(*e, d);
            }
        }
        // (the source sorts the pairs by j; a BTreeMap iterates in that order)
        for (j, d) in &pair_min {
            push(
                &mut reasons,
                max_reasons,
                format!("Balls {i} and {j} overlap: their centres are {} apart along the boundary; they must be at least {} apart.", q(*d), q(2.0)),
            );
        }
        if !(loop_ >= loop_limit) {
            push(
                &mut reasons,
                max_reasons,
                format!("Ball {i} overlaps itself: a geodesic loop of length {} leaves and returns to its centre; it must be at least {}.", q(loop_), q(2.0)),
            );
        }
    }
    Ok(reasons)
}

/// True when the unit quaternion turns a cube onto itself: its matrix is a signed permutation matrix
/// to within 1e-9 (the unit-length tolerance).
/// packages/boundary/src/validate.ts: mapsCubeOntoItself
fn maps_cube_onto_itself(q: &[f64]) -> bool {
    quaternion_to_matrix(q).iter().all(|x| math::min(x.abs(), (x.abs() - 1.0).abs()) <= 1e-9)
}

/// Tests of pairs of parts one check may run before it is refused. One separating-axis test costs
/// 0.4 us (tetrahedra) to 8.8 us (icosahedra) in the TypeScript, so 20,000 tests take at most
/// 0.18 s there. Real layouts need 0 to 12 and pieces that pass the edge tests have at most 193
/// chains, so the cap refuses nothing real; it fails closed with a reason.
/// packages/boundary/src/validate.ts: MAX_PAIR_TESTS
pub const MAX_PAIR_TESTS: f64 = 20000.0;

struct PartShape {
    piece: usize,
    sat: SatShape,
    mu: f64,
}

/// The rule for rotated polytope pieces (the cube included; on the tesseract the cube problems use
/// it for their axis-aligned cubes).
/// packages/boundary/src/validate.ts: validatePieces
#[allow(clippy::too_many_arguments)]
fn validate_pieces(poly: &Polytope, piece: &str, s: f64, pieces: &[BoundaryPiece], tol: f64, max_chains: f64, max_reasons: f64, max_pairs: Option<f64>) -> Result<Vec<String>, BoundaryError> {
    let max_pairs = max_pairs.unwrap_or(MAX_PAIR_TESTS);
    let shape = piece_shape(piece).ok_or_else(|| BoundaryError::Error(format!("unknown piece {piece}")))?;
    let one = capital(piece);
    let many = capital(&plural(piece));
    let mut reasons: Vec<String> = Vec::new();
    let name = &poly.name;
    let rot: Vec<[f64; 9]> = pieces.iter().map(|p| match &p.q { Some(q) => quaternion_to_matrix(q), None => [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] }).collect();
    // in-cell hinge test first: the anchor's own edges against the cube
    for (i, p) in pieces.iter().enumerate() {
        let root = ChainNode::root(p.cell);
        let depth = hinge_depth_in_cube(poly, s, std::slice::from_ref(&root), &rot[i], [p.u[0], p.u[1], p.u[2]], shape);
        if !(depth <= tol) {
            push(&mut reasons, max_reasons, format!("{one} {i} has an edge of the {name} passing through its interior (depth {}).", fmt(depth)));
        }
    }
    if !reasons.is_empty() {
        return Ok(reasons);
    }
    let mut shapes: Vec<Vec<PartShape>> = poly.cells.iter().map(|_| Vec::new()).collect();
    let snap = ridge_snap(s, Some(tol));
    for i in 0..pieces.len() {
        if reasons.len() as f64 >= max_reasons {
            return Ok(reasons);
        }
        let Some(dev) = develop(poly, piece, &pieces[i], s, piece_reach(piece), max_chains, snap, i, &mut reasons)? else { return Ok(reasons) };
        let depth = hinge_depth_in_cube(poly, s, &dev.nodes, &rot[i], dev.u, shape);
        if !(depth <= allowed(tol, dev.snapped)) {
            push(&mut reasons, max_reasons, format!("{one} {i} has an edge of the {name} passing through its interior beyond its anchor cell (depth {}).", fmt(depth)));
        }
        for x in parts_of_development(poly, piece, i, &dev, s) {
            let p = x.poly.as_ref().expect("a polytope piece's part has a polyhedron");
            if polyhedron_thickness(p) <= PART_EPS {
                continue;
            }
            shapes[x.part.cell].push(PartShape { piece: i, sat: sat_shape(p), mu: dev.snapped });
        }
    }
    if !reasons.is_empty() {
        return Ok(reasons);
    }
    // Pairs: a uniform grid of side G per cell (2, or the piece's diameter when that is larger), keyed by the low corner of each part's
    // bounding box. A part's extent is at most the piece's diameter (the cube's sqrt 3 < 2) <= G, so two parts whose boxes
    // overlap have low corners within G of each other on every axis: neighbouring grid cells only.
    let g = math::max(2.0, 2.0 * shape.circumradius + 1e-9);
    let mut pairs = 0.0f64;
    for (cell, list) in shapes.iter().enumerate() {
        if reasons.len() as f64 >= max_reasons {
            continue;
        }
        let mut grid: HashMap<(i64, i64, i64), Vec<usize>> = HashMap::new();
        let at: Vec<[f64; 3]> = list.iter().map(|a| [(a.sat.lo[0] / g).floor(), (a.sat.lo[1] / g).floor(), (a.sat.lo[2] / g).floor()]).collect();
        for a in 0..list.len() {
            grid.entry((at[a][0] as i64, at[a][1] as i64, at[a][2] as i64)).or_default().push(a);
        }
        // (a `return` inside the source's forEach callback ends this cell only)
        'cell: for a in 0..list.len() {
            if reasons.len() as f64 >= max_reasons {
                break 'cell;
            }
            let pa = &list[a];
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let Some(bucket) = grid.get(&((at[a][0] + dx as f64) as i64, (at[a][1] + dy as f64) as i64, (at[a][2] + dz as f64) as i64)) else { continue };
                        for &b in bucket {
                            if b <= a {
                                continue;
                            }
                            let pb = &list[b];
                            // the tolerance charged with both pieces' snap displacements (header)
                            let thr = allowed(tol, pa.mu + pb.mu);
                            // bounding boxes overlapping by more than thr on every axis
                            if !(math::min(pa.sat.hi[0], pb.sat.hi[0]) - math::max(pa.sat.lo[0], pb.sat.lo[0]) > thr) {
                                continue;
                            }
                            if !(math::min(pa.sat.hi[1], pb.sat.hi[1]) - math::max(pa.sat.lo[1], pb.sat.lo[1]) > thr) {
                                continue;
                            }
                            if !(math::min(pa.sat.hi[2], pb.sat.hi[2]) - math::max(pa.sat.lo[2], pb.sat.lo[2]) > thr) {
                                continue;
                            }
                            // the work cap: a check that needs more separating-axis tests than this is refused, never accepted
                            pairs += 1.0;
                            if pairs > max_pairs {
                                push(
                                    &mut reasons,
                                    max_reasons,
                                    format!("The check needs more than {} tests of pairs of parts; the configuration is too crowded for the server to check.", num(max_pairs)),
                                );
                                break 'cell;
                            }
                            // stops early once an axis shows an overlap <= thr; otherwise it is the full penetration depth
                            let depth = sat_depth(&pa.sat, &pb.sat, thr);
                            if depth <= thr {
                                continue;
                            }
                            if pa.piece == pb.piece {
                                push(&mut reasons, max_reasons, format!("{one} {} overlaps itself in cell {cell} (depth {}).", pa.piece, fmt(depth)));
                            } else {
                                let (i, j) = if pa.piece < pb.piece { (pa.piece, pb.piece) } else { (pb.piece, pa.piece) };
                                push(&mut reasons, max_reasons, format!("{many} {i} and {j} overlap in cell {cell} (depth {}).", fmt(depth)));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(reasons)
}

/// Validates a configuration (untrusted input, a JSON value) for a problem. Returns ok with the
/// score s, or the reasons it is invalid as plain sentences. A bad tol (a caller's mistake) is the
/// source's RangeError: `Err(BoundaryError::Range)`.
/// packages/boundary/src/validate.ts: validateBoundary
pub fn validate_boundary(problem: &BoundaryProblem, config: &Value, opts: &ValidateOptions) -> Result<BoundaryVerdict, BoundaryError> {
    // the d-cubes (d = 5..10) have their own validator, with the same rule (ncube/validate.rs)
    if is_ncube_name(&problem.polytope) {
        // the d-cubes take balls and axis-aligned cubes only
        if problem.piece != "ball" && problem.piece != "cube" {
            return Ok(BoundaryVerdict { ok: false, score: None, reasons: vec![format!("The {} takes balls and cubes only, not \"{}\".", problem.polytope, problem.piece)] });
        }
        return validate_ncube(problem, config, opts);
    }
    // the simplex, orthoplex and demicube take balls only (validate_nd refuses any other piece in its own words)
    if is_nd_name(&problem.polytope) {
        return Ok(validate_nd(problem, config, opts));
    }
    run(problem, config, opts, None)
}

/// `validate_boundary` for a typed configuration (what the server's parser gives).
pub fn validate_boundary_config(problem: &BoundaryProblem, config: &BoundaryConfig, opts: &ValidateOptions) -> Result<BoundaryVerdict, BoundaryError> {
    let value = serde_json::to_value(config).map_err(|e| BoundaryError::Error(e.to_string()))?;
    validate_boundary(problem, &value, opts)
}

/// The same rule on any polytope built with build_polytope (for polytopes not yet in the catalogue,
/// and for tests): P pieces of one kind, configuration as for validate_boundary.
/// packages/boundary/src/validate.ts: validateOn
pub fn validate_on(poly: &Polytope, piece: &str, p: f64, config: &Value, opts: &ValidateOptions) -> Result<BoundaryVerdict, BoundaryError> {
    run(&BoundaryProblem { polytope: poly.name.clone(), piece: piece.to_string(), p }, config, opts, Some(poly))
}

/// `mr >= 1 ? Math.floor(mr) : 1` of an optional limit with a default.
pub(crate) fn limit(x: Option<f64>, default: f64) -> f64 {
    let v = x.unwrap_or(default);
    if v >= 1.0 {
        v.floor()
    } else {
        1.0
    }
}

/// packages/boundary/src/validate.ts: run
fn run(problem: &BoundaryProblem, config: &Value, opts: &ValidateOptions, given: Option<&Polytope>) -> Result<BoundaryVerdict, BoundaryError> {
    let tol = opts.tol.unwrap_or(1e-9);
    // a caller's mistake, not the submitter's: no tolerance may make everything pass
    if !(tol.is_finite() && tol >= 0.0) {
        return Err(BoundaryError::Range(format!("validateBoundary: tol must be a finite number >= 0, not {}", num(tol))));
    }
    // at least one reason and one chain, so that the early stops can never accept anything
    let max_reasons = limit(opts.max_reasons, 20.0);
    let max_chains = limit(opts.max_chains, 4096.0);
    let mut reasons: Vec<String> = Vec::new();
    let Some(shape) = check_shape(problem, config, tol, &mut reasons, max_reasons, given, opts.turned_cubes)? else {
        return Ok(BoundaryVerdict { ok: false, score: None, reasons: if reasons.is_empty() { vec!["The configuration is malformed.".to_string()] } else { reasons } });
    };
    let Shape { poly, s, pieces } = shape;
    // Volume bound [CALC]: developments are injective on interiors and interiors are disjoint, so
    // the pieces' volumes add up to at most the boundary's (the relative margin 1e-6 absorbs
    // overlaps within tol). Cheap, and it keeps huge P at small s away from the chain stage.
    let piece_volume = if problem.piece == "ball" {
        (4.0 * math::PI * math::pow(BALL_RADIUS, 3.0)) / 3.0
    } else {
        piece_shape(&problem.piece).ok_or_else(|| BoundaryError::Error(format!("unknown piece {}", problem.piece)))?.volume
    };
    let volume = boundary_volume(poly) * math::pow(s, 3.0);
    let count = pieces.len() as f64;
    if !(count * piece_volume <= volume * (1.0 + 1e-6)) {
        return Ok(BoundaryVerdict {
            ok: false,
            score: None,
            reasons: vec![format!(
                "{} {} have a total volume of {}, more than the {} of the {}'s boundary at s = {}.",
                pieces.len(),
                plural(&problem.piece),
                fmt(count * piece_volume),
                fmt(volume),
                poly.name,
                fmt(s)
            )],
        });
    }
    let geo = if problem.piece == "ball" {
        validate_balls_site(poly, s, &pieces, tol, max_chains, max_reasons)?
    } else {
        validate_pieces(poly, &problem.piece, s, &pieces, tol, max_chains, max_reasons, opts.max_pairs)?
    };
    Ok(if geo.is_empty() { BoundaryVerdict { ok: true, score: Some(s), reasons: vec![] } } else { BoundaryVerdict { ok: false, score: None, reasons: geo } })
}
