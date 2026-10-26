#!/usr/bin/env python3
"""Writes packages/polyhedra/src/solids.data.ts from solids_exact.json (offline tool; needs mpmath).

solids_exact.json holds upstream's 56 solids, copied unchanged from alejandrozu/platonic-packing (MIT, commit
cbf76f2f, file src/solids_exact.json; see THIRD_PARTY_NOTICES.md), followed by PolyPack's 18 bipyramids and
trapezohedra in the same format (docs/spaces/POLYHEDRA.md, section 1). Each solid's vertex coordinates are elements of
a number field Q(alpha), given by alpha's minimal polynomial and an isolating interval, times lambda = 1/sqrt(D) for
the snub solids and their duals. This tool evaluates them at 100 significant digits (the coefficients of the degree-20
field of the hendecagonal trapezohedron cancel by about 15, so 60 would not do) and writes, per solid:

  V        vertices rounded to the nearest binary64 (the canonical solid, centred at the origin);
  faces    vertex cycles ordered counter-clockwise seen from outside (so (v1 - v0) x (v2 - v0) points out);
  normals  unit outward face normals, rounded to binary64;
  offsets  face offsets b_f = n_f . v for v on face f (the face plane is n_f . x = b_f), rounded;
  edges    vertex pairs [i, j] with i < j;
  inradius = min b_f, circumradius = max |v|, volume (all rounded from the 100-digit values).

Usage: python3 python/polyhedra/gen_solids.py [solids_exact.json] [out.ts]
"""
import json
import os
import sys
from fractions import Fraction

import mpmath as mp

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
mp.mp.dps = 100

sys.path.insert(0, HERE)
from catalogue import solids as catalogue  # noqa: E402


def root_in(poly, lo, hi):
    """The root of the integer polynomial (low degree first) in [lo, hi], by bisection to the working precision."""
    p = [mp.mpf(Fraction(c).numerator) / Fraction(c).denominator for c in poly]
    f = lambda x: mp.fsum(c * x ** k for k, c in enumerate(p))
    a, b = mp.mpf(lo.numerator) / lo.denominator, mp.mpf(hi.numerator) / hi.denominator
    fa = f(a)
    if len(p) == 2:                       # linear: alpha is rational
        return -p[0] / p[1]
    for _ in range(4 * mp.mp.dps):
        m = (a + b) / 2
        fm = f(m)
        if fm == 0:
            return m
        if (fm > 0) == (fa > 0):
            a, fa = m, fm
        else:
            b = m
        if b - a < mp.mpf(10) ** (2 - mp.mp.dps):
            break
    return (a + b) / 2


def q(c):
    fr = Fraction(c)
    return mp.mpf(fr.numerator) / fr.denominator


def evaluate(d):
    lo, hi = Fraction(d['interval'][0]), Fraction(d['interval'][1])
    alpha = root_in(d['minpoly'], lo, hi)
    def val(coeffs):
        # the coefficient representation is unique, so an element is zero iff all its coefficients are
        if all(Fraction(c) == 0 for c in coeffs):
            return mp.mpf(0)
        return mp.fsum(q(c) * alpha ** k for k, c in enumerate(coeffs))
    lam = mp.mpf(1) if not d['D'] else 1 / mp.sqrt(val(d['D']))
    return [[val(c) * lam for c in v] for v in d['V']]


