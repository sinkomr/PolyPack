// The following is adapted from fdlibm (http://www.netlib.org/fdlibm).
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
//
// The original source code covered by the above license above has been
// modified significantly by Google Inc.
// Copyright 2016 the V8 project authors. All rights reserved.
//
// Ported to Rust for PolyPack from V8's src/base/ieee754.cc as shipped in Node
// (deps/v8/src/base/ieee754.cc; the v24 and v26 lines differ only in a pragma for Visual Studio).

//! V8's transcendental functions (`v8::base::ieee754`), line by line.
//!
//! Node's `Math.sin`, `Math.cos`, `Math.tan`, `Math.exp`, `Math.log` and the others (every one
//! here) call these functions: they are fdlibm as Sun published it, with a few changes by the V8
//! authors (`exp(1)` returns E exactly, `log10` is `log` times a constant, `sinh` and `cosh` are
//! V8's own). They are NOT the same as musl's or FreeBSD's descendants of fdlibm, which evaluate
//! some polynomials in another order and use other kernels; that is why the `libm` crate gives a
//! neighbouring double for a percent or so of arguments.
//!
//! Checked bit for bit against Node 24 on Linux x86-64 with a million arguments per function
//! (`examples/vectors.rs`), and by the test at the end of this file on a sample of them.
//!
//! Rules kept in this port, because a last bit depends on each of them:
//!  - every expression has the parentheses and the order of the C++ source;
//!  - no product and sum are fused: Rust never contracts `a * b + c` into a fused multiply-add,
//!    and nothing here calls `mul_add`;
//!  - integer casts are the source's: `as i32` truncates as `static_cast<int32_t>` does for the
//!    values that reach it, a high word is signed (`int32_t`) or unsigned (`uint32_t`) as declared.
//!
//! Fusion is the one thing that makes Node's results depend on the machine. The C++ compiler may
//! contract `a * b + c` where the processor has the instruction: Clang does on arm64 (the Mac),
//! GCC does not on x86-64 without `-mfma` (the Linux release of Node, which the server runs). The
//! experiment: this very source file of V8, compiled with `-ffp-contract=off`, gives the bits of
//! Node 24 on Linux x86-64 for every function, and compiled with `-ffp-contract=on` the bits of
//! Node 26 on an arm64 Mac; the two differ for 0.02% to 0.6% of arguments in every function except
//! `log2` (and one argument in a million for `cbrt`), by one unit in the last place (up to two for
//! `log10` and `sinh`, three for `cosh` and `tanh`, which are built on `expm1` and `exp`). This
//! port is the one without fusion: the server's.
//!
//! The comment before each function names the C++ function it ports. The long derivations of the
//! original comments are not repeated; see the source.

// the shape of the source is kept where a linter would write it otherwise (x - x for NaN, t = t * ...)
#![allow(
    clippy::excessive_precision,
    clippy::approx_constant,
    clippy::many_single_char_names,
    clippy::eq_op,
    clippy::assign_op_pattern,
    clippy::explicit_counter_loop,
    clippy::needless_late_init
)]

/* The word macros of the source: EXTRACT_WORDS, GET_HIGH_WORD, GET_LOW_WORD, INSERT_WORDS,
 * SET_HIGH_WORD, SET_LOW_WORD. */

/// GET_HIGH_WORD into an `int32_t`.
#[inline(always)]
fn high_word(d: f64) -> i32 {
    (d.to_bits() >> 32) as i32
}

/// GET_LOW_WORD.
#[inline(always)]
fn low_word(d: f64) -> u32 {
    d.to_bits() as u32
}

/// INSERT_WORDS.
#[inline(always)]
fn insert_words(ix0: u32, ix1: u32) -> f64 {
    f64::from_bits(((ix0 as u64) << 32) | ix1 as u64)
}

/// SET_HIGH_WORD.
#[inline(always)]
fn set_high_word(d: f64, v: u32) -> f64 {
    f64::from_bits((d.to_bits() & 0x0000_0000_FFFF_FFFF) | ((v as u64) << 32))
}

/// SET_LOW_WORD.
#[inline(always)]
fn set_low_word(d: f64, v: u32) -> f64 {
    f64::from_bits((d.to_bits() & 0xFFFF_FFFF_0000_0000) | v as u64)
}

/// C's `scalbn(x, n)`: x times 2 to the n, exact unless the result is subnormal or overflows.
/// `__kernel_rem_pio2` is its only caller, with results in the normal range.
fn scalbn(x: f64, n: i32) -> f64 {
    let x1p1023 = f64::from_bits(0x7FE0_0000_0000_0000);
    let x1p53 = f64::from_bits(0x4340_0000_0000_0000);
    let x1p_1022 = f64::from_bits(0x0010_0000_0000_0000);
    let mut y = x;
    let mut n = n;
    if n > 1023 {
        y *= x1p1023;
        n -= 1023;
        if n > 1023 {
            y *= x1p1023;
            n -= 1023;
            if n > 1023 {
                n = 1023;
            }
        }
    } else if n < -1022 {
        // 2^-1022 * 2^53: the intermediate stays normal, so that the result is rounded once
        y *= x1p_1022 * x1p53;
        n += 1022 - 53;
        if n < -1022 {
            y *= x1p_1022 * x1p53;
            n += 1022 - 53;
            if n < -1022 {
                n = -1022;
            }
        }
    }
    y * f64::from_bits(((0x3FF + n) as u64) << 52)
}

/* __ieee754_rem_pio2(x,y)
 *
 * return the remainder of x rem pi/2 in y[0]+y[1]
 * use __kernel_rem_pio2()
 */

/// Table of constants for 2/pi, 396 Hex digits (476 decimal) of 2/pi
static TWO_OVER_PI: [i32; 66] = [
    0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C, 0x439041, 0xFE5163,
    0xABDEBB, 0xC561B7, 0x246E3A, 0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
    0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41, 0x3991D6, 0x398353, 0x39F49C,
    0x845F8B, 0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
    0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5, 0xF17B3D, 0x0739F7, 0x8A5292,
    0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
    0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA,
    0x73A8C9, 0x60E27B, 0xC08C6B,
];

static NPIO2_HW: [i32; 32] = [
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB,
    0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
    0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
    0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
];

/// `__ieee754_rem_pio2`: returns (n, y[0], y[1]) with x = n*pi/2 + y[0] + y[1], |y| <= pi/4.
///
///  - invpio2:  53 bits of 2/pi
///  - pio2_1:   first  33 bit of pi/2
///  - pio2_1t:  pi/2 - pio2_1
///  - pio2_2:   second 33 bit of pi/2
///  - pio2_2t:  pi/2 - (pio2_1+pio2_2)
///  - pio2_3:   third  33 bit of pi/2
///  - pio2_3t:  pi/2 - (pio2_1+pio2_2+pio2_3)
#[inline]
fn ieee754_rem_pio2(x: f64) -> (i32, f64, f64) {
    const HALF: f64 = 5.00000000000000000000e-01; /* 0x3FE00000, 0x00000000 */
    const INVPIO2: f64 = 6.36619772367581382433e-01; /* 0x3FE45F30, 0x6DC9C883 */
    const PIO2_1: f64 = 1.57079632673412561417e+00; /* 0x3FF921FB, 0x54400000 */
    const PIO2_1T: f64 = 6.07710050650619224932e-11; /* 0x3DD0B461, 0x1A626331 */
    const PIO2_2: f64 = 6.07710050630396597660e-11; /* 0x3DD0B461, 0x1A600000 */
    const PIO2_2T: f64 = 2.02226624879595063154e-21; /* 0x3BA3198A, 0x2E037073 */
    const PIO2_3: f64 = 2.02226624871116645580e-21; /* 0x3BA3198A, 0x2E000000 */
    const PIO2_3T: f64 = 8.47842766036889956997e-32; /* 0x397B839A, 0x252049C1 */

    let hx = high_word(x); /* high word of x */
    let ix = hx & 0x7FFFFFFF;
    if ix <= 0x3FE921FB {
        /* |x| ~<= pi/4 , no need for reduction */
        return (0, x, 0.0);
    }
    if ix < 0x4002D97C {
        /* |x| < 3pi/4, special case with n=+-1 */
        if hx > 0 {
            let mut z = x - PIO2_1;
            if ix != 0x3FF921FB {
                /* 33+53 bit pi is good enough */
                let y0 = z - PIO2_1T;
                let y1 = (z - y0) - PIO2_1T;
                return (1, y0, y1);
            } else {
                /* near pi/2, use 33+33+53 bit pi */
                z -= PIO2_2;
                let y0 = z - PIO2_2T;
                let y1 = (z - y0) - PIO2_2T;
                return (1, y0, y1);
            }
        } else {
            /* negative x */
            let mut z = x + PIO2_1;
            if ix != 0x3FF921FB {
                /* 33+53 bit pi is good enough */
                let y0 = z + PIO2_1T;
                let y1 = (z - y0) + PIO2_1T;
                return (-1, y0, y1);
            } else {
                /* near pi/2, use 33+33+53 bit pi */
                z += PIO2_2;
                let y0 = z + PIO2_2T;
                let y1 = (z - y0) + PIO2_2T;
                return (-1, y0, y1);
            }
        }
    }
    if ix <= 0x413921FB {
        /* |x| ~<= 2^19*(pi/2), medium size */
        let mut t = x.abs();
        let n = (t * INVPIO2 + HALF) as i32;
        let fn_ = n as f64;
        let mut r = t - fn_ * PIO2_1;
        let mut w = fn_ * PIO2_1T; /* 1st round good to 85 bit */
        let mut y0;
        if n < 32 && ix != NPIO2_HW[(n - 1) as usize] {
            y0 = r - w; /* quick check no cancellation */
        } else {
            let j = ix >> 20;
            y0 = r - w;
            let mut high = high_word(y0) as u32;
            let mut i = j - ((high >> 20) & 0x7FF) as i32;
            if i > 16 {
                /* 2nd iteration needed, good to 118 */
                t = r;
                w = fn_ * PIO2_2;
                r = t - w;
                w = fn_ * PIO2_2T - ((t - r) - w);
                y0 = r - w;
                high = high_word(y0) as u32;
                i = j - ((high >> 20) & 0x7FF) as i32;
                if i > 49 {
                    /* 3rd iteration need, 151 bits acc */
                    t = r; /* will cover all possible cases */
                    w = fn_ * PIO2_3;
                    r = t - w;
                    w = fn_ * PIO2_3T - ((t - r) - w);
                    y0 = r - w;
                }
            }
        }
        let y1 = (r - y0) - w;
        if hx < 0 {
            return (-n, -y0, -y1);
        } else {
            return (n, y0, y1);
        }
    }
    /*
     * all other (large) arguments
     */
    if ix >= 0x7FF00000 {
        /* x is inf or NaN */
        let v = x - x;
        return (0, v, v);
    }
    rem_pio2_large(x, hx, ix)
}

/// The last part of `__ieee754_rem_pio2`, for |x| above 2^19*(pi/2): x is cut into three 24-bit
/// pieces and multiplied by as many digits of 2/pi as needed. Kept out of line so that the common
/// path stays small.
#[inline(never)]
fn rem_pio2_large(x: f64, hx: i32, ix: i32) -> (i32, f64, f64) {
    const ZERO: f64 = 0.00000000000000000000e+00; /* 0x00000000, 0x00000000 */
    const TWO24: f64 = 1.67772160000000000000e+07; /* 0x41700000, 0x00000000 */
    let mut tx = [0.0f64; 3];
    let mut y = [0.0f64; 2];
    /* set z = scalbn(|x|,ilogb(x)-23) */
    let low = low_word(x);
    let mut z = set_low_word(0.0, low);
    let e0 = (ix >> 20) - 1046; /* e0 = ilogb(z)-23; */
    z = set_high_word(z, (ix - ((e0 as u32) << 20) as i32) as u32);
    for item in tx.iter_mut().take(2) {
        *item = (z as i32) as f64;
        z = (z - *item) * TWO24;
    }
    tx[2] = z;
    let mut nx = 3;
    while tx[nx - 1] == ZERO {
        nx -= 1; /* skip zero term */
    }
    let n = kernel_rem_pio2(&tx, &mut y, e0, nx as i32, 2, &TWO_OVER_PI);
    if hx < 0 {
        return (-n, -y[0], -y[1]);
    }
    (n, y[0], y[1])
}

