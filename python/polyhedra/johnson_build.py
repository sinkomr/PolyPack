"""Constructions of J1 to J83 (exact, in a tower of quadratic fields). See johnson.py."""
import itertools
from fractions import Fraction as Fr

import numpy as np

import johnson_tower as jt
from johnson_tower import add, sub, mul, inv, sqrt, vadd, vsub, vdot, vcross, vfloat
import johnson_geom as g
from johnson_geom import vscale, attach, analyze, hull, centre

ONE = Fr(1)
UP = (Fr(0), Fr(0), Fr(1))


def key(P):
    """Congruence invariant: sorted pair distances."""
    pts = np.array([vfloat(p) for p in P])
    d = np.linalg.norm(pts[:, None] - pts[None], axis=2)
    return tuple(np.round(np.sort(d.ravel()), 7))


# ------------------------------------------------------------------------------------------------ axial solids
CAPS = {'pyr3': ('pyramid', 3), 'pyr4': ('pyramid', 4), 'pyr5': ('pyramid', 5), 'cup3': ('cupola', 6),
        'cup4': ('cupola', 8), 'cup5': ('cupola', 10), 'rot': ('rotunda', 10), 'prism': ('prism', None),
        'antiprism': ('antiprism', None), 'wedge': ('wedge', 4)}


def top_polygon(kind, P, new):
    """The vertices of a cap that form its top polygon / apex."""
    if kind == 'rotunda': return new[5:]
    return new


def axial(items, shifts):
    """Stack along z: items from the top cap (+z) down; shifts[i] is the gluing shift of items[i] (i >= 1)."""
    kind0, m = CAPS[items[0]]
    base = g.ring(m)
    P = attach(base, list(range(m)), kind0, 0, normal=UP)
    tops = [top_polygon(kind0, P, P[m:])]
    face = [0] + list(range(m - 1, 0, -1))                 # the ring, ccw seen from below
    for it, s in zip(items[1:], shifts):
        kind, _ = CAPS[it]
        n0 = len(P)
        P = attach(P, face, kind, s)
        if kind in ('prism', 'antiprism'):
            face = list(range(n0, n0 + m))
        else:
            tops.append(top_polygon(kind, P, P[n0:]))
    return P, tops


def azimuths(poly):
    return sorted(round(float(np.arctan2(float(jt.approx(p[1])), float(jt.approx(p[0])))) % (2 * np.pi), 6) % round(2 * np.pi, 6)
                  for p in poly)


def aligned(tops):
    """True when the first and last top polygons project onto the same points (ortho), False when rotated (gyro)."""
    a = [(round(float(jt.approx(p[0])), 6), round(float(jt.approx(p[1])), 6)) for p in tops[0]]
    b = [(round(float(jt.approx(p[0])), 6), round(float(jt.approx(p[1])), 6)) for p in tops[-1]]
    return sorted(a) == sorted(b)


def handedness(tops):
    """+1 or -1 for a chiral stack: the angle (anticlockwise seen from +z) from the first top polygon to the nearest vertex of
    the last one, below or above half a step of the polygon; 0 for an achiral stack."""
    az = lambda p: float(np.arctan2(float(jt.approx(p[1])), float(jt.approx(p[0]))))
    k = len(tops[0]); step = 2 * np.pi / k
    a0 = az(tops[0][0])
    d = min(((az(p) - a0) % step) for p in tops[-1])
    if abs(d) < 1e-7 or abs(d - step / 2) < 1e-7 or abs(d - step) < 1e-7: return 0
    return 1 if d < step / 2 else -1


def build_axial(items, want=None):
    """All valid shift choices; returns list of (P, aligned, shifts). want: 'ortho' / 'gyro' / None."""
    out = []
    n = len(items) - 1
    for shifts in itertools.product((0, 1), repeat=n):
        jt.reset()
        P, tops = axial(items, shifts)
        ok, counts = analyze(P)
        if not ok: continue
        out.append((P, aligned(tops) if len(tops) > 1 else None, shifts, counts, key(P), handedness(tops) if len(tops) > 1 else 0))
    if want is not None:
        out = [o for o in out if o[1] == (want == 'ortho')]
    return out


