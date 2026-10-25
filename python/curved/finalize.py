"""Assemble data/curved/records.json from search runs, certify every entry with certify.py, attach
rigorous lower bounds and the P_max catalogue from bounds.json.

Usage:
  python3 python/curved/finalize.py --runs RUNDIR_KM1 RUNDIR_KP1 [--ideal IDEALDIR] --out data/curved
"""
import glob
import json
import math
import os
import sys
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import certify  # noqa: E402
import rigorous as rg  # noqa: E402
import bounds as bd  # noqa: E402
from mpmath import iv  # noqa: E402

I = rg.I
PI = rg.pi_iv()
TODAY = "2026-10-24"
SOFTWARE = "PolyPack curved research build"
FOUND_BY = "PolyPack research"
METHOD = (
    "packages/curved solve(): seeded multistart; random start in a roomy container, penalty compression "
    "(L-BFGS on squared overlaps at fixed container), sequential-LP polish with box trust region and "
    "second-order correction, basin hopping (re-place / jiggle / rotate pieces), each P warm-started from "
    "the P-1 optimum plus one piece; then margin re-solve (all gaps >= margin) for certification"
)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


def sqrt_down(q):
    """Largest binary64 value a with a^2 <= q (q a non-negative Fraction), decided exactly."""
    a = math.sqrt(float(q))
    while a > 0 and Fraction(a) ** 2 > q:
        a = math.nextafter(a, 0.0)
    while Fraction(math.nextafter(a, math.inf)) ** 2 <= q:
        a = math.nextafter(a, math.inf)
    return a


def container_area(K, M, s):
    """Interval area of the container of size s at K = +-1."""
    Ki = I(K)
    s = I(s)
    if M == 0:
        return 2 * PI * (1 - rg.csK(Ki, s)) / Ki
    cM, sM = rg.cos_sin(PI / M)
    y = cM / rg.csK(Ki, s / 2)
    alpha = 2 * bd.asin_iv(y)
    return (M - 2) * PI - M * alpha if K < 0 else M * alpha - (M - 2) * PI


_PD = {}


def piece_data(K, N):
    if (K, N) not in _PD:
        _PD[(K, N)] = bd.piece_data(K, N)
    return _PD[(K, N)]


def area_lower_bound(K, N, M, P, s_hi):
    """Largest s_lo (bisection, rigorous) with area(s_lo) < P * A_piece certainly: s(P) > s_lo."""
    A = piece_data(K, N)["area"]
    target = P * A
    lo, hi = 0.0, float(s_hi)
    # need area(lo) < target certainly; area(0) = 0
    for _ in range(36):
        mid = (lo + hi) / 2
        try:
            a = container_area(K, M, mid)
        except ValueError:
            hi = mid
            continue
        if (a - target).b < 0:
            lo = mid
        else:
            hi = mid
    return lo


def inradius_side(K, N, M):
    """P = 1, polygon container: the container's inradius (apothem) must be >= rho_N, so
    s >= 2 atn_K(sn_K(rho) tan(pi/M)). Returned rigorously rounded down (float)."""
    rho = piece_data(K, N)["rho"]
    Ki = I(K)
    cM, sM = rg.cos_sin(PI / M)
    y = rg.snK(Ki, rho) * sM / cM  # = tn_K(s/2)
    if K < 0 and not (y * y - 1).b < 0:
        return None
    tn = lambda x: rg.snK(Ki, x) / rg.csK(Ki, x)  # noqa: E731
    g = 2 * (math.atanh(float(y.a)) if K < 0 else math.atan(float(y.a)))
    half = bd.inv_increasing(tn, y, g / 2, 0.0, 50.0)
    return float((2 * half).a) * (1 - 1e-15)


def load_runs(dirs):
    out = {}
    for d in dirs:
        for f in glob.glob(os.path.join(d, "*.json")):
            r = json.load(open(f))
            out[(r["K"], r["N"], r["M"], r["P"])] = r
    return out


def euclid_records():
    data = json.load(open(os.path.join(ROOT, "data", "records.json")))["records"]
    return {(r["N"], r["M"], r["P"]): r for r in data}


