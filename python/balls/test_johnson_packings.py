#!/usr/bin/env python3
"""Exact certification of test packings of the balls space with Johnson solids
(python/balls/fixtures/johnson_packings.json, written by packages/balls/scripts/gen-johnson-packings.ts).

Run: python3 python/balls/test_johnson_packings.py. Balls in J12, J44 (chiral) and J92 (fcc and hcp lattice cuts), and J1, J44
and J92 in a ball (a coarse grid in random orientations), each legalized with a clearance of about 1e-10, and for each two
adversarial variants (a piece moved until it overlaps a neighbour, or sticks out of the container, by 1e-9). The certifier must
prove every packing, refuse every variant, and give the bounds of the Johnson problems the TypeScript catalogue gives, which
rest on the Chebyshev and enclosing radii and not on the centroid's inradius and circumradius. Test packings, not good ones.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import balls_catalogue  # noqa: E402
import certify  # noqa: E402

CASES = json.load(open(os.path.join(HERE, 'fixtures', 'johnson_packings.json')))['cases']


class JohnsonBalls(unittest.TestCase):
    def test_every_packing_is_certified(self):
        self.assertEqual(len(CASES), 12)
        for c in CASES:
            r = certify.certify_config(c['code'], c['s'], c['pieces'])
            self.assertTrue(r['ok'], c['code'])
            self.assertLessEqual(r['min_wall_gap'], c['minWallGap'] + 1e-12, c['code'])
            self.assertGreater(r['min_wall_gap'], c['minWallGap'] - 1e-9, c['code'])
            self.assertGreaterEqual(c['s'], balls_catalogue.bound(c['code'], c['P']) * (1 - 1e-9), c['code'])

    def test_overlaps_and_protrusions_of_1e_9_are_refused(self):
        for c in CASES:
            o = c['overlap']
            r = certify.certify_config(c['code'], o['s'], o['pieces'])
            self.assertFalse(r['ok'], c['code'])
            self.assertIn(o['pair'], r['failed_pairs'], c['code'])
            r = certify.certify_config(c['code'], c['s'], c['protrusion']['pieces'])
            self.assertFalse(r['ok'], c['code'])
            self.assertIn(c['protrusion']['piece'], r['failed_walls'], c['code'])

    def test_a_quaternion_of_any_norm_is_its_rotation(self):
        for c in CASES:
            if c['code'].endswith('inball'):
                pieces = [p[:3] + [3 * q for q in p[3:]] for p in c['pieces']]
                self.assertTrue(certify.certify_config(c['code'], c['s'], pieces)['ok'], c['code'])

    def test_373_codes_and_the_first_7_unchanged(self):
        self.assertEqual(len(balls_catalogue.PROBLEMS), 373)
        self.assertEqual(balls_catalogue.CODES[:2], ['ballinball', 'ballintet'])
        self.assertEqual(balls_catalogue.CODES[1 + 186], 'tetinball')
        self.assertEqual(balls_catalogue.PROBLEMS['ballinj12']['container'], 'triangular_bipyramid')
        self.assertEqual(balls_catalogue.PROBLEMS['j92inball']['title'], 'J92 triangular hebesphenorotundas in a ball')

    def test_bounds_use_the_best_centre_for_the_johnson_solids(self):
        # a square pyramid (J1, edge 1): its largest inscribed ball has radius about 0.2588 and is centred above the
        # vertex centroid, whose inscribed ball has radius 0.1414; its smallest enclosing ball is the one
        # about the base's centre, radius sqrt 2 / 2 = 0.7071, and not the centroid's 0.7211
        g = balls_catalogue.geometry('square_pyramid')
        self.assertAlmostEqual(g['inradius'], 0.1414213562373095, 12)
        self.assertAlmostEqual(g['chebyshev'], 0.2588190451025, 6)
        self.assertAlmostEqual(g['circumradius'], 0.7211102550927979, 12)
        self.assertAlmostEqual(g['enclosing'], 2 ** 0.5 / 2, 6)
        # one ball in J1: s >= r / chebyshev; one J1 in a ball: a diameter of at least twice the enclosing radius
        self.assertGreaterEqual(balls_catalogue.bound('ballinj01', 2), 0.5 / g['chebyshev'] * (1 - 1e-12))
        self.assertLessEqual(balls_catalogue.bound('j01inball', 2), 1.5)
        self.assertGreaterEqual(balls_catalogue.bound('j01inball', 2), 2 * g['enclosing'] * (1 - 1e-12))
        # where the centroid is the centre, as for every one of the first 94 solids, the two radii are the old ones
        for name in ('cube', 'truncated_icosidodecahedron', 'prism5', 'trapezohedron7', 'pentakis_dodecahedron'):
            h = balls_catalogue.geometry(name)
            self.assertEqual(h['chebyshev'], h['inradius'], name)
            self.assertEqual(h['enclosing'], h['circumradius'], name)


if __name__ == '__main__':
    unittest.main()
