"""Adversarial and sanity tests for the curved-packing certifier.

Run: python3 python/curved/test_certify.py
"""
import json
import math
import os
import sys
import unittest
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import certify  # noqa: E402
import floatgeom as fg  # noqa: E402
import rigorous as rg  # noqa: E402
from mpmath import mp, mpf, iv  # noqa: E402


RECORDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "curved", "records.json")


def shipped(rid):
    with open(RECORDS) as f:
        return [x for x in json.load(f)["records"] if x["id"] == rid][0]


def rec(K, N, M, size, poses, witnesses=None, **extra):
    r = {
        "K": K,
        "N": N,
        "M": M,
        "P": len(poses),
        "config_cert": {"size": size, "pieces": [{"x": x, "y": y, "theta": t} for (x, y, t) in poses]},
    }
    if witnesses is not None:
        r["witnesses"] = witnesses
    r.update(extra)
    return r


def ok(r):
    """Geometric certification of a minimal record (configuration only)."""
    if not isinstance(r, dict) or "id" in r:
        return certify.certify_record(r)["certified"]
    return certify.certify_configuration(
        r.get("K"), r.get("N"), r.get("M"), r.get("P"), r.get("config_cert"), r.get("witnesses"), r.get("score_cert")
    )["certified"]


def published(K, N, M, size, poses, **extra):
    """A record in the published format of data/curved/records.json."""
    r = {
        "id": certify.problem_id(K, N, M, len(poses)),
        "K": K,
        "N": N,
        "M": M,
        "P": len(poses),
        "config": {"size": size, "pieces": [{"x": x, "y": y, "theta": t} for (x, y, t) in poses]},
        "score_cert": size,
        "display": certify.display_nearest(size),
    }
    r.update(extra)
    return r


def inradius(K, N):
    """Float inradius of the unit N-gon: sn(rho) = tn(1/2) / tan(pi/N)."""
    if K < 0:
        k = math.sqrt(-K)
        return math.asinh(math.tanh(k / 2) / math.tan(math.pi / N)) / k
    if K > 0:
        k = math.sqrt(K)
        return math.asin(math.tan(k / 2) / math.tan(math.pi / N)) / k
    return 0.5 / math.tan(math.pi / N)


def moved_pair(K, a, shift):
    """Two unit squares facing each other across the y-axis at centre distance 2a, then both moved
    by the transvection T(0, shift) (far from the origin when shift is large)."""
    out = []
    Tm = fg.transvection(K, 0.0, shift)
    for sx in (1, -1):
        G = fg.mul(Tm, fg.pose_matrix(K, sx * a, 0.0, math.pi / 4))
        out.append(fg.pose_of(K, G))
    return out


class RigorousFunctions(unittest.TestCase):
    def test_pi(self):
        p = rg.pi_iv()
        mp.prec = 400
        self.assertTrue(p.a <= mp.pi <= p.b)
        self.assertLess(p.b - p.a, mpf(2) ** -240)
        mp.prec = 53

    def test_cos_sin_cosh(self):
        mp.prec = 400
        for x in [0, 0.3, -1.7, 2.5, 6.9, 12.0]:
            c, s = rg.cos_sin(rg.I(x))
            self.assertTrue(c.a <= mp.cos(mpf(x)) <= c.b)
            self.assertTrue(s.a <= mp.sin(mpf(x)) <= s.b)
            ch = rg.csK(rg.I(-1), rg.I(x))
            self.assertTrue(ch.a <= mp.cosh(mpf(x)) <= ch.b)
            sh = rg.snK(rg.I(-1), rg.I(x))
            self.assertTrue(sh.a <= mp.sinh(mpf(x)) <= sh.b)
            xi = rg.I(x)
            v = rg.Vfun(-(xi * xi))
            exact = (mp.cosh(mpf(x)) - 1) / mpf(x) ** 2 if x else mpf(1) / 2
            self.assertTrue(v.a <= exact <= v.b)
        mp.prec = 53


