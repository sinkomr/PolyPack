//! The fallback of the pair test: a max-margin separating hyperplane of two vertex sets by linear
//! programming (packages/ndim/src/margin.ts).
//!
//! For unit vectors u (Euclidean norm 1) the gap of u is gap(u) = min over B of u.y - max over A of
//! u.x, and the signed separation of the hulls is sep = max over u of gap(u) (the distance when
//! positive, minus the penetration depth when not). The LP maximises the same expression over the
//! box instead of the sphere:
//!
//!   g = max { delta : a.x <= b - delta/2 on A, a.y >= b + delta/2 on B, |a|_inf = 1 }.
//!
//! (Without a normalisation the LP is useless: a = 0 is feasible with delta = 0, which would call
//! every overlapping pair touching. |a|_inf = 1 is not a linear constraint, so the LP is solved 2d
//! times, once for each coordinate fixed to a_i = +1 or -1 with the others in [-1, 1]; g is the
//! largest of the 2d optima.)
//!
//! The relation to the Euclidean separation, from |a|_inf <= |a|_2 <= sqrt(d) |a|_inf [CALC]:
//!  - g >= 0 (separable): g / sqrt(d) <= sep <= g;
//!  - g <  0 (overlap, depth D = -sep): -sqrt(d) D <= g <= -D, so g <= sep <= g / sqrt(d).
//!
//! Hence the decisions (tol >= 0, sep the Euclidean separation):
//!  - accept: for the optimal a of a branch, u = a / |a|_2 has gap(u) = g_a / |a|_2, and the gap of
//!    any unit vector is a lower bound of sep (sep is their maximum). gap(u) >= -tol therefore
//!    proves sep >= -tol, whatever the LP did;
//!  - refuse: g < -sqrt(d) tol gives D > tol, a true overlap by more than tol (this uses the LP's
//!    upper bound t);
//!  - otherwise (-sqrt(d) tol <= g, no certificate): inconclusive, the caller refuses. The band is
//!    empty at tol = 0.
//!
//! Each of the 2d LPs has d unknowns and one constraint per vertex, so it is solved by cutting
//! planes (Kelley's method): the master LP keeps a pool of constraints t <= a.w_k, where
//! w_k = y - x for the pairs the current a selects as most violated (the point of B - A minimising
//! a.w, found in O(nV d) from the vertex lists), and is solved by a dense simplex with Bland's
//! anti-cycling rule. The pool is shared by the 2d branches. The master value t is an upper bound
//! of the branch optimum, the true value g(a) of the master's a a lower bound; they meet when the
//! polytope has been cut enough, which for polytopes happens after finitely many cuts.
use crate::linalg::dot;
use polypack_js::math;

