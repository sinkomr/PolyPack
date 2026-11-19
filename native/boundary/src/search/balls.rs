//! Unit balls: the penalty energy and the exact violation of a state, by the distance form of the
//! validator (validate.rs): every centre at geodesic distance >= 1 from the hinges (clearance),
//! every two centres >= 2 apart along every geodesic, and every geodesic loop at a centre >= 2.
//! Port of packages/boundary/src/search/balls.ts (working units: balls of radius 1; ball_site.rs
//! converts to site units).
//!
//! Energy: the sum of the squared violations, (1 - clearance)^2 per near hinge, (2 - d)^2 for every
//! realised straight geodesic of length d < 2 between two centres, and (2 - d)^2 for every such loop.
//! The gradient is analytic: a geodesic is a straight segment from u_i to the image y = M u_j + t of
//! u_j in u_i's development, so d(d)/du_i = (u_i - y) / d and d(d)/du_j = M^T (y - u_i) / d.
//!
//! Two metrics give the geodesics:
//!  - `WordMetric` (the tesseract): the lattice words of tesseract.rs, flattened. A word's map is a
//!    signed permutation, y = M u_j + h t, and the word is realised when the segment u_i -> y crosses
//!    the word's lattice planes in its order. The clearance has the closed form of tesseractClearance,
//!    one term per edge direction. Pairs whose centres are >= 2 apart in R^4 are skipped.
//!  - `ChainMetric` (any polytope): the chains of chains.rs from each centre (reach 2), the hinges
//!    clipped to each chain's window for the clearance.

use super::chart::random_cell_point;
use super::model::{copy_state, Finish, PieceModel, State};
use super::random::Mulberry32;
use super::tesseract::{axes_of, TesseractWords};
use super::Res;
use crate::chains::{clamp_to_cell, clip_segment_to_window, enumerate_chains, in_window, ridge_snap, ChainOptions};
use crate::linalg::{iso_apply, point_segment_distance3, V3};
use crate::polytope::{boundary_volume, cell_excess, topo, Polytope};
use crate::types::{BoundaryConfig, BoundaryPiece};
use polypack_js::math;
use std::sync::OnceLock;

/// packages/boundary/src/search/balls.ts: BallMetric. The penalty energy at edge s (adding its gradient
/// with respect to U into g when g is given), or with `violation` the largest violation
/// max(1 - clearance, 2 - distance, 2 - loop) over every realised geodesic (-Infinity when nothing is near).
pub trait BallMetric {
    fn evaluate(&mut self, cells: &[usize], u: &[f64], s: f64, g: Option<&mut [f64]>, violation: bool) -> f64;
}

// ---------------------------------------------------------------- tesseract: lattice words

const MAX_STEPS: usize = 6;

/// Words of one length class, flattened: y_r = sign_r u2[perm_r] + h t_r; steps (k, level), at most 6.
struct WordTable {
    /// First word and count per (c1, c2), at 8 c1 + c2.
    start: [usize; 64],
    count: [usize; 64],
    perm: Vec<u8>,
    sign: Vec<f64>,
    t: Vec<f64>,
    nst: Vec<u8>,
    st_k: Vec<u8>,
    st_l: Vec<f64>,
}

