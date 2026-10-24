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
from build_records import display_up  # noqa: E402


class Display(unittest.TestCase):
    def test_rounds_up(self):
        self.assertEqual(display_up(1.0), "1.000000")
        self.assertEqual(display_up(1.0000000000001), "1.000001")
        self.assertEqual(display_up(2.4166164921352), "2.416617")
        x = 3.8637033051562737
        self.assertGreaterEqual(Decimal(display_up(x)), Decimal(x))


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


if __name__ == "__main__":
    unittest.main(verbosity=1)
