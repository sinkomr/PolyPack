//! Chart-free float validator for whole-sphere packings. Source: packages/sphere/src/validate.ts.
//!
//! Pairs are NOT confined to one hemisphere, so no gnomonic/Klein chart is used. A convex spherical
//! polygon in an open hemisphere is S^2 intersected with the convex cone over its vertices; two such
//! pointed cones have disjoint interiors iff some plane through 0 weakly separates them. The
//! max-margin value
//!     m(A, B) = max over unit n of min( min_k n.a_k, min_l -n.b_l )
//! is the cosine of the radius of the smallest cap containing S = {a_k} u {-b_l}: m > 0 strictly
//! separated, m = 0 touching, m < 0 overlapping interiors. At the optimum at least two points of S
//! are active, so n is +-(p + q)/|p + q| for two points or +- the normal of the plane through three
//! points; a brute force over these candidates is exact (no candidate is missed).
//! Gaps are reported in length units on the sphere of radius rho: rho asin(m) for polygons (distance
//! from the separating great circle to the nearest vertex), rho angle(c_i, c_j) - 1 for disks
//! (diameter 1).
//!
//! Not authoritative: this is a float check. Near the existence limit rho = N/(2 pi) the
//! circumradius R = asin(sin(a/2)/sin(pi/N)) approaches pi/2 and its float error grows like
//! 1e-16/(pi/2 - R), so strictly_valid can be wrong for |gap| below about 1e-11 there.
//! python/sphere/certify.py decides validity.
//!
//! The source's generators (`marginSteps`, `pairSteps`, `validationSteps`) yield for the event
//! loop; here they are plain functions (PORTING.md, rule 5).

use crate::geometry::{
    apply, centre_of, circumradius_angle, cross, dot, norm, piece_angle, piece_exists, quat_to_matrix,
    standard_vertices, Quat, SphereConfig, SphereProblem, Vec3,
};
use crate::hull::hull_faces;
use polypack_js::{fmt, math};
use std::collections::HashSet;

/// validate.ts: `MaxMargin`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MaxMargin {
    pub value: f64,
    pub normal: Vec3,
}

/// The state of `marginSteps`: the points S and the best plane so far (its closure `consider`).
struct Margin<'a> {
    s: &'a [Vec3],
    best: f64,
    best_n: Vec3,
}

impl Margin<'_> {
    /// The closure `consider` of `marginSteps`: the plane with normal v, if v is not (nearly) zero.
    #[inline]
    fn consider(&mut self, v: Vec3) {
        let nv = norm(&v);
        if !(nv > 1e-12) {
            return;
        }
        let n: Vec3 = [v[0] / nv, v[1] / nv, v[2] / nv];
        let mut lo = f64::INFINITY;
        for s in self.s {
            lo = math::min(lo, dot(&n, s));
        }
        if lo > self.best {
            self.best = lo;
            self.best_n = n;
        }
    }
}

/// validate.ts: `marginSteps` (and `maxMarginPlane`, which runs it). The plane through 0 that
/// separates the vertices A from the vertices B with the largest margin.
pub fn max_margin_plane(a: &[Vec3], b: &[Vec3]) -> MaxMargin {
    let mut s: Vec<Vec3> = Vec::with_capacity(a.len() + b.len());
    s.extend_from_slice(a);
    s.extend(b.iter().map(|b| [-b[0], -b[1], -b[2]]));
    margin_of(&s)
}

/// The body of `marginSteps` once S = A u -B is built.
fn margin_of(s: &[Vec3]) -> MaxMargin {
    let m = s.len();
    let mut st = Margin {
        s,
        best: f64::NEG_INFINITY,
        best_n: [0.0, 0.0, 1.0],
    };
    if m > 16 {
        let faces = hull_faces(s);
        // the source's Set of "a,b" keys, smaller index first; only membership is used
        let mut edges: HashSet<(usize, usize)> = HashSet::new();
        for [i, j, k] in faces {
            let u: Vec3 = [s[j][0] - s[i][0], s[j][1] - s[i][1], s[j][2] - s[i][2]];
            let v: Vec3 = [s[k][0] - s[i][0], s[k][1] - s[i][1], s[k][2] - s[i][2]];
            let n = cross(&u, &v);
            st.consider(n);
            st.consider([-n[0], -n[1], -n[2]]);
            for (a, b) in [(i, j), (j, k), (k, i)] {
                let key = if a < b { (a, b) } else { (b, a) };
                if edges.contains(&key) {
                    continue;
                }
                edges.insert(key);
                st.consider([s[a][0] + s[b][0], s[a][1] + s[b][1], s[a][2] + s[b][2]]);
            }
        }
    } else {
        for i in 0..m {
            for j in i + 1..m {
                st.consider([s[i][0] + s[j][0], s[i][1] + s[j][1], s[i][2] + s[j][2]]);
                for k in j + 1..m {
                    let u: Vec3 = [s[j][0] - s[i][0], s[j][1] - s[i][1], s[j][2] - s[i][2]];
                    let w: Vec3 = [s[k][0] - s[i][0], s[k][1] - s[i][1], s[k][2] - s[i][2]];
                    let c = cross(&u, &w);
                    st.consider(c);
                    st.consider([-c[0], -c[1], -c[2]]);
                }
            }
        }
    }
    MaxMargin {
        value: st.best,
        normal: st.best_n,
    }
}

