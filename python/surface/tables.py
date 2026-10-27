"""Builds data/surface/records.json from certified candidates.

Subcommands:
  candidates NOFOLD.json EXACT.json OUT.json [SEARCH.jsonl ...] [--extra CANDIDATES.json ...]
      one candidate list: nofold configurations in nofold mode (#nofold) and in fold mode
      (#asfold), exact tilings (#exact), fold search results (#search, the best per problem) and
      ready-made candidates such as the one-piece replicas of build-replicas.ts (#replica).
  subsets CERTIFIED.json OUT.json
      fold candidates "P+1 minus one piece" (#subset) wherever P+1's best certified fold value is
      below P's: removing a piece keeps a strictly valid packing strictly valid.
  assemble OUT_RECORDS.json CERTDIR_IN CERTDIR_OUT CERTIFIED.json [CERTIFIED.json ...]
      best certified candidate per problem, with bounds and provenance; certificate bundles
      rewritten to contain the winners only, keyed by record id.

Certification itself is run_cert.py (the candidates' "id" is the candidate id: <record id>#<kind>).
"""

import gzip
import json
import math
import os
import sys
from fractions import Fraction

SOFTWARE = "PolyPack surface research build"
FOUND_BY = "PolyPack research"
ASFOLD_MAX_P = 24
FACES = {"tetrahedron": (4, 3), "cube": (6, 4), "octahedron": (8, 3), "dodecahedron": (12, 5), "icosahedron": (20, 3)}


def load(path):
    with open(path) as fh:
        return json.load(fh)


def piece_area(N):
    return math.pi / 4 if N == 0 else N / (4 * math.tan(math.pi / N))  # a disk has diameter 1


def bounds(solid, N, P):
    F, M = FACES[solid]
    area = math.sqrt(P * piece_area(N) * 4 * math.tan(math.pi / M) / (F * M))
    r = 0.5 if N == 0 else 1 / (2 * math.tan(math.pi / N))
    one = 2 * math.sin(math.pi / M) * r
    return area, one


def nudge_inside(solid, s, p):
    """A search centre within 1e-12 of its face boundary (or rounded just outside it) is moved 4e-12
    (relative) towards the face centre, so that the pose rule 'centre in the closed face' holds
    exactly; the certificate's shrink absorbs the move."""
    F, M = FACES[solid]
    ap = s / (2 * math.tan(math.pi / M))
    depth = min(ap - (p["x"] * math.cos(2 * math.pi * (j + 1) / M - math.pi / 2)
                      + p["y"] * math.sin(2 * math.pi * (j + 1) / M - math.pi / 2)) for j in range(M))
    if depth >= 1e-12 * s:
        return p
    k = 1 - 4e-12 - max(0.0, -depth) / ap
    return dict(p, x=p["x"] * k, y=p["y"] * k)


def cmd_candidates(nofold_path, exact_path, out_path, search_paths, extra_paths=()):
    out = []
    for path in extra_paths:
        out.extend(load(path)["records"])
    for r in load(nofold_path)["records"]:
        base = {k: r[k] for k in ("solid", "N", "P", "s", "pieces")}
        rid = "surface/%s/%%s/%d/%d" % (r["solid"], r["N"], r["P"])
        prov = {"face_packing": r["face_packing"], "k_per_face": r["k_per_face"], "k_min": r["k_min"]}
        out.append(dict(base, id=rid % "nofold" + "#nofold", mode="nofold", kind="nofold", provenance=prov))
        # fold searches cover P <= 24; the nofold packing as a fold candidate is only needed there
        if r["P"] <= ASFOLD_MAX_P:
            out.append(dict(base, id=rid % "fold" + "#asfold", mode="fold", kind="asfold", provenance=prov))
    for r in load(exact_path)["records"]:
        out.append(dict({k: r[k] for k in ("solid", "N", "P", "s", "pieces")}, id=r["id"] + "#exact", mode="fold",
                        kind="exact", provenance={"exact": r["exact"]}))
    best = {}
    for path in search_paths:
        with open(path) as fh:
            for line in fh:
                if not line.strip():
                    continue
                r = json.loads(line)
                r["_file"] = os.path.basename(path)
                key = (r["solid"], r["N"], r["P"])
                if key not in best or r["s"] < best[key]["s"]:
                    best[key] = r
    for (solid, N, P), r in sorted(best.items()):
        r["pieces"] = [nudge_inside(solid, r["s"], p) for p in r["pieces"]]
        prov = {k: r.get(k) for k in ("label", "seed", "starts", "hops", "seconds_budget", "seconds", "warm")}
        prov["search_file"] = r["_file"]
        out.append(dict({k: r[k] for k in ("solid", "N", "P", "s", "pieces")},
                        id="surface/%s/fold/%d/%d#search" % (solid, N, P), mode="fold", kind="search", provenance=prov))
    with open(out_path, "w") as fh:
        json.dump({"records": out}, fh)
    print("candidates:", len(out))


