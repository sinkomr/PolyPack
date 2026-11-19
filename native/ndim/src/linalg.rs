//! Small dense linear algebra for d <= 10, on row-major slices (packages/ndim/src/linalg.ts).
//! The server's bundle keeps `solve` and `dot` of that file; `det`, `transpose` and `matmul` are the
//! search's (the matrix-to-pose functions of pose.rs), and `inverse_into`, `mul_into` and
//! `orthonormalise` are the kernel's own copy in packages/ndspace/src/linalg.ts.

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

/// packages/ndim/src/linalg.ts: det. Determinant of the n x n matrix A.
pub fn det(a: &[f64], n: usize) -> f64 {
    let mut m = a.to_vec();
    let mut out = 1.0f64;
    for c in 0..n {
        let mut p = c;
        for r in c + 1..n {
            if m[r * n + c].abs() > m[p * n + c].abs() {
                p = r;
            }
        }
        if m[p * n + c] == 0.0 {
            return 0.0;
        }
        if p != c {
            for j in 0..n {
                m.swap(c * n + j, p * n + j);
            }
            out = -out;
        }
        out *= m[c * n + c];
        for r in c + 1..n {
            let f = m[r * n + c] / m[c * n + c];
            for j in c..n {
                m[r * n + j] -= f * m[c * n + j];
            }
        }
    }
    out
}

/// packages/ndim/src/linalg.ts: transpose. A^T.
pub fn transpose(a: &[f64], n: usize) -> Vec<f64> {
    let mut t = vec![0.0f64; n * n];
    for i in 0..n {
        for j in 0..n {
            t[j * n + i] = a[i * n + j];
        }
    }
    t
}

/// packages/ndim/src/linalg.ts: matmul. A B for n x n matrices.
pub fn matmul(a: &[f64], b: &[f64], n: usize) -> Vec<f64> {
    let mut c = vec![0.0f64; n * n];
    for i in 0..n {
        for k in 0..n {
            let x = a[i * n + k];
            if x == 0.0 {
                continue;
            }
            for j in 0..n {
                c[i * n + j] += x * b[k * n + j];
            }
        }
    }
    c
}

/// packages/ndspace/src/linalg.ts: inverse (the search kernel's own copy). Inverse of an n x n
/// matrix by Gauss-Jordan with partial pivoting, written to `out`; false when singular. `work` is
/// scratch of n * 2n numbers.
pub fn inverse_into(a: &[f64], n: usize, work: &mut [f64], out: &mut [f64]) -> bool {
    let w = 2 * n;
    let m = &mut work[..n * w];
    m.fill(0.0);
    for i in 0..n {
        for j in 0..n {
            m[i * w + j] = a[i * n + j];
        }
        m[i * w + n + i] = 1.0;
    }
    for c in 0..n {
        let mut p = c;
        for r in c + 1..n {
            if m[r * w + c].abs() > m[p * w + c].abs() {
                p = r;
            }
        }
        if !(m[p * w + c].abs() > 1e-300) {
            return false;
        }
        if p != c {
            for j in 0..w {
                m.swap(c * w + j, p * w + j);
            }
        }
        let piv = m[c * w + c];
        for j in 0..w {
            m[c * w + j] /= piv;
        }
        for r in 0..n {
            if r == c {
                continue;
            }
            let f = m[r * w + c];
            if f == 0.0 {
                continue;
            }
            for j in 0..w {
                m[r * w + j] -= f * m[c * w + j];
            }
        }
    }
    for i in 0..n {
        for j in 0..n {
            out[i * n + j] = m[i * w + n + j];
        }
    }
    true
}

/// packages/ndspace/src/linalg.ts: mul. A B for n x n matrices, written to `out` (which is zeroed
/// first, as the source does); a zero entry of A skips its row of B.
pub fn mul_into(a: &[f64], b: &[f64], n: usize, out: &mut [f64]) {
    out[..n * n].fill(0.0);
    for i in 0..n {
        for k in 0..n {
            let x = a[i * n + k];
            if x == 0.0 {
                continue;
            }
            for j in 0..n {
                out[i * n + j] += x * b[k * n + j];
            }
        }
    }
}

/// packages/ndspace/src/linalg.ts: orthonormalise. Gram-Schmidt on the columns of M: the
/// nearest-ish orthonormal matrix (keeps the rotation from drifting).
pub fn orthonormalise(m: &mut [f64], n: usize) {
    for c in 0..n {
        for p in 0..c {
            let mut f = 0.0f64;
            for i in 0..n {
                f += m[i * n + c] * m[i * n + p];
            }
            for i in 0..n {
                m[i * n + c] -= f * m[i * n + p];
            }
        }
        let mut l = 0.0f64;
        for i in 0..n {
            l += m[i * n + c] * m[i * n + c];
        }
        l = l.sqrt();
        for i in 0..n {
            m[i * n + c] /= l;
        }
    }
}
