//! The correctly rounded power: the double nearest to x^y (ties to even).
//!
//! `Math.pow` is the one function of `Math` that V8 does not compute itself: it calls the C
//! library's `pow`, and macOS's, glibc's without fused multiply-add and glibc's with it are three
//! different programs, each wrong by one unit in the last place for a few arguments in ten thousand
//! (not the same ones). There is no single Node result to copy. The correctly rounded power is the
//! one value all of them aim at, it is the same on every platform, and each library returns it for
//! all but those few arguments.
//!
//! Measured on the 1,001,024 pairs of `native/tools/jsmath-vectors.mts --bin` (which favour hard
//! cases), against the powers of `native/tools/jsmath-powref.py` (exact rational arithmetic and 90
//! decimal digits, no C library): this function 0 different; Node 24 on Linux x86-64 (glibc 2.36,
//! its path without fused multiply-add) 817, among them 10^23, 10^126 and 10^210; Node 26 on an
//! arm64 Mac 1,054, among them 3^34; the two Nodes differ from each other on 1,513. All by one unit
//! in the last place.
//!
//! Method (no table is copied from anywhere: every constant is computed here, once, from series):
//!
//!   x = m * 2^e with 3/4 <= m < 3/2, and m * c = 1 + d with c a ratio of 11 bits from a table and
//!   |d| < 2^-8 exactly (the product is exact in integers);
//!   ln x = e ln 2 - ln c + ln(1 + d), the last by its series;
//!   y ln x = j (ln 2)/128 + g with 0 <= g < (ln 2)/128;
//!   x^y = 2^(j div 128) * 2^((j mod 128)/128) * exp(g), exp by its series.
//!
//! All of it in integer arithmetic of 128 bits (`power_fast`, on `u128`), which leaves an error
//! below 2^-100 of the result. If the result is further than that from the middle of two doubles,
//! rounding it is safe. Otherwise the same computation runs with 256 bits (`power`, error below
//! 2^-225); and if that is still undecided the power is, for all practical purposes, exactly half
//! way between two doubles, which is settled by exact arithmetic: it happens only when y = n/2^k
//! and the odd part of x is a 2^k-th power (3^34 is the classic case).
//!
//! A whole exponent from -64 to 64 does not need the logarithm: the power is a few products of 128
//! bits, and a reciprocal for a negative one (`power_whole`), with the same test on the result.

use crate::fdlibm;
use std::cmp::Ordering;
use std::sync::OnceLock;

/* Fixed-point numbers: N words of 64 bits, least significant first, with two bits before the
 * point: the value is the integer divided by 2^(64N-2), in [0, 4). */

/// The widest product: two numbers of four words.
const WIDE: usize = 8;

fn fix_one<const N: usize>() -> [u64; N] {
    let mut a = [0u64; N];
    a[N - 1] = 1 << 62;
    a
}

fn fix_add<const N: usize>(a: &[u64; N], b: &[u64; N]) -> [u64; N] {
    let mut out = [0u64; N];
    let mut carry = false;
    for i in 0..N {
        let (s, c1) = a[i].overflowing_add(b[i]);
        let (s, c2) = s.overflowing_add(carry as u64);
        out[i] = s;
        carry = c1 | c2;
    }
    out
}

/// a - b for a >= b.
fn fix_sub<const N: usize>(a: &[u64; N], b: &[u64; N]) -> [u64; N] {
    let mut out = [0u64; N];
    let mut borrow = false;
    for i in 0..N {
        let (s, b1) = a[i].overflowing_sub(b[i]);
        let (s, b2) = s.overflowing_sub(borrow as u64);
        out[i] = s;
        borrow = b1 | b2;
    }
    out
}

/// The whole product of two numbers of N words, in 2N words.
#[inline(always)]
fn mul_wide<const N: usize>(a: &[u64; N], b: &[u64; N]) -> [u64; WIDE] {
    let mut p = [0u64; WIDE];
    for i in 0..N {
        let mut carry = 0u64;
        for j in 0..N {
            let t = a[i] as u128 * b[j] as u128 + p[i + j] as u128 + carry as u128;
            p[i + j] = t as u64;
            carry = (t >> 64) as u64;
        }
        p[i + N] = carry;
    }
    p
}

/// a * b, rounded down.
#[inline(always)]
fn fix_mul<const N: usize>(a: &[u64; N], b: &[u64; N]) -> [u64; N] {
    let p = mul_wide(a, b);
    let mut out = [0u64; N];
    for i in 0..N {
        out[i] = (p[N + i] << 2) | (p[N + i - 1] >> 62);
    }
    out
}

/// a / d, rounded down.
fn fix_div_small<const N: usize>(a: &[u64; N], d: u64) -> [u64; N] {
    let mut out = [0u64; N];
    let mut rem = 0u128;
    for i in (0..N).rev() {
        let cur = (rem << 64) | a[i] as u128;
        out[i] = (cur / d as u128) as u64;
        rem = cur % d as u128;
    }
    out
}

/// p / q for whole p < q, rounded down.
fn fix_ratio<const N: usize>(p: u64, q: u64) -> [u64; N] {
    let mut out = [0u64; N];
    let mut cur = (p as u128) << 62;
    for i in (0..N).rev() {
        out[i] = (cur / q as u128) as u64;
        cur = (cur % q as u128) << 64;
    }
    out
}

fn leading_zeros(a: &[u64]) -> u32 {
    let mut n = 0;
    for &w in a.iter().rev() {
        if w != 0 {
            return n + w.leading_zeros();
        }
        n += 64;
    }
    n
}

