//! Shapes, lattices and the exact geometry of this solver (used for starts, repairs and checks, never in the
//! energy's inner loop).
//!
//! Conventions (docs/spaces/TORUS.md section 1): a piece is a disk of diameter 1 (N = 0) or a regular N-gon of
//! side 1 whose vertex k sits at angle theta + pi/2 + 2 pi k / N about its centre (circumradius
//! R = 1 / (2 sin(pi/N)), apothem r = 1 / (2 tan(pi/N))). The torus is R^2 / (Z b1 + Z b2): `sq` has
//! b1 = L (1, 0), b2 = L (0, 1), `hex` b1 = L (1, 0), b2 = L (1/2, sqrt 3 / 2), both scored L; `free` any basis,
//! scored sqrt |det(b1, b2)|. A packing is valid when no two pieces' lattice translates overlap (a piece and its
//! own translates included).

use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Sq,
    Hex,
    Free,
}

impl Family {
    pub fn parse(s: &str) -> Option<Family> {
        match s {
            "sq" => Some(Family::Sq),
            "hex" => Some(Family::Hex),
            "free" => Some(Family::Free),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Family::Sq => "sq",
            Family::Hex => "hex",
            Family::Free => "free",
        }
    }
    /// The basis of the family's torus of score s (free: the square one), with the same floating-point
    /// operations as the server's check builds it from L.
    pub fn basis(self, s: f64) -> [f64; 4] {
        match self {
            Family::Hex => [s, 0.0, s / 2.0, (s * 3f64.sqrt()) / 2.0],
            _ => [s, 0.0, 0.0, s],
        }
    }
    /// Cell area of the torus of score s (free: s^2).
    pub fn area(self, s: f64) -> f64 {
        match self {
            Family::Hex => 0.5 * 3f64.sqrt() * s * s,
            _ => s * s,
        }
    }
}

/// A piece: a disk (n = 0) or a regular n-gon of side 1.
#[derive(Clone, Debug)]
pub struct Shape {
    pub n: usize,
    /// Bounding radius (circumradius, 1/2 for a disk).
    pub big_r: f64,
    /// Inradius (apothem, 1/2 for a disk).
    pub apo: f64,
    /// Angle between consecutive vertices, 2 pi / n (0 for a disk).
    pub step: f64,
    pub area: f64,
    /// Unit vertex directions at theta = 0.
    pub base: Vec<[f64; 2]>,
}

impl Shape {
    pub fn new(n: usize) -> Shape {
        if n == 0 {
            return Shape { n, big_r: 0.5, apo: 0.5, step: 0.0, area: 0.25 * PI, base: Vec::new() };
        }
        let nf = n as f64;
        let step = 2.0 * PI / nf;
        let base = (0..n).map(|k| {
            let a = 0.5 * PI + step * k as f64;
            [a.cos(), a.sin()]
        });
        Shape {
            n,
            big_r: 1.0 / (2.0 * (PI / nf).sin()),
            apo: 1.0 / (2.0 * (PI / nf).tan()),
            step,
            area: nf / (4.0 * (PI / nf).tan()),
            base: base.collect(),
        }
    }

    pub fn is_disk(&self) -> bool {
        self.n == 0
    }

    /// Support function of the piece at angle theta (centre at the origin) in the direction of angle phi:
    /// R cos of the angle from phi to the nearest vertex direction.
    #[inline]
    pub fn support(&self, theta: f64, phi: f64) -> f64 {
        if self.n == 0 {
            return 0.5;
        }
        let mut t = (phi - theta - 0.5 * PI) % self.step;
        if t < 0.0 {
            t += self.step;
        }
        if t > 0.5 * self.step {
            t = self.step - t;
        }
        self.big_r * t.cos()
    }

