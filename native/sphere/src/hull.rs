//! Facets of the convex hull of unit vectors. Source: packages/sphere/src/hull.ts.
//!
//! Coplanar triangles need only one supporting plane. Incremental hull, oriented away from a fixed
//! interior tetrahedron point; O(m²) work, O(m) faces. Used only to propose float planes; the
//! Python certifier verifies its candidates in intervals.

use crate::geometry::{cross, dot, norm, sub, Vec3};
use polypack_js::math;
use std::collections::HashMap;

/// A face of the growing hull: `type Face` of hull.ts.
#[derive(Clone, Copy)]
struct Face {
    v: [usize; 3],
    n: Vec3,
    offset: f64,
    slack: f64,
}

/// The closure `face` of hull.ts: the triangle (i, j, k) turned so that its normal points away from
/// `inside`.
fn face(s: &[Vec3], inside: &Vec3, i: usize, mut j: usize, mut k: usize) -> Face {
    let mut n = cross(&sub(&s[j], &s[i]), &sub(&s[k], &s[i]));
    if dot(&n, &sub(inside, &s[i])) > 0.0 {
        std::mem::swap(&mut j, &mut k);
        n = [-n[0], -n[1], -n[2]];
    }
    Face {
        v: [i, j, k],
        n,
        offset: dot(&n, &s[i]),
        slack: 1e-15 * norm(&n),
    }
}

/// `Array.prototype.sort` with the comparator `(i, j) => key[i] - key[j]`, as a binary insertion
/// sort (the one V8 uses for short arrays). Every stable sort gives the same order when the keys
/// are numbers; with a NaN key (a comparator that answers NaN, which V8 reads as "not smaller")
/// this one neither panics nor loops, and for more than 32 elements it may then order differently
/// from V8's merge of runs. No finite input reaches that case.
fn sort_by_key_difference(order: &mut [usize], key: &[f64]) {
    for start in 1..order.len() {
        let pivot = order[start];
        let (mut left, mut right) = (0usize, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if key[pivot] - key[order[mid]] < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        let mut p = start;
        while p > left {
            order[p] = order[p - 1];
            p -= 1;
        }
        order[left] = pivot;
    }
}

/// hull.ts: `hullFaces`. The triangles (indices into `s`) of the convex hull of the points `s`;
/// `s` needs at least four points (the validator calls it with more than 16).
pub fn hull_faces(s: &[Vec3]) -> Vec<[usize; 3]> {
    let a = 0usize;
    let (mut b, mut c, mut d) = (1usize, 2usize, 3usize);
    for i in 1..s.len() {
        if norm(&sub(&s[i], &s[a])) > norm(&sub(&s[b], &s[a])) {
            b = i;
        }
    }
    let line = sub(&s[b], &s[a]);
    for i in 1..s.len() {
        if norm(&cross(&line, &sub(&s[i], &s[a]))) > norm(&cross(&line, &sub(&s[c], &s[a]))) {
            c = i;
        }
    }
    let plane = cross(&line, &sub(&s[c], &s[a]));
    for i in 1..s.len() {
        if math::abs(dot(&plane, &sub(&s[i], &s[a]))) > math::abs(dot(&plane, &sub(&s[d], &s[a]))) {
            d = i;
        }
    }
    if math::abs(dot(&plane, &sub(&s[d], &s[a]))) < 1e-24 {
        // Coplanar unit vectors lie on a circle. A fan includes every boundary edge and its plane.
        let len = s.len() as f64;
        let mut centre: Vec3 = [0.0, 0.0, 0.0];
        for p in s {
            centre = [centre[0] + p[0] / len, centre[1] + p[1] / len, centre[2] + p[2] / len];
        }
        let side = cross(&plane, &line);
        // the comparator's key of each point (the source computes it at every comparison)
        let key: Vec<f64> = s
            .iter()
            .map(|p| {
                let r = sub(p, &centre);
                math::atan2(dot(&r, &side), dot(&r, &line))
            })
            .collect();
        let mut order: Vec<usize> = (0..s.len()).collect();
        sort_by_key_difference(&mut order, &key);
        // order.slice(1, -1).map((i, k) => [order[0], i, order[k + 2]])
        return (1..order.len() - 1)
            .map(|k| [order[0], order[k], order[k + 1]])
            .collect();
    }
    let inside: Vec3 = [
        (s[a][0] + s[b][0] + s[c][0] + s[d][0]) / 4.0,
        (s[a][1] + s[b][1] + s[c][1] + s[d][1]) / 4.0,
        (s[a][2] + s[b][2] + s[c][2] + s[d][2]) / 4.0,
    ];
    let mut faces = vec![
        face(s, &inside, a, b, c),
        face(s, &inside, a, d, b),
        face(s, &inside, a, c, d),
        face(s, &inside, b, d, c),
    ];
    // The source's `edges` is a Map from "u,v" (smaller index first) to [u, v]: an edge seen twice
    // is deleted, and the edges left (the horizon) are read in the order they were inserted. Here:
    // the list of insertions, with a deleted one blanked, and where each live key sits in it.
    let mut horizon: Vec<Option<(usize, usize)>> = Vec::new();
    let mut live: HashMap<(usize, usize), usize> = HashMap::new();
    for i in 0..s.len() {
        if i == a || i == b || i == c || i == d {
            continue;
        }
        horizon.clear();
        live.clear();
        // `kept`: the faces that do not see the point stay, in their order; the edges of the others
        // are counted
        faces.retain(|f| {
            if dot(&f.n, &s[i]) - f.offset <= f.slack {
                return true;
            }
            for e in 0..3 {
                let u = f.v[e];
                let v = f.v[(e + 1) % 3];
                let key = if u < v { (u, v) } else { (v, u) };
                if let Some(at) = live.remove(&key) {
                    horizon[at] = None;
                } else {
                    live.insert(key, horizon.len());
                    horizon.push(Some((u, v)));
                }
            }
            false
        });
        for &(u, v) in horizon.iter().flatten() {
            faces.push(face(s, &inside, u, v, i));
        }
    }
    faces.iter().map(|f| f.v).collect()
}
