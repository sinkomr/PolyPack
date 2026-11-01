# Convex packing in 4 to 10 dimensions: the core (phase A)

The d-generic core for packing equal convex pieces in a scaled convex container in dimensions d = 4 to 10: an exact
catalogue of 34 polytopes, poses, a floating-point validator, an exact certifier, and the bounds that go with them.
Later phases build the problem spaces ("4D in 4D" to "10D in 10D"), the boundary problems ("4D on 5D" to "9D on 10D"),
the server registry and the site on this core. This phase adds no problem space, route, page or search. Plan and
background: the research notes of 2026-10-30 (catalogue, validators, costs) and 2026-11-01 (phases).

In code and data: `packages/ndim` (TypeScript), `python/ndim` (generator, exact certifier, tests),
`packages/ndim/test/fixtures/packings.json` (test packings shared by both languages).

Labels: [EST] established and sourced, [CALC] computed here, [SPEC] speculation.

## 1. Problems and conventions

A problem is `{ d, piece, container }` with d from 4 to 10 and each shape a catalogue code (§2) or `"ball"`. P equal
pieces are packed in the smallest scaled container. A configuration is `{ s, pieces }`: the container scale and one pose
per piece (§3).

- **Units.** A polytope piece has edge 1 and is centred at its vertex centroid. A ball piece has diameter 1 (radius 1/2),
  as in the 2D and 3D spaces since 2026-10-27.
- **Container.** Centred at the origin: the catalogue polytope (unit edge, centroid at the origin) scaled by s, or the
  ball of diameter s (radius s/2).
- **Score.** s; smaller is better. It is the edge factor of a polytope container and the diameter of a ball container.
  Stored at full precision, displayed with six decimals.
- **Validity.** Interiors of pieces may not overlap, pieces may touch, and every piece lies in the closed container.
  The float validator works at PolyPack's touching tolerance 1e-9 (`NDIM_TOL`); records keep the exact certifier's
  strict separation, with the 1e-7 clearance convention of 3D in 3D, so that a clearance of 1e-7 is certified exactly
  (§5). Site entries use the server's float validator.
- **Piece kinds.** All pieces of a problem have the same shape (a polytope or a ball). The pairs a later phase may offer
  are the polytope or ball pieces in a polytope or ball container of the same dimension.

## 2. The catalogue

34 polytopes, every one of unit edge and centred at the vertex centroid, with exact vertices and its exact
H-representation. Code scheme: `"<d>:<name>"`, with the names

| name                           | polytope                                                                                     | dimensions |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ---------- |
| `simplex`                      | regular simplex (the 5-cell for d = 4)                                                       | 4 to 10    |
| `cube`                         | hypercube (tesseract for d = 4), vertices (±1/2)^d                                           | 4 to 10    |
| `ortho`                        | orthoplex, the cross-polytope (the 16-cell for d = 4), vertices ±e_i/√2                      | 4 to 10    |
| `demi`                         | demicube, the even-weight vertices of the cube (the 16-cell for d = 4, so listed from d = 5) | 5 to 10    |
| `24cell`, `120cell`, `600cell` | the regular 4-polytopes with 24, 600 and 120 vertices                                        | 4          |
| `221`, `122`                   | the Gosset polytopes 2_21 (27 vertices) and 1_22 (72 vertices)                               | 6          |
| `321`                          | the Gosset polytope 3_21 (56 vertices)                                                       | 7          |
| `421`                          | the Gosset polytope 4_21 (the 240 roots of E8)                                               | 8          |

The counts (vertices, edges, facets) are the literature's [EST: Coxeter, _Regular Polytopes_, 3rd ed., Dover 1973;
Conway and Sloane, _Sphere Packings, Lattices and Groups_, ch. 4 and 21 for the root systems; Gosset 1900; the counts of the
uniform polytope tables]. The generator reproduces each one and fails if any differs:

| d   | polytopes (vertices / facets)                                                               |
| --- | ------------------------------------------------------------------------------------------- |
| 4   | 5-cell 5/5, tesseract 16/8, 16-cell 8/16, 24-cell 24/24, 120-cell 600/120, 600-cell 120/600 |
| 5   | simplex 6/6, cube 32/10, ortho 10/32, demi 16/26                                            |
| 6   | simplex 7/7, cube 64/12, ortho 12/64, demi 32/44, 2_21 27/99, 1_22 72/54                    |
| 7   | simplex 8/8, cube 128/14, ortho 14/128, demi 64/78, 3_21 56/702                             |
| 8   | simplex 9/9, cube 256/16, ortho 16/256, demi 128/144, 4_21 240/19,440                       |
| 9   | simplex 10/10, cube 512/18, ortho 18/512, demi 256/274                                      |
| 10  | simplex 11/11, cube 1,024/20, ortho 20/1,024, demi 512/532                                  |

