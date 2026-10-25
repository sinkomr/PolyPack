"""Tests of the boundary space's exact certifier (tesseract, "3D on 4D"): the lattice-word
developments, the records, adversarial configurations, and a cross-check against the TypeScript
engine's validator, distances and parts (fixtures/crosscheck.json, written by
packages/boundary/scripts/gen-crosscheck.ts).

Run: python3 python/boundary/test_boundary.py
"""

import copy
import io
import json
import math
import os
import sys
import time
import unittest
from contextlib import redirect_stdout
from fractions import Fraction as Fr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_records  # noqa: E402
import certify as C  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
RECORDS = os.path.join(REPO, "data", "boundary", "records.json")


def load(*parts):
    with open(os.path.join(*parts)) as fh:
        return json.load(fh)


def pid(piece, P):
    return f"boundary/tesseract/{piece}/{P}"


def shrink(config, k):
    return {"s": config["s"] * k, "pieces": [dict(p, u=[x * k for x in p["u"]]) for p in config["pieces"]]}


def valid(problem, config, strict=False):
    return C.check(problem, config, strict=strict).ok


def ball(cell, u):
    return {"cell": cell, "u": list(u)}


class Words(unittest.TestCase):
    """The developments: every word's map is the unfolding of the cells it passes."""

    def test_counts(self):
        for c0 in range(8):
            ws = [w for lst in C.words_by_end(c0).values() for w in lst]
            self.assertEqual(len(ws), 1957)
            self.assertEqual(len({w.steps for w in ws}), 1957)
            # monotone per axis, at most 2 crossings per axis, levels 2 m + tau
            for w in ws:
                m = [0, 0, 0]
                for (k, tau, level) in w.steps:
                    self.assertTrue(m[k] == 0 or (m[k] > 0) == (tau > 0))
                    self.assertEqual(level, 2 * m[k] + tau)
                    m[k] += tau
                self.assertEqual(tuple(m), w.m)
                self.assertTrue(all(abs(x) <= 2 for x in m))

    def test_maps_are_unfoldings(self):
        # cube m develops onto the end cell, and a word and its one-step extension agree on the
        # 2-face they share (the gluing fixes the 2-face): exact integer identities, at h = 1
        for c0 in range(8):
            ws = {w.steps: w for lst in C.words_by_end(c0).values() for w in lst}
            for w in ws.values():
                for k in range(3):  # A is a signed permutation
                    self.assertEqual(sum(abs(w.A[r][k]) for r in range(4)), 1)
                self.assertEqual(len({r for (r, _, _) in w.cols}), 3)
                i, sg = C.cell_of(w.cell)
                centre = [sum(w.A[r][k] * 2 * w.m[k] for k in range(3)) + w.b[r] for r in range(4)]
                self.assertEqual(centre, [sg if r == i else 0 for r in range(4)])
                self.assertNotIn(i, [r for (r, _, _) in w.cols])  # the cube lies in the end cell's hyperplane
                if not w.steps:
                    continue
                parent = ws[w.steps[:-1]]
                k, tau, level = w.steps[-1]
                for l in range(3):
                    if l != k:
                        self.assertEqual([w.A[r][l] for r in range(4)], [parent.A[r][l] for r in range(4)])
                face_point = [w.A[r][k] * level + w.b[r] for r in range(4)]
                self.assertEqual(face_point, [parent.A[r][k] * level + parent.b[r] for r in range(4)])

    def test_holonomy_around_an_edge(self):
        # two straight ways round the edge u0 = u1 = h of cell 0 reach the same cell with maps that
        # differ by a quarter turn about the edge (cone angle 3 pi/2: three cells round an edge)
        ws = {w.steps: w for lst in C.words_by_end(0).values() for w in lst}
        a = ws[((1, 1, 1),)]
        b = ws[((0, 1, 1), (1, 1, 1))]
        self.assertEqual(a.cell, b.cell)
        self.assertNotEqual(a.A, b.A)
        for t in (-1, 0, 1):  # points of the edge line y0 = y1 = 1 map alike
            y = (1, 1, t)
            xa = [sum(a.A[r][k] * y[k] for k in range(3)) + a.b[r] for r in range(4)]
            xb = [sum(b.A[r][k] * y[k] for k in range(3)) + b.b[r] for r in range(4)]
            self.assertEqual(xa, xb)

    def test_loop_words_need_two_double_crossings(self):
        # every word ending in its start cell crosses two axes twice, so a realized loop is at least
        # 2h sqrt 2 = s sqrt 2 >= 2 long once s >= sqrt 2 (and words cover every loop shorter than 2 s)
        for c0 in range(8):
            loops = [w for w in C.words_by_end(c0).get(c0, []) if w.steps]
            self.assertEqual(len(loops), 264)
            for w in loops:
                self.assertGreaterEqual(sum(1 for x in w.m if abs(x) == 2), 2)

    def test_three_crossings_per_axis_change_nothing(self):
        # empirical check of the completeness bound: words with up to 3 crossings per axis find no
        # path shorter than 2 s that the words with up to 2 miss (lengths and the set of short paths)
        t0 = time.time()
        for r in load(RECORDS)["records"]:
            if r["piece"] != "ball" or r["P"] not in (8, 9):
                continue
            cfg = C.parse(r["id"], r["config"])
            lim = (4 * cfg.H) ** 2  # (2 s)^2 = (4 h)^2, scaled
            for a in range(cfg.P):
                for b in range(cfg.P):
                    for mmax in (2, 3):
                        by = C.words_by_end(cfg.cells[a], mmax)
                        L = []
                        for c in C.cells_containing(cfg.X[b], cfg.H):
                            for w in by.get(c, ()):
                                if a == b and not w.steps:
                                    continue
                                x = C.realized_sq(w, cfg.U[a], cfg.X[b], cfg.H)
                                if x is not None and x < lim:
                                    L.append(x)
                        if mmax == 2:
                            short2 = sorted(L)
                        else:
                            self.assertEqual(sorted(L), short2, (r["id"], a, b))
        print(f"  [mmax 3 against 2 on balls P = 8 and 9: {time.time() - t0:.1f} s]", file=sys.stderr)


