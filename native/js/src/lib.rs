//! JavaScript's `Math` functions and number formats in Rust.
//!
//! The server's validators were written in TypeScript and their Rust ports must give the same
//! verdicts and the same messages. Two things in a faithful port can still differ: the
//! transcendental functions (Rust's `f64::sin` calls the platform's C library, V8 has its own) and
//! the text of a number (`{}` in Rust never uses an exponent, JavaScript does below 1e-6 and from
//! 1e21). This crate holds both, checked against Node by `examples/vectors.rs` with the vectors of
//! `native/tools/jsmath-vectors.mts`, and by `cargo test` against a sample of them kept in the
//! crate.
//!
//! `json` writes JSON as `JSON.stringify` does.
//!
//! Use `math::sin(x)` wherever the TypeScript says `Math.sin(x)`, and `fmt::num(x)` wherever a
//! number is put into a template string.
//!
//! What is the same as Node, and how it was measured (`examples/vectors.rs`, a million arguments
//! per function from `native/tools/jsmath-vectors.mts --bin`, drawn to reach every branch):
//!  - every format (`fmt::num`, `exponential`, `fixed`, `precision`): identical text;
//!  - `sqrt`, `round`, `hypot`, `max`, `min`: identical bits;
//!  - `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `expm1`, `log`, `log1p`, `log2`,
//!    `log10`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `cbrt`: identical bits to Node 24
//!    on Linux x86-64, the platform the server runs on. They are V8's own functions
//!    (`src/base/ieee754.cc`, which is fdlibm), ported line by line in `fdlibm`. Node is built
//!    without `V8_USE_LIBM_TRIG_FUNCTIONS`, so its sine and cosine are fdlibm's too, not glibc's;
//!  - `pow`: V8 calls the C library's, which is not the same program on macOS and on Linux and is
//!    one unit in the last place off for about one argument in a thousand on each. `math::pow` is
//!    the correctly rounded power (`math/pow.rs`), which both aim at; it is checked against exact
//!    arithmetic (`native/tools/jsmath-powref.py`).
//!
//! Node on an arm64 Mac is NOT a reference for the functions of `fdlibm`, `log2` excepted: its
//! compiler fuses `a * b + c` into one operation with a single rounding, which the compiler of the
//! Linux release does not, and the last bit of a result changes for 0.02% to 0.6% of arguments
//! (V8's own source compiled both ways reproduces both, see `fdlibm.rs`). The results here are
//! those without fusion, on every platform: Rust never fuses on its own.
//!
//! A port therefore computes what the TypeScript computes on the server, bit for bit, except
//! through `pow` (with an exponent other than 2 and 0.5, which are a product and a square root),
//! where the result is the neighbouring double for about one argument in a thousand.

pub mod fdlibm;
pub mod fmt;
pub mod json;
pub mod math;
