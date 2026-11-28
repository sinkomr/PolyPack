//! Constructive starts: every piece at the points of one lattice Gamma that contains the torus lattice Lambda
//! with index P (so P points per cell), all at one angle, the cell scaled until no two pieces overlap.
//!
//! For sq and hex Lambda is the family's cell and Gamma runs over the superlattices of index P, which are
//! B0 H^{-1} Z^2 for the Hermite normal forms H = [[a, b], [0, d]], ad = P, 0 <= b < d. Two pieces at the same
//! angle a lattice vector g apart are disjoint exactly when g is at least the pair's touching distance in its
//! direction, which is the least over the separating axes n with n.g > 0 of w(n) / n.g times |g| (w the width
//! of the pair along n; `Shape::pair_scale`). So the least scale is the largest of these over the short vectors
//! of Gamma, minimised over the angle (a grid, then a golden-section refinement). Only vectors no longer than
//! R/r times the shortest can bind, which keeps this cheap for many sides.
//!
//! For free, Lambda can be any sublattice of index P of a lattice packing Gamma: Gamma is the better of the
//! square and hexagonal lattice packings at their best angles, and Lambda = Gamma H for the H whose reduced
//! basis is roundest (the search then has room in every direction).

use crate::geom::{gauss_reduce, mul, Family, Shape, Sol};
use crate::rng::Rng;
use std::f64::consts::PI;

/// One constructive packing: the scale of the unit-score cell and the data to place the pieces.
#[derive(Clone, Debug)]
pub struct Arrangement {
    /// Score of the torus.
    pub s: f64,
    pub sol: Sol,
}

/// Short vectors of the lattice with (reduced) basis g, one of each +-pair, no longer than `lim` times the
/// shortest.
fn short_vectors(g: &[f64; 4], lim: f64, out: &mut Vec<[f64; 2]>) {
    out.clear();
    let (r, _) = gauss_reduce(g);
    let mut vs: Vec<[f64; 2]> = Vec::new();
    let mut min2 = f64::INFINITY;
    for i in 0..=2i32 {
        for j in -2..=2i32 {
            if i == 0 && j <= 0 {
                continue;
            }
            let v = [i as f64 * r[0] + j as f64 * r[2], i as f64 * r[1] + j as f64 * r[3]];
            let l2 = v[0] * v[0] + v[1] * v[1];
            min2 = min2.min(l2);
            vs.push(v);
        }
    }
    let cap = min2 * lim * lim * (1.0 + 1e-9);
    for v in vs {
        if v[0] * v[0] + v[1] * v[1] <= cap {
            out.push(v);
        }
    }
}

/// The least scale at which pieces at angle theta on the points of the lattice with short vectors `vs` do not
/// overlap.
fn need(sh: &Shape, theta: f64, vs: &[[f64; 2]]) -> f64 {
    let mut l = 0.0f64;
    for v in vs {
        l = l.max(sh.pair_scale(theta, theta, *v, 0.0));
    }
    l
}

/// Best angle for the lattice: a grid over one period of the piece, then golden-section refinement.
fn best_angle(sh: &Shape, vs: &[[f64; 2]], grid: usize) -> (f64, f64) {
    if sh.n == 0 {
        return (0.0, need(sh, 0.0, vs));
    }
    let per = sh.step;
    let mut best = (0.0, f64::INFINITY);
    for k in 0..grid {
        let t = per * k as f64 / grid as f64;
        let l = need(sh, t, vs);
        if l < best.1 {
            best = (t, l);
        }
    }
    let h = per / grid as f64;
    let (mut a, mut b) = (best.0 - h, best.0 + h);
    let gr = 0.5 * (5f64.sqrt() - 1.0);
    let mut c = b - gr * (b - a);
    let mut d = a + gr * (b - a);
    let mut fc = need(sh, c, vs);
    let mut fd = need(sh, d, vs);
    for _ in 0..40 {
        if fc < fd {
            b = d;
            d = c;
            fd = fc;
            c = b - gr * (b - a);
            fc = need(sh, c, vs);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + gr * (b - a);
            fd = need(sh, d, vs);
        }
    }
    for (t, l) in [(c, fc), (d, fd)] {
        if l < best.1 {
            best = (t, l);
        }
    }
    best
}

fn divisors(p: usize) -> Vec<usize> {
    (1..=p).filter(|a| p % a == 0).collect()
}

/// The unit-score cell of the family (free: the square one).
fn unit_cell(fam: Family) -> [f64; 4] {
    fam.basis(1.0)
}

