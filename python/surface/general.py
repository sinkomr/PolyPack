"""Certifier for packings on the general convex polyhedral surfaces: the 13 Archimedean and 13 Catalan solids, the prisms
with 3 and 5 to 12 sides and the antiprisms with 4 to 12 sides (the five Platonic solids keep their
exact path in cert.py and geom.py).

Built independently of the TypeScript code, from the polyhedra space's exact solids
(python/polyhedra/solids_exact.json): every vertex coordinate is an exact element of a real number
field Q(alpha) (alpha given by its minimal polynomial and an isolating rational interval), times
1/sqrt(D) for the duals of the snub solids.

Exact checks of each solid (numfield.El arithmetic, exact signs): the faces are planar convex
polygons, counter-clockwise seen from outside; every other vertex lies strictly inside every face
plane; every directed edge occurs once, so the faces glue into a closed surface; Euler's formula.
Archimedean, prism and antiprism faces are checked to be regular with their centre at the foot of the
perpendicular from the origin. Interval checks: every cone angle is at least pi (the boundary rule
of docs/spaces/SURFACE, section 1, needs it; a solid with a sharper vertex is refused).

Face frames (as in packages/surface/src/solids.ts): the origin is the foot of the perpendicular
from the solid's centre to the face plane, and the last edge (frame vertex M - 1 to 0) runs along +x
at the bottom. The foot is exact in the field; frame coordinates are exact field elements divided
by square roots of field elements, enclosed in mpmath intervals at 128 bits, and so are the gluing
motions (rotation as an interval cosine and sine, translation) and their compositions.

Decisions (see the docstring of cert.py for what is certified):
- Wedge boundaries are rays from the piece centre through developed vertices, each with a key
  naming the developed vertex; two rays with the same key are the same ray (a vertex shared by
  consecutive crossed edges is inherited, not recomputed). Every other orientation test is decided
  by intervals; one that intervals cannot decide (the centre exactly in line with two developed
  vertices, or on the line of an unfolded edge) raises CertError: such degenerate configurations
  are refused, never guessed.
- Prunings of chains are made only when certain (an edge certainly beyond reach, the centre
  certainly beyond the edge line, the turn rule certainly broken: the faces passed around a vertex
  have face angles summing to at least pi, decided exactly for regular faces); otherwise the chain
  is kept, which only adds checks.
- Cone points and disk images are skipped only when certainly outside the closed wedge.
- fold mode first tries the nofold certificate: a configuration whose scaled pieces lie strictly
  inside their anchor faces, pairwise disjoint on each face, is a fold packing (each piece's
  development is the piece itself; docs/spaces/SURFACE, section 2.2).
"""

import json
import math
import os
from fractions import Fraction as Fr

from mpmath import iv

from numfield import El, Field

HERE = os.path.dirname(os.path.abspath(__file__))
SOLIDS_EXACT = os.path.join(HERE, "..", "polyhedra", "solids_exact.json")

ARCHIMEDEAN = ("truncated_tetrahedron", "cuboctahedron", "truncated_cube", "truncated_octahedron",
               "rhombicuboctahedron", "truncated_cuboctahedron", "snub_cube", "icosidodecahedron",
               "truncated_dodecahedron", "truncated_icosahedron", "rhombicosidodecahedron",
               "truncated_icosidodecahedron", "snub_dodecahedron")
CATALAN = ("triakis_tetrahedron", "rhombic_dodecahedron", "triakis_octahedron", "tetrakis_hexahedron",
           "deltoidal_icositetrahedron", "disdyakis_dodecahedron", "pentagonal_icositetrahedron",
           "rhombic_triacontahedron", "triakis_icosahedron", "pentakis_dodecahedron",
           "deltoidal_hexecontahedron", "disdyakis_triacontahedron", "pentagonal_hexecontahedron")
PRISMS = tuple("prism%d" % n for n in (3, 5, 6, 7, 8, 9, 10, 11, 12))
ANTIPRISMS = tuple("antiprism%d" % n for n in range(4, 13))
GENERAL_SOLIDS = ARCHIMEDEAN + CATALAN + PRISMS + ANTIPRISMS

# filled lazily by load_data()
_DATA = None
# precision of the frame computation (the frames are then kept at the working precision)
FRAME_PREC = 320


class SolidError(Exception):
    pass


def load_data(path=SOLIDS_EXACT):
    global _DATA
    if _DATA is None:
        with open(path) as fh:
            _DATA = json.load(fh)
    return _DATA


# --------------------------------------------------------------------------- the field of a solid

def _peval(p, x):
    v = Fr(0)
    for c in reversed(p):
        v = v * x + c
    return v


