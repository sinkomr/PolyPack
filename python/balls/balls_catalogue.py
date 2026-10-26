"""The problems of the balls space (packages/balls/src/catalogue.ts) and their elementary lower bounds
(packages/balls/src/problems.ts ballsBound), for the certifier and the record builder. Standard library only."""
import math
import re

PROBLEMS = {
    'ballinball': {'piece': 'ball', 'container': 'ball', 'title': 'Balls in a ball'},
    'ballincub': {'piece': 'ball', 'container': 'cube', 'title': 'Balls in a cube'},
    'tetinball': {'piece': 'tetrahedron', 'container': 'ball', 'title': 'Tetrahedra in a ball'},
    'cubinball': {'piece': 'cube', 'container': 'ball', 'title': 'Cubes in a ball'},
    'octinball': {'piece': 'octahedron', 'container': 'ball', 'title': 'Octahedra in a ball'},
    'dodinball': {'piece': 'dodecahedron', 'container': 'ball', 'title': 'Dodecahedra in a ball'},
    'icoinball': {'piece': 'icosahedron', 'container': 'ball', 'title': 'Icosahedra in a ball'},
}
CODES = list(PROBLEMS)
MIN_P, MAX_P = 2, 100

S5 = math.sqrt(5)
# unit-edge Platonic solids: volume, circumradius, inradius (closed forms) [EST]
SOLIDS = {
    'tetrahedron': (1 / (6 * math.sqrt(2)), math.sqrt(6) / 4, math.sqrt(6) / 12),
    'cube': (1.0, math.sqrt(3) / 2, 0.5),
    'octahedron': (math.sqrt(2) / 3, math.sqrt(2) / 2, math.sqrt(6) / 6),
    'dodecahedron': ((15 + 7 * S5) / 4, math.sqrt(3) * (1 + S5) / 4, math.sqrt((25 + 11 * S5) / 10) / 2),
    'icosahedron': (5 * (3 + S5) / 12, math.sqrt(10 + 2 * S5) / 4, math.sqrt(3) * (3 + S5) / 12),
}


def parse_id(text):
    """(code, P) of an id balls/<code>/<P> in its one written form with 2 <= P <= 100, or None."""
    if not isinstance(text, str):
        return None
    m = re.fullmatch(r'balls/([a-z]+)/([1-9][0-9]{0,3})', text)
    if not m or m.group(1) not in PROBLEMS:
        return None
    P = int(m.group(2))
    return (m.group(1), P) if MIN_P <= P <= MAX_P else None


def bound(code, P):
    """The largest of the volume, one-piece and two-piece bounds (problems.ts), as a float."""
    prob = PROBLEMS[code]
    piece, ball = prob['piece'], prob['container'] == 'ball'
    v = 4 * math.pi / 3 if piece == 'ball' else SOLIDS[piece][0]
    vals = [(3 * P * v / (4 * math.pi)) ** (1 / 3) if ball else (P * v) ** (1 / 3)]
    if piece == 'ball':
        if ball:
            vals += [1.0] + ([2.0] if P >= 2 else [])
        else:
            vals += [2.0] + ([2 + 2 / math.sqrt(3)] if P >= 2 else [])
    else:
        _, R, r = SOLIDS[piece]
        vals += [R] + ([2 * r] if P >= 2 else [])
    return max(vals)
