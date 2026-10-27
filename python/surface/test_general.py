"""Tests of the certifier on the general surfaces (general.py): the 13 Catalan solids, the prisms and
the antiprisms. Exact structure of every solid, frames and holonomy, the committed test packings,
a cross-check against the TypeScript validator's verdicts on random configurations, and adversarial
rejections.

Run: python3 python/surface/test_general.py
"""

import copy
import json
import math
import os
import sys
import unittest
from fractions import Fraction as Fr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from mpmath import iv  # noqa: E402

from cert import CertError, certify, check_records  # noqa: E402
import general  # noqa: E402
from general import GENERAL_SOLIDS, GeneralSolid, SolidError, get_general  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))


def load(*parts):
    with open(os.path.join(*parts)) as fh:
        return json.load(fh)


def rec(solid, mode, N, s, pieces):
    return {"id": "test", "solid": solid, "mode": mode, "N": N, "P": len(pieces), "s": s,
            "pieces": [dict(face=f, x=x, y=y, theta=t) for f, x, y, t in pieces]}


def ok(r, eps="1e-9"):
    try:
        certify(r, eps)
        return True
    except CertError:
        return False


def mid(x):
    return float(x.mid)


def edge_point(S, s, f, k, t):
    """Point of edge k of face f at parameter t, as floats in f's frame."""
    a = S.frame_vertex(Fr(s), f, k)
    b = S.frame_vertex(Fr(s), f, k + 1)
    return (mid(a[0]) + t * (mid(b[0]) - mid(a[0])), mid(a[1]) + t * (mid(b[1]) - mid(a[1])))


def inward(S, s, f, k):
    a = S.frame_vertex(Fr(s), f, k)
    b = S.frame_vertex(Fr(s), f, k + 1)
    ex, ey = mid(b[0]) - mid(a[0]), mid(b[1]) - mid(a[1])
    L = math.hypot(ex, ey)
    return (-ey / L, ex / L)


def to_neighbour(S, s, f, k, p):
    """Express the point p (f's frame, floats) in the frame of the face glued to edge k."""
    g, l, T = S.glue(Fr(s), f, k)
    q = T.inverse().apply((iv.mpf(p[0]), iv.mpf(p[1])))
    return g, (mid(q[0]), mid(q[1])), T


