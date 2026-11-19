//! Sequential linear programming polish ("contact LP"). Port of
//! `packages/surface/src/search/slp.ts`.
//!
//! From a valid packing at scale lam, it linearises every near contact (part-part separations,
//! cone-point clearances, and for disks the developed centre distances) by finite differences and
//! solves
//!   maximise d_lam  subject to  value_k + J_k . d >= 0,  |d_i| <= trust,
//! then accepts the step only if the true packing is valid (every value >= -accept); otherwise the
//! trust region shrinks. Contacts are keyed by the chains (edge paths) of the parts involved, so the
//! same contact is followed under small moves.

use super::chains;
use super::energy::{canonicalize, part_sep};
use crate::chains::{chain_path, in_wedge, ChainNode};
use crate::geometry::{bounding_radius, inradius};
use crate::parts::{piece_outline, piece_parts, HalfPlanes, SurfacePose};
use crate::rigid::apply;
use crate::solids::{face_vertex, Solid};
use polypack_js::math;
use polypack_js::math::PI;
use std::collections::HashMap;
use std::rc::Rc;

struct GPart {
    key: String,
    face: usize,
    poly: Vec<f64>,
    cuts: HalfPlanes,
}

/// `slp.ts: PieceGeom`.
pub struct PieceGeom {
    nodes: Vec<ChainNode>,
    parts: Vec<GPart>,
}

/// An insertion-ordered map from a contact's key to its value (a JavaScript Map of string to
/// number: setting an existing key keeps its place).
#[derive(Default)]
pub struct Values {
    keys: Vec<String>,
    vals: Vec<f64>,
    idx: HashMap<String, usize>,
}

impl Values {
    fn set(&mut self, key: String, v: f64) {
        if let Some(&i) = self.idx.get(&key) {
            self.vals[i] = v;
        } else {
            self.idx.insert(key.clone(), self.keys.len());
            self.keys.push(key);
            self.vals.push(v);
        }
    }
    fn get(&self, key: &str) -> Option<f64> {
        self.idx.get(key).map(|&i| self.vals[i])
    }
    fn len(&self) -> usize {
        self.keys.len()
    }
}

/// `slp.ts: pathKey`.
fn path_key(nodes: &[ChainNode], idx: usize) -> String {
    let path = chain_path(nodes, idx);
    let parts: Vec<String> = path.iter().map(|(f, e)| format!("{f}.{e}")).collect();
    parts.join("|")
}

/// `slp.ts: geomOf`.
fn geom_of(solid: &Solid, n: usize, lam: f64, p: &SurfacePose, i: usize, nofold: bool) -> Rc<PieceGeom> {
    if nofold {
        if n == 0 {
            return Rc::new(PieceGeom { nodes: Vec::new(), parts: Vec::new() });
        }
        let o = piece_outline(n, p, lam);
        let cuts = HalfPlanes { nx: o.nx, ny: o.ny, b: o.b };
        return Rc::new(PieceGeom {
            nodes: Vec::new(),
            parts: vec![GPart { key: String::new(), face: p.face_index(), poly: o.poly, cuts }],
        });
    }
    if n == 0 {
        let nodes = chains(solid, 1.0, p.face_index(), p.x, p.y, 2.0 * lam);
        return Rc::new(PieceGeom { nodes, parts: Vec::new() });
    }
    let nodes = chains(solid, 1.0, p.face_index(), p.x, p.y, lam * bounding_radius(n));
    let mut parts = Vec::new();
    for q in piece_parts(solid, 1.0, n, p, i, lam, &nodes) {
        if q.poly.len() >= 6 {
            parts.push(GPart { key: path_key(&nodes, q.chain), face: q.face, poly: q.poly, cuts: q.cuts });
        }
    }
    Rc::new(PieceGeom { nodes, parts })
}

fn gpart_sep(a: &GPart, b: &GPart) -> f64 {
    part_sep(&a.poly, &a.cuts, &b.poly, &b.cuts)
}

