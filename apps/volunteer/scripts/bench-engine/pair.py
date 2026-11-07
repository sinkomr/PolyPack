"""pair.py A B: gap (%) per problem and seed for two result files, on the cells both have, and
the evaluations of each run's jobs (to compare solver speed at equal CPU)."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    out = {}
    for l in open(os.path.join(HERE, "results", name + ".jsonl")):
        r = json.loads(l)
        out[(r["N"], r["M"], r["P"], r["seed"])] = r
    return out


a, b = (load(n) for n in sys.argv[1:3])
for k in sorted(set(a) & set(b)):
    ra, rb = a[k], b[k]
    ea = sum(j["e"] for j in ra["jobs"])
    eb = sum(j["e"] for j in rb["jobs"])
    print(f"{k}  {100 * ra['gap']:8.4f}% {100 * rb['gap']:8.4f}%   evals {ea:7d} {eb:7d}  cpu {ra['cpu']:5.1f} {rb['cpu']:5.1f}")