def sub(a, b): return [x - y for x, y in zip(a, b)]
def dot(a, b): return mp.fsum(x * y for x, y in zip(a, b))
def cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def build(name, d):
    V = evaluate(d)
    faces, normals, offsets = [], [], []
    for f in d['faces']:
        a, b, c = V[f[0]], V[f[1]], V[f[2]]
        m = cross(sub(b, a), sub(c, a))
        if dot(m, a) < 0:                 # the solid is centred at the origin, which is interior
            f = [f[0]] + f[1:][::-1]
            m = [-x for x in m]
        l = mp.sqrt(dot(m, m))
        # components that cancel to below 1e-40 are exact zeros (a nonzero algebraic number of this height is
        # far larger), so they are written as 0
        n = [x / l if abs(x / l) > mp.mpf(10) ** -40 else mp.mpf(0) for x in m]
        beta = dot(n, V[f[0]])
        assert all(abs(dot(n, V[i]) - beta) < mp.mpf(10) ** -50 for i in f), name + ': face not planar'
        assert all(dot(n, v) < beta + mp.mpf(10) ** -50 for v in V), name + ': face not supporting'
        faces.append(f)
        normals.append(n)
        offsets.append(beta)
    edges = sorted({(min(a, b), max(a, b)) for f in faces for a, b in zip(f, f[1:] + f[:1])})
    assert len(V) - len(edges) + len(faces) == 2, name + ': Euler'
    centroid = [mp.fsum(v[k] for v in V) / len(V) for k in range(3)]
    assert max(abs(x) for x in centroid) < mp.mpf(10) ** -50, name + ': not centred'
    # volume: sum over faces of (1/3) area * offset, area by fan triangulation
    vol = mp.mpf(0)
    for f, n, b in zip(faces, normals, offsets):
        area = mp.mpf(0)
        for i in range(1, len(f) - 1):
            area += dot(cross(sub(V[f[i]], V[f[0]]), sub(V[f[i + 1]], V[f[0]])), n) / 2
        vol += area * b / 3
    return {
        'V': [[float(x) for x in v] for v in V],
        'faces': faces,
        'normals': [[float(x) for x in n] for n in normals],
        'offsets': [float(b) for b in offsets],
        'edges': [list(e) for e in edges],
        'inradius': float(min(offsets)),
        'circumradius': float(max(mp.sqrt(dot(v, v)) for v in V)),
        'volume': float(vol),
        'tangential': bool(max(offsets) - min(offsets) < mp.mpf(10) ** -40),
    }


def js(x):
    """A binary64 as JavaScript writes it (shortest round-trip digits); Python's repr is the same digits."""
    r = repr(float(x))
    if r.endswith('.0'):
        r = r[:-2]
    return r.replace('e-0', 'e-').replace('e+0', 'e+').replace('e+', 'e+')


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'solids_exact.json')
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'packages', 'polyhedra', 'src', 'solids.data.ts')
    exact = json.load(open(src))
    cat = catalogue()
    assert sorted(n for n, *_ in cat) == sorted(exact), 'catalogue and solids_exact.json differ'
    lines = [
        '// Generated by python/polyhedra/gen_solids.py from solids_exact.json, whose first 56 solids are copied unchanged',
        '// from alejandrozu/platonic-packing (MIT; commit cbf76f2f, src/solids_exact.json; see THIRD_PARTY_NOTICES.md);',
        "// the bipyramids and trapezohedra are PolyPack's. Exact coordinates evaluated at 100 digits and rounded to",
        '// binary64. Do not edit by hand.',
        '',
        'export interface SolidData {',
        '  name: string;',
        '  code: string;',
        '  family: "platonic" | "archimedean" | "catalan" | "prism" | "antiprism" | "elongated_prism" | "bipyramid" | "trapezohedron";',
        '  title: string;',
        '  V: number[][];',
        '  faces: number[][];',
        '  normals: number[][];',
        '  offsets: number[];',
        '  edges: [number, number][];',
        '  inradius: number;',
        '  circumradius: number;',
        '  volume: number;',
        '  tangential: boolean;',
        '}',
        '',
        'export const SOLID_DATA: SolidData[] = [',
    ]
    for name, code, family, title in cat:
        s = build(name, exact[name])
        arr = lambda a: '[' + ','.join(arr(x) if isinstance(x, list) else (js(x) if isinstance(x, float) else str(x)) for x in a) + ']'
        lines.append('  {')
        lines.append(f'    name: "{name}", code: "{code}", family: "{family}", title: "{title}",')
        lines.append(f'    V: {arr(s["V"])},')
        lines.append(f'    faces: {arr(s["faces"])},')
        lines.append(f'    normals: {arr(s["normals"])},')
        lines.append(f'    offsets: {arr(s["offsets"])},')
        lines.append(f'    edges: {arr(s["edges"])},')
        lines.append(f'    inradius: {js(s["inradius"])}, circumradius: {js(s["circumradius"])}, volume: {js(s["volume"])}, '
                     f'tangential: {"true" if s["tangential"] else "false"},')
        lines.append('  },')
        print(f'{name:30s} V={len(s["V"]):3d} F={len(s["faces"]):3d} E={len(s["edges"]):3d} '
              f'r={s["inradius"]:.6f} R={s["circumradius"]:.6f} vol={s["volume"]:.6f} tangential={s["tangential"]}')
    lines.append('];')
    open(out, 'w').write('\n'.join(lines) + '\n')
    print('wrote', out, os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    main()
