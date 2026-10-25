# 3D on 4D, tesseract boundary: unit balls and cubes on the boundary of a tesseract

**Dimension.** Under Dimensions this is **3D on 4D**: solid 3D pieces packed on the 3-dimensional
boundary of a 4D polytope, with no container around them. Problem ids and records use the space
name `boundary`.

P unit balls (radius 1) or P unit cubes (edge 1) are packed on the boundary of a tesseract of
edge s. The score is the smallest s. Every record is certified by an exact checker
(`python/boundary/certify.py`, exact arithmetic only), so its validity is proven, not just
tested. Records: `data/boundary/records.json`, from the PolyPack research prototype (2026-10-24),
the PolyPack boundary search (2026-10-25) and exact constructions (section 4.6).

Labels: [EST] established and sourced, [CALC] computed or proved here, [SPEC] speculation.

## 1. The problem in plain words

A tesseract is a 4D cube. Its boundary is made of 8 solid cubes (the cells), glued face to face,
the way the surface of an ordinary cube is made of 6 squares. This boundary is a closed curved
3D space. It is flat inside every cell and across every square face (2-face) where two cells
meet. All its curvature sits on the edges: only 3 cells meet around an edge, so the angle around
it is 3 x 90 = 270 degrees instead of 360 [EST: Miller, Pak 2008, sec. 1: every point off the
faces of dimension at most d - 2 of a d-dimensional polytope boundary is flat; CALC: three cells
with 90-degree dihedral angles meet at each edge].

A piece is a rigid ball or cube that lives in this space. It may cross a 2-face into the next
cell, lying flat across it like a ribbon laid over the edge of a box. No edge or vertex of the
tesseract may pass through its interior. Pieces may touch but not overlap. The task: find the
smallest tesseract that holds P pieces.

There are 32 problems: P = 1..16 for balls and for cubes.

## 2. Conventions

These are the conventions of the engine's contract (`packages/boundary/src/types.ts`).

- **Tesseract.** The cube [-s/2, s/2]^4 in R^4. Write h = s/2.
- **Cells.** Cell `2 i + (sigma > 0)` is the cube x_i = sigma h, for i = 0..3 and sigma = -1 or +1.
  So cell 0 is x_0 = -h, cell 1 is x_0 = +h, cell 2 is x_1 = -h, and so on up to cell 7, x_3 = +h.
  Cells 2i and 2i + 1 are opposite; every other pair of cells shares a 2-face.
- **Local frames.** A point of cell (i, sigma) has local coordinates u = the other three
  coordinates of R^4, in increasing order of their index. The cell is the cube [-h, h]^3 with its
  centre at the origin. Example: in cell 5 (x_2 = +h), u = (x_0, x_1, x_3).
- **Configuration.** `{s, pieces: [{cell, u, q?}]}`. `cell` is the anchor cell, the cell that
  holds the piece's centre; `u` is the centre in the anchor's local coordinates at this s, and it
  must lie in the closed cell. `q` is a unit quaternion (w, x, y, z) rotating a cube in the
  anchor's frame; absent means axis-aligned. Balls have no `q`.
- **Units.** Balls have radius 1; cubes have edge 1 (the cube [-1/2, 1/2]^3 about its centre).
  Lengths scale with s, piece sizes do not.
- **Ids.** `boundary/tesseract/ball/<P>` and `boundary/tesseract/cube/<P>`, P without leading zeros.
- **Score.** s, the tesseract's edge. Smaller is better. Stored at full precision; shown at 6
  decimals (score_cert rounded to the nearest, ties to even, from its exact binary64 value).

Example, one ball: `{"s": 1.4142135623745096, "pieces": [{"cell": 0, "u": [0, 0, 0]}]}`.

## 3. The fold rule and what valid means

