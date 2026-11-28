//! The order of the 3D-in-3D sweep (--sweep-3d-in-3d): the polyhedra and balls problems from simple to
//! complex, in loops.
//!
//! The shapes are ranked: the ball first (rank 1), then the solids of the polyhedra catalogue in its
//! order (`SOLID_NAMES_LIST`: upstream's Platonic, Archimedean, Catalan, prisms, antiprisms ..., then
//! PolyPack's additions, then the 92 Johnson solids: rank 2, 3, ...). A problem has a piece and a
//! container shape:
//!
//!   balls/ballinball/P          ball in ball (ranks 1, 1)
//!   balls/ballin<solid>/P       ball in a solid (1, solid's rank)
//!   balls/<solid>inball/P       solid in a ball (solid's rank, 1)
//!   polyhedra/<piece>in<container>/P    solid in a solid (both ranks)
//!
//! P starts at 2 in both spaces (the largest P is the space's: 100 for balls, 500 for polyhedra).
//! Loop k = 1, 2, 3 ... covers the problems with max(P - 1, piece rank, container rank) = k: the
//! L-shaped rim of the square of (P - 1, largest rank). Within a loop: by P, then piece rank, then
//! container rank, then kind (balls before polyhedra; a given pair of shapes belongs to one kind).
//! `--solids` narrows the solids (the ball is always in), `--P` / `--max-P` the numbers of pieces.

use crate::options::{SweepKind, SweepOptions};
use crate::sweep_order::{fnv1a, sorted, SweepProblem};
use polypack_balls::{balls_problem_of, BALLS_MAX_P, BALLS_MIN_P};
use polypack_polyhedra::{get_problem, pair_code, POLYHEDRA_MAX_P, SOLID_NAMES_LIST};
use std::collections::HashSet;

/// Smallest P of both spaces.
pub const MIN_P: usize = 2;

#[derive(Clone, Debug, PartialEq)]
pub struct Shape3 {
    /// 1 for the ball, 2, 3 ... for the solids in catalogue order.
    pub rank: usize,
    /// "ball" or the solid's name ("truncated_cube").
    pub name: String,
    /// "ball" or the solid's code ("ttc"), as the ids write it.
    pub code: String,
}

impl Shape3 {
    pub fn is_ball(&self) -> bool {
        self.rank == 1
    }
}

/// The ranked shapes of the catalogue: the ball, then the 186 solids.
pub fn all_shapes() -> Vec<Shape3> {
    let mut v = vec![Shape3 { rank: 1, name: "ball".into(), code: "ball".into() }];
    for (i, s) in SOLID_NAMES_LIST.iter().enumerate() {
        v.push(Shape3 { rank: i + 2, name: s.name.clone(), code: s.code.clone() });
    }
    v
}

pub struct Order3 {
    balls: bool,
    polyhedra: bool,
    /// The shapes swept, by rank: the ball and the chosen solids.
    shapes: Vec<Shape3>,
    solids: Option<Vec<String>>,
    p_filter: Option<HashSet<usize>>,
    balls_max_p: usize,
    polyhedra_max_p: usize,
    loops: usize,
    signature: String,
}

impl Order3 {
    pub fn new(o: &SweepOptions, p: Option<&Vec<usize>>) -> Order3 {
        let balls = o.kinds.contains(&SweepKind::Balls);
        let polyhedra = o.kinds.contains(&SweepKind::Polyhedra);
        let shapes: Vec<Shape3> = all_shapes().into_iter().filter(|s| s.is_ball() || o.solids.as_ref().map_or(true, |l| l.contains(&s.name))).collect();
        let mut order = Order3 {
            balls,
            polyhedra,
            shapes,
            solids: o.solids.clone(),
            p_filter: p.map(|v| v.iter().copied().collect()),
            balls_max_p: BALLS_MAX_P as usize,
            polyhedra_max_p: POLYHEDRA_MAX_P,
            loops: 0,
            signature: String::new(),
        };
        let top_rank = order.shapes.last().map_or(0, |s| s.rank);
        let top_p = |max: usize| (MIN_P..=max).rev().find(|&p| order.p_ok(p));
        let mut loops = 0;
        if balls {
            if let Some(p) = top_p(order.balls_max_p) {
                loops = loops.max((p - 1).max(top_rank));
            }
        }
        if polyhedra && order.shapes.len() > 1 {
            if let Some(p) = top_p(order.polyhedra_max_p) {
                loops = loops.max((p - 1).max(top_rank));
            }
        }
        order.loops = loops;
        let kinds = format!("{}{}", if balls { "b" } else { "" }, if polyhedra { "p" } else { "" });
        let text = format!("3d|{kinds}|{:?}|{:?}", order.solids.as_ref().map(|l| l.join(",")), sorted(&order.p_filter));
        order.signature = format!("{:016x}", fnv1a(text.as_bytes()));
        order
    }

