//! Polytope data from formulas (packages/ndim/src/generate.ts): the simplex, hypercube, orthoplex
//! and demicube of every dimension, and the 4_21 polytope of 8D, computed when first needed instead
//! of shipped as tables. Vertex order is the generator's (python/ndim/gen_catalogue.py); the order
//! of the facets is this file's.
//!
//! Unit edge, centred at the vertex centroid:
//!   simplex   vertices from the orthonormalised vectors (1^k, -k, 0, ...), scaled by 1/sqrt(2);
//!             facet j opposite vertex j.
//!   cube      (+-1/2)^d; facets +-e_i at distance 1/2.
//!   orthoplex +-e_i / sqrt(2); facets (+-1)^d / sqrt(d) at distance 1 / sqrt(2d).
//!   demicube  (+-a)^d with an even number of minus signs, a = 1 / (2 sqrt(2)); simplex facets
//!             s / sqrt(d) (an odd number of minus signs in s) at distance a (d - 2) / sqrt(d), and
//!             the cube facets +-e_i at distance a.
//!   4_21      the 240 roots of E8 over sqrt(2); its 19,440 facets are the orbits of two normals
//!             under the reflections of E8 (17,280 simplex facets at distance 3/4 and 2,160
//!             orthoplex facets at distance 1/sqrt(2)).
//!
//! The arithmetic is the source's, operation for operation, so that the coordinates are the same
//! doubles as the TypeScript's (the comparison checks every one of them).
use crate::Thrown;
use polypack_js::math;
use std::collections::HashSet;
use std::f64::consts::{FRAC_1_SQRT_2, SQRT_2};

/// The coordinates of a polytope: vertices (nV x d), unit outward facet normals (nF x d) and
/// offsets (nF) (`Pick<PolytopeData, "V" | "N" | "b">`).
pub struct Data {
    pub v: Vec<f64>,
    pub n: Vec<f64>,
    pub b: Vec<f64>,
}

/// packages/ndim/src/generate.ts: simplex.
fn simplex(d: usize) -> Data {
    let df = d as f64;
    let mut v: Vec<f64> = Vec::new();
    let mut n: Vec<f64> = Vec::new();
    let r = (df / (2.0 * (df + 1.0))).sqrt();
    for j in 0..=d {
        for k in 1..=d {
            let kf = k as f64;
            let bk = if j < k {
                1.0
            } else if j == k {
                -kf
            } else {
                0.0
            };
            v.push(bk / (2.0 * kf * (kf + 1.0)).sqrt());
        }
    }
    for j in 0..=d {
        for k in 0..d {
            n.push(-v[j * d + k] / r);
        }
    }
    Data { v, n, b: vec![r / df; d + 1] }
}

/// packages/ndim/src/generate.ts: signVectors. Sign vectors of length d in binary order with +
/// before -, optionally only those with an even (0) or odd (1) number of minus signs.
fn sign_vectors(d: usize, parity: Option<usize>) -> Vec<Vec<f64>> {
    let mut out: Vec<Vec<f64>> = Vec::new();
    for m in 0..(1usize << d) {
        let mut s: Vec<f64> = Vec::with_capacity(d);
        let mut minus = 0usize;
        for i in 0..d {
            let neg = (m >> (d - 1 - i)) & 1;
            minus += neg;
            s.push(if neg != 0 { -1.0 } else { 1.0 });
        }
        if parity.map_or(true, |p| minus % 2 == p) {
            out.push(s);
        }
    }
    out
}

/// packages/ndim/src/generate.ts: axisFacets. The facets +-e_i at distance `dist`.
fn axis_facets(d: usize, dist: f64, n: &mut Vec<f64>, b: &mut Vec<f64>) {
    for i in 0..d {
        for sg in [1.0, -1.0] {
            for k in 0..d {
                n.push(if k == i { sg } else { 0.0 });
            }
            b.push(dist);
        }
    }
}

