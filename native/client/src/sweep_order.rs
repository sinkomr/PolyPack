//! The order of the 2D-on-3D sweep (--sweep-2d-on-3d): the surface, sphere and torus problems from
//! easy to hard, in loops, and the position kept in the state directory.
//!
//! A problem has a number of pieces P and a piece shape N. N is ranked in its domain's order, the
//! disk first (N = 0, 3, 4, 5 ... have ranks 1, 2, 3, 4 ...), so rank_P = P and rank_N = position + 1.
//! Loop k covers the problems with max(rank_P, rank_N) = k, of every enabled kind, solid, mode and
//! torus family: the L-shaped rim of the k x k square of (P, rank N). Within a loop the order is
//! P ascending, then N rank ascending, then kind (surface, sphere, torus), then solid in catalogue
//! order, then mode (fold, nofold) or torus family (sq, hex, free).
//!
//! A kind skips what its domain does not hold: a P above its maximum (100 for surface and sphere,
//! 500 for torus), or an N it does not offer (all three offer N = 0 and 3 to 100).
//!
//! The position is the loop and the index within it of the first problem not finished; problems
//! finished beyond it (another slot ran ahead) are kept too, so a restart repeats none of them. After
//! the last loop the sweep starts pass 2 at loop 1.

use crate::options::{SweepKind, SweepOptions};
use crate::state::write_atomic;
use polypack_spaces::{domain_max_p, space_domain, surface_solids, SpaceName, TORUS_FAMILIES};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const POSITION_FILE: &str = "sweep.json";
/// After a pass in which no problem was searched (all closed, led by the user or unknown), the
/// wait before the next pass starts, so that a finished sweep does not read the server in a loop.
pub const EMPTY_PASS_WAIT: Duration = Duration::from_secs(300);

/// One problem of the sweep.
#[derive(Clone, Debug, PartialEq)]
pub struct SweepProblem {
    pub kind: SweepKind,
    /// The id as the server writes it, e.g. "surface/cube/fold/4/12".
    pub id: String,
    pub n: u32,
    pub p: usize,
}

impl SweepProblem {
    pub fn space(&self) -> SpaceName {
        match self.kind {
            SweepKind::Surface => SpaceName::Surface,
            SweepKind::Sphere => SpaceName::Sphere,
            SweepKind::Torus => SpaceName::Torus,
        }
    }
}

/// What a kind's domain offers: the shape codes in its order (the disk first) and the largest P.
#[derive(Clone, Debug, PartialEq)]
pub struct KindDomain {
    pub kind: SweepKind,
    pub ns: Vec<u32>,
    pub max_p: usize,
}

impl KindDomain {
    /// Read from the spaces' domain description (/api/spaces' fields N and P).
    pub fn of(kind: SweepKind) -> KindDomain {
        let space = match kind {
            SweepKind::Surface => SpaceName::Surface,
            SweepKind::Sphere => SpaceName::Sphere,
            SweepKind::Torus => SpaceName::Torus,
        };
        let domain = space_domain(space).expect("every space has a domain");
        let fields = domain.info.get("fields").and_then(Value::as_array).cloned().unwrap_or_default();
        let ns = fields
            .iter()
            .find(|f| f.get("key").and_then(Value::as_str) == Some("N"))
            .and_then(|f| f.get("values"))
            .and_then(Value::as_array)
            .map(|v| v.iter().filter_map(|x| x.as_str().and_then(|s| s.parse::<u32>().ok())).collect())
            .unwrap_or_default();
        KindDomain { kind, ns, max_p: domain_max_p(domain) as usize }
    }
}

/// The sweep's problems, by loop.
pub struct Order {
    doms: Vec<KindDomain>,
    modes: Vec<String>,
    solids: Vec<String>,
    max_n: Option<u32>,
    n_filter: Option<HashSet<u32>>,
    p_filter: Option<HashSet<usize>>,
    loops: usize,
    signature: String,
}

