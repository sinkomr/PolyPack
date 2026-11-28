//! The search of one face problem: k pieces in the smallest scaled copy s Q of one face shape Q.
//!
//! Monotonic basin hopping on the pressure objective of [`crate::model`] in epochs, resumable in slices
//! (the scheduler of [`crate::search`] gives each face problem slices of evaluations in turn). An epoch
//! starts from random centres (random or edge-aligned angles), a patch of a periodic arrangement, the best
//! packing of this problem shaken, or a neighbouring problem's best packing with a piece added or taken away;
//! then it perturbs and re-minimises at the exploring pressure, keeping a result when its soft scale is
//! smaller, until 40 + 3k perturbations in a row have failed. A soft packing that beats the best soft scale
//! is polished down a pressure ladder, repaired exactly ([`crate::geom::repair`]) and kept as the problem's
//! best when its exact scale is smaller.

use crate::geom::{repair, Container, Packing, Piece};
use crate::lattice::{lattices, Lattice};
use crate::lbfgs::Lbfgs;
use crate::model::{Budget, Model, Sol};
use crate::rng::Rng;
use std::f64::consts::PI;

#[derive(Clone, Debug)]
pub struct Params {
    pub w_explore: f64,
    pub w_quick: f64,
    pub w_final: f64,
    pub ladder: f64,
    pub max_fails: usize,
    pub p_hole: f64,
    pub hop_gtol: f64,
    pub abort_it: u64,
    pub abort_margin: f64,
    pub polish_share: f64,
    pub lat_cands: usize,
    /// Start kinds: random, aligned, lattice, elite, neighbour.
    pub start_w: [f64; 5],
    /// Moves: shake all, relocate, shake a neighbourhood, turn, turn over, copy a neighbour's angle.
    pub move_w: [f64; 6],
}

impl Params {
    pub fn for_problem(k: usize) -> Params {
        let mut p = Params {
            w_explore: 3e-2,
            w_quick: 1e-5,
            w_final: 1e-11,
            ladder: 1e-2,
            max_fails: 40 + 3 * k,
            p_hole: 0.5,
            hop_gtol: 1e-2,
            abort_it: 50,
            abort_margin: 0.02,
            polish_share: 0.25,
            lat_cands: 40,
            start_w: [1.0, 1.0, 1.5, 1.0, 1.0],
            move_w: [1.0; 6],
        };
        if let Ok(v) = std::env::var("FSN_PARAMS") {
            for kv in v.split(',') {
                let mut it = kv.splitn(2, '=');
                let (Some(key), Some(val)) = (it.next(), it.next()) else { continue };
                let f: f64 = match val.parse() {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                match key {
                    "w" => p.w_explore = f,
                    "wq" => p.w_quick = f,
                    "fails" => p.max_fails = f as usize,
                    "fails_k" => p.max_fails = 40 + (f * k as f64) as usize,
                    "hole" => p.p_hole = f,
                    "gtol" => p.hop_gtol = f,
                    "abort_it" => p.abort_it = f as u64,
                    "abort_m" => p.abort_margin = f,
                    "share" => p.polish_share = f,
                    "latc" => p.lat_cands = f as usize,
                    "s_rand" => p.start_w[0] = f,
                    "s_align" => p.start_w[1] = f,
                    "s_lat" => p.start_w[2] = f,
                    "s_elite" => p.start_w[3] = f,
                    "s_nb" => p.start_w[4] = f,
                    _ => {}
                }
            }
        }
        p
    }
}

/// Best packings of the neighbouring problems (k - 1 and k + 1 pieces of the same face), site units.
#[derive(Default)]
pub struct Hints<'a> {
    pub fewer: Option<&'a Packing>,
    pub more: Option<&'a Packing>,
}

pub struct FaceSearch {
    pub k: usize,
    pub dim: usize,
    pub model: Model,
    lb: Lbfgs,
    pub rng: Rng,
    pub prm: Params,
    lats: Vec<Lattice>,
    in_epoch: bool,
    cur: Sol,
    cand: Sol,
    pol: Sol,
    fails: usize,
    cur_g: f64,
    best_explore: f64,
    pending: Sol,
    has_pending: bool,
    best_pol: Sol,
    deep_pending: bool,
    deep_w: f64,
    pub polish_evals: u64,
    pub own_evals: u64,
    /// The best packing found (site units), exact and repaired; None until one is found.
    pub best: Option<Packing>,
    /// Set when `best` improves; the scheduler clears it.
    pub improved: bool,
    pub starts: u64,
    pub hops: u64,
    pub epochs_since_best: u64,
    pub debug: bool,
    pub start_tries: [u64; 5],
    pub start_wins: [u64; 5],
    cur_kind: usize,
}

