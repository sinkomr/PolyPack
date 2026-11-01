#!/usr/bin/env python3
"""Generator of the exact nD catalogue (needs numpy and scipy; the committed outputs need neither).

usage: python3 python/ndim/gen_catalogue.py [--only code,code] [--no-ts]     (then: npx prettier --write packages/ndim/src/data)

Writes catalogue_exact.json (exact vertices and H-representations, see catalogue.py) and the float data modules
packages/ndim/src/data/*.ts. Every entry is checked by catalogue.verify before it is written: the build fails unless
the vertex, edge and facet counts are the literature's, all edges are exactly 1, and the polytope is convex with an
exact, complete facet list. Facets of the simplex, hypercube, orthoplex and demicube are written down (they have too
many simplices for a convex hull program in 10D); the others come from Qhull (scipy) and are then solved and proven in
exact integer or Q(sqrt5) arithmetic.

Constructions (unit edge, then centred at the vertex centroid):
  simplex   the vertices e_j / sqrt2 of R^(d+1) in the orthonormal basis (1,..,1,-k,0,..) / sqrt(k(k+1)) of the hyperplane
  cube      (+-1/2)^d
  ortho     +-e_i / sqrt2
  demicube  the vertices (+-1)^d with an even number of minus signs, divided by 2 sqrt2 (edge sqrt8 -> 1)
  24-cell   the 8 permutations of (+-2,0,0,0) and the 16 points (+-1)^4, divided by 2
  120-/600-cell  the standard coordinates in Q(sqrt5) (Coxeter), scaled to unit edge
  2_21, 1_22, 3_21, 4_21  roots of E8 (the 240 vectors of norm 2: (+-1,+-1,0^6) permutations and (+-1/2)^8 with an even
            number of minus signs, here doubled to integers): 4_21 is the 240 roots; 3_21 the 56 roots r with
            r.rho = 1 for a root rho, projected to rho-perp (r - rho/2); 2_21 the 27 roots with r.a = 1, r.b = 0 for roots
            a, b with a.b = -1, projected to {a, b}-perp (r - (2a + b)/3); 1_22 the 72 roots orthogonal to a and b.
            Their span gets an orthogonal rational basis by Gram-Schmidt, which gives the axis form."""
import argparse
import itertools
import json
import math
import os
import sys
import time
from fractions import Fraction as Fr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.append(os.path.join(os.path.dirname(HERE), 'polyhedra'))
import catalogue as C  # noqa: E402
import exact as X  # noqa: E402
import multiquad as MQM  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
TS_DIR = os.path.join(ROOT, 'packages', 'ndim', 'src', 'data')
VERSION = 1


# ------------------------------------------------------------------ axis form from rational points
def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def gram_schmidt(vecs):
    """Orthogonal (not normalised) rational basis of the span of vecs, in order; dependent vectors are skipped."""
    basis = []
    for v in vecs:
        w = list(v)
        for u in basis:
            f = dot(w, u) / dot(u, u)
            if f:
                w = [x - f * y for x, y in zip(w, u)]
        if any(w):
            basis.append(w)
    return basis


def axis_entry(code, points, e2, basis=None):
    """Axis form of rational points (native coordinates), after centring and scaling by 1/sqrt(e2) (e2: native edge^2)."""
    n = len(points)
    D = len(points[0])
    cen = [sum(p[i] for p in points) / n for i in range(D)]
    pts = [[Fr(p[i]) - cen[i] for i in range(D)] for p in points]
    if basis is None:
        basis = gram_schmidt(pts)
    d = len(basis)
    rad, q = [], [[None] * d for _ in range(n)]
    for k, u in enumerate(basis):
        f, r = X.sqrt_split(dot(u, u) * Fr(e2))          # |u| sqrt(e2) = f sqrt(r)
        rad.append(r)
        for i, p in enumerate(pts):
            q[i][k] = dot(p, u) / (f * r)                # coordinate along u/|u|, over sqrt(e2): (p.u)/(f sqrt r) = (p.u)/(f r) sqrt r
    den = 1
    for row in q:
        for x in row:
            den = X.lcm(den, x.denominator)
    V = [[int(x * den) for x in row] for row in q]
    return {'code': code, 'd': d, 'form': 'axis', 'den': den, 'rad': rad, 'V': V}


