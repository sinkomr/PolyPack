"""Adversarial and sanity tests for the whole-sphere certifier and bounds.

Run: python3 python/sphere/test_certify.py
Uses only the stdlib + mpmath (the certifier's own dependencies); test fixtures are built with
plain float math here, independently of the numpy search code.
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bounds as bd  # noqa: E402
import certify  # noqa: E402

PI = math.pi
HERE = os.path.dirname(os.path.abspath(__file__))
RECORDS = os.path.join(HERE, "..", "..", "data", "sphere", "records.json")


def qmul(p, q):
    w1, x1, y1, z1 = p
    w2, x2, y2, z2 = q
    return [w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2]


def qz(t):
    return [math.cos(t / 2), 0.0, 0.0, math.sin(t / 2)]


def qx(t):
    return [math.cos(t / 2), math.sin(t / 2), 0.0, 0.0]


def qy(t):
    return [math.cos(t / 2), 0.0, math.sin(t / 2), 0.0]


def q_centre(c, theta=0.0):
    n = math.sqrt(sum(x * x for x in c))
    c = [x / n for x in c]
    d = math.acos(max(-1.0, min(1.0, c[2])))
    s = math.hypot(c[0], c[1])
    if s < 1e-300:
        qt = [1.0, 0, 0, 0] if c[2] > 0 else [0.0, 1.0, 0, 0]
    else:
        qt = [math.cos(d / 2), math.sin(d / 2) * -c[1] / s, math.sin(d / 2) * c[0] / s, 0.0]
    return qmul(qt, qz(theta))


def rec(N, rho, qs, witnesses=None):
    return {"N": N, "P": len(qs), "config": {"rho": rho, "pieces": [{"q": q} for q in qs]}, "witnesses": witnesses}


def ok(r):
    """Geometry-only certification of a bare {N, P, config, witnesses} dict."""
    if not isinstance(r, dict):
        return certify.certify_configuration(None, None, None)["certified"]
    return certify.certify_configuration(r.get("N"), r.get("P"), r.get("config"), r.get("witnesses"))["certified"]


def published(N, rho, qs, **extra):
    """A minimal published record that passes the record-level checks."""
    r = {"id": f"sphere/{N}/{len(qs)}", "N": N, "P": len(qs), "score_float": rho, "score_cert": rho,
         "display": certify.display_6(rho), "status": "best_known",
         "config": {"rho": rho, "pieces": [{"q": q} for q in qs]}}
    r.update(extra)
    return r


def pok(r):
    return certify.certify_record(r)["certified"]


def cube_record(rho):
    """Six squares, the radial projection of the cube (face centres +-e_i, aligned edges)."""
    # square vertex directions at phi = pi/2 + k pi/2 are the axes; a cube face seen from its centre has
    # its vertices on the diagonals, so turn by pi/4.
    qs = [q_centre([0, 0, 1], PI / 4), q_centre([0, 0, -1], PI / 4)]
    for c in ([1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]):
        qs.append(None)
    # side faces: rotate the top face about the x or y axis by +-pi/2
    qs[2] = qmul(qy(PI / 2), qs[0])
    qs[3] = qmul(qy(-PI / 2), qs[0])
    qs[4] = qmul(qx(-PI / 2), qs[0])
    qs[5] = qmul(qx(PI / 2), qs[0])
    return rec(4, rho, qs)


RHO_CUBE = 1 / math.acos(1 / 3)
RHO_TET = 1 / math.acos(-1 / 3)


class TestPolygons(unittest.TestCase):
    def test_cube_tiling(self):
        self.assertTrue(ok(cube_record(RHO_CUBE * (1 + 1e-10))))
        # overlap: the touching limit itself cannot be certified strictly, and 1e-9 below overlaps
        self.assertFalse(ok(cube_record(RHO_CUBE)))
        self.assertFalse(ok(cube_record(RHO_CUBE * (1 - 1e-9))))

    def test_rotated_piece_overlaps(self):
        r = cube_record(RHO_CUBE * (1 + 1e-10))
        q = r["config"]["pieces"][2]["q"]
        r["config"]["pieces"][2]["q"] = qmul(q, qz(1e-7))
        self.assertFalse(ok(r))

    def test_tetrahedron(self):
        # four triangles centred at the tetrahedron face directions; a triangle centred at -v (v a vertex)
        V = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]
        qs = []
        for v in V:
            c = [-x for x in v]
            # orient so that one vertex of the piece points at a tetrahedron vertex: search theta numerically
            best = None
            for k in range(3600):
                th = 2 * PI * k / 3600
                q = q_centre(c, th)
                M = _mat(q)
                R = math.acos(1 / 3) / 2  # not used
                # vertex 0 direction of the standard piece at circumradius Rt
                Rt = PI - math.acos(-1 / 3) - 0.0
                del R, Rt
                Rt = math.acos(1 / math.sqrt(3)) if False else _tet_R()
                v0 = [0.0, math.sin(Rt), math.cos(Rt)]
                w = [sum(M[i][j] * v0[j] for j in range(3)) for i in range(3)]
                tgt = [x / math.sqrt(3) for x in V[(V.index(v) + 1) % 4]]
                d = sum(w[i] * tgt[i] for i in range(3))
                if best is None or d > best[0]:
                    best = (d, q)
            qs.append(best[1])
        # angle quantisation 0.1 degree: certify at a comfortably larger rho, reject at a smaller one
        self.assertTrue(ok(rec(3, RHO_TET * 1.01, qs)))
        self.assertFalse(ok(rec(3, RHO_TET * 0.99, qs)))

    def test_antipodal_pair(self):
        for N in (3, 4, 5, 6, 8):
            lim = N / (2 * PI)
            qs = [[1.0, 0, 0, 0], [0.0, 1.0, 0, 0]]
            self.assertTrue(ok(rec(N, lim * (1 + 1e-9), qs)), N)
            # below the existence limit the piece is not a convex polygon
            self.assertFalse(ok(rec(N, lim * (1 - 1e-9), qs)), N)
            # near-antipodal: at rho = lim (1 + 1e-9) the circumradius is pi/2 - d with d ~ 4e-5, so a tilt
            # by 1e-3 pushes vertices into the other piece, a tilt by 1e-6 does not
            self.assertFalse(ok(rec(N, lim * (1 + 1e-9), [qs[0], qmul(qx(1e-3), qs[1])])), N)
            self.assertTrue(ok(rec(N, lim * (1 + 1e-9), [qs[0], qmul(qx(1e-6), qs[1])])), N)
            # with a real margin the same tilt is fine
            self.assertTrue(ok(rec(N, lim * 1.01, [qs[0], qmul(qx(1e-6), qs[1])])), N)

    def test_union_wraps_more_than_a_hemisphere(self):
        # two near-hemisphere triangles at the poles turned by 60 degrees: the six vertices alternate
        # north/south around the equator, so no open hemisphere (no chart) contains both pieces
        e = 1e-3
        N = 3
        a = 2 * math.asin(math.sin(PI / 2 - e) * math.sin(PI / N))
        rho = 1 / a
        q1 = qmul([0.0, 1.0, 0, 0], qz(PI / 3))
        self.assertTrue(ok(rec(N, rho, [[1.0, 0, 0, 0], q1])))
        self.assertTrue(ok(rec(N, rho, [[1.0, 0, 0, 0], qmul(qx(1.5 * e), q1)])))  # separated by a tilted plane
        self.assertFalse(ok(rec(N, rho, [[1.0, 0, 0, 0], qmul(qx(5 * e), q1)])))  # a vertex enters the other piece

    def test_bad_witness_falls_back(self):
        r = cube_record(RHO_CUBE * (1 + 1e-10))
        r["witnesses"] = [[0, 2, 1.0, 2.0, 3.0], [0, 1, 0.0, 0.0, 0.0], [1, 2, float("nan"), 0, 0], "junk"]
        self.assertTrue(ok(r))

    def test_zero_witness_on_a_near_pair(self):
        r = cube_record(RHO_CUBE * (1 + 1e-10))
        r["witnesses"] = [[0, 2, 0.0, 0.0, 0.0], [0, 3, 0.0, 0.0, 0.0]]
        self.assertTrue(ok(r))

    def test_side_beyond_pi_rejected(self):
        # a = 2 pi - 0.1 has a small sin(a/2) but is not a polygon side
        self.assertFalse(ok(rec(3, 1 / (2 * PI - 0.1), [[1.0, 0, 0, 0]])))
        self.assertFalse(ok(rec(4, 1 / (PI + 0.01), [[1.0, 0, 0, 0]])))

    def test_nonexistent_unit_triangles_curvature_20(self):
        # regression (found in review of python/curved): at rho = 1/sqrt(20) the side angle sqrt(20) > pi,
        # sin(sqrt(20)/2) < sin(pi/3) holds, but no convex unit triangle exists (perimeter 3 > 2 pi rho)
        self.assertFalse(ok(rec(3, 1 / math.sqrt(20), [[1.0, 0, 0, 0]])))
        self.assertFalse(ok(rec(3, 1 / math.sqrt(20), [[1.0, 0, 0, 0], [0.0, 1.0, 0, 0]])))

    def test_published_fields(self):
        # S2: id (optionally #tag), score_cert = config.rho, display rounded to 6 decimals, score_float <= score_cert,
        # status in the allowed set, 'proven' only with a cited proof
        qs = [[1.0, 0, 0, 0], [0.0, 1.0, 0, 0]]
        r = published(4, 1.0, qs)
        self.assertTrue(pok(r))
        self.assertTrue(pok(dict(r, id="sphere/4/2#b2")))
        for bad in [dict(r, id="sphere/4/3"), dict(r, id="sphere/3/2"), dict(r, id="sphere/4/2 "), dict(r, id="sphere/4/2#"),
                    dict(r, id="sphere/4/2#a b"), dict(r, id=None), {k: v for k, v in r.items() if k != "id"},
                    dict(r, score_cert=0.9), {k: v for k, v in r.items() if k != "score_cert"},
                    dict(r, display="1.000001"), dict(r, display="0.999999"), dict(r, display=1.0), {k: v for k, v in r.items() if k != "display"},
                    dict(r, score_float=1.0000001), dict(r, score_float=0.0), dict(r, score_float=float("nan")), {k: v for k, v in r.items() if k != "score_float"},
                    dict(r, status="optimal"), dict(r, status=None), dict(r, status="proven"),
                    dict(r, status="proven", literature={"proof": []}), dict(r, status="proven", literature={"proof": [" "]}),
                    dict(r, certificate=[1, 2]), dict(r, certificate={"witnesses": 5})]:
            self.assertFalse(pok(bad), {k: bad.get(k) for k in ("id", "score_cert", "display", "score_float", "status", "certificate")})
        self.assertTrue(pok(dict(r, status="proven", literature={"proof": ["R. A. Rankin, Proc. Glasgow Math. Assoc. 2 (1955) 139-144"]})))
        # display: nearest at 6 decimals from the exact binary64 value (ties to even); exact values show exactly
        self.assertEqual(certify.display_6(1.0), "1.000000")
        self.assertEqual(certify.display_6(math.nextafter(1.0, 2.0)), "1.000000")  # no trailing 1 above an exact value
        self.assertEqual(certify.display_6(2.0000004), "2.000000")
        self.assertEqual(certify.display_6(2.0000006), "2.000001")
        self.assertEqual(certify.display_6(1.9999996), "2.000000")
        # 0.1234565 is stored as 0.12345649999999999... in binary64, so it rounds down
        self.assertEqual(certify.display_6(0.1234565), "0.123456")
        # exact binary64 values decide: 1 + 2^-21 = 1.000000476837158203125 rounds down,
        # 1 + 2^-20 = 1.00000095367431640625 rounds up
        self.assertEqual(certify.display_6(1 + 2 ** -21), "1.000000")
        self.assertEqual(certify.display_6(1 + 2 ** -20), "1.000001")
        self.assertEqual(certify.display_6(0.0), "0.000000")
        self.assertFalse(pok(dict(r, display="1.000001")))  # the old rounded-up string is now rejected for rho = 1

    def test_supported_shapes_only(self):
        # S4: N in {0, 3, 4, 5, 6, 8}; 7-gons are geometrically fine but outside the problem set
        for N in (3, 4, 5, 6, 8):
            self.assertTrue(ok(rec(N, N, [[1.0, 0, 0, 0], [0.0, 1.0, 0, 0]])), N)
        for N in (7, 9, 10, 12, 100, 1, 2):
            self.assertFalse(ok(rec(N, N, [[1.0, 0, 0, 0], [0.0, 1.0, 0, 0]])), N)

    def test_witness_cannot_rescue_an_overlap(self):
        r = cube_record(RHO_CUBE * (1 - 1e-6))
        r["witnesses"] = [[i, j, 0.0, 0.0, 1.0] for i in range(6) for j in range(i + 1, 6)]
        self.assertFalse(ok(r))


class TestDisks(unittest.TestCase):
    def pair(self, rho, ang):
        return rec(0, rho, [[1.0, 0, 0, 0], q_centre([math.sin(ang), 0.0, math.cos(ang)])])

    def test_overlap_by_1e9(self):
        rho = 1.7
        self.assertTrue(ok(self.pair(rho, (2 / rho) * (1 + 1e-9))))
        self.assertFalse(ok(self.pair(rho, (2 / rho) * (1 - 1e-9))))

    def test_hemispheres(self):
        qs = [[1.0, 0, 0, 0], [0.0, 1.0, 0, 0]]
        self.assertTrue(ok(rec(0, (2 / PI) * (1 + 1e-12), qs)))
        # the binary64 value of 2/pi is 3e-17 above 2/pi (strictly valid, correctly certified); one ulp lower
        # is below 2/pi: the caps exceed hemispheres and must be rejected
        self.assertTrue(ok(rec(0, 2 / PI, qs)))
        self.assertFalse(ok(rec(0, math.nextafter(2 / PI, 0.0), qs)))
        self.assertFalse(ok(rec(0, (2 / PI) * (1 - 1e-9), qs)))

    def test_octahedron_codes(self):
        # six disks at +-e_i: angle pi/2 = 2a -> rho = 4/pi
        cs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        qs = [q_centre(c) for c in cs]
        self.assertTrue(ok(rec(0, (4 / PI) * (1 + 1e-12), qs)))
        self.assertFalse(ok(rec(0, (4 / PI) * (1 - 1e-12), qs)))


class TestNeverRaises(unittest.TestCase):
    """D2: non-object records and fields are failures, never tracebacks."""

    def test_certify_record_returns_failure(self):
        good = published(4, 1.0, [[1.0, 0, 0, 0], [0.0, 1.0, 0, 0]])
        for bad in ([1, 2, 3], "junk", None, 5, dict(good, config=[1]), dict(good, config="x"),
                    dict(good, certificate=[1, 2]), dict(good, config={"rho": 1.0, "pieces": "ab"}),
                    dict(good, config={"rho": 1.0, "pieces": [1, 2]}), dict(good, literature=[1], status="proven")):
            res = certify.certify_record(bad)
            self.assertFalse(res["certified"], bad)
            self.assertIn("error", res)
        for args in ((4, 2, [1]), (4, 2, None), ("4", 2, {}), (4, 2, {"rho": 1.0, "pieces": [[1, 0, 0, 0]] * 2})):
            self.assertFalse(certify.certify_configuration(*args)["certified"], args)

    def test_command_line_counts_every_record(self):
        # D1 + D2: every entry of 'records' is counted, failures are reported, exit status 1
        import subprocess

        fx = os.path.join(HERE, "fixtures")
        for name, total in (("review_noconfig.json", 3), ("review_junkrec.json", 2),
                            ("review_configlist.json", 2), ("review_certlist.json", 2)):
            p = subprocess.run([sys.executable, os.path.join(HERE, "certify.py"), os.path.join(fx, name)],
                               capture_output=True, text=True, timeout=120)
            self.assertEqual(p.returncode, 1, name)
            self.assertNotIn("Traceback", p.stderr + p.stdout, name)
            summary, res = certify.run(os.path.join(fx, name), quiet=True)
            self.assertEqual(summary["records"], total, name)
            self.assertEqual(len(res), total, name)
            self.assertGreaterEqual(summary["failed"], 1, name)
            self.assertEqual(summary["certified"] + summary["failed"], total, name)

    def test_unreadable_or_empty_files_fail(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            for content in ("not json", "{}", '{"records": 5}', '{"records": []}', "[1, 2]"):
                fn = os.path.join(d, "x.json")
                open(fn, "w").write(content)
                summary, _ = certify.run(fn, quiet=True)
                self.assertGreaterEqual(summary["failed"], 1, content)
            summary, _ = certify.run(os.path.join(d, "missing.json"), quiet=True)
            self.assertGreaterEqual(summary["failed"], 1)


class TestMalformed(unittest.TestCase):
    base = {"N": 4, "P": 2, "config": {"rho": 1.0, "pieces": [{"q": [1.0, 0, 0, 0]}, {"q": [0.0, 1.0, 0, 0]}]}}

    def variant(self, **kw):
        import copy

        r = copy.deepcopy(self.base)
        for k, v in kw.items():
            if k in ("rho", "pieces"):
                r["config"][k] = v
            else:
                r[k] = v
        return r

    def test_good(self):
        self.assertTrue(ok(self.base))

    def test_rejects(self):
        bad = [
            self.variant(P=3), self.variant(P=0), self.variant(P=True), self.variant(P=2.0),
            self.variant(N=2), self.variant(N=-1), self.variant(N="4"), self.variant(N=True), self.variant(N=4.0),
            self.variant(rho=float("nan")), self.variant(rho=float("inf")), self.variant(rho=0.0), self.variant(rho=-1.0),
            self.variant(rho="1.0"), self.variant(rho=0.5),  # 0.5 < 4/(2 pi): no convex square
            self.variant(pieces=[{"q": [1.0, 0, 0, 0]}, {"q": [0.0, 0, 0, 0]}]),
            self.variant(pieces=[{"q": [1.0, 0, 0, 0]}, {"q": [float("nan"), 1.0, 0, 0]}]),
            self.variant(pieces=[{"q": [1.0, 0, 0, 0]}, {"q": [float("inf"), 1.0, 0, 0]}]),
            self.variant(pieces=[{"q": [1.0, 0, 0, 0]}, {"q": [1.0, 0, 0]}]),
            self.variant(pieces=[{"q": [1.0, 0, 0, 0]}, {}]),
            self.variant(pieces=[{"q": [1.0, 0, 0, 0]}]),
            {"N": 4, "P": 2},
        ]
        for i, r in enumerate(bad):
            self.assertFalse(ok(r), i)
        # identical pieces overlap
        self.assertFalse(ok(self.variant(pieces=[{"q": [1.0, 0, 0, 0]}, {"q": [2.0, 0, 0, 0]}])))
        # disks larger than a hemisphere
        self.assertFalse(ok({"N": 0, "P": 2, "config": {"rho": 0.6, "pieces": self.base["config"]["pieces"]}}))


class TestBounds(unittest.TestCase):
    def test_area_bound_tilings(self):
        cases = [(3, 4, RHO_TET), (3, 8, 2 / PI), (3, 20, 1 / math.atan(2)), (4, 6, RHO_CUBE), (5, 12, 1 / math.acos(math.sqrt(5) / 3))]
        for N, P, rho in cases:
            L = bd.area_bound(N, P)
            self.assertIsNotNone(L)
            self.assertLessEqual(L, rho)
            self.assertLess(rho - L, 1e-11)

    def test_fejes_toth_sharp_cases(self):
        # sharp for P = 3, 4, 6, 12 (Fejes Toth 1943)
        exact = {3: 2 / (2 * PI / 3), 4: 2 / math.acos(-1 / 3), 6: 4 / PI, 12: 2 / math.atan(2)}
        for P, rho in exact.items():
            L = bd.fejes_toth_disk_bound(P)
            self.assertLessEqual(L, rho)
            self.assertLess(rho - L, 1e-11, P)

    def test_bounds_are_below_known_packings(self):
        self.assertLess(bd.inradius_bound(4, 6, bd._ft_cos_iv(6), bd.ft_cos(6)), RHO_CUBE)
        self.assertLess(bd.maximality_bound(4, "0.955316"), RHO_CUBE)  # 7 squares need more room than 6
        self.assertGreater(bd.maximality_bound(4, "0.955316"), RHO_CUBE * 0.999)

    def test_records_if_present(self):
        if not os.path.exists(RECORDS):
            self.skipTest("no records yet")
        import json

        data = json.load(open(RECORDS))
        for r in data["records"]:
            for b in r.get("bounds") or []:
                # every bound (including the published maximality bounds) must lie below the found value
                self.assertLessEqual(b["value"], r["score_float"] * (1 + 1e-12), (r["id"], b["kind"]))
                self.assertIn("rigorous", b)
            if r["bound"]:
                self.assertLessEqual(r["bound"]["value"], r["score_float"] * (1 + 1e-12), r["id"])
                self.assertTrue(r["bound"]["rigorous"], r["id"])  # the headline bound is always rigorous

    def test_float_computed_maximality_bounds_are_flagged(self):
        # S1: dOSV star rows rest on floating-point SDP values; dagger rows whose printed volume bound is
        # below n + 1 (triangles 19, 20, ...) follow from the area argument and stay rigorous
        if not os.path.exists(RECORDS):
            self.skipTest("no records yet")
        import json

        by = {r["id"]: r for r in json.load(open(RECORDS))["records"]}
        for rid in ("sphere/4/8", "sphere/4/9", "sphere/4/10", "sphere/4/11", "sphere/5/6", "sphere/5/8"):
            mx = [b for b in by[rid]["bounds"] if b["kind"] == "maximality_dosv2026"]
            self.assertTrue(mx and not any(b["rigorous"] for b in mx), rid)
            self.assertIn("float-computed", mx[0]["label"])
            self.assertNotEqual(by[rid]["bound"]["kind"], "maximality_dosv2026", rid)
        for rid in ("sphere/3/20", "sphere/3/21"):
            mx = [b for b in by[rid]["bounds"] if b["kind"] == "maximality_dosv2026"]
            self.assertTrue(mx and all(b["rigorous"] for b in mx), rid)

    def test_icosahedral_tiling_is_not_counted_as_a_gain(self):
        # D3: the dOSV n = 20 row is a weaker non-tiling configuration; sphere/3/20 is the classical tiling
        if not os.path.exists(RECORDS):
            self.skipTest("no records yet")
        import json

        recs = json.load(open(RECORDS))["records"]
        by = {r["id"]: r for r in recs}
        self.assertEqual(by["sphere/3/20"]["literature"]["verdict"], "tiling")
        comp = [r for r in recs if r["N"] > 0 and r["literature"] and r["literature"].get("verdict")]
        verdicts = [r["literature"]["verdict"] for r in comp]
        self.assertEqual(verdicts.count("tiling"), 1)
        # "better" = circumradius above the printed value by more than 1e-5, tilings excluded (34 at the
        # first publication, 40 after the re-run of 2026-10-24)
        expect = sum(1 for r in comp if r["literature"]["our_circumradius"] > float(r["literature"]["radius"]) + 1e-5
                     and r["id"] != "sphere/3/20")
        self.assertEqual(verdicts.count("better"), expect)
        self.assertGreaterEqual(expect, 34)

    def test_proven_tammes_against_exact_optima(self):
        # reviewer's check: for proven Tammes P, score_cert >= 2/theta_P with cos theta_P the exact root of
        # Cohn's minimal polynomial (closed forms for P <= 6), and score_float within 1e-12 of it
        if not os.path.exists(RECORDS):
            self.skipTest("no records yet")
        import json
        from mpmath import mp, mpf, acos, polyroots

        mp.dps = 50
        polys = {7: [3, -9, -3, 1], 8: [7, 2, -1], 9: [3, -1], 10: [7, -4, -2, 1], 11: [5, 0, -1], 12: [5, 0, -1],
                 13: [1, -24, -12, 8, 38, 24, -12, -8, 1], 14: [4, -2, 3, 0, -1], 24: [7, 1, -3, -1]}
        closed = {2: mpf(-1), 3: mpf(-1) / 2, 4: mpf(-1) / 3, 5: mpf(0), 6: mpf(0)}
        by = {r["id"]: r for r in json.load(open(RECORDS))["records"]}
        proven = [r for r in by.values() if r["N"] == 0 and r["status"] == "proven"]
        self.assertEqual(sorted(r["P"] for r in proven), list(range(2, 15)) + [24])
        for r in proven:
            P = r["P"]
            if P in closed:
                c = closed[P]
            else:
                table = mpf(r["literature"]["cos_min_angle"])
                roots = [z.real for z in polyroots(polys[P], maxsteps=200, extraprec=200) if abs(z.imag) < mpf(10) ** -30]
                c = min(roots, key=lambda z: abs(z - table))
                self.assertLess(abs(c - table), mpf(10) ** -11, P)
            opt = 2 / acos(c)
            self.assertGreaterEqual(mpf(r["score_cert"]), opt, P)
            self.assertLess(abs(mpf(r["score_float"]) / opt - 1), mpf(10) ** -12, P)


def _mat(q):
    w, x, y, z = q
    n = w * w + x * x + y * y + z * z
    return [[(w * w + x * x - y * y - z * z) / n, 2 * (x * y - w * z) / n, 2 * (x * z + w * y) / n],
            [2 * (x * y + w * z) / n, (w * w - x * x + y * y - z * z) / n, 2 * (y * z - w * x) / n],
            [2 * (x * z - w * y) / n, 2 * (y * z + w * x) / n, (w * w - x * x - y * y + z * z) / n]]


def _tet_R():
    a = math.acos(-1 / 3)
    return math.asin(math.sin(a / 2) / math.sin(PI / 3))


if __name__ == "__main__":
    unittest.main(verbosity=1)
