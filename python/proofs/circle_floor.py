"""Machine check for docs/proofs/circle-container-floor.md.

Run from the repository root:

    python3 python/proofs/circle_floor.py

Standard library only, so CI's plain python3 runs it (`npm run test:python`).

- Exact layer (fractions): every circle configuration of the proof is built in a cyclotomic
  field Q(zeta_m). Each stated contact c_j - c_i = 2 e(psi) and each stated wall contact
  c_i = a e(phi) is checked as an identity of field elements, as are the closed forms of
  rho0 - 1. Contact directions are exact fractions of a turn, so the congruence condition
  mod 2 pi / N is checked exactly.
- 90-digit layer (decimal): the polygon packings are built from the same formulas (not from
  Packomania's numbers) and checked: contact gaps, clearance of all other pairs, containment
  and the container radius against the floor sqrt(r_N^2 rho0^2 + 1/4).
- The page's own tables are parsed and compared with this script's data: the summary table of
  Theorem 2, the values q_n of Section 5.3, the contact and direction tables of Sections
  5.4-5.6, and the value tables of Sections 10 and 11.

The proof does not rest on this script; it repeats the proof's computations.
"""

import itertools
import re
import sys
from decimal import ROUND_FLOOR, Decimal, getcontext
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "docs/proofs/circle-container-floor.md"

getcontext().prec = 90
# Tolerance for quantities that are exactly zero in the proof (contact gaps, distances of
# face normals from contact directions, floor minus farthest vertex); a 90-digit computation
# leaves errors near 1e-85.
EXACT = Decimal("1e-60")

# ------------------------------------------------------------------------------------------
# Exact arithmetic in the cyclotomic field Q(zeta_m), zeta_m = e^(2 pi i / m)
# ------------------------------------------------------------------------------------------


def _poly_divide(num, den):
    """Exact quotient of integer polynomials (coefficients low to high), den monic."""
    num = list(num)
    out = [0] * (len(num) - len(den) + 1)
    for k in range(len(out) - 1, -1, -1):
        q = num[k + len(den) - 1]
        out[k] = q
        for j, d in enumerate(den):
            num[k + j] -= q * d
    assert not any(num), "division is not exact"
    return out


@lru_cache(maxsize=None)
def cyclotomic(m):
    """Coefficients of the m-th cyclotomic polynomial, low to high."""
    poly = [-1] + [0] * (m - 1) + [1]
    for d in range(1, m):
        if m % d == 0:
            poly = _poly_divide(poly, cyclotomic(d))
    return tuple(poly)


class Field:
    """Q(zeta_m) with basis 1, zeta, ..., zeta^(n-1), n = phi(m)."""

    def __init__(self, m):
        self.m = m
        self.phi = cyclotomic(m)
        self.n = len(self.phi) - 1

    def element(self, coeffs):
        c = [Fraction(x) for x in coeffs]
        # x^k = -x^(k-n) * (phi_0 + ... + phi_(n-1) x^(n-1)) for k >= n
        for k in range(len(c) - 1, self.n - 1, -1):
            t = c[k]
            if t:
                for j in range(self.n):
                    c[k - self.n + j] -= t * self.phi[j]
        c = c[: self.n] + [Fraction(0)] * (self.n - len(c))
        return Cyc(self, tuple(c))

    def const(self, q):
        return self.element([q])

    def zeta(self, k):
        return self.element([0] * (k % self.m) + [1])

    def e(self, degrees):
        """Unit vector at an angle given in degrees, as a power of zeta."""
        k = Fraction(degrees) * self.m / 360
        assert k.denominator == 1, f"{degrees} degrees is not a multiple of 360/{self.m}"
        return self.zeta(int(k))

    def cos(self, degrees):
        return (self.e(degrees) + self.e(-Fraction(degrees))) * Fraction(1, 2)

    def sin(self, degrees):
        return (self.e(degrees) - self.e(-Fraction(degrees))) / (self.e(90) * 2)


class Cyc:
    """An element of Q(zeta_m); used as a complex number x + i y."""

    def __init__(self, field, coeffs):
        self.f = field
        self.c = coeffs

    def _lift(self, other):
        return other if isinstance(other, Cyc) else self.f.const(other)

    def __add__(self, other):
        o = self._lift(other)
        return Cyc(self.f, tuple(a + b for a, b in zip(self.c, o.c)))

    __radd__ = __add__

    def __neg__(self):
        return Cyc(self.f, tuple(-a for a in self.c))

    def __sub__(self, other):
        return self + (-self._lift(other))

    def __rsub__(self, other):
        return self._lift(other) - self

    def __mul__(self, other):
        o = self._lift(other)
        prod = [Fraction(0)] * (2 * self.f.n)
        for i, a in enumerate(self.c):
            if a:
                for j, b in enumerate(o.c):
                    prod[i + j] += a * b
        return self.f.element(prod)

    __rmul__ = __mul__

    def inverse(self):
        """Solve self * x = 1 by Gaussian elimination on the multiplication matrix."""
        n = self.f.n
        cols = [(self * self.f.zeta(j)).c for j in range(n)]
        rows = [[cols[j][i] for j in range(n)] + [Fraction(int(i == 0))] for i in range(n)]
        for col in range(n):
            pivot = next(r for r in range(col, n) if rows[r][col])
            rows[col], rows[pivot] = rows[pivot], rows[col]
            d = rows[col][col]
            rows[col] = [v / d for v in rows[col]]
            for r in range(n):
                if r != col and rows[r][col]:
                    d = rows[r][col]
                    rows[r] = [v - d * w for v, w in zip(rows[r], rows[col])]
        return Cyc(self.f, tuple(rows[i][n] for i in range(n)))

    def __truediv__(self, other):
        return self * self._lift(other).inverse()

    def __rtruediv__(self, other):
        return self._lift(other) * self.inverse()

    def conj(self):
        """Complex conjugate: zeta^j -> zeta^(-j)."""
        out = [Fraction(0)] * self.f.m
        for j, a in enumerate(self.c):
            out[(-j) % self.f.m] += a
        return self.f.element(out)

    def __eq__(self, other):
        return self.c == self._lift(other).c

    def __hash__(self):
        return hash(self.c)

    def is_real(self):
        return self == self.conj()

    def decimal(self):
        """(x, y) to working precision."""
        x = y = Decimal(0)
        for j, a in enumerate(self.c):
            if a:
                cx, cy = root_of_unity(j, self.f.m)
                q = Decimal(a.numerator) / Decimal(a.denominator)
                x += q * cx
                y += q * cy
        return x, y