def min_dist2(points):
    return min(sum((a - b) ** 2 for a, b in zip(p, r)) for p, r in itertools.combinations(points, 2))


# ------------------------------------------------------------------ families
def signs(d):
    return itertools.product((1, -1), repeat=d)


def simplex(d):
    pts = [[Fr(int(i == j)) for i in range(d + 1)] for j in range(d + 1)]
    basis = [[Fr(1)] * k + [Fr(-k)] + [Fr(0)] * (d - k) for k in range(1, d + 1)]
    return axis_entry(f'{d}:simplex', pts, 2, basis)


def cube(d):
    return {'code': f'{d}:cube', 'd': d, 'form': 'axis', 'den': 2, 'rad': [1] * d, 'V': [list(s) for s in signs(d)]}


def ortho(d):
    V = []
    for i in range(d):
        for s in (1, -1):
            V.append([s if k == i else 0 for k in range(d)])
    return {'code': f'{d}:ortho', 'd': d, 'form': 'axis', 'den': 2, 'rad': [2] * d, 'V': V}


def demi(d):
    V = [list(s) for s in signs(d) if s.count(-1) % 2 == 0]
    return {'code': f'{d}:demi', 'd': d, 'form': 'axis', 'den': 4, 'rad': [2] * d, 'V': V}


def cell24():
    V = []
    for i in range(4):
        for s in (2, -2):
            V.append([s if k == i else 0 for k in range(4)])
    V += [list(s) for s in signs(4)]
    return {'code': '4:24cell', 'd': 4, 'form': 'axis', 'den': 2, 'rad': [1] * 4, 'V': V}


def e8_roots():
    R = []
    for i, j in itertools.combinations(range(8), 2):
        for si in (2, -2):
            for sj in (2, -2):
                v = [0] * 8
                v[i], v[j] = si, sj
                R.append(v)
    for s in signs(8):
        if s.count(-1) % 2 == 0:
            R.append(list(s))
    assert len(R) == 240
    return [[Fr(x, 2) for x in r] for r in R]               # norm 2


def e_polytopes():
    R = e8_roots()
    out = {}
    out['8:421'] = axis_entry('8:421', R, 2)
    rho = R[0]
    p321 = [[x - y / 2 for x, y in zip(r, rho)] for r in R if dot(r, rho) == 1]
    out['7:321'] = axis_entry('7:321', p321, 2)
    a = R[0]
    b = next(r for r in R if dot(a, r) == -1)
    om = [(2 * x + y) / 3 for x, y in zip(a, b)]
    p221 = [[x - y for x, y in zip(r, om)] for r in R if dot(r, a) == 1 and dot(r, b) == 0]
    out['6:221'] = axis_entry('6:221', p221, 2)
    p122 = [r for r in R if dot(r, a) == 0 and dot(r, b) == 0]
    out['6:122'] = axis_entry('6:122', p122, 2)
    for k, ent in out.items():
        assert len(ent['V']) == C.LITERATURE[k][0], (k, len(ent['V']))
    return out


# ---- 120- and 600-cell over Q(sqrt5)
S5 = MQM.MQ.sqrt(5)
PHI = (1 + S5) / 2
MQ = MQM.MQ


def even_perms(n):
    out = []
    for p in itertools.permutations(range(n)):
        inv = sum(1 for i in range(n) for j in range(i + 1, n) if p[i] > p[j])
        if inv % 2 == 0:
            out.append(p)
    return out


def cell600_points():
    h = MQ(Fr(1, 2))
    P = []
    for i in range(4):
        for s in (1, -1):
            P.append([MQ(s) if k == i else MQ(0) for k in range(4)])
    for s in signs(4):
        P.append([h * s[k] for k in range(4)])
    base = [PHI / 2, h, 1 / (2 * PHI), MQ(0)]
    for perm in even_perms(4):
        for s in signs(3):
            vals = [base[perm[k]] for k in range(4)]
            sg = iter(s)
            P.append([(v if v.sign() == 0 else v * next(sg)) for v in vals])
    return [[x * PHI for x in p] for p in P]                 # circumradius 1 has edge 1/phi: scale to edge 1


