#!/usr/bin/env python3
"""Certifier of the polyhedra space's records (standard library only).

usage: python3 python/polyhedra/certify.py [records.json] [--out certification.json] [--jobs J] [--ids id,id]
                                           [--sample K --seed S]

For every record of data/polyhedra/records.json it checks the published fields and proves the configuration valid:

  fields   id is polyhedra/<code>/<P> in its one written form with a known problem code; piece, container and family
           agree with the code; config has P poses of 7 JSON numbers; config.s == score_cert; display is score_cert
           rounded to the nearest at 6 decimals from its exact binary value (ROUND_HALF_EVEN); score_float <=
           score_cert; the bound is the volume bound and is <= score_cert; status is best_known (proven only with a
           published proof listed in literature); value-only literature entries are numbers with a source;
  geometry certify_config() below, a port of certify_general.main (vendored from alejandrozu/platonic-packing, MIT;
           see THIRD_PARTY_NOTICES.md) that returns its findings instead of printing them. It proves, with exact
           rational rotations R = H(q)/|q|^2 and rigorous fixed-point interval arithmetic on enclosures of the exact
           solid coordinates (solids_exact.json), that every piece lies in the interior of s C and that every two
           pieces are strictly separated: near pairs by an explicit rational plane, the others because their centres
           are farther apart than twice an upper bound of the circumradius. Floating point only proposes the planes,
           so a bad proposal can make a proof fail, never succeed.

Additions to upstream's checks: every entry must be a finite JSON number (no strings, booleans or NaN), every
quaternion must be nonzero, s must be positive and P must match the id. Exit code 0 iff every record passes.
"""
import argparse
import json
import math
import os
import random
import sys
import time
from decimal import ROUND_HALF_EVEN, Decimal
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue  # noqa: E402
import certify_general as cg  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_RECORDS = os.path.join(ROOT, 'data', 'polyhedra', 'records.json')
STATUSES = ('best_known', 'proven')


class CertError(Exception):
    pass


def display(x):
    """score_cert rounded to the nearest at 6 decimals from its exact binary64 value."""
    return str(Decimal(x).quantize(Decimal('0.000001'), rounding=ROUND_HALF_EVEN))


