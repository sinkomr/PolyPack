//! Time of `fmt::num` per call, in nanoseconds: `cargo run --release -p polypack-js --example fmtbench`.
use polypack_js::fmt;
use std::time::Instant;

fn main() {
    let xs: Vec<f64> = (0..200_000u64).map(|i| ((i * 2654435761 % 1000003) as f64).sin() * 1e-7 * (1 + i % 9) as f64).collect();
    let t = Instant::now();
    let mut n = 0usize;
    for &x in &xs {
        n += fmt::num(x).len();
    }
    println!("fmt::num: {:.0} ns per call ({} characters)", t.elapsed().as_nanos() as f64 / xs.len() as f64, n);
}
