"""Adversarial tests for the rigorous torus certifier.

Run: python3 python/torus/test_certify_torus.py
"""

import math
import os
import random
import sys
import unittest
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import certify_torus as C  # noqa: E402

SQ3 = math.sqrt(3.0)
TRI_R = 1 / SQ3  # circumradius of the unit triangle
TRI_r = 1 / (2 * SQ3)


def rec(family, N, poses, eps=1e-12, **lat):
    if family in ("sq", "hex"):
        lattice = {"L": lat["L"]}
    else:
        lattice = {"b1": lat["b1"], "b2": lat["b2"]}
    out = {"family": family, "N": N, "P": len(poses), "lattice": lattice, "poses": poses, "eps": eps}
    if "score_cert" in lat:
        out["score_cert"] = lat["score_cert"]
    return out


def square_tile(L=1.0):
    # theta = pi/4 turns the vertex-up square into an axis-aligned one
    return rec("sq", 4, [[0.3, 0.2, math.pi / 4]], L=L)


def two_triangles(L=1.0, shift=0.0):
    up = [0.5, SQ3 / 6, 0.0]
    down = [1.0 - shift, SQ3 / 3 - shift * 0.0, math.pi]
    return rec("hex", 3, [up, down], L=L)


class ValidCases(unittest.TestCase):
    def test_square_tiling_touching(self):
        c = C.certify(square_tile(1.0))
        self.assertGreater(float(c["min_clearance_lb"]), 0)
        # score bound is L / (1 - eps), just above 1
        self.assertGreater(float(c["score_cert_upper"]), 1.0)
        self.assertLess(float(c["score_cert_upper"]), 1.0 + 1e-11)

    def test_disk_self_contact(self):
        c = C.certify(rec("sq", 0, [[0.0, 0.0, 0.0]], L=2.0))
        self.assertEqual(c["P"], 1)

    def test_disk_hex_lattice(self):
        C.certify(rec("hex", 0, [[1.0, 1.0, 0.0]], L=2.0))

    def test_disks_touching_across_the_boundary(self):
        # distance 2 inside the cell and 4 - 2 = 2 through the boundary
        C.certify(rec("sq", 0, [[0.5, 1.0, 0.0], [2.5, 1.0, 0.0]], L=4.0))

    def test_triangle_tiling_of_hex_torus(self):
        C.certify(two_triangles())

    def test_unreduced_basis_valid(self):
        # b2 - 1000 b1 = (0.3, 2.1) has length > 2: valid for unit disks
        C.certify(rec("free", 0, [[0.0, 0.0, 0.0]], b1=[2.5, 0.0], b2=[2500.3, 2.1]))

    def test_unreduced_basis_square_tiling(self):
        # b2 - 1000 b1 = (0, 1): the unit-square tiling with a very skewed basis
        C.certify(rec("free", 4, [[0.1, 0.1, math.pi / 4]], b1=[1.0, 0.0], b2=[1000.0, 1.0]))

    def test_claim_at_bound_accepted(self):
        r = square_tile(1.0)
        c = C.certify(r)
        r["score_cert"] = c["score_upper_float"]
        C.certify(r)

    def test_diamond_at_sqrt2(self):
        # theta = 0 square points a vertex up (a diamond); it needs L = sqrt(2)
        C.certify(rec("sq", 4, [[0.0, 0.0, 0.0]], L=math.sqrt(2.0) * (1 + 1e-15)))