/// packages/boundary/src/search/balls.ts: buildTable
fn build_table(words: &TesseractWords, keep: &dyn Fn(&[i32; 3]) -> bool) -> WordTable {
    let mut lists: Vec<Vec<&super::tesseract::Word>> = Vec::with_capacity(64);
    for c1 in 0..8 {
        for c2 in 0..8 {
            lists.push(words.list(c1, c2).iter().filter(|w| keep(&w.m)).collect());
        }
    }
    let n: usize = lists.iter().map(|l| l.len()).sum();
    let mut tb = WordTable {
        start: [0; 64],
        count: [0; 64],
        perm: vec![0; 3 * n],
        sign: vec![0.0; 3 * n],
        t: vec![0.0; 3 * n],
        nst: vec![0; n],
        st_k: vec![0; MAX_STEPS * n],
        st_l: vec![0.0; MAX_STEPS * n],
    };
    let mut w = 0;
    for (key, list) in lists.iter().enumerate() {
        let c2 = key & 7;
        let i2 = c2 >> 1;
        let ax2 = axes_of(i2);
        let mut off2 = [0.0; 4];
        off2[i2] = if c2 & 1 == 1 { 1.0 } else { -1.0 };
        tb.start[key] = w;
        tb.count[key] = list.len();
        for word in list {
            // y = A^T (x2 - h b), x2 = E2 u2 + h off2: M = A^T E2 (M[r][k] = A[ax2[k]][r]), t = A^T (off2 - b)
            for r in 0..3 {
                let mut found: i32 = -1;
                for k in 0..3 {
                    let v = word.a[ax2[k]][r];
                    if v != 0.0 {
                        assert!(!(found >= 0 || (v.abs() - 1.0).abs() > 1e-12), "search: a lattice word's map is not a signed permutation");
                        found = k as i32;
                        tb.perm[3 * w + r] = k as u8;
                        tb.sign[3 * w + r] = if v > 0.0 { 1.0 } else { -1.0 };
                    }
                }
                assert!(found >= 0, "search: a lattice word's map is singular");
                let mut t = 0.0;
                for j in 0..4 {
                    t += word.a[j][r] * (off2[j] - word.b[j]);
                }
                tb.t[3 * w + r] = t;
            }
            assert!(word.steps.len() <= MAX_STEPS, "search: a lattice word is too long");
            tb.nst[w] = word.steps.len() as u8;
            for (q, st) in word.steps.iter().enumerate() {
                tb.st_k[MAX_STEPS * w + q] = st.0 as u8;
                tb.st_l[MAX_STEPS * w + q] = st.1 as f64;
            }
            w += 1;
        }
    }
    tb
}

/// The two tables of the word metric (about 16,000 words), built once per process.
struct WordTables {
    /// |m_k| <= 2, at most one axis at 2: s < 2.
    wide: WordTable,
    /// |m_k| <= 1: s >= 2.
    narrow: WordTable,
}

fn word_tables() -> &'static WordTables {
    static TABLES: OnceLock<WordTables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let words = TesseractWords::new(2);
        WordTables {
            wide: build_table(&words, &|m| m.iter().map(|x| x.abs()).max().unwrap() <= 2 && m.iter().filter(|x| x.abs() == 2).count() <= 1),
            narrow: build_table(&words, &|m| m.iter().map(|x| x.abs()).max().unwrap() <= 1),
        }
    })
}

/// packages/boundary/src/search/balls.ts: WordMetric
pub struct WordMetric {
    tables: &'static WordTables,
    x4: Vec<f64>,
}

impl WordMetric {
    pub fn new() -> WordMetric {
        WordMetric { tables: word_tables(), x4: Vec::new() }
    }

    /// Is the word realised from u to y: are its planes crossed in its order, within [0, 1]? A step
    /// whose plane holds the whole segment (both ends on it: two points of one ridge, seen from either
    /// cell) is crossed at any time, so it does not constrain the order; its crossing time would be 0 / 0.
    fn realised(t: &WordTable, w: usize, h: f64, u: &[f64; 3], y: &[f64; 3]) -> bool {
        let eps = 1e-12 * math::max(1.0, h);
        let mut prev = f64::NEG_INFINITY;
        let ns = t.nst[w] as usize;
        for q in 0..ns {
            let k = t.st_k[MAX_STEPS * w + q] as usize;
            let plane = h * t.st_l[MAX_STEPS * w + q];
            if (u[k] - plane).abs() <= eps && (y[k] - plane).abs() <= eps {
                continue;
            }
            let tt = (plane - u[k]) / (y[k] - u[k]);
            if !(tt >= -1e-12 && tt <= 1.0 + 1e-12 && tt > prev) {
                return false;
            }
            prev = tt;
        }
        true
    }
}

impl Default for WordMetric {
    fn default() -> Self {
        Self::new()
    }
}

