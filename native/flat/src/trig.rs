//! Port of packages/geometry/src/trig.ts: the memo of the per-orientation trigonometry of a
//! regular N-gon piece.
//!
//! Invariant (as in the source): an entry holds only pure functions of (N, theta), the SAT
//! edge-normal angles with their cos and sin. It never depends on x, y, the container or the other
//! piece. Every lookup compares (N, theta) with the entry it finds (`Object.is`: -0 is not +0, NaN
//! is NaN), so a stale entry is a miss and is refilled. The expressions are the ones the kernels
//! would use inline (same operand order), so every value is bit-equal to computing it in place: the
//! memo changes the cost of a kernel and never its result.
//!
//! The source keeps one table per JavaScript realm; here each thread has its own
//! ([`with_memo`]), since the Rust server checks submissions on worker threads. An entry is named
//! by its slot index instead of an object reference; as in the source, a caller that holds one
//! entry passes it as `keep` when it fetches a second, so the second lookup cannot overwrite it.
//!
//! Not ported: `vertexCos` and `lastVertexSin` (the vertex directions), which only the penalty
//! kernels of the TypeScript search use; the server bundle does not keep them.

use crate::math;
use std::cell::RefCell;
use std::f64::consts::PI;

/// trig.ts: PieceTrig. `axes` holds [angle, cos, sin] per edge normal; valid when `axes_ready`, or
/// per edge once its cos and sin are not NaN (see [`TrigMemo::axis_of`]).
#[derive(Clone, Debug)]
pub struct PieceTrig {
    pub n: u32,
    pub theta: f64,
    pub axes: Vec<f64>,
    pub axes_ready: bool,
}

/// trig.ts: SLOTS.
const SLOTS: usize = 2048;

/// trig.ts: the module's `slots` table.
#[derive(Debug)]
pub struct TrigMemo {
    slots: Vec<Option<PieceTrig>>,
}

impl Default for TrigMemo {
    fn default() -> Self {
        Self::new()
    }
}

/// `Object.is(a, b)` for numbers.
#[inline]
fn object_is(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}

impl TrigMemo {
    pub fn new() -> Self {
        let mut slots = Vec::new();
        slots.resize_with(SLOTS, || None);
        TrigMemo { slots }
    }

    #[inline]
    fn hit(&self, idx: usize, n: u32, theta: f64) -> bool {
        match &self.slots[idx] {
            Some(e) => e.n == n && object_is(e.theta, theta),
            None => false,
        }
    }

    /// trig.ts: pieceTrig. The slot of the entry for (N, theta), reusing a slot (never `keep`'s)
    /// on a miss.
    pub fn piece_trig(&mut self, n: u32, theta: f64, keep: Option<usize>) -> usize {
        let bits = theta.to_bits();
        let lo = bits as u32;
        let hi = (bits >> 32) as u32;
        // N is mixed in before the multiply, so it reaches the top bits the shift keeps
        let mut idx =
            ((lo ^ hi.wrapping_mul(0x9e37_79b1) ^ n.wrapping_mul(0x27d4_eb2f)).wrapping_mul(0x85eb_ca6b) >> 21) as usize; // 11 bits
        if self.hit(idx, n, theta) {
            return idx;
        }
        if keep == Some(idx) && self.slots[idx].is_some() {
            idx = (idx + 1) & (SLOTS - 1);
            if self.hit(idx, n, theta) {
                return idx;
            }
        }
        let len = 3 * n as usize;
        match &mut self.slots[idx] {
            // arrays at least as long as N needs are reused (trig.ts: fill)
            Some(e) if e.axes.len() >= len => {
                e.n = n;
                e.theta = theta;
                e.axes_ready = false;
                e.axes[..len].fill(f64::NAN);
            }
            // trig.ts: make
            slot => *slot = Some(PieceTrig { n, theta, axes: vec![f64::NAN; len], axes_ready: false }),
        }
        idx
    }

    #[inline]
    fn entry(&mut self, e: usize) -> &mut PieceTrig {
        self.slots[e].as_mut().expect("a slot returned by piece_trig")
    }