class Overlaps(unittest.TestCase):
    def assertRejects(self, r, msg=None):
        with self.assertRaises(C.CertError, msg=msg):
            C.certify(r)

    def test_square_tile_too_small(self):
        self.assertRejects(square_tile(1.0 - 1e-9))

    def test_diamond_at_one(self):
        self.assertRejects(rec("sq", 4, [[0.0, 0.0, 0.0]], L=1.0))

    def test_disk_self_overlap_short_vector(self):
        self.assertRejects(rec("sq", 0, [[0.0, 0.0, 0.0]], L=2.0 - 1e-9))

    def test_disk_self_overlap_hex(self):
        self.assertRejects(rec("hex", 0, [[0.0, 0.0, 0.0]], L=2.0 - 1e-9))

    def test_disks_overlap_inside(self):
        self.assertRejects(rec("sq", 0, [[0.5, 1.0, 0.0], [2.5 - 1e-9, 1.0, 0.0]], L=4.0))

    def test_disks_overlap_across_boundary(self):
        self.assertRejects(rec("sq", 0, [[0.5, 1.0, 0.0], [2.5 + 1e-9, 1.0, 0.0]], L=4.0))

    def test_disks_overlap_far_outside_cell(self):
        # centres given far outside the fundamental cell: images still found
        self.assertRejects(rec("sq", 0, [[0.5 + 400.0, 1.0, 0.0], [2.5 + 1e-9 - 4000.0, 1.0 + 40.0, 0.0]], L=4.0))

    def test_triangles_lattice_too_small(self):
        self.assertRejects(two_triangles(L=1.0 - 1e-9))

    def test_triangles_shifted(self):
        self.assertRejects(two_triangles(shift=1e-9))

    def test_unreduced_basis_overlap(self):
        # b2 - 1000 b1 = (0.3, 1.9) is shorter than 2
        self.assertRejects(rec("free", 0, [[0.0, 0.0, 0.0]], b1=[2.5, 0.0], b2=[2500.3, 1.9]))

    def test_unreduced_basis_square_overlap(self):
        self.assertRejects(rec("free", 4, [[0.1, 0.1, math.pi / 4]], b1=[1.0, 0.0], b2=[1000.0, 1.0 - 1e-9]))

    def test_eps_too_small_for_contact(self):
        # exact touching, but a float-rounded contact needs some shrink:
        # a 1e-9 overlap is not cleared by eps = 1e-12
        r = rec("sq", 0, [[0.0, 0.0, 0.0], [2.0 - 1e-9, 0.0, 0.0]], L=10.0, eps=1e-12)
        self.assertRejects(r)

    def test_coincident_pieces(self):
        self.assertRejects(rec("sq", 5, [[1.0, 1.0, 0.3], [1.0, 1.0, 0.3]], L=10.0))

    def test_pentagons_overlap_1e9(self):
        # pentagon a has an edge with outward normal +x (edge normal angle
        # theta + pi/2 + pi/5 for k = 0); pentagon b points a vertex at -x
        # (vertex angle theta + pi/2 = pi). Gap along x is dx - r - R.
        N = 5
        r = 1 / (2 * math.tan(math.pi / N))
        R = 1 / (2 * math.sin(math.pi / N))
        tha = -math.pi / 2 - math.pi / 5
        thb = math.pi / 2
        C.certify(rec("sq", 5, [[0.0, 0.0, tha], [r + R + 1e-6, 0.0, thb]], L=20.0))
        self.assertRejects(rec("sq", 5, [[0.0, 0.0, tha], [r + R - 1e-9, 0.0, thb]], L=20.0))


class Malformed(unittest.TestCase):
    def assertRejects(self, r):
        with self.assertRaises(C.CertError):
            C.certify(r)

    def test_wrong_P(self):
        r = square_tile()
        r["P"] = 2
        self.assertRejects(r)

    def test_P_zero_and_bool(self):
        r = square_tile()
        r["P"] = 0
        self.assertRejects(r)
        r["P"] = True
        self.assertRejects(r)

    def test_nan_inf(self):
        for bad in (float("nan"), float("inf"), -float("inf")):
            r = square_tile()
            r["poses"][0][0] = bad
            self.assertRejects(r)
            r = square_tile()
            r["poses"][0][2] = bad
            self.assertRejects(r)
            r = square_tile()
            r["lattice"]["L"] = bad
            self.assertRejects(r)
            r = square_tile()
            r["eps"] = bad
            self.assertRejects(r)

    def test_non_numbers(self):
        r = square_tile()
        r["poses"][0][1] = "0.5"
        self.assertRejects(r)
        r = square_tile()
        r["poses"][0] = [0.1, 0.2]
        self.assertRejects(r)
        r = square_tile()
        r["lattice"] = {"L": None}
        self.assertRejects(r)

    def test_bad_L(self):
        for L in (0.0, -1.0):
            self.assertRejects(square_tile(L))

    def test_bad_eps(self):
        for e in (0.0, -1e-12, 0.5, 1.0):
            r = square_tile()
            r["eps"] = e
            self.assertRejects(r)

    def test_bad_N(self):
        for N in (1, 2, -3, 101, True, 4.0, "4"):
            r = square_tile()
            r["N"] = N
            self.assertRejects(r)

    def test_bad_family(self):
        r = square_tile()
        r["family"] = "klein"
        self.assertRejects(r)

    def test_degenerate_basis(self):
        self.assertRejects(rec("free", 0, [[0.0, 0.0, 0.0]], b1=[3.0, 1.0], b2=[6.0, 2.0]))
        self.assertRejects(rec("free", 0, [[0.0, 0.0, 0.0]], b1=[0.0, 0.0], b2=[3.0, 3.0]))

    def test_huge_enumeration_refused(self):
        # nearly degenerate but valid-looking basis: enumeration window explodes
        self.assertRejects(rec("free", 0, [[0.0, 0.0, 0.0]], b1=[1e-6, 0.0], b2=[0.0, 1e7]))

    def test_huge_theta_no_crash_and_agrees_with_reduced_angle(self):
        # float vertices collapse at |theta| ~ 1e16 (review finding: ZeroDivisionError before).
        # The intervals still resolve the exact double 1e16, so the verdict must match the one
        # for the angle reduced modulo pi/2 at high precision.
        import mpmath

        with mpmath.workdps(60):
            red = float(mpmath.fmod(mpmath.mpf(1e16), mpmath.pi / 2))
        for L in (1.0, 1.2, 1.3, 1.45):
            verdicts = []
            for th in (1e16, red):
                try:
                    C.certify(rec("sq", 4, [[0.0, 0.0, th]], eps=1e-9, L=L))
                    verdicts.append(True)
                except C.CertError:
                    verdicts.append(False)
            self.assertEqual(verdicts[0], verdicts[1], (L, red))

    def test_huge_integers_are_a_certerror(self):
        for field in ("x", "L", "eps", "score_cert"):
            r = square_tile()
            if field == "x":
                r["poses"][0][0] = 10**400
            elif field == "L":
                r["lattice"]["L"] = 10**400
            elif field == "eps":
                r["eps"] = 10**400
            else:
                r["score_cert"] = 10**400
            self.assertRejects(r)

    def test_precision_restored(self):
        import mpmath
        from mpmath import iv

        before = (iv.prec, mpmath.mp.prec)
        C.certify(square_tile())
        self.assertEqual((iv.prec, mpmath.mp.prec), before)

    def test_claim_below_bound(self):
        r = square_tile(1.0)
        r["score_cert"] = 1.0
        self.assertRejects(r)
        r["score_cert"] = 1.0 + 1e-13
        self.assertRejects(r)


