//! Facets of the convex hull of a full-dimensional point set in R^k, by gift wrapping (facet to
//! facet pivoting), for any k >= 1. Port of packages/boundary/src/hull.ts.
//!
//! Built for polytope vertex lists: every input point must be a vertex of the hull (no point inside
//! a face), and faces may have many vertices (the tesseract's cells are cubes, not simplices).
//!
//! - Initial facet: start from the supporting hyperplane with normal e_0 and, while its contact set
//!   S spans less than a hyperplane, rotate the normal about aff(S) towards a direction w orthogonal
//!   to aff(S) and to the normal, until a new point is hit (the "pivot" below). Each pivot adds a
//!   point outside aff(S), so k - 1 pivots at most.
//! - Neighbours: the ridges of a facet F are the facets of F inside its own hyperplane (recursion in
//!   R^(k-1)). Rotating F's normal n about a ridge R towards R's outward in-facet normal w, the
//!   first points hit span the neighbouring facet across R.
//!
//! Pivot about an affine subspace A (contained in the current supporting hyperplane, normal n),
//! towards a unit w orthogonal to n and to A: for a point p off the hyperplane write
//! a = (p - r0).w and b = (p - r0).n < 0 (r0 in A). The normal n(t) = cos t n + sin t w keeps p on
//! the inner side, (p - r0).n(t) <= 0, exactly while t <= atan2(-b, a), a value in (0, pi). The
//! largest admissible t is the minimum over p, and the points that reach it join the contact set.
//!
//! The server's polytopes are read from tables written by the TypeScript (polytope.rs), because the
//! pivots use atan2, cos and sin, whose last bit differs between V8 and the `libm` crate; this
//! module is the port that `build_polytope` runs, and a test compares its polytopes with the tables.

use crate::linalg::{dot, norm, orthonormal_basis, reject_from, sub, unit};
use polypack_js::math;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct HullRidge {
    /// Point indices of the ridge.
    pub ids: Vec<usize>,
    /// Unit normal of the ridge inside the facet's hyperplane, pointing out of the facet.
    pub w: Vec<f64>,
    /// Index of the facet across the ridge.
    pub neighbor: usize,
}

#[derive(Clone, Debug)]
pub struct HullFacet {
    /// Point indices on the facet, ascending.
    pub ids: Vec<usize>,
    /// Outward unit normal; every point p has normal . p <= offset.
    pub normal: Vec<f64>,
    pub offset: f64,
    pub ridges: Vec<HullRidge>,
}

/// packages/boundary/src/hull.ts: argmaxSet
fn argmax_set(pts: &[Vec<f64>], n: &[f64], tol: f64) -> Vec<usize> {
    let mut best = f64::NEG_INFINITY;
    for p in pts {
        best = math::max(best, dot(p, n));
    }
    let mut out = Vec::new();
    for (i, p) in pts.iter().enumerate() {
        if dot(p, n) >= best - tol {
            out.push(i);
        }
    }
    out
}

/// Orthonormal basis of the directions of aff(points[ids]).
/// packages/boundary/src/hull.ts: affineBasis
fn affine_basis(pts: &[Vec<f64>], ids: &[usize], tol: f64) -> Vec<Vec<f64>> {
    let p0 = &pts[ids[0]];
    let vs: Vec<Vec<f64>> = ids[1..].iter().map(|&i| sub(&pts[i], p0)).collect();
    orthonormal_basis(&vs, tol)
}

/// Rotates the supporting hyperplane (normal n through r0) about the contact set towards w; returns the new normal.
/// packages/boundary/src/hull.ts: pivot
fn pivot(pts: &[Vec<f64>], members: &[bool], n: &[f64], w: &[f64], r0: &[f64], tol: f64) -> Result<Vec<f64>, String> {
    let mut best = f64::INFINITY;
    for (i, p) in pts.iter().enumerate() {
        if members[i] {
            continue;
        }
        let d = sub(p, r0);
        let b = dot(&d, n);
        if b > -tol {
            continue; // on the hyperplane: already a member up to rounding
        }
        let t = math::atan2(-b, dot(&d, w));
        if t < best {
            best = t;
        }
    }
    if !best.is_finite() {
        return Err("convexHull: the points are not full-dimensional".to_string());
    }
    let c = math::cos(best);
    let s = math::sin(best);
    let v: Vec<f64> = n.iter().enumerate().map(|(i, x)| c * x + s * w[i]).collect();
    Ok(unit(&v))
}

/// The contact set of the hyperplane (normal n through r0), and its normal refitted to those points.
/// packages/boundary/src/hull.ts: contact
fn contact(pts: &[Vec<f64>], n: &[f64], r0: &[f64], tol: f64) -> (Vec<usize>, Vec<f64>) {
    let mut ids = Vec::new();
    for (i, p) in pts.iter().enumerate() {
        if dot(&sub(p, r0), n).abs() <= tol {
            ids.push(i);
        }
    }
    // refit: the normal is orthogonal to aff(ids); remove the rounding drift of the pivot
    let b = affine_basis(pts, &ids, tol);
    let mut m = reject_from(n, &b);
    if norm(&m) < 0.5 {
        m = n.to_vec();
    }
    (ids, unit(&m))
}

fn member_set(n: usize, ids: &[usize]) -> Vec<bool> {
    let mut m = vec![false; n];
    for &i in ids {
        m[i] = true;
    }
    m
}

