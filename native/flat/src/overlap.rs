//! Port of packages/geometry/src/overlap.ts: the signed separation of two congruent pieces and
//! the search for overlapping pairs, operation for operation, so that the Rust server decides, and
//! words its refusals, as the TypeScript server does.
//!
//! sep > 0: the pieces are disjoint (for polygons a lower bound on their distance, exact for face
//! contact); sep < 0: they overlap and -sep is the exact penetration depth. (nx, ny) is the unit
//! direction in which moving piece A increases sep fastest.
//!
//! Each kernel has two forms: the one named after the source, which uses the thread's
//! trigonometry memo ([`crate::trig::with_memo`]), and a `_in` form that takes the memo, for a
//! caller that already holds it ([`find_overlaps`] does, for the whole scan).

use crate::math;
use crate::shapes::{bounding_radius, circumradius, inradius, Pose, DISK_RADIUS};
use crate::trig::{with_memo, TrigMemo};
use std::cell::RefCell;
use std::f64::consts::PI;

/// overlap.ts: TOL. Tolerance in piece units (side length 1, disk diameter 1).
/// Rule for "touching": two pieces overlap only when their separation is below -TOL.
/// A separation in [-TOL, TOL] is contact and is valid.
pub const TOL: f64 = 1e-9;

/// overlap.ts: Contact.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Contact {
    pub sep: f64,
    pub nx: f64,
    pub ny: f64,
}

/// overlap.ts: polygonSeparation. Separating-axis test for two convex polygons given as flat
/// counter-clockwise vertex arrays. Reference implementation, O(|a| * |b|).
pub fn polygon_separation(a: &[f64], b: &[f64]) -> Contact {
    let mut best = f64::NEG_INFINITY;
    let mut nx = 1.0;
    let mut ny = 0.0;
    for pass in 0..2 {
        // pass 0 uses the edge normals of A, pass 1 those of B
        let (p, q) = if pass == 0 { (a, b) } else { (b, a) };
        let np = p.len() / 2;
        let nq = q.len() / 2;
        for i in 0..np {
            let j = (i + 1) % np;
            let px = p[2 * i];
            let py = p[2 * i + 1];
            let ex = p[2 * j] - px;
            let ey = p[2 * j + 1] - py;
            let len = math::hypot(ex, ey);
            // outward normal of a counter-clockwise edge
            let ux = ey / len;
            let uy = -ex / len;
            let mut m = f64::INFINITY;
            for k in 0..nq {
                let d = (q[2 * k] - px) * ux + (q[2 * k + 1] - py) * uy;
                if d < m {
                    m = d;
                }
            }
            if m > best {
                best = m;
                // A's normal points from A toward B, so A retreats along -u; B's normal pushes A along +u
                let s = if pass == 0 { -1.0 } else { 1.0 };
                nx = s * ux;
                ny = s * uy;
            }
        }
    }
    Contact { sep: best, nx, ny }
}

/// overlap.ts: cosToNearestVertex. cos of the angular distance from `rel` to the nearest multiple
/// of `step`.
#[inline]
fn cos_to_nearest_vertex(rel: f64, step: f64) -> f64 {
    let mut t = rel % step;
    if t < 0.0 {
        t += step;
    }
    if t > step / 2.0 {
        t = step - t;
    }
    math::cos(t)
}

/// overlap.ts: regularPolygonSeparation. Separating-axis test for two congruent regular N-gon
/// pieces, O(N).
///
/// Along an edge normal u of A, A reaches exactly its inradius. B reaches R cos(delta) toward A,
/// where delta is the angle between -u and B's nearest vertex direction (the support function of a
/// regular polygon). So the gap along u is
///   (cB - cA) . u - inradius - R cos(delta).
///
/// The axes are visited A0, B0, A1, B1, ... and the first largest gap wins. Since
/// r <= R cos(delta) <= R, each gap lies in [lin - r - R, lin - 2r], lin = (cB - cA) . u (with the
/// sign of the piece the axis belongs to). So an axis whose lin is below the largest lin by more
/// than R - r (plus a margin of 1e-11 (|dx| + |dy| + R), far above the rounding of either bound)
/// has a gap strictly below the largest gap, and its cosine is not needed: the axes that remain
/// hold every one attaining the maximum, visited in the same order with the same expressions, so
/// the result is the same double, normal included.
pub fn regular_polygon_separation(n: u32, a: &Pose, b: &Pose, scale: f64) -> Contact {
    with_memo(|memo| regular_polygon_separation_in(memo, n, a, b, scale))
}

