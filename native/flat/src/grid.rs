//! Broad phase: pairs of pieces whose centres are within a reach of each other.
//!
//! Two congruent pieces can only touch when their centres are closer than twice the bounding
//! radius, so every candidate pair lies in the 3x3 block of cells of side `reach` around a piece.
//! The cells are stored compressed (counting sort into one index array) over the bounding box of
//! the centres; a box with far more cells than pieces (adversarially spread coordinates) falls
//! back to a sorted list of cell keys. Buffers are reused between builds, so repeated queries
//! allocate nothing once they have grown.

use crate::shapes::Pose;

#[derive(Default, Clone)]
pub struct NeighborGrid {
    reach: f64,
    // dense mode
    dense: bool,
    x0: f64,
    y0: f64,
    gx: i64,
    gy: i64,
    start: Vec<u32>,
    items: Vec<u32>,
    cell_of: Vec<u32>,
    fill: Vec<u32>,
    // sparse mode: (cell key, piece) sorted
    keys: Vec<(i64, i64, u32)>,
}

impl NeighborGrid {
    pub fn new() -> Self {
        Self::default()
    }

    /// Index the centres of `poses` for queries within `reach`.
    pub fn build(&mut self, poses: &[Pose], reach: f64) {
        let n = poses.len();
        self.reach = reach;
        self.items.clear();
        self.keys.clear();
        if n == 0 || !(reach > 0.0) || !reach.is_finite() {
            self.dense = true;
            self.gx = 0;
            self.gy = 0;
            self.start.clear();
            self.start.push(0);
            return;
        }
        let mut minx = f64::INFINITY;
        let mut miny = f64::INFINITY;
        let mut maxx = f64::NEG_INFINITY;
        let mut maxy = f64::NEG_INFINITY;
        let mut finite = true;
        for p in poses {
            if !(p.x.is_finite() && p.y.is_finite()) {
                finite = false;
                break;
            }
            minx = minx.min(p.x);
            miny = miny.min(p.y);
            maxx = maxx.max(p.x);
            maxy = maxy.max(p.y);
        }
        let gx = if finite { ((maxx - minx) / reach).floor() + 1.0 } else { f64::INFINITY };
        let gy = if finite { ((maxy - miny) / reach).floor() + 1.0 } else { f64::INFINITY };
        if finite && gx * gy <= (4 * n + 64) as f64 {
            self.dense = true;
            self.x0 = minx;
            self.y0 = miny;
            self.gx = gx as i64;
            self.gy = gy as i64;
            let cells = (self.gx * self.gy) as usize;
            self.start.clear();
            self.start.resize(cells + 1, 0);
            self.cell_of.clear();
            self.cell_of.resize(n, 0);
            for (i, p) in poses.iter().enumerate() {
                let cx = (((p.x - minx) / reach) as i64).min(self.gx - 1);
                let cy = (((p.y - miny) / reach) as i64).min(self.gy - 1);
                let c = (cy * self.gx + cx) as u32;
                self.cell_of[i] = c;
                self.start[c as usize + 1] += 1;
            }
            for c in 0..cells {
                self.start[c + 1] += self.start[c];
            }
            self.items.resize(n, 0);
            // fill in index order so that each cell lists its pieces in ascending order
            self.fill.clear();
            self.fill.extend_from_slice(&self.start[..cells]);
            for i in 0..n {
                let c = self.cell_of[i] as usize;
                self.items[self.fill[c] as usize] = i as u32;
                self.fill[c] += 1;
            }
        } else {
            self.dense = false;
            for (i, p) in poses.iter().enumerate() {
                let (kx, ky) = if p.x.is_finite() && p.y.is_finite() {
                    ((p.x / reach).floor() as i64, (p.y / reach).floor() as i64)
                } else {
                    (i64::MAX, i64::MAX)
                };
                self.keys.push((kx, ky, i as u32));
            }
            self.keys.sort_unstable();
        }
    }

