//! Shrink and repair (packages/solver/src/methods/shrink_repair.ts, shrink_repair/repair.ts and
//! kernel.ts): separate feasibility from size, as the strongest irregular-packing heuristics do
//! (Egeblad, Nielsen & Odgaard 2007; Imamichi, Yagiura & Nagamochi 2009; sparrow). From the
//! current valid packing at size s the container is shrunk to s (1 - r), the centres are scaled
//! into it, and a repair phase at that fixed size removes the overlap by global descent,
//! relocation of conflicting pieces by sampling, and guided-local-search weights. A repaired state
//! is legalised strictly and scored; r adapts to success and failure. At the floor of a basin the
//! search explores (ruins a region, repairs just below the current size), and after repeated
//! failed explorations restarts from random poses near the best size.

use super::common::{adopt, legalise, restore, scatter, shuffle, PairTester, Strategy};
use crate::framework::Ctx;
use crate::rng::Rng;
use crate::shapes::{area_lower_bound, bounding_radius, container_inradius, piece_inradius, Config, Pose, DISK_RADIUS, MAX_COORD};
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub start: String,
    pub shrink_ratio: f64,
    pub min_shrink_ratio: f64,
    pub max_shrink_ratio: f64,
    pub strikes: u32,
    pub patience: u32,
    pub global_samples: u32,
    pub local_samples: u32,
    pub weight_growth: f64,
    pub weight_decay: f64,
    pub descent_iterations: u32,
    pub explore_patience: u32,
    pub max_ruin: f64,
    pub restart_after: u32,
    pub restart_slack: f64,
    pub evaluation_work: f64,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            start: "auto".into(),
            shrink_ratio: 0.01,
            min_shrink_ratio: 0.0002,
            max_shrink_ratio: 0.05,
            strikes: 3,
            patience: 12,
            global_samples: 48,
            local_samples: 24,
            weight_growth: 2.0,
            weight_decay: 0.95,
            descent_iterations: 40,
            explore_patience: 24,
            max_ruin: 1.0,
            restart_after: 40,
            restart_slack: 0.02,
            evaluation_work: 4000.0,
        }
    }
}

impl Params {
    pub fn check(&self) -> Result<(), String> {
        if self.start != "auto" && self.start != "random" {
            return Err("start must be auto or random".into());
        }
        if !(self.shrink_ratio > 0.0 && self.shrink_ratio <= 0.5) || self.strikes < 1 || self.patience < 1 || self.descent_iterations < 1 {
            return Err("shrink_repair parameters out of range".into());
        }
        Ok(())
    }
}

/// A state is feasible for the repair when nothing penetrates or protrudes by more than this.
pub const SUCCESS_DEPTH: f64 = 1e-10;
const MEMORY: usize = 8;
const REFINE_STEPS: usize = 10;
const WEIGHT_CEILING: f64 = 1e12;

#[inline]
fn offset(rel: f64, step: f64) -> f64 {
    let mut t = rel % step;
    if t < 0.0 {
        t += step;
    }
    if t > step / 2.0 {
        step - t
    } else {
        t
    }
}

/// Support-form protrusions of one piece: sum of squares, the deepest, and the sum's gradient.
#[derive(Clone, Copy, Default)]
struct Walls {
    sum: f64,
    max: f64,
    wx: f64,
    wy: f64,
    wt: f64,
}

/// Overlap kernels of the repair. Along edge normal k of piece p the other piece q reaches
/// R cos(delta), with delta the same for all N edges of one pass (consecutive normals differ by
/// the vertex spacing): one cosine per pass. Walls: the furthest vertex along a wall normal is the
/// vertex nearest in angle to it.
struct Kernel {
    n: u32,
    m: u32,
    big_r: f64,
    r: f64,
    step: f64,
    base_cos: Vec<f64>,
    base_sin: Vec<f64>,
    wall_cos: Vec<f64>,
    wall_sin: Vec<f64>,
    wall_angle: Vec<f64>,
}

impl Kernel {
    fn new(n: u32, m: u32) -> Self {
        let step = if n == 0 { 2.0 * PI } else { 2.0 * PI / n as f64 };
        let base: Vec<f64> = (0..n as usize).map(|k| PI / 2.0 + PI / n as f64 + k as f64 * step).collect();
        let walls: Vec<f64> = (0..m as usize).map(|j| -PI / 2.0 + 2.0 * PI * j as f64 / m as f64).collect();
        Kernel {
            n,
            m,
            big_r: bounding_radius(n),
            r: piece_inradius(n),
            step,
            base_cos: base.iter().map(|a| a.cos()).collect(),
            base_sin: base.iter().map(|a| a.sin()).collect(),
            wall_cos: walls.iter().map(|a| a.cos()).collect(),
            wall_sin: walls.iter().map(|a| a.sin()).collect(),
            wall_angle: walls,
        }
    }

    /// Edge normals of a piece at angle theta, [ux0, uy0, ux1, uy1, ...].
    #[inline]
    fn normals(&self, theta: f64, out: &mut [f64]) {
        let (s, c) = theta.sin_cos();
        for k in 0..self.n as usize {
            out[2 * k] = c * self.base_cos[k] - s * self.base_sin[k];
            out[2 * k + 1] = s * self.base_cos[k] + c * self.base_sin[k];
        }
    }

    /// Penetration depth of a and b when they overlap, otherwise 0 (it stops at the first
    /// separating axis).
    #[inline]
    fn depth(&self, xa: f64, ya: f64, ta: f64, ua: &[f64], xb: f64, yb: f64, tb: f64, ub: &[f64]) -> f64 {
        let dx = xb - xa;
        let dy = yb - ya;
        if self.n == 0 {
            let d = 2.0 * self.big_r - dx.hypot(dy);
            return if d > 0.0 { d } else { 0.0 };
        }
        let n = self.n as usize;
        let extra = PI + PI / self.n as f64;
        let ca = self.r + self.big_r * offset(ta - tb + extra, self.step).cos();
        let mut best = f64::NEG_INFINITY;
        for k in 0..n {
            let s = dx * ua[2 * k] + dy * ua[2 * k + 1] - ca;
            if s >= 0.0 {
                return 0.0;
            }
            if s > best {
                best = s;
            }
        }
        let cb = self.r + self.big_r * offset(tb - ta + extra, self.step).cos();
        for k in 0..n {
            let s = -(dx * ub[2 * k] + dy * ub[2 * k + 1]) - cb;
            if s >= 0.0 {
                return 0.0;
            }
            if s > best {
                best = s;
            }
        }
        -best
    }

