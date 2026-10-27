#!/usr/bin/env python3
"""Tests of the balls certifier (python/balls/certify.py): exact contact rules, overlaps and protrusions of 1e-9,
malformed input, the published fields and agreement with the float validator near contact. Balls have diameter 1 and
a ball container is scored by its diameter (2026-10-27). Run: python3 python/balls/test_certify.py"""
import json
import math
import os
import sys
import unittest
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import balls_catalogue  # noqa: E402
import certify  # noqa: E402
from balls_catalogue import bound  # noqa: E402



def q_of_axis_angle(axis, angle):
    l = math.sqrt(sum(a * a for a in axis))
    s = math.sin(angle / 2) / l
    return [math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s]


class Balls(unittest.TestCase):
    def test_touching_balls_and_walls_are_valid(self):
        # two balls of diameter 1 touching each other and the container ball of diameter 2, exactly
        r = certify.certify_balls('ball', 2.0, [[0.5, 0.0, 0.0], [-0.5, 0.0, 0.0]])
        self.assertTrue(r['ok'])
        self.assertEqual(r['min_pair_gap'], 0.0)
        self.assertEqual(r['min_wall_gap'], 0.0)
        # eight balls of the 2 x 2 x 2 grid in the cube of edge 2, all touching
        grid = [[x, y, z] for x in (-0.5, 0.5) for y in (-0.5, 0.5) for z in (-0.5, 0.5)]
        self.assertTrue(certify.certify_balls('cube', 2.0, grid)['ok'])

    def test_overlap_of_1e9_is_rejected(self):
        d = 0.5 - 0.5e-9
        r = certify.certify_balls('ball', 2.0, [[d, 0.0, 0.0], [-d, 0.0, 0.0]])
        self.assertFalse(r['ok'])
        self.assertEqual(r['failed_pairs'], [[0, 1]])
        grid = [[x, y, z] for x in (-0.5, 0.5) for y in (-0.5, 0.5) for z in (-0.5, 0.5)]
        grid[0] = [-0.5 + 1e-9, -0.5, -0.5]
        self.assertFalse(certify.certify_balls('cube', 2.0, grid)['ok'])

    def test_protrusion_of_1e9_is_rejected(self):
        r = certify.certify_balls('ball', 2.0, [[0.5 + 1e-9, 0.0, 0.0], [-0.5, 0.0, 0.0]])
        self.assertFalse(r['ok'])
        self.assertEqual(r['failed_walls'], [0])
        # a ball 1e-9 past the cube's face x = s/2 - 1/2, the others clear
        r = certify.certify_balls('cube', 2.0, [[0.5 + 1e-9, -0.5, -0.5], [-0.5, 0.5, 0.5]])
        self.assertFalse(r['ok'])
        self.assertEqual(r['failed_walls'], [0])
        # off by one ulp of s is enough
        s = math.nextafter(2.0, 0)
        self.assertFalse(certify.certify_balls('ball', s, [[0.5, 0.0, 0.0], [-0.5, 0.0, 0.0]])['ok'])

    def test_clearance_of_1e10_is_reported(self):
        g = 1e-10
        r = certify.certify_balls('ball', 2 + 3 * g, [[0.5 + g / 2, 0.0, 0.0], [-0.5 - g / 2, 0.0, 0.0]])
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
            certify.certify_balls('ball', 0.5, [[0.0, 0.0, 0.0]])    # a container of diameter below 1 holds no ball
        with self.assertRaises(certify.CertError):
            certify.certify_balls('cube', 0.75, [[0.0, 0.0, 0.0]])   # nor a cube of edge below 1


