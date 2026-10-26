"""Runs the unit tests of the new spaces' certifiers (python/<space>/test_*.py), each in its own process.

Each test file puts its own directory on the import path, so they are run as scripts rather than
collected into one unittest run. Exits non-zero when any of them fails.
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = [
    "boundary/test_boundary.py",
    "curved/test_certify.py",
    "curved/test_bounds.py",
    "polyhedra/test_certify.py",
    "sphere/test_certify.py",
    "surface/test_cert.py",
    "surface/test_general.py",
    "torus/test_certify_torus.py",
    "torus/test_torus_tools.py",
]


def main() -> int:
    failed = []
    for rel in TESTS:
        start = time.time()
        run = subprocess.run([sys.executable, os.path.join(HERE, rel)], capture_output=True, text=True)
        status = "ok" if run.returncode == 0 else "FAILED"
        print(f"{rel}: {status} ({time.time() - start:.1f} s)")
        if run.returncode != 0:
            failed.append(rel)
            sys.stdout.write(run.stdout[-4000:])
            sys.stdout.write(run.stderr[-4000:])
    if failed:
        print(f"{len(failed)} of {len(TESTS)} test files failed: {', '.join(failed)}")
        return 1
    print(f"all {len(TESTS)} test files passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
