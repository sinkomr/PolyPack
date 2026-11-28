//! The penalty energy of an arrangement at a fixed container size, with its exact gradient.
//!
//! Variables (one flat vector x): per piece i its centre c_i (3) and quaternion q_i (4), at x[7i..7i+7]; then per
//! listed pair k = (i, j) a separating plane: a direction w_k (3; the unit normal is u = w / |w|) and an offset
//! e_k, at x[7P + 4k..7P + 4k + 4]. The plane is {y : u . (y - m) = e} with m = (c_i + c_j) / 2, so that it
//! moves with the pair. Piece i should lie on its negative side and piece j on its positive side.
//!
//!     E = sum_pairs [ sum_{a in i} max(0, u . (X_a - m) - e)^2 + sum_{b in j} max(0, e - u . (X_b - m))^2 ]
//!       + sum_i sum_{vertices X of i} sum_g max(0, N_g . X - s b_g)^2        (polyhedral container)
//!       + sum_i sum_{vertices X of i} max(0, |X| - s beta)^2                  (ball container)
//!
//! with X = c + R(q) v. E = 0 exactly when every listed pair is separated by its plane and every vertex is in the
//! container; then the pieces are disjoint (touching allowed) and contained. At a positive E, the overlap of a pair
//! along u is at most the sum of its deepest violations on both sides, an upper bound on its penetration depth.
//!
//! Gradient: each vertex term's derivative f = dE/dX gives the centre f and the torque (X - c) x f; the torque tau
//! of a piece is turned into the quaternion's gradient by dE/dq = 2 [-tau . q_v, w tau + tau x q_v] / |q|^2 (the
//! world-frame increment of q is (0, dw / 2) q; R depends on q / |q| only).
//!
//! Pairs: a pair is listed when its circumscribed balls (radius 1) come within the skin of each other and the
//! pieces are not already apart by the skin along the line of centres or along their former plane. Every point of
//! piece i has moved by at most m_i = |c_i - c_i0| + 2 |q_i - q_i0| (unit quaternions, sign chosen) since the
//! build, so the list stays exact (no unlisted pair can touch) while every m_i is below skin / 2; each evaluation
//! checks this and sets `stale` when it no longer holds. The minimiser then stops at its last good point and the list
//! is rebuilt (`rebuild`), the planes of the pairs that stay listed being kept.

use crate::model::{dot, r_mul, rot, rt_mul, Container, Piece};

/// The state of an arrangement: the variables and the pair list their planes belong to.
#[derive(Clone, Debug, Default)]
pub struct State {
    pub x: Vec<f64>,
    pub pairs: Vec<[u32; 2]>,
}

pub struct Energy {
    pub p: usize,
    nv: usize,
    vx: Vec<f64>,
    vy: Vec<f64>,
    vz: Vec<f64>,
    /// Half-extents of the piece about its centre along its own axes (max |v_x|, ...).
    hext: [f64; 3],
    // the piece's face normals (local), for plane initialisation
    nfp: usize,
    fx: Vec<f64>,
    fy: Vec<f64>,
    fz: Vec<f64>,
    ball: bool,
    beta: f64,
    nfc: usize,
    nx: Vec<f64>,
    ny: Vec<f64>,
    nz: Vec<f64>,
    b: Vec<f64>,
    /// The container size of the evaluations.
    pub s: f64,
    /// The pair list of the state being minimised (swapped in and out by the search).
    pub pairs: Vec<[u32; 2]>,
    rots: Vec<[f64; 9]>,
    inv_n2: Vec<f64>,
    tq: Vec<[f64; 3]>,
    gc: Vec<[f64; 3]>,
    ref_c: Vec<f64>,
    ref_q: Vec<f64>,
    pub skin: f64,
    /// Set by an evaluation at which some piece has moved more than skin / 2 since the last build.
    pub stale: bool,
    pub evals: u64,
    pub rebuilds: u64,
    /// Per-piece energy share of the last `per_piece` call.
    per: Vec<f64>,
    // scratch for rebuild
    new_pairs: Vec<[u32; 2]>,
    new_planes: Vec<f64>,
}