impl BallMetric for WordMetric {
    /// packages/boundary/src/search/balls.ts: WordMetric.evaluate (without the kernel's options)
    fn evaluate(&mut self, cells: &[usize], uu: &[f64], s: f64, mut g: Option<&mut [f64]>, violation: bool) -> f64 {
        let p = cells.len();
        let h = s / 2.0;
        let t = if h >= 1.0 { &self.tables.narrow } else { &self.tables.wide };
        let mut e = 0.0;
        let mut worst = f64::NEG_INFINITY;
        // clearance, closed form: the nearest edge of each of the three directions
        for i in 0..p {
            let o = 3 * i;
            let a0 = h - uu[o].abs();
            let a1 = h - uu[o + 1].abs();
            let a2 = h - uu[o + 2].abs();
            for ed in 0..3 {
                let a = if ed == 0 { 1 } else { 0 };
                let b = if ed == 2 { 1 } else { 2 };
                let aa = if a == 0 { a0 } else { a1 };
                let ab = if b == 1 { a1 } else { a2 };
                let cl = math::sqrt(aa * aa + ab * ab);
                if violation {
                    if 1.0 - cl > worst {
                        worst = 1.0 - cl;
                    }
                } else if cl < 1.0 {
                    e += (1.0 - cl) * (1.0 - cl);
                    if g.is_some() && cl > 0.0 {
                        let c = (2.0 * (1.0 - cl)) / cl;
                        if let Some(g) = g.as_deref_mut() {
                            g[o + a] += c * aa * (if uu[o + a] >= 0.0 { 1.0 } else { -1.0 });
                            g[o + b] += c * ab * (if uu[o + b] >= 0.0 { 1.0 } else { -1.0 });
                        }
                    }
                }
            }
        }
        // centres in R^4, for the chord test
        if self.x4.len() < 4 * p {
            self.x4 = vec![0.0; 4 * p];
        }
        let xs = &mut self.x4;
        for i in 0..p {
            let c = cells[i];
            let ax = c >> 1;
            let mut k = 0;
            for j in 0..4 {
                xs[4 * i + j] = if j == ax {
                    if c & 1 == 1 {
                        h
                    } else {
                        -h
                    }
                } else {
                    let v = uu[3 * i + k];
                    k += 1;
                    v
                };
            }
        }
        let mut y = [0.0f64; 3];
        let mut u = [0.0f64; 3];
        for i in 0..p {
            u[0] = uu[3 * i];
            u[1] = uu[3 * i + 1];
            u[2] = uu[3 * i + 2];
            for j in i..p {
                let selfp = j == i;
                if !selfp {
                    let d0 = xs[4 * i] - xs[4 * j];
                    let d1 = xs[4 * i + 1] - xs[4 * j + 1];
                    let d2 = xs[4 * i + 2] - xs[4 * j + 2];
                    let d3 = xs[4 * i + 3] - xs[4 * j + 3];
                    if d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3 >= 4.0 {
                        continue;
                    }
                }
                let key = 8 * cells[i] + cells[j];
                let w0 = t.start[key];
                let w1 = w0 + t.count[key];
                let o = 3 * j;
                for w in w0..w1 {
                    if selfp && t.nst[w] == 0 {
                        continue;
                    }
                    y[0] = t.sign[3 * w] * uu[o + t.perm[3 * w] as usize] + h * t.t[3 * w];
                    y[1] = t.sign[3 * w + 1] * uu[o + t.perm[3 * w + 1] as usize] + h * t.t[3 * w + 1];
                    y[2] = t.sign[3 * w + 2] * uu[o + t.perm[3 * w + 2] as usize] + h * t.t[3 * w + 2];
                    let r0 = y[0] - u[0];
                    let r1 = y[1] - u[1];
                    let r2 = y[2] - u[2];
                    let dd = r0 * r0 + r1 * r1 + r2 * r2;
                    // a realised geodesic shorter than 2 (or, for the violation, any realised one)
                    if !violation && dd >= 4.0 {
                        continue;
                    }
                    if selfp && dd <= 1e-24 {
                        continue;
                    }
                    if !Self::realised(t, w, h, &u, &y) {
                        continue;
                    }
                    let d = math::sqrt(dd);
                    if violation {
                        if 2.0 - d > worst {
                            worst = 2.0 - d;
                        }
                        continue;
                    }
                    e += (2.0 - d) * (2.0 - d);
                    let Some(g) = g.as_deref_mut() else { continue };
                    let c = (2.0 * (2.0 - d)) / math::max(d, 1e-15);
                    // dE/du_i = c r; dE/du_j = -c M^T r (for a loop both, on the same piece)
                    g[3 * i] += c * r0;
                    g[3 * i + 1] += c * r1;
                    g[3 * i + 2] += c * r2;
                    g[o + t.perm[3 * w] as usize] -= c * t.sign[3 * w] * r0;
                    g[o + t.perm[3 * w + 1] as usize] -= c * t.sign[3 * w + 1] * r1;
                    g[o + t.perm[3 * w + 2] as usize] -= c * t.sign[3 * w + 2] * r2;
                }
            }
        }
        if violation {
            worst
        } else {
            e
        }
    }
}

