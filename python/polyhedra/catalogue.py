"""The solids and problems of the polyhedra space (standard library only).

Names, codes and the order of upstream's solids and problems follow alejandrozu/platonic-packing scripts/engine.py
(AB, ARCHIMEDEAN, CATALAN, PRISMS, PROBLEMS; MIT, commit cbf76f2f). PolyPack adds prisms and antiprisms with 7, 9,
10 and 11 sides and the elongated prisms of the 7-, 9-, 10- and 11-gon (2026-10-25), named in upstream's scheme and listed after
upstream's solids and problems, and the bipyramids and trapezohedra, the canonical duals of the unit-edge prisms and
antiprisms (docs/spaces/POLYHEDRA.md), each in itself and in a cube; polyhedrainpolyhedra.wiki does not list them (WIKI_PROBLEMS holds the codes it does).
packages/polyhedra/src/problems.ts builds the same list; the TypeScript tests compare the two through
data/polyhedra/records.json.
"""
import re

PLATONIC = ['tetrahedron', 'cube', 'octahedron', 'dodecahedron', 'icosahedron']
ARCHIMEDEAN = ['truncated_tetrahedron', 'cuboctahedron', 'truncated_cube', 'truncated_octahedron',
               'rhombicuboctahedron', 'truncated_cuboctahedron', 'snub_cube', 'icosidodecahedron',
               'truncated_dodecahedron', 'truncated_icosahedron', 'rhombicosidodecahedron',
               'truncated_icosidodecahedron', 'snub_dodecahedron']
CATALAN = ['triakis_tetrahedron', 'rhombic_dodecahedron', 'triakis_octahedron', 'tetrakis_hexahedron',
           'deltoidal_icositetrahedron', 'disdyakis_dodecahedron', 'pentagonal_icositetrahedron',
           'rhombic_triacontahedron', 'triakis_icosahedron', 'pentakis_dodecahedron', 'deltoidal_hexecontahedron',
           'disdyakis_triacontahedron', 'pentagonal_hexecontahedron']
PRISM_K = [3, 5, 6, 8, 12]
ANTIPRISM_K = [4, 5, 6, 8, 12]
ELONG = [('l15', '1.5'), ('l2', '2'), ('l3', '3')]
EXTRA_K = [7, 9, 10, 11]                 # PolyPack's prisms, antiprisms and elongated prisms (not on the wiki)
# PolyPack's duals of the n-prisms (n = 4 is the octahedron) and of the n-antiprisms (n = 3 is the cube)
BIPYRAMID_K = [3, 5, 6, 7, 8, 9, 10, 11, 12]
TRAPEZOHEDRON_K = [4, 5, 6, 7, 8, 9, 10, 11, 12]
POLY = {3: 'triangular', 4: 'square', 5: 'pentagonal', 6: 'hexagonal', 7: 'heptagonal', 8: 'octagonal',
        9: 'enneagonal', 10: 'decagonal', 11: 'hendecagonal', 12: 'dodecagonal'}
AB = {'tetrahedron': 'tet', 'cube': 'cub', 'octahedron': 'oct', 'dodecahedron': 'dod', 'icosahedron': 'ico',
      'truncated_tetrahedron': 'tte', 'cuboctahedron': 'cbo', 'truncated_cube': 'tcu', 'truncated_octahedron': 'toc',
      'rhombicuboctahedron': 'rco', 'truncated_cuboctahedron': 'tco', 'snub_cube': 'snc', 'icosidodecahedron': 'ido',
      'truncated_dodecahedron': 'tdo', 'truncated_icosahedron': 'tic', 'rhombicosidodecahedron': 'rid',
      'truncated_icosidodecahedron': 'tid', 'snub_dodecahedron': 'snd',
      'triakis_tetrahedron': 'ktt', 'rhombic_dodecahedron': 'rdo', 'triakis_octahedron': 'kto',
      'tetrakis_hexahedron': 'kth', 'deltoidal_icositetrahedron': 'dit', 'disdyakis_dodecahedron': 'ddo',
      'pentagonal_icositetrahedron': 'pit', 'rhombic_triacontahedron': 'rtc', 'triakis_icosahedron': 'kti',
      'pentakis_dodecahedron': 'pkd', 'deltoidal_hexecontahedron': 'dhc', 'disdyakis_triacontahedron': 'dtc',
      'pentagonal_hexecontahedron': 'phc'}
for _k in PRISM_K + EXTRA_K:
    AB[f'prism{_k}'] = f'pr{_k}'
