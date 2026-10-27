"""Tests for the torus helper scripts (bounds, display rounding, literature conversions).

Run: python3 python/torus/test_torus_tools.py
"""

import math
import os
import sys
import unittest
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import literature_torus as LIT  # noqa: E402
import p1_bound  # noqa: E402
import certify_torus as C  # noqa: E402
from build_records import candidate, display  # noqa: E402


class Display(unittest.TestCase):
    def test_rounds_to_nearest_six_decimals(self):
        self.assertEqual(display(1.0), "1.000000")
        self.assertEqual(display(2.000000000002), "2.000000")
        self.assertEqual(display(1.0000000000001), "1.000000")
        self.assertEqual(display(2.4166164921352), "2.416616")
        self.assertEqual(display(2.4166165), "2.416616")  # its binary value is just below the tie
        self.assertEqual(display(2.41661650000001), "2.416617")
        self.assertEqual(display(3.8637033051562737), "3.863703")

    def test_exact_binary_ties_go_to_even(self):
        # 1/128 = 0.0078125 is an exact binary64 tie at 6 decimals
        self.assertEqual(display(0.0078125), "0.007812")
        self.assertEqual(display(1.0078125), "1.007812")
        self.assertEqual(display(1.0234375), "1.023438")

    def test_always_six_decimals(self):
        x = 7.190416372301467
        d = display(x)
        self.assertEqual(len(d.split(".")[1]), 6)
        self.assertLessEqual(abs(Decimal(d) - Decimal(x)), Decimal("0.0000005"))


_BOUNDS = {}


def bound(family, N):
    """p1_bound.bound, computed once per (family, N) within this process (the tests share the cases)."""
    if (family, N) not in _BOUNDS:
        _BOUNDS[(family, N)] = p1_bound.bound(family, N)
    return _BOUNDS[(family, N)]


class P1Bounds(unittest.TestCase):
    def test_tilings_and_known_values(self):
        lb, ub, _ = bound("sq", 4)
        self.assertAlmostEqual(float(lb), 1.0, places=12)
        lb, ub, _ = bound("hex", 6)
        self.assertAlmostEqual(float(lb), math.sqrt(3), places=12)
        lb, ub, _ = bound("hex", 3)
        self.assertAlmostEqual(float(lb), math.sqrt(3) / 2, places=12)

    def test_bound_below_float_optimum(self):
        for fam in ("sq", "hex"):
            for N in (5, 7):
                lb, ub, _ = bound(fam, N)
                self.assertLessEqual(float(lb), ub)
                self.assertLess((ub - float(lb)) / ub, 2e-9)

    def test_bound_is_valid_at_sample_angles(self):
        # the rigorous bound can never exceed L*(theta) at any angle
        lb, _, _ = bound("hex", 5)
        F = ((1.0, 0.5), (0.0, math.sqrt(3) / 2))
        for k in range(200):
            th = 2 * math.pi * k / 200
            self.assertGreaterEqual(p1_bound.float_Lstar(5, F, th), float(lb) - 1e-12)


class Literature(unittest.TestCase):
    def test_conversions(self):
        # square torus, 6 disks: Musin-Nikitenko d6
        v = LIT.literature("sq", 0, 6)[0]["value"]
        self.assertAlmostEqual(v, 4.994935776886 / 2, places=9)
        # 7 and 8 disks share d = 1/(1 + sqrt3)
        self.assertAlmostEqual(LIT.literature("sq", 0, 8)[0]["value"], 1 + math.sqrt(3), places=12)
        # squares: Blair et al. P = 12, density 24/25
        self.assertAlmostEqual(LIT.literature("sq", 4, 12)[0]["value"], 5 / math.sqrt(2), places=12)

    def test_bounds(self):
        # hexagonal torus with P = 7 disks of diameter 1: sqrt7 from the Thue density bound
        self.assertAlmostEqual(LIT.score_bound("hex", 0, 7)["value"], math.sqrt(7), places=12)
        # octagon lattice density bound for the free family
        b = LIT.score_bound("free", 8, 3)["value"]
        self.assertAlmostEqual(b, math.sqrt(3 * (5 + 4 * math.sqrt(2)) / 2), places=12)
        # one disk: L >= 1 (its diameter)
        self.assertEqual(LIT.score_bound("sq", 0, 1)["value"], 1.0)

    def test_exact_forms(self):
        e = LIT.exact_form("free", 0, 7, math.sqrt(7 * math.sqrt(3) / 2))
        self.assertIsNotNone(e)
        self.assertIsNone(LIT.exact_form("free", 0, 7, 1.0001 * math.sqrt(7 * math.sqrt(3) / 2)))
        # one triangle on a free torus: Fary's lattice optimum, density 2/3
        e = LIT.exact_form("free", 3, 1, math.sqrt(3 * math.sqrt(3) / 8))
        self.assertEqual(e["expr"], "sqrt(3 sqrt(3) / 8)")
        self.assertIsNone(LIT.exact_form("free", 3, 2, math.sqrt(3 * math.sqrt(3) / 8)))

    def test_lattice_bound_for_one_triangle(self):
        b = LIT.score_bound("free", 3, 1)
        self.assertEqual(b["kind"], "proven")
        self.assertAlmostEqual(b["value"], math.sqrt(3 * math.sqrt(3) / 8), places=14)
        self.assertIn("Sriamorn 2016", b["label"])