/// [`regular_polygon_separation`] with the memo in hand.
pub fn regular_polygon_separation_in(memo: &mut TrigMemo, n: u32, a: &Pose, b: &Pose, scale: f64) -> Contact {
    let big_r = circumradius(n) * scale;
    let r = inradius(n) * scale;
    let step = (2.0 * PI) / n as f64;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut best = f64::NEG_INFINITY;
    let mut nx = 1.0;
    let mut ny = 0.0;
    // cached edge-normal angles, cos and sin of each piece (pure in (N, theta), see trig.rs)
    let ea = memo.piece_trig(n, a.theta, None);
    let eb = memo.piece_trig(n, b.theta, Some(ea));
    memo.axes_of(ea);
    memo.axes_of(eb);
    let ax_a = memo.axes(ea);
    let ax_b = memo.axes(eb);
    let count = n as usize;
    let mut top = f64::NEG_INFINITY;
    for k in 0..count {
        let lin_a = dx * ax_a[3 * k + 1] + dy * ax_a[3 * k + 2];
        let lin_b = -(dx * ax_b[3 * k + 1] + dy * ax_b[3 * k + 2]);
        if lin_a > top {
            top = lin_a;
        }
        if lin_b > top {
            top = lin_b;
        }
    }
    let mut threshold = top - (big_r - r) - 1e-11 * (dx.abs() + dy.abs() + big_r);
    // infinite or NaN inputs: every axis, as without the bound
    if !threshold.is_finite() {
        threshold = f64::NEG_INFINITY;
    }
    for k in 0..count {
        // edge normals bisect consecutive vertex directions
        let mut ux = ax_a[3 * k + 1];
        let mut uy = ax_a[3 * k + 2];
        let lin_a = dx * ux + dy * uy;
        if !(lin_a < threshold) {
            let sep = lin_a - r - big_r * cos_to_nearest_vertex(ax_a[3 * k] + PI / 2.0 - b.theta, step);
            if sep > best {
                best = sep;
                nx = -ux;
                ny = -uy;
            }
        }
        ux = ax_b[3 * k + 1];
        uy = ax_b[3 * k + 2];
        let lin_b = -(dx * ux + dy * uy);
        if !(lin_b < threshold) {
            let sep = lin_b - r - big_r * cos_to_nearest_vertex(ax_b[3 * k] + PI / 2.0 - a.theta, step);
            if sep > best {
                best = sep;
                nx = ux;
                ny = uy;
            }
        }
    }
    Contact { sep: best, nx, ny }
}

