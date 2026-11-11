//! The validator of the surface family: regular polygons and disks on the surface of a solid,
//! folding over its edges (fold) or each inside one face (nofold).
//! Port of what the server reaches of `packages/surface/src/validate.ts`.
//!
//! The TypeScript writes each check as a generator that yields between pieces and every 32 pairs,
//! so that `validateAsync` can give the event loop a turn; `validate` drains the same generator.
//! Here each check is a plain function (native/PORTING.md, rule 5): `validate` gives what both
//! `validate` and `validateAsync` give. Both stop as soon as `max_errors` errors are found, and
//! skip pairs whose pieces (or developed parts) have centres farther apart than two circumradii:
//! such pieces cannot meet.

use crate::chains::{enumerate_chains, in_wedge, ChainError, ChainNode};
use crate::disk::{disk_separation, piece_reach, SURFACE_DISK_RADIUS};
use crate::geometry::{axes_of, bounding_radius, inradius, piece_vertices, regular_polygon_separation_with, TOL};
use crate::parts::{part_separation, piece_chains, piece_parts, Part, SurfacePose};
use crate::rigid::apply;
use crate::solids::{face_depth, face_vertex, get_solid, is_solid_name, Solid};
use polypack_js::fmt;
use polypack_js::math;
use polypack_js::math::PI;

/// `packages/surface/src/validate.ts: Mode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Fold,
    Nofold,
}

impl Mode {
    /// The mode of a string as `validate` reads it: "fold" is fold, anything else nofold
    /// (`mode === "fold" ? validateFold : validateNofold`).
    pub fn of(mode: &str) -> Mode {
        if mode == "fold" {
            Mode::Fold
        } else {
            Mode::Nofold
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Fold => "fold",
            Mode::Nofold => "nofold",
        }
    }
}

/// `packages/surface/src/validate.ts: SurfaceConfig`. A configuration on a solid of edge s. Pieces
/// have side 1 (N >= 3) or diameter 1 (N = 0, radius 1/2).
///
/// `n` and each piece's `face` are numbers as in the TypeScript: `check_shape` refuses the ones
/// that are not what they must be, with the TypeScript's messages.
#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceConfig {
    pub solid: String,
    pub n: f64,
    pub s: f64,
    pub pieces: Vec<SurfacePose>,
}

/// `packages/surface/src/validate.ts: Validation`.
#[derive(Clone, Debug)]
pub struct Validation {
    pub ok: bool,
    pub errors: Vec<String>,
    /// smallest signed clearance found between pieces (or parts of one piece), in piece units
    pub min_pair_sep: f64,
    /// smallest clearance between a piece interior and a cone point (negative: cone point inside)
    pub min_cone_sep: f64,
    /// smallest clearance of a piece to its face boundary (nofold only)
    pub min_wall_sep: f64,
}

/// `packages/surface/src/validate.ts: ValidateOptions`, with the defaults the checks give the
/// fields that are left out (`ValidateOptions::default()`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ValidateOptions {
    /// default TOL = 1e-9
    pub tol: f64,
    /// pieces scaled about their centres (1 = unit pieces)
    pub scale: f64,
    /// stop collecting errors after this many (default 50)
    pub max_errors: usize,
    /// fold: most chains of faces per piece; more are a `ChainError::ChainLimit` (default
    /// `f64::INFINITY`: no limit)
    pub max_chains: f64,
}

impl Default for ValidateOptions {
    fn default() -> Self {
        ValidateOptions { tol: TOL, scale: 1.0, max_errors: 50, max_chains: f64::INFINITY }
    }
}

/// `Number.isInteger`.
fn is_integer(x: f64) -> bool {
    x.is_finite() && x == x.trunc()
}

/// `packages/surface/src/validate.ts: checkShape`. The solid of a configuration whose fields are
/// what they must be, or None with the reasons pushed to `errors`.
fn check_shape(cfg: &SurfaceConfig, errors: &mut Vec<String>) -> Option<&'static Solid> {
    if !is_solid_name(&cfg.solid) {
        errors.push(format!("unknown solid {}", cfg.solid));
        return None;
    }
    // a solid of the list always builds (the comparison tool builds all 141)
    let solid = get_solid(&cfg.solid).expect("a solid of the list");
    if !(is_integer(cfg.n) && (cfg.n == 0.0 || cfg.n >= 3.0)) {
        errors.push("N must be 0 or an integer >= 3".to_string());
    }
    if !(cfg.s.is_finite() && cfg.s > 0.0) {
        errors.push("s must be a positive finite number".to_string());
    }
    if cfg.pieces.is_empty() {
        errors.push("pieces must be a non-empty array".to_string());
    }
    if !errors.is_empty() {
        return None;
    }
    for (i, p) in cfg.pieces.iter().enumerate() {
        if !is_integer(p.face) || p.face < 0.0 || p.face >= solid.f as f64 {
            errors.push(format!("pieces[{i}].face out of range"));
        } else if ![p.x, p.y, p.theta].iter().all(|v| v.is_finite()) {
            errors.push(format!("pieces[{i}] needs finite x, y, theta"));
        }
    }
    if errors.is_empty() {
        Some(solid)
    } else {
        None
    }
}

