#!/usr/bin/env python3
"""Tests of the balls certifier (python/balls/certify.py): exact contact rules, overlaps and protrusions of 1e-9,
malformed input, the published fields and agreement with the float validator near contact. Run: python3 python/balls/test_certify.py"""
import copy
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import certify  # noqa: E402
from balls_catalogue import bound  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
RECORDS = os.path.join(ROOT, 'data', 'balls', 'records.json')


def q_of_axis_angle(axis, angle):
    l = math.sqrt(sum(a * a for a in axis))
    s = math.sin(angle / 2) / l
    return [math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s]


class Balls(unittest.TestCase):
    def test_touching_balls_and_walls_are_valid(self):
        # two unit balls touching each other and the container ball of radius 2, exactly
        r = certify.certify_balls('ball', 2.0, [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]])
        self.assertTrue(r['ok'])
        self.assertEqual(r['min_pair_gap'], 0.0)
        self.assertEqual(r['min_wall_gap'], 0.0)
        # eight balls of the 2 x 2 x 2 grid in the cube of edge 4, all touching
        grid = [[x, y, z] for x in (-1.0, 1.0) for y in (-1.0, 1.0) for z in (-1.0, 1.0)]
        self.assertTrue(certify.certify_balls('cube', 4.0, grid)['ok'])

    def test_overlap_of_1e9_is_rejected(self):
        d = 1 - 0.5e-9
        r = certify.certify_balls('ball', 2.0, [[d, 0.0, 0.0], [-d, 0.0, 0.0]])
        self.assertFalse(r['ok'])
        self.assertEqual(r['failed_pairs'], [[0, 1]])
        grid = [[x, y, z] for x in (-1.0, 1.0) for y in (-1.0, 1.0) for z in (-1.0, 1.0)]
        grid[0] = [-1 + 1e-9, -1.0, -1.0]
        self.assertFalse(certify.certify_balls('cube', 4.0, grid)['ok'])

    def test_protrusion_of_1e9_is_rejected(self):
        r = certify.certify_balls('ball', 2.0, [[1 + 1e-9, 0.0, 0.0], [-1.0, 0.0, 0.0]])
        self.assertFalse(r['ok'])
        self.assertEqual(r['failed_walls'], [0])
        # a ball 1e-9 past the cube's face x = s/2 - 1, the others clear
        r = certify.certify_balls('cube', 4.0, [[1 + 1e-9, -1.0, -1.0], [-1.0, 1.0, 1.0]])
        self.assertFalse(r['ok'])
        self.assertEqual(r['failed_walls'], [0])
        # off by one ulp of s is enough
        s = math.nextafter(2.0, 0)
        self.assertFalse(certify.certify_balls('ball', s, [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]])['ok'])

    def test_clearance_of_1e10_is_reported(self):
        g = 1e-10
        r = certify.certify_balls('ball', 2 + 2 * g, [[1 + g / 2, 0.0, 0.0], [-1 - g / 2, 0.0, 0.0]])
        self.assertTrue(r['ok'])
        self.assertAlmostEqual(r['min_pair_gap'], g, delta=1e-15)
        self.assertGreater(r['min_wall_gap'], 0.9 * g)

    def test_malformed_balls(self):
        for pieces in ([[0.0, 0.0]], [[0.0, 0.0, 'x']], [[0.0, 0.0, True]], [[0.0, 0.0, float('nan')]],
                       [[0.0, 0.0, float('inf')]], [], 'balls', [[0.0, 0.0, 0.0, 0.0]]):
            with self.assertRaises(certify.CertError, msg=repr(pieces)):
                certify.certify_balls('ball', 3.0, pieces)
        for s in (0.0, -1.0, float('nan'), '3', None, True):
            with self.assertRaises(certify.CertError, msg=repr(s)):
                certify.certify_balls('ball', s, [[0.0, 0.0, 0.0]])
        with self.assertRaises(certify.CertError):
            certify.certify_balls('ball', 0.5, [[0.0, 0.0, 0.0]])
        with self.assertRaises(certify.CertError):
            certify.certify_balls('cube', 1.5, [[0.0, 0.0, 0.0]])