**Development.** A piece is placed by developing it from its centre c. Each point q of the piece
is reached by the straight segment from c to q. Where the segment meets a 2-face it continues
into the neighbouring cell, unfolded flat: in R^4 this is the rotation about the 2-face that takes
one cell's hyperplane onto the other's. This is the exponential map at c [EST: Miller, Pak 2008].
It is defined as long as no segment from c meets an edge first.

**Validity** (touching allowed):

1. each centre lies in its closed anchor cell;
2. no point of the 1-skeleton (the edges and vertices) lies in the interior of a developed piece;
3. each development is injective on the piece's interior (a piece does not overlap itself);
4. the interiors of distinct pieces are disjoint.

Given (2), conditions (3) and (4) together say: cut every developed piece into its parts, one per
cell and path class it reaches; in every cell, all parts (two parts of one piece included) have
disjoint interiors.

**Strict validity**: the closed pieces avoid the 1-skeleton, are embedded, and are pairwise
disjoint. Every record is certified strictly valid at its stored s (section 4.4).

**Edges** [CALC, research note sec. 2.2]. No angle condition is needed at an edge. A convex piece
fills at most 180 degrees around a boundary point, and every edge has 270 degrees.

**Vertices** [SPEC]. Whether a piece touching a vertex of the tesseract needs a further condition
(on its tangent cone there) is argued in the research note, not proved. The engine treats a vertex
like any edge point: inside a piece is invalid, on its boundary is allowed. The certified records
are strictly valid, so no piece touches any edge or vertex. The open question does not affect
them.

**nofold.** The simpler rule "every piece lies inside one closed cell" is not a separate track
here. Its best value is given with every record as a reference (section 6).

## 4. Certification

The certifier reads every number as an exact rational (a binary64 float is a dyadic rational, so
nothing is rounded) and decides every inequality in exact integer arithmetic: all coordinates are
put over one common denominator. It shares no code with the TypeScript engine.

### 4.1 Developments as lattice words

Every 2-face of the tesseract is a right angle in R^4. So when a straight path crosses a 2-face,
the next cell unfolds as the adjacent cube. All the cells a path crosses therefore unfold into the
cubes of the lattice 2h Z^3, with the anchor cell at the origin [CALC; the research prototype's
`tess.py`, re-derived]. Every edge of an unfolded cube lies on a lattice line (a line where two
lattice coordinates are odd multiples of h), and it is an edge of the tesseract.

A straight developed path crosses lattice planes y_k = (2n + 1) h. The ordered list of planes
crossed is a **word**. Along a straight segment each coordinate is monotone, so a word crosses the
planes of one axis all in one direction. Each word has an end cell and an exact development map
x = A y + h b from the lattice into R^4 (A a signed permutation, b an integer vector), built by
composing the unfoldings. Both depend only on the word, not on where the path starts.

The rotation used at each crossing: in cell (i, sigma), lattice direction tau e_k is the R^4
direction t e_j given by A. The path leaves through the 2-face x_i = sigma h, x_j = t h and
enters cell (j, t). The unfolding rotates in the plane of e_i and e_j about that 2-face, taking
sigma e_i (the old normal) to t e_j (the new normal) and t e_j (straight on) to -sigma e_i
(inward in the new cell).

**Realised word.** Word w realises a path from the start u to a target point x2 when the image
y = A^T (x2 - h b) lies in w's closed lattice cube and the segment u -> y crosses w's planes at
parameters 0 <= t_1 <= t_2 <= ... <= 1. The path's length is |y - u|. Two rules make the test exact:

- every cell that contains x2 is tried (x2 may lie on a 2-face shared by two cells);
- a plane the segment is parallel to is not counted as crossed. The segment then never meets it,
  or runs inside it. A path inside a 2-face plane cannot cross another plane without passing
  through an edge, so it stays in one closed cell, and the word without that crossing realises it.

Every realised word is a real curve on the boundary from u to x2. Ties t_j = t_{j+1}, or an end
on a lattice line, are curves through an edge. They are kept: they only add candidates.

