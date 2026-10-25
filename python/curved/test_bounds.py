"""Tests for the rigorous P_max bounds and for the shipped records.

Run: python3 python/curved/test_bounds.py
"""
import json
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bounds as bd  # noqa: E402
import certify  # noqa: E402
from mpmath import iv, mp, mpf  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RECORDS = os.path.join(HERE, "..", "..", "data", "curved", "records.json")


class PieceConstants(unittest.TestCase):
    def test_hyperbolic_unit_pieces(self):
        mp.prec = 200
        for N in (3, 4, 5, 6, 8):
            d = bd.piece_data(-1, N)
            R = mp.asinh(mp.sinh(mpf(1) / 2) / mp.sin(mp.pi / N))
            rho = mp.asinh(mp.tanh(mpf(1) / 2) / mp.tan(mp.pi / N))
            alpha = 2 * mp.asin(mp.cos(mp.pi / N) / mp.cosh(mpf(1) / 2))
            A = (N - 2) * mp.pi - N * alpha
            self.assertTrue(d["R"].a <= R <= d["R"].b)
            self.assertTrue(d["rho"].a <= rho <= d["rho"].b)
            self.assertTrue(d["area"].a <= A <= d["area"].b)
        mp.prec = 53

    def test_spherical_unit_pieces(self):
        mp.prec = 200
        for N in (3, 4, 5, 6):
            d = bd.piece_data(1, N)
            alpha = 2 * mp.asin(mp.cos(mp.pi / N) / mp.cos(mpf(1) / 2))
            A = N * alpha - (N - 2) * mp.pi
            self.assertTrue(d["area"].a <= A <= d["area"].b)
        mp.prec = 53


class Arguments(unittest.TestCase):
    def test_disks_in_polygons(self):
        # no unit disk in a hyperbolic triangle or square; exactly one fits for M = 5, 6, 8
        self.assertEqual(bd.bounds_for(-1, 0, 3)["P_max_upper"], 0)
        self.assertEqual(bd.bounds_for(-1, 0, 4)["P_max_upper"], 0)
        for M in (5, 6, 8):
            self.assertEqual(bd.bounds_for(-1, 0, M)["P_max_upper"], 1)
        # cot(pi/M) < e sinh 1 exactly for M <= 10
        self.assertLess(1 / math.tan(math.pi / 10), math.e * math.sinh(1))
        self.assertGreater(1 / math.tan(math.pi / 11), math.e * math.sinh(1))

    def test_sphere(self):
        for N in (0, 5, 6):
            for M in (0, 3, 4, 6):
                self.assertEqual(bd.bounds_for(1, N, M)["P_max_upper"], 1)

    def test_ystar_disk_and_triangle(self):
        old = iv.prec
        iv.prec = 96
        y, _ = bd.ystar_upper(3, tol=1e-3)
        iv.prec = old
        self.assertGreater(float(y), 2.49)  # float estimate 2.4913
        self.assertLess(float(y), 2.50)

    def test_square_fits_no_triangle(self):
        proved, boxes = bd.centre_bb(4, 3, 0.0, max_boxes=20000)
        self.assertTrue(proved)

    def test_bb_does_not_prove_false_targets(self):
        # false targets from the review: a hexagon centre can reach a = 0.6549 > 0.65, and a unit
        # pentagon centred just beyond rho fits in the ideal pentagon
        proved, _ = bd.centre_bb(6, 6, 0.65, max_boxes=3000)
        self.assertFalse(proved)
        rho5 = float(bd.piece_data(-1, 5)["rho"].a)
        proved, _ = bd.centre_bb(5, 5, rho5, max_boxes=3000)
        self.assertFalse(proved)

    def test_bb_does_not_prove_false_claims(self):
        # a unit triangle does fit in the ideal triangle: the branch-and-bound must not "prove" otherwise
        proved, _ = bd.centre_bb(3, 3, 0.0, max_boxes=3000)
        self.assertFalse(proved)


class ReviewRegressions(unittest.TestCase):
    def test_floor_strict_uses_upper_end(self):
        # an upper bound on max{P : P < x} for x anywhere in the interval needs the upper end
        self.assertEqual(bd.floor_strict(iv.mpf([4.5, 5.5])), 5)
        self.assertEqual(bd.floor_strict(iv.mpf([4.5, 5])), 4)
        self.assertEqual(bd.floor_strict(iv.mpf(5)), 4)
        self.assertEqual(bd.floor_strict(iv.mpf([0.2, 0.3])), 0)
        self.assertEqual(bd.floor_strict(iv.mpf([2.0, 2.0000001])), 2)

    def test_ideal_lower_bounds_exact_and_displayed_down(self):
        path = os.path.join(HERE, "..", "..", "data", "curved", "ideal.json")
        if not os.path.exists(path):
            self.skipTest("no ideal.json yet")
        import report_tables
        from fractions import Fraction

        data = json.load(open(path))
        ok, fails, msgs = certify.check_ideal(data)
        self.assertEqual(fails, 0, msgs[:5])
        self.assertGreater(ok, 0)
        for e in data["entries"]:
            lb = e.get("certified_lower_bound")
            if lb is None:
                continue
            self.assertLessEqual(Fraction(report_tables.down6(lb)), Fraction(lb))


class ShippedRecords(unittest.TestCase):
    def test_all_packings_certify(self):
        if not os.path.exists(RECORDS):
            self.skipTest("no records.json yet")
        data = json.load(open(RECORDS))
        recs = [r for r in data["records"] if r.get("config")]
        self.assertGreater(len(recs), 0)
        for r in recs:
            # the published record as is: id, K_exact, score_cert, display and the config itself
            res = certify.certify_record(r)
            self.assertTrue(res["certified"], (r["id"], res.get("reason")))
            self.assertGreaterEqual(r["score_cert"], r["score_float"])
            # display = score_cert rounded to the nearest at 6 decimals (an exact 1 shows as 1.000000)
            self.assertEqual(r["display"], certify.display_nearest(r["score_cert"]))


if __name__ == "__main__":
    unittest.main(verbosity=1)
