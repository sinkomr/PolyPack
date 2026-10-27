"""Rigorous upper bounds on P_max(N, M) (the most unit pieces that fit in some regular M-gon) and
lower bounds on the container size s(P), at K = -1 (hyperbolic) and K = +1 (spherical).

All decisions use interval arithmetic (rigorous.py: mpmath iv arithmetic + series with remainder).
Arguments, each labelled in the output:

  area        K=-1: every regular M-gon is inside the ideal M-gon of area (M-2) pi, so P A_N < (M-2) pi.
              K=+1: every admissible container lies in an open hemisphere, so P A_N < 2 pi.
  cusp        K=-1: in the upper half-plane normalise a cusp of the ideal M-gon to the strip 0 < x < 1.
              A piece placed in the strip is y0 Q_theta + x0 (Q_theta: the piece centred at i), so it
              fits only if y0 width(Q_theta) <= 1 and then its top is <= Y* = max_theta top/width.
              The region {y > Y*} of each cusp (area 1/Y*) is unusable; for Y* >= 1 these M regions are
              disjoint (the area-1 horoball neighbourhoods of a regular ideal polygon are disjoint).
              So P A_N < (M-2) pi - M / Y*. Y* is bounded above by interval branch-and-bound over theta.
  inradius    a piece contains its inscribed disk (radius rho_N); a regular M-gon has inradius below
              the ideal value acosh(1/sin(pi/M)) (K=-1). rho_N >= that  =>  P_max = 0.
  near-wall   K=-1: a centre c at distance a whose direction makes angle <= pi/M with the normal of
              the nearest ideal wall has n.c >= -cot(pi/M) e^{-a}; the inscribed disk needs
              n.c <= -sinh(rho). So every admissible centre has a <= a_rho = ln(cot(pi/M)/sinh rho).
              Two pieces have centre distance >= 2 rho (disjoint inscribed disks), so a_rho < rho => P_max <= 1.
              K=+1: the inscribed disk lies in the open hemisphere, so a < pi/2 - rho; rho > pi/4 => P_max <= 1.
  centre-bb   K=-1: interval branch-and-bound over (centre, orientation) shows that no orientation of a
              piece centred at distance >= r0 from O fits in the ideal M-gon. r0 = 0 => P_max = 0;
              r0 <= rho => P_max <= 1 (two admissible centres are < 2 rho apart).

Usage: python3 python/curved/bounds.py [--bb] [--out data/curved/bounds.json]
"""
import json
import math
import sys
import os
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rigorous as rg  # noqa: E402
from mpmath import iv, mpf  # noqa: E402

I = rg.I
PI = rg.pi_iv()
DISK_RADIUS = Fraction(1, 2)  # a disk piece (N = 0) has diameter 1 (packages/curved/src/shapes.ts)


def exp_iv(x):
    """e^x = cosh x + sinh x (rigorous series)."""
    m1 = I(-1)
    return rg.csK(m1, x) + rg.snK(m1, x)


def inv_increasing(f, y, guess, lo_lim, hi_lim, rel=1e-30):
    """Enclosure [x_lo, x_hi] of the solution of f(x) = y for an increasing f, verified with f."""
    g = float(guess)
    w = max(abs(g), 1.0) * 1e-14
    for _ in range(60):
        xl = mpf(max(lo_lim, g - w))
        xh = mpf(min(hi_lim, g + w))
        if (f(iv.mpf(xl)) - y).b < 0 and (f(iv.mpf(xh)) - y).a > 0:
            return iv.mpf([xl, xh])
        w *= 4
    raise ValueError("inverse enclosure failed")


def asinh_iv(y):
    yf = float(y.a)
    return inv_increasing(lambda x: rg.snK(I(-1), x), y, math.asinh(yf), -1e6, 1e6)


def asin_iv(y):
    yf = float(y.a)
    return inv_increasing(lambda x: rg.cos_sin(x)[1], y, math.asin(max(-1, min(1, yf))), -1.5707963, 1.5707963)