fn shl<const N: usize>(a: &[u64; N], bits: u32) -> [u64; N] {
    let mut out = [0u64; N];
    let (words, bits) = ((bits / 64) as usize, bits % 64);
    for i in (words..N).rev() {
        let lo = if bits > 0 && i > words { a[i - words - 1] >> (64 - bits) } else { 0 };
        out[i] = (a[i - words] << bits) | lo;
    }
    out
}

fn shr<const N: usize>(a: &[u64; N], bits: u32) -> [u64; N] {
    let mut out = [0u64; N];
    let (words, bits) = ((bits / 64) as usize, bits % 64);
    for i in 0..N.saturating_sub(words) {
        let hi = if bits > 0 && i + words + 1 < N { a[i + words + 1] << (64 - bits) } else { 0 };
        out[i] = (a[i + words] >> bits) | hi;
    }
    out
}

fn cmp_words(a: &[u64], b: &[u64]) -> Ordering {
    for i in (0..a.len()).rev() {
        match a[i].cmp(&b[i]) {
            Ordering::Equal => {}
            other => return other,
        }
    }
    Ordering::Equal
}

/* Floating-point numbers of N words: (-1)^neg * (m / 2^(64N)) * 2^exp, the top bit of m set
 * (1/2 <= m / 2^(64N) < 1), or m = 0 for zero. Products and sums are rounded down in magnitude. */

#[derive(Clone, Copy)]
struct Big<const N: usize> {
    neg: bool,
    exp: i32,
    m: [u64; N],
}

impl<const N: usize> Big<N> {
    const ZERO: Self = Big { neg: false, exp: 0, m: [0; N] };

    fn is_zero(&self) -> bool {
        self.m[N - 1] == 0
    }

    /// Shifts the top bit into place.
    fn normalized(neg: bool, exp: i32, m: [u64; N]) -> Self {
        let lz = leading_zeros(&m);
        if lz as usize == 64 * N {
            return Self::ZERO;
        }
        Big { neg, exp: exp - lz as i32, m: shl(&m, lz) }
    }

    /// A whole number, exactly.
    fn from_int(v: i128) -> Self {
        let a = v.unsigned_abs();
        let mut m = [0u64; N];
        m[N - 1] = (a >> 64) as u64;
        m[N - 2] = a as u64;
        Self::normalized(v < 0, 128, m)
    }

    /// A finite double, exactly.
    fn from_f64(v: f64) -> Self {
        let bits = v.to_bits();
        let field = ((bits >> 52) & 0x7FF) as i32;
        let frac = bits & 0x000F_FFFF_FFFF_FFFF;
        // v = mant * 2^e
        let (mant, e) = if field == 0 { (frac, -1074) } else { (frac | (1 << 52), field - 1075) };
        let mut m = [0u64; N];
        m[N - 1] = mant;
        Self::normalized(v.is_sign_negative(), e + 64, m)
    }

    /// A fixed-point number.
    fn from_fix(f: &[u64; N], neg: bool) -> Self {
        Self::normalized(neg, 2, *f)
    }

    /// The fixed-point number, for a value in [0, 4); the bits below the last place are dropped.
    fn to_fix(self) -> [u64; N] {
        let shift = 2 - self.exp;
        if shift >= 64 * N as i32 {
            return [0; N];
        }
        shr(&self.m, shift as u32)
    }

    fn mul(&self, other: &Self) -> Self {
        if self.is_zero() || other.is_zero() {
            return Self::ZERO;
        }
        let p = mul_wide(&self.m, &other.m);
        let mut m = [0u64; N];
        m.copy_from_slice(&p[N..2 * N]);
        let mut exp = self.exp + other.exp;
        if m[N - 1] >> 63 == 0 {
            // the product of two numbers in [1/2, 1) is in [1/4, 1): at most one place
            m = shl(&m, 1);
            m[0] |= p[N - 1] >> 63;
            exp -= 1;
        }
        Big { neg: self.neg != other.neg, exp, m }
    }

    fn add(&self, other: &Self) -> Self {
        if self.is_zero() {
            return *other;
        }
        if other.is_zero() {
            return *self;
        }
        let (a, b) = if self.exp > other.exp || (self.exp == other.exp && cmp_words(&self.m, &other.m) != Ordering::Less) {
            (self, other)
        } else {
            (other, self)
        };
        let gap = (a.exp - b.exp) as u32;
        let bm = if gap as usize >= 64 * N { [0; N] } else { shr(&b.m, gap) };
        if a.neg == b.neg {
            let m = fix_add(&a.m, &bm);
            if cmp_words(&m, &a.m) == Ordering::Less {
                // carried out of the top: one place down, the carry back in
                let mut m = shr(&m, 1);
                m[N - 1] |= 1 << 63;
                return Big { neg: a.neg, exp: a.exp + 1, m };
            }
            Big { neg: a.neg, exp: a.exp, m }
        } else {
            Self::normalized(a.neg, a.exp, fix_sub(&a.m, &bm))
        }
    }

    fn sub(&self, other: &Self) -> Self {
        self.add(&Big { neg: !other.neg, ..*other })
    }

    /// The first two of the four words (the constants are computed once, with four).
    fn narrowed<const M: usize>(&self) -> Big<M> {
        let mut m = [0u64; M];
        m.copy_from_slice(&self.m[N - M..]);
        Big { neg: self.neg, exp: self.exp, m }
    }
}