/* __kernel_cos( x,  y )
 * kernel cos function on [-pi/4, pi/4], pi/4 ~ 0.785398164
 * Input x is assumed to be bounded by ~pi/4 in magnitude.
 * Input y is the tail of x.
 *
 * Algorithm
 *      1. Since cos(-x) = cos(x), we need only to consider positive x.
 *      2. if x < 2^-27 (hx<0x3E400000 0), return 1 with inexact if x!=0.
 *      3. cos(x) is approximated by a polynomial of degree 14 on
 *         [0,pi/4]
 *                                       4            14
 *              cos(x) ~ 1 - x*x/2 + C1*x + ... + C6*x
 *      4. let r = C1*x^4 + ... + C6*x^14, then
 *             cos(x) = 1 - x*x/2 + r
 *         since cos(x+y) ~ cos(x) - sin(x)*y
 *                        ~ cos(x) - x*y,
 *         a correction term is necessary in cos(x) and hence
 *              cos(x+y) = 1 - (x*x/2 - (r - x*y))
 *         For better accuracy when x > 0.3, let qx = |x|/4 with
 *         the last 32 bits mask off, and if x > 0.78125, let qx = 0.28125.
 *         Then
 *              cos(x+y) = (1-qx) - ((x*x/2-qx) - (r-x*y)).
 *         Note that 1-qx and (x*x/2-qx) is EXACT here, and the
 *         magnitude of the latter is at least a quarter of x*x/2,
 *         thus, reducing the rounding error in the subtraction.
 */
