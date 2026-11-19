//! The soft-to-rigid simulator's geometry: rounded convex polytopes, signed distance between their cores with
//! analytic gradients, and the boolean overlap test. Port of `packages/polyhedra/src/sim/geom.ts` (ported there from
//! upstream's src/geom.js, alejandrozu/platonic-packing, MIT; see THIRD_PARTY_NOTICES.md).
//!
//! Conventions. A piece is (c, R, k): its core is c + k R P, where P is the solid (scaled so that its inradius
//! is 1/2) and k = 1 - 2r is the core scale of the rounded shape kP (+) B(r). R is row-major 3x3, world = R * local.
//!
//! Every expression keeps the source's order of operations, so that the numbers are the TypeScript's to the bit.
//! The source's module-level scratch (`PR`, `SEG`, `GR`, `lastAxis`) is the fields of [`Sd`].

// The port keeps the source's index loops and its NaN-aware comparisons (`!(a < b)` is not `a >= b`), line by line.
#![allow(clippy::needless_range_loop, clippy::neg_cmp_op_on_partial_ord, clippy::too_many_arguments)]

use crate::solids::Solid;
use polypack_js::math;
use std::cell::OnceCell;

pub type Vec3 = [f64; 3];

/// `Math.hypot(...v)` of a 3-vector.
#[inline]
pub fn hyp3(v: &[f64]) -> f64 {
    math::hypot3(v[0], v[1], v[2])
}

#[inline]
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
pub fn cross(a: &[f64], b: &[f64]) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

#[inline]
pub fn sub(a: &[f64], b: &[f64]) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn vx(x: &[f64], i: usize) -> Vec3 {
    [x[3 * i], x[3 * i + 1], x[3 * i + 2]]
}

/// `sim/geom.ts: Shape`: a solid in internal units.
#[derive(Clone, Debug)]
pub struct Shape {
    /// Internal units per unit of the canonical solid (the inradius becomes 1/2).
    pub scale: f64,
    pub v: Vec<Vec3>,
    pub nv: usize,
    pub faces: Vec<Vec<usize>>,
    pub n: Vec<Vec3>,
    pub beta: Vec<f64>,
    /// Face normals, one per direction up to sign.
    pub faxes: Vec<Vec3>,
    /// Edge directions, one per direction up to sign.
    pub edirs: Vec<Vec3>,
    /// Per face: its edges as (p, m), m the inward in-plane unit normal.
    pub fedges: Vec<Vec<(Vec3, Vec3)>>,
    pub edges: Vec<[usize; 2]>,
    pub circ: f64,
    pub emax: f64,
    pub eface: Vec<[usize; 2]>,
    pub prune: bool,
    pub edge: f64,
    pub volume: f64,
}

/// `sim/geom.ts: pruneFlag`: Gauss-map pruning pays off when the full scan is more expensive than one arc test
/// per pair of edges.
fn prune_flag(nd: usize, nv: usize, ne: usize) -> bool {
    (nd * nd * nv * 6) as f64 > (2 * ne * ne * 20) as f64
}

