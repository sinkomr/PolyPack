"""Rigorous certifier for PolyPack packings on flat tori.

Standard library + mpmath only (no numpy); separate code from the search
(torus_np.py, torus_search.py) and from the TypeScript float validator.
Every inequality that the verdict depends on is decided with mpmath interval
arithmetic (outward rounding, PREC = 128 bits); floats are used only to choose
which separating axis to try first.

Problem (see docs/spaces/TORUS.md):
  P congruent pieces on the torus R^2 / Lambda, Lambda = Z b1 + Z b2.
  N = 0: closed disk of radius 1; N >= 3: regular N-gon of side 1 with pose
  (x, y, theta), vertex k at (x, y) + R (cos a_k, sin a_k),
  a_k = theta + pi/2 + 2 pi k / N, R = 1 / (2 sin(pi/N)).
  Families: sq  Lambda = L Z^2 (score L);
            hex b1 = L (1, 0), b2 = L (1/2, sqrt(3)/2) (score L);
            free any basis (score sqrt|det(b1, b2)|).
  Valid: the interiors of all pieces and all of their lattice translates are
  pairwise disjoint, including a piece and its own nonzero translates.

Certificate (the shrink argument for flat spaces):
  Shrink every piece by s = 1 - eps about its centre and prove, for every
  piece pair (i, j) and every lattice vector lam with (i, lam) != (j, 0), that
  piece i and piece j + lam are STRICTLY separated (positive clearance).
  Scaling the plane by k >= 1/s maps this to a packing of full-size pieces on
  the torus with lattice k Lambda (a similarity; full-size pieces about the
  scaled centres contain nothing but the scaled shrunk pieces... see docs),
  so every score >= score(Lambda)/s is attained by a valid packing. The claim
  `score_cert` is accepted only if it is >= the interval upper bound of
  score(Lambda)/s.

Enumeration bound (proved in the docs): write v = c_j + lam - c_i in the basis,
v = alpha b1 + beta b2. Cramer's rule gives |alpha| <= |v| |b2| / |det| and
|beta| <= |v| |b1| / |det|. If |v| >= 2 s R the bounding disks of the shrunk
pieces have disjoint interiors and (strictly, if >) the pieces are separated.
So only integers m, n with |alpha_0 + m| < 2 s R |b2| / |det| and
|beta_0 + n| < 2 s R |b1| / |det| can matter (alpha_0, beta_0 the coordinates
of c_j - c_i). The certifier enumerates an integer superset of these from
interval bounds, so it never relies on a reduced basis.

Status (check_status, applied to every record of records.json):
  `best_known` or `proven`. `proven` needs a literature entry with status `proven`, a DOI, the
  theorem or section that proves this exact torus case in `proof`, and a value that score_cert
  attains (value <= score_cert <= value (1 + PROVEN_SLACK)). No record may lie below the value of
  any literature entry with status `proven`.

Usage:
  python3 certify_torus.py data/torus/records.json            # verify all records
  python3 certify_torus.py data/torus/records.json --id torus/sq/0/5
"""

import json
import math
import os
import re
import sys

import mpmath
from mpmath import iv

PREC = 128
FAMILIES = ("sq", "hex", "free")
MAX_SIDES = 100
MAX_PIECES = 500
MAX_WINDOW = 1_000_000  # lattice vectors per pair window
MAX_CANDIDATES = 2_000_000  # in total, plus 64 per pair (a window has at least 4 x 4 integers)


class CertError(Exception):
    """The input is malformed or the configuration could not be proven valid."""


def _num(x, name):
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        raise CertError("%s must be a number" % name)
    try:
        xf = float(x)
    except (OverflowError, ValueError):
        raise CertError("%s is not representable as a double" % name)
    if not math.isfinite(xf):
        raise CertError("%s must be finite" % name)
    if isinstance(x, int) and float(xf) != x:
        raise CertError("%s is not exactly representable" % name)
    return xf


def _pos(a):
    """True iff the interval a is certainly > 0."""
    return a.a > 0


def _set_prec():
    """Set working precisions; returns the previous ones for restoring."""
    old = (iv.prec, mpmath.mp.prec)
    iv.prec = PREC
    # interval endpoints are converted to plain mpf for floor/ceil; at 2 * PREC
    # bits that conversion is exact (mpmath's default 53 bits would round)
    mpmath.mp.prec = 2 * PREC
    return old


