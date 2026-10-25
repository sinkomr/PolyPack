"""Seeded search for whole-sphere packings sphere/N/P (numpy/scipy; search only, never certification).

Polygons (N >= 3): variables are one quaternion per piece (piece 0 fixed at the identity: SO(3)
gauge), one separating-plane normal m per near pair, and the circumradius angle R on the unit
sphere. Constraints: m^.x >= mu for the vertices x of piece i and -m^.y >= mu for those of piece j,
m^ = m/|m| (cone separation: a plane through 0 strictly between the two cones proves disjointness).
Stage 1: penalty continuation  min -R + lam * sum relu(mu - s)^2  with L-BFGS-B, lam = 10 .. 1e7.
Stage 2: SLSQP polish of max R subject to the plane constraints (analytic Jacobian).
Basin hopping: perturb (jiggle all, re-place one piece, rotate one piece), shrink, repeat.

Disks (N = 0, the Tammes problem): centres c_i (normalised inside), minimise z subject to
c^_i.c^_j <= z, z = cos(2a). Same two stages.

Usage:
  python3 python/sphere/search.py --N 4 --P 3-24 --seed 1 --starts 8 --hops 20 --out RUNDIR
Writes RUNDIR/sphere_N_P.json with the best configuration (rho = 1/a), seeds and budget.
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
from scipy.optimize import minimize

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sgeom as sg  # noqa: E402

PI = math.pi


# ======================================================================== quaternion helpers (vectorised)

def rotate_all(Qn, V):
    """X[p, k] = rot(Qn[p]) V[k] for unit quaternions Qn (P, 4), V (N, 3) -> (P, N, 3)."""
    w = Qn[:, 0][:, None, None]
    u = Qn[:, 1:][:, None, :]
    Vb = V[None, :, :]
    uv = np.sum(u * Vb, axis=2, keepdims=True)
    uu = np.sum(u * u, axis=2, keepdims=True)
    return (w * w - uu) * Vb + 2 * uv * u + 2 * w * np.cross(u, Vb)


def rotate_grad(Qn, V, G):
    """d/dq^ of sum_k G[p,k].rot(q^_p) V[k]  -> (P, 4), using the unnormalised formula."""
    w = Qn[:, 0]
    u = Qn[:, 1:]
    gV = np.einsum("pkd,kd->pk", G, V)  # g_k . V_k
    VxG = np.cross(V[None, :, :], G)  # V_k x g_k
    gw = 2 * w * gV.sum(1) + 2 * np.einsum("pd,pd->p", u, VxG.sum(1))
    gu_ = (-2 * gV.sum(1)[:, None] * u
           + 2 * np.einsum("pk,kd->pd", np.einsum("pkd,pd->pk", G, u), V)
           + 2 * np.einsum("pk,pkd->pd", np.einsum("pd,kd->pk", u, V), G)
           + 2 * w[:, None] * VxG.sum(1))
    return np.concatenate([gw[:, None], gu_], axis=1)


def normalise_rows(A):
    n = np.linalg.norm(A, axis=1, keepdims=True)
    return A / n, n


def project_grad(g, Xn, n):
    """Chain rule through x^ = x/|x| (rows)."""
    return (g - np.sum(g * Xn, axis=1, keepdims=True) * Xn) / n


# ======================================================================== polygon model

class PolyModel:
    def __init__(self, N, P, pairs):
        self.N, self.P = N, P
        self.pairs = np.array(pairs, dtype=int).reshape(-1, 2)
        self.I = self.pairs[:, 0]
        self.J = self.pairs[:, 1]
        self.np_ = len(self.pairs)
        self.nq = 4 * (P - 1)
        self.nm = 3 * self.np_
        self.n = self.nq + self.nm + 1

    def pack(self, Q, M, R):
        return np.concatenate([Q[1:].ravel(), M.ravel(), [R]])

    def unpack(self, x):
        Q = np.vstack([[1.0, 0, 0, 0], x[: self.nq].reshape(-1, 4)])
        M = x[self.nq: self.nq + self.nm].reshape(-1, 3)
        R = x[-1]
        return Q, M, R

    def sides(self, x):
        """Constraint values s_i (np, N), s_j (np, N) and intermediates."""
        Q, M, R = self.unpack(x)
        Qn, qn = normalise_rows(Q)
        Mn, mn = normalise_rows(M) if self.np_ else (M, np.ones((0, 1)))
        V = sg.std_vertices(self.N, R)
        X = rotate_all(Qn, V)
        si = np.einsum("pkd,pd->pk", X[self.I], Mn)
        sj = -np.einsum("pkd,pd->pk", X[self.J], Mn)
        return si, sj, (Q, Qn, qn, M, Mn, mn, R, V, X)

    def penalty(self, x, mu):
        si, sj, (Q, Qn, qn, M, Mn, mn, R, V, X) = self.sides(x)
        vi = np.maximum(mu - si, 0.0)
        vj = np.maximum(mu - sj, 0.0)
        f = float(np.sum(vi * vi) + np.sum(vj * vj))
        # gradient: d f / d X and d f / d Mn
        GX = np.zeros_like(X)
        np.add.at(GX, self.I, -2 * vi[:, :, None] * Mn[:, None, :])
        np.add.at(GX, self.J, 2 * vj[:, :, None] * Mn[:, None, :])
        GMn = np.einsum("pk,pkd->pd", -2 * vi, X[self.I]) + np.einsum("pk,pkd->pd", 2 * vj, X[self.J])
        gQn = rotate_grad(Qn, V, GX)
        gQ = project_grad(gQn, Qn, qn)
        gM = project_grad(GMn, Mn, mn) if self.np_ else GMn
        dV = sg.std_vertices_dR(self.N, R)
        XdR = rotate_all(Qn, dV)
        gR = float(np.sum(GX * XdR))
        g = np.concatenate([gQ[1:].ravel(), gM.ravel(), [gR]])
        return f, g

    def cons(self, x, mu):
        si, sj, _ = self.sides(x)
        return np.concatenate([si.ravel(), sj.ravel()]) - mu

    def cons_jac(self, x, mu):
        N = self.N
        si, sj, (Q, Qn, qn, M, Mn, mn, R, V, X) = self.sides(x)
        npairs = self.np_
        nc = 2 * npairs * N
        Jm = np.zeros((nc, self.n))
        dV = sg.std_vertices_dR(N, R)
        XdR = rotate_all(Qn, dV)
        w = Qn[:, 0]
        u = Qn[:, 1:]
        for side, (P_idx, sign) in enumerate(((self.I, 1.0), (self.J, -1.0))):
            for k in range(N):
                rows = side * npairs * N + np.arange(npairs) * N + k
                g = sign * Mn  # (np, 3), gradient of s wrt X_k of the piece
                Vk = V[k]
                pw = w[P_idx]
                pu = u[P_idx]
                gV = g @ Vk
                VxG = np.cross(Vk[None, :], g)
                dw = 2 * pw * gV + 2 * np.sum(pu * VxG, axis=1)
                du = (-2 * gV[:, None] * pu + 2 * np.sum(g * pu, axis=1)[:, None] * Vk[None, :]
                      + 2 * (pu @ Vk)[:, None] * g + 2 * pw[:, None] * VxG)
                dqn = np.concatenate([dw[:, None], du], axis=1)
                Qp = Qn[P_idx]
                dq = (dqn - np.sum(dqn * Qp, axis=1, keepdims=True) * Qp) / qn[P_idx]
                for r in range(4):
                    cols = 4 * (P_idx - 1) + r
                    mask = P_idx > 0
                    Jm[rows[mask], cols[mask]] = dq[mask, r]
                # wrt m
                Xk = sign * X[P_idx, k, :]
                dm = (Xk - np.sum(Xk * Mn, axis=1, keepdims=True) * Mn) / mn
                for r in range(3):
                    Jm[rows, self.nq + 3 * np.arange(npairs) + r] = dm[:, r]
                Jm[rows, -1] = sign * np.sum(Mn * XdR[P_idx, k, :], axis=1)
        return Jm


def edge_normals(N, R):
    """Outward unit normals of the edge planes of the standard piece and their R-derivatives.
    Edge k (vertices k, k+1) lies on the great circle at angular distance r (inradius) from O in
    direction psi_k = phi_k + pi/N: U_k = (cos r cos psi_k, cos r sin psi_k, -sin r), tan r = tan R cos(pi/N)."""
    k = np.arange(N)
    psi = PI / 2 + 2 * PI * k / N + PI / N
    r = math.atan(math.tan(R) * math.cos(PI / N))
    drdR = math.cos(PI / N) / math.cos(R) ** 2 / (1 + (math.tan(R) * math.cos(PI / N)) ** 2)
    U = np.stack([math.cos(r) * np.cos(psi), math.cos(r) * np.sin(psi), np.full(N, -math.sin(r))], axis=1)
    dU = drdR * np.stack([-math.sin(r) * np.cos(psi), -math.sin(r) * np.sin(psi), np.full(N, -math.cos(r))], axis=1)
    return U, dU


def _qgrad_rows(Qn, qn, idx, g, Vrow):
    """Rows of d/dq (unnormalised) of g . rot(q^_idx) Vrow  (g, Vrow: (n, 3)); returns (n, 4)."""
    pw = Qn[idx, 0]
    pu = Qn[idx, 1:]
    gV = np.sum(g * Vrow, axis=1)
    VxG = np.cross(Vrow, g)
    dw = 2 * pw * gV + 2 * np.sum(pu * VxG, axis=1)
    du = (-2 * gV[:, None] * pu + 2 * np.sum(g * pu, axis=1)[:, None] * Vrow
          + 2 * np.sum(pu * Vrow, axis=1)[:, None] * g + 2 * pw[:, None] * VxG)
    dqn = np.concatenate([dw[:, None], du], axis=1)
    Qp = Qn[idx]
    return (dqn - np.sum(dqn * Qp, axis=1, keepdims=True) * Qp) / qn[idx]


class MixedModel:
    """Polish model: 'plane' pairs carry a normal variable (2N constraints), 'edge' pairs use a fixed
    edge plane of one piece (owner o, edge k; N constraints U_k(o) . y_l >= mu for the other piece)."""

    def __init__(self, N, P, plane_pairs, edge_pairs):
        self.N, self.P = N, P
        self.plane = PolyModel(N, P, plane_pairs)
        self.edges = np.array(edge_pairs, dtype=int).reshape(-1, 3)  # (owner, other, k)
        self.nq = 4 * (P - 1)
        self.nm = self.plane.nm
        self.n = self.nq + self.nm + 1
        self.pairs = self.plane.pairs

    def pack(self, Q, M, R):
        return self.plane.pack(Q, M, R)

    def unpack(self, x):
        return self.plane.unpack(x)

    def _edge_vals(self, x):
        Q, M, R = self.unpack(x)
        Qn, qn = normalise_rows(Q)
        V = sg.std_vertices(self.N, R)
        U, dU = edge_normals(self.N, R)
        X = rotate_all(Qn, V)
        O, T, K = self.edges[:, 0], self.edges[:, 1], self.edges[:, 2]
        Uw = rotate_all(Qn[O], U)[np.arange(len(O)), K]  # (ne, 3) placed edge normal
        vals = np.einsum("ed,ekd->ek", Uw, X[T])  # (ne, N)
        return vals, (Q, Qn, qn, R, V, U, dU, X, Uw, O, T, K)

    def cons(self, x, mu):
        parts = []
        if self.plane.np_:
            parts.append(self.plane.cons(x, mu))
        if len(self.edges):
            parts.append(self._edge_vals(x)[0].ravel() - mu)
        return np.concatenate(parts) if parts else np.zeros(0)

    def cons_jac(self, x, mu):
        blocks = []
        if self.plane.np_:
            blocks.append(self.plane.cons_jac(x, mu))
        if len(self.edges):
            N = self.N
            vals, (Q, Qn, qn, R, V, U, dU, X, Uw, O, T, K) = self._edge_vals(x)
            ne = len(O)
            Je = np.zeros((ne * N, self.n))
            XdR = rotate_all(Qn, sg.std_vertices_dR(N, R))
            dUw = rotate_all(Qn[O], dU)[np.arange(ne), K]
            for l in range(N):
                rows = np.arange(ne) * N + l
                y = X[T, l, :]
                # owner rotation: g = y, vector U_k
                dqo = _qgrad_rows(Qn, qn, O, y, U[K])
                dqt = _qgrad_rows(Qn, qn, T, Uw, np.repeat(V[l][None, :], ne, axis=0))
                for r in range(4):
                    mo = O > 0
                    Je[rows[mo], 4 * (O[mo] - 1) + r] += dqo[mo, r]
                    mt = T > 0
                    Je[rows[mt], 4 * (T[mt] - 1) + r] += dqt[mt, r]
                Je[rows, -1] = np.sum(dUw * y, axis=1) + np.sum(Uw * XdR[T, l, :], axis=1)
            blocks.append(Je)
        return np.vstack(blocks) if blocks else np.zeros((0, self.n))


def classify_pairs(N, P, Q, R, thr, tol=1e-3):
    """For pairs with max-margin < thr: an edge witness (owner, other, k) when some edge plane is
    within tol of the max-margin value, else a plane pair (with its max-margin normal)."""
    a = sg.a_from_R(N, R)
    iu, ju, g, nrm = sg.pair_gaps(N, P, a, Q)
    sel = g < thr
    Ms = np.array([sg.qmat(q) for q in Q])
    V = sg.std_vertices(N, R)
    U, _ = edge_normals(N, R)
    X = np.einsum("pij,kj->pki", Ms, V)
    UW = np.einsum("pij,kj->pki", Ms, U)
    planes, edges, mm = [], [], {}
    for i, j, gg, n in zip(iu[sel], ju[sel], g[sel], nrm[sel]):
        i, j = int(i), int(j)
        ei = (UW[i] @ X[j].T).min(axis=1)  # edges of i against vertices of j
        ej = (UW[j] @ X[i].T).min(axis=1)
        ki, kj = int(np.argmax(ei)), int(np.argmax(ej))
        if max(ei[ki], ej[kj]) >= gg - tol:
            edges.append((i, j, ki) if ei[ki] >= ej[kj] else (j, i, kj))
        else:
            planes.append((i, j))
            mm[(i, j)] = n
    return planes, edges, mm


def near_pairs(Q, R, slack):
    C = np.array([sg.qmat(q)[:, 2] for q in Q])
    P = len(Q)
    lim = math.cos(min(PI, 2 * R + slack))
    G = C @ C.T
    return [(i, j) for i in range(P) for j in range(i + 1, P) if G[i, j] > lim], C


def init_normals(pairs, C, old=None):
    M = []
    for (i, j) in pairs:
        if old is not None and (i, j) in old:
            M.append(old[(i, j)])
            continue
        v = C[i] - C[j]
        nv = np.linalg.norm(v)
        M.append(v / nv if nv > 1e-9 else np.array([1.0, 0, 0]))
    return np.array(M).reshape(-1, 3)


def Rmax(N):
    return PI / 2 - 1e-6


def poly_penalty_solve(N, P, Q, R, rng=None, lams=(10, 100, 1e3), mu=0.0, slack=0.35, maxiter=500):
    normals = None
    for lam in lams:
        pairs, C = near_pairs(Q, R, slack)
        M = init_normals(pairs, C, normals)
        model = PolyModel(N, P, pairs)
        x0 = model.pack(Q, M, R)
        bounds = [(None, None)] * (model.n - 1) + [(1e-3, Rmax(N))]

        def fun(x):
            f, g = model.penalty(x, mu)
            gg = lam * g
            gg[-1] -= 1.0
            return -x[-1] + lam * f, gg

        res = minimize(fun, x0, jac=True, method="L-BFGS-B", bounds=bounds,
                       options={"maxiter": maxiter, "ftol": 1e-15, "gtol": 1e-12})
        Q, M, R = model.unpack(res.x)
        Q = Q / np.linalg.norm(Q, axis=1, keepdims=True)
        Q[0] = [1, 0, 0, 0]
        normals = {tuple(p): M[k] / np.linalg.norm(M[k]) for k, p in enumerate(map(tuple, model.pairs))}
    return Q, R, normals


def margin_pairs(N, P, Q, R, thr):
    """Pairs whose max-margin gap is below thr, with their max-margin normals (initial planes)."""
    iu, ju, g, nrm = sg.pair_gaps(N, P, sg.a_from_R(N, R), Q)
    sel = g < thr
    return [(int(i), int(j)) for i, j in zip(iu[sel], ju[sel])], {(int(i), int(j)): n for i, j, n in zip(iu[sel], ju[sel], nrm[sel])}


def poly_polish(N, P, Q, R, normals=None, mu=0.0, thr=0.03, maxiter=150, rounds=10, box=0.05, log=None):
    """SLSQP: maximise R subject to separation constraints >= mu on the pairs with small max-margin
    (edge witnesses where an edge plane is nearly optimal, plane variables otherwise), inside a box
    trust region (quaternion components +-box, R <= (1 + box/2) R0) re-centred every round; pairs found
    (nearly) touching outside the model are added. Returns (Q, R, normals, ok); normals are the
    max-margin planes of the final configuration (certificate witnesses)."""
    ok = False
    extra = set()
    for rnd in range(rounds):
        planes, edges, mm = classify_pairs(N, P, Q, R, thr)
        have = set(planes) | {(min(o, t), max(o, t)) for o, t, _ in edges}
        for p in extra:
            if p not in have:
                planes.append(p)
        planes = sorted(set(planes))
        _, C = near_pairs(Q, R, 0.0)
        M = init_normals(planes, C, mm)
        model = MixedModel(N, P, planes, edges)
        x0 = model.pack(Q, M, R)
        bounds = ([(v - box, v + box) for v in x0[: model.nq]] + [(None, None)] * model.nm
                  + [(max(1e-3, 0.5 * R), min(Rmax(N), R * (1 + box / 2)))])
        res = minimize(lambda x: -x[-1], x0, jac=lambda x: np.concatenate([np.zeros(model.n - 1), [-1.0]]),
                       method="SLSQP", bounds=bounds,
                       constraints=[{"type": "ineq", "fun": lambda x: model.cons(x, mu),
                                     "jac": lambda x: model.cons_jac(x, mu)}],
                       options={"maxiter": maxiter, "ftol": 1e-16})
        Qn, Mn, Rn = model.unpack(res.x)
        Qn = Qn / np.linalg.norm(Qn, axis=1, keepdims=True)
        Qn[0] = [1, 0, 0, 0]
        cons = model.cons(model.pack(Qn, Mn, Rn), mu)
        viol = float(-min(0.0, cons.min())) if len(cons) else 0.0
        iu, ju, g, _ = sg.pair_gaps(N, P, sg.a_from_R(N, Rn), Qn)
        known = set(planes) | {(min(o, t), max(o, t)) for o, t, _ in edges}
        missing = [(int(i), int(j)) for i, j, gg in zip(iu, ju, g) if gg < mu + 1e-9 and (int(i), int(j)) not in known]
        if log:
            log(f"    polish round {rnd}: R={Rn:.15f} viol={viol:.2e} nit={res.nit} st={res.status} planes={len(planes)} edges={len(edges)} missing={len(missing)}")
        if not np.isfinite(Rn) or (viol > 1e-6 and Rn > R):
            box *= 0.3
            extra |= set(missing)
            continue
        hit_box = Rn >= R * (1 + box / 2) - 1e-12
        converged = abs(Rn - R) < 1e-14 * max(1.0, R)
        Q, R = Qn, Rn
        extra |= set(missing)
        if viol < 1e-11 and not missing and not hit_box and (res.status == 0 or converged):
            ok = True
            break
    iu, ju, g, nrm = sg.pair_gaps(N, P, sg.a_from_R(N, R), Q)
    normals = {(int(i), int(j)): n for i, j, n in zip(iu, ju, nrm)}
    return Q, R, normals, ok


def true_R(N, P, Q, R):
    """Largest R' <= R at which the configuration is valid (float), by bisection on the max-margin gap."""
    g, _ = sg.validate(N, P, sg.a_from_R(N, R), Q)
    if g >= 0:
        return R, g
    lo = R
    while True:
        lo *= 0.9
        if lo < 1e-4:
            return 0.0, -1.0
        if sg.validate(N, P, sg.a_from_R(N, lo), Q)[0] >= 0:
            break
    hi = lo / 0.9
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        g, _ = sg.validate(N, P, sg.a_from_R(N, mid), Q)
        if g >= 0:
            lo = mid
        else:
            hi = mid
    return lo, sg.validate(N, P, sg.a_from_R(N, lo), Q)[0]