/// `sim/geom.ts: prepShape`: the solid in internal units, multiplied by `scale` (default: inradius 1/2).
pub fn prep_shape(s: &Solid, scale: Option<f64>) -> Shape {
    let sc = scale.unwrap_or(0.5 / s.inradius);
    let v: Vec<Vec3> = (0..s.nv).map(|i| [s.v[3 * i] * sc, s.v[3 * i + 1] * sc, s.v[3 * i + 2] * sc]).collect();
    let n: Vec<Vec3> = (0..s.faces.len()).map(|f| [s.n[3 * f], s.n[3 * f + 1], s.n[3 * f + 2]]).collect();
    let beta: Vec<f64> = s.faces.iter().enumerate().map(|(i, f)| dot(&n[i], &v[f[0]])).collect();
    // one direction per line through the origin, in first-seen order
    let uniq = |list: Vec<Vec3>| {
        let mut out: Vec<Vec3> = Vec::new();
        for u in list {
            if !out.iter().any(|w| math::abs(dot(&u, w)) > 1.0 - 1e-9) {
                out.push(u);
            }
        }
        out
    };
    let faxes = uniq(n.clone());
    let edirs = uniq(
        s.edges
            .iter()
            .map(|&[i, j]| {
                let d = sub(&v[j], &v[i]);
                let l = hyp3(&d);
                [d[0] / l, d[1] / l, d[2] / l]
            })
            .collect(),
    );
    let fedges = s
        .faces
        .iter()
        .enumerate()
        .map(|(fi, f)| {
            f.iter()
                .enumerate()
                .map(|(t, &a)| {
                    let b = f[(t + 1) % f.len()];
                    let nn = n[fi];
                    let p = v[a];
                    let e = sub(&v[b], &p);
                    let m = cross(&nn, &e);
                    let l = hyp3(&m);
                    (p, [m[0] / l, m[1] / l, m[2] / l])
                })
                .collect()
        })
        .collect();
    let circ = math::max_of(&v.iter().map(|p| hyp3(p)).collect::<Vec<_>>());
    let emax = math::max_of(&s.edges.iter().map(|&[i, j]| hyp3(&sub(&v[j], &v[i]))).collect::<Vec<_>>());
    Shape {
        scale: sc,
        nv: v.len(),
        prune: prune_flag(edirs.len(), v.len(), s.edges.len()),
        v,
        faces: s.faces.clone(),
        n,
        beta,
        faxes,
        edirs,
        fedges,
        edges: s.edges.clone(),
        circ,
        emax,
        eface: s.edge_faces.clone(),
        edge: sc,
        volume: s.volume * math::powi(sc, 3),
    }
}

/// `sim/geom.ts: quatToR`: the rotation of a unit quaternion (no normalisation here).
pub fn quat_to_r(q: &[f64]) -> [f64; 9] {
    let (w, x, y, z) = (q[0], q[1], q[2], q[3]);
    [
        1.0 - 2.0 * (y * y + z * z),
        2.0 * (x * y - w * z),
        2.0 * (x * z + w * y),
        2.0 * (x * y + w * z),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z - w * x),
        2.0 * (x * z - w * y),
        2.0 * (y * z + w * x),
        1.0 - 2.0 * (x * x + y * y),
    ]
}

/// `sim/geom.ts: rotq`: q <- exp(omega) q for a world-frame rotation vector, normalised.
pub fn rotq(q: [f64; 4], wx: f64, wy: f64, wz: f64) -> [f64; 4] {
    let th = math::hypot3(wx, wy, wz);
    if th < 1e-16 {
        return q;
    }
    let h = th / 2.0;
    let sh = math::sin(h) / th;
    let dw = math::cos(h);
    let dx = wx * sh;
    let dy = wy * sh;
    let dz = wz * sh;
    let [w, x, y, z] = q;
    let r = [
        dw * w - dx * x - dy * y - dz * z,
        dw * x + dx * w + dy * z - dz * y,
        dw * y - dx * z + dy * w + dz * x,
        dw * z + dx * y - dy * x + dz * w,
    ];
    let m = math::hypot4(r[0], r[1], r[2], r[3]);
    [r[0] / m, r[1] / m, r[2] / m, r[3] / m]
}

/// The Gauss-map data of one edge of a placed piece (`sim/geom.ts: SimPose._E`): the unit normals a, b of its two
/// faces, c = b x a and the unit direction d = -c / |c| (None when the faces are parallel).
struct EdgeArc {
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Option<Vec3>,
}

/// `sim/geom.ts: SimPose`: world data of one piece.
pub struct SimPose<'a> {
    pub shape: &'a Shape,
    pub c: Vec3,
    pub r: [f64; 9],
    pub k: f64,
    /// World vertices, flat.
    pub x: Vec<f64>,
    pub fa: Vec<Vec3>,
    pub ed: Vec<Vec3>,
    pub fnn: Option<Vec<Vec3>>,
    /// Edge arcs, computed at the first edge-axis test of the pose.
    arcs: OnceCell<Vec<EdgeArc>>,
}

