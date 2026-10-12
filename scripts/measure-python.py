"""Reproduce Python contact-refinement measurements using TypeScript validation."""

import json
import math
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def command(args):
    return subprocess.run(
        args, cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout


def cases():
    expansion = 1.03
    distance = (1 + math.sqrt(0.5)) / 2 * expansion
    squares = [{"x": 0, "y": 0, "theta": 0}] + [
        {"x": x * distance, "y": y * distance, "theta": math.pi / 4}
        for x, y in [(-1, -1), (-1, 1), (1, -1), (1, 1)]
    ]
    circles = [{"x": 0, "y": 0, "theta": 0}] + [
        {
            "x": 2 * expansion * math.cos(k * math.pi / 3),
            "y": 2 * expansion * math.sin(k * math.pi / 3),
            "theta": 0,
        }
        for k in range(6)
    ]
    hexagons = json.loads((ROOT / "data/corpus/N6-M0-P10.json").read_text())["config"][
        "pieces"
    ]
    return [
        ("five_squares", 4, 4, squares, 2 + math.sqrt(0.5)),
        ("seven_circles", 0, 0, circles, 3),
        ("ten_hexagons_in_circle", 6, 0, hexagons, None),
    ]


def main():
    results = []
    with tempfile.TemporaryDirectory(prefix="polypack-python-") as temporary:
        directory = Path(temporary)
        for name, n, m, pieces, target in cases():
            config = {
                "N": n,
                "M": m,
                "P": len(pieces),
                "container_phi": 0,
                "pieces": pieces,
            }
            source_corpus = None
            if name == "ten_hexagons_in_circle":
                source_corpus = "data/corpus/N6-M0-P10.json"
                config = json.loads((ROOT / source_corpus).read_text())["config"]
            input_path = directory / f"{name}.json"
            contacts_path = directory / f"{name}-contacts.json"
            result_path = directory / f"{name}-result.json"
            input_path.write_text(json.dumps(config))
            contacts_path.write_text(
                command(
                    [
                        "node",
                        "--import",
                        "tsx",
                        "scripts/polish-contacts.ts",
                        str(input_path),
                    ]
                )
            )
            before = time.perf_counter()
            command(
                [
                    sys.executable,
                    "python/polish_mp.py",
                    str(contacts_path),
                    "--iterations",
                    "80",
                    "--out",
                    str(result_path),
                ]
            )
            runtime = time.perf_counter() - before
            result = json.loads(result_path.read_text())
            accepted = json.loads(
                command(
                    [
                        "node",
                        "--import",
                        "tsx",
                        "scripts/validate-polish.ts",
                        str(contacts_path),
                        str(result_path),
                    ]
                )
            )
            results.append(
                {
                    "case": name,
                    "source_corpus": source_corpus,
                    "N": n,
                    "M": m,
                    "P": len(pieces),
                    "runtime_seconds": runtime,
                    "iterations": result.get("iterations"),
                    "newton_steps": result.get("newton_steps"),
                    "valid_after_typescript_revalidation": accepted["valid"],
                    "accepted_refinement": accepted["accepted_refinement"],
                    "server_score": accepted["score"],
                    "known_target": target,
                    "absolute_target_error": abs(accepted["score"] - target)
                    if target
                    else None,
                    "container_size_50_digits": result.get("container_size_50_digits"),
                    "maximum_active_contact_residual": result.get(
                        "maximum_active_contact_residual"
                    ),
                    "achieved_contact_residual_digits": result.get(
                        "achieved_contact_residual_digits"
                    ),
                    "minimum_constraint_gap": result.get("minimum_constraint_gap"),
                    "reason": result.get("reason"),
                }
            )
            print(
                f"{name}: {runtime:.3f}s, score={accepted['score']}, valid={accepted['valid']}",
                flush=True,
            )
    output = {
        "python": platform.python_version(),
        "mpmath": "1.3.0",
        "working_precision_digits": 50,
        "platform": platform.platform(),
        "measured_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "command": "python/.venv/bin/python scripts/measure-python.py",
        "note": "Runtime includes Python process startup and independent float64 validation. Contact residual digits are not correct score digits or a proof of optimality.",
        "cases": results,
    }
    (ROOT / "python/measurements.json").write_text(json.dumps(output, indent=2) + "\n")


if __name__ == "__main__":
    main()
