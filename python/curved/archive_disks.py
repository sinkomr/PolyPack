#!/usr/bin/env python3
"""Moves the curved space's radius-1 disk data out of the served files into data/curved/archive/ (2026-10-27).

Disk pieces (N = 0) changed from radius 1 to diameter 1 (radius 1/2). A radius-1 disk packing at curvature K is the
diameter-1 packing at curvature 4 K scaled by 2, so the 52 records, the 12 catalogue entries, the bounds, ideal-family
and certificate entries and the curvature sweeps of disks of radius 1 are not answers to the diameter-1 problems at
K = -1, 0, 1: those problems are open. The radius-1 data is kept, unchanged, under data/curved/archive/ (README.md
there) and no longer served. Polygon-piece data is untouched, except for the header of records.json.

Moves: records.json (records and catalogue), certification.json, bounds.json, ideal.json and sweep/{records,summary}.json
are split by N = 0; sweep/sweep_0_0_*.json (disk sweeps) are moved as they are. Refuses to run twice.

Usage: python3 python/curved/archive_disks.py
"""
import glob
import json
import os
import shutil
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DATA = os.path.join(ROOT, "data", "curved")
ARCHIVE = os.path.join(DATA, "archive")
DATE = "2026-10-27"
NOTE = (
    "Radius-1 disk data (disks of radius 1, N = 0), archived " + DATE + " when disk pieces became diameter 1. "
    "Equivalent to diameter-1 disks at K = +-4 (K x 4, lengths x 1/2). Kept for reference, not served."
)


def load(path):
    with open(path) as fh:
        return json.load(fh)


def dump(path, doc, compact=False):
    """Written as the data files are: indent 1 (sweep/records.json: compact), no trailing newline."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        if compact:
            json.dump(doc, fh, separators=(",", ":"))
        else:
            json.dump(doc, fh, indent=1)


def id_N(rid):
    """N of 'curved/K/N/M/P[#b]' or 'curved-sweep/N/M/P'."""
    parts = rid.split("/")
    return int(parts[2]) if parts[0] == "curved" else int(parts[1])


def split(items, n_of):
    keep = [x for x in items if n_of(x) != 0]
    out = [x for x in items if n_of(x) == 0]
    return keep, out


def main():
    if os.path.exists(ARCHIVE):
        print("data/curved/archive exists: already archived")
        return 1
    counts = {}
    # records.json: records and catalogue
    path = os.path.join(DATA, "records.json")
    doc = load(path)
    recs, arch_recs = split(doc["records"], lambda r: r["N"])
    cat, arch_cat = split(doc["catalogue"], lambda c: c["N"])
    counts["records"] = len(arch_recs)
    counts["catalogue"] = len(arch_cat)
    dump(os.path.join(ARCHIVE, "records.json"), dict(archived=NOTE, generated=doc["generated"], conventions=doc["conventions"], catalogue=arch_cat, records=arch_recs))
    conv = dict(doc["conventions"])
    conv["units"] = "geodesic lengths at curvature K; polygon pieces have side 1, disk pieces (N = 0) diameter 1 (radius 1/2); the container is a regular M-gon of side s or, for M = 0, a disk scored by its geodesic RADIUS r"
    served = dict(generated=doc["generated"], units="diameter", units_date=DATE, conventions=conv, catalogue=cat, records=recs)
    dump(path, served)
    # certification.json
    path = os.path.join(DATA, "certification.json")
    doc = load(path)
    keep, arch = split(doc["results"], lambda r: id_N(r["id"]))
    counts["certification"] = len(arch)
    dump(os.path.join(ARCHIVE, "certification.json"), dict(archived=NOTE, **{k: v for k, v in doc.items() if k != "results"}, results=arch))
    doc["results"] = keep
    dump(path, doc)
    # bounds.json and ideal.json
    path = os.path.join(DATA, "bounds.json")
    doc = load(path)
    keep, arch = split(doc["bounds"], lambda b: b["N"])
    counts["bounds"] = len(arch)
    dump(os.path.join(ARCHIVE, "bounds.json"), dict(archived=NOTE, **{k: v for k, v in doc.items() if k != "bounds"}, bounds=arch))
    doc["bounds"] = keep
    dump(path, doc)
    path = os.path.join(DATA, "ideal.json")
    doc = load(path)
    keep, arch = split(doc["entries"], lambda e: e["N"])
    counts["ideal"] = len(arch)
    dump(os.path.join(ARCHIVE, "ideal.json"), dict(archived=NOTE, **{k: v for k, v in doc.items() if k != "entries"}, entries=arch))
    doc["entries"] = keep
    dump(path, doc)
    # sweeps
    path = os.path.join(DATA, "sweep", "records.json")
    doc = load(path)
    keep, arch = split(doc["records"], lambda r: r["N"])
    counts["sweep records"] = len(arch)
    dump(os.path.join(ARCHIVE, "sweep", "records.json"), dict(archived=NOTE, **{k: v for k, v in doc.items() if k != "records"}, records=arch), compact=True)
    doc["records"] = keep
    doc["units"] = "diameter"
    doc["units_date"] = DATE
    dump(path, doc, compact=True)
    path = os.path.join(DATA, "sweep", "summary.json")
    doc = load(path)
    keep, arch = split(doc["problems"], lambda p: id_N(p["id"]))
    counts["sweep summary"] = len(arch)
    dump(os.path.join(ARCHIVE, "sweep", "summary.json"), dict(archived=NOTE, **{k: v for k, v in doc.items() if k != "problems"}, problems=arch))
    doc["problems"] = keep
    dump(path, doc)
    moved = 0
    for f in sorted(glob.glob(os.path.join(DATA, "sweep", "sweep_0_*.json"))):
        shutil.move(f, os.path.join(ARCHIVE, "sweep", os.path.basename(f)))
        moved += 1
    counts["sweep files"] = moved
    print("archived:", ", ".join(f"{k} {v}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