    /// Signed penetration depth (positive: overlap) and, when positive, its derivatives with
    /// respect to both poses in `g` (a's x, y, theta, then b's), the selected separating-axis
    /// branch: the edge normal u of piece p and the vertex v of piece q.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn depth_gradient(&self, xa: f64, ya: f64, ta: f64, ua: &[f64], xb: f64, yb: f64, tb: f64, ub: &[f64], g: &mut [f64; 6]) -> f64 {
        let dx = xb - xa;
        let dy = yb - ya;
        if self.n == 0 {
            let distance = dx.hypot(dy);
            // coincident centres: a bounded subgradient that separates them
            let ux = if distance == 0.0 { 1.0 } else { -dx / distance };
            let uy = if distance == 0.0 { 0.0 } else { -dy / distance };
            *g = [-ux, -uy, 0.0, ux, uy, 0.0];
            return 2.0 * self.big_r - distance;
        }
        let n = self.n as usize;
        let step = self.step;
        let extra = PI + PI / self.n as f64;
        let rel_a = ta - tb + extra;
        let rel_b = tb - ta + extra;
        let ca = self.r + self.big_r * offset(rel_a, step).cos();
        let cb = self.r + self.big_r * offset(rel_b, step).cos();
        let mut best = f64::NEG_INFINITY;
        let mut pass = 0;
        let mut edge = 0;
        for k in 0..n {
            let s = dx * ua[2 * k] + dy * ua[2 * k + 1] - ca;
            if s > best {
                best = s;
                edge = k;
            }
        }
        for k in 0..n {
            let s = -(dx * ub[2 * k] + dy * ub[2 * k + 1]) - cb;
            if s > best {
                best = s;
                pass = 1;
                edge = k;
            }
        }
        if !(best < 0.0) {
            return -best;
        }
        // edge piece p, vertex piece q; d = q - p
        let (ux, uy) = if pass == 0 { (ua[2 * edge], ua[2 * edge + 1]) } else { (ub[2 * edge], ub[2 * edge + 1]) };
        let qt = if pass == 0 { tb } else { ta };
        let rel = (if pass == 0 { rel_a } else { rel_b }) + edge as f64 * step;
        let vertex = (rel / step).round();
        let vertex_angle = qt + PI / 2.0 + vertex * step;
        let vx = self.big_r * vertex_angle.cos();
        let vy = self.big_r * vertex_angle.sin();
        let (ddx, ddy) = if pass == 0 { (dx, dy) } else { (-dx, -dy) };
        let pt = (ddx + vx) * uy - (ddy + vy) * ux;
        let qtheta = vy * ux - vx * uy;
        if pass == 0 {
            *g = [ux, uy, pt, -ux, -uy, qtheta];
        } else {
            *g = [-ux, -uy, qtheta, ux, uy, pt];
        }
        -best
    }

    /// Squared protrusions of one piece through the walls of a container of size `size` centred
    /// at the origin with phi = 0, in support form (for a circle, the furthest vertex).
    #[inline]
    fn walls(&self, x: f64, y: f64, theta: f64, size: f64, gradient: bool) -> Walls {
        let mut w = Walls::default();
        let (n, m, big_r, step) = (self.n, self.m, self.big_r, self.step);
        // radius of the circle container, or the apothem of a polygon container
        let limit = size * container_inradius(m);
        if m == 0 {
            let distance = x.hypot(y);
            if distance + big_r <= limit {
                return w;
            }
            let (mut px, mut py, mut ox, mut oy) = (x, y, 0.0, 0.0);
            if n != 0 {
                // the vertex nearest in angle to the centre's direction is the furthest one
                let a0 = theta + PI / 2.0;
                let vertex = (((if distance == 0.0 { 0.0 } else { y.atan2(x) }) - a0) / step).round();
                let angle = a0 + vertex * step;
                ox = big_r * angle.cos();
                oy = big_r * angle.sin();
                px += ox;
                py += oy;
            }
            let reach = px.hypot(py);
            let depth = reach + if n == 0 { DISK_RADIUS } else { 0.0 } - limit;
            if !(depth > 0.0) {
                return w;
            }
            w.sum = depth * depth;
            w.max = depth;
            if gradient {
                let ux = if reach == 0.0 { 1.0 } else { px / reach };
                let uy = if reach == 0.0 { 0.0 } else { py / reach };
                w.wx = 2.0 * depth * ux;
                w.wy = 2.0 * depth * uy;
                w.wt = 2.0 * depth * (ox * uy - oy * ux);
            }
            return w;
        }
        let a0 = theta + PI / 2.0;
        for j in 0..m as usize {
            let wx = self.wall_cos[j];
            let wy = self.wall_sin[j];
            let h = x * wx + y * wy;
            if h + big_r <= limit {
                continue;
            }
            let (depth, ox, oy) = if n == 0 {
                (h + DISK_RADIUS - limit, 0.0, 0.0)
            } else {
                let vertex = ((self.wall_angle[j] - a0) / step).round();
                let angle = a0 + vertex * step;
                let ox = big_r * angle.cos();
                let oy = big_r * angle.sin();
                (h + ox * wx + oy * wy - limit, ox, oy)
            };
            if !(depth > 0.0) {
                continue;
            }
            w.sum += depth * depth;
            if depth > w.max {
                w.max = depth;
            }
            if gradient {
                w.wx += 2.0 * depth * wx;
                w.wy += 2.0 * depth * wy;
                w.wt += 2.0 * depth * (ox * wy - oy * wx);
            }
        }
        w
    }
}

struct Settings {
    global_samples: u32,
    local_samples: u32,
    weight_growth: f64,
    weight_decay: f64,
}

/// The repair's working state: poses in the frame of a container centred at the origin with
/// phi = 0, whose size is fixed during one repair.
///
/// Objective F = sum_pairs w_ij d_ij^2 + sum_i v_i sum_walls p_ik^2, with d the penetration depth
/// of the true pieces and p the support-form protrusions; the unweighted sum is the raw overlap.
struct RepairState {
    n: u32,
    m: u32,
    p: usize,
    nn: usize,
    poses: Vec<Pose>,
    size: f64,
    big_r: f64,
    rin: f64,
    period: f64,
    apothem: f64,
    raw: f64,
    max_depth: f64,
    /// Counted pair and wall feature tests since the caller last took them.
    work: f64,
    pair_cost: f64,
    wall_cost: f64,
    settings: Settings,
    kernel: Kernel,
    axes: Vec<f64>,
    pair_weight: Vec<f64>,
    wall_weight: Vec<f64>,
    active_pairs: Vec<u32>,
    active_pair_flag: Vec<bool>,
    active_walls: Vec<bool>,
    stamp: Vec<u32>,
    stamp_value: u32,
    // a uniform grid of cell lists over the container's bounding box (pieces outside are clamped
    // into the border cells, which keeps every pair within reach in adjacent cells)
    cell_size: f64,
    grid_origin: f64,
    g: i64,
    head: Vec<i32>,
    next: Vec<i32>,
    prev: Vec<i32>,
    cell_of: Vec<i32>,
    pair_i: Vec<u32>,
    pair_j: Vec<u32>,
    pair_d: Vec<f64>,
    wall_depth: Vec<f64>,
    cand_axes: Vec<f64>,
    trial_axes: Vec<f64>,
    piece_grad: [f64; 3],
    x: Vec<f64>,
    gvec: Vec<f64>,
    x_new: Vec<f64>,
    g_new: Vec<f64>,
    direction: Vec<f64>,
    s_hist: Vec<Vec<f64>>,
    y_hist: Vec<Vec<f64>>,
}

