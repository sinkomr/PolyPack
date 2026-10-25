"""Print the markdown result tables for docs/spaces/TORUS.md from data/torus/records.json.

  python3 python/torus/doc_tables.py data/torus/records.json
"""

import json
import sys

NAMES = {0: "disks", 3: "triangles", 4: "squares", 5: "pentagons", 6: "hexagons", 7: "heptagons", 8: "octagons"}
FAMS = {"sq": "Square torus (score L)", "hex": "Hexagonal torus (score L)", "free": "Free lattice (score sqrt(cell area))"}


def main(path, pmax=16):
    with open(path) as f:
        recs = json.load(f)["records"]
    by = {(r["family"], r["N"], r["P"]): r for r in recs}
    Ns = sorted({r["N"] for r in recs})
    for fam, title in FAMS.items():
        Ps = sorted({r["P"] for r in recs if r["family"] == fam and r["P"] <= pmax})
        if not Ps:
            continue
        print("### %s\n" % title)
        print("Certified score (rounded to 6 decimals), with density below. **Bold**: equal to the lower bound in the record (to 1e-12 relative).\n")
        print("| P | " + " | ".join(NAMES.get(N, str(N)) for N in Ns) + " |")
        print("|---:|" + "---:|" * len(Ns))
        for P in Ps:
            cells = []
            for N in Ns:
                r = by.get((fam, N, P))
                if r is None:
                    cells.append("")
                    continue
                atb = (r["score_float"] - r["bound"]["value"]) / r["bound"]["value"] <= 1e-12
                v = r["display"]
                cells.append(("**%s**" % v if atb else v) + "<br>%.4f" % r["density"])
            print("| %d | %s |" % (P, " | ".join(cells)))
        print()


if __name__ == "__main__" and len(sys.argv) == 2:
    main(sys.argv[1])


def comparisons(path):
    """Markdown table: our certified scores against literature values."""
    with open(path) as f:
        recs = json.load(f)["records"]
    print("| problem | ours (score_float) | literature | status | ours - literature | source |")
    print("|---|---:|---:|---|---:|---|")
    for r in recs:
        for lit in r.get("literature") or []:
            v = lit.get("value")
            diff = "" if v is None else "%.2e" % (r["score_float"] - v)
            vs = "—" if v is None else "%.9f" % v
            print("| %s | %.9f | %s | %s | %s | %s%s |" % (
                r["problem"], r["score_float"], vs, lit["status"].replace("_", " "), diff, lit["short"],
                ("; " + lit["note"]) if lit.get("note") else ""))


if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[2] == "--compare":
    comparisons(sys.argv[1])