def best_certified(paths, mode=None):
    best = {}
    for path in paths:
        for r in load(path)["records"]:
            if "score_cert" not in r:
                continue
            if mode and r["mode"] != mode:
                continue
            key = (r["solid"], r["mode"], r["N"], r["P"])
            if key not in best or r["score_cert"] < best[key]["score_cert"]:
                best[key] = r
    return best


def cmd_subsets(certified_paths, out_path):
    best = best_certified(certified_paths, "fold")
    out = []
    cur = dict(best)
    for solid, N in sorted({(k[0], k[2]) for k in best}):
        pmax = max(4 * FACES[solid][0], 24)  # the nofold table's range; beyond it only exact tilings are listed
        # walk P downwards so that removals chain (P+2 -> P+1 -> P)
        for P in range(pmax, 0, -1):
            key = (solid, "fold", N, P)
            up = cur.get((solid, "fold", N, P + 1))
            if not up or (key in cur and up["score_cert"] >= cur[key]["score_cert"]):
                continue
            pieces = up["pieces"][:-1]
            cand = {"id": "surface/%s/fold/%d/%d#subset" % (solid, N, P), "solid": solid, "mode": "fold", "N": N,
                    "P": P, "s": up["s"], "pieces": pieces, "kind": "subset",
                    "provenance": {"from": up["id"], "note": "the P+1 packing with its last piece removed"}}
            out.append(cand)
            cur[key] = dict(cand, score_cert=up["score_cert"])
    with open(out_path, "w") as fh:
        json.dump({"records": out}, fh)
    print("subset candidates:", len(out))


def meets_bound(r, bound):
    """A value meets its bound when score_cert / bound - 1 is at most the shrink plus float rounding:
    3 eps (eps >= 1e-12, while rounding s up to a float adds at most a few 1e-16)."""
    return r["score_cert"] / bound - 1 <= 3 * float(Fraction(r["eps"]))


def method_text(r):
    k = r["kind"]
    p = r.get("provenance", {})
    if k == "nofold":
        return "nofold: best 2D packing of %d pieces per face (envelope over k >= %d), one copy per face" % (
            p["k_per_face"], p["k_min"])
    if k == "asfold":
        return "the nofold packing (k = %d per face), certified in fold mode; the fold search found nothing better" % p["k_per_face"]
    if k == "exact":
        return "exact %s" % p["exact"]["construction"]
    if k == "search":
        return "fold search (packages/surface/src/search): start %s" % p.get("label")
    if k == "subset":
        return "the best P+1 fold packing minus one piece"
    if k == "replica":
        base = p.get("base", "")
        if p.get("closed_form"):
            base = "the closed-form one-piece placement (s = %s, centred on a face)" % p["closed_form"]
        return "%d copies of %s on faces %s, whose covered regions do not overlap" % (
            len(p.get("faces", [])), base, p.get("faces"))
    return k