/* The constants. */

/// m is cut into intervals of 1/256 from 192/256 to 384/256.
const FIRST: usize = 192;
const INTERVALS: usize = 192;
/// 2^(r/128), r = 0..127.
const ROOTS: usize = 128;
/// Terms of ln(1 + d) and of exp(g) kept (|d| < 2^-8, g < 2^-7.5), with 128 and with 256 bits.
const LOG_TERMS_FAST: usize = 17;
const EXP_TERMS_FAST: usize = 14;
const LOG_TERMS: usize = 33;
const EXP_TERMS: usize = 25;
const RECIPROCALS: usize = 36;
const FACTORIALS: usize = 28;
/// The relative error of the result is below 2^-SURE (see the module comment).
const SURE_FAST: u32 = 100;
const SURE: u32 = 225;

struct Tables<const N: usize> {
    /// 1/k
    inv: [[u64; N]; RECIPROCALS],
    /// 1/k!
    ifact: [[u64; N]; FACTORIALS],
    ln2: Big<N>,
    /// ln(2)/128
    step: Big<N>,
    /// ln of the ratio c of each interval
    ln_c: [Big<N>; INTERVALS],
    /// 2^(r/128)
    root: [[u64; N]; ROOTS],
}

/// 1024 * c for the interval m in [i/256, (i+1)/256): the nearest whole number to 1024 divided by
/// the middle of the interval, and exactly 1 on both sides of m = 1 so that ln x keeps its
/// relative precision when x is next to 1.
fn ratio(i: usize) -> u64 {
    if i == 255 || i == 256 {
        return 1024;
    }
    let twice_middle = 2 * i as u64 + 1; // the middle of the interval is twice_middle / 512
    (2 * 524288 + twice_middle) / (2 * twice_middle)
}

/// ln(p/q) for whole numbers with p/q from 2/3 to 2: 2 atanh((p - q)/(p + q)), by the series.
fn ln_ratio(p: u64, q: u64, inv_odd: &[[u64; 4]]) -> Big<4> {
    if p == q {
        return Big::ZERO;
    }
    let z = fix_ratio::<4>(p.abs_diff(q), p + q); // at most 1/3
    let s = fix_mul(&z, &z);
    let mut acc = inv_odd[inv_odd.len() - 1];
    for k in (0..inv_odd.len() - 1).rev() {
        acc = fix_add(&fix_mul(&acc, &s), &inv_odd[k]);
    }
    let mut r = Big::from_fix(&fix_mul(&z, &acc), p < q);
    r.exp += 1;
    r
}

/// exp(g) for 0 <= g < 2^-7.5: the sum of g^n / n!.
#[inline(always)]
fn exp_series<const N: usize>(g: &[u64; N], t: &Tables<N>) -> [u64; N] {
    let terms = EXP_TERMS;
    let mut acc = t.ifact[terms];
    for n in (0..terms).rev() {
        acc = fix_add(&fix_mul(&acc, g), &t.ifact[n]);
    }
    acc
}

fn build() -> Tables<4> {
    let mut inv = [[0u64; 4]; RECIPROCALS];
    for (k, item) in inv.iter_mut().enumerate().skip(1) {
        *item = if k == 1 { fix_one() } else { fix_ratio(1, k as u64) };
    }
    let mut ifact = [[0u64; 4]; FACTORIALS];
    ifact[0] = fix_one();
    for k in 1..FACTORIALS {
        ifact[k] = fix_div_small(&ifact[k - 1], k as u64);
    }
    // 1/(2k+1): (1/9)^85 is below 2^-269
    let inv_odd: Vec<[u64; 4]> = (0..85u64).map(|k| if k == 0 { fix_one() } else { fix_ratio(1, 2 * k + 1) }).collect();
    let ln2 = ln_ratio(2, 1, &inv_odd);
    let mut step = ln2;
    step.exp -= 7;
    let mut ln_c = [Big::<4>::ZERO; INTERVALS];
    for (i, item) in ln_c.iter_mut().enumerate() {
        *item = ln_ratio(ratio(FIRST + i), 1024, &inv_odd);
    }
    let mut t = Tables { inv, ifact, ln2, step, ln_c, root: [[0u64; 4]; ROOTS] };
    // 2^(1/128) = exp(ln(2)/128), the others by squaring and multiplying
    let first = exp_series(&step.to_fix(), &t);
    t.root[0] = fix_one();
    for r in 1..ROOTS {
        let half = t.root[r / 2];
        let square = fix_mul(&half, &half);
        t.root[r] = if r % 2 == 1 { fix_mul(&square, &first) } else { square };
    }
    t
}

fn tables4() -> &'static Tables<4> {
    static TABLES: OnceLock<Tables<4>> = OnceLock::new();
    TABLES.get_or_init(build)
}

/* The same with 128 bits, on `u128`: the pass that nearly every call ends in. */

/// The top 128 bits of a product of two 128-bit numbers, at most 3 too small (the low partial
/// products are not carried).
#[inline(always)]
fn mulhi(a: u128, b: u128) -> u128 {
    let (a1, a0) = (a >> 64, a as u64 as u128);
    let (b1, b0) = (b >> 64, b as u64 as u128);
    a1 * b1 + ((a1 * b0) >> 64) + ((a0 * b1) >> 64)
}

/// The product of two fixed-point numbers (126 bits behind the point), at most 15 units too small.
#[inline(always)]
fn mul126(a: u128, b: u128) -> u128 {
    mulhi(a, b) << 2
}

