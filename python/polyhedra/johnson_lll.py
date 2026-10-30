"""Offline helpers for johnson_derive.py: integer relations by LLL (python-flint) instead of PSLQ."""
import sys as _sys
_sys.set_int_max_str_digits(0)
import mpmath as mp
from flint import fmpz_mat


def relation(vals, digits, bound_digits=None):
    """Small integer vector c with sum c_i vals_i ~ 0, or None. vals: mpf at precision > digits + 20."""
    n = len(vals)
    scale = mp.mpf(10) ** digits
    M = fmpz_mat(n, n + 1)
    for i, v in enumerate(vals):
        M[i, i] = 1
        M[i, n] = int(mp.floor(v * scale))
    L = M.lll()
    best = None
    for r in range(n):
        row = [int(L[r, c]) for c in range(n + 1)]
        c = row[:n]
        if all(x == 0 for x in c): continue
        val = abs(sum(ci * v for ci, v in zip(c, vals)))
        if max(map(abs, c)) < mp.mpf(10) ** (0.5 * digits / n) and val < mp.mpf(10) ** (-(digits * 3) // 4):
            if best is None or max(map(abs, c)) < max(map(abs, best)): best = c
        break
    return best


def minpoly(v, maxdeg, digits, start=1):
    for n in range(start, maxdeg + 1):
        c = relation([v ** k for k in range(n + 1)], digits)
        if c is not None and c[n] != 0:
            if c[n] < 0: c = [-x for x in c]
            return c
    return None


def express(v, alpha, d, digits):
    """Fractions c_k with v = sum c_k alpha^k (k < d), or None."""
    from fractions import Fraction as Fr
    c = relation([v] + [alpha ** k for k in range(d)], digits)
    if c is None or c[0] == 0: return None
    return [Fr(-x, c[0]) for x in c[1:]]