// ---------------------------------------------------------------- any polytope: chains

/// packages/boundary/src/search/balls.ts: ChainMetric
pub struct ChainMetric {
    pub poly: &'static Polytope,
}

impl BallMetric for ChainMetric {
    /// packages/boundary/src/search/balls.ts: ChainMetric.evaluate (without the kernel's options)
    fn evaluate(&mut self, cells: &[usize], uu: &[f64], s: f64, mut g: Option<&mut [f64]>, violation: bool) -> f64 {
        let poly = self.poly;
        let t = topo(poly);
        let p = cells.len();
        let mut by_cell: Vec<Vec<usize>> = poly.cells.iter().map(|_| Vec::new()).collect();
        for i in 0..p {
            by_cell[cells[i]].push(i);
        }
        let ne = poly.edges.len();
        let mut edge_d = vec![0.0f64; ne];
        let mut edge_p = vec![0.0f64; 3 * ne];
        let mut e = 0.0;
        let mut worst = f64::NEG_INFINITY;
        let mut verts: Vec<V3> = Vec::new();
        for i in 0..p {
            let u = clamp_to_cell(poly, cells[i], &[uu[3 * i], uu[3 * i + 1], uu[3 * i + 2]], s, ridge_snap(s, None));
            let nodes = match enumerate_chains(poly, s, cells[i], &u, 2.0, &ChainOptions { max_chains: Some(4096.0), ..Default::default() }) {
                Ok(n) => n,
                Err(_) => return f64::INFINITY,
            };
            // Clearance: one term per polytope edge, its least distance over the chains.
            edge_d.fill(f64::INFINITY);
            for (ni, node) in nodes.iter().enumerate() {
                verts.clear();
                verts.extend(t.cells[node.cell].verts.iter().map(|q| iso_apply(&node.to_anchor, [q[0] * s, q[1] * s, q[2] * s])));
                for (hi, &[a, b]) in poly.cells[node.cell].hinges.iter().enumerate() {
                    let Some(iv) = clip_segment_to_window(&node.window, u, verts[a], verts[b]) else { continue };
                    let ev: V3 = [verts[b][0] - verts[a][0], verts[b][1] - verts[a][1], verts[b][2] - verts[a][2]];
                    let l2 = ev[0] * ev[0] + ev[1] * ev[1] + ev[2] * ev[2];
                    let mut tt = if l2 > 0.0 { ((u[0] - verts[a][0]) * ev[0] + (u[1] - verts[a][1]) * ev[1] + (u[2] - verts[a][2]) * ev[2]) / l2 } else { 0.0 };
                    tt = math::min(iv.1, math::max(iv.0, tt));
                    let pt: V3 = [verts[a][0] + tt * ev[0], verts[a][1] + tt * ev[1], verts[a][2] + tt * ev[2]];
                    let d = math::hypot3(u[0] - pt[0], u[1] - pt[1], u[2] - pt[2]);
                    let ge = t.hinge_edge[node.cell][hi] as usize;
                    if d < edge_d[ge] {
                        edge_d[ge] = d;
                        edge_p[3 * ge..3 * ge + 3].copy_from_slice(&pt);
                    }
                }
                // centres of the other balls (those after i) and of this one (loops) in the window
                for &j in &by_cell[node.cell] {
                    if j < i || (j == i && ni == 0) {
                        continue;
                    }
                    let y = iso_apply(&node.to_anchor, if j == i { u } else { [uu[3 * j], uu[3 * j + 1], uu[3 * j + 2]] });
                    if !in_window(node, u, y, 0.0) {
                        continue;
                    }
                    let r: V3 = [y[0] - u[0], y[1] - u[1], y[2] - u[2]];
                    let d = math::hypot3(r[0], r[1], r[2]);
                    if j == i && d <= 1e-12 {
                        continue;
                    }
                    if violation {
                        worst = math::max(worst, 2.0 - d);
                        continue;
                    }
                    if d >= 2.0 {
                        continue;
                    }
                    e += (2.0 - d) * (2.0 - d);
                    let Some(g) = g.as_deref_mut() else { continue };
                    let c = (2.0 * (2.0 - d)) / math::max(d, 1e-15);
                    let m = &node.to_anchor.m;
                    for k in 0..3 {
                        g[3 * i + k] += c * r[k];
                        // M^T r, M the chain's linear part (cell of j -> anchor of i)
                        g[3 * j + k] -= c * (m[k] * r[0] + m[3 + k] * r[1] + m[6 + k] * r[2]);
                    }
                }
            }
            for ed in 0..ne {
                let d = edge_d[ed];
                if !(d < f64::INFINITY) {
                    continue;
                }
                if violation {
                    worst = math::max(worst, 1.0 - d);
                    continue;
                }
                if d >= 1.0 {
                    continue;
                }
                e += (1.0 - d) * (1.0 - d);
                // the nearest point held fixed: d(d)/du = (u - p) / d
                if g.is_some() && d > 0.0 {
                    let c = (2.0 * (1.0 - d)) / d;
                    if let Some(g) = g.as_deref_mut() {
                        for k in 0..3 {
                            g[3 * i + k] -= c * (u[k] - edge_p[3 * ed + k]);
                        }
                    }
                }
            }
        }
        if violation {
            worst
        } else {
            e
        }
    }
}

