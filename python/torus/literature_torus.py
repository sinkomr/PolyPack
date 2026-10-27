"""Lower bounds and literature values for the torus tables (converted to PolyPack units).

Units: disks of DIAMETER 1 (radius 1/2; before 2026-10-27 they had radius 1 and every disk score was twice as
large), polygons of side 1. Scores: sq/hex side L, free sqrt(cell area).
A packing on a torus lifts to a periodic packing of the plane with the same density, so any
density bound for packings of congruent copies in the plane applies.

A record is marked proven only when one of its literature entries carries a `proof`: a
published, refereed proof of that exact torus case (same torus shape, piece, count and
objective), read and checked, with its DOI and the theorem or section that states it, and the
record's certified score attains the value (certify_torus.proof_entry). Everything else stays
best_known, including cases settled by a theorem about the plane or about all lattices, by an
unrefereed preprint, or by a paper that was not read.
"""

import math

SQ3 = math.sqrt(3.0)
ACCESSED = "2026-10-24"


def piece_area(N):
    return math.pi / 4.0 if N == 0 else N / (4.0 * math.tan(math.pi / N))


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
            out = {"value": 1.0, "label": "[CALC] one disk: the shortest lattice vector L must be >= 1 (the diameter)", "kind": "exact"}
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


# Literature entries keyed by (family, N, P), values converted to diameter-1 disks and side-1
# polygons (L = 1/d for disks at minimal distance d on the unit torus, L = 1/(2r) for disks of
# radius r on it, L = sqrt(P / rho) for squares at density rho).
#
# Fields of an entry: value (PolyPack units, or None), status (the source's own claim: proven,
# proven_unrefereed, best_known or conjecture), short, source (full citation), url (an open copy
# where there is one), accessed, note, and when known doi. `proof` is set only when the entry's
# proof states this exact torus case (the same torus shape, piece, count and objective) and was
# checked against the source: it names the theorem or section. A record is `proven` only through
# such an entry (certify_torus.proof_entry); a proof of a more general problem (the plane, any
# lattice), an unrefereed preprint or a paper that was not read gives no `proof`.
AUDITED = "2026-10-25"
MN = ("O. R. Musin, A. V. Nikitenko, Optimal packings of congruent circles on a square flat torus, "
      "Discrete Comput. Geom. 55(1) (2016) 1-20")
MN_DOI = "10.1007/s00454-015-9742-6"
MN_URL = "https://arxiv.org/abs/1212.0649"
DGKX = ("W. Dickinson, D. Guillot, A. Keaton, S. Xhumari, Optimal packings of up to five equal circles on a "
        "square flat torus, Beitr. Algebra Geom. 52(2) (2011) 315-333 (paper not read; values as quoted in "
        "Musin-Nikitenko 2016, Fig. 2)")
DGKX_DOI = "10.1007/s13366-011-0029-7"
BDEKS = ("M. Brandt, W. Dickinson, A. Ellsworth, J. Kenkel, H. Smith, Optimal packings of two to four equal "
         "circles on any flat torus, Discrete Math. 342(12) (2019) 111597")
BDEKS_DOI = "10.1016/j.disc.2019.111597"
BDEKS_URL = "https://arxiv.org/abs/1708.05395"
CFKS = ("R. Connelly, M. Funkhouser, V. Kuperberg, E. Solomonides, Packings of equal disks in a square torus, "
        "Discrete Comput. Geom. 58(3) (2017) 614-642 (search values, r to 3 decimals; conjectures for 10-16)")
CFKS_DOI = "10.1007/s00454-016-9843-x"
CFKS_URL = "https://arxiv.org/abs/1512.08762"
BSM = ("D. W. Blair, C. Santangelo, J. Machta, Packing squares in a torus, J. Stat. Mech. (2012) P01018, "
       "sec. II.A.1 and Table I (density one optimal by construction; the rest conjectured)")
