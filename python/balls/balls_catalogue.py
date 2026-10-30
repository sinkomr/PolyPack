"""The problems of the balls space (packages/balls/src/catalogue.ts) and their elementary lower bounds
(packages/balls/src/problems.ts ballsBound), for the certifier and the record builder. Standard library only.

373 problems: `ballinball`, `ballin<code>` for each of the polyhedra space's 186 solids (the 94 of the first catalogue
and the 92 Johnson solids; balls in that solid, scaled by s) and `<code>inball` for each of the 186 (the unit-edge solid
in a ball), P from 2 to 100. The first 7 (ORIGINAL_CODES) are the space's first problems; the order of CODES is the
TypeScript catalogue's (balls in a ball, then in the Platonic, Archimedean, Catalan, prism, antiprism, elongated prism,
bipyramid, trapezohedron and Johnson solids, then the solids in a ball in the same order)."""
import math
import os
import re
import sys
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
POLYHEDRA = os.path.join(os.path.dirname(HERE), 'polyhedra')


def _polyhedra(module):
    """A module of python/polyhedra, imported without leaving that folder on the path: certify_general puts its own folder
    first on sys.path, where its certify.py and catalogue.py would shadow this folder's."""
    saved = list(sys.path)
    sys.path.append(POLYHEDRA)
    try:
        return __import__(module)
    finally:
        sys.path[:] = saved


_poly = _polyhedra('catalogue')            # the polyhedra space's solids and codes

# The radius of a ball piece (balls have diameter 1): the one place in this module and the certifier where it is written
# (packages/balls/src/catalogue.ts BALL_RADIUS). A Fraction, so that the exact checks stay in rationals.
BALL_RADIUS = Fraction(1, 2)
BALL_DIAMETER = 2 * BALL_RADIUS
# The score of a ball container is its DIAMETER (2026-10-27): radius = score / 2 (ballContainerRadius in catalogue.ts).
SCORE_PER_RADIUS = 2

MIN_P, MAX_P = 2, 100

_FAMILIES = ['platonic', 'archimedean', 'catalan', 'prism', 'antiprism', 'elongated_prism', 'bipyramid', 'trapezohedron',
             'johnson']
_LABEL = {'platonic': 'Platonic solid', 'archimedean': 'Archimedean solid', 'catalan': 'Catalan solid', 'prism': 'prism',
          'antiprism': 'antiprism', 'elongated_prism': 'elongated prism', 'bipyramid': 'bipyramid',
          'trapezohedron': 'trapezohedron', 'johnson': 'Johnson solid'}


def _rank(name):
    m = re.fullmatch(r'(?:prism|antiprism|bipyramid|trapezohedron)(\d+)(?:_(l15|l2|l3))?', name)
    return (int(m.group(1)), ['l15', 'l2', 'l3'].index(m.group(2)) if m.group(2) else 0) if m else (0, 0)


def _plural(title):
    if ' prism of height' in title:
        return title.replace(' prism of', ' prisms of')
    return title[:-2] + 'a' if title.endswith('hedron') else title + 's'


def _article(title):
    return ('an ' if title[0] in 'aeiouAEIOU' else 'a ') + title


def _build():
    solids = _poly.solids()          # (name, code, family, title)
    ordered = []
    for fam in _FAMILIES:
        members = [s for s in solids if s[2] == fam]
        ordered += sorted(members, key=lambda s: (_rank(s[0]), members.index(s)))
    out = {'ballinball': {'piece': 'ball', 'container': 'ball', 'title': 'Balls in a ball'}}
    for name, code, fam, title in ordered:
        out['ballin' + code] = {'piece': 'ball', 'container': name, 'title': 'Balls in ' + _article(title)}
    for name, code, fam, title in ordered:
        t = _plural(title)
        out[code + 'inball'] = {'piece': name, 'container': 'ball', 'title': t[0].upper() + t[1:] + ' in a ball'}
    return out


PROBLEMS = _build()
CODES = list(PROBLEMS)
ORIGINAL_CODES = ['ballinball', 'ballincub', 'tetinball', 'cubinball', 'octinball', 'dodinball', 'icoinball']

S5 = math.sqrt(5)
# unit-edge Platonic solids: volume, circumradius, inradius (closed forms) [EST]; the others come from the exact solids
CLOSED_FORMS = {
    'tetrahedron': (1 / (6 * math.sqrt(2)), math.sqrt(6) / 4, math.sqrt(6) / 12),
    'cube': (1.0, math.sqrt(3) / 2, 0.5),
    'octahedron': (math.sqrt(2) / 3, math.sqrt(2) / 2, math.sqrt(6) / 6),
    'dodecahedron': ((15 + 7 * S5) / 4, math.sqrt(3) * (1 + S5) / 4, math.sqrt((25 + 11 * S5) / 10) / 2),
    'icosahedron': (5 * (3 + S5) / 12, math.sqrt(10 + 2 * S5) / 4, math.sqrt(3) * (3 + S5) / 12),
}
SOLIDS = CLOSED_FORMS      # the name the first version of this module had

