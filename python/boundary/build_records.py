"""Builds data/boundary/records.json: the 32 problems boundary/tesseract/{ball,cube}/{1..16}.

Units (2026-10-27): the records are in site units, where a ball has diameter 1. The research prototype's and the search's
ball results (data/boundary/sources) are in the radius-1 units they were found in; they are halved exactly on read
(half_ball), which keeps every certificate and scaling rule (s lam_k, u lam_k are binary64 products, and halving
commutes with them), so a ball record is the old record with every length halved. Cube records are unchanged.

Candidates per problem, all binary64 configurations:
  * the exact constructions of the research note (one ball at a cell centre, opposite balls, one
    cube per cell);
  * the research prototype's round-2 result (data/boundary/sources/research_round2.json);
  * the PolyPack boundary search's result (data/boundary/sources/search_2026-10-25.json);
  * exact versions of those: cube layouts whose value is within 1e-5 of 5/4, 4/3 or 3/2, with
    every coordinate within 1e-6 of a multiple of 1/24 snapped to it, when they are valid at
    exactly that edge (rational arithmetic); and the two ball layouts with every coordinate
    +-a, a = (2 - sqrt 2)/8 (P = 4, s = (1 + 1/sqrt 2)/2) and a = sin 15 deg / 2 (P = 8,
    s = cos 15 deg), when they are valid at exactly that edge (arithmetic in Q(sqrt 2, sqrt 3));
    the stored float configuration is then the exact one rounded to binary64;
  * the record for P + 1 with its last piece removed (a subset of a valid packing is valid).
Each candidate is scaled about the tesseract's centre by lam_k = 1 + k 1e-12 for k = 1, 2, ...
(binary64 products s lam_k and u lam_k), and the first k at which python/boundary/certify.py
proves the stored floats strictly valid gives its score_cert = s lam_k. Scaling the boundary by
lam_k > 1 with the pieces kept at unit size shrinks every piece about its centre by 1/lam_k, which
turns every contact of a valid packing into a gap (BOUNDARY.md 4.4). The record is the candidate
with the smallest score_cert (ties: exact, then search, then research, then P + 1 minus a piece).

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
from qfield import COS15, SIN15, Q23  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
RESEARCH = os.path.join(REPO, "data", "boundary", "sources", "research_round2.json")
SEARCH = os.path.join(REPO, "data", "boundary", "sources", "search_2026-10-25.json")
GENERATED = "2026-10-27"
SQRT2 = math.sqrt(2)
MAX_K = 100000
GRID = Fraction(1, 24)  # contains the 1/8, 1/6 and 1/4 grids of the cube layouts
CUBE_TARGETS = ((Fraction(5, 4), "5/4"), (Fraction(4, 3), "4/3"), (Fraction(3, 2), "3/2"))
# ball layouts with every coordinate +-a: (P, a, s, text)
BALL_FORMS = (
    (4, Q23(Fraction(1, 4), Fraction(-1, 8)), Q23(Fraction(1, 2), Fraction(1, 4)), "s = (1 + 1/sqrt 2)/2 = 0.853553, every coordinate +-(2 - sqrt 2)/8"),
    (8, SIN15 / 2, COS15, "s = cos 15 deg = (sqrt 6 + sqrt 2)/4 = 0.965926, every coordinate +-sin 15 deg / 2 = +-(sqrt 6 - sqrt 2)/8"),
)
PRIORITY = {"exact": 0, "search": 1, "research": 2, "subset": 3}

RESEARCH_BALL_METHOD = (
    "research prototype, round 2 (balls_round2.py): two independent seeds; per seed a 60 s screen (random starts, "
    "the P-1 packing plus a ball, hops; penalty compression with exact lattice-word distances and closed-form "
    "clearance, L-BFGS-B with re-charting across faces), then up to two 40 s rounds while the seeds differ by more "
    "than 1e-6 relative; the better seed's packing polished by bisection on s to 1e-10")
RESEARCH_CUBE_METHOD = (
    "research prototype, round 2 (cubes_aligned.py): axis-aligned cubes in any cells crossing faces in any direction "
    "(box parts, exact penetration and line-crossing energy, L-BFGS-B with re-charting, compression; starts from the "
    "two-rings layout, random, hops); one seed per P range")
SEARCH_METHOD = (
    "PolyPack boundary search (packages/boundary/src/search): penalty relaxation over exact tesseract geodesics "
    "(balls) or box parts (aligned cubes), L-BFGS in cell charts, compression of s, random starts and hops, final "
    "polish valid at tolerance 0; one deterministic call {call}")


def half_ball(config):
    """A ball configuration of the sources (balls of radius 1) in site units (diameter 1): every length halved, exactly."""
    return {"s": config["s"] / 2, "pieces": [dict(p, u=[x / 2 for x in p["u"]]) for p in config["pieces"]]}


def scaled(config, k):
    lam = 1 + k * 1e-12
    pieces = []
    for p in config["pieces"]:
        q = {"cell": p["cell"], "u": [x * lam for x in p["u"]]}
        if "q" in p:
            q["q"] = list(p["q"])
        pieces.append(q)
    return lam, {"s": config["s"] * lam, "pieces": pieces}


def ladder(pid, config, max_k=MAX_K):
    """The first k >= 1 at which the scaled configuration is strictly valid, or None."""
    for k in range(1, max_k + 1):
        lam, cfg = scaled(config, k)
        v = C.check(pid, cfg, strict=True)
        if v.ok:
            return k, lam, cfg, C.summary(v)
    return None


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
        vol = largest_float(checks["volume"], cbrt(P * mpi / 48))
        one = largest_float(checks["one piece"], 1 / mpf(2).sqrt())
        out = [
            {"kind": "volume", "value": vol, "exact": f"({P} pi/48)^(1/3)",
             "label": "[CALC] volume: the developed balls have disjoint interiors, so P (pi/6) <= 8 s^3", "rigorous": True},
            {"kind": "one piece", "value": one, "exact": "1/sqrt 2",
             "label": "[CALC] one ball: its centre must be at distance >= 1/2 from the edges, and every point of a cell lies within s/sqrt 2 of the cell's edges", "rigorous": True},
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
            return {"value": 1.0, "exact": "1", "pieces_per_cell": 1,
                    "source": "[CALC] one ball of diameter 1 per cell; a ball in a cube needs edge 1 (its centre is at distance >= 1/2 from every face)"}
        # (2 + 2/sqrt 3) / 2 as a binary64 expression: exactly half of the value for balls of radius 1
        return {"value": (2 + 2 / math.sqrt(3)) / 2, "exact": "1 + 1/sqrt 3", "pieces_per_cell": 2,
                "source": ("[CALC] two balls of diameter 1 in one cell: their centres lie in the inner cube of edge s - 1, whose diameter "
                           "sqrt 3 (s - 1) must be >= 1; equality on a main diagonal. nofold(P) = f(ceil(P/8)) (BOUNDARY.md 6)")}
    if k == 1:
        return {"value": 1.0, "exact": "1", "pieces_per_cell": 1,
                "source": "[CALC] one unit cube per cell, filling it; a cube of edge < 1 holds no unit cube"}
    return {"value": 2.0, "exact": "2", "pieces_per_cell": 2,
            "source": ("[EST] two unit cubes in a cube need edge 2: the cube-in-cube table of polyhedrainpolyhedra.wiki "
                       "(n = 2), as cited by the PolyPack research note of 2026-10-24; upper bound [CALC] two cubes side by side. "
                       "nofold(P) = f(ceil(P/8)) (BOUNDARY.md 6)")}


def exact_configs():
    out = {}
    out[("ball", 1)] = ({"s": SQRT2 / 2, "pieces": [{"cell": 0, "u": [0.0, 0.0, 0.0]}]},
                        "exact construction: a ball at the centre of cell 0, s = sqrt 2 / 2 (score_float is the binary64 value of sqrt 2 / 2)")
    out[("ball", 2)] = ({"s": SQRT2 / 2, "pieces": [{"cell": 0, "u": [0.0, 0.0, 0.0]}, {"cell": 1, "u": [0.0, 0.0, 0.0]}]},
                        "exact construction: balls at the centres of the opposite cells 0 and 1, s = sqrt 2 / 2")
    for P in range(1, 9):
        out[("cube", P)] = ({"s": 1.0, "pieces": [{"cell": c, "u": [0.0, 0.0, 0.0]} for c in range(P)]},
                            "exact construction: one axis-aligned unit cube filling each of the cells 0 to P-1, s = 1")
    return out


def research_config(entry):
    return {"s": entry["s"], "pieces": [{"cell": c, "u": list(u)} for c, u in zip(entry["cells"], entry["U"])]}


# ------------------------------------------------------------------ candidates


def research_candidate(piece, P, e):
    if piece == "ball":
        other = (e["sB"] if e["seed"] == e["seeds"][0] else e["sA"]) / 2
        prov = {"source": "PolyPack research, round 2", "date": "2026-10-24", "kind": "search", "program": "balls_round2.py",
                "seed": e["seed"], "seeds": e["seeds"], "other_seed_score": other, "seeds_rel_spread": e["rel_spread"],
                "file": f"data/boundary/sources/research_round2.json#balls/{P}",
                "units": "the source is in balls of radius 1; lengths here are exactly half of it (diameter 1)"}
        budget = {"screen_s": e["screen_s"], "extra_rounds": e["extra_rounds"], "extra_s": e["extra_s"],
                  "starts": [e["startsA"], e["startsB"]], "wall_s": round(e["wall_s"], 1)}
        if e["rel_spread"] <= 1e-6:
            note = f"The research search's two independent seeds ({e['seeds'][0]}, {e['seeds'][1]}) agree to {e['rel_spread']:.1e} relative: evidence of the best basin found, not a proof."
        else:
            note = f"Not converged: the research search's two seeds ({e['seeds'][0]}, {e['seeds'][1]}) differ by {e['rel_spread']:.1e} relative; an upper bound only."
        return dict(kind="research", config=half_ball(research_config(e)), method=RESEARCH_BALL_METHOD, seed=e["seed"], budget=budget,
                    provenance=prov, notes=[note], software="PolyPack boundary research prototype (float search)", found_by="PolyPack research")
    prov = {"source": "PolyPack research, round 2", "date": "2026-10-24", "kind": "search", "program": "cubes_aligned.py",
            "seed": e["seed"], "file": f"data/boundary/sources/research_round2.json#cubes/{P}"}
    return dict(kind="research", config=research_config(e), method=RESEARCH_CUBE_METHOD, seed=e["seed"],
                budget={"seconds": e["seconds"], "starts": e["starts"]}, provenance=prov, notes=[],
                software="PolyPack boundary research prototype (float search)", found_by="PolyPack research")


def search_candidate(piece, P, e):
    ball = piece == "ball"
    prov = {"source": "PolyPack boundary search", "method": e["method"], "date": e["date"], "kind": "search",
            "call": e["call"], "seed": e["seed"], "evals": e["evals_budget"], "value": e["value"] / 2 if ball else e["value"],
            "file": f"data/boundary/sources/search_2026-10-25.json#{piece}/{P}"}
    if ball:
        prov["units"] = "the source is in balls of radius 1; lengths here are exactly half of it (diameter 1)"
    budget = {"evals": e["evals_budget"], "evals_used": e["evals_used"], "ended": e["ended"], "starts": e["starts"], "wall_s": e["wall_s"]}
    return dict(kind="search", config=half_ball(e["config"]) if ball else e["config"], method=SEARCH_METHOD.format(call=e["call"]), seed=e["seed"], budget=budget,
                provenance=prov, notes=[], software="PolyPack boundary search (packages/boundary/src/search)", found_by="PolyPack boundary search")


def snapped_cube(pid, base):
    """The exact version of a cube candidate at 5/4, 4/3 or 3/2, if valid there; else None."""
    s = Fraction(base["config"]["s"])
    for t, name in CUBE_TARGETS:
        if abs(s / t - 1) > Fraction(1, 10 ** 5):
            continue
        pieces = []
        snapped = 0
        for p in base["config"]["pieces"]:
            u = []
            for x in p["u"]:
                y = Fraction(x) * t / s
                n = round(y / GRID)
                if abs(y - n * GRID) <= Fraction(1, 10 ** 6):
                    u.append(n * GRID)
                    snapped += 1
                else:
                    u.append(Fraction(float(y)))  # a coordinate with slack, kept as a binary64 value
            pieces.append({"cell": p["cell"], "u": u})
        jsonp = [{"cell": p["cell"], "u": [str(x) if x.denominator & (x.denominator - 1) else float(x) for x in p["u"]]} for p in pieces]
        exact = {"field": "Q", "s": name, "pieces": jsonp,
                 "statement": f"valid at exactly s = {name} (touching allowed), certified in rational arithmetic"}
        ok, _, _, _ = C.check_exact(pid, exact)
        if not ok:
            continue
        cfg = {"s": float(t), "pieces": [{"cell": p["cell"], "u": [float(x) for x in p["u"]]} for p in pieces]}
        c = dict(base)
        c.update(kind="exact", config=cfg, exact=exact, exact_value=name,
                 provenance=dict(base["provenance"], exact=f"snapped to exact s = {name}: {snapped} coordinates within 1e-6 of a multiple of 1/24 moved onto it, the others kept"),
                 notes=list(base["notes"]) + [
                     f"[CALC] Exact construction at s = {name}: the {base['kind']} layout scaled to {name}, with every coordinate within 1e-6 of a "
                     f"multiple of 1/24 snapped to it ({snapped} of {3 * len(pieces)}), is valid at exactly s = {name} (rational arithmetic; field exact). "
                     f"The stored configuration is that construction in binary64."])
        return c
    return None


def ball_form(pid, P, base):
    """The exact Q(sqrt 2, sqrt 3) version of a ball candidate of the BALL_FORMS kind, if valid; else None."""
    for (Pf, a, s, text) in BALL_FORMS:
        if Pf != P:
            continue
        cfg = base["config"]
        if abs(cfg["s"] - float(s)) > 1e-8 or any(abs(abs(x) - float(a)) > 1e-8 for p in cfg["pieces"] for x in p["u"]):
            return None
        pieces = [{"cell": p["cell"], "u": [(a if x > 0 else -a).to_json() for x in p["u"]]} for p in cfg["pieces"]]
        exact = {"field": "Q(sqrt 2, sqrt 3)", "s": s.to_json(), "pieces": pieces,
                 "statement": f"valid at exactly {text} (signs and cells of the stored configuration); certified in Q(sqrt 2, sqrt 3), elements [a, b, c, d] = a + b sqrt 2 + c sqrt 3 + d sqrt 6"}
        ok, _, margins, _ = C.check_exact(pid, exact)
        if not ok:
            return None
        sf = to_float(s)
        af = to_float(a)
        fcfg = {"s": sf, "pieces": [{"cell": p["cell"], "u": [af if x > 0 else -af for x in p["u"]]} for p in cfg["pieces"]]}
        c = dict(base)
        c.update(kind="exact", config=fcfg, exact=exact, exact_value=text.split(",")[0],
                 provenance=dict(base["provenance"], exact=f"exact form of the {base['kind']} layout: {text}"),
                 notes=list(base["notes"]) + [
                     f"[CALC] Exact construction: {text}, in the cells of the {base['kind']} layout, is valid at exactly that s: every clearance is exactly 1/2 "
                     f"(h - a = 1/(2 sqrt 2) in every axis) and the least centre distance is exactly 1 (certified in Q(sqrt 2, sqrt 3); field exact). "
                     f"The stored configuration is that construction in binary64. [SPEC] that this s is the optimum: no matching lower bound is known."])
        return c
    return None


def to_float(x):
    """A Q(sqrt 2, sqrt 3) element rounded to binary64 (via 50 digits)."""
    mp.dps = 50
    q = lambda f: mpf(Fraction(f).numerator) / Fraction(f).denominator  # noqa: E731
    return float(q(x.a) + q(x.b) * mpf(2).sqrt() + q(x.c) * mpf(3).sqrt() + q(x.d) * mpf(6).sqrt())


def subset_of(parent_rec, parent_cand):
    """The P + 1 record's candidate with its last piece removed."""
    base = parent_cand["config"]
    cfg = {"s": base["s"], "pieces": [dict(p) for p in base["pieces"][:-1]]}
    c = dict(parent_cand)
    c.update(kind="subset", config=cfg,
             provenance={"kind": "subset", "from": parent_rec["id"], "dropped": "its last piece", "parent": parent_cand["provenance"]},
             method=f"the record for {parent_rec['id']} with its last piece removed; that record: {parent_cand['method']}",
             notes=[f"The record for {parent_rec['id']} with its last piece removed (a subset of a valid packing is valid)."])
    if parent_cand.get("exact"):
        ex = dict(parent_cand["exact"])
        ex["pieces"] = ex["pieces"][:-1]
        c["exact"] = ex
        c["notes"] = c["notes"] + [f"[CALC] Exact construction at s = {parent_cand['exact_value']}: the exact construction of {parent_rec['id']} without its last piece (field exact)."]
    return c