# ------------------------------------------------------------------------------------------
# Decimal elementary functions (recipes from the decimal module documentation)
# ------------------------------------------------------------------------------------------


@lru_cache(maxsize=None)
def dpi():
    getcontext().prec += 4
    three = Decimal(3)
    lasts, t, s, n, na, d, da = 0, three, 3, 1, 0, 0, 24
    while s != lasts:
        lasts = s
        n, na = n + na, na + 8
        d, da = d + da, da + 32
        t = (t * n) / d
        s += t
    getcontext().prec -= 4
    return +s


def _reduce(x):
    """x mod 2 pi into (-pi, pi]."""
    two_pi = 2 * dpi()
    x = x - two_pi * (x / two_pi).to_integral_value()
    return x


def dcos(x):
    x = _reduce(x)
    getcontext().prec += 4
    i, lasts, s, fact, num, sign = 0, 0, 1, 1, 1, 1
    while s != lasts:
        lasts = s
        i += 2
        fact *= i * (i - 1)
        num *= x * x
        sign *= -1
        s += num / fact * sign
    getcontext().prec -= 4
    return +s


def dsin(x):
    x = _reduce(x)
    getcontext().prec += 4
    i, lasts, s, fact, num, sign = 1, 0, x, 1, x, 1
    while s != lasts:
        lasts = s
        i += 2
        fact *= i * (i - 1)
        num *= x * x
        sign *= -1
        s += num / fact * sign
    getcontext().prec -= 4
    return +s


@lru_cache(maxsize=None)
def root_of_unity(j, m):
    t = turn(Fraction(j, m))
    return dcos(t), dsin(t)


def turn(q):
    """An angle given as a fraction of a full turn, in radians."""
    return 2 * dpi() * Decimal(q.numerator) / Decimal(q.denominator)


def inradius(N):
    return dcos(dpi() / N) / (2 * dsin(dpi() / N))


def circumradius(N):
    return 1 / (2 * dsin(dpi() / N))


# ------------------------------------------------------------------------------------------
# The circle configurations of the proof (circle units: unit circles, container radius rho0)
# ------------------------------------------------------------------------------------------


class Config:
    """Circle centres c_i in Q(zeta_m), wall radius a = rho0 - 1, and the stated contacts.

    walls:    {name: phi} meaning c_name = a e(phi)
    contacts: [(i, j, psi)] meaning c_j - c_i = 2 e(psi)
    Angles are in degrees, as Fractions.
    """

    def __init__(self, P, label, field, a, rho0_text, points, walls, contacts, identities, classes, index_mod=None):
        self.P = P
        self.index_mod = index_mod or {}  # how the page's tables reduce indices, e.g. {"W": 12}
        self.label = label
        self.f = field
        self.a = a
        self.rho0_text = rho0_text
        self.points = points  # ordered dict name -> Cyc
        self.walls = {k: Fraction(v) % 360 for k, v in walls.items()}
        self.contacts = [(i, j, Fraction(psi) % 360) for i, j, psi in contacts]
        self.identities = identities  # [(text, bool)] closed forms of a
        self.classes = classes  # the N <= 100 claimed

    def directions(self):
        """Psi_i: contact directions of each circle, in degrees mod 360."""
        out = {name: [] for name in self.points}
        for name, phi in self.walls.items():
            out[name].append(phi)
        for i, j, psi in self.contacts:
            out[i].append(psi)
            out[j].append((psi + 180) % 360)
        return out

    def congruent(self, N):
        """Are each circle's contact directions congruent mod 360/N degrees?"""
        for dirs in self.directions().values():
            for psi in dirs[1:]:
                if ((psi - dirs[0]) * N / 360).denominator != 1:
                    return False
        return True


def ring_points(F, n, a, phi0, prefix="c"):
    return {f"{prefix}{k}": a * F.e(Fraction(phi0) + Fraction(360 * k, n)) for k in range(n)}


def ring_contacts(n, phi0, prefix="c", skip=()):
    """Consecutive pairs of a ring of n at angles phi0 + 360 k / n; chord direction
    phi_k + 90 + 180 / n. Pairs that touch a missing position are left out."""
    out = []
    for k in range(n):
        if n == 2 and k == 1:
            break
        if k in skip or (k + 1) % n in skip:
            continue
        psi = Fraction(phi0) + Fraction(360 * k, n) + 90 + Fraction(180, n)
        out.append((f"{prefix}{k}", f"{prefix}{(k + 1) % n}", psi))
    return out


def ring_config(P, n, m, phi0, centre=None):
    """P = n: a ring of n touching circles; P = n + 1: the ring plus a circle at the centre,
    which touches the ring (centre='touch', n = 6) or is a rattler (centre='free')."""
    F = Field(m)
    a = 1 / F.sin(Fraction(180, n))
    pts = ring_points(F, n, a, phi0)
    walls = {f"c{k}": Fraction(phi0) + Fraction(360 * k, n) for k in range(n)}
    contacts = ring_contacts(n, phi0)
    if centre:
        pts = {"O": F.const(0), **pts}
        if centre == "touch":
            contacts += [("O", f"c{k}", walls[f"c{k}"]) for k in range(n)]
    return F, a, pts, walls, contacts


