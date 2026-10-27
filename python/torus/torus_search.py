"""Seeded search for PolyPack pieces on flat tori (float; not a proof).

Method (see docs/spaces/TORUS.md):
  * sequential linear programming in the spirit of Torquato and Jiao's adaptive
    shrinking cell: linearise every near contact (SAT edge/vertex rows for
    polygons, centre distance for disks) in the fractional centres, the angles
    and the lattice parameters, minimise the cell size inside a trust box, accept
    by a merit ratio test, shrink the box until it falls below a floor;
  * structured seeds: translative lattice packings on every superlattice of the
    family lattice, replications of smaller solutions on sublattices (same
    density), insertion of one piece into the P-1 solution, solutions of other
    families (free only), random sequential addition at low density;
  * basin hopping on the incumbent (expand + jitter, kick k pieces, rotate one).
The final configuration is polished with the trust floor at 1e-11.
Uses numpy/scipy (search only). Results go to JSON; certification is separate.
"""

import argparse
import json
import math
import os
import sys
import time

import numpy as np
from scipy.optimize import linprog

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from torus_np import (  # noqa: E402
    HEX,
    SQ3_2,
    Geometry,
    State,
    basis_of,
    cartesian,
    from_cartesian,
    gauss_reduce,
    metric_of,
    normalise_free,
    piece_area,
    score_of,
    shape_radii,
)

LP_OPTS = {
    "primal_feasibility_tolerance": 1e-10,
    "dual_feasibility_tolerance": 1e-10,
    # scipy 1.7's HiGHS can stall on these highly degenerate LPs; a stalled
    # solve is treated like a failed step (the trust box shrinks)
    "time_limit": 2.0,
}
CHILD_TIMEOUT_S = 90.0


def symmetric_angle(N, th):
    if N == 0:
        return 0.0 * th
    per = 2 * math.pi / N
    return th - per * np.floor(th / per)


# ---------------------------------------------------------------------- isolation
CRASHES = [0]


def isolated(fn, *args, **kw):
    """Run fn in a forked child; return its result, or None if the child died.

    scipy 1.7's HiGHS occasionally aborts the whole process (uncaught C++
    exception "singular-basis-matrix"). Each local solve therefore runs in a
    child process; a crash discards that solve only. The parent's random stream
    is untouched, so a run stays reproducible from its seed.
    """
    import pickle

    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        try:
            data = pickle.dumps(fn(*args, **kw))
        except BaseException:
            data = b""
        with os.fdopen(w, "wb") as f:
            f.write(data)
        os._exit(0)
    import select
    import signal

    os.close(w)
    chunks = []
    deadline = time.time() + CHILD_TIMEOUT_S
    killed = False
    with os.fdopen(r, "rb", buffering=0) as f:
        while True:
            left = deadline - time.time()
            if left <= 0:
                os.kill(pid, signal.SIGKILL)
                killed = True
                break
            ready, _, _ = select.select([f], [], [], left)
            if not ready:
                continue
            chunk = f.read(1 << 16)
            if not chunk:
                break
            chunks.append(chunk)
    _, status = os.waitpid(pid, 0)
    data = b"".join(chunks)
    if killed or status != 0 or not data:
        CRASHES[0] += 1
        return None
    return pickle.loads(data)