_GEOMETRY = {}


def _float_vertices(name):
    """The vertices (floats) and faces of the canonical solid `name` of python/polyhedra/solids_exact.json: its exact
    coordinates in Q(alpha) evaluated on an interval of width 2^-80 around alpha (certify_general.Solid does the same to
    170 bits, after exact checks of the whole solid that take a second each; the bounds need only floats)."""
    cg = _polyhedra('certify_general')
    A, Fr = cg.A, cg.Fr
    d = cg.EXACT[name]
    F = A.Field([Fr(c) for c in d['minpoly']], Fr(d['interval'][0]), Fr(d['interval'][1]))
    F.refine(Fr(1, 1 << 80))

    def mid(coeffs):
        x = F.interval(tuple(Fr(c) for c in coeffs))
        return float((x.lo + x.hi) / 2)
    lam = 1.0 if d['D'] is None else 1 / math.sqrt(mid(d['D']))
    return [[mid(x) * lam for x in v] for v in d['V']], d['faces']


def _solve(A, y):
    """Gaussian elimination with partial pivoting; None for a (nearly) singular matrix."""
    n = len(y)
    M = [list(row) + [y[i]] for i, row in enumerate(A)]
    scale = max(abs(v) for row in A for v in row)
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(M[r][i]))
        if abs(M[p][i]) <= 1e-11 * scale:
            return None
        M[i], M[p] = M[p], M[i]
        for r in range(i + 1, n):
            m = M[r][i] / M[i][i]
            for j in range(i, n + 1):
                M[r][j] -= m * M[i][j]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        x[i] = (M[i][n] - sum(M[i][j] * x[j] for j in range(i + 1, n))) / M[i][i]
    return x


def _ball_on(pts):
    """(centre, r^2) of the smallest ball with the 1 to 4 points on its boundary, or None when they are degenerate."""
    if not pts:
        return (0.0, 0.0, 0.0), -1.0
    a = pts[0]
    u = [[p[k] - a[k] for k in range(3)] for p in pts[1:]]
    if not u:
        return tuple(a), 0.0
    G = [[sum(p[k] * q[k] for k in range(3)) for q in u] for p in u]
    t = _solve(G, [sum(p[k] * p[k] for k in range(3)) / 2 for p in u])
    if t is None:
        return None
    x = [a[k] + sum(t[i] * u[i][k] for i in range(len(u))) for k in range(3)]
    return tuple(x), sum((a[k] - x[k]) ** 2 for k in range(3))


def enclosing_radius(V):
    """Radius of the smallest ball holding the points V (Welzl's algorithm; a port of enclosingOf in
    packages/balls/src/extent.ts, whose result the fixture bounds.json compares). Floats."""
    P = [V[i] for i in sorted(range(len(V)), key=lambda i: (i * 2654435761) % 4294967296)]

    def inside(B, p):
        return sum((p[k] - B[0][k]) ** 2 for k in range(3)) <= B[1] * (1 + 1e-12) + 1e-15

    def welzl(n, R):
        B = _ball_on(R) or ((0.0, 0.0, 0.0), -1.0)
        if len(R) == 4:
            return B
        for i in range(n):
            if B[1] >= 0 and inside(B, P[i]):
                continue
            B = welzl(i, R + [P[i]])
        return B
    return math.sqrt(welzl(len(P), [])[1])


def chebyshev_radius(N, b):
    """max r with N_f . x + r <= b_f for every face f (the radius of the largest ball in the solid): a tableau simplex on
    x+, x- and r with Bland's rule, as chebyshevOf in packages/balls/src/extent.ts. N are unit outward normals."""
    F = len(b)
    n = 7
    w = n + F + 1
    T = [[0.0] * w for _ in range(F + 1)]
    basis = [n + f for f in range(F)]
    for f in range(F):
        for k in range(3):
            T[f][k] = N[f][k]
            T[f][3 + k] = -N[f][k]
        T[f][6] = 1.0
        T[f][n + f] = 1.0
        T[f][w - 1] = b[f]
    T[F][6] = -1.0
    for _ in range(10000):
        col = next((j for j in range(w - 1) if T[F][j] < -1e-13), -1)
        if col < 0:
            break
        row, best = -1, math.inf
        for f in range(F):
            if T[f][col] > 1e-13:
                ratio = T[f][w - 1] / T[f][col]
                if ratio < best - 1e-15 or (abs(ratio - best) <= 1e-15 and basis[f] < basis[row]):
                    best, row = ratio, f
        if row < 0:
            raise ValueError('unbounded')
        p = T[row][col]
        T[row] = [v / p for v in T[row]]
        for f in range(F + 1):
            if f != row and T[f][col] != 0:
                m = T[f][col]
                T[f] = [T[f][j] - m * T[row][j] for j in range(w)]
        basis[row] = col
    return T[F][w - 1]


_SAFETY = 1e-9