def configurations():
    cfgs = []

    def add(P, label, n, m, phi0, rho0_text, identities, classes, centre=None):
        F, a, pts, walls, contacts = ring_config(P, n, m, phi0, centre)
        cfgs.append(
            Config(P, label, F, a, rho0_text, pts, walls, contacts, identities(F, a), classes)
        )

    every = lambda q, lo=3: [N for N in range(lo, 101) if N % q == 0]  # noqa: E731
    add(2, "two touching circles", 2, 4, 0, "2", lambda F, a: [("a = 1", a == 1)], every(2, 4))
    add(
        3,
        "ring of 3",
        3,
        12,
        90,
        "1 + 2/sqrt(3)",
        lambda F, a: [("a^2 = 4/3", a * a == Fraction(4, 3))],
        every(12),
    )
    add(4, "ring of 4", 4, 8, 45, "1 + sqrt(2)", lambda F, a: [("a^2 = 2", a * a == 2)], every(8))
    add(5, "ring of 5", 5, 20, 90, "1 + 1/sin(36 deg)", lambda F, a: [("a sin 36 = 1", a * F.sin(36) == 1)], every(20))
    add(6, "ring of 6", 6, 12, 0, "3", lambda F, a: [("a = 2", a == 2)], every(3))
    add(7, "ring of 6 and centre", 6, 12, 0, "3", lambda F, a: [("a = 2", a == 2)], every(6), "touch")
    add(
        8,
        "ring of 7 and free centre",
        7,
        28,
        90,
        "1 + 1/sin(180/7 deg)",
        lambda F, a: [("a sin(180/7) = 1", a * F.sin(Fraction(180, 7)) == 1)],
        every(28),
        "free",
    )
    add(
        9,
        "ring of 8 and free centre",
        8,
        16,
        Fraction(45, 2),
        "1 + 1/sin(22.5 deg)",
        lambda F, a: [("a sin 22.5 = 1", a * F.sin(Fraction(45, 2)) == 1)],
        every(16),
        "free",
    )
    cfgs.append(config_11())
    cfgs.append(config_13())
    cfgs.append(config_19())
    return cfgs


def config_11():
    """Eight circles on the ring of nine positions 10 + 40 k (k != 2) and an inner
    equilateral triangle X1 (left), X2 (right), X3 (top) (docs: Section 5.4)."""
    F = Field(36)
    i = F.e(90)
    a = 1 / F.sin(20)
    t = F.sin(10) / F.cos(10)
    sqrt3 = 2 * F.cos(30)
    ks = [0, 1, 3, 4, 5, 6, 7, 8]
    pts = {f"W{k}": a * F.e(10 + 40 * k) for k in ks}
    pts["X1"] = -1 - i * t
    pts["X2"] = 1 - i * t
    pts["X3"] = i * (sqrt3 - t)
    walls = {f"W{k}": 10 + 40 * k for k in ks}
    contacts = [(f"W{k}", f"W{k + 1}", 120 + 40 * k) for k in (0, 3, 4, 5, 6, 7)]
    contacts.append(("W8", "W0", 80))
    contacts += [
        ("X1", "X2", 0),
        ("X1", "X3", 60),
        ("X2", "X3", 120),
        ("X1", "W4", 160),
        ("X1", "W5", 220),
        ("X2", "W0", 20),
        ("X2", "W8", 320),
        ("X3", "W1", 20),
        ("X3", "W3", 160),
    ]
    identities = [("a sin 20 = 1", a * F.sin(20) == 1), ("sqrt3^2 = 3", sqrt3 * sqrt3 == 3)]
    return Config(11, "Melissen's 11", F, a, "1 + 1/sin(20 deg)", pts, walls, contacts, identities, [36, 72])


def config_13():
    """Nine circles at radius 1 + sqrt5 on the positions 18 + 36 k (k != 2), three at radius
    sqrt5 - 1 in the directions 270 (Y1), 162 (Y2), 18 (Y3), and Y4 = (0, 2) (docs: Section 5.5)."""
    F = Field(20)
    sqrt5 = 4 * F.cos(36) - 1
    A = 1 + sqrt5
    b = sqrt5 - 1
    ks = [0, 1, 3, 4, 5, 6, 7, 8, 9]
    pts = {f"W{k}": A * F.e(18 + 36 * k) for k in ks}
    pts.update({"Y1": b * F.e(270), "Y2": b * F.e(162), "Y3": b * F.e(18), "Y4": 2 * F.e(90)})
    walls = {f"W{k}": 18 + 36 * k for k in ks}
    contacts = [(f"W{k}", f"W{(k + 1) % 10}", 126 + 36 * k) for k in (0, 3, 4, 5, 6, 7, 8, 9)]
    contacts += [
        ("Y1", "W7", 270),
        ("Y3", "W0", 18),
        ("Y2", "W4", 162),
        ("Y4", "W1", 18),
        ("Y4", "W3", 162),
        ("Y1", "Y3", 54),
        ("Y1", "Y2", 126),
        ("Y3", "Y4", 126),
        ("Y2", "Y4", 54),
    ]
    identities = [("sqrt5^2 = 5", sqrt5 * sqrt5 == 5)]
    return Config(13, "Fodor's 13", F, A, "2 + sqrt(5)", pts, walls, contacts, identities, every_n(10), {"W": 10})


