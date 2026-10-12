"""Numerical regressions for exact inputs, SAT derivatives and broad-phase safety."""

import unittest

from polish_mp import D, FeasibilityContacts, mp, residuals, solve


class PrecisionRegression(unittest.TestCase):
    def test_json_float_preserves_binary_value(self):
        value = 0.1
        self.assertEqual(D(value), mp.mpf(value))
        self.assertNotEqual(D(value), mp.mpf(str(value)))

    def test_analytic_selected_face_derivatives(self):
        config = {"N": 6, "M": 5, "P": 2, "pieces": [{}, {}]}
        variables = list(map(D, [0.2, -0.4, 0.17, 1.7, 0.6, -0.23, 0.5, 0.4, 0.13, 4]))
        contacts = [
            {"kind": "pair", "i": 0, "j": 1},
            {"kind": "wall", "i": 1, "vertex": 2, "edge": 3},
        ]
        _, rows = residuals(config, variables, contacts, True)
        h = D("1e-20")
        for j in range(len(variables)):
            plus, minus = variables[:], variables[:]
            plus[j] += h
            minus[j] -= h
            gp = residuals(config, plus, contacts)
            gm = residuals(config, minus, contacts)
            for k, row in enumerate(rows):
                self.assertLess(abs(row[j] - (gp[k] - gm[k]) / (2 * h)), D("1e-28"))

    def test_pair_cache_rebuilds_before_new_overlap(self):
        config = {"N": 0, "M": 0, "P": 2, "pieces": [{}, {}]}
        variables = list(map(D, [0, 0, 0, 3, 0, 0, 0, 0, 0, 4]))
        cache = FeasibilityContacts(config)
        self.assertFalse(any(c["kind"] == "pair" for c in cache.get(variables)))
        variables[3] = D("1.9")
        self.assertTrue(any(c["kind"] == "pair" for c in cache.get(variables)))
        gaps = residuals(config, variables, cache.get(variables))
        self.assertLess(min(gaps), D(0))

    def test_two_circle_newton_refinement_reports_reached_residual(self):
        config = {
            "N": 0,
            "M": 0,
            "P": 2,
            "container_phi": 0,
            "pieces": [
                {"x": -1.0, "y": 0.0, "theta": 0.0},
                {"x": 1.0, "y": 0.0, "theta": 0.0},
            ],
        }
        data = {
            "config": config,
            "contacts": [{"kind": "pair", "i": 0, "j": 1}],
            "container": {"cx": 0, "cy": 0, "phi": 0, "size": 2},
        }
        result = solve(data, 1)
        self.assertTrue(result["valid"])
        self.assertGreaterEqual(result["achieved_contact_residual_digits"], 40)
        self.assertLess(D(result["maximum_active_contact_residual"]), D("1e-40"))
        self.assertNotIn("precision_digits", result)


if __name__ == "__main__":
    unittest.main()
