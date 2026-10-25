"""Rigorous certifier for PolyPack packings on the surfaces of Platonic solids.

It decides every inequality exactly (chain topology, disk distances, cone points against
wedges; arithmetic in Q, Q(sqrt 3) or Q(sqrt(10 + 2 sqrt 5))) or with mpmath interval
arithmetic at 128 bits (anything involving a piece angle theta). It shares no code with the
TypeScript validator and search.

What is certified, for a configuration (solid, N, s, poses) and a shrink factor lam = 1 - eps:
the pieces scaled by lam about their centres form a STRICTLY valid packing on the solid of
edge s, in the stated mode. Scaling the whole surface by 1/lam is a similarity, so unit pieces
on the solid of edge s/lam (centres scaled by 1/lam in their face frames) form a valid
packing: score_cert = s / lam, rounded up to a float. display = score_cert rounded to the
nearest at 6 decimals (half to even, from its exact binary64 value): a readable value, not a bound.

nofold: every scaled piece lies in the interior of its anchor face; scaled pieces on one face are
pairwise disjoint.

fold: the development of each scaled piece from its centre (see docs/spaces/SURFACE) satisfies
  (1) the centre lies in the closed anchor face;
  (2) no cone point (vertex of the solid) lies in the scaled piece;
  (3) on each face, the parts of all scaled pieces (two parts of one piece included) are
      pairwise disjoint closed sets.
For disks, (2)-(3) take the equivalent distance form proved in the docs: every vertex is at
surface distance > lam from each centre, every two centres are at surface distance > 2 lam, and
every geodesic loop at a centre is longer than 2 lam.

Witnesses: a pair of parts is separated by a "disk" witness (their bounding disks are disjoint)
or by a Farkas witness: non-negative multipliers on at most three of the half-planes that
describe the two parts, whose combination proves that the half-planes have no common point.
The multipliers are found with floating point (untrusted) and then checked with intervals,
including the residual of the combination, so the check does not rely on exact cancellation.

Usage: python3 cert.py RECORDS.json [--out DIR] [--only ID ...]
"""

import json
import math
import os
import sys
from decimal import ROUND_HALF_EVEN, Decimal
from fractions import Fraction as Fr

from mpmath import iv, mpf

from geom import SOLIDS, get_solid

iv.prec = 128
PREC_BITS = 128
VERSION = "surface-cert 2"
MAX_DEPTH = 200
# Work limits for untrusted input. Real records use at most a few dozen chains per piece; a piece
# far too large for its solid is rejected by the anchor-face cone check before any enumeration.
MAX_CHAINS = 5000
MAX_PIECES = 10000
MAX_ABS = 1e6  # bound on |s|, |x|, |y|, |theta|


class CertError(Exception):
    pass


def ivf(x):
    """Exact interval of a Python float or Fraction."""
    if isinstance(x, Fr):
        return iv.mpf(x.numerator) / x.denominator
    return iv.mpf(x)


def pos(x):
    """x is certainly > 0."""
    return x.a > 0


def sig_down(x, digits=3):
    """Round a positive lower bound down to `digits` significant digits (stays a lower bound)."""
    if not (x > 0) or not math.isfinite(x):
        return x
    e = math.floor(math.log10(x)) - digits + 1
    q = math.floor(x / 10 ** e) * 10 ** e
    return float("%.*g" % (digits, q)) if q <= x else float("%.*g" % (digits, q - 10 ** e))


def round_mults(mults):
    """Multipliers clamped to >= 0 (floats are exact rationals, so the stored witness is exactly
    the one verified). They are not rounded further: a relative change delta in a multiplier
    costs about delta * (piece size) of certified clearance, more than a 1e-12 shrink provides."""
    return [(k, max(float(mu), 0.0)) for k, mu in mults]


def exact_fraction(x, what):
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        raise CertError("%s must be a number" % what)
    if isinstance(x, float) and not math.isfinite(x):
        raise CertError("%s must be finite" % what)
    return Fr(x)


# --------------------------------------------------------------------------- exact plane helpers

def vsub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def seg_dist_sq(c, A, B):
    e = vsub(B, A)
    w = vsub(c, A)
    t = dot(w, e)
    L2 = dot(e, e)
    if t.sign() <= 0:
        return dot(w, w)
    if (t - L2).sign() >= 0:
        v = vsub(c, B)
        return dot(v, v)
    return dot(w, w) - t * t / L2


def in_closed_wedge(lo, hi, v):
    """v in the closed wedge from lo counter-clockwise to hi (angle <= pi)."""
    return cross(lo, v).sign() >= 0 and cross(v, hi).sign() >= 0


