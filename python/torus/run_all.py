"""Run the seeded torus search over all (family, N) with at most 2 workers.

Each worker is a separate `torus_search.py` process (nice 10, single-threaded
BLAS). scipy 1.7's HiGHS can abort the process on a singular basis; the runner
then restarts the job with --attempt k+1 (seed + 1000 k), skipping the P values
already written. Free-lattice jobs start after all sq/hex jobs so that they can
use those results as seeds.

  python3 python/torus/run_all.py --out data/torus/raw
"""

import argparse
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = dict(
    os.environ,
    OMP_NUM_THREADS="1",
    OPENBLAS_NUM_THREADS="1",
    MKL_NUM_THREADS="1",
    VECLIB_MAXIMUM_THREADS="1",
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--Ns", default="0,3,4,5,6,7,8")
    ap.add_argument("--P", default="1-16")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--final-scale", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=20261024)
    ap.add_argument("--max-attempts", type=int, default=6)
    ap.add_argument("--phases", default="A,B,C", help="comma list, run in the order given")
    ap.add_argument("--c-Ns", default=None, help="restrict phase C to these N")
    ap.add_argument("--wait-for", default=None, help="pgrep pattern: wait until no such process runs")
    ap.add_argument("--external", default=None, help="pgrep pattern of other search jobs that occupy worker slots")
    args = ap.parse_args()

    def external_jobs():
        if not args.external:
            return 0
        out = subprocess.run(["pgrep", "-f", args.external], capture_output=True, text=True).stdout.split()
        pids = set(out)
        n = 0
        for pid in pids:
            ppid = subprocess.run(["ps", "-o", "ppid=", "-p", pid], capture_output=True, text=True).stdout.strip()
            if ppid not in pids:  # count job parents, not their forked solver children
                n += 1
        return n

    if args.wait_for:
        while subprocess.run(["pgrep", "-f", args.wait_for], capture_output=True).returncode == 0:
            time.sleep(10)
    Ns = [int(v) for v in args.Ns.split(",")]
    os.makedirs(args.out, exist_ok=True)
    runlog = open(os.path.join(args.out, "runner.log"), "a")
    # Phase A: free lattices. Phase B: sq and hex, seeded by deformed free
    # solutions. Phase C: free again, seeded by the sq/hex solutions (only
    # improvements are written).
    phases = [
        ("A", [("free", n) for n in Ns], ["--skip-existing", "--scale", str(args.scale)]),
        ("B", [(f, n) for n in Ns for f in ("sq", "hex")],
         ["--skip-existing", "--scale", str(args.scale), "--from", args.out]),
        ("C", [("free", n) for n in Ns], ["--scale", str(args.final_scale), "--from", args.out, "--seed", str(args.seed + 7)]),
        # S: structured seeds only (lattice superlattices, replications, insertion, cross-family),
        # rerun after the superlattice enumeration fix of 2026-10-24 (only improvements are written)
        ("S", [(f, n) for n in Ns for f in ("sq", "hex")], ["--seeds-only", "--from", args.out, "--seed", str(args.seed + 11)]),
    ]
    if args.c_Ns:
        cN = [int(v) for v in args.c_Ns.split(",")]
        phases = [(ph, [j for j in jobs if ph != "C" or j[1] in cN], ex) for ph, jobs, ex in phases]

    def launch(phase, job, attempt, extra):
        fam, N = job
        cmd = [
            "nice", "-n", "10", sys.executable, os.path.join(HERE, "torus_search.py"),
            "--family", fam, "--N", str(N), "--P", args.P, "--seed", str(args.seed),
            "--attempt", str(attempt), "--out", args.out,
        ] + extra
        err = open(os.path.join(args.out, "stderr_%s_%d.txt" % (fam, N)), "a")
        runlog.write("%s start %s %s attempt %d\n" % (time.strftime("%H:%M:%S"), phase, job, attempt))
        runlog.flush()
        return subprocess.Popen(cmd, env=ENV, stdout=err, stderr=err)

    order = args.phases.split(",")
    phases = sorted([p for p in phases if p[0] in order], key=lambda p: order.index(p[0]))
    for phase, jobs, extra in phases:
        queue = list(jobs)
        running = {}
        while queue or running:
            while queue and len(running) + external_jobs() < args.workers:
                job = queue.pop(0)
                running[job] = (launch(phase, job, 0, extra), 0)
            time.sleep(2)
            for job, (proc, attempt) in list(running.items()):
                rc = proc.poll()
                if rc is None:
                    continue
                del running[job]
                runlog.write("%s end %s %s attempt %d rc %d\n" % (time.strftime("%H:%M:%S"), phase, job, attempt, rc))
                runlog.flush()
                if rc != 0 and attempt + 1 < args.max_attempts:
                    # a crash: restart, skipping P already written (a crashed phase C job therefore ends)
                    ex = extra if "--skip-existing" in extra else extra + ["--skip-existing"]
                    running[job] = (launch(phase, job, attempt + 1, ex), attempt + 1)
    runlog.write("%s all done\n" % time.strftime("%H:%M:%S"))


if __name__ == "__main__":
    main()