Fields of each entry (TypeScript `PolytopeInfo`/`Polytope`): `code`, `d`, `name`, `title`, `nV`, `nE`, `nF`, `inradius`
(the smallest facet offset: the largest ball about the centroid inside), `circumradius` (the largest vertex norm),
`volume` (unit edge; closed form where known, else Qhull's, about 1e-14 relative), and for the coordinates `V` (vertices,
nV × d), `N` (unit outward facet normals, nF × d) and `b` (offsets, positive): x is in the polytope iff `N_f . x <= b_f`
for all f. 4D polytopes carry both their vertices and facets, so a piece can be a container and conversely.

**Exact data** (`python/ndim/catalogue_exact.json`, written by `python/ndim/gen_catalogue.py`). Two number forms:

- _axis form_ (all but the 120- and 600-cell): `x_k = (V[i][k] / den) sqrt(rad_k)`, with squarefree integers `rad_k` and
  integer `V`, `den`. The polytope is the image of the integer polytope conv(V) under a diagonal scaling, so edge
  lengths and facets are exact rational computations: |x_i - x_j|^2 = Σ rad_k (V_ik − V_jk)^2 / den^2, and a facet
  `[n_1..n_d, b]` (integers) is the half-space Σ n_k V_k ≤ b of the integer vertices. The cube and the 24-cell are rational;
  the orthoplex and demicube live in Q(√2); the simplex in Q(√r) for squarefree r | 2k(k+1) (k ≤ d), the Gosset polytopes
  in a few radicals of a Gram-Schmidt basis of the root lattice.
- _q5 form_ (120-cell and 600-cell): `x_k = (a_k + b_k √5) / den`; facets are `m . X <= r + s √5` over Q(√5).

Constructions (all [CALC]): simplex, the vertices e_j/√2 of R^(d+1) in the orthonormal basis (1,..,1,−k,0,..)/√(k(k+1))
of the hyperplane Σx = const; cube, orthoplex, demicube, 24-cell, as in the table; 600-cell, the 8 permutations of
(±1,0,0,0), the 16 points (±1/2)^4 and the 96 even permutations of (±φ, ±1, ±1/φ, 0)/2, times φ for the unit edge;
120-cell, the 600 vertices of Coxeter's list (permutations of (0,0,±2,±2), (±1,±1,±1,±√5), (±φ^−2,±φ,±φ,±φ),
(±φ^−1,±φ^−1,±φ^−1,±φ²) and the even permutations of (0,±φ^−2,±1,±φ²), (0,±φ^−1,±φ,±√5), (±φ^−1,±1,±φ,±2)), times
φ²/2; 4_21, the 240 roots of E8 (±e_i±e_j and (±1/2)^8 with an even number of minus signs); 3_21, the 56 roots r with
r.ρ = 1 for a root ρ, projected to ρ-perp (r − ρ/2); 2_21, the 27 roots with r.a = 1, r.b = 0 for roots a, b with a.b = −1,
projected to {a, b}-perp (r − (2a + b)/3); 1_22, the 72 roots orthogonal to such a and b. The span gets an orthogonal
rational basis by Gram-Schmidt, which gives the axis form.

**The proof.** `python/ndim/catalogue.py: verify` proves each entry in exact integer or Q(√5) arithmetic and the
generator and the tests both run it. It checks: the vertex, edge and facet counts equal the literature's; the vertices
are distinct and their centroid is 0; every pair of vertices is at distance at least 1 and the pairs at distance exactly
1 are the edges, forming a regular graph; every vertex satisfies every facet inequality (convexity); every facet touches
d affinely independent vertices (each listed facet is genuine) and contains 0 strictly inside; the facets are distinct, so
with the literature's count the list is complete; every vertex is an extreme point (the normals of the facets through it
have rank d); every unit edge lies in facets whose normals have rank d − 1 (so it is a 1-face). Facets of the simplex,
cube, orthoplex and demicube are written down (their triangulations are too large for a hull program in 10D); the
others come from Qhull and are then solved exactly. The proof of all 34 entries takes about half a minute in pure Python (4_21 about 15 s of it: 19,440 facets × 240
vertices; 6 s with numpy).

