"""analyze.py tagA-budget [tagB-budget ...]: per-problem median gap (%) over seeds, class medians,
time to within 1% and 0.1% of the reference (median over seeds; inf when never), and wins."""
import json
import os
import statistics
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    rows = [json.loads(l) for l in open(os.path.join(HERE, "results", name + ".jsonl"))]
    by = defaultdict(list)
    for r in rows:
        by[(r["N"], r["M"], r["P"])].append(r)
    return by


def cls(k):
    N, M, P = k
    if N == 0:
        return "disk"
    if N == 4 and M == 4:
        return "square"
    return "polygon"


def ttt(r, x):
    for t, s in r["trace"]:
        if (s - r["ref"]) / r["ref"] <= x:
            return t
    return float("inf")


names = sys.argv[1:]
data = [load(n) for n in names]
keys = sorted(set().union(*[d.keys() for d in data]), key=lambda k: (cls(k), k))
print("problem".ljust(12) + "".join(f"{n:>22}" for n in names))
classes = defaultdict(lambda: defaultdict(list))
for k in keys:
    line = f"{k[0]}/{k[1]}/{k[2]}".ljust(12)
    for n, d in zip(names, data):
        rs = d.get(k, [])
        if not rs:
            line += " " * 22
            continue
        g = statistics.median(100 * r["gap"] for r in rs)
        classes[n][cls(k)].append(g)
        classes[n]["all"].append(g)
        t1 = statistics.median(ttt(r, 0.001) for r in rs)
        line += f"{g:>11.4f}% t.1%={t1:>6.1f}"
    print(line)
print()
for c in ["disk", "square", "polygon", "all"]:
    print(c.ljust(12) + "".join(f"{statistics.median(classes[n][c]) if classes[n][c] else float('nan'):>21.4f}%" for n in names))
print("mean all".ljust(12) + "".join(f"{statistics.mean(classes[n]['all']):>21.4f}%" for n in names))
# Runs (problem x seed) that came within 0.1% and 0.01% of the reference, and the median time to
# within 0.1% over all runs (inf counts as never)
for x in (0.001, 0.0001):
    print(f"<{100 * x:g}% runs".ljust(12) + "".join(f"{sum(r['gap'] <= x for v in d.values() for r in v):>14d}/{sum(len(v) for v in d.values()):<7d}" for d in data))
print("t to 0.1%".ljust(12) + "".join(f"{statistics.median(ttt(r, 0.001) for v in d.values() for r in v):>21.1f}s" for d in data))
if len(names) == 2:
    a, b = data
    w = l = 0
    for k in keys:
        if k in a and k in b:
            ga = statistics.median(r["gap"] for r in a[k])
            gb = statistics.median(r["gap"] for r in b[k])
            if gb < ga - 1e-7:
                w += 1
            elif gb > ga + 1e-7:
                l += 1
    print(f"{names[1]} better on {w}, worse on {l} of {len(keys)} (median gap)")
