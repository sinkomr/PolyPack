# Vendored from alejandrozu/platonic-packing (MIT licence; commit cbf76f2f, file multiquad.py).
# Copyright (c) 2026 Yohei Nakajima; Copyright (c) 2026 Alejandro Zarzuelo. Licence text: THIRD_PARTY_NOTICES.md.
# Unchanged except for these three comment lines.
"""Exact arithmetic in the multiquadratic field Q(sqrt2, sqrt3, sqrt5, sqrt7) (standard library only).

Added 13 Oct 2026 (Alejandro: "add also sqrt3, sqrt7 to the field over which we prove the constructions"). Both exact
certifiers use it: a record may give any number (centre coordinate, quaternion entry, s_full, container_center) either
as a JSON number (read as the exact rational it denotes) or as a string expression in this field, e.g. "4+2*sqrt3",
"(1+sqrt7)/2", "sqrt(21)/3", "3/4"; the certificate is then decided exactly / rigorously in Q(sqrt2, sqrt3, sqrt5, sqrt7).

An element is sum_d c_d sqrt(d) over the 16 squarefree divisors d of 210 = 2*3*5*7 (a basis: the field has degree 16),
with rational c_d. Products use sqrt(a) sqrt(b) = g sqrt(ab/g^2), g = gcd(a, b). Signs are decided exactly by the
tower Q < Q(sqrt2) < Q(sqrt2, sqrt3) < ...: write x = p + q sqrt(r) with p, q free of sqrt(r); if p and q have the same
sign that is the sign of x, otherwise it is sign(p) * sign(p^2 - r q^2) (never 0: sqrt(r) is not in the smaller field).
Inverses use the same tower: 1/(p + q sqrt r) = (p - q sqrt r) / (p^2 - r q^2)."""
from fractions import Fraction as Fr
from math import gcd, isqrt
import ast

PRIMES = (2, 3, 5, 7)
BASIS = sorted({a * b * c * d for a in (1, 2) for b in (1, 3) for c in (1, 5) for d in (1, 7)})


def _sqfree(n):
    """n = k^2 m with m squarefree; returns (k, m)."""
    k, m, f = 1, n, 2
    while f * f <= m:
        while m % (f * f) == 0: m //= f * f; k *= f
        f += 1
    return k, m


