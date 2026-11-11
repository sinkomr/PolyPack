//! Half-chains, windows, joins and hinge distances on the boundary of the simplex, orthoplex and
//! demicube (d = 5..10); the float engine of docs/spaces/BOUNDARY.md section 4D.2 to 4D.4.
//! Port of packages/boundary/src/nd/chains.ts (the functions the validator reaches).
//!
//! Development. The cell c_0 (the anchor) holds the source point u. A chain is a sequence of cells
//! c_0, c_1, ..., c_k, each glued to the previous one across a ridge. The cell c_(j+1) is unfolded
//! into the hyperplane of c_j by the reflection
//!     sigma(x) = x - 2 (m . (x - q)) / (m . m) m,    m = n_(c_j) + n_(c_(j+1)),   q a point of the ridge,
//! the reflection about the hyperplane through the ridge with normal n1 + n2 (n1, n2 the cells'
//! outward unit normals): it is an involution of the ambient space, fixes the ridge pointwise, maps
//! H_(c_(j+1)) onto H_(c_j) and, because the two cells are on opposite sides of the ridge's
//! (d-2)-flat, lays c_(j+1) on the far side of the ridge (the other reflection through the ridge,
//! with normal n1 - n2, folds it back over c_j). The development of c_k is
//! T_k = sigma_1 o sigma_2 o ... (composed on the right) : actual cell c_k -> the anchor's
//! hyperplane; a node stores its linear part L and translation t (T x = L x + t) and a = T^(-1) u,
//! the source as seen in the actual hyperplane of its own cell; a child's a is sigma(a) (an
//! involution).
//!
//! Pruning (sound: a branch is cut only when no straight path of length <= reach can follow it).
//! The next ridge, of neighbour g, is crossed by a ray from u only if a is strictly inside the
//! half-space of g (S_g = s h_g - n_g . a > 0), and then the path is at least as long as the
//! distance from a to the ridge, which is at least
//!     sqrt( S_g^2 / |nu_g|^2 + max_k (viol_k / |tn_k|)^2 ),
//! the distance within H_c from a to the flat of the ridge plus the distance, within that flat,
//! from the foot of the perpendicular to the half-space of the cell's other facet k (viol_k > 0 how
//! far the foot is outside it; |tn_k| the length of that facet's normal tangential to the flat).
//! Any single facet gives a lower bound on the distance to the ridge, so the maximum does too.
//!
//! Windows. A ray from u with direction e (in the anchor's hyperplane) crosses the ridges of a
//! chain in order, each inside the closed ridge, exactly when e is in the window of the chain, a
//! polyhedral cone: for each step (cell p, crossed neighbour f, S_k = s h_k - n_k . a_p), with z
//! the direction in p's frame, n_f . z >= 0 and S_f (n_k . z) - S_k (n_f . z) <= 0 for every other
//! neighbour k of p (derived in 4D.2: the ray hits the plane of f at tau = S_f / (n_f . z) and
//! satisfies the facet k there). Directions are carried from the end cell's frame back along the
//! chain by the reflections (z_(j) = R_j z_(j+1)), so no window is stored.
//!
//! Joins. Two half-chains, one from each source, ending in the same cell c, with sources a1, a2 as
//! seen in c's hyperplane, give the straight path of length |a1 - a2| from the first source to the
//! second exactly when the direction w = a2 - a1 is in the window of the first and beyond its last
//! ridge (n_f . z >= S_f), and -w is in the window of the second and beyond its last ridge. A path
//! of length L has a midpoint at distance L/2 from each source, so it is found from half-chains of
//! reach L/2.
//!
//! The step budget: every node created, every join candidate and every projection counts one step;
//! a check that exceeds its budget throws NDLimitError and is refused, never accepted.

use super::container::{NdCell, NdContainer};
use polypack_js::fmt::num;
use polypack_js::math;
use std::collections::HashMap;
use std::rc::Rc;

/// packages/boundary/src/nd/chains.ts: NDLimitError
#[derive(Clone, Debug, PartialEq)]
pub struct NdLimitError(pub String);

