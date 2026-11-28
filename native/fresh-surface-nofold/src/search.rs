//! The whole search of one problem: face problems, the assignment of pieces to faces, the schedule, the
//! check.
//!
//! **Decomposition.** Faces meet only along edges, so a nofold packing is a packing of each face on its
//! own, and every face scales with s. Congruent faces are the same face problem, and a face holding k
//! pieces needs s >= s_c(k), the least scale of k pieces in the face shape Q_c. A packing of k pieces
//! gives one of fewer by dropping pieces, so the best known upper bounds U_c(k) are made non-decreasing in
//! k, and the best s for the known bounds is the least value s among the U_c(k) at which the faces hold P
//! pieces: sum over classes of |faces of c| * max{k : U_c(k) <= s} >= P. It is computed exactly from
//! the table of bounds.
//!
//! **Schedule.** Only face problems that can lower s* are searched: for each class c, the problem with one
//! more piece per face than the class holds below s* (k = cap_c(s* - 0) + 1), unless its lower bound
//! already reaches s*. Each such problem gets slices of evaluations in turn, weighted by how close its
//! bound U is to s* (the bottleneck most), and every problem first gets a few slices. A face problem's
//! search is kept between slices ([`crate::planar::FaceSearch`]), and its best packings seed the
//! problems with one piece more or less.
//!
//! **Validity.** Every face packing is repaired exactly and checked on its own face with the validator's
//! nofold check at the strict tolerance; the assembled packing of the whole solid is checked with
//! `validate_space_submission` (strict: `no_record`, which implies the default check) before it enters
//! the trace or the result. A constructive packing for every face problem (pieces on a hexagonal grid of
//! their bounding circles, repaired) gives a valid packing of every problem at once.

use crate::geom::{repair, Packing, Piece};
use crate::lattice::Lattice;
use crate::model::Budget;
use crate::planar::{FaceSearch, Hints};
use crate::solid::Problem;
use polypack_flat::clock::thread_cpu_seconds;
use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};
use polypack_surface::{validate_nofold, SurfaceConfig, SurfacePose, ValidateOptions};
use serde_json::{json, Value};
use std::f64::consts::PI;

/// One face problem: k pieces on one face of class c.
struct Pair {
    /// Best valid packing (site units, k pieces), checked on its face.
    best: Option<Packing>,
    search: Option<FaceSearch>,
    lb: f64,
}

pub struct Tuning {
    /// Evaluations per slice: base + per_piece * k.
    pub slice_base: u64,
    pub slice_per_piece: u64,
    /// Slices every frontier problem gets before the weights apply.
    pub min_slices: u64,
    /// Weight of a frontier problem: 1 / (gap + g0)^2, gap = U / s* - 1.
    pub g0: f64,
}

impl Tuning {
    pub fn new() -> Tuning {
        let mut t = Tuning { slice_base: 3000, slice_per_piece: 300, min_slices: 3, g0: 0.01 };
        if let Ok(v) = std::env::var("FSN_TUNE") {
            for kv in v.split(',') {
                let mut it = kv.splitn(2, '=');
                let (Some(key), Some(val)) = (it.next(), it.next()) else { continue };
                let Ok(f) = val.parse::<f64>() else { continue };
                match key {
                    "slice" => t.slice_base = f as u64,
                    "slice_k" => t.slice_per_piece = f as u64,
                    "min_slices" => t.min_slices = f as u64,
                    "g0" => t.g0 = f,
                    _ => {}
                }
            }
        }
        t
    }
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning::new()
    }
}

pub struct Engine<'a> {
    pub prob: Problem,
    pairs: Vec<Vec<Pair>>,
    pub bud: Budget<'a>,
    t0: f64,
    seed: u64,
    lats: Option<Vec<Lattice>>,
    pub tune: Tuning,
    pub best_score: f64,
    pub best_config: Option<Value>,
    /// (CPU seconds since the start, score) at each checked improvement.
    pub trace: Vec<(f64, f64)>,
    pub checks: u64,
    pub check_failures: u64,
    pub slices: u64,
    pub stopped: &'static str,
    pub debug: bool,
    pub on_improve: Option<&'a mut dyn FnMut(f64, &Value)>,
    /// Reserve of the budget kept for the last polishes (evaluations, CPU seconds).
    reserve_evals: u64,
    reserve_cpu: f64,
    reserve_done: bool,
}