def piece_data(K, N):
    """Interval circumradius, inradius and area of the unit piece at K = +-1."""
    Ki = I(K)
    if N == 0:
        one = I(DISK_RADIUS)  # a disk of diameter 1 (2026-10-27)
        area = 2 * PI * (1 - rg.csK(Ki, one)) / Ki if K != 0 else PI * one * one
        return {"R": one, "rho": one, "area": area}
    cN, sN = rg.cos_sin(PI / N)
    half = I(Fraction(1, 2))
    if K < 0:
        R = asinh_iv(rg.snK(Ki, half) / sN)
        rho = asinh_iv((rg.snK(Ki, half) / rg.csK(Ki, half)) * cN / sN)
    else:
        R = asin_iv(rg.snK(Ki, half) / sN)
        rho = asin_iv((rg.snK(Ki, half) / rg.csK(Ki, half)) * cN / sN)
    # interior angle: sin(alpha/2) = cos(pi/N) / cs_K(1/2)
    alpha = 2 * asin_iv(cN / rg.csK(Ki, half))
    area = ((N - 2) * PI - N * alpha) if K < 0 else (N * alpha - (N - 2) * PI)
    return {"R": R, "rho": rho, "area": area}


def ideal_inradius(M):
    cM, sM = rg.cos_sin(PI / M)
    return asinh_iv(cM / sM)  # sinh h = cot(pi/M)


# ---------------------------------------------------------------------------------------------
# Y* = max over theta of top/width of the piece centred at i in the upper half-plane (K = -1)


def _half_plane_vertices(R, N, th):
    """Vertices (x, y) of the unit piece centred at i with vertex 0 at direction theta from the
    vertical (interval th). Point at distance R from i in direction making angle a with +y:
    via the disk model w = tanh(R/2) e^{i(a + pi/2)}, z = i (1 + w)/(1 - w)."""
    m1 = I(-1)
    t = rg.snK(m1, R / 2) / rg.csK(m1, R / 2)  # tanh(R/2)
    out = []
    for j in range(N):
        a = th + PI / 2 + 2 * PI * j / N
        c, s = cos_sin_mv(a)
        wr, wi = t * c, t * s
        # z = i (1+w)/(1-w):  (1+w)/(1-w) = ((1+wr) + i wi)((1-wr) + i wi)/|1-w|^2
        den = (1 - wr) ** 2 + wi ** 2
        re = ((1 + wr) * (1 - wr) - wi * wi) / den
        im = (wi * (1 - wr) + (1 + wr) * wi) / den
        # multiply by i: x = -im, y = re
        out.append((-im, re))
    return out


def cos_sin_mv(a):
    """cos/sin of an interval by the mean-value form around the midpoint (|cos'|, |sin'| <= 1)."""
    m = (a.a + a.b) / 2
    r = (a.b - a.a) / 2
    c, s = rg.cos_sin(iv.mpf(m))
    e = iv.mpf([-r, r])
    return c + e, s + e


def top_width_upper(R, N, th):
    v = _half_plane_vertices(R, N, th)
    xs = [p[0] for p in v]
    ys = [p[1] for p in v]
    top = max(y.b for y in ys)
    # edges are arcs of circles centred on the real axis; if the apex can lie inside the arc,
    # the arc's radius bounds the top: radius^2 = (x - c)^2 + y^2 with c the centre
    for j in range(N):
        (x1, y1), (x2, y2) = v[j], v[(j + 1) % N]
        dx = x1 - x2
        D = x1 * x1 + y1 * y1 - x2 * x2 - y2 * y2
        # the circle centre c = D / (2 dx) lies between x1 and x2 (apex inside the arc) iff
        # F = (2 dx x1 - D)(2 dx x2 - D) <= 0; this form needs no division
        F = (2 * dx * x1 - D) * (2 * dx * x2 - D)
        if F.a > 0:
            continue
        if dx.a <= 0 <= dx.b:
            return None
        c = D / (2 * dx)
        rad = rg.sqrt_pos((x1 - c) ** 2 + y1 * y1)
        top = max(top, rad.b)
    xmax_lo = max(x.a for x in xs)
    xmin_hi = min(x.b for x in xs)
    width_lo = (xmax_lo - xmin_hi).a  # rigorous lower bound of the width (point interval)
    if not width_lo > 0:
        return None
    return (top / width_lo).b  # rigorous upper bound of top/width (point interval)


_YSTAR = {}


def ystar_upper(N, K=-1, tol=1e-6, max_boxes=200000):
    """Rigorous upper bound on Y*(N) by bisection over theta in [0, 2 pi/N) (cached per N, tol)."""
    key = (N, tol, iv.prec)
    if key in _YSTAR:
        return _YSTAR[key]
    _YSTAR[key] = _ystar_upper(N, K, tol, max_boxes)
    return _YSTAR[key]