/// The best superlattice arrangements of the family's cell (sq, hex), best first, at most `keep`. With an rng,
/// the angle grid and the choice among near-best forms are randomised (for varied restarts).
pub fn superlattice(sh: &Shape, fam: Family, p: usize, keep: usize, rng: Option<&mut Rng>) -> Vec<Arrangement> {
    let b0 = unit_cell(fam);
    let ratio = if sh.n == 0 { 1.0 } else { sh.big_r / sh.apo };
    let grid = if sh.n == 0 { 1 } else if sh.n <= 12 { 48 } else { 16 };
    // all Hermite normal forms, with Gamma's shortest vector
    let mut forms: Vec<(f64, usize, usize, usize, [f64; 4])> = Vec::new();
    let mut vs = Vec::new();
    for a in divisors(p) {
        let d = p / a;
        for b in 0..d {
            // Gamma = B0 H^{-1}: columns B0 (1/a, 0) and B0 (-b/(ad), 1/d)
            let g1 = mul(&b0, [1.0 / a as f64, 0.0]);
            let g2 = mul(&b0, [-(b as f64) / p as f64, 1.0 / d as f64]);
            let g = [g1[0], g1[1], g2[0], g2[1]];
            short_vectors(&g, 1.0, &mut vs);
            let m = vs.iter().map(|v| (v[0] * v[0] + v[1] * v[1]).sqrt()).fold(f64::INFINITY, f64::min);
            forms.push((m, a, b, d, g));
        }
    }
    forms.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap());
    let mut found: Vec<(f64, f64, usize)> = Vec::new(); // (scale, angle, form index)
    let mut best_l = f64::INFINITY;
    let mut rng = rng;
    let jitter = rng.as_mut().map(|r| r.uniform()).unwrap_or(0.0);
    for (fi, f) in forms.iter().enumerate() {
        // the width of a piece is at least 2r: no scale below 2r / |shortest| can work
        if 2.0 * sh.apo / f.0 > best_l * (1.0 + 0.05) && found.len() >= keep {
            break;
        }
        short_vectors(&f.4, ratio, &mut vs);
        let (mut t, mut l) = best_angle(sh, &vs, grid);
        if jitter > 0.0 && sh.n > 0 {
            // a randomised second look: the angle grid shifted
            let t2 = t + (jitter - 0.5) * sh.step / grid as f64;
            let l2 = need(sh, t2, &vs);
            if l2 < l {
                t = t2;
                l = l2;
            }
        }
        if l < best_l {
            best_l = l;
        }
        found.push((l, t, fi));
    }
    found.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
    found.truncate(keep.max(1));
    let mut out = Vec::new();
    for &(l, t, fi) in &found {
        let (_, a, b, d, _) = forms[fi];
        let mut sol = Sol::new(p);
        let s = l * (1.0 + 1e-12);
        sol.s = s;
        sol.b = fam.basis(s);
        let mut k = 0;
        for m1 in 0..a {
            for m2 in 0..d {
                // B0 H^{-1} (m1, m2) scaled
                let f = [m1 as f64 / a as f64 - (b * m2) as f64 / p as f64, m2 as f64 / d as f64];
                let c = mul(&sol.b, f);
                sol.pos[2 * k] = c[0];
                sol.pos[2 * k + 1] = c[1];
                sol.ang[k] = t;
                k += 1;
            }
        }
        out.push(Arrangement { s, sol });
    }
    out
}