    /// Exact signed separation of piece a (centre 0, angle ta) and piece b (centre d, angle tb): the largest gap
    /// between their projections over the edge normals of both (separating axes); for overlapping pieces minus
    /// the penetration depth. Disks: |d| - 1.
    pub fn sep(&self, ta: f64, tb: f64, d: [f64; 2]) -> f64 {
        if self.n == 0 {
            return (d[0] * d[0] + d[1] * d[1]).sqrt() - 1.0;
        }
        let off = 0.5 * PI + 0.5 * self.step;
        let mut best = f64::NEG_INFINITY;
        for k in 0..self.n {
            // outward normal k of a: gap = n.d - r - h_b(-n)
            let phi = ta + off + self.step * k as f64;
            let (s, c) = phi.sin_cos();
            let g = c * d[0] + s * d[1] - self.apo - self.support(tb, phi + PI);
            if g > best {
                best = g;
            }
            // outward normal m of b, axis -m: gap = -m.d - r - h_a(-m)
            let phi = tb + off + self.step * k as f64;
            let (s, c) = phi.sin_cos();
            let g = -(c * d[0] + s * d[1]) - self.apo - self.support(ta, phi + PI);
            if g > best {
                best = g;
            }
        }
        best
    }

    /// The least factor lambda >= 0 such that the pair (a at 0, b at lambda d) is separated by `target`: along a
    /// fixed axis the gap is lambda n.d - w(n), so it is the least over the axes with n.d > 0 of
    /// (w(n) + target) / n.d. Infinite when d = 0.
    pub fn pair_scale(&self, ta: f64, tb: f64, d: [f64; 2], target: f64) -> f64 {
        if self.n == 0 {
            let r = (d[0] * d[0] + d[1] * d[1]).sqrt();
            return if r > 0.0 { (1.0 + target) / r } else { f64::INFINITY };
        }
        let off = 0.5 * PI + 0.5 * self.step;
        let mut best = f64::INFINITY;
        for k in 0..self.n {
            let phi = ta + off + self.step * k as f64;
            let (s, c) = phi.sin_cos();
            let nd = c * d[0] + s * d[1];
            if nd > 0.0 {
                let w = self.apo + self.support(tb, phi + PI);
                best = best.min((w + target) / nd);
            }
            let phi = tb + off + self.step * k as f64;
            let (s, c) = phi.sin_cos();
            let nd = -(c * d[0] + s * d[1]);
            if nd > 0.0 {
                let w = self.apo + self.support(ta, phi + PI);
                best = best.min((w + target) / nd);
            }
        }
        best
    }
}

/// det of the basis [b1x, b1y, b2x, b2y].
#[inline]
pub fn det(b: &[f64; 4]) -> f64 {
    b[0] * b[3] - b[1] * b[2]
}

/// Inverse of the basis matrix (columns b1, b2), in the same layout: [row0col0, row1col0, row0col1, row1col1].
#[inline]
pub fn inverse(b: &[f64; 4]) -> [f64; 4] {
    let d = det(b);
    [b[3] / d, -b[1] / d, -b[2] / d, b[0] / d]
}

/// Matrix (column-major, as the bases) times vector.
#[inline]
pub fn mul(m: &[f64; 4], v: [f64; 2]) -> [f64; 2] {
    [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]]
}

/// Product of two column-major 2x2 matrices.
#[inline]
pub fn mat_mul(a: &[f64; 4], b: &[f64; 4]) -> [f64; 4] {
    [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3]]
}