BSM_DOI = "10.1088/1742-5468/2012/01/P01018"
BSM_URL = "https://arxiv.org/abs/1110.5348"
CD = "R. Connelly, W. Dickinson, Periodic planar disc packings, Phil. Trans. R. Soc. A 372 (2014) 20120039"
CD_DOI = "10.1098/rsta.2012.0039"
CD_URL = "https://arxiv.org/abs/1201.5965"
DGKX6 = ("W. Dickinson, D. Guillot, A. Keaton, S. Xhumari, Optimal packings of up to six equal circles on a "
         "triangular flat torus, J. Geom. 102(1-2) (2011) 27-51 (paper not read; described in Connelly-Dickinson "
         "2014, sec. 1(d))")
DGKX6_DOI = "10.1007/s00022-011-0099-6"
TORDA = ("M. Torda, J. Y. Goulermas, V. Kurlin, G. M. Day, Densest plane group packings of regular polygons, "
         "Phys. Rev. E 106 (2022) 054603, Table I, plane group p1 (numerical, 5 decimals)")
TORDA_DOI = "10.1103/PhysRevE.106.054603"
TORDA_URL = "https://arxiv.org/abs/2207.08959"
KK = ("G. Kuperberg, W. Kuperberg, Double-lattice packings of convex bodies in the plane, Discrete Comput. Geom. 5 "
      "(1990) 389-397 (values as quoted by Kallus and Kusner, arXiv:1509.02241; best known, not proven optimal for heptagons)")
KK_DOI = "10.1007/BF02187800"
KK_URL = "https://arxiv.org/abs/1509.02241"
HK = ("T. Hales, W. Kusner, Packings of regular pentagons in the plane, arXiv:1602.07220 v2 (computer-assisted "
      "proof for the plane; no refereed publication found)")
HK_URL = "https://arxiv.org/abs/1602.07220"
FT = ("L. Fejes Toth, Some packing and covering theorems, Acta Sci. Math. (Szeged) 12A (1950) 62-67, as stated in "
      "G. Fejes Toth, Packing and covering, Handbook of Discrete and Computational Geometry, 3rd ed., ch. 2, p. 29: "
      "delta(K) = delta_T(K) = delta_L(K) for centrally symmetric K (a theorem for the plane)")
FT_URL = "http://www.csun.edu/~ctoth/Handbook/chap2.pdf"
FARY = ("I. Fary, Sur la densite des reseaux de domaines convexes, Bull. Soc. Math. France 78 (1950) 152-161, "
        "Theoreme 1: the densest lattice packing of a convex domain has density >= 2/3, with equality only for "
        "triangles")
FARY_DOI = "10.24033/bsmf.1413"
FARY_URL = "http://www.numdam.org/item/BSMF_1950__78__152_0/"
FUKSHANSKY = ("L. Fukshansky, Revisiting the hexagonal lattice: on optimal lattice circle packing, Elem. Math. "
              "66(1) (2011) 1-9")
FUKSHANSKY_DOI = "10.4171/EM/163"
FUKSHANSKY_URL = "https://www1.cmc.edu/pages/faculty/lenny/papers/hexagon.pdf"
SRIAMORN = ("K. Sriamorn, On the multiple packing densities of triangles, Discrete Comput. Geom. 55(1) (2016) "
            "228-242")
SRIAMORN_DOI = "10.1007/s00454-015-9748-0"
SRIAMORN_URL = "https://arxiv.org/abs/1501.00467"
LAGRANGE = ("J. L. Lagrange, Recherches d'arithmetique, Nouv. Mem. Acad. Roy. Sci. Belles-Lettres Berlin (1773) "
            "265-312 (not read; cited for delta_L(disk) = pi/sqrt12 in the Handbook of Discrete and Computational "
            "Geometry, 3rd ed., ch. 2, Table 2.1.3)")
SV = ("V. V. Voloshinov, S. A. Smirnov, Optimal packings of congruent circles on a square flat torus as "
      "mixed-integer nonlinear optimization problem, Communications in Computer and Information Science "
      "(Springer, 2019) 87-97, doi:10.1007/978-3-030-36592-9_8")