def random_quats(P, rng):
    Q = []
    for i in range(P):
        if i == 0:
            Q.append(np.array([1.0, 0, 0, 0]))
            continue
        c = rng.normal(size=3)
        Q.append(sg.q_from_centre_theta(c, rng.uniform(0, 2 * PI)))
    return np.array(Q)


def quats_from_centres(Cs, rng, theta_mode="random"):
    Cs = np.asarray(Cs, float)
    # rotate so that centre 0 is at the north pole
    q0 = sg.q_from_centre_theta(Cs[0], 0.0)
    M0 = sg.qmat(q0)
    Cs = Cs @ M0  # M0^T applied to each row
    Q = []
    for i, c in enumerate(Cs):
        th = 0.0 if i == 0 else (rng.uniform(0, 2 * PI) if theta_mode == "random" else 0.0)
        Q.append(sg.q_from_centre_theta(c, th) if i else np.array([1.0, 0, 0, 0]))
    return np.array(Q)


def R_area(N, P):
    """Circumradius at which P pieces have total area 4 pi (area bound)."""
    target = ((N - 2) * PI + 4 * PI / P) / N  # interior angle alpha*
    if target >= PI:
        return Rmax(N)
    # cos(a/2) = cos(pi/N)/sin(alpha*/2)
    ca = math.cos(PI / N) / math.sin(target / 2)
    a = 2 * math.acos(min(1.0, ca))
    return sg.R_from_a(N, a)