class Basic(unittest.TestCase):
    def test_single_piece_fills_container(self):
        for K in (-1, 0, 1, "1e-6", "-1e-6"):
            for N in (3, 4, 5, 6):
                # the container has a horizontal bottom edge; the piece a vertex up
                th = 0.0 if N % 2 else math.pi / N
                self.assertTrue(ok(rec(K, N, N, 1 + 1e-9, [(0.0, 0.0, th)])), (K, N))
                # touching exactly is not certifiable (strict clearance required)
                self.assertFalse(ok(rec(K, N, N, 1.0, [(0.0, 0.0, th)])), (K, N))
                # piece outside by ~1e-9
                self.assertFalse(ok(rec(K, N, N, 1 - 2e-9, [(0.0, 0.0, th)])), (K, N))
                # unaligned piece does not fit at all
                self.assertFalse(ok(rec(K, N, N, 1 + 1e-9, [(0.0, 0.0, th + 0.01)])), (K, N))

    def test_disk_in_disk(self):
        for K in (-1, 0, 1):
            # (disks have diameter 1: radius 1/2)
            self.assertTrue(ok(rec(K, 0, 0, 0.5 + 1e-12, [(0.0, 0.0, 0.0)])))
            self.assertFalse(ok(rec(K, 0, 0, 0.5 - 1e-12, [(0.0, 0.0, 0.0)])))

    def test_disk_pair_distance(self):
        for K in (-4, 0, 2):
            for d, expect in ((1 + 1e-9, True), (1 - 1e-12, False), (1.0, False)):
                poses = [(d / 2, 0.0, 0.0), (-d / 2, 0.0, 0.0)]
                # at K = 2 the open hemisphere has radius pi / (2 sqrt 2) = 1.1107
                self.assertEqual(ok(rec(K, 0, 0, 1.1, poses)), expect, (K, d))
        # beyond the hemisphere the container is rejected
        self.assertFalse(ok(rec(2, 0, 0, 1.12, [(0.5 + 1e-9, 0.0, 0.0), (-0.5 - 1e-9, 0.0, 0.0)])))

    def test_square_pair_overlap_1e9(self):
        for K in (-1, 0, 1):
            rho = inradius(K, 4)
            good = [(rho + 1e-9, 0.0, math.pi / 4), (-(rho + 1e-9), 0.0, math.pi / 4)]
            bad = [(rho - 0.5e-9, 0.0, math.pi / 4), (-(rho - 0.5e-9), 0.0, math.pi / 4)]
            self.assertTrue(ok(rec(K, 4, 0, 1.4, good)), K)
            self.assertFalse(ok(rec(K, 4, 0, 1.4, bad)), K)
            # bogus witness on the bad pair must not help; bogus witness on the good pair must not hurt
            w = [{"i": 0, "j": 1, "type": "axis", "owner": 0, "edge": 2}]
            self.assertFalse(ok(rec(K, 4, 0, 1.4, bad, witnesses=w)))
            self.assertTrue(ok(rec(K, 4, 0, 1.4, good, witnesses=w)))
            self.assertFalse(ok(rec(K, 4, 0, 1.4, bad, witnesses=[{"i": 0, "j": 1, "type": "far"}])))

    def test_tolerance_trap_far_from_centre(self):
        # a real 1e-4 overlap 8 units from the container centre must be rejected,
        # a real 1e-4 gap there must be accepted
        K = -1
        rho = inradius(K, 4)
        for delta, expect in ((-0.5e-4, False), (0.5e-4, True)):
            poses = moved_pair(K, rho + delta, 8.0)
            self.assertGreater(math.hypot(poses[0][0], poses[0][1]), 7.9)
            self.assertEqual(ok(rec(K, 4, 0, 10.0, poses)), expect, delta)
        # and much smaller overlaps there too
        poses = moved_pair(K, rho - 5e-9, 8.0)
        self.assertFalse(ok(rec(K, 4, 0, 10.0, poses)))


