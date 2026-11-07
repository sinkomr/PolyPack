//! Gap rows with analytic gradients for the search (packages/curved/src/evaluate.ts and model.ts),
//! organised for speed:
//!  - piece states (pose motion, its inverse, vertices, edge lines) are arrays over the pieces,
//!    rebuilt in place for every evaluation without allocation;
//!  - the body Jacobian of a piece is built only when a row of that piece needs a gradient;
//!  - candidate pairs come from a grid of cells of the interaction reach (or all pairs when P is
//!    small), and pairs whose half squared chord exceeds that of the reach are dropped unexamined;
//!  - the separating-axis test stops as soon as an axis separates the pieces by the threshold of
//!    the caller, tries the edges facing the other piece first, and accepts an edge at once when
//!    the other piece's circumscribed disk lies beyond it;
//!  - wall tests skip pieces inside the container's inscribed disk and walls that a piece's
//!    circumscribed disk does not reach.
//!
//! Values and gradients are those of the reference (the same formulas); only the order of
//! summation and the representation of edge lines (transformed from the standard piece's instead
//! of crossed from the placed vertices) differ in the last bits.
//!
//! Every constraint is a gap in geodesic length units (validate.rs). Gradients are taken with
//! respect to the pose coordinates (x, y, theta) of the pieces involved and the container
//! variable t (apothem h or radius r): first in the body frame of a piece (the generators P_x, P_y
//! and J acting on the lifted point), then through the body Jacobian of the pose.

use crate::geom::{line_value, pair_vs, transvection_of};
use crate::kfun::{ang_k, asn_k, cs_k, dist_from_vs, sfun, sn_k, ufun, vfun, vs_k};
use crate::problem::Space;
use std::f64::consts::PI;

/// No second piece (wall and rim rows).
pub const NONE: u32 = u32::MAX;

/// One constraint: value >= 0 is feasible; gi/gj: d value / d (x, y, theta) of pieces i and j;
/// gt: d value / dt.
#[derive(Clone, Copy, Debug, Default)]
pub struct Row {
    pub i: u32,
    pub j: u32,
    pub value: f64,
    pub gi: [f64; 3],
    pub gj: [f64; 3],
    pub gt: f64,
}

/// Separating-axis result of a polygon pair in n . v units (before asn_K).
#[derive(Clone, Copy, Debug)]
struct Sat {
    y: f64,
    /// axis is an edge of the first piece (0) or of the second (1)
    owner: u8,
    edge: usize,
    vertex: usize,
}

/// sn_K(d) for a threshold distance d, or +infinity when d lies beyond the monotone branch of sn_K
/// (K > 0 and d >= pi / (2 sqrt K)), where every asn_K value is below d.
#[inline]
fn sn_threshold(k: f64, d: f64) -> f64 {
    if k > 0.0 && d * k.sqrt() >= PI / 2.0 {
        f64::INFINITY
    } else {
        sn_k(k, d)
    }
}

/// S(t) and V(t) together (kfun.rs), the closed forms from one sine and cosine (t > 0) or one
/// exponential (t < 0) of half the argument: S = 2 sn(r/2) cs(r/2) / r, V = 2 sn(r/2)^2 / t.
#[inline]
fn sv_pair(t: f64) -> (f64, f64) {
    if t.abs() < 0.5 {
        return (sfun(t), vfun(t));
    }
    if t > 0.0 {
        let r = t.sqrt();
        let (s, c) = libm::sincos(r / 2.0);
        return (2.0 * s * c / r, (2.0 * s * s) / t);
    }
    let r = (-t).sqrt();
    // r / 2 >= 0.35 here, where (e - 1/e) / 2 loses no accuracy
    let e = libm::exp(r / 2.0);
    if !e.is_finite() {
        return (sfun(t), vfun(t));
    }
    let sh = (e - 1.0 / e) / 2.0;
    let ch = (e + 1.0 / e) / 2.0;
    (2.0 * sh * ch / r, (2.0 * sh * sh) / -t)
}

/// Generators P_x, P_y, J of the isometry group acting on a lifted point p, as lifted tangent
/// vectors: P_x p = (x, 1 - K e, 0), P_y p = (y, 0, 1 - K e), J p = (0, -y, x).
#[inline]
fn generators(k: f64, p: &[f64; 3]) -> [[f64; 3]; 3] {
    let w = 1.0 - k * p[0];
    [[p[1], w, 0.0], [p[2], 0.0, w], [0.0, -p[2], p[1]]]
}

