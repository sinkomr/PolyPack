//! Development: checks the lattice start of torus/sq/<N>/<P> and prints the check's reasons.
use fresh_torus::geom::{min_separation, repair_scale, Family, Shape};
use fresh_torus::lattice::superlattice;
use fresh_torus::search::{config_value, normalize_frame};
use polypack_spaces::{validate_space_submission, SpaceName, SpaceValidateOptions};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let n: usize = a[0].parse().unwrap();
    let p: usize = a[1].parse().unwrap();
    let sh = Shape::new(n);
    let fam = Family::Sq;
    let mut s = superlattice(&sh, fam, p, 1, None).remove(0).sol;
    normalize_frame(fam, &mut s);
    let lam = repair_scale(&sh, &s, 1e-13);
    println!("lam {lam} ms {} s {}", min_separation(&sh, &s), s.s);
    s.scale(lam);
    normalize_frame(fam, &mut s);
    println!("after ms {}", min_separation(&sh, &s));
    let cfg = config_value(fam, &s);
    let id = format!("torus/sq/{n}/{p}");
    let v = validate_space_submission(SpaceName::Torus, &id, &cfg, &SpaceValidateOptions { no_record: true, ..Default::default() });
    println!("valid {} reasons {:?}", v.valid, &v.reasons[..v.reasons.len().min(3)]);
    let v = validate_space_submission(SpaceName::Torus, &id, &cfg, &SpaceValidateOptions::default());
    println!("default valid {} reasons {:?}", v.valid, &v.reasons[..v.reasons.len().min(3)]);
}
