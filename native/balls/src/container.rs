//! The container of a balls problem, as the validator reads it. Port of what the server reaches of
//! `packages/balls/src/container.ts`.
//!
//!  - "ball": the ball of DIAMETER s about the origin (radius s / 2, catalogue.rs ball_container_radius);
//!  - "cube": the cube [-s/2, s/2]^3 (an axis-aligned special case with its own, simpler code, kept as it was
//!    before the other solids were containers);
//!  - "polyhedron": s times a canonical solid of the polyhedra family (centred at its vertex centroid, which is
//!    the origin), the intersection of the half-spaces N_f . x <= s b_f, N_f the unit outward normal of face f
//!    and b_f its offset. The cube is one too: the same formulas hold for it.
//!
//! A ball piece of radius r lies in the closed container s C exactly when its centre c satisfies, for every face,
//!   N_f . c <= s b_f - r
//! [EST, elementary: the ball lies in the half-space N_f . x <= s b_f iff its centre is at least r inside the
//! plane; a convex polyhedron is the intersection of its face half-spaces]. So the centres lie in a polyhedron
//! with the same face normals and offsets s b_f - r, the container "shrunk inward by r"; for the tangential
//! solids (all b_f equal to the inradius rho) it is the container itself scaled to s - r / rho.
//!
//! For the first 94 solids the vertex centroid is the centre of the largest inscribed ball and of the smallest
//! enclosing ball; for the 92 Johnson solids it mostly is not, and the bounds read those two radii from
//! extent.rs (`chebyshev` and `enclosing` below).

use crate::catalogue::BallsProblem;
use crate::extent::{chebyshev_radius, enclosing_radius};
use polypack_js::math;
use polypack_polyhedra::{get_solid, Solid};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

/// `container.ts: ContainerKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContainerKind {
    Ball,
    Cube,
    Polyhedron,
}

/// `container.ts: containerKind`.
pub fn container_kind(problem: &BallsProblem) -> ContainerKind {
    if problem.container == "ball" {
        ContainerKind::Ball
    } else if problem.container == "cube" {
        ContainerKind::Cube
    } else {
        ContainerKind::Polyhedron
    }
}

/// `container.ts: Container`. The source's `N` and `b` are the solid's `n` and `offsets`.
#[derive(Clone, Debug)]
pub struct Container {
    pub solid: &'static Solid,
    /// Number of faces of the canonical solid.
    pub f: usize,
    /// Least offset: the radius of the largest ball about the origin in the canonical solid.
    pub inradius: f64,
    /// The radius of the largest ball anywhere in the canonical solid (extent.rs): the inradius for the first 94
    /// solids, more for a Johnson solid whose centroid is not the centre of its largest inscribed ball. The lower
    /// bounds use this.
    pub chebyshev: f64,
    /// Largest vertex distance from the origin.
    pub circumradius: f64,
    /// The radius of the smallest ball holding the canonical solid anywhere (extent.rs): the circumradius for the
    /// first 94 solids.
    pub enclosing: f64,
    /// Largest distance of two vertices (the canonical solid's diameter).
    pub diameter: f64,
    pub volume: f64,
    /// True when every offset equals the inradius.
    pub tangential: bool,
    /// Bounding box of the canonical solid.
    pub lo: [f64; 3],
    pub hi: [f64; 3],
}

impl Container {
    /// The unit outward normals (flat): the source's `N`.
    pub fn n(&self) -> &[f64] {
        &self.solid.n
    }
    /// The offsets of the canonical solid: the source's `b`.
    pub fn b(&self) -> &[f64] {
        &self.solid.offsets
    }
}

static CACHE: LazyLock<Mutex<HashMap<String, Arc<Container>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// `container.ts: containerOf`: the geometry of a solid as a container (cached); any solid, the cube included.
/// `Err` (the source throws) for a name that is not a solid.
pub fn container_of(name: &str) -> Result<Arc<Container>, String> {
    if let Some(c) = CACHE.lock().unwrap().get(name) {
        return Ok(c.clone());
    }
    let solid = get_solid(name)?;
    let mut diameter = 0.0f64;
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for i in 0..solid.nv {
        for d in 0..3 {
            lo[d] = math::min(lo[d], solid.v[3 * i + d]);
            hi[d] = math::max(hi[d], solid.v[3 * i + d]);
        }
        for j in i + 1..solid.nv {
            diameter = math::max(
                diameter,
                math::hypot3(
                    solid.v[3 * i] - solid.v[3 * j],
                    solid.v[3 * i + 1] - solid.v[3 * j + 1],
                    solid.v[3 * i + 2] - solid.v[3 * j + 2],
                ),
            );
        }
    }
    let c = Arc::new(Container {
        solid,
        f: solid.offsets.len(),
        inradius: solid.inradius,
        chebyshev: chebyshev_radius(solid)?,
        circumradius: solid.circumradius,
        enclosing: enclosing_radius(solid),
        diameter,
        volume: solid.volume,
        tangential: solid.tangential,
        lo,
        hi,
    });
    CACHE.lock().unwrap().insert(name.to_string(), c.clone());
    Ok(c)
}

/// `container.ts: containerOfProblem`: the geometry of a problem's container; None for a ball container.
pub fn container_of_problem(problem: &BallsProblem) -> Result<Option<Arc<Container>>, String> {
    if problem.container == "ball" {
        Ok(None)
    } else {
        container_of(&problem.container).map(Some)
    }
}

/// `container.ts: wallGap`: the gap of a ball of radius r centred at (x, y, z) to the nearest face of s times
/// the container: the least over faces of s b_f - r - N_f . c (negative: the ball sticks out). This one
/// expression is the validator's, the kernel's and the search's, so that all of them round alike.
pub fn wall_gap(c: &Container, s: f64, r: f64, x: f64, y: f64, z: f64) -> f64 {
    let mut gap = f64::INFINITY;
    let n = c.n();
    let b = c.b();
    for f in 0..c.f {
        let g = s * b[f] - r - (n[3 * f] * x + n[3 * f + 1] * y + n[3 * f + 2] * z);
        if g < gap {
            gap = g;
        }
    }
    gap
}