class Closures(unittest.TestCase):
    def test_clearance_closed_form(self):
        cfg = C.parse(pid("ball", 1), {"s": 3.0, "pieces": [ball(5, [0.5, -0.25, 1.0])]})
        # h = 1.5: slacks (1, 1.25, 0.5); min over pairs: hypot(1, 0.5)
        self.assertEqual(Fr(C.clearance_sq(cfg.U[0], cfg.H), cfg.D ** 2), Fr(5, 4))

    def test_one_ball_bound_attained_only_above_sqrt2(self):
        s2 = math.sqrt(2)  # binary64 sqrt 2 is above sqrt 2
        self.assertGreater(Fr(s2) ** 2, 2)
        self.assertTrue(valid(pid("ball", 1), {"s": s2, "pieces": [ball(0, [0, 0, 0])]}, strict=True))
        below = math.nextafter(s2, 0)
        self.assertLess(Fr(below) ** 2, 2)
        self.assertFalse(valid(pid("ball", 1), {"s": below, "pieces": [ball(0, [0, 0, 0])]}))

    def test_two_opposite_balls_and_a_third_that_does_not_fit(self):
        s = math.sqrt(2) * (1 + 1e-12)
        two = {"s": s, "pieces": [ball(0, [0, 0, 0]), ball(1, [0, 0, 0])]}
        self.assertTrue(valid(pid("ball", 2), two, strict=True))
        adj = {"s": s, "pieces": [ball(0, [0, 0, 0]), ball(2, [0, 0, 0])]}
        self.assertFalse(valid(pid("ball", 2), adj))  # adjacent cell centres are s < 2 apart

    def test_exact_rational_input(self):
        # strings are exact rationals: a cube filling its cell at s = 1 is valid, not strictly
        cfg = {"s": "1", "pieces": [{"cell": 3, "u": ["0", "0", "0"]}]}
        self.assertTrue(valid(pid("cube", 1), cfg))
        self.assertFalse(valid(pid("cube", 1), cfg, strict=True))
        cfg["s"] = "1000000000001/1000000000000"
        self.assertTrue(valid(pid("cube", 1), cfg, strict=True))


