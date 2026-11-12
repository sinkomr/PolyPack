//! The `torus` branch of `check` and `reducedSpaceConfig` in packages/spaces/src/validate.ts: what
//! the server does around the validator. They are not part of packages/torus; they are here so
//! that the comparison with the TypeScript (`examples/torusdiff.rs`) covers the reasons the server
//! sends and the basis it stores, and the coordinator may call them or copy them into
//! `native/spaces`.

use crate::geometry::{bounding_radius, piece_inradius, Pose};
use crate::lattice::{gauss_reduce, max_image_candidates, Lattice, TorusFamily};
use crate::validate::{validation_steps, TorusPacking, TorusValidation, ValidateOptions};
use polypack_js::{fmt, math};

/// packages/spaces/src/validate.ts: `TorusLatticeSpec`. The lattice as a configuration states it:
/// `{L}` for sq and hex, `{b1, b2}` for free.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LatticeSpec {
    L(f64),
    Basis { b1: [f64; 2], b2: [f64; 2] },
}

/// The lattice of a configuration, as `check` (and `parseTorus`) build it:
/// `"L" in L ? (family === "sq" ? square : hexagonal) : { b1, b2 }`.
pub fn spec_lattice(family: TorusFamily, spec: &LatticeSpec) -> Lattice {
    match *spec {
        LatticeSpec::L(l) => {
            if family == TorusFamily::Sq {
                Lattice {
                    b1: [l, 0.0],
                    b2: [0.0, l],
                }
            } else {
                Lattice {
                    b1: [l, 0.0],
                    b2: [l / 2.0, (l * math::sqrt(3.0)) / 2.0],
                }
            }
        }
        LatticeSpec::Basis { b1, b2 } => Lattice { b1, b2 },
    }
}

/// packages/spaces/src/validate.ts: `reasonsOf`. Reasons from a validator, at most `max_reasons`,
/// with a fallback when it gave none.
pub fn reasons_of(errors: &[String], fallback: &str, max_reasons: usize) -> Vec<String> {
    let list: Vec<String> = errors.iter().take(max_reasons).cloned().collect();
    if list.is_empty() {
        vec![fallback.to_string()]
    } else {
        list
    }
}

/// `${x}` of a whole number below 2^53 (a count of lattice vectors, a limit): its digits. Anything
/// else goes through `fmt::num`, which gives the same text for these and takes longer.
fn whole(x: f64) -> String {
    if x == x.trunc() && x.abs() < 9007199254740992.0 {
        (x as i64).to_string()
    } else {
        fmt::num(x)
    }
}

/// The reasons `check` makes of the validator's result: none when valid, its errors, or one
/// sentence per overlap (at most `max_reasons`).
pub fn reasons_of_validation(v: &TorusValidation, max_reasons: usize) -> Vec<String> {
    if v.valid && v.errors.is_empty() {
        return Vec::new();
    }
    if !v.errors.is_empty() {
        return reasons_of(&v.errors, "", max_reasons);
    }
    v.overlaps
        .iter()
        .take(max_reasons)
        .map(|o| {
            if o.i == o.j {
                format!(
                    "piece {} overlaps its own translate by ({}, {}) lattice vectors, by {}",
                    o.i,
                    whole(o.m),
                    whole(o.n),
                    fmt::num(-o.sep)
                )
            } else {
                format!(
                    "pieces {} and {} overlap (translate ({}, {})) by {}",
                    o.i,
                    o.j,
                    whole(o.m),
                    whole(o.n),
                    fmt::num(-o.sep)
                )
            }
        })
        .collect()
}

/// packages/spaces/src/validate.ts: `check`, case "torus". Runs the validator on a parsed
/// configuration at `tol`; the reasons are empty when it is valid. `max_reasons` is the server's
/// MAX_REASONS (20) and `max_translates` its TORUS_MAX_TRANSLATES (1000).
pub fn check(
    family: TorusFamily,
    n: f64,
    spec: &LatticeSpec,
    poses: &[[f64; 3]],
    tol: f64,
    max_reasons: usize,
    max_translates: f64,
) -> Vec<String> {
    let lattice = spec_lattice(family, spec);
    // A piece contains its inscribed disk, and its width in every direction is at least twice
    // the inradius r, so a piece and its translate by a lattice vector of length l overlap by at
    // least 2r - l. A lattice vector shorter than 2r - TOL is therefore an overlap the validator
    // would reject as well, and refusing it first keeps the enumeration below small.
    let shortest = gauss_reduce(&lattice).lattice.b1;
    let width = 2.0 * piece_inradius(n);
    let len = math::hypot(shortest[0], shortest[1]);
    if len < width - tol {
        return vec![format!(
            "the lattice has a vector of length {}, shorter than the piece's width {}: every piece overlaps its own translate",
            fmt::num(len),
            fmt::num(width)
        )];
    }
    // the validator's enumeration window, per pair of pieces (see packages/torus/src/lattice.ts)
    let reach_r = 2.0 * bounding_radius(n) + 2.0 * 1e-7;
    // the most candidates (m, n) that the loop of latticeImages visits for one pair, exactly its bound
    let translates = max_image_candidates(&lattice, reach_r);
    if !(translates <= max_translates) {
        return vec![format!(
            "the lattice basis is too skewed: up to {} translates per pair would need checking (at most {}); send a Lagrange-Gauss reduced basis",
            whole(translates),
            whole(max_translates)
        )];
    }
    let v = validation_steps(
        &TorusPacking {
            family,
            n,
            lattice,
            poses: poses.iter().map(|&[x, y, theta]| Pose { x, y, theta }).collect(),
        },
        &ValidateOptions {
            tol: Some(tol),
            max_errors: Some(max_reasons as f64),
            ..Default::default()
        },
    );
    reasons_of_validation(&v, max_reasons)
}

/// packages/spaces/src/validate.ts: `reducedSpaceConfig`, the lattice of it. A free torus lattice
/// that is skewed or left-handed is stored Lagrange-Gauss reduced with det(b1, b2) > 0: the same
/// lattice, so the same packing and score, in a basis that every reader can draw and search
/// without a long walk over translates. `None`: the basis is kept as it was sent (it is reduced
/// and right-handed already). The server stores the reduced form only when it passes the check
/// again with the same score (`storedSpaceConfig`).
pub fn reduced_lattice(sent: &Lattice) -> Option<Lattice> {
    let det0 = sent.b1[0] * sent.b2[1] - sent.b1[1] * sent.b2[0];
    let reduced = gauss_reduce(sent).lattice;
    let (b1, r2) = (reduced.b1, reduced.b2);
    // -b2 spans the same lattice as b2
    let b2: [f64; 2] = if b1[0] * r2[1] - b1[1] * r2[0] < 0.0 {
        [-r2[0], -r2[1]]
    } else {
        [r2[0], r2[1]]
    };
    let length2 = |u: &[f64; 2], v: &[f64; 2]| u[0] * u[0] + u[1] * u[1] + v[0] * v[0] + v[1] * v[1];
    // a reduced, right-handed basis is kept as it was sent, so that stored records are not rewritten
    if det0 > 0.0 && length2(&b1, &b2) >= length2(&sent.b1, &sent.b2) * (1.0 - 1e-12) {
        return None;
    }
    Some(Lattice { b1: [b1[0], b1[1]], b2 })
}
