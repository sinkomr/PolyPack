"""Independent rigorous certifier for PolyPack whole-sphere packings sphere/N/P.

Separate code from the search (python/sphere/search.py, numpy) and from the TypeScript validator.
Uses only the standard library and mpmath interval arithmetic (iv, 256 bits, outward rounding).
Transcendental quantities (pi, cos, sin) come from python/curved/rigorous.py (imported read-only;
power series with explicit remainder bounds, so only interval +, -, *, / and sqrt are trusted).

Model (re-derived here; same conventions as packages/sphere and docs/spaces/SPHERE.md):
  * Unit sphere in R^3; the problem sphere of radius rho is scaled to radius 1, so a piece has
    angular size a = 1/rho (polygon side angle; disk angular radius).
  * Standard N-gon: centre e3, vertex k = (sin R cos phi_k, sin R sin phi_k, cos R),
    phi_k = pi/2 + 2 pi k/N, sin(a/2) = sin R sin(pi/N); it exists (convex, R < pi/2) iff
    sin(a/2) < sin(pi/N).
  * Pose: quaternion q = (w, x, y, z) != 0, read as exact dyadic rationals; the rotation matrix
    H(q)/|q|^2 (entries quadratic in q) is EXACTLY orthogonal for every nonzero q.

What is proved, all strictly (so the closed pieces are pairwise disjoint, clearance > 0):
  * disks:   c_i . c_j < cos 2a = 1 - 2 sin^2 a, with 2a < pi  (angle between centres > 2a);
  * polygons, for every pair, one of
      (far)     c_i . c_j < cos 2R = 1 - 2 sin^2 R: the circumscribed caps (radius R < pi/2,
                convex, containing the convex polygon) are disjoint;
      (plane)   a vector n with n . x > 0 for every vertex x of one piece and n . y < 0 for every
                vertex y of the other: the cone over a convex spherical polygon in an open
                hemisphere is the conic hull of its vertices, so the plane n . v = 0 strictly
                separates the two cones (they meet only at 0). n may come from anywhere (stored
                witness or a float heuristic); only the sign test is trusted.
Malformed input (wrong P, NaN, inf, N outside {0, 3, 4, 5, 6, 8}, rho <= 0, zero quaternion,
non-existent piece, non-object records or fields) is rejected; nothing ever raises.

Published records (certify_record, and the command line) are also checked for their own consistency:
id = sphere/N/P (optionally followed by #tag), config present, score_cert equal to config.rho,
display = score_cert rounded up at 6 decimals, 0 < score_float <= score_cert, status in
{best_known, proven}, and 'proven' only with a cited proof (literature.proof, a non-empty list of
references). Every record in the file is counted; any failure gives exit status 1.

Usage:  python3 python/sphere/certify.py data/sphere/records.json [--out data/sphere/certification.json]
"""
import json
import math
import os
import re
import sys
import time
from fractions import Fraction

from mpmath import iv

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from rig import rg  # noqa: E402  (python/curved/rigorous.py, loaded read-only by explicit path)

I = rg.I


class CertError(Exception):
    pass


def _num(v, what):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise CertError(f"{what} must be a number")
    if isinstance(v, float) and not math.isfinite(v):
        raise CertError(f"{what} must be finite")
    return Fraction(v)


SUPPORTED_N = (0, 3, 4, 5, 6, 8)  # the problem set of docs/spaces/SPHERE.md
STATUSES = ("best_known", "proven")
ID_TAG = re.compile(r"[A-Za-z0-9_.-]{1,32}")  # allowed suffix after '#' in a record id


def _shape(N):
    if isinstance(N, bool) or not isinstance(N, int):
        raise CertError("N must be an integer")
    if N not in SUPPORTED_N:
        raise CertError("N must be one of 0, 3, 4, 5, 6, 8")
    return N


def _posint(P):
    if isinstance(P, bool) or not isinstance(P, int) or P < 1:
        raise CertError("P must be a positive integer")
    return P