impl FaceSearch {
    pub fn new(pc: &Piece, ct: &Container, k: usize, seed: u64, lats: Vec<Lattice>) -> FaceSearch {
        let dim = if pc.n == 0 { 2 } else { 3 };
        let poly = pc.n > 0;
        let prm = Params::for_problem(k);
        FaceSearch {
            k,
            dim,
            model: Model::new(pc.clone(), ct.clone(), k),
            lb: Lbfgs::new(7),
            rng: Rng::new(seed),
            prm,
            lats,
            in_epoch: false,
            cur: Sol::new(k, dim, poly),
            cand: Sol::new(k, dim, poly),
            pol: Sol::new(k, dim, poly),
            fails: 0,
            cur_g: f64::INFINITY,
            best_explore: f64::INFINITY,
            pending: Sol::new(k, dim, poly),
            has_pending: false,
            best_pol: Sol::new(k, dim, poly),
            deep_pending: false,
            deep_w: 0.0,
            polish_evals: 0,
            own_evals: 0,
            best: None,
            improved: false,
            starts: 0,
            hops: 0,
            epochs_since_best: 0,
            debug: std::env::var("FSN_DEBUG").is_ok(),
            start_tries: [0; 5],
            start_wins: [0; 5],
            cur_kind: 0,
        }
    }

    fn pc(&self) -> &Piece {
        &self.model.pc
    }

    /// Offers a packing found elsewhere (site units, valid): kept if it beats the best.
    pub fn offer(&mut self, p: &Packing) {
        if self.best.as_ref().is_none_or(|b| p.s < b.s) {
            self.best = Some(p.clone());
            self.improved = true;
        }
    }

    /// Searches until the run's evaluation count reaches `until` or the budget ends.
    pub fn work(&mut self, bud: &mut Budget, until: u64, hints: &Hints) {
        let e_start = bud.evals;
        while bud.evals < until && !bud.exhausted {
            if !self.in_epoch {
                self.start_epoch(bud, hints);
                continue;
            }
            if self.has_pending {
                self.flush(bud, false);
            }
            self.hop(bud);
            if self.fails >= self.prm.max_fails {
                self.end_epoch(bud);
            }
        }
        self.own_evals += bud.evals - e_start;
    }

    /// Polishes what waits for polishing (the end of the run).
    pub fn finish_pending(&mut self, bud: &mut Budget) {
        self.flush(bud, true);
        self.deep_polish(bud);
    }

    pub fn has_work_pending(&self) -> bool {
        self.has_pending || self.deep_pending
    }

    fn end_epoch(&mut self, bud: &mut Budget) {
        self.in_epoch = false;
        self.deep_polish(bud);
        self.epochs_since_best += 1;
        if self.debug {
            eprintln!("    [k={}] epoch end kind {} soft {:.6} best {:?}", self.k, self.cur_kind, self.cur.s, self.best.as_ref().map(|b| b.s));
        }
    }

    fn pick_start(&mut self, hints: &Hints) -> usize {
        let mut w = self.prm.start_w;
        if self.k < 3 || self.lats.is_empty() {
            w[2] = 0.0;
        }
        if self.best.is_none() {
            w[3] = 0.0;
        }
        if hints.fewer.is_none() && hints.more.is_none() {
            w[4] = 0.0;
        }
        if self.pc().n == 0 {
            // angles mean nothing for disks
            w[0] += w[1];
            w[1] = 0.0;
        }
        // the first epoch: a neighbour's packing if there is one, else a lattice patch for many pieces
        if self.starts == 0 {
            if w[4] > 0.0 {
                return 4;
            }
            if w[2] > 0.0 && self.k >= 6 {
                return 2;
            }
        }
        let total: f64 = w.iter().sum();
        let mut x = self.rng.uniform() * total;
        for (i, &wi) in w.iter().enumerate() {
            if x < wi {
                return i;
            }
            x -= wi;
        }
        0
    }

