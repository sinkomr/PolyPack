"""Assemble data/torus/records.json from raw search results, certifying every entry.

  python3 python/torus/build_records.py --raw data/torus/raw --out data/torus

For each (family, N, P) the candidates are: the raw result; for free, the sq and
hex results read as free-lattice packings; for every family, the P+1 result with
its last piece removed (L(P) <= L(P+1) because deleting a piece keeps a packing
valid). The best candidate is certified with the smallest shrink eps on a ladder
that the interval certifier (certify_torus.py) accepts; score_cert is the
smallest double >= the certified upper bound of score/(1 - eps). Standard
library only (plus the certifier's mpmath).
"""

import argparse
import datetime
import json
import math
import os
import sys
from decimal import ROUND_CEILING, Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import certify_torus as C  # noqa: E402
import literature_torus as LIT  # noqa: E402

EPS_LADDER = (1e-12, 1e-11, 1e-10, 1e-9)
# Proven clearances below this are valid but too thin for a float re-check (the TypeScript
# records test re-validates the shrunk configuration in doubles); take the next eps instead.
MIN_CLEARANCE = 5e-14
SOFTWARE = "PolyPack torus research build"
FOUND_BY = "PolyPack research"
SQ3_2 = math.sqrt(3.0) / 2.0


def piece_area(N):
    return math.pi if N == 0 else N / (4.0 * math.tan(math.pi / N))


def basis_of(rec):
    fam = rec["family"]
    p = rec["params"]
    if fam == "sq":
        return (p[0], 0.0), (0.0, p[0])
    if fam == "hex":
        return (p[0], 0.0), (0.5 * p[0], SQ3_2 * p[0])
    return (p[0], 0.0), (p[1], p[2])


def score_float(fam, b1, b2, L=None):
    if fam in ("sq", "hex"):
        return L
    return math.sqrt(abs(b1[0] * b2[1] - b1[1] * b2[0]))


def norm_theta(N, th):
    if N == 0:
        return 0.0
    per = 2 * math.pi / N
    return th - per * math.floor(th / per)


def candidate(fam, N, P, raw, label):
    """A certifier input from a raw search result (possibly of another family)."""
    b1, b2 = basis_of(raw)
    poses = [[float(x), float(y), norm_theta(N, float(t))] for x, y, t in raw["poses"]]
    if fam in ("sq", "hex"):
        lattice = {"L": float(raw["params"][0])}
        sf = float(raw["params"][0])
    else:
        lattice = {"b1": [float(b1[0]), float(b1[1])], "b2": [float(b2[0]), float(b2[1])]}
        sf = score_float("free", b1, b2)
    return {
        "family": fam,
        "N": N,
        "P": P,
        "lattice": lattice,
        "poses": poses,
        "score_float": sf,
        "label": label,
        "raw": raw,
    }


def drop_last(cand):
    c = dict(cand)
    c["P"] = cand["P"] - 1
    c["poses"] = cand["poses"][:-1]
    c["label"] = "P+1 result minus one piece (" + cand["label"] + ")"
    return c


def certify_candidate(c):
    last = None
    for eps in EPS_LADDER:
        rec = {k: c[k] for k in ("family", "N", "P", "lattice", "poses")}
        rec["eps"] = eps
        try:
            cert = C.certify(rec)
        except C.CertError as e:
            last = str(e)
            continue
        if float(cert["min_clearance_lb"]) < MIN_CLEARANCE:
            last = "clearance %s below %g" % (cert["min_clearance_lb"], MIN_CLEARANCE)
            continue
        rec["score_cert"] = cert["score_upper_float"]
        cert = C.certify(rec)  # re-check with the claim
        return eps, cert
    raise C.CertError("no eps on the ladder certifies: %s" % last)