/// packages/boundary/src/nd/chains.ts: NDBudget (JavaScript numbers in the source, so `f64`)
#[derive(Clone, Copy, Debug)]
pub struct NdBudget {
    pub steps: f64,
    pub max: f64,
    /// Multiply-adds spent (an estimate from the loops' sizes) and their cap.
    pub ops: f64,
    pub max_ops: f64,
}

/// packages/boundary/src/nd/chains.ts: newNDBudget (maxOps defaults to Infinity there)
pub fn new_nd_budget(max: f64, max_ops: f64) -> NdBudget {
    NdBudget { steps: 0.0, max, ops: 0.0, max_ops }
}

#[inline]
fn spend(b: &mut NdBudget) -> Result<(), NdLimitError> {
    b.steps += 1.0;
    if b.steps > b.max {
        return Err(NdLimitError(format!("the check needs more than {} search steps", num(b.max))));
    }
    Ok(())
}

/// Charges the multiply-adds of a loop that is not one step each: the cost of a step grows with the
/// container (a demicube cell has up to 274 neighbours at d = 10 and a chain's window F rows per
/// ridge crossed), so the steps alone do not bound the time (4D.8). The count is the loops' sizes,
/// not a clock: the same on every machine.
#[inline]
fn spend_ops(b: &mut NdBudget, k: f64) -> Result<(), NdLimitError> {
    b.ops += k;
    if b.ops > b.max_ops {
        return Err(NdLimitError(format!("the check needs more than {} operations", num(b.max_ops))));
    }
    Ok(())
}

/// packages/boundary/src/nd/chains.ts: NDNode
#[derive(Clone, Debug)]
pub struct NdNode {
    pub cell: usize,
    /// Index of the parent node (-1 for the anchor) and the index in the parent's neighbour list of the ridge crossed.
    pub parent: i32,
    pub via: i32,
    pub depth: usize,
    /// The source as seen in this cell's hyperplane.
    pub a: Vec<f64>,
    /// The development T x = L x + t of this cell into the anchor's hyperplane (L row-major D x D).
    pub l: Vec<f64>,
    pub t: Vec<f64>,
}

#[inline]
fn dot(a: &[f64], ao: usize, b: &[f64], bo: usize, d: usize) -> f64 {
    let a = &a[ao..ao + d];
    let b = &b[bo..bo + d];
    let mut s = 0.0;
    for j in 0..d {
        s += a[j] * b[j];
    }
    s
}

/// Reflects v about the direction m (a vector of squared length mm): v - 2 (m . v) / mm m, in place.
#[inline]
fn reflect_dir(v: &mut [f64], m: &[f64], mm: f64, d: usize) {
    let c = (2.0 * dot(m, 0, v, 0, d)) / mm;
    for j in 0..d {
        v[j] -= c * m[j];
    }
}

/// m = n_c + n_g for the ridge between cell cl and its neighbour k; returns mm = m . m.
#[inline]
fn mirror(cl: &NdCell, k: usize, d: usize, m: &mut [f64]) -> f64 {
    let mut mm = 0.0;
    for j in 0..d {
        m[j] = cl.n[j] + cl.nn[k * d + j];
        mm += m[j] * m[j];
    }
    mm
}

/// Relative slack below which a ridge counts as not strictly ahead of the source. It must stay
/// below 4 eta (anchor_piece's band, eta >= 2^-52 max(1, s), so 4 eta >= 8.8e-16 max(1, s)): a
/// centre whose slack toward a neighbour is in (AHEAD, 4 eta] is developed into it, a centre within
/// 4 eta of the ridge also anchors in it, and none falls between the two (4D.6).
const AHEAD: f64 = 8e-16;

