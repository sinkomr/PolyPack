"""Exact certifier for PolyPack's boundary space on the tesseract ("3D on 4D").

Problem boundary/tesseract/<piece>/<P>: P balls of diameter 1 (radius 1/2) or unit cubes (edge 1) on the
boundary of the tesseract [-s/2, s/2]^4; the score is the edge s.

Units (2026-10-27): the configurations, records and reports are in SITE units (a ball has diameter 1). The ball
checks below were written for a ball of radius 1 and still run in that WORKING unit: Config multiplies s and every
centre of a ball configuration by BALL_WORK = 2 (exact in rationals), and everything reported is converted back by
Config.unit = 1/2 (squared lengths by 1/4). The statements below ("clearance >= 1", "centres >= 2 apart") are in the
working unit; in site units they read 1/2 and 1. Conventions are those of
packages/boundary/src/types.ts and docs/spaces/BOUNDARY.md:
  * cell c = 2 i + (sigma > 0) is the cube x_i = sigma s/2 (i = 0..3, sigma = -1 or +1);
  * its local coordinates u are the other three coordinates of R^4 in increasing order, so the
    cell is the cube [-h, h]^3 with h = s/2, centred at the origin;
  * a configuration is {s, pieces: [{cell, u, q?}]}, u at the configuration's s; q (cubes only)
    is a rotation, and this certifier handles axis-aligned cubes only (q absent or +-(1, 0, 0, 0)).

Every number is read as an exact rational (a binary64 float is a dyadic rational) and every
decision is made in exact integer arithmetic: all coordinates are put over one common
denominator. Nothing here uses floating point except the readable numbers in the reports. It
shares no code with the TypeScript engine (packages/boundary/src).

Validity ("fold" placement): (1) each centre lies in its closed anchor cell; (2) no point of the
1-skeleton (the tesseract's edges and vertices) lies in the interior of a developed piece; (3)
each development is injective on the piece's interior; (4) the interiors of distinct pieces are
disjoint. Strict validity: the closed pieces avoid the 1-skeleton, are embedded and pairwise
disjoint. Records are certified strictly valid at their stored s = score_cert.

Developments: every 2-face of the tesseract is a right angle, so the cells a straight path
crosses unfold into the cubes of the lattice 2h Z^3 (anchor cube at the origin). A path is
described by the sequence of lattice planes y_k = (2n + 1) h it crosses, a "word"; each word has a
fixed end cell and an exact development map y -> x = A y + h b (A a signed permutation, b an
integer vector), independent of the start point. See build_words and BOUNDARY.md section 4 for
why the words with at most 2 crossings per axis contain every path of length <= 2 once s > 1.

Balls use the distance form (BOUNDARY.md 4.2): valid iff every centre is at distance >= 1 from
the 1-skeleton (closed form, clearance_sq), every two centres are >= 2 apart and every geodesic
loop at a centre is >= 2 long (words). Strict: > instead of >=.

Axis-aligned cubes (BOUNDARY.md 4.3): the cube centred at u is the box u +- 1/2 in the
development. It is valid iff it crosses the faces of its cell in at most one axis; its parts are
then exact boxes (one in the anchor, one in the neighbour across the crossed face), and the parts
in each cell must be pairwise interior-disjoint (strict: closed boxes disjoint, faces touched
from inside count as crossed).

Usage:
  python3 python/boundary/certify.py data/boundary/records.json   (records mode; exit 1 on failure)
"""

import json
import math
import re
import sys
from decimal import ROUND_HALF_EVEN, Decimal
from fractions import Fraction

VERSION = "boundary-cert 1"
CHECKER = "python/boundary/certify.py"
MAX_P = 9999
MAX_S = Fraction(10) ** 4  # the engine's MAX_S (packages/boundary/src/validate.ts), in site units
BALL_RADIUS = Fraction(1, 2)  # a ball piece, site units (packages/boundary/src/units.ts)
BALL_WORK = 1 / BALL_RADIUS  # working length per site length for balls: the ball code below has radius 1
MMAX = 2
POLYTOPES = ("tesseract",)
PIECES = ("ball", "cube")
STATUSES = ("best_known", "proven")
ID_RE = re.compile(r"^boundary/(tesseract)/(ball|cube)/([1-9][0-9]{0,3})$")
# pi to 50 decimals, truncated: a rational lower bound and (adding 1e-50) an upper bound
PI_LO = Fraction("3.14159265358979323846264338327950288419716939937510")
PI_HI = PI_LO + Fraction(1, 10 ** 50)


class CertError(Exception):
    """Malformed input, a configuration outside this certifier's scope, or (certify) an invalid one."""


# ------------------------------------------------------------------ numbers


def to_fraction(v, what):
    """An exact rational from a JSON value: an int, a finite float (its exact binary value) or a
    string such as "3/2" or "1.25". Booleans and non-finite values are rejected."""
    if isinstance(v, bool):
        raise CertError(f"{what} must be a number")
    if isinstance(v, int):
        return Fraction(v)
    if isinstance(v, float):
        if not math.isfinite(v):
            raise CertError(f"{what} must be finite")
        return Fraction(v)
    if isinstance(v, str):
        try:
            x = Fraction(v.strip())
        except (ValueError, ZeroDivisionError):
            raise CertError(f"{what} is not a rational number: {v!r}") from None
        return x
    raise CertError(f"{what} must be a number")


