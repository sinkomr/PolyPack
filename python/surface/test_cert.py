"""Tests of the surface certifier: exact geometry, known packings, adversarial rejections and a
cross-check against the TypeScript validator's verdicts on random configurations.

Run: python3 python/surface/test_cert.py
"""

import copy
import json
import math
import os
import sys
import unittest
from fractions import Fraction as Fr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import time  # noqa: E402

from cert import CertError, certify, check_records, enumerate_chains, published_errors  # noqa: E402
from geom import SOLIDS, get_solid  # noqa: E402
from numfield import KD, Q3  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))


def load(*parts):
    with open(os.path.join(*parts)) as fh:
        return json.load(fh)


def rec(solid, mode, N, s, pieces, P=None):
    return {"id": "test", "solid": solid, "mode": mode, "N": N, "P": len(pieces) if P is None else P, "s": s,
            "pieces": [dict(face=f, x=x, y=y, theta=t) for f, x, y, t in pieces]}


def ok(r, eps="1e-9"):
    try:
        certify(r, eps)
        return True
    except CertError:
        return False


class NumberFields(unittest.TestCase):
    def test_sqrt3(self):
        r3 = Q3.gen()
        self.assertTrue((r3 * r3 - 3).is_zero())
        self.assertEqual((r3 - Fr(17, 10)).sign(), 1)  # sqrt3 > 1.7
        self.assertEqual((r3 - Fr(1733, 1000)).sign(), -1)
        x = (r3 + 2) / (r3 - 1)
        self.assertTrue((x * (r3 - 1) - (r3 + 2)).is_zero())

    def test_dodecahedral_field(self):
        w = KD.gen()
        w4 = w * w * w * w
        self.assertTrue(w4.F is KD)
        self.assertTrue((w4 - 20 * (w * w) + 80).is_zero())
        c36 = (w * w - 8) / 8
        s36 = (w * w - 10) / (2 * w)
        self.assertTrue((c36 * c36 + s36 * s36 - 1).is_zero())
        self.assertAlmostEqual(float(c36), math.cos(math.pi / 5), places=14)
        self.assertAlmostEqual(float(s36), math.sin(math.pi / 5), places=14)

    def test_sign_of_tiny_nonzero(self):
        r3 = Q3.gen()
        tiny = r3 - Fr(1732050807568877293527446341505872366943, 10 ** 39)
        self.assertNotEqual(tiny.sign(), 0)


class Solids(unittest.TestCase):
    def test_matches_committed_json(self):
        data = load(REPO, "data", "surface", "solids.json")["solids"]
        for name in SOLIDS:
            S = get_solid(name)
            self.assertEqual(S.faces, data[name]["faces"])
            self.assertEqual([[list(e) for e in row] for row in S.adj], data[name]["adj"])

    def test_counts_and_gluing(self):
        expect = {"tetrahedron": (4, 4, 6, 3), "cube": (6, 8, 12, 3), "octahedron": (8, 6, 12, 4),
                  "dodecahedron": (12, 20, 30, 3), "icosahedron": (20, 12, 30, 5)}
        for name in SOLIDS:
            S = get_solid(name)
            self.assertEqual((S.F, S.V, S.E, S.degree), expect[name])
            s = Fr(7, 5)
            for f in range(S.F):
                for k in range(S.M):
                    g, l, T = S.glue(s, f, k)
                    self.assertEqual(S.adj[g][l], (f, k))
                    a = S.apply(T, S.frame_vertex(s, l))
                    b = S.frame_vertex(s, k + 1)
                    self.assertTrue((a[0] - b[0]).is_zero() and (a[1] - b[1]).is_zero())
                    a = S.apply(T, S.frame_vertex(s, l + 1))
                    b = S.frame_vertex(s, k)
                    self.assertTrue((a[0] - b[0]).is_zero() and (a[1] - b[1]).is_zero())

    def test_holonomy_is_the_cone_angle(self):
        # going once around frame vertex 0 of face 0 rotates by the cone angle, exactly
        unit = {3: 60, 4: 90, 5: 36}
        cone = {"tetrahedron": 180, "cube": 270, "octahedron": 240, "dodecahedron": 324, "icosahedron": 300}
        for name in SOLIDS:
            S = get_solid(name)
            s = Fr(1)
            T = S.identity()
            f, k = 0, S.M - 1
            for _ in range(S.degree):
                g, l, G = S.glue(s, f, k)
                T = S.compose(T, G)
                f, k = g, (l - 1) % S.M
            self.assertEqual(f, 0)
            deg = (T.j * unit[S.M]) % 360
            self.assertIn(deg, (cone[name] % 360, (360 - cone[name]) % 360))
            v = S.frame_vertex(s, 0)
            w = S.apply(T, v)
            self.assertTrue((w[0] - v[0]).is_zero() and (w[1] - v[1]).is_zero())


