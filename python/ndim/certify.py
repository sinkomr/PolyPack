#!/usr/bin/env python3
"""Exact certifier of nD packings (standard library only): d = 4 to 10, polytopes of the catalogue and balls.

usage: python3 python/ndim/certify.py record.json [--clearance 1e-7]
       record.json = {"problem": {"d": 6, "piece": "6:cube", "container": "6:cube"},
                      "config": {"s": 2.0000004, "pieces": [[...pose...], ...]}}

A problem names the piece and the container by a catalogue code ("4:24cell", see catalogue.py) or "ball". Pieces of unit
edge or balls of diameter 1; the container, centred at the origin, is s times the unit-edge polytope or the ball of
diameter s (radius s/2). A pose of a polytope is [t_1..t_d, k_1..k_m, flip] (m = d(d-1)/2; the flip is optional, 0 when
absent): the centre t of the piece's vertex centroid and the rotation R = D (I - S)^-1 (I + S), S the skew matrix with
S[i][j] = k (i < j, row-major) and D the diagonal matrix with -1 in the positions of the set bits of flip (an even
number of them). The pose of a ball is its centre [t_1..t_d]. Every number is a JSON number and means the exact
rational it denotes, so R is an exactly orthogonal rational matrix with determinant 1.

What is proved (all inequalities strict, decided with rigorous fixed-point interval arithmetic of 170 bits on enclosures
of the exact catalogue coordinates; floating point only proposes the separating directions, so a bad proposal can make
the certification fail, never succeed):
  containment  in a polytope container: every vertex x of every piece (a ball: centre c and radius 1/2) satisfies
               N_f . x < s B_f for every facet f; in a ball container: |x|^2 < (s/2)^2 for every vertex (a ball:
               |c| + 1/2 < s/2, in exact rationals);
  separation   every two pieces are strictly separated: pairs whose centres are farther apart than the sum of their
               circumradii by an upper bound are disjoint; every other pair gets an explicit rational vector u and the
               exact test max over one piece of u.x < min over the other (a ball: u.c - |u|/2).
With clearance > 0 the proved gaps (distances along the unit direction u, or to a wall) must exceed it.

certify_config returns a dict: ok, counts, the smallest proved wall gap and pair gap (rigorous lower bounds, floats) and
the failures; it raises CertError for a malformed problem or configuration. Not covered: the exact coordinates are the
catalogue's, whose own proof is catalogue.verify."""
import argparse
import json
import math
import os
import sys
import time
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue as CAT  # noqa: E402
import exact as X  # noqa: E402
import floatgeom as G  # noqa: E402

MAX_COORD = 1e4          # largest |t_i|
MAX_SIZE = 1e6           # largest s
BALL_RADIUS = Fraction(1, 2)
SAT_FACET_LIMIT = 64     # pieces with at most this many facets also propose their facet normals


class CertError(Exception):
    pass


