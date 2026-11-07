"""Builds panel.json: the benchmark problems with the literature value (data/records.json) and the
site's best score (one GET per problem to /api/problems/N/M/P)."""
import json
import os
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
recs = json.load(open(os.path.join(HERE, "../../data/records.json")))["records"]
lit = {(r["N"], r["M"], r["P"]): r for r in recs}
panel = [
    (0, 0, 10), (0, 0, 30), (0, 0, 60), (0, 0, 120), (0, 4, 20), (0, 4, 50), (0, 4, 100), (0, 6, 20),
    (4, 4, 10), (4, 4, 17), (4, 4, 37), (4, 4, 80), (4, 4, 150),
    (3, 3, 20), (3, 0, 30), (3, 4, 20),
    (5, 5, 20), (5, 0, 30), (5, 4, 40),
    (6, 6, 30), (6, 0, 40), (7, 4, 20), (8, 8, 30), (8, 4, 50),
]
out = []
for N, M, P in panel:
    r = lit[(N, M, P)]
    d = json.load(urllib.request.urlopen(f"https://polypack.fly.dev/api/problems/{N}/{M}/{P}"))
    sb = (d.get("site_best") or {}).get("score")
    out.append(dict(N=N, M=M, P=P, literature=r["value"], status=r["status"], source=r["source_name"][:40], site_best=sb, area_bound=d.get("area_bound")))
    print(N, M, P, r["value"], sb, r["status"], r["source_name"][:30])
    time.sleep(0.2)
json.dump(out, open(os.path.join(HERE, "panel.json"), "w"), indent=1)