class Solids(unittest.TestCase):
    def test_two_cubes_face_to_face(self):
        # cubes [-1, 0] x [-1/2, 1/2]^2 and [0, 1] x [-1/2, 1/2]^2: the farthest vertex is at sqrt(1 + 1/4 + 1/4)
        far = math.sqrt(1.5)
        for gap, s_extra, ok in ((1e-10, 1e-10, True), (-1e-9, 1e-9, False), (1e-10, -1e-9, False)):
            pieces = [[-0.5 - gap / 2, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], [0.5 + gap / 2, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
            s = math.sqrt((1 + gap / 2) ** 2 + 0.5) + s_extra
            r = certify.certify_solids('cube', s, pieces)
            self.assertEqual(r['ok'], ok, (gap, s_extra))
        self.assertGreater(far, 1.2)

    def test_touching_solids_are_not_certified(self):
        # exact contact cannot be shown by a strict plane: the certifier refuses rather than guess
        pieces = [[-0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], [0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
        r = certify.certify_solids('cube', 2.0, pieces)
        self.assertFalse(r['ok'])
        self.assertEqual(r['failed_pairs'], [[0, 1]])

    def test_a_piece_turned_by_1e3_rad_is_caught(self):
        # cubes face to face 1e-10 apart are valid; turning one by 1e-3 rad about z pushes its corners 5e-4 into the other
        g = 1e-10
        s = math.sqrt((1 + g / 2) ** 2 + 0.5) + 1e-3
        a = [-0.5 - g / 2, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]
        b = [0.5 + g / 2, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]
        self.assertTrue(certify.certify_solids('cube', s, [a, b])['ok'])
        b2 = b[:3] + q_of_axis_angle([0.0, 0.0, 1.0], 1e-3)
        r = certify.certify_solids('cube', s, [a, b2])
        self.assertFalse(r['ok'])
        self.assertEqual(r['failed_pairs'], [[0, 1]])
        # tetrahedra: the same pair test on a turned pair kept apart by its circumradii is certified
        R = math.sqrt(6) / 4
        q = q_of_axis_angle([0.3, 1.0, 0.2], 0.7)
        tets = [[-R - 1e-9, 0.0, 0.0] + q, [R + 1e-9, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
        self.assertTrue(certify.certify_solids('tetrahedron', 2 * R + 1e-6, tets)['ok'])

    def test_protruding_vertex(self):
        # one icosahedron at the origin: circumradius sqrt(10 + 2 sqrt 5) / 4
        R = math.sqrt(10 + 2 * math.sqrt(5)) / 4
        one = [[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
        self.assertTrue(certify.certify_solids('icosahedron', R + 1e-10, one)['ok'])
        self.assertFalse(certify.certify_solids('icosahedron', R - 1e-9, one)['ok'])
        # the same with a large integer quaternion of the identity
        big = [[0.0, 0.0, 0.0, 5e48, 0.0, 0.0, 0.0]]
        self.assertTrue(certify.certify_solids('icosahedron', R + 1e-10, big)['ok'])

    def test_malformed_solids(self):
        for pieces in ([[0.0] * 6], [[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]], [[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 'x']],
                       [[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, float('nan')]], [], [[0.0, 0.0, 0.0, False, 0.0, 0.0, 1.0]]):
            with self.assertRaises(certify.CertError, msg=repr(pieces)):
                certify.certify_solids('cube', 3.0, pieces)
        with self.assertRaises(certify.CertError):
            certify.certify_solids('cuboid', 3.0, [[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]])
        with self.assertRaises(certify.CertError):
            certify.certify_solids('cube', -1.0, [[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]])


def a_record(code='ballinball', P=2, s=2.0000000003, pieces=None):
    pieces = pieces or [[1.0000000001, 0.0, 0.0], [-1.0000000001, 0.0, 0.0]]
    prob = certify.catalogue.PROBLEMS[code]
    return {
        'id': f'balls/{code}/{P}', 'code': code, 'piece': prob['piece'], 'container': prob['container'], 'P': P,
        'config': {'s': s, 'pieces': pieces}, 'score_cert': s, 'display': certify.display(s),
        'bound': {'value': bound(code, P), 'kind': 'two pieces', 'label': ''}, 'status': 'best_known', 'literature': [],
    }


class Fields(unittest.TestCase):
    def test_a_good_record(self):
        r = certify.certify_record(a_record())
        self.assertTrue(r['ok'], r)

    def test_each_field(self):
        bad = []
        r = a_record(); r['id'] = 'balls/ballinball/02'; bad.append(r)
        r = a_record(); r['id'] = 'balls/ballinball/1'; bad.append(r)
        r = a_record(); r['id'] = 'balls/ballinball/101'; bad.append(r)
        r = a_record(); r['id'] = 'balls/ballinballs/2'; bad.append(r)
        r = a_record(); r['container'] = 'cube'; bad.append(r)
        r = a_record(); r['P'] = 3; bad.append(r)
        r = a_record(); r['config']['pieces'].append([5.0, 5.0, 5.0]); bad.append(r)
        r = a_record(); r['config']['pieces'][0] = [1.0, 0.0]; bad.append(r)
        r = a_record(); r['config']['pieces'][0] = [float('nan'), 0.0, 0.0]; bad.append(r)
        r = a_record(); r['score_cert'] = 2.1; bad.append(r)
        r = a_record(); r['display'] = '2.0000000003'; bad.append(r)
        r = a_record(); r['bound']['value'] = 1.5; bad.append(r)
        r = a_record(); r['status'] = 'optimal'; bad.append(r)
        r = a_record(); r['status'] = 'proven'; bad.append(r)
        r = a_record(); r['literature'] = [{'value': '2', 'source': 'x'}]; bad.append(r)
        r = a_record(); r['config']['pieces'][0] = [0.99, 0.0, 0.0]; bad.append(r)
        for k, rec in enumerate(bad):
            self.assertFalse(certify.certify_record(rec)['ok'], k)

    def test_proven_needs_its_proof(self):
        r = a_record('ballincub', 2, 2 + 2 / math.sqrt(3) + 4e-10,
                     [[0.57735026924, 0.57735026924, 0.57735026924], [-0.57735026924, -0.57735026924, -0.57735026924]])
        r['bound']['value'] = bound('ballincub', 2)
        self.assertTrue(certify.certify_record(r)['ok'], certify.certify_record(r))
        r['status'] = 'proven'
        self.assertFalse(certify.certify_record(r)['ok'])
        r['literature'] = [{'value': 2 + 2 / math.sqrt(3), 'source': 'J. Schaer 1966', 'short': 'Schaer 1966', 'proof': 'n = 2'}]
        self.assertTrue(certify.certify_record(r)['ok'])
        r['literature'][0]['value'] = 3.2
        self.assertFalse(certify.certify_record(r)['ok'])


class CrossCheck(unittest.TestCase):
    def test_validator_and_certifier_agree_near_contact(self):
        # fixtures/crosscheck.json: 140 cases from packages/balls/scripts/gen-crosscheck.ts with the float validator's
        # measured gaps (+-1e-7, +-1e-9, pairs and walls, every problem)
        with open(os.path.join(HERE, 'fixtures', 'crosscheck.json')) as f:
            cases = json.load(f)['cases']
        self.assertEqual(len(cases), 140)
        for c in cases:
            r = certify.certify_config(c['code'], c['config']['s'], c['config']['pieces'])
            if c['gap'] > 1e-10:
                self.assertTrue(r['ok'], (c['code'], c['what'], c['gap']))
            elif c['gap'] < -1e-10:
                self.assertFalse(r['ok'], (c['code'], c['what'], c['gap']))


@unittest.skipUnless(os.path.exists(RECORDS), 'no records file')
class Shipped(unittest.TestCase):
    def test_a_sample_of_the_records(self):
        doc = certify.load_records(RECORDS)
        recs = doc['records']
        self.assertEqual(len(recs), 7 * 99)
        # every problem's P = 2, 13 and 50: fast enough for the test suite (the full run is in the docs)
        pick = [r for r in recs if r['P'] in (2, 13, 50)]
        for rec in pick:
            res = certify.certify_record(copy.deepcopy(rec))
            self.assertTrue(res['ok'], (rec['id'], res.get('errors')))

    def test_shrunk_records_fail(self):
        doc = certify.load_records(RECORDS)
        for rec in [r for r in doc['records'] if r['P'] in (5, 20)]:
            c = rec['config']
            s = c['s'] * (1 - 1e-8)
            self.assertFalse(certify.certify_config(rec['code'], s, c['pieces'])['ok'], rec['id'])


if __name__ == '__main__':
    unittest.main(verbosity=1)