# ------------------------------------------------------------------ build


def build(bases=None):
    """The records file's content. If `bases` is a dict, it receives each record's unscaled
    configuration (the chosen candidate's) by id, for tests of the scaling rule."""
    with open(RESEARCH) as fh:
        research = json.load(fh)
    with open(SEARCH) as fh:
        search = json.load(fh)["runs"]
    exact = exact_configs()
    by_piece = {}
    for piece in ("ball", "cube"):
        chosen = {}
        for P in range(16, 0, -1):
            pid = f"boundary/tesseract/{piece}/{P}"
            t0 = time.time()
            cands = []
            if (piece, P) in exact:
                config, method = exact[(piece, P)]
                cands.append(dict(kind="exact", config=config, method=method, seed=None, budget=None,
                                  provenance={"source": "PolyPack research note, 2026-10-24 (exact constructions, section 3)", "date": "2026-10-24", "kind": "exact"},
                                  notes=[], software="PolyPack boundary research note", found_by="PolyPack research"))
            e = research["balls" if piece == "ball" else "cubes"].get(str(P))
            res_cand = research_candidate(piece, P, e) if e else None
            if res_cand:
                cands.append(res_cand)
            se = search.get(f"{piece}/{P}")
            if se:
                cands.append(search_candidate(piece, P, se))
            for base in [c for c in cands if c["kind"] in ("research", "search")]:
                ex = snapped_cube(pid, base) if piece == "cube" else ball_form(pid, P, base)
                if ex:
                    cands.append(ex)
            if P + 1 in chosen:
                cands.append(subset_of(*chosen[P + 1]))
            results = []
            for c in cands:
                r = ladder(pid, c["config"], max_k=1000)
                if r is None:
                    print(f"  {pid}: a {c['kind']} candidate did not certify up to k = 1000", flush=True)
                    continue
                results.append((r[2]["s"], PRIORITY[c["kind"]], c, r))
            if not results:
                raise SystemExit(f"{pid}: no candidate certified")
            results.sort(key=lambda t: (t[0], t[1]))
            sc, _, cand, (k, lam, cfg, cert) = results[0]
            prev = None
            rr = next((t for t in results if t[2] is res_cand), None) if res_cand is not None and cand is not res_cand else None
            if rr is not None:
                prev = {"source": "PolyPack research, round 2", "score_float": res_cand["config"]["s"], "score_cert": rr[0],
                        "display": C.display_6(rr[0]), "k": rr[3][0], "file": res_cand["provenance"]["file"],
                        "improvement_rel": 1 - sc / rr[0]}
            rec = make_record(piece, P, cand, k, lam, cfg, cert, prev)
            chosen[P] = (rec, cand)
            if bases is not None:
                bases[pid] = cand["config"]
            secs = time.time() - t0
            tags = ", ".join(f"{t[2]['kind']} {t[0]:.12f}" for t in results)
            print(f"{pid}: {cand['kind']} k = {k}, score_cert {sc!r} ({rec['display']}){'' if prev is None else ', previous %s (%.2e better)' % (prev['display'], prev['improvement_rel'])}; candidates: {tags}; {secs:.2f} s", flush=True)
        by_piece[piece] = [chosen[P][0] for P in range(1, 17)]
    return {
        "generated": GENERATED,
        "units": "diameter",
        "conventions": {
            "problem_id": "boundary/<polytope>/<piece>/<P>: P congruent pieces on the boundary of a convex 4-polytope; polytope tesseract; piece ball (3-ball of diameter 1, radius 1/2) or cube (unit cube, edge 1)",
            "score": "s, the polytope's edge (smaller is better)",
            "cells": "the tesseract is [-s/2, s/2]^4; cell 2 i + (sigma > 0) is the cube x_i = sigma s/2 (i = 0..3, sigma = -1 or +1)",
            "pose": "{cell, u, q?}: u = the centre in the cell's local coordinates at s (the other three R^4 coordinates in increasing order, the cell's centre at the origin), in the closed cell; q = rotation (unit quaternion w, x, y, z) of a cube in that frame, absent = axis-aligned; balls have no q",
            "validity": "fold placement: each piece is developed from its centre across 2-faces; no point of the edges or vertices in a piece's interior; developments injective on interiors; interiors of distinct pieces disjoint (touching allowed)",
            "certified_statement": "config is at s = score_cert; python/boundary/certify.py proves it strictly valid in exact rational arithmetic (closed pieces avoid the edges and vertices, are embedded and pairwise disjoint)",
            "score_cert": "s lam_k for the first k >= 1 with lam_k = 1 + k 1e-12 at which the scaled configuration (s lam_k, u lam_k, binary64 products) certifies; score_float = the unscaled s",
            "certificate": "the certifier's exact margins at score_cert, rounded down to binary64: balls min_clearance (to the edges), min_distance (over the pairs at most 2 apart in R^4; null when there is none, so all centres are more than 2 apart), min_loop (null: no geodesic loop shorter than 2 s); cubes min_edge_slack (per cube the second smallest of h - |u_l| - 1/2 over its three axes, positive when it crosses faces in at most one axis and keeps clear of the edges; least over the cubes) and min_part_separation (per pair of parts in one cell the largest gap over the axes; least over the pairs); k and lambda of the scaling",
            "exact": "where present, an exact construction valid at exactly its s (touching allowed), checked by the certifier in records mode: field Q (numbers or rational strings) or Q(sqrt 2, sqrt 3) (each number [a, b, c, d] = a + b sqrt 2 + c sqrt 3 + d sqrt 6); config is its binary64 rounding, scaled to strict validity",
            "previous": "where the record improves on the research prototype's round-2 value: that value certified the same way, and improvement_rel = 1 - score_cert / previous.score_cert",
            "display": "score_cert rounded to the nearest at 6 decimals (half-even, from its exact binary64 value)",
            "bound": "the larger proven lower bound on s: volume, or one piece (1/sqrt 2 for balls and for cubes), as a binary64 value rounded down",
            "nofold": "the best value when every piece must lie in one closed cell: f(ceil(P/8)), the smallest cube holding ceil(P/8) pieces",
            "fold_gain": "1 - score_float / nofold.value",
            "status": "best_known everywhere: PolyPack calls a value proven only with a published proof",
        },
        "records": by_piece["ball"] + by_piece["cube"],
    }


