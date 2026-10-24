"""Extend the tables to larger P where it is cheap: exact replications that attain a bound.

  python3 python/torus/extend_torus.py --raw data/torus/raw --out data/torus/raw_ext --Pmax 49

A packing with q pieces on the lattice B Z^2 is also a packing with q k pieces on any
sublattice B M Z^2 of index k = |det M| (the pieces are repeated over the cosets). The
density is unchanged, so when the q-piece packing attains a density bound, so does the
replica. Cases written (each for Pmin <= P <= Pmax):
  free, N in {0, 4, 6}: P = k (from P = 1; lattice packings that attain the bound);
  free, N in {3, 5}:    P = 2 k (from the P = 2 double lattice; tiling resp. Hales-Kusner);
  sq,  N = 4:           P = a^2 + b^2 (M = [[a, -b], [b, a]], a rotated square sublattice);
  hex, N in {0, 6}:     P = a^2 + a b + b^2 (M = [[a, -b], [b, a + b]], rotated hexagonal);
  hex, N = 3:           P = 2 (a^2 + a b + b^2) from the P = 2 tiling.
The free-family sublattice is the most nearly square one of index k (for display only).
For P <= 16 these replications are extra candidates beside the search results (they are
exact up to float rounding, where the search polish may stop 1e-10 short).
Output files use the raw search schema and are certified by build_records.py.
"""

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from torus_np import Geometry, basis_of  # noqa: E402
from torus_search import from_json, hnf_list, replicate, to_json  # noqa: E402


def norms_sq(k):
    return [(a, b) for a in range(0, k + 1) for b in range(0, k + 1) if a * a + b * b == k and a > 0]


def norms_hex(k):
    return [(a, b) for a in range(0, k + 1) for b in range(0, k + 1) if a * a + a * b + b * b == k and a > 0]


def squarest(B, k):
    """HNF of index k whose sublattice basis (reduced) is closest to square."""
    best = None
    for M in hnf_list(k):
        Bn = B @ M.astype(float)
        from torus_np import gauss_reduce

        Br, _ = gauss_reduce(Bn)
        n1, n2 = np.linalg.norm(Br[:, 0]), np.linalg.norm(Br[:, 1])
        q = n2 / n1
        if best is None or q < best[0] - 1e-12:
            best = (q, M)
    return best[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--Pmin", type=int, default=2)
    ap.add_argument("--Pmax", type=int, default=49)
    ap.add_argument("--octagons", action="store_true", help="also extend free octagon lattices beyond P = 16")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    def load(fam, N, P):
        with open(os.path.join(args.raw, "%s_%d_%d.json" % (fam, N, P))) as f:
            return json.load(f)

    jobs = []
    for N in (0, 4, 6, 8):
        # octagons: the lattice packing; it attains a proven bound only if the densest packing of
        # congruent centrally symmetric disks is a lattice packing (see docs), so P > 16 only
        # with --octagons
        top = args.Pmax if (N != 8 or args.octagons) else min(args.Pmax, 16)
        jobs += [("free", N, 1, k, None) for k in range(args.Pmin, top + 1)]
    for N in (3, 5, 7):
        # heptagons: the best known double lattice, only within the searched range P <= 16
        top = args.Pmax if N != 7 else min(args.Pmax, 16)
        jobs += [("free", N, 2, k // 2, None) for k in range(max(4, args.Pmin), top + 1) if k % 2 == 0]
    for P in range(args.Pmin, args.Pmax + 1):
        ab = norms_sq(P)
        if ab:
            jobs.append(("sq", 4, 1, P, ab[0]))
        ab = norms_hex(P)
        if ab:
            jobs.append(("hex", 0, 1, P, ab[0]))
            jobs.append(("hex", 6, 1, P, ab[0]))
        if P % 2 == 0 and P >= 4 and norms_hex(P // 2):
            jobs.append(("hex", 3, 2, P // 2, norms_hex(P // 2)[0]))
    for fam, N, q, k, ab in jobs:
        if not os.path.exists(os.path.join(args.raw, "%s_%d_%d.json" % (fam, N, q))):
            print("skip %s N=%d P=%d: no base result for P=%d" % (fam, N, q * k, q))
            continue
        base = load(fam, N, q)
        st = from_json(base)
        if fam == "free":
            M = squarest(basis_of("free", st.params), k)
        elif fam == "sq":
            a, b = ab
            M = np.array([[a, -b], [b, a]], dtype=np.int64)
        else:
            a, b = ab
            M = np.array([[a, -b], [b, a + b]], dtype=np.int64)
        ns = replicate(fam, st, M, fam)
        P = q * k
        geo = Geometry(fam, N, P)
        ms = geo.min_sep(ns)
        meta = {
            "label": "replication of the P=%d result over an index-%d sublattice" % (q, k),
            "seed": None,
            "budget": None,
            "method": "exact replication (same density as the P=%d packing)" % q,
            "sublattice": M.tolist(),
        }
        out = to_json(geo, ns, ms, meta)
        with open(os.path.join(args.out, "%s_%d_%d.json" % (fam, N, P)), "w") as f:
            json.dump(out, f, indent=1)
        print("%s N=%d P=%d score=%.10f dens=%.6f msep=%.2e" % (fam, N, P, out["score"], out["density"], ms))


if __name__ == "__main__":
    main()
