#!/usr/bin/env python3
# Vendored from alejandrozu/platonic-packing (MIT licence; commit cbf76f2f, file certify_general.py).
# Copyright (c) 2026 Yohei Nakajima; Copyright (c) 2026 Alejandro Zarzuelo. Licence text: THIRD_PARTY_NOTICES.md.
# Changed for PolyPack only where marked "PolyPack:" (the path of solids_exact.json, which sits next to this file).
"""Proof-grade certificate for a packing record of any solid in src/solids_exact.json (standard library only).
usage: python3 certify_general.py record.json

What is proved. Let P be the canonical piece solid and C the canonical container solid, given exactly in
src/solids_exact.json: every vertex coordinate is an element of a real number field Q(alpha) (minimal polynomial +
isolating interval), times a common positive scale lambda = 1/sqrt(D) for the snub solids and their duals. Then:

  (0) P and C are what they claim to be: checked exactly in Q(alpha) -- every face planar, every face plane
      supporting the solid strictly (all other vertices strictly inside), every edge on exactly two faces (so the
      faces are all the facets and C equals the intersection of their half-spaces), all edges of length exactly 1
      (Archimedean solids, prisms, antiprisms, cube...) or all faces tangent to one sphere (Catalan solids);
  (1) each piece c_i + R_i P, with R_i = H(q_i)/|q_i|^2 the exactly orthogonal rational matrix of the stored
      quaternion, lies in the interior of s_full * C (+ container_center): every vertex strictly inside every face
      half-space;
  (2) any two pieces are disjoint: for every pair whose centres are closer than twice an upper bound of the
      circumradius, an explicit rational vector u and rational t with u.x < t on every vertex of one piece and
      u.x > t on every vertex of the other; the other pairs are farther apart than the sum of their circumradii.

All inequalities in (1) and (2) are decided with rigorous interval arithmetic (fixed-point integers with outward
rounding) on enclosures of the exact coordinates (alpha refined by exact bisection); floating point only proposes the
separating directions, so a bad proposal can make certification fail, never succeed. Exit code 0 iff CERTIFIED."""
import json, os, sys, math, time
from fractions import Fraction as Fr
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import algebraic as A
import multiquad as MQM                   # numbers given exactly in Q(sqrt2, sqrt3, sqrt5, sqrt7) (13 Oct 2026)

K = 170                                   # fixed-point bits
ONE = 1 << K
EXACT = json.load(open(os.path.join(HERE, 'solids_exact.json')))   # PolyPack: upstream reads HERE/src/solids_exact.json


# ------------------------------------------------------------------ fixed-point intervals (lo, hi) = [lo, hi] / 2^K
def fx(q):
    """Enclosure of a rational (or an A.I interval) as a fixed-point interval."""
    if isinstance(q, A.I): lo, hi = q.lo, q.hi
    elif isinstance(q, MQM.MQ): lo, hi = q.enclose(K + 24)          # rigorous enclosure of an exact field element
    else: lo = hi = Fr(q)
    return (lo.numerator * ONE // lo.denominator, -(-hi.numerator * ONE // hi.denominator))


def fadd(a, b): return (a[0] + b[0], a[1] + b[1])
def fsub(a, b): return (a[0] - b[1], a[1] - b[0])


def fmul(a, b):
    p = (a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1])
    return (min(p) >> K, -((-max(p)) >> K))       # floor of the min, ceil of the max


def fdot(u, v): return fadd(fadd(fmul(u[0], v[0]), fmul(u[1], v[1])), fmul(u[2], v[2]))


