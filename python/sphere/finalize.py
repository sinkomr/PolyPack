"""Build data/sphere/records.json and certification.json from the search runs.

For every problem sphere/N/P: take the best run (or an exact construction for P = 2), choose the
smallest certification margin eps in EPS such that the stored poses are PROVEN strictly valid at
rho_cert = rho_float (1 + eps) by python/sphere/certify.py, attach max-margin plane witnesses,
rigorous lower bounds (python/sphere/bounds.py) and literature values (data/sphere/literature.json).

Why no margin re-solve is needed on the whole sphere [CALC]: there is no container, and on the unit
sphere rho -> rho (1 + eps) shrinks every piece about its own centre (a -> a/(1 + eps)). A regular
polygon (or cap) of smaller size with the same centre and orientation lies in the interior of the
original one (its vertices lie on the open segments from the centre to the original vertices), so
touching pieces become strictly disjoint. The certifier does not rely on this argument; it checks
the stored configuration at rho_cert directly.

Usage: python3 python/sphere/finalize.py --runs RUN_DIR [RUN_DIR ...] --out data/sphere
"""
import argparse
import glob
import json
import math
import os
import sys
import time
from fractions import Fraction

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import bounds as bd  # noqa: E402
import certify as cert  # noqa: E402
import sgeom as sg  # noqa: E402

PI = math.pi
EPS = [1e-11, 3e-11, 1e-10, 3e-10, 1e-9, 1e-8]
SOFTWARE = "PolyPack sphere research build"
FOUND_BY = "PolyPack research"

REF = {
    "rankin1955": "R. A. Rankin, The closest packing of spherical caps in n dimensions, Proc. Glasgow Math. Assoc. 2 (1955) 139-144, doi:10.1017/S2040618500033219",
    "ft1943": "L. Fejes Toth, Uber die Abschatzung des kurzesten Abstandes zweier Punkte eines auf einer Kugelflache liegenden Punktsystems, Jber. Deutsch. Math.-Verein. 53 (1943) 66-68",
    "svdw1951": "K. Schutte and B. L. van der Waerden, Auf welcher Kugel haben 5, 6, 7, 8 oder 9 Punkte mit Mindestabstand Eins Platz?, Math. Ann. 123 (1951) 96-124, doi:10.1007/BF02054944",
    "danzer": "L. Danzer, Endliche Punktmengen auf der 2-Sphare mit moglichst grossem Minimalabstand, Habilitationsschrift, Gottingen 1963; English: Finite point-sets on S^2 with minimum distance as large as possible, Discrete Math. 60 (1986) 3-66, doi:10.1016/0012-365X(86)90002-6",
    "boroczky1983": "K. Boroczky, The problem of Tammes for n = 11, Studia Sci. Math. Hungar. 18 (1983) 165-171",
    "mt2012": "O. R. Musin and A. S. Tarasov, The strong thirteen spheres problem, Discrete Comput. Geom. 48 (2012) 128-141, doi:10.1007/s00454-011-9392-2",
    "mt2015": "O. R. Musin and A. S. Tarasov, The Tammes problem for N = 14, Exp. Math. 24 (2015) 460-468, doi:10.1080/10586458.2015.1022842",
    "robinson1961": "R. M. Robinson, Arrangement of 24 points on a sphere, Math. Ann. 144 (1961) 17-48, doi:10.1007/BF01396539",
}
PROVEN_TAMMES = {
    2: ["rankin1955"], 3: ["rankin1955", "ft1943"], 4: ["rankin1955", "ft1943"], 5: ["rankin1955", "svdw1951"],
    6: ["rankin1955", "ft1943"], 7: ["svdw1951"], 8: ["svdw1951"], 9: ["svdw1951"], 10: ["danzer"],
    11: ["danzer", "boroczky1983"], 12: ["ft1943"], 13: ["mt2012"], 14: ["mt2015"], 24: ["robinson1961"],
}
SMALL_TAMMES_COS = {2: Fraction(-1), 3: Fraction(-1, 2), 4: Fraction(-1, 3), 5: Fraction(0), 6: Fraction(0)}

# exact tilings (radial projections of the Platonic solids): rho = 1 / (edge angle)
TILINGS = {
    (3, 4): ("tetrahedron", lambda: 1 / math.acos(-1 / 3)),
    (3, 8): ("octahedron", lambda: 2 / PI),
    (3, 20): ("icosahedron", lambda: 1 / math.atan(2)),
    (4, 6): ("cube", lambda: 1 / math.acos(1 / 3)),
    (5, 12): ("dodecahedron", lambda: 1 / math.acos(math.sqrt(5) / 3)),
}