The floats of the TypeScript package (`packages/ndim/src/data/*.ts`) are generated from the exact data at 170 bits and
rounded to binary64; `test_ndim.py` checks that the committed files hold exactly those values.

**Cost of the large ones** [CALC]. 4_21 has 240 vertices and 19,440 facets: its data is 2 MB of TypeScript and is loaded
on demand (`await loadPolytope("8:421")`; `getPolytope` throws until then; `problemErrors` says so). Checking one piece
against it costs nV × 19,440 inequalities: the float validator takes milliseconds, the exact certifier about 35 s for one
4_21 piece in a 4_21 container (4.67 million inequalities, 7.6 µs each). The 120-cell (600 vertices) and the 600-cell
(600 facets) are small in comparison: 1.6 s for one 120-cell in a 600-cell container (360,000 inequalities). The 10D cube
(1,024 vertices) and orthoplex (1,024 facets) are the other large entries; pair counts, not vertex counts, limit packings
of them (§6).

Not in the catalogue [SPEC]: the other uniform polytopes, prisms and duoprisms, duals, and the larger Wythoff forms.
Adding one is a construction function and a literature count in the generator.

## 3. Poses and formats

**A polytope piece's pose** is the flat array `[t_1..t_d, k_1..k_m, flip]` with m = d(d−1)/2 and the last entry
optional (0 when absent). t is the centre of the piece's vertex centroid; the rotation is

    R = D (I − S)^−1 (I + S),   S[i][j] = k (i < j, in row-major order), S[j][i] = −k,   D = diag(−1 for the set bits of flip)

and the world vertex of the canonical vertex v is `t + R v`. S is skew, so I − S is always invertible and R is
orthogonal with determinant det D = +1 (the flip has an even number of set bits; an odd flip would be a reflection and is
refused). Without a flip, the Cayley form covers every rotation without eigenvalue −1; with one, every rotation of the
group can be written (half turns of an even number of axes are D itself with k = 0). The parameters are JSON numbers
that mean exactly the rational numbers they denote, so **R is an exactly orthogonal rational matrix**: the exact
certifier uses it as such, the floats of the validator agree with it to about 1e-15. Limits (the same in the TypeScript
validator and the Python certifier): |k| ≤ 32 (`MAX_CAYLEY`; it keeps I − S well conditioned), |t_i| ≤ 1e4 (`MAX_COORD`), 0 < s ≤ 1e6 (`MAX_SIZE`). A pose has d + d(d−1)/2 numbers
(10 for d = 4, 55 for d = 10) and the optional flip, an integer-valued JSON number (`2` and `2.0` are the same number, and both
languages accept either; a fractional flip, a negative one, one at or above 2^d, or one with an odd number of set bits is refused); in 3 dimensions the same formula with S the cross-product matrix of v
gives H(q)/|q|² for q = (1, v), the rule of the 3D certifier [CALC].

**A ball's pose** is its centre `[t_1..t_d]`.

**From a rotation matrix.** `poseOfMatrix(t, R, d)` (TypeScript) and `floatgeom.pose_of_matrix(t, R)` (Python) build the pose of
a row-major orthonormal matrix, choosing the flip that keeps the parameters small. They **refuse** a matrix that is not
finite, not orthonormal (RᵀR differs from I by more than 1e-9), or has determinant < 0 (a reflection: it is not
silently turned into a rotation), and one without a Cayley form within the bound. The pose is then within 1e-9 of the
matrix, and exactly the rotation the certifier proves things about.

**Configuration** (the submission format): `{ "s": 2.0000004, "pieces": [ pose, pose, ... ] }`; problem
`{ "d": 4, "piece": "4:cube", "container": "4:cube" }`. The certifier's record file is `{ "problem", "config" }`.

## 4. The float validator (`packages/ndim`)

```ts
validateNd(problem, config, { tol = 1e-9, maxErrors = 20, maxPairErrors = 3, limits, deadline }): { valid, score, reasons, minWallGap, minPairSep, worstPair, pairsTested }
validateNdAsync(problem, config, { ...same, sliceMs = 20, timeoutMs }): the same plus { workMs, slices, longestSliceMs }
ndCheck(problem, config, opts): Generator<void, NdValidation>   // the steps both of them run
```

