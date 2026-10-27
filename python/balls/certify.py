#!/usr/bin/env python3
"""Certifier of the balls space's records (standard library only).

usage: python3 python/balls/certify.py [records.json] [--out certification.json] [--ids id,id] [--jobs J]

For every record of data/balls/records.json, with its configuration from data/balls/configs/<code>.jsonl (the line
its config_at locates), it checks the published fields and proves the configuration valid.

  fields   id is balls/<code>/<P> in its one written form with a known code and 2 <= P <= 100; piece and container
           agree with the code; config has P pieces of JSON numbers (3 for a ball, 7 for a solid); config.s ==
           score_cert; display is score_cert rounded to the nearest at 6 decimals from its exact binary value
           (ROUND_HALF_EVEN); the bound is the elementary bound of the problem and is <= score_cert; status is
           best_known, or proven with a literature entry that names its proof and gives an optimum <= score_cert;
           literature entries are numbers with a source.
  geometry Every JSON number is read as the exact rational it denotes (a binary64 float is a dyadic rational).
           Balls (radius r = BALL_RADIUS, balls_catalogue.py), exactly in rationals:
             pairs      |c_i - c_j|^2 >= (2 r)^2 for every two centres;
             ball       s >= r and |c_i|^2 <= (s - r)^2;
             cube       |c_ik| <= s/2 - r for k = 1, 2, 3 (the cube [-s/2, s/2]^3);
           and in any other solid C of the polyhedra space (s times the canonical solid about its vertex centroid; faces
           N_f . x <= s b_f with N_f the exact outward normals, not unit, of solids_exact.json), for every ball and face
           N_f . c + r |N_f| < s B_f, decided with 170-bit interval arithmetic with outward rounding on the exact N_f, B_f
           and |N_f| (an upper bound of its square root); the walls are certified strictly, as the solids' are, so that a
           ball touching a face of an irrational solid is refused rather than guessed.
           Solids (edge 1) in the ball of radius s, with the polyhedra space's vendored certify_general
           machinery (python/polyhedra; MIT, see THIRD_PARTY_NOTICES.md): the solids are checked exactly in their
           number field (solids_exact.json); each rotation is the exact rational matrix H(q)/|q|^2 of the stored
           quaternion; every world vertex c + R v is enclosed with 170-bit fixed-point intervals with outward
           rounding, and an upper bound of |x|^2 must be below s^2 (rounded down); every pair whose centres are
           closer than twice an upper bound of the circumradius is strictly separated by an explicit rational plane
           (floating point only proposes the axes: face normals and Gauss-map pruned edge cross products), and the
           others are farther apart than the sum of their circumradii.
Floating point never decides a check, so a bad proposal can make a proof fail, never succeed. The pieces may touch
(the balls' checks are closed); the records keep a clearance of 1e-10, reported as the smallest gaps.
Exit code 0 iff every record passes.
"""
import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from decimal import ROUND_HALF_EVEN, Decimal
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.append(os.path.join(os.path.dirname(HERE), "polyhedra"))
import balls_catalogue as catalogue  # noqa: E402
import certify_general as cg  # noqa: E402

R = catalogue.BALL_RADIUS
D = catalogue.BALL_DIAMETER

DEFAULT_RECORDS = os.path.join(ROOT, 'data', 'balls', 'records.json')
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


def isqrt_up(n):
    """An integer at least the square root of the integer n >= 0."""
    return math.isqrt(n) + 1


def certify_walls_in_solid(container, s, cs):
    """The walls of a solid container (not the ball or the cube): bad_walls (indices of balls not proven inside) and the
    smallest wall slack, a rigorous lower bound (float) of s b_f - r - N_f . c over balls and faces, in the unit
    normals' terms. For every ball and face the inequality N_f . c + r |N_f| < s B_f is decided with fixed-point
    intervals: the exact N_f and B_f enclosed by certify_general, c and s exact rationals, |N_f| bounded above by the
    fixed-point square root of an upper bound of N_f . N_f. Never decided by floating point."""
    if container not in cg.EXACT:
        raise CertError(f'unknown container {container!r}')
    C = cg.get_solid(container)
    ONE, fx, fdot, fmul = cg.ONE, cg.fx, cg.fdot, cg.fmul
    sf = fx(s)
    rf = fx(R)
    faces = []
    for N, B in zip(C.N, C.B):
        n2 = fdot(N, N)[1]                       # an upper bound of |N|^2, fixed point
        nu = isqrt_up(n2 * ONE)                  # an upper bound of |N|, fixed point
        faces.append((N, fmul(sf, B)[0], fmul(rf, (nu, nu))[1], nu))
    bad, worst = [], math.inf
    for i, c in enumerate(cs):
        cf = [fx(x) for x in c]
        for N, sB, rN, nu in faces:
            slack = sB - fdot(N, cf)[1] - rN     # a lower bound of s B_f - N_f . c - r |N_f|
            if slack <= 0 and (not bad or bad[-1] != i):
                bad.append(i)
            worst = min(worst, slack / ONE / (nu / ONE))
    return bad, worst