#[inline(always)]
fn kernel_cos(x: f64, y: f64) -> f64 {
    const ONE: f64 = 1.00000000000000000000e+00; /* 0x3FF00000, 0x00000000 */
    const C1: f64 = 4.16666666666666019037e-02; /* 0x3FA55555, 0x5555554C */
    const C2: f64 = -1.38888888888741095749e-03; /* 0xBF56C16C, 0x16C15177 */
    const C3: f64 = 2.48015872894767294178e-05; /* 0x3EFA01A0, 0x19CB1590 */
    const C4: f64 = -2.75573143513906633035e-07; /* 0xBE927E4F, 0x809C52AD */
    const C5: f64 = 2.08757232129817482790e-09; /* 0x3E21EE9E, 0xBDB4B1C4 */
    const C6: f64 = -1.13596475577881948265e-11; /* 0xBDA8FAE9, 0xBE8838D4 */

    let ix = high_word(x) & 0x7FFFFFFF; /* ix = |x|'s high word*/
    if ix < 0x3E400000 {
        /* if x < 2**27 */
        if (x as i32) == 0 {
            return ONE; /* generate inexact */
        }
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    // The source has two returns:
    //   if (ix < 0x3FD33333)  return one - (0.5 * z - (z * r - x * y));        /* if |x| < 0.3 */
    //   else { qx = ...; iz = 0.5 * z - qx; a = one - qx; return a - (iz - (z * r - x * y)); }
    // The first is the second with qx = 0 (one - 0 and 0.5 * z - 0 are exact), so qx is chosen
    // and one expression serves both: the same bits, without a branch that the processor cannot
    // predict for arguments spread over [-pi/4, pi/4].
    let qx = if ix < 0x3FD33333 {
        0.0
    } else if ix > 0x3FE90000 {
        /* x > 0.78125 */
        0.28125
    } else {
        insert_words((ix - 0x00200000) as u32, 0) /* x/4 */
    };
    let iz = 0.5 * z - qx;
    let a = ONE - qx;
    a - (iz - (z * r - x * y))
}

/* __kernel_rem_pio2(x,y,e0,nx,prec,ipio2)
 *
 * __kernel_rem_pio2 return the last three digits of N with
 *              y = x - N*pi/2
 * so that |y| < pi/2.
 *
 * The method is to compute the integer (mod 8) and fraction parts of
 * (2/pi)*x without doing the full multiplication. In general we
 * skip the part of the product that are known to be a huge integer (
 * more accurately, = 0 mod 8 ). Thus the number of operations are
 * independent of the exponent of the input.
 *
 * (2/pi) is represented by an array of 24-bit integers in ipio2[].
 *
 * Input parameters:
 *      x[]     The input value (must be positive) is broken into nx
 *              pieces of 24-bit integers in double precision format.
 *              x[i] will be the i-th 24 bit of x. The scaled exponent
 *              of x[0] is given in input parameter e0 (i.e., x[0]*2^e0
 *              match x's up to 24 bits.
 *      y[]     output result in an array of double precision numbers.
 *      e0      The exponent of x[0]
 *      nx      dimension of x[]
 *      prec    an integer indicating the precision:
 *                      0       24  bits (single)
 *                      1       53  bits (double)
 *                      2       64  bits (extended)
 *                      3       113 bits (quad)
 *      ipio2[] integer array, contains the (24*i)-th to (24*i+23)-th
 *              bit of 2/pi after binary point.
 *
 * Local variables:
 *      jk      jk+1 is the initial number of terms of ipio2[] needed
 *              in the computation.
 *      jz      local integer variable indicating the number of
 *              terms of ipio2[] used.
 *      jx      nx - 1
 *      jv      index for pointing to the suitable ipio2[] for the
 *              computation. jv = max(0,(e0-3)/24).
 *      jp      jp+1 is the number of terms in PIo2[] needed, jp = jk.
 *      q[]     double array with integral value, representing the
 *              24-bits chunk of the product of x and 2/pi.
 *      q0      the corresponding exponent of q[0]. Note that the
 *              exponent for q[i] would be q0-24*i.
 *      PIo2[]  double precision array, obtained by cutting pi/2
 *              into 24 bits chunks.
 *      f[]     ipio2[] in floating point
 *      iq[]    integer array by breaking up q[] in 24-bits chunk.
 *      fq[]    final product of x*(2/pi) in fq[0],..,fq[jk]
 *      ih      integer. If >0 it indicates q[] is >= 0.5, hence
 *              it also indicates the *sign* of the result.
 */
fn kernel_rem_pio2(x: &[f64], y: &mut [f64], e0: i32, nx: i32, prec: usize, ipio2: &[i32]) -> i32 {
    const INIT_JK: [i32; 4] = [2, 3, 4, 6]; /* initial value for jk */

    const PIO2: [f64; 8] = [
        1.57079625129699707031e+00, /* 0x3FF921FB, 0x40000000 */
        7.54978941586159635335e-08, /* 0x3E74442D, 0x00000000 */
        5.39030252995776476554e-15, /* 0x3CF84698, 0x80000000 */
        3.28200341580791294123e-22, /* 0x3B78CC51, 0x60000000 */
        1.27065575308067607349e-29, /* 0x39F01B83, 0x80000000 */
        1.22933308981111328932e-36, /* 0x387A2520, 0x40000000 */
        2.73370053816464559624e-44, /* 0x36E38222, 0x80000000 */
        2.16741683877804819444e-51, /* 0x3569F31D, 0x00000000 */
    ];

    const ZERO: f64 = 0.0;
    const ONE: f64 = 1.0;
    const TWO24: f64 = 1.67772160000000000000e+07; /* 0x41700000, 0x00000000 */
    const TWON24: f64 = 5.96046447753906250000e-08; /* 0x3E700000, 0x00000000 */

    let mut iq = [0i32; 20];
    let mut f = [0.0f64; 20];
    let mut fq = [0.0f64; 20];
    let mut q = [0.0f64; 20];
    let mut fw: f64;

    /* initialize jk*/
    let jk = INIT_JK[prec];
    let jp = jk;

    /* determine jx,jv,q0, note that 3>q0 */
    let jx = nx - 1;
    let mut jv = (e0 - 3) / 24;
    if jv < 0 {
        jv = 0;
    }
    let mut q0 = e0 - 24 * (jv + 1);

    /* set up f[0] to f[jx+jk] where f[jx+jk] = ipio2[jv+jk] */
    let mut j = jv - jx;
    let m = jx + jk;
    for i in 0..=m {
        f[i as usize] = if j < 0 { ZERO } else { ipio2[j as usize] as f64 };
        j += 1;
    }

    /* compute q[0],q[1],...q[jk] */
    for i in 0..=jk {
        fw = 0.0;
        for j in 0..=jx {
            fw += x[j as usize] * f[(jx + i - j) as usize];
        }
        q[i as usize] = fw;
    }

    let mut jz = jk;
    let mut z: f64;
    let mut n: i32;
    let mut ih: i32;
    loop {
        /* recompute: */
        /* distill q[] into iq[] reversingly */
        z = q[jz as usize];
        let mut i = 0;
        let mut j = jz;
        while j > 0 {
            fw = ((TWON24 * z) as i32) as f64;
            iq[i as usize] = (z - TWO24 * fw) as i32;
            z = q[(j - 1) as usize] + fw;
            i += 1;
            j -= 1;
        }

        /* compute n */
        z = scalbn(z, q0); /* actual value of z */
        z -= 8.0 * (z * 0.125).floor(); /* trim off integer >= 8 */
        n = z as i32;
        z -= n as f64;
        ih = 0;
        if q0 > 0 {
            /* need iq[jz-1] to determine n */
            let i = iq[(jz - 1) as usize] >> (24 - q0);
            n += i;
            iq[(jz - 1) as usize] -= i << (24 - q0);
            ih = iq[(jz - 1) as usize] >> (23 - q0);
        } else if q0 == 0 {
            ih = iq[(jz - 1) as usize] >> 23;
        } else if z >= 0.5 {
            ih = 2;
        }

        if ih > 0 {
            /* q > 0.5 */
            n += 1;
            let mut carry = 0;
            for i in 0..jz {
                /* compute 1-q */
                let j = iq[i as usize];
                if carry == 0 {
                    if j != 0 {
                        carry = 1;
                        iq[i as usize] = 0x1000000 - j;
                    }
                } else {
                    iq[i as usize] = 0xFFFFFF - j;
                }
            }
            if q0 > 0 {
                /* rare case: chance is 1 in 12 */
                match q0 {
                    1 => iq[(jz - 1) as usize] &= 0x7FFFFF,
                    2 => iq[(jz - 1) as usize] &= 0x3FFFFF,
                    _ => {}
                }
            }
            if ih == 2 {
                z = ONE - z;
                if carry != 0 {
                    z -= scalbn(ONE, q0);
                }
            }
        }

        /* check if recomputation is needed */
        if z == ZERO {
            let mut j = 0;
            let mut i = jz - 1;
            while i >= jk {
                j |= iq[i as usize];
                i -= 1;
            }
            if j == 0 {
                /* need recomputation */
                let mut k = 1;
                while jk >= k && iq[(jk - k) as usize] == 0 {
                    k += 1; /* k = no. of terms needed */
                }

                for i in (jz + 1)..=(jz + k) {
                    /* add q[jz+1] to q[jz+k] */
                    f[(jx + i) as usize] = ipio2[(jv + i) as usize] as f64;
                    fw = 0.0;
                    for j in 0..=jx {
                        fw += x[j as usize] * f[(jx + i - j) as usize];
                    }
                    q[i as usize] = fw;
                }
                jz += k;
                continue; /* goto recompute */
            }
        }
        break;
    }

    /* chop off zero terms */
    if z == 0.0 {
        jz -= 1;
        q0 -= 24;
        while iq[jz as usize] == 0 {
            jz -= 1;
            q0 -= 24;
        }
    } else {
        /* break z into 24-bit if necessary */
        z = scalbn(z, -q0);
        if z >= TWO24 {
            fw = ((TWON24 * z) as i32) as f64;
            iq[jz as usize] = (z - TWO24 * fw) as i32;
            jz += 1;
            q0 += 24;
            iq[jz as usize] = fw as i32;
        } else {
            iq[jz as usize] = z as i32;
        }
    }

    /* convert integer "bit" chunk to floating-point value */
    fw = scalbn(ONE, q0);
    let mut i = jz;
    while i >= 0 {
        q[i as usize] = fw * iq[i as usize] as f64;
        fw *= TWON24;
        i -= 1;
    }

    /* compute PIo2[0,...,jp]*q[jz,...,0] */
    let mut i = jz;
    while i >= 0 {
        fw = 0.0;
        let mut k = 0;
        while k <= jp && k <= jz - i {
            fw += PIO2[k as usize] * q[(i + k) as usize];
            k += 1;
        }
        fq[(jz - i) as usize] = fw;
        i -= 1;
    }

    /* compress fq[] into y[] */
    match prec {
        0 => {
            fw = 0.0;
            let mut i = jz;
            while i >= 0 {
                fw += fq[i as usize];
                i -= 1;
            }
            y[0] = if ih == 0 { fw } else { -fw };
        }
        1 | 2 => {
            fw = 0.0;
            let mut i = jz;
            while i >= 0 {
                fw += fq[i as usize];
                i -= 1;
            }
            y[0] = if ih == 0 { fw } else { -fw };
            fw = fq[0] - fw;
            for i in 1..=jz {
                fw += fq[i as usize];
            }
            y[1] = if ih == 0 { fw } else { -fw };
        }
        _ => {
            /* case 3: painful */
            let mut i = jz;
            while i > 0 {
                fw = fq[(i - 1) as usize] + fq[i as usize];
                fq[i as usize] += fq[(i - 1) as usize] - fw;
                fq[(i - 1) as usize] = fw;
                i -= 1;
            }
            let mut i = jz;
            while i > 1 {
                fw = fq[(i - 1) as usize] + fq[i as usize];
                fq[i as usize] += fq[(i - 1) as usize] - fw;
                fq[(i - 1) as usize] = fw;
                i -= 1;
            }
            fw = 0.0;
            let mut i = jz;
            while i >= 2 {
                fw += fq[i as usize];
                i -= 1;
            }
            if ih == 0 {
                y[0] = fq[0];
                y[1] = fq[1];
                y[2] = fw;
            } else {
                y[0] = -fq[0];
                y[1] = -fq[1];
                y[2] = -fw;
            }
        }
    }
    n & 7
}

/* __kernel_sin( x, y, iy)
 * kernel sin function on [-pi/4, pi/4], pi/4 ~ 0.7854
 * Input x is assumed to be bounded by ~pi/4 in magnitude.
 * Input y is the tail of x.
 * Input iy indicates whether y is 0. (if iy=0, y assume to be 0).
 *
 * Algorithm
 *      1. Since sin(-x) = -sin(x), we need only to consider positive x.
 *      2. if x < 2^-27 (hx<0x3E400000 0), return x with inexact if x!=0.
 *      3. sin(x) is approximated by a polynomial of degree 13 on
 *         [0,pi/4]
 *                               3            13
 *              sin(x) ~ x + S1*x + ... + S6*x
 *      4. sin(x+y) = sin(x) + sin'(x')*y
 *                  ~ sin(x) + (1-x*x/2)*y
 *         For better accuracy, let
 *                   3      2      2      2      2
 *              r = x *(S2+x *(S3+x *(S4+x *(S5+x *S6))))
 *         then                   3    2
 *              sin(x) = x + (S1*x + (x *(r-y/2)+y))
 */
#[inline(always)]
fn kernel_sin(x: f64, y: f64, iy: i32) -> f64 {
    const HALF: f64 = 5.00000000000000000000e-01; /* 0x3FE00000, 0x00000000 */
    const S1: f64 = -1.66666666666666324348e-01; /* 0xBFC55555, 0x55555549 */
    const S2: f64 = 8.33333333332248946124e-03; /* 0x3F811111, 0x1110F8A6 */
    const S3: f64 = -1.98412698298579493134e-04; /* 0xBF2A01A0, 0x19C161D5 */
    const S4: f64 = 2.75573137070700676789e-06; /* 0x3EC71DE3, 0x57B1FE7D */
    const S5: f64 = -2.50507602534068634195e-08; /* 0xBE5AE5E6, 0x8A2B9CEB */
    const S6: f64 = 1.58969099521155010221e-10; /* 0x3DE5D93A, 0x5ACFD57C */

    let ix = high_word(x) & 0x7FFFFFFF; /* high word of x */
    if ix < 0x3E400000 {
        /* |x| < 2**-27 */
        if (x as i32) == 0 {
            return x;
        }
    } /* generate inexact */
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if iy == 0 {
        x + v * (S1 + z * r)
    } else {
        x - ((z * (HALF * y - v * r) - y) - v * S1)
    }
}

/* __kernel_tan( x, y, k )
 * kernel tan function on [-pi/4, pi/4], pi/4 ~ 0.7854
 * Input x is assumed to be bounded by ~pi/4 in magnitude.
 * Input y is the tail of x.
 * Input k indicates whether tan (if k=1) or
 * -1/tan (if k= -1) is returned.
 *
 * Algorithm
 *      1. Since tan(-x) = -tan(x), we need only to consider positive x.
 *      2. if x < 2^-28 (hx<0x3E300000 0), return x with inexact if x!=0.
 *      3. tan(x) is approximated by an odd polynomial of degree 27 on
 *         [0,0.67434]
 *                               3             27
 *              tan(x) ~ x + T1*x + ... + T13*x
 *         Note: tan(x+y) = tan(x) + tan'(x)*y
 *                        ~ tan(x) + (1+x*x)*y
 *         Therefore, for better accuracy in computing tan(x+y), let
 *                   3      2      2       2       2
 *              r = x *(T2+x *(T3+x *(...+x *(T12+x *T13))))
 *         then
 *                                  3    2
 *              tan(x+y) = x + (T1*x + (x *(r+y)+y))
 *
 *      4. For x in [0.67434,pi/4],  let y = pi/4 - x, then
 *              tan(x) = tan(pi/4-y) = (1-tan(y))/(1+tan(y))
 *                     = 1 - 2*(tan(y) - (tan(y)^2)/(1+tan(y)))
 */
fn kernel_tan(mut x: f64, mut y: f64, iy: i32) -> f64 {
    const T: [f64; 13] = [
        3.33333333333334091986e-01,  /* 3FD55555, 55555563 */
        1.33333333333201242699e-01,  /* 3FC11111, 1110FE7A */
        5.39682539762260521377e-02,  /* 3FABA1BA, 1BB341FE */
        2.18694882948595424599e-02,  /* 3F9664F4, 8406D637 */
        8.86323982359930005737e-03,  /* 3F8226E3, E96E8493 */
        3.59207910759131235356e-03,  /* 3F6D6D22, C9560328 */
        1.45620945432529025516e-03,  /* 3F57DBC8, FEE08315 */
        5.88041240820264096874e-04,  /* 3F4344D8, F2F26501 */
        2.46463134818469906812e-04,  /* 3F3026F7, 1A8D1068 */
        7.81794442939557092300e-05,  /* 3F147E88, A03792A6 */
        7.14072491382608190305e-05,  /* 3F12B80F, 32F0A7E9 */
        -1.85586374855275456654e-05, /* BEF375CB, DB605373 */
        2.59073051863633712884e-05,  /* 3EFB2A70, 74BF7AD4 */
    ];
    const ONE: f64 = 1.00000000000000000000e+00; /* 3FF00000, 00000000 */
    const PIO4: f64 = 7.85398163397448278999e-01; /* 3FE921FB, 54442D18 */
    const PIO4LO: f64 = 3.06161699786838301793e-17; /* 3C81A626, 33145C07 */

    let hx = high_word(x); /* high word of x */
    let ix = hx & 0x7FFFFFFF; /* high word of |x| */
    if ix < 0x3E300000 {
        /* x < 2**-28 */
        if (x as i32) == 0 {
            /* generate inexact */
            let low = low_word(x);
            if ((ix as u32 | low) | (iy + 1) as u32) == 0 {
                return ONE / x.abs();
            } else if iy == 1 {
                return x;
            } else {
                /* compute -1 / (x+y) carefully */
                let w = x + y;
                let z = set_low_word(w, 0);
                let v = y - (z - x);
                let a = -ONE / w;
                let t = set_low_word(a, 0);
                let s = ONE + t * z;
                return t + a * (s + t * v);
            }
        }
    }
    if ix >= 0x3FE59428 {
        /* |x| >= 0.6744 */
        if hx < 0 {
            x = -x;
            y = -y;
        }
        let z = PIO4 - x;
        let w = PIO4LO - y;
        x = z + w;
        y = 0.0;
    }
    let z = x * x;
    let w = z * z;
    /*
     * Break x^5*(T[1]+x^2*T[2]+...) into
     * x^5(T[1]+x^4*T[3]+...+x^20*T[11]) +
     * x^5(x^2*(T[2]+x^4*T[4]+...+x^22*[T12]))
     */
    let r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
    let v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
    let s = z * x;
    let mut r = y + z * (s * (r + v) + y);
    r += T[0] * s;
    let w = x + r;
    if ix >= 0x3FE59428 {
        let v = iy as f64;
        return (1 - ((hx >> 30) & 2)) as f64 * (v - 2.0 * (x - (w * w / (w + v) - r)));
    }
    if iy == 1 {
        w
    } else {
        /*
         * if allow error up to 2 ulp, simply return
         * -1.0 / (x+r) here
         */
        /* compute -1.0 / (x+r) accurately */
        let z = set_low_word(w, 0);
        let v = r - (z - x); /* z+v = r+x */
        let a = -1.0 / w; /* a = -1.0/w */
        let t = set_low_word(a, 0);
        let s = 1.0 + t * z;
        t + a * (s + t * v)
    }
}

/* acos(x)
 * Method :
 *      acos(x)  = pi/2 - asin(x)
 *      acos(-x) = pi/2 + asin(x)
 * For |x|<=0.5
 *      acos(x) = pi/2 - (x + x*x^2*R(x^2))     (see asin.c)
 * For x>0.5
 *      acos(x) = pi/2 - (pi/2 - 2asin(sqrt((1-x)/2)))
 *              = 2asin(sqrt((1-x)/2))
 *              = 2s + 2s*z*R(z)        ...z=(1-x)/2, s=sqrt(z)
 *              = 2f + (2c + 2s*z*R(z))
 *     where f=hi part of s, and c = (z-f*f)/(s+f) is the correction term
 *     for f so that f+c ~ sqrt(z).
 * For x<-0.5
 *      acos(x) = pi - 2asin(sqrt((1-|x|)/2))
 *              = pi - 0.5*(s+s*z*R(z)), where z=(1-|x|)/2,s=sqrt(z)
 *
 * Special cases:
 *      if x is NaN, return x itself;
 *      if |x|>1, return NaN with invalid signal.
 */
/// `v8::base::ieee754::acos`
pub fn acos(x: f64) -> f64 {
    const ONE: f64 = 1.00000000000000000000e+00; /* 0x3FF00000, 0x00000000 */
    const PI: f64 = 3.14159265358979311600e+00; /* 0x400921FB, 0x54442D18 */
    const PIO2_HI: f64 = 1.57079632679489655800e+00; /* 0x3FF921FB, 0x54442D18 */
    const PIO2_LO: f64 = 6.12323399573676603587e-17; /* 0x3C91A626, 0x33145C07 */
    const PS0: f64 = 1.66666666666666657415e-01; /* 0x3FC55555, 0x55555555 */
    const PS1: f64 = -3.25565818622400915405e-01; /* 0xBFD4D612, 0x03EB6F7D */
    const PS2: f64 = 2.01212532134862925881e-01; /* 0x3FC9C155, 0x0E884455 */
    const PS3: f64 = -4.00555345006794114027e-02; /* 0xBFA48228, 0xB5688F3B */
    const PS4: f64 = 7.91534994289814532176e-04; /* 0x3F49EFE0, 0x7501B288 */
    const PS5: f64 = 3.47933107596021167570e-05; /* 0x3F023DE1, 0x0DFDF709 */
    const QS1: f64 = -2.40339491173441421878e+00; /* 0xC0033A27, 0x1C8A2D4B */
    const QS2: f64 = 2.02094576023350569471e+00; /* 0x40002AE5, 0x9C598AC8 */
    const QS3: f64 = -6.88283971605453293030e-01; /* 0xBFE6066C, 0x1B8D0159 */
    const QS4: f64 = 7.70381505559019352791e-02; /* 0x3FB3B8C5, 0xB12E9282 */

    let hx = high_word(x);
    let ix = hx & 0x7FFFFFFF;
    if ix >= 0x3FF00000 {
        /* |x| >= 1 */
        let lx = low_word(x);
        if ((ix - 0x3FF00000) as u32 | lx) == 0 {
            /* |x|==1 */
            if hx > 0 {
                return 0.0; /* acos(1) = 0  */
            } else {
                return PI + 2.0 * PIO2_LO; /* acos(-1)= pi */
            }
        }
        return f64::NAN; // acos(|x|>1) is NaN
    }
    if ix < 0x3FE00000 {
        /* |x| < 0.5 */
        if ix <= 0x3C600000 {
            return PIO2_HI + PIO2_LO; /*if|x|<2**-57*/
        }
        let z = x * x;
        let p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
        let q = ONE + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
        let r = p / q;
        PIO2_HI - (x - (PIO2_LO - x * r))
    } else if hx < 0 {
        /* x < -0.5 */
        let z = (ONE + x) * 0.5;
        let p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
        let q = ONE + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
        let s = z.sqrt();
        let r = p / q;
        let w = r * s - PIO2_LO;
        PI - 2.0 * (s + w)
    } else {
        /* x > 0.5 */
        let z = (ONE - x) * 0.5;
        let s = z.sqrt();
        let df = set_low_word(s, 0);
        let c = (z - df * df) / (s + df);
        let p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
        let q = ONE + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
        let r = p / q;
        let w = r * s + c;
        2.0 * (df + w)
    }
}

/* acosh(x)
 * Method :
 *      Based on
 *              acosh(x) = log [ x + sqrt(x*x-1) ]
 *      we have
 *              acosh(x) := log(x)+ln2, if x is large; else
 *              acosh(x) := log(2x-1/(sqrt(x*x-1)+x)) if x>2; else
 *              acosh(x) := log1p(t+sqrt(2.0*t+t*t)); where t=x-1.
 *
 * Special cases:
 *      acosh(x) is NaN with signal if x<1.
 *      acosh(NaN) is NaN without signal.
 */
/// `v8::base::ieee754::acosh`
pub fn acosh(x: f64) -> f64 {
    const ONE: f64 = 1.0;
    const LN2: f64 = 6.93147180559945286227e-01; /* 0x3FE62E42, 0xFEFA39EF */
    let hx = high_word(x);
    let lx = low_word(x);
    if hx < 0x3FF00000 {
        /* x < 1 */
        f64::NAN
    } else if hx >= 0x41B00000 {
        /* x > 2**28 */
        if hx >= 0x7FF00000 {
            /* x is inf of NaN */
            x + x
        } else {
            log(x) + LN2 /* acosh(huge)=log(2x) */
        }
    } else if ((hx - 0x3FF00000) as u32 | lx) == 0 {
        0.0 /* acosh(1) = 0 */
    } else if hx > 0x40000000 {
        /* 2**28 > x > 2 */
        let t = x * x;
        log(2.0 * x - ONE / (x + (t - ONE).sqrt()))
    } else {
        /* 1<x<2 */
        let t = x - ONE;
        log1p(t + (2.0 * t + t * t).sqrt())
    }
}

/* asin(x)
 * Method :
 *      Since  asin(x) = x + x^3/6 + x^5*3/40 + x^7*15/336 + ...
 *      we approximate asin(x) on [0,0.5] by
 *              asin(x) = x + x*x^2*R(x^2)
 *      where
 *              R(x^2) is a rational approximation of (asin(x)-x)/x^3
 *      and its remez error is bounded by
 *              |(asin(x)-x)/x^3 - R(x^2)| < 2^(-58.75)
 *
 *      For x in [0.5,1]
 *              asin(x) = pi/2-2*asin(sqrt((1-x)/2))
 *      Let y = (1-x), z = y/2, s := sqrt(z), and pio2_hi+pio2_lo=pi/2;
 *      then for x>0.98
 *              asin(x) = pi/2 - 2*(s+s*z*R(z))
 *                      = pio2_hi - (2*(s+s*z*R(z)) - pio2_lo)
 *      For x<=0.98, let pio4_hi = pio2_hi/2, then
 *              f = hi part of s;
 *              c = sqrt(z) - f = (z-f*f)/(s+f)         ...f+c=sqrt(z)
 *      and
 *              asin(x) = pi/2 - 2*(s+s*z*R(z))
 *                      = pio4_hi+(pio4-2s)-(2s*z*R(z)-pio2_lo)
 *                      = pio4_hi+(pio4-2f)-(2s*z*R(z)-(pio2_lo+2c))
 *
 * Special cases:
 *      if x is NaN, return x itself;
 *      if |x|>1, return NaN with invalid signal.
 */
/// `v8::base::ieee754::asin`
pub fn asin(x: f64) -> f64 {
    const ONE: f64 = 1.00000000000000000000e+00; /* 0x3FF00000, 0x00000000 */
    const HUGE: f64 = 1.000e+300;
    const PIO2_HI: f64 = 1.57079632679489655800e+00; /* 0x3FF921FB, 0x54442D18 */
    const PIO2_LO: f64 = 6.12323399573676603587e-17; /* 0x3C91A626, 0x33145C07 */
    const PIO4_HI: f64 = 7.85398163397448278999e-01; /* 0x3FE921FB, 0x54442D18 */
    /* coefficient for R(x^2) */
    const PS0: f64 = 1.66666666666666657415e-01; /* 0x3FC55555, 0x55555555 */
    const PS1: f64 = -3.25565818622400915405e-01; /* 0xBFD4D612, 0x03EB6F7D */
    const PS2: f64 = 2.01212532134862925881e-01; /* 0x3FC9C155, 0x0E884455 */
    const PS3: f64 = -4.00555345006794114027e-02; /* 0xBFA48228, 0xB5688F3B */
    const PS4: f64 = 7.91534994289814532176e-04; /* 0x3F49EFE0, 0x7501B288 */
    const PS5: f64 = 3.47933107596021167570e-05; /* 0x3F023DE1, 0x0DFDF709 */
    const QS1: f64 = -2.40339491173441421878e+00; /* 0xC0033A27, 0x1C8A2D4B */
    const QS2: f64 = 2.02094576023350569471e+00; /* 0x40002AE5, 0x9C598AC8 */
    const QS3: f64 = -6.88283971605453293030e-01; /* 0xBFE6066C, 0x1B8D0159 */
    const QS4: f64 = 7.70381505559019352791e-02; /* 0x3FB3B8C5, 0xB12E9282 */

    let mut t = 0.0;
    let hx = high_word(x);
    let ix = hx & 0x7FFFFFFF;
    if ix >= 0x3FF00000 {
        /* |x|>= 1 */
        let lx = low_word(x);
        if ((ix - 0x3FF00000) as u32 | lx) == 0 {
            /* asin(1)=+-pi/2 with inexact */
            return x * PIO2_HI + x * PIO2_LO;
        }
        return f64::NAN; // asin(|x|>1) is NaN
    } else if ix < 0x3FE00000 {
        /* |x|<0.5 */
        if ix < 0x3E400000 {
            /* if |x| < 2**-27 */
            if HUGE + x > ONE {
                return x; /* return x with inexact if x!=0*/
            }
        } else {
            t = x * x;
        }
        let p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
        let q = ONE + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
        let w = p / q;
        return x + x * w;
    }
    /* 1> |x|>= 0.5 */
    let mut w = ONE - x.abs();
    t = w * 0.5;
    let mut p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
    let mut q = ONE + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
    let s = t.sqrt();
    if ix >= 0x3FEF3333 {
        /* if |x| > 0.975 */
        w = p / q;
        t = PIO2_HI - (2.0 * (s + s * w) - PIO2_LO);
    } else {
        w = set_low_word(s, 0);
        let c = (t - w * w) / (s + w);
        let r = p / q;
        p = 2.0 * s * r - (PIO2_LO - 2.0 * c);
        q = PIO4_HI - 2.0 * w;
        t = PIO4_HI - (p - q);
    }
    if hx > 0 {
        t
    } else {
        -t
    }
}

/* asinh(x)
 * Method :
 *      Based on
 *              asinh(x) = sign(x) * log [ |x| + sqrt(x*x+1) ]
 *      we have
 *      asinh(x) := x  if  1+x*x=1,
 *               := sign(x)*(log(x)+ln2)) for large |x|, else
 *               := sign(x)*log(2|x|+1/(|x|+sqrt(x*x+1))) if|x|>2, else
 *               := sign(x)*log1p(|x| + x^2/(1 + sqrt(1+x^2)))
 */
/// `v8::base::ieee754::asinh`
pub fn asinh(x: f64) -> f64 {
    const ONE: f64 = 1.00000000000000000000e+00; /* 0x3FF00000, 0x00000000 */
    const LN2: f64 = 6.93147180559945286227e-01; /* 0x3FE62E42, 0xFEFA39EF */
    const HUGE: f64 = 1.00000000000000000000e+300;

    let hx = high_word(x);
    let ix = hx & 0x7FFFFFFF;
    if ix >= 0x7FF00000 {
        return x + x; /* x is inf or NaN */
    }
    if ix < 0x3E300000 {
        /* |x|<2**-28 */
        if HUGE + x > ONE {
            return x; /* return x inexact except 0 */
        }
    }
    let w;
    if ix > 0x41B00000 {
        /* |x| > 2**28 */
        w = log(x.abs()) + LN2;
    } else if ix > 0x40000000 {
        /* 2**28 > |x| > 2.0 */
        let t = x.abs();
        w = log(2.0 * t + ONE / ((x * x + ONE).sqrt() + t));
    } else {
        /* 2.0 > |x| > 2**-28 */
        let t = x * x;
        w = log1p(x.abs() + t / (ONE + (ONE + t).sqrt()));
    }
    if hx > 0 {
        w
    } else {
        -w
    }
}

/* atan(x)
 * Method
 *   1. Reduce x to positive by atan(x) = -atan(-x).
 *   2. According to the integer k=4t+0.25 chopped, t=x, the argument
 *      is further reduced to one of the following intervals and the
 *      arctangent of t is evaluated by the corresponding formula:
 *
 *      [0,7/16]      atan(x) = t-t^3*(a1+t^2*(a2+...(a10+t^2*a11)...)
 *      [7/16,11/16]  atan(x) = atan(1/2) + atan( (t-0.5)/(1+t/2) )
 *      [11/16.19/16] atan(x) = atan( 1 ) + atan( (t-1)/(1+t) )
 *      [19/16,39/16] atan(x) = atan(3/2) + atan( (t-1.5)/(1+1.5t) )
 *      [39/16,INF]   atan(x) = atan(INF) + atan( -1/t )
 */
/// `v8::base::ieee754::atan`
pub fn atan(mut x: f64) -> f64 {
    const ATANHI: [f64; 4] = [
        4.63647609000806093515e-01, /* atan(0.5)hi 0x3FDDAC67, 0x0561BB4F */
        7.85398163397448278999e-01, /* atan(1.0)hi 0x3FE921FB, 0x54442D18 */
        9.82793723247329054082e-01, /* atan(1.5)hi 0x3FEF730B, 0xD281F69B */
        1.57079632679489655800e+00, /* atan(inf)hi 0x3FF921FB, 0x54442D18 */
    ];

    const ATANLO: [f64; 4] = [
        2.26987774529616870924e-17, /* atan(0.5)lo 0x3C7A2B7F, 0x222F65E2 */
        3.06161699786838301793e-17, /* atan(1.0)lo 0x3C81A626, 0x33145C07 */
        1.39033110312309984516e-17, /* atan(1.5)lo 0x3C700788, 0x7AF0CBBD */
        6.12323399573676603587e-17, /* atan(inf)lo 0x3C91A626, 0x33145C07 */
    ];

    const AT: [f64; 11] = [
        3.33333333333329318027e-01,  /* 0x3FD55555, 0x5555550D */
        -1.99999999998764832476e-01, /* 0xBFC99999, 0x9998EBC4 */
        1.42857142725034663711e-01,  /* 0x3FC24924, 0x920083FF */
        -1.11111104054623557880e-01, /* 0xBFBC71C6, 0xFE231671 */
        9.09088713343650656196e-02,  /* 0x3FB745CD, 0xC54C206E */
        -7.69187620504482999495e-02, /* 0xBFB3B0F2, 0xAF749A6D */
        6.66107313738753120669e-02,  /* 0x3FB10D66, 0xA0D03D51 */
        -5.83357013379057348645e-02, /* 0xBFADDE2D, 0x52DEFD9A */
        4.97687799461593236017e-02,  /* 0x3FA97B4B, 0x24760DEB */
        -3.65315727442169155270e-02, /* 0xBFA2B444, 0x2C6A6C2F */
        1.62858201153657823623e-02,  /* 0x3F90AD3A, 0xE322DA11 */
    ];

    const ONE: f64 = 1.0;
    const HUGE: f64 = 1.0e300;

    let hx = high_word(x);
    let ix = hx & 0x7FFFFFFF;
    if ix >= 0x44100000 {
        /* if |x| >= 2^66 */
        let low = low_word(x);
        if ix > 0x7FF00000 || (ix == 0x7FF00000 && (low != 0)) {
            return x + x; /* NaN */
        }
        if hx > 0 {
            return ATANHI[3] + ATANLO[3];
        } else {
            return -ATANHI[3] - ATANLO[3];
        }
    }
    let id: i32;
    if ix < 0x3FDC0000 {
        /* |x| < 0.4375 */
        if ix < 0x3E400000 {
            /* |x| < 2^-27 */
            if HUGE + x > ONE {
                return x; /* raise inexact */
            }
        }
        id = -1;
    } else {
        x = x.abs();
        if ix < 0x3FF30000 {
            /* |x| < 1.1875 */
            if ix < 0x3FE60000 {
                /* 7/16 <=|x|<11/16 */
                id = 0;
                x = (2.0 * x - ONE) / (2.0 + x);
            } else {
                /* 11/16<=|x|< 19/16 */
                id = 1;
                x = (x - ONE) / (x + ONE);
            }
        } else if ix < 0x40038000 {
            /* |x| < 2.4375 */
            id = 2;
            x = (x - 1.5) / (ONE + 1.5 * x);
        } else {
            /* 2.4375 <= |x| < 2^66 */
            id = 3;
            x = -1.0 / x;
        }
    }
    /* end of argument reduction */
    let z = x * x;
    let w = z * z;
    /* break sum from i=0 to 10 aT[i]z**(i+1) into odd and even poly */
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if id < 0 {
        x - x * (s1 + s2)
    } else {
        let z = ATANHI[id as usize] - ((x * (s1 + s2) - ATANLO[id as usize]) - x);
        if hx < 0 {
            -z
        } else {
            z
        }
    }
}

/* atan2(y,x)
 * Method :
 *      1. Reduce y to positive by atan2(y,x)=-atan2(-y,x).
 *      2. Reduce x to positive by (if x and y are unexceptional):
 *              ARG (x+iy) = arctan(y/x)           ... if x > 0,
 *              ARG (x+iy) = pi - arctan[y/(-x)]   ... if x < 0,
 *
 * Special cases:
 *      ATAN2((anything), NaN ) is NaN;
 *      ATAN2(NAN , (anything) ) is NaN;
 *      ATAN2(+-0, +(anything but NaN)) is +-0  ;
 *      ATAN2(+-0, -(anything but NaN)) is +-pi ;
 *      ATAN2(+-(anything but 0 and NaN), 0) is +-pi/2;
 *      ATAN2(+-(anything but INF and NaN), +INF) is +-0 ;
 *      ATAN2(+-(anything but INF and NaN), -INF) is +-pi;
 *      ATAN2(+-INF,+INF ) is +-pi/4 ;
 *      ATAN2(+-INF,-INF ) is +-3pi/4;
 *      ATAN2(+-INF, (anything but,0,NaN, and INF)) is +-pi/2;
 */
/// `v8::base::ieee754::atan2`
pub fn atan2(y: f64, x: f64) -> f64 {
    const TINY: f64 = 1.0e-300;
    const ZERO: f64 = 0.0;
    const PI_O_4: f64 = 7.8539816339744827900E-01; /* 0x3FE921FB, 0x54442D18 */
    const PI_O_2: f64 = 1.5707963267948965580E+00; /* 0x3FF921FB, 0x54442D18 */
    const PI: f64 = 3.1415926535897931160E+00; /* 0x400921FB, 0x54442D18 */
    const PI_LO: f64 = 1.2246467991473531772E-16; /* 0x3CA1A626, 0x33145C07 */

    let hx = high_word(x);
    let lx = low_word(x);
    let ix = hx & 0x7FFFFFFF;
    let hy = high_word(y);
    let ly = low_word(y);
    let iy = hy & 0x7FFFFFFF;
    if ((ix as u32 | ((lx | lx.wrapping_neg()) >> 31)) > 0x7FF00000)
        || ((iy as u32 | ((ly | ly.wrapping_neg()) >> 31)) > 0x7FF00000)
    {
        return x + y; /* x or y is NaN */
    }
    if (hx.wrapping_sub(0x3FF00000) as u32 | lx) == 0 {
        return atan(y); /* x=1.0 */
    }
    let mut m = ((hy >> 31) & 1) | ((hx >> 30) & 2); /* 2*sign(x)+sign(y) */

    /* when y = 0 */
    if (iy as u32 | ly) == 0 {
        match m {
            0 | 1 => return y,       /* atan(+-0,+anything)=+-0 */
            2 => return PI + TINY,   /* atan(+0,-anything) = pi */
            _ => return -PI - TINY,  /* atan(-0,-anything) =-pi */
        }
    }
    /* when x = 0 */
    if (ix as u32 | lx) == 0 {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }

    /* when x is INF */
    if ix == 0x7FF00000 {
        if iy == 0x7FF00000 {
            match m {
                0 => return PI_O_4 + TINY,        /* atan(+INF,+INF) */
                1 => return -PI_O_4 - TINY,       /* atan(-INF,+INF) */
                2 => return 3.0 * PI_O_4 + TINY,  /*atan(+INF,-INF)*/
                _ => return -3.0 * PI_O_4 - TINY, /*atan(-INF,-INF)*/
            }
        } else {
            match m {
                0 => return ZERO,       /* atan(+...,+INF) */
                1 => return -ZERO,      /* atan(-...,+INF) */
                2 => return PI + TINY,  /* atan(+...,-INF) */
                _ => return -PI - TINY, /* atan(-...,-INF) */
            }
        }
    }
    /* when y is INF */
    if iy == 0x7FF00000 {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }

    /* compute y/x */
    let k = (iy - ix) >> 20;
    let z;
    if k > 60 {
        /* |y/x| >  2**60 */
        z = PI_O_2 + 0.5 * PI_LO;
        m &= 1;
    } else if hx < 0 && k < -60 {
        z = 0.0; /* 0 > |y|/x > -2**-60 */
    } else {
        z = atan((y / x).abs()); /* safe to do y/x */
    }
    match m {
        0 => z,                 /* atan(+,+) */
        1 => -z,                /* atan(-,+) */
        2 => PI - (z - PI_LO),  /* atan(+,-) */
        _ => (z - PI_LO) - PI,  /* case 3: atan(-,-) */
    }
}

/* cos(x)
 * Return cosine function of x.
 *
 * kernel function:
 *      __kernel_sin            ... sine function on [-pi/4,pi/4]
 *      __kernel_cos            ... cosine function on [-pi/4,pi/4]
 *      __ieee754_rem_pio2      ... argument reduction routine
 *
 * Method.
 *      Let S,C and T denote the sin, cos and tan respectively on
 *      [-PI/4, +PI/4]. Reduce the argument x to y1+y2 = x-k*pi/2
 *      in [-pi/4 , +pi/4], and let n = k mod 4.
 *      We have
 *
 *          n        sin(x)      cos(x)        tan(x)
 *     ----------------------------------------------------------
 *          0          S           C             T
 *          1          C          -S            -1/T
 *          2         -S          -C             T
 *          3         -C           S            -1/T
 *     ----------------------------------------------------------
 *
 * Special cases:
 *      Let trig be any of sin, cos, or tan.
 *      trig(+-INF)  is NaN, with signals;
 *      trig(NaN)    is that NaN;
 */
/// `v8::base::ieee754::cos` (the fdlibm one: Node is built without V8_USE_LIBM_TRIG_FUNCTIONS)
pub fn cos(x: f64) -> f64 {
    let z = 0.0;

    /* High word of x. */
    let mut ix = high_word(x);

    /* |x| ~< pi/4 */
    ix &= 0x7FFFFFFF;
    if ix <= 0x3FE921FB {
        kernel_cos(x, z)
    } else if ix >= 0x7FF00000 {
        /* cos(Inf or NaN) is NaN */
        x - x
    } else {
        /* argument reduction needed */
        let (n, y0, y1) = ieee754_rem_pio2(x);
        match n & 3 {
            0 => kernel_cos(y0, y1),
            1 => -kernel_sin(y0, y1, 1),
            2 => -kernel_cos(y0, y1),
            _ => kernel_sin(y0, y1, 1),
        }
    }
}

/* exp(x)
 * Returns the exponential of x.
 *
 * Method
 *   1. Argument reduction:
 *      Reduce x to an r so that |r| <= 0.5*ln2 ~ 0.34658.
 *      Given x, find r and integer k such that
 *
 *               x = k*ln2 + r,  |r| <= 0.5*ln2.
 *
 *      Here r will be represented as r = hi-lo for better
 *      accuracy.
 *
 *   2. Approximation of exp(r) by a special rational function on
 *      the interval [0,0.34658]:
 *      Write
 *          R(r**2) = r*(exp(r)+1)/(exp(r)-1) = 2 + r*r/6 - r**4/360 + ...
 *      We use a special Remes algorithm on [0,0.34658] to generate
 *      a polynomial of degree 5 to approximate R. The computation of
 *      exp(r) thus becomes
 *                             2*r
 *              exp(r) = 1 + -------
 *                            R - r
 *                                 r*R1(r)
 *                     = 1 + r + ----------- (for better accuracy)
 *                                2 - R1(r)
 *      where
 *                               2       4             10
 *              R1(r) = r - (P1*r  + P2*r  + ... + P5*r   ).
 *
 *   3. Scale back to obtain exp(x):
 *      From step 1, we have
 *         exp(x) = 2^k * exp(r)
 *
 * Special cases:
 *      exp(INF) is INF, exp(NaN) is NaN;
 *      exp(-INF) is 0, and
 *      for finite argument, only exp(0)=1 is exact.
 *
 * Misc. info.
 *      For IEEE double
 *          if x >  7.09782712893383973096e+02 then exp(x) overflow
 *          if x < -7.45133219101941108420e+02 then exp(x) underflow
 */
/// `v8::base::ieee754::exp`
pub fn exp(mut x: f64) -> f64 {
    const ONE: f64 = 1.0;
    const HALF: [f64; 2] = [0.5, -0.5];
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02; /* 0x40862E42, 0xFEFA39EF */
    const U_THRESHOLD: f64 = -7.45133219101941108420e+02; /* 0xC0874910, 0xD52D3051 */
    const LN2HI: [f64; 2] = [
        6.93147180369123816490e-01,  /* 0x3FE62E42, 0xFEE00000 */
        -6.93147180369123816490e-01, /* 0xBFE62E42, 0xFEE00000 */
    ];
    const LN2LO: [f64; 2] = [
        1.90821492927058770002e-10,  /* 0x3DEA39EF, 0x35793C76 */
        -1.90821492927058770002e-10, /* 0xBDEA39EF, 0x35793C76 */
    ];
    const INVLN2: f64 = 1.44269504088896338700e+00; /* 0x3FF71547, 0x652B82FE */
    const P1: f64 = 1.66666666666666019037e-01; /* 0x3FC55555, 0x5555553E */
    const P2: f64 = -2.77777777770155933842e-03; /* 0xBF66C16C, 0x16BEBD93 */
    const P3: f64 = 6.61375632143793436117e-05; /* 0x3F11566A, 0xAF25DE2C */
    const P4: f64 = -1.65339022054652515390e-06; /* 0xBEBBBD41, 0xC5D26BF1 */
    const P5: f64 = 4.13813679705723846039e-08; /* 0x3E663769, 0x72BEA4D0 */
    const E: f64 = 2.718281828459045; /* 0x4005BF0A, 0x8B145769 */

    const HUGE: f64 = 1.0e+300;
    const TWOM1000: f64 = 9.33263618503218878990e-302; /* 2**-1000=0x01700000,0*/
    const TWO1023: f64 = 8.988465674311579539e307; /* 0x1p1023 */

    let mut hi = 0.0;
    let mut lo = 0.0;
    let mut k: i32 = 0;

    let mut hx = high_word(x) as u32;
    let xsb = ((hx >> 31) & 1) as usize; /* sign bit of x */
    hx &= 0x7FFFFFFF; /* high word of |x| */

    /* filter out non-finite argument */
    if hx >= 0x40862E42 {
        /* if |x|>=709.78... */
        if hx >= 0x7FF00000 {
            let lx = low_word(x);
            if ((hx & 0xFFFFF) | lx) != 0 {
                return x + x; /* NaN */
            } else {
                return if xsb == 0 { x } else { 0.0 }; /* exp(+-inf)={inf,0} */
            }
        }
        if x > O_THRESHOLD {
            return HUGE * HUGE; /* overflow */
        }
        if x < U_THRESHOLD {
            return TWOM1000 * TWOM1000; /* underflow */
        }
    }

    /* argument reduction */
    if hx > 0x3FD62E42 {
        /* if  |x| > 0.5 ln2 */
        if hx < 0x3FF0A2B2 {
            /* and |x| < 1.5 ln2 */
            /* TODO(rtoy): We special case exp(1) here to return the correct
             * value of E, as the computation below would get the last bit
             * wrong. We should probably fix the algorithm instead.
             */
            if x == 1.0 {
                return E;
            }
            hi = x - LN2HI[xsb];
            lo = LN2LO[xsb];
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = (INVLN2 * x + HALF[xsb]) as i32;
            let t = k as f64;
            hi = x - t * LN2HI[0]; /* t*ln2HI is exact here */
            lo = t * LN2LO[0];
        }
        x = hi - lo;
    } else if hx < 0x3E300000 {
        /* when |x|<2**-28 */
        if HUGE + x > ONE {
            return ONE + x; /* trigger inexact */
        }
    } else {
        k = 0;
    }

    /* x is now in primary range */
    let t = x * x;
    let twopk = if k >= -1021 {
        insert_words(0x3FF00000u32.wrapping_add((k as u32) << 20), 0)
    } else {
        insert_words(0x3FF00000u32.wrapping_add(((k + 1000) as u32) << 20), 0)
    };
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return ONE - ((x * c) / (c - 2.0) - x);
    }
    let y = ONE - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * TWO1023;
        }
        y * twopk
    } else {
        y * twopk * TWOM1000
    }
}