impl RepairState {
    fn new(n: u32, m: u32, p: usize, settings: Settings) -> Self {
        let nn = n as usize;
        RepairState {
            n,
            m,
            p,
            nn,
            poses: vec![Pose::default(); p],
            size: 1.0,
            big_r: bounding_radius(n),
            rin: piece_inradius(n),
            period: if n == 0 { 2.0 * PI } else { 2.0 * PI / n as f64 },
            apothem: container_inradius(m),
            raw: 0.0,
            max_depth: 0.0,
            work: 0.0,
            pair_cost: if n == 0 { 1.0 } else { 2.0 * n as f64 },
            wall_cost: if m == 0 { 1.0 } else { m as f64 },
            settings,
            kernel: Kernel::new(n, m),
            axes: vec![0.0; 2 * nn * p],
            pair_weight: vec![1.0; p * p],
            wall_weight: vec![1.0; p],
            active_pairs: Vec::new(),
            active_pair_flag: vec![false; p * p],
            active_walls: vec![false; p],
            stamp: vec![0; p * p],
            stamp_value: 0,
            cell_size: 1.0,
            grid_origin: 0.0,
            g: 1,
            head: vec![-1; 1],
            next: vec![-1; p],
            prev: vec![-1; p],
            cell_of: vec![0; p],
            pair_i: Vec::new(),
            pair_j: Vec::new(),
            pair_d: Vec::new(),
            wall_depth: vec![0.0; p],
            cand_axes: vec![0.0; 2 * nn],
            trial_axes: vec![0.0; 2 * nn],
            piece_grad: [0.0; 3],
            x: vec![0.0; 3 * p],
            gvec: vec![0.0; 3 * p],
            x_new: vec![0.0; 3 * p],
            g_new: vec![0.0; 3 * p],
            direction: vec![0.0; 3 * p],
            s_hist: vec![vec![0.0; 3 * p]; MEMORY],
            y_hist: vec![vec![0.0; 3 * p]; MEMORY],
        }
    }

    /// Set the container size and rebuild the grid for it.
    fn set_size(&mut self, size: f64) {
        self.size = size;
        // half-width of the container's bounding box: its circumradius (radius for a circle)
        let half = if self.m == 0 { size / 2.0 } else { size / (2.0 * (PI / self.m as f64).sin()) };
        self.cell_size = 2.0 * self.big_r;
        let g = ((2.0 * (half + self.big_r)) / self.cell_size).ceil();
        self.g = if g.is_finite() { (g as i64).clamp(1, 256) } else { 256 };
        self.grid_origin = -(self.g as f64) * self.cell_size * 0.5;
        let cells = (self.g * self.g) as usize;
        if self.head.len() != cells {
            self.head = vec![-1; cells];
        }
        self.rebuild_grid();
    }

    fn wrap(&self, theta: f64) -> f64 {
        let t = theta % self.period;
        if t < 0.0 {
            t + self.period
        } else {
            t
        }
    }

    fn refresh_axes(&mut self, i: usize) {
        if self.n != 0 {
            let nn = self.nn;
            let theta = self.poses[i].theta;
            self.kernel.normals(theta, &mut self.axes[2 * nn * i..2 * nn * (i + 1)]);
        }
    }

    /// Copy poses in (angles reduced to one symmetry period) and refresh the caches.
    fn load(&mut self, pieces: &[Pose]) {
        for i in 0..self.p {
            self.poses[i] = Pose::new(pieces[i].x, pieces[i].y, if self.n == 0 { 0.0 } else { self.wrap(pieces[i].theta) });
            self.refresh_axes(i);
        }
        self.rebuild_grid();
    }

    /// Reset every guided-local-search weight to 1.
    fn reset_weights(&mut self) {
        for &key in &self.active_pairs {
            self.pair_weight[key as usize] = 1.0;
            self.active_pair_flag[key as usize] = false;
        }
        self.active_pairs.clear();
        for i in 0..self.p {
            if self.active_walls[i] {
                self.wall_weight[i] = 1.0;
                self.active_walls[i] = false;
            }
        }
    }

    #[inline]
    fn cell_index(&self, x: f64, y: f64) -> i32 {
        let g = self.g;
        let mut cx = ((x - self.grid_origin) / self.cell_size).floor();
        let mut cy = ((y - self.grid_origin) / self.cell_size).floor();
        // non-finite coordinates go to cell 0; they never occur in a state the method keeps
        if !(cx >= 0.0) {
            cx = 0.0;
        } else if cx >= g as f64 {
            cx = (g - 1) as f64;
        }
        if !(cy >= 0.0) {
            cy = 0.0;
        } else if cy >= g as f64 {
            cy = (g - 1) as f64;
        }
        (cy as i64 * g + cx as i64) as i32
    }

    fn rebuild_grid(&mut self) {
        self.head.fill(-1);
        for i in 0..self.p {
            self.insert(i);
        }
        self.work += self.p as f64;
    }

    fn insert(&mut self, i: usize) {
        let c = self.cell_index(self.poses[i].x, self.poses[i].y);
        self.cell_of[i] = c;
        let first = self.head[c as usize];
        self.next[i] = first;
        self.prev[i] = -1;
        if first >= 0 {
            self.prev[first as usize] = i as i32;
        }
        self.head[c as usize] = i as i32;
    }

    fn remove(&mut self, i: usize) {
        let n = self.next[i];
        let p = self.prev[i];
        if p >= 0 {
            self.next[p as usize] = n;
        } else {
            self.head[self.cell_of[i] as usize] = n;
        }
        if n >= 0 {
            self.prev[n as usize] = p;
        }
    }

    /// Place piece i at a pose, keeping the grid and caches current.
    fn place(&mut self, i: usize, pose: Pose) {
        self.poses[i] = Pose::new(pose.x, pose.y, if self.n == 0 { 0.0 } else { self.wrap(pose.theta) });
        self.refresh_axes(i);
        let c = self.cell_index(pose.x, pose.y);
        if c != self.cell_of[i] {
            self.remove(i);
            self.insert(i);
        }
    }

    /// Scale every centre about the container centre (the origin).
    fn scale_centres(&mut self, factor: f64) {
        for q in &mut self.poses {
            q.x *= factor;
            q.y *= factor;
        }
        self.rebuild_grid();
    }

    /// List every pair whose centres are within twice the bounding radius (i < j).
    fn collect_pairs(&mut self) {
        self.pair_i.clear();
        self.pair_j.clear();
        let g = self.g;
        let reach2 = 4.0 * self.big_r * self.big_r;
        for i in 0..self.p {
            let a = self.poses[i];
            let c = self.cell_of[i] as i64;
            let cx = c % g;
            let cy = c / g;
            for gy in (cy - 1).max(0)..=(cy + 1).min(g - 1) {
                for gx in (cx - 1).max(0)..=(cx + 1).min(g - 1) {
                    let mut j = self.head[(gy * g + gx) as usize];
                    while j >= 0 {
                        let ju = j as usize;
                        j = self.next[ju];
                        if ju <= i {
                            continue;
                        }
                        let b = self.poses[ju];
                        let dx = a.x - b.x;
                        let dy = a.y - b.y;
                        if dx * dx + dy * dy <= reach2 {
                            self.pair_i.push(i as u32);
                            self.pair_j.push(ju as u32);
                        }
                    }
                }
            }
        }
        self.pair_d.resize(self.pair_i.len(), 0.0);
        self.work += self.p as f64;
    }

