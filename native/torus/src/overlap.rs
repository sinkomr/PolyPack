//! `regularPolygonOverlap` of packages/geometry/src/overlap.ts, with the memo of
//! packages/geometry/src/trig.ts that its hot loops rely on. The search (`search`) calls it for
//! every image pair of every energy, so the edge normals of a piece are kept by (N, theta).

use crate::geometry::{axes_of, circumradius, cos_to_nearest_vertex, inradius};
use polypack_js::math;
use std::cell::RefCell;

type Entry = Option<(usize, u64, Vec<f64>)>;

/// What `regular_polygon_overlap` memoizes: the edge normals of an N-gon at one angle (trig.ts:
/// `pieceTrig`, `axesOf`; an entry is a pure function of (N, theta), so a hit and a fresh
/// computation give the same numbers), and the circumradius and inradius of the last N seen
/// (overlap.ts: `memoN`, `memoR`, `memoInr`).
struct TrigCache {
    slots: Vec<Entry>,
    memo_n: usize,
    memo_r: f64,
    memo_inr: f64,
}

const SLOTS: usize = 2048;

thread_local! {
    static TRIG: RefCell<TrigCache> = RefCell::new(TrigCache {
        slots: vec![None; SLOTS],
        memo_n: usize::MAX,
        memo_r: f64::NAN,
        memo_inr: f64::NAN,
    });
}

impl TrigCache {
    /// trig.ts: `pieceTrig` and `axesOf`: the slot of (n, theta), filled, and never `keep`'s.
    fn slot(&mut self, n: usize, theta: f64, keep: Option<usize>) -> usize {
        let bits = theta.to_bits();
        let h = ((bits as u32) ^ ((bits >> 32) as u32).wrapping_mul(0x9e3779b1) ^ (n as u32).wrapping_mul(0x27d4eb2f))
            .wrapping_mul(0x85ebca6b)
            >> 21;
        let mut idx = h as usize;
        let hit = |s: &Entry| matches!(s, Some((m, b, _)) if *m == n && *b == bits);
        if hit(&self.slots[idx]) {
            return idx;
        }
        if keep == Some(idx) {
            idx = (idx + 1) & (SLOTS - 1);
            if hit(&self.slots[idx]) {
                return idx;
            }
        }
        self.slots[idx] = Some((n, bits, axes_of(n, theta)));
        idx
    }
}

/// overlap.ts: `regularPolygonOverlap`. `regular_polygon_separation(n, a, b, scale).sep` when it
/// is negative (the pieces overlap), the same double; otherwise a candidate gap of at least
/// `enough` (>= 0), as soon as one is found, or the maximum when none is (for penalty energies,
/// which ignore separated pairs). The candidates are those of `regular_polygon_separation`,
/// visited in its order, so a result below `enough` is its maximum bit for bit.
#[allow(clippy::too_many_arguments)]
pub fn regular_polygon_overlap(
    n: usize,
    ax: f64,
    ay: f64,
    at: f64,
    bx: f64,
    by: f64,
    bt: f64,
    scale: f64,
    enough: f64,
) -> f64 {
    TRIG.with(|c| {
        let mut c = c.borrow_mut();
        if n != c.memo_n {
            c.memo_n = n;
            c.memo_r = circumradius(n as f64);
            c.memo_inr = inradius(n as f64);
        }
        let big_r = c.memo_r * scale;
        let r = c.memo_inr * scale;
        let step = (2.0 * math::PI) / n as f64;
        let dx = bx - ax;
        let dy = by - ay;
        let mut best = f64::NEG_INFINITY;
        let ia = c.slot(n, at, None);
        let ib = c.slot(n, bt, Some(ia));
        let ax_a = &c.slots[ia].as_ref().unwrap().2;
        let ax_b = &c.slots[ib].as_ref().unwrap().2;
        for k in 0..n {
            let mut sep = dx * ax_a[3 * k + 1] + dy * ax_a[3 * k + 2]
                - r
                - big_r * cos_to_nearest_vertex(ax_a[3 * k] + math::PI / 2.0 - bt, step);
            if sep > best {
                best = sep;
                if best >= enough {
                    return best;
                }
            }
            sep = -(dx * ax_b[3 * k + 1] + dy * ax_b[3 * k + 2])
                - r
                - big_r * cos_to_nearest_vertex(ax_b[3 * k] + math::PI / 2.0 - at, step);
            if sep > best {
                best = sep;
                if best >= enough {
                    return best;
                }
            }
        }
        best
    })
}