    fn start_epoch(&mut self, bud: &mut Budget, hints: &Hints) {
        let kind = self.pick_start(hints);
        let mut cur = std::mem::replace(&mut self.cur, Sol::new(0, 0, false));
        match kind {
            0 | 1 => self.random_start(&mut cur, kind == 1),
            2 => self.lattice_start(&mut cur),
            3 => {
                let b = self.best.clone().unwrap();
                self.from_packing(&mut cur, &b);
                let amp = 0.15 + 0.3 * self.rng.uniform();
                self.shake_all(&mut cur, amp);
                for _ in 0..1 + self.k / 8 {
                    self.apply_move(&mut cur, 1);
                }
            }
            _ => {
                let use_fewer = match (hints.fewer, hints.more) {
                    (Some(_), Some(_)) => self.rng.chance(0.5),
                    (Some(_), None) => true,
                    _ => false,
                };
                if use_fewer {
                    self.from_fewer(&mut cur, hints.fewer.unwrap());
                } else {
                    self.from_more(&mut cur, hints.more.unwrap());
                }
            }
        }
        cur.forget_lines();
        let w = self.prm.w_explore;
        self.model.local_min(&mut self.lb, bud, &mut cur, w, 20000, w * 1e-2, true);
        self.starts += 1;
        self.start_tries[kind] += 1;
        self.cur_kind = kind;
        self.cur_g = cur.s + self.model.last_e / w;
        self.fails = 0;
        self.in_epoch = true;
        if self.debug {
            eprintln!("    [k={}] start {} kind {} soft {:.6} evals {}", self.k, self.starts, kind, cur.s, bud.evals);
        }
        self.cur = cur;
        if !bud.exhausted {
            let c = self.cur.clone();
            self.consider(bud, &c);
        }
    }

    fn hop(&mut self, bud: &mut Budget) {
        let mut cand = std::mem::replace(&mut self.cand, Sol::new(0, 0, false));
        cand.copy_from(&self.cur);
        self.perturb(&mut cand);
        let w = self.prm.w_explore;
        if self.prm.abort_it > 0 {
            self.model.abort_it = self.prm.abort_it;
            self.model.abort_level = self.cur_g * (1.0 + self.prm.abort_margin);
        }
        self.model.local_min(&mut self.lb, bud, &mut cand, w, 3000, w * self.prm.hop_gtol, true);
        self.model.abort_it = 0;
        self.hops += 1;
        if bud.exhausted {
            self.cand = cand;
            return;
        }
        if self.model.aborted {
            self.fails += 1;
        } else if cand.s < self.cur.s * (1.0 - 1e-12) {
            self.cur_g = cand.s + self.model.last_e / w;
            std::mem::swap(&mut self.cur, &mut cand);
            self.fails = 0;
            let c = self.cur.clone();
            self.consider(bud, &c);
        } else {
            self.fails += 1;
        }
        self.cand = cand;
    }

    // ---- starts ----

    /// The scale at which k pieces would fill the face to `fill` of its area (internal units).
    fn scale_at_fill(&self, fill: f64) -> f64 {
        (self.k as f64 * self.pc().area / (fill * self.model.ct.area)).sqrt()
    }

    fn random_start(&mut self, sol: &mut Sol, aligned: bool) {
        let s0 = self.scale_at_fill(0.5).max(self.min_scale() * 1.2);
        let dim = self.dim;
        let n = self.pc().n;
        let period = self.pc().period;
        for i in 0..self.k {
            let (x, y) = self.model.ct.sample(&mut self.rng, 0.85 * s0);
            sol.q[dim * i] = x;
            sol.q[dim * i + 1] = y;
            if dim == 3 {
                sol.q[3 * i + 2] = if aligned {
                    // an edge of the piece parallel to an edge of the face
                    let e = self.rng.below(self.model.ct.m);
                    self.model.ct.psi[e] - PI / 2.0 - PI / n as f64 + if n % 2 == 1 && self.rng.chance(0.5) { 0.5 * period } else { 0.0 }
                } else {
                    self.rng.uniform() * period
                };
            }
        }
        sol.s = s0;
    }

    /// The scale below which one piece cannot fit (internal units), when known.
    fn min_scale(&self) -> f64 {
        let ct = &self.model.ct;
        if ct.rho > 0.0 {
            self.pc().inr / ct.rho
        } else {
            0.0
        }
    }