**Completeness** [CALC]. *Every straight path of length L < 2s is realised by a word with at most
2 crossings per lattice axis.* Proof: 3 crossings in one axis means crossing three consecutive
planes, for example y_k = h, 3h and 5h. The segment then spans at least 5h - h = 4h = 2s in that
coordinate, so L >= 2s. For s > 1 this covers every path of length <= 2, which is all the ball
test needs. The certifier enumerates all such words: 1957 per start cell. A test repeats two ball
records (P = 8 and 9) with up to 3 crossings per axis (41179 words per cell) and finds the same
paths shorter than 2s.

The word maps are checked exactly in the tests: each unfolded cube lands on its end cell, a word
and its one-step extension agree on the 2-face they share, and going round an edge gives the
expected quarter-turn holonomy.

### 4.2 Balls

[CALC] A unit-ball packing is valid exactly when

- every centre is at distance >= 1 from the 1-skeleton;
- every two centres are >= 2 apart (intrinsic distance);
- every geodesic loop at a centre (a straight path from the centre back to itself that avoids the
  skeleton) is >= 2 long.

The proof is that of [SURFACE.md](SURFACE.md) section 2.3, one dimension up. It uses one fact
about shortest paths [EST: Miller, Pak 2008, Prop. 1.2: a shortest path between two points that
do not lie in a common facet has no warped point in its interior; for a d-dimensional boundary
the warped points are the faces of dimension at most d - 2, here the edges and vertices]. Points
that do lie in a common cell are joined by the straight segment in that cell, which is shortest
because it is the R^4 distance. Strict validity uses > for all three.

How each condition is checked:

- **Clearance**, closed form. For a centre u in its cell, the distance to the skeleton is
  min over pairs of axes a < b of sqrt((h - |u_a|)^2 + (h - |u_b|)^2). Proof: a shortest path to
  the skeleton is a straight developed segment ending on a lattice line. The odd multiple of h
  nearest to u_a (which lies in [-h, h]) is +-h, so no lattice line is closer than this minimum,
  and an edge of the anchor cube itself attains it. The certifier compares the squared value
  with 1.
- **Pairs.** Intrinsic distance is never below the R^4 distance. So only pairs at most 2 apart in
  R^4 are examined; for those, every realised word from one centre to the other must give
  squared length >= 4. By completeness and Prop. 1.2, a pair closer than 2 always shows up as a
  shorter realised word. A realised word through an edge is at least clearance + clearance >= 2
  long, so it never causes a false rejection.
- **Loops.** Every realised non-empty word from a centre back to itself must give length >= 2.
  [CALC] Every word that ends in its own start cell (264 per cell) crosses two axes twice. So any
  loop shorter than 2s is at least s sqrt 2 long, which is >= 2 whenever a ball fits at all. The
  check is kept anyway. No record has a loop shorter than 2s (`min_loop` is null).

[CALC] Clearance <= h sqrt 2 = s / sqrt 2 for every point, so a ball needs s >= sqrt 2 > 1. The
word stage therefore always runs at s > 1, where completeness holds.

### 4.3 Axis-aligned cubes

The certifier handles axis-aligned cubes, which is all the records use: q absent or
+-(1, 0, 0, 0). A rotated cube is refused as out of scope, not judged.

The cube centred at u is the box u +- 1/2 in the lattice picture. Say it **crosses axis k** when
|u_k| + 1/2 > h, so that it pokes through the face u_k = +-h.

[CALC] *It is valid alone exactly when it crosses at most one axis.*

- Two crossed axes k and l: the anchor's own edge u_k = +-h, u_l = +-h runs through the open
  box (the point with the third coordinate equal to u_m is inside it). Invalid.
