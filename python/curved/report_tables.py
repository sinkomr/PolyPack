"""Print markdown tables of data/curved/records.json and ideal.json for docs/spaces/CURVED.md."""
import json
import math
import os
import sys
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "data", "curved")
def down6(x):
    """x rounded DOWN at 6 decimals (exact), for certified lower bounds."""
    n = math.floor(Fraction(x) * 10**6)
    return f"{n // 10**6}.{n % 10**6:06d}"


NAMES = {0: "disk", 3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 8: "octagon"}


def main():
    d = json.load(open(os.path.join(DATA, "records.json")))
    recs = [r for r in d["records"] if r.get("config")]
    by = {}
    for r in recs:
        by.setdefault((r["K"], r["N"], r["M"]), []).append(r)
    for K in (-1, 1):
        print(f"\n#### K = {K}: certified sizes s(P) (rounded up), P = 1, 2, ...\n")
        print("| N \\\\ M | container | values |")
        print("|---|---|---|")
        for key in sorted(k for k in by if k[0] == K):
            _, N, M = key
            rs = sorted(by[key], key=lambda r: r["P"])
            vals = ", ".join(f"{r['P']}: {r['display']}" for r in rs)
            print(f"| {NAMES.get(N, N)} | {'disk' if M == 0 else str(M) + '-gon'} | {vals} |")
    print("\n#### Catalogue (polygon containers)\n")
    print("| K | N | M | P_max found | upper bound | exact | arguments |")
    print("|---|---|---|---|---|---|---|")
    for c in d["catalogue"]:
        if c["M"] == 0:
            continue
        args = c.get("upper_arguments") or {}
        keep = []
        for k, v in args.items():
            if k.startswith("centre_bb"):
                keep.append(f"{k}: {'proved' if v.get('proved') else 'not proved'} ({v.get('boxes')} boxes)")
            elif k in ("area", "cusp", "inradius", "near_wall"):
                keep.append(f"{k} <= {v}")
        print(f"| {c['K']} | {NAMES.get(c['N'], c['N'])} | {c['M']} | {c['P_max_found']} | {c['P_max_upper']} | {'yes' if c['exact'] else 'no'} | {'; '.join(keep)} |")
    p = os.path.join(DATA, "ideal.json")
    if os.path.exists(p):
        di = json.load(open(p))
        rows = {}
        for e in di["entries"]:
            rows.setdefault((e["N"], e["M"]), []).append(e)
        print("\n#### a*(N, M, P) at K = -1 (ideal M-gon); certified lower bounds, rounded down\n")
        print("| N | M | a* for P = 1, 2, ... |")
        print("|---|---|---|")
        for key in sorted(rows):
            es = sorted(rows[key], key=lambda e: e["P"])
            vals = []
            for e in es:
                if e.get("a_star") == "infinity":
                    vals.append(f"{e['P']}: ∞")
                elif e.get("a_star_note") and not e.get("certified_lower_bound"):
                    vals.append(f"{e['P']}: n/d")
                elif e.get("certified_lower_bound"):
                    mark = "≥" if e.get("lower_bound_from_P") or e.get("a_star_note") else ""
                    vals.append(f"{e['P']}: {mark}{down6(e['certified_lower_bound'])}")
                else:
                    vals.append(f"{e['P']}: ({down6(e['a_float'])} uncertified)")
            print(f"| {NAMES.get(key[0], key[0])} | {key[1]} | {', '.join(vals)} |")


if __name__ == "__main__":
    main()