fn rot_by(r: &[f64; 9], u: &[f64]) -> Vec3 {
    [
        r[0] * u[0] + r[1] * u[1] + r[2] * u[2],
        r[3] * u[0] + r[4] * u[1] + r[5] * u[2],
        r[6] * u[0] + r[7] * u[1] + r[8] * u[2],
    ]
}

/// `sim/geom.ts: pose`: centre, rotation, core scale, world vertices, face axes and edge directions.
pub fn pose<'a>(shape: &'a Shape, c: &[f64], q: &[f64], k: f64) -> SimPose<'a> {
    let r = quat_to_r(q);
    let mut x = vec![0.0f64; 3 * shape.nv];
    for i in 0..shape.nv {
        let v = &shape.v[i];
        x[3 * i] = c[0] + k * (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
        x[3 * i + 1] = c[1] + k * (r[3] * v[0] + r[4] * v[1] + r[5] * v[2]);
        x[3 * i + 2] = c[2] + k * (r[6] * v[0] + r[7] * v[1] + r[8] * v[2]);
    }
    SimPose {
        shape,
        c: [c[0], c[1], c[2]],
        r,
        k,
        x,
        fa: shape.faxes.iter().map(|u| rot_by(&r, u)).collect(),
        ed: shape.edirs.iter().map(|u| rot_by(&r, u)).collect(),
        fnn: if shape.prune { Some(shape.n.iter().map(|u| rot_by(&r, u)).collect()) } else { None },
        arcs: OnceCell::new(),
    }
}

/// min, max, argmin, argmax of X . u over the first n vertices (`sim/geom.ts: proj`, which writes PR).
#[inline]
fn proj(x: &[f64], n: usize, u0: f64, u1: f64, u2: f64) -> (f64, f64, usize, usize) {
    let mut mn = f64::INFINITY;
    let mut mx = f64::NEG_INFINITY;
    let mut imn = 0;
    let mut imx = 0;
    for i in 0..n {
        let j = 3 * i;
        let p = x[j] * u0 + x[j + 1] * u1 + x[j + 2] * u2;
        if p < mn {
            mn = p;
            imn = i;
        }
        if p > mx {
            mx = p;
            imx = i;
        }
    }
    (mn, mx, imn, imx)
}

/// `sim/geom.ts: segDist2`: closest points between segments X1[a]-X1[b] and X2[c]-X2[e] (Ericson, Real-Time
/// Collision Detection 5.1.9); writes the two points into out[0..6] and returns their squared distance.
fn seg_dist2(x1: &[f64], a: usize, b: usize, x2: &[f64], c: usize, e: usize, out: &mut [f64; 6]) -> f64 {
    let p1x = x1[a];
    let p1y = x1[a + 1];
    let p1z = x1[a + 2];
    let p2x = x2[c];
    let p2y = x2[c + 1];
    let p2z = x2[c + 2];
    let d1x = x1[b] - p1x;
    let d1y = x1[b + 1] - p1y;
    let d1z = x1[b + 2] - p1z;
    let d2x = x2[e] - p2x;
    let d2y = x2[e + 1] - p2y;
    let d2z = x2[e + 2] - p2z;
    let rx = p1x - p2x;
    let ry = p1y - p2y;
    let rz = p1z - p2z;
    let aa = d1x * d1x + d1y * d1y + d1z * d1z;
    let ee = d2x * d2x + d2y * d2y + d2z * d2z;
    let ff = d2x * rx + d2y * ry + d2z * rz;
    let cc = d1x * rx + d1y * ry + d1z * rz;
    let bq = d1x * d2x + d1y * d2y + d1z * d2z;
    let den = aa * ee - bq * bq;
    let mut s = if den > 1e-14 * aa * ee { math::min(1.0, math::max(0.0, (bq * ff - cc * ee) / den)) } else { 0.0 };
    let mut t = (bq * s + ff) / ee;
    if t < 0.0 {
        t = 0.0;
        s = math::min(1.0, math::max(0.0, -cc / aa));
    } else if t > 1.0 {
        t = 1.0;
        s = math::min(1.0, math::max(0.0, (bq - cc) / aa));
    }
    out[0] = p1x + d1x * s;
    out[1] = p1y + d1y * s;
    out[2] = p1z + d1z * s;
    out[3] = p2x + d2x * t;
    out[4] = p2y + d2y * t;
    out[5] = p2z + d2z * t;
    let qx = out[0] - out[3];
    let qy = out[1] - out[4];
    let qz = out[2] - out[5];
    qx * qx + qy * qy + qz * qz
}

