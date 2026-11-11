//! The simplex, orthoplex and demicube boundaries for d = 5..10 as cell complexes
//! (docs/spaces/BOUNDARY.md section 4D.1). Port of packages/boundary/src/nd/container.ts (what the
//! validator uses: the cells and `to_ambient`; `pickCell`, `facetLabel`, `vertices` and `toLocal`
//! serve the search and the viewers).
//!
//! The container is a convex d-polytope P of unit edge centred at its vertex centroid,
//! P = { x : n_c . x <= h_c for every cell c }, n_c the unit outward normal of the cell (facet) c.
//! The boundary is the union of the cells; each cell is a (d-1)-dimensional polytope in the
//! hyperplane H_c = { n_c . x = h_c }, glued to its neighbours along ridges. The coordinates are
//! generated in BASE UNITS (edge sqrt 2, rational or, for the demicube's mixed ridges, in
//! Q(sqrt d)) and divided by E0 = sqrt 2:
//!  - simplex (D = d + 1, in the hyperplane sum x = 1): vertices e_0..e_d. Cell i is the facet
//!    x_i = 0 (vertices e_j, j != i); normal (1 - (d+1) e_i) / sqrt(d (d+1)), offset
//!    1 / sqrt(d (d+1)). Every two cells are adjacent. d + 1 cells.
//!  - orthoplex (D = d): vertices +-e_i. Cell c is the facet sigma . x = 1, sigma_i = -1 exactly
//!    when bit i of c is set (vertices sigma_i e_i); normal sigma / sqrt d, offset 1 / sqrt d.
//!    Cells c and c xor 2^k are adjacent. 2^d cells.
//!  - demicube (D = d): vertices (+-1/2)^d with an even number of minus signs. Cells 0..2d-1: the
//!    facet x_i = a/2 (a = +-1) has id 2 i + (a > 0), a (d-1)-demicube, normal a e_i, offset 1/2.
//!    Cells 2d + k: the facet w . x = (d-2)/2 at an odd-parity sign vector w (bit i of the mask set
//!    exactly when w_i = -1; k the rank of the mask among the masks of odd popcount), a
//!    (d-1)-simplex, normal w / sqrt d, offset (d-2) / (2 sqrt d). 2d + 2^(d-1) cells. A demicube
//!    facet x_i = a/2 is adjacent to the other demicube facets x_j = b/2 (j != i) and to the
//!    simplex facets with w_i = a; a simplex facet to its d demicube facets.
//!
//! Ridges are the (d-2)-faces shared by two adjacent cells; the singular set of the boundary is the
//! (d-3)-faces, the hinges. A hinge of a cell is the intersection of two of its ridges that is
//! (d-3)-dimensional (`hinges`: pairs of indices into `nbr`).
//!
//! Local coordinates of a cell: u in R^n (n = d - 1) at edge s means x = s o_c + sum_k u_k f_k,
//! o_c the cell's centre (the centroid of its vertices) and f_0..f_(n-1) the cell's frame:
//! Gram-Schmidt (run twice) on the projections of e_0, e_1, ... onto the cell's tangent space,
//! skipping a vector whose residual is under 1e-9, until n are found. For the demicube's x_i = a/2
//! cells this is the other coordinates in increasing order.
//!
//! Everything is built lazily per cell (the 10-orthoplex has 1,024 cells and the 10-demicube 532).

use super::names::{nd_cell_count, nd_parse, NdFamily, ND_NAMES};
use polypack_js::math;
use std::sync::OnceLock;

/// The edge of the base polytopes before scaling to unit edge.
/// packages/boundary/src/nd/container.ts: E0
pub const E0: f64 = math::SQRT2;

/// packages/boundary/src/nd/container.ts: NDCell
#[derive(Clone, Debug)]
pub struct NdCell {
    pub c: usize,
    /// 0: simplex or orthoplex cell; 1: a demicube's (d-1)-demicube facet; 2: a demicube's simplex facet.
    pub kind: u8,
    /// Unit outward normal, and offset at unit edge (n . x = h on the cell, <= h in the polytope).
    pub n: Vec<f64>,
    pub h: f64,
    /// Neighbouring cells, their unit normals (flat, k * D), offsets, and a point of each ridge at unit edge (flat).
    pub nbr: Vec<usize>,
    pub nn: Vec<f64>,
    pub hn: Vec<f64>,
    pub rp: Vec<f64>,
    /// |nu_k|^2 = 1 - (n_k . n)^2, the squared length of the tangential part of neighbour k's normal.
    pub nu2: Vec<f64>,
    /// The cell's centre at unit edge, and its frame (n orthonormal vectors of R^D).
    pub o: Vec<f64>,
    pub frame: Vec<Vec<f64>>,
    /// Pairs (k, l) of indices into nbr whose ridges meet in a hinge, flat.
    pub hinges: Vec<usize>,
}

