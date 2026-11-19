//! Moving a centre on the boundary: the exponential map in the cells' local charts.
//! Port of packages/boundary/src/search/chart.ts.
//!
//! A centre (cell c, local u) moved by a vector v of c's local frame follows the segment u + t v,
//! t in [0, 1], of c's development: straight inside c; where it crosses a facet of c (a ridge of
//! the polytope) it goes on in the neighbour, unfolded by the gluing (CellFacet.to_neighbor:
//! y' = A y + s b, an isometry fixing the ridge). Wherever the segment avoids the hinges, the map
//! v -> (end cell, end u) is a local isometry whose derivative is the product M of the crossed
//! gluings' linear parts, so the gradient of an energy with respect to v is M^T times its gradient
//! with respect to u. A segment that meets a hinge has no continuation (the boundary is not flat
//! there): `move_` reports it and the energy is Infinity, which the line search treats as too long
//! a step.

use super::random::Mulberry32;
use crate::polytope::Polytope;
use polypack_js::math;

/// packages/boundary/src/search/chart.ts: Charts
pub struct Charts {
    pub cell_count: usize,
    /// Per cell: per facet n (3) and h (at s = 1), the facet being { y : n . y <= s h }.
    planes: Vec<Vec<f64>>,
    /// Per cell: per facet the gluing's A (9, row-major) and b (3, at s = 1).
    glue: Vec<Vec<f64>>,
    neighbor: Vec<Vec<usize>>,
}

impl Charts {
    pub fn new(poly: &Polytope) -> Charts {
        let planes = poly
            .cells
            .iter()
            .map(|c| {
                let mut out = vec![0.0; 4 * c.facets.len()];
                for (k, f) in c.facets.iter().enumerate() {
                    out[4 * k] = f.inside.n[0];
                    out[4 * k + 1] = f.inside.n[1];
                    out[4 * k + 2] = f.inside.n[2];
                    out[4 * k + 3] = f.inside.h;
                }
                out
            })
            .collect();
        let glue = poly
            .cells
            .iter()
            .map(|c| {
                let mut out = vec![0.0; 12 * c.facets.len()];
                for (k, f) in c.facets.iter().enumerate() {
                    let a = &f.to_neighbor.a;
                    for r in 0..3 {
                        for q in 0..3 {
                            out[12 * k + 3 * r + q] = a[r][q];
                        }
                    }
                    for r in 0..3 {
                        out[12 * k + 9 + r] = f.to_neighbor.b[r];
                    }
                }
                out
            })
            .collect();
        let neighbor = poly.cells.iter().map(|c| c.facets.iter().map(|f| f.neighbor).collect()).collect();
        Charts { cell_count: poly.cells.len(), planes, glue, neighbor }
    }

