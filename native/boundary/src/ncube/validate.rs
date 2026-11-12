//! Float validator of the d-cube problems (d = 5..10, docs/spaces/BOUNDARY.md section 4B),
//! tolerance tol (default 1e-9). Port of packages/boundary/src/ncube/validate.ts.
//!
//! The rule is the tesseract's (validate.rs, BOUNDARY.md 3): centres in their closed anchor cells
//! (within tol), no hinge (a (d-3)-face) inside a piece, no piece overlapping itself, interiors of
//! distinct pieces disjoint. The d-cube's lattice makes it exact in closed form (lattice.rs):
//!  - Balls (diameter 1): every centre at geodesic distance >= 1/2 - tol from the hinges (closed
//!    form), every two centres >= 1 - tol apart along every realised word, every geodesic loop at a
//!    centre >= 1 - tol. The words are found by reach (lattice.rs), for the pairs whose centres are
//!    < 1 apart in R^d only (the geodesic is never shorter than the chord).
//!  - Axis-aligned cubes (edge 1, no rotation): the cube centred at u is the box u +- 1/2. It
//!    crosses axis k when |u_k| + 1/2 > h + tol; valid alone exactly when it crosses at most one axis
//!    (4.3: two crossed axes put the anchor's own hinge inside it); its parts are the box clipped to
//!    the anchor and, beyond a crossed face, a slab in the neighbour; parts of distinct cubes in a
//!    cell must not overlap by more than tol in all axes. A rotated cube is not a d-cube problem
//!    here (`q` is refused).
//! No ridge snap is needed: every gluing is an exact signed permutation, so a piece is developed
//! without rounding.
//!
//! Work is capped. A check stops after opts.max_work search steps (default NCUBE_MAX_WORK) and
//! refuses the configuration with a plain reason, so a packing that crowds many balls against the
//! hinges of a high-dimensional cube is refused (sound, incomplete); the pair stage bins centres
//! (balls) or the parts' corners (cubes) in a uniform grid, so the work is linear in P, and it
//! stops after max_reasons reasons.

use super::bounds::unit_ball_volume;
use super::lattice::{axes_of, embed_cell, is_ncube_name, ncube_clearance, ncube_dim, new_budget, realised_words, start_map, step_map, RealisedOptions, WordLimitError};
use crate::types::{BoundaryProblem, BoundaryVerdict};
use crate::validate::{finite_number, finite_numbers, fmt, is_integer, limit, push, BoundaryError, ValidateOptions, MAX_S};
use polypack_js::fmt::num;
use polypack_js::math;
use serde_json::Value;
use std::collections::HashMap;

/// Search steps (lattice.rs) one check may spend: about a second on one core of the TypeScript ([CALC] BOUNDARY.md 4B).
/// packages/boundary/src/ncube/validate.ts: NCUBE_MAX_WORK
pub const NCUBE_MAX_WORK: f64 = 4_000_000.0;