# ---------------------------------------------------------------------- LP core
def lp_step(geo, st, delta, slack_cost):
    fam, P, N = geo.family, geo.P, geo.N
    gap_tol = max(6.0 * delta, 1e-7)
    vwin = max(6.0 * delta, 1e-9)
    g, Jm, msep = geo.rows(st, gap_tol, vwin)
    nv = geo.nvar_pose + geo.npar
    B = basis_of(fam, st.params)
    S = max(math.hypot(B[0, 0], B[1, 0]), math.hypot(B[0, 1], B[1, 1]))
    scale = np.empty(nv)
    scale[: 2 * P] = delta / S
    if N > 0:
        scale[2 * P : 3 * P] = delta / geo.R
    scale[geo.nvar_pose :] = delta
    c = np.zeros(nv + 1)
    if fam == "free":
        a, _, cc = st.params
        c[geo.nvar_pose] = cc
        c[geo.nvar_pose + 2] = a
    else:
        c[geo.nvar_pose] = 1.0
    c[:nv] *= scale
    c[nv] = slack_cost * delta
    bounds = [(-1.0, 1.0)] * nv + [(0.0, None)]
    bounds[0] = (0.0, 0.0)
    bounds[1] = (0.0, 0.0)
    if len(g):
        A = np.zeros((len(g), nv + 1))
        A[:, :nv] = -Jm * scale
        A[:, nv] = -delta
        # rows scaled by their gradient norm for conditioning
        nrm = np.sqrt((A * A).sum(1)) + 1e-300
        A /= nrm[:, None]
        b = g / nrm
        # drop duplicate rows (tied vertices of parallel edges); keep the tighter rhs
        key, inv = np.unique(np.round(A, 11), axis=0, return_inverse=True)
        if len(key) < len(A):
            inv = inv.reshape(-1)
            bb = np.full(len(key), np.inf)
            np.minimum.at(bb, inv, b)
            first = np.full(len(key), -1)
            first[inv[::-1]] = np.arange(len(A))[::-1]
            A, b = A[first], bb
        try:
            res = linprog(c, A_ub=A, b_ub=b, bounds=bounds, method="highs", options=LP_OPTS)
        except Exception:
            return None, msep, None
    else:
        res = linprog(c, bounds=bounds, method="highs", options=LP_OPTS)
    if res.status != 0 or res.x is None:
        return None, msep, None
    y = res.x
    dz = y[:nv] * scale
    slack = y[nv] * delta
    at_bound = np.mean(np.abs(y[:nv]) > 0.999)
    return dz, msep, (slack, at_bound)


def apply_dz(geo, st, dz):
    P, N = geo.P, geo.N
    ns = st.copy()
    ns.U = ns.U + dz[: 2 * P].reshape(P, 2)
    if N > 0:
        ns.TH = ns.TH + dz[2 * P : 3 * P]
    ns.params = ns.params + dz[geo.nvar_pose :]
    ns.U -= np.floor(ns.U)
    if geo.family == "free":
        normalise_free(ns)
    return ns


def compress(geo, st, delta0=0.2, delta_min=1e-5, max_iter=400, deadline=None):
    """Trust-region SLP minimisation of the cell size. Returns (state, msep)."""
    fam = geo.family
    if fam == "free":
        normalise_free(st)
    delta = delta0
    msep = geo.min_sep(st)
    it = 0
    while it < max_iter and delta >= delta_min:
        if deadline is not None and time.time() > deadline:
            break
        it += 1
        m0 = metric_of(fam, st.params)
        rho = 3.0 * m0
        ov0 = max(0.0, -msep)
        dz, msep_cur, info = lp_step(geo, st, delta, slack_cost=50.0 * rho)
        if dz is None:
            # numerical failure: open the cell a little and retry smaller
            st = scale_state(geo, st, 1.0 + max(4 * ov0, 1e-9))
            msep = geo.min_sep(st)
            delta *= 0.5
            continue
        slack, at_bound = info
        o = geo.nvar_pose
        if fam == "free":
            a, _, c = st.params
            pred_m = -(c * dz[o] + a * dz[o + 2])
        else:
            pred_m = -dz[o]
        pred = pred_m + rho * (ov0 - slack)
        if pred <= 1e-15 * (1.0 + m0):
            delta *= 0.25
            continue
        ns = apply_dz(geo, st, dz)
        msep_new = geo.min_sep(ns)
        actual = m0 + rho * ov0 - (metric_of(fam, ns.params) + rho * max(0.0, -msep_new))
        ratio = actual / pred
        if ratio < 0.1:
            delta *= 0.3
            continue
        st, msep = ns, msep_new
        if ratio > 0.75 and at_bound > 0.0:
            delta = min(2.0 * delta, 0.5)
        elif ratio < 0.4:
            delta *= 0.5
    return st, msep