fn popcount(x: usize) -> u32 {
    x.count_ones()
}

/// The simplex lies in the hyperplane flat.v . x = flat.b (at unit edge).
#[derive(Clone, Debug)]
pub struct Flat {
    pub v: Vec<f64>,
    pub b: f64,
}

/// packages/boundary/src/nd/container.ts: NDContainer
pub struct NdContainer {
    pub name: String,
    pub family: NdFamily,
    pub d: usize,
    pub n: usize,
    /// Dimension of the ambient space the coordinates live in (d + 1 for the simplex, d otherwise).
    pub dd: usize,
    /// The number of cells (the source's C).
    pub c: usize,
    /// The simplex lies in the hyperplane flat.v . x = flat.b (at unit edge); None for the others.
    pub flat: Option<Flat>,
    cells: Vec<OnceLock<NdCell>>,
    odd_masks: Vec<usize>,
    sd: f64,
}

struct Normal {
    n: Vec<f64>,
    h: f64,
    kind: u8,
}

impl NdContainer {
    /// packages/boundary/src/nd/container.ts: NDContainer constructor
    pub fn new(name: &str) -> Result<NdContainer, String> {
        let (family, d) = nd_parse(name).ok_or_else(|| format!("NDContainer: unknown container {name}"))?;
        let dd = if family == NdFamily::Simplex { d + 1 } else { d };
        let c = nd_cell_count(family, d);
        let flat = if family == NdFamily::Simplex {
            let v = vec![1.0 / (dd as f64).sqrt(); dd];
            Some(Flat { v, b: 1.0 / ((dd as f64).sqrt() * E0) })
        } else {
            None
        };
        let mut odd: Vec<usize> = Vec::new();
        for m in 0..(1usize << d) {
            if popcount(m) % 2 == 1 {
                odd.push(m);
            }
        }
        Ok(NdContainer { name: name.to_string(), family, d, n: d - 1, dd, c, flat, cells: (0..c).map(|_| OnceLock::new()).collect(), odd_masks: odd, sd: (d as f64).sqrt() })
    }

    /// The cell c, built on first use. An index out of range panics, where the source throws
    /// "cell c is out of range" (the validator checks a configuration's cells before it asks).
    /// packages/boundary/src/nd/container.ts: NDContainer.cell
    pub fn cell(&self, c: usize) -> &NdCell {
        assert!(c < self.c, "cell {c} is out of range");
        self.cells[c].get_or_init(|| self.build(c))
    }

    /// The sign vector w of a demicube simplex cell (id >= 2d), as +-1 entries.
    fn signs(&self, mask: usize) -> Vec<f64> {
        (0..self.d).map(|i| if (mask >> i) & 1 == 1 { -1.0 } else { 1.0 }).collect()
    }

    /// Unit normal and unit-edge offset of cell c, and its kind.
    fn normal_of(&self, c: usize) -> Normal {
        let (d, dd, sd) = (self.d, self.dd, self.sd);
        let mut n = vec![0.0; dd];
        if self.family == NdFamily::Simplex {
            let k = ((d * (d + 1)) as f64).sqrt();
            for x in n.iter_mut() {
                *x = 1.0 / k;
            }
            n[c] = (1.0 - (d + 1) as f64) / k;
            return Normal { n, h: 1.0 / k / E0, kind: 0 };
        }
        if self.family == NdFamily::Orthoplex {
            for i in 0..d {
                n[i] = (if (c >> i) & 1 == 1 { -1.0 } else { 1.0 }) / sd;
            }
            return Normal { n, h: 1.0 / sd / E0, kind: 0 };
        }
        if c < 2 * d {
            n[c >> 1] = if c & 1 == 1 { 1.0 } else { -1.0 };
            return Normal { n, h: 0.5 / E0, kind: 1 };
        }
        let w = self.signs(self.odd_masks[c - 2 * d]);
        for i in 0..d {
            n[i] = w[i] / sd;
        }
        Normal { n, h: (d as f64 - 2.0) / (2.0 * sd) / E0, kind: 2 }
    }

