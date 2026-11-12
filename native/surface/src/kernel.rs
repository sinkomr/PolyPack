//! What the server's bundle keeps of the search kernels (`packages/surface/src/kernel.ts` and
//! `kernel-finish.ts`): a few constants evaluated when the modules load. No code of the server
//! reads them (the searches run in the browser and in the research scripts); they are here so that
//! everything the bundle holds of the package has its place in the port.

use polypack_js::fmt;
use polypack_js::math;

/// `packages/surface/src/kernel-finish.ts: SERVER_STRICT_TOL`.
pub const SERVER_STRICT_TOL: f64 = 1e-11;

/// `packages/surface/src/kernel-finish.ts: STRICT_NO_RECORD_REASON`.
pub fn strict_no_record_reason() -> String {
    format!(
        "valid only within the float tolerance; this problem has no research record yet, and its entries must be valid at tolerance {}",
        fmt::num(SERVER_STRICT_TOL)
    )
}

/// `packages/surface/src/kernel-finish.ts: DROPS`.
pub fn drops() -> Vec<f64> {
    let mut out: Vec<f64> = (0..20).map(|k| 1e-12 * math::pow(4.0, k as f64)).collect();
    out.extend([0.5, 0.75, 0.9]);
    out
}

/// `packages/surface/src/kernel.ts: VALIDATE_COST.fold`.
pub const VALIDATE_COST_FOLD: f64 = 2.0;
/// `packages/surface/src/kernel.ts: VALIDATE_COST.nofold`.
pub const VALIDATE_COST_NOFOLD: f64 = 4.0;
/// `packages/surface/src/kernel.ts: SURFACE_VALIDATE_COST`.
pub const SURFACE_VALIDATE_COST: f64 = VALIDATE_COST_FOLD;

#[cfg(test)]
mod tests {
    use super::*;

    /// The values Node 26 prints for the two expressions (JSON.stringify(DROPS) and the reason).
    #[test]
    fn constants_are_the_typescript_ones() {
        let want = [
            1e-12, 4e-12, 1.6e-11, 6.4e-11, 2.56e-10, 1.024e-9, 4.096e-9, 1.6384e-8, 6.5536e-8, 2.62144e-7, 0.000001048576,
            0.000004194304, 0.000016777216, 0.000067108864, 0.000268435456, 0.001073741824, 0.004294967296, 0.017179869184,
            0.068719476736, 0.274877906944, 0.5, 0.75, 0.9,
        ];
        assert_eq!(drops(), want);
        assert!(strict_no_record_reason().ends_with("must be valid at tolerance 1e-11"));
        assert_eq!(SURFACE_VALIDATE_COST, 2.0);
    }
}