# ------------------------------------------------------------------------------------------------ standard parents
def phi(): return mul(add(1, jt_sqrt5()), Fr(1, 2))
def jt_sqrt5(): return sqrt(Fr(5))


def perms3(v, even=True):
    x, y, z = v
    return [(x, y, z), (y, z, x), (z, x, y)] if even else [(x, y, z), (y, z, x), (z, x, y), (x, z, y), (z, y, x), (y, x, z)]


def signs(v):
    out = []
    for sg in itertools.product((1, -1), repeat=3):
        w = tuple(mul(s, c) for s, c in zip(sg, v))
        out.append(w)
    return out


def dedupe(vs):
    seen, out = set(), []
    for v in vs:
        k = tuple(round(float(jt.approx(c)), 7) for c in v)
        if k not in seen: seen.add(k); out.append(v)
    return out


def dodecahedron():
    f = phi(); fi = inv(f)
    base = [(ONE, ONE, ONE), (Fr(0), fi, f)]
    vs = signs(base[0]) + [w for p in perms3(base[1]) for w in signs(p)]
    return [vscale(v, mul(f, HALF)) for v in dedupe(vs)]


HALF = Fr(1, 2)


def icosahedron():
    f = phi()
    vs = [w for p in perms3((Fr(0), ONE, f)) for w in signs(p)]
    return [vscale(v, HALF) for v in dedupe(vs)]


def trunc_tetrahedron():
    s2 = sqrt(Fr(2))
    vs = []
    for p in set(itertools.permutations((3, 1, 1))):
        for sg in itertools.product((1, -1), repeat=3):
            if sg[0] * sg[1] * sg[2] == 1: vs.append(tuple(mul(Fr(a * b), mul(s2, Fr(1, 4))) for a, b in zip(p, sg)))
    return dedupe(vs)


def trunc_cube():
    s2 = sqrt(Fr(2))
    big = mul(add(1, s2), HALF)
    vs = []
    for p in set(itertools.permutations((0, 1, 1))):
        for sg in itertools.product((1, -1), repeat=3):
            vs.append(tuple(mul(sg[i], HALF if p[i] == 0 else big) for i in range(3)))
    return dedupe(vs)


def trunc_dodecahedron():
    f = phi(); fi = inv(f)
    gens = [(Fr(0), fi, add(2, f)), (fi, f, mul(2, f)), (f, Fr(2), add(f, 1))]
    vs = [w for gv in gens for p in perms3(gv) for w in signs(p)]
    return [vscale(v, mul(f, HALF)) for v in dedupe(vs)]


def rid():
    f = phi()
    f2, f3 = mul(f, f), mul(mul(f, f), f)
    gens = [(ONE, ONE, f3), (f2, f, mul(2, f)), (add(2, f), Fr(0), f2)]
    vs = [w for gv in gens for p in perms3(gv) for w in signs(p)]
    return [vscale(v, HALF) for v in dedupe(vs)]


def prism_base(m):
    jt_ = axial(['pyr3'] if False else [{3: 'cup3'}.get(m, 'prism')], [])  # placeholder (unused)


def make_prism(m):
    base = g.ring(m)
    P = attach(base, list(range(m)), 'prism', 0, normal=UP)
    return P


def fnormal(P, face):
    q = [P[i] for i in face]
    n = vcross(vsub(q[1], q[0]), vsub(q[2], q[0]))
    c = centre(q)
    if float(vdot(n, vsub(c, centre(P)))) < 0: n = vscale(n, Fr(-1))
    return n, c


def unitf(v):
    a = np.array(vfloat(v)); return a / np.linalg.norm(a)


def orient(P, a, b):
    """Rotate (about the origin) so that a points along +z and the component of b perpendicular to a along +x."""
    aa = vdot(a, a)
    e3 = vscale(a, inv(sqrt(aa)))
    bp = vsub(b, vscale(a, mul(vdot(a, b), inv(aa))))
    e1 = vscale(bp, inv(sqrt(vdot(bp, bp))))
    e2 = vcross(e3, e1)
    return [(vdot(p, e1), vdot(p, e2), vdot(p, e3)) for p in P]