class KnownPackings(unittest.TestCase):
    def test_simple_valid(self):
        self.assertTrue(ok(rec("cube", "fold", 0, 2.0, [(f, 0.0, 0.0, 0.0) for f in range(6)])))
        self.assertTrue(ok(rec("cube", "nofold", 0, 2.0, [(f, 0.0, 0.0, 0.0) for f in range(6)])))
        self.assertTrue(ok(rec("cube", "fold", 4, 1.0, [(f, 0.0, 0.0, math.pi / 4) for f in range(6)])))
        self.assertTrue(ok(rec("tetrahedron", "fold", 3, 1.0, [(f, 0.0, 0.0, 0.0) for f in range(4)])))
        # dodecahedron: pentagon pieces equal to the faces (theta = pi/5 - pi)
        self.assertTrue(ok(rec("dodecahedron", "fold", 5, 1.0, [(f, 0.0, 0.0, math.pi / 5 - math.pi) for f in range(12)])))

    def test_exact_tilings(self):
        data = load(HERE, "fixtures", "exact_small.json")["records"]
        for r in data:
            c = certify(r, "1e-11")
            self.assertLess(c["score_cert"] / r["s"] - 1, 2e-11, r["id"])

    def test_tight_witnesses_at_1e12(self):
        # regression: multipliers rounded to 8 digits lost ~1e-8 of clearance and failed here
        r = load(HERE, "fixtures", "tight_nofold.json")["records"][0]
        self.assertTrue(ok(r, "1e-12"))
        self.assertTrue(ok(dict(r, mode="fold"), "1e-12"))

    def test_single_disk_thresholds(self):
        # unit disk at a face centre: needs face circumradius >= 1, i.e. s >= 2 sin(pi/M)
        for name in SOLIDS:
            S = get_solid(name)
            s0 = 2 * math.sin(math.pi / S.M)
            self.assertTrue(ok(rec(name, "fold", 0, s0 * (1 + 1e-8), [(0, 0.0, 0.0, 0.0)]), "1e-10"), name)
            self.assertFalse(ok(rec(name, "fold", 0, s0 * (1 - 1e-8), [(0, 0.0, 0.0, 0.0)]), "1e-12"), name)

    def test_score_rounding(self):
        c = certify(rec("cube", "fold", 0, 2.0, [(f, 0.0, 0.0, 0.0) for f in range(6)]), "1e-9")
        self.assertGreaterEqual(Fr(c["score_cert"]), Fr(2) / (1 - Fr("1e-9")))
        self.assertEqual(c["display"], "2.000001")


