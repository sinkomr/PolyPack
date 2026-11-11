//! Rigid geometry of the polyhedra family: placed pieces, the separating-axis test between two placed convex
//! polyhedra and containment in the scaled container. Port of `packages/polyhedra/src/geom.ts`.
//!
//! A pose is [x, y, z, qw, qx, qy, qz]: the canonical piece turned by the rotation of the quaternion q / |q|
//! (scalar first; v -> q v q*) and moved so that its centre is at (x, y, z). Any nonzero q is accepted; the
//! rotation is the exactly orthogonal matrix H(q) / |q|^2 that the certifier uses.
//!
//! The separating-axis test follows upstream's src/geom.js and verify_general.py (alejandrozu/platonic-packing,
//! MIT; see THIRD_PARTY_NOTICES.md): the candidate axes are the face normals of both pieces and the cross
//! products of an edge of each whose Gauss-map arcs intersect (D. Gregorius, GDC 2013). Those cross products
//! are the face normals of the Minkowski difference A - B, so for overlapping pieces the smallest overlap over
//! the candidates is the exact penetration depth, and for disjoint pieces some candidate separates them.
//!
//! Every sum and product below is written in the source's order, so that the two round alike. Two places are
//! not a literal transcription, and both give the source's numbers to the bit (the comparison with the
//! TypeScript and the test `project_is_the_scan_in_order` check it):
//!  - `project` keeps four running minima and maxima instead of one (see there);
//!  - in `separation`'s loop over the edge pairs, the products nB . (b x a) are computed once per face of B for
//!    each edge of A, and read by the edges of B, where the source computes them again for every edge.
//! Together they make a pair's full test about 1.6 times faster than the literal form (measured on the
//! comparison's slowest cases).

use crate::solids::Solid;
use polypack_js::math;

/// `geom.ts: Pose`: [x, y, z, qw, qx, qy, qz].
pub type Pose = [f64; 7];

/// `geom.ts: Placed`: a piece placed in the world: its vertices, face normals and the edges' adjacent face
/// normals (through `solid.edge_faces`).
#[derive(Clone, Debug)]
pub struct Placed<'a> {
    pub solid: &'a Solid,
    /// Centre.
    pub c: [f64; 3],
    /// Row-major rotation, world = R local.
    pub r: [f64; 9],
    /// World vertices, flat.
    pub x: Vec<f64>,
    /// World unit face normals, flat.
    pub fn_: Vec<f64>,
}

/// `geom.ts: quatToR`: the rotation of q / |q| as a row-major 3x3 matrix. q is first divided by its largest
/// component, so that tiny or huge quaternions neither underflow nor overflow. The source throws a RangeError
/// for a zero or non-finite q; that is the `Err` here, with its message.
pub fn quat_to_r(qw: f64, qx: f64, qy: f64, qz: f64) -> Result<[f64; 9], String> {
    let m = math::max(math::max(math::max(math::abs(qw), math::abs(qx)), math::abs(qy)), math::abs(qz));
    if !(m > 0.0) || !m.is_finite() {
        return Err("the quaternion must be finite and nonzero".to_string());
    }
    let mut w = qw / m;
    let mut x = qx / m;
    let mut y = qy / m;
    let mut z = qz / m;
    let n = (w * w + x * x + y * y + z * z).sqrt();
    w /= n;
    x /= n;
    y /= n;
    z /= n;
    let mut out = [0.0f64; 9];
    out[0] = 1.0 - 2.0 * (y * y + z * z);
    out[1] = 2.0 * (x * y - w * z);
    out[2] = 2.0 * (x * z + w * y);
    out[3] = 2.0 * (x * y + w * z);
    out[4] = 1.0 - 2.0 * (x * x + z * z);
    out[5] = 2.0 * (y * z - w * x);
    out[6] = 2.0 * (x * z - w * y);
    out[7] = 2.0 * (y * z + w * x);
    out[8] = 1.0 - 2.0 * (x * x + y * y);
    Ok(out)
}