def perturb(Q, rng, kind, scale):
    Q = Q.copy()
    P = len(Q)
    if kind == "jiggle":
        for i in range(1, P):
            dq = np.concatenate([[1.0], rng.normal(scale=scale, size=3)])
            Q[i] = sg.qmul(dq, Q[i])
    elif kind == "replace":
        i = int(rng.integers(1, P))
        Q[i] = sg.q_from_centre_theta(rng.normal(size=3), rng.uniform(0, 2 * PI))
    elif kind == "spin":
        for i in rng.choice(np.arange(1, P), size=max(1, P // 4), replace=False):
            th = rng.uniform(0, 2 * PI)
            Q[i] = sg.qmul(Q[i], np.array([math.cos(th / 2), 0, 0, math.sin(th / 2)]))
    Q = Q / np.linalg.norm(Q, axis=1, keepdims=True)
    # re-gauge so that piece 0 is the identity: Q_i <- Q_0^{-1} Q_i
    q0inv = Q[0] * np.array([1, -1, -1, -1])
    Q = np.array([sg.qmul(q0inv, q) for q in Q])
    Q[0] = [1, 0, 0, 0]
    return Q


def platonic_centres(P):
    """Face centres of the Platonic solid with P faces (P in 4, 6, 8, 12, 20), else None."""
    phi = (1 + math.sqrt(5)) / 2
    if P == 4:
        return np.array([[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]], float)
    if P == 6:
        return np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], float)
    if P == 8:
        return np.array([[x, y, z] for x in (1, -1) for y in (1, -1) for z in (1, -1)], float)
    if P == 12:
        v = []
        for s1 in (1, -1):
            for s2 in (1, -1):
                v += [[0, s1, s2 * phi], [s1, s2 * phi, 0], [s2 * phi, 0, s1]]
        return np.array(v, float)
    if P == 20:
        v = [[x, y, z] for x in (1, -1) for y in (1, -1) for z in (1, -1)]
        for s1 in (1, -1):
            for s2 in (1, -1):
                # dodecahedron dual to the icosahedron of P = 12 (same orientation)
                v += [[0, s1 * phi, s2 / phi], [s1 / phi, 0, s2 * phi], [s1 * phi, s2 / phi, 0]]
        return np.array(v, float)
    return None


