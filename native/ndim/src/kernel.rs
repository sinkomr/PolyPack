//! The nD in nD space's kernel for the generic search methods (packages/ndspace/src/kernel.ts,
//! docs/spaces/NDIM.md §11): P equal polytopes of the dimension's catalogue, or balls of diameter
//! 1, in the container scaled by s (a polytope, or the ball of diameter s), centred at the origin.
//!
//! State. A polytope piece i owns dim = d + d(d - 1)/2 numbers x[dim i ...]: its centre t (d
//! lengths, absolute: the container is centred at the origin) and a chart rotation, the Cayley
//! parameters k of a skew matrix S times the piece's circumradius Rc so that they read as lengths
//! (x = k Rc). The piece is turned by R = R0 C(S), C(S) = (I - S)^-1 (I + S), R0 its anchor, a
//! rotation matrix kept in aux; a step of x moves no vertex by much more than its size, to first
//! order. rebase folds C(S) into R0 (and re-orthonormalises it). A ball owns its centre only (dim =
//! d). size is s, the score; set_size scales the centres with the container and keeps the pieces'
//! size.
//!
//! Energy. For a pair, the overlap 2 r - sd, where sd is the signed separation of the two pieces'
//! cores (the polytope scaled by the shape parameter tau about its centre; minus the penetration
//! depth when they overlap: GJK and EPA of gjk.rs) and r = (1 - tau) rho the dilation, rho the
//! inradius, so that tau = 1 is the true piece and tau = 0 its inscribed ball. For a wall, the
//! largest protrusion of the core plus r beyond a facet of the container (N_f . x + r - s b_f), or
//! beyond the ball (|x| + r - s/2). Balls are their own inscribed balls. E is the weighted sum of
//! the squares of the positive overlaps, with the exact gradient: the envelope theorem at the
//! separating direction u (the support vertices of the two pieces carry the gradient) and, for a
//! vertex x = t + tau R0 C(S) v, d(u . x)/dk_ij = 2 (a_i b_j - a_j b_i) with a = (R0 (I - S)^-1)^T
//! u and b = tau (I - S)^-1 v (dC = 2 (I - S)^-1 dS (I - S)^-1). The model is exact at tau = 1 up
//! to EPA's depth, which never exceeds the true depth, so a configuration valid at tolerance 0 has
//! (almost) no energy.
//!
//! finish() is the legalisation by scaling: the centres and the container scale together by a
//! factor f >= 1 raise every pair gap (by at least 2 rho (f - 1)) and every wall gap (by at least
//! rho (f - 1)), so the valid factors form a ray [f*, inf) of the validator; finish() brackets and
//! bisects it with the validator at tolerance 0 and returns the smallest valid factor to 1e-12.
//! seeds() are lattice cuts (Z^d, D_d, E8) with the spacing at which the pieces just do not
//! overlap.
//!
//! What the source's kernel has and is not ported: `validate` (the job's rule replaces it,
//! auto.rs), `clear` and `setShape` (basin_hopping calls neither; the shape parameter tau is
//! therefore always 1).
//!
//! Efficiency, with every result the source's bit for bit: the placed vertices, charts and gradient
//! accumulator of an energy call are buffers of the kernel, not arrays allocated per call.

use crate::contact::contact_points;
use crate::gjk::{closest_points, gap_along, signed_separation};
use crate::lattice::{lattice_points, LatticeName};
use crate::linalg::{inverse_into, mul_into, orthonormalise};
use crate::polytope::{get_polytope, is_loaded, Polytope};
use crate::pose::{pose_of_matrix, read_pose, Pose, MAX_SIZE};
use crate::problem::NdConfig;
use crate::space::{
    format_nd_id, nd_bound_entry, nd_ball_volume, nd_check, nd_code, nd_in_range, nd_shapes, NdProblemId, ND_BALL,
};
use crate::Thrown;
use polypack_js::math;
use polypack_methods::kernel::{FamilyKernel, Finished, KernelState, Throw};
use polypack_methods::random::Mulberry32;

/// Volume fraction of a random start.
const START_FILL: f64 = 0.15;
const BALL_R: f64 = 0.5;
/// Shape parameters below this are taken as the inscribed ball.
const POINT_T: f64 = 1e-6;

/// kernel.ts: Aux. Anchor rotations (P x d x d, row-major) and the shape parameter in [0, 1].
#[derive(Debug, Clone)]
pub struct NdAux {
    pub r0: Vec<f64>,
    pub t: f64,
}

pub type NdState = KernelState<NdAux>;

/// kernel.ts: `randomRotation`. A Haar-random rotation (Gaussian columns, Gram-Schmidt,
/// determinant fixed to +1), row-major.
fn random_rotation(n: usize, rng: &mut Mulberry32, out: &mut [f64]) {
    let mut gauss = || math::sqrt(-2.0 * math::log(1.0 - rng.next())) * math::cos(2.0 * std::f64::consts::PI * rng.next());
    for i in 0..n * n {
        out[i] = gauss();
    }
    orthonormalise(out, n);
    // determinant by elimination
    let mut m = out[..n * n].to_vec();
    let mut det = 1.0f64;
    for c in 0..n {
        let mut p = c;
        for r in c + 1..n {
            if math::abs(m[r * n + c]) > math::abs(m[p * n + c]) {
                p = r;
            }
        }
        if p != c {
            for j in 0..n {
                m.swap(c * n + j, p * n + j);
            }
            det = -det;
        }
        det *= m[c * n + c];
        for r in c + 1..n {
            let f = m[r * n + c] / m[c * n + c];
            for j in c..n {
                m[r * n + j] -= f * m[c * n + j];
            }
        }
    }
    if det < 0.0 {
        for i in 0..n {
            out[i * n] = -out[i * n];
        }
    }
}

/// Buffers of one energy call (kernel.ts: `Placed` for every piece, and the call's local arrays).
struct Scratch {
    /// I - S of the chart being read, d x d, and the Gauss-Jordan work area.
    a: Vec<f64>,
    work: Vec<f64>,
    /// C(S) of the piece being placed, and R0 C(S).
    c: Vec<f64>,
    r: Vec<f64>,
    /// Per piece: (I - S)^-1 (Minv) and R0 (I - S)^-1 (RM), d x d each.
    minv: Vec<f64>,
    rm: Vec<f64>,
    /// Per piece: its core vertices in the world, nV x d.
    xw: Vec<f64>,
    placed: Vec<bool>,
    /// The gradient accumulator, P x dim.
    g: Vec<f64>,
    /// a and b of the vertex gradient, and a direction.
    va: Vec<f64>,
    vb: Vec<f64>,
    u: Vec<f64>,
}