impl Order {
    /// `n` and `p` are the flat options --N and --P / --max-P, used here as filters.
    pub fn new(o: &SweepOptions, n: Option<&Vec<u32>>, p: Option<&Vec<usize>>) -> Order {
        let doms: Vec<KindDomain> = SweepKind::ALL.iter().filter(|k| o.kinds.contains(k)).map(|&k| KindDomain::of(k)).collect();
        let solids: Vec<String> = match &o.solids {
            Some(list) => surface_solids().iter().filter(|s| list.contains(s)).cloned().collect(),
            None => surface_solids().to_vec(),
        };
        let modes: Vec<String> = polypack_spaces::SURFACE_MODES.iter().filter(|m| o.surface_modes.iter().any(|x| x == *m)).map(|m| m.to_string()).collect();
        let mut order = Order {
            doms,
            modes,
            solids,
            max_n: o.max_n,
            n_filter: n.map(|v| v.iter().copied().collect()),
            p_filter: p.map(|v| v.iter().copied().collect()),
            loops: 0,
            signature: String::new(),
        };
        // the last loop: the largest max(P, rank N) of a problem that exists
        let mut loops = 0;
        for d in &order.doms {
            if order.per_cell(d.kind) == 0 {
                continue;
            }
            let top_p = (1..=d.max_p).rev().find(|p| order.p_ok(*p));
            let top_rank = d.ns.iter().rposition(|&n| order.n_ok(n)).map(|i| i + 1);
            if let (Some(p), Some(r)) = (top_p, top_rank) {
                loops = loops.max(p.max(r));
            }
        }
        order.loops = loops;
        let text = format!("{:?}|{:?}|{}|{:?}|{:?}|{:?}", order.doms.iter().map(|d| d.kind.name()).collect::<Vec<_>>(), order.modes, order.solids.join(","), order.max_n, sorted(&order.n_filter), sorted(&order.p_filter));
        order.signature = format!("{:016x}", fnv1a(text.as_bytes()));
        order
    }

    /// The number of loops: the last one holds the largest P or N rank any enabled problem has.
    pub fn loops(&self) -> usize {
        self.loops
    }

    pub fn signature(&self) -> &str {
        &self.signature
    }

    fn p_ok(&self, p: usize) -> bool {
        self.p_filter.as_ref().map_or(true, |f| f.contains(&p))
    }

    fn n_ok(&self, n: u32) -> bool {
        self.max_n.map_or(true, |m| n <= m) && self.n_filter.as_ref().map_or(true, |f| f.contains(&n))
    }

    /// How many problems a kind has for one P and N.
    fn per_cell(&self, kind: SweepKind) -> usize {
        match kind {
            SweepKind::Surface => self.solids.len() * self.modes.len(),
            SweepKind::Sphere => 1,
            SweepKind::Torus => TORUS_FAMILIES.len(),
        }
    }

    /// The problems of loop k (1-based), in the sweep's order.
    pub fn loop_problems(&self, k: usize) -> Vec<SweepProblem> {
        let mut out = Vec::new();
        let top_p = self.doms.iter().map(|d| d.max_p).max().unwrap_or(0);
        for p in 1..=k.min(top_p) {
            if !self.p_ok(p) {
                continue;
            }
            // below the loop's own P only the N of rank k closes the square; at P = k every rank
            let ranks = if p < k { k..=k } else { 1..=k };
            for rank in ranks {
                for d in &self.doms {
                    if p > d.max_p || rank > d.ns.len() {
                        continue;
                    }
                    let n = d.ns[rank - 1];
                    if !self.n_ok(n) {
                        continue;
                    }
                    let mut push = |id: String| out.push(SweepProblem { kind: d.kind, id, n, p });
                    match d.kind {
                        SweepKind::Surface => {
                            for solid in &self.solids {
                                for mode in &self.modes {
                                    push(format!("surface/{solid}/{mode}/{n}/{p}"));
                                }
                            }
                        }
                        SweepKind::Sphere => push(format!("sphere/{n}/{p}")),
                        SweepKind::Torus => {
                            for family in TORUS_FAMILIES {
                                push(format!("torus/{family}/{n}/{p}"));
                            }
                        }
                    }
                }
            }
        }
        out
    }

