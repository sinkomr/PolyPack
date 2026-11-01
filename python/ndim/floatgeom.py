"""Floating-point helpers of the nD certifier and of the fixture builder (standard library only): rotations from
Cayley parameters, pose conversion from a matrix, and the closest points of two convex point sets (GJK with Wolfe's
minimum-norm-point solver). The certifier uses them only to propose separating directions; the proofs are exact."""
import itertools
import math

MAX_CAYLEY = 64.0         # largest accepted |Cayley parameter| (the TypeScript validator's bound too)


def n_params(d):
    return d * (d - 1) // 2


def skew(params, d):
    S = [[0.0] * d for _ in range(d)]
    k = 0
    for i in range(d):
        for j in range(i + 1, d):
            S[i][j], S[j][i] = params[k], -params[k]
            k += 1
    return S


def solve(A, B):
    """Solves A X = B (square A, matrix B) by Gaussian elimination with partial pivoting; None if singular."""
    n = len(A)
    M = [list(A[i]) + list(B[i]) for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[p][c]) < 1e-300:
            return None
        M[c], M[p] = M[p], M[c]
        piv = M[c][c]
        M[c] = [x / piv for x in M[c]]
        for r in range(n):
            if r != c and M[r][c] != 0.0:
                f = M[r][c]
                M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return [row[n:] for row in M]


def eye(d):
    return [[1.0 if i == j else 0.0 for j in range(d)] for i in range(d)]


def matmul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(len(B))) for j in range(len(B[0]))] for i in range(len(A))]


def transpose(A):
    return [list(r) for r in zip(*A)]


def det(A):
    n = len(A)
    M = [list(r) for r in A]
    out = 1.0
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        if M[p][c] == 0.0:
            return 0.0
        if p != c:
            M[c], M[p] = M[p], M[c]
            out = -out
        out *= M[c][c]
        for r in range(c + 1, n):
            f = M[r][c] / M[c][c]
            M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return out


def flip_diag(flip, d):
    return [-1.0 if flip >> i & 1 else 1.0 for i in range(d)]


def cayley_matrix(params, d, flip=0):
    """R = D (I - S)^-1 (I + S) in floats (the certifier computes the same matrix exactly in rationals)."""
    S = skew(params, d)
    I = eye(d)
    C = solve([[I[i][j] - S[i][j] for j in range(d)] for i in range(d)],
              [[I[i][j] + S[i][j] for j in range(d)] for i in range(d)])
    D = flip_diag(flip, d)
    return [[D[i] * C[i][j] for j in range(d)] for i in range(d)]


def cayley_of_matrix(R):
    """(params, flip) with cayley_matrix(params, d, flip) = R up to rounding, choosing the flip that keeps the
    parameters smallest. Raises ValueError for a matrix that is not orthonormal to 1e-9 or has determinant < 0."""
    d = len(R)
    if any(len(r) != d for r in R) or not all(math.isfinite(x) for r in R for x in r):
        raise ValueError('the rotation must be a finite d x d matrix')
    G = matmul(transpose(R), R)
    if max(abs(G[i][j] - (i == j)) for i in range(d) for j in range(d)) > 1e-9:
        raise ValueError('the matrix is not orthonormal (R^T R differs from I by more than 1e-9)')
    if det(R) < 0:
        raise ValueError('the matrix is a reflection (determinant -1): poses are rotations only')
    best = None
    if d <= 7:
        masks = [m for m in range(1 << d) if bin(m).count('1') % 2 == 0]
    else:
        base = sum(1 << i for i in range(d) if R[i][i] < 0)
        if bin(base).count('1') % 2:
            i = min(range(d), key=lambda i: abs(R[i][i]))
            base ^= 1 << i
        masks = [base] + [base ^ (1 << i) ^ (1 << j) for i in range(d) for j in range(i + 1, d)]
    for m in masks:
        D = flip_diag(m, d)
        C = [[D[i] * R[i][j] for j in range(d)] for i in range(d)]
        num = [[C[i][j] - (i == j) for j in range(d)] for i in range(d)]
        den = [[C[i][j] + (i == j) for j in range(d)] for i in range(d)]
        # S = num den^-1  ->  S den = num  ->  den^T S^T = num^T
        St = solve(transpose(den), transpose(num))
        if St is None:
            continue
        S = transpose(St)
        params = [0.5 * (S[i][j] - S[j][i]) for i in range(d) for j in range(i + 1, d)]
        size = max((abs(p) for p in params), default=0.0)
        if best is None or size < best[0]:
            best = (size, params, m)
    if best is None or best[0] > MAX_CAYLEY:
        raise ValueError('the rotation has no Cayley form within the parameter bound')
    return best[1], best[2]


