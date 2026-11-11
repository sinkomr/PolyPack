"""Benchmark of the native engine against the JavaScript engine at equal CPU seconds.

    python3 native/tools/bench.py OUT.jsonl --seconds 20 --seeds 1,2 --jobs 6 \
        --impl native=native/target/release/polypack-native \
        --impl js-main=. --impl js-perf=/path/to/other/checkout

Every run is one problem's search on one lane, from scratch, with the engine's and the jobs'
clocks on CPU time (`polypack-native bench`, native/tools/js-bench.mts). Results are appended to
OUT.jsonl, one line per run; runs already there are skipped, so an interrupted benchmark resumes.
`--summary` prints the table of the results instead.
"""
import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

PANEL = [(4, 4), (3, 6), (0, 4), (7, 0)]
SIZES = [5, 20, 50, 150]
NAMES = {(4, 4): "squares in a square", (3, 6): "triangles in a hexagon", (0, 4): "disks in a square", (7, 0): "heptagons in a circle"}
HERE = os.path.dirname(os.path.abspath(__file__))


def command(impl, target, n, m, p, seconds, seed):
    if impl.startswith("native"):
        return [target, "bench", "--N", str(n), "--M", str(m), "--P", str(p), "--seconds", str(seconds), "--seed", str(seed)], None
    root = os.path.abspath(target)
    return ["npx", "tsx", os.path.join(HERE, "js-bench.mts"), root, str(n), str(m), str(p), str(seconds), str(seed)], root


def run_one(args):
    impl, target, n, m, p, seconds, seed = args
    cmd, cwd = command(impl, target, n, m, p, seconds, seed)
    out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    line = next((l for l in out.stdout.splitlines() if l.startswith("{")), None)
    if line is None:
        return {"impl": impl, "N": n, "M": m, "P": p, "seed": seed, "seconds": seconds, "error": out.stderr[-500:]}
    d = json.loads(line)
    d.pop("trace", None)
    d["impl"] = impl
    return d


def summary(path):
    """Mean score over the seeds (and the number of seeds), mean evaluations per CPU second."""
    rows = [json.loads(l) for l in open(path) if l.strip()]
    impls = sorted({r["impl"] for r in rows})
    print("| problem | P | " + " | ".join(f"{i} score | {i} ev/s" for i in impls) + " |")
    print("|---|---:|" + "---:|---:|" * len(impls))
    for nm in PANEL:
        for p in SIZES:
            cells = []
            for i in impls:
                rs = [r for r in rows if r["impl"] == i and (r["N"], r["M"]) == nm and r["P"] == p and r.get("score")]
                if not rs:
                    cells.append("- | -")
                    continue
                mean = sum(r["score"] for r in rs) / len(rs)
                eps = sum(r["evaluations_per_second"] for r in rs) / len(rs)
                cells.append(f"{mean:.6f} ({len(rs)}) | {eps:,.0f}")
            if any(c != "- | -" for c in cells):
                print(f"| {NAMES[nm]} | {p} | " + " | ".join(cells) + " |")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--seeds", default="1,2")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--impl", action="append", default=[])
    ap.add_argument("--sizes", default=",".join(map(str, SIZES)))
    ap.add_argument("--summary", action="store_true")
    a = ap.parse_args()
    if a.summary:
        summary(a.out)
        return
    done = set()
    if os.path.exists(a.out):
        for l in open(a.out):
            if l.strip():
                r = json.loads(l)
                if "error" not in r:
                    done.add((r["impl"], r["N"], r["M"], r["P"], r["seed"], float(r["seconds"])))
    impls = [s.split("=", 1) for s in a.impl]
    todo = []
    for seed in [int(s) for s in a.seeds.split(",")]:
        for p in [int(s) for s in a.sizes.split(",")]:
            for n, m in PANEL:
                for impl, target in impls:
                    if (impl, n, m, p, seed, float(a.seconds)) not in done:
                        todo.append((impl, target, n, m, p, a.seconds, seed))
    print(f"{len(todo)} runs to do", file=sys.stderr)
    with ThreadPoolExecutor(a.jobs) as pool, open(a.out, "a") as f:
        for r in pool.map(run_one, todo):
            f.write(json.dumps(r) + "\n")
            f.flush()
            print(r.get("impl"), r.get("N"), r.get("M"), r.get("P"), r.get("seed"), r.get("score"), r.get("error", "")[:200], file=sys.stderr)


if __name__ == "__main__":
    main()