    /// "surface (fold, nofold; 141 solids), sphere, torus".
    pub fn describe(&self) -> String {
        self.doms
            .iter()
            .map(|d| match d.kind {
                SweepKind::Surface => format!("surface ({}; {} solid{})", self.modes.join(", "), self.solids.len(), if self.solids.len() == 1 { "" } else { "s" }),
                k => k.name().to_string(),
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// True when no problem passes the options.
    pub fn is_empty(&self) -> bool {
        self.loops == 0
    }
}

fn sorted<T: Ord + Clone + std::hash::Hash>(s: &Option<HashSet<T>>) -> Option<Vec<T>> {
    s.as_ref().map(|s| {
        let mut v: Vec<T> = s.iter().cloned().collect();
        v.sort();
        v
    })
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// A problem handed to a slot.
#[derive(Clone, Debug)]
pub struct Taken {
    pub pass: u32,
    pub k: usize,
    pub index: usize,
    /// The number of problems in the loop.
    pub size: usize,
    pub problem: SweepProblem,
}

pub enum Next {
    Problem(Taken),
    /// Nothing to hand out now: the rest of the loop is being searched, or a pass that searched
    /// nothing is waiting. Ask again shortly.
    Wait,
    /// The first pass is complete and the sweep was asked to make one pass only (--one-pass).
    Finished,
}

struct Inner {
    pass: u32,
    k: usize,
    items: Vec<SweepProblem>,
    /// The next index to hand out.
    next: usize,
    /// The first index not finished.
    low: usize,
    /// Finished indices above `low`.
    done: BTreeSet<usize>,
    searched_in_pass: usize,
    not_before: Option<Instant>,
    /// True once the pass is complete with --one-pass.
    finished: bool,
    /// When the position was last written.
    saved_at: Option<Instant>,
}

/// Hands the sweep's problems out one at a time to the slots, and keeps the position.
pub struct Dispenser {
    order: Order,
    path: Option<PathBuf>,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    empty_pass_wait: Duration,
    /// Stop at the end of the current pass instead of starting the next one (--one-pass).
    one_pass: bool,
    inner: Mutex<Inner>,
}

impl Dispenser {
    /// Reads the kept position from `dir` (unless `restart`), or starts at loop 1 of pass 1.
    /// `dir` None keeps nothing (tests). The order must not be empty.
    pub fn open(order: Order, dir: Option<&std::path::Path>, restart: bool, log: Arc<dyn Fn(&str) + Send + Sync>) -> Dispenser {
        assert!(!order.is_empty(), "an empty sweep has no position");
        let path = dir.map(|d| d.join(POSITION_FILE));
        let (mut pass, mut k, mut low, mut done) = (1u32, 1usize, 0usize, BTreeSet::new());
        if restart {
            if path.as_ref().map_or(false, |p| p.exists()) {
                log("--sweep-restart: starting again at loop 1 of pass 1");
            }
        } else if let Some(saved) = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            let get = |key: &str| saved.get(key).and_then(Value::as_u64);
            if let (Some(sp), Some(sk)) = (get("pass"), get("loop")) {
                if saved.get("signature").and_then(Value::as_str) == Some(order.signature()) {
                    pass = (sp as u32).max(1);
                    k = (sk as usize).clamp(1, order.loops());
                    low = get("index").unwrap_or(0) as usize;
                    done = saved.get("done").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).map(|x| x as usize).filter(|&x| x > low).collect()).unwrap_or_default();
                } else {
                    // Other options make another list of problems: the kept loop of the old list would skip every
                    // earlier loop of the new one (a pass of P <= 3 ends at loop 99; P <= 100 kept there did only N
                    // 99 and 100), so start the new list from its beginning.
                    log(&format!("The sweep's options changed since the position was kept (loop {sk} of pass {sp}): starting at loop 1 of pass 1 of the new list"));
                }
            }
        }
        let items = order.loop_problems(k);
        if low > items.len() {
            low = 0;
            done.clear();
        }
        let mut next = low;
        while done.contains(&next) {
            next += 1;
        }
        let d = Dispenser {
            order,
            path,
            log,
            empty_pass_wait: EMPTY_PASS_WAIT,
            one_pass: false,
            inner: Mutex::new(Inner { pass, k, items, next, low, done, searched_in_pass: 0, not_before: None, finished: false, saved_at: None }),
        };
        {
            let g = d.inner.lock().unwrap();
            d.announce_loop(&g, low > 0 || !g.done.is_empty());
            d.save(&g);
        }
        d
    }

    /// Stop at the end of the current pass (--one-pass).
    pub fn with_one_pass(mut self, one_pass: bool) -> Self {
        self.one_pass = one_pass;
        self
    }

    #[cfg(test)]
    pub fn with_empty_pass_wait(mut self, wait: Duration) -> Self {
        self.empty_pass_wait = wait;
        self
    }

    pub fn order(&self) -> &Order {
        &self.order
    }

    /// (pass, loop) now.
    pub fn position(&self) -> (u32, usize) {
        let g = self.inner.lock().unwrap();
        (g.pass, g.k)
    }

    fn announce_loop(&self, g: &Inner, resumed: bool) {
        (self.log)(&format!(
            "Sweep loop {} of {} (pass {}): {} problem(s) with max(P, rank of N) = {}{}",
            g.k,
            self.order.loops(),
            g.pass,
            g.items.len(),
            g.k,
            if resumed { format!("; resuming at problem {} (kept position)", g.low + 1) } else { String::new() }
        ));
    }

    fn save(&self, g: &Inner) {
        let Some(path) = &self.path else { return };
        let text = json!({
            "version": 1,
            "signature": self.order.signature(),
            "pass": g.pass,
            "loop": g.k,
            "index": g.low,
            "done": g.done.iter().collect::<Vec<_>>(),
        });
        if let Err(e) = write_atomic(path, &format!("{text}\n")) {
            (self.log)(&format!("Could not save the sweep position: {e}"));
        }
    }

    /// The next problem, or Wait.
    pub fn take(&self) -> Next {
        let mut g = self.inner.lock().unwrap();
        if g.finished {
            return Next::Finished;
        }
        if g.not_before.map_or(false, |t| Instant::now() < t) {
            return Next::Wait;
        }
        g.not_before = None;
        loop {
            if g.next < g.low {
                g.next = g.low;
            }
            while g.done.contains(&g.next) {
                g.next += 1;
            }
            if g.next < g.items.len() {
                let index = g.next;
                g.next += 1;
                return Next::Problem(Taken { pass: g.pass, k: g.k, index, size: g.items.len(), problem: g.items[index].clone() });
            }
            if g.low < g.items.len() {
                return Next::Wait;
            }
            // the loop is finished: the next one, or the next pass
            if g.k >= self.order.loops() && self.one_pass {
                (self.log)(&format!("Sweep pass {} is complete ({} problem(s) searched): stopping (--one-pass)", g.pass, g.searched_in_pass));
                g.finished = true;
                return Next::Finished;
            }
            if g.k >= self.order.loops() {
                (self.log)(&format!("Sweep pass {} is complete ({} problem(s) searched); starting pass {} at loop 1", g.pass, g.searched_in_pass, g.pass + 1));
                if g.searched_in_pass == 0 {
                    (self.log)(&format!("No problem was searched in pass {}: waiting {} before the next one", g.pass, crate::format::format_duration(self.empty_pass_wait.as_secs_f64())));
                    g.not_before = Some(Instant::now() + self.empty_pass_wait);
                }
                g.pass += 1;
                g.k = 1;
                g.searched_in_pass = 0;
            } else {
                g.k += 1;
            }
            g.items = self.order.loop_problems(g.k);
            g.next = 0;
            g.low = 0;
            g.done.clear();
            self.announce_loop(&g, false);
            self.save(&g);
            if g.not_before.is_some() {
                return Next::Wait;
            }
        }
    }

    /// A problem is handled (searched, or skipped as closed, unknown or led by the user): it is
    /// not offered again after a restart. `searched` counts it for the pass's tally.
    pub fn finish(&self, t: &Taken, searched: bool) {
        let mut g = self.inner.lock().unwrap();
        if t.pass != g.pass || t.k != g.k {
            return;
        }
        if searched {
            g.searched_in_pass += 1;
        }
        g.done.insert(t.index);
        loop {
            let low = g.low;
            if !g.done.remove(&low) {
                break;
            }
            g.low += 1;
        }
        // a searched problem is written at once; problems passed over (thousands a minute from the
        // lists) at most once a second, and flush() writes the last of them
        if searched || g.saved_at.map_or(true, |t| t.elapsed() >= Duration::from_secs(1)) {
            self.save(&g);
            g.saved_at = Some(Instant::now());
        }
    }

    /// Writes the position now.
    pub fn flush(&self) {
        let g = self.inner.lock().unwrap();
        self.save(&g);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use polypack_spaces::{parse_space_id, space_domain};
    use std::sync::Mutex as M;

    fn opts() -> SweepOptions {
        SweepOptions { kinds: SweepKind::ALL.to_vec(), surface_modes: vec!["fold".into(), "nofold".into()], solids: None, max_n: None, restart: false, include_own: false, open_only: false, one_pass: false }
    }

    fn ids(v: &[SweepProblem]) -> Vec<&str> {
        v.iter().map(|p| p.id.as_str()).collect()
    }

    fn quiet() -> Arc<dyn Fn(&str) + Send + Sync> {
        Arc::new(|_: &str| {})
    }

    fn collecting() -> (Arc<dyn Fn(&str) + Send + Sync>, Arc<M<Vec<String>>>) {
        let lines = Arc::new(M::new(Vec::new()));
        let l = lines.clone();
        (Arc::new(move |m: &str| l.lock().unwrap().push(m.to_string())), lines)
    }

    #[test]
    fn domains() {
        let s = KindDomain::of(SweepKind::Surface);
        assert_eq!((s.ns.len(), s.ns[..3].to_vec(), s.max_p), (99, vec![0, 3, 4], 100));
        let t = KindDomain::of(SweepKind::Torus);
        assert_eq!((t.ns.len(), t.max_p), (99, 500));
        assert_eq!(KindDomain::of(SweepKind::Sphere).max_p, 100);
    }

    #[test]
    fn loop_one_and_two() {
        let order = Order::new(&opts(), None, None);
        let one = order.loop_problems(1);
        // P = 1, N = 0: surface (141 solids x fold, nofold), sphere, torus (sq, hex, free)
        assert_eq!(one.len(), 141 * 2 + 1 + 3);
        assert_eq!(ids(&one)[..4], ["surface/tetrahedron/fold/0/1", "surface/tetrahedron/nofold/0/1", "surface/cube/fold/0/1", "surface/cube/nofold/0/1"]);
        assert_eq!(ids(&one)[one.len() - 4..], ["sphere/0/1", "torus/sq/0/1", "torus/hex/0/1", "torus/free/0/1"]);
        // loop 2: P = 1 with rank 2 (N = 3), then P = 2 with N = 0 and N = 3
        let two = order.loop_problems(2);
        assert_eq!(two.len(), 3 * 286);
        let kinds_at = |from: usize| -> Vec<&str> { ids(&two)[from..from + 1].to_vec() };
        assert_eq!(kinds_at(0), ["surface/tetrahedron/fold/3/1"]);
        assert_eq!(kinds_at(286), ["surface/tetrahedron/fold/0/2"]);
        assert_eq!(kinds_at(2 * 286), ["surface/tetrahedron/fold/3/2"]);
        assert_eq!(ids(&two)[2 * 286 - 1], "torus/free/0/2");
        // every problem has max(P, rank N) = k and parses as a problem of its domain
        for (k, list) in [(1, &one), (2, &two)] {
            for p in list.iter() {
                let rank = KindDomain::of(p.kind).ns.iter().position(|&n| n == p.n).unwrap() + 1;
                assert_eq!(p.p.max(rank), k, "{}", p.id);
                let parsed = parse_space_id(p.space(), &p.id).unwrap();
                assert!(space_domain(p.space()).unwrap().bound(&parsed).is_some(), "{}", p.id);
            }
        }
    }

    #[test]
    fn order_within_a_loop_is_p_then_n_then_kind() {
        let o = SweepOptions { solids: Some(vec!["cube".into()]), ..opts() };
        let order = Order::new(&o, None, None);
        let three = order.loop_problems(3);
        let key: Vec<(usize, usize, usize)> = three
            .iter()
            .map(|p| (p.p, KindDomain::of(p.kind).ns.iter().position(|&n| n == p.n).unwrap(), p.kind as usize))
            .collect();
        let mut sorted = key.clone();
        sorted.sort();
        assert_eq!(key, sorted);
        // P = 1 and 2 only with N of rank 3 (N = 4); P = 3 with ranks 1 to 3
        assert_eq!(three.iter().filter(|p| p.p == 1).map(|p| p.n).collect::<HashSet<_>>(), HashSet::from([4]));
        assert_eq!(three.iter().filter(|p| p.p == 3).map(|p| p.n).collect::<HashSet<_>>(), HashSet::from([0, 3, 4]));
        // cube: fold then nofold, then sphere, then the three torus families
        let first: Vec<&str> = ids(&three)[..6].to_vec();
        assert_eq!(first, ["surface/cube/fold/4/1", "surface/cube/nofold/4/1", "sphere/4/1", "torus/sq/4/1", "torus/hex/4/1", "torus/free/4/1"]);
    }

    #[test]
    fn domains_limits_and_loops() {
        let order = Order::new(&opts(), None, None);
        // torus alone runs to P = 500; the others stop at 100
        assert_eq!(order.loops(), 500);
        let l101 = order.loop_problems(101);
        assert!(l101.iter().all(|p| p.kind == SweepKind::Torus));
        assert_eq!(l101.len(), 99 * 3);
        let sphere_only = Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, None, None);
        assert_eq!(sphere_only.loops(), 100);
        // loop 100: P = 100 with every rank (there are 99 shapes)
        assert_eq!(sphere_only.loop_problems(100).len(), 99);
        // loop 99 holds rank 99 (N = 100) at P below 99, and P = 99 at ranks 1 to 99
        assert_eq!(sphere_only.loop_problems(99).len(), 98 + 99);
        assert!(sphere_only.loop_problems(101).is_empty());
    }

    #[test]
    fn filters() {
        let o = SweepOptions { kinds: vec![SweepKind::Sphere, SweepKind::Torus], max_n: Some(5), ..opts() };
        let p: Vec<usize> = (1..=4).collect();
        let order = Order::new(&o, None, Some(&p));
        // N in {0, 3, 4, 5}: ranks 1 to 4; P up to 4
        assert_eq!(order.loops(), 4);
        assert_eq!(ids(&order.loop_problems(1)), ["sphere/0/1", "torus/sq/0/1", "torus/hex/0/1", "torus/free/0/1"]);
        let all: usize = (1..=4).map(|k| order.loop_problems(k).len()).sum();
        assert_eq!(all, 4 * 4 * 4);
        // --N narrows to a list
        let order = Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, Some(&vec![0, 6]), Some(&vec![2, 3]));
        // N = 6 has rank 5 (0, 3, 4, 5, 6)
        assert_eq!(order.loops(), 5);
        let flat: Vec<String> = (1..=order.loops()).flat_map(|k| order.loop_problems(k)).map(|p| p.id).collect();
        assert_eq!(flat, ["sphere/0/2", "sphere/0/3", "sphere/6/2", "sphere/6/3"]);
        // a surface restricted to solids and modes
        let o = SweepOptions { kinds: vec![SweepKind::Surface], surface_modes: vec!["nofold".into()], solids: Some(vec!["snub_cube".into(), "cube".into()]), ..opts() };
        let order = Order::new(&o, None, None);
        assert_eq!(ids(&order.loop_problems(1)), ["surface/cube/nofold/0/1", "surface/snub_cube/nofold/0/1"]);
        assert_eq!(order.describe(), "surface (nofold; 2 solids)");
        assert_eq!(Order::new(&opts(), None, None).describe(), "surface (fold, nofold; 141 solids), sphere, torus");
        // nothing passes
        let none = Order::new(&SweepOptions { kinds: vec![], ..opts() }, None, None);
        assert!(none.is_empty());
        assert!(Order::new(&opts(), Some(&vec![1]), None).is_empty());
    }