def _fmt6(n):
    s = str(n).rjust(7, "0")
    return s[:-6] + "." + s[-6:]


def next_up(x, eps):
    y = x * (1 + eps)
    while Fraction(y) < Fraction(x) * (1 + Fraction(eps)):
        y = math.nextafter(y, math.inf)
    return y


def lit_values(lit):
    tam = {}
    for P, c in SMALL_TAMMES_COS.items():
        tam[P] = {"cos": c, "src": "exact (P <= 6, Rankin 1955; " + ("trivial" if P == 2 else "regular simplex / cross-polytope") + ")"}
    for k, v in lit["tammes"]["values"].items():
        tam[int(k)] = {"cos": Fraction(v["cos_min_angle"]), "marked_optimal": v["marked_optimal"],
                       "src": "Cohn, Table of spherical codes (spherical-codes.org), accessed 2026-10-24", "refs": v["references"]}
    poly = {}
    for r in lit["dosv2026"]["rows"]:
        key = (r["N"], r["n"])
        poly.setdefault(key, []).append(r)
    return tam, poly


def site_run(r):
    """A raw search run in site units. Runs written before 2026-10-27 have no "units" tag and disks
    of radius 1: their rho is twice the diameter-1 value (exact halving; the poses do not change)."""
    if r["N"] == 0 and r.get("units") != "diameter":
        return {**r, "rho": r["rho"] / 2, "units": "diameter"}
    return r


def witnesses_for(N, P, a, Q):
    if N == 0:
        return []
    iu, ju, g, nrm = sg.pair_gaps(N, P, a, Q)
    return [[int(i), int(j)] + [float(c) for c in n] for i, j, n in zip(iu, ju, nrm)]