`score` is `config.s` when valid, else `null`; `reasons` are sentences ("pieces 3 and 7 overlap by 1.2e-9", "piece 2 sticks
out of the container by …", malformed input, "at most 20 pieces are checked in this problem, got 300"). Never throws on bad
input. `validateNdAsync` gives the event loop a turn (`setTimeout 0`) whenever a slice of work reaches `sliceMs`, like
`validateAsync` of the surface space; `ndCheck` yields between pieces and pairs, so a server can also drive it itself; a
`deadline` (a time of `performance.now()`) or `timeoutMs` ends the check as invalid with a reason. One GJK / EPA / LP run
is not interrupted; each is bounded (below). Other exports:

| function                                                                                                                                    | purpose                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `getPolytope(code)`, `loadPolytope(code)`, `polytopeInfo(code)`, `POLYTOPE_CODES`, `polytopesOfDimension(d)`                                | catalogue                                                          |
| `cayleyMatrix(params, d, flip)`, `cayleyOfMatrix(R, d)`, `poseOfMatrix(t, R, d)`, `readPose(d, pose, ball)`, `placeVertices`, `placeFacets` | poses and transforms                                               |
| `signedSeparation(A, nA, B, nB, d, { tol })`, `closestPoints`, `penetrationDepth`, `gapAlong`, `maxMarginSeparation`                        | pair separation of two vertex sets                                 |
| `pieceWallGap(problem, s, pose)`, `pairSeparation(problem, poseA, poseB)`, `tightScale(problem, poses)`                                     | per-piece and per-pair numbers, the smallest s holding given poses |
| `MAX_PIECES_BY_DIM`, `MAX_BALL_PIECES`, `MAX_VERTEX_WORK`, `MAX_WALL_WORK`, `HARD_*`, `defaultLimits`, `effectiveLimits`, `sizeErrors`      | the size limits (below)                                            |
| `ballPairGap`, `ballFacetGap`, `ballWallGap`, `ballInBallGap`                                                                               | balls as pieces                                                    |
| `volumeBound`, `inradiusBound`, `lowerBound`, `maxPiecesByVolume`, `ballVolume`, `unitVolume`, `unitInradius`, `unitCircumradius`           | bounds (§7)                                                        |

**Containment** (`N_f . x <= s b_f + tol` for the piece's vertices and the container's unit facet normals; `|x| <= s/2 + tol` in
a ball container; for a ball piece `N_f . c + 1/2 <= s b_f + tol` or `|c| + 1/2 <= s/2 + tol`) and **disjointness** (the
signed separation of two pieces is at least −tol). The separating-axis test of the 3D space stops being practical from
4D on [CALC: the facets of the Minkowski difference of two polytopes come from pairs of faces F, G with dim F + dim G =
d − 1; two 120-cells give about 1.7 million candidate axes], so the pair test is **GJK with Wolfe's minimum-norm-point
solver** on the Minkowski difference A − B (support points of the two vertex sets, no explicit difference; accurate to
about 1e-13 in the distance) and, for overlapping pieces, **EPA** (a simplicial polytope grown inside A − B from a starting
simplex until its nearest facet to the origin is a facet of A − B; the depth it reports never exceeds the true depth and
converges to it from below). Two balls are compared by their centres' distance.

**Fail closed.** A pair is accepted only with a _certificate_: a unit vector u whose gap `min_B u.y − max_A u.x` is at least
−tol. The gap of any unit vector is a lower bound of the signed separation (which is the maximum of the gaps), so a
certificate proves the pair separated within tol whatever the code that found u did. Certificates come, in this order, from
(1) a few candidate directions (the line between the centres and the two facet normals of each piece that face the other
most), (2) the direction of GJK's closest points or EPA's facet normal, (3) the max-margin LP below. A pair is refused when
its separation is proved below −tol: EPA's depth so far is a lower bound of the depth, and the LP's upper bound likewise.
When neither a certificate nor a proof of overlap is found, the pair is **refused** as "could not be shown to be separated
within the tolerance" with the interval it lies in. Only a refusal can rest on EPA's depth ("overlaps by more than tol is a
sound verdict" holds for refusal; an _accepting_ EPA would not be sound, since an EPA that stops early reports a depth too
small, in the worst case 0). The first version of the validator accepted on the depth: when EPA could not build its
starting simplex (ties in the support points of coincident or aligned copies of demicubes, orthoplexes and simplices)
it reported depth 0 and the pair passed. EPA now builds the starting simplex from the support points in directions
orthogonal to the hull so far, in the sign that moves farther off it (one of the two always does, since A − B has
positive width), with seeded random directions as a fallback, reports a facet it cannot build as `converged: false`, and
`signedSeparation` returns `lower` and `upper` bounds with `sep` (the exact value when `converged`).

