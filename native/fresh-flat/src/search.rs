//! The search: monotonic basin hopping on the pressure-penalty objective of [`crate::model`], with
//! restarts, a pressure ladder to polish candidates, and an exact repair before the check.

use crate::geom::{min_separation, Shape};
use crate::lattice::{lattices, Lattice};
use crate::lbfgs::Lbfgs;
use crate::model::{sh_unit, Model, Sol, OCTAGON_R};
use crate::rng::Rng;
use polypack_flat::clock::thread_cpu_seconds;
use polypack_flat::shapes::{Config, Pose, Problem};
use polypack_flat::validate::server_check;
use std::f64::consts::PI;

pub struct Params {
    /// Pressure while exploring.
    pub w_explore: f64,
    /// Smallest pressure of the polish ladder.
    pub w_final: f64,
    /// Failed perturbations before a restart.
    pub max_fails: usize,
    /// Share of starts taken from a periodic arrangement.
    pub p_lattice: f64,
    /// Pressure factor between polish stages.
    pub ladder: f64,
    /// Pressure at which a new best is first checked.
    pub w_quick: f64,
    /// Largest share of the time spent polishing before candidates wait.
    pub polish_share: f64,
    /// Probability that a relocated piece goes to the roomiest of several sampled points.
    pub p_hole: f64,
    /// Gradient tolerance of a hop, relative to the pressure.
    pub hop_gtol: f64,
    /// Probability that an epoch restarts near the best packing instead of from scratch.
    pub p_elite: f64,
    /// Choose the kind of fresh start by the results of earlier epochs.
    pub adaptive: bool,
    /// Turns and shifts of a periodic arrangement compared per lattice start.
    pub lat_cands: usize,
    /// Relative frequencies of the perturbations: shake all, relocate, shake a neighbourhood, turn,
    /// turn over, copy a neighbour's orientation (disks use the first three).
    pub move_w: [f64; 6],
    /// L-BFGS memory.
    pub memory: usize,
    /// Extra moves per perturbation at the end of an epoch (0: always one move).
    pub vns: usize,
    /// Iteration at which a hop is checked for giving up (0: never), and the margin over the current
    /// packing's G / w beyond which it is.
    pub abort_it: u64,
    pub abort_margin: f64,
    /// Relative window above the best soft size within which a hop's result is polished too.
    pub near_window: f64,
}

impl Params {
    /// Tuning overrides from the environment (development only): FRESH_W, FRESH_FAILS, FRESH_LAT.
    pub fn with_env(mut self) -> Params {
        if let Some(v) = std::env::var("FRESH_W").ok().and_then(|v| v.parse().ok()) {
            self.w_explore = v;
        }
        if let Some(v) = std::env::var("FRESH_FAILS").ok().and_then(|v| v.parse().ok()) {
            self.max_fails = v;
        }
        if let Some(v) = std::env::var("FRESH_LAT").ok().and_then(|v| v.parse().ok()) {
            self.p_lattice = v;
        }
        if let Some(v) = std::env::var("FRESH_WQ").ok().and_then(|v| v.parse().ok()) {
            self.w_quick = v;
        }
        if let Some(v) = std::env::var("FRESH_SHARE").ok().and_then(|v| v.parse().ok()) {
            self.polish_share = v;
        }
        if let Some(v) = std::env::var("FRESH_HOLE").ok().and_then(|v| v.parse().ok()) {
            self.p_hole = v;
        }
        if let Some(v) = std::env::var("FRESH_GTOL").ok().and_then(|v| v.parse().ok()) {
            self.hop_gtol = v;
        }
        if let Some(v) = std::env::var("FRESH_ELITE").ok().and_then(|v| v.parse().ok()) {
            self.p_elite = v;
        }
        if let Ok(v) = std::env::var("FRESH_ADAPT") {
            self.adaptive = v == "1";
        }
        if let Some(v) = std::env::var("FRESH_LATC").ok().and_then(|v| v.parse().ok()) {
            self.lat_cands = v;
        }
        if let Ok(v) = std::env::var("FRESH_MOVES") {
            for (k, x) in v.split(',').enumerate().take(6) {
                if let Ok(f) = x.parse() {
                    self.move_w[k] = f;
                }
            }
        }
        if let Some(v) = std::env::var("FRESH_MEM").ok().and_then(|v| v.parse().ok()) {
            self.memory = v;
        }
        if let Some(v) = std::env::var("FRESH_VNS").ok().and_then(|v| v.parse().ok()) {
            self.vns = v;
        }
        if let Some(v) = std::env::var("FRESH_ABORT_IT").ok().and_then(|v| v.parse().ok()) {
            self.abort_it = v;
        }
        if let Some(v) = std::env::var("FRESH_ABORT_M").ok().and_then(|v| v.parse().ok()) {
            self.abort_margin = v;
        }
        if let Some(v) = std::env::var("FRESH_NEAR").ok().and_then(|v| v.parse().ok()) {
            self.near_window = v;
        }
        self
    }