/// The module state of `sim/geom.ts` (`GR`, `lastAxis`) and scratch buffers reused between calls.
#[derive(Default)]
pub struct Sd {
    /// d sd / d [cA(3), wA(3), cB(3), wB(3)] of the last `sd_cores` call with `need_grad`.
    pub gr: [f64; 12],
    /// The best known separating direction A -> B of the last call, or None when the cores overlap.
    pub last_axis: Option<Vec3>,
    pa: Vec<f64>,
    pb: Vec<f64>,
}

/// `sim/geom.ts: Best` of `sdCores`: the least-overlap axis so far.
#[derive(Clone, Copy)]
struct BestAxis {
    u: Vec3,
    sg: f64,
    ia: usize,
    ib: usize,
    kind: Kind,
    i: Option<Vec3>,
    j: Option<Vec3>,
    l: f64,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    A,
    B,
    X,
}

/// The state of `sdCores`' closure `test`.
struct Sat {
    min_o: f64,
    best: Option<BestAxis>,
    sep_gap: f64,
    sep_u: Option<Vec3>,
}

impl Sat {
    /// `sdCores`' `test`: projects both pieces on the unit axis u; true when it separates them.
    fn test(&mut self, a: &SimPose, b: &SimPose, u: Vec3, kind: Kind, ea: Option<Vec3>, eb: Option<Vec3>, l: f64) -> bool {
        let (a_min, a_max, ai_min, ai_max) = proj(&a.x, a.shape.nv, u[0], u[1], u[2]);
        let (b_min, b_max, bi_min, bi_max) = proj(&b.x, b.shape.nv, u[0], u[1], u[2]);
        let o1 = a_max - b_min; // A below B along u
        let o2 = b_max - a_min; // A above B
        if o1 <= 0.0 || o2 <= 0.0 {
            let gap = if o1 <= 0.0 { -o1 } else { -o2 };
            if gap > self.sep_gap {
                self.sep_gap = gap;
                self.sep_u = Some(if o1 <= 0.0 { u } else { [-u[0], -u[1], -u[2]] });
            }
            return true;
        }
        let o = math::min(o1, o2);
        if o < self.min_o {
            self.min_o = o;
            self.best = Some(if o1 <= o2 {
                BestAxis { u, sg: 1.0, ia: ai_max, ib: bi_min, kind, i: ea, j: eb, l }
            } else {
                BestAxis { u: [-u[0], -u[1], -u[2]], sg: -1.0, ia: ai_min, ib: bi_max, kind, i: ea, j: eb, l }
            });
        }
        false
    }
}