def _ystar_upper(N, K, tol, max_boxes):
    R = piece_data(K, N)["R"]
    stack = [(mpf(0), (2 * PI / N).b)]
    best_lower = mpf(0)
    result = mpf(0)
    boxes = 0
    while stack:
        a, b = stack.pop()
        boxes += 1
        if boxes > max_boxes:
            raise RuntimeError("Y* bisection did not finish")
        ub = top_width_upper(R, N, iv.mpf([a, b]))
        mid = (a + b) / 2
        point = top_width_upper(R, N, iv.mpf(mid))
        if point is not None:
            best_lower = max(best_lower, point)
        if ub is not None and ub <= best_lower * (1 + tol):
            result = max(result, ub)
            continue
        if ub is not None and b - a < mpf(1e-9):
            result = max(result, ub)
            continue
        stack.append((a, mid))
        stack.append((mid, b))
    return result, boxes


# ---------------------------------------------------------------------------------------------
# Centre branch-and-bound at K = -1


def _transform_box(K, xs, ys, th, verts):
    """World vertices for x in xs, y in ys, theta in th (intervals)."""
    c, s = cos_sin_mv(th)
    D2 = xs * xs + ys * ys
    t = K * D2
    S = rg.Sfun(t)
    V = rg.Vfun(t)
    C = 1 - K * D2 * V
    out = []
    for (v0, v1, v2) in verts:
        w1 = c * v1 - s * v2
        w2 = s * v1 + c * v2
        dot = xs * w1 + ys * w2
        out.append((C * v0 - K * S * dot, S * xs * v0 + w1 - K * V * dot * xs, S * ys * v0 + w2 - K * V * dot * ys))
    return out


def centre_bb(N, M, r0, max_boxes=400000, prec=96):
    """Prove: no orientation of a unit N-gon centred at distance in [r0, a_rho] from O fits in the
    ideal M-gon at K = -1. Returns (proved, boxes)."""
    old = iv.prec
    iv.prec = prec
    try:
        K = I(-1)
        pd = piece_data(-1, N)
        rho = pd["rho"]
        cM, sM = rg.cos_sin(PI / M)
        cot = cM / sM
        # admissible centres satisfy a <= a_rho = ln(cot / sinh rho)
        a_rho = math.log(float(cot.b) / float(rg.snK(K, rho).a)) + 1e-9
        if a_rho <= float(r0):
            return True, 0
        # standard piece vertices
        cN, sN = rg.cos_sin(PI / N)
        snR = rg.snK(K, I(Fraction(1, 2))) / sN
        csR = rg.sqrt_pos(1 - K * snR * snR)
        verts = []
        for k in range(N):
            c, s = rg.cos_sin(PI / 2 + 2 * PI * k / N)
            verts.append((csR, snR * c, snR * s))
        # ideal walls: n_k = (-sinh h, cosh h u_k), sinh h = cot(pi/M), cosh h = 1/sin(pi/M)
        walls = []
        for k in range(M):
            c, s = rg.cos_sin(-PI / 2 + 2 * PI * k / M)
            walls.append((-cot, c / sM, s / sM))
        boxes = 0
        # domain: a in [r0, a_rho], phi in [0, 2 pi/M) (rotation symmetry), theta in [0, 2 pi / N)
        stack = [(mpf(r0), mpf(a_rho), mpf(0), (2 * PI / M).b, mpf(0), (2 * PI / N).b)]
        while stack:
            a0, a1, p0, p1, t0, t1 = stack.pop()
            boxes += 1
            if boxes > max_boxes:
                return False, boxes
            A = iv.mpf([a0, a1])
            cp, sp = cos_sin_mv(iv.mpf([p0, p1]))
            xs, ys = A * cp, A * sp
            vs = _transform_box(K, xs, ys, iv.mpf([t0, t1]), verts)
            excluded = False
            for n in walls:
                for v in vs:
                    if (n[0] * v[0] + n[1] * v[1] + n[2] * v[2]).a > 0:
                        excluded = True
                        break
                if excluded:
                    break
            if excluded:
                continue
            # split the widest dimension (scaled: angles count with radius factor)
            wa = a1 - a0
            wp = (p1 - p0) * a1
            wt = (t1 - t0) * 0.7
            if wa >= wp and wa >= wt:
                m = (a0 + a1) / 2
                stack += [(a0, m, p0, p1, t0, t1), (m, a1, p0, p1, t0, t1)]
            elif wp >= wt:
                m = (p0 + p1) / 2
                stack += [(a0, a1, p0, m, t0, t1), (a0, a1, m, p1, t0, t1)]
            else:
                m = (t0 + t1) / 2
                stack += [(a0, a1, p0, p1, t0, m), (a0, a1, p0, p1, m, t1)]
            if wa < 1e-7 and wp < 1e-7 and wt < 1e-7:
                return False, boxes
        return True, boxes
    finally:
        iv.prec = old