def geometry(name):
    """Volume, circumradius, inradius, diameter (largest vertex distance) and tangential flag of the canonical solid
    `name` (python/polyhedra/solids_exact.json), from its float vertices and the unit normals through the first vertex
    of each face; the vertex centroid is the origin. The inradius is the least face offset about the origin, and the
    circumradius the largest vertex distance: both about the centroid, which is the centre of the largest inscribed
    and of the smallest enclosing ball of the first 94 solids (container.ts in packages/balls), not of the Johnson solids,
    so 'chebyshev' and 'enclosing' give the radii of the largest ball inside and the smallest ball outside. Floats."""
    g = _GEOMETRY.get(name)
    if g is None:
        V, faces = _float_vertices(name)
        offsets = []
        normals = []
        vol = 0.0
        for f in faces:
            a, b, c = V[f[0]], V[f[1]], V[f[2]]
            u = [b[k] - a[k] for k in range(3)]
            w = [c[k] - a[k] for k in range(3)]
            n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
            length = math.hypot(*n)
            off = sum(n[k] * a[k] for k in range(3)) / length
            offsets.append(abs(off))
            normals.append([(x if off >= 0 else -x) / length for x in n])
            for i in range(1, len(f) - 1):
                b, c = V[f[i]], V[f[i + 1]]
                vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                        + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
        diam = max(math.dist(V[i], V[j]) for i in range(len(V)) for j in range(i + 1, len(V)))
        g = {'volume': abs(vol), 'circumradius': max(math.hypot(*v) for v in V), 'inradius': min(offsets),
             'diameter': diam, 'tangential': max(offsets) - min(offsets) < 1e-12}
        # about the best centre (extent.ts): the vertex centroid's values where it is optimal, else the optimum moved
        # by 1e-9 of itself to keep a bound valid
        cheb = chebyshev_radius(normals, offsets)
        g['chebyshev'] = g['inradius'] if cheb <= g['inradius'] * (1 + 1e-9) else cheb * (1 + _SAFETY)
        encl = enclosing_radius(V)
        g['enclosing'] = g['circumradius'] if encl >= g['circumradius'] * (1 - 1e-9) else encl * (1 - _SAFETY)
        _GEOMETRY[name] = g
    return g


ID_RE = re.compile(r'^balls/([a-z][a-z0-9]*)/([1-9][0-9]{0,3})$')


def parse_id(text):
    """(code, P) of an id balls/<code>/<P> in its one written form with 2 <= P <= 100, or None."""
    if not isinstance(text, str):
        return None
    m = ID_RE.match(text)
    if not m or m.group(1) not in PROBLEMS:
        return None
    P = int(m.group(2))
    return (m.group(1), P) if MIN_P <= P <= MAX_P else None


def bound(code, P):
    """The largest of the volume, one-piece and two-piece bounds (problems.ts), as a float. Balls (radius r =
    BALL_RADIUS = 1/2): volume, in a ball container of radius rho >= (P)^(1/3) r, in a solid s >= (P 4 pi r^3 / (3 V))^(1/3);
    one piece, rho >= r in a ball, s >= 2 r in a cube, s >= r / rho in another solid, rho its Chebyshev radius; two pieces, rho >= 2 r in a ball, s >= 2 r +
    2 r / sqrt 3 in a cube, in another solid s >= r / rho + 2 r / D when all its faces are at the inradius rho (D the
    diameter) and always s >= 4 r / D. Solids in a ball: volume, the enclosing radius (the circumradius for the first 94 solids), twice the inradius, all radii.
    A ball container is scored by its diameter, so its bounds are doubled: score = 2 rho."""
    prob = PROBLEMS[code]
    piece, container = prob['piece'], prob['container']
    R, D2 = float(BALL_RADIUS), float(BALL_DIAMETER)
    if piece == 'ball':
        v = 4 * math.pi * R ** 3 / 3
        if container == 'ball':
            vals = [(3 * P * v / (4 * math.pi)) ** (1 / 3), R] + ([D2] if P >= 2 else [])
            return float(max(vals)) * SCORE_PER_RADIUS
        elif container == 'cube':
            vals = [(P * v) ** (1 / 3), D2] + ([D2 + D2 / math.sqrt(3)] if P >= 2 else [])
        else:
            c = geometry(container)
            vals = [(P * v / c['volume']) ** (1 / 3), R / c['chebyshev']]
            if P >= 2:
                if c['tangential']:
                    vals.append(R / c['inradius'] + D2 / c['diameter'])
                vals.append(2 * D2 / c['diameter'])
        return float(max(vals))
    v, Rc, r = CLOSED_FORMS[piece] if piece in CLOSED_FORMS else (lambda g: (g['volume'], g['enclosing'], g['inradius']))(geometry(piece))
    vals = [(3 * P * v / (4 * math.pi)) ** (1 / 3), Rc] + ([2 * r] if P >= 2 else [])
    return float(max(vals)) * SCORE_PER_RADIUS