def build(N, P, rho_float, Q, meta, tam, poly):
    Q = [list(map(float, q)) for q in Q]
    notes = list(meta.get("notes", []))
    t0 = time.time()
    chosen = None
    for eps in EPS:
        rho_cert = next_up(rho_float, eps)
        a = sg.angle_of_rho(N, rho_cert)
        W = witnesses_for(N, P, a, np.array(Q))
        res = cert.certify_configuration(N, P, {"rho": rho_cert, "pieces": [{"q": q} for q in Q]}, W)
        if res["certified"]:
            chosen = (eps, rho_cert, W, res)
            break
    if chosen is None:
        return None, f"certification failed for every eps (last: {res.get('error')})"
    eps, rho_cert, W, res = chosen
    gap_rel = float((Fraction(rho_cert) - Fraction(rho_float)) / Fraction(rho_float))
    a_f = sg.angle_of_rho(N, rho_float)
    # ---------------- bounds
    blist = []

    def addb(kind, val, label, src=None, rigorous=True):
        # rigorous: proved here in interval arithmetic from the stated published theorem or elementary
        # argument; False: a published bound whose own computation was done in floating point
        if val is not None:
            blist.append({"kind": kind, "value": val, "label": label, "rigorous": rigorous, **({"source": src} if src else {})})

    if N == 0:
        addb("area", bd.area_bound(0, P), "CALC: P caps of angular radius 1/(2 rho) (diameter 1) have total area <= 4 pi")
        if P >= 3:
            addb("fejes_toth", bd.fejes_toth_disk_bound(P), "CALC from EST theorem: Fejes Toth 1943 bound on the minimal angle, rho >= 1/theta_FT", REF["ft1943"])
        if P in PROVEN_TAMMES and P in tam and P >= 3:
            addb("tammes_proven", bd.tammes_disk_bound(P, tam[P]["cos"]), "EST: published Tammes optimum, rho >= 1/theta_P", "; ".join(REF[k] for k in PROVEN_TAMMES[P]))
    else:
        addb("existence", bd.existence_bound(N), "CALC: a convex regular N-gon of side 1 needs rho > N/(2 pi)")
        addb("area", bd.area_bound(N, P), "CALC: P N-gons have total area <= 4 pi rho^2")
        if P >= 3:
            from mpmath import iv  # noqa
            ftc = bd._ft_cos_iv(P)
            addb("inradius_fejes_toth", bd.inradius_bound(N, P, ftc, bd.ft_cos(P)),
                 "CALC from EST theorem: the inscribed disks form a cap packing; Fejes Toth 1943 bound on its minimal angle", REF["ft1943"])
        if P in PROVEN_TAMMES and P in tam and P >= 3:
            c = tam[P]["cos"] - Fraction(1, 10 ** 11)
            addb("inradius_tammes", bd.inradius_bound(N, P, bd.I(c), float(c)),
                 "EST: inscribed disks against the published Tammes optimum for P points", "; ".join(REF[k] for k in PROVEN_TAMMES[P]))
        prev = poly.get((N, P - 1), [])
        for r in prev:
            if r["mark"] in ("†", "⋆") and "conjectured" not in r["remarks"]:
                # the volume bound alone settles maximality when it is below n + 1 (then the bound is
                # elementary, and weaker than our own area bound for P = n + 1); otherwise it rests on
                # their theta' / 3-point SDP values, computed in floating point ("can be rigorously
                # verified using standard techniques"), so it is not rigorous as published
                by_volume = float(r["volume_bound"]) < (P - 1) + 1 - 1e-6
                lab = (f"EST: de Oliveira Filho-Spomer-Vallentin 2026 show {P - 1} copies at circumradius {r['radius_rad_truncated']} (truncated) are maximal ({r['mark']}), so {P} copies need R < {r['radius_rad_truncated']} + 1e-6; "
                       + ("their printed volume bound " + r["volume_bound"] + " < " + str(P) + " already proves it (rigorous, implied by the area bound)" if by_volume
                          else "[EST, float-computed in the source]: the maximality rests on theta'/3-point SDP values computed in floating point, not rigorously verified in the paper"))
                addb("maximality_dosv2026", bd.maximality_bound(N, r["radius_rad_truncated"]), lab,
                     "arXiv:2604.21451, Table 2", rigorous=by_volume)
    rig = [b for b in blist if b["rigorous"]]
    best = max(rig, key=lambda b: b["value"]) if rig else None
    best_pub = max(blist, key=lambda b: b["value"]) if blist else None
    if best_pub is not None and best is not None and best_pub["value"] <= best["value"]:
        best_pub = None
    # ---------------- literature
    litrec = None
    status = "best_known"
    if N == 0 and P in tam:
        c = tam[P]["cos"]
        theta = math.acos(float(c))
        rho_lit = 1 / theta  # disks of diameter 1: rho = 1/(2a), theta = 2a
        litrec = {"quantity": "Tammes minimal angle", "cos_min_angle": str(tam[P]["cos"]) if P <= 6 else tam[P].get("refs") and str(float(c)),
                  "theta_deg": math.degrees(theta), "rho": rho_lit, "source": tam[P]["src"],
                  "rel_diff": (rho_float - rho_lit) / rho_lit}
        if P > 6:
            litrec["cos_min_angle"] = format(float(c), ".12f")
            litrec["marked_optimal_in_table"] = tam[P]["marked_optimal"]
        if P in PROVEN_TAMMES and abs(rho_float - rho_lit) <= 1e-9 * rho_lit:
            status = "proven"
            litrec["proof"] = [REF[k] for k in PROVEN_TAMMES[P]]
            notes.append("Optimal: matches the published Tammes optimum for P = %d within %.1e relative (proof: %s)." %
                         (P, abs(rho_float - rho_lit) / rho_lit, "; ".join(REF[k].split(",")[0] for k in PROVEN_TAMMES[P])))
        if P == 15:
            notes.append("Cohn's table marks P = 15 optimal, citing a 2026 Zenodo preprint (mt0-svg, doi:10.5281/zenodo.23450670); not a refereed publication, so the status stays best_known.")
    if N >= 3 and (N, P) in poly:
        rows = poly[(N, P)]
        r = max(rows, key=lambda r: float(r["radius_rad_truncated"]))
        R0 = float(r["radius_rad_truncated"])
        rho_hi = 1 / sg.a_from_R(N, R0)
        rho_lo = 1 / sg.a_from_R(N, R0 + 1e-6)
        R_ours = sg.R_from_a(N, a_f)
        R_ours_ = sg.R_from_a(N, a_f)
        if R_ours_ > R0 + 1e-5 and (N, P) in TILINGS:
            verdict = "tiling"  # classical tiling; the dOSV row is a weaker non-tiling configuration
        elif R_ours_ > R0 + 1e-5:
            verdict = "better"
        elif R_ours_ >= R0 - 1e-9:
            verdict = "same"  # within 1e-5 of the truncated value: presumably the same configuration
        else:
            verdict = "worse"
        litrec = {"quantity": "best circumradius found (rad, truncated to 6 decimals)", "radius": r["radius_rad_truncated"],
                  "mark": r["mark"], "remarks": r["remarks"], "rho_range": [rho_lo, rho_hi],
                  "our_circumradius": R_ours, "verdict": verdict,
                  "source": "de Oliveira Filho, Spomer, Vallentin, arXiv:2604.21451, Table 2 (https://arxiv.org/abs/2604.21451), accessed 2026-10-24",
                  "conversion": "rho = 1/a with sin(a/2) = sin(radius) sin(pi/N) (unit side on the sphere of radius rho)"}
        if len(rows) > 1:
            litrec["other_rows"] = [x["radius_rad_truncated"] + (" (" + x["remarks"] + ")" if x["remarks"] else "") for x in rows if x is not r]
    if N >= 3 and P >= 3 and best is not None and best["kind"].startswith("inradius") and rho_float <= best["value"] * (1 + 1e-9):
        src_t = "the Fejes Toth bound, sharp for P = 3, 4, 6, 12" if best["kind"] == "inradius_fejes_toth" else "the published Tammes optimum"
        notes.append(f"Meets the inscribed-disk bound to {rho_float / best['value'] - 1:.0e}: the inscribed disks form an optimal {P}-point Tammes code ({src_t}), so no larger pieces fit [CALC from EST]. Kept best_known (PolyPack's own derivation).")
    if N == 3 and P == 20:
        notes.append("Classical tiling, not listed by dOSV 2026: their 20-triangle row (circumradius 0.651805, marked maximal) is a weaker non-tiling configuration from manifold optimisation, not a typo (its printed volume bound 20.03839317 is 4 pi/area at R in [0.651805, 0.651806)) [CALC]. Not a new result.")
    if (N, P) in TILINGS:
        name, f = TILINGS[(N, P)]
        notes.append(f"Exact tiling: radial projection of the {name} (rho = {f():.15f}); meets the area bound P A = 4 pi rho^2 [CALC]. Optimal by the area argument, but kept best_known (PolyPack's own derivation).")
    if N >= 3 and P == 2:
        notes.append("Infimum, not attained: two antipodal pieces fit for every rho > N/(2 pi); at rho = N/(2 pi) the piece degenerates to a hemisphere (circumradius pi/2). Meets the existence bound and, in the limit, the area bound [CALC].")
    if N == 0 and P == 2:
        notes.append("Two closed hemispheres (angular radius pi/2) touching along the equator: rho = 1/pi exactly [CALC].")
    density = P * sg.area(N, a_f) / (4 * PI) if N == 0 or a_f < 2 * PI / N else 1.0
    rec = {
        "id": f"sphere/{N}/{P}", "N": N, "P": P,
        "score_float": rho_float, "score_cert": rho_cert, "display": cert.display_6(rho_cert),
        "gap_rel": gap_rel, "K_cert": 1 / rho_cert ** 2, "density_float": density,
        "status": status,
        "config": {"rho": rho_cert, "pieces": [{"q": q} for q in Q]},
        "certificate": {"file": "data/sphere/certification.json", "eps": eps, "witnesses": W,
                        "stats": res["stats"], "min_clearance": res["min_clearance"], "prec_bits": res["prec"]},
        "bound": best, "bounds": blist,
        **({"bound_published": best_pub} if best_pub else {}),
        "bound_gap_rel": (rho_float - best["value"]) / best["value"] if best else None,
        "literature": litrec,
        "method": meta.get("method"), "seed": meta.get("seed"), "budget": meta.get("budget"),
        "software": SOFTWARE, "found_by": FOUND_BY, "notes": notes,
    }
    return rec, None