/// validate.ts: the `kind` of a `PairGap`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairKind {
    /// circumscribed caps disjoint: the gap is the caps' gap, a lower bound
    Far,
    /// polygons: the max-margin plane's gap
    Plane,
    /// disks: the exact gap
    Disk,
}

impl PairKind {
    /// The source's string: "far", "plane" or "disk".
    pub fn as_str(self) -> &'static str {
        match self {
            PairKind::Far => "far",
            PairKind::Plane => "plane",
            PairKind::Disk => "disk",
        }
    }
}

/// validate.ts: `PairGap`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PairGap {
    pub i: usize,
    pub j: usize,
    /// gap in length units on the sphere of radius rho (negative = overlap)
    pub gap: f64,
    pub kind: PairKind,
    /// the separating plane's normal (kind `Plane` only)
    pub normal: Option<Vec3>,
}

/// validate.ts: `ValidationResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct ValidationResult {
    pub valid: bool,
    pub strictly_valid: bool,
    pub min_gap: f64,
    pub worst_pair: Option<(usize, usize)>,
    pub pairs: Vec<PairGap>,
    pub errors: Vec<String>,
}

/// The options `{ tol?, maxErrors? }` of validate.ts. `None` is a field left out: `tol` is then
/// 1e-9 and `max_errors` Infinity (every pair is measured). The server passes its tolerance (1e-9,
/// or 1e-11 for the strict check) and 20.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ValidateOptions {
    pub tol: Option<f64>,
    pub max_errors: Option<f64>,
}

/// The quaternion of a piece that `validation_steps` has accepted (four numbers).
fn quat(q: &[f64]) -> Quat {
    [q[0], q[1], q[2], q[3]]
}

/// validate.ts: `pairSteps` (and `pairGaps`, which runs it without options). Gaps of all pairs; far
/// pairs (circumscribed caps disjoint) are reported with kind "far". It stops at the
/// `max_errors`-th pair that overlaps by more than `tol`. The configuration must be one that
/// `validation_steps` accepts (N a shape, every q four numbers).
pub fn pair_gaps(problem: &SphereProblem, config: &SphereConfig, opts: &ValidateOptions) -> Vec<PairGap> {
    let n = problem.n;
    let rho = config.rho;
    let p = config.pieces.len();
    let c: Vec<Vec3> = config.pieces.iter().map(|p| centre_of(&quat(&p.q))).collect();
    let mut out: Vec<PairGap> = Vec::new();
    // `++overlaps >= (opts.maxErrors ?? Infinity)`: a count compared as a double
    let mut overlaps = 0.0f64;
    let tol = opts.tol.unwrap_or(1e-9);
    let max_errors = opts.max_errors.unwrap_or(f64::INFINITY);
    if n == 0.0 {
        let a = piece_angle(n, rho);
        for i in 0..p {
            for j in i + 1..p {
                let ang = math::acos(math::max(-1.0, math::min(1.0, dot(&c[i], &c[j]))));
                let gap = rho * (ang - 2.0 * a);
                out.push(PairGap {
                    i,
                    j,
                    gap,
                    kind: PairKind::Disk,
                    normal: None,
                });
                if gap < -tol && {
                    overlaps += 1.0;
                    overlaps >= max_errors
                } {
                    return out;
                }
            }
        }
        return out;
    }
    let r = circumradius_angle(n, rho);
    // placedVertices(N, rho, p.q) of every piece: the standard vertices are the same for all
    let standard = standard_vertices(n as usize, r);
    let x: Vec<Vec<Vec3>> = config
        .pieces
        .iter()
        .map(|p| {
            let m = quat_to_matrix(&quat(&p.q));
            standard.iter().map(|v| apply(&m, v)).collect()
        })
        .collect();
    let mut s: Vec<Vec3> = Vec::with_capacity(2 * standard.len());
    for i in 0..p {
        for j in i + 1..p {
            let ang = math::acos(math::max(-1.0, math::min(1.0, dot(&c[i], &c[j]))));
            if ang > 2.0 * r + 1e-9 {
                out.push(PairGap {
                    i,
                    j,
                    gap: rho * (ang - 2.0 * r),
                    kind: PairKind::Far,
                    normal: None,
                });
                continue;
            }
            // marginSteps(X[i], X[j]): S = [...A, ...B.map((b) => -b)]
            s.clear();
            s.extend_from_slice(&x[i]);
            s.extend(x[j].iter().map(|b| [-b[0], -b[1], -b[2]]));
            let mm = margin_of(&s);
            let gap = rho * math::asin(math::max(-1.0, math::min(1.0, mm.value)));
            out.push(PairGap {
                i,
                j,
                gap,
                kind: PairKind::Plane,
                normal: Some(mm.normal),
            });
            if gap < -tol && {
                overlaps += 1.0;
                overlaps >= max_errors
            } {
                return out;
            }
        }
    }
    out
}

