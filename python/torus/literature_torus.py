"""Lower bounds and literature values for the torus tables (converted to PolyPack units).

Units: disks of radius 1, polygons of side 1. Scores: sq/hex side L, free sqrt(cell area).
A packing on a torus lifts to a periodic packing of the plane with the same density, so any
density bound for packings of congruent copies in the plane applies.
"""

import math

SQ3 = math.sqrt(3.0)
ACCESSED = "2026-10-24"


def piece_area(N):
    return math.pi if N == 0 else N / (4.0 * math.tan(math.pi / N))


# Density upper bounds delta(N) for packings of congruent copies in the plane.
DENSITY = {
    0: (
        math.pi / math.sqrt(12.0),
        "[EST] density <= pi/sqrt(12) for congruent disks (Thue 1910; Handbook of Discrete and Computational Geometry, ch. 2, Table 2.1.1)",
    ),
    5: (
        (5.0 - math.sqrt(5.0)) / 3.0,
        "[EST] density <= (5 - sqrt5)/3 for congruent regular pentagons (Hales and Kusner, arXiv:1602.07220 v2, computer-assisted proof; no refereed publication found)",
    ),
    8: (
        (4.0 + 4.0 * math.sqrt(2.0)) / (5.0 + 4.0 * math.sqrt(2.0)),
        "[EST] density <= delta_L = (4 + 4 sqrt2)/(5 + 4 sqrt2) for congruent regular octagons (L. Fejes Toth 1950: delta(K) = delta_L(K) for centrally symmetric convex disks; Handbook ch. 2, p. 29)",
    ),
}
AREA_LABEL = "[CALC] area bound P * A_piece <= cell area"


def score_from_area(fam, area):
    if fam == "hex":
        return math.sqrt(area / (SQ3 / 2.0))
    return math.sqrt(area)


_P1 = None


def p1_bounds():
    """Rigorous P = 1 bounds for sq/hex from p1_bound.py (data/torus/p1_bounds.json)."""
    global _P1
    if _P1 is None:
        import json
        import os

        fn = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "torus", "p1_bounds.json")
        _P1 = json.load(open(fn)) if os.path.exists(fn) else {}
    return _P1


def score_bound(fam, N, P):
    """Best lower bound on the score that we can justify, with its label and source."""
    A = P * piece_area(N)
    if N in DENSITY:
        d, label = DENSITY[N]
        out = {"value": score_from_area(fam, A / d), "label": label, "kind": "density"}
    else:
        out = {"value": score_from_area(fam, A), "label": AREA_LABEL, "kind": "area"}
    if P == 1 and fam in ("sq", "hex"):
        if N == 0:
            out = {"value": 2.0, "label": "[CALC] one disk: the shortest lattice vector L must be >= 2", "kind": "exact"}
        else:
            b = p1_bounds().get("%s/%d" % (fam, N))
            if b and b["lower_bound"] > out["value"]:
                out = {
                    "value": b["lower_bound"],
                    "label": "[CALC] rigorous interval branch and bound over the piece angle (python/torus/p1_bound.py)",
                    "kind": "computer-assisted",
                }
    for lit in literature(fam, N, P):
        if lit.get("status") == "proven" and lit.get("value") and lit["value"] > out["value"]:
            out = {"value": lit["value"], "label": "[EST] proven optimum: " + lit["short"], "kind": "proven"}
    return out


# Literature entries keyed by (family, N, P), verified 2026-10-24 (values converted to
# radius-1 disks / side-1 polygons; L = 2/d for disks at minimal distance d on the unit torus).
MN = ("O. R. Musin, A. V. Nikitenko, Optimal packings of congruent circles on a square flat torus, "
      "Discrete Comput. Geom. 55 (2016) 1-20")
MN_URL = "https://arxiv.org/abs/1212.0649"
DGKX = ("W. Dickinson, D. Guillot, A. Keaton, S. Xhumari, Optimal packings of up to five equal circles on a "
        "square flat torus, Beitr. Algebra Geom. 52 (2011) 315-333 (values as quoted in Musin-Nikitenko, Fig. 2)")
BDEKS = ("Brandt, Dickinson, Ellsworth, Kenkel, Smith, Optimal packings of two to four equal circles on any flat "
         "torus, Discrete Math. 342 (2019) 111597")