/// kernel.ts: `chart`. C(S) = 2 (I - S)^-1 - I for the chart parameters of piece i (x entries d..
/// in length units); fills Minv too. False when the chart is singular.
fn chart(
    d: usize,
    dim: usize,
    rc: f64,
    x: &[f64],
    i: usize,
    a: &mut [f64],
    work: &mut [f64],
    minv: &mut [f64],
    c: Option<&mut [f64]>,
) -> bool {
    let o = dim * i + d;
    let mut k = 0;
    a[..d * d].fill(0.0);
    for r in 0..d {
        a[r * d + r] = 1.0;
    }
    for r in 0..d {
        for b in r + 1..d {
            let v = x[o + k] / rc;
            k += 1;
            a[r * d + b] = -v; // I - S
            a[b * d + r] = v;
        }
    }
    if !inverse_into(a, d, work, minv) {
        return false;
    }
    if let Some(c) = c {
        for r in 0..d * d {
            c[r] = 2.0 * minv[r];
        }
        for r in 0..d {
            c[r * d + r] -= 1.0;
        }
    }
    true
}

/// kernel.ts: `vertexGrad`. Adds c * grad(u . x_v) of vertex v of piece i (core scale tau) to G, in
/// x units. `rm` and `minv` are the piece's.
fn vertex_grad(
    g: &mut [f64],
    d: usize,
    dim: usize,
    rc: f64,
    piece: Option<&Polytope>,
    i: usize,
    rm: &[f64],
    minv: &[f64],
    v: usize,
    tau: f64,
    u: &[f64],
    c: f64,
    va: &mut [f64],
    vb: &mut [f64],
) {
    let o = dim * i;
    for a in 0..d {
        g[o + a] += c * u[a];
    }
    let Some(piece) = piece else { return };
    for j in 0..d {
        let mut sa = 0.0f64;
        let mut sb = 0.0f64;
        for l in 0..d {
            sa += rm[l * d + j] * u[l];
            sb += minv[j * d + l] * piece.v[v * d + l];
        }
        va[j] = sa;
        vb[j] = tau * sb;
    }
    let mut k = 0;
    let f = (2.0 * c) / rc;
    for p in 0..d {
        for q in p + 1..d {
            g[o + d + k] += f * (va[p] * vb[q] - va[q] * vb[p]);
            k += 1;
        }
    }
}

/// One call of kernel.ts: `terms`: the energy's terms and, with `want_grad`, their gradient.
struct Terms<'a> {
    d: usize,
    dim: usize,
    rc: f64,
    n_v: usize,
    piece: Option<&'a Polytope>,
    cont: Option<&'a Polytope>,
    x: &'a [f64],
    r0: &'a [f64],
    size: f64,
    tau: f64,
    r: f64,
    /// A piece that is a point plus a ball: balls, and polytopes whose core has shrunk to a point.
    point_like: bool,
    reach: f64,
    w: Option<&'a [f64]>,
    sc: &'a mut Scratch,
    want_grad: bool,
    e: f64,
    gs: f64,
    /// `worst`: receives the largest overlap (a length) of the terms evaluated.
    worst: Option<&'a mut f64>,
}

