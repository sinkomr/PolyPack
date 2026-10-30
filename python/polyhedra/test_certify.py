#!/usr/bin/env python3
"""Tests of the polyhedra certifier (python/polyhedra/certify.py and the vendored certify_general.py).

Run: python3 python/polyhedra/test_certify.py. Standard library only. Covers the published-field checks, the display
rule, adversarial configurations (overlaps and protrusions of 3e-7, coincident pieces, zero and non-numeric
quaternions, strings, booleans, NaN), PolyPack's prisms and antiprisms with 7, 9, 10 and 11 sides (exact checks of the
solids in their number fields, valid, overlapping and protruding packings), PolyPack's bipyramids and trapezohedra
(exact midsphere and insphere, closed-form volumes, face-to-face pairs 1e-7 apart that certify and 2e-7 overlaps and
protrusions that do not), agreement with the TypeScript validator on the near-contact cases of
fixtures/crosscheck.json, and a field check of every record of data/polyhedra/records.json.
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
        self.assertEqual(len(catalogue.solids()), 94)
        self.assertEqual(len(catalogue.PROBLEMS), 150)
        self.assertEqual(len(catalogue.WIKI_PROBLEMS), 86)
        new = [c for c in catalogue.PROBLEMS if c not in catalogue.WIKI_PROBLEMS]
        self.assertEqual(new[:8], ['pr7inpr7', 'pr7incub', 'pr9inpr9', 'pr9incub', 'pr10inpr10', 'pr10incub',
                                   'pr11inpr11', 'pr11incub'])
        self.assertEqual(len(new), 64)
        self.assertEqual(catalogue.PROBLEMS['ap11incub'], ('antiprism11', 'cube', 'prisms'))
        self.assertEqual(catalogue.PROBLEMS['ap9inap9'], ('antiprism9', 'antiprism9', 'prisms'))
        self.assertEqual(catalogue.PROBLEMS['pr10l15incub'], ('prism10_l15', 'cube', 'prisms'))
        self.assertEqual(catalogue.parse_id('polyhedra/ap10incub/100'), ('ap10incub', 100))
        self.assertIsNone(catalogue.parse_id('polyhedra/pr13incub/2'))
        self.assertEqual(sorted(cg.EXACT), sorted(n for n, *_ in catalogue.all_solids()))

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

    def test_every_new_solid_in_a_cube(self):
        # all 20: two pieces stacked along z, 2e-7 apart, in a cube 4e-7 wider than they need (2e-7 to the binding
        # walls): certified; the upper piece moved 3e-7 down (an overlap of 1e-7): refused; a cube 2e-7 narrower
        # than they need (a protrusion of 1e-7): refused
        # (the bipyramids and trapezohedra have their own pairs below: stacked along z they meet apex to apex)
        names = [n for n, _, fam, _ in catalogue.solids()[56:] if fam not in ('bipyramid', 'trapezohedron')]
        self.assertEqual(len(names), 20)
        for name in names:
            V = cg.get_solid(name).Vf
            ex, ey, ez = (max(abs(v[k]) for v in V) for k in range(3))
            z = ez + 1e-7
            half = max(ex, ey, 2 * ez + 1e-7)
            pieces = [[0.0, 0.0, -z, 1.0, 0.0, 0.0, 0.0], [0.0, 0.0, z, 1.0, 0.0, 0.0, 0.0]]
            c = certify.certify_config(name, 'cube', 2 * half + 4e-7, pieces)
            self.assertTrue(c['ok'], name)
            self.assertGreater(c['min_pair_gap'], 1.9e-7, name)
            self.assertGreater(c['min_wall_slack'], 1.9e-7, name)
            over = copy.deepcopy(pieces)
            over[1][2] -= 3e-7
            self.assertTrue(certify.certify_config(name, 'cube', 2 * half + 4e-7, over)['failed_pairs'], name)
            self.assertTrue(certify.certify_config(name, 'cube', 2 * half - 2e-7, pieces)['failed_walls'], name)

    def test_field_checks_of_a_new_record(self):
        z = 0.5 + 1e-7
        rec = record_of(2 + 6e-7, [[0.0, 0.0, -z, 1.0, 0.0, 0.0, 0.0], [0.0, 0.0, z, 1.0, 0.0, 0.0, 0.0]], 'pr7inpr7')
        self.assertEqual(certify.field_errors(rec, VOL), [])
        self.assertTrue(certify.check_record(rec, VOL)['ok'])
        rec['family'] = 'platonic'
        self.assertTrue(certify.field_errors(rec, VOL))
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
        self.assertEqual(sorted(exact), sorted(n for n, *_ in catalogue.all_solids()))
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


class KeepSearch(unittest.TestCase):
    """build_records.py --keep with --search: a certified result replaces a PolyPack record by any gain and a record
    of the wiki's only by more than 1e-5 relative; the other lines of the configuration file stay as they were; a
    result with pieces deleted from a larger P (from_P) takes that record's lineage, also when the same run replaces
    it."""

    def test_replacements(self):
        import shutil
        import tempfile
        import build_records as B
        a = 0.5 + 0.5e-7
        two = [[-a, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], [a, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]]
        four = [[x, y, 0.0, 1.0, 0.0, 0.0, 0.0] for x in (-a, a) for y in (-a, a)]
        _, eight = cubes8()

        def kept(pieces, s, ours, wiki_s):
            r = record_of(s, copy.deepcopy(pieces))
            r.update(found_by='PolyPack research' if ours else 'Alejandro Zarzuelo',
                     sources=['polypack'] if ours else ['wiki'], source='test',
                     origin={'file': f'records/cubincub/cubincub_n{len(pieces):02d}.json', 'date': '2026-10-15'},
                     wiki={'s_full': wiki_s, 'url': B.catalogue_wiki('cubincub', len(pieces))})
            if ours:
                r['credit'] = 'PolyPack research'
            return r

        old = [kept(two, 2.001, False, 2.001), kept(four, 2 + 5e-7, True, 2.1),
               kept(eight, 2 + 4e-7 + 1e-5, False, 2 + 4e-7 + 1e-5)]
        d = tempfile.mkdtemp()
        try:
            B.write_configs(os.path.join(d, 'configs'), old)
            keep = os.path.join(d, 'records.json')
            with open(keep, 'w') as f:
                json.dump({'sources': {'wiki': {}, 'polypack': {}}, 'conventions': {}, 'records': old}, f)
            with open(os.path.join(d, 'configs', 'cubincub.jsonl'), 'rb') as f:
                before = f.read().split(b'\n')
            res = os.path.join(d, 'polish')
            os.makedirs(res)

            def result(pieces, s, record_file=None, **more):
                n = len(pieces)
                with open(os.path.join(res, f'cubincub_n{n:02d}.json'), 'w') as f:
                    json.dump({'code': 'cubincub', 'P': n, 's_full': s, 'pieces': pieces, 'method': 'test polish',
                               'start': 'warm', 'record_file': record_file or f'records/cubincub/cubincub_n{n:02d}.json',
                               'date': '2026-10-27', **more}, f)

            for pieces, s in ((two, 2 + 3e-7), (four, 2 + 4e-7), (eight, 2 + 4e-7)):
                result(pieces, s)
            self.assertEqual(B.keep_and_add(keep, None, [res], 100, 1, False), 0)
            doc = certify.load_records(keep)
            r2, r4, r8 = doc['records']
            # the wiki's record of P = 2 gains 5e-4: replaced, credited to the wiki's packing it started from
            self.assertEqual(r2['score_cert'], 2 + 3e-7)
            self.assertEqual(r2['found_by'], 'PolyPack research')
            self.assertEqual(r2['sources'], ['polypack', 'wiki'])
            self.assertEqual(r2['origin'], {'file': 'polish/cubincub_n02.json', 'date': '2026-10-27',
                                            'start': 'records/cubincub/cubincub_n02.json'})
            self.assertEqual(r2['wiki']['s_full'], 2.001)
            self.assertEqual(r2['wiki']['file'], 'records/cubincub/cubincub_n02.json')
            self.assertIn('Alejandro Zarzuelo, records/cubincub/cubincub_n02.json', r2['credit'])
            # a PolyPack record is replaced by a gain of 5e-8; the wiki's of P = 8 not by 5e-6 (below 1e-5)
            self.assertEqual((r4['score_cert'], r4['credit']), (2 + 4e-7, 'PolyPack research'))
            self.assertEqual((r8['score_cert'], r8['found_by']), (2 + 4e-7 + 1e-5, 'Alejandro Zarzuelo'))
            with open(os.path.join(d, 'configs', 'cubincub.jsonl'), 'rb') as f:
                after = f.read().split(b'\n')
            self.assertEqual(after[2], before[2])
            for r in doc['records']:
                self.assertEqual(certify.field_errors(r, VOL), [], r['id'])
                self.assertTrue(certify.check_record(r, VOL)['ok'], r['id'])
            # pieces deleted from the wiki's P = 8 give P = 4, and from that new P = 4 (the same run) P = 2
            os.remove(os.path.join(res, 'cubincub_n08.json'))
            result(four, 2 + 3.5e-7, 'records/cubincub/cubincub_n08.json', from_P=8, runs=['pieces deleted'])
            result(two, 2 + 2e-7, 'polish/cubincub_n04.json', from_P=4, runs=['pieces deleted'])
            self.assertEqual(B.keep_and_add(keep, None, [res], 100, 1, False), 0)
            r2, r4, _ = certify.load_records(keep)['records']
            self.assertEqual((r4['score_cert'], r2['score_cert']), (2 + 3.5e-7, 2 + 2e-7))
            self.assertEqual(r4['origin'], {'file': 'polish/cubincub_n04.json', 'date': '2026-10-27',
                                            'start': 'records/cubincub/cubincub_n08.json', 'runs': ['pieces deleted']})
            self.assertEqual(r2['origin']['start'], 'polish/cubincub_n04.json')
            for r in (r2, r4):
                self.assertEqual(r['sources'], ['polypack', 'wiki'])
                self.assertIn('Alejandro Zarzuelo, records/cubincub/cubincub_n08.json', r['credit'])
                self.assertTrue(certify.check_record(r, VOL)['ok'], r['id'])
            # a result that did not start from the record it names, or names a smaller P, is refused
            for n in (2, 4):
                os.remove(os.path.join(res, f'cubincub_n{n:02d}.json'))
            result(eight, 2 + 3e-7, 'records/other.json')
            with self.assertRaises(ValueError):
                B.keep_and_add(keep, None, [res], 100, 1, False)
            result(eight, 2 + 3e-7, from_P=4)
            with self.assertRaises(ValueError):
                B.keep_and_add(keep, None, [res], 100, 1, False)
        finally:
            shutil.rmtree(d)


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
