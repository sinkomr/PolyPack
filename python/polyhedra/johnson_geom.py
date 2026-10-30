"""Exact construction helpers for the Johnson solids: caps attached to faces, hull faces, validity (offline tool)."""
from fractions import Fraction as Fr

import numpy as np
from scipy.spatial import ConvexHull

import johnson_tower as jt
from johnson_tower import add, sub, mul, inv, sqrt, vadd, vsub, vdot, vcross, vfloat

HALF = Fr(1, 2)


def S5(): return sqrt(Fr(5))


def cos2pi_over(n):
    """cos(2 pi / n) for n in 3, 4, 5, 6, 8, 10 exactly."""
    if n == 3: return Fr(-1, 2)
    if n == 4: return Fr(0)
    if n == 5: return mul(sub(S5(), 1), Fr(1, 4))
    if n == 6: return Fr(1, 2)
    if n == 8: return mul(sqrt(Fr(2)), Fr(1, 2))
    if n == 10: return mul(add(S5(), 1), Fr(1, 4))
    raise ValueError(n)


def Rsq(n):
    """Squared circumradius of the regular n-gon of edge 1: 1 / (2 (1 - cos(2 pi / n)))."""
    return inv(mul(sub(Fr(1), cos2pi_over(n)), 2))


def vscale(u, s): return tuple(mul(a, s) for a in u)


def centre(qs):
    r = qs[0]
    for q in qs[1:]: r = vadd(r, q)
    return vscale(r, Fr(1, len(qs)))


def mid(p, q): return vscale(vadd(p, q), HALF)


def unit_step(n, length2):
    """Scalar t >= 0 with |t n|^2 = length2 (n a vector, length2 an element)."""
    return sqrt(mul(length2, inv(vdot(n, n))))


def cap_vertices(kind, q, c, n):
    """New vertices of a cap whose base is the regular unit-edge polygon q (ccw seen from the cap side, i.e. from
    outside the solid it is glued to), centre c, with n a vector along the outward normal."""
    m = len(q)
    R2 = vdot(vsub(q[0], c), vsub(q[0], c))
    if kind == 'pyramid':
        t = unit_step(n, sub(Fr(1), R2))
        return [vadd(c, vscale(n, t))]
    if kind == 'prism':
        t = unit_step(n, Fr(1))
        return [vadd(qj, vscale(n, t)) for qj in q]
    if kind == 'antiprism':
        M = [mid(q[j], q[(j + 1) % m]) for j in range(m)]
        a2 = vdot(vsub(M[0], c), vsub(M[0], c))
        kap = sqrt(mul(R2, inv(a2)))
        tops = [vadd(c, vscale(vsub(Mj, c), kap)) for Mj in M]
        h2 = sub(Fr(1), vdot(vsub(tops[0], q[0]), vsub(tops[0], q[0])))
        t = unit_step(n, h2)
        return [vadd(p, vscale(n, t)) for p in tops]
    if kind == 'cupola':
        k = m // 2
        M = [mid(q[2 * j], q[2 * j + 1]) for j in range(k)]
        a2 = vdot(vsub(M[0], c), vsub(M[0], c))
        kap = sqrt(mul(Rsq(k), inv(a2)))
        tops = [vadd(c, vscale(vsub(Mj, c), kap)) for Mj in M]
        h2 = sub(Fr(1), vdot(vsub(tops[0], q[0]), vsub(tops[0], q[0])))
        t = unit_step(n, h2)
        return [vadd(p, vscale(n, t)) for p in tops]
    if kind == 'rotunda':
        assert m == 10
        a2 = vdot(vsub(mid(q[0], q[1]), c), vsub(mid(q[0], q[1]), c))
        kM = mul(sub(R2, HALF), inv(a2))                    # rho_M / a  (rho_M = (R^2 - 1/2) / a, a the apothem)
        zm2 = sub(R2, mul(mul(kM, kM), a2))
        kT = sqrt(mul(Rsq(5), inv(a2)))
        zt2 = sub(R2, Rsq(5))
        tm, tt = unit_step(n, zm2), unit_step(n, zt2)
        Ms = [vadd(vadd(c, vscale(vsub(mid(q[2 * i], q[2 * i + 1]), c), kM)), vscale(n, tm)) for i in range(5)]
        Ts = [vadd(vadd(c, vscale(vsub(mid(q[(2 * i - 1) % 10], q[2 * i]), c), kT)), vscale(n, tt)) for i in range(5)]
        return Ms + Ts
    if kind == 'wedge':
        assert m == 4
        t = unit_step(n, Fr(3, 4))
        return [vadd(mid(q[1], q[2]), vscale(n, t)), vadd(mid(q[3], q[0]), vscale(n, t))]
    raise ValueError(kind)