**The max-margin LP** (`maxMarginSeparation`, `margin.ts`): maximise δ subject to `a.x <= b − δ/2` on A, `a.y >= b + δ/2` on B
and `|a|∞ = 1`. The normalisation is not linear (a = 0 is feasible with δ = 0, which would call every overlap touching), so
it is solved for each of the 2d choices `a_i = ±1`, the other coordinates in [−1, 1]; the largest optimum is g, the box
margin. By cutting planes (the master LP over the d unknowns, a dense simplex with Bland's rule, the constraint
`t <= a.(y − x)` added for the vertex pair the current a selects as most violated). Relation to the Euclidean separation
sep (unit vectors) [CALC]: from |a|∞ ≤ |a|₂ ≤ √d |a|∞, for g ≥ 0, g/√d ≤ sep ≤ g; for g < 0, g ≤ sep ≤ g/√d. Hence

- the LP's a, normalised to u = a/|a|₂, has gap g_a/|a|₂ ≤ sep: it is the certificate, and `gap(u) >= −tol` accepts;
- `g < −√d·tol` proves a depth above tol and refuses; this is decided by the LP's upper bound;
- between, with no certificate (an overlap of tol to √d·tol that the LP's direction does not clear), the answer is
  "open" and the pair is refused. The band is empty at tol = 0.

The fallback accepts the genuinely touching pairs: face to face (the k^d grids, aligned 24-cells face to face), shifted
face to face, coincident faces, and slivers of overlap within tol, because the box-optimal a of those pairs is a facet
normal, and `gap(u) = 0` or `−tol/2`. It runs when GJK's direction is too noisy to certify (distances below about 1e-7) or
EPA does not converge, which is common for the large polytopes in 8D to 10D (4_21, the 10-cube): their A − B has too many
facets for EPA's cap of 12,000, and the LP, which never builds facets, takes over (about 100 to 200 ms per pair at worst).
It is bounded by 260 cuts and 140 master solves per branch; past that it is inconclusive and the pair is refused.

**Limits on the work** (`limits.ts`; enforced by `configErrors`, hence by `validateNd`, before any pose is read).

| limit                                       | default                                   | hard ceiling |
| ------------------------------------------- | ----------------------------------------- | ------------ |
| polytope pieces `P`                         | 40 (4D), 32 (5D), 24 (6D), 20 (7D to 10D) | 256          |
| ball pieces                                 | 400, any d                                | 1,024        |
| `P · nV · d` (world vertices, 8 bytes each) | 500,000 (4 MB)                            | 8,000,000    |
| `P · nV · nF` (wall inequalities)           | 200,000,000                               | 4 × 10^9     |

A trusted caller (tests, offline tools: the 81 cubes of the 3^4 fixture, 128 cubes of 2^7) passes `limits: { maxPieces: 128 }`
and the like, replacing the defaults up to the ceilings; a server takes the limits from the problem registry, never from the
request. Work
inside the limits: the pairs are found by a sweep along the coordinate of the largest spread of the centres, and a pair whose
centres are farther apart than the circumradii's sum plus tol costs nothing; vertices are placed only for pieces that
have a near pair or a nearby wall; a polytope container skips a piece far from all walls (`|t| + R <= s r_in`) and,
per facet, the vertex test when `N_f . t + R <= s b_f` (`minWallGap` is then a lower bound of the true smallest gap for those
pieces, exact for any piece within reach of a wall; `pieceWallGap` stays exact); the check ends after `maxErrors` errors and
after `maxPairErrors` (3) refused pairs, since each is an EPA or LP run. Measured on Apple Silicon [CALC]: 20 coincident or
random overlapping pieces of 8:421, 10:cube, 10:demi, 9:demi: 0.2 to 0.4 s (three refused pairs); 8000 10-cubes or 300 8:421:
refused in 2 ms (they took 784 MB and 5.5 s, and 40 s, before); 400 balls in 10D: under 30 ms.

Tests: GJK/EPA against closed forms (cubes in 4D to 10D, aligned 24-cells face to face), against the 3D
separating-axis test of the polyhedra space on 160 random polyhedron pairs (penetration depths agree to 2e-9 and the
distance is never below the SAT value), and in 4D to 8D by the facet property (moving B by depth + 1e-6 along the returned
direction separates the pieces, depth − 1e-6 does not); the cases that used to fail open (coincident copies of every
catalogue polytope, copies shifted along a body axis or the diagonal, copies under a common random rotation, all against exact
depths `min_f (2 b_f − N_f . o)`), the LP against closed forms and GJK/EPA, the limits, the sweep against an all-pairs scan,
the wall prefilter, and the slices (`packages/ndim/test/robust.test.ts`).

## 5. The exact certifier (`python/ndim/certify.py`)

    python3 python/ndim/certify.py record.json [--clearance 1e-7]       # standard library only
    certify_config(problem, config, clearance=0.0) -> { ok, pieces, tests, near_pairs, far_pairs, min_wall_gap, min_pair_gap, failures, seconds }

It raises `CertError` for malformed input and returns `ok = False` with the failing walls and pairs otherwise. What is
proved, in rigorous 170-bit fixed-point interval arithmetic on enclosures of the exact catalogue coordinates, with every
inequality strict:

1. **Rational rotations.** From the pose's floats (the exact rationals they denote) the Cayley matrix
   R = D (I − S)^−1 (I + S) is computed in `Fraction`s: exactly orthogonal, determinant 1 (the tests check RᵀR = I and
   det R = 1 exactly in every d). Poses are never "rounded to a rotation": the rotation is defined by the pose.
2. **Containment.** Every vertex x of every piece satisfies `N_f . x < s B_f` for every facet f of a polytope container
   (N_f the exact outward normal, not unit, in the enclosure of the exact field element); in a ball container
   `|x|^2 < ((s − clearance)/2)^2`; a ball piece satisfies `N_f . c + |N_f|/2 < s B_f`, or `|c| + 1/2 < s/2` in exact rationals.
3. **Separation.** Pairs whose centres are farther apart than 2 R_up (an upper bound of the circumradius) are disjoint;
   every other pair gets an explicit **rational separating hyperplane** u (a unit vector rounded to denominator 1e12,
   proposed in floating point from the line of centres, the facets of pieces with at most 64 facets, and the closest
   points by GJK) and the exact test `max over A of u.x < min over B of u.x` on every vertex. A bad proposal can make
   the certification fail, never succeed. Two balls: exact squared distance.
4. **Clearance.** With `clearance = c > 0` the proved gap along the unit normal (and to each wall) must exceed c, decided
   exactly. The convention of 3D in 3D: records keep 1e-7, and the certifier reports the smallest proved wall and pair gaps.
   With the default 0 only strict positivity is proved.

Interfaces: `cayley_exact(params, d, flip)`, `is_orthogonal(R)`, `world_enc(piece, vertex_enc)`, `plane_test(u, XA, XB)`,
`exact_plane(XA, XB, u)` (Python); pose conversion in `floatgeom.py`; the catalogue's `Polytope.vertex_enc()`,
`facet_enc()`, `vertices_float()`, `facets_float()`.

**Speed** (Apple Silicon, one core, Python 3.12) [CALC]:

| case                                                           | time           |
| -------------------------------------------------------------- | -------------- |
| 2^6 = 64 cubes in a 6-cube (1,984 near pairs, 1.5e-7 gaps)     | 0.6 s          |
| 2^7 = 128 cubes in a 7-cube (8,064 near pairs)                 | 5.5 s          |
| 16 cubes of the 2^10 grid in a 10-cube (1,024 vertices each)   | 1.3 s          |
| two touching 120-cells, 600-cells or 4_21 polytopes in a ball  | 0.01 to 0.06 s |
| one 8-orthoplex in 4_21 (256 × 19,440 inequalities)            | 3.1 s          |
| one 120-cell in a 600-cell (360,000 inequalities)              | 1.6 s          |
| one 4_21 piece in a 4_21 container (4.67 million inequalities) | 35 s           |
| 86 test packings of the fast set, clearance 0 and 1e-7         | 10 s           |

Containment dominates for big containers (about 7 µs per vertex-facet inequality) and the number of near pairs for
many pieces (about 0.7 ms per pair). A floating-point filter that keeps the exact test for near-maximal vertices only
would cut the containment time by an order of magnitude [SPEC]; not done.

## 6. Test packings and tests

`python/ndim/make_fixtures.py` writes `packages/ndim/test/fixtures/packings.json` (98 fixtures, 0.14 MB, deterministic):

- k^d cubes in a cube at gaps of 1.5e-7 (4D: 3^4 = 81; 5D to 7D: 2^d; 8D to 10D: the first 32, 16 and 16 of the grid) and
  at 5e-8 (strictly separated, below the 1e-7 clearance);
- k^d balls in a cube (the same grids) and the D4-type layout of **17 balls in a 4-cube of side 2**
  (the 16 corners of a tesseract of edge 1 and its centre: 17 points of a cube of side 1 with mutual distances at least 1 [CALC];
  17 is the most such points, by Adamko 2019 as quoted in the research note of 2026-10-30);
- pairs of randomly rotated pieces moved together to a float distance of 1.5e-7 in a ball: simplices (4D to 10D),
  orthoplexes, demicubes, the 24-, 120- and 600-cell, 2_21, 1_22, 3_21, 4_21, cubes; one piece of every catalogue entry in
  a ball and nine pieces in other polytopes (a simplex in a cube, a 24-cell in a 600-cell, an 8-orthoplex in 4_21, ...), each
  scaled to a wall gap of 1.5e-7;
- adversarial: two tesseracts overlapping, touching and separated by 1e-9; the same two 5-cubes under a common random
  rotation; two aligned 24-cells face to face 1e-9 apart; a 5-cube in a container 2e-9 narrower, and 2e-9 wider; a 24-cell
  and a ball out by 1e-9; two touching balls and two balls overlapping by 1e-9.

Each fixture says what the exact certifier answers (clearance 0 and 1e-7) and what the float validator answers at
tolerance 0; both languages must give those answers, and they do, for all 98. The pieces that are exactly touching are
the instructive ones: valid in floating point, not strictly separated for the exact certifier.

Further tests. TypeScript (`packages/ndim/test`, 240 tests, about 15 s): the catalogue against the literature's counts
and against itself in floats (all inequalities, unit edges, volumes by closed forms and by sums of pyramids), poses
(orthonormality and determinant in every d, round trips, half turns, refusal of reflections, non-orthonormal and
non-finite matrices, malformed poses), GJK/EPA (§4), the validator (tolerance semantics at 1e-9, soundness against the full
separation on 240 random pairs, balls, 4_21 as a container, malformed configurations and problems with their reasons,
the cap on errors, and the fail-closed pair test of §4 in `robust.test.ts`), bounds, and the on-demand loading of 4_21. Python (`python/ndim/test_ndim.py`, added to
`python/test_spaces.py`; 20 tests, under a minute): the exact proof of every catalogue entry and that tampered data is
refused (a moved vertex, a missing or repeated facet, a facet repeated at another scale, a facet moved in or out, a wrong scale or radicand, an extra
vertex), the generated TypeScript data, exact orthogonality of the rational rotations, pose conversion, malformed
configurations and problems, all fixtures, and adversarial cases (coincident pieces, gaps of ±1e-9 and 0, walls,
the clearance, a wrong separating plane, rotated 24-cells). `NDIM_SLOW=1` adds the three slowest fixtures and the
rebuild of the fixture file (about 90 s in all); CI's main job skips them.

**Pairs at scale** [CALC]. Pairs dominate the cost of many pieces: in the grid of 2^d cubes every two cubes are within
the reach 2 R = √d of each other for d ≤ 10, so 2^10 cubes would be 523,000 near pairs; the 2^10 fixture therefore uses 16
pieces. The validator finds the near pairs by a sweep along one coordinate and caps P (§4), so the many-piece
fixtures here (81 cubes in 4D, 128 in 7D) are validated with raised limits; a later phase's kernel will want a neighbour grid.

## 7. Bounds

`volumeBound(problem, P)` is (P vol(piece)/vol(container))^(1/d) [EST: volume]; `inradiusBound(problem)` is
r_in(piece)/r_in(container) (the piece contains a ball of its inradius, which must fit in the container's) [EST];
`lowerBound` is the larger. Volumes at unit scale: the catalogue's `volume`, and π^(d/2)/Γ(d/2 + 1) (1/2)^d for a ball.
Volume bounds weaken with d, because the best packing densities fall (lattice balls: 0.617, 0.465, 0.373 in 4D to
6D [EST: Conway and Sloane]), so "relative gap to the bound" is large even for good packings. `maxPiecesByVolume(problem, s)`
is floor(s^d vol(container)/vol(piece)). The optima proved by tilings (k^d cubes at s = k) stay `best_known` under PolyPack's
policy unless a published proof exists.

## 8. For the later phases

- **Kernel** (`packages/methods`, kernel.ts). A piece has `dim = d + d(d−1)/2` variables: the centre t and a rotation
  increment. A kernel keeps the base rotation R₀ of each piece as an anchor in `aux` and an increment S (the skew
  parameters) in the state, so that a piece's rotation is R₀ (I − S)^−1 (I + S) near S = 0 (the chart is regular there and
  has no gimbal singularity; `rebase` folds S into R₀ with `cayleyMatrix` and `cayleyOfMatrix`). `finish()` writes poses
  with `poseOfMatrix`, validates with `validateNd` at tolerance 0 and states `score = s`, as the kernel's `Validation` (`{ valid, score, reasons }`)
  expects. Energy terms: `pieceWallGap`, `pairSeparation` and the ball helpers give lengths of overlaps and protrusions.
- **Server.** Problem ids and codes are the caller's; `NdProblem` is `{ d, piece, container }` and the configuration is
  `{ s, pieces }` as in §3. `validateNd` never throws and bounds its work (the limits of §4 are enforced first; far pairs cost nothing; EPA and
  the LP are capped); the server should drive `validateNdAsync` (or `ndCheck`) with a deadline and call `loadPolytope("8:421")` once at start-up if an 8D problem uses it.
- **Records.** The exact certifier takes `{ problem, config }`; the wiki's 4D to 6D configurations (rotation matrices or
  Cayley parameters) are converted with `poseOfMatrix` and certified at the 1e-7 clearance before they are imported.