    fn neighbours(&self, c: usize) -> Vec<usize> {
        let d = self.d;
        let mut out: Vec<usize> = Vec::new();
        match self.family {
            NdFamily::Simplex => {
                for g in 0..=d {
                    if g != c {
                        out.push(g);
                    }
                }
            }
            NdFamily::Orthoplex => {
                for k in 0..d {
                    out.push(c ^ (1 << k));
                }
            }
            NdFamily::Demicube => {
                if c < 2 * d {
                    let i = c >> 1;
                    let neg = c & 1 == 0;
                    for j in 0..d {
                        if j != i {
                            out.push(2 * j);
                            out.push(2 * j + 1);
                        }
                    }
                    for (k, &m) in self.odd_masks.iter().enumerate() {
                        if ((m >> i) & 1) == (if neg { 1 } else { 0 }) {
                            out.push(2 * d + k);
                        }
                    }
                } else {
                    let m = self.odd_masks[c - 2 * d];
                    for i in 0..d {
                        out.push(2 * i + if (m >> i) & 1 == 1 { 0 } else { 1 });
                    }
                }
            }
        }
        out
    }

    /// A point of the ridge between adjacent cells c and g, at unit edge (the centroid of the ridge's vertices).
    /// packages/boundary/src/nd/container.ts: NDContainer.ridgePoint
    pub fn ridge_point(&self, c: usize, g: usize) -> Vec<f64> {
        let (d, dd) = (self.d, self.dd);
        let mut x = vec![0.0; dd];
        match self.family {
            NdFamily::Simplex => {
                for v in x.iter_mut() {
                    *v = 1.0 / (d as f64 - 1.0);
                }
                x[c] = 0.0;
                x[g] = 0.0;
            }
            NdFamily::Orthoplex => {
                let k = math::log2((c ^ g) as f64);
                for i in 0..d {
                    x[i] = if i as f64 == k { 0.0 } else { (if (c >> i) & 1 == 1 { -1.0 } else { 1.0 }) / (d as f64 - 1.0) };
                }
            }
            NdFamily::Demicube => {
                if c < 2 * d && g < 2 * d {
                    x[c >> 1] = if c & 1 == 1 { 0.5 } else { -0.5 };
                    x[g >> 1] = if g & 1 == 1 { 0.5 } else { -0.5 };
                } else {
                    // a demicube facet x_i = +-1/2 and a simplex facet w: the centroid of the simplex's vertices off coordinate i
                    let dem = if c < 2 * d { c } else { g };
                    let sim = if c < 2 * d { g } else { c };
                    let i = dem >> 1;
                    let w = self.signs(self.odd_masks[sim - 2 * d]);
                    for k in 0..d {
                        x[k] = w[k] / 2.0 - (if k == i { 0.0 } else { w[k] / (d as f64 - 1.0) });
                    }
                }
            }
        }
        for v in x.iter_mut() {
            *v /= E0;
        }
        x
    }

    fn centre(&self, c: usize) -> Vec<f64> {
        let (d, dd) = (self.d, self.dd);
        let mut o = vec![0.0; dd];
        match self.family {
            NdFamily::Simplex => {
                for v in o.iter_mut() {
                    *v = 1.0 / d as f64;
                }
                o[c] = 0.0;
            }
            NdFamily::Orthoplex => {
                for i in 0..d {
                    o[i] = (if (c >> i) & 1 == 1 { -1.0 } else { 1.0 }) / d as f64;
                }
            }
            NdFamily::Demicube => {
                if c < 2 * d {
                    o[c >> 1] = if c & 1 == 1 { 0.5 } else { -0.5 };
                } else {
                    let w = self.signs(self.odd_masks[c - 2 * d]);
                    for i in 0..d {
                        o[i] = (w[i] * (d as f64 - 2.0)) / (2.0 * d as f64);
                    }
                }
            }
        }
        for v in o.iter_mut() {
            *v /= E0;
        }
        o
    }

