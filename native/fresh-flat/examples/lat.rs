use polypack_fresh_flat::{geom::Shape, lattice::lattices};
fn main() {
    for n in [0usize, 3, 4, 5, 6, 7, 8] {
        let sh = Shape::new(n, 0);
        let t = std::time::Instant::now();
        let ls = lattices(&sh);
        let d: Vec<String> = ls.iter().map(|l| format!("{:.4}({})", l.density, l.motif.len())).collect();
        println!("n={n} {:?} {:.1}ms", d, t.elapsed().as_secs_f64() * 1e3);
    }
}