    fn drain(d: &Dispenser, n: usize) -> Vec<Taken> {
        (0..n)
            .map(|_| match d.take() {
                Next::Problem(t) => {
                    d.finish(&t, true);
                    t
                }
                Next::Wait => panic!("unexpected wait"),
                Next::Finished => panic!("unexpected finish"),
            })
            .collect()
    }

    fn small() -> Order {
        Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, None, Some(&(1..=3).collect()))
    }

    #[test]
    fn walks_the_loops_and_wraps_into_pass_two() {
        let (log, lines) = collecting();
        // sphere with P up to 3 and every N: loops 1 to 99 (ranks), loop k holds ranks...
        let d = Dispenser::open(Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, Some(&vec![0, 3, 4]), Some(&(1..=3).collect())), None, false, log).with_empty_pass_wait(Duration::ZERO);
        // N ranks 1 to 3, P 1 to 3: loop 1 has 1 problem, loop 2 has 3, loop 3 has 5: 9 in all
        let got: Vec<String> = drain(&d, 9).into_iter().map(|t| format!("{}.{} {}", t.pass, t.k, t.problem.id)).collect();
        assert_eq!(
            got,
            ["1.1 sphere/0/1", "1.2 sphere/3/1", "1.2 sphere/0/2", "1.2 sphere/3/2", "1.3 sphere/4/1", "1.3 sphere/4/2", "1.3 sphere/0/3", "1.3 sphere/3/3", "1.3 sphere/4/3"]
        );
        let t = drain(&d, 1).remove(0);
        assert_eq!((t.pass, t.k, t.index, t.problem.id.as_str()), (2, 1, 0, "sphere/0/1"));
        let lines = lines.lock().unwrap();
        assert!(lines.iter().any(|l| l.contains("Sweep pass 1 is complete") && l.contains("starting pass 2 at loop 1")), "{lines:?}");
        assert!(lines.iter().any(|l| l.starts_with("Sweep loop 3 of 3 (pass 1): 5 problem(s)")), "{lines:?}");
    }

    #[test]
    fn a_loop_ends_only_when_its_problems_are_finished() {
        let d = Dispenser::open(small(), None, false, quiet());
        let Next::Problem(a) = d.take() else { panic!() };
        // loop 1 has a single problem, still being searched: the next ask waits
        assert!(matches!(d.take(), Next::Wait));
        d.finish(&a, true);
        let Next::Problem(b) = d.take() else { panic!() };
        assert_eq!((b.pass, b.k), (1, 2));
    }

    #[test]
    fn a_pass_that_searched_nothing_waits() {
        let o = Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, Some(&vec![0]), Some(&vec![1]));
        let d = Dispenser::open(o, None, false, quiet());
        let Next::Problem(a) = d.take() else { panic!() };
        d.finish(&a, false);
        assert!(matches!(d.take(), Next::Wait));
        assert!(matches!(d.take(), Next::Wait));
        assert_eq!(d.position().0, 2);
    }

    #[test]
    fn changed_options_start_the_new_list_at_loop_1() {
        let dir = temp("changed");
        let narrow = || Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, Some(&vec![0, 3, 4]), Some(&vec![1]));
        let wide = || Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, Some(&vec![0, 3, 4]), Some(&(1..=3).collect()));
        // the narrow list (P = 1) is swept to its last loop
        let d = Dispenser::open(narrow(), Some(&dir), false, quiet());
        drain(&d, 3);
        assert_eq!(d.position(), (1, 3));
        d.flush();
        drop(d);
        // the wider list (P <= 3) does not continue at loop 3: it starts at loop 1
        let (log, lines) = collecting();
        let d = Dispenser::open(wide(), Some(&dir), false, log);
        assert_eq!(d.position(), (1, 1));
        assert!(lines.lock().unwrap().iter().any(|l| l.contains("starting at loop 1 of pass 1 of the new list")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_pass_finishes_instead_of_starting_the_next() {
        let o = Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, Some(&vec![0]), Some(&vec![1]));
        let d = Dispenser::open(o, None, false, quiet()).with_one_pass(true);
        let Next::Problem(a) = d.take() else { panic!() };
        d.finish(&a, true);
        assert!(matches!(d.take(), Next::Finished));
        // every slot that asks afterwards hears the same, and the pass does not advance
        assert!(matches!(d.take(), Next::Finished));
        assert_eq!(d.position().0, 1);
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("polypack-sweep-{name}-{}-{:08x}", std::process::id(), crate::state::random_u32()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resumes_where_it_stopped() {
        let dir = temp("resume");
        let order = || Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, Some(&vec![0, 3, 4]), Some(&(1..=3).collect()));
        let d = Dispenser::open(order(), Some(&dir), false, quiet());
        // loop 1 (1 problem), then in loop 2: three problems taken, the second finished first
        let one = drain(&d, 1);
        assert_eq!(one[0].problem.id, "sphere/0/1");
        let Next::Problem(a) = d.take() else { panic!() };
        let Next::Problem(b) = d.take() else { panic!() };
        let Next::Problem(c) = d.take() else { panic!() };
        assert_eq!((a.problem.id.as_str(), b.problem.id.as_str(), c.problem.id.as_str()), ("sphere/3/1", "sphere/0/2", "sphere/3/2"));
        d.finish(&b, true);
        drop(d);
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(POSITION_FILE)).unwrap()).unwrap();
        assert_eq!((saved["pass"].as_u64(), saved["loop"].as_u64(), saved["index"].as_u64(), saved["done"].clone()), (Some(1), Some(2), Some(0), json!([1])));
        // a new run: the unfinished problems of loop 2 come again, the finished one does not
        let (log, lines) = collecting();
        let d = Dispenser::open(order(), Some(&dir), false, log);
        let got: Vec<String> = (0..3)
            .filter_map(|_| match d.take() {
                Next::Problem(t) => {
                    d.finish(&t, true);
                    Some(t.problem.id)
                }
                Next::Wait | Next::Finished => None,
            })
            .collect();
        assert_eq!(got, ["sphere/3/1", "sphere/3/2", "sphere/4/1"]);
        assert!(lines.lock().unwrap().iter().any(|l| l.contains("Sweep loop 2 of 3 (pass 1)") && l.contains("resuming at problem 1")));
        // finishing everything: the position is the end of the loop's successor
        drop(d);
        // --sweep-restart starts over
        let d = Dispenser::open(order(), Some(&dir), true, quiet());
        assert_eq!(drain(&d, 1)[0].problem.id, "sphere/0/1");
        assert_eq!(d.position(), (1, 1));
        drop(d);
        // other options: the loop is kept, its index is not
        let d = Dispenser::open(Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, Some(&vec![0, 3, 4, 5]), Some(&(1..=3).collect())), Some(&dir), false, quiet());
        assert_eq!(d.position(), (1, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resumes_in_pass_two() {
        let dir = temp("pass2");
        let order = || Order::new(&SweepOptions { kinds: vec![SweepKind::Sphere], ..opts() }, Some(&vec![0, 3]), Some(&vec![1, 2]));
        let d = Dispenser::open(order(), Some(&dir), false, quiet()).with_empty_pass_wait(Duration::ZERO);
        // N ranks 1 and 2, P 1 and 2: loop 1 has 1 problem, loop 2 has 3: pass 1 is 4 problems
        let got = drain(&d, 5);
        assert_eq!(got.last().map(|t| (t.pass, t.k)), Some((2, 1)));
        drop(d);
        let d = Dispenser::open(order(), Some(&dir), false, quiet());
        assert_eq!(d.position(), (2, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