class Structure(unittest.TestCase):
    def test_every_solid_is_built_and_checked_exactly(self):
        # planar, convex, counter-clockwise faces; every vertex strictly inside every other face plane;
        # closed surface; Euler; prism and antiprism faces regular and centred; cone angles in [pi, 2 pi)
        data = load(REPO, "data", "surface", "solids.json")["solids"]
        for name in GENERAL_SOLIDS:
            S = get_general(name)
            self.assertEqual(S.V - S.E + S.F, 2, name)
            # the combinatorics agree with the TypeScript code's (data/surface/solids.json)
            self.assertEqual(S.faces, data[name]["faces"], name)
            self.assertEqual([[list(e) for e in row] for row in S.adj], data[name]["adj"], name)
            for v, c in enumerate(S.cone):
                self.assertTrue((c - iv.pi).a > 0, (name, v))
                self.assertAlmostEqual(mid(c / iv.pi), data[name]["cone_angles_over_pi"][v], places=12)
            # Gauss-Bonnet: the defects sum to 4 pi
            total = sum((2 * iv.pi - c for c in S.cone), iv.mpf(0))
            d = total / iv.pi - 4
            self.assertLess(max(abs(float(d.a)), abs(float(d.b))), 1e-30, name)

    def test_regular_faces_are_the_regular_frames(self):
        for name in general.ARCHIMEDEAN + general.PRISMS + general.ANTIPRISMS:
            S = get_general(name)
            for f in range(S.F):
                M = S.sides[f]
                for k in range(M):
                    a = -iv.pi / 2 + iv.pi / M + 2 * iv.pi * k / M
                    R = 1 / (2 * iv.sin(iv.pi / M))
                    x, y = S.frame_vertex(Fr(1), f, k)
                    # the enclosures overlap and are tight
                    for u, w in ((x, R * iv.cos(a)), (y, R * iv.sin(a))):
                        self.assertTrue(u.a <= w.b and w.a <= u.b, (name, f, k))
                        self.assertLess(float(u.delta), 1e-35, (name, f, k))

    def test_catalan_faces_are_tangential_at_the_frame_origin(self):
        for name in general.CATALAN:
            S = get_general(name)
            r0 = None
            for f in range(S.F):
                for k in range(S.sides[f]):
                    a = S.frame_vertex(Fr(1), f, k)
                    b = S.frame_vertex(Fr(1), f, k + 1)
                    e = (b[0] - a[0], b[1] - a[1])
                    d = abs(a[0] * b[1] - a[1] * b[0]) / iv.sqrt(e[0] ** 2 + e[1] ** 2)
                    r0 = d if r0 is None else r0
                    self.assertLess(abs(mid(d - r0)), 1e-30, (name, f, k))

    def test_gluing_matches_edges_and_holonomy_is_the_cone_angle(self):
        for name in ("deltoidal_icositetrahedron", "rhombic_dodecahedron", "triakis_tetrahedron",
                     "pentagonal_icositetrahedron", "prism5", "antiprism4", "antiprism9") + general.ARCHIMEDEAN:
            S = get_general(name)
            s = Fr(7, 5)
            for f in range(S.F):
                for k in range(S.sides[f]):
                    g, l, T = S.glue(s, f, k)
                    self.assertEqual(S.adj[g][l], (f, k))
                    for (j, i) in ((l, k + 1), (l + 1, k)):
                        a = T.apply(S.frame_vertex(s, g, j))
                        b = S.frame_vertex(s, f, i)
                        self.assertLess(abs(mid(a[0] - b[0])) + abs(mid(a[1] - b[1])), 1e-30)
            for v in range(S.V):
                f0 = next(i for i, face in enumerate(S.faces) if v in face)
                k0 = S.faces[f0].index(v)
                T = general.identity()
                f, k = f0, (k0 - 1) % S.sides[f0]
                deg = sum(1 for face in S.faces if v in face)
                for _ in range(deg):
                    g, l, G = S.glue(Fr(1), f, k)
                    T = T.compose(G)
                    f, k = g, (l - 1) % S.sides[g]
                self.assertEqual(f, f0)
                ang = iv.atan2(T.s, T.c)
                cone = S.cone[v]
                d1 = abs(mid(ang) - mid(cone - 2 * iv.pi))
                d2 = abs(mid(ang) + mid(cone - 2 * iv.pi))
                self.assertLess(min(d1, d2), 1e-25, (name, v))

    def test_refuses_a_solid_with_a_vertex_sharper_than_pi(self):
        # a tall pyramid on a triangle: its apex has cone angle well below pi, where a piece's boundary
        # through the vertex would need more angle than the vertex has; the certifier refuses the solid
        data = {"needle": {"minpoly": ["-1", "1"], "interval": ["0", "2"], "D": None,
                           "V": [[["1"], ["0"], ["-1"]], [["-1"], ["1"], ["-1"]], [["-1"], ["-1"], ["-1"]], [["0"], ["0"], ["20"]]],
                           "faces": [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]]}}
        with self.assertRaisesRegex(SolidError, "cone angle"):
            GeneralSolid("needle", data)
        # a face listed clockwise is refused too
        bad = copy.deepcopy(data)
        bad["needle"]["V"][3] = [["0"], ["0"], ["1"]]
        bad["needle"]["faces"][0] = [0, 1, 2]
        with self.assertRaisesRegex(SolidError, "counter-clockwise"):
            GeneralSolid("needle", bad)
        # an open surface
        bad = copy.deepcopy(data)
        bad["needle"]["V"][3] = [["0"], ["0"], ["1"]]
        bad["needle"]["faces"] = bad["needle"]["faces"][:3]
        with self.assertRaises(SolidError):
            GeneralSolid("needle", bad)


