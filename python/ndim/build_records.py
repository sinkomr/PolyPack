#!/usr/bin/env python3
"""Builds data/ndim/records.json and data/ndim/configs/*.jsonl from the wiki's records of the regular polytopes in 4D to 6D
(offline tool; numpy for the frame change, the exact certifier python/ndim/certify.py for every record).

usage: python3 python/ndim/build_records.py --upstream DIR [--out data/ndim] [--jobs 8] [--only c8inc8 ...] [--fail-log FILE]

  --upstream  a checkout of github.com/alejandrozu/platonic-packing (records/<p>/<p>_nNN.json, src/polytopes_nd.json)

Upstream (MIT) stores a packing of n regular polytopes of the same dimension as the container edge over the piece edge s_full
(mu = piece edge / container edge) and, per piece, [c_1..c_d, S_12, S_13, .., S_(d-1)d, D_1..D_d]: the piece's polytope of
src/polytopes_nd.json (exact vertices V, edge E) placed as c + R V, R = diag(D) (I - S)^-1 (I + S), inside the container
s_full mu times its polytope. PolyPack's pose has the same rotation form but unit edges and its own catalogue frame
(python/ndim/catalogue.py), so each record is converted:

    t' = Q_C c / E_P,    R' = Q_C R Q_P^T,    s = s_full

where Q_P and Q_C are the orthogonal maps taking upstream's polytopes at unit edge (V / E) onto the catalogue's, found by
matching vertex sets (the choice with det Q_P = det Q_C so that R' is a rotation). R' is converted to a pose with
floatgeom.pose_of_matrix, and the converted configuration must pass certify.certify_config (exact, strict separation and
containment) or the record is dropped and logged. Upstream's clearance of 1e-7 between pieces and to the walls is kept: the
certifier's smallest proved gaps are stored with the record.
"""
import argparse
import glob
import json
import math
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from decimal import ROUND_HALF_EVEN, Decimal

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue as CAT  # noqa: E402
import certify  # noqa: E402
import floatgeom as G  # noqa: E402

UPSTREAM = 'https://github.com/alejandrozu/platonic-packing'
UPSTREAM_COMMIT = '8ce7b48831804b287fd98ade4ef35f5a6d6ca188'
GENERATED = '2026-11-01'

# upstream id -> (dimension, PolyPack catalogue name)
MAP = {'c5': (4, 'simplex'), 'c8': (4, 'cube'), 'c16': (4, 'ortho'), 'c24': (4, '24cell'), 'c120': (4, '120cell'),
       'c600': (4, '600cell'), 'sx5': (5, 'simplex'), 'hc5': (5, 'cube'), 'op5': (5, 'ortho'),
       'sx6': (6, 'simplex'), 'hc6': (6, 'cube'), 'op6': (6, 'ortho')}
P_MAX = {4: 40, 5: 32, 6: 24}
MAX_CAYLEY = 32.0  # the server's bound on a Cayley parameter (packages/ndim MAX_CAYLEY)
FILE = re.compile(r'^(?P<a>[a-z0-9]+?)in(?P<b>(?:c|sx|hc|op)[0-9]+)_n(?P<n>\d\d)\.json$')

CREDIT = ('soft-to-rigid method by Yohei Nakajima (2026); generalization to regular polytopes of dimensions 4-6, '
          'basin-hopping search and exact certification developed with Claude (Anthropic) under Alejandro Zarzuelo\'s direction')
METHOD = ('d-dimensional soft-to-rigid homotopy (inscribed balls hardened into the polytope under inward pressure), basin '
          'hopping, sequential-LP tightening with per-pair separating hyperplanes (alejandrozu/platonic-packing, '
          'src/ndsim.py, src/ndslp.py)')
