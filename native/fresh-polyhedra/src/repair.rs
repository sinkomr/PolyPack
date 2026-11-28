//! From an arrangement to a valid packing, and the check.
//!
//! `repair` works in true units with the validator's own rotation (`quat_to_r`) and vertex formula, so that what
//! it computes is what the check sees up to the rounding of a dot product:
//!  - each pair of pieces whose centres are closer than twice the circumradius gets a separating direction u
//!    (its plane in the state, or the best of the line of centres and the face normals of both pieces); its
//!    overlap along u is delta = max_i u . X - min_j u . X and its centres' spread D = u . (c_j - c_i) (positive for
//!    a direction that nearly separates, the centres being interior points); scaling every centre by
//!    lambda >= 1 + (delta + margin) / D about the origin separates the pair along u, since the pieces move
//!    rigidly with their centres (a pair with D <= 0 is instead separated by its circumscribed balls);
//!  - every centre is scaled by the largest such lambda (all pairwise distances grow, so no other pair starts to
//!    overlap), and s is the least size that holds every vertex, enlarged by 1e-14 relative.
//! The result is valid at tolerance 0 up to rounding (margins of about 1e-14), so it also passes the server's
//! strict check (1e-11).

use crate::energy::State;
use crate::model::{dot, Problem};
use polypack_polyhedra::quat_to_r;
use polypack_spaces::{validate_space_submission, SpaceValidateOptions};
use serde_json::{json, Value};

/// A packing in true units: the size and one pose [x, y, z, qw, qx, qy, qz] per piece.
#[derive(Clone, Debug, Default)]
pub struct Packing {
    pub s: f64,
    pub poses: Vec<[f64; 7]>,
}

impl Packing {
    /// The configuration in the submission format: {"s": s, "pieces": [[x, y, z, qw, qx, qy, qz], ...]}.
    pub fn to_json(&self) -> Value {
        let pieces: Vec<Value> = self.poses.iter().map(|p| json!(p.to_vec())).collect();
        json!({ "s": self.s, "pieces": pieces })
    }

    /// The configuration of a JSON value {s, pieces} with 7-number poses, or None.
    pub fn from_json(v: &Value) -> Option<Packing> {
        let s = v.get("s")?.as_f64()?;
        let arr = v.get("pieces")?.as_array()?;
        let mut poses = Vec::with_capacity(arr.len());
        for p in arr {
            let a = p.as_array()?;
            if a.len() != 7 {
                return None;
            }
            let mut pose = [0.0; 7];
            for k in 0..7 {
                pose[k] = a[k].as_f64()?;
            }
            poses.push(pose);
        }
        Some(Packing { s, poses })
    }
}

/// The world vertices of a piece in a pose, as the validator's `place` computes them.
fn world(prob: &Problem, pose: &[f64; 7], r: &[f64; 9], out: &mut Vec<f64>) {
    let v = &prob.piece.solid.v;
    out.clear();
    for k in 0..prob.piece.nv {
        let a = v[3 * k];
        let b = v[3 * k + 1];
        let d = v[3 * k + 2];
        out.push(pose[0] + r[0] * a + r[1] * b + r[2] * d);
        out.push(pose[1] + r[3] * a + r[4] * b + r[5] * d);
        out.push(pose[2] + r[6] * a + r[7] * b + r[8] * d);
    }
}

fn extent(xs: &[f64], u: [f64; 3]) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for v in xs.chunks_exact(3) {
        let d = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
        lo = lo.min(d);
        hi = hi.max(d);
    }
    (lo, hi)
}