class Malformed(unittest.TestCase):
    def test_bad_inputs(self):
        base = rec(-1, 3, 3, 1.5, [(0.0, 0.0, 0.0)])
        self.assertTrue(ok(base))
        for mutate in [
            lambda r: r.update(P=2),
            lambda r: r.update(N=2),
            lambda r: r.update(N=1),
            lambda r: r.update(M=1),
            lambda r: r.update(N=3.0),
            lambda r: r.update(K=float("nan")),
            lambda r: r.update(K=float("inf")),
            lambda r: r.update(K="abc"),
            lambda r: r.update(K=True),
            lambda r: r["config_cert"].update(size=float("nan")),
            lambda r: r["config_cert"].update(size=float("inf")),
            lambda r: r["config_cert"].update(size=0.0),
            lambda r: r["config_cert"].update(size=-1.5),
            lambda r: r["config_cert"]["pieces"][0].update(x=float("nan")),
            lambda r: r["config_cert"]["pieces"][0].update(theta=float("inf")),
            lambda r: r["config_cert"]["pieces"][0].update(y="0"),
            lambda r: r["config_cert"]["pieces"].append({"x": 0, "y": 0, "theta": 0}),
            lambda r: r.update(score_cert=1.4),
            lambda r: r.pop("config_cert"),
        ]:
            r = rec(-1, 3, 3, 1.5, [(0.0, 0.0, 0.0)])
            mutate(r)
            self.assertFalse(ok(r), r)

    def test_spherical_limits(self):
        # a convex container must stay in an open hemisphere: side < 2 pi / M at K = 1
        self.assertTrue(ok(rec(1, 3, 4, 1.5, [(0.0, 0.0, 0.0)])))
        self.assertFalse(ok(rec(1, 3, 4, math.pi / 2 + 1e-12, [(0.0, 0.0, 0.0)])))
        self.assertFalse(ok(rec(1, 3, 4, 2.0, [(0.0, 0.0, 0.0)])))
        # disk container radius below pi/2
        self.assertFalse(ok(rec(1, 3, 0, 1.6, [(0.0, 0.0, 0.0)])))
        self.assertTrue(ok(rec(1, 3, 0, 1.5, [(0.0, 0.0, 0.0)])))
        # no unit octagon on the unit sphere; unit hexagon exists
        self.assertFalse(ok(rec(1, 8, 0, 1.5, [(0.0, 0.0, 0.0)])))
        self.assertTrue(ok(rec(1, 6, 6, 1.0 + 1e-9, [(0.0, 0.0, math.pi / 6)])))
        # a disk of diameter 1 does not fit in a hemisphere at K = 10 (pi / (2 sqrt 10) = 0.4967 < 1/2)
        self.assertFalse(ok(rec(10, 0, 0, 0.9, [(0.0, 0.0, 0.0)])))
        self.assertTrue(ok(rec(9, 0, 0, 0.5 + 1e-3, [(0.0, 0.0, 0.0)])))

    def test_disk_in_polygon(self):
        # one disk of diameter 1 in the regular pentagon at K = -1 whose apothem is 1/2 + 1e-9
        K = -1
        h = 0.5 + 1e-9
        s = 2 * math.atanh(math.sinh(h) * math.tan(math.pi / 5))
        self.assertTrue(ok(rec(K, 0, 5, s, [(0.0, 0.0, 0.0)])))
        h = 0.5 - 1e-9
        s = 2 * math.atanh(math.sinh(h) * math.tan(math.pi / 5))
        self.assertFalse(ok(rec(K, 0, 5, s, [(0.0, 0.0, 0.0)])))
        # the ideal apothem of a hyperbolic square is 0.8814 > 1/2: a huge side holds the disk (a disk of radius 1 would not fit)
        self.assertTrue(ok(rec(K, 0, 4, 30.0, [(0.0, 0.0, 0.0)])))