def code_start(C, N, rng, jitter=0.05, aligned=False):
    """Quaternions from a (Tammes) point code: randomly rotated and jittered centres; theta random, or
    'aligned' so that an edge of each piece faces its nearest neighbour (edge midpoint direction
    pi/2 + pi/N + theta in the local frame T(c) e1, T(c) e2)."""
    C = np.asarray(C, float)
    A = np.linalg.qr(rng.normal(size=(3, 3)))[0]
    C = C @ A.T + rng.normal(scale=jitter, size=C.shape)
    C /= np.linalg.norm(C, axis=1, keepdims=True)
    Q = []
    for i, c in enumerate(C):
        if aligned:
            G = C @ c
            G[i] = -2
            cj = C[int(np.argmax(G))]
            T = sg.qmat(sg.q_from_centre_theta(c, 0.0))
            d = cj - (cj @ c) * c
            psi = math.atan2(d @ T[:, 1], d @ T[:, 0])
            th = psi - PI / 2 - PI / N
        else:
            th = rng.uniform(0, 2 * PI)
        Q.append(sg.q_from_centre_theta(c, th))
    Q = np.array(Q)
    q0inv = Q[0] * np.array([1, -1, -1, -1])
    Q = np.array([sg.qmul(q0inv, q) for q in Q])
    Q[0] = [1, 0, 0, 0]
    return Q


