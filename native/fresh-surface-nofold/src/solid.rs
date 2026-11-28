//! The problem `surface/<solid>/nofold/<N>/<P>` as a set of face problems: the solid's faces grouped into
//! classes of congruent faces (all regular M-gons of one M are the same polygon in their frames; congruent
//! irregular faces, as on the Catalan solids, are matched up to a rotation or a reflection), with the rigid
//! map from each class's representative frame to every face's frame, and the lower bounds of each face
//! problem.
//!
//! From `polypack-surface` this reads only the definitions: the solid's face polygons in their frames
//! (`unit_faces`, at scale 1) and which faces are regular.

use crate::geom::{Container, Piece};
use polypack_surface::{get_solid, is_solid_name, Solid};
use std::f64::consts::PI;

/// A rigid map of the plane: p -> R (M p) + t, M the reflection y -> -y when `mirror`, R the rotation by `rot`.
#[derive(Clone, Copy, Debug)]
pub struct Transform {
    pub rot: f64,
    pub mirror: bool,
    pub tx: f64,
    pub ty: f64,
}

impl Transform {
    pub fn identity() -> Transform {
        Transform { rot: 0.0, mirror: false, tx: 0.0, ty: 0.0 }
    }

    pub fn is_identity(&self) -> bool {
        self.rot == 0.0 && !self.mirror && self.tx == 0.0 && self.ty == 0.0
    }

    /// The image of a point.
    pub fn point(&self, x: f64, y: f64) -> (f64, f64) {
        let y = if self.mirror { -y } else { y };
        let (s, c) = self.rot.sin_cos();
        (c * x - s * y + self.tx, s * x + c * y + self.ty)
    }

    /// The image of a piece pose (x, y, theta): vertex directions theta + pi/2 + 2 pi k/N map to
    /// theta' + pi/2 + 2 pi k'/N with theta' = theta + rot, or rot - theta - pi under a reflection.
    pub fn pose(&self, p: [f64; 3]) -> [f64; 3] {
        let (x, y) = self.point(p[0], p[1]);
        let th = if self.mirror { self.rot - p[2] - PI } else { p[2] + self.rot };
        [x, y, th]
    }

    /// The preimage of a piece pose.
    pub fn inverse_pose(&self, p: [f64; 3]) -> [f64; 3] {
        let (s, c) = self.rot.sin_cos();
        let (dx, dy) = (p[0] - self.tx, p[1] - self.ty);
        let (x, y) = (c * dx + s * dy, -s * dx + c * dy);
        let y = if self.mirror { -y } else { y };
        let th = if self.mirror { self.rot - p[2] - PI } else { p[2] - self.rot };
        [x, y, th]
    }
}

/// Faces of one shape.
#[derive(Clone, Debug)]
pub struct FaceClass {
    pub cont: Container,
    /// The faces of this class, the representative first.
    pub faces: Vec<usize>,
    /// Largest load one face of the class can need: ceil(P / faces).
    pub kmax: usize,
    pub regular: bool,
}

/// One problem: its piece, face classes and maps.
#[derive(Clone, Debug)]
pub struct Problem {
    pub id: String,
    pub solid_name: String,
    pub solid: &'static Solid,
    pub n: usize,
    pub p: usize,
    pub piece: Piece,
    pub classes: Vec<FaceClass>,
    /// Per face: its class and the map from the class representative's frame to the face's frame.
    pub face_class: Vec<usize>,
    pub face_map: Vec<Transform>,
}

/// `surface/<solid>/nofold/<N>/<P>` as (solid, N, P), when this engine searches it.
pub fn parse_id(id: &str) -> Option<(String, usize, usize)> {
    let parts: Vec<&str> = id.split('/').collect();
    if parts.len() != 5 || parts[0] != "surface" || parts[2] != "nofold" {
        return None;
    }
    let solid = parts[1];
    if !is_solid_name(solid) {
        return None;
    }
    // the shape and the count as the ids write them: plain decimal integers
    let plain = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) && (t == "0" || !t.starts_with('0'));
    if !plain(parts[3]) || !plain(parts[4]) {
        return None;
    }
    let n: usize = parts[3].parse().ok()?;
    let p: usize = parts[4].parse().ok()?;
    let ok = (n == 0 || (3..=100).contains(&n)) && (1..=100).contains(&p);
    ok.then(|| (solid.to_string(), n, p))
}

