#!/usr/bin/env python3
"""Tests of the polyhedra certifier (python/polyhedra/certify.py and the vendored certify_general.py).

Run: python3 python/polyhedra/test_certify.py. Standard library only. Covers the published-field checks, the display
rule, adversarial configurations (overlaps and protrusions of 3e-7, coincident pieces, zero and non-numeric
quaternions, strings, booleans, NaN), PolyPack's prisms and antiprisms with 7, 9, 10 and 11 sides (exact checks of the
solids in their number fields, valid, overlapping and protruding packings), agreement with the TypeScript validator
on the near-contact cases of fixtures/crosscheck.json, and a field check of every record of
data/polyhedra/records.json.
"""
import copy
import json
import math
import os
import sys
import unittest
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue  # noqa: E402
import certify  # noqa: E402
import certify_general as cg  # noqa: E402

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
                     'antiprism12', 'prism7', 'antiprism9', 'prism10_l15'):
            p = [[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
            self.assertTrue(certify.certify_config(name, name, 1 + 1e-6, p)['ok'], name)
            self.assertFalse(certify.certify_config(name, name, 1 - 1e-9, p)['ok'], name)


NEW_PRISMS = [(f'prism{k}', k, Fraction(1)) for k in (7, 9, 10, 11)] + \
    [(f'prism{k}_{t}', k, h) for k in (7, 9, 10, 11) for t, h in (('l15', Fraction(3, 2)), ('l2', Fraction(2)), ('l3', Fraction(3)))]
NEW_ANTIPRISMS = [(f'antiprism{k}', k) for k in (7, 9, 10, 11)]


class NewSolids(unittest.TestCase):
    """PolyPack's prisms and antiprisms (7, 9, 10, 11 sides), checked exactly in their number fields Q(alpha)."""

    def test_catalogue(self):
        self.assertEqual(len(catalogue.solids()), 76)
        self.assertEqual(len(catalogue.PROBLEMS), 114)
        self.assertEqual(len(catalogue.WIKI_PROBLEMS), 86)
        new = [c for c in catalogue.PROBLEMS if c not in catalogue.WIKI_PROBLEMS]
        self.assertEqual(new[:8], ['pr7inpr7', 'pr7incub', 'pr9inpr9', 'pr9incub', 'pr10inpr10', 'pr10incub',
                                   'pr11inpr11', 'pr11incub'])
        self.assertEqual(len(new), 28)
        self.assertEqual(catalogue.PROBLEMS['ap11incub'], ('antiprism11', 'cube', 'prisms'))
        self.assertEqual(catalogue.PROBLEMS['ap9inap9'], ('antiprism9', 'antiprism9', 'prisms'))
        self.assertEqual(catalogue.PROBLEMS['pr10l15incub'], ('prism10_l15', 'cube', 'prisms'))
        self.assertEqual(catalogue.parse_id('polyhedra/ap10incub/100'), ('ap10incub', 100))
        self.assertIsNone(catalogue.parse_id('polyhedra/pr13incub/2'))
        self.assertEqual(sorted(cg.EXACT), sorted(n for n, *_ in catalogue.solids()))

    def regular_base(self, S, idx):
        """The vertices idx lie exactly on one circle about the z axis and at one height; returns (r^2, z)."""
        F, U = S.F, S.U
        r2 = [F.add(F.mul(U[i][0], U[i][0]), F.mul(U[i][1], U[i][1])) for i in idx]
        self.assertTrue(all(F.is_zero(F.sub(x, r2[0])) for x in r2), S.name)
        self.assertTrue(all(F.is_zero(F.sub(U[i][2], U[idx[0]][2])) for i in idx), S.name)
        return r2[0], U[idx[0]][2]

    def test_prisms_exactly(self):
        for name, n, h in NEW_PRISMS:
            S = cg.get_solid(name)
            F, U = S.F, S.U
            if h == 1:
                self.assertIn('all edges exactly 1', S.check, name)
            else:
                self.assertIn(f'lateral edges exactly {h}', S.check, name)
            self.assertEqual(len(U), 2 * n)
            self.assertEqual(sorted(len(f) for f in S.faces), [4] * n + [n, n], name)
            # top and bottom: equilateral (unit edges, checked above) and concyclic, hence regular n-gons
            r2t, zt = self.regular_base(S, list(range(0, 2 * n, 2)))
            r2b, zb = self.regular_base(S, list(range(1, 2 * n, 2)))
            self.assertTrue(F.is_zero(F.sub(zt, F.elem([h / 2]))) and F.is_zero(F.add(zb, F.elem([h / 2]))), name)
            for k in range(n):                       # lateral edges vertical: V[2k] and V[2k + 1] differ only in z
                self.assertTrue(all(F.is_zero(F.sub(U[2 * k][c], U[2 * k + 1][c])) for c in (0, 1)), name)
            self.assertTrue(F.is_zero(U[0][1]) and F.sign(U[0][0]) > 0, name)     # vertex 0 on the +x axis

    def test_antiprisms_exactly(self):
        for name, n in NEW_ANTIPRISMS:
            S = cg.get_solid(name)
            F, U = S.F, S.U
            self.assertIn('all edges exactly 1', S.check, name)
            self.assertEqual(sorted(len(f) for f in S.faces), [3] * (2 * n) + [n, n], name)
            r2t, zt = self.regular_base(S, list(range(n)))
            r2b, zb = self.regular_base(S, list(range(n, 2 * n)))
            self.assertTrue(F.is_zero(F.sub(r2t, r2b)) and F.is_zero(F.add(zt, zb)) and F.sign(zt) > 0, name)
            self.assertTrue(F.is_zero(U[0][1]) and F.sign(U[0][0]) > 0, name)
            # alpha's interval isolates one root of its minimal polynomial (Sturm)
            self.assertEqual(cg.A.sturm_count(S.F.p, S.F.lo, S.F.hi), 1)

    def test_valid_overlapping_and_protruding_prisms(self):
        for name, n, h in NEW_PRISMS[:3]:
            # two prisms stacked in their own prism of scale 2 + 6e-7: gaps of 2e-7 to each other and to the caps
            z = 0.5 + 1e-7
            pieces = [[0.0, 0.0, -z, 1.0, 0.0, 0.0, 0.0], [0.0, 0.0, z, 1.0, 0.0, 0.0, 0.0]]
            c = certify.certify_config(name, name, 2 + 6e-7, pieces)
            self.assertTrue(c['ok'], name)
            self.assertGreater(c['min_pair_gap'], 1.9e-7)
            self.assertGreater(c['min_wall_slack'], 1.9e-7)
            over = copy.deepcopy(pieces)
            over[1][2] -= 3e-7                                      # 2e-7 gap becomes a 1e-7 overlap
            c = certify.certify_config(name, name, 2 + 6e-7, over)
            self.assertFalse(c['ok'], name)
            self.assertTrue(c['failed_pairs'])
            c = certify.certify_config(name, name, 2 - 2e-7, pieces)  # caps 1e-7 inside the pieces
            self.assertFalse(c['ok'], name)
            self.assertTrue(c['failed_walls'])

    def test_valid_overlapping_and_protruding_antiprisms(self):
        for name, n in NEW_ANTIPRISMS:
            # two antiprisms stacked in a cube of side 2R + 4e-7 (R = 1 / (2 sin(pi/n)) is their reach along x)
            R = 1 / (2 * math.sin(math.pi / n))
            H = 2 * max(v[2] for v in cg.get_solid(name).Vf)
            z = H / 2 + 1e-7
            q = [math.cos(math.pi / (2 * n)), 0.0, 0.0, math.sin(math.pi / (2 * n))]      # turned by pi/n about z
            pieces = [[0.0, 0.0, -z, 1.0, 0.0, 0.0, 0.0], [0.0, 0.0, z] + q]
            c = certify.certify_config(name, 'cube', 2 * R + 4e-7, pieces)
            self.assertTrue(c['ok'], name)
            self.assertGreater(c['min_pair_gap'], 1.9e-7)
            self.assertGreater(c['min_wall_slack'], 1.9e-7)
            over = copy.deepcopy(pieces)
            over[1][2] -= 3e-7
            c = certify.certify_config(name, 'cube', 2 * R + 4e-7, over)
            self.assertFalse(c['ok'], name)
            self.assertTrue(c['failed_pairs'])
            c = certify.certify_config(name, 'cube', 2 * R - 2e-7, pieces)
            self.assertFalse(c['ok'], name)
            self.assertTrue(c['failed_walls'])
            # in its own antiprism, turned by a symmetry (2 pi/n about the axis): fits at 1 + 1e-6, not at 1 - 1e-9
            q = [[0.0, 0.0, 0.0, math.cos(math.pi / n), 0.0, 0.0, math.sin(math.pi / n)]]
            self.assertTrue(certify.certify_config(name, name, 1 + 1e-6, q)['ok'], name)
            self.assertFalse(certify.certify_config(name, name, 1 - 1e-9, q)['ok'], name)

    def test_field_checks_of_a_new_record(self):
        z = 0.5 + 1e-7
        rec = record_of(2 + 6e-7, [[0.0, 0.0, -z, 1.0, 0.0, 0.0, 0.0], [0.0, 0.0, z, 1.0, 0.0, 0.0, 0.0]], 'pr7inpr7')
        self.assertEqual(certify.field_errors(rec, VOL), [])
        self.assertTrue(certify.check_record(rec, VOL)['ok'])
        rec['family'] = 'platonic'
        self.assertTrue(certify.field_errors(rec, VOL))


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
        doc = read_json(RECORDS)
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
        doc = read_json(RECORDS)
        recs = doc['records']
        sample = recs[::max(1, len(recs) // 12)][:12]
        for r in sample:
            self.assertTrue(certify.check_record(r, VOL)['ok'], r['id'])


if __name__ == '__main__':
    unittest.main(verbosity=1)
