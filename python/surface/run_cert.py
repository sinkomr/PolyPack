"""Certify a batch of configurations with the smallest shrink eps that the certifier accepts.

Usage: python3 run_cert.py IN.json OUT.json [--certdir DIR] [--mode fold|nofold] [--only-prefix P]
       [--ladder 1e-12,3e-12,...]

IN.json: {"records": [{id, solid, mode, N, P, s, pieces, ...}, ...]}.
OUT.json gets every input record plus: eps, score_cert, display, gap_rel, certificate (file name
and key) or cert_error when no eps on the ladder works. Certificates are collected per solid and
mode into DIR/<solid>_<mode>[.<tag>].json, an object keyed by record id.
`--mode fold` certifies the configurations in fold mode whatever their own mode (used to
check that nofold packings are fold packings).
"""

import argparse
import hashlib
import json
import os
import sys
import time
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cert import VERSION, CertError, certify  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def code_hash():
    """Certifier version plus a hash of the certifier's code: part of every cache key, so a changed
    certifier never reuses certificates (or failures) made by an older one."""
    h = hashlib.sha256(VERSION.encode())
    for name in ("cert.py", "numfield.py", "geom.py", "general.py"):
        with open(os.path.join(HERE, name), "rb") as fh:
            h.update(fh.read())
    return h.hexdigest()

LADDER = ["1e-12", "3e-12", "1e-11", "3e-11", "1e-10", "3e-10", "1e-9", "3e-9", "1e-8", "3e-8", "1e-7", "1e-6"]


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--certdir", default=None)
    ap.add_argument("--mode", default=None)
    ap.add_argument("--only-prefix", default=None)
    ap.add_argument("--ladder", default=None)
    ap.add_argument("--tag", default=None, help="suffix for the certificate bundle names")
    ap.add_argument("--cache", default=None, help="JSON-lines cache of certificates keyed by configuration hash")
    args = ap.parse_args(argv)
    ladder = args.ladder.split(",") if args.ladder else LADDER
    recs = json.load(open(args.inp))["records"]
    code = code_hash()
    cache = {}
    if args.cache and os.path.exists(args.cache):
        with open(args.cache) as fh:
            for line in fh:
                if line.strip():
                    e = json.loads(line)
                    cache[e["hash"]] = e
    out = []
    bundles = {}
    t0 = time.time()
    nfail = 0
    for rec in recs:
        if args.only_prefix and not rec["id"].startswith(args.only_prefix):
            continue
        r = dict(rec)
        if args.mode:
            r["mode"] = args.mode
        last = None
        t = time.time()
        h = hashlib.sha256(json.dumps([code, r["solid"], r["mode"], r["N"], r["P"], r["s"], r["pieces"], ladder],
                                      sort_keys=True).encode()).hexdigest()
        hit = cache.get(h)
        for eps in ([hit["eps"]] if hit and hit.get("eps") else [] if hit else ladder):
            if hit:
                cert = dict(hit["cert"])
                cert["id"] = r["id"]
            else:
                try:
                    cert = certify(r, eps)
                except CertError as e:
                    last = str(e)
                    continue
                if args.cache:
                    with open(args.cache, "a") as fh:
                        fh.write(json.dumps({"hash": h, "eps": eps, "cert": cert}) + "\n")
            r["eps"] = eps
            r["score_cert"] = cert["score_cert"]
            r["display"] = cert["display"]
            r["gap_rel"] = float((Fraction(cert["score_cert"]) - Fraction(r["s"])) / Fraction(r["s"]))
            if args.certdir:
                name = "%s_%s%s.json" % (r["solid"], r["mode"], ("." + args.tag) if args.tag else "")
                bundles.setdefault(name, {})[r["id"]] = cert
                r["certificate"] = "certificates/%s#%s" % (name, r["id"])
            r["cert_summary"] = cert.get("summary")
            last = None
            break
        if hit and not hit.get("eps"):
            last = hit["error"]
        if last is not None:
            r["cert_error"] = last
            if args.cache and not hit:
                with open(args.cache, "a") as fh:
                    fh.write(json.dumps({"hash": h, "eps": None, "error": last}) + "\n")
            nfail += 1
            print("FAIL", r["id"], last, flush=True)
        else:
            print("OK  ", r["id"], r["display"], "eps", r["eps"], "%.1fs" % (time.time() - t), flush=True)
        out.append(r)
    json.dump({"records": out}, open(args.out, "w"))
    for name, certs in bundles.items():
        path = os.path.join(args.certdir, name)
        old = {}
        if os.path.exists(path):
            with open(path) as fh:
                old = json.load(fh)
        old.update(certs)
        with open(path, "w") as fh:
            json.dump(old, fh, separators=(",", ":"), sort_keys=True)
    print("done: %d records, %d failed, %.0fs" % (len(out), nfail, time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