SOURCES = {
    'wiki': {
        'title': 'polyhedrainpolyhedra.wiki, higher polytopes (records of alejandrozu/platonic-packing)',
        'authors': 'Alejandro Zarzuelo; soft-to-rigid method by Yohei Nakajima',
        'url': f'{UPSTREAM}/tree/{UPSTREAM_COMMIT}/records',
        'commit': UPSTREAM_COMMIT,
        'licence': 'MIT (THIRD_PARTY_NOTICES.md)',
        'credit': CREDIT,
        'method': METHOD,
        'docs': f'{UPSTREAM}/blob/{UPSTREAM_COMMIT}/docs/HIGHER_DIM.md',
        'files': f'{UPSTREAM}/blob/{UPSTREAM_COMMIT}/records/<origin.file>',
    }
}


# ------------------------------------------------------------------ the frame change
def unit_vertices_upstream(poly):
    return np.array(poly['Vf'], dtype=float) / poly['edge']


def match_isometries(W, V, want_det=None, limit=1):
    """Orthogonal Q (d x d) with Q w in V for every row w of W and every row of V reached; the first `limit` found with the
    wanted determinant sign (None: any). W and V are (n x d) and have the same Gram structure."""
    n, d = W.shape
    if V.shape != W.shape:
        raise ValueError('different vertex counts')
    # d linearly independent vertex vectors: vertex 0 and its nearest neighbours (a tight basis keeps the matching search small)
    order = sorted(range(1, n), key=lambda i: (round(float(np.linalg.norm(W[i] - W[0])), 9), i))
    idx = [0]
    for i in order:
        if len(idx) == d:
            break
        if np.linalg.matrix_rank(W[idx + [i]], tol=1e-7) == len(idx) + 1:
            idx.append(i)
    B = W[idx[:d]]
    G0 = B @ B.T
    found = []
    tol = 1e-8

    def rec(chosen):
        if len(found) >= limit:
            return
        k = len(chosen)
        if k == d:
            C = V[chosen]
            Q = np.linalg.solve(B, C).T  # rows b_i map to rows c_i: Q b_i = c_i
            if not np.allclose(Q @ Q.T, np.eye(d), atol=1e-7):
                return
            # every vertex of W lands on a vertex of V, all distinct
            img = W @ Q.T
            D = np.linalg.norm(img[:, None, :] - V[None, :, :], axis=2)
            if D.min(axis=1).max() > 1e-7 or len(set(D.argmin(axis=1))) != n:
                return
            if want_det is None or np.sign(np.linalg.det(Q)) == want_det:
                found.append(Q)
            return
        for c in range(n):
            if c in chosen:
                continue
            if abs(V[c] @ V[c] - B[k] @ B[k]) > tol:
                continue
            if all(abs(V[c] @ V[chosen[j]] - G0[k, j]) <= tol for j in range(k)):
                rec(chosen + [c])
                if len(found) >= limit:
                    return

    rec([])
    return found


_frames = {}


def frames(up, key):
    """(E, Q) for an upstream polytope: its edge and the orthogonal map onto the catalogue's polytope at unit edge,
    for both determinant signs (None when a sign has no map)."""
    if key in _frames:
        return _frames[key]
    d, name = MAP[key]
    ours = np.array(CAT.get(f'{d}:{name}').vertices_float(), dtype=float)
    W = unit_vertices_upstream(up[key])
    out = {}
    for sgn in (1, -1):
        qs = match_isometries(W, ours, want_det=sgn, limit=1)
        out[sgn] = qs[0] if qs else None
    _frames[key] = (up[key]['edge'], out)
    return _frames[key]


def cayley_upstream(S_upper, D, d):
    S = np.zeros((d, d))
    k = 0
    for i in range(d):
        for j in range(i + 1, d):
            S[i, j] = S_upper[k]
            S[j, i] = -S_upper[k]
            k += 1
    I = np.eye(d)
    return np.diag(D) @ np.linalg.solve(I - S, I + S)