/// The least size whose container holds the vertices (true units).
pub fn size_needed(prob: &Problem, xs: &[f64]) -> f64 {
    let c = &prob.cont;
    if c.ball {
        let mut m = 0.0f64;
        for v in xs.chunks_exact(3) {
            m = m.max((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt());
        }
        return 2.0 * m;
    }
    let solid = c.solid.expect("a polyhedral container");
    let mut s = f64::NEG_INFINITY;
    for g in 0..c.nf {
        let n = [solid.n[3 * g], solid.n[3 * g + 1], solid.n[3 * g + 2]];
        let mut m = f64::NEG_INFINITY;
        for v in xs.chunks_exact(3) {
            m = m.max(v[0] * n[0] + v[1] * n[1] + v[2] * n[2]);
        }
        s = s.max(m / solid.offsets[g]);
    }
    s
}

/// Workspace of `repair`.
#[derive(Default)]
pub struct Repairer {
    rots: Vec<[f64; 9]>,
    verts: Vec<Vec<f64>>,
    tmp: Vec<f64>,
}

impl Repairer {
    /// The valid packing of an arrangement (see the module notes). `centre_scale` multiplies the centres first
    /// (1 normally; the check's fallback enlarges it).
    pub fn repair(&mut self, prob: &Problem, st: &State, centre_scale: f64) -> Packing {
        let p = prob.p;
        let rho = prob.piece.rho;
        let mut poses: Vec<[f64; 7]> = Vec::with_capacity(p);
        self.rots.resize(p, [0.0; 9]);
        self.verts.resize_with(p, Vec::new);
        for i in 0..p {
            let x = &st.x[7 * i..7 * i + 7];
            let qn = (x[3] * x[3] + x[4] * x[4] + x[5] * x[5] + x[6] * x[6]).sqrt();
            let pose = [x[0] * rho * centre_scale, x[1] * rho * centre_scale, x[2] * rho * centre_scale, x[3] / qn, x[4] / qn, x[5] / qn, x[6] / qn];
            self.rots[i] = quat_to_r(pose[3], pose[4], pose[5], pose[6]).unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
            poses.push(pose);
        }
        for i in 0..p {
            let mut buf = std::mem::take(&mut self.verts[i]);
            world(prob, &poses[i], &self.rots[i], &mut buf);
            self.verts[i] = buf;
        }
        let mut cmax = 0.0f64;
        for pose in &poses {
            cmax = cmax.max(pose[0].abs()).max(pose[1].abs()).max(pose[2].abs());
        }
        let margin = 1e-14 * (rho + cmax);
        let reach = 2.0 * rho * (1.0 + 1e-12);
        let reach2 = reach * reach;
        let base = 7 * p;
        let mut lambda = 1.0f64;
        let mut k = 0usize;
        let np = st.pairs.len();
        for i in 0..p {
            for j in i + 1..p {
                let dc = [poses[j][0] - poses[i][0], poses[j][1] - poses[i][1], poses[j][2] - poses[i][2]];
                let d2 = dot(dc, dc);
                let key = [i as u32, j as u32];
                while k < np && st.pairs[k] < key {
                    k += 1;
                }
                if d2 >= reach2 {
                    continue;
                }
                // the candidate directions: the state's plane, then the line of centres and the face normals
                let mut best: Option<([f64; 3], f64)> = None; // (u, gap)
                let consider = |u: [f64; 3], best: &mut Option<([f64; 3], f64)>| {
                    let (_, hi) = extent(&self.verts[i], u);
                    let (lo, _) = extent(&self.verts[j], u);
                    let gap = lo - hi;
                    if best.is_none_or(|b| gap > b.1) {
                        *best = Some((u, gap));
                    }
                };
                if k < np && st.pairs[k] == key {
                    let o = base + 4 * k;
                    let w = [st.x[o], st.x[o + 1], st.x[o + 2]];
                    let n = dot(w, w).sqrt();
                    if n > 0.0 && n.is_finite() {
                        consider([w[0] / n, w[1] / n, w[2] / n], &mut best);
                    }
                }
                // other directions only for a pair that the plane leaves overlapping by more than a hair (a
                // relaxed state's planes leave about 1e-13, which costs that much in lambda): the line of
                // centres, then the face normals
                if best.is_none_or(|b| b.1 < 0.0) {
                    let dn = d2.sqrt();
                    if dn > 0.0 {
                        consider([dc[0] / dn, dc[1] / dn, dc[2] / dn], &mut best);
                    }
                }
                if best.is_none_or(|b| b.1 < -1e-10 * rho) {
                    let solid = prob.piece.solid;
                    for f in 0..prob.piece.nf {
                        let nl = [solid.n[3 * f], solid.n[3 * f + 1], solid.n[3 * f + 2]];
                        for (who, sign) in [(i, 1.0), (j, -1.0)] {
                            let r = &self.rots[who];
                            let nw = [
                                sign * (r[0] * nl[0] + r[1] * nl[1] + r[2] * nl[2]),
                                sign * (r[3] * nl[0] + r[4] * nl[1] + r[5] * nl[2]),
                                sign * (r[6] * nl[0] + r[7] * nl[1] + r[8] * nl[2]),
                            ];
                            if dot(nw, dc) > 0.0 {
                                consider(nw, &mut best);
                            }
                        }
                    }
                }
                let Some((u, gap)) = best else { continue };
                let delta = -gap;
                if delta + margin <= 0.0 {
                    continue;
                }
                let dd = dot(u, dc);
                let l = if dd > 1e-9 * rho { 1.0 + (delta + margin) / dd } else { reach / d2.sqrt().max(1e-300) };
                let l = l.min(reach / d2.sqrt().max(1e-300));
                lambda = lambda.max(l);
            }
        }
        if lambda > 1.0 {
            for pose in poses.iter_mut() {
                pose[0] *= lambda;
                pose[1] *= lambda;
                pose[2] *= lambda;
            }
        }
        // the size from the final vertices
        let mut s = 0.0f64;
        for i in 0..p {
            world(prob, &poses[i], &self.rots[i], &mut self.tmp);
            s = s.max(size_needed(prob, &self.tmp));
        }
        Packing { s: s * (1.0 + 1e-14), poses }
    }
}

/// The server's check with the strict tolerance as well (an entry of a problem without a research record must be
/// valid at 1e-11): Some(score) when valid. The strict verdict implies the default one.
pub fn check(prob: &Problem, cfg: &Value) -> Option<f64> {
    let opts = SpaceValidateOptions { no_record: true, ..SpaceValidateOptions::default() };
    let v = validate_space_submission(prob.space, &prob.id, cfg, &opts);
    if v.valid {
        v.score
    } else {
        None
    }
}

/// The check exactly as the contract states it (default options).
pub fn check_default(prob: &Problem, cfg: &Value) -> Option<f64> {
    let v = validate_space_submission(prob.space, &prob.id, cfg, &SpaceValidateOptions::default());
    if v.valid {
        v.score
    } else {
        None
    }
}

/// The packing with its centres scaled by 1 + eps about the origin (every pairwise distance grows) and the least
/// size that holds it, enlarged by 1e-14 relative: the check's fallback.
pub fn enlarge(prob: &Problem, pk: &Packing, eps: f64) -> Packing {
    let mut out = pk.clone();
    let mut s = 0.0f64;
    let mut tmp = Vec::new();
    for pose in out.poses.iter_mut() {
        for d in 0..3 {
            pose[d] *= 1.0 + eps;
        }
        let r = quat_to_r(pose[3], pose[4], pose[5], pose[6]).unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        world(prob, pose, &r, &mut tmp);
        s = s.max(size_needed(prob, &tmp));
    }
    out.s = s * (1.0 + 1e-14 + eps);
    out
}

/// A packing checked as it is, or enlarged by 1e-12, 1e-10, ... relative when the check refuses it: the checked
/// score, configuration and packing.
pub fn check_or_enlarge(prob: &Problem, pk: &Packing) -> Option<(f64, Value, Packing)> {
    let mut cur = pk.clone();
    for k in 0..5 {
        let cfg = cur.to_json();
        if let Some(score) = check(prob, &cfg) {
            return Some((score, cfg, cur));
        }
        cur = enlarge(prob, pk, 1e-12 * 100f64.powi(k));
    }
    None
}