/// overlap.ts: regularPolygonOverlap. `regular_polygon_separation(n, a, b, scale).sep` when it is
/// negative (the pieces overlap), the same double; otherwise a candidate gap of at least `enough`
/// (>= 0), as soon as one is found, or the maximum when none is (for penalty energies, which
/// ignore separated pairs). The candidates are those of regularPolygonSeparation, visited in its
/// order, so a result below `enough` is its maximum bit for bit. (The source also memoises the
/// two radii of the last N; they are recomputed here, the same doubles.)
#[allow(clippy::too_many_arguments)]
pub fn regular_polygon_overlap(n: u32, ax: f64, ay: f64, at: f64, bx: f64, by: f64, bt: f64, scale: f64, enough: f64) -> f64 {
    with_memo(|memo| {
        let big_r = circumradius(n) * scale;
        let r = inradius(n) * scale;
        let step = (2.0 * PI) / n as f64;
        let dx = bx - ax;
        let dy = by - ay;
        let mut best = f64::NEG_INFINITY;
        let ea = memo.piece_trig(n, at, None);
        let eb = memo.piece_trig(n, bt, Some(ea));
        memo.axes_of(ea);
        memo.axes_of(eb);
        let ax_a = memo.axes(ea);
        let ax_b = memo.axes(eb);
        for k in 0..n as usize {
            let mut sep =
                dx * ax_a[3 * k + 1] + dy * ax_a[3 * k + 2] - r - big_r * cos_to_nearest_vertex(ax_a[3 * k] + PI / 2.0 - bt, step);
            if sep > best {
                best = sep;
                if best >= enough {
                    return best;
                }
            }
            sep = -(dx * ax_b[3 * k + 1] + dy * ax_b[3 * k + 2])
                - r
                - big_r * cos_to_nearest_vertex(ax_b[3 * k] + PI / 2.0 - at, step);
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

/// overlap.ts: PRUNE_FROM_N. Fewest sides for which pairSeparation prunes the axes: below, the
/// plain loop is as fast.
const PRUNE_FROM_N: u32 = 12;
/// overlap.ts: PRUNE_MAX_THETA. Largest |theta| for which the pruning's margin covers the rounding
/// of the axis angles (see [`pair_separation`]).
const PRUNE_MAX_THETA: f64 = 1000.0;

/// overlap.ts: pairSeparation. `regular_polygon_separation(n, a, b, scale).sep`, the same double
/// (up to the sign of a zero, which find_overlaps never reports), from far fewer axes for
/// many-sided pieces: about 2 instead of 2N for pieces near contact.
///
/// Why it is exact: each candidate gap is d.u - r - R cos(delta) with R cos(delta) >= r, so it is
/// at most |d| cos(alpha) - 2r, alpha being the angle between the axis and the line of centres. The
/// axes are visited outward from the one nearest that line, on both pieces; the axes s steps away
/// have alpha >= (s - 1/2) 2 pi / N. Once |d| cos((s - 1/2) 2 pi / N) - 2r is below the best gap
/// found by more than the margin, no axis left can reach it, and the maximum is the kernel's: the
/// same expressions, evaluated for a set of axes that holds every one attaining it. The margin,
/// 1e-11 (|d| + R), covers the rounding of the gaps (about 1e-15 (|d| + R)) and of the axis angles
/// (a few ulps of |theta| + 2 pi, below 4e-13 rad while |theta| <= PRUNE_MAX_THETA).
pub fn pair_separation(n: u32, a: &Pose, b: &Pose, scale: f64) -> f64 {
    if n == 0 {
        return circle_separation(a, b, scale).sep;
    }
    with_memo(|memo| pair_separation_in(memo, n, a, b, scale))
}

/// The index of axis `k` (any whole number as a double) in 0..N: `((k % N) + N) % N`. None when
/// `k` is not a number, where the source reads an undefined array element and its gap is NaN.
#[inline]
fn axis_index(k: f64, nf: f64) -> Option<usize> {
    let i = ((k % nf) + nf) % nf;
    if i.is_finite() {
        Some(i as usize)
    } else {
        None
    }
}

/// [`pair_separation`] with the memo in hand.
pub fn pair_separation_in(memo: &mut TrigMemo, n: u32, a: &Pose, b: &Pose, scale: f64) -> f64 {
    if n == 0 {
        return circle_separation(a, b, scale).sep;
    }
    if n < PRUNE_FROM_N || !(a.theta.abs() <= PRUNE_MAX_THETA && b.theta.abs() <= PRUNE_MAX_THETA) {
        return regular_polygon_separation_in(memo, n, a, b, scale).sep;
    }
    let big_r = circumradius(n) * scale;
    let r = inradius(n) * scale;
    let nf = n as f64;
    let step = (2.0 * PI) / nf;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    // the candidate gaps of the edge normals k of A and of B, exactly as regularPolygonSeparation has them
    // axes are filled on demand: the pruned search visits only a few of the N. Both entries are held
    // across the search, the second looked up so as not to evict the first.
    let ea = memo.piece_trig(n, a.theta, None);
    let eb = memo.piece_trig(n, b.theta, Some(ea));
    let (a_theta, b_theta) = (a.theta, b.theta);
    let gap_a = |memo: &mut TrigMemo, k: f64| -> f64 {
        let Some(k) = axis_index(k, nf) else { return f64::NAN };
        let ax_a = memo.axis_of(ea, k);
        let ang_a = ax_a[3 * k];
        dx * ax_a[3 * k + 1] + dy * ax_a[3 * k + 2] - r - big_r * cos_to_nearest_vertex(ang_a + PI / 2.0 - b_theta, step)
    };
    let gap_b = |memo: &mut TrigMemo, k: f64| -> f64 {
        let Some(k) = axis_index(k, nf) else { return f64::NAN };
        let ax_b = memo.axis_of(eb, k);
        let ang_b = ax_b[3 * k];
        -(dx * ax_b[3 * k + 1] + dy * ax_b[3 * k + 2]) - r - big_r * cos_to_nearest_vertex(ang_b + PI / 2.0 - a_theta, step)
    };
    // the normal of A nearest the direction from A to B, and of B nearest the direction from B to A
    let toward_b = math::atan2(dy, dx);
    let ka = math::round((toward_b - (a.theta + PI / 2.0 + PI / nf)) / step);
    let kb = math::round((toward_b + PI - (b.theta + PI / 2.0 + PI / nf)) / step);
    let first_a = gap_a(memo, ka);
    let first_b = gap_b(memo, kb);
    let mut best = math::max(first_a, first_b);
    let dist = math::hypot(dx, dy);
    let margin = 1e-11 * (dist + big_r);
    let mut s = 1.0;
    while s <= nf / 2.0 {
        if dist * math::cos((s - 0.5) * step) - 2.0 * r < best - margin {
            break;
        }
        let g1 = gap_a(memo, ka + s);
        let g2 = gap_a(memo, ka - s);
        let g3 = gap_b(memo, kb + s);
        let g4 = gap_b(memo, kb - s);
        best = math::max(math::max(math::max(math::max(best, g1), g2), g3), g4);
        s += 1.0;
    }
    best
}

/// overlap.ts: separationBelow. `pair_separation(n, a, b, scale) < threshold`, without the
/// separation itself. The separation is the largest of the SAT gaps (regularPolygonSeparation), so
/// it is below the threshold exactly when every gap is: the gaps are computed with the same
/// expressions and the test ends at the first one that reaches the threshold. A gap is at most
/// lin - 2r (lin as in regularPolygonSeparation), so an axis whose lin is below threshold + 2r by
/// more than the margin cannot reach it and needs no cosine. Many-sided pieces and non-finite
/// thresholds or offsets go through pairSeparation itself.
pub fn separation_below(n: u32, a: &Pose, b: &Pose, threshold: f64, scale: f64) -> bool {
    if n == 0 {
        return circle_separation(a, b, scale).sep < threshold;
    }
    with_memo(|memo| separation_below_in(memo, n, a, b, threshold, scale))
}

/// [`separation_below`] with the memo in hand.
pub fn separation_below_in(memo: &mut TrigMemo, n: u32, a: &Pose, b: &Pose, threshold: f64, scale: f64) -> bool {
    if n == 0 {
        return circle_separation(a, b, scale).sep < threshold;
    }
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let big_r = circumradius(n) * scale;
    let r = inradius(n) * scale;
    let need = threshold + 2.0 * r - 1e-11 * (dx.abs() + dy.abs() + big_r);
    if n >= PRUNE_FROM_N || !need.is_finite() || !threshold.is_finite() {
        return pair_separation_in(memo, n, a, b, scale) < threshold;
    }
    let step = (2.0 * PI) / n as f64;
    let ea = memo.piece_trig(n, a.theta, None);
    let eb = memo.piece_trig(n, b.theta, Some(ea));
    memo.axes_of(ea);
    memo.axes_of(eb);
    let ax_a = memo.axes(ea);
    let ax_b = memo.axes(eb);
    for k in 0..n as usize {
        let lin_a = dx * ax_a[3 * k + 1] + dy * ax_a[3 * k + 2];
        if lin_a >= need && lin_a - r - big_r * cos_to_nearest_vertex(ax_a[3 * k] + PI / 2.0 - b.theta, step) >= threshold {
            return false;
        }
        let lin_b = -(dx * ax_b[3 * k + 1] + dy * ax_b[3 * k + 2]);
        if lin_b >= need && lin_b - r - big_r * cos_to_nearest_vertex(ax_b[3 * k] + PI / 2.0 - a.theta, step) >= threshold {
            return false;
        }
    }
    true
}

/// overlap.ts: pieceSeparationBelow. `piece_separation(n, a, b, scale).sep < threshold`, for the
/// callers that compare pieceSeparation. It is separationBelow except for many-sided pieces with a
/// non-finite centre offset, where pairSeparation (NaN) and pieceSeparation (the largest gap that
/// is a number, -Infinity when none is) part ways: there the full kernel answers.
pub fn piece_separation_below(n: u32, a: &Pose, b: &Pose, threshold: f64, scale: f64) -> bool {
    if n >= PRUNE_FROM_N && !((b.x - a.x).is_finite() && (b.y - a.y).is_finite()) {
        return regular_polygon_separation(n, a, b, scale).sep < threshold;
    }
    separation_below(n, a, b, threshold, scale)
}

/// overlap.ts: circleSeparation. Circle-circle separation from the centre distance. Exact in both
/// signs.
pub fn circle_separation(a: &Pose, b: &Pose, scale: f64) -> Contact {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    let d = math::hypot(dx, dy);
    if d == 0.0 {
        return Contact { sep: -2.0 * DISK_RADIUS * scale, nx: 1.0, ny: 0.0 };
    }
    Contact { sep: d - 2.0 * DISK_RADIUS * scale, nx: dx / d, ny: dy / d }
}

/// overlap.ts: pieceSeparation. Separation between two congruent pieces (N = 0 for circles).
pub fn piece_separation(n: u32, a: &Pose, b: &Pose, scale: f64) -> Contact {
    if n == 0 {
        circle_separation(a, b, scale)
    } else {
        regular_polygon_separation(n, a, b, scale)
    }
}

/// overlap.ts: polygonCircleSeparation. Separation between a convex polygon (flat
/// counter-clockwise vertices) and a circle, by the closest point of the polygon to the circle
/// centre. Exact in both signs. The normal is the direction in which moving the circle increases
/// the separation.
pub fn polygon_circle_separation(poly: &[f64], cx: f64, cy: f64, r: f64) -> Contact {
    let n = poly.len() / 2;
    let mut inside = f64::NEG_INFINITY;
    let mut inx = 1.0;
    let mut iny = 0.0;
    let mut best_d2 = f64::INFINITY;
    let mut qx = 0.0;
    let mut qy = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        let px = poly[2 * i];
        let py = poly[2 * i + 1];
        let ex = poly[2 * j] - px;
        let ey = poly[2 * j + 1] - py;
        let len2 = ex * ex + ey * ey;
        let len = len2.sqrt();
        let ux = ey / len;
        let uy = -ex / len;
        let signed = (cx - px) * ux + (cy - py) * uy;
        if signed > inside {
            inside = signed;
            inx = ux;
            iny = uy;
        }
        // closest point on this edge segment
        let mut t = ((cx - px) * ex + (cy - py) * ey) / len2;
        t = if t < 0.0 {
            0.0
        } else if t > 1.0 {
            1.0
        } else {
            t
        };
        let sx = px + t * ex;
        let sy = py + t * ey;
        let d2 = (cx - sx) * (cx - sx) + (cy - sy) * (cy - sy);
        if d2 < best_d2 {
            best_d2 = d2;
            qx = sx;
            qy = sy;
        }
    }
    if inside <= 0.0 {
        // centre inside the polygon: depth to the nearest edge plus the radius
        return Contact { sep: inside - r, nx: inx, ny: iny };
    }
    let d = best_d2.sqrt();
    Contact { sep: d - r, nx: (cx - qx) / d, ny: (cy - qy) / d }
}

/// overlap.ts: Overlap. `i` is the piece that comes first in the list, `j` the later one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Overlap {
    pub i: usize,
    pub j: usize,
    /// negative; -sep is the penetration depth
    pub sep: f64,
}

/// overlap.ts: CellTable. The cells of find_overlaps: an open-addressing table from a cell's key
/// (a double) to the pieces in it as linked lists in insertion order. Keys match as the keys of a
/// JavaScript Map do (SameValueZero: NaN matches NaN). A slot is in use when its stamp is the
/// current call's. Reused between the calls of a thread.
#[derive(Debug, Default)]
struct CellTable {
    keys: Vec<f64>,
    stamps: Vec<u32>,
    head: Vec<i32>,
    tail: Vec<i32>,
    next: Vec<i32>,
    mask: usize,
    shift: u32,
    stamp: u32,
}

impl CellTable {
    /// overlap.ts: cellTable. Makes the table ready for `pieces` pieces and a new call.
    fn prepare(&mut self, pieces: usize) {
        let mut bits = 4u32;
        while (1usize << bits) < 4 * pieces {
            bits += 1;
        }
        if self.keys.is_empty() || self.mask + 1 < (1usize << bits) || self.next.len() < pieces + 1 {
            let size = 1usize << bits;
            self.keys = vec![0.0; size];
            self.stamps = vec![0; size];
            self.head = vec![0; size];
            self.tail = vec![0; size];
            self.next = vec![0; pieces + 1];
            self.mask = size - 1;
            self.shift = 32 - bits;
            self.stamp = 0;
        }
        if self.stamp == 0xffff_ffff {
            self.stamp = 0;
            self.stamps.fill(0);
        }
        self.stamp += 1;
    }

    /// The `find` of findOverlaps: Ok(slot) of the cell with this key, or Err(slot) of the free
    /// slot where it would go (the source returns `~slot`).
    #[inline]
    fn find(&self, key: f64) -> Result<usize, usize> {
        let mixed = to_int32(key) ^ math::imul(to_int32(key / 4294967296.0), 0x27d4_eb2f);
        let mut h = ((math::imul(mixed, 0x9e37_79b1_u32 as i32) as u32) >> self.shift) as usize;
        while self.stamps[h] == self.stamp {
            // SameValueZero: equal, or both NaN
            if self.keys[h] == key || (key.is_nan() && self.keys[h].is_nan()) {
                return Ok(h);
            }
            h = (h + 1) & self.mask;
        }
        Err(h)
    }
}

/// JavaScript's `x | 0` (ToInt32): the whole part modulo 2^32, as a signed integer; 0 for NaN and
/// the infinities.
#[inline]
fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let m = x.trunc() % 4294967296.0;
    (m as i64) as u32 as i32
}

thread_local! {
    static CELLS: RefCell<CellTable> = RefCell::new(CellTable::default());
}

/// overlap.ts: findOverlaps. All overlapping pairs among congruent pieces, in the source's order:
/// each piece against the earlier pieces of the 3x3 block of cells around it (the columns from
/// left to right, each from bottom to top; within a cell the pieces in list order), so a `limit`
/// cuts the list where the source cuts it.
///
/// Broad phase: uniform grid with cell size 2R, where R is the bounding radius. Two pieces can
/// only overlap when their centres are closer than 2R, so only the 3x3 block of neighbouring cells
/// needs the exact test, pair_separation. With `limit` (`usize::MAX` for none, the source's
/// Infinity), the search stops once that many pairs are found. Pieces that do not overlap leave
/// only a bounded number of neighbours in each cell, so the cost of a heavily overlapping
/// configuration (say every piece at one point) then stays near that of a valid one.
///
/// As in the source, `limit` is tested after a pair is stored: a limit of 0 returns the first pair.
/// The cell loops step a double by 1, as the source's do, so they would not end for a coordinate
/// beyond 2^53 cells; `parse_config` bounds coordinates at 1e6.
pub fn find_overlaps(n: u32, poses: &[Pose], tol: f64, scale: f64, limit: usize) -> Vec<Overlap> {
    CELLS.with(|cells| with_memo(|memo| find_overlaps_in(&mut cells.borrow_mut(), memo, n, poses, tol, scale, limit)))
}

fn find_overlaps_in(
    grid: &mut CellTable,
    memo: &mut TrigMemo,
    n: u32,
    poses: &[Pose],
    tol: f64,
    scale: f64,
    limit: usize,
) -> Vec<Overlap> {
    let reach = 2.0 * bounding_radius(n) * scale;
    let reach2 = reach * reach;
    const OFFSET: f64 = 33554432.0; // 2 ** 25
    const SPAN: f64 = 67108864.0; // 2 ** 26
    let mut out: Vec<Overlap> = Vec::new();
    let count = poses.len();
    grid.prepare(count);
    for i in 0..count {
        let a = &poses[i];
        let ix = (a.x / reach).floor();
        let iy = (a.y / reach).floor();
        let mut gx = ix - 1.0;
        while gx <= ix + 1.0 {
            let mut gy = iy - 1.0;
            while gy <= iy + 1.0 {
                if let Ok(cell) = grid.find((gx + OFFSET) * SPAN + (gy + OFFSET)) {
                    let mut link = grid.head[cell];
                    while link != 0 {
                        let j = (link - 1) as usize;
                        link = grid.next[link as usize];
                        let b = &poses[j];
                        let dx = a.x - b.x;
                        let dy = a.y - b.y;
                        if dx * dx + dy * dy > reach2 {
                            continue;
                        }
                        // most pairs within reach do not overlap: the cheaper test settles them
                        if !separation_below_in(memo, n, a, b, -tol, scale) {
                            continue;
                        }
                        let sep = pair_separation_in(memo, n, a, b, scale);
                        if sep < -tol {
                            out.push(Overlap { i: j, j: i, sep });
                            if out.len() >= limit {
                                return out;
                            }
                        }
                    }
                }
                gy += 1.0;
            }
            gx += 1.0;
        }
        let key = (ix + OFFSET) * SPAN + (iy + OFFSET);
        let cell = match grid.find(key) {
            Err(free) => {
                grid.stamps[free] = grid.stamp;
                grid.keys[free] = key;
                grid.head[free] = i as i32 + 1;
                free
            }
            Ok(cell) => {
                let last = grid.tail[cell] as usize;
                grid.next[last] = i as i32 + 1;
                cell
            }
        };
        grid.tail[cell] = i as i32 + 1;
        grid.next[i + 1] = 0;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_int32_is_javascripts() {
        assert_eq!(to_int32(0.0), 0);
        assert_eq!(to_int32(-0.0), 0);
        assert_eq!(to_int32(3.9), 3);
        assert_eq!(to_int32(-3.9), -3);
        assert_eq!(to_int32(2147483648.0), -2147483648);
        assert_eq!(to_int32(4294967296.0), 0);
        assert_eq!(to_int32(4294967297.0), 1);
        assert_eq!(to_int32(-4294967297.0), -1);
        assert_eq!(to_int32(2251799880794112.0), 67108864); // (2^25) * 2^26 + 2^26: a cell key
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(f64::INFINITY), 0);
    }

    /// The overlaps are those of a plain scan of all pairs, in the order of the later piece.
    #[test]
    fn finds_what_a_plain_scan_finds() {
        let mut seed = 11u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 11) as f64) / ((1u64 << 53) as f64)
        };
        for n in [0u32, 3, 4, 6, 12, 37, 100] {
            for round in 0..6 {
                let count = 5 + 40 * round;
                let spread = 1.0 + (count as f64).sqrt() * 0.8;
                let poses: Vec<Pose> =
                    (0..count).map(|_| Pose::new(spread * (next() - 0.5), spread * (next() - 0.5), 7.0 * next() - 3.0)).collect();
                let found = find_overlaps(n, &poses, TOL, 1.0, usize::MAX);
                let mut plain = Vec::new();
                for j in 0..count {
                    for i in 0..j {
                        let sep = pair_separation(n, &poses[j], &poses[i], 1.0);
                        if sep < -TOL {
                            plain.push((i, j, sep.to_bits()));
                        }
                    }
                }
                let mut got: Vec<(usize, usize, u64)> = found.iter().map(|o| (o.i, o.j, o.sep.to_bits())).collect();
                // the scan goes cell by cell, so only the later piece is in order
                assert!(got.windows(2).all(|w| w[0].1 <= w[1].1));
                got.sort_unstable();
                plain.sort_unstable();
                assert_eq!(got, plain, "n={n} count={count}");
                let limited = find_overlaps(n, &poses, TOL, 1.0, 20);
                assert_eq!(limited.len(), found.len().min(20));
                assert_eq!(&found[..limited.len()], &limited[..]);
                assert_eq!(find_overlaps(n, &poses, TOL, 1.0, 0).len(), found.len().min(1));
            }
        }
    }

    #[test]
    fn pruned_kernels_agree_with_the_full_one() {
        let mut seed = 5u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 11) as f64) / ((1u64 << 53) as f64)
        };
        for n in [3u32, 4, 5, 8, 11, 12, 13, 37, 50, 67, 100] {
            for _ in 0..3000 {
                let a = Pose::new(next() * 2.0, next() * 2.0, next() * 20.0 - 10.0);
                let b = Pose::new(next() * 2.0, next() * 2.0, next() * 20.0 - 10.0);
                let full = regular_polygon_separation(n, &a, &b, 1.0).sep;
                let pruned = pair_separation(n, &a, &b, 1.0);
                assert_eq!(full.to_bits(), pruned.to_bits(), "n={n}");
                let vertices = |p: &Pose| crate::shapes::piece_vertices(n, p, 1.0);
                let general = polygon_separation(&vertices(&a), &vertices(&b)).sep;
                assert!((general - full).abs() < 1e-12);
                for threshold in [-1e-9, 0.0, full, full + 1e-13, 0.3] {
                    assert_eq!(separation_below(n, &a, &b, threshold, 1.0), full < threshold);
                    assert_eq!(piece_separation_below(n, &a, &b, threshold, 1.0), full < threshold);
                }
                let o = regular_polygon_overlap(n, a.x, a.y, a.theta, b.x, b.y, b.theta, 1.0, 0.0);
                if full < 0.0 {
                    assert_eq!(o.to_bits(), full.to_bits());
                } else {
                    assert!(o >= 0.0);
                }
            }
        }
    }
}