def intersect_wedges(W, lo2, hi2):
    """Exact intersection of closed wedges; None unless it has positive width."""
    if W is None:
        nlo, nhi = lo2, hi2
    else:
        lo1, hi1 = W
        if in_closed_wedge(lo1, hi1, lo2):
            nlo = lo2
        elif in_closed_wedge(lo2, hi2, lo1):
            nlo = lo1
        else:
            return None
        if in_closed_wedge(lo1, hi1, hi2):
            nhi = hi2
        elif in_closed_wedge(lo2, hi2, hi1):
            nhi = hi1
        else:
            return None
    cr = cross(nlo, nhi).sign()
    if cr > 0 or (cr == 0 and dot(nlo, nhi).sign() < 0):
        return (nlo, nhi)
    # width 0: one ray through a vertex, which no vertex-avoiding ray follows
    return None


# --------------------------------------------------------------------------- chains

class Node:
    __slots__ = ("face", "T", "W", "entry", "depth", "parent", "run_v", "run_n", "path")

    def __init__(self, face, T, W, entry, depth, parent, run_v, run_n, path):
        self.face = face
        self.T = T
        self.W = W
        self.entry = entry
        self.depth = depth
        self.parent = parent
        self.run_v = run_v
        self.run_n = run_n
        self.path = path


def enumerate_chains(S, s, anchor, c, reach_sq_exact, reach_sq_iv):
    """Every chain a vertex-avoiding ray of length <= reach from c can follow (a superset).

    Prunes only on exact or certified facts: c strictly right of the edge line; segment distance
    certainly > reach; the turn rule; an exact wedge of zero width.
    """
    M = S.M
    root = Node(anchor, S.identity(), None, -1, 0, -1, -1, 0, ())
    out = [root]
    i = 0
    while i < len(out):
        node = out[i]
        i += 1
        if node.depth >= MAX_DEPTH:
            raise CertError("chain depth limit")
        if len(out) > MAX_CHAINS:
            raise CertError("more than %d chains for one piece (piece far too large for the solid)" % MAX_CHAINS)
        verts = [S.apply(node.T, S.frame_vertex(s, k)) for k in range(M)]
        for k in range(M):
            if k == node.entry:
                continue
            A = verts[k]
            B = verts[(k + 1) % M]
            if cross(vsub(B, A), vsub(c, A)).sign() < 0:
                continue  # c strictly beyond this edge's line: no ray from c crosses it outward
            d2 = seg_dist_sq(c, A, B)
            if reach_sq_exact is not None:
                if (d2 - reach_sq_exact).sign() > 0:
                    continue
            elif pos(d2.to_iv() - reach_sq_iv):
                continue
            run_v, run_n = -1, 0
            if node.entry >= 0:
                local = None
                if k == (node.entry + 1) % M:
                    local = k
                elif k == (node.entry - 1) % M:
                    local = node.entry
                if local is not None:
                    run_v = S.faces[node.face][local]
                    run_n = node.run_n + 1 if run_v == node.run_v else 1
                    # faces passed around one vertex: run_n * (M - 2) pi / M must stay below pi
                    if run_n * (M - 2) >= M:
                        continue
            lo = vsub(A, c)
            hi = vsub(B, c)
            if (lo[0].is_zero() and lo[1].is_zero()) or (hi[0].is_zero() and hi[1].is_zero()):
                raise CertError("a piece centre is at a vertex")
            W = intersect_wedges(node.W, lo, hi)
            if W is None:
                continue
            g, l, G = S.glue(s, node.face, k)
            out.append(Node(g, S.compose(node.T, G), W, l, node.depth + 1, i - 1, run_v, run_n,
                            node.path + ((node.face, k),)))
    return out


# --------------------------------------------------------------------------- configuration

class Config:
    def __init__(self, rec):
        if not isinstance(rec, dict):
            raise CertError("a record must be a JSON object")
        self.id = rec.get("id")
        self.solid = rec.get("solid")
        self.mode = rec.get("mode")
        self.N = rec.get("N")
        self.P = rec.get("P")
        if self.mode not in ("fold", "nofold"):
            raise CertError("mode must be fold or nofold")
        if not (isinstance(self.N, int) and not isinstance(self.N, bool) and (self.N == 0 or 3 <= self.N <= 100)):
            raise CertError("N must be 0 or an integer 3..100")
        if not (isinstance(self.P, int) and not isinstance(self.P, bool) and 1 <= self.P <= MAX_PIECES):
            raise CertError("P must be an integer 1..%d" % MAX_PIECES)
        if not (isinstance(self.solid, str) and self.solid in SOLIDS):
            raise CertError("unknown solid %r" % (self.solid,))
        self.S = get_solid(self.solid)
        self.s = exact_fraction(rec.get("s"), "s")
        if not (0 < self.s <= MAX_ABS):
            raise CertError("s must be in (0, %g]" % MAX_ABS)
        pieces = rec.get("pieces")
        if not isinstance(pieces, list):
            raise CertError("pieces must be a list")
        if len(pieces) != self.P:
            raise CertError("expected %d pieces, got %d" % (self.P, len(pieces)))
        self.poses = []
        for i, p in enumerate(pieces):
            if not isinstance(p, dict):
                raise CertError("piece %d is not an object" % i)
            f = p.get("face")
            if not (isinstance(f, int) and not isinstance(f, bool) and 0 <= f < self.S.F):
                raise CertError("piece %d: face out of range" % i)
            x = exact_fraction(p.get("x"), "x")
            y = exact_fraction(p.get("y"), "y")
            th = exact_fraction(p.get("theta", 0.0), "theta")
            if max(abs(x), abs(y), abs(th)) > MAX_ABS:
                raise CertError("piece %d: coordinate beyond %g" % (i, MAX_ABS))
            self.poses.append((f, x, y, th))