def _e(value, status, short, source, url, note=None, doi=None, proof=None, accessed=ACCESSED):
    out = {"value": value, "status": status, "short": short, "source": source, "url": url, "accessed": accessed}
    if doi:
        out["doi"] = doi
    if proof:
        out["proof"] = proof
    if note:
        out["note"] = note
    return out


def _dens_score(fam, N, P, dens):
    return score_from_area(fam, P * piece_area(N) / dens)


def _brandt(value, proof, note=None):
    return _e(value, "proven", "Brandt et al. 2019, Thm 1.1", BDEKS, BDEKS_URL, note, BDEKS_DOI, proof, AUDITED)


def _dgkx(value, note):
    return _e(value, "proven", "Dickinson et al. 2011 (not read)", DGKX, MN_URL, note, DGKX_DOI)


def _mn(value, k, note):
    proof = "Theorem %d: optimal minimal distance on the unit square torus, %s; L = 1/d" % (k - 5, note)
    return _e(value, "proven", "Musin and Nikitenko 2016, Thm %d" % (k - 5), MN, MN_URL, note, MN_DOI, proof, AUDITED)


S2, S3, S5, S6 = math.sqrt(2.0), SQ3, math.sqrt(5.0), math.sqrt(6.0)
_d6 = S3 / 2 - S2 * math.sqrt(3 * S3 + 2) / 6 + 1 / 6.0
_SQ_R = "on the square torus (v2 = (0, 1)); L = 1/(2r)"
_HEX_R = "on the triangular torus (v2 = (1/2, sqrt3/2)); L = 1/(2r)"
LIT = {
    ("sq", 0, 1): [
        _dgkx(1.0, "one disk: the shortest lattice vector must be at least 1 (trivial); Connelly et al. 2017 report the square grid optimal for N = 1, 2 and 5"),
    ],
    ("sq", 0, 2): [
        _brandt(S2, "Theorem 1.1, region R1_2: r2 = sqrt2/4 " + _SQ_R, "L = sqrt2"),
        _dgkx(S2, "d = sqrt2/2, L = sqrt2"),
    ],
    ("sq", 0, 3): [
        _brandt((S6 + S2) / 2, "Theorem 1.1, region R1_3: r3 = (sqrt6 - sqrt2)/4 " + _SQ_R, "L = (sqrt6 + sqrt2)/2"),
        _dgkx((S6 + S2) / 2, "d = (sqrt6 - sqrt2)/2, L = (sqrt6 + sqrt2)/2"),
    ],
    ("sq", 0, 4): [
        _brandt((S6 + S2) / 2, "Theorem 1.1, region R1_4: r4 = (sqrt6 - sqrt2)/4 " + _SQ_R, "L = (sqrt6 + sqrt2)/2"),
        _dgkx((S6 + S2) / 2, "d = (sqrt6 - sqrt2)/2, L = (sqrt6 + sqrt2)/2"),
    ],
    ("sq", 0, 5): [_dgkx(S5, "d = 1/sqrt5, L = sqrt5")],
    ("sq", 0, 6): [_mn(1 / _d6, 6, "d6 = sqrt3/2 - sqrt2 sqrt(3 sqrt3 + 2)/6 + 1/6")],
    ("sq", 0, 7): [_mn(1 + S3, 7, "d7 = 1/(1 + sqrt3), three optimal arrangements")],
    ("sq", 0, 8): [_mn(1 + S3, 8, "d8 = 1/(1 + sqrt3)")],
    ("sq", 0, 9): [_e(math.sqrt(5 + 2 * S3), "conjecture", "Musin and Nikitenko 2016, Conjecture 2.1", MN, MN_URL,
                      "d = 1/sqrt(5 + 2 sqrt3); Voloshinov and Smirnov reach the same arrangement with a floating-point "
                      "branch and bound (" + SV + "), not a rigorous proof", MN_DOI)],
    ("sq", 0, 10): [_e(math.sqrt(10.0), "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "square grid, conjectured optimal; table bracket L in [3.16205, 3.1641]", CFKS_DOI)],
    ("sq", 0, 11): [_e(None, "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "table bracket L in [3.27295, 3.275] (r = 0.153, delta = 0.806)", CFKS_DOI)],
    ("sq", 0, 12): [_e(12 / math.sqrt(13.0), "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "Type I (a, b) = (3, 2): L = 12/sqrt13; table bracket [3.32695, 3.3289]", CFKS_DOI)],
    ("sq", 0, 13): [_e(None, "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "table bracket L in [3.59845, 3.60075] (r = 0.139, delta = 0.788)", CFKS_DOI)],
    ("sq", 0, 14): [_e(None, "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "table bracket L in [3.6191, 3.62125] (r = 0.138, delta = 0.839)", CFKS_DOI)],
    ("sq", 0, 15): [_e(15 / math.sqrt(17.0), "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "Type II (a, b) = (4, 1): L = 15/sqrt17; table bracket [3.63725, 3.6393]", CFKS_DOI)],
    ("sq", 0, 16): [_e(S6 + S2, "best_known", "Connelly et al. 2017", CFKS, CFKS_URL, "table bracket [3.86205, 3.86435]; 2 x 2 copy of the P = 4 optimum gives sqrt6 + sqrt2 [SPEC identification]", CFKS_DOI)],
    ("hex", 0, 2): [
        _brandt(S3, "Theorem 1.1, region R1_2: r2 = 1/(2 sqrt3) " + _HEX_R, "L = sqrt3 (3-point lattice minus one)"),
        _e(S3, "proven", "Dickinson et al. 2011, J. Geom. (not read)", DGKX6, CD_URL, "L = sqrt3", DGKX6_DOI),
    ],
    ("hex", 0, 5): [_e(None, "proven", "Dickinson et al. 2011, J. Geom. (not read)", DGKX6, CD_URL, "optimal packing proven there; no published value seen", DGKX6_DOI)],
    ("hex", 0, 6): [_e(math.sqrt(7.0), "proven", "Dickinson et al. 2011, J. Geom. (not read)", DGKX6, CD_URL, "7-point lattice minus one disk, L = sqrt7 (as described by Connelly-Dickinson 2014, sec. 1(d))", DGKX6_DOI)],
}
# square-torus squares (Blair, Santangelo, Machta 2012): L = sqrt(P / rho). Density one, when P is a
# sum of two squares, is proven optimal there (sec. II.A.1); the other entries of Table I are conjectures.
for _P, _rho, _t in ((3, 3 / 4, "2^2 - 1"), (6, 5 / 6, "gapped bricklayer"), (7, 7 / 8, "2^2 + 2^2 - 1"),
                     (11, 10 / 11, "gapped bricklayer"), (12, 24 / 25, "lattice of 1/2 x 1/2 holes"),
                     (14, 13 / 14, "gapped bricklayer"), (15, 15 / 16, "4^2 - 1")):
    LIT[("sq", 4, _P)] = [_e(math.sqrt(_P / _rho), "best_known", "Blair et al. 2012, Table I", BSM, BSM_URL,
                             "density %s (%s); conjectured optimal" % (_rho, _t), BSM_DOI, None, AUDITED)]
_SUMSQ = sorted({a * a + b * b for a in range(0, 8) for b in range(0, 8)} - {0})
for _P in _SUMSQ:
    if _P <= 49:
        LIT[("sq", 4, _P)] = [_e(math.sqrt(_P), "proven", "Blair et al. 2012, sec. II.A.1", BSM, BSM_URL,
                                 "density one (P is a sum of two squares)", BSM_DOI,
                                 "Section II.A.1: a density-one packing exists when P is a sum of two squares and is "
                                 "optimal, since no packing has density above 1; L = sqrt(P)", AUDITED)]
# hexagonal torus disks: density pi/sqrt12 iff P = a^2 + ab + b^2 (Connelly-Dickinson 2014, Theorem 1.1;
# Theorem 1 in arXiv:1201.5965); density gap conjecture (their Conjecture 1.3): if P + 1 has that form
# and P does not, the optimum is the (P + 1)-lattice minus one disk, L = sqrt(P + 1)
_EIS = {a * a + a * b + b * b for a in range(0, 8) for b in range(0, 8)}
_CD_PROOF = ("Theorem 1.1: on the triangular torus the density pi/sqrt12 is reached exactly when n = a^2 + ab + b^2; "
             "n (pi/4) / ((sqrt3/2) L^2) = pi/sqrt12 gives L = sqrt(n)")
for _P in range(1, 50):
    if _P in _EIS:
        LIT.setdefault(("hex", 0, _P), []).insert(0, _e(
            math.sqrt(_P), "proven", "Connelly and Dickinson 2014, Thm 1.1", CD, CD_URL,
            "triangular lattice, density pi/sqrt12", CD_DOI, _CD_PROOF, AUDITED))
    elif (_P + 1) in _EIS and ("hex", 0, _P) not in LIT:
        LIT[("hex", 0, _P)] = [
            _e(math.sqrt(_P + 1), "conjecture", "Connelly and Dickinson 2014, Conjecture 1.3", CD, CD_URL,
               "density gap conjecture: (P + 1)-lattice minus one disk", CD_DOI, None, AUDITED)
        ]
LIT[("hex", 0, 3)].append(_brandt(S3, "Theorem 1.1, region R2_3: r3 = sqrt3/6 " + _HEX_R, "L = sqrt3"))
LIT[("hex", 0, 4)].append(_brandt(2.0, "Theorem 1.1, region R2_4: r4 = 1/4 " + _HEX_R, "L = 2"))
# free lattice: P = 1 is the densest lattice packing; P = 2 double lattices
# Torda et al. give 5 decimals; the score uses our 13-digit critical-determinant value
# (python/torus/lattice_density.py, [CALC]), which agrees with the table to its precision.
for _N, _d in ((3, 2 / 3), (5, 0.8172560023684), (7, 0.8601910243450), (8, (4 + 4 * S2) / (5 + 4 * S2))):
    LIT[("free", _N, 1)] = [
        _e(_dens_score("free", _N, 1, _d), "best_known", "Torda et al. 2022 (p1)", TORDA, TORDA_URL,
           "densest lattice packing, numerical table density %.5f; score from the [CALC] value %.13f" % (math.floor(_d * 1e5) / 1e5, _d),
           TORDA_DOI)
    ]
# One piece on a free torus is a lattice packing of it, so the densest lattice packing of the piece
# gives the record directly: L = sqrt(area / delta_L).
LIT[("free", 3, 1)][0:0] = [
    _e(_dens_score("free", 3, 1, 2 / 3), "proven", "Sriamorn 2016, Thm 1.1", SRIAMORN, SRIAMORN_URL,
       "densest lattice packing of a triangle, density 2/3", SRIAMORN_DOI,
       "Theorem 1.1 with k = 1: delta_T(T) = delta_L(T) = 2/3 for every triangle T (the upper bound is proved there "
       "with stair polygons, secs. 4-5; Fary 1950 gives a lattice of density 2/3). A single piece on a torus is a "
       "lattice packing of it, so delta_L gives L = sqrt((sqrt3/4)/(2/3)) = sqrt(3 sqrt3/8) directly", AUDITED),
    _e(_dens_score("free", 3, 1, 2 / 3), "proven", "Fary 1950, Theoreme 1", FARY, FARY_URL,
       "every convex domain has a lattice packing of density at least 2/3, denser unless it is a triangle; for a "
       "triangle this gives a lattice of density 2/3. The paper does not prove that no lattice packing of a triangle "
       "is denser (Sriamorn 2016 does)", FARY_DOI, None, AUDITED),
]
LIT[("free", 8, 1)].append(_e(_dens_score("free", 8, 1, (4 + 4 * S2) / (5 + 4 * S2)), "proven", "L. Fejes Toth 1950", FT, FT_URL,
                              "densest packing of congruent regular octagons is the lattice packing, density (4 + 4 sqrt2)/(5 + 4 sqrt2) "
                              "(the octagon's value computed here)"))
LIT[("free", 5, 2)] = [_e(_dens_score("free", 5, 2, (5 - S5) / 3), "proven_unrefereed", "Kuperberg and Kuperberg 1990; Hales and Kusner 2016",
                          KK + "; " + HK, HK_URL,
                          "pentagonal ice-ray double lattice, density (5 - sqrt5)/3; optimality: computer-assisted preprint proof for the plane",
                          KK_DOI, None, AUDITED)]
_hept = (2 / 97) * (-111 + 492 * math.cos(math.pi / 7) - 356 * math.cos(math.pi / 7) ** 2)
LIT[("free", 7, 2)] = [_e(_dens_score("free", 7, 2, _hept), "best_known", "Kuperberg and Kuperberg 1990", KK, KK_URL,
                          "densest double lattice of the regular heptagon, density 0.8926906861 = (2/97)(-111 + 492 cos(pi/7) - 356 cos^2(pi/7)) (J. Baez, AMS Visual Insight 2014)",
                          KK_DOI)]
LIT[("free", 0, 1)] = [
    _e(_dens_score("free", 0, 1, math.pi / math.sqrt(12.0)), "proven", "Fukshansky 2011, Thm 1.1", FUKSHANSKY, FUKSHANSKY_URL,
       "densest lattice packing of disks: the hexagonal lattice, density pi/sqrt12 (first proved by Lagrange 1773)",
       FUKSHANSKY_DOI,
       "Theorem 1.1: every lattice packing of congruent circles in the plane has density at most pi/(2 sqrt3) = "
       "pi/sqrt12, with equality only for lattices similar to the hexagonal one. A single disk on a torus is a "
       "lattice packing, so L = sqrt((pi/4)/(pi/sqrt12)) = sqrt(sqrt3/2) directly", AUDITED),
    _e(_dens_score("free", 0, 1, math.pi / math.sqrt(12.0)), "proven", "Lagrange 1773 (not read)", LAGRANGE, FT_URL,
       "the origin of the densest lattice packing of disks; the record cites Fukshansky 2011 for a proof"),
    _e(_dens_score("free", 0, 1, math.pi / math.sqrt(12.0)), "proven", "Thue 1910", "A. Thue 1910 (Handbook ch. 2, Table 2.1.1)", FT_URL,
       "hexagonal lattice, density pi/sqrt12 (a theorem for the plane)"),
]


def literature(fam, N, P):
    return list(LIT.get((fam, N, P), []))


# Closed forms score = sqrt(P * c) for the (family, N) whose bound is attained by a
# lattice, double-lattice or tiling construction (used when score_float equals the bound).
EXACT_C = {
    ("sq", 4): ("1", 1.0),
    ("free", 4): ("1", 1.0),
    ("hex", 0): ("1", 1.0),
    ("free", 0): ("sqrt(3) / 2", SQ3 / 2.0),
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


# Closed forms score = sqrt(c) for single pieces whose bound is a published lattice optimum.
EXACT_P1 = {
    ("free", 3): ("3 sqrt(3) / 8", 3.0 * SQ3 / 8.0),  # densest lattice packing of a triangle, 2/3 (Fary 1950; Sriamorn 2016)
}


def exact_form(fam, N, P, score):
    """'sqrt(P * c)' with P substituted when it matches score to 1e-12 relative, else None."""
    if P == 1 and (fam, N) in EXACT_P1:
        expr, c = EXACT_P1[(fam, N)]
        val = math.sqrt(c)
        return {"expr": "sqrt(%s)" % expr, "value": val} if abs(val - score) <= 1e-12 * val else None
    e = EXACT_C.get((fam, N))
    if e is None:
        return None
    val = math.sqrt(P * e[1])
    if abs(val - score) > 1e-12 * val:
        return None
    return {"expr": "sqrt(%d * %s)" % (P, e[0]) if e[0] != "1" else "sqrt(%d)" % P, "value": val}
