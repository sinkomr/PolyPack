//! The two radii that a solid's lower bounds in the balls family rest on, about the best centre and not about
//! the vertex centroid. Port of `packages/balls/src/extent.ts`.
//!
//!  - chebyshev_radius: the radius of the largest ball inside the solid (the Chebyshev radius), max over x of
//!    min_f (b_f - N_f . x);
//!  - enclosing_radius: the radius of the smallest ball holding the solid (that of its vertices).
//!
//! For the 94 solids of the first catalogue the vertex centroid is both centres (their symmetry groups fix no
//! other point, container.rs), so there these are Solid.inradius and Solid.circumradius, and those values are
//! used as they are. The 92 Johnson solids are mostly not symmetric enough: a pyramid's largest inscribed ball is
//! not centred at its vertex centroid, and neither is its smallest enclosing ball. A bound that divides by the
//! centroid's inradius, or asks for the centroid's circumradius, would then be too strong, so the bounds use
//! these.
//!
//! Floating point, [CALC, the source's]. The inscribed ball is a linear programme in (x, r) solved by a tableau
//! simplex with Bland's rule; the enclosing ball is Welzl's algorithm on the vertices. Where the optimum is not
//! the centroid's value the result is moved by 1e-9 of itself in the direction that keeps a bound valid (the
//! inradius up, the enclosing radius down), which is far above the rounding of either computation and far below
//! any bound's use.

use polypack_js::math;
use polypack_polyhedra::Solid;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

const SAFETY: f64 = 1e-9;

/// `extent.ts: chebyshevOf`: max r with N_f . x + r <= b_f for every face f: simplex on the variables x+, x-
/// (x = x+ - x-) and r, all >= 0. `Err` (the source throws) when the programme is unbounded.
pub fn chebyshev_of(n_flat: &[f64], b: &[f64]) -> Result<f64, String> {
    let f_count = b.len();
    let n = 7usize; // x+ (3), x- (3), r
    let w = n + f_count + 1;
    // rows: F constraints, then the objective row (maximise r, stored as -r)
    let mut t: Vec<Vec<f64>> = (0..f_count + 1).map(|_| vec![0.0f64; w]).collect();
    let mut basis: Vec<usize> = vec![0; f_count];
    for f in 0..f_count {
        for k in 0..3 {
            t[f][k] = n_flat[3 * f + k];
            t[f][3 + k] = -n_flat[3 * f + k];
        }
        t[f][6] = 1.0;
        t[f][n + f] = 1.0;
        t[f][w - 1] = b[f];
        basis[f] = n + f;
    }
    t[f_count][6] = -1.0;
    for _iter in 0..10000 {
        // Bland: the lowest-index column with a negative reduced cost
        let mut col: Option<usize> = None;
        for j in 0..w - 1 {
            if t[f_count][j] < -1e-13 {
                col = Some(j);
                break;
            }
        }
        let Some(col) = col else { break };
        let mut row: Option<usize> = None;
        let mut best = f64::INFINITY;
        for f in 0..f_count {
            if t[f][col] > 1e-13 {
                let ratio = t[f][w - 1] / t[f][col];
                // basis[row] with row = -1 is undefined in the source, and a comparison with it is false
                if ratio < best - 1e-15
                    || (math::abs(ratio - best) <= 1e-15 && row.is_some_and(|r| basis[f] < basis[r]))
                {
                    best = ratio;
                    row = Some(f);
                }
            }
        }
        let Some(row) = row else {
            return Err("the inscribed ball is unbounded: not a bounded polyhedron".to_string());
        };
        let p = t[row][col];
        for j in 0..w {
            t[row][j] /= p;
        }
        for f in 0..=f_count {
            if f == row {
                continue;
            }
            let m = t[f][col];
            if m != 0.0 {
                for j in 0..w {
                    let d = m * t[row][j];
                    t[f][j] -= d;
                }
            }
        }
        basis[row] = col;
    }
    Ok(t[f_count][w - 1])
}

/// `extent.ts: Ball`.
#[derive(Clone, Copy, Debug)]
struct Ball {
    c: [f64; 3],
    r2: f64,
}

/// `extent.ts: ballOn`: the ball with the given points (1 to 4) on its boundary and the smallest radius, or None
/// when they are degenerate.
fn ball_on(pts: &[[f64; 3]]) -> Option<Ball> {
    if pts.is_empty() {
        return Some(Ball { c: [0.0, 0.0, 0.0], r2: -1.0 });
    }
    let a = pts[0];
    if pts.len() == 1 {
        return Some(Ball { c: [a[0], a[1], a[2]], r2: 0.0 });
    }
    if pts.len() == 2 {
        let b = pts[1];
        let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0];
        let (d0, d1, d2) = (a[0] - m[0], a[1] - m[1], a[2] - m[2]);
        return Some(Ball { c: m, r2: d0 * d0 + d1 * d1 + d2 * d2 });
    }
    // centre = a + sum_k t_k (p_k - a) in the span of the others' differences, from |x - a|^2 = |x - p|^2
    let u: Vec<[f64; 3]> = pts[1..].iter().map(|p| [p[0] - a[0], p[1] - a[1], p[2] - a[2]]).collect();
    let m = u.len();
    let g: Vec<Vec<f64>> = u.iter().map(|p| u.iter().map(|q| p[0] * q[0] + p[1] * q[1] + p[2] * q[2]).collect()).collect();
    let rhs: Vec<f64> = u.iter().map(|p| (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / 2.0).collect();
    let t = solve(&g, &rhs)?;
    let mut x = [a[0], a[1], a[2]];
    for k in 0..m {
        for e in 0..3 {
            x[e] += t[k] * u[k][e];
        }
    }
    let (d0, d1, d2) = (a[0] - x[0], a[1] - x[1], a[2] - x[2]);
    Some(Ball { c: x, r2: d0 * d0 + d1 * d1 + d2 * d2 })
}

