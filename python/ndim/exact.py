"""Exact and rigorous arithmetic shared by the nD catalogue and certifier (standard library only).

Two kinds of numbers appear in the catalogue (docs/spaces/NDIM.md):
  axis form  x_k = (V_k / den) * sqrt(rad_k)   rad_k a squarefree positive integer per axis, V_k and den integers;
  q5 form    x_k = (a_k + b_k sqrt5) / den     (the 120-cell and 600-cell).
Everything else (facets, edge lengths) is derived exactly from these. Fixed-point intervals (K bits, outward rounding)
enclose them for the certifier, as in python/polyhedra/certify_general.py (the arithmetic is the same idea; the code
is PolyPack's own)."""
import math
import os
import sys
from fractions import Fraction as Fr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(os.path.dirname(HERE), 'polyhedra'))
import algebraic as A  # noqa: E402  (PolyPack's vendored number-field tools: intervals and integer square roots)

K = 170
ONE = 1 << K


# ------------------------------------------------------------------ small number theory
def sqfree(n):
    """n = k^2 m with m squarefree; returns (k, m) for a positive integer n."""
    k, m, f = 1, n, 2
    while f * f <= m:
        while m % (f * f) == 0:
            m //= f * f
            k *= f
        f += 1
    return k, m


def sqrt_split(q):
    """For a positive rational q returns (f, r) with sqrt(q) = f sqrt(r), f rational and r a squarefree integer."""
    q = Fr(q)
    assert q > 0
    k, m = sqfree(q.numerator * q.denominator)       # sqrt(a/b) = sqrt(ab) / b
    return Fr(k, q.denominator), m


def lcm(a, b):
    return a * b // math.gcd(a, b)


# ------------------------------------------------------------------ fixed-point intervals (lo, hi) = [lo, hi] / 2^K
def fx(q):
    """Enclosure of a rational (or an algebraic.I) as a fixed-point interval."""
    if isinstance(q, A.I):
        lo, hi = q.lo, q.hi
    else:
        lo = hi = Fr(q)
    return (lo.numerator * ONE // lo.denominator, -(-hi.numerator * ONE // hi.denominator))


def fadd(a, b):
    return (a[0] + b[0], a[1] + b[1])


def fsub(a, b):
    return (a[0] - b[1], a[1] - b[0])


def fmul(a, b):
    p = (a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1])
    return (min(p) >> K, -((-max(p)) >> K))


def fsqrt(r):
    """Enclosure of sqrt(r) for a nonnegative rational r."""
    r = Fr(r)
    if r == 0:
        return (0, 0)
    e = A.isqrt_interval(A.I(r), bits=K + 16)
    return fx(e)


def fto_float(a):
    """Midpoint of a fixed-point interval as a float (correctly rounded to within one ulp)."""
    return float(Fr(a[0] + a[1], 2 * ONE))


def fto_fraction(a):
    return Fr(a[0] + a[1], 2 * ONE)


# ------------------------------------------------------------------ exact linear algebra over Q
def nullvec(rows):
    """A nonzero rational vector orthogonal to the given rows (d-1 independent rows of length d), or None."""
    d = len(rows[0])
    M = [[Fr(x) for x in r] for r in rows]
    piv = []
    r = 0
    for c in range(d):
        p = next((i for i in range(r, len(M)) if M[i][c] != 0), None)
        if p is None:
            continue
        M[r], M[p] = M[p], M[r]
        inv = 1 / M[r][c]
        M[r] = [x * inv for x in M[r]]
        for i in range(len(M)):
            if i != r and M[i][c] != 0:
                f = M[i][c]
                M[i] = [x - f * y for x, y in zip(M[i], M[r])]
        piv.append(c)
        r += 1
        if r == len(M):
            break
    free = [c for c in range(d) if c not in piv]
    if len(free) != 1:
        return None
    fc = free[0]
    v = [Fr(0)] * d
    v[fc] = Fr(1)
    for i, c in enumerate(piv):
        v[c] = -M[i][fc]
    return v


def rank(rows):
    M = [[Fr(x) for x in r] for r in rows]
    r = 0
    d = len(M[0]) if M else 0
    for c in range(d):
        p = next((i for i in range(r, len(M)) if M[i][c] != 0), None)
        if p is None:
            continue
        M[r], M[p] = M[p], M[r]
        for i in range(r + 1, len(M)):
            if M[i][c] != 0:
                f = M[i][c] / M[r][c]
                M[i] = [x - f * y for x, y in zip(M[i], M[r])]
        r += 1
    return r


def primitive(vec):
    """Scales a rational vector to a primitive integer vector (same direction)."""
    den = 1
    for x in vec:
        den = lcm(den, Fr(x).denominator)
    ints = [int(Fr(x) * den) for x in vec]
    g = 0
    for x in ints:
        g = math.gcd(g, abs(x))
    return [x // g for x in ints] if g else ints
