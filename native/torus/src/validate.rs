//! Float validator for packings on flat tori. Source: packages/torus/src/validate.ts.
//!
//! Not a proof: the rigorous certificate is python/torus/certify_torus.py (interval arithmetic).
//! The source's generator `validationSteps` yields for the event loop; here it is a plain function
//! (PORTING.md, rule 5).

use crate::disk::{area_of, reach_of, separation_of};
use crate::geometry::{axes_of, is_shape_code, regular_polygon_separation_with, Pose, TOL};
use crate::lattice::{cell_area, lattice_images, torus_score, Lattice, TorusFamily, TORUS_DISK_RADIUS};
use polypack_js::{fmt, math};

/// validate.ts: `TorusPacking`. `n` is a double, as in JavaScript: the validator itself refuses a
/// value that is not a shape code.
#[derive(Clone, Debug, PartialEq)]
pub struct TorusPacking {
    pub family: TorusFamily,
    /// 0 = disk of diameter 1 (radius 1/2), N >= 3 = regular N-gon of side 1
    pub n: f64,
    pub lattice: Lattice,
    pub poses: Vec<Pose>,
}

/// validate.ts: `ImageContact`. `m` and `n` are whole numbers kept as doubles (`lattice::Image`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImageContact {
    /// piece index
    pub i: usize,
    /// other piece index (j >= i)
    pub j: usize,
    /// lattice vector m b1 + n b2 applied to piece j
    pub m: f64,
    pub n: f64,
    /// signed SAT separation (exact distance for disks; penetration depth when negative)
    pub sep: f64,
}

/// validate.ts: `TorusValidation`.
#[derive(Clone, Debug, PartialEq)]
pub struct TorusValidation {
    pub valid: bool,
    /// smallest separation over all image pairs within reach (Infinity if none)
    pub min_sep: f64,
    /// pairs with sep < -tol
    pub overlaps: Vec<ImageContact>,
    /// pairs with |sep| <= contactTol (for drawing contact graphs)
    pub contacts: Vec<ImageContact>,
    /// image pairs tested exactly
    pub pairs_checked: u64,
    pub score: f64,
    pub density: f64,
    pub errors: Vec<String>,
}

/// validate.ts: `ValidateOptions`. `None` is a field left out. The server passes `tol` (1e-9, or
/// 1e-11 for the strict check) and `max_errors` 20, and nothing else.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ValidateOptions {
    /// overlap tolerance in piece units (default: the shared TOL = 1e-9)
    pub tol: Option<f64>,
    /// the check stops when this many overlaps are found (default: never)
    pub max_errors: Option<f64>,
    /// shrink factor applied to every piece about its centre (certificate-style checks; default 1)
    pub scale: Option<f64>,
    /// contacts reported when |sep| <= contactTol (default 1e-7)
    pub contact_tol: Option<f64>,
    /// Disk radius of the units the packing is in (default TORUS_DISK_RADIUS = 1/2, the site's
    /// diameter-1 disks). Ignored for polygons.
    pub disk_radius: Option<f64>,
}

/// The closure `empty` of `validationSteps`: the result of a packing that could not be checked.
fn empty(errors: Vec<String>) -> TorusValidation {
    TorusValidation {
        valid: false,
        min_sep: f64::NAN,
        overlaps: Vec::new(),
        contacts: Vec::new(),
        pairs_checked: 0,
        score: f64::NAN,
        density: f64::NAN,
        errors,
    }
}