def config_19():
    """Twelve circles at radius sqrt2 + sqrt6 on 15 + 30 k, six at radius 2 on 60 j and one at
    the centre (docs: Section 5.6)."""
    F = Field(24)
    A = 4 * F.cos(15)
    sqrt2 = 2 * F.cos(45)
    sqrt3 = 2 * F.cos(30)
    pts = {"O": F.const(0)}
    pts.update({f"H{j}": 2 * F.e(60 * j) for j in range(6)})
    pts.update({f"W{k}": A * F.e(15 + 30 * k) for k in range(12)})
    walls = {f"W{k}": 15 + 30 * k for k in range(12)}
    contacts = [(f"W{k}", f"W{(k + 1) % 12}", 120 + 30 * k) for k in range(12)]
    contacts += [("O", f"H{j}", 60 * j) for j in range(6)]
    contacts += [(f"H{j}", f"H{(j + 1) % 6}", 60 * j + 120) for j in range(6)]
    contacts += [(f"H{j}", f"W{2 * j}", 60 * j + 30) for j in range(6)]
    contacts += [(f"H{j}", f"W{(2 * j - 1) % 12}", 60 * j - 30) for j in range(6)]
    identities = [
        ("A = sqrt2 + sqrt6", A == sqrt2 + sqrt2 * sqrt3),
        ("sqrt2^2 = 2", sqrt2 * sqrt2 == 2),
        ("sqrt3^2 = 3", sqrt3 * sqrt3 == 3),
    ]
    return Config(
        19, "Fodor's 19", F, A, "1 + sqrt(2) + sqrt(6)", pts, walls, contacts, identities, every_n(24), {"H": 6, "W": 12}
    )


def every_n(q):
    return [N for N in range(3, 101) if N % q == 0]


def six_gaps(N):
    """Theorem 3: the centre and five circles at radius 2 with gaps k_1..k_5 (units 360/N),
    four of them floor(N/6) + 1 and the last N minus the others."""
    g = N // 6 + 1
    return [g, g, g, g, N - 4 * g]


def config_six_centre(N):
    """P = 6, centre + five: the circle at 0 touches five circles at radius 2 whose angular
    gaps are multiples of 360/N, each larger than 60 degrees (docs: Section 5.7)."""
    F = Field(N)
    gaps = six_gaps(N)
    phis = [Fraction(360 * sum(gaps[:k]), N) for k in range(5)]
    pts = {"O": F.const(0)}
    pts.update({f"c{k}": 2 * F.e(phi) for k, phi in enumerate(phis)})
    walls = {f"c{k}": phi for k, phi in enumerate(phis)}
    contacts = [("O", f"c{k}", phi) for k, phi in enumerate(phis)]
    a = F.const(2)
    return Config(6, f"centre and five, gaps {gaps}", F, a, "3", pts, walls, contacts, [("a = 2", a == 2)], [N])


def theorem3_extra():
    """N <= 100 added by Theorem 3 for P = 6: even, not divisible by 3, not 4, 8 or 14."""
    return [N for N in range(4, 101, 2) if N % 3 and N not in (4, 8, 14)]


# ------------------------------------------------------------------------------------------
# Checks
# ------------------------------------------------------------------------------------------


class Report:
    def __init__(self):
        self.failures = []
        self.lines = []

    def check(self, ok, what):
        if not ok:
            self.failures.append(what)
        return ok

    def say(self, line=""):
        self.lines.append(line)


def check_configuration(cfg, rep):
    """Exact identities, then the full contact graph to 90 digits."""
    F = cfg.f
    rep.check(cfg.a.is_real(), f"P={cfg.P}: a is real")
    for text, ok in cfg.identities:
        rep.check(ok, f"P={cfg.P}: identity {text}")
    for name, phi in cfg.walls.items():
        rep.check(cfg.points[name] == cfg.a * F.e(phi), f"P={cfg.P}: wall {name} at {phi}")
    for i, j, psi in cfg.contacts:
        rep.check(cfg.points[j] - cfg.points[i] == 2 * F.e(psi), f"P={cfg.P}: contact {i}-{j} at {psi}")
    # No other pair touches or overlaps, no other circle reaches the wall (decimal, with margin).
    names = list(cfg.points)
    rep.check(len(names) == cfg.P, f"P={cfg.P}: {len(names)} circles")
    pts = {k: v.decimal() for k, v in cfg.points.items()}
    a = cfg.a.decimal()[0]
    stated = {frozenset((i, j)) for i, j, _ in cfg.contacts}
    min_gap = None
    for i, j in itertools.combinations(names, 2):
        d2 = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2
        if frozenset((i, j)) in stated:
            continue
        rep.check(d2 > 4 + Decimal("1e-3"), f"P={cfg.P}: {i}-{j} is not a contact")
        min_gap = d2.sqrt() if min_gap is None else min(min_gap, d2.sqrt())
    max_inner = Decimal(0)
    for name in names:
        r2 = pts[name][0] ** 2 + pts[name][1] ** 2
        if name not in cfg.walls:
            rep.check(r2.sqrt() < a - Decimal("1e-3"), f"P={cfg.P}: {name} is inside")
            max_inner = max(max_inner, r2.sqrt())
    rattlers = [n for n, d in cfg.directions().items() if not d]
    return min_gap, max_inner, rattlers


def poses(cfg, N):
    """Centres r_N c_i and angles theta_i = psi_i - 90 - 180/N (degrees -> radians), psi_i the
    first contact direction (the wall direction for wall circles); rattlers get theta = 0."""
    r = inradius(N)
    out = {}
    for name, dirs in cfg.directions().items():
        x, y = cfg.points[name].decimal()
        theta = turn((dirs[0] - 90 - Fraction(180, N)) / 360) if dirs else Decimal(0)
        out[name] = (r * x, r * y, theta)
    return out


def vertices(N, pose):
    """Vertex k at angle theta + pi/2 + 2 pi k / N, counter-clockwise, as in
    packages/geometry/src/shapes.ts (pieceVertices).
    The angles are stepped by complex multiplication with e(2 pi / N); at 90 digits the
    accumulated rounding stays far below EXACT."""
    x, y, theta = pose
    R = circumradius(N)
    c, s = dcos(theta + dpi() / 2), dsin(theta + dpi() / 2)
    cw, sw = root_of_unity(1, N)
    out = []
    for _ in range(N):
        out.append((x + R * c, y + R * s))
        c, s = c * cw - s * sw, s * cw + c * sw
    return out


def gap_along(u, va, vb):
    """Separation of two vertex sets along the unit vector u (b beyond a)."""
    return min(x * u[0] + y * u[1] for x, y in vb) - max(x * u[0] + y * u[1] for x, y in va)