/// `geom.ts: place`: the solid in a pose. `Err` when the quaternion is zero or not finite (see `quat_to_r`).
pub fn place<'a>(solid: &'a Solid, pose: &Pose) -> Result<Placed<'a>, String> {
    let r = quat_to_r(pose[3], pose[4], pose[5], pose[6])?;
    let c = [pose[0], pose[1], pose[2]];
    let nv = solid.nv;
    let v = &solid.v;
    let mut x = vec![0.0f64; 3 * nv];
    for i in 0..nv {
        let a = v[3 * i];
        let b = v[3 * i + 1];
        let d = v[3 * i + 2];
        x[3 * i] = c[0] + r[0] * a + r[1] * b + r[2] * d;
        x[3 * i + 1] = c[1] + r[3] * a + r[4] * b + r[5] * d;
        x[3 * i + 2] = c[2] + r[6] * a + r[7] * b + r[8] * d;
    }
    let f_count = solid.faces.len();
    let n = &solid.n;
    let mut fn_ = vec![0.0f64; 3 * f_count];
    for f in 0..f_count {
        let a = n[3 * f];
        let b = n[3 * f + 1];
        let d = n[3 * f + 2];
        fn_[3 * f] = r[0] * a + r[1] * b + r[2] * d;
        fn_[3 * f + 1] = r[3] * a + r[4] * b + r[5] * d;
        fn_[3 * f + 2] = r[6] * a + r[7] * b + r[8] * d;
    }
    Ok(Placed { solid, c, r, x, fn_ })
}

/// `geom.ts: project`: min and max of X . u over the vertices, scanned in the source's order.
fn project_in_order(x: &[f64], ux: f64, uy: f64, uz: f64) -> (f64, f64) {
    let mut mn = f64::INFINITY;
    let mut mx = f64::NEG_INFINITY;
    for v in x.chunks_exact(3) {
        let p = v[0] * ux + v[1] * uy + v[2] * uz;
        if p < mn {
            mn = p;
        }
        if p > mx {
            mx = p;
        }
    }
    (mn, mx)
}

/// `geom.ts: project`: min and max of X . u over the vertices.
///
/// Each product X . u is computed as in the source. The smallest and the largest are kept in four running
/// pairs (vertex i in pair i mod 4) that are merged at the end, so that the processor works on four vertices at
/// a time. The result is the source's to the bit: the smallest of a set of numbers does not depend on the order
/// they are compared in, except that 0 and -0 are equal and the first one met is kept; when an extreme is zero
/// the scan is therefore repeated in the source's order. (A NaN is skipped by `p < mn` and `p > mx` in any order.)
#[inline]
fn project(x: &[f64], ux: f64, uy: f64, uz: f64) -> (f64, f64) {
    let mut mn = [f64::INFINITY; 4];
    let mut mx = [f64::NEG_INFINITY; 4];
    let mut quads = x.chunks_exact(12);
    for c in &mut quads {
        for k in 0..4 {
            let p = c[3 * k] * ux + c[3 * k + 1] * uy + c[3 * k + 2] * uz;
            if p < mn[k] {
                mn[k] = p;
            }
            if p > mx[k] {
                mx[k] = p;
            }
        }
    }
    for (k, v) in quads.remainder().chunks_exact(3).enumerate() {
        let p = v[0] * ux + v[1] * uy + v[2] * uz;
        if p < mn[k] {
            mn[k] = p;
        }
        if p > mx[k] {
            mx[k] = p;
        }
    }
    let mut lo = mn[0];
    let mut hi = mx[0];
    for k in 1..4 {
        if mn[k] < lo {
            lo = mn[k];
        }
        if mx[k] > hi {
            hi = mx[k];
        }
    }
    if lo == 0.0 || hi == 0.0 {
        return project_in_order(x, ux, uy, uz);
    }
    (lo, hi)
}

/// `geom.ts: Separation`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Separation {
    /// The largest gap over the candidate axes: for overlapping pieces minus the exact penetration depth (<= 0);
    /// for disjoint pieces a positive lower bound on their distance. When the test stopped early (see `stop_at`),
    /// the gap of the axis that stopped it.
    pub sep: f64,
    /// A unit axis attaining sep (pointing from A to B when sep > 0).
    pub axis: [f64; 3],
    /// Number of axes projected.
    pub axes: u64,
}

/// The state of `separation`'s closure `consider`: the best gap so far and its axis.
struct Best<'p, 'a> {
    a: &'p Placed<'a>,
    b: &'p Placed<'a>,
    stop_at: f64,
    best: f64,
    bx: f64,
    by: f64,
    bz: f64,
    axes: u64,
}

impl Best<'_, '_> {
    /// `separation`'s `consider`: projects both pieces on the unit axis u and keeps the larger gap; true when the
    /// best gap has reached `stop_at`.
    #[inline]
    fn consider(&mut self, ux: f64, uy: f64, uz: f64) -> bool {
        self.axes += 1;
        let (pa0, pa1) = project(&self.a.x, ux, uy, uz);
        let (pb0, pb1) = project(&self.b.x, ux, uy, uz);
        let g1 = pb0 - pa1;
        let g2 = pa0 - pb1;
        let g = if g1 >= g2 { g1 } else { g2 };
        if g > self.best {
            self.best = g;
            let s = if g1 >= g2 { 1.0 } else { -1.0 };
            self.bx = s * ux;
            self.by = s * uy;
            self.bz = s * uz;
        }
        self.best >= self.stop_at
    }