def scale_state(geo, st, f):
    ns = st.copy()
    if geo.family == "free":
        ns.params = ns.params * f
    else:
        ns.params = ns.params * f
    return ns


def repair(geo, st, target=0.0):
    """Scale the cell up until min separation >= target (scaling never hurts)."""
    for _ in range(60):
        ms = geo.min_sep(st)
        if ms >= target:
            return st, ms
        st = scale_state(geo, st, 1.0 + max(1e-12, min(0.5, -ms + 1e-12)))
    return st, geo.min_sep(st)


def polish(geo, st, deadline=None):
    st, ms = compress(geo, st, delta0=1e-3, delta_min=1e-11, max_iter=600, deadline=deadline)
    return st, ms


# ---------------------------------------------------------------------- seeds
def unit_area(fam):
    return SQ3_2 if fam == "hex" else 1.0


def params_for_area(fam, area, rng=None, shape=None):
    if fam == "sq":
        return np.array([math.sqrt(area)])
    if fam == "hex":
        return np.array([math.sqrt(area / SQ3_2)])
    if shape is not None:
        a, b_over_a = shape
    else:
        a = math.sqrt(area) * math.exp(rng.normal(0, 0.25))
        b_over_a = rng.uniform(-0.5, 0.5)
    return np.array([a, b_over_a * a, area / a])


def random_state(geo, rng, density=0.25):
    fam, N, P = geo.family, geo.N, geo.P
    area = P * geo.area_piece / density
    for _attempt in range(40):
        params = params_for_area(fam, area, rng)
        st = State(params, np.zeros((P, 2)), np.zeros(P))
        ok = True
        for i in range(P):
            placed = False
            for _try in range(300):
                st.U[i] = rng.uniform(0, 1, 2)
                st.TH[i] = rng.uniform(0, 2 * math.pi) if N > 0 else 0.0
                sub = Geometry(fam, N, i + 1)
                s2 = State(st.params, st.U[: i + 1], st.TH[: i + 1])
                if sub.min_sep(s2) > 0.02:
                    placed = True
                    break
            if not placed:
                ok = False
                break
        if ok:
            return st
        area *= 1.3
    return st


def hnf_list(n):
    """Column-style Hermite normal forms of determinant n: every SUBlattice B M Z^2 of
    index n of B Z^2 arises from exactly one (M is determined up to right unimodular factors)."""
    out = []
    for a in range(1, n + 1):
        if n % a:
            continue
        d = n // a
        for b in range(a):
            out.append(np.array([[a, b], [0, d]], dtype=np.int64))
    return out


def super_list(n):
    """Integer M of determinant n such that M^{-1} Z^2 runs over every SUPERlattice of Z^2 of
    index n exactly once. M^{-1} Z^2 = M'^{-1} Z^2 iff M' = U M with U unimodular, so the
    canonical form is the row-style Hermite form: upper triangular with 0 <= b < d.
    (The column-style list above misses most superlattices, e.g. all but two for prime n.)"""
    out = []
    for a in range(1, n + 1):
        if n % a:
            continue
        d = n // a
        for b in range(d):
            out.append(np.array([[a, b], [0, d]], dtype=np.int64))
    return out


def coset_reps(M):
    """Integer points k with M^{-1} k in [0,1)^2 (representatives of Z^2 / M Z^2)."""
    Mi = np.linalg.inv(M.astype(float))
    corners = np.array([[0, 0], [1, 0], [0, 1], [1, 1]], float) @ M.T.astype(float)
    lo = np.floor(corners.min(0)).astype(int) - 1
    hi = np.ceil(corners.max(0)).astype(int) + 1
    reps = []
    for x in range(lo[0], hi[0] + 1):
        for y in range(lo[1], hi[1] + 1):
            f = Mi @ np.array([x, y], float)
            if (f > -1e-9).all() and (f < 1 - 1e-9).all():
                reps.append((x, y))
    return np.array(reps, dtype=float)