class Adversarial(unittest.TestCase):
    def test_overlap_by_1e9_across_an_edge(self):
        base = [(f, 0.0, 0.0, math.pi / 4) for f in range(6)]
        shifted = list(base)
        shifted[0] = (0, 2e-9, 0.0, math.pi / 4)
        self.assertFalse(ok(rec("cube", "fold", 4, 1.0, shifted), "1e-10"))
        self.assertTrue(ok(rec("cube", "fold", 4, 1.0, shifted), "1e-8"))

    def test_outside_face_by_1e9(self):
        p = [(0, 1e-9, 0.0, 0.0)]
        self.assertFalse(ok(rec("cube", "nofold", 0, 2.0, p), "1e-12"))
        self.assertTrue(ok(rec("cube", "nofold", 0, 2.0, p), "1e-8"))

    def test_disks_overlap_by_1e9(self):
        # two disks on one face of a large cube, centre distance 2 - 1e-9
        p = [(0, -1.0 + 5e-10, 0.0, 0.0), (0, 1.0 - 5e-10, 0.0, 0.0)]
        self.assertFalse(ok(rec("cube", "fold", 0, 5.0, p), "1e-12"))
        self.assertFalse(ok(rec("cube", "nofold", 0, 5.0, p), "1e-12"))
        self.assertTrue(ok(rec("cube", "fold", 0, 5.0, p), "1e-8"))

    def test_cone_point_inside_by_1e9(self):
        # disk at distance 1 - 1e-9 from the corner (2.5, 2.5) of a cube face of side 5
        d = (1 - 1e-9) / math.sqrt(2)
        p = [(0, 2.5 - d, 2.5 - d, 0.0)]
        self.assertFalse(ok(rec("cube", "fold", 0, 5.0, p), "1e-12"))
        # a square whose corner pokes 1e-9 over the same vertex
        h = 0.5 - 1e-9
        self.assertFalse(ok(rec("cube", "fold", 4, 5.0, [(0, 2.5 - h, 2.5 - h, math.pi / 4)]), "1e-12"))
        self.assertTrue(ok(rec("cube", "fold", 4, 5.0, [(0, 2.5 - h, 2.5 - h, math.pi / 4)]), "1e-8"))

    def test_disks_overlapping_across_an_edge(self):
        # adjacent faces of the cube with s = 2: centres 2 apart through the edge; move one 1e-9 closer
        S = get_solid("cube")
        g, l = S.adj[0][0]
        a = math.pi * (l + 1) / 2 - math.pi / 2  # outward normal of edge l in face g
        good = [(0, 0.0, 0.0, 0.0), (g, 0.0, 0.0, 0.0)]
        self.assertTrue(ok(rec("cube", "fold", 0, 2.0, good), "1e-9"))
        bad = [(0, 2e-9, 0.0, 0.0), (g, 2e-9 * math.cos(a), 2e-9 * math.sin(a), 0.0)]
        self.assertFalse(ok(rec("cube", "fold", 0, 2.0, bad), "1e-12"))

    def test_malformed(self):
        good = rec("cube", "fold", 0, 2.0, [(0, 0.0, 0.0, 0.0)])
        cases = []
        for key, val in [("solid", "sphere"), ("mode", "both"), ("N", 2), ("N", 1.5), ("N", True), ("P", 2), ("P", 0),
                         ("s", 0.0), ("s", -1.0), ("s", float("nan")), ("s", float("inf")), ("s", "2")]:
            r = copy.deepcopy(good)
            r[key] = val
            cases.append(r)
        for key, val in [("x", float("nan")), ("y", float("inf")), ("theta", float("nan")), ("face", 6), ("face", -1),
                         ("face", 1.0), ("x", "0")]:
            r = copy.deepcopy(good)
            r["pieces"][0][key] = val
            cases.append(r)
        r = copy.deepcopy(good)
        r["pieces"] = "none"
        cases.append(r)
        for r in cases:
            with self.assertRaises((CertError, ValueError, KeyError, TypeError)):
                certify(r, "1e-9")
        for eps in ["0", "1", "-1e-9", "2"]:
            with self.assertRaises(CertError):
                certify(good, eps)

    def test_centre_outside_its_face(self):
        self.assertFalse(ok(rec("cube", "fold", 0, 3.0, [(0, 1.5 + 1e-12, 0.0, 0.0)])))

    def test_centre_at_a_vertex(self):
        self.assertFalse(ok(rec("cube", "fold", 0, 3.0, [(0, 1.5, 1.5, 0.0)])))

    def test_chain_enumeration_terminates_on_degenerate_rays(self):
        # face centre of the cube: rays through the corners pass through further vertices exactly
        S = get_solid("cube")
        F = S.field
        nodes = enumerate_chains(S, Fr(1), 0, (F(0), F(0)), F(9), None)
        self.assertLess(len(nodes), 2000)


