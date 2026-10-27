"""Replace records of data/sphere/records.json by better search results, leaving every other record
byte-identical (the file is re-written with the same json.dump settings, indent=1).

A record is replaced only when a run in RUN_DIRS has a smaller rho (by more than 1e-12 relative)
and the new configuration is certified by python/sphere/certify.py at its score_cert (the record is
rebuilt by finalize.build: margin, witnesses, bounds, literature verdict, notes).

With --redisplay, every record's display is recomputed from score_cert with the current rule
(certify.display_6: nearest at 6 decimals, half-even, exact binary64 value) and the conventions text
is updated; no other field of any record is touched.

Usage:
  python3 python/sphere/update_records.py --runs RUN_DIR [RUN_DIR ...] [--records data/sphere/records.json] [--dry-run] [--redisplay]
Prints old -> new for every replaced record (rho and circumradius).
"""
import argparse
import glob
import json
import math
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import certify as cert  # noqa: E402
import finalize as fin  # noqa: E402


def circumradius(N, rho):
    if N == 0:
        return 1 / (2 * rho)  # angular radius of a disk of diameter 1
    return math.asin(math.sin(1 / (2 * rho)) / math.sin(math.pi / N))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="+", required=True)
    ap.add_argument("--records", default=os.path.join(_HERE, "..", "..", "data", "sphere", "records.json"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--redisplay", action="store_true")
    args = ap.parse_args()
    raw = open(args.records).read()
    data = json.loads(raw)
    if json.dumps(data, indent=1, allow_nan=False) != raw.rstrip("\n"):
        sys.exit("records.json is not in the json.dump(indent=1) format; refusing to rewrite it")
    if data.get("units") != "diameter":
        sys.exit("records.json is not in site units (header units != \"diameter\"): convert it first (scripts/convert-units.ts)")
    by = {(r["N"], r["P"]): i for i, r in enumerate(data["records"])}
    best = {}
    for d in args.runs:
        for fn in glob.glob(os.path.join(d, "sphere_*_*.json")):
            r = fin.site_run(json.load(open(fn)))
            key = (r["N"], r["P"])
            if key not in best or r["rho"] < best[key][0]["rho"]:
                best[key] = (r, fn)
    lit = json.load(open(os.path.join(_HERE, "..", "..", "data", "sphere", "literature.json")))
    tam, poly = fin.lit_values(lit)
    changed = []
    for key, (r, fn) in sorted(best.items()):
        if key not in by:
            continue
        old = data["records"][by[key]]
        if not r["rho"] < old["score_float"] * (1 - 1e-12):
            continue
        meta = {"seed": r.get("seed"), "budget": r.get("budget"),
                "method": "penalty continuation with separating-plane variables (L-BFGS-B), SLSQP polish with edge/plane witnesses in a box trust region, basin hopping; rerun on a quiet machine with longer budgets (warm start from the previous record, Tammes-code starts with random or neighbour-aligned orientations, random starts)"}
        rec, err = fin.build(key[0], key[1], r["rho"], r["q"], meta, tam, poly)
        if rec is None:
            print(f"sphere/{key[0]}/{key[1]}: new run not certified ({err}); kept the old record")
            continue
        res = cert.certify_record(rec)
        if not res["certified"]:
            print(f"sphere/{key[0]}/{key[1]}: rebuilt record fails the published-record checks ({res.get('error')}); kept")
            continue
        N, P = key
        ol, nl = old.get("literature") or {}, rec.get("literature") or {}
        line = (f"{rec['id']}: rho {old['score_float']:.9f} -> {rec['score_float']:.9f} (display {old['display']} -> {rec['display']}); "
                f"R {circumradius(N, old['score_float']):.7f} -> {circumradius(N, rec['score_float']):.7f}")
        if nl.get("radius"):
            line += f"; dOSV R {nl['radius']}: {ol.get('verdict')} -> {nl.get('verdict')}"
        print(line, f"[{os.path.basename(os.path.dirname(fn))}]")
        changed.append(rec["id"])
        data["records"][by[key]] = rec
    ndisp = 0
    if args.redisplay:
        for r in data["records"]:
            nd = cert.display_6(r["score_cert"])
            if r["display"] != nd:
                r["display"] = nd
                ndisp += 1
        data["conventions"]["display"] = "score_cert rounded to the nearest at 6 decimals (half-even, from its exact binary64 value)"
        print(f"display strings changed: {ndisp} of {len(data['records'])}")
    if (changed or args.redisplay) and not args.dry_run:
        data["generated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with open(args.records, "w") as f:
            json.dump(data, f, indent=1, allow_nan=False)
    print(f"{len(changed)} records replaced{' (dry run)' if args.dry_run else ''}: {changed}")


if __name__ == "__main__":
    main()