/// packages/ndim/src/generate.ts: cube.
fn cube(d: usize) -> Data {
    let v: Vec<f64> = sign_vectors(d, None).iter().flat_map(|s| s.iter().map(|x| x / 2.0)).collect();
    let mut n = Vec::new();
    let mut b = Vec::new();
    axis_facets(d, 0.5, &mut n, &mut b);
    Data { v, n, b }
}

/// packages/ndim/src/generate.ts: ortho.
fn ortho(d: usize) -> Data {
    let df = d as f64;
    let mut v: Vec<f64> = Vec::new();
    for i in 0..d {
        for sg in [1.0, -1.0] {
            for k in 0..d {
                v.push(if k == i { sg * FRAC_1_SQRT_2 } else { 0.0 });
            }
        }
    }
    let n: Vec<f64> = sign_vectors(d, None).iter().flat_map(|s| s.iter().map(|x| x / df.sqrt())).collect();
    Data { v, n, b: vec![1.0 / (2.0 * df).sqrt(); 1usize << d] }
}

/// packages/ndim/src/generate.ts: demi.
fn demi(d: usize) -> Data {
    let df = d as f64;
    let a = 1.0 / (2.0 * SQRT_2);
    let v: Vec<f64> = sign_vectors(d, Some(0)).iter().flat_map(|s| s.iter().map(|x| x * a)).collect();
    let mut n: Vec<f64> = sign_vectors(d, Some(1)).iter().flat_map(|s| s.iter().map(|x| x / df.sqrt())).collect();
    let mut b = vec![(a * (df - 2.0)) / df.sqrt(); n.len() / d];
    axis_facets(d, a, &mut n, &mut b);
    Data { v, n, b }
}

/// packages/ndim/src/generate.ts: e8Roots. The 240 roots of E8, scaled to unit vectors... as the
/// source has them: (+-1, +-1, 0^6) and (+-1/2)^8 with an even number of minus signs.
fn e8_roots() -> Vec<Vec<f64>> {
    let mut r: Vec<Vec<f64>> = Vec::new();
    for i in 0..8 {
        for j in i + 1..8 {
            for si in [1.0, -1.0] {
                for sj in [1.0, -1.0] {
                    let mut v = vec![0.0f64; 8];
                    v[i] = si;
                    v[j] = sj;
                    r.push(v);
                }
            }
        }
    }
    for s in sign_vectors(8, Some(0)) {
        r.push(s.iter().map(|x| x / 2.0).collect());
    }
    r
}

/// `w.reduce((a, x, k) => a + x * u[k], 0)`.
fn dot8(w: &[f64], u: &[f64]) -> f64 {
    let mut a = 0.0f64;
    for k in 0..w.len() {
        a += w[k] * u[k];
    }
    a
}

/// packages/ndim/src/generate.ts: e8Frame. The orthonormal frame the generator puts E8 in:
/// Gram-Schmidt of the roots in the order of e8Roots (the first root becomes the first axis, and so
/// on), so that vertex k of the polytope is the root's coordinates along these axes over sqrt(2).
fn e8_frame(roots: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let mut frame: Vec<Vec<f64>> = Vec::new();
    for r in roots {
        let mut w = r.clone();
        for u in &frame {
            let f = dot8(&w, u);
            for k in 0..8 {
                w[k] -= f * u[k];
            }
        }
        let len = math::hypot_of(&w);
        if len > 1e-6 {
            frame.push(w.iter().map(|x| x / len).collect());
        }
        if frame.len() == 8 {
            break;
        }
    }
    frame
}