    /// Moves the centre (cell, U[uo..uo+2]) by v (in that cell's frame) at edge s. Writes the end
    /// point into out_u[ou..ou+2] (clamped into its closed cell) and the linear part M of the map
    /// (start frame -> end frame, row-major) into out_m[om..om+8]; returns the end cell, or -1 when the
    /// segment meets a hinge.
    /// packages/boundary/src/search/chart.ts: Charts.move
    #[allow(clippy::too_many_arguments)]
    pub fn move_(&self, cell: usize, u: &[f64], uo: usize, v0: f64, v1: f64, v2: f64, s: f64, out_u: &mut [f64], ou: usize, out_m: &mut [f64], om: usize) -> i64 {
        let mut c = cell;
        let mut px = u[uo];
        let mut py = u[uo + 1];
        let mut pz = u[uo + 2];
        let (mut m0, mut m1, mut m2, mut m3, mut m4, mut m5, mut m6, mut m7, mut m8) = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
        let len = (v0 * v0 + v1 * v1 + v2 * v2).sqrt();
        if len > 0.0 {
            let mut dx = v0 / len;
            let mut dy = v1 / len;
            let mut dz = v2 / len;
            let mut rem = len;
            let tol_h = 1e-12 * math::max(1.0, s);
            let mut step = 0;
            loop {
                if step > 64 {
                    return -1;
                }
                let pl = &self.planes[c];
                let nf = pl.len() >> 2;
                let mut best = f64::INFINITY;
                let mut k: i64 = -1;
                for f in 0..nf {
                    let nd = pl[4 * f] * dx + pl[4 * f + 1] * dy + pl[4 * f + 2] * dz;
                    if nd <= 1e-15 {
                        continue;
                    }
                    let t = (s * pl[4 * f + 3] - (pl[4 * f] * px + pl[4 * f + 1] * py + pl[4 * f + 2] * pz)) / nd;
                    if t < best {
                        best = t;
                        k = f as i64;
                    }
                }
                if best >= rem || k < 0 {
                    px += rem * dx;
                    py += rem * dy;
                    pz += rem * dz;
                    break;
                }
                let k = k as usize;
                if best < 0.0 {
                    best = 0.0;
                }
                let qx = px + best * dx;
                let qy = py + best * dy;
                let qz = pz + best * dz;
                // the crossing point lies on another facet too: it is a point of a hinge
                for f in 0..nf {
                    if f == k {
                        continue;
                    }
                    if s * pl[4 * f + 3] - (pl[4 * f] * qx + pl[4 * f + 1] * qy + pl[4 * f + 2] * qz) < tol_h {
                        return -1;
                    }
                }
                let g = &self.glue[c];
                let o = 12 * k;
                let (a0, a1, a2, a3, a4, a5, a6, a7, a8) = (g[o], g[o + 1], g[o + 2], g[o + 3], g[o + 4], g[o + 5], g[o + 6], g[o + 7], g[o + 8]);
                px = a0 * qx + a1 * qy + a2 * qz + s * g[o + 9];
                py = a3 * qx + a4 * qy + a5 * qz + s * g[o + 10];
                pz = a6 * qx + a7 * qy + a8 * qz + s * g[o + 11];
                let ex = a0 * dx + a1 * dy + a2 * dz;
                let ey = a3 * dx + a4 * dy + a5 * dz;
                let ez = a6 * dx + a7 * dy + a8 * dz;
                dx = ex;
                dy = ey;
                dz = ez;
                let n0 = a0 * m0 + a1 * m3 + a2 * m6;
                let n1 = a0 * m1 + a1 * m4 + a2 * m7;
                let n2 = a0 * m2 + a1 * m5 + a2 * m8;
                let n3 = a3 * m0 + a4 * m3 + a5 * m6;
                let n4 = a3 * m1 + a4 * m4 + a5 * m7;
                let n5 = a3 * m2 + a4 * m5 + a5 * m8;
                let n6 = a6 * m0 + a7 * m3 + a8 * m6;
                let n7 = a6 * m1 + a7 * m4 + a8 * m7;
                let n8 = a6 * m2 + a7 * m5 + a8 * m8;
                m0 = n0;
                m1 = n1;
                m2 = n2;
                m3 = n3;
                m4 = n4;
                m5 = n5;
                m6 = n6;
                m7 = n7;
                m8 = n8;
                c = self.neighbor[c][k];
                rem -= best;
                step += 1;
            }
        }
        // rounding may leave the point a hair outside its cell
        let pl = &self.planes[c];
        for f in 0..(pl.len() >> 2) {
            let ex = pl[4 * f] * px + pl[4 * f + 1] * py + pl[4 * f + 2] * pz - s * pl[4 * f + 3];
            if ex > 0.0 {
                px -= ex * pl[4 * f];
                py -= ex * pl[4 * f + 1];
                pz -= ex * pl[4 * f + 2];
            }
        }
        out_u[ou] = px;
        out_u[ou + 1] = py;
        out_u[ou + 2] = pz;
        out_m[om] = m0;
        out_m[om + 1] = m1;
        out_m[om + 2] = m2;
        out_m[om + 3] = m3;
        out_m[om + 4] = m4;
        out_m[om + 5] = m5;
        out_m[om + 6] = m6;
        out_m[om + 7] = m7;
        out_m[om + 8] = m8;
        c as i64
    }
}

/// A random point of a cell at edge s, `shrink` times the way from the cell's centre to its
/// boundary: uniform in the shrunk cube for the tesseract, a random convex combination of the
/// vertices otherwise. packages/boundary/src/search/chart.ts: randomCellPoint
pub fn random_cell_point(poly: &Polytope, cell: usize, s: f64, rand: &mut Mulberry32, shrink: f64) -> [f64; 3] {
    if poly.name == "tesseract" {
        let h = (s / 2.0) * shrink;
        // the three draws are made in order, as the array literal does
        let a = (2.0 * rand.next() - 1.0) * h;
        let b = (2.0 * rand.next() - 1.0) * h;
        let c = (2.0 * rand.next() - 1.0) * h;
        return [a, b, c];
    }
    let v = &poly.cells[cell].vertices;
    let w: Vec<f64> = v.iter().map(|_| -math::log(1.0 - rand.next())).collect();
    let mut total = 0.0;
    for x in &w {
        total += x;
    }
    let mut p = [0.0; 3];
    for (i, vi) in v.iter().enumerate() {
        for k in 0..3 {
            p[k] += (w[i] / total) * vi[k] * s * shrink;
        }
    }
    p
}