/// validate.ts: `validationSteps` (and `validate`, `validateAsync`, which run it). The server calls
/// it with `{ N, P }` of the problem id, the parsed configuration and `{ tol, maxErrors: 20 }`, and
/// reads `valid`, `errors`, `worst_pair` and `min_gap` (packages/spaces/src/validate.ts: `check`).
pub fn validation_steps(problem: &SphereProblem, config: &SphereConfig, opts: &ValidateOptions) -> ValidationResult {
    let tol = opts.tol.unwrap_or(1e-9);
    let mut errors: Vec<String> = Vec::new();
    let SphereProblem { n, p } = *problem;
    // Number.isInteger: finite and whole
    let is_integer = |v: f64| v.is_finite() && v == v.trunc();
    if !(n == 0.0 || (is_integer(n) && n >= 3.0 && n <= 100.0)) {
        errors.push("N must be 0 or an integer in [3, 100]".to_string());
    }
    if !is_integer(p) || p < 1.0 {
        errors.push("P must be a positive integer".to_string());
    }
    // `!config || !Array.isArray(config.pieces)` cannot be said in these types: only the length is left
    if config.pieces.len() as f64 != p {
        errors.push("number of pieces differs from P".to_string());
    }
    if !(config.rho > 0.0) || !config.rho.is_finite() {
        errors.push("rho must be positive and finite".to_string());
    } else if !piece_exists(n, config.rho) {
        errors.push("piece does not exist at this rho (needs rho > N/(2 pi))".to_string());
    }
    for (k, piece) in config.pieces.iter().enumerate() {
        if piece.q.len() != 4 || !piece.q.iter().all(|c| c.is_finite()) {
            errors.push(format!("piece {k}: q must be 4 finite numbers"));
        } else if math::hypot_of(&piece.q) == 0.0 {
            errors.push(format!("piece {k}: zero quaternion"));
        }
    }
    if n == 0.0 && p >= 2.0 && config.rho > 0.0 && piece_angle(0.0, config.rho) > math::PI / 2.0 {
        errors.push("disks larger than a hemisphere cannot both fit".to_string());
    }
    if !errors.is_empty() {
        return ValidationResult {
            valid: false,
            strictly_valid: false,
            min_gap: f64::NEG_INFINITY,
            worst_pair: None,
            pairs: Vec::new(),
            errors,
        };
    }
    let pairs = pair_gaps(problem, config, opts);
    let mut min_gap = f64::INFINITY;
    let mut worst: Option<(usize, usize)> = None;
    for g in &pairs {
        if g.gap < min_gap {
            min_gap = g.gap;
            worst = Some((g.i, g.j));
        }
    }
    ValidationResult {
        valid: min_gap >= -tol,
        strictly_valid: min_gap > 0.0,
        min_gap,
        worst_pair: worst,
        pairs,
        errors,
    }
}

/// The reason the server gives for an overlap, from `check` of packages/spaces/src/validate.ts:
/// `pieces ${i} and ${j} overlap by ${-v.minGap}`; -1 and -1 when there is no worst pair.
pub fn overlap_reason(v: &ValidationResult) -> String {
    let (i, j) = match v.worst_pair {
        Some((i, j)) => (i.to_string(), j.to_string()),
        None => ("-1".to_string(), "-1".to_string()),
    };
    format!("pieces {i} and {j} overlap by {}", fmt::num(-v.min_gap))
}
