#!/usr/bin/env python3
"""Tests of the polyhedra certifier (python/polyhedra/certify.py and the vendored certify_general.py).

Run: python3 python/polyhedra/test_certify.py. Standard library only. Covers the published-field checks, the display
rule, adversarial configurations (overlaps and protrusions of 3e-7, coincident pieces, zero and non-numeric
quaternions, strings, booleans, NaN), agreement with the TypeScript validator on the near-contact cases of
fixtures/crosscheck.json, a field check of every record of data/polyhedra/records.json, and PolyPack's bipyramids
and trapezohedra (exact midsphere and insphere, closed-form volumes, face-to-face pairs 1e-7 apart that certify and
2e-7 overlaps and protrusions that do not).
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


DUALS = [f'bipyramid{n}' for n in catalogue.BIPYRAMID_K] + [f'trapezohedron{n}' for n in catalogue.TRAPEZOHEDRON_K]


def quat_of(R):
    """A unit quaternion [w, x, y, z] of a rotation matrix (Shepperd's method)."""
    t = R[0][0] + R[1][1] + R[2][2]
    if t > 0:
        r = math.sqrt(1 + t) * 2
        return [r / 4, (R[2][1] - R[1][2]) / r, (R[0][2] - R[2][0]) / r, (R[1][0] - R[0][1]) / r]
    if R[0][0] > R[1][1] and R[0][0] > R[2][2]:
        r = math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2
        return [(R[2][1] - R[1][2]) / r, r / 4, (R[0][1] + R[1][0]) / r, (R[0][2] + R[2][0]) / r]
    if R[1][1] > R[2][2]:
        r = math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2
        return [(R[0][2] - R[2][0]) / r, (R[0][1] + R[1][0]) / r, r / 4, (R[1][2] + R[2][1]) / r]
    r = math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2
    return [(R[1][0] - R[0][1]) / r, (R[0][2] + R[2][0]) / r, (R[1][2] + R[2][1]) / r, r / 4]


def mirror_pair(code, g, w):
    """Two pieces face to face: piece 1 is the mirror image of piece 0 in the plane of its face 0, moved off it by g along
    the face normal N (g < 0: into it). Both families have the mirror y -> -y, so the image is the proper copy
    R K + (2b + g) N with R = (I - 2 N N^T)(I - 2 e_y e_y^T); the faces coincide at g = 0. The container is the smallest
    with wall gap w (w < 0: the pieces stick out by -w)."""
    piece, container, _ = catalogue.PROBLEMS[code]
    S, C = certify.cg.get_solid(piece), certify.cg.get_solid(container)
    N = S.Nf[0]
    b = sum(N[k] * S.Vf[S.faces[0][0]][k] for k in range(3))
    R = [[(1.0 if i == j else 0.0) - 2 * N[i] * N[j] for j in range(3)] for i in range(3)]
    for row in R:
        row[1] = -row[1]
    q = quat_of(R)
    d = (2 * b + g) / 2
    pieces = [[-d * N[0], -d * N[1], -d * N[2], 1.0, 0.0, 0.0, 0.0], [d * N[0], d * N[1], d * N[2]] + q]
    Rq = [[float(x) for x in row] for row in certify.cg.rot(q)]
    mid = lambda e: (e[0] + e[1]) / 2 / certify.cg.ONE           # a fixed-point enclosure's midpoint
    # the container's faces n . x = b with unit n (C.N are exact normals of any length, C.B their offsets)
    walls = [(n, mid(B) / math.sqrt(sum(mid(e) ** 2 for e in m))) for n, m, B in zip(C.Nf, C.N, C.B)]
    s = 0.0
    for k, c in enumerate(pieces):
        for v in S.Vf:
            x = v if k == 0 else [sum(Rq[i][j] * v[j] for j in range(3)) for i in range(3)]
            x = [x[i] + c[i] for i in range(3)]
            for n, off in walls:
                s = max(s, (sum(n[i] * x[i] for i in range(3)) + w) / off)
    return piece, container, s, pieces


class Duals(unittest.TestCase):
    """PolyPack's bipyramids and trapezohedra: exact solids, a certified packing per family, adversarial ones."""

    def test_solids_are_exact_canonical_duals(self):
        import algebraic as A
        for name in DUALS:
            S = certify.cg.get_solid(name)
            self.assertIn('insphere', S.check, name)
            F, U = S.F, S.U
            n = int(name.lstrip('abcdefghijklmnopqrstuvwxyz'))
            t = math.pi / n
            # every edge line at the same distance rho from the centre (exactly, in Q(alpha)), touching inside the edge:
            # rho^2 |d|^2 = |a|^2 |d|^2 - (a.d)^2 for the edge a + u d, 0 < u < 1
            q0 = d0 = None
            for i, j in S.edges:
                a, d = U[i], A.vsub(F, U[j], U[i])
                aa, dd, ad = A.vdot(F, a, a), A.vdot(F, d, d), A.vdot(F, a, d)
                num = F.sub(F.mul(aa, dd), F.mul(ad, ad))
                if q0 is None:
                    q0, d0 = num, dd
                self.assertTrue(F.is_zero(F.sub(F.mul(num, d0), F.mul(q0, dd))), name)
                self.assertEqual(F.sign(F.scale(ad, -1)), 1, name)
                self.assertEqual(F.sign(F.add(dd, ad)), 1, name)
            rho2 = float(F.interval(q0).lo) / float(F.interval(d0).lo)
            # the midradius of the unit-edge n-prism, 1/(2 sin(pi/n)), or n-antiprism, 1/(4 sin(pi/2n)) [CALC]
            rho = 1 / (2 * math.sin(t)) if name.startswith('bipyramid') else 1 / (4 * math.sin(t / 2))
            self.assertAlmostEqual(math.sqrt(rho2) / rho, 1, places=12, msg=name)
            # volume: MathWorld's canonical dipyramid (prism edge 1) and trapezohedron (short edge 1, here
            # 1/sqrt(1 + 2 cos(pi/n))) [EST]
            c = math.cos(t)
            if name.startswith('bipyramid'):
                vol = n / (12 * math.sin(t) ** 3 * c)
            else:
                h = t / 2
                vol = n / math.tan(h) / math.sin(h) ** 2 * (2 * c + 1) / (24 * math.sqrt(2 + 2 * c)) / (1 + 2 * c) ** 1.5
            self.assertAlmostEqual(VOL[name] / vol, 1, places=12, msg=name)

    def test_catalogue_matches_the_exact_file(self):
        exact = read_json(os.path.join(HERE, 'solids_exact.json'))
        self.assertEqual(sorted(exact), sorted(n for n, *_ in catalogue.solids()))
        self.assertEqual(len(catalogue.PROBLEMS), 122)
        self.assertEqual(catalogue.PROBLEMS['bp5incub'], ('bipyramid5', 'cube', 'bipyramids'))
        self.assertEqual(catalogue.PROBLEMS['tz11intz11'], ('trapezohedron11', 'trapezohedron11', 'trapezohedra'))
        self.assertNotIn('bp4inbp4', catalogue.PROBLEMS)
        self.assertNotIn('tz3incub', catalogue.PROBLEMS)

    def test_face_to_face_pairs(self):
        for code in ('bp5inbp5', 'bp12incub', 'tz4incub', 'tz11intz11'):
            piece, container, s, p = mirror_pair(code, 1e-7, 1e-7)
            c = certify.certify_config(piece, container, s, p)
            self.assertTrue(c['ok'], code)
            self.assertAlmostEqual(c['min_pair_gap'] / 1e-7, 1, places=3, msg=code)
            self.assertGreater(c['min_wall_slack'], 0.9e-7, code)
            # faces overlapping by 2e-7: no separating plane exists
            c = certify.certify_config(*mirror_pair(code, -2e-7, 1e-7))
            self.assertFalse(c['ok'], code)
            self.assertEqual(c['failed_pairs'], [[0, 1]], code)
            self.assertFalse(c['failed_walls'], code)
            # sticking out of the container by 2e-7
            c = certify.certify_config(*mirror_pair(code, 1e-7, -2e-7))
            self.assertFalse(c['ok'], code)
            self.assertTrue(c['failed_walls'], code)
            self.assertFalse(c['failed_pairs'], code)

    def test_a_valid_record_of_each_family(self):
        for code in ('bp7incub', 'tz6intz6'):
            r = record_of(*mirror_pair(code, 1e-7, 1e-7)[2:], code=code)
            self.assertEqual(self.check(r), [], code)
            self.assertTrue(certify.check_record(r, VOL)['ok'], code)

    def check(self, r):
        return certify.field_errors(r, VOL)


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