// ---------------------------------------------------------------- the model

/// Proven lower bounds on s for P balls: one ball needs its centre at distance >= 1 from every
/// hinge, and every point of a regular cell lies within (midradius) s of one of its edges, so
/// s >= 1 / midradius (sqrt 2 for the tesseract); and P ball volumes fit in the boundary's volume.
/// packages/boundary/src/search/balls.ts: ballFloor
pub fn ball_floor(poly: &Polytope, p: usize) -> f64 {
    let t = topo(poly);
    let mut rho = 0.0;
    for (ci, c) in poly.cells.iter().enumerate() {
        let mut near = f64::INFINITY;
        for &[a, b] in &c.hinges {
            near = math::min(near, point_segment_distance3([0.0, 0.0, 0.0], t.cells[ci].verts[a], t.cells[ci].verts[b]));
        }
        rho = math::max(rho, near);
    }
    let volume = math::cbrt((p as f64 * 4.0 * math::PI) / 3.0 / boundary_volume(poly));
    math::max(1.0 / rho, volume)
}

/// packages/boundary/src/search/balls.ts: BallModel
pub struct BallModel {
    pub poly: &'static Polytope,
    pub p: usize,
    metric: Box<dyn BallMetric>,
    floor: f64,
}

impl BallModel {
    /// With the polytope's own metric: the lattice words on the tesseract, the chains elsewhere.
    pub fn new(poly: &'static Polytope, p: usize) -> BallModel {
        let metric: Box<dyn BallMetric> = if poly.name == "tesseract" { Box::new(WordMetric::new()) } else { Box::new(ChainMetric { poly }) };
        BallModel { poly, p, metric, floor: ball_floor(poly, p) }
    }

    /// The generic chain metric on any polytope (the search's `ballMetric: "chains"`).
    pub fn with_chains(poly: &'static Polytope, p: usize) -> BallModel {
        BallModel { poly, p, metric: Box::new(ChainMetric { poly }), floor: ball_floor(poly, p) }
    }
}

impl Finish for BallModel {
    fn floor(&self) -> f64 {
        self.floor
    }

    fn violation(&mut self, st: &State, s: f64) -> f64 {
        self.metric.evaluate(&st.cells, &st.u, s, None, true)
    }

    fn pieces(&mut self, st: &State, s: f64) -> Vec<BoundaryPiece> {
        clamped_pieces(self.poly, st, s)
    }
}