def face_constraints(S, s):
    """Exact half-planes a.x <= b of the face polygon in its frame (outward normals)."""
    out = []
    for j in range(S.M):
        A = S.frame_vertex(s, j)
        B = S.frame_vertex(s, j + 1)
        e = vsub(B, A)
        a = (e[1], -e[0])
        out.append((a, dot(a, A)))
    return out


def piece_radii(N):
    """(circumradius, inradius) as intervals, and exact circumradius^2 when rational."""
    if N == 0:
        return iv.mpf(1), iv.mpf(1), Fr(1)
    R = 1 / (2 * iv.sin(iv.pi / N))
    r = 1 / (2 * iv.tan(iv.pi / N))
    R2 = {3: Fr(1, 3), 4: Fr(1, 2), 6: Fr(1)}.get(N)
    return R, r, R2


# --------------------------------------------------------------------------- polygon parts

class PartData:
    """One part: half-planes (intervals) in its face's frame, plus floats for the witness search."""

    __slots__ = ("piece", "chain", "face", "c_iv", "rho", "cons", "fcons", "poly", "labels")


def build_part(S, s, N, lam, R_iv, r_iv, c, theta, node, piece, chain):
    Tinv = S.inverse(node.T)
    cF = S.apply(Tinv, c)
    cx, cy = cF[0].to_iv(), cF[1].to_iv()
    thF = ivf(theta) - node.T.j * iv.pi / S.unit_angle_den
    lam_iv = ivf(lam)
    cons = []
    for k in range(N):
        phi = thF + iv.pi / 2 + iv.pi / N + 2 * iv.pi * k / N
        ax, ay = iv.cos(phi), iv.sin(phi)
        cons.append((("P", k), ax, ay, ax * cx + ay * cy + lam_iv * r_iv))
    if node.W is not None:
        lo = S.rotate(Tinv.j, node.W[0])
        hi = S.rotate(Tinv.j, node.W[1])
        a1 = (lo[1], -lo[0])
        a2 = (-hi[1], hi[0])
        cons.append((("W", 0), a1[0].to_iv(), a1[1].to_iv(), dot(a1, cF).to_iv()))
        cons.append((("W", 1), a2[0].to_iv(), a2[1].to_iv(), dot(a2, cF).to_iv()))
    p = PartData()
    p.piece, p.chain, p.face = piece, chain, node.face
    p.c_iv = (cx, cy)
    p.rho = lam_iv * R_iv
    p.cons = cons
    # float polygon for the (untrusted) witness search
    cfx, cfy = float(cx.mid), float(cy.mid)
    thf = float(thF.mid)
    Rf = float(lam) * float(R_iv.mid)
    poly = []
    labels = []
    for k in range(N):
        a = thf + math.pi / 2 + 2 * math.pi * k / N
        poly.append((cfx + Rf * math.cos(a), cfy + Rf * math.sin(a)))
        labels.append(("P", k))
    p.poly, p.labels = poly, labels
    return p


def clip(poly, labels, a, b, label):
    """Sutherland-Hodgman clip of a convex float polygon by a.x <= b, keeping edge labels."""
    n = len(poly)
    if n == 0:
        return poly, labels
    out, lab = [], []
    for i in range(n):
        P = poly[i]
        Q = poly[(i + 1) % n]
        dp = a[0] * P[0] + a[1] * P[1] - b
        dq = a[0] * Q[0] + a[1] * Q[1] - b
        if dp <= 0:
            out.append(P)
            lab.append(labels[i])
            if dq > 0:
                t = dp / (dp - dq)
                out.append((P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])))
                lab.append(label)
        elif dq < 0:
            t = dp / (dp - dq)
            out.append((P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])))
            lab.append(labels[i])
    if len(out) < 3:
        return [], []
    return out, lab


