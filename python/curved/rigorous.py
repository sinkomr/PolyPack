"""Rigorous interval building blocks for the curved-packing certifier.

Only the four arithmetic operations and sqrt of mpmath's interval context `iv` are trusted
(outward rounding, mpmath.libmp mpi_* routines). Every transcendental quantity (pi, cos, sin,
cs_K, sn_K) is built here from power series with explicit remainder bounds, so the certifier does
not depend on the correctness of mpmath's interval elementary functions.

Curvature functions with t = K x^2 (entire, no division by K):
    C(t) = sum (-t)^k/(2k)!     cs_K(x) = C(K x^2)
    S(t) = sum (-t)^k/(2k+1)!   sn_K(x) = x S(K x^2)
    V(t) = sum (-t)^k/(2k+2)!   (1 - cs_K(x))/K = x^2 V(K x^2)
cos x = C(x^2), sin x = x S(x^2).
"""
from fractions import Fraction
import math

from mpmath import iv, mpf

PREC = 256
iv.prec = PREC

# tail bound target: 2^-(PREC + 30)
_EPS_EXP = PREC + 30


def I(x):
    """Exact interval for an int, a binary float or a Fraction (outward rounded if needed)."""
    if isinstance(x, Fraction):
        return iv.mpf(x.numerator) / iv.mpf(x.denominator)
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    if isinstance(x, int):
        return iv.mpf(x)
    if isinstance(x, float):
        if not math.isfinite(x):
            raise ValueError("non-finite input")
        # a binary64 float is an exact dyadic rational; convert exactly
        return I(Fraction(x))
    return iv.mpf(x)


def upper(x):
    return x.b


def lower(x):
    return x.a


def is_pos(x):
    """Certainly > 0."""
    return x.a > 0


def is_neg(x):
    """Certainly < 0."""
    return x.b < 0


def absmax(x):
    """Upper bound on |x| as an mpf."""
    return max(abs(x.a), abs(x.b))


_COEF = {}


def _coef(first, k):
    """Interval 1/(first + 2k)! at the current precision (cached)."""
    key = (iv.prec, first, k)
    c = _COEF.get(key)
    if c is None:
        c = iv.mpf(1) / iv.mpf(math.factorial(first + 2 * k))
        _COEF[key] = c
    return c


def _series(t, first):
    """sum_{k>=0} (-t)^k / (first + 2k)!  plus a rigorous tail enclosure.

    n terms are summed by Horner's rule; the tail sum_{k>=n} |t|^k/(first+2k)! is bounded by
    2 |t|^n/(first+2n)!, valid once |t| <= (first+2n+1)(first+2n+2)/2 (term ratio <= 1/2)."""
    T = float(absmax(t)) * (1 + 1e-12) + 1e-300
    target = 2.0 ** (-(iv.prec + 30))
    # choose n (heuristic, in floats; the tail itself is bounded rigorously below)
    n = 1
    lt = 0.0  # log of |t|^n/(first+2n)!
    logT = math.log(T) if T > 0 else -1e9
    while True:
        lt = n * logT - math.lgamma(first + 2 * n + 1)
        if 2 * T <= (first + 2 * n + 1) * (first + 2 * n + 2) and lt < math.log(target):
            break
        n += 1
        if n > 3000:
            raise ValueError("series argument too large")
    u = -t
    acc = iv.mpf(0)
    for k in range(n - 1, -1, -1):
        acc = acc * u + _coef(first, k)
    Tu = iv.mpf(absmax(t))
    tail = Tu ** n * _coef(first, n) * 2
    tb = tail.b
    return acc + iv.mpf([-tb, tb])


def Cfun(t):
    return _series(t, 0)


def Sfun(t):
    return _series(t, 1)


def Vfun(t):
    return _series(t, 2)


def cos_sin(x):
    """Rigorous (cos x, sin x) for an interval x of moderate size."""
    t = x * x
    return Cfun(t), x * Sfun(t)


def cos_sin_reduced(x):
    """(cos x, sin x) with argument reduction x - 2 pi k (k from a float estimate; any k is valid
    because the interval 2 pi k is rigorous), so large |x| does not widen the series enclosure."""
    xf = float(x.a)
    if abs(xf) <= 8:
        return cos_sin(x)
    k = round(xf / (2 * math.pi))
    return cos_sin(x - 2 * k * pi_iv())


def _atan_inv(m):
    """atan(1/m) for an integer m >= 2: alternating series, error <= first omitted term."""
    s = iv.mpf(0)
    k = 0
    while True:
        term = iv.mpf(1) / (iv.mpf(2 * k + 1) * iv.mpf(m) ** (2 * k + 1))
        if term.b < mpf(2) ** (-_EPS_EXP):
            break
        s = s + term if k % 2 == 0 else s - term
        k += 1
    tb = term.b
    return s + iv.mpf([-tb, tb])


_PI = None


def pi_iv():
    """Machin: pi = 16 atan(1/5) - 4 atan(1/239)."""
    global _PI
    if _PI is None:
        _PI = 16 * _atan_inv(5) - 4 * _atan_inv(239)
    return _PI


def csK(K, x):
    return Cfun(K * x * x)


def snK(K, x):
    return x * Sfun(K * x * x)


def sqrt_pos(x):
    if not x.a > 0:
        raise ValueError("sqrt of a possibly non-positive interval")
    return iv.sqrt(x)
