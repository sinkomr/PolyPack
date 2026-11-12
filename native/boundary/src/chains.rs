//! Developments of the boundary from a point: the exponential map at a centre u of a closed cell.
//! Port of packages/boundary/src/chains.ts (the functions the server reaches).
//!
//! A straight ray from u that avoids the hinges (the edges) crosses a sequence of ridges (a chain);
//! unfold the cells it passes into the anchor cell's local frame (each gluing is an isometry that
//! fixes its ridge). For a chain C = (R_1, ..., R_k), let W(C) be the set of directions whose rays
//! cross R_1, ..., R_k in this order: the window. It is a convex polyhedral cone with apex u:
//!
//!   W(R_1) = cone_u(R_1),   W(R_1..R_k) = W(R_1..R_k-1) ∩ cone_u(R_k) = cone_u(G_k),
//!   G_k = R_k ∩ W(R_1..R_k-1)   (the "gate": the part of the developed ridge the rays reach),
//!
//! where R_j is the developed ridge polygon and cone_u(G) the rays from u through G. Lemma (as in
//! the 2D surface track): a ray in the interior of W(C) crosses R_1, ..., R_k in this order and runs
//! inside each developed cell between consecutive crossings, because each developed cell lies on
//! the far side of the plane of the ridge it was entered through and a ray crosses a plane once.
//! The part of a piece X in the last cell is X ∩ (developed cell) ∩ W(C).
//!
//! Enumeration is breadth-first from the anchor cell. A branch is cut only when no hinge-avoiding
//! ray of length <= reach can follow it:
//! 1. side: u lies on or beyond the plane of the next ridge (seen from the current developed cell);
//!    such a ray would have to cross that plane at its start (only possible at the anchor cell,
//!    where a centre on a ridge sees the closed half-space beyond it as the window);
//! 2. distance: the gate is farther than `reach` from u;
//! 3. empty window: the gate has fewer than 3 vertices after clipping, or the window is thinner than
//!    MIN_WINDOW_ANGLE. Thinness is tested with an upper bound, never an estimate: for a face of
//!    the window with inward unit normal N (a plane through u) and any gate point p, N . (p - u) is
//!    linear in p, so it is at most its largest value over the gate's vertices, and |p - u| is at
//!    least dist(u, gate); hence the window's angular height above that face (the largest
//!    N . d over its unit directions d) is at most max_v N . (v - u) / dist(u, gate). A window is
//!    cut only when this bound is below MIN_WINDOW_ANGLE for some face, so every window cut is
//!    truly that thin and its part has a thickness below MIN_WINDOW_ANGLE x reach.
//! 4. turn rule: a straight line not meeting an edge e sees e under exactly pi in the plane normal
//!    to e, so it can cross consecutive ridges around e only while the cells passed between them
//!    have dihedral angles at e summing to less than pi (at most one cube of the tesseract).
//! Termination: windows only shrink, the gate distance grows with each crossing (cells have
//! positive width), and `max_chains` / `max_depth` bound the work for untrusted input.
//!
//! Centres near ridges (any convex polytope). The centre is first clamped into its closed anchor
//! cell and then snapped onto every facet plane of the anchor within the snap distance eta
//! (clamp_to_cell; it moves by at most sqrt 3 eta). eta defaults to RIDGE_SNAP max(1, s); the
//! validator passes ridge_snap(s, tol) = min(that, tol / 10), never below one rounding unit of s,
//! and charges each piece's actual snap displacement to its verdict (validate.rs), so the snap is
//! never extra tolerance. A centre on a facet's plane lies on that facet (it is in the closed
//! cell), and every ray from it into the open half-space beyond the facet crosses the ridge at its
//! start, so that half-space is the exact window of the chain through that facet. Every other
//! facet plane of the anchor is then more than eta away, and the cone over its ridge is computed.
//! Deeper in a chain a ridge plane within eta of u is skipped (rule 1): every ray through such a
//! gate makes an angle below eta / dist(u, gate) with the gate's plane, so the part lost lies in a
//! slab of thickness below reach x eta / dist(u, gate).

use crate::linalg::{cross3, dot3, iso_apply, iso_compose, iso_inverse, iso_linear, norm3, point_segment_distance3, sub3, unit3, Iso3, ISO_IDENTITY, V3};
use crate::polytope::{topo, Polytope};
use polypack_js::fmt::num;
use polypack_js::math;

