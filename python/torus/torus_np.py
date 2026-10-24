"""Float (numpy) geometry for the flat-torus SEARCH only.

This module is used by torus_search.py. It is deliberately independent of the
rigorous certifier (certify_torus.py), which uses mpmath interval arithmetic and
no numpy. Nothing here is a proof.

Conventions (PolyPack PROMPT.md section 2):
  N = 0: disk of radius 1.  N >= 3: regular N-gon of side 1, circumradius
  R = 1/(2 sin(pi/N)), inradius r = 1/(2 tan(pi/N)); vertex k of a piece with
  pose (x, y, theta) is at (x, y) + R (cos a_k, sin a_k), a_k = theta + pi/2 + 2 pi k/N.
  Edge k joins vertices k and k+1; its outward normal has angle
  theta + pi/2 + pi/N + 2 pi k/N and the edge lies at distance r from the centre.

Torus R^2 / Lambda with Lambda = B Z^2 (columns of B are the basis vectors).
Families:
  sq   B = L I                                 params [L]       score L
  hex  B = L [[1, 1/2], [0, sqrt(3)/2]]        params [L]       score L
  free B = [[a, b], [0, c]], a > 0, c > 0      params [a, b, c] score sqrt(a c)
Piece centres are stored in fractional coordinates u (x = B u).
"""

import math

import numpy as np

SQ3_2 = math.sqrt(3.0) / 2.0
HEX = np.array([[1.0, 0.5], [0.0, SQ3_2]])
FAMILIES = ("sq", "hex", "free")


def shape_radii(N):
    """(bounding radius R, inradius r); for disks both are 1."""
    if N == 0:
        return 1.0, 1.0
    return 1.0 / (2.0 * math.sin(math.pi / N)), 1.0 / (2.0 * math.tan(math.pi / N))


def piece_area(N):
    return math.pi if N == 0 else N / (4.0 * math.tan(math.pi / N))


def basis_of(family, p):
    if family == "sq":
        return np.array([[p[0], 0.0], [0.0, p[0]]])
    if family == "hex":
        return p[0] * HEX
    return np.array([[p[0], p[1]], [0.0, p[2]]])


def score_of(family, p):
    if family == "free":
        return math.sqrt(p[0] * p[2])
    return float(p[0])


def metric_of(family, p):
    """Quantity the LP minimises: L for sq/hex, cell area for free."""
    if family == "free":
        return p[0] * p[2]
    return float(p[0])


def gauss_reduce(B):
    """Lagrange-Gauss reduction. Returns (B', M) with B' = B M, M unimodular (integer)."""
    B = B.copy()
    M = np.eye(2, dtype=np.int64)
    for _ in range(200):
        n1 = B[:, 0] @ B[:, 0]
        n2 = B[:, 1] @ B[:, 1]
        if n2 < n1:
            B = B[:, ::-1].copy()
            M = M[:, ::-1].copy()
            n1, n2 = n2, n1
        mu = int(round((B[:, 0] @ B[:, 1]) / n1))
        if mu == 0:
            break
        B[:, 1] -= mu * B[:, 0]
        M[:, 1] -= mu * M[:, 0]
        if B[:, 1] @ B[:, 1] >= n1:
            break
    return B, M


class State:
    """params (np array), U (P,2) fractional centres, TH (P,) angles."""

    __slots__ = ("params", "U", "TH")

    def __init__(self, params, U, TH):
        self.params = np.array(params, dtype=float)
        self.U = np.array(U, dtype=float).reshape(-1, 2)
        self.TH = np.array(TH, dtype=float).reshape(-1)

    def copy(self):
        return State(self.params.copy(), self.U.copy(), self.TH.copy())


def cartesian(family, st):
    B = basis_of(family, st.params)
    return st.U @ B.T


def from_cartesian(family, params, X, TH):
    B = basis_of(family, params)
    U = np.linalg.solve(B, np.asarray(X, float).T).T
    return State(params, U, TH)