def float_cons(cons):
    return [(lab, float(ax.mid), float(ay.mid), float(b.mid)) for lab, ax, ay, b in cons]


def clip_part(p, fcons_face):
    poly, labels = p.poly, p.labels
    for lab, ax, ay, b in float_cons(p.cons):
        if lab[0] == "W":
            poly, labels = clip(poly, labels, (ax, ay), b, lab)
    for lab, ax, ay, b in fcons_face:
        poly, labels = clip(poly, labels, (ax, ay), b, lab)
    p.poly, p.labels = poly, labels


def farkas_value(cons, mults, center, rho):
    """Interval lower bound proving infeasibility when > 0 (see module docstring).

    For x in the intersection: sum mu_k (a_k.x - b_k) <= 0, i.e. r.x <= beta with r = sum mu a.
    Every x of the parts also lies in the disk (center, rho), so r.x >= r.center - |r| rho.
    Hence r.center - |r| rho - beta > 0 means the intersection is empty.
    """
    rx = iv.mpf(0)
    ry = iv.mpf(0)
    beta = iv.mpf(0)
    for idx, mu in mults:
        _, ax, ay, b = cons[idx]
        m = iv.mpf(mu)
        rx += m * ax
        ry += m * ay
        beta += m * b
    norm = iv.sqrt(rx ** 2 + ry ** 2)
    return rx * center[0] + ry * center[1] - norm * rho - beta


def solve2(a, b, rhs):
    det = a[0] * b[1] - a[1] * b[0]
    if abs(det) < 1e-300:
        return None
    return ((rhs[0] * b[1] - rhs[1] * b[0]) / det, (a[0] * rhs[1] - a[1] * rhs[0]) / det)


def sat_witness(PA, LA, PB, LB, idxA, idxB, fl):
    """Float SAT on two labelled polygons -> Farkas multipliers over constraint indices."""
    best = None
    for (P, L, Q, LQ, iP, iQ) in ((PA, LA, PB, LB, idxA, idxB), (PB, LB, PA, LA, idxB, idxA)):
        n = len(P)
        for e in range(n):
            lab = L[e]
            k = iP[lab]
            _, ax, ay, b = fl[k]
            nrm = math.hypot(ax, ay)
            # support of Q in direction -a: smallest a.q
            jmin = min(range(len(Q)), key=lambda j: ax * Q[j][0] + ay * Q[j][1])
            sep = (ax * Q[jmin][0] + ay * Q[jmin][1] - b) / nrm
            if best is None or sep > best[0]:
                best = (sep, k, jmin, LQ, iQ, Q)
    sep, k, j, LQ, iQ, Q = best
    m = len(Q)
    # the two edges of Q at vertex j: incoming (j-1) and outgoing (j)
    k1 = iQ[LQ[(j - 1) % m]]
    k2 = iQ[LQ[j]]
    _, ax, ay, _b = fl[k]
    _, a1x, a1y, _ = fl[k1]
    _, a2x, a2y, _ = fl[k2]
    sol = solve2((a1x, a1y), (a2x, a2y), (-ax, -ay))
    cands = []
    if sol and sol[0] >= -1e-12 and sol[1] >= -1e-12:
        cands.append([(k, 1.0), (k1, max(sol[0], 0.0)), (k2, max(sol[1], 0.0))])
    # edge-to-edge contact: one opposite edge alone
    for kk in (k1, k2):
        _, bx, by, _ = fl[kk]
        if ax * bx + ay * by < 0:
            cands.append([(k, 1.0), (kk, math.hypot(ax, ay) / math.hypot(bx, by))])
    return sep, cands


def brute_witness(fl, center, rho, limit=None):
    """Best float Farkas candidate over all pairs and triples (fallback)."""
    n = len(fl)
    best = (-math.inf, None)
    cx, cy = center
    idx = range(n) if limit is None else limit

    def score(mults):
        rx = sum(m * fl[k][1] for k, m in mults)
        ry = sum(m * fl[k][2] for k, m in mults)
        beta = sum(m * fl[k][3] for k, m in mults)
        nm = sum(m * math.hypot(fl[k][1], fl[k][2]) for k, m in mults)
        return (rx * cx + ry * cy - math.hypot(rx, ry) * rho - beta) / nm

    idx = list(idx)
    for ii, i in enumerate(idx):
        ai = fl[i]
        for jj in range(ii + 1, len(idx)):
            j = idx[jj]
            aj = fl[j]
            if ai[1] * aj[1] + ai[2] * aj[2] < 0:
                m = [(i, 1.0), (j, math.hypot(ai[1], ai[2]) / math.hypot(aj[1], aj[2]))]
                v = score(m)
                if v > best[0]:
                    best = (v, m)
            for kk in range(jj + 1, len(idx)):
                k = idx[kk]
                ak = fl[k]
                m1 = aj[1] * ak[2] - aj[2] * ak[1]
                m2 = ak[1] * ai[2] - ak[2] * ai[1]
                m3 = ai[1] * aj[2] - ai[2] * aj[1]
                if m1 >= 0 and m2 >= 0 and m3 >= 0:
                    pass
                elif m1 <= 0 and m2 <= 0 and m3 <= 0:
                    m1, m2, m3 = -m1, -m2, -m3
                else:
                    continue
                if m1 + m2 + m3 <= 0:
                    continue
                m = [(i, m1), (j, m2), (k, m3)]
                v = score(m)
                if v > best[0]:
                    best = (v, m)
    return best