/// `slp.ts: valuesFold`. Constraint values involving piece i (all of them when `only` is None), keyed.
#[allow(clippy::too_many_arguments)]
fn values_fold(solid: &Solid, n: usize, lam: f64, poses: &[SurfacePose], g: &[Rc<PieceGeom>], only: Option<usize>, thr: f64, out: &mut Values) {
    let pc = poses.len();
    let rin = if n == 0 { lam } else { inradius(n) * lam };
    let pieces: Vec<usize> = match only {
        None => (0..pc).collect(),
        Some(o) => vec![o],
    };
    for i in pieces {
        let p = poses[i];
        // cone points
        for (ni, node) in g[i].nodes.iter().enumerate() {
            for k in 0..solid.sides[node.face] {
                let (fx, fy) = face_vertex(solid, 1.0, node.face, k);
                let (vx, vy) = apply(&node.to_anchor, fx, fy);
                if !in_wedge(node.wedge.as_ref(), p.x, p.y, vx, vy, 1e-12) {
                    continue;
                }
                let v;
                if n == 0 {
                    v = math::hypot(vx - p.x, vy - p.y) - lam;
                } else {
                    let mut m = f64::NEG_INFINITY;
                    for j in 0..n {
                        let a = p.theta + PI / 2.0 + PI / n as f64 + (2.0 * PI * j as f64) / n as f64;
                        m = math::max(m, (vx - p.x) * math::cos(a) + (vy - p.y) * math::sin(a) - rin);
                    }
                    v = m;
                }
                if v < thr {
                    out.set(format!("c{}:{}:{}", i, path_key(&g[i].nodes, ni), k), v);
                }
            }
        }
        if n == 0 {
            // developed images of every centre (pairs and loops)
            for (ni, node) in g[i].nodes.iter().enumerate() {
                for j in 0..pc {
                    if poses[j].face != node.face as f64 || (j == i && ni == 0) {
                        continue;
                    }
                    let (qx, qy) = apply(&node.to_anchor, poses[j].x, poses[j].y);
                    if !in_wedge(node.wedge.as_ref(), p.x, p.y, qx, qy, 1e-12) {
                        continue;
                    }
                    let v = math::hypot(qx - p.x, qy - p.y) - 2.0 * lam;
                    if v < thr {
                        // the same geodesic is seen from both ends; key it from the smaller index
                        if j < i && only.is_none() {
                            continue;
                        }
                        out.set(format!("d{}:{}:{}:{}", i.min(j), i.max(j), i, path_key(&g[i].nodes, ni)), v);
                    }
                }
            }
            continue;
        }
        for a in 0..g[i].parts.len() {
            let pa = &g[i].parts[a];
            for j in 0..pc {
                if j < i && only.is_none() {
                    continue;
                }
                let parts = &g[j].parts;
                for b in 0..parts.len() {
                    if j == i && b <= a {
                        continue;
                    }
                    let pb = &parts[b];
                    if pb.face != pa.face {
                        continue;
                    }
                    let v = gpart_sep(pa, pb);
                    if v < thr {
                        let key = if i < j || (i == j && a < b) {
                            format!("p{}:{}:{}:{}", i, pa.key, j, pb.key)
                        } else {
                            format!("p{}:{}:{}:{}", j, pb.key, i, pa.key)
                        };
                        out.set(key, v);
                    }
                }
            }
        }
    }
}

/// `slp.ts: valuesNofold`. Constraint values of the nofold mode: each piece's clearance to every
/// edge line of its face (piece vertices, or the disk's centre minus lam) and the separation of
/// pieces on one face.
#[allow(clippy::too_many_arguments)]
fn values_nofold(solid: &Solid, n: usize, lam: f64, poses: &[SurfacePose], g: &[Rc<PieceGeom>], only: Option<usize>, thr: f64, out: &mut Values) {
    let pc = poses.len();
    let pieces: Vec<usize> = match only {
        None => (0..pc).collect(),
        Some(o) => vec![o],
    };
    for i in pieces {
        let p = poses[i];
        let face = p.face_index();
        let m = solid.sides[face];
        for j in 0..m {
            let (ax, ay) = face_vertex(solid, 1.0, face, j);
            let (bx, by) = face_vertex(solid, 1.0, face, j + 1);
            let l = math::hypot(bx - ax, by - ay);
            let nx = -(by - ay) / l;
            let ny = (bx - ax) / l;
            let v;
            if n == 0 {
                v = nx * (p.x - ax) + ny * (p.y - ay) - lam;
            } else {
                let mut mv = f64::INFINITY;
                let poly = &g[i].parts[0].poly;
                let mut t = 0;
                while t < poly.len() {
                    mv = math::min(mv, nx * (poly[t] - ax) + ny * (poly[t + 1] - ay));
                    t += 2;
                }
                v = mv;
            }
            if v < thr {
                out.set(format!("w{}:{}:{}", i, face, j), v);
            }
        }
        for j in 0..pc {
            if j == i || poses[j].face != p.face || (j < i && only.is_none()) {
                continue;
            }
            let q = poses[j];
            let v = if n == 0 { math::hypot(q.x - p.x, q.y - p.y) - 2.0 * lam } else { gpart_sep(&g[i].parts[0], &g[j].parts[0]) };
            if v < thr {
                out.set(format!("q{}:{}:{}", i.min(j), i.max(j), face), v);
            }
        }
    }
}

