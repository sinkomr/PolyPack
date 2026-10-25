#!/usr/bin/env python3
"""Tests of the polyhedra certifier (python/polyhedra/certify.py and the vendored certify_general.py).

Run: python3 python/polyhedra/test_certify.py. Standard library only. Covers the published-field checks, the display
rule, adversarial configurations (overlaps and protrusions of 3e-7, coincident pieces, zero and non-numeric
quaternions, strings, booleans, NaN), agreement with the TypeScript validator on the near-contact cases of
fixtures/crosscheck.json, and a field check of every record of data/polyhedra/records.json.
"""
import copy
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue  # noqa: E402
import certify  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
RECORDS = os.path.join(ROOT, 'data', 'polyhedra', 'records.json')
VOL = certify.solid_volumes()


def read_json(path):
    with open(path) as f:
        return json.load(f)


def cubes8():
    """8 unit cubes in a cube: pair gaps 1e-7, wall gaps 1.5e-7."""
    a = 0.5 + 0.5e-7
    pieces = [[x, y, z, 1.0, 0.0, 0.0, 0.0] for x in (-a, a) for y in (-a, a) for z in (-a, a)]
    return 2 + 4e-7, pieces


def record_of(s, pieces, code='cubincub'):
    piece, container, family = catalogue.PROBLEMS[code]
    n = len(pieces)
    vb = certify.volume_bound(piece, container, n, VOL)
    return {'id': f'polyhedra/{code}/{n}', 'code': code, 'piece': piece, 'container': container, 'family': family,
            'P': n, 'score_float': s * (1 - 1e-8), 'score_cert': s, 'display': certify.display(s),
            'status': 'best_known', 'config': {'s': s, 'pieces': pieces},
            'bound': {'value': vb, 'kind': 'volume', 'label': '[EST] volume'}, 'found_by': 'test', 'literature': []}


class Display(unittest.TestCase):
    def test_rounds_exact_binary_value_half_even(self):
        self.assertEqual(certify.display(2.0000003000001), '2.000000')
        self.assertEqual(certify.display(2.4166165), '2.416616')       # the double is just below the tie
        self.assertEqual(certify.display(0.0078125), '0.007812')       # an exact binary tie goes to even
        self.assertEqual(certify.display(1.0234375), '1.023438')
        self.assertEqual(certify.display(1.9535648569341), '1.953565')