def display_up(x, digits=6):
    q = Decimal(1).scaleb(-digits)
    return str(Decimal(x).quantize(q, rounding=ROUND_CEILING))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--Ns", default="0,3,4,5,6,7,8")
    ap.add_argument("--Pmax", type=int, default=16, help="searched range 1..Pmax")
    ap.add_argument("--raw-ext", default=None, help="extension results (extend_torus.py) for P > Pmax")
    ap.add_argument("--Pext", type=int, default=49)
    args = ap.parse_args()
    Ns = [int(v) for v in args.Ns.split(",")]
    certdir = os.path.join(args.out, "certificates")
    os.makedirs(certdir, exist_ok=True)

    def load_from(d, fam, N, P):
        if d is None:
            return None
        fn = os.path.join(d, "%s_%d_%d.json" % (fam, N, P))
        if not os.path.exists(fn):
            return None
        with open(fn) as f:
            return json.load(f)

    def loads(fam, N, P):
        """Search result (P <= Pmax) and exact replication (any P), when present."""
        out = []
        if P <= args.Pmax:
            out.append(load_from(args.raw, fam, N, P))
        out.append(load_from(args.raw_ext, fam, N, P))
        return [r for r in out if r is not None]

    Ptop = args.Pext if args.raw_ext else args.Pmax

    records = []
    report = []
    for fam in ("sq", "hex", "free"):
        for N in Ns:
            chosen = {}
            for P in range(Ptop, 0, -1):
                cands = []
                for raw in loads(fam, N, P):
                    cands.append(candidate(fam, N, P, raw, raw.get("label", "search")))
                if fam == "free":
                    for fam2 in ("sq", "hex"):
                        for r2 in loads(fam2, N, P):
                            cands.append(candidate("free", N, P, r2, "%s result as a free lattice" % fam2))
                if (P + 1) in chosen and P < args.Pmax:
                    cands.append(drop_last(chosen[P + 1]))
                if not cands:
                    continue
                cands.sort(key=lambda c: c["score_float"])
                chosen[P] = cands[0]
            for P in range(1, Ptop + 1):
                if P not in chosen:
                    continue
                c = chosen[P]
                eps, cert = certify_candidate(c)
                pid = "torus/%s/%d/%d" % (fam, N, P)
                certname = "certificates/%s_%d_%d.json" % (fam, N, P)
                with open(os.path.join(args.out, certname), "w") as f:
                    json.dump(cert, f, indent=1)
                b1, b2 = (c["lattice"]["b1"], c["lattice"]["b2"]) if fam == "free" else basis_of(
                    {"family": fam, "params": [c["lattice"]["L"]]}
                )
                area = abs(b1[0] * b2[1] - b1[1] * b2[0])
                dens = P * piece_area(N) / area
                sc = cert["score_upper_float"]
                bound = LIT.score_bound(fam, N, P)
                lit = LIT.literature(fam, N, P)
                raw = c["raw"]
                notes = []
                gap_rel = (c["score_float"] - bound["value"]) / bound["value"]
                exact = LIT.exact_form(fam, N, P, c["score_float"])
                if gap_rel <= 1e-12:
                    notes.append("[CALC] score_float equals the lower bound (%s) to 1e-12 relative." % bound["label"])
                    if exact:
                        notes.append(
                            "[CALC] Exact value %s = %.15g (a lattice, double-lattice or tiling construction attains the bound); the stored floats certify score_cert just above it."
                            % (exact["expr"], exact["value"])
                        )
                if c["label"].startswith("P+1") or "as a free lattice" in c["label"]:
                    notes.append("Taken from: %s." % c["label"])
                for L_ in lit:
                    if L_.get("value") is not None:
                        d = c["score_float"] - L_["value"]
                        notes.append(
                            "Literature %s value %.10f (%s): ours - literature = %.3e."
                            % (L_["status"], L_["value"], L_["short"], d)
                        )
                rec = {
                    "problem": pid,
                    "family": fam,
                    "N": N,
                    "P": P,
                    "score_float": c["score_float"],
                    "score_cert": sc,
                    "display": display_up(sc),
                    "status": "best_known",
                    "density": dens,
                    "eps": eps,
                    "configuration": {"lattice": c["lattice"], "poses": c["poses"]},
                    "certificate": certname,
                    "min_clearance_shrunk": cert["min_clearance_lb"],
                    "bound": bound,
                    "exact": exact if gap_rel <= 1e-12 else None,
                    "literature": lit,
                    "method": raw.get("method", "search"),
                    "seed": raw.get("seed"),
                    "budget": raw.get("budget"),
                    "search_label": c["label"],
                    "software": SOFTWARE,
                    "found_by": FOUND_BY,
                    "notes": " ".join(notes),
                }
                records.append(rec)
                report.append(
                    "%-18s %.10f cert %.10f eps %.0e dens %.6f bound %.10f gap %.2e %s"
                    % (pid, c["score_float"], sc, eps, dens, bound["value"], gap_rel, c["label"][:30])
                )
                print(report[-1], flush=True)
    out = {
        "generated": datetime.date.today().isoformat(),
        "conventions": {
            "problem_id": "torus/<family>/<N>/<P>",
            "pieces": "N = 0: disk of radius 1; N >= 3: regular N-gon of side 1, vertex k at (x, y) + R (cos a_k, sin a_k), a_k = theta + pi/2 + 2 pi k/N, R = 1/(2 sin(pi/N)); theta in radians",
            "families": {
                "sq": "lattice L Z^2; lattice = {L}; score L",
                "hex": "lattice generated by L (1, 0) and L (1/2, sqrt(3)/2); lattice = {L}; score L",
                "free": "any lattice; lattice = {b1, b2}; score sqrt(|det(b1, b2)|) = sqrt(cell area)",
            },
            "validity": "interiors of all pieces and all their lattice translates pairwise disjoint, including a piece and its own nonzero translates",
            "score_float": "score of the stored configuration (search result, float)",
            "score_cert": "proven: shrinking every piece of the stored configuration by (1 - eps) about its centre leaves all image pairs strictly separated (mpmath interval certificate); scaling the plane by score_cert/score_float >= 1/(1 - eps) then gives a valid packing of full-size pieces at score_cert",
            "display": "score_cert rounded up to 6 decimals",
            "density": "P * piece area / cell area of the stored configuration",
            "units": "polygon side 1, disk radius 1",
        },
        "records": records,
    }
    with open(os.path.join(args.out, "records.json"), "w") as f:
        json.dump(out, f, indent=1)
    print("wrote %d records" % len(records))


if __name__ == "__main__":
    main()
