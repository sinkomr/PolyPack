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
