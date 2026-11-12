//! The crate's one rule for transcendental functions: JavaScript's `Math` as `polypack-js` gives
//! it (the `libm` crate, and V8's own `Math.hypot`), never the platform's C library behind
//! `f64::sin`, `f64::hypot` and the like. The server rule then computes the same doubles on every
//! machine, the ones the TypeScript reference computes up to the last place of a sine, and a
//! seeded search run gives the same packing on macOS, Linux and Windows.

pub use polypack_js::math::*;

/// (sin x, cos x), in the order of `f64::sin_cos`.
#[inline]
pub fn sin_cos(x: f64) -> (f64, f64) {
    (sin(x), cos(x))
}