# --------------------------------------------------------------------------- certification

def parse_eps(eps):
    """eps as an exact Fraction in (0, 1): a decimal string such as "1e-12", or a finite float."""
    if isinstance(eps, bool) or not isinstance(eps, (str, int, float)):
        raise CertError("eps must be a decimal string or a number")
    try:
        eps_fr = Fr(eps)
    except (ValueError, ZeroDivisionError, OverflowError):
        raise CertError("eps %r is not a finite number" % (eps,))
    if not (0 < eps_fr < 1):
        raise CertError("eps must be in (0, 1)")
    return eps_fr


def certified_score(s, eps):
    """(score_cert, display) for edge s and shrink eps: s / (1 - eps) rounded up to a float, and
    score_cert rounded to the nearest at 6 decimals (see display_6)."""
    score = exact_fraction(s, "s") / (1 - parse_eps(eps))
    sc = float(score)
    if Fr(sc) < score:
        sc = math.nextafter(sc, math.inf)
    return sc, display_6(sc)


def certify(rec, eps):
    """Certify one record at shrink eps (a decimal string or float). Returns a certificate dict."""
    cfg = Config(rec)
    eps_fr = parse_eps(eps)
    lam = 1 - eps_fr
    if cfg.mode == "nofold":
        body = certify_nofold(cfg, lam)
    else:
        body = certify_fold(cfg, lam)
    sc, disp = certified_score(rec.get("s"), eps)
    cert = {
        "certifier": VERSION,
        "precision_bits": PREC_BITS,
        "id": cfg.id,
        "solid": cfg.solid,
        "mode": cfg.mode,
        "N": cfg.N,
        "P": cfg.P,
        "s": rec.get("s"),
        "eps": str(eps),
        "lambda": "%d/%d" % (lam.numerator, lam.denominator),
        "score_cert": sc,
        "display": disp,
    }
    cert.update(body)
    return cert


def display_6(x):
    """PolyPack's display rule for every space: the exact binary64 value of x rounded to the nearest
    at 6 decimals, ties to even, always 6 decimals (2.000000000002 -> "2.000000")."""
    return str(Decimal(x).quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN))


def centre_in_face(S, s, c):
    for a, b in face_constraints(S, s):
        if (dot(a, c) - b).sign() > 0:
            return False
    return True


def certify_nofold(cfg, lam):
    S, s, N = cfg.S, cfg.s, cfg.N
    F = S.field
    fc = face_constraints(S, s)
    fc_iv = [((a[0].to_iv(), a[1].to_iv()), b.to_iv()) for a, b in fc]
    R_iv, r_iv, _ = piece_radii(N)
    lam_iv = ivf(lam)
    walls = []
    pairs = []
    by_face = {}
    for i, (f, x, y, th) in enumerate(cfg.poses):
        by_face.setdefault(f, []).append(i)
        if N == 0:
            c = (F(x), F(y))
            worst = None
            for j, (a, b) in enumerate(fc):
                gap = b - dot(a, c)  # = |a| * distance to the edge line, exact
                if gap.sign() <= 0 or (gap * gap - lam * lam * dot(a, a)).sign() <= 0:
                    raise CertError("disk %d is not strictly inside face %d (edge %d)" % (i, f, j))
                g = float(gap) / math.sqrt(float(dot(a, a))) - float(lam)
                worst = g if worst is None else min(worst, g)
            walls.append(sig_down(worst))
        else:
            worst = None
            cx, cy = ivf(x), ivf(y)
            for k in range(N):
                ang = ivf(th) + iv.pi / 2 + 2 * iv.pi * k / N
                vx = cx + lam_iv * R_iv * iv.cos(ang)
                vy = cy + lam_iv * R_iv * iv.sin(ang)
                for j, ((ax, ay), b) in enumerate(fc_iv):
                    gap = b - (ax * vx + ay * vy)
                    if not pos(gap):
                        raise CertError("piece %d vertex %d is not strictly inside face %d (edge %d)" % (i, k, f, j))
                    g = float(gap.a) / math.hypot(float(ax.mid), float(ay.mid))
                    worst = g if worst is None else min(worst, g)
            walls.append(sig_down(worst))
    for f, ids in by_face.items():
        for u in range(len(ids)):
            for v in range(u + 1, len(ids)):
                i, j = ids[u], ids[v]
                pi, pj = cfg.poses[i], cfg.poses[j]
                if N == 0:
                    d = (F(pi[1] - pj[1]), F(pi[2] - pj[2]))
                    gap = dot(d, d) - 4 * lam * lam
                    if gap.sign() <= 0:
                        raise CertError("disks %d and %d are not strictly separated" % (i, j))
                    pairs.append([f, i, j, "dist", sig_down(float(gap))])
                    continue
                parts = []
                for idx, pp in ((i, pi), (j, pj)):
                    node = Node(f, S.identity(), None, -1, 0, -1, -1, 0, ())
                    parts.append(build_part(S, s, N, lam, R_iv, r_iv, (F(pp[1]), F(pp[2])), pp[3], node, idx, 0))
                pairs.append(certify_pair(parts[0], parts[1], [], f))
    return {"wall_clearance_min": min(walls), "pairs": pairs, "summary": {"pairs": len(pairs), "walls": len(walls)}}


