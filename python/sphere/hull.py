"""Pure-float incremental convex hull; candidate planes only, never a certificate decision."""

def sub(a, b):
    return [x-y for x, y in zip(a, b)]


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def faces(S):
    a = 0
    b = max(range(len(S)), key=lambda i: dot(sub(S[i], S[a]), sub(S[i], S[a])))
    line = sub(S[b], S[a])
    c = max(range(len(S)), key=lambda i: dot(cross(line, sub(S[i], S[a])), cross(line, sub(S[i], S[a]))))
    plane = cross(line, sub(S[c], S[a]))
    d = max(range(len(S)), key=lambda i: abs(dot(plane, sub(S[i], S[a]))))
    if abs(dot(plane, sub(S[d], S[a]))) < 1e-24:
        return []  # fail closed if these candidates cannot prove separation
    inside = [sum(S[i][k] for i in (a, b, c, d))/4 for k in range(3)]

    def face(i, j, k):
        return (i, k, j) if dot(cross(sub(S[j], S[i]), sub(S[k], S[i])), sub(inside, S[i])) > 0 else (i, j, k)

    fs = [face(a, b, c), face(a, d, b), face(a, c, d), face(b, d, c)]
    for i in range(len(S)):
        if i in (a, b, c, d):
            continue
        edges, kept = {}, []
        for f in fs:
            n = cross(sub(S[f[1]], S[f[0]]), sub(S[f[2]], S[f[0]]))
            if dot(n, sub(S[i], S[f[0]])) <= 1e-15 * dot(n, n)**0.5:
                kept.append(f)
                continue
            for u, v in zip(f, f[1:]+f[:1]):
                key = tuple(sorted((u, v)))
                if key in edges:
                    del edges[key]
                else:
                    edges[key] = (u, v)
        fs = kept + [face(u, v, i) for u, v in edges.values()]
    return fs