def certify_balls(container, s, pieces):
    """Proves that balls of radius BALL_RADIUS at `pieces` (centres [x, y, z]) lie in the closed container of size s
    ('ball', 'cube' or the name of another solid of the polyhedra space) with disjoint interiors: exactly in rationals
    for the pairs, the ball and the cube, with interval arithmetic for the other solids' walls. Returns ok, the smallest
    pair gap |c_i - c_j| - 2 r and the smallest wall gap (both as floats of exact values, for the report; the other
    solids' is a lower bound) and the failures. Raises CertError for malformed input."""
    s = exact(s, 's')
    if s <= 0:
        raise CertError('s must be positive')
    if not isinstance(pieces, list) or not pieces:
        raise CertError('pieces must be a nonempty list')
    cs = []
    for i, p in enumerate(pieces):
        if not isinstance(p, list) or len(p) != 3:
            raise CertError(f'pieces[{i}] must be [x, y, z]')
        cs.append([exact(x, f'pieces[{i}][{k}]') for k, x in enumerate(p)])
    bad_walls, bad_pairs = [], []
    min_wall = math.inf
    if container == 'ball':
        r = s - R
        if r < 0:
            raise CertError(f'a ball container of radius below {R} holds no ball of radius {R}')
        r2 = r * r
        for i, c in enumerate(cs):
            d2 = c[0] * c[0] + c[1] * c[1] + c[2] * c[2]
            if d2 > r2:
                bad_walls.append(i)
            # report only: the gap r - |c|, from the exact d2 in floating point
            min_wall = min(min_wall, float(r) - math.sqrt(float(d2)))
    elif container == 'cube':
        h = s / 2 - R
        if h < 0:
            raise CertError(f'a cube of edge below {D} holds no ball of radius {R}')
        for i, c in enumerate(cs):
            m = max(abs(x) for x in c)
            if m > h:
                bad_walls.append(i)
            min_wall = min(min_wall, float(h - m))
    else:
        bad_walls, min_wall = certify_walls_in_solid(container, s, cs)
    min_pair = math.inf
    n = len(cs)
    for i in range(n):
        a = cs[i]
        for j in range(i + 1, n):
            b = cs[j]
            d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
            if d2 < D * D:
                bad_pairs.append([i, j])
            if d2 < (1.5 * D) ** 2:
                # report only
                min_pair = min(min_pair, gap_of(d2))
    return {
        'ok': not bad_walls and not bad_pairs,
        'min_wall_gap': min_wall,
        'min_pair_gap': min_pair if min_pair < math.inf else None,
        'failed_walls': bad_walls[:20],
        'failed_pairs': bad_pairs[:20],
    }


def gap_of(d2):
    """|c_i - c_j| - 2 r from the exact d2 = |c_i - c_j|^2, as (d2 - 4 r^2) / (|c_i - c_j| + 2 r) to keep its digits."""
    return float(d2 - D * D) / (math.sqrt(float(d2)) + D)


