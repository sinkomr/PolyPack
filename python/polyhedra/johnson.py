#!/usr/bin/env python3
"""Builds the 92 Johnson solids exactly at unit edge and writes them to solids_exact.json (offline tool; mpmath, numpy, scipy).

usage: python3 python/polyhedra/johnson.py [--write] [--only 1,5,84] [--no-symmetry]

J1-J83 are constructed here from pyramids, cupolae, the pentagonal rotunda, prisms and antiprisms and from the Platonic
and Archimedean solids (johnson_build.py, johnson_geom.py), in exact arithmetic in a tower of quadratic fields
(johnson_tower.py). J84-J92 are elementary (no such construction): their vertex sets come from johnson_elementary.json,
found offline by johnson_search.py / johnson_derive.py (a numerical solution of the unit-edge system for the solid's point
group, then the exact algebraic numbers). That data is not trusted: every solid, whatever its origin, is stored as
coordinates in Q(alpha) (alpha with an integer minimal polynomial and an isolating interval), and this script then proves
in exact arithmetic in that field
  - all vertices distinct, their centroid the origin;
  - every edge of every face has length exactly 1;
  - every face is planar, and a regular polygon (equilateral, convex, all vertices at one distance from the centre);
  - every face plane supports the solid strictly (all other vertices strictly inside), so the solid is strictly
    convex and its faces are exactly the listed ones; every edge is on exactly two faces (a closed surface);
  - V, E, F and the faces by number of sides equal the standard table (johnson_table.py, with its source);
and, as a floating-point cross-check of the construction, the order of the symmetry group of the vertex set.
The script fails on any mismatch.

Orientation and handedness: see docs/spaces/POLYHEDRA.md ("Johnson solids").
"""
import json
import os
import sys
import time
from fractions import Fraction as Fr
from math import gcd

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import algebraic as A  # noqa: E402
import johnson_build as B  # noqa: E402
import johnson_geom as G  # noqa: E402
import johnson_tower as jt  # noqa: E402
from johnson_prove import prove  # noqa: E402
from johnson_table import JOHNSON, sname  # noqa: E402

EXACT_JSON = os.path.join(HERE, 'solids_exact.json')
ELEMENTARY_JSON = os.path.join(HERE, 'johnson_elementary.json')

# ------------------------------------------------------------------------------------------------ the constructions
AX = {1: ['pyr4'], 2: ['pyr5'], 3: ['cup3'], 4: ['cup4'], 5: ['cup5'], 6: ['rot'],
      7: ['pyr3', 'prism'], 8: ['pyr4', 'prism'], 9: ['pyr5', 'prism'], 10: ['pyr4', 'antiprism'], 11: ['pyr5', 'antiprism'],
      12: ['pyr3', 'pyr3'], 13: ['pyr5', 'pyr5'], 14: ['pyr3', 'prism', 'pyr3'], 15: ['pyr4', 'prism', 'pyr4'],
      16: ['pyr5', 'prism', 'pyr5'], 17: ['pyr4', 'antiprism', 'pyr4'],
      18: ['cup3', 'prism'], 19: ['cup4', 'prism'], 20: ['cup5', 'prism'], 21: ['rot', 'prism'],
      22: ['cup3', 'antiprism'], 23: ['cup4', 'antiprism'], 24: ['cup5', 'antiprism'], 25: ['rot', 'antiprism'],
      26: ['wedge', 'wedge'], 27: ['cup3', 'cup3'], 28: ['cup4', 'cup4'], 29: ['cup4', 'cup4'], 30: ['cup5', 'cup5'],
      31: ['cup5', 'cup5'], 32: ['cup5', 'rot'], 33: ['cup5', 'rot'], 34: ['rot', 'rot'],
      35: ['cup3', 'prism', 'cup3'], 36: ['cup3', 'prism', 'cup3'], 37: ['cup4', 'prism', 'cup4'],
      38: ['cup5', 'prism', 'cup5'], 39: ['cup5', 'prism', 'cup5'], 40: ['cup5', 'prism', 'rot'],
      41: ['cup5', 'prism', 'rot'], 42: ['rot', 'prism', 'rot'], 43: ['rot', 'prism', 'rot'],
      44: ['cup3', 'antiprism', 'cup3'], 45: ['cup4', 'antiprism', 'cup4'], 46: ['cup5', 'antiprism', 'cup5'],
      47: ['cup5', 'antiprism', 'rot'], 48: ['rot', 'antiprism', 'rot']}