    /// Calls `f(i, j)` once for every pair i < j whose centres are within the reach (inclusive);
    /// `f` returns false to stop the scan. Non-finite centres are never paired.
    pub fn for_each_pair(&self, poses: &[Pose], mut f: impl FnMut(usize, usize) -> bool) {
        let reach2 = self.reach * self.reach;
        if self.dense {
            if self.gx == 0 {
                return;
            }
            for i in 0..poses.len() {
                let c = self.cell_of[i] as i64;
                let cx = c % self.gx;
                let cy = c / self.gx;
                let a = poses[i];
                for ny in (cy - 1).max(0)..=(cy + 1).min(self.gy - 1) {
                    let lo = (cx - 1).max(0);
                    let hi = (cx + 1).min(self.gx - 1);
                    // the cells of one row in this range are contiguous
                    let s = self.start[(ny * self.gx + lo) as usize] as usize;
                    let e = self.start[(ny * self.gx + hi) as usize + 1] as usize;
                    for &j in &self.items[s..e] {
                        let j = j as usize;
                        if j <= i {
                            continue;
                        }
                        let b = poses[j];
                        let dx = a.x - b.x;
                        let dy = a.y - b.y;
                        if dx * dx + dy * dy <= reach2 && !f(i, j) {
                            return;
                        }
                    }
                }
            }
        } else {
            let keys = &self.keys;
            for k in 0..keys.len() {
                let (kx, ky, i) = keys[k];
                if kx == i64::MAX {
                    continue;
                }
                let i = i as usize;
                let a = poses[i];
                for gx in [kx.saturating_sub(1), kx, kx.saturating_add(1)] {
                    let lo = keys.partition_point(|e| (e.0, e.1) < (gx, ky.saturating_sub(1)));
                    let mut t = lo;
                    while t < keys.len() && keys[t].0 == gx && keys[t].1 <= ky.saturating_add(1) {
                        let j = keys[t].2 as usize;
                        t += 1;
                        if j <= i {
                            continue;
                        }
                        let b = poses[j];
                        let dx = a.x - b.x;
                        let dy = a.y - b.y;
                        if dx * dx + dy * dy <= reach2 && !f(i, j) {
                            return;
                        }
                    }
                }
            }
        }
    }

    /// Calls `f(j)` for every piece j != `skip` whose centre is within the reach of (x, y).
    /// The point may lie outside the indexed box.
    pub fn for_each_near(&self, poses: &[Pose], x: f64, y: f64, skip: usize, mut f: impl FnMut(usize) -> bool) {
        let reach2 = self.reach * self.reach;
        if !(x.is_finite() && y.is_finite()) {
            return;
        }
        if self.dense {
            if self.gx == 0 {
                return;
            }
            let fx = ((x - self.x0) / self.reach).floor();
            let fy = ((y - self.y0) / self.reach).floor();
            if fx < -1.0 || fy < -1.0 || fx > self.gx as f64 || fy > self.gy as f64 {
                return;
            }
            let cx = fx as i64;
            let cy = fy as i64;
            for ny in (cy - 1).max(0)..=(cy + 1).min(self.gy - 1) {
                let lo = (cx - 1).max(0);
                let hi = (cx + 1).min(self.gx - 1);
                if lo > hi {
                    continue;
                }
                let s = self.start[(ny * self.gx + lo) as usize] as usize;
                let e = self.start[(ny * self.gx + hi) as usize + 1] as usize;
                for &j in &self.items[s..e] {
                    let j = j as usize;
                    if j == skip {
                        continue;
                    }
                    let b = poses[j];
                    let dx = x - b.x;
                    let dy = y - b.y;
                    if dx * dx + dy * dy <= reach2 && !f(j) {
                        return;
                    }
                }
            }
        } else {
            let kx = (x / self.reach).floor() as i64;
            let ky = (y / self.reach).floor() as i64;
            let keys = &self.keys;
            for gx in [kx.saturating_sub(1), kx, kx.saturating_add(1)] {
                let lo = keys.partition_point(|e| (e.0, e.1) < (gx, ky.saturating_sub(1)));
                let mut t = lo;
                while t < keys.len() && keys[t].0 == gx && keys[t].1 <= ky.saturating_add(1) {
                    let j = keys[t].2 as usize;
                    t += 1;
                    if j == skip {
                        continue;
                    }
                    let b = poses[j];
                    let dx = x - b.x;
                    let dy = y - b.y;
                    if dx * dx + dy * dy <= reach2 && !f(j) {
                        return;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_all_pairs() {
        let mut seed = 3u64;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 11) as f64) / ((1u64 << 53) as f64)
        };
        for spread in [3.0, 30.0, 1e5] {
            let poses: Vec<Pose> = (0..200).map(|_| Pose::new(rnd() * spread, rnd() * spread, 0.0)).collect();
            let mut g = NeighborGrid::new();
            g.build(&poses, 1.3);
            let mut found = vec![];
            g.for_each_pair(&poses, |i, j| {
                found.push((i, j));
                true
            });
            found.sort();
            let mut brute = vec![];
            for i in 0..poses.len() {
                for j in i + 1..poses.len() {
                    let dx = poses[i].x - poses[j].x;
                    let dy = poses[i].y - poses[j].y;
                    if dx * dx + dy * dy <= 1.3 * 1.3 {
                        brute.push((i, j));
                    }
                }
            }
            assert_eq!(found, brute);
            for k in 0..poses.len() {
                let mut near = vec![];
                g.for_each_near(&poses, poses[k].x + 0.1, poses[k].y, k, |j| {
                    near.push(j);
                    true
                });
                near.sort();
                let mut bn = vec![];
                for j in 0..poses.len() {
                    if j == k {
                        continue;
                    }
                    let dx = poses[k].x + 0.1 - poses[j].x;
                    let dy = poses[k].y - poses[j].y;
                    if dx * dx + dy * dy <= 1.3 * 1.3 {
                        bn.push(j);
                    }
                }
                assert_eq!(near, bn);
            }
        }
    }
}
