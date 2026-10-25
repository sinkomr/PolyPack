"""Independent rigorous certifier for PolyPack's constant-curvature packings (curved/K/N/M/P).

Separate code from the TypeScript search. Every inequality is decided with interval arithmetic
(mpmath iv, 256 bits, outward rounding; transcendental functions from series with explicit
remainders in rigorous.py). The certificate proves that the stored floating-point configuration,
read as exact dyadic rationals, is a packing with STRICTLY positive clearance at the stored size.

Model (identical conventions to packages/curved, re-derived here):
  * Points are homogeneous vectors v = (v0, v1, v2) with Q(v) = v0^2 + K (v1^2 + v2^2) > 0 and
    v0 > 0; the chart p = (v1, v2)/v0 is Beltrami-Klein (K < 0), gnomonic (K > 0, open hemisphere
    around O) or the identity (K = 0). Geodesics are chart lines, so geodesic convex polygons are
    Euclidean convex polygons in the chart, and disjointness/containment can be decided there.
  * A line is a covector n; points with n.v > 0 lie strictly on one side (for v0 > 0).
  * Pose (x, y, theta): G = T(x, y) R(theta), T the transvection moving O to exp_O(x, y):
        v0' = C v0 - K S (x v1 + y v2)
        v' = S (x, y) v0 + v - K V (x v1 + y v2) (x, y),  C = C(K D^2), S = S(K D^2), V = V(K D^2), D^2 = x^2 + y^2.
  * Unit piece: regular N-gon of geodesic side 1, circumradius R with sn_K(1/2) = sn_K(R) sin(pi/N),
    vertex k at direction pi/2 + 2 pi k/N; disk (N = 0) of radius 1.
  * Container centred at O, phi = 0: polygon walls at distance h with tn_K(s/2) = sn_K(h) tan(pi/M),
    covectors n_k = (-sn_K(h), cs_K(h) u_k), u_k at angle -pi/2 + 2 pi k/M (outward); or a disk of radius r.
  * K > 0: container (hence every piece) must lie in the open hemisphere around O.

Usage:  python3 python/curved/certify.py data/curved/records.json [--out data/curved/certification.json]
        python3 python/curved/certify.py data/curved/ideal.json --ideal
"""
import json
import math
import re
import sys
from decimal import ROUND_HALF_EVEN, Decimal
from fractions import Fraction

from mpmath import iv

try:
    from . import rigorous as rg
except ImportError:  # run as a script
    import os

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import rigorous as rg

I = rg.I

# allowed suffix after '#' in a record id (see _certify_published)
ID_TAG = re.compile(r"[A-Za-z0-9_.-]{1,32}")


class CertError(Exception):
    pass


def parse_K(K):
    """Exact rational value of K given as an int, a binary64 float, a Fraction or a rational literal."""
    if isinstance(K, bool):
        raise CertError("K must be a number")
    if isinstance(K, Fraction):
        return K
    if isinstance(K, int):
        return Fraction(K)
    if isinstance(K, float):
        if not math.isfinite(K):
            raise CertError("K must be finite")
        return Fraction(K)
    if isinstance(K, str):
        try:
            return Fraction(K)
        except (ValueError, ZeroDivisionError, OverflowError):
            raise CertError("K is not a rational literal")
    raise CertError("K must be a number or a decimal string")


def _finite_float(v, what):
    """A number that is exactly representable as a finite binary64 float."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise CertError(f"{what} must be a number")
    try:
        f = float(v)
    except OverflowError:
        raise CertError(f"{what} is out of the binary64 range")
    if not math.isfinite(f):
        raise CertError(f"{what} must be finite")
    if isinstance(v, int) and Fraction(f) != v:
        raise CertError(f"{what} is not exactly representable as binary64")
    return f


def _shape_code(n, what):
    if isinstance(n, bool) or not isinstance(n, int):
        raise CertError(f"{what} must be an integer")
    if not (n == 0 or 3 <= n <= 100):
        raise CertError(f"{what} must be 0 or 3..100")
    return n


def display_nearest(x):
    """Score rounded to the NEAREST at 6 decimals (ties to even), always 6 decimals, as a string.
    Exact: x is read as its binary64 value (Decimal(float) is exact), e.g. 1.0000000000400 -> "1.000000",
    2.8284271247490187 -> "2.828427", 1/128 = 0.0078125 -> "0.007812"."""
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        raise CertError("score must be a finite number")
    if x < 0:
        raise CertError("negative score")
    return str(Decimal(x).quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN))


def problem_id(K, N, M, P):
    """The records' id format: curved/K/N/M/P with K printed as stored (int or binary64 repr)."""
    return f"curved/{K}/{N}/{M}/{P}"


