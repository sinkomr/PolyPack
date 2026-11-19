//! Unit cubes on the tesseract, the axis-aligned family. Port of packages/boundary/src/search/cubes.ts.
//!
//! Every gluing of the tesseract maps local axes to local axes (a signed permutation), so a cube
//! aligned with its anchor's axes stays aligned in every cell it reaches, and it is the box u +- 1/2
//! in its anchor's local coordinates. With 1 <= s its interior avoids the hinges exactly when it
//! crosses the anchor's faces (u_k +- 1/2 contains +-s/2) in at most one axis. A cube crossing face k
//! (depth d = |u_k| + 1/2 - s/2 > 0) has two parts, both boxes: the box clipped to the anchor cell, and
//! the slab beyond the face, in the neighbour (j, tau), j the 4D axis of local axis k and tau the sign
//! of u_k. So validity is: at most one crossing per cube, and boxes of distinct cubes in a cell disjoint.
//!
//! Energy: for each cube the squared crossing depths except the largest (line crossing), and for each
//! pair of parts of distinct cubes in a cell the squared penetration depth of the two boxes (the
//! smallest overlap over the three axes). Every box bound is a * u + b in a single coordinate, so the
//! gradient is exact.
//!
//! Starts: the two rings: the cycles of cells (+-e1, +-e2) and (+-e3, +-e4) each develop into a
//! straight row of four cells with trivial holonomy, a flat solid torus of length 4 s, so ceil(P / 2)
//! cubes slide round one of them at s = ceil(P / 2) / 4 (and the rest round the other); random layouts
//! at s = 2; hops that move one to three cubes.

use super::balls::{clamped_pieces, plain_state};
use super::chart::{random_cell_point, Charts};
use super::model::{copy_state, Finish, PieceModel, State};
use super::random::Mulberry32;
use super::{Halt, Res};
use crate::linalg::quaternion_to_matrix;
use crate::polytope::Polytope;
use crate::types::{BoundaryConfig, BoundaryPiece};
use polypack_js::math;

/// Local axis k of tesseract cell (i, sg) is the 4D axis AX[i][k].
const AX: [[usize; 3]; 4] = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];

/// At most 4 parts per cube (an invalid cube crossing three faces has three slabs).
const MAX_PARTS: usize = 4;

/// packages/boundary/src/search/cubes.ts: AlignedCubeModel
pub struct AlignedCubeModel {
    poly: &'static Polytope,
    p: usize,
    charts: Charts,
    floor: f64,
    // parts: cell, cube, and per axis the bounds lo = loA U[loI] + loB, hi = hiA U[hiI] + hiB (I = -1: constant)
    p_cell: Vec<usize>,
    p_cube: Vec<usize>,
    lo_i: Vec<i64>,
    lo_a: Vec<f64>,
    lo_b: Vec<f64>,
    hi_i: Vec<i64>,
    hi_a: Vec<f64>,
    hi_b: Vec<f64>,
    order: Vec<usize>,
}

impl AlignedCubeModel {
    pub fn new(poly: &'static Polytope, p: usize) -> AlignedCubeModel {
        assert!(poly.name == "tesseract", "search: aligned cubes exist on the tesseract only");
        // no aligned unit cube fits in a cell of edge < 1; and the volume bound P <= 8 s^3
        let floor = math::max(1.0, math::cbrt(p as f64 / 8.0));
        let n = MAX_PARTS * p;
        AlignedCubeModel {
            poly,
            p,
            charts: Charts::new(poly),
            floor,
            p_cell: vec![0; n],
            p_cube: vec![0; n],
            lo_i: vec![0; 3 * n],
            lo_a: vec![0.0; 3 * n],
            lo_b: vec![0.0; 3 * n],
            hi_i: vec![0; 3 * n],
            hi_a: vec![0.0; 3 * n],
            hi_b: vec![0.0; 3 * n],
            order: vec![0; n],
        }
    }