class ArchimedeanPackings(unittest.TestCase):
    def test_constructed_packings_certify(self):
        packings = load(HERE, "fixtures", "archimedean_packings.json")["packings"]
        self.assertEqual(len(packings), 24)
        for name in ("truncated_tetrahedron", "cuboctahedron", "snub_cube", "truncated_icosidodecahedron"):
            S = get_general(name)
            for N in (0, 3, 12):
                for mode in ("fold", "nofold"):
                    r = next(p for p in packings if (p["solid"], p["N"], p["mode"]) == (name, N, mode))
                    c = certify(r, "1e-12")
                    if mode == "fold":
                        self.assertEqual(c["method"], "chains", r["id"])
                        self.assertFalse(ok(dict(r, mode="nofold"), "1e-12"), r["id"])
                    else:
                        self.assertEqual({S.sides[p["face"]] for p in r["pieces"]}, set(S.sides))
                        self.assertLess(len({p["face"] for p in r["pieces"]}), r["P"])
                        self.assertEqual(certify(dict(r, mode="fold"), "1e-12")["method"], "inside_faces")

    def test_exact_cone_angles_and_unit_normalisation(self):
        expected = (Fr(5, 3), Fr(5, 3), Fr(11, 6), Fr(11, 6), Fr(11, 6), Fr(23, 12),
                    Fr(11, 6), Fr(28, 15), Fr(29, 15), Fr(29, 15), Fr(29, 15), Fr(59, 30), Fr(29, 15))
        for name, want in zip(general.ARCHIMEDEAN, expected, strict=True):
            S = get_general(name)
            for v in range(S.V):
                exact = sum((S.corner_pi[f][k] for f, face in enumerate(S.faces)
                             for k, w in enumerate(face) if w == v), Fr(0))
                self.assertEqual(exact, want, (name, v))
        name = "truncated_tetrahedron"
        bad = {name: copy.deepcopy(general.load_data()[name])}
        for p in bad[name]["V"]:
            for coords in p:
                coords[:] = [str(2 * Fr(c)) for c in coords]
        with self.assertRaisesRegex(SolidError, "unit edges"):
            GeneralSolid(name, bad)


