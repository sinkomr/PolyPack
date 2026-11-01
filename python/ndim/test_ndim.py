#!/usr/bin/env python3
"""Tests of the nD catalogue and certifier (python/ndim). Standard library only.

Run: python3 python/ndim/test_ndim.py            (the fast set, about 40 s)
     NDIM_SLOW=1 python3 python/ndim/test_ndim.py   (adds the largest packings and the rebuild of the fixtures, about 90 s)

Covers: the exact proof of every catalogue entry (counts, unit edges, complete facet lists) and that tampered data is
caught; that the generated TypeScript data holds the same floats; exactly orthogonal rational Cayley rotations; pose
conversion with its refusals (reflections, non-orthonormal matrices); malformed input; every fixture of
packages/ndim/test/fixtures/packings.json certified (or refused) as expected, with clearance 0 and 1e-7; and
adversarial configurations (pieces overlapping, touching and separated by 1e-9, a piece out by 1e-9, coincident pieces)."""
import copy
import json
import math
import os
import random
import re
import sys
import time
import unittest
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue as CAT  # noqa: E402
import certify as C  # noqa: E402
import exact as X  # noqa: E402
import floatgeom as G  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
FIXTURES = os.path.join(ROOT, 'packages', 'ndim', 'test', 'fixtures', 'packings.json')
TS_DATA = os.path.join(ROOT, 'packages', 'ndim', 'src', 'data')
SLOW = bool(os.environ.get('NDIM_SLOW'))


def det_exact(M):
    n = len(M)
    A = [[Fraction(x) for x in r] for r in M]
    out = Fraction(1)
    for c in range(n):
        p = next((r for r in range(c, n) if A[r][c] != 0), None)
        if p is None:
            return Fraction(0)
        if p != c:
            A[c], A[p] = A[p], A[c]
            out = -out
        out *= A[c][c]
        for r in range(c + 1, n):
            f = A[r][c] / A[c][c]
            A[r] = [x - f * y for x, y in zip(A[r], A[c])]
    return out


