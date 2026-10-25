"""Final polish of raw search results (deterministic; writes only improvements).

  python3 python/torus/polish_raw.py --raw data/torus/raw [--part 0 --parts 2]

Some searches stop with a gap of ~1e-9 (the trust box reached its floor while a contact was
still opening). This reruns the SLP from each stored result with a small starting box down to
1e-12, keeps the result only if the score drops and the float overlap stays <= 1e-13.
"""

import argparse
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from torus_np import HEX, Geometry, State, basis_of, metric_of  # noqa: E402
from torus_search import compress, from_json, isolated, repair, to_json  # noqa: E402


# ---------------------------------------------------------------------------- SLSQP polish
# The SLP polish converges linearly and creeps (about 1e-8 per round) where the optimum
# slides along curved contacts. Here the contact set (pair, lattice vector, SAT axis owner,
# edge, vertex) is frozen, the exact nonlinear constraints g >= 0 are solved with scipy's
# SLSQP (quasi-Newton, superlinear), the set is re-selected and the step repeated.

def contact_set(geo, st, gap_tol, vwin):
    fam, N, R = geo.family, geo.N, geo.R
    B = basis_of(fam, st.params)
    pi_, W, D = geo.images(B, st.U, 2 * R + gap_tol)
    if len(pi_) == 0:
        return None
    sep, ax = geo.separations(st.TH, pi_, D)
    Ii, Jj = geo.I[pi_], geo.J[pi_]
    lam = np.round(W - (st.U[Jj] - st.U[Ii])).astype(float)
    if N == 0:
        sel = np.nonzero(sep < gap_tol)[0]
        return {"I": Ii[sel], "J": Jj[sel], "lam": lam[sel]}
    projA, projB, kA, kB, sideB, _ = ax
    sel = np.nonzero(sep < gap_tol)[0]
    sB = sideB[sel]
    prow = np.where(sB[:, None], projB[sel, kB[sel], :], projA[sel, kA[sel], :])
    vm = prow <= prow.min(1)[:, None] + vwin
    rr, vv = np.nonzero(vm)
    p = sel[rr]
    side = sideB[p]
    return {"I": Ii[p], "J": Jj[p], "lam": lam[p], "side": side, "k": np.where(side, kB[p], kA[p]), "v": vv}


def rows_fixed(geo, st, cs):
    """Constraint values and Jacobian [du (2P), dtheta (P), dparams] for a frozen contact set."""
    fam, N, P, R, r = geo.family, geo.N, geo.P, geo.R, geo.r
    B = basis_of(fam, st.params)
    Ii, Jj = cs["I"], cs["J"]
    W = st.U[Jj] + cs["lam"] - st.U[Ii]
    D = W @ B.T
    if N == 0:
        dist = np.sqrt((D * D).sum(-1))
        g = dist - 2.0
        gd = D / dist[:, None]
    else:
        side = cs["side"]
        ow = np.where(side, Jj, Ii)
        ot = np.where(side, Ii, Jj)
        sgn = np.where(side, -1.0, 1.0)
        al = st.TH[ow] + geo.base_e[cs["k"]]
        ph = st.TH[ot] + geo.base_v[cs["v"]]
        nx, ny = np.cos(al), np.sin(al)
        ex, ey = np.cos(ph), np.sin(ph)
        dx, dy = sgn * D[:, 0], sgn * D[:, 1]
        g = dx * nx + dy * ny + R * (ex * nx + ey * ny) - r
        gd = np.stack([sgn * nx, sgn * ny], -1)
        gto = (dx + R * ex) * (-ny) + (dy + R * ey) * nx
        gtt = R * (-ey * nx + ex * ny)
    nv = geo.nvar_pose + geo.npar
    nr = len(g)
    Jm = np.zeros((nr, nv))
    gu = gd @ B
    ar = np.arange(nr)
    np.add.at(Jm, (ar, 2 * Jj), gu[:, 0])
    np.add.at(Jm, (ar, 2 * Jj + 1), gu[:, 1])
    np.add.at(Jm, (ar, 2 * Ii), -gu[:, 0])
    np.add.at(Jm, (ar, 2 * Ii + 1), -gu[:, 1])
    if N > 0:
        np.add.at(Jm, (ar, 2 * P + ow), gto)
        np.add.at(Jm, (ar, 2 * P + ot), gtt)
    o = geo.nvar_pose
    if fam == "sq":
        Jm[:, o] = (gd * W).sum(-1)
    elif fam == "hex":
        Jm[:, o] = (gd * (W @ HEX.T)).sum(-1)
    else:
        Jm[:, o] = gd[:, 0] * W[:, 0]
        Jm[:, o + 1] = gd[:, 0] * W[:, 1]
        Jm[:, o + 2] = gd[:, 1] * W[:, 1]
    return g, Jm