/// The half-chains from the point x0 (ambient, in the hyperplane of cell c0, edge s) of reach
/// `reach`: every chain a straight path of length <= reach can follow. The anchor is node 0.
/// packages/boundary/src/nd/chains.ts: develop
pub fn develop(c: &NdContainer, s: f64, c0: usize, x0: &[f64], reach: f64, budget: &mut NdBudget) -> Result<Vec<NdNode>, NdLimitError> {
    let d = c.dd;
    let reach2 = reach * reach * (1.0 + 1e-12);
    let mut ident = vec![0.0; d * d];
    for j in 0..d {
        ident[j * d + j] = 1.0;
    }
    let mut nodes: Vec<NdNode> = vec![NdNode { cell: c0, parent: -1, via: -1, depth: 0, a: x0.to_vec(), l: ident, t: vec![0.0; d] }];
    let mut m = vec![0.0; d];
    let mut nu = vec![0.0; d];
    let mut lm = vec![0.0; d];
    let mut sv: Vec<f64> = Vec::new();
    spend(budget)?;
    let mut idx = 0;
    while idx < nodes.len() {
        let cl = c.cell(nodes[idx].cell);
        let f = cl.nbr.len();
        let parent_cell: i64 = if nodes[idx].parent >= 0 { nodes[nodes[idx].parent as usize].cell as i64 } else { -1 };
        // S_k = s h_k - n_k . a for every neighbour, computed once per node
        sv.clear();
        {
            let a = &nodes[idx].a;
            for k in 0..f {
                sv.push(s * cl.hn[k] - dot(&cl.nn, k * d, a, 0, d));
            }
        }
        spend_ops(budget, (f * d) as f64)?;
        for k in 0..f {
            if cl.nbr[k] as i64 == parent_cell {
                continue;
            }
            let sk = sv[k];
            if !(sk > AHEAD * math::max(1.0, s)) {
                continue;
            }
            let nu2 = cl.nu2[k];
            if !(nu2 > 1e-12) {
                continue;
            }
            let d2 = (sk * sk) / nu2;
            if d2 > reach2 {
                continue;
            }
            // nu = tangential part of n_k; q_l = n_l . nu for the other facets
            let nk = &cl.nn;
            let c1 = dot(nk, k * d, &cl.n, 0, d);
            for j in 0..d {
                nu[j] = nk[k * d + j] - c1 * cl.n[j];
            }
            let fq = sk / nu2;
            let mut extra2 = 0.0;
            spend_ops(budget, (f * d) as f64)?;
            for l in 0..f {
                if l == k {
                    continue;
                }
                let q = dot(nk, l * d, &nu, 0, d);
                let viol = -sv[l] + fq * q;
                if viol > 0.0 {
                    let tn2 = cl.nu2[l] - (q * q) / nu2;
                    if tn2 > 1e-12 {
                        let e2 = (viol * viol) / tn2;
                        if e2 > extra2 {
                            extra2 = e2;
                        }
                    }
                }
            }
            if d2 + extra2 > reach2 {
                continue;
            }
            spend(budget)?;
            spend_ops(budget, (4 * d * d) as f64)?;
            // the child: unfold neighbour k's cell into H_c
            let mm = mirror(cl, k, d, &mut m);
            let mut qv = vec![0.0; d];
            for j in 0..d {
                qv[j] = s * cl.rp[k * d + j];
            }
            let mq = dot(&m, 0, &qv, 0, d);
            let nd = &nodes[idx];
            let a = &nd.a;
            let mut a2 = vec![0.0; d];
            let ma = (2.0 * (dot(&m, 0, a, 0, d) - mq)) / mm;
            for j in 0..d {
                a2[j] = a[j] - ma * m[j];
            }
            // L' = L - 2 (L m) m^T / mm, t' = t + 2 (m . q) / mm (L m)
            for r in 0..d {
                lm[r] = dot(&nd.l, r * d, &m, 0, d);
            }
            let mut l2 = vec![0.0; d * d];
            for r in 0..d {
                let cc = (2.0 * lm[r]) / mm;
                for j in 0..d {
                    l2[r * d + j] = nd.l[r * d + j] - cc * m[j];
                }
            }
            let mut t2 = vec![0.0; d];
            let ct = (2.0 * mq) / mm;
            for r in 0..d {
                t2[r] = nd.t[r] + ct * lm[r];
            }
            let depth = nd.depth + 1;
            nodes.push(NdNode { cell: cl.nbr[k], parent: idx as i32, via: k as i32, depth, a: a2, l: l2, t: t2 });
        }
        idx += 1;
    }
    Ok(nodes)
}