def add_piece(Q, rng, samples=4000):
    """Previous optimum plus one piece at the sampled point farthest from all centres."""
    C = np.array([sg.centre(q) for q in Q])
    S = rng.normal(size=(samples, 3))
    S /= np.linalg.norm(S, axis=1, keepdims=True)
    far = S[np.argmin((S @ C.T).max(axis=1))]
    return np.vstack([Q, sg.q_from_centre_theta(far, rng.uniform(0, 2 * PI))])


def solve_polygon(N, P, seed, starts, hops, starts_centres=None, time_limit=600, log=None, prev_Q=None, warm_Q=None,
                  code_mix=False):
    rng = np.random.default_rng([seed, N, P])
    t0 = time.time()
    best = None
    Ra = R_area(N, P)
    history = []

    def run_from(Q, R0, tag):
        nonlocal best
        Q1, R1, normals = poly_penalty_solve(N, P, Q, R0)
        Rv, _ = true_R(N, P, Q1, R1)
        cand = (Rv, Q1, R1, normals)
        history.append((tag, Rv))
        if best is None or Rv > best[0] * (1 - 3e-3):
            Q2, R2, n2, ok = poly_polish(N, P, Q1, Rv, normals, rounds=12)
            Rv2, _ = true_R(N, P, Q2, R2)
            if Rv2 > Rv:
                cand = (Rv2, Q2, R2, n2)
            history[-1] = (tag, cand[0])
        if best is None or cand[0] > best[0] + 1e-13:
            best = cand
            if log:
                log(f"  N={N} P={P} {tag}: R={cand[0]:.12f} rho={1 / sg.a_from_R(N, cand[0]):.12f}")
        return cand

    special = []
    if warm_Q is not None and len(warm_Q) == P:
        special.append((np.asarray(warm_Q, float), "warm"))
    if platonic_centres(P) is not None:
        special.append((quats_from_centres(platonic_centres(P), rng), "platonic"))
    if prev_Q is not None and len(prev_Q) == P - 1:
        special.append((add_piece(np.asarray(prev_Q, float), rng), "prev+1"))
    for c in (starts_centres or []):
        special.append((quats_from_centres(c, rng), "code"))
    for s in range(starts):
        if time.time() - t0 > time_limit:
            break
        if s < len(special):
            Q, kind = special[s]
            tag = f"start{s}:{kind}"
        elif code_mix and starts_centres and s % 2 == 0:
            # optional (--code-mix): every other random start is a rotated, jittered Tammes code with
            # random or neighbour-aligned orientations
            aligned = (s // 2) % 2 == 1
            Q = code_start(starts_centres[0], N, rng, aligned=aligned)
            tag = f"start{s}:code-{'aligned' if aligned else 'random'}"
        else:
            Q = random_quats(P, rng)
            tag = f"start{s}:random"
        run_from(Q, 0.6 * Ra, tag)
    kinds = ["jiggle", "replace", "spin"]
    for h in range(hops):
        if time.time() - t0 > time_limit:
            break
        kind = kinds[h % 3]
        Q = perturb(best[1], rng, kind, 0.15)
        run_from(Q, best[0] * 0.95, f"hop{h}:{kind}")
    Rv, Q, R, normals = best
    return {"R": Rv, "Q": Q, "normals": normals, "history": history, "time": time.time() - t0}


# ======================================================================== disks (Tammes)

def disk_penalty_solve(P, C, z, lams=(10, 100, 1e3, 1e4, 1e5, 1e6, 1e7)):
    iu = np.triu_indices(P, 1)

    for lam in lams:
        def fun(x):
            Cx = x[:-1].reshape(P, 3)
            Cn, cn = normalise_rows(Cx)
            G = Cn @ Cn.T
            v = np.maximum(G[iu] - x[-1], 0.0)
            f = np.sum(v * v)
            W = np.zeros((P, P))
            W[iu] = 2 * v
            W = W + W.T
            gCn = W @ Cn
            gC = project_grad(gCn, Cn, cn)
            gz = -np.sum(2 * v)
            return x[-1] + lam * f, np.concatenate([lam * gC.ravel(), [1 + lam * gz]])

        x0 = np.concatenate([C.ravel(), [z]])
        res = minimize(fun, x0, jac=True, method="L-BFGS-B", bounds=[(None, None)] * (3 * P) + [(-1, 1)],
                       options={"maxiter": 3000, "ftol": 1e-15, "gtol": 1e-12})
        C = res.x[:-1].reshape(P, 3)
        C = C / np.linalg.norm(C, axis=1, keepdims=True)
        z = res.x[-1]
    return C, z


def disk_polish(P, C, z):
    iu = np.triu_indices(P, 1)
    npair = len(iu[0])

    def cons(x):
        Cn, _ = normalise_rows(x[:-1].reshape(P, 3))
        return x[-1] - (Cn @ Cn.T)[iu]

    def jac(x):
        Cx = x[:-1].reshape(P, 3)
        Cn, cn = normalise_rows(Cx)
        Jm = np.zeros((npair, 3 * P + 1))
        Jm[:, -1] = 1.0
        a, b = iu
        ga = -Cn[b]
        gb = -Cn[a]
        ga = (ga - np.sum(ga * Cn[a], axis=1, keepdims=True) * Cn[a]) / cn[a]
        gb = (gb - np.sum(gb * Cn[b], axis=1, keepdims=True) * Cn[b]) / cn[b]
        rows = np.arange(npair)
        for r in range(3):
            Jm[rows, 3 * a + r] = ga[:, r]
            Jm[rows, 3 * b + r] = gb[:, r]
        return Jm

    x0 = np.concatenate([C.ravel(), [z]])
    res = minimize(lambda x: x[-1], x0, jac=lambda x: np.concatenate([np.zeros(3 * P), [1.0]]), method="SLSQP",
                   constraints=[{"type": "ineq", "fun": cons, "jac": jac}], bounds=[(None, None)] * (3 * P) + [(-1, 1)],
                   options={"maxiter": 500, "ftol": 1e-16})
    C = res.x[:-1].reshape(P, 3)
    C = C / np.linalg.norm(C, axis=1, keepdims=True)
    return C


def disk_true_z(C):
    G = C @ C.T
    P = len(C)
    return float(np.max(G[np.triu_indices(P, 1)]))


def solve_disks(P, seed, starts, hops, time_limit=300, log=None):
    rng = np.random.default_rng([seed, 0, P])
    t0 = time.time()
    best = None
    history = []

    def run_from(C, tag):
        nonlocal best
        z0 = disk_true_z(C)
        C1, z1 = disk_penalty_solve(P, C, min(z0, 0.99))
        C2 = disk_polish(P, C1, disk_true_z(C1))
        z = disk_true_z(C2)
        if disk_true_z(C1) < z:
            C2, z = C1, disk_true_z(C1)
        history.append((tag, z))
        if best is None or z < best[0] - 1e-14:
            best = (z, C2)
            if log:
                log(f"  disks P={P} {tag}: theta={math.degrees(math.acos(z)):.10f} deg rho={2 / math.acos(z):.12f}")

    for s in range(starts):
        if time.time() - t0 > time_limit:
            break
        run_from(rng.normal(size=(P, 3)), f"start{s}")
    for h in range(hops):
        if time.time() - t0 > time_limit:
            break
        C = best[1] + rng.normal(scale=0.08, size=(P, 3))
        if h % 2:
            C[int(rng.integers(P))] = rng.normal(size=3)
        run_from(C, f"hop{h}")
    z, C = best
    # gauge: centre 0 at the north pole, quaternions with theta = 0
    Q = quats_from_centres(C, rng, theta_mode="zero")
    return {"z": z, "C": C, "Q": Q, "history": history, "time": time.time() - t0}


# ======================================================================== CLI

def parse_range(s):
    out = []
    for part in s.split(","):
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--N", type=int, required=True)
    ap.add_argument("--P", required=True)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--starts", type=int, default=8)
    ap.add_argument("--hops", type=int, default=20)
    ap.add_argument("--time", type=float, default=600)
    ap.add_argument("--codes", default=None, help="run dir with disk results used as polygon starting centres")
    ap.add_argument("--warm", default=None, help="run dir whose sphere_N_P.json is used as an extra start")
    ap.add_argument("--code-mix", action="store_true", help="every other random start from the Tammes code (rotated, jittered)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    logf = open(os.path.join(args.out, f"log_N{args.N}.txt"), "a")

    def log(msg):
        print(msg, flush=True)
        logf.write(msg + "\n")
        logf.flush()

    for P in parse_range(args.P):
        t = time.time()
        if args.N == 0:
            r = solve_disks(P, args.seed, args.starts, args.hops, args.time, log)
            a = math.acos(r["z"]) / 2
            out = {"N": 0, "P": P, "a": a, "rho": 1 / a, "q": r["Q"].tolist(), "seed": args.seed,
                   "budget": {"starts": args.starts, "hops": args.hops, "time_limit_s": args.time},
                   "time_s": r["time"], "history": r["history"]}
        else:
            codes = None
            if args.codes:
                fn = os.path.join(args.codes, f"sphere_0_{P}.json")
                if os.path.exists(fn):
                    d = json.load(open(fn))
                    codes = [[sg.centre(q) for q in d["q"]]]
            prev = None
            fp = os.path.join(args.out, f"sphere_{args.N}_{P - 1}.json")
            if os.path.exists(fp):
                prev = json.load(open(fp))["q"]
            warm = None
            if args.warm:
                fw = os.path.join(args.warm, f"sphere_{args.N}_{P}.json")
                if os.path.exists(fw):
                    warm = json.load(open(fw))["q"]
            r = solve_polygon(args.N, P, args.seed, args.starts, args.hops, codes, args.time, log, prev, warm, args.code_mix)
            a = sg.a_from_R(args.N, r["R"])
            out = {"N": args.N, "P": P, "R": r["R"], "a": a, "rho": 1 / a, "q": r["Q"].tolist(),
                   "normals": [[int(i), int(j)] + list(map(float, n)) for (i, j), n in r["normals"].items()],
                   "seed": args.seed,
                   "budget": {"starts": args.starts, "hops": args.hops, "time_limit_s": args.time,
                              "code_start": bool(codes), "warm_start": bool(warm), "code_mix": bool(args.code_mix)},
                   "time_s": r["time"], "history": r["history"]}
        with open(os.path.join(args.out, f"sphere_{args.N}_{P}.json"), "w") as f:
            json.dump(out, f)
        log(f"N={args.N} P={P}: rho={out['rho']:.12f}  ({time.time() - t:.1f}s)")


if __name__ == "__main__":
    main()