/// `slp.ts: simplex`. Dense simplex for: maximise c.z subject to A z <= b, z >= 0, with b >= 0
/// (Bland's rule). `should_stop` is polled every 8 pivots; true gives up (None, as for an
/// unbounded LP).
pub fn simplex(a: &[Vec<f64>], b: &[f64], c: &[f64], max_pivots: usize, should_stop: &dyn Fn() -> bool) -> Option<Vec<f64>> {
    let m = a.len();
    let n = c.len();
    // tableau rows: [A | I | b], objective row: [-c | 0 | 0]
    let w = n + m + 1;
    let mut t: Vec<Vec<f64>> = Vec::with_capacity(m);
    for r in 0..m {
        let mut row = vec![0.0; w];
        for j in 0..n {
            row[j] = a[r][j];
        }
        row[n + r] = 1.0;
        row[w - 1] = b[r];
        t.push(row);
    }
    let mut obj = vec![0.0; w];
    for j in 0..n {
        obj[j] = -c[j];
    }
    let mut basis: Vec<usize> = (0..m).map(|r| n + r).collect();
    let mut nz_idx: Vec<usize> = vec![0; w];
    for it in 0..max_pivots {
        if (it & 7) == 7 && should_stop() {
            return None;
        }
        let mut col: i64 = -1;
        for j in 0..w - 1 {
            if obj[j] < -1e-12 {
                col = j as i64;
                break;
            }
        }
        if col < 0 {
            break;
        }
        let col = col as usize;
        let mut row: i64 = -1;
        let mut best = f64::INFINITY;
        for r in 0..m {
            let av = t[r][col];
            if av > 1e-12 {
                let q = t[r][w - 1] / av;
                if q < best - 1e-15 || ((q - best).abs() <= 1e-15 && row >= 0 && basis[r] < basis[row as usize]) {
                    best = q;
                    row = r as i64;
                }
            }
        }
        if row < 0 {
            return None; // unbounded
        }
        let row = row as usize;
        let pv = t[row][col];
        // the pivot row is mostly zeros; the elimination below visits its nonzero entries only
        let mut nz = 0;
        for j in 0..w {
            t[row][j] /= pv;
            if t[row][j] != 0.0 {
                nz_idx[nz] = j;
                nz += 1;
            }
        }
        let pr = t[row].clone();
        for r in 0..m {
            if r == row {
                continue;
            }
            let f = t[r][col];
            if f != 0.0 {
                let tr = &mut t[r];
                for q in 0..nz {
                    let j = nz_idx[q];
                    tr[j] -= f * pr[j];
                }
            }
        }
        let f = obj[col];
        if f != 0.0 {
            for q in 0..nz {
                let j = nz_idx[q];
                obj[j] -= f * pr[j];
            }
        }
        basis[row] = col;
    }
    let mut z = vec![0.0; n];
    for (r, &v) in basis.iter().enumerate() {
        if v < n {
            z[v] = t[r][w - 1];
        }
    }
    Some(z)
}

pub struct SlpResult {
    pub lam: f64,
    pub poses: Vec<SurfacePose>,
    pub iterations: usize,
}