/// `sim/geom.ts: sdCores`: signed distance between the cores of A and B: < 0 the penetration depth by the
/// separating-axis test, > 0 the Euclidean distance. Fills `ctx.gr`. If an axis already separates by >= cutoff,
/// returns that lower bound (no gradient). `hint`, a unit vector from A towards B that separated the pair recently,
/// is tried first. `Err` where the source throws (a TypeError when no axis gave a finite overlap).
pub fn sd_cores(
    ctx: &mut Sd,
    a: &SimPose,
    b: &SimPose,
    cutoff: f64,
    need_grad: bool,
    hint: Option<Vec3>,
) -> Result<f64, String> {
    let sa = a.shape;
    let sb = b.shape;
    let k = a.k;
    ctx.last_axis = None;
    if k <= 1e-12 {
        // cores are points
        let dd = sub(&a.c, &b.c);
        let h = hyp3(&dd);
        let d = if h == 0.0 || h.is_nan() { 1e-300 } else { h };
        ctx.gr = [0.0; 12];
        for t in 0..3 {
            ctx.gr[t] = dd[t] / d;
            ctx.gr[6 + t] = -dd[t] / d;
        }
        return Ok(d);
    }
    if let Some(h) = hint {
        let a_max = proj(&a.x, sa.nv, h[0], h[1], h[2]).1;
        let b_min = proj(&b.x, sb.nv, h[0], h[1], h[2]).0;
        let gap = b_min - a_max;
        if gap > 0.0 {
            if gap >= cutoff {
                ctx.last_axis = Some(h);
                return Ok(gap);
            }
            let r = dist_separated(ctx, a, b, h, gap, need_grad);
            ctx.last_axis = Some([(r.pb[0] - r.pa[0]) / r.d, (r.pb[1] - r.pa[1]) / r.d, (r.pb[2] - r.pa[2]) / r.d]);
            return Ok(r.d);
        }
    }
    let mut sat = Sat { min_o: f64::INFINITY, best: None, sep_gap: f64::NEG_INFINITY, sep_u: None };
    let mut sep = false;
    for i in 0..a.fa.len() {
        if sat.test(a, b, a.fa[i], Kind::A, None, None, 1.0) {
            sep = true;
        }
    }
    for i in 0..b.fa.len() {
        if sat.test(a, b, b.fa[i], Kind::B, None, None, 1.0) {
            sep = true;
        }
    }
    if !sep {
        if sa.prune || sb.prune {
            edge_axes(a, b, &mut |ea, eb| {
                let w = cross(&ea, &eb);
                let l = math::hypot3(w[0], w[1], w[2]);
                if l < 1e-9 {
                    return false;
                }
                if sat.test(a, b, [w[0] / l, w[1] / l, w[2] / l], Kind::X, Some(ea), Some(eb), l) {
                    sep = true;
                    return true;
                }
                false
            });
        } else {
            let mut i = 0;
            while i < a.ed.len() && !sep {
                for j in 0..b.ed.len() {
                    let w = cross(&a.ed[i], &b.ed[j]);
                    let l = math::hypot3(w[0], w[1], w[2]);
                    if l < 1e-9 {
                        continue;
                    }
                    if sat.test(a, b, [w[0] / l, w[1] / l, w[2] / l], Kind::X, Some(a.ed[i]), Some(b.ed[j]), l) {
                        sep = true;
                        break;
                    }
                }
                i += 1;
            }
        }
    }
    if sep {
        let su = sat.sep_u.expect("a separating axis");
        if sat.sep_gap >= cutoff {
            ctx.last_axis = Some(su);
            return Ok(sat.sep_gap);
        }
        let r = dist_separated(ctx, a, b, su, sat.sep_gap, need_grad);
        ctx.last_axis = Some([(r.pb[0] - r.pa[0]) / r.d, (r.pb[1] - r.pa[1]) / r.d, (r.pb[2] - r.pa[2]) / r.d]);
        return Ok(r.d);
    }
    if !need_grad {
        return Ok(-sat.min_o);
    }
    // penetration o = h_A(u) + h_B(-u) along the oriented best axis u; sd = -o
    let Some(bb) = sat.best else {
        return Err("Cannot read properties of null (reading 'u')".to_string());
    };
    let u = bb.u;
    let pa = vx(&a.x, bb.ia);
    let pb = vx(&b.x, bb.ib);
    let g = sub(&pa, &pb);
    let mut da = cross(&sub(&pa, &a.c), &u);
    let mut db = cross(&sub(&pb, &b.c), &u);
    db = [-db[0], -db[1], -db[2]];
    if bb.kind == Kind::A {
        let t = cross(&u, &g);
        da = [da[0] + t[0], da[1] + t[1], da[2] + t[2]];
    } else if bb.kind == Kind::B {
        let t = cross(&u, &g);
        db = [db[0] + t[0], db[1] + t[1], db[2] + t[2]];
    } else {
        let ea = bb.i.expect("edge direction");
        let eb = bb.j.expect("edge direction");
        let ug = dot(&u, &g);
        let h = [
            (bb.sg * (g[0] - u[0] * ug)) / bb.l,
            (bb.sg * (g[1] - u[1] * ug)) / bb.l,
            (bb.sg * (g[2] - u[2] * ug)) / bb.l,
        ];
        let ta = cross(&ea, &cross(&eb, &h));
        let tb = cross(&eb, &cross(&h, &ea));
        da = [da[0] + ta[0], da[1] + ta[1], da[2] + ta[2]];
        db = [db[0] + tb[0], db[1] + tb[1], db[2] + tb[2]];
    }
    for t in 0..3 {
        ctx.gr[t] = -u[t];
        ctx.gr[3 + t] = -da[t];
        ctx.gr[6 + t] = u[t];
        ctx.gr[9 + t] = -db[t];
    }
    Ok(-sat.min_o)
}