/// `extent.ts: solve`: Gaussian elimination with partial pivoting; None for a (nearly) singular matrix.
fn solve(a: &[Vec<f64>], y: &[f64]) -> Option<Vec<f64>> {
    let n = y.len();
    let mut m: Vec<Vec<f64>> = a
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let mut r = row.clone();
            r.push(y[i]);
            r
        })
        .collect();
    let mut scale = 0.0f64;
    for row in a {
        for &v in row {
            scale = math::max(scale, math::abs(v));
        }
    }
    for i in 0..n {
        let mut p = i;
        for r in i + 1..n {
            if math::abs(m[r][i]) > math::abs(m[p][i]) {
                p = r;
            }
        }
        if math::abs(m[p][i]) <= 1e-11 * scale {
            return None;
        }
        m.swap(i, p);
        for r in i + 1..n {
            let f = m[r][i] / m[i][i];
            for j in i..=n {
                let d = f * m[i][j];
                m[r][j] -= d;
            }
        }
    }
    let mut x = vec![0.0f64; n];
    for i in (0..n).rev() {
        let mut v = m[i][n];
        for j in i + 1..n {
            v -= m[i][j] * x[j];
        }
        x[i] = v / m[i][i];
    }
    Some(x)
}

/// `extent.ts: inside`.
fn inside(ball: &Ball, p: &[f64; 3]) -> bool {
    let (d0, d1, d2) = (p[0] - ball.c[0], p[1] - ball.c[1], p[2] - ball.c[2]);
    d0 * d0 + d1 * d1 + d2 * d2 <= ball.r2 * (1.0 + 1e-12) + 1e-15
}

/// `extent.ts: enclosingOf`'s recursion `welzl`: the smallest ball holding the first n points with the points of
/// `r` on its boundary.
fn welzl(pts: &[[f64; 3]], n: usize, r: &[[f64; 3]]) -> Ball {
    let mut ball = ball_on(r).unwrap_or(Ball { c: [0.0, 0.0, 0.0], r2: -1.0 });
    if r.len() == 4 {
        return ball;
    }
    for i in 0..n {
        if ball.r2 >= 0.0 && inside(&ball, &pts[i]) {
            continue;
        }
        let mut with: Vec<[f64; 3]> = r.to_vec();
        with.push(pts[i]);
        ball = welzl(pts, i, &with);
    }
    ball
}

/// `extent.ts: enclosingOf`: radius of the smallest ball holding the points (flat x, y, z), by Welzl's algorithm
/// with move-to-front.
pub fn enclosing_of(v: &[f64]) -> f64 {
    let mut pts: Vec<[f64; 3]> = Vec::new();
    let mut i = 0;
    while i < v.len() {
        pts.push([v[i], v[i + 1], v[i + 2]]);
        i += 3;
    }
    // a fixed shuffle (a multiplicative walk), so that the run is reproducible and the recursion shallow.
    // (i * 2654435761) % 4294967296 is exact in a double for every index of a solid, as it is in u64.
    let mut order: Vec<usize> = (0..pts.len()).collect();
    let walk = |i: usize| ((i as u64 * 2654435761u64) % 4294967296u64) as i64;
    order.sort_by(|&i, &j| (walk(i) - walk(j)).cmp(&0));
    let p: Vec<[f64; 3]> = order.iter().map(|&i| pts[i]).collect();
    let ball = welzl(&p, p.len(), &[]);
    ball.r2.sqrt()
}

static CHEB: LazyLock<Mutex<HashMap<String, f64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static ENCL: LazyLock<Mutex<HashMap<String, f64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// `extent.ts: chebyshevRadius`: the Chebyshev radius of the solid (about its best centre), as a valid upper
/// bound; the inradius where the centroid is optimal. Computed once per solid.
pub fn chebyshev_radius(s: &Solid) -> Result<f64, String> {
    if let Some(&v) = CHEB.lock().unwrap().get(&s.name) {
        return Ok(v);
    }
    let r = chebyshev_of(&s.n, &s.offsets)?;
    let v = if r <= s.inradius * (1.0 + 1e-9) { s.inradius } else { r * (1.0 + SAFETY) };
    CHEB.lock().unwrap().insert(s.name.clone(), v);
    Ok(v)
}

/// `extent.ts: enclosingRadius`: the radius of the smallest ball holding the solid, as a valid lower bound; the
/// circumradius where the centroid is optimal. Computed once per solid.
pub fn enclosing_radius(s: &Solid) -> f64 {
    if let Some(&v) = ENCL.lock().unwrap().get(&s.name) {
        return v;
    }
    let r = enclosing_of(&s.v);
    let v = if r >= s.circumradius * (1.0 - 1e-9) { s.circumradius } else { r * (1.0 - SAFETY) };
    ENCL.lock().unwrap().insert(s.name.clone(), v);
    v
}
