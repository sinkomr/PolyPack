"""Exact constructions: radial projections of the five Platonic solids (and nothing else).

Each face becomes one piece: centre = face centre direction, vertex 0 pointed at one vertex of the
face. The rotation maps the standard frame (e1, e2 = towards vertex 0, e3 = centre) to
(t x c, t, c), t the unit tangent at c towards the chosen face vertex. Writes run files
RUN_DIR/sphere_N_P.json with the closed-form rho (the tilings meet the area bound).

Usage: python3 python/sphere/exact.py --out RUN_DIR
"""
import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from search import platonic_centres  # noqa: E402

CASES = {  # (N, P): (vertices of the solid, closed-form rho)
    (3, 4): (lambda: -platonic_centres(4), lambda: 1 / math.acos(-1 / 3)),
    (4, 6): (lambda: platonic_centres(8), lambda: 1 / math.acos(1 / 3)),
    (3, 8): (lambda: platonic_centres(6), lambda: 2 / math.pi),
    (5, 12): (lambda: platonic_centres(20), lambda: 1 / math.acos(math.sqrt(5) / 3)),
    (3, 20): (lambda: platonic_centres(12), lambda: 1 / math.atan(2)),
}


def quat_from_matrix(M):
    """Unit quaternion of a rotation matrix (Shepperd's method)."""
    t = M[0, 0] + M[1, 1] + M[2, 2]
    if t > 0:
        s = math.sqrt(t + 1) * 2
        return np.array([0.25 * s, (M[2, 1] - M[1, 2]) / s, (M[0, 2] - M[2, 0]) / s, (M[1, 0] - M[0, 1]) / s])
    i = int(np.argmax([M[0, 0], M[1, 1], M[2, 2]]))
    if i == 0:
        s = math.sqrt(1 + M[0, 0] - M[1, 1] - M[2, 2]) * 2
        return np.array([(M[2, 1] - M[1, 2]) / s, 0.25 * s, (M[0, 1] + M[1, 0]) / s, (M[0, 2] + M[2, 0]) / s])
    if i == 1:
        s = math.sqrt(1 + M[1, 1] - M[0, 0] - M[2, 2]) * 2
        return np.array([(M[0, 2] - M[2, 0]) / s, (M[0, 1] + M[1, 0]) / s, 0.25 * s, (M[1, 2] + M[2, 1]) / s])
    s = math.sqrt(1 + M[2, 2] - M[0, 0] - M[1, 1]) * 2
    return np.array([(M[1, 0] - M[0, 1]) / s, (M[0, 2] + M[2, 0]) / s, (M[1, 2] + M[2, 1]) / s, 0.25 * s])


def construct(N, P):
    verts, rho_f = CASES[(N, P)]
    V = verts()
    V = V / np.linalg.norm(V, axis=1, keepdims=True)
    C = platonic_centres(P)
    C = C / np.linalg.norm(C, axis=1, keepdims=True)
    # gauge: rotate so that face 0 is centred at the north pole with vertex 0 up
    Q = []
    for c in C:
        v = V[int(np.argmax(V @ c))]
        t = v - (v @ c) * c
        t /= np.linalg.norm(t)
        M = np.stack([np.cross(t, c), t, c], axis=1)  # columns: images of e1, e2, e3
        Q.append(quat_from_matrix(M))
    G0 = None
    q0 = Q[0]
    q0inv = q0 * np.array([1, -1, -1, -1])

    def qmul(p, q):
        w1, x1, y1, z1 = p
        w2, x2, y2, z2 = q
        return np.array([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                         w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2])

    Q = [qmul(q0inv, q) for q in Q]
    Q[0] = np.array([1.0, 0, 0, 0])
    del G0
    return rho_f(), Q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    import sgeom as sg

    for (N, P) in CASES:
        rho, Q = construct(N, P)
        g, _ = sg.validate(N, P, sg.angle_of_rho(N, rho) * (1 - 1e-12), np.array(Q))
        print(f"N={N} P={P}: rho={rho:.15f} min max-margin at rho(1+1e-12): {g:.3e}")
        json.dump({"N": N, "P": P, "rho": rho, "q": [list(map(float, q)) for q in Q], "seed": None, "budget": None,
                   "method": "exact construction: radial projection of the Platonic solid"},
                  open(os.path.join(args.out, f"sphere_{N}_{P}.json"), "w"))


if __name__ == "__main__":
    main()