    /// Builds the parts of every cube; returns their count and the line-crossing term (energy, or with
    /// `violation` the largest second crossing depth), adding the term's gradient into g.
    /// packages/boundary/src/search/cubes.ts: AlignedCubeModel.build
    fn build(&mut self, st: &State, s: f64, mut g: Option<&mut [f64]>, violation: bool) -> (usize, f64) {
        let h = s / 2.0;
        let u = &st.u;
        let mut n = 0usize;
        let mut line = if violation { f64::NEG_INFINITY } else { 0.0 };
        let mut dep = [0.0f64; 3];
        let mut lo4_i = [0i64; 4];
        let mut lo4_a = [0.0f64; 4];
        let mut lo4_b = [0.0f64; 4];
        let mut hi4_i = [0i64; 4];
        let mut hi4_a = [0.0f64; 4];
        let mut hi4_b = [0.0f64; 4];
        for q in 0..self.p {
            let c = st.cells[q];
            let i = c >> 1;
            let sg = if c & 1 == 1 { 1.0 } else { -1.0 };
            let o = 3 * q;
            let mut ncross = 0;
            let mut kmax: i64 = -1;
            for k in 0..3 {
                dep[k] = u[o + k].abs() + 0.5 - h;
                if dep[k] > 0.0 {
                    ncross += 1;
                    if kmax < 0 || dep[k] > dep[kmax as usize] {
                        kmax = k as i64;
                    }
                }
            }
            if violation {
                // the second largest depth: <= 0 exactly when at most one axis crosses
                let mut sorted = dep;
                sorted.sort_by(|a, b| {
                    let d = b - a;
                    if d < 0.0 {
                        std::cmp::Ordering::Less
                    } else if d > 0.0 {
                        std::cmp::Ordering::Greater
                    } else {
                        std::cmp::Ordering::Equal
                    }
                });
                line = math::max(line, sorted[1]);
            } else if ncross >= 2 {
                for k in 0..3 {
                    if dep[k] > 0.0 && k as i64 != kmax {
                        line += dep[k] * dep[k];
                        if let Some(g) = g.as_deref_mut() {
                            g[o + k] += 2.0 * dep[k] * (if u[o + k] >= 0.0 { 1.0 } else { -1.0 });
                        }
                    }
                }
            }
            // the part in the anchor cell
            let a = n;
            n += 1;
            self.p_cell[a] = c;
            self.p_cube[a] = q;
            for k in 0..3 {
                let x = 3 * a + k;
                self.lo_i[x] = (o + k) as i64;
                self.lo_a[x] = 1.0;
                self.lo_b[x] = -0.5;
                self.hi_i[x] = (o + k) as i64;
                self.hi_a[x] = 1.0;
                self.hi_b[x] = 0.5;
                if dep[k] > 0.0 {
                    if u[o + k] > 0.0 {
                        self.hi_i[x] = -1;
                        self.hi_a[x] = 0.0;
                        self.hi_b[x] = h;
                    } else {
                        self.lo_i[x] = -1;
                        self.lo_a[x] = 0.0;
                        self.lo_b[x] = -h;
                    }
                }
            }
            // a slab beyond each crossed face
            for k in 0..3 {
                if !(dep[k] > 0.0) {
                    continue;
                }
                let tau = if u[o + k] > 0.0 { 1.0 } else { -1.0 };
                let j = AX[i][k];
                let c2 = 2 * j + if tau > 0.0 { 1 } else { 0 };
                // along the old normal axis i: from the shared 2-face x_i = sg h, depth d = tau u_k + 1/2 - h
                if sg > 0.0 {
                    lo4_i[i] = (o + k) as i64;
                    lo4_a[i] = -tau;
                    lo4_b[i] = 2.0 * h - 0.5;
                    hi4_i[i] = -1;
                    hi4_a[i] = 0.0;
                    hi4_b[i] = h;
                } else {
                    lo4_i[i] = -1;
                    lo4_a[i] = 0.0;
                    lo4_b[i] = -h;
                    hi4_i[i] = (o + k) as i64;
                    hi4_a[i] = tau;
                    hi4_b[i] = 0.5 - 2.0 * h;
                }
                for m in 0..3 {
                    if m == k {
                        continue;
                    }
                    let gm = AX[i][m];
                    let x = 3 * a + m;
                    lo4_i[gm] = self.lo_i[x];
                    lo4_a[gm] = self.lo_a[x];
                    lo4_b[gm] = self.lo_b[x];
                    hi4_i[gm] = self.hi_i[x];
                    hi4_a[gm] = self.hi_a[x];
                    hi4_b[gm] = self.hi_b[x];
                }
                let b = n;
                n += 1;
                self.p_cell[b] = c2;
                self.p_cube[b] = q;
                for pp in 0..3 {
                    let gp = AX[j][pp];
                    let x = 3 * b + pp;
                    self.lo_i[x] = lo4_i[gp];
                    self.lo_a[x] = lo4_a[gp];
                    self.lo_b[x] = lo4_b[gp];
                    self.hi_i[x] = hi4_i[gp];
                    self.hi_a[x] = hi4_a[gp];
                    self.hi_b[x] = hi4_b[gp];
                }
            }
        }
        (n, line)
    }