def certify_pair(A, B, fcons_iv, face):
    """Certify that parts A and B (same face) are disjoint; returns the witness row."""
    dx = A.c_iv[0] - B.c_iv[0]
    dy = A.c_iv[1] - B.c_iv[1]
    if pos(dx ** 2 + dy ** 2 - (A.rho + B.rho) ** 2):
        return [face, A.piece, A.chain, B.piece, B.chain, "disk"]
    cons, owner = [], []
    idxA, idxB = {}, {}
    for c in A.cons:
        idxA[c[0]] = len(cons)
        cons.append(c)
        owner.append("A")
    for c in B.cons:
        idxB[c[0]] = len(cons)
        cons.append(c)
        owner.append("B")
    for c in fcons_iv:
        idxA[c[0]] = idxB[c[0]] = len(cons)
        cons.append(c)
        owner.append("F")
    fl = float_cons(cons)
    cands = []
    if A.poly and B.poly:
        _, cands = sat_witness(A.poly, A.labels, B.poly, B.labels, idxA, idxB, fl)
    centre_f = (float(A.c_iv[0].mid), float(A.c_iv[1].mid))
    for mults in cands:
        mults = round_mults(mults)
        v = farkas_value(cons, mults, A.c_iv, A.rho)
        if pos(v):
            return [face, A.piece, A.chain, B.piece, B.chain, "farkas", witness_rows(cons, owner, mults), sig_down(float(v.a))]
    best = brute_witness(fl, centre_f, float(A.rho.mid))
    if best[1] is not None:
        mults = round_mults(best[1])
        v = farkas_value(cons, mults, A.c_iv, A.rho)
        if pos(v):
            return [face, A.piece, A.chain, B.piece, B.chain, "farkas", witness_rows(cons, owner, mults), sig_down(float(v.a))]
    raise CertError("could not separate piece %d (chain %d) and piece %d (chain %d) on face %d" % (A.piece, A.chain, B.piece, B.chain, face))


def witness_rows(cons, owner, mults):
    """Readable witness: owner (A, B or F for the face), constraint label and multiplier."""
    return [[owner[k], cons[k][0][0], cons[k][0][1], mu] for k, mu in mults]