    fn done(&self) -> Separation {
        Separation { sep: self.best, axis: [self.bx, self.by, self.bz], axes: self.axes }
    }
}

/// `geom.ts: separation`: separating-axis test of two placed pieces. With `stop_at`, the test ends at the first
/// axis whose gap is at least stop_at (enough to decide sep >= stop_at; `f64::INFINITY` for the exact
/// separation). `hint`, a unit axis, is tried first.
pub fn separation(a: &Placed, b: &Placed, stop_at: f64, hint: Option<[f64; 3]>) -> Separation {
    let mut st = Best { a, b, stop_at, best: f64::NEG_INFINITY, bx: 0.0, by: 0.0, bz: 1.0, axes: 0 };
    if let Some(hint) = hint {
        let l = math::hypot3(hint[0], hint[1], hint[2]);
        if l > 0.0 && st.consider(hint[0] / l, hint[1] / l, hint[2] / l) {
            return st.done();
        }
    }
    // the line between the centres often separates and is cheap to try
    {
        let dx = b.c[0] - a.c[0];
        let dy = b.c[1] - a.c[1];
        let dz = b.c[2] - a.c[2];
        let l = math::hypot3(dx, dy, dz);
        if l > 0.0 && st.consider(dx / l, dy / l, dz / l) {
            return st.done();
        }
    }
    let fa = &a.fn_;
    let fb = &b.fn_;
    let mut f = 0;
    while f < fa.len() {
        if st.consider(fa[f], fa[f + 1], fa[f + 2]) {
            return st.done();
        }
        f += 3;
    }
    let mut f = 0;
    while f < fb.len() {
        if st.consider(fb[f], fb[f + 1], fb[f + 2]) {
            return st.done();
        }
        f += 3;
    }
    // edge-edge axes with Gauss-map pruning. For an edge with faces (f1, f2) the arc runs from n1 to n2
    // on the Gauss map; B's arcs are negated. Arcs (a, b) and (c, d) intersect iff
    //   (c . (b x a)) (d . (b x a)) < 0, (a . (d x c)) (b . (d x c)) < 0 and (c . (b x a)) (b . (d x c)) > 0,
    // with c = -nB1, d = -nB2 (the test of geom.js edgeAxes).
    let ea = &a.solid.edge_faces;
    let eb = &b.solid.edge_faces;
    let nb = eb.len();
    let mut cb = vec![0.0f64; 3 * nb]; // nB2 x nB1 per edge of B (= d x c), unnormalised
    for j in 0..nb {
        let [g1, g2] = eb[j];
        let c1x = fb[3 * g1];
        let c1y = fb[3 * g1 + 1];
        let c1z = fb[3 * g1 + 2];
        let c2x = fb[3 * g2];
        let c2y = fb[3 * g2 + 1];
        let c2z = fb[3 * g2 + 2];
        cb[3 * j] = c2y * c1z - c2z * c1y;
        cb[3 * j + 1] = c2z * c1x - c2x * c1z;
        cb[3 * j + 2] = c2x * c1y - c2y * c1x;
    }
    let mut fb_dot = vec![0.0f64; fb.len() / 3];
    for &[f1, f2] in ea.iter() {
        let ax = fa[3 * f1];
        let ay = fa[3 * f1 + 1];
        let az = fa[3 * f1 + 2];
        let bxx = fa[3 * f2];
        let byy = fa[3 * f2 + 1];
        let bzz = fa[3 * f2 + 2];
        // b x a
        let pcx = byy * az - bzz * ay;
        let pcy = bzz * ax - bxx * az;
        let pcz = bxx * ay - byy * ax;
        // nB . (b x a) for every face of B, once per edge of A: the source computes the same product for each
        // edge of B that has the face (twice per edge, so each face several times over)
        for (d, nrm) in fb_dot.iter_mut().zip(fb.chunks_exact(3)) {
            *d = nrm[0] * pcx + nrm[1] * pcy + nrm[2] * pcz;
        }
        for j in 0..nb {
            let [g1, g2] = eb[j];
            // C = -nB1, D = -nB2
            let cba = -fb_dot[g1];
            let dba = -fb_dot[g2];
            if cba * dba >= 0.0 {
                continue;
            }
            let qx = cb[3 * j];
            let qy = cb[3 * j + 1];
            let qz = cb[3 * j + 2];
            let adc = ax * qx + ay * qy + az * qz;
            let bdc = bxx * qx + byy * qy + bzz * qz;
            if adc * bdc >= 0.0 || cba * bdc <= 0.0 {
                continue;
            }
            // the axis is the cross product of the two edge directions, i.e. of (b x a) and (d x c)
            let mut wx = pcy * qz - pcz * qy;
            let mut wy = pcz * qx - pcx * qz;
            let mut wz = pcx * qy - pcy * qx;
            let l = math::hypot3(wx, wy, wz);
            if l < 1e-12 {
                continue;
            }
            wx /= l;
            wy /= l;
            wz /= l;
            if st.consider(wx, wy, wz) {
                return st.done();
            }
        }
    }
    st.done()
}