def lattice_basis(family, lattice):
    """Interval basis vectors (b1, b2) for a lattice description.

    sq/hex: {"L": float}. free: {"b1": [x, y], "b2": [x, y]}.
    """
    if family not in FAMILIES:
        raise CertError("unknown family %r" % (family,))
    if not isinstance(lattice, dict):
        raise CertError("lattice must be an object")
    if family in ("sq", "hex"):
        L = _num(lattice.get("L"), "L")
        if not L > 0:
            raise CertError("L must be positive")
        Li = iv.mpf(L)
        if family == "sq":
            return (Li, iv.mpf(0)), (iv.mpf(0), Li), Li
        h = iv.sqrt(iv.mpf(3)) / 2
        return (Li, iv.mpf(0)), (Li / 2, Li * h), Li
    b1 = lattice.get("b1")
    b2 = lattice.get("b2")
    for b, nm in ((b1, "b1"), (b2, "b2")):
        if not isinstance(b, (list, tuple)) or len(b) != 2:
            raise CertError("%s must be a pair of numbers" % nm)
    v1 = (iv.mpf(_num(b1[0], "b1.x")), iv.mpf(_num(b1[1], "b1.y")))
    v2 = (iv.mpf(_num(b2[0], "b2.x")), iv.mpf(_num(b2[1], "b2.y")))
    det = v1[0] * v2[1] - v1[1] * v2[0]
    if det.a <= 0 <= det.b:
        raise CertError("lattice basis is degenerate (determinant not provably nonzero)")
    return v1, v2, iv.sqrt(abs(det))


def shape_constants(N):
    """Interval (R, r): bounding (circum) radius and inradius; disks: (1, 1)."""
    if N == 0:
        return iv.mpf(1), iv.mpf(1)
    if isinstance(N, bool) or not isinstance(N, int) or N < 3 or N > MAX_SIDES:
        raise CertError("N must be 0 or an integer in [3, %d]" % MAX_SIDES)
    t = iv.pi / N
    return 1 / (2 * iv.sin(t)), 1 / (2 * iv.tan(t))


def _vertices_rel(N, theta, sR):
    """Interval vertex offsets (from the centre) of a shrunk N-gon, CCW."""
    out = []
    th = iv.mpf(theta)
    for k in range(N):
        a = th + iv.pi / 2 + 2 * iv.pi * k / N
        out.append((sR * iv.cos(a), sR * iv.sin(a)))
    return out


def _float_vertices_rel(N, theta, sR):
    out = []
    for k in range(N):
        a = theta + math.pi / 2 + 2 * math.pi * k / N
        out.append((sR * math.cos(a), sR * math.sin(a)))
    return out


class _Piece:
    __slots__ = ("x", "y", "theta", "V", "Vf", "edges")

    def __init__(self, N, pose, sR, sRf):
        if not isinstance(pose, (list, tuple)) or len(pose) != 3:
            raise CertError("each pose must be [x, y, theta]")
        self.x = _num(pose[0], "x")
        self.y = _num(pose[1], "y")
        self.theta = _num(pose[2], "theta")
        self.V = None
        self.Vf = None
        self.edges = None
        if N > 0:
            self.V = _vertices_rel(N, self.theta, sR)
            self.Vf = _float_vertices_rel(N, self.theta, sRf)
            # per edge k: base point p, outward normal n = (e_y, -e_x) and the
            # interval upper bound of max over own vertices of (V - p) . n
            # (0 in exact arithmetic: the polygon lies on the inner side)
            self.edges = []
            for k in range(N):
                p = self.V[k]
                q = self.V[(k + 1) % N]
                n = (q[1] - p[1], p[0] - q[0])
                own = None
                for w in self.V:
                    d = (w[0] - p[0]) * n[0] + (w[1] - p[1]) * n[1]
                    own = d if own is None else iv.mpf([max(own.a, d.a), max(own.b, d.b)])
                self.edges.append((p, n, own.b))