    /// trig.ts: axesOf. Fills the SAT axes of an entry: the expressions of
    /// regularPolygonSeparation and penaltyEdgeNormals.
    pub fn axes_of(&mut self, e: usize) -> &[f64] {
        let entry = self.entry(e);
        if !entry.axes_ready {
            let n = entry.n;
            let nf = n as f64;
            let step = (2.0 * PI) / nf;
            for k in 0..n as usize {
                let angle = entry.theta + PI / 2.0 + PI / nf + k as f64 * step;
                entry.axes[3 * k] = angle;
                entry.axes[3 * k + 1] = math::cos(angle);
                entry.axes[3 * k + 2] = math::sin(angle);
            }
            entry.axes_ready = true;
        }
        &entry.axes
    }

    /// trig.ts: axisOf. Edge normal `k` of an entry on demand (for kernels that visit few axes):
    /// fills [angle, cos, sin] if not yet there.
    pub fn axis_of(&mut self, e: usize, k: usize) -> &[f64] {
        let entry = self.entry(e);
        let (c, s) = (entry.axes[3 * k + 1], entry.axes[3 * k + 2]);
        // the source tests `c !== c || s !== s`: not yet computed (or computed as NaN, and then again)
        if !entry.axes_ready && (c.is_nan() || s.is_nan()) {
            let nf = entry.n as f64;
            let step = (2.0 * PI) / nf;
            let angle = entry.theta + PI / 2.0 + PI / nf + k as f64 * step;
            entry.axes[3 * k] = angle;
            entry.axes[3 * k + 1] = math::cos(angle);
            entry.axes[3 * k + 2] = math::sin(angle);
        }
        &entry.axes
    }

    /// The axes of an entry as they are (after [`TrigMemo::axes_of`] filled them).
    #[inline]
    pub fn axes(&self, e: usize) -> &[f64] {
        &self.slots[e].as_ref().expect("a slot returned by piece_trig").axes
    }
}

thread_local! {
    static MEMO: RefCell<TrigMemo> = RefCell::new(TrigMemo::new());
}

/// Runs `f` with this thread's memo. The kernels run no callbacks, so a second use cannot start
/// while one holds it.
pub fn with_memo<T>(f: impl FnOnce(&mut TrigMemo) -> T) -> T {
    MEMO.with(|m| f(&mut m.borrow_mut()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_are_pure_and_keep_protects_the_first() {
        let mut memo = TrigMemo::new();
        for n in [3u32, 4, 7, 12, 100] {
            for i in 0..3000 {
                let ta = (i as f64) * 0.37 - 500.0;
                let tb = (i as f64) * -0.11 + 3.0;
                let a = memo.piece_trig(n, ta, None);
                let b = memo.piece_trig(n, tb, Some(a));
                assert_ne!(a, b);
                memo.axes_of(a);
                memo.axis_of(b, (i % n) as usize);
                let nf = n as f64;
                let step = (2.0 * PI) / nf;
                for k in 0..n as usize {
                    let angle = ta + PI / 2.0 + PI / nf + k as f64 * step;
                    assert_eq!(memo.axes(a)[3 * k].to_bits(), angle.to_bits());
                    assert_eq!(memo.axes(a)[3 * k + 1].to_bits(), math::cos(angle).to_bits());
                    assert_eq!(memo.axes(a)[3 * k + 2].to_bits(), math::sin(angle).to_bits());
                }
                let k = (i % n) as usize;
                let angle = tb + PI / 2.0 + PI / nf + k as f64 * step;
                assert_eq!(memo.axes(b)[3 * k + 1].to_bits(), math::cos(angle).to_bits());
            }
        }
        // the same orientation is the same entry, and -0 is not +0
        let a = memo.piece_trig(5, 0.25, None);
        assert_eq!(memo.piece_trig(5, 0.25, Some(a)), a);
        let z = memo.piece_trig(5, 0.0, None);
        memo.axes_of(z);
        let neg = memo.piece_trig(5, -0.0, Some(z));
        assert!(neg != z || !memo.slots[neg].as_ref().unwrap().axes_ready);
    }
}
