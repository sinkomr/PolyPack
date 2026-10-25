# Vendored from alejandrozu/platonic-packing (MIT licence; commit cbf76f2f, file algebraic.py).
# Copyright (c) 2026 Yohei Nakajima; Copyright (c) 2026 Alejandro Zarzuelo. Licence text: THIRD_PARTY_NOTICES.md.
# Unchanged except for these three comment lines.
"""Exact arithmetic in a real number field Q(alpha) and rigorous rational interval arithmetic (standard library only).

A field is given by an irreducible integer polynomial p (the minimal polynomial of alpha) and a rational interval
[a, b] containing alpha and no other root of p (checked with a Sturm sequence). Elements are coefficient tuples
(c_0, ..., c_{d-1}) of Fractions, meaning sum c_k alpha^k; the representation is unique, so an element is zero iff all
its coefficients are zero. Signs of nonzero elements are decided by evaluating them on a rational interval around
alpha with interval arithmetic and refining the interval (bisection, exact signs of p) until the result excludes 0,
which always happens because the value is nonzero.

Used by scripts/exact_solids.py (which builds src/solids_exact.json) and by certify_general.py."""
from fractions import Fraction as Fr


# ------------------------------------------------------------------ polynomials over Q (lists, low degree first)
def _trim(a):
    a = list(a) or [Fr(0)]
    while len(a) > 1 and a[-1] == 0: a.pop()
    return a


def _pmul(a, b):
    out = [Fr(0)] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x == 0: continue
        for j, y in enumerate(b): out[i + j] += x * y
    return out


def _pmod(a, m):
    a = list(a); dm = len(m) - 1; lead = m[-1]
    for i in range(len(a) - 1, dm - 1, -1):
        c = a[i]
        if c == 0: continue
        f = c / lead
        for j in range(dm + 1): a[i - dm + j] -= f * m[j]
    return _trim(a[:dm] if len(a) > dm else a)


def _peval(a, x):
    v = Fr(0)
    for c in reversed(a): v = v * x + c
    return v


def _pderiv(a): return _trim([k * a[k] for k in range(1, len(a))] or [Fr(0)])


def sturm_count(p, lo, hi):
    """Number of distinct real roots of p in (lo, hi] (Sturm's theorem; exact)."""
    seq = [_trim([Fr(c) for c in p]), _pderiv([Fr(c) for c in p])]
    while len(seq[-1]) > 1 or seq[-1][0] != 0:
        r = _pmod(seq[-2], seq[-1])
        if len(r) == 1 and r[0] == 0: break
        seq.append([-c for c in r])

    def changes(x):
        s = [_peval(q, x) for q in seq]; s = [v for v in s if v != 0]
        return sum(1 for u, v in zip(s, s[1:]) if (u > 0) != (v > 0))
    return changes(lo) - changes(hi)


# ------------------------------------------------------------------ rational intervals
class I:
    """Closed interval [lo, hi] with Fraction endpoints; operations return enclosures of the exact results."""
    __slots__ = ('lo', 'hi')

    def __init__(self, lo, hi=None):
        self.lo = Fr(lo); self.hi = Fr(hi) if hi is not None else self.lo

    def __add__(s, o):
        o = o if isinstance(o, I) else I(o); return I(s.lo + o.lo, s.hi + o.hi)
    __radd__ = __add__

    def __neg__(s): return I(-s.hi, -s.lo)
    def __sub__(s, o): return s + (-(o if isinstance(o, I) else I(o)))
    def __rsub__(s, o): return (-s) + o

    def __mul__(s, o):
        if not isinstance(o, I):
            o = Fr(o); return I(s.lo * o, s.hi * o) if o >= 0 else I(s.hi * o, s.lo * o)
        p = (s.lo * o.lo, s.lo * o.hi, s.hi * o.lo, s.hi * o.hi)
        return I(min(p), max(p))
    __rmul__ = __mul__

    def __repr__(s): return f'[{float(s.lo)!r}, {float(s.hi)!r}]'


