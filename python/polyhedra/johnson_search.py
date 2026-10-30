"""Offline search for the elementary Johnson solids J84-J92: unit-edge vertex sets with a given point group,
by random-start least squares on symmetry orbits.
usage: JOHNSON_WORK=dir python3 johnson_search.py J tries [maxaxis seed [hull [shard/of]]]   (writes search_J<J>.json) Floating point only proposes; johnson.py proves everything exactly."""
import itertools, os, sys, time, json
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial import ConvexHull
sys.path.insert(0, '.')
from johnson_table import JOHNSON


USE_HULL = False
SHARD = None


def gen_group(gens):
    G = [np.eye(3)]
    changed = True
    while changed:
        changed = False
        for a in list(G):
            for g in gens:
                m = g @ a
                if not any(np.allclose(m, h, atol=1e-9) for h in G):
                    G.append(m); changed = True
    return G


def rotz(t): return np.array([[np.cos(t), -np.sin(t), 0], [np.sin(t), np.cos(t), 0], [0, 0, 1.0]])
D = np.diag
GROUPS = {
    'D2d': [D([-1, -1, 1.]), D([1, -1, -1.]), np.array([[0, 1, 0], [1, 0, 0], [0, 0, 1.0]])],
    'D4d': [rotz(np.pi / 4) @ D([1, 1, -1.]), D([1, -1, -1.])],
    'C2v': [D([-1, -1, 1.]), D([1, -1, 1.])],
    'Cs': [D([-1, 1, 1.])],
    'D2h': [D([-1, 1, 1.]), D([1, -1, 1.]), D([1, 1, -1.])],
    'C3v': [rotz(2 * np.pi / 3), D([1, -1, 1.])],
}
SOLID_GROUP = {84: 'D2d', 85: 'D4d', 86: 'C2v', 88: 'C2v', 89: 'C2v', 90: 'D2d', 91: 'D2h', 92: 'C3v'}


def fixed_spaces(G):
    spaces = [np.eye(3)]
    for g in G:
        if np.allclose(g, np.eye(3)): continue
        u, s, vt = np.linalg.svd(g - np.eye(3))
        null = vt[np.sum(s > 1e-9):]
        if len(null) == 0: continue
        if not any(len(n) == len(null) and np.allclose(null @ n.T @ n, null, atol=1e-9) for n in spaces[1:]):
            spaces.append(null)
    # also the origin-type spaces are excluded (the origin would be a vertex)
    return spaces


def orbit(G, p):
    pts = []
    for g in G:
        q = g @ p
        if not any(np.linalg.norm(q - r) < 1e-6 for r in pts): pts.append(q)
    return pts


def structure(G, spaces, combo, rng):
    """Matrix A (3V x n): vertex coordinates = A @ parameters, for the orbits of the given space types."""
    dims = [len(spaces[t]) for t in combo]
    n = sum(dims)
    rows = []
    k = 0
    for t, d in zip(combo, dims):
        Bt = spaces[t].T if d < 3 else np.eye(3)
        p = Bt @ rng.normal(size=d)
        seen = []
        for g in G:
            q = g @ p
            if not any(np.linalg.norm(q - r) < 1e-6 for r in seen):
                seen.append(q)
                M = np.zeros((3, n)); M[:, k:k + d] = g @ Bt
                rows.append(M)
        k += d
    return np.vstack(rows), n


def lm(A, n, V, x, window, iters=60):
    """Gauss-Newton / Levenberg-Marquardt on the unit-distance equations of the pairs closer than window."""
    lam = 1e-3
    iu = np.triu_indices(V, 1)
    for it in range(iters):
        X = (A @ x).reshape(V, 3)
        d = np.linalg.norm(X[:, None] - X[None], axis=2)
        sel = d[iu] < window
        a, b = iu[0][sel], iu[1][sel]
        if len(a) == 0: return None
        diff = X[a] - X[b]
        dist = np.linalg.norm(diff, axis=1)
        r = dist - 1
        Aa = A.reshape(V, 3, n)
        J = np.einsum('ek,ekn->en', diff / dist[:, None], Aa[a] - Aa[b])
        cost = r @ r
        for _ in range(8):
            H = J.T @ J + lam * np.eye(n)
            step = np.linalg.solve(H, -J.T @ r)
            xn = x + step
            Xn = (A @ xn).reshape(V, 3)
            rn = np.linalg.norm(Xn[a] - Xn[b], axis=1) - 1
            if rn @ rn < cost: x = xn; lam = max(lam / 5, 1e-12); break
            lam *= 5
        else:
            return x, cost
        if cost < 1e-26: break
    return x, cost