/// `geom.ts: wallGap`: smallest wall gap s b_f - N_f . x over the piece's vertices and the container's faces
/// (unit normals).
pub fn wall_gap(container: &Solid, s: f64, x: &[f64]) -> f64 {
    let n = &container.n;
    let b = &container.offsets;
    let mut g = f64::INFINITY;
    for f in 0..b.len() {
        let nx = n[3 * f];
        let ny = n[3 * f + 1];
        let nz = n[3 * f + 2];
        let lim = s * b[f];
        for v in x.chunks_exact(3) {
            let d = lim - (v[0] * nx + v[1] * ny + v[2] * nz);
            if d < g {
                g = d;
            }
        }
    }
    g
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solids::get_solid;

    /// A small deterministic generator (mulberry32).
    fn generator(mut state: u32) -> impl FnMut() -> f64 {
        move || {
            state = state.wrapping_add(0x6d2b79f5);
            let mut t = state;
            t = (t ^ (t >> 15)).wrapping_mul(t | 1);
            t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
            ((t ^ (t >> 14)) as f64) / 4294967296.0
        }
    }

    /// `project` keeps four running extremes; it must give the bits of the scan in the source's order, also when
    /// the extreme is a zero of either sign and when values repeat.
    #[test]
    fn project_is_the_scan_in_order() {
        let mut random = generator(7);
        for round in 0..20000 {
            let nv = 1 + (random() * 40.0) as usize;
            let mut x = Vec::with_capacity(3 * nv);
            for _ in 0..3 * nv {
                let r = random();
                // many exact zeros of both signs and repeated values, so that ties are common
                x.push(if r < 0.2 {
                    0.0
                } else if r < 0.4 {
                    -0.0
                } else if r < 0.6 {
                    (random() * 4.0).floor() - 2.0
                } else {
                    random() * 2.0 - 1.0
                });
            }
            let pick = |r: f64| if r < 0.3 { 0.0 } else if r < 0.5 { -1.0 } else if r < 0.7 { 1.0 } else { r - 0.85 };
            let (ux, uy, uz) = if round % 3 == 0 {
                (pick(random()), pick(random()), pick(random()))
            } else {
                (random() - 0.5, random() - 0.5, random() - 0.5)
            };
            let a = project(&x, ux, uy, uz);
            let b = project_in_order(&x, ux, uy, uz);
            assert_eq!((a.0.to_bits(), a.1.to_bits()), (b.0.to_bits(), b.1.to_bits()), "round {round}");
        }
    }

    #[test]
    fn two_cubes() {
        let cube = get_solid("cube").unwrap();
        let a = place(cube, &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]).unwrap();
        // apart by a half along x: the line of centres separates them by exactly 0.5
        let b = place(cube, &[1.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]).unwrap();
        let r = separation(&a, &b, f64::INFINITY, None);
        assert_eq!(r.sep, 0.5);
        assert_eq!(r.axis, [1.0, 0.0, 0.0]);
        // into each other by a quarter: the penetration depth
        let c = place(cube, &[0.75, 0.25, 0.0, 2.0, 0.0, 0.0, 0.0]).unwrap();
        assert_eq!(separation(&a, &c, f64::INFINITY, None).sep, -0.25);
        // the test stops at the first axis with the gap asked for
        assert_eq!(separation(&a, &b, 1e-3, None).axes, 1);
        assert!(quat_to_r(0.0, 0.0, 0.0, 0.0).is_err());
        assert!(quat_to_r(f64::NAN, 0.0, 0.0, 1.0).is_err());
        assert_eq!(quat_to_r(1e-200, 0.0, 0.0, 0.0).unwrap(), [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(wall_gap(cube, 3.0, &a.x), 1.0);
    }
}