def make_field(name, minpoly, interval):
    """numfield.Field for Q(alpha), alpha the root of `minpoly` in the isolating interval."""
    p = [Fr(c) for c in minpoly]
    if p[-1] != 1:
        p = [c / p[-1] for c in p]
    lo, hi = Fr(interval[0]), Fr(interval[1])
    if len(p) == 2:
        root = -p[0]
        return Field(name, p, lambda: iv.mpf(root.numerator) / root.denominator)
    plo = _peval(p, lo)
    phi = _peval(p, hi)
    if plo == 0 or phi == 0 or (plo > 0) == (phi > 0):
        raise SolidError("%s: the isolating interval does not bracket a sign change" % name)
    cache = {}

    def enclosure():
        prec = iv.prec
        if prec in cache:
            return cache[prec]
        a, b, pa = lo, hi, plo
        # bisect with exact rational signs until the width is below 2^-(prec + 8)
        width = Fr(1, 2 ** (prec + 8))
        while b - a > width:
            m = (a + b) / 2
            pm = _peval(p, m)
            if pm == 0:
                a = b = m
                break
            if (pm > 0) == (pa > 0):
                a, pa = m, pm
            else:
                b = m
        # the hull of the outward-rounded enclosures of a and b
        out = iv.mpf([(iv.mpf(a.numerator) / a.denominator).a, (iv.mpf(b.numerator) / b.denominator).b])
        cache[prec] = out
        return out

    return Field(name, p, enclosure)


def ivq(q):
    """Interval of a rational (exact for the dyadic rationals of floats)."""
    q = Fr(q)
    return iv.mpf(q.numerator) / q.denominator


def _ivx(x):
    """Interval of an exact field element (current precision)."""
    return x.to_iv()