class ReviewRegressions(unittest.TestCase):
    """Defects found by the independent review (2026-10-24); each failed before the fix."""

    def test_D1_no_unit_polygon_when_perimeter_too_long(self):
        # sin(sqrt K/2) < sin(pi/N) holds again for large K, but sqrt K < 2 pi / N is required
        for K, N in ((20, 3), (30, 3), (39, 3), (50, 3), (30, 4), (35, 6)):
            self.assertFalse(ok(rec(K, N, 0, 0.3 if N == 3 else 0.25, [(0.0, 0.0, 0.0)])), (K, N))
        # just inside the limit a unit triangle exists and certifies in a slightly larger disk
        K = (2 * math.pi / 3) ** 2 * 0.98
        R = math.asin(math.sin(math.sqrt(K) / 2) / math.sin(math.pi / 3)) / math.sqrt(K)
        self.assertTrue(ok(rec(K, 3, 0, R * 1.001, [(0.0, 0.0, 0.0)])))

    def test_D2_polygon_container_must_stay_in_hemisphere(self):
        # side 1.5 + 4 pi at K = 1 used to wrap around to the polygon of side 1.5
        self.assertTrue(ok(rec(1, 3, 4, 1.5, [(0.0, 0.0, 0.0)])))
        self.assertFalse(ok(rec(1, 3, 4, 1.5 + 4 * math.pi, [(0.0, 0.0, 0.0)])))
        self.assertFalse(ok(rec(1, 3, 4, 1.5 + 8 * math.pi, [(0.0, 0.0, 0.0)])))
        self.assertFalse(ok(rec(1, 3, 3, 1.0 + 4 * math.pi, [(0.0, 0.0, 0.0)])))
        # the limit itself: s < 2 pi / (M sqrt K)
        self.assertFalse(ok(rec(4, 3, 4, math.pi / 4 + 1e-15, [(0.0, 0.0, 0.0)])))
        if os.path.exists(RECORDS):
            r = shipped("curved/1/3/3/10")
            cfg = dict(r["config"])
            self.assertTrue(ok({"K": 1, "N": 3, "M": 3, "P": 10, "config_cert": cfg}))
            for k in (4, 8):
                cfg2 = {"size": cfg["size"] + k * math.pi, "pieces": cfg["pieces"]}
                self.assertFalse(ok({"K": 1, "N": 3, "M": 3, "P": 10, "config_cert": cfg2}), k)

    def test_D3_published_record_consistency(self):
        base = lambda **kw: published(-1, 3, 3, 1.5, [(0.0, 0.0, 0.0)], **kw)  # noqa: E731
        self.assertTrue(ok(base()))
        self.assertTrue(ok(base(K_exact="-1")))
        # K_exact may not override K
        self.assertFalse(ok(base(K_exact="1")))
        self.assertFalse(ok(base(K_exact="binary64 -1.0000000000000002")))
        self.assertFalse(ok(base(K_exact="nonsense")))
        # the id must match curved/K/N/M/P
        self.assertFalse(ok(base(id="curved/-1/3/3/2")))
        self.assertFalse(ok(base(id="curved/1/3/3/1")))
        # a '#tag' suffix may follow the exact problem id, nothing else
        self.assertTrue(ok(base(id=base()["id"] + "#b2")))
        self.assertFalse(ok(base(id=base()["id"] + "#")))
        self.assertFalse(ok(base(id=base()["id"] + "#b 2")))
        self.assertFalse(ok(base(id=base()["id"] + "x")))
        self.assertFalse(ok(base(id="curved/-1/3/3/2#b2")))
        r = base()
        r.pop("id")
        self.assertFalse(ok(r))
        # score_cert required and equal to the size; display = score_cert rounded to the nearest at 6 decimals
        r = base()
        r.pop("score_cert")
        self.assertFalse(ok(r))
        self.assertFalse(ok(base(score_cert=1.4)))
        self.assertFalse(ok(base(display="0.000001")))
        self.assertFalse(ok(base(display="1.499999")))
        self.assertFalse(ok(base(display="1.500001")))  # the former rounded-up form is rejected
        self.assertTrue(ok(base(display="1.500000")))
        r = base()
        r.pop("display")
        self.assertFalse(ok(r))
        # the published config is certified; a valid config_cert does not rescue an invalid config
        bad = base()
        bad["config"] = {"size": 1.5, "pieces": [{"x": 3.0, "y": 0.0, "theta": 0.0}]}
        bad["config_cert"] = {"size": 1.5, "pieces": [{"x": 0.0, "y": 0.0, "theta": 0.0}]}
        self.assertFalse(ok(bad))
        bad2 = base(config_cert={"size": 1.5, "pieces": [{"x": 3.0, "y": 0.0, "theta": 0.0}]})
        self.assertFalse(ok(bad2))
        # a K = -1 configuration presented as K = +1 is rejected
        if os.path.exists(RECORDS):
            r = shipped("curved/-1/3/4/7")
            self.assertTrue(ok(dict(r)))
            r2 = dict(r, id="curved/1/3/4/7", K=1, K_exact="-1")
            self.assertFalse(ok(r2))
            r3 = dict(r, id="curved/-1/3/4/8")
            self.assertFalse(ok(r3))

    def test_display_rounds_to_nearest(self):
        # display = score_cert rounded to the NEAREST at 6 decimals (ties to even), from the exact binary64 value
        d = certify.display_nearest
        self.assertEqual(d(1.0000000000400), "1.000000")
        self.assertEqual(d(2.8284271247490187), "2.828427")
        self.assertEqual(d(1.0), "1.000000")
        self.assertEqual(d(math.nextafter(1.0, 2.0)), "1.000000")
        self.assertEqual(d(3), "3.000000")
        self.assertEqual(d(2.9999995000001), "3.000000")
        self.assertEqual(d(2.9999994999999), "2.999999")
        # exact binary64 ties: 1/128 = 0.0078125 and 3/128 = 0.0234375 go to the even neighbour
        self.assertEqual(d(1 / 128), "0.007812")
        self.assertEqual(d(3 / 128), "0.023438")
        for bad in (-1e-9, float("nan"), float("inf"), True, "1.0"):
            with self.assertRaises(certify.CertError):
                d(bad)

    def test_crashes_become_rejections(self):
        big = 10**400
        self.assertFalse(ok(rec(big, 3, 3, 1.5, [(0.0, 0.0, 0.0)])))
        self.assertFalse(ok(rec(-1, 3, 3, big, [(0.0, 0.0, 0.0)])))
        for k in range(3):
            pose = [0.0, 0.0, 0.0]
            pose[k] = big
            self.assertFalse(ok(rec(-1, 3, 3, 1.5, [tuple(pose)])))
            r = published(-1, 3, 3, 1.5, [(0.0, 0.0, 0.0)])
            r["config"]["pieces"][0][("x", "y", "theta")[k]] = big
            self.assertFalse(ok(r))
        r = published(-1, 3, 3, 1.5, [(0.0, 0.0, 0.0)])
        r["K"] = big
        self.assertFalse(ok(r))
        for junk in ([1, 2], "record", None, 7):
            self.assertFalse(certify.certify_record(junk)["certified"])

    def test_main_survives_bad_records(self):
        import io
        import tempfile
        from contextlib import redirect_stdout

        good = published(-1, 3, 3, 1.5, [(0.0, 0.0, 0.0)])
        recs = {"records": [good, [1, 2], {"K": 10**400}, "x"]}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write(json.dumps(recs).replace(str(10**400), "1" + "0" * 400))
            path = f.name
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = certify.main(["certify.py", path])
        os.unlink(path)
        self.assertEqual(rc, 1)
        self.assertIn("1/4 records certified", buf.getvalue())

    def test_large_theta_argument_reduction(self):
        # theta = 1000 + pi/4 (mod 2 pi) is the axis-aligned square; it must still certify
        for th0 in (math.pi / 4, 1000 * 2 * math.pi + math.pi / 4):
            self.assertTrue(ok(rec(-1, 4, 4, 1 + 1e-6, [(0.0, 0.0, th0)])), th0)


