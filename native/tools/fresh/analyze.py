#!/usr/bin/env python3
"""Time-to-quality report of the fresh-solvers benchmark (native/FRESH.md), as markdown on stdout.

    python3 native/tools/fresh/analyze.py runs.validated.jsonl [--eps 1e-2,1e-3,1e-4] [--times 5,15,60]

Input: the output of validate.mts. Per problem the reference R is the best ts_score over all runs whose
final packing the server's validators accept. A run counts only if its final packing is ts-valid (otherwise it is
reported as invalid, or as "none" when it produced no packing: crash, timeout, null result). Its time to a target
R (1 + eps) is the CPU time of the first trace entry at or below the target, provided its final ts_score is at the
target too; otherwise the run is censored for that target. Standard library only.
"""
import argparse
import json
import math
import statistics
import sys
from collections import defaultdict

SOLVERS = ["js", "port", "fresh"]
FAMILIES = ["flat", "curved", "sphere", "balls", "polyhedra", "torus"]
PAIRS = [("fresh", "port"), ("fresh", "js"), ("port", "js")]  # (a, b): ratio = time of b / time of a, > 1 when a is faster
FLOOR = 1e-3  # seconds: a target reached before the first entry's clock tick counts as 1 ms


def fmt(x, nd=3):
    return "-" if x is None else f"{x:.{nd}g}"


def time_to(run, target):
    """CPU seconds to reach `target`, or None (censored)."""
    if not run["valid"] or run["score"] > target:
        return None
    for e in run["trace"]:
        if e["best"] <= target:
            return max(e["t"], FLOOR)
    return max(run["engine_s"], FLOOR)  # no trace entry (a solver that traced nothing): the whole run


