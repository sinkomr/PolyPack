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
from build_records import display  # noqa: E402


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


class P1Bounds(unittest.TestCase):
    def test_tilings_and_known_values(self):
        lb, ub, _ = p1_bound.bound("sq", 4)
        self.assertAlmostEqual(float(lb), 1.0, places=12)
        lb, ub, _ = p1_bound.bound("hex", 6)
        self.assertAlmostEqual(float(lb), math.sqrt(3), places=12)
        lb, ub, _ = p1_bound.bound("hex", 3)
        self.assertAlmostEqual(float(lb), math.sqrt(3) / 2, places=12)

    def test_bound_below_float_optimum(self):
        for fam in ("sq", "hex"):
            for N in (5, 7):
                lb, ub, _ = p1_bound.bound(fam, N)
                self.assertLessEqual(float(lb), ub)
                self.assertLess((ub - float(lb)) / ub, 2e-9)

    def test_bound_is_valid_at_sample_angles(self):
        # the rigorous bound can never exceed L*(theta) at any angle
        lb, _, _ = p1_bound.bound("hex", 5)
        F = ((1.0, 0.5), (0.0, math.sqrt(3) / 2))
        for k in range(200):
            th = 2 * math.pi * k / 200
            self.assertGreaterEqual(p1_bound.float_Lstar(5, F, th), float(lb) - 1e-12)


class Literature(unittest.TestCase):
    def test_conversions(self):
        # square torus, 6 disks: Musin-Nikitenko d6
        v = LIT.literature("sq", 0, 6)[0]["value"]
        self.assertAlmostEqual(v, 4.994935776886, places=9)
        # 7 and 8 disks share d = 1/(1 + sqrt3)
        self.assertAlmostEqual(LIT.literature("sq", 0, 8)[0]["value"], 2 * (1 + math.sqrt(3)), places=12)
        # squares: Blair et al. P = 12, density 24/25
        self.assertAlmostEqual(LIT.literature("sq", 4, 12)[0]["value"], 5 / math.sqrt(2), places=12)

    def test_bounds(self):
        # hexagonal torus with P = 7 disks: 2 sqrt7 from the Thue density bound
        self.assertAlmostEqual(LIT.score_bound("hex", 0, 7)["value"], 2 * math.sqrt(7), places=12)
        # octagon lattice density bound for the free family
        b = LIT.score_bound("free", 8, 3)["value"]
        self.assertAlmostEqual(b, math.sqrt(3 * (5 + 4 * math.sqrt(2)) / 2), places=12)
        # one disk: L >= 2
        self.assertEqual(LIT.score_bound("sq", 0, 1)["value"], 2.0)

    def test_exact_forms(self):
        e = LIT.exact_form("free", 0, 7, math.sqrt(7 * 2 * math.sqrt(3)))
        self.assertIsNotNone(e)
        self.assertIsNone(LIT.exact_form("free", 0, 7, 1.0001 * math.sqrt(7 * 2 * math.sqrt(3))))
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
        self.assertAlmostEqual(proofs("sq", 0, 2)[0]["value"], 1 / r2, places=13)
        self.assertAlmostEqual(proofs("sq", 0, 3)[0]["value"], 1 / r34, places=13)
        self.assertAlmostEqual(proofs("sq", 0, 4)[0]["value"], 1 / r34, places=13)
        self.assertAlmostEqual(proofs("hex", 0, 2)[0]["value"], 2 * math.sqrt(3), places=13)
        for n in self.LOESCHIAN:
            if n <= 49:
                for e in proofs("hex", 0, n):
                    self.assertAlmostEqual(e["value"], 2 * math.sqrt(n), places=12)
        for P in self.SUMSQ:
            if P <= 49:
                self.assertAlmostEqual(proofs("sq", 4, P)[0]["value"], math.sqrt(P), places=13)
        # one disk: area pi at density pi/sqrt12; one triangle: area sqrt3/4 at density 2/3
        self.assertAlmostEqual(proofs("free", 0, 1)[0]["value"], math.sqrt(2 * math.sqrt(3)), places=13)
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
        self.assertEqual(LIT.literature("sq", 0, 1)[0]["value"], 2.0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