/* atanh(x)
 * Method :
 *    1.Reduced x to positive by atanh(-x) = -atanh(x)
 *    2.For x>=0.5
 *                  1              2x                          x
 *      atanh(x) = --- * log(1 + -------) = 0.5 * log1p(2 * --------)
 *                  2             1 - x                      1 - x
 *
 *      For x<0.5
 *      atanh(x) = 0.5*log1p(2x+2x*x/(1-x))
 *
 * Special cases:
 *      atanh(x) is NaN if |x| > 1 with signal;
 *      atanh(NaN) is that NaN with no signal;
 *      atanh(+-1) is +-INF with signal.
 */
/// `v8::base::ieee754::atanh`
pub fn atanh(mut x: f64) -> f64 {
    const ONE: f64 = 1.0;
    const HUGE: f64 = 1e300;
    const ZERO: f64 = 0.0;

    let hx = high_word(x);
    let lx = low_word(x);
    let ix = hx & 0x7FFFFFFF;
    if (ix as u32 | ((lx | lx.wrapping_neg()) >> 31)) > 0x3FF00000 {
        /* |x|>1 */
        return f64::NAN;
    }
    if ix == 0x3FF00000 {
        return if x > 0.0 { f64::INFINITY } else { f64::NEG_INFINITY };
    }
    if ix < 0x3E300000 && (HUGE + x) > ZERO {
        return x; /* x<2**-28 */
    }
    x = set_high_word(x, ix as u32);
    let mut t;
    if ix < 0x3FE00000 {
        /* x < 0.5 */
        t = x + x;
        t = 0.5 * log1p(t + t * x / (ONE - x));
    } else {
        t = 0.5 * log1p((x + x) / (ONE - x));
    }
    if hx >= 0 {
        t
    } else {
        -t
    }
}