# ------------------------------------------------------------------ solids
class Solid:
    def __init__(self, name):
        d = EXACT[name]; self.name = name
        F = self.F = A.Field([Fr(c) for c in d['minpoly']], Fr(d['interval'][0]), Fr(d['interval'][1]))
        self.U = [tuple(tuple(Fr(c) for c in x) for x in v) for v in d['V']]
        self.faces = d['faces']
        self.D = tuple(Fr(c) for c in d['D']) if d['D'] else None
        self.check = self._self_check(name)
        F.refine(Fr(1, 1 << (K + 20)))
        lam = A.I(1) if self.D is None else A.inv_interval(A.isqrt_interval(F.interval(self.D), bits=K + 20))
        self.lam = fx(lam)
        self.V = [tuple(fmul(fx(F.interval(c)), self.lam) for c in v) for v in self.U]     # enclosures of the vertices
        self.N = [tuple(fx(F.interval(c)) for c in m) for m in self.m]                    # exact outward normals (unscaled)
        self.B = [fmul(fx(F.interval(b)), self.lam) for b in self.beta]                    # offsets of the scaled solid
        self.R2up = max(sum(fmul(c, c)[1] for c in v) for v in self.V)                      # circumradius^2 (upper, fixed point)
        self.Vf = [[(c[0] + c[1]) / 2 / ONE for c in v] for v in self.V]                   # floats (proposals only)
        self.Nf = [self._unit([(c[0] + c[1]) / 2 / ONE for c in m]) for m in self.N]
        self.edges = sorted({(min(a, b), max(a, b)) for f in self.faces for a, b in zip(f, f[1:] + f[:1])})
        ef = {}
        for fi, f in enumerate(self.faces):
            for a, b in zip(f, f[1:] + f[:1]): ef.setdefault((min(a, b), max(a, b)), []).append(fi)
        self.eface = [ef[e] for e in self.edges]

    @staticmethod
    def _unit(u):
        l = math.sqrt(sum(x * x for x in u)); return [x / l for x in u]

    def _self_check(self, name):
        F, U, faces = self.F, self.U, self.faces
        n = len(U)
        edges = {}
        for fi, f in enumerate(faces):
            for a, b in zip(f, f[1:] + f[:1]): edges.setdefault((min(a, b), max(a, b)), []).append(fi)
        assert all(len(v) == 2 for v in edges.values()), 'an edge is not on exactly two faces'
        assert n - len(edges) + len(faces) == 2, 'Euler characteristic'
        self.m, self.beta = [], []
        for f in faces:
            a, b, c = U[f[0]], U[f[1]], U[f[2]]
            m = A.vcross(F, A.vsub(F, b, a), A.vsub(F, c, a)); beta = A.vdot(F, m, a)
            signs = [F.sign(F.sub(A.vdot(F, m, U[i]), beta)) for i in range(n)]
            assert all((s == 0) == (i in f) for i, s in enumerate(signs)), 'face not planar / vertex on a face plane'
            off = {s for i, s in enumerate(signs) if i not in f}
            assert len(off) == 1, 'face plane does not support the solid'
            if off == {1}: m = tuple(F.scale(x, -1) for x in m); beta = F.scale(beta, -1)
            self.m.append(m); self.beta.append(beta)
        L2 = [A.vdot(F, A.vsub(F, U[i], U[j]), A.vsub(F, U[i], U[j])) for i, j in edges]
        target = self.D if self.D is not None else F.one()
        if all(F.is_zero(F.sub(x, target)) for x in L2):
            return f'{name}: V={n} E={len(edges)} F={len(faces)}, faces planar and supporting, closed surface, all edges exactly 1'
        if name.startswith('prism') and '_l' in name:     # elongated prism (13 Oct 2026): base edges 1, lateral edges l
            l = {'l15': Fr(3, 2), 'l2': Fr(2), 'l3': Fr(3)}[name.split('_')[1]]
            base = sum(1 for x in L2 if F.is_zero(F.sub(x, F.one())))
            lat = sum(1 for x in L2 if F.is_zero(F.sub(x, F.elem([l * l]))))
            assert base + lat == len(L2) and base == n and lat == n // 2, 'elongated prism edges are not 1 and l'
            return (f'{name}: V={n} E={len(edges)} F={len(faces)}, faces planar and supporting, closed surface, '
                    f'base edges exactly 1, lateral edges exactly {l}')
        b0, m0 = F.mul(self.beta[0], self.beta[0]), A.vdot(F, self.m[0], self.m[0])
        assert all(F.is_zero(F.sub(F.mul(F.mul(b, b), m0), F.mul(b0, A.vdot(F, m, m)))) for m, b in zip(self.m, self.beta)), \
            'neither unit-edge nor tangential'
        return f'{name}: V={n} E={len(edges)} F={len(faces)}, faces planar and supporting, closed surface, insphere (Catalan)'


_CACHE = {}


def get_solid(name):
    if name not in _CACHE: _CACHE[name] = Solid(name)
    return _CACHE[name]