/// `sim/geom.ts: edgeAxes`: edge-edge separating-axis candidates with Gauss-map pruning (D. Gregorius, GDC 2013);
/// `f(ea, eb)` gets unit world edge directions and returns true to stop.
pub fn edge_axes(a: &SimPose, b: &SimPose, f: &mut dyn FnMut(Vec3, Vec3) -> bool) {
    let prep = |p: &SimPose| -> Vec<EdgeArc> {
        let sh = p.shape;
        let fns: Vec<Vec3> = match &p.fnn {
            Some(v) => v.clone(),
            None => sh.n.iter().map(|u| rot_by(&p.r, u)).collect(),
        };
        sh.eface
            .iter()
            .map(|&[f1, f2]| {
                let na = fns[f1];
                let nb = fns[f2];
                let c = cross(&nb, &na);
                let l = math::hypot3(c[0], c[1], c[2]);
                EdgeArc { a: na, b: nb, c, d: if l > 1e-12 { Some([-c[0] / l, -c[1] / l, -c[2] / l]) } else { None } }
            })
            .collect()
    };
    let ea = a.arcs.get_or_init(|| prep(a));
    let eb = b.arcs.get_or_init(|| prep(b));
    for p in ea.iter() {
        let Some(pd) = p.d else { continue };
        for q in eb.iter() {
            let Some(qd) = q.d else { continue };
            let cba = -(q.a[0] * p.c[0] + q.a[1] * p.c[1] + q.a[2] * p.c[2]);
            let dba = -(q.b[0] * p.c[0] + q.b[1] * p.c[1] + q.b[2] * p.c[2]);
            if cba * dba >= 0.0 {
                continue;
            }
            let adc = p.a[0] * q.c[0] + p.a[1] * q.c[1] + p.a[2] * q.c[2];
            let bdc = p.b[0] * q.c[0] + p.b[1] * q.c[1] + p.b[2] * q.c[2];
            if adc * bdc >= 0.0 || cba * bdc <= 0.0 {
                continue;
            }
            if f(pd, qd) {
                return;
            }
        }
    }
}

struct Dist {
    d: f64,
    pa: Vec3,
    pb: Vec3,
}

/// `distSeparated`'s `vertFace`: the vertex x (a world point) against the faces of polytope Y lying in Y's slab;
/// the closest point on Y, or None.
fn vert_face(x: Vec3, y: &SimPose, face_ok: &[bool]) -> Option<Vec3> {
    let sy = y.shape;
    let r = &y.r;
    let kk = y.k;
    let dx = x[0] - y.c[0];
    let dy = x[1] - y.c[1];
    let dz = x[2] - y.c[2];
    let yy = [
        (r[0] * dx + r[3] * dy + r[6] * dz) / kk,
        (r[1] * dx + r[4] * dy + r[7] * dz) / kk,
        (r[2] * dx + r[5] * dy + r[8] * dz) / kk,
    ];
    let mut bestq: Option<Vec3> = None;
    let mut bestt = f64::INFINITY;
    for f in 0..sy.faces.len() {
        if !face_ok[f] {
            continue;
        }
        let n = &sy.n[f];
        let t = dot(n, &yy) - sy.beta[f];
        if t <= 0.0 || t >= bestt {
            continue;
        }
        let mut inside = true;
        for (p, m) in &sy.fedges[f] {
            if (yy[0] - p[0]) * m[0] + (yy[1] - p[1]) * m[1] + (yy[2] - p[2]) * m[2] < 0.0 {
                inside = false;
                break;
            }
        }
        if !inside {
            continue;
        }
        bestt = t;
        let nw = [
            r[0] * n[0] + r[1] * n[1] + r[2] * n[2],
            r[3] * n[0] + r[4] * n[1] + r[5] * n[2],
            r[6] * n[0] + r[7] * n[1] + r[8] * n[2],
        ];
        bestq = Some([x[0] - kk * t * nw[0], x[1] - kk * t * nw[1], x[2] - kk * t * nw[2]]);
    }
    bestq
}

