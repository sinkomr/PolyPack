// Densities of the periodic arrangements used as starts, and the time to build them:
//   cargo run --release -p polypack-fresh-flat --example lat [N ...]
use polypack_fresh_flat::{geom::Shape, lattice::lattices};
fn main() {
    let ns: Vec<usize> = std::env::args().skip(1).filter_map(|a| a.parse().ok()).collect();
    let ns = if ns.is_empty() { vec![0, 3, 4, 5, 6, 7, 8, 9, 12, 17, 25, 40, 64, 97, 100] } else { ns };
    for n in ns {
        let sh = Shape::new(n, 0);
        let t = std::time::Instant::now();
        let ls = lattices(&sh);
        let d: Vec<String> = ls.iter().map(|l| format!("{:.4}({})", l.density, l.motif.len())).collect();
        println!("n={n} {:?} {:.1}ms", d, t.elapsed().as_secs_f64() * 1e3);
    }
}