def gauge_D(N, theta, V):
    """Gauge of the difference body K - K at vectors V (n,2): V not in int(K-K) iff gauge >= 1."""
    if N == 0:
        return np.sqrt((V * V).sum(-1)) / 2.0
    R, r = shape_radii(N)
    k = np.arange(N)
    al = theta + math.pi / 2 + math.pi / N + 2 * math.pi * k / N
    proj = np.abs(V[:, 0:1] * np.cos(al) + V[:, 1:2] * np.sin(al))
    width = (r + R) if N % 2 else 2 * r
    return proj.max(1) / width


def lattice_scale(N, theta, G):
    """Smallest s such that s * G (columns: lattice basis) is a packing lattice of K(theta)."""
    Gr, _ = gauss_reduce(G)
    m = np.arange(-3, 4)
    co = np.stack(np.meshgrid(m, m, indexing="ij"), -1).reshape(-1, 2).astype(float)
    co = co[(co != 0).any(1)]
    V = co @ Gr.T
    return 1.0 / gauge_D(N, theta, V).min()


def best_theta(N, G, ngrid=90):
    if N == 0:
        return 0.0, lattice_scale(0, 0.0, G)
    per = 2 * math.pi / N
    ths = np.linspace(0, per, ngrid, endpoint=False)
    vals = np.array([lattice_scale(N, t, G) for t in ths])
    i = int(vals.argmin())
    lo, hi = ths[i] - per / ngrid, ths[i] + per / ngrid
    gr = (math.sqrt(5) - 1) / 2
    for _ in range(40):
        x1 = hi - gr * (hi - lo)
        x2 = lo + gr * (hi - lo)
        if lattice_scale(N, x1, G) < lattice_scale(N, x2, G):
            hi = x2
        else:
            lo = x1
    t = 0.5 * (lo + hi)
    return t, lattice_scale(N, t, G)


def lattice_seeds(geo, top=4):
    """Translative lattice packings with P pieces per cell of the family lattice."""
    fam, N, P = geo.family, geo.N, geo.P
    if fam == "free":
        return []
    F = HEX if fam == "hex" else np.eye(2)
    cands = []
    for M in super_list(P):
        G = F @ np.linalg.inv(M.astype(float))  # superlattice of F Z^2, index P
        th, s = best_theta(N, G)
        # torus lattice is s * F; pieces at s * G k for coset reps of G / F
        cands.append((s, th, M))
    cands.sort(key=lambda t: t[0])
    seeds = []
    seen = []
    for s, th, M in cands:
        if any(abs(s - q) < 1e-9 for q in seen):
            continue
        seen.append(s)
        Mi = np.linalg.inv(M.astype(float))
        # fractional (w.r.t. F) coordinates of the P superlattice points in the cell
        reps = coset_reps_inverse(M)
        U = reps @ Mi.T
        U -= np.floor(U)
        st = State([s * (1 + 1e-14)], U, np.full(P, th))
        seeds.append(("lattice", st))
        if len(seeds) >= top:
            break
    return seeds


def coset_reps_inverse(M):
    """Integer vectors k such that M^{-1} k runs over (M^{-1} Z^2) / Z^2."""
    # M^{-1} k mod 1 for k in reps of Z^2 / M Z^2 gives the superlattice cosets
    return coset_reps(M)