class Geometry:
    """Rigorous constants for (K, N, M)."""

    def __init__(self, Kq, N, M):
        self.Kq = Kq
        self.K = I(Kq)
        self.N = N
        self.M = M
        K = self.K
        pi = rg.pi_iv()
        self.pi = pi
        self.sn1 = rg.snK(K, I(1))
        if N == 0:
            if Kq > 0:
                # radius 1 must be below the hemisphere radius pi/(2 sqrt K): 4K < pi^2
                if not rg.is_pos(pi * pi - 4 * K):
                    raise CertError("unit disk does not fit in a hemisphere at this K")
            self.verts = []
        else:
            if Kq > 0:
                # a convex regular N-gon of side a on the sphere of radius 1/sqrt K has
                # sin(sqrt K a / 2) = sin(sqrt K R) sin(pi/N) with R < pi/(2 sqrt K), so its side
                # ranges over (0, 2 pi/(N sqrt K)): a unit N-gon exists iff sqrt K < 2 pi/N
                if not rg.is_pos((2 * pi / N) ** 2 - K):
                    raise CertError("no unit regular N-gon exists at this K (needs sqrt K < 2 pi/N)")
            cN, sN = rg.cos_sin(pi / N)
            snR = rg.snK(K, I(Fraction(1, 2))) / sN
            q = 1 - K * snR * snR
            if not rg.is_pos(q):
                raise CertError("no unit regular N-gon exists at this K")
            csR = rg.sqrt_pos(q)
            self.snR = snR
            self.csR = csR
            self.verts = []
            for k in range(N):
                c, s = rg.cos_sin(pi / 2 + 2 * pi * k / N)
                self.verts.append((csR, snR * c, snR * s))

    def container(self, size_f):
        """Wall covectors (polygon) or radius data (disk) for the exact size."""
        K, M = self.K, self.M
        s = I(size_f)
        if M == 0:
            r = s
            if self.Kq > 0:
                # open hemisphere: K r^2 < (pi/2)^2
                if not rg.is_pos((self.pi / 2) ** 2 - K * r * r):
                    raise CertError("disk container is not inside an open hemisphere")
            self.r = r
            self.walls = None
            return
        if self.Kq > 0:
            # convex regular M-gon in an open hemisphere: s < 2 pi/(M sqrt K), i.e. K s^2 < (2 pi/M)^2
            # (without this, sides near 4 pi k/sqrt K would wrap around to a smaller polygon)
            if not rg.is_pos((2 * self.pi / M) ** 2 - K * s * s):
                raise CertError("polygon container is not inside an open hemisphere (needs s < 2 pi/(M sqrt K))")
        half = s / 2
        cs_half = rg.csK(K, half)
        if not rg.is_pos(cs_half):
            raise CertError("container side too large")
        tn_half = rg.snK(K, half) / cs_half
        cM, sM = rg.cos_sin(self.pi / M)
        snh = tn_half * cM / sM
        q = 1 - K * snh * snh
        if not rg.is_pos(q):
            raise CertError("container apothem beyond the hemisphere")
        csh = rg.sqrt_pos(q)
        # for K > 0 the circumradius R_c has cs_K(R_c) = cs_K(h) cs_K(s/2) > 0: container in the open hemisphere
        self.walls = []
        for k in range(M):
            c, sn = rg.cos_sin(-self.pi / 2 + 2 * self.pi * k / M)
            self.walls.append((-snh, csh * c, csh * sn))


def transform(geo, pose, v):
    """Apply G = T(x, y) R(theta) to a homogeneous vector v (intervals)."""
    K = geo.K
    x, y, th = pose
    c, s = rg.cos_sin_reduced(th)
    w0 = v[0]
    w1 = c * v[1] - s * v[2]
    w2 = s * v[1] + c * v[2]
    D2 = x * x + y * y
    t = K * D2
    S = rg.Sfun(t)
    V = rg.Vfun(t)
    C = 1 - K * D2 * V
    dot = x * w1 + y * w2
    return (C * w0 - K * S * dot, S * x * w0 + w1 - K * V * dot * x, S * y * w0 + w2 - K * V * dot * y)


def centre(geo, pose):
    x, y, _ = pose
    D2 = x * x + y * y
    t = geo.K * D2
    S = rg.Sfun(t)
    V = rg.Vfun(t)
    return (1 - geo.K * D2 * V, S * x, S * y)