    pub fn for_problem(p: usize) -> Params {
        Params { w_explore: 3e-2, w_final: 1e-11, max_fails: 40 + 3 * p, p_lattice: 0.5, ladder: 1e-2, w_quick: 1e-5, polish_share: 0.25, p_hole: 0.5, hop_gtol: 1e-2, p_elite: 0.0, adaptive: false, lat_cands: 40, move_w: [1.0; 6], memory: 7, vns: 0, abort_it: 50, abort_margin: 0.02, near_window: 0.0 }
    }
}

pub struct Search<'a> {
    pub sh: Shape,
    pub p: usize,
    pub dim: usize,
    pub model: Model<'a>,
    lb: Lbfgs,
    pub rng: Rng,
    pub prm: Params,
    t0: f64,
    pub best_score: f64,
    pub best_q: Vec<f64>,
    pub trace: Vec<(f64, f64)>,
    pub checks: u64,
    pub starts: u64,
    pub hops: u64,
    best_explore: f64,
    cur: Sol,
    cand: Sol,
    pol: Sol,
    tmp_q: Vec<f64>,
    lattices: Vec<Lattice>,
    pub debug: bool,
    best_pol: Sol,
    deep_w: f64,
    deep_pending: bool,
    pending: Sol,
    has_pending: bool,
    polish_evals: u64,
    pub move_tries: [u64; 8],
    pub move_wins: [u64; 8],
    elite: Sol,
    elite_ok: bool,
    kind_best: [f64; 4],
    kind_runs: [u64; 4],
    patch_buf: Vec<(f64, [f64; 3])>,
    /// G / w of the current packing at the exploring pressure.
    cur_g: f64,
    pub aborts: u64,
    pub near_polishes: u64,
    /// Called with each checked improvement (score and the packing), in time order.
    pub on_improve: Option<&'a mut dyn FnMut(f64, &Config)>,
}

