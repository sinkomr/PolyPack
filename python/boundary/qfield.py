"""Exact arithmetic in Q(sqrt 2, sqrt 3), for certifying constructions whose coordinates involve
sin 15 deg = (sqrt 6 - sqrt 2)/4 and cos 15 deg = (sqrt 6 + sqrt 2)/4.

An element is a + b sqrt 2 + c sqrt 3 + d sqrt 6 with rational a, b, c, d. Signs are decided
exactly. A binary64 evaluation is used only when it is far from 0 compared with its proven error
bound (see sign()); otherwise: write x = p + q sqrt 3 with p = a + b sqrt 2, q = c + d sqrt 2.
When p and q have opposite signs, sign(x) follows from sign(p^2 - 3 q^2), an element of
Q(sqrt 2), whose sign follows the same way from r^2 - 2 t^2 for r + t sqrt 2. These differences
are never 0 for nonzero p, q (r, t), because sqrt 3 is not in Q(sqrt 2) and sqrt 2 is irrational.

The certifier's generic routines (certify.realized_sq, path_lengths_sq, clearance_sq, embed,
cells_containing) only add, subtract, multiply and compare, so they run on these elements as on
integers.
"""

import math
from fractions import Fraction

# correctly rounded binary64 square roots (IEEE sqrt is correctly rounded)
_R2, _R3, _R6 = math.sqrt(2), math.sqrt(3), math.sqrt(6)


def _sgn(x):
    return (x > 0) - (x < 0)


def _sign2(r, t):
    """Sign of r + t sqrt 2 (r, t rational)."""
    sr, st = _sgn(r), _sgn(t)
    if st == 0:
        return sr
    if sr == 0 or sr == st:
        return st if sr == 0 else sr
    m = _sgn(r * r - 2 * t * t)  # never 0: sqrt 2 is irrational
    return m if sr > 0 else -m


class Q23:
    """a + b sqrt 2 + c sqrt 3 + d sqrt 6, a..d rational."""

    __slots__ = ("a", "b", "c", "d")

    def __init__(self, a=0, b=0, c=0, d=0):
        # integers stay Python ints (fast, and closed under +, - and *); anything else is a Fraction
        self.a, self.b, self.c, self.d = (x if type(x) is int else Fraction(x) for x in (a, b, c, d))

    @staticmethod
    def of(x):
        return x if isinstance(x, Q23) else Q23(x)

    def coeffs(self):
        return (self.a, self.b, self.c, self.d)

    def __add__(self, o):
        o = Q23.of(o)
        return Q23(self.a + o.a, self.b + o.b, self.c + o.c, self.d + o.d)

    __radd__ = __add__

    def __neg__(self):
        return Q23(-self.a, -self.b, -self.c, -self.d)

    def __sub__(self, o):
        return self + (-Q23.of(o))

    def __rsub__(self, o):
        return Q23.of(o) - self

    def __mul__(self, o):
        if not isinstance(o, Q23):
            k = o if type(o) is int else Fraction(o)
            return Q23(self.a * k, self.b * k, self.c * k, self.d * k)
        a1, b1, c1, d1 = self.coeffs()
        a2, b2, c2, d2 = o.coeffs()
        return Q23(
            a1 * a2 + 2 * b1 * b2 + 3 * c1 * c2 + 6 * d1 * d2,
            a1 * b2 + b1 * a2 + 3 * (c1 * d2 + d1 * c2),
            a1 * c2 + c1 * a2 + 2 * (b1 * d2 + d1 * b2),
            a1 * d2 + d1 * a2 + b1 * c2 + c1 * b2,
        )

    __rmul__ = __mul__

    def __truediv__(self, k):
        if isinstance(k, Q23):
            raise TypeError("division by a field element is not needed here")
        k = Fraction(k)
        return Q23(self.a / k, self.b / k, self.c / k, self.d / k)

    def __pow__(self, n):
        if not isinstance(n, int) or n < 0:
            raise TypeError("only non-negative integer powers")
        out = Q23(1)
        for _ in range(n):
            out = out * self
        return out

    def sign(self):
        a, b, c, d = self.coeffs()
        # Fast path, still rigorous: each term below is computed with relative error under 4e-16
        # (a correctly rounded conversion, a correctly rounded constant, one rounded product), and
        # three additions add at most 3.4e-16 of the sum of magnitudes, so the float sum is within
        # 2e-15 of the sum of magnitudes M from the true value. Its sign is taken only when it
        # exceeds 1e-12 M; otherwise the exact test below decides.
        try:
            ta, tb, tc, td = float(a), float(b) * _R2, float(c) * _R3, float(d) * _R6
            m = abs(ta) + abs(tb) + abs(tc) + abs(td)
            f = ta + tb + tc + td
            if math.isfinite(m) and abs(f) > 1e-12 * m:
                return 1 if f > 0 else -1
        except OverflowError:
            pass
        sp, sq = _sign2(a, b), _sign2(c, d)
        if sq == 0:
            return sp
        if sp == 0 or sp == sq:
            return sq if sp == 0 else sp
        # p^2 - 3 q^2 = (a^2 + 2 b^2 - 3 c^2 - 6 d^2) + (2 a b - 6 c d) sqrt 2, never 0 here
        n = _sign2(a * a + 2 * b * b - 3 * c * c - 6 * d * d, 2 * a * b - 6 * c * d)
        return n if sp > 0 else -n

    def __abs__(self):
        return -self if self.sign() < 0 else self

    def _cmp(self, o):
        return (self - Q23.of(o)).sign()

    def __eq__(self, o):
        try:
            return self._cmp(o) == 0
        except (TypeError, ValueError):
            return NotImplemented

    def __hash__(self):
        return hash(self.coeffs())

    def __lt__(self, o):
        return self._cmp(o) < 0

    def __le__(self, o):
        return self._cmp(o) <= 0

    def __gt__(self, o):
        return self._cmp(o) > 0

    def __ge__(self, o):
        return self._cmp(o) >= 0

    def __float__(self):
        return float(self.a) + float(self.b) * 2 ** 0.5 + float(self.c) * 3 ** 0.5 + float(self.d) * 6 ** 0.5

    def __repr__(self):
        return "Q23(%s, %s, %s, %s)" % tuple(str(x) for x in self.coeffs())

    def denominator(self):
        """The least common denominator of the coefficients."""
        d = 1
        for x in self.coeffs():
            d = math.lcm(d, Fraction(x).denominator)
        return d

    def scaled_int(self, D):
        """self * D with integer coefficients (D must clear every denominator)."""
        out = []
        for x in self.coeffs():
            y = Fraction(x) * D
            if y.denominator != 1:
                raise ValueError("D does not clear the denominators")
            out.append(int(y))
        return Q23(*out)

    def to_json(self):
        """[a, b, c, d] as rational strings: a + b sqrt 2 + c sqrt 3 + d sqrt 6."""
        return [str(x) for x in self.coeffs()]

    @staticmethod
    def from_json(v):
        if not (isinstance(v, list) and len(v) == 4):
            raise ValueError("a Q(sqrt 2, sqrt 3) element is a list [a, b, c, d]")
        return Q23(*(Fraction(str(x)) for x in v))


SQRT2 = Q23(0, 1)
SQRT3 = Q23(0, 0, 1)
SIN15 = Q23(0, Fraction(-1, 4), 0, Fraction(1, 4))  # (sqrt 6 - sqrt 2)/4
COS15 = Q23(0, Fraction(1, 4), 0, Fraction(1, 4))  # (sqrt 6 + sqrt 2)/4