- At most one crossed axis: in each other axis the open box, and u, lie inside the open
  interval (-h, h). So every segment from u to a point of the open box crosses u_k = +-h inside
  the 2-face, never at its rim. The box lies in the anchor cube and the neighbouring cube; no
  lattice line meets its interior. If s < 1, every axis is crossed, so one crossed axis forces
  s >= 1, and then the slice beyond the face (depth at most 1/2) stays inside the neighbouring
  cube.

The parts are then exact boxes: the box clipped to the anchor cell, and the slice beyond the
crossed face mapped into the neighbour by the one-crossing word. The map is a signed permutation,
so the slice is a box there too. The two parts of one cube lie in different cells, so a cube
never overlaps itself. Two parts in one cell have disjoint interiors when some axis separates
them (one's upper end <= the other's lower end).

Strict mode counts a face touched from inside (|u_k| + 1/2 = h) as crossed and adds the flat
slice in the neighbour. Closed boxes must then be separated (<). This catches two cubes that
touch across a 2-face from different cells.

### 4.4 score_cert

Scaling the tesseract by lam > 1 about its centre, with the pieces kept at unit size, is the same
as shrinking every piece about its own centre by 1/lam. A shrunk convex piece lies, with its
boundary, in the interior of the original one. So every contact of a valid packing becomes a gap,
and a valid packing becomes strictly valid [CALC]. The rule:

  for k = 1, 2, ...: lam_k = 1 + k 1e-12; scale s and every coordinate of every centre by
  lam_k (binary64 products); score_cert = s lam_k for the first k at which these floats certify
  strictly valid.

score_float is the unscaled s. The record's configuration is the scaled one, at s = score_cert,
so what is stored is exactly what was certified. Every record certifies at k = 1, except balls
P = 14 (k = 3), whose research result was 2e-12 short of touching.

### 4.5 Checks around the certifier

- **Records mode.** `python3 python/boundary/certify.py data/boundary/records.json` checks each
  record's own fields (id against polytope, piece and P; status; score_cert equal to the
  configuration's s; display; 0 < score_float <= score_cert; the stored bound below score_cert
  and below the proven bound, exactly) and then certifies the configuration. Every failure,
  malformed input included, is reported, and the exit status is 1.
- **Engine check.** `packages/boundary/scripts/check-records.ts` runs the engine's float
  validator on every record at score_cert, at the touching tolerance 1e-9 and at tolerance 0.
  All 32 pass.
- **Cross-check.** `packages/boundary/scripts/gen-crosscheck.ts` writes the engine's verdicts,
  chain-based distances, loops, clearances and cube parts for 314 configurations: the engine's
  research fixtures, the records, the records shrunk by 1e-6, the adversarial cases and 200
  seeded random ones (balanced valid and invalid). The test compares them with the certifier.
  Verdicts agree on all 314 at tolerance 1e-9 and on 287 at tolerance 0. The other 27 have an
  exact margin within 1e-13 of a threshold (raw float fixtures and exact contacts), where a float
  verdict at tolerance 0 is decided by rounding. One such case: the research fixture for 9 balls
  at its own s is exactly valid, with margins of about 1e-16; the engine rejects it at tolerance 0
  by rounding and accepts it at 1e-9. Distances, loops, clearances and cube part boxes agree to
  1e-9.
- **Adversarial tests.** Balls overlapping across a 2-face; balls overlapping around an edge
  (the shortest path crosses two 2-faces); a ball too close to an edge; a cube containing an edge
  point; two cube parts overlapping in one cell; touching variants of each, valid but not
  strictly; malformed and out-of-scope input. A copy of every record shrunk by 1e-6 fails.

### 4.6 Exact constructions

Some layouts sit on exact values. Where the certifier proves the exact version valid at exactly
that s (touching allowed), the record stores it in the field `exact`, records mode re-checks it,
and the record's configuration is that construction rounded to binary64 and scaled as in 4.4.

