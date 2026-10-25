"""Curate curvature-sweep results into data/curved/sweep/ and the viewer data.

Inputs per problem X = N_M_P (scratch directory):
  RUNS/sweep_X.json      branches with poses (packages/curved/scripts/sweep/run-sweep.ts)
  ANA/ana_X.json         events, ground state, stability, certification prep (analyze.ts)
  ANA/ana_X.cert.json    certification results (sweep_certify.py, i.e. certify.py)
Outputs:
  data/curved/sweep/sweep_X.json   curated record of the sweep (curves, events, list of certified points)
  data/curved/sweep/records.json   every certified configuration, in the records format of
                                   data/curved/records.json (python3 python/curved/certify.py reads it)
  data/curved/sweep/summary.json   one entry per problem: headline numbers and the event table
  VIEWER (--viewer)                compact data embedded in packages/curved/viz/sweep.html by
                                   packages/curved/scripts/sweep/build-sweep-viz.ts

    python3 python/curved/sweep_curate.py --runs RUNS --ana ANA --out data/curved/sweep --viewer VIEWER.json \
        --about packages/curved/viz/sweep-about.html
"""
import argparse
import json
import math
import os
from datetime import date
from decimal import ROUND_HALF_EVEN, Decimal
from fractions import Fraction


def display_nearest(x):
    """score rounded to the NEAREST at 6 decimals (ties to even), exactly (Decimal of the binary64 value);
    the same rule as python/curved/certify.py display_nearest."""
    return str(Decimal(x).quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN))


def k_exact(K):
    """Exact rational value of the binary64 K, as 'p/q' (or an integer)."""
    f = Fraction(K)
    return str(f.numerator) if f.denominator == 1 else f"{f.numerator}/{f.denominator}"