def certify_solids(piece, s, pieces):
    """Proves that `pieces` (poses [x, y, z, qw, qx, qy, qz]) of the canonical `piece` lie in the closed ball of
    radius s about the origin with disjoint interiors (see the module comment). Returns ok, the smallest wall slack
    (a rigorous lower bound of s - |x|), the near and far pair counts, the smallest pair gap (a rigorous lower bound
    along the plane normal, |u| = 1 to about 1e-12) and the failures. Raises CertError for malformed input."""
    if piece not in cg.EXACT:
        raise CertError(f'unknown solid {piece!r}')
    P = cg.get_solid(piece)
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
    fx, fadd, fdot, fmul, ONE = cg.fx, cg.fadd, cg.fdot, cg.fmul, cg.ONE
    X = []
    for R, c in zip(Rs, cs):
        Rf = [[fx(e) for e in row] for row in R]
        cf = [fx(e) for e in c]
        X.append([tuple(fadd(fdot(Rf[k], v), cf[k]) for k in range(3)) for v in P.V])
    # (1) containment: an upper bound of |x|^2 below a lower bound of s^2. fmul(a, a)[1] bounds a^2 from above
    # whatever the signs of a's ends.
    s2lo = fx(s * s)[0]
    bad_walls, worst = [], math.inf
    for i in range(n):
        for x in X[i]:
            up = fmul(x[0], x[0])[1] + fmul(x[1], x[1])[1] + fmul(x[2], x[2])[1]
            if not up < s2lo and (not bad_walls or bad_walls[-1] != i):
                bad_walls.append(i)
            # report only: s - |x| >= (s^2 - up) / (2 s), a lower bound since |x| <= sqrt(up) <= s when it holds
            worst = min(worst, (s2lo - up) / ONE / (2 * float(s)))
    # (2) disjointness, as certify_general does it
    lim = 4 * P.R2up
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
        'min_wall_gap': worst,
        'near_pairs': near,
        'far_pairs': far,
        'min_pair_gap': (margin / ONE) if margin is not None else None,
        'failed_walls': bad_walls[:20],
        'failed_pairs': bad_pairs[:20],
    }


def certify_config(code, s, pieces):
    prob = catalogue.PROBLEMS.get(code)
    if prob is None:
        raise CertError(f'unknown problem {code!r}')
    if prob['piece'] == 'ball':
        return certify_balls(prob['container'], s, pieces)
    return certify_solids(prob['piece'], s, pieces)


def load_records(path):
    """records.json with every record's configuration attached from configs/<code>.jsonl at its config_at (a line
    that is not there, or not the record's P, leaves the record without one; field_errors reports it)."""
    with open(path) as f:
        doc = json.load(f)
    cdir = os.path.join(os.path.dirname(os.path.abspath(path)), 'configs')
    cache = {}
    for r in doc.get('records', []):
        if not isinstance(r, dict) or 'config' in r or not isinstance(r.get('code'), str):
            continue
        code = r['code']
        if code not in cache:
            fn = os.path.join(cdir, f'{code}.jsonl') if code in catalogue.PROBLEMS else None
            try:
                with open(fn, 'rb') as f:
                    cache[code] = f.read()
            except (OSError, TypeError):
                cache[code] = b''
        at = r.get('config_at')
        if not (isinstance(at, list) and len(at) == 2 and all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in at)):
            continue
        try:
            line = json.loads(cache[code][at[0]:at[0] + at[1]])
        except ValueError:
            continue
        if isinstance(line, dict) and line.get('P') == r.get('P') and 'config' in line:
            r['config'] = line['config']
    return doc