# ---------------------------------------------------------------------------------------------


def floor_strict(x):
    """Upper bound on max{P integer : P < x} for the true value x in the interval: the largest
    integer strictly below the UPPER end x.b (x may be anywhere in [x.a, x.b])."""
    hi = x.b
    f = int(math.floor(float(hi)))
    while f >= hi:
        f -= 1
    while f + 1 < hi:
        f += 1
    return f


# (N, M) -> target: 0 = prove no piece fits; 1 = prove no admissible centre at distance >= rho.
# Squares in a square and pentagons in a pentagon are not listed: there the r0 = rho target is false
# (a single piece centred slightly beyond rho still fits), so the test cannot settle them.
BB_TASKS = {(4, 3): 0, (6, 6): 1}
BB_MAX_BOXES = 80000


def bounds_for(K, N, M, run_bb=False):
    pd = piece_data(K, N)
    out = {"K": K, "N": N, "M": M, "args": {}}
    A = pd["area"]
    rho = pd["rho"]
    if K < 0:
        if M == 0:
            out["P_max_upper"] = None
            out["args"]["note"] = "disk containers hold any number of pieces"
            return out
        cap_area = floor_strict(((M - 2) * PI) / A)
        out["args"]["area"] = cap_area
        best = cap_area
        hinf = ideal_inradius(M)
        if (rho - hinf).a >= 0:
            out["args"]["inradius"] = 0
            best = 0
        if N == 0:
            Y = 1 / (1 - exp_iv(I(-2 * DISK_RADIUS)))  # exact for a disk of radius r: e^r / (2 sinh r)
            ystar = Y.b
        else:
            old_prec = iv.prec
            iv.prec = 96
            try:
                ystar, _ = ystar_upper(N, tol=1e-3)
            finally:
                iv.prec = old_prec
        out["args"]["Ystar_upper"] = float(ystar)
        if ystar >= 1:
            cusp = floor_strict(((M - 2) * PI - M / iv.mpf(ystar)) / A)
            out["args"]["cusp"] = max(cusp, 0)
            best = min(best, max(cusp, 0))
        cM, sM = rg.cos_sin(PI / M)
        cot = cM / sM
        sinh_rho = rg.snK(I(-1), rho)
        # a_rho < rho  <=>  cot < e^rho sinh rho
        if (cot - exp_iv(rho) * sinh_rho).b < 0:
            out["args"]["near_wall"] = 1
            best = min(best, 1)
        if run_bb and N > 0 and (N, M) in BB_TASKS:
            goal = BB_TASKS[(N, M)]
            r0 = 0.0 if goal == 0 else float(rho.a)
            proved, nb = centre_bb(N, M, r0, max_boxes=BB_MAX_BOXES)
            out["args"][f"centre_bb_r0_{'0' if goal == 0 else 'rho'}"] = {"proved": proved, "boxes": nb, "r0": r0}
            if proved:
                best = min(best, goal)
        out["P_max_upper"] = best
    else:
        cap_area = floor_strict((2 * PI) / A)
        out["args"]["area"] = cap_area
        best = cap_area
        if (rho - PI / 4).a > 0:
            out["args"]["near_wall"] = 1
            best = min(best, 1)
        out["P_max_upper"] = best
    out["rho"] = float(rho.a)
    out["area"] = float(A.a)
    return out


def main(argv):
    run_bb = "--bb" in argv
    res = []
    for K in (-1, 1):
        for N in (0, 3, 4, 5, 6, 8):
            if K > 0 and N == 8:
                res.append({"K": K, "N": N, "note": "no unit octagon exists at K = +1 (perimeter 8 > 2 pi)", "P_max_upper": 0})
                continue
            for M in (0, 3, 4, 5, 6, 8):
                b = bounds_for(K, N, M, run_bb=run_bb and K < 0)
                res.append(b)
                print(K, N, M, b.get("P_max_upper"), b["args"], flush=True)
    if "--out" in argv:
        with open(argv[argv.index("--out") + 1], "w") as f:
            json.dump({"generated_by": "python/curved/bounds.py", "bounds": res}, f, indent=1)


if __name__ == "__main__":
    main(sys.argv)
