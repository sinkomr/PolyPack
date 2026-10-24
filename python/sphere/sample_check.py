"""Independent sanity check of stored records by point sampling (numpy; not part of the proof).

Usage: python3 python/sphere/sample_check.py data/sphere/records.json sphere/3/12,sphere/3/22

For each listed record, 4,000 random points per piece (convex combinations of its vertices,
normalised) are tested against the inward edge half-spaces of every other piece, using only the
stored quaternions and radius. Expected: 0 points inside another piece at score_cert, and some
at score_float (1 - 1e-4), which shows the check is sensitive.
"""
import json, sys, math
import numpy as np
rec_file, ids = sys.argv[1], sys.argv[2].split(",")
d = json.load(open(rec_file))
by = {r["id"]: r for r in d["records"]}
rng = np.random.default_rng(0)
def qmat(q):
    w, x, y, z = q; n = w*w+x*x+y*y+z*z
    return np.array([[w*w+x*x-y*y-z*z, 2*(x*y-w*z), 2*(x*z+w*y)], [2*(x*y+w*z), w*w-x*x+y*y-z*z, 2*(y*z-w*x)], [2*(x*z-w*y), 2*(y*z+w*x), w*w-x*x-y*y+z*z]]) / n
for i in ids:
    r = by[i]; N, P = r["N"], r["P"]
    for label, rho in (("float*(1-1e-4)", r["score_float"] * (1 - 1e-4)), ("cert", r["score_cert"])):
        a = 1 / rho
        R = math.asin(math.sin(a / 2) / math.sin(math.pi / N))
        k = np.arange(N); ph = math.pi / 2 + 2 * math.pi * k / N
        V = np.stack([math.sin(R) * np.cos(ph), math.sin(R) * np.sin(ph), np.full(N, math.cos(R))], 1)
        Ms = [qmat(p["q"]) for p in r["config"]["pieces"]]
        X = [V @ M.T for M in Ms]
        # inward edge normals from the vertices (centre on the positive side)
        E = []
        for x, M in zip(X, Ms):
            c = M[:, 2]
            n = np.cross(x, np.roll(x, -1, axis=0))
            n *= np.sign(n @ c)[:, None]
            E.append(n / np.linalg.norm(n, axis=1, keepdims=True))
        bad = 0; tot = 0
        for p in range(P):
            # random points in piece p: random convex combinations of the vertices, normalised
            w = rng.dirichlet(np.ones(N), size=4000) ** 2
            w /= w.sum(1, keepdims=True)
            pts = w @ X[p]; pts /= np.linalg.norm(pts, axis=1, keepdims=True)
            # include points very close to the vertices and edge midpoints
            for q in range(P):
                if q == p: continue
                inside = (pts @ E[q].T > 1e-12).all(axis=1)
                bad += int(inside.sum())
            tot += len(pts)
        print(i, label, "points of one piece strictly inside another:", bad, "of", tot)