def _axis_proof(owner, other, v_other_minus_owner, k, N):
    """Try edge k of `owner` as a separating axis. Returns clearance lower bound or None.

    other's vertices are W = v + V_other (owner centre at the origin).
    """
    p, n, own_max = owner.edges[k]
    vx, vy = v_other_minus_owner
    lo = None
    for w in other.V:
        d = (vx + w[0] - p[0]) * n[0] + (vy + w[1] - p[1]) * n[1]
        lo = d.a if lo is None or d.a < lo else lo
    if lo > own_max:
        nn = iv.sqrt(n[0] * n[0] + n[1] * n[1])
        gap = (iv.mpf(lo) - iv.mpf(own_max)) / nn.b
        return gap.a
    return None


def _float_axis_gaps(A, B, vf, N):
    """Float SAT gaps for all 2N axes (heuristic ordering only)."""
    gaps = []
    for side, owner, other, sgn in ((0, A, B, 1.0), (1, B, A, -1.0)):
        ox, oy = sgn * vf[0], sgn * vf[1]
        V = owner.Vf
        for k in range(N):
            px, py = V[k]
            qx, qy = V[(k + 1) % N]
            nx, ny = qy - py, px - qx
            nn = math.hypot(nx, ny)
            if not nn > 0 or not math.isfinite(nn):
                # float vertices collapsed (|theta| ~ 1e16): still try this axis, last
                gaps.append((-math.inf, side, k))
                continue
            m = min((ox + wx - px) * nx + (oy + wy - py) * ny for wx, wy in other.Vf)
            gaps.append((m / nn, side, k))
    gaps.sort(key=lambda g: (g[0], -g[1], -g[2]), reverse=True)
    return gaps


def certify(record, eps=None, collect=True):
    """Certify one record. Returns a certificate dict; raises CertError on failure.

    record: {"family", "N", "P", "lattice", "poses", "eps", "score_cert"?}
    eps: overrides record["eps"] when given (the caller must then publish this eps).
    """
    old = _set_prec()
    try:
        return _certify(record, eps, collect)
    finally:
        iv.prec, mpmath.mp.prec = old


