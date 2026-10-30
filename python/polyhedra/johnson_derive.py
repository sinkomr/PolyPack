#!/usr/bin/env python3
"""Offline: from refined coordinates of J84-J92 (johnson_refine.py) to exact data: the minimal polynomial of a primitive
element alpha of the coordinate field and every coordinate as a rational polynomial in alpha, found as integer relations
by LLL (python-flint, johnson_lll.py). Only a proposal: johnson.py proves the edge lengths, planarity, regularity and
convexity exactly in Q(alpha) before anything is stored.

usage: JOHNSON_WORK=dir python3 johnson_derive.py J     (reads refined_J<J>.json, writes derived_J<J>.json)
"""
import sys as _sys
_sys.set_int_max_str_digits(0)
import json, os, sys, time
from fractions import Fraction as Fr
import mpmath as mp
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import johnson_lll as L

WORK = os.environ.get('JOHNSON_WORK', '.')


def derive_from_points(pts, dps, label='', maxdeg=64):
    """pts: list of 3-lists of mpf at precision dps. Returns the JSON-ready dict."""
    mp.mp.dps = dps
    digits = dps - 40
    vals = [c for p in pts for c in p]
    uniq = []
    for v in vals:
        if abs(v) < mp.mpf(10) ** -(digits // 2): continue
        if all(abs(abs(v) - u) > mp.mpf(10) ** -(digits // 2) for u in uniq): uniq.append(abs(v))
    info = []
    for v in sorted(uniq, reverse=True):
        p = L.minpoly(v, maxdeg, digits)
        assert p is not None, f'{label}: a coordinate has degree above what {dps} digits can show'
        info.append((len(p) - 1, v, p))
        print(f'  {label} coordinate {mp.nstr(v, 8)} has degree {len(p) - 1}', flush=True)
    info.sort(key=lambda t: -t[0])
    from math import gcd
    deg, alpha, poly = info[0]
    d = deg
    degof = {mp.nstr(v, 40): dg for dg, v, p in info}
    while True:
        bad = None
        for dg, v, p in info:
            if d > 1 and L.express(v, alpha, d, digits) is None: bad = (dg, v); break
        if bad is None: break
        dgb, vb = bad
        lc = d * dgb // gcd(d, dgb)
        done = False
        for lam in (1, 2, 3, 5, 7, 11):
            na = alpha + lam * vb
            for n in range(lc, maxdeg + 1, lc):
                c = L.relation([na ** k for k in range(n + 1)], digits)
                if c is not None and c[n] != 0:
                    if c[n] < 0: c = [-x for x in c]
                    if L.express(alpha, na, n, digits) is not None and L.express(vb, na, n, digits) is not None:
                        alpha, poly, d, done = na, c, n, True
                    break
            if done: break
        assert done, f'{label}: field degree above {maxdeg} or more digits needed'
        print(f'  {label} alpha extended to degree {d}', flush=True)
    cache = {}
    coords = []
    for p in pts:
        row = []
        for v in p:
            if abs(v) < mp.mpf(10) ** -(digits // 2): row.append([Fr(0)] * d); continue
            key = mp.nstr(abs(v), 40)
            if key not in cache:
                e = L.express(abs(v), alpha, d, digits) if d > 1 else [Fr(int(mp.floor(abs(v) * 2 ** 80)), 2 ** 80)]
                assert e is not None, 'coordinate not in Q(alpha)'
                cache[key] = e
            e = cache[key]
            row.append(e if v > 0 else [-c for c in e])
        coords.append(row)
    s = 10 ** 60
    lo = Fr(int(mp.floor(alpha * s)) - 1, s); hi = Fr(int(mp.floor(alpha * s)) + 2, s)
    return {'minpoly': [str(c) for c in poly], 'interval': [str(lo), str(hi)],
            'V': [[[str(c) for c in x_] for x_ in row] for row in coords]}, d


if __name__ == '__main__':
    j = int(sys.argv[1])
    x = json.load(open(os.path.join(WORK, f'refined_J{j}.json')))
    dps = max(len(s) for s in x) + 10
    dps = int(sys.argv[2]) if len(sys.argv) > 2 else dps
    mp.mp.dps = dps
    x = [mp.mpf(s) for s in x]
    pts = [[x[3 * i + k] for k in range(3)] for i in range(len(x) // 3)]
    t0 = time.time()
    out, d = derive_from_points(pts, dps, f'J{j}')
    json.dump(out, open(os.path.join(WORK, f'derived_J{j}.json'), 'w'))
    print(f'J{j}: field degree {d}, {time.time() - t0:.0f}s')
