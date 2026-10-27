"""Independent float64 SAT, primal enclosure LP and orientation search."""

import itertools
import math
from functools import cache

TOL = 1e-9
# Radius of a disk piece (N = 0): disk pieces have diameter 1. A circle container is scored by its diameter.
DISK_RADIUS = 0.5


def vertices(n, pose):
    radius = 1 / (2 * math.sin(math.pi / n))
    return [
        (
            pose["x"]
            + radius * math.cos(pose["theta"] + math.pi / 2 + 2 * math.pi * k / n),
            pose["y"]
            + radius * math.sin(pose["theta"] + math.pi / 2 + 2 * math.pi * k / n),
        )
        for k in range(n)
    ]


def separation(n, a, b):
    if n == 0:
        return math.hypot(a["x"] - b["x"], a["y"] - b["y"]) - 2 * DISK_RADIUS
    pa, pb = vertices(n, a), vertices(n, b)
    best = -math.inf
    for polygon in (pa, pb):
        for i, p in enumerate(polygon):
            q = polygon[(i + 1) % n]
            ux, uy = q[1] - p[1], p[0] - q[0]
            norm = math.hypot(ux, uy)
            ux, uy = ux / norm, uy / norm
            aa = [x * ux + y * uy for x, y in pa]
            bb = [x * ux + y * uy for x, y in pb]
            best = max(best, min(bb) - max(aa), min(aa) - max(bb))
    return best


def hull(points):
    points = sorted(set(points))
    if len(points) <= 2:
        return points

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and cross(out[-2], out[-1], p) <= 0:
                out.pop()
            out.append(p)
        return out

    return half(points)[:-1] + half(reversed(points))[:-1]


def solve3(rows, rhs):
    a = [list(row) + [b] for row, b in zip(rows, rhs)]
    for col in range(3):
        pivot = max(range(col, 3), key=lambda i: abs(a[i][col]))
        if abs(a[pivot][col]) < 1e-12:
            return None
        a[col], a[pivot] = a[pivot], a[col]
        d = a[col][col]
        a[col] = [v / d for v in a[col]]
        for i in range(3):
            if i != col:
                d = a[i][col]
                a[i] = [v - d * w for v, w in zip(a[i], a[col])]
    return tuple(a[i][3] for i in range(3))


@cache
def polygon_basis(m):
    """Precompute primal bases in container coordinates, independent of phi."""
    normals = tuple(
        (
            math.cos(-math.pi / 2 + 2 * math.pi * j / m),
            math.sin(-math.pi / 2 + 2 * math.pi * j / m),
        )
        for j in range(m)
    )
    bases = []
    for ids in itertools.combinations(range(m), 3):
        rows = [(1, *normals[i]) for i in ids]
        columns = [solve3(rows, unit) for unit in ((1, 0, 0), (0, 1, 0), (0, 0, 1))]
        if columns[0] is not None:
            inverse = tuple(tuple(columns[j][i] for j in range(3)) for i in range(3))
            bases.append((ids, inverse))
    return normals, tuple(bases)


def enclosing_polygon(points, pad, m, phi):
    normals, bases = polygon_basis(m)
    cosine, sine = math.cos(phi), math.sin(phi)
    rotated = [(x * cosine + y * sine, y * cosine - x * sine) for x, y in points]
    support = [max(x * ux + y * uy for x, y in rotated) + pad for ux, uy in normals]
    best = math.inf
    # Enumerate primal LP vertices and check every inequality. This does not
    # share TypeScript's dual support combinations or its feasibility shortcut.
    for ids, inverse in bases:
        rhs = [support[i] for i in ids]
        a = sum(v * h for v, h in zip(inverse[0], rhs))
        if a >= best:
            continue
        cx = sum(v * h for v, h in zip(inverse[1], rhs))
        cy = sum(v * h for v, h in zip(inverse[2], rhs))
        # Only roundoff slack: using the touching tolerance here would bias
        # orientation minima toward slightly infeasible primal bases.
        slack = 2e-13 * max(1, abs(a), abs(cx), abs(cy))
        if all(
            a + cx * ux + cy * uy >= hi - slack
            for (ux, uy), hi in zip(normals, support)
        ):
            best = a
    if not math.isfinite(best):
        raise ValueError("enclosing LP failed")
    return 2 * best * math.tan(math.pi / m)


def auto_oriented_polygon(points, pad, m, phi0=0):
    """Independently scan and refine local minima over one orientation period.

    Twice the server's minimum sample density and all sampled local minima
    reduce the chance that a narrow basin is missed. This remains numerical
    search rather than a global optimality certificate.
    """
    period = 2 * math.pi / m
    count = min(2048, max(512, 8 * (len(points) + m)))
    step = period / count
    objective = lambda phi: enclosing_polygon(points, pad, m, phi)
    values = [objective(i * step) for i in range(count)]
    best = min(objective(phi0), values[0])
    golden = (math.sqrt(5) - 1) / 2
    for i, value in enumerate(values):
        if value > values[i - 1] or value > values[(i + 1) % count]:
            continue
        lo, hi = (i - 1) * step, (i + 1) * step
        x1, x2 = hi - golden * (hi - lo), lo + golden * (hi - lo)
        f1, f2 = objective(x1), objective(x2)
        while hi - lo > 2e-14:
            if f1 < f2:
                hi, x2, f2 = x2, x1, f1
                x1 = hi - golden * (hi - lo)
                f1 = objective(x1)
            else:
                lo, x1, f1 = x1, x2, f2
                x2 = lo + golden * (hi - lo)
                f2 = objective(x2)
        best = min(best, value, objective((lo + hi) / 2))
    return best


def enclosing_circle(points, pad):
    best = math.inf

    def consider(cx, cy, r):
        nonlocal best
        if r < best and all(math.hypot(x - cx, y - cy) <= r + 1e-10 for x, y in points):
            best = r

    for x, y in points:
        consider(x, y, 0)
    for a, b in itertools.combinations(points, 2):
        consider((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, math.dist(a, b) / 2)
    # Exhaust all support triples rather than sharing the Welzl algorithm.
    for a, b, c in itertools.combinations(points, 3):
        bx, by = b[0] - a[0], b[1] - a[1]
        dx, dy = c[0] - a[0], c[1] - a[1]
        det = 2 * (bx * dy - by * dx)
        if abs(det) < 1e-15:
            continue
        b2, d2 = bx * bx + by * by, dx * dx + dy * dy
        ux, uy = (dy * b2 - by * d2) / det, (bx * d2 - dx * b2) / det
        consider(a[0] + ux, a[1] + uy, math.hypot(ux, uy))
    # the site scores a circle container by its diameter
    return 2 * (best + pad)


def evaluate(config, phi=None, *, auto_orient=True):
    n, m, ps = config["N"], config["M"], config["pieces"]
    valid = len(ps) == config["P"] and all(
        separation(n, a, b) >= -TOL for a, b in itertools.combinations(ps, 2)
    )
    if not ps:
        return valid, None
    points = hull(
        [(p["x"], p["y"]) for p in ps]
        if n == 0
        else [v for p in ps for v in vertices(n, p)]
    )
    pad = DISK_RADIUS if n == 0 else 0
    phi = config.get("container_phi", 0) if phi is None else phi
    if m == 0:
        score = enclosing_circle(points, pad)
    elif auto_orient:
        score = auto_oriented_polygon(points, pad, m, phi)
    else:
        score = enclosing_polygon(points, pad, m, phi)
    return valid, score
