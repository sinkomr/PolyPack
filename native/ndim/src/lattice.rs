//! Lattice points for the structured starts of the nD kernel (packages/ndspace/src/lattice.ts): the
//! P points of a lattice nearest to a centre. The lattices are Z^d (the k^d grids), D_d (integer
//! points with an even coordinate sum: the densest known ball packing lattice in 3 to 5
//! dimensions) and E8 (D8 together with the half-integer points of even sum, in 8 dimensions), at
//! unit scale (spacing 1 in the integer coordinates).

use polypack_js::math;
use polypack_methods::random::Mulberry32;

/// lattice.ts: LatticeName.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LatticeName {
    Zd,
    Dd,
    E8,
}

/// lattice.ts: MAX_CANDIDATES. Largest number of candidate points a search keeps before it takes
/// the nearest P of them (bounds the work).
const MAX_CANDIDATES: usize = 20000;

struct Cand {
    p: Vec<f64>,
    r2: f64,
    tie: f64,
}

struct Search<'a> {
    name: LatticeName,
    d: usize,
    centre: &'a [f64],
    shift: f64,
    r2_cap: f64,
    p: Vec<f64>,
    cands: Vec<Cand>,
    overflow: bool,
    rng: &'a mut Mulberry32,
}

fn sum_of(p: &[f64], d: usize) -> f64 {
    let mut s = 0.0f64;
    for i in 0..d {
        s += p[i];
    }
    s
}

impl Search<'_> {
    fn rec(&mut self, k: usize, r2: f64, parity: f64) {
        if self.overflow {
            return;
        }
        let d = self.d;
        if k == d {
            // D_d: even sum of integer coordinates; E8's half-integer coset: even sum of x - 1/2
            // shifted... the coset (Z + 1/2)^8 with an even sum of the coordinates
            let ok = self.name == LatticeName::Zd
                || (if self.shift == 0.0 { parity % 2.0 == 0.0 } else { math::round(sum_of(&self.p, d)) % 2.0 == 0.0 });
            if ok {
                if self.cands.len() >= MAX_CANDIDATES {
                    self.overflow = true;
                } else {
                    let tie = self.rng.next();
                    self.cands.push(Cand { p: self.p.clone(), r2, tie });
                }
            }
            return;
        }
        let c = self.centre[k];
        let room = math::sqrt(math::max(0.0, self.r2_cap - r2));
        let mut v = math::ceil(c - room - self.shift) + self.shift;
        while v <= c + room + 1e-12 {
            let e = v - c;
            let r2n = r2 + e * e;
            if r2n > self.r2_cap + 1e-12 {
                v += 1.0;
                continue;
            }
            self.p[k] = v;
            let add = if self.shift == 0.0 { math::round(v) } else { 0.0 };
            self.rec(k + 1, r2n, parity + add);
            v += 1.0;
        }
    }
}

/// lattice.ts: latticePoints. The P lattice points nearest to `centre` (ties broken by rng), as a
/// flat array P x d, or None when the lattice does not have enough points near that centre within
/// the candidate cap. The points are in the lattice's own coordinates (the caller scales them).
pub fn lattice_points(name: LatticeName, d: usize, centre: &[f64], p: usize, rng: &mut Mulberry32) -> Option<Vec<f64>> {
    // E8 is D8 plus the half-integer points of even sum: two cosets, each searched as a shifted integer lattice
    let shifts: &[f64] = if name == LatticeName::E8 { &[0.0, 0.5] } else { &[0.0] };
    let mut r2_cap = 1.0f64;
    // grow the squared radius until enough candidates are found
    while r2_cap < (4 * d + 8) as f64 {
        let mut s = Search { name, d, centre, shift: 0.0, r2_cap, p: vec![0.0; d], cands: Vec::new(), overflow: false, rng: &mut *rng };
        for &shift in shifts {
            s.shift = shift;
            s.p = vec![0.0; d];
            s.rec(0, 0.0, 0.0);
        }
        let overflow = s.overflow;
        let mut cands = std::mem::take(&mut s.cands);
        if overflow {
            break;
        }
        if cands.len() >= p {
            // a stable sort by (r2, tie): `a.r2 - b.r2 || a.tie - b.tie`
            cands.sort_by(|a, b| {
                let c = a.r2 - b.r2;
                if c < 0.0 {
                    return std::cmp::Ordering::Less;
                }
                if c > 0.0 {
                    return std::cmp::Ordering::Greater;
                }
                let t = a.tie - b.tie;
                if t < 0.0 {
                    std::cmp::Ordering::Less
                } else if t > 0.0 {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Equal
                }
            });
            let mut out = vec![0.0f64; p * d];
            for i in 0..p {
                out[i * d..(i + 1) * d].copy_from_slice(&cands[i].p);
            }
            return Some(out);
        }
        r2_cap *= 1.5;
    }
    // too many candidates before P were found within a radius, or the radius cap was reached: no start of this kind
    None
}
