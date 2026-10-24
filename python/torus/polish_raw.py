"""Final polish of raw search results (deterministic; writes only improvements).

  python3 python/torus/polish_raw.py --raw data/torus/raw [--part 0 --parts 2]

Some searches stop with a gap of ~1e-9 (the trust box reached its floor while a contact was
still opening). This reruns the SLP from each stored result with a small starting box down to
1e-12, keeps the result only if the score drops and the float overlap stays <= 1e-13.
"""

import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from torus_np import Geometry, metric_of  # noqa: E402
from torus_search import compress, from_json, isolated, repair, to_json  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--part", type=int, default=0)
    ap.add_argument("--parts", type=int, default=1)
    ap.add_argument("--pattern", default="*_*_*.json", help="file glob inside --raw")
    ap.add_argument("--deep", type=int, default=0, help="extra restart rounds with larger boxes (3e-2 ... 1e-3)")
    args = ap.parse_args()
    files = sorted(glob.glob(os.path.join(args.raw, args.pattern)))
    files = [f for i, f in enumerate(files) if i % args.parts == args.part]
    for fn in files:
        with open(fn) as f:
            rec = json.load(f)
        fam, N, P = rec["family"], rec["N"], rec["P"]
        geo = Geometry(fam, N, P)
        st = from_json(rec)
        m0 = metric_of(fam, st.params)
        best = None
        for d0 in (1e-4, 1e-6, 1e-3):
            res = isolated(compress, geo, st.copy(), delta0=d0, delta_min=1e-12, max_iter=800)
            if res is None:
                continue
            ps, ms = res
            if ms < -1e-13:
                ps, ms = repair(geo, ps, -1e-13)
            m = metric_of(fam, ps.params)
            if best is None or m < best[0]:
                best = (m, ps, ms)
        # optional deeper restarts for slowly converging cases (a sliding valley)
        for _ in range(args.deep):
            if best is None:
                break
            improved = False
            for d0 in (3e-2, 1e-2, 3e-3, 1e-3):
                res = isolated(compress, geo, best[1].copy(), delta0=d0, delta_min=1e-12, max_iter=1500)
                if res is None:
                    continue
                ps, ms = res
                if ms < -1e-13:
                    ps, ms = repair(geo, ps, -1e-13)
                m = metric_of(fam, ps.params)
                if m < best[0] * (1 - 1e-12):
                    best = (m, ps, ms)
                    improved = True
            if not improved:
                break
        if best is not None and best[0] < m0 * (1 - 1e-15):
            meta = {k: v for k, v in rec.items() if k not in ("family", "N", "P", "score", "params", "basis", "poses", "frac", "min_sep", "density")}
            meta["polished"] = "polish_raw.py"
            out = to_json(geo, best[1], best[2], meta)
            with open(fn + ".tmp", "w") as f:
                json.dump(out, f, indent=1)
            os.replace(fn + ".tmp", fn)
            print("%s: %.12f -> %.12f (rel %.2e)" % (os.path.basename(fn), rec["score"], out["score"], (rec["score"] - out["score"]) / rec["score"]), flush=True)


if __name__ == "__main__":
    main()