def float_down(x):
    """The largest binary64 value <= the rational x (for reporting bounds that must not be overstated)."""
    f = float(x)
    while Fraction(f) > x:
        f = math.nextafter(f, -math.inf)
    while Fraction(math.nextafter(f, math.inf)) <= x:
        f = math.nextafter(f, math.inf)
    return f


def sqrt_down(x):
    """The largest binary64 value whose square is <= the rational x >= 0."""
    if x <= 0:
        return 0.0
    f = math.sqrt(float(x))
    while f > 0 and Fraction(f) ** 2 > x:
        f = math.nextafter(f, 0.0)
    while Fraction(math.nextafter(f, math.inf)) ** 2 <= x:
        f = math.nextafter(f, math.inf)
    return f


def display_6(x):
    """PolyPack's display rule for every space: the exact binary64 value of x rounded to the nearest
    at 6 decimals, ties to even, always 6 decimals."""
    return str(Decimal(x).quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN))


def fmt(x):
    return "%.10g" % float(x)


# ------------------------------------------------------------------ tesseract combinatorics


def cell_of(c):
    """Cell id -> (i, sigma): the cell x_i = sigma h."""
    return c >> 1, (1 if c & 1 else -1)


def axes(i):
    """The R^4 axes of the local coordinates of a cell normal to axis i, in increasing order."""
    return [j for j in range(4) if j != i]


def embed(c, u, h):
    """R^4 point of local coordinates u of cell c, at half-edge h (any exact numbers)."""
    i, sg = cell_of(c)
    x = [0, 0, 0, 0]
    x[i] = sg * h
    for k, j in enumerate(axes(i)):
        x[j] = u[k]
    return x


def cells_containing(x, h):
    """All cells whose closed cube contains the boundary point x (exact): x_i = sigma h."""
    out = []
    for i in range(4):
        if x[i] == h:
            out.append(2 * i + 1)
        elif x[i] == -h:
            out.append(2 * i)
    return out


class Word:
    """A path class: the lattice planes crossed, in order, from the anchor cell.

    steps: ((k, tau, level), ...): the crossing of the plane y_k = level h in direction tau;
    m: the lattice cube reached (cube m is [2 h m_k - h, 2 h m_k + h] per axis);
    cell: the cell that cube m is a copy of; A (4 x 3), b (4): its development map, at h = 1
    scaled as x = A y + h b. A is a signed permutation, so y = A^T (x - h b); `cols` stores, per
    lattice axis k, the R^4 row r and sign g of A's column k (y_k = g (x_r - h b_r)).
    """

    __slots__ = ("steps", "m", "cell", "A", "b", "cols")

    def __init__(self, steps, m, cell, A, b):
        self.steps = steps
        self.m = m
        self.cell = cell
        self.A = A
        self.b = b
        cols = []
        for k in range(3):
            nz = [r for r in range(4) if A[r][k] != 0]
            assert len(nz) == 1 and abs(A[nz[0]][k]) == 1
            cols.append((nz[0], A[nz[0]][k], b[nz[0]]))
        self.cols = tuple(cols)


def build_words(c0, mmax=MMAX):
    """Every word from cell c0 with at most mmax crossings per lattice axis, all in one direction
    per axis (a straight segment is monotone in each coordinate). Exact, as tess.py of the research
    prototype, re-derived:

    In cell c = (i, sg) the development direction tau e_k (lattice axis k) is the R^4 direction
    tj e_j given by A's column k. Moving that way the path meets the 2-face x_i = sg h, x_j = tj h
    and enters cell (j, tj). The unfolding is the rotation R about that 2-face in the plane
    (e_i, e_j) with R(sg e_i) = tj e_j (the old normal becomes the new one) and R(tj e_j) = -sg e_i
    (straight on becomes inward in the new cell); it fixes the 2-face pointwise. So the new map is
    x -> R (x - h q) + h q applied to the old one, q = sg e_i + tj e_j.
    """
    i0, sg0 = cell_of(c0)
    A0 = [[0, 0, 0] for _ in range(4)]
    for k, j in enumerate(axes(i0)):
        A0[j][k] = 1
    b0 = [0, 0, 0, 0]
    b0[i0] = sg0
    out = []
    stack = [((), (0, 0, 0), c0, A0, b0)]
    while stack:
        steps, m, c, A, b = stack.pop()
        out.append(Word(steps, m, c, tuple(tuple(r) for r in A), tuple(b)))
        for k in range(3):
            for tau in (-1, 1):
                if m[k] != 0 and (m[k] > 0) != (tau > 0):
                    continue
                if abs(m[k] + tau) > mmax:
                    continue
                i, sg = cell_of(c)
                col = [A[r][k] * tau for r in range(4)]
                j = next(r for r in range(4) if col[r] != 0)
                tj = col[j]
                assert j != i

                def rot(x, i=i, j=j, sg=sg, tj=tj):
                    y = list(x)
                    y[i] = -sg * tj * x[j]
                    y[j] = sg * tj * x[i]
                    return y

                cols = [rot([A[r][cc] for r in range(4)]) for cc in range(3)]
                A2 = [[cols[cc][r] for cc in range(3)] for r in range(4)]
                q = [0, 0, 0, 0]
                q[i] = sg
                q[j] = tj
                b2 = [v + q[r] for r, v in enumerate(rot([b[r] - q[r] for r in range(4)]))]
                m2 = list(m)
                level = 2 * m[k] + tau
                m2[k] += tau
                stack.append((steps + ((k, tau, level),), tuple(m2), 2 * j + (1 if tj > 0 else 0), A2, b2))
    return out