def cell120_points():
    r5 = S5
    i1, i2 = 1 / PHI, 1 / (PHI * PHI)
    P = []
    for i, j in itertools.combinations(range(4), 2):         # (0,0,+-2,+-2) permutations
        for si in (2, -2):
            for sj in (2, -2):
                v = [MQ(0)] * 4
                v[i], v[j] = MQ(si), MQ(sj)
                P.append(v)

    def all_perm_signs(vals):
        seen = set()
        for perm in itertools.permutations(range(4)):
            for s in signs(4):
                v = tuple(vals[perm[k]] * s[k] for k in range(4))
                key = tuple(repr(x) for x in v)
                if key not in seen:
                    seen.add(key)
                    P.append(list(v))
    all_perm_signs([MQ(1), MQ(1), MQ(1), r5])
    all_perm_signs([i2, PHI, PHI, PHI])
    all_perm_signs([i1, i1, i1, PHI * PHI])

    def even_signed(vals):
        seen = set()
        for perm in even_perms(4):
            for s in signs(4):
                v = tuple(vals[perm[k]] * s[k] for k in range(4))
                key = tuple(repr(x) for x in v)
                if key not in seen:
                    seen.add(key)
                    P.append(list(v))
    even_signed([MQ(0), i2, MQ(1), PHI * PHI])
    even_signed([MQ(0), i1, PHI, r5])
    even_signed([i1, MQ(1), PHI, MQ(2)])
    scale = PHI * PHI / 2                                    # edge 2/phi^2 -> 1
    return [[x * scale for x in p] for p in P]


def q5_entry(code, pts):
    """q5 form of points with coordinates in Q(sqrt5), centred (they are symmetric)."""
    den = 1
    for p in pts:
        for x in p:
            assert set(x.c) <= {1, 5}
            for c in x.c.values():
                den = X.lcm(den, Fr(c).denominator)
    V = []
    for p in pts:
        row = []
        for x in p:
            row += [int(x.c.get(1, 0) * den), int(x.c.get(5, 0) * den)]
        V.append(row)
    for k in range(len(V[0])):
        assert sum(v[k] for v in V) == 0, 'not centred'
    return {'code': code, 'd': 4, 'form': 'q5', 'den': den, 'V': V}


# ------------------------------------------------------------------ facets
def hyperplane_exact(Vint, idxs):
    """Primitive integer (n, b) with n . V_i = b for the vertices idxs, oriented so that b > 0."""
    rows = [[a - b for a, b in zip(Vint[i], Vint[idxs[0]])] for i in idxs[1:]]
    n = X.nullvec(rows)
    assert n is not None, 'degenerate facet'
    n = X.primitive(n)
    b = dot(n, Vint[idxs[0]])
    if b < 0:
        n, b = [-x for x in n], -b
    assert b > 0
    return n + [b]


def facets_analytic(e):
    code, d = e['code'], e['d']
    kind = code.split(':')[1]
    F = []
    if kind == 'cube':
        for i in range(d):
            for s in (1, -1):
                F.append([s if k == i else 0 for k in range(d)] + [1])
    elif kind == 'ortho':
        for s in signs(d):
            F.append(list(s) + [1])
    elif kind == 'demi':
        for s in signs(d):
            if s.count(-1) % 2 == 1:
                F.append(list(s) + [d - 2])
        for i in range(d):
            for s in (1, -1):
                F.append([s if k == i else 0 for k in range(d)] + [1])
    elif kind == 'simplex':
        V = e['V']
        for j in range(d + 1):
            F.append(hyperplane_exact(V, [i for i in range(d + 1) if i != j]))
    return F


def real_coords(e):
    """Float vertex coordinates (actual space) from the exact entry."""
    P = C.Polytope(dict(e, F=[]))
    return P.vertices_float()


def facets_qhull(e):
    import numpy as np
    from scipy.spatial import ConvexHull
    d = e['d']
    Vf = np.array(real_coords(e))
    hull = ConvexHull(Vf)
    seen = {}
    for eq in hull.equations:
        n, off = eq[:d], -eq[d]
        on = np.flatnonzero(np.abs(Vf @ n - off) < 1e-8)
        seen.setdefault(tuple(on.tolist()), None)
    sets = list(seen)
    if e['form'] == 'axis':
        F = [hyperplane_exact(e['V'], list(s)) for s in sets]
    else:
        F = [hyperplane_q5(e, list(s)) for s in sets]
    return F, float(hull.volume)