class WidePieces(unittest.TestCase):
    def test_certified_examples(self):
        for N in (3, 7, 12, 20, 100):
            for P in (1, 2, 5):
                for K in (-1e-6, 1e-6):
                    R = math.asinh(math.sinh(0.0005)/math.sin(math.pi/N))/0.001 if K < 0 else math.asin(math.sin(0.0005)/math.sin(math.pi/N))/0.001
                    poses = [(3*R*i, 0, 0) for i in range(P)]
                    self.assertTrue(ok(rec(K, N, 0, 3*R*P+1, poses)), (K, N, P))

    def test_capacity_with_near_pairs(self):
        N, P = 100, 100
        step = 2*math.asinh(math.tanh(0.0005)/math.tan(math.pi/N))/0.001+1e-7
        poses = [((i-49.5)*step, 0, math.pi/N) for i in range(P)]
        self.assertTrue(ok(rec(-1e-6, N, 0, P*step, poses)))

    def test_large_touch_overlap_and_boundary(self):
        N = 100
        r = 0.5/math.tan(math.pi/N)
        R = 0.5/math.sin(math.pi/N)
        theta = math.pi/N
        # Strict certificates reject exact contact, then accept an explicit clearance.
        self.assertTrue(ok(rec(0, N, 0, 4*R, [(0, 0, theta), (2*r+1e-7, 0, theta)])))
        self.assertFalse(ok(rec(0, N, 0, 4*R, [(0, 0, theta), (2*r-1e-7, 0, theta)])))
        self.assertTrue(ok(rec(0, N, 0, R+1e-7, [(0, 0, 0)])))
        self.assertFalse(ok(rec(0, N, 0, R-1e-7, [(0, 0, 0)])))
        bad = rec(0, N, 0, 100, [(0, 0, 0)])
        bad['config_cert']['pieces'] = [None]
        self.assertFalse(ok(bad))


if __name__ == "__main__":
    unittest.main(verbosity=1)