def robust_pose(t, R, d):
    """The pose [t, k, flip] of a rotation matrix: the flip and Cayley parameters of smallest size whose matrix reproduces R
    to 1e-12 (floatgeom.pose_of_matrix does not check this: for a matrix with an eigenvalue -1 under some flips the solve is
    numerically singular and can return parameters of another rotation)."""
    R = np.array(R, dtype=float)
    best = None
    for mask in range(1 << d):
        if bin(mask).count('1') % 2:
            continue
        D = np.array([-1.0 if mask >> i & 1 else 1.0 for i in range(d)])
        C = D[:, None] * R
        I = np.eye(d)
        try:
            S = (C - I) @ np.linalg.inv(C + I)
        except np.linalg.LinAlgError:
            continue
        params = [0.5 * (S[i, j] - S[j, i]) for i in range(d) for j in range(i + 1, d)]
        size = max(abs(x) for x in params)
        if not size <= MAX_CAYLEY or (best is not None and size >= best[0]):
            continue
        back = np.array(G.cayley_matrix(params, d, mask))
        if np.abs(back - R).max() < 1e-12:
            best = (size, params, mask)
    if best is None:
        raise ValueError('no Cayley form within the bound')
    return [float(x) for x in t] + [float(x) for x in best[1]] + [best[2]]


def convert(rec, up):
    """The PolyPack configuration {s, pieces} of an upstream record, or raises."""
    d = rec['dim']
    pk, ck = rec['piece'], rec['container']
    EP, QP = frames(up, pk)
    EC, QC = frames(up, ck)
    # R' = Q_C R Q_P^T needs det Q_C = det Q_P
    sgn = 1 if QP[1] is not None and QC[1] is not None else -1
    if QP[sgn] is None or QC[sgn] is None:
        raise ValueError('no frame change of matching determinant')
    qp, qc = QP[sgn], QC[sgn]
    m = d * (d - 1) // 2
    pieces = []
    for row in rec['pieces']:
        c = np.array(row[:d], dtype=float)
        R = cayley_upstream(row[d:d + m], row[d + m:d + m + d], d)
        t = qc @ c / EP
        Rn = qc @ R @ qp.T
        pieces.append(robust_pose(t, Rn, d))
    return {'s': rec['s_full'], 'pieces': pieces}


# ------------------------------------------------------------------ one record
_UP = {}


def upstream_data(root):
    if root not in _UP:
        _UP[root] = json.load(open(os.path.join(root, 'src', 'polytopes_nd.json')))
    return _UP[root]


def process(job):
    path, root = job
    up = upstream_data(root)
    t0 = time.time()
    rec = json.load(open(path))
    d = rec['dim']
    pk, ck = rec['piece'], rec['container']
    problem = {'d': d, 'piece': f'{d}:{MAP[pk][1]}', 'container': f'{d}:{MAP[ck][1]}'}
    out = {'file': path, 'd': d, 'piece': MAP[pk][1], 'container': MAP[ck][1], 'P': rec['n']}
    try:
        config = convert(rec, up)
        res = certify.certify_config(problem, config, clearance=0.0)
    except Exception as e:  # noqa: BLE001
        out.update(ok=False, error=f'{type(e).__name__}: {e}', seconds=time.time() - t0)
        return out
    out.update(ok=bool(res['ok']), config=config, seconds=time.time() - t0,
               cert={k: res[k] for k in ('min_wall_gap', 'min_pair_gap', 'near_pairs', 'far_pairs', 'tests')},
               failures=res['failures'][:3] if not res['ok'] else [],
               upstream={k: rec.get(k) for k in ('s', 's_plus', 's_full', 's_tight', 'found_by', 'credit', 'date',
                                                 'method', 'record_id', 'volume_lower_bound', 'density')},
               lineage=rec.get('search'), upstream_cert=rec.get('certificate'))
    return out