def gap_at(run, T, R):
    """Relative gap to R of the best packing found by CPU time T, or None when none yet."""
    if not run["valid"]:
        return None
    best = None
    for e in run["trace"]:
        if e["t"] <= T and (best is None or e["best"] < best):
            best = e["best"]
    if best is None and not run["trace"]:
        best = run["score"] if run["engine_s"] <= T else None
    return None if best is None else max(best / R - 1, 0.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs")
    ap.add_argument("--eps", default="1e-2,1e-3,1e-4")
    ap.add_argument("--times", default="5,15,60")
    a = ap.parse_args()
    eps_list = [float(x) for x in a.eps.split(",")]
    times = [float(x) for x in a.times.split(",")]

    raw = [json.loads(l) for l in open(a.runs) if l.strip()]
    runs = []
    for r in raw:
        res = r.get("result") or {}
        has_packing = res.get("config") is not None
        valid = bool(r.get("ts_valid")) and r.get("ts_score") is not None
        runs.append({
            "id": r["id"], "family": r["family"], "solver": r["solver"], "seed": r["seed"],
            "has_packing": has_packing, "valid": valid, "score": r.get("ts_score"),
            "match": r.get("ts_score_match"), "claims_valid": res.get("check_valid"),
            "trace": sorted(res.get("trace") or [], key=lambda e: e["t"]),
            "engine_s": res.get("engine_seconds") or r.get("seconds") or 0.0,
            "failed": r.get("exit_code") != 0, "wall_s": r.get("wall_s"), "evals": res.get("evaluations"),
        })
    ref = {}
    for r in runs:
        if r["valid"]:
            ref[r["id"]] = min(ref.get(r["id"], math.inf), r["score"])
    for r in runs:
        r["R"] = ref.get(r["id"])
    problems = sorted({r["id"] for r in runs})
    print(f"# Fresh solvers benchmark\n\n{len(runs)} runs, {len(problems)} problems, {len({r['seed'] for r in runs})} seeds. "
          f"{len(ref)} problems have a reference R (best ts-valid final score of any run).\n")
    no_ref = [p for p in problems if p not in ref]
    if no_ref:
        print(f"Problems without any valid run (not analysed): {', '.join(no_ref)}\n")
    mism = [r for r in runs if r["valid"] and r["match"] is False]
    if mism:
        print(f"Warning: {len(mism)} valid runs report a score that differs from the validator's beyond the tie tolerance "
              f"({', '.join(sorted({r['solver'] for r in mism}))}).\n")
    bad_claim = [r for r in runs if r["valid"] is False and r["claims_valid"] is True]
    if bad_claim:
        print(f"Warning: {len(bad_claim)} runs claim check_valid but fail the TypeScript validator "
              f"({', '.join(sorted({r['solver'] for r in bad_claim}))}).\n")

    def section(title, rs):
        print(f"## {title}\n")
        by = {s: [r for r in rs if r["solver"] == s] for s in SOLVERS}
        print("### Validity and reaching the targets\n")
        head = "| solver | runs | valid | invalid | none |" + "".join(f" reach {e:g} | median t {e:g} (s) |" for e in eps_list)
        print(head)
        print("|" + "---|" * (5 + 2 * len(eps_list)))
        for s in SOLVERS:
            x = by[s]
            if not x:
                continue
            row = f"| {s} | {len(x)} | {sum(r['valid'] for r in x)} | {sum((not r['valid']) and r['has_packing'] for r in x)} | {sum(not r['has_packing'] for r in x)} |"
            for e in eps_list:
                ts = [time_to(r, r['R'] * (1 + e)) for r in x if r["R"] is not None]
                reached = [t for t in ts if t is not None]
                row += f" {len(reached)}/{len(ts)} | {fmt(statistics.median(reached)) if reached else '-'} |"
            print(row)
        print("\n(invalid: a packing the validator rejects; none: no packing at all. Runs that reach nothing are censored; the median is over the runs that reach.)\n")

        print("### Speed ratio over (problem, seed) pairs where both reach the target\n")
        print("Geometric mean over the pairs of (time of b) / (time of a): above 1, a is faster.\n")
        print("| a vs b | target | both | only a | only b | neither | geo-mean b/a |")
        print("|---|---|---|---|---|---|---|")
        idx = {(r["id"], r["seed"], r["solver"]): r for r in rs}
        keys = sorted({(r["id"], r["seed"]) for r in rs if r["R"] is not None})
        for A, B in PAIRS:
            for e in eps_list:
                both = oa = ob = nn = 0
                logs = []
                for (pid, seed) in keys:
                    ra, rb = idx.get((pid, seed, A)), idx.get((pid, seed, B))
                    if ra is None or rb is None:
                        continue
                    tgt = ra["R"] * (1 + e)
                    ta, tb = time_to(ra, tgt), time_to(rb, tgt)
                    if ta is not None and tb is not None:
                        both += 1
                        logs.append(math.log(tb / ta))
                    elif ta is not None:
                        oa += 1
                    elif tb is not None:
                        ob += 1
                    else:
                        nn += 1
                g = math.exp(sum(logs) / len(logs)) if logs else None
                print(f"| {A} vs {B} | {e:g} | {both} | {oa} | {ob} | {nn} | {fmt(g)} |")
        print()

        print("### Mean relative gap to R at fixed CPU times\n")
        print("Gap = best valid score found by then / R - 1, over the runs that have a packing by then (n of the valid runs).\n")
        print("| solver |" + "".join(f" t = {t:g} s |" for t in times))
        print("|---|" + "---|" * len(times))
        for s in SOLVERS:
            x = [r for r in by[s] if r["R"] is not None]
            if not x:
                continue
            row = f"| {s} |"
            for T in times:
                g = [gap_at(r, T, r["R"]) for r in x]
                g = [v for v in g if v is not None]
                row += f" {fmt(statistics.mean(g)) if g else '-'} (n={len(g)}/{len(x)}) |"
            print(row)
        print()

    for fam in FAMILIES:
        rs = [r for r in runs if r["family"] == fam]
        if rs:
            section(f"Family: {fam}", rs)
    section("All families", runs)

    print("## Runs without a valid packing\n")
    bad = [r for r in runs if not r["valid"]]
    if not bad:
        print("None.")
    for r in sorted(bad, key=lambda r: (r["solver"], r["id"], r["seed"])):
        why = "failed (exit code or timeout)" if r["failed"] else ("invalid packing" if r["has_packing"] else "no packing")
        print(f"- {r['solver']} {r['id']} seed {r['seed']}: {why}")


if __name__ == "__main__":
    main()
