"""The exact catalogue of convex polytopes of dimension 4 to 10 (standard library only): loading, enclosures and checks.

The data file catalogue_exact.json is written by gen_catalogue.py. Each entry is a polytope of unit edge, centred at the
vertex centroid, with exact vertices and its exact H-representation:

  axis form  x_k = (V[i][k] / den) * sqrt(rad[k]); a facet [n_1..n_d, b] (integers) is the half-space
             sum_k n_k V_k <= b of the integer vertex matrix, i.e. m . x <= b / den for the actual coordinates x with
             m_k = n_k / sqrt(rad_k) (not a unit normal).
  q5 form    x_k = (a_k + b_k sqrt5) / den, V[i] = [a_1, b_1, ..., a_d, b_d]; a facet [p_1, q_1, ..., p_d, q_d, r, s]
             is m . X <= r + s sqrt5 for the integer-coordinate vertices X (m_k = p_k + q_k sqrt5), i.e.
             m . x <= (r + s sqrt5) / den.

verify(entry) proves exactly that the data is the polytope it claims to be: counts of vertices, edges and facets equal the
literature (LITERATURE), the vertex centroid is 0, every edge (every pair at the least distance) has length exactly 1 and
the graph is regular, every vertex satisfies every facet inequality, every facet touches d affinely independent vertices
(a genuine facet), every vertex is an extreme point (the facets through it have normals of rank d) and every edge lies in
facets with normals of rank d - 1. Facets are distinct, so the facet count being the literature's, the list is complete."""
import json
import math
import os
import sys
from fractions import Fraction as Fr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import exact as X  # noqa: E402

DATA = os.path.join(HERE, 'catalogue_exact.json')