def certify_fold(cfg, lam):
    S, s, N = cfg.S, cfg.s, cfg.N
    F = S.field
    for i, (f, x, y, th) in enumerate(cfg.poses):
        if not centre_in_face(S, s, (F(x), F(y))):
            raise CertError("centre of piece %d is outside its face %d" % (i, f))
    if N == 0:
        return certify_fold_disks(cfg, lam)
    R_iv, r_iv, R2 = piece_radii(N)
    reach_exact = F(lam * lam * R2) if R2 is not None else None
    reach_iv = (ivf(lam) * R_iv) ** 2
    fc = face_constraints(S, s)
    fcons_iv = [(("F", j), a[0].to_iv(), a[1].to_iv(), b.to_iv()) for j, (a, b) in enumerate(fc)]
    fcons_fl = float_cons(fcons_iv)
    by_face = {}
    cone_rows = []
    empty_rows = []
    chain_counts = []
    for i, (f, x, y, th) in enumerate(cfg.poses):
        c = (F(x), F(y))
        # quick reject before any enumeration: the anchor face's own vertices (root chain)
        root = Node(f, S.identity(), None, -1, 0, -1, -1, 0, ())
        root_part = build_part(S, s, N, lam, R_iv, r_iv, c, th, root, i, 0)
        for k in range(S.M):
            vF = S.frame_vertex(s, k)
            vx, vy = vF[0].to_iv(), vF[1].to_iv()
            if not any(pos(ax * vx + ay * vy - b) for lab, ax, ay, b in root_part.cons if lab[0] == "P"):
                raise CertError("cone point %d of face %d may lie in piece %d (anchor face)" % (k, f, i))
        nodes = enumerate_chains(S, s, f, c, reach_exact, reach_iv)
        chain_counts.append(len(nodes))
        worst_cone = None
        for ci, node in enumerate(nodes):
            part = build_part(S, s, N, lam, R_iv, r_iv, c, th, node, i, ci)
            # (2) cone points: every vertex of this face, unless outside the closed wedge
            for k in range(S.M):
                V = S.apply(node.T, S.frame_vertex(s, k))
                if node.W is not None and not in_closed_wedge(node.W[0], node.W[1], vsub(V, c)):
                    continue
                vF = S.frame_vertex(s, k)
                vx, vy = vF[0].to_iv(), vF[1].to_iv()
                best = None
                for lab, ax, ay, b in part.cons:
                    if lab[0] != "P":
                        continue
                    g = ax * vx + ay * vy - b
                    if best is None or g.a > best[1].a:
                        best = (lab[1], g)
                if not pos(best[1]):
                    raise CertError("cone point %d of face %d may lie in piece %d (chain %d)" % (k, node.face, i, ci))
                gl = sig_down(float(best[1].a))
                worst_cone = gl if worst_cone is None else min(worst_cone, gl)
            # parts: drop certified-empty ones
            clip_part(part, fcons_fl)
            if not part.poly:
                cons = part.cons + fcons_iv
                best = brute_witness(float_cons(cons), (float(part.c_iv[0].mid), float(part.c_iv[1].mid)), float(part.rho.mid))
                if best[1] is not None:
                    mults = round_mults(best[1])
                    v = farkas_value(cons, mults, part.c_iv, part.rho)
                    if pos(v):
                        empty_rows.append([node.face, i, ci, [[cons[k][0][0], cons[k][0][1], mu] for k, mu in mults], sig_down(float(v.a))])
                        continue
                # not certified empty: keep it as a (possibly tiny) part
            by_face.setdefault(node.face, []).append(part)
        cone_rows.append([i, worst_cone])
    pairs = []
    for f, plist in sorted(by_face.items()):
        for u in range(len(plist)):
            for v in range(u + 1, len(plist)):
                pairs.append(certify_pair(plist[u], plist[v], fcons_iv, f))
    return {
        "chains": chain_counts,
        "cone": cone_rows,
        "empty_parts": empty_rows,
        "pairs": pairs,
        "summary": {"chains": sum(chain_counts), "parts": sum(len(v) for v in by_face.values()),
                    "pairs": len(pairs), "farkas_pairs": sum(1 for p in pairs if p[5] == "farkas"),
                    "empty_parts": len(empty_rows)},
    }


def certify_fold_disks(cfg, lam):
    """Disks: exact distance form. Every quantity here is exact (no intervals)."""
    S, s = cfg.S, cfg.s
    F = S.field
    reach_sq = F(4 * lam * lam)
    lam_sq = lam * lam
    nodes_all = []
    cone_rows = []
    pair_rows = []
    loop_rows = []
    centres = [(F(x), F(y)) for (_, x, y, _) in cfg.poses]
    for i, (f, x, y, th) in enumerate(cfg.poses):
        c = centres[i]
        # quick reject before any enumeration: the anchor face's own vertices
        for k in range(S.M):
            d = vsub(S.frame_vertex(s, k), c)
            if (dot(d, d) - lam_sq).sign() <= 0:
                raise CertError("cone point %d of face %d is within lam of disk %d (anchor face)" % (k, f, i))
        nodes = enumerate_chains(S, s, f, c, reach_sq, None)
        nodes_all.append(nodes)
        worst = None
        for ci, node in enumerate(nodes):
            for k in range(S.M):
                V = S.apply(node.T, S.frame_vertex(s, k))
                d = vsub(V, c)
                if node.W is not None and not in_closed_wedge(node.W[0], node.W[1], d):
                    continue
                g = dot(d, d) - lam_sq
                if g.sign() <= 0:
                    raise CertError("cone point %d of face %d is within lam of disk %d (chain %d)" % (k, node.face, i, ci))
                gf = sig_down(float(g))
                worst = gf if worst is None else min(worst, gf)
        cone_rows.append([i, worst])
    for i in range(cfg.P):
        c = centres[i]
        for j in range(i, cfg.P):
            fq = cfg.poses[j][0]
            q = centres[j]
            n_checked = 0
            worst = None
            for ci, node in enumerate(nodes_all[i]):
                if node.face != fq or (i == j and ci == 0):
                    continue
                qq = S.apply(node.T, q)
                d = vsub(qq, c)
                if node.W is not None and not in_closed_wedge(node.W[0], node.W[1], d):
                    continue
                g = dot(d, d) - reach_sq
                if g.sign() <= 0:
                    what = "disk %d wraps onto itself" % i if i == j else "disks %d and %d overlap" % (i, j)
                    raise CertError("%s (chain %d)" % (what, ci))
                n_checked += 1
                gf = sig_down(float(g))
                worst = gf if worst is None else min(worst, gf)
            if n_checked:
                (loop_rows if i == j else pair_rows).append([i, j, n_checked, worst])
    return {
        "chains": [len(n) for n in nodes_all],
        "cone": cone_rows,
        "pairs": pair_rows,
        "loops": loop_rows,
        "summary": {"chains": sum(len(n) for n in nodes_all), "pair_images": sum(r[2] for r in pair_rows),
                    "loop_images": sum(r[2] for r in loop_rows)},
    }