    /// The weighted objective at the current poses; with `gradient`, also its gradient into
    /// `gvec` (or `g_new` with `into_new`). Updates raw, max_depth, the pair depths and the wall
    /// depths.
    fn evaluate(&mut self, gradient: bool, into_new: bool) -> f64 {
        let p = self.p;
        let nn = self.nn;
        if gradient {
            if into_new {
                self.g_new.fill(0.0);
            } else {
                self.gvec.fill(0.0);
            }
        }
        self.collect_pairs();
        let mut value = 0.0;
        let mut raw = 0.0;
        let mut deepest = 0.0f64;
        for k in 0..self.pair_i.len() {
            let i = self.pair_i[k] as usize;
            let j = self.pair_j[k] as usize;
            let a = self.poses[i];
            let b = self.poses[j];
            let ua = &self.axes[2 * nn * i..2 * nn * (i + 1)];
            let ub = &self.axes[2 * nn * j..2 * nn * (j + 1)];
            let mut gr = [0.0f64; 6];
            let d = if gradient {
                self.kernel.depth_gradient(a.x, a.y, a.theta, ua, b.x, b.y, b.theta, ub, &mut gr)
            } else {
                self.kernel.depth(a.x, a.y, a.theta, ua, b.x, b.y, b.theta, ub)
            };
            self.pair_d[k] = d;
            if !(d > 0.0) {
                continue;
            }
            let w = self.pair_weight[i * p + j];
            raw += d * d;
            value += w * d * d;
            if d > deepest {
                deepest = d;
            }
            if gradient {
                let f = 2.0 * w * d;
                let g = if into_new { &mut self.g_new } else { &mut self.gvec };
                g[3 * i] += f * gr[0];
                g[3 * i + 1] += f * gr[1];
                g[3 * i + 2] += f * gr[2];
                g[3 * j] += f * gr[3];
                g[3 * j + 1] += f * gr[4];
                g[3 * j + 2] += f * gr[5];
            }
        }
        let size = self.size;
        for i in 0..p {
            let q = self.poses[i];
            let wl = self.kernel.walls(q.x, q.y, q.theta, size, gradient);
            self.wall_depth[i] = wl.max;
            if wl.sum == 0.0 {
                continue;
            }
            let v = self.wall_weight[i];
            raw += wl.sum;
            value += v * wl.sum;
            if wl.max > deepest {
                deepest = wl.max;
            }
            if gradient {
                let g = if into_new { &mut self.g_new } else { &mut self.gvec };
                g[3 * i] += v * wl.wx;
                g[3 * i + 1] += v * wl.wy;
                g[3 * i + 2] += v * wl.wt;
            }
        }
        self.work += self.pair_i.len() as f64 * self.pair_cost + p as f64 * self.wall_cost;
        self.raw = raw;
        self.max_depth = deepest;
        value
    }

    fn feasible(&self) -> bool {
        self.max_depth <= SUCCESS_DEPTH
    }

    /// Pieces in conflict at the last evaluation, in index order.
    fn conflicting(&self) -> Vec<usize> {
        let mut hit = vec![false; self.p];
        for k in 0..self.pair_i.len() {
            if self.pair_d[k] > SUCCESS_DEPTH {
                hit[self.pair_i[k] as usize] = true;
                hit[self.pair_j[k] as usize] = true;
            }
        }
        for i in 0..self.p {
            if self.wall_depth[i] > SUCCESS_DEPTH {
                hit[i] = true;
            }
        }
        (0..self.p).filter(|&i| hit[i]).collect()
    }

    /// Guided local search: multiply the weight of every pair and wall still in conflict by between
    /// 1 + (growth - 1)/5 (shallowest) and growth (deepest); decay former conflicts toward 1.
    fn update_weights(&mut self) {
        let growth = self.settings.weight_growth;
        let low = 1.0 + (growth - 1.0) / 5.0;
        let decay = self.settings.weight_decay;
        let deepest = self.max_depth;
        if !(deepest > 0.0) {
            return;
        }
        self.stamp_value = self.stamp_value.wrapping_add(1);
        if self.stamp_value == u32::MAX {
            self.stamp.fill(0);
            self.stamp_value = 1;
        }
        let p = self.p;
        let mut ceiling = 0.0f64;
        for k in 0..self.pair_i.len() {
            let d = self.pair_d[k];
            if !(d > SUCCESS_DEPTH) {
                continue;
            }
            let key = self.pair_i[k] as usize * p + self.pair_j[k] as usize;
            let w = self.pair_weight[key] * (low + (growth - low) * d / deepest);
            self.pair_weight[key] = w;
            ceiling = ceiling.max(w);
            self.stamp[key] = self.stamp_value;
            if !self.active_pair_flag[key] {
                self.active_pair_flag[key] = true;
                self.active_pairs.push(key as u32);
            }
        }
        let mut k = 0;
        while k < self.active_pairs.len() {
            let key = self.active_pairs[k] as usize;
            if self.stamp[key] == self.stamp_value {
                k += 1;
                continue;
            }
            let w = (self.pair_weight[key] * decay).max(1.0);
            self.pair_weight[key] = w;
            if w == 1.0 {
                self.active_pair_flag[key] = false;
                self.active_pairs.swap_remove(k);
            } else {
                k += 1;
            }
        }
        for i in 0..p {
            let d = self.wall_depth[i];
            if d > SUCCESS_DEPTH {
                let w = self.wall_weight[i] * (low + (growth - low) * d / deepest);
                self.wall_weight[i] = w;
                ceiling = ceiling.max(w);
                self.active_walls[i] = true;
            } else if self.active_walls[i] {
                let w = (self.wall_weight[i] * decay).max(1.0);
                self.wall_weight[i] = w;
                if w == 1.0 {
                    self.active_walls[i] = false;
                }
            }
        }
        if ceiling > WEIGHT_CEILING {
            // only ratios matter to the search; keep the numbers finite
            let f = 1.0 / ceiling.sqrt();
            for &key in &self.active_pairs {
                self.pair_weight[key as usize] = (self.pair_weight[key as usize] * f).max(1.0);
            }
            for i in 0..p {
                if self.active_walls[i] {
                    self.wall_weight[i] = (self.wall_weight[i] * f).max(1.0);
                }
            }
        }
    }