- **Boundary problems** (nD on (n+1)D) need the same catalogue as containers, the chain enumerator of the 3D on 4D code
  generalised, and this validator for the overlap test of parts (4D in 4D is a prerequisite of 4D on 5D).

## 9. Sources, licences and limitations

- **Mathematics.** Coxeter, _Regular Polytopes_ (1973), for the regular polytopes, the demicubes and the counts; Conway and
  Sloane, _Sphere Packings, Lattices and Groups_ (1999), for the E8 root system and the Gosset polytopes; Gosset, "On the regular and
  semi-regular figures in space of n dimensions" (1900). The Cayley transform of a skew matrix is classical.
- **Code.** The code of this phase is PolyPack's own, MIT like the rest of the repository. It uses `python/polyhedra/algebraic.py`
  (vendored from alejandrozu/platonic-packing, MIT, see THIRD_PARTY_NOTICES.md) for interval arithmetic and integer
  square roots. Upstream's nD tools (`polytopes_nd.py` and `.json`, `certify_nd.py`, `ndsim.py`, `ndslp.py`) were not
  used: nothing of them is vendored. An independent review compared the catalogue with upstream's `polytopes_nd.json`
  afterwards: all 12 polytopes the two share have the same vertices up to congruence (a comparison, not a source). Phase
  B's import of the wiki's 4D to 6D records will certify them again with this certifier.