    fn p_ok(&self, p: usize) -> bool {
        p >= MIN_P && self.p_filter.as_ref().map_or(true, |f| f.contains(&p))
    }

    pub fn loops(&self) -> usize {
        self.loops
    }

    pub fn signature(&self) -> &str {
        &self.signature
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.loops == 0
    }

    /// The problem of a piece and a container shape with P pieces: balls when either is the ball,
    /// polyhedra when both are solids; None when that kind is off or P is beyond its largest.
    fn problem(&self, piece: &Shape3, container: &Shape3, p: usize) -> Option<SweepProblem> {
        let ranks = (piece.rank, container.rank);
        if piece.is_ball() || container.is_ball() {
            if !self.balls || p > self.balls_max_p || p < BALLS_MIN_P as usize {
                return None;
            }
            let code = format!("{}in{}", piece.code, container.code);
            // the catalogue has the problem: the ball in the ball, a ball in a solid, a solid in the ball
            balls_problem_of(&code)?;
            Some(SweepProblem { kind: SweepKind::Balls, id: format!("balls/{code}/{p}"), p, ranks })
        } else {
            if !self.polyhedra || p > self.polyhedra_max_p {
                return None;
            }
            let code = pair_code(&piece.name, &container.name)?;
            get_problem(&code)?;
            Some(SweepProblem { kind: SweepKind::Polyhedra, id: format!("polyhedra/{code}/{p}"), p, ranks })
        }
    }

    /// The problems of loop k (1-based), in the sweep's order.
    pub fn loop_problems(&self, k: usize) -> Vec<SweepProblem> {
        let mut out = Vec::new();
        let upto: Vec<&Shape3> = self.shapes.iter().filter(|s| s.rank <= k).collect();
        // the pairs of the rim (the largest rank is k), and every pair, in piece rank then container rank order
        let mut rim: Vec<(&Shape3, &Shape3)> = Vec::new();
        let mut square: Vec<(&Shape3, &Shape3)> = Vec::new();
        let p_top = self.balls_max_p.max(self.polyhedra_max_p);
        let has_rim = upto.last().map_or(false, |s| s.rank == k);
        for a in &upto {
            for b in &upto {
                if a.rank.max(b.rank) == k {
                    rim.push((a, b));
                }
            }
        }
        if k + 1 <= p_top {
            for a in &upto {
                for b in &upto {
                    square.push((a, b));
                }
            }
        }
        for p in MIN_P..=(k + 1).min(p_top) {
            if !self.p_ok(p) {
                continue;
            }
            // below the loop's own P (P - 1 < k) only a shape of rank k closes the square; at P - 1 = k every pair
            let pairs: &[(&Shape3, &Shape3)] = if p - 1 < k {
                if !has_rim {
                    continue;
                }
                &rim
            } else {
                &square
            };
            for (a, b) in pairs {
                if let Some(pr) = self.problem(a, b, p) {
                    out.push(pr);
                }
            }
        }
        out
    }

