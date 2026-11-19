//! Poses in d dimensions (packages/ndim/src/pose.ts, docs/spaces/NDIM.md §3).
//!
//! A polytope piece's pose is the flat array [t_1..t_d, k_1..k_m, flip] with m = d(d-1)/2: the
//! centre t of the piece's vertex centroid, the Cayley parameters k, and an optional flip (an
//! integer; 0 when absent). The rotation is
//!
//!   R = D (I - S)^-1 (I + S),   S[i][j] = k (i < j, row-major order), S[j][i] = -k,
//!   D = diag(-1 for each set bit of flip)
//!
//! and the world vertex of the canonical vertex v is t + R v. S is skew, so I - S is invertible, R
//! is orthogonal with determinant det D = +1 (the flip has an even number of set bits: reflections
//! are refused), and every rotation without eigenvalue -1 has one Cayley form with D = I; with a
//! suitable flip every rotation of the group is representable. A ball's pose is its centre
//! [t_1..t_d].
//!
//! The server's bundle keeps cayleyMatrix, readPose and placeVertices of the source; the
//! matrix-to-pose functions (cayleyOfMatrix, poseOfMatrix) are the search's, for the nD kernel's
//! Auto search. placeFacets is not ported.
use crate::linalg::{det, matmul, solve, transpose};
use crate::Thrown;
use polypack_js::{fmt, math};
use serde_json::Value;

/// Largest absolute value of a Cayley parameter (keeps I - S well conditioned, and rotations within
/// 3.5 degrees of a half turn out).
pub const MAX_CAYLEY: f64 = 32.0;
/// Largest absolute value of a centre coordinate.
pub const MAX_COORD: f64 = 1e4;
/// Largest container scale s accepted.
pub const MAX_SIZE: f64 = 1e6;

/// packages/ndim/src/pose.ts: nParams.
pub const fn n_params(d: usize) -> usize {
    (d * d.saturating_sub(1)) / 2
}

/// packages/ndim/src/pose.ts: cayleyMatrix. R = D (I - S)^-1 (I + S) for the Cayley parameters
/// (upper triangle of S, row-major) and the flip bit mask.
pub fn cayley_matrix(params: &[f64], d: usize, flip: u32) -> Result<Vec<f64>, Thrown> {
    let mut a = vec![0.0f64; d * d];
    let mut b = vec![0.0f64; d * d];
    for i in 0..d {
        a[i * d + i] = 1.0;
        b[i * d + i] = 1.0;
    }
    let mut k = 0;
    for i in 0..d {
        for j in i + 1..d {
            let v = params[k];
            k += 1;
            a[i * d + j] = -v; // I - S
            a[j * d + i] = v;
            b[i * d + j] = v; // I + S
            b[j * d + i] = -v;
        }
    }
    let Some(mut c) = solve(&a, &b, d, d) else {
        return Err(Thrown("I - S is singular".into()));
    };
    for i in 0..d {
        if (flip >> i) & 1 != 0 {
            for j in 0..d {
                c[i * d + j] = -c[i * d + j];
            }
        }
    }
    Ok(c)
}

/// packages/ndim/src/pose.ts: parity. The number of set bits, modulo 2.
fn parity(mut m: u32) -> u32 {
    let mut c = 0;
    while m != 0 {
        c += 1;
        m &= m - 1;
    }
    c & 1
}

/// packages/ndim/src/pose.ts: ReadPose. A pose read from untrusted input: the centre and, for a
/// polytope, the rotation matrix.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadPose {
    pub t: Vec<f64>,
    pub r: Option<Vec<f64>>,
}

/// What readPose returns: the pose, or the error text when it is malformed.
#[derive(Debug, Clone, PartialEq)]
pub enum Pose {
    Read(ReadPose),
    Bad(String),
}

/// packages/ndim/src/pose.ts: readPose, on a JSON value (untrusted input). A value that is not an
/// array, and an entry that is not a number, are refused with the source's texts.
pub fn read_pose_value(d: usize, pose: &Value, ball: bool) -> Result<Pose, Thrown> {
    let Value::Array(items) = pose else {
        return Ok(Pose::Bad("must be an array of numbers".into()));
    };
    read_pose_items(d, items.len(), |i| items[i].as_f64(), ball)
}