def face_normals(vs):
    out = []
    for k in range(len(vs)):
        (x0, y0), (x1, y1) = vs[k], vs[(k + 1) % len(vs)]
        nx, ny = y1 - y0, x0 - x1  # outward for a counter-clockwise polygon
        norm = (nx * nx + ny * ny).sqrt()
        out.append((nx / norm, ny / norm))
    return out


def unit(degrees):
    t = turn(Fraction(degrees) / 360)
    return dcos(t), dsin(t)


def check_packing(cfg, N, rep):
    """Build the N-gon packing and check it against the proof's claims. Returns a summary."""
    tag = f"(N={N}, P={cfg.P})"
    rep.check(cfg.congruent(N), f"{tag}: contact directions congruent mod 360/N")
    ps = poses(cfg, N)
    vs = {k: vertices(N, p) for k, p in ps.items()}
    r, R = inradius(N), circumradius(N)
    rho0 = cfg.a.decimal()[0] + 1
    floor = (r * r * rho0 * rho0 + Decimal(1) / 4).sqrt()
    dirs = cfg.directions()
    normals_of = {k: face_normals(v) for k, v in vs.items()}
    # every contact direction is an outward face normal of its polygon (vertex formula check)
    for name, ds in dirs.items():
        normals = normals_of[name]
        for psi in ds:
            u = unit(psi)
            # distance of e(psi) from the nearest face normal: certifies the angle to ~1e-60
            best = min(((n[0] - u[0]) ** 2 + (n[1] - u[1]) ** 2).sqrt() for n in normals)
            rep.check(best < EXACT, f"{tag}: {psi} is a face normal of {name}")
    worst_contact = Decimal(0)
    for i, j, psi in cfg.contacts:
        g = gap_along(unit(psi), vs[i], vs[j])
        worst_contact = max(worst_contact, abs(g))
        rep.check(abs(g) < EXACT, f"{tag}: contact {i}-{j} closes, gap {g:.3e}")
    stated = {frozenset((i, j)) for i, j, _ in cfg.contacts}
    min_clear = None
    min_ratio = None
    for i, j in itertools.combinations(list(ps), 2):
        if frozenset((i, j)) in stated:
            continue
        (xi, yi, _), (xj, yj, _) = ps[i], ps[j]
        dist = ((xj - xi) ** 2 + (yj - yi) ** 2).sqrt()
        ratio = dist / (2 * R)
        min_ratio = ratio if min_ratio is None else min(min_ratio, ratio)
        # certified lower bound on the separation: the best of the face normals of either
        # polygon nearest the line of centres (any axis's gap bounds the separation below)
        u = ((xj - xi) / dist, (yj - yi) / dist)
        candidates = normals_of[i] + [(-a, -b) for a, b in normals_of[j]]
        axes = sorted(candidates, key=lambda n: -(n[0] * u[0] + n[1] * u[1]))[:4]
        sep = max(gap_along(n, vs[i], vs[j]) for n in axes)
        min_clear = sep if min_clear is None else min(min_clear, sep)
        if (N, cfg.P) == (3, 6):
            rep.check(sep > -EXACT, f"{tag}: {i}-{j} touch at most")
        else:
            rep.check(dist >= 2 * R, f"{tag}: {i}-{j} centre distance {dist:.6f} >= 2 R_N")
            rep.check(sep > 0, f"{tag}: {i}-{j} separated")
    radius = Decimal(0)
    for name, v in vs.items():
        far = max((x * x + y * y).sqrt() for x, y in v)
        radius = max(radius, far)
        if name in cfg.walls:
            rep.check(abs(far - floor) < EXACT, f"{tag}: {name} reaches the floor exactly")
        else:
            x, y, _ = ps[name]
            rep.check((x * x + y * y).sqrt() + R <= r * rho0, f"{tag}: {name}: D + R_N <= r_N rho0")
            rep.check(far < floor, f"{tag}: {name} inside")
    rep.check(abs(radius - floor) < EXACT, f"{tag}: radius equals the floor")
    return {"floor": floor, "contact": worst_contact, "clear": min_clear, "ratio": min_ratio}


def check_vertex_lemma(rep, samples=400):
    """Theorem 1, vertex lemma: farthest vertex^2 = D^2 + R^2 + 2 D R cos(pi/N - beta) >=
    (D + r)^2 + 1/4, on pseudo-random poses."""
    import random

    rng = random.Random(20261019)
    worst = None
    face_on = Decimal(0)
    for s in range(samples):
        N = rng.randint(3, 100)
        D = Decimal(rng.random() * 50)
        phi = Decimal(rng.random()) * 2 * dpi()
        theta = Decimal(rng.random()) * 2 * dpi()
        if s % 4 == 0:  # face-on: a face normal along the radial direction (equality case)
            theta = phi - dpi() / 2 - dpi() / N + 2 * dpi() * rng.randint(0, N - 1) / N
        pose = (D * dcos(phi), D * dsin(phi), theta)
        r, R = inradius(N), circumradius(N)
        far2 = max(x * x + y * y for x, y in vertices(N, pose))
        # beta: angle from the radial direction to the nearest outward face normal
        step = 2 * dpi() / N
        off = phi - (theta + dpi() / 2 + dpi() / N)
        off -= step * (off / step).to_integral_value(rounding=ROUND_FLOOR)  # into [0, step)
        beta = min(off, step - off)
        formula = D * D + R * R + 2 * D * R * dcos(dpi() / N - beta)
        rep.check(abs(far2 - formula) < EXACT, f"vertex lemma formula N={N}")
        slack = far2 - ((D + r) ** 2 + Decimal(1) / 4)
        rep.check(slack > -EXACT, f"vertex lemma N={N} D={D}")
        if s % 4 == 0:
            face_on = max(face_on, abs(slack))
        else:
            worst = slack if worst is None else min(worst, slack)
    rep.check(face_on < EXACT, "vertex lemma: equality when face-on")
    return worst, face_on