def proofs(fam, N, P):
    return [e for e in LIT.literature(fam, N, P) if e.get("proof")]


class ProofEntries(unittest.TestCase):
    """Which cases carry a `proof` (a checked, published proof of the exact torus case)."""

    LOESCHIAN = sorted({a * a + a * b + b * b for a in range(8) for b in range(8)} - {0})
    SUMSQ = sorted({a * a + b * b for a in range(8) for b in range(8)} - {0})

    def proven_cases(self):
        out = [("sq", 0, P) for P in (2, 3, 4, 6, 7, 8)]
        out += [("hex", 0, 2)] + [("hex", 0, n) for n in self.LOESCHIAN if n <= 49]
        out += [("sq", 4, P) for P in self.SUMSQ if P <= 49]
        # one piece on a free torus is a lattice packing: the densest lattice packings of disks and triangles
        out += [("free", 0, 1), ("free", 3, 1)]
        return out

    def test_every_proof_entry_is_complete(self):
        for (fam, N, P), entries in LIT.LIT.items():
            for e in entries:
                if not e.get("proof"):
                    continue
                self.assertEqual(e["status"], "proven", (fam, N, P))
                self.assertRegex(e["doi"], r"^10\.\d{4,9}/\S+$")
                self.assertGreater(e["value"], 0)
                self.assertTrue(e["source"].strip())
                self.assertNotIn("not read", e["source"] + e["short"])

    def test_the_proven_cases(self):
        cases = sorted(k for k in LIT.LIT if proofs(*k))
        self.assertEqual(cases, sorted(self.proven_cases()))
        self.assertEqual(len(cases), 52)

    def test_values_of_the_proofs(self):
        r2, r34 = math.sqrt(2) / 4, (math.sqrt(6) - math.sqrt(2)) / 4
        self.assertAlmostEqual(proofs("sq", 0, 2)[0]["value"], 1 / (2 * r2), places=13)
        self.assertAlmostEqual(proofs("sq", 0, 3)[0]["value"], 1 / (2 * r34), places=13)
        self.assertAlmostEqual(proofs("sq", 0, 4)[0]["value"], 1 / (2 * r34), places=13)
        self.assertAlmostEqual(proofs("hex", 0, 2)[0]["value"], math.sqrt(3), places=13)
        for n in self.LOESCHIAN:
            if n <= 49:
                for e in proofs("hex", 0, n):
                    self.assertAlmostEqual(e["value"], math.sqrt(n), places=12)
        for P in self.SUMSQ:
            if P <= 49:
                self.assertAlmostEqual(proofs("sq", 4, P)[0]["value"], math.sqrt(P), places=13)
        # one disk (diameter 1): area pi/4 at density pi/sqrt12; one triangle: area sqrt3/4 at density 2/3
        self.assertAlmostEqual(proofs("free", 0, 1)[0]["value"], math.sqrt(math.sqrt(3) / 2), places=13)
        self.assertAlmostEqual(proofs("free", 3, 1)[0]["value"], math.sqrt(3 * math.sqrt(3) / 8), places=13)
        self.assertEqual(proofs("free", 0, 1)[0]["doi"], "10.4171/EM/163")
        self.assertEqual(proofs("free", 3, 1)[0]["doi"], "10.1007/s00454-015-9748-0")

    def test_cases_left_best_known(self):
        # papers not read (Dickinson et al. 2011a/b), plane theorems (Fejes Toth, Thue), a preprint
        # (Hales-Kusner) and a conjecture give no proof
        for k in (("sq", 0, 1), ("sq", 0, 5), ("hex", 0, 5), ("hex", 0, 6),
                  ("free", 8, 1), ("free", 5, 2), ("sq", 0, 9), ("hex", 0, 8), ("sq", 4, 3)):
            self.assertEqual(proofs(*k), [], k)
        # Fary proves a lattice packing of density 2/3 exists, not that a triangle has none denser;
        # Lagrange (not read) and Thue (the plane) are cited beside the proofs
        fary = [e for e in LIT.literature("free", 3, 1) if e["short"].startswith("Fary 1950")][0]
        self.assertEqual(fary["doi"], "10.24033/bsmf.1413")
        self.assertNotIn("proof", fary)
        self.assertEqual([e["short"] for e in LIT.literature("free", 0, 1) if not e.get("proof")],
                         ["Lagrange 1773 (not read)", "Thue 1910"])
        self.assertEqual(LIT.literature("free", 5, 2)[0]["status"], "proven_unrefereed")

    def test_citations(self):
        cd = LIT.literature("hex", 0, 7)[0]
        self.assertEqual(cd["short"], "Connelly and Dickinson 2014, Thm 1.1")
        self.assertTrue(cd["proof"].startswith("Theorem 1.1"))
        self.assertEqual(LIT.literature("hex", 0, 8)[0]["short"], "Connelly and Dickinson 2014, Conjecture 1.3")
        self.assertTrue(LIT.literature("sq", 4, 5)[0]["source"].startswith("D. W. Blair, C. Santangelo, J. Machta"))
        self.assertEqual(LIT.literature("sq", 0, 1)[0]["value"], 1.0)