/// `sim/geom.ts: distSeparated`: exact distance between disjoint cores. u: unit axis with max_A u.x + gap <=
/// min_B u.x (gap > 0). The closest pair lies in the slabs u.x >= h_A - delta (on A) and u.x <= m_B + delta (on B),
/// delta = D - gap, where D is any upper bound on the distance; every candidate feature pair touching the slabs is
/// enumerated: vertex of A / face of B, face of A / vertex of B, edge of A / edge of B.
fn dist_separated(ctx: &mut Sd, a: &SimPose, b: &SimPose, u: Vec3, _gap: f64, need_grad: bool) -> Dist {
    let sa = a.shape;
    let sb = b.shape;
    let k = a.k;
    ctx.pa.clear();
    ctx.pa.resize(sa.nv, 0.0);
    ctx.pb.clear();
    ctx.pb.resize(sb.nv, 0.0);
    let mut h_a = f64::NEG_INFINITY;
    let mut m_b = f64::INFINITY;
    let mut ia = 0;
    let mut ib = 0;
    for i in 0..sa.nv {
        let p = a.x[3 * i] * u[0] + a.x[3 * i + 1] * u[1] + a.x[3 * i + 2] * u[2];
        ctx.pa[i] = p;
        if p > h_a {
            h_a = p;
            ia = i;
        }
    }
    for i in 0..sb.nv {
        let p = b.x[3 * i] * u[0] + b.x[3 * i + 1] * u[1] + b.x[3 * i + 2] * u[2];
        ctx.pb[i] = p;
        if p < m_b {
            m_b = p;
            ib = i;
        }
    }
    let mut pa = vx(&a.x, ia);
    let mut pb = vx(&b.x, ib);
    let mut d2 = (pa[0] - pb[0]) * (pa[0] - pb[0]) + (pa[1] - pb[1]) * (pa[1] - pb[1]) + (pa[2] - pb[2]) * (pa[2] - pb[2]);
    let delta = d2.sqrt() - (m_b - h_a) + 1e-12 * (1.0 + d2.sqrt());
    let th_a = h_a - delta;
    let th_b = m_b + delta;
    let pa_ = std::mem::take(&mut ctx.pa);
    let pb_ = std::mem::take(&mut ctx.pb);
    let fa: Vec<bool> = sa.faces.iter().map(|f| f.iter().any(|&i| pa_[i] >= th_a)).collect();
    let fb: Vec<bool> = sb.faces.iter().map(|f| f.iter().any(|&i| pb_[i] <= th_b)).collect();
    let consider = |p: Vec3, q: Vec3, d2: &mut f64, pa: &mut Vec3, pb: &mut Vec3| {
        let dd = (p[0] - q[0]) * (p[0] - q[0]) + (p[1] - q[1]) * (p[1] - q[1]) + (p[2] - q[2]) * (p[2] - q[2]);
        if dd < *d2 {
            *d2 = dd;
            *pa = p;
            *pb = q;
        }
    };
    for i in 0..sa.nv {
        if pa_[i] >= th_a {
            let x = vx(&a.x, i);
            if let Some(q) = vert_face(x, b, &fb) {
                consider(x, q, &mut d2, &mut pa, &mut pb);
            }
        }
    }
    for i in 0..sb.nv {
        if pb_[i] <= th_b {
            let x = vx(&b.x, i);
            if let Some(q) = vert_face(x, a, &fa) {
                consider(q, x, &mut d2, &mut pa, &mut pb);
            }
        }
    }
    // the vertex-face candidates gave a better upper bound D; the slab argument holds for any D >= d, so re-slab
    let delta2 = d2.sqrt() - (m_b - h_a) + 1e-12 * (1.0 + d2.sqrt());
    let th_a2 = h_a - delta2;
    let th_b2 = m_b + delta2;
    let e_a: Vec<[usize; 2]> = sa.edges.iter().copied().filter(|&[i, j]| pa_[i] >= th_a2 || pa_[j] >= th_a2).collect();
    let e_b: Vec<[usize; 2]> = sb.edges.iter().copied().filter(|&[i, j]| pb_[i] <= th_b2 || pb_[j] <= th_b2).collect();
    let xa = &a.x;
    let xb = &b.x;
    let half_sum = 0.5 * k * (sa.emax + sb.emax) * (1.0 + 1e-12);
    let mut seg = [0.0f64; 6];
    for &[i1, j1] in &e_a {
        let ai = 3 * i1;
        let bi = 3 * j1;
        let mx1 = 0.5 * (xa[ai] + xa[bi]);
        let my1 = 0.5 * (xa[ai + 1] + xa[bi + 1]);
        let mz1 = 0.5 * (xa[ai + 2] + xa[bi + 2]);
        for &[i2, j2] in &e_b {
            let c = 3 * i2;
            let e = 3 * j2;
            // segment distance >= |m1 - m2| - (l1 + l2)/2: skip pairs that cannot be strictly closer than the best so far
            let ex = mx1 - 0.5 * (xb[c] + xb[e]);
            let ey = my1 - 0.5 * (xb[c + 1] + xb[e + 1]);
            let ez = mz1 - 0.5 * (xb[c + 2] + xb[e + 2]);
            let lb = d2.sqrt() + half_sum;
            if ex * ex + ey * ey + ez * ez >= lb * lb {
                continue;
            }
            let dd = seg_dist2(xa, ai, bi, xb, c, e, &mut seg);
            if dd < d2 {
                d2 = dd;
                pa = [seg[0], seg[1], seg[2]];
                pb = [seg[3], seg[4], seg[5]];
            }
        }
    }
    ctx.pa = pa_;
    ctx.pb = pb_;
    let sq = d2.sqrt();
    let d = if sq == 0.0 || sq.is_nan() { 1e-300 } else { sq };
    if need_grad {
        let n = [(pa[0] - pb[0]) / d, (pa[1] - pb[1]) / d, (pa[2] - pb[2]) / d];
        let ta = cross(&sub(&pa, &a.c), &n);
        let tb = cross(&sub(&pb, &b.c), &n);
        for t in 0..3 {
            ctx.gr[t] = n[t];
            ctx.gr[3 + t] = ta[t];
            ctx.gr[6 + t] = -n[t];
            ctx.gr[9 + t] = -tb[t];
        }
    }
    Dist { d, pa, pb }
}