impl Terms<'_> {
    fn record(&mut self, o: f64) {
        if let Some(w) = self.worst.as_deref_mut() {
            if o > *w {
                *w = o;
            }
        }
    }

    /// kernel.ts: `place`. Places piece i in the world for this call (once).
    fn place(&mut self, i: usize) -> Result<(), Throw> {
        if self.sc.placed[i] {
            return Ok(());
        }
        let (d, dim, nv) = (self.d, self.dim, self.n_v);
        let dd = d * d;
        let sc = &mut *self.sc;
        if !chart(d, dim, self.rc, self.x, i, &mut sc.a, &mut sc.work, &mut sc.minv[i * dd..(i + 1) * dd], Some(&mut sc.c)) {
            return Err(Throw::Error("singular chart".into()));
        }
        let r0 = &self.r0[i * dd..(i + 1) * dd];
        mul_into(r0, &sc.c, d, &mut sc.r);
        mul_into(r0, &sc.minv[i * dd..(i + 1) * dd], d, &mut sc.rm[i * dd..(i + 1) * dd]);
        let t = &self.x[dim * i..dim * i + d];
        let piece = self.piece.expect("a polytope piece");
        for v in 0..nv {
            for a in 0..d {
                let mut acc = 0.0f64;
                for l in 0..d {
                    acc += sc.r[a * d + l] * piece.v[v * d + l];
                }
                sc.xw[(i * nv + v) * d + a] = t[a] + self.tau * acc;
            }
        }
        sc.placed[i] = true;
        Ok(())
    }

    fn grad_vertex(&mut self, i: usize, v: usize, u_is_scratch: bool, u_ext: &[f64], c: f64) {
        let (d, dim) = (self.d, self.dim);
        let dd = d * d;
        let sc = &mut *self.sc;
        let rm = &sc.rm[i * dd..(i + 1) * dd];
        let minv = &sc.minv[i * dd..(i + 1) * dd];
        let u: &[f64] = if u_is_scratch { &sc.u } else { u_ext };
        vertex_grad(&mut sc.g, d, dim, self.rc, self.piece, i, rm, minv, v, self.tau, u, c, &mut sc.va, &mut sc.vb);
    }

    fn wall(&mut self, i: usize) -> Result<(), Throw> {
        let (d, dim, nv) = (self.d, self.dim, self.n_v);
        let wi = self.w.map_or(1.0, |w| w[i]);
        let x = self.x;
        let t = &x[dim * i..dim * i + d];
        let (tau, r, rc, size) = (self.tau, self.r, self.rc, self.size);
        let Some(cont) = self.cont else {
            // ball container of radius s/2
            let lim = size / 2.0;
            let mut tn = 0.0f64;
            for a in 0..d {
                tn += t[a] * t[a];
            }
            tn = math::sqrt(tn);
            if self.point_like {
                let viol = tn + r - lim;
                if !(viol > 0.0) {
                    return Ok(());
                }
                self.record(viol);
                self.e += wi * viol * viol;
                if self.want_grad {
                    let c2 = 2.0 * wi * viol;
                    for a in 0..d {
                        self.sc.g[dim * i + a] += if tn > 0.0 { (c2 * t[a]) / tn } else { 0.0 };
                    }
                    self.gs -= c2 * 0.5;
                }
                return Ok(());
            }
            if tn + tau * rc + r <= lim {
                return Ok(());
            }
            self.place(i)?;
            let mut far: Option<usize> = None;
            let mut fv = 0.0f64;
            for v in 0..nv {
                let mut q = 0.0f64;
                for a in 0..d {
                    let w = self.sc.xw[(i * nv + v) * d + a];
                    q += w * w;
                }
                if q > fv {
                    fv = q;
                    far = Some(v);
                }
            }
            let nrm = math::sqrt(fv);
            let viol = nrm + r - lim;
            if !(viol > 0.0) {
                return Ok(());
            }
            self.record(viol);
            self.e += wi * viol * viol;
            if self.want_grad {
                let c2 = 2.0 * wi * viol;
                // far is None only when fv is 0, which the size above 0 rules out (viol would be negative)
                let far = far.expect("a farthest vertex");
                for a in 0..d {
                    self.sc.u[a] = self.sc.xw[(i * nv + far) * d + a] / nrm;
                }
                self.grad_vertex(i, far, true, &[], c2);
                self.gs -= c2 * 0.5;
            }
            return Ok(());
        };
        for f in 0..cont.n_f {
            let nf = &cont.n[f * d..f * d + d];
            let lim = size * cont.b[f];
            let mut nt = 0.0f64;
            for a in 0..d {
                nt += nf[a] * t[a];
            }
            if self.point_like {
                let viol = nt + r - lim;
                if !(viol > 0.0) {
                    continue;
                }
                self.record(viol);
                self.e += wi * viol * viol;
                if self.want_grad {
                    let c2 = 2.0 * wi * viol;
                    for a in 0..d {
                        self.sc.g[dim * i + a] += c2 * nf[a];
                    }
                    self.gs -= c2 * cont.b[f];
                }
                continue;
            }
            if nt + tau * rc + r <= lim {
                continue;
            }
            self.place(i)?;
            let mut top = f64::NEG_INFINITY;
            let mut at = 0usize;
            for v in 0..nv {
                let mut q = 0.0f64;
                for a in 0..d {
                    q += nf[a] * self.sc.xw[(i * nv + v) * d + a];
                }
                if q > top {
                    top = q;
                    at = v;
                }
            }
            let viol = top + r - lim;
            if !(viol > 0.0) {
                continue;
            }
            self.record(viol);
            self.e += wi * viol * viol;
            if self.want_grad {
                let c2 = 2.0 * wi * viol;
                self.grad_vertex(i, at, false, nf, c2);
                self.gs -= c2 * cont.b[f];
            }
        }
        Ok(())
    }

    /// A pair is always taken as (lower index, higher index), so energy() and pieceEnergy()
    /// compute it alike.
    fn pair(&mut self, p: usize, q: usize) -> Result<(), Throw> {
        let (d, dim, nv) = (self.d, self.dim, self.n_v);
        let x = self.x;
        let tp = &x[dim * p..dim * p + d];
        let tq = &x[dim * q..dim * q + d];
        let mut d2 = 0.0f64;
        for a in 0..d {
            let df = tq[a] - tp[a];
            d2 += df * df;
        }
        if d2 >= self.reach * self.reach {
            return Ok(());
        }
        let dist = math::sqrt(d2);
        let wpq = match self.w {
            Some(w) => (w[p] + w[q]) / 2.0,
            None => 1.0,
        };
        let r = self.r;
        if self.point_like {
            let o = 2.0 * r - dist;
            if !(o > 0.0) {
                return Ok(());
            }
            self.record(o);
            self.e += wpq * o * o;
            if self.want_grad {
                let c2 = 2.0 * wpq * o;
                for a in 0..d {
                    // o = 2 r - |t_q - t_p|: d o / d t_p = +du, d o / d t_q = -du for du the unit vector from p to q
                    let du = if dist > 0.0 {
                        (tq[a] - tp[a]) / dist
                    } else if a == 0 {
                        1.0
                    } else {
                        0.0
                    };
                    self.sc.g[dim * p + a] += c2 * du;
                    self.sc.g[dim * q + a] -= c2 * du;
                }
            }
            return Ok(());
        }
        self.place(p)?;
        self.place(q)?;
        if dist > 0.0 {
            for a in 0..d {
                self.sc.u[a] = (tq[a] - tp[a]) / dist;
            }
            // any direction bounds the separation from below: a gap of 2 r along the line of centres means no overlap
            let (xp, xq) = (&self.sc.xw[p * nv * d..(p + 1) * nv * d], &self.sc.xw[q * nv * d..(q + 1) * nv * d]);
            if gap_along(xp, nv, xq, nv, d, &self.sc.u) >= 2.0 * r {
                return Ok(());
            }
        }
        let sep = {
            let (xp, xq) = (&self.sc.xw[p * nv * d..(p + 1) * nv * d], &self.sc.xw[q * nv * d..(q + 1) * nv * d]);
            signed_separation(xp, nv, xq, nv, d, None)
        };
        let o = 2.0 * r - sep.sep;
        if !(o > 0.0) {
            return Ok(());
        }
        self.record(o);
        self.e += wpq * o * o;
        if self.want_grad {
            let Some(dir) = sep.dir else { return Ok(()) };
            // the derivative of the separation along its optimal direction is taken at the contact points (contact.ts)
            let ct = {
                let (xp, xq) = (&self.sc.xw[p * nv * d..(p + 1) * nv * d], &self.sc.xw[q * nv * d..(q + 1) * nv * d]);
                contact_points(xp, xq, nv, d, &dir)
            };
            let c2 = 2.0 * wpq * o;
            for k in 0..ct.ia.len() {
                self.grad_vertex(p, ct.ia[k], false, &dir, c2 * ct.wa[k]);
                self.grad_vertex(q, ct.ib[k], false, &dir, -c2 * ct.wb[k]);
            }
        }
        Ok(())
    }
}

/// The nD kernel of one problem (kernel.ts: `ndKernel`).
pub struct NdKernel {
    problem: NdProblemId,
    d: usize,
    np: usize,
    ball_piece: bool,
    piece: Option<std::sync::Arc<Polytope>>,
    cont: Option<std::sync::Arc<Polytope>>,
    /// d (d - 1) / 2.
    m: usize,
    dim: usize,
    rho: f64,
    rc: f64,
    n_v: usize,
    rho_c: f64,
    vol_p: f64,
    vol_c: f64,
    bound: f64,
    finish_cost: f64,
    validate_cost: f64,
    steps: Vec<f64>,
    box_half: f64,
    box_accept: f64,
    sc: Scratch,
}