    fn lattice_start(&mut self, sol: &mut Sol) {
        let nl = self.lats.len();
        let li = if nl == 1 || self.rng.chance(0.6) { 0 } else { self.rng.below(nl) };
        let lat = self.lats[li].clone();
        let mut top: Vec<(f64, f64, f64, f64)> = Vec::new();
        let mut buf: Vec<(f64, [f64; 3])> = Vec::new();
        for _ in 0..self.prm.lat_cands.max(1) {
            let turn = if self.rng.chance(0.7) {
                let e = self.rng.below(self.model.ct.m);
                self.model.ct.psi[e] + PI / 2.0 + if self.rng.chance(0.5) { PI } else { 0.0 }
            } else {
                self.rng.uniform() * 2.0 * PI
            };
            let u = self.rng.uniform();
            let v = self.rng.uniform();
            let ox = u * lat.t + v * lat.a2[0];
            let oy = v * lat.a2[1];
            let fit = self.patch(&lat, turn, ox, oy, &mut buf);
            top.push((fit, turn, ox, oy));
        }
        top.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let pick = if self.rng.chance(0.5) { 0 } else { self.rng.below(top.len().min(3)) };
        let (_, turn, ox, oy) = top[pick];
        self.patch(&lat, turn, ox, oy, &mut buf);
        let dim = self.dim;
        for i in 0..self.k {
            let c = buf[i].1;
            sol.q[dim * i] = c[0];
            sol.q[dim * i + 1] = c[1];
            if dim == 3 {
                sol.q[3 * i + 2] = c[2];
            }
        }
    }

    /// The arrangement turned by `turn` about the shift (ox, oy): its pieces near the origin with the
    /// scale each needs, the k smallest first in `buf`; returns the k-th smallest.
    fn patch(&self, lat: &Lattice, turn: f64, ox: f64, oy: f64, buf: &mut Vec<(f64, [f64; 3])>) -> f64 {
        let k = self.k;
        let ct = &self.model.ct;
        let pc = self.pc();
        let (sn, cs) = turn.sin_cos();
        let extent = 1.5 * self.scale_at_fill(0.6) * ct.ext + 3.0;
        let rows = (extent / lat.a2[1]).ceil() as i64 + 2;
        let cols = (extent / lat.t).ceil() as i64 + 2;
        buf.clear();
        for j in -rows..=rows {
            let shift = (j as f64 * lat.a2[0] / lat.t).round() as i64;
            for i in -cols - shift..=cols - shift {
                for m in &lat.motif {
                    let lx = m[0] + i as f64 * lat.t + j as f64 * lat.a2[0] - ox;
                    let ly = m[1] + j as f64 * lat.a2[1] - oy;
                    let x = cs * lx - sn * ly;
                    let y = sn * lx + cs * ly;
                    if x.abs() > extent || y.abs() > extent {
                        continue;
                    }
                    let th = m[2] + turn;
                    buf.push((ct.fit(pc, x, y, th, 1.0, 0.0), [x, y, th]));
                }
            }
        }
        if buf.len() < k {
            return f64::INFINITY;
        }
        buf.select_nth_unstable_by(k - 1, |a, b| a.0.partial_cmp(&b.0).unwrap());
        buf[k - 1].0
    }

    /// A site-unit packing as an internal solution.
    fn from_packing(&self, sol: &mut Sol, p: &Packing) {
        let r = self.pc().r_site;
        let dim = self.dim;
        for i in 0..self.k {
            sol.q[dim * i] = p.q[i][0] / r;
            sol.q[dim * i + 1] = p.q[i][1] / r;
            if dim == 3 {
                sol.q[3 * i + 2] = p.q[i][2];
            }
        }
        sol.s = p.s / r;
    }

    /// The packing of k - 1 pieces with one more at the roomiest of 64 sampled points.
    fn from_fewer(&mut self, sol: &mut Sol, p: &Packing) {
        let r = self.pc().r_site;
        let dim = self.dim;
        let k = self.k;
        for i in 0..k - 1 {
            sol.q[dim * i] = p.q[i][0] / r;
            sol.q[dim * i + 1] = p.q[i][1] / r;
            if dim == 3 {
                sol.q[3 * i + 2] = p.q[i][2];
            }
        }
        sol.s = p.s / r;
        let (x, y) = self.roomiest(sol, k - 1, 64);
        sol.q[dim * (k - 1)] = x;
        sol.q[dim * (k - 1) + 1] = y;
        if dim == 3 {
            sol.q[3 * (k - 1) + 2] = if k >= 2 && self.rng.chance(0.5) { sol.q[3 * self.rng.below(k - 1) + 2] } else { self.rng.uniform() * self.pc().period };
        }
    }