impl<'a> Search<'a> {
    pub fn new(n: usize, m: usize, p: usize, seed: u64, t0: f64) -> Search<'a> {
        let sh = Shape::new(n, m);
        let dim = if n == 0 { 2 } else { 3 };
        let mut prm = Params::for_problem(p).with_env();
        // the pressures were tuned for pieces of up to 8 sides in containers of up to 8: a piece
        // larger than the octagon, or a container whose side is short against its apothem, scales
        // them so that the overlap they buy keeps its size relative to the pieces and the walls
        let unit = sh_unit(&sh) * (sh.big_r / OCTAGON_R).max(1.0);
        prm.w_explore *= unit;
        prm.w_quick *= unit;
        prm.w_final *= unit;
        let mut model = Model::new(sh.clone(), p);
        if let Some(v) = std::env::var("FRESH_SKIN").ok().and_then(|v| v.parse::<f64>().ok()) {
            model.skin = v * sh.big_r;
        }
        let poly = n > 0;
        Search {
            dim,
            model,
            lb: Lbfgs::new(prm.memory),
            rng: Rng::new(seed),
            prm,
            t0,
            best_score: f64::INFINITY,
            best_q: Vec::new(),
            trace: Vec::new(),
            checks: 0,
            starts: 0,
            hops: 0,
            best_explore: f64::INFINITY,
            cur: Sol::new(p, dim, poly),
            cand: Sol::new(p, dim, poly),
            pol: Sol::new(p, dim, poly),
            tmp_q: vec![0.0; dim * p],
            lattices: lattices(&sh),
            debug: std::env::var("FRESH_DEBUG").is_ok(),
            best_pol: Sol::new(p, dim, poly),
            deep_w: 0.0,
            deep_pending: false,
            pending: Sol::new(p, dim, poly),
            has_pending: false,
            polish_evals: 0,
            move_tries: [0; 8],
            move_wins: [0; 8],
            elite: Sol::new(p, dim, poly),
            elite_ok: false,
            kind_best: [f64::INFINITY; 4],
            kind_runs: [0; 4],
            patch_buf: Vec::new(),
            cur_g: f64::INFINITY,
            aborts: 0,
            near_polishes: 0,
            on_improve: None,
            sh,
            p,
        }
    }

    fn done(&self) -> bool {
        self.model.exhausted
    }

    pub fn run(&mut self) {
        while !self.done() {
            let mut cur = std::mem::replace(&mut self.cur, Sol::new(0, 0, false));
            let e0 = self.model.evals;
            let kind = if self.elite_ok && self.starts >= 2 && self.rng.chance(self.prm.p_elite) {
                // restart near the best packing so far: a hard shake and a few pieces moved to holes
                cur.copy_from(&self.elite);
                let amp = 0.2 + 0.3 * self.rng.uniform();
                let k = 1 + self.p / 8;
                self.shake_all(&mut cur, amp);
                for _ in 0..k {
                    self.apply_move(&mut cur, 1);
                }
                let w = self.prm.w_explore;
                self.model.local_min(&mut self.lb, &mut cur, w, 20000, w * 1e-2, true);
                3
            } else {
                let k = self.pick_start_kind();
                self.new_start(&mut cur, k)
            };
            self.starts += 1;
            if self.debug {
                eprintln!("start {} kind {} s {:.6} evals {} t {:.3}", self.starts, kind, cur.s, self.model.evals - e0, thread_cpu_seconds() - self.t0);
            }
            if self.done() {
                self.cur = cur;
                break;
            }
            self.cur_g = cur.s + self.model.last_e / self.prm.w_explore;
            self.consider(&cur);
            let mut cand = std::mem::replace(&mut self.cand, Sol::new(0, 0, false));
            let mut fails = 0;
            while fails < self.prm.max_fails && !self.done() {
                if (self.deep_pending || self.has_pending) && self.near_end() {
                    self.deep_polish();
                } else if self.has_pending {
                    self.flush(false);
                }
                cand.copy_from(&cur);
                let kind = self.perturb(&mut cand);
                self.move_tries[kind] += 1;
                if self.prm.vns > 0 {
                    // more moves at once as failures accumulate
                    let extra = fails * self.prm.vns / self.prm.max_fails.max(1);
                    for _ in 0..extra {
                        self.perturb(&mut cand);
                    }
                }
                let w = self.prm.w_explore;
                // a hop whose G / w is still far above the current packing's after `abort_it`
                // iterations is given up (G only decreases, but slowly at the end)
                if self.prm.abort_it > 0 {
                    self.model.abort_it = self.prm.abort_it;
                    self.model.abort_level = self.cur_g * (1.0 + self.prm.abort_margin);
                }
                self.model.trace_hop = self.debug;
                self.model.local_min(&mut self.lb, &mut cand, w, 3000, w * self.prm.hop_gtol, true);
                self.model.abort_it = 0;
                self.hops += 1;
                if self.done() {
                    break;
                }
                if self.debug {
                    let m = self.model.hop_marks;
                    eprintln!("    hopdat {:.6} {:.6} {:.6} {:.6} {:.6} {} {}", m[0] / cur.s - 1.0, m[1] / cur.s - 1.0, m[2] / cur.s - 1.0, cand.s / cur.s - 1.0, self.cur_g / cur.s - 1.0, self.model.hop_it, self.model.aborted as u8);
                }
                if self.model.aborted {
                    self.aborts += 1;
                    fails += 1;
                    continue;
                }
                if cand.s < cur.s * (1.0 - 1e-12) {
                    if self.debug {
                        eprintln!("  hop {} -> {:.6} (fails {})", self.hops, cand.s, fails);
                    }
                    self.move_wins[kind] += 1;
                    self.cur_g = cand.s + self.model.last_e / w;
                    std::mem::swap(&mut cur, &mut cand);
                    fails = 0;
                    self.consider(&cur);
                } else {
                    fails += 1;
                    // near ties at the soft pressure can rank either way once hard: polish a hop that
                    // ends within a small window above the best soft size (not the current packing again)
                    if self.prm.near_window > 0.0
                        && cand.s < self.best_explore * (1.0 + self.prm.near_window)
                        && (cand.s - cur.s).abs() > 1e-7 * cur.s
                        && self.polish_evals as f64 <= self.prm.polish_share * self.model.evals as f64
                    {
                        self.near_polish(&cand);
                    }
                }
            }
            if cur.s < self.kind_best[kind] {
                self.kind_best[kind] = cur.s;
            }
            self.kind_runs[kind] += 1;
            if self.debug {
                eprintln!("epoch end kind {} s {:.6} t {:.3}", kind, cur.s, thread_cpu_seconds() - self.t0);
            }
            self.cand = cand;
            self.cur = cur;
            self.deep_polish();
        }
    }

    /// The kind of the next fresh start: each kind once, then mostly the one whose epochs ended best.
    fn pick_start_kind(&mut self) -> usize {
        if !self.prm.adaptive {
            let roll = self.rng.uniform();
            return if roll < self.prm.p_lattice { 2 } else if roll < 0.5 + 0.5 * self.prm.p_lattice { 1 } else { 0 };
        }
        for k in [2usize, 1, 0] {
            if self.kind_runs[k] == 0 {
                return k;
            }
        }
        if self.rng.chance(0.3) {
            return self.rng.below(3);
        }
        let mut best = 2;
        for k in [1usize, 0] {
            if self.kind_best[k] < self.kind_best[best] {
                best = k;
            }
        }
        best
    }

    fn shake_all(&mut self, sol: &mut Sol, amp_r: f64) {
        let amp = amp_r * self.sh.big_r;
        let turn = self.dim == 3 && self.rng.chance(0.5);
        for i in 0..self.p {
            sol.q[self.dim * i] += amp * self.rng.signed();
            sol.q[self.dim * i + 1] += amp * self.rng.signed();
            if turn {
                sol.q[3 * i + 2] += 0.5 * amp_r * self.rng.signed();
            }
        }
    }

    /// A fresh start, minimised at the exploring pressure.
    fn new_start(&mut self, sol: &mut Sol, kind: usize) -> usize {
        let p = self.p;
        let dim = self.dim;
        let r = self.sh.big_r;
        let s0 = self.sh.area_bound(p) * 1.45;
        if kind < 2 {
            let sh = &self.sh;
            let lim = s0 - r / sh.k_in;
            let ext = s0 * sh.k_out;
            let aligned = -PI - if sh.n > 0 { PI / sh.n as f64 } else { 0.0 };
            for i in 0..p {
                loop {
                    let x = ext * self.rng.signed();
                    let y = ext * self.rng.signed();
                    if sh.gauge(x, y) <= lim {
                        sol.q[dim * i] = x;
                        sol.q[dim * i + 1] = y;
                        break;
                    }
                }
                if dim == 3 {
                    sol.q[3 * i + 2] = if kind == 0 {
                        self.rng.uniform() * sh.period
                    } else if sh.n % 2 == 1 && self.rng.chance(0.5) {
                        aligned + PI / sh.n as f64
                    } else {
                        aligned
                    };
                }
            }
        } else {
            self.lattice_start(sol);
        }
        for v in sol.lines.iter_mut() {
            *v = 0.0;
        }
        let w = self.prm.w_explore;
        self.model.local_min(&mut self.lb, sol, w, 20000, w * 1e-2, true);
        kind
    }

    /// P pieces of a periodic arrangement: of several random turns and shifts of the arrangement, one
    /// of those whose P best-placed pieces fit the smallest container (centred at the origin).
    fn lattice_start(&mut self, sol: &mut Sol) {
        let nl = self.lattices.len();
        // the densest arrangement most often
        let li = if nl == 1 || self.rng.chance(0.5) { 0 } else { self.rng.below(nl.min(3)) };
        let lat = self.lattices[li].clone();
        let m = self.sh.m;
        let mut top: [(f64, f64, f64, f64); 3] = [(f64::INFINITY, 0.0, 0.0, 0.0); 3];
        let mut buf = std::mem::take(&mut self.patch_buf);
        for _ in 0..self.prm.lat_cands.max(1) {
            let turn = if m > 0 && self.rng.chance(0.7) {
                self.rng.below(4) as f64 * PI / (2.0 * m as f64)
            } else {
                self.rng.uniform() * 2.0 * PI
            };
            let ox = self.rng.uniform() * lat.period;
            let oy = self.rng.uniform() * lat.shift[1];
            let fit = self.patch(&lat, turn, ox, oy, &mut buf);
            if fit < top[2].0 {
                top[2] = (fit, turn, ox, oy);
                top.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            }
        }
        let pick = if self.rng.chance(0.5) || !top[1].0.is_finite() { 0 } else { 1 + self.rng.below(if top[2].0.is_finite() { 2 } else { 1 }) };
        let (_, turn, ox, oy) = top[pick];
        self.patch(&lat, turn, ox, oy, &mut buf);
        let dim = self.dim;
        for i in 0..self.p {
            let c = buf[i].1;
            sol.q[dim * i] = c[0];
            sol.q[dim * i + 1] = c[1];
            if dim == 3 {
                sol.q[3 * i + 2] = c[2];
            }
        }
        self.patch_buf = buf;
    }

    /// The arrangement turned by `turn` about the shift (ox, oy): its pieces near the origin with the
    /// container size each needs, the P smallest first in `buf`; returns the P-th smallest.
    fn patch(&self, lat: &Lattice, turn: f64, ox: f64, oy: f64, buf: &mut Vec<(f64, [f64; 3])>) -> f64 {
        let p = self.p;
        let sh = &self.sh;
        let (sn, cs) = turn.sin_cos();
        let ne = lat.motif.len();
        let extent = 1.4 * sh.area_bound(p) * sh.k_out + 2.0 * sh.big_r;
        let rows = (extent / lat.shift[1]).ceil() as i64 + 2;
        let cols = (extent / lat.period).ceil() as i64 + 2;
        buf.clear();
        for j in -rows..=rows {
            let kshift = (j as f64 * lat.shift[0] / lat.period).round() as i64;
            for k in -cols - kshift..=cols - kshift {
                for e in 0..ne {
                    let c = lat.piece(j, k, e);
                    let lx = c[0] - ox;
                    let ly = c[1] - oy;
                    let x = cs * lx - sn * ly;
                    let y = sn * lx + cs * ly;
                    if x.abs() > extent || y.abs() > extent {
                        continue;
                    }
                    let g = sh.piece_gauge(x, y, c[2] + turn);
                    buf.push((g, [x, y, c[2] + turn]));
                }
            }
        }
        if buf.len() < p {
            return f64::INFINITY;
        }
        buf.select_nth_unstable_by(p - 1, |a, b| a.0.partial_cmp(&b.0).unwrap());
        buf[p - 1].0
    }

    fn perturb(&mut self, sol: &mut Sol) -> usize {
        let nk = if self.dim == 3 { 6 } else { 3 };
        let total: f64 = self.prm.move_w[..nk].iter().sum();
        let mut x = self.rng.uniform() * total;
        let mut kind = nk - 1;
        for k in 0..nk {
            if x < self.prm.move_w[k] {
                kind = k;
                break;
            }
            x -= self.prm.move_w[k];
        }
        self.apply_move(sol, kind)
    }

    fn apply_move(&mut self, sol: &mut Sol, kind: usize) -> usize {
        let p = self.p;
        let dim = self.dim;
        let r = self.sh.big_r;
        let period = self.sh.period;
        match kind {
            0 => {
                // shake every piece
                let amp = r * (0.05 + 0.35 * self.rng.uniform());
                let turn = self.rng.chance(0.5);
                for i in 0..p {
                    sol.q[dim * i] += amp * self.rng.signed();
                    sol.q[dim * i + 1] += amp * self.rng.signed();
                    if dim == 3 && turn {
                        sol.q[3 * i + 2] += 0.5 * amp / r * self.rng.signed();
                    }
                }
            }
            1 => {
                // move one piece somewhere else in the container: a random point, or the roomiest of
                // a few (room: half the distance to the nearest other centre, or the wall distance)
                let i = self.rng.below(p);
                let lim = sol.s - r / self.sh.k_in;
                let ext = sol.s * self.sh.k_out;
                let tries = if self.rng.chance(self.prm.p_hole) { 24 } else { 1 };
                let mut best = (f64::NEG_INFINITY, sol.q[dim * i], sol.q[dim * i + 1]);
                let mut got = 0;
                for _ in 0..1000 {
                    let x = ext * self.rng.signed();
                    let y = ext * self.rng.signed();
                    let g = self.sh.gauge(x, y);
                    if g > lim {
                        continue;
                    }
                    let mut room = (sol.s - g) * self.sh.k_in;
                    if tries > 1 {
                        for j in 0..p {
                            if j != i {
                                let dx = sol.q[dim * j] - x;
                                let dy = sol.q[dim * j + 1] - y;
                                room = room.min(0.5 * (dx * dx + dy * dy).sqrt());
                            }
                        }
                    }
                    if room > best.0 {
                        best = (room, x, y);
                    }
                    got += 1;
                    if got >= tries {
                        break;
                    }
                }
                sol.q[dim * i] = best.1;
                sol.q[dim * i + 1] = best.2;
                if dim == 3 {
                    sol.q[3 * i + 2] = self.rng.uniform() * period;
                }
            }
            2 => {
                // shake the neighbourhood of one piece hard
                let c = self.rng.below(p);
                let (cx, cy) = (sol.q[dim * c], sol.q[dim * c + 1]);
                let rad = 3.0 * r;
                let amp = 0.6 * r;
                for i in 0..p {
                    let dx = sol.q[dim * i] - cx;
                    let dy = sol.q[dim * i + 1] - cy;
                    if dx * dx + dy * dy < rad * rad {
                        sol.q[dim * i] += amp * self.rng.signed();
                        sol.q[dim * i + 1] += amp * self.rng.signed();
                        if dim == 3 {
                            sol.q[3 * i + 2] += 0.5 * period * self.rng.signed();
                        }
                    }
                }
            }
            3 => {
                // turn one or two pieces
                let k = 1 + self.rng.below(2);
                for _ in 0..k {
                    let i = self.rng.below(p);
                    sol.q[3 * i + 2] += period * self.rng.uniform();
                }
            }
            4 => {
                // flip one piece by half a period (odd N: vertex up <-> vertex down)
                let i = self.rng.below(p);
                sol.q[3 * i + 2] += 0.5 * period;
            }
            _ => {
                // give a piece the orientation of its nearest neighbour (or its flip)
                let i = self.rng.below(p);
                let mut nb = i;
                let mut bd = f64::INFINITY;
                for j in 0..p {
                    if j != i {
                        let dx = sol.q[3 * j] - sol.q[3 * i];
                        let dy = sol.q[3 * j + 1] - sol.q[3 * i + 1];
                        let d = dx * dx + dy * dy + 1e-9 * self.rng.uniform();
                        if d < bd {
                            bd = d;
                            nb = j;
                        }
                    }
                }
                sol.q[3 * i + 2] = sol.q[3 * nb + 2] + if self.sh.n % 2 == 1 && self.rng.chance(0.5) { 0.5 * period } else { 0.0 };
            }
        }
        kind
    }

    /// A candidate that may beat the best: kept as pending, and polished now unless polishing has
    /// already taken its share of the time (then later, see `flush`).
    fn consider(&mut self, sol: &Sol) {
        if sol.s >= self.best_explore {
            return;
        }
        self.best_explore = sol.s;
        self.elite.copy_from(sol);
        self.elite_ok = true;
        self.pending.copy_from(sol);
        self.has_pending = true;
        self.flush(false);
    }

    /// Polishes the pending candidate (one stage at the quick pressure), repairs and checks it, and
    /// keeps it for the deep polish. Unless forced, waits while polishing exceeds its time share.
    fn flush(&mut self, force: bool) {
        if !self.has_pending || self.done() {
            return;
        }
        // the share is counted in evaluations, not time, so that runs with --evals repeat exactly
        let e0 = self.model.evals;
        if !force && self.polish_evals as f64 > self.prm.polish_share * e0 as f64 {
            return;
        }
        self.has_pending = false;
        let mut pol = std::mem::replace(&mut self.pol, Sol::new(0, 0, false));
        pol.copy_from(&self.pending);
        let w = self.prm.w_quick;
        self.model.local_min(&mut self.lb, &mut pol, w, 6000, w * 1e-3, false);
        let sc = self.finish(&pol.q);
        if self.debug {
            eprintln!("  polish {:.9} -> {:.9} -> {:?} t {:.3}", self.pending.s, pol.s, sc, thread_cpu_seconds() - self.t0);
        }
        if sc.is_some() && sc.unwrap() <= self.best_score {
            self.best_pol.copy_from(&pol);
            self.deep_w = w * self.prm.ladder;
            self.deep_pending = true;
        }
        self.pol = pol;
        self.polish_evals += self.model.evals - e0;
    }

    /// Polishes a near-tie candidate like a new best (it becomes the best only if its checked score is
    /// smaller).
    fn near_polish(&mut self, sol: &Sol) {
        let e0 = self.model.evals;
        let mut pol = std::mem::replace(&mut self.pol, Sol::new(0, 0, false));
        pol.copy_from(sol);
        let w = self.prm.w_quick;
        self.model.local_min(&mut self.lb, &mut pol, w, 6000, w * 1e-3, false);
        let before = self.best_score;
        let sc = self.finish(&pol.q);
        if let Some(v) = sc {
            if v < before {
                if self.debug {
                    eprintln!("  near tie wins: soft {:.9} -> {:.12}", sol.s, v);
                }
                self.best_pol.copy_from(&pol);
                self.deep_w = w * self.prm.ladder;
                self.deep_pending = true;
            }
        }
        self.pol = pol;
        self.near_polishes += 1;
        self.polish_evals += self.model.evals - e0;
    }

    /// Continues the pressure ladder on the best packing down to the final pressure.
    fn deep_polish(&mut self) {
        self.flush(true);
        if !self.deep_pending {
            return;
        }
        let e0 = self.model.evals;
        self.deep_pending = false;
        let mut pol = std::mem::replace(&mut self.pol, Sol::new(0, 0, false));
        pol.copy_from(&self.best_pol);
        let mut w = self.deep_w;
        while w >= self.prm.w_final * 0.999 && !self.done() {
            self.model.local_min(&mut self.lb, &mut pol, w, 4000, w * 1e-3, false);
            w *= self.prm.ladder;
        }
        let sc = self.finish(&pol.q);
        if self.debug {
            eprintln!("  deep polish -> {:.12} -> {:?} t {:.3}", pol.s, sc, thread_cpu_seconds() - self.t0);
        }
        self.pol = pol;
        self.polish_evals += self.model.evals - e0;
    }

    /// True when the budget left is only the reserve kept for the final deep polish.
    fn near_end(&self) -> bool {
        let md = &self.model;
        if md.eval_limit != u64::MAX {
            let reserve = (md.eval_limit as f64 * 0.03) as u64;
            if md.evals + reserve >= md.eval_limit {
                return true;
            }
        }
        if md.deadline.is_finite() {
            let total = md.deadline - self.t0;
            let reserve = (0.03 * total).clamp(0.02, 0.5);
            if thread_cpu_seconds() >= md.deadline - reserve {
                return true;
            }
        }
        false
    }

    /// Repairs the remaining overlap by spreading the centres about the container centre (separations
    /// never decrease under it), checks with the client's rule, and records an improvement.
    pub fn finish(&mut self, q: &[f64]) -> Option<f64> {
        let p = self.p;
        let dim = self.dim;
        let target = 1e-13;
        self.tmp_q.copy_from_slice(q);
        if dim == 3 {
            // angles in one period, as the check will see them (the separation is then computed
            // from the same small angles, and rounds as the check's does)
            for i in 0..p {
                self.tmp_q[3 * i + 2] = reduce(q[3 * i + 2], self.sh.period);
            }
        }
        let (ms, _, _) = min_separation(&self.sh, &self.tmp_q, p);
        if !(ms >= target) {
            let mut lam = (target - ms).max(1e-15) / (2.0 * self.sh.apo) * 1.5;
            let mut ok = false;
            for _ in 0..80 {
                for i in 0..p {
                    self.tmp_q[dim * i] = q[dim * i] * (1.0 + lam);
                    self.tmp_q[dim * i + 1] = q[dim * i + 1] * (1.0 + lam);
                }
                let (m2, _, _) = min_separation(&self.sh, &self.tmp_q, p);
                if m2 >= target {
                    ok = true;
                    break;
                }
                lam *= 2.0;
            }
            if !ok {
                return None;
            }
        }
        let cfg = self.config(&self.tmp_q.clone());
        self.checks += 1;
        let chk = server_check(&cfg, p);
        if chk.valid && chk.strict {
            if let Some(sc) = chk.score {
                if sc < self.best_score {
                    self.best_score = sc;
                    self.best_q = self.tmp_q.clone();
                    let t = thread_cpu_seconds() - self.t0;
                    self.trace.push((t, sc));
                    if let Some(cb) = self.on_improve.as_mut() {
                        cb(sc, &cfg);
                    }
                }
                return Some(sc);
            }
        }
        None
    }

    /// The submission form of a configuration: angles reduced to one period, phi = 0.
    pub fn config(&self, q: &[f64]) -> Config {
        let p = self.p;
        let dim = self.dim;
        let mut pieces = Vec::with_capacity(p);
        for i in 0..p {
            let th = if dim == 3 { reduce(q[3 * i + 2], self.sh.period) } else { 0.0 };
            pieces.push(Pose::new(q[dim * i], q[dim * i + 1], th));
        }
        Config::new(Problem::new(self.sh.n as u32, self.sh.m as u32, p), pieces, 0.0)
    }
}

/// x modulo period, in [0, period).
fn reduce(x: f64, period: f64) -> f64 {
    let t = x % period;
    if t < 0.0 {
        t + period
    } else {
        t
    }
}
