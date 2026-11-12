//! Small dense linear algebra for d <= 10, on row-major slices (packages/ndim/src/linalg.ts).
//! The server's bundle keeps `solve` and `dot` of that file.

/// packages/ndim/src/linalg.ts: solve. Solves A X = B for square A (n x n) and B (n x m) by
/// Gaussian elimination with partial pivoting; None when singular.
pub fn solve(a: &[f64], b: &[f64], n: usize, m: usize) -> Option<Vec<f64>> {
    let w = n + m;
    let mut mm = vec![0.0f64; n * w];
    for i in 0..n {
        for j in 0..n {
            mm[i * w + j] = a[i * n + j];
        }
        for j in 0..m {
            mm[i * w + n + j] = b[i * m + j];
        }
    }
    for c in 0..n {
        let mut p = c;
        let mut best = mm[c * w + c].abs();
        for r in c + 1..n {
            let v = mm[r * w + c].abs();
            if v > best {
                best = v;
                p = r;
            }
        }
        if !(best > 1e-300) {
            return None;
        }
        if p != c {
            for j in 0..w {
                mm.swap(c * w + j, p * w + j);
            }
        }
        let piv = mm[c * w + c];
        for j in c..w {
            mm[c * w + j] /= piv;
        }
        for r in 0..n {
            if r == c {
                continue;
            }
            let f = mm[r * w + c];
            if f == 0.0 {
                continue;
            }
            for j in c..w {
                mm[r * w + j] -= f * mm[c * w + j];
            }
        }
    }
    let mut x = vec![0.0f64; n * m];
    for i in 0..n {
        for j in 0..m {
            x[i * m + j] = mm[i * w + n + j];
        }
    }
    Some(x)
}

/// packages/ndim/src/linalg.ts: dot. The sum of a[ao + i] * b[bo + i] for i < d, added in order
/// from 0.
#[inline]
pub fn dot(a: &[f64], b: &[f64], d: usize, ao: usize, bo: usize) -> f64 {
    let a = &a[ao..ao + d];
    let b = &b[bo..bo + d];
    let mut s = 0.0f64;
    for i in 0..d {
        s += a[i] * b[i];
    }
    s
}