def centred(P):
    c = centre(P)
    return [vsub(p, c) for p in P]


def pick_axes(N, pattern, first=0):
    """Indices into the unit-vector list N by pattern: 'one', 'para', 'meta', 'tri' (the icosahedral relations)."""
    A = first
    dots = lambda i, j: float(np.dot(N[i], N[j]))
    para = [j for j in range(len(N)) if dots(A, j) < -0.99]
    meta = [j for j in range(len(N)) if abs(dots(A, j) + 1 / np.sqrt(5)) < 1e-6]
    if pattern == 'one': return [A]
    if pattern == 'para': return [A, para[0]]
    if pattern == 'meta': return [A, meta[0]]
    if pattern == 'tri':
        B = meta[0]
        C = next(j for j in meta if j != B and abs(dots(B, j) + 1 / np.sqrt(5)) < 1e-6)
        return [A, B, C]
    raise ValueError(pattern)


def finish(P, a=None, b=None):
    P = centred(P)
    if a is not None: P = orient(P, a, b)
    return P


# --- prism-based (J49-J57)
def aug_prism(m, idxs):
    P = make_prism(m)
    faces, normals, _ = hull(P)
    sq = [f for f in faces if len(f) == 4]
    ang = lambda f: float(np.arctan2(*np.array(vfloat(fnormal(P, f)[0]))[[1, 0]])) % (2 * np.pi)
    sq.sort(key=ang)
    sel = [sq[i] for i in idxs]
    Q = P
    for f in sel: Q = attach(Q, f, 'pyramid', 0)
    ns = [fnormal(P, f) for f in sel]
    return P, Q, ns


def j_prism(m, idxs):
    P, Q, ns = aug_prism(m, idxs)
    ok, counts = analyze(Q)
    assert ok, (m, idxs)
    k = len(idxs)
    n = [x[0] for x in ns]
    if k == 1 or (k == 3 and m == 3 and False): a, b = n[0], vcross(n[0], UP)
    if k == 1: a = n[0]; b = UP
    elif k == 2: a = vadd(n[0], n[1]); b = vsub(n[0], n[1])
    else:
        a = UP; b = n[0]
    if k == 2 and max(abs(x) for x in vfloat(vadd(n[0], n[1]))) < 1e-9:
        a, b = n[0], UP
    return finish(Q, a, b)


# --- icosahedral families
def j_dodeca(pattern):
    D = dodecahedron()
    faces, normals, _ = hull(D)
    N = [np.array(x) / np.linalg.norm(x) for x in normals]
    ax = pick_axes(N, pattern)
    Q = D
    for i in ax: Q = attach(Q, faces[i], 'pyramid', 0)
    ok, _ = analyze(Q); assert ok
    ns = [fnormal(D, faces[i]) for i in ax]
    return finish(Q, *orient_args(pattern, ns, D, faces, ax))


def orient_args(pattern, ns, P, faces, ax):
    n = [x[0] for x in ns]
    if pattern == 'one' or pattern == 'para':
        return n[0], vsub(P[faces[ax[0]][0]], ns[0][1])
    if pattern == 'meta': return vadd(n[0], n[1]), vsub(n[0], n[1])
    return vadd(vadd(n[0], n[1]), n[2]), n[0]


def j_icosa(pattern):
    I = icosahedron()
    N = [np.array(vfloat(v)) / np.linalg.norm(vfloat(v)) for v in I]
    ax = pick_axes(N, pattern)
    keep = [v for i, v in enumerate(I) if i not in ax]
    n = [I[i] for i in ax]
    return keep, n