def theorem3_six(N):
    """Lemma 5 lists the optimal 6-configurations: the hexagon on radius 2, or the centre
    and five circles on radius 2 with angular gaps of at least 60 degrees. Is one of them
    commensurate with N? For the five, the centre touches all of them, so (if the
    configuration is commensurate) the gaps are multiples of 360/N: compositions of N into
    five parts, each part k with 6 k >= N. This checks every such composition."""
    hexagon = configurations()[4]
    assert hexagon.P == 6
    if hexagon.congruent(N):
        return True
    for gaps in compositions(N, 5, -(-N // 6)):
        phis = [Fraction(360 * sum(gaps[:k]), N) for k in range(5)]
        dirs = {"O": list(phis)}
        for k, phi in enumerate(phis):
            dirs[k] = [phi, (phi + 180) % 360]
        for k, g in enumerate(gaps):
            if 6 * g == N:  # neighbours 60 degrees apart touch: chord at phi_k + 120
                dirs[k].append((phis[k] + 120) % 360)
                dirs[(k + 1) % 5].append((phis[(k + 1) % 5] - 120) % 360)
        if all(((psi - d[0]) * N / 360).denominator == 1 for d in dirs.values() for psi in d):
            return True
    return False


def compositions(total, parts, least):
    if parts == 1:
        if total >= least:
            yield (total,)
        return
    for first in range(least, total - least * (parts - 1) + 1):
        for rest in compositions(total - first, parts - 1, least):
            yield (first,) + rest


def records_remarks():
    """Section 9 ([CALC], outside the proof), in floating point from data/records.json:
    (1) no polygon-in-circle record lies below F(N, P) where rho0(P) is proven, and which ones
    equal it; (2) for which N <= 100 the stored circle configurations for P = 10, 12, 14, 18,
    37 satisfy the congruence condition (contacts detected to 1e-9, directions to 1e-9 rad)."""
    import json
    import math

    recs = json.loads((ROOT / "data/records.json").read_text(encoding="utf-8"))["records"]
    circle = {r["P"]: r for r in recs if r["N"] == 0 and r["M"] == 0}
    checked, below, equal = 0, [], []
    for r in recs:
        c = circle.get(r["P"])
        if r["M"] != 0 or r["N"] < 3 or not c or c["status"] != "proven":
            continue
        N, P = r["N"], r["P"]
        bound = math.hypot(c["value"] / (2 * math.tan(math.pi / N)), 0.5)
        tol = 10.0 ** -r["display_precision"]
        checked += 1
        if r["value"] + tol < bound:
            below.append((N, P))
        elif abs(r["value"] - bound) <= tol:
            equal.append((N, P))
    classes = {}
    for P in (10, 12, 14, 18, 37):
        pts = [(q["x"], q["y"]) for q in circle[P]["pieces"]]
        a = circle[P]["value"] - 1
        dirs = [[math.atan2(y, x)] if math.hypot(x, y) >= a - 1e-9 else [] for x, y in pts]
        for i, j in itertools.combinations(range(P), 2):
            dx, dy = pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]
            if math.hypot(dx, dy) <= 2 + 1e-9:
                dirs[i].append(math.atan2(dy, dx))
                dirs[j].append(math.atan2(-dy, -dx))

        def congruent(N):
            step = 2 * math.pi / N
            return all(abs((psi - d[0]) / step - round((psi - d[0]) / step)) * step < 1e-9 for d in dirs for psi in d)

        classes[P] = [N for N in range(3, 101) if congruent(N)]
    return checked, below, equal, classes


def table_rows(cfgs):
    rows = []
    for cfg in cfgs:
        rho0 = cfg.a.decimal()[0] + 1
        for N in cfg.classes:
            r = inradius(N)
            rows.append((cfg.P, N, (r * r * rho0 * rho0 + Decimal(1) / 4).sqrt()))
    return rows


def fmt(v, places=15):
    return f"{v.quantize(Decimal(10) ** -places)}"


def doc_rows():
    """(P, N, value) rows of the tables in the proof page: lines `| P | N | value |`."""
    out = {}
    pattern = re.compile(r"^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([0-9.]+)\s*\|\s*$")
    section = None
    for line in DOC.read_text(encoding="utf-8").splitlines():
        if line.startswith("#"):
            section = line
        m = pattern.match(line)
        if m:
            out.setdefault(section, []).append((int(m.group(1)), int(m.group(2)), m.group(3)))
    return out


# ------------------------------------------------------------------------------------------
# The page's own tables, parsed from the Markdown and compared with the data above
# ------------------------------------------------------------------------------------------


def _evaluate(expr, env):
    """Exact value of an arithmetic expression in integers and the variables of env."""
    import ast

    ops = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b}

    def ev(n):
        if isinstance(n, ast.Constant) and isinstance(n.value, int):
            return Fraction(n.value)
        if isinstance(n, ast.Name) and n.id in env:
            return Fraction(env[n.id])
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub):
            return -ev(n.operand)
        if isinstance(n, ast.BinOp) and type(n.op) in ops:
            return ops[type(n.op)](ev(n.left), ev(n.right))
        raise ValueError(f"cannot read {expr!r}")

    return ev(ast.parse(expr, mode="eval").body)


def _arith(tex):
    """'$120^\\circ + 40^\\circ k$' -> '120 + 40*k'; '2j-1' -> '2*j-1'."""
    t = tex.replace("$", "").replace("^\\circ", "").replace("−", "-").replace("{", "(").replace("}", ")")
    return re.sub(r"(\d)\s*([a-z(])", r"\1*\2", t).strip()


def _range(tex):
    """'$k = 0, 3, 4, \\dots, 9$' -> ('k', [0, 3, 4, 5, 6, 7, 8, 9]); '' -> (None, [None])."""
    t = tex.replace("$", "").strip()
    if not t:
        return None, [None]
    var, rhs = (x.strip() for x in t.split("="))
    items = [x.strip() for x in rhs.split(",")]
    out = []
    for i, item in enumerate(items):
        if item in ("\\dots", "\\ldots", "…"):
            out.extend(range(out[-1] + 1, int(items[i + 1])))
        else:
            out.append(int(item))
    return var, out