/// `packages/surface/src/validate.ts: empty`.
fn empty(errors: Vec<String>) -> Validation {
    Validation { ok: false, errors, min_pair_sep: f64::NAN, min_cone_sep: f64::NAN, min_wall_sep: f64::NAN }
}

/// `packages/surface/src/validate.ts: validateNofold` (the generator `nofoldCheck`, drained).
/// nofold: every piece lies in its closed anchor face; pieces on one face have disjoint interiors.
/// Faces meet only along edges, so pieces on different faces never overlap.
pub fn validate_nofold(cfg: &SurfaceConfig, opts: &ValidateOptions) -> Validation {
    let tol = opts.tol;
    let scale = opts.scale;
    let max_errors = opts.max_errors;
    let mut errors: Vec<String> = Vec::new();
    let Some(solid) = check_shape(cfg, &mut errors) else {
        return empty(errors);
    };
    let n = cfg.n as usize;
    let s = cfg.s;
    let mut min_wall = f64::INFINITY;
    let mut min_pair = f64::INFINITY;
    for (i, p) in cfg.pieces.iter().enumerate() {
        let face = p.face_index();
        let depth;
        if n == 0 {
            depth = face_depth(solid, s, face, p.x, p.y) - scale * SURFACE_DISK_RADIUS;
        } else {
            let v = piece_vertices(n, p.pose(), scale);
            let mut d = f64::INFINITY;
            for k in 0..n {
                d = math::min(d, face_depth(solid, s, face, v[2 * k], v[2 * k + 1]));
            }
            depth = d;
        }
        min_wall = math::min(min_wall, depth);
        if depth < -tol && errors.len() < max_errors {
            errors.push(format!("piece {} leaves face {} by {}", i, fmt::num(p.face), fmt::num(-depth)));
        }
    }
    let result = |errors: Vec<String>, min_pair: f64| Validation {
        ok: errors.is_empty(),
        errors,
        min_pair_sep: min_pair,
        min_cone_sep: f64::INFINITY,
        min_wall_sep: min_wall,
    };
    if errors.len() >= max_errors {
        return result(errors, min_pair);
    }
    let reach = 2.0 * scale * piece_reach(n) * (1.0 + 1e-9) + 1e-12;
    // The edge normals of each piece, filled when a pair first needs them: the TypeScript's
    // regularPolygonSeparation reads them from a memo of pure functions of (N, theta)
    // (packages/geometry/src/trig.ts), so they are the same doubles.
    let mut axes: Vec<Option<Vec<f64>>> = vec![None; if n == 0 { 0 } else { cfg.pieces.len() }];
    for i in 0..cfg.pieces.len() {
        for j in i + 1..cfg.pieces.len() {
            let a = &cfg.pieces[i];
            let b = &cfg.pieces[j];
            if a.face != b.face || math::hypot(a.x - b.x, a.y - b.y) > reach {
                continue;
            }
            // planarSeparation(N, a, b, scale)
            let sep = if n == 0 {
                disk_separation(a.pose(), b.pose(), scale)
            } else {
                if axes[i].is_none() {
                    axes[i] = Some(axes_of(n, a.theta));
                }
                if axes[j].is_none() {
                    axes[j] = Some(axes_of(n, b.theta));
                }
                regular_polygon_separation_with(n, a.pose(), b.pose(), axes[i].as_ref().unwrap(), axes[j].as_ref().unwrap(), scale)
            };
            min_pair = math::min(min_pair, sep);
            if sep < -tol {
                errors.push(format!("pieces {} and {} overlap on face {} by {}", i, j, fmt::num(a.face), fmt::num(-sep)));
                if errors.len() >= max_errors {
                    return result(errors, min_pair);
                }
            }
        }
    }
    result(errors, min_pair)
}

/// `packages/surface/src/validate.ts: chainImages`. Developed images of a point q (face fq, frame
/// coords) seen from p along chains: [x, y, length].
pub fn chain_images(nodes: &[ChainNode], px: f64, py: f64, fq: usize, qx: f64, qy: f64, tol: f64, skip_root: bool) -> Vec<[f64; 3]> {
    let mut out: Vec<[f64; 3]> = Vec::new();
    for (idx, node) in nodes.iter().enumerate() {
        if node.face != fq || (skip_root && idx == 0) {
            continue;
        }
        let (x, y) = apply(&node.to_anchor, qx, qy);
        if !in_wedge(node.wedge.as_ref(), px, py, x, y, tol) {
            continue;
        }
        out.push([x, y, math::hypot(x - px, y - py)]);
    }
    out
}