class CrossCheck(unittest.TestCase):
    def test_agrees_with_typescript_validator(self):
        data = load(HERE, "fixtures", "crosscheck.json")["cases"]
        self.assertGreater(len(data), 200)
        for c in data:
            self.assertEqual(ok(c, "1e-9"), c["ts_valid"], c["id"])


class RecordsMode(unittest.TestCase):
    """cert.py RECORDS.json checks the published fields and reports malformed input as FAIL."""

    def run_file(self, recs):
        lines = []
        ok, bad = check_records(recs, log=lines.append)
        return ok, bad, lines

    def test_reviewer_tampered_records_fail(self):
        recs = load(HERE, "fixtures", "review", "tampered.json")["records"]
        ok, bad, lines = self.run_file(recs)
        self.assertEqual((ok, bad), (0, 5), lines)
        for name in ("tampered_noeps", "tampered_nondict", "tampered_badsolid"):
            recs = load(HERE, "fixtures", "review", name + ".json")["records"]
            ok, bad, lines = self.run_file(recs)
            # every file holds one untouched control record, which passes
            controls = sum(1 for r in recs if isinstance(r, dict) and r.get("solid") == "cube" and "eps" in r)
            self.assertEqual((ok, bad), (controls, len(recs) - controls), (name, lines))
            self.assertTrue(all(l.startswith(("OK", "FAIL")) for l in lines))

    def test_malformed_records_fail_without_crashing(self):
        good = load(HERE, "fixtures", "review", "tampered_nondict.json")["records"][0]
        bad = []
        for key, val in [("eps", "nan"), ("eps", "garbage"), ("eps", None), ("eps", float("inf")), ("solid", None),
                         ("solid", "sphere"), ("s", 1e300), ("score_cert", True), ("N", "0"), ("P", 10 ** 12)]:
            r = copy.deepcopy(good)
            r[key] = val
            bad.append(r)
        r = copy.deepcopy(good)
        del r["solid"]
        bad.append(r)
        r = copy.deepcopy(good)
        r["pieces"][0]["x"] = 1e300
        bad.append(r)
        r = copy.deepcopy(good)
        r["pieces"] = None
        bad.append(r)
        ok, nbad, lines = self.run_file(bad + [None, 3, "x", []])
        self.assertEqual(ok, 0, lines)
        self.assertEqual(nbad, len(bad) + 4)
        self.assertEqual(check_records({"records": 1}, log=lambda m: None), (0, 1))
        # certify itself raises CertError (not another exception) on these
        for rec, eps in [(good, "nan"), (dict(good, solid="sphere"), "1e-12"), (dict(good, solid=None), "1e-12"),
                         ([1, 2], "1e-12"), (good, None), (good, True)]:
            with self.assertRaises(CertError):
                certify(rec, eps)

    def test_tiny_solids_are_rejected_quickly(self):
        # a piece far too large for the solid is rejected by the anchor-face cone check, before the
        # chain enumeration (which would grow like (reach/s)^3)
        for solid, N, s in [("cube", 0, 0.05), ("icosahedron", 0, 0.01), ("dodecahedron", 3, 0.05), ("tetrahedron", 8, 0.01)]:
            t = time.time()
            self.assertFalse(ok(rec(solid, "fold", N, s, [(0, 0.0, 0.0, 0.0)]), "1e-12"))
            self.assertLess(time.time() - t, 2.0)