BDEKS_URL = "https://arxiv.org/abs/1708.05395"
CFKS = ("R. Connelly, M. Funkhouser, V. Kuperberg, E. Solomonides, Packings of equal disks in a square torus, "
        "Discrete Comput. Geom. 58 (2017) 614-642 (search values, r to 3 decimals; conjectures for 10-16)")
CFKS_URL = "https://arxiv.org/abs/1512.08762"
BSM = ("J. Blair, C. D. Santangelo, J. Machta, Packing squares in a torus, J. Stat. Mech. (2012) P01018, Table I "
       "(density one optimal by construction; the rest conjectured)")
BSM_URL = "https://arxiv.org/abs/1110.5348"
CD = ("R. Connelly, W. Dickinson, Periodic planar disc packings, Phil. Trans. R. Soc. A 372 (2014) 20120039")
CD_URL = "https://arxiv.org/abs/1201.5965"
DGKX6 = ("W. Dickinson, D. Guillot, A. Keaton, S. Xhumari, Optimal packings of up to six equal circles on a "
         "triangular flat torus, J. Geom. 102 (2011) 27-51 (not opened; described in Connelly-Dickinson 2014, sec. 1.4)")
TORDA = ("M. Torda, J. Y. Goulermas, V. Kurlin, G. M. Day, Densest plane group packings of regular polygons, "
         "Phys. Rev. E 106 (2022) 054603, Table I, plane group p1 (5 decimals)")
TORDA_URL = "https://arxiv.org/abs/2207.08959"
KK = ("G. Kuperberg, W. Kuperberg, Double-lattice packings of convex bodies in the plane, Discrete Comput. Geom. 5 "
      "(1990) 389-397 (values as quoted by Kallus and Kusner, arXiv:1509.02241; best known, not proven optimal for heptagons)")
KK_URL = "https://arxiv.org/abs/1509.02241"
HK = "T. Hales, W. Kusner, Packings of regular pentagons in the plane, arXiv:1602.07220 v2 (computer-assisted proof)"
HK_URL = "https://arxiv.org/abs/1602.07220"
FT = ("L. Fejes Toth 1950, as stated in G. Fejes Toth, Packing and covering, Handbook of Discrete and "
      "Computational Geometry, 3rd ed., ch. 2, p. 29: delta(K) = delta_T(K) = delta_L(K) for centrally symmetric K")
FT_URL = "http://www.csun.edu/~ctoth/Handbook/chap2.pdf"


def _e(value, status, short, source, url, note=None):
    out = {"value": value, "status": status, "short": short, "source": source, "url": url, "accessed": ACCESSED}
    if note:
        out["note"] = note
    return out


def _dens_score(fam, N, P, dens):
    return score_from_area(fam, P * piece_area(N) / dens)