/// Lagrange-Gauss reduction of a basis: a basis of the same lattice with |b1| <= |b2| and
/// |b1.b2| <= |b1|^2 / 2, made right-handed (det > 0). Also the integer matrix M (column-major) with
/// reduced = basis M.
pub fn gauss_reduce(b: &[f64; 4]) -> ([f64; 4], [i64; 4]) {
    let mut u = [b[0], b[1]];
    let mut v = [b[2], b[3]];
    let mut mu = [1i64, 0];
    let mut mv = [0i64, 1];
    let n2 = |a: [f64; 2]| a[0] * a[0] + a[1] * a[1];
    if n2(v) < n2(u) {
        std::mem::swap(&mut u, &mut v);
        std::mem::swap(&mut mu, &mut mv);
    }
    for _ in 0..200 {
        let k = ((u[0] * v[0] + u[1] * v[1]) / n2(u)).round();
        if k == 0.0 || !k.is_finite() {
            break;
        }
        v = [v[0] - k * u[0], v[1] - k * u[1]];
        let ki = k as i64;
        mv = [mv[0] - ki * mu[0], mv[1] - ki * mu[1]];
        if n2(v) >= n2(u) {
            break;
        }
        std::mem::swap(&mut u, &mut v);
        std::mem::swap(&mut mu, &mut mv);
    }
    if u[0] * v[1] - u[1] * v[0] < 0.0 {
        v = [-v[0], -v[1]];
        mv = [-mv[0], -mv[1]];
    }
    ([u[0], u[1], v[0], v[1]], [mu[0], mu[1], mv[0], mv[1]])
}

/// True when the basis is reduced up to a small slack (no reduction step would change it).
pub fn is_reduced(b: &[f64; 4]) -> bool {
    let n1 = b[0] * b[0] + b[1] * b[1];
    let n2 = b[2] * b[2] + b[3] * b[3];
    let dot = b[0] * b[2] + b[1] * b[3];
    n1 <= n2 * (1.0 + 1e-9) && dot.abs() <= 0.5 * n1 * (1.0 + 1e-9) + 1e-12
}

/// The lattice vectors k = (m, n) with |d + m b1 + n b2| < cut, by the Cramer window (any basis): with
/// (al, be) the coordinates of d, |al + m| < cut |b2| / |det| and |be + n| < cut |b1| / |det|. With `half`,
/// only (m, n) in the half plane m > 0 or (m = 0, n > 0) (a piece and its own translates). Calls f(m, n, v).
#[inline]
pub fn images(b: &[f64; 4], inv: &[f64; 4], d: [f64; 2], cut: f64, half: bool, mut f: impl FnMut(i32, i32, [f64; 2])) {
    let a = mul(inv, d);
    let ad = det(b).abs();
    let x1 = cut * (b[2] * b[2] + b[3] * b[3]).sqrt() / ad;
    let x2 = cut * (b[0] * b[0] + b[1] * b[1]).sqrt() / ad;
    if !(x1.is_finite() && x2.is_finite() && a[0].is_finite() && a[1].is_finite()) {
        return;
    }
    let m0 = (-a[0] - x1).floor() as i64 - 1;
    let m1 = (-a[0] + x1).ceil() as i64 + 1;
    let n0 = (-a[1] - x2).floor() as i64 - 1;
    let n1 = (-a[1] + x2).ceil() as i64 + 1;
    let c2 = cut * cut;
    for m in m0..=m1 {
        if half && m < 0 {
            continue;
        }
        let bx = d[0] + m as f64 * b[0];
        let by = d[1] + m as f64 * b[1];
        for n in n0..=n1 {
            if half && m == 0 && n <= 0 {
                continue;
            }
            let vx = bx + n as f64 * b[2];
            let vy = by + n as f64 * b[3];
            if vx * vx + vy * vy < c2 {
                f(m as i32, n as i32, [vx, vy]);
            }
        }
    }
}

/// A packing in the solver's frame: the score s, the basis (free: upper triangular, b1 along +x, det = s^2;
/// sq and hex: the family's basis of score s), centres, angles, and the separating lines of near polygon pairs
/// keyed by (i, j, lattice vector) (sorted by key).
#[derive(Clone, Debug, Default)]
pub struct Sol {
    pub s: f64,
    pub b: [f64; 4],
    pub pos: Vec<f64>,
    pub ang: Vec<f64>,
    pub lines: Vec<(u64, [f64; 3])>,
}