/// A lattice packing Gamma (all P pieces on one lattice, one angle) on a free torus Lambda = Gamma H: Gamma the
/// better of the square and hexagonal lattices at their best angles, H the form of index P whose reduced
/// Lambda is roundest. The solver's frame: b1 along +x, det = s^2.
pub fn free_lattice(sh: &Shape, p: usize, rng: Option<&mut Rng>) -> Arrangement {
    let ratio = if sh.n == 0 { 1.0 } else { sh.big_r / sh.apo };
    let grid = if sh.n == 0 { 1 } else if sh.n <= 12 { 64 } else { 24 };
    let mut vs = Vec::new();
    let mut best: Option<([f64; 4], f64, f64)> = None; // (Gamma scaled, angle, area)
    let mut rng = rng;
    for fam in [Family::Sq, Family::Hex] {
        let g = unit_cell(fam);
        short_vectors(&g, ratio, &mut vs);
        let (mut t, mut l) = best_angle(sh, &vs, grid);
        if let Some(r) = rng.as_mut() {
            let t2 = t + (r.uniform() - 0.5) * sh.step / grid as f64;
            let l2 = need(sh, t2, &vs);
            if l2 < l {
                t = t2;
                l = l2;
            }
        }
        let gs = [g[0] * l, g[1] * l, g[2] * l, g[3] * l];
        let area = (gs[0] * gs[3] - gs[1] * gs[2]).abs();
        if best.as_ref().is_none_or(|b| area < b.2) {
            best = Some((gs, t, area));
        }
    }
    let (g, t, _) = best.unwrap();
    // the roundest sublattice of index p
    let mut pick = (f64::NEG_INFINITY, 1usize, 0usize, p);
    for a in divisors(p) {
        let d = p / a;
        for b in 0..d {
            // Lambda = Gamma H: columns a g1, b g1 + d g2
            let l1 = [a as f64 * g[0], a as f64 * g[1]];
            let l2 = [b as f64 * g[0] + d as f64 * g[2], b as f64 * g[1] + d as f64 * g[3]];
            let (r, _) = gauss_reduce(&[l1[0], l1[1], l2[0], l2[1]]);
            let m = (r[0] * r[0] + r[1] * r[1]).sqrt();
            if m > pick.0 * (1.0 + 1e-12) {
                pick = (m, a, b, d);
            }
        }
    }
    let (_, a, b, d) = pick;
    let l1 = [a as f64 * g[0], a as f64 * g[1]];
    let l2 = [b as f64 * g[0] + d as f64 * g[2], b as f64 * g[1] + d as f64 * g[3]];
    let (lam, _) = gauss_reduce(&[l1[0], l1[1], l2[0], l2[1]]);
    let mut sol = Sol::new(p);
    // the points of Gamma in one cell of Lambda: m1 g1 + m2 g2, 0 <= m1 < a, 0 <= m2 < d (cosets of H Z^2)
    let mut k = 0;
    for m1 in 0..a {
        for m2 in 0..d {
            sol.pos[2 * k] = m1 as f64 * g[0] + m2 as f64 * g[2];
            sol.pos[2 * k + 1] = m1 as f64 * g[1] + m2 as f64 * g[3];
            sol.ang[k] = t;
            k += 1;
        }
    }
    // turn so that b1 lies along +x
    let al = lam[1].atan2(lam[0]);
    sol.b = lam;
    sol.s = (lam[0] * lam[3] - lam[1] * lam[2]).abs().sqrt();
    crate::geom::rotate(&mut sol, -al);
    sol.b[0] = (sol.b[0] * sol.b[0] + sol.b[1] * sol.b[1]).sqrt();
    sol.b[1] = 0.0;
    sol.b[3] = sol.s * sol.s / sol.b[0];
    // a hair of room against rounding
    sol.scale(1.0 + 1e-12);
    Arrangement { s: sol.s, sol }
}

/// The Hermite normal forms of index q, roundest first: (shortest vector of B0 H^{-1}, a, b, d).
fn forms_by_roundness(b0: &[f64; 4], q: usize) -> Vec<(f64, usize, usize, usize)> {
    let mut out = Vec::new();
    for a in divisors(q) {
        let d = q / a;
        for b in 0..d {
            let g1 = mul(b0, [1.0 / a as f64, 0.0]);
            let g2 = mul(b0, [-(b as f64) / q as f64, 1.0 / d as f64]);
            let (r, _) = gauss_reduce(&[g1[0], g1[1], g2[0], g2[1]]);
            out.push(((r[0] * r[0] + r[1] * r[1]).sqrt(), a, b, d));
        }
    }
    out.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap());
    out
}