class MQ:
    __slots__ = ('c',)

    def __init__(self, v=0, _c=None):
        if _c is not None:
            self.c = {d: x for d, x in _c.items() if x}; return
        if isinstance(v, MQ): self.c = dict(v.c); return
        v = Fr(v)
        self.c = {1: v} if v else {}

    @staticmethod
    def sqrt(n):
        """sqrt of a positive integer whose squarefree part divides 210."""
        k, m = _sqfree(int(n))
        if 210 % m: raise ValueError(f'sqrt({n}) is not in Q(sqrt2, sqrt3, sqrt5, sqrt7)')
        return MQ(_c={m: Fr(k)})

    @staticmethod
    def of(v):
        return v if isinstance(v, MQ) else MQ(v)

    # ---------------------------------------------------------------- arithmetic
    def __add__(s, o):
        o = MQ.of(o); c = dict(s.c)
        for d, x in o.c.items(): c[d] = c.get(d, 0) + x
        return MQ(_c=c)
    __radd__ = __add__

    def __neg__(s): return MQ(_c={d: -x for d, x in s.c.items()})
    def __sub__(s, o): return s + (-MQ.of(o))
    def __rsub__(s, o): return MQ.of(o) - s

    def __mul__(s, o):
        if not isinstance(o, MQ):
            o = Fr(o); return MQ(_c={d: x * o for d, x in s.c.items()})
        c = {}
        for d1, x1 in s.c.items():
            for d2, x2 in o.c.items():
                g = gcd(d1, d2); d = d1 * d2 // (g * g)
                c[d] = c.get(d, 0) + x1 * x2 * g
        return MQ(_c=c)
    __rmul__ = __mul__

    def __pow__(s, e):
        e = int(e); r = MQ(1); b = s
        if e < 0: b = b.inv(); e = -e
        while e:
            if e & 1: r = r * b
            b = b * b; e >>= 1
        return r

    def _split(s):
        """(r, p, q) with s = p + q sqrt(r), r the largest prime present (None if s is rational)."""
        ps = [r for r in PRIMES if any(d % r == 0 for d in s.c)]
        if not ps: return None, s, MQ(0)
        r = ps[-1]
        p = MQ(_c={d: x for d, x in s.c.items() if d % r})
        q = MQ(_c={d // r: x for d, x in s.c.items() if d % r == 0})
        return r, p, q

    def inv(s):
        if not s.c: raise ZeroDivisionError('MQ division by zero')
        r, p, q = s._split()
        if r is None: return MQ(1 / s.c[1])
        den = p * p - q * q * r                        # in the field without sqrt(r), nonzero
        return (p - q * MQ.sqrt(r)) * den.inv()

    def __truediv__(s, o):
        if not isinstance(o, MQ): return s * (1 / Fr(o))
        return s * o.inv()

    def __rtruediv__(s, o): return MQ.of(o) * s.inv()

    # ---------------------------------------------------------------- order
    def sign(s):
        if not s.c: return 0
        r, p, q = s._split()
        if r is None: return 1 if s.c[1] > 0 else -1
        sp, sq = p.sign(), q.sign()
        if sq == 0: return sp
        if sp == 0 or sp == sq: return sq if sp == 0 else sp
        return sp * (p * p - q * q * r).sign()

    def __eq__(s, o): return (s - o).sign() == 0
    def __ne__(s, o): return not s.__eq__(o)
    def __lt__(s, o): return (s - o).sign() < 0
    def __le__(s, o): return (s - o).sign() <= 0
    def __gt__(s, o): return (s - o).sign() > 0
    def __ge__(s, o): return (s - o).sign() >= 0
    def __hash__(s): return hash(tuple(sorted(s.c.items())))

    # ---------------------------------------------------------------- numerics
    def __float__(s): return float(sum(float(x) * d ** 0.5 for d, x in s.c.items()))

    def enclose(s, bits=200):
        """Rigorous rational enclosure [lo, hi] of the element (each sqrt(d) enclosed to 2^-bits)."""
        lo = hi = Fr(0); sc = 1 << bits
        for d, x in s.c.items():
            if d == 1: lo += x; hi += x; continue
            f = isqrt(d * sc * sc)                        # floor(sqrt(d) * 2^bits)
            a, b = Fr(f, sc), Fr(f + 1, sc)
            if x > 0: lo += x * a; hi += x * b
            else: lo += x * b; hi += x * a
        return lo, hi

    def primes(s):
        return {r for r in PRIMES if any(d % r == 0 for d in s.c)}

    def __repr__(s):
        if not s.c: return '0'
        out = []
        for d in sorted(s.c):
            x = s.c[d]; t = str(abs(x)) if d == 1 else (('' if abs(x) == 1 else f'{abs(x)}*') + f'sqrt{d}')
            out.append(('-' if x < 0 else '+') + t)
        r = ''.join(out)
        return r[1:] if r[0] == '+' else r


def field_name(primes):
    ps = sorted(primes)
    return 'Q' if not ps else 'Q(' + ', '.join(f'sqrt{p}' for p in ps) + ')'


# -------------------------------------------------------------------- parsing (no eval: a small AST walker)
def parse(expr):
    """Exact value of a string such as '4+2*sqrt3', '(1+sqrt7)/2', 'sqrt(21)/3', '-0.25', '3/4', 'sqrt2**3'.
    Decimal literals are read as exact decimals; names sqrtN (N whose squarefree part divides 210) and sqrt(N)."""
    tree = ast.parse(expr.strip(), mode='eval')

    def ev(nd):
        if isinstance(nd, ast.Expression): return ev(nd.body)
        if isinstance(nd, ast.Constant) and isinstance(nd.value, (int, float)) and not isinstance(nd.value, bool):
            seg = ast.get_source_segment(expr.strip(), nd)
            return MQ(Fr(seg) if seg else Fr(nd.value))
        if isinstance(nd, ast.UnaryOp) and isinstance(nd.op, (ast.USub, ast.UAdd)):
            v = ev(nd.operand); return -v if isinstance(nd.op, ast.USub) else v
        if isinstance(nd, ast.BinOp):
            a, b = ev(nd.left), ev(nd.right)
            if isinstance(nd.op, ast.Add): return a + b
            if isinstance(nd.op, ast.Sub): return a - b
            if isinstance(nd.op, ast.Mult): return a * b
            if isinstance(nd.op, ast.Div): return a / b
            if isinstance(nd.op, ast.Pow):
                if b.primes() or b.c.get(1, Fr(0)).denominator != 1: raise ValueError('only integer powers')
                return a ** int(b.c.get(1, 0))
        if isinstance(nd, ast.Name) and nd.id.startswith('sqrt') and nd.id[4:].isdigit():
            return MQ.sqrt(int(nd.id[4:]))
        if (isinstance(nd, ast.Call) and isinstance(nd.func, ast.Name) and nd.func.id == 'sqrt' and len(nd.args) == 1
                and isinstance(nd.args[0], ast.Constant) and isinstance(nd.args[0].value, int)):
            return MQ.sqrt(nd.args[0].value)
        raise ValueError(f'unsupported expression in {expr!r}')
    return ev(tree)


def num(v):
    """A record entry as an exact number: JSON numbers -> the rational they denote (Fraction), strings -> MQ."""
    if isinstance(v, str):
        x = parse(v)
        return x.c.get(1, Fr(0)) if not x.primes() else x
    return Fr(v)


if __name__ == '__main__':
    # self-test
    s3, s7 = MQ.sqrt(3), MQ.sqrt(7)
    x = 4 + 2 * s3
    assert abs(float(x) - (4 + 2 * 3 ** 0.5)) < 1e-12
    assert (x * x.inv()) == 1 and (s3 * s7) == MQ.sqrt(21)
    assert (MQ.sqrt(2) + s3).sign() == 1 and (s7 - MQ.sqrt(2) - MQ.sqrt(3) + Fr(1, 5)).sign() == (1 if 7 ** .5 - 2 ** .5 - 3 ** .5 + .2 > 0 else -1)
    y = parse('(1+sqrt7)/2 - sqrt(28)/4'); assert y == Fr(1, 2)
    lo, hi = parse('sqrt2+sqrt3+sqrt5+sqrt7').enclose(100); v = 2 ** .5 + 3 ** .5 + 5 ** .5 + 7 ** .5
    assert lo <= Fr(v) + Fr(1, 10 ** 12) and hi >= Fr(v) - Fr(1, 10 ** 12) and hi - lo < Fr(1, 2 ** 90)
    # p^2 - r q^2 test that would fail without exact signs: (sqrt2+sqrt3)^2 vs 5+2*sqrt6
    assert (MQ.sqrt(2) + s3) ** 2 == 5 + 2 * MQ.sqrt(6)
    print('multiquad self-test ok:', repr(x), repr(parse('sqrt(12)*sqrt(21)/6')), field_name({3, 7}))