class SiteUnits(unittest.TestCase):
    """Disk records in site units (diameter 1): converted copies of radius-1 records by exact halving."""

    PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "torus", "records.json")

    def halved(self, r):
        import json  # noqa: F401

        lat = r["configuration"]["lattice"]
        lattice = {"L": lat["L"] / 2} if "L" in lat else {"b1": [v / 2 for v in lat["b1"]], "b2": [v / 2 for v in lat["b2"]]}
        poses = [[x / 2, y / 2, t] for x, y, t in r["configuration"]["poses"]]
        return {"family": r["family"], "N": 0, "P": r["P"], "lattice": lattice, "poses": poses, "eps": r["eps"]}

    def test_converted_records_certify_and_a_shrunk_copy_does_not(self):
        import json

        if not os.path.exists(self.PATH):
            self.skipTest("no records file")
        with open(self.PATH) as f:
            data = json.load(f)
        if data.get("units") == "diameter":
            self.skipTest("the data is already converted; test_certify_torus covers site units")
        want = {"torus/sq/0/2", "torus/hex/0/7", "torus/free/0/1", "torus/sq/0/5", "torus/hex/0/4"}
        done = 0
        for r in data["records"]:
            if r["problem"] not in want:
                continue
            rec = self.halved(r)
            cert = C.certify(rec)
            # the certified upper bound is exactly half the radius-1 one (rounding aside)
            self.assertAlmostEqual(float(cert["score_upper_float"]) * 2, r["score_cert"], places=12)
            # shrinking the lattice and the centres by 1e-9 overlaps disks that touch
            if r["problem"] in ("torus/sq/0/2", "torus/hex/0/4", "torus/free/0/1"):
                k = 1 - 1e-9
                small = dict(rec, poses=[[x * k, y * k, t] for x, y, t in rec["poses"]])
                small["lattice"] = (
                    {"L": rec["lattice"]["L"] * k}
                    if "L" in rec["lattice"]
                    else {"b1": [v * k for v in rec["lattice"]["b1"]], "b2": [v * k for v in rec["lattice"]["b2"]]}
                )
                with self.assertRaises(C.CertError, msg=r["problem"]):
                    C.certify(small)
            done += 1
        self.assertEqual(done, len(want))

    def test_raw_search_results_are_converted_at_the_build_edge(self):
        raw = {"family": "sq", "params": [4.0], "poses": [[0.5, 1.0, 0.7], [2.5, 1.0, 0.1]], "units": "working"}
        c = candidate("sq", 0, 2, raw, "x")
        self.assertEqual(c["lattice"], {"L": 2.0})
        self.assertEqual(c["poses"], [[0.25, 0.5, 0.0], [1.25, 0.5, 0.0]])
        self.assertEqual(c["score_float"], 2.0)
        # polygons and results already in diameter units are not scaled
        self.assertEqual(candidate("sq", 4, 2, dict(raw), "x")["lattice"], {"L": 4.0})
        self.assertEqual(candidate("sq", 0, 2, dict(raw, units="diameter"), "x")["lattice"], {"L": 4.0})
        C.certify({**{k: c[k] for k in ("family", "N", "P", "lattice", "poses")}, "eps": 1e-12})


if __name__ == "__main__":
    unittest.main(verbosity=1)
