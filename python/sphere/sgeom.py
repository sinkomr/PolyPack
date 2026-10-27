"""Floating-point geometry for whole-sphere packings (search and reporting only; NOT the certifier).

Conventions (identical to packages/sphere and docs/spaces/SPHERE.md):
  * All computation happens on the UNIT sphere S^2 in R^3. A problem sphere/N/P with sphere
    radius rho is the same as pieces of angular size a on the unit sphere: a = 1/rho for polygons
    (side angle) and a = 1/(2 rho) for disks (angular radius; disks have diameter 1, since
    2026-10-27, radius 1 before). angle_of_rho and rho_of_angle convert; everything else here is
    in a, so nothing below depends on the unit change.
  * O = e3 = (0, 0, 1) (north pole); tangent frame at O: x = e1, y = e2.
  * Standard piece: centre O, vertex k at (sin R cos phi_k, sin R sin phi_k, cos R),
    phi_k = pi/2 + 2 pi k/N (vertex 0 straight up, +y), R the angular circumradius,
    sin(a/2) = sin R sin(pi/N). A convex regular spherical N-gon needs R < pi/2, i.e. a < 2 pi/N.
  * Pose: a quaternion q = (w, x, y, z) != 0; the piece is G(standard piece), G = rotation of q/|q|
    (v -> q v q^*, Hamilton product). Gauge: piece 0 has q = (1, 0, 0, 0).
"""
import math

import numpy as np

PI = math.pi


def angle_of_rho(N, rho):
    """Angular size a of a piece on the sphere of radius rho (disks: angular radius 1/(2 rho))."""
    return 1 / (2 * rho) if N == 0 else 1 / rho


def rho_of_angle(N, a):
    """Sphere radius at which a piece has angular size a (exact inverse of angle_of_rho)."""
    return 1 / (2 * a) if N == 0 else 1 / a


# ---------------------------------------------------------------- piece measures (unit sphere)

def R_from_a(N, a):
    """Angular circumradius of the regular N-gon of side angle a (a < 2 pi / N)."""
    return math.asin(math.sin(a / 2) / math.sin(PI / N))


def a_from_R(N, R):
    return 2 * math.asin(math.sin(R) * math.sin(PI / N))


def inradius(N, a):
    """tan(a/2) = sin(r) tan(pi/N)."""
    return math.asin(math.tan(a / 2) / math.tan(PI / N))


def interior_angle(N, a):
    """cos(pi/N) = cos(a/2) sin(alpha/2)."""
    return 2 * math.asin(min(1.0, math.cos(PI / N) / math.cos(a / 2)))


def area(N, a):
    """Area on the unit sphere: N alpha - (N - 2) pi (Gauss-Bonnet); disks 2 pi (1 - cos a)."""
    if N == 0:
        return 2 * PI * (1 - math.cos(a))
    return N * interior_angle(N, a) - (N - 2) * PI


def std_vertices(N, R):
    k = np.arange(N)
    phi = PI / 2 + 2 * PI * k / N
    return np.stack([math.sin(R) * np.cos(phi), math.sin(R) * np.sin(phi), np.full(N, math.cos(R))], axis=1)


def std_vertices_dR(N, R):
    k = np.arange(N)
    phi = PI / 2 + 2 * PI * k / N
    return np.stack([math.cos(R) * np.cos(phi), math.cos(R) * np.sin(phi), np.full(N, -math.sin(R))], axis=1)


# ---------------------------------------------------------------- quaternions

def qmul(p, q):
    w1, x1, y1, z1 = p
    w2, x2, y2, z2 = q
    return np.array([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ])


