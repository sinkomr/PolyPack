"""Rigorous lower bounds on rho for sphere/N/P (stdlib + mpmath intervals; no numpy).

Every bound is returned as a float L together with an interval PROOF that every packing has
rho >= L (for rho < L the stated necessary condition fails). The float L is found by a float
formula and lowered by a relative 1e-12 before the interval check, so it is slightly weaker than
the exact bound. Functions return None when the argument gives nothing.

Arguments (unit sphere, piece size a = 1/rho; a increases as rho decreases, and every
quantity used below is monotone in a):
  existence  a convex regular N-gon needs R < pi/2, i.e. a < 2 pi/N:  rho > N/(2 pi).
  area       interior-disjoint pieces: P A(a) <= 4 pi; A = N alpha - (N - 2) pi with
             cos(pi/N) = cos(a/2) sin(alpha/2); disks A = 2 pi (1 - cos a).
  fejes_toth (disks, P >= 3) the minimal angle of P points satisfies cos theta >= (cot^2 w - 1)/2,
             w = pi P / (6 (P - 2)) [L. Fejes Toth 1943]; disks need 2a <= theta.
  inradius   (polygons) the inscribed caps (sin r = tan(a/2)/tan(pi/N)) are disjoint, so their centres
             form a code with angle >= 2r: 2r <= theta_P <= theta_bound (Fejes Toth, or the proven
             Tammes value when one is published).
  maximality (polygons) de Oliveira Filho, Spomer & Vallentin (arXiv:2604.21451, Table 2) prove that
             P - 1 copies at circumradius rho_lit (truncated to 6 decimals in the paper) admit no P-th
             copy; packability is monotone in the size, so P copies need R < rho_lit + 1e-6.
"""
import math
import os
import sys
from fractions import Fraction

from mpmath import iv

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from rig import rg  # noqa: E402  (python/curved/rigorous.py, loaded read-only by explicit path)

I = rg.I
PI = math.pi


def _lower(L):
    return L * (1 - 1e-12)


def existence_bound(N):
    """rho > N/(2 pi): checked in intervals as 1/L > 2 pi/N (then every rho < L has a > 2 pi/N)."""
    if N == 0:
        return None
    L = N / (2 * PI) * (1 - 1e-15)
    if rg.is_pos(I(1) / I(Fraction(L)) - 2 * rg.pi_iv() / N):
        return L
    return None


def _verify_area(N, P, L):
    a = I(1) / I(Fraction(L))
    pi = rg.pi_iv()
    if N == 0:
        ca, _ = rg.cos_sin(a)
        if not rg.is_neg(a - pi):
            return False
        return rg.is_neg(ca - (1 - I(Fraction(2, P))))  # cos a < 1 - 2/P  => P A(a) > 4 pi
    alpha_star = ((N - 2) * pi + 4 * pi / P) / N
    if not rg.is_neg(alpha_star - pi):
        return False
    cpn, _ = rg.cos_sin(pi / N)
    ch, _ = rg.cos_sin(a / 2)
    _, sas = rg.cos_sin(alpha_star / 2)
    # alpha(a) > alpha*  <=>  cos(pi/N)/cos(a/2) > sin(alpha*/2)
    return rg.is_pos(ch) and rg.is_pos(cpn / ch - sas)


def area_bound(N, P):
    if N == 0:
        a = math.acos(1 - 2 / P)
        L = _lower(1 / a)
    else:
        alpha_star = ((N - 2) * PI + 4 * PI / P) / N
        if alpha_star >= PI:
            return None
        ca = math.cos(PI / N) / math.sin(alpha_star / 2)
        if ca >= 1:
            return None
        a = 2 * math.acos(ca)
        L = _lower(1 / a)
    return L if _verify_area(N, P, L) else None


def ft_cos(P):
    """Float (cot^2 w - 1)/2."""
    w = PI * P / (6 * (P - 2))
    return (1 / math.tan(w) ** 2 - 1) / 2


def _ft_cos_iv(P):
    pi = rg.pi_iv()
    w = pi * P / (6 * (P - 2))
    c, s = rg.cos_sin(w)
    return ((c * c) / (s * s) - 1) / 2


def fejes_toth_disk_bound(P):
    if P < 3:
        return None
    theta = math.acos(ft_cos(P))
    L = _lower(2 / theta)
    a = I(1) / I(Fraction(L))
    pi = rg.pi_iv()
    c2a, _ = rg.cos_sin(2 * a)
    # 2a > theta_FT  <=>  cos 2a < cos theta_FT  (2a in [0, pi])
    if rg.is_neg(2 * a - pi) and rg.is_neg(c2a - _ft_cos_iv(P)):
        return L
    return None


def tammes_disk_bound(P, cos_theta_lit, slack=Fraction(1, 10 ** 11)):
    """rho >= 2/theta_P from a published Tammes optimum, cos theta_P >= cos_lit - slack."""
    c = Fraction(cos_theta_lit) - slack
    theta = math.acos(float(c))
    L = _lower(2 / theta)
    a = I(1) / I(Fraction(L))
    c2a, _ = rg.cos_sin(2 * a)
    pi = rg.pi_iv()
    if rg.is_neg(2 * a - pi) and rg.is_neg(c2a - I(c)):
        return L
    return None


def inradius_bound(N, P, cos_theta_bound_iv, cos_theta_float):
    """rho >= L where the inscribed caps would need 2 r(1/L) >= theta_bound."""
    theta = math.acos(cos_theta_float)
    # tan(a/2) = sin(theta/2) tan(pi/N)
    t = math.sin(theta / 2) * math.tan(PI / N)
    a = 2 * math.atan(t)
    L = _lower(1 / a)
    aI = I(1) / I(Fraction(L))
    pi = rg.pi_iv()
    ch, sh = rg.cos_sin(aI / 2)
    cp, sp = rg.cos_sin(pi / N)
    sin_r = (sh / ch) / (sp / cp)
    sin_half = rg.sqrt_pos((1 - cos_theta_bound_iv) / 2)
    if rg.is_pos(ch) and rg.is_pos(sin_r - sin_half):
        return L
    return None


def maximality_bound(N, radius_trunc):
    """rho > 1/a(R0) with R0 = radius_trunc + 1e-6 (published maximality of P - 1 copies at R0)."""
    R0 = float(Fraction(str(radius_trunc)) + Fraction(1, 10 ** 6))
    a = 2 * math.asin(math.sin(R0) * math.sin(PI / N))
    L = _lower(1 / a)
    aI = I(1) / I(Fraction(L))
    pi = rg.pi_iv()
    _, sh = rg.cos_sin(aI / 2)
    _, sp = rg.cos_sin(pi / N)
    _, sR0 = rg.cos_sin(I(Fraction(str(radius_trunc)) + Fraction(1, 10 ** 6)))
    # R(1/L) >= R0  <=>  sin(a/2)/sin(pi/N) >= sin R0  (R, R0 < pi/2)
    if rg.is_pos(sh / sp - sR0) and rg.is_neg(I(Fraction(str(radius_trunc))) - pi / 2):
        return L
    return None