/// packages/boundary/src/chains.ts: ChainNode
#[derive(Clone, Debug)]
pub struct ChainNode {
    /// The cell reached.
    pub cell: usize,
    /// This cell's local coordinates -> the anchor's local coordinates (the development), at edge s.
    pub to_anchor: Iso3,
    /// The window: unit normals N, in the anchor frame, of the planes through the centre u that bound
    /// it, { y : N . (y - u) >= 0 }. Empty for the anchor (all directions).
    pub window: Vec<V3>,
    /// The gate: the last ridge crossed, clipped to the parent's window, in the anchor frame (empty for the anchor).
    pub gate: Vec<V3>,
    /// Distance from u to the gate (0 for the anchor).
    pub gate_dist: f64,
    /// Facet of `cell` through which the chain entered (-1 for the anchor).
    pub entry: i32,
    /// Index of the parent node (-1 for the anchor).
    pub parent: i32,
    pub depth: usize,
    /// Cells crossed, anchor first, this cell last.
    pub cells: Vec<usize>,
    /// Polytope edge shared by the last two ridges crossed (-1 if none), and the angle swept around it.
    pub run_edge: i32,
    pub run_angle: f64,
}

impl ChainNode {
    /// The anchor's node (node 0 of every development).
    pub fn root(cell: usize) -> ChainNode {
        ChainNode {
            cell,
            to_anchor: ISO_IDENTITY,
            window: vec![],
            gate: vec![],
            gate_dist: 0.0,
            entry: -1,
            parent: -1,
            depth: 0,
            cells: vec![cell],
            run_edge: -1,
            run_angle: 0.0,
        }
    }
}

/// Thrown when a point has more chains (or longer ones) than the caller allows.
/// packages/boundary/src/chains.ts: ChainLimitError
#[derive(Clone, Debug, PartialEq)]
pub struct ChainLimitError(pub String);

/// packages/boundary/src/chains.ts: ChainOptions
#[derive(Clone, Copy, Debug, Default)]
pub struct ChainOptions {
    /// Most chains from one point (default 20000).
    pub max_chains: Option<f64>,
    /// Longest chain (default 256 crossings).
    pub max_depth: Option<f64>,
    /// Snap distance eta for centres near the anchor's facet planes (default RIDGE_SNAP max(1, s)).
    pub snap: Option<f64>,
}

/// Windows thinner than this (sine of an angle, by the upper bound of rule 3) are treated as empty.
pub const MIN_WINDOW_ANGLE: f64 = 1e-12;

/// Default snap: centres within RIDGE_SNAP max(1, s) of a facet plane of their anchor cell are snapped onto it.
pub const RIDGE_SNAP: f64 = 1e-14;

/// The snap distance at edge s: RIDGE_SNAP max(1, s), or, given a tolerance, the smaller of that
/// and tol / 10, but never below one rounding unit of s (2^-52 max(1, s)), under which the side
/// of a ridge plane is not decided reliably.
/// packages/boundary/src/chains.ts: ridgeSnap
pub fn ridge_snap(s: f64, tol: Option<f64>) -> f64 {
    let base = RIDGE_SNAP * math::max(1.0, s);
    match tol {
        None => base,
        // 2 ** -52 is f64::EPSILON
        Some(tol) => math::max(f64::EPSILON * math::max(1.0, s), math::min(base, tol / 10.0)),
    }
}

