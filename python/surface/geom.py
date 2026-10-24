"""Exact geometry of the five Platonic surfaces, built independently of the TypeScript code.

Combinatorics: the convex hull of exact vertex coordinates (integers, or Q(sqrt 5) for the
icosahedron and dodecahedron), decided with exact signs. Faces are vertex cycles that run
counter-clockwise seen from outside, start at their smallest vertex id and are sorted
lexicographically; vertices are listed in the documented order (see docs/spaces/SURFACE).

Face frames: face f is the regular M-gon of side s centred at the origin with a horizontal
bottom edge; frame vertex k (at angle -pi/2 + pi/M + 2 pi k/M) is the 3D vertex faces[f][k].
Frame vertices, gluing rotations and translations are exact elements of the solid's field:
Q for the cube, Q(sqrt 3) for the deltahedra, K = Q(sqrt(10 + 2 sqrt 5)) for the dodecahedron.
"""

from fractions import Fraction as Fr

from numfield import KD, Q3, Q5, QQ

SOLIDS = ("tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron")


# --------------------------------------------------------------------------- combinatorics

def _vertices_exact(name):
    """Vertex coordinates in the documented order, up to a common scale (exact)."""
    one = Q5.one
    phi = (one + Q5.gen()) / 2
    iphi = phi - 1  # 1/phi

    def cube(h):
        return [((h if i & 1 else -h), (h if i & 2 else -h), (h if i & 4 else -h)) for i in range(8)]

    def cyclic(a, b):
        sg = [(1, 1), (1, -1), (-1, 1), (-1, -1)]
        out = [(0 * a, p * a, q * b) for p, q in sg]
        out += [(p * a, q * b, 0 * a) for p, q in sg]
        out += [(q * b, 0 * a, p * a) for p, q in sg]
        return out

    if name == "tetrahedron":
        pts = [(1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1)]
        return [tuple(QQ(x) for x in p) for p in pts]
    if name == "cube":
        return [tuple(QQ(x) for x in p) for p in cube(1)]
    if name == "octahedron":
        pts = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
        return [tuple(QQ(x) for x in p) for p in pts]
    if name == "icosahedron":
        return cyclic(one, phi)
    if name == "dodecahedron":
        return [tuple(one * x for x in p) for p in cube(1)] + cyclic(iphi, phi)
    raise ValueError(name)


def _sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def hull_faces(pts):
    """Canonical face cycles of the convex hull (exact)."""
    n = len(pts)
    faces = {}
    for i in range(n):
        for j in range(i + 1, n):
            for k in range(j + 1, n):
                nrm = _cross(_sub(pts[j], pts[i]), _sub(pts[k], pts[i]))
                if all(x.is_zero() for x in nrm):
                    continue
                signs = [(_dot(nrm, _sub(pts[m], pts[i]))).sign() for m in range(n)]
                if 1 in signs and -1 in signs:
                    continue
                on = tuple(m for m in range(n) if signs[m] == 0)
                if on in faces:
                    continue
                out = nrm if -1 in signs else tuple(-x for x in nrm)  # outward normal
                faces[on] = out
    cycles = []
    for ids, out in faces.items():
        # consecutive vertices of a regular face are the pairs at the smallest distance
        d2 = {}
        for a in ids:
            for b in ids:
                if a < b:
                    v = _sub(pts[a], pts[b])
                    d2[(a, b)] = _dot(v, v)
        emin = min(d2.values(), key=lambda x: x.to_iv(64).mid)
        nb = {a: [] for a in ids}
        for (a, b), v in d2.items():
            if (v - emin).is_zero():
                nb[a].append(b)
                nb[b].append(a)
        assert all(len(x) == 2 for x in nb.values()), "face is not a cycle"
        start = min(ids)
        cyc = [start, min(nb[start])]
        while len(cyc) < len(ids):
            nxt = [x for x in nb[cyc[-1]] if x != cyc[-2]][0]
            cyc.append(nxt)
        # counter-clockwise seen from outside: (v1 - v0) x (v2 - v0) points outward
        turn = _cross(_sub(pts[cyc[1]], pts[cyc[0]]), _sub(pts[cyc[2]], pts[cyc[0]]))
        if _dot(turn, out).sign() < 0:
            cyc = [cyc[0]] + cyc[1:][::-1]
        cycles.append(tuple(cyc))
    cycles.sort()
    return [list(c) for c in cycles]


# --------------------------------------------------------------------------- exact frames

def _field_of(name):
    return {"cube": QQ, "tetrahedron": Q3, "octahedron": Q3, "icosahedron": Q3, "dodecahedron": KD}[name]


