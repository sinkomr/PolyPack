//! The `sphere` branch of `check` in packages/spaces/src/validate.ts: what the server does with the
//! validator's result. It is not part of packages/sphere; it is here so that the comparison with
//! the TypeScript (`examples/spherediff.rs`) covers the reasons the server sends, and the
//! coordinator may call it or copy it into `native/spaces`.

use crate::geometry::{SphereConfig, SphereProblem};
use crate::validate::{overlap_reason, validation_steps, ValidateOptions};

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

/// packages/spaces/src/validate.ts: `check`, case "sphere". Runs the validator on a parsed
/// configuration at `tol`; the reasons are empty when it is valid. `n` and `p` are the N and P of
/// the problem id, `max_reasons` is the server's MAX_REASONS (20).
pub fn check(n: f64, p: f64, config: &SphereConfig, tol: f64, max_reasons: usize) -> Vec<String> {
    let v = validation_steps(
        &SphereProblem { n, p },
        config,
        &ValidateOptions {
            tol: Some(tol),
            max_errors: Some(max_reasons as f64),
        },
    );
    if v.valid {
        return Vec::new();
    }
    if !v.errors.is_empty() {
        return reasons_of(&v.errors, "", max_reasons);
    }
    vec![overlap_reason(&v)]
}