def dot(n, v):
    return n[0] * v[0] + n[1] * v[1] + n[2] * v[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def qform(geo, v):
    return v[0] * v[0] + geo.K * (v[1] * v[1] + v[2] * v[2])


def vs_between(geo, v, w):
    """vs_K of the distance between two points (increasing in the distance on [0, pi/sqrt K])."""
    qv = rg.sqrt_pos(qform(geo, v))
    qw = rg.sqrt_pos(qform(geo, w))
    a = [v[i] / qv for i in range(3)]
    b = [w[i] / qw for i in range(3)]
    d1 = a[1] - b[1]
    d2 = a[2] - b[2]
    if geo.Kq == 0:
        return (d1 * d1 + d2 * d2) / 2
    d0 = a[0] - b[0]
    return (d0 * d0 / geo.K + d1 * d1 + d2 * d2) / 2


def vs_from_O(geo, v):
    q = rg.sqrt_pos(qform(geo, v))
    if geo.Kq == 0:
        return (v[1] * v[1] + v[2] * v[2]) / (2 * v[0] * v[0])
    return (1 - v[0] / q) / geo.K


def vs_of_length(geo, L):
    """vs_K(L) = L^2 V(K L^2)."""
    return L * L * rg.Vfun(geo.K * L * L)


def _guard(fn, *args):
    try:
        return fn(*args)
    except CertError as e:
        return {"certified": False, "reason": str(e)}
    except Exception as e:  # noqa: BLE001  fail closed on anything unexpected
        return {"certified": False, "reason": f"invalid input: {type(e).__name__}: {e}"}


def certify_record(rec, use_witnesses=True):
    """Certify one PUBLISHED record of data/curved/records.json. Returns {certified: bool, ...}.

    Checks the record's own consistency (id = curved/K/N/M/P, K_exact equal to K, score_cert equal
    to the size of `config`, display = score_cert rounded to the nearest at 6 decimals) and then proves the
    published `config` (and `config_cert`, if a record carries one) strictly valid. Never raises."""
    return _guard(_certify_published, rec, use_witnesses)


def certify_configuration(K, N, M, P, config, witnesses=None, score_cert=None):
    """Prove one configuration strictly valid (no record metadata). K: int, binary64 float, Fraction or
    rational literal. Never raises."""
    return _guard(_certify_core, K, N, M, P, config, witnesses, score_cert)


def _check_K_exact(rec, Kq):
    if "K_exact" not in rec:
        return
    ke = rec["K_exact"]
    if not isinstance(ke, str):
        raise CertError("K_exact must be a string")
    if ke.startswith("binary64 "):
        try:
            kv = float(ke[len("binary64 "):])
        except ValueError:
            raise CertError("K_exact is not a binary64 literal")
        if not math.isfinite(kv) or Fraction(kv) != Kq:
            raise CertError("K_exact differs from K")
        return
    if parse_K(ke) != Kq:
        raise CertError("K_exact differs from K")


def _certify_published(rec, use_witnesses):
    if not isinstance(rec, dict):
        raise CertError("record must be an object")
    K = rec.get("K")
    if isinstance(K, bool) or not isinstance(K, (int, float)):
        raise CertError("K must be a number")
    Kq = parse_K(K)
    _check_K_exact(rec, Kq)
    N = _shape_code(rec.get("N"), "N")
    M = _shape_code(rec.get("M"), "M")
    P = rec.get("P")
    if isinstance(P, bool) or not isinstance(P, int) or P < 1:
        raise CertError("P must be a positive integer")
    # The id names the problem; a "#tag" suffix (e.g. a sweep branch, "#b2") may follow it to keep
    # several configurations of one problem apart, but the part before "#" must match exactly.
    rid = rec.get("id")
    pid = problem_id(K, N, M, P)
    if not isinstance(rid, str) or not (rid == pid or (rid.startswith(pid + "#") and ID_TAG.fullmatch(rid[len(pid) + 1:]))):
        raise CertError(f"id must be {pid} (optionally followed by #tag)")
    cfg = rec.get("config")
    if not isinstance(cfg, dict):
        raise CertError("missing configuration")
    if "score_cert" not in rec:
        raise CertError("missing score_cert")
    score = _finite_float(rec["score_cert"], "score_cert")
    if rec.get("display") != display_nearest(score):
        raise CertError(f"display must be {display_nearest(score)} (score_cert rounded to the nearest at 6 decimals)")
    wl = None
    if use_witnesses:
        wl = rec.get("witnesses")
        if wl is None and isinstance(rec.get("certificate"), dict):
            wl = rec["certificate"].get("witnesses")
    res = _certify_core(Kq, N, M, P, cfg, wl, score)
    if rec.get("config_cert") is not None and rec["config_cert"] != cfg:
        res2 = _certify_core(Kq, N, M, P, rec["config_cert"], wl, score)
        res["config_cert_also_certified"] = res2["certified"]
    return res


def _certify_core(K, N, M, P, cfg, witness_list=None, score_cert=None):
    Kq = parse_K(K)
    N = _shape_code(N, "N")
    M = _shape_code(M, "M")
    if isinstance(P, bool) or not isinstance(P, int) or P < 1:
        raise CertError("P must be a positive integer")
    if not isinstance(cfg, dict):
        raise CertError("missing configuration")
    pieces = cfg.get("pieces")
    if not isinstance(pieces, list) or len(pieces) != P:
        raise CertError("number of pieces differs from P")
    size = _finite_float(cfg.get("size"), "size")
    if not size > 0:
        raise CertError("size must be positive")
    if score_cert is not None and _finite_float(score_cert, "score_cert") != size:
        raise CertError("score_cert differs from the configuration size")
    poses = []
    for p in pieces:
        if not isinstance(p, dict):
            raise CertError("pose must be an object")
        poses.append(tuple(I(_finite_float(p.get(k), k)) for k in ("x", "y", "theta")))
    geo = Geometry(Kq, N, M)
    geo.container(size)
    K = geo.K
    # world vertices (or centres)
    world = []
    centres = []
    for pose in poses:
        centres.append(centre(geo, pose))
        world.append([transform(geo, pose, v) for v in geo.verts] if N else [])
    if Kq > 0:
        for i in range(P):
            for v in world[i] + [centres[i]]:
                if not rg.is_pos(v[0]):
                    raise CertError(f"piece {i} not certainly in the open hemisphere")
    min_cont = None
    min_pair = None

    def upd(cur, val):
        return val if cur is None or val < cur else cur

    # containment
    for i in range(P):
        if M > 0:
            if N > 0:
                for v in world[i]:
                    for n in geo.walls:
                        val = dot(n, v)
                        if not rg.is_neg(val):
                            raise CertError(f"piece {i} not certainly inside wall")
                        min_cont = upd(min_cont, -val.b)
            else:
                c = centres[i]
                qc = rg.sqrt_pos(qform(geo, c))
                for n in geo.walls:
                    val = dot(n, c) / qc + geo.sn1  # needs < 0: sn(signed distance) < -sn(1)
                    if not rg.is_neg(val):
                        raise CertError(f"disk {i} not certainly inside wall")
                    min_cont = upd(min_cont, -val.b)
        else:
            if N > 0:
                lim = vs_of_length(geo, geo.r)
                for v in world[i]:
                    val = lim - vs_from_O(geo, v)
                    if not rg.is_pos(val):
                        raise CertError(f"piece {i} not certainly inside the disk container")
                    min_cont = upd(min_cont, val.a)
            else:
                if not rg.is_pos(geo.r - 1):
                    raise CertError("container radius must exceed 1")
                lim = vs_of_length(geo, geo.r - 1)
                val = lim - vs_from_O(geo, centres[i])
                if not rg.is_pos(val):
                    raise CertError(f"disk {i} not certainly inside the disk container")
                min_cont = upd(min_cont, val.a)
    # pairs
    wit = {}
    for w in witness_list or []:
        if isinstance(w, dict) and isinstance(w.get("i"), int) and isinstance(w.get("j"), int):
            wit[(w["i"], w["j"])] = w
    used = {"axis": 0, "far": 0, "disk": 0, "searched": 0}
    if N == 0:
        lim = vs_of_length(geo, I(2))
    else:
        far_lim = 2 * geo.snR * geo.snR  # vs_K(2R) = 2 sn_K(R)^2
    for i in range(P):
        for j in range(i + 1, P):
            if N == 0:
                val = vs_between(geo, centres[i], centres[j]) - lim
                if not rg.is_pos(val):
                    raise CertError(f"disks {i},{j} not certainly disjoint")
                used["disk"] += 1
                min_pair = upd(min_pair, val.a)
                continue
            w = wit.get((i, j))
            ok = False
            if w and w.get("type") == "far":
                ok = _far(geo, centres[i], centres[j], far_lim)
                if ok:
                    used["far"] += 1
            elif w and w.get("type") == "axis":
                own, e = w.get("owner"), w.get("edge")
                if own in (0, 1) and isinstance(e, int) and 0 <= e < N:
                    a, b = (world[i], world[j]) if own == 0 else (world[j], world[i])
                    m = _axis(a, e, b, N)
                    if m is not None:
                        ok = True
                        used["axis"] += 1
                        min_pair = upd(min_pair, m)
            if not ok:
                # no or failed witness: try the far test and every axis
                used["searched"] += 1
                if _far(geo, centres[i], centres[j], far_lim):
                    ok = True
                else:
                    for a, b in ((world[i], world[j]), (world[j], world[i])):
                        for e in range(N):
                            m = _axis(a, e, b, N)
                            if m is not None:
                                ok = True
                                min_pair = upd(min_pair, m)
                                break
                        if ok:
                            break
            if not ok:
                raise CertError(f"pieces {i},{j} not certainly disjoint")
    return {
        "certified": True,
        "min_container_clearance_lb": float(min_cont) if min_cont is not None else None,
        "min_pair_clearance_lb": float(min_pair) if min_pair is not None else None,
        "tests": used,
        "precision_bits": rg.PREC,
    }


def _far(geo, ci, cj, far_lim):
    return rg.is_pos(vs_between(geo, ci, cj) - far_lim)


def _axis(owner_verts, e, other_verts, N):
    """Edge e of the owner separates: owner's other vertices certainly on n.v < 0, the other piece's
    vertices certainly on n.v > 0, with n = V_{e+1} x V_e (the endpoints lie on n.v = 0 exactly).
    Returns a lower bound of the smallest n.w over the other piece, or None."""
    a = owner_verts[e]
    b = owner_verts[(e + 1) % N]
    n = cross(b, a)
    for k in range(N):
        if k == e or k == (e + 1) % N:
            continue
        if not rg.is_neg(dot(n, owner_verts[k])):
            return None
    m = None
    for w in other_verts:
        val = dot(n, w)
        if not rg.is_pos(val):
            return None
        m = val.a if m is None or val.a < m else m
    return m


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[1]
    out = None
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    with open(path) as f:
        data = json.load(f)
    if "--ideal" in argv:
        return main_ideal(data)
    recs = data["records"] if isinstance(data, dict) else data
    results = []
    bad = 0
    skipped = [r for r in recs if isinstance(r, dict) and r.get("status") == "infeasible"]
    recs = [r for r in recs if not (isinstance(r, dict) and r.get("status") == "infeasible")]
    if skipped:
        print(f"{len(skipped)} infeasibility records skipped (no configuration; see bounds.py)")
    for rec in recs:
        res = certify_record(rec)
        res["id"] = rec.get("id") if isinstance(rec, dict) else None
        if not res["certified"]:
            bad += 1
            print(f"FAIL {res['id']}: {res.get('reason')}")
        results.append(res)
    print(f"{len(recs) - bad}/{len(recs)} records certified")
    if out:
        with open(out, "w") as f:
            json.dump({"certifier": "python/curved/certify.py", "precision_bits": rg.PREC, "results": results}, f, indent=1)
    return 0 if bad == 0 else 1


def check_ideal(data):
    """Certify every config_cert of ideal.json and check each finite certified lower bound lb against
    the curvature K_cert it comes from: lb^2 <= -K_cert exactly. Returns (ok, failures, messages)."""
    entries = data.get("entries", []) if isinstance(data, dict) else []
    by = {}
    for e in entries:
        if isinstance(e, dict):
            by[(e.get("N"), e.get("M"), e.get("P"))] = e
    ok, fails, msgs = 0, 0, []
    certified = {}
    for key, e in by.items():
        if e.get("config_cert") is None:
            continue
        res = certify_configuration(e.get("K_cert"), e.get("N"), e.get("M"), e.get("P"), e["config_cert"])
        certified[key] = res["certified"]
        if res["certified"]:
            ok += 1
        else:
            fails += 1
            msgs.append(f"FAIL config_cert {key}: {res.get('reason')}")
    for key, e in by.items():
        lb = e.get("certified_lower_bound")
        if lb is None or e.get("a_star") == "infinity":
            continue
        src = by.get((key[0], key[1], e.get("lower_bound_from_P", key[2])))
        if src is None or not certified.get((src["N"], src["M"], src["P"])):
            fails += 1
            msgs.append(f"FAIL bound {key}: source configuration not certified")
            continue
        try:
            good = Fraction(lb) ** 2 <= -parse_K(src["K_cert"])
        except (CertError, TypeError, ValueError, OverflowError):
            good = False
        if not good:
            fails += 1
            msgs.append(f"FAIL bound {key}: certified_lower_bound^2 > -K_cert")
    return ok, fails, msgs


def main_ideal(data):
    ok, fails, msgs = check_ideal(data)
    for m in msgs:
        print(m)
    print(f"{ok} ideal configurations certified, {fails} failures")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