# 'ortho': the top polygons of the two end caps project onto the same points; 'gyro': they are turned against each other
WANT = {27: 'ortho', 28: 'ortho', 29: 'gyro', 30: 'ortho', 31: 'gyro', 32: 'ortho', 33: 'gyro', 34: 'ortho', 35: 'ortho',
        36: 'gyro', 37: 'gyro', 38: 'ortho', 39: 'gyro', 40: 'ortho', 41: 'gyro', 42: 'ortho', 43: 'gyro'}
GYROELONGATED_BICAPS = (44, 45, 46, 47, 48)    # chiral; the handedness +1 of johnson_build.handedness is stored
CASES = {
    49: lambda: B.j_prism(3, [0]), 50: lambda: B.j_prism(3, [0, 1]), 51: lambda: B.j_prism(3, [0, 1, 2]),
    52: lambda: B.j_prism(5, [0]), 53: lambda: B.j_prism(5, [0, 2]), 54: lambda: B.j_prism(6, [0]),
    55: lambda: B.j_prism(6, [0, 3]), 56: lambda: B.j_prism(6, [0, 2]), 57: lambda: B.j_prism(6, [0, 2, 4]),
    58: lambda: B.j_dodeca('one'), 59: lambda: B.j_dodeca('para'), 60: lambda: B.j_dodeca('meta'), 61: lambda: B.j_dodeca('tri'),
    62: lambda: B.j_dim_icosa('meta'), 63: lambda: B.j_dim_icosa('tri'), 64: lambda: B.j_dim_icosa('tri', True),
    65: lambda: B.j_trunc('tt', 'cupola', 6, 'one'), 66: lambda: B.j_trunc('tc', 'cupola', 8, 'one'),
    67: lambda: B.j_trunc('tc', 'cupola', 8, 'para'), 68: lambda: B.j_trunc('td', 'cupola', 10, 'one'),
    69: lambda: B.j_trunc('td', 'cupola', 10, 'para'), 70: lambda: B.j_trunc('td', 'cupola', 10, 'meta'),
    71: lambda: B.j_trunc('td', 'cupola', 10, 'tri'),
    72: lambda: B.j_rid(None, ('one', ['gyro'])), 73: lambda: B.j_rid(None, ('para', ['gyro', 'gyro'])),
    74: lambda: B.j_rid(None, ('meta', ['gyro', 'gyro'])), 75: lambda: B.j_rid(None, ('tri', ['gyro'] * 3)),
    76: lambda: B.j_rid(None, ('one', ['dim'])), 77: lambda: B.j_rid(None, ('para', ['dim', 'gyro'])),
    78: lambda: B.j_rid(None, ('meta', ['dim', 'gyro'])), 79: lambda: B.j_rid(None, ('tri', ['dim', 'gyro', 'gyro'])),
    80: lambda: B.j_rid(None, ('para', ['dim', 'dim'])), 81: lambda: B.j_rid(None, ('meta', ['dim', 'dim'])),
    82: lambda: B.j_rid(None, ('tri', ['dim', 'dim', 'gyro'])), 83: lambda: B.j_rid(None, ('tri', ['dim'] * 3)),
}
# order of the full symmetry group (rotations and reflections) of each solid, from Johnson's table of point groups
SYMMETRY_ORDER = {
    1: 8, 2: 10, 3: 6, 4: 8, 5: 10, 6: 10, 7: 6, 8: 8, 9: 10, 10: 8, 11: 10, 12: 12, 13: 20, 14: 12, 15: 16, 16: 20, 17: 16,
    18: 6, 19: 8, 20: 10, 21: 10, 22: 6, 23: 8, 24: 10, 25: 10, 26: 8, 27: 12, 28: 16, 29: 16, 30: 20, 31: 20, 32: 10, 33: 10,
    34: 20, 35: 12, 36: 12, 37: 16, 38: 20, 39: 20, 40: 10, 41: 10, 42: 20, 43: 20, 44: 6, 45: 8, 46: 10, 47: 5, 48: 10,
    49: 4, 50: 4, 51: 12, 52: 4, 53: 4, 54: 4, 55: 8, 56: 4, 57: 12, 58: 10, 59: 20, 60: 4, 61: 6, 62: 4, 63: 6, 64: 6,
    65: 6, 66: 8, 67: 16, 68: 10, 69: 20, 70: 4, 71: 6, 72: 10, 73: 20, 74: 4, 75: 6, 76: 10, 77: 10, 78: 2, 79: 2, 80: 20,
    81: 4, 82: 2, 83: 6, 84: 8, 85: 16, 86: 4, 87: 2, 88: 4, 89: 4, 90: 8, 91: 8, 92: 6}