impl NdKernel {
    /// kernel.ts: `ndKernel`. `Err` (the source throws) for a shape the dimension does not have, a P
    /// out of the dimension's range, or a polytope that is loaded on demand and is not loaded.
    pub fn new(problem: &NdProblemId) -> Result<NdKernel, String> {
        let d = problem.d as usize;
        let np = problem.p as usize;
        let shapes = nd_shapes(problem.d);
        if !shapes.contains(&problem.piece.as_str()) || !shapes.contains(&problem.container.as_str()) {
            return Err("unknown shape".into());
        }
        if !nd_in_range(problem.d, problem.p) {
            return Err("P must be in the range of the dimension, the P the server accepts".into());
        }
        let ball_piece = problem.piece == ND_BALL;
        let ball_container = problem.container == ND_BALL;
        for shape in [&problem.piece, &problem.container] {
            if shape != ND_BALL && !is_loaded(&nd_code(problem.d, shape)) {
                return Err(format!("{} is loaded on demand: await loadPolytope first", nd_code(problem.d, shape)));
            }
        }
        let load = |ball: bool, shape: &str| -> Result<Option<std::sync::Arc<Polytope>>, String> {
            if ball {
                Ok(None)
            } else {
                get_polytope(&nd_code(problem.d, shape)).map(Some).map_err(|e| e.0)
            }
        };
        let piece = load(ball_piece, &problem.piece)?;
        let cont = load(ball_container, &problem.container)?;
        let m = (d * (d - 1)) / 2;
        let dim = if ball_piece { d } else { d + m };
        let rho = piece.as_ref().map_or(BALL_R, |p| p.inradius);
        let rc = piece.as_ref().map_or(BALL_R, |p| p.circumradius);
        let n_v = piece.as_ref().map_or(1, |p| p.n_v);
        let rho_c = cont.as_ref().map_or(0.5, |c| c.inradius);
        let vol_p = piece.as_ref().map_or_else(|| nd_ball_volume(problem.d, BALL_R), |p| p.volume);
        let vol_c = cont.as_ref().map_or_else(|| nd_ball_volume(problem.d, 0.5), |c| c.volume);
        let bound = nd_bound_entry(problem.d, &problem.piece, &problem.container, problem.p).map_err(|e| e.0)?.value;
        // Costs in energy() calls (measured by test/kernel.test.ts's bench and stated in
        // docs/spaces/NDIM.md §11): an energy costs about the pairs' GJK tests; a finish is a
        // bracketing and a bisection of 30 to 60 validations of the whole packing.
        let finish_cost = math::max(20.0, math::round(60.0 + 0.5 * np as f64));
        let validate_cost = 3.0;
        // Bounding box of the container (for rejection sampling of centres) and whether it is worth using.
        let box_half = match &cont {
            None => 0.0,
            Some(c) => {
                let mut mx = 0.0f64;
                for k in 0..c.v.len() {
                    mx = math::max(mx, math::abs(c.v[k]));
                }
                mx
            }
        };
        let box_accept = if cont.is_some() { vol_c / math::pow(2.0 * box_half, d as f64) } else { 1.0 };
        let dd = d * d;
        let sc = Scratch {
            a: vec![0.0; dd],
            work: vec![0.0; 2 * dd],
            c: vec![0.0; dd],
            r: vec![0.0; dd],
            minv: vec![0.0; np * dd],
            rm: vec![0.0; np * dd],
            xw: vec![0.0; np * n_v * d],
            placed: vec![false; np],
            g: vec![0.0; np * dim],
            va: vec![0.0; d],
            vb: vec![0.0; d],
            u: vec![0.0; d],
        };
        Ok(NdKernel {
            problem: problem.clone(),
            d,
            np,
            ball_piece,
            piece,
            cont,
            m,
            dim,
            rho,
            rc,
            n_v,
            rho_c,
            vol_p,
            vol_c,
            bound,
            finish_cost,
            validate_cost,
            steps: vec![rho; dim],
            box_half,
            box_accept,
            sc,
        })
    }

    /// The problem's id.
    pub fn id(&self) -> String {
        format_nd_id(self.problem.d, &self.problem.piece, &self.problem.container, self.problem.p)
    }

    // ---------------------------------------------------------------- rotation

    /// kernel.ts: `rotationOf`. The rotation of piece i: R0 C(S) (row-major d x d), or None when the
    /// chart is singular.
    fn rotation_of(&mut self, s: &NdState, i: usize) -> Option<Vec<f64>> {
        if self.ball_piece {
            return None;
        }
        let (d, dim, rc) = (self.d, self.dim, self.rc);
        let dd = d * d;
        let mut minv = vec![0.0f64; dd];
        let mut c = vec![0.0f64; dd];
        let sc = &mut self.sc;
        if !chart(d, dim, rc, &s.x, i, &mut sc.a, &mut sc.work, &mut minv, Some(&mut c)) {
            return None;
        }
        let mut out = vec![0.0f64; dd];
        mul_into(&s.aux.r0[i * dd..(i + 1) * dd], &c, d, &mut out);
        Some(out)
    }

    // ---------------------------------------------------------------- configurations

    /// kernel.ts: `poseOf`.
    fn pose_of(&mut self, s: &NdState, i: usize) -> Option<Vec<f64>> {
        let (d, dim) = (self.d, self.dim);
        let t: Vec<f64> = s.x[dim * i..dim * i + d].to_vec();
        if self.ball_piece {
            return Some(t);
        }
        let r = self.rotation_of(s, i)?;
        pose_of_matrix(&t, &r, d).ok()
    }

    fn blank(&self, size: f64) -> NdState {
        KernelState { x: vec![0.0; self.dim * self.np], size, aux: NdAux { r0: vec![0.0; self.np * self.d * self.d], t: 1.0 } }
    }

    fn set_identity(&self, r0: &mut [f64], i: usize) {
        let d = self.d;
        r0[i * d * d..(i + 1) * d * d].fill(0.0);
        for a in 0..d {
            r0[i * d * d + a * d + a] = 1.0;
        }
    }

    fn finite(&self, s: &NdState) -> bool {
        if !s.size.is_finite() {
            return false;
        }
        s.x.iter().all(|v| v.is_finite())
    }

    // ---------------------------------------------------------------- energy

