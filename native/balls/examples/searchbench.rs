//! Times `search_balls` on one problem: `cargo run --release -p polypack-balls --example searchbench -- balls/ballinball/40 1 30000`
//! (id, seed, evaluations).

use polypack_balls::auto::parse_id;
use polypack_balls::search::{search_balls, BallsSearchOptions};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let b = parse_id(&a[1]).expect("a balls id");
    let mut o = BallsSearchOptions::new(a[2].parse().unwrap());
    o.max_evals = a[3].parse().unwrap();
    let t = Instant::now();
    let r = search_balls(b.problem, b.p, &o).unwrap();
    println!("{} score {} evaluations {} hops {} in {:.3} s", a[1], r.score, r.evaluations, r.hops, t.elapsed().as_secs_f64());
}