/// packages/boundary/src/ncube/validate.ts: NCubeConfig
#[derive(Clone, Debug, PartialEq)]
pub struct NCubeConfig {
    pub s: f64,
    pub pieces: Vec<NCubePiece>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NCubePiece {
    pub cell: usize,
    pub u: Vec<f64>,
}

/// Checks the shape of a configuration; returns the typed pieces or pushes reasons.
/// packages/boundary/src/ncube/validate.ts: readNCubeConfig
pub fn read_ncube_config(problem: &BoundaryProblem, config: &Value, tol: f64, reasons: &mut Vec<String>, max_reasons: f64) -> Option<NCubeConfig> {
    let d = ncube_dim(&problem.polytope);
    if d == 0 {
        push(reasons, max_reasons, format!("Unknown polytope \"{}\".", problem.polytope));
        return None;
    }
    let n = d - 1;
    let Value::Object(config) = config else {
        push(reasons, max_reasons, "The configuration must be an object with s and pieces.".to_string());
        return None;
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
        return None;
    };
    if list.len() as f64 != problem.p {
        push(reasons, max_reasons, format!("The configuration has {} pieces; the problem needs exactly {}.", list.len(), num(problem.p)));
    }
    if !reasons.is_empty() {
        return None;
    }
    let s = s.expect("a reason was pushed otherwise");
    let h = s / 2.0;
    let mut pieces: Vec<NCubePiece> = Vec::new();
    for (i, raw) in list.iter().enumerate() {
        let Value::Object(raw) = raw else {
            push(reasons, max_reasons, format!("Piece {i} must be an object with cell and u."));
            continue;
        };
        let mut ok = true;
        let cell = finite_number(raw.get("cell"));
        if !matches!(cell, Some(c) if is_integer(c) && c >= 0.0 && c < (2 * d) as f64) {
            push(reasons, max_reasons, format!("Piece {i}: its cell must be a whole number from 0 to {}.", 2 * d - 1));
            ok = false;
        }
        let u = finite_numbers(raw.get("u"), n);
        if u.is_none() {
            push(reasons, max_reasons, format!("Piece {i}: its centre u must be {n} finite numbers."));
            ok = false;
        }
        if raw.get("q").is_some() {
            push(reasons, max_reasons, format!("Piece {i}: a piece on the {} has no rotation q (cubes stay axis-aligned).", problem.polytope));
            ok = false;
        }
        let (true, Some(u)) = (ok, u) else { continue };
        let cell = cell.expect("checked");
        let mut m = f64::NEG_INFINITY;
        for x in &u {
            m = math::max(m, x.abs());
        }
        let ex = m - h;
        if !(ex <= tol) {
            push(reasons, max_reasons, format!("Piece {i}: its centre lies outside its anchor cell {} by {}.", num(cell), fmt(ex)));
        }
        pieces.push(NCubePiece { cell: cell as usize, u });
    }
    if !reasons.is_empty() {
        return None;
    }
    Some(NCubeConfig { s, pieces })
}

/// Pairs of pieces by index whose R^d centres are less than `reach` apart (a grid on the first four coordinates).
/// packages/boundary/src/ncube/validate.ts: nearPairs
pub fn near_pairs(d: usize, cells: &[usize], u: &[f64], n: usize, h: f64, reach: f64) -> Vec<(usize, usize)> {
    let p = cells.len();
    let x: Vec<Vec<f64>> = cells.iter().enumerate().map(|(i, &c)| embed_cell(d, c, u, i * n, h)).collect();
    let mut g: HashMap<(i64, i64, i64, i64), Vec<usize>> = HashMap::new();
    let key = |x: &[f64], a: i64, b: i64, c: i64, e: i64| -> (i64, i64, i64, i64) {
        (((x[0] / reach).floor() + a as f64) as i64, ((x[1] / reach).floor() + b as f64) as i64, ((x[2] / reach).floor() + c as f64) as i64, ((x[3] / reach).floor() + e as f64) as i64)
    };
    for i in 0..p {
        g.entry(key(&x[i], 0, 0, 0, 0)).or_default().push(i);
    }
    let mut out: Vec<(usize, usize)> = Vec::new();
    let r2 = reach * reach;
    for i in 0..p {
        for a in -1..=1 {
            for b in -1..=1 {
                for c in -1..=1 {
                    for e in -1..=1 {
                        let Some(list) = g.get(&key(&x[i], a, b, c, e)) else { continue };
                        for &j in list {
                            if j <= i {
                                continue;
                            }
                            let mut q = 0.0;
                            for t in 0..d {
                                q += (x[i][t] - x[j][t]) * (x[i][t] - x[j][t]);
                            }
                            if q < r2 {
                                out.push((i, j));
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// packages/boundary/src/ncube/validate.ts: validateBalls
fn validate_balls(d: usize, name: &str, cfg: &NCubeConfig, tol: f64, max_reasons: f64, max_work: f64) -> Vec<String> {
    let mut reasons: Vec<String> = Vec::new();
    let n = d - 1;
    let s = cfg.s;
    let pieces = &cfg.pieces;
    let h = s / 2.0;
    let p = pieces.len();
    let mut u = vec![0.0; n * p];
    let mut cells: Vec<usize> = Vec::with_capacity(p);
    for (i, piece) in pieces.iter().enumerate() {
        u[i * n..i * n + n].copy_from_slice(&piece.u);
        cells.push(piece.cell);
    }
    for i in 0..p {
        let c = ncube_clearance(&u, i * n, n, h);
        if !(c >= 0.5 - tol) {
            push(&mut reasons, max_reasons, format!("Ball {i} is {} from a (d-3)-face of the {name}; it must be at least 0.5, or the face passes through the ball.", fmt(c)));
        }
    }
    if !reasons.is_empty() {
        return reasons;
    }
    let mut budget = new_budget(max_work);
    let mut search = |reasons: &mut Vec<String>| -> Result<(), WordLimitError> {
        let limit = 1.0 - tol;
        for (i, j) in near_pairs(d, &cells, &u, n, h, 1.0) {
            if reasons.len() as f64 >= max_reasons {
                break;
            }
            let mut best = f64::INFINITY;
            for r in realised_words(d, s, cells[i], &u, i * n, cells[j], &u, j * n, &mut budget, &RealisedOptions::default())? {
                best = math::min(best, r.len);
            }
            if !(best >= limit) {
                push(reasons, max_reasons, format!("Balls {i} and {j} overlap: their centres are {} apart along the boundary; they must be at least 1 apart.", fmt(best)));
            }
        }
        // The loop lemma (BOUNDARY.md 4B.3): a geodesic loop is at least s sqrt 2 long, so for s >= 1/sqrt 2 none is shorter than 1
        // (nor than 1 - tol) and the search, the biggest consumer of the budget, is skipped. Below that it runs, because a ball of
        // diameter 1 can then still fit (the clearance rule needs only s >= 1/sqrt 2 - tol).
        let mut i = 0;
        while i < p && (reasons.len() as f64) < max_reasons && !(s * math::SQRT2 >= 1.0) {
            let mut best = f64::INFINITY;
            for r in realised_words(d, s, cells[i], &u, i * n, cells[i], &u, i * n, &mut budget, &RealisedOptions { exclude_empty: true, ..Default::default() })? {
                if r.len > 1e-12 {
                    best = math::min(best, r.len);
                }
            }
            if !(best >= limit) {
                push(reasons, max_reasons, format!("Ball {i} overlaps itself: a geodesic loop of length {} leaves and returns to its centre; it must be at least 1.", fmt(best)));
            }
            i += 1;
        }
        Ok(())
    };
    if let Err(e) = search(&mut reasons) {
        push(
            &mut reasons,
            max_reasons,
            format!("The check reached its work limit ({} search steps) before it could decide: too many balls crowd the (d-3)-faces of the {name}.", num(e.limit)),
        );
    }
    reasons
}

/// A part of a cube: a box in a cell's local coordinates.
/// packages/boundary/src/ncube/validate.ts: Part
#[derive(Clone, Debug)]
pub struct Part {
    pub piece: usize,
    pub cell: usize,
    pub lo: Vec<f64>,
    pub hi: Vec<f64>,
}

/// packages/boundary/src/ncube/validate.ts: cubeParts' result
#[derive(Clone, Debug)]
pub struct CubeParts {
    pub parts: Vec<Part>,
    pub crossed: Vec<usize>,
    pub depth: Vec<f64>,
}

/// The parts of the axis-aligned cube centred at u (anchor cell c) as boxes, and the axes it
/// crosses (depth > tol). With one crossed axis k (side tau) the slice beyond the face y_k = tau h,
/// y_k in [h, u_k + 1/2] (tau > 0), has the other axes' bounds, and the one-crossing word maps it to
/// a box of the neighbour cell (j, tau'); the old normal axis i becomes a tangent axis of the
/// neighbour, of depth d_k into it.
/// packages/boundary/src/ncube/validate.ts: cubeParts
pub fn cube_parts(d: usize, s: f64, piece: usize, c: usize, u: &[f64], o: usize, tol: f64) -> CubeParts {
    let n = d - 1;
    let h = s / 2.0;
    let mut depth: Vec<f64> = Vec::with_capacity(n);
    let mut crossed: Vec<usize> = Vec::new();
    for k in 0..n {
        let dep = u[o + k].abs() + 0.5 - h;
        depth.push(dep);
        if dep > tol {
            crossed.push(k);
        }
    }
    let mut lo = vec![0.0; n];
    let mut hi = vec![0.0; n];
    for k in 0..n {
        lo[k] = u[o + k] - 0.5;
        hi[k] = u[o + k] + 0.5;
        if depth[k] > tol {
            if u[o + k] > 0.0 {
                hi[k] = h;
            } else {
                lo[k] = -h;
            }
        }
    }
    let mut parts: Vec<Part> = vec![Part { piece, cell: c, lo: lo.clone(), hi: hi.clone() }];
    if crossed.len() == 1 {
        let k = crossed[0];
        let tau = if u[o + k] > 0.0 { 1 } else { -1 };
        let mut blo = lo.clone();
        let mut bhi = hi.clone();
        if tau > 0 {
            blo[k] = h;
            bhi[k] = u[o + k] + 0.5;
        } else {
            blo[k] = u[o + k] - 0.5;
            bhi[k] = -h;
        }
        let w = step_map(d, &start_map(d, c), k, tau);
        // x = A y + h b for the two corners, then the neighbour's local axes
        let ax2 = axes_of(d, w.cell >> 1);
        let a = |y: &[f64]| -> Vec<f64> {
            let mut x = vec![0.0; d];
            for r in 0..n {
                x[w.rows[r] as usize] += w.sgn[r] as f64 * y[r];
            }
            for t in 0..d {
                x[t] += h * w.b[t] as f64;
            }
            x
        };
        let x0 = a(&blo);
        let x1 = a(&bhi);
        let mut nlo = vec![0.0; n];
        let mut nhi = vec![0.0; n];
        for q in 0..n {
            nlo[q] = math::min(x0[ax2[q]], x1[ax2[q]]);
            nhi[q] = math::max(x0[ax2[q]], x1[ax2[q]]);
        }
        parts.push(Part { piece, cell: w.cell, lo: nlo, hi: nhi });
    }
    CubeParts { parts, crossed, depth }
}

/// packages/boundary/src/ncube/validate.ts: validateCubes
fn validate_cubes(d: usize, name: &str, cfg: &NCubeConfig, tol: f64, max_reasons: f64) -> Vec<String> {
    let mut reasons: Vec<String> = Vec::new();
    let n = d - 1;
    let s = cfg.s;
    let pieces = &cfg.pieces;
    let mut u = vec![0.0; n * pieces.len()];
    for (i, p) in pieces.iter().enumerate() {
        u[i * n..i * n + n].copy_from_slice(&p.u);
    }
    let mut by_cell: Vec<Vec<Part>> = (0..2 * d).map(|_| Vec::new()).collect();
    for i in 0..pieces.len() {
        let CubeParts { parts, crossed, depth } = cube_parts(d, s, i, pieces[i].cell, &u, i * n, tol);
        if crossed.len() >= 2 {
            let mut sorted = depth.clone();
            // (a, b) => b - a: descending
            sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            let worst = sorted[1];
            push(
                &mut reasons,
                max_reasons,
                format!("Cube {i} crosses the faces of its cell in {} axes, so a (d-3)-face of the {name} passes through its interior (depth {}).", crossed.len(), fmt(worst)),
            );
            continue;
        }
        for p in parts {
            let cell = p.cell;
            by_cell[cell].push(p);
        }
    }
    if !reasons.is_empty() {
        return reasons;
    }
    // the parts' low corners in a grid of side 2 on the first three axes: a part is at most 1 long on each axis
    let g = 2.0;
    let kc = |x: f64| -> f64 { (x / g).floor() };
    for (cell, list) in by_cell.iter().enumerate() {
        if reasons.len() as f64 >= max_reasons {
            continue;
        }
        let mut grid: HashMap<(i64, i64, i64), Vec<usize>> = HashMap::new();
        for (a, p) in list.iter().enumerate() {
            grid.entry((kc(p.lo[0]) as i64, kc(p.lo[1]) as i64, kc(p.lo[2]) as i64)).or_default().push(a);
        }
        let mut a = 0;
        while a < list.len() && (reasons.len() as f64) < max_reasons {
            let pa = &list[a];
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let Some(bucket) = grid.get(&((kc(pa.lo[0]) + dx as f64) as i64, (kc(pa.lo[1]) + dy as f64) as i64, (kc(pa.lo[2]) + dz as f64) as i64)) else { continue };
                        for &b in bucket {
                            if b <= a {
                                continue;
                            }
                            let pb = &list[b];
                            // the least overlap over the axes is the penetration depth; all overlaps must exceed tol
                            let mut depth = f64::INFINITY;
                            for k in 0..n {
                                let ov = math::min(pa.hi[k], pb.hi[k]) - math::max(pa.lo[k], pb.lo[k]);
                                if ov < depth {
                                    depth = ov;
                                }
                                if !(depth > tol) {
                                    break;
                                }
                            }
                            if !(depth > tol) {
                                continue;
                            }
                            let (i, j) = if pa.piece < pb.piece { (pa.piece, pb.piece) } else { (pb.piece, pa.piece) };
                            push(&mut reasons, max_reasons, format!("Cubes {i} and {j} overlap in cell {cell} (depth {}).", fmt(depth)));
                        }
                    }
                }
            }
            a += 1;
        }
    }
    reasons
}

/// Validates a configuration (untrusted input) for a d-cube problem: ok with the score s, or the
/// reasons as plain sentences. A bad tol (a caller's mistake) is the source's RangeError.
/// packages/boundary/src/ncube/validate.ts: validateNCube
pub fn validate_ncube(problem: &BoundaryProblem, config: &Value, opts: &ValidateOptions) -> Result<BoundaryVerdict, BoundaryError> {
    let tol = opts.tol.unwrap_or(1e-9);
    if !(tol.is_finite() && tol >= 0.0) {
        return Err(BoundaryError::Range(format!("validateNCube: tol must be a finite number >= 0, not {}", num(tol))));
    }
    let max_reasons = limit(opts.max_reasons, 20.0);
    let max_work = limit(opts.max_work, NCUBE_MAX_WORK);
    let mut reasons: Vec<String> = Vec::new();
    let bad = |reasons: Vec<String>| -> BoundaryVerdict { BoundaryVerdict { ok: false, score: None, reasons: if reasons.is_empty() { vec!["The configuration is malformed.".to_string()] } else { reasons } } };
    if !is_ncube_name(&problem.polytope) {
        reasons.push(format!("Unknown polytope \"{}\".", problem.polytope));
        return Ok(bad(reasons));
    }
    if problem.piece != "ball" && problem.piece != "cube" {
        reasons.push(format!("Unknown piece \"{}\".", problem.piece));
        return Ok(bad(reasons));
    }
    if !(is_integer(problem.p) && problem.p >= 1.0) {
        reasons.push("The problem's P must be a whole number from 1.".to_string());
        return Ok(bad(reasons));
    }
    let d = ncube_dim(&problem.polytope);
    let Some(cfg) = read_ncube_config(problem, config, tol, &mut reasons, max_reasons) else { return Ok(bad(reasons)) };
    let n = d - 1;
    // volume bound [CALC]: the pieces' volumes add up to at most the boundary's, 2d s^n (1e-6 absorbs overlaps within tol)
    let piece_volume = if problem.piece == "ball" { unit_ball_volume(n) / math::pow(2.0, n as f64) } else { 1.0 };
    let volume = (2 * d) as f64 * math::pow(cfg.s, n as f64);
    let count = cfg.pieces.len() as f64;
    if !(count * piece_volume <= volume * (1.0 + 1e-6)) {
        return Ok(BoundaryVerdict {
            ok: false,
            score: None,
            reasons: vec![format!(
                "{} {}s have a total volume of {}, more than the {} of the {}'s boundary at s = {}.",
                cfg.pieces.len(),
                problem.piece,
                fmt(count * piece_volume),
                fmt(volume),
                problem.polytope,
                fmt(cfg.s)
            )],
        });
    }
    let geo = if problem.piece == "ball" { validate_balls(d, &problem.polytope, &cfg, tol, max_reasons, max_work) } else { validate_cubes(d, &problem.polytope, &cfg, tol, max_reasons) };
    Ok(if geo.is_empty() { BoundaryVerdict { ok: true, score: Some(cfg.s), reasons: vec![] } } else { BoundaryVerdict { ok: false, score: None, reasons: geo } })
}