def rot(q):
    """Exact rotation matrix H(q)/|q|^2 of a quaternion with rational entries or entries in Q(sqrt2, sqrt3, sqrt5,
    sqrt7) given as strings (then the matrix is exact in that field)."""
    w, x, y, z = (MQM.num(c) for c in q)
    n = w * w + x * x + y * y + z * z
    M = [[w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
         [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
         [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z]]
    return [[c / n for c in row] for row in M]


def main(fn):
    t0 = time.time()
    rec = json.load(open(fn))
    P, C = get_solid(rec['piece']), get_solid(rec['container'])
    print('solid check:', P.check)
    if C is not P: print('solid check:', C.check)
    s = MQM.num(rec['s_full']); cc = [MQM.num(c) for c in rec.get('container_center', [0, 0, 0])]
    pcs = rec['pieces']; n = len(pcs)
    assert n == rec['n'], 'piece count'
    Rs = [rot(p[3:]) for p in pcs]
    cs = [[MQM.num(c) for c in p[:3]] for p in pcs]
    used = set()
    for v in [s] + cc + [x for c in cs for x in c] + [x for R in Rs for row in R for x in row]:
        if isinstance(v, MQM.MQ): used |= v.primes()
    if used: print('record numbers given exactly in', MQM.field_name(used), '(arithmetic in Q(sqrt2, sqrt3, sqrt5, sqrt7))')
    # world vertex enclosures
    X = []
    for R, c in zip(Rs, cs):
        Rf = [[fx(e) for e in row] for row in R]; cf = [fx(e) for e in c]
        X.append([tuple(fadd(fdot(Rf[k], v), cf[k]) for k in range(3)) for v in P.V])
    ok = True
    # (1) containment: N_f . (x - cc) < s * B_f
    sB = [fmul(fx(s), b) for b in C.B]
    ccf = [fx(c) for c in cc]
    worst = None; tests = 0
    for i in range(n):
        for x in X[i]:
            xr = [fsub(x[k], ccf[k]) for k in range(3)]
            for N, b in zip(C.N, sB):
                tests += 1
                slack = fsub(b, fdot(N, xr))
                if worst is None or slack[0] < worst: worst = slack[0]
                if slack[0] <= 0: ok = False
    print(f'containment: {tests} vertex/face inequalities, smallest slack >= {worst / ONE:.3e} (times |normal|)'
          + ('' if ok else '  FAILED'))
    # (2) disjointness
    lim = 4 * P.R2up                                     # (2 R_up)^2 in fixed point
    near = far = 0; margin = None; failed = []
    Vf = [[[float(sum(float(R[k][j]) * P.Vf[v][j] for j in range(3)) + float(c[k])) for k in range(3)] for v in range(len(P.Vf))]
          for R, c in zip(Rs, cs)]
    Nw = [[[sum(float(R[k][j]) * nn[j] for j in range(3)) for k in range(3)] for nn in P.Nf] for R in Rs]
    for i in range(n):
        for j in range(i + 1, n):
            d2 = sum((cs[i][k] - cs[j][k]) ** 2 for k in range(3))
            if d2 * ONE > lim: far += 1; continue          # |c_i - c_j| > 2 R_up: disjoint
            near += 1
            done = False
            for u in candidate_axes(P, Vf[i], Vf[j], Nw[i], Nw[j]):
                uq = [Fr(x).limit_denominator(10 ** 12) for x in u]
                uf = [fx(x) for x in uq]
                pa = [fdot(uf, x) for x in X[i]]; pb = [fdot(uf, x) for x in X[j]]
                amax, bmin = max(p[1] for p in pa), min(p[0] for p in pb)
                if amax < bmin:
                    g = bmin - amax; margin = g if margin is None else min(margin, g); done = True; break
                bmax, amin = max(p[1] for p in pb), min(p[0] for p in pa)
                if bmax < amin:
                    g = amin - bmax; margin = g if margin is None else min(margin, g); done = True; break
            if not done: ok = False; failed.append((i, j))
    print(f'disjointness: {near} near pairs separated by explicit rational planes (smallest gap >= '
          f'{(margin or 0) / ONE:.3e} along the plane normal), {far} pairs farther apart than twice the circumradius'
          + (f'  FAILED for {failed[:10]}' if failed else ''))
    print(f"{'CERTIFIED' if ok else 'NOT CERTIFIED'}: {n} {rec['piece']} in s = {rec['s_full']} x {rec['container']}  ({time.time() - t0:.1f}s)")
    return 0 if ok else 1


def candidate_axes(P, VA, VB, NA, NB, k=6):
    """Float proposals: face normals of both pieces and Gauss-map-pruned edge-edge cross products, best first."""
    cand = []

    def gap(u):
        pa = [x[0] * u[0] + x[1] * u[1] + x[2] * u[2] for x in VA]; pb = [x[0] * u[0] + x[1] * u[1] + x[2] * u[2] for x in VB]
        return max(min(pb) - max(pa), min(pa) - max(pb))
    for u in NA + NB: cand.append((gap(u), u))
    cr = lambda a, b: [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    dt = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    EA = [(NA[f1], NA[f2], cr(NA[f2], NA[f1])) for f1, f2 in P.eface]
    EB = [(NB[f1], NB[f2], cr(NB[f2], NB[f1])) for f1, f2 in P.eface]
    for a1, a2, ca in EA:
        for b1, b2, cb in EB:
            CBA, DBA = -dt(b1, ca), -dt(b2, ca)
            if CBA * DBA >= 0: continue
            ADC, BDC = dt(a1, cb), dt(a2, cb)
            if ADC * BDC >= 0 or CBA * BDC <= 0: continue
            w = cr(ca, cb); l = math.sqrt(dt(w, w))
            if l < 1e-12: continue
            w = [x / l for x in w]; cand.append((gap(w), w))
    cand.sort(key=lambda t: -t[0])
    return [u for _, u in cand[:k]]


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