def display_up(x):
    """Score rounded UP at 6 decimals, as a string (exact: x is read as its binary64 value)."""
    f = Fraction(x)
    n = math.ceil(f * 10 ** 6)
    if n < 0:
        raise CertError("negative score")
    return f"{n // 10 ** 6}.{n % 10 ** 6:06d}"


# ---------------------------------------------------------------- interval geometry

def rot_matrix(q):
    """Exact rational rotation matrix of q (list of 4 Fractions), as intervals."""
    w, x, y, z = q
    n = w * w + x * x + y * y + z * z
    if n == 0:
        raise CertError("zero quaternion")
    H = [
        [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
    ]
    return [[I(h / n) for h in row] for row in H]


def matvec(M, v):
    return [M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2] for r in range(3)]


def dot(u, v):
    return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]


class Piece:
    """Interval data of the standard polygon (N >= 3) at side angle a (an interval)."""

    def __init__(self, N, a):
        self.N = N
        pi = rg.pi_iv()
        _, s_half = rg.cos_sin(a / 2)
        _, s_pin = rg.cos_sin(pi / N)
        if not rg.is_pos(a):
            raise CertError("size must be positive")
        # a < pi first, so that a/2 lies in (0, pi/2) where sin is increasing: then
        # sin(a/2) < sin(pi/N) <=> a < 2 pi/N <=> circumradius R < pi/2
        if not rg.is_neg(a - pi):
            raise CertError("side angle must be < pi")
        if not rg.is_neg(s_half - s_pin):
            raise CertError("no convex regular N-gon of this side on the sphere (needs a < 2 pi / N)")
        sR = s_half / s_pin
        cR = rg.sqrt_pos(1 - sR * sR)
        self.sinR, self.cosR = sR, cR
        self.cos2R = 1 - 2 * sR * sR
        V = []
        for k in range(N):
            c, s = rg.cos_sin(pi / 2 + 2 * pi * k / N)
            V.append([sR * c, sR * s, cR])
        self.V = V


def _float_mid(x):
    return 0.5 * (float(x.a) + float(x.b))


def _float_max_margin_normals(A, B, limit=12):
    """Heuristic (float, pure Python) candidate normals: the best few max-margin candidates
    +-(p + q)/|p + q| and +- plane normals through three points of {a_k} u {-b_l}."""
    S = [list(a) for a in A] + [[-c for c in b] for b in B]
    m = len(S)
    cands = []

    def add(v):
        nv = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
        if nv > 1e-14:
            v = [c / nv for c in v]
            val = min(v[0] * s[0] + v[1] * s[1] + v[2] * s[2] for s in S)
            cands.append((val, v))

    for i in range(m):
        for j in range(i + 1, m):
            add([S[i][r] + S[j][r] for r in range(3)])
            for k in range(j + 1, m):
                u = [S[j][r] - S[i][r] for r in range(3)]
                w = [S[k][r] - S[i][r] for r in range(3)]
                cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
                add(cr)
                add([-c for c in cr])
    cands.sort(key=lambda t: -t[0])
    return [v for _, v in cands[:limit]]


def plane_separates(n, XA, XB):
    """True if n . x > 0 on all of XA and n . y < 0 on all of XB (or the reverse), rigorously.
    Returns (ok, lower bound of min |n.v| / |n| as float)."""
    nI = [I(Fraction(c)) if not hasattr(c, "a") else c for c in n]
    if not rg.is_pos(dot(nI, nI)):
        return False, None
    da = [dot(nI, x) for x in XA]
    db = [dot(nI, y) for y in XB]
    nn = rg.sqrt_pos(dot(nI, nI))
    for sgn in (1, -1):
        if all(rg.is_pos(sgn * d) for d in da) and all(rg.is_neg(sgn * d) for d in db):
            lo = min([float(((sgn * d) / nn).a) for d in da] + [float(((-sgn * d) / nn).a) for d in db])
            return True, lo
    return False, None