/// Is the direction w (in the frame of the end cell of node idx) in the closed window of the chain
/// ending at idx, and, when `beyond`, beyond its last ridge? tol is relative (to |w| times the
/// slacks involved).
/// packages/boundary/src/nd/chains.ts: inWindow
pub fn in_window(c: &NdContainer, s: f64, nodes: &[NdNode], idx: usize, w: &[f64], beyond: bool, tol: f64) -> bool {
    let d = c.dd;
    let mut z = w.to_vec();
    let mut m = vec![0.0; d];
    let mut nw = 0.0;
    for j in 0..d {
        nw += w[j] * w[j];
    }
    nw = nw.sqrt();
    let mut cur = idx;
    let mut first = true;
    while nodes[cur].parent >= 0 {
        let p = &nodes[nodes[cur].parent as usize];
        let pc = c.cell(p.cell);
        let f = nodes[cur].via as usize;
        // z in p's frame: reflect by the ridge's mirror
        let mm = mirror(pc, f, d, &mut m);
        reflect_dir(&mut z, &m, mm, d);
        let fc = pc.nbr.len();
        let sf = s * pc.hn[f] - dot(&pc.nn, f * d, &p.a, 0, d);
        let nfz = dot(&pc.nn, f * d, &z, 0, d);
        if nfz < -tol * nw {
            return false;
        }
        if first && beyond && nfz < sf - tol * nw {
            return false;
        }
        first = false;
        for k in 0..fc {
            if k == f {
                continue;
            }
            let sk = s * pc.hn[k] - dot(&pc.nn, k * d, &p.a, 0, d);
            let lhs = sf * dot(&pc.nn, k * d, &z, 0, d) - sk * nfz;
            if lhs > tol * nw * (sf.abs() + sk.abs()) {
                return false;
            }
        }
        cur = nodes[cur].parent as usize;
    }
    true
}

/// Joins shorter than this are the trivial loop of a centre on a ridge, for one ball; for two balls they are one point (4D.2).
/// packages/boundary/src/nd/chains.ts: ndZeroLength
pub fn nd_zero_length(s: f64) -> f64 {
    1e-10 * math::max(1.0, s)
}

/// The multiply-adds of in_window for the chain ending at node idx: per ridge crossed, a reflection and the cell's F facet tests.
fn window_ops(c: &NdContainer, nodes: &[NdNode], idx: usize) -> f64 {
    let mut ops = 0.0;
    let mut cur = idx;
    while nodes[cur].parent >= 0 {
        let pc = c.cell(nodes[nodes[cur].parent as usize].cell);
        ops += ((2 * pc.nbr.len() + 6) * c.dd) as f64;
        cur = nodes[cur].parent as usize;
    }
    ops
}

/// packages/boundary/src/nd/chains.ts: NDJoin
#[derive(Clone, Copy, Debug)]
pub struct NdJoin {
    pub dist: f64,
    pub a: i32,
    pub b: i32,
}