class Catalogue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = CAT.load()

    def test_listing(self):
        codes = [e['code'] for e in self.doc['polytopes']]
        self.assertEqual(codes, self.doc['codes'])
        self.assertEqual(set(codes), set(CAT.LITERATURE))
        self.assertEqual(len(codes), 34)
        for d in range(4, 11):
            for n in ('simplex', 'cube', 'ortho'):
                self.assertIn(f'{d}:{n}', codes)
            self.assertEqual(f'{d}:demi' in codes, d >= 5)
        for c in ('4:24cell', '4:120cell', '4:600cell', '6:221', '6:122', '7:321', '8:421'):
            self.assertIn(c, codes)

    def test_every_entry_is_proved(self):
        for e in self.doc['polytopes']:
            t = time.time()
            res = CAT.verify(e)
            self.assertEqual((res['V'], res['E'], res['F']), CAT.LITERATURE[e['code']])
            if time.time() - t > 3:
                print(f"  {e['code']}: {time.time() - t:.1f} s")

    def test_tampered_data_is_refused(self):
        e = next(x for x in self.doc['polytopes'] if x['code'] == '5:demi')

        def bad(mut, msg):
            f = copy.deepcopy(e)
            mut(f)
            with self.assertRaises(AssertionError, msg=msg):
                CAT.verify(f)
        bad(lambda f: f['V'][0].__setitem__(0, f['V'][0][0] + 1), 'moved vertex')
        bad(lambda f: f['V'].pop(), 'missing vertex')
        bad(lambda f: f['F'].pop(), 'missing facet')
        bad(lambda f: f['F'].append(list(f['F'][0])), 'repeated facet')
        bad(lambda f: f['F'][0].__setitem__(f['d'], f['F'][0][f['d']] + 1), 'facet offset moved out')
        bad(lambda f: f['F'][0].__setitem__(f['d'], f['F'][0][f['d']] - 1), 'facet offset moved in')
        bad(lambda f: f.__setitem__('den', f['den'] * 2), 'wrong scale: edges are not 1')
        bad(lambda f: f['rad'].__setitem__(0, 3), 'wrong radicand')
        # a 6-cube as the 5-demicube's vertex set is not a demicube
        bad(lambda f: f.__setitem__('V', [v for v in f['V']] + [[1, 1, 1, 1, 1]]), 'extra vertex')
        q = copy.deepcopy(next(x for x in self.doc['polytopes'] if x['code'] == '4:600cell'))
        q['V'][5][1] += 1
        with self.assertRaises(AssertionError):
            CAT.verify(q)

    def test_a_facet_repeated_at_another_scale_is_refused(self):
        """A scaled copy of a facet in place of another is the same count of distinct lists but one half-space too few."""
        by = {x['code']: x for x in self.doc['polytopes']}
        for code in ('4:cube', '5:demi', '6:221', '4:24cell', '4:600cell', '7:321'):
            e = by[code]
            for mode in ({}, {'facet_sample': 4}):
                f = copy.deepcopy(e)
                f['F'][0] = [2 * x for x in f['F'][1]]
                with self.assertRaises(AssertionError, msg=f'{code} {mode}'):
                    CAT.verify(f, **mode)
                f = copy.deepcopy(e)
                f['F'][0] = [3 * x for x in f['F'][1]]
                with self.assertRaises(AssertionError, msg=f'{code} x3 {mode}'):
                    CAT.verify(f, **mode)
        # reordering is not a change (the sampled mode on the largest entry is what the fast tests use)
        f = copy.deepcopy(by['5:demi'])
        f['F'].reverse()
        f['V'].reverse()
        CAT.verify(f)
        CAT.verify(copy.deepcopy(by['4:600cell']), facet_sample=8)

    def test_float_data_of_the_typescript_package_is_current(self):
        pat = re.compile(r'code:\s*"([^"]+)",\s*V:\s*\[([^\]]*)\],\s*N:\s*\[([^\]]*)\],\s*b:\s*\[([^\]]*)\]')
        seen = {}
        for fn in sorted(os.listdir(TS_DATA)):
            if fn.startswith('d'):
                with open(os.path.join(TS_DATA, fn)) as fh:
                    text = fh.read()
                for code, V, N, b in pat.findall(text):
                    seen[code] = [[float(x) for x in s.replace('\n', ' ').split(',') if x.strip()] for s in (V, N, b)]
        self.assertEqual(set(seen), set(CAT.LITERATURE))
        for code, (V, N, b) in seen.items():
            P = CAT.get(code)
            flat = [c for v in P.vertices_float() for c in v]
            self.assertEqual(V, flat, code)
            nf, bf = P.facets_float()
            self.assertEqual(N, [c for n in nf for c in n], code)
            self.assertEqual(b, bf, code)

    def test_float_values_agree_with_independent_formulas(self):
        # unit edges and the circumradius of the regular families from closed forms
        for d in range(4, 11):
            r = math.sqrt(d / (2 * (d + 1)))                     # circumradius of the unit-edge simplex
            P = CAT.get(f'{d}:simplex')
            self.assertAlmostEqual(max(math.sqrt(sum(c * c for c in v)) for v in P.vertices_float()), r, places=13)
            self.assertAlmostEqual(min(CAT.get(f'{d}:ortho').facets_float()[1]), 1 / math.sqrt(2 * d), places=13)
            self.assertAlmostEqual(min(CAT.get(f'{d}:cube').facets_float()[1]), 0.5, places=14)
        P = CAT.get('4:600cell')
        self.assertAlmostEqual(max(math.sqrt(sum(c * c for c in v)) for v in P.vertices_float()), (1 + 5 ** 0.5) / 2, places=13)
        self.assertAlmostEqual(CAT.get('4:24cell').circumradius2_up() / X.ONE, 1.0, places=12)


