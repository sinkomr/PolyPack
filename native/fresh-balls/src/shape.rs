//! The container of a balls problem, read from the problem definitions (polypack-balls), in the flat form the
//! search uses.
//!
//! Conventions (packages/balls, native/balls/src/{catalogue,container,validate}.rs) [EST, the definitions]:
//!  - balls have diameter 1 (radius R = 1/2);
//!  - a ball container of score s is the ball of DIAMETER s about the origin: a centre c is inside when
//!    |c| <= s/2 - R;
//!  - a solid container of score s is s times the canonical solid (centred at its vertex centroid, the origin),
//!    the intersection of the half-spaces N_f . x <= s b_f with unit outward normals N_f and offsets b_f > 0; a
//!    centre c is inside when N_f . c <= s b_f - R for every face (the cube is the case N = +-e_k, b = 1/2, which
//!    the validator writes as max |c_k| <= s/2 - R).
//!
//! The validator accepts gaps down to -1e-9; this search does not use that slack: every packing it reports has
//! its gaps non-negative up to the rounding of a few flops.

use crate::rng::Rng;

/// Radius of a ball piece.
pub const R: f64 = 0.5;

#[derive(Clone, Debug)]
pub struct Shape {
    /// True for a ball container; otherwise a polyhedron given by its faces.
    pub ball: bool,
    /// Number of faces (0 for the ball).
    pub nf: usize,
    /// Unit outward normals, flat [n0x, n0y, n0z, n1x, ...].
    pub n: Vec<f64>,
    /// Offsets of the canonical (s = 1) container: face f is N_f . x = b_f.
    pub b: Vec<f64>,
    pub bmin: f64,
    pub bmax: f64,
    /// Volume of the canonical container (pi / 6 for the ball of diameter 1).
    pub volume: f64,
    /// Bounding box of the canonical container.
    pub lo: [f64; 3],
    pub hi: [f64; 3],
    /// The container's name ("ball" or the solid's).
    pub name: String,
    /// For each face, the unit directions of its edges (in the face's plane): frames for aligned lattice starts.
    pub face_edges: Vec<Vec<[f64; 3]>>,
}

impl Shape {
    pub fn ball() -> Shape {
        Shape {
            ball: true,
            nf: 0,
            n: Vec::new(),
            b: Vec::new(),
            bmin: 0.5,
            bmax: 0.5,
            volume: std::f64::consts::PI / 6.0,
            lo: [-0.5; 3],
            hi: [0.5; 3],
            name: "ball".to_string(),
            face_edges: Vec::new(),
        }
    }

    /// The container of a problem's container name: "ball" or a solid of the polyhedra family.
    pub fn of_name(name: &str) -> Result<Shape, String> {
        if name == "ball" {
            return Ok(Shape::ball());
        }
        let c = polypack_balls::container_of(name)?;
        let n = c.n().to_vec();
        let b = c.b().to_vec();
        if b.iter().any(|&x| !(x > 0.0)) {
            return Err(format!("container {name}: the origin is not inside"));
        }
        let bmin = b.iter().cloned().fold(f64::INFINITY, f64::min);
        let bmax = b.iter().cloned().fold(0.0, f64::max);
        let solid = c.solid;
        let mut face_edges = Vec::with_capacity(b.len());
        for (f, face) in solid.faces.iter().enumerate().take(b.len()) {
            let nf = [n[3 * f], n[3 * f + 1], n[3 * f + 2]];
            let mut dirs = Vec::new();
            for k in 0..face.len() {
                let (i, j) = (face[k], face[(k + 1) % face.len()]);
                let mut d = [0.0; 3];
                for a in 0..3 {
                    d[a] = solid.v[3 * j + a] - solid.v[3 * i + a];
                }
                // in the face's plane (it is, up to rounding), unit length
                let dn = d[0] * nf[0] + d[1] * nf[1] + d[2] * nf[2];
                for a in 0..3 {
                    d[a] -= dn * nf[a];
                }
                let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                if len > 1e-9 {
                    dirs.push([d[0] / len, d[1] / len, d[2] / len]);
                }
            }
            face_edges.push(dirs);
        }
        Ok(Shape { ball: false, nf: b.len(), n, b, bmin, bmax, volume: c.volume, lo: c.lo, hi: c.hi, name: name.to_string(), face_edges })
    }

    /// The least size s at which a ball of radius R centred at c lies in s times the container.
    #[inline]
    pub fn size_for(&self, c: &[f64]) -> f64 {
        if self.ball {
            2.0 * ((c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt() + R)
        } else {
            let mut s = 0.0f64;
            for f in 0..self.nf {
                let n = &self.n[3 * f..3 * f + 3];
                let v = (n[0] * c[0] + n[1] * c[1] + n[2] * c[2] + R) / self.b[f];
                if v > s {
                    s = v;
                }
            }
            s
        }
    }

    /// The largest factor l <= 1 such that the centre l c lies in size s of the container (the centres' region
    /// is convex and holds the origin when s exceeds the least size).
    pub fn scale_into(&self, s: f64, c: &[f64]) -> f64 {
        let mut l = 1.0f64;
        if self.ball {
            let r = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
            if r > 0.0 {
                l = l.min((0.5 * s - R) / r);
            }
        } else {
            for f in 0..self.nf {
                let n = &self.n[3 * f..3 * f + 3];
                let d = n[0] * c[0] + n[1] * c[1] + n[2] * c[2];
                if d > 0.0 {
                    l = l.min((s * self.b[f] - R) / d);
                }
            }
        }
        l.max(0.0)
    }

    /// The gap of a ball centred at c to the boundary of s times the container (negative: it sticks out), written
    /// as the validator writes it.
    #[inline]
    pub fn gap(&self, s: f64, c: &[f64]) -> f64 {
        if self.ball {
            s * 0.5 - R - (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt()
        } else {
            let mut g = f64::INFINITY;
            for f in 0..self.nf {
                let n = &self.n[3 * f..3 * f + 3];
                let v = s * self.b[f] - R - (n[0] * c[0] + n[1] * c[1] + n[2] * c[2]);
                if v < g {
                    g = v;
                }
            }
            g
        }
    }

    /// A uniformly random centre that lies in s times the container shrunk by R + margin (rejection from the
    /// bounding box). Falls back to the origin after many misses (a container too small for the margin).
    pub fn random_inside(&self, s: f64, margin: f64, rng: &mut Rng, out: &mut [f64]) {
        for _ in 0..10_000 {
            let c = [
                rng.range(s * self.lo[0], s * self.hi[0]),
                rng.range(s * self.lo[1], s * self.hi[1]),
                rng.range(s * self.lo[2], s * self.hi[2]),
            ];
            if self.gap(s, &c) >= margin {
                out[..3].copy_from_slice(&c);
                return;
            }
        }
        out[..3].copy_from_slice(&[0.0; 3]);
    }

    /// The size estimate a packing of P balls at density phi needs: volume P (pi / 6) / phi.
    pub fn size_at_density(&self, p: usize, phi: f64) -> f64 {
        (p as f64 * std::f64::consts::PI / 6.0 / (phi * self.volume)).cbrt()
    }
}
