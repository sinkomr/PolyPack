"""The problems of the balls space (packages/balls/src/catalogue.ts) and their elementary lower bounds
(packages/balls/src/problems.ts ballsBound), for the certifier and the record builder. Standard library only.

189 problems: `ballinball`, `ballin<code>` for each of the polyhedra space's 94 solids (balls in that solid, scaled by
s) and `<code>inball` for each of the 94 (the unit-edge solid in a ball), P from 2 to 100. The first 7 (ORIGINAL_CODES)
are the space's first problems; the order of CODES is the TypeScript catalogue's (balls in a ball, then in the
Platonic, Archimedean, Catalan, prism, antiprism, elongated prism, bipyramid and trapezohedron solids, then the solids in
a ball in the same order)."""
import math
import os
import re
import sys

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

# The radius of a ball piece: the one place in this module and the certifier where it is written (packages/balls/src/
# catalogue.ts BALL_RADIUS). An integer, so that the exact checks stay in rationals.
BALL_RADIUS = 1
BALL_DIAMETER = 2 * BALL_RADIUS

MIN_P, MAX_P = 2, 100

_FAMILIES = ['platonic', 'archimedean', 'catalan', 'prism', 'antiprism', 'elongated_prism', 'bipyramid', 'trapezohedron']
_LABEL = {'platonic': 'Platonic solid', 'archimedean': 'Archimedean solid', 'catalan': 'Catalan solid', 'prism': 'prism',
          'antiprism': 'antiprism', 'elongated_prism': 'elongated prism', 'bipyramid': 'bipyramid',
          'trapezohedron': 'trapezohedron'}


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


def geometry(name):
    """Volume, circumradius, inradius, diameter (largest vertex distance) and tangential flag of the canonical solid
    `name` (python/polyhedra/solids_exact.json), from its float vertices and the unit normals through the first vertex
    of each face; the vertex centroid is the origin. The inradius is the least face offset about the origin, and the
    circumradius the largest vertex distance: both about the centroid, which is the centre of the largest inscribed
    and of the smallest enclosing ball of all 94 solids (container.ts in packages/balls). Floats."""
    g = _GEOMETRY.get(name)
    if g is None:
        V, faces = _float_vertices(name)
        offsets = []
        vol = 0.0
        for f in faces:
            a, b, c = V[f[0]], V[f[1]], V[f[2]]
            u = [b[k] - a[k] for k in range(3)]
            w = [c[k] - a[k] for k in range(3)]
            n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
            length = math.hypot(*n)
            off = sum(n[k] * a[k] for k in range(3)) / length
            offsets.append(abs(off))
            for i in range(1, len(f) - 1):
                b, c = V[f[i]], V[f[i + 1]]
                vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                        + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
        diam = max(math.dist(V[i], V[j]) for i in range(len(V)) for j in range(i + 1, len(V)))
        g = {'volume': abs(vol), 'circumradius': max(math.hypot(*v) for v in V), 'inradius': min(offsets),
             'diameter': diam, 'tangential': max(offsets) - min(offsets) < 1e-12}
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
    BALL_RADIUS): volume, in a ball s >= (P)^(1/3) r, in a solid s >= (P 4 pi r^3 / (3 V))^(1/3); one piece, s >= r in
    a ball, s >= 2 r in a cube, s >= r / rho in another solid; two pieces, s >= 2 r in a ball, s >= 2 r + 2 r / sqrt 3
    in a cube, in another solid s >= r / rho + 2 r / D when all its faces are at the inradius rho (D the diameter) and
    always s >= 4 r / D. Solids in a ball: volume, circumradius, twice the inradius."""
    prob = PROBLEMS[code]
    piece, container = prob['piece'], prob['container']
    R, D2 = BALL_RADIUS, BALL_DIAMETER
    if piece == 'ball':
        v = 4 * math.pi * R ** 3 / 3
        if container == 'ball':
            vals = [(3 * P * v / (4 * math.pi)) ** (1 / 3), R] + ([D2] if P >= 2 else [])
        elif container == 'cube':
            vals = [(P * v) ** (1 / 3), D2] + ([D2 + D2 / math.sqrt(3)] if P >= 2 else [])
        else:
            c = geometry(container)
            vals = [(P * v / c['volume']) ** (1 / 3), R / c['inradius']]
            if P >= 2:
                if c['tangential']:
                    vals.append(R / c['inradius'] + D2 / c['diameter'])
                vals.append(2 * D2 / c['diameter'])
        return float(max(vals))
    v, Rc, r = CLOSED_FORMS[piece] if piece in CLOSED_FORMS else (lambda g: (g['volume'], g['circumradius'], g['inradius']))(geometry(piece))
    vals = [(3 * P * v / (4 * math.pi)) ** (1 / 3), Rc] + ([2 * r] if P >= 2 else [])
    return float(max(vals))