def hyperplane_q5(e, idxs):
    """Facet [p1,q1,...,pd,qd,r,s] through vertices idxs, exactly over Q(sqrt5)."""
    d, den = e['d'], e['den']
    Xv = [[MQ(Fr(v[2 * k], 1)) + MQ(_mq5(Fr(v[2 * k + 1]))) for k in range(d)] for v in e['V']]
    # elimination over the field with MQ elements
    base = Xv[idxs[0]]
    rows = [[a - b for a, b in zip(Xv[i], base)] for i in idxs[1:]]
    r = 0
    piv = []
    for c in range(d):
        p = next((i for i in range(r, len(rows)) if rows[i][c].sign() != 0), None)
        if p is None:
            continue
        rows[r], rows[p] = rows[p], rows[r]
        iv = rows[r][c].inv()
        rows[r] = [x * iv for x in rows[r]]
        for i in range(len(rows)):
            if i != r and rows[i][c].sign() != 0:
                f = rows[i][c]
                rows[i] = [x - f * y for x, y in zip(rows[i], rows[r])]
        piv.append(c)
        r += 1
    free = [c for c in range(d) if c not in piv]
    assert len(free) == 1, 'degenerate q5 facet'
    n = [MQ(0)] * d
    n[free[0]] = MQ(1)
    for i, c in enumerate(piv):
        n[c] = -rows[i][free[0]]
    b = sum((x * y for x, y in zip(n, base)), MQ(0))
    if b.sign() < 0:
        n, b = [-x for x in n], -b
    # clear denominators: all coefficients over Q
    L = 1
    for x in n + [b]:
        for c in x.c.values():
            L = X.lcm(L, Fr(c).denominator)
    g = 0
    flat = []
    for x in n:
        flat += [int(x.c.get(1, 0) * L), int(x.c.get(5, 0) * L)]
    flat += [int(b.c.get(1, 0) * L), int(b.c.get(5, 0) * L)]
    for x in flat:
        g = math.gcd(g, abs(x))
    return [x // g for x in flat]


def _mq5(c):
    """The element c * sqrt5 as an MQ."""
    return MQ(_c={5: c}) if c else MQ(0)


# note: offsets of q5 facets are relative to the integer-coordinate vertices X = x * den: m . X = r + s sqrt5.
# hyperplane_q5 above works with the coordinates (a + b sqrt5) = X_k, so b computed there is m . X directly.


def volume_closed(code, d):
    kind = code.split(':')[1]
    if kind == 'simplex':
        return math.sqrt(d + 1) / (math.factorial(d) * 2 ** (d / 2))
    if kind == 'cube':
        return 1.0
    if kind == 'ortho':
        return 2 ** (d / 2) / math.factorial(d)
    if kind == 'demi':
        return (2 ** d - 2 ** (d - 1) * 2 ** d / math.factorial(d)) / (2 * math.sqrt(2)) ** d
    return None


# ------------------------------------------------------------------ build
def build(only=None):
    ents = {}
    for d in range(4, 11):
        ents[f'{d}:simplex'] = simplex(d)
        ents[f'{d}:cube'] = cube(d)
        ents[f'{d}:ortho'] = ortho(d)
        if d >= 5:
            ents[f'{d}:demi'] = demi(d)
    ents['4:24cell'] = cell24()
    p600 = cell600_points()
    ents['4:600cell'] = q5_entry('4:600cell', p600)
    ents['4:120cell'] = q5_entry('4:120cell', cell120_points())
    ents.update(e_polytopes())
    order = sorted(ents, key=lambda c: (ents[c]['d'], c))
    out, vols = [], {}
    for code in order:
        if only and code not in only:
            continue
        t0 = time.time()
        e = ents[code]
        kind = code.split(':')[1]
        if kind in ('simplex', 'cube', 'ortho', 'demi'):
            F, vol = facets_analytic(e), volume_closed(code, e['d'])
        else:
            F, vol = facets_qhull(e)
        e['F'] = sorted(F)
        e['name'] = kind
        e['title'] = f"{e['d']}D " + C.TITLES[kind]
        res = C.verify(e)
        e['nV'], e['nE'], e['nF'] = res['V'], res['E'], res['F']
        e['volume'] = vol
        out.append(e)
        print(f"{code:10s} V={res['V']:5d} E={res['E']:5d} F={res['F']:6d}  verified in {time.time() - t0:.1f}s", flush=True)
    return out


def finish_volumes(entries):
    """Closed forms where known, otherwise Qhull's; cross-checks both for the entries that have both."""
    import numpy as np
    from scipy.spatial import ConvexHull
    for e in entries:
        kind = e['code'].split(':')[1]
        cf = volume_closed(e['code'], e['d'])
        if cf is None:
            continue
        if e['d'] <= 6 and e['volume'] is not None:
            vq = ConvexHull(np.array(real_coords(e))).volume
            assert abs(vq - cf) < 1e-9 * max(1.0, cf), (e['code'], vq, cf)


def write_json(entries, path=C.DATA):
    doc = {'version': VERSION, 'codes': [e['code'] for e in entries],
           'polytopes': [{k: v for k, v in e.items() if k != 'volume'} for e in entries],
           'volumes': {e['code']: e['volume'] for e in entries}}
    with open(path, 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
        f.write('\n')


def fnum(x):
    x = float(x)
    if x == 0:
        return '0'
    return repr(x)


def write_ts(entries):
    os.makedirs(TS_DIR, exist_ok=True)
    by_d = {}
    for e in entries:
        by_d.setdefault(e['d'], []).append(e)
    head = ('// Generated by python/ndim/gen_catalogue.py from catalogue_exact.json (exact vertices and facets evaluated at\n'
            '// 170 bits and rounded to binary64). Do not edit by hand.\n\n')
    for d, es in sorted(by_d.items()):
        lazy = [e for e in es if e['code'] == '8:421']
        keep = [e for e in es if e['code'] != '8:421']
        write_module(os.path.join(TS_DIR, f'd{d}.ts'), head, keep, f'D{d}')
        for e in lazy:
            write_module(os.path.join(TS_DIR, 'd8-421.ts'), head, [e], 'D8_421', default=True)
    write_info(entries, head)


def entry_ts(e):
    P = C.Polytope(e)
    N, b = P.facets_float()
    s = ['  {', f'    code: "{e["code"]}",']
    s.append('    V: [' + ','.join(fnum(c) for v in P.vertices_float() for c in v) + '],')
    s.append('    N: [' + ','.join(fnum(c) for n in N for c in n) + '],')
    s.append('    b: [' + ','.join(fnum(c) for c in b) + '],')
    s.append('  },')
    return '\n'.join(s)


def info_ts(e):
    P = C.Polytope(e)
    V = P.vertices_float()
    b = P.facets_float()[1]
    circ = max(math.sqrt(sum(c * c for c in v)) for v in V)
    return (f'  {{ code: "{e["code"]}", d: {e["d"]}, name: "{e["name"]}", title: "{e["title"]}", nV: {len(V)}, nE: {e["nE"]}, '
            f'nF: {len(b)}, inradius: {fnum(min(b))}, circumradius: {fnum(circ)}, volume: {fnum(e["volume"])} }},')


def write_module(path, head, es, name, default=False):
    body = head + 'import type { PolytopeData } from "../polytope";\n\n'
    body += f'export const {name}: PolytopeData[] = [\n' + '\n'.join(entry_ts(e) for e in es) + '\n];\n'
    if default:
        body += f'\nexport default {name}[0];\n'
    with open(path, 'w') as f:
        f.write(body)


def write_info(entries, head):
    body = head + 'import type { PolytopeInfo } from "../polytope";\n\n'
    body += 'export const INFO: PolytopeInfo[] = [\n' + '\n'.join(info_ts(e) for e in entries) + '\n];\n'
    with open(os.path.join(TS_DIR, 'info.ts'), 'w') as f:
        f.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only')
    ap.add_argument('--no-ts', action='store_true')
    a = ap.parse_args()
    only = set(a.only.split(',')) if a.only else None
    entries = build(only)
    finish_volumes(entries)
    if only:
        print('partial run: nothing written')
        return
    write_json(entries)
    if not a.no_ts:
        write_ts(entries)
    print(f'{len(entries)} polytopes written')


if __name__ == '__main__':
    main()