def main(argv):
    runs_dirs = []
    i = argv.index("--runs") + 1
    while i < len(argv) and not argv[i].startswith("--"):
        runs_dirs.append(argv[i])
        i += 1
    out_dir = argv[argv.index("--out") + 1]
    ideal_dir = argv[argv.index("--ideal") + 1] if "--ideal" in argv else None
    runs = load_runs(runs_dirs)
    bnds = {}
    bpath = os.path.join(out_dir, "bounds.json")
    if os.path.exists(bpath):
        for b in json.load(open(bpath))["bounds"]:
            if "M" in b:
                bnds[(b["K"], b["N"], b["M"])] = b
    eu = euclid_records()
    records = []
    certs = []
    catalogue = {}
    lower_prev = {}
    for key in sorted(runs, key=lambda k: (-k[0], k[1], k[2], k[3])):
        r = runs[key]
        K, N, M, P = key
        cat = catalogue.setdefault((K, N, M), {"K": K, "N": N, "M": M, "found": [], "not_found": []})
        if not r.get("found"):
            cat["not_found"].append(P)
            continue
        cat["found"].append(P)
        pid = f"curved/{K}/{N}/{M}/{P}"
        # lower bound on s(P)
        lb_kind = []
        lb = 0.0
        try:
            la = area_lower_bound(K, N, M, P, r["score_cert"])
            lb, lb_kind = la, ["area"]
        except Exception as e:  # noqa: BLE001
            lb_kind = [f"area bound failed: {e}"]
        if P == 1:
            if M == 0:
                v = 1.0 if N == 0 else float(piece_data(K, N)["R"].a)
                if v >= lb:
                    lb, lb_kind = v, ["P = 1 in a disk: the disk contains the piece's circumscribed vertices (r >= R)"]
            else:
                v = inradius_side(K, N, M)
                if v is not None and v >= lb:
                    lb, lb_kind = v, ["P = 1: container inradius >= piece inradius"]
        if M == 0 and P >= 2:
            rho = 1.0 if N == 0 else float(piece_data(K, N)["rho"].a)
            v = 2 * rho * (1 - 1e-15)
            if v > lb:
                lb, lb_kind = v, ["two inscribed disks of radius rho in the container: r >= 2 rho"]
        prev = lower_prev.get((K, N, M, P - 1))
        if prev is not None and prev > lb:
            lb, lb_kind = prev, [f"monotonicity: s(P) >= lower bound for P - 1"]
        lower_prev[(K, N, M, P)] = lb
        e = eu.get((N, M, P))
        sens = {
            "dsdK_envelope": r.get("dsdK"),
            "dsdK_multiplier_range": r.get("dsdK_range"),
            "kkt_residual": r.get("kktResidual"),
            "contacts": r.get("contacts"),
            "rattlers": r.get("rattlers"),
        }
        notes = []
        if r.get("perfect"):
            notes.append(f"[CALC] {r['perfect']} at the curvature K* where the unit triangle's angle is 2 pi/{M}; "
                         "the configuration matches the area bound (the pieces fill the container), so no smaller container exists")
        if r.get("rattlers"):
            notes.append(f"rattlers (no active contact): {r['rattlers']}")
        if sens["dsdK_multiplier_range"] and sens["dsdK_multiplier_range"].get("max") is not None:
            rg_ = sens["dsdK_multiplier_range"]
            if abs((rg_["max"] or 0) - (rg_["min"] or 0)) > 1e-6:
                notes.append("degenerate multipliers: ds/dK one-sided slopes may differ (see dsdK_multiplier_range)")
        if r["score_cert"] < r["score_float"]:
            # the margin re-solve found a better local optimum than the float polish; the touching
            # limit is then below the certified margin configuration
            notes.append("margin re-solve improved on the float polish; score_float set to score_cert")
            r = dict(r)
            r["score_float"] = r["score_cert"]
            r["config_float"] = r["config_cert"]
        rec = {
            "id": pid,
            "K": K,
            "K_exact": str(Fraction(K)) if float(K).is_integer() else f"binary64 {K!r}",
            "N": N,
            "M": M,
            "P": P,
            "score_float": r["score_float"],
            "score_cert": r["score_cert"],
            "cert_minus_float": r["score_cert"] - r["score_float"],
            "cert_minus_float_relative": (r["score_cert"] - r["score_float"]) / r["score_float"],
            "display": certify.display_nearest(r["score_cert"]),
            "status": "best_known",
            "certified": None,
            "config": r["config_cert"],
            "config_touching": r["config_float"],
            "certificate": {
                "file": "certification.json",
                "checker": "python/curved/certify.py (mpmath iv, 256 bits, series-based transcendentals)",
                "margin": r.get("margin"),
                "witnesses": r.get("witnesses"),
                "min_pair_clearance_lb": None,
                "min_container_clearance_lb": None,
            },
            "bound": {"lower": lb, "kind": "; ".join(lb_kind), "label": "[CALC] rigorous (interval arithmetic)"},
            "method": METHOD,
            "seed": r.get("seed"),
            "budget": r.get("budget"),
            "software": SOFTWARE,
            "found_by": FOUND_BY,
            "sensitivity": sens,
            "euclidean_record": {"value": e["value"], "status": e["status"], "source": "data/records.json"} if e else None,
            "notes": "; ".join(notes),
        }
        # certify the published record exactly as it will be written (format checks + geometry)
        res = certify.certify_record(rec)
        res["id"] = pid
        certs.append(res)
        rec["certified"] = res["certified"]
        rec["certificate"]["min_pair_clearance_lb"] = res.get("min_pair_clearance_lb")
        rec["certificate"]["min_container_clearance_lb"] = res.get("min_container_clearance_lb")
        if not res["certified"]:
            rec["status"] = "uncertified"
            rec["notes"] = (rec["notes"] + "; " if rec["notes"] else "") + f"certifier: {res.get('reason')}"
        records.append(rec)
    # catalogue and proven-infeasible entries
    cat_out = []
    for key in sorted(catalogue, key=lambda k: (-k[0], k[1], k[2])):
        c = catalogue[key]
        K, N, M = key
        if K not in (-1, 1):
            continue  # single problems at special curvatures (tilings), not catalogues
        pf = max(c["found"]) if c["found"] else 0
        b = bnds.get(key)
        up = b.get("P_max_upper") if b else None
        exact = up is not None and up == pf
        entry = {
            "K": K,
            "N": N,
            "M": M,
            "P_max_found": pf,
            "P_max_upper": up,
            "upper_arguments": b.get("args") if b else None,
            "exact": exact,
            "searched_without_success": sorted(c["not_found"]),
        }
        cat_out.append(entry)
        if exact and (M != 0 or K > 0):
            pid = f"curved/{K}/{N}/{M}/{pf + 1}"
            args = b.get("args") or {}
            reasons = [k for k in args if k in ("inradius", "near_wall", "cusp", "area") and args[k] is not None and args[k] <= pf]
            reasons += [k for k in args if k.startswith("centre_bb") and args[k].get("proved")]
            records.append(
                {
                    "id": pid,
                    "K": K,
                    "K_exact": str(Fraction(K)) if float(K).is_integer() else f"binary64 {K!r}",
                    "N": N,
                    "M": M,
                    "P": pf + 1,
                    "status": "infeasible",
                    "proof": "python/curved/bounds.py arguments: " + ", ".join(reasons) + " (see docs/spaces/CURVED.md, 'P_max')",
                    "found_by": FOUND_BY,
                    "software": SOFTWARE,
                }
            )
    conventions = {
        "space": "plane of constant curvature K: K < 0 hyperbolic, K = 0 Euclidean, K > 0 sphere of radius 1/sqrt(K)",
        "problem_id": "curved/K/N/M/P",
        "units": "geodesic lengths at curvature K; polygon pieces have side 1, disk pieces (N = 0) radius 1",
        "pose": "(x, y, theta): piece = T(exp_O(x, y)) R(theta) (standard piece); exp_O(x, y) is the point at distance sqrt(x^2+y^2) from the container centre O in direction (x, y); T the transvection along the geodesic from O; R(theta) the rotation about O; standard piece centred at O with a vertex straight up; at K = 0 this is PolyPack's Euclidean pose",
        "container": "centred at O, phi = 0 (horizontal bottom edge): regular M-gon of geodesic side s (walls at apothem h with tn_K(s/2) = sn_K(h) tan(pi/M)), or disk of radius r (M = 0); for K > 0 the container lies in the open hemisphere around O",
        "score": "s (M >= 3) or r (M = 0); smaller is better",
        "score_float": "touching limit found by the search (float64 polish)",
        "score_cert": "size at which the stored configuration `config` is proven valid with strictly positive clearance",
        "display": "score_cert rounded to the nearest at 6 decimals (ties to even, from its exact binary64 value)",
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "records.json"), "w") as f:
        json.dump({"generated": TODAY, "conventions": conventions, "catalogue": cat_out, "records": records}, f, indent=1)
    with open(os.path.join(out_dir, "certification.json"), "w") as f:
        json.dump({"generated": TODAY, "certifier": "python/curved/certify.py", "precision_bits": rg.PREC, "results": certs}, f, indent=1)
    ok = sum(1 for c in certs if c["certified"])
    print(f"records: {len(records)} ({ok}/{len(certs)} packings certified)")
    if ideal_dir:
        ideal_out = []
        for f in sorted(glob.glob(os.path.join(ideal_dir, "ideal_*.json"))):
            d = json.load(open(f))
            if not d.get("found"):
                continue
            entry = {k: d.get(k) for k in ("N", "M", "P", "a_float", "K_float", "unbounded", "how", "seed", "hops")}
            Nn, Mm, Pp = d["N"], d["M"], d["P"]
            if Nn >= 3 and ((Nn == 3 and Pp <= Mm - 2) or (Pp == 1 and (Mm % Nn == 0 or (Nn, Mm) == (4, 6)))):
                # [CALC] a regular N-gon of any size, concentric and aligned with an ideal regular N-gon,
                # is the intersection of half-planes parallel-shifted inside the ideal one's, so it fits;
                # an ideal triangulation gives M - 2 disjoint ideal triangles, and every k-th vertex of the
                # ideal kN-gon spans an ideal regular N-gon
                entry["a_star"] = "infinity"
                entry["proof"] = (
                    f"{Pp} disjoint ideal triangles in a triangulation of the ideal {Mm}-gon"
                    if Nn == 3 and Pp <= Mm - 2
                    else (
                        "vertices 0, 1, 2, 4 of the ideal hexagon span a regular ideal square: on the unit circle "
                        "|z0 - z2| |z1 - z4| / (|z0 - z4| |z1 - z2|) = (sqrt3 * 2)/(sqrt3 * 1) = 2, the cross-ratio of a square"
                        if (Nn, Mm) == (4, 6)
                        else f"the ideal {Mm}-gon contains an ideal regular {Nn}-gon (every {Mm // Nn}-th vertex)"
                    )
                ) + "; each contains a concentric regular piece of any size"
            elif d.get("unbounded"):
                # K ran past the divergence limit without a proof: at piece sides near 20 the float
                # coordinates (~e^20) are meaningless, so this is not evidence of a* = infinity
                entry["unbounded"] = False
                entry["a_star_note"] = "kPolish diverged numerically (side > 20, float conditioning); not determined"
            if d.get("config_cert"):
                cr = certify.certify_configuration(
                    d["K_cert"], d["N"], d["M"], d["P"], d["config_cert"], d.get("witnesses"), d["score_cert"]
                )
                entry["certified_lower_bound"] = sqrt_down(-Fraction(d["K_cert"])) if cr["certified"] else None
                entry["K_cert"] = d["K_cert"]
                entry["config_cert"] = d["config_cert"]
                entry["certified"] = cr["certified"]
                if not cr["certified"]:
                    entry["certifier"] = cr.get("reason")
            ideal_out.append(entry)
        # a* is non-increasing in P (drop pieces), so a certified packing of P' >= P pieces also
        # certifies a* (N, M, P) >= its value
        groups = {}
        for e in ideal_out:
            groups.setdefault((e["N"], e["M"]), []).append(e)
        for es in groups.values():
            es.sort(key=lambda e: e["P"])
            best, src = None, None
            for e in reversed(es):
                v = e.get("certified_lower_bound")
                if v is not None and (best is None or v > best):
                    best, src = v, e["P"]
                if e.get("a_star") != "infinity" and best is not None:
                    if e.get("certified_lower_bound") is None or best > e["certified_lower_bound"]:
                        e["certified_lower_bound"] = best
                        e["lower_bound_from_P"] = src
        with open(os.path.join(out_dir, "ideal.json"), "w") as f:
            json.dump(
                {
                    "generated": TODAY,
                    "definition": "a*(N, M, P): sup side (radius for N = 0) of P congruent regular N-gons in the ideal regular M-gon at K = -1; P unit pieces fit in some finite regular M-gon at curvature K < 0 iff sqrt(-K) < a*",
                    "certificate": "certified_lower_bound a_c = sqrt(-K_cert): config_cert is a certified packing of P unit pieces in a finite M-gon at curvature K_cert",
                    "entries": ideal_out,
                },
                f,
                indent=1,
            )
        print(f"ideal entries: {len(ideal_out)}")


if __name__ == "__main__":
    main(sys.argv)
