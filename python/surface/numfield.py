"""Exact arithmetic in the real number fields the Platonic surfaces need.

Elements are vectors of Fractions over the power basis 1, a, ..., a^(d-1) of a primitive
element a with a known minimal polynomial. Signs are decided exactly: an element is zero only
when all its coefficients are zero; otherwise its value is enclosed with mpmath interval
arithmetic at increasing precision until the enclosure excludes zero (this terminates because
a non-zero algebraic number has a positive distance from 0).

Fields:
  Q            d = 1 (cube: every coordinate is rational)
  Q(sqrt 3)    a = sqrt(3), a^2 = 3 (faces with 60-degree angles: tetrahedron, octahedron, icosahedron)
  Q(sqrt 5)    a = sqrt(5) (only for building the icosahedron and dodecahedron combinatorics)
  K            a = w = sqrt(10 + 2 sqrt 5), w^4 - 20 w^2 + 80 = 0 (dodecahedron: cos/sin of 18 degrees)
"""

from fractions import Fraction
from mpmath import iv, mpf

__all__ = ["Field", "QQ", "Q3", "Q5", "KD", "El"]


class Field:
    def __init__(self, name, minpoly, alpha_enclosure):
        # minpoly: monic, coefficients low -> high, e.g. x^2 - 3 is [-3, 0, 1]
        self.name = name
        self.minpoly = [Fraction(c) for c in minpoly]
        assert self.minpoly[-1] == 1
        self.d = len(minpoly) - 1
        self._alpha_enclosure = alpha_enclosure
        self._alpha_cache = {}
        self.zero = El(self, (Fraction(0),) * self.d)
        self.one = El(self, (Fraction(1),) + (Fraction(0),) * (self.d - 1))

    def __repr__(self):
        return "Field(%s)" % self.name

    def alpha_powers(self, prec):
        """Interval enclosures of a^0 .. a^(d-1) at `prec` bits."""
        hit = self._alpha_cache.get(prec)
        if hit is not None:
            return hit
        old = iv.prec
        iv.prec = prec
        try:
            a = self._alpha_enclosure()
            pw = [iv.mpf(1)]
            for _ in range(1, self.d):
                pw.append(pw[-1] * a)
        finally:
            iv.prec = old
        self._alpha_cache[prec] = pw
        return pw

    def __call__(self, x):
        """Embed a rational (int, Fraction, or float taken exactly)."""
        if isinstance(x, El):
            assert x.F is self
            return x
        return El(self, (Fraction(x),) + (Fraction(0),) * (self.d - 1))

    def gen(self):
        if self.d == 1:
            raise ValueError("Q has no generator")
        return El(self, (Fraction(0), Fraction(1)) + (Fraction(0),) * (self.d - 2))

    def mul_coeffs(self, a, b):
        d = self.d
        prod = [Fraction(0)] * (2 * d - 1)
        for i, x in enumerate(a):
            if x == 0:
                continue
            for j, y in enumerate(b):
                if y != 0:
                    prod[i + j] += x * y
        # reduce modulo the monic minimal polynomial, highest degree first
        mp = self.minpoly
        for k in range(2 * d - 2, d - 1, -1):
            c = prod[k]
            if c == 0:
                continue
            prod[k] = Fraction(0)
            for t in range(d):
                prod[k - d + t] -= c * mp[t]
        return tuple(prod[:d])