def _guard(fn, *args):
    t0 = time.time()
    try:
        out = fn(*args)
    except CertError as e:
        out = {"certified": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001  fail closed on anything unexpected
        out = {"certified": False, "error": f"invalid input: {type(e).__name__}: {e}"}
    out["time_s"] = round(time.time() - t0, 3)
    return out


def certify_configuration(N, P, config, witnesses=None, use_witnesses=True):
    """Prove one configuration strictly valid (geometry only, no record metadata). Never raises."""
    return _guard(_certify_core, N, P, config, witnesses if use_witnesses else None)


def certify_record(rec, use_witnesses=True):
    """Certify one PUBLISHED record of data/sphere/records.json: its own consistency (see the module
    docstring) and then its configuration. Returns {certified: bool, ...}. Never raises."""
    return _guard(_certify_published, rec, use_witnesses)


def _certify_published(rec, use_witnesses):
    if not isinstance(rec, dict):
        raise CertError("record must be an object")
    N = _shape(rec.get("N"))
    P = _posint(rec.get("P"))
    pid = f"sphere/{N}/{P}"
    rid = rec.get("id")
    if not isinstance(rid, str) or not (rid == pid or (rid.startswith(pid + "#") and ID_TAG.fullmatch(rid[len(pid) + 1:]))):
        raise CertError(f"id must be {pid} (optionally followed by #tag)")
    cfg = rec.get("config")
    if not isinstance(cfg, dict):
        raise CertError("missing config")
    if "score_cert" not in rec:
        raise CertError("missing score_cert")
    sc = _num(rec["score_cert"], "score_cert")
    if sc != _num(cfg.get("rho"), "config.rho"):
        raise CertError("score_cert differs from the radius of the stored configuration")
    if rec.get("display") != display_up(sc):
        raise CertError(f"display must be {display_up(sc)} (score_cert rounded up at 6 decimals)")
    sf = _num(rec.get("score_float"), "score_float")
    if not (0 < sf <= sc):
        raise CertError("need 0 < score_float <= score_cert")
    status = rec.get("status")
    if status not in STATUSES:
        raise CertError(f"status must be one of {STATUSES}")
    if status == "proven":
        lit = rec.get("literature")
        proof = lit.get("proof") if isinstance(lit, dict) else None
        if not (isinstance(proof, list) and proof and all(isinstance(s, str) and s.strip() for s in proof)):
            raise CertError("status 'proven' needs a cited published proof (literature.proof)")
    cert = rec.get("certificate")
    if cert is not None and not isinstance(cert, dict):
        raise CertError("certificate must be an object")
    wl = cert.get("witnesses") if isinstance(cert, dict) else None
    if wl is not None and not isinstance(wl, list):
        raise CertError("certificate.witnesses must be a list")
    return _certify_core(N, P, cfg, wl if use_witnesses else None)


def _certify_core(N, P, cfg, witness_list):
    out = {"certified": False}
    N = _shape(N)
    P = _posint(P)
    if not isinstance(cfg, dict):
        raise CertError("missing config")
    pieces = cfg.get("pieces")
    if not isinstance(pieces, list) or len(pieces) != P:
        raise CertError("number of pieces differs from P")
    rho = _num(cfg.get("rho"), "rho")
    if rho <= 0:
        raise CertError("rho must be positive")
    a = I(1) / I(rho)
    Q = []
    for k, p in enumerate(pieces):
        q = p.get("q") if isinstance(p, dict) else None
        if not isinstance(q, list) or len(q) != 4:
            raise CertError(f"piece {k}: q must be 4 numbers")
        Q.append([_num(c, f"piece {k} q") for c in q])
    Ms = [rot_matrix(q) for q in Q]
    C = [[M[0][2], M[1][2], M[2][2]] for M in Ms]
    stats = {"far": 0, "witness": 0, "fallback": 0}
    minclr = math.inf
    pi = rg.pi_iv()
    if N == 0:
        if P >= 2 and not rg.is_neg(a - pi / 2):
            raise CertError("disks of angular radius >= pi/2 cannot be strictly disjoint")
        if P == 1 and not rg.is_neg(a - pi):
            raise CertError("disk angular radius must be < pi")
        _, sa = rg.cos_sin(a)
        cos2a = 1 - 2 * sa * sa
        for i in range(P):
            for j in range(i + 1, P):
                d = dot(C[i], C[j]) - cos2a
                if not rg.is_neg(d):
                    raise CertError(f"disks {i}, {j}: separation not proved")
                stats["far"] += 1
                minclr = min(minclr, float((-d).a))
        out.update(certified=True, stats=stats, min_clearance=(minclr if math.isfinite(minclr) else None), prec=iv.prec)
        return out
    pc = Piece(N, a)
    X = [[matvec(M, v) for v in pc.V] for M in Ms]
    wit = {}
    for w in witness_list or []:
        if isinstance(w, list) and len(w) == 5:
            i, j = w[0], w[1]
            if isinstance(i, int) and isinstance(j, int) and not isinstance(i, bool) and not isinstance(j, bool):
                try:
                    wit[(min(i, j), max(i, j))] = [_num(c, "witness") for c in w[2:]]
                except CertError:
                    pass
    for i in range(P):
        for j in range(i + 1, P):
            if rg.is_neg(dot(C[i], C[j]) - pc.cos2R):
                stats["far"] += 1
                continue
            done = False
            if (i, j) in wit:
                ok, lo = plane_separates(wit[(i, j)], X[i], X[j])
                if ok:
                    stats["witness"] += 1
                    minclr = min(minclr, lo)
                    done = True
            if not done:
                A = [[_float_mid(c) for c in x] for x in X[i]]
                B = [[_float_mid(c) for c in x] for x in X[j]]
                for n in _float_max_margin_normals(A, B):
                    ok, lo = plane_separates(n, X[i], X[j])
                    if ok:
                        stats["fallback"] += 1
                        minclr = min(minclr, lo)
                        done = True
                        break
            if not done:
                raise CertError(f"pieces {i}, {j}: separation not proved")
    out.update(certified=True, stats=stats, min_clearance=(minclr if math.isfinite(minclr) else None), prec=iv.prec)
    return out


def run(path, use_witnesses=True, out_path=None, quiet=False):
    """Certify every record of a records file. Returns (summary, results); every entry of the
    'records' list counts (a missing config, a non-object record, ... is a failure)."""
    try:
        data = json.load(open(path))
    except (OSError, ValueError) as e:
        summary = {"records": 0, "certified": 0, "failed": 1, "error": f"cannot read {path}: {e}"}
        return summary, []
    recs = data.get("records") if isinstance(data, dict) else None
    if not isinstance(recs, list):
        summary = {"records": 0, "certified": 0, "failed": 1, "error": "the file has no 'records' list"}
        return summary, []
    res = []
    bad = 0
    for idx, r in enumerate(recs):
        rr = {"index": idx, "id": r.get("id") if isinstance(r, dict) else None}
        cfg = r.get("config") if isinstance(r, dict) else None
        rr["rho_cert"] = cfg.get("rho") if isinstance(cfg, dict) else None
        rr.update(certify_record(r, use_witnesses))
        res.append(rr)
        if not rr["certified"]:
            bad += 1
        if not quiet:
            clr = rr.get("min_clearance")
            print(f"{rr['id']}: {'CERTIFIED' if rr['certified'] else 'FAILED ' + str(rr.get('error', ''))}"
                  f"  {rr.get('stats', '')}  clr>={clr if clr is not None else 'n/a'}  {rr['time_s']}s", flush=True)
    summary = {"records": len(res), "certified": len(res) - bad, "failed": bad, "precision_bits": iv.prec,
               "certifier": "python/sphere/certify.py (mpmath iv; series from python/curved/rigorous.py)"}
    if not res:
        summary["failed"] = 1
        summary["error"] = "no records"
    if out_path:
        json.dump({"summary": summary, "results": res}, open(out_path, "w"), indent=1)
    return summary, res


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("records")
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-witnesses", action="store_true")
    args = ap.parse_args(argv)
    summary, _ = run(args.records, not args.no_witnesses, args.out)
    print(summary)
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
