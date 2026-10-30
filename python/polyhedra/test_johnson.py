#!/usr/bin/env python3
"""Tests of the 92 Johnson solids in solids_exact.json (standard library only).

The exact proof of johnson_prove.py is run again on every stored solid: unit edges, planar regular faces, strict
convexity, closed surface, V, E, F and the faces by kind equal to the standard table. The certifier is shown to read the
data with two pieces of a Johnson solid in a cube (fixtures/johnson_start.json, made with latticeStart of
packages/polyhedra, which fits boxes in a box lattice)."""
import json
import os
import sys
import unittest
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue  # noqa: E402
import johnson_prove  # noqa: E402
from johnson_table import CHIRAL, JOHNSON, code, sname, title  # noqa: E402

EXACT = json.load(open(os.path.join(HERE, 'solids_exact.json')))


class JohnsonTable(unittest.TestCase):
    def test_the_table(self):
        self.assertEqual(sorted(JOHNSON), list(range(1, 93)))
        self.assertEqual(len({sname(j) for j in JOHNSON}), 92)
        # the standard table is consistent: Euler, and every edge on two faces
        for j, (name, V, E, F) in JOHNSON.items():
            self.assertEqual(V - E + sum(F.values()), 2, name)
            self.assertEqual(2 * E, sum(k * c for k, c in F.items()), name)
        self.assertEqual(CHIRAL, (44, 45, 46, 47, 48))
        # spot checks against well-known solids
        self.assertEqual(JOHNSON[34][1:3], (30, 60))      # the pentagonal orthobirotunda: V 30, E 60
        self.assertEqual(JOHNSON[84][3], {3: 12})
        self.assertEqual(JOHNSON[92][3], {3: 13, 4: 3, 5: 3, 6: 1})

    def test_catalogue(self):
        js = catalogue.johnson_solids()
        self.assertEqual(len(js), 92)
        self.assertEqual(len(catalogue.solids()), 94)
        self.assertEqual(len(catalogue.all_solids()), 186)
        self.assertEqual([c for _, c, *_ in js], [f'j{j:02d}' for j in range(1, 93)])
        self.assertTrue(all('in' not in c for _, c, *_ in js))
        self.assertTrue(all(f == 'johnson' for _, _, f, _ in js))
        self.assertEqual(js[11], ('triangular_bipyramid', 'j12', 'johnson', 'J12 triangular bipyramid'))
        names = [n for n, *_ in catalogue.all_solids()]
        self.assertEqual(len(set(names)), 186)
        self.assertEqual(len({c for _, c, *_ in catalogue.all_solids()}), 186)
        self.assertEqual(sorted(EXACT), sorted(names))


class JohnsonExact(unittest.TestCase):
    def test_every_solid_is_proved_again(self):
        degrees = {}
        for j in range(1, 93):
            entry = EXACT[sname(j)]
            self.assertEqual(entry['D'], None, sname(j))
            checks = johnson_prove.prove(j, entry)
            self.assertEqual(checks, entry['checks'], sname(j))
            degrees[j] = len(entry['minpoly']) - 1
        self.assertLessEqual(max(degrees.values()), 64)

    def test_a_wrong_solid_is_refused(self):
        # one coordinate of the square pyramid moved: the proof must fail
        entry = json.loads(json.dumps(EXACT['square_pyramid']))
        entry['V'][0][2][0] = str(Fraction(entry['V'][0][2][0]) + Fraction(1, 1000))
        with self.assertRaises(AssertionError):
            johnson_prove.prove(1, entry)
        # a face dropped: not a closed surface
        entry = json.loads(json.dumps(EXACT['square_pyramid']))
        entry['faces'] = entry['faces'][:-1]
        with self.assertRaises(AssertionError):
            johnson_prove.prove(1, entry)

    def test_the_centroid_is_the_origin_and_edges_are_unit(self):
        # independent of johnson_prove: the numbers of a few solids in floating point
        import math
        for j in (6, 34, 48, 71, 84, 92):
            entry = EXACT[sname(j)]
            lo, hi = Fraction(entry['interval'][0]), Fraction(entry['interval'][1])
            alpha = float((lo + hi) / 2)
            V = [[sum(float(Fraction(c)) * alpha ** k for k, c in enumerate(x)) for x in v] for v in entry['V']]
            for k in range(3):
                self.assertLess(abs(sum(v[k] for v in V)), 1e-9)
            for f in entry['faces']:
                for a, b in zip(f, f[1:] + f[:1]):
                    self.assertAlmostEqual(math.dist(V[a], V[b]), 1.0, places=9)


class JohnsonCertify(unittest.TestCase):
    def test_certify_reads_the_data(self):
        import certify
        fixture = json.load(open(os.path.join(HERE, 'fixtures', 'johnson_start.json')))
        self.assertGreaterEqual(len(fixture), 3)
        for name, case in fixture.items():
            res = certify.certify_config(name, 'cube', case['s'], case['pieces'])
            self.assertTrue(res['ok'], name)
            self.assertGreater(res['min_wall_slack'], 0, name)


if __name__ == '__main__':
    unittest.main()