def _trig_tables(M, F):
    """Exact (cos, sin) of the rotation unit and the frame-vertex angles.

    Rotation unit u: pi/M for odd M (60 or 36 degrees), pi/2 for squares.
    Returns (unit_cos, unit_sin, order, frame_vertices_unit_edge).
    """
    if M == 4:
        h = Fr(1, 2)
        verts = [(F(h), F(-h)), (F(h), F(h)), (F(-h), F(h)), (F(-h), F(-h))]
        return F(0), F(1), 4, verts
    if M == 3:
        r3 = F.gen()  # sqrt 3
        verts = [(F(Fr(1, 2)), -r3 / 6), (F(0), r3 / 3), (F(Fr(-1, 2)), -r3 / 6)]
        return F(Fr(1, 2)), r3 / 2, 6, verts
    if M == 5:
        w = F.gen()  # sqrt(10 + 2 sqrt 5) = 4 cos 18
        c18 = w / 4
        s18 = (w * w - 12) / 8  # (sqrt5 - 1)/4 with sqrt5 = (w^2 - 10)/2
        c36 = c18 * c18 - s18 * s18
        s36 = 2 * s18 * c18
        R = 1 / (2 * s36)
        # frame vertex k at angle -54 + 72 k degrees = 18 * (4k - 3)
        def trig18(m):
            c, s = F(1), F(0)
            step = (c18, s18) if m >= 0 else (c18, -s18)
            for _ in range(abs(m)):
                c, s = c * step[0] - s * step[1], s * step[0] + c * step[1]
            return c, s
        verts = []
        for k in range(5):
            c, s = trig18(4 * k - 3)
            verts.append((R * c, R * s))
        return c36, s36, 10, verts
    raise ValueError(M)


class Rigid:
    """Exact rigid motion p -> R(j u) p + t; j is an index into the rotation table."""

    __slots__ = ("j", "tx", "ty")

    def __init__(self, j, tx, ty):
        self.j = j
        self.tx = tx
        self.ty = ty


class Solid:
    def __init__(self, name):
        self.name = name
        pts = _vertices_exact(name)
        self.faces = hull_faces(pts)
        self.F = len(self.faces)
        self.M = len(self.faces[0])
        assert all(len(f) == self.M for f in self.faces)
        self.V = len(pts)
        self.E = self.F * self.M // 2
        assert self.V - self.E + self.F == 2, "Euler characteristic"
        self.degree = self.F * self.M // self.V
        directed = {}
        for fi, f in enumerate(self.faces):
            for k in range(self.M):
                directed[(f[k], f[(k + 1) % self.M])] = (fi, k)
        self.adj = []
        for fi, f in enumerate(self.faces):
            row = []
            for k in range(self.M):
                row.append(directed[(f[(k + 1) % self.M], f[k])])
            self.adj.append(row)
        self.field = _field_of(name)
        uc, us, order, verts = _trig_tables(self.M, self.field)
        self.order = order
        # rotation table: (cos, sin) of j * u for j = 0 .. order-1
        self.rot = [(self.field(1), self.field(0))]
        for _ in range(1, order):
            c, s = self.rot[-1]
            self.rot.append((c * uc - s * us, s * uc + c * us))
        assert (self.rot[-1][0] * uc - self.rot[-1][1] * us - 1).is_zero(), "rotation table must close"
        self.unit_verts = verts  # frame vertices at unit edge
        # face angle (M - 2) pi / M; turn rule: count * (M - 2) >= M prunes
        self.unit_angle_den = self.M if self.M % 2 else 2  # u = pi / unit_angle_den

    def frame_vertex(self, s, k):
        x, y = self.unit_verts[k % self.M]
        return (x * s, y * s)

    def rotate(self, j, v):
        c, s = self.rot[j % self.order]
        return (c * v[0] - s * v[1], s * v[0] + c * v[1])

    def apply(self, T, v):
        x, y = self.rotate(T.j, v)
        return (x + T.tx, y + T.ty)

    def compose(self, A, B):
        """A after B."""
        x, y = self.rotate(A.j, (B.tx, B.ty))
        return Rigid((A.j + B.j) % self.order, x + A.tx, y + A.ty)

    def inverse(self, T):
        j = (-T.j) % self.order
        x, y = self.rotate(j, (T.tx, T.ty))
        return Rigid(j, -x, -y)

    def identity(self):
        return Rigid(0, self.field(0), self.field(0))

    def glue(self, s, f, k):
        """Map from the frame of the face glued to edge k of face f into f's frame (unfolded)."""
        g, l = self.adj[f][k]
        M = self.M
        if M == 4:
            j = (k - l + 2) % self.order
        else:
            j = (2 * (k - l) + M) % self.order
        p = self.rotate(j, self.frame_vertex(s, l + 1))
        q = self.frame_vertex(s, k)
        return g, l, Rigid(j, q[0] - p[0], q[1] - p[1])


_CACHE = {}


def get_solid(name):
    if name not in SOLIDS:
        raise ValueError("unknown solid %r" % (name,))
    if name not in _CACHE:
        _CACHE[name] = Solid(name)
    return _CACHE[name]