    /// packages/boundary/src/nd/container.ts: NDContainer.build
    fn build(&self, c: usize) -> NdCell {
        let (dd, nn_, d) = (self.dd, self.n, self.d);
        let Normal { n, h, kind } = self.normal_of(c);
        let nb = self.neighbours(c);
        let f = nb.len();
        let mut nn = vec![0.0; f * dd];
        let mut hn = vec![0.0; f];
        let mut rp = vec![0.0; f * dd];
        let mut nu2 = vec![0.0; f];
        for k in 0..f {
            let g = self.normal_of(nb[k]);
            nn[k * dd..k * dd + dd].copy_from_slice(&g.n);
            hn[k] = g.h;
            rp[k * dd..k * dd + dd].copy_from_slice(&self.ridge_point(c, nb[k]));
            let mut dot = 0.0;
            for j in 0..dd {
                dot += g.n[j] * n[j];
            }
            nu2[k] = 1.0 - dot * dot;
        }
        // hinge pairs
        let mut pairs: Vec<usize> = Vec::new();
        if kind == 1 {
            // demicube facet: (dem j, dem j') with j != j' for d >= 6; (dem j, simplex w) with w_j = the sign of the demicube facet
            let n_dem = 2 * (d - 1);
            for k in 0..n_dem {
                for l in k + 1..n_dem {
                    if d >= 6 && nb[k] >> 1 != nb[l] >> 1 {
                        pairs.push(k);
                        pairs.push(l);
                    }
                }
                for l in n_dem..f {
                    let m = self.odd_masks[nb[l] - 2 * d];
                    let j = nb[k] >> 1;
                    let wj = if (m >> j) & 1 == 1 { -1 } else { 1 };
                    if (if nb[k] & 1 == 1 { 1 } else { -1 }) == wj {
                        pairs.push(k);
                        pairs.push(l);
                    }
                }
            }
        } else {
            for k in 0..f {
                for l in k + 1..f {
                    pairs.push(k);
                    pairs.push(l);
                }
            }
        }
        // frame
        let mut cons: Vec<&[f64]> = vec![&n];
        if let Some(flat) = &self.flat {
            cons.push(&flat.v);
        }
        let mut frame: Vec<Vec<f64>> = Vec::new();
        fn proj(v: &mut [f64], b: &[f64]) {
            let mut dt = 0.0;
            for j in 0..v.len() {
                dt += b[j] * v[j];
            }
            for j in 0..v.len() {
                v[j] -= dt * b[j];
            }
        }
        let mut k = 0;
        while k < dd && frame.len() < nn_ {
            let mut v = vec![0.0; dd];
            v[k] = 1.0;
            k += 1;
            for _pass in 0..2 {
                for b in &cons {
                    proj(&mut v, b);
                }
                for b in &frame {
                    proj(&mut v, b);
                }
            }
            let mut nm = 0.0;
            for j in 0..dd {
                nm += v[j] * v[j];
            }
            nm = nm.sqrt();
            if nm < 1e-9 {
                continue;
            }
            for x in v.iter_mut() {
                *x /= nm;
            }
            frame.push(v);
        }
        // (the source throws here when the frame has fewer than n vectors; it cannot for these containers)
        assert!(frame.len() == nn_, "frame of cell {c} of the {} has {} vectors", self.name, frame.len());
        let o = self.centre(c);
        NdCell { c, kind, n, h, nbr: nb, nn, hn, rp, nu2, o, frame, hinges: pairs }
    }

    /// The ambient point of local coordinates u (n numbers, at edge s) of cell c.
    /// packages/boundary/src/nd/container.ts: NDContainer.toAmbient
    pub fn to_ambient(&self, c: usize, u: &[f64], s: f64) -> Vec<f64> {
        let cl = self.cell(c);
        let (dd, n) = (self.dd, self.n);
        let mut out = vec![0.0; dd];
        for j in 0..dd {
            out[j] = s * cl.o[j];
        }
        for k in 0..n {
            let uk = u[k];
            let f = &cl.frame[k];
            for j in 0..dd {
                out[j] += uk * f[j];
            }
        }
        out
    }
}

/// The container of a name (built once). packages/boundary/src/nd/container.ts: getND
pub fn get_nd(name: &str) -> Option<&'static NdContainer> {
    static REGISTRY: [OnceLock<NdContainer>; 18] = [const { OnceLock::new() }; 18];
    let i = ND_NAMES.iter().position(|&n| n == name)?;
    Some(REGISTRY[i].get_or_init(|| NdContainer::new(name).expect("a name of ND_NAMES")))
}