def _circle(tex, env, mods):
    """'W_{k+1}' at k = 3 -> 'W4'; 'X_1' -> 'X1'; 'O' -> 'O'. Indices reduced by mods."""
    m = re.fullmatch(r"([A-Z])(?:_\{?([^}]*)\}?)?", tex.strip())
    if not m:
        raise ValueError(f"cannot read circle {tex!r}")
    if m.group(2) is None:
        return m.group(1)
    k = int(_evaluate(_arith(m.group(2)), env))
    return f"{m.group(1)}{k % mods[m.group(1)] if m.group(1) in mods else k}"


def _cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def doc_sections():
    """{section number: lines} for the '### n.m' subsections of the page."""
    out, current = {}, None
    for line in DOC.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^#{2,3} (\d+(?:\.\d+)?)\.? ", line)
        if m:
            current = m.group(1)
            out[current] = []
        elif current:
            out[current].append(line)
    return out


def _table(lines, header):
    """Rows (as cell lists) of the table whose header row starts with `header`."""
    rows, inside = [], False
    for line in lines:
        if line.startswith(header):
            inside, rows = True, []
            continue
        if inside:
            if not line.startswith("|"):
                break
            if not set(line) <= set("|-: "):
                rows.append(_cells(line))
    return rows


def _canonical(contacts):
    """{frozenset(pair): direction from the alphabetically first circle, mod 360}."""
    out = {}
    for i, j, psi in contacts:
        first, psi = (i, psi) if i < j else (j, psi + 180)
        out[frozenset((i, j))] = (first, Fraction(psi) % 360)
    return out