def _fmt6_up(x):
    f = Fraction(x) * 10 ** 6
    n = -((-f.numerator) // f.denominator)
    return _fmt6(n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default=None, help="comma list N:P")
    args = ap.parse_args()
    lit = json.load(open(os.path.join(_HERE, "..", "..", "data", "sphere", "literature.json")))
    tam, poly = lit_values(lit)
    runs = {}
    for d in args.runs:
        for fn in glob.glob(os.path.join(d, "sphere_*_*.json")):
            r = site_run(json.load(open(fn)))
            key = (r["N"], r["P"])
            exact = str(r.get("method") or "").startswith("exact construction")
            if key in runs and str(runs[key].get("method") or "").startswith("exact construction"):
                continue  # a closed-form construction wins over float search results within 1e-11
            if key not in runs or exact or r["rho"] < runs[key]["rho"]:
                runs[key] = r
    # exact P = 2 constructions
    for N in (0, 3, 4, 5, 6, 8):
        runs[(N, 2)] = {"N": N, "P": 2, "rho": (1 / PI) if N == 0 else N / (2 * PI), "units": "diameter",
                        "q": [[1.0, 0, 0, 0], [0.0, 1.0, 0, 0]], "seed": None,
                        "budget": None, "method": "exact construction (antipodal pair)"}
    keys = sorted(runs)
    if args.only:
        want = {tuple(map(int, s.split(":"))) for s in args.only.split(",")}
        keys = [k for k in keys if k in want]
    records, failures, certs = [], [], []
    for (N, P) in keys:
        r = runs[(N, P)]
        rho = r["rho"]
        if (N, P) in TILINGS:
            exact = TILINGS[(N, P)][1]()
            if abs(rho - exact) <= 1e-11 * exact:
                rho = exact
        meta = {"seed": r.get("seed"), "budget": r.get("budget"),
                "method": r.get("method") or ("Tammes search: penalty continuation (L-BFGS-B) + SLSQP polish of max min angle, basin hopping" if N == 0 else
                                               "penalty continuation with separating-plane variables (L-BFGS-B), SLSQP polish with edge/plane witnesses in a box trust region, basin hopping; starts: Platonic face centres, previous P + 1 piece, best Tammes code, random")}
        t = time.time()
        rec, err = build(N, P, rho, r["q"], meta, tam, poly)
        if rec is None:
            failures.append({"N": N, "P": P, "error": err})
            print(f"N={N} P={P}: FAILED {err}", flush=True)
            continue
        records.append(rec)
        certs.append({"id": rec["id"], "certified": True, "rho_cert": rec["score_cert"], "eps": rec["certificate"]["eps"],
                      "stats": rec["certificate"]["stats"], "min_clearance": rec["certificate"]["min_clearance"],
                      "prec_bits": rec["certificate"]["prec_bits"]})
        lv = rec["literature"]
        print(f"N={N} P={P}: rho={rec['score_float']:.12f} cert={rec['display']} eps={rec['certificate']['eps']:.0e} "
              f"bound={rec['bound']['value'] if rec['bound'] else None} ({rec['bound']['kind'] if rec['bound'] else ''}) "
              f"lit={lv.get('verdict', lv.get('rel_diff')) if lv else None} status={rec['status']} ({time.time() - t:.1f}s)", flush=True)
    os.makedirs(args.out, exist_ok=True)
    out = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "units": "diameter",
        "conventions": {
            "problem_id": "sphere/N/P: P congruent pieces on the whole sphere of radius rho (no container); N = 0 disks of geodesic diameter 1, N >= 3 regular spherical N-gons of geodesic side 1",
            "score": "rho, the sphere radius (smaller is better); curvature K = 1/rho^2",
            "units": "lengths in units of the piece (side 1 / disk diameter 1); poses on the unit sphere",
            "pose": "q = [w, x, y, z] (any nonzero quaternion; the piece is G(standard piece), G = rotation of q/|q|, v -> q v q*). Standard piece: centre e3 = (0,0,1), vertex k at (sin R cos phi_k, sin R sin phi_k, cos R), phi_k = pi/2 + 2 pi k/N (vertex up = +y), sin(1/(2 rho)) = sin R sin(pi/N). Gauge: piece 0 has q = [1,0,0,0]. G = T(c) R_z(theta) recovers the curved package's (centre, theta) pose away from the south pole.",
            "validity": "interiors disjoint (touching allowed); score_cert is a radius at which the stored configuration is proven strictly valid by python/sphere/certify.py (mpmath intervals, 256 bits)",
            "display": "score_cert rounded to the nearest at 6 decimals (half-even, from its exact binary64 value)",
            "status": "proven only when a published proof establishes the optimum and the record matches it within the certification gap; best_known otherwise",
        },
        "records": records, "failures": failures,
    }
    json.dump(out, open(os.path.join(args.out, "records.json"), "w"), indent=1, allow_nan=False)
    json.dump({"summary": {"records": len(records), "certified": len(certs), "failed": len(failures),
                           "certifier": "python/sphere/certify.py", "precision_bits": 256},
               "results": certs}, open(os.path.join(args.out, "certification.json"), "w"), indent=1)
    print(f"{len(records)} records, {len(failures)} failures")


if __name__ == "__main__":
    main()
