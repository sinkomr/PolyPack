#!/usr/bin/env python3
"""The correctly rounded `Math.pow` for the vectors of jsmath-vectors.mts, computed independently
of any C library: exact rational arithmetic for whole exponents, 90 decimal digits otherwise.

  python3 native/tools/jsmath-powref.py <vectors.bin> <out.bin>

Reads the `pow` section of a binary vector file (`jsmath-vectors.mts --bin`) and writes a file of
the same format with that one section, the results replaced by the double nearest to the true
power (ties to even), under JavaScript's rules for the special cases. Use it to check
`polypack_js::math::pow` (`vectors <out.bin>`) and to count how often a platform's `Math.pow` is
not correctly rounded (`vectors --compare <platform.bin> <out.bin>`).

Only the standard library is used. A result is accepted when the 90-digit value rounds to the same
double after being moved up and down by 1e-80 of itself; a result that does not (an exact tie, or a
power that is exactly a double) is settled exactly: the exponent is n/2^k, the base must be the
2^k-th power of a rational, and then the power is a rational number.
"""
import json
import math
import struct
import sys
from decimal import Context, Decimal, MAX_EMAX, MIN_EMIN, ROUND_HALF_EVEN
from fractions import Fraction

CTX = Context(prec=90, rounding=ROUND_HALF_EVEN, Emax=MAX_EMAX, Emin=MIN_EMIN, traps=[])
UP = Decimal(1) + Decimal(10) ** -80
DOWN = Decimal(1) - Decimal(10) ** -80
INF = float("inf")
NAN = float("nan")


def to_float(q):
    """A positive Fraction to the nearest double, ties to even, with overflow and underflow."""
    try:
        return q.numerator / q.denominator  # int / int is correctly rounded in Python
    except OverflowError:
        return INF


def exact_root_power(x, y):
    """x**y as a Fraction when it is rational (y = n/2^k and x a 2^k-th power), else None."""
    fy = Fraction(y)
    n, d = fy.numerator, fy.denominator  # d is a power of two
    r = Fraction(x)
    while d > 1:
        a, b = math.isqrt(r.numerator), math.isqrt(r.denominator)
        if a * a != r.numerator or b * b != r.denominator:
            return None
        r = Fraction(a, b)
        d //= 2
    if abs(n) > 5000:
        return None
    return r ** n


def positive_power(x, y, counts):
    """The correctly rounded x**y for finite x > 0, x != 1 and finite y != 0."""
    if y == math.floor(y) and abs(y) <= 64:
        counts["exact"] += 1
        return to_float(Fraction(x) ** int(y))
    d = CTX.power(Decimal(x), Decimal(y))
    lo = float(CTX.multiply(d, DOWN))
    hi = float(CTX.multiply(d, UP))
    if lo == hi:
        return lo
    q = exact_root_power(x, y)
    if q is not None:
        counts["exact"] += 1
        return to_float(q)
    # not rational: more digits settle it
    counts["hard"] += 1
    big = Context(prec=400, rounding=ROUND_HALF_EVEN, Emax=MAX_EMAX, Emin=MIN_EMIN, traps=[])
    d = big.power(Decimal(x), Decimal(y))
    lo = float(big.multiply(d, Decimal(1) - Decimal(10) ** -390))
    hi = float(big.multiply(d, Decimal(1) + Decimal(10) ** -390))
    if lo != hi:
        raise ValueError(f"cannot round pow({x!r}, {y!r})")
    return lo


def js_pow(x, y, counts):
    """Number::exponentiate of ECMAScript, with the correctly rounded power."""
    if y != y:
        return NAN
    if y == 0:
        return 1.0
    if x != x:
        return NAN
    if math.isinf(y):
        if abs(x) == 1:
            return NAN
        return INF if (abs(x) > 1) == (y > 0) else 0.0
    whole = y == math.floor(y)
    odd = whole and abs(y) < 2.0 ** 53 and int(abs(y)) % 2 == 1
    negative = math.copysign(1.0, x) < 0
    if x == 0 or math.isinf(x):
        large = (x == 0) == (y < 0)
        m = INF if large else 0.0
        return -m if (odd and negative) else m
    if negative and not whole:
        return NAN
    ax = abs(x)
    r = 1.0 if ax == 1 else positive_power(ax, y, counts)
    return -r if (negative and odd) else r


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as f:
        if f.read(8) != b"JSMATHV1":
            raise SystemExit("not a binary vector file")
        (n,) = struct.unpack("<I", f.read(4))
        meta = json.loads(f.read(n))
        while True:
            raw = f.read(4)
            if not raw:
                raise SystemExit("no pow section")
            (n,) = struct.unpack("<I", raw)
            head = json.loads(f.read(n))
            size = 8 * head["n"] * head["arity"]
            if head["name"] != "pow":
                f.seek(size + 8 * head["n"], 1)
                continue
            args = f.read(size)
            break
    count = head["n"]
    counts = {"exact": 0, "hard": 0}
    out = bytearray(8 * count)
    for i in range(count):
        x, y = struct.unpack_from("<dd", args, 16 * i)
        struct.pack_into("<d", out, 8 * i, js_pow(x, y, counts))
        if i % 100000 == 0:
            print(f"{i} of {count}", file=sys.stderr, flush=True)
    meta = {"reference": "correctly rounded (jsmath-powref.py)", "from": meta}
    with open(dst, "wb") as f:
        f.write(b"JSMATHV1")
        for record in (meta, head):
            text = json.dumps(record, separators=(",", ":")).encode()
            f.write(struct.pack("<I", len(text)))
            f.write(text)
            if record is head:
                f.write(args)
                f.write(out)
    print(f"{count} powers written to {dst}: {counts['exact']} by exact arithmetic, {counts['hard']} needed 400 digits")


if __name__ == "__main__":
    main()