/// `packages/surface/src/validate.ts: coneClearance`. Cone-point clearance of a piece: smallest
/// distance of a vertex to the piece's boundary (negative = inside).
fn cone_clearance(solid: &Solid, s: f64, n: usize, pose: &SurfacePose, nodes: &[ChainNode], scale: f64, tol: f64) -> f64 {
    let mut worst = f64::INFINITY;
    let rin = if n == 0 { scale * SURFACE_DISK_RADIUS } else { inradius(n) * scale };
    // The directions of the piece's edge normals do not depend on the vertex tested: the
    // TypeScript computes cos(a) and sin(a) inside the loop over vertices, here they are computed
    // once (the same expressions, so the same doubles).
    let mut normals: Vec<(f64, f64)> = Vec::with_capacity(n);
    for j in 0..n {
        let a = pose.theta + PI / 2.0 + PI / n as f64 + (2.0 * PI * j as f64) / n as f64;
        normals.push((math::cos(a), math::sin(a)));
    }
    for node in nodes {
        let m = solid.sides[node.face];
        for k in 0..m {
            let (fx, fy) = face_vertex(solid, s, node.face, k);
            let (x, y) = apply(&node.to_anchor, fx, fy);
            if !in_wedge(node.wedge.as_ref(), pose.x, pose.y, x, y, tol) {
                continue;
            }
            let mut out;
            if n == 0 {
                out = math::hypot(x - pose.x, y - pose.y) - scale * SURFACE_DISK_RADIUS;
            } else {
                // largest support excess over the apothem: > 0 means outside the polygon
                out = f64::NEG_INFINITY;
                for &(c, sn) in &normals {
                    out = math::max(out, (x - pose.x) * c + (y - pose.y) * sn - rin);
                }
            }
            if out < worst {
                worst = out;
            }
        }
    }
    worst
}

