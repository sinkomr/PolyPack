//! Balls as pieces and containers (centre plus radius) (packages/ndim/src/ball.ts). Lengths are in
//! the catalogue's units: a ball piece has diameter 1 (radius BALL_RADIUS); a ball container of
//! scale s has diameter s. The server's bundle keeps the three functions below.
use crate::linalg::dot;
use crate::polytope::Polytope;

/// packages/ndim/src/ball.ts: ballPairGap. Gap between two balls: the distance of the centres minus
/// the radii (negative: overlap depth).
pub fn ball_pair_gap(c1: &[f64], r1: f64, c2: &[f64], r2: f64, d: usize) -> f64 {
    let mut s = 0.0f64;
    for i in 0..d {
        let e = c1[i] - c2[i];
        s += e * e;
    }
    s.sqrt() - r1 - r2
}

/// packages/ndim/src/ball.ts: ballFacetGap. Gap between a ball (centre c, radius r) and facet f of
/// a polytope scaled by s: s b_f - N_f . c - r (negative: protrusion).
pub fn ball_facet_gap(c: &[f64], r: f64, p: &Polytope, f: usize, s: f64) -> f64 {
    s * p.b[f] - dot(&p.n, c, p.d, f * p.d, 0) - r
}

/// packages/ndim/src/ball.ts: ballInBallGap. Gap between a ball and the inside of a ball container
/// of radius R centred at the origin: R - |c| - r.
pub fn ball_in_ball_gap(c: &[f64], r: f64, big_r: f64, d: usize) -> f64 {
    big_r - dot(c, c, d, 0, 0).sqrt() - r
}