/// `slp.ts: slpPolish`. Polish a valid packing (pieces scaled by lam on the unit solid). Returns a
/// packing that is valid with every constraint value >= -max(accept, the start's worst overlap)
/// (accept defaults to 1e-14) and lam at least the input's. `should_stop` is polled before every
/// iteration and also inside one (per piece of the derivatives, in the LP, per trial step); true
/// returns the last accepted packing.
pub fn slp_polish(
    solid: &Solid,
    n: usize,
    lam0: f64,
    poses0: &[SurfacePose],
    iterations: usize,
    should_stop: &dyn Fn() -> bool,
    nofold: bool,
) -> SlpResult {
    let mut lam = lam0;
    let pc = poses0.len();
    let dim = if n == 0 { 2 } else { 3 };
    let accept = 1e-14;
    let geom = |l: f64, p: &SurfacePose, i: usize| geom_of(solid, n, l, p, i, nofold);
    let values = |l: f64, ps: &[SurfacePose], gs: &[Rc<PieceGeom>], only: Option<usize>, thr: f64, out: &mut Values| {
        if nofold {
            values_nofold(solid, n, l, ps, gs, only, thr, out)
        } else {
            values_fold(solid, n, l, ps, gs, only, thr, out)
        }
    };
    let mut poses: Vec<SurfacePose> = poses0.iter().map(|p| canonicalize(solid, 1.0, p)).collect();
    let mut gg: Vec<Rc<PieceGeom>> = poses.iter().enumerate().map(|(i, p)| geom(lam, p, i)).collect();
    // steps may not make the worst overlap worse than at the start (which may carry rounding-level overlaps)
    let accept_worst;
    {
        let mut worst0 = 0.0;
        let mut m0 = Values::default();
        values(lam, &poses, &gg, None, 0.0, &mut m0);
        for &v in &m0.vals {
            worst0 = math::min(worst0, v);
        }
        accept_worst = math::max(accept, -worst0 * 1.0001);
    }
    let r = if n == 0 { 1.0 } else { bounding_radius(n) };
    let mut trust = 0.02 * lam;
    let h = 1e-7 * lam;
    let mut it = 0;
    let all_values = |l: f64, ps: &[SurfacePose], gs: &[Rc<PieceGeom>], thr: f64| {
        let mut m = Values::default();
        values(l, ps, gs, None, thr, &mut m);
        m
    };
    'outer: while it < iterations {
        if should_stop() {
            break;
        }
        'body: {
            let thr = math::max(4.0 * trust, 1e-6) * math::max(1.0, r);
            let base = all_values(lam, &poses, &gg, thr);
            if base.len() == 0 {
                // nothing nearby (or contacts not yet visible: a piece flush with an edge has no part across
                // it until it moves): try growing within the trust region, checked like any other step
                let l2 = lam * (1.0 + trust);
                let gs: Vec<Rc<PieceGeom>> = poses.iter().enumerate().map(|(i, p)| geom(l2, p, i)).collect();
                let mut worst = 0.0;
                for &v in &all_values(l2, &poses, &gs, 0.0).vals {
                    worst = math::min(worst, v);
                }
                if worst >= -accept_worst {
                    lam = l2;
                    gg = gs;
                } else {
                    trust *= 0.25;
                    if trust < 1e-13 * lam {
                        break 'outer;
                    }
                }
                break 'body;
            }
            let keys: &Vec<String> = &base.keys;
            let kidx: &HashMap<String, usize> = &base.idx;
            let nv = dim * pc + 1;
            let mut jac: Vec<Vec<f64>> = keys.iter().map(|_| vec![0.0; nv]).collect();
            // derivatives in each piece's variables
            let mut stopped = false;
            for i in 0..pc {
                if should_stop() {
                    stopped = true;
                    break;
                }
                for c in 0..dim {
                    let mut q = poses[i];
                    if c == 0 {
                        q.x += h;
                    } else if c == 1 {
                        q.y += h;
                    } else {
                        q.theta += h / (r * lam);
                    }
                    let qc = canonicalize(solid, 1.0, &q);
                    let mut ps = poses.clone();
                    ps[i] = qc;
                    let mut gs = gg.clone();
                    gs[i] = geom(lam, &qc, i);
                    let mut m = Values::default();
                    values(lam, &ps, &gs, Some(i), f64::INFINITY, &mut m);
                    // contacts seen from the other pieces (disk images keyed from i, self pairs included)
                    for (ki, k) in m.keys.iter().enumerate() {
                        if let Some(&t) = kidx.get(k) {
                            jac[t][dim * i + c] = (m.vals[ki] - base.vals[t]) / h;
                        }
                    }
                    // keys owned by other pieces that involve i: recompute those pieces' view
                    // (nofold: every key that involves i is computed from i's view above)
                    if n == 0 && !nofold {
                        for j in 0..pc {
                            if j == i {
                                continue;
                            }
                            let mut mj = Values::default();
                            values(lam, &ps, &gs, Some(j), f64::INFINITY, &mut mj);
                            for (ki, k) in mj.keys.iter().enumerate() {
                                if let Some(&t) = kidx.get(k) {
                                    if k.starts_with('d') && jac[t][dim * i + c] == 0.0 {
                                        let d = (mj.vals[ki] - base.vals[t]) / h;
                                        if d != 0.0 {
                                            jac[t][dim * i + c] = d;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if stopped {
                break 'outer;
            }
            // derivative in lam
            {
                let l2 = lam * (1.0 + 1e-7);
                let gs: Vec<Rc<PieceGeom>> = poses.iter().enumerate().map(|(i, p)| geom(l2, p, i)).collect();
                let m = all_values(l2, &poses, &gs, f64::INFINITY);
                for (t, k) in keys.iter().enumerate() {
                    if let Some(v) = m.get(k) {
                        jac[t][nv - 1] = (v - base.vals[t]) / (l2 - lam);
                    }
                }
            }
            // LP in z = d+ - d- (all >= 0), bounds as rows
            let nn = 2 * nv;
            let mut a: Vec<Vec<f64>> = Vec::new();
            let mut b: Vec<f64> = Vec::new();
            for (t, _k) in keys.iter().enumerate() {
                let mut row = vec![0.0; nn];
                for v in 0..nv {
                    row[v] = -jac[t][v];
                    row[nv + v] = jac[t][v];
                }
                a.push(row);
                b.push(math::max(0.0, base.vals[t]));
            }
            for v in 0..nv {
                let bound = if v == nv - 1 { trust * lam } else { trust };
                for side in [0usize, 1] {
                    let mut row = vec![0.0; nn];
                    row[side * nv + v] = 1.0;
                    a.push(row);
                    b.push(bound);
                }
            }
            let mut c = vec![0.0; nn];
            c[nv - 1] = 1.0;
            c[2 * nv - 1] = -1.0;
            let z = simplex(&a, &b, &c, 5000, should_stop);
            let Some(z) = z else {
                if should_stop() {
                    break 'outer;
                }
                trust *= 0.5;
                if trust < 1e-13 * lam {
                    break 'outer;
                }
                break 'body;
            };
            // guard against numerical trouble in the dense simplex: the step must respect its bounds and
            // (to rounding) the linearised constraints, else it is discarded
            let d: Vec<f64> = (0..nv).map(|v| z[v] - z[nv + v]).collect();
            let mut bad = d.iter().enumerate().any(|(idx, &v)| !v.is_finite() || v.abs() > (if idx == nv - 1 { trust * lam } else { trust }) * (1.0 + 1e-9));
            for t in 0..keys.len() {
                let mut lin = base.vals[t];
                for v in 0..nv {
                    lin += jac[t][v] * d[v];
                }
                if lin < -1e-9 * math::max(1.0, trust) {
                    bad = true;
                }
            }
            if bad {
                trust *= 0.5;
                if trust < 1e-13 * lam {
                    break 'outer;
                }
                break 'body;
            }
            if d[nv - 1] <= 1e-15 * lam {
                trust *= 0.5;
                if trust < 1e-13 * lam {
                    break 'outer;
                }
                break 'body;
            }
            // try the step, halving it until the true packing is valid
            let mut ok = false;
            let mut t = 1.0;
            while t >= 1.0 / 64.0 {
                if t < 1.0 && should_stop() {
                    break;
                }
                let l2 = lam + t * d[nv - 1];
                let ps: Vec<SurfacePose> = poses
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        canonicalize(
                            solid,
                            1.0,
                            &SurfacePose {
                                face: p.face,
                                x: p.x + t * d[dim * i],
                                y: p.y + t * d[dim * i + 1],
                                theta: if dim == 3 { p.theta + (t * d[dim * i + 2]) / (r * lam) } else { p.theta },
                            },
                        )
                    })
                    .collect();
                let gs: Vec<Rc<PieceGeom>> = ps.iter().enumerate().map(|(i, p)| geom(l2, p, i)).collect();
                let m = all_values(l2, &ps, &gs, 0.0);
                let mut worst = 0.0;
                for &v in &m.vals {
                    worst = math::min(worst, v);
                }
                if worst >= -accept_worst {
                    lam = l2;
                    poses = ps;
                    gg = gs;
                    ok = true;
                    if t == 1.0 {
                        trust = math::min(trust * 1.5, 0.05 * lam);
                    }
                    break;
                }
                t /= 2.0;
            }
            if !ok {
                trust *= 0.25;
                if trust < 1e-13 * lam {
                    break 'outer;
                }
            }
        }
        it += 1;
    }
    SlpResult { lam, poses, iterations: it }
}