/// validate.ts: `validationSteps` (and `validateTorusPacking`, `validateTorusPackingAsync`, which
/// run it). Check every pair (i, j >= i) and every lattice vector lambda with (i, lambda) != (j, 0)
/// for which the centres are closer than twice the bounding radius (farther pairs cannot overlap,
/// because each piece lies in its bounding disk). Lattice vectors come from the Cramer window in
/// `lattice_images`, so an unreduced basis is handled correctly.
///
/// The first reason of the source, "packing needs poses and a lattice with two vectors", is for a
/// value that is not a packing at all; these types cannot hold one.
pub fn validation_steps(p: &TorusPacking, opts: &ValidateOptions) -> TorusValidation {
    let tol = opts.tol.unwrap_or(TOL);
    let scale = opts.scale.unwrap_or(1.0);
    let rd = opts.disk_radius.unwrap_or(TORUS_DISK_RADIUS);
    let contact_tol = opts.contact_tol.unwrap_or(1e-7);
    let max_errors = opts.max_errors.unwrap_or(f64::INFINITY);
    let mut errors: Vec<String> = Vec::new();
    if !is_shape_code(p.n) {
        errors.push(format!("invalid shape code {}", fmt::num(p.n)));
    }
    if p.poses.is_empty() {
        errors.push("no pieces".to_string());
    }
    for (k, q) in p.poses.iter().enumerate() {
        if !(q.x.is_finite() && q.y.is_finite() && q.theta.is_finite()) {
            errors.push(format!("pose {k} is not finite"));
        }
    }
    let l = &p.lattice;
    if !(l.b1[0].is_finite() && l.b1[1].is_finite() && l.b2[0].is_finite() && l.b2[1].is_finite()) {
        errors.push("lattice is not finite".to_string());
    }
    let area = cell_area(l);
    if !(area > 0.0) {
        errors.push("lattice is degenerate".to_string());
    }
    if !(scale > 0.0 && scale <= 1.0) {
        errors.push("scale must be in (0, 1]".to_string());
    }
    if !errors.is_empty() {
        return empty(errors);
    }

    // centres at least 2R apart cannot overlap; the small margin keeps exact contacts
    // (disks at distance exactly 2) in the reported contact list
    let reach = 2.0 * reach_of(p.n, rd) * scale + 2.0 * math::max(contact_tol, tol);
    let mut overlaps: Vec<ImageContact> = Vec::new();
    let mut contacts: Vec<ImageContact> = Vec::new();
    let mut min_sep = f64::INFINITY;
    let mut pairs_checked = 0u64;
    let count = p.poses.len();
    let polygon = p.n != 0.0;
    let sides = p.n as usize;
    // The edge normals of each polygon, made when its first pair is measured. (The source's
    // pieceTrig cache holds the same numbers by N and theta.)
    let mut axes: Vec<Option<Vec<f64>>> = vec![None; if polygon { count } else { 0 }];
    'pairs: for i in 0..count {
        let a = p.poses[i];
        for j in i..count {
            let b = p.poses[j];
            let imgs = match lattice_images(l, &[b.x - a.x, b.y - a.y], reach, i == j) {
                Ok(imgs) => imgs,
                // the source's catch: the message of the thrown Error becomes the only reason
                Err(message) => {
                    errors.push(message);
                    return empty(errors);
                }
            };
            for im in &imgs {
                // place piece i at the origin: pieceSeparation only uses relative positions
                let pa = Pose {
                    x: 0.0,
                    y: 0.0,
                    theta: a.theta,
                };
                // shifted({ x: 0, y: 0, theta: b.theta }, im.v)
                let pb = Pose {
                    x: 0.0 + im.v[0],
                    y: 0.0 + im.v[1],
                    theta: b.theta,
                };
                // separationOf(p.N, pa, pb, scale, rd): for polygons pieceSeparation, here with the
                // normals already made
                let sep = if polygon {
                    if axes[i].is_none() {
                        axes[i] = Some(axes_of(sides, a.theta));
                    }
                    if axes[j].is_none() {
                        axes[j] = Some(axes_of(sides, b.theta));
                    }
                    let (ax_a, ax_b) = (axes[i].as_deref().unwrap(), axes[j].as_deref().unwrap());
                    regular_polygon_separation_with(sides, &pa, &pb, ax_a, ax_b, scale).sep
                } else {
                    separation_of(p.n, &pa, &pb, scale, rd)
                };
                pairs_checked += 1;
                if sep < min_sep {
                    min_sep = sep;
                }
                let c = ImageContact {
                    i,
                    j,
                    m: im.m,
                    n: im.n,
                    sep,
                };
                if sep < -tol {
                    overlaps.push(c);
                }
                if math::abs(sep) <= contact_tol {
                    contacts.push(c);
                }
                if overlaps.len() as f64 >= max_errors {
                    break 'pairs;
                }
            }
        }
    }
    TorusValidation {
        valid: overlaps.is_empty(),
        min_sep,
        overlaps,
        contacts,
        pairs_checked,
        score: torus_score(p.family, l),
        density: (count as f64 * area_of(p.n, rd)) / area,
        errors,
    }
}

/// validate.ts: `areaScoreBound`. Lower bound on the score from the area:
/// P * A_piece / densityBound <= cell area. The source's defaults are `density_bound` 1 and
/// `rd` TORUS_DISK_RADIUS; the torus domain's bound is this, with the defaults, times (1 - 1e-12)
/// (packages/spaces/src/piece-domains.ts: `torusDomain.bound`).
pub fn area_score_bound(family: TorusFamily, n: f64, p: f64, density_bound: f64, rd: f64) -> f64 {
    let area = (p * area_of(n, rd)) / density_bound;
    if family == TorusFamily::Hex {
        math::sqrt(area / (math::sqrt(3.0) / 2.0))
    } else {
        math::sqrt(area)
    }
}