/// The shortest straight path from the source of `A` to the source of `B` found by joining
/// half-chains, if its length is below `limit` (Infinity otherwise). With `same` the two sets are
/// one ball's: the pairs of distinct half-chains (a loop). With `own` (the source's default) the
/// sets belong to one ball and a join shorter than 1e-10 max(1, s) is the trivial loop of a centre
/// on a ridge, skipped. For two different balls (`own` false) such a join is an overlap and is kept
/// (4D.2, 4D.6). `tol` is 1e-12 in the source's default.
/// packages/boundary/src/nd/chains.ts: joinDistance
#[allow(clippy::too_many_arguments)]
pub fn join_distance(c: &NdContainer, s: f64, a_nodes: &[NdNode], b_nodes: &[NdNode], limit: f64, budget: &mut NdBudget, same: bool, tol: f64, own: bool) -> Result<NdJoin, NdLimitError> {
    let d = c.dd;
    // (a Map from cell to the indices of B's nodes there; only looked up, so its order does not matter)
    let mut by_cell: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, nd) in b_nodes.iter().enumerate() {
        by_cell.entry(nd.cell).or_default().push(i);
    }
    let mut w = vec![0.0; d];
    let mut wn = vec![0.0; d];
    let mut best = NdJoin { dist: f64::INFINITY, a: -1, b: -1 };
    let lim2 = limit * limit;
    let zero = nd_zero_length(s);
    let zero2 = zero * zero;
    for i in 0..a_nodes.len() {
        let Some(l) = by_cell.get(&a_nodes[i].cell) else { continue };
        for &j in l {
            if same && j <= i {
                continue;
            }
            let mut len2 = 0.0;
            spend_ops(budget, d as f64)?;
            for r in 0..d {
                w[r] = b_nodes[j].a[r] - a_nodes[i].a[r];
                len2 += w[r] * w[r];
            }
            if !(len2 < lim2) || (own && len2 < zero2) || len2 >= best.dist * best.dist {
                continue;
            }
            spend(budget)?;
            spend_ops(budget, window_ops(c, a_nodes, i) + window_ops(c, b_nodes, j))?;
            if !in_window(c, s, a_nodes, i, &w, true, tol) {
                continue;
            }
            for r in 0..d {
                wn[r] = -w[r];
            }
            if !in_window(c, s, b_nodes, j, &wn, true, tol) {
                continue;
            }
            best = NdJoin { dist: len2.sqrt(), a: i as i32, b: j as i32 };
        }
    }
    Ok(best)
}

// ---------------------------------------------------------------------------------------------------------- hinge distance

/// A row v . x <= b (or = b). The vector is shared: a hinge's rows include the window's rows as they are.
#[derive(Clone, Debug)]
struct Row {
    v: Rc<[f64]>,
    b: f64,
}

#[derive(Clone, Debug)]
struct Res {
    d2: f64,
    x: Option<Rc<Vec<f64>>>,
}

struct Nearest<'a> {
    a: &'a [f64],
    eqs: &'a [Row],
    rows: Vec<Row>,
    d: usize,
    tol_v: f64,
    memo: HashMap<Vec<usize>, Res>,
    active: Vec<usize>,
}