def isqrt_interval(x, bits=200):
    """Enclosure of sqrt(x) for an interval x with x.lo >= 0 (integer square roots of scaled numerators)."""
    import math
    S = 1 << (2 * bits)

    def lo_root(q):  # largest k/2^bits with (k/2^bits)^2 <= q
        k = math.isqrt(q.numerator * S // q.denominator); return Fr(k, 1 << bits)

    def hi_root(q):
        k = math.isqrt(-(-q.numerator * S // q.denominator)); k += 1; return Fr(k, 1 << bits)
    assert x.lo >= 0
    return I(lo_root(x.lo), hi_root(x.hi))


def inv_interval(x):
    assert x.lo > 0 or x.hi < 0
    return I(1 / x.hi, 1 / x.lo)


# ------------------------------------------------------------------ the field
class Field:
    def __init__(self, minpoly, lo, hi, name='alpha'):
        self.p = [Fr(c) for c in minpoly]                       # integer coefficients, low degree first
        self.d = len(self.p) - 1
        self.monic = [c / self.p[-1] for c in self.p]
        self.lo, self.hi = Fr(lo), Fr(hi); self.name = name
        assert sturm_count(self.p, self.lo, self.hi) == 1 and _peval(self.p, self.lo) != 0, 'interval does not isolate a root'
        self._pow_cache = {}

    def refine(self, width):
        """Shrink the isolating interval by bisection until hi - lo <= width."""
        slo = _peval(self.p, self.lo) > 0
        while self.hi - self.lo > width:
            m = (self.lo + self.hi) / 2; v = _peval(self.p, m)
            if v == 0: self.lo = self.hi = m; break
            if (v > 0) == slo: self.lo = m
            else: self.hi = m
        self._pow_cache = {}

    def alpha(self): return I(self.lo, self.hi)

    # elements: tuples of d Fractions
    def elem(self, coeffs):
        c = [Fr(x) for x in coeffs] + [Fr(0)] * self.d
        return tuple(c[:self.d])

    def zero(self): return tuple([Fr(0)] * self.d)
    def one(self): return self.elem([1])
    def add(self, a, b): return tuple(x + y for x, y in zip(a, b))
    def sub(self, a, b): return tuple(x - y for x, y in zip(a, b))
    def scale(self, a, q): q = Fr(q); return tuple(x * q for x in a)

    def mul(self, a, b):
        if self.d == 1: return (a[0] * b[0],)
        r = _pmod(_pmul(list(a), list(b)), self.monic)
        return self.elem(r)

    def is_zero(self, a): return all(x == 0 for x in a)

    def interval(self, a):
        """Enclosure of the value of a at alpha (Horner with interval arithmetic)."""
        x = self.alpha(); v = I(0)
        for c in reversed(a): v = v * x + c
        return v

    def sign(self, a):
        if self.is_zero(a): return 0
        w = self.hi - self.lo
        while True:
            v = self.interval(a)
            if v.lo > 0: return 1
            if v.hi < 0: return -1
            w = w / 2 ** 32 if w > 0 else w
            if self.hi - self.lo == 0: raise ArithmeticError('alpha is rational, sign undecided')
            self.refine(max(w, Fr(1, 2 ** 4000)))


# ------------------------------------------------------------------ vectors over the field
def vsub(F, u, v): return tuple(F.sub(a, b) for a, b in zip(u, v))
def vdot(F, u, v):
    s = F.zero()
    for a, b in zip(u, v): s = F.add(s, F.mul(a, b))
    return s
def vcross(F, u, v):
    return (F.sub(F.mul(u[1], v[2]), F.mul(u[2], v[1])), F.sub(F.mul(u[2], v[0]), F.mul(u[0], v[2])),
            F.sub(F.mul(u[0], v[1]), F.mul(u[1], v[0])))