/// A floating-point number of 128 bits: (-1)^neg * (m / 2^128) * 2^exp, the top bit of m set, or
/// m = 0 for zero.
#[derive(Clone, Copy)]
struct Wide {
    neg: bool,
    exp: i32,
    m: u128,
}

impl Wide {
    const ZERO: Wide = Wide { neg: false, exp: 0, m: 0 };

    #[inline(always)]
    fn normalized(neg: bool, exp: i32, m: u128) -> Wide {
        if m == 0 {
            return Wide::ZERO;
        }
        let lz = m.leading_zeros();
        Wide { neg, exp: exp - lz as i32, m: m << lz }
    }

    #[inline(always)]
    fn from_int(v: i128) -> Wide {
        Wide::normalized(v < 0, 128, v.unsigned_abs())
    }

    #[inline(always)]
    fn from_f64(v: f64) -> Wide {
        let bits = v.to_bits();
        let field = ((bits >> 52) & 0x7FF) as i32;
        let frac = bits & 0x000F_FFFF_FFFF_FFFF;
        let (mant, e) = if field == 0 { (frac, -1074) } else { (frac | (1 << 52), field - 1075) };
        Wide::normalized(v.is_sign_negative(), e + 128, mant as u128)
    }

    fn from_big(b: &Big<2>) -> Wide {
        Wide { neg: b.neg, exp: b.exp, m: (b.m[1] as u128) << 64 | b.m[0] as u128 }
    }

    #[inline(always)]
    fn mul(self, other: Wide) -> Wide {
        if self.m == 0 || other.m == 0 {
            return Wide::ZERO;
        }
        Wide::normalized(self.neg != other.neg, self.exp + other.exp, mulhi(self.m, other.m))
    }

    #[inline(always)]
    fn add(self, other: Wide) -> Wide {
        if self.m == 0 {
            return other;
        }
        if other.m == 0 {
            return self;
        }
        let (a, b) = if self.exp > other.exp || (self.exp == other.exp && self.m >= other.m) { (self, other) } else { (other, self) };
        let gap = (a.exp - b.exp) as u32;
        let bm = if gap >= 128 { 0 } else { b.m >> gap };
        if a.neg == b.neg {
            let (m, carry) = a.m.overflowing_add(bm);
            if carry {
                Wide { neg: a.neg, exp: a.exp + 1, m: (m >> 1) | (1 << 127) }
            } else {
                Wide { neg: a.neg, exp: a.exp, m }
            }
        } else {
            Wide::normalized(a.neg, a.exp, a.m - bm)
        }
    }

    #[inline(always)]
    fn sub(self, other: Wide) -> Wide {
        self.add(Wide { neg: !other.neg, ..other })
    }

    /// 1 / self (not zero), by Newton's iteration from the quotient of doubles: 53, 106, then
    /// about 120 good bits.
    #[inline(always)]
    fn reciprocal(self) -> Wide {
        if self.m == 1 << 127 {
            return Wide { neg: self.neg, exp: 2 - self.exp, m: self.m }; // a power of two
        }
        // v = m / 2^128 is in (1/2, 1), r = 1/v in (1, 2), both with 126 bits behind the point
        let v = self.m >> 2;
        let two = 2u128 << 126;
        let start = 1.0 / ((self.m >> 64) as f64 * 5.421010862427522e-20); // 2^-64
        let mut r = ((start * 4611686018427387904.0) as u128) << 64; // 2^62
        r = mul126(r, two - mul126(v, r));
        r = mul126(r, two - mul126(v, r));
        Wide::normalized(self.neg, 2 - self.exp, r)
    }
}

/// The constants with 128 bits: the top half of the 256-bit ones.
struct Fast {
    inv: [u128; RECIPROCALS],
    ifact: [u128; FACTORIALS],
    ln2: Wide,
    step: Wide,
    /// 1024 c and ln c of each interval
    ratio: [u64; INTERVALS],
    ln_c: [Wide; INTERVALS],
    root: [u128; ROOTS],
}

fn fast() -> &'static Fast {
    static TABLES: OnceLock<Fast> = OnceLock::new();
    TABLES.get_or_init(|| {
        let t = tables4();
        let top = |f: &[u64; 4]| (f[3] as u128) << 64 | f[2] as u128;
        let mut ratios = [0u64; INTERVALS];
        for (i, r) in ratios.iter_mut().enumerate() {
            *r = ratio(FIRST + i);
        }
        Fast {
            inv: t.inv.map(|f| top(&f)),
            ifact: t.ifact.map(|f| top(&f)),
            ln2: Wide::from_big(&t.ln2.narrowed()),
            step: Wide::from_big(&t.step.narrowed()),
            ratio: ratios,
            ln_c: t.ln_c.map(|b| Wide::from_big(&b.narrowed())),
            root: t.root.map(|f| top(&f)),
        }
    })
}

/* The power. */

/// What rounding the computed value gives.
enum Rounded {
    /// Further from the middle of two doubles than the error: this is the answer.
    Sure(f64),
    /// Within the error of the middle between `down` and `down + 1` units of 2^lsb.
    Unsure { down: u64, lsb: i32, above: bool },
}

/// The double of `r` units of 2^lsb, where lsb is the last place of its binade (-1074 for the
/// subnormals and the first binade). The encoding of doubles is linear in `r`, a carry included.
fn assemble(r: u64, lsb: i32) -> f64 {
    let bits = (((lsb + 1074) as u64) << 52) + r;
    if bits >= 0x7FF0_0000_0000_0000 {
        f64::INFINITY
    } else {
        f64::from_bits(bits)
    }
}