RECORD_FIELDS = ("id", "solid", "mode", "N", "P", "s", "score_float", "score_cert", "display", "eps", "pieces")


def published_errors(rec):
    """Problems with a record's published fields, checked without certifying (exact arithmetic):
    the id matches solid/mode/N/P, s == score_float, and score_cert and display are exactly the
    values that the certified statement at the stored eps gives (s / (1 - eps) rounded up to a
    float, and that float rounded to the nearest at 6 decimals)."""
    if not isinstance(rec, dict):
        return ["a record must be a JSON object"]
    errs = ["missing field %s" % f for f in RECORD_FIELDS if f not in rec]
    if errs:
        return errs
    try:
        want = "surface/%s/%s/%d/%d" % (rec["solid"], rec["mode"], rec["N"], rec["P"])
    except (TypeError, ValueError):
        return ["solid, mode, N, P have the wrong types"]
    if rec["id"] != want:
        errs.append("id %r does not match its fields (%s)" % (rec["id"], want))
    s, sf = rec["s"], rec["score_float"]
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)  # noqa: E731 (JSON may store 2 for 2.0)
    if not (num(s) and num(sf) and s == sf):
        errs.append("score_float %r differs from s %r" % (sf, s))
    try:
        sc, disp = certified_score(s, rec["eps"])
    except CertError as e:
        return errs + [str(e)]
    if rec["score_cert"] != sc or isinstance(rec["score_cert"], bool):
        errs.append("score_cert %r is not s/(1-eps) rounded up (%r)" % (rec["score_cert"], sc))
    if rec["display"] != disp:
        errs.append("display %r is not score_cert rounded to 6 decimals (%s)" % (rec["display"], disp))
    return errs


def check_record(rec):
    """Records mode: the published fields are consistent, and the configuration is certified at the
    stored eps with exactly the published score_cert and display. Raises CertError otherwise."""
    errs = published_errors(rec)
    if errs:
        raise CertError("; ".join(errs))
    cert = certify(rec, rec["eps"])
    if cert["score_cert"] != rec["score_cert"] or cert["display"] != rec["display"]:
        raise CertError("certified %r (%s) but the record says %r (%s)" % (
            cert["score_cert"], cert["display"], rec["score_cert"], rec["display"]))
    return cert


def check_records(recs, out=None, only=None, log=print):
    """Check every record; any failure (including malformed input) is reported, never raised."""
    ok = bad = 0
    if not isinstance(recs, list):
        log("FAIL the file has no list of records")
        return 0, 1
    for rec in recs:
        rid = rec.get("id") if isinstance(rec, dict) else None
        if only and rid not in only:
            continue
        try:
            cert = check_record(rec)
            if out:
                name = str(rid).replace("/", "_") + ".json"
                with open(os.path.join(out, name), "w") as fh:
                    json.dump(cert, fh, separators=(",", ":"))
            ok += 1
            log("OK   %s %s" % (rid, cert["display"]))
        except CertError as e:
            bad += 1
            log("FAIL %s %s" % (rid, e))
        except Exception as e:  # malformed input must not stop the run
            bad += 1
            log("FAIL %s internal error %s: %s" % (rid, type(e).__name__, e))
    return ok, bad


def main(argv):
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("records")
    ap.add_argument("--out", default=None, help="directory for certificate files")
    ap.add_argument("--only", nargs="*", default=None)
    args = ap.parse_args(argv)
    with open(args.records) as fh:
        data = json.load(fh)
    recs = data.get("records") if isinstance(data, dict) else data
    ok, bad = check_records(recs, args.out, args.only)
    print("certified %d, failed %d" % (ok, bad))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