def num(v, what):
    """A JSON number as the exact rational it denotes; anything else is refused."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise CertError(f'{what} must be a JSON number')
    if isinstance(v, float) and not math.isfinite(v):
        raise CertError(f'{what} must be finite')
    return Fraction(v)


# ------------------------------------------------------------------ exact rotations
def cayley_exact(params, d, flip=0):
    """R = D (I - S)^-1 (I + S) as a d x d matrix of Fractions (S from the Fraction parameters, upper triangle row-major)."""
    S = [[Fraction(0)] * d for _ in range(d)]
    k = 0
    for i in range(d):
        for j in range(i + 1, d):
            S[i][j], S[j][i] = params[k], -params[k]
            k += 1
    if not any(any(r) for r in S):
        C = [[Fraction(int(i == j)) for j in range(d)] for i in range(d)]
    else:
        # solve (I - S) C = (I + S) by Gauss-Jordan over Q
        M = [[(1 if i == j else 0) - S[i][j] for j in range(d)] + [(1 if i == j else 0) + S[i][j] for j in range(d)]
             for i in range(d)]
        M = [[Fraction(x) for x in r] for r in M]
        for c in range(d):
            p = next(r for r in range(c, d) if M[r][c] != 0)    # I - S is invertible: S is skew
            M[c], M[p] = M[p], M[c]
            iv = 1 / M[c][c]
            M[c] = [x * iv for x in M[c]]
            for r in range(d):
                if r != c and M[r][c] != 0:
                    f = M[r][c]
                    M[r] = [x - f * y for x, y in zip(M[r], M[c])]
        C = [r[d:] for r in M]
    return [[(-C[i][j] if flip >> i & 1 else C[i][j]) for j in range(d)] for i in range(d)]


def is_orthogonal(R):
    d = len(R)
    return all(sum(R[k][i] * R[k][j] for k in range(d)) == (1 if i == j else 0) for i in range(d) for j in range(d))


def parse_shape(code, d, what):
    if code == 'ball':
        return None
    if not isinstance(code, str):
        raise CertError(f'{what} must be a catalogue code or "ball"')
    try:
        P = CAT.get(code)
    except KeyError:
        raise CertError(f'unknown {what} {code!r}')
    if P.d != d:
        raise CertError(f'{what} {code} is not {d}-dimensional')
    return P


class Placed:
    """One piece: exact centre t (Fractions), exact rotation (integer matrix P over den, sparse rows) or none (a ball)."""

    def __init__(self, d, ball, pose, i):
        m = G.n_params(d)
        if not isinstance(pose, list):
            raise CertError(f'pieces[{i}] must be an array of numbers')
        if ball:
            if len(pose) != d:
                raise CertError(f'pieces[{i}] (a ball) must be its centre, {d} numbers')
        elif len(pose) not in (d + m, d + m + 1):
            raise CertError(f'pieces[{i}] must have {d + m} numbers (centre and Cayley parameters) and an optional flip')
        v = [num(x, f'pieces[{i}][{k}]') for k, x in enumerate(pose[:d + m])]
        if any(abs(x) > MAX_COORD for x in v[:d]):
            raise CertError(f'pieces[{i}]: centre coordinates must be at most {MAX_COORD:g} in absolute value')
        self.t = v[:d]
        self.ball = ball
        self.R = None
        if not ball:
            if any(abs(x) > Fraction(G.MAX_CAYLEY) for x in v[d:]):
                raise CertError(f'pieces[{i}]: Cayley parameters must be at most {G.MAX_CAYLEY:g} in absolute value')
            flip = 0
            if len(pose) == d + m + 1:
                f = pose[d + m]
                if isinstance(f, bool) or not isinstance(f, int) or not 0 <= f < (1 << d):
                    raise CertError(f'pieces[{i}]: the flip must be an integer in [0, 2^{d})')
                if bin(f).count('1') % 2:
                    raise CertError(f'pieces[{i}]: the flip must have an even number of set bits (a reflection is refused)')
                flip = f
            R = cayley_exact(v[d:], d, flip)
            den = 1
            for row in R:
                for x in row:
                    den = X.lcm(den, x.denominator)
            self.den = den
            self.Rf = [[float(x) for x in row] for row in R]
            self.rows = [[(j, int(x * den)) for j, x in enumerate(row) if x != 0] for row in R]
            self.R = R


# ------------------------------------------------------------------ the certificate
def world_enc(piece, venc):
    """Fixed-point enclosures of the world vertices c + R v of a polytope piece: a list of rows of (lo, hi)."""
    d = len(piece.t)
    tenc = [X.fx(x) for x in piece.t]
    den = piece.den
    out = []
    for v in venc:
        row = []
        for i in range(d):
            lo = hi = 0
            for j, p in piece.rows[i]:
                a, b = v[j]
                if p >= 0:
                    lo += p * a
                    hi += p * b
                else:
                    lo += p * b
                    hi += p * a
            row.append((tenc[i][0] + lo // den, tenc[i][1] - ((-hi) // den)))
        out.append(row)
    return out


def float_world(piece, vfl):
    d = len(piece.t)
    t = [float(x) for x in piece.t]
    R = piece.Rf
    return [[t[i] + sum(R[i][j] * v[j] for j in range(d)) for i in range(d)] for v in vfl]


def float_normals(piece, nfl):
    d = len(piece.t)
    R = piece.Rf
    return [[sum(R[i][j] * n[j] for j in range(d)) for i in range(d)] for n in nfl]


def plane_test(u_int, XA, XB):
    """Exact test of the plane with integer normal u: the largest u.x over the world vertex enclosures XA against the
    smallest over XB, in units of 2^-K. Returns min_B u.x - max_A u.x (a lower bound; positive iff A is strictly below B)."""
    amax = None
    for x in XA:
        s = 0
        for a, (lo, hi) in zip(u_int, x):
            if a:
                s += a * (hi if a > 0 else lo)
        if amax is None or s > amax:
            amax = s
    bmin = None
    for x in XB:
        s = 0
        for a, (lo, hi) in zip(u_int, x):
            if a:
                s += a * (lo if a > 0 else hi)
        if bmin is None or s < bmin:
            bmin = s
    return bmin - amax


def certify_config(problem, config, clearance=0.0):
    t0 = time.time()
    if not isinstance(problem, dict):
        raise CertError('problem must be an object {d, piece, container}')
    d = problem.get('d')
    if isinstance(d, bool) or not isinstance(d, int) or not 4 <= d <= 10:
        raise CertError('d must be an integer from 4 to 10')
    PP = parse_shape(problem.get('piece'), d, 'piece')
    CC = parse_shape(problem.get('container'), d, 'container')
    if not isinstance(config, dict):
        raise CertError('config must be an object {s, pieces}')
    s = num(config.get('s'), 's')
    if not 0 < s <= MAX_SIZE:
        raise CertError(f's must be positive and at most {MAX_SIZE:g}')
    pcs = config.get('pieces')
    if not isinstance(pcs, list) or not pcs:
        raise CertError('pieces must be a nonempty list')
    clr = Fraction(clearance)
    placed = [Placed(d, PP is None, p, i) for i, p in enumerate(pcs)]
    n = len(placed)
    failures = []
    stats = {'tests': 0, 'near': 0, 'far': 0}
    wall_min = math.inf
    pair_min = math.inf

    # ---- world vertex enclosures and circumradii
    if PP is not None:
        venc = PP.vertex_enc()
        vfl = PP.vertices_float()
        r2 = PP.circumradius2_up()
        R_up = Fraction(math.isqrt(r2 << X.K) + 1, X.ONE)       # upper bound of the circumradius
        XW = [world_enc(p, venc) for p in placed]
    else:
        R_up = BALL_RADIUS
        XW = None

    # ---- (1) containment
    if CC is None:
        R = s / 2
        for i, p in enumerate(placed):
            if PP is None:
                c2 = sum(x * x for x in p.t)
                gap_ok = R - BALL_RADIUS - clr
                stats['tests'] += 1
                if not (gap_ok > 0 and c2 < gap_ok * gap_ok):
                    failures.append(('wall', i))
                else:
                    wall_min = min(wall_min, float(R - BALL_RADIUS) - math.sqrt(float(c2)) - 0.0)
            else:
                worst = max(sum(X.fmul(c, c)[1] for c in x) for x in XW[i])
                stats['tests'] += len(XW[i])
                R_cl = R - clr
                lim = X.fx(R_cl * R_cl)[0] if R_cl > 0 else 0
                if not worst < lim:
                    failures.append(('wall', i))
                else:
                    wall_min = min(wall_min, float(R) - math.sqrt(worst / X.ONE))
    else:
        N, B = CC.facet_enc()
        sfx = X.fx(s)
        sB = [X.fmul(sfx, b) for b in B]
        Nz = [[(k, c) for k, c in enumerate(nf) if c != (0, 0)] for nf in N]
        nlen = [X.fsqrt(Fraction(sum(X.fmul(c, c)[1] for _, c in nz), X.ONE)) for nz in Nz]   # |N_f| (upper)
        nlenf = [x[1] / X.ONE for x in nlen]
        cl_fx = [X.fx(clr * Fraction(x[0] + x[1], 2 * X.ONE)) for x in nlen]                  # clearance * |N_f|
        for i, p in enumerate(placed):
            bad = False
            if PP is None:
                cenc = [X.fx(x) for x in p.t]
                rad = X.fx(BALL_RADIUS)
                for f, nz in enumerate(Nz):
                    stats['tests'] += 1
                    dotc = (0, 0)
                    for k, c in nz:
                        dotc = X.fadd(dotc, X.fmul(c, cenc[k]))
                    slack = X.fsub(X.fsub(sB[f], dotc), X.fmul(rad, nlen[f]))
                    if slack[0] <= cl_fx[f][1]:
                        bad = True
                    else:
                        wall_min = min(wall_min, (slack[0] - cl_fx[f][1]) / X.ONE / nlenf[f] + float(clr))
            else:
                # float filter-free exact test: every vertex against every facet
                for f, nz in enumerate(Nz):
                    lo = None
                    for x in XW[i]:
                        dotx = (0, 0)
                        for k, c in nz:
                            dotx = X.fadd(dotx, X.fmul(c, x[k]))
                        if lo is None or dotx[1] > lo:
                            lo = dotx[1]
                    stats['tests'] += len(XW[i])
                    slack = sB[f][0] - lo
                    if slack <= cl_fx[f][1]:
                        bad = True
                    else:
                        wall_min = min(wall_min, (slack - cl_fx[f][1]) / X.ONE / nlenf[f] + float(clr))
            if bad:
                failures.append(('wall', i))

    # ---- (2) separation
    centers = [p.t for p in placed]
    reach = 2 * R_up + clr
    reach2 = reach * reach
    if n > 1 and PP is not None:
        VF = [float_world(p, vfl) for p in placed]
        nfl = PP.facets_float()[0] if PP.nF <= SAT_FACET_LIMIT else None
        NW = [float_normals(p, nfl) for p in placed] if nfl is not None else None
    for i in range(n):
        for j in range(i + 1, n):
            d2 = sum((a - b) ** 2 for a, b in zip(centers[i], centers[j]))
            if d2 > reach2:
                stats['far'] += 1
                gap = math.sqrt(float(d2)) - float(2 * R_up)
                pair_min = min(pair_min, gap)
                continue
            stats['near'] += 1
            if PP is None:                                       # two balls: exact distance
                if not d2 > (1 + clr) ** 2:
                    failures.append(('pair', i, j))
                else:
                    pair_min = min(pair_min, math.sqrt(float(d2)) - 1.0)
                continue
            gap = prove_pair(placed, XW, VF, NW, i, j, clr)
            if gap is None:
                failures.append(('pair', i, j))
            else:
                pair_min = min(pair_min, gap)
    return {'ok': not failures, 'pieces': n, 'tests': stats['tests'], 'near_pairs': stats['near'],
            'far_pairs': stats['far'], 'min_wall_gap': wall_min, 'min_pair_gap': pair_min,
            'failures': failures[:20], 'seconds': round(time.time() - t0, 3)}


def prove_pair(placed, XW, VF, NW, i, j, clr):
    """Proves pieces i and j (both polytopes) strictly separated by an explicit rational plane; returns the gap proved
    along the plane's unit normal (a float lower bound, rounded down) or None. Floating point proposes the directions:
    the line between the centres, the facet normals of both pieces when they have few facets (ranked by their float
    gap), and the direction of the closest points (GJK)."""
    A, B = VF[i], VF[j]

    def gapf(u):
        nu = math.sqrt(sum(x * x for x in u))
        if nu == 0:
            return -math.inf
        pa = [sum(x * y for x, y in zip(u, p)) for p in A]
        pb = [sum(x * y for x, y in zip(u, p)) for p in B]
        return max(min(pb) - max(pa), min(pa) - max(pb)) / nu
    # 1. the line between the centres, 2. the facet normals of both pieces (best float gap first), 3. the closest points
    best = [None]

    def attempt(u, XA, XB):
        r = exact_plane(XA, XB, u)
        if r is None:
            return False
        diff, norm_up = r
        gap, ok = float(Fraction(diff, norm_up)), Fraction(diff) > clr * norm_up      # exact clearance test
        if best[0] is None or (ok, gap) > (best[0][1], best[0][0]):
            best[0] = (gap, ok)
        return ok
    u = [float(b - a) for a, b in zip(placed[i].t, placed[j].t)]
    if gapf(u) > 0 and attempt(u, XW[i], XW[j]):
        return best[0][0]
    if NW is not None:
        scored = sorted(((gapf(u), u) for u in NW[i] + NW[j]), key=lambda t: -t[0])
        for g, u in scored[:2]:
            if g > 0 and attempt(u, XW[i], XW[j]):
                return best[0][0]
    dist, wv = G.closest(A, B)
    if wv is not None and attempt([-x for x in wv], XW[i], XW[j]):
        return best[0][0]
    if best[0] is not None and best[0][1]:
        return best[0][0]
    return None


def exact_plane(XA, XB, u):
    """Rounds u to integers (a unit vector over 10^12) and tests max_A u.x < min_B u.x exactly, then the other way round
    (B below A). Returns (diff, norm_up): the proved min_B u.x - max_A u.x in units of 2^-K and |u| 2^-K rounded up, so
    that the gap along the unit normal is at least diff / norm_up; None when neither side is strictly separated."""
    nu = math.sqrt(sum(x * x for x in u))
    if not nu > 0:
        return None
    uq = [round(x / nu * 10 ** 12) for x in u]
    if not any(uq):
        return None
    norm_up = math.isqrt(sum(a * a for a in uq) << (2 * X.K)) + 1                # |uq| 2^K, rounded up
    for P1, P2 in ((XA, XB), (XB, XA)):
        diff = plane_test(uq, P1, P2)
        if diff > 0:                                  # strictly separated; the gap along the unit normal is diff / norm_up
            return diff, norm_up
    return None


# ------------------------------------------------------------------ command line
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('record')
    ap.add_argument('--clearance', type=float, default=0.0)
    a = ap.parse_args(argv)
    rec = json.load(open(a.record))
    res = certify_config(rec['problem'], rec['config'], a.clearance)
    print(json.dumps(res))
    print('CERTIFIED' if res['ok'] else 'NOT CERTIFIED')
    return 0 if res['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