# code -> (vertices, edges, facets) from the literature (Coxeter, Regular Polytopes; Wikipedia's polytope pages for the
# uniform families; the demicube's and the Gosset polytopes' counts from their Coxeter-Dynkin diagrams).
def _lit():
    L = {}
    for d in range(4, 11):
        L[f'{d}:simplex'] = (d + 1, (d + 1) * d // 2, d + 1)
        L[f'{d}:cube'] = (2 ** d, d * 2 ** (d - 1), 2 * d)
        L[f'{d}:ortho'] = (2 * d, 2 * d * (d - 1), 2 ** d)
        if d >= 5:
            L[f'{d}:demi'] = (2 ** (d - 1), 2 ** (d - 3) * d * (d - 1), 2 ** (d - 1) + 2 * d)
    L['4:24cell'] = (24, 96, 24)
    L['4:120cell'] = (600, 1200, 120)
    L['4:600cell'] = (120, 720, 600)
    L['6:221'] = (27, 216, 99)
    L['6:122'] = (72, 720, 54)
    L['7:321'] = (56, 756, 702)
    L['8:421'] = (240, 6720, 19440)
    return L


LITERATURE = _lit()

TITLES = {'simplex': 'simplex', 'cube': 'hypercube', 'ortho': 'orthoplex', 'demi': 'demicube', '24cell': '24-cell',
          '120cell': '120-cell', '600cell': '600-cell', '221': '2_21 polytope', '122': '1_22 polytope',
          '321': '3_21 polytope', '421': '4_21 polytope'}


def load(path=DATA):
    with open(path) as f:
        return json.load(f)


_CACHE = {}


def get(code):
    if code not in _CACHE:
        for e in load()['polytopes']:
            _CACHE[e['code']] = Polytope(e)
    return _CACHE[code]


def codes():
    return list(load()['codes'])


# ------------------------------------------------------------------ enclosures
class Polytope:
    """A catalogue entry with enclosures and floats (cached)."""

    def __init__(self, e):
        self.e = e
        self.code = e['code']
        self.d = e['d']
        self.form = e['form']
        self.den = e['den']
        self.V = e['V']
        self.F = e['F']
        self._venc = self._fenc = self._vfl = self._ffl = None

    @property
    def nV(self):
        return len(self.V)

    @property
    def nF(self):
        return len(self.F)

    def _coord_enc(self):
        d, den = self.d, self.den
        if self.form == 'axis':
            sig = [X.fsqrt(r) for r in self.e['rad']]
            return [[self._scaled(Fr(v[k], den), sig[k]) for k in range(d)] for v in self.V]
        s5 = X.fsqrt(5)
        return [[X.fadd(X.fx(Fr(v[2 * k], den)), self._scaled(Fr(v[2 * k + 1], den), s5)) for k in range(d)]
                for v in self.V]

    @staticmethod
    def _scaled(q, enc):
        """Enclosure of q * (the number enclosed by enc), q rational."""
        lo, hi = (enc if q >= 0 else (enc[1], enc[0]))
        return (q.numerator * lo // q.denominator, -(-q.numerator * hi // q.denominator))

    def vertex_enc(self):
        """Fixed-point enclosures of the vertex coordinates: a list of rows of (lo, hi) pairs (2^-K units)."""
        if self._venc is None:
            self._venc = self._coord_enc()
        return self._venc

    def facet_enc(self):
        """(N, B): outward normals (not unit) and offsets as fixed-point enclosures, N[f] . x <= B[f] on the polytope."""
        if self._fenc is None:
            d, den = self.d, self.den
            N, B = [], []
            if self.form == 'axis':
                sig = [X.fsqrt(r) for r in self.e['rad']]
                for f in self.F:
                    N.append([self._scaled(Fr(f[k], self.e['rad'][k]), sig[k]) for k in range(d)])
                    B.append(X.fx(Fr(f[d], den)))
            else:
                s5 = X.fsqrt(5)
                for f in self.F:
                    N.append([X.fadd(X.fx(f[2 * k]), self._scaled(Fr(f[2 * k + 1]), s5)) for k in range(d)])
                    B.append(X.fadd(X.fx(Fr(f[2 * d], den)), self._scaled(Fr(f[2 * d + 1], den), s5)))
            self._fenc = (N, B)
        return self._fenc

    def vertices_float(self):
        if self._vfl is None:
            self._vfl = [[X.fto_float(c) for c in row] for row in self.vertex_enc()]
        return self._vfl

    def facets_float(self):
        """(unit outward normals, offsets) as floats."""
        if self._ffl is None:
            N, B = self.facet_enc()
            nf, bf = [], []
            for n, b in zip(N, B):
                v = [X.fto_fraction(c) for c in n]
                ln = math.sqrt(float(sum(c * c for c in v)))
                nf.append([float(c) / ln for c in v])
                bf.append(float(X.fto_fraction(b)) / ln)
            self._ffl = (nf, bf)
        return self._ffl

    def circumradius2_up(self):
        """Upper bound of max |v|^2 as a fixed-point integer (2^-K units)."""
        return max(sum(X.fmul(c, c)[1] for c in row) for row in self.vertex_enc())


# ------------------------------------------------------------------ exact checks
def _sign5(u, v):
    """Sign of u + v sqrt5 for integers u, v."""
    if u >= 0 and v >= 0:
        return 0 if u == 0 and v == 0 else 1
    if u <= 0 and v <= 0:
        return -1
    # opposite signs: compare u^2 with 5 v^2
    if u * u > 5 * v * v:
        return 1 if u > 0 else -1
    return 1 if v > 0 else -1


class _Q:
    """The two number forms behind one interface for the checks (integers only)."""

    def __init__(self, e):
        self.e = e
        self.d = e['d']
        self.den = e['den']
        self.V = e['V']
        self.axis = e['form'] == 'axis'
        if self.axis:
            self.rad = e['rad']

    def centroid_zero(self):
        return all(sum(v[k] for v in self.V) == 0 for k in range(len(self.V[0])))

    def dist2_is(self, i, j):
        """Compares |v_i - v_j|^2 with den^2: returns -1, 0, 1."""
        a, b, den2 = self.V[i], self.V[j], self.den ** 2
        if self.axis:
            s = sum(r * (x - y) ** 2 for r, x, y in zip(self.rad, a, b))
            return (s > den2) - (s < den2)
        s0 = s1 = 0
        for k in range(self.d):
            da, db = a[2 * k] - b[2 * k], a[2 * k + 1] - b[2 * k + 1]
            s0 += da * da + 5 * db * db
            s1 += 2 * da * db
        return _sign5(s0 - den2, s1)

    def dist2_float_key(self, i, j):
        """|v_i - v_j|^2 as a float (a prefilter for the exact comparison)."""
        a, b = self.V[i], self.V[j]
        if self.axis:
            return sum(r * (x - y) ** 2 for r, x, y in zip(self.rad, a, b)) / self.den ** 2
        s = 0.0
        r5 = math.sqrt(5)
        for k in range(self.d):
            s += ((a[2 * k] - b[2 * k]) + (a[2 * k + 1] - b[2 * k + 1]) * r5) ** 2
        return s / self.den ** 2

    def slack_sign(self, f, i):
        """Sign of (b_f - n_f . v_i): +1 inside, 0 on the facet, -1 outside."""
        F, v, d = self.e['F'][f], self.V[i], self.d
        if self.axis:
            s = F[d] - sum(n * x for n, x in zip(F, v))
            return (s > 0) - (s < 0)
        s0 = s1 = 0
        for k in range(d):
            p, q, a, b = F[2 * k], F[2 * k + 1], v[2 * k], v[2 * k + 1]
            s0 += p * a + 5 * q * b
            s1 += p * b + q * a
        return _sign5(F[2 * d] - s0, F[2 * d + 1] - s1)

    def normal_rows(self, f):
        """The facet normal as an echelon row: the integer vector n (axis form; the actual normal is n / sqrt(rad), an
        invertible diagonal image, so ranks agree) or the pair (p-list, q-list) of m_k = p_k + q_k sqrt5 (q5 form)."""
        F = self.e['F'][f]
        return F[:self.d] if self.axis else ([F[2 * k] for k in range(self.d)], [F[2 * k + 1] for k in range(self.d)])

    def diff_row(self, i, j):
        """v_i - v_j as an echelon row (see normal_rows); differences of integer vertices span the same space as of actual ones."""
        a, b = self.V[i], self.V[j]
        if self.axis:
            return [x - y for x, y in zip(a, b)]
        return ([a[2 * k] - b[2 * k] for k in range(self.d)], [a[2 * k + 1] - b[2 * k + 1] for k in range(self.d)])


class _Echelon:
    """Incremental row echelon form over Q (axis form) or Q(sqrt5) (q5 form, rows are (p-list, q-list) pairs): add() tells
    whether a row is independent of the earlier ones; rank is the number of independent rows so far."""

    def __init__(self, axis):
        self.axis = axis
        self.rows = []                    # (pivot column, row) with the pivot entry normalised to 1
        self.rank = 0

    def add(self, row):
        if self.axis:
            r = [Fr(x) for x in row]
            for c, p in self.rows:
                if r[c] != 0:
                    f = r[c]
                    r = [x - f * y for x, y in zip(r, p)]
            c = next((k for k, x in enumerate(r) if x != 0), None)
            if c is None:
                return False
            iv = 1 / r[c]
            self.rows.append((c, [x * iv for x in r]))
        else:
            r = [(Fr(p), Fr(q)) for p, q in zip(*row)]

            def mul(x, y):
                return (x[0] * y[0] + 5 * x[1] * y[1], x[0] * y[1] + x[1] * y[0])
            for c, p in self.rows:
                if r[c] != (0, 0):
                    f = r[c]
                    r = [(x[0] - mul(f, y)[0], x[1] - mul(f, y)[1]) for x, y in zip(r, p)]
            c = next((k for k, x in enumerate(r) if x != (0, 0)), None)
            if c is None:
                return False
            n = r[c][0] ** 2 - 5 * r[c][1] ** 2
            iv = (r[c][0] / n, -r[c][1] / n)
            self.rows.append((c, [mul(x, iv) for x in r]))
        self.rank += 1
        return True


def _rank_upto(Q, rows, want):
    """Rank of the rows, stopping at `want`."""
    ech = _Echelon(Q.axis)
    for r in rows:
        ech.add(r)
        if ech.rank >= want:
            break
    return ech.rank


def _slack_rows(Q):
    """For every facet the list of vertices on it; asserts that no vertex is outside (exact integer arithmetic)."""
    e, d = Q.e, Q.d
    nV, nF = len(Q.V), len(e['F'])
    np = None
    try:
        import numpy as np  # noqa: F811
    except ImportError:
        pass
    if np is not None and Q.axis:
        big = max(abs(x) for f in e['F'] for x in f) * max(abs(x) for v in Q.V for x in v) * d
        if big < 2 ** 62:
            M = np.array([f[:d] for f in e['F']], dtype=np.int64) @ np.array(Q.V, dtype=np.int64).T
            S = np.array([f[d] for f in e['F']], dtype=np.int64)[:, None] - M
            assert (S >= 0).all(), 'a vertex is outside a facet'
            return [np.flatnonzero(S[f] == 0).tolist() for f in range(nF)]
    on_all = []
    for f in range(nF):
        on = []
        for i in range(nV):
            s = Q.slack_sign(f, i)
            assert s >= 0, f'vertex {i} outside facet {f}'
            if s == 0:
                on.append(i)
        on_all.append(on)
    return on_all


def verify(e, *, facet_sample=None):
    """Proves the entry exact (see the module docstring). Raises AssertionError with a reason; returns a summary dict.

    facet_sample: if given, only this many facets (spread evenly) are tested against all vertices and for the
    supporting-face rank, and the extreme point and edge tests are skipped (a partial check for the largest polytope in
    the fast tests); the counts, the edges and the distinctness of the facets are still checked in full."""
    code, d = e['code'], e['d']
    nV, nE, nF = LITERATURE[code]
    Q = _Q(e)
    V = e['V']
    assert len(V) == nV, f'{code}: {len(V)} vertices, literature {nV}'
    assert len({tuple(v) for v in V}) == nV, f'{code}: repeated vertices'
    assert Q.centroid_zero(), f'{code}: vertex centroid is not 0'
    assert e['den'] > 0 and all(len(v) == (d if Q.axis else 2 * d) for v in V)
    if Q.axis:
        assert len(e['rad']) == d and all(r > 0 and X.sqfree(r)[0] == 1 for r in e['rad']), f'{code}: radicands'
    # edges: pairs at the least distance, which must be exactly 1 (a float scan; the exact test decides every pair
    # within 1e-6 of 1, and a pair below that fails)
    edges = []
    deg = [0] * nV
    key = Q.dist2_float_key
    for i in range(nV):
        for j in range(i + 1, nV):
            if key(i, j) < 1 + 1e-6:
                c = Q.dist2_is(i, j)
                assert c >= 0, f'{code}: vertices {i},{j} closer than 1'
                if c == 0:
                    edges.append((i, j))
                    deg[i] += 1
                    deg[j] += 1
    assert len(edges) == nE, f'{code}: {len(edges)} unit edges, literature {nE}'
    assert len(set(deg)) == 1, f'{code}: the unit-distance graph is not regular'
    F = e['F']
    assert len(F) == nF, f'{code}: {len(F)} facets, literature {nF}'
    assert len({tuple(f) for f in F}) == nF, f'{code}: repeated facets'
    for f in range(nF):                           # b > 0: the centroid 0 is strictly inside every half-space
        assert (F[f][d] > 0) if Q.axis else (_sign5(F[f][2 * d], F[f][2 * d + 1]) > 0), f'{code}: facet {f} excludes 0'
    if facet_sample is not None:
        pick = list(range(0, nF, max(1, nF // facet_sample)))
        sub = dict(e, F=[F[f] for f in pick])
        Qs = _Q(sub)
        for k, on in enumerate(_slack_rows(Qs)):
            assert len(on) >= d
            assert _rank_upto(Qs, [Qs.diff_row(on[0], j) for j in on[1:]], d - 1) == d - 1, \
                f'{code}: facet {pick[k]} touches only a lower-dimensional face'
        return {'code': code, 'V': nV, 'E': len(edges), 'F': nF, 'partial': True}
    on_all = _slack_rows(Q)
    through = [[] for _ in range(nV)]
    for f, on in enumerate(on_all):
        assert len(on) >= d
        assert _rank_upto(Q, [Q.diff_row(on[0], j) for j in on[1:]], d - 1) == d - 1, \
            f'{code}: facet {f} touches only a lower-dimensional face'
        for i in on:
            through[i].append(f)
    for i in range(nV):                           # every vertex is an extreme point: its facets' normals have rank d
        assert _rank_upto(Q, (Q.normal_rows(f) for f in through[i]), d) == d, f'{code}: vertex {i} is not extreme'
    sets = [set(t) for t in through]
    for i, j in edges:                            # every unit edge is a face of dimension 1
        common = sets[i] & sets[j]
        assert _rank_upto(Q, (Q.normal_rows(f) for f in common), d - 1) == d - 1, f'{code}: ({i},{j}) is not an edge'
    return {'code': code, 'V': nV, 'E': len(edges), 'F': nF}