/// packages/ndim/src/pose.ts: readPose, on a pose that is already an array of numbers (the
/// configuration the parser returned).
pub fn read_pose(d: usize, pose: &[f64], ball: bool) -> Result<Pose, Thrown> {
    read_pose_items(d, pose.len(), |i| Some(pose[i]), ball)
}

/// The body of readPose: `at(i)` is entry i when it is a number (`typeof pose[i] === "number"`).
/// The checks and their order are the source's: the length, finite numbers, the centre's range, the
/// Cayley parameters' range, the flip.
fn read_pose_items(d: usize, len: usize, at: impl Fn(usize) -> Option<f64>, ball: bool) -> Result<Pose, Thrown> {
    let bad = |text: String| Ok(Pose::Bad(text));
    let m = n_params(d);
    if ball {
        if len != d {
            return bad(format!("must be the centre of a ball, {d} numbers"));
        }
    } else if len != d + m && len != d + m + 1 {
        return bad(format!("must have {} numbers (centre and Cayley parameters) and an optional flip", d + m));
    }
    let n = if ball { d } else { d + m };
    let mut x: Vec<f64> = Vec::with_capacity(n);
    for i in 0..n {
        match at(i) {
            Some(v) if v.is_finite() => x.push(v),
            _ => return bad("must contain finite numbers only".into()),
        }
    }
    for i in 0..d {
        if x[i].abs() > MAX_COORD {
            return bad(format!("centre coordinates must be at most {} in absolute value", fmt::num(MAX_COORD)));
        }
    }
    let t: Vec<f64> = x[..d].to_vec();
    if ball {
        return Ok(Pose::Read(ReadPose { t, r: None }));
    }
    for i in d..d + m {
        if x[i].abs() > MAX_CAYLEY {
            return bad(format!("Cayley parameters must be at most {} in absolute value", fmt::num(MAX_CAYLEY)));
        }
    }
    let mut flip: u32 = 0;
    if len == d + m + 1 {
        // Number.isInteger(f): a number that is finite and whole (false for an entry that is not a number)
        let f = at(d + m);
        let whole = matches!(f, Some(v) if v.is_finite() && v.floor() == v);
        let f = f.unwrap_or(f64::NAN);
        if !whole || f < 0.0 || f >= 2f64.powi(d as i32) {
            return bad(format!("the flip must be an integer in [0, 2^{d})"));
        }
        if parity(f as u32) != 0 {
            return bad("the flip must have an even number of set bits (a reflection is refused)".into());
        }
        flip = f as u32;
    }
    Ok(Pose::Read(ReadPose { t, r: Some(cayley_matrix(&x[d..d + m], d, flip)?) }))
}

/// packages/ndim/src/pose.ts: placeVertices. The world vertices t + R v of canonical vertices V
/// (nV x d), flat.
pub fn place_vertices(v: &[f64], n_v: usize, d: usize, t: &[f64], r: &[f64]) -> Vec<f64> {
    let mut x = vec![0.0f64; n_v * d];
    for vi in 0..n_v {
        let row = &v[vi * d..vi * d + d];
        for i in 0..d {
            let mut s = t[i];
            let rr = &r[i * d..i * d + d];
            for j in 0..d {
                s += rr[j] * row[j];
            }
            x[vi * d + i] = s;
        }
    }
    x
}

/// A candidate's rebuild must match the matrix to this (largest absolute entry difference).
const VERIFY_TOL: f64 = 1e-12;