impl Sol {
    pub fn new(p: usize) -> Sol {
        Sol { s: 0.0, b: [0.0; 4], pos: vec![0.0; 2 * p], ang: vec![0.0; p], lines: Vec::new() }
    }
    pub fn copy_from(&mut self, o: &Sol) {
        self.s = o.s;
        self.b = o.b;
        self.pos.clone_from(&o.pos);
        self.ang.clone_from(&o.ang);
        self.lines.clone_from(&o.lines);
    }
    pub fn p(&self) -> usize {
        self.ang.len()
    }
    /// Scales the whole packing (centres and lattice) by f about the origin; the score becomes f s.
    pub fn scale(&mut self, f: f64) {
        self.s *= f;
        for v in self.b.iter_mut() {
            *v *= f;
        }
        for v in self.pos.iter_mut() {
            *v *= f;
        }
    }
    /// Rescales to score s.
    pub fn rescale_to(&mut self, s: f64) {
        let f = s / self.s;
        self.scale(f);
        self.s = s;
    }
}

/// The key of a pair (i <= j) and lattice vector (m, n).
#[inline]
pub fn pair_key(i: usize, j: usize, m: i32, n: i32) -> u64 {
    ((i as u64) << 44) | ((j as u64) << 32) | ((((m + 32768) as u64) & 0xffff) << 16) | (((n + 32768) as u64) & 0xffff)
}

#[inline]
pub fn key_parts(k: u64) -> (usize, usize, i32, i32) {
    ((k >> 44) as usize, ((k >> 32) & 0xfff) as usize, ((k >> 16) & 0xffff) as i32 - 32768, (k & 0xffff) as i32 - 32768)
}

/// Every image pair whose centres are closer than `cut`: f(i, j, m, n, v) for i < j and every lattice vector
/// (m, n) with v = x_j - x_i + m b1 + n b2, |v| < cut, and for i = j every such (m, n) in the half plane. All
/// pairs of pieces for few pieces or a small cell; otherwise a grid over the cell in fractional coordinates,
/// with cells at least the window wide, so that only neighbouring cells can hold a near pair.
pub fn near_images(b: &[f64; 4], pos: &[f64], cut: f64, cells: &mut Vec<Vec<u32>>, mut f: impl FnMut(usize, usize, i32, i32, [f64; 2])) {
    let p = pos.len() / 2;
    let inv = inverse(b);
    let ad = det(b).abs();
    let x1 = cut * (b[2] * b[2] + b[3] * b[3]).sqrt() / ad;
    let x2 = cut * (b[0] * b[0] + b[1] * b[1]).sqrt() / ad;
    let g1 = if x1 > 0.0 { (1.0 / x1).floor().min(64.0) as usize } else { 0 };
    let g2 = if x2 > 0.0 { (1.0 / x2).floor().min(64.0) as usize } else { 0 };
    if p < 48 || g1 < 3 || g2 < 3 {
        for i in 0..p {
            for j in i..p {
                let d = [pos[2 * j] - pos[2 * i], pos[2 * j + 1] - pos[2 * i + 1]];
                images(b, &inv, d, cut, i == j, |m, n, v| f(i, j, m, n, v));
            }
        }
        return;
    }
    let nc = g1 * g2;
    if cells.len() < nc {
        cells.resize(nc, Vec::new());
    }
    for c in cells[..nc].iter_mut() {
        c.clear();
    }
    let mut home = Vec::with_capacity(p);
    for i in 0..p {
        let fr = mul(&inv, [pos[2 * i], pos[2 * i + 1]]);
        let u = fr[0] - fr[0].floor();
        let v = fr[1] - fr[1].floor();
        let c1 = ((u * g1 as f64) as usize).min(g1 - 1);
        let c2 = ((v * g2 as f64) as usize).min(g2 - 1);
        home.push((c1, c2));
        cells[c1 * g2 + c2].push(i as u32);
    }
    for i in 0..p {
        let (c1, c2) = home[i];
        images(b, &inv, [0.0, 0.0], cut, true, |m, n, v| f(i, i, m, n, v));
        for a in [g1 - 1, 0, 1] {
            for bb in [g2 - 1, 0, 1] {
                for &j in &cells[((c1 + a) % g1) * g2 + (c2 + bb) % g2] {
                    let j = j as usize;
                    if j > i {
                        let d = [pos[2 * j] - pos[2 * i], pos[2 * j + 1] - pos[2 * i + 1]];
                        images(b, &inv, d, cut, false, |m, n, v| f(i, j, m, n, v));
                    }
                }
            }
        }
    }
}