def slsqp_polish(geo, st, rounds=40, box=0.02, gap_tol=0.05, vwin=0.05):
    from scipy.optimize import minimize

    fam, N, P = geo.family, geo.N, geo.P
    nv = geo.nvar_pose + geo.npar
    free_idx = np.arange(2, nv)  # u_0 fixed (translation gauge)

    def pack(s):
        z = np.concatenate([s.U.reshape(-1), s.TH if N > 0 else np.zeros(0), s.params])
        return z

    def unpack(z):
        U = z[: 2 * P].reshape(P, 2).copy()
        o = 2 * P
        TH = z[o : o + P].copy() if N > 0 else np.zeros(P)
        o += P if N > 0 else 0
        return State(z[o:].copy(), U, TH)

    def metric_grad(z):
        gvec = np.zeros(nv)
        par = z[geo.nvar_pose :]
        if fam == "free":
            gvec[geo.nvar_pose] = par[2]
            gvec[geo.nvar_pose + 2] = par[0]
            return par[0] * par[2], gvec
        gvec[geo.nvar_pose] = 1.0
        return par[0], gvec

    cur = st.copy()
    cur_m = metric_of(fam, cur.params)
    for _ in range(rounds):
        cs = contact_set(geo, cur, gap_tol, vwin)
        if cs is None:
            break
        z0 = pack(cur)
        Bc = basis_of(fam, cur.params)
        S = max(np.hypot(*Bc[:, 0]), np.hypot(*Bc[:, 1]))
        scale = np.ones(nv)
        scale[: 2 * P] = box / S
        if N > 0:
            scale[2 * P : 3 * P] = box / geo.R
        scale[geo.nvar_pose :] = box
        zf0 = z0[free_idx]

        def full(y):
            z = z0.copy()
            z[free_idx] = zf0 + y * scale[free_idx]
            return z

        def f(y):
            m, _ = metric_grad(full(y))
            return m

        def fj(y):
            _, gvec = metric_grad(full(y))
            return gvec[free_idx] * scale[free_idx]

        def c(y):
            return rows_fixed(geo, unpack(full(y)), cs)[0]

        def cj(y):
            return rows_fixed(geo, unpack(full(y)), cs)[1][:, free_idx] * scale[free_idx]

        y0 = np.zeros(len(free_idx))
        try:
            res = minimize(f, y0, jac=fj, method="SLSQP", bounds=[(-1, 1)] * len(y0),
                           constraints=[{"type": "ineq", "fun": c, "jac": cj}],
                           options={"ftol": 1e-16, "maxiter": 300})
        except Exception:
            break
        cand = unpack(full(res.x))
        cand.U -= np.floor(cand.U)
        ms = geo.min_sep(cand)
        if ms < -1e-13:
            cand, ms = repair(geo, cand, -1e-13)
        m = metric_of(fam, cand.params)
        if m < cur_m * (1 - 1e-15):
            cur, cur_m = cand, m
        else:
            break
    return cur, geo.min_sep(cur)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--part", type=int, default=0)
    ap.add_argument("--parts", type=int, default=1)
    ap.add_argument("--pattern", default="*_*_*.json", help="file glob inside --raw")
    ap.add_argument("--deep", type=int, default=0, help="extra restart rounds with larger boxes (3e-2 ... 1e-3)")
    ap.add_argument("--slsqp", type=int, default=0, help="rounds of SLSQP with a frozen contact set (0: off)")
    args = ap.parse_args()
    files = sorted(glob.glob(os.path.join(args.raw, args.pattern)))
    files = [f for i, f in enumerate(files) if i % args.parts == args.part]
    for fn in files:
        with open(fn) as f:
            rec = json.load(f)
        fam, N, P = rec["family"], rec["N"], rec["P"]
        geo = Geometry(fam, N, P)
        st = from_json(rec)
        m0 = metric_of(fam, st.params)
        best = None
        for d0 in (1e-4, 1e-6, 1e-3):
            res = isolated(compress, geo, st.copy(), delta0=d0, delta_min=1e-12, max_iter=800)
            if res is None:
                continue
            ps, ms = res
            if ms < -1e-13:
                ps, ms = repair(geo, ps, -1e-13)
            m = metric_of(fam, ps.params)
            if best is None or m < best[0]:
                best = (m, ps, ms)
        # optional deeper restarts for slowly converging cases (a sliding valley)
        for _ in range(args.deep):
            if best is None:
                break
            improved = False
            for d0 in (3e-2, 1e-2, 3e-3, 1e-3):
                res = isolated(compress, geo, best[1].copy(), delta0=d0, delta_min=1e-12, max_iter=1500)
                if res is None:
                    continue
                ps, ms = res
                if ms < -1e-13:
                    ps, ms = repair(geo, ps, -1e-13)
                m = metric_of(fam, ps.params)
                if m < best[0] * (1 - 1e-12):
                    best = (m, ps, ms)
                    improved = True
            if not improved:
                break
        if args.slsqp and best is not None:
            res = isolated(slsqp_polish, geo, best[1].copy(), args.slsqp)
            if res is not None:
                ps, ms = res
                if ms < -1e-13:
                    ps, ms = repair(geo, ps, -1e-13)
                m = metric_of(fam, ps.params)
                if m < best[0]:
                    best = (m, ps, ms)
        if best is not None and best[0] < m0 * (1 - 1e-15):
            meta = {k: v for k, v in rec.items() if k not in ("family", "N", "P", "score", "params", "basis", "poses", "frac", "min_sep", "density")}
            meta["polished"] = "polish_raw.py"
            out = to_json(geo, best[1], best[2], meta)
            with open(fn + ".tmp", "w") as f:
                json.dump(out, f, indent=1)
            os.replace(fn + ".tmp", fn)
            print("%s: %.12f -> %.12f (rel %.2e)" % (os.path.basename(fn), rec["score"], out["score"], (rec["score"] - out["score"]) / rec["score"]), flush=True)


if __name__ == "__main__":
    main()