def replicate(fam_from, st, Mint, fam_to):
    """Tile a solution over the index-det(M) sublattice B M of its lattice B.

    The new lattice is B M; for sq/hex targets M must map onto a rotated square
    or hexagonal lattice and the whole configuration is rotated back.
    """
    B = basis_of(fam_from, st.params)
    X = cartesian(fam_from, st)
    reps = coset_reps(Mint)
    Bn = B @ Mint.astype(float)
    Xs = (X[None, :, :] + (reps @ B.T)[:, None, :]).reshape(-1, 2)
    TH = np.tile(st.TH, len(reps))
    psi = math.atan2(Bn[1, 0], Bn[0, 0])
    c, s = math.cos(-psi), math.sin(-psi)
    Rm = np.array([[c, -s], [s, c]])
    Bn = Rm @ Bn
    Xs = Xs @ Rm.T
    TH = TH - psi
    if np.linalg.det(Bn) < 0:
        Bn[:, 1] = -Bn[:, 1]
    if fam_to == "sq":
        L = math.hypot(Bn[0, 0], Bn[1, 0])
        params = np.array([L])
    elif fam_to == "hex":
        L = math.hypot(Bn[0, 0], Bn[1, 0])
        params = np.array([L])
    else:
        params = np.array([Bn[0, 0], Bn[0, 1], Bn[1, 1]])
    ns = from_cartesian(fam_to, params, Xs, TH)
    ns.U -= np.floor(ns.U)
    if fam_to == "free":
        normalise_free(ns)
    return ns


def replication_seeds(fam, P, best_by_P):
    """Same-density seeds from solutions with q | P pieces of the same family."""
    out = []
    for q in sorted(best_by_P):
        if q >= P or P % q:
            continue
        k = P // q
        stq = best_by_P[q]
        Ms = []
        if fam == "sq":
            for a in range(0, k + 1):
                for b in range(0, k + 1):
                    if a * a + b * b == k and a > 0:
                        Ms.append(np.array([[a, -b], [b, a]], dtype=np.int64))
        elif fam == "hex":
            for a in range(0, k + 1):
                for b in range(0, k + 1):
                    if a * a + a * b + b * b == k and a > 0:
                        Ms.append(np.array([[a, -b], [b, a + b]], dtype=np.int64))
        else:
            Ms = hnf_list(k)
        for M in Ms[:6]:
            out.append(("replicate%d" % q, replicate(fam, stq, M, fam)))
    return out


def insertion_seed(geo, st_prev, rng):
    """Add one piece to the P-1 solution at the emptiest sampled point."""
    fam, N, P = geo.family, geo.N, geo.P
    f = math.sqrt(P / (P - 1.0)) * 1.02
    params = st_prev.params * f
    X = cartesian(fam, State(params, st_prev.U, st_prev.TH))
    B = basis_of(fam, params)
    best, bestd = None, -1
    samples = rng.uniform(0, 1, (400, 2))
    for u in samples:
        x = B @ u
        d = X - x
        f_ = np.linalg.solve(B, d.T).T
        f_ -= np.round(f_)
        dd = np.sqrt(((f_ @ B.T) ** 2).sum(1)).min()
        if dd > bestd:
            bestd, best = dd, u
    U = np.vstack([st_prev.U, best])
    TH = np.append(st_prev.TH, rng.uniform(0, 2 * math.pi) if N > 0 else 0.0)
    st = State(params, U, TH)
    st, _ = repair(Geometry(fam, N, P), st, 0.0)
    return st