def pose_of_matrix(t, R):
    """Pose array [t..., cayley params..., flip] from a centre and a rotation matrix (see cayley_of_matrix)."""
    params, flip = cayley_of_matrix(R)
    return list(t) + params + [flip]


def matrix_of_pose(pose, d):
    m = n_params(d)
    return cayley_matrix(pose[d:d + m], d, int(pose[d + m]) if len(pose) > d + m else 0)


# ------------------------------------------------------------------ closest points of two convex point sets
def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _affine_min(S):
    """Coefficients mu (sum 1) of the minimum-norm point of the affine hull of the points S, or None if singular."""
    k = len(S)
    M = [[dot(S[i], S[j]) for j in range(k)] + [1.0] for i in range(k)] + [[1.0] * k + [0.0]]
    rhs = [[0.0]] * k + [[1.0]]
    sol = solve(M, rhs)
    return None if sol is None else [row[0] for row in sol[:k]]


def closest(A, B, ball_radius=0.0, maxit=500):
    """Closest points of conv(A) and conv(B) (lists of float vectors) by GJK with Wolfe's minimum-norm-point solver.

    Returns (distance, w) with w = a* - b* the point of conv(A) - conv(B) nearest the origin, or (0.0, None) when the two
    sets touch or overlap (the minimum-norm point is 0 to rounding)."""
    d = len(A[0])

    def support(x):
        a = min(A, key=lambda p: dot(x, p))
        b = max(B, key=lambda p: dot(x, p))
        return [u - v for u, v in zip(a, b)]
    S = [[u - v for u, v in zip(A[0], B[0])]]
    lam = [1.0]
    x = list(S[0])
    last = math.inf
    for _ in range(maxit):
        xx = dot(x, x)
        if xx < 1e-28:
            return 0.0, None
        p = support(x)
        if xx - dot(x, p) <= 1e-15 + 1e-14 * xx:    # no support point is lower than x, to the noise of the coordinates (1e-16)
            break
        if xx >= last * (1 - 1e-15):                # stalled at the rounding level
            break
        last = xx
        if any(max(abs(u - v) for u, v in zip(p, q)) < 1e-15 for q in S):
            break
        S.append(p)
        lam.append(0.0)
        while True:
            mu = _affine_min(S)
            if mu is None:                        # numerically dependent: drop the new point and stop
                S.pop()
                lam.pop()
                break
            if all(m > 1e-14 for m in mu):
                lam = mu
                break
            theta = min(l / (l - m) if l - m > 1e-300 else 0.0 for l, m in zip(lam, mu) if m <= 1e-14)
            theta = max(0.0, min(1.0, theta))
            lam = [(1 - theta) * l + theta * m for l, m in zip(lam, mu)]
            keep = [i for i, l in enumerate(lam) if l > 1e-14]
            if len(keep) == len(lam):                 # rounding: drop the smallest so that the corral shrinks
                i = min(range(len(lam)), key=lambda i: lam[i])
                keep = [j for j in range(len(lam)) if j != i]
            S = [S[i] for i in keep]
            lam = [lam[i] for i in keep]
            s = sum(lam)
            lam = [l / s for l in lam]
        x = [sum(l * q[c] for l, q in zip(lam, S)) for c in range(d)]
    return math.sqrt(dot(x, x)), x