def field_errors(rec):
    """Errors of the published fields of one record (empty when they are right)."""
    if not isinstance(rec, dict):
        return ['the record is not an object']
    parsed = catalogue.parse_id(rec.get('id'))
    if parsed is None:
        return [f'id {rec.get("id")!r} is not balls/<code>/<P> in its one written form with a known code and 2 <= P <= 100']
    code, P = parsed
    prob = catalogue.PROBLEMS[code]
    err = []
    for k in ('code', 'piece', 'container'):
        want = code if k == 'code' else prob[k]
        if rec.get(k) != want:
            err.append(f'{k} is {rec.get(k)!r}, not {want!r}')
    if rec.get('P') != P:
        err.append(f'P is {rec.get("P")!r}, not {P}')
    cfg = rec.get('config')
    width = 3 if prob['piece'] == 'ball' else 7
    if not isinstance(cfg, dict) or not isinstance(cfg.get('pieces'), list):
        return err + ['config {s, pieces} is missing']
    if len(cfg['pieces']) != P:
        err.append(f'config has {len(cfg["pieces"])} pieces, not {P}')
    for i, p in enumerate(cfg['pieces']):
        if not (isinstance(p, list) and len(p) == width and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in p)):
            err.append(f'pieces[{i}] is not {width} finite JSON numbers')
            break
    sc = rec.get('score_cert')
    if not (isinstance(sc, float) and math.isfinite(sc) and sc > 0) or cfg.get('s') != sc:
        err.append('score_cert must be a positive float equal to config.s')
    elif rec.get('display') != display(sc):
        err.append(f'display is {rec.get("display")!r}, not {display(sc)!r}')
    b = rec.get('bound')
    want = catalogue.bound(code, P)
    if not isinstance(b, dict) or not isinstance(b.get('value'), float) or abs(b['value'] - want) > 1e-12 * want:
        err.append(f'bound.value must be the elementary bound {want!r}')
    elif isinstance(sc, float) and b['value'] > sc:
        err.append('the bound is above score_cert')
    status = rec.get('status')
    lit = rec.get('literature')
    if not isinstance(lit, list):
        err.append('literature must be a list')
        lit = []
    for e in lit:
        if not (isinstance(e, dict) and isinstance(e.get('value'), float) and math.isfinite(e['value']) and isinstance(e.get('source'), str) and e['source']):
            err.append('a literature entry is not {value, source, ...}')
    if status not in STATUSES:
        err.append(f'status {status!r} is not one of {STATUSES}')
    elif status == 'proven':
        proofs = [e for e in lit if isinstance(e, dict) and isinstance(e.get('proof'), str) and isinstance(e.get('short'), str)]
        if not proofs:
            err.append('a proven record must cite its proof in literature (proof, short)')
        elif isinstance(sc, float) and not all(isinstance(e.get('value'), float) and e['value'] <= sc * (1 + 1e-12) for e in proofs):
            err.append('the proven optimum is above score_cert')
    return err


def certify_record(rec):
    t0 = time.time()
    out = {'id': rec.get('id') if isinstance(rec, dict) else None}
    errs = field_errors(rec)
    if errs:
        out.update(ok=False, errors=errs)
        return out
    try:
        res = certify_config(rec['code'], rec['config']['s'], rec['config']['pieces'])
    except CertError as e:
        out.update(ok=False, errors=[str(e)])
        return out
    out.update(res)
    if not res['ok']:
        out['errors'] = ['not certified']
    out['seconds'] = round(time.time() - t0, 3)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('records', nargs='?', default=DEFAULT_RECORDS)
    ap.add_argument('--out')
    ap.add_argument('--ids')
    ap.add_argument('--jobs', type=int, default=1)
    a = ap.parse_args(argv)
    doc = load_records(a.records)
    recs = doc.get('records', [])
    if a.ids:
        want = set(a.ids.split(','))
        recs = [r for r in recs if isinstance(r, dict) and r.get('id') in want]
    ids = [r.get('id') for r in recs if isinstance(r, dict)]
    dup = {i for i in ids if ids.count(i) > 1}
    t0 = time.time()
    if a.jobs > 1:
        with ProcessPoolExecutor(a.jobs) as ex:
            results = list(ex.map(certify_record, recs, chunksize=4))
    else:
        results = [certify_record(r) for r in recs]
    for r in results:
        if r['id'] in dup:
            r['ok'] = False
            r.setdefault('errors', []).append('id listed twice')
    good = sum(1 for r in results if r['ok'])
    for r in results:
        if not r['ok']:
            print('FAILED', r['id'], '; '.join(r.get('errors', [])), r.get('failed_walls'), r.get('failed_pairs'))
    walls = [r['min_wall_gap'] for r in results if r.get('ok') and r.get('min_wall_gap') is not None]
    pairs = [r['min_pair_gap'] for r in results if r.get('ok') and r.get('min_pair_gap') is not None]
    print(f'{good} of {len(results)} certified in {time.time() - t0:.1f} s'
          + (f'; smallest wall gap {min(walls):.3e}, smallest pair gap {min(pairs):.3e}' if walls and pairs else ''))
    if a.out:
        with open(a.out, 'w') as f:
            json.dump({'records': len(results), 'certified': good, 'results': results}, f, indent=0)
            f.write('\n')
    return 0 if good == len(results) and results else 1


if __name__ == '__main__':
    sys.exit(main())