_WORDS = {}


def words_by_end(c0, mmax=MMAX):
    """The words from c0 grouped by end cell (cached)."""
    key = (c0, mmax)
    if key not in _WORDS:
        by = {}
        for w in build_words(c0, mmax):
            by.setdefault(w.cell, []).append(w)
        _WORDS[key] = by
    return _WORDS[key]


def realized_sq(w, U1, X2, H):
    """Squared length of the straight developed path from U1 (anchor frame) to the R^4 point X2
    along word w, or None when w does not realize it. All arguments are integers over one common
    denominator (H = h D, U1 = u1 D, X2 = x2 D), so the result is the squared length times D^2.

    Realized: the image Y = A^T (X2 - H b) lies in the closed lattice cube m, and the segment
    U1 -> Y crosses the planes of w at parameters 0 <= t_1 <= t_2 <= ... <= 1. A crossing of a
    plane the segment is parallel to (den = 0) is not counted: such a segment never crosses it,
    or lies in it and is realized by the word without that step (BOUNDARY.md 4.1).
    """
    Y = []
    for k, (r, g, br) in enumerate(w.cols):
        y = g * (X2[r] - H * br)
        c = 2 * H * w.m[k]
        if y - c > H or c - y > H:
            return None
        Y.append(y)
    pn, pd = 0, 1  # previous crossing parameter pn / pd, starting at t = 0
    for (k, _tau, level) in w.steps:
        den = Y[k] - U1[k]
        if den == 0:
            return None
        num = H * level - U1[k]
        if den < 0:
            num, den = -num, -den
        if num < 0 or num > den:
            return None
        if num * pd < pn * den:
            return None
        pn, pd = num, den
    return (Y[0] - U1[0]) ** 2 + (Y[1] - U1[1]) ** 2 + (Y[2] - U1[2]) ** 2


def path_lengths_sq(c1, U1, X2, H, exclude_empty=False):
    """(length^2, word) for every realized word from cell c1 (start U1) to the point X2, over all
    cells that contain X2; scaled integers as in realized_sq."""
    by = words_by_end(c1)
    out = []
    for c in cells_containing(X2, H):
        for w in by.get(c, ()):
            if exclude_empty and not w.steps:
                continue
            L = realized_sq(w, U1, X2, H)
            if L is not None:
                out.append((L, w))
    return out


def clearance_sq(U, H):
    """Squared geodesic distance from the local point U of a cell to the 1-skeleton (scaled
    integers): min over axis pairs of (H - |U_a|)^2 + (H - |U_b|)^2. The development's edges are
    the lattice lines; the nearest one is an edge of the anchor cube (BOUNDARY.md 4.2)."""
    a = [H - abs(x) for x in U]
    return min(a[1] ** 2 + a[2] ** 2, a[0] ** 2 + a[2] ** 2, a[0] ** 2 + a[1] ** 2)


# ------------------------------------------------------------------ configurations