def ring(m, z=0):
    """Regular unit-edge m-gon in the plane z, vertex 0 on +x, counter-clockwise seen from +z, exactly."""
    from johnson_tower import mp
    R = sqrt(Rsq(m))
    if m == 3: cs = [(Fr(1), Fr(0)), (Fr(-1, 2), mul(sqrt(Fr(3)), HALF)), (Fr(-1, 2), mul(sqrt(Fr(3)), Fr(-1, 2)))]
    else:
        c1 = cos2pi_over(m)
        s1 = sqrt(sub(Fr(1), mul(c1, c1)))
        cs = [(Fr(1), Fr(0))]
        for j in range(1, m):
            x, y = cs[-1]
            cs.append((sub(mul(x, c1), mul(y, s1)), add(mul(y, c1), mul(x, s1))))
    return [(mul(R, x), mul(R, y), Fr(z)) for x, y in cs]


def hull(P):
    """Faces (ccw from outside, as index lists), from the float positions. Returns (faces, normals, n_extreme)."""
    pts = np.array([vfloat(p) for p in P])
    h = ConvexHull(pts)
    groups = []
    for simp, eq in zip(h.simplices, h.equations):
        for g in groups:
            if np.allclose(g[0], eq, atol=1e-7):
                g[1].update(simp.tolist()); break
        else:
            groups.append([eq, set(simp.tolist())])
    faces, normals = [], []
    for eq, vs in groups:
        nrm = eq[:3]
        vs = sorted(vs)
        cen = pts[vs].mean(axis=0)
        u = pts[vs[0]] - cen; u -= nrm * np.dot(u, nrm); u /= np.linalg.norm(u)
        v = np.cross(nrm, u)
        ang = [np.arctan2(np.dot(pts[i] - cen, v), np.dot(pts[i] - cen, u)) for i in vs]
        faces.append([i for _, i in sorted(zip(ang, vs))])
        normals.append(nrm)
    return faces, normals, len(h.vertices)


def analyze(P, tol=1e-8):
    """(ok, counts) : every vertex extreme, every face a regular unit-edge polygon; counts = {sides: number}."""
    faces, normals, nv = hull(P)
    if nv != len(P): return False, None
    pts = np.array([vfloat(p) for p in P])
    counts = {}
    for f in faces:
        L = [np.linalg.norm(pts[f[i]] - pts[f[(i + 1) % len(f)]]) for i in range(len(f))]
        if any(abs(x - 1) > tol for x in L): return False, None
        cen = pts[f].mean(axis=0)
        rr = [np.linalg.norm(pts[i] - cen) for i in f]
        if max(rr) - min(rr) > tol: return False, None
        counts[len(f)] = counts.get(len(f), 0) + 1
    return True, counts


def face_with(faces, idxset):
    for f in faces:
        if set(f) == set(idxset): return f
    return None


def attach(P, face, kind, s=0, normal=None):
    """P plus a cap of `kind` glued on `face` (ccw from outside), base vertex j of the cap on face[(j+s) % m]."""
    m = len(face)
    q = [P[face[(j + s) % m]] for j in range(m)]
    c = centre(q)
    n = vcross(vsub(q[1], q[0]), vsub(q[2], q[0]))
    ref = normal if normal is not None else vsub(c, centre(P))
    if float(vdot(n, ref)) < 0: n = vscale(n, Fr(-1))
    return P + cap_vertices(kind, q, c, n)


def analyze_float(pts, tol=1e-8):
    """Like analyze, for an array of float points: (ok, {sides: faces})."""
    h = ConvexHull(pts)
    if len(h.vertices) != len(pts): return False, None
    groups = []
    for simp, eq in zip(h.simplices, h.equations):
        for g in groups:
            if np.allclose(g[0], eq, atol=1e-7): g[1].update(simp.tolist()); break
        else: groups.append([eq, set(simp.tolist())])
    counts = {}
    for eq, vs in groups:
        vs = sorted(vs); cen = pts[vs].mean(axis=0); nrm = eq[:3]
        u = pts[vs[0]] - cen; u = u - nrm * np.dot(u, nrm); u /= np.linalg.norm(u); v = np.cross(nrm, u)
        order = sorted(vs, key=lambda i: np.arctan2(np.dot(pts[i] - cen, v), np.dot(pts[i] - cen, u)))
        for a, b in zip(order, order[1:] + order[:1]):
            if abs(np.linalg.norm(pts[a] - pts[b]) - 1) > tol: return False, None
        counts[len(vs)] = counts.get(len(vs), 0) + 1
    return True, counts