def qmat(q):
    """Rotation matrix of q/|q| (exactly orthogonal formula divided by |q|^2)."""
    w, x, y, z = q
    n = w * w + x * x + y * y + z * z
    return np.array([
        [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
    ]) / n


def q_from_centre_theta(c, theta):
    """G = T(c) R_z(theta): T(c) the rotation about e3 x c taking e3 to c (minimal), R_z about e3."""
    c = np.asarray(c, float)
    c = c / np.linalg.norm(c)
    d = math.acos(max(-1.0, min(1.0, c[2])))
    s = math.hypot(c[0], c[1])
    if s < 1e-300:
        qt = np.array([1.0, 0, 0, 0]) if c[2] > 0 else np.array([0.0, 1.0, 0, 0])
    else:
        ax = np.array([-c[1], c[0], 0.0]) / s  # e3 x c normalised
        qt = np.concatenate([[math.cos(d / 2)], math.sin(d / 2) * ax])
    qz = np.array([math.cos(theta / 2), 0, 0, math.sin(theta / 2)])
    return qmul(qt, qz)


def centre_theta_from_q(q):
    """Inverse of q_from_centre_theta (theta undefined at the south pole: returned as the angle of G e1)."""
    M = qmat(q)
    c = M[:, 2]
    s = math.hypot(c[0], c[1])
    if s < 1e-14:
        if c[2] > 0:
            return c, math.atan2(M[1, 0], M[0, 0])
        # T(-e3) taken as the rotation by pi about e1 (limit along +y direction is ambiguous)
        return c, math.atan2(-M[1, 0], M[0, 0])
    d = math.acos(max(-1.0, min(1.0, c[2])))
    ax = np.array([-c[1], c[0], 0.0]) / s
    qt = np.concatenate([[math.cos(d / 2)], math.sin(d / 2) * ax])
    qtinv = qt * np.array([1, -1, -1, -1])
    qz = qmul(qtinv, np.asarray(q, float) / np.linalg.norm(q))
    return c, 2 * math.atan2(qz[3], qz[0])


def placed_vertices(N, R, q):
    return std_vertices(N, R) @ qmat(q).T


def centre(q):
    return qmat(q)[:, 2]


# ---------------------------------------------------------------- separation (float)

def max_margin(A, B):
    """max over unit n of min(min_k n.a_k, min_l -n.b_l): the max-margin plane through 0.

    Equals cos of the radius of the smallest cap containing S = {a_k} u {-b_l}; > 0 iff the cones
    over A and B meet only at 0 (strictly separated), = 0 when touching, < 0 when interiors overlap.
    The optimum has >= 2 active points, so it is attained at +-(p + q)/|p + q| or at the
    +- normal of the plane through three points of S: brute force over all of them is exact."""
    S = np.concatenate([A, -B], axis=0)
    m = len(S)
    best = -np.inf
    bestn = None
    cands = []
    for i in range(m):
        for j in range(i + 1, m):
            v = S[i] + S[j]
            nv = np.linalg.norm(v)
            if nv > 1e-12:
                cands.append(v / nv)
            for k in range(j + 1, m):
                w = np.cross(S[j] - S[i], S[k] - S[i])
                nw = np.linalg.norm(w)
                if nw > 1e-12:
                    cands.append(w / nw)
                    cands.append(-w / nw)
    C = np.array(cands)
    vals = (C @ S.T).min(axis=1)
    k = int(np.argmax(vals))
    best, bestn = vals[k], C[k]
    return float(best), bestn


def disk_gap(c1, c2, a):
    """Angular gap (angle between centres) - 2a."""
    d = math.acos(max(-1.0, min(1.0, float(np.dot(c1, c2)) / (np.linalg.norm(c1) * np.linalg.norm(c2)))))
    return d - 2 * a


_COMBOS = {}


def _combos(m):
    c = _COMBOS.get(m)
    if c is None:
        pi_, pj_ = np.triu_indices(m, 1)
        t = [(i, j, k) for i in range(m) for j in range(i + 1, m) for k in range(j + 1, m)]
        t = np.array(t, dtype=int).reshape(-1, 3)
        c = (pi_, pj_, t[:, 0], t[:, 1], t[:, 2])
        _COMBOS[m] = c
    return c


def max_margin_batch(A, B):
    """Vectorised max_margin for batches A (b, N, 3), B (b, N, 3) -> (values (b,), normals (b, 3))."""
    S = np.concatenate([A, -B], axis=1)
    m = S.shape[1]
    pi_, pj_, ti, tj, tk = _combos(m)
    c2 = S[:, pi_] + S[:, pj_]
    c3 = np.cross(S[:, tj] - S[:, ti], S[:, tk] - S[:, ti])
    C = np.concatenate([c2, c3, -c3], axis=1)
    nC = np.linalg.norm(C, axis=2, keepdims=True)
    good = nC[..., 0] > 1e-12
    C = C / np.where(nC > 1e-12, nC, 1.0)
    vals = np.einsum("bcd,bmd->bcm", C, S).min(axis=2)
    vals = np.where(good, vals, -np.inf)
    k = np.argmax(vals, axis=1)
    idx = np.arange(len(S))
    return vals[idx, k], C[idx, k]


def pair_gaps(N, P, a, Q, prefilter=True):
    """All candidate pairs (i, j) with their gaps: polygon max-margin values (sine units, > 0 means
    strictly separated) or disk angular gaps. Far pairs (circumscribed caps disjoint) are skipped."""
    Q = np.asarray(Q, float)
    Ms = np.array([qmat(q) for q in Q])
    C = Ms[:, :, 2]
    G = C @ C.T
    iu, ju = np.triu_indices(P, 1)
    if N == 0:
        d = np.arccos(np.clip(G[iu, ju], -1.0, 1.0))
        return iu, ju, d - 2 * a, None
    R = R_from_a(N, a)
    if prefilter:
        keep = G[iu, ju] >= math.cos(min(PI, 2 * R)) - 1e-9
        iu, ju = iu[keep], ju[keep]
    V = std_vertices(N, R)
    X = np.einsum("pij,kj->pki", Ms, V)
    if len(iu) == 0:
        return iu, ju, np.zeros(0), np.zeros((0, 3))
    vals, nrm = max_margin_batch(X[iu], X[ju])
    return iu, ju, vals, nrm


def validate(N, P, a, Q, tol=1e-12):
    """Float check of a configuration at piece size a on the unit sphere.

    Returns (min_gap, worst_pair). Polygon gaps are max-margin values (sine units), disks angular gaps."""
    Q = np.asarray(Q, float)
    assert len(Q) == P
    iu, ju, g, _ = pair_gaps(N, P, a, Q)
    if len(g) == 0:
        return (np.inf, None)
    k = int(np.argmin(g))
    return (float(g[k]), (int(iu[k]), int(ju[k])))