/// packages/ndim/src/margin.ts: MarginOptions.
#[derive(Debug, Clone, Copy, Default)]
pub struct MarginOptions {
    /// Stop with `separated` as soon as a unit direction with gap at least this is certified
    /// (typically -tol). Default +Infinity.
    pub accept_at: Option<f64>,
    /// Stop with `overlapping` once the optimum is proved below this (typically -sqrt(d) tol: the
    /// box margin g). Default -Infinity.
    pub refuse_below: Option<f64>,
    /// Cuts in the shared pool, default 260.
    pub max_cuts: Option<usize>,
    /// Master solves per branch, default 140.
    pub max_rounds: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarginVerdict {
    /// A certified gap >= acceptAt.
    Separated,
    /// Proved below refuseBelow.
    Overlapping,
    /// Neither.
    Open,
}

/// packages/ndim/src/margin.ts: MarginResult.
#[derive(Debug, Clone)]
pub struct MarginResult {
    /// Certified lower bound of the signed separation: the gap of the unit vector `dir`.
    pub lower: f64,
    /// The unit vector achieving `lower` (pointing from A to B), None if none was evaluated.
    pub dir: Option<Vec<f64>>,
    /// Upper bound of the signed separation (see the module comment), valid when `conclusive`; else
    /// +Infinity.
    pub upper: f64,
    /// The LP optima of all 2d branches were bracketed (or a stopping threshold was reached).
    pub conclusive: bool,
    pub verdict: MarginVerdict,
    /// Master solves done (a measure of the work).
    pub rounds: usize,
}

/// packages/ndim/src/margin.ts: simplexMax. Dense simplex for: maximise z[n-1] subject to
/// G z <= h, z >= 0, with h >= 0 (so z = 0 is feasible). G is m x n, row-major. Compact (Tucker)
/// tableau and Bland's rule once degenerate pivots pile up. Returns z, or None if the pivot cap was
/// hit.
fn simplex_max(g: &[f64], h: &[f64], m: usize, n: usize, max_pivots: usize) -> Option<Vec<f64>> {
    let w = n + 1;
    let mut t = vec![0.0f64; (m + 1) * w];
    for i in 0..m {
        for j in 0..n {
            t[i * w + j] = g[i * n + j];
        }
        t[i * w + n] = math::max(0.0, h[i]);
    }
    t[m * w + n - 1] = -1.0; // objective row: obj = T[m][n] - sum T[m][j] z_j, so -1 means "increasing z[n-1] gains 1"
    let mut row_var: Vec<usize> = (0..m).map(|i| n + i).collect();
    let mut col_var: Vec<usize> = (0..n).collect();
    const EPS: f64 = 1e-11;
    let mut degenerate = 0;
    for _it in 0..max_pivots {
        let mut q: Option<usize> = None;
        if degenerate < 30 {
            let mut best = -EPS;
            for j in 0..n {
                if t[m * w + j] < best {
                    best = t[m * w + j];
                    q = Some(j);
                }
            }
        } else {
            // Bland: the entering column of the smallest variable label (`lab` starts at Infinity)
            let mut lab = usize::MAX;
            for j in 0..n {
                if t[m * w + j] < -EPS && col_var[j] < lab {
                    lab = col_var[j];
                    q = Some(j);
                }
            }
        }
        let Some(q) = q else {
            let mut z = vec![0.0f64; n];
            for i in 0..m {
                if row_var[i] < n {
                    z[row_var[i]] = t[i * w + n];
                }
            }
            return Some(z);
        };
        let mut r: Option<usize> = None;
        let mut ratio = f64::INFINITY;
        for i in 0..m {
            let c = t[i * w + q];
            if c > EPS {
                let rt = t[i * w + n] / c;
                if rt < ratio - 1e-14 || (rt <= ratio + 1e-14 && r.is_some_and(|r| row_var[i] < row_var[r])) {
                    ratio = rt;
                    r = Some(i);
                }
            }
        }
        let r = r?; // unbounded: cannot happen with the bound rows, so numerical trouble
        degenerate = if ratio < 1e-13 { degenerate + 1 } else { 0 };
        let piv = t[r * w + q];
        for j in 0..w {
            if j != q {
                t[r * w + j] /= piv;
            }
        }
        t[r * w + q] = 1.0 / piv;
        for i in 0..=m {
            if i == r {
                continue;
            }
            let f = t[i * w + q];
            if f == 0.0 {
                continue;
            }
            for j in 0..w {
                if j != q {
                    t[i * w + j] -= f * t[r * w + j];
                }
            }
            t[i * w + q] = -f / piv;
        }
        std::mem::swap(&mut row_var[r], &mut col_var[q]);
    }
    None
}

/// The point w = y - x of B - A minimising a.w, and a.w (the closure `worst` of
/// maxMarginSeparation).
fn worst(a_set: &[f64], n_a: usize, b_set: &[f64], n_b: usize, d: usize, aa: &[f64]) -> (Vec<f64>, f64) {
    let mut ia = 0;
    let mut va = f64::NEG_INFINITY;
    for i in 0..n_a {
        let s = dot(a_set, aa, d, i * d, 0);
        if s > va {
            va = s;
            ia = i;
        }
    }
    let mut ib = 0;
    let mut vb = f64::INFINITY;
    for i in 0..n_b {
        let s = dot(b_set, aa, d, i * d, 0);
        if s < vb {
            vb = s;
            ib = i;
        }
    }
    let mut w = vec![0.0f64; d];
    for c in 0..d {
        w[c] = b_set[ib * d + c] - a_set[ia * d + c];
    }
    (w, vb - va)
}

/// The closure `addCut`: a cut joins the pool unless an equal one is there.
fn add_cut(cuts: &mut Vec<Vec<f64>>, w: Vec<f64>, d: usize) {
    for q in cuts.iter() {
        let mut same = true;
        for c in 0..d {
            if q[c] != w[c] {
                same = false;
                break;
            }
        }
        if same {
            return;
        }
    }
    cuts.push(w);
}

/// packages/ndim/src/margin.ts: maxMarginSeparation. Decides, or brackets, the signed separation of
/// conv(A) and conv(B) by the max-margin LP (see the module comment). `verdict` Open means the LP
/// did not settle the thresholds within its caps.
pub fn max_margin_separation(
    a_set: &[f64],
    n_a: usize,
    b_set: &[f64],
    n_b: usize,
    d: usize,
    opts: &MarginOptions,
    seed: &[Vec<f64>],
) -> MarginResult {
    let accept_at = opts.accept_at.unwrap_or(f64::INFINITY);
    let refuse_below = opts.refuse_below.unwrap_or(f64::NEG_INFINITY);
    let max_cuts = opts.max_cuts.unwrap_or(260);
    let max_rounds = opts.max_rounds.unwrap_or(140);
    let sqrt_d = (d as f64).sqrt();
    // M bounds |w|_1 for every w = y - x: |w|_1 <= sqrt(d) |w|_2 <= sqrt(d) (rA + rB + |cB - cA|)
    let mut c_a = vec![0.0f64; d];
    let mut c_b = vec![0.0f64; d];
    for i in 0..n_a {
        for c in 0..d {
            c_a[c] += a_set[i * d + c] / n_a as f64;
        }
    }
    for i in 0..n_b {
        for c in 0..d {
            c_b[c] += b_set[i * d + c] / n_b as f64;
        }
    }
    let mut r_a = 0.0f64;
    let mut r_b = 0.0f64;
    for i in 0..n_a {
        let mut s = 0.0f64;
        for c in 0..d {
            let e = a_set[i * d + c] - c_a[c];
            s += e * e;
        }
        r_a = math::max(r_a, s.sqrt());
    }
    for i in 0..n_b {
        let mut s = 0.0f64;
        for c in 0..d {
            let e = b_set[i * d + c] - c_b[c];
            s += e * e;
        }
        r_b = math::max(r_b, s.sqrt());
    }
    let mut dc = 0.0f64;
    for c in 0..d {
        let e = c_b[c] - c_a[c];
        dc += e * e;
    }
    let big_m = sqrt_d * (r_a + r_b + dc.sqrt()) * (1.0 + 1e-9) + 1e-9;

    let mut cuts: Vec<Vec<f64>> = Vec::new();
    let mut a = vec![0.0f64; d];
    // seeds: the support points in the coordinate directions, and the given ones (typically the points GJK found)
    for i in 0..d {
        for sg in [1.0, -1.0] {
            a.fill(0.0);
            a[i] = sg;
            let (w, _) = worst(a_set, n_a, b_set, n_b, d, &a);
            add_cut(&mut cuts, w, d);
        }
    }
    for s in seed {
        let mut w = vec![0.0f64; d];
        w[..d].copy_from_slice(&s[..d]);
        add_cut(&mut cuts, w, d);
    }

    let mut lower = f64::NEG_INFINITY;
    let mut best_dir: Option<Vec<f64>> = None;
    let mut upper = f64::NEG_INFINITY; // max over branches of the proved upper bound of the branch optimum g
    let mut rounds = 0usize;
    let mut conclusive = true;
    let mut verdict = MarginVerdict::Open;
    // the closure `finish`
    let finish = |lower: f64, best_dir: Option<Vec<f64>>, upper: f64, conclusive: bool, verdict: MarginVerdict, rounds: usize| {
        let mut up = f64::INFINITY;
        if conclusive {
            up = if upper >= 0.0 { upper } else { upper / sqrt_d }; // (Infinity stays Infinity)
        }
        MarginResult { lower, dir: best_dir, upper: up, conclusive, verdict, rounds }
    };
    let n = d; // d - 1 free coordinates and t'
    'branches: for i in 0..d {
        for sigma in [1.0, -1.0] {
            let mut branch_up = f64::INFINITY;
            let mut done = false;
            for _round in 0..max_rounds {
                // master: variables a'_j = a_j + 1 in [0, 2] (j != i) and t' = t + M in [0, 2 M]
                let nc = cuts.len();
                let m = nc + d;
                let mut g_mat = vec![0.0f64; m * n];
                let mut h = vec![0.0f64; m];
                for k in 0..nc {
                    let w = &cuts[k];
                    let mut sum_others = 0.0f64;
                    let mut col = 0;
                    for j in 0..d {
                        if j == i {
                            continue;
                        }
                        g_mat[k * n + col] = -w[j];
                        col += 1;
                        sum_others += w[j];
                    }
                    g_mat[k * n + n - 1] = 1.0;
                    h[k] = sigma * w[i] + big_m - sum_others;
                }
                for c in 0..d - 1 {
                    g_mat[(nc + c) * n + c] = 1.0;
                    h[nc + c] = 2.0;
                }
                g_mat[(nc + d - 1) * n + n - 1] = 1.0;
                h[nc + d - 1] = 2.0 * big_m;
                rounds += 1;
                let Some(z) = simplex_max(&g_mat, &h, m, n, 40 * (m + n) + 200) else {
                    break;
                };
                let t = z[n - 1] - big_m;
                branch_up = math::min(branch_up, t);
                let mut col = 0;
                for j in 0..d {
                    a[j] = if j == i {
                        sigma
                    } else {
                        col += 1;
                        z[col - 1] - 1.0
                    };
                }
                let mut na = 0.0f64;
                for j in 0..d {
                    na += a[j] * a[j];
                }
                let na = na.sqrt();
                let (w, g) = worst(a_set, n_a, b_set, n_b, d, &a);
                let cert = g / na; // gap of the unit vector a / |a|_2: a rigorous lower bound of the separation
                if cert > lower {
                    lower = cert;
                    best_dir = Some(a.iter().map(|x| x / na).collect());
                }
                if lower >= accept_at {
                    verdict = MarginVerdict::Separated;
                    upper = f64::INFINITY; // stopped early: the other branches were not bounded
                    return finish(lower, best_dir, upper, conclusive, verdict, rounds);
                }
                if t < refuse_below || t - g <= 1e-11 * (1.0 + t.abs()) {
                    done = true; // the branch optimum is at most t, and (when t - g is tiny) equals it
                    break;
                }
                if cuts.len() >= max_cuts {
                    break;
                }
                add_cut(&mut cuts, w, d);
            }
            if !done {
                conclusive = false;
                upper = f64::INFINITY;
                if cuts.len() >= max_cuts {
                    break 'branches;
                }
            } else {
                upper = math::max(upper, branch_up);
            }
        }
    }
    if conclusive && upper < refuse_below {
        verdict = MarginVerdict::Overlapping;
    } else if conclusive && lower >= accept_at {
        verdict = MarginVerdict::Separated;
    }
    finish(lower, best_dir, upper, conclusive, verdict, rounds)
}
