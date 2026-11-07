"""Builds warm.json: panel problems whose site leader is behind the literature value and whose
literature has no coordinates, with the leader's packing (GET /api/submissions/<id>) as the start.
This is what a volunteer starts from on those problems."""
import json
import os
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
panel = json.load(open(os.path.join(HERE, "panel.json")))
recs = {(r["N"], r["M"], r["P"]): r for r in json.load(open(os.path.join(HERE, "../../data/records.json")))["records"]}
out = []
for p in panel:
    k = (p["N"], p["M"], p["P"])
    if recs[k].get("pieces") or not p["site_best"] or p["site_best"] <= p["literature"] * (1 + 1e-6):
        continue
    d = json.load(urllib.request.urlopen(f"https://polypack.fly.dev/api/problems/{k[0]}/{k[1]}/{k[2]}"))
    sid = d["site_best"]["id"]
    s = json.load(urllib.request.urlopen(f"https://polypack.fly.dev/api/submissions/{sid}"))
    out.append({**p, "known": {"pieces": s.get("pieces"), "container_phi": s.get("container_phi", 0), "score": s.get("score")}})
    print(k, sid, s.get("score"), len(s.get("pieces") or []))
    time.sleep(0.2)
json.dump(out, open(os.path.join(HERE, "warm.json"), "w"))
