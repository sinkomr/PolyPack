"""Rigorous lower bounds for one piece on the square or hexagonal torus (P = 1).

  python3 python/torus/p1_bound.py data/torus/p1_bounds.json   # all N in {3,...,8}, sq and hex

Standard library + mpmath intervals (no numpy), like the certifier.

With one piece per cell, the piece K(theta) and its translates by the lattice L F Z^2
(F = I for sq, F = [[1, 1/2], [0, sqrt(3)/2]] for hex) have disjoint interiors iff no
nonzero lattice vector lies in the interior of the difference body D(theta) = K - K. For a
regular N-gon D is the polygon {v : |v . n_k(theta)| <= w for k = 0..N-1} with n_k the edge
normals of K (angle theta + pi/2 + pi/N + 2 pi k / N) and w = r + h, h = R for odd N (a
vertex is opposite each edge) and h = r for even N. So the gauge of v is
max_k |v . n_k| / w and the smallest feasible side is

  L*(theta) = 1 / min_{gamma != 0} gauge(F gamma; theta),     L* = min_theta L*(theta).

For any finite set G of nonzero gamma and any angle interval T,
  L*(theta) >= max_{gamma in G} w / sup_{theta in T} max_k |F gamma . n_k(theta)|
for all theta in T. Branch and bound over T covering one period of D(theta)
(pi/N for odd N, 2 pi/N for even N) proves L* >= min over leaves of these bounds.
"""

import math
import sys

import mpmath
from mpmath import iv

iv.prec = 120
mpmath.mp.prec = 240


def widths(N):
    t = iv.pi / N
    R = 1 / (2 * iv.sin(t))
    r = 1 / (2 * iv.tan(t))
    return r + (R if N % 2 else r)


def gammas(F, K=2):
    out = []
    for m in range(-K, K + 1):
        for n in range(-K, K + 1):
            if (m, n) == (0, 0) or (m < 0 or (m == 0 and n < 0)):
                continue  # gauge(-v) = gauge(v)
            out.append((m * F[0][0] + n * F[0][1], m * F[1][0] + n * F[1][1]))
    return out


def leaf_bound(N, w, vecs, lo, hi):
    """Interval-rigorous lower bound of L*(theta) for theta in [lo, hi] (mpf endpoints)."""
    T = iv.mpf([lo, hi])
    best = None
    for vx, vy in vecs:
        sup = None
        for k in range(N):
            a = T + iv.pi / 2 + iv.pi / N + 2 * iv.pi * k / N
            d = abs(vx * iv.cos(a) + vy * iv.sin(a))
            sup = d.b if sup is None or d.b > sup else sup
        lb = (w / iv.mpf(sup)).a
        best = lb if best is None or lb > best else best
    return best


def float_Lstar(N, F, theta):
    R = 1 / (2 * math.sin(math.pi / N))
    r = 1 / (2 * math.tan(math.pi / N))
    w = r + (R if N % 2 else r)
    g = math.inf
    for m in range(-3, 4):
        for n in range(-3, 4):
            if (m, n) == (0, 0):
                continue
            vx = m * F[0][0] + n * F[0][1]
            vy = m * F[1][0] + n * F[1][1]
            gg = max(abs(vx * math.cos(a) + vy * math.sin(a)) for a in (theta + math.pi / 2 + math.pi / N + 2 * math.pi * k / N for k in range(N))) / w
            g = min(g, gg)
    return 1 / g


def bound(family, N, target_rel=1e-9, max_leaves=200000):
    """Return (rigorous lower bound, float upper value L*(theta*) at the best grid angle)."""
    if family == "sq":
        F = ((iv.mpf(1), iv.mpf(0)), (iv.mpf(0), iv.mpf(1)))
        Ff = ((1.0, 0.0), (0.0, 1.0))
    else:
        h = iv.sqrt(iv.mpf(3)) / 2
        F = ((iv.mpf(1), iv.mpf(1) / 2), (iv.mpf(0), h))
        Ff = ((1.0, 0.5), (0.0, math.sqrt(3) / 2))
    w = widths(N)
    vecs = gammas(F)
    period = mpmath.pi / N if N % 2 else 2 * mpmath.pi / N
    # float estimate of the optimum to set the pruning target
    per_f = float(period)
    grid = [per_f * i / 4000 for i in range(4000)]
    ub = min(float_Lstar(N, Ff, t) for t in grid)
    target = mpmath.mpf(ub) * (1 - mpmath.mpf(target_rel))
    stack = [(mpmath.mpf(0), period)]
    final = []
    leaves = 0
    while stack:
        lo, hi = stack.pop()
        lb = leaf_bound(N, w, vecs, lo, hi)
        leaves += 1
        if lb >= target or hi - lo < mpmath.mpf(10) ** -30 or leaves > max_leaves:
            final.append(lb)
            continue
        mid = (lo + hi) / 2
        stack.append((lo, mid))
        stack.append((mid, hi))
    return min(final), ub, leaves


if __name__ == "__main__":
    import json

    out = {}
    for fam in ("sq", "hex"):
        for N in (3, 4, 5, 6, 7, 8):
            lb, ub, leaves = bound(fam, N)
            # round the proven bound DOWN to a double
            f = float(mpmath.mpf(lb))
            while mpmath.mpf(f) > mpmath.mpf(lb):
                f = math.nextafter(f, -math.inf)
            out["%s/%d" % (fam, N)] = {"lower_bound": f, "float_optimum_estimate": ub, "intervals": leaves}
            print("%-3s N=%d  L* >= %.15f  (float value %.12f, %d intervals)" % (fam, N, f, ub, leaves))
            sys.stdout.flush()
    if len(sys.argv) > 1:
        with open(sys.argv[1], "w") as fh:
            json.dump(out, fh, indent=1)