fn basis_vector(k: usize, j: usize) -> Vec<f64> {
    (0..k).map(|i| if i == j { 1.0 } else { 0.0 }).collect()
}

/// packages/boundary/src/hull.ts: convexHull (tol defaults to 1e-9 there)
pub fn convex_hull(points: &[Vec<f64>], tol: f64) -> Result<Vec<HullFacet>, String> {
    let k = points[0].len();
    let mut sc = 1.0;
    for p in points {
        let mut m = f64::NEG_INFINITY;
        for x in p {
            m = math::max(m, x.abs());
        }
        sc = math::max(sc, m);
    }
    let eps = tol * sc;
    if k == 1 {
        let xs: Vec<f64> = points.iter().map(|p| p[0]).collect();
        let lo = math::min_of(&xs);
        let hi = math::max_of(&xs);
        if hi - lo <= eps {
            return Err("convexHull: the points are not full-dimensional".to_string());
        }
        let lo_ids: Vec<usize> = (0..xs.len()).filter(|&i| xs[i] <= lo + eps).collect();
        let hi_ids: Vec<usize> = (0..xs.len()).filter(|&i| xs[i] >= hi - eps).collect();
        return Ok(vec![
            HullFacet { ids: lo_ids, normal: vec![-1.0], offset: -lo, ridges: vec![] },
            HullFacet { ids: hi_ids, normal: vec![1.0], offset: hi, ridges: vec![] },
        ]);
    }

    // initial facet
    let mut n: Vec<f64> = basis_vector(k, 0);
    let mut s_ids = argmax_set(points, &n, eps);
    let mut guard = 0;
    loop {
        if guard > k {
            return Err("convexHull: could not find an initial facet".to_string());
        }
        let b = affine_basis(points, &s_ids, eps);
        if b.len() >= k - 1 {
            break;
        }
        // a direction orthogonal to n and to aff(S): the standard basis vector with the largest residual
        let mut reference: Vec<Vec<f64>> = vec![n.clone()];
        reference.extend(b);
        let bref = orthonormal_basis(&reference, eps);
        let mut w: Vec<f64> = Vec::new();
        let mut wn = 0.0;
        for j in 0..k {
            let r = reject_from(&basis_vector(k, j), &bref);
            let rn = norm(&r);
            if rn > wn {
                wn = rn;
                w = r;
            }
        }
        let w = unit(&w);
        let r0 = &points[s_ids[0]];
        n = pivot(points, &member_set(points.len(), &s_ids), &n, &w, r0, eps)?;
        let (ids, normal) = contact(points, &n, r0, eps);
        n = normal;
        s_ids = ids;
        guard += 1;
    }

    let mut facets: Vec<HullFacet> = Vec::new();
    let mut index: HashMap<Vec<usize>, usize> = HashMap::new();
    // packages/boundary/src/hull.ts: convexHull, `add`
    fn add(facets: &mut Vec<HullFacet>, index: &mut HashMap<Vec<usize>, usize>, points: &[Vec<f64>], ids: Vec<usize>, normal: Vec<f64>) -> usize {
        if let Some(&got) = index.get(&ids) {
            return got;
        }
        let offset = dot(&normal, &points[ids[0]]);
        index.insert(ids.clone(), facets.len());
        facets.push(HullFacet { ids, normal, offset, ridges: vec![] });
        facets.len() - 1
    }
    add(&mut facets, &mut index, points, s_ids, n);
    let mut fi = 0;
    while fi < facets.len() {
        let f_ids = facets[fi].ids.clone();
        let f_normal = facets[fi].normal.clone();
        let members = member_set(points.len(), &f_ids);
        // the facet's points in an orthonormal basis of its hyperplane
        let std: Vec<Vec<f64>> = (0..k).map(|j| reject_from(&basis_vector(k, j), std::slice::from_ref(&f_normal))).collect();
        let mut basis = orthonormal_basis(&std, 1e-6);
        basis.truncate(k - 1);
        let mut c0 = vec![0.0; k];
        for &i in &f_ids {
            let p = &points[i];
            c0 = c0.iter().enumerate().map(|(t, x)| x + p[t] / f_ids.len() as f64).collect();
        }
        let local: Vec<Vec<f64>> = f_ids
            .iter()
            .map(|&i| {
                let d = sub(&points[i], &c0);
                basis.iter().map(|b| dot(&d, b)).collect()
            })
            .collect();
        let sub_ = convex_hull(&local, tol)?;
        for r in &sub_ {
            let mut ids: Vec<usize> = r.ids.iter().map(|&j| f_ids[j]).collect();
            ids.sort_unstable();
            let wv: Vec<f64> = (0..basis[0].len())
                .map(|i| {
                    let mut acc = 0.0;
                    for (j, b) in basis.iter().enumerate() {
                        acc += b[i] * r.normal[j];
                    }
                    acc
                })
                .collect();
            let w = unit(&wv);
            let r0 = &points[ids[0]];
            let n2 = pivot(points, &members, &f_normal, &w, r0, eps)?;
            let (c_ids, c_normal) = contact(points, &n2, r0, eps);
            let nb = add(&mut facets, &mut index, points, c_ids, c_normal);
            facets[fi].ridges.push(HullRidge { ids, w, neighbor: nb });
        }
        fi += 1;
    }
    Ok(facets)
}