/* log(x)
 * Return the logrithm of x
 *
 * Method :
 *   1. Argument Reduction: find k and f such that
 *                      x = 2^k * (1+f),
 *         where  sqrt(2)/2 < 1+f < sqrt(2) .
 *
 *   2. Approximation of log(1+f).
 *      Let s = f/(2+f) ; based on log(1+f) = log(1+s) - log(1-s)
 *               = 2s + 2/3 s**3 + 2/5 s**5 + .....,
 *               = 2s + s*R
 *      We use a special Reme algorithm on [0,0.1716] to generate
 *      a polynomial of degree 14 to approximate R.
 *              log(1+f) = f - s*(f - R)        (if f is not too large)
 *              log(1+f) = f - (hfsq - s*(hfsq+R)).     (better accuracy)
 *
 *      3. Finally,  log(x) = k*ln2 + log(1+f).
 *                          = k*ln2_hi+(f-(hfsq-(s*(hfsq+R)+k*ln2_lo)))
 *         Here ln2 is split into two floating point number:
 *                      ln2_hi + ln2_lo,
 *         where n*ln2_hi is always exact for |n| < 2000.
 *
 * Special cases:
 *      log(x) is NaN with signal if x < 0 (including -INF) ;
 *      log(+INF) is +INF; log(0) is -INF with signal;
 *      log(NaN) is that NaN with no signal.
 */