- **Cubes, rational** [CALC]. A cube layout whose value is within 1e-5 of 5/4, 4/3 or 3/2 is
  scaled to that value, and every coordinate within 1e-6 of a multiple of 1/24 (which holds the
  1/8, 1/6 and 1/4 grids) is snapped onto it; the other coordinates have slack and are kept as
  binary64 values. The certifier then decides validity at exactly s = 5/4, 4/3 or 3/2 in
  rational arithmetic. This works for the search layouts of P = 11, 12 (5/4) and 13, 14 (4/3) and
  the research layouts of P = 9 (5/4) and 14, 16 (3/2); it fails for the research layouts of
  P = 10, 12, 13 and 15, whose contacts run through coordinates off the grid. Those problems
  take a better or equal exact value from another candidate.
- **Balls, in Q(sqrt 2, sqrt 3)** [CALC]. Two layouts have every centre coordinate equal to
  +-a with h - a = 1/sqrt 2, so every clearance is exactly 1:
  P = 4, s = 1 + 1/sqrt 2, a = (2 - sqrt 2)/4 (the research layout), and
  P = 8, s = 2 cos 15 deg = (sqrt 6 + sqrt 2)/2, a = sin 15 deg = (sqrt 6 - sqrt 2)/4 (the
  search layout, one ball per cell). The certifier runs the same tests (clearance, words, loops)
  on elements a + b sqrt 2 + c sqrt 3 + d sqrt 6 with rational a..d (`python/boundary/qfield.py`).
  Signs are exact: a binary64 evaluation decides only when it exceeds 1e-12 times the sum of the
  terms' magnitudes, far above its proven error (2e-15 of that sum); otherwise sign(p + q sqrt 3)
  with p, q in Q(sqrt 2) follows from the signs of p, q and p^2 - 3 q^2, and the same one level
  down. Both layouts are valid at exactly their s, with every clearance exactly 1 and the least
  centre distance exactly 2. Whether these s are optimal is open [SPEC]: no matching lower bound.
- **P + 1 minus a piece.** A subset of a valid packing is valid, so the record for P + 1 with its
  last piece removed is a candidate for P. Cubes P = 10 (from 11) and 15 (from 16) use it.

The builder (`python/boundary/build_records.py`) certifies every candidate (research, search,
exact versions, P + 1 minus a piece, and the research note's constructions) with the rule of
4.4 and keeps the one with the smallest score_cert (ties: exact, search, research, subset).

## 5. Lower bounds

Only proven bounds are stored [CALC]. Each is stored as a binary64 value rounded down, and the
record's `bound` is the larger one.

- **Volume.** Developments are local isometries, injective on interiors, with disjoint images, so
  the pieces' volumes add up to at most the boundary's, 8 s^3. Balls: s >= (P pi / 6)^(1/3).
  Cubes: s >= (P / 8)^(1/3).
- **One piece.** Every point of a cell lies within s / sqrt 2 of the cell's edges (the clearance
  formula is at most h sqrt 2 = s / sqrt 2, reached at the centre). A ball's centre needs
  clearance >= 1, so s >= sqrt 2. A cube contains the ball of radius 1/2 about its centre, which
  must avoid the edges, so s >= 1 / sqrt 2.

Balls P = 1 and 2 meet sqrt 2, and cubes P = 8 meet the volume bound 1 (the 8 cubes fill the
boundary). These values are therefore optimal by our own derivation [CALC]. PolyPack calls a value
proven only with a published proof, so they stay `best_known`, with a note. Every other value,
the search values and the exact constructions included, lies above both bounds; the tests check
this exactly.

"No unit cube fits on a tesseract of edge below 1" is numerical only (research note sec. 4:
maximising the side of a cube that avoids the edges, over rotation and centre, by 150 Nelder-Mead
runs and 200,000 random poses, gave 1) and is not used as a bound.

## 6. nofold values

[CALC, research note sec. 2.3] nofold(P) = f(ceil(P / 8)), with f(n) the smallest cube holding n
pieces. Upper bound: an optimal n-packing in every cell. Lower bound: some cell holds at least
ceil(P / 8) pieces inside it, which is an ordinary 3D packing.

