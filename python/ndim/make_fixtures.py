#!/usr/bin/env python3
"""Builds the test packings of the nD package (packages/ndim/test/fixtures/packings.json), deterministically.

usage: python3 python/ndim/make_fixtures.py [--check]      (then npx prettier --write packages/ndim/test/fixtures; --check rebuilds and compares with the committed file, as data)

Each fixture is {name, problem, config, expect}; `expect` says what the exact certifier (clearance 0, clearance 1e-7) and
the TypeScript validator (tolerance 0) must answer. They are written by this script from grid and lattice seeds (cubes
and balls in a cube), pairs of pieces moved together along the line of their closest points to a gap of 1.5e-7 (random
rotations, Cayley parameters from a fixed seed), single pieces in a ball or a cube, and adversarial cases: pieces
overlapping, touching or separated by 1e-9, and a piece out of its container by 1e-9. The Python tests certify every
fixture exactly, the TypeScript tests validate them in floating point: the two languages must agree.

Needs the catalogue's float data only (standard library)."""
import itertools
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import catalogue as CAT  # noqa: E402
import floatgeom as G  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'packages', 'ndim', 'test', 'fixtures', 'packings.json')
GAP = 1.5e-7            # clearance of the valid fixtures: above the 1e-7 convention
rng = random.Random(20261101)