class TestPackings(unittest.TestCase):
    """The committed test packings (python/surface/fixtures/general_packings.json)."""

    @classmethod
    def setUpClass(cls):
        cls.recs = load(HERE, "fixtures", "general_packings.json")["records"]

    def test_variety(self):
        kinds = {(r["solid"], r["N"], r["mode"]) for r in self.recs}
        for solid in ("deltoidal_icositetrahedron", "rhombic_dodecahedron", "prism5", "antiprism4"):
            for N in (0, 3, 6):
                for mode in ("fold", "nofold"):
                    self.assertIn((solid, N, mode), kinds)

    def test_all_certify_at_1e12(self):
        # One pass certifies every packing, and also counts what it covered: N = 3, 7, 12, 20 and 100 on a
        # Platonic and a Catalan solid, a prism and an antiprism, folded and not, each certified here
        # (a 100-gon packing certifies in a few seconds)
        import time

        done = set()
        for r in self.recs:
            t = time.time()
            c = certify(r, "1e-12")
            if r["N"] == 100:
                self.assertLess(time.time() - t, 30, r["id"])
            done.add((r["solid"], r["N"], r["mode"]))
            self.assertGreaterEqual(Fr(c["score_cert"]), Fr(r["s"]) / (1 - Fr("1e-12")))
            if r["mode"] == "fold" and r["solid"] in GENERAL_SOLIDS:
                # these packings cross edges: the chain path certified them, not the nofold lemma
                self.assertEqual(c["method"], "chains", r["id"])
        for solid in ("cube", "rhombic_dodecahedron", "prism7", "antiprism5"):
            for N in (3, 7, 12, 20, 100):
                for mode in ("fold", "nofold"):
                    self.assertIn((solid, N, mode), done)

    def test_nofold_packings_are_fold_packings(self):
        for r in self.recs:
            if r["mode"] == "nofold":
                c = certify(dict(r, mode="fold"), "1e-12")
                if r["solid"] in GENERAL_SOLIDS:
                    self.assertEqual(c["method"], "inside_faces", r["id"])

    def test_every_packing_is_tight(self):
        # the solid shrunk by 1e-7 relative: some contact (pair, wall or cone point) is violated
        for r in self.recs:
            self.assertFalse(ok(dict(r, s=r["s"] * (1 - 1e-7)), "1e-12"), r["id"])

    def test_fold_packings_fail_as_nofold(self):
        for r in self.recs:
            if r["mode"] == "fold":
                self.assertFalse(ok(dict(r, mode="nofold"), "1e-12"), r["id"])

    def test_records_mode_on_a_test_packing(self):
        from cert import certified_score

        r = copy.deepcopy(self.recs[0])
        r["id"] = "surface/%s/%s/%d/%d" % (r["solid"], r["mode"], r["N"], r["P"])
        r["eps"] = "1e-12"
        r["score_float"] = r["s"]
        r["score_cert"], r["display"] = certified_score(r["s"], "1e-12")
        lines = []
        self.assertEqual(check_records([r], log=lines.append), (1, 0), lines)
        bad = dict(copy.deepcopy(r), id="surface/%s/%s/%d/%d" % (r["solid"], r["mode"], r["N"], r["P"] + 1))
        self.assertEqual(check_records([bad], log=lines.append), (0, 1))


class CrossCheck(unittest.TestCase):
    def test_agrees_with_the_typescript_validator(self):
        data = load(HERE, "fixtures", "crosscheck_general.json")["cases"]
        self.assertGreaterEqual(len(data), 150)
        self.assertGreaterEqual(sum(1 for c in data if c["ts_valid"]), 60)
        for c in data:
            self.assertEqual(ok(c, "1e-9"), c["ts_valid"], c["id"])