class Rotations(unittest.TestCase):
    def test_cayley_is_exactly_orthogonal_with_determinant_one(self):
        rng = random.Random(1)
        for d in range(4, 11):
            m = d * (d - 1) // 2
            for flip in (0, 0b11, 0b110 if d > 3 else 0):
                params = [Fraction(rng.uniform(-3, 3)) for _ in range(m)]
                R = C.cayley_exact(params, d, flip)
                self.assertTrue(C.is_orthogonal(R), (d, flip))
                self.assertEqual(det_exact(R), 1)

    def test_agrees_with_the_float_matrix(self):
        rng = random.Random(2)
        for d in (4, 7, 10):
            p = [rng.uniform(-2, 2) for _ in range(d * (d - 1) // 2)]
            R = C.cayley_exact([Fraction(x) for x in p], d, 0b101 if d == 4 else 0b1001)
            Rf = G.cayley_matrix(p, d, 0b101 if d == 4 else 0b1001)
            self.assertLess(max(abs(float(R[i][j]) - Rf[i][j]) for i in range(d) for j in range(d)), 1e-12)

    def test_pose_of_matrix_round_trips_and_refuses(self):
        rng = random.Random(3)
        for d in (4, 6, 9):
            p = [rng.uniform(-1, 1) for _ in range(d * (d - 1) // 2)]
            R = G.cayley_matrix(p, d)
            pose = G.pose_of_matrix([0.0] * d, R)
            R2 = G.matrix_of_pose(pose, d)
            self.assertLess(max(abs(R[i][j] - R2[i][j]) for i in range(d) for j in range(d)), 1e-9)
        d = 5
        I = G.eye(d)
        refl = [r[:] for r in I]
        refl[0][0] = -1.0
        with self.assertRaisesRegex(ValueError, 'reflection'):
            G.pose_of_matrix([0.0] * d, refl)
        skew = [r[:] for r in I]
        skew[0][1] = 1e-6
        with self.assertRaisesRegex(ValueError, 'orthonormal'):
            G.pose_of_matrix([0.0] * d, skew)
        nan = [r[:] for r in I]
        nan[2][2] = float('nan')
        with self.assertRaisesRegex(ValueError, 'finite'):
            G.pose_of_matrix([0.0] * d, nan)
        half = [r[:] for r in I]
        half[0][0] = half[1][1] = -1.0
        self.assertEqual(G.cayley_of_matrix(half)[1], 0b11)


PROB = {'d': 4, 'piece': '4:cube', 'container': '4:cube'}
Z = [0.0] * 6


class Malformed(unittest.TestCase):
    def refused(self, config, problem=PROB, regex=None):
        with self.assertRaisesRegex(C.CertError, regex or '.'):
            C.certify_config(problem, config)

    def test_configs(self):
        pose = [0.0] * 4 + Z
        self.refused(None, regex='config must be')
        self.refused({'pieces': [pose]}, regex='s must be')
        self.refused({'s': 0, 'pieces': [pose]}, regex='s must be')
        self.refused({'s': -1.0, 'pieces': [pose]}, regex='s must be')
        self.refused({'s': float('nan'), 'pieces': [pose]}, regex='finite')
        self.refused({'s': float('inf'), 'pieces': [pose]}, regex='finite')
        self.refused({'s': True, 'pieces': [pose]}, regex='JSON number')
        self.refused({'s': '2', 'pieces': [pose]}, regex='JSON number')
        self.refused({'s': 2e6, 'pieces': [pose]}, regex='s must be')
        self.refused({'s': 2.0}, regex='pieces')
        self.refused({'s': 2.0, 'pieces': []}, regex='pieces')
        self.refused({'s': 2.0, 'pieces': [pose[:-1]]}, regex='pieces\\[0\\]')
        self.refused({'s': 2.0, 'pieces': [pose + [0, 0]]}, regex='pieces\\[0\\]')
        self.refused({'s': 2.0, 'pieces': ['x']}, regex='array')
        self.refused({'s': 2.0, 'pieces': [[0.0, 0.0, 0.0, float('nan')] + Z]}, regex='finite')
        self.refused({'s': 2.0, 'pieces': [[0.0, 0.0, 0.0, '0'] + Z]}, regex='JSON number')
        self.refused({'s': 2.0, 'pieces': [[0.0, 0.0, 0.0, None] + Z]}, regex='JSON number')
        self.refused({'s': 2.0, 'pieces': [[1e5, 0.0, 0.0, 0.0] + Z]}, regex='centre')
        self.refused({'s': 2.0, 'pieces': [[0.0] * 4 + [99.0] + Z[1:]]}, regex='Cayley')
        self.refused({'s': 2.0, 'pieces': [pose + [1]]}, regex='even number')       # a flip of one axis: a reflection
        self.refused({'s': 2.0, 'pieces': [pose + [0b110000]]}, regex='flip')
        self.refused({'s': 2.0, 'pieces': [pose + [1.5]]}, regex='flip')
        self.refused({'s': 2.0, 'pieces': [pose + [True]]}, regex='flip')
        # an integral float is the same JSON number as the integer (as in the TypeScript validator): accepted, equal results
        for flip in (0, 3, 6):
            a = C.certify_config(PROB, {'s': 3.0, 'pieces': [pose + [flip]]})
            b = C.certify_config(PROB, {'s': 3.0, 'pieces': [pose + [float(flip)]]})
            self.assertTrue(a['ok'] and b['ok'])
            self.assertEqual(a['min_wall_gap'], b['min_wall_gap'])
        self.refused({'s': 2.0, 'pieces': [pose + [float('inf')]]}, regex='flip|finite')
        self.refused({'s': 2.0, 'pieces': [pose + [1.0]]}, regex='even number')

    def test_problems(self):
        cfg = {'s': 2.0, 'pieces': [[0.0] * 4 + Z]}
        self.refused(cfg, {'d': 3, 'piece': '4:cube', 'container': '4:cube'}, 'd must be')
        self.refused(cfg, {'d': 11, 'piece': '4:cube', 'container': '4:cube'}, 'd must be')
        self.refused(cfg, {'d': True, 'piece': '4:cube', 'container': '4:cube'}, 'd must be')
        self.refused(cfg, {'d': 4, 'piece': '5:cube', 'container': '4:cube'}, 'not 4-dimensional')
        self.refused(cfg, {'d': 4, 'piece': '4:nope', 'container': '4:cube'}, 'unknown')
        self.refused(cfg, {'d': 4, 'piece': '4:cube', 'container': 7}, 'container must be')
        self.refused(cfg, 'nope', 'problem must be')
        # a ball's pose is its centre only
        self.refused(cfg, {'d': 4, 'piece': 'ball', 'container': '4:cube'}, 'its centre')


class Fixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURES) as f:
            cls.fixtures = json.load(f)['fixtures']

    def test_every_fixture(self):
        self.assertGreater(len(self.fixtures), 80)
        t0 = time.time()
        counts = {'exact': 0, 'refused': 0, 'skipped': 0}
        for f in self.fixtures:
            if f['slow'] and not SLOW:
                counts['skipped'] += 1
                continue
            e = f['expect']
            r = C.certify_config(f['problem'], f['config'])
            self.assertEqual(r['ok'], e['exact'], f['name'])
            if r['ok']:
                self.assertGreater(r['min_wall_gap'], 0, f['name'])
                self.assertGreater(r['min_pair_gap'], 0, f['name'])
            # the 1e-7 clearance of the records
            r1 = C.certify_config(f['problem'], f['config'], 1e-7) if (r['ok'] and (e['exact_clearance'] or len(f['config']['pieces']) < 40)) else None
            if r1 is not None:
                self.assertEqual(r1['ok'], e['exact_clearance'], f['name'])
            counts['exact' if r['ok'] else 'refused'] += 1
        print(f"  {counts['exact']} fixtures certified, {counts['refused']} refused, {counts['skipped']} slow ones skipped "
              f"({time.time() - t0:.1f} s)")
        self.assertGreater(counts['refused'], 8)

    def test_fixture_expectations_cover_the_adversarial_cases(self):
        names = {f['name'] for f in self.fixtures}
        for n in ('tesseracts_overlap_1e-9', 'tesseracts_touching', 'tesseracts_gap_1e-9', 'cube_out_by_1e-9', 'balls17_in_cube2_4D'):
            self.assertIn(n, names)

    @unittest.skipUnless(SLOW, 'slow: rebuilds the fixtures (bisection of the touching pairs)')
    def test_a_deterministic_rebuild(self):
        import make_fixtures
        with open(FIXTURES) as fh:       # compared as data: the committed file is formatted by prettier
            self.assertEqual({'version': 1, 'gap': make_fixtures.GAP, 'fixtures': make_fixtures.build()}, json.load(fh))


class Adversarial(unittest.TestCase):
    def cfg(self, s, *centres, d=4):
        return {'s': s, 'pieces': [list(c) + [0.0] * (d * (d - 1) // 2) for c in centres]}

    def test_coincident_pieces_overlap(self):
        r = C.certify_config(PROB, self.cfg(5.0, [0, 0, 0, 0], [0, 0, 0, 0]))
        self.assertFalse(r['ok'])
        self.assertEqual(r['failures'], [('pair', 0, 1)])

    def test_gaps_of_1e_9(self):
        for gap, ok in ((-1e-9, False), (0.0, False), (1e-9, True), (1e-12, True)):
            r = C.certify_config(PROB, self.cfg(5.0, [0, 0, 0, 0], [1 + gap, 0, 0, 0]))
            self.assertEqual(r['ok'], ok, gap)
        # strict, but under the 1e-7 clearance
        r = C.certify_config(PROB, self.cfg(5.0, [0, 0, 0, 0], [1 + 1e-9, 0, 0, 0]), clearance=1e-7)
        self.assertFalse(r['ok'])
        r = C.certify_config(PROB, self.cfg(5.0, [0, 0, 0, 0], [1 + 2e-7, 0, 0, 0]), clearance=1e-7)
        self.assertTrue(r['ok'])

    def test_walls(self):
        for s, ok in ((1 - 2e-9, False), (1.0, False), (1 + 2e-9, True)):
            self.assertEqual(C.certify_config(PROB, self.cfg(s, [0, 0, 0, 0]))['ok'], ok, s)

    def test_a_pose_of_a_ball_container(self):
        P = {'d': 5, 'piece': '5:cube', 'container': 'ball'}
        circ = math.sqrt(5) / 2
        cfg = {'s': 2 * circ * (1 + 1e-9), 'pieces': [[0.0] * 5 + [0.0] * 10]}
        self.assertTrue(C.certify_config(P, cfg)['ok'])
        cfg['s'] = 2 * circ * (1 - 1e-9)
        self.assertFalse(C.certify_config(P, cfg)['ok'])

    def test_a_wrong_plane_is_not_accepted(self):
        # the exact plane test decides by the inequality, whatever direction float arithmetic proposed
        P = CAT.get('4:cube')
        a = C.Placed(4, False, [0.0] * 10, 0)
        b = C.Placed(4, False, [1.0, 0, 0, 0] + [0.0] * 6, 1)
        XA, XB = (C.world_enc(p, P.vertex_enc()) for p in (a, b))
        touching = C.plane_test([10 ** 12, 0, 0, 0], XA, XB)                         # min - max = 0 up to the enclosures' width
        self.assertLessEqual(touching, 0)
        self.assertGreater(touching, -10 ** 14)
        self.assertLess(C.plane_test([0, 10 ** 12, 0, 0], XA, XB), 0)               # a plane along y does not separate them
        self.assertIsNone(C.exact_plane(XA, XB, [0.0, 1.0, 0.0, 0.0]))
        self.assertIsNone(C.exact_plane(XA, XB, [0.0, 0.0, 0.0, 0.0]))

    def test_rotated_pieces_are_certified_in_the_rotated_frame(self):
        # two 24-cells with the same rotation, face to face: 1e-9 apart certify, 1e-9 overlapping do not
        P = CAT.get('4:24cell')
        N, b = P.facets_float()
        rot = [0.3, -0.2, 0.1, 0.4, -0.5, 0.25]
        R = G.cayley_matrix(rot, 4)
        n = [sum(R[i][j] * N[0][j] for j in range(4)) for i in range(4)]
        for delta, ok in ((1e-9, True), (-1e-9, False)):
            t = [(2 * b[0] + delta) * x for x in n]
            r = C.certify_config({'d': 4, 'piece': '4:24cell', 'container': 'ball'}, {'s': 20.0, 'pieces': [[0.0] * 4 + rot, t + rot]})
            self.assertEqual(r['ok'], ok, delta)


class ImportedRecords(unittest.TestCase):
    """The wiki's records in data/ndim (build_records.py), certified again exactly: a sample of every dimension and of the
    pairs with big polytopes. (build_records.py certified every one when it built the file.)"""

    PICK = [('4', 'cube', 'cube', 16), ('4', '24cell', '600cell', 12), ('4', '120cell', '120cell', 7), ('4', '600cell', 'simplex', 20),
            ('4', 'simplex', 'ortho', 40), ('5', 'simplex', 'cube', 10), ('5', 'ortho', 'ortho', 32), ('6', 'cube', 'simplex', 24),
            ('6', 'cube', 'cube', 20)]

    @classmethod
    def setUpClass(cls):
        path = os.path.join(ROOT, 'data', 'ndim')
        cls.recs = {r['id']: r for r in json.load(open(os.path.join(path, 'records.json')))['records']}
        cls.path = path

    def config(self, r):
        f = os.path.join(self.path, 'configs', f"{r['d']}-{r['piece']}-{r['container']}.jsonl")
        with open(f, 'rb') as fh:
            fh.seek(r['config_at'][0])
            row = json.loads(fh.read(r['config_at'][1]))
        self.assertEqual(row['P'], r['P'])
        return row['config']

    def test_sample_is_certified_with_the_wikis_clearance(self):
        for d, a, b, P in self.PICK:
            r = self.recs[f'ndim/{d}/{a}/{b}/{P}']
            problem = {'d': int(d), 'piece': f'{d}:{a}', 'container': f'{d}:{b}'}
            res = C.certify_config(problem, self.config(r), clearance=0.0)
            self.assertTrue(res['ok'], (r['id'], res['failures']))
            # the wiki keeps 1e-7 between pieces and from the walls; a few pairs a hair below it after the conversion
            self.assertGreater(res['min_wall_gap'], 9.9e-8, r['id'])
            self.assertGreater(res['min_pair_gap'], 9e-8, r['id'])
            self.assertEqual(self.config(r)['s'], r['score_cert'])
            self.assertEqual(len(self.config(r)['pieces']), P)

    def test_a_tampered_record_is_refused(self):
        r = self.recs['ndim/4/cube/cube/16']
        problem = {'d': 4, 'piece': '4:cube', 'container': '4:cube'}
        cfg = copy.deepcopy(self.config(r))
        cfg['s'] = cfg['s'] - 1e-6
        self.assertFalse(C.certify_config(problem, cfg)['ok'])

    def test_counts(self):
        by_d = {}
        for r in self.recs.values():
            by_d[r['d']] = by_d.get(r['d'], 0) + 1
            self.assertEqual(r['status'], 'best_known')
            self.assertIn('Zarzuelo', r['credit'])
        # 36 pairs x 39, 9 x 31 and 9 x 23, less the four the certifier could not prove (docs/spaces/NDIM.md section 11)
        self.assertEqual(sum(by_d.values()), 1886)
        self.assertEqual(by_d, {4: 1403, 5: 278, 6: 205})


if __name__ == '__main__':
    unittest.main(verbosity=2)
