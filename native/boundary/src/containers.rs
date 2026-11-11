//! Vertex lists of the six regular convex 4-polytopes, the containers of the boundary space, with
//! unit edge and centred at the origin. Port of packages/boundary/src/containers.ts.
//!
//!  - tesseract: polytope.rs (tesseract_vertices).
//!  - 5-cell: the regular simplex (1, 1, 1, -1/sqrt 5), (1, -1, -1, -1/sqrt 5), (-1, 1, -1, -1/sqrt 5),
//!    (-1, -1, 1, -1/sqrt 5), (0, 0, 0, 4/sqrt 5), edge sqrt 8.
//!  - 16-cell: +-e_i, edge sqrt 2.
//!  - 24-cell: the permutations of (+-1, +-1, 0, 0), edge sqrt 2.
//!  - 600-cell: unit circumradius; (+-1, 0, 0, 0) and permutations, (+-1/2, +-1/2, +-1/2, +-1/2), and
//!    the even permutations of (+-phi, +-1, +-1/phi, 0) / 2; edge 1/phi.
//!  - 120-cell: the standard coordinates of circumradius 2 sqrt 2 and edge 3 - sqrt 5 (Coxeter).
//! The generators return the vertices before the unit-edge scale (RAW); `unit_vertices` scales.
//!
//! These lists feed `build_polytope`, which builds the server's polytopes (polytope.rs: `get_polytope`).

use polypack_js::math;

fn phi() -> f64 {
    (1.0 + 5f64.sqrt()) / 2.0
}
fn sq5() -> f64 {
    5f64.sqrt()
}

fn permutations(even_only: bool) -> Vec<Vec<usize>> {
    fn perm(a: Vec<usize>, rest: Vec<usize>, even_only: bool, out: &mut Vec<Vec<usize>>) {
        if rest.is_empty() {
            if even_only {
                let mut inv = 0;
                for i in 0..4 {
                    for j in i + 1..4 {
                        if a[i] > a[j] {
                            inv += 1;
                        }
                    }
                }
                if inv % 2 == 0 {
                    out.push(a);
                }
            } else {
                out.push(a);
            }
            return;
        }
        for &r in &rest {
            let mut a2 = a.clone();
            a2.push(r);
            perm(a2, rest.iter().copied().filter(|&x| x != r).collect(), even_only, out);
        }
    }
    let mut out = Vec::new();
    perm(vec![], vec![0, 1, 2, 3], even_only, &mut out);
    out
}

/// The 12 even permutations of (0, 1, 2, 3), in lexicographic order.
/// packages/boundary/src/containers.ts: EVEN_PERMUTATIONS
pub fn even_permutations() -> Vec<Vec<usize>> {
    permutations(true)
}

/// All 24 permutations of (0, 1, 2, 3), in lexicographic order.
/// packages/boundary/src/containers.ts: ALL_PERMUTATIONS
fn all_permutations() -> Vec<Vec<usize>> {
    permutations(false)
}

/// The points obtained from `base` by the given permutations (point[perm[i]] = base[i]) and every
/// sign choice on the nonzero entries, deduplicated in order of first appearance. A sign pattern
/// runs through the nonzero entries of `base` in order, the first entry's sign changing slowest,
/// + before -.
/// packages/boundary/src/containers.ts: signedPoints
pub fn signed_points(base: &[f64], perms: &[Vec<usize>]) -> Vec<Vec<f64>> {
    let nz: Vec<usize> = (0..base.len()).filter(|&i| base[i] != 0.0).collect();
    let mut out: Vec<Vec<f64>> = Vec::new();
    // the source keys a Set by `p.join(",")`: the text of a double identifies it, except that -0
    // and 0 print alike, so points are compared with ==
    for perm in perms {
        for m in 0..(1usize << nz.len()) {
            let mut p = vec![0.0; 4];
            for (i, &x) in base.iter().enumerate() {
                let k = nz.iter().position(|&t| t == i);
                let sign = match k {
                    Some(k) if (m >> (nz.len() - 1 - k)) & 1 == 1 => -1.0,
                    _ => 1.0,
                };
                p[perm[i]] = sign * x;
            }
            if !out.iter().any(|q| q.iter().zip(&p).all(|(a, b)| a == b)) {
                out.push(p);
            }
        }
    }
    out
}

/// Raw (unscaled) vertices of a container other than the tesseract, in the order the exact side repeats.
/// packages/boundary/src/containers.ts: rawVertices
pub fn raw_vertices(name: &str) -> Option<Vec<Vec<f64>>> {
    let phi = phi();
    let sq5 = sq5();
    let all = all_permutations();
    let even = even_permutations();
    Some(match name {
        "5cell" => {
            let a = 1.0 / sq5;
            vec![
                vec![1.0, 1.0, 1.0, -a],
                vec![1.0, -1.0, -1.0, -a],
                vec![-1.0, 1.0, -1.0, -a],
                vec![-1.0, -1.0, 1.0, -a],
                vec![0.0, 0.0, 0.0, 4.0 * a],
            ]
        }
        "16cell" => {
            let mut out = Vec::new();
            for i in 0..4 {
                for sg in [-1.0, 1.0] {
                    let mut p = vec![0.0; 4];
                    p[i] = sg;
                    out.push(p);
                }
            }
            out
        }
        "24cell" => signed_points(&[1.0, 1.0, 0.0, 0.0], &all),
        "600cell" => {
            let mut out = signed_points(&[1.0, 0.0, 0.0, 0.0], &all);
            out.extend(signed_points(&[0.5, 0.5, 0.5, 0.5], &[vec![0, 1, 2, 3]]));
            out.extend(signed_points(&[phi / 2.0, 0.5, 1.0 / phi / 2.0, 0.0], &even));
            out
        }
        "120cell" => {
            let ip = 1.0 / phi;
            let mut out = signed_points(&[0.0, 0.0, 2.0, 2.0], &all);
            out.extend(signed_points(&[1.0, 1.0, 1.0, sq5], &all));
            out.extend(signed_points(&[ip * ip, phi, phi, phi], &all));
            out.extend(signed_points(&[ip, ip, ip, phi * phi], &all));
            out.extend(signed_points(&[0.0, ip * ip, 1.0, phi * phi], &even));
            out.extend(signed_points(&[0.0, ip, phi, sq5], &even));
            out.extend(signed_points(&[ip, 1.0, phi, 2.0], &even));
            out
        }
        _ => return None,
    })
}

/// The edge of the raw vertex list (before scaling), as a float.
/// packages/boundary/src/containers.ts: RAW_EDGE
pub fn raw_edge(name: &str) -> Option<f64> {
    Some(match name {
        "5cell" => 8f64.sqrt(),
        "16cell" => math::SQRT2,
        "24cell" => math::SQRT2,
        "600cell" => 1.0 / phi(),
        "120cell" => 3.0 - sq5(),
        _ => return None,
    })
}

/// Unit-edge vertices of a container other than the tesseract.
/// packages/boundary/src/containers.ts: unitVertices
pub fn unit_vertices(name: &str) -> Option<Vec<Vec<f64>>> {
    let e = raw_edge(name)?;
    Some(raw_vertices(name)?.into_iter().map(|v| v.into_iter().map(|x| x / e).collect()).collect())
}