| pieces | P = 1..8 (one per cell) | P = 9..16 (two per cell) |
|---|---|---|
| balls | 2 [CALC: a unit ball in a cube needs edge 2] | 2 + 2/sqrt 3 = 3.154701 [CALC: the two centres lie in the inner cube of edge s - 2, of diameter sqrt 3 (s - 2) >= 2; equality on a diagonal] |
| cubes | 1 [CALC] | 2 [EST: two unit cubes in a cube, the cube-in-cube table of polyhedrainpolyhedra.wiki, as cited by the research note; upper bound CALC] |

## 7. Results

fold = score_cert at 6 decimals. Gain = 1 - score_float / nofold. Lower bound as in section 5.
Source: exact = a construction of the research note; research = the research prototype's round-2
search (2026-10-24; balls seeds 21 and 22, cubes seed 31 or 32); search = the PolyPack boundary
search (2026-10-25, one deterministic call with seed 1, below). "made exact" = section 4.6.

**Balls:**

| P | fold | nofold | gain | lower bound | source |
|---|---|---|---|---|---|
| 1 | 1.414214 | 2 | 29.3% | 1.414214 (one ball) | exact: centre of cell 0 |
| 2 | 1.414214 | 2 | 29.3% | 1.414214 (one ball) | exact: centres of cells 0 and 1 |
| 3 | 1.680142 | 2 | 16.0% | 1.414214 (one ball) | research (seeds agree) |
| 4 | 1.707107 | 2 | 14.6% | 1.414214 (one ball) | research, made exact: 1 + 1/sqrt 2 |
| 5 | 1.787226 | 2 | 10.6% | 1.414214 (one ball) | search |
| 6 | 1.865835 | 2 | 6.7% | 1.464592 (volume) | research (seeds agree) |
| 7 | 1.925404 | 2 | 3.7% | 1.541815 (volume) | research (seeds differ by 5.1e-4) |
| 8 | 1.931852 | 2 | 3.4% | 1.611992 (volume) | search, made exact: 2 cos 15 deg |
| 9 | 2.220596 | 3.154701 | 29.6% | 1.676539 (volume) | research (seeds agree) |
| 10 | 2.269267 | 3.154701 | 28.1% | 1.736466 (volume) | search |
| 11 | 2.315918 | 3.154701 | 26.6% | 1.792519 (volume) | search |
| 12 | 2.328171 | 3.154701 | 26.2% | 1.845270 (volume) | research (seeds agree) |
| 13 | 2.397495 | 3.154701 | 24.0% | 1.895166 (volume) | search |
| 14 | 2.435431 | 3.154701 | 22.8% | 1.942565 (volume) | research (seeds agree) |
| 15 | 2.503240 | 3.154701 | 20.7% | 1.987757 (volume) | search |
| 16 | 2.526574 | 3.154701 | 19.9% | 2.030983 (volume) | search |

Mean gain 19.5%. "Seeds agree" means the research search's two independent seeds differ by at
most 1e-6 relative: evidence of the best basin found, not a proof. The gain falls from 29% to 3%
as P grows to 8, then jumps back at P = 9, where nofold must put two balls in one cell.

**Cubes** (axis-aligned):

