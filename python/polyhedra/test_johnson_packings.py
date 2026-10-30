#!/usr/bin/env python3
"""Exact certification of test packings of Johnson solids (python/polyhedra/fixtures/johnson_packings.json).

Run: python3 python/polyhedra/test_johnson_packings.py. Standard library only. The fixture is written by
packages/polyhedra/scripts/gen-johnson-packings.ts: 44 packings of J1, J3, J6, J12, J37, J44 (chiral), J72, J84, J86, J90
and J92 in a cube, in themselves, in another Johnson solid and in an Archimedean solid, each the box-lattice start
(latticeStart) with a clearance of about 1e-10, and for each two adversarial variants (a piece moved until it overlaps its
neighbour, or sticks out of the container, by 1e-9). The certifier must prove every packing, refuse every variant, agree with
the float validator's gaps, and treat a quaternion of any norm as its rotation. These are test packings, not good ones.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue  # noqa: E402
import certify  # noqa: E402

CASES = json.load(open(os.path.join(HERE, 'fixtures', 'johnson_packings.json')))['cases']


class JohnsonPackings(unittest.TestCase):
    def test_every_packing_is_certified(self):
        self.assertEqual(len(CASES), 44)
        for c in CASES:
            r = certify.certify_config(c['piece'], c['container'], c['s'], c['pieces'])
            self.assertTrue(r['ok'], c['code'])
            # the certifier's rigorous slacks are at most the float validator's gaps, and agree with them to 1e-12
            self.assertLessEqual(r['min_wall_slack'], c['minWallGap'] + 1e-12, c['code'])
            self.assertGreater(r['min_wall_slack'], c['minWallGap'] - 1e-9, c['code'])
            if c['minPairSep'] is not None and r['min_pair_gap'] is not None:
                self.assertLessEqual(r['min_pair_gap'], c['minPairSep'] + 1e-12, c['code'])

    def test_overlaps_and_protrusions_of_1e_9_are_refused(self):
        for c in CASES:
            if c['overlap'] is not None:
                r = certify.certify_config(c['piece'], c['container'], c['s'], c['overlap']['pieces'])
                self.assertFalse(r['ok'], c['code'])
                self.assertIn(c['overlap']['pair'], r['failed_pairs'], c['code'])
            r = certify.certify_config(c['piece'], c['container'], c['s'], c['protrusion']['pieces'])
            self.assertFalse(r['ok'], c['code'])
            self.assertIn(c['protrusion']['piece'], [w if isinstance(w, int) else w[0] for w in r['failed_walls']], c['code'])

    def test_a_quaternion_of_any_norm_is_its_rotation(self):
        for c in CASES[::4]:
            for scale in (7, 5 * 10 ** 48):
                pieces = [p[:3] + [scale * q for q in p[3:]] for p in c['pieces']]
                self.assertTrue(certify.certify_config(c['piece'], c['container'], c['s'], pieces)['ok'], c['code'])
        c = CASES[0]
        zero = [p[:3] + [0.0, 0.0, 0.0, 0.0] for p in c['pieces']]
        with self.assertRaises(certify.CertError):
            certify.certify_config(c['piece'], c['container'], c['s'], zero)

    def test_the_certifier_does_not_shrink_s(self):
        # the same pieces in a container 2e-9 smaller (relative, about 1e-9 of the scale) stick out
        c = next(c for c in CASES if c['code'] == 'j92inj44')
        self.assertFalse(certify.certify_config(c['piece'], c['container'], c['s'] * (1 - 1e-7), c['pieces'])['ok'])


class PairCatalogue(unittest.TestCase):
    def test_186_solids_and_34596_pairs(self):
        solids = catalogue.solids()
        self.assertEqual(len(solids), 186)
        self.assertEqual(len(catalogue.named_solids()), 94)
        self.assertEqual(len(catalogue.PROBLEMS), 150)
        seen = set()
        for a in solids:
            for b in solids:
                code = f'{a[1]}in{b[1]}'
                self.assertEqual(catalogue.pair_problem(code)[:2], (a[0], b[0]), code)
                seen.add(code)
        self.assertEqual(len(seen), 186 * 186)
        for code, (piece, container, family) in catalogue.PROBLEMS.items():
            self.assertEqual(catalogue.pair_problem(code), (piece, container, family))
        self.assertEqual(catalogue.pair_problem('j05inj92'), ('pentagonal_cupola', 'triangular_hebesphenorotunda', 'pairs'))
        for bad in ('', 'in', 'j05in', 'j93incub', 'j00incub', 'cubincubin', 7, None):
            self.assertIsNone(catalogue.pair_problem(bad), bad)


if __name__ == '__main__':
    unittest.main()