/// Rounds p * 2^q (p a fixed-point number in [1, 4)) to a double, given that its relative error is
/// below 2^-sure.
fn round<const N: usize>(p: &[u64; N], q: i32, sure: u32) -> Rounded {
    let total = 64 * N as i32;
    let len = total - leading_zeros(p) as i32; // bits of p as a whole number
    let unit = q - (total - 2); // p counts units of 2^unit
    let top = len - 1 + unit; // 2^top <= value < 2^(top + 1)
    if top > 1024 {
        return Rounded::Sure(f64::INFINITY);
    }
    let lsb = (top - 52).max(-1074);
    let frac = lsb - unit; // bits of p below the last place of the result
    if frac > len + 1 {
        return Rounded::Sure(0.0); // below a quarter of the smallest double
    }
    let frac = frac as u32;
    let down = if frac >= total as u32 { 0 } else { shr(p, frac)[0] };
    // the bits below the last place against one half, in five words (the half can be bit 64N)
    let mut rem = [0u64; 5];
    rem[..N].copy_from_slice(p);
    for (i, w) in rem.iter_mut().enumerate() {
        let lo = 64 * i as u32;
        if frac <= lo {
            *w = 0;
        } else if frac < lo + 64 {
            *w &= (1u64 << (frac - lo)) - 1;
        }
    }
    let mut half = [0u64; 5];
    half[((frac - 1) / 64) as usize] = 1 << ((frac - 1) % 64);
    let above = cmp_words(&rem, &half) != Ordering::Less;
    let diff = if above { fix_sub(&rem, &half) } else { fix_sub(&half, &rem) };
    let error = shr(p, sure)[0] + 2;
    if diff[1..].iter().all(|&w| w == 0) && diff[0] <= error {
        return Rounded::Unsure { down, lsb, above };
    }
    Rounded::Sure(assemble(down + above as u64, lsb))
}

/// `round` for 128 bits: p * 2^q with p a fixed-point number of 126 bits behind the point and a
/// relative error below 2^-SURE_FAST.
#[inline(always)]
fn round_fast(p: u128, q: i32) -> Rounded {
    let len = 128 - p.leading_zeros() as i32;
    let unit = q - 126;
    let top = len - 1 + unit;
    if top > 1024 {
        return Rounded::Sure(f64::INFINITY);
    }
    let lsb = (top - 52).max(-1074);
    let frac = lsb - unit;
    if frac > len + 1 {
        return Rounded::Sure(0.0);
    }
    // the bits below the last place against one half = 2^(frac - 1); frac is from 1 to 129
    let frac = frac as u32;
    let (down, above, diff) = if frac == 129 {
        (0, false, p.wrapping_neg()) // 2^128 - p
    } else {
        let (down, rem) = if frac == 128 { (0, p) } else { ((p >> frac) as u64, p & ((1u128 << frac) - 1)) };
        let half = 1u128 << (frac - 1);
        if rem >= half {
            (down, true, rem - half)
        } else {
            (down, false, half - rem)
        }
    };
    if diff <= (p >> SURE_FAST) + 2 {
        return Rounded::Unsure { down, lsb, above };
    }
    Rounded::Sure(assemble(down + above as u64, lsb))
}

/// `power` with 128 bits.
#[inline(always)]
fn power_fast(mh: u64, e: i32, y: f64, estimate: f64, t: &Fast) -> Rounded {
    // m * c = 1 + d, exactly: d = nu / 2^63
    let i = (mh >> 45) as usize - FIRST;
    let nu = (mh as u128 * t.ratio[i] as u128) as i128 - (1i128 << 63);
    let d = nu.unsigned_abs() << 63;
    // ln(1 + d) / d = 1 - d/2 + d^2/3 - ...
    let mut acc = t.inv[LOG_TERMS_FAST];
    if nu >= 0 {
        for k in (1..LOG_TERMS_FAST).rev() {
            acc = t.inv[k] - mul126(acc, d);
        }
    } else {
        for k in (1..LOG_TERMS_FAST).rev() {
            acc = t.inv[k] + mul126(acc, d);
        }
    }
    let mut ln_m = Wide::from_int(nu).mul(Wide::normalized(false, 2, acc));
    ln_m.exp -= 63;
    // ln x = e ln 2 + ln(1 + d) - ln c
    let ln_x = Wide::from_int(e as i128).mul(t.ln2).add(ln_m).sub(t.ln_c[i]);
    let u = ln_x.mul(Wide::from_f64(y));
    // u = j (ln 2)/128 + g, 0 <= g < (ln 2)/128
    let mut j = (estimate * (128.0 / std::f64::consts::LN_2)).floor() as i64;
    let mut g = u.sub(Wide::from_int(j as i128).mul(t.step));
    while g.neg && g.m != 0 {
        j -= 1;
        g = g.add(t.step);
    }
    while g.m != 0 && (g.exp > t.step.exp || (g.exp == t.step.exp && g.m >= t.step.m)) {
        j += 1;
        g = g.sub(t.step);
    }
    let shift = 2 - g.exp;
    let g = if g.m == 0 || shift >= 128 { 0 } else { g.m >> shift };
    // exp(g) = sum of g^n / n!
    let mut acc = t.ifact[EXP_TERMS_FAST];
    for n in (0..EXP_TERMS_FAST).rev() {
        acc = mul126(acc, g) + t.ifact[n];
    }
    round_fast(mul126(t.root[j.rem_euclid(128) as usize], acc), j.div_euclid(128) as i32)
}

