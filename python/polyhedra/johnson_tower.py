"""Exact arithmetic in a tower of real quadratic extensions Q = K0 < K1 < ... (standard library and mpmath).

K_k = K_{k-1}(sqrt d_k) with d_k in K_{k-1} a non-square there. An element of K_k is a + b sqrt(d_k) with a, b in
K_{k-1}; level 0 elements are Fractions. Representations are canonical (b = 0 is dropped), so an element is zero iff it
is the Fraction 0. sqrt() extends the tower only when the argument is not already a square of the current field, so
the tower degree is the true degree of the generated field. Used by johnson.py to build the Johnson solids exactly.
"""
from fractions import Fraction as Fr
from math import isqrt

import mpmath as mp

mp.mp.dps = 130


class Tower:
    def __init__(self):
        self.D = [None]            # D[k]: the radicand of level k (an element of level < k)
        self.val = [None]          # val[k]: mpf of sqrt(D[k]) > 0


T = Tower()


def reset():
    global T
    T = Tower()


class E:
    __slots__ = ('k', 'a', 'b', 'v')

    def __init__(s, k, a, b):
        s.k, s.a, s.b, s.v = k, a, b, None

    def __add__(s, o): return add(s, o)
    __radd__ = __add__
    def __sub__(s, o): return sub(s, o)
    def __rsub__(s, o): return sub(o, s)
    def __neg__(s): return neg(s)
    def __mul__(s, o): return mul(s, o)
    __rmul__ = __mul__
    def __truediv__(s, o): return mul(s, inv(o))
    def __rtruediv__(s, o): return mul(o, inv(s))
    def __float__(s): return float(approx(s))
    def __repr__(s): return f'E({float(s):.6f}, level {s.k})'


def lvl(x): return x.k if isinstance(x, E) else 0
def iszero(x): return (not isinstance(x, E)) and x == 0


def mk(k, a, b):
    return a if iszero(b) else E(k, a, b)


def add(x, y):
    kx, ky = lvl(x), lvl(y)
    if kx == ky:
        if kx == 0: return Fr(x) + Fr(y)
        return mk(kx, add(x.a, y.a), add(x.b, y.b))
    if kx > ky: return mk(kx, add(x.a, y), x.b)
    return mk(ky, add(x, y.a), y.b)


def neg(x):
    return mk(x.k, neg(x.a), neg(x.b)) if isinstance(x, E) else -Fr(x)


def sub(x, y): return add(x, neg(y))


def mul(x, y):
    kx, ky = lvl(x), lvl(y)
    if kx == 0 and ky == 0: return Fr(x) * Fr(y)
    if iszero(x) or iszero(y): return Fr(0)
    if kx > ky: return mk(kx, mul(x.a, y), mul(x.b, y))
    if ky > kx: return mk(ky, mul(x, y.a), mul(x, y.b))
    ac, bd = mul(x.a, y.a), mul(x.b, y.b)
    real = add(ac, mul(T.D[kx], bd))
    imag = sub(mul(add(x.a, x.b), add(y.a, y.b)), add(ac, bd))
    return mk(kx, real, imag)


def inv(x):
    k = lvl(x)
    if k == 0: return 1 / Fr(x)
    n = sub(mul(x.a, x.a), mul(T.D[k], mul(x.b, x.b)))
    ni = inv(n)
    return mk(k, mul(x.a, ni), neg(mul(x.b, ni)))


def approx(x):
    if not isinstance(x, E): return mp.mpf(Fr(x).numerator) / Fr(x).denominator
    if x.v is None: x.v = approx(x.a) + approx(x.b) * T.val[x.k]
    return x.v


def sign(x):
    v = approx(x)
    return 0 if iszero(x) else (1 if v > 0 else -1)


def _sqrt_at(x, k):
    """A square root of x in K_k, or None."""
    if k == 0:
        x = Fr(x)
        if x < 0: return None
        n, d = isqrt(x.numerator), isqrt(x.denominator)
        return Fr(n, d) if n * n == x.numerator and d * d == x.denominator else None
    if lvl(x) == k: a, b = x.a, x.b
    else: a, b = x, Fr(0)
    dk = T.D[k]
    if iszero(b):
        y = _sqrt_at(a, k - 1)
        if y is not None: return y
        y = _sqrt_at(mul(a, inv(dk)), k - 1)            # a = q^2 d_k  ->  sqrt = q sqrt(d_k)
        return None if y is None else mk(k, Fr(0), y)
    N = sub(mul(a, a), mul(dk, mul(b, b)))
    s = _sqrt_at(N, k - 1)
    if s is None: return None
    for sg in (s, neg(s)):
        p = _sqrt_at(mul(add(a, sg), Fr(1, 2)), k - 1)
        if p is not None and not iszero(p):
            return mk(k, p, mul(b, inv(mul(p, 2))))
    return None


def sqrt(x):
    """The positive square root of x >= 0, extending the tower if x is not a square of the current field."""
    if iszero(x): return Fr(0)
    assert approx(x) > 0, 'sqrt of a negative number'
    top = len(T.D) - 1
    y = _sqrt_at(x, top)
    if y is None:
        T.D.append(x)
        T.val.append(mp.sqrt(approx(x)))
        return E(top + 1, Fr(0), Fr(1))
    return y if approx(y) > 0 else neg(y)