    /// kernel.ts: `terms`. The energy's terms: all, or with only Some those of piece `only` (its
    /// pairs and walls). With `grad`, the gradient in x and, last, in the size. `worst`, when given,
    /// receives the largest overlap (a length) of the terms evaluated (it is the source's
    /// `worst.v`; the source's `worst.stop`, which no caller sets, is not ported).
    fn terms(
        &mut self,
        s: &NdState,
        grad: Option<&mut [f64]>,
        w: Option<&[f64]>,
        only: Option<usize>,
        worst: Option<&mut f64>,
    ) -> Result<f64, Throw> {
        if !self.finite(s) {
            if let Some(g) = grad {
                g.fill(0.0);
            }
            if let Some(w) = worst {
                *w = f64::INFINITY;
            }
            return Ok(f64::INFINITY);
        }
        let tau = if self.ball_piece { 1.0 } else { s.aux.t };
        let r = if self.ball_piece { BALL_R } else { (1.0 - tau) * self.rho };
        let point_like = self.ball_piece || tau < POINT_T;
        let reach = if self.ball_piece { 2.0 * BALL_R } else { 2.0 * (tau * self.rc + r) };
        let want_grad = grad.is_some();
        let (np, dim) = (self.np, self.dim);
        let this = &mut *self;
        this.sc.placed.fill(false);
        if want_grad {
            this.sc.g.fill(0.0);
        }
        let mut t = Terms {
            d: this.d,
            dim,
            rc: this.rc,
            n_v: this.n_v,
            piece: this.piece.as_deref(),
            cont: this.cont.as_deref(),
            x: &s.x,
            r0: &s.aux.r0,
            size: s.size,
            tau,
            r,
            point_like,
            reach,
            w,
            sc: &mut this.sc,
            want_grad,
            e: 0.0,
            gs: 0.0,
            worst,
        };
        match only {
            Some(o) => {
                t.wall(o)?;
                for j in 0..np {
                    if j != o {
                        t.pair(o.min(j), o.max(j))?;
                    }
                }
            }
            None => {
                for i in 0..np {
                    t.wall(i)?;
                    for j in i + 1..np {
                        t.pair(i, j)?;
                    }
                }
            }
        }
        let (e, gs) = (t.e, t.gs);
        if let Some(grad) = grad {
            grad.fill(0.0);
            grad[..np * dim].copy_from_slice(&this.sc.g[..np * dim]);
            grad[np * dim] = gs;
        }
        Ok(e)
    }

    // ---------------------------------------------------------------- random poses

    /// kernel.ts: `centreIn`. A centre at random in the container of scale `scale` (a ball: radius
    /// scale/2), written to x[o ..].
    fn centre_in(&self, scale: f64, rng: &mut Mulberry32, x: &mut [f64], o: usize) {
        let d = self.d;
        if !(scale > 0.0) {
            for a in 0..d {
                x[o + a] = 0.0;
            }
            return;
        }
        let gauss = |rng: &mut Mulberry32| math::sqrt(-2.0 * math::log(1.0 - rng.next())) * math::cos(2.0 * std::f64::consts::PI * rng.next());
        let Some(cont) = self.cont.as_deref() else {
            // uniform in the ball: a Gaussian direction and radius (scale/2) U^(1/d)
            let mut g = vec![0.0f64; d];
            let mut l = 0.0f64;
            for a in 0..d {
                g[a] = gauss(rng);
                l += g[a] * g[a];
            }
            l = math::sqrt(l);
            let rad = (scale / 2.0) * math::pow(rng.next(), 1.0 / d as f64);
            for a in 0..d {
                x[o + a] = (g[a] / l) * rad;
            }
            return;
        };
        if self.box_accept >= 0.02 {
            let mut p = vec![0.0f64; d];
            for _ in 0..2000 {
                for a in 0..d {
                    p[a] = scale * self.box_half * (2.0 * rng.next() - 1.0);
                }
                let mut inside = true;
                let mut f = 0;
                while f < cont.n_f && inside {
                    let mut q = 0.0f64;
                    for a in 0..d {
                        q += cont.n[f * d + a] * p[a];
                    }
                    inside = q <= scale * cont.b[f];
                    f += 1;
                }
                if inside {
                    x[o..o + d].copy_from_slice(&p[..d]);
                    return;
                }
            }
        }
        // radial: a random direction, a radius up to the container's boundary along it (not uniform, but inside)
        let mut g = vec![0.0f64; d];
        let mut l = 0.0f64;
        for a in 0..d {
            g[a] = gauss(rng);
            l += g[a] * g[a];
        }
        l = math::sqrt(l);
        let mut reach_r = f64::INFINITY;
        for f in 0..cont.n_f {
            let mut q = 0.0f64;
            for a in 0..d {
                q += (cont.n[f * d + a] * g[a]) / l;
            }
            if q > 1e-12 {
                reach_r = math::min(reach_r, (scale * cont.b[f]) / q);
            }
        }
        let rad = reach_r * math::pow(rng.next(), 1.0 / d as f64);
        for a in 0..d {
            x[o + a] = (g[a] / l) * rad;
        }
    }

    /// kernel.ts: `chartOf`. The chart parameters (length units) of the rotation Q relative to an
    /// anchor: S = (Q - I)(Q + I)^-1, or false when Q is near a half turn.
    fn chart_of(&self, q: &[f64], x: &mut [f64], o: usize) -> bool {
        let d = self.d;
        let mut num = q.to_vec();
        let mut den = q.to_vec();
        for a in 0..d {
            num[a * d + a] -= 1.0;
            den[a * d + a] += 1.0;
        }
        let mut inv = vec![0.0f64; d * d];
        let mut work = vec![0.0f64; 2 * d * d];
        if !inverse_into(&den, d, &mut work, &mut inv) {
            return false;
        }
        let mut sm = vec![0.0f64; d * d];
        mul_into(&num, &inv, d, &mut sm);
        let mut k = 0;
        for a in 0..d {
            for b in a + 1..d {
                let v = 0.5 * (sm[a * d + b] - sm[b * d + a]);
                if !(math::abs(v) < 1e3) {
                    return false;
                }
                x[o + k] = v * self.rc;
                k += 1;
            }
        }
        true
    }

    /// kernel.ts: `shrunk`.
    fn shrunk(&self, size: f64) -> f64 {
        math::max(0.0, size - self.rc / self.rho_c)
    }

    // ---------------------------------------------------------------- legalisation (finish)

    fn scaled_config(&self, cfg: &NdConfig, f: f64) -> NdConfig {
        NdConfig {
            s: cfg.s * f,
            pieces: cfg
                .pieces
                .iter()
                .map(|p| {
                    let mut q = p.clone();
                    for a in 0..self.d {
                        q[a] = p[a] * f;
                    }
                    q
                })
                .collect(),
        }
    }

    fn valid_at(&self, cfg: &NdConfig, f: f64) -> Result<bool, Throw> {
        let c = self.scaled_config(cfg, f);
        if !(c.s <= 1e6) {
            return Ok(false);
        }
        Ok(nd_check(&self.problem, &c, 0.0, 1).map_err(|e| Throw::Error(e.0))?.is_empty())
    }