def j_dim_icosa(pattern, augment=False):
    keep, n = j_icosa(pattern)
    Q = keep
    if augment:
        faces, _, _ = hull(Q)
        tri = [f for f in faces if len(f) == 3]
        good = []
        for f in tri:
            R = attach(Q, f, 'pyramid', 0)
            ok, cnt = analyze(R)
            if ok: good.append((R, key(R)))
        assert good and all(x[1] == good[0][1] for x in good), len(good)
        Q = good[0][0]
    ok, _ = analyze(Q); assert ok
    if pattern == 'meta': a, b = vadd(n[0], n[1]), vsub(n[0], n[1])
    else: a, b = vadd(vadd(n[0], n[1]), n[2]), n[0]
    return finish(Q, a, b)


def pick_valid(P, face, kind):
    good = []
    for s in (0, 1):
        R = attach(P, face, kind, s)
        ok, cnt = analyze(R)
        if ok: good.append(R)
    assert len(good) == 1, len(good)
    return good[0]


def j_trunc(parent, kind, nsides, pattern):
    P = {'tt': trunc_tetrahedron, 'tc': trunc_cube, 'td': trunc_dodecahedron}[parent]()
    faces, normals, _ = hull(P)
    idx = [i for i, f in enumerate(faces) if len(f) == nsides]
    N = [np.array(normals[i]) for i in idx]
    ax = [idx[i] for i in pick_axes(N, pattern)]
    Q = P
    for i in ax: Q = pick_valid(Q, faces[i], kind) if False else Q
    for i in ax:
        Q = attach_valid(Q, faces[i], kind)
    ns = [fnormal(P, faces[i]) for i in ax]
    return finish(Q, *orient_args(pattern, ns, P, faces, ax))


def attach_valid(Q, face, kind):
    good = []
    for s in (0, 1):
        R = attach(Q, face, kind, s)
        ok, _ = analyze(R)
        if ok: good.append(R)
    assert len(good) == 1, len(good)
    return good[0]


def j_rid(spec, orient_kind):
    """spec: list of ('dim'|'gyro') per chosen axis; axes chosen by pattern in orient_kind=(pattern, order)."""
    pattern, roles = orient_kind
    R = rid()
    faces, normals, _ = hull(R)
    pent = [i for i, f in enumerate(faces) if len(f) == 5]
    N = [np.array(normals[i]) for i in pent]
    ax = [pent[i] for i in pick_axes(N, pattern)]
    removed = set()
    for i in ax: removed |= set(faces[i])
    keep_idx = [i for i in range(len(R)) if i not in removed]
    Q = [R[i] for i in keep_idx]
    fq, nq, _ = hull(Q)
    for i, role in zip(ax, roles):
        if role != 'gyro': continue
        nvec = np.array(normals[i])
        f = next(f for f, nn in zip(fq, nq) if len(f) == 10 and np.dot(nn, nvec) > 0.99)
        orig = sorted(tuple(np.round(vfloat(R[j]), 6)) for j in faces[i])
        cands = []
        for s in (0, 1):
            Rn = attach(Q, f, 'cupola', s)
            new = sorted(tuple(np.round(vfloat(p), 6)) for p in Rn[len(Q):])
            cands.append((new == orig, Rn))
        gy = [r for same, r in cands if not same]
        assert len(gy) == 1
        Q = gy[0]
    ok, _ = analyze(Q); assert ok, 'rid'
    ns = [fnormal(R, faces[i]) for i in ax]
    n = [x[0] for x in ns]
    if pattern == 'one': a, b = n[0], vsub(R[faces[ax[0]][0]], ns[0][1])
    elif pattern == 'para': a, b = n[0], vsub(R[faces[ax[0]][0]], ns[0][1])
    elif pattern == 'meta':
        if roles[0] != roles[1]: a, b = n[0], n[1]
        else: a, b = vadd(n[0], n[1]), vsub(n[0], n[1])
    else:
        if len(set(roles)) == 1: a, b = vadd(vadd(n[0], n[1]), n[2]), n[0]
        else:
            odd = [i for i in range(3) if roles.count(roles[i]) == 1][0]
            others = [i for i in range(3) if i != odd]
            a, b = n[odd], vadd(n[others[0]], n[others[1]])
    return finish(Q, a, b)