/// `v8::base::ieee754::log`
pub fn log(mut x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01; /* 3fe62e42 fee00000 */
    const LN2_LO: f64 = 1.90821492927058770002e-10; /* 3dea39ef 35793c76 */
    const TWO54: f64 = 1.80143985094819840000e+16; /* 43500000 00000000 */
    const LG1: f64 = 6.666666666666735130e-01; /* 3FE55555 55555593 */
    const LG2: f64 = 3.999999999940941908e-01; /* 3FD99999 9997FA04 */
    const LG3: f64 = 2.857142874366239149e-01; /* 3FD24924 94229359 */
    const LG4: f64 = 2.222219843214978396e-01; /* 3FCC71C5 1D8E78AF */
    const LG5: f64 = 1.818357216161805012e-01; /* 3FC74664 96CB03DE */
    const LG6: f64 = 1.531383769920937332e-01; /* 3FC39A09 D078C69F */
    const LG7: f64 = 1.479819860511658591e-01; /* 3FC2F112 DF3E5244 */

    const ZERO: f64 = 0.0;

    let mut hx = high_word(x);
    let lx = low_word(x);

    let mut k: i32 = 0;
    if hx < 0x00100000 {
        /* x < 2**-1022  */
        if ((hx & 0x7FFFFFFF) as u32 | lx) == 0 {
            return f64::NEG_INFINITY; /* log(+-0)=-inf */
        }
        if hx < 0 {
            return f64::NAN; /* log(-#) = NaN */
        }
        k -= 54;
        x *= TWO54; /* subnormal number, scale up x */
        hx = high_word(x);
    }
    if hx >= 0x7FF00000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000FFFFF;
    let mut i = (hx + 0x95F64) & 0x100000;
    x = set_high_word(x, (hx | (i ^ 0x3FF00000)) as u32); /* normalize x or x/2 */
    k += i >> 20;
    let f = x - 1.0;
    if (0x000FFFFF & (2 + hx)) < 3 {
        /* -2**-20 <= f < 2**-20 */
        if f == ZERO {
            if k == 0 {
                return ZERO;
            } else {
                let dk = k as f64;
                return dk * LN2_HI + dk * LN2_LO;
            }
        }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        if k == 0 {
            return f - r;
        } else {
            let dk = k as f64;
            return dk * LN2_HI - ((r - dk * LN2_LO) - f);
        }
    }
    let s = f / (2.0 + f);
    let dk = k as f64;
    let z = s * s;
    i = hx - 0x6147A;
    let w = z * z;
    let j = 0x6B851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

/* double log1p(double x)
 *
 * Method :
 *   1. Argument Reduction: find k and f such that
 *                      1+x = 2^k * (1+f),
 *         where  sqrt(2)/2 < 1+f < sqrt(2) .
 *
 *      Note. If k=0, then f=x is exact. However, if k!=0, then f
 *      may not be representable exactly. In that case, a correction
 *      term is need. Let u=1+x rounded. Let c = (1+x)-u, then
 *      log(1+x) - log(u) ~ c/u. Thus, we proceed to compute log(u),
 *      and add back the correction term c/u.
 *      (Note: when x > 2**53, one can simply return log(x))
 *
 *   2. Approximation of log1p(f): as in log, with the polynomial Lp1..Lp7.
 *
 *      3. Finally, log1p(x) = k*ln2 + log1p(f).
 *                           = k*ln2_hi+(f-(hfsq-(s*(hfsq+R)+k*ln2_lo)))
 *
 * Special cases:
 *      log1p(x) is NaN with signal if x < -1 (including -INF) ;
 *      log1p(+INF) is +INF; log1p(-1) is -INF with signal;
 *      log1p(NaN) is that NaN with no signal.
 */
/// `v8::base::ieee754::log1p`
pub fn log1p(x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01; /* 3fe62e42 fee00000 */
    const LN2_LO: f64 = 1.90821492927058770002e-10; /* 3dea39ef 35793c76 */
    const TWO54: f64 = 1.80143985094819840000e+16; /* 43500000 00000000 */
    const LP1: f64 = 6.666666666666735130e-01; /* 3FE55555 55555593 */
    const LP2: f64 = 3.999999999940941908e-01; /* 3FD99999 9997FA04 */
    const LP3: f64 = 2.857142874366239149e-01; /* 3FD24924 94229359 */
    const LP4: f64 = 2.222219843214978396e-01; /* 3FCC71C5 1D8E78AF */
    const LP5: f64 = 1.818357216161805012e-01; /* 3FC74664 96CB03DE */
    const LP6: f64 = 1.531383769920937332e-01; /* 3FC39A09 D078C69F */
    const LP7: f64 = 1.479819860511658591e-01; /* 3FC2F112 DF3E5244 */

    const ZERO: f64 = 0.0;

    let mut f = 0.0;
    let mut c = 0.0;
    let mut hu: i32 = 0;

    let hx = high_word(x);
    let ax = hx & 0x7FFFFFFF;

    let mut k: i32 = 1;
    if hx < 0x3FDA827A {
        /* 1+x < sqrt(2)+ */
        if ax >= 0x3FF00000 {
            /* x <= -1.0 */
            if x == -1.0 {
                return f64::NEG_INFINITY; /* log1p(-1)=+inf */
            } else {
                return f64::NAN; // log1p(x<-1)=NaN
            }
        }
        if ax < 0x3E200000 {
            /* |x| < 2**-29 */
            if TWO54 + x > ZERO /* raise inexact */
                && ax < 0x3C900000
            /* |x| < 2**-54 */
            {
                return x;
            } else {
                return x - x * x * 0.5;
            }
        }
        if hx > 0 || hx <= (0xBFD2BEC4u32 as i32) {
            k = 0;
            f = x;
            hu = 1;
        } /* sqrt(2)/2- <= 1+x < sqrt(2)+ */
    }
    if hx >= 0x7FF00000 {
        return x + x;
    }
    if k != 0 {
        let mut u;
        if hx < 0x43400000 {
            u = 1.0 + x;
            hu = high_word(u);
            k = (hu >> 20) - 1023;
            c = if k > 0 { 1.0 - (u - x) } else { x - (u - 1.0) }; /* correction term */
            c /= u;
        } else {
            u = x;
            hu = high_word(u);
            k = (hu >> 20) - 1023;
            c = 0.0;
        }
        hu &= 0x000FFFFF;
        /*
         * The approximation to sqrt(2) used in thresholds is not
         * critical.  However, the ones used above must give less
         * strict bounds than the one here so that the k==0 case is
         * never reached from here, since here we have committed to
         * using the correction term but don't use it if k==0.
         */
        if hu < 0x6A09E {
            /* u ~< sqrt(2) */
            u = set_high_word(u, (hu | 0x3FF00000) as u32); /* normalize u */
        } else {
            k += 1;
            u = set_high_word(u, (hu | 0x3FE00000) as u32); /* normalize u/2 */
            hu = (0x00100000 - hu) >> 2;
        }
        f = u - 1.0;
    }
    let hfsq = 0.5 * f * f;
    let kd = k as f64;
    if hu == 0 {
        /* |f| < 2**-20 */
        if f == ZERO {
            if k == 0 {
                return ZERO;
            } else {
                c += kd * LN2_LO;
                return kd * LN2_HI + c;
            }
        }
        let r = hfsq * (1.0 - 0.66666666666666666 * f);
        if k == 0 {
            return f - r;
        } else {
            return kd * LN2_HI - ((r - (kd * LN2_LO + c)) - f);
        }
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let r = z * (LP1 + z * (LP2 + z * (LP3 + z * (LP4 + z * (LP5 + z * (LP6 + z * LP7))))));
    if k == 0 {
        f - (hfsq - s * (hfsq + r))
    } else {
        kd * LN2_HI - ((hfsq - (s * (hfsq + r) + (kd * LN2_LO + c))) - f)
    }
}

/*
 * k_log1p(f):
 * Return log(1+f) - f for 1+f in ~[sqrt(2)/2, sqrt(2)].
 *
 * The following describes the overall strategy for computing
 * logarithms in base e.  The base-e results are post-processed for
 * base 2 (log2).
 *
 * As in log(), with R(z) split into odd and even terms, and
 *      log(1+f) = f - s*(f - R)        (if f is not too large)
 *      log(1+f) = f - (hfsq - s*(hfsq+R)).     (better accuracy)
 */
#[inline(always)]
fn k_log1p(f: f64) -> f64 {
    const LG1: f64 = 6.666666666666735130e-01; /* 3FE55555 55555593 */
    const LG2: f64 = 3.999999999940941908e-01; /* 3FD99999 9997FA04 */
    const LG3: f64 = 2.857142874366239149e-01; /* 3FD24924 94229359 */
    const LG4: f64 = 2.222219843214978396e-01; /* 3FCC71C5 1D8E78AF */
    const LG5: f64 = 1.818357216161805012e-01; /* 3FC74664 96CB03DE */
    const LG6: f64 = 1.531383769920937332e-01; /* 3FC39A09 D078C69F */
    const LG7: f64 = 1.479819860511658591e-01; /* 3FC2F112 DF3E5244 */

    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    let r = t2 + t1;
    let hfsq = 0.5 * f * f;
    s * (hfsq + r)
}

/*
 * Return the base 2 logarithm of x.  See k_log1p for most details of the
 * computation of the logarithm of the mantissa: log(1+f) = f - hfsq + r, with
 * f - hfsq split into hi + lo and the product with 1/ln2 = ivln2hi + ivln2lo
 * added to k with an extra-precision sum.
 */
/// `v8::base::ieee754::log2`
pub fn log2(mut x: f64) -> f64 {
    const TWO54: f64 = 1.80143985094819840000e+16; /* 0x43500000, 0x00000000 */
    const IVLN2HI: f64 = 1.44269504072144627571e+00; /* 0x3FF71547, 0x65200000 */
    const IVLN2LO: f64 = 1.67517131648865118353e-10; /* 0x3DE705FC, 0x2EEFA200 */

    let mut hx = high_word(x);
    let lx = low_word(x);

    let mut k: i32 = 0;
    if hx < 0x00100000 {
        /* x < 2**-1022  */
        if ((hx & 0x7FFFFFFF) as u32 | lx) == 0 {
            return f64::NEG_INFINITY; /* log(+-0)=-inf */
        }
        if hx < 0 {
            return f64::NAN; /* log(-#) = NaN */
        }
        k -= 54;
        x *= TWO54; /* subnormal number, scale up x */
        hx = high_word(x);
    }
    if hx >= 0x7FF00000 {
        return x + x;
    }
    if hx == 0x3FF00000 && lx == 0 {
        return 0.0; /* log(1) = +0 */
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000FFFFF;
    let i = (hx + 0x95F64) & 0x100000;
    x = set_high_word(x, (hx | (i ^ 0x3FF00000)) as u32); /* normalize x or x/2 */
    k += i >> 20;
    let y = k as f64;
    let f = x - 1.0;
    let hfsq = 0.5 * f * f;
    let r = k_log1p(f);

    /*
     * f-hfsq must (for args near 1) be evaluated in extra precision
     * to avoid a large cancellation when x is near sqrt(2) or 1/sqrt(2).
     * This is fairly efficient since f-hfsq only depends on f, so can
     * be evaluated in parallel with R.  Not combining hfsq with R also
     * keeps R small (though not as small as a true `lo' term would be),
     * so that extra precision is not needed for terms involving R.
     */
    let hi = set_low_word(f - hfsq, 0);
    let lo = (f - hi) - hfsq + r;
    let mut val_hi = hi * IVLN2HI;
    let mut val_lo = (lo + hi) * IVLN2LO + lo * IVLN2HI;

    /* spadd(val_hi, val_lo, y), except for not using double_t: */
    let w = y + val_hi;
    val_lo += (y - w) + val_hi;
    val_hi = w;

    val_lo + val_hi
}

/*
 * Return the base 10 logarithm of x
 *
 * Method :
 *      Let log10_2hi = leading 40 bits of log10(2) and
 *          log10_2lo = log10(2) - log10_2hi,
 *          ivln10   = 1/log(10) rounded.
 *      Then
 *              n = ilogb(x),
 *              if(n<0)  n = n+1;
 *              x = scalbn(x,-n);
 *              log10(x) := n*log10_2hi + (n*log10_2lo + ivln10*log(x))
 *
 *  Note 1:
 *     To guarantee log10(10**n)=n, where 10**n is normal, the rounding
 *     mode must set to Round-to-Nearest.
 *
 * Special cases:
 *      log10(x) is NaN if x < 0;
 *      log10(+INF) is +INF; log10(0) is -INF;
 *      log10(NaN) is that NaN;
 *      log10(10**N) = N  for N=0,...,22.
 */
/// `v8::base::ieee754::log10`
pub fn log10(mut x: f64) -> f64 {
    const TWO54: f64 = 1.80143985094819840000e+16; /* 0x43500000, 0x00000000 */
    const IVLN10: f64 = 4.34294481903251816668e-01;
    const LOG10_2HI: f64 = 3.01029995663611771306e-01; /* 0x3FD34413, 0x509F6000 */
    const LOG10_2LO: f64 = 3.69423907715893078616e-13; /* 0x3D59FEF3, 0x11F12B36 */

    let mut hx = high_word(x);
    let mut lx = low_word(x);

    let mut k: i32 = 0;
    if hx < 0x00100000 {
        /* x < 2**-1022  */
        if ((hx & 0x7FFFFFFF) as u32 | lx) == 0 {
            return f64::NEG_INFINITY; /* log(+-0)=-inf */
        }
        if hx < 0 {
            return f64::NAN; /* log(-#) = NaN */
        }
        k -= 54;
        x *= TWO54; /* subnormal number, scale up x */
        hx = high_word(x);
        lx = low_word(x);
    }
    if hx >= 0x7FF00000 {
        return x + x;
    }
    if hx == 0x3FF00000 && lx == 0 {
        return 0.0; /* log(1) = +0 */
    }
    k += (hx >> 20) - 1023;

    let i = (((k as u32) & 0x80000000) >> 31) as i32;
    hx = (hx & 0x000FFFFF) | ((0x3FF - i) << 20);
    let y = (k + i) as f64;
    x = set_high_word(x, hx as u32);
    x = set_low_word(x, lx);

    let z = y * LOG10_2LO + IVLN10 * log(x);
    z + y * LOG10_2HI
}

/* expm1(x)
 * Returns exp(x)-1, the exponential of x minus 1.
 *
 * Method
 *   1. Argument reduction:
 *      Given x, find r and integer k such that
 *
 *               x = k*ln2 + r,  |r| <= 0.5*ln2 ~ 0.34658
 *
 *      Here a correction term c will be computed to compensate
 *      the error in r when rounded to a floating-point number.
 *
 *   2. Approximating expm1(r) by a special rational function on
 *      the interval [0,0.34658]:
 *              R1(r*r) = 1 + Q1*z + ... + Q5*z^5,   z = r*r,
 *      and
 *                            r*r       r*r*(R1 - (3 - R1*r/2))
 *              expm1(r) = r + --- + -------------------------
 *                             2        6 - r*(3 - R1*r/2)
 *      To compensate the error in the argument reduction, we use
 *              expm1(r+c) = expm1(r) + c + expm1(r)*c
 *                         ~ expm1(r) + c + r*c
 *      Thus c+r*c will be added in as the correction terms for
 *      expm1(r+c). Now rearrange the term to avoid optimization
 *      screw up:
 *              expm1(r+c) ~ r - (r*(e-c)-c) + 0.5 r*r
 *
 *   3. Scale back to obtain expm1(x):
 *      From step 1, we have
 *         expm1(x) = either 2^k*[expm1(r)+1] - 1
 *                  = or     2^k*[expm1(r) + (1-2^-k)]
 *   4. Implementation notes:
 *      (A). To save one multiplication, we scale the coefficient Qi
 *           to Qi*2^i, and replace z by (x^2)/2.
 *      (B). To achieve maximum accuracy, we compute expm1(x) by
 *        (i)   if x < -56*ln2, return -1.0, (raise inexact if x!=inf)
 *        (ii)  if k=0, return r-E
 *        (iii) if k=-1, return 0.5*(r-E)-0.5
 *        (iv)  if k=1 if r < -0.25, return 2*((r+0.5)- E)
 *                     else          return  1.0+2.0*(r-E);
 *        (v)   if (k<-2||k>56) return 2^k(1-(E-r)) - 1 (or exp(x)-1)
 *        (vi)  if k <= 20, return 2^k((1-2^-k)-(E-r)), else
 *        (vii) return 2^k(1-((E+2^-k)-r))
 *
 * Special cases:
 *      expm1(INF) is INF, expm1(NaN) is NaN;
 *      expm1(-INF) is -1, and
 *      for finite argument, only expm1(0)=0 is exact.
 */
/// `v8::base::ieee754::expm1`
pub fn expm1(mut x: f64) -> f64 {
    const ONE: f64 = 1.0;
    const TINY: f64 = 1.0e-300;
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02; /* 0x40862E42, 0xFEFA39EF */
    const LN2_HI: f64 = 6.93147180369123816490e-01; /* 0x3FE62E42, 0xFEE00000 */
    const LN2_LO: f64 = 1.90821492927058770002e-10; /* 0x3DEA39EF, 0x35793C76 */
    const INVLN2: f64 = 1.44269504088896338700e+00; /* 0x3FF71547, 0x652B82FE */
    /* Scaled Q's: Qn_here = 2**n * Qn_above, for R(2*z) where z = hxs =
     * x*x/2: */
    const Q1: f64 = -3.33333333333331316428e-02; /* BFA11111 111110F4 */
    const Q2: f64 = 1.58730158725481460165e-03; /* 3F5A01A0 19FE5585 */
    const Q3: f64 = -7.93650757867487942473e-05; /* BF14CE19 9EAADBB7 */
    const Q4: f64 = 4.00821782732936239552e-06; /* 3ED0CFCA 86E65239 */
    const Q5: f64 = -2.01099218183624371326e-07; /* BE8AFDB7 6E09C32D */

    const HUGE: f64 = 1.0e+300;

    let hi;
    let lo;
    let c;
    let mut t;
    let k: i32;

    let mut hx = high_word(x) as u32;
    let xsb = hx & 0x80000000; /* sign bit of x */
    hx &= 0x7FFFFFFF; /* high word of |x| */

    /* filter out huge and non-finite argument */
    if hx >= 0x4043687A {
        /* if |x|>=56*ln2 */
        if hx >= 0x40862E42 {
            /* if |x|>=709.78... */
            if hx >= 0x7FF00000 {
                let low = low_word(x);
                if ((hx & 0xFFFFF) | low) != 0 {
                    return x + x; /* NaN */
                } else {
                    return if xsb == 0 { x } else { -1.0 }; /* exp(+-inf)={inf,-1} */
                }
            }
            if x > O_THRESHOLD {
                return HUGE * HUGE; /* overflow */
            }
        }
        if xsb != 0 {
            /* x < -56*ln2, return -1.0 with inexact */
            if x + TINY < 0.0 {
                /* raise inexact */
                return TINY - ONE; /* return -1 */
            }
        }
    }

    /* argument reduction */
    if hx > 0x3FD62E42 {
        /* if  |x| > 0.5 ln2 */
        if hx < 0x3FF0A2B2 {
            /* and |x| < 1.5 ln2 */
            if xsb == 0 {
                hi = x - LN2_HI;
                lo = LN2_LO;
                k = 1;
            } else {
                hi = x + LN2_HI;
                lo = -LN2_LO;
                k = -1;
            }
        } else {
            k = (INVLN2 * x + (if xsb == 0 { 0.5 } else { -0.5 })) as i32;
            t = k as f64;
            hi = x - t * LN2_HI; /* t*ln2_hi is exact here */
            lo = t * LN2_LO;
        }
        x = hi - lo;
        c = (hi - x) - lo;
    } else if hx < 0x3C900000 {
        /* when |x|<2**-54, return x */
        t = HUGE + x; /* return x with inexact flags when x!=0 */
        return x - (t - (HUGE + x));
    } else {
        k = 0;
        c = 0.0;
    }

    /* x is now in primary range */
    let hfx = 0.5 * x;
    let hxs = x * hfx;
    let r1 = ONE + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
    t = 3.0 - r1 * hfx;
    let mut e = hxs * ((r1 - t) / (6.0 - x * t));
    if k == 0 {
        return x - (x * e - hxs); /* c is 0 */
    }
    let twopk = insert_words(0x3FF00000u32.wrapping_add((k as u32) << 20), 0); /* 2^k */
    e = x * (e - c) - c;
    e -= hxs;
    if k == -1 {
        return 0.5 * (x - e) - 0.5;
    }
    if k == 1 {
        if x < -0.25 {
            return -2.0 * (e - (x + 0.5));
        } else {
            return ONE + 2.0 * (x - e);
        }
    }
    let mut y;
    if k <= -2 || k > 56 {
        /* suffice to return exp(x)-1 */
        y = ONE - (e - x);
        // TODO(mvstanton): is this replacement for the hex float
        // sufficient?
        // if (k == 1024) y = y*2.0*0x1p1023;
        if k == 1024 {
            y = y * 2.0 * 8.98846567431158e+307;
        } else {
            y *= twopk;
        }
        return y - ONE;
    }
    t = ONE;
    if k < 20 {
        t = set_high_word(t, (0x3FF00000 - (0x200000 >> k)) as u32); /* t=1-2^-k */
        y = t - (e - x);
        y *= twopk;
    } else {
        t = set_high_word(t, ((0x3FF - k) << 20) as u32); /* 2^-k */
        y = x - (e + t);
        y += ONE;
        y *= twopk;
    }
    y
}

/* cbrt(x)
 * Return cube root of x
 */
/// `v8::base::ieee754::cbrt`
pub fn cbrt(x: f64) -> f64 {
    const B1: u32 = 715094163; /* B1 = (1023-1023/3-0.03306235651)*2**20 */
    const B2: u32 = 696219795; /* B2 = (1023-1023/3-54/3-0.03306235651)*2**20 */

    /* |1/cbrt(x) - p(x)| < 2**-23.5 (~[-7.93e-8, 7.929e-8]). */
    const P0: f64 = 1.87595182427177009643; /* 0x3FFE03E6, 0x0F61E692 */
    const P1: f64 = -1.88497979543377169875; /* 0xBFFE28E0, 0x92F02420 */
    const P2: f64 = 1.621429720105354466140; /* 0x3FF9F160, 0x4A49D6C2 */
    const P3: f64 = -0.758397934778766047437; /* 0xBFE844CB, 0xBEE751D9 */
    const P4: f64 = 0.145996192886612446982; /* 0x3FC2B000, 0xD4E4EDD7 */

    let mut hx = high_word(x) as u32;
    let low = low_word(x);
    let sign = hx & 0x80000000; /* sign= sign(x) */
    hx ^= sign;
    if hx >= 0x7FF00000 {
        return x + x; /* cbrt(NaN,INF) is itself */
    }

    /*
     * Rough cbrt to 5 bits:
     *    cbrt(2**e*(1+m) ~= 2**(e/3)*(1+(e%3+m)/3)
     * where e is integral and >= 0, m is real and in [0, 1), and "/" and
     * "%" are integer division and modulus with rounding towards minus
     * infinity.  The RHS is always >= the LHS and has a maximum relative
     * error of about 1 in 16.  Adding a bias of -0.03306235651 to the
     * (e%3+m)/3 term reduces the error to about 1 in 32. With the IEEE
     * floating point representation, for finite positive normal values,
     * ordinary integer division of the value in bits magically gives
     * almost exactly the RHS of the above provided we first subtract the
     * exponent bias (1023 for doubles) and later add it back.  We do the
     * subtraction virtually to keep e >= 0 so that ordinary integer
     * division rounds towards minus infinity; this is also efficient.
     */
    let mut t;
    if hx < 0x00100000 {
        /* zero or subnormal? */
        if (hx | low) == 0 {
            return x; /* cbrt(0) is itself */
        }
        t = set_high_word(0.0, 0x43500000); /* set t= 2**54 */
        t *= x;
        let high = high_word(t) as u32;
        t = insert_words(sign | ((high & 0x7FFFFFFF) / 3 + B2), 0);
    } else {
        t = insert_words(sign | (hx / 3 + B1), 0);
    }

    /*
     * New cbrt to 23 bits:
     *    cbrt(x) = t*cbrt(x/t**3) ~= t*P(t**3/x)
     * where P(r) is a polynomial of degree 4 that approximates 1/cbrt(r)
     * to within 2**-23.5 when |r - 1| < 1/10.  The rough approximation
     * has produced t such than |t/cbrt(x) - 1| ~= 2**-5 > 1/10, so
     * this gives us bounds for r = t**3/x.
     */
    let mut r = (t * t) * (t / x);
    t = t * ((P0 + r * (P1 + r * P2)) + ((r * r) * r) * (P3 + r * P4));

    /*
     * Round t away from zero to 23 bits (sloppily except for ensuring that
     * the result is larger in magnitude than cbrt(x) but not much more than
     * 2 23-bit ulps larger).  With rounding towards zero, the error bound
     * would be ~5/6 instead of ~4/6.  With a maximum error of 2 23-bit ulps
     * in the rounded t, the infinite-precision error in the Newton
     * approximation barely affects third digit in the final error
     * 0.667; the error in the rounded t can be up to about 3 23-bit ulps
     * before the final error is larger than 0.667 ulps.
     */
    let mut bits = t.to_bits();
    bits = bits.wrapping_add(0x80000000) & 0xFFFFFFFFC0000000;
    t = f64::from_bits(bits);

    /* one step Newton iteration to 53 bits with error < 0.667 ulps */
    let s = t * t; /* t*t is exact */
    r = x / s; /* error <= 0.5 ulps; |r| < |t| */
    let w = t + t; /* t+t is exact */
    r = (r - t) / (w + r); /* r-t is exact; w+r ~= 3*t */
    t + t * r /* error <= 0.5 + 0.5/3 + epsilon */
}

/* sin(x)
 * Return sine function of x.
 * See cos for the method and the table of quadrants.
 */
/// `v8::base::ieee754::sin` (the fdlibm one: Node is built without V8_USE_LIBM_TRIG_FUNCTIONS)
pub fn sin(x: f64) -> f64 {
    let z = 0.0;

    /* High word of x. */
    let mut ix = high_word(x);

    /* |x| ~< pi/4 */
    ix &= 0x7FFFFFFF;
    if ix <= 0x3FE921FB {
        kernel_sin(x, z, 0)
    } else if ix >= 0x7FF00000 {
        /* sin(Inf or NaN) is NaN */
        x - x
    } else {
        /* argument reduction needed */
        let (n, y0, y1) = ieee754_rem_pio2(x);
        match n & 3 {
            0 => kernel_sin(y0, y1, 1),
            1 => kernel_cos(y0, y1),
            2 => -kernel_sin(y0, y1, 1),
            _ => -kernel_cos(y0, y1),
        }
    }
}

/* tan(x)
 * Return tangent function of x.
 * See cos for the method and the table of quadrants.
 */
/// `v8::base::ieee754::tan`
pub fn tan(x: f64) -> f64 {
    let z = 0.0;

    /* High word of x. */
    let mut ix = high_word(x);

    /* |x| ~< pi/4 */
    ix &= 0x7FFFFFFF;
    if ix <= 0x3FE921FB {
        kernel_tan(x, z, 1)
    } else if ix >= 0x7FF00000 {
        /* tan(Inf or NaN) is NaN */
        x - x /* NaN */
    } else {
        /* argument reduction needed */
        let (n, y0, y1) = ieee754_rem_pio2(x);
        /* 1 -> n even, -1 -> n odd */
        kernel_tan(y0, y1, 1 - ((n & 1) << 1))
    }
}

/*
 * ES6 draft 09-27-13, section 20.2.2.12.
 * Math.cosh
 * Method :
 * mathematically cosh(x) if defined to be (exp(x)+exp(-x))/2
 *      1. Replace x by |x| (cosh(x) = cosh(-x)).
 *      2.
 *                                                      [ exp(x) - 1 ]^2
 *          0        <= x <= ln2/2  :  cosh(x) := 1 + -------------------
 *                                                         2*exp(x)
 *
 *                                                 exp(x) + 1/exp(x)
 *          ln2/2    <= x <= 22     :  cosh(x) := -------------------
 *                                                        2
 *          22       <= x <= lnovft :  cosh(x) := exp(x)/2
 *          lnovft   <= x <= ln2ovft:  cosh(x) := exp(x/2)/2 * exp(x/2)
 *          ln2ovft  <  x           :  cosh(x) := huge*huge (overflow)
 *
 * Special cases:
 *      cosh(x) is |x| if x is +INF, -INF, or NaN.
 *      only cosh(0)=1 is exact for finite x.
 */
/// `v8::base::ieee754::cosh`
pub fn cosh(x: f64) -> f64 {
    const KCOSH_OVERFLOW: f64 = 710.4758600739439;
    const ONE: f64 = 1.0;
    const HALF: f64 = 0.5;
    const HUGE: f64 = 1.0e+300;

    /* High word of |x|. */
    let mut ix = high_word(x);
    ix &= 0x7FFFFFFF;

    // |x| in [0,0.5*log2], return 1+expm1(|x|)^2/(2*exp(|x|))
    if ix < 0x3FD62E43 {
        let t = expm1(x.abs());
        let w = ONE + t;
        // For |x| < 2^-55, cosh(x) = 1
        if ix < 0x3C800000 {
            return w;
        }
        return ONE + (t * t) / (w + w);
    }

    // |x| in [0.5*log2, 22], return (exp(|x|)+1/exp(|x|)/2
    if ix < 0x40360000 {
        let t = exp(x.abs());
        return HALF * t + HALF / t;
    }

    // |x| in [22, log(maxdouble)], return half*exp(|x|)
    if ix < 0x40862E42 {
        return HALF * exp(x.abs());
    }

    // |x| in [log(maxdouble), overflowthreshold]
    if x.abs() <= KCOSH_OVERFLOW {
        let w = exp(HALF * x.abs());
        let t = HALF * w;
        return t * w;
    }

    /* x is INF or NaN */
    if ix >= 0x7FF00000 {
        return x * x;
    }

    // |x| > overflowthreshold.
    HUGE * HUGE
}

/*
 * ES2019 Draft 2019-01-02 12.6.4
 * Math.pow & Exponentiation Operator: not ported. `v8::base::ieee754::legacy::pow` is only used
 * with --no-use-std-math-pow; `Math.pow` is `std::pow` (see math.rs).
 */

/*
 * ES6 draft 09-27-13, section 20.2.2.30.
 * Math.sinh
 * Method :
 * mathematically sinh(x) if defined to be (exp(x)-exp(-x))/2
 *      1. Replace x by |x| (sinh(-x) = -sinh(x)).
 *      2.
 *                                                  E + E/(E+1)
 *          0        <= x <= 22     :  sinh(x) := --------------, E=expm1(x)
 *                                                      2
 *
 *          22       <= x <= lnovft :  sinh(x) := exp(x)/2
 *          lnovft   <= x <= ln2ovft:  sinh(x) := exp(x/2)/2 * exp(x/2)
 *          ln2ovft  <  x           :  sinh(x) := x*shuge (overflow)
 *
 * Special cases:
 *      sinh(x) is |x| if x is +Infinity, -Infinity, or NaN.
 *      only sinh(0)=0 is exact for finite x.
 */
/// `v8::base::ieee754::sinh`
pub fn sinh(x: f64) -> f64 {
    const KSINH_OVERFLOW: f64 = 710.4758600739439;
    const TWO_M28: f64 = 3.725290298461914e-9; // 2^-28, empty lower half
    const LOG_MAXD: f64 = 709.7822265625; // 0x40862E42 00000000, empty lower half
    const SHUGE: f64 = 1.0e307;

    let h = if x < 0.0 { -0.5 } else { 0.5 };
    // |x| in [0, 22]. return sign(x)*0.5*(E+E/(E+1))
    let ax = x.abs();
    if ax < 22.0 {
        // For |x| < 2^-28, sinh(x) = x
        if ax < TWO_M28 {
            return x;
        }
        let t = expm1(ax);
        if ax < 1.0 {
            return h * (2.0 * t - t * t / (t + 1.0));
        }
        return h * (t + t / (t + 1.0));
    }
    // |x| in [22, log(maxdouble)], return 0.5 * exp(|x|)
    if ax < LOG_MAXD {
        return h * exp(ax);
    }
    // |x| in [log(maxdouble), overflowthreshold]
    // overflowthreshold = 710.4758600739426
    if ax <= KSINH_OVERFLOW {
        let w = exp(0.5 * ax);
        let t = h * w;
        return t * w;
    }
    // |x| > overflowthreshold or is NaN.
    // Return Infinity of the appropriate sign or NaN.
    x * SHUGE
}

/* Tanh(x)
 * Return the Hyperbolic Tangent of x
 *
 * Method :
 *                                 x    -x
 *                                e  - e
 *  0. tanh(x) is defined to be -----------
 *                                 x    -x
 *                                e  + e
 *  1. reduce x to non-negative by tanh(-x) = -tanh(x).
 *  2.  0      <= x <  2**-28 : tanh(x) := x with inexact if x != 0
 *                                          -t
 *      2**-28 <= x <  1      : tanh(x) := -----; t = expm1(-2x)
 *                                         t + 2
 *                                               2
 *      1      <= x <  22     : tanh(x) := 1 - -----; t = expm1(2x)
 *                                             t + 2
 *      22     <= x <= INF    : tanh(x) := 1.
 *
 * Special cases:
 *      tanh(NaN) is NaN;
 *      only tanh(0)=0 is exact for finite argument.
 */
/// `v8::base::ieee754::tanh`
pub fn tanh(x: f64) -> f64 {
    const TINY: f64 = 1.0e-300;
    const ONE: f64 = 1.0;
    const TWO: f64 = 2.0;
    const HUGE: f64 = 1.0e300;

    let jx = high_word(x);
    let ix = jx & 0x7FFFFFFF;

    /* x is INF or NaN */
    if ix >= 0x7FF00000 {
        if jx >= 0 {
            return ONE / x + ONE; /* tanh(+-inf)=+-1 */
        } else {
            return ONE / x - ONE; /* tanh(NaN) = NaN */
        }
    }

    let z;
    /* |x| < 22 */
    if ix < 0x40360000 {
        /* |x|<22 */
        if ix < 0x3E300000 {
            /* |x|<2**-28 */
            if HUGE + x > ONE {
                return x; /* tanh(tiny) = tiny with inexact */
            }
        }
        if ix >= 0x3FF00000 {
            /* |x|>=1  */
            let t = expm1(TWO * x.abs());
            z = ONE - TWO / (t + TWO);
        } else {
            let t = expm1(-TWO * x.abs());
            z = -t / (t + TWO);
        }
        /* |x| >= 22, return +-1 */
    } else {
        z = ONE - TINY; /* raise inexact flag */
    }
    if jx >= 0 {
        z
    } else {
        -z
    }
}

#[cfg(test)]
mod tests {
    /// Results of Node 24 on Linux x86-64 (the production platform), written by
    /// `cargo run -p polypack-js --example vectors -- --fixture <vectors.bin>`: the special values of
    /// every function and a sample of the million arguments each was checked with.
    #[test]
    fn node_s_bits() {
        let mut count = 0;
        for line in include_str!("fdlibm_vectors.txt").lines().filter(|l| !l.starts_with('#')) {
            let mut parts = line.split(' ');
            let name = parts.next().unwrap();
            let mut values: Vec<f64> = parts.map(|h| f64::from_bits(u64::from_str_radix(h, 16).unwrap())).collect();
            let want = values.pop().unwrap();
            let one: fn(f64) -> f64 = match name {
                "sin" => super::sin,
                "cos" => super::cos,
                "tan" => super::tan,
                "asin" => super::asin,
                "acos" => super::acos,
                "atan" => super::atan,
                "atanh" => super::atanh,
                "asinh" => super::asinh,
                "acosh" => super::acosh,
                "cbrt" => super::cbrt,
                "exp" => super::exp,
                "expm1" => super::expm1,
                "sinh" => super::sinh,
                "cosh" => super::cosh,
                "tanh" => super::tanh,
                "log" => super::log,
                "log1p" => super::log1p,
                "log2" => super::log2,
                "log10" => super::log10,
                "atan2" => |_| f64::NAN,
                _ => continue,
            };
            let got = if name == "atan2" { super::atan2(values[0], values[1]) } else { one(values[0]) };
            assert!(got.to_bits() == want.to_bits() || (got.is_nan() && want.is_nan()), "{name}({values:?}): {got:e}, Node {want:e}");
            count += 1;
        }
        assert!(count > 5000, "{count} vectors");
    }
}
