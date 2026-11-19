//! Contact points of two convex polytopes along a separating (or penetration) direction, for the
//! gradient of their separation with respect to the pieces' rotations
//! (packages/ndspace/src/contact.ts).
//!
//! The signed separation of A and B along its optimal unit direction u is sep = min_B u.y - max_A
//! u.x. Its derivative with respect to anything that moves the pieces is u . (d b* - d a*) at the
//! contact points a* and b*, not at an arbitrary vertex: where the contact is an edge against an
//! edge (the generic case of two polytopes in contact) the two vertices of each edge tie along u,
//! and the contact points are the points of the edges nearest to each other. They solve "P(a - b) =
//! 0 for a in the face F_A of A that maximises u.x, b in the face F_B of B that minimises u.y", P
//! the projection orthogonal to u: the minimum-norm point of the polytope {P(a_i - b_j)}, which GJK
//! finds (gjk.rs closest_points) with a corral of at most d points whose convex weights give a* and
//! b*.

use crate::gjk::closest_points;

/// contact.ts: Contact. Vertex indices of A and the convex weights (sum 1) whose combination is a*,
/// and the same for B.
#[derive(Debug, Clone, Default)]
pub struct Contact {
    pub ia: Vec<usize>,
    pub wa: Vec<f64>,
    pub ib: Vec<usize>,
    pub wb: Vec<f64>,
}

/// contact.ts: MAX_PAIRS. Faces with more vertex pairs than this are taken at their centroids (the
/// separation is not smooth there anyway).
const MAX_PAIRS: usize = 1024;
const EPS: f64 = 1e-9;

/// contact.ts: solveSmall. Solves the small dense system M x = r (Gaussian elimination, partial
/// pivoting); None when singular. `m` is row-major n x n.
fn solve_small(m: &[Vec<f64>], r: &[f64]) -> Option<Vec<f64>> {
    let n = r.len();
    let mut a: Vec<Vec<f64>> = (0..n)
        .map(|i| {
            let mut row = m[i].clone();
            row.push(r[i]);
            row
        })
        .collect();
    for c in 0..n {
        let mut p = c;
        for i in c + 1..n {
            if a[i][c].abs() > a[p][c].abs() {
                p = i;
            }
        }
        if !(a[p][c].abs() > 1e-300) {
            return None;
        }
        a.swap(c, p);
        for i in 0..n {
            if i == c {
                continue;
            }
            let f = a[i][c] / a[c][c];
            if f != 0.0 {
                for j in c..=n {
                    let t = f * a[c][j];
                    a[i][j] -= t;
                }
            }
        }
    }
    Some((0..n).map(|i| a[i][n] / a[i][i]).collect())
}

fn uniform(f: &[usize]) -> Vec<f64> {
    f.iter().map(|_| 1.0 / f.len() as f64).collect()
}

/// contact.ts: contactPoints. `xa` and `xb` are the world vertices of the two pieces (nV x d, flat),
/// `u` the unit direction.
pub fn contact_points(xa: &[f64], xb: &[f64], n_v: usize, d: usize, u: &[f64]) -> Contact {
    let mut max_a = f64::NEG_INFINITY;
    let mut min_b = f64::INFINITY;
    let mut pa = vec![0.0f64; n_v];
    let mut pb = vec![0.0f64; n_v];
    for v in 0..n_v {
        let mut sa = 0.0f64;
        let mut sb = 0.0f64;
        for c in 0..d {
            sa += u[c] * xa[v * d + c];
            sb += u[c] * xb[v * d + c];
        }
        pa[v] = sa;
        pb[v] = sb;
        if sa > max_a {
            max_a = sa;
        }
        if sb < min_b {
            min_b = sb;
        }
    }
    let mut fa: Vec<usize> = Vec::new();
    let mut fb: Vec<usize> = Vec::new();
    for v in 0..n_v {
        if pa[v] >= max_a - EPS {
            fa.push(v);
        }
        if pb[v] <= min_b + EPS {
            fb.push(v);
        }
    }
    if fa.len() == 1 && fb.len() == 1 {
        return Contact { ia: fa, wa: vec![1.0], ib: fb, wb: vec![1.0] };
    }
    if fa.len() * fb.len() > MAX_PAIRS {
        let (wa, wb) = (uniform(&fa), uniform(&fb));
        return Contact { ia: fa, wa, ib: fb, wb };
    }
    // the polytope of the tangential differences P(a_i - b_j)
    let n_z = fa.len() * fb.len();
    let mut z = vec![0.0f64; n_z * d];
    let mut tmp = vec![0.0f64; d];
    let mut k = 0;
    for &i in &fa {
        for &j in &fb {
            let mut dp = 0.0f64;
            for c in 0..d {
                tmp[c] = xa[i * d + c] - xb[j * d + c];
                dp += tmp[c] * u[c];
            }
            for c in 0..d {
                z[k * d + c] = tmp[c] - dp * u[c];
            }
            k += 1;
        }
    }
    let res = closest_points(&z, n_z, &vec![0.0f64; d], 1, d);
    let corral = &res.corral;
    // convex weights of the minimum-norm point of the corral's affine hull
    let m = corral.len();
    let mut lam: Vec<f64> = vec![1.0];
    if m > 1 {
        let mut mat: Vec<Vec<f64>> = Vec::new();
        for i in 0..m {
            let mut row: Vec<f64> = Vec::new();
            for j in 0..m {
                let mut g = 0.0f64;
                for c in 0..d {
                    g += corral[i][c] * corral[j][c];
                }
                row.push(g);
            }
            row.push(1.0);
            mat.push(row);
        }
        let mut last = vec![1.0f64; m];
        last.push(0.0);
        mat.push(last);
        let mut rhs = vec![0.0f64; m];
        rhs.push(1.0);
        match solve_small(&mat, &rhs) {
            Some(sol) => {
                // Math.max(0, v): NaN stays NaN
                lam = sol[..m].iter().map(|&v| polypack_js::math::max(0.0, v)).collect();
                let mut tot = 0.0f64;
                for &v in &lam {
                    tot += v;
                }
                lam = if tot > 0.0 { lam.iter().map(|&v| v / tot).collect() } else { vec![1.0 / m as f64; m] };
            }
            None => lam = vec![1.0 / m as f64; m],
        }
    }
    let mut out = Contact::default();
    for q in 0..m {
        // the corral point is an exact copy of one row of Z
        let mut at: Option<usize> = None;
        let mut r = 0;
        while r < n_z && at.is_none() {
            let mut same = true;
            let mut c = 0;
            while c < d && same {
                same = z[r * d + c] == corral[q][c];
                c += 1;
            }
            if same {
                at = Some(r);
            }
            r += 1;
        }
        let Some(at) = at else { continue };
        if !(lam[q] > 0.0) {
            continue;
        }
        out.ia.push(fa[at / fb.len()]);
        out.ib.push(fb[at % fb.len()]);
        out.wa.push(lam[q]);
        out.wb.push(lam[q]);
    }
    if out.ia.is_empty() {
        let (wa, wb) = (uniform(&fa), uniform(&fb));
        return Contact { ia: fa, wa, ib: fb, wb };
    }
    out
}