/// x^n and x^-n (`inverse`) for a whole n from 1 to 64: at most twelve products of 128 bits, each
/// rounded down by less than 2^-125 of itself, and a reciprocal good to 2^-118.
#[inline(always)]
fn power_whole(x: f64, n: u32, inverse: bool) -> Rounded {
    let base = Wide::from_f64(x);
    let mut acc = base;
    for bit in (0..31 - n.leading_zeros()).rev() {
        acc = acc.mul(acc);
        if (n >> bit) & 1 == 1 {
            acc = acc.mul(base);
        }
    }
    if inverse {
        acc = acc.reciprocal();
    }
    round_fast(acc.m >> 1, acc.exp - 1)
}

/// x^y for x = (mh / 2^53) * 2^e with 3/4 <= mh / 2^53 < 3/2, with N words (only N = 4 is used).
/// `estimate` is y ln x as a double.
fn power<const N: usize>(mh: u64, e: i32, y: f64, estimate: f64, t: &Tables<N>) -> Rounded {
    // m * c = 1 + d, exactly: d = nu / 2^63
    let i = (mh >> 45) as usize;
    let nu = (mh as u128 * ratio(i) as u128) as i128 - (1i128 << 63);
    let mut d = [0u64; N];
    d[N - 1] = (nu.unsigned_abs() as u64) >> 1;
    d[N - 2] = (nu.unsigned_abs() as u64) << 63;
    // ln(1 + d) / d = 1 - d/2 + d^2/3 - ...
    let terms = LOG_TERMS;
    let mut acc = t.inv[terms];
    if nu >= 0 {
        for k in (1..terms).rev() {
            acc = fix_sub(&t.inv[k], &fix_mul(&acc, &d));
        }
    } else {
        for k in (1..terms).rev() {
            acc = fix_add(&t.inv[k], &fix_mul(&acc, &d));
        }
    }
    let mut ln_m = Big::<N>::from_int(nu).mul(&Big::from_fix(&acc, false));
    ln_m.exp -= 63;
    // ln x = e ln 2 + ln(1 + d) - ln c
    let ln_x = Big::<N>::from_int(e as i128).mul(&t.ln2).add(&ln_m).sub(&t.ln_c[i - FIRST]);
    let u = ln_x.mul(&Big::from_f64(y));
    // u = j (ln 2)/128 + g, 0 <= g < (ln 2)/128
    let mut j = (estimate * (128.0 / std::f64::consts::LN_2)).floor() as i64;
    let mut g = u.sub(&Big::<N>::from_int(j as i128).mul(&t.step));
    while g.neg && !g.is_zero() {
        j -= 1;
        g = g.add(&t.step);
    }
    while !g.is_zero() && (g.exp > t.step.exp || (g.exp == t.step.exp && cmp_words(&g.m, &t.step.m) != Ordering::Less)) {
        j += 1;
        g = g.sub(&t.step);
    }
    let p = fix_mul(&t.root[j.rem_euclid(128) as usize], &exp_series(&g.to_fix(), t));
    round(&p, j.div_euclid(128) as i32, SURE)
}

/// The whole square root of a whole number, if it is one.
fn exact_sqrt(c: u64) -> Option<u64> {
    let mut s = (c as f64).sqrt() as u64;
    while s as u128 * s as u128 > c as u128 {
        s -= 1;
    }
    while (s as u128 + 1) * (s as u128 + 1) <= c as u128 {
        s += 1;
    }
    (s * s == c).then_some(s)
}

/// The odd part of x^y when x^y is a whole number times a power of two (x = odd * 2^two, x not a
/// power of two): y must be n / 2^k with n > 0, `odd` a 2^k-th power and `two` a multiple of 2^k.
fn exact_odd_part(odd: u64, two: i32, y: f64) -> Option<u128> {
    if y <= 0.0 {
        return None;
    }
    let yb = Big::<2>::from_f64(y);
    // y = top * 2^(exp - 64), top with its highest bit set
    let top = yb.m[1];
    let zeros = top.trailing_zeros() as i32;
    let n = top >> zeros;
    let scale = yb.exp - 64 + zeros; // y = n * 2^scale, n odd
    let (n, k) = if scale >= 0 {
        if scale > 6 || n > 64 {
            return None;
        }
        (n << scale, 0)
    } else {
        (n, -scale)
    };
    if n > 64 || k > 5 || two % (1 << k) != 0 {
        return None;
    }
    let mut c = odd;
    for _ in 0..k {
        c = exact_sqrt(c)?;
    }
    (c as u128).checked_pow(n as u32)
}