def _certify(record, eps, collect):
    if not isinstance(record, dict):
        raise CertError("record must be an object")
    family = record.get("family")
    N = record.get("N")
    P = record.get("P")
    if isinstance(P, bool) or not isinstance(P, int) or P < 1 or P > MAX_PIECES:
        raise CertError("P must be an integer in [1, %d]" % MAX_PIECES)
    if isinstance(N, bool) or not isinstance(N, int):
        raise CertError("N must be an integer")
    R, _r = shape_constants(N)
    poses = record.get("poses")
    if not isinstance(poses, list) or len(poses) != P:
        raise CertError("poses must list exactly P = %d poses" % P)
    if eps is None:
        eps = record.get("eps")
    eps = _num(eps, "eps")
    if not (0 < eps <= 1e-3):
        raise CertError("eps must be in (0, 1e-3]")
    b1, b2, score_iv = lattice_basis(family, record.get("lattice"))
    s = 1 - iv.mpf(eps)
    sR = s * R
    sRf = (1 - eps) * (1.0 if N == 0 else 1.0 / (2 * math.sin(math.pi / N)))
    pieces = [_Piece(N, p, sR, sRf) for p in poses]
    det = b1[0] * b2[1] - b1[1] * b2[0]
    adet = abs(det)
    nb1 = iv.sqrt(b1[0] * b1[0] + b1[1] * b1[1])
    nb2 = iv.sqrt(b2[0] * b2[0] + b2[1] * b2[1])
    rho = 2 * sR  # bounding-disk contact distance of two shrunk pieces
    rho2_hi = (rho * rho).b
    X1 = iv.mpf((rho * nb2 / adet).b)
    X2 = iv.mpf((rho * nb1 / adet).b)
    b1f = (float(mpmath.mpf(b1[0].mid)), float(mpmath.mpf(b1[1].mid)))
    b2f = (float(mpmath.mpf(b2[0].mid)), float(mpmath.mpf(b2[1].mid)))
    max_total = MAX_CANDIDATES + 64 * P * (P + 1) // 2
    explicit = []
    n_disk = 0
    n_cand = 0
    min_clear = None
    for i in range(P):
        A = pieces[i]
        for j in range(i, P):
            Bp = pieces[j]
            dx = iv.mpf(Bp.x) - iv.mpf(A.x)
            dy = iv.mpf(Bp.y) - iv.mpf(A.y)
            al0 = (dx * b2[1] - dy * b2[0]) / det
            be0 = (b1[0] * dy - b1[1] * dx) / det
            # integer superset of the open windows |alpha_0 + m| < X1, |beta_0 + n| < X2,
            # with interval endpoints so that rounding can only widen the range
            # (one extra integer on each side costs little and guards the conversion)
            m_lo = int(mpmath.floor(mpmath.mpf((-al0 - X1).a))) - 1
            m_hi = int(mpmath.ceil(mpmath.mpf((-al0 + X1).b))) + 1
            n_lo = int(mpmath.floor(mpmath.mpf((-be0 - X2).a))) - 1
            n_hi = int(mpmath.ceil(mpmath.mpf((-be0 + X2).b))) + 1
            count = (m_hi - m_lo + 1) * (n_hi - n_lo + 1)
            if count > MAX_WINDOW:
                raise CertError(
                    "enumeration window of %d lattice vectors for pair (%d, %d): nearly degenerate "
                    "basis or coordinates too large for the interval precision" % (count, i, j)
                )
            n_cand += count
            if n_cand > max_total:
                raise CertError("more than %d lattice vectors to examine in total" % max_total)
            for m in range(m_lo, m_hi + 1):
                for n in range(n_lo, n_hi + 1):
                    if i == j and (m < 0 or (m == 0 and n <= 0)):
                        # (0,0) is the piece itself; -lam gives the same image pair
                        continue
                    vx = dx + m * b1[0] + n * b2[0]
                    vy = dy + m * b1[1] + n * b2[1]
                    d2 = vx * vx + vy * vy
                    if d2.a > rho2_hi:
                        n_disk += 1
                        # |v| - rho = (|v|^2 - rho^2) / (|v| + rho) > 0, bounded below rigorously
                        gap = ((iv.mpf(d2.a) - iv.mpf(rho2_hi)) / (iv.sqrt(d2) + rho).b).a
                        if min_clear is None or gap < min_clear:
                            min_clear = gap
                        continue
                    if N == 0:
                        raise CertError(
                            "disks %d and %d + (%d, %d) are not proven separated" % (i, j, m, n)
                        )
                    vf = (
                        float(Bp.x - A.x) + m * b1f[0] + n * b2f[0],
                        float(Bp.y - A.y) + m * b1f[1] + n * b2f[1],
                    )
                    proof = None
                    for _g, side, k in _float_axis_gaps(A, Bp, vf, N):
                        if side == 0:
                            gap = _axis_proof(A, Bp, (vx, vy), k, N)
                        else:
                            gap = _axis_proof(Bp, A, (-vx, -vy), k, N)
                        if gap is not None and gap > 0:
                            proof = (side, k, gap)
                            break
                    if proof is None:
                        raise CertError(
                            "pieces %d and %d + (%d, %d) are not proven separated" % (i, j, m, n)
                        )
                    side, k, gap = proof
                    if min_clear is None or gap < min_clear:
                        min_clear = gap
                    if collect:
                        explicit.append(
                            {
                                "i": i,
                                "j": j,
                                "lam": [m, n],
                                "axis_owner": "i" if side == 0 else "j",
                                "edge": k,
                                "clearance_lb": mpmath.nstr(mpmath.mpf(gap), 6),
                            }
                        )
    if min_clear is None:
        # no image pair within the enumeration window: everything is far apart
        min_clear = iv.mpf(1)
    score_cert_iv = score_iv / s
    cert = {
        "family": family,
        "N": N,
        "P": P,
        "eps": eps,
        "shrink": "pieces scaled by 1 - eps about their centres",
        "interval_precision_bits": PREC,
        "enumeration": {
            "candidates": n_cand,
            "bounding_disk_separated": n_disk,
            "explicit_axis_separated": len(explicit) if collect else None,
            "X1": mpmath.nstr(mpmath.mpf(X1.b), 10),
            "X2": mpmath.nstr(mpmath.mpf(X2.b), 10),
        },
        "min_clearance_lb": mpmath.nstr(mpmath.mpf(min_clear), 8),
        "score_cert_upper": mpmath.nstr(mpmath.mpf(score_cert_iv.b), 25),
        "score_upper_float": _float_up(score_cert_iv.b),
        "explicit": explicit if collect else None,
    }
    claim = record.get("score_cert")
    if claim is not None:
        c = _num(claim, "score_cert")
        if not (iv.mpf(c) >= score_cert_iv.b) is True:
            raise CertError(
                "claimed score_cert %r is below the certified bound %s"
                % (c, mpmath.nstr(mpmath.mpf(score_cert_iv.b), 20))
            )
        cert["score_cert_checked"] = c
    return cert