/// `sim/geom.ts: overlaps`: boolean SAT overlap test (true if the interiors overlap by more than tol along every
/// axis).
pub fn overlaps(a: &SimPose, b: &SimPose, tol: f64) -> bool {
    let sa = a.shape;
    let sb = b.shape;
    let chk = |u: Vec3| -> bool {
        let (a_min, a_max, _, _) = proj(&a.x, sa.nv, u[0], u[1], u[2]);
        let (b_min, b_max, _, _) = proj(&b.x, sb.nv, u[0], u[1], u[2]);
        math::min(a_max - b_min, b_max - a_min) > tol
    };
    for u in &a.fa {
        if !chk(*u) {
            return false;
        }
    }
    for u in &b.fa {
        if !chk(*u) {
            return false;
        }
    }
    if sa.prune || sb.prune {
        let mut res = true;
        edge_axes(a, b, &mut |ea, eb| {
            let w = cross(&ea, &eb);
            let l = hyp3(&w);
            if l < 1e-9 {
                return false;
            }
            if !chk([w[0] / l, w[1] / l, w[2] / l]) {
                res = false;
                return true;
            }
            false
        });
        return res;
    }
    for ea in &a.ed {
        for eb in &b.ed {
            let w = cross(ea, eb);
            let l = hyp3(&w);
            if l < 1e-9 {
                continue;
            }
            if !chk([w[0] / l, w[1] / l, w[2] / l]) {
                return false;
            }
        }
    }
    true
}