    /// kernel.ts: `legalFactor`. The smallest factor f >= 1 (to 1e-12) at which scaling the centres
    /// and the container makes cfg valid at tolerance 0, or None.
    fn legal_factor(&mut self, cfg: &NdConfig, stop: &mut dyn FnMut() -> bool) -> Result<Option<f64>, Throw> {
        let Some(c0) = self.check_measure(cfg)? else { return Ok(None) };
        let mut hi = 1.0 + (2.0 * math::max(0.0, c0)) / self.rho + 1e-12;
        if !self.valid_at(cfg, hi)? {
            let mut step = hi - 1.0;
            let mut ok = false;
            let mut k = 0;
            while k < 60 && !ok {
                if stop() {
                    return Ok(None);
                }
                step *= 2.0;
                hi = 1.0 + step;
                ok = self.valid_at(cfg, hi)?;
                k += 1;
            }
            if !ok {
                return Ok(None);
            }
        }
        let mut lo = 1.0f64;
        if self.valid_at(cfg, 1.0)? {
            // already valid: the ray [f*, inf) may reach below 1, so shrink while it stays valid (the finish tightens as well)
            hi = 1.0;
            let mut step = 1e-3;
            for _ in 0..40 {
                if stop() {
                    return Ok(Some(hi));
                }
                let f = math::max(0.01, 1.0 - step);
                if !self.valid_at(cfg, f)? {
                    lo = f;
                    break;
                }
                hi = f;
                if f <= 0.01 {
                    return Ok(Some(hi));
                }
                step *= 2.0;
            }
            if lo == 1.0 {
                return Ok(Some(hi));
            }
        }
        let mut k = 0;
        while k < 80 && hi - lo > 1e-13 * hi {
            if stop() {
                break;
            }
            let mid = 0.5 * (lo + hi);
            if self.valid_at(cfg, mid)? {
                hi = mid;
            } else {
                lo = mid;
            }
            k += 1;
        }
        Ok(Some(hi))
    }

    /// kernel.ts: `ndCheckMeasure`. The largest violation (a length) of cfg: overlap or protrusion,
    /// from the validator's measures; None for a malformed one.
    fn check_measure(&mut self, cfg: &NdConfig) -> Result<Option<f64>, Throw> {
        if !self.parse_ok(cfg) {
            return Ok(None);
        }
        let st = self.state_of_parsed(cfg).map_err(Throw::Error)?;
        let mut worst = 0.0f64;
        self.terms(&st, None, None, None, Some(&mut worst))?;
        Ok(Some(worst))
    }

    /// `parseNdConfig(problem, config).ok` of packages/ndspace/src/validate.ts for a configuration
    /// that is already numbers: s in (0, MAX_SIZE], P poses that `read_pose` accepts.
    pub fn parse_ok(&self, c: &NdConfig) -> bool {
        parse_nd_config_ok(&self.problem, c)
    }

    /// kernel.ts: `fromParsed`. `Err` is the RangeError the source throws for a pose it cannot read.
    fn state_of_parsed(&self, c: &NdConfig) -> Result<NdState, String> {
        let d = self.d;
        let mut st = self.blank(c.s);
        for i in 0..self.np {
            match read_pose(d, &c.pieces[i], self.ball_piece).map_err(|e| e.0)? {
                Pose::Bad(text) => return Err(text),
                Pose::Read(r) => {
                    st.x[self.dim * i..self.dim * i + d].copy_from_slice(&r.t);
                    if let Some(rot) = r.r {
                        st.aux.r0[i * d * d..(i + 1) * d * d].copy_from_slice(&rot);
                    }
                }
            }
        }
        Ok(st)
    }

    // ---------------------------------------------------------------- seeds

    /// kernel.ts: `seedState`.
    fn seed_state(&mut self, name: LatticeName, offset: f64, rotate: bool, rng: &mut Mulberry32) -> Option<NdState> {
        let (d, np, dim) = (self.d, self.np, self.dim);
        let (rho, rc) = (self.rho, self.rc);
        let n_v = self.n_v;
        let centre = vec![offset; d];
        let mut pts = lattice_points(name, d, &centre, np, rng)?;
        // centred at their mean
        let mut mean = vec![0.0f64; d];
        for i in 0..np {
            for a in 0..d {
                mean[a] += pts[i * d + a] / np as f64;
            }
        }
        for i in 0..np {
            for a in 0..d {
                pts[i * d + a] -= mean[a];
            }
        }
        let mut st = self.blank(1.0);
        let mut q = vec![0.0f64; d * d];
        if rotate && !self.ball_piece {
            random_rotation(d, rng, &mut q);
        }
        for i in 0..np {
            if rotate && !self.ball_piece {
                st.aux.r0[i * d * d..(i + 1) * d * d].copy_from_slice(&q);
            } else if !self.ball_piece {
                let mut r0 = std::mem::take(&mut st.aux.r0);
                self.set_identity(&mut r0, i);
                st.aux.r0 = r0;
            }
        }
        // the spacing a: the smallest at which the pieces in these poses do not overlap, by bisection. The pieces contain their
        // inscribed balls and lie in their circumscribed ones, so the centres' least distance dmin (in lattice units) puts a
        // between 2 rho / dmin and 2 Rc / dmin, where the upper end is valid.
        let mut dmin = f64::INFINITY;
        for i in 0..np {
            for j in i + 1..np {
                let mut qq = 0.0f64;
                for a in 0..d {
                    let df = pts[i * d + a] - pts[j * d + a];
                    qq += df * df;
                }
                dmin = math::min(dmin, math::sqrt(qq));
            }
        }
        // the canonical piece in the (common) pose of the seed, about the origin; a piece is this plus its centre
        let mut rv = vec![0.0f64; n_v * d];
        if let Some(piece) = self.piece.as_deref() {
            let r = &st.aux.r0[..d * d];
            for v in 0..n_v {
                for a in 0..d {
                    let mut acc = 0.0f64;
                    for l in 0..d {
                        acc += r[a * d + l] * piece.v[v * d + l];
                    }
                    rv[v * d + a] = acc;
                }
            }
        }
        let mut xa = vec![0.0f64; n_v * d];
        let mut xb = vec![0.0f64; n_v * d];
        let mut u = vec![0.0f64; d];
        let has_piece = self.piece.is_some();
        // True when no two pieces overlap at spacing a: GJK on the near pairs (no EPA: only whether they overlap matters).
        let mut pairs_ok = |a: f64| -> bool {
            for i in 0..np {
                for j in i + 1..np {
                    let mut d2 = 0.0f64;
                    for q in 0..d {
                        let df = a * (pts[j * d + q] - pts[i * d + q]);
                        d2 += df * df;
                    }
                    let dist = math::sqrt(d2);
                    if dist >= 2.0 * rc {
                        continue;
                    }
                    if !has_piece {
                        if dist < 1.0 {
                            return false;
                        }
                        continue;
                    }
                    if dist < 2.0 * rho {
                        return false;
                    }
                    for v in 0..n_v {
                        for q in 0..d {
                            xa[v * d + q] = rv[v * d + q] + a * pts[i * d + q];
                            xb[v * d + q] = rv[v * d + q] + a * pts[j * d + q];
                        }
                    }
                    for q in 0..d {
                        u[q] = (a * (pts[j * d + q] - pts[i * d + q])) / dist;
                    }
                    if gap_along(&xa, n_v, &xb, n_v, d, &u) >= 0.0 {
                        continue;
                    }
                    let cp = closest_points(&xa, n_v, &xb, n_v, d);
                    if cp.w.is_none() || !(cp.dist > 1e-12) {
                        return false;
                    }
                }
            }
            true
        };
        let mut lo = (2.0 * rho) / dmin;
        let mut hi = (2.0 * rc) / dmin;
        if !(hi > 0.0) || !hi.is_finite() {
            return None;
        }
        let mut k = 0;
        while k < 60 && hi - lo > 1e-10 * hi {
            let mid = 0.5 * (lo + hi);
            if pairs_ok(mid) {
                hi = mid;
            } else {
                lo = mid;
            }
            k += 1;
        }
        let a = hi * (1.0 + 1e-9);
        for i in 0..np {
            for q in 0..d {
                st.x[dim * i + q] = a * pts[i * d + q];
            }
        }
        // the container that holds the arrangement: the largest wall ratio, at least the roomy start
        st.size = self.tight(&st);
        Some(st)
    }