    /// "balls and polyhedra (187 shapes: the ball and 186 solids)".
    pub fn describe(&self) -> String {
        let kinds: Vec<&str> = [(self.balls, "balls"), (self.polyhedra, "polyhedra")].iter().filter(|k| k.0).map(|k| k.1).collect();
        format!("{} ({} shape{}: the ball and {} solid{})", kinds.join(" and "), self.shapes.len(), if self.shapes.len() == 1 { "" } else { "s" }, self.shapes.len() - 1, if self.shapes.len() == 2 { "" } else { "s" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::options::SweepMode;
    use polypack_spaces::{parse_space_id, space_domain};

    pub fn opts() -> SweepOptions {
        SweepOptions {
            mode: SweepMode::ThreeDInThreeD,
            kinds: SweepKind::ALL_3D.to_vec(),
            surface_modes: Vec::new(),
            solids: None,
            max_n: None,
            restart: false,
            include_own: false,
            open_only: false,
            one_pass: false,
        }
    }

    fn ids(v: &[SweepProblem]) -> Vec<&str> {
        v.iter().map(|p| p.id.as_str()).collect()
    }

    #[test]
    fn the_shapes_are_ranked_ball_first_then_the_catalogue() {
        let shapes = all_shapes();
        assert_eq!(shapes.len(), 187);
        assert_eq!((shapes[0].rank, shapes[0].name.as_str()), (1, "ball"));
        let names: Vec<&str> = shapes.iter().skip(1).take(7).map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron", "truncated_tetrahedron", "cuboctahedron"]);
        assert_eq!(shapes[1].rank, 2);
        assert_eq!(shapes[186].rank, 187);
        assert_eq!(shapes[186].name, "triangular_hebesphenorotunda");
    }

    #[test]
    fn loop_one_is_the_two_balls_and_loop_two_the_first_solids() {
        let order = Order3::new(&opts(), None);
        assert_eq!(ids(&order.loop_problems(1)), ["balls/ballinball/2"]);
        // loop 2: P - 1 = 2 with the ball and the tetrahedron; P = 2 with the tetrahedron on the rim
        let two = order.loop_problems(2);
        assert_eq!(
            ids(&two),
            [
                // P = 2: the rim (a shape of rank 2)
                "balls/ballintet/2",
                "balls/tetinball/2",
                "polyhedra/tetintet/2",
                // P = 3: every pair of the ball and the tetrahedron
                "balls/ballinball/3",
                "balls/ballintet/3",
                "balls/tetinball/3",
                "polyhedra/tetintet/3",
            ]
        );
    }

    #[test]
    fn the_order_within_a_loop_is_p_then_piece_then_container_then_kind() {
        let order = Order3::new(&opts(), None);
        for k in 1..=6 {
            let list = order.loop_problems(k);
            let key: Vec<(usize, usize, usize, usize)> = list.iter().map(|p| (p.p, p.ranks.0, p.ranks.1, p.kind as usize)).collect();
            let mut sorted = key.clone();
            sorted.sort();
            assert_eq!(key, sorted, "loop {k}");
            // loop k: max(P - 1, piece rank, container rank) = k, and every problem exists
            for p in &list {
                assert_eq!((p.p - 1).max(p.ranks.0).max(p.ranks.1), k, "{}", p.id);
                let parsed = parse_space_id(p.kind.space(), &p.id).unwrap_or_else(|e| panic!("{}: {e}", p.id));
                assert!(space_domain(p.kind.space()).unwrap().bound(&parsed).is_some(), "{}", p.id);
            }
            // no problem twice
            let set: HashSet<&str> = ids(&list).into_iter().collect();
            assert_eq!(set.len(), list.len(), "loop {k}");
        }
        // the first loop's counts: 1, 7, ...
        assert_eq!(order.loop_problems(1).len(), 1);
        assert_eq!(order.loop_problems(2).len(), 7);
    }

    #[test]
    fn kinds_pieces_and_containers_follow_the_ids() {
        let order = Order3::new(&opts(), None);
        let three = order.loop_problems(3);
        let find = |id: &str| three.iter().find(|p| p.id == id).unwrap_or_else(|| panic!("{id} not in loop 3"));
        let p = find("balls/cubinball/2");
        assert_eq!((p.kind, p.ranks), (SweepKind::Balls, (3, 1)));
        let p = find("balls/ballincub/4");
        assert_eq!((p.kind, p.ranks), (SweepKind::Balls, (1, 3)));
        let p = find("polyhedra/cubintet/2");
        assert_eq!((p.kind, p.ranks), (SweepKind::Polyhedra, (3, 2)));
        let p = find("polyhedra/tetincub/4");
        assert_eq!((p.kind, p.ranks), (SweepKind::Polyhedra, (2, 3)));
        // P = 4 is the loop's own P (P - 1 = 3): every pair of ranks up to 3, 9 pairs
        assert_eq!(three.iter().filter(|p| p.p == 4).count(), 9);
        // P = 2 and 3: the 5 pairs with a cube
        assert_eq!(three.iter().filter(|p| p.p == 2).count(), 5);
    }

    #[test]
    fn the_largest_p_and_the_last_loop() {
        let order = Order3::new(&opts(), None);
        // polyhedra go to P = 500: loop 499; balls stop at P = 100
        assert_eq!(order.loops(), 499);
        let l187 = order.loop_problems(187);
        assert!(l187.iter().any(|p| p.ranks.0 == 187 || p.ranks.1 == 187));
        // beyond the ranks only P - 1 = k: every pair of solids, and no ball problem past P = 100
        let l200 = order.loop_problems(200);
        assert_eq!(l200.len(), 186 * 186);
        assert!(l200.iter().all(|p| p.kind == SweepKind::Polyhedra && p.p == 201));
        assert_eq!(order.loop_problems(499).len(), 186 * 186);
        assert!(order.loop_problems(500).is_empty());
        let balls = Order3::new(&SweepOptions { kinds: vec![SweepKind::Balls], ..opts() }, None);
        assert_eq!(balls.loops(), 187);
        // loop 100: P = 101 is beyond the balls' largest P: only the rim of rank-100 shapes with P <= 100
        assert!(balls.loop_problems(100).iter().all(|p| p.p <= 100));
        assert!(balls.loop_problems(150).iter().all(|p| p.p <= 100));
    }

    #[test]
    fn filters_narrow_the_sweep() {
        let o = SweepOptions { solids: Some(vec!["cube".into(), "tetrahedron".into()]), ..opts() };
        let order = Order3::new(&o, Some(&vec![2, 3, 4]));
        // the ball, the tetrahedron (rank 2) and the cube (rank 3); P up to 4: last loop max(3, 3)
        assert_eq!(order.loops(), 3);
        assert_eq!(ids(&order.loop_problems(1)), ["balls/ballinball/2"]);
        let all: Vec<String> = (1..=3).flat_map(|k| order.loop_problems(k)).map(|p| p.id).collect();
        // 3 shapes: P = 2, 3, 4 each with 9 pairs (every pair exists in one kind)
        assert_eq!(all.len(), 27);
        let one = SweepOptions { kinds: vec![SweepKind::Polyhedra], solids: Some(vec!["cube".into()]), ..opts() };
        let order = Order3::new(&one, Some(&vec![2, 3]));
        let all: Vec<String> = (1..=order.loops()).flat_map(|k| order.loop_problems(k)).map(|p| p.id).collect();
        assert_eq!(all, ["polyhedra/cubincub/2", "polyhedra/cubincub/3"]);
        assert_eq!(order.describe(), "polyhedra (2 shapes: the ball and 1 solid)");
        // balls only, no solid beyond the ball: the ball in the ball
        let o = SweepOptions { kinds: vec![SweepKind::Balls], solids: Some(vec![]), ..opts() };
        let order = Order3::new(&o, Some(&vec![2]));
        assert_eq!(ids(&order.loop_problems(1)), ["balls/ballinball/2"]);
        assert_eq!(order.loops(), 1);
        // nothing: polyhedra without a solid
        let o = SweepOptions { kinds: vec![SweepKind::Polyhedra], solids: Some(vec![]), ..opts() };
        assert!(Order3::new(&o, None).is_empty());
        // P = 1 is no problem of either space
        assert!(Order3::new(&opts(), Some(&vec![1])).is_empty());
    }

    #[test]
    fn the_signature_follows_the_options() {
        let a = Order3::new(&opts(), None);
        assert_eq!(a.signature(), Order3::new(&opts(), None).signature());
        assert_ne!(a.signature(), Order3::new(&opts(), Some(&vec![2, 3])).signature());
        assert_ne!(a.signature(), Order3::new(&SweepOptions { kinds: vec![SweepKind::Balls], ..opts() }, None).signature());
        assert_ne!(a.signature(), Order3::new(&SweepOptions { solids: Some(vec!["cube".into()]), ..opts() }, None).signature());
    }

    /// Prints the first problems of loops 1 to 3 as the sweep visits them (cargo test -- --nocapture).
    #[test]
    fn prints_the_first_loops() {
        let order = Order3::new(&opts(), None);
        for k in 1..=3 {
            let list = order.loop_problems(k);
            println!("loop {k}: {} problems", list.len());
            for (i, p) in list.iter().take(30).enumerate() {
                println!("  {:2}. {}", i + 1, p.id);
            }
        }
    }
}