/// The centre the development works from: u clamped into the closed cell (moved by at most the
/// largest facet violation), then snapped onto every facet plane within `snap` (the source's
/// default is ridgeSnap(s)). Every computation of a piece (chains, parts, distances) uses it.
/// snap = 0 clamps only.
/// packages/boundary/src/chains.ts: clampToCell
pub fn clamp_to_cell(poly: &Polytope, cell: usize, u: &[f64], s: f64, snap: f64) -> V3 {
    let ct = &topo(poly).cells[cell];
    let mut p: V3 = [u[0], u[1], u[2]];
    let eta = snap;
    for _pass in 0..4 {
        let mut moved = false;
        for pl in &ct.planes {
            let ex = dot3(pl.n, p) - pl.h * s;
            if ex > 0.0 || (ex > -eta && ex != 0.0) {
                p[0] -= ex * pl.n[0];
                p[1] -= ex * pl.n[1];
                p[2] -= ex * pl.n[2];
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    p
}

/// Twice the area vector of a planar polygon (Newell): its direction is the counter-clockwise normal.
/// packages/boundary/src/chains.ts: polygonNormal
pub fn polygon_normal(p: &[V3]) -> V3 {
    let mut n: V3 = [0.0; 3];
    for i in 0..p.len() {
        let a = p[i];
        let b = p[(i + 1) % p.len()];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    n
}

/// Drops consecutive (cyclic) vertices closer than eps.
/// packages/boundary/src/chains.ts: dedupePolygon
pub fn dedupe_polygon(p: Vec<V3>, eps: f64) -> Vec<V3> {
    let mut out: Vec<V3> = Vec::with_capacity(p.len());
    for v in p {
        if let Some(q) = out.last() {
            if (v[0] - q[0]).abs() <= eps && (v[1] - q[1]).abs() <= eps && (v[2] - q[2]).abs() <= eps {
                continue;
            }
        }
        out.push(v);
    }
    while out.len() > 1 {
        let a = out[0];
        let b = out[out.len() - 1];
        if (a[0] - b[0]).abs() <= eps && (a[1] - b[1]).abs() <= eps && (a[2] - b[2]).abs() <= eps {
            out.pop();
        } else {
            break;
        }
    }
    out
}

/// Sutherland-Hodgman clip of a planar convex polygon by the half-space { y : N . (y - u) >= 0 }.
/// Intersection points are computed from the vertex inside to the vertex outside.
/// packages/boundary/src/chains.ts: clipPolygonByPlane
pub fn clip_polygon_by_plane(p: Vec<V3>, nrm: V3, u: V3, eps: f64, d: &mut Vec<f64>) -> Vec<V3> {
    let n = p.len();
    if n == 0 {
        return p;
    }
    d.clear();
    let mut neg = false;
    let mut pos = false;
    for q in &p {
        let x = nrm[0] * (q[0] - u[0]) + nrm[1] * (q[1] - u[1]) + nrm[2] * (q[2] - u[2]);
        d.push(x);
        // written so that a NaN counts as both, as `every` did
        if !(x >= 0.0) {
            neg = true;
        }
        if !(x <= 0.0) {
            pos = true;
        }
    }
    if !neg {
        return p;
    }
    if !pos {
        return vec![];
    }
    let mut out: Vec<V3> = Vec::with_capacity(n + 2);
    for i in 0..n {
        let j = if i + 1 == n { 0 } else { i + 1 };
        if d[i] >= 0.0 {
            out.push(p[i]);
        }
        if (d[i] > 0.0 && d[j] < 0.0) || (d[i] < 0.0 && d[j] > 0.0) {
            let (a, da, b, db) = if d[i] > 0.0 { (p[i], d[i], p[j], d[j]) } else { (p[j], d[j], p[i], d[i]) };
            let t = da / (da - db);
            out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
        }
    }
    dedupe_polygon(out, eps)
}

/// Distance from u to a planar convex polygon P, counter-clockwise around the unit normal m.
/// packages/boundary/src/chains.ts: polygonDistance
pub fn polygon_distance(u: V3, p: &[V3], m: V3) -> f64 {
    let h = dot3(sub3(u, p[0]), m);
    let f: V3 = [u[0] - h * m[0], u[1] - h * m[1], u[2] - h * m[2]];
    let mut inside = true;
    let mut i = 0;
    while i < p.len() && inside {
        let a = p[i];
        let b = p[(i + 1) % p.len()];
        if dot3(cross3(sub3(b, a), sub3(f, a)), m) < 0.0 {
            inside = false;
        }
        i += 1;
    }
    if inside {
        return h.abs();
    }
    let mut best = f64::INFINITY;
    for i in 0..p.len() {
        best = math::min(best, point_segment_distance3(u, p[i], p[(i + 1) % p.len()]));
    }
    best
}

/// The cone from u over a planar convex polygon G (counter-clockwise around the direction the rays
/// travel, u strictly before G's plane), as inward unit normals of its faces; None when the cone is
/// thinner than MIN_WINDOW_ANGLE by the upper bound of rule 3. `dist` is dist(u, G) (the source
/// computes it from G's own plane when the caller does not give it; every caller here does).
/// packages/boundary/src/chains.ts: coneOver
pub fn cone_over(u: V3, g: &[V3], dist: f64) -> Option<Vec<V3>> {
    let n = g.len();
    let rays: Vec<V3> = g.iter().map(|&p| unit3(sub3(p, u))).collect();
    let mut normals: Vec<V3> = Vec::with_capacity(n);
    for j in 0..n {
        let c = cross3(rays[j], rays[(j + 1) % n]);
        let l = norm3(c);
        if l < 1e-15 {
            continue;
        }
        normals.push([c[0] / l, c[1] / l, c[2] / l]);
    }
    if normals.len() < 3 {
        return None;
    }
    if !(dist > 0.0) {
        return Some(normals);
    }
    // upper bound on the window's angular height above each face (rule 3): max_v N.(v - u) / dist(u, G)
    let mut thin = f64::INFINITY;
    for nn in &normals {
        let mut hmax = 0.0;
        for p in g {
            hmax = math::max(hmax, nn[0] * (p[0] - u[0]) + nn[1] * (p[1] - u[1]) + nn[2] * (p[2] - u[2]));
        }
        thin = math::min(thin, hmax / dist);
    }
    if thin < MIN_WINDOW_ANGLE {
        None
    } else {
        Some(normals)
    }
}

/// All chains from the point u (local coordinates at edge s) of cell `anchor` that a ray of length
/// <= reach avoiding the hinges can follow. The anchor itself is node 0.
/// packages/boundary/src/chains.ts: enumerateChains
pub fn enumerate_chains(poly: &Polytope, s: f64, anchor: usize, u: &[f64], reach: f64, opts: &ChainOptions) -> Result<Vec<ChainNode>, ChainLimitError> {
    let max_chains = opts.max_chains.unwrap_or(20000.0);
    let max_depth = opts.max_depth.unwrap_or(256.0);
    let t = topo(poly);
    let eta = opts.snap.unwrap_or_else(|| ridge_snap(s, None));
    let uc = clamp_to_cell(poly, anchor, u, s, eta);
    let sc = math::max(1.0, s);
    let eps = 1e-14 * sc;
    let slack = 1e-12 * sc;
    let mut out: Vec<ChainNode> = vec![ChainNode::root(anchor)];
    let mut clip_d: Vec<f64> = Vec::with_capacity(32);
    let mut idx = 0;
    while idx < out.len() {
        let node_cell = out[idx].cell;
        let node_to_anchor = out[idx].to_anchor;
        let node_entry = out[idx].entry;
        let node_depth = out[idx].depth;
        let node_run_edge = out[idx].run_edge;
        let node_run_angle = out[idx].run_angle;
        let ct = &t.cells[node_cell];
        let u_loc = iso_apply(&iso_inverse(&node_to_anchor), uc);
        let is_root = node_depth == 0;
        for k in 0..ct.f {
            if k as i32 == node_entry {
                continue;
            }
            let pl = &ct.planes[k];
            // > 0: u strictly on the inner side of this facet's plane (seen from the developed cell).
            // At the anchor the clamped centre is in the closed cell, so delta <= eta (even < 0, by
            // rounding) means it lies on this facet: the half-space window below. Deeper, rule 1.
            let delta = pl.h * s - dot3(pl.n, u_loc);
            if !is_root && delta <= eta {
                continue;
            }
            // the gate lies in the ridge's plane, so it is at least the distance of u from that plane away (the development is an
            // isometry): a ridge farther than the reach needs neither its polygon nor its clipping
            if delta > reach + slack {
                continue;
            }
            let mut run_edge = -1i32;
            let mut run_angle = 0.0;
            if !is_root {
                let h = ct.pair_hinge[node_entry as usize * ct.f + k];
                if h >= 0 {
                    let e = t.hinge_edge[node_cell][h as usize];
                    run_angle = (if e == node_run_edge { node_run_angle } else { 0.0 }) + ct.hinge_dihedral[h as usize];
                    if run_angle >= math::PI - 1e-9 {
                        continue;
                    }
                    run_edge = e;
                }
            }
            let mut q: Vec<V3> = ct.polys[k].iter().map(|p| iso_apply(&node_to_anchor, [p[0] * s, p[1] * s, p[2] * s])).collect();
            // m: the direction rays travel when they cross this ridge
            let m = iso_linear(&node_to_anchor, pl.n);
            if dot3(polygon_normal(&q), m) < 0.0 {
                q.reverse();
            }
            let gate: Vec<V3>;
            let window: Vec<V3>;
            let gate_dist: f64;
            if is_root && delta <= eta {
                // the centre lies on this ridge: rays leaving through it fill the closed half-space beyond
                gate = q;
                window = vec![m];
                gate_dist = polygon_distance(uc, &gate, m);
                if gate_dist > reach + slack {
                    continue;
                }
            } else {
                let mut g = q;
                for nn in &out[idx].window {
                    g = clip_polygon_by_plane(g, *nn, uc, eps, &mut clip_d);
                    if g.len() < 3 {
                        break;
                    }
                }
                if g.len() < 3 {
                    continue;
                }
                gate = g;
                gate_dist = polygon_distance(uc, &gate, m);
                if gate_dist > reach + slack {
                    continue;
                }
                match cone_over(uc, &gate, gate_dist) {
                    None => continue,
                    Some(cone) => window = cone,
                }
            }
            if out.len() as f64 >= max_chains {
                return Err(ChainLimitError(format!(
                    "more than {} chains of cells within distance {} of a point of cell {}: the polytope is far too small for its pieces",
                    num(max_chains),
                    num(reach),
                    anchor
                )));
            }
            if (node_depth + 1) as f64 > max_depth {
                return Err(ChainLimitError(format!("a chain of more than {} cells from a point of cell {}", num(max_depth), anchor)));
            }
            let g = &ct.glue[k];
            let gs = Iso3 { m: g.m, t: [g.t[0] * s, g.t[1] * s, g.t[2] * s] };
            let facet = &poly.cells[node_cell].facets[k];
            let mut cells = Vec::with_capacity(out[idx].cells.len() + 1);
            cells.extend_from_slice(&out[idx].cells);
            cells.push(facet.neighbor);
            out.push(ChainNode {
                cell: facet.neighbor,
                to_anchor: iso_compose(&node_to_anchor, &iso_inverse(&gs)),
                window,
                gate,
                gate_dist,
                entry: facet.neighbor_facet as i32,
                parent: idx as i32,
                depth: node_depth + 1,
                cells,
                run_edge,
                run_angle,
            });
        }
        idx += 1;
    }
    Ok(out)
}

/// Is the point y (anchor frame) in the node's closed window, up to tol (0 in the source's default)?
/// packages/boundary/src/chains.ts: inWindow
#[inline]
pub fn in_window(node: &ChainNode, u: V3, y: V3, tol: f64) -> bool {
    for n in &node.window {
        if n[0] * (y[0] - u[0]) + n[1] * (y[1] - u[1]) + n[2] * (y[2] - u[2]) < -tol {
            return false;
        }
    }
    true
}

/// The parameter interval [t0, t1] of the segment a + t (b - a), t in [0, 1], inside the closed window; None if empty.
/// packages/boundary/src/chains.ts: clipSegmentToWindow
pub fn clip_segment_to_window(window: &[V3], u: V3, a: V3, b: V3) -> Option<(f64, f64)> {
    let mut t0 = 0.0;
    let mut t1 = 1.0;
    for n in window {
        let fa = n[0] * (a[0] - u[0]) + n[1] * (a[1] - u[1]) + n[2] * (a[2] - u[2]);
        let fb = n[0] * (b[0] - u[0]) + n[1] * (b[1] - u[1]) + n[2] * (b[2] - u[2]);
        // f(t) = fa + t (fb - fa) >= 0
        let df = fb - fa;
        if df == 0.0 {
            if fa < 0.0 {
                return None;
            }
            continue;
        }
        let t = -fa / df;
        if df > 0.0 {
            t0 = math::max(t0, t);
        } else {
            t1 = math::min(t1, t);
        }
        if t0 > t1 {
            return None;
        }
    }
    Some((t0, t1))
}

/// Distances from u to the hinges seen through each chain (the hinge segment clipped to the window), minimum over all.
/// packages/boundary/src/chains.ts: hingeDistanceOverChains
pub fn hinge_distance_over_chains(poly: &Polytope, s: f64, nodes: &[ChainNode], u: V3) -> f64 {
    let t = topo(poly);
    let mut best = f64::INFINITY;
    let mut v: Vec<V3> = Vec::new();
    for node in nodes {
        let ct = &t.cells[node.cell];
        v.clear();
        v.extend(ct.verts.iter().map(|p| iso_apply(&node.to_anchor, [p[0] * s, p[1] * s, p[2] * s])));
        for &[i, j] in &poly.cells[node.cell].hinges {
            let a = v[i];
            let b = v[j];
            let Some(iv) = clip_segment_to_window(&node.window, u, a, b) else { continue };
            let e = sub3(b, a);
            let p0: V3 = [a[0] + iv.0 * e[0], a[1] + iv.0 * e[1], a[2] + iv.0 * e[2]];
            let p1: V3 = [a[0] + iv.1 * e[0], a[1] + iv.1 * e[1], a[2] + iv.1 * e[2]];
            best = math::min(best, point_segment_distance3(u, p0, p1));
        }
    }
    best
}
