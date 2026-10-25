"""Print markdown tables of data/sphere/records.json for docs/spaces/SPHERE.md.

Usage: python3 python/sphere/report_tables.py [data/sphere/records.json]
"""
import json
import math
import sys

NAMES = {0: "disks", 3: "triangles", 4: "squares", 5: "pentagons", 6: "hexagons", 8: "octagons"}


def summary(recs):
    from collections import Counter

    print("records:", len(recs), dict(Counter(NAMES.get(r["N"], r["N"]) for r in recs)))
    print("status:", dict(Counter(r["status"] for r in recs)))
    print("max gap_rel (score_cert/score_float - 1): %.2e" % max(r["gap_rel"] for r in recs))
    print("eps used:", dict(Counter(r["certificate"]["eps"] for r in recs)))
    dis = [r for r in recs if r["N"] == 0 and r["literature"]]
    print("disks: max |rel diff| to Cohn: %.1e; worse than lit by > 1e-10: %s" % (
        max(abs(r["literature"]["rel_diff"]) for r in dis),
        [r["P"] for r in dis if r["literature"]["rel_diff"] > 1e-10]))
    for N in (3, 4, 5):
        rs = [r for r in recs if r["N"] == N and r["literature"]]
        c = Counter(r["literature"]["verdict"] for r in rs)
        print(f"N={N} vs dOSV:", dict(c), "better:", [r["P"] for r in rs if r["literature"]["verdict"] == "better"],
              "tiling:", [r["P"] for r in rs if r["literature"]["verdict"] == "tiling"],
              "worse:", [r["P"] for r in rs if r["literature"]["verdict"] == "worse"])
    tight = [r["id"] for r in recs if r["bound"] and r["score_float"] / r["bound"]["value"] - 1 < 1e-9]
    print("meets its lower bound (< 1e-9):", tight)


def main():
    fn = sys.argv[1] if len(sys.argv) > 1 else "data/sphere/records.json"
    d = json.load(open(fn))
    recs = d["records"]
    if "--summary" in sys.argv:
        summary(recs)
        return
    print("\nBounds are rigorous (interval-checked). 'published ... (float-computed)' is a higher bound from dOSV 2026 "
          "maximality whose own computation was done in floating point; it is not used as the headline bound.")
    for N in sorted({r["N"] for r in recs}):
        rows = sorted([r for r in recs if r["N"] == N], key=lambda r: r["P"])
        print(f"\n#### {NAMES.get(N, N)} (N = {N})\n")
        if N == 0:
            print("| P | rho (certified, 6 decimals) | lower bound (kind) | gap to bound | Tammes rho (Cohn table) | ours - lit (rel) | status |")
            print("|---|---|---|---|---|---|---|")
        else:
            print("| P | rho (certified, 6 decimals) | circumradius R (rad) | lower bound (kind) | gap to bound | dOSV 2026 R (truncated) | vs dOSV | status |")
            print("|---|---|---|---|---|---|---|---|")
        for r in rows:
            b = r["bound"]
            bs = f"{b['value']:.6f} ({b['kind'].replace('_', ' ')})" if b else "-"
            bp = r.get("bound_published")
            if bp:
                bs += f"; published {bp['value']:.6f} (float-computed)"
            gap = f"{100 * (r['score_float'] / b['value'] - 1):.3f}%" if b else "-"
            L = r["literature"]
            st = r["status"]
            if N == 0:
                lit = f"{L['rho']:.9f}" if L else "-"
                rel = f"{L['rel_diff']:+.1e}" if L else "-"
                print(f"| {r['P']} | {r['display']} | {bs} | {gap} | {lit} | {rel} | {st} |")
            else:
                a = 1 / r["score_float"]
                R = math.asin(min(1.0, math.sin(a / 2) / math.sin(math.pi / N)))
                lit = (L["radius"] + (" " + L["mark"] if L["mark"] else "")) if L else "-"
                vs = L["verdict"] if L else "-"
                print(f"| {r['P']} | {r['display']} | {R:.7f} | {bs} | {gap} | {lit} | {vs} | {st} |")


if __name__ == "__main__":
    main()