def zeros(d):
    return [0.0] * (d * (d - 1) // 2)


def prob(d, piece, container):
    return {'d': d, 'piece': piece, 'container': container}


SLOW = ('cubes2^7', 'cubes2^6_gap5e-8', 'single_8_ortho_in_8_421')      # exact certification takes seconds: the slow set


def fx(name, problem, s, pieces, exact, clr, valid0, note=''):
    return {'name': name, 'problem': problem, 'config': {'s': s, 'pieces': pieces}, 'slow': name.startswith(SLOW),
            'expect': {'exact': exact, 'exact_clearance': clr, 'valid0': valid0}, 'note': note}


def grid_centres(d, k, g, limit=None):
    h = (k - 1) / 2
    out = [[(i - h) * (1 + g) for i in idx] for idx in itertools.product(range(k), repeat=d)]
    return out if limit is None else out[:limit]


def rand_rot(d, scale=0.8):
    return [round(rng.uniform(-scale, scale), 6) for _ in range(d * (d - 1) // 2)]


def world(P, pose):
    d = P.d
    R = G.matrix_of_pose(pose, d)
    return [[pose[i] + sum(R[i][j] * v[j] for j in range(d)) for i in range(d)] for v in P.vertices_float()]


def touching_pair(code, gap=GAP):
    """Two randomly rotated pieces, the second moved along a random direction until the float distance is `gap`."""
    P = CAT.get(code)
    d = P.d
    c1 = [0.0] * d
    r1, r2 = rand_rot(d), rand_rot(d)
    A = world(P, c1 + r1)
    u = [rng.gauss(0, 1) for _ in range(d)]
    nu = math.sqrt(sum(x * x for x in u))
    u = [x / nu for x in u]
    circ = max(math.sqrt(sum(c * c for c in v)) for v in P.vertices_float())
    lo, hi = 0.0, 2 * circ + 1
    for _ in range(80):
        mid = (lo + hi) / 2
        B = world(P, [x * mid for x in u] + r2)
        if G.closest(A, B)[0] > gap:
            hi = mid
        else:
            lo = mid
    return c1 + r1, [x * hi for x in u] + r2, circ


def ball_container(poses, circ, d):
    far = max(math.sqrt(sum(x * x for x in p[:d])) for p in poses) + circ
    return 2 * (far + GAP)


def tight_poly_scale(piece, container, poses):
    """Smallest s with wall gap GAP for every facet of the container (float)."""
    P, C = CAT.get(piece), CAT.get(container)
    N, b = C.facets_float()
    s = 0.0
    for pose in poses:
        X = world(P, pose)
        for n, off in zip(N, b):
            top = max(sum(a * c for a, c in zip(n, x)) for x in X)
            s = max(s, (top + GAP) / off)
    return s


def build():
    F = []
    # ---- cubes in a cube: grid seeds, gaps 1.5e-7 (clearance), 5e-8 (below the 1e-7 convention)
    for d, k, limit in ((4, 3, None), (5, 2, None), (6, 2, None), (7, 2, None), (8, 2, 32), (9, 2, 16), (10, 2, 16)):
        for g, tag, clr in ((GAP, '', True), (5e-8, '_gap5e-8', False)):
            if tag and d > 6:
                continue                                  # (the failing clearance run tries every candidate: slow)
            pieces = [c + zeros(d) for c in grid_centres(d, k, g, limit)]
            s = k + (k + 1) * g
            label = f'cubes{k}^{d}' + ('' if limit is None else f'_first{limit}')
            F.append(fx(f'{label}{tag}', prob(d, f'{d}:cube', f'{d}:cube'), s, pieces, True, clr, True))
    # ---- balls in a cube: grids, and the D4-type layout of 17 balls (the 16 corners of the unit tesseract and its centre)
    for d, k, limit in ((4, 3, None), (5, 2, None), (6, 2, None), (7, 2, 64), (8, 2, 32), (10, 2, 16)):
        pieces = [c for c in grid_centres(d, k, GAP, limit)]
        s = k + (k + 1) * GAP
        label = f'balls{k}^{d}' + ('' if limit is None else f'_first{limit}')
        F.append(fx(label, prob(d, 'ball', f'{d}:cube'), s, pieces, True, True, True))
    g = 2e-7
    h = 0.5 * (1 + g)
    corners = [list(c) for c in itertools.product((-h, h), repeat=4)]
    centre = [0.0] * 4
    # corner balls touch the centre ball at distance sqrt(4) h = 2h > 1: gap 2h - 1 = g; walls: 1 + .. -> s/2 = h + 0.5 + g/2
    F.append(fx('balls17_in_cube2_4D', prob(4, 'ball', '4:cube'), 2 * (h + 0.5 + g), corners + [centre], True, True, True,
                'the 16 corners of a tesseract of edge 1 and its centre: 17 balls in a cube of side 2 (2 + 4e-7 here)'))
    # ---- balls in a ball, a ball in a cube
    F.append(fx('ball_in_ball_4D', prob(4, 'ball', 'ball'), 1.0 + 2 * GAP, [[0.0] * 4], True, True, True))
    # ---- polytope pairs touching at a gap of 1.5e-7, random rotations, in a ball
    pair_codes = ['4:simplex', '5:simplex', '6:simplex', '7:simplex', '8:simplex', '9:simplex', '10:simplex',
                  '4:ortho', '5:ortho', '6:ortho', '8:ortho', '5:demi', '6:demi', '4:24cell', '4:600cell', '4:120cell',
                  '6:221', '6:122', '7:321', '8:421', '4:cube', '7:cube']
    for code in pair_codes:
        d = int(code.split(':')[0])
        p1, p2, circ = touching_pair(code)
        s = ball_container([p1, p2], circ, d)
        F.append(fx(f'pair_{code.replace(":", "_")}_in_ball', prob(d, code, 'ball'), s, [p1, p2], True, True, True,
                    'two randomly rotated pieces 1.5e-7 apart (float distance), in a ball'))
    # ---- one piece of each kind in a ball (any rotation) and in a polytope container
    for code in CAT.codes():
        d = int(code.split(':')[0])
        circ = max(math.sqrt(sum(c * c for c in v)) for v in CAT.get(code).vertices_float())
        pose = [0.0] * d + rand_rot(d)
        F.append(fx(f'single_{code.replace(":", "_")}_in_ball', prob(d, code, 'ball'), 2 * (circ + GAP), [pose], True, True, True))
    for piece, container in (('4:simplex', '4:cube'), ('5:cube', '5:ortho'), ('6:ortho', '6:cube'), ('4:24cell', '4:600cell'),
                             ('5:simplex', '5:demi'), ('7:demi', '7:321'), ('6:cube', '6:221'), ('4:600cell', '4:cube'),
                             ('8:ortho', '8:421')):
        d = int(piece.split(':')[0])
        pose = [0.0] * d + rand_rot(d)
        s = tight_poly_scale(piece, container, [pose])
        F.append(fx(f'single_{piece.replace(":", "_")}_in_{container.replace(":", "_")}', prob(d, piece, container), s, [pose],
                    True, True, True, 'a randomly rotated piece in a container scaled so that its wall gap is 1.5e-7'))
    # a pair of touching pieces in a polytope container
    for piece, container in (('4:simplex', '4:cube'), ('5:ortho', '5:cube')):
        d = int(piece.split(':')[0])
        p1, p2, circ = touching_pair(piece)
        s = tight_poly_scale(piece, container, [p1, p2])
        F.append(fx(f'pair_{piece.replace(":", "_")}_in_{container.replace(":", "_")}', prob(d, piece, container), s, [p1, p2],
                    True, True, True))
    # ---- adversarial
    big = 10.0
    d = 4
    for tag, dx, ex, clr, v0 in (('overlap_1e-9', 1 - 1e-9, False, False, False), ('touching', 1.0, False, False, True),
                                 ('gap_1e-9', 1 + 1e-9, True, False, True)):
        F.append(fx(f'tesseracts_{tag}', prob(d, '4:cube', '4:cube'), big, [[0.0] * 4 + zeros(4), [dx, 0.0, 0.0, 0.0] + zeros(4)],
                    ex, clr, v0))
    # the same rotated together (a pose with a common rotation): the pair is still 1e-9 apart along the rotated axis
    rot = rand_rot(5)
    R = G.matrix_of_pose([0.0] * 5 + rot, 5)
    for tag, dx, ex, clr, v0 in (('overlap_1e-9', 1 - 1e-9, False, False, False), ('gap_1e-9', 1 + 1e-9, True, False, True)):
        t2 = [R[i][0] * dx for i in range(5)]
        F.append(fx(f'rotated_5cubes_{tag}', prob(5, '5:cube', '5:cube'), big, [[0.0] * 5 + rot, t2 + rot], ex, clr, v0,
                    'two 5-cubes with the same random rotation, moved 1 -/+ 1e-9 apart along a rotated axis'))
    P24 = CAT.get('4:24cell')
    N24, b24 = P24.facets_float()
    for tag, delta, ex, clr, v0 in (('overlap_1e-9', -1e-9, False, False, False), ('gap_1e-9', 1e-9, True, False, True)):
        n = N24[0]
        t2 = [(2 * b24[0] + delta) * x for x in n]
        F.append(fx(f'24cells_face_to_face_{tag}', prob(4, '4:24cell', '4:cube'), big, [[0.0] * 4 + zeros(4), t2 + zeros(4)], ex, clr, v0,
                    'two aligned 24-cells face to face, 1e-9 apart'))
    F.append(fx('cube_out_by_1e-9', prob(5, '5:cube', '5:cube'), 1 - 2e-9, [[0.0] * 5 + zeros(5)], False, False, False,
                'a 5-cube in a container 2e-9 narrower: out by 1e-9 on every side'))
    F.append(fx('cube_in_by_1e-9', prob(5, '5:cube', '5:cube'), 1 + 2e-9, [[0.0] * 5 + zeros(5)], True, False, True,
                'a 5-cube with a wall gap of 1e-9 on every side'))
    F.append(fx('24cell_out_by_1e-9', prob(4, '4:24cell', '4:24cell'), 1 - 1e-9 / b24[0], [[0.0] * 4 + zeros(4)], False, False, False))
    F.append(fx('ball_out_by_1e-9', prob(6, 'ball', 'ball'), 1 - 2e-9, [[0.0] * 6], False, False, False))
    F.append(fx('balls_touching', prob(6, 'ball', '6:cube'), 3.0, [[-0.5, 0, 0, 0, 0, 0], [0.5, 0, 0, 0, 0, 0]], False, False, True,
                'touching balls: valid in floating point, not strictly separated'))
    F.append(fx('balls_overlap_1e-9', prob(6, 'ball', '6:cube'), 3.0, [[-0.5, 0, 0, 0, 0, 0], [0.5 - 1e-9, 0, 0, 0, 0, 0]], False, False, False))
    return F


def main():
    doc = {'version': 1, 'gap': GAP, 'fixtures': build()}
    text = json.dumps(doc, separators=(',', ':')) + '\n'
    if '--check' in sys.argv:
        with open(OUT) as f:                      # as data: prettier formats the committed file
            assert json.load(f) == doc, 'fixtures differ from the committed file'
        print('fixtures unchanged')
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        f.write(text)
    print(f'{len(doc["fixtures"])} fixtures, {len(text) / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