def _float_up(x):
    """Smallest double >= the mpf x."""
    f = float(mpmath.mpf(x))
    while (iv.mpf(f) < x) is True:
        f = math.nextafter(f, math.inf)
    return f


STATUSES = ("best_known", "proven")
DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")
# score_cert exceeds the configuration's score by the shrink factor 1/(1 - eps), eps <= 1e-9 on the
# build ladder, so a record at a proven optimum has score_cert within this of the optimum.
PROVEN_SLACK = 2e-9


def _finite_positive(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x > 0


def _text(x):
    return isinstance(x, str) and x.strip() != ""


def proof_entry(literature, score_cert):
    """The first literature entry that proves this exact case and that score_cert attains, or None.

    Such an entry has status `proven`, a full citation in `source`, a DOI, the theorem or section
    in `proof`, and a value with value <= score_cert <= value (1 + PROVEN_SLACK).
    """
    if not isinstance(literature, list) or not _finite_positive(score_cert):
        return None
    for e in literature:
        if not isinstance(e, dict) or e.get("status") != "proven":
            continue
        v = e.get("value")
        if not (_finite_positive(v) and _text(e.get("source")) and _text(e.get("proof"))):
            continue
        if not (isinstance(e.get("doi"), str) and DOI_RE.match(e["doi"])):
            continue
        if v <= score_cert <= v * (1 + PROVEN_SLACK):
            return e
    return None


def check_status(rec):
    """Raise CertError unless the record's status and literature obey the rule above."""
    status = rec.get("status")
    if status not in STATUSES:
        raise CertError("unknown status %r" % (status,))
    sc = rec.get("score_cert")
    if not _finite_positive(sc):
        raise CertError("score_cert must be a positive finite number")
    lit = rec.get("literature")
    if lit is None:
        lit = []
    if not isinstance(lit, list) or not all(isinstance(e, dict) for e in lit):
        raise CertError("literature must be a list of objects")
    for e in lit:
        v = e.get("value")
        if e.get("status") == "proven" and _finite_positive(v) and sc < v:
            raise CertError("score_cert %r lies below the proven optimum %r (%s)" % (sc, v, e.get("short")))
    if status == "proven" and proof_entry(lit, sc) is None:
        raise CertError(
            "status proven needs a literature entry with status proven, a DOI, the theorem in `proof` "
            "and a value that score_cert attains"
        )


def record_input(rec):
    """Map a records.json entry to the certifier's input."""
    cfg = rec["configuration"]
    return {
        "family": rec["family"],
        "N": rec["N"],
        "P": rec["P"],
        "lattice": cfg["lattice"],
        "poses": cfg["poses"],
        "eps": rec["eps"],
        "score_cert": rec["score_cert"],
    }


def main(argv):
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("records")
    ap.add_argument("--id", default=None)
    args = ap.parse_args(argv)
    with open(args.records) as f:
        data = json.load(f)
    ok = bad = 0
    for rec in data["records"]:
        if args.id and rec["problem"] != args.id:
            continue
        try:
            cert = certify(record_input(rec), collect=False)
            check_status(rec)
            ok += 1
            print("OK  %-18s score_cert %.12f  min clearance %s  %s" % (rec["problem"], rec["score_cert"], cert["min_clearance_lb"], rec["status"]))
        except Exception as e:  # noqa: BLE001 - report every bad record and continue
            bad += 1
            print("BAD %-18s %s" % (rec.get("problem"), e))
    print("certified %d, failed %d" % (ok, bad))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
