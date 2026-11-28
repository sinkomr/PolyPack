#!/usr/bin/env python3
"""Runs every problem x solver x seed of the fresh-solvers benchmark (native/FRESH.md).

    python3 native/tools/fresh/run.py [--seconds 60] [--concurrency 5] [--out native/tools/fresh/runs.jsonl]
    python3 native/tools/fresh/run.py --only sphere/0/30 --solvers port,js --seeds 1 --seconds 20

Solvers: js (apps/volunteer + packages/spaces searched through tsx), port (native/target/release/polypack-native
bench / bench-space), fresh (native/target/release/fresh-{flat,round,balls,polyhedra}). One thread each, CPU-time clocks.
Appends one JSON line per run to --out and skips the runs already in it (resumable; a failed run is kept and not
repeated unless --retry-failed). Standard library only.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
BIN = ROOT / "native" / "target" / "release"


def family(pid):
    head = pid.split("/")[0]
    return head if head in ("flat", "curved", "sphere", "balls", "polyhedra", "torus", "surface") else "other"


def command(solver, pid, seconds, seed):
    fam = family(pid)
    if solver == "fresh":
        if fam == "surface":
            exe = {"nofold": "fresh-surface-nofold"}[pid.split("/")[2]]
        else:
            exe = {"flat": "fresh-flat", "curved": "fresh-round", "sphere": "fresh-round", "balls": "fresh-balls", "polyhedra": "fresh-polyhedra", "torus": "fresh-torus"}[fam]
            if fam == "balls" and not pid.split("/")[1].startswith("ballin"):
                exe = "fresh-polyhedra"  # solids in a ball
        return [str(BIN / exe), "--id", pid, "--seconds", str(seconds), "--seed", str(seed)]
    if solver == "port":
        if fam == "flat":
            _, n, m, p = pid.split("/")
            return [str(BIN / "polypack-native"), "bench", "--N", n, "--M", m, "--P", p, "--seconds", str(seconds), "--seed", str(seed)]
        return [str(BIN / "polypack-native"), "bench-space", "--id", pid, "--seconds", str(seconds), "--seed", str(seed)]
    if solver == "js":
        script = "js-flat.mts" if fam == "flat" else "js-space.mts"
        return [str(ROOT / "node_modules" / ".bin" / "tsx"), str(HERE / script), "--id", pid, "--seconds", str(seconds), "--seed", str(seed)]
    raise ValueError(solver)


def to_contract(solver, pid, seed, seconds, raw):
    """The port's flat bench output in the contract's shape; every other output already is."""
    if solver == "port" and family(pid) == "flat":
        trace, last = [], float("inf")
        for e in raw.get("trace", []):
            b = e.get("best")
            if b is not None and b < last:
                last = b
                trace.append({"t": e["t"], "best": b})
        return {
            "solver": "port", "id": pid, "seed": seed, "seconds": seconds, "clock": raw.get("clock", "cpu"),
            "score": raw.get("score"), "config": raw.get("config"), "evaluations": raw.get("evaluations", 0),
            "check_valid": (raw["check_valid"] and raw["check_strict"]) if raw.get("check_valid") is not None else None,
            "trace": trace, "jobs": raw.get("jobs"), "stopped": raw.get("stopped"), "engine_seconds": raw.get("engine_seconds"),
        }
    return raw


def run_one(job, timeout):
    solver, pid, seed, seconds = job
    cmd = command(solver, pid, seconds, seed)
    t0 = time.time()
    rec = {"id": pid, "family": family(pid), "solver": solver, "seed": seed, "seconds": seconds, "cmd": cmd[1:] if solver == "js" else cmd}
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=ROOT)
        rec.update(exit_code=p.returncode, timed_out=False)
        rec["wall_s"] = time.time() - t0
        result = None
        for line in reversed(p.stdout.strip().splitlines()):
            try:
                result = json.loads(line)
                break
            except ValueError:
                continue
        if result is None or p.returncode != 0:
            rec["stderr_tail"] = p.stderr[-1500:]
            rec["stdout_tail"] = p.stdout[-300:] if result is None else ""
        rec["result"] = to_contract(solver, pid, seed, seconds, result) if result is not None else None
    except subprocess.TimeoutExpired as e:
        rec.update(exit_code=None, timed_out=True, wall_s=time.time() - t0, result=None, stderr_tail=(e.stderr or b"")[-1500:].decode(errors="replace") if isinstance(e.stderr, bytes) else str(e.stderr or "")[-1500:])
    except Exception as e:  # a missing binary
        rec.update(exit_code=None, timed_out=False, wall_s=time.time() - t0, result=None, stderr_tail=f"{type(e).__name__}: {e}")
    return rec


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--problems", default=str(HERE / "problems.json"))
    ap.add_argument("--only", help="comma-separated problem ids instead of the problem file")
    ap.add_argument("--solvers", default="js,port,fresh")
    ap.add_argument("--seeds", default="1,2,3")
    ap.add_argument("--seconds", type=float, default=60.0)
    ap.add_argument("--concurrency", type=int, default=5)
    ap.add_argument("--timeout", type=float, help="per-run wall timeout in seconds (default 2 x seconds + 60)")
    ap.add_argument("--order-seed", type=int, default=20261121)
    ap.add_argument("--out", default=str(HERE / "runs.jsonl"))
    ap.add_argument("--retry-failed", action="store_true", help="run again the runs recorded with a failure")
    a = ap.parse_args()

    problems = a.only.split(",") if a.only else json.loads(Path(a.problems).read_text())
    solvers = a.solvers.split(",")
    seeds = [int(s) for s in a.seeds.split(",")]
    timeout = a.timeout or 2 * a.seconds + 60
    out = Path(a.out)
    done = set()
    if out.exists():
        for line in out.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            failed = r.get("exit_code") != 0
            if not (failed and a.retry_failed):
                done.add((r["solver"], r["id"], r["seed"], r["seconds"]))
    jobs = [(s, p, k, a.seconds) for p in problems for s in solvers for k in seeds if (s, p, k, a.seconds) not in done]
    random.Random(a.order_seed).shuffle(jobs)
    print(f"{len(jobs)} runs to do ({len(done)} already in {out}), concurrency {a.concurrency}, timeout {timeout:.0f} s", file=sys.stderr)
    lock = threading.Lock()
    count = [0]

    def work(job):
        rec = run_one(job, timeout)
        with lock:
            with out.open("a") as f:
                f.write(json.dumps(rec) + "\n")
            count[0] += 1
            r = rec["result"] or {}
            print(f"[{count[0]}/{len(jobs)}] {rec['solver']:5} {rec['id']:28} seed {rec['seed']} exit {rec['exit_code']} wall {rec['wall_s']:.1f}s score {r.get('score')}", file=sys.stderr, flush=True)

    with ThreadPoolExecutor(max_workers=a.concurrency) as ex:
        list(ex.map(work, jobs))


if __name__ == "__main__":
    main()