class El:
    __slots__ = ("F", "c")

    def __init__(self, F, coeffs):
        self.F = F
        self.c = tuple(coeffs)

    def _lift(self, o):
        if isinstance(o, El):
            if o.F is not self.F:
                raise TypeError("mixed fields %s and %s" % (self.F, o.F))
            return o
        return self.F(o)

    def __add__(self, o):
        o = self._lift(o)
        return El(self.F, tuple(x + y for x, y in zip(self.c, o.c)))

    __radd__ = __add__

    def __sub__(self, o):
        o = self._lift(o)
        return El(self.F, tuple(x - y for x, y in zip(self.c, o.c)))

    def __rsub__(self, o):
        return self._lift(o) - self

    def __neg__(self):
        return El(self.F, tuple(-x for x in self.c))

    def __mul__(self, o):
        if not isinstance(o, El):
            q = Fraction(o)
            return El(self.F, tuple(x * q for x in self.c))
        o = self._lift(o)
        return El(self.F, self.F.mul_coeffs(self.c, o.c))

    __rmul__ = __mul__

    def inverse(self):
        if self.is_zero():
            raise ZeroDivisionError("inverse of zero")
        d = self.F.d
        if d == 1:
            return El(self.F, (1 / self.c[0],))
        # solve (self * x) = 1 for the coefficient vector x: columns are self * a^j
        cols = []
        basis = [tuple(Fraction(1 if i == j else 0) for i in range(d)) for j in range(d)]
        for e in basis:
            cols.append(self.F.mul_coeffs(self.c, e))
        A = [[cols[j][i] for j in range(d)] + [Fraction(1 if i == 0 else 0)] for i in range(d)]
        # Gauss-Jordan elimination over Q
        for col in range(d):
            piv = next(r for r in range(col, d) if A[r][col] != 0)
            A[col], A[piv] = A[piv], A[col]
            pv = A[col][col]
            A[col] = [v / pv for v in A[col]]
            for r in range(d):
                if r != col and A[r][col] != 0:
                    f = A[r][col]
                    A[r] = [v - f * w for v, w in zip(A[r], A[col])]
        return El(self.F, tuple(A[i][d] for i in range(d)))

    def __truediv__(self, o):
        if not isinstance(o, El):
            q = Fraction(o)
            return El(self.F, tuple(x / q for x in self.c))
        return self * self._lift(o).inverse()

    def __rtruediv__(self, o):
        return self._lift(o) * self.inverse()

    def is_zero(self):
        return all(x == 0 for x in self.c)

    def to_iv(self, prec=None):
        """Interval enclosure at `prec` bits (default: the current iv.prec)."""
        p = prec or iv.prec
        pw = self.F.alpha_powers(p)
        old = iv.prec
        iv.prec = p
        try:
            acc = iv.mpf(0)
            for x, a in zip(self.c, pw):
                if x != 0:
                    acc += iv.mpf(x.numerator) / x.denominator * a
        finally:
            iv.prec = old
        return acc

    def sign(self):
        """Exact sign: -1, 0 or 1."""
        if self.is_zero():
            return 0
        if self.F.d == 1:
            return 1 if self.c[0] > 0 else -1
        prec = 96
        while True:
            v = self.to_iv(prec)
            if v.a > 0:
                return 1
            if v.b < 0:
                return -1
            prec *= 2
            if prec > 1 << 16:
                raise ArithmeticError("sign undecided at 65536 bits")

    def __float__(self):
        return float(self.to_iv(80).mid)

    def __eq__(self, o):
        return (self - o).is_zero()

    def __hash__(self):
        return hash(self.c)

    def __lt__(self, o):
        return (self - o).sign() < 0

    def __le__(self, o):
        return (self - o).sign() <= 0

    def __gt__(self, o):
        return (self - o).sign() > 0

    def __ge__(self, o):
        return (self - o).sign() >= 0

    def __repr__(self):
        return "El(%s, %s)" % (self.F.name, ", ".join(str(x) for x in self.c))


QQ = Field("Q", [0, 1], lambda: iv.mpf(0))
Q3 = Field("Q(sqrt3)", [-3, 0, 1], lambda: iv.sqrt(iv.mpf(3)))
Q5 = Field("Q(sqrt5)", [-5, 0, 1], lambda: iv.sqrt(iv.mpf(5)))
KD = Field("Q(sqrt(10+2sqrt5))", [80, 0, -20, 0, 1], lambda: iv.sqrt(10 + 2 * iv.sqrt(iv.mpf(5))))