impl Nearest<'_> {
    // cap: only distances below sqrt(cap) matter. Adding an equality can only lengthen the projection, and every inequality the projection
    // violates by delta (measured inside the flat) puts the nearest point at least delta farther, so a branch is dropped as soon as
    // |x0 - a|^2 + max delta^2 exceeds the cap, and a violated row is tried only while it can still beat the best found.
    fn solve(&mut self, cap: f64, budget: &mut NdBudget) -> Result<Res, NdLimitError> {
        let none = Res { d2: f64::INFINITY, x: None };
        let d = self.d;
        let a = self.a;
        let mut key = self.active.clone();
        key.sort_unstable();
        if let Some(hit) = self.memo.get(&key) {
            return Ok(hit.clone());
        }
        spend(budget)?;
        let e: Vec<Row> = self.eqs.iter().cloned().chain(self.active.iter().map(|&i| self.rows[i].clone())).collect();
        let m = e.len();
        spend_ops(budget, ((self.rows.len() + m * m) * d + 2 * m * m * m) as f64)?;
        // Gram matrix G, its inverse by Gauss-Jordan; lambda = G^-1 r with r_i = v_i . a - b_i, x0 = a - sum lambda_i v_i
        let mut g: Vec<Vec<f64>> = Vec::with_capacity(m);
        for i in 0..m {
            let mut row = vec![0.0; 2 * m];
            for j in 0..m {
                row[j] = dot(&e[i].v, 0, &e[j].v, 0, d);
            }
            row[m + i] = 1.0;
            g.push(row);
        }
        for c in 0..m {
            let mut p = c;
            for i in c + 1..m {
                if g[i][c].abs() > g[p][c].abs() {
                    p = i;
                }
            }
            // dependent equalities: this flat adds nothing
            if g[p][c].abs() < 1e-9 {
                self.memo.insert(key, none.clone());
                return Ok(none);
            }
            g.swap(c, p);
            let pv = g[c][c];
            for j in 0..2 * m {
                g[c][j] /= pv;
            }
            for i in 0..m {
                if i == c {
                    continue;
                }
                let f = g[i][c];
                if f != 0.0 {
                    for j in 0..2 * m {
                        let gcj = g[c][j];
                        g[i][j] -= f * gcj;
                    }
                }
            }
        }
        let ginv = |i: usize, j: usize| -> f64 { g[i][m + j] };
        let r: Vec<f64> = e.iter().map(|row| dot(&row.v, 0, a, 0, d) - row.b).collect();
        let mut x = a.to_vec();
        for i in 0..m {
            let mut lam = 0.0;
            for j in 0..m {
                lam += ginv(i, j) * r[j];
            }
            for j in 0..d {
                x[j] -= lam * e[i].v[j];
            }
        }
        let mut d2 = 0.0;
        for j in 0..d {
            d2 += (x[j] - a[j]) * (x[j] - a[j]);
        }
        if d2 > cap {
            return Ok(none);
        }
        let mut viol: Vec<(f64, usize)> = Vec::new();
        let mut worst = 0.0;
        let mut ev = vec![0.0; m];
        for i in 0..self.rows.len() {
            if self.active.contains(&i) {
                continue;
            }
            let v = dot(&self.rows[i].v, 0, &x, 0, d) - self.rows[i].b;
            if v > self.tol_v {
                viol.push((v, i));
                // delta = v / |tangential part of the row in the flat|
                for k in 0..m {
                    ev[k] = dot(&e[k].v, 0, &self.rows[i].v, 0, d);
                }
                let mut q = 1.0;
                for k in 0..m {
                    for l in 0..m {
                        q -= ev[k] * ginv(k, l) * ev[l];
                    }
                }
                if q > 1e-12 {
                    worst = math::max(worst, (v * v) / q);
                }
            }
        }
        if d2 + worst > cap {
            return Ok(none);
        }
        let mut out = none;
        if viol.is_empty() {
            out = Res { d2, x: Some(Rc::new(x)) };
        } else {
            // (p, q) => q[0] - p[0]: the largest violation first
            viol.sort_by(|p, q| q.0.partial_cmp(&p.0).unwrap_or(std::cmp::Ordering::Equal));
            for &(_, i) in &viol {
                self.active.push(i);
                let r2 = self.solve(math::min(cap, out.d2), budget)?;
                if r2.d2 < out.d2 {
                    out = r2;
                }
                self.active.pop();
            }
        }
        if out.d2 <= cap {
            self.memo.insert(key, out.clone());
        }
        Ok(out)
    }
}

/// The squared distance from a to the polytope { x : v_i . x = b_i (i in eqs), v_j . x <= b_j (j in
/// rows) }, or Infinity when it is empty. Rows are unit vectors. The projection onto the flat of
/// the equalities decides: when it satisfies every inequality it is the nearest point; otherwise
/// the nearest point lies on the boundary of at least one violated inequality (it is the nearest
/// point of the polytope to the projection, whose normal-cone vector has a positive inner product
/// with some active constraint's normal, a constraint the projection violates), so the distance is
/// the least over the violated ones of the distance with that one added to the equalities.
/// packages/boundary/src/nd/chains.ts: nearest2
fn nearest2(a: &[f64], eqs: &[Row], rows0: &[Row], d: usize, tol_v: f64, budget: &mut NdBudget, cap: f64) -> Result<Res, NdLimitError> {
    // a row the whole ball of radius sqrt(cap) about a satisfies cannot matter (rows are unit vectors)
    let rad = cap.sqrt();
    spend_ops(budget, (rows0.len() * d) as f64)?;
    let rows: Vec<Row> = rows0.iter().filter(|r| dot(&r.v, 0, a, 0, d) - r.b > -rad - tol_v).cloned().collect();
    let mut state = Nearest { a, eqs, rows, d, tol_v, memo: HashMap::new(), active: Vec::new() };
    state.solve(cap, budget)
}