- **Limitations.** [1] The catalogue is regular, demi- and Gosset polytopes only; 4D has no Archimedean-type pieces yet.
  [2] The pieces of a problem share one shape. [3] The validator finds pairs by a sweep along one coordinate (O(P^2) in the worst case, P is capped at 20 to 40 for polytopes).
  [4] The
  exact certifier is pure Python: containment of big polytopes in big containers takes tens of seconds (§5). [5] EPA is
  a lower bound of the penetration depth and stops at 600 expansions or 12,000 facets (reported as `converged: false` by
  `signedSeparation`); the validator then does not judge by the depth found: a pair is accepted only with a certificate
  (a unit vector with gap at least −tol, from the candidate directions, GJK, EPA's normal or the max-margin LP), refused
  when the depth or the LP's bound proves an overlap above tol, and refused as undecided otherwise, so it can refuse a
  valid pair that overlaps by between tol and √d·tol, never accept an invalid one (§4). [6] Poses with a Cayley parameter above 32 are
  refused; use a flip. [7] The edges are not stored in the TypeScript data (they are the pairs at distance 1).
  [8] Nothing here knows about folding, the boundary ("on") problems or the site.
  [9] The certifier rounds each separating hyperplane to a denominator of 10^12, so a strict gap below about 1e-12 may
  go uncertified (incompleteness only, never an unsound verdict; irrelevant at the records' 1e-7 clearance).
  [10] The clearance term in `certify.py` uses the midpoint of the enclosure of |N_f| rather than its upper end; the
  error is about 1e-48 times the clearance. [11] In floats, R^T R - I reaches about 6e-15 at |k| = 32 in d = 10; the
  exact certifier uses the exact rational rotation, so this affects only the float validator's 1e-9 tolerance.