    /// Weighted loss of piece i placed at `pose` (normals in trial_axes or cand_axes) against
    /// the others at their current poses and the walls; stops early once it reaches `cutoff`.
    fn piece_loss(&mut self, i: usize, pose: Pose, trial: bool, cutoff: f64) -> f64 {
        let wl = self.kernel.walls(pose.x, pose.y, pose.theta, self.size, false);
        self.work += self.wall_cost;
        let mut loss = self.wall_weight[i] * wl.sum;
        if loss >= cutoff {
            return loss;
        }
        let reach2 = 4.0 * self.big_r * self.big_r;
        let c = self.cell_index(pose.x, pose.y) as i64;
        let g = self.g;
        let (cx, cy) = (c % g, c / g);
        let nn = self.nn;
        let p = self.p;
        let axes = if trial { &self.trial_axes } else { &self.cand_axes };
        let mut tests = 0.0;
        for gy in (cy - 1).max(0)..=(cy + 1).min(g - 1) {
            for gx in (cx - 1).max(0)..=(cx + 1).min(g - 1) {
                let mut j = self.head[(gy * g + gx) as usize];
                while j >= 0 {
                    let ju = j as usize;
                    j = self.next[ju];
                    if ju == i {
                        continue;
                    }
                    let q = self.poses[ju];
                    let dx = pose.x - q.x;
                    let dy = pose.y - q.y;
                    if dx * dx + dy * dy > reach2 {
                        continue;
                    }
                    tests += 1.0;
                    let d = self.kernel.depth(pose.x, pose.y, pose.theta, axes, q.x, q.y, q.theta, &self.axes[2 * nn * ju..2 * nn * (ju + 1)]);
                    if !(d > 0.0) {
                        continue;
                    }
                    let key = if i < ju { i * p + ju } else { ju * p + i };
                    loss += self.pair_weight[key] * d * d;
                    if loss >= cutoff {
                        self.work += tests * self.pair_cost;
                        return loss;
                    }
                }
            }
        }
        self.work += tests * self.pair_cost;
        loss
    }

    /// Weighted loss of piece i at `pose` (normals in cand_axes) and its gradient (piece_grad).
    fn piece_gradient(&mut self, i: usize, pose: Pose) -> f64 {
        let wl = self.kernel.walls(pose.x, pose.y, pose.theta, self.size, true);
        self.work += self.wall_cost;
        let v = self.wall_weight[i];
        let mut loss = v * wl.sum;
        let mut g = [v * wl.wx, v * wl.wy, v * wl.wt];
        let reach2 = 4.0 * self.big_r * self.big_r;
        let c = self.cell_index(pose.x, pose.y) as i64;
        let gg = self.g;
        let (cx, cy) = (c % gg, c / gg);
        let nn = self.nn;
        let p = self.p;
        let mut tests = 0.0;
        for gy in (cy - 1).max(0)..=(cy + 1).min(gg - 1) {
            for gx in (cx - 1).max(0)..=(cx + 1).min(gg - 1) {
                let mut j = self.head[(gy * gg + gx) as usize];
                while j >= 0 {
                    let ju = j as usize;
                    j = self.next[ju];
                    if ju == i {
                        continue;
                    }
                    let q = self.poses[ju];
                    let dx = pose.x - q.x;
                    let dy = pose.y - q.y;
                    if dx * dx + dy * dy > reach2 {
                        continue;
                    }
                    tests += 1.0;
                    let mut gr = [0.0f64; 6];
                    let d = self.kernel.depth_gradient(pose.x, pose.y, pose.theta, &self.cand_axes, q.x, q.y, q.theta, &self.axes[2 * nn * ju..2 * nn * (ju + 1)], &mut gr);
                    if !(d > 0.0) {
                        continue;
                    }
                    let key = if i < ju { i * p + ju } else { ju * p + i };
                    let w = self.pair_weight[key];
                    loss += w * d * d;
                    g[0] += 2.0 * w * d * gr[0];
                    g[1] += 2.0 * w * d * gr[1];
                    g[2] += 2.0 * w * d * gr[2];
                }
            }
        }
        self.work += tests * self.pair_cost;
        self.piece_grad = g;
        loss
    }

    /// Uniform centre inside the container, at least the piece inradius from every wall.
    fn sample_centre(&self, rng: &mut Rng) -> (f64, f64) {
        let s = self.size;
        if self.m == 0 {
            let radius = (self.apothem * s - self.rin).max(0.0) * rng.next().sqrt();
            let angle = 2.0 * PI * rng.next();
            return (radius * angle.cos(), radius * angle.sin());
        }
        let limit = (self.apothem * s - self.rin).max(0.0);
        let half = limit / (PI / self.m as f64).cos();
        // rejection from the bounding square of the shrunken polygon; acceptance above 0.4
        for _ in 0..64 {
            let x = (2.0 * rng.next() - 1.0) * half;
            let y = (2.0 * rng.next() - 1.0) * half;
            let mut inside = true;
            for k in 0..self.m as usize {
                if x * self.kernel.wall_cos[k] + y * self.kernel.wall_sin[k] > limit {
                    inside = false;
                    break;
                }
            }
            if inside {
                return (x, y);
            }
        }
        (0.0, 0.0)
    }

    /// An angle for a sampled pose: interlocking angles first (an edge parallel to a wall, turned
    /// by a quarter period at a time; a random other piece's angle, or that turned by pi/N, the
    /// inverted neighbour that tiles with triangles; for a circular container, an edge facing the
    /// centre), then uniform ones.
    fn sample_angle(&self, i: usize, x: f64, y: f64, rng: &mut Rng) -> f64 {
        let (n, m, period) = (self.n, self.m, self.period);
        if n == 0 {
            return 0.0;
        }
        let u = rng.next();
        if u < 0.4 {
            let wall = if m == 0 { y.atan2(x) + PI / 2.0 } else { 2.0 * PI * (rng.next() * m as f64).floor() / m as f64 };
            return wall - PI - PI / n as f64 + (period / 4.0) * (rng.next() * 4.0).floor();
        }
        if u < 0.6 && self.p > 1 {
            let mut j = (rng.next() * (self.p - 1) as f64) as usize;
            if j >= i {
                j += 1;
            }
            return self.poses[j].theta + if rng.next() < 0.5 { 0.0 } else { PI / n as f64 };
        }
        if u < 0.7 {
            return self.poses[i].theta;
        }
        period * rng.next()
    }

    /// Short gradient descent of one piece's weighted loss from `pose`, in place; returns the loss.
    fn refine(&mut self, i: usize, pose: &mut Pose) -> f64 {
        let n = self.n;
        if n != 0 {
            self.kernel.normals(pose.theta, &mut self.cand_axes);
        }
        let mut loss = self.piece_gradient(i, *pose);
        let mut step = 0.0;
        for _ in 0..REFINE_STEPS {
            if !(loss > 0.0) {
                break;
            }
            let g = self.piece_grad;
            let norm = (g[0] * g[0] + g[1] * g[1] + (self.big_r * g[2]).powi(2)).sqrt();
            if !(norm > 0.0) {
                break;
            }
            // the first step moves the piece by a tenth of its bounding radius
            if step == 0.0 {
                step = 0.1 * self.big_r / norm;
            }
            let mut accepted = None;
            for _line in 0..12 {
                let trial = Pose::new(pose.x - step * g[0], pose.y - step * g[1], pose.theta - step * g[2]);
                if n != 0 {
                    self.kernel.normals(trial.theta, &mut self.trial_axes);
                }
                if self.piece_loss(i, trial, true, loss) < loss {
                    accepted = Some(trial);
                    break;
                }
                step *= 0.35;
            }
            let Some(trial) = accepted else { break };
            *pose = trial;
            if n != 0 {
                self.kernel.normals(pose.theta, &mut self.cand_axes);
            }
            loss = self.piece_gradient(i, *pose);
            step *= 2.0;
        }
        loss
    }

