"""diagnose.py tag-budget: where the engine's time goes. Per arm (kind:method[params]): jobs,
CPU seconds, jobs that improved the best, total log-improvement credited; stop reasons; CPU
used against the budget; which arm produced each problem's final best."""
import json
import math
import os
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(os.path.join(HERE, "results", sys.argv[1] + ".jsonl"))]
arm = defaultdict(lambda: dict(jobs=0, cpu=0.0, wins=0, gain=0.0, final=0))
stops = Counter()
used = []
for r in rows:
    stops[r.get("stopped", "?")] += 1
    used.append(r["cpu"] / r["budget"])
    best = r.get("start") or math.inf
    prev = 0.0
    final = None
    for j in r["jobs"]:
        key = f"{j['k']}:{j['m']}" + ("[" + j["p"][:24] + "]" if j.get("p") and "family" not in j["p"] else "")
        a = arm[key]
        a["jobs"] += 1
        a["cpu"] += j["t"] - prev
        prev = j["t"]
        s = j["s"]
        if s is not None and s < best * (1 - 1e-9):
            if best < math.inf:
                a["wins"] += 1
                a["gain"] += math.log(best / s)
            best = s
            final = key
    if final:
        arm[final]["final"] += 1
print("stops", dict(stops), "mean cpu share used %.2f" % (sum(used) / len(used)))
tot = sum(a["cpu"] for a in arm.values())
print(f"{'arm':44} jobs  cpu%   wins  gain(log)  final")
for k, a in sorted(arm.items(), key=lambda kv: -kv[1]["cpu"]):
    print(f"{k:44} {a['jobs']:4d} {100 * a['cpu'] / tot:5.1f} {a['wins']:5d} {a['gain']:10.5f} {a['final']:5d}")
