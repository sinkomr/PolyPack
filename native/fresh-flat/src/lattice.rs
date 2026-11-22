//! Periodic arrangements used as starts: rows of pieces, either all in one orientation or (odd N)
//! alternating "vertex up" and "vertex down", stacked with the offset that packs the rows closest.
//! Every spacing is found by bisection on the exact separation, so an arrangement has no overlap.

use crate::geom::Shape;
use std::f64::consts::PI;

#[derive(Clone, Debug)]
pub struct Lattice {
    /// Pieces of one row period: (x, y, theta) relative to the period's origin.
    pub motif: Vec<[f64; 3]>,
    /// Row period along x.
    pub period: f64,
    /// Offset of the next row.
    pub shift: [f64; 2],
    /// Covered fraction of the plane.
    pub density: f64,
}

impl Lattice {
    /// Piece (row j, period k, motif element e).
    pub fn piece(&self, j: i64, k: i64, e: usize) -> [f64; 3] {
        let m = self.motif[e];
        [m[0] + k as f64 * self.period + j as f64 * self.shift[0], m[1] + j as f64 * self.shift[1], m[2]]
    }
}

/// A piece orientation: vertex offsets from the centre and outward edge normals.
struct Oriented {
    off: Vec<[f64; 2]>,
    nrm: Vec<[f64; 2]>,
}

fn oriented(sh: &Shape, th: f64) -> Oriented {
    let n = sh.n;
    let mut off = vec![[0.0; 2]; n];
    sh.vertices(0.0, 0.0, th, &mut off);
    let nrm = (0..n)
        .map(|k| {
            let a = th + PI / 2.0 + PI / n as f64 + 2.0 * PI * k as f64 / n as f64;
            [a.cos(), a.sin()]
        })
        .collect();
    Oriented { off, nrm }
}

/// The separating-axis separation of two oriented pieces at centres pa and pb (as `sat_sep`, without
/// trigonometry).
fn sep_oriented(sh: &Shape, a: &Oriented, pa: [f64; 2], b: &Oriented, pb: [f64; 2]) -> f64 {
    let dx = pb[0] - pa[0];
    let dy = pb[1] - pa[1];
    if sh.n == 0 {
        return (dx * dx + dy * dy).sqrt() - 1.0;
    }
    let mut best = f64::NEG_INFINITY;
    for u in a.nrm.iter().chain(b.nrm.iter()) {
        let (mut amin, mut amax, mut bmin, mut bmax) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for o in &a.off {
            let t = u[0] * o[0] + u[1] * o[1];
            amin = amin.min(t);
            amax = amax.max(t);
        }
        let ud = u[0] * dx + u[1] * dy;
        for o in &b.off {
            let t = u[0] * o[0] + u[1] * o[1] + ud;
            bmin = bmin.min(t);
            bmax = bmax.max(t);
        }
        best = best.max(bmin - amax).max(amin - bmax);
    }
    best
}

fn clear(sh: &Shape, a: &Oriented, pa: [f64; 2], b: &Oriented, pb: [f64; 2]) -> bool {
    let dx = pb[0] - pa[0];
    let dy = pb[1] - pa[1];
    let reach = 2.0 * sh.big_r;
    if dx * dx + dy * dy >= reach * reach {
        return true;
    }
    sep_oriented(sh, a, pa, b, pb) >= 1e-12
}