def check_doc_tables(cfgs, rep):
    secs = doc_sections()
    by_p = {c.P: c for c in cfgs}
    # Theorem 2 summary: q_P, the decimal of rho0(P) (truncated), and the count
    rows = _table(secs["2"], "| $P$ | $\\rho_0(P)$ | decimal |")
    rep.check(sorted(int(r[0]) for r in rows) == sorted(by_p), "summary table lists every P")
    for r in rows:
        cfg = by_p[int(r[0])]
        q = int(r[3])
        rep.check(cfg.classes == [N for N in range(3, 101) if N % q == 0], f"summary: q_{cfg.P} = {q}")
        rep.check(int(r[5]) == len(cfg.classes), f"summary: count for P = {cfg.P}")
        dec = re.search(r"(\d+\.\d+)", r[2])
        if dec:
            printed, rho0 = Decimal(dec.group(1)), cfg.a.decimal()[0] + 1
            ulp = Decimal(1).scaleb(-len(dec.group(1).split(".")[1]))
            rep.check(printed <= rho0 < printed + ulp, f"summary: decimal of rho0({cfg.P})")
        else:
            integer = re.fullmatch(r"\$(\d+)\$", r[1])
            rep.check(bool(integer) and cfg.a == int(integer.group(1)) - 1, f"summary: rho0({cfg.P}) = {r[1]}")
    # Section 5.3: q_n = 4n / gcd(4n, n + 2), and the classes of the rings
    import math

    qs = {int(n): int(q) for n, q in re.findall(r"\$q_(\d+) = (\d+)\$", "\n".join(secs["5.3"]))}
    rep.check(sorted(qs) == [2, 3, 4, 5, 6, 7, 8], "Section 5.3 lists q_2..q_8")
    for n, q in qs.items():
        rep.check(q == 4 * n // math.gcd(4 * n, n + 2), f"q_{n} = {q}")
        P = {7: 8, 8: 9}.get(n, n)
        rep.check(by_p[P].classes == [N for N in range(3, 101) if N % q == 0], f"q_{n} gives the classes of P = {P}")
    # Sections 5.4-5.6: contact tables and direction tables
    for sec, P in (("5.4", 11), ("5.5", 13), ("5.6", 19)):
        cfg = by_p[P]
        found = []
        for pair, rng, psi in _table(secs[sec], "| pair | for | $\\psi$ |"):
            var, values = _range(rng)
            names = pair.replace("$", "").strip("()").split(",")
            for v in values:
                env = {var: v} if var else {}
                i, j = (_circle(n, env, cfg.index_mod) for n in names)
                found.append((i, j, _evaluate(_arith(psi), env)))
        rep.check(len(found) == len(cfg.contacts), f"Section {sec}: {len(found)} contacts in the table")
        rep.check(_canonical(found) == _canonical(cfg.contacts), f"Section {sec}: contact table matches")
        dirs = cfg.directions()
        seen = set()
        for name, listed, diffs in _table(secs[sec], "| circle | $\\Psi_i$ (degrees) |"):
            c = _circle(name.replace("$", ""), {}, {})
            listed = [Fraction(x) for x in re.findall(r"-?\d+", listed)]
            diffs = [Fraction(x) for x in re.findall(r"-?\d+", diffs)]
            seen.add(c)
            rep.check(sorted(d % 360 for d in listed) == sorted(dirs[c]), f"Section {sec}: directions of {c}")
            rep.check(diffs == [(d - listed[0]) % 360 for d in listed[1:]], f"Section {sec}: differences of {c}")
        rep.check(seen == set(cfg.points), f"Section {sec}: direction table covers every circle")


def direction_rows(cfg):
    """Rows for the page's direction tables: the wall direction first, the rest by difference."""
    out = []
    for name, dirs in cfg.directions().items():
        first, rest = dirs[0], sorted(dirs[1:], key=lambda d: (d - dirs[0]) % 360)
        label = re.sub(r"([A-Z])(\d+)", lambda m: f"{m[1]}_{{{m[2]}}}" if len(m[2]) > 1 else f"{m[1]}_{m[2]}", name)
        listed = ", ".join(str(d) for d in [first] + rest)
        diffs = ", ".join(str((d - first) % 360) for d in rest)
        out.append(f"| ${label}$ | ${listed}$ | ${diffs}$ |")
    return out


def run(quick=False):
    rep = Report()
    cfgs = configurations()
    rep.say("Exact layer: circle configurations")
    for cfg in cfgs:
        gap, inner, rattlers = check_configuration(cfg, rep)
        found = [N for N in range(3, 101) if cfg.congruent(N)]
        rep.check(found == cfg.classes, f"P={cfg.P}: congruent N {found} != {cfg.classes}")
        rep.say(
            f"  P={cfg.P:2d} {cfg.label}: {len(cfg.contacts)} contacts, {len(cfg.walls)} at the wall, "
            f"rattlers {rattlers or 'none'}; smallest non-contact distance "
            f"{'-' if gap is None else fmt(gap, 6)}; congruent for N <= 100: {found}"
        )
    total = sum(len(c.classes) for c in cfgs)
    rep.check(total == 148, f"Theorem 2 has {total} cases")
    rep.say(f"  Theorem 2 cases: {total}")

    rep.say("90-digit layer: polygon packings")
    worst = {"contact": Decimal(0), "clear": None, "ratio": None}
    cases = [(cfg, N) for cfg in cfgs for N in cfg.classes]
    extra = [(config_six_centre(N), N) for N in theorem3_extra()]
    if quick:
        cases = [(c, N) for c, N in cases if N == c.classes[0]]
        extra = extra[:2]
    for cfg, _ in extra:
        check_configuration(cfg, rep)
    for cfg, N in cases + extra:
        s = check_packing(cfg, N, rep)
        worst["contact"] = max(worst["contact"], s["contact"])
        for key in ("clear", "ratio"):
            if s[key] is not None and not (cfg.P == 6 and N == 3):
                worst[key] = s[key] if worst[key] is None else min(worst[key], s[key])
    rep.say(f"  packings checked: {len(cases)} (Theorem 2) + {len(extra)} (Theorem 3, P = 6)")
    rep.say(f"  largest |gap| over contacts: {worst['contact']:.3e}")
    rep.say(f"  smallest certified separation of other pairs (N > 3): {fmt(worst['clear'], 6)}")
    rep.say(f"  smallest centre distance / 2 R_N of other pairs (N > 3): {fmt(worst['ratio'], 6)}")

    rep.say("Theorem 3, P = 6: the counting step (Lemma 5's configurations, all admissible gap sequences)")
    for N in range(3, 101):
        cfg6 = config_six_centre(N) if N % 2 == 0 and N % 3 and N not in (4, 8, 14) else None
        if cfg6:
            rep.check(cfg6.congruent(N), f"P=6 centre+5 congruent for N={N}")
            rep.check(all(6 * g > N for g in six_gaps(N)), f"P=6 gaps > 60 degrees for N={N}")
        claimed = N % 3 == 0 or (N % 2 == 0 and N not in (4, 8, 14))
        rep.check(theorem3_six(N) == claimed, f"Theorem 3 P=6 at N={N}")
    rep.say(f"  N <= 100 added for P = 6: {theorem3_extra()} ({len(theorem3_extra())})")

    rep.say("Theorem 1 (vertex lemma) on pseudo-random poses")
    slack, face_on = check_vertex_lemma(rep, 60 if quick else 400)
    rep.say(f"  smallest slack (random poses): {slack:.3e}; largest |slack| in face-on poses: {face_on:.3e}")

    rep.say("Remarks of Section 9 (floating point, data/records.json)")
    checked, below, equal, classes = records_remarks()
    rep.check(not below, f"records below the bound: {below}")
    rep.say(f"  polygon-in-circle records with a proven rho0(P): {checked}; below F(N,P): {len(below)}")
    rep.say(f"  equal to F(N,P) within their printed precision: {sorted(equal, key=lambda t: (t[1], t[0]))}")
    for P, ns in classes.items():
        rep.say(f"  stored configuration for P = {P}: congruence condition holds for N <= 100 in {ns}")

    rep.say("Tables in docs/proofs/circle-container-floor.md")
    if DOC.exists():
        check_doc_tables(cfgs, rep)
        rep.say("  summary table of Theorem 2, q_n of Section 5.3, contact and direction tables of 5.4-5.6: compared")
    expected = {(P, N): fmt(v) for P, N, v in table_rows(cfgs)}
    expected3 = {(6, N): fmt(v) for P, N, v in table_rows([config_six_centre(N) for N in theorem3_extra()])}
    if DOC.exists():
        found = doc_rows()
        main = {(P, N): v for sec, rows in found.items() if sec and "Table of the 148" in sec for P, N, v in rows}
        add = {(P, N): v for sec, rows in found.items() if sec and "Table of the 30" in sec for P, N, v in rows}
        rep.check(main == expected, "doc table of the 148 cases matches")
        rep.check(add == expected3, "doc table of the 30 cases matches")
        rep.say(f"  148-case table rows: {len(main)}, 30-case table rows: {len(add)}")
    else:
        rep.check(False, f"{DOC} not found")
    return rep, cfgs


def print_tables():
    cfgs = configurations()
    for cfg in cfgs:
        if cfg.P in (11, 13, 19):
            print(f"P = {cfg.P}")
            print("\n".join(direction_rows(cfg)))
            print()
    for P, N, v in table_rows(cfgs):
        print(f"| {P} | {N} | {fmt(v)} |")
    print()
    for P, N, v in table_rows([config_six_centre(N) for N in theorem3_extra()]):
        print(f"| {P} | {N} | {fmt(v)} |")


def main(argv):
    if "--tables" in argv:
        print_tables()
        return 0
    rep, _ = run(quick="--quick" in argv)
    print("\n".join(rep.lines))
    if rep.failures:
        print(f"\nFAILED: {len(rep.failures)} check(s)")
        for f in rep.failures[:50]:
            print("  " + f)
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