def lm_hull(A, n, V, x, reach=1.3, iters=80):
    """Like lm, but the equations are the edges of the convex hull of the current points shorter than reach (plus a
    repulsion of every pair closer than 1), which does not mistake a close non-edge pair for an edge."""
    lam = 1e-3
    iu = np.triu_indices(V, 1)
    Aa = A.reshape(V, 3, n)
    for it in range(iters):
        X = (A @ x).reshape(V, 3)
        try: h = ConvexHull(X)
        except Exception: return None
        es = set()
        for simp in h.simplices:
            for u, v in ((0, 1), (1, 2), (0, 2)):
                a, b = sorted((simp[u], simp[v])); es.add((a, b))
        d = np.linalg.norm(X[:, None] - X[None], axis=2)
        for a, b in zip(*iu):
            if d[a, b] < 1.0: es.add((a, b))
        es = [(a, b) for a, b in es if d[a, b] < reach]
        if not es: return None
        a = np.array([e[0] for e in es]); b = np.array([e[1] for e in es])
        diff = X[a] - X[b]; dist = np.linalg.norm(diff, axis=1); r = dist - 1
        J = np.einsum('ek,ekn->en', diff / np.maximum(dist, 1e-9)[:, None], Aa[a] - Aa[b])
        cost = r @ r
        for _ in range(8):
            step = np.linalg.solve(J.T @ J + lam * np.eye(n), -J.T @ r)
            xn = x + step
            Xn = (A @ xn).reshape(V, 3)
            rn = np.linalg.norm(Xn[a] - Xn[b], axis=1) - 1
            if rn @ rn < cost: x = xn; lam = max(lam / 5, 1e-12); break
            lam *= 5
        else:
            return x, cost
        if cost < 1e-26: break
    return x, cost


def search(j, tries=400, window=1.12, seed=0, maxaxis=2, verbose=True, combos_only=None):
    name, V, E, F = JOHNSON[j]
    G = gen_group(GROUPS[SOLID_GROUP[j]])
    spaces = fixed_spaces(G)
    rng = np.random.default_rng(seed)
    sizes = []
    for B in spaces:
        p = B.T @ rng.normal(size=len(B)) if len(B) < 3 else rng.normal(size=3)
        sizes.append(len(orbit(G, p)))
    found = {}
    combos = []
    def rec(rem, start, cur):
        if rem == 0: combos.append(list(cur)); return
        for t in range(start, len(spaces)):
            if sizes[t] <= rem:
                cur.append(t); rec(rem - sizes[t], t, cur); cur.pop()
    rec(V, 0, [])
    combos = [c for c in combos if sum(1 for t in c if len(spaces[t]) == 1) <= maxaxis]
    if verbose: print(f'J{j} {name}: group order {len(G)}, orbit sizes {sizes}, {len(combos)} orbit combos', flush=True)
    for ci, combo in enumerate(combos):
        if SHARD and ci % SHARD[1] != SHARD[0]: continue
        A, n = structure(G, spaces, combo, rng)
        t0 = time.time(); nfound = 0
        for it in range(tries):
            x = rng.uniform(-1.0, 1.0, n) * (0.8 + 1.4 * rng.random())
            res = lm_hull(A, n, V, x) if USE_HULL else lm(A, n, V, x, window * (1 + 0.15 * (it % 4) - 0.1))
            if res is None or res[1] > 1e-22: continue
            x = res[0]
            X = (A @ x).reshape(V, 3)
            dn = np.linalg.norm(X[:, None] - X[None], axis=2)
            iu = np.triu_indices(V, 1)
            if dn[iu].min() < 1 - 1e-7: continue
            if int(np.sum(np.abs(dn[iu] - 1) < 1e-7)) != E: continue
            try: h = ConvexHull(X)
            except Exception: continue
            if len(h.vertices) != V: continue
            groups = []
            for simp, eq in zip(h.simplices, h.equations):
                for gg in groups:
                    if np.allclose(gg[0], eq, atol=1e-6): gg[1].update(simp.tolist()); break
                else: groups.append([eq, set(simp.tolist())])
            counts = {}
            for _, vs in groups: counts[len(vs)] = counts.get(len(vs), 0) + 1
            if counts != F: continue
            bad = False
            for eq, vs in groups:
                vs = sorted(vs); cen = X[vs].mean(axis=0)
                nrm = eq[:3]
                u = X[vs[0]] - cen; u = u - nrm * (u @ nrm); u /= np.linalg.norm(u); v = np.cross(nrm, u)
                ang = sorted(vs, key=lambda i: np.arctan2((X[i] - cen) @ v, (X[i] - cen) @ u))
                for a_, b_ in zip(ang, ang[1:] + ang[:1]):
                    if abs(np.linalg.norm(X[a_] - X[b_]) - 1) > 1e-6: bad = True
            if bad: continue
            key = tuple(np.round(np.sort(dn.ravel()), 4))
            if key not in found:
                found[key] = (combo, x.copy(), X.copy())
                nfound += 1
                if verbose: print(f'  found: combo {combo} after {it} tries ({time.time()-t0:.1f}s)', flush=True)
        if verbose and ci % 10 == 0: print(f'  combo {ci}/{len(combos)} done', flush=True)
    return found, G, spaces


if __name__ == '__main__':
    j = int(sys.argv[1])
    USE_HULL = len(sys.argv) > 5 and sys.argv[5] == 'hull'
    if len(sys.argv) > 6: SHARD = tuple(int(x) for x in sys.argv[6].split('/'))
    found, G, spaces = search(j, tries=int(sys.argv[2]) if len(sys.argv) > 2 else 300, maxaxis=int(sys.argv[3]) if len(sys.argv) > 3 else 2, seed=int(sys.argv[4]) if len(sys.argv) > 4 else 0)
    out = [{'combo': c, 'x': x.tolist(), 'X': X.tolist()} for c, x, X in found.values()]
    json.dump(out, open(os.path.join(os.environ.get('JOHNSON_WORK', '.'), f'search_J{j}' + (f'_{SHARD[0]}' if SHARD else '') + '.json'), 'w'))
    print('distinct solutions', len(out))