| P | fold | nofold | gain | lower bound | source |
|---|---|---|---|---|---|
| 1..2 | 1.000000 | 1 | 0% | 0.707107 (one cube) | exact: one cube per cell |
| 3..7 | 1.000000 | 1 | 0% | 0.721125 .. 0.956466 (volume) | exact: one cube per cell |
| 8 | 1.000000 | 1 | 0% | 1 (volume) | exact: the cells themselves; meets the bound |
| 9 | 1.250000 | 2 | 37.5% | 1.040042 (volume) | research, made exact: 5/4 |
| 10 | 1.250000 | 2 | 37.5% | 1.077217 (volume) | P = 11 minus a cube: 5/4 |
| 11 | 1.250000 | 2 | 37.5% | 1.111990 (volume) | search, made exact: 5/4 |
| 12 | 1.250000 | 2 | 37.5% | 1.144714 (volume) | search, made exact: 5/4 |
| 13 | 1.333333 | 2 | 33.3% | 1.175667 (volume) | search, made exact: 4/3 |
| 14 | 1.333333 | 2 | 33.3% | 1.205071 (volume) | search, made exact: 4/3 |
| 15 | 1.500000 | 2 | 25.0% | 1.233106 (volume) | P = 16 minus a cube: 3/2 |
| 16 | 1.500000 | 2 | 25.0% | 1.259921 (volume) | research, made exact: 3/2 |

Mean gain 16.7%. Every cube value from P = 9 on is an exact construction at 5/4, 4/3 or 3/2
[CALC]; whether these are optimal is open [SPEC].

**What the search changed** (2026-10-25; `searchBoundary({polytope: "tesseract", piece, P},
{seed: 1, budget: {evals: E}})`, reproduced by `packages/boundary/scripts/search-sources.ts`).
It beat the research values at 11 problems. Improvement = 1 - new score_cert / research score_cert:

| problem | evaluations E | research | now | improvement |
|---|---|---|---|---|
| ball 5 | 2,617,672 | 1.787248 | 1.787226 | 0.0012% |
| ball 8 | 65,479 | 1.936630 | 1.931852 (2 cos 15 deg) | 0.25% |
| ball 10 | 654,968 | 2.270488 | 2.269267 | 0.054% |
| ball 11 | 1,358,135 | 2.315950 | 2.315918 | 0.0014% |
| ball 13 | 7,650,384 | 2.397624 | 2.397495 | 0.0054% |
| ball 15 | 5,026,907 | 2.504811 | 2.503240 | 0.063% |
| ball 16 | 779,083 | 2.528105 | 2.526574 | 0.061% |
| cube 11 | 156,372 | 1.333333 | 1.250000 (5/4) | 6.25% |
| cube 12 | 490,433 | 1.500000 | 1.250000 (5/4) | 16.7% |
| cube 13 | 298,374 | 1.500000 | 1.333333 (4/3) | 11.1% |
| cube 14 | 2,007,977 | 1.500000 | 1.333333 (4/3) | 11.1% |

The exact constructions also moved balls P = 4 (by 5e-11 relative, to 1 + 1/sqrt 2) and cubes
P = 9, 10, 15, 16 (by 1e-7 to 3e-7, onto 5/4 and 3/2). Each record keeps the research value in
its field `previous`.

## 8. Exact and float

- **Exact:** the certification of every record (strict validity at score_cert); the exact
  constructions of section 4.6 (rational, or in Q(sqrt 2, sqrt 3)); the lower bounds; the closed
  forms of the nofold values; the word maps.
- **Float:** the search values (score_float) of the ball records that are not exact
  constructions; the engine's validator; the cross-check numbers.
- The exact constructions sit on their exact values: balls P = 1, 2 at sqrt 2, P = 4 at
  1 + 1/sqrt 2, P = 8 at 2 cos 15 deg; cubes P = 1..8 at 1, P = 9..12 at 5/4, 13, 14 at 4/3, 15, 16
  at 3/2. Their records store the binary64 rounding, scaled to strict validity, so score_cert is
  about 1e-12 above the exact value.

## 9. Limitations

- The vertex rule is argued, not proved [SPEC] (section 3). It does not affect the records.
- Ball values are float search results, except the exact constructions. The research value of
  P = 7 is not converged (two seeds differ by 5.1e-4), and the search values (P = 5, 10, 11, 13,
  15, 16) come from one seeded run each. All are upper bounds. Nothing is claimed optimal beyond
  the three cases that meet their bounds, and those stay `best_known`.