class RandomisedAgainstExact(unittest.TestCase):
    """Disks on the square torus with dyadic data: compare with exact rationals."""

    def exact_valid(self, L, pts, eps):
        s = 1 - Fraction(eps)
        lim = (2 * s) ** 2
        Lf = Fraction(L)
        for i in range(len(pts)):
            for j in range(i, len(pts)):
                for m in range(-6, 7):
                    for n in range(-6, 7):
                        if i == j and m == 0 and n == 0:
                            continue
                        dx = Fraction(pts[j][0]) - Fraction(pts[i][0]) + m * Lf
                        dy = Fraction(pts[j][1]) - Fraction(pts[i][1]) + n * Lf
                        if dx * dx + dy * dy <= lim:
                            return False
        return True

    def test_random(self):
        rnd = random.Random(7)
        agree = 0
        for _ in range(120):
            P = rnd.randint(1, 5)
            L = rnd.choice([2.0, 3.0, 4.0, 4.5, 5.25])
            pts = [[rnd.randint(0, 64) / 16 * L / 4, rnd.randint(0, 64) / 16 * L / 4, 0.0] for _ in range(P)]
            eps = 1e-12
            ex = self.exact_valid(L, pts, eps)
            try:
                C.certify(rec("sq", 0, pts, eps=eps, L=L))
                got = True
            except C.CertError:
                got = False
            self.assertEqual(got, ex, (L, pts))
            agree += 1
        self.assertEqual(agree, 120)


PROOF = {
    "value": 2 * math.sqrt(2),
    "status": "proven",
    "short": "Brandt et al. 2019, Thm 1.1",
    "source": "M. Brandt et al., Optimal packings of two to four equal circles on any flat torus, Discrete Math. 342(12) (2019) 111597",
    "doi": "10.1016/j.disc.2019.111597",
    "proof": "Theorem 1.1, region R1_2",
}
CERT_SQ02 = 2.8284271247490187  # torus/sq/0/2: 2 sqrt2 (1 + 1e-12)


def status_rec(status, literature, score_cert=CERT_SQ02):
    return {"problem": "torus/sq/0/2", "status": status, "score_cert": score_cert, "literature": literature}