# ---------------------------------------------------------------------- hopping
def perturb(geo, st, rng):
    fam, N, P = geo.family, geo.N, geo.P
    ns = st.copy()
    kind = rng.integers(0, 4)
    if kind == 0:
        ns = scale_state(geo, ns, 1.0 + rng.uniform(0.02, 0.08))
        ns.U += rng.normal(0, 0.03, ns.U.shape) / math.sqrt(P)
        if N > 0:
            ns.TH += rng.normal(0, 0.08, P)
    elif kind == 1:
        ns = scale_state(geo, ns, 1.08)
        k = max(1, int(rng.integers(1, max(2, P // 3 + 1))))
        idx = rng.choice(P, size=min(k, P), replace=False)
        ns.U[idx] = rng.uniform(0, 1, (len(idx), 2))
        if N > 0:
            ns.TH[idx] = rng.uniform(0, 2 * math.pi, len(idx))
    elif kind == 2 and N > 0:
        ns = scale_state(geo, ns, 1.05)
        i = rng.integers(0, P)
        ns.TH[i] += math.pi / N * rng.choice([-1, 1]) * rng.uniform(0.3, 1.0)
        ns.U += rng.normal(0, 0.01, ns.U.shape)
    else:
        ns = scale_state(geo, ns, 1.04)
        if fam == "free":
            a, b, c = ns.params
            ns.params = np.array([a * math.exp(rng.normal(0, 0.1)), b + rng.normal(0, 0.15) * a, c])
            ns.params[2] = a * c / ns.params[0]
        ns.U += rng.normal(0, 0.05, ns.U.shape) / math.sqrt(P)
        if N > 0:
            ns.TH += rng.normal(0, 0.15, P)
    ns.U -= np.floor(ns.U)
    ns, _ = repair(geo, ns, 0.0)
    return ns


# ---------------------------------------------------------------------- driver
def to_json(geo, st, msep, meta):
    fam = geo.family
    X = cartesian(fam, st)
    B = basis_of(fam, st.params)
    score = score_of(fam, st.params)
    area = abs(np.linalg.det(B))
    return {
        "family": fam,
        "N": geo.N,
        "P": geo.P,
        "score": score,
        "params": [float(v) for v in st.params],
        "basis": [[float(B[0, 0]), float(B[1, 0])], [float(B[0, 1]), float(B[1, 1])]],
        "poses": [[float(X[i, 0]), float(X[i, 1]), float(st.TH[i])] for i in range(geo.P)],
        "frac": [[float(v) for v in st.U[i]] for i in range(geo.P)],
        "units": "working",  # disks of radius 1; build_records.py halves them (polygons: no change)
        "min_sep": msep,
        "density": geo.P * geo.area_piece / area,
        **meta,
    }


def from_json(rec):
    fam = rec["family"]
    U = np.array(rec["frac"])
    TH = np.array([p[2] for p in rec["poses"]])
    return State(rec["params"], U, TH)


# Density upper bounds used ONLY to stop a search early once a packing attains
# them (a packing cannot beat a valid bound). Disks: Thue / L. Fejes Toth,
# pi/sqrt(12). Regular pentagon: Hales and Kusner (2016), (5 - sqrt5)/3.
# Other shapes: the trivial bound 1 (attained only by tilings).
DENSITY_STOP = {0: math.pi / math.sqrt(12.0), 5: (5.0 - math.sqrt(5.0)) / 3.0}


def score_floor(fam, N, P):
    dens = DENSITY_STOP.get(N, 1.0)
    area = P * piece_area(N) / dens
    if fam == "hex":
        return math.sqrt(area / SQ3_2)
    return math.sqrt(area)


def run_counts(N, P, scale=1.0):
    """Deterministic budget: (random starts, basin hops)."""
    return int(round(scale * (6 + P))), int(round(scale * (12 + 5 * P)))


def solve_problem(fam, N, P, seed, best_by_P, extra_seeds=(), log=None, scale=1.0, time_cap=None, seeds_only=False):
    rng = np.random.default_rng([seed, N, P, FAM_ID[fam]])
    geo = Geometry(fam, N, P)
    t0 = time.time()
    n_rand, n_hops = run_counts(N, P, scale)
    if time_cap is None:
        time_cap = 60.0 + 30.0 * P
    deadline = t0 + time_cap
    floor = score_floor(fam, N, P)
    pool = []  # (metric, label, state, msep)
    runs = 0
    stopped = "count"

    def consider(label, st):
        nonlocal runs
        runs += 1
        res = isolated(compress, geo, st)
        if res is None:
            return
        st, ms = res
        if ms < -1e-6:
            st, ms = repair(geo, st, 0.0)
        pool.append((metric_of(fam, st.params), label, st, ms))
        pool.sort(key=lambda t: t[0])
        del pool[8:]

    def at_floor():
        return pool and score_of(fam, pool[0][2].params) <= floor * (1 + 1e-9)

    seeds = []
    seeds += lattice_seeds(geo)
    seeds += replication_seeds(fam, P, best_by_P)
    seeds += list(extra_seeds)
    seeds += double_lattice_seeds(geo, rng)
    if P > 1 and (P - 1) in best_by_P:
        seeds.append(("insert", insertion_seed(geo, best_by_P[P - 1], rng)))
    for label, st in seeds:
        consider(label, st)
    hops = 0
    if seeds_only:
        stopped = "seeds-only"
    elif not at_floor():
        for _ in range(n_rand):
            if time.time() > deadline:
                stopped = "time"
                break
            consider("random", random_state(geo, rng))
            if at_floor():
                stopped = "floor"
                break
        for _ in range(n_hops):
            if stopped != "count":
                break
            if time.time() > deadline:
                stopped = "time"
                break
            base = pool[0] if rng.random() < 0.7 or len(pool) < 2 else pool[int(rng.integers(1, len(pool)))]
            consider("hop:" + base[1].split(":")[-1], perturb(geo, base[2], rng))
            hops += 1
            if at_floor():
                stopped = "floor"
                break
    else:
        stopped = "floor"
    # polish the best few; keep the best of the polished and unpolished states,
    # each first made float-clean (overlap <= 1e-13) by scaling up if needed
    best = None
    for m, label, st, ms in pool[:3]:
        cands = [(st, ms)]
        res = None
        for d0 in (1e-3, 2e-3, 5e-4, 3e-3):
            res = isolated(compress, geo, st.copy(), delta0=d0, delta_min=1e-11, max_iter=600)
            if res is not None:
                break
        if res is not None:
            cands.append(res)
        for cs, cms in cands:
            if cms < -1e-13:
                cs, cms = repair(geo, cs, -1e-13)
            val = metric_of(fam, cs.params)
            if best is None or val < best[0] - 1e-15 * val:
                best = (val, label, cs, cms)
    m, label, st, ms = best
    meta = {
        "label": label,
        "seed": seed,
        "budget": {"random_starts": n_rand, "hops": n_hops, "time_cap_s": time_cap},
        "stopped_by": stopped,
        "elapsed_s": round(time.time() - t0, 2),
        "runs": runs,
        "hops": hops,
        "lp_crashes_isolated": CRASHES[0],
        "method": "torus-slp: lattice/replication/insertion/random seeds, basin hopping, SLP polish",
    }
    out = to_json(geo, st, ms, meta)
    if log:
        log.write(
            "%s N=%d P=%d score=%.10f dens=%.6f msep=%.2e label=%s runs=%d hops=%d stop=%s t=%.1f\n"
            % (fam, N, P, out["score"], out["density"], ms, label, runs, hops, stopped, out["elapsed_s"])
        )
        log.flush()
    return out, st


FAM_ID = {"sq": 1, "hex": 2, "free": 3}


def load_other_family_seeds(dirs, fam, N, P):
    """Seeds from other families' raw results.

    free target: sq/hex solutions are free-lattice packings as they stand.
    sq/hex target: the free solution's fractional coordinates are kept and its
    cell is replaced by the target cell of equal area (an affine deformation);
    the search first rescales until there is no overlap, then compresses.
    """
    extra = []
    for d in dirs:
        for fam2 in ("sq", "hex", "free"):
            if fam2 == fam or (fam != "free" and fam2 != "free"):
                continue
            fn2 = os.path.join(d, "%s_%d_%d.json" % (fam2, N, P))
            if not os.path.exists(fn2):
                continue
            with open(fn2) as f:
                r2 = json.load(f)
            st2 = from_json(r2)
            if fam == "free":
                B2 = basis_of(fam2, st2.params)
                ns = from_cartesian("free", np.array([B2[0, 0], B2[0, 1], B2[1, 1]]), cartesian(fam2, st2), st2.TH)
                normalise_free(ns)
            else:
                area = st2.params[0] * st2.params[2]
                ns = State(params_for_area(fam, area), st2.U.copy(), st2.TH.copy())
                ns, _ = repair(Geometry(fam, N, P), ns, 0.0)
            extra.append(("from-" + fam2, ns))
    return extra


def double_lattice_seeds(geo, rng, count=4):
    """Pieces on a superlattice G of index P/2 at angle th and on G + t at th + pi."""
    fam, N, P = geo.family, geo.N, geo.P
    if fam == "free" or N == 0 or P % 2:
        return []
    F = HEX if fam == "hex" else np.eye(2)
    Ms = super_list(P // 2)
    out = []
    for _ in range(count):
        M = Ms[int(rng.integers(0, len(Ms)))]
        Mi = np.linalg.inv(M.astype(float))
        U1 = coset_reps(M) @ Mi.T
        t = rng.uniform(0, 1, 2) @ Mi.T
        U = np.vstack([U1, U1 + t])
        U -= np.floor(U)
        th = rng.uniform(0, 2 * math.pi)
        TH = np.concatenate([np.full(P // 2, th), np.full(P // 2, th + math.pi)])
        area = P * geo.area_piece / 0.5
        st = State(params_for_area(fam, area), U, TH)
        st, _ = repair(geo, st, 0.0)
        out.append(("double", st))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--family", required=True, choices=["sq", "hex", "free"])
    ap.add_argument("--N", type=int, required=True)
    ap.add_argument("--P", default="1-16")
    ap.add_argument("--scale", type=float, default=1.0, help="multiplies the run counts")
    ap.add_argument("--seed", type=int, default=20261024)
    ap.add_argument("--attempt", type=int, default=0, help="added to the seed after a crash")
    ap.add_argument("--out", required=True, help="directory for raw result JSON")
    ap.add_argument("--skip-existing", action="store_true")
    ap.add_argument("--seeds-only", action="store_true", help="structured seeds + polish only (no random starts, no hops)")
    ap.add_argument("--from", dest="from_dirs", action="append", default=[], help="raw dirs with sq/hex results (free seeds)")
    args = ap.parse_args()
    lo, hi = (int(v) for v in args.P.split("-")) if "-" in args.P else (int(args.P), int(args.P))
    os.makedirs(args.out, exist_ok=True)
    log = open(os.path.join(args.out, "log_%s_%d.txt" % (args.family, args.N)), "a")
    best_by_P = {}
    for q in range(1, hi + 1):
        fn = os.path.join(args.out, "%s_%d_%d.json" % (args.family, args.N, q))
        if os.path.exists(fn):
            with open(fn) as f:
                best_by_P[q] = from_json(json.load(f))
    seed = args.seed + 1000 * args.attempt
    for P in range(lo, hi + 1):
        fn = os.path.join(args.out, "%s_%d_%d.json" % (args.family, args.N, P))
        if args.skip_existing and os.path.exists(fn):
            continue
        extra = load_other_family_seeds(args.from_dirs, args.family, args.N, P)
        CRASHES[0] = 0
        out, st = solve_problem(args.family, args.N, P, seed, best_by_P, extra, log, scale=args.scale, seeds_only=args.seeds_only)
        prev = None
        if os.path.exists(fn):
            with open(fn) as f:
                prev = json.load(f)
        if prev is None or out["score"] < prev["score"] - 1e-12:
            with open(fn + ".tmp", "w") as f:
                json.dump(out, f, indent=1)
            os.replace(fn + ".tmp", fn)
            best_by_P[P] = st
        else:
            best_by_P[P] = from_json(prev)


if __name__ == "__main__":
    main()
