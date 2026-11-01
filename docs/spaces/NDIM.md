# Convex packing in 4 to 10 dimensions: the core (phase A) and the nD in nD space (phase B)

The d-generic core for packing equal convex pieces in a scaled convex container in dimensions d = 4 to 10: an exact
catalogue of 34 polytopes, poses, a floating-point validator, an exact certifier, and the bounds that go with them.
Later phases build the problem spaces ("4D in 4D" to "10D in 10D"), the boundary problems ("4D on 5D" to "9D on 10D"),
the server registry and the site on this core. Phase A (§1 to §9) adds no problem space, route, page or search; phase B
(§10 to §12) adds the nD in nD space: problems, server rules, the wiki's records and a kernel for the generic methods.
Plan and background: the research notes of 2026-10-30 (catalogue, validators, costs) and 2026-11-01 (phases).

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
certifier uses it as such, the floats of the validator agree with it to about 1e-15. Limits: |k| ≤ 32 (`MAX_CAYLEY`; it
keeps I − S well conditioned), |t_i| ≤ 1e4 (`MAX_COORD`), 0 < s ≤ 1e6 (`MAX_SIZE`). A pose has d + d(d−1)/2 numbers
(10 for d = 4, 55 for d = 10) and the optional flip; in 3 dimensions the same formula with S the cross-product matrix of v
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
validateNd(problem, config, { tol = 1e-9, maxErrors = 20 }): { valid, score, reasons, minWallGap, minPairSep, worstPair, pairsTested }
```

`score` is `config.s` when valid, else `null`; `reasons` are sentences ("pieces 3 and 7 overlap by 1.2e-9", "piece 2 sticks
out of the container by …", malformed input). Never throws on bad input. Other exports:

| function                                                                                                                                    | purpose                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `getPolytope(code)`, `loadPolytope(code)`, `polytopeInfo(code)`, `POLYTOPE_CODES`, `polytopesOfDimension(d)`                                | catalogue                                                          |
| `cayleyMatrix(params, d, flip)`, `cayleyOfMatrix(R, d)`, `poseOfMatrix(t, R, d)`, `readPose(d, pose, ball)`, `placeVertices`, `placeFacets` | poses and transforms                                               |
| `signedSeparation(A, nA, B, nB, d)`, `closestPoints`, `penetrationDepth`, `gapAlong`                                                        | pair separation of two vertex sets                                 |
| `pieceWallGap(problem, s, pose)`, `pairSeparation(problem, poseA, poseB)`, `tightScale(problem, poses)`                                     | per-piece and per-pair numbers, the smallest s holding given poses |
| `ballPairGap`, `ballFacetGap`, `ballWallGap`, `ballInBallGap`                                                                               | balls as pieces                                                    |
| `volumeBound`, `inradiusBound`, `lowerBound`, `maxPiecesByVolume`, `ballVolume`, `unitVolume`, `unitInradius`, `unitCircumradius`           | bounds (§7)                                                        |

**Containment** (`N_f . x <= s b_f + tol` for the piece's vertices and the container's unit facet normals; `|x| <= s/2 + tol` in
a ball container; for a ball piece `N_f . c + 1/2 <= s b_f + tol` or `|c| + 1/2 <= s/2 + tol`) and **disjointness** (the
signed separation of two pieces is at least −tol). The separating-axis test of the 3D space stops being practical from
4D on [CALC: the facets of the Minkowski difference of two polytopes come from pairs of faces F, G with dim F + dim G =
d − 1; two 120-cells give about 1.7 million candidate axes], so the pair test is **GJK with Wolfe's minimum-norm-point
solver** on the Minkowski difference A − B (support points of the two vertex sets, no explicit difference; accurate to
about 1e-13) and, for overlapping pieces, **EPA** (a simplicial polytope grown inside A − B from GJK's final simplex
until its nearest facet to the origin is a facet of A − B; the depth it reports never exceeds the true depth and converges
to it from below, so "overlaps by more than tol" is a sound verdict). A pair is settled without either when one of a few
candidate directions (the line between the centres and the two facet normals of each piece that face the other most)
shows a gap of at least −tol, since any unit direction gives a lower bound of the separation. Pairs whose centres are
farther apart than the sum of the circumradii are skipped. Two balls are compared by their centres' distance.

Tests: GJK/EPA against closed forms (cubes in 4D to 10D, aligned 24-cells face to face), against the 3D
separating-axis test of the polyhedra space on 160 random polyhedron pairs (penetration depths agree to 2e-9 and the
distance is never below the SAT value), and in 4D to 8D by the facet property (moving B by depth + 1e-6 along the returned
direction separates the pieces, depth − 1e-6 does not).

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

Further tests. TypeScript (`packages/ndim/test`, 176 tests, about 5 s): the catalogue against the literature's counts
and against itself in floats (all inequalities, unit edges, volumes by closed forms and by sums of pyramids), poses
(orthonormality and determinant in every d, round trips, half turns, refusal of reflections, non-orthonormal and
non-finite matrices, malformed poses), GJK/EPA (§4), the validator (tolerance semantics at 1e-9, soundness against the full
separation on 240 random pairs, balls, 4_21 as a container, malformed configurations and problems with their reasons,
the cap on errors), bounds, and the on-demand loading of 4_21. Python (`python/ndim/test_ndim.py`, added to
`python/test_spaces.py`; 19 tests, under a minute): the exact proof of every catalogue entry and that tampered data is
refused (a moved vertex, a missing or repeated facet, a facet moved in or out, a wrong scale or radicand, an extra
vertex), the generated TypeScript data, exact orthogonality of the rational rotations, pose conversion, malformed
configurations and problems, all fixtures, and adversarial cases (coincident pieces, gaps of ±1e-9 and 0, walls,
the clearance, a wrong separating plane, rotated 24-cells). `NDIM_SLOW=1` adds the three slowest fixtures and the
rebuild of the fixture file (about 90 s in all); CI's main job skips them.

**Pairs at scale** [CALC]. Pairs dominate the cost of many pieces: in the grid of 2^d cubes every two cubes are within
the reach 2 R = √d of each other for d ≤ 10, so 2^10 cubes would be 523,000 near pairs; the 2^10 fixture therefore uses 16
pieces. A later phase's kernel will want a neighbour grid; the validator here scans all pairs (O(P^2) distance checks,
cheap per pair).

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
  `{ s, pieces }` as in §3. `validateNd` never throws and bounds its work (pairs farther than the reach are skipped, EPA is
  capped); the server should call `loadPolytope("8:421")` once at start-up if an 8D problem uses it.
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
  used: nothing of them is vendored, and the catalogue was not compared with `polytopes_nd.json`. Phase B's import of the
  wiki's 4D to 6D records will certify them again with this certifier.
- **Limitations.** [1] The catalogue is regular, demi- and Gosset polytopes only; 4D has no Archimedean-type pieces yet.
  [2] The pieces of a problem share one shape. [3] The validator is O(P^2) in pairs and has no neighbour grid. [4] The
  exact certifier is pure Python: containment of big polytopes in big containers takes tens of seconds (§5). [5] EPA is
  a lower bound of the penetration depth and stops at 600 expansions (reported as `converged: false` by
  `signedSeparation`; the validator then judges by the depth found). [6] Poses with a Cayley parameter above 32 are
  refused; use a flip. [7] The edges are not stored in the TypeScript data (they are the pairs at distance 1).
  [8] Nothing here knows about folding, the boundary ("on") problems or the site.

## 10. The nD in nD space (phase B)

**Structure.** One space, `ndim`, for every dimension: a problem is `ndim/<d>/<piece>/<container>/<P>`, with d from 4 to 10 and the
two shapes the catalogue's names (`simplex`, `cube`, `ortho`, `demi`, `24cell`, `120cell`, `600cell`, `221`, `122`, `321`,
`421`, as §2 lists them for the dimension) or `ball`: `ndim/4/cube/ortho/12` is 12 hypercubes in an orthoplex (the 16-cell),
`ndim/8/ball/421/5` five balls in the 4_21 polytope. A single space keeps the registry, the records file and the heavy-check
rules in one place; the site shows one entry "dD in dD" per dimension by the `d` field of the domain (phase E). Ids are accepted
in this one form only (no leading zeros). Code: `packages/ndspace` (names, ids, bounds, domain, validation, kernel), wired in
`packages/spaces` (types, ids, info, domain, records, validate, search) and `apps/server/src/spaces.ts`.

**Problems.** Every ordered pair of the dimension's shapes, balls included (balls in each polytope, each polytope in a ball, balls
in a ball), and P over the dimension's range, defined by ranges and never listed in memory (`SPACE_DOMAINS.ndim`):

| d   | shapes (polytopes + ball) | ordered pairs | P         | problems  |
| --- | ------------------------- | ------------- | --------- | --------- |
| 4   | 6 + 1                     | 49            | 2 to 40   | 1,911     |
| 5   | 4 + 1                     | 25            | 2 to 32   | 775       |
| 6   | 6 + 1                     | 49            | 2 to 24   | 1,127     |
| 7   | 5 + 1                     | 36            | 2 to 20   | 684       |
| 8   | 5 + 1                     | 36            | 2 to 20   | 684       |
| 9   | 4 + 1                     | 25            | 2 to 20   | 475       |
| 10  | 4 + 1                     | 25            | 2 to 20   | 475       |
|     |                           |               | **total** | **6,131** |

(4D has no `demi`: the 4D demicube is the 16-cell.) The ranges of 4D to 6D are upstream's. The domain's fields are `d`, `piece`,
`container` and `P`; the last two depend on `d` (`dependent` in the field description: the shapes of each dimension and its range
of P). Titles are "Hypercubes in an orthoplex" with "4D:" in front.

**Bounds** (`ndLowerBound`, the domain's `bound`): the larger of the volume bound (§7), the inradius bound and, in a ball container,
the circumradius bound s >= 2 R of the piece (the circumscribed ball of a regular polytope is its smallest enclosing ball [EST]),
lowered by 1e-12 relative because the volumes are floats [CALC]. Entries below it by more than 1e-9 relative are refused unchecked.

**Server rules.** The submission route is the spaces' `POST /api/spaces/submit` with `space: "ndim"`, the id and the configuration
`{s, pieces}` of §3; the configuration is read by `parseNdConfig` (malformed input is 400, a wrong number of pieces 422) and
checked by `validateNdSteps` of the ndim package (§4) at the touching tolerance 1e-9, and at 1e-11 as well for an entry that
beats a record or has none (as in every space). As in 3D in 3D, the records keep the wiki's clearance of 1e-7 between pieces and
from the walls, so an entry beats a record only when it is below it by more than a relative 1e-6 (`SPACE_RECORD_MARGIN.ndim`, the
polyhedra's `POLYHEDRA_RECORD_MARGIN`), below the site leader by more than the tie tolerance, and it is answered "not checked" (200,
`checked: false`) without any geometry when its stated size cannot be kept (the checks are costly). No unit gate: the units are
the diameter-1 ones from the start. Work bounds:

- P is at most the dimension's range (the server refuses others as outside the catalogue); poses are read with the ndim limits
  (§3: centres at most 1e4, Cayley parameters at most 32, s at most 1e6);
- the check runs in slices (`ndCheckSteps` yields between pieces, pairs and blocks of 2,048 vertex-facet products; the server runs
  it through `runStepsAsync`, 8 ms slices), stops after 5 reasons (an overlapping pair of 8D to 10D polytopes costs up to 0.8 s of GJK
  and EPA [CALC]) and after 8 s of processor time (`NDIM_CHECK_MS`; the check then says so and the entry is refused);
- pairs whose centres are closer than twice the inradius are overlaps without GJK (a bound that never exceeds the true depth);
  a container facet that cannot lower the smallest wall gap (by the piece's circumradius) is skipped;
- checks of more than 2e7 multiply-adds (`ndCheckOps`: pieces' vertices times the container's facets times d, and 40 nV d per pair)
  are heavy (`ndIsHeavy`): one at a time server-wide, at most 8 waiting, else 503, as for polyhedra at P = 500; the budget charged to
  the address is estimated at 5 + 3e-6 ops ms (at most 8 s) and corrected by the work measured. The 4_21 polytope is loaded on demand
  (2 MB; `loadNdProblem`) before the first check that uses it.

[CALC] Measured on Apple Silicon (Node 26): the largest valid cases, 20 4_21 polytopes in a 4_21 container (761 M multiply-adds),
20 hypercubes in a 10D orthoplex, 40 120-cells in a 600-cell, took 25 to 90 ms with the facet skipping (2.3 s without), and
two gross overlaps of 10D hypercubes 0.5 to 0.8 s each when EPA runs. The tests (`packages/ndspace/test/validate.test.ts`) check
that the worst problems of four dimensions stay under the cap with every piece on top of the others, and
`apps/server/test/spaces-ndim.test.ts` the submission cases and the full queue.

**API text.** `GET /api/spaces` lists `ndim` with its title, summary, score, id form, conventions (problems, units, container, pose,
configuration, validity, improvement, work limit), the domain and the number of records; the page and the viewer are phase E's.

## 11. The kernel for the generic methods

`ndKernel({d, piece, container, P})` (`packages/ndspace/src/kernel.ts`) implements the `packages/methods` contract, so that Auto and
the generic methods run on every problem of the domain; `packages/spaces/src/search` builds it for `ndim/...` ids. Auto is the generic
basin hopping on this kernel (`AUTO_NDIM_METHOD`; no engine of its own). A polytope piece has d + d(d-1)/2 variables (centre and
a chart rotation, the Cayley parameters of a skew S times the circumradius, around an anchor R0 kept in `aux`; `rebase` folds
C(S) = (I - S)^-1 (I + S) into R0), a ball piece d.

- **Energy.** Sum of squared overlaps: of pairs, 2 r - sd with sd the signed separation of the pieces' cores by GJK and EPA
  (`signedSeparation`), of walls, the protrusion of the farthest vertex beyond a facet of the container (or beyond the ball).
  With the shape parameter tau the core is the piece scaled by tau and dilated by r = (1 - tau) rho (the soft pieces of harden and
  morph; balls are their own inscribed ball). The gradient is analytic: translations by the separating direction u, rotations by
  d(u . x)/dk_ij = 2 (a_i b_j - a_j b_i), a = (R0 (I - S)^-1)^T u, b = tau (I - S)^-1 v; at the **contact points** of the pair, not at
  a vertex (`contact.ts`: for an edge against an edge the vertices tie and the derivative sits at the closest points of the edges,
  found by GJK on the tangential differences of the two faces). The contract's gradient check passes on every kind of pair and wall.
- **finish** scales the centres and the container together by f: every pair gap grows by at least 2 rho (f - 1) and every wall gap
  by at least rho (f - 1), so the valid f form a ray; it brackets and bisects it with the validator at tolerance 0, to 1e-12, and
  returns the smallest (it also shrinks a state that is valid with room to spare). **validate** is the server's rule (form, the lower
  bound with its slack, the check at 1e-9).
- **seeds**: P points of the lattice Z^d (at the centre of a cell and at a vertex), D_d, and E8 in 8D (§ `lattice.ts`), their mean at
  the origin, in the canonical orientation and then in random common orientations, at the smallest spacing at which the pieces
  just do not overlap (bisection on the pair test); 2^d hypercubes in the hypercube give the exact grid s = 2. **randomStart**
  fills the container to 15 %, **randomPose** a uniform orientation (Haar, by QR), `swap` the orientations of two pieces.
- **Poses.** The kernel's configurations use `robustPose`: the ndim package's `poseOfMatrix` solves S = (D R - I)(D R + I)^-1 for
  each even flip D and keeps the smallest parameters, and for a rotation with an eigenvalue -1 under some D (a signed permutation
  matrix, say) the solve is numerically singular and can return the parameters of another rotation. `robustPose` rebuilds every
  candidate and keeps one only when it reproduces the matrix to 1e-12.

Costs are declared in energy evaluations (finishCost 60 + P/2, validateCost 3). In 8D to 10D the energy of a deep overlap of
two polytopes with hundreds of vertices costs up to 0.5 s (EPA), so the generic methods run, but slowly, there; no search was
run for this phase beyond the tests (`packages/ndspace/test/kernel.test.ts`: `checkKernel` on 16 problems of every dimension, the
full gradient against differences, finish, seeds, the generic methods penalty, basin_hopping and seed on a small problem).

## 12. The wiki's records

The 4D to 6D problems of polyhedrainpolyhedra.wiki's higher-polytope tab (36 ordered pairs of the six regular 4-polytopes with n = 2
to 40, 9 pairs of the 5-simplex, 5-cube and 5-orthoplex with n up to 32, 9 of 6D with n up to 24: 1,890 files) are imported by
`python/ndim/build_records.py` from alejandrozu/platonic-packing (MIT, commit 8ce7b48831804b287fd98ade4ef35f5a6d6ca188, see
THIRD_PARTY_NOTICES.md), the same way as 3D in 3D (`docs/spaces/POLYHEDRA.md` §2):

- **Frame.** Upstream's polytopes are in another frame and edge length (`src/polytopes_nd.json`). The vertex sets at unit edge are
  matched with the catalogue's by an orthogonal map Q (backtracking on the Gram matrix of d neighbouring vertices, checked on all
  vertices, with det Q_C = det Q_P so that the rotation stays a rotation), and each pose [c, S, D] becomes t = Q_C c / E_P,
  R = Q_C R_up Q_P^T, with the pose of R from `robust_pose` (as above, every candidate rebuilt and compared at 1e-12), s = s_full.
- **Certification.** Every converted record is certified again by `python/ndim/certify.py` (exact rational rotations, interval
  enclosures, strict separation by explicit rational hyperplanes, containment by exact facets) at clearance 0, and only the ones
  that pass are kept. The certifier's smallest proved gaps are stored with each record (`certification`). Upstream's clearance of
  1e-7 survives the conversion to about 1e-15; some pairs show a proved gap a hair under 1e-7 (down to 9.9e-8), which is the
  certifier's rigorous lower bound on a conservatively rounded rational plane.
- **Result** [CALC]: 1,886 of 1,890 records certified (4D 1,403 of 1,404, 5D 278 of 279, 6D 205 of 207), 10 MB in `data/ndim`
  (`records.json` 2.4 MB, `configs/<d>-<piece>-<container>.jsonl` one line per P, as for polyhedra). The four dropped, each for one
  pair the certifier could not separate by a rational plane (its proposals, from the line of centres, the facet normals and GJK,
  found none of positive margin): 5-cell in 600-cell n = 39, 6-simplex in 6-orthoplex n = 10, 6-cube in 6-orthoplex n = 8, 5-cube in
  5-orthoplex n = 5 (hypercube pieces in an orthoplex are touching-face contacts at 1e-7). Their upstream files stay at the
  upstream; they are not claimed.
- **Fields of a record**: `id`, `d`, `piece`, `container`, `P`, `status` (`best_known` for all), `score_cert` (= the configuration's
  s = upstream's s_full), `display`, `config_at`, `bound` (taken from the domain), `found_by`, `credit`, `method`, `sources`
  (`wiki`, whose title, authors, URL, commit, licence, credit and method are given once in the file's `sources` table), `source`,
  `origin` (upstream's file, record id, date), `wiki` (upstream's s, s_plus, s_full, s_tight), `lineage` (upstream's `search`)
  and `certification`. Nothing is called proven.
- **Changes forced in the core by this import**: `python/ndim/certify.py` proposes, for pieces with more than 64 facets (the 120- and
  600-cell, 4_21), the two facets of each piece that face the other as separating directions (the closest points of GJK are too
  inaccurate for a face-to-face contact 1e-7 apart); `packages/ndim` gains `validateNdSteps` (the sliced validator; `validateNd`
  drives it), the `./info` entry (the catalogue's facts without the coordinates), the inscribed-ball shortcut for gross overlaps
  and the facet skipping of the wall test. `floatgeom.MAX_CAYLEY` is 64 where the TypeScript and the docs say 32.

Tests: `python/ndim/test_ndim.py` (`ImportedRecords`: a sample of nine records of every dimension certified again exactly, a
tampered record refused, the counts), `packages/spaces/test/ndim-records.test.ts` (the index, the credits, and every record read
back and valid at tolerance 0 by the float validator).