/// The rigid map taking polygon a onto polygon b (flat vertex lists, same vertex count), matching vertex
/// i of a to vertex (t + i) of b (or (t - i) under a reflection), when one exists to `tol`.
fn congruence(a: &[f64], b: &[f64], tol: f64) -> Option<Transform> {
    let m = a.len() / 2;
    if b.len() != a.len() {
        return None;
    }
    for mirror in [false, true] {
        let av: Vec<(f64, f64)> = (0..m).map(|i| (a[2 * i], if mirror { -a[2 * i + 1] } else { a[2 * i + 1] })).collect();
        for t in 0..m {
            let map = |i: usize| if mirror { (t + m - i % m) % m } else { (t + i) % m };
            let (b0, b1) = ((b[2 * map(0)], b[2 * map(0) + 1]), (b[2 * map(1)], b[2 * map(1) + 1]));
            let (a0, a1) = (av[0], av[1]);
            let la = (a1.0 - a0.0).hypot(a1.1 - a0.1);
            let lb = (b1.0 - b0.0).hypot(b1.1 - b0.1);
            if (la - lb).abs() > tol {
                continue;
            }
            let rot = (b1.1 - b0.1).atan2(b1.0 - b0.0) - (a1.1 - a0.1).atan2(a1.0 - a0.0);
            let (s, c) = rot.sin_cos();
            let tx = b0.0 - (c * a0.0 - s * a0.1);
            let ty = b0.1 - (s * a0.0 + c * a0.1);
            let tf = Transform { rot, mirror, tx, ty };
            let ok = (0..m).all(|i| {
                let (x, y) = tf.point(a[2 * i], a[2 * i + 1]);
                let j = map(i);
                (x - b[2 * j]).hypot(y - b[2 * j + 1]) <= tol
            });
            if ok {
                return Some(tf);
            }
        }
    }
    None
}

impl Problem {
    pub fn new(id: &str) -> Result<Problem, String> {
        let (solid_name, n, p) = parse_id(id).ok_or_else(|| format!("fresh-surface-nofold does not search {id}"))?;
        let solid = get_solid(&solid_name)?;
        let piece = Piece::new(n);
        let mut classes: Vec<FaceClass> = Vec::new();
        let mut face_class = vec![0usize; solid.f];
        let mut face_map = vec![Transform::identity(); solid.f];
        for f in 0..solid.f {
            let poly = &solid.unit_faces[f];
            let scale = poly.iter().fold(0.0f64, |a, &v| a.max(v.abs()));
            let mut found = None;
            for (ci, cl) in classes.iter().enumerate() {
                let rep = cl.faces[0];
                if solid.sides[rep] != solid.sides[f] || solid.regular[rep] != solid.regular[f] {
                    continue;
                }
                if solid.regular[f] {
                    // every regular M-gon face is the same polygon in its frame
                    found = Some((ci, Transform::identity()));
                    break;
                }
                if let Some(tf) = congruence(&solid.unit_faces[rep], poly, 1e-9 * scale.max(1.0)) {
                    found = Some((ci, tf));
                    break;
                }
            }
            match found {
                Some((ci, tf)) => {
                    classes[ci].faces.push(f);
                    face_class[f] = ci;
                    face_map[f] = tf;
                }
                None => {
                    face_class[f] = classes.len();
                    classes.push(FaceClass { cont: Container::from_flat(poly), faces: vec![f], kmax: 0, regular: solid.regular[f] });
                }
            }
        }
        for cl in classes.iter_mut() {
            cl.kmax = p.div_ceil(cl.faces.len()).min(p);
        }
        Ok(Problem { id: id.to_string(), solid_name, solid, n, p, piece, classes, face_class, face_map })
    }

    /// A lower bound on the scale of k pieces on one face of class c (site units): the area bound, and
    /// for one piece the inscribed disk of the piece in the largest disk of the face.
    pub fn lower_bound(&self, c: usize, k: usize) -> f64 {
        if k == 0 {
            return 0.0;
        }
        let cl = &self.classes[c];
        let r = self.piece.r_site;
        let area = (k as f64 * self.piece.area * r * r / cl.cont.area).sqrt();
        let one = if cl.cont.rho > 0.0 { r * self.piece.inr / cl.cont.rho } else { 0.0 };
        area.max(one) * (1.0 - 1e-12)
    }
}
