//! Periodic arrangements of a piece for starts (internal units, bounding radius 1): rows of pieces with one
//! orientation, or rows alternating two orientations half a period apart (for odd N, vertex up and vertex
//! down), every spacing found by bisection on the exact separation. Triangles, squares and hexagons come out
//! as their tilings, disks hexagonal.

use crate::geom::Piece;
use std::f64::consts::PI;

/// A periodic arrangement: lattice vectors a1 = (t, 0) and a2 = (bx, by), and its motif.
#[derive(Clone, Debug)]
pub struct Lattice {
    pub t: f64,
    pub a2: [f64; 2],
    pub motif: Vec<[f64; 3]>,
    /// Share of the plane covered.
    pub density: f64,
}

/// The least spacing t > 0 with the pieces at (0, 0, th) and (t, 0, th) apart.
fn row_spacing(pc: &Piece, th: f64) -> f64 {
    let (mut lo, mut hi) = (0.0, 2.0 + 1e-9);
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        if pc.separation(1.0, [0.0, 0.0, th], [mid, 0.0, th]) >= 0.0 {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    hi
}

/// The least height oy at which a row of pieces at angle `tb`, offset ox, spacing t, clears the row of
/// pieces at angle `ta` on the x axis (scanning down from clear, then bisection); None when it clears at 0.
fn row_height(pc: &Piece, t: f64, ta: f64, tb: f64, ox: f64) -> Option<f64> {
    let clear = |oy: f64| -> bool {
        for m in -3i32..=3 {
            let x = ox + m as f64 * t;
            if x.abs() > 2.0 + 1e-9 {
                continue;
            }
            if pc.separation(1.0, [0.0, 0.0, ta], [x, oy, tb]) < 0.0 {
                return false;
            }
        }
        true
    };
    let mut hi: f64 = 2.0 + 1e-9;
    let mut lo = f64::NAN;
    let mut y = hi;
    while y > 0.0 {
        y -= 0.04;
        let yy = y.max(0.0);
        if !clear(yy) {
            lo = yy;
            break;
        }
        hi = yy;
    }
    if lo.is_nan() {
        return None;
    }
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        if clear(mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    Some(hi)
}

/// True when no two pieces of a patch of the arrangement overlap.
fn valid(pc: &Piece, lat: &Lattice) -> bool {
    let mut pts: Vec<[f64; 3]> = Vec::new();
    for j in -2i32..=2 {
        for i in -3i32..=3 {
            for m in &lat.motif {
                pts.push([m[0] + i as f64 * lat.t + j as f64 * lat.a2[0], m[1] + j as f64 * lat.a2[1], m[2]]);
            }
        }
    }
    for a in 0..pts.len() {
        for b in a + 1..pts.len() {
            let dx = pts[b][0] - pts[a][0];
            let dy = pts[b][1] - pts[a][1];
            if dx * dx + dy * dy < 4.0 && pc.separation(1.0, pts[a], pts[b]) < -1e-9 {
                return false;
            }
        }
    }
    true
}

/// The densest arrangements found, densest first (at most 4).
pub fn lattices(pc: &Piece) -> Vec<Lattice> {
    if pc.n == 0 {
        return vec![Lattice { t: 2.0, a2: [1.0, 3f64.sqrt()], motif: vec![[0.0, 0.0, 0.0]], density: PI / (2.0 * 3f64.sqrt()) }];
    }
    let period = pc.period;
    let mut out: Vec<Lattice> = Vec::new();
    // many-sided pieces are nearly disks: a few turns suffice
    let na = if pc.n > 12 { 2 } else { 8 };
    let nox = 16;
    for ia in 0..na {
        let ta = period * ia as f64 / na as f64;
        // one orientation
        let t = row_spacing(pc, ta);
        let mut best: Option<Lattice> = None;
        for io in 0..nox {
            let ox = t * io as f64 / nox as f64;
            if let Some(oy) = row_height(pc, t, ta, ta, ox) {
                let d = pc.area / (t * oy);
                if best.as_ref().is_none_or(|b| d > b.density) {
                    best = Some(Lattice { t, a2: [ox, oy], motif: vec![[0.0, 0.0, ta]], density: d });
                }
            }
        }
        if let Some(b) = best {
            out.push(b);
        }
        // two orientations half a period apart, in alternate rows
        let tb = ta + 0.5 * period;
        let t2 = t.max(row_spacing(pc, tb));
        let mut best: Option<Lattice> = None;
        for io in 0..nox {
            let ox1 = t2 * io as f64 / nox as f64;
            let Some(oy1) = row_height(pc, t2, ta, tb, ox1) else { continue };
            for ox2 in [ox1, -ox1, 0.0, 0.5 * t2] {
                let Some(oy2) = row_height(pc, t2, tb, ta, ox2) else { continue };
                let d = 2.0 * pc.area / (t2 * (oy1 + oy2));
                if best.as_ref().is_none_or(|b| d > b.density) {
                    best = Some(Lattice { t: t2, a2: [ox1 + ox2, oy1 + oy2], motif: vec![[0.0, 0.0, ta], [ox1, oy1, tb]], density: d });
                }
            }
        }
        if let Some(b) = best {
            out.push(b);
        }
    }
    out.retain(|l| l.density.is_finite() && l.density <= 1.0 + 1e-9 && valid(pc, l));
    out.sort_by(|a, b| b.density.total_cmp(&a.density));
    // keep distinct densities
    let mut kept: Vec<Lattice> = Vec::new();
    for l in out {
        if kept.iter().all(|k| (k.density - l.density).abs() > 1e-6) {
            kept.push(l);
        }
        if kept.len() >= 4 {
            break;
        }
    }
    kept
}
