"""Machine check of docs/proofs/circle-container-floor.md.

Run from the repository root: python3 python/test_circle_floor.py
"""

import unittest
from decimal import Decimal
from fractions import Fraction

from proofs import circle_floor as cf


class CircleFloor(unittest.TestCase):
    def test_every_check_of_the_proof_page(self):
        rep, cfgs = cf.run()
        print("\n".join(rep.lines))
        self.assertEqual(rep.failures, [])
        self.assertEqual(sum(len(c.classes) for c in cfgs), 148)

    def test_records_remark_compares_the_right_quantities(self):
        # Site units: circle records are container diameters of diameter-1 disks, polygon records
        # are container diameters. "below F: 0" must not be vacuous.
        import copy
        import json

        recs = json.loads((cf.ROOT / "data/records.json").read_text(encoding="utf-8"))["records"]
        checked, below, equal, classes = cf.records_remarks(recs)
        self.assertEqual((checked, below), (60, []))
        self.assertEqual(sorted(equal), sorted([(4, 2), (6, 2), (8, 2), (8, 4), (3, 6), (6, 6), (6, 7)]))
        self.assertEqual(classes[37], [18, 36, 54, 72, 90])
        # a deliberately wrong value (the radius, half the diameter) must be reported
        bad = copy.deepcopy(recs)
        for r in bad:
            if (r["N"], r["P"], r["M"]) == (6, 2, 0):
                r["value"] /= 2
        self.assertIn((6, 2), cf.records_remarks(bad)[1])
        # so must a polygon value just below the bound, by more than the printed precision
        bad = copy.deepcopy(recs)
        for r in bad:
            if (r["N"], r["P"], r["M"]) == (8, 4, 0):
                r["value"] -= 1e-3
        self.assertIn((8, 4), cf.records_remarks(bad)[1])
        # a wrong circle record (the unit-circle radius ratio replaced by its half) is caught too:
        # it moves the bound, so records that equalled it no longer do
        bad = copy.deepcopy(recs)
        for r in bad:
            if (r["N"], r["P"], r["M"]) == (0, 2, 0):
                r["value"] = 1.0
        self.assertNotIn((4, 2), cf.records_remarks(bad)[2])

    def test_field_arithmetic(self):
        F = cf.Field(36)
        self.assertEqual(cf.cyclotomic(36), (1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1))
        s20 = F.sin(20)
        self.assertEqual(s20 * (1 / s20), F.const(1))
        self.assertEqual(F.e(90) * F.e(90), F.const(-1))
        self.assertEqual(F.cos(60), F.const(Fraction(1, 2)))
        x, y = F.e(10).decimal()
        self.assertLess(abs(x * x + y * y - 1), Decimal("1e-80"))
        # a wrong contact must fail: (X1, W4) at 150 degrees instead of 160
        c11 = cf.config_11()
        self.assertNotEqual(c11.points["W4"] - c11.points["X1"], 2 * c11.f.e(150))

    def test_decimal_functions_against_mpmath(self):
        try:
            import mpmath
        except ImportError:
            self.skipTest("mpmath not installed; the decimal functions are checked against identities only")
        mpmath.mp.dps = 85
        for k in range(-7, 30):
            x = Decimal(k) / 3
            self.assertLess(abs(cf.dcos(x) - Decimal(mpmath.nstr(mpmath.cos(mpmath.mpf(k) / 3), 85))), Decimal("1e-80"))
            self.assertLess(abs(cf.dsin(x) - Decimal(mpmath.nstr(mpmath.sin(mpmath.mpf(k) / 3), 85))), Decimal("1e-80"))
        self.assertLess(abs(cf.dpi() - Decimal(mpmath.nstr(mpmath.pi, 85))), Decimal("1e-80"))

    def test_decimal_functions_identities(self):
        for k in range(1, 40):
            x = Decimal(k) / 7
            self.assertLess(abs(cf.dcos(x) ** 2 + cf.dsin(x) ** 2 - 1), Decimal("1e-80"))
            self.assertLess(abs(cf.dsin(2 * x) - 2 * cf.dsin(x) * cf.dcos(x)), Decimal("1e-80"))
        self.assertLess(abs(cf.dsin(cf.dpi() / 6) - Decimal("0.5")), Decimal("1e-80"))


if __name__ == "__main__":
    unittest.main()