/// `packages/surface/src/validate.ts: validateFold` (the generator `foldCheck`, drained).
/// fold: rigid flat pieces developed from their centres across edges.
/// Valid when (1) every centre lies in its closed anchor face, (2) no cone point lies in the open
/// interior of a piece, (3) on every face, the parts of all pieces (two parts of one piece
/// included) have disjoint interiors. (3) for parts of one piece is the embedding condition.
/// Disks use the equivalent distance form (see docs/spaces/SURFACE.md): vertex distance >= 1/2,
/// centre distance >= 1, geodesic loops at a centre >= 1 (disks of diameter 1).
///
/// The `Err` is what the TypeScript throws: a `ChainError::ChainLimit` when a piece has more than
/// `max_chains` chains of faces, a `ChainError::Other` at the chain depth limit.
pub fn validate_fold(cfg: &SurfaceConfig, opts: &ValidateOptions) -> Result<Validation, ChainError> {
    let tol = opts.tol;
    let scale = opts.scale;
    let max_errors = opts.max_errors;
    let max_chains = opts.max_chains;
    let mut errors: Vec<String> = Vec::new();
    let Some(solid) = check_shape(cfg, &mut errors) else {
        return Ok(empty(errors));
    };
    let n = cfg.n as usize;
    let s = cfg.s;
    fn push(errors: &mut Vec<String>, max_errors: usize, e: String) {
        if errors.len() < max_errors {
            errors.push(e);
        }
    }
    let mut min_pair = f64::INFINITY;
    let mut min_cone = f64::INFINITY;
    for (i, p) in cfg.pieces.iter().enumerate() {
        let d = face_depth(solid, s, p.face_index(), p.x, p.y);
        if d < -tol {
            push(&mut errors, max_errors, format!("centre of piece {} is outside its face {} by {}", i, fmt::num(p.face), fmt::num(-d)));
        }
    }
    if !errors.is_empty() {
        return Ok(Validation { ok: false, errors, min_pair_sep: f64::NAN, min_cone_sep: f64::NAN, min_wall_sep: f64::INFINITY });
    }

    if n == 0 {
        let reach = 2.0 * scale * SURFACE_DISK_RADIUS;
        let mut nodes: Vec<Vec<ChainNode>> = Vec::with_capacity(cfg.pieces.len());
        for p in &cfg.pieces {
            nodes.push(enumerate_chains(solid, s, p.face_index(), p.x, p.y, reach, max_chains)?);
        }
        for i in 0..cfg.pieces.len() {
            let p = &cfg.pieces[i];
            if errors.len() >= max_errors {
                break;
            }
            let c = cone_clearance(solid, s, 0, p, &nodes[i], scale, tol);
            min_cone = math::min(min_cone, c);
            if c < -tol {
                push(&mut errors, max_errors, format!("a cone point lies inside disk {} (by {})", i, fmt::num(-c)));
            }
            // Images use the exact wedge (tolerance 0): an image on a wedge boundary is a path through a
            // vertex, of length d(p, V) + d(V, q), which the vertex check already bounds below by one diameter, and
            // a tolerance would admit paths that do not exist (slightly shorter than a diameter near a touched vertex).
            for [_, _, d] in chain_images(&nodes[i], p.x, p.y, p.face_index(), p.x, p.y, 0.0, true) {
                let sep = d - 2.0 * scale * SURFACE_DISK_RADIUS;
                min_pair = math::min(min_pair, sep);
                if sep < -tol {
                    push(&mut errors, max_errors, format!("disk {} wraps onto itself (geodesic loop {})", i, fmt::num(d)));
                }
            }
            for j in i + 1..cfg.pieces.len() {
                let q = &cfg.pieces[j];
                for [_, _, d] in chain_images(&nodes[i], p.x, p.y, q.face_index(), q.x, q.y, 0.0, false) {
                    let sep = d - 2.0 * scale * SURFACE_DISK_RADIUS;
                    min_pair = math::min(min_pair, sep);
                    if sep < -tol {
                        push(&mut errors, max_errors, format!("disks {} and {} overlap (centre distance {})", i, j, fmt::num(d)));
                    }
                }
            }
        }
        return Ok(Validation { ok: errors.is_empty(), errors, min_pair_sep: min_pair, min_cone_sep: min_cone, min_wall_sep: f64::INFINITY });
    }

    let mut by_face: Vec<Vec<Part>> = (0..solid.f).map(|_| Vec::new()).collect();
    let result = |errors: Vec<String>, min_pair: f64, min_cone: f64| Validation {
        ok: errors.is_empty(),
        errors,
        min_pair_sep: min_pair,
        min_cone_sep: min_cone,
        min_wall_sep: f64::INFINITY,
    };
    for (i, p) in cfg.pieces.iter().enumerate() {
        let nodes = piece_chains(solid, s, n, p, scale, max_chains)?;
        let c = cone_clearance(solid, s, n, p, &nodes, scale, tol);
        min_cone = math::min(min_cone, c);
        if c < -tol {
            push(&mut errors, max_errors, format!("a cone point lies inside piece {} (depth {})", i, fmt::num(-c)));
        }
        if errors.len() >= max_errors {
            return Ok(result(errors, min_pair, min_cone));
        }
        for part in piece_parts(solid, s, n, p, i, scale, &nodes) {
            if part.poly.len() >= 6 {
                by_face[part.face].push(part);
            }
        }
    }
    // a part lies within the circumradius of its developed centre (cx, cy), so parts whose centres are
    // farther apart than two circumradii cannot meet
    let reach = 2.0 * scale * bounding_radius(n) * (1.0 + 1e-9) + 1e-12;
    for f in 0..solid.f {
        let list = &by_face[f];
        for a in 0..list.len() {
            for b in a + 1..list.len() {
                let pa = &list[a];
                let pb = &list[b];
                if math::hypot(pa.cx - pb.cx, pa.cy - pb.cy) > reach {
                    continue;
                }
                // axes from the half-planes the parts were cut from, not from their clipped sides (parts.rs)
                let sep = part_separation(pa, pb);
                min_pair = math::min(min_pair, sep);
                if sep < -tol {
                    if pa.piece == pb.piece {
                        push(&mut errors, max_errors, format!("piece {} overlaps itself on face {} (depth {})", pa.piece, f, fmt::num(-sep)));
                    } else {
                        push(
                            &mut errors,
                            max_errors,
                            format!("pieces {} and {} overlap on face {} (depth {})", pa.piece, pb.piece, f, fmt::num(-sep)),
                        );
                    }
                    if errors.len() >= max_errors {
                        return Ok(result(errors, min_pair, min_cone));
                    }
                }
            }
        }
    }
    Ok(result(errors, min_pair, min_cone))
}

/// `packages/surface/src/validate.ts: validate`, and `validateAsync` (the same check in slices,
/// with timings the Rust server takes itself). The `Err` is what the TypeScript throws (fold only).
pub fn validate(cfg: &SurfaceConfig, mode: Mode, opts: &ValidateOptions) -> Result<Validation, ChainError> {
    match mode {
        Mode::Fold => validate_fold(cfg, opts),
        Mode::Nofold => Ok(validate_nofold(cfg, opts)),
    }
}