def build_tower(j):
    """Exact vertices of J<j> (j <= 83), centred at the vertex centroid and oriented, as tuples of tower elements."""
    jt.reset()
    if j in AX:
        res = B.build_axial(AX[j], WANT.get(j))
        if j in GYROELONGATED_BICAPS: res = [r for r in res if r[5] == 1]
        assert res, j
        return B.centred(res[0][0])
    return CASES[j]()


# ------------------------------------------------------------------------------------------------ exact data
def integer_poly(p):
    """Primitive integer polynomial (low degree first) proportional to p."""
    den = 1
    for c in p: den = den * c.denominator // gcd(den, c.denominator)
    ip = [int(c * den) for c in p]
    g = 0
    for c in ip: g = gcd(g, abs(c))
    return [c // g for c in ip]


def isolating_interval(poly, alpha, digits=50):
    """A rational interval [lo, hi] around alpha containing no other root of poly."""
    import mpmath as mp
    s = 10 ** digits
    lo = Fr(int(mp.floor(alpha * s)) - 1, s)
    hi = Fr(int(mp.floor(alpha * s)) + 2, s)
    assert A.sturm_count([Fr(c) for c in poly], lo, hi) == 1, 'interval does not isolate a root'
    return lo, hi


def entry_from_coordinates(minpoly, interval, coords):
    """coords: for each vertex three coefficient lists of Fractions. Returns the (unfinished) JSON entry."""
    d = len(minpoly) - 1
    V = [[[str(c) for c in (list(x) + [Fr(0)] * d)[:d]] for x in v] for v in coords]
    return {'minpoly': [str(c) for c in minpoly], 'interval': [str(interval[0]), str(interval[1])], 'D': None, 'V': V}


def faces_of(entry):
    """Faces of the solid, counter-clockwise from outside, from a 100-digit evaluation of the coordinates."""
    import mpmath as mp
    mp.mp.dps = 80
    lo, hi = Fr(entry['interval'][0]), Fr(entry['interval'][1])
    poly = [mp.mpf(Fr(c).numerator) / Fr(c).denominator for c in entry['minpoly']]
    f = lambda x: mp.fsum(c * x ** k for k, c in enumerate(poly))
    a, b = mp.mpf(lo.numerator) / lo.denominator, mp.mpf(hi.numerator) / hi.denominator
    fa = f(a)
    for _ in range(300):
        m = (a + b) / 2; fm = f(m)
        if (fm > 0) == (fa > 0): a, fa = m, fm
        else: b = m
    alpha = (a + b) / 2
    pts = [[float(mp.fsum(mp.mpf(Fr(c).numerator) / Fr(c).denominator * alpha ** k for k, c in enumerate(x))) for x in v] for v in entry['V']]
    from scipy.spatial import ConvexHull
    pts = np.array(pts)
    h = ConvexHull(pts)
    assert len(h.vertices) == len(pts), 'a vertex is not extreme'
    groups = []
    for simp, eq in zip(h.simplices, h.equations):
        for g in groups:
            if np.allclose(g[0], eq, atol=1e-7): g[1].update(simp.tolist()); break
        else: groups.append([eq, set(simp.tolist())])
    faces = []
    for eq, vs in groups:
        nrm = eq[:3]; vs = sorted(vs); cen = pts[vs].mean(axis=0)
        u = pts[vs[0]] - cen; u -= nrm * np.dot(u, nrm); u /= np.linalg.norm(u); v = np.cross(nrm, u)
        ang = [np.arctan2(np.dot(pts[i] - cen, v), np.dot(pts[i] - cen, u)) for i in vs]
        faces.append([int(i) for _, i in sorted(zip(ang, vs))])
    faces.sort(key=lambda f: (len(f), f))
    return faces, pts


# ------------------------------------------------------------------------------------------------ symmetry (floating point)
def symmetry_order(pts, tol=1e-7):
    """Order of the group of isometries (rotations and reflections) that map the vertex set to itself."""
    pts = np.array(pts, dtype=float)
    n = len(pts)
    D = np.linalg.norm(pts[:, None] - pts[None], axis=2)
    # three affinely independent reference vertices a, b, c (+ d off their plane)
    a = 0
    b = int(np.argmax(D[a]))
    cc = max(range(n), key=lambda i: np.linalg.norm(np.cross(pts[b] - pts[a], pts[i] - pts[a])))
    nrm = np.cross(pts[b] - pts[a], pts[cc] - pts[a])
    d = max(range(n), key=lambda i: abs(np.dot(nrm, pts[i] - pts[a])))
    ref = [a, b, cc, d]
    count = 0
    for ia in range(n):
        for ib in range(n):
            if abs(D[ia, ib] - D[a, b]) > tol: continue
            for ic in range(n):
                if abs(D[ia, ic] - D[a, cc]) > tol or abs(D[ib, ic] - D[b, cc]) > tol: continue
                for idd in range(n):
                    if (abs(D[ia, idd] - D[a, d]) > tol or abs(D[ib, idd] - D[b, d]) > tol or abs(D[ic, idd] - D[cc, d]) > tol): continue
                    Rm = pts[[ia, ib, ic, idd]] - pts[ia]
                    Sm = pts[ref] - pts[a]
                    # least squares map Sm -> Rm (Sm has rank 3)
                    M, *_ = np.linalg.lstsq(Sm[1:], Rm[1:], rcond=None)
                    img = (pts - pts[a]) @ M + pts[ia]
                    dd = np.linalg.norm(img[:, None] - pts[None], axis=2).min(axis=1)
                    if dd.max() < 1e-5 and abs(abs(np.linalg.det(M)) - 1) < 1e-6: count += 1
    return count


# ------------------------------------------------------------------------------------------------ driver
def solid_entry(j):
    """(entry, checks, floats) of J<j>, exactly proved."""
    if j <= 83:
        P = build_tower(j)
        vals = [c for p in P for c in p]
        mpoly, polys, alpha = jt.primitive(vals)
        poly = integer_poly(mpoly)
        coords = [[polys[3 * i + k] for k in range(3)] for i in range(len(P))]
    else:
        el = json.load(open(ELEMENTARY_JSON))[str(j)]
        poly = [int(c) for c in el['minpoly']]
        coords = [[[Fr(c) for c in x] for x in v] for v in el['V']]
        import mpmath as mp
        mp.mp.dps = 80
        alpha = mp.mpf(Fr(el['interval'][0]).numerator) / Fr(el['interval'][0]).denominator
    lo, hi = isolating_interval(poly, alpha) if j <= 83 else (Fr(el['interval'][0]), Fr(el['interval'][1]))
    entry = entry_from_coordinates([Fr(c) for c in poly], (lo, hi), coords)
    faces, pts = faces_of(entry)
    entry['faces'] = faces
    entry['checks'] = prove(j, entry)
    return entry, pts


def main():
    args = sys.argv[1:]
    only = None
    if '--only' in args: only = [int(x) for x in args[args.index('--only') + 1].split(',')]
    write = '--write' in args
    check_sym = '--no-symmetry' not in args
    out = {}
    for j in (only or range(1, 93)):
        if j >= 84 and not os.path.exists(ELEMENTARY_JSON): print(f'J{j}: {ELEMENTARY_JSON} missing, skipped'); continue
        if j >= 84 and str(j) not in json.load(open(ELEMENTARY_JSON)): print(f'J{j}: no data yet, skipped'); continue
        t = time.time()
        entry, pts = solid_entry(j)
        sym = symmetry_order(pts) if check_sym else None
        if check_sym: assert sym == SYMMETRY_ORDER[j], f'J{j}: symmetry group of order {sym}, expected {SYMMETRY_ORDER[j]}'
        out[j] = entry
        print(f'J{j:<2} {JOHNSON[j][0]:46s} field degree {len(entry["minpoly"]) - 1:3d}  |G|={sym}  proved in {time.time() - t:.1f}s', flush=True)
    if write:
        text = open(EXACT_JSON).read()
        existing = json.loads(text)
        names = {sname(j): j for j in out}
        assert not (set(names) & set(existing)), 'already present'
        add = ''.join(', ' + json.dumps(sname(j)) + ': ' + json.dumps(out[j]) for j in sorted(out))
        assert text.rstrip().endswith('}}')
        text = text.rstrip()[:-1] + add + '}'
        json.loads(text)
        open(EXACT_JSON, 'w').write(text)
        print('wrote', len(out), 'solids to', EXACT_JSON)


if __name__ == '__main__':
    main()