/// packages/ndim/src/generate.ts: e8Cell. The 4_21 polytope.
fn e8_cell() -> Result<Data, Thrown> {
    let roots = e8_roots();
    let frame = e8_frame(&roots);
    let in_frame = |x: &[f64]| -> Vec<f64> { frame.iter().map(|u| dot8(x, u)).collect() };
    let scaled = |r: &[f64]| -> Vec<f64> { r.iter().map(|x| x * FRAC_1_SQRT_2).collect() };
    let v: Vec<f64> = roots.iter().flat_map(|r| in_frame(&scaled(r))).collect();
    // simple roots (Bourbaki), unit length: reflecting in them generates the Weyl group, which preserves the polytope
    let simple: Vec<Vec<f64>> = [
        [0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5],
        [1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        [-1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        [0.0, -1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, -1.0, 1.0, 0.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, -1.0, 1.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0, -1.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 1.0, 0.0],
    ]
    .iter()
    .map(|r| in_frame(&scaled(r)))
    .collect();
    let s = SQRT_2 / 8.0;
    let reps: [(Vec<f64>, f64, usize); 2] = [
        (vec![-0.75, -0.5, -s, -s, -s, -s, -s, -s], 0.75, 17280),
        (
            vec![-FRAC_1_SQRT_2, -FRAC_1_SQRT_2 / 2.0, -0.25, -0.25, -0.25, -0.25, -0.25, 0.25],
            FRAC_1_SQRT_2,
            2160,
        ),
    ];
    let mut n: Vec<f64> = Vec::new();
    let mut b: Vec<f64> = Vec::new();
    for (rep_n, rep_b, count) in reps {
        // the source's key is the text of the rounded coordinates joined by commas (a -0 prints as "0"): the
        // integers themselves are the same key
        let key = |x: &[f64]| -> Vec<i64> { x.iter().map(|c| math::round(c * 1e7) as i64).collect() };
        let mut seen: HashSet<Vec<i64>> = HashSet::new();
        seen.insert(key(&rep_n));
        let mut queue: Vec<Vec<f64>> = vec![rep_n];
        let mut q = 0;
        while q < queue.len() {
            let x = queue[q].clone();
            for u in &simple {
                let mut dot = 0.0f64;
                for k in 0..8 {
                    dot += x[k] * u[k];
                }
                let y: Vec<f64> = (0..8).map(|k| x[k] - 2.0 * dot * u[k]).collect();
                let len = math::hypot_of(&y);
                let z: Vec<f64> = y.iter().map(|c| c / len).collect();
                let kz = key(&z);
                if !seen.contains(&kz) {
                    seen.insert(kz);
                    queue.push(z);
                }
            }
            q += 1;
        }
        if queue.len() != count {
            return Err(Thrown(format!("4_21: {} facets in an orbit, expected {}", queue.len(), count)));
        }
        for x in &queue {
            n.extend_from_slice(x);
            b.push(rep_b);
        }
    }
    Ok(Data { v, n, b })
}

/// The dimension and name of a code of the form `<digits>:<name>` with the name one of `names`
/// (the regular expressions `/^(\d+):(simplex|cube|...)$/` of the source; `\d` is an ASCII digit).
pub(crate) fn split_code<'a>(code: &'a str, names: &[&str]) -> Option<(&'a str, &'a str)> {
    let (digits, name) = code.split_once(':')?;
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) || !names.contains(&name) {
        return None;
    }
    Some((digits, name))
}

/// packages/ndim/src/generate.ts: FORMULA_NAMES. The formula families (simplex, cube, ortho, demi)
/// of any dimension, and 8:421.
pub const FORMULA_NAMES: [&str; 5] = ["simplex", "cube", "ortho", "demi", "421"];

/// packages/ndim/src/generate.ts: generatePolytope. The data of a polytope computed from formulas,
/// or None when the code is not one of those. (The callers ask only for codes of the catalogue, so
/// d is 4 to 10; a dimension that does not fit a small integer is answered None here.)
pub fn generate_polytope(code: &str) -> Result<Option<Data>, Thrown> {
    let Some((digits, name)) = split_code(code, &FORMULA_NAMES) else {
        return Ok(None);
    };
    let Ok(d) = digits.parse::<usize>() else {
        return Ok(None);
    };
    if d > 20 {
        return Ok(None);
    }
    Ok(match name {
        "simplex" => Some(simplex(d)),
        "cube" => Some(cube(d)),
        "ortho" => Some(ortho(d)),
        "demi" => {
            if d >= 5 {
                Some(demi(d))
            } else {
                None
            }
        }
        _ => {
            if d == 8 {
                Some(e8_cell()?)
            } else {
                None
            }
        }
    })
}