fn unit_row(v: &[f64], b: f64) -> Row {
    let mut nm = 0.0;
    for x in v {
        nm += x * x;
    }
    nm = nm.sqrt();
    let u: Vec<f64> = v.iter().map(|x| x / nm).collect();
    Row { v: u.into(), b: b / nm }
}

/// The multiply-adds of window_rows: per ridge crossed, F rows, each carried back through the later reflections and normalised.
fn window_rows_ops(c: &NdContainer, nodes: &[NdNode], idx: usize) -> f64 {
    let mut ops = 0.0;
    let mut i = 0usize;
    let mut cur = idx;
    while nodes[cur].parent >= 0 {
        let f = c.cell(nodes[nodes[cur].parent as usize].cell).nbr.len();
        ops += (f * ((3 * (i + 1) + 6) * c.dd)) as f64;
        cur = nodes[cur].parent as usize;
        i += 1;
    }
    ops
}

/// The rows (v . x <= b) of the window of the chain ending at node idx, in the frame of its end cell, about the source a.
/// packages/boundary/src/nd/chains.ts: windowRows
fn window_rows(c: &NdContainer, s: f64, nodes: &[NdNode], idx: usize) -> Vec<Row> {
    let d = c.dd;
    let mut out: Vec<Row> = Vec::new();
    let mut m = vec![0.0; d];
    let a_end = &nodes[idx].a;
    // the chain's steps from the end back to the anchor; the reflections R_(end-1) ... R_p carry a vector of p's frame to the end frame
    let mut steps: Vec<usize> = Vec::new();
    let mut cur = idx;
    while nodes[cur].parent >= 0 {
        steps.push(cur);
        cur = nodes[cur].parent as usize;
    }
    // steps[0] is the end node, steps[i] the node whose parent is the (i+1)th from the end
    for i in 0..steps.len() {
        let cur = steps[i];
        let p = &nodes[nodes[cur].parent as usize];
        let pc = c.cell(p.cell);
        let f = nodes[cur].via as usize;
        let fc = pc.nbr.len();
        let sf = s * pc.hn[f] - dot(&pc.nn, f * d, &p.a, 0, d);
        let mut carry = |v: &mut [f64]| {
            // apply R_p (between p and its child), then the reflections of the later steps, up to the end
            for t in (0..=i).rev() {
                let c2 = steps[t];
                let q = &nodes[nodes[c2].parent as usize];
                let mm = mirror(c.cell(q.cell), nodes[c2].via as usize, d, &mut m);
                reflect_dir(v, &m, mm, d);
            }
        };
        // heading: n_f . z >= 0  ->  -n_f . z <= 0
        {
            let mut v = vec![0.0; d];
            for j in 0..d {
                v[j] = -pc.nn[f * d + j];
            }
            carry(&mut v);
            let b = dot(&v, 0, a_end, 0, d);
            out.push(unit_row(&v, b));
        }
        for k in 0..fc {
            if k == f {
                continue;
            }
            let sk = s * pc.hn[k] - dot(&pc.nn, k * d, &p.a, 0, d);
            let mut v = vec![0.0; d];
            for j in 0..d {
                v[j] = sf * pc.nn[k * d + j] - sk * pc.nn[f * d + j];
            }
            carry(&mut v);
            let b = dot(&v, 0, a_end, 0, d);
            out.push(unit_row(&v, b));
        }
    }
    out
}

/// packages/boundary/src/nd/chains.ts: NDHinge
#[derive(Clone, Debug)]
pub struct NdHinge {
    /// Distance from the source to the nearest hinge point seen by a straight path of a chain, Infinity if none within the reach.
    pub dist: f64,
    /// The node where it occurs (-1 if none), and the nearest point (in that node's end-cell frame).
    pub node: i32,
    pub x: Option<Vec<f64>>,
}

