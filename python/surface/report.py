"""Writes docs/spaces/SURFACE_RESULTS.md (tables of certified values) from data/surface/records.json.

Usage: python3 python/surface/report.py [records.json] [out.md]
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SOLIDS = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"]
SHAPES = {0: "disks", 3: "triangles", 4: "squares", 5: "pentagons", 6: "hexagons", 8: "octagons"}


def main(argv):
    rec_path = argv[0] if argv else os.path.join(REPO, "data", "surface", "records.json")
    out_path = argv[1] if len(argv) > 1 else os.path.join(REPO, "docs", "spaces", "SURFACE_RESULTS.md")
    with open(rec_path) as fh:
        doc = json.load(fh)
    recs = {(r["solid"], r["mode"], r["N"], r["P"]): r for r in doc["records"]}
    lines = []
    w = lines.append
    n_fold = sum(1 for r in doc["records"] if r["mode"] == "fold")
    n_nofold = len(doc["records"]) - n_fold
    worst_gap = max(r["gap_rel"] for r in doc["records"])
    w("# 2D on 3D, Platonic surfaces: certified tables")
    w("")
    w("Generated from `data/surface/records.json` (%s) by `python/surface/report.py`. %d nofold and %d fold "
      "records; every value is certified by `python/surface/cert.py` (largest relative gap "
      "score_cert / score_float - 1: %.1e). Values are the certified edge score_cert rounded to 6 decimals "
      "(nearest); score_cert itself, in the records, is the certified bound rounded up to a float. "
      "Definitions and proofs: [SURFACE.md](SURFACE.md)." % (doc["generated"], n_nofold, n_fold, worst_gap))
    w("")
    w("Columns: **fold** and **nofold** values; **gain** = 1 - fold/nofold; **bound** = the larger of the area "
      "bound and the one-piece bound [CALC]; **how** = where the fold value comes from: `search` (fold search), "
      "`exact` (exact tiling, meets the area bound), `replica` (copies of the best one-piece placement on faces "
      "whose covered regions do not overlap), `subset` (the P+1 packing minus a piece), `nofold` (the "
      "nofold packing; the search found nothing better), `-` (no fold search run; the nofold packing).")
    w("")
    # summary of fold gains
    w("## Where folding helps")
    w("")
    w("| solid | pieces | P searched | fold entries | mean gain | largest gain (P) | entries with no gain |")
    w("|---|---|---|---|---|---|---|")
    for solid in SOLIDS:
        for N in SHAPES:
            allf = [recs[k] for k in recs if k[0] == solid and k[1] == "fold" and k[2] == N]
            rows = [r for r in allf if r.get("searched")]
            if not allf:
                continue
            gains = [(r.get("fold_gain") or 0.0, r["P"]) for r in allf if r.get("fold_gain") is not None]
            if not gains:
                continue
            mean = sum(g for g, _ in gains) / len(gains)
            big = max(gains)
            none = sum(1 for g, _ in gains if g <= 1e-9)
            w("| %s | %s | %d | %d | %.1f%% | %.1f%% (%d) | %d |" % (solid, SHAPES[N], len(rows), len(gains), 100 * mean, 100 * big[0], big[1], none))
    w("")
    meet = [r for r in doc["records"] if r["score_cert"] / r["bound"]["value"] - 1 <= 3 * float(r["eps"])]
    near = [r for r in doc["records"] if r not in meet and r["score_cert"] / r["bound"]["value"] - 1 < 1e-6]
    w("## Entries that meet their lower bound")
    w("")
    w("[CALC] %d entries: score_cert / bound - 1 is at most 3 eps, i.e. the certified value equals the area or "
      "one-piece bound up to the float rounding of s and the certificate's shrink eps. So the packings are best "
      "possible; status stays best_known (no published proof). The gap column gives score_cert / bound - 1."
      % len(meet))
    w("")
    w("| id | value | bound | gap | kind |")
    w("|---|---|---|---|---|")
    for r in meet:
        w("| %s | %s | %s | %.1e | %s |" % (r["id"], r["display"], r["bound"]["kind"],
                                           r["score_cert"] / r["bound"]["value"] - 1, r["kind"]))
    w("")
    if near:
        w("Within 1e-6 of the bound but not shown to equal it: " + ", ".join(
            "%s (gap %.1e)" % (r["id"], r["score_cert"] / r["bound"]["value"] - 1) for r in near) + ".")
        w("")
    for solid in SOLIDS:
        w("## %s" % solid.capitalize())
        w("")
        for N in SHAPES:
            Ps = sorted({k[3] for k in recs if k[0] == solid and k[2] == N})
            if not Ps:
                continue
            w("### %s" % SHAPES[N].capitalize())
            w("")
            w("| P | fold | nofold | gain | bound | how |")
            w("|---|---|---|---|---|---|")
            for P in Ps:
                f = recs.get((solid, "fold", N, P))
                n = recs.get((solid, "nofold", N, P))
                how = "-"
                if f:
                    how = {"search": "search", "exact": "exact", "subset": "subset", "asfold": "nofold",
                           "replica": "replica"}.get(f["kind"], f["kind"])
                    if f["kind"] == "asfold" and not f.get("searched"):
                        how = "-"
                gain = ""
                if f and f.get("fold_gain") is not None and f["fold_gain"] > 1e-9:
                    gain = "%.1f%%" % (100 * f["fold_gain"])
                b = (f or n)["bound"]["value"]
                w("| %d | %s | %s | %s | %.6f | %s |" % (P, f["display"] if f else "", n["display"] if n else "", gain, b, how))
            w("")
    with open(out_path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    print("wrote", out_path)


if __name__ == "__main__":
    main(sys.argv[1:])
