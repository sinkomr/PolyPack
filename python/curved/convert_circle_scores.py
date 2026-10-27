#!/usr/bin/env python3
"""Doubles the scores of the curved records with a circle container (M = 0) and polygon pieces (2026-10-27).

A circle container is scored by its DIAMETER (the unit change); before, curved M = 0 sizes were the geodesic radius.
The geometry of every configuration is unchanged: only the score is stated differently, so each of the 65 best-known
records (and the same 'bound.lower', the sensitivities ds/dK, and the copy of the Euclidean record's value) doubles
exactly (a power of two), `display` is recomputed by the nearest-6-decimals rule from the exact binary value, and the
configuration's `size` doubles with it. Lengths that are not sizes (clearances, margin, pose coordinates) are kept.
Refuses to run twice (header key circle_scores).

Usage: python3 python/curved/convert_circle_scores.py
"""
import json
import os
import sys
from decimal import ROUND_HALF_EVEN, Decimal

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
PATH = os.path.join(ROOT, "data", "curved", "records.json")


def display(x):
    return str(Decimal(x).quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN))


def main():
    with open(PATH) as fh:
        doc = json.load(fh)
    if "circle_scores" in doc:
        print("already converted")
        return 1
    n = 0
    for r in doc["records"]:
        if r["M"] != 0 or r["N"] == 0 or r["status"] == "infeasible":
            continue
        for k in ("score_float", "score_cert", "cert_minus_float"):
            r[k] *= 2
        r["display"] = display(r["score_cert"])
        r["config"]["size"] *= 2
        r["config_touching"]["size"] *= 2
        r["bound"]["lower"] *= 2
        r["bound"]["kind"] = (
            r["bound"]["kind"]
            .replace("(r >= R)", "(diameter >= 2 R)")
            .replace("r >= 2 rho", "diameter >= 4 rho")
        )
        s = r["sensitivity"]
        s["dsdK_envelope"] *= 2
        for k in ("min", "max"):
            if s["dsdK_multiplier_range"].get(k) is not None:
                s["dsdK_multiplier_range"][k] *= 2
        if r.get("euclidean_record"):
            r["euclidean_record"]["value"] *= 2
        n += 1
    doc["circle_scores"] = "diameter"
    doc["conventions"]["score"] = "s (M >= 3, the side) or the container's geodesic DIAMETER (M = 0; its radius is s / 2); smaller is better"
    doc["conventions"]["units"] = doc["conventions"]["units"].replace("scored by its geodesic RADIUS r", "scored by its geodesic DIAMETER s = 2 r")
    doc["conventions"]["container"] = doc["conventions"]["container"].replace("or disk of radius r (M = 0)", "or disk of diameter s (radius s / 2) (M = 0)")
    with open(PATH, "w") as fh:
        json.dump(doc, fh, indent=1)
    print("converted", n, "records")
    return 0


if __name__ == "__main__":
    sys.exit(main())
