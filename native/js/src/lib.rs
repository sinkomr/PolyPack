//! JavaScript's `Math` functions and number formats in Rust.
//!
//! The server's validators were written in TypeScript and their Rust ports must give the same
//! verdicts and the same messages. Two things in a faithful port can still differ: the
//! transcendental functions (Rust's `f64::sin` calls the platform's C library, V8 has its own) and
//! the text of a number (`{}` in Rust never uses an exponent, JavaScript does below 1e-6 and from
//! 1e21). This crate holds both, checked against Node by `examples/vectors.rs` with the vectors of
//! `native/tools/jsmath-vectors.mts`.
//!
//! Use `math::sin(x)` wherever the TypeScript says `Math.sin(x)`, and `fmt::num(x)` wherever a
//! number is put into a template string.
//!
//! What is the same as Node, measured on 740,000 vectors (Node 26, V8 14.6):
//!  - every format (`fmt::num`, `exponential`, `fixed`, `precision`): identical text;
//!  - `sqrt`, `round`, `hypot`, `max`, `min`, and `pow` with the exponents 2 and 0.5: identical bits;
//!  - the transcendental functions (`sin`, `cos`, `tan`, `atan2`, `exp`, `log`, ...): the `libm`
//!    crate's, which give the same bits as V8 for 85% to 99.9% of arguments depending on the function
//!    and differ by one unit in the last place otherwise (two for `log10` and `tanh`). V8's `sin`
//!    and `cos` come from glibc (LGPL), so they are not copied here. The results are the same on
//!    every platform, which the C library's are not.
//!
//! A port therefore gives the same verdicts except within about 1e-16 of a tolerance, and its
//! messages can differ from the TypeScript's in the last digits of a number.

pub mod fmt;
pub mod math;