#[inline(always)]
fn side(vx: &[f64], vy: &[f64], vz: &[f64], ul: [f64; 3], c0: f64) -> (f64, f64, [f64; 3]) {
    // sum of max(0, c0 + ul . v)^2, sum of 2 max(0, .), sum of 2 max(0, .) v
    let mut e = 0.0;
    let mut s = 0.0;
    let mut a = 0.0;
    let mut b = 0.0;
    let mut c = 0.0;
    for ((x, y), z) in vx.iter().zip(vy).zip(vz) {
        let r = c0 + ul[0] * x + ul[1] * y + ul[2] * z;
        let rp = if r > 0.0 { r } else { 0.0 };
        e += rp * rp;
        s += rp;
        a += rp * x;
        b += rp * y;
        c += rp * z;
    }
    (e, 2.0 * s, [2.0 * a, 2.0 * b, 2.0 * c])
}

#[inline(always)]
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

impl Energy {
    pub fn new(piece: &Piece, cont: &Container, p: usize) -> Energy {
        let mut hext = [0.0f64; 3];
        for k in 0..piece.nv {
            hext[0] = hext[0].max(piece.vx[k].abs());
            hext[1] = hext[1].max(piece.vy[k].abs());
            hext[2] = hext[2].max(piece.vz[k].abs());
        }
        Energy {
            p,
            nv: piece.nv,
            vx: piece.vx.clone(),
            vy: piece.vy.clone(),
            vz: piece.vz.clone(),
            hext,
            nfp: piece.nf,
            fx: piece.fx.clone(),
            fy: piece.fy.clone(),
            fz: piece.fz.clone(),
            ball: cont.ball,
            beta: cont.beta,
            nfc: cont.nf,
            nx: cont.nx.clone(),
            ny: cont.ny.clone(),
            nz: cont.nz.clone(),
            b: cont.b.clone(),
            s: 1.0,
            pairs: Vec::new(),
            rots: vec![[0.0; 9]; p],
            inv_n2: vec![0.0; p],
            tq: vec![[0.0; 3]; p],
            gc: vec![[0.0; 3]; p],
            ref_c: vec![0.0; 3 * p],
            ref_q: vec![0.0; 4 * p],
            skin: 0.5,
            stale: false,
            evals: 0,
            rebuilds: 0,
            per: vec![0.0; p],
            new_pairs: Vec::new(),
            new_planes: Vec::new(),
        }
    }

    /// Number of variables of a state with `npairs` listed pairs.
    #[inline]
    pub fn dim(&self, npairs: usize) -> usize {
        7 * self.p + 4 * npairs
    }

    /// An upper bound of the support of the piece in the local direction ul: min(|ul|, sum |ul_k| h_k).
    #[inline(always)]
    fn reach(&self, ul: [f64; 3]) -> f64 {
        let h = ul[0].abs() * self.hext[0] + ul[1].abs() * self.hext[1] + ul[2].abs() * self.hext[2];
        if h < 1.0 {
            h
        } else {
            1.0
        }
    }

    /// E and its gradient at x (the pair list `self.pairs`).
    pub fn eval(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        self.eval_impl::<false>(x, g)
    }

    /// Each piece's share of E at x: its container terms and its side of each pair's terms (into `out`).
    pub fn per_piece(&mut self, x: &[f64], out: &mut [f64]) {
        let mut g = vec![0.0; x.len()];
        self.eval_impl::<true>(x, &mut g);
        out[..self.p].copy_from_slice(&self.per);
        self.evals -= 1;
    }

