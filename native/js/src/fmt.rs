//! Number formats of JavaScript: `String(x)`, `x.toExponential(d)`, `x.toFixed(d)`, `x.toPrecision(p)`.

/// The shortest decimal digits that read back as `x` (finite, non-zero, positive) and the decimal
/// exponent of the first digit: `x = d.ddd * 10^exp`.
fn shortest(x: f64) -> (String, i32) {
    // Rust's `{:e}` prints the shortest digits that round-trip, as JavaScript does
    let s = format!("{:e}", x);
    let (mant, exp) = s.split_once('e').expect("exponent");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().expect("exponent");
    // When x lies exactly halfway between two shortest candidates, Rust takes the upper one and
    // V8 the one with an even last digit (1616980188147352.25 prints as ...52.2 in JavaScript).
    let k = digits.len();
    let (ex, _) = exact(x);
    if ex.len() == k + 1 && ex[k] == 5 {
        let lower: Vec<u8> = ex[..k].to_vec();
        let (upper, carry) = round_digits(&ex, k);
        if !carry && lower[k - 1] % 2 == 0 {
            let text = digit_string(&lower);
            if format!("{}e{}", insert_point(&text), exp).parse::<f64>() == Ok(x) {
                return (text, exp);
            }
        } else if !carry {
            let text = digit_string(&upper);
            if format!("{}e{}", insert_point(&text), exp).parse::<f64>() == Ok(x) {
                return (text, exp);
            }
        }
    }
    (digits, exp)
}

/// "1234" as "1.234".
fn insert_point(digits: &str) -> String {
    if digits.len() == 1 {
        digits.to_string()
    } else {
        format!("{}.{}", &digits[..1], &digits[1..])
    }
}

