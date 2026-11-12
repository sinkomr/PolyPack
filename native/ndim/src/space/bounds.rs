//! Lower bounds on the score (the container scale s) of an nD problem, from the polytopes' facts
//! alone (no coordinates) (packages/ndspace/src/bounds.ts):
//!  - volume: P vol(piece) <= s^d vol(container);
//!  - inradius: the piece contains a ball of its inradius, which must fit in the container (a ball
//!    in a convex body has radius at most the body's inradius): s r_in(C) >= r_in(piece), for a
//!    ball container r_in = s/2;
//!  - circumradius, in a ball container: a regular polytope's smallest enclosing ball is its
//!    circumscribed ball (vertex-transitive, so the circumcentre is the centroid [EST]), so
//!    s/2 >= R(piece).
use super::catalogue::{nd_code, ND_BALL};
use crate::info::info_of;
use crate::Thrown;
use polypack_js::math;

const BALL_RADIUS: f64 = 0.5;

/// packages/ndspace/src/bounds.ts: ndBallVolume. Volume of the d-ball of radius r
/// (V_d = 2 pi / d V_(d-2)).
pub fn nd_ball_volume(d: u32, r: f64) -> f64 {
    let mut v: f64 = if d % 2 == 0 { 1.0 } else { 2.0 };
    let mut k = if d % 2 == 0 { 2 } else { 3 };
    while k <= d {
        v *= (2.0 * std::f64::consts::PI) / k as f64;
        k += 2;
    }
    v * math::pow(r, d as f64)
}

/// The volume and radii of a shape at scale 1 (the function `facts` of the source).
struct Facts {
    volume: f64,
    inradius: f64,
    circumradius: f64,
}

fn facts(d: u32, shape: &str) -> Result<Facts, Thrown> {
    if shape == ND_BALL {
        return Ok(Facts { volume: nd_ball_volume(d, BALL_RADIUS), inradius: BALL_RADIUS, circumradius: BALL_RADIUS });
    }
    match info_of(&nd_code(d, shape)) {
        Some(info) => Ok(Facts { volume: info.volume, inradius: info.inradius, circumradius: info.circumradius }),
        None => Err(Thrown(format!("unknown shape {shape} in {d}D"))),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NdBoundKind {
    Volume,
    Inradius,
    Circumradius,
}
impl NdBoundKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NdBoundKind::Volume => "volume",
            NdBoundKind::Inradius => "inradius",
            NdBoundKind::Circumradius => "circumradius",
        }
    }
}

/// packages/ndspace/src/bounds.ts: NdBound.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NdBound {
    pub value: f64,
    pub kind: NdBoundKind,
}

/// packages/ndspace/src/bounds.ts: ndLowerBound. The best lower bound on s of the problem with P
/// pieces, and the kind that gives it. An error (the source throws) for a shape that the dimension
/// does not have.
pub fn nd_lower_bound(d: u32, piece: &str, container: &str, p: u32) -> Result<NdBound, Thrown> {
    let a = facts(d, piece)?;
    let c = facts(d, container)?;
    let mut candidates = vec![
        NdBound { value: math::pow((p as f64 * a.volume) / c.volume, 1.0 / d as f64), kind: NdBoundKind::Volume },
        NdBound { value: a.inradius / c.inradius, kind: NdBoundKind::Inradius },
    ];
    // a ball container of diameter s holds the piece's circumscribed ball: s >= 2 R
    if container == ND_BALL {
        candidates.push(NdBound { value: 2.0 * a.circumradius, kind: NdBoundKind::Circumradius });
    }
    // `candidates.reduce((best, x) => (x.value > best.value ? x : best))`
    let mut best = candidates[0];
    for &x in &candidates[1..] {
        if x.value > best.value {
            best = x;
        }
    }
    Ok(best)
}

/// What the spaces list as a problem's bound.
#[derive(Debug, Clone, PartialEq)]
pub struct NdBoundEntry {
    pub value: f64,
    pub label: String,
}

/// packages/ndspace/src/bounds.ts: ndBoundEntry. The bound as the spaces list it: slightly lowered,
/// since the volumes are floats (about 1e-14 relative).
pub fn nd_bound_entry(d: u32, piece: &str, container: &str, p: u32) -> Result<NdBoundEntry, Thrown> {
    let b = nd_lower_bound(d, piece, container, p)?;
    Ok(NdBoundEntry { value: b.value * (1.0 - 1e-12), label: format!("{} bound; [CALC]", b.kind.as_str()) })
}
