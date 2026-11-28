#!/usr/bin/env python3
"""Per-problem table of a validated runs file (validate.mts output), for the surface fold report.

    python3 native/tools/fresh/table-surface.py runs.validated.jsonl [--eps 1e-2,1e-3,1e-4]

R = the best TypeScript-valid final score of any run of the problem. For each solver: valid runs / runs, final gap
score / R - 1 per seed, and CPU seconds to R (1 + eps) per seed ('-': not reached). Standard library only.
"""
import argparse
import json
import math
from collections import defaultdict

SOLVERS = ["fresh", "port", "js"]


def time_to(run, target):
    if not run["valid"] or run["score"] > target:
        return None
    for e in sorted(run["trace"], key=lambda e: e["t"]):
        if e["best"] <= target:
            return max(e["t"], 1e-3)
    return run["engine_s"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs")
    ap.add_argument("--eps", default="1e-2,1e-3,1e-4")
    a = ap.parse_args()
    eps = [float(x) for x in a.eps.split(",")]
    runs = []
    for line in open(a.runs):
        if not line.strip():
            continue
        r = json.loads(line)
        res = r.get("result") or {}
        runs.append({
            "id": r["id"], "solver": r["solver"], "seed": r["seed"],
            "valid": bool(r.get("ts_valid")) and r.get("ts_score") is not None, "score": r.get("ts_score"),
            "trace": res.get("trace") or [], "engine_s": res.get("engine_seconds") or r.get("seconds") or 0.0,
        })
    by = defaultdict(list)
    for r in runs:
        by[r["id"]].append(r)
    print("| problem | R | solver | valid | final gap (per seed) | " + " | ".join(f"t to {e:g} (s)" for e in eps) + " |")
    print("|---|---|---|---|---|" + "---|" * len(eps))
    for pid in sorted(by):
        rs = by[pid]
        vals = [r["score"] for r in rs if r["valid"]]
        if not vals:
            print(f"| {pid} | - | | | |" + " |" * len(eps))
            continue
        R = min(vals)
        first = True
        for s in SOLVERS:
            x = sorted([r for r in rs if r["solver"] == s], key=lambda r: r["seed"])
            if not x:
                continue
            gaps = " / ".join(("%.1e" % (r["score"] / R - 1)) if r["valid"] else "invalid" for r in x)
            ts = []
            for e in eps:
                ts.append(" / ".join((lambda t: "-" if t is None else f"{t:.3g}")(time_to(r, R * (1 + e))) for r in x))
            head = f"{pid} | {R:.10g}" if first else " | "
            print(f"| {head} | {s} | {sum(r['valid'] for r in x)}/{len(x)} | {gaps} | " + " | ".join(ts) + " |")
            first = False


if __name__ == "__main__":
    main()