def display(x):
    return str(Decimal(x).quantize(Decimal('0.000001'), rounding=ROUND_HALF_EVEN))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upstream', required=True)
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', 'data', 'ndim'))
    ap.add_argument('--jobs', type=int, default=8)
    ap.add_argument('--only', nargs='*')
    ap.add_argument('--fail-log')
    ap.add_argument('--pmax', type=int, default=None, help='test: only P up to this')
    a = ap.parse_args()
    up = json.load(open(os.path.join(a.upstream, 'src', 'polytopes_nd.json')))
    paths = []
    for p in sorted(glob.glob(os.path.join(a.upstream, 'records', '*in*'))):
        base = os.path.basename(p)
        if not os.path.isdir(p):
            continue
        m = re.match(r'^(c\d+|sx\d|hc\d|op\d)in(c\d+|sx\d|hc\d|op\d)$', base)
        if not m or m.group(1) not in MAP or m.group(2) not in MAP:
            continue
        if MAP[m.group(1)][0] != MAP[m.group(2)][0]:
            continue
        if a.only and base not in a.only:
            continue
        for f in sorted(glob.glob(os.path.join(p, f'{base}_n*.json'))):
            n = int(re.search(r'_n(\d+)\.json$', f).group(1))
            d = MAP[m.group(1)][0]
            if 2 <= n <= P_MAX[d] and (a.pmax is None or n <= a.pmax):
                paths.append(f)
    print(f'{len(paths)} upstream files', flush=True)
    # the largest jobs first
    paths.sort(key=lambda f: -os.path.getsize(f))
    results = []
    t0 = time.time()
    with ProcessPoolExecutor(a.jobs) as ex:
        for k, r in enumerate(ex.map(process, [(f, a.upstream) for f in paths], chunksize=1)):
            results.append(r)
            if (k + 1) % 50 == 0 or not r['ok']:
                print(f'{k + 1}/{len(paths)} {os.path.basename(r["file"])} ok={r["ok"]} {r["seconds"]:.1f}s '
                      f'(elapsed {time.time() - t0:.0f}s)' + ('' if r['ok'] else ' ' + str(r.get('error') or r.get('failures'))),
                      flush=True)
    os.makedirs(os.path.join(a.out, 'configs'), exist_ok=True)
    good = [r for r in results if r['ok']]
    bad = [r for r in results if not r['ok']]
    if a.fail_log:
        with open(a.fail_log, 'w') as f:
            json.dump([{k: v for k, v in r.items() if k != 'config'} for r in bad], f, indent=1)
    # records and configuration files
    by_problem = {}
    for r in good:
        by_problem.setdefault((r['d'], r['piece'], r['container']), []).append(r)
    records = []
    for (d, piece, container), rs in sorted(by_problem.items()):
        rs.sort(key=lambda r: r['P'])
        fname = f'{d}-{piece}-{container}'
        offset = 0
        with open(os.path.join(a.out, 'configs', fname + '.jsonl'), 'wb') as f:
            for r in rs:
                line = json.dumps({'P': r['P'], 'config': r['config']}, separators=(',', ':')).encode()
                f.write(line + b'\n')
                records.append({
                    'id': f'ndim/{d}/{piece}/{container}/{r["P"]}',
                    'd': d, 'piece': piece, 'container': container, 'P': r['P'],
                    'status': 'best_known',
                    'score_cert': r['config']['s'],
                    'display': display(r['config']['s']),
                    'config_at': [offset, len(line)],
                    'bound': None,
                    'found_by': r['upstream']['found_by'],
                    'credit': r['upstream']['credit'],
                    'method': r['upstream']['method'],
                    'sources': ['wiki'],
                    'source': 'Zarzuelo (alejandrozu/platonic-packing), MIT; converted to PolyPack poses and certified again '
                              'with python/ndim/certify.py',
                    'origin': {'file': os.path.relpath(r['file'], a.upstream),
                               'record_id': r['upstream']['record_id'], 'date': r['upstream']['date']},
                    'wiki': {'s': r['upstream']['s'], 's_plus': r['upstream']['s_plus'],
                             's_full': r['upstream']['s_full'], 's_tight': r['upstream']['s_tight']},
                    'lineage': r['lineage'],
                    'certification': {'clearance': 0.0, 'min_wall_gap': r['cert']['min_wall_gap'],
                                      'min_pair_gap': r['cert']['min_pair_gap'], 'near_pairs': r['cert']['near_pairs'],
                                      'seconds': round(r['seconds'], 2)},
                })
                offset += len(line) + 1
    json.dump({'generated': GENERATED, 'sources': SOURCES, 'records': records},
              open(os.path.join(a.out, 'records.json'), 'w'), separators=(',', ':'))
    print(f'{len(good)} records certified, {len(bad)} failed, {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
