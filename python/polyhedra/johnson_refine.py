#!/usr/bin/env python3
"""Offline: refine the numerical solution of J<j> to many digits and save the coordinates (johnson_ident.refine).
usage: JOHNSON_WORK=dir python3 johnson_refine.py J digits"""
import sys as _sys
_sys.set_int_max_str_digits(0)
import json, os, sys, time
import numpy as np
import mpmath as mp
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import johnson_ident as I, johnson_search as S
W = os.environ.get('JOHNSON_WORK', '.')
j, dps = int(sys.argv[1]), int(sys.argv[2])
sols = json.load(open(os.path.join(W, f'search_J{j}.json')))
X = np.array(sols[0]['X']); gens = S.GROUPS[S.SOLID_GROUP[j]]; V = len(X)
d = np.linalg.norm(X[:, None] - X[None], axis=2)
edges = [(a, b, mp.mpf(1)) for a in range(V) for b in range(a + 1, V) if abs(d[a, b] - 1) < 1e-6]
# regular faces: every chord of a face polygon is fixed too (unit edges alone leave non-triangular faces flexible)
from scipy.spatial import ConvexHull
h = ConvexHull(X); groups = []
for simp, eq in zip(h.simplices, h.equations):
    for g in groups:
        if np.allclose(g[0], eq, atol=1e-6): g[1].update(simp.tolist()); break
    else: groups.append([eq, set(simp.tolist())])
for eq, vs in groups:
    vs = sorted(vs); m = len(vs)
    if m < 4: continue
    cen = X[vs].mean(axis=0); nrm = eq[:3]
    u = X[vs[0]] - cen; u = u - nrm * (u @ nrm); u /= np.linalg.norm(u); w = np.cross(nrm, u)
    cyc = sorted(vs, key=lambda i: np.arctan2((X[i] - cen) @ w, (X[i] - cen) @ u))
    mp.mp.dps = dps
    for i in range(m):
        for k in range(2, m // 2 + 1):
            a, b = cyc[i], cyc[(i + k) % m]
            if k == m - k and i >= m // 2: continue
            edges.append((min(a, b), max(a, b), mp.sin(k * mp.pi / m) / mp.sin(mp.pi / m)))
t = time.time()
x = I.refine(X, gens, edges, dps)
mp.mp.dps = dps
json.dump([mp.nstr(v, dps - 5) for v in x], open(os.path.join(W, f'refined_J{j}.json'), 'w'))
print('refined J', j, 'in', round(time.time() - t), 's', flush=True)