def flat(x, k):
    """Coordinates of x in the basis of K_k (2^k Fractions)."""
    if k == 0: return [Fr(x)]
    if lvl(x) == k: return flat(x.a, k - 1) + flat(x.b, k - 1)
    return flat(x, k - 1) + [Fr(0)] * (2 ** (k - 1))


def top(): return len(T.D) - 1


# ----------------------------------------------------------------------------------------- vectors
def vadd(u, v): return tuple(add(a, b) for a, b in zip(u, v))
def vsub(u, v): return tuple(sub(a, b) for a, b in zip(u, v))
def vscale(u, s): return tuple(mul(a, s) for a, b in zip(u, u))
def vdot(u, v):
    r = Fr(0)
    for a, b in zip(u, v): r = add(r, mul(a, b))
    return r
def vcross(u, v):
    return (sub(mul(u[1], v[2]), mul(u[2], v[1])), sub(mul(u[2], v[0]), mul(u[0], v[2])), sub(mul(u[0], v[1]), mul(u[1], v[0])))
def vmean(vs):
    n = Fr(1, len(vs)); r = vs[0]
    for v in vs[1:]: r = vadd(r, v)
    return vscale(r, n)
def vfloat(u): return [float(approx(a)) for a in u]


# ----------------------------------------------------------------------------------------- primitive element
def _reduce(basis, vec):
    """Reduce vec against basis [(pivot, vector, combo)] ; returns (residual, combo of basis powers)."""
    vec = list(vec); combo = [Fr(0)] * (len(basis) + 1)
    for idx, (piv, bv, bc) in enumerate(basis):
        c = vec[piv]
        if c != 0:
            for i in range(len(vec)):
                if bv[i] != 0: vec[i] -= c * bv[i]
            for i, w in enumerate(bc): combo[i] += c * w
    return vec, combo


def primitive(values, maxdeg=64, want_all=True):
    """Find alpha with every value in Q(alpha). values: elements of the current tower.
    Returns (minpoly as Fractions low->high, [coefficient lists of each value], alpha as mpf)."""
    K = top()
    vals = []
    for v in values:
        if lvl(v) > 0 and all(v is not w for w in vals): vals.append(v)
    uniq = {}
    for v in vals: uniq.setdefault(tuple(flat(v, K)), v)
    vals = list(uniq.values())
    vals.sort(key=lambda v: -lvl(v))
    alpha = None
    deg = 1
    for v in vals:
        if alpha is None:
            alpha = v; deg = _try(alpha, [], K, maxdeg)[0]
            continue
        if _try(alpha, [v], K, maxdeg)[1] is not None: continue
        for lam in range(1, 40):
            cand = add(alpha, mul(v, lam))
            d, ok = _try(cand, [alpha, v], K, maxdeg)
            if ok is not None:
                alpha = cand; break
        else:
            raise RuntimeError('no primitive element found')
    if alpha is None:
        return [Fr(-1), Fr(1)], [[Fr(x)] for x in values], mp.mpf(1)
    d, res = _try(alpha, list(values), K, maxdeg)
    mpoly, polys = res
    return mpoly, polys, approx(alpha)


def _try(alpha, targets, K, maxdeg):
    """Krylov: (degree of alpha, (minpoly, coefficient lists of targets) or None if some target is outside Q(alpha))."""
    basis = []; pw = Fr(1); mpoly = None
    cur = Fr(1)
    while True:
        vec, combo = _reduce(basis, flat(cur, K))
        if all(c == 0 for c in vec):
            # cur = sum combo_i alpha^i  (combo over basis powers 0..m-1)
            mpoly = [-c for c in combo[:len(basis)]] + [Fr(1)]
            break
        piv = next(i for i, c in enumerate(vec) if c != 0)
        s = vec[piv]
        vec = [c / s for c in vec]
        newc = [Fr(0)] * (len(basis) + 1)
        for i, c in enumerate(combo): newc[i] = -c / s
        newc[len(basis)] = 1 / s
        basis.append((piv, vec, newc))
        if len(basis) > maxdeg: raise RuntimeError(f'degree above {maxdeg}')
        cur = mul(cur, alpha)
    m = len(basis)
    polys = []
    for t in targets:
        vec, combo = _reduce(basis, flat(t, K))
        if any(c != 0 for c in vec): return m, None
        # t = sum combo_i basis_i-original ; basis vectors are reduced forms, newc expresses reduced vector in powers
        coeffs = [Fr(0)] * m
        for idx, (piv, bv, bc) in enumerate(basis):
            pass
        polys.append(_expand(basis, flat(t, K), m))
    return m, (mpoly, polys)


def _expand(basis, vec, m):
    """Coefficients of vec in the powers 1, alpha, ..., alpha^(m-1)."""
    vec = list(vec); out = [Fr(0)] * m
    for idx, (piv, bv, bc) in enumerate(basis):
        c = vec[piv]
        if c != 0:
            for i in range(len(vec)):
                if bv[i] != 0: vec[i] -= c * bv[i]
            for i, w in enumerate(bc): out[i] += c * w
    assert all(x == 0 for x in vec)
    return out