class Geometry(unittest.TestCase):
    def test_valid_configuration_certifies(self):
        s, p = cubes8()
        c = certify.certify_config('cube', 'cube', s, p)
        self.assertTrue(c['ok'])
        self.assertGreater(c['min_pair_gap'], 0.9e-7)
        self.assertGreater(c['min_wall_slack'], 1.4e-7)

    def test_scaled_quaternions_still_certify(self):
        s, p = cubes8()
        p = [x[:3] + [3 * v for v in x[3:]] for x in p]
        self.assertTrue(certify.certify_config('cube', 'cube', s, p)['ok'])

    def test_overlap_of_3e7_fails(self):
        s, p = cubes8()
        p[0][0] += 3e-7                                    # 1e-7 gap becomes a 2e-7 overlap
        c = certify.certify_config('cube', 'cube', s, p)
        self.assertFalse(c['ok'])
        self.assertTrue(c['failed_pairs'])

    def test_protrusion_fails(self):
        s, p = cubes8()
        c = certify.certify_config('cube', 'cube', s - 3.2e-7 * 2, p)   # wall gap 1.5e-7 becomes -1.7e-7
        self.assertFalse(c['ok'])
        self.assertTrue(c['failed_walls'])

    def test_coincident_pieces_fail(self):
        s, p = cubes8()
        p[1] = list(p[0])
        self.assertFalse(certify.certify_config('cube', 'cube', s, p)['ok'])

    def test_rotation_into_neighbour_fails(self):
        s, p = cubes8()
        h = math.sin(1e-3 / 2)
        p[0][3:] = [math.cos(1e-3 / 2), 0.0, 0.0, h]       # turned 1e-3 rad: its corners reach 7e-4 out
        self.assertFalse(certify.certify_config('cube', 'cube', s, p)['ok'])

    def test_malformed_numbers_are_refused(self):
        s, p = cubes8()
        for bad in ('0.5', True, float('nan'), float('inf'), None):
            q = copy.deepcopy(p)
            q[2][1] = bad
            with self.assertRaises(certify.CertError, msg=repr(bad)):
                certify.certify_config('cube', 'cube', s, q)
        q = copy.deepcopy(p)
        q[3][3:] = [0.0, 0.0, 0.0, 0.0]
        with self.assertRaises(certify.CertError):
            certify.certify_config('cube', 'cube', s, q)
        with self.assertRaises(certify.CertError):
            certify.certify_config('cube', 'cube', -s, p)
        with self.assertRaises(certify.CertError):
            certify.certify_config('cube', 'cube', s, [x[:6] for x in p])
        with self.assertRaises(certify.CertError):
            certify.certify_config('cube', 'blob', s, p)

    def test_other_solids(self):
        # one piece of each kind in a roomy container of itself: certifies; shrunk below the piece: fails
        for name in ('truncated_icosidodecahedron', 'pentagonal_hexecontahedron', 'snub_cube', 'prism3_l3',
                     'antiprism12'):
            p = [[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
            self.assertTrue(certify.certify_config(name, name, 1 + 1e-6, p)['ok'], name)
            self.assertFalse(certify.certify_config(name, name, 1 - 1e-9, p)['ok'], name)


class Fields(unittest.TestCase):
    def setUp(self):
        s, p = cubes8()
        self.rec = record_of(s, p)

    def errs(self, rec):
        return certify.field_errors(rec, VOL)

    def test_good_record(self):
        self.assertEqual(self.errs(self.rec), [])
        self.assertTrue(certify.check_record(self.rec, VOL)['ok'])

    def test_bad_fields(self):
        cases = {
            'id': 'polyhedra/cubincub/08', 'code': 'cubintet', 'P': 7, 'display': '2.000001',
            'status': 'proven', 'score_float': 3.0, 'family': 'catalan', 'found_by': '',
        }
        for k, v in cases.items():
            r = copy.deepcopy(self.rec)
            r[k] = v
            self.assertTrue(self.errs(r), k)
        r = copy.deepcopy(self.rec)
        r['config']['s'] = r['score_cert'] * (1 + 1e-15)
        self.assertTrue(self.errs(r))
        r = copy.deepcopy(self.rec)
        r['config']['pieces'].pop()
        self.assertTrue(self.errs(r))
        r = copy.deepcopy(self.rec)
        r['bound']['value'] = 2.5
        self.assertTrue(self.errs(r))
        r = copy.deepcopy(self.rec)
        r['config']['extra'] = 1
        self.assertTrue(self.errs(r))
        r = copy.deepcopy(self.rec)
        r['literature'] = [{'value': '1.9', 'source': 'x'}]
        self.assertTrue(self.errs(r))
        for bad in ('polyhedra/cubincub/+8', 'polyhedra/blob/8', 'polyhedra/cubincub/0', 'polyhedra//8', 8):
            r = copy.deepcopy(self.rec)
            r['id'] = bad
            self.assertTrue(self.errs(r), bad)

    def test_claim_below_the_certified_scale_fails(self):
        r = copy.deepcopy(self.rec)
        s = 2 + 1e-7                                       # walls at -0.5e-7
        r['score_cert'] = r['config']['s'] = s
        r['score_float'] = s * (1 - 1e-8)
        r['display'] = certify.display(s)
        out = certify.check_record(r, VOL)
        self.assertFalse(out['ok'])


class CrossCheck(unittest.TestCase):
    """The certifier and the TypeScript validator agree on near-contact cases (gaps and overlaps of 1e-7, 1e-9)."""

    def test_agreement(self):
        cases = read_json(os.path.join(HERE, 'fixtures', 'crosscheck.json'))['cases']
        self.assertGreaterEqual(len(cases), 200)
        n_ok = n_bad = 0
        for c in cases:
            piece, container, _ = catalogue.PROBLEMS[c['code']]
            out = certify.certify_config(piece, container, c['s'], c['pieces'])
            # a single piece has no pair: the fixture writes its Infinity as null
            margin = min(math.inf if c['ts_sep'] is None else c['ts_sep'], c['ts_wall'])
            if margin > 1e-10:
                self.assertTrue(out['ok'], c['id'])
                self.assertTrue(c['ts_valid_strict'], c['id'])
                n_ok += 1
            elif margin < -1e-10:
                self.assertFalse(out['ok'], c['id'])
                self.assertFalse(c['ts_valid_strict'], c['id'])
                n_bad += 1
        self.assertGreaterEqual(n_ok, 100)
        self.assertGreaterEqual(n_bad, 100)


@unittest.skipUnless(os.path.exists(RECORDS), 'no records file')
class RecordsFile(unittest.TestCase):
    def test_fields_of_every_record(self):
        doc = certify.load_records(RECORDS)
        ids = [r['id'] for r in doc['records']]
        self.assertEqual(len(ids), len(set(ids)))
        for r in doc['records']:
            self.assertEqual(self.check(r), [], r['id'])
            for k in r.get('sources', []):
                self.assertIn(k, doc['sources'], r['id'])
            self.assertTrue(r.get('source'), r['id'])

    def check(self, r):
        return certify.field_errors(r, VOL)

    def test_a_sample_certifies(self):
        doc = certify.load_records(RECORDS)
        recs = doc['records']
        sample = recs[::max(1, len(recs) // 12)][:12]
        for r in sample:
            self.assertTrue(certify.check_record(r, VOL)['ok'], r['id'])


if __name__ == '__main__':
    unittest.main(verbosity=1)