/// The squared flat distance from a to the hinge flat of neighbours k, l of cell cl (within H_c): a lower bound of the distance to the hinge.
fn flat_dist2(cl: &NdCell, sv: &[f64], k: usize, l: usize, d: usize) -> f64 {
    let c = dot(&cl.nn, k * d, &cl.nn, l * d, d) - dot(&cl.nn, k * d, &cl.n, 0, d) * dot(&cl.nn, l * d, &cl.n, 0, d);
    let det = cl.nu2[k] * cl.nu2[l] - c * c;
    if !(det > 1e-12) {
        return f64::INFINITY;
    }
    (sv[k] * sv[k] * cl.nu2[l] - 2.0 * sv[k] * sv[l] * c + sv[l] * sv[l] * cl.nu2[k]) / det
}

/// The geodesic distance from the source to the hinges (the (d-3)-faces) over `nodes` (its
/// half-chains), if below `reach`: for each node and each hinge of its cell within reach, the
/// nearest point of the hinge inside the chain's window. `only` (-1 in the source's default)
/// restricts the search to one node.
/// packages/boundary/src/nd/chains.ts: hingeDistance
pub fn hinge_distance(c: &NdContainer, s: f64, nodes: &[NdNode], reach: f64, budget: &mut NdBudget, only: i32) -> Result<NdHinge, NdLimitError> {
    let d = c.dd;
    let reach2 = reach * reach * (1.0 + 1e-12);
    let tol_v = 1e-12 * math::max(1.0, s);
    let mut best = NdHinge { dist: f64::INFINITY, node: -1, x: None };
    let cell_eqs = |cl: &NdCell| -> Vec<Row> {
        let mut e = vec![unit_row(&cl.n, s * cl.h)];
        if let Some(flat) = &c.flat {
            e.push(unit_row(&flat.v, s * flat.b));
        }
        e
    };
    for idx in 0..nodes.len() {
        if only >= 0 && idx as i32 != only {
            continue;
        }
        let nd = &nodes[idx];
        let cl = c.cell(nd.cell);
        let f = cl.nbr.len();
        let mut sv = vec![0.0; f];
        for k in 0..f {
            sv[k] = s * cl.hn[k] - dot(&cl.nn, k * d, &nd.a, 0, d);
        }
        spend_ops(budget, (f * d + 4 * cl.hinges.len()) as f64)?;
        let mut wrows: Option<Vec<Row>> = None;
        let mut p = 0;
        while p < cl.hinges.len() {
            let k = cl.hinges[p];
            let l = cl.hinges[p + 1];
            p += 2;
            // the hinge lies in both ridge planes: farther than either plane
            if sv[k] * sv[k] > reach2 * cl.nu2[k] || sv[l] * sv[l] > reach2 * cl.nu2[l] {
                continue;
            }
            spend_ops(budget, (3 * d + 10) as f64)?;
            let lb = flat_dist2(cl, &sv, k, l, d);
            if !(lb <= reach2) {
                continue;
            }
            spend(budget)?;
            if wrows.is_none() {
                spend_ops(budget, window_rows_ops(c, nodes, idx))?;
                wrows = Some(window_rows(c, s, nodes, idx));
            }
            let wr = wrows.as_ref().expect("just set");
            // the rows of this hinge: the cell's other facets, normalised, and the window's
            spend_ops(budget, (4 * (f + wr.len()) * d) as f64)?;
            let mut eqs = cell_eqs(cl);
            eqs.push(unit_row(&cl.nn[k * d..k * d + d], s * cl.hn[k]));
            eqs.push(unit_row(&cl.nn[l * d..l * d + d], s * cl.hn[l]));
            let mut rows: Vec<Row> = Vec::with_capacity(f + wr.len());
            for j in 0..f {
                if j != k && j != l {
                    rows.push(unit_row(&cl.nn[j * d..j * d + d], s * cl.hn[j]));
                }
            }
            for r in wr {
                rows.push(r.clone());
            }
            let r = nearest2(&nd.a, &eqs, &rows, d, tol_v, budget, math::min(reach2, best.dist * best.dist))?;
            if r.d2 < best.dist * best.dist && r.d2 <= reach2 {
                best = NdHinge { dist: r.d2.sqrt(), node: idx as i32, x: r.x.map(|x| (*x).clone()) };
            }
        }
    }
    Ok(best)
}