#[inline]
fn dot3(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// L^T a for a row-major 3x3 L.
#[inline]
fn lt_mul(l: &[f64; 9], a: &[f64; 3]) -> [f64; 3] {
    [
        l[0] * a[0] + l[3] * a[1] + l[6] * a[2],
        l[1] * a[0] + l[4] * a[1] + l[7] * a[2],
        l[2] * a[0] + l[5] * a[1] + l[8] * a[2],
    ]
}

/// Pose gradient = Jb^T body gradient (Jb[2] = Jb[5] = 0, Jb[8] = 1).
#[inline]
fn to_pose(jb: &[f64; 9], b: &[f64; 3]) -> [f64; 3] {
    [
        jb[0] * b[0] + jb[3] * b[1] + jb[6] * b[2],
        jb[1] * b[0] + jb[4] * b[1] + jb[7] * b[2],
        b[2],
    ]
}

pub struct Evaluator {
    pub k: f64,
    /// sides of a piece (0 for disks)
    pub n: usize,
    /// sides of the container (0 for a disk container)
    pub m: usize,
    pub p: usize,
    /// circumradius and inradius of the piece
    pub r: f64,
    pub rho: f64,
    pub area: f64,
    pub t_max: f64,
    /// standard piece: vertices (lifted), edge covectors and their affine form (-K n0, n1, n2)
    vloc: Vec<[f64; 3]>,
    eloc0: Vec<f64>,
    eloc_a: Vec<[f64; 3]>,
    /// generators at each standard vertex: gen_loc[k][a]
    gen_loc: Vec<[[f64; 3]; 3]>,
    // ---- state of the current poses
    gl: Vec<[f64; 9]>,
    gb: Vec<[f64; 3]>,
    il: Vec<[f64; 9]>,
    ib: Vec<[f64; 3]>,
    /// x, y, t = K (x^2 + y^2), S(t), V(t), cos theta, sin theta of each pose
    frame: Vec<[f64; 7]>,
    jb: Vec<[f64; 9]>,
    jb_stamp: Vec<u32>,
    stamp: u32,
    verts: Vec<[f64; 3]>,
    edges: Vec<[f64; 3]>,
    /// wall directions (cos, sin of the outward normal angles)
    wall_u: Vec<[f64; 2]>,
    /// wall lines at the container variable wall_t, with sn_K(wall_t) and cs_K(wall_t)
    walls: Vec<[f64; 3]>,
    wall_t: f64,
    wall_sn_t: f64,
    wall_cs_t: f64,
    // ---- scratch
    pairs: Vec<(u32, u32)>,
    cell_of: Vec<u32>,
    cell_start: Vec<u32>,
    cell_items: Vec<u32>,
    order: Vec<u32>,
    pub rows: Vec<Row>,
    /// pairs and points examined (a work count for the callers' polls)
    pub sweeps: u64,
}

impl Evaluator {
    pub fn new(space: &Space, p: usize) -> Evaluator {
        let k = space.k;
        let n = space.n as usize;
        let vloc = space.vertices.clone();
        let eloc0 = space.edges.iter().map(|e| e[0]).collect();
        let eloc_a = space.edges.iter().map(|e| [-k * e[0], e[1], e[2]]).collect();
        let gen_loc = vloc.iter().map(|v| generators(k, v)).collect();
        Evaluator {
            k,
            n,
            m: space.m as usize,
            p,
            r: space.piece.r,
            rho: space.piece.rho,
            area: space.piece.area,
            t_max: space.t_max,
            vloc,
            eloc0,
            eloc_a,
            gen_loc,
            gl: vec![[0.0; 9]; p],
            gb: vec![[0.0; 3]; p],
            il: vec![[0.0; 9]; p],
            ib: vec![[0.0; 3]; p],
            frame: vec![[0.0; 7]; p],
            jb: vec![[0.0; 9]; p],
            jb_stamp: vec![0; p],
            stamp: 1,
            verts: vec![[0.0; 3]; p * n],
            edges: vec![[0.0; 3]; p * n],
            wall_u: space
                .wall_angles
                .iter()
                .map(|&a| [libm::cos(a), libm::sin(a)])
                .collect(),
            walls: Vec::new(),
            wall_t: f64::NAN,
            wall_sn_t: f64::NAN,
            wall_cs_t: f64::NAN,
            pairs: Vec::new(),
            cell_of: vec![0; p],
            cell_start: Vec::new(),
            cell_items: vec![0; p],
            order: Vec::new(),
            rows: Vec::new(),
            sweeps: 0,
        }
    }

    /// Builds the state of every piece at the poses z (x0, y0, theta0, x1, ...).
    pub fn set_poses(&mut self, z: &[f64]) {
        let k = self.k;
        let n = self.n;
        self.stamp = self.stamp.wrapping_add(1).max(1);
        for i in 0..self.p {
            let (x, y, th) = (z[3 * i], z[3 * i + 1], z[3 * i + 2]);
            let d2 = x * x + y * y;
            let t = k * d2;
            let (s_, v_) = sv_pair(t);
            let (s, c) = libm::sincos(th);
            self.frame[i] = [x, y, t, s_, v_, c, s];
            // G = T(x, y) R(theta): R = [[1, 0, 0], [0, c, -s], [0, s, c]]
            let tm = transvection_of(k, x, y, d2, s_, v_);
            let a = &tm.l;
            let l = [
                a[0],
                a[1] * c + a[2] * s,
                -a[1] * s + a[2] * c,
                a[3],
                a[4] * c + a[5] * s,
                -a[4] * s + a[5] * c,
                a[6],
                a[7] * c + a[8] * s,
                -a[7] * s + a[8] * c,
            ];
            self.gl[i] = l;
            self.gb[i] = tm.b;
            if n == 0 {
                continue;
            }
            // G^-1 = R(-theta) T(-x, -y): R(-theta) = [[1, 0, 0], [0, c, s], [0, -s, c]]
            let ti = transvection_of(k, -x, -y, d2, s_, v_);
            let a = &ti.l;
            let li = [
                a[0],
                a[1],
                a[2],
                c * a[3] + s * a[6],
                c * a[4] + s * a[7],
                c * a[5] + s * a[8],
                -s * a[3] + c * a[6],
                -s * a[4] + c * a[7],
                -s * a[5] + c * a[8],
            ];
            let bi = [ti.b[0], c * ti.b[1] + s * ti.b[2], -s * ti.b[1] + c * ti.b[2]];
            self.il[i] = li;
            self.ib[i] = bi;
            let b = tm.b;
            for e in 0..n {
                let v = &self.vloc[e];
                self.verts[i * n + e] = [
                    l[0] * v[0] + l[1] * v[1] + l[2] * v[2] + b[0],
                    l[3] * v[0] + l[4] * v[1] + l[5] * v[2] + b[1],
                    l[6] * v[0] + l[7] * v[1] + l[8] * v[2] + b[2],
                ];
                // the edge line moved by G: n_w . v(p) = n_loc . v(G^-1 p), so with the affine form
                // a = (-K n0, n1, n2) of the standard edge, n_w0 = n0 + a . b_inv and
                // (n_w1, n_w2) = the last two components of L_inv^T a
                let al = &self.eloc_a[e];
                let w0 = self.eloc0[e] + al[0] * bi[0] + al[1] * bi[1] + al[2] * bi[2];
                let w1 = li[1] * al[0] + li[4] * al[1] + li[7] * al[2];
                let w2 = li[2] * al[0] + li[5] * al[1] + li[8] * al[2];
                self.edges[i * n + e] = [w0, w1, w2];
            }
        }
    }

    /// Body Jacobian of piece i: body velocity = Jb . (dx, dy, dtheta), with
    /// body translation = R(-theta) A dw, A = S I + K U w w^T, body rotation = dtheta - K V (x dy - y dx).
    fn jb(&mut self, i: usize) -> [f64; 9] {
        if self.jb_stamp[i] == self.stamp {
            return self.jb[i];
        }
        let k = self.k;
        let [x, y, t, s_, v_, c, s] = self.frame[i];
        let u = ufun(t);
        let a00 = s_ + k * u * x * x;
        let a01 = k * u * x * y;
        let a11 = s_ + k * u * y * y;
        let j = [
            c * a00 + s * a01,
            c * a01 + s * a11,
            0.0,
            -s * a00 + c * a01,
            -s * a01 + c * a11,
            0.0,
            k * v_ * y,
            -k * v_ * x,
            1.0,
        ];
        self.jb[i] = j;
        self.jb_stamp[i] = self.stamp;
        j
    }

    /// Candidate pairs (i < j) whose half squared chord is at most vs_K(reach). Pieces are binned in
    /// cells of a coordinate in which pieces within `reach` lie within one cell width: the
    /// exponential coordinates for K <= 0 (exp_O does not shrink distances without positive
    /// curvature), the lifted (x, y) for K > 0 (|dxy|^2 <= 2 vs).
    fn find_pairs(&mut self, z: &[f64], reach: f64) {
        let k = self.k;
        let p = self.p;
        self.pairs.clear();
        let vs_reach = if k > 0.0 && k.sqrt() * reach > 0.99 * PI {
            f64::INFINITY
        } else {
            vs_k(k, reach) * (1.0 + 1e-12)
        };
        if p < 24 || !vs_reach.is_finite() {
            for i in 0..p {
                for j in i + 1..p {
                    if pair_vs(k, &self.gb[i], &self.gb[j]) <= vs_reach {
                        self.pairs.push((i as u32, j as u32));
                    }
                }
            }
            self.sweeps += (p * p / 2) as u64;
            return;
        }
        let coord = |ev: &Evaluator, i: usize| -> (f64, f64) {
            if k > 0.0 {
                (ev.gb[i][1], ev.gb[i][2])
            } else {
                (z[3 * i], z[3 * i + 1])
            }
        };
        let mut h = if k > 0.0 {
            (2.0 * vs_reach).sqrt()
        } else {
            reach * (1.0 + 1e-12)
        };
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for i in 0..p {
            let (x, y) = coord(self, i);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) || !(h > 0.0) {
            // non-finite poses: all pairs (their values decide)
            for i in 0..p {
                for j in i + 1..p {
                    self.pairs.push((i as u32, j as u32));
                }
            }
            return;
        }
        // at most about 4 P cells
        let span = ((x1 - x0) * (y1 - y0)).max(0.0);
        if span / (h * h) > 4.0 * p as f64 {
            h = (span / (4.0 * p as f64)).sqrt();
        }
        let nx = ((x1 - x0) / h).floor() as usize + 1;
        let ny = ((y1 - y0) / h).floor() as usize + 1;
        let cells = nx * ny;
        self.cell_start.clear();
        self.cell_start.resize(cells + 1, 0);
        for i in 0..p {
            let (x, y) = coord(self, i);
            let cx = (((x - x0) / h).floor() as usize).min(nx - 1);
            let cy = (((y - y0) / h).floor() as usize).min(ny - 1);
            let c = cy * nx + cx;
            self.cell_of[i] = c as u32;
            self.cell_start[c + 1] += 1;
        }
        for c in 0..cells {
            self.cell_start[c + 1] += self.cell_start[c];
        }
        self.order.clear();
        self.order.extend_from_slice(&self.cell_start[..cells]);
        for i in 0..p {
            let c = self.cell_of[i] as usize;
            self.cell_items[self.order[c] as usize] = i as u32;
            self.order[c] += 1;
        }
        for i in 0..p {
            let c = self.cell_of[i] as usize;
            let (cx, cy) = (c % nx, c / nx);
            for dy in -1i64..=1 {
                let yy = cy as i64 + dy;
                if yy < 0 || yy >= ny as i64 {
                    continue;
                }
                for dx in -1i64..=1 {
                    let xx = cx as i64 + dx;
                    if xx < 0 || xx >= nx as i64 {
                        continue;
                    }
                    let cc = yy as usize * nx + xx as usize;
                    for q in self.cell_start[cc]..self.cell_start[cc + 1] {
                        let j = self.cell_items[q as usize] as usize;
                        if j <= i {
                            continue;
                        }
                        if pair_vs(k, &self.gb[i], &self.gb[j]) <= vs_reach {
                            self.pairs.push((i as u32, j as u32));
                        }
                    }
                }
            }
        }
        // the order of the rows decides ties in the linear programs: keep it independent of the grid
        self.pairs.sort_unstable();
        self.sweeps += p as u64 * 9;
    }

    /// The edge of piece a whose outward normal points nearest to the centre of piece b.
    #[inline]
    fn facing_edge(&self, a: usize, b: usize) -> usize {
        let n = self.n;
        let c = &self.gb[b];
        let li = &self.il[a];
        let bi = &self.ib[a];
        let qx = li[3] * c[0] + li[4] * c[1] + li[5] * c[2] + bi[1];
        let qy = li[6] * c[0] + li[7] * c[1] + li[8] * c[2] + bi[2];
        // edge e has outward normal angle pi/2 + pi/N + 2 pi e / N
        let phi = libm::atan2(qy, qx) - PI / 2.0 - PI / n as f64;
        let e = (phi * n as f64 / (2.0 * PI)).round() as i64;
        e.rem_euclid(n as i64) as usize
    }

    /// Separating-axis value of the polygon pair (a, b) with its witness, or None as soon as some
    /// axis has every vertex of the other piece at n . v >= y_exit. `y_sep` = sn_K(R + d), d the
    /// distance that y_exit stands for: a piece whose centre lies at least R + d beyond an edge
    /// line has all its vertices at least d beyond it.
    fn sat(&self, a: usize, b: usize, y_exit: f64, y_sep: f64) -> Option<Sat> {
        let k = self.k;
        let n = self.n;
        let mut best = f64::NEG_INFINITY;
        let mut w = Sat {
            y: best,
            owner: 0,
            edge: 0,
            vertex: 0,
        };
        let disk_test = n >= 5 && y_sep.is_finite();
        for pass in 0..2u8 {
            let (pp, qq) = if pass == 0 { (a, b) } else { (b, a) };
            let pe = &self.edges[pp * n..pp * n + n];
            let qv = &self.verts[qq * n..qq * n + n];
            let qc = &self.gb[qq];
            let e0 = if n > 6 { self.facing_edge(pp, qq) } else { 0 };
            for step in 0..n {
                // e0, e0 + 1, e0 - 1, e0 + 2, ...
                let off = step.div_ceil(2);
                let e = if step % 2 == 1 {
                    (e0 + off) % n
                } else {
                    (e0 + n - off) % n
                };
                let nn = &pe[e];
                if disk_test && line_value(k, nn, qc) >= y_sep {
                    return None;
                }
                let mut m = f64::INFINITY;
                let mut mk = 0;
                for (kk, v) in qv.iter().enumerate() {
                    let val = line_value(k, nn, v);
                    if val < m {
                        m = val;
                        mk = kk;
                        if m <= best {
                            break;
                        }
                    }
                }
                if m > best {
                    best = m;
                    w = Sat {
                        y: m,
                        owner: pass,
                        edge: e,
                        vertex: mk,
                    };
                    if best >= y_exit {
                        return None;
                    }
                }
            }
        }
        w.y = best;
        Some(w)
    }

    /// Row for the signed distance of vertex `kv` of piece q from edge line `e` of piece p,
    /// stored with i < j. The derivative with respect to p's body velocity is minus that of moving
    /// the point by the same spatial generator.
    fn vertex_edge_row(&mut self, p: usize, e: usize, q: usize, kv: usize, grad: bool) -> Row {
        let k = self.k;
        let n = self.n;
        let nw = self.edges[p * n + e];
        let w = self.verts[q * n + kv];
        let y = line_value(k, &nw, &w);
        let value = asn_k(k, y);
        let mut row = Row {
            i: p as u32,
            j: q as u32,
            value,
            ..Row::default()
        };
        if grad {
            let dval = 1.0 / (1.0 - k * y * y).max(1e-300).sqrt();
            let nt = [-k * nw[0], nw[1], nw[2]];
            // Q: d/d(body a) of n . (G_Q v_k) = (L_Q^T n~) . gen_a(v_k)
            let mq = lt_mul(&self.gl[q], &nt);
            let gq = &self.gen_loc[kv];
            let body_q = [
                dval * dot3(&mq, &gq[0]),
                dval * dot3(&mq, &gq[1]),
                dval * dot3(&mq, &gq[2]),
            ];
            // P: L_P^T n~ is the standard edge's affine form; the point in P's frame is G_P^-1 w
            let li = &self.il[p];
            let bi = &self.ib[p];
            let wp = [
                li[0] * w[0] + li[1] * w[1] + li[2] * w[2] + bi[0],
                li[3] * w[0] + li[4] * w[1] + li[5] * w[2] + bi[1],
                li[6] * w[0] + li[7] * w[1] + li[8] * w[2] + bi[2],
            ];
            let mp = self.eloc_a[e];
            let gp = generators(k, &wp);
            let body_p = [
                -dval * dot3(&mp, &gp[0]),
                -dval * dot3(&mp, &gp[1]),
                -dval * dot3(&mp, &gp[2]),
            ];
            let jp = self.jb(p);
            let jq = self.jb(q);
            row.gi = to_pose(&jp, &body_p);
            row.gj = to_pose(&jq, &body_q);
        }
        if p > q {
            row.i = q as u32;
            row.j = p as u32;
            std::mem::swap(&mut row.gi, &mut row.gj);
        }
        row
    }

    /// Disk pair row: distance(c_i, c_j) - 2 R.
    fn disk_pair_row(&mut self, a: usize, b: usize, vs: f64, grad: bool) -> Row {
        let k = self.k;
        let d = dist_from_vs(k, vs);
        let mut row = Row {
            i: a as u32,
            j: b as u32,
            value: d - 2.0 * self.r,
            ..Row::default()
        };
        if grad {
            let sn = sn_k(k, d);
            let inv = if sn > 1e-300 { 1.0 / sn } else { 0.0 };
            let (ca, cb) = (self.gb[a], self.gb[b]);
            let dx = ca[1] - cb[1];
            let dy = ca[2] - cb[2];
            let de = ca[0] - cb[0];
            let (la, lb) = (&self.gl[a], &self.gl[b]);
            // L gen_a(O) as (e, x, y): the columns 1 and 2 of L
            let ta0 = [la[1], la[4], la[7]];
            let ta1 = [la[2], la[5], la[8]];
            let tb0 = [lb[1], lb[4], lb[7]];
            let tb1 = [lb[2], lb[5], lb[8]];
            let body_a = [
                (dx * ta0[1] + dy * ta0[2] + k * de * ta0[0]) * inv,
                (dx * ta1[1] + dy * ta1[2] + k * de * ta1[0]) * inv,
                0.0,
            ];
            let body_b = [
                -(dx * tb0[1] + dy * tb0[2] + k * de * tb0[0]) * inv,
                -(dx * tb1[1] + dy * tb1[2] + k * de * tb1[0]) * inv,
                0.0,
            ];
            let ja = self.jb(a);
            let jbb = self.jb(b);
            row.gi = to_pose(&ja, &body_a);
            row.gj = to_pose(&jbb, &body_b);
        }
        row
    }

    /// Wall row for vertex kv of piece i (its centre when kv is None) against wall w at t.
    fn wall_row(&mut self, i: usize, kv: Option<usize>, w: usize, t: f64, grad: bool) -> Row {
        let k = self.k;
        let nw = self.walls[w];
        let p = match kv {
            Some(v) => self.verts[i * self.n + v],
            None => self.gb[i],
        };
        let y = line_value(k, &nw, &p);
        let sd = asn_k(k, y);
        let mut row = Row {
            i: i as u32,
            j: NONE,
            value: -sd - if kv.is_some() { 0.0 } else { self.r },
            ..Row::default()
        };
        if grad {
            let dval = 1.0 / (1.0 - k * y * y).max(1e-300).sqrt();
            let nt = [-k * nw[0], nw[1], nw[2]];
            let ms = lt_mul(&self.gl[i], &nt);
            let body = match kv {
                Some(v) => {
                    let g = &self.gen_loc[v];
                    [
                        -dval * dot3(&ms, &g[0]),
                        -dval * dot3(&ms, &g[1]),
                        -dval * dot3(&ms, &g[2]),
                    ]
                }
                // generators at O: (0, 1, 0), (0, 0, 1), 0
                None => [-dval * ms[1], -dval * ms[2], 0.0],
            };
            let j = self.jb(i);
            row.gi = to_pose(&j, &body);
            // d(n . v)/dt with n = (-sn(t), cs(t) u): -cs(t) v0 - K sn(t) (u . v_vec)
            debug_assert_eq!(self.wall_t, t);
            let [u0, u1] = self.wall_u[w];
            let dndt = -self.wall_cs_t * (1.0 - k * p[0]) - k * self.wall_sn_t * (u0 * p[1] + u1 * p[2]);
            row.gt = -dval * dndt;
        }
        row
    }

    /// Rim row for a disk container of radius t: t - d(O, p), minus R for a disk centre.
    fn rim_row(&mut self, i: usize, kv: Option<usize>, t: f64, grad: bool) -> Row {
        let k = self.k;
        let p = match kv {
            Some(v) => self.verts[i * self.n + v],
            None => self.gb[i],
        };
        let d = dist_from_vs(k, p[0]);
        let mut row = Row {
            i: i as u32,
            j: NONE,
            value: t - d - if kv.is_some() { 0.0 } else { self.r },
            gt: 1.0,
            ..Row::default()
        };
        if grad {
            let sn = sn_k(k, d);
            let inv = if sn > 1e-300 { 1.0 / sn } else { 0.0 };
            let l = &self.gl[i];
            let row0 = [l[0], l[1], l[2]];
            let body = match kv {
                Some(v) => {
                    let g = &self.gen_loc[v];
                    [
                        -dot3(&row0, &g[0]) * inv,
                        -dot3(&row0, &g[1]) * inv,
                        -dot3(&row0, &g[2]) * inv,
                    ]
                }
                None => [-row0[1] * inv, -row0[2] * inv, 0.0],
            };
            let j = self.jb(i);
            row.gi = to_pose(&j, &body);
        }
        row
    }

    /// The rows of the configuration at container variable t whose value is below `below`, into
    /// self.rows (collectRows). Pair rows: one per pair at its separating-axis witness
    /// (`vertices` false), or every vertex of the other piece below the threshold against the
    /// witness edge (`vertices` true). Container rows per point. Poses must be set.
    pub fn gather(&mut self, z: &[f64], t: f64, below: f64, vertices: bool, grad: bool) {
        let k = self.k;
        let n = self.n;
        let r = self.r;
        self.rows.clear();
        let reach = 2.0 * r + below.max(0.0);
        self.find_pairs(z, reach);
        let y_below = sn_threshold(k, below);
        let y_sep = sn_threshold(k, r + below);
        let vs_row = if k > 0.0 && k.sqrt() * (2.0 * r + below) > 0.99 * PI {
            f64::INFINITY
        } else {
            vs_k(k, 2.0 * r + below)
        };
        let pairs = std::mem::take(&mut self.pairs);
        for &(a, b) in &pairs {
            let (a, b) = (a as usize, b as usize);
            if n == 0 {
                let vs = pair_vs(k, &self.gb[a], &self.gb[b]);
                // d - 2R < below
                if vs < vs_row * (1.0 + 1e-12) {
                    let row = self.disk_pair_row(a, b, vs, grad);
                    if row.value < below {
                        self.rows.push(row);
                    }
                }
                continue;
            }
            let Some(s) = self.sat(a, b, y_below, y_sep) else {
                continue;
            };
            let (pp, qq) = if s.owner == 0 { (a, b) } else { (b, a) };
            if !vertices {
                let row = self.vertex_edge_row(pp, s.edge, qq, s.vertex, grad);
                self.rows.push(row);
            } else {
                let nw = self.edges[pp * n + s.edge];
                for kv in 0..n {
                    let y = line_value(k, &nw, &self.verts[qq * n + kv]);
                    if y < y_below {
                        let row = self.vertex_edge_row(pp, s.edge, qq, kv, grad);
                        self.rows.push(row);
                    }
                }
            }
        }
        self.sweeps += pairs.len() as u64;
        self.pairs = pairs;
        self.gather_container(t, below, grad);
    }

    fn gather_container(&mut self, t: f64, below: f64, grad: bool) {
        let k = self.k;
        let n = self.n;
        let r = self.r;
        let p = self.p;
        // a piece within distance t - R - below of O lies in the container's inscribed disk with
        // clearance below at least: its centre's e at most vs_K(t - R - below)
        let inner = t - r - below;
        let e_inner = if inner > 0.0 { vs_k(k, inner) } else { f64::NEG_INFINITY };
        self.sweeps += p as u64;
        if self.m == 0 {
            // rim: a point at distance d from O has gap t - d (less R for a disk centre)
            let lim_point = t - below;
            let e_point = if lim_point > 0.0 {
                vs_k(k, lim_point)
            } else {
                f64::NEG_INFINITY
            };
            for i in 0..p {
                let c = self.gb[i];
                if c[0] <= e_inner {
                    continue;
                }
                if n == 0 {
                    let row = self.rim_row(i, None, t, grad);
                    if row.value < below {
                        self.rows.push(row);
                    }
                    continue;
                }
                for v in 0..n {
                    if self.verts[i * n + v][0] > e_point {
                        let row = self.rim_row(i, Some(v), t, grad);
                        if row.value < below {
                            self.rows.push(row);
                        }
                    }
                }
            }
            return;
        }
        if self.wall_t != t || self.walls.len() != self.m {
            // the wall lines (line_covector) at t, from the directions computed once
            self.wall_t = t;
            self.wall_sn_t = sn_k(k, t);
            self.wall_cs_t = cs_k(k, t);
            self.walls.clear();
            for &[u0, u1] in &self.wall_u {
                self.walls
                    .push([-self.wall_sn_t, self.wall_cs_t * u0, self.wall_cs_t * u1]);
            }
        }
        let y_point = -sn_threshold(k, below);
        let y_piece = -sn_threshold(k, r + below);
        for i in 0..p {
            let c = self.gb[i];
            if c[0] <= e_inner {
                continue;
            }
            for w in 0..self.m {
                let yc = line_value(k, &self.walls[w], &c);
                if n == 0 {
                    // -asn(yc) - R < below
                    if yc > y_piece {
                        let row = self.wall_row(i, None, w, t, grad);
                        if row.value < below {
                            self.rows.push(row);
                        }
                    }
                    continue;
                }
                if yc <= y_piece {
                    continue;
                }
                for v in 0..n {
                    let y = line_value(k, &self.walls[w], &self.verts[i * n + v]);
                    if y > y_point {
                        let row = self.wall_row(i, Some(v), w, t, grad);
                        if row.value < below {
                            self.rows.push(row);
                        }
                    }
                }
            }
        }
    }

    /// Penalty energy sum(min(0, gap - margin)^2) over all constraints, with its gradient in z (t fixed).
    pub fn energy(&mut self, z: &[f64], t: f64, margin: f64, grad: &mut [f64]) -> f64 {
        self.set_poses(z);
        self.gather(z, t, margin, false, true);
        grad.fill(0.0);
        let mut e = 0.0;
        for r in &self.rows {
            let v = r.value - margin;
            if v >= 0.0 {
                continue;
            }
            e += v * v;
            let f = 2.0 * v;
            let i = r.i as usize;
            for a in 0..3 {
                grad[3 * i + a] += f * r.gi[a];
            }
            if r.j != NONE {
                let j = r.j as usize;
                for a in 0..3 {
                    grad[3 * j + a] += f * r.gj[a];
                }
            }
        }
        e
    }

    /// Sum of violations below the margin, row by row as in the linear model (every vertex of the
    /// other piece against the separating axis; container rows per point). Poses must be set.
    pub fn violation(&mut self, z: &[f64], t: f64, margin: f64) -> f64 {
        self.gather(z, t, margin, true, false);
        let mut v = 0.0;
        for r in &self.rows {
            if r.value < margin {
                v += margin - r.value;
            }
        }
        v
    }

    /// Worst gap less the margin over the rows within margin + 1e-3 (0 when there are none), as
    /// the reference's polish reports its feasibility. Poses must be set.
    pub fn feasibility(&mut self, z: &[f64], t: f64, margin: f64) -> f64 {
        self.gather(z, t, margin + 1e-3, false, false);
        let mut worst = f64::INFINITY;
        for r in &self.rows {
            worst = worst.min(r.value - margin);
        }
        if worst.is_finite() {
            worst
        } else {
            0.0
        }
    }

    /// Smallest container variable t (apothem or radius) that contains every piece at the fixed
    /// centre O and orientation (requiredT over the pieces). For a wall direction u write a point
    /// as v = (c0, X = u . v_vec, ...) and A = sqrt(c0^2 + K X^2), a = ang_K(X, c0); then
    /// n(t) . v = A sn_K(a - t), so a vertex needs t >= a and a disk centre t >= a + asn_K(sn_K(R) / A).
    /// Only the walls whose normals lie nearest to a point's direction can bind (a grows with X),
    /// and a piece whose farthest point from O is closer than the t found so far cannot raise it.
    /// Poses must be set.
    pub fn required_t(&mut self) -> f64 {
        let k = self.k;
        let n = self.n;
        let m = self.m;
        let r = self.r;
        let p = self.p;
        // pieces by decreasing distance of the centre from O
        self.order.clear();
        self.order.extend(0..p as u32);
        let gb = &self.gb;
        self.order
            .sort_unstable_by(|&a, &b| gb[b as usize][0].total_cmp(&gb[a as usize][0]).then(a.cmp(&b)));
        let s1 = sn_k(k, r);
        let mut t = f64::NEG_INFINITY;
        for idx in 0..p {
            let i = self.order[idx] as usize;
            let c = self.gb[i];
            let dc = dist_from_vs(k, c[0]);
            // every point of the piece lies within dc + R of O, and a point at distance d needs at most d
            // (inside the open hemisphere when K > 0; beyond it the apothem of a point is not monotone)
            if dc + r <= t && (k <= 0.0 || (dc + r) * k.sqrt() < PI / 2.0) {
                break;
            }
            let pts: &[[f64; 3]] = if n == 0 {
                std::slice::from_ref(&self.gb[i])
            } else {
                &self.verts[i * n..i * n + n]
            };
            for pt in pts {
                if m == 0 {
                    t = t.max(dist_from_vs(k, pt[0]) + if n == 0 { r } else { 0.0 });
                    continue;
                }
                let c0 = 1.0 - k * pt[0];
                // wall angles -pi/2 + 2 pi w / M: the nearest to the point's direction, and its
                // neighbours; every wall for a point beyond the hemisphere (c0 <= 0), where a no
                // longer grows with X
                let phi = libm::atan2(pt[2], pt[1]);
                let w0 = ((phi + PI / 2.0) * m as f64 / (2.0 * PI)).round() as i64;
                let (lo, hi) = if c0 > 0.0 && m > 3 {
                    (-1i64, 1i64)
                } else {
                    (0, m as i64 - 1)
                };
                for dw in lo..=hi {
                    let w = (w0 + dw).rem_euclid(m as i64) as usize;
                    let [u0, u1] = self.wall_u[w];
                    let x = u0 * pt[1] + u1 * pt[2];
                    let a = ang_k(k, x, c0);
                    if n == 0 {
                        let aa = (c0 * c0 + k * x * x).max(0.0).sqrt();
                        t = t.max(a + asn_k(k, s1 / aa));
                    } else {
                        t = t.max(a);
                    }
                }
            }
        }
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{apply_point, covector_norm2, line_through, pose_motion};

    fn space(k: f64, n: u32, m: u32) -> Space {
        Space::new(k, n, m).unwrap()
    }

    #[test]
    fn edges_match_lines_through_vertices() {
        for &k in &[-1.0, 0.0, 0.7] {
            let sp = space(k, 5, 4);
            let mut ev = Evaluator::new(&sp, 1);
            let z = [0.3, -0.2, 1.1];
            ev.set_poses(&z);
            let g = pose_motion(k, z[0], z[1], z[2]);
            for e in 0..5 {
                let a = apply_point(&g, &sp.vertices[e]);
                let b = apply_point(&g, &sp.vertices[(e + 1) % 5]);
                let nn = line_through(k, &b, &a);
                let q = covector_norm2(k, &nn).sqrt();
                for c in 0..3 {
                    assert!((ev.edges[e][c] - nn[c] / q).abs() < 1e-14, "K={k}");
                    assert!((ev.verts[e][c] - a[c]).abs() < 1e-15);
                }
            }
        }
    }

    /// Finite-difference check of every row kind's gradient.
    #[test]
    fn gradients_match_finite_differences() {
        for &(k, n, m) in &[
            (-1.0, 3u32, 6u32),
            (0.0, 4, 0),
            (0.6, 0, 4),
            (-0.3, 0, 0),
            (0.2, 5, 0),
            (-0.5, 6, 5),
        ] {
            let sp = space(k, n, m);
            let p = 3;
            let mut ev = Evaluator::new(&sp, p);
            let z = vec![0.1, 0.2, 0.3, 0.7, 0.35, 1.2, -0.2, 0.6, 2.0];
            let t = 0.9;
            ev.set_poses(&z);
            ev.gather(&z, t, 0.6, true, true);
            let rows = ev.rows.clone();
            assert!(!rows.is_empty());
            let h = 1e-6;
            for (ri, row) in rows.iter().enumerate() {
                for (piece, g) in [(row.i, row.gi), (row.j, row.gj)] {
                    if piece == NONE {
                        continue;
                    }
                    for a in 0..3 {
                        let mut zp = z.clone();
                        zp[3 * piece as usize + a] += h;
                        let mut zm = z.clone();
                        zm[3 * piece as usize + a] -= h;
                        let vp = row_value(&mut ev, &zp, t, &rows[ri], &rows);
                        let vm = row_value(&mut ev, &zm, t, &rows[ri], &rows);
                        let fd = (vp - vm) / (2.0 * h);
                        assert!(
                            (fd - g[a]).abs() < 1e-6 * (1.0 + fd.abs()),
                            "K={k} N={n} M={m} row {ri} piece {piece} a {a}: {fd} vs {}",
                            g[a]
                        );
                    }
                }
                let vp = row_value(&mut ev, &z, t + h, &rows[ri], &rows);
                let vm = row_value(&mut ev, &z, t - h, &rows[ri], &rows);
                let fd = (vp - vm) / (2.0 * h);
                assert!(
                    (fd - row.gt).abs() < 1e-6 * (1.0 + fd.abs()),
                    "K={k} N={n} M={m} row {ri} dt: {fd} vs {}",
                    row.gt
                );
            }
        }
    }

    /// required_t looks at the nearest walls only and stops at pieces that cannot raise t: it must
    /// equal the reference's maximum over every point and every wall.
    #[test]
    fn required_t_matches_every_wall() {
        let mut rng = crate::rng::Rng::new(5);
        for &(k, n, m) in &[
            (-1.0, 3u32, 6u32),
            (0.3, 0, 5),
            (0.0, 4, 3),
            (-0.2, 0, 8),
            (1.0, 3, 4),
            (-0.01, 7, 0),
        ] {
            let sp = space(k, n, m);
            let p = 9;
            let mut ev = Evaluator::new(&sp, p);
            for _ in 0..50 {
                let z: Vec<f64> = (0..3 * p).map(|_| (rng.next_f64() - 0.5) * 2.0).collect();
                ev.set_poses(&z);
                let fast = ev.required_t();
                let mut full = f64::NEG_INFINITY;
                let s1 = sn_k(k, ev.r);
                for i in 0..p {
                    let pts: Vec<[f64; 3]> = if n == 0 {
                        vec![ev.gb[i]]
                    } else {
                        ev.verts[i * ev.n..(i + 1) * ev.n].to_vec()
                    };
                    for pt in pts {
                        if m == 0 {
                            full = full.max(dist_from_vs(k, pt[0]) + if n == 0 { ev.r } else { 0.0 });
                            continue;
                        }
                        let c0 = 1.0 - k * pt[0];
                        for (w, &ang) in sp.wall_angles.iter().enumerate() {
                            let x = libm::cos(ang) * pt[1] + libm::sin(ang) * pt[2];
                            let a = ang_k(k, x, c0);
                            let v = if n == 0 {
                                a + asn_k(k, s1 / (c0 * c0 + k * x * x).max(0.0).sqrt())
                            } else {
                                a
                            };
                            assert!(v.is_finite() || w > m as usize);
                            full = full.max(v);
                        }
                    }
                }
                assert!(
                    (fast - full).abs() <= 1e-14 * full.abs().max(1.0),
                    "K={k} N={n} M={m}: {fast} vs {full}"
                );
            }
        }
    }

    /// The value of the same row (same pieces, kind and witness) at other poses: re-gathered and
    /// matched by its index among rows of the same pieces (the witnesses do not change for small steps).
    fn row_value(ev: &mut Evaluator, z: &[f64], t: f64, row: &Row, all: &[Row]) -> f64 {
        let index = all.iter().position(|r| std::ptr::eq(r, row)).unwrap();
        ev.set_poses(z);
        ev.gather(z, t, 0.6, true, false);
        assert_eq!(ev.rows.len(), all.len());
        let r = ev.rows[index];
        assert_eq!((r.i, r.j), (row.i, row.j));
        r.value
    }
}