def exact(v, what):
    """A JSON number as the exact rational it denotes; anything else is refused."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise CertError(f'{what} must be a JSON number')
    if isinstance(v, float) and not math.isfinite(v):
        raise CertError(f'{what} must be finite')
    return Fraction(v)


def certify_config(piece, container, s, pieces):
    """Proves that `pieces` (poses [x, y, z, qw, qx, qy, qz]) form a packing in s * container with positive clearance.

    Returns a dict: ok, the number of containment inequalities and their smallest slack (a rigorous lower bound,
    divided by |normal| in floating point), the near and far pair counts, the smallest pair gap (a rigorous lower
    bound along the plane normal, |u| = 1 to about 1e-12), and the failures. Raises CertError for malformed input."""
    if piece not in cg.EXACT or container not in cg.EXACT:
        raise CertError(f'unknown solid {piece!r} or {container!r}')
    P, C = cg.get_solid(piece), cg.get_solid(container)
    s = exact(s, 's')
    if s <= 0:
        raise CertError('s must be positive')
    if not isinstance(pieces, list) or not pieces:
        raise CertError('pieces must be a nonempty list')
    cs, Rs = [], []
    for i, p in enumerate(pieces):
        if not isinstance(p, list) or len(p) != 7:
            raise CertError(f'pieces[{i}] must be [x, y, z, qw, qx, qy, qz]')
        v = [exact(x, f'pieces[{i}][{k}]') for k, x in enumerate(p)]
        if all(x == 0 for x in v[3:]):
            raise CertError(f'pieces[{i}]: zero quaternion')
        cs.append(v[:3])
        Rs.append(cg.rot(v[3:]))
    n = len(pieces)
    fx, fadd, fsub, fdot, fmul, ONE = cg.fx, cg.fadd, cg.fsub, cg.fdot, cg.fmul, cg.ONE
    # enclosures of the world vertices c + R v (v enclosed from the exact coordinates)
    X = []
    for R, c in zip(Rs, cs):
        Rf = [[fx(e) for e in row] for row in R]
        cf = [fx(e) for e in c]
        X.append([tuple(fadd(fdot(Rf[k], v), cf[k]) for k in range(3)) for v in P.V])
    # (1) containment: N_f . x < s B_f for every vertex and face (N_f the exact outward normal, not unit)
    sB = [fmul(fx(s), b) for b in C.B]
    nlen = [math.sqrt(sum(((c[0] + c[1]) / 2 / ONE) ** 2 for c in m)) for m in C.N]
    tests, worst, bad_walls = 0, math.inf, []
    for i in range(n):
        for x in X[i]:
            for f, (Nf, b) in enumerate(zip(C.N, sB)):
                tests += 1
                lo = fsub(b, fdot(Nf, x))[0]
                g = lo / ONE / nlen[f]
                if g < worst:
                    worst = g
                if lo <= 0 and (not bad_walls or bad_walls[-1] != i):
                    bad_walls.append(i)
    # (2) disjointness
    lim = 4 * P.R2up                                   # (2 R_up)^2 in fixed point
    Vf = [[[float(sum(float(R[k][j]) * P.Vf[v][j] for j in range(3)) + float(c[k])) for k in range(3)]
           for v in range(len(P.Vf))] for R, c in zip(Rs, cs)]
    Nw = [[[sum(float(R[k][j]) * nn[j] for j in range(3)) for k in range(3)] for nn in P.Nf] for R in Rs]
    near = far = 0
    margin = None
    bad_pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            d2 = sum((cs[i][k] - cs[j][k]) ** 2 for k in range(3))
            if d2 * ONE > lim:
                far += 1
                continue
            near += 1
            done = False
            for u in cg.candidate_axes(P, Vf[i], Vf[j], Nw[i], Nw[j]):
                uq = [Fraction(x).limit_denominator(10 ** 12) for x in u]
                uf = [fx(x) for x in uq]
                pa = [fdot(uf, x) for x in X[i]]
                pb = [fdot(uf, x) for x in X[j]]
                amax, bmin = max(p[1] for p in pa), min(p[0] for p in pb)
                if amax < bmin:
                    g = bmin - amax
                    margin = g if margin is None else min(margin, g)
                    done = True
                    break
                bmax, amin = max(p[1] for p in pb), min(p[0] for p in pa)
                if bmax < amin:
                    g = amin - bmax
                    margin = g if margin is None else min(margin, g)
                    done = True
                    break
            if not done:
                bad_pairs.append([i, j])
    return {
        'ok': not bad_walls and not bad_pairs,
        'containment_tests': tests,
        'min_wall_slack': worst,
        'near_pairs': near,
        'far_pairs': far,
        'min_pair_gap': (margin / ONE) if margin is not None else None,
        'failed_walls': bad_walls[:20],
        'failed_pairs': bad_pairs[:20],
    }


def volume_bound(piece, container, P, volumes):
    return (P * volumes[piece] / volumes[container]) ** (1.0 / 3.0)


def field_errors(rec, volumes):
    """Errors of the published fields of one record (empty when they are right)."""
    err = []
    if not isinstance(rec, dict):
        return ['the record is not an object']
    parsed = catalogue.parse_id(rec.get('id'))
    if parsed is None:
        return [f'id {rec.get("id")!r} is not polyhedra/<code>/<P> in its one written form with a known code']
    code, P = parsed
    piece, container, family = catalogue.PROBLEMS[code]
    for k, want in (('code', code), ('piece', piece), ('container', container), ('family', family), ('P', P)):
        if rec.get(k) != want:
            err.append(f'{k} is {rec.get(k)!r}, the id says {want!r}')
    cfg = rec.get('config')
    if not isinstance(cfg, dict) or set(cfg) != {'s', 'pieces'}:
        return err + ['config must be {s, pieces}']
    if not isinstance(cfg['pieces'], list) or len(cfg['pieces']) != P:
        err.append(f'config has {len(cfg["pieces"]) if isinstance(cfg["pieces"], list) else "no"} pieces, the id says {P}')
    sc = rec.get('score_cert')
    sf = rec.get('score_float')
    for k, v in (('score_cert', sc), ('score_float', sf), ('config.s', cfg['s'])):
        if isinstance(v, bool) or not isinstance(v, float) or not math.isfinite(v) or v <= 0:
            err.append(f'{k} must be a positive finite float')
    if err:
        return err
    if cfg['s'] != sc:
        err.append(f'config.s {cfg["s"]!r} differs from score_cert {sc!r}')
    if rec.get('display') != display(sc):
        err.append(f'display is {rec.get("display")!r}, score_cert rounds to {display(sc)!r}')
    if not sf <= sc:
        err.append(f'score_float {sf!r} is above score_cert {sc!r}')
    b = rec.get('bound')
    vb = volume_bound(piece, container, P, volumes)
    if not isinstance(b, dict) or not isinstance(b.get('value'), float):
        err.append('bound must be {value, kind, label}')
    else:
        if not b['value'] <= sc:
            err.append(f'bound {b["value"]!r} is above score_cert {sc!r}')
        if b.get('kind') == 'volume' and abs(b['value'] - vb) > 1e-12 * vb:
            err.append(f'the volume bound is {vb!r}, the record says {b["value"]!r}')
    status = rec.get('status')
    if status not in STATUSES:
        err.append(f'status {status!r} is not one of {STATUSES}')
    lit = rec.get('literature', [])
    if not isinstance(lit, list):
        err.append('literature must be a list')
    else:
        for k, e in enumerate(lit):
            if not isinstance(e, dict) or not isinstance(e.get('value'), float) or not isinstance(e.get('source'), str):
                err.append(f'literature[{k}] must have a float value and a source')
    if status == 'proven' and not any(isinstance(e, dict) and e.get('proof') for e in lit or []):
        err.append('status proven needs a published proof in literature')
    if not isinstance(rec.get('found_by'), str) or not rec['found_by']:
        err.append('found_by is missing')
    return err


def check_record(rec, volumes):
    """(ok, summary) for one record: the field checks, then the geometric certificate."""
    t0 = time.time()
    rid = rec.get('id') if isinstance(rec, dict) else None
    errs = field_errors(rec, volumes)
    out = {'id': rid}
    if errs:
        out.update(ok=False, errors=errs)
        return out
    try:
        c = certify_config(rec['piece'], rec['container'], rec['config']['s'], rec['config']['pieces'])
    except (CertError, ZeroDivisionError, ValueError, AssertionError) as e:
        out.update(ok=False, errors=[f'not certified: {e}'])
        return out
    out.update(c)
    out['seconds'] = round(time.time() - t0, 3)
    if not c['ok']:
        out['errors'] = [f'not certified: walls {c["failed_walls"]}, pairs {c["failed_pairs"]}']
    return out


def solid_volumes():
    """Volumes of the solids from their float coordinates (only for the volume bound check)."""
    vol = {}
    for name in cg.EXACT:
        S = cg.get_solid(name)
        V = S.Vf
        total = 0.0
        for f in S.faces:
            a = V[f[0]]
            for i in range(1, len(f) - 1):
                b, c = V[f[i]], V[f[i + 1]]
                total += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                          + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
        vol[name] = abs(total)
    return vol


_VOL = None


def _worker(rec):
    global _VOL
    if _VOL is None:
        _VOL = solid_volumes()
    return check_record(rec, _VOL)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('records', nargs='?', default=DEFAULT_RECORDS)
    ap.add_argument('--out', help='write the per-record summary here (JSON)')
    ap.add_argument('--jobs', type=int, default=1)
    ap.add_argument('--ids', help='comma-separated ids to check (default all)')
    ap.add_argument('--sample', type=int, help='check K records drawn at random')
    ap.add_argument('--seed', type=int, default=1)
    a = ap.parse_args(argv)
    doc = json.load(open(a.records))
    recs = doc['records']
    if a.ids:
        want = set(a.ids.split(','))
        recs = [r for r in recs if r.get('id') in want]
    if a.sample:
        recs = random.Random(a.seed).sample(recs, min(a.sample, len(recs)))
    t0 = time.time()
    if a.jobs > 1:
        import multiprocessing as mp
        with mp.Pool(a.jobs) as pool:
            results = pool.map(_worker, recs, chunksize=4)
    else:
        results = [_worker(r) for r in recs]
    ids = [r.get('id') for r in doc['records']]
    dup = len(ids) - len(set(ids))
    bad = [r for r in results if not r['ok']]
    for r in bad[:30]:
        print('FAILED', r['id'], '; '.join(r.get('errors', [])))
    walls = [r['min_wall_slack'] for r in results if r.get('ok')]
    gaps = [r['min_pair_gap'] for r in results if r.get('ok') and r.get('min_pair_gap') is not None]
    slow = max(results, key=lambda r: r.get('seconds', 0)) if results else None
    print(f'{len(results) - len(bad)} of {len(results)} records certified in {time.time() - t0:.1f} s'
          + (f'; smallest wall slack {min(walls):.3e}' if walls else '')
          + (f', smallest pair gap {min(gaps):.3e}' if gaps else '')
          + (f'; slowest {slow["id"]} {slow.get("seconds")} s' if slow else '')
          + (f'; {dup} duplicate ids' if dup else ''))
    if a.out:
        json.dump({'checker': 'python/polyhedra/certify.py (certify_general.py geometry, 170-bit fixed-point intervals)',
                   'records': a.records if not os.path.isabs(a.records) else os.path.basename(a.records),
                   'results': [{k: v for k, v in r.items() if k not in ('failed_walls', 'failed_pairs') or v}
                               for r in results]}, open(a.out, 'w'), separators=(',', ':'))
    return 0 if not bad and not dup else 1


if __name__ == '__main__':
    sys.exit(main())