    fn eval_impl<const PER: bool>(&mut self, x: &[f64], g: &mut [f64]) -> f64 {
        self.evals += 1;
        let p = self.p;
        let half = 0.5 * self.skin;
        let mut moved = 0.0f64;
        for i in 0..p {
            let q = &x[7 * i + 3..7 * i + 7];
            let n2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
            self.inv_n2[i] = 1.0 / n2;
            self.rots[i] = rot(q);
            let dx = x[7 * i] - self.ref_c[3 * i];
            let dy = x[7 * i + 1] - self.ref_c[3 * i + 1];
            let dz = x[7 * i + 2] - self.ref_c[3 * i + 2];
            let qn = 1.0 / n2.sqrt();
            let rq = &self.ref_q[4 * i..4 * i + 4];
            let sg = if q[0] * rq[0] + q[1] * rq[1] + q[2] * rq[2] + q[3] * rq[3] >= 0.0 { qn } else { -qn };
            let mut dq2 = 0.0;
            for k in 0..4 {
                let d = q[k] * sg - rq[k];
                dq2 += d * d;
            }
            let m = (dx * dx + dy * dy + dz * dz).sqrt() + 2.0 * dq2.sqrt();
            moved = moved.max(m);
            self.gc[i] = [0.0; 3];
            self.tq[i] = [0.0; 3];
            if PER {
                self.per[i] = 0.0;
            }
        }
        self.stale = moved > half;
        let mut energy = 0.0;
        let base = 7 * p;
        let (vx, vy, vz) = (&self.vx[..], &self.vy[..], &self.vz[..]);
        // pairs
        for (k, pr) in self.pairs.iter().enumerate() {
            let i = pr[0] as usize;
            let j = pr[1] as usize;
            let o = base + 4 * k;
            let w = [x[o], x[o + 1], x[o + 2]];
            let e = x[o + 3];
            let wn = (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt();
            let u = [w[0] / wn, w[1] / wn, w[2] / wn];
            let ci = [x[7 * i], x[7 * i + 1], x[7 * i + 2]];
            let cj = [x[7 * j], x[7 * j + 1], x[7 * j + 2]];
            let dc = [cj[0] - ci[0], cj[1] - ci[1], cj[2] - ci[2]];
            let ud = dot(u, dc);
            // side of i: r_a = u . (c_i - m) - e + (R_i^T u) . v_a, with u . (c_i - m) = -ud / 2
            let ca = -0.5 * ud - e;
            // side of j: r_b = e - u . (c_j - m) - (R_j^T u) . v_b
            let cb = e - 0.5 * ud;
            if ca + 1.0 <= 0.0 && cb + 1.0 <= 0.0 {
                g[o] = 0.0;
                g[o + 1] = 0.0;
                g[o + 2] = 0.0;
                g[o + 3] = 0.0;
                continue;
            }
            let (mut ea, mut sa, mut sva) = (0.0, 0.0, [0.0; 3]);
            let (mut eb, mut sb, mut svb) = (0.0, 0.0, [0.0; 3]);
            if ca + 1.0 > 0.0 {
                let ul = rt_mul(&self.rots[i], u);
                if ca + self.reach(ul) > 0.0 {
                    (ea, sa, sva) = side(vx, vy, vz, ul, ca);
                }
            }
            if cb + 1.0 > 0.0 {
                let ul = rt_mul(&self.rots[j], u);
                if cb + self.reach(ul) > 0.0 {
                    (eb, sb, svb) = side(vx, vy, vz, [-ul[0], -ul[1], -ul[2]], cb);
                }
            }
            if sa == 0.0 && sb == 0.0 {
                g[o] = 0.0;
                g[o + 1] = 0.0;
                g[o + 2] = 0.0;
                g[o + 3] = 0.0;
                continue;
            }
            energy += ea + eb;
            if PER {
                self.per[i] += ea;
                self.per[j] += eb;
            }
            // dE/dc_i = (SA + SB) u / 2 = -dE/dc_j
            let st = 0.5 * (sa + sb);
            // world lever sums R SV; torques (R SVA) x u on i and -(R SVB) x u on j
            let ra = r_mul(&self.rots[i], sva);
            let rb = r_mul(&self.rots[j], svb);
            let ta = cross(ra, u);
            let tb = cross(rb, u);
            for d in 0..3 {
                self.gc[i][d] += st * u[d];
                self.gc[j][d] -= st * u[d];
                self.tq[i][d] += ta[d];
                self.tq[j][d] -= tb[d];
            }
            // dE/du = -(SA + SB) dc / 2 + R_i SVA - R_j SVB
            let gu = [-st * dc[0] + ra[0] - rb[0], -st * dc[1] + ra[1] - rb[1], -st * dc[2] + ra[2] - rb[2]];
            let gdu = dot(gu, u);
            g[o] = (gu[0] - u[0] * gdu) / wn;
            g[o + 1] = (gu[1] - u[1] * gdu) / wn;
            g[o + 2] = (gu[2] - u[2] * gdu) / wn;
            g[o + 3] = sb - sa;
        }
        // container
        let s = self.s;
        if self.ball {
            let rb = s * self.beta;
            for i in 0..p {
                let c = [x[7 * i], x[7 * i + 1], x[7 * i + 2]];
                let cn = dot(c, c).sqrt();
                if cn + 1.0 <= rb {
                    continue;
                }
                let r = &self.rots[i];
                let mut ei = 0.0;
                let mut gcs = [0.0; 3];
                let mut tqs = [0.0; 3];
                for k in 0..self.nv {
                    let w = r_mul(r, [vx[k], vy[k], vz[k]]);
                    let xx = [c[0] + w[0], c[1] + w[1], c[2] + w[2]];
                    let n = dot(xx, xx).sqrt();
                    let d = n - rb;
                    if d > 0.0 {
                        ei += d * d;
                        let f = 2.0 * d / n;
                        let gx = [f * xx[0], f * xx[1], f * xx[2]];
                        let t = cross(w, gx);
                        for a in 0..3 {
                            gcs[a] += gx[a];
                            tqs[a] += t[a];
                        }
                    }
                }
                energy += ei;
                if PER {
                    self.per[i] += ei;
                }
                for a in 0..3 {
                    self.gc[i][a] += gcs[a];
                    self.tq[i][a] += tqs[a];
                }
            }
        } else {
            for i in 0..p {
                let c = [x[7 * i], x[7 * i + 1], x[7 * i + 2]];
                for gf in 0..self.nfc {
                    let n = [self.nx[gf], self.ny[gf], self.nz[gf]];
                    let c0 = dot(n, c) - s * self.b[gf];
                    if c0 + 1.0 <= 0.0 {
                        continue;
                    }
                    let ul = rt_mul(&self.rots[i], n);
                    if c0 + self.reach(ul) <= 0.0 {
                        continue;
                    }
                    let (ei, si, svi) = side(vx, vy, vz, ul, c0);
                    if si == 0.0 {
                        continue;
                    }
                    energy += ei;
                    if PER {
                        self.per[i] += ei;
                    }
                    let rv = r_mul(&self.rots[i], svi);
                    let t = cross(rv, n);
                    for a in 0..3 {
                        self.gc[i][a] += si * n[a];
                        self.tq[i][a] += t[a];
                    }
                }
            }
        }
        // the quaternions' gradients from the torques
        for i in 0..p {
            let t = self.tq[i];
            let q = &x[7 * i + 3..7 * i + 7];
            let (w, qv) = (q[0], [q[1], q[2], q[3]]);
            let k = 2.0 * self.inv_n2[i];
            let tx = cross(t, qv);
            g[7 * i] = self.gc[i][0];
            g[7 * i + 1] = self.gc[i][1];
            g[7 * i + 2] = self.gc[i][2];
            g[7 * i + 3] = -k * dot(t, qv);
            g[7 * i + 4] = k * (w * t[0] + tx[0]);
            g[7 * i + 5] = k * (w * t[1] + tx[1]);
            g[7 * i + 6] = k * (w * t[2] + tx[2]);
        }
        energy
    }

    /// The extent of piece i (centre c, rotation r) along the unit direction u: (min, max) of u . X.
    #[inline]
    fn extent(&self, c: [f64; 3], r: &[f64; 9], u: [f64; 3]) -> (f64, f64) {
        let ul = rt_mul(r, u);
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for k in 0..self.nv {
            let d = ul[0] * self.vx[k] + ul[1] * self.vy[k] + ul[2] * self.vz[k];
            lo = lo.min(d);
            hi = hi.max(d);
        }
        let uc = dot(u, c);
        (uc + lo, uc + hi)
    }

    /// The gap along u (from i to j): min over j - max over i of u . X, and both extremes.
    fn gap_along(&self, ci: [f64; 3], ri: &[f64; 9], cj: [f64; 3], rj: &[f64; 9], u: [f64; 3]) -> (f64, f64, f64) {
        let (_, hi_i) = self.extent(ci, ri, u);
        let (lo_j, _) = self.extent(cj, rj, u);
        (lo_j - hi_i, hi_i, lo_j)
    }

    /// A separating plane for the pair (i, j) of x: the best (largest gap) of the line of centres and the face
    /// normals of both pieces, and of `prev` if given; offset at the middle of the gap. Returns [w (unit), e].
    pub fn init_plane(&self, x: &[f64], i: usize, j: usize, prev: Option<[f64; 4]>) -> [f64; 4] {
        let ci = [x[7 * i], x[7 * i + 1], x[7 * i + 2]];
        let cj = [x[7 * j], x[7 * j + 1], x[7 * j + 2]];
        let dc = [cj[0] - ci[0], cj[1] - ci[1], cj[2] - ci[2]];
        let dn = dot(dc, dc).sqrt();
        let m = [0.5 * (ci[0] + cj[0]), 0.5 * (ci[1] + cj[1]), 0.5 * (ci[2] + cj[2])];
        if dn >= 2.0 {
            // the bisector separates the unit balls
            return [dc[0] / dn, dc[1] / dn, dc[2] / dn, 0.0];
        }
        let ri = rot(&x[7 * i + 3..7 * i + 7]);
        let rj = rot(&x[7 * j + 3..7 * j + 7]);
        let mut best_gap = f64::NEG_INFINITY;
        let mut best = [0.0, 0.0, 1.0, 0.0];
        let consider = |u: [f64; 3], best_gap: &mut f64, best: &mut [f64; 4]| {
            let (gap, hi_i, lo_j) = self.gap_along(ci, &ri, cj, &rj, u);
            if gap > *best_gap {
                *best_gap = gap;
                let e = 0.5 * (hi_i + lo_j) - dot(u, m);
                *best = [u[0], u[1], u[2], e];
            }
        };
        if let Some(pv) = prev {
            let n = (pv[0] * pv[0] + pv[1] * pv[1] + pv[2] * pv[2]).sqrt();
            if n > 0.0 {
                consider([pv[0] / n, pv[1] / n, pv[2] / n], &mut best_gap, &mut best);
            }
        }
        if dn > 1e-12 {
            consider([dc[0] / dn, dc[1] / dn, dc[2] / dn], &mut best_gap, &mut best);
        }
        for f in 0..self.nfp {
            let nl = [self.fx[f], self.fy[f], self.fz[f]];
            let ni = r_mul(&ri, nl);
            if dot(ni, dc) > 0.0 {
                consider(ni, &mut best_gap, &mut best);
            }
            let nj = r_mul(&rj, nl);
            if dot(nj, dc) < 0.0 {
                consider([-nj[0], -nj[1], -nj[2]], &mut best_gap, &mut best);
            }
        }
        if best_gap == f64::NEG_INFINITY {
            best = [0.0, 0.0, 1.0, 0.0];
        }
        best
    }

    /// Rebuilds the pair list of the state (see the module notes): a pair whose unit balls come within the skin is
    /// listed unless the pieces are apart by at least the skin along the line of centres or along their former
    /// plane. The planes of pairs that stay listed are kept (renormalised) unless one of the pair is flagged in
    /// `dirty`, in which case the better of the kept plane and a fresh one is taken; new pairs get a fresh plane.
    /// Quaternions are renormalised. The reference poses of the staleness test become the state's.
    pub fn rebuild(&mut self, st: &mut State, dirty: Option<&[bool]>) {
        self.rebuilds += 1;
        let p = self.p;
        let base = 7 * p;
        for i in 0..p {
            crate::model::qnormalize(&mut st.x[7 * i + 3..7 * i + 7]);
            self.ref_c[3 * i] = st.x[7 * i];
            self.ref_c[3 * i + 1] = st.x[7 * i + 1];
            self.ref_c[3 * i + 2] = st.x[7 * i + 2];
            self.ref_q[4 * i..4 * i + 4].copy_from_slice(&st.x[7 * i + 3..7 * i + 7]);
            self.rots[i] = rot(&st.x[7 * i + 3..7 * i + 7]);
        }
        let skin = self.skin;
        let reach = 2.0 + skin;
        let reach2 = reach * reach;
        self.new_pairs.clear();
        self.new_planes.clear();
        let mut old = 0usize;
        let nold = st.pairs.len();
        for i in 0..p {
            let ci = [st.x[7 * i], st.x[7 * i + 1], st.x[7 * i + 2]];
            for j in i + 1..p {
                let cj = [st.x[7 * j], st.x[7 * j + 1], st.x[7 * j + 2]];
                let dc = [cj[0] - ci[0], cj[1] - ci[1], cj[2] - ci[2]];
                let d2 = dot(dc, dc);
                if d2 >= reach2 {
                    continue;
                }
                let key = [i as u32, j as u32];
                while old < nold && st.pairs[old] < key {
                    old += 1;
                }
                let kept = if old < nold && st.pairs[old] == key {
                    let o = base + 4 * old;
                    Some([st.x[o], st.x[o + 1], st.x[o + 2], st.x[o + 3]])
                } else {
                    None
                };
                // apart by the skin along the line of centres or the former plane: not listed
                let dn = d2.sqrt();
                if dn > 1e-12 {
                    let u = [dc[0] / dn, dc[1] / dn, dc[2] / dn];
                    if self.gap_along(ci, &self.rots[i], cj, &self.rots[j], u).0 >= skin {
                        continue;
                    }
                }
                if let Some(pl) = kept {
                    let n = (pl[0] * pl[0] + pl[1] * pl[1] + pl[2] * pl[2]).sqrt();
                    if n > 1e-300 && n.is_finite() {
                        let u = [pl[0] / n, pl[1] / n, pl[2] / n];
                        if self.gap_along(ci, &self.rots[i], cj, &self.rots[j], u).0 >= skin {
                            continue;
                        }
                    }
                }
                let is_dirty = dirty.is_some_and(|d| d[i] || d[j]);
                let plane = match kept {
                    Some(pl) if !is_dirty && d2 < 4.0 => {
                        let n = (pl[0] * pl[0] + pl[1] * pl[1] + pl[2] * pl[2]).sqrt();
                        if n > 1e-300 && n.is_finite() {
                            [pl[0] / n, pl[1] / n, pl[2] / n, pl[3]]
                        } else {
                            self.init_plane(&st.x, i, j, None)
                        }
                    }
                    Some(pl) => self.init_plane(&st.x, i, j, Some(pl)),
                    None => self.init_plane(&st.x, i, j, None),
                };
                self.new_pairs.push(key);
                self.new_planes.extend_from_slice(&plane);
            }
        }
        std::mem::swap(&mut st.pairs, &mut self.new_pairs);
        st.x.truncate(base);
        st.x.extend_from_slice(&self.new_planes);
    }
}
