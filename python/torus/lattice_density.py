"""Independent check of the P = 1 free-lattice entries: densest lattice packing densities.

  python3 python/torus/lattice_density.py

Translates K + lam (lam in a lattice) pack iff no nonzero lattice vector lies in the
interior of the difference body D = K - K. The densest such lattice has determinant
Delta(D), the critical determinant of D, and density A(K) / Delta(D). For a centrally
symmetric convex polygon D a critical lattice has three pairs of points b1, b2, b2 - b1 on
the boundary of D (Minkowski; see e.g. Gruber and Lekkerkerker, Geometry of Numbers), so
we scan b1 over the boundary, solve for b2 on the boundary with b2 - b1 also on it, and
minimise |det(b1, b2)|. Uses numpy/scipy; this is a float cross-check, not a proof.
"""

import math

import numpy as np
from scipy.optimize import brentq, minimize_scalar


def polygon(N, th=0.0):
    R = 1 / (2 * math.sin(math.pi / N))
    return np.array([[R * math.cos(th + math.pi / 2 + 2 * math.pi * k / N), R * math.sin(th + math.pi / 2 + 2 * math.pi * k / N)] for k in range(N)])


def difference_body(V):
    from scipy.spatial import ConvexHull

    pts = (V[:, None, :] - V[None, :, :]).reshape(-1, 2)
    h = ConvexHull(pts)
    return pts[h.vertices]  # counter-clockwise for 2-D hulls


def gauge(D, x):
    n = len(D)
    best = 0.0
    for i in range(n):
        p, q = D[i], D[(i + 1) % n]
        e = q - p
        nn = np.array([e[1], -e[0]])
        best = max(best, (x @ nn) / (p @ nn))
    return best


def boundary_point(D, psi):
    u = np.array([math.cos(psi), math.sin(psi)])
    return u / gauge(D, u)


def det_for(D, phi):
    b1 = boundary_point(D, phi)
    f = lambda psi: gauge(D, boundary_point(D, psi) - b1) - 1.0
    ps = np.linspace(phi + 1e-7, phi + math.pi - 1e-7, 721)
    vals = np.array([f(p) for p in ps])
    best = math.inf
    for k in range(len(ps) - 1):
        if vals[k] * vals[k + 1] < 0:
            psi = brentq(f, ps[k], ps[k + 1], xtol=1e-15)
            b2 = boundary_point(D, psi)
            best = min(best, abs(b1[0] * b2[1] - b1[1] * b2[0]))
    return best


def critical_determinant(D, ngrid=720):
    phis = np.linspace(0, math.pi, ngrid, endpoint=False)
    vals = np.array([det_for(D, p) for p in phis])
    i = int(vals.argmin())
    h = math.pi / ngrid
    res = minimize_scalar(lambda p: det_for(D, p), bounds=(phis[i] - h, phis[i] + h), method="bounded", options={"xatol": 1e-13})
    return min(res.fun, vals[i])


def lattice_density(N):
    if N == 0:
        return math.pi / math.sqrt(12.0)
    A = N / (4 * math.tan(math.pi / N))
    return A / critical_determinant(difference_body(polygon(N)))


if __name__ == "__main__":
    for N in (0, 3, 4, 5, 6, 7, 8):
        d = lattice_density(N)
        A = math.pi if N == 0 else N / (4 * math.tan(math.pi / N))
        print("N=%d  lattice density %.10f  P=1 free score sqrt(A/density) = %.10f" % (N, d, math.sqrt(A / d)))
