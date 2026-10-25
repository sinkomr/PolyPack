"""Builds data/boundary/records.json: the 32 problems boundary/tesseract/{ball,cube}/{1..16}.

Each configuration (the research prototype's round-2 result in data/boundary/sources, or an exact
construction) is scaled about the tesseract's centre by lam_k = 1 + k 1e-12 for k = 1, 2, ...
(binary64 products s lam_k and u lam_k), and the first k at which python/boundary/certify.py proves
the stored floats strictly valid gives score_cert = s lam_k. Scaling the boundary by lam_k > 1
with the pieces kept at unit size is the same as shrinking every piece about its centre by
1/lam_k, which turns every contact of a valid packing into a gap (BOUNDARY.md 4.4).

Usage: python3 python/boundary/build_records.py [--out data/boundary/records.json]
Deterministic: the same sources give the same file.
"""

import argparse
import json
import math
import os
import sys
import time
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import certify as C  # noqa: E402
from mpmath import mp, mpf, cbrt, pi as mpi  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SOURCES = os.path.join(REPO, "data", "boundary", "sources", "research_round2.json")
GENERATED = "2026-10-25"
SQRT2 = math.sqrt(2)
MAX_K = 100000


def scaled(config, k):
    lam = 1 + k * 1e-12
    pieces = []
    for p in config["pieces"]:
        q = {"cell": p["cell"], "u": [x * lam for x in p["u"]]}
        if "q" in p:
            q["q"] = list(p["q"])
        pieces.append(q)
    return lam, {"s": config["s"] * lam, "pieces": pieces}


def ladder(pid, config):
    """The first k >= 1 at which the scaled configuration is strictly valid."""
    for k in range(1, MAX_K + 1):
        lam, cfg = scaled(config, k)
        v = C.check(pid, cfg, strict=True)
        if v.ok:
            return k, lam, cfg, C.summary(v)
    raise SystemExit(f"{pid}: not certified up to k = {MAX_K}")


def largest_float(check, approx):
    """The largest binary64 value x with check(Fraction(x)) true, near approx (check monotone)."""
    f = float(approx)
    while not check(Fraction(f)):
        f = math.nextafter(f, -math.inf)
    while check(Fraction(math.nextafter(f, math.inf))):
        f = math.nextafter(f, math.inf)
    return f


def bounds_of(piece, P):
    mp.dps = 50
    checks = {k: ok for k, _, ok in C.lower_bounds(piece, P)}
    if piece == "ball":
        vol = largest_float(checks["volume"], cbrt(P * mpi / 6))
        one = largest_float(checks["one piece"], mpf(2).sqrt())
        out = [
            {"kind": "volume", "value": vol, "exact": f"({P} pi/6)^(1/3)",
             "label": "[CALC] volume: the developed balls have disjoint interiors, so P (4 pi/3) <= 8 s^3", "rigorous": True},
            {"kind": "one piece", "value": one, "exact": "sqrt 2",
             "label": "[CALC] one ball: its centre must be at distance >= 1 from the edges, and every point of a cell lies within s/sqrt 2 of the cell's edges", "rigorous": True},
        ]
    else:
        vol = largest_float(checks["volume"], cbrt(mpf(P) / 8))
        one = largest_float(checks["one piece"], 1 / mpf(2).sqrt())
        out = [
            {"kind": "volume", "value": vol, "exact": f"({P}/8)^(1/3)",
             "label": "[CALC] volume: the developed cubes have disjoint interiors, so P <= 8 s^3", "rigorous": True},
            {"kind": "one piece", "value": one, "exact": "1/sqrt 2",
             "label": "[CALC] inscribed ball: the ball of radius 1/2 inside a cube must avoid the edges, and every point of a cell lies within s/sqrt 2 of the cell's edges", "rigorous": True},
        ]
    best = max(out, key=lambda b: b["value"])
    return dict(best), out