/// Smallest t in [lo, hi] (hi feasible) with feasible(t), by bisection.
fn bisect(mut lo: f64, mut hi: f64, mut feasible: impl FnMut(f64) -> bool) -> f64 {
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        if feasible(mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    hi
}

/// The rows' arrangement for a motif of orientations `thetas` (one per element) at heights `ys`.
fn build(sh: &Shape, thetas: &[f64], ys: &[f64]) -> Lattice {
    let r = sh.big_r;
    let ne = thetas.len();
    let ori: Vec<Oriented> = thetas.iter().map(|&t| oriented(sh, t)).collect();
    let xy = |m: [f64; 3]| [m[0], m[1]];
    // consecutive elements of a row, each as close as it can be to the previous one
    let mut motif: Vec<[f64; 3]> = Vec::with_capacity(ne);
    motif.push([0.0, ys[0], thetas[0]]);
    for e in 1..ne {
        let prev = motif[e - 1];
        let y = ys[e];
        let th = thetas[e];
        let dx = bisect(0.0, 2.0 * r + 1e-9, |d| {
            let cand = [prev[0] + d, y];
            (0..e).all(|a| clear(sh, &ori[a], xy(motif[a]), &ori[e], cand))
        });
        motif.push([prev[0] + dx, y, th]);
    }
    // the period: the next copy of the motif clears every element of this one
    let last = motif[ne - 1];
    let first = motif[0];
    let period = bisect(0.0, last[0] - first[0] + 2.0 * r + 1e-9, |pd| {
        (0..ne).all(|a| (0..ne).all(|b| clear(sh, &ori[a], xy(motif[a]), &ori[b], [motif[b][0] + pd, motif[b][1]])))
    })
    .max(last[0] - first[0] + 1e-12);
    // stack: for a range of horizontal shifts, the smallest vertical offset clearing the row
    let row_clear = |sx: f64, sy: f64| -> bool {
        for k in -2i64..=2 {
            for a in 0..ne {
                for b in 0..ne {
                    let pb = [motif[b][0] + k as f64 * period + sx, motif[b][1] + sy];
                    if !clear(sh, &ori[a], xy(motif[a]), &ori[b], pb) {
                        return false;
                    }
                }
            }
        }
        true
    };
    let height = 4.0 * r + 1e-9;
    let mut best = (f64::INFINITY, 0.0);
    let steps = 32;
    for t in 0..steps {
        let sx = period * t as f64 / steps as f64;
        let sy = bisect(0.0, height, |sy| row_clear(sx, sy));
        if sy < best.0 - 1e-12 {
            best = (sy, sx);
        }
    }
    // refine the shift around the best
    let mut lo = best.1 - period / steps as f64;
    let mut hi = best.1 + period / steps as f64;
    for _ in 0..30 {
        let a = lo + (hi - lo) / 3.0;
        let b = hi - (hi - lo) / 3.0;
        let fa = bisect(0.0, height, |sy| row_clear(a, sy));
        let fb = bisect(0.0, height, |sy| row_clear(b, sy));
        if fa < fb {
            hi = b;
        } else {
            lo = a;
        }
    }
    let sx = 0.5 * (lo + hi);
    let sy = bisect(0.0, height, |sy| row_clear(sx, sy));
    let (sy, sx) = if sy < best.0 { (sy, sx) } else { best };
    let density = ne as f64 * sh.piece_area() / (period * sy);
    Lattice { motif, period, shift: [sx, sy], density }
}

/// The arrangements tried for a shape, densest first.
pub fn lattices(sh: &Shape) -> Vec<Lattice> {
    let mut out = Vec::new();
    if sh.n == 0 {
        out.push(build(sh, &[0.0], &[0.0]));
        return out;
    }
    let n = sh.n as f64;
    let face_x = -PI / 2.0 - PI / n; // a face normal along +x
    let vert_x = -PI / 2.0; // a vertex along +x
    out.push(build(sh, &[face_x], &[0.0]));
    out.push(build(sh, &[vert_x], &[0.0]));
    if sh.n % 2 == 1 {
        // vertex up (flat bottom) and vertex down, interleaved; the down piece's top edge level with
        // the up piece's apex, or both centres on one line
        let up = 0.0;
        let down = PI / n;
        out.push(build(sh, &[up, down], &[0.0, sh.big_r - sh.apo]));
        out.push(build(sh, &[up, down], &[0.0, 0.0]));
        out.push(build(sh, &[face_x, face_x + PI / n], &[0.0, 0.0]));
    }
    out.sort_by(|a, b| b.density.partial_cmp(&a.density).unwrap());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::sat_sep;

    #[test]
    fn tilings_are_found() {
        // squares, hexagons and triangles tile the plane; disks pack hexagonally
        for (n, want) in [(4usize, 1.0), (6, 1.0), (3, 1.0), (0, PI / 12f64.sqrt())] {
            let sh = Shape::new(n, 4);
            let l = &lattices(&sh)[0];
            assert!((l.density - want).abs() < 1e-6, "n={n}: density {}", l.density);
        }
    }

    #[test]
    fn arrangements_do_not_overlap() {
        for n in [0usize, 3, 4, 5, 6, 7, 8] {
            let sh = Shape::new(n, 0);
            for l in lattices(&sh) {
                let mut pts = Vec::new();
                for j in -2..=2 {
                    for k in -2..=2 {
                        for e in 0..l.motif.len() {
                            pts.push(l.piece(j, k, e));
                        }
                    }
                }
                for a in 0..pts.len() {
                    for b in a + 1..pts.len() {
                        assert!(sat_sep(&sh, pts[a], pts[b]) > -1e-9, "n={n}");
                    }
                }
            }
        }
    }
}