def _sub3(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot3(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross3(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def canonical_cycle(c):
    m = c.index(min(c))
    return list(c[m:]) + list(c[:m])


# --------------------------------------------------------------------------- interval plane geometry

class IRigid:
    """p -> R p + t with R = [[c, -s], [s, c]] (intervals containing the exact motion)."""

    __slots__ = ("c", "s", "tx", "ty")

    def __init__(self, c, s, tx, ty):
        self.c, self.s, self.tx, self.ty = c, s, tx, ty

    def apply(self, p):
        return (self.c * p[0] - self.s * p[1] + self.tx, self.s * p[0] + self.c * p[1] + self.ty)

    def rot(self, v):
        return (self.c * v[0] - self.s * v[1], self.s * v[0] + self.c * v[1])

    def rot_inv(self, v):
        return (self.c * v[0] + self.s * v[1], -self.s * v[0] + self.c * v[1])

    def compose(self, B):
        """self after B."""
        c = self.c * B.c - self.s * B.s
        s = self.s * B.c + self.c * B.s
        tx, ty = self.apply((B.tx, B.ty))
        return IRigid(c, s, tx, ty)

    def inverse(self):
        tx, ty = self.rot_inv((self.tx, self.ty))
        return IRigid(self.c, -self.s, -tx, -ty)


def identity():
    return IRigid(iv.mpf(1), iv.mpf(0), iv.mpf(0), iv.mpf(0))


def icross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def isub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def idot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def sign_iv(x):
    """1, -1, or 0 when the interval contains 0 (undecided)."""
    if x.a > 0:
        return 1
    if x.b < 0:
        return -1
    return 0


# --------------------------------------------------------------------------- the solid

class GeneralSolid:
    """A convex polyhedral surface from solids_exact.json, with interval frames and gluings."""

    def __init__(self, name, data=None):
        data = data or load_data()
        if name not in data:
            raise SolidError("unknown solid %r" % (name,))
        d = data[name]
        self.name = name
        F = make_field(name, d["minpoly"], d["interval"])
        self.field = F

        def el(coeffs):
            return El(F, tuple(Fr(c) for c in coeffs) + (Fr(0),) * (F.d - len(coeffs)))

        pts = [tuple(el(c) for c in v) for v in d["V"]]
        # the common scale 1/sqrt(D) of the snub duals (an interval; exact checks use pts unscaled)
        self._D = el(d["D"]) if d.get("D") else None
        self.pts = pts
        self.V = len(pts)
        faces = sorted(canonical_cycle(f) for f in d["faces"])
        self.faces = faces
        self.F = len(faces)
        self.sides = [len(f) for f in faces]
        self.E = sum(self.sides) // 2
        self._check_exact()
        directed = {}
        for fi, f in enumerate(faces):
            for k in range(len(f)):
                key = (f[k], f[(k + 1) % len(f)])
                if key in directed:
                    raise SolidError("%s: directed edge %r twice" % (name, key))
                directed[key] = (fi, k)
        self.adj = []
        for fi, f in enumerate(faces):
            row = []
            for k in range(len(f)):
                r = directed.get((f[(k + 1) % len(f)], f[k]))
                if r is None:
                    raise SolidError("%s: unglued edge" % name)
                row.append(r)
            self.adj.append(row)
        if self.V - self.E + self.F != 2:
            raise SolidError("%s: Euler characteristic" % name)
        self.regular = [name in ARCHIMEDEAN or name.startswith("prism") or name.startswith("antiprism") for _ in faces]
        if any(self.regular):
            self._check_regular()
        self._build_frames()
        self._build_angles()
        self._glue_cache = {}

    # exact structure ------------------------------------------------------
    def _check_exact(self):
        pts = self.pts
        for fi, f in enumerate(self.faces):
            P = [pts[v] for v in f]
            n = len(P)
            nrm = _cross3(_sub3(P[1], P[0]), _sub3(P[2], P[0]))
            for k in range(3, n):
                if not _dot3(nrm, _sub3(P[k], P[0])).is_zero():
                    raise SolidError("%s: face %d is not planar" % (self.name, fi))
            for k in range(n):
                e = _sub3(P[(k + 1) % n], P[k])
                for j in range(n):
                    if j in (k, (k + 1) % n):
                        continue
                    # convex and counter-clockwise seen from outside: every other vertex lies strictly
                    # left of every edge, i.e. (edge x (vertex - start)) points outward, away from the
                    # origin (which the next test shows to be strictly inside every face plane)
                    if _dot3(_cross3(e, _sub3(P[j], P[k])), P[0]).sign() <= 0:
                        raise SolidError("%s: face %d is not convex and counter-clockwise from outside" % (self.name, fi))
            for v in range(self.V):
                if v in f:
                    continue
                if _dot3(nrm, _sub3(pts[v], P[0])).sign() * _dot3(nrm, P[0]).sign() >= 0:
                    raise SolidError("%s: vertex %d is not strictly inside the plane of face %d" % (self.name, v, fi))

    def _check_regular(self):
        """Regular unit-edge faces: all vertices equidistant from the vertex centroid, which is
        the foot of the perpendicular from the origin. Raw edges have squared length D when
        the source coordinates carry the common scale 1/sqrt(D)."""
        pts = self.pts
        for fi, f in enumerate(self.faces):
            P = [pts[v] for v in f]
            n = len(P)
            e0 = _sub3(P[1], P[0])
            L2 = _dot3(e0, e0)
            if not (L2 - (self._D if self._D is not None else 1)).is_zero():
                raise SolidError("%s: face %d does not have unit edges" % (self.name, fi))
            cen = tuple(sum((p[t] for p in P[1:]), P[0][t]) / n for t in range(3))
            r2 = _dot3(_sub3(P[0], cen), _sub3(P[0], cen))
            for k in range(n):
                e = _sub3(P[(k + 1) % n], P[k])
                if not (_dot3(e, e) - L2).is_zero():
                    raise SolidError("%s: face %d is not equilateral" % (self.name, fi))
                w = _sub3(P[k], cen)
                if not (_dot3(w, w) - r2).is_zero():
                    raise SolidError("%s: face %d is not concyclic" % (self.name, fi))
                if not _dot3(cen, _sub3(P[k], P[0])).is_zero():
                    raise SolidError("%s: face %d is not centred at the foot" % (self.name, fi))

    # frames ---------------------------------------------------------------
    def _build_frames(self):
        """Frame coordinates, computed at FRAME_PREC bits (the field elements of the high-degree
        fields carry large coefficients) and kept as intervals at the working precision."""
        work = iv.prec
        iv.prec = FRAME_PREC
        try:
            self._build_frames_at()
        finally:
            iv.prec = work
        self.unit = [[(+x, +y) for x, y in face] for face in self.unit]
        self.scale_iv = +self.scale_iv

    def _build_frames_at(self):
        pts = self.pts
        self.scale_iv = iv.mpf(1) if self._D is None else 1 / iv.sqrt(_ivx(self._D))
        lam = self.scale_iv
        self.unit = []  # per face: list of (x, y) intervals at scale 1
        for f in self.faces:
            P = [pts[v] for v in f]
            n = len(P)
            nrm = (P[0][0] * 0, P[0][1] * 0, P[0][2] * 0)
            for k in range(n):
                c = _cross3(P[k], P[(k + 1) % n])
                nrm = (nrm[0] + c[0], nrm[1] + c[1], nrm[2] + c[2])
            nn = _dot3(nrm, nrm)
            foot = tuple(x * (_dot3(nrm, P[0]) / nn) for x in nrm)
            e = _sub3(P[0], P[n - 1])
            ee = _dot3(e, e)
            ey3 = _cross3(nrm, e)
            inv_e = 1 / iv.sqrt(_ivx(ee))
            inv_ne = 1 / iv.sqrt(_ivx(nn) * _ivx(ee))
            verts = []
            for p in P:
                w = _sub3(p, foot)
                verts.append((lam * _ivx(_dot3(w, e)) * inv_e, lam * _ivx(_dot3(w, ey3)) * inv_ne))
            self.unit.append(verts)

    def frame_vertex(self, s, f, k):
        """Frame vertex k of face f at scale s (a Fraction or an interval)."""
        x, y = self.unit[f][k % self.sides[f]]
        si = ivq(s) if isinstance(s, (Fr, int)) else s
        return (si * x, si * y)

    def _build_angles(self):
        """Corner angles (intervals; exact multiples of pi for regular faces) and cone angles."""
        self.corner = []
        self.corner_pi = []  # exact Fraction of pi for regular faces, else None
        for fi, f in enumerate(self.faces):
            n = len(f)
            row = []
            for k in range(n):
                a = self.unit[fi][(k - 1) % n]
                b = self.unit[fi][k]
                c = self.unit[fi][(k + 1) % n]
                u = isub(a, b)
                v = isub(c, b)
                row.append(iv.atan2(icross(v, u), idot(u, v)))
            self.corner.append(row)
            self.corner_pi.append([Fr(n - 2, n)] * n if self.regular[fi] else None)
        cone = [iv.mpf(0)] * self.V
        for fi, f in enumerate(self.faces):
            for k, v in enumerate(f):
                cone[v] = cone[v] + self.corner[fi][k]
        self.cone = cone
        for v, c in enumerate(cone):
            if not (c - iv.pi).a >= 0:
                raise SolidError("%s: cone angle at vertex %d is not certainly >= pi" % (self.name, v))
            if not (c - 2 * iv.pi).b < 0:
                raise SolidError("%s: cone angle at vertex %d is not below 2 pi" % (self.name, v))

    # gluing ---------------------------------------------------------------
    def glue(self, s, f, k):
        """(g, l, T): T maps the frame of the face g glued to edge k of f into f's frame (unfolded)."""
        key = (s, f, k)
        hit = self._glue_cache.get(key)
        if hit is not None:
            return hit
        g, l = self.adj[f][k]
        A0 = self.frame_vertex(s, f, k)
        A1 = self.frame_vertex(s, f, k + 1)
        B0 = self.frame_vertex(s, g, l)
        B1 = self.frame_vertex(s, g, l + 1)
        dg = isub(B1, B0)
        mdf = isub(A0, A1)
        L2 = iv.sqrt(idot(dg, dg) * idot(mdf, mdf))
        c = idot(dg, mdf) / L2
        sn = icross(dg, mdf) / L2
        R = IRigid(c, sn, iv.mpf(0), iv.mpf(0))
        q = R.apply(B1)
        T = IRigid(c, sn, A0[0] - q[0], A0[1] - q[1])
        out = (g, l, T)
        self._glue_cache[key] = out
        return out


_CACHE = {}


def get_general(name):
    if name not in GENERAL_SOLIDS:
        raise SolidError("unknown solid %r" % (name,))
    if name not in _CACHE:
        _CACHE[name] = GeneralSolid(name)
    return _CACHE[name]


# --------------------------------------------------------------------------- chains with keyed rays

class Ray:
    """A ray from the piece centre: direction vector (intervals) and the key of its developed vertex."""

    __slots__ = ("v", "key")

    def __init__(self, v, key):
        self.v = v
        self.key = key


class Undecided(Exception):
    pass


def orient(a, b):
    """Sign of cross(a, b) for rays; 0 for the same developed vertex; Undecided otherwise when the
    intervals cannot tell."""
    if a.key == b.key:
        return 0
    sg = sign_iv(icross(a.v, b.v))
    if sg == 0:
        raise Undecided("the piece centre is in line with two developed vertices")
    return sg


def in_closed_wedge(W, r):
    lo, hi = W
    return orient(lo, r) >= 0 and orient(r, hi) >= 0


def intersect(W, lo2, hi2):
    """Intersection of the closed wedge W (None: all directions) with the cone (lo2, hi2), both of
    width below pi; None unless it has positive width."""
    if W is None:
        nlo, nhi = lo2, hi2
    else:
        lo1, hi1 = W
        if in_closed_wedge(W, lo2):
            nlo = lo2
        elif in_closed_wedge((lo2, hi2), lo1):
            nlo = lo1
        else:
            return None
        if in_closed_wedge(W, hi2):
            nhi = hi2
        elif in_closed_wedge((lo2, hi2), hi1):
            nhi = hi1
        else:
            return None
    if nlo.key == nhi.key:
        return None  # width 0: one ray through a vertex, which no vertex-avoiding ray follows
    sg = sign_iv(icross(nlo.v, nhi.v))
    if sg > 0:
        return (nlo, nhi)
    if sg < 0:
        return None
    raise Undecided("a wedge of width 0 or pi between different vertices")


def certainly_outside(W, r):
    """True only when the ray is certainly outside the closed wedge (W is not None)."""
    lo, hi = W
    for a, b in ((lo, r), (r, hi)):
        if a.key == b.key:
            continue
        if icross(a.v, b.v).b < 0:
            return True
    return False


def point_certainly_outside(W, c, p):
    """The point p (anchor frame) is certainly outside the closed wedge W with apex c."""
    if W is None:
        return False
    return certainly_outside(W, Ray(isub(p, c), ("point",)))


class GNode:
    __slots__ = ("face", "T", "W", "entry", "depth", "parent", "run_v", "run_n", "run_pi", "run_iv", "verts", "path")


def _seg_dist_sq_lower(c, A, B):
    """A lower bound (interval) on the squared distance from c to the segment AB."""
    e = isub(B, A)
    w = isub(c, A)
    t = idot(w, e)
    L2 = idot(e, e)
    if t.b <= 0:
        return idot(w, w)
    if (t - L2).a >= 0:
        v = isub(c, B)
        return idot(v, v)
    # the distance to the line never exceeds the distance to the segment
    cr = icross(e, w)
    return cr * cr / L2


def enumerate_chains(S, s, anchor, c, reach_sq, max_chains, max_depth):
    """Every chain a vertex-avoiding ray of length <= reach from c can follow (a superset)."""
    root = GNode()
    root.face, root.T, root.W, root.entry, root.depth, root.parent = anchor, identity(), None, -1, 0, -1
    root.run_v, root.run_n, root.run_pi, root.run_iv, root.path = -1, 0, Fr(0), iv.mpf(0), ()
    root.verts = [(S.frame_vertex(s, anchor, k), (0, k)) for k in range(S.sides[anchor])]
    out = [root]
    i = 0
    from cert import CertError  # noqa: E402 (cert imports this module lazily)

    while i < len(out):
        node = out[i]
        i += 1
        if node.depth >= max_depth:
            raise CertError("chain depth limit")
        if len(out) > max_chains:
            raise CertError("more than %d chains for one piece (piece far too large for the solid)" % max_chains)
        M = S.sides[node.face]
        for k in range(M):
            if k == node.entry:
                continue
            (A, keyA) = node.verts[k]
            (B, keyB) = node.verts[(k + 1) % M]
            side = sign_iv(icross(isub(B, A), isub(c, A)))
            if side < 0:
                continue  # c strictly beyond this edge's line: no ray from c crosses it outward
            if side == 0:
                raise CertError("degenerate configuration: a piece centre lies on the line of an unfolded edge")
            if (_seg_dist_sq_lower(c, A, B) - reach_sq).a > 0:
                continue
            run_v, run_n, run_pi, run_iv = -1, 0, Fr(0), iv.mpf(0)
            if node.entry >= 0:
                local = None
                if k == (node.entry + 1) % M:
                    local = k
                elif k == (node.entry - 1) % M:
                    local = node.entry
                if local is not None:
                    run_v = S.faces[node.face][local]
                    same = run_v == node.run_v
                    run_n = node.run_n + 1 if same else 1
                    # turn rule: the faces passed around one vertex have angles summing below pi
                    exact = S.corner_pi[node.face]
                    if exact is not None and (not same or node.run_pi is not None):
                        run_pi = (node.run_pi if same else Fr(0)) + exact[local]
                    else:
                        run_pi = None
                    run_iv = (node.run_iv if same else iv.mpf(0)) + S.corner[node.face][local]
                    if run_pi is not None:
                        if run_pi >= 1:
                            continue
                    elif (run_iv - iv.pi).a >= 0:
                        continue
            lo = Ray(isub(A, c), keyA)
            hi = Ray(isub(B, c), keyB)
            for r in (lo, hi):
                if r.v[0].a <= 0 <= r.v[0].b and r.v[1].a <= 0 <= r.v[1].b:
                    raise CertError("a piece centre may be at a vertex")
            try:
                W = intersect(node.W, lo, hi)
            except Undecided as e:
                raise CertError("degenerate configuration: %s" % e)
            if W is None:
                continue
            g, l, G = S.glue(s, node.face, k)
            child = GNode()
            child.face, child.T, child.W, child.entry = g, node.T.compose(G), W, l
            child.depth, child.parent = node.depth + 1, i - 1
            child.run_v, child.run_n, child.run_pi, child.run_iv = run_v, run_n, run_pi, run_iv
            child.path = node.path + ((node.face, k),)
            Mg = S.sides[g]
            verts = []
            idx = len(out)
            for j in range(Mg):
                if j == (l + 1) % Mg:
                    verts.append((A, keyA))  # g's vertex l + 1 is f's vertex k
                elif j == l:
                    verts.append((B, keyB))  # g's vertex l is f's vertex k + 1
                else:
                    verts.append((child.T.apply(S.frame_vertex(s, g, j)), (idx, j)))
            child.verts = verts
            out.append(child)
    return out


# --------------------------------------------------------------------------- certification

def face_cons(S, s, f):
    """Interval half-planes a.x <= b of face f in its frame, labelled ("F", j)."""
    out = []
    M = S.sides[f]
    for j in range(M):
        A = S.frame_vertex(s, f, j)
        B = S.frame_vertex(s, f, j + 1)
        e = isub(B, A)
        a = (e[1], -e[0])
        out.append((("F", j), a[0], a[1], idot(a, A)))
    return out


def build_part(N, lam, R_iv, r_iv, c, theta, node, piece, chain):
    from cert import PartData, ivf

    Tinv = node.T.inverse()
    cF = Tinv.apply(c)
    lam_iv = ivf(lam)
    th = ivf(theta)
    cons = []
    for k in range(N):
        phi = th + iv.pi / 2 + iv.pi / N + 2 * iv.pi * k / N
        ax, ay = node.T.rot_inv((iv.cos(phi), iv.sin(phi)))
        cons.append((("P", k), ax, ay, ax * cF[0] + ay * cF[1] + lam_iv * r_iv))
    if node.W is not None:
        lo = node.T.rot_inv(node.W[0].v)
        hi = node.T.rot_inv(node.W[1].v)
        a1 = (lo[1], -lo[0])
        a2 = (-hi[1], hi[0])
        cons.append((("W", 0), a1[0], a1[1], idot(a1, cF)))
        cons.append((("W", 1), a2[0], a2[1], idot(a2, cF)))
    p = PartData()
    p.piece, p.chain, p.face = piece, chain, node.face
    p.c_iv = cF
    p.rho = lam_iv * R_iv
    p.cons = cons
    # float polygon for the (untrusted) witness search
    cfx, cfy = float(cF[0].mid), float(cF[1].mid)
    thf = float(theta) - math.atan2(float(node.T.s.mid), float(node.T.c.mid))
    Rf = float(lam) * float(R_iv.mid)
    poly, labels = [], []
    for k in range(N):
        a = thf + math.pi / 2 + 2 * math.pi * k / N
        poly.append((cfx + Rf * math.cos(a), cfy + Rf * math.sin(a)))
        labels.append(("P", k))
    p.poly, p.labels = poly, labels
    return p


def root_node(S, s, f):
    n = GNode()
    n.face, n.T, n.W, n.entry, n.depth, n.parent = f, identity(), None, -1, 0, -1
    n.run_v, n.run_n, n.run_pi, n.run_iv, n.path = -1, 0, Fr(0), iv.mpf(0), ()
    n.verts = [(S.frame_vertex(s, f, k), (0, k)) for k in range(S.sides[f])]
    return n


def certify_nofold(cfg, lam):
    from cert import CertError, certify_pair, ivf, piece_radii, pos, sig_down

    S, s, N = cfg.S, cfg.s, cfg.N
    R_iv, r_iv, _ = piece_radii(N)
    lam_iv = ivf(lam)
    fcons = [face_cons(S, s, f) for f in range(S.F)]
    walls, pairs, by_face = [], [], {}
    for i, (f, x, y, th) in enumerate(cfg.poses):
        by_face.setdefault(f, []).append(i)
        cx, cy = ivf(x), ivf(y)
        worst = None
        if N == 0:
            for lab, ax, ay, b in fcons[f]:
                gap = b - (ax * cx + ay * cy) - lam_iv * iv.sqrt(ax * ax + ay * ay) / 2  # radius lam / 2
                if not pos(gap):
                    raise CertError("disk %d is not strictly inside face %d (edge %d)" % (i, f, lab[1]))
                g = float(gap.a) / math.hypot(float(ax.mid), float(ay.mid))
                worst = g if worst is None else min(worst, g)
        else:
            for k in range(N):
                ang = ivf(th) + iv.pi / 2 + 2 * iv.pi * k / N
                vx = cx + lam_iv * R_iv * iv.cos(ang)
                vy = cy + lam_iv * R_iv * iv.sin(ang)
                for lab, ax, ay, b in fcons[f]:
                    gap = b - (ax * vx + ay * vy)
                    if not pos(gap):
                        raise CertError("piece %d vertex %d is not strictly inside face %d (edge %d)" % (i, k, f, lab[1]))
                    g = float(gap.a) / math.hypot(float(ax.mid), float(ay.mid))
                    worst = g if worst is None else min(worst, g)
        walls.append(sig_down(worst))
    for f, ids in by_face.items():
        for u in range(len(ids)):
            for v in range(u + 1, len(ids)):
                i, j = ids[u], ids[v]
                pi, pj = cfg.poses[i], cfg.poses[j]
                if N == 0:
                    dx, dy = ivf(pi[1]) - ivf(pj[1]), ivf(pi[2]) - ivf(pj[2])
                    gap = dx * dx + dy * dy - lam_iv * lam_iv
                    if not pos(gap):
                        raise CertError("disks %d and %d are not strictly separated" % (i, j))
                    pairs.append([f, i, j, "dist", sig_down(float(gap.a))])
                    continue
                parts = []
                for idx, pp in ((i, pi), (j, pj)):
                    node = root_node(S, s, f)
                    parts.append(build_part(N, lam, R_iv, r_iv, (ivf(pp[1]), ivf(pp[2])), pp[3], node, idx, 0))
                pairs.append(certify_pair(parts[0], parts[1], [], f))
    return {"wall_clearance_min": min(walls), "pairs": pairs, "summary": {"pairs": len(pairs), "walls": len(walls)}}


def certify_fold(cfg, lam):
    from cert import (FAST_EMPTY_N, MAX_CHAINS, MAX_DEPTH, CertError, brute_witness, certify_pair, clip_part,
                      face_float_polygon, fast_empty_witness, farkas_value, float_cons, ivf, piece_radii, pos,
                      round_mults, sig_down)

    S, s, N = cfg.S, cfg.s, cfg.N
    for i, (f, x, y, th) in enumerate(cfg.poses):
        c = (ivf(x), ivf(y))
        for lab, ax, ay, b in face_cons(S, s, f):
            if not (b - (ax * c[0] + ay * c[1])).a >= 0:
                raise CertError("centre of piece %d is not certainly in its face %d" % (i, f))
    # a packing whose pieces lie inside their faces is a fold packing (docs/spaces/SURFACE, 2.2)
    try:
        body = certify_nofold(cfg, lam)
        body["method"] = "inside_faces"
        return body
    except CertError:
        pass
    if N == 0:
        return certify_fold_disks(cfg, lam)
    R_iv, r_iv, _ = piece_radii(N)
    reach_sq = (ivf(lam) * R_iv) ** 2
    fcons_iv = [face_cons(S, s, f) for f in range(S.F)]
    by_face, cone_rows, empty_rows, chain_counts = {}, [], [], []
    for i, (f, x, y, th) in enumerate(cfg.poses):
        c = (ivf(x), ivf(y))
        root = root_node(S, s, f)
        root_part = build_part(N, lam, R_iv, r_iv, c, th, root, i, 0)
        for k in range(S.sides[f]):
            vx, vy = S.frame_vertex(s, f, k)
            if not any(pos(ax * vx + ay * vy - b) for lab, ax, ay, b in root_part.cons if lab[0] == "P"):
                raise CertError("cone point %d of face %d may lie in piece %d (anchor face)" % (k, f, i))
        nodes = enumerate_chains(S, s, f, c, reach_sq, MAX_CHAINS, MAX_DEPTH)
        chain_counts.append(len(nodes))
        worst_cone = None
        for ci, node in enumerate(nodes):
            part = build_part(N, lam, R_iv, r_iv, c, th, node, i, ci)
            for k, (V, key) in enumerate(node.verts):
                if node.W is not None and certainly_outside(node.W, Ray(isub(V, c), key)):
                    continue
                vx, vy = S.frame_vertex(s, node.face, k)
                best = None
                for lab, ax, ay, b in part.cons:
                    if lab[0] != "P":
                        continue
                    g = ax * vx + ay * vy - b
                    if best is None or g.a > best.a:
                        best = g
                if not pos(best):
                    raise CertError("cone point %d of face %d may lie in piece %d (chain %d)" % (k, node.face, i, ci))
                gl = sig_down(float(best.a))
                worst_cone = gl if worst_cone is None else min(worst_cone, gl)
            fcons = fcons_iv[node.face]
            poly0, labels0 = part.poly, part.labels
            clip_part(part, float_cons(fcons))
            if not part.poly:
                cons = part.cons + fcons
                centre = (float(part.c_iv[0].mid), float(part.c_iv[1].mid))
                # many-sided pieces: the separating axis of the piece and the face's region of the chain
                fast = None
                if N > FAST_EMPTY_N:
                    fast = fast_empty_witness(cons, poly0, labels0, face_float_polygon(S, s, node.face), centre, float(part.rho.mid))
                    if fast and not pos(farkas_value(cons, round_mults(fast), part.c_iv, part.rho)):
                        fast = None
                best = (None, fast) if fast else brute_witness(float_cons(cons), centre, float(part.rho.mid))
                if best[1] is not None:
                    mults = round_mults(best[1])
                    v = farkas_value(cons, mults, part.c_iv, part.rho)
                    if pos(v):
                        empty_rows.append([node.face, i, ci, [[cons[k][0][0], cons[k][0][1], mu] for k, mu in mults], sig_down(float(v.a))])
                        continue
            by_face.setdefault(node.face, []).append(part)
        cone_rows.append([i, worst_cone])
    pairs = []
    for f, plist in sorted(by_face.items()):
        for u in range(len(plist)):
            for v in range(u + 1, len(plist)):
                pairs.append(certify_pair(plist[u], plist[v], fcons_iv[f], f))
    return {
        "method": "chains",
        "chains": chain_counts,
        "cone": cone_rows,
        "empty_parts": empty_rows,
        "pairs": pairs,
        "summary": {"chains": sum(chain_counts), "parts": sum(len(v) for v in by_face.values()),
                    "pairs": len(pairs), "farkas_pairs": sum(1 for p in pairs if p[5] == "farkas"),
                    "empty_parts": len(empty_rows)},
    }


def certify_fold_disks(cfg, lam):
    from cert import MAX_CHAINS, MAX_DEPTH, CertError, ivf, pos, sig_down

    S, s = cfg.S, cfg.s
    lam_iv = ivf(lam)
    reach_sq = lam_iv * lam_iv  # the shrunk diameter squared (disks have diameter 1)
    lam_sq = lam_iv * lam_iv / 4  # the shrunk radius squared
    centres = [(ivf(x), ivf(y)) for (_, x, y, _) in cfg.poses]
    nodes_all, cone_rows, pair_rows, loop_rows = [], [], [], []
    for i, (f, x, y, th) in enumerate(cfg.poses):
        c = centres[i]
        for k in range(S.sides[f]):
            d = isub(S.frame_vertex(s, f, k), c)
            if not pos(idot(d, d) - lam_sq):
                raise CertError("cone point %d of face %d is within lam of disk %d (anchor face)" % (k, f, i))
        nodes = enumerate_chains(S, s, f, c, reach_sq, MAX_CHAINS, MAX_DEPTH)
        nodes_all.append(nodes)
        worst = None
        for ci, node in enumerate(nodes):
            for k, (V, key) in enumerate(node.verts):
                d = isub(V, c)
                if node.W is not None and certainly_outside(node.W, Ray(d, key)):
                    continue
                g = idot(d, d) - lam_sq
                if not pos(g):
                    raise CertError("cone point %d of face %d is within lam of disk %d (chain %d)" % (k, node.face, i, ci))
                gf = sig_down(float(g.a))
                worst = gf if worst is None else min(worst, gf)
        cone_rows.append([i, worst])
    for i in range(cfg.P):
        c = centres[i]
        for j in range(i, cfg.P):
            fq = cfg.poses[j][0]
            q = centres[j]
            n_checked, worst = 0, None
            for ci, node in enumerate(nodes_all[i]):
                if node.face != fq or (i == j and ci == 0):
                    continue
                qq = node.T.apply(q)
                if point_certainly_outside(node.W, c, qq):
                    continue
                d = isub(qq, c)
                g = idot(d, d) - reach_sq
                if not pos(g):
                    what = "disk %d wraps onto itself" % i if i == j else "disks %d and %d overlap" % (i, j)
                    raise CertError("%s (chain %d)" % (what, ci))
                n_checked += 1
                gf = sig_down(float(g.a))
                worst = gf if worst is None else min(worst, gf)
            if n_checked:
                (loop_rows if i == j else pair_rows).append([i, j, n_checked, worst])
    return {
        "method": "chains",
        "chains": [len(n) for n in nodes_all],
        "cone": cone_rows,
        "pairs": pair_rows,
        "loops": loop_rows,
        "summary": {"chains": sum(len(n) for n in nodes_all), "pair_images": sum(r[2] for r in pair_rows),
                    "loop_images": sum(r[2] for r in loop_rows)},
    }