S2, S3, S5, S6 = math.sqrt(2.0), SQ3, math.sqrt(5.0), math.sqrt(6.0)
_d6 = S3 / 2 - S2 * math.sqrt(3 * S3 + 2) / 6 + 1 / 6.0
LIT = {
    ("sq", 0, 2): [
        _e(2 * S2, "proven", "Dickinson et al. 2011; Brandt et al. 2019", DGKX + "; " + BDEKS, BDEKS_URL, "L = 2 sqrt2"),
    ],
    ("sq", 0, 3): [
        _e(S6 + S2, "proven", "Dickinson et al. 2011; Brandt et al. 2019", DGKX + "; " + BDEKS, BDEKS_URL, "d = (sqrt6 - sqrt2)/2, L = sqrt6 + sqrt2"),
    ],
    ("sq", 0, 4): [
        _e(S6 + S2, "proven", "Dickinson et al. 2011; Brandt et al. 2019", DGKX + "; " + BDEKS, BDEKS_URL, "d = (sqrt6 - sqrt2)/2, L = sqrt6 + sqrt2"),
    ],
    ("sq", 0, 5): [_e(2 * S5, "proven", "Dickinson et al. 2011", DGKX, MN_URL, "d = 1/sqrt5, L = 2 sqrt5")],
    ("sq", 0, 6): [_e(2 / _d6, "proven", "Musin and Nikitenko 2016, Thm 1", MN, MN_URL, "d = sqrt3/2 - sqrt2 sqrt(3 sqrt3 + 2)/6 + 1/6")],
    ("sq", 0, 7): [_e(2 * (1 + S3), "proven", "Musin and Nikitenko 2016, Thm 2", MN, MN_URL, "d = 1/(1 + sqrt3); three optimal arrangements")],
    ("sq", 0, 8): [_e(2 * (1 + S3), "proven", "Musin and Nikitenko 2016, Thm 3", MN, MN_URL, "d = 1/(1 + sqrt3)")],
    ("sq", 0, 9): [_e(2 * math.sqrt(5 + 2 * S3), "conjecture", "Musin and Nikitenko 2016, Conjecture 2.1", MN, MN_URL, "d = 1/sqrt(5 + 2 sqrt3)")],
    ("sq", 0, 10): [_e(2 * math.sqrt(10.0), "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "square grid, conjectured optimal; table bracket L in [6.3241, 6.3282]")],
    ("sq", 0, 11): [_e(None, "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "table bracket L in [6.5459, 6.5500] (r = 0.153, delta = 0.806)")],
    ("sq", 0, 12): [_e(24 / math.sqrt(13.0), "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "Type I (a, b) = (3, 2): L = 24/sqrt13; table bracket [6.6539, 6.6578]")],
    ("sq", 0, 13): [_e(None, "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "table bracket L in [7.1969, 7.2015] (r = 0.139, delta = 0.788)")],
    ("sq", 0, 14): [_e(None, "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "table bracket L in [7.2382, 7.2425] (r = 0.138, delta = 0.839)")],
    ("sq", 0, 15): [_e(30 / math.sqrt(17.0), "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "Type II (a, b) = (4, 1): L = 30/sqrt17; table bracket [7.2745, 7.2786]")],
    ("sq", 0, 16): [_e(2 * (S6 + S2), "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "table bracket [7.7241, 7.7287]; 2 x 2 copy of the P = 4 optimum gives 2 (sqrt6 + sqrt2) [SPEC identification]")],
    ("hex", 0, 2): [_e(2 * S3, "proven", "Brandt et al. 2019; Dickinson et al. 2011", BDEKS + "; " + DGKX6, BDEKS_URL, "L = 2 sqrt3 (3-point lattice minus one)")],
    ("hex", 0, 5): [_e(None, "proven", "Dickinson et al. 2011 (J. Geom.)", DGKX6, CD_URL, "optimal packing proven there; value not seen (paper not opened)")],
    ("hex", 0, 6): [_e(2 * math.sqrt(7.0), "proven", "Dickinson et al. 2011 (J. Geom.)", DGKX6, CD_URL, "7-point lattice minus one disk, L = 2 sqrt7 (as described by Connelly-Dickinson)")],
}
# square-torus squares (Blair, Santangelo, Machta 2012, Table I): L = sqrt(P / rho)
for _P, _rho, _t in ((3, 3 / 4, "2^2 - 1"), (6, 5 / 6, "gapped bricklayer"), (7, 7 / 8, "2^2 + 2^2 - 1"),
                     (11, 10 / 11, "gapped bricklayer"), (12, 24 / 25, "lattice of 1/2 x 1/2 holes"),
                     (14, 13 / 14, "gapped bricklayer"), (15, 15 / 16, "4^2 - 1")):
    LIT[("sq", 4, _P)] = [_e(math.sqrt(_P / _rho), "best_known", "Blair et al. 2012", BSM, BSM_URL, "density %s (%s); conjectured optimal" % (_rho, _t))]
for _P in (1, 2, 4, 5, 8, 9, 10, 13, 16):
    LIT[("sq", 4, _P)] = [_e(math.sqrt(_P), "proven", "Blair et al. 2012", BSM, BSM_URL, "density one (P is a sum of two squares)")]
# hexagonal torus disks: density pi/sqrt12 iff P = a^2 + ab + b^2 (Connelly-Dickinson Thm 1);
# density-gap conjecture: if P + 1 has that form and P does not, the optimum is the
# (P + 1)-lattice minus one disk, L = 2 sqrt(P + 1)
_EIS = {a * a + a * b + b * b for a in range(0, 8) for b in range(0, 8)}
for _P in range(1, 17):
    if _P in _EIS:
        LIT.setdefault(("hex", 0, _P), []).append(
            _e(2 * math.sqrt(_P), "proven", "Thue; Connelly and Dickinson 2014, Thm 1", CD, CD_URL, "triangular lattice, density pi/sqrt12")
        )
    elif (_P + 1) in _EIS and ("hex", 0, _P) not in LIT:
        LIT[("hex", 0, _P)] = [
            _e(2 * math.sqrt(_P + 1), "conjecture", "Connelly and Dickinson 2014, Density Gap Conjecture 2", CD, CD_URL, "(P + 1)-lattice minus one disk")
        ]
# free lattice: P = 1 is the densest lattice packing; P = 2 double lattices
# Torda et al. give 5 decimals; the score uses our 13-digit critical-determinant value
# (python/torus/lattice_density.py, [CALC]), which agrees with the table to its precision.
for _N, _d in ((3, 2 / 3), (5, 0.8172560023684), (7, 0.8601910243450), (8, (4 + 4 * S2) / (5 + 4 * S2))):
    LIT[("free", _N, 1)] = [
        _e(_dens_score("free", _N, 1, _d), "best_known", "Torda et al. 2022 (p1)", TORDA, TORDA_URL,
           "densest lattice packing, table density %.5f; score from the [CALC] value %.13f" % (math.floor(_d * 1e5) / 1e5, _d))
    ]
LIT[("free", 8, 1)].append(_e(_dens_score("free", 8, 1, (4 + 4 * S2) / (5 + 4 * S2)), "proven", "L. Fejes Toth 1950", FT, FT_URL,
                              "densest packing of congruent regular octagons is the lattice packing, density (4 + 4 sqrt2)/(5 + 4 sqrt2)"))
LIT[("free", 5, 2)] = [_e(_dens_score("free", 5, 2, (5 - S5) / 3), "proven", "Kuperberg and Kuperberg 1990; Hales and Kusner 2016", KK + "; " + HK, HK_URL,
                          "pentagonal ice-ray double lattice, density (5 - sqrt5)/3; optimality: computer-assisted preprint proof")]
_hept = (2 / 97) * (-111 + 492 * math.cos(math.pi / 7) - 356 * math.cos(math.pi / 7) ** 2)
LIT[("free", 7, 2)] = [_e(_dens_score("free", 7, 2, _hept), "best_known", "Kuperberg and Kuperberg 1990", KK, KK_URL,
                          "densest double lattice of the regular heptagon, density 0.8926906861 = (2/97)(-111 + 492 cos(pi/7) - 356 cos^2(pi/7)) (J. Baez, AMS Visual Insight 2014)")]
LIT[("free", 0, 1)] = [_e(_dens_score("free", 0, 1, math.pi / math.sqrt(12.0)), "proven", "Thue 1910", "A. Thue 1910 (Handbook ch. 2, Table 2.1.1)", FT_URL, "hexagonal lattice, density pi/sqrt12")]


def literature(fam, N, P):
    return list(LIT.get((fam, N, P), []))


# Closed forms score = sqrt(P * c) for the (family, N) whose bound is attained by a
# lattice, double-lattice or tiling construction (used when score_float equals the bound).
EXACT_C = {
    ("sq", 4): ("1", 1.0),
    ("free", 4): ("1", 1.0),
    ("hex", 0): ("4", 4.0),
    ("free", 0): ("2 sqrt(3)", 2.0 * SQ3),
    ("hex", 6): ("3", 3.0),
    ("free", 6): ("3 sqrt(3) / 2", 1.5 * SQ3),
    ("hex", 3): ("1/2", 0.5),
    ("free", 3): ("sqrt(3) / 4", SQ3 / 4.0),
    ("free", 5): (
        "3 sqrt(25 + 10 sqrt(5)) / (4 (5 - sqrt(5)))",
        3.0 * math.sqrt(25.0 + 10.0 * math.sqrt(5.0)) / (4.0 * (5.0 - math.sqrt(5.0))),
    ),
    ("free", 8): ("(5 + 4 sqrt(2)) / 2", (5.0 + 4.0 * math.sqrt(2.0)) / 2.0),
}


def exact_form(fam, N, P, score):
    """'sqrt(P * c)' with P substituted when it matches score to 1e-12 relative, else None."""
    e = EXACT_C.get((fam, N))
    if e is None:
        return None
    val = math.sqrt(P * e[1])
    if abs(val - score) > 1e-12 * val:
        return None
    return {"expr": "sqrt(%d * %s)" % (P, e[0]) if e[0] != "1" else "sqrt(%d)" % P, "value": val}