def make_record(piece, P, cand, k, lam, cfg, cert, prev):
    pid = f"boundary/tesseract/{piece}/{P}"
    config = cand["config"]
    sc = cfg["s"]
    bound, bounds = bounds_of(piece, P)
    nofold = nofold_of(piece, P)
    cert = dict(cert)
    cert.update({"k": k, "lambda": lam, "rule": "first k >= 1 with s lam_k, u lam_k strictly valid, lam_k = 1 + k 1e-12 (binary64)"})
    if cand.get("exact"):
        cert["exact_valid"] = True
    notes = list(cand["notes"])
    if prev is not None:
        src = cand["provenance"]
        chain = []
        while src.get("kind") == "subset":
            chain.append(src["from"])
            src = src["parent"]
        how = ("the PolyPack boundary search, " + src["call"]) if src.get("source") == "PolyPack boundary search" else "the research layout"
        if src.get("exact"):
            how += " made exact (" + src["exact"] + ")"
        if chain:
            how = f"the record for {chain[-1]} minus pieces, which comes from {how}"
        notes.insert(0, f"Improves on the research value {prev['display']} (score_cert {prev['score_cert']!r}) by {100 * prev['improvement_rel']:.3g}%: from {how}.")
    gap = sc / bound["value"] - 1
    if gap < 1e-9:
        why = " (the 8 cubes fill the boundary)" if piece == "cube" else ""
        notes.append(f"[CALC] Meets its lower bound {bound['exact']} ({bound['kind']}){why}: score_cert / bound - 1 = {gap:.1e}. The bound is derived in BOUNDARY.md section 5, not taken from a published proof, so the status stays best_known.")
    if piece == "cube" and P < 8:
        notes.append("[CALC] One cube per cell at s = 1. A search found no unit cube on a tesseract of edge below 1 (numerical evidence, research note section 4); the proven bound is only " + ("1/sqrt 2." if P <= 2 else f"({P}/8)^(1/3)."))
    if cand.get("exact_value") and piece == "cube":
        notes.append(f"[SPEC] that {cand['exact_value']} is the optimum: no matching lower bound is known.")
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
    }
    if cand.get("exact"):
        rec["exact"] = cand["exact"]
    rec.update({
        "bound": bound,
        "bounds": bounds,
        "bound_gap_rel": gap,
        "nofold": nofold,
        "fold_gain": 1 - config["s"] / nofold["value"],
        "method": cand["method"],
        "seed": cand["seed"],
        "budget": cand["budget"],
        "provenance": cand["provenance"],
        "software": cand["software"] + "; certified by python/boundary/certify.py",
        "found_by": cand["found_by"],
    })
    if prev is not None:
        rec["previous"] = prev
    rec["notes"] = notes
    errs = C.published_errors(rec)
    if errs:
        raise SystemExit(f"{pid}: {errs}")
    return rec


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