for _k in ANTIPRISM_K + EXTRA_K:
    AB[f'antiprism{_k}'] = f'ap{_k}'
for _k in PRISM_K + EXTRA_K:
    for _t, _h in ELONG:
        AB[f'prism{_k}_{_t}'] = f'pr{_k}{_t}'
for _k in BIPYRAMID_K:
    AB[f'bipyramid{_k}'] = f'bp{_k}'
for _k in TRAPEZOHEDRON_K:
    AB[f'trapezohedron{_k}'] = f'tz{_k}'


def _prism_solids(prisms, antiprisms):
    out = [(f'prism{k}', f'pr{k}', 'prism', f'{POLY[k]} prism') for k in prisms]
    out += [(f'antiprism{k}', f'ap{k}', 'antiprism', f'{POLY[k]} antiprism') for k in antiprisms]
    out += [(f'prism{k}_{t}', f'pr{k}{t}', 'elongated_prism', f'{POLY[k]} prism of height {h}')
            for k in prisms for t, h in ELONG]
    return out


def _prism_problems(prisms, antiprisms):
    out = []
    for s in [f'prism{k}' for k in prisms] + [f'antiprism{k}' for k in antiprisms]:
        out += [(s, s, 'prisms'), (s, 'cube', 'prisms')]
    out += [(f'prism{k}_{t}', 'cube', 'prisms') for k in prisms for t, _ in ELONG]
    return out


def solids():
    """(name, code, family, title) of every solid: upstream's 56 in upstream's order of families, then PolyPack's 38."""
    out = [(s, AB[s], 'platonic', s) for s in PLATONIC]
    out += [(s, AB[s], 'archimedean', s.replace('_', ' ')) for s in ARCHIMEDEAN]
    out += [(s, AB[s], 'catalan', s.replace('_', ' ')) for s in CATALAN]
    out += _prism_solids(PRISM_K, ANTIPRISM_K)
    out += _prism_solids(EXTRA_K, EXTRA_K)
    out += [(f'bipyramid{k}', f'bp{k}', 'bipyramid', f'{POLY[k]} bipyramid') for k in BIPYRAMID_K]
    out += [(f'trapezohedron{k}', f'tz{k}', 'trapezohedron', f'{POLY[k]} trapezohedron') for k in TRAPEZOHEDRON_K]
    return out


def problems(wiki_only=False):
    """(code, piece, container, family) of the 150 problems: upstream's 86 in upstream's order, then PolyPack's 64
    (only upstream's with wiki_only)."""
    pairs = [('tetrahedron', 'tetrahedron'), ('octahedron', 'octahedron'), ('icosahedron', 'icosahedron'),
             ('dodecahedron', 'dodecahedron'), ('cube', 'cube'), ('cube', 'octahedron'), ('octahedron', 'cube'),
             ('dodecahedron', 'icosahedron'), ('icosahedron', 'dodecahedron')]
    pairs += [(p, c) for p in PLATONIC for c in PLATONIC if (p, c) not in pairs]
    out = [(p, c, 'platonic') for p, c in pairs]
    out += [(s, s, 'archimedean') for s in ARCHIMEDEAN]
    out += [(s, s, 'catalan') for s in CATALAN]
    out += _prism_problems(PRISM_K, ANTIPRISM_K)
    if not wiki_only:
        out += _prism_problems(EXTRA_K, EXTRA_K)
        for s in [f'bipyramid{k}' for k in BIPYRAMID_K]:
            out += [(s, s, 'bipyramids'), (s, 'cube', 'bipyramids')]
        for s in [f'trapezohedron{k}' for k in TRAPEZOHEDRON_K]:
            out += [(s, s, 'trapezohedra'), (s, 'cube', 'trapezohedra')]
    return [(f'{AB[p]}in{AB[c]}', p, c, fam) for p, c, fam in out]


PROBLEMS = {code: (piece, container, family) for code, piece, container, family in problems()}
WIKI_PROBLEMS = frozenset(code for code, *_ in problems(wiki_only=True))   # the 86 that polyhedrainpolyhedra.wiki lists
ID_RE = re.compile(r'^polyhedra/([a-z0-9]+)/([1-9][0-9]{0,3})$')


def parse_id(text):
    """(code, P) of a problem id 'polyhedra/<code>/<P>' in its one written form, or None."""
    if not isinstance(text, str):
        return None
    m = ID_RE.match(text)
    if not m or m.group(1) not in PROBLEMS:
        return None
    return m.group(1), int(m.group(2))