/// Smallest exact separation over every image pair of the packing (piece pairs i < j with every translate, and
/// every piece with its own nonzero translates) whose centres are within reach; +infinity when none is.
pub fn min_separation(sh: &Shape, sol: &Sol) -> f64 {
    let cut = 2.0 * sh.big_r + 1e-9;
    let mut best = f64::INFINITY;
    let mut cells = Vec::new();
    near_images(&sol.b, &sol.pos, cut, &mut cells, |i, j, _, _, v| {
        let s = sh.sep(sol.ang[i], sol.ang[j], v);
        if s < best {
            best = s;
        }
    });
    best
}

/// The least factor >= 1 by which scaling the packing about the origin separates every image pair by at least
/// `target` (exact per pair, see `Shape::pair_scale`).
pub fn repair_scale(sh: &Shape, sol: &Sol, target: f64) -> f64 {
    let cut = 2.0 * sh.big_r + target + 1e-9;
    let mut lam = 1.0f64;
    let mut cells = Vec::new();
    near_images(&sol.b, &sol.pos, cut, &mut cells, |i, j, _, _, v| {
        if sh.sep(sol.ang[i], sol.ang[j], v) < target {
            lam = lam.max(sh.pair_scale(sol.ang[i], sol.ang[j], v, target));
        }
    });
    lam
}

/// Scales the packing (centres and lattice) to the least score at which no two images overlap: first so that the
/// nearest centres are 2R apart (then nothing overlaps), then down to the largest per-pair contact factor
/// (`Shape::pair_scale`) over the pairs that can bind (closer than 2R^2/r: a farther pair's factor is below r/R,
/// which the nearest pair's already exceeds). Returns false for a degenerate arrangement (coincident centres).
pub fn scale_to_contact(sh: &Shape, sol: &mut Sol) -> bool {
    let (rb, _) = gauss_reduce(&sol.b);
    let lim = (rb[0] * rb[0] + rb[1] * rb[1]).sqrt() * 1.001;
    let mut dnn = f64::INFINITY;
    let mut cells = Vec::new();
    near_images(&sol.b, &sol.pos, lim, &mut cells, |_, _, _, _, v| {
        dnn = dnn.min((v[0] * v[0] + v[1] * v[1]).sqrt());
    });
    if !(dnn > 0.0 && dnn.is_finite()) {
        return false;
    }
    sol.scale(2.0 * sh.big_r / dnn);
    let cut = 2.0 * sh.big_r * sh.big_r / sh.apo * (1.0 + 1e-9);
    let mut lam = 0.0f64;
    near_images(&sol.b, &sol.pos, cut, &mut cells, |i, j, _, _, v| {
        lam = lam.max(sh.pair_scale(sol.ang[i], sol.ang[j], v, 0.0));
    });
    if !(lam > 0.0 && lam.is_finite()) {
        return false;
    }
    sol.scale(lam * (1.0 + 1e-12));
    true
}

/// Rotates the whole packing by angle a about the origin (centres, lattice, piece angles and line normals).
pub fn rotate(sol: &mut Sol, a: f64) {
    let (s, c) = a.sin_cos();
    let rot = |v: [f64; 2]| [c * v[0] - s * v[1], s * v[0] + c * v[1]];
    let b1 = rot([sol.b[0], sol.b[1]]);
    let b2 = rot([sol.b[2], sol.b[3]]);
    sol.b = [b1[0], b1[1], b2[0], b2[1]];
    for i in 0..sol.p() {
        let v = rot([sol.pos[2 * i], sol.pos[2 * i + 1]]);
        sol.pos[2 * i] = v[0];
        sol.pos[2 * i + 1] = v[1];
        sol.ang[i] += a;
    }
    for (_, l) in sol.lines.iter_mut() {
        let v = rot([l[0], l[1]]);
        l[0] = v[0];
        l[1] = v[1];
    }
}

