"""Plain-float helpers for building test configurations (NOT used by the certifier's decisions).

Homogeneous 3x3 isometry matrices for curvature K, matching the conventions of certify.py.
"""
import math


def _S(t):
    if abs(t) < 1e-8:
        return 1 - t / 6
    if t > 0:
        r = math.sqrt(t)
        return math.sin(r) / r
    r = math.sqrt(-t)
    return math.sinh(r) / r


def _V(t):
    if abs(t) < 1e-8:
        return 0.5 - t / 24
    if t > 0:
        r = math.sqrt(t)
        return 2 * math.sin(r / 2) ** 2 / t
    r = math.sqrt(-t)
    return 2 * math.sinh(r / 2) ** 2 / -t


def transvection(K, x, y):
    D2 = x * x + y * y
    t = K * D2
    S, V = _S(t), _V(t)
    C = 1 - K * D2 * V
    return [
        [C, -K * S * x, -K * S * y],
        [S * x, 1 - K * V * x * x, -K * V * x * y],
        [S * y, -K * V * x * y, 1 - K * V * y * y],
    ]


def rotation(th):
    c, s = math.cos(th), math.sin(th)
    return [[1, 0, 0], [0, c, -s], [0, s, c]]


def mul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def pose_matrix(K, x, y, th):
    return mul(transvection(K, x, y), rotation(th))


def asn(K, s):
    if K > 0:
        r = math.sqrt(K)
        return math.asin(max(-1.0, min(1.0, r * s))) / r
    if K < 0:
        r = math.sqrt(-K)
        return math.asinh(r * s) / r
    return s


def pose_of(K, G):
    """Decompose an isometry G = T(x, y) R(theta) back into the pose (x, y, theta)."""
    c0, c1, c2 = G[0][0], G[1][0], G[2][0]
    s = math.hypot(c1, c2)
    D = asn(K, s) if K <= 0 else math.atan2(math.sqrt(K) * s, c0) / math.sqrt(K)
    x, y = (D * c1 / s, D * c2 / s) if s > 0 else (0.0, 0.0)
    T = transvection(K, -x, -y)
    R = mul(T, G)
    th = math.atan2(R[2][1], R[1][1])
    return x, y, th
