"""The exact proof that an entry of solids_exact.json is a Johnson solid (standard library only).

For J<j>: in Q(alpha) (python/polyhedra/algebraic.py, exact signs by Sturm-isolated intervals),
  - the vertices are distinct and their centroid is the origin;
  - every edge of every face has length exactly 1;
  - every face is planar and a regular polygon: equilateral (above), convex and counter-clockwise, all vertices at one
    distance from the face centre;
  - every face plane supports the solid strictly (every other vertex strictly inside), so the solid is strictly convex and
    its faces are exactly the listed ones; every edge lies on exactly two faces (a closed surface), Euler V - E + F = 2;
  - V, E and F and the number of faces of each kind equal the standard table (johnson_table.py).
Used by johnson.py (at build) and test_johnson.py.
"""
from fractions import Fraction as Fr
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import algebraic as A  # noqa: E402
from johnson_table import JOHNSON  # noqa: E402


def prove(j, entry):
    """The exact proof of the module docstring. Raises AssertionError on any failure; returns the 'checks' text."""
    name, nV, nE, counts = JOHNSON[j]
    F = A.Field([Fr(c) for c in entry['minpoly']], Fr(entry['interval'][0]), Fr(entry['interval'][1]))
    U = [tuple(tuple(Fr(c) for c in x) for x in v) for v in entry['V']]
    U = [tuple(x for x in v) for v in U]
    faces = entry['faces']
    n = len(U)
    assert n == nV, f'J{j}: {n} vertices, table has {nV}'
    # distinct vertices, centroid at the origin
    assert len(set(U)) == n, 'repeated vertices'
    for k in range(3):
        s = F.zero()
        for v in U: s = F.add(s, v[k])
        assert F.is_zero(s), 'centroid is not the origin'
    one = F.one()
    edges = {}
    for fi, f in enumerate(faces):
        for a, b in zip(f, f[1:] + f[:1]): edges.setdefault((min(a, b), max(a, b)), []).append(fi)
    assert all(len(v) == 2 for v in edges.values()), 'an edge is not on exactly two faces'
    assert len(edges) == nE, f'J{j}: {len(edges)} edges, table has {nE}'
    assert n - len(edges) + len(faces) == 2, 'Euler characteristic'
    got = {}
    for f in faces: got[len(f)] = got.get(len(f), 0) + 1
    assert got == counts, f'J{j}: faces by sides {got}, table has {counts}'
    for (a, b) in edges:
        d = A.vsub(F, U[a], U[b])
        assert F.is_zero(F.sub(A.vdot(F, d, d), one)), f'edge {a}-{b} does not have length 1'
    for f in faces:
        m = len(f)
        P = [U[i] for i in f]
        a, b, c = P[0], P[1], P[2]
        nrm = A.vcross(F, A.vsub(F, b, a), A.vsub(F, c, a))
        beta = A.vdot(F, nrm, a)
        assert F.sign(beta) > 0, 'face is oriented inwards / the origin is not inside'
        for i, v in enumerate(U):
            e = F.sub(A.vdot(F, nrm, v), beta)
            if i in f: assert F.is_zero(e), 'face not planar'
            else: assert F.sign(e) < 0, 'a vertex is not strictly inside a face plane (not strictly convex)'
        # regular polygon: convex counter-clockwise, and all vertices at one distance from the centre of the face
        csum = [F.zero()] * 3
        for p in P: csum = [F.add(s, x) for s, x in zip(csum, p)]
        cen = tuple(F.scale(s, Fr(1, m)) for s in csum)
        r2 = None
        for p in P:
            d = A.vsub(F, p, cen); q = A.vdot(F, d, d)
            if r2 is None: r2 = q
            assert F.is_zero(F.sub(q, r2)), 'face vertices are not on one circle'
        for i in range(m):
            e1 = A.vsub(F, P[(i + 1) % m], P[i]); e2 = A.vsub(F, P[(i + 2) % m], P[(i + 1) % m])
            assert F.sign(A.vdot(F, A.vcross(F, e1, e2), nrm)) > 0, 'face is not convex / not counter-clockwise'
    return f'V={n} E={len(edges)} F={len(faces)}: faces planar and supporting, closed surface, all edges exactly 1, regular faces, strictly convex'