    /// The packing of k + 1 pieces without one of them (chosen at random).
    fn from_more(&mut self, sol: &mut Sol, p: &Packing) {
        let r = self.pc().r_site;
        let dim = self.dim;
        let skip = self.rng.below(self.k + 1);
        let mut o = 0;
        for (i, pose) in p.q.iter().enumerate() {
            if i == skip {
                continue;
            }
            sol.q[dim * o] = pose[0] / r;
            sol.q[dim * o + 1] = pose[1] / r;
            if dim == 3 {
                sol.q[3 * o + 2] = pose[2];
            }
            o += 1;
        }
        sol.s = p.s / r;
    }

    /// The roomiest of `tries` random points of sol.s Q for a piece not among the first `count`: room is
    /// the clearance to the walls or half the distance to the nearest centre, whichever is less.
    fn roomiest(&mut self, sol: &Sol, count: usize, tries: usize) -> (f64, f64) {
        let dim = self.dim;
        let s = sol.s;
        let mut best = (f64::NEG_INFINITY, 0.0, 0.0);
        for _ in 0..tries {
            let (x, y) = self.model.ct.sample(&mut self.rng, s);
            let ct = &self.model.ct;
            let mut room = f64::INFINITY;
            for e in 0..ct.m {
                room = room.min(s * ct.h[e] - ct.nx[e] * x - ct.ny[e] * y);
            }
            for j in 0..count {
                let dx = sol.q[dim * j] - x;
                let dy = sol.q[dim * j + 1] - y;
                room = room.min(0.5 * (dx * dx + dy * dy).sqrt());
            }
            if room > best.0 {
                best = (room, x, y);
            }
        }
        (best.1, best.2)
    }

    // ---- moves ----

    fn shake_all(&mut self, sol: &mut Sol, amp: f64) {
        let turn = self.dim == 3 && self.rng.chance(0.5);
        for i in 0..self.k {
            sol.q[self.dim * i] += amp * self.rng.signed();
            sol.q[self.dim * i + 1] += amp * self.rng.signed();
            if turn {
                sol.q[3 * i + 2] += 0.5 * amp * self.rng.signed();
            }
        }
    }