    fn bound(i: &[i64], a: &[f64], b: &[f64], x: usize, u: &[f64]) -> f64 {
        if i[x] < 0 {
            b[x]
        } else {
            a[x] * u[i[x] as usize] + b[x]
        }
    }

    /// Penalty energy (violation = false) or largest violation of the state at edge s.
    /// packages/boundary/src/search/cubes.ts: AlignedCubeModel.evaluate
    fn evaluate(&mut self, st: &State, s: f64, mut g: Option<&mut [f64]>, violation: bool) -> f64 {
        let (n, line) = self.build(st, s, g.as_deref_mut(), violation);
        let u = &st.u;
        let mut e = line;
        // parts by cell (counting sort)
        let mut first = [0usize; 9];
        for p in 0..n {
            first[self.p_cell[p] + 1] += 1;
        }
        for c in 0..8 {
            first[c + 1] += first[c];
        }
        let mut fill: [usize; 8] = [0; 8];
        fill.copy_from_slice(&first[..8]);
        for p in 0..n {
            let c = self.p_cell[p];
            self.order[fill[c]] = p;
            fill[c] += 1;
        }
        for c in 0..8 {
            for x in first[c]..first[c + 1] {
                let a = self.order[x];
                for y in (x + 1)..first[c + 1] {
                    let b = self.order[y];
                    if self.p_cube[a] == self.p_cube[b] {
                        continue;
                    }
                    let mut best = f64::INFINITY;
                    let mut hi_x = usize::MAX;
                    let mut lo_x = usize::MAX;
                    for m in 0..3 {
                        let ha = Self::bound(&self.hi_i, &self.hi_a, &self.hi_b, 3 * a + m, u);
                        let hb = Self::bound(&self.hi_i, &self.hi_a, &self.hi_b, 3 * b + m, u);
                        let la = Self::bound(&self.lo_i, &self.lo_a, &self.lo_b, 3 * a + m, u);
                        let lb = Self::bound(&self.lo_i, &self.lo_a, &self.lo_b, 3 * b + m, u);
                        let ov = math::min(ha, hb) - math::max(la, lb);
                        if ov < best {
                            best = ov;
                            hi_x = if ha < hb { 3 * a + m } else { 3 * b + m };
                            lo_x = if la > lb { 3 * a + m } else { 3 * b + m };
                        }
                        if !violation && ov <= 0.0 {
                            break;
                        }
                    }
                    if violation {
                        e = math::max(e, best);
                        continue;
                    }
                    if !(best > 0.0) {
                        continue;
                    }
                    e += best * best;
                    let Some(g) = g.as_deref_mut() else { continue };
                    // (an index never set is the source's -1: undefined, no gradient)
                    if hi_x != usize::MAX && self.hi_i[hi_x] >= 0 {
                        g[self.hi_i[hi_x] as usize] += 2.0 * best * self.hi_a[hi_x];
                    }
                    if lo_x != usize::MAX && self.lo_i[lo_x] >= 0 {
                        g[self.lo_i[lo_x] as usize] -= 2.0 * best * self.lo_a[lo_x];
                    }
                }
            }
        }
        e
    }
}

impl Finish for AlignedCubeModel {
    fn floor(&self) -> f64 {
        self.floor
    }

    fn violation(&mut self, st: &State, s: f64) -> f64 {
        self.evaluate(st, s, None, true)
    }

    fn pieces(&mut self, st: &State, s: f64) -> Vec<BoundaryPiece> {
        clamped_pieces(self.poly, st, s)
    }
}