def normalise_free(st):
    """Reduce a free-lattice basis and rotate so b1 lies on +x with c > 0.

    Rotating the whole configuration (lattice, centres and pieces) by -psi is an
    isometry, so piece angles change by -psi; fractional coordinates change only
    through the unimodular basis change.
    """
    B = basis_of("free", st.params)
    Bp, M = gauss_reduce(B)
    U = np.linalg.solve(M.astype(float), st.U.T).T
    if np.linalg.det(Bp) < 0:
        Bp[:, 1] = -Bp[:, 1]
        U[:, 1] = -U[:, 1]
    psi = math.atan2(Bp[1, 0], Bp[0, 0])
    c, s = math.cos(-psi), math.sin(-psi)
    Rm = np.array([[c, -s], [s, c]])
    Bp = Rm @ Bp
    st.params = np.array([Bp[0, 0], Bp[0, 1], Bp[1, 1]])
    st.U = U - np.floor(U)
    st.TH = st.TH - psi
    return st


class Geometry:
    """Precomputed per (family, N, P) tables for pair enumeration and SAT."""

    def __init__(self, family, N, P):
        self.family, self.N, self.P = family, N, P
        self.R, self.r = shape_radii(N)
        self.area_piece = piece_area(N)
        I, J = np.triu_indices(P)
        self.I, self.J = I, J
        self.self_pair = I == J
        if N > 0:
            k = np.arange(N)
            self.base_v = math.pi / 2 + 2 * math.pi * k / N
            self.base_e = self.base_v + math.pi / N
        self.nvar_pose = 2 * P + (P if N > 0 else 0)
        self.npar = 3 if family == "free" else 1

    # ------------------------------------------------------------------ pairs
    def images(self, B, U, reach):
        """All (pair, lattice vector) with centre distance < reach.

        Returns pair index array, W (fractional displacement u_j + lambda - u_i)
        and D = B W. Self pairs keep lambda in the open half-plane m > 0 or
        (m = 0, n > 0) so each unordered image pair appears once.
        Enumeration bound (see docs): |w_1| < reach |b2| / A, |w_2| < reach |b1| / A.
        """
        I, J = self.I, self.J
        w0 = U[J] - U[I]
        w0 = w0 - np.round(w0)
        A = abs(np.linalg.det(B))
        n1 = math.hypot(B[0, 0], B[1, 0])
        n2 = math.hypot(B[0, 1], B[1, 1])
        K1 = int(math.ceil(0.5 + reach * n2 / A))
        K2 = int(math.ceil(0.5 + reach * n1 / A))
        m = np.arange(-K1, K1 + 1)
        n = np.arange(-K2, K2 + 1)
        off = np.stack(np.meshgrid(m, n, indexing="ij"), -1).reshape(-1, 2).astype(float)
        pos_half = (off[:, 0] > 0) | ((off[:, 0] == 0) & (off[:, 1] > 0))
        W = w0[:, None, :] + off[None, :, :]
        D = W @ B.T
        d2 = (D * D).sum(-1)
        mask = d2 < reach * reach
        mask &= ~self.self_pair[:, None] | pos_half[None, :]
        pi_, oi = np.nonzero(mask)
        return pi_, W[pi_, oi], D[pi_, oi]

    # ------------------------------------------------------------------ SAT
    def separations(self, TH, pi_, D):
        """Signed SAT separation for each candidate image pair plus axis data."""
        N, R, r = self.N, self.R, self.r
        if N == 0:
            dist = np.sqrt((D * D).sum(-1))
            return dist - 2.0, None
        thA = TH[self.I[pi_]]
        thB = TH[self.J[pi_]]
        alA = thA[:, None] + self.base_e
        alB = thB[:, None] + self.base_e
        phA = thA[:, None] + self.base_v
        phB = thB[:, None] + self.base_v
        dnA = D[:, 0:1] * np.cos(alA) + D[:, 1:2] * np.sin(alA)
        dnB = -(D[:, 0:1] * np.cos(alB) + D[:, 1:2] * np.sin(alB))
        projA = dnA[:, :, None] + R * np.cos(phB[:, None, :] - alA[:, :, None]) - r
        projB = dnB[:, :, None] + R * np.cos(phA[:, None, :] - alB[:, :, None]) - r
        GA = projA.min(2)
        GB = projB.min(2)
        kA = GA.argmax(1)
        kB = GB.argmax(1)
        ar = np.arange(len(pi_))
        sA = GA[ar, kA]
        sB = GB[ar, kB]
        sideB = sB > sA
        sep = np.where(sideB, sB, sA)
        return sep, (projA, projB, kA, kB, sideB, sep)

    def min_sep(self, st):
        B = basis_of(self.family, st.params)
        pi_, W, D = self.images(B, st.U, 2 * self.R + 1e-6)
        if len(pi_) == 0:
            return 1.0
        sep, _ = self.separations(st.TH, pi_, D)
        return float(sep.min())

    # ------------------------------------------------------------------ rows
    def rows(self, st, gap_tol, vwin):
        """Linearised contact rows g + J dz >= 0 for all pairs with sep < gap_tol.

        Variables dz = [du (2P), dtheta (P, polygons), dparams].
        Returns (g, Jrows, min_sep).
        """
        fam, N, P, R, r = self.family, self.N, self.P, self.R, self.r
        B = basis_of(fam, st.params)
        pi_, W, D = self.images(B, st.U, 2 * R + gap_tol)
        nv = self.nvar_pose + self.npar
        if len(pi_) == 0:
            return np.zeros(0), np.zeros((0, nv)), 1.0
        sep, ax = self.separations(st.TH, pi_, D)
        msep = float(sep.min())
        if N == 0:
            sel = np.nonzero(sep < gap_tol)[0]
            Dd = D[sel]
            dist = np.sqrt((Dd * Dd).sum(-1))
            g = dist - 2.0
            gd = Dd / dist[:, None]
            Ii, Jj, Ww = self.I[pi_[sel]], self.J[pi_[sel]], W[sel]
            ow = ot = None
            gto = gtt = None
        else:
            projA, projB, kA, kB, sideB, _ = ax
            sel = np.nonzero(sep < gap_tol)[0]
            sB = sideB[sel]
            prow = np.where(
                sB[:, None], projB[sel, kB[sel], :], projA[sel, kA[sel], :]
            )
            pmin = prow.min(1)
            vm = prow <= pmin[:, None] + vwin
            rr, vv = np.nonzero(vm)
            p = sel[rr]
            side = sideB[p]
            kk = np.where(side, kB[p], kA[p])
            Ii, Jj = self.I[pi_[p]], self.J[pi_[p]]
            ow = np.where(side, Jj, Ii)
            ot = np.where(side, Ii, Jj)
            sgn = np.where(side, -1.0, 1.0)
            al = st.TH[ow] + self.base_e[kk]
            ph = st.TH[ot] + self.base_v[vv]
            nx, ny = np.cos(al), np.sin(al)
            ex, ey = np.cos(ph), np.sin(ph)
            dx, dy = sgn * D[p, 0], sgn * D[p, 1]
            g = dx * nx + dy * ny + R * (ex * nx + ey * ny) - r
            gd = np.stack([sgn * nx, sgn * ny], -1)
            # rotating the owner turns its edge normal: dn/dtheta = (-ny, nx)
            gto = (dx + R * ex) * (-ny) + (dy + R * ey) * nx
            # rotating the other piece moves its vertex: de/dtheta = (-ey, ex)
            gtt = R * (-ey * nx + ex * ny)
            Ww = W[p]
        nr = len(g)
        Jm = np.zeros((nr, nv))
        gu = gd @ B  # B^T gd, row form
        ar = np.arange(nr)
        np.add.at(Jm, (ar, 2 * Jj), gu[:, 0])
        np.add.at(Jm, (ar, 2 * Jj + 1), gu[:, 1])
        np.add.at(Jm, (ar, 2 * Ii), -gu[:, 0])
        np.add.at(Jm, (ar, 2 * Ii + 1), -gu[:, 1])
        if N > 0:
            np.add.at(Jm, (ar, 2 * P + ow), gto)
            np.add.at(Jm, (ar, 2 * P + ot), gtt)
        o = self.nvar_pose
        if fam == "sq":
            Jm[:, o] = (gd * Ww).sum(-1)
        elif fam == "hex":
            Jm[:, o] = (gd * (Ww @ HEX.T)).sum(-1)
        else:
            Jm[:, o] = gd[:, 0] * Ww[:, 0]
            Jm[:, o + 1] = gd[:, 0] * Ww[:, 1]
            Jm[:, o + 2] = gd[:, 1] * Ww[:, 1]
        return g, Jm, msep
