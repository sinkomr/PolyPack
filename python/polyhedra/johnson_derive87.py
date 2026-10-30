#!/usr/bin/env python3
"""Offline: J87 (augmented sphenocorona) = J86 with a square pyramid on one of its two squares, recentred. Reads the exact
J86 data of johnson_elementary.json, forms the apex at high precision and derives the exact data as johnson_derive.py does.
usage: JOHNSON_WORK=dir python3 johnson_derive87.py [digits]"""
import sys as _sys
_sys.set_int_max_str_digits(0)
import json, os, sys, time
from fractions import Fraction as Fr
import numpy as np
import mpmath as mp
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import johnson_derive as D
import johnson_geom as G


def j86_points(dps):
    mp.mp.dps = dps
    el = json.load(open(os.path.join(HERE, 'johnson_elementary.json')))['86']
    poly = [mp.mpf(int(c)) for c in el['minpoly']]
    lo, hi = [mp.mpf(Fr(c).numerator) / Fr(c).denominator for c in el['interval']]
    alpha = mp.findroot(lambda x: mp.polyval(poly[::-1], x), (lo + hi) / 2)
    ev = lambda cs: mp.fsum(mp.mpf(Fr(c).numerator) / Fr(c).denominator * alpha ** k for k, c in enumerate(cs))
    return [[ev(x) for x in v] for v in el['V']]


if __name__ == '__main__':
    dps = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    P = j86_points(dps)
    pts = np.array([[float(c) for c in p] for p in P])
    faces, normals, nv = G.hull(P) if False else (None, None, None)
    from scipy.spatial import ConvexHull
    h = ConvexHull(pts)
    groups = []
    for simp, eq in zip(h.simplices, h.equations):
        for g in groups:
            if np.allclose(g[0], eq, atol=1e-7): g[1].update(simp.tolist()); break
        else: groups.append([eq, set(simp.tolist())])
    squares = [sorted(vs) for eq, vs in groups if len(vs) == 4]
    assert len(squares) == 2
    done = False
    for sq in squares:
        cen = sum((np.array([P[i][k] for k in range(3)], dtype=object) for i in sq), np.zeros(3, dtype=object)) / 4
        a, b, c = [P[i] for i in sq[:3]]
        # normal through the face: cross of two edge vectors of the square (sq[0], sq[1], sq[2] may include a diagonal)
        u = [b[k] - a[k] for k in range(3)]; v = [c[k] - a[k] for k in range(3)]
        n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        ln = mp.sqrt(sum(x * x for x in n)); n = [x / ln for x in n]
        centroid = [sum(p[k] for p in P) / len(P) for k in range(3)]
        if sum(n[k] * (cen[k] - centroid[k]) for k in range(3)) < 0: n = [-x for x in n]
        apex = [cen[k] + mp.sqrt(mp.mpf(1) / 2) * n[k] for k in range(3)]
        Q = P + [apex]
        ok, cnt = G.analyze_float(np.array([[float(c) for c in p] for p in Q]))
        print('square', sq, 'valid', ok, cnt)
        if ok and not done:
            done = True; best = Q
    cen = [sum(p[k] for p in best) / len(best) for k in range(3)]
    best = [[p[k] - cen[k] for k in range(3)] for p in best]
    out, d = D.derive_from_points(best, dps, 'J87')
    json.dump(out, open(os.path.join(D.WORK, 'derived_J87.json'), 'w'))
    print(f'J87: field degree {d}')