def cmd_assemble(out_path, certdir_in, certdir_out, certified_paths):
    best = best_certified(certified_paths)
    searched = set()
    for path in certified_paths:
        for r in load(path)["records"]:
            if r.get("kind") == "search":
                searched.add((r["solid"], r["N"], r["P"]))
    bundles_in = {}
    for name in os.listdir(certdir_in):
        if name.endswith(".json"):
            bundles_in[name] = load(os.path.join(certdir_in, name))
    records = []
    bundles_out = {}
    nofold_val = {(k[0], k[2], k[3]): v["score_cert"] for k, v in best.items() if k[1] == "nofold"}
    for key in sorted(best, key=lambda k: (list(FACES).index(k[0]), k[1], k[2], k[3])):
        solid, mode, N, P = key
        r = best[key]
        # fold records only where a fold search ran or a fold construction exists (exact tiling, or a
        # better P+1 fold packing minus a piece); elsewhere fold <= nofold is all that is known
        if mode == "fold" and (solid, N, P) not in searched and r["kind"] not in ("exact", "subset", "replica"):
            continue
        rid = "surface/%s/%s/%d/%d" % key
        area, one = bounds(solid, N, P)
        bound = max(area, one)
        bname, bkey = r["certificate"].split("/", 1)[1].split("#", 1)
        cert = dict(bundles_in[bname][bkey])
        cert["id"] = rid
        cert["candidate"] = r["id"]
        out_name = "%s_%s.json.gz" % (solid, mode)
        bundles_out.setdefault(out_name, {})[rid] = cert
        prov = r.get("provenance", {})
        notes = []
        exact = None
        if r["kind"] == "exact":
            exact = prov["exact"]
            notes.append("[CALC] Exact tiling (%s, s = %s); it meets the area bound, so it is best possible by area. "
                         "Status stays best_known per PolyPack policy." % (exact["construction"], exact["s_exact"]))
        gap = r["score_cert"] / bound - 1
        if meets_bound(r, bound) and r["kind"] != "exact":
            notes.append("[CALC] Meets its lower bound (%s): score_cert / bound - 1 = %.1e, which is the float "
                         "rounding of s plus the certificate's shrink eps = %s. Status stays best_known." % (
                             "area" if area >= one else "one-piece", gap, r["eps"]))
        elif gap < 1e-6:
            notes.append("[CALC] Within %.1e (relative) of its lower bound; not shown to equal it." % gap)
        rec = {
            "id": rid, "solid": solid, "mode": mode, "N": N, "P": P,
            "score_float": r["s"], "score_cert": r["score_cert"], "display": r["display"],
            "gap_rel": r["gap_rel"], "eps": r["eps"], "status": "best_known",
            "s": r["s"], "pieces": r["pieces"],
            "certificate": "certificates/%s#%s" % (out_name, rid),
            "bound": {"value": bound, "kind": "area" if area >= one else "one-piece", "area": area, "one_piece": one,
                      "label": "[CALC]"},
            "gap_to_bound": r["score_cert"] / bound - 1,
            "method": method_text(r), "kind": r["kind"],
            "software": SOFTWARE, "found_by": FOUND_BY,
        }
        if mode == "fold":
            rec["searched"] = (solid, N, P) in searched
            nv = nofold_val.get((solid, N, P))
            if nv is not None:
                rec["nofold_score_cert"] = nv
                rec["fold_gain"] = 1 - r["score_cert"] / nv
        if r["kind"] == "search":
            rec["seed"] = prov.get("seed")
            rec["budget"] = {k: prov.get(k) for k in ("starts", "hops", "seconds_budget")}
            rec["budget"]["seconds_used"] = prov.get("seconds")
            rec["budget"]["deadline_hit"] = (prov.get("seconds") or 0) >= (prov.get("seconds_budget") or 1e9) - 0.5
            rec["warm_starts"] = prov.get("warm")
        elif r["kind"] == "subset":
            rec["seed"] = None
            rec["budget"] = None
            rec["derived_from"] = prov.get("from")
        else:
            rec["seed"] = None
            rec["budget"] = None
        if r["kind"] in ("nofold", "asfold"):
            fp = prov["face_packing"]
            rec["sources"] = [fp]
            rec["k_per_face"] = prov["k_per_face"]
            notes.append("Each face holds a copy of the face packing (%d pieces per face, %s)." % (
                prov["k_per_face"], "PolyPack site entry #%s" % fp.get("entry_id") if fp["kind"] == "polypack_site"
                else fp.get("source_name")))
        if exact:
            rec["exact"] = exact
        rec["notes"] = " ".join(notes)
        records.append(rec)
    os.makedirs(certdir_out, exist_ok=True)
    for name, certs in bundles_out.items():
        # gzip with a fixed mtime so that rebuilding identical data gives identical files
        with open(os.path.join(certdir_out, name), "wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as fh:
                fh.write(json.dumps(certs, separators=(",", ":"), sort_keys=True).encode())
    doc = {
        "generated": "2026-10-24",
        "units": "diameter",
        "conventions": {
            "problem_id": "surface/<solid>/<mode>/<N>/<P>; solid in tetrahedron, cube, octahedron, dodecahedron, icosahedron; "
                          "mode fold (pieces may cross edges) or nofold (each piece in one closed face)",
            "units": "polygon pieces have side 1, disks (N = 0) diameter 1",
            "score": "edge length s of the solid (smaller is better)",
            "pose": "face f and (x, y, theta) in f's frame: the regular M-gon of side s centred at the origin with a "
                    "horizontal bottom edge; frame vertex k at angle -pi/2 + pi/M + 2 pi k/M is solids.json faces[f][k]; "
                    "piece vertex k at angle theta + pi/2 + 2 pi k/N (radians)",
            "certified_statement": "pieces scaled by lam = 1 - eps about their centres at edge s are strictly valid "
                                   "(python/surface/cert.py); by similarity unit pieces fit at edge s / lam, so "
                                   "score_cert = s / lam rounded up to a float; display = score_cert rounded to 6 decimals "
                                   "(nearest, ties to even, from its exact binary64 value)",
            "score_float": "s, the edge of the stored configuration (pieces touching up to float rounding)",
            "status": "best_known everywhere (no published proofs); see notes for matches with the bound",
            "docs": "docs/spaces/SURFACE.md",
        },
        "records": records,
    }
    with open(out_path, "w") as fh:
        json.dump(doc, fh, indent=None, separators=(",", ":"))
    print("records:", len(records))


def main(argv):
    cmd = argv[0]
    if cmd == "candidates":
        rest = argv[4:]
        extra = rest[rest.index("--extra") + 1:] if "--extra" in rest else []
        search = rest[:rest.index("--extra")] if "--extra" in rest else rest
        cmd_candidates(argv[1], argv[2], argv[3], search, extra)
    elif cmd == "subsets":
        cmd_subsets(argv[2:], argv[1])
    elif cmd == "assemble":
        cmd_assemble(argv[1], argv[2], argv[3], argv[4:])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