impl PieceModel for AlignedCubeModel {
    fn target(&self) -> f64 {
        1e-20
    }

    fn max_step(&self) -> f64 {
        0.25
    }

    fn energy(&mut self, st: &State, s: f64, g: &mut [f64]) -> f64 {
        g.fill(0.0);
        self.evaluate(st, s, Some(g), false)
    }

    fn start_edge(&self) -> f64 {
        // 8 k^3 aligned cubes fit at s = k (k^3 per cell); s = 2 holds 64
        math::max(2.0, math::ceil(math::cbrt(self.p as f64 / 8.0)))
    }

    fn random_state(&mut self, s: f64, rand: &mut Mulberry32) -> State {
        let mut cells = vec![0usize; self.p];
        let mut u = vec![0.0; 3 * self.p];
        // centres within 1/2 of the cell's centre (the prototype's start at s = 2)
        let shrink = math::min(1.0, 1.0 / s);
        for q in 0..self.p {
            cells[q] = rand.int(8);
            u[3 * q..3 * q + 3].copy_from_slice(&random_cell_point(self.poly, cells[q], s, rand, shrink));
        }
        State { cells, u, r: None }
    }

    fn hop(&mut self, st: &State, s: f64, rand: &mut Mulberry32) -> State {
        let mut out = copy_state(st);
        let k = 1 + rand.int(3);
        for _ in 0..k {
            let q = rand.int(self.p);
            out.cells[q] = rand.int(8);
            out.u[3 * q..3 * q + 3].copy_from_slice(&random_cell_point(self.poly, out.cells[q], s, rand, 1.0));
        }
        out
    }

    /// The two rings at s = max(1, ceil(P / 2) / 4) (1 + 1e-6), with a random phase.
    fn constructed_start(&mut self, rand: &mut Mulberry32) -> Res<Option<(State, f64)>> {
        let n_a = math::ceil(self.p as f64 / 2.0) as usize;
        let s = math::max(1.0, n_a as f64 / 4.0) * (1.0 + 1e-6);
        let phase = rand.next();
        let st = two_rings(&self.charts, s, n_a, self.p - n_a, phase)?;
        Ok(Some((st, s)))
    }

    fn state_of(&self, config: &BoundaryConfig) -> Option<State> {
        let st = plain_state(self.poly, config, self.p)?;
        // a rotation is fine when it maps the cube's axes to axes (a symmetry of the cube)
        for p in &config.pieces {
            let Some(q) = &p.q else { continue };
            let m = quaternion_to_matrix(q);
            if m.iter().any(|x| math::min(x.abs(), (x.abs() - 1.0).abs()) > 1e-9) {
                return None;
            }
        }
        Some(st)
    }
}

/// The two-rings layout at edge s: nA cubes round the ring of cells 0..3 (from the centre of cell 1
/// along its local axis 0, the 4D axis 1) and nB round the ring of cells 4..7 (from the centre of
/// cell 5 along its local axis 2, the 4D axis 3), evenly spaced along the ring's length 4 s from
/// `phase`. The rays run through the centres of the cells' faces, far from the hinges.
/// packages/boundary/src/search/cubes.ts: twoRings
pub fn two_rings(charts: &Charts, s: f64, n_a: usize, n_b: usize, phase: f64) -> Res<State> {
    let p = n_a + n_b;
    let mut cells = vec![0usize; p];
    let mut u = vec![0.0; 3 * p];
    let mut m = [0.0f64; 9];
    let zero = [0.0f64; 3];
    let l = 4.0 * s;
    let mut q = 0;
    for (c0, k, n) in [(1usize, 0usize, n_a), (5, 2, n_b)] {
        for j in 0..n {
            let d = (phase + (j as f64 * l) / n as f64) % l;
            let mut v = [0.0f64; 3];
            v[k] = d;
            let c = charts.move_(c0, &zero, 0, v[0], v[1], v[2], s, &mut u, 3 * q, &mut m, 0);
            if c < 0 {
                return Err(Halt::Error("search: a ring ray met a hinge".to_string()));
            }
            cells[q] = c as usize;
            q += 1;
        }
    }
    Ok(State { cells, u, r: None })
}