class Solids(unittest.TestCase):
    def test_two_cubes_face_to_face(self):
        # cubes [-1, 0] x [-1/2, 1/2]^2 and [0, 1] x [-1/2, 1/2]^2: the farthest vertex is at sqrt(1 + 1/4 + 1/4)
        # (the container is scored by its diameter: twice the radius that the vertices need)
        far = math.sqrt(1.5)
        for gap, s_extra, ok in ((1e-10, 1e-10, True), (-1e-9, 1e-9, False), (1e-10, -1e-9, False)):
            pieces = [[-0.5 - gap / 2, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], [0.5 + gap / 2, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
            s = 2 * (math.sqrt((1 + gap / 2) ** 2 + 0.5) + s_extra)
            r = certify.certify_solids('cube', s, pieces)
            self.assertEqual(r['ok'], ok, (gap, s_extra))
        self.assertGreater(far, 1.2)

    def test_touching_solids_are_not_certified(self):
        # exact contact cannot be shown by a strict plane: the certifier refuses rather than guess
        pieces = [[-0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], [0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
        r = certify.certify_solids('cube', 4.0, pieces)
        self.assertFalse(r['ok'])
        self.assertEqual(r['failed_pairs'], [[0, 1]])

    def test_a_piece_turned_by_1e3_rad_is_caught(self):
        # cubes face to face 1e-10 apart are valid; turning one by 1e-3 rad about z pushes its corners 5e-4 into the other
        g = 1e-10
        s = 2 * (math.sqrt((1 + g / 2) ** 2 + 0.5) + 1e-3)
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
        self.assertTrue(certify.certify_solids('tetrahedron', 2 * (2 * R + 1e-6), tets)['ok'])

    def test_protruding_vertex(self):
        # one icosahedron at the origin: circumradius sqrt(10 + 2 sqrt 5) / 4
        R = math.sqrt(10 + 2 * math.sqrt(5)) / 4
        one = [[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
        self.assertTrue(certify.certify_solids('icosahedron', 2 * (R + 1e-10), one)['ok'])
        self.assertFalse(certify.certify_solids('icosahedron', 2 * (R - 1e-9), one)['ok'])
        # the same with a large integer quaternion of the identity
        big = [[0.0, 0.0, 0.0, 5e48, 0.0, 0.0, 0.0]]
        self.assertTrue(certify.certify_solids('icosahedron', 2 * (R + 1e-10), big)['ok'])

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
    pieces = pieces or [[0.50000000005, 0.0, 0.0], [-0.50000000005, 0.0, 0.0]]
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
        r = a_record(); r['config']['pieces'][0] = [0.99, 0.0, 0.0]; bad.append(r)    # protrudes from the container
        for k, rec in enumerate(bad):
            self.assertFalse(certify.certify_record(rec)['ok'], k)

    def test_proven_needs_its_proof(self):
        r = a_record('ballincub', 2, 1 + 1 / math.sqrt(3) + 2e-10,
                     [[0.28867513462, 0.28867513462, 0.28867513462], [-0.28867513462, -0.28867513462, -0.28867513462]])
        r['bound']['value'] = bound('ballincub', 2)
        self.assertTrue(certify.certify_record(r)['ok'], certify.certify_record(r))
        r['status'] = 'proven'
        self.assertFalse(certify.certify_record(r)['ok'])
        r['literature'] = [{'value': 1 + 1 / math.sqrt(3), 'source': 'J. Schaer 1966', 'short': 'Schaer 1966', 'proof': 'n = 2'}]
        self.assertTrue(certify.certify_record(r)['ok'])
        r['literature'][0]['value'] = 1.6
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


class Catalogue(unittest.TestCase):
    """The 189 problems and their bounds agree with packages/balls (fixtures/bounds.json, scripts/gen-bounds.ts)."""

    def test_codes_ids_and_titles(self):
        c = balls_catalogue
        self.assertEqual(len(c.CODES), 189)
        self.assertEqual(len(set(c.CODES)), 189)
        self.assertEqual(c.ORIGINAL_CODES, ['ballinball', 'ballincub', 'tetinball', 'cubinball', 'octinball', 'dodinball', 'icoinball'])
        self.assertEqual(c.PROBLEMS['ballinpkd'], {'piece': 'ball', 'container': 'pentakis_dodecahedron', 'title': 'Balls in a pentakis dodecahedron'})
        self.assertEqual(c.PROBLEMS['kttinball']['title'], 'Triakis tetrahedra in a ball')
        self.assertEqual(c.PROBLEMS['pr3l15inball']['title'], 'Triangular prisms of height 1.5 in a ball')
        self.assertEqual(c.PROBLEMS['ballinoct']['title'], 'Balls in an octahedron')
        self.assertEqual(c.parse_id('balls/pr3l15inball/7'), ('pr3l15inball', 7))
        self.assertEqual(c.parse_id('balls/ballinpkd/100'), ('ballinpkd', 100))
        for bad in ('balls/ballinpkd/1', 'balls/ballinpkd/101', 'balls/ballinpkd/07', 'balls/ballinPKD/5', 'balls/3inball/5', 'balls/pr3l16inball/5'):
            self.assertIsNone(c.parse_id(bad), bad)
        self.assertEqual(c.BALL_RADIUS, Fraction(1, 2))
        self.assertEqual(c.BALL_DIAMETER, 1)

    def test_bounds_and_solid_geometry_match_the_typescript(self):
        with open(os.path.join(HERE, 'fixtures', 'bounds.json')) as f:
            d = json.load(f)
        self.assertEqual(len(d['solids']), 94)
        self.assertEqual(len(d['bounds']), 189 * 3)
        for name, g in d['solids'].items():
            h = balls_catalogue.geometry(name)
            self.assertEqual(h['tangential'], g['tangential'], name)
            for k in ('volume', 'inradius', 'circumradius', 'diameter'):
                self.assertAlmostEqual(h[k] / g[k], 1.0, delta=1e-12, msg=f'{name} {k}')
        for b in d['bounds']:
            self.assertAlmostEqual(bound(b['code'], b['P']) / b['value'], 1.0, delta=1e-12, msg=str(b))
        # the bound of a ball in a tetrahedron at P = 2: the two far vertices of the shrunk tetrahedron
        self.assertAlmostEqual(bound('ballintet', 2), 6 / math.sqrt(6) + 1, delta=1e-12)


class SolidContainers(unittest.TestCase):
    """Balls in a solid other than the ball and the cube: the walls are decided with interval arithmetic."""

    def test_a_centred_ball_needs_the_inradius(self):
        # the octahedron (edge 1) has inradius sqrt 6 / 6: one ball of radius 1/2 fits from s = sqrt 6 / 2 on
        s = math.sqrt(6) / 2
        for k, ok in ((1e-9, True), (1e-12, True), (1e-15, True), (-1e-15, False), (-1e-9, False)):
            r = certify.certify_balls('octahedron', s * (1 + k), [[0.0, 0.0, 0.0]])
            self.assertEqual(r['ok'], ok, k)
            self.assertAlmostEqual(r['min_wall_gap'], s * k / math.sqrt(6), delta=1e-14)
        r = certify.certify_balls('octahedron', s * 0.9, [[0.0, 0.0, 0.0]])
        self.assertEqual(r['failed_walls'], [0])

    def test_pairs_and_walls_together(self):
        # two balls on the axis of a hexagonal prism (edge 1, height 1): the prism's ends are at 0.5, so s * 0.5 >= 1/2 + |c_z|
        s = 2.25
        z = s * 0.5 - 0.5
        ok = certify.certify_balls('prism6', s, [[0.0, 0.0, z * (1 - 1e-12)], [0.0, 0.0, -z * (1 - 1e-12)]])
        self.assertTrue(ok['ok'])
        self.assertAlmostEqual(ok['min_pair_gap'], 2 * z - 1, delta=1e-9)
        bad = certify.certify_balls('prism6', s, [[0.0, 0.0, z * (1 + 1e-9)], [0.0, 0.0, -z * (1 - 1e-12)]])
        self.assertEqual(bad['failed_walls'], [0])
        near = certify.certify_balls('prism6', s, [[0.0, 0.0, 0.0], [0.0, 0.0, 1 - 1e-9]])
        self.assertEqual(near['failed_pairs'], [[0, 1]])
        self.assertFalse(near['ok'])

    def test_malformed_and_unknown(self):
        with self.assertRaises(certify.CertError):
            certify.certify_balls('no_such_solid', 3.0, [[0.0, 0.0, 0.0]])
        with self.assertRaises(certify.CertError):
            certify.certify_balls('octahedron', 3.0, [[0.0, 0.0]])
        with self.assertRaises(certify.CertError):
            certify.certify_balls('octahedron', 0.0, [[0.0, 0.0, 0.0]])
        with self.assertRaises(certify.CertError):
            certify.certify_balls('octahedron', 3.0, [[0.0, 0.0, float('nan')]])

    def test_a_record_of_a_new_problem_passes_its_field_checks(self):
        s = math.sqrt(6) * (1 + 1e-9)
        rec = a_record('ballinoct', 2, s, [[0.15, 0.0, 0.0], [-0.15, 0.0, 0.0]])
        rec['bound']['value'] = bound('ballinoct', 2)
        res = certify.certify_record(rec)
        self.assertFalse(res['ok'], res)       # the balls overlap
        rec['config']['pieces'] = [[0.5, 0.0, 0.0], [-0.5, 0.0, 0.0]]
        self.assertTrue(certify.certify_record(rec)['ok'], certify.certify_record(rec))
        rec['container'] = 'cube'
        self.assertFalse(certify.certify_record(rec)['ok'])

    def test_validator_and_certifier_agree_near_contact_on_the_solids(self):
        # fixtures/crosscheck_solids.json: 702 cases from packages/balls/scripts/gen-crosscheck-solids.ts with the float
        # validator's measured gaps (+-1e-7, +-1e-9, +-1e-12): one ball against the walls of each of the 93 solids that
        # are no cube, and pairs and walls of 8 solids in a ball. The certifier is exact, the validator's floats err by
        # about 1e-16 of the sizes, so they agree wherever the gap exceeds 1e-13.
        with open(os.path.join(HERE, 'fixtures', 'crosscheck_solids.json')) as f:
            cases = json.load(f)['cases']
        self.assertEqual(len(cases), 702)
        seen = {'valid': 0, 'invalid': 0}
        for c in cases:
            r = certify.certify_config(c['code'], c['config']['s'], c['config']['pieces'])
            if c['gap'] > 1e-13:
                self.assertTrue(r['ok'], (c['code'], c['what'], c['gap']))
                seen['valid'] += 1
            elif c['gap'] < -1e-13:
                self.assertFalse(r['ok'], (c['code'], c['what'], c['gap']))
                seen['invalid'] += 1
        self.assertEqual(seen['valid'], 351)
        self.assertEqual(seen['invalid'], 351)


class TestPackings(unittest.TestCase):
    """fixtures/packings.json: test packings of every problem kind at P = 2, 5, 13, 30, 80 and 100 (not records: the
    problems ship without any). Each is proven valid, and fails once its container is shrunk by 1e-8 relative."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HERE, 'fixtures', 'packings.json')) as f:
            cls.packings = json.load(f)['packings']

    def test_every_kind_and_size(self):
        self.assertEqual(sorted({p['code'] for p in self.packings}), sorted(certify.catalogue.ORIGINAL_CODES))
        self.assertEqual(len(self.packings), 7 * 6)
        for p in self.packings:
            r = certify.certify_config(p['code'], p['config']['s'], p['config']['pieces'])
            self.assertTrue(r['ok'], (p['id'], r.get('failed_walls'), r.get('failed_pairs')))
            self.assertGreater(r['min_wall_gap'], 0)
            self.assertGreaterEqual(p['config']['s'], bound(p['code'], p['P']))

    def test_shrunk_packings_fail(self):
        for p in self.packings:
            if p['P'] not in (5, 13):
                continue
            c = p['config']
            self.assertFalse(certify.certify_config(p['code'], c['s'] * (1 - 1e-8), c['pieces'])['ok'], p['id'])

    def test_as_records(self):
        # the packings as records of a records file pass the field checks too
        for p in self.packings:
            if p['P'] != 13:
                continue
            rec = a_record(p['code'], 13, p['config']['s'], p['config']['pieces'])
            res = certify.certify_record(rec)
            self.assertTrue(res['ok'], (p['id'], res.get('errors')))


if __name__ == '__main__':
    unittest.main(verbosity=1)