def nofold_of(piece, P):
    k = -(-P // 8)
    if piece == "ball":
        if k == 1:
            return {"value": 2.0, "exact": "2", "pieces_per_cell": 1,
                    "source": "[CALC] one unit ball per cell; a unit ball in a cube needs edge 2 (its centre is at distance >= 1 from every face)"}
        return {"value": 2 + 2 / math.sqrt(3), "exact": "2 + 2/sqrt 3", "pieces_per_cell": 2,
                "source": ("[CALC] two unit balls in one cell: their centres lie in the inner cube of edge s - 2, whose diameter "
                           "sqrt 3 (s - 2) must be >= 2; equality on a main diagonal. nofold(P) = f(ceil(P/8)) (BOUNDARY.md 6)")}
    if k == 1:
        return {"value": 1.0, "exact": "1", "pieces_per_cell": 1,
                "source": "[CALC] one unit cube per cell, filling it; a cube of edge < 1 holds no unit cube"}
    return {"value": 2.0, "exact": "2", "pieces_per_cell": 2,
            "source": ("[EST] two unit cubes in a cube need edge 2: the cube-in-cube table of polyhedrainpolyhedra.wiki "
                       "(n = 2), as cited by the PolyPack research note of 2026-10-24; upper bound [CALC] two cubes side by side. "
                       "nofold(P) = f(ceil(P/8)) (BOUNDARY.md 6)")}


def exact_configs():
    out = {}
    out[("ball", 1)] = ({"s": SQRT2, "pieces": [{"cell": 0, "u": [0.0, 0.0, 0.0]}]},
                        "exact construction: a unit ball at the centre of cell 0, s = sqrt 2 (score_float is the binary64 value of sqrt 2)")
    out[("ball", 2)] = ({"s": SQRT2, "pieces": [{"cell": 0, "u": [0.0, 0.0, 0.0]}, {"cell": 1, "u": [0.0, 0.0, 0.0]}]},
                        "exact construction: unit balls at the centres of the opposite cells 0 and 1, s = sqrt 2")
    for P in range(1, 9):
        out[("cube", P)] = ({"s": 1.0, "pieces": [{"cell": c, "u": [0.0, 0.0, 0.0]} for c in range(P)]},
                            "exact construction: one axis-aligned unit cube filling each of the cells 0 to P-1, s = 1")
    return out


def research_config(entry):
    return {"s": entry["s"], "pieces": [{"cell": c, "u": list(u)} for c, u in zip(entry["cells"], entry["U"])]}


def build():
    with open(SOURCES) as fh:
        src = json.load(fh)
    exact = exact_configs()
    records = []
    for piece in ("ball", "cube"):
        for P in range(1, 17):
            pid = f"boundary/tesseract/{piece}/{P}"
            t0 = time.time()
            notes = []
            if (piece, P) in exact:
                config, method = exact[(piece, P)]
                prov = {"source": "PolyPack research note, 2026-10-24 (exact constructions, section 3)", "date": "2026-10-24", "kind": "exact"}
                seed = None
                budget = None
            else:
                e = src["balls" if piece == "ball" else "cubes"][str(P)]
                config = research_config(e)
                if piece == "ball":
                    other = e["sB"] if e["seed"] == e["seeds"][0] else e["sA"]
                    method = ("research prototype, round 2 (balls_round2.py): two independent seeds; per seed a 60 s screen "
                              "(random starts, the P-1 packing plus a ball, hops; penalty compression with exact lattice-word "
                              "distances and closed-form clearance, L-BFGS-B with re-charting across faces), then up to two "
                              "40 s rounds while the seeds differ by more than 1e-6 relative; the better seed's packing "
                              "polished by bisection on s to 1e-10")
                    prov = {"source": "PolyPack research, round 2", "date": "2026-10-24", "kind": "search",
                            "program": "balls_round2.py", "seed": e["seed"], "seeds": e["seeds"], "other_seed_score": other,
                            "seeds_rel_spread": e["rel_spread"], "file": f"data/boundary/sources/research_round2.json#balls/{P}"}
                    seed = e["seed"]
                    budget = {"screen_s": e["screen_s"], "extra_rounds": e["extra_rounds"], "extra_s": e["extra_s"],
                              "starts": [e["startsA"], e["startsB"]], "wall_s": round(e["wall_s"], 1)}
                    if e["rel_spread"] <= 1e-6:
                        notes.append(f"Two independent seeds ({e['seeds'][0]}, {e['seeds'][1]}) agree to {e['rel_spread']:.1e} relative: evidence of the best basin found, not a proof.")
                    else:
                        notes.append(f"Not converged: the two seeds ({e['seeds'][0]}, {e['seeds'][1]}) differ by {e['rel_spread']:.1e} relative; an upper bound only.")
                else:
                    method = ("research prototype, round 2 (cubes_aligned.py): axis-aligned cubes in any cells crossing faces "
                              "in any direction (box parts, exact penetration and line-crossing energy, L-BFGS-B with "
                              "re-charting, compression; starts from the two-rings layout, random, hops); one seed per P range")
                    prov = {"source": "PolyPack research, round 2", "date": "2026-10-24", "kind": "search",
                            "program": "cubes_aligned.py", "seed": e["seed"], "file": f"data/boundary/sources/research_round2.json#cubes/{P}"}
                    seed = e["seed"]
                    budget = {"seconds": e["seconds"], "starts": e["starts"]}
            k, lam, cfg, cert = ladder(pid, config)
            sc = cfg["s"]
            bound, bounds = bounds_of(piece, P)
            nofold = nofold_of(piece, P)
            secs = time.time() - t0  # printed only: the records file stays deterministic
            cert.update({"k": k, "lambda": lam, "rule": "first k >= 1 with s lam_k, u lam_k strictly valid, lam_k = 1 + k 1e-12 (binary64)"})
            gap = sc / bound["value"] - 1
            if gap < 1e-9:
                why = " (the 8 cubes fill the boundary)" if piece == "cube" else ""
                notes.append(f"[CALC] Meets its lower bound {bound['exact']} ({bound['kind']}){why}: score_cert / bound - 1 = {gap:.1e}. The bound is derived in BOUNDARY.md section 5, not taken from a published proof, so the status stays best_known.")
            if (piece, P) == ("ball", 4):
                d = config["s"] - (1 + 1 / math.sqrt(2))
                notes.append(f"[SPEC] The value looks like exactly 1 + 1/sqrt 2 = 1.707107 (score_float is {d:.1e} above it); no exact construction or matching lower bound is known, so the status stays best_known.")
            if piece == "cube" and P < 8:
                notes.append("[CALC] One cube per cell at s = 1. A search found no unit cube on a tesseract of edge below 1 (numerical evidence, research note section 4); the proven bound is only " + ("1/sqrt 2." if P <= 2 else f"({P}/8)^(1/3)."))
            if piece == "cube" and P > 8:
                for name, val in (("5/4", 1.25), ("4/3", 4 / 3), ("3/2", 1.5)):
                    if 0 < config["s"] - val < 1e-6:
                        notes.append(f"[SPEC] score_float is {config['s'] - val:.1e} above {name}; an exact construction at {name} is likely but was not extracted.")
            notes.append(f"Certified strictly valid at score_cert = s (1 + {k}e-12) by python/boundary/certify.py (exact rational arithmetic).")
            rec = {
                "id": pid,
                "polytope": "tesseract",
                "piece": piece,
                "P": P,
                "score_float": config["s"],
                "score_cert": sc,
                "display": C.display_6(sc),
                "gap_rel": sc / config["s"] - 1,
                "status": "best_known",
                "config": cfg,
                "certificate": cert,
                "bound": bound,
                "bounds": bounds,
                "bound_gap_rel": gap,
                "nofold": nofold,
                "fold_gain": 1 - config["s"] / nofold["value"],
                "method": method,
                "seed": seed,
                "budget": budget,
                "provenance": prov,
                "software": "PolyPack boundary research prototype (float search); certified by python/boundary/certify.py",
                "found_by": "PolyPack research",
                "notes": notes,
            }
            errs = C.published_errors(rec)
            if errs:
                raise SystemExit(f"{pid}: {errs}")
            print(f"{pid}: k = {k}, score_cert {sc!r} ({rec['display']}), bound {bound['value']:.6f} ({bound['kind']}), "
                  f"nofold {nofold['value']:.6f}, gain {100 * rec['fold_gain']:.1f}%, {secs:.2f} s", flush=True)
            records.append(rec)
    return {
        "generated": GENERATED,
        "conventions": {
            "problem_id": "boundary/<polytope>/<piece>/<P>: P congruent pieces on the boundary of a convex 4-polytope; polytope tesseract; piece ball (unit 3-ball, radius 1) or cube (unit cube, edge 1)",
            "score": "s, the polytope's edge (smaller is better)",
            "cells": "the tesseract is [-s/2, s/2]^4; cell 2 i + (sigma > 0) is the cube x_i = sigma s/2 (i = 0..3, sigma = -1 or +1)",
            "pose": "{cell, u, q?}: u = the centre in the cell's local coordinates at s (the other three R^4 coordinates in increasing order, the cell's centre at the origin), in the closed cell; q = rotation (unit quaternion w, x, y, z) of a cube in that frame, absent = axis-aligned; balls have no q",
            "validity": "fold placement: each piece is developed from its centre across 2-faces; no point of the edges or vertices in a piece's interior; developments injective on interiors; interiors of distinct pieces disjoint (touching allowed)",
            "certified_statement": "config is at s = score_cert; python/boundary/certify.py proves it strictly valid in exact rational arithmetic (closed pieces avoid the edges and vertices, are embedded and pairwise disjoint)",
            "score_cert": "s lam_k for the first k >= 1 with lam_k = 1 + k 1e-12 at which the scaled configuration (s lam_k, u lam_k, binary64 products) certifies; score_float = the unscaled s",
            "certificate": "the certifier's exact margins at score_cert, rounded down to binary64: balls min_clearance (to the edges), min_distance (over the pairs at most 2 apart in R^4; null when there is none, so all centres are more than 2 apart), min_loop (null: no geodesic loop shorter than 2 s); cubes min_edge_slack (per cube the second smallest of h - |u_l| - 1/2 over its three axes, positive when it crosses faces in at most one axis and keeps clear of the edges; least over the cubes) and min_part_separation (per pair of parts in one cell the largest gap over the axes; least over the pairs); k and lambda of the scaling",
            "display": "score_cert rounded to the nearest at 6 decimals (half-even, from its exact binary64 value)",
            "bound": "the larger proven lower bound on s: volume, or one piece (sqrt 2 for balls, 1/sqrt 2 for cubes), as a binary64 value rounded down",
            "nofold": "the best value when every piece must lie in one closed cell: f(ceil(P/8)), the smallest cube holding ceil(P/8) pieces",
            "fold_gain": "1 - score_float / nofold.value",
            "status": "best_known everywhere: PolyPack calls a value proven only with a published proof",
        },
        "records": records,
    }


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=os.path.join(REPO, "data", "boundary", "records.json"))
    args = ap.parse_args(argv)
    t0 = time.time()
    data = build()
    with open(args.out, "w") as fh:
        json.dump(data, fh, indent=1)
        fh.write("\n")
    print(f"wrote {len(data['records'])} records to {os.path.relpath(args.out, REPO)} in {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main(sys.argv[1:])