- Cubes: only axis-aligned cubes were searched. Rotated cubes were tried only by random
  single-cube insertion in the research (no fit found). The certifier refuses rotated cubes.
- Only the tesseract is covered. The engine is generic over convex 4-polytopes; the certifier's
  lattice words are specific to the tesseract's right-angled 2-faces.
- The cube nofold value 2 for P = 9..16 is taken from the wiki's table, not re-derived here.
- The certifier's soundness rests on the arguments of section 4 and on Python's exact integers
  and fractions (and, for Q(sqrt 2, sqrt 3), on the sign rule of 4.6). Its records are also
  accepted by the engine's independent float validator.

## 10. Files and commands

- `python/boundary/certify.py`: the certifier (library and records mode);
  `python/boundary/qfield.py`: exact arithmetic in Q(sqrt 2, sqrt 3).
- `python/boundary/build_records.py`: builds `data/boundary/records.json` from the sources and
  the exact constructions. Deterministic; a test rebuilds and compares.
- `data/boundary/sources/research_round2.json`: the research prototype's round-2 output,
  imported with its numbers unchanged. `data/boundary/sources/search_2026-10-25.json`: the
  search's 11 configurations with their calls (method, seed, evaluations, date, value).
- `python/boundary/test_boundary.py`: tests; `python/boundary/fixtures/`: adversarial cases and
  the engine cross-check.
- `packages/boundary/scripts/check-records.ts`, `packages/boundary/scripts/gen-crosscheck.ts`,
  `packages/boundary/scripts/search-sources.ts`.

```
python3 python/boundary/certify.py data/boundary/records.json
python3 python/boundary/test_boundary.py
npx tsx packages/boundary/scripts/search-sources.ts
python3 python/boundary/build_records.py
npx tsx packages/boundary/scripts/check-records.ts
npx tsx packages/boundary/scripts/gen-crosscheck.ts
```

Timing (Apple Silicon, shared machine): the 11 searches about 2.5 minutes in all (the longest,
balls P = 13 and 15, 44 and 49 s); building the records file 3 s; certifying all 32 records with
their exact constructions 2.3 s; the Python tests about 26 s; the engine check 0.3 s for 64
validations.

## 11. Sources

- E. Miller, I. Pak, Metric combinatorics of convex polyhedra: cut loci and nonoverlapping
  unfoldings, Discrete Comput. Geom. 39 (2008) 339-388, https://arxiv.org/abs/math/0312253
  (full text, sections 1-3, read by the research note): boundaries of convex polytopes in every
  dimension; flat and warped points; Prop. 1.2 (shortest paths avoid warped points); the
  exponential map. No packing.
- S. Devadoss, M. Harvey, Unfoldings and nets of regular polytopes (2021),
  https://arxiv.org/abs/2111.01359, and S. Devadoss, M. Harvey, D. Richter, Unfolding overlaps of
  the exceptional regular polytopes (2026), https://arxiv.org/abs/2608.30285 (abstracts and
  introductions, as read by the research note): every ridge unfolding of the tesseract is a net;
  nets, not packings.
- F. Buekenhout, M. Parker, Discrete Math. 186 (1998) 69-94: the count of the tesseract's nets,
  261 (as cited by Devadoss and Harvey; not opened).
- polyhedrainpolyhedra.wiki (A. Zarzuelo Urdiales, github.com/alejandrozu/platonic-packing): the
  cube-in-cube table used for the cube nofold value at two per cell, as cited by the research
  note (site and repository audited for PolyPack on 2026-10-23).
- PolyPack research note "3D pieces on the boundary of a 4-polytope", 2026-10-24: definitions,
  the lattice-word developments, the round-2 searches and their configurations.
- PolyPack boundary search (`packages/boundary/src/search`), runs of 2026-10-25: the 11
  improved configurations.
- [SURFACE.md](SURFACE.md) section 2.3: the distance form for disks, which section 4.2 lifts one
  dimension up.
