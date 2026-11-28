//! Prints the periodic arrangements of a few pieces and the time they take (development).
use fresh_surface_nofold::geom::Piece;
use fresh_surface_nofold::lattice::lattices;
use std::time::Instant;

fn main() {
    for n in [0usize, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 30, 50, 100] {
        let t = Instant::now();
        let l = lattices(&Piece::new(n));
        let ds: Vec<String> = l.iter().map(|x| format!("{:.4}({})", x.density, x.motif.len())).collect();
        println!("N={n:3} {:7.2} ms {}", t.elapsed().as_secs_f64() * 1e3, ds.join(" "));
    }
}
