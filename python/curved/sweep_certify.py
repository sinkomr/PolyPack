"""Certify the configurations prepared by a curvature sweep (packages/curved/scripts/sweep/run-sweep.ts).

Each sweep output carries `certs`: margin re-solved configurations (config_cert, score_cert,
witnesses) at exact binary64 values of K (grid values j/64 are also exact small rationals; crossing
curvatures K_c are exact binary64 numbers). Every one is checked with the unchanged rigorous
certifier python/curved/certify.py (256-bit interval arithmetic); the result is written next to the
input as <name>.cert.json:

    python3 python/curved/sweep_certify.py RUN.json [RUN2.json ...]

A configuration counts as certified only when certify.py proves it and the margin re-solve stayed
within 1e-9 relative of the touching value (score_cert - score_float <= 1e-9 * score_float).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import certify  # noqa: E402

REL_GAP = 1e-9


def certify_run(path):
    with open(path) as f:
        run = json.load(f)
    results = []
    ok = 0
    for c in run.get("certs", []):
        rec = {
            "id": c["id"],
            "K": c["K"],
            "N": c["N"],
            "M": c["M"],
            "P": c["P"],
            "score_cert": c["score_cert"],
            "config_cert": c["config_cert"],
            "witnesses": c.get("witnesses"),
        }
        res = certify.certify_record(rec)
        gap = c["score_cert"] - c["score_float"]
        rel = gap / c["score_float"]
        good = bool(res.get("certified")) and rel <= REL_GAP
        ok += good
        results.append(
            {
                "id": c["id"],
                "K": c["K"],
                "role": c["role"],
                "branch": c["branch"],
                "score_float": c["score_float"],
                "score_cert": c["score_cert"],
                "cert_minus_float": gap,
                "cert_minus_float_relative": rel,
                "certified": good,
                "certifier": {k: v for k, v in res.items() if k != "certified"},
                "certifier_certified": bool(res.get("certified")),
            }
        )
    out = path[:-5] + ".cert.json" if path.endswith(".json") else path + ".cert.json"
    with open(out, "w") as f:
        json.dump({"source": os.path.basename(path), "certifier": "python/curved/certify.py", "results": results}, f)
    worst = max((r["cert_minus_float_relative"] for r in results), default=0.0)
    print(f"{os.path.basename(path)}: {ok}/{len(results)} certified; worst (cert - float)/float = {worst:.2e}")
    return ok, len(results)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    tot = good = 0
    for p in argv[1:]:
        g, n = certify_run(p)
        good += g
        tot += n
    print(f"total {good}/{tot} certified")
    return 0 if good == tot else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