class Config:
    """A parsed problem and configuration, all numbers exact."""

    def __init__(self, polytope, piece, P, config):
        if polytope not in POLYTOPES:
            raise CertError(f"unknown polytope {polytope!r}")
        if piece not in PIECES:
            raise CertError(f"unknown piece {piece!r}")
        if isinstance(P, bool) or not isinstance(P, int) or not 1 <= P <= MAX_P:
            raise CertError(f"P must be a whole number from 1 to {MAX_P}")
        if not isinstance(config, dict):
            raise CertError("the configuration must be an object with s and pieces")
        s = to_fraction(config.get("s"), "s")
        if not 0 < s <= MAX_S:
            raise CertError("s must be greater than 0 and at most 1e4")
        pieces = config.get("pieces")
        if not isinstance(pieces, list):
            raise CertError("the configuration needs a list of pieces")
        if len(pieces) != P:
            raise CertError(f"the configuration has {len(pieces)} pieces; the problem needs {P}")
        self.polytope, self.piece, self.P = polytope, piece, P
        self.s_site = s
        # the working unit: balls have radius 1 in it (header); cubes are in site units already
        w = BALL_WORK if piece == "ball" else Fraction(1)
        self.unit = 1 / w
        self.s = s * w
        s = self.s
        self.h = s / 2
        self.cells = []
        self.u = []
        for n, p in enumerate(pieces):
            if not isinstance(p, dict):
                raise CertError(f"piece {n} must be an object with cell and u")
            extra = set(p) - {"cell", "u", "q"}
            if extra:
                raise CertError(f"piece {n} has unknown fields {sorted(extra)}")
            c = p.get("cell")
            if isinstance(c, bool) or not isinstance(c, int) or not 0 <= c < 8:
                raise CertError(f"piece {n}: cell must be a whole number from 0 to 7")
            u = p.get("u")
            if not isinstance(u, list) or len(u) != 3:
                raise CertError(f"piece {n}: u must be 3 numbers")
            uu = [to_fraction(x, f"piece {n} u[{k}]") for k, x in enumerate(u)]
            if any(abs(x) > MAX_S for x in uu):
                raise CertError(f"piece {n}: u is out of range")
            if "q" in p:
                if piece == "ball":
                    raise CertError(f"piece {n} is a ball and must not have a rotation q")
                q = p["q"]
                if not isinstance(q, list) or len(q) != 4:
                    raise CertError(f"piece {n}: q must be 4 numbers")
                qq = [to_fraction(x, f"piece {n} q[{k}]") for k, x in enumerate(q)]
                if not (abs(qq[0]) == 1 and qq[1] == qq[2] == qq[3] == 0):
                    raise CertError(f"piece {n}: rotated cubes are outside this certifier (q must be absent or +-(1, 0, 0, 0))")
            self.cells.append(c)
            self.u.append([x * w for x in uu])
        # one common denominator for h, 1/2 and every coordinate: all tests are then integer tests
        D = math.lcm(2, self.h.denominator)
        for uu in self.u:
            for x in uu:
                D = math.lcm(D, x.denominator)
        self.D = D
        self.H = self.h.numerator * (D // self.h.denominator)
        self.U = [[x.numerator * (D // x.denominator) for x in uu] for uu in self.u]
        self.X = [embed(c, U, self.H) for c, U in zip(self.cells, self.U)]


def parse(problem, config):
    """problem: an id 'boundary/tesseract/<piece>/<P>' or a dict {polytope, piece, P}."""
    if isinstance(problem, str):
        m = ID_RE.match(problem)
        if not m:
            raise CertError(f"{problem!r} is not of the form boundary/tesseract/<ball|cube>/<P>")
        problem = {"polytope": m.group(1), "piece": m.group(2), "P": int(m.group(3))}
    if not isinstance(problem, dict):
        raise CertError("the problem must be an id or an object with polytope, piece and P")
    return Config(problem.get("polytope"), problem.get("piece"), problem.get("P"), config)


class Verdict:
    """ok, the reasons it fails (plain sentences), and exact margins (rationals, at unit scale)."""

    def __init__(self, cfg, strict):
        self.cfg = cfg
        self.strict = strict
        self.reasons = []
        self.margins = {}
        self.stats = {}

    @property
    def ok(self):
        return not self.reasons

    def fail(self, msg):
        if len(self.reasons) < 50:
            self.reasons.append(msg)


def _bad(value, limit, strict):
    """value < limit (valid needs >=), or value <= limit when strict."""
    return value <= limit if strict else value < limit


def check(problem, config, strict=True):
    """Decides validity exactly. Returns a Verdict; raises CertError only for malformed input or a
    configuration outside the certifier's scope (rotated cubes)."""
    cfg = parse(problem, config)
    v = Verdict(cfg, strict)
    H, D = cfg.H, cfg.D
    for n, U in enumerate(cfg.U):
        if any(abs(x) > H for x in U):
            v.fail(f"piece {n}: its centre lies outside its anchor cell {cfg.cells[n]}")
    if not v.ok:
        return v
    if cfg.piece == "ball":
        _check_balls(cfg, v)
    else:
        _check_cubes(cfg, v)
    return v


def _check_balls(cfg, v):
    H, D, strict = cfg.H, cfg.D, v.strict
    # volume: P (4 pi/3) <= 8 s^3, tested with a lower bound of pi (a failure here is certain)
    if cfg.P * Fraction(4, 3) * PI_LO > 8 * cfg.s ** 3:
        v.fail(f"{cfg.P} balls have more volume than the boundary of the tesseract at s = {fmt(cfg.s_site)}")
        return
    one = D * D
    u2 = cfg.unit ** 2  # site length squared per working length squared
    cl = [clearance_sq(U, H) for U in cfg.U]
    for n, c in enumerate(cl):
        if _bad(c, one, strict):
            v.fail(f"ball {n} is {fmt(sqrt_down(Fraction(c, one) * u2))} from an edge of the tesseract; it must be {'more than' if strict else 'at least'} {fmt(cfg.unit)}")
    v.margins["clearance_sq"] = Fraction(min(cl), one)
    if not v.ok:
        return
    # clearance >= 1 at some point forces s >= sqrt 2 (clearance <= h sqrt 2): the word set is complete
    if not cfg.s > 1:
        raise CertError("internal: word stage reached with s <= 1")
    four = 4 * one
    pairs = 0
    best_pair = None
    for a, b in _near_pairs(cfg):
        pairs += 1
        L = [x for x, _ in path_lengths_sq(cfg.cells[a], cfg.U[a], cfg.X[b], H)]
        if not L:
            continue
        m = min(L)
        if best_pair is None or m < best_pair:
            best_pair = m
        if _bad(m, four, strict):
            v.fail(f"balls {a} and {b} overlap: a path of length {fmt(sqrt_down(Fraction(m, one) * u2))} joins their centres; they must be {'more than' if strict else 'at least'} {fmt(2 * cfg.unit)} apart")
    best_loop = None
    for a in range(cfg.P):
        L = [x for x, _ in path_lengths_sq(cfg.cells[a], cfg.U[a], cfg.X[a], H, exclude_empty=True)]
        if not L:
            continue
        m = min(L)
        if best_loop is None or m < best_loop:
            best_loop = m
        if _bad(m, four, strict):
            v.fail(f"ball {a} overlaps itself: a geodesic loop of length {fmt(sqrt_down(Fraction(m, one) * u2))} leaves and returns to its centre")
    v.margins["distance_sq"] = None if best_pair is None else Fraction(best_pair, one)
    v.margins["loop_sq"] = None if best_loop is None else Fraction(best_loop, one)
    v.stats["pairs_within_2_in_R4"] = pairs


def _near_pairs(cfg):
    """Pairs (a, b), a < b, whose centres are at most 2 apart in R^4 (exact). The intrinsic
    distance is at least the R^4 distance, so every other pair is more than 2 apart and valid in
    both modes. A grid of side 2 keeps this linear in P."""
    D = cfg.D
    four = 4 * D * D
    grid = {}
    for n, X in enumerate(cfg.X):
        grid.setdefault(tuple(x // (2 * D) for x in X), []).append(n)
    out = []
    for key, members in grid.items():
        for d0 in (-1, 0, 1):
            for d1 in (-1, 0, 1):
                for d2 in (-1, 0, 1):
                    for d3 in (-1, 0, 1):
                        other = grid.get((key[0] + d0, key[1] + d1, key[2] + d2, key[3] + d3))
                        if not other:
                            continue
                        for a in members:
                            for b in other:
                                if a >= b:
                                    continue
                                d2sq = sum((p - q) ** 2 for p, q in zip(cfg.X[a], cfg.X[b]))
                                if d2sq <= four:
                                    out.append((a, b))
    return sorted(set(out))


def cube_parts(cfg, n, strict):
    """The parts of axis-aligned cube n as exact boxes (cell, lo, hi) in cell frames, scaled
    integers. Returns (parts, edge_slack, crossing): edge_slack is the second smallest axis slack
    H - |U_l| - D/2 (valid needs >= 0, strict > 0) and crossing lists the axes whose faces the
    cube crosses (slack < 0; strict: <= 0, a face touched from inside counts). The parts are
    meaningful only when at most one axis is crossed (BOUNDARY.md 4.3).

    With one crossed axis k (side tau) the cube lies in the slab |y_l| <= h of the other two axes,
    so every segment from its centre to a point of it crosses y_k = tau h inside the 2-face, and
    the slice beyond lies in the neighbouring lattice cube (|U_k| + 1/2 <= 3h since s >= 1). Its
    image in the neighbour is a box because the development map is a signed permutation."""
    H, D = cfg.H, cfg.D
    half = D // 2
    U = cfg.U[n]
    c = cfg.cells[n]
    slack = [H - abs(x) - half for x in U]
    crossing = [k for k in range(3) if (slack[k] <= 0 if strict else slack[k] < 0)]
    order = sorted(slack)
    lo = [max(U[k] - half, -H) for k in range(3)]
    hi = [min(U[k] + half, H) for k in range(3)]
    parts = [(c, tuple(lo), tuple(hi))]
    if len(crossing) == 1:
        k = crossing[0]
        tau = 1 if U[k] > 0 else -1
        # the slice beyond the face y_k = tau h, in the development (inside cube tau e_k: |U_k| + 1/2 <= 3h)
        assert abs(U[k]) + half <= 3 * H
        blo = list(lo)
        bhi = list(hi)
        if tau > 0:
            blo[k], bhi[k] = H, U[k] + half
        else:
            blo[k], bhi[k] = U[k] - half, -H
        w = one_step_word(c, k, tau)
        # map the two corners to R^4 by x = A y + h b, then to the neighbour's local frame
        j, _ = cell_of(w.cell)
        corners = []
        for y in (blo, bhi):
            x = [sum(w.A[r][cc] * y[cc] for cc in range(3)) + H * w.b[r] for r in range(4)]
            corners.append([x[a] for a in axes(j)])
        nlo = tuple(min(corners[0][t], corners[1][t]) for t in range(3))
        nhi = tuple(max(corners[0][t], corners[1][t]) for t in range(3))
        parts.append((w.cell, nlo, nhi))
    return parts, order[1], crossing


def one_step_word(c0, k, tau):
    """The word that crosses the face u_k = tau h of cell c0 (first crossing: level tau)."""
    for ws in words_by_end(c0).values():
        for w in ws:
            if w.steps == ((k, tau, tau),):
                return w
    raise AssertionError("one-step word missing")


def _check_cubes(cfg, v):
    H, D, strict = cfg.H, cfg.D, v.strict
    if cfg.P > 8 * cfg.s ** 3:
        v.fail(f"{cfg.P} cubes have more volume than the boundary of the tesseract at s = {fmt(cfg.s)}")
        return
    by_cell = {}
    worst_edge = None
    for n in range(cfg.P):
        parts, edge, crossing = cube_parts(cfg, n, strict)
        worst_edge = edge if worst_edge is None or edge < worst_edge else worst_edge
        if len(crossing) >= 2:
            v.fail(f"cube {n} crosses the faces of its cell in {len(crossing)} axes, so an edge of the tesseract passes through {'it' if strict else 'its interior'}")
            continue
        for p in parts:
            by_cell.setdefault(p[0], []).append((n,) + p)
    v.margins["edge_slack"] = Fraction(worst_edge, D)
    if not v.ok:
        return
    worst_sep = None
    for cell, lst in by_cell.items():
        lst.sort(key=lambda t: t[2][0])
        for x in range(len(lst)):
            a = lst[x]
            for y in range(x + 1, len(lst)):
                b = lst[y]
                g = b[2][0] - a[3][0]
                # sorted by lo_0: every later box is at least g apart in axis 0, so once g > 0 and
                # g >= the least separation found so far, no later pair is invalid or smaller
                if g > 0 and worst_sep is not None and g >= worst_sep:
                    break
                # separation: the largest gap over the axes (> 0 apart, 0 touching, < 0 overlap depth)
                sep = max(max(b[2][t] - a[3][t], a[2][t] - b[3][t]) for t in range(3))
                if worst_sep is None or sep < worst_sep:
                    worst_sep = sep
                if _bad(sep, 0, strict):
                    who = f"cube {a[0]} overlaps itself" if a[0] == b[0] else f"cubes {min(a[0], b[0])} and {max(a[0], b[0])} overlap"
                    v.fail(f"{who} in cell {cell} ({'touching' if sep == 0 else 'depth ' + fmt(Fraction(-sep, D))})")
    v.margins["part_separation"] = None if worst_sep is None else Fraction(worst_sep, D)
    v.stats["parts"] = sum(len(x) for x in by_cell.values())


def certify(problem, config):
    """Certifies strict validity; returns a summary, raises CertError when it does not hold."""
    v = check(problem, config, strict=True)
    if not v.ok:
        raise CertError("; ".join(v.reasons[:5]))
    return summary(v)


def summary(v):
    """Readable margins of a verdict, rounded down (lengths) so that they are never overstated. Ball margins are in site
    units (the verdict's squared working lengths times Config.unit squared)."""
    out = {"checker": CHECKER, "version": VERSION, "strict": v.strict, "valid": v.ok}
    m = v.margins
    if v.cfg.piece == "ball":
        u2 = v.cfg.unit ** 2
        out["words_per_cell"] = sum(len(ws) for ws in words_by_end(0).values())
        out["min_clearance"] = sqrt_down(m["clearance_sq"] * u2) if "clearance_sq" in m else None
        out["min_distance"] = sqrt_down(m["distance_sq"] * u2) if m.get("distance_sq") is not None else None
        out["min_loop"] = sqrt_down(m["loop_sq"] * u2) if m.get("loop_sq") is not None else None
        out["pairs_within_2_in_R4"] = v.stats.get("pairs_within_2_in_R4")
    else:
        out["min_edge_slack"] = float_down(m["edge_slack"]) if "edge_slack" in m else None
        out["min_part_separation"] = float_down(m["part_separation"]) if m.get("part_separation") is not None else None
        out["parts"] = v.stats.get("parts")
    return out


# ------------------------------------------------------------------ distances for cross-checks


def ball_distances(problem, config):
    """For cross-checks: the least realized-word length (exact, squared, in site units) between every two centres
    and of the loops at every centre, without the R^4 shortcut. Complete for lengths < 2 s (BOUNDARY.md 4.1)."""
    cfg = parse(problem, config)
    one = cfg.D * cfg.D / cfg.unit ** 2
    pairs = {}
    for a in range(cfg.P):
        for b in range(a + 1, cfg.P):
            L = [x for x, _ in path_lengths_sq(cfg.cells[a], cfg.U[a], cfg.X[b], cfg.H)]
            pairs[(a, b)] = Fraction(min(L)) / one if L else None
    loops = {}
    for a in range(cfg.P):
        L = [x for x, _ in path_lengths_sq(cfg.cells[a], cfg.U[a], cfg.X[a], cfg.H, exclude_empty=True)]
        loops[a] = Fraction(min(L)) / one if L else None
    clear = [Fraction(clearance_sq(U, cfg.H)) / one for U in cfg.U]
    return pairs, loops, clear


def cube_part_boxes(problem, config, strict=False):
    """For cross-checks: every cube's parts as (piece, cell, lo, hi) with exact rational bounds."""
    cfg = parse(problem, config)
    out = []
    for n in range(cfg.P):
        parts, _, crossing = cube_parts(cfg, n, strict)
        if len(crossing) >= 2:
            continue
        for (c, lo, hi) in parts:
            out.append((n, c, tuple(Fraction(x) / cfg.D for x in lo), tuple(Fraction(x) / cfg.D for x in hi)))
    return out


# ------------------------------------------------------------------ exact constructions


def check_field_balls(cells, U, s):
    """Validity (touching allowed) of balls, in the WORKING unit (radius 1: the caller has multiplied the site numbers
    by BALL_WORK), whose numbers lie in a field other than Q, here
    Q(sqrt 2, sqrt 3) (qfield.Q23). The same exact tests as _check_balls, run on field elements
    with the generic routines: h and the centres are put over one common denominator D, so the
    elements have integer coefficients, and squared lengths are compared with D^2 and 4 D^2. Every
    pair closer than 2 in R^4 is examined. Returns (ok, reasons, margins), squared margins exact."""
    from qfield import Q23

    h = s / 2
    if not s > 1:
        return False, ["s must exceed 1 for the word stage"], {}
    D = h.denominator()
    for u in U:
        for x in u:
            D = math.lcm(D, x.denominator())
    H = h.scaled_int(D)
    U = [[x.scaled_int(D) for x in u] for u in U]
    one, four = D * D, 4 * D * D
    reasons = []
    for n, u in enumerate(U):
        if any(abs(x) > H for x in u):
            reasons.append(f"piece {n}: its centre lies outside its anchor cell")
    if reasons:
        return False, reasons, {}
    cl = [clearance_sq(u, H) for u in U]
    for n, c in enumerate(cl):
        if c < one:
            reasons.append(f"ball {n} is closer than 1/2 to an edge")
    unit = lambda x: None if x is None else x / one  # noqa: E731
    margins = {"clearance_sq": unit(min(cl))}
    if reasons:
        return False, reasons, margins
    X = [embed(c, u, H) for c, u in zip(cells, U)]
    best = None
    for a in range(len(U)):
        for b in range(a + 1, len(U)):
            if sum(((p - q) ** 2 for p, q in zip(X[a], X[b])), Q23(0)) > four:
                continue  # more than 2 apart in R^4, so more than 2 apart on the boundary
            for L, _ in path_lengths_sq(cells[a], U[a], X[b], H):
                best = L if best is None or L < best else best
                if L < four:
                    reasons.append(f"balls {a} and {b} overlap")
    loop = None
    for a in range(len(U)):
        for L, _ in path_lengths_sq(cells[a], U[a], X[a], H, exclude_empty=True):
            loop = L if loop is None or L < loop else loop
            if L < four:
                reasons.append(f"ball {a} overlaps itself")
    margins["distance_sq"] = unit(best)
    margins["loop_sq"] = unit(loop)
    return not reasons, sorted(set(reasons)), margins


def check_exact(problem, exact):
    """An exact construction stored with a record ("exact": {field, s, pieces}): valid at exactly
    its s, touching allowed. field "Q": numbers are JSON numbers or rational strings ("4/3");
    field "Q(sqrt 2, sqrt 3)" (balls only): every number is [a, b, c, d] = a + b sqrt 2 + c sqrt 3
    + d sqrt 6. Returns (ok, reasons, margins, s) with s exact; raises CertError when malformed."""
    if not isinstance(exact, dict) or not isinstance(exact.get("pieces"), list):
        raise CertError("exact must be an object with field, s and pieces")
    field = exact.get("field")
    if field == "Q":
        cfg = {"s": exact.get("s"), "pieces": exact["pieces"]}
        v = check(problem, cfg, strict=False)
        return v.ok, v.reasons, v.margins, v.cfg.s_site
    if field == "Q(sqrt 2, sqrt 3)":
        from qfield import Q23

        p = parse(problem, {"s": 1, "pieces": [{"cell": 0, "u": [0, 0, 0]}] * (problem_P(problem))})
        if p.piece != "ball":
            raise CertError("constructions in Q(sqrt 2, sqrt 3) are supported for balls only")
        try:
            s = Q23.from_json(exact.get("s"))
            cells = []
            U = []
            for n, q in enumerate(exact["pieces"]):
                c = q.get("cell") if isinstance(q, dict) else None
                if isinstance(c, bool) or not isinstance(c, int) or not 0 <= c < 8:
                    raise CertError(f"piece {n}: bad cell")
                if not isinstance(q.get("u"), list) or len(q["u"]) != 3:
                    raise CertError(f"piece {n}: u must be 3 elements")
                cells.append(c)
                U.append([Q23.from_json(x) for x in q["u"]])
        except (ValueError, ZeroDivisionError) as e:
            raise CertError(f"bad field element: {e}") from None
        if len(cells) != p.P:
            raise CertError(f"the construction has {len(cells)} pieces; the problem needs {p.P}")
        # the stored numbers are site lengths (balls of diameter 1): the checks run on them times BALL_WORK
        w = int(BALL_WORK)
        ok, reasons, margins = check_field_balls(cells, [[x * w for x in u] for u in U], s * w)
        return ok, reasons, margins, s
    raise CertError(f"unknown field {field!r}")


def problem_P(problem):
    if isinstance(problem, str):
        m = ID_RE.match(problem)
        if not m:
            raise CertError(f"{problem!r} is not a boundary problem id")
        return int(m.group(3))
    return problem.get("P")


# ------------------------------------------------------------------ bounds


def lower_bounds(piece, P):
    """The proven lower bounds on s (BOUNDARY.md 5) as (kind, exact text, check), where check(x)
    decides exactly whether the rational x is <= the bound."""
    if piece == "ball":
        return [
            ("volume", "(P pi/48)^(1/3)", lambda x: x ** 3 * 48 <= P * PI_LO),
            ("one piece", "1/sqrt 2", lambda x: 2 * x * x <= 1),
        ]
    return [
        ("volume", "(P/8)^(1/3)", lambda x: x ** 3 * 8 <= P),
        ("one piece", "1/sqrt 2", lambda x: 2 * x * x <= 1),
    ]


# ------------------------------------------------------------------ records mode


def published_errors(rec):
    """The record's own fields, checked against each other (not the geometry)."""
    errs = []
    if not isinstance(rec, dict):
        return ["the record is not an object"]
    rid = rec.get("id")
    m = ID_RE.match(rid) if isinstance(rid, str) else None
    if not m:
        return [f"bad id {rid!r}"]
    if rec.get("polytope") != m.group(1) or rec.get("piece") != m.group(2) or rec.get("P") != int(m.group(3)):
        errs.append("the id does not match polytope, piece and P")
    status = rec.get("status")
    if status not in STATUSES:
        errs.append(f"unknown status {status!r}")
    if status == "proven":
        lit = rec.get("literature")
        proof = lit.get("proof") if isinstance(lit, dict) else None
        if not (isinstance(proof, list) and proof and all(isinstance(p, str) and p for p in proof)):
            errs.append("status proven needs a published proof (literature.proof)")
    cfg = rec.get("config")
    if not isinstance(cfg, dict):
        errs.append("the record has no configuration")
        return errs
    sc = rec.get("score_cert")
    if isinstance(sc, bool) or not isinstance(sc, (int, float)) or not math.isfinite(sc):
        errs.append("score_cert must be a finite number")
        return errs
    if cfg.get("s") != sc:
        errs.append("score_cert differs from the s of the stored configuration")
    if rec.get("display") != display_6(sc):
        errs.append(f"display must be {display_6(sc)} (score_cert rounded to 6 decimals)")
    sf = rec.get("score_float")
    if isinstance(sf, bool) or not isinstance(sf, (int, float)) or not (0 < sf <= sc):
        errs.append("need 0 < score_float <= score_cert")
    bound = rec.get("bound")
    if bound is not None:
        if not isinstance(bound, dict) or isinstance(bound.get("value"), bool) or not isinstance(bound.get("value"), (int, float)):
            errs.append("bound must be an object with a numeric value")
        else:
            bv = Fraction(bound["value"])
            if bv > Fraction(sc):
                errs.append("the lower bound exceeds score_cert")
            kinds = {k: ok for k, _, ok in lower_bounds(m.group(2), int(m.group(3)))}
            if bound.get("kind") not in kinds:
                errs.append(f"unknown bound kind {bound.get('kind')!r}")
            elif not kinds[bound["kind"]](bv):
                errs.append("the stored bound value exceeds the proven bound")
    return errs


def certify_record(rec):
    """Records mode: consistent published fields, and the stored configuration (at s = score_cert)
    certified strictly valid; a stored exact construction (field "exact") must be valid at exactly
    its s, and that s must not exceed score_cert. Returns the summary; raises CertError otherwise."""
    errs = published_errors(rec)
    if errs:
        raise CertError("; ".join(errs))
    out = certify(rec["id"], rec["config"])
    if "exact" in rec:
        ok, reasons, _, s = check_exact(rec["id"], rec["exact"])
        if not ok:
            raise CertError("the exact construction is invalid: " + "; ".join(reasons[:3]))
        if s > Fraction(rec["score_cert"]):
            raise CertError("the exact construction's s exceeds score_cert")
        out["exact_valid"] = True
    return out


def check_records(recs, log=print):
    """Checks every record; every failure (malformed input included) is reported, never raised."""
    ok = bad = 0
    if not isinstance(recs, list):
        log("FAIL the file has no list of records")
        return 0, 1
    for rec in recs:
        rid = rec.get("id") if isinstance(rec, dict) else None
        try:
            cert = certify_record(rec)
            ok += 1
            if rec["piece"] == "ball":
                extra = f"clearance {cert['min_clearance']!r}, distance {cert['min_distance']!r}, loop {cert['min_loop']!r}"
            else:
                extra = f"edge slack {cert['min_edge_slack']!r}, part separation {cert['min_part_separation']!r}"
            log(f"OK   {rid} {rec['display']} ({extra})")
        except CertError as e:
            bad += 1
            log(f"FAIL {rid} {e}")
        except Exception as e:  # malformed input must not stop the run
            bad += 1
            log(f"FAIL {rid} internal error {type(e).__name__}: {e}")
    return ok, bad


def main(argv):
    if len(argv) != 1:
        print(__doc__.strip().splitlines()[-1].strip())
        return 2
    with open(argv[0]) as fh:
        data = json.load(fh)
    recs = data.get("records") if isinstance(data, dict) else data
    ok, bad = check_records(recs)
    print(f"certified {ok}, failed {bad}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