    /// Relocate piece i: sample poses across the container and near its current and best poses,
    /// keep the one of least weighted loss, refine it, and move the piece there if that lowers
    /// its loss.
    fn relocate(&mut self, i: usize, rng: &mut Rng) -> bool {
        let n = self.n;
        let nn = self.nn;
        let current = self.poses[i];
        self.cand_axes.copy_from_slice(&self.axes[2 * nn * i..2 * nn * (i + 1)]);
        let current_loss = self.piece_loss(i, current, false, f64::INFINITY);
        if current_loss == 0.0 {
            return false;
        }
        let mut best = current;
        let mut best_loss = current_loss;
        let mut k = 0;
        while k < self.settings.global_samples && best_loss > 0.0 {
            let (x, y) = self.sample_centre(rng);
            let theta = self.sample_angle(i, x, y, rng);
            let cand = Pose::new(x, y, theta);
            if n != 0 {
                self.kernel.normals(cand.theta, &mut self.cand_axes);
            }
            let loss = self.piece_loss(i, cand, false, best_loss);
            if loss < best_loss {
                best_loss = loss;
                best = cand;
            }
            k += 1;
        }
        // local samples alternate between the current pose and the best found so far
        let sigma = 0.3 * self.big_r;
        let mut k = 0;
        while k < self.settings.local_samples && best_loss > 0.0 {
            let base = if k % 2 == 0 { current } else { best };
            let scale = sigma * if rng.next() < 0.5 { 1.0 } else { 0.2 };
            let x = base.x + scale * rng.gaussian();
            let y = base.y + scale * rng.gaussian();
            let theta = if rng.next() < 0.25 { self.sample_angle(i, x, y, rng) } else { base.theta + 0.15 * rng.gaussian() };
            let cand = Pose::new(x, y, theta);
            if n != 0 {
                self.kernel.normals(cand.theta, &mut self.cand_axes);
            }
            let loss = self.piece_loss(i, cand, false, best_loss);
            if loss < best_loss {
                best_loss = loss;
                best = cand;
            }
            k += 1;
        }
        let refined = self.refine(i, &mut best);
        if !(refined < current_loss) {
            return false;
        }
        self.place(i, best);
        true
    }

    /// Move piece i to a uniformly random pose in the container (a disruption).
    fn scatter_piece(&mut self, i: usize, rng: &mut Rng) {
        let (x, y) = self.sample_centre(rng);
        let theta = if self.n == 0 { 0.0 } else { self.period * rng.next() };
        self.place(i, Pose::new(x, y, theta));
    }

    /// Ruin a region: the `count` pieces nearest a random piece are scattered over the disk they
    /// occupied, or turned rigidly together about their mean centre by a random angle (keeping
    /// the block's internal contacts and tilting it as a whole).
    fn ruin(&mut self, count: usize, rng: &mut Rng) {
        let p = self.p;
        let k = count.clamp(1, p);
        let centre = self.poses[(rng.next() * p as f64) as usize];
        let dist = |q: &Pose| (q.x - centre.x).hypot(q.y - centre.y);
        let mut order: Vec<usize> = (0..p).collect();
        order.sort_by(|&a, &b| dist(&self.poses[a]).partial_cmp(&dist(&self.poses[b])).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b)));
        let chosen: Vec<usize> = order[..k].to_vec();
        let radius = dist(&self.poses[chosen[k - 1]]) + self.big_r;
        if rng.next() < 0.5 {
            let (mut mx, mut my) = (0.0, 0.0);
            for &i in &chosen {
                mx += self.poses[i].x / k as f64;
                my += self.poses[i].y / k as f64;
            }
            // a turn by up to half the symmetry period either way (any angle for disks)
            let alpha = (rng.next() - 0.5) * if self.n == 0 { 2.0 * PI } else { self.period };
            let (s, c) = alpha.sin_cos();
            for &i in &chosen {
                let q = self.poses[i];
                let (dx, dy) = (q.x - mx, q.y - my);
                self.place(i, Pose::new(mx + c * dx - s * dy, my + s * dx + c * dy, q.theta + alpha));
            }
            return;
        }
        for &i in &chosen {
            // uniform in the region's disk within the container (rejection, then anywhere inside)
            let mut cand = (0.0, 0.0);
            for _ in 0..32 {
                cand = self.sample_centre(rng);
                if (cand.0 - centre.x).hypot(cand.1 - centre.y) <= radius {
                    break;
                }
            }
            let theta = self.sample_angle(i, cand.0, cand.1, rng);
            self.place(i, Pose::new(cand.0, cand.1, theta));
        }
    }

    fn load_vector(&mut self, from_new: bool) {
        for i in 0..self.p {
            let v = if from_new { &self.x_new } else { &self.x };
            let (x, y, t) = (v[3 * i], v[3 * i + 1], v[3 * i + 2]);
            self.poses[i] = Pose::new(x, y, if self.n == 0 { 0.0 } else { t });
            self.refresh_axes(i);
        }
        self.rebuild_grid();
    }

    /// L-BFGS on the weighted objective over every pose with an Armijo backtracking line search,
    /// moves capped at a quarter bounding radius (and a quarter radian). Stops at the iteration
    /// limit, when feasible, or when no step decreases the objective; `pulse` runs after every
    /// iteration and returns false to stop. Leaves the state evaluated at its final poses.
    fn descend(&mut self, iterations: u32, ctx: &mut Ctx, run: &mut Run) -> bool {
        let p = self.p;
        let n3 = 3 * p;
        for i in 0..p {
            self.x[3 * i] = self.poses[i].x;
            self.x[3 * i + 1] = self.poses[i].y;
            self.x[3 * i + 2] = self.poses[i].theta;
        }
        let mut f = self.evaluate(true, false);
        let mut rho = [0.0f64; MEMORY];
        let mut alpha = [0.0f64; MEMORY];
        let mut stored = 0usize;
        let mut newest: usize = MEMORY - 1;
        let cap_move = 0.25 * self.big_r;
        let dot = |a: &[f64], b: &[f64]| -> f64 { a.iter().zip(b.iter()).map(|(x, y)| x * y).sum() };
        for _it in 0..iterations {
            if self.feasible() || !(f > 0.0) {
                break;
            }
            // two-loop recursion
            for k in 0..n3 {
                self.direction[k] = -self.gvec[k];
            }
            for mm in 0..stored {
                let h = (newest + MEMORY - mm) % MEMORY;
                alpha[h] = rho[h] * dot(&self.s_hist[h], &self.direction);
                let a = alpha[h];
                for (d, y) in self.direction.iter_mut().zip(self.y_hist[h].iter()) {
                    *d -= a * y;
                }
            }
            if stored > 0 {
                let h = newest;
                let gamma = dot(&self.s_hist[h], &self.y_hist[h]) / dot(&self.y_hist[h], &self.y_hist[h]);
                for d in self.direction.iter_mut() {
                    *d *= gamma;
                }
            }
            for mm in (0..stored).rev() {
                let h = (newest + MEMORY - mm) % MEMORY;
                let beta = rho[h] * dot(&self.y_hist[h], &self.direction);
                let c = alpha[h] - beta;
                for (d, s) in self.direction.iter_mut().zip(self.s_hist[h].iter()) {
                    *d += s * c;
                }
            }
            let mut slope = dot(&self.gvec, &self.direction);
            if !(slope < 0.0) {
                stored = 0;
                slope = 0.0;
                for k in 0..n3 {
                    self.direction[k] = -self.gvec[k];
                    slope -= self.gvec[k] * self.gvec[k];
                }
                if !(slope < 0.0) {
                    break;
                }
            }
            // cap the largest move
            let mut largest = 0.0f64;
            for i in 0..p {
                largest = largest.max(self.direction[3 * i].hypot(self.direction[3 * i + 1]) / cap_move);
                if self.n != 0 {
                    largest = largest.max(self.direction[3 * i + 2].abs() / 0.25);
                }
            }
            let mut step = if stored == 0 { 1f64.min(1.0 / largest.max(1e-300)) } else { 1.0 };
            if step * largest > 1.0 {
                step = 1.0 / largest;
            }
            let mut accepted = false;
            let mut f_new = f;
            for _line in 0..40 {
                for k in 0..n3 {
                    self.x_new[k] = self.x[k] + step * self.direction[k];
                }
                self.load_vector(true);
                f_new = self.evaluate(true, true);
                if f_new.is_finite() && f_new <= f + 1e-4 * step * slope && f_new < f {
                    accepted = true;
                    break;
                }
                step *= 0.5;
            }
            if !accepted {
                self.load_vector(false);
                self.evaluate(false, false);
                break;
            }
            // curvature pair
            let slot = (newest + 1) % MEMORY;
            let (mut sy, mut ss, mut yy) = (0.0, 0.0, 0.0);
            for k in 0..n3 {
                let s = self.x_new[k] - self.x[k];
                let y = self.g_new[k] - self.gvec[k];
                self.s_hist[slot][k] = s;
                self.y_hist[slot][k] = y;
                sy += s * y;
                ss += s * s;
                yy += y * y;
            }
            if sy > 1e-12 * (ss * yy).sqrt() {
                rho[slot] = 1.0 / sy;
                newest = slot;
                stored = (stored + 1).min(MEMORY);
            }
            std::mem::swap(&mut self.x, &mut self.x_new);
            std::mem::swap(&mut self.gvec, &mut self.g_new);
            f = f_new;
            if !run.pulse(ctx, self) {
                return false;
            }
        }
        // keep angles in one period
        if self.n != 0 {
            for i in 0..p {
                self.poses[i].theta = self.wrap(self.poses[i].theta);
                self.refresh_axes(i);
            }
        }
        true
    }
}