/// A hexagonal grid of the pieces' bounding circles in the face, the k cells that need the least scale,
/// repaired: a valid packing of any face problem, built at once.
pub fn grid_packing(pc: &Piece, ct: &crate::geom::Container, k: usize) -> Option<Packing> {
    let r = pc.r_site;
    let d = 2.0 * r * (1.0 + 1e-6);
    let cell = d * d * 3f64.sqrt() / 2.0;
    let reach = 2.0 * (k as f64 * cell / PI).sqrt() + 3.0 * d;
    let mut turns: Vec<f64> = ct.psi.iter().map(|p| p + PI / 2.0).take(6).collect();
    turns.push(0.0);
    let offsets = [(0.0, 0.0), (0.5, 0.0), (0.25, 0.5), (0.5, 0.5)];
    let mut best: Option<(f64, Vec<[f64; 3]>)> = None;
    let rows = (reach / (d * 3f64.sqrt() / 2.0)).ceil() as i64 + 1;
    let cols = (reach / d).ceil() as i64 + 1;
    let mut buf: Vec<(f64, [f64; 3])> = Vec::new();
    for &turn in &turns {
        let (sn, cs) = turn.sin_cos();
        for &(fu, fv) in &offsets {
            buf.clear();
            for j in -rows..=rows {
                for i in -cols..=cols {
                    let lx = (i as f64 + 0.5 * j as f64 + fu) * d;
                    let ly = (j as f64 + fv) * d * 3f64.sqrt() / 2.0;
                    if lx * lx + ly * ly > reach * reach {
                        continue;
                    }
                    let x = cs * lx - sn * ly;
                    let y = sn * lx + cs * ly;
                    // the bounding circle in the face
                    let mut g = f64::NEG_INFINITY;
                    for e in 0..ct.m {
                        g = g.max((ct.nx[e] * x + ct.ny[e] * y + r) / ct.h[e]);
                    }
                    buf.push((g, [x, y, 0.0]));
                }
            }
            if buf.len() < k {
                continue;
            }
            buf.select_nth_unstable_by(k - 1, |a, b| a.0.partial_cmp(&b.0).unwrap());
            let s = buf[k - 1].0;
            if best.as_ref().is_none_or(|b| s < b.0) {
                best = Some((s, buf[..k].iter().map(|b| b.1).collect()));
            }
        }
    }
    let (_, q) = best?;
    repair(pc, ct, &q)
}