    fn perturb(&mut self, sol: &mut Sol) -> usize {
        let nk = if self.dim == 3 { 6 } else { 3 };
        let nk = if self.k == 1 { nk.min(if self.dim == 3 { 5 } else { 2 }) } else { nk };
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
        let k = self.k;
        let dim = self.dim;
        let period = self.pc().period;
        match kind {
            0 => {
                let amp = 0.05 + 0.35 * self.rng.uniform();
                let turn = self.rng.chance(0.5);
                for i in 0..k {
                    sol.q[dim * i] += amp * self.rng.signed();
                    sol.q[dim * i + 1] += amp * self.rng.signed();
                    if dim == 3 && turn {
                        sol.q[3 * i + 2] += 0.5 * amp * self.rng.signed();
                    }
                }
            }
            1 => {
                let i = self.rng.below(k);
                let tries = if self.rng.chance(self.prm.p_hole) { 24 } else { 1 };
                // the other pieces first in a copy: roomiest() reads the first `count` centres
                let mut tmp = sol.clone();
                if i != k - 1 {
                    for d in 0..dim {
                        tmp.q.swap(dim * i + d, dim * (k - 1) + d);
                    }
                }
                let (x, y) = self.roomiest(&tmp, k - 1, tries);
                sol.q[dim * i] = x;
                sol.q[dim * i + 1] = y;
                if dim == 3 {
                    sol.q[3 * i + 2] = self.rng.uniform() * period;
                }
            }
            2 => {
                let c = self.rng.below(k);
                let (cx, cy) = (sol.q[dim * c], sol.q[dim * c + 1]);
                let rad = 3.0;
                let amp = 0.6;
                for i in 0..k {
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
                let m = 1 + self.rng.below(2);
                for _ in 0..m {
                    let i = self.rng.below(k);
                    sol.q[3 * i + 2] += period * self.rng.uniform();
                }
            }
            4 => {
                let i = self.rng.below(k);
                sol.q[3 * i + 2] += 0.5 * period;
            }
            _ => {
                let i = self.rng.below(k);
                let mut nb = i;
                let mut bd = f64::INFINITY;
                for j in 0..k {
                    if j != i {
                        let dx = sol.q[3 * j] - sol.q[3 * i];
                        let dy = sol.q[3 * j + 1] - sol.q[3 * i + 1];
                        let d = dx * dx + dy * dy;
                        if d < bd {
                            bd = d;
                            nb = j;
                        }
                    }
                }
                let n = self.pc().n;
                sol.q[3 * i + 2] = sol.q[3 * nb + 2] + if n % 2 == 1 && self.rng.chance(0.5) { 0.5 * period } else { 0.0 };
            }
        }
        kind
    }

    // ---- polish ----

    fn consider(&mut self, bud: &mut Budget, sol: &Sol) {
        if sol.s >= self.best_explore {
            return;
        }
        self.best_explore = sol.s;
        self.pending.copy_from(sol);
        self.has_pending = true;
        self.flush(bud, false);
    }

    fn flush(&mut self, bud: &mut Budget, force: bool) {
        if !self.has_pending || bud.exhausted {
            return;
        }
        if !force && self.polish_evals as f64 > self.prm.polish_share * (self.own_evals as f64 + 1000.0) {
            return;
        }
        let e0 = bud.evals;
        self.has_pending = false;
        let mut pol = std::mem::replace(&mut self.pol, Sol::new(0, 0, false));
        pol.copy_from(&self.pending);
        let w = self.prm.w_quick;
        self.model.local_min(&mut self.lb, bud, &mut pol, w, 6000, w * 1e-3, false);
        let before = self.best.as_ref().map_or(f64::INFINITY, |b| b.s);
        let got = self.finish(&pol);
        if self.debug {
            eprintln!("    [k={}] polish soft {:.9} -> {:.9} -> {:?}", self.k, self.pending.s, pol.s, got);
        }
        if let Some(v) = got {
            if v <= before {
                self.best_pol.copy_from(&pol);
                self.deep_w = w * self.prm.ladder;
                self.deep_pending = true;
            }
        }
        self.pol = pol;
        self.polish_evals += bud.evals - e0;
    }

    fn deep_polish(&mut self, bud: &mut Budget) {
        self.flush(bud, true);
        if !self.deep_pending || bud.exhausted {
            return;
        }
        let e0 = bud.evals;
        self.deep_pending = false;
        let mut pol = std::mem::replace(&mut self.pol, Sol::new(0, 0, false));
        pol.copy_from(&self.best_pol);
        let mut w = self.deep_w;
        while w >= self.prm.w_final * 0.999 && !bud.exhausted {
            self.model.local_min(&mut self.lb, bud, &mut pol, w, 4000, w * 1e-3, false);
            w *= self.prm.ladder;
        }
        if !bud.exhausted {
            let got = self.finish(&pol);
            if self.debug {
                eprintln!("    [k={}] deep polish -> {:.12} -> {:?}", self.k, pol.s, got);
            }
        }
        self.pol = pol;
        self.polish_evals += bud.evals - e0;
    }

    /// Repairs an internal solution exactly in site units; keeps it as the best when it is smaller.
    /// Returns its exact scale.
    fn finish(&mut self, sol: &Sol) -> Option<f64> {
        let r = self.pc().r_site;
        let dim = self.dim;
        let q: Vec<[f64; 3]> = (0..self.k).map(|i| [sol.q[dim * i] * r, sol.q[dim * i + 1] * r, if dim == 3 { sol.q[3 * i + 2] } else { 0.0 }]).collect();
        let p = repair(self.pc(), &self.model.ct, &q)?;
        let s = p.s;
        if self.best.as_ref().is_none_or(|b| s < b.s) {
            self.best = Some(p);
            self.improved = true;
            self.epochs_since_best = 0;
            self.start_wins[self.cur_kind] += 1;
        }
        Some(s)
    }

    /// The lattices this search draws starts from.
    pub fn lattices_of(pc: &Piece) -> Vec<Lattice> {
        lattices(pc)
    }
}