/// Strict legalisation: no pair separation below zero. Scaling centres by f about any point moves
/// a penetrating pair apart along its deepest separating axis u by (f - 1)(c_b - c_a).u, and
/// (c_b - c_a).u >= 2r - d for regular polygons of inradius r penetrating by d (a regular polygon
/// reaches at least r in every direction). So f = 1 + d / (2r - d), with a last-place margin,
/// separates every pair whose depth is below 2r; anything else goes to the bisected homothety and
/// the shared restoration.
pub fn legalise_strict(ctx: &mut Ctx, config: &Config, tester: &mut PairTester) -> Option<Config> {
    let deepest = tester.deepest(&config.pieces);
    if deepest == 0.0 {
        return Some(config.clone());
    }
    let r = piece_inradius(config.n);
    if deepest < r {
        let mut margin = 4e-12;
        for _ in 0..4 {
            let f = (1.0 + deepest / (2.0 * r - deepest)) * (1.0 + margin);
            let mut scaled = config.clone();
            for q in &mut scaled.pieces {
                q.x *= f;
                q.y *= f;
            }
            if !tester.any_below(&scaled.pieces, 0.0) {
                return Some(scaled);
            }
            margin *= 16.0;
        }
    }
    let contact = legalise(ctx, config, tester);
    if ctx.should_stop() {
        return None;
    }
    let base = contact.unwrap_or_else(|| config.clone());
    let legal = restore(ctx, &base, Strategy::Expand, true, MAX_COORD, tester, None)?;
    if tester.any_below(&legal.pieces, 0.0) {
        return None;
    }
    Some(legal)
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Outcome {
    Feasible,
    Failed,
    Stopped,
}

/// The method's own state: the best packing, the current one that compression and exploration
/// work on (the best, or since the last restart the descendant of a random start until it beats
/// the best), and the periodic assessments.
struct Run {
    best: Option<Vec<Pose>>,
    best_size: f64,
    current: Option<Vec<Pose>>,
    current_size: f64,
    since_assessment: f64,
    interval: f64,
    tester: PairTester,
}

impl Run {
    /// Legalise and score poses in the container frame; unless `insurance`, a result smaller than
    /// the current (or best) packing replaces it. Err(()) ends the method; Ok(None) when nothing
    /// valid was scored; otherwise the score and the poses re-centred on their container.
    fn assess(&mut self, ctx: &mut Ctx, pieces: &[Pose], insurance: bool) -> Result<Option<(f64, Vec<Pose>)>, ()> {
        if ctx.should_stop() {
            return Err(());
        }
        let config = Config { n: ctx.problem.n, m: ctx.problem.m, pieces: pieces.to_vec(), phi: 0.0 };
        let legal = legalise_strict(ctx, &config, &mut self.tester);
        if ctx.should_stop() {
            return Err(());
        }
        let Some(legal) = legal else { return Ok(None) };
        let Some(result) = ctx.evaluate(&legal, false) else { return Err(()) };
        if !result.valid {
            return Ok(None);
        }
        let score = result.score.unwrap();
        let c = result.container.unwrap();
        let centred: Vec<Pose> = legal.pieces.iter().map(|q| Pose::new(q.x - c.cx, q.y - c.cy, q.theta)).collect();
        if !insurance {
            if score < self.current_size {
                self.current = Some(centred.clone());
                self.current_size = score;
            }
            if score < self.best_size {
                self.best = Some(centred.clone());
                self.best_size = score;
            }
        }
        Ok(Some((score, centred)))
    }

    /// Called inside the repair after every unit of work: periodic assessments by counted work.
    fn pulse(&mut self, ctx: &mut Ctx, st: &mut RepairState) -> bool {
        if ctx.should_stop() {
            return false;
        }
        self.since_assessment += st.work;
        st.work = 0.0;
        if self.since_assessment >= self.interval {
            self.since_assessment = 0.0;
            let poses = st.poses.clone();
            if self.assess(ctx, &poses, false).is_err() {
                return false;
            }
        }
        true
    }

    /// Repair the loaded state at the current size.
    fn repair(&mut self, ctx: &mut Ctx, st: &mut RepairState, params: &Params, patience: u32) -> Outcome {
        if !st.descend(params.descent_iterations, ctx, self) {
            return Outcome::Stopped;
        }
        if st.feasible() {
            return Outcome::Feasible;
        }
        let mut least_raw = st.raw;
        let mut least = st.poses.clone();
        let limit = 4 * params.strikes * patience;
        let mut iterations = 0;
        for _strike in 0..params.strikes {
            if iterations >= limit {
                break;
            }
            let mut still = 0;
            while still < patience && iterations < limit {
                iterations += 1;
                let mut order = st.conflicting();
                shuffle(&mut order, ctx);
                for &i in &order {
                    st.relocate(i, &mut ctx.rng);
                    if !self.pulse(ctx, st) {
                        return Outcome::Stopped;
                    }
                }
                if !st.descend(params.descent_iterations, ctx, self) {
                    return Outcome::Stopped;
                }
                if st.feasible() {
                    return Outcome::Feasible;
                }
                if st.raw < least_raw * (1.0 - 1e-3) {
                    least_raw = st.raw;
                    least = st.poses.clone();
                    still = 0;
                } else {
                    still += 1;
                }
                st.update_weights();
            }
            // a strike restores the least overlapping state of this repair, keeping the weights
            st.load(&least);
            st.evaluate(false, false);
        }
        Outcome::Failed
    }

    /// Repair the loaded state at `size`, growing the container and the centres by `growth` after
    /// each failure, until a strict packing is scored; it becomes the current packing. False ends
    /// the method.
    fn settle(&mut self, ctx: &mut Ctx, st: &mut RepairState, params: &Params, mut size: f64, growth: f64) -> bool {
        for _attempt in 0..60 {
            st.set_size(size);
            st.reset_weights();
            let outcome = self.repair(ctx, st, params, params.explore_patience);
            if outcome == Outcome::Stopped {
                return false;
            }
            if outcome == Outcome::Feasible {
                let poses = st.poses.clone();
                match self.assess(ctx, &poses, false) {
                    Err(()) => return false,
                    Ok(Some((score, centred))) => {
                        self.current = Some(centred);
                        self.current_size = score;
                        return true;
                    }
                    Ok(None) => {}
                }
            }
            // a repair whose legalisation failed counts as a failure
            st.scale_centres(growth);
            size *= growth;
        }
        true
    }
}

pub fn execute(ctx: &mut Ctx) {
    let params: Params = match serde_json::from_value(ctx.params().clone()) {
        Ok(p) => p,
        Err(e) => return ctx.fail(e.to_string()),
    };
    if !ctx.checkpoint() {
        return;
    }
    let problem = ctx.problem;
    let (n, m, p) = (problem.n, problem.m, problem.p);
    let r0 = params.shrink_ratio;
    let r_min = params.min_shrink_ratio.min(r0);
    let r_max = params.max_shrink_ratio.max(r0);
    let settings = Settings {
        global_samples: params.global_samples,
        local_samples: params.local_samples,
        weight_growth: params.weight_growth,
        weight_decay: params.weight_decay,
    };
    let mut state = RepairState::new(n, m, p, settings);
    let mut run = Run {
        best: None,
        best_size: f64::INFINITY,
        current: None,
        current_size: f64::INFINITY,
        since_assessment: 0.0,
        interval: params.evaluation_work * p as f64,
        tester: PairTester::new(n),
    };

    // until something valid has been scored a stop would leave no result: the jitter-free grid
    // (no seeded draw, no repair needed) is scored first
    if !ctx.initial_evaluation().map_or(false, |e| e.valid) && ctx.remaining().0 >= 2.0 {
        let grid = scatter(problem, || 0.5);
        if run.assess(ctx, &adopt(&grid).0, true).is_err() {
            return;
        }
    }
    let random = params.start == "random";
    let mut initial: Option<Config> = None;
    if !random {
        if let Some(s) = ctx.start() {
            if s.pieces.len() == p {
                initial = Some(s.clone());
            }
        }
    }
    if !random && initial.is_none() {
        let remaining = ctx.remaining().0;
        let slice = remaining.min(3f64.max(24f64.min((remaining / 10.0).floor())));
        let seeded = ctx.run(crate::methods::Method::Seed, &serde_json::json!({"kind": "auto", "poolLimit": 0}), None, Some(slice as u64), None);
        initial = seeded.found.or(seeded.best);
        if ctx.should_stop() {
            return;
        }
        if initial.as_ref().map_or(false, |c| c.pieces.len() != p) {
            initial = None;
        }
    }

    let size;
    let mut settled = false;
    if let Some(init) = &initial {
        let (pieces, s) = adopt(init);
        state.load(&pieces);
        size = s;
        if !run.tester.any_below(&init.pieces, 0.0) {
            // a strict start is the packing to shrink from; the framework (or the seed) scored it
            run.best = Some(state.poses.clone());
            run.current = Some(state.poses.clone());
            run.best_size = size;
            run.current_size = size;
            settled = true;
        }
    } else {
        // random poses in a container 30% larger than the area bound, repaired before shrinking
        size = 1.3 * area_lower_bound(n, m, p);
        state.set_size(size);
        for i in 0..p {
            state.scatter_piece(i, &mut ctx.rng);
        }
    }
    // an invalid or random start is repaired at its own size, growing 5% after each failure
    if !settled && !run.settle(ctx, &mut state, &params, size, 1.05) {
        return;
    }
    if run.best.is_none() || run.current.is_none() {
        return;
    }

    // Compression: shrink the current packing by `ratio`, which grows after a success and halves
    // after a failure. Below its minimum the search is at the floor of the basin and explores:
    // targets 1 to 4 minimum ratios below, each from the current packing with a ruined region of
    // a log-uniform number of pieces. After `restartAfter` failed explorations in a row, random
    // poses are repaired at a container `restartSlack` larger than the best.
    let mut ratio = r0;
    let mut exploring = false;
    let mut stale = 0;
    while !ctx.should_stop() {
        if !ctx.checkpoint() {
            return;
        }
        if params.restart_after > 0 && stale >= params.restart_after {
            stale = 0;
            exploring = false;
            ratio = r0;
            let restart_size = run.best_size * (1.0 + params.restart_slack);
            state.set_size(restart_size);
            for i in 0..p {
                state.scatter_piece(i, &mut ctx.rng);
            }
            // the restart's packing replaces the current one even when it is worse
            run.current_size = f64::INFINITY;
            let kept = run.current.clone();
            if !run.settle(ctx, &mut state, &params, restart_size, 1.02) {
                return;
            }
            if run.current_size == f64::INFINITY {
                run.current = kept;
                run.current_size = run.best_size;
            }
            continue;
        }
        let r = if exploring { r_min * (1.0 + 3.0 * ctx.rng.next()) } else { ratio };
        let from = run.current_size;
        let target = from * (1.0 - r);
        let current = run.current.clone().unwrap();
        state.load(&current);
        state.set_size(target);
        state.scale_centres(1.0 - r);
        state.reset_weights();
        if exploring {
            let count = (params.max_ruin * p as f64).max(1.0).powf(ctx.rng.next()).round().max(1.0) as usize;
            state.ruin(count, &mut ctx.rng);
        }
        let patience = if exploring { params.explore_patience } else { params.patience };
        let outcome = run.repair(ctx, &mut state, &params, patience);
        if outcome == Outcome::Stopped {
            return;
        }
        if outcome == Outcome::Feasible {
            let poses = state.poses.clone();
            if run.assess(ctx, &poses, false).is_err() {
                return;
            }
        }
        // the current packing may also have improved through a periodic assessment
        if run.current_size < from {
            ratio = if exploring { ratio.max(2.0 * r) } else { r_max.min(ratio * 1.25) };
            exploring = false;
            stale = 0;
        } else if !exploring {
            ratio *= 0.5;
            if ratio < r_min {
                ratio = r_min;
                exploring = true;
            }
        } else {
            stale += 1;
        }
    }
}