class StatusRules(unittest.TestCase):
    """`proven` only with a published proof of the exact case in the literature (check_status)."""

    def test_best_known_needs_nothing(self):
        C.check_status(status_rec("best_known", []))
        C.check_status(status_rec("best_known", None))
        C.check_status(status_rec("best_known", [dict(PROOF)]))

    def test_proven_with_a_proof_entry(self):
        C.check_status(status_rec("proven", [dict(PROOF)]))
        self.assertIs(C.proof_entry([dict(PROOF)], CERT_SQ02)["doi"], PROOF["doi"])

    def test_proven_without_literature_is_rejected(self):
        for lit in ([], None):
            with self.assertRaises(C.CertError):
                C.check_status(status_rec("proven", lit))

    def test_proven_needs_every_part_of_the_entry(self):
        for drop in ("proof", "doi", "source", "value"):
            e = dict(PROOF)
            del e[drop]
            with self.assertRaises(C.CertError, msg=drop):
                C.check_status(status_rec("proven", [e]))
        for field, bad in (
            ("status", "best_known"),
            ("status", "proven_unrefereed"),
            ("status", "conjecture"),
            ("proof", "   "),
            ("doi", "doi:10.1016/j.disc.2019.111597"),
            ("doi", "https://doi.org/10.1016/j.disc.2019.111597"),
            ("doi", "10.1016"),
            ("value", float("nan")),
            ("value", float("inf")),
            ("value", "2.8284271247461903"),
            ("value", True),
            ("value", None),
        ):
            e = dict(PROOF, **{field: bad})
            with self.assertRaises(C.CertError, msg=(field, bad)):
                C.check_status(status_rec("proven", [e]))

    def test_proven_needs_the_record_to_attain_the_value(self):
        # 1e-6 above the proven optimum: valid, but not the optimum
        with self.assertRaises(C.CertError):
            C.check_status(status_rec("proven", [dict(PROOF)], score_cert=PROOF["value"] * (1 + 1e-6)))
        # a proof of another case (a smaller optimum) does not make this record proven
        e = dict(PROOF, value=2.0)
        with self.assertRaises(C.CertError):
            C.check_status(status_rec("proven", [e]))

    def test_no_record_below_a_proven_optimum(self):
        below = PROOF["value"] * (1 - 1e-9)
        for status in ("best_known", "proven"):
            with self.assertRaises(C.CertError):
                C.check_status(status_rec(status, [dict(PROOF)], score_cert=below))
        # an unrefereed or best-known value may be beaten
        C.check_status(status_rec("best_known", [dict(PROOF, status="best_known")], score_cert=below))

    def test_unknown_status_and_malformed_literature(self):
        for status in ("guessed", "infeasible", "", None, 1):
            with self.assertRaises(C.CertError):
                C.check_status(status_rec(status, []))
        for lit in ("Brandt 2019", {"status": "proven"}, [PROOF, "x"]):
            with self.assertRaises(C.CertError):
                C.check_status(status_rec("proven", lit))
        for sc in (float("nan"), -1.0, 0.0, "2.83", None):
            with self.assertRaises(C.CertError):
                C.check_status(status_rec("best_known", [], score_cert=sc))

    def test_the_records_file(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "torus", "records.json")
        if not os.path.exists(path):
            self.skipTest("no records file")
        import json

        with open(path) as f:
            records = json.load(f)["records"]
        for r in records:
            C.check_status(r)
        proven = sorted(r["problem"] for r in records if r["status"] == "proven")
        loeschian = sorted({a * a + a * b + b * b for a in range(8) for b in range(8)} - {0})
        sums = sorted({a * a + b * b for a in range(8) for b in range(8)} - {0})
        expected = (
            ["torus/sq/0/%d" % P for P in (2, 3, 4, 6, 7, 8)]
            + ["torus/hex/0/%d" % P for P in [2] + [n for n in loeschian if n <= 49]]
            + ["torus/sq/4/%d" % P for P in sums if P <= 49]
            + ["torus/free/0/1", "torus/free/3/1"]
        )
        self.assertEqual(proven, sorted(expected))
        self.assertEqual(len(proven), 52)


class WidePieces(unittest.TestCase):
    def test_certified_examples(self):
        for N in (3, 7, 12, 20, 100):
            R = 0.5/math.sin(math.pi/N)
            for P in (1, 2, 5):
                for family in ('sq', 'hex', 'free'):
                    L = 4*R*P
                    lat = dict(b1=[L, 0], b2=[0, L]) if family == 'free' else dict(L=L)
                    C.certify(rec(family, N, [[3*R*i, 0, 0] for i in range(P)], **lat))

    def test_capacity_with_near_pairs(self):
        N, P = 100, 100
        step = 1/math.tan(math.pi/N)+1e-7
        C.certify(rec('sq', N, [[step*(i%10-4.5), step*(i//10-4.5), math.pi/N] for i in range(P)], L=10*step))

    def test_large_touch_overlap_and_periodic_boundary(self):
        N = 100
        r = 0.5/math.tan(math.pi/N)
        theta = math.pi/N
        # A self-translate touches across the identified cell boundary. Shrink proves touching.
        C.certify(rec('sq', N, [[0, 0, theta]], L=2*r))
        with self.assertRaises(C.CertError):
            C.certify(rec('sq', N, [[0, 0, theta]], L=2*r-1e-7))
        C.certify(rec('sq', N, [[-1, 0, theta], [2*r-1+1e-7, 0, theta]], L=100))
        with self.assertRaises(C.CertError):
            C.certify(rec('sq', N, [[-1, 0, theta], [2*r-1-1e-7, 0, theta]], L=100))
        with self.assertRaises(C.CertError):
            C.certify(rec('sq', N, [[None, 0, 0]], L=100))


if __name__ == "__main__":
    unittest.main(verbosity=1)