/// A double lattice: pairs of pieces, one at angle theta on the points of a lattice Gamma with q = P/2 points
/// per cell and one at theta + pi on Gamma + delta (delta near the middle of Gamma's cell), as odd-N polygons
/// pack densely (triangles tile this way). sq and hex: Gamma one of the roundest superlattices of index q of the
/// cell; free: Gamma square or hexagonal, the torus its roundest sublattice of index q. Scaled to first
/// contact (`scale_to_contact`); the angle is random, so the caller relaxes and polishes it. P must be even.
pub fn double_lattice(sh: &Shape, fam: Family, p: usize, rng: &mut Rng) -> Option<Sol> {
    if p < 2 || p % 2 != 0 {
        return None;
    }
    let q = p / 2;
    let theta = if sh.n > 0 { rng.uniform() * sh.step } else { 0.0 };
    let jit = [0.5 + 0.2 * rng.signed(), 0.5 + 0.2 * rng.signed()];
    let mut sol = Sol::new(p);
    let mut k = 0;
    if fam != Family::Free {
        let b0 = unit_cell(fam);
        let forms = forms_by_roundness(&b0, q);
        let (_, a, b, d) = forms[rng.below(forms.len().min(3))];
        sol.s = 1.0;
        sol.b = b0;
        let g1 = mul(&b0, [1.0 / a as f64, 0.0]);
        let g2 = mul(&b0, [-(b as f64) / q as f64, 1.0 / d as f64]);
        let delta = [jit[0] * g1[0] + jit[1] * g2[0], jit[0] * g1[1] + jit[1] * g2[1]];
        for m1 in 0..a {
            for m2 in 0..d {
                let c = [m1 as f64 * g1[0] + m2 as f64 * g2[0], m1 as f64 * g1[1] + m2 as f64 * g2[1]];
                sol.pos[2 * k] = c[0];
                sol.pos[2 * k + 1] = c[1];
                sol.ang[k] = theta;
                sol.pos[2 * k + 2] = c[0] + delta[0];
                sol.pos[2 * k + 3] = c[1] + delta[1];
                sol.ang[k + 1] = theta + PI;
                k += 2;
            }
        }
    } else {
        let g = unit_cell(if rng.chance(0.5) { Family::Hex } else { Family::Sq });
        let mut pick = (f64::NEG_INFINITY, 1usize, 0usize, q);
        let mut ties = 0.0;
        for a in divisors(q) {
            let d = q / a;
            for b in 0..d {
                let l1 = [a as f64 * g[0], a as f64 * g[1]];
                let l2 = [b as f64 * g[0] + d as f64 * g[2], b as f64 * g[1] + d as f64 * g[3]];
                let (r, _) = gauss_reduce(&[l1[0], l1[1], l2[0], l2[1]]);
                let m = (r[0] * r[0] + r[1] * r[1]).sqrt();
                if m > pick.0 * (1.0 + 1e-9) {
                    pick = (m, a, b, d);
                    ties = 1.0;
                } else if m > pick.0 * (1.0 - 1e-9) {
                    ties += 1.0;
                    if rng.uniform() * ties < 1.0 {
                        pick = (m, a, b, d);
                    }
                }
            }
        }
        let (_, a, b, d) = pick;
        let l1 = [a as f64 * g[0], a as f64 * g[1]];
        let l2 = [b as f64 * g[0] + d as f64 * g[2], b as f64 * g[1] + d as f64 * g[3]];
        let (lam, _) = gauss_reduce(&[l1[0], l1[1], l2[0], l2[1]]);
        let delta = [jit[0] * g[0] + jit[1] * g[2], jit[0] * g[1] + jit[1] * g[3]];
        for m1 in 0..a {
            for m2 in 0..d {
                let c = [m1 as f64 * g[0] + m2 as f64 * g[2], m1 as f64 * g[1] + m2 as f64 * g[3]];
                sol.pos[2 * k] = c[0];
                sol.pos[2 * k + 1] = c[1];
                sol.ang[k] = theta;
                sol.pos[2 * k + 2] = c[0] + delta[0];
                sol.pos[2 * k + 3] = c[1] + delta[1];
                sol.ang[k + 1] = theta + PI;
                k += 2;
            }
        }
        sol.b = lam;
        sol.s = (lam[0] * lam[3] - lam[1] * lam[2]).abs().sqrt();
        let al = lam[1].atan2(lam[0]);
        crate::geom::rotate(&mut sol, -al);
        sol.b[0] = (sol.b[0] * sol.b[0] + sol.b[1] * sol.b[1]).sqrt();
        sol.b[1] = 0.0;
        sol.b[3] = sol.s * sol.s / sol.b[0];
    }
    if !crate::geom::scale_to_contact(sh, &mut sol) {
        return None;
    }
    Some(sol)
}

/// Drops piece k of a packing (a vacancy: an arrangement of P + 1 pieces is a packing of P).
pub fn without(sol: &Sol, k: usize) -> Sol {
    let p = sol.p();
    let mut out = Sol::new(p - 1);
    out.s = sol.s;
    out.b = sol.b;
    let mut t = 0;
    for i in 0..p {
        if i != k {
            out.pos[2 * t] = sol.pos[2 * i];
            out.pos[2 * t + 1] = sol.pos[2 * i + 1];
            out.ang[t] = sol.ang[i];
            t += 1;
        }
    }
    out
}

/// Places pieces in a cell of score s at random (centres uniform in the cell, angles uniform), the frame of the
/// family (free: the given basis shape scaled).
pub fn random_sol(fam: Family, sh: &Shape, p: usize, s: f64, shape_of: Option<&[f64; 4]>, rng: &mut Rng) -> Sol {
    let mut sol = Sol::new(p);
    sol.s = s;
    sol.b = match (fam, shape_of) {
        (Family::Free, Some(b)) => {
            let f = s / (b[0] * b[3] - b[1] * b[2]).abs().sqrt();
            [b[0] * f, 0.0, b[2] * f, s * s / (b[0] * f)]
        }
        _ => fam.basis(s),
    };
    for i in 0..p {
        let c = mul(&sol.b, [rng.uniform(), rng.uniform()]);
        sol.pos[2 * i] = c[0];
        sol.pos[2 * i + 1] = c[1];
        sol.ang[i] = if sh.n > 0 { rng.uniform() * 2.0 * PI } else { 0.0 };
    }
    sol
}