impl<'a> Engine<'a> {
    pub fn new(prob: Problem, seed: u64, bud: Budget<'a>, t0: f64) -> Engine<'a> {
        let mut pairs = Vec::with_capacity(prob.classes.len());
        for (c, cl) in prob.classes.iter().enumerate() {
            pairs.push((1..=cl.kmax).map(|k| Pair { best: None, search: None, lb: prob.lower_bound(c, k) }).collect());
        }
        let reserve_evals = if bud.eval_limit != u64::MAX { (bud.eval_limit as f64 * 0.03) as u64 } else { 0 };
        let total = bud.deadline - t0;
        let reserve_cpu = if total.is_finite() { (0.03 * total).clamp(0.02, 0.5) } else { 0.0 };
        Engine {
            prob,
            pairs,
            bud,
            t0,
            seed,
            lats: None,
            tune: Tuning::new(),
            best_score: f64::INFINITY,
            best_config: None,
            trace: Vec::new(),
            checks: 0,
            check_failures: 0,
            slices: 0,
            stopped: "",
            debug: std::env::var("FSN_DEBUG").is_ok(),
            on_improve: None,
            reserve_evals,
            reserve_cpu,
            reserve_done: false,
        }
    }

    /// The face problem's packing checked on its class's representative face with the validator's nofold
    /// check at the strict tolerance.
    fn face_ok(&self, c: usize, p: &Packing) -> bool {
        let face = self.prob.classes[c].faces[0];
        let pieces: Vec<SurfacePose> = p.q.iter().map(|q| SurfacePose { face: face as f64, x: q[0], y: q[1], theta: q[2] }).collect();
        let cfg = SurfaceConfig { solid: self.prob.solid_name.clone(), n: self.prob.n as f64, s: p.s, pieces };
        let opts = ValidateOptions { tol: 1e-11, ..ValidateOptions::default() };
        validate_nofold(&cfg, &opts).ok
    }

    /// Offers a packing of k pieces of class c (site units): kept when valid on its face and better.
    fn offer(&mut self, c: usize, p: Packing) -> bool {
        let k = p.q.len();
        if k == 0 || k > self.prob.classes[c].kmax {
            return false;
        }
        let pair = &self.pairs[c][k - 1];
        if pair.best.as_ref().is_some_and(|b| b.s <= p.s) {
            return false;
        }
        if !self.face_ok(c, &p) {
            self.check_failures += 1;
            if self.debug {
                eprintln!("face check refused class {c} k {k} s {}", p.s);
            }
            return false;
        }
        let pair = &mut self.pairs[c][k - 1];
        if let Some(fs) = pair.search.as_mut() {
            fs.offer(&p);
            fs.improved = false;
        }
        pair.best = Some(p);
        true
    }

    /// U_c(k): the least scale of a known packing of at least k pieces of class c, and which k' holds it.
    fn upper(&self, c: usize, k: usize) -> (f64, usize) {
        let mut best = (f64::INFINITY, 0);
        for kk in k..=self.prob.classes[c].kmax {
            if let Some(b) = &self.pairs[c][kk - 1].best {
                if b.s < best.0 {
                    best = (b.s, kk);
                }
            }
        }
        best
    }

    /// The best scale for the known packings, and per class the load and the source problem.
    fn assignment(&self) -> Option<(f64, Vec<(usize, usize)>)> {
        let nc = self.prob.classes.len();
        // per class, U_c(k) for k = 1..kmax (non-decreasing)
        let mut env: Vec<Vec<(f64, usize)>> = Vec::with_capacity(nc);
        let mut cands: Vec<f64> = Vec::new();
        for c in 0..nc {
            let km = self.prob.classes[c].kmax;
            let mut row = vec![(f64::INFINITY, 0); km];
            let mut run = (f64::INFINITY, 0usize);
            for k in (1..=km).rev() {
                if let Some(b) = &self.pairs[c][k - 1].best {
                    if b.s < run.0 {
                        run = (b.s, k);
                    }
                }
                row[k - 1] = run;
                if run.0.is_finite() {
                    cands.push(run.0);
                }
            }
            env.push(row);
        }
        cands.sort_by(|a, b| a.partial_cmp(b).unwrap());
        cands.dedup();
        for &s in &cands {
            let mut cap = 0usize;
            let mut loads = vec![(0usize, 0usize); nc];
            for c in 0..nc {
                let row = &env[c];
                let mut kk = 0;
                while kk < row.len() && row[kk].0 <= s {
                    kk += 1;
                }
                if kk > 0 {
                    loads[c] = (kk, row[kk - 1].1);
                }
                cap += kk * self.prob.classes[c].faces.len();
            }
            if cap >= self.prob.p {
                return Some((s, loads));
            }
        }
        None
    }

    /// The configuration of the whole solid for an assignment: each face of a class gets up to the class
    /// load of pieces from the source packing, mapped to the face's frame, until P pieces are placed.
    fn assemble(&self, s: f64, loads: &[(usize, usize)]) -> Value {
        let mut left = self.prob.p;
        let mut pieces: Vec<Value> = Vec::with_capacity(left);
        let period = self.prob.piece.period;
        for (c, cl) in self.prob.classes.iter().enumerate() {
            let (load, src) = loads[c];
            if load == 0 {
                continue;
            }
            let pk = self.pairs[c][src - 1].best.as_ref().unwrap();
            for &f in &cl.faces {
                if left == 0 {
                    break;
                }
                let m = load.min(left);
                let tf = self.prob.face_map[f];
                for q in &pk.q[..m] {
                    let p = if tf.is_identity() { *q } else { tf.pose(*q) };
                    let th = if self.prob.n == 0 { 0.0 } else { crate::geom::reduce_angle(p[2], period) };
                    pieces.push(json!({"face": f, "x": p[0], "y": p[1], "theta": th}));
                }
                left -= m;
            }
        }
        json!({"s": s, "pieces": pieces})
    }

    /// The check of a whole configuration: the server's validator, strict (which implies the default
    /// check). Some(score) when valid.
    pub fn check(id: &str, cfg: &Value) -> Option<f64> {
        let opts = SpaceValidateOptions { no_record: true, ..SpaceValidateOptions::default() };
        let v = validate_space_submission(SpaceName::Surface, id, cfg, &opts);
        if v.valid {
            v.score
        } else {
            None
        }
    }

    /// Recomputes the best assignment; checks and records it when it beats the best.
    fn update_global(&mut self) {
        let Some((s, loads)) = self.assignment() else { return };
        if !(s < self.best_score) {
            return;
        }
        let cfg = self.assemble(s, &loads);
        self.checks += 1;
        match Engine::check(&self.prob.id, &cfg) {
            Some(score) if score < self.best_score => {
                self.best_score = score;
                let t = thread_cpu_seconds() - self.t0;
                self.trace.push((t, score));
                if self.debug {
                    eprintln!("best {:.12} t {:.3} evals {} loads {:?}", score, t, self.bud.evals, loads);
                }
                if let Some(cb) = self.on_improve.as_mut() {
                    cb(score, &cfg);
                }
                self.best_config = Some(cfg);
            }
            Some(_) => {}
            None => {
                self.check_failures += 1;
                if self.debug {
                    eprintln!("whole check refused s {s}");
                }
            }
        }
    }

    /// Starts from a valid configuration of the problem: it is the best to beat, and each face's pieces
    /// seed that face problem.
    pub fn seed_start(&mut self, start: &Value) {
        let opts = SpaceValidateOptions::default();
        let v = validate_space_submission(SpaceName::Surface, &self.prob.id, start, &opts);
        if !v.valid {
            return;
        }
        let Some(score) = v.score else { return };
        self.best_score = score;
        self.best_config = Some(start.clone());
        let Some(list) = start.get("pieces").and_then(|p| p.as_array()) else { return };
        let nf = self.prob.solid.f;
        let mut per_face: Vec<Vec<[f64; 3]>> = vec![Vec::new(); nf];
        for p in list {
            let f = p.get("face").and_then(|v| v.as_f64()).unwrap_or(-1.0);
            let (Some(x), Some(y), Some(th)) = (p.get("x").and_then(|v| v.as_f64()), p.get("y").and_then(|v| v.as_f64()), p.get("theta").and_then(|v| v.as_f64())) else {
                continue;
            };
            if f >= 0.0 && (f as usize) < nf {
                let f = f as usize;
                let tf = self.prob.face_map[f];
                per_face[f].push(tf.inverse_pose([x, y, th]));
            }
        }
        for (f, q) in per_face.into_iter().enumerate() {
            if q.is_empty() {
                continue;
            }
            let c = self.prob.face_class[f];
            let cont = self.prob.classes[c].cont.clone();
            if let Some(p) = repair(&self.prob.piece, &cont, &q) {
                self.offer(c, p);
            }
        }
    }

    /// The frontier: the face problems whose improvement below s* can lower s*. Below s*, class c holds
    /// kappa_c pieces per face, short of P by D. A plan raises some classes by j_c >= 1 pieces per face
    /// with sum |faces of c| j_c >= D (minimal: no raised class is spare); it needs every problem
    /// (c, kappa_c + j_c) below s*, and none may have its lower bound at s*. Its difficulty is the largest
    /// gap U / s* - 1 among them. Each problem of some plan is returned with the least difficulty of the
    /// plans it is in: (class, k, difficulty).
    fn frontier(&self, sstar: f64) -> Vec<(usize, usize, f64)> {
        let nc = self.prob.classes.len();
        let mut kappa = vec![0usize; nc];
        let mut held = 0usize;
        for (c, cl) in self.prob.classes.iter().enumerate() {
            for k in 1..=cl.kmax {
                if self.upper(c, k).0 < sstar * (1.0 - 1e-12) {
                    kappa[c] = k;
                } else {
                    break;
                }
            }
            held += kappa[c] * cl.faces.len();
        }
        if held >= self.prob.p {
            return Vec::new();
        }
        let deficit = self.prob.p - held;
        // per class, the raises j = 1.. with their gaps, up to the first that covers the deficit alone,
        // stopping at a lower bound that reaches s*
        let mut opts: Vec<Vec<f64>> = Vec::with_capacity(nc);
        for (c, cl) in self.prob.classes.iter().enumerate() {
            let f = cl.faces.len();
            let jmax = deficit.div_ceil(f).min(cl.kmax - kappa[c]);
            let mut row = Vec::new();
            for j in 1..=jmax {
                let k = kappa[c] + j;
                if self.pairs[c][k - 1].lb >= sstar * (1.0 - 1e-9) {
                    break;
                }
                row.push((self.upper(c, k).0 / sstar - 1.0).max(0.0));
            }
            opts.push(row);
        }
        let mut best: Vec<Vec<f64>> = opts.iter().map(|r| vec![f64::INFINITY; r.len()]).collect();
        let mut chosen: Vec<usize> = vec![0; nc];
        let mut nodes = 0usize;
        #[allow(clippy::too_many_arguments)]
        fn walk(
            c: usize,
            covered: usize,
            diff: f64,
            deficit: usize,
            opts: &[Vec<f64>],
            faces: &[usize],
            chosen: &mut Vec<usize>,
            best: &mut Vec<Vec<f64>>,
            nodes: &mut usize,
        ) {
            *nodes += 1;
            if *nodes > 200_000 {
                return;
            }
            if covered >= deficit {
                // minimal: no raised class is spare
                if (0..opts.len()).all(|d| chosen[d] == 0 || covered - faces[d] * chosen[d] < deficit) {
                    for d in 0..opts.len() {
                        if chosen[d] > 0 {
                            let slot = &mut best[d][chosen[d] - 1];
                            *slot = slot.min(diff);
                        }
                    }
                }
                return;
            }
            if c == opts.len() {
                return;
            }
            walk(c + 1, covered, diff, deficit, opts, faces, chosen, best, nodes);
            for j in 1..=opts[c].len() {
                chosen[c] = j;
                let cov = covered + faces[c] * j;
                walk(c + 1, cov, diff.max(opts[c][j - 1]), deficit, opts, faces, chosen, best, nodes);
                chosen[c] = 0;
                if cov >= deficit {
                    break;
                }
            }
        }
        let faces: Vec<usize> = self.prob.classes.iter().map(|cl| cl.faces.len()).collect();
        walk(0, 0, 0.0, deficit, &opts, &faces, &mut chosen, &mut best, &mut nodes);
        let mut out = Vec::new();
        for c in 0..nc {
            for (j, &d) in best[c].iter().enumerate() {
                if d.is_finite() {
                    out.push((c, kappa[c] + j + 1, d));
                }
            }
        }
        out
    }

    fn lattices(&mut self) -> Vec<Lattice> {
        if self.lats.is_none() {
            self.lats = Some(FaceSearch::lattices_of(&self.prob.piece));
        }
        self.lats.clone().unwrap()
    }

    fn near_end(&mut self) -> bool {
        if self.reserve_evals > 0 && self.bud.evals + self.reserve_evals >= self.bud.eval_limit {
            return true;
        }
        self.reserve_cpu > 0.0 && thread_cpu_seconds() >= self.bud.deadline - self.reserve_cpu
    }

    /// Takes the improvements of a face search into the table and the global best.
    fn collect(&mut self, c: usize, k: usize) {
        let pair = &mut self.pairs[c][k - 1];
        let Some(fs) = pair.search.as_mut() else { return };
        if !fs.improved {
            return;
        }
        fs.improved = false;
        let Some(p) = fs.best.clone() else { return };
        if self.offer(c, p) {
            self.update_global();
        }
    }

    pub fn run(&mut self) {
        // a valid packing of every face problem at once, and so of the problem
        for c in 0..self.prob.classes.len() {
            let cont = self.prob.classes[c].cont.clone();
            for k in 1..=self.prob.classes[c].kmax {
                if let Some(p) = grid_packing(&self.prob.piece, &cont, k) {
                    self.offer(c, p);
                }
            }
        }
        self.update_global();
        loop {
            if self.bud.exhausted || self.bud.poll() {
                break;
            }
            if !self.reserve_done && self.near_end() {
                self.reserve_done = true;
                self.polish_frontier();
                continue;
            }
            let sstar = self.assignment().map_or(f64::INFINITY, |a| a.0);
            let front = self.frontier(sstar);
            if front.is_empty() {
                self.stopped = "bound";
                break;
            }
            // the problem to search: the least effort per weight, every problem first a few slices
            let mut pick = 0;
            let mut best_key = f64::INFINITY;
            for (i, &(c, k, gap)) in front.iter().enumerate() {
                let slice = self.slice_len(k) as f64;
                let effort = self.pairs[c][k - 1].search.as_ref().map_or(0, |s| s.own_evals) as f64;
                let key = if effort < self.tune.min_slices as f64 * slice { -1e30 + effort } else { effort * (gap + self.tune.g0).powi(2) };
                if key < best_key {
                    best_key = key;
                    pick = i;
                }
            }
            let (c, k, _) = front[pick];
            self.search_slice(c, k);
        }
        if self.stopped.is_empty() {
            self.stopped = if self.bud.halt.is_empty() { "cpu" } else { self.bud.halt };
        }
    }

    fn slice_len(&self, k: usize) -> u64 {
        self.tune.slice_base + self.tune.slice_per_piece * k as u64
    }

    fn search_slice(&mut self, c: usize, k: usize) {
        if self.pairs[c][k - 1].search.is_none() {
            let lats = self.lattices();
            let seed = self.seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ ((c as u64) << 32) ^ (k as u64).wrapping_mul(0xD1B5_4A32_D192_ED03);
            let mut fs = FaceSearch::new(&self.prob.piece, &self.prob.classes[c].cont, k, seed, lats);
            if let Some(b) = &self.pairs[c][k - 1].best {
                fs.offer(b);
                fs.improved = false;
            }
            self.pairs[c][k - 1].search = Some(fs);
        }
        let until = self.bud.evals + self.slice_len(k);
        let km = self.prob.classes[c].kmax;
        let fewer = if k >= 2 { self.pairs[c][k - 2].best.clone() } else { None };
        let more = if k < km { self.pairs[c][k].best.clone() } else { None };
        let hints = Hints { fewer: fewer.as_ref(), more: more.as_ref() };
        let mut fs = self.pairs[c][k - 1].search.take().unwrap();
        fs.work(&mut self.bud, until, &hints);
        self.pairs[c][k - 1].search = Some(fs);
        self.slices += 1;
        self.collect(c, k);
    }

    /// Polishes what the frontier problems keep pending (the reserve at the end of the budget).
    fn polish_frontier(&mut self) {
        let sstar = self.assignment().map_or(f64::INFINITY, |a| a.0);
        for (c, k, _) in self.frontier(sstar) {
            if let Some(fs) = self.pairs[c][k - 1].search.as_mut() {
                if fs.has_work_pending() {
                    fs.finish_pending(&mut self.bud);
                }
            }
            self.collect(c, k);
        }
    }

    pub fn summary(&self) -> String {
        let mut parts = Vec::new();
        for (c, row) in self.pairs.iter().enumerate() {
            for (i, p) in row.iter().enumerate() {
                if let Some(fs) = &p.search {
                    parts.push(format!(
                        "c{} k{}: evals {} starts {} hops {} best {:.9} lb {:.6} tries {:?} wins {:?}",
                        c,
                        i + 1,
                        fs.own_evals,
                        fs.starts,
                        fs.hops,
                        p.best.as_ref().map_or(f64::NAN, |b| b.s),
                        p.lb,
                        fs.start_tries,
                        fs.start_wins
                    ));
                }
            }
        }
        parts.join("\n")
    }
}