GROUPS = [
    ("Disks in a disk", lambda N, M: N == 0 and M == 0),
    ("Triangles in a triangle", lambda N, M: N == 3 and M == 3),
    ("Squares in a square", lambda N, M: N == 4 and M == 4),
    ("Triangles in a q-gon ({3,q} tilings)", lambda N, M: N == 3 and M >= 5),
]
NAMES = {0: ("disk", "disks"), 3: ("triangle", "triangles"), 4: ("square", "squares"), 5: ("pentagon", "pentagons"), 6: ("hexagon", "hexagons")}
CNAME = {0: "disk", 3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon"}
# {3,q} tiling curvatures K*: cs_K(1/2) = 1/(2 sin(pi/q))
TILING = {5: 1.225778283313099, 6: 0.0, 7: -1.1892985685754194, 8: -2.3365290558829845}


def title(N, M, P):
    one, many = NAMES[N]
    c = CNAME[M]
    return f"{P} {many if P > 1 else one} in {'an' if c[0] in 'aeiou' else 'a'} {c}"


def group_of(N, M):
    for g, f in GROUPS:
        if f(N, M):
            return g
    return "Other"


def r6(v):
    return None if v is None or (isinstance(v, float) and not math.isfinite(v)) else round(v, 7)


def runs_of(ground):
    out = []
    for g in ground:
        if out and out[-1]["b"] == g["b"]:
            out[-1]["K1"] = g["K"]
        else:
            out.append({"b": g["b"], "K0": g["K"], "K1": g["K"]})
    return out


def describe(d):
    if not d:
        return ""
    r = d.get("rattlers") or []
    return f"shells {d.get('family')}, {d.get('sym')}, {d.get('contacts')} contacts" + (f", {len(r)} rattler{'s' if len(r) > 1 else ''}" if r else "")


def cert_records(certs, res, N, M, P):
    """Certified configurations in the records format of data/curved/records.json (re-checkable with
    python3 python/curved/certify.py). One record per (K, branch); id 'curved/K/N/M/P#b<branch>'."""
    out = []
    seen = set()
    for c in certs:
        key = (c["K"], c["branch"])
        if key in seen:
            continue
        r = next((r for r in res if r["id"] == c["id"] and r["K"] == c["K"] and r["role"] == c["role"]), None)
        if not r or not r["certified"]:
            continue
        seen.add(key)
        K = c["K"]
        assert c["config_cert"]["size"] == c["score_cert"]
        roles = [x["role"] for x in certs if x["K"] == K and x["branch"] == c["branch"]]
        out.append(
            {
                "id": f"curved/{K!r}/{N}/{M}/{P}#b{c['branch']}",
                "K": K,
                "K_exact": k_exact(K),
                "N": N,
                "M": M,
                "P": P,
                "score_float": c["score_float"],
                "score_cert": c["score_cert"],
                "cert_minus_float": c["score_cert"] - c["score_float"],
                "cert_minus_float_relative": (c["score_cert"] - c["score_float"]) / c["score_float"],
                "display": display_nearest(c["score_cert"]),
                "status": "best_known",
                "certified": True,
                "config": c["config_cert"],
                "witnesses": c["witnesses"],
                "certificate": {
                    "certifier": "python/curved/certify.py",
                    "margin": c["margin"],
                    **{k: v for k, v in (r.get("certifier") or {}).items() if k != "reason"},
                },
                "sweep": {"branch": c["branch"], "roles": roles},
                "method": "curvature sweep (packages/curved/scripts/sweep): seeded multistart solves every 1/4 in K, branch continuation on the 1/64 grid, refinement; margin re-solve (certifyPrep) for certification",
                "software": "PolyPack curved research build (curvature sweep)",
                "found_by": "PolyPack research",
            }
        )
    return out


def curate(X, runs_dir, ana_dir):
    run = json.load(open(os.path.join(runs_dir, f"sweep_{X}.json")))
    ana = json.load(open(os.path.join(ana_dir, f"ana_{X}.json")))
    cpath = os.path.join(ana_dir, f"ana_{X}.cert.json")
    cert = json.load(open(cpath)) if os.path.exists(cpath) else {"results": []}
    N, M, P = run["problem"]["N"], run["problem"]["M"], run["problem"]["P"]
    grid = run["grid"]
    if not run.get("euclidean"):
        # records without poses were not used as seeds; their value is still the comparison at K = 0
        here = os.path.dirname(os.path.abspath(__file__))
        recs = json.load(open(os.path.join(here, "../../data/records.json")))["records"]
        r = next((r for r in recs if r["N"] == N and r["M"] == M and r["P"] == P), None)
        if r:
            run["euclidean"] = {"value": r["value"], "source": f"euclidean record {r['value']} ({r.get('status')}; {r.get('source_name', '')}; no poses stored)"}
    ground = ana["ground"]
    optimal = ana["optimal"]
    branches = {b["id"]: dict(b) for b in run["branches"]}
    # metastable continuations from the crossings (analyze.ts): splice them into the branch curves
    for m in ana.get("meta", []):
        b = branches.get(m["branch"])
        if b is None or not m["points"]:
            continue
        K0 = m["fromK"]
        if m["dir"] > 0:
            pts = [p for p in b["points"] if p["K"] < K0] + m["points"]
            b["high"] = {"K": m["end"]["K"], "kind": m["end"]["kind"], "note": m["end"].get("note")}
        else:
            pts = list(reversed(m["points"])) + [p for p in b["points"] if p["K"] > K0]
            b["low"] = {"K": m["end"]["K"], "kind": m["end"]["kind"], "note": m["end"].get("note")}
        b["points"] = sorted(pts, key=lambda p: p["K"])
    gmap = {round(g["K"] / grid): g for g in ground}

    # metastable competitors: non-optimal branches within 1% of the ground state somewhere
    extra = []
    for b in run["branches"]:
        if b["id"] in optimal:
            continue
        best = min(
            (p["size"] / gmap[round(p["K"] / grid)]["s"] - 1 for p in b["points"] if p["grid"] and round(p["K"] / grid) in gmap),
            default=1.0,
        )
        if best < 0.01:
            extra.append((best, -len(b["points"]), b["id"]))
    extra = [e[2] for e in sorted(extra)[:4]]
    kept = optimal + extra
    first_opt = {}
    for g in ground:
        first_opt.setdefault(g["b"], g["K"])
    slot = {bid: i for i, bid in enumerate(sorted(optimal, key=lambda b: first_opt[b]))}

    # certification bookkeeping
    res = cert["results"]
    cert_ok = [r for r in res if r["certified"]]
    ground_cert = {round(r["K"] / grid): r for r in res if r["role"] == "ground"}

    # events
    evs = []
    for e in ana["events"]:
        k = e["kind"]
        # kink scan: genuine kinks jump by >= 5% of the slope; smaller "jumps" in the asymptotic regime are
        # the fast smooth growth of s'' near s -> infinity (first version of the scan; see analyze.ts)
        if k == "kink" and abs((e.get("slopeRight") or 0) - (e.get("slopeLeft") or 0)) < 0.05 * (1 + abs(e.get("slopeLeft") or 0)):
            continue
        # the scan can report one kink from two neighbouring grid points
        if k == "kink" and any(x["kind"] == "kink" and x.get("branch") == e.get("branch") and abs(x["K"] - e["K"]) < 1e-4 for x in evs):
            continue
        # a "crossing" with no slope change is the same configuration under two labels
        if k == "crossing" and e.get("kink") is not None and abs(e["kink"]) < 2e-3 * (1 + abs(e.get("slopeLeft") or 0)):
            e = dict(e, kind="coincide")
            k = "coincide"
        if k in ("contact", "symmetry") and not e.get("onGround"):
            continue
        if k == "fold" and e.get("branch") not in kept and "metastable continuation" not in (e.get("note") or ""):
            continue
        if k == "stability" and not e.get("onGround"):
            continue
        ev = {kk: e.get(kk) for kk in ("kind", "K", "Klo", "Khi", "branch", "from", "to", "s", "slopeLeft", "slopeRight", "d2Left", "d2Right", "kink", "onGround", "note")}
        ev["before"] = e.get("before")
        ev["after"] = e.get("after")
        if k == "crossing":
            pre = f"crossing {e['from']}->{e['to']} at "

            def at_k(role):
                # role = 'crossing A->B at <K_c as printed by JS>: ...'; compare K_c numerically (JS and Python print floats differently)
                try:
                    return abs(float(role[len(pre):].split(":")[0]) - e["K"]) <= 1e-15 * max(1.0, abs(e["K"]))
                except ValueError:
                    return False

            rs = [r for r in res if r["role"].startswith(pre) and at_k(r["role"])]
            ok = sum(1 for r in rs if r["certified"])
            ev["certified"] = f"{ok}/{len(rs)}"
            ev["certified_all"] = ok == len(rs) and len(rs) > 0
            hy = e.get("hysteresis") or []
            hys = "; ".join(f"branch {h['branch']} survives {'up' if h['direction'] == 'up' else 'down'} to K = {h['survivesTo']:.4f} ({h['end']})" for h in hy)
            ev["hysteresis"] = hy
            ev["text"] = (
                f"branch {e['from']} ({describe(e['before'])}) gives way to branch {e['to']} ({describe(e['after'])}); "
                + (f"slope jumps by {e['kink']:+.4f}" if e.get("kink") is not None else "slope on one side not measurable (branch ends there)")
                + (f"; metastable: {hys}" if hys else "")
            )
        elif k == "coincide":
            ev["text"] = f"branches {e['from']} and {e['to']} coincide here (same value and slope): relabelled copy, not a kink"
        elif k == "gap":
            ev["text"] = f"unresolved: {e.get('note')}"
        elif k == "fold":
            a = e.get("after") or {}
            ev["text"] = (
                f"branch {e['branch']} ({describe(e['before'])}) ceases to exist; descent jumps"
                + (f" by {a.get('jump'):+.3e} in s to {describe(a)}" if a.get("jump") is not None else "")
            )
        elif k == "stability":
            ev["text"] = e.get("note", "")
        elif k == "kink":
            ev["text"] = (
                f"branch {e['branch']} ({describe(e.get('before'))}): slope jumps from {e.get('slopeLeft') or float('nan'):.4f} to {e.get('slopeRight') or float('nan'):.4f} "
                "with no change of the contact set at grid resolution (e.g. a floppy plateau ends, or a degenerate contact set switches)"
            )
        elif k == "end":
            ev["text"] = e.get("note", "")
        elif k in ("contact", "symmetry"):
            a = e.get("after") or {}
            b0 = e.get("before") or {}
            kink = e.get("kink")
            kind = "kink" if kink is not None and abs(kink) > 2e-3 * (1 + abs(e.get("slopeLeft") or 0)) else "smooth slope"
            ev["kinkClass"] = kind
            add = ", ".join(a.get("added") or []) or "none"
            rem = ", ".join(a.get("removed") or []) or "none"
            rat = ""
            if (b0.get("rattlers") or []) != (a.get("rattlers") or []):
                rat = f"; rattlers {b0.get('rattlers')} -> {a.get('rattlers')}"
            ev["text"] = (
                f"branch {e['branch']}: contacts +[{add}] -[{rem}]{rat}; symmetry {b0.get('sym')} -> {a.get('sym')}; {kind}"
                + (f" (slope {e.get('slopeLeft'):.4f} | {e.get('slopeRight'):.4f})" if e.get("slopeLeft") is not None and e.get("slopeRight") is not None else "")
            )
        evs.append(ev)

    # symmetry-label flicker: a symmetry-only change (no contact change, smooth slope) that is undone
    # on the same branch within 0.02 in K comes from the detection tolerance, not from the geometry
    def sym_only(e):
        a = e.get("after") or {}
        return e["kind"] == "symmetry" and not (a.get("added") or a.get("removed")) and e.get("kinkClass") != "kink"

    drop = set()
    for i, e in enumerate(evs):
        if not sym_only(e):
            continue
        for j, f in enumerate(evs):
            if j != i and sym_only(f) and f.get("branch") == e.get("branch") and abs(f["K"] - e["K"]) < 0.02:
                if (e.get("before") or {}).get("sym") == (f.get("after") or {}).get("sym") or (e.get("after") or {}).get("sym") == (f.get("before") or {}).get("sym"):
                    drop.add(i)
                    drop.add(j)
    evs = [e for i, e in enumerate(evs) if i not in drop]

    # K = 0 summary
    k0 = ana.get("k0", [])
    s0 = None
    g0 = gmap.get(0)
    if g0:
        s0 = g0["s"]
    elif run.get("euclidean"):
        s0 = run["euclidean"]["value"]
    else:
        s0 = ground[len(ground) // 2]["s"]

    record = {
        "id": f"curved-sweep/{N}/{M}/{P}",
        "N": N,
        "M": M,
        "P": P,
        "title": title(N, M, P),
        "K_range": [run["Kmin"], run["Kmax"]],
        "grid": grid,
        "grid_note": "K values are multiples of 1/64 (exact binary64 and exact rationals for the certifier)",
        "euclidean_record": run.get("euclidean"),
        "search": {
            "solves": len(run["solves"]),
            "solve_params": run["params"],
            "branches_followed": len(run["branches"]),
            "seconds": run.get("seconds"),
        },
        "ground_state": [
            {
                "K": g["K"],
                "s": g["s"],
                "branch": g["b"],
                "density": g["density"],
                "sym": g["sym"],
                "family": g["family"],
                "certified": (ground_cert.get(round(g["K"] / grid)) or {}).get("certified"),
            }
            for g in ground
        ],
        "ground_runs": runs_of(ground),
        "branches": [
            {
                "id": b,
                "seed": branches[b]["seed"],
                "optimal": b in optimal,
                "low_end": branches[b]["low"],
                "high_end": branches[b]["high"],
                "curve": [
                    [p["K"], p["size"], r6(p["density"]), r6(p["dsdK"]), p["sym"], p["family"], len(p["contacts"]), p["rattlers"]]
                    for p in branches[b]["points"]
                ],
            }
            for b in kept
        ],
        "branch_curve_columns": ["K", "s", "density", "dsdK_envelope", "symmetry", "shells", "contacts", "rattlers"],
        "events": evs,
        "k0": k0,
        "asymptote": ana.get("asymptote"),
        "stability_probe": {str(k): v for k, v in ana.get("stability", {}).items()},
        "certification": {
            "certifier": "python/curved/certify.py (256-bit interval arithmetic), via python/curved/sweep_certify.py",
            "prepared": len(res),
            "certified": len(cert_ok),
            "worst_cert_minus_float_relative": max((r["cert_minus_float_relative"] for r in res), default=None),
            "records": cert_records(ana["certs"], res, N, M, P),
        },
        "status": "best_known",
        "software": "PolyPack curved research build (curvature sweep)",
        "found_by": "PolyPack research",
    }

    # viewer
    fam_names, sym_names = [], []

    def idx(lst, v):
        if v not in lst:
            lst.append(v)
        return lst.index(v)

    vb = []
    for b in kept:
        pts = branches[b]["points"]
        # drop sub-steps closer than 1e-4 to the previous point (fold refinement), keep the last
        sel = []
        for i, p in enumerate(pts):
            if sel and p["K"] - sel[-1]["K"] < 2e-4 and i != len(pts) - 1 and not p["grid"]:
                continue
            sel.append(p)
        lowE, highE = branches[b]["low"], branches[b]["high"]
        vb.append(
            {
                "id": b,
                "slot": slot.get(b, -1),
                "label": f"shells {sel[len(sel)//2]['family']} · {sel[len(sel)//2]['sym']}",
                "ends": [lowE["kind"], pts[0]["K"], highE["kind"], pts[-1]["K"]],
                "K": [round(p["K"], 9) for p in sel],
                "s": [round(p["size"], 9) for p in sel],
                "d": [round(p["density"], 6) for p in sel],
                "sym": [idx(sym_names, p["sym"]) for p in sel],
                "fam": [idx(fam_names, p["family"]) for p in sel],
                "nc": [len(p["contacts"]) for p in sel],
                "rat": [p["rattlers"] if p["rattlers"] else 0 for p in sel],
                "ct": [" ".join(p["contacts"]) for p in sel],
                "poses": [[round(v, 6) for q in p["pieces"] for v in (q["x"], q["y"], q["theta"])] for p in sel],
            }
        )
    for b in vb:
        b["rat"] = [r if r else [] for r in b["rat"]]
    vev = []
    for e in evs:
        k = e["kind"]
        if k == "coincide":
            continue
        dens = None
        if e.get("s") is not None and e.get("K") is not None:
            pass
        vev.append(
            {
                "kind": k,
                "K": e["K"],
                "s": e.get("s"),
                "d": (e.get("before") or {}).get("density"),
                "from": e.get("from"),
                "to": e.get("to"),
                "branch": e.get("branch"),
                "sl": e.get("slopeLeft") if k != "crossing" else (e.get("before") or {}).get("slopes", [None])[0],
                "sr": e.get("slopeRight") if k != "crossing" else (e.get("after") or {}).get("slopes", [None, None])[1],
                "text": e.get("text", ""),
                "jump": (e.get("after") or {}).get("jump") if k == "fold" else None,
                "cert": e.get("certified"),
                "chip": k in ("crossing", "kink", "stability", "end", "gap") or (k == "fold" and e.get("onGround") is not None and abs((e.get("after") or {}).get("jump") or 0) > 1e-4) or (k in ("contact", "symmetry") and e.get("kinkClass") == "kink"),
                "table": True,
            }
        )
    marks = []
    if N == 3 and M in TILING and M == P and TILING[M] != 0:
        marks.append({"K": TILING[M], "label": f"{{3,{M}}} tiling K*"})
    if N == 3 and M == 6 and P == 6:
        marks.append({"K": 0.0, "label": "{3,6}"})
    view = {
        "key": X,
        "N": N,
        "M": M,
        "P": P,
        "title": title(N, M, P),
        "group": group_of(N, M),
        "Kmin": run["Kmin"],
        "Kmax": run["Kmax"],
        "grid": grid,
        "s0": s0,
        "marks": marks,
        "symNames": sym_names,
        "famNames": fam_names,
        "branches": vb,
        "ground": {
            "K": [g["K"] for g in ground],
            "s": [round(g["s"], 9) for g in ground],
            "b": [g["b"] for g in ground],
            "d": [round(g["density"], 6) for g in ground],
            "fam": [g["family"] for g in ground],
            "sym": [g["sym"] for g in ground],
        },
        "events": sorted(vev, key=lambda e: e["K"]),
        "certLine": (
            f"Certified with python/curved/certify.py: {len(cert_ok)}/{len(res)} configurations "
            f"(ground state every 1/16 in K, both branches at every crossing); worst (score_cert - score_float)/score_float = "
            f"{max((r['cert_minus_float_relative'] for r in res), default=0):.1e}."
            + (f" Euclidean record at K = 0: {run['euclidean']['value']:.6f} ({run['euclidean']['source']})." if run.get("euclidean") else "")
        ),
    }
    return record, view


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True)
    ap.add_argument("--ana", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--about", default=None)
    ap.add_argument("--viewer", default=None, help="where to write viewer.json (default: OUT/viewer.json)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    keys = []
    for f in sorted(os.listdir(a.ana)):
        if f.startswith("ana_") and f.endswith(".json") and not f.endswith(".cert.json"):
            X = f[4:-5]
            if os.path.exists(os.path.join(a.runs, f"sweep_{X}.json")):
                keys.append(X)
    order = lambda X: (["0_0", "3_3", "4_4"].index(X.rsplit("_", 1)[0]) if X.rsplit("_", 1)[0] in ("0_0", "3_3", "4_4") else 9, int(X.split("_")[1]), int(X.split("_")[2]))
    keys.sort(key=order)
    summary = []
    views = []
    flat = []
    for X in keys:
        rec, view = curate(X, a.runs, a.ana)
        with open(os.path.join(a.out, f"sweep_{X}.json"), "w") as f:
            json.dump(rec, f, separators=(",", ":"))
        views.append(view)
        flat.extend(rec["certification"]["records"])
        # the per-problem file lists the certified points; full configurations live once, in records.json
        rec["certification"]["records"] = [
            {k: r[k] for k in ("id", "K", "K_exact", "score_float", "score_cert", "display", "sweep")} for r in rec["certification"]["records"]
        ]
        rec["certification"]["configurations"] = "data/curved/sweep/records.json (same ids)"
        with open(os.path.join(a.out, f"sweep_{X}.json"), "w") as f:
            json.dump(rec, f, separators=(",", ":"))
        c = rec["certification"]
        summary.append(
            {
                "id": rec["id"],
                "title": rec["title"],
                "K_range": rec["K_range"],
                "euclidean_record": rec["euclidean_record"],
                "ground_runs": rec["ground_runs"],
                "events": [
                    {k: e.get(k) for k in ("kind", "K", "s", "slopeLeft", "slopeRight", "kink", "branch", "from", "to", "text", "certified")}
                    for e in rec["events"]
                    if e["kind"] in ("crossing", "kink", "fold", "stability", "end", "gap") or e.get("kinkClass") == "kink"
                ],
                "k0": rec["k0"],
                "asymptote": rec["asymptote"],
                "certified": f"{c['certified']}/{c['prepared']}",
                "worst_rel": c["worst_cert_minus_float_relative"],
            }
        )
        print(f"{X}: {len(rec['branches'])} branches kept, {len(rec['events'])} events, certified {c['certified']}/{c['prepared']}")
    with open(os.path.join(a.out, "summary.json"), "w") as f:
        json.dump({"generated": str(date.today()), "problems": summary}, f, indent=1)
    with open(os.path.join(a.out, "records.json"), "w") as f:
        json.dump(
            {
                "generated": str(date.today()),
                "conventions": "as data/curved/records.json (docs/spaces/CURVED.md); K_exact is the exact rational value of the binary64 K; config is the certified configuration at score_cert; display is score_cert rounded to the nearest at 6 decimals (ties to even)",
                "records": flat,
            },
            f,
            separators=(",", ":"),
        )
    print(f"records.json: {len(flat)} certified sweep configurations")
    about = open(a.about).read() if a.about else ""
    sub = (
        "How packings change as the curvature K of the plane changes smoothly: hyperbolic (K < 0), flat (K = 0), spherical (K > 0). "
        "Unit pieces; s is the container side (radius for a disk container). Values are best found, not proven optimal."
    )
    vpath = a.viewer or os.path.join(a.out, "viewer.json")
    with open(vpath, "w") as f:
        json.dump({"generated": str(date.today()), "subtitle": sub, "about": about, "start": "0_0_7", "problems": views}, f, separators=(",", ":"))
    print(f"viewer: {len(views)} problems, {os.path.getsize(vpath) / 1e6:.2f} MB -> {vpath}")


if __name__ == "__main__":
    main()