class Adversarial(unittest.TestCase):
    def test_piece_crossing_an_edge_in_nofold(self):
        # the tight tiling of 12 triangles on the square antiprism (side 2): move one piece 2e-9 outward
        r = next(x for x in load(HERE, "fixtures", "general_packings.json")["records"]
                 if x["id"] == "surface/antiprism4/nofold/3/12")
        self.assertTrue(ok(r, "1e-12"))
        S = get_general("antiprism4")
        moved = 0
        for i, p in enumerate(r["pieces"]):
            f = p["face"]
            for k in range(S.sides[f]):
                # the piece touching edge k: some piece vertex on the edge line
                a = S.frame_vertex(Fr(r["s"]), f, k)
                b = S.frame_vertex(Fr(r["s"]), f, k + 1)
                nx, ny = inward(S, r["s"], f, k)
                R = 1 / math.sqrt(3)
                gaps = [nx * (p["x"] + R * math.cos(p["theta"] + math.pi / 2 + 2 * math.pi * j / 3) - mid(a[0]))
                        + ny * (p["y"] + R * math.sin(p["theta"] + math.pi / 2 + 2 * math.pi * j / 3) - mid(a[1]))
                        for j in range(3)]
                if min(gaps) < 1e-9:
                    q = copy.deepcopy(r)
                    q["pieces"][i]["x"] -= 2e-9 * nx
                    q["pieces"][i]["y"] -= 2e-9 * ny
                    self.assertFalse(ok(q, "1e-10"), (i, k))
                    self.assertTrue(ok(q, "1e-8"), (i, k))
                    moved += 1
                    break
            if moved >= 3:
                break
        self.assertGreaterEqual(moved, 3)
        _ = (a, b)

    def test_overlap_across_a_fold(self):
        # two pieces mirrored across the midpoint of a shared edge, on the two faces: their distance
        # through the edge is 2 d; disks overlap below d = 1, and the fold certifier sees it
        for name in ("deltoidal_icositetrahedron", "rhombic_dodecahedron", "prism5", "antiprism4"):
            S = get_general(name)
            s = 6.0
            f, k = 0, 0
            m = edge_point(S, s, f, k, 0.5)
            nx, ny = inward(S, s, f, k)
            for d, want in ((1 - 1e-9, False), (1 + 1e-9, True)):
                p = (m[0] + d * nx, m[1] + d * ny)
                g, q, _ = to_neighbour(S, s, f, k, (m[0] - d * nx, m[1] - d * ny))
                r = rec(name, "fold", 0, s, [(f, p[0], p[1], 0.0), (g, q[0], q[1], 0.0)])
                self.assertEqual(ok(r, "1e-12"), want, (name, d))
            # hexagons whose corners interpenetrate across the edge
            d = 0.8
            p = (m[0] + d * nx, m[1] + d * ny)
            g, q, T = to_neighbour(S, s, f, k, (m[0] - d * nx, m[1] - d * ny))
            r = rec(name, "fold", 6, s, [(f, p[0], p[1], 0.1), (g, q[0], q[1], 0.1)])
            self.assertFalse(ok(r, "1e-12"), name)
            with self.assertRaisesRegex(CertError, "separate|cone"):
                certify(r, "1e-12")

    def test_many_sided_pieces_meeting_across_an_edge(self):
        # two regular N-gons with a side parallel to a shared edge, each centred an apothem (1 -+ 1e-9)
        # from it on its own face: they overlap across the fold by 2e-9 apothems, or keep that gap
        for name, f in (("prism7", None), ("rhombic_dodecahedron", 0), ("antiprism5", None)):
            S = get_general(name)
            s = 120.0
            if f is None:
                # an edge between a square (prism) or a triangle (antiprism) and the n-gon
                f = next(i for i in range(S.F) if S.sides[i] == max(S.sides))
            k = 0
            g, l, _ = S.glue(Fr(s), f, k)
            m = edge_point(S, s, f, k, 0.5)
            nf = inward(S, s, f, k)
            for N in (7, 100):
                rin = 1 / (2 * math.tan(math.pi / N))
                for delta, want in ((-1e-9, False), (1e-9, True)):
                    d = rin * (1 + delta)
                    p = (m[0] + d * nf[0], m[1] + d * nf[1])
                    g, q, _ = to_neighbour(S, s, f, k, (m[0] - d * nf[0], m[1] - d * nf[1]))
                    # side 0's outward normal (angle theta + pi/2 + pi/N) points at the edge
                    th_f = math.atan2(-nf[1], -nf[0]) - math.pi / 2 - math.pi / N
                    ng = inward(S, s, g, l)
                    th_g = math.atan2(-ng[1], -ng[0]) - math.pi / 2 - math.pi / N
                    r = rec(name, "fold", N, s, [(f, p[0], p[1], th_f), (g, q[0], q[1], th_g)])
                    self.assertEqual(ok(r, "1e-12"), want, (name, N, delta))

    def test_piece_over_a_vertex(self):
        # the sharpest vertex of the new solids (triakis tetrahedron, cone angle 1.119 pi) and the
        # other kinds: a disk 1 - 1e-9 from the vertex covers it; 1 + 1e-9 away it is fine
        for name in ("triakis_tetrahedron", "deltoidal_icositetrahedron", "rhombic_dodecahedron", "prism3", "antiprism4") + general.ARCHIMEDEAN:
            S = get_general(name)
            s = 8.0
            kinds = {}
            for v, c in enumerate(S.cone):
                kinds.setdefault(round(mid(c), 9), v)
            for v in kinds.values():
                f = next(i for i, face in enumerate(S.faces) if v in face)
                k = S.faces[f].index(v)
                V = S.frame_vertex(Fr(s), f, k)
                vx, vy = mid(V[0]), mid(V[1])
                L = math.hypot(vx, vy)
                for d, want in ((1 - 1e-9, False), (1 + 1e-9, True)):
                    r = rec(name, "fold", 0, s, [(f, vx * (1 - d / L), vy * (1 - d / L), 0.0)])
                    self.assertEqual(ok(r, "1e-12"), want, (name, v, d))
                # a square with a corner 1e-9 over the vertex, pointing at it
                h = math.sqrt(0.5) - 1e-9
                ang = math.atan2(vy, vx)
                r = rec(name, "fold", 4, s, [(f, vx * (1 - h / L), vy * (1 - h / L), ang - math.pi / 2)])
                with self.assertRaisesRegex(CertError, "cone point"):
                    certify(r, "1e-12")

    def test_wrapping_pieces_never_pass(self):
        # pieces larger than the whole surface (below the area bound): always rejected (cone point,
        # a piece wrapping onto itself, or the chain limit), never certified
        for name in ("prism3", "antiprism4", "rhombic_dodecahedron", "triakis_tetrahedron"):
            S = get_general(name)
            area = 0.0
            for f in range(S.F):
                P = [S.frame_vertex(Fr(1), f, k) for k in range(S.sides[f])]
                area += sum(mid(P[k][0] * P[(k + 1) % len(P)][1] - P[(k + 1) % len(P)][0] * P[k][1]) for k in range(len(P))) / 2
            for N in (0, 3, 8):
                a = math.pi if N == 0 else N / (4 * math.tan(math.pi / N))
                for k in (0.3, 0.95):
                    s = k * math.sqrt(a / area)
                    for th in (0.0, 0.7):
                        self.assertFalse(ok(rec(name, "fold", N, s, [(0, 0.0, 0.0, th)]), "1e-12"), (name, N, s))

    def test_degenerate_and_malformed_input(self):
        S = get_general("prism5")
        V = S.frame_vertex(Fr(3), 0, 0)
        at_vertex = rec("prism5", "fold", 0, 3.0, [(0, mid(V[0]), mid(V[1]), 0.0)])
        with self.assertRaises(CertError):
            certify(at_vertex, "1e-12")
        m = edge_point(S, 3.0, 0, 1, 0.5)
        on_edge = rec("prism5", "fold", 3, 3.0, [(0, m[0], m[1], 0.0)])
        with self.assertRaises(CertError):
            certify(on_edge, "1e-12")
        good = rec("prism5", "fold", 0, 3.0, [(0, 0.0, 0.0, 0.0)])
        self.assertTrue(ok(good))
        for change in ({"solid": "prism4"}, {"solid": "elongated_cube"}, {"solid": 5}, {"N": 2}, {"N": -1},
                       {"s": -1.0}, {"s": float("nan")}, {"P": 2}, {"mode": "flat"}, {"pieces": "x"}):
            with self.assertRaises(CertError):
                certify(dict(good, **change), "1e-12")
        for piece in ({"face": 7, "x": 0.0, "y": 0.0, "theta": 0.0}, {"face": -1, "x": 0.0, "y": 0.0},
                      {"face": 0, "x": float("inf"), "y": 0.0}, {"face": 0, "x": "0", "y": 0.0}, {"face": 0.5, "x": 0.0, "y": 0.0},
                      {"face": 0, "x": 1e7, "y": 0.0}, 3):
            with self.assertRaises(CertError):
                certify(dict(good, pieces=[piece]), "1e-12")
        # a centre outside its anchor face
        with self.assertRaisesRegex(CertError, "face"):
            certify(rec("prism5", "fold", 0, 3.0, [(0, 50.0, 0.0, 0.0)]), "1e-12")
        # records mode reports malformed general records as FAIL and goes on
        lines = []
        self.assertEqual(check_records([dict(good, solid="prism4"), None], log=lines.append), (0, 2))


if __name__ == "__main__":
    unittest.main(verbosity=1)