/// Brings every centre into the cell (fractional coordinates in [0, 1)), moving the keys of the stored lines
/// with the pieces, and for a free lattice first reduces the basis and turns the packing so that b1 lies along
/// +x with det > 0 (then the lines are dropped: they are rebuilt from scratch). Changes nothing physical.
pub fn canonicalize(sol: &mut Sol, free: bool) {
    let p = sol.p();
    if free && (!is_reduced(&sol.b) || sol.b[1] != 0.0 || det(&sol.b) <= 0.0) {
        let (rb, _) = gauss_reduce(&sol.b);
        sol.b = rb;
        let a = rb[1].atan2(rb[0]);
        rotate(sol, -a);
        // exactly upper triangular: b1 = (|b1|, 0)
        sol.b[0] = (sol.b[0] * sol.b[0] + sol.b[1] * sol.b[1]).sqrt();
        sol.b[1] = 0.0;
        // keep det = s^2 exactly in the solver's frame (the rotation leaves it up to rounding)
        sol.b[3] = sol.s * sol.s / sol.b[0];
        sol.lines.clear();
    }
    let inv = inverse(&sol.b);
    let mut shift = vec![[0i32; 2]; p];
    let mut any = false;
    for i in 0..p {
        let f = mul(&inv, [sol.pos[2 * i], sol.pos[2 * i + 1]]);
        let w = [f[0].floor(), f[1].floor()];
        if w[0] != 0.0 || w[1] != 0.0 {
            any = true;
            shift[i] = [w[0] as i32, w[1] as i32];
            let v = mul(&sol.b, w);
            sol.pos[2 * i] -= v[0];
            sol.pos[2 * i + 1] -= v[1];
        }
    }
    if any && !sol.lines.is_empty() {
        // d = x_j - x_i + B k with x = x' + B w: k' = k + w_j - w_i
        let mut out = Vec::with_capacity(sol.lines.len());
        for &(k, l) in sol.lines.iter() {
            let (i, j, m, n) = key_parts(k);
            let m2 = m + shift[j][0] - shift[i][0];
            let n2 = n + shift[j][1] - shift[i][1];
            out.push((pair_key(i, j, m2, n2), l));
        }
        out.sort_by_key(|e| e.0);
        sol.lines = out;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduce_keeps_the_lattice() {
        let b = [3.0, 0.0, 1000.3, 1.9];
        let (r, m) = gauss_reduce(&b);
        // reduced = b M
        let c1 = [b[0] * m[0] as f64 + b[2] * m[1] as f64, b[1] * m[0] as f64 + b[3] * m[1] as f64];
        let c2 = [b[0] * m[2] as f64 + b[2] * m[3] as f64, b[1] * m[2] as f64 + b[3] * m[3] as f64];
        assert!((c1[0] - r[0]).abs() < 1e-9 && (c1[1] - r[1]).abs() < 1e-9);
        assert!((c2[0] - r[2]).abs() < 1e-9 && (c2[1] - r[3]).abs() < 1e-9);
        assert!(is_reduced(&r));
        assert!((det(&r) - det(&b).abs()).abs() < 1e-9);
    }

    #[test]
    fn images_match_brute_force() {
        let b = [2.0, 0.0, 0.7, 1.7];
        let inv = inverse(&b);
        let d = [3.3, -2.2];
        let mut got = Vec::new();
        images(&b, &inv, d, 2.5, false, |m, n, _| got.push((m, n)));
        let mut want = Vec::new();
        for m in -20..=20 {
            for n in -20..=20 {
                let vx = d[0] + m as f64 * b[0] + n as f64 * b[2];
                let vy = d[1] + m as f64 * b[1] + n as f64 * b[3];
                if vx * vx + vy * vy < 6.25 {
                    want.push((m, n));
                }
            }
        }
        got.sort();
        want.sort();
        assert_eq!(got, want);
    }
}
