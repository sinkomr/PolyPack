"""Median gap (%) of the chain runs against sr-60 and v2-60 on the same problems."""
import collections
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
IDS = ["0/4/100", "3/3/20", "6/0/40", "4/4/37", "5/5/20", "3/4/20"]
for f in ["chain10", "chain4", "chain4lo"]:
    d = collections.defaultdict(list)
    for l in open(os.path.join(HERE, "results", f + ".jsonl")):
        r = json.loads(l)
        d[r["id"]].append(r["gap"])
    print(f.ljust(8), {k: round(statistics.median(d[k]), 4) for k in IDS})
for f in ["sr-60", "v2-60", "base-60"]:
    d = collections.defaultdict(list)
    for l in open(os.path.join(HERE, "results", f + ".jsonl")):
        r = json.loads(l)
        d["%d/%d/%d" % (r["N"], r["M"], r["P"])].append(100 * r["gap"])
    print(f.ljust(8), {k: round(statistics.median(d[k]), 4) for k in IDS})