/// `String(x)`, also what a template string `${x}` gives.
pub fn num(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let (digits, exp) = shortest(x.abs());
    let k = digits.len() as i32;
    // n: the position of the decimal point after the first digit (ECMAScript Number::toString)
    let n = exp + 1;
    let body = if k <= n && n <= 21 {
        format!("{}{}", digits, "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let e = n - 1;
        let es = if e < 0 { format!("-{}", -e) } else { format!("+{}", e) };
        if k == 1 {
            format!("{}e{}", digits, es)
        } else {
            format!("{}.{}e{}", &digits[..1], &digits[1..], es)
        }
    };
    format!("{sign}{body}")
}

/// An integer as JavaScript prints it (a number that holds an integer below 2^53).
pub fn int(x: i64) -> String {
    x.to_string()
}

/// The exact decimal expansion of a positive finite `x`: its digits (no leading zeros) and the
/// decimal exponent of the first digit.
fn exact(x: f64) -> (Vec<u8>, i32) {
    // a double has at most 767 significant decimal digits; `{:.N$e}` is exact in Rust
    let s = format!("{:.800e}", x);
    let (mant, exp) = s.split_once('e').expect("exponent");
    let mut digits: Vec<u8> = mant.bytes().filter(|c| *c != b'.').map(|c| c - b'0').collect();
    while digits.len() > 1 && *digits.last().unwrap() == 0 {
        digits.pop();
    }
    (digits, exp.parse().expect("exponent"))
}

/// The first `keep` digits of an exact expansion rounded half up (ties away from zero, as
/// JavaScript's "pick the larger n"); returns the digits and whether the rounding carried into a
/// new leading digit (then the exponent grows by one and the digits are 1000...).
fn round_digits(digits: &[u8], keep: usize) -> (Vec<u8>, bool) {
    let mut out: Vec<u8> = (0..keep).map(|i| digits.get(i).copied().unwrap_or(0)).collect();
    let up = digits.get(keep).copied().unwrap_or(0) >= 5;
    if !up {
        return (out, false);
    }
    let mut i = keep;
    loop {
        if i == 0 {
            // every kept digit was 9
            out.insert(0, 1);
            out.truncate(keep.max(1));
            return (out, true);
        }
        i -= 1;
        if out[i] == 9 {
            out[i] = 0;
        } else {
            out[i] += 1;
            return (out, false);
        }
    }
}

fn digit_string(d: &[u8]) -> String {
    d.iter().map(|c| (c + b'0') as char).collect()
}

fn special(x: f64) -> Option<String> {
    if x.is_nan() {
        Some("NaN".into())
    } else if x.is_infinite() {
        Some(if x > 0.0 { "Infinity".into() } else { "-Infinity".into() })
    } else {
        None
    }
}

fn exp_suffix(e: i32) -> String {
    if e < 0 {
        format!("e-{}", -e)
    } else {
        format!("e+{}", e)
    }
}

/// `x.toExponential(d)`; `None` is `x.toExponential()`: as many digits as needed.
pub fn exponential(x: f64, d: Option<usize>) -> String {
    if let Some(s) = special(x) {
        return s;
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let a = x.abs();
    let (digits, e) = match d {
        None => {
            if a == 0.0 {
                ("0".to_string(), 0)
            } else {
                shortest(a)
            }
        }
        Some(d) => {
            if a == 0.0 {
                ("0".repeat(d + 1), 0)
            } else {
                let (ex, e) = exact(a);
                let (r, carry) = round_digits(&ex, d + 1);
                (digit_string(&r), if carry { e + 1 } else { e })
            }
        }
    };
    let body = if digits.len() == 1 { digits } else { format!("{}.{}", &digits[..1], &digits[1..]) };
    format!("{sign}{body}{}", exp_suffix(e))
}

/// `x.toFixed(d)`.
pub fn fixed(x: f64, d: usize) -> String {
    if let Some(s) = special(x) {
        return s;
    }
    if x.abs() >= 1e21 {
        return num(x);
    }
    let a = x.abs();
    let text = if a == 0.0 {
        if d == 0 { "0".to_string() } else { format!("0.{}", "0".repeat(d)) }
    } else {
        let (ex, e) = exact(a);
        // digits before the decimal point: e + 1 (when positive); kept digits: e + 1 + d
        let keep = e + 1 + d as i32;
        let (int_digits, frac_digits) = if keep < 0 {
            (vec![0u8], vec![0u8; d])
        } else {
            let (r, carry) = round_digits(&ex, keep as usize);
            let (r, e) = if carry {
                // keep == 0 gives the single digit 1 at exponent e + 1
                let mut r = r;
                if keep as usize + 1 > r.len() {
                    r.resize(keep as usize + 1, 0);
                }
                (r, e + 1)
            } else {
                (r, e)
            };
            if e < 0 {
                // 0.000ddd: -e - 1 zeros, then the kept digits
                let mut frac = vec![0u8; (-e - 1) as usize];
                frac.extend_from_slice(&r);
                frac.truncate(d);
                frac.resize(d, 0);
                (vec![0u8], frac)
            } else {
                let n = (e + 1) as usize;
                let mut r = r;
                if r.len() < n + d {
                    r.resize(n + d, 0);
                }
                (r[..n].to_vec(), r[n..n + d].to_vec())
            }
        };
        if d == 0 {
            digit_string(&int_digits)
        } else {
            format!("{}.{}", digit_string(&int_digits), digit_string(&frac_digits))
        }
    };
    // -0 and negatives that round to zero keep their sign in JavaScript only when x < 0
    let sign = if x < 0.0 { "-" } else { "" };
    format!("{sign}{text}")
}

/// `x.toPrecision(p)`, p from 1 to 100.
pub fn precision(x: f64, p: usize) -> String {
    if let Some(s) = special(x) {
        return s;
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let a = x.abs();
    let (digits, e) = if a == 0.0 {
        (vec![0u8; p], 0)
    } else {
        let (ex, e) = exact(a);
        let (r, carry) = round_digits(&ex, p);
        (r, if carry { e + 1 } else { e })
    };
    let ds = digit_string(&digits);
    let body = if e < -6 || e >= p as i32 {
        let m = if p == 1 { ds } else { format!("{}.{}", &ds[..1], &ds[1..]) };
        format!("{m}{}", exp_suffix(e))
    } else if e == p as i32 - 1 {
        ds
    } else if e >= 0 {
        format!("{}.{}", &ds[..(e + 1) as usize], &ds[(e + 1) as usize..])
    } else {
        format!("0.{}{}", "0".repeat((-(e + 1)) as usize), ds)
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings() {
        assert_eq!(num(1e-9), "1e-9");
        assert_eq!(num(0.000001), "0.000001");
        assert_eq!(num(1.5e-7), "1.5e-7");
        assert_eq!(num(1e21), "1e+21");
        assert_eq!(num(123456789012345680000.0), "123456789012345680000");
        assert_eq!(num(-0.0), "0");
        assert_eq!(num(100.0), "100");
        assert_eq!(num(0.1 + 0.2), "0.30000000000000004");
    }

    #[test]
    fn rounded() {
        assert_eq!(fixed(0.5, 0), "1");
        assert_eq!(fixed(2.5, 0), "3");
        assert_eq!(fixed(1.005, 2), "1.00");
        assert_eq!(fixed(-1.5, 0), "-2");
        assert_eq!(fixed(0.000001, 3), "0.000");
        assert_eq!(fixed(9.999, 2), "10.00");
        assert_eq!(exponential(1e-9, None), "1e-9");
        assert_eq!(exponential(12345.0, Some(2)), "1.23e+4");
        assert_eq!(precision(0.000123456, 3), "0.000123");
        assert_eq!(precision(123456.0, 3), "1.23e+5");
        assert_eq!(precision(99.99, 3), "100");
    }
}