class Records(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load(RECORDS)
        cls.recs = cls.data["records"]

    def test_32_problems(self):
        ids = [r["id"] for r in self.recs]
        self.assertEqual(ids, [pid(p, P) for p in ("ball", "cube") for P in range(1, 17)])
        self.assertEqual(self.data["generated"], build_records.GENERATED)

    def test_every_record_certifies(self):
        t0 = time.time()
        for r in self.recs:
            cert = C.certify_record(r)
            self.assertTrue(cert["valid"] and cert["strict"], r["id"])
            for k in ("min_clearance", "min_distance", "min_loop", "min_edge_slack", "min_part_separation"):
                if k in r["certificate"]:
                    self.assertEqual(cert[k], r["certificate"][k], (r["id"], k))
        lines = []
        ok, bad = C.check_records(self.recs, log=lines.append)
        self.assertEqual((ok, bad), (32, 0), lines)
        print(f"  [32 records certified twice: {time.time() - t0:.1f} s]", file=sys.stderr)

    def test_command_line(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = C.main([RECORDS])
        self.assertEqual(code, 0)
        self.assertIn("certified 32, failed 0", out.getvalue())

    def test_shrunk_copy_fails(self):
        for r in self.recs:
            self.assertFalse(valid(r["id"], shrink(r["config"], 1 - 1e-6)), r["id"])

    def test_ladder_rule(self):
        src = load(REPO, "data", "boundary", "sources", "research_round2.json")
        exact = build_records.exact_configs()
        for r in self.recs:
            k = r["certificate"]["k"]
            if (r["piece"], r["P"]) in exact:
                base = exact[(r["piece"], r["P"])][0]
            else:
                base = build_records.research_config(src["balls" if r["piece"] == "ball" else "cubes"][str(r["P"])])
            self.assertEqual(base["s"], r["score_float"])
            lam, cfg = build_records.scaled(base, k)
            self.assertEqual(cfg, r["config"], r["id"])
            self.assertEqual(lam, r["certificate"]["lambda"])
            for j in range(1, k):  # no smaller k certifies
                self.assertFalse(valid(r["id"], build_records.scaled(base, j)[1], strict=True), (r["id"], j))

    def test_build_is_reproducible(self):
        with redirect_stdout(io.StringIO()):
            fresh = build_records.build()
        self.assertEqual(json.loads(json.dumps(fresh)), self.data)

    def test_status_bounds_and_nofold(self):
        for r in self.recs:
            self.assertEqual(r["status"], "best_known", r["id"])
            self.assertEqual(r["display"], C.display_6(r["score_cert"]))
            self.assertLessEqual(r["score_float"], r["score_cert"])
            kinds = {k: ok for k, _, ok in C.lower_bounds(r["piece"], r["P"])}
            self.assertEqual({b["kind"] for b in r["bounds"]}, set(kinds))
            for b in r["bounds"]:
                # the stored bound is the largest float not above the proven bound
                self.assertTrue(kinds[b["kind"]](Fr(b["value"])))
                self.assertFalse(kinds[b["kind"]](Fr(math.nextafter(b["value"], math.inf))))
                self.assertLessEqual(Fr(b["value"]), Fr(r["score_cert"]))
                self.assertTrue(b["label"].startswith("[CALC]") and b["rigorous"])
            self.assertEqual(r["bound"], max(r["bounds"], key=lambda b: b["value"]))
            nf = r["nofold"]
            per = -(-r["P"] // 8)
            self.assertEqual(nf["pieces_per_cell"], per)
            want = {("ball", 1): 2.0, ("ball", 2): 2 + 2 / math.sqrt(3), ("cube", 1): 1.0, ("cube", 2): 2.0}[(r["piece"], per)]
            self.assertEqual(nf["value"], want)
            self.assertAlmostEqual(r["fold_gain"], 1 - r["score_float"] / want, places=15)
            self.assertGreaterEqual(r["fold_gain"], 0)
        by = {r["id"]: r for r in self.recs}
        for P in (1, 2):  # meet the one-ball bound sqrt 2 to 1e-12, still best_known
            self.assertLess(by[pid("ball", P)]["bound_gap_rel"], 2e-12)
            self.assertEqual(by[pid("ball", P)]["bound"]["kind"], "one piece")

    def test_catalogue_fields(self):
        # what packages/spaces buildSpaceCatalogue reads: id, the id's fields, status, score_cert,
        # display, the configuration in the submission format with P pieces, bound {value, label}
        for r in self.recs:
            m = C.ID_RE.match(r["id"])
            self.assertEqual((r["polytope"], r["piece"], r["P"]), (m.group(1), m.group(2), int(m.group(3))))
            self.assertIsInstance(r["score_cert"], float)
            self.assertIsInstance(r["display"], str)
            self.assertEqual(set(r["config"]), {"s", "pieces"})
            self.assertEqual(len(r["config"]["pieces"]), r["P"])
            for p in r["config"]["pieces"]:
                self.assertEqual(set(p), {"cell", "u"})
            self.assertIsInstance(r["bound"]["value"], float)
            self.assertIsInstance(r["bound"]["label"], str)

    def test_tampered_records_fail(self):
        good = self.recs[20]  # boundary/tesseract/cube/5
        self.assertEqual(good["id"], pid("cube", 5))
        bad = []
        r = copy.deepcopy(good); r["score_cert"] = r["score_cert"] * (1 - 1e-6); bad.append(r)
        r = copy.deepcopy(good); r["display"] = "1.000001"; bad.append(r)
        r = copy.deepcopy(good); r["status"] = "proven"; bad.append(r)
        r = copy.deepcopy(good); r["status"] = "optimal"; bad.append(r)
        r = copy.deepcopy(good); r["P"] = 6; bad.append(r)
        r = copy.deepcopy(good); r["id"] = pid("cube", 6); bad.append(r)
        r = copy.deepcopy(good); r["bound"]["value"] = 1.2; bad.append(r)
        r = copy.deepcopy(good); r["bound"]["value"] = 0.8; bad.append(r)  # weaker than the proven (5/8)^(1/3) = 0.854988: still a valid bound
        r = copy.deepcopy(good); r["score_float"] = r["score_cert"] * 2; bad.append(r)
        r = copy.deepcopy(good); r["config"]["s"] = good["config"]["s"] * (1 - 1e-6); r["score_cert"] = r["config"]["s"]; r["display"] = C.display_6(r["score_cert"]); bad.append(r)
        r = copy.deepcopy(good); r["config"]["pieces"][0]["u"][0] = 0.4; bad.append(r)
        r = copy.deepcopy(good); r["config"]["pieces"].pop(); bad.append(r)
        r = copy.deepcopy(good); del r["config"]; bad.append(r)
        bad += [None, [], "x", {"id": 3}]
        lines = []
        ok, nbad = C.check_records(bad, log=lines.append)
        # the 0.8 bound is valid (below the proven 0.854988) and must pass: one OK, the rest FAIL
        self.assertEqual((ok, nbad), (1, len(bad) - 1), "\n".join(lines))
        self.assertTrue(lines[7].startswith("OK"), lines[7])


class Adversarial(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = {c["id"]: c for c in load(HERE, "fixtures", "adversarial.json")["cases"]}

    def verdicts(self, name):
        c = self.cases[name]
        p = pid(c["piece"], c["P"])
        return C.check(p, c["config"], strict=False), C.check(p, c["config"], strict=True), c

    def test_all_expected(self):
        for name in self.cases:
            a, b, c = self.verdicts(name)
            self.assertEqual((a.ok, b.ok), (c["valid"], c["strict"]), (name, a.reasons, b.reasons))

    def test_balls_overlapping_across_a_ridge(self):
        a, _, _ = self.verdicts("adv/ball-pair-across-ridge-overlap")
        self.assertFalse(a.ok)
        c = self.cases["adv/ball-pair-across-ridge-overlap"]
        d = 2 * (2 - Fr(1.1))  # straight through the 2-face: (h - u) twice, exactly (1.1 as a binary64)
        self.assertEqual(a.margins["distance_sq"], d * d)
        self.assertEqual(C.ball_distances(pid("ball", 2), c["config"])[0][(0, 1)], d * d)

    def test_balls_overlapping_around_an_edge(self):
        a, _, c = self.verdicts("adv/ball-pair-around-an-edge")
        self.assertFalse(a.ok)
        d2 = a.margins["distance_sq"]
        self.assertAlmostEqual(math.sqrt(d2), 2 * 1.1 * math.sin(math.radians(60)), places=12)
        # the path crosses two 2-faces: cells 0 -> 3 -> 5
        cfg = C.parse(pid("ball", 2), c["config"])
        best = min(C.path_lengths_sq(cfg.cells[0], cfg.U[0], cfg.X[1], cfg.H), key=lambda t: t[0])
        self.assertEqual([k for (k, _, _) in best[1].steps], [0, 1])

    def test_ball_too_close_to_an_edge(self):
        a, _, _ = self.verdicts("adv/ball-near-an-edge")
        self.assertFalse(a.ok)
        self.assertIn("from an edge", a.reasons[0])
        a, b, _ = self.verdicts("adv/ball-on-an-edge-clearance-1")
        self.assertTrue(a.ok)
        self.assertFalse(b.ok)
        self.assertEqual(a.margins["clearance_sq"], 1)

    def test_cube_containing_an_edge_point(self):
        a, _, _ = self.verdicts("adv/cube-containing-an-edge-point")
        self.assertFalse(a.ok)
        self.assertIn("edge of the tesseract passes through its interior", a.reasons[0])
        a, b, _ = self.verdicts("adv/cube-touching-an-edge")
        self.assertTrue(a.ok)
        self.assertFalse(b.ok)

    def test_cube_parts_overlapping_in_one_cell(self):
        a, _, _ = self.verdicts("adv/cube-parts-overlap-in-one-cell")
        self.assertFalse(a.ok)
        self.assertEqual(a.margins["part_separation"], Fr(-1, 8))
        self.assertIn("in cell 3", a.reasons[0])
        a, b, _ = self.verdicts("adv/cube-parts-touch-in-one-cell")
        self.assertTrue(a.ok)
        self.assertFalse(b.ok)
        self.assertEqual(a.margins["part_separation"], 0)
        # the part across the 2-face, in cell 3's frame: x0 in [-1, -3/4], x2, x3 in [-1/2, 1/2]
        parts = C.cube_part_boxes(pid("cube", 2), self.cases["adv/cube-parts-touch-in-one-cell"]["config"])
        self.assertIn((0, 3, (Fr(-1), Fr(-1, 2), Fr(-1, 2)), (Fr(-3, 4), Fr(1, 2), Fr(1, 2))), parts)

    def test_strict_mode_sees_touching_across_a_2_face(self):
        a, b, _ = self.verdicts("adv/cubes-touch-across-a-2-face")
        self.assertTrue(a.ok)
        self.assertFalse(b.ok)

    def test_out_of_scope_and_malformed(self):
        base = {"s": 2.0, "pieces": [{"cell": 0, "u": [0.0, 0.0, 0.0]}]}
        turned = copy.deepcopy(base)
        turned["pieces"][0]["q"] = [math.cos(0.3), 0.0, 0.0, math.sin(0.3)]
        with self.assertRaises(C.CertError):
            C.check(pid("cube", 1), turned)
        same = copy.deepcopy(base)
        same["pieces"][0]["q"] = [-1.0, 0.0, 0.0, 0.0]
        self.assertTrue(valid(pid("cube", 1), same, strict=True))
        withq = copy.deepcopy(base)
        withq["pieces"][0]["q"] = [1.0, 0.0, 0.0, 0.0]
        bad = [
            (pid("ball", 2), base), (pid("ball", 1), withq), ("boundary/tesseract/ball/01", base),
            ("boundary/24-cell/ball/1", base), ("boundary/tesseract/octahedron/1", base),
            (pid("ball", 1), {"s": float("nan"), "pieces": base["pieces"]}), (pid("ball", 1), {"s": 0.0, "pieces": base["pieces"]}),
            (pid("ball", 1), {"s": 2e6, "pieces": base["pieces"]}), (pid("ball", 1), {"s": True, "pieces": base["pieces"]}),
            (pid("ball", 1), {"s": 2.0, "pieces": [{"cell": 8, "u": [0, 0, 0]}]}),
            (pid("ball", 1), {"s": 2.0, "pieces": [{"cell": 0, "u": [0, 0]}]}),
            (pid("ball", 1), {"s": 2.0, "pieces": [{"cell": 0, "u": [0, 0, float("inf")]}]}),
            (pid("ball", 1), {"s": 2.0, "pieces": [{"cell": 0, "u": [0, 0, 0], "r": 1}]}),
            (pid("ball", 1), {"s": 2.0, "pieces": [{"cell": True, "u": [0, 0, 0]}]}),
            (pid("ball", 1), {"s": "x", "pieces": base["pieces"]}), (pid("ball", 1), []), (pid("ball", 1), {"s": 2.0}),
        ]
        for problem, cfg in bad:
            with self.assertRaises(C.CertError, msg=(problem, cfg)):
                C.check(problem, cfg)


class CrossCheck(unittest.TestCase):
    """Agreement with the TypeScript engine (float validator at tol 1e-9 and 0, chain distances, parts)."""

    @classmethod
    def setUpClass(cls):
        cls.cases = load(HERE, "fixtures", "crosscheck.json")["cases"]

    @staticmethod
    def exact_margin(c):
        """(m, complete): the least margin over every constraint (>= 0 valid), as the engine
        measures it (distance - 2, clearance - 1, minus overlap depth); complete is False when some
        constraint could not be evaluated. A centre outside its cell gives minus its excess; a centre
        on its cell's boundary (excess exactly 0, which binary64 also gets exactly) is no margin."""
        p = pid(c["piece"], c["P"])
        cfg = C.parse(p, c["config"])
        s = float(cfg.s)
        ex = max(abs(x) for U in cfg.u for x in U) - cfg.h
        ms = [math.inf]
        if ex > 0:
            return -float(ex), False
        if c["piece"] == "ball":
            if c["P"] * 4 * math.pi / 3 > 8 * s ** 3 * (1 + 1e-6):
                return -math.inf, True
            pairs, loops, clear = C.ball_distances(p, c["config"])
            ms += [math.sqrt(x) - 1 for x in clear]
            ms += [math.sqrt(x) - 2 for x in list(pairs.values()) + list(loops.values()) if x is not None]
            return min(ms), True
        if c["P"] > 8 * s ** 3 * (1 + 1e-6):
            return -math.inf, True
        complete = True
        for n in range(cfg.P):
            _, edge, crossing = C.cube_parts(cfg, n, False)
            ms.append(float(Fr(edge, cfg.D)))
            complete = complete and len(crossing) <= 1
        if complete:
            boxes = C.cube_part_boxes(p, c["config"])
            for i in range(len(boxes)):
                for j in range(i + 1, len(boxes)):
                    a, b = boxes[i], boxes[j]
                    if a[1] == b[1]:
                        ms.append(float(max(max(b[2][t] - a[3][t], a[2][t] - b[3][t]) for t in range(3))))
        return min(ms), complete

    def test_verdicts(self):
        # the engine works in binary64: its margins carry errors of a few ulps (about 1e-15 here), so
        # verdicts are compared wherever the exact margin is more than EPS away from a threshold
        EPS = 1e-13
        t0 = time.time()
        compared = {"1e-9": 0, "0": 0}
        skipped = []
        undecided = []
        for c in self.cases:
            m, complete = self.exact_margin(c)
            ctx = (c["id"], m, c["ts_reason"])
            if m < -1e-9 - EPS:
                self.assertFalse(c["ts_valid_1e9"], ctx)
                self.assertFalse(c["ts_valid_0"], ctx)
                compared["1e-9"] += 1
                compared["0"] += 1
            elif complete and m > EPS:
                self.assertTrue(c["ts_valid_1e9"], ctx)
                self.assertTrue(c["ts_valid_0"], ctx)
                compared["1e-9"] += 1
                compared["0"] += 1
            elif complete and -1e-9 + EPS < m < -EPS:
                self.assertTrue(c["ts_valid_1e9"], ctx)
                self.assertFalse(c["ts_valid_0"], ctx)
                compared["1e-9"] += 1
                compared["0"] += 1
            elif complete and abs(m) <= EPS:
                self.assertTrue(c["ts_valid_1e9"], ctx)  # within the touching tolerance either way
                compared["1e-9"] += 1
                skipped.append(c["id"])
            else:
                undecided.append(c["id"])
        self.assertGreater(len(self.cases), 300)
        # tol 0 stays undecided only where the exact margin is within EPS of 0: the raw float
        # fixtures (contacts exact to rounding), exact adversarial contacts, and a few records
        self.assertEqual(undecided, [])
        self.assertGreaterEqual(compared["0"], 250)
        print(f"  [{len(self.cases)} cases; tol 1e-9 compared {compared['1e-9']}, tol 0 compared {compared['0']}, "
              f"tol 0 undecided at exact contacts: {len(skipped)}; {time.time() - t0:.1f} s]", file=sys.stderr)

    def test_fixtures_and_records(self):
        by = {c["id"]: c for c in self.cases}
        for piece in ("ball", "cube"):
            for P in range(1, 17):
                f = by[f"fixture:{pid(piece, P)}"]
                r = by[f"record:{pid(piece, P)}"]
                s = by[f"shrunk:{pid(piece, P)}"]
                self.assertTrue(f["ts_valid_1e9"])
                m, _ = self.exact_margin(f)
                self.assertGreater(m, -1e-9, f["id"])  # valid within the touching tolerance, exactly
                self.assertTrue(r["ts_valid_1e9"] and r["ts_valid_0"])
                self.assertTrue(valid(pid(piece, P), r["config"], strict=True))
                self.assertFalse(s["ts_valid_1e9"])
                self.assertFalse(valid(pid(piece, P), s["config"]))

    def test_ball_distances(self):
        n = 0
        for c in self.cases:
            if c["piece"] != "ball" or "pairs" not in c:
                continue
            p = pid(c["piece"], c["P"])
            pairs, loops, clear = C.ball_distances(p, c["config"])
            for (i, j, d) in c["pairs"]:
                py = pairs[(i, j)]
                py = None if py is None else math.sqrt(py)
                if (d is not None and d < 2.5 - 1e-9) or (py is not None and py < 2.5 - 1e-9):
                    self.assertIsNotNone(d, (c["id"], i, j, py))
                    self.assertIsNotNone(py, (c["id"], i, j, d))
                    self.assertAlmostEqual(py, d, delta=1e-9, msg=(c["id"], i, j))
                    n += 1
            for (i, d) in c["loops"]:
                py = loops[i]
                py = None if py is None else math.sqrt(py)
                if (d is not None and d < 2.5 - 1e-9) or (py is not None and py < 2.5 - 1e-9):
                    self.assertAlmostEqual(py, d, delta=1e-9, msg=(c["id"], "loop", i))
                    n += 1
            for i, x in enumerate(clear):
                py = math.sqrt(x)
                self.assertAlmostEqual(py, c["clearance_closed"][i], delta=1e-12)
                ch = c["clearance_chains"][i]
                if ch is not None or py < 1.5 - 1e-9:
                    self.assertAlmostEqual(py, ch, delta=1e-9, msg=(c["id"], "clearance", i))
        self.assertGreater(n, 500)

    def test_cube_parts(self):
        n = 0
        for c in self.cases:
            if c["piece"] != "cube" or "parts" not in c:
                continue
            p = pid(c["piece"], c["P"])
            mine = [(a, cell, [float(x) for x in lo], [float(x) for x in hi]) for (a, cell, lo, hi) in C.cube_part_boxes(p, c["config"])]
            mine = [t for t in mine if min(h - l for l, h in zip(t[2], t[3])) > 1e-12]  # the engine drops parts thinner than 1e-12
            theirs = [tuple(t) for t in c["parts"]]
            key = lambda t: (t[0], t[1], [round(x, 6) for x in t[2]])  # noqa: E731
            mine.sort(key=key)
            theirs.sort(key=key)
            self.assertEqual([(t[0], t[1]) for t in mine], [(t[0], t[1]) for t in theirs], c["id"])
            for a, b in zip(mine, theirs):
                for x, y in zip(a[2] + a[3], b[2] + b[3]):
                    self.assertAlmostEqual(x, y, delta=1e-9, msg=c["id"])
                n += 1
        self.assertGreater(n, 300)


if __name__ == "__main__":
    t0 = time.time()
    prog = unittest.main(exit=False, verbosity=1)
    print(f"test_boundary: {time.time() - t0:.1f} s", file=sys.stderr)
    sys.exit(0 if prog.result.wasSuccessful() else 1)