/// packages/ndim/src/pose.ts: cayleyOfMatrix. The Cayley parameters and flip of a rotation matrix
/// (row-major d x d), choosing the flip that keeps the parameters smallest. Every candidate
/// (D R - I)(D R + I)^-1 is rebuilt with cayley_matrix and kept only if it reproduces R to 1e-12: a
/// nearly singular D R + I would otherwise return the parameters of another rotation. All even
/// flips are tried for d <= 7; above, a greedy flip and its pair swaps first, and, when none of
/// those verifies, all even flips (2^(d-1), 512 at d = 10). `Err` (a RangeError of the source,
/// with its message) for a matrix that is not finite, not orthonormal (R^T R differs from I by more
/// than 1e-9), a reflection (determinant < 0) or without a verified Cayley form within MAX_CAYLEY.
pub fn cayley_of_matrix(r: &[f64], d: usize) -> Result<(Vec<f64>, u32), Thrown> {
    if r.len() != d * d || !r.iter().all(|v| v.is_finite()) {
        return Err(Thrown("the rotation must be a finite d x d matrix".into()));
    }
    let mm = r.to_vec();
    let g = matmul(&transpose(&mm, d), &mm, d);
    let mut dev = 0.0f64;
    for i in 0..d {
        for j in 0..d {
            dev = math::max(dev, math::abs(g[i * d + j] - if i == j { 1.0 } else { 0.0 }));
        }
    }
    if dev > 1e-9 {
        return Err(Thrown("the matrix is not orthonormal (R^T R differs from I by more than 1e-9)".into()));
    }
    if det(&mm, d) < 0.0 {
        return Err(Thrown("the matrix is a reflection (determinant -1): poses are rotations only".into()));
    }
    // a matrix that is itself off orthogonal by dev is reproduced only that well (a wrong candidate is off by order 1)
    let tol = VERIFY_TOL + 10.0 * dev;
    let mut even_flips: Vec<u32> = Vec::new();
    for m in 0..(1u32 << d) {
        if parity(m) == 0 {
            even_flips.push(m);
        }
    }
    let mut heuristic = even_flips.clone();
    let mut heuristic_is_all = true;
    if d > 7 {
        let mut base = 0u32;
        for i in 0..d {
            if mm[i * d + i] < 0.0 {
                base |= 1 << i;
            }
        }
        if parity(base) != 0 {
            let mut imin = 0;
            for i in 1..d {
                if math::abs(mm[i * d + i]) < math::abs(mm[imin * d + imin]) {
                    imin = i;
                }
            }
            base ^= 1 << imin;
        }
        heuristic = vec![base];
        for i in 0..d {
            for j in i + 1..d {
                heuristic.push(base ^ (1 << i) ^ (1 << j));
            }
        }
        heuristic_is_all = false;
    }
    let try_masks = |masks: &[u32]| -> Option<(f64, Vec<f64>, u32)> {
        let mut best: Option<(f64, Vec<f64>, u32)> = None;
        for &m in masks {
            let mut c = vec![0.0f64; d * d];
            for i in 0..d {
                for j in 0..d {
                    c[i * d + j] = (if (m >> i) & 1 != 0 { -1.0 } else { 1.0 }) * mm[i * d + j];
                }
            }
            let mut num = c.clone();
            let mut den = c;
            for i in 0..d {
                num[i * d + i] -= 1.0;
                den[i * d + i] += 1.0;
            }
            // S = num den^-1, i.e. den^T S^T = num^T
            let Some(st) = solve(&transpose(&den, d), &transpose(&num, d), d, d) else {
                continue;
            };
            let s = transpose(&st, d);
            let mut params: Vec<f64> = Vec::new();
            let mut size = 0.0f64;
            for i in 0..d {
                for j in i + 1..d {
                    let v = 0.5 * (s[i * d + j] - s[j * d + i]);
                    params.push(v);
                    size = math::max(size, math::abs(v));
                }
            }
            if !(size <= MAX_CAYLEY) || matches!(&best, Some(b) if size >= b.0) {
                continue;
            }
            let Ok(back) = cayley_matrix(&params, d, m) else {
                continue;
            };
            let mut err = 0.0f64;
            for k in 0..d * d {
                err = math::max(err, math::abs(back[k] - mm[k]));
            }
            if err < tol {
                best = Some((size, params, m));
            }
        }
        best
    };
    let best = match try_masks(&heuristic) {
        Some(b) => Some(b),
        None if heuristic_is_all => None,
        None => try_masks(&even_flips),
    };
    match best {
        Some((_, params, flip)) => Ok((params, flip)),
        None => Err(Thrown("the rotation has no verified Cayley form within the parameter bound".into())),
    }
}

/// packages/ndim/src/pose.ts: poseOfMatrix. The pose array [t..., k..., flip] of a centre and a
/// rotation matrix (see cayley_of_matrix for the refusals).
pub fn pose_of_matrix(t: &[f64], r: &[f64], d: usize) -> Result<Vec<f64>, Thrown> {
    let (params, flip) = cayley_of_matrix(r, d)?;
    let mut out: Vec<f64> = t.iter().take(d).copied().collect();
    out.extend(params);
    out.push(flip as f64);
    Ok(out)
}