    /// kernel.ts: `tight`. The smallest container scale that holds every piece of s as placed (from
    /// the vertices and facets).
    fn tight(&mut self, s: &NdState) -> f64 {
        let (d, np, dim, n_v) = (self.d, self.np, self.dim, self.n_v);
        let mut size = 0.0f64;
        for i in 0..np {
            let t = &s.x[dim * i..dim * i + d];
            let mut xv: Option<Vec<f64>> = None;
            if !self.ball_piece {
                let Some(r) = self.rotation_of(s, i) else { continue };
                let piece = self.piece.as_deref().expect("a polytope piece");
                let mut x = vec![0.0f64; n_v * d];
                for v in 0..n_v {
                    for a in 0..d {
                        let mut acc = 0.0f64;
                        for l in 0..d {
                            acc += r[a * d + l] * piece.v[v * d + l];
                        }
                        x[v * d + a] = t[a] + acc;
                    }
                }
                xv = Some(x);
            }
            let Some(cont) = self.cont.as_deref() else {
                match &xv {
                    None => {
                        let mut tn = 0.0f64;
                        for a in 0..d {
                            tn += t[a] * t[a];
                        }
                        size = math::max(size, 2.0 * (math::sqrt(tn) + BALL_R));
                    }
                    Some(x) => {
                        for v in 0..n_v {
                            let mut q = 0.0f64;
                            for a in 0..d {
                                q += x[v * d + a] * x[v * d + a];
                            }
                            size = math::max(size, 2.0 * math::sqrt(q));
                        }
                    }
                }
                continue;
            };
            for f in 0..cont.n_f {
                match &xv {
                    None => {
                        let mut q = 0.0f64;
                        for a in 0..d {
                            q += cont.n[f * d + a] * t[a];
                        }
                        size = math::max(size, (q + BALL_R) / cont.b[f]);
                    }
                    Some(x) => {
                        for v in 0..n_v {
                            let mut q = 0.0f64;
                            for a in 0..d {
                                q += cont.n[f * d + a] * x[v * d + a];
                            }
                            size = math::max(size, q / cont.b[f]);
                        }
                    }
                }
            }
        }
        size
    }
}

/// `parseNdConfig(p, config).ok` of packages/ndspace/src/validate.ts, for a configuration that is
/// already numbers: s a number in (0, MAX_SIZE] and P poses of the right length with finite numbers
/// in range (read_pose).
pub fn parse_nd_config_ok(p: &NdProblemId, c: &NdConfig) -> bool {
    // `!Number.isFinite(c.s) || !(c.s > 0) || c.s > MAX_SIZE` is an error
    if !c.s.is_finite() || !(c.s > 0.0) || c.s > MAX_SIZE {
        return false;
    }
    if c.pieces.len() != p.p as usize {
        return false;
    }
    let ball = p.piece == ND_BALL;
    c.pieces.iter().all(|q| matches!(read_pose(p.d as usize, q, ball), Ok(Pose::Read(_))))
}

/// True when `JSON.stringify` writes the two numbers alike: the same value, or both not finite (null).
fn json_same(a: f64, b: f64) -> bool {
    if a.is_finite() && b.is_finite() {
        a == b
    } else {
        !a.is_finite() && !b.is_finite()
    }
}

/// kernel.ts: the lattice seeds of each dimension: Z^d at a half offset, D_d, Z^d, D_d at a quarter
/// offset; in 8D the E8 lattice replaces the second.
fn seed_kinds(d: usize) -> [(LatticeName, f64, bool); 4] {
    if d == 8 {
        [(LatticeName::Zd, 0.5, false), (LatticeName::E8, 0.0, false), (LatticeName::Dd, 0.0, false), (LatticeName::Zd, 0.0, false)]
    } else {
        [(LatticeName::Zd, 0.5, false), (LatticeName::Dd, 0.0, false), (LatticeName::Zd, 0.0, false), (LatticeName::Dd, 0.25, false)]
    }
}

#[allow(clippy::wrong_self_convention)]
impl FamilyKernel for NdKernel {
    type Aux = NdAux;
    type Config = NdConfig;

    fn p(&self) -> usize {
        self.np
    }
    fn dim(&self) -> usize {
        self.dim
    }
    fn steps(&self) -> &[f64] {
        &self.steps
    }
    fn globals(&self) -> usize {
        0
    }
    fn global_steps(&self) -> &[f64] {
        &[]
    }
    fn bound(&self) -> Option<f64> {
        Some(self.bound)
    }
    fn finish_cost(&self) -> f64 {
        self.finish_cost
    }
    fn validate_cost(&self) -> Option<f64> {
        Some(self.validate_cost)
    }
    fn grad_cost(&self) -> Option<f64> {
        None
    }
    fn has_swap(&self) -> bool {
        !self.ball_piece
    }
    fn has_seeds(&self) -> bool {
        true
    }