class CacheKey(unittest.TestCase):
    def test_cache_key_covers_the_certifier_code(self):
        import run_cert

        h = run_cert.code_hash()
        self.assertEqual(len(h), 64)
        self.assertEqual(h, run_cert.code_hash())
        old = run_cert.VERSION
        try:
            run_cert.VERSION = old + "x"
            self.assertNotEqual(h, run_cert.code_hash())
        finally:
            run_cert.VERSION = old


class ReviewFixtures(unittest.TestCase):
    def test_threshold_cases(self):
        data = load(HERE, "fixtures", "review", "threshold_fixtures.json")
        n = 0
        for kind, cases in data.items():
            for c in cases:
                self.assertTrue(ok(c["accept_at"], c["eps"]), (kind, c["s_star"]))
                self.assertFalse(ok(c["reject_at"], c["eps"]), (kind, c["s_star"]))
                n += 1
        self.assertEqual(n, 14)

    def test_reviewer_constructions(self):
        for r in load(HERE, "fixtures", "review", "constructions_records.json")["records"]:
            c = certify(r, r["eps"])
            self.assertEqual(c["score_cert"], r["score_cert"], r["id"])
            self.assertEqual(c["display"], r["display"], r["id"])


class RecordsFile(unittest.TestCase):
    """Consistency of data/surface/records.json (the certificates themselves are re-checked by cert.py)."""

    def setUp(self):
        path = os.path.join(REPO, "data", "surface", "records.json")
        if not os.path.exists(path):
            self.skipTest("no records file yet")
        self.doc = load(path)

    def test_fields_and_ordering(self):
        recs = {(r["solid"], r["mode"], r["N"], r["P"]): r for r in self.doc["records"]}
        need = ["id", "solid", "mode", "N", "P", "score_float", "score_cert", "display", "status", "pieces",
                "certificate", "bound", "method", "software", "found_by", "notes", "eps"]
        for key, r in recs.items():
            for f in need:
                self.assertIn(f, r, r["id"])
            self.assertEqual(r["status"], "best_known")
            self.assertEqual(len(r["pieces"]), r["P"])
            self.assertGreaterEqual(Fr(r["score_cert"]), Fr(r["score_float"]) / (1 - Fr(r["eps"])))
            q = Fr(r["score_cert"]) * 10 ** 6
            n = q.numerator // q.denominator + (1 if q.numerator % q.denominator else 0)
            self.assertEqual(r["display"], "%d.%06d" % (n // 10 ** 6, n % 10 ** 6), r["id"])
            self.assertGreaterEqual(r["score_cert"], r["bound"]["value"] * (1 - 1e-12), r["id"])
            if key[1] == "fold" and (key[0], "nofold", key[2], key[3]) in recs:
                self.assertLessEqual(r["score_cert"], recs[(key[0], "nofold", key[2], key[3])]["score_cert"], r["id"])
            nxt = recs.get((key[0], key[1], key[2], key[3] + 1))
            if nxt:
                self.assertLessEqual(r["score_cert"], nxt["score_cert"] * (1 + 1e-15), r["id"])

    def test_every_record_has_consistent_published_fields(self):
        # all records, without certifying: id, s == score_float, score_cert and display at the stored eps
        for r in self.doc["records"]:
            self.assertEqual(published_errors(r), [], r.get("id"))

    def test_sample_recertifies(self):
        # full re-certification of every record is `cert.py data/surface/records.json` (minutes)
        recs = self.doc["records"]
        lines = []
        ok_, bad = check_records(recs[:: max(1, len(recs) // 25)], log=lines.append)
        self.assertEqual(bad, 0, [l for l in lines if l.startswith("FAIL")])


if __name__ == "__main__":
    unittest.main(verbosity=1)