/// The correctly rounded x^y for a finite x > 0 other than 1 and a finite y other than 0.
pub(super) fn pow_positive(x: f64, y: f64) -> f64 {
    // x = mx * 2^ex with 2^52 <= mx < 2^53
    let bits = x.to_bits();
    let field = (bits >> 52) as i32;
    let (mx, ex) = if field == 0 {
        let shift = bits.leading_zeros() as i32 - 11;
        (bits << shift, -1074 - shift)
    } else {
        ((bits & 0x000F_FFFF_FFFF_FFFF) | (1 << 52), field - 1075)
    };
    let zeros = mx.trailing_zeros() as i32;
    let (odd, two) = (mx >> zeros, ex + zeros);
    if odd == 1 {
        // a power of two: 2^(two * y), exact when the exponent is whole
        let yb = Big::<2>::from_f64(y);
        let yz = yb.m[1].trailing_zeros() as i32;
        let (n, scale) = ((yb.m[1] >> yz) as i128, yb.exp - 64 + yz); // |y| = n * 2^scale
        let whole = scale >= 0 || two.trailing_zeros() as i32 >= -scale;
        if whole {
            if scale > 12 {
                return if (two > 0) == (y > 0.0) { f64::INFINITY } else { 0.0 };
            }
            let magnitude = if scale >= 0 { (two as i128 * n) << scale } else { (two as i128 * n) >> -scale };
            let t = if y < 0.0 { -magnitude } else { magnitude };
            return if t > 1023 {
                f64::INFINITY
            } else if t >= -1074 {
                assemble(1u64 << (t + 1074).min(52), (t as i32 - 52).max(-1074))
            } else {
                0.0 // 2^-1075 is half way between 0 and the smallest double: to the even one
            };
        }
    }
    // y ln x as a double is enough to see an overflow, an underflow and a power that rounds to 1
    let estimate = y * fdlibm::log(x);
    if estimate > 709.79 {
        return f64::INFINITY; // above ln(2^1024)
    }
    if estimate < -745.14 {
        return 0.0; // below ln(2^-1075)
    }
    if estimate.abs() < 1.3877787807814457e-17 {
        return 1.0; // |y ln x| < 2^-56
    }
    // x = (mh / 2^53) * 2^e with 3/4 <= mh / 2^53 < 3/2
    let (mh, e) = if mx >= 3 << 51 { (mx, ex + 53) } else { (mx << 1, ex + 52) };
    if y.abs() <= 64.0 && y == y.trunc() {
        if let Rounded::Sure(r) = power_whole(x, y.abs() as u32, y < 0.0) {
            return r;
        }
    } else if let Rounded::Sure(r) = power_fast(mh, e, y, estimate, fast()) {
        return r;
    }
    match power::<4>(mh, e, y, estimate, tables4()) {
        Rounded::Sure(r) => r,
        Rounded::Unsure { down, lsb, above } => {
            if exact_odd_part(odd, two, y) == Some(2 * down as u128 + 1) {
                assemble(down + (down & 1), lsb) // exactly half way: to the even one
            } else {
                assemble(down + above as u64, lsb)
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::approx_constant)]
mod tests {
    use super::*;

    fn bits(x: f64) -> String {
        format!("{:016x}", x.to_bits())
    }

    #[test]
    fn constants() {
        let t = tables4();
        // ln 2 = 0.B17217F7D1CF79ABC9E3B39803F2F6AF40F343267298B62D8A0D175B8BAAFA2B...
        assert_eq!(t.ln2.exp, 0);
        assert_eq!(t.ln2.m[3], 0xB17217F7D1CF79AB);
        assert_eq!(t.ln2.m[2], 0xC9E3B39803F2F6AF);
        assert_eq!(t.ln2.m[1], 0x40F343267298B62D);
        // sqrt(2) = 1.6A09E667F3BCC908B2FB1366EA957D3E3ADEC17512775099DA2F590B0667322A...
        assert_eq!(t.root[64][3], 0x5A827999FCEF3242);
        assert_eq!(t.root[64][2], 0x2CBEC4D9BAA55F4F);
        assert_eq!(t.root[64][1] >> 8, 0x8EB7B05D449DD4);
        // the 128-bit tables are the top of the 256-bit ones
        assert_eq!((fast().root[64] >> 64) as u64, t.root[64][3]);
    }

    #[test]
    fn exact_and_half_way() {
        // exact powers
        assert_eq!(pow_positive(3.0, 5.0), 243.0);
        assert_eq!(pow_positive(2.5, 3.0), 15.625);
        assert_eq!(pow_positive(6.25, 1.5), 15.625);
        assert_eq!(pow_positive(0.75, -2.0), 16.0 / 9.0);
        assert_eq!(pow_positive(10.0, 22.0), 1e22);
        assert_eq!(pow_positive(10.0, -5.0), 1e-5);
        assert_eq!(pow_positive(8.0, 1.0 / 3.0), 2.0);
        // 3^34 = 16677181699666569 has 54 bits and is odd: half way, to the even neighbour
        assert_eq!(pow_positive(3.0, 34.0), 16677181699666568.0);
        assert_eq!(pow_positive(9.0, 17.0), 16677181699666568.0);
        assert_eq!(pow_positive(81.0, 8.5), 16677181699666568.0);
        // 3^35 = 50031545098999707 = 2^55.47: two bits too many, the nearest multiple of 8
        assert_eq!(pow_positive(3.0, 35.0), 50031545098999704.0);
        // (3 * 2^-215)^5 = 243 * 2^-1075 = 121.5 smallest doubles: to 122
        let x = 3.0 * f64::from_bits((1023 - 215) << 52);
        assert_eq!(pow_positive(x, 5.0).to_bits(), 122);
        // (5 * 2^-215)^5 = 3125 * 2^-1075 = 1562.5: to 1562
        let x = 5.0 * f64::from_bits((1023 - 215) << 52);
        assert_eq!(pow_positive(x, 5.0).to_bits(), 1562);
    }

    #[test]
    fn close_to_half_way() {
        // 1/(1 - 2^-53) = 1 + 2^-53 + 2^-106 + ...: above the middle of 1 and 1 + 2^-52 by 2^-106
        assert_eq!(bits(pow_positive(0.9999999999999999, -1.0)), "3ff0000000000001");
        // (1 - 2^-53)^-3 = 1 + 3 * 2^-53 + 6 * 2^-106 + ...
        assert_eq!(bits(pow_positive(0.9999999999999999, -3.0)), "3ff0000000000002");
        // the 128-bit pass cannot decide these, the 256-bit pass can
        let (mh, e) = (0x1F_FFFF_FFFF_FFFFu64, 0);
        let estimate = -fdlibm::log(0.9999999999999999);
        assert!(matches!(power_fast(mh, e, -1.0, estimate, fast()), Rounded::Unsure { .. }));
        assert!(matches!(power::<4>(mh, e, -1.0, estimate, tables4()), Rounded::Sure(_)));
    }

    #[test]
    fn limits() {
        let max = f64::MAX;
        assert_eq!(pow_positive(2.0, 1023.0), f64::from_bits(0x7FE0_0000_0000_0000));
        assert_eq!(pow_positive(2.0, 1024.0), f64::INFINITY);
        assert_eq!(pow_positive(2.0, -1074.0).to_bits(), 1);
        assert_eq!(pow_positive(2.0, -1075.0), 0.0);
        assert_eq!(pow_positive(2.0, -1074.5).to_bits(), 1);
        assert_eq!(pow_positive(4.0, -537.25).to_bits(), 1);
        assert_eq!(pow_positive(0.5, 1e300), 0.0);
        assert_eq!(pow_positive(0.5, -1e300), f64::INFINITY);
        assert_eq!(pow_positive(max, 1.0), max);
        assert_eq!(pow_positive(max, 1.0000000000000002), f64::INFINITY);
        assert_eq!(pow_positive(max, 0.9999999999999999), 1.797693134862174e308);
        assert_eq!(pow_positive(5e-324, 1.0).to_bits(), 1);
        assert_eq!(pow_positive(5e-324, 0.9999999999999999).to_bits(), 1);
        assert_eq!(pow_positive(5e-324, 1.0000000000000002).to_bits(), 1);
        assert_eq!(pow_positive(1.0000000000000002, 1e-300), 1.0);
        assert_eq!(pow_positive(1.0000000000000002, 4503599627370496.0), 2.718281828459045);
        assert_eq!(pow_positive(10.0, -322.0), 1e-322);
        assert_eq!(pow_positive(10.0, 308.0), 1e308);
        assert_eq!(pow_positive(10.0, 309.0), f64::INFINITY);
    }

    #[test]
    fn two_precisions_agree() {
        // wherever the 128-bit pass is sure, the 256-bit pass gives the same double
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut sure = 0;
        for i in 0..20000 {
            let x = f64::from_bits((next() >> 12) | ((1023 - 3 + next() % 7) << 52));
            let y = (next() % 4001) as f64 / 64.0 - 31.0 + if i % 2 == 0 { (next() >> 11) as f64 / (1u64 << 53) as f64 } else { 0.0 };
            if y == 0.0 || x == 1.0 {
                continue;
            }
            let bits = x.to_bits();
            let mx = (bits & 0x000F_FFFF_FFFF_FFFF) | (1 << 52);
            let ex = (bits >> 52) as i32 - 1075;
            let (mh, e) = if mx >= 3 << 51 { (mx, ex + 53) } else { (mx << 1, ex + 52) };
            let estimate = y * fdlibm::log(x);
            if let Rounded::Sure(a) = power_fast(mh, e, y, estimate, fast()) {
                sure += 1;
                match power::<4>(mh, e, y, estimate, tables4()) {
                    Rounded::Sure(b) => assert_eq!(a.to_bits(), b.to_bits(), "pow({x:e}, {y:e})"),
                    Rounded::Unsure { .. } => panic!("pow({x:e}, {y:e}): 256 bits unsure"),
                }
            }
            // and a whole exponent by products gives what the logarithm gives
            let n = 1 + (next() % 64) as u32;
            let estimate = n as f64 * fdlibm::log(x);
            if let (Rounded::Sure(a), Rounded::Sure(b)) = (power_whole(x, n, false), power::<4>(mh, e, n as f64, estimate, tables4())) {
                assert_eq!(a.to_bits(), b.to_bits(), "pow({x:e}, {n})");
            }
            if let (Rounded::Sure(a), Rounded::Sure(b)) = (power_whole(x, n, true), power::<4>(mh, e, -(n as f64), -estimate, tables4())) {
                assert_eq!(a.to_bits(), b.to_bits(), "pow({x:e}, -{n})");
            }
        }
        assert!(sure > 19000);
    }

    /// The correctly rounded powers of `native/tools/jsmath-powref.py` (exact arithmetic and 90
    /// decimal digits), through `math::pow` and JavaScript's special cases.
    #[test]
    fn reference_powers() {
        let mut count = 0;
        for line in include_str!("pow_vectors.txt").lines().filter(|l| !l.starts_with('#')) {
            let v: Vec<f64> = line.split(' ').skip(1).map(|h| f64::from_bits(u64::from_str_radix(h, 16).unwrap())).collect();
            let got = crate::math::pow(v[0], v[1]);
            assert!(got.to_bits() == v[2].to_bits() || (got.is_nan() && v[2].is_nan()), "pow({:e}, {:e}): {got:e}, reference {:e}", v[0], v[1], v[2]);
            count += 1;
        }
        assert!(count > 250, "{count} vectors");
    }
}