    fn from_config(&mut self, config: &NdConfig) -> Option<NdState> {
        if !self.parse_ok(config) {
            return None;
        }
        // the same limits as the server: s and centres in range, rotations that can be read (parseNdConfig reads every pose)
        self.state_of_parsed(config).ok()
    }

    fn to_config(&mut self, s: &NdState) -> Result<NdConfig, Throw> {
        let mut pieces: Vec<Vec<f64>> = Vec::with_capacity(self.np);
        for i in 0..self.np {
            let pose = self.pose_of(s, i);
            // never a malformed pose: a rotation without a verified Cayley form is refused (not expected for valid input)
            match pose {
                Some(p) => pieces.push(p),
                None => return Err(Throw::Error(format!("piece {i}: the rotation has no verified Cayley pose"))),
            }
        }
        Ok(NdConfig { s: s.size, pieces })
    }

    fn same_config(&self, a: &NdConfig, b: &NdConfig) -> bool {
        json_same(a.s, b.s)
            && a.pieces.len() == b.pieces.len()
            && a.pieces.iter().zip(&b.pieces).all(|(p, q)| p.len() == q.len() && p.iter().zip(q).all(|(&x, &y)| json_same(x, y)))
    }

    fn rebase(&mut self, s: &mut NdState) {
        if self.ball_piece {
            return;
        }
        let (d, dim, m) = (self.d, self.dim, self.m);
        for i in 0..self.np {
            let o = dim * i + d;
            let mut zero = true;
            for k in 0..m {
                if s.x[o + k] != 0.0 {
                    zero = false;
                }
            }
            if zero {
                continue;
            }
            let Some(mut r) = self.rotation_of(s, i) else { continue };
            orthonormalise(&mut r, d);
            s.aux.r0[i * d * d..(i + 1) * d * d].copy_from_slice(&r);
            s.x[o..o + m].fill(0.0);
        }
    }

    fn random_start(&mut self, rng: &mut Mulberry32) -> NdState {
        let d = self.d;
        let np = self.np as f64;
        let size = math::max(
            math::pow((np * self.vol_p) / (START_FILL * self.vol_c), 1.0 / d as f64),
            (1.5 * self.rc) / self.rho_c + 1e-3,
        );
        let mut st = self.blank(size);
        for i in 0..self.np {
            self.centre_in(self.shrunk(size), rng, &mut st.x, self.dim * i);
            if !self.ball_piece {
                random_rotation(d, rng, &mut st.aux.r0[i * d * d..(i + 1) * d * d]);
            }
        }
        st
    }

    fn random_pose(&mut self, s: &mut NdState, i: usize, rng: &mut Mulberry32) {
        let (d, dim, m) = (self.d, self.dim, self.m);
        self.centre_in(self.shrunk(s.size), rng, &mut s.x, dim * i);
        if self.ball_piece {
            return;
        }
        // a uniformly random orientation, written as the chart rotation C relative to the anchor: R0 C = Q, C = R0^T Q
        let mut q = vec![0.0f64; d * d];
        let mut rel = vec![0.0f64; d * d];
        for _ in 0..20 {
            random_rotation(d, rng, &mut q);
            for a in 0..d {
                for b in 0..d {
                    let mut acc = 0.0f64;
                    for l in 0..d {
                        acc += s.aux.r0[i * d * d + l * d + a] * q[l * d + b];
                    }
                    rel[a * d + b] = acc;
                }
            }
            if self.chart_of(&rel, &mut s.x, dim * i + d) {
                return;
            }
        }
        s.x[dim * i + d..dim * i + d + m].fill(0.0);
    }

    fn jiggle(&mut self, s: &mut NdState, i: usize, amount: f64, rng: &mut Mulberry32) {
        for a in 0..self.dim {
            s.x[self.dim * i + a] += (2.0 * rng.next() - 1.0) * amount * self.rho;
        }
    }

    fn set_size(&mut self, s: &mut NdState, size: f64) {
        let f = size / s.size;
        for i in 0..self.np {
            for a in 0..self.d {
                s.x[self.dim * i + a] *= f;
            }
        }
        s.size = size;
    }

    fn energy(&mut self, s: &NdState, grad: Option<&mut [f64]>, w: Option<&[f64]>) -> Result<f64, Throw> {
        self.terms(s, grad, w, None, None)
    }

    fn piece_energy(&mut self, s: &NdState, i: usize, w: Option<&[f64]>) -> Result<f64, Throw> {
        self.terms(s, None, w, Some(i), None)
    }

    fn finish(
        &mut self,
        s: &NdState,
        should_stop: &mut dyn FnMut() -> bool,
    ) -> Result<Option<Finished<NdConfig>>, Throw> {
        if !self.finite(s) {
            return Ok(None);
        }
        let cfg = self.to_config(s)?;
        if !self.parse_ok(&cfg) {
            return Ok(None);
        }
        let Some(f) = self.legal_factor(&cfg, should_stop)? else { return Ok(None) };
        let out = self.scaled_config(&cfg, f);
        if !nd_check(&self.problem, &out, 0.0, 1).map_err(|e| Throw::Error(e.0))?.is_empty() {
            return Ok(None);
        }
        let score = out.s;
        Ok(Some(Finished { config: out, score }))
    }

    fn seeds(&mut self, rng: &mut Mulberry32, count: usize) -> Vec<NdState> {
        let kinds = seed_kinds(self.d);
        let mut out = Vec::new();
        for n in 0..count {
            // the canonical orientation for the first lattice cuts, random orientations for the next
            let (name, off, _) = kinds[n % kinds.len()];
            let st = match self.seed_state(name, off, n >= kinds.len() && !self.ball_piece, rng) {
                Some(s) => Some(s),
                None => self.seed_state(LatticeName::Zd, 0.0, false, rng),
            };
            if let Some(st) = st {
                out.push(st);
            }
        }
        out
    }

    fn swap(&mut self, s: &mut NdState, i: usize, j: usize) {
        // the whole orientation (anchor and chart) of each piece, so that a swap is exactly reversible
        let (d, dim) = (self.d, self.dim);
        for a in 0..d * d {
            s.aux.r0.swap(i * d * d + a, j * d * d + a);
        }
        for a in d..dim {
            s.x.swap(dim * i + a, dim * j + a);
        }
    }
}

// the loader of a problem's polytopes, for the callers (auto.rs) that build the kernel
/// Loads the polytopes of the problem that are kept on demand (`loadNdProblem`).
pub fn load_problem(p: &NdProblemId) -> Result<(), Thrown> {
    crate::space::load_nd_problem(p.d, &p.piece, &p.container)
}