impl PieceModel for BallModel {
    fn target(&self) -> f64 {
        1e-22
    }

    fn max_step(&self) -> f64 {
        0.5
    }

    fn energy(&mut self, st: &State, s: f64, g: &mut [f64]) -> f64 {
        g.fill(0.0);
        self.metric.evaluate(&st.cells, &st.u, s, Some(g), false)
    }

    fn start_edge(&self) -> f64 {
        1.35 * self.floor
    }

    fn random_state(&mut self, s: f64, rand: &mut Mulberry32) -> State {
        let c = self.poly.cells.len();
        let mut cells = vec![0usize; self.p];
        let mut u = vec![0.0; 3 * self.p];
        for i in 0..self.p {
            cells[i] = rand.int(c);
            u[3 * i..3 * i + 3].copy_from_slice(&random_cell_point(self.poly, cells[i], s, rand, 0.6));
        }
        State { cells, u, r: None }
    }

    fn hop(&mut self, st: &State, s: f64, rand: &mut Mulberry32) -> State {
        let mut out = copy_state(st);
        let k = 1 + rand.int(3);
        for _ in 0..k {
            let i = rand.int(self.p);
            out.cells[i] = rand.int(self.poly.cells.len());
            out.u[3 * i..3 * i + 3].copy_from_slice(&random_cell_point(self.poly, out.cells[i], s, rand, 0.6));
        }
        out
    }

    fn constructed_start(&mut self, _rand: &mut Mulberry32) -> Res<Option<(State, f64)>> {
        Ok(None)
    }

    fn state_of(&self, config: &BoundaryConfig) -> Option<State> {
        plain_state(self.poly, config, self.p)
    }
}

/// Cells and centres of a configuration with P pieces in range, or None. Centres are clamped into
/// their closed cells (the charts move centres from inside their cells).
/// packages/boundary/src/search/balls.ts: plainState
pub fn plain_state(poly: &Polytope, config: &BoundaryConfig, p: usize) -> Option<State> {
    if config.pieces.len() != p {
        return None;
    }
    if !(config.s.is_finite() && config.s > 0.0) {
        return None;
    }
    let mut cells = vec![0usize; p];
    let mut u = vec![0.0; 3 * p];
    for i in 0..p {
        let pc = &config.pieces[i];
        if pc.cell >= poly.cells.len() || pc.u.len() != 3 || !pc.u.iter().all(|x| x.is_finite()) {
            return None;
        }
        cells[i] = pc.cell;
        u[3 * i..3 * i + 3].copy_from_slice(&clamp_to_cell(poly, pc.cell, &pc.u, config.s, ridge_snap(config.s, None)));
    }
    Some(State { cells, u, r: None })
}

/// The pieces of a state, each centre clamped into its closed anchor cell exactly (the validator
/// checks it at tol 0). packages/boundary/src/search/balls.ts: clampedPieces
pub fn clamped_pieces(poly: &Polytope, st: &State, s: f64) -> Vec<BoundaryPiece> {
    let mut out = Vec::with_capacity(st.cells.len());
    for i in 0..st.cells.len() {
        let c = st.cells[i];
        let mut u: Vec<f64> = vec![st.u[3 * i], st.u[3 * i + 1], st.u[3 * i + 2]];
        if poly.name == "tesseract" {
            // the cell is [-s/2, s/2]^3 and the validator compares u_k with s * 0.5: clamping is exact
            let h = s * 0.5;
            for x in u.iter_mut() {
                *x = math::min(h, math::max(-h, *x));
            }
        } else {
            u = clamp_to_cell(poly, c, &u, s, ridge_snap(s, None)).to_vec();
            // the cell is convex around its centre (the origin): pull in until no facet is exceeded
            let mut k = 0;
            while k < 60 && cell_excess(poly, c, &u, s) > 0.0 {
                // 2 ** -50 * 2 ** k: two exact powers of two
                let f = (1.0 / (1u64 << 50) as f64) * ((1u64 << k) as f64);
                for x in u.iter_mut() {
                    *x *= 1.0 - f;
                }
                k += 1;
            }
        }
        out.push(BoundaryPiece { cell: c, u, q: None });
    }
    out
}
